package authz_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	batchpb "go.temporal.io/api/batch/v1"
	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	namespacepb "go.temporal.io/api/namespace/v1"
	"go.temporal.io/api/operatorservice/v1"
	schedulepb "go.temporal.io/api/schedule/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/known/durationpb"

	"tempolens/internal/audit"
	"tempolens/internal/auth"
	"tempolens/internal/authz"
	"tempolens/internal/config"
	"tempolens/internal/testutil"
)

const wf = "/temporal.api.workflowservice.v1.WorkflowService/"

type harness struct {
	fake *testutil.FakeTemporal
	conn *grpc.ClientConn
	logs *testutil.SyncBuffer
}

func newHarness(t *testing.T, mutate func(*config.Config)) *harness {
	t.Helper()
	cfg := testutil.AuthConfig(t)
	if mutate != nil {
		mutate(cfg)
	}
	logs := &testutil.SyncBuffer{}
	log := slog.New(slog.NewJSONHandler(logs, nil))
	fake := testutil.StartFakeTemporal(t)
	icpt := authz.NewInterceptor(authz.NewPolicy(cfg), audit.New(log), log, "test")
	return &harness{fake: fake, conn: fake.Dial(t, icpt.Unary, authz.StreamDeny), logs: logs}
}

func writer() context.Context {
	return auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Writer))
}

func admin() context.Context {
	return auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Admin))
}

// confirmed adds the intent headers a UI sends for req: the confirmation
// target the method's rule expects, and a reason.
func confirmed(ctx context.Context, method string, req proto.Message) context.Context {
	in := authz.Intent{Reason: "because"}
	if r, _ := authz.Lookup(method); r.Confirm != nil {
		in.Confirm, in.HasConfirm = r.Confirm(req)
	}
	return authz.WithIntent(ctx, in)
}

// newRequest builds the concrete request message of a method with namespace
// "ns" and the fields its validator needs.
func newRequest(t *testing.T, method string) (req, reply proto.Message) {
	t.Helper()
	svc, name, _ := strings.Cut(strings.TrimPrefix(method, "/"), "/")
	d, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(svc))
	if err != nil {
		t.Fatalf("find %s: %v", svc, err)
	}
	md := d.(protoreflect.ServiceDescriptor).Methods().ByName(protoreflect.Name(name))
	in, _ := protoregistry.GlobalTypes.FindMessageByName(md.Input().FullName())
	out, _ := protoregistry.GlobalTypes.FindMessageByName(md.Output().FullName())
	req, reply = in.New().Interface(), out.New().Interface()
	m := req.ProtoReflect()
	if fd := m.Descriptor().Fields().ByName("namespace"); fd != nil {
		m.Set(fd, protoreflect.ValueOfString("ns"))
	}
	if fd := m.Descriptor().Fields().ByName("reason"); fd != nil {
		m.Set(fd, protoreflect.ValueOfString("because"))
	}
	if fd := m.Descriptor().Fields().ByName("workflow_execution"); fd != nil {
		m.Set(fd, protoreflect.ValueOfMessage((&commonpb.WorkflowExecution{WorkflowId: "wf"}).ProtoReflect()))
	}
	switch r := req.(type) {
	case *workflowservice.StartBatchOperationRequest:
		r.JobId = "j"
		r.VisibilityQuery = `WorkflowType="X"`
		r.Operation = &workflowservice.StartBatchOperationRequest_TerminationOperation{TerminationOperation: &batchpb.BatchOperationTermination{}}
	case *workflowservice.RegisterNamespaceRequest:
		r.WorkflowExecutionRetentionPeriod = durationpb.New(24 * time.Hour)
	case *operatorservice.AddSearchAttributesRequest:
		r.SearchAttributes = map[string]enumspb.IndexedValueType{"CustomKeyword": enumspb.INDEXED_VALUE_TYPE_KEYWORD}
	case *operatorservice.RemoveSearchAttributesRequest:
		r.SearchAttributes = []string{"CustomKeyword"}
	}
	return req, reply
}

func invoke(t *testing.T, h *harness, ctx context.Context, method string, req, reply proto.Message) codes.Code {
	t.Helper()
	return status.Code(h.conn.Invoke(ctx, method, req, reply))
}

