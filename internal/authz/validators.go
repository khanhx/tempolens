package authz

import (
	"slices"
	"strings"

	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// Validators return InvalidArgument (HTTP 400) for incomplete requests and
// PermissionDenied (HTTP 403) for forbidden variants.

func requireReason(reason string) error {
	if strings.TrimSpace(reason) == "" {
		return status.Error(codes.InvalidArgument, "a non-empty reason is required")
	}
	return nil
}

func validateTerminate(m proto.Message) error {
	req, ok := m.(*workflowservice.TerminateWorkflowExecutionRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	return requireReason(req.GetReason())
}

func validateReset(m proto.Message) error {
	req, ok := m.(*workflowservice.ResetWorkflowExecutionRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	if len(req.GetPostResetOperations()) > 0 {
		return status.Error(codes.PermissionDenied, "postResetOperations are not allowed")
	}
	return requireReason(req.GetReason())
}

// validateStart refuses the start options a UI never needs and that reach
// beyond the workflow: completion callbacks (an HTTP call from the Temporal
// frontend to any URL) and eager execution (a task handed to the caller).
// It reads the fields by name, so it serves Start and SignalWithStart alike
// (the latter has neither field in api v1.64, but may gain them).
func validateStart(m proto.Message) error {
	msg := m.ProtoReflect()
	fields := msg.Descriptor().Fields()
	if fd := fields.ByName("completion_callbacks"); fd != nil && msg.Get(fd).List().Len() > 0 {
		return status.Error(codes.PermissionDenied, "completionCallbacks are not allowed")
	}
	if fd := fields.ByName("request_eager_execution"); fd != nil && msg.Get(fd).Bool() {
		return status.Error(codes.PermissionDenied, "requestEagerExecution is not allowed")
	}
	return nil
}

// validateNexusTarget refuses endpoints that route into temporal-system.
func validateNexusTarget(m proto.Message) error {
	if stringAt(m, "spec.target.worker.namespace") == SystemNamespace {
		return status.Error(codes.PermissionDenied, "Nexus endpoints may not target "+SystemNamespace)
	}
	return nil
}

// validateBatch keeps the one batch targeting mode the UI uses: a
// terminate, cancel or reset over a non-empty visibility query.
func validateBatch(m proto.Message) error {
	req, ok := m.(*workflowservice.StartBatchOperationRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	switch op := req.GetOperation().(type) {
	case *workflowservice.StartBatchOperationRequest_TerminationOperation,
		*workflowservice.StartBatchOperationRequest_CancellationOperation,
		// Deletion is ADMIN (batchClass); the role check has already run.
		*workflowservice.StartBatchOperationRequest_DeletionOperation:
	case *workflowservice.StartBatchOperationRequest_ResetOperation:
		if len(op.ResetOperation.GetPostResetOperations()) > 0 {
			return status.Error(codes.PermissionDenied, "postResetOperations are not allowed")
		}
	default:
		return status.Error(codes.PermissionDenied, "only terminate, cancel, reset and (admin) delete batch operations are allowed")
	}
	if len(req.GetExecutions()) > 0 || len(req.GetTargetExecutions()) > 0 {
		return status.Error(codes.PermissionDenied, "batch operations must target a visibilityQuery, not executions")
	}
	if strings.TrimSpace(req.GetVisibilityQuery()) == "" {
		return status.Error(codes.PermissionDenied, "batch operations require a non-empty visibilityQuery")
	}
	return requireReason(req.GetReason())
}

// validateRegisterNamespace needs a name and a positive retention.
func validateRegisterNamespace(m proto.Message) error {
	req, ok := m.(*workflowservice.RegisterNamespaceRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	if strings.TrimSpace(req.GetNamespace()) == "" {
		return status.Error(codes.InvalidArgument, "a namespace name is required")
	}
	if r := req.GetWorkflowExecutionRetentionPeriod(); r == nil || r.AsDuration() <= 0 {
		return status.Error(codes.InvalidArgument, "a positive workflowExecutionRetentionPeriod is required")
	}
	return nil
}

// validateUpdateNamespace refuses promoting a namespace to global, a
// cluster-replication change.
func validateUpdateNamespace(m proto.Message) error {
	req, ok := m.(*workflowservice.UpdateNamespaceRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	if req.GetPromoteNamespace() {
		return status.Error(codes.PermissionDenied, "promoteNamespace is not allowed")
	}
	return nil
}

// validateDeleteNamespace targets a namespace by name only, so the
// namespace guard and the protected list see the real target.
func validateDeleteNamespace(m proto.Message) error {
	req, ok := m.(*operatorservice.DeleteNamespaceRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	if strings.TrimSpace(req.GetNamespace()) == "" || req.GetNamespaceId() != "" {
		return status.Error(codes.InvalidArgument, "delete a namespace by its name only (namespace, not namespaceId)")
	}
	return nil
}

// ProtectedNamespaces returns the namespaces that can never be deleted:
// default, temporal-system and the configured list, sorted and deduplicated.
func (p *Policy) ProtectedNamespaces() []string {
	out := append([]string{"default", SystemNamespace}, p.cfg.ProtectedNamespaces...)
	slices.Sort(out)
	return slices.Compact(out)
}

// checkProtectedNamespace refuses deleting a protected namespace.
func (p *Policy) checkProtectedNamespace(m proto.Message) error {
	ns := stringAt(m, "namespace")
	if slices.Contains(p.ProtectedNamespaces(), ns) {
		return status.Error(codes.PermissionDenied, "namespace "+ns+" is protected and cannot be deleted")
	}
	return nil
}

func validateAddSearchAttributes(m proto.Message) error {
	req, ok := m.(*operatorservice.AddSearchAttributesRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	if len(req.GetSearchAttributes()) == 0 {
		return status.Error(codes.InvalidArgument, "at least one search attribute is required")
	}
	return nil
}

// systemSearchAttributes are Temporal's built-in attributes (1.24); any
// name starting with "Temporal" is reserved as well.
var systemSearchAttributes = []string{
	"BatcherNamespace", "BatcherUser", "BinaryChecksums", "BuildIds", "CloseTime", "ExecutionDuration",
	"ExecutionStatus", "ExecutionTime", "HistoryLength", "HistorySizeBytes", "NamespaceId", "ParentRunId",
	"ParentWorkflowId", "RootRunId", "RootWorkflowId", "RunId", "StartTime", "StateTransitionCount",
	"TaskQueue", "WorkflowId", "WorkflowType",
}

func validateRemoveSearchAttributes(m proto.Message) error {
	req, ok := m.(*operatorservice.RemoveSearchAttributesRequest)
	if !ok {
		return status.Error(codes.Internal, "unexpected request type")
	}
	if len(req.GetSearchAttributes()) == 0 {
		return status.Error(codes.InvalidArgument, "at least one search attribute is required")
	}
	for _, name := range req.GetSearchAttributes() {
		if strings.HasPrefix(name, "Temporal") || slices.Contains(systemSearchAttributes, name) {
			return status.Error(codes.PermissionDenied, "system search attribute "+name+" cannot be removed")
		}
	}
	return nil
}
