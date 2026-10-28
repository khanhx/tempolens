package xapi_test

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"

	"tempolens/internal/config"
	"tempolens/internal/testutil"
)

type graphResp struct {
	Nodes []struct {
		ID           string `json:"id"`
		WorkflowID   string `json:"workflowId"`
		RunID        string `json:"runId"`
		WorkflowType string `json:"workflowType"`
		Status       string `json:"status"`
		Focus        bool   `json:"focus"`
		Root         bool   `json:"root"`
	} `json:"nodes"`
	Edges []struct {
		From    string `json:"from"`
		To      string `json:"to"`
		Kind    string `json:"kind"`
		EventID string `json:"eventId"`
	} `json:"edges"`
	Truncated bool     `json:"truncated"`
	Partial   bool     `json:"partial"`
	Notes     []string `json:"notes"`
}

// edges renders edges as "fromRun -kind-> toRun" for comparison.
func (g graphResp) edges() []string {
	run := map[string]string{}
	for _, n := range g.Nodes {
		run[n.ID] = n.RunID
	}
	var out []string
	for _, e := range g.Edges {
		out = append(out, run[e.From]+" -"+e.Kind+"-> "+run[e.To])
	}
	sort.Strings(out)
	return out
}

func (g graphResp) node(run string) (focus, root, found bool, status string) {
	for _, n := range g.Nodes {
		if n.RunID == run {
			return n.Focus, n.Root, true, n.Status
		}
	}
	return false, false, false, ""
}

func graphOf(t *testing.T, env *testutil.Env, ns, wf, run, extra string) graphResp {
	t.Helper()
	var g graphResp
	path := fmt.Sprintf("/api/x/graph?namespace=%s&workflowId=%s&runId=%s%s", ns, wf, run, extra)
	if code := getJSON(t, env, testutil.Reader, path, &g); code != http.StatusOK {
		t.Fatalf("%s: status %d", path, code)
	}
	return g
}

func ev(t enumspb.EventType, attrs any) *historypb.HistoryEvent {
	e := &historypb.HistoryEvent{EventType: t}
	switch a := attrs.(type) {
	case *historypb.WorkflowExecutionContinuedAsNewEventAttributes:
		e.Attributes = &historypb.HistoryEvent_WorkflowExecutionContinuedAsNewEventAttributes{WorkflowExecutionContinuedAsNewEventAttributes: a}
	case *historypb.WorkflowTaskFailedEventAttributes:
		e.Attributes = &historypb.HistoryEvent_WorkflowTaskFailedEventAttributes{WorkflowTaskFailedEventAttributes: a}
	case *historypb.SignalExternalWorkflowExecutionInitiatedEventAttributes:
		e.Attributes = &historypb.HistoryEvent_SignalExternalWorkflowExecutionInitiatedEventAttributes{SignalExternalWorkflowExecutionInitiatedEventAttributes: a}
	case *historypb.WorkflowExecutionSignaledEventAttributes:
		e.Attributes = &historypb.HistoryEvent_WorkflowExecutionSignaledEventAttributes{WorkflowExecutionSignaledEventAttributes: a}
	case *historypb.ChildWorkflowExecutionStartedEventAttributes:
		e.Attributes = &historypb.HistoryEvent_ChildWorkflowExecutionStartedEventAttributes{ChildWorkflowExecutionStartedEventAttributes: a}
	}
	return e
}

func exec(wf, run string) *commonpb.WorkflowExecution {
	return &commonpb.WorkflowExecution{WorkflowId: wf, RunId: run}
}