// methodsOf returns every method of class c and its declared stamp paths.
func methodsOf(c authz.Class) map[string][]string {
	out := map[string][]string{}
	for _, svc := range []string{"temporal.api.workflowservice.v1.WorkflowService", "temporal.api.operatorservice.v1.OperatorService"} {
		d, _ := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(svc))
		ms := d.(protoreflect.ServiceDescriptor).Methods()
		for i := 0; i < ms.Len(); i++ {
			full := "/" + svc + "/" + string(ms.Get(i).Name())
			if r, _ := authz.Lookup(full); r.Class == c {
				out[full] = r.Stamp
			}
		}
	}
	return out
}

func TestWriteReachesBackendWithIdentityStamped(t *testing.T) {
	h := newHarness(t, nil)
	for method, paths := range methodsOf(authz.ClassWrite) {
		h.fake.Reset()
		req, reply := newRequest(t, method)
		// Unimplemented comes from the fake backend, so the call got through.
		if code := invoke(t, h, confirmed(writer(), method, req), method, req, reply); code != codes.Unimplemented {
			t.Errorf("%s: code %v, want Unimplemented from the backend", method, code)
			continue
		}
		calls := h.fake.Calls()
		if len(calls) != 1 || calls[0].Method != method {
			t.Errorf("%s: backend calls %v", method, calls)
			continue
		}
		stamped := 0
		for _, p := range paths {
			if got := stringAt(calls[0].Req, p); got != "" {
				if got != "tempolens:writer@example.com" {
					t.Errorf("%s: identity at %s = %q", method, p, got)
				}
				stamped++
			}
		}
		if len(paths) > 0 && stamped != 1 {
			t.Errorf("%s: identity stamped at %d of %v, want exactly 1", method, stamped, paths)
		}
	}
}

// TestRoleBoundaries: admin reaches every WRITE and ADMIN method; write and
// read reach no ADMIN method.
func TestRoleBoundaries(t *testing.T) {
	h := newHarness(t, nil)
	reader := auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader))
	adminMethods := methodsOf(authz.ClassAdmin)
	if len(adminMethods) != 5 {
		t.Fatalf("ADMIN methods = %v", adminMethods)
	}
	for _, set := range []map[string][]string{methodsOf(authz.ClassWrite), adminMethods} {
		for method := range set {
			h.fake.Reset()
			req, reply := newRequest(t, method)
			if code := invoke(t, h, confirmed(admin(), method, req), method, req, reply); code != codes.Unimplemented {
				t.Errorf("admin %s: code %v, want Unimplemented from the backend", method, code)
			}
		}
	}
	for method := range adminMethods {
		for name, ctx := range map[string]context.Context{"writer": writer(), "reader": reader} {
			h.fake.Reset()
			req, reply := newRequest(t, method)
			if code := invoke(t, h, confirmed(ctx, method, req), method, req, reply); code != codes.PermissionDenied {
				t.Errorf("%s %s: code %v, want PermissionDenied", name, method, code)
			}
			if calls := h.fake.Calls(); len(calls) != 0 {
				t.Errorf("%s %s: backend reached", name, method)
			}
		}
	}
	// Batch delete is ADMIN; the same request as batch terminate is WRITE.
	batchDelete := func() proto.Message {
		req, _ := newRequest(t, wf+"StartBatchOperation")
		req.(*workflowservice.StartBatchOperationRequest).Operation = &workflowservice.StartBatchOperationRequest_DeletionOperation{
			DeletionOperation: &batchpb.BatchOperationDeletion{}}
		return req
	}
	h.fake.Reset()
	req := batchDelete()
	if code := invoke(t, h, confirmed(writer(), wf+"StartBatchOperation", req), wf+"StartBatchOperation", req, &workflowservice.StartBatchOperationResponse{}); code != codes.PermissionDenied {
		t.Errorf("writer batch delete: code %v, want PermissionDenied", code)
	}
	req = batchDelete()
	if code := invoke(t, h, confirmed(admin(), wf+"StartBatchOperation", req), wf+"StartBatchOperation", req, &workflowservice.StartBatchOperationResponse{}); code != codes.Unimplemented {
		t.Errorf("admin batch delete: code %v, want Unimplemented from the backend", code)
	}
	if got := stringAt(h.fake.Calls()[0].Req, "deletion_operation.identity"); got != "tempolens:admin@example.com" {
		t.Errorf("batch delete identity = %q", got)
	}
}

