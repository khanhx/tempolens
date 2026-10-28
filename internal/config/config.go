// Package config loads the Tempolens configuration from the environment.
//
// Only TEMPOLENS_*, TEMPORAL_ADDRESS, TEMPORAL_TLS_* and PORT are read.
// Upstream temporalio/ui variables (TEMPORAL_UI_*, TEMPORAL_AUTH_*, ...) and
// TEMPORAL_PORT (k8s service links inject "tcp://..." into it) are ignored.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Role is the access level of a principal.
type Role string

const (
	RoleRead  Role = "read"
	RoleWrite Role = "write"
	// RoleAdmin implies write, which implies read.
	RoleAdmin Role = "admin"
)

const (
	defaultPort        = 8080
	sessionKeyLen      = 32
	scanMaxWorkflowCap = 1000
)

// requiredScopes are always requested, because role mapping needs groups.
var requiredScopes = []string{"openid", "groups"}

// TLS configures the connection to the Temporal frontend.
type TLS struct {
	CAFile             string
	CertFile           string
	KeyFile            string
	ServerName         string
	InsecureSkipVerify bool
}

// Enabled reports whether TLS is used; it is on when a CA or a client cert is set.
func (t TLS) Enabled() bool { return t.CAFile != "" || t.CertFile != "" }

// ActionFlags holds the per-action *_DISABLED switches.
type ActionFlags struct {
	Terminate bool
	Cancel    bool
	Signal    bool
	Update    bool
	Reset     bool
	Pause     bool
	Batch     bool
	Start     bool
	Schedule  bool
	Nexus     bool
	// Delete covers workflow delete and batch delete.
	Delete          bool
	Activity        bool
	Namespace       bool
	SearchAttribute bool
}

// Auth configures OIDC login and role mapping.
type Auth struct {
	Disabled     bool
	DisabledRole Role
	ProviderURL  string
	ClientID     string
	ClientSecret string
	CallbackURL  string
	// CallbackPath is the path of CallbackURL, served as the callback route.
	CallbackPath string
	Scopes       []string
	// ScopesAdded lists required scopes that were missing from the env and added.
	ScopesAdded []string
	AdminGroups []string
	WriteGroups []string
	ReadGroups  []string
	SessionTTL  time.Duration
	// SessionKeys are 32-byte keys; the first seals, all open.
	SessionKeys [][]byte
}

// Codec is passed to the browser, which calls the codec server directly.
type Codec struct {
	Endpoint            string
	IncludeCredentials  bool
	DefaultErrorMessage string
	DefaultErrorLink    string
}

// Limits bounds scans, fan-out and per-principal usage.
type Limits struct {
	ScanMaxWorkflows    int
	ScanConcurrency     int
	ScanTimeout         time.Duration
	ScanMaxInflight     int
	FanoutConcurrency   int
	FanoutMaxNamespaces int
	XAPIRPS             float64
	MaxStreamsPerUser   int
}

// Config is the full server configuration.
type Config struct {
	TemporalAddress string
	Port            int
	PublicOrigin    string
	// ListenHost is the interface to listen on: "" means every interface.
	ListenHost          string
	TLS                 TLS
	DefaultNamespace    string
	ShowSystemNamespace bool
	DisableWriteActions bool
	// ProtectedNamespaces can never be deleted (in addition to default and
	// temporal-system).
	ProtectedNamespaces []string
	Disabled            ActionFlags
	Auth                Auth
	Codec               Codec
	LogLevel            slog.Level
	Limits              Limits
}

// FromEnv loads the configuration from the process environment.
func FromEnv() (*Config, error) { return Load(os.Getenv) }

// Port returns the HTTP listen port: TEMPOLENS_PORT, else PORT, else 8080.
// It never reads TEMPORAL_PORT.
func Port(getenv func(string) string) (int, error) {
	name, raw := "TEMPOLENS_PORT", strings.TrimSpace(getenv("TEMPOLENS_PORT"))
	if raw == "" {
		name, raw = "PORT", strings.TrimSpace(getenv("PORT"))
	}
	if raw == "" {
		return defaultPort, nil
	}
	p, err := strconv.Atoi(raw)
	if err != nil || p < 1 || p > 65535 {
		return 0, fmt.Errorf("%s: invalid port %q", name, raw)
	}
	return p, nil
}