func graphWorld() *world {
	w := newWorld("ns-a")
	add := func(s wfSpec) {
		s.ns = "ns-a"
		w.add(s)
		w.setHistory("ns-a", s.wf, s.run, started("", s.run), completed())
	}
	// Tree: root -> c1 -> g1, root -> c2.
	add(wfSpec{wf: "root", run: "r0", start: 0, close: 10})
	add(wfSpec{wf: "c1", run: "c1r", start: 1, close: 9, parentWF: "root", parentRun: "r0", rootWF: "root", rootRun: "r0"})
	add(wfSpec{wf: "c2", run: "c2r", start: 2, close: 8, parentWF: "root", parentRun: "r0", rootWF: "root", rootRun: "r0"})
	add(wfSpec{wf: "g1", run: "g1r", start: 3, close: 7, parentWF: "c1", parentRun: "c1r", rootWF: "root", rootRun: "r0"})
	w.setHistory("ns-a", "root", "r0", started("", "r0"),
		ev(enumspb.EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED, &historypb.ChildWorkflowExecutionStartedEventAttributes{InitiatedEventId: 1, WorkflowExecution: exec("c1", "c1r")}),
		completed())

	// Continue-as-new: can1 -> can2 -> can3.
	can := func(i int) string { return fmt.Sprintf("can%d", i) }
	for i := 1; i <= 3; i++ {
		w.add(wfSpec{ns: "ns-a", wf: "can", run: can(i), start: 20 + i, close: 21 + i, status: enumspb.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW})
	}
	w.setHistory("ns-a", "can", "can1", started("", "can1"), ev(enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW, &historypb.WorkflowExecutionContinuedAsNewEventAttributes{NewExecutionRunId: "can2"}))
	w.setHistory("ns-a", "can", "can2", started("can1", "can2"), ev(enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW, &historypb.WorkflowExecutionContinuedAsNewEventAttributes{NewExecutionRunId: "can3"}))
	w.setHistory("ns-a", "can", "can3", started("can2", "can3"), completed())

	// Reset: base rb, reset run rn.
	w.add(wfSpec{ns: "ns-a", wf: "reset", run: "rb", start: 30, close: 31})
	w.add(wfSpec{ns: "ns-a", wf: "reset", run: "rn", start: 32, close: 33})
	w.setHistory("ns-a", "reset", "rb", started("", "rb"), completed())
	w.setHistory("ns-a", "reset", "rn", started("", "rb"), plainEvent(enumspb.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED),
		ev(enumspb.EVENT_TYPE_WORKFLOW_TASK_FAILED, &historypb.WorkflowTaskFailedEventAttributes{
			Cause: enumspb.WORKFLOW_TASK_FAILED_CAUSE_RESET_WORKFLOW, BaseRunId: "rb", NewRunId: "rn"}),
		completed())
	// A reset of the reset run: rb -> rn -> rn2.
	w.add(wfSpec{ns: "ns-a", wf: "reset", run: "rn2", start: 34, close: 35})
	w.setHistory("ns-a", "reset", "rn2", started("", "rb"), plainEvent(enumspb.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED),
		ev(enumspb.EVENT_TYPE_WORKFLOW_TASK_FAILED, &historypb.WorkflowTaskFailedEventAttributes{
			Cause: enumspb.WORKFLOW_TASK_FAILED_CAUSE_RESET_WORKFLOW, BaseRunId: "rn", NewRunId: "rn2"}),
		completed())

	// Signal: sender s1 signals target t1.
	w.add(wfSpec{ns: "ns-a", wf: "sender", run: "s1", start: 40, close: 41})
	w.add(wfSpec{ns: "ns-a", wf: "target", run: "t1", start: 40, close: -1})
	w.setHistory("ns-a", "sender", "s1", started("", "s1"),
		ev(enumspb.EVENT_TYPE_SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED, &historypb.SignalExternalWorkflowExecutionInitiatedEventAttributes{
			Namespace: "ns-a", WorkflowExecution: exec("target", "t1"), SignalName: "go"}),
		completed())
	w.setHistory("ns-a", "target", "t1", started("", "t1"),
		ev(enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED, &historypb.WorkflowExecutionSignaledEventAttributes{
			SignalName: "go", ExternalWorkflowExecution: exec("sender", "s1")}),
		ev(enumspb.EVENT_TYPE_SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED, &historypb.SignalExternalWorkflowExecutionInitiatedEventAttributes{
			Namespace: "ns-a", WorkflowExecution: exec("third", "x1"), SignalName: "relay"}))
	w.add(wfSpec{ns: "ns-a", wf: "third", run: "x1", start: 42, close: -1})
	w.setHistory("ns-a", "third", "x1", started("", "x1"))
	return w
}

