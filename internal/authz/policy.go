// Package authz authorizes every gRPC call to Temporal by its full method
// name. Unknown methods are denied. The rules here are the only place that
// decides what a principal may call; HTTP paths are never inspected.
package authz

import (
	"strings"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/workflowservice/v1"

	"tempolens/internal/config"
)

// Class is the access class of an RPC.
type Class int

const (
	// ClassBlock is denied for every principal.
	ClassBlock Class = iota
	// ClassRead is allowed for every authenticated principal.
	ClassRead
	// ClassWrite is allowed for write and admin principals, subject to env
	// flags and validators.
	ClassWrite
	// ClassInternal is allowed only for the server's internal principal.
	ClassInternal
	// ClassAdmin is allowed only for admin principals, subject to env flags
	// and validators.
	ClassAdmin
)

func (c Class) String() string {
	return [...]string{"BLOCK", "READ", "WRITE", "INTERNAL", "ADMIN"}[c]
}

// mutating reports whether the class changes state (WRITE or ADMIN).
func (c Class) mutating() bool { return c == ClassWrite || c == ClassAdmin }

// Action names a per-action env flag. The same names appear in
// /api/x/me disabledActions.
type Action string

const (
	ActionTerminate Action = "terminate"
	ActionCancel    Action = "cancel"
	ActionSignal    Action = "signal"
	ActionUpdate    Action = "update"
	ActionReset     Action = "reset"
	ActionPause     Action = "pause"
	ActionBatch     Action = "batch"
	ActionStart     Action = "start"
	ActionSchedule  Action = "schedule"
	ActionNexus     Action = "nexus"
	// ActionDelete covers workflow delete; batch delete also checks it.
	ActionDelete Action = "delete"
	// ActionActivity covers the activity commands and activity complete/fail by ID.
	ActionActivity        Action = "activity"
	ActionNamespace       Action = "namespace"
	ActionSearchAttribute Action = "searchAttribute"
	// ActionBatchDelete has no flag of its own: it is disabled with batch or
	// delete, and it needs the admin role.
	ActionBatchDelete Action = "batchDelete"
)

// Rule is the authorization rule of one RPC.
type Rule struct {
	Class Class
	// Actions are the env flags that block this RPC.
	Actions []Action
	// DynamicActions adds env flags that depend on the request content.
	DynamicActions func(proto.Message) []Action
	// Stamp lists proto field paths (dot-separated proto names) that receive
	// the caller identity. Paths whose oneof parent is unset are skipped.
	Stamp []string
	// NoStamp declares that the request has no identity field.
	NoStamp bool
	// Validator rejects forbidden or incomplete requests before invoke.
	Validator func(proto.Message) error
	// PolicyCheck is a validator that needs the configuration.
	PolicyCheck func(*Policy, proto.Message) error
	// DynamicClass raises the class for some request variants (batch delete
	// is ADMIN).
	DynamicClass func(proto.Message) Class
	// Confirm returns the target that X-Tempolens-Confirm must name, when the
	// request is destructive.
	Confirm func(proto.Message) (target string, required bool)
	// ReasonHeader requires X-Tempolens-Reason (for RPCs without a reason field).
	ReasonHeader bool
	// NamespaceScoped is true when the request has a string "namespace"
	// field. It is derived from the descriptor, not declared.
	NamespaceScoped bool
}

const (
	wfPrefix     = "/temporal.api.workflowservice.v1.WorkflowService/"
	opPrefix     = "/temporal.api.operatorservice.v1.OperatorService/"
	healthPrefix = "/grpc.health.v1.Health/"
)