func stringAt(m proto.Message, path string) string {
	msg := m.ProtoReflect()
	parts := strings.Split(path, ".")
	for i, name := range parts {
		fd := msg.Descriptor().Fields().ByName(protoreflect.Name(name))
		if fd == nil {
			return ""
		}
		if i == len(parts)-1 {
			return msg.Get(fd).String()
		}
		if !msg.Has(fd) {
			return ""
		}
		msg = msg.Get(fd).Message()
	}
	return ""
}

func TestClientIdentityIsOverwritten(t *testing.T) {
	h := newHarness(t, nil)
	req := &workflowservice.SignalWorkflowExecutionRequest{Namespace: "ns", Identity: "forged"}
	invoke(t, h, writer(), wf+"SignalWorkflowExecution", req, &workflowservice.SignalWorkflowExecutionResponse{})
	if got := h.fake.Calls()[0].Req.(*workflowservice.SignalWorkflowExecutionRequest).GetIdentity(); got != "tempolens:writer@example.com" {
		t.Fatalf("identity = %q", got)
	}
}

func TestDenials(t *testing.T) {
	reader := auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader))
	revoked := auth.WithPrincipal(context.Background(), &auth.Principal{Email: "x@example.com", Role: config.RoleWrite, WriteGroup: "gone"})
	type row struct {
		name   string
		mutate func(*config.Config)
		ctx    context.Context
		method string
		req    func(*testing.T) (proto.Message, proto.Message)
		want   codes.Code
	}
	std := func(method string) func(*testing.T) (proto.Message, proto.Message) {
		return func(t *testing.T) (proto.Message, proto.Message) { return newRequest(t, method) }
	}
	withNS := func(method, ns string) func(*testing.T) (proto.Message, proto.Message) {
		return func(t *testing.T) (proto.Message, proto.Message) {
			req, reply := newRequest(t, method)
			m := req.ProtoReflect()
			m.Set(m.Descriptor().Fields().ByName("namespace"), protoreflect.ValueOfString(ns))
			return req, reply
		}
	}
	patch := func(p *schedulepb.SchedulePatch) func(*testing.T) (proto.Message, proto.Message) {
		return func(*testing.T) (proto.Message, proto.Message) {
			return &workflowservice.PatchScheduleRequest{Namespace: "ns", ScheduleId: "s", Patch: p}, &workflowservice.PatchScheduleResponse{}
		}
	}
	terminateDisabled := func(c *config.Config) { c.Disabled.Terminate = true }
	for _, tc := range []row{
		{"no principal", nil, context.Background(), wf + "ListWorkflowExecutions", std(wf + "ListWorkflowExecutions"), codes.Unauthenticated},
		{"unknown method", nil, writer(), "/temporal.api.workflowservice.v1.WorkflowService/Nope", std(wf + "GetSystemInfo"), codes.PermissionDenied},
		{"read user write", nil, reader, wf + "TerminateWorkflowExecution", std(wf + "TerminateWorkflowExecution"), codes.PermissionDenied},
		{"block for writer", nil, writer(), wf + "ExecuteMultiOperation", std(wf + "ExecuteMultiOperation"), codes.PermissionDenied},
		{"block for admin", nil, admin(), wf + "DeprecateNamespace", std(wf + "DeprecateNamespace"), codes.PermissionDenied},
		{"write group removed from env", nil, revoked, wf + "TerminateWorkflowExecution", std(wf + "TerminateWorkflowExecution"), codes.PermissionDenied},
		{"read groups set and none matches", func(c *config.Config) { c.Auth.ReadGroups = []string{"readers"} }, revoked, wf + "ListWorkflowExecutions", std(wf + "ListWorkflowExecutions"), codes.Unauthenticated},
		{"write on temporal-system", nil, writer(), wf + "TerminateWorkflowExecution", withNS(wf+"TerminateWorkflowExecution", "temporal-system"), codes.PermissionDenied},
		{"write with empty namespace", nil, writer(), wf + "TerminateWorkflowExecution", withNS(wf+"TerminateWorkflowExecution", ""), codes.PermissionDenied},
		{"read on temporal-system hidden", nil, reader, wf + "ListWorkflowExecutions", withNS(wf+"ListWorkflowExecutions", "temporal-system"), codes.PermissionDenied},
		{"terminate disabled", terminateDisabled, writer(), wf + "TerminateWorkflowExecution", std(wf + "TerminateWorkflowExecution"), codes.PermissionDenied},
		{"batch terminate with terminate disabled", terminateDisabled, writer(), wf + "StartBatchOperation", std(wf + "StartBatchOperation"), codes.PermissionDenied},
		{"global write disable", func(c *config.Config) { c.DisableWriteActions = true }, writer(), wf + "SignalWorkflowExecution", std(wf + "SignalWorkflowExecution"), codes.PermissionDenied},
		{"schedule trigger with start disabled", func(c *config.Config) { c.Disabled.Start = true }, writer(), wf + "PatchSchedule",
			patch(&schedulepb.SchedulePatch{TriggerImmediately: &schedulepb.TriggerImmediatelyRequest{}}), codes.PermissionDenied},
		{"schedule backfill with start disabled", func(c *config.Config) { c.Disabled.Start = true }, writer(), wf + "PatchSchedule",
			patch(&schedulepb.SchedulePatch{BackfillRequest: []*schedulepb.BackfillRequest{{}}}), codes.PermissionDenied},
		{"create schedule with start disabled", func(c *config.Config) { c.Disabled.Start = true }, writer(), wf + "CreateSchedule", std(wf + "CreateSchedule"), codes.PermissionDenied},
		{"delete schedule with schedule disabled", func(c *config.Config) { c.Disabled.Schedule = true }, writer(), wf + "DeleteSchedule", std(wf + "DeleteSchedule"), codes.PermissionDenied},
		{"patch pause with schedule disabled", func(c *config.Config) { c.Disabled.Schedule = true }, writer(), wf + "PatchSchedule",
			patch(&schedulepb.SchedulePatch{Pause: "p"}), codes.PermissionDenied},
		{"nexus endpoint with nexus disabled", func(c *config.Config) { c.Disabled.Nexus = true }, writer(),
			"/temporal.api.operatorservice.v1.OperatorService/DeleteNexusEndpoint", std("/temporal.api.operatorservice.v1.OperatorService/DeleteNexusEndpoint"), codes.PermissionDenied},
		{"activity command with activity disabled", func(c *config.Config) { c.Disabled.Activity = true }, writer(), wf + "PauseActivity", std(wf + "PauseActivity"), codes.PermissionDenied},
		{"start with completion callbacks", nil, writer(), wf + "StartWorkflowExecution", func(*testing.T) (proto.Message, proto.Message) {
			return &workflowservice.StartWorkflowExecutionRequest{Namespace: "ns", CompletionCallbacks: []*commonpb.Callback{{}}}, &workflowservice.StartWorkflowExecutionResponse{}
		}, codes.PermissionDenied},
		{"empty reason", nil, writer(), wf + "TerminateWorkflowExecution", func(*testing.T) (proto.Message, proto.Message) {
			return &workflowservice.TerminateWorkflowExecutionRequest{Namespace: "ns"}, &workflowservice.TerminateWorkflowExecutionResponse{}
		}, codes.InvalidArgument},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, reply := tc.req(t)
			expectDenied(t, tc.mutate, tc.ctx, tc.method, req, reply, tc.want)
		})
	}
}

