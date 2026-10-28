// Package server wires the HTTP surface: health, auth, the /api/v1 gateway,
// /api/x and the embedded SPA, behind the shared middleware chain.
package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"tempolens/internal/apierr"
	"tempolens/internal/audit"
	"tempolens/internal/auth"
	"tempolens/internal/authz"
	"tempolens/internal/config"
	"tempolens/internal/gateway"
	"tempolens/internal/health"
	"tempolens/internal/limits"
	"tempolens/internal/xapi"
)

const (
	maxBodyBytes = 4 << 20
	// streamRetryAfter is the Retry-After for the per-principal stream cap.
	streamRetryAfter = 5
	// exportPath is streamed; it is never gzipped by the middleware and counts
	// toward the stream cap.
	exportPath = "/api/x/history-export"
)

// csp allows codec servers (any https origin, or a local http one) in
// connect-src; everything else is same-origin only.
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
	"connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'"

// Options are the server dependencies.
type Options struct {
	Config *config.Config
	// Conn is the intercepted Temporal connection.
	Conn grpc.ClientConnInterface
	// Keys seals sessions; required when auth is on.
	Keys *auth.Keyring
	// OIDC is nil when auth is disabled.
	OIDC *auth.OIDC
	// Policy reports the env-disabled actions for /api/x/me.
	Policy  *authz.Policy
	Health  *health.Checker
	UI      http.Handler
	Audit   *audit.Logger
	Log     *slog.Logger
	Version string
}

type server struct {
	cfg      *config.Config
	log      *slog.Logger
	streams  *limits.Streams
	callback string

	healthz, readyz, sso, callbackH, logout http.Handler
	settings, gateway, xapi, apiNotFound    http.Handler
	assets, spa                             http.Handler
}

// New returns the complete HTTP handler.
func New(ctx context.Context, o Options) (http.Handler, error) {
	if o.Keys == nil || o.Policy == nil {
		return nil, errors.New("server: keys and policy are required")
	}
	if !o.Config.Auth.Disabled && o.OIDC == nil {
		return nil, errors.New("server: auth is enabled but OIDC is missing")
	}
	gw, err := gateway.New(ctx, o.Conn)
	if err != nil {
		return nil, err
	}
	s := &server{
		cfg:     o.Config,
		log:     o.Log,
		streams: limits.NewStreams(o.Config.Limits.MaxStreamsPerUser),
	}

	get := []string{http.MethodGet, http.MethodHead}
	s.healthz = allow(get, http.HandlerFunc(o.Health.Healthz))
	s.readyz = allow(get, http.HandlerFunc(o.Health.Readyz))
	if o.Config.Auth.Disabled {
		s.sso = allow(get, http.HandlerFunc(auth.SSODisabled))
	} else {
		s.sso = allow(get, http.HandlerFunc(o.OIDC.SSO))
		s.callback = o.Config.Auth.CallbackPath
		s.callbackH = allow(get, http.HandlerFunc(o.OIDC.Callback))
	}
	s.logout = allow([]string{http.MethodPost}, auth.Logout(o.Audit))
	s.settings = auth.RequireAPI(allow(get, gateway.Settings(o.Config, o.Version)))
	s.gateway = auth.RequireAPI(allow([]string{http.MethodGet, http.MethodPost, http.MethodDelete},
		s.limitStreams(limitBody(gw))))
	// Exports count toward the per-principal stream cap.
	// /api/x checks methods per route; the section 3.8 routes take POST and DELETE.
	s.xapi = auth.RequireAPI(allow([]string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodDelete}, s.limitStreams(xapi.New(xapi.Options{
		Config: o.Config, Conn: o.Conn, Keys: o.Keys, Policy: o.Policy, Audit: o.Audit, Log: o.Log, Version: o.Version,
	}))))
	s.apiNotFound = auth.RequireAPI(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		apierr.Write(w, http.StatusNotFound, codes.NotFound, "no such API route")
	}))
	s.assets = allow(get, o.UI)
	s.spa = allow(get, auth.RequireHTML(o.UI))

	var h http.Handler = http.HandlerFunc(s.route)
	h = authz.IntentMiddleware(h)
	h = auth.NewSessions(o.Config.Auth, o.Keys).Middleware(h)
	h = auth.CSRF(o.Config.PublicOrigin, h)
	h = gzipJSON(h)
	h = securityHeaders(h)
	if o.Config.Auth.Disabled {
		h = auth.HostGuard(h)
	}
	h = requestLog(o.Log, h)
	h = recoverer(o.Log, h)
	return h, nil
}