var (
	wfRead = []string{
		"DescribeNamespace", "ListNamespaces", "GetWorkflowExecutionHistory", "GetWorkflowExecutionHistoryReverse",
		"ListOpenWorkflowExecutions", "ListClosedWorkflowExecutions", "ListWorkflowExecutions",
		"ListArchivedWorkflowExecutions", "ScanWorkflowExecutions", "CountWorkflowExecutions", "GetSearchAttributes",
		// QueryWorkflow stays READ: query handlers are read-only by Temporal's
		// contract, and upstream treats them as reads.
		"QueryWorkflow",
		// CLI reads, including ListTaskQueuePartitions and the versioning reads.
		"DescribeWorkflowExecution", "DescribeTaskQueue", "GetClusterInfo", "GetSystemInfo", "ListTaskQueuePartitions",
		"DescribeSchedule", "ListScheduleMatchingTimes", "ListSchedules", "CountSchedules",
		"GetWorkerBuildIdCompatibility", "GetWorkerVersioningRules", "GetWorkerTaskReachability",
		"DescribeDeployment", "DescribeWorkerDeploymentVersion", "ListDeployments", "GetDeploymentReachability",
		"GetCurrentDeployment", "DescribeWorkerDeployment", "ListWorkerDeployments",
		"DescribeBatchOperation", "ListBatchOperations", "DescribeWorkflowRule", "ListWorkflowRules",
		"ListWorkers", "CountWorkers", "DescribeWorker", "FetchWorkerConfig",
		"DescribeActivityExecution", "DescribeNexusOperationExecution", "PollActivityExecution",
		"PollNexusOperationExecution", "PollWorkflowExecutionUpdate", "ListActivityExecutions",
		"ListNexusOperationExecutions", "CountActivityExecutions", "CountNexusOperationExecutions",
	}
	wfBlock = []string{
		// Deprecated namespace call, versioning and deployment writes (the
		// versioning APIs are off by default on Temporal 1.24 and unused by
		// the UI), and rule administration.
		"DeprecateNamespace",
		"UpdateWorkerBuildIdCompatibility", "UpdateWorkerVersioningRules",
		"SetCurrentDeployment", "SetWorkerDeploymentCurrentVersion", "SetWorkerDeploymentRampingVersion",
		"SetWorkerDeploymentManager", "CreateWorkerDeployment", "CreateWorkerDeploymentVersion",
		"DeleteWorkerDeployment", "DeleteWorkerDeploymentVersion", "UpdateWorkerDeploymentVersionComputeConfig",
		"ValidateWorkerDeploymentVersionComputeConfig", "UpdateWorkerDeploymentVersionMetadata",
		"CreateWorkflowRule", "DeleteWorkflowRule", "TriggerWorkflowRule", "UpdateTaskQueueConfig", "UpdateWorkerConfig",
		// Mutations the UI does not expose.
		"ExecuteMultiOperation", "UpdateWorkflowExecutionOptions",
		// Standalone activities and Nexus operations.
		"StartActivityExecution", "RequestCancelActivityExecution", "TerminateActivityExecution",
		"DeleteActivityExecution", "PauseActivityExecution", "UnpauseActivityExecution", "ResetActivityExecution",
		"UpdateActivityExecutionOptions", "StartNexusOperationExecution", "RequestCancelNexusOperationExecution",
		"TerminateNexusOperationExecution", "DeleteNexusOperationExecution",
		// Worker protocol.
		"PollWorkflowTaskQueue", "RespondWorkflowTaskCompleted", "RespondWorkflowTaskFailed", "PollActivityTaskQueue",
		"RecordActivityTaskHeartbeat", "RecordActivityTaskHeartbeatById", "RespondActivityTaskCompleted",
		"RespondActivityTaskFailed", "RespondActivityTaskCanceled", "RespondActivityTaskCanceledById", "RespondQueryTaskCompleted",
		"ResetStickyTaskQueue", "ShutdownWorker", "PollNexusTaskQueue", "RespondNexusTaskCompleted",
		"RespondNexusTaskFailed", "RecordWorkerHeartbeat",
		// Undocumented.
		"PollWorkflowExecutionTimeSkipping",
	}
	opRead  = []string{"ListSearchAttributes", "ListClusters", "GetNexusEndpoint", "ListNexusEndpoints"}
	opBlock = []string{"AddOrUpdateRemoteCluster", "RemoveRemoteCluster"}
)

