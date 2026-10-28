package authz

import (
	"testing"
	"time"

	batchpb "go.temporal.io/api/batch/v1"
	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	nexuspb "go.temporal.io/api/nexus/v1"
	"go.temporal.io/api/operatorservice/v1"
	schedulepb "go.temporal.io/api/schedule/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"

	"tempolens/internal/config"
)

func batch(mod func(*workflowservice.StartBatchOperationRequest)) *workflowservice.StartBatchOperationRequest {
	r := &workflowservice.StartBatchOperationRequest{
		Namespace: "ns", VisibilityQuery: `WorkflowType="X"`, Reason: "r", JobId: "j",
		Operation: &workflowservice.StartBatchOperationRequest_TerminationOperation{TerminationOperation: &batchpb.BatchOperationTermination{}},
	}
	if mod != nil {
		mod(r)
	}
	return r
}

func TestValidators(t *testing.T) {
	postReset := []*workflowpb.PostResetOperation{{}}
	for _, tc := range []struct {
		name string
		v    func(proto.Message) error
		req  proto.Message
		want codes.Code
	}{
		{"start ok", validateStart, &workflowservice.StartWorkflowExecutionRequest{}, codes.OK},
		{"start completion callbacks", validateStart, &workflowservice.StartWorkflowExecutionRequest{
			CompletionCallbacks: []*commonpb.Callback{{}}}, codes.PermissionDenied},
		{"start eager execution", validateStart, &workflowservice.StartWorkflowExecutionRequest{RequestEagerExecution: true}, codes.PermissionDenied},
		{"signal-with-start ok", validateStart, &workflowservice.SignalWithStartWorkflowExecutionRequest{Namespace: "n"}, codes.OK},
		{"nexus external target ok", validateNexusTarget, &operatorservice.CreateNexusEndpointRequest{Spec: &nexuspb.EndpointSpec{
			Target: &nexuspb.EndpointTarget{Variant: &nexuspb.EndpointTarget_External_{External: &nexuspb.EndpointTarget_External{Url: "https://x"}}}}}, codes.OK},
		{"nexus worker target ok", validateNexusTarget, &operatorservice.CreateNexusEndpointRequest{Spec: nexusSpec("orders")}, codes.OK},
		{"nexus target temporal-system", validateNexusTarget, &operatorservice.CreateNexusEndpointRequest{Spec: nexusSpec("temporal-system")}, codes.PermissionDenied},
		{"nexus update target temporal-system", validateNexusTarget, &operatorservice.UpdateNexusEndpointRequest{Spec: nexusSpec("temporal-system")}, codes.PermissionDenied},
		{"terminate ok", validateTerminate, &workflowservice.TerminateWorkflowExecutionRequest{Reason: "r"}, codes.OK},
		{"terminate empty reason", validateTerminate, &workflowservice.TerminateWorkflowExecutionRequest{Reason: "  "}, codes.InvalidArgument},
		{"reset ok", validateReset, &workflowservice.ResetWorkflowExecutionRequest{Reason: "r"}, codes.OK},
		{"reset empty reason", validateReset, &workflowservice.ResetWorkflowExecutionRequest{}, codes.InvalidArgument},
		{"reset post-reset ops", validateReset, &workflowservice.ResetWorkflowExecutionRequest{Reason: "r", PostResetOperations: postReset}, codes.PermissionDenied},

		{"batch terminate ok", validateBatch, batch(nil), codes.OK},
		{"batch cancel ok", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Operation = &workflowservice.StartBatchOperationRequest_CancellationOperation{CancellationOperation: &batchpb.BatchOperationCancellation{}}
		}), codes.OK},
		{"batch reset ok", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Operation = &workflowservice.StartBatchOperationRequest_ResetOperation{ResetOperation: &batchpb.BatchOperationReset{}}
		}), codes.OK},
		{"batch empty reason", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) { r.Reason = "" }), codes.InvalidArgument},
		{"batch signal", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Operation = &workflowservice.StartBatchOperationRequest_SignalOperation{SignalOperation: &batchpb.BatchOperationSignal{}}
		}), codes.PermissionDenied},
		{"batch deletion is allowed (admin-only by class)", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Operation = &workflowservice.StartBatchOperationRequest_DeletionOperation{DeletionOperation: &batchpb.BatchOperationDeletion{}}
		}), codes.OK},
		{"register namespace ok", validateRegisterNamespace, &workflowservice.RegisterNamespaceRequest{Namespace: "n", WorkflowExecutionRetentionPeriod: durationpb.New(24 * time.Hour)}, codes.OK},
		{"register namespace without retention", validateRegisterNamespace, &workflowservice.RegisterNamespaceRequest{Namespace: "n"}, codes.InvalidArgument},
		{"register namespace zero retention", validateRegisterNamespace, &workflowservice.RegisterNamespaceRequest{Namespace: "n", WorkflowExecutionRetentionPeriod: durationpb.New(0)}, codes.InvalidArgument},
		{"register namespace without name", validateRegisterNamespace, &workflowservice.RegisterNamespaceRequest{WorkflowExecutionRetentionPeriod: durationpb.New(time.Hour)}, codes.InvalidArgument},
		{"update namespace ok", validateUpdateNamespace, &workflowservice.UpdateNamespaceRequest{Namespace: "n"}, codes.OK},
		{"update namespace promote", validateUpdateNamespace, &workflowservice.UpdateNamespaceRequest{Namespace: "n", PromoteNamespace: true}, codes.PermissionDenied},
		{"delete namespace by name", validateDeleteNamespace, &operatorservice.DeleteNamespaceRequest{Namespace: "n"}, codes.OK},
		{"delete namespace by id", validateDeleteNamespace, &operatorservice.DeleteNamespaceRequest{Namespace: "n", NamespaceId: "id"}, codes.InvalidArgument},
		{"delete namespace without name", validateDeleteNamespace, &operatorservice.DeleteNamespaceRequest{NamespaceId: "id"}, codes.InvalidArgument},
		{"add search attribute ok", validateAddSearchAttributes, &operatorservice.AddSearchAttributesRequest{Namespace: "n",
			SearchAttributes: map[string]enumspb.IndexedValueType{"CustomKeyword": enumspb.INDEXED_VALUE_TYPE_KEYWORD}}, codes.OK},
		{"add search attribute none", validateAddSearchAttributes, &operatorservice.AddSearchAttributesRequest{Namespace: "n"}, codes.InvalidArgument},
		{"remove custom search attribute", validateRemoveSearchAttributes, &operatorservice.RemoveSearchAttributesRequest{Namespace: "n", SearchAttributes: []string{"CustomKeyword"}}, codes.OK},
		{"remove system search attribute", validateRemoveSearchAttributes, &operatorservice.RemoveSearchAttributesRequest{Namespace: "n", SearchAttributes: []string{"CustomKeyword", "WorkflowType"}}, codes.PermissionDenied},
		{"remove Temporal-prefixed attribute", validateRemoveSearchAttributes, &operatorservice.RemoveSearchAttributesRequest{Namespace: "n", SearchAttributes: []string{"TemporalChangeVersion"}}, codes.PermissionDenied},
		{"remove none", validateRemoveSearchAttributes, &operatorservice.RemoveSearchAttributesRequest{Namespace: "n"}, codes.InvalidArgument},
		{"batch update options", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Operation = &workflowservice.StartBatchOperationRequest_UpdateWorkflowOptionsOperation{UpdateWorkflowOptionsOperation: &batchpb.BatchOperationUpdateWorkflowExecutionOptions{}}
		}), codes.PermissionDenied},
		{"batch activity op", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Operation = &workflowservice.StartBatchOperationRequest_ResetActivitiesOperation{ResetActivitiesOperation: &batchpb.BatchOperationResetActivities{}}
		}), codes.PermissionDenied},
		{"batch no operation", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) { r.Operation = nil }), codes.PermissionDenied},
		{"batch executions", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Executions = []*commonpb.WorkflowExecution{{WorkflowId: "a"}}
		}), codes.PermissionDenied},
		{"batch target executions", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.TargetExecutions = []*commonpb.Execution{{}}
		}), codes.PermissionDenied},
		{"batch empty query", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) { r.VisibilityQuery = " " }), codes.PermissionDenied},
		{"batch reset post-reset ops", validateBatch, batch(func(r *workflowservice.StartBatchOperationRequest) {
			r.Operation = &workflowservice.StartBatchOperationRequest_ResetOperation{ResetOperation: &batchpb.BatchOperationReset{PostResetOperations: postReset}}
		}), codes.PermissionDenied},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := status.Code(tc.v(tc.req)); got != tc.want {
				t.Fatalf("code %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDynamicActions(t *testing.T) {
	if got := batchActions(batch(nil)); len(got) != 1 || got[0] != ActionTerminate {
		t.Fatalf("batch terminate actions = %v", got)
	}
	patch := &workflowservice.PatchScheduleRequest{Patch: &schedulePatch{TriggerImmediately: &triggerRequest{}}}
	if got := patchScheduleActions(patch); len(got) != 1 || got[0] != ActionStart {
		t.Fatalf("patch trigger actions = %v", got)
	}
	patch = &workflowservice.PatchScheduleRequest{Patch: &schedulePatch{BackfillRequest: []*backfillRequest{{}}}}
	if got := patchScheduleActions(patch); len(got) != 1 || got[0] != ActionStart {
		t.Fatalf("patch backfill actions = %v", got)
	}
	patch = &workflowservice.PatchScheduleRequest{Patch: &schedulePatch{Pause: "p"}}
	if got := patchScheduleActions(patch); len(got) != 0 {
		t.Fatalf("patch pause actions = %v", got)
	}
}

func TestStamp(t *testing.T) {
	r := batch(nil)
	paths := rules[wfPrefix+"StartBatchOperation"].Stamp
	if n := stamp(r, paths, "tempolens:a"); n != 1 {
		t.Fatalf("stamped %d paths, want 1 (only the set oneof member)", n)
	}
	if got := r.GetTerminationOperation().GetIdentity(); got != "tempolens:a" {
		t.Fatalf("identity = %q", got)
	}
	if r.GetResetOperation() != nil || r.GetCancellationOperation() != nil {
		t.Fatal("stamping must not create other oneof members")
	}

	u := &workflowservice.UpdateWorkflowExecutionRequest{}
	if n := stamp(u, []string{"request.meta.identity"}, "tempolens:b"); n != 1 || u.GetRequest().GetMeta().GetIdentity() != "tempolens:b" {
		t.Fatalf("update stamp failed: n=%d req=%v", n, u)
	}
}

type (
	schedulePatch   = schedulepb.SchedulePatch
	triggerRequest  = schedulepb.TriggerImmediatelyRequest
	backfillRequest = schedulepb.BackfillRequest
)

func nexusSpec(ns string) *nexuspb.EndpointSpec {
	return &nexuspb.EndpointSpec{Name: "e", Target: &nexuspb.EndpointTarget{Variant: &nexuspb.EndpointTarget_Worker_{
		Worker: &nexuspb.EndpointTarget_Worker{Namespace: ns, TaskQueue: "q"}}}}
}

func TestProtectedNamespaces(t *testing.T) {
	p := &Policy{cfg: &config.Config{ProtectedNamespaces: []string{"payments"}}}
	for ns, want := range map[string]codes.Code{
		"default": codes.PermissionDenied, "temporal-system": codes.PermissionDenied,
		"payments": codes.PermissionDenied, "tui-test-scratch": codes.OK,
	} {
		if got := status.Code(p.checkProtectedNamespace(&operatorservice.DeleteNamespaceRequest{Namespace: ns})); got != want {
			t.Errorf("delete %s: %v, want %v", ns, got, want)
		}
	}
	// default stays protected even when the env list leaves it out.
	p = &Policy{cfg: &config.Config{}}
	if status.Code(p.checkProtectedNamespace(&operatorservice.DeleteNamespaceRequest{Namespace: "default"})) != codes.PermissionDenied {
		t.Fatal("default must always be protected")
	}
}

func TestConfirmTargets(t *testing.T) {
	term := &workflowservice.TerminateWorkflowExecutionRequest{WorkflowExecution: &commonpb.WorkflowExecution{WorkflowId: "a/b c"}}
	if got, req := rules[wfPrefix+"TerminateWorkflowExecution"].Confirm(term); !req || got != "a/b c" {
		t.Errorf("terminate target = %q %v", got, req)
	}
	if _, req := confirmBatch(batch(func(r *workflowservice.StartBatchOperationRequest) {
		r.Operation = &workflowservice.StartBatchOperationRequest_CancellationOperation{CancellationOperation: &batchpb.BatchOperationCancellation{}}
	})); req {
		t.Error("batch cancel must not need confirmation")
	}
	if got, req := confirmBatch(batch(nil)); !req || got != "j" {
		t.Errorf("batch terminate target = %q %v", got, req)
	}
	rm := &operatorservice.RemoveSearchAttributesRequest{SearchAttributes: []string{"B", "A"}}
	if got, _ := confirmSearchAttributes(rm); got != "B,A" {
		t.Errorf("remove SA target = %q", got)
	}
	if batchClass(batch(func(r *workflowservice.StartBatchOperationRequest) {
		r.Operation = &workflowservice.StartBatchOperationRequest_DeletionOperation{DeletionOperation: &batchpb.BatchOperationDeletion{}}
	})) != ClassAdmin || batchClass(batch(nil)) != ClassWrite {
		t.Error("batch delete must be ADMIN and batch terminate WRITE")
	}
}