// Load builds a Config from getenv and reports every invalid or missing value at once.
func Load(getenv func(string) string) (*Config, error) {
	p := parser{getenv: getenv}
	c := &Config{
		TemporalAddress:     p.str("TEMPORAL_ADDRESS", "127.0.0.1:7233"),
		DefaultNamespace:    p.str("TEMPOLENS_DEFAULT_NAMESPACE", "default"),
		ShowSystemNamespace: p.boolean("TEMPOLENS_SHOW_TEMPORAL_SYSTEM_NAMESPACE"),
		ProtectedNamespaces: splitGroups(p.str("TEMPOLENS_PROTECTED_NAMESPACES", "default")),
		DisableWriteActions: p.boolean("TEMPOLENS_DISABLE_WRITE_ACTIONS"),
		TLS: TLS{
			CAFile:             p.str("TEMPORAL_TLS_CA", ""),
			CertFile:           p.str("TEMPORAL_TLS_CERT", ""),
			KeyFile:            p.str("TEMPORAL_TLS_KEY", ""),
			ServerName:         p.str("TEMPORAL_TLS_SERVER_NAME", ""),
			InsecureSkipVerify: p.boolean("TEMPORAL_TLS_INSECURE_SKIP_VERIFY"),
		},
		Disabled: ActionFlags{
			Terminate:       p.boolean("TEMPOLENS_WORKFLOW_TERMINATE_DISABLED"),
			Cancel:          p.boolean("TEMPOLENS_WORKFLOW_CANCEL_DISABLED"),
			Signal:          p.boolean("TEMPOLENS_WORKFLOW_SIGNAL_DISABLED"),
			Update:          p.boolean("TEMPOLENS_WORKFLOW_UPDATE_DISABLED"),
			Reset:           p.boolean("TEMPOLENS_WORKFLOW_RESET_DISABLED"),
			Pause:           p.boolean("TEMPOLENS_WORKFLOW_PAUSE_DISABLED"),
			Batch:           p.boolean("TEMPOLENS_BATCH_ACTIONS_DISABLED"),
			Start:           p.boolean("TEMPOLENS_START_WORKFLOW_DISABLED"),
			Schedule:        p.boolean("TEMPOLENS_SCHEDULE_ACTIONS_DISABLED"),
			Nexus:           p.boolean("TEMPOLENS_NEXUS_ACTIONS_DISABLED"),
			Delete:          p.boolean("TEMPOLENS_WORKFLOW_DELETE_DISABLED"),
			Activity:        p.boolean("TEMPOLENS_ACTIVITY_ACTIONS_DISABLED"),
			Namespace:       p.boolean("TEMPOLENS_NAMESPACE_ACTIONS_DISABLED"),
			SearchAttribute: p.boolean("TEMPOLENS_SEARCH_ATTRIBUTE_ACTIONS_DISABLED"),
		},
		Codec: Codec{
			Endpoint:            p.str("TEMPOLENS_CODEC_ENDPOINT", ""),
			IncludeCredentials:  p.boolean("TEMPOLENS_CODEC_INCLUDE_CREDENTIALS"),
			DefaultErrorMessage: p.str("TEMPOLENS_CODEC_DEFAULT_ERROR_MESSAGE", ""),
			DefaultErrorLink:    p.str("TEMPOLENS_CODEC_DEFAULT_ERROR_LINK", ""),
		},
		LogLevel: p.logLevel("TEMPOLENS_LOG_LEVEL"),
		Limits: Limits{
			ScanMaxWorkflows:    p.positiveInt("TEMPOLENS_SCAN_MAX_WORKFLOWS", 200),
			ScanConcurrency:     p.positiveInt("TEMPOLENS_SCAN_CONCURRENCY", 8),
			ScanTimeout:         p.duration("TEMPOLENS_SCAN_TIMEOUT", 20*time.Second),
			ScanMaxInflight:     p.positiveInt("TEMPOLENS_SCAN_MAX_INFLIGHT", 2),
			FanoutConcurrency:   p.positiveInt("TEMPOLENS_FANOUT_CONCURRENCY", 8),
			FanoutMaxNamespaces: p.positiveInt("TEMPOLENS_FANOUT_MAX_NAMESPACES", 50),
			XAPIRPS:             p.positiveFloat("TEMPOLENS_XAPI_RPS", 5),
			MaxStreamsPerUser:   p.positiveInt("TEMPOLENS_MAX_STREAMS_PER_USER", 4),
		},
	}
	if c.Limits.ScanMaxWorkflows > scanMaxWorkflowCap {
		p.fail("TEMPOLENS_SCAN_MAX_WORKFLOWS: must be at most %d", scanMaxWorkflowCap)
	}
	if (c.TLS.CertFile == "") != (c.TLS.KeyFile == "") {
		p.fail("TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY must be set together")
	}

	port, err := Port(getenv)
	if err != nil {
		p.errs = append(p.errs, err)
	}
	c.Port = port

	c.Auth = p.auth()
	c.PublicOrigin = p.publicOrigin(c.Auth, port)
	c.ListenHost = p.listenHost(c.Auth.Disabled)

	if err := errors.Join(p.errs...); err != nil {
		return nil, err
	}
	return c, nil
}