// route dispatches on the raw path prefix. A pattern mux is not used because
// it would clean paths and redirect workflow IDs that contain "/../" or "//".
func (s *server) route(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	switch {
	case p == "/healthz":
		s.healthz.ServeHTTP(w, r)
	case p == "/readyz":
		s.readyz.ServeHTTP(w, r)
	case p == "/auth/sso":
		s.sso.ServeHTTP(w, r)
	case s.callback != "" && p == s.callback:
		s.callbackH.ServeHTTP(w, r)
	case p == "/auth/logout":
		s.logout.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/auth/"):
		apierr.Write(w, http.StatusNotFound, codes.NotFound, "no such auth route")
	case p == "/api/v1/settings":
		s.settings.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/api/v1/"):
		s.gateway.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/api/x/"):
		s.xapi.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/api/"):
		s.apiNotFound.ServeHTTP(w, r)
	case strings.HasPrefix(p, "/assets/"):
		s.assets.ServeHTTP(w, r)
	default:
		s.spa.ServeHTTP(w, r)
	}
}

// allow answers 405 for methods outside methods.
func allow(methods []string, next http.Handler) http.Handler {
	allowHeader := strings.Join(methods, ", ")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !slices.Contains(methods, r.Method) {
			w.Header().Set("Allow", allowHeader)
			apierr.Write(w, http.StatusMethodNotAllowed, codes.Unimplemented, "method not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// limitBody buffers request bodies up to 4 MiB and answers 413 above that.
func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Body != http.NoBody {
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
			if err != nil {
				var tooBig *http.MaxBytesError
				if errors.As(err, &tooBig) {
					apierr.Write(w, http.StatusRequestEntityTooLarge, codes.InvalidArgument, "request body exceeds 4 MiB")
					return
				}
				apierr.Write(w, http.StatusBadRequest, codes.InvalidArgument, "unreadable request body")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
		}
		next.ServeHTTP(w, r)
	})
}

// limitStreams applies the per-principal cap to history long-polls.
func (s *server) limitStreams(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isStream(r) {
			next.ServeHTTP(w, r)
			return
		}
		p := auth.FromContext(r.Context())
		release, ok := s.streams.Acquire(p.Key())
		if !ok {
			apierr.TooMany(w, streamRetryAfter, "too many concurrent history streams for this user")
			return
		}
		defer release()
		next.ServeHTTP(w, r)
	})
}

// isStream reports a history long-poll or an export. The gateway accepts
// both the JSON and the proto name of a query parameter, and any
// strconv.ParseBool form, so all of them count.
func isStream(r *http.Request) bool {
	if r.URL.Path == exportPath {
		return true
	}
	if r.Method != http.MethodGet {
		return false
	}
	q := r.URL.Query()
	for _, key := range []string{"waitNewEvent", "wait_new_event"} {
		for _, v := range q[key] {
			if b, err := strconv.ParseBool(v); err == nil && b {
				return true
			}
		}
	}
	return false
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// recoverer turns a handler panic into a logged 500.
func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			log.Error("handler panic", "method", r.Method, "path", r.URL.Path, "panic", v)
			apierr.Write(w, http.StatusInternalServerError, codes.Internal, "internal error")
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLog logs one line per request, without query strings or bodies.
// Probe routes log at DEBUG so liveness and readiness checks do not flood INFO.
func requestLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		level := slog.LevelInfo
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			level = slog.LevelDebug
		}
		log.Log(r.Context(), level, "request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"bytes", rec.bytes, "durationMs", time.Since(start).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status, s.wroteHeader = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.wroteHeader = true
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

func (s *statusRecorder) Flush() { _ = http.NewResponseController(s.ResponseWriter).Flush() }

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
