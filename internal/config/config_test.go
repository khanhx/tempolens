package config

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
	"time"
)

var (
	keyA = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))
	keyB = base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))
)

// authEnv is a complete, valid auth-on environment.
func authEnv() map[string]string {
	return map[string]string{
		"TEMPOLENS_AUTH_PROVIDER_URL":  "https://dex.example.com/api/dex",
		"TEMPOLENS_AUTH_CLIENT_ID":     "tempolens",
		"TEMPOLENS_AUTH_CLIENT_SECRET": "secret",
		"TEMPOLENS_AUTH_CALLBACK_URL":  "https://tempolens.example.com/auth/sso/callback",
		"TEMPOLENS_SESSION_KEYS":       keyA,
	}
}

func load(t *testing.T, env map[string]string) (*Config, error) {
	t.Helper()
	return Load(func(k string) string { return env[k] })
}

func mustLoad(t *testing.T, env map[string]string) *Config {
	t.Helper()
	c, err := load(t, env)
	if err != nil {
		t.Fatalf("Load: unexpected error: %v", err)
	}
	return c
}

func mustFail(t *testing.T, env map[string]string, want string) {
	t.Helper()
	_, err := load(t, env)
	if err == nil {
		t.Fatalf("Load: expected error containing %q, got nil", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("Load: error %q does not contain %q", err, want)
	}
}

func TestDefaultsAuthOn(t *testing.T) {
	c := mustLoad(t, authEnv())
	if c.Auth.Disabled {
		t.Fatal("auth must be on by default")
	}
	if c.TemporalAddress != "127.0.0.1:7233" || c.Port != 8080 || c.DefaultNamespace != "default" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.Auth.SessionTTL != 8*time.Hour {
		t.Fatalf("SessionTTL = %v, want 8h", c.Auth.SessionTTL)
	}
	if c.Auth.CallbackPath != "/auth/sso/callback" {
		t.Fatalf("CallbackPath = %q", c.Auth.CallbackPath)
	}
	if !reflect.DeepEqual(c.Auth.Scopes, []string{"openid", "profile", "email", "groups"}) || len(c.Auth.ScopesAdded) != 0 {
		t.Fatalf("Scopes = %v added %v", c.Auth.Scopes, c.Auth.ScopesAdded)
	}
	want := Limits{
		ScanMaxWorkflows: 200, ScanConcurrency: 8, ScanTimeout: 20 * time.Second, ScanMaxInflight: 2,
		FanoutConcurrency: 8, FanoutMaxNamespaces: 50, XAPIRPS: 5, MaxStreamsPerUser: 4,
	}
	if c.Limits != want {
		t.Fatalf("Limits = %+v, want %+v", c.Limits, want)
	}
	if c.TLS.Enabled() {
		t.Fatal("TLS must be off by default")
	}
}

func TestMissingAuthFields(t *testing.T) {
	for _, name := range []string{
		"TEMPOLENS_AUTH_PROVIDER_URL",
		"TEMPOLENS_AUTH_CLIENT_ID",
		"TEMPOLENS_AUTH_CLIENT_SECRET",
		"TEMPOLENS_AUTH_CALLBACK_URL",
	} {
		t.Run(name, func(t *testing.T) {
			env := authEnv()
			delete(env, name)
			mustFail(t, env, name+" is required")
		})
	}
}

func TestAuthOnRequiresSessionKeys(t *testing.T) {
	env := authEnv()
	delete(env, "TEMPOLENS_SESSION_KEYS")
	mustFail(t, env, "TEMPOLENS_SESSION_KEYS is required")
}

func TestSessionKeys(t *testing.T) {
	env := authEnv()
	env["TEMPOLENS_SESSION_KEYS"] = keyA + " , " + keyB
	c := mustLoad(t, env)
	if len(c.Auth.SessionKeys) != 2 || string(c.Auth.SessionKeys[0]) != strings.Repeat("a", 32) {
		t.Fatalf("SessionKeys not parsed in order: %d keys", len(c.Auth.SessionKeys))
	}

	short := base64.StdEncoding.EncodeToString([]byte("too-short"))
	for name, val := range map[string]string{
		"short":       keyA + "," + short,
		"not base64":  "!!!not-base64!!!",
		"only commas": ",,",
	} {
		t.Run(name, func(t *testing.T) {
			env := authEnv()
			env["TEMPOLENS_SESSION_KEYS"] = val
			_, err := load(t, env)
			if err == nil {
				t.Fatal("expected an error")
			}
			if strings.Contains(err.Error(), short) || strings.Contains(err.Error(), keyA) {
				t.Fatalf("error leaks key material: %v", err)
			}
		})
	}
}

func TestLegacyAuthFlagIgnored(t *testing.T) {
	env := authEnv()
	env["TEMPORAL_AUTH_ENABLED"] = "false"
	if c := mustLoad(t, env); c.Auth.Disabled {
		t.Fatal("TEMPORAL_AUTH_ENABLED=false must not disable auth")
	}
	// Without the TEMPOLENS_ auth fields, the legacy flag cannot turn auth off either.
	mustFail(t, map[string]string{"TEMPORAL_AUTH_ENABLED": "false"}, "TEMPOLENS_AUTH_PROVIDER_URL is required")
}

func TestAuthDisabled(t *testing.T) {
	c := mustLoad(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true"})
	if !c.Auth.Disabled || c.Auth.DisabledRole != RoleRead {
		t.Fatalf("auth disabled: got disabled=%v role=%q", c.Auth.Disabled, c.Auth.DisabledRole)
	}
	if c.PublicOrigin != "http://localhost:8080" {
		t.Fatalf("PublicOrigin = %q, want http://localhost:8080", c.PublicOrigin)
	}

	c = mustLoad(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true", "TEMPOLENS_AUTH_DISABLED_ROLE": "write"})
	if c.Auth.DisabledRole != RoleWrite {
		t.Fatalf("DisabledRole = %q, want write", c.Auth.DisabledRole)
	}
	c = mustLoad(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true", "TEMPOLENS_AUTH_DISABLED_ROLE": "admin"})
	if c.Auth.DisabledRole != RoleAdmin {
		t.Fatalf("DisabledRole = %q, want admin", c.Auth.DisabledRole)
	}
	mustFail(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true", "TEMPOLENS_AUTH_DISABLED_ROLE": "root"}, "must be read, write or admin")
}

func TestAdminGroupsAndProtectedNamespaces(t *testing.T) {
	env := authEnv()
	c := mustLoad(t, env)
	if c.Auth.AdminGroups != nil {
		t.Fatalf("AdminGroups must have no default, got %q", c.Auth.AdminGroups)
	}
	if want := []string{"default"}; !reflect.DeepEqual(c.ProtectedNamespaces, want) {
		t.Fatalf("ProtectedNamespaces = %q, want %q", c.ProtectedNamespaces, want)
	}
	env["TEMPOLENS_AUTH_ADMIN_GROUPS"] = " acme:Platform Admins ,ops"
	env["TEMPOLENS_PROTECTED_NAMESPACES"] = "default, payments"
	c = mustLoad(t, env)
	if want := []string{"acme:Platform Admins", "ops"}; !reflect.DeepEqual(c.Auth.AdminGroups, want) {
		t.Fatalf("AdminGroups = %q, want %q", c.Auth.AdminGroups, want)
	}
	if want := []string{"default", "payments"}; !reflect.DeepEqual(c.ProtectedNamespaces, want) {
		t.Fatalf("ProtectedNamespaces = %q, want %q", c.ProtectedNamespaces, want)
	}
}

func TestAuthDisabledWithProviderURL(t *testing.T) {
	mustFail(t, map[string]string{
		"TEMPOLENS_AUTH_DISABLED":     "true",
		"TEMPOLENS_AUTH_PROVIDER_URL": "https://dex.example.com",
	}, "cannot be combined with TEMPOLENS_AUTH_PROVIDER_URL")
}

func TestGroupsTrimmedKeepInnerSpaces(t *testing.T) {
	env := authEnv()
	env["TEMPOLENS_AUTH_WRITE_GROUPS"] = " acme:Platform Team , x "
	env["TEMPOLENS_AUTH_READ_GROUPS"] = "a,, b ,"
	c := mustLoad(t, env)
	if want := []string{"acme:Platform Team", "x"}; !reflect.DeepEqual(c.Auth.WriteGroups, want) {
		t.Fatalf("WriteGroups = %q, want %q", c.Auth.WriteGroups, want)
	}
	if want := []string{"a", "b"}; !reflect.DeepEqual(c.Auth.ReadGroups, want) {
		t.Fatalf("ReadGroups = %q, want %q", c.Auth.ReadGroups, want)
	}
	if c := mustLoad(t, authEnv()); c.Auth.ReadGroups != nil {
		t.Fatalf("ReadGroups must be unset by default, got %q", c.Auth.ReadGroups)
	}
}

func TestScopesAddRequired(t *testing.T) {
	env := authEnv()
	env["TEMPOLENS_AUTH_SCOPES"] = "openid,email,profile"
	c := mustLoad(t, env)
	if want := []string{"openid", "email", "profile", "groups"}; !reflect.DeepEqual(c.Auth.Scopes, want) {
		t.Fatalf("Scopes = %v, want %v", c.Auth.Scopes, want)
	}
	if want := []string{"groups"}; !reflect.DeepEqual(c.Auth.ScopesAdded, want) {
		t.Fatalf("ScopesAdded = %v, want %v", c.Auth.ScopesAdded, want)
	}

	env["TEMPOLENS_AUTH_SCOPES"] = "email profile email"
	c = mustLoad(t, env)
	if want := []string{"email", "profile", "openid", "groups"}; !reflect.DeepEqual(c.Auth.Scopes, want) {
		t.Fatalf("Scopes = %v, want %v", c.Auth.Scopes, want)
	}
}

func TestPublicOrigin(t *testing.T) {
	c := mustLoad(t, authEnv())
	if c.PublicOrigin != "https://tempolens.example.com" {
		t.Fatalf("derived PublicOrigin = %q", c.PublicOrigin)
	}

	env := authEnv()
	env["TEMPOLENS_PUBLIC_ORIGIN"] = "http://localhost:8234/"
	if c := mustLoad(t, env); c.PublicOrigin != "http://localhost:8234" {
		t.Fatalf("explicit PublicOrigin = %q", c.PublicOrigin)
	}

	c = mustLoad(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true", "TEMPOLENS_PORT": "8234"})
	if c.PublicOrigin != "http://localhost:8234" {
		t.Fatalf("auth-off PublicOrigin = %q", c.PublicOrigin)
	}

	for _, bad := range []string{"localhost:8234", "http://localhost:8234/app", "ftp://x", "http://u:p@x"} {
		mustFail(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true", "TEMPOLENS_PUBLIC_ORIGIN": bad}, "TEMPOLENS_PUBLIC_ORIGIN")
	}
}

func TestCallbackURLValidated(t *testing.T) {
	env := authEnv()
	env["TEMPOLENS_AUTH_CALLBACK_URL"] = "/auth/sso/callback"
	mustFail(t, env, "TEMPOLENS_AUTH_CALLBACK_URL: must be an absolute")

	env["TEMPOLENS_AUTH_CALLBACK_URL"] = "https://tempolens.example.com"
	mustFail(t, env, "must include a callback path")
}

func TestPort(t *testing.T) {
	base := map[string]string{"TEMPOLENS_AUTH_DISABLED": "true"}
	with := func(kv ...string) map[string]string {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for i := 0; i < len(kv); i += 2 {
			env[kv[i]] = kv[i+1]
		}
		return env
	}

	if c := mustLoad(t, with("TEMPORAL_PORT", "tcp://10.0.0.1:7233")); c.Port != 8080 {
		t.Fatalf("TEMPORAL_PORT must be ignored, got port %d", c.Port)
	}
	if c := mustLoad(t, with("PORT", "9000")); c.Port != 9000 {
		t.Fatalf("PORT: got %d", c.Port)
	}
	if c := mustLoad(t, with("PORT", "9000", "TEMPOLENS_PORT", "8234")); c.Port != 8234 {
		t.Fatalf("TEMPOLENS_PORT must win over PORT, got %d", c.Port)
	}
	mustFail(t, with("TEMPOLENS_PORT", "70000"), "TEMPOLENS_PORT: invalid port")
	mustFail(t, with("PORT", "abc"), "PORT: invalid port")
}

func TestFlagsAndLimits(t *testing.T) {
	env := map[string]string{
		"TEMPOLENS_AUTH_DISABLED":               "true",
		"TEMPOLENS_WORKFLOW_TERMINATE_DISABLED": "true",
		"TEMPOLENS_SCHEDULE_ACTIONS_DISABLED":   "1",
		"TEMPOLENS_DISABLE_WRITE_ACTIONS":       "TRUE",
		"TEMPOLENS_SCAN_MAX_WORKFLOWS":          "1000",
		"TEMPOLENS_SCAN_TIMEOUT":                "5s",
		"TEMPOLENS_LOG_LEVEL":                   "debug",
		"TEMPORAL_TLS_CA":                       "/certs/ca.pem",
	}
	c := mustLoad(t, env)
	if !c.Disabled.Terminate || !c.Disabled.Schedule || c.Disabled.Cancel || !c.DisableWriteActions {
		t.Fatalf("flags = %+v disableWrite=%v", c.Disabled, c.DisableWriteActions)
	}
	if c.Limits.ScanMaxWorkflows != 1000 || c.Limits.ScanTimeout != 5*time.Second {
		t.Fatalf("limits = %+v", c.Limits)
	}
	if c.LogLevel.String() != "DEBUG" || !c.TLS.Enabled() {
		t.Fatalf("logLevel=%v tls=%v", c.LogLevel, c.TLS.Enabled())
	}

	for name, val := range map[string]string{
		"TEMPOLENS_SCAN_MAX_WORKFLOWS":    "1001",
		"TEMPOLENS_SCAN_CONCURRENCY":      "0",
		"TEMPOLENS_SESSION_TTL":           "-1h",
		"TEMPOLENS_XAPI_RPS":              "nope",
		"TEMPOLENS_DISABLE_WRITE_ACTIONS": "maybe",
		"TEMPOLENS_LOG_LEVEL":             "loud",
	} {
		mustFail(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true", name: val}, name)
	}
	mustFail(t, map[string]string{"TEMPOLENS_AUTH_DISABLED": "true", "TEMPORAL_TLS_CERT": "/c.pem"}, "must be set together")
}

func TestAllErrorsReported(t *testing.T) {
	_, err := load(t, map[string]string{"TEMPOLENS_SCAN_CONCURRENCY": "0"})
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{"TEMPOLENS_AUTH_CLIENT_ID", "TEMPOLENS_SESSION_KEYS", "TEMPOLENS_SCAN_CONCURRENCY", "TEMPOLENS_PUBLIC_ORIGIN cannot be derived"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestLogValueRedactsSecrets(t *testing.T) {
	env := authEnv()
	env["TEMPOLENS_AUTH_CLIENT_SECRET"] = "super-secret-value"
	c := mustLoad(t, env)
	out := c.LogValue().String()
	for _, secret := range []string{"super-secret-value", keyA, strings.Repeat("a", 32)} {
		if strings.Contains(out, secret) {
			t.Fatalf("log value leaks a secret: %s", out)
		}
	}
	if !strings.Contains(out, "clientSecretSet=true") || !strings.Contains(out, "sessionKeys=1") {
		t.Fatalf("log value lacks redacted markers: %s", out)
	}
}
