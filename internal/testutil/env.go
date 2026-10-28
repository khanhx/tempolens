package testutil

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"tempolens/internal/audit"
	"tempolens/internal/auth"
	"tempolens/internal/authz"
	"tempolens/internal/config"
	"tempolens/internal/health"
	"tempolens/internal/server"
	"tempolens/internal/ui"
)

const (
	// Origin is the public origin of the test server.
	Origin = "http://localhost:8234"
	// WriteGroup is the configured write group (with a space, as in Dex).
	WriteGroup = "tempolens-test:Platform Team"
	// AdminGroup is the configured admin group.
	AdminGroup = "tempolens-test:Admins"
)

// Who selects the caller of a test request.
type Who int

const (
	Nobody Who = iota
	Reader
	Writer
	Admin
)

// Env is a complete Tempolens HTTP handler wired to a FakeTemporal.
type Env struct {
	Handler http.Handler
	Fake    *FakeTemporal
	Cfg     *config.Config
	Keys    *auth.Keyring
	logs    *SyncBuffer
}

// SyncBuffer is a goroutine-safe log sink.
type SyncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *SyncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *SyncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// AuthConfig returns an auth-enabled configuration for tests. The provider
// URL is never contacted unless the test starts discovery.
func AuthConfig(t testing.TB) *config.Config {
	t.Helper()
	env := map[string]string{
		"TEMPOLENS_AUTH_PROVIDER_URL":  "http://127.0.0.1:1/dex",
		"TEMPOLENS_AUTH_CLIENT_ID":     "tempolens-test",
		"TEMPOLENS_AUTH_CLIENT_SECRET": "test-secret",
		"TEMPOLENS_AUTH_CALLBACK_URL":  Origin + "/auth/sso/callback",
		"TEMPOLENS_AUTH_WRITE_GROUPS":  WriteGroup,
		"TEMPOLENS_AUTH_ADMIN_GROUPS":  AdminGroup,
		"TEMPOLENS_SESSION_KEYS":       testSessionKey,
		"TEMPOLENS_PUBLIC_ORIGIN":      Origin,
	}
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatalf("test config: %v", err)
	}
	return cfg
}

// NewEnv builds the server for cfg (AuthConfig when nil). The SPA serves a
// one-file build with index.html.
func NewEnv(t testing.TB, cfg *config.Config) *Env {
	t.Helper()
	if cfg == nil {
		cfg = AuthConfig(t)
	}
	logs := &SyncBuffer{}
	log := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	keys, err := auth.RandomKeyring()
	if !cfg.Auth.Disabled {
		keys, err = auth.NewKeyring(cfg.Auth.SessionKeys)
	}
	if err != nil {
		t.Fatalf("keyring: %v", err)
	}
	auditLog := audit.New(log)
	fake := StartFakeTemporal(t)
	policy := authz.NewPolicy(cfg)
	icpt := authz.NewInterceptor(policy, auditLog, log, "test")
	conn := fake.Dial(t, icpt.Unary, authz.StreamDeny)

	var provider *auth.OIDC
	if !cfg.Auth.Disabled {
		provider = auth.NewOIDC(cfg.Auth, keys, auditLog, log)
	}
	uiHandler, err := ui.New(fstest.MapFS{
		"index.html":       {Data: []byte("<!doctype html><title>Tempolens</title>")},
		"assets/app-1.js":  {Data: []byte(strings.Repeat("console.log(1);", 100))},
		"assets/app-1.css": {Data: []byte("body{}")},
	})
	if err != nil {
		t.Fatalf("ui: %v", err)
	}
	h, err := server.New(context.Background(), server.Options{
		Config: cfg, Conn: conn, Keys: keys, OIDC: provider, Policy: policy,
		Health: health.New(conn, func() string { return health.OIDCDisabled }, log),
		UI:     uiHandler, Audit: auditLog, Log: log, Version: "test",
	})
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	return &Env{Handler: h, Fake: fake, Cfg: cfg, Keys: keys, logs: logs}
}

// Logs returns everything logged so far.
func (e *Env) Logs() string { return e.logs.String() }

// SessionCookie returns a session cookie value for a principal.
func (e *Env) SessionCookie(t testing.TB, p *auth.Principal) string {
	t.Helper()
	v, err := e.Keys.SealSession(p, time.Now(), time.Hour)
	if err != nil {
		t.Fatalf("seal session: %v", err)
	}
	return v
}

// Principal returns the test principal for who.
func Principal(who Who) *auth.Principal {
	switch who {
	case Admin:
		return &auth.Principal{Sub: "a", Email: "admin@example.com", Role: config.RoleAdmin, AdminGroup: AdminGroup}
	case Writer:
		return &auth.Principal{Sub: "w", Email: "writer@example.com", Role: config.RoleWrite, WriteGroup: WriteGroup}
	case Reader:
		return &auth.Principal{Sub: "r", Email: "reader@example.com", Role: config.RoleRead}
	}
	return nil
}

// NewRequest builds a same-origin request. Non-GET requests carry the CSRF
// header and Origin; who selects the session cookie.
func (e *Env) NewRequest(t testing.TB, who Who, method, target, body string) *http.Request {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, target, rd)
	r.Host = "localhost:8234"
	if method != http.MethodGet && method != http.MethodHead {
		r.Header.Set("Origin", Origin)
		r.Header.Set(auth.CSRFHeader, "1")
		r.Header.Set("Content-Type", "application/json")
	}
	if p := Principal(who); p != nil && !e.Cfg.Auth.Disabled {
		r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: e.SessionCookie(t, p)})
	}
	return r
}

// Do serves r and returns the recorded response.
func (e *Env) Do(r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	e.Handler.ServeHTTP(w, r)
	return w
}

// testSessionKey is a fixed, obviously non-secret 32-byte test key.
var testSessionKey = base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
