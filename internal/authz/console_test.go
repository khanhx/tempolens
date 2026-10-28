package authz

import (
	"testing"
)

// TestConsoleAllowlistFollowsPolicy: the console offers exactly the unary
// WorkflowService and OperatorService RPCs classed READ, WRITE or ADMIN.
func TestConsoleAllowlistFollowsPolicy(t *testing.T) {
	listed := map[string]ConsoleMethod{}
	for _, m := range ConsoleMethods() {
		listed[m.Method] = m
	}
	for name, md := range allMethods() {
		r, _ := Lookup(name)
		svc, inService := consoleServices[md.Parent().FullName()]
		want := inService && !md.IsStreamingClient() && !md.IsStreamingServer() &&
			(r.Class == ClassRead || r.Class == ClassWrite || r.Class == ClassAdmin)
		m, got := listed[name]
		if got != want {
			t.Errorf("%s (class %s): listed=%v, want %v", name, r.Class, got, want)
			continue
		}
		if !got {
			if _, ok := ConsoleDescriptor(name); ok {
				t.Errorf("%s has a console descriptor but is not listed", name)
			}
			continue
		}
		if m.Class != r.Class.String() || m.Service != svc || m.Name != string(md.Name()) {
			t.Errorf("%s: listed as %+v", name, m)
		}
		if d, ok := ConsoleDescriptor(name); !ok || d.FullName() != md.FullName() {
			t.Errorf("%s: descriptor %v, %v", name, d, ok)
		}
	}
	for _, name := range []string{
		wfPrefix + "PollWorkflowTaskQueue", wfPrefix + "ExecuteMultiOperation", opPrefix + "AddOrUpdateRemoteCluster",
		healthPrefix + "Check", wfPrefix + "NoSuchMethod", "",
	} {
		if _, ok := ConsoleDescriptor(name); ok {
			t.Errorf("%q must not be in the console allowlist", name)
		}
	}
	for name, class := range map[string]string{
		wfPrefix + "DescribeNamespace":          "READ",
		wfPrefix + "TerminateWorkflowExecution": "WRITE",
		opPrefix + "DeleteNamespace":            "ADMIN",
		opPrefix + "ListSearchAttributes":       "READ",
	} {
		if listed[name].Class != class {
			t.Errorf("%s: class %q, want %s", name, listed[name].Class, class)
		}
	}
}

func TestConsoleMethodsSortedAndCopied(t *testing.T) {
	a := ConsoleMethods()
	for i := 1; i < len(a); i++ {
		p, c := a[i-1], a[i]
		if p.Service > c.Service || (p.Service == c.Service && p.Name >= c.Name) {
			t.Fatalf("not sorted at %d: %s/%s then %s/%s", i, p.Service, p.Name, c.Service, c.Name)
		}
	}
	a[0].Class = "BLOCK"
	if ConsoleMethods()[0].Class == "BLOCK" {
		t.Fatal("ConsoleMethods returned the shared slice")
	}
}