func (p *parser) auth() Auth {
	a := Auth{
		Disabled:     p.boolean("TEMPOLENS_AUTH_DISABLED"),
		DisabledRole: p.role("TEMPOLENS_AUTH_DISABLED_ROLE"),
		ProviderURL:  p.str("TEMPOLENS_AUTH_PROVIDER_URL", ""),
		ClientID:     p.str("TEMPOLENS_AUTH_CLIENT_ID", ""),
		ClientSecret: p.str("TEMPOLENS_AUTH_CLIENT_SECRET", ""),
		CallbackURL:  p.str("TEMPOLENS_AUTH_CALLBACK_URL", ""),
		AdminGroups:  splitGroups(p.str("TEMPOLENS_AUTH_ADMIN_GROUPS", "")),
		WriteGroups:  splitGroups(p.str("TEMPOLENS_AUTH_WRITE_GROUPS", "")),
		ReadGroups:   splitGroups(p.str("TEMPOLENS_AUTH_READ_GROUPS", "")),
		SessionTTL:   p.duration("TEMPOLENS_SESSION_TTL", 8*time.Hour),
		SessionKeys:  p.sessionKeys("TEMPOLENS_SESSION_KEYS"),
	}
	a.Scopes, a.ScopesAdded = scopes(p.str("TEMPOLENS_AUTH_SCOPES", "openid,profile,email,groups"))

	if a.Disabled {
		if a.ProviderURL != "" {
			p.fail("TEMPOLENS_AUTH_DISABLED=true cannot be combined with TEMPOLENS_AUTH_PROVIDER_URL")
		}
		return a
	}

	for _, req := range []struct{ name, val string }{
		{"TEMPOLENS_AUTH_PROVIDER_URL", a.ProviderURL},
		{"TEMPOLENS_AUTH_CLIENT_ID", a.ClientID},
		{"TEMPOLENS_AUTH_CLIENT_SECRET", a.ClientSecret},
		{"TEMPOLENS_AUTH_CALLBACK_URL", a.CallbackURL},
	} {
		if req.val == "" {
			p.fail("%s is required when auth is enabled", req.name)
		}
	}
	if len(a.SessionKeys) == 0 && p.str("TEMPOLENS_SESSION_KEYS", "") == "" {
		p.fail("TEMPOLENS_SESSION_KEYS is required when auth is enabled")
	}
	if a.ProviderURL != "" {
		if _, err := absoluteURL(a.ProviderURL); err != nil {
			p.fail("TEMPOLENS_AUTH_PROVIDER_URL: %v", err)
		}
	}
	if a.CallbackURL != "" {
		u, err := absoluteURL(a.CallbackURL)
		switch {
		case err != nil:
			p.fail("TEMPOLENS_AUTH_CALLBACK_URL: %v", err)
		case u.Path == "" || u.Path == "/":
			p.fail("TEMPOLENS_AUTH_CALLBACK_URL: must include a callback path such as /auth/sso/callback")
		default:
			a.CallbackPath = u.Path
		}
	}
	return a
}

// publicOrigin derives the browser-visible origin used by the CSRF check.
func (p *parser) publicOrigin(a Auth, port int) string {
	if raw := p.str("TEMPOLENS_PUBLIC_ORIGIN", ""); raw != "" {
		o, err := origin(raw, true)
		if err != nil {
			p.fail("TEMPOLENS_PUBLIC_ORIGIN: %v", err)
		}
		return o
	}
	if !a.Disabled {
		if a.CallbackURL == "" {
			p.fail("TEMPOLENS_PUBLIC_ORIGIN cannot be derived: set it or TEMPOLENS_AUTH_CALLBACK_URL")
			return ""
		}
		o, err := origin(a.CallbackURL, false)
		if err != nil {
			// The callback URL error is already reported by auth().
			return ""
		}
		return o
	}
	if port == 0 {
		return ""
	}
	return fmt.Sprintf("http://localhost:%d", port)
}

