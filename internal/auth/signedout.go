package auth

import (
	"html/template"
	"net/http"
	"net/url"
)

// signedOutPage has no script, inline style or external asset, so the strict
// CSP applies unchanged. It never redirects: Dex has no end-session endpoint,
// so an automatic trip to /auth/sso would sign the user straight back in.
var signedOutPage = template.Must(template.New("signed-out").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Signed out · Tempolens</title>
</head>
<body>
<main>
{{if .Disabled}}<h1>Authentication is disabled</h1>
<p>This server runs without sign-in, so there is no session to end.</p>
<p><a href="{{.Next}}">Back to Tempolens</a></p>
{{else}}<h1>You have been signed out</h1>
<p>Your Tempolens session has ended.</p>
<p><a href="{{.Next}}">Sign in again</a></p>
<p><small>Your identity provider session may still be active, so signing in again may not ask for your password. Sign out of the identity provider too if this is a shared computer.</small></p>
{{end}}</main>
</body>
</html>
`))

// SignedOut serves GET /auth/signed-out, the page the SPA opens after
// logout. It needs no session. The optional returnTo is sanitized like
// /auth/sso and carried into the sign-in link.
func SignedOut(disabled bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		returnTo := SanitizeReturnTo(r.URL.Query().Get("returnTo"))
		next := returnTo
		if !disabled {
			next = "/auth/sso?returnTo=" + url.QueryEscape(returnTo)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_ = signedOutPage.Execute(w, struct {
			Disabled bool
			Next     string
		}{disabled, next})
	}
}