func equal(t *testing.T, what string, got, want []string) {
	t.Helper()
	sort.Strings(want)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("%s\n got: %q\nwant: %q", what, got, want)
	}
}

func TestGraphMidTreeChild(t *testing.T) {
	env := newEnv(t, graphWorld(), nil)
	g := graphOf(t, env, "ns-a", "c1", "c1r", "")
	equal(t, "edges", g.edges(), []string{"r0 -child-> c1r", "r0 -child-> c2r", "c1r -child-> g1r"})
	if focus, _, _, _ := g.node("c1r"); !focus {
		t.Fatal("c1r must be the focus")
	}
	if _, root, found, status := g.node("r0"); !found || !root || status != "WORKFLOW_EXECUTION_STATUS_COMPLETED" {
		t.Fatalf("root node: found=%v root=%v status=%s", found, root, status)
	}
	if g.Partial || g.Truncated {
		t.Fatalf("partial=%v truncated=%v notes=%v", g.Partial, g.Truncated, g.Notes)
	}

	// The tree does not depend on depth.
	g = graphOf(t, env, "ns-a", "c1", "c1r", "&depth=1")
	equal(t, "depth-1 edges", g.edges(), []string{"r0 -child-> c1r", "r0 -child-> c2r", "c1r -child-> g1r"})

	// From the root, the child edge to c1 carries the initiating event ID.
	g = graphOf(t, env, "ns-a", "root", "r0", "")
	for _, e := range g.Edges {
		if e.Kind == "child" && e.EventID == "" {
			var to string
			for _, n := range g.Nodes {
				if n.ID == e.To {
					to = n.RunID
				}
			}
			if to == "c1r" {
				t.Fatal("child edge from the focus lacks its eventId")
			}
		}
	}
}

func TestGraphContinueAsNew(t *testing.T) {
	env := newEnv(t, graphWorld(), nil)
	g := graphOf(t, env, "ns-a", "can", "can2", "")
	equal(t, "edges", g.edges(), []string{"can1 -continuedAsNew-> can2", "can2 -continuedAsNew-> can3"})
	if _, _, found, status := g.node("can3"); !found || status != "WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW" {
		t.Fatalf("can3 node: found=%v status=%s", found, status)
	}
}

func TestGraphResetFromBaseRun(t *testing.T) {
	env := newEnv(t, graphWorld(), nil)
	g := graphOf(t, env, "ns-a", "reset", "rb", "")
	equal(t, "edges", g.edges(), []string{"rb -reset-> rn", "rn -reset-> rn2"})
	g = graphOf(t, env, "ns-a", "reset", "rn", "&depth=1")
	equal(t, "edges from the reset run", g.edges(), []string{"rb -reset-> rn", "rn -reset-> rn2"})
	// Depth bounds reset hops from the focus.
	g = graphOf(t, env, "ns-a", "reset", "rb", "&depth=1")
	equal(t, "depth-1 reset edges", g.edges(), []string{"rb -reset-> rn"})
	if !strings.Contains(strings.Join(g.Notes, " "), "reset lineage continues") {
		t.Fatalf("notes = %v", g.Notes)
	}
}

