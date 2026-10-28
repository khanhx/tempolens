// Package auth implements OIDC login, sealed-cookie sessions, and the HTTP
// guards (CSRF, Host allowlist) that run before any API handler.
package auth

import (
	"context"
	"slices"

	"tempolens/internal/config"
)

// Principal is the caller of a request. The authz interceptor reads it from
// the context of every gRPC call.
type Principal struct {
	Sub   string
	Email string
	Name  string
	Role  config.Role
	// AdminGroup, WriteGroup and ReadGroup are the claim groups that matched
	// at login. They are re-checked against the current env on every request.
	AdminGroup string
	WriteGroup string
	ReadGroup  string
	// Local is the fixed principal used when auth is disabled.
	Local bool
	// Internal is the server's own principal, used only by readiness checks.
	Internal bool
}

// InternalPrincipal is used for server-originated calls such as /readyz.
var InternalPrincipal = &Principal{Role: config.RoleRead, Internal: true}

// LocalPrincipal returns the fixed principal used when auth is disabled.
func LocalPrincipal(role config.Role) *Principal {
	return &Principal{Role: role, Local: true}
}

// Key identifies the principal for per-principal limits.
func (p *Principal) Key() string {
	switch {
	case p.Internal:
		return "internal"
	case p.Local:
		return "local"
	case p.Email != "":
		return "email:" + p.Email
	default:
		return "sub:" + p.Sub
	}
}

// User is the name written to audit lines.
func (p *Principal) User() string {
	switch {
	case p.Internal:
		return "internal"
	case p.Local:
		return "local-dev"
	case p.Email != "":
		return p.Email
	default:
		return p.Sub
	}
}

// Identity is the value stamped into the identity field of write requests.
func (p *Principal) Identity() string { return "tempolens:" + p.User() }

type ctxKey struct{}

// WithPrincipal returns ctx carrying p.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext returns the principal in ctx, or nil.
func FromContext(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKey{}).(*Principal)
	return p
}

// Effective re-applies the current group configuration to a principal
// restored from a session. A role whose group is no longer configured drops
// to the highest role a remaining group still grants (admin → write → read).
// When read groups are configured and no admin, write or read group still
// matches, ok is false and the session must be treated as absent.
func Effective(p *Principal, a config.Auth) (eff *Principal, ok bool) {
	if p.Local || p.Internal {
		return p, true
	}
	agOK := p.AdminGroup != "" && slices.Contains(a.AdminGroups, p.AdminGroup)
	wgOK := p.WriteGroup != "" && slices.Contains(a.WriteGroups, p.WriteGroup)
	rgOK := p.ReadGroup != "" && slices.Contains(a.ReadGroups, p.ReadGroup)
	if len(a.ReadGroups) > 0 && !agOK && !wgOK && !rgOK {
		return nil, false
	}
	cp := *p
	switch {
	case cp.Role == config.RoleAdmin && agOK:
	case (cp.Role == config.RoleAdmin || cp.Role == config.RoleWrite) && wgOK:
		cp.Role = config.RoleWrite
	default:
		cp.Role = config.RoleRead
	}
	return &cp, true
}

// AtLeast reports whether role r includes role min (admin ⊇ write ⊇ read).
func AtLeast(r, min config.Role) bool {
	rank := map[config.Role]int{config.RoleRead: 1, config.RoleWrite: 2, config.RoleAdmin: 3}
	return rank[r] >= rank[min]
}

// Groups are the claim groups that matched each env list at login.
type Groups struct{ Admin, Write, Read string }

// MapGroups maps id_token groups to a role (admin, then write, then read).
// Claim groups are compared exactly and untrimmed against the (trimmed) env
// lists. ok is false when read groups are configured and no group matches.
func MapGroups(groups []string, a config.Auth) (role config.Role, matched Groups, ok bool) {
	for _, g := range groups {
		if matched.Admin == "" && slices.Contains(a.AdminGroups, g) {
			matched.Admin = g
		}
		if matched.Write == "" && slices.Contains(a.WriteGroups, g) {
			matched.Write = g
		}
		if matched.Read == "" && slices.Contains(a.ReadGroups, g) {
			matched.Read = g
		}
	}
	switch {
	case matched.Admin != "":
		return config.RoleAdmin, matched, true
	case matched.Write != "":
		return config.RoleWrite, matched, true
	case len(a.ReadGroups) == 0 || matched.Read != "":
		return config.RoleRead, matched, true
	default:
		return "", Groups{}, false
	}
}
