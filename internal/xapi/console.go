package xapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	"tempolens/internal/apierr"
	"tempolens/internal/audit"
	"tempolens/internal/auth"
	"tempolens/internal/authz"
)

// The command console invokes any allowlisted RPC by name (contract
// section 3.9). The call goes through the intercepted connection, so roles,
// env flags, validators, confirmation, identity stamping and audit apply
// exactly as on every other route.

const (
	maxConsoleBody = 1 << 20
	// maxAuditMethod caps a client-supplied method name in the audit line.
	maxAuditMethod = 256
	// consoleTimeout bounds every console call, including long-polls.
	consoleTimeout = 30 * time.Second
)

// consoleRequest is the POST /api/x/console/invoke body.
type consoleRequest struct {
	Method  string          `json:"method"`
	Request json.RawMessage `json:"request"`
}

// consoleMethods serves GET /api/x/console/methods.
func (h *Handler) consoleMethods(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, struct {
		Methods []authz.ConsoleMethod `json:"methods"`
	}{authz.ConsoleMethods()})
}

// consoleInvoke serves POST /api/x/console/invoke.
func (h *Handler) consoleInvoke(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	if !method(w, r, http.MethodPost) {
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxConsoleBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			apierr.Write(w, http.StatusRequestEntityTooLarge, codes.InvalidArgument, "request body exceeds 1 MiB")
			return
		}
		writeError(w, badRequest("unreadable request body"))
		return
	}
	var body consoleRequest
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, badRequest("invalid request body: "+err.Error()))
		return
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeError(w, badRequest("invalid request body: trailing data"))
		return
	}
	if !validMethodName(body.Method) {
		writeError(w, badRequest(`method must be a full gRPC method name, for example "/temporal.api.workflowservice.v1.WorkflowService/DescribeNamespace"`))
		return
	}
	md, ok := authz.ConsoleDescriptor(body.Method)
	if !ok {
		h.auditConsoleDeny(r, body.Method, start)
		apierr.Write(w, http.StatusForbidden, codes.PermissionDenied,
			"permission denied: "+body.Method+" is not available in the console")
		return
	}
	req, err := newMessage(md.Input())
	if err != nil {
		apierr.Write(w, http.StatusInternalServerError, codes.Internal, err.Error())
		return
	}
	resp, err := newMessage(md.Output())
	if err != nil {
		apierr.Write(w, http.StatusInternalServerError, codes.Internal, err.Error())
		return
	}
	if raw := bytes.TrimSpace(body.Request); len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
		if err := strictJSON.Unmarshal(raw, req); err != nil {
			writeError(w, badRequest("invalid request for "+string(md.Name())+": "+err.Error()))
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), consoleTimeout)
	defer cancel()
	if err := h.conn.Invoke(ctx, body.Method, req, resp); err != nil {
		writeError(w, err)
		return
	}
	writeProto(w, resp)
}

// auditConsoleDeny writes the interceptor's deny line for a method the
// console refuses before any RPC, so probing for blocked or unknown methods
// is visible to operators.
func (h *Handler) auditConsoleDeny(r *http.Request, fullMethod string, start time.Time) {
	if h.audit == nil {
		return
	}
	name := fullMethod[strings.LastIndexByte(fullMethod, '/')+1:]
	if len(name) > maxAuditMethod {
		name = name[:maxAuditMethod]
	}
	ev := audit.Event{Event: audit.EventDeny, Method: name, Code: codes.PermissionDenied.String(),
		Reason: "method not allowed in the console", DurationMs: time.Since(start).Milliseconds()}
	if p := auth.FromContext(r.Context()); p != nil {
		ev.User, ev.Role = p.User(), string(p.Role)
	}
	h.audit.Log(ev)
}

// validMethodName reports whether s has the "/pkg.Service/Method" shape.
func validMethodName(s string) bool {
	svc, name, ok := strings.Cut(strings.TrimPrefix(s, "/"), "/")
	return strings.HasPrefix(s, "/") && ok && strings.Contains(svc, ".") && name != "" && !strings.Contains(name, "/")
}

// newMessage returns an empty message of the generated Go type for d, so
// the interceptor's typed validators see the same type as on other routes.
func newMessage(d protoreflect.MessageDescriptor) (proto.Message, error) {
	mt, err := protoregistry.GlobalTypes.FindMessageByName(d.FullName())
	if err != nil {
		return nil, errors.New("no message type for " + string(d.FullName()))
	}
	return mt.New().Interface(), nil
}