// ListenAddr is the host:port the HTTP server listens on.
func (c *Config) ListenAddr() string {
	return net.JoinHostPort(c.ListenHost, strconv.Itoa(c.Port))
}

// ListenHost reads TEMPOLENS_LISTEN_ADDR: an IP address, "localhost", or
// "0.0.0.0"/"::" for every interface. It defaults to every interface when
// auth is on (needed in Kubernetes) and to 127.0.0.1 when auth is disabled,
// so an unauthenticated instance is not reachable from other hosts.
func ListenHost(getenv func(string) string, authDisabled bool) (string, error) {
	raw := strings.TrimSpace(getenv("TEMPOLENS_LISTEN_ADDR"))
	switch {
	case raw == "" && authDisabled:
		return "127.0.0.1", nil
	case raw == "" || raw == "0.0.0.0" || raw == "::":
		return "", nil
	case raw == "localhost" || net.ParseIP(raw) != nil:
		return raw, nil
	}
	return "", fmt.Errorf("TEMPOLENS_LISTEN_ADDR: must be an IP address, localhost, 0.0.0.0 or ::, got %q", raw)
}

func (p *parser) listenHost(authDisabled bool) string {
	h, err := ListenHost(p.getenv, authDisabled)
	if err != nil {
		p.errs = append(p.errs, err)
	}
	return h
}

// LogValue renders the configuration for logs with every secret redacted.
func (c *Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("temporalAddress", c.TemporalAddress),
		slog.Int("port", c.Port),
		slog.String("listenAddr", c.ListenAddr()),
		slog.String("publicOrigin", c.PublicOrigin),
		slog.Bool("tls", c.TLS.Enabled()),
		slog.String("tlsServerName", c.TLS.ServerName),
		slog.Bool("tlsInsecureSkipVerify", c.TLS.InsecureSkipVerify),
		slog.String("defaultNamespace", c.DefaultNamespace),
		slog.Bool("showSystemNamespace", c.ShowSystemNamespace),
		slog.Bool("disableWriteActions", c.DisableWriteActions),
		slog.Group("disabled",
			slog.Bool("terminate", c.Disabled.Terminate),
			slog.Bool("cancel", c.Disabled.Cancel),
			slog.Bool("signal", c.Disabled.Signal),
			slog.Bool("update", c.Disabled.Update),
			slog.Bool("reset", c.Disabled.Reset),
			slog.Bool("pause", c.Disabled.Pause),
			slog.Bool("batch", c.Disabled.Batch),
			slog.Bool("start", c.Disabled.Start),
			slog.Bool("schedule", c.Disabled.Schedule),
			slog.Bool("nexus", c.Disabled.Nexus),
			slog.Bool("delete", c.Disabled.Delete),
			slog.Bool("activity", c.Disabled.Activity),
			slog.Bool("namespace", c.Disabled.Namespace),
			slog.Bool("searchAttribute", c.Disabled.SearchAttribute),
		),
		slog.Group("auth",
			slog.Bool("disabled", c.Auth.Disabled),
			slog.String("disabledRole", string(c.Auth.DisabledRole)),
			slog.String("providerURL", c.Auth.ProviderURL),
			slog.String("clientID", c.Auth.ClientID),
			slog.Bool("clientSecretSet", c.Auth.ClientSecret != ""),
			slog.String("callbackURL", c.Auth.CallbackURL),
			slog.Any("scopes", c.Auth.Scopes),
			slog.Any("adminGroups", c.Auth.AdminGroups),
			slog.Any("writeGroups", c.Auth.WriteGroups),
			slog.Any("readGroups", c.Auth.ReadGroups),
			slog.String("sessionTTL", c.Auth.SessionTTL.String()),
			slog.Int("sessionKeys", len(c.Auth.SessionKeys)),
		),
		slog.Group("codec",
			slog.String("endpoint", c.Codec.Endpoint),
			slog.Bool("includeCredentials", c.Codec.IncludeCredentials),
		),
		slog.String("logLevel", c.LogLevel.String()),
		slog.Group("limits",
			slog.Int("scanMaxWorkflows", c.Limits.ScanMaxWorkflows),
			slog.Int("scanConcurrency", c.Limits.ScanConcurrency),
			slog.String("scanTimeout", c.Limits.ScanTimeout.String()),
			slog.Int("scanMaxInflight", c.Limits.ScanMaxInflight),
			slog.Int("fanoutConcurrency", c.Limits.FanoutConcurrency),
			slog.Int("fanoutMaxNamespaces", c.Limits.FanoutMaxNamespaces),
			slog.Float64("xapiRPS", c.Limits.XAPIRPS),
			slog.Int("maxStreamsPerUser", c.Limits.MaxStreamsPerUser),
		),
	)
}

