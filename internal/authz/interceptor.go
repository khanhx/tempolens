package authz

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	"tempolens/internal/audit"
	"tempolens/internal/auth"
	"tempolens/internal/config"
)

// SystemNamespace is Temporal's internal namespace.
const SystemNamespace = "temporal-system"

// DestructiveTimeout bounds a confirmed destructive call, which runs detached
// from the request's cancellation.
const DestructiveTimeout = 30 * time.Second

// Interceptor authorizes every unary call on the shared client connection.
type Interceptor struct {
	policy  *Policy
	cfg     *config.Config
	audit   *audit.Logger
	log     *slog.Logger
	version string
}

// NewInterceptor returns the authorization interceptor.
func NewInterceptor(policy *Policy, auditLog *audit.Logger, log *slog.Logger, version string) *Interceptor {
	return &Interceptor{policy: policy, cfg: policy.cfg, audit: auditLog, log: log, version: version}
}

// Unary is the grpc.UnaryClientInterceptor. The checks run in this order:
// rule lookup, principal, namespace guard, class and role, env flags,
// validators, confirmation and reason headers, identity stamp, metadata
// replacement, the live-namespace check before DeleteNamespace, invoke,
// audit.
func (i *Interceptor) Unary(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	start := time.Now()
	short := shortMethod(method)

	rule, known := Lookup(method)
	p := auth.FromContext(ctx)
	msg, isProto := req.(proto.Message)

	deny := func(code codes.Code, msg string, reqMsg proto.Message) error {
		ev := i.event(audit.EventDeny, p, short, reqMsg)
		ev.Code = code.String()
		ev.DurationMs = time.Since(start).Milliseconds()
		i.audit.Log(ev)
		return status.Error(code, msg)
	}

	if !known || !isProto {
		return deny(codes.PermissionDenied, "permission denied: "+short+" is not allowed", nil)
	}
	if p == nil {
		return deny(codes.Unauthenticated, "no valid session", msg)
	}
	// Some request variants raise the class (batch delete is ADMIN).
	if rule.DynamicClass != nil && rule.Class == ClassWrite {
		rule.Class = rule.DynamicClass(msg)
	}
	intent := IntentFrom(ctx)
	if rule.NamespaceScoped {
		ns := stringAt(msg, "namespace")
		switch {
		case ns == SystemNamespace && rule.Class.mutating():
			return deny(codes.PermissionDenied, "permission denied: writes on "+SystemNamespace+" are not allowed", msg)
		case ns == SystemNamespace && !i.cfg.ShowSystemNamespace:
			return deny(codes.PermissionDenied, "permission denied: "+SystemNamespace+" is hidden", msg)
		case ns == "" && rule.Class.mutating():
			return deny(codes.PermissionDenied, "permission denied: a namespace is required", msg)
		}
	}

	if err := i.checkPrincipal(p, rule, short); err != nil {
		st := status.Convert(err)
		return deny(st.Code(), st.Message(), msg)
	}

	var target string
	if rule.Class.mutating() {
		if a, blocked := i.policy.blockedBy(rule, msg); blocked {
			return deny(codes.PermissionDenied, "permission denied: the "+string(a)+" action is disabled on this server", msg)
		}
		for _, check := range []func(proto.Message) error{rule.Validator, i.policyCheck(rule)} {
			if check == nil {
				continue
			}
			if err := check(msg); err != nil {
				st := status.Convert(err)
				return deny(st.Code(), st.Message(), msg)
			}
		}
		if rule.Confirm != nil {
			t, required := rule.Confirm(msg)
			if required {
				if t == "" {
					return deny(codes.InvalidArgument, "the target of a destructive action is required", msg)
				}
				if !intent.HasConfirm || intent.Confirm != t {
					return deny(codes.InvalidArgument, ConfirmHeader+" must name the target ("+t+")", msg)
				}
				target = t
			}
		}
		if rule.ReasonHeader && strings.TrimSpace(intent.Reason) == "" {
			return deny(codes.InvalidArgument, "a non-empty "+ReasonHeader+" is required", msg)
		}
		if !rule.NoStamp {
			stamp(msg, rule.Stamp, p.Identity())
		}
	}

	// A confirmed destructive call must finish once it starts: a client that
	// disconnects mid-call would otherwise cancel it, leaving Temporal's
	// state unknown and the audit line without the real result.
	if target != "" {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.WithoutCancel(ctx), DestructiveTimeout)
		defer cancel()
	}
	ctx = withOutgoingMetadata(ctx, i.version)
	if rule.Class.mutating() {
		i.log.Debug("write attempt", "audit", "attempt", "user", p.User(), "method", short)
	}
	var err error
	if del, ok := msg.(*operatorservice.DeleteNamespaceRequest); ok {
		err = requireLiveNamespace(ctx, del.GetNamespace(), cc, invoker, opts...)
	}
	if err == nil {
		err = invoker(ctx, method, req, reply, cc, opts...)
	}
	if err == nil && method == listNamespaces && !i.cfg.ShowSystemNamespace {
		hideSystemNamespace(reply)
	}
	if rule.Class.mutating() {
		ev := i.event(audit.EventWrite, p, short, msg)
		ev.Code = status.Code(err).String()
		ev.DurationMs = time.Since(start).Milliseconds()
		ev.Target = target
		if rule.ReasonHeader {
			ev.Reason = intent.Reason
		}
		i.audit.Log(ev)
	}
	return err
}