var identity = []string{"identity"}

// writeRules are exactly the mutations the UI exposes.
var writeRules = map[string]Rule{
	wfPrefix + "StartWorkflowExecution":         {Actions: []Action{ActionStart}, Stamp: identity, Validator: validateStart},
	wfPrefix + "SignalWorkflowExecution":        {Actions: []Action{ActionSignal}, Stamp: identity},
	wfPrefix + "UpdateWorkflowExecution":        {Actions: []Action{ActionUpdate}, Stamp: []string{"request.meta.identity"}},
	wfPrefix + "RequestCancelWorkflowExecution": {Actions: []Action{ActionCancel}, Stamp: identity},
	wfPrefix + "TerminateWorkflowExecution": {Actions: []Action{ActionTerminate}, Stamp: identity, Validator: validateTerminate,
		Confirm: confirmPath("workflow_execution.workflow_id")},
	wfPrefix + "SignalWithStartWorkflowExecution": {Actions: []Action{ActionStart, ActionSignal}, Stamp: identity, Validator: validateStart},
	wfPrefix + "DeleteWorkflowExecution": {Actions: []Action{ActionDelete}, NoStamp: true, ReasonHeader: true,
		Confirm: confirmPath("workflow_execution.workflow_id")},
	wfPrefix + "RespondActivityTaskCompletedById": {Actions: []Action{ActionActivity}, Stamp: identity},
	wfPrefix + "RespondActivityTaskFailedById":    {Actions: []Action{ActionActivity}, Stamp: identity},
	// Unimplemented on Temporal 1.24 (501); the UI gates them on capabilities.
	wfPrefix + "PauseActivity":            {Actions: []Action{ActionActivity}, Stamp: identity},
	wfPrefix + "UnpauseActivity":          {Actions: []Action{ActionActivity}, Stamp: identity},
	wfPrefix + "ResetActivity":            {Actions: []Action{ActionActivity}, Stamp: identity},
	wfPrefix + "UpdateActivityOptions":    {Actions: []Action{ActionActivity}, Stamp: identity},
	wfPrefix + "ResetWorkflowExecution":   {Actions: []Action{ActionReset}, Stamp: identity, Validator: validateReset},
	wfPrefix + "PauseWorkflowExecution":   {Actions: []Action{ActionPause}, Stamp: identity},
	wfPrefix + "UnpauseWorkflowExecution": {Actions: []Action{ActionPause}, Stamp: identity},
	wfPrefix + "StartBatchOperation": {
		Actions:        []Action{ActionBatch},
		DynamicActions: batchActions,
		DynamicClass:   batchClass,
		Stamp: []string{"termination_operation.identity", "cancellation_operation.identity",
			"reset_operation.identity", "deletion_operation.identity"},
		Validator: validateBatch,
		Confirm:   confirmBatch,
	},
	wfPrefix + "StopBatchOperation":  {Actions: []Action{ActionBatch}, Stamp: identity},
	wfPrefix + "CreateSchedule":      {Actions: []Action{ActionSchedule, ActionStart}, Stamp: identity},
	wfPrefix + "UpdateSchedule":      {Actions: []Action{ActionSchedule, ActionStart}, Stamp: identity},
	wfPrefix + "PatchSchedule":       {Actions: []Action{ActionSchedule}, DynamicActions: patchScheduleActions, Stamp: identity},
	wfPrefix + "DeleteSchedule":      {Actions: []Action{ActionSchedule}, Stamp: identity},
	opPrefix + "CreateNexusEndpoint": {Actions: []Action{ActionNexus}, NoStamp: true, Validator: validateNexusTarget},
	opPrefix + "UpdateNexusEndpoint": {Actions: []Action{ActionNexus}, NoStamp: true, Validator: validateNexusTarget},
	opPrefix + "DeleteNexusEndpoint": {Actions: []Action{ActionNexus}, NoStamp: true},
}