// expectDenied invokes method and checks it was refused with want, audited,
// and never reached the backend.
func expectDenied(t *testing.T, mutate func(*config.Config), ctx context.Context, method string, req, reply proto.Message, want codes.Code) {
	t.Helper()
	h := newHarness(t, mutate)
	if got := invoke(t, h, ctx, method, req, reply); got != want {
		t.Fatalf("code %v, want %v", got, want)
	}
	if calls := h.fake.Calls(); len(calls) != 0 {
		t.Fatalf("backend was reached: %v", calls)
	}
	if !strings.Contains(h.logs.String(), `"event":"deny"`) {
		t.Fatalf("denial not audited: %s", h.logs.String())
	}
}

const op = "/temporal.api.operatorservice.v1.OperatorService/"

// TestDestructiveDenials covers the admin guards, the confirmation and
// reason headers, and the flags of the CLI-parity actions.
func TestDestructiveDenials(t *testing.T) {
	revokedAdmin := auth.WithPrincipal(context.Background(), &auth.Principal{Email: "x@example.com", Role: config.RoleAdmin, AdminGroup: "gone"})
	deleteNS := func(ns string) proto.Message { return &operatorservice.DeleteNamespaceRequest{Namespace: ns} }
	for _, tc := range []struct {
		name    string
		mutate  func(*config.Config)
		ctx     context.Context
		method  string
		req     func(t *testing.T) proto.Message
		confirm bool // send the intent the UI would send
		intent  *authz.Intent
		want    codes.Code
	}{
		{name: "writer registers a namespace", ctx: writer(), method: wf + "RegisterNamespace", confirm: true, want: codes.PermissionDenied},
		{name: "admin group removed from env", ctx: revokedAdmin, method: wf + "RegisterNamespace", confirm: true, want: codes.PermissionDenied},
		{name: "global write disable covers admin", mutate: func(c *config.Config) { c.DisableWriteActions = true },
			ctx: admin(), method: wf + "RegisterNamespace", confirm: true, want: codes.PermissionDenied},
		{name: "namespace actions disabled", mutate: func(c *config.Config) { c.Disabled.Namespace = true },
			ctx: admin(), method: wf + "UpdateNamespace", confirm: true, want: codes.PermissionDenied},
		{name: "search attribute actions disabled", mutate: func(c *config.Config) { c.Disabled.SearchAttribute = true },
			ctx: admin(), method: op + "AddSearchAttributes", confirm: true, want: codes.PermissionDenied},
		{name: "register namespace without retention", ctx: admin(), method: wf + "RegisterNamespace", confirm: true,
			req: func(*testing.T) proto.Message {
				return &workflowservice.RegisterNamespaceRequest{Namespace: "tui-test-x"}
			}, want: codes.InvalidArgument},
		{name: "delete default namespace", ctx: admin(), method: op + "DeleteNamespace", confirm: true,
			req: func(*testing.T) proto.Message { return deleteNS("default") }, want: codes.PermissionDenied},
		{name: "delete temporal-system", ctx: admin(), method: op + "DeleteNamespace", confirm: true,
			req: func(*testing.T) proto.Message { return deleteNS("temporal-system") }, want: codes.PermissionDenied},
		{name: "delete env-protected namespace", mutate: func(c *config.Config) { c.ProtectedNamespaces = []string{"payments"} },
			ctx: admin(), method: op + "DeleteNamespace", confirm: true,
			req: func(*testing.T) proto.Message { return deleteNS("payments") }, want: codes.PermissionDenied},
		{name: "delete namespace by id", ctx: admin(), method: op + "DeleteNamespace", confirm: true,
			req: func(*testing.T) proto.Message {
				return &operatorservice.DeleteNamespaceRequest{Namespace: "ns", NamespaceId: "id"}
			}, want: codes.InvalidArgument},
		{name: "delete namespace without confirm", ctx: admin(), method: op + "DeleteNamespace", want: codes.InvalidArgument},
		{name: "delete namespace with mismatched confirm", ctx: admin(), method: op + "DeleteNamespace",
			intent: &authz.Intent{Confirm: "other", HasConfirm: true}, want: codes.InvalidArgument},
		{name: "remove system search attribute", ctx: admin(), method: op + "RemoveSearchAttributes", confirm: true,
			req: func(*testing.T) proto.Message {
				return &operatorservice.RemoveSearchAttributesRequest{Namespace: "ns", SearchAttributes: []string{"WorkflowType"}}
			}, want: codes.PermissionDenied},
		{name: "remove search attributes with names reordered", ctx: admin(), method: op + "RemoveSearchAttributes",
			req: func(*testing.T) proto.Message {
				return &operatorservice.RemoveSearchAttributesRequest{Namespace: "ns", SearchAttributes: []string{"A", "B"}}
			}, intent: &authz.Intent{Confirm: "B,A", HasConfirm: true}, want: codes.InvalidArgument},
		{name: "terminate without confirm", ctx: writer(), method: wf + "TerminateWorkflowExecution", want: codes.InvalidArgument},
		{name: "terminate with mismatched confirm", ctx: writer(), method: wf + "TerminateWorkflowExecution",
			intent: &authz.Intent{Confirm: "wf2", HasConfirm: true}, want: codes.InvalidArgument},
		{name: "terminate without a workflow ID", ctx: writer(), method: wf + "TerminateWorkflowExecution",
			req: func(*testing.T) proto.Message {
				return &workflowservice.TerminateWorkflowExecutionRequest{Namespace: "ns", Reason: "r"}
			}, intent: &authz.Intent{HasConfirm: true}, want: codes.InvalidArgument},
		{name: "batch terminate without confirm", ctx: writer(), method: wf + "StartBatchOperation", want: codes.InvalidArgument},
		{name: "delete workflow without reason", ctx: writer(), method: wf + "DeleteWorkflowExecution",
			intent: &authz.Intent{Confirm: "wf", HasConfirm: true, Reason: " "}, want: codes.InvalidArgument},
		{name: "delete workflow with delete disabled", mutate: func(c *config.Config) { c.Disabled.Delete = true },
			ctx: writer(), method: wf + "DeleteWorkflowExecution", confirm: true, want: codes.PermissionDenied},
		{name: "delete workflow on temporal-system", ctx: writer(), method: wf + "DeleteWorkflowExecution", confirm: true,
			req: func(*testing.T) proto.Message {
				return &workflowservice.DeleteWorkflowExecutionRequest{Namespace: "temporal-system", WorkflowExecution: &commonpb.WorkflowExecution{WorkflowId: "wf"}}
			}, want: codes.PermissionDenied},
		{name: "batch delete with delete disabled", mutate: func(c *config.Config) { c.Disabled.Delete = true },
			ctx: admin(), method: wf + "StartBatchOperation", confirm: true,
			req: func(t *testing.T) proto.Message {
				req, _ := newRequest(t, wf+"StartBatchOperation")
				req.(*workflowservice.StartBatchOperationRequest).Operation = &workflowservice.StartBatchOperationRequest_DeletionOperation{
					DeletionOperation: &batchpb.BatchOperationDeletion{}}
				return req
			}, want: codes.PermissionDenied},
		{name: "signal-with-start with signal disabled", mutate: func(c *config.Config) { c.Disabled.Signal = true },
			ctx: writer(), method: wf + "SignalWithStartWorkflowExecution", confirm: true, want: codes.PermissionDenied},
		{name: "signal-with-start with start disabled", mutate: func(c *config.Config) { c.Disabled.Start = true },
			ctx: writer(), method: wf + "SignalWithStartWorkflowExecution", confirm: true, want: codes.PermissionDenied},
		{name: "activity complete by ID for reader", ctx: auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader)),
			method: wf + "RespondActivityTaskCompletedById", want: codes.PermissionDenied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var req, reply proto.Message
			req, reply = newRequest(t, tc.method)
			if tc.req != nil {
				req = tc.req(t)
			}
			ctx := tc.ctx
			switch {
			case tc.confirm:
				ctx = confirmed(ctx, tc.method, req)
			case tc.intent != nil:
				ctx = authz.WithIntent(ctx, *tc.intent)
			}
			expectDenied(t, tc.mutate, ctx, tc.method, req, reply, tc.want)
		})
	}
}

