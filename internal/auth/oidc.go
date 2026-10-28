package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"tempolens/internal/audit"
	"tempolens/internal/config"
)

const (
	discoveryMinBackoff = time.Second
	discoveryMaxBackoff = 60 * time.Second
	idpTimeout          = 10 * time.Second
)

// OIDC runs the login flow: authorization code + PKCE S256 + state + nonce.
type OIDC struct {
	cfg   config.Auth
	keys  *Keyring
	audit *audit.Logger
	log   *slog.Logger
	http  *http.Client
	now   func() time.Time

	minBackoff time.Duration
	maxBackoff time.Duration

	mu       sync.RWMutex
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// NewOIDC returns the login handlers. Call Run to start discovery; until it
// succeeds, the login routes answer 503.
func NewOIDC(a config.Auth, keys *Keyring, auditLog *audit.Logger, log *slog.Logger) *OIDC {
	return &OIDC{
		cfg: a, keys: keys, audit: auditLog, log: log,
		http:       &http.Client{Timeout: idpTimeout},
		now:        time.Now,
		minBackoff: discoveryMinBackoff,
		maxBackoff: discoveryMaxBackoff,
	}
}

// Ready reports whether discovery has succeeded.
func (o *OIDC) Ready() bool {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.oauth != nil
}

// Run retries discovery with exponential backoff until it succeeds or ctx
// ends. A discovery failure never stops the process.
func (o *OIDC) Run(ctx context.Context) {
	backoff := o.minBackoff
	for {
		err := o.discover(ctx)
		if err == nil {
			o.log.Info("OIDC discovery succeeded", "issuer", o.cfg.ProviderURL)
			return
		}
		o.log.Warn("OIDC discovery failed; retrying", "issuer", o.cfg.ProviderURL, "error", err.Error(), "retryIn", backoff.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, o.maxBackoff)
	}
}

func (o *OIDC) discover(ctx context.Context) error {
	dctx, cancel := context.WithTimeout(oidc.ClientContext(ctx, o.http), idpTimeout)
	defer cancel()
	// The provider keeps only the HTTP client from this context, so the
	// timeout does not affect later key-set refreshes.
	provider, err := oidc.NewProvider(dctx, o.cfg.ProviderURL)
	if err != nil {
		return err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.oauth = &oauth2.Config{
		ClientID:     o.cfg.ClientID,
		ClientSecret: o.cfg.ClientSecret,
		RedirectURL:  o.cfg.CallbackURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       o.cfg.Scopes,
	}
	o.verifier = provider.Verifier(&oidc.Config{ClientID: o.cfg.ClientID})
	return nil
}

func (o *OIDC) clients() (*oauth2.Config, *oidc.IDTokenVerifier) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.oauth, o.verifier
}

// SSO handles GET /auth/sso?returnTo=: it seals the login state into the
// oauth cookie and redirects to the provider.
func (o *OIDC) SSO(w http.ResponseWriter, r *http.Request) {
	oc, _ := o.clients()
	if oc == nil {
		plain(w, http.StatusServiceUnavailable, "Login is not available yet: the identity provider has not been reached. Retry shortly.")
		return
	}
	state, nonce := randomToken(), randomToken()
	verifier := oauth2.GenerateVerifier()
	name := oauthCookieName(state)
	sealed, err := o.keys.sealOAuth(name, oauthPayload{
		State: state, Nonce: nonce, Verifier: verifier,
		ReturnTo: SanitizeReturnTo(r.URL.Query().Get("returnTo")),
		Exp:      o.now().Add(oauthTTL).Unix(),
	})
	if err != nil {
		o.log.Error("seal login cookie", "error", err.Error())
		plain(w, http.StatusInternalServerError, "Login failed.")
		return
	}
	// Logins in several tabs each keep their own cookie; past the cap, the
	// older ones are cleared.
	var pending []string
	for _, c := range r.Cookies() {
		if strings.HasPrefix(c.Name, OAuthCookie+"_") {
			pending = append(pending, c.Name)
		}
	}
	if len(pending) >= maxLoginCookies {
		for _, n := range pending {
			http.SetCookie(w, cookie(n, "", 0))
		}
	}
	http.SetCookie(w, cookie(name, sealed, oauthTTL))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, oc.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}

// idClaims are the id_token claims used for identity and role mapping.
type idClaims struct {
	Email         string   `json:"email"`
	EmailVerified flexBool `json:"email_verified"`
	Name          string   `json:"name"`
	Groups        []string `json:"groups"`
}

// flexBool accepts a JSON boolean or the strings "true"/"false", which some
// identity providers send for email_verified.
type flexBool bool

func (b *flexBool) UnmarshalJSON(data []byte) error {
	var v bool
	if err := json.Unmarshal(data, &v); err == nil {
		*b = flexBool(v)
		return nil
	}
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	*b = flexBool(strings.EqualFold(s, "true"))
	return nil
}

// Callback handles the redirect back from the provider.
func (o *OIDC) Callback(w http.ResponseWriter, r *http.Request) {
	oc, verifier := o.clients()
	if oc == nil {
		plain(w, http.StatusServiceUnavailable, "Login is not available yet. Retry shortly.")
		return
	}
	q := r.URL.Query()
	state := q.Get("state")
	if !validState.MatchString(state) {
		plain(w, http.StatusBadRequest, "Login state mismatch. Start the login again.")
		return
	}
	name := oauthCookieName(state)
	c, err := r.Cookie(name)
	if err != nil {
		plain(w, http.StatusBadRequest, "Login session missing or expired. Start the login again.")
		return
	}
	login, err := o.keys.openOAuth(name, c.Value, o.now())
	if err != nil {
		plain(w, http.StatusBadRequest, "Login session missing or expired. Start the login again.")
		return
	}
	if subtle.ConstantTimeCompare([]byte(state), []byte(login.State)) != 1 {
		plain(w, http.StatusBadRequest, "Login state mismatch. Start the login again.")
		return
	}
	if e := q.Get("error"); e != "" {
		o.log.Warn("identity provider returned an error", "error", e)
		plain(w, http.StatusUnauthorized, "The identity provider rejected the login.")
		return
	}
	code := q.Get("code")
	if code == "" {
		plain(w, http.StatusBadRequest, "Missing authorization code.")
		return
	}

	ctx, cancel := context.WithTimeout(oidc.ClientContext(r.Context(), o.http), idpTimeout)
	defer cancel()
	tok, err := oc.Exchange(context.WithValue(ctx, oauth2.HTTPClient, o.http), code, oauth2.VerifierOption(login.Verifier))
	if err != nil {
		o.log.Warn("token exchange failed", "error", err.Error())
		plain(w, http.StatusUnauthorized, "Login failed: token exchange was rejected.")
		return
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		plain(w, http.StatusUnauthorized, "Login failed: no id_token returned.")
		return
	}
	idt, err := verifier.Verify(ctx, rawID)
	if err != nil {
		o.log.Warn("id_token verification failed", "error", err.Error())
		plain(w, http.StatusUnauthorized, "Login failed: invalid id_token.")
		return
	}
	if subtle.ConstantTimeCompare([]byte(idt.Nonce), []byte(login.Nonce)) != 1 {
		plain(w, http.StatusUnauthorized, "Login failed: nonce mismatch.")
		return
	}
	var claims idClaims
	if err := idt.Claims(&claims); err != nil {
		plain(w, http.StatusUnauthorized, "Login failed: unreadable claims.")
		return
	}
	o.log.Debug("login claims", "sub", idt.Subject, "email", claims.Email, "emailVerified", bool(claims.EmailVerified), "groups", claims.Groups)

	// An unverified email is not trusted for attribution: identity and audit
	// then use the subject.
	email := ""
	if claims.EmailVerified {
		email = claims.Email
	}
	user := email
	if user == "" {
		user = idt.Subject
	}
	role, matched, ok := MapGroups(claims.Groups, o.cfg)
	if !ok {
		o.audit.Log(audit.Event{Event: audit.EventLoginDenied, User: user})
		http.SetCookie(w, cookie(name, "", 0))
		plain(w, http.StatusForbidden, "Access denied: your account is not in a group allowed to use Tempolens.")
		return
	}
	p := &Principal{Sub: idt.Subject, Email: email, Name: claims.Name, Role: role, AdminGroup: matched.Admin, WriteGroup: matched.Write, ReadGroup: matched.Read}
	sealed, err := o.keys.SealSession(p, o.now(), o.cfg.SessionTTL)
	if err != nil {
		o.log.Error("seal session", "error", err.Error())
		plain(w, http.StatusInternalServerError, "Login failed.")
		return
	}
	o.audit.Log(audit.Event{Event: audit.EventLogin, User: user, Role: string(role)})
	http.SetCookie(w, cookie(name, "", 0))
	http.SetCookie(w, cookie(SessionCookie, sealed, o.cfg.SessionTTL))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, SanitizeReturnTo(login.ReturnTo), http.StatusFound)
}

// SSODisabled handles GET /auth/sso when auth is disabled: there is nothing
// to log into, so it goes straight to returnTo.
func SSODisabled(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, SanitizeReturnTo(r.URL.Query().Get("returnTo")), http.StatusFound)
}

// Logout returns the POST /auth/logout handler. CSRF is checked by the
// middleware. The session cookie is cleared; Dex has no end-session endpoint.
func Logout(auditLog *audit.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if p := FromContext(r.Context()); p != nil && !p.Local {
			auditLog.Log(audit.Event{Event: audit.EventLogout, User: p.User(), Role: string(p.Role)})
		}
		http.SetCookie(w, cookie(SessionCookie, "", 0))
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	}
}

// validState matches the base64url states this server issues.
var validState = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)

func randomToken() string {
	b := make([]byte, 32)
	// crypto/rand.Read never returns an error on supported platforms.
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func plain(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(msg + "\n"))
}