// adminRules are the namespace and search-attribute administration RPCs.
// None of their requests has an identity field.
var adminRules = map[string]Rule{
	wfPrefix + "RegisterNamespace": {Actions: []Action{ActionNamespace}, NoStamp: true, Validator: validateRegisterNamespace},
	wfPrefix + "UpdateNamespace":   {Actions: []Action{ActionNamespace}, NoStamp: true, Validator: validateUpdateNamespace},
	opPrefix + "DeleteNamespace": {Actions: []Action{ActionNamespace}, NoStamp: true, Validator: validateDeleteNamespace,
		PolicyCheck: (*Policy).checkProtectedNamespace, Confirm: confirmPath("namespace")},
	opPrefix + "AddSearchAttributes": {Actions: []Action{ActionSearchAttribute}, NoStamp: true, Validator: validateAddSearchAttributes},
	opPrefix + "RemoveSearchAttributes": {Actions: []Action{ActionSearchAttribute}, NoStamp: true,
		Validator: validateRemoveSearchAttributes, Confirm: confirmSearchAttributes},
}

// rules maps every known full method name to its rule.
var rules = buildRules()

func buildRules() map[string]Rule {
	m := map[string]Rule{}
	add := func(prefix string, names []string, c Class) {
		for _, n := range names {
			m[prefix+n] = Rule{Class: c}
		}
	}
	add(wfPrefix, wfRead, ClassRead)
	add(wfPrefix, wfBlock, ClassBlock)
	add(opPrefix, opRead, ClassRead)
	add(opPrefix, opBlock, ClassBlock)
	// Check is READ (the internal principal may call READ RPCs); it has no
	// HTTP route.
	add(healthPrefix, []string{"Check"}, ClassRead)
	add(healthPrefix, []string{"List", "Watch"}, ClassBlock)
	for name, r := range writeRules {
		r.Class = ClassWrite
		m[name] = r
	}
	for name, r := range adminRules {
		r.Class = ClassAdmin
		m[name] = r
	}
	for name, r := range m {
		r.NamespaceScoped = hasNamespaceField(name)
		m[name] = r
	}
	return m
}

// Lookup returns the rule of a full method name.
func Lookup(fullMethod string) (Rule, bool) {
	r, ok := rules[fullMethod]
	return r, ok
}

// hasNamespaceField reports whether the method's request message has a
// string field named "namespace".
func hasNamespaceField(fullMethod string) bool {
	md := methodDescriptor(fullMethod)
	if md == nil {
		return false
	}
	f := md.Input().Fields().ByName("namespace")
	return f != nil && f.Kind() == protoreflect.StringKind && f.Cardinality() != protoreflect.Repeated
}

// methodDescriptor resolves "/pkg.Service/Method" in the global registry.
func methodDescriptor(fullMethod string) protoreflect.MethodDescriptor {
	if len(fullMethod) < 2 || fullMethod[0] != '/' {
		return nil
	}
	svc, method := "", ""
	for i := len(fullMethod) - 1; i > 0; i-- {
		if fullMethod[i] == '/' {
			svc, method = fullMethod[1:i], fullMethod[i+1:]
			break
		}
	}
	d, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(svc))
	if err != nil {
		return nil
	}
	sd, ok := d.(protoreflect.ServiceDescriptor)
	if !ok {
		return nil
	}
	return sd.Methods().ByName(protoreflect.Name(method))
}

// Policy applies the env flags on top of the static rules.
type Policy struct {
	cfg      *config.Config
	disabled map[Action]bool
}