func TestGraphSignals(t *testing.T) {
	env := newEnv(t, graphWorld(), nil)
	g := graphOf(t, env, "ns-a", "sender", "s1", "&depth=1")
	equal(t, "outgoing", g.edges(), []string{"s1 -signal-> t1"})
	if g.Edges[0].EventID != "2" {
		t.Fatalf("signal eventId = %q, want 2", g.Edges[0].EventID)
	}
	// Depth 2 reads the partner's history: t1 relays to x1.
	g = graphOf(t, env, "ns-a", "sender", "s1", "&depth=2")
	equal(t, "two signal hops", g.edges(), []string{"s1 -signal-> t1", "t1 -signal-> x1"})
	g = graphOf(t, env, "ns-a", "target", "t1", "&depth=1")
	equal(t, "incoming", g.edges(), []string{"s1 -signal-> t1", "t1 -signal-> x1"})
}

// TestGraphWholeTreeFromGrandchild: the whole root tree is present at the
// default depth, including the parent's sibling.
func TestGraphWholeTreeFromGrandchild(t *testing.T) {
	env := newEnv(t, graphWorld(), nil)
	g := graphOf(t, env, "ns-a", "g1", "g1r", "")
	equal(t, "edges", g.edges(), []string{"r0 -child-> c1r", "r0 -child-> c2r", "c1r -child-> g1r"})
	if _, root, found, _ := g.node("c2r"); !found || root {
		t.Fatal("the parent's sibling c2r is missing at the default depth")
	}
	if _, root, _, _ := g.node("r0"); !root {
		t.Fatal("r0 must be flagged as the root")
	}
}

// TestGraphContinueAsNewDepth: the chain follows depth x 10 runs each way.
func TestGraphContinueAsNewDepth(t *testing.T) {
	w := newWorld("ns-a")
	const runs = 15
	run := func(i int) string { return fmt.Sprintf("long%02d", i) }
	for i := 1; i <= runs; i++ {
		w.add(wfSpec{ns: "ns-a", wf: "long", run: run(i), start: i, close: i + 1, status: enumspb.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW})
		prev := ""
		if i > 1 {
			prev = run(i - 1)
		}
		last := completed()
		if i < runs {
			last = ev(enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW, &historypb.WorkflowExecutionContinuedAsNewEventAttributes{NewExecutionRunId: run(i + 1)})
		}
		w.setHistory("ns-a", "long", run(i), started(prev, run(i)), last)
	}
	env := newEnv(t, w, nil)

	g := graphOf(t, env, "ns-a", "long", run(1), "&depth=1")
	if n := len(g.Edges); n != 10 || !strings.Contains(strings.Join(g.Notes, " "), "continues after") {
		t.Fatalf("depth 1 from the first run: %d edges (want 10), notes %v", n, g.Notes)
	}
	g = graphOf(t, env, "ns-a", "long", run(1), "&depth=2")
	if n := len(g.Edges); n != runs-1 || strings.Contains(strings.Join(g.Notes, " "), "continues") {
		t.Fatalf("depth 2 from the first run: %d edges (want %d), notes %v", n, runs-1, g.Notes)
	}
	// From the last run the walk goes backwards.
	g = graphOf(t, env, "ns-a", "long", run(runs), "&depth=1")
	if n := len(g.Edges); n != 10 || !strings.Contains(strings.Join(g.Notes, " "), "continues before") {
		t.Fatalf("depth 1 from the last run: %d edges (want 10), notes %v", n, g.Notes)
	}
}

func TestGraphBounds(t *testing.T) {
	w := graphWorld()
	for i := 0; i < 400; i++ {
		w.add(wfSpec{ns: "ns-a", wf: fmt.Sprintf("big-%03d", i), run: fmt.Sprintf("b%03d", i), start: 50, close: 60,
			parentWF: "root", parentRun: "r0", rootWF: "root", rootRun: "r0"})
	}
	env := newEnv(t, w, nil)
	g := graphOf(t, env, "ns-a", "root", "r0", "")
	if !g.Truncated || len(g.Nodes) > 300 {
		t.Fatalf("truncated=%v nodes=%d", g.Truncated, len(g.Nodes))
	}
	for _, p := range []string{
		"/api/x/graph?namespace=ns-a&workflowId=root&runId=r0&depth=4",
		"/api/x/graph?namespace=ns-a&workflowId=root&runId=r0&depth=0",
		"/api/x/graph?namespace=ns-a&workflowId=root",
	} {
		if code := getJSON(t, env, testutil.Reader, p, nil); code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", p, code)
		}
	}
	if code := getJSON(t, env, testutil.Reader, "/api/x/graph?namespace=ns-a&workflowId=nope&runId=x", nil); code != http.StatusNotFound {
		t.Errorf("unknown workflow: %d, want 404", code)
	}
}

