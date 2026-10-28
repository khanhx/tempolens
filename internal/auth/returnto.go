package auth

import (
	"net/url"
	"strings"
)

// SanitizeReturnTo returns raw rebuilt as a same-origin path plus query, or
// "/" when raw could lead anywhere else. Rejected: any scheme, host or user
// info; a path not starting with exactly one "/"; and control bytes (below
// 0x20, 0x7f) or a backslash, either raw or after one unescape.
func SanitizeReturnTo(raw string) string {
	if raw == "" || unsafeChars(raw) {
		return "/"
	}
	if un, err := url.PathUnescape(raw); err != nil || unsafeChars(un) || strings.HasPrefix(un, "//") {
		return "/"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil || u.Opaque != "" {
		return "/"
	}
	p := u.EscapedPath()
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") {
		return "/"
	}
	if u.RawQuery != "" {
		return p + "?" + u.RawQuery
	}
	return p
}

func unsafeChars(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 || c == 0x7f || c == '\\' {
			return true
		}
	}
	return false
}
