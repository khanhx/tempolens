package main

import (
	"encoding/base64"
	"strings"
	"testing"

	"tempolens/internal/config"
)

func env(kv ...string) func(string) string {
	m := map[string]string{}
	for i := 0; i < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return func(k string) string { return m[k] }
}

// TestListenAddr checks that an auth-disabled server is loopback-only unless
// told otherwise, while an auth-enabled one listens on every interface.
func TestListenAddr(t *testing.T) {
	authOn := []string{
		"TEMPOLENS_AUTH_PROVIDER_URL", "https://dex.example.com", "TEMPOLENS_AUTH_CLIENT_ID", "c",
		"TEMPOLENS_AUTH_CLIENT_SECRET", "s", "TEMPOLENS_AUTH_CALLBACK_URL", "https://t.example.com/auth/sso/callback",
		"TEMPOLENS_SESSION_KEYS", testSessionKey,
	}
	for _, tc := range []struct {
		name string
		env  []string
		want string
	}{
		{"auth disabled defaults to loopback", []string{"TEMPOLENS_AUTH_DISABLED", "true", "TEMPOLENS_PORT", "8234"}, "127.0.0.1:8234"},
		{"auth disabled, explicit all interfaces (compose)", []string{"TEMPOLENS_AUTH_DISABLED", "true", "TEMPOLENS_LISTEN_ADDR", "0.0.0.0"}, ":8080"},
		{"auth on defaults to all interfaces", authOn, ":8080"},
		{"auth on, explicit address", append(append([]string{}, authOn...), "TEMPOLENS_LISTEN_ADDR", "10.0.0.5"), "10.0.0.5:8080"},
		{"IPv6 loopback", []string{"TEMPOLENS_AUTH_DISABLED", "true", "TEMPOLENS_LISTEN_ADDR", "::1"}, "[::1]:8080"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := config.Load(env(tc.env...))
			if err != nil {
				t.Fatal(err)
			}
			if got := cfg.ListenAddr(); got != tc.want {
				t.Fatalf("ListenAddr = %q, want %q", got, tc.want)
			}
		})
	}
	if _, err := config.Load(env("TEMPOLENS_AUTH_DISABLED", "true", "TEMPOLENS_LISTEN_ADDR", "evil.example")); err == nil ||
		!strings.Contains(err.Error(), "TEMPOLENS_LISTEN_ADDR") {
		t.Fatalf("hostname listen address: err = %v", err)
	}
}

func TestHealthTarget(t *testing.T) {
	for _, tc := range []struct {
		env  []string
		want string
	}{
		{nil, "http://127.0.0.1:8080/healthz"},
		{[]string{"TEMPOLENS_LISTEN_ADDR", "0.0.0.0", "PORT", "9000"}, "http://127.0.0.1:9000/healthz"},
		{[]string{"TEMPOLENS_LISTEN_ADDR", "10.0.0.5"}, "http://10.0.0.5:8080/healthz"},
	} {
		if got, err := healthTarget(env(tc.env...)); err != nil || got != tc.want {
			t.Errorf("healthTarget(%v) = %q, %v; want %q", tc.env, got, err, tc.want)
		}
	}
}

// testSessionKey is a fixed, obviously non-secret 32-byte test key.
var testSessionKey = base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
