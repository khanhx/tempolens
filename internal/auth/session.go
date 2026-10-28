package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"tempolens/internal/config"
)

const (
	// SessionCookie holds the sealed session.
	SessionCookie = "__Host-tempolens_session"
	// OAuthCookie prefixes the login cookies. Each login attempt has its own
	// cookie, OAuthCookie + "_" + the first 8 characters of its state, which
	// holds the sealed state, nonce, PKCE verifier and returnTo.
	OAuthCookie = "__Host-tempolens_oauth"
	// maxLoginCookies bounds the login cookies a browser keeps at once.
	maxLoginCookies = 5
	statePrefixLen  = 8

	sessionVersion = 1
	oauthTTL       = 10 * time.Minute
)

// Subkey purposes. Each master key derives one subkey per purpose with HKDF,
// so a value sealed for one purpose never opens under another.
const (
	purposeOAuth     = "oauth"
	purposeSession   = "session"
	purposePageToken = "pagetoken"
)

var errSealed = errors.New("invalid sealed value")

type subkeys struct {
	oauth     cipher.AEAD
	session   cipher.AEAD
	pageToken []byte
}

// Keyring seals with the first key and opens with any key, so keys can be
// rotated by prepending a new one.
type Keyring struct {
	keys []subkeys
}

// NewKeyring derives subkeys from 32-byte master keys.
func NewKeyring(master [][]byte) (*Keyring, error) {
	if len(master) == 0 {
		return nil, errors.New("keyring: no keys")
	}
	k := &Keyring{}
	for i, m := range master {
		if len(m) != 32 {
			return nil, fmt.Errorf("keyring: key %d is %d bytes, want 32", i+1, len(m))
		}
		var sk subkeys
		var err error
		if sk.oauth, err = deriveAEAD(m, purposeOAuth); err != nil {
			return nil, err
		}
		if sk.session, err = deriveAEAD(m, purposeSession); err != nil {
			return nil, err
		}
		if sk.pageToken, err = hkdf.Key(sha256.New, m, nil, purposePageToken, 32); err != nil {
			return nil, err
		}
		k.keys = append(k.keys, sk)
	}
	return k, nil
}

// RandomKeyring returns a keyring with a fresh random key. It is used when
// auth is disabled: page tokens then do not survive a restart.
func RandomKeyring() (*Keyring, error) {
	m := make([]byte, 32)
	if _, err := rand.Read(m); err != nil {
		return nil, err
	}
	return NewKeyring([][]byte{m})
}

// PageTokenKeys returns the page-token HMAC keys; the first signs, all verify.
func (k *Keyring) PageTokenKeys() [][]byte {
	out := make([][]byte, len(k.keys))
	for i, sk := range k.keys {
		out[i] = sk.pageToken
	}
	return out
}

func deriveAEAD(master []byte, purpose string) (cipher.AEAD, error) {
	key, err := hkdf.Key(sha256.New, master, nil, purpose, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (sk subkeys) aead(purpose string) cipher.AEAD {
	if purpose == purposeOAuth {
		return sk.oauth
	}
	return sk.session
}

// seal encrypts v as JSON with the active key. The cookie name is the AAD.
func (k *Keyring) seal(purpose, name string, v any) (string, error) {
	plain, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	aead := k.keys[0].aead(purpose)
	nonce := make([]byte, aead.NonceSize(), aead.NonceSize()+len(plain)+aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(aead.Seal(nonce, nonce, plain, []byte(name))), nil
}

// open decrypts a value sealed by seal with any key in the ring.
func (k *Keyring) open(purpose, name, value string, v any) error {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return errSealed
	}
	for _, sk := range k.keys {
		aead := sk.aead(purpose)
		if len(raw) < aead.NonceSize()+aead.Overhead() {
			return errSealed
		}
		plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte(name))
		if err != nil {
			continue
		}
		if err := json.Unmarshal(plain, v); err != nil {
			return errSealed
		}
		return nil
	}
	return errSealed
}

// sessionPayload is the sealed content of the session cookie.
type sessionPayload struct {
	V     int    `json:"v"`
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
	AG    string `json:"ag,omitempty"`
	WG    string `json:"wg,omitempty"`
	RG    string `json:"rg,omitempty"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
}

// SealSession seals p into a session cookie value valid until now+ttl.
func (k *Keyring) SealSession(p *Principal, now time.Time, ttl time.Duration) (string, error) {
	return k.seal(purposeSession, SessionCookie, sessionPayload{
		V: sessionVersion, Sub: p.Sub, Email: p.Email, Name: p.Name, Role: string(p.Role),
		AG: p.AdminGroup, WG: p.WriteGroup, RG: p.ReadGroup, Iat: now.Unix(), Exp: now.Add(ttl).Unix(),
	})
}

// OpenSession opens a session cookie value and rejects expired or malformed sessions.
func (k *Keyring) OpenSession(value string, now time.Time) (*Principal, error) {
	var s sessionPayload
	if err := k.open(purposeSession, SessionCookie, value, &s); err != nil {
		return nil, err
	}
	if s.V != sessionVersion {
		return nil, errors.New("session: unsupported version")
	}
	if now.Unix() >= s.Exp || s.Iat > now.Add(time.Minute).Unix() {
		return nil, errors.New("session: expired")
	}
	role := config.Role(s.Role)
	if role != config.RoleRead && role != config.RoleWrite && role != config.RoleAdmin {
		return nil, errors.New("session: invalid role")
	}
	return &Principal{Sub: s.Sub, Email: s.Email, Name: s.Name, Role: role, AdminGroup: s.AG, WriteGroup: s.WG, ReadGroup: s.RG}, nil
}

// oauthPayload is the sealed content of the login cookie.
type oauthPayload struct {
	State    string `json:"state"`
	Nonce    string `json:"nonce"`
	Verifier string `json:"verifier"`
	ReturnTo string `json:"returnTo"`
	Exp      int64  `json:"exp"`
}

// oauthCookieName names the login cookie of the login with this state.
// The state is base64url, so the name is a valid cookie token.
func oauthCookieName(state string) string {
	return OAuthCookie + "_" + state[:statePrefixLen]
}

// sealOAuth seals a login cookie; its full name is the AAD, so a cookie
// cannot be replayed under another login's name.
func (k *Keyring) sealOAuth(name string, o oauthPayload) (string, error) {
	return k.seal(purposeOAuth, name, o)
}

func (k *Keyring) openOAuth(name, value string, now time.Time) (oauthPayload, error) {
	var o oauthPayload
	if err := k.open(purposeOAuth, name, value, &o); err != nil {
		return o, err
	}
	if now.Unix() >= o.Exp {
		return o, errors.New("login expired")
	}
	return o, nil
}

// cookie builds a __Host- cookie: Secure, Path=/, no Domain, HttpOnly, Lax.
func cookie(name, value string, maxAge time.Duration) *http.Cookie {
	c := &http.Cookie{
		Name: name, Value: value, Path: "/",
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
		MaxAge: int(maxAge / time.Second),
	}
	if maxAge <= 0 {
		c.MaxAge = -1
	}
	return c
}
