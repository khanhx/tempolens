package authz

import (
	"context"
	"net/http"
	"net/url"

	"google.golang.org/grpc/codes"

	"tempolens/internal/apierr"
)

// Headers that state the user's intent for destructive actions. Values are
// percent-encoded (encodeURIComponent) so any workflow ID fits in a header.
const (
	ConfirmHeader = "X-Tempolens-Confirm"
	ReasonHeader  = "X-Tempolens-Reason"
)

// Intent is the decoded confirmation and reason of a request. The gateway
// forwards no headers to gRPC, so the interceptor reads them from here.
type Intent struct {
	Confirm    string
	HasConfirm bool
	Reason     string
}

type intentKey struct{}

// WithIntent returns ctx carrying in.
func WithIntent(ctx context.Context, in Intent) context.Context {
	return context.WithValue(ctx, intentKey{}, in)
}

// IntentFrom returns the intent in ctx, or the zero Intent.
func IntentFrom(ctx context.Context) Intent {
	in, _ := ctx.Value(intentKey{}).(Intent)
	return in
}

// IntentMiddleware decodes the intent headers into the request context. An
// undecodable value is a client error.
func IntentMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in Intent
		if raw, ok := r.Header[ConfirmHeader]; ok && len(raw) > 0 {
			v, err := url.PathUnescape(raw[0])
			if err != nil {
				apierr.Write(w, http.StatusBadRequest, codes.InvalidArgument, ConfirmHeader+" is not valid percent-encoding")
				return
			}
			in.Confirm, in.HasConfirm = v, true
		}
		if raw := r.Header.Get(ReasonHeader); raw != "" {
			v, err := url.PathUnescape(raw)
			if err != nil {
				apierr.Write(w, http.StatusBadRequest, codes.InvalidArgument, ReasonHeader+" is not valid percent-encoding")
				return
			}
			in.Reason = v
		}
		if in.HasConfirm || in.Reason != "" {
			r = r.WithContext(WithIntent(r.Context(), in))
		}
		next.ServeHTTP(w, r)
	})
}
