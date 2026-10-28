package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"tempolens/internal/audit"
	"tempolens/internal/config"
)

const (
	testClientID     = "tempolens-test"
	testClientSecret = "test-secret"
	writeGroup       = "tempolens-test:Platform Team"
)

// mockIssuer is a minimal OIDC provider: discovery, JWKS and a token
// endpoint that enforces PKCE S256 and client authentication.
type mockIssuer struct {
	t      *testing.T
	srv    *httptest.Server
	key    *rsa.PrivateKey
	signer jose.Signer
	up     atomic.Bool

	mu    sync.Mutex
	codes map[string]grant
}

type grant struct {
	challenge string
	claims    map[string]any
}

func newMockIssuer(t *testing.T) *mockIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: "k1"}},
		(&jose.SignerOptions{}).WithType("JWT"))
	if err != nil {
		t.Fatal(err)
	}
	m := &mockIssuer{t: t, key: key, signer: signer, codes: map[string]grant{}}
	m.up.Store(true)
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", m.discovery)
	mux.HandleFunc("/keys", m.jwks)
	mux.HandleFunc("/token", m.token)
	m.srv = httptest.NewServer(mux)
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mockIssuer) discovery(w http.ResponseWriter, _ *http.Request) {
	if !m.up.Load() {
		http.Error(w, "down", http.StatusServiceUnavailable)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"issuer":                                m.srv.URL,
		"authorization_endpoint":                m.srv.URL + "/auth",
		"token_endpoint":                        m.srv.URL + "/token",
		"jwks_uri":                              m.srv.URL + "/keys",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"code_challenge_methods_supported":      []string{"S256"},
	})
}

func (m *mockIssuer) jwks(w http.ResponseWriter, _ *http.Request) {
	_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
		{Key: &m.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"},
	}})
}

func (m *mockIssuer) token(w http.ResponseWriter, r *http.Request) {
	id, secret, ok := r.BasicAuth()
	if !ok {
		id, secret = r.FormValue("client_id"), r.FormValue("client_secret")
	}
	if id != testClientID || secret != testClientSecret {
		http.Error(w, `{"error":"invalid_client"}`, http.StatusUnauthorized)
		return
	}
	m.mu.Lock()
	g, found := m.codes[r.FormValue("code")]
	delete(m.codes, r.FormValue("code"))
	m.mu.Unlock()
	sum := sha256.Sum256([]byte(r.FormValue("code_verifier")))
	if !found || base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": "at", "token_type": "Bearer", "expires_in": 3600, "id_token": m.sign(g.claims),
	})
}