// NewPolicy returns the policy for cfg.
func NewPolicy(cfg *config.Config) *Policy {
	f := cfg.Disabled
	return &Policy{cfg: cfg, disabled: map[Action]bool{
		ActionTerminate: f.Terminate, ActionCancel: f.Cancel, ActionSignal: f.Signal,
		ActionUpdate: f.Update, ActionReset: f.Reset, ActionPause: f.Pause,
		ActionBatch: f.Batch, ActionStart: f.Start, ActionSchedule: f.Schedule, ActionNexus: f.Nexus,
		ActionDelete: f.Delete, ActionActivity: f.Activity, ActionNamespace: f.Namespace,
		ActionSearchAttribute: f.SearchAttribute, ActionBatchDelete: f.Batch || f.Delete,
	}}
}

// AllActions lists every action in the order used by /api/x/me.
var AllActions = []Action{
	ActionTerminate, ActionCancel, ActionSignal, ActionUpdate, ActionReset,
	ActionPause, ActionBatch, ActionStart, ActionSchedule, ActionNexus,
	ActionDelete, ActionActivity, ActionNamespace, ActionSearchAttribute, ActionBatchDelete,
}

// AdminActions are the actions only the admin role may perform.
var AdminActions = []Action{ActionNamespace, ActionSearchAttribute, ActionBatchDelete}

// DisabledByEnv returns the actions disabled by env flags, in AllActions order.
func (p *Policy) DisabledByEnv() []Action {
	var out []Action
	for _, a := range AllActions {
		if p.disabled[a] {
			out = append(out, a)
		}
	}
	return out
}

// blockedBy returns the first env flag that blocks req under rule, if any.
func (p *Policy) blockedBy(rule Rule, req proto.Message) (Action, bool) {
	actions := rule.Actions
	if rule.DynamicActions != nil {
		actions = append(append([]Action(nil), actions...), rule.DynamicActions(req)...)
	}
	for _, a := range actions {
		if p.disabled[a] {
			return a, true
		}
	}
	return "", false
}

func batchActions(m proto.Message) []Action {
	req, ok := m.(*workflowservice.StartBatchOperationRequest)
	if !ok {
		return nil
	}
	switch req.GetOperation().(type) {
	case *workflowservice.StartBatchOperationRequest_TerminationOperation:
		return []Action{ActionTerminate}
	case *workflowservice.StartBatchOperationRequest_CancellationOperation:
		return []Action{ActionCancel}
	case *workflowservice.StartBatchOperationRequest_ResetOperation:
		return []Action{ActionReset}
	case *workflowservice.StartBatchOperationRequest_DeletionOperation:
		return []Action{ActionDelete}
	}
	return nil
}

// batchClass makes batch delete an ADMIN operation.
func batchClass(m proto.Message) Class {
	if req, ok := m.(*workflowservice.StartBatchOperationRequest); ok && req.GetDeletionOperation() != nil {
		return ClassAdmin
	}
	return ClassWrite
}

// confirmPath confirms against the string field at path.
func confirmPath(path string) func(proto.Message) (string, bool) {
	return func(m proto.Message) (string, bool) { return stringAt(m, path), true }
}

// confirmBatch requires confirmation, by job ID, for batch terminate and delete.
func confirmBatch(m proto.Message) (string, bool) {
	req, ok := m.(*workflowservice.StartBatchOperationRequest)
	if !ok || (req.GetTerminationOperation() == nil && req.GetDeletionOperation() == nil) {
		return "", false
	}
	return req.GetJobId(), true
}

// confirmSearchAttributes confirms by the removed names, comma-separated in
// request order.
func confirmSearchAttributes(m proto.Message) (string, bool) {
	req, ok := m.(*operatorservice.RemoveSearchAttributesRequest)
	if !ok {
		return "", true
	}
	return strings.Join(req.GetSearchAttributes(), ","), true
}

func patchScheduleActions(m proto.Message) []Action {
	req, ok := m.(*workflowservice.PatchScheduleRequest)
	if !ok {
		return nil
	}
	if p := req.GetPatch(); p.GetTriggerImmediately() != nil || len(p.GetBackfillRequest()) > 0 {
		return []Action{ActionStart}
	}
	return nil
}
