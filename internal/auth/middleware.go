package auth

import (
	"net/http"
	"net/url"
	"time"

	"google.golang.org/grpc/codes"

	"tempolens/internal/apierr"
	"tempolens/internal/config"
)

// Sessions resolves the principal of each request.
type Sessions struct {
	auth config.Auth
	keys *Keyring
	now  func() time.Time
}

// NewSessions returns the session resolver for cfg. keys may be nil only when
// auth is disabled.
func NewSessions(a config.Auth, keys *Keyring) *Sessions {
	return &Sessions{auth: a, keys: keys, now: time.Now}
}

// Principal returns the caller of r, or nil when there is no valid session.
func (s *Sessions) Principal(r *http.Request) *Principal {
	if s.auth.Disabled {
		return LocalPrincipal(s.auth.DisabledRole)
	}
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		return nil
	}
	p, err := s.keys.OpenSession(c.Value, s.now())
	if err != nil {
		return nil
	}
	eff, ok := Effective(p, s.auth)
	if !ok {
		return nil
	}
	return eff
}

// Middleware puts the caller's principal, if any, into the request context.
func (s *Sessions) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := s.Principal(r); p != nil {
			r = r.WithContext(WithPrincipal(r.Context(), p))
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAPI answers 401 when the request has no principal.
func RequireAPI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if FromContext(r.Context()) == nil {
			apierr.Write(w, http.StatusUnauthorized, codes.Unauthenticated, "no valid session")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireHTML redirects an unauthenticated navigation to the login, keeping
// the current path and query as returnTo.
func RequireHTML(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if FromContext(r.Context()) == nil {
			target := "/auth/sso?returnTo=" + url.QueryEscape(SanitizeReturnTo(r.URL.RequestURI()))
			w.Header().Set("Cache-Control", "no-store")
			http.Redirect(w, r, target, http.StatusFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}
