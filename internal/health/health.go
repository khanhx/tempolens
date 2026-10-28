// Package health serves /healthz (process liveness) and /readyz (Temporal
// reachable and, when auth is on, OIDC discovery done).
package health

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"

	"tempolens/internal/auth"
)

const (
	checkTimeout = 2 * time.Second
	cacheTTL     = 5 * time.Second
	// temporalService is the health service name the Temporal frontend registers.
	temporalService = "temporal.api.workflowservice.v1.WorkflowService"
)

// OIDC states reported by /readyz.
const (
	OIDCOK       = "ok"
	OIDCPending  = "pending"
	OIDCDisabled = "disabled"
)

// Temporal states reported by /readyz. The cause is logged, never returned:
// /readyz is public.
const (
	TemporalOK          = "ok"
	TemporalUnavailable = "unavailable"
)

// Checker answers the health routes. All gRPC calls run as the internal principal.
type Checker struct {
	conn grpc.ClientConnInterface
	oidc func() string
	log  *slog.Logger
	now  func() time.Time

	mu       sync.Mutex
	checked  time.Time
	temporal string
}

// New returns a checker. oidcState reports OIDCOK, OIDCPending or OIDCDisabled.
func New(conn grpc.ClientConnInterface, oidcState func() string, log *slog.Logger) *Checker {
	return &Checker{conn: conn, oidc: oidcState, log: log, now: time.Now}
}

type readiness struct {
	Status   string `json:"status"`
	Temporal string `json:"temporal"`
	OIDC     string `json:"oidc"`
}

// Healthz always answers 200: the process is alive.
func (c *Checker) Healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// Readyz answers 200 only when every dependency is ready.
func (c *Checker) Readyz(w http.ResponseWriter, r *http.Request) {
	res := readiness{Temporal: c.temporalState(r.Context()), OIDC: c.oidc()}
	code := http.StatusOK
	res.Status = "ok"
	if res.Temporal != TemporalOK || res.OIDC == OIDCPending {
		code, res.Status = http.StatusServiceUnavailable, "unavailable"
	}
	writeJSON(w, code, res)
}

// temporalState returns TemporalOK or TemporalUnavailable, cached for
// cacheTTL. The failure cause is logged at WARN once per check.
func (c *Checker) temporalState(ctx context.Context) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if now := c.now(); !c.checked.IsZero() && now.Sub(c.checked) < cacheTTL {
		return c.temporal
	}
	c.temporal = TemporalOK
	if cause := c.check(ctx); cause != "" {
		c.temporal = TemporalUnavailable
		c.log.Warn("readiness: Temporal unavailable", "cause", cause)
	}
	c.checked = c.now()
	return c.temporal
}

// check returns "" when Temporal is healthy, else the cause.
func (c *Checker) check(parent context.Context) string {
	ctx, cancel := context.WithTimeout(auth.WithPrincipal(context.WithoutCancel(parent), auth.InternalPrincipal), checkTimeout)
	defer cancel()
	resp, err := healthpb.NewHealthClient(c.conn).Check(ctx, &healthpb.HealthCheckRequest{Service: temporalService})
	switch status.Code(err) {
	case codes.OK:
		if resp.GetStatus() != healthpb.HealthCheckResponse_SERVING {
			return "health status " + resp.GetStatus().String()
		}
		return ""
	case codes.Unimplemented, codes.NotFound:
		if _, err := workflowservice.NewWorkflowServiceClient(c.conn).GetSystemInfo(ctx, &workflowservice.GetSystemInfoRequest{}); err != nil {
			return status.Convert(err).Message()
		}
		return ""
	default:
		return status.Convert(err).Message()
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
