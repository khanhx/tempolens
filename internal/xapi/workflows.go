package xapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	workflowpb "go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/status"
)

// sortKey is the visibility ordering key of a row. Times are unix nanos;
// Close is nil for a running workflow.
type sortKey struct {
	Close *int64 `json:"c,omitempty"`
	Start int64  `json:"s"`
	Run   string `json:"r"`
}

func keyOf(info *workflowpb.WorkflowExecutionInfo) sortKey {
	k := sortKey{Run: info.GetExecution().GetRunId()}
	if info.GetStartTime() != nil {
		k.Start = info.GetStartTime().AsTime().UnixNano()
	}
	if info.GetCloseTime() != nil {
		c := info.GetCloseTime().AsTime().UnixNano()
		k.Close = &c
	}
	return k
}

// compareKeys orders a before b (negative) as Temporal 1.24 visibility does
// on both stores: close time desc with a missing close time (running) first,
// then start time desc, then run ID asc. SQL orders by
// COALESCE(close_time, max) DESC, start_time DESC, run_id ASC; Elasticsearch
// sorts CloseTime and StartTime desc with missing values first and has no
// run ID tie-breaker, so on Elasticsearch rows with identical close and start
// times may come back in a different order across pages.
func compareKeys(a, b sortKey) int {
	ac, bc := closeRank(a), closeRank(b)
	switch {
	case ac > bc:
		return -1
	case ac < bc:
		return 1
	case a.Start > b.Start:
		return -1
	case a.Start < b.Start:
		return 1
	}
	return strings.Compare(a.Run, b.Run)
}

const maxInt64 = int64(^uint64(0) >> 1)

func closeRank(k sortKey) int64 {
	if k.Close != nil {
		return *k.Close
	}
	return maxInt64
}

// nsCursor is the per-namespace page-token state: Tok is the server page
// token of the page holding the last emitted row, Last that row's key.
type nsCursor struct {
	Tok  []byte   `json:"tok,omitempty"`
	Last *sortKey `json:"last,omitempty"`
}

type pageToken struct {
	V  int                 `json:"v"`
	Q  string              `json:"q"`
	NS map[string]nsCursor `json:"ns"`
}

// queryHash binds a token to its query and namespace selection.
func queryHash(query, nsKey string) string {
	sum := sha256.Sum256([]byte(query + "\x00" + nsKey))
	return hex.EncodeToString(sum[:8])
}

func (h *Handler) signToken(t pageToken) (string, error) {
	payload, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, h.keys[0])
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// openToken verifies the HMAC with any key, then the version, query hash and
// namespace set.
func (h *Handler) openToken(raw, hash string, allowed []string) (pageToken, error) {
	var t pageToken
	bad := badRequest("invalid pageToken; restart from the first page")
	p, s, ok := strings.Cut(raw, ".")
	if !ok {
		return t, bad
	}
	payload, err1 := base64.RawURLEncoding.DecodeString(p)
	sig, err2 := base64.RawURLEncoding.DecodeString(s)
	if err1 != nil || err2 != nil {
		return t, bad
	}
	valid := false
	for _, k := range h.keys {
		mac := hmac.New(sha256.New, k)
		mac.Write(payload)
		if hmac.Equal(sig, mac.Sum(nil)) {
			valid = true
			break
		}
	}
	if !valid || json.Unmarshal(payload, &t) != nil || t.V != 1 {
		return t, bad
	}
	if t.Q != hash {
		return t, badRequest("pageToken belongs to a different query or namespace selection")
	}
	set := map[string]bool{}
	for _, n := range allowed {
		set[n] = true
	}
	for n := range t.NS {
		if !set[n] {
			return t, bad
		}
	}
	return t, nil
}

type listRow struct {
	ns      string
	info    *workflowpb.WorkflowExecutionInfo
	key     sortKey
	pageTok []byte
}

// nsStream walks one namespace's visibility pages, skipping rows at or
// before the last emitted key.
type nsStream struct {
	ns   string
	last *sortKey
	next []byte // token of the next page to fetch
	// cur is the token of the page holding the last emitted row (the
	// incoming cursor until a row is emitted); it is kept on error.
	cur     []byte
	noMore  bool
	buf     []listRow
	err     error
	fetches int
}

type xError struct {
	Namespace string `json:"namespace"`
	Code      int    `json:"code"`
	Message   string `json:"message"`
}