func TestAllowed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*config.Config)
		ctx    context.Context
		method string
		ns     string
	}{
		{"query workflow is read", nil, auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader)), wf + "QueryWorkflow", "ns"},
		{"temporal-system read when shown", func(c *config.Config) { c.ShowSystemNamespace = true },
			auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader)), wf + "ListWorkflowExecutions", "temporal-system"},
		{"local write role when auth disabled", func(c *config.Config) { c.Auth.Disabled = true },
			auth.WithPrincipal(context.Background(), auth.LocalPrincipal(config.RoleWrite)), wf + "SignalWorkflowExecution", "ns"},
		{"internal principal health", nil, auth.WithPrincipal(context.Background(), auth.InternalPrincipal), "/grpc.health.v1.Health/Check", ""},
		{"health is read for a user", nil, auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader)), "/grpc.health.v1.Health/Check", ""},
		{"task queue partitions are read", nil, auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader)), wf + "ListTaskQueuePartitions", "ns"},
		{"local admin role when auth disabled", func(c *config.Config) { c.Auth.Disabled = true },
			auth.WithPrincipal(context.Background(), auth.LocalPrincipal(config.RoleAdmin)), wf + "UpdateNamespace", "ns"},
		{"internal principal system info", nil, auth.WithPrincipal(context.Background(), auth.InternalPrincipal), wf + "GetSystemInfo", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, tc.mutate)
			req, reply := newRequest(t, tc.method)
			if fd := req.ProtoReflect().Descriptor().Fields().ByName("namespace"); fd != nil {
				req.ProtoReflect().Set(fd, protoreflect.ValueOfString(tc.ns))
			}
			_ = h.conn.Invoke(tc.ctx, tc.method, req, reply)
			if calls := h.fake.Calls(); len(calls) != 1 {
				t.Fatalf("backend calls = %d, want 1", len(calls))
			}
		})
	}
}

