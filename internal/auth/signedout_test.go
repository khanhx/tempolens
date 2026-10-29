package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSignedOut(t *testing.T) {
	for _, tc := range []struct {
		name     string
		disabled bool
		target   string
		link     string
		text     string
	}{
		{"default", false, "/auth/signed-out", `href="/auth/sso?returnTo=%2F"`, "You have been signed out"},
		{"returnTo kept", false, "/auth/signed-out?returnTo=%2Fnamespaces%2Fa%3Fq%3D1", `href="/auth/sso?returnTo=%2Fnamespaces%2Fa%3Fq%3D1"`, "identity provider session may still be active"},
		{"foreign returnTo dropped", false, "/auth/signed-out?returnTo=%2F%2Fevil.test", `href="/auth/sso?returnTo=%2F"`, "Sign in again"},
		{"auth disabled", true, "/auth/signed-out?returnTo=%2Fnamespaces%2Fa", `href="/namespaces/a"`, "Authentication is disabled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			SignedOut(tc.disabled)(w, httptest.NewRequest(http.MethodGet, tc.target, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("status %d, want 200", w.Code)
			}
			if loc := w.Header().Get("Location"); loc != "" {
				t.Fatalf("Location %q, want none: the page must not redirect", loc)
			}
			if ct := w.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
				t.Errorf("Content-Type %q", ct)
			}
			if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
				t.Errorf("Cache-Control %q, want no-store", cc)
			}
			body := w.Body.String()
			if !strings.Contains(body, tc.link) || !strings.Contains(body, tc.text) {
				t.Fatalf("body lacks %s or %q:\n%s", tc.link, tc.text, body)
			}
			// Nothing the CSP would block, and no automatic navigation.
			for _, bad := range []string{"<script", "<style", "style=", "<link", "http-equiv", "http://", "https://", "evil"} {
				if strings.Contains(strings.ToLower(body), bad) {
					t.Errorf("body contains %q", bad)
				}
			}
		})
	}
}