func errorOf(ns string, err error) xError {
	st := status.Convert(err)
	return xError{Namespace: ns, Code: int(st.Code()), Message: st.Message()}
}

func (h *Handler) fetch(ctx context.Context, s *nsStream, query string, pageSize int) {
	tok := s.next
	resp, err := h.wf.ListWorkflowExecutions(ctx, &workflowservice.ListWorkflowExecutionsRequest{
		Namespace: s.ns, Query: query, PageSize: int32(pageSize), NextPageToken: tok,
	})
	s.fetches++
	if err != nil {
		s.err = err
		return
	}
	for _, info := range resp.GetExecutions() {
		k := keyOf(info)
		if s.last != nil && compareKeys(k, *s.last) <= 0 {
			continue
		}
		s.buf = append(s.buf, listRow{ns: s.ns, info: info, key: k, pageTok: tok})
	}
	s.next = resp.GetNextPageToken()
	s.noMore = len(s.next) == 0
}

type listItem struct {
	Namespace string          `json:"namespace"`
	Execution json.RawMessage `json:"execution"`
}

type listResponse struct {
	Executions    []listItem `json:"executions"`
	NextPageToken string     `json:"nextPageToken"`
	Errors        []xError   `json:"errors"`
}

// maxFetchesPerNamespace bounds refetches when every row of a page was
// already emitted.
const maxFetchesPerNamespace = 20

func (h *Handler) workflows(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	pageSize, err := intParam(r, "pageSize", pageSizeDefault, 1, pageSizeMax)
	if err != nil {
		writeError(w, err)
		return
	}
	names, nsKey, err := h.namespaces(ctx, q.Get("namespaces"))
	if err != nil {
		writeError(w, err)
		return
	}
	query, err := userQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	hash := queryHash(query, nsKey)

	var streams []*nsStream
	if raw := q.Get("pageToken"); raw != "" {
		t, err := h.openToken(raw, hash, names)
		if err != nil {
			writeError(w, err)
			return
		}
		for _, n := range names {
			if c, ok := t.NS[n]; ok {
				streams = append(streams, &nsStream{ns: n, last: c.Last, next: c.Tok, cur: c.Tok})
			}
		}
	} else {
		for _, n := range names {
			streams = append(streams, &nsStream{ns: n})
		}
	}

	forEach(len(streams), h.cfg.Limits.FanoutConcurrency, func(i int) {
		h.fetch(ctx, streams[i], query, pageSize)
	})

	resp := listResponse{Executions: []listItem{}, Errors: []xError{}}
	for len(resp.Executions) < pageSize {
		// Keep every live namespace's buffer non-empty so the merge is exact.
		for _, s := range streams {
			for s.err == nil && len(s.buf) == 0 && !s.noMore && s.fetches < maxFetchesPerNamespace {
				h.fetch(ctx, s, query, pageSize)
			}
		}
		var best *nsStream
		for _, s := range streams {
			if s.err == nil && len(s.buf) > 0 && (best == nil || compareKeys(s.buf[0].key, best.buf[0].key) < 0) {
				best = s
			}
		}
		if best == nil {
			break
		}
		row := best.buf[0]
		best.buf = best.buf[1:]
		k := row.key
		best.last, best.cur = &k, row.pageTok
		raw, err := rawProto(row.info)
		if err != nil {
			writeError(w, err)
			return
		}
		resp.Executions = append(resp.Executions, listItem{Namespace: row.ns, Execution: raw})
	}

	next := pageToken{V: 1, Q: hash, NS: map[string]nsCursor{}}
	for _, s := range streams {
		switch {
		case s.err != nil:
			// Keep the namespace at its last good position so the next
			// page retries it instead of silently dropping it.
			resp.Errors = append(resp.Errors, errorOf(s.ns, s.err))
			next.NS[s.ns] = nsCursor{Tok: s.cur, Last: s.last}
		case len(s.buf) > 0:
			next.NS[s.ns] = nsCursor{Tok: s.buf[0].pageTok, Last: s.last}
		case !s.noMore:
			next.NS[s.ns] = nsCursor{Tok: s.next, Last: s.last}
		}
	}
	if len(next.NS) > 0 {
		if resp.NextPageToken, err = h.signToken(next); err != nil {
			writeError(w, err)
			return
		}
	}
	writeJSON(w, resp)
}