func TestInternalPrincipalCannotWrite(t *testing.T) {
	h := newHarness(t, nil)
	ctx := auth.WithPrincipal(context.Background(), auth.InternalPrincipal)
	req, reply := newRequest(t, wf+"TerminateWorkflowExecution")
	if got := invoke(t, h, ctx, wf+"TerminateWorkflowExecution", req, reply); got != codes.PermissionDenied {
		t.Fatalf("code %v", got)
	}
}

func TestOutgoingMetadataReplaced(t *testing.T) {
	h := newHarness(t, nil)
	ctx := metadata.AppendToOutgoingContext(writer(), "authorization", "Bearer x", "authorization-extras", "y", "foo", "bar")
	req, reply := newRequest(t, wf+"ListWorkflowExecutions")
	invoke(t, h, ctx, wf+"ListWorkflowExecutions", req, reply)
	md := h.fake.Calls()[0].MD
	for k := range md {
		switch k {
		case "client-name", "client-version", ":authority", "content-type", "user-agent":
		default:
			t.Errorf("unexpected metadata key %q reached Temporal", k)
		}
	}
	if got := md.Get("client-name"); len(got) != 1 || got[0] != "tempolens" {
		t.Errorf("client-name = %v", got)
	}
}

func TestStreamsDenied(t *testing.T) {
	h := newHarness(t, nil)
	_, err := h.conn.NewStream(writer(), &grpc.StreamDesc{ServerStreams: true}, "/grpc.health.v1.Health/Watch")
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("stream err = %v", err)
	}
}

