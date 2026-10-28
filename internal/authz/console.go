package authz

import (
	"cmp"
	"slices"

	"google.golang.org/protobuf/reflect/protoreflect"
)

// ConsoleMethod is one RPC the command console may invoke.
type ConsoleMethod struct {
	// Method is the full gRPC method name, "/pkg.Service/Name".
	Method string `json:"method"`
	// Service is the short service name, WorkflowService or OperatorService.
	Service string `json:"service"`
	// Name is the short method name.
	Name string `json:"name"`
	// Class is READ, WRITE or ADMIN. StartBatchOperation is WRITE here; its
	// delete variant is raised to ADMIN when called.
	Class string `json:"class"`
}

// consoleServices are the services whose RPCs the console may invoke.
var consoleServices = map[protoreflect.FullName]string{
	"temporal.api.workflowservice.v1.WorkflowService": "WorkflowService",
	"temporal.api.operatorservice.v1.OperatorService": "OperatorService",
}

// consoleMethods is the console allowlist, derived from the rules: every
// unary WorkflowService or OperatorService RPC classed READ, WRITE or ADMIN.
// Classifying an RPC therefore also decides whether the console offers it.
var consoleMethods, consoleByName = buildConsole()

func buildConsole() ([]ConsoleMethod, map[string]protoreflect.MethodDescriptor) {
	var list []ConsoleMethod
	byName := map[string]protoreflect.MethodDescriptor{}
	for name, r := range rules {
		if r.Class != ClassRead && r.Class != ClassWrite && r.Class != ClassAdmin {
			continue
		}
		md := methodDescriptor(name)
		if md == nil || md.IsStreamingClient() || md.IsStreamingServer() {
			continue
		}
		svc, ok := consoleServices[md.Parent().FullName()]
		if !ok {
			continue
		}
		byName[name] = md
		list = append(list, ConsoleMethod{Method: name, Service: svc, Name: string(md.Name()), Class: r.Class.String()})
	}
	slices.SortFunc(list, func(a, b ConsoleMethod) int {
		return cmp.Or(cmp.Compare(a.Service, b.Service), cmp.Compare(a.Name, b.Name))
	})
	return list, byName
}

// ConsoleMethods returns the console allowlist, sorted by service and name.
func ConsoleMethods() []ConsoleMethod {
	return slices.Clone(consoleMethods)
}

// ConsoleDescriptor returns the descriptor of an allowlisted console method.
func ConsoleDescriptor(fullMethod string) (protoreflect.MethodDescriptor, bool) {
	md, ok := consoleByName[fullMethod]
	return md, ok
}