// policyCheck binds a rule's configuration-dependent validator.
func (i *Interceptor) policyCheck(rule Rule) func(proto.Message) error {
	if rule.PolicyCheck == nil {
		return nil
	}
	return func(m proto.Message) error { return rule.PolicyCheck(i.policy, m) }
}

const (
	listNamespaces    = wfPrefix + "ListNamespaces"
	describeNamespace = wfPrefix + "DescribeNamespace"
)

// requireLiveNamespace answers NotFound for a namespace that is gone or
// already marked deleted, before DeleteNamespace runs. Temporal 1.24 accepts
// a delete of a name it deleted seconds earlier, while its frontend cache
// still holds the name, then blocks for minutes as the system delete workflow
// retries the lookup. DescribeNamespace reads persistence and answers at once.
// Any other describe error is returned, so the delete is not attempted.
func requireLiveNamespace(ctx context.Context, ns string, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	resp := &workflowservice.DescribeNamespaceResponse{}
	if err := invoker(ctx, describeNamespace, &workflowservice.DescribeNamespaceRequest{Namespace: ns}, resp, cc, opts...); err != nil {
		return err
	}
	if resp.GetNamespaceInfo().GetState() == enumspb.NAMESPACE_STATE_DELETED {
		return status.Error(codes.NotFound, "namespace "+ns+" is already deleted")
	}
	return nil
}

// hideSystemNamespace drops temporal-system from a ListNamespaces reply,
// matching the READ guard that hides it everywhere else.
func hideSystemNamespace(reply any) {
	resp, ok := reply.(*workflowservice.ListNamespacesResponse)
	if !ok {
		return
	}
	kept := resp.Namespaces[:0]
	for _, ns := range resp.GetNamespaces() {
		if ns.GetNamespaceInfo().GetName() != SystemNamespace {
			kept = append(kept, ns)
		}
	}
	resp.Namespaces = kept
}

// checkPrincipal applies the class and role rules.
func (i *Interceptor) checkPrincipal(p *auth.Principal, rule Rule, short string) error {
	if p.Internal {
		if rule.Class == ClassInternal || rule.Class == ClassRead {
			return nil
		}
		return status.Error(codes.PermissionDenied, "permission denied: "+short+" is not allowed for the internal principal")
	}
	a := i.cfg.Auth
	adminOK := p.Role == config.RoleAdmin && (p.Local || slices.Contains(a.AdminGroups, p.AdminGroup))
	writeOK := adminOK || (p.Role == config.RoleWrite && (p.Local || slices.Contains(a.WriteGroups, p.WriteGroup)))
	if !p.Local && len(a.ReadGroups) > 0 && !slices.Contains(a.AdminGroups, p.AdminGroup) &&
		!slices.Contains(a.WriteGroups, p.WriteGroup) && !slices.Contains(a.ReadGroups, p.ReadGroup) {
		return status.Error(codes.Unauthenticated, "your groups no longer grant access; log in again")
	}
	switch rule.Class {
	case ClassRead:
		return nil
	case ClassWrite, ClassAdmin:
		if i.cfg.DisableWriteActions {
			return status.Error(codes.PermissionDenied, "permission denied: write actions are disabled on this server")
		}
		if rule.Class == ClassAdmin && !adminOK {
			return status.Error(codes.PermissionDenied, "permission denied: "+short+" requires the admin role")
		}
		if !writeOK {
			return status.Error(codes.PermissionDenied, "permission denied: "+short+" requires the write role")
		}
		return nil
	default:
		return status.Error(codes.PermissionDenied, "permission denied: "+short+" is not allowed")
	}
}

// event builds an audit event from declared request field paths. It reads
// only identifiers and the reason, never payloads.
func (i *Interceptor) event(kind string, p *auth.Principal, method string, msg proto.Message) audit.Event {
	ev := audit.Event{Event: kind, Method: method}
	if p != nil {
		ev.User, ev.Role = p.User(), string(p.Role)
	}
	if msg == nil {
		return ev
	}
	ev.Namespace = stringAt(msg, "namespace")
	ev.WorkflowID = firstString(msg, "workflow_execution.workflow_id", "execution.workflow_id", "workflow_id")
	ev.RunID = firstString(msg, "workflow_execution.run_id", "execution.run_id", "run_id")
	ev.ScheduleID = stringAt(msg, "schedule_id")
	ev.JobID = stringAt(msg, "job_id")
	ev.Reason = stringAt(msg, "reason")
	if op := msg.ProtoReflect().Descriptor().Oneofs().ByName("operation"); op != nil {
		if fd := msg.ProtoReflect().WhichOneof(op); fd != nil {
			ev.BatchOp = string(fd.Name())
		}
	}
	return ev
}

func firstString(m proto.Message, paths ...string) string {
	for _, p := range paths {
		if v := stringAt(m, p); v != "" {
			return v
		}
	}
	return ""
}

func shortMethod(full string) string {
	if i := strings.LastIndexByte(full, '/'); i >= 0 {
		return full[i+1:]
	}
	return full
}

// StreamDeny is the stream interceptor: no streaming RPC is allowed.
func StreamDeny(_ context.Context, _ *grpc.StreamDesc, _ *grpc.ClientConn, method string, _ grpc.Streamer, _ ...grpc.CallOption) (grpc.ClientStream, error) {
	return nil, status.Error(codes.PermissionDenied, "permission denied: streaming call "+shortMethod(method)+" is not allowed")
}