func TestWriteAuditedAfterInvoke(t *testing.T) {
	h := newHarness(t, nil)
	req := &workflowservice.TerminateWorkflowExecutionRequest{Namespace: "ns", Reason: "cleanup", WorkflowExecution: &commonpb.WorkflowExecution{WorkflowId: "a/b c"}}
	ctx := authz.WithIntent(writer(), authz.Intent{Confirm: "a/b c", HasConfirm: true})
	invoke(t, h, ctx, wf+"TerminateWorkflowExecution", req, &workflowservice.TerminateWorkflowExecutionResponse{})
	logs := h.logs.String()
	for _, want := range []string{`"event":"write"`, `"code":"Unimplemented"`, `"user":"writer@example.com"`, `"reason":"cleanup"`,
		`"method":"TerminateWorkflowExecution"`, `"target":"a/b c"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("audit line lacks %s: %s", want, logs)
		}
	}
}

// TestDestructiveAuditCarriesResult: the audit line of an admin delete is
// written after Temporal answers and carries the target, reason and result.
func TestDestructiveAuditCarriesResult(t *testing.T) {
	h := newHarness(t, nil)
	h.fake.SetResponder(func(_ context.Context, method string, _ any) (any, error, bool) {
		return &operatorservice.DeleteNamespaceResponse{DeletedNamespace: "tui-test-x-deleted-1"}, nil, true
	})
	req := &operatorservice.DeleteNamespaceRequest{Namespace: "tui-test-x"}
	ctx := authz.WithIntent(admin(), authz.Intent{Confirm: "tui-test-x", HasConfirm: true})
	if code := invoke(t, h, ctx, op+"DeleteNamespace", req, &operatorservice.DeleteNamespaceResponse{}); code != codes.OK {
		t.Fatalf("delete namespace: %v", code)
	}
	logs := h.logs.String()
	for _, want := range []string{`"event":"write"`, `"code":"OK"`, `"role":"admin"`, `"method":"DeleteNamespace"`, `"target":"tui-test-x"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("audit line lacks %s: %s", want, logs)
		}
	}

	h = newHarness(t, nil)
	dreq := &workflowservice.DeleteWorkflowExecutionRequest{Namespace: "ns", WorkflowExecution: &commonpb.WorkflowExecution{WorkflowId: "wf"}}
	ctx = authz.WithIntent(writer(), authz.Intent{Confirm: "wf", HasConfirm: true, Reason: "cleanup"})
	invoke(t, h, ctx, wf+"DeleteWorkflowExecution", dreq, &workflowservice.DeleteWorkflowExecutionResponse{})
	for _, want := range []string{`"event":"write"`, `"code":"Unimplemented"`, `"reason":"cleanup"`, `"target":"wf"`} {
		if !strings.Contains(h.logs.String(), want) {
			t.Errorf("workflow delete audit lacks %s: %s", want, h.logs.String())
		}
	}
}