func (m *mockIssuer) sign(claims map[string]any) string {
	now := time.Now()
	full := map[string]any{"iss": m.srv.URL, "aud": testClientID, "sub": "user-1", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
	for k, v := range claims {
		full[k] = v
	}
	payload, _ := json.Marshal(full)
	obj, err := m.signer.Sign(payload)
	if err != nil {
		m.t.Fatal(err)
	}
	s, _ := obj.CompactSerialize()
	return s
}

// issue registers code for the authorization request in authURL.
func (m *mockIssuer) issue(code, authURL string, claims map[string]any) {
	u, _ := url.Parse(authURL)
	q := u.Query()
	if _, set := claims["nonce"]; !set {
		claims["nonce"] = q.Get("nonce")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.codes[code] = grant{challenge: q.Get("code_challenge"), claims: claims}
}

type oidcEnv struct {
	o    *OIDC
	iss  *mockIssuer
	keys *Keyring
	logs *strings.Builder
	mu   *sync.Mutex
}

func newOIDCEnv(t *testing.T, readGroups []string) *oidcEnv {
	t.Helper()
	iss := newMockIssuer(t)
	keys, _ := NewKeyring([][]byte{key(7)})
	logs, mu := &strings.Builder{}, &sync.Mutex{}
	log := slog.New(slog.NewJSONHandler(lockedWriter{logs, mu}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	a := config.Auth{
		ProviderURL: iss.srv.URL, ClientID: testClientID, ClientSecret: testClientSecret,
		CallbackURL: "http://localhost:8234/auth/sso/callback", CallbackPath: "/auth/sso/callback",
		Scopes: []string{"openid", "profile", "email", "groups"}, WriteGroups: []string{writeGroup},
		ReadGroups: readGroups, SessionTTL: 8 * time.Hour,
	}
	o := NewOIDC(a, keys, audit.New(log), log)
	o.minBackoff, o.maxBackoff = 5*time.Millisecond, 20*time.Millisecond
	return &oidcEnv{o: o, iss: iss, keys: keys, logs: logs, mu: mu}
}

type lockedWriter struct {
	b  *strings.Builder
	mu *sync.Mutex
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (e *oidcEnv) logText() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.logs.String()
}

func (e *oidcEnv) ready(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go e.o.Run(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for !e.o.Ready() {
		if time.Now().After(deadline) {
			t.Fatal("discovery did not succeed")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// startLogin calls /auth/sso and returns the provider URL and oauth cookie.
func (e *oidcEnv) startLogin(t *testing.T, returnTo string) (string, *http.Cookie) {
	t.Helper()
	w := httptest.NewRecorder()
	e.o.SSO(w, httptest.NewRequest(http.MethodGet, "/auth/sso?returnTo="+url.QueryEscape(returnTo), nil))
	if w.Code != http.StatusFound {
		t.Fatalf("/auth/sso: status %d", w.Code)
	}
	var oauth *http.Cookie
	for _, c := range w.Result().Cookies() {
		if strings.HasPrefix(c.Name, OAuthCookie+"_") && c.MaxAge > 0 {
			oauth = c
		}
	}
	if oauth == nil || !oauth.HttpOnly || !oauth.Secure || oauth.SameSite != http.SameSiteLaxMode || oauth.Path != "/" {
		t.Fatalf("oauth cookie missing or weak: %+v", oauth)
	}
	return w.Header().Get("Location"), oauth
}

func (e *oidcEnv) callback(t *testing.T, query string, oauth *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/auth/sso/callback?"+query, nil)
	if oauth != nil {
		r.AddCookie(oauth)
	}
	w := httptest.NewRecorder()
	e.o.Callback(w, r)
	return w
}

func stateOf(t *testing.T, authURL string) string {
	t.Helper()
	u, _ := url.Parse(authURL)
	return u.Query().Get("state")
}

func sessionOf(t *testing.T, e *oidcEnv, w *httptest.ResponseRecorder) *Principal {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == SessionCookie && c.Value != "" {
			if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.MaxAge != int((8*time.Hour).Seconds()) {
				t.Fatalf("weak session cookie: %+v", c)
			}
			p, err := e.keys.OpenSession(c.Value, time.Now())
			if err != nil {
				t.Fatalf("open session: %v", err)
			}
			return p
		}
	}
	return nil
}

func TestDiscoveryIsLazy(t *testing.T) {
	e := newOIDCEnv(t, nil)
	e.iss.up.Store(false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.o.Run(ctx)

	w := httptest.NewRecorder()
	e.o.SSO(w, httptest.NewRequest(http.MethodGet, "/auth/sso", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("/auth/sso while discovery is down: %d, want 503", w.Code)
	}
	w = httptest.NewRecorder()
	e.o.Callback(w, httptest.NewRequest(http.MethodGet, "/auth/sso/callback?state=x&code=y", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("callback while discovery is down: %d, want 503", w.Code)
	}

	e.iss.up.Store(true)
	deadline := time.Now().Add(5 * time.Second)
	for !e.o.Ready() {
		if time.Now().After(deadline) {
			t.Fatal("discovery never recovered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.startLogin(t, "/")
}

func TestLoginFlow(t *testing.T) {
	for _, tc := range []struct {
		name   string
		groups []string
		read   []string
		want   int
		role   config.Role
	}{
		{"write group", []string{"x", writeGroup}, nil, http.StatusFound, config.RoleWrite},
		{"padded group is read", []string{" " + writeGroup}, nil, http.StatusFound, config.RoleRead},
		{"no groups is read", nil, nil, http.StatusFound, config.RoleRead},
		{"read groups set, no match", []string{"x"}, []string{"readers"}, http.StatusForbidden, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newOIDCEnv(t, tc.read)
			e.ready(t)
			authURL, oauth := e.startLogin(t, "/namespaces/default/workflows?query=a%3D1")

			u, _ := url.Parse(authURL)
			q := u.Query()
			if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("nonce") == "" || q.Get("state") == "" {
				t.Fatalf("authorization request lacks PKCE/state/nonce: %s", authURL)
			}
			if scopes := q.Get("scope"); !strings.Contains(scopes, "groups") || !strings.Contains(scopes, "openid") {
				t.Fatalf("scopes = %q", scopes)
			}

			claims := map[string]any{"email": "a@example.com", "email_verified": true, "name": "A"}
			if tc.groups != nil {
				claims["groups"] = tc.groups
			}
			e.iss.issue("code-1", authURL, claims)
			w := e.callback(t, "state="+url.QueryEscape(stateOf(t, authURL))+"&code=code-1", oauth)
			if w.Code != tc.want {
				t.Fatalf("callback: status %d, want %d (%s)", w.Code, tc.want, w.Body.String())
			}
			p := sessionOf(t, e, w)
			if tc.want == http.StatusForbidden {
				if p != nil {
					t.Fatal("denied login set a session")
				}
				if !strings.Contains(e.logText(), `"event":"login_denied"`) {
					t.Fatalf("login_denied not audited: %s", e.logText())
				}
				return
			}
			if w.Header().Get("Location") != "/namespaces/default/workflows?query=a%3D1" {
				t.Fatalf("redirect = %q", w.Header().Get("Location"))
			}
			if p == nil || p.Role != tc.role || p.Email != "a@example.com" || p.Sub != "user-1" {
				t.Fatalf("session principal = %+v, want role %q", p, tc.role)
			}
			if !strings.Contains(e.logText(), `"event":"login"`) {
				t.Fatalf("login not audited: %s", e.logText())
			}
		})
	}
}

func TestCallbackRejects(t *testing.T) {
	e := newOIDCEnv(t, nil)
	e.ready(t)

	authURL, oauth := e.startLogin(t, "/")
	e.iss.issue("c-state", authURL, map[string]any{})
	if w := e.callback(t, "state=wrong&code=c-state", oauth); w.Code != http.StatusBadRequest {
		t.Errorf("state mismatch: %d, want 400", w.Code)
	}

	authURL, oauth = e.startLogin(t, "/")
	e.iss.issue("c-nonce", authURL, map[string]any{"nonce": "other"})
	if w := e.callback(t, "state="+url.QueryEscape(stateOf(t, authURL))+"&code=c-nonce", oauth); w.Code != http.StatusUnauthorized {
		t.Errorf("nonce mismatch: %d, want 401", w.Code)
	}

	authURL, _ = e.startLogin(t, "/")
	if w := e.callback(t, "state="+url.QueryEscape(stateOf(t, authURL))+"&code=x", nil); w.Code != http.StatusBadRequest {
		t.Errorf("missing oauth cookie: %d, want 400", w.Code)
	}

	// A login cookie from another login: its PKCE verifier does not match
	// the challenge registered for this code, so the exchange fails.
	authURL1, _ := e.startLogin(t, "/")
	authURL2, oauth2 := e.startLogin(t, "/")
	e.iss.issue("c-pkce", authURL1, map[string]any{"nonce": "n"})
	if w := e.callback(t, "state="+url.QueryEscape(stateOf(t, authURL2))+"&code=c-pkce", oauth2); w.Code != http.StatusUnauthorized {
		t.Errorf("PKCE verifier mismatch: %d, want 401", w.Code)
	}

	authURL, oauth = e.startLogin(t, "/")
	if w := e.callback(t, "state="+url.QueryEscape(stateOf(t, authURL)), oauth); w.Code != http.StatusBadRequest {
		t.Errorf("missing code: %d, want 400", w.Code)
	}
}

func TestSSOSanitizesReturnTo(t *testing.T) {
	e := newOIDCEnv(t, nil)
	e.ready(t)
	authURL, oauth := e.startLogin(t, "//evil.example/x")
	e.iss.issue("c", authURL, map[string]any{})
	w := e.callback(t, "state="+url.QueryEscape(stateOf(t, authURL))+"&code=c", oauth)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/" {
		t.Fatalf("status %d location %q, want 302 to /", w.Code, w.Header().Get("Location"))
	}
}

func callbackFor(t *testing.T, e *oidcEnv, code, authURL string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/auth/sso/callback?state="+url.QueryEscape(stateOf(t, authURL))+"&code="+code, nil)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	e.o.Callback(w, r)
	return w
}

// TestParallelLogins runs two logins from one browser (two tabs): both
// login cookies coexist, and each callback completes with its own state.
func TestParallelLogins(t *testing.T) {
	e := newOIDCEnv(t, nil)
	e.ready(t)
	urlA, cookieA := e.startLogin(t, "/a")
	urlB, cookieB := e.startLogin(t, "/b")
	if cookieA.Name == cookieB.Name {
		t.Fatalf("both logins share the cookie %s", cookieA.Name)
	}
	e.iss.issue("code-a", urlA, map[string]any{"email": "a@example.com", "email_verified": true})
	e.iss.issue("code-b", urlB, map[string]any{"email": "a@example.com", "email_verified": true})
	// The browser sends every cookie it holds; B finishes first.
	if w := callbackFor(t, e, "code-b", urlB, cookieA, cookieB); w.Code != http.StatusFound || w.Header().Get("Location") != "/b" {
		t.Fatalf("login B: %d %q", w.Code, w.Header().Get("Location"))
	}
	if w := callbackFor(t, e, "code-a", urlA, cookieA); w.Code != http.StatusFound || w.Header().Get("Location") != "/a" {
		t.Fatalf("login A after B: %d %q %s", w.Code, w.Header().Get("Location"), w.Body.String())
	}
	// A login cookie is bound to its own name (AAD): it cannot complete
	// another login.
	renamed := &http.Cookie{Name: cookieB.Name, Value: cookieA.Value}
	if w := callbackFor(t, e, "code-x", urlB, renamed); w.Code != http.StatusBadRequest {
		t.Fatalf("cookie replayed under another login's name: %d, want 400", w.Code)
	}
}

func TestLoginCookieCap(t *testing.T) {
	e := newOIDCEnv(t, nil)
	e.ready(t)
	r := httptest.NewRequest(http.MethodGet, "/auth/sso", nil)
	for i := 0; i < maxLoginCookies; i++ {
		r.AddCookie(&http.Cookie{Name: fmt.Sprintf("%s_old%05d", OAuthCookie, i), Value: "x"})
	}
	w := httptest.NewRecorder()
	e.o.SSO(w, r)
	cleared, set := 0, 0
	for _, c := range w.Result().Cookies() {
		switch {
		case c.MaxAge < 0:
			cleared++
		case strings.HasPrefix(c.Name, OAuthCookie+"_"):
			set++
		}
	}
	if cleared != maxLoginCookies || set != 1 {
		t.Fatalf("cleared %d, set %d; want %d cleared and 1 new", cleared, set, maxLoginCookies)
	}
}

func TestBadStateFormat(t *testing.T) {
	e := newOIDCEnv(t, nil)
	e.ready(t)
	for _, q := range []string{"state=short&code=c", "state=" + url.QueryEscape("a;b=c/../"+strings.Repeat("x", 40)) + "&code=c", "code=c"} {
		w := httptest.NewRecorder()
		e.o.Callback(w, httptest.NewRequest(http.MethodGet, "/auth/sso/callback?"+q, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", q, w.Code)
		}
	}
}

// TestUnverifiedEmail: identity and audit fall back to sub unless
// email_verified is true (a JSON boolean or the string "true").
func TestUnverifiedEmail(t *testing.T) {
	for _, tc := range []struct {
		name     string
		verified any
		want     string
	}{
		{"verified", true, "a@example.com"},
		{"verified as string", "true", "a@example.com"},
		{"unverified", false, ""},
		{"claim missing", nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newOIDCEnv(t, nil)
			e.ready(t)
			authURL, cookieA := e.startLogin(t, "/")
			claims := map[string]any{"email": "a@example.com", "groups": []string{writeGroup}}
			if tc.verified != nil {
				claims["email_verified"] = tc.verified
			}
			e.iss.issue("c", authURL, claims)
			w := callbackFor(t, e, "c", authURL, cookieA)
			p := sessionOf(t, e, w)
			if p == nil || p.Email != tc.want {
				t.Fatalf("principal = %+v, want email %q", p, tc.want)
			}
			wantUser := tc.want
			if wantUser == "" {
				wantUser = "user-1"
				if p.Identity() != "tempolens:user-1" {
					t.Fatalf("identity = %q, want the subject", p.Identity())
				}
			}
			if !strings.Contains(e.logText(), `"event":"login","user":"`+wantUser+`"`) {
				t.Fatalf("audit user is not %q: %s", wantUser, e.logText())
			}
		})
	}
}
