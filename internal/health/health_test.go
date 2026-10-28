package health_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"tempolens/internal/audit"
	"tempolens/internal/authz"
	"tempolens/internal/health"
	"tempolens/internal/testutil"
)

func newChecker(t *testing.T, oidc *atomic.Value) (*health.Checker, *testutil.FakeTemporal) {
	t.Helper()
	return newCheckerLog(t, oidc, io.Discard)
}

func newCheckerLog(t *testing.T, oidc *atomic.Value, out io.Writer) (*health.Checker, *testutil.FakeTemporal) {
	t.Helper()
	cfg := testutil.AuthConfig(t)
	log := slog.New(slog.NewJSONHandler(out, nil))
	fake := testutil.StartFakeTemporal(t)
	icpt := authz.NewInterceptor(authz.NewPolicy(cfg), audit.New(log), log, "test")
	conn := fake.Dial(t, icpt.Unary, authz.StreamDeny)
	return health.New(conn, func() string { return oidc.Load().(string) }, log), fake
}

func readyz(t *testing.T, c *health.Checker) (int, map[string]string) {
	t.Helper()
	w := httptest.NewRecorder()
	c.Readyz(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("readyz body: %v", err)
	}
	return w.Code, body
}

func TestReadyz(t *testing.T) {
	oidc := &atomic.Value{}
	oidc.Store(health.OIDCPending)
	c, fake := newChecker(t, oidc)

	if code, body := readyz(t, c); code != http.StatusServiceUnavailable || body["oidc"] != "pending" || body["temporal"] != "ok" {
		t.Fatalf("OIDC pending: %d %v", code, body)
	}
	oidc.Store(health.OIDCOK)
	if code, body := readyz(t, c); code != http.StatusOK || body["status"] != "ok" {
		t.Fatalf("all ready: %d %v", code, body)
	}
	// The Temporal result is cached: a second call within 5 s does not hit it.
	n := len(fake.Calls())
	readyz(t, c)
	if len(fake.Calls()) != n {
		t.Fatal("readiness was not cached")
	}
	for _, call := range fake.Calls() {
		if call.Method != "/grpc.health.v1.Health/Check" {
			t.Fatalf("unexpected call %s", call.Method)
		}
	}
}

func TestReadyzFallbackAndFailure(t *testing.T) {
	oidc := &atomic.Value{}
	oidc.Store(health.OIDCDisabled)

	c, fake := newChecker(t, oidc)
	fake.SetResponder(func(_ context.Context, method string, _ any) (any, error, bool) {
		switch {
		case strings.HasSuffix(method, "/Check"):
			return nil, status.Error(codes.Unimplemented, "no health"), true
		case strings.HasSuffix(method, "/GetSystemInfo"):
			return &workflowservice.GetSystemInfoResponse{}, nil, true
		}
		return nil, nil, false
	})
	if code, body := readyz(t, c); code != http.StatusOK || body["oidc"] != "disabled" {
		t.Fatalf("GetSystemInfo fallback: %d %v", code, body)
	}

	logs := &testutil.SyncBuffer{}
	c, fake = newCheckerLog(t, oidc, logs)
	fake.SetResponder(func(context.Context, string, any) (any, error, bool) {
		return nil, status.Error(codes.Unavailable, "connection refused"), true
	})
	code, body := readyz(t, c)
	if code != http.StatusServiceUnavailable || body["temporal"] != "unavailable" {
		t.Fatalf("Temporal down: %d %v", code, body)
	}
	// The cause stays in the server log, not in the public response.
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "refused") {
		t.Fatalf("readyz leaks the error detail: %s", raw)
	}
	if !strings.Contains(logs.String(), "connection refused") {
		t.Fatalf("the cause was not logged: %s", logs.String())
	}
}

func TestHealthz(t *testing.T) {
	oidc := &atomic.Value{}
	oidc.Store(health.OIDCPending)
	c, _ := newChecker(t, oidc)
	w := httptest.NewRecorder()
	c.Healthz(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("healthz: %d %s", w.Code, w.Body.String())
	}
}
