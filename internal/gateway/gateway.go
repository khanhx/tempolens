// Package gateway serves the upstream-compatible /api/v1 surface with the
// grpc-gateway handlers generated in go.temporal.io/api.
package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/proto"

	"tempolens/internal/apierr"
)

// New builds the gateway mux once. It must be mounted only under /api/v1/:
// the generated handlers also register prefix-less patterns.
func New(ctx context.Context, conn grpc.ClientConnInterface) (*runtime.ServeMux, error) {
	mux := runtime.NewServeMux(
		runtime.WithMarshalerOption(runtime.MIMEWildcard, marshaler{
			contentType: "application/json",
			mOpts:       temporalproto.CustomJSONMarshalOptions{Indent: "  "},
			// DiscardUnknown stays false: unknown JSON fields are rejected (400).
			uOpts: temporalproto.CustomJSONUnmarshalOptions{},
		}),
		// Keeps %2F inside workflow IDs.
		runtime.WithUnescapingMode(runtime.UnescapingModeAllExceptReserved),
		runtime.WithErrorHandler(errorHandler),
		runtime.WithRoutingErrorHandler(routingErrorHandler),
		// No HTTP header becomes gRPC metadata; the authz interceptor also
		// replaces outgoing metadata, which drops the Authorization header
		// the gateway forwards unconditionally.
		runtime.WithIncomingHeaderMatcher(func(string) (string, bool) { return "", false }),
		runtime.WithOutgoingHeaderMatcher(func(string) (string, bool) { return "", false }),
		runtime.WithOutgoingTrailerMatcher(func(string) (string, bool) { return "", false }),
		runtime.WithDisablePathLengthFallback(),
	)
	if err := workflowservice.RegisterWorkflowServiceHandlerClient(ctx, mux, workflowservice.NewWorkflowServiceClient(conn)); err != nil {
		return nil, err
	}
	if err := operatorservice.RegisterOperatorServiceHandlerClient(ctx, mux, operatorservice.NewOperatorServiceClient(conn)); err != nil {
		return nil, err
	}
	return mux, nil
}

// errorHandler writes a google.rpc.Status with details and the HTTP status
// mapped from the gRPC code, as upstream does.
func errorHandler(_ context.Context, _ *runtime.ServeMux, _ runtime.Marshaler, w http.ResponseWriter, _ *http.Request, err error) {
	apierr.WriteStatus(w, serviceerror.ToStatus(err))
}

// routingErrorHandler keeps routing failures distinct from RPC failures: the
// default handler would turn a wrong method into 501, which the contract
// reserves for RPCs the Temporal server does not implement.
func routingErrorHandler(ctx context.Context, mux *runtime.ServeMux, m runtime.Marshaler, w http.ResponseWriter, r *http.Request, httpStatus int) {
	switch httpStatus {
	case http.StatusMethodNotAllowed:
		apierr.Write(w, http.StatusMethodNotAllowed, codes.Unimplemented, "method not allowed")
	case http.StatusNotFound:
		apierr.Write(w, http.StatusNotFound, codes.NotFound, "no such API route")
	default:
		runtime.DefaultRoutingErrorHandler(ctx, mux, m, w, r, httpStatus)
	}
}

// marshaler is upstream's temporalproto JSON marshaler: lowerCamel fields,
// enum names, int64 as strings, payloads as base64.
type marshaler struct {
	contentType string
	mOpts       temporalproto.CustomJSONMarshalOptions
	uOpts       temporalproto.CustomJSONUnmarshalOptions
}

func (m marshaler) Marshal(v any) ([]byte, error) {
	if pm, ok := v.(proto.Message); ok {
		return m.mOpts.Marshal(pm)
	}
	return json.MarshalIndent(v, "", m.mOpts.Indent)
}

func (m marshaler) Unmarshal(data []byte, v any) error {
	if pm, ok := v.(proto.Message); ok {
		return m.uOpts.Unmarshal(data, pm)
	}
	return json.Unmarshal(data, v)
}

func (m marshaler) NewDecoder(r io.Reader) runtime.Decoder {
	return decoder{uOpts: m.uOpts, json: json.NewDecoder(r)}
}

func (m marshaler) NewEncoder(w io.Writer) runtime.Encoder {
	return encoder{mOpts: m.mOpts, w: w}
}

func (m marshaler) ContentType(any) string { return m.contentType }

type decoder struct {
	uOpts temporalproto.CustomJSONUnmarshalOptions
	json  *json.Decoder
}

func (d decoder) Decode(v any) error {
	pm, ok := v.(proto.Message)
	if !ok {
		return d.json.Decode(v)
	}
	var raw json.RawMessage
	if err := d.json.Decode(&raw); err != nil {
		return err
	}
	return d.uOpts.Unmarshal(raw, pm)
}

type encoder struct {
	mOpts temporalproto.CustomJSONMarshalOptions
	w     io.Writer
}

func (e encoder) Encode(v any) error {
	var b []byte
	var err error
	if pm, ok := v.(proto.Message); ok {
		b, err = e.mOpts.Marshal(pm)
	} else {
		b, err = json.Marshal(v)
	}
	if err != nil {
		return err
	}
	if _, err := e.w.Write(b); err != nil {
		return err
	}
	_, err = e.w.Write([]byte{'\n'})
	return err
}
