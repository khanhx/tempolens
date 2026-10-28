package auth

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"tempolens/internal/config"
)

func key(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

func TestSanitizeReturnTo(t *testing.T) {
	for in, want := range map[string]string{
		"/a?b=1":                        "/a?b=1",
		"/namespaces/default/workflows": "/namespaces/default/workflows",
		"/w/a%2Fb?query=x%3D1":          "/w/a%2Fb?query=x%3D1",
		"":                              "/",
		"//evil":                        "/",
		`/\evil`:                        "/",
		"https://evil":                  "/",
		"/%09/evil":                     "/",
		"/%0A":                          "/",
		"/x%5Cy":                        "/",
		"/%2F/evil":                     "/",
		"evil":                          "/",
		"javascript:alert(1)":           "/",
		"/a\x7f":                        "/",
		"/ok\tno":                       "/",
	} {
		if got := SanitizeReturnTo(in); got != want {
			t.Errorf("SanitizeReturnTo(%q) = %q, want %q", in, got, want)
		}
	}
}

func principal() *Principal {
	return &Principal{Sub: "s", Email: "a@example.com", Name: "A", Role: config.RoleWrite, WriteGroup: "w", ReadGroup: "r"}
}

func TestSessionRoundTrip(t *testing.T) {
	k, _ := NewKeyring([][]byte{key(1)})
	now := time.Now()
	v, err := k.SealSession(principal(), now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	got, err := k.OpenSession(v, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if *got != *principal() {
		t.Fatalf("round trip: got %+v", got)
	}
	if len(v) > 600 {
		t.Fatalf("session cookie is %d bytes, expected a small constant size", len(v))
	}
}

func TestSessionRejects(t *testing.T) {
	k, _ := NewKeyring([][]byte{key(1)})
	now := time.Now()
	v, _ := k.SealSession(principal(), now, time.Hour)

	tampered := []byte(v)
	tampered[len(tampered)/2] ^= 1
	if _, err := k.OpenSession(string(tampered), now); err == nil {
		t.Error("tampered session accepted")
	}
	if _, err := k.OpenSession(v, now.Add(time.Hour+time.Second)); err == nil {
		t.Error("expired session accepted")
	}
	other, _ := NewKeyring([][]byte{key(2)})
	if _, err := other.OpenSession(v, now); err == nil {
		t.Error("session opened with an unrelated key")
	}
	oauth, _ := k.sealOAuth(oauthCookieName(strings.Repeat("s", 32)), oauthPayload{State: "s", Exp: now.Add(time.Hour).Unix()})
	if _, err := k.OpenSession(oauth, now); err == nil {
		t.Error("oauth cookie accepted as a session (AAD/subkey separation)")
	}
	// Same purpose, other cookie name: the AAD must differ.
	asOAuthName, _ := k.seal(purposeSession, OAuthCookie, sessionPayload{V: 1, Role: "read", Exp: now.Add(time.Hour).Unix()})
	if _, err := k.OpenSession(asOAuthName, now); err == nil {
		t.Error("value sealed under another cookie name accepted")
	}
	if _, err := k.OpenSession("not-base64!", now); err == nil {
		t.Error("garbage accepted")
	}
}

func TestKeyRotation(t *testing.T) {
	old, _ := NewKeyring([][]byte{key(1)})
	now := time.Now()
	v, _ := old.SealSession(principal(), now, time.Hour)

	rotated, _ := NewKeyring([][]byte{key(2), key(1)})
	if _, err := rotated.OpenSession(v, now); err != nil {
		t.Fatalf("old key must still open: %v", err)
	}
	nv, _ := rotated.SealSession(principal(), now, time.Hour)
	newOnly, _ := NewKeyring([][]byte{key(2)})
	if _, err := newOnly.OpenSession(nv, now); err != nil {
		t.Fatalf("new key must seal: %v", err)
	}
	if _, err := old.OpenSession(nv, now); err == nil {
		t.Fatal("value sealed after rotation opened with the old key only")
	}
	if a, b := old.PageTokenKeys()[0], rotated.PageTokenKeys()[1]; !bytes.Equal(a, b) {
		t.Fatal("page-token subkey must be derived deterministically per master key")
	}
	if bytes.Equal(old.PageTokenKeys()[0], key(1)) {
		t.Fatal("page-token key must be a derived subkey, not the master key")
	}
}

func TestMapGroups(t *testing.T) {
	a := config.Auth{WriteGroups: []string{"tempolens-test:Platform Team"}, AdminGroups: []string{"tempolens-test:Admins"}}
	for _, tc := range []struct {
		name   string
		groups []string
		read   []string
		role   config.Role
		ok     bool
	}{
		{"exact write group", []string{"other", "tempolens-test:Platform Team"}, nil, config.RoleWrite, true},
		{"padded claim is not trimmed", []string{" tempolens-test:Platform Team"}, nil, config.RoleRead, true},
		{"case differs", []string{"tempolens-test:platform team"}, nil, config.RoleRead, true},
		{"no groups", nil, nil, config.RoleRead, true},
		{"read groups set, no match", []string{"x"}, []string{"readers"}, "", false},
		{"read groups set, match", []string{"readers"}, []string{"readers"}, config.RoleRead, true},
		{"read groups set, write match", []string{"tempolens-test:Platform Team"}, []string{"readers"}, config.RoleWrite, true},
		{"admin group wins over write", []string{"tempolens-test:Platform Team", "tempolens-test:Admins"}, nil, config.RoleAdmin, true},
		{"read groups set, admin match", []string{"tempolens-test:Admins"}, []string{"readers"}, config.RoleAdmin, true},
		{"padded admin claim is not trimmed", []string{"tempolens-test:Admins "}, nil, config.RoleRead, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a.ReadGroups = tc.read
			role, _, ok := MapGroups(tc.groups, a)
			if role != tc.role || ok != tc.ok {
				t.Fatalf("got role=%q ok=%v, want role=%q ok=%v", role, ok, tc.role, tc.ok)
			}
		})
	}
}

func TestEffective(t *testing.T) {
	p := &Principal{Email: "a", Role: config.RoleWrite, WriteGroup: "w"}
	if eff, ok := Effective(p, config.Auth{WriteGroups: []string{"w"}}); !ok || eff.Role != config.RoleWrite {
		t.Fatalf("write group still configured: %+v ok=%v", eff, ok)
	}
	if eff, ok := Effective(p, config.Auth{WriteGroups: []string{"other"}}); !ok || eff.Role != config.RoleRead {
		t.Fatalf("write group removed from env must drop to read: %+v ok=%v", eff, ok)
	}
	if _, ok := Effective(p, config.Auth{WriteGroups: []string{"other"}, ReadGroups: []string{"r"}}); ok {
		t.Fatal("no group left with read groups configured must invalidate the session")
	}
	if eff, ok := Effective(&Principal{Role: config.RoleRead, ReadGroup: "r"}, config.Auth{ReadGroups: []string{"r"}}); !ok || eff.Role != config.RoleRead {
		t.Fatal("read group still configured must keep read")
	}

	adm := &Principal{Email: "a", Role: config.RoleAdmin, AdminGroup: "a", WriteGroup: "w"}
	for _, tc := range []struct {
		name string
		cfg  config.Auth
		role config.Role
		ok   bool
	}{
		{"admin group still configured", config.Auth{AdminGroups: []string{"a"}}, config.RoleAdmin, true},
		{"admin group removed, write group kept", config.Auth{WriteGroups: []string{"w"}}, config.RoleWrite, true},
		{"admin and write groups removed", config.Auth{}, config.RoleRead, true},
		{"admin group alone satisfies read groups", config.Auth{AdminGroups: []string{"a"}, ReadGroups: []string{"r"}}, config.RoleAdmin, true},
		{"nothing left with read groups set", config.Auth{ReadGroups: []string{"r"}}, "", false},
	} {
		eff, ok := Effective(adm, tc.cfg)
		if ok != tc.ok || (ok && eff.Role != tc.role) {
			t.Errorf("%s: got %+v ok=%v, want role %q ok=%v", tc.name, eff, ok, tc.role, tc.ok)
		}
	}
	// A write session never gains admin from a group it did not log in with.
	if eff, _ := Effective(&Principal{Role: config.RoleWrite, AdminGroup: "a", WriteGroup: "w"},
		config.Auth{AdminGroups: []string{"a"}, WriteGroups: []string{"w"}}); eff.Role != config.RoleWrite {
		t.Errorf("write session promoted to %q", eff.Role)
	}
}

func TestCSRF(t *testing.T) {
	h := CSRF("http://localhost:8234", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }))
	for _, tc := range []struct {
		name, method, origin, header string
		want                         int
	}{
		{"get passes", http.MethodGet, "", "", http.StatusTeapot},
		{"post ok", http.MethodPost, "http://localhost:8234", "1", http.StatusTeapot},
		{"post no header", http.MethodPost, "http://localhost:8234", "", http.StatusForbidden},
		{"post wrong header value", http.MethodPost, "http://localhost:8234", "true", http.StatusForbidden},
		{"post foreign origin", http.MethodPost, "http://evil.test", "1", http.StatusForbidden},
		{"post no origin", http.MethodPost, "", "1", http.StatusForbidden},
		{"delete foreign origin", http.MethodDelete, "http://evil.test", "1", http.StatusForbidden},
		{"put no header", http.MethodPut, "http://localhost:8234", "", http.StatusForbidden},
	} {
		r := httptest.NewRequest(tc.method, "/x", nil)
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if tc.header != "" {
			r.Header.Set(CSRFHeader, tc.header)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%s: status %d, want %d", tc.name, w.Code, tc.want)
		}
	}
}

func TestHostGuard(t *testing.T) {
	h := HostGuard(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }))
	for host, want := range map[string]int{
		"localhost:8234": http.StatusTeapot,
		"127.0.0.1:8234": http.StatusTeapot,
		"LOCALHOST":      http.StatusTeapot,
		"evil.test":      http.StatusForbidden,
		"evil.test:8234": http.StatusForbidden,
		"[::1]:8234":     http.StatusForbidden,
		"localhost.evil": http.StatusForbidden,
	} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Host = host
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Errorf("host %q: status %d, want %d", host, w.Code, want)
		}
	}
}