// TestGraphInteractiveBrowsing: clicking through nodes faster than the
// general /api/x rate is allowed by the graph's own burst.
func TestGraphInteractiveBrowsing(t *testing.T) {
	env := newEnv(t, graphWorld(), func(c *config.Config) { c.Limits.XAPIRPS = 5 })
	for i := 0; i < 15; i++ {
		w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/x/graph?namespace=ns-a&workflowId=c1&runId=c1r", ""))
		if w.Code != http.StatusOK {
			t.Fatalf("click %d: %d", i+1, w.Code)
		}
	}
	// The general bucket is untouched by graph walks.
	if code := getJSON(t, env, testutil.Reader, "/api/x/me", nil); code != http.StatusOK {
		t.Fatalf("/api/x/me after browsing: %d", code)
	}
}

func graphAsync(env *testutil.Env, t *testing.T, who testutil.Who, out *int, wg *sync.WaitGroup) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		w := env.Do(env.NewRequest(t, who, http.MethodGet, "/api/x/graph?namespace=ns-a&workflowId=c1&runId=c1r", ""))
		*out = w.Code
		if w.Code == http.StatusTooManyRequests && w.Header().Get("Retry-After") != "1" {
			t.Errorf("Retry-After = %q, want 1", w.Header().Get("Retry-After"))
		}
	}()
}

// TestGraphWalkLimits: at most 2 concurrent walks per user; other users are
// unaffected; a full global pool is waited on briefly instead of failing.
func TestGraphWalkLimits(t *testing.T) {
	w := graphWorld()
	env := newEnv(t, w, func(c *config.Config) { c.Limits.ScanMaxInflight = 1 }) // global graph pool = 2
	w.delay = 150 * time.Millisecond

	var wg sync.WaitGroup
	codes := make([]int, 4)
	graphAsync(env, t, testutil.Reader, &codes[0], &wg)
	graphAsync(env, t, testutil.Reader, &codes[1], &wg)
	time.Sleep(50 * time.Millisecond)
	graphAsync(env, t, testutil.Reader, &codes[2], &wg) // third walk for the same user
	graphAsync(env, t, testutil.Writer, &codes[3], &wg) // another user, waits for a global slot
	wg.Wait()
	if codes[0] != http.StatusOK || codes[1] != http.StatusOK || codes[2] != http.StatusTooManyRequests || codes[3] != http.StatusOK {
		t.Fatalf("codes = %v, want [200 200 429 200]", codes)
	}
}

// TestGraphNotBlockedByScans: graph walks do not share the scan slots.
func TestGraphNotBlockedByScans(t *testing.T) {
	w := graphWorld()
	env := newEnv(t, w, func(c *config.Config) { c.Limits.ScanMaxInflight = 1 })
	w.delay = 100 * time.Millisecond
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		env.Do(env.NewRequest(t, testutil.Writer, http.MethodGet, "/api/x/search/event?namespaces=ns-a&eventType=EVENT_TYPE_TIMER_STARTED", ""))
	}()
	time.Sleep(30 * time.Millisecond)
	if code := getJSON(t, env, testutil.Reader, "/api/x/graph?namespace=ns-a&workflowId=c1&runId=c1r", nil); code != http.StatusOK {
		t.Fatalf("graph during a scan: %d, want 200", code)
	}
	wg.Wait()
}
