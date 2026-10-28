package xapi

import (
	"context"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strings"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/workflowservice/v1"

	"tempolens/internal/authz"
)

// withClause appends a server-built clause to a user query. The user query
// is always parenthesised, so "a OR b" cannot widen the clause.
func withClause(q, clause string) string {
	if strings.TrimSpace(q) == "" {
		return clause
	}
	return "(" + q + ") AND " + clause
}

// withGroupBy adds the status grouping used by counts.
func withGroupBy(q string) string {
	if strings.TrimSpace(q) == "" {
		return "GROUP BY ExecutionStatus"
	}
	return "(" + q + ") GROUP BY ExecutionStatus"
}

// orderBy matches ORDER BY outside string literals, case-insensitively.
var orderBy = regexp.MustCompile(`(?i)\border\s+by\b`)

// userQuery reads the query parameter and rejects what would break the
// server-built clauses or the merge order: ORDER BY outside string
// literals, unbalanced parentheses, and unterminated string literals.
func userQuery(r *http.Request) (string, error) {
	q := r.URL.Query().Get("query")
	var outside strings.Builder
	depth := 0
	var lit byte
	for i := 0; i < len(q); i++ {
		c := q[i]
		if lit != 0 {
			switch c {
			case '\\':
				i++
			case lit:
				lit = 0
			}
			outside.WriteByte(' ')
			continue
		}
		switch c {
		case '\'', '"', '`':
			lit = c
		case '(':
			depth++
		case ')':
			if depth--; depth < 0 {
				return "", badRequest("query has an unbalanced ')'")
			}
		}
		outside.WriteByte(c)
	}
	switch {
	case lit != 0:
		return "", badRequest("query has an unterminated string literal")
	case depth != 0:
		return "", badRequest("query has an unbalanced '('")
	case orderBy.MatchString(outside.String()):
		return "", badRequest("ORDER BY is not supported here; results use the visibility order")
	}
	return q, nil
}

// quote renders s as a visibility query string literal.
func quote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// namespaces resolves the namespaces parameter: "*" is every visible
// namespace; a list must be a subset of them. The result is sorted and
// de-duplicated; key is the canonical form used in page-token hashes.
func (h *Handler) namespaces(ctx context.Context, raw string) (names []string, key string, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", badRequest("namespaces is required (a comma list, or *)")
	}
	all, err := h.visibleNamespaces(ctx)
	if err != nil {
		return nil, "", err
	}
	if raw == "*" {
		names, key = all, "*"
	} else {
		seen := map[string]bool{}
		for _, n := range strings.Split(raw, ",") {
			n = strings.TrimSpace(n)
			if n == "" || seen[n] {
				continue
			}
			if !slices.Contains(all, n) {
				return nil, "", badRequest("unknown or hidden namespace: " + n)
			}
			seen[n] = true
			names = append(names, n)
		}
		sort.Strings(names)
		key = strings.Join(names, ",")
	}
	if len(names) == 0 {
		return nil, "", badRequest("no namespaces selected")
	}
	if len(names) > h.cfg.Limits.FanoutMaxNamespaces {
		return nil, "", badRequest("too many namespaces; narrow the selection")
	}
	return names, key, nil
}

// visibleNamespaces lists registered namespaces, cached for 30 s, without
// temporal-system unless it is shown.
func (h *Handler) visibleNamespaces(ctx context.Context) ([]string, error) {
	h.mu.Lock()
	if h.nsNames != nil && h.now().Sub(h.nsAt) < cacheTTL {
		names := h.nsNames
		h.mu.Unlock()
		return names, nil
	}
	h.mu.Unlock()

	var names []string
	ids := map[string]string{}
	var token []byte
	for {
		resp, err := h.wf.ListNamespaces(ctx, &workflowservice.ListNamespacesRequest{PageSize: 100, NextPageToken: token})
		if err != nil {
			return nil, err
		}
		for _, ns := range resp.GetNamespaces() {
			info := ns.GetNamespaceInfo()
			if info.GetState() == enumspb.NAMESPACE_STATE_DELETED {
				continue
			}
			ids[info.GetId()] = info.GetName()
			if info.GetName() == authz.SystemNamespace && !h.cfg.ShowSystemNamespace {
				continue
			}
			names = append(names, info.GetName())
		}
		if token = resp.GetNextPageToken(); len(token) == 0 {
			break
		}
	}
	sort.Strings(names)
	h.mu.Lock()
	h.nsNames, h.nsAt = names, h.now()
	for id, name := range ids {
		h.nsByID[id] = name
		h.nsIDByNS[name] = id
	}
	h.mu.Unlock()
	return names, nil
}

// namespaceName maps a namespace ID to its name using the namespace cache.
func (h *Handler) namespaceName(ctx context.Context, id string) (string, bool) {
	h.mu.Lock()
	name, ok := h.nsByID[id]
	h.mu.Unlock()
	if ok {
		return name, true
	}
	if _, err := h.visibleNamespaces(ctx); err != nil {
		return "", false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	name, ok = h.nsByID[id]
	return name, ok
}

// namespaceID maps a namespace name to its ID using the namespace cache.
func (h *Handler) namespaceID(ctx context.Context, name string) string {
	h.mu.Lock()
	id := h.nsIDByNS[name]
	h.mu.Unlock()
	if id == "" {
		if _, err := h.visibleNamespaces(ctx); err == nil {
			h.mu.Lock()
			id = h.nsIDByNS[name]
			h.mu.Unlock()
		}
	}
	return id
}