// TestListNamespacesHidesSystem: the namespace record itself is hidden from
// ListNamespaces unless temporal-system is shown.
func TestListNamespacesHidesSystem(t *testing.T) {
	for _, show := range []bool{false, true} {
		h := newHarness(t, func(c *config.Config) { c.ShowSystemNamespace = show })
		h.fake.SetResponder(func(_ context.Context, method string, _ any) (any, error, bool) {
			resp := &workflowservice.ListNamespacesResponse{}
			for _, n := range []string{"temporal-system", "default", "orders"} {
				resp.Namespaces = append(resp.Namespaces, &workflowservice.DescribeNamespaceResponse{NamespaceInfo: &namespacepb.NamespaceInfo{Name: n}})
			}
			return resp, nil, true
		})
		reply := &workflowservice.ListNamespacesResponse{}
		ctx := auth.WithPrincipal(context.Background(), testutil.Principal(testutil.Reader))
		if err := h.conn.Invoke(ctx, wf+"ListNamespaces", &workflowservice.ListNamespacesRequest{}, reply); err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, ns := range reply.GetNamespaces() {
			names = append(names, ns.GetNamespaceInfo().GetName())
		}
		want := "default,orders"
		if show {
			want = "temporal-system,default,orders"
		}
		if got := strings.Join(names, ","); got != want {
			t.Fatalf("show=%v: namespaces %s, want %s", show, got, want)
		}
	}
}

// blockingResponder answers every call once release is closed, or fails with
// the server-side context error if the call is canceled first. started
// receives one value per call.
func blockingResponder(started chan<- struct{}, release <-chan struct{}) testutil.Responder {
	return func(ctx context.Context, method string, _ any) (any, error, bool) {
		started <- struct{}{}
		select {
		case <-release:
			if strings.HasSuffix(method, "/DeleteNamespace") {
				return &operatorservice.DeleteNamespaceResponse{DeletedNamespace: "tui-test-x-deleted"}, nil, true
			}
			return &workflowservice.SignalWorkflowExecutionResponse{}, nil, true
		case <-ctx.Done():
			return nil, status.FromContextError(ctx.Err()).Err(), true
		}
	}
}

// TestDestructiveCallSurvivesClientCancel: once a confirmed destructive call
// is invoked, canceling the caller's context does not cancel it, and the
// audit line records Temporal's real result. Other writes still follow the
// caller's cancellation.
func TestDestructiveCallSurvivesClientCancel(t *testing.T) {
	for _, tc := range []struct {
		name     string
		ctx      context.Context
		method   string
		req      proto.Message
		reply    proto.Message
		wantCode codes.Code
	}{
		{"namespace delete completes", authz.WithIntent(admin(), authz.Intent{Confirm: "tui-test-x", HasConfirm: true}),
			op + "DeleteNamespace", &operatorservice.DeleteNamespaceRequest{Namespace: "tui-test-x"}, &operatorservice.DeleteNamespaceResponse{}, codes.OK},
		{"signal is canceled", writer(),
			wf + "SignalWorkflowExecution", &workflowservice.SignalWorkflowExecutionRequest{Namespace: "ns"}, &workflowservice.SignalWorkflowExecutionResponse{}, codes.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, nil)
			started, release := make(chan struct{}, 1), make(chan struct{})
			h.fake.SetResponder(blockingResponder(started, release))
			ctx, cancel := context.WithCancel(tc.ctx)
			done := make(chan codes.Code, 1)
			go func() { done <- status.Code(h.conn.Invoke(ctx, tc.method, tc.req, tc.reply)) }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("backend never called")
			}
			cancel()
			// Give a cancellation time to reach the backend before it answers.
			time.Sleep(100 * time.Millisecond)
			close(release)
			if got := <-done; got != tc.wantCode {
				t.Fatalf("code %v, want %v", got, tc.wantCode)
			}
			if want := `"code":"` + tc.wantCode.String() + `"`; !strings.Contains(h.logs.String(), want) {
				t.Fatalf("audit lacks %s: %s", want, h.logs.String())
			}
		})
	}
}
