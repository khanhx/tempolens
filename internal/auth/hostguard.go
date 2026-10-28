package auth

import (
	"net"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"

	"tempolens/internal/apierr"
)

// HostGuard is used only when auth is disabled. It rejects every request
// whose Host is not localhost or 127.0.0.1 (any port), which blocks DNS
// rebinding against an unauthenticated local instance.
func HostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		switch strings.ToLower(host) {
		case "localhost", "127.0.0.1":
			next.ServeHTTP(w, r)
		default:
			apierr.Write(w, http.StatusForbidden, codes.PermissionDenied, "host not allowed while auth is disabled")
		}
	})
}
