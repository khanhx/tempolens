package server_test

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/workflowservice/v1"

	"tempolens/internal/auth"
	"tempolens/internal/authz"
	"tempolens/internal/config"
	"tempolens/internal/testutil"
)

const (
	terminatePath   = "/api/v1/namespaces/ns/workflows/wf/terminate"
	terminateTarget = "wf"
)

func authDisabledEnv(t *testing.T, role config.Role) *testutil.Env {
	t.Helper()
	cfg := testutil.AuthConfig(t)
	cfg.Auth = config.Auth{Disabled: true, DisabledRole: role}
	return testutil.NewEnv(t, cfg)
}

func TestCSRFAndHost(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	for _, tc := range []struct {
		name string
		mod  func(*http.Request)
	}{
		{"missing X-Tempolens", func(r *http.Request) { r.Header.Del(auth.CSRFHeader) }},
		{"foreign Origin", func(r *http.Request) { r.Header.Set("Origin", "http://evil.test") }},
		{"no Origin", func(r *http.Request) { r.Header.Del("Origin") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env.Fake.Reset()
			r := env.NewRequest(t, testutil.Writer, http.MethodPost, terminatePath, `{"reason":"r"}`)
			tc.mod(r)
			if w := env.Do(r); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"code":7`) {
				t.Fatalf("status %d body %s, want 403", w.Code, w.Body.String())
			}
			if len(env.Fake.Calls()) != 0 {
				t.Fatal("backend reached")
			}
		})
	}

	t.Run("rebound Host with auth disabled", func(t *testing.T) {
		env := authDisabledEnv(t, config.RoleWrite)
		r := env.NewRequest(t, testutil.Nobody, http.MethodPost, terminatePath, `{"reason":"r"}`)
		r.Host = "evil.test"
		if w := env.Do(r); w.Code != http.StatusForbidden {
			t.Fatalf("status %d, want 403", w.Code)
		}
		r = env.NewRequest(t, testutil.Nobody, http.MethodGet, "/api/x/me", "")
		r.Host = "evil.test:8234"
		if w := env.Do(r); w.Code != http.StatusForbidden {
			t.Fatalf("GET with rebound host: status %d, want 403", w.Code)
		}
		if len(env.Fake.Calls()) != 0 {
			t.Fatal("backend reached")
		}
	})
}

func TestAuthDisabledRoles(t *testing.T) {
	read := authDisabledEnv(t, config.RoleRead)
	if w := read.Do(read.NewRequest(t, testutil.Nobody, http.MethodPost, terminatePath, `{"reason":"r"}`)); w.Code != http.StatusForbidden {
		t.Fatalf("auth disabled, role read, terminate: %d, want 403", w.Code)
	}
	write := authDisabledEnv(t, config.RoleWrite)
	r := write.NewRequest(t, testutil.Nobody, http.MethodPost, terminatePath, `{"reason":"r"}`)
	r.Header.Set(authz.ConfirmHeader, terminateTarget)
	write.Do(r)
	calls := write.Fake.Calls()
	if len(calls) != 1 {
		t.Fatalf("auth disabled, role write: backend calls %d, want 1", len(calls))
	}
	if id := calls[0].Req.(*workflowservice.TerminateWorkflowExecutionRequest).GetIdentity(); id != "tempolens:local-dev" {
		t.Fatalf("identity = %q", id)
	}

	const deleteNS = "/api/x/namespace?namespace=tui-test-x"
	for role, want := range map[config.Role]int{config.RoleWrite: 0, config.RoleAdmin: 1} {
		env := authDisabledEnv(t, role)
		r := env.NewRequest(t, testutil.Nobody, http.MethodDelete, deleteNS, "")
		r.Header.Set(authz.ConfirmHeader, "tui-test-x")
		w := env.Do(r)
		if n := len(env.Fake.Calls()); n != want {
			t.Fatalf("auth disabled, role %s, namespace delete: backend calls %d, want %d (status %d)", role, n, want, w.Code)
		}
	}
}

func TestLogout(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	r := env.NewRequest(t, testutil.Writer, http.MethodPost, "/auth/logout", "")
	r.Header.Set("Origin", "http://evil.test")
	if w := env.Do(r); w.Code != http.StatusForbidden {
		t.Fatalf("logout with foreign Origin: %d, want 403", w.Code)
	}
	if w := env.Do(env.NewRequest(t, testutil.Writer, http.MethodGet, "/auth/logout", "")); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET logout: %d, want 405", w.Code)
	}
	w := env.Do(env.NewRequest(t, testutil.Writer, http.MethodPost, "/auth/logout", ""))
	if w.Code != http.StatusNoContent {
		t.Fatalf("logout: %d, want 204", w.Code)
	}
	cleared := false
	for _, c := range w.Result().Cookies() {
		cleared = cleared || (c.Name == auth.SessionCookie && c.MaxAge < 0)
	}
	if !cleared {
		t.Fatal("logout did not clear the session cookie")
	}
	if !strings.Contains(env.Logs(), `"event":"logout"`) {
		t.Fatal("logout not audited")
	}
}

func TestUnauthenticated(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	if w := env.Do(env.NewRequest(t, testutil.Nobody, http.MethodGet, "/api/v1/namespaces", "")); w.Code != http.StatusUnauthorized ||
		!strings.Contains(w.Body.String(), `"code":16`) {
		t.Fatalf("API without session: %d %s", w.Code, w.Body.String())
	}
	w := env.Do(env.NewRequest(t, testutil.Nobody, http.MethodGet, "/namespaces/default/workflows?query=a%3D1", ""))
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/auth/sso?returnTo=%2Fnamespaces%2Fdefault%2Fworkflows%3Fquery%3Da%253D1" {
		t.Fatalf("HTML navigation: %d location %q", w.Code, w.Header().Get("Location"))
	}
	r := env.NewRequest(t, testutil.Nobody, http.MethodGet, "/api/v1/namespaces", "")
	r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: "tampered"})
	if w := env.Do(r); w.Code != http.StatusUnauthorized {
		t.Fatalf("tampered cookie: %d, want 401", w.Code)
	}
	// Public routes need no session.
	for _, p := range []string{"/healthz", "/readyz", "/assets/app-1.js"} {
		if w := env.Do(env.NewRequest(t, testutil.Nobody, http.MethodGet, p, "")); w.Code != http.StatusOK {
			t.Errorf("%s without session: %d", p, w.Code)
		}
	}
	if w := env.Do(env.NewRequest(t, testutil.Nobody, http.MethodGet, "/auth/sso", "")); w.Code != http.StatusServiceUnavailable {
		t.Errorf("/auth/sso before discovery: %d, want 503", w.Code)
	}
}

func TestMethodsAndHeaders(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{http.MethodPost, "/namespaces/default/workflows", http.StatusMethodNotAllowed},
		{http.MethodDelete, "/assets/app-1.js", http.StatusMethodNotAllowed},
		{http.MethodPut, "/api/v1/namespaces/ns", http.StatusMethodNotAllowed},
		{http.MethodPost, "/api/x/me", http.StatusMethodNotAllowed},
		{http.MethodPost, "/healthz", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/x/no-such-route", http.StatusNotFound},
		{http.MethodGet, "/auth/other", http.StatusNotFound},
		// Gateway routing failures: an unmounted method on a mounted path is
		// 405 (never 501, which means Temporal lacks the RPC); an unknown path is 404.
		{http.MethodPost, "/api/v1/namespaces/ns/search-attributes", http.StatusMethodNotAllowed},
		{http.MethodDelete, "/api/v1/namespaces/ns/workflows/wf", http.StatusMethodNotAllowed},
		{http.MethodPost, "/api/v1/namespaces/ns/workflows/wf/no-such-action", http.StatusNotFound},
	} {
		w := env.Do(env.NewRequest(t, testutil.Writer, tc.method, tc.path, ""))
		if w.Code != tc.want {
			t.Errorf("%s %s: %d, want %d", tc.method, tc.path, w.Code, tc.want)
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["details"] == nil {
			t.Errorf("%s %s: body is not a google.rpc.Status: %s", tc.method, tc.path, w.Body.String())
		}
	}

	w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, "/namespaces/default/workflows/a%2F..%2Fb/run", ""))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Tempolens") {
		t.Fatalf("SPA deep link with encoded slashes: %d", w.Code)
	}
	for k, want := range map[string]string{
		"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "same-origin",
		"Cache-Control":           "no-cache",
	} {
		if got := w.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

func TestBodyLimit(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	big := `{"reason":"` + strings.Repeat("a", 4<<20) + `"}`
	if w := env.Do(env.NewRequest(t, testutil.Writer, http.MethodPost, terminatePath, big)); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413", w.Code)
	}
	if len(env.Fake.Calls()) != 0 {
		t.Fatal("backend reached")
	}
}

func TestSettings(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	for who, want := range map[testutil.Who]bool{testutil.Reader: true, testutil.Writer: false} {
		w := env.Do(env.NewRequest(t, who, http.MethodGet, "/api/v1/settings", ""))
		var s struct {
			DisableWriteActions bool
			Auth                struct{ Enabled bool }
			Version             string
		}
		if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
			t.Fatalf("settings: %v", err)
		}
		if s.DisableWriteActions != want || !s.Auth.Enabled || s.Version != "test" {
			t.Errorf("who=%d settings = %+v", who, s)
		}
	}
}

func TestGzipJSON(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	r := env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/v1/namespaces", "")
	r.Header.Set("Accept-Encoding", "gzip")
	w := env.Do(r)
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("API error JSON not gzipped: %v", w.Header())
	}
	zr, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(zr)
	if !strings.Contains(string(body), `"code":12`) {
		t.Fatalf("decoded body = %s", body)
	}

	r = env.NewRequest(t, testutil.Reader, http.MethodGet, "/assets/app-1.js", "")
	r.Header.Set("Accept-Encoding", "gzip")
	w = env.Do(r)
	if w.Header().Get("Content-Encoding") != "gzip" || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset headers: %v", w.Header())
	}
}

// TestStreamLimit holds four long-polls open in the backend; the fifth for
// the same principal gets 429 while another principal still gets through.
func TestStreamLimit(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	release := make(chan struct{})
	entered := make(chan struct{}, 10)
	env.Fake.SetResponder(func(ctx context.Context, method string, _ any) (any, error, bool) {
		if !strings.HasSuffix(method, "/GetWorkflowExecutionHistory") {
			return nil, nil, false
		}
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return &workflowservice.GetWorkflowExecutionHistoryResponse{History: &historypb.History{}}, nil, true
	})
	poll := "/api/v1/namespaces/ns/workflows/wf/history?execution.runId=r&waitNewEvent=true"

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, poll, ""))
		}()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("long-polls did not reach the backend")
		}
	}

	for _, p := range []string{poll, strings.Replace(poll, "waitNewEvent=true", "wait_new_event=1", 1)} {
		w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, p, ""))
		if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
			t.Errorf("fifth stream %s: %d, want 429 with Retry-After", p, w.Code)
		}
	}
	// A plain history read is not a stream.
	go func() { <-entered }()
	close(release)
	if w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/v1/namespaces/ns/workflows/wf/history", "")); w.Code != http.StatusOK {
		t.Errorf("plain history read: %d", w.Code)
	}
	wg.Wait()

	// Slots are released when the streams end.
	if w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, poll, "")); w.Code != http.StatusOK {
		t.Errorf("after release: %d, want 200", w.Code)
	}
}

func TestStreamLimitPerPrincipal(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	release := make(chan struct{})
	entered := make(chan struct{}, 10)
	env.Fake.SetResponder(func(ctx context.Context, method string, _ any) (any, error, bool) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return &workflowservice.GetWorkflowExecutionHistoryResponse{}, nil, true
	})
	poll := "/api/v1/namespaces/ns/workflows/wf/history?waitNewEvent=true"
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, poll, ""))
		}()
		<-entered
	}
	done := make(chan int)
	go func() {
		done <- env.Do(env.NewRequest(t, testutil.Writer, http.MethodGet, poll, "")).Code
	}()
	select {
	case <-entered:
	case code := <-done:
		t.Fatalf("other principal was limited: %d", code)
	case <-time.After(5 * time.Second):
		t.Fatal("other principal's stream did not reach the backend")
	}
	close(release)
	wg.Wait()
	if code := <-done; code != http.StatusOK {
		t.Fatalf("other principal: %d", code)
	}
}
