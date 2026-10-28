package auth

import (
	"net/http"

	"google.golang.org/grpc/codes"

	"tempolens/internal/apierr"
)

// CSRFHeader must be "1" on every request that is not GET or HEAD.
const CSRFHeader = "X-Tempolens"

// CSRF rejects every request whose method is not GET or HEAD unless it sends
// X-Tempolens: 1 and an Origin equal to the public origin. It applies in every
// mode, including auth disabled and /auth/logout.
func CSRF(publicOrigin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get(CSRFHeader) != "1" || r.Header.Get("Origin") != publicOrigin {
				apierr.Write(w, http.StatusForbidden, codes.PermissionDenied, "cross-site request rejected")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
