package authz

import (
	"slices"
	"sort"
	"testing"

	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/workflowservice/v1"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// serviceFiles are every gRPC service the connection can reach.
var serviceFiles = []protoreflect.FileDescriptor{
	workflowservice.File_temporal_api_workflowservice_v1_service_proto,
	operatorservice.File_temporal_api_operatorservice_v1_service_proto,
	healthpb.File_grpc_health_v1_health_proto,
}

func allMethods() map[string]protoreflect.MethodDescriptor {
	out := map[string]protoreflect.MethodDescriptor{}
	for _, f := range serviceFiles {
		for i := 0; i < f.Services().Len(); i++ {
			svc := f.Services().Get(i)
			for j := 0; j < svc.Methods().Len(); j++ {
				m := svc.Methods().Get(j)
				out["/"+string(svc.FullName())+"/"+string(m.Name())] = m
			}
		}
	}
	return out
}

// TestEveryMethodClassified fails when an api bump adds a method, forcing a
// class, stamp and validator decision.
func TestEveryMethodClassified(t *testing.T) {
	methods := allMethods()
	for name := range methods {
		if _, ok := Lookup(name); !ok {
			t.Errorf("unclassified method %s", name)
		}
	}
	for name := range rules {
		if _, ok := methods[name]; !ok {
			t.Errorf("rule for unknown method %s", name)
		}
	}
}

func classSet(c Class) []string {
	var got []string
	for name, r := range rules {
		if r.Class == c {
			got = append(got, shortMethod(name))
		}
	}
	sort.Strings(got)
	return got
}

func TestWriteSetIsExact(t *testing.T) {
	want := []string{
		"CreateNexusEndpoint", "CreateSchedule", "DeleteNexusEndpoint", "DeleteSchedule", "DeleteWorkflowExecution",
		"PatchSchedule", "PauseActivity", "PauseWorkflowExecution", "RequestCancelWorkflowExecution", "ResetActivity",
		"ResetWorkflowExecution", "RespondActivityTaskCompletedById", "RespondActivityTaskFailedById",
		"SignalWithStartWorkflowExecution", "SignalWorkflowExecution", "StartBatchOperation", "StartWorkflowExecution",
		"StopBatchOperation", "TerminateWorkflowExecution", "UnpauseActivity", "UnpauseWorkflowExecution",
		"UpdateActivityOptions", "UpdateNexusEndpoint", "UpdateSchedule", "UpdateWorkflowExecution",
	}
	if got := classSet(ClassWrite); !slices.Equal(got, want) {
		t.Fatalf("WRITE set\n got: %v\nwant: %v", got, want)
	}
}

func TestAdminSetIsExact(t *testing.T) {
	want := []string{"AddSearchAttributes", "DeleteNamespace", "RegisterNamespace", "RemoveSearchAttributes", "UpdateNamespace"}
	if got := classSet(ClassAdmin); !slices.Equal(got, want) {
		t.Fatalf("ADMIN set\n got: %v\nwant: %v", got, want)
	}
}

func TestSpecificClasses(t *testing.T) {
	for name, want := range map[string]Class{
		wfPrefix + "QueryWorkflow":                    ClassRead,
		wfPrefix + "ListWorkflowExecutions":           ClassRead,
		wfPrefix + "SignalWithStartWorkflowExecution": ClassWrite,
		wfPrefix + "DeleteWorkflowExecution":          ClassWrite,
		wfPrefix + "DeprecateNamespace":               ClassBlock,
		wfPrefix + "UpdateWorkerVersioningRules":      ClassBlock,
		wfPrefix + "ListTaskQueuePartitions":          ClassRead,
		wfPrefix + "GetWorkerTaskReachability":        ClassRead,
		opPrefix + "RemoveRemoteCluster":              ClassBlock,
		wfPrefix + "UpdateWorkflowExecutionOptions":   ClassBlock,
		wfPrefix + "ExecuteMultiOperation":            ClassBlock,
		wfPrefix + "RegisterNamespace":                ClassAdmin,
		wfPrefix + "RespondWorkflowTaskCompleted":     ClassBlock,
		opPrefix + "AddSearchAttributes":              ClassAdmin,
		wfPrefix + "PauseActivity":                    ClassWrite,
		wfPrefix + "RespondActivityTaskCompletedById": ClassWrite,
		wfPrefix + "RespondActivityTaskCompleted":     ClassBlock,
		healthPrefix + "Check":                        ClassRead,
		healthPrefix + "Watch":                        ClassBlock,
	} {
		if r, _ := Lookup(name); r.Class != want {
			t.Errorf("%s: class %v, want %v", name, r.Class, want)
		}
	}
}

// TestStampPaths checks that every WRITE declares a stamp or an explicit
// none, and that every stamp path ends in a string field.
func TestStampPaths(t *testing.T) {
	methods := allMethods()
	for name, r := range rules {
		if !r.Class.mutating() {
			if len(r.Stamp) > 0 || r.NoStamp {
				t.Errorf("%s: non-mutating rule declares stamping", name)
			}
			continue
		}
		if (len(r.Stamp) > 0) == r.NoStamp {
			t.Errorf("%s: must declare exactly one of Stamp or NoStamp", name)
			continue
		}
		in := methods[name].Input()
		if r.NoStamp && in.Fields().ByName("identity") != nil {
			t.Errorf("%s: declares NoStamp but has an identity field", name)
		}
		for _, p := range r.Stamp {
			if !resolvesToString(in, splitPath(p)) {
				t.Errorf("%s: stamp path %q does not resolve to a string field of %s", name, p, in.FullName())
			}
		}
	}
}

func resolvesToString(md protoreflect.MessageDescriptor, path []string) bool {
	for i, name := range path {
		fd := md.Fields().ByName(protoreflect.Name(name))
		if fd == nil || fd.Cardinality() == protoreflect.Repeated {
			return false
		}
		if i == len(path)-1 {
			return fd.Kind() == protoreflect.StringKind
		}
		if fd.Kind() != protoreflect.MessageKind {
			return false
		}
		md = fd.Message()
	}
	return false
}

func TestNamespaceScopedDerived(t *testing.T) {
	for name, want := range map[string]bool{
		wfPrefix + "TerminateWorkflowExecution": true,
		wfPrefix + "ListNamespaces":             false,
		wfPrefix + "GetSystemInfo":              false,
		opPrefix + "CreateNexusEndpoint":        false,
		opPrefix + "ListSearchAttributes":       true,
	} {
		if r, _ := Lookup(name); r.NamespaceScoped != want {
			t.Errorf("%s: NamespaceScoped=%v, want %v", name, r.NamespaceScoped, want)
		}
	}
}