// parser reads env values and accumulates errors so all of them are reported together.
type parser struct {
	getenv func(string) string
	errs   []error
}

func (p *parser) fail(format string, args ...any) {
	p.errs = append(p.errs, fmt.Errorf(format, args...))
}

func (p *parser) str(name, def string) string {
	if v := strings.TrimSpace(p.getenv(name)); v != "" {
		return v
	}
	return def
}

func (p *parser) boolean(name string) bool {
	raw := p.str(name, "")
	if raw == "" {
		return false
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		p.fail("%s: invalid boolean %q", name, raw)
	}
	return v
}

func (p *parser) positiveInt(name string, def int) int {
	raw := p.str(name, "")
	if raw == "" {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 1 {
		p.fail("%s: must be a positive integer, got %q", name, raw)
		return def
	}
	return v
}

func (p *parser) positiveFloat(name string, def float64) float64 {
	raw := p.str(name, "")
	if raw == "" {
		return def
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || !(v > 0) {
		p.fail("%s: must be a positive number, got %q", name, raw)
		return def
	}
	return v
}

func (p *parser) duration(name string, def time.Duration) time.Duration {
	raw := p.str(name, "")
	if raw == "" {
		return def
	}
	v, err := time.ParseDuration(raw)
	if err != nil || v <= 0 {
		p.fail("%s: must be a positive duration such as 8h, got %q", name, raw)
		return def
	}
	return v
}

func (p *parser) role(name string) Role {
	switch raw := strings.ToLower(p.str(name, string(RoleRead))); Role(raw) {
	case RoleRead, RoleWrite, RoleAdmin:
		return Role(raw)
	default:
		p.fail("%s: must be read, write or admin, got %q", name, raw)
		return RoleRead
	}
}

func (p *parser) logLevel(name string) slog.Level {
	raw := p.str(name, "info")
	var l slog.Level
	if err := l.UnmarshalText([]byte(raw)); err != nil {
		p.fail("%s: must be debug, info, warn or error, got %q", name, raw)
		return slog.LevelInfo
	}
	return l
}

func (p *parser) sessionKeys(name string) [][]byte {
	raw := p.str(name, "")
	if raw == "" {
		return nil
	}
	var keys [][]byte
	invalid := false
	for i, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, err := decodeBase64(part)
		if err != nil || len(key) != sessionKeyLen {
			// Never echo key material in the error.
			p.fail("%s: key %d must be base64 of exactly %d bytes", name, i+1, sessionKeyLen)
			invalid = true
			continue
		}
		keys = append(keys, key)
	}
	if len(keys) == 0 && !invalid {
		p.fail("%s: no keys found", name)
	}
	return keys
}

func decodeBase64(s string) ([]byte, error) {
	var lastErr error
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		b, err := enc.DecodeString(s)
		if err == nil {
			return b, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// splitGroups splits a comma list. Entries are trimmed but inner spaces are
// kept, so "acme:Platform Team" stays one group.
func splitGroups(raw string) []string {
	var out []string
	for _, g := range strings.Split(raw, ",") {
		if g = strings.TrimSpace(g); g != "" {
			out = append(out, g)
		}
	}
	return out
}

// scopes splits a comma or space list, de-duplicates it and appends any
// missing required scope.
func scopes(raw string) (all, added []string) {
	seen := map[string]bool{}
	for _, s := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
		if !seen[s] {
			seen[s] = true
			all = append(all, s)
		}
	}
	for _, s := range requiredScopes {
		if !seen[s] {
			seen[s] = true
			all = append(all, s)
			added = append(added, s)
		}
	}
	return all, added
}

func absoluteURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid URL %q", raw)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("must be an absolute http(s) URL, got %q", raw)
	}
	return u, nil
}

// origin returns scheme://host[:port] of raw. When strict, raw must be a bare
// origin with no path, query, fragment or user info.
func origin(raw string, strict bool) (string, error) {
	u, err := absoluteURL(raw)
	if err != nil {
		return "", err
	}
	if strict && (u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "") {
		return "", fmt.Errorf("must be scheme://host[:port] only, got %q", raw)
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}
