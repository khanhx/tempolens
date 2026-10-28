package xapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	graphDepthDefault = 2
	graphMaxNodes     = 300
	// graphTreeCap bounds the RootWorkflowId prefetch.
	graphTreeCap = 500
	// graphChildPage bounds one per-node children query.
	graphChildPage = 100
	// graphRunCap bounds the runs inspected for reset lineage.
	// canRunsPerDepth is how many continue-as-new runs each depth level
	// follows in each direction (30 at the maximum depth).
	canRunsPerDepth = 10
	graphRunCap     = 50
	// graphParentHops bounds the walk up to the root beyond the depth.
	graphParentHops = 10
)

// Edge kinds.
const (
	edgeChild         = "child"
	edgeContinued     = "continuedAsNew"
	edgeReset         = "reset"
	edgeSignal        = "signal"
	edgeCancelRequest = "cancelRequest"
)

type graphNode struct {
	ID           string  `json:"id"`
	Namespace    string  `json:"namespace"`
	WorkflowID   string  `json:"workflowId"`
	RunID        string  `json:"runId"`
	WorkflowType string  `json:"workflowType"`
	Status       string  `json:"status"`
	StartTime    *string `json:"startTime"`
	CloseTime    *string `json:"closeTime"`
	Focus        bool    `json:"focus"`
	Root         bool    `json:"root"`

	known  bool
	parent *runRef
}

type graphEdge struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Kind    string `json:"kind"`
	EventID string `json:"eventId,omitempty"`
}

type graphResponse struct {
	Nodes     []*graphNode `json:"nodes"`
	Edges     []*graphEdge `json:"edges"`
	Truncated bool         `json:"truncated"`
	Partial   bool         `json:"partial"`
	Notes     []string     `json:"notes"`
}

type runRef struct{ ns, wf, run string }

// graphBuilder accumulates nodes and edges under the node budget. It is
// safe for concurrent use.
type graphBuilder struct {
	h   *Handler
	ctx context.Context

	mu    sync.Mutex
	nodes map[runRef]*graphNode
	order []*graphNode
	edges map[[3]string]*graphEdge
	elist []*graphEdge
	resp  graphResponse
}

func (g *graphBuilder) node(ref runRef) *graphNode {
	g.mu.Lock()
	defer g.mu.Unlock()
	if n, ok := g.nodes[ref]; ok {
		return n
	}
	if len(g.order) >= graphMaxNodes {
		g.resp.Truncated = true
		return nil
	}
	n := &graphNode{
		ID: "n" + strconv.Itoa(len(g.order)), Namespace: ref.ns, WorkflowID: ref.wf, RunID: ref.run,
		Status: enumName(enumspb.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED),
	}
	g.nodes[ref] = n
	g.order = append(g.order, n)
	return n
}

// lookup returns an existing node without creating one.
func (g *graphBuilder) lookup(ref runRef) *graphNode {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.nodes[ref]
}

// withInfo adds (or fills) the node of a visibility or describe row.
func (g *graphBuilder) withInfo(ns string, info *workflowpb.WorkflowExecutionInfo) *graphNode {
	ref := runRef{ns, info.GetExecution().GetWorkflowId(), info.GetExecution().GetRunId()}
	n := g.node(ref)
	if n == nil {
		return nil
	}
	g.fill(n, ns, info)
	return n
}

func (g *graphBuilder) fill(n *graphNode, ns string, info *workflowpb.WorkflowExecutionInfo) {
	var parent *runRef
	if p := info.GetParentExecution(); p != nil && p.GetWorkflowId() != "" {
		// A parent in another namespace is named by ID; resolve it outside the lock.
		pns := ns
		if id := info.GetParentNamespaceId(); id != "" && id != g.h.namespaceID(g.ctx, ns) {
			if name, ok := g.h.namespaceName(g.ctx, id); ok {
				pns = name
			}
		}
		parent = &runRef{pns, p.GetWorkflowId(), p.GetRunId()}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	n.WorkflowType = info.GetType().GetName()
	n.Status = enumName(info.GetStatus())
	n.StartTime = timeString(info.GetStartTime())
	n.CloseTime = timeString(info.GetCloseTime())
	n.known = true
	n.parent = parent
}

func (g *graphBuilder) edge(from, to *graphNode, kind, eventID string) {
	if from == nil || to == nil || from == to {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	k := [3]string{from.ID, to.ID, kind}
	if e, ok := g.edges[k]; ok {
		if e.EventID == "" {
			e.EventID = eventID
		}
		return
	}
	e := &graphEdge{From: from.ID, To: to.ID, Kind: kind, EventID: eventID}
	g.edges[k] = e
	g.elist = append(g.elist, e)
}

// fail records a non-fatal RPC failure.
func (g *graphBuilder) fail(what string, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.resp.Partial = true
	if isTimeout(g.ctx, err) {
		g.addNote("timed out while reading " + what)
		return
	}
	g.addNote("could not read " + what + ": " + status.Convert(err).Message())
}

func (g *graphBuilder) note(msg string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.addNote(msg)
}

// addNote appends a de-duplicated note; the caller holds g.mu.
func (g *graphBuilder) addNote(msg string) {
	for _, n := range g.resp.Notes {
		if n == msg {
			return
		}
	}
	g.resp.Notes = append(g.resp.Notes, msg)
}

func (g *graphBuilder) describe(ref runRef) (*workflowpb.WorkflowExecutionInfo, error) {
	resp, err := g.h.wf.DescribeWorkflowExecution(g.ctx, &workflowservice.DescribeWorkflowExecutionRequest{
		Namespace: ref.ns, Execution: &commonpb.WorkflowExecution{WorkflowId: ref.wf, RunId: ref.run},
	})
	if err != nil {
		return nil, err
	}
	return resp.GetWorkflowExecutionInfo(), nil
}

func (g *graphBuilder) list(ns, query string, pageSize int, token []byte) (*workflowservice.ListWorkflowExecutionsResponse, error) {
	return g.h.wf.ListWorkflowExecutions(g.ctx, &workflowservice.ListWorkflowExecutionsRequest{
		Namespace: ns, Query: query, PageSize: int32(pageSize), NextPageToken: token,
	})
}

func (h *Handler) graph(w http.ResponseWriter, r *http.Request) {
	ns, err := requiredParam(r, "namespace")
	if err != nil {
		writeError(w, err)
		return
	}
	wfID, err := requiredParam(r, "workflowId")
	if err != nil {
		writeError(w, err)
		return
	}
	runID, err := requiredParam(r, "runId")
	if err != nil {
		writeError(w, err)
		return
	}
	depth, err := intParam(r, "depth", graphDepthDefault, 1, graphDepthMax)
	if err != nil {
		writeError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.cfg.Limits.ScanTimeout)
	defer cancel()
	g := &graphBuilder{h: h, ctx: ctx, nodes: map[runRef]*graphNode{}, edges: map[[3]string]*graphEdge{},
		resp: graphResponse{Notes: []string{}}}

	focusRef := runRef{ns, wfID, runID}
	info, err := g.describe(focusRef)
	if err != nil {
		writeError(w, err)
		return
	}
	focus := g.withInfo(ns, info)
	focus.Focus = true

	root := g.ancestors(focus, info.GetRootExecution(), depth)
	if root != nil {
		root.Root = true
	}
	g.tree(focus, root, depth)
	g.histories(focus, depth)
	g.resetLineage(focus, depth)
	g.fillUnknown()

	g.mu.Lock()
	defer g.mu.Unlock()
	if g.resp.Truncated {
		g.addNote("the graph was truncated at its node or tree budget")
	}
	resp := g.resp
	resp.Nodes = g.order
	resp.Edges = g.elist
	if resp.Edges == nil {
		resp.Edges = []*graphEdge{}
	}
	writeJSON(w, resp)
}

// ancestors walks parentExecution up to the root and returns the root node.
// The root reported by rootExecution is trusted; the walk links the path.
func (g *graphBuilder) ancestors(focus *graphNode, rootExec *commonpb.WorkflowExecution, depth int) *graphNode {
	cur := focus
	for hops := 0; cur.parent != nil && hops < depth+graphParentHops; hops++ {
		ref := *cur.parent
		parent := g.lookup(ref)
		if parent == nil || !parent.known {
			info, err := g.describe(ref)
			if err != nil {
				g.fail("parent "+ref.wf, err)
				parent = g.node(ref)
				g.edge(parent, cur, edgeChild, "")
				return nil
			}
			parent = g.withInfo(ref.ns, info)
		}
		if parent == nil {
			return nil
		}
		g.edge(parent, cur, edgeChild, "")
		cur = parent
	}
	if cur.parent == nil {
		return cur
	}
	if rootExec.GetWorkflowId() != "" {
		return g.node(runRef{cur.Namespace, rootExec.GetWorkflowId(), rootExec.GetRunId()})
	}
	return nil
}

// tree adds every member of the focus's parent/child tree. When the root
// is known, one RootWorkflowId query returns the whole tree (up to
// graphTreeCap members, then truncated), whatever the depth. Otherwise, or
// when that query is truncated, the tree is walked per node from the focus
// within depth hops, so the neighbourhood is always present.
func (g *graphBuilder) tree(focus, root *graphNode, depth int) {
	complete := false
	if root != nil && root.RunID != "" {
		complete = g.rootTree(root)
	}
	if complete {
		return
	}
	dist := map[*graphNode]int{focus: 0}
	frontier := []*graphNode{focus}
	for len(frontier) > 0 && g.ctx.Err() == nil {
		n := frontier[0]
		frontier = frontier[1:]
		d := dist[n]
		if d >= depth {
			continue
		}
		visit := func(m *graphNode) {
			if m == nil {
				return
			}
			if _, seen := dist[m]; !seen {
				dist[m] = d + 1
				frontier = append(frontier, m)
			}
		}
		if n.parent != nil {
			if p := g.lookup(*n.parent); p != nil {
				visit(p)
			}
		}
		query := "ParentWorkflowId=" + quote(n.WorkflowID) + " AND ParentRunId=" + quote(n.RunID)
		resp, err := g.list(n.Namespace, query, graphChildPage, nil)
		if err != nil {
			g.fail("children of "+n.WorkflowID, err)
			continue
		}
		if len(resp.GetNextPageToken()) > 0 {
			g.truncate()
		}
		for _, info := range resp.GetExecutions() {
			c := g.withInfo(n.Namespace, info)
			g.edge(n, c, edgeChild, "")
			visit(c)
		}
	}
	if g.ctx.Err() != nil {
		g.fail("the workflow tree", g.ctx.Err())
	}
}

// rootTree adds every member of the root's tree with its parent edge. It
// reports whether the whole tree was read.
func (g *graphBuilder) rootTree(root *graphNode) bool {
	query := "RootWorkflowId=" + quote(root.WorkflowID) + " AND RootRunId=" + quote(root.RunID)
	var members []*workflowpb.WorkflowExecutionInfo
	var token []byte
	complete := false
	for {
		resp, err := g.list(root.Namespace, query, min(graphTreeCap-len(members), 1000), token)
		if err != nil {
			g.fail("the workflow tree", err)
			return false
		}
		members = append(members, resp.GetExecutions()...)
		if token = resp.GetNextPageToken(); len(token) == 0 {
			complete = true
			break
		}
		if len(members) >= graphTreeCap {
			g.truncate()
			break
		}
	}
	// Nodes first, so every parent that is a member exists for its edges.
	for _, info := range members {
		g.withInfo(root.Namespace, info)
	}
	for _, info := range members {
		p := info.GetParentExecution()
		if p.GetWorkflowId() == "" {
			continue
		}
		child := g.lookup(runRef{root.Namespace, info.GetExecution().GetWorkflowId(), info.GetExecution().GetRunId()})
		parent := g.lookup(runRef{root.Namespace, p.GetWorkflowId(), p.GetRunId()})
		g.edge(parent, child, edgeChild, "")
	}
	return complete
}

func (g *graphBuilder) truncate() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.resp.Truncated = true
}

// runHistory reads one run's history once: it records child event IDs and
// signal or cancel edges, and returns the continue-as-new neighbours and the
// signal or cancel partners (with a run ID) for further expansion.
func (g *graphBuilder) runHistory(n *graphNode) (prevRun, nextRun, closeEventID string, partners []*graphNode) {
	exec := &commonpb.WorkflowExecution{WorkflowId: n.WorkflowID, RunId: n.RunID}
	partner := func(m *graphNode) {
		if m != nil && m.RunID != "" {
			partners = append(partners, m)
		}
	}
	err := g.h.eachEvent(g.ctx, n.Namespace, exec, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT, func(e *historypb.HistoryEvent) bool {
		id := strconv.FormatInt(e.GetEventId(), 10)
		switch {
		case e.GetWorkflowExecutionStartedEventAttributes() != nil:
			prevRun = e.GetWorkflowExecutionStartedEventAttributes().GetContinuedExecutionRunId()
		case e.GetWorkflowExecutionContinuedAsNewEventAttributes() != nil:
			nextRun, closeEventID = e.GetWorkflowExecutionContinuedAsNewEventAttributes().GetNewExecutionRunId(), id
		case e.GetChildWorkflowExecutionStartedEventAttributes() != nil:
			a := e.GetChildWorkflowExecutionStartedEventAttributes()
			child := g.node(runRef{nsOr(a.GetNamespace(), n.Namespace), a.GetWorkflowExecution().GetWorkflowId(), a.GetWorkflowExecution().GetRunId()})
			g.edge(n, child, edgeChild, strconv.FormatInt(a.GetInitiatedEventId(), 10))
		case e.GetSignalExternalWorkflowExecutionInitiatedEventAttributes() != nil:
			a := e.GetSignalExternalWorkflowExecutionInitiatedEventAttributes()
			t := g.external(nsOr(a.GetNamespace(), n.Namespace), a.GetWorkflowExecution())
			g.edge(n, t, edgeSignal, id)
			partner(t)
		case e.GetRequestCancelExternalWorkflowExecutionInitiatedEventAttributes() != nil:
			a := e.GetRequestCancelExternalWorkflowExecutionInitiatedEventAttributes()
			t := g.external(nsOr(a.GetNamespace(), n.Namespace), a.GetWorkflowExecution())
			g.edge(n, t, edgeCancelRequest, id)
			partner(t)
		case e.GetWorkflowExecutionSignaledEventAttributes().GetExternalWorkflowExecution() != nil:
			// The event does not name the sender's namespace; same namespace is assumed.
			src := g.external(n.Namespace, e.GetWorkflowExecutionSignaledEventAttributes().GetExternalWorkflowExecution())
			g.edge(src, n, edgeSignal, "")
			partner(src)
		case e.GetWorkflowExecutionCancelRequestedEventAttributes().GetExternalWorkflowExecution() != nil:
			src := g.external(n.Namespace, e.GetWorkflowExecutionCancelRequestedEventAttributes().GetExternalWorkflowExecution())
			g.edge(src, n, edgeCancelRequest, "")
			partner(src)
		}
		return true
	})
	if errors.Is(err, errHistoryCap) {
		g.mu.Lock()
		g.resp.Partial = true
		g.addNote("the history of " + n.WorkflowID + " exceeds " + strconv.Itoa(historyEventCap) + " events; later edges are missing")
		g.mu.Unlock()
	} else if err != nil {
		g.fail("the history of "+n.WorkflowID, err)
	}
	return prevRun, nextRun, closeEventID, partners
}

// histories reads the focus history, follows signal and cancel edges for up
// to depth hops (each hop reads the partners' histories), and walks the
// continue-as-new chain up to depth x canRunsPerDepth runs each way.
func (g *graphBuilder) histories(focus *graphNode, depth int) {
	prevRun, nextRun, closeEventID, partners := g.runHistory(focus)

	expanded := map[*graphNode]bool{focus: true}
	frontier := partners
	for hop := 2; hop <= depth && len(frontier) > 0 && g.ctx.Err() == nil; hop++ {
		var next []*graphNode
		for _, m := range frontier {
			if expanded[m] {
				continue
			}
			expanded[m] = true
			_, _, _, more := g.runHistory(m)
			next = append(next, more...)
		}
		frontier = next
	}

	// Backwards: each run's first event names the run it continued.
	cur := focus
	for i := 0; prevRun != "" && g.ctx.Err() == nil; i++ {
		if i == depth*canRunsPerDepth {
			g.note("the continue-as-new chain continues before the shown runs; increase depth to see more")
			break
		}
		prev := g.node(runRef{focus.Namespace, focus.WorkflowID, prevRun})
		g.edge(prev, cur, edgeContinued, "")
		if prev == nil {
			return
		}
		cur, prevRun = prev, ""
		_ = g.h.eachEvent(g.ctx, cur.Namespace, &commonpb.WorkflowExecution{WorkflowId: cur.WorkflowID, RunId: cur.RunID},
			enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT, func(e *historypb.HistoryEvent) bool {
				prevRun = e.GetWorkflowExecutionStartedEventAttributes().GetContinuedExecutionRunId()
				return false
			})
	}
	// Forwards: each run's close event names the next run.
	cur = focus
	for i := 0; nextRun != "" && g.ctx.Err() == nil; i++ {
		if i == depth*canRunsPerDepth {
			g.note("the continue-as-new chain continues after the shown runs; increase depth to see more")
			break
		}
		next := g.node(runRef{focus.Namespace, focus.WorkflowID, nextRun})
		g.edge(cur, next, edgeContinued, closeEventID)
		if next == nil {
			return
		}
		cur, nextRun, closeEventID = next, "", ""
		_ = g.h.eachEvent(g.ctx, cur.Namespace, &commonpb.WorkflowExecution{WorkflowId: cur.WorkflowID, RunId: cur.RunID},
			enumspb.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT, func(e *historypb.HistoryEvent) bool {
				if a := e.GetWorkflowExecutionContinuedAsNewEventAttributes(); a != nil {
					nextRun, closeEventID = a.GetNewExecutionRunId(), strconv.FormatInt(e.GetEventId(), 10)
				}
				return false
			})
	}
}

// external returns the node of a signal or cancel target or source. A
// target without a run ID stays unresolved (runId "").
func (g *graphBuilder) external(ns string, exec *commonpb.WorkflowExecution) *graphNode {
	if exec.GetWorkflowId() == "" {
		g.note("an external workflow reference without a workflow ID was skipped")
		return nil
	}
	return g.node(runRef{ns, exec.GetWorkflowId(), exec.GetRunId()})
}

// resetLineage lists the runs of the focus workflow ID and links each run
// created by a reset to its base run, keeping the links within depth reset
// hops of the focus. A run's first event tells whether it came from a reset
// (originalExecutionRunId differs from its run ID); only those runs are read
// up to their first WorkflowTaskFailed, whose RESET_WORKFLOW cause carries
// the base run ID.
func (g *graphBuilder) resetLineage(focus *graphNode, depth int) {
	resp, err := g.list(focus.Namespace, "WorkflowId="+quote(focus.WorkflowID), graphRunCap, nil)
	if err != nil {
		g.fail("the runs of "+focus.WorkflowID, err)
		return
	}
	if len(resp.GetNextPageToken()) > 0 {
		g.note("more than " + strconv.Itoa(graphRunCap) + " runs share this workflow ID; reset lineage is limited to the latest")
	}
	runs := resp.GetExecutions()
	infos := map[string]*workflowpb.WorkflowExecutionInfo{}
	for _, info := range runs {
		infos[info.GetExecution().GetRunId()] = info
	}

	bases := make([]string, len(runs))
	forEach(len(runs), g.h.cfg.Limits.ScanConcurrency, func(i int) {
		run := runs[i].GetExecution().GetRunId()
		exec := &commonpb.WorkflowExecution{WorkflowId: focus.WorkflowID, RunId: run}
		derived := false
		err := g.h.eachEvent(g.ctx, focus.Namespace, exec, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT, func(e *historypb.HistoryEvent) bool {
			orig := e.GetWorkflowExecutionStartedEventAttributes().GetOriginalExecutionRunId()
			derived = orig != "" && orig != run
			return false
		})
		if err != nil {
			g.fail("the first event of run "+run, err)
			return
		}
		if !derived {
			return
		}
		err = g.h.eachEvent(g.ctx, focus.Namespace, exec, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT, func(e *historypb.HistoryEvent) bool {
			a := e.GetWorkflowTaskFailedEventAttributes()
			if a == nil {
				return true
			}
			if a.GetCause() == enumspb.WORKFLOW_TASK_FAILED_CAUSE_RESET_WORKFLOW && a.GetBaseRunId() != "" {
				bases[i] = a.GetBaseRunId()
			}
			return false
		})
		if err != nil && !errors.Is(err, errHistoryCap) {
			g.fail("the reset point of run "+run, err)
		}
	})

	// Keep the links within depth reset hops of the focus run.
	adj := map[string][]string{}
	for i, base := range bases {
		if base != "" {
			run := runs[i].GetExecution().GetRunId()
			adj[base] = append(adj[base], run)
			adj[run] = append(adj[run], base)
		}
	}
	dist := map[string]int{focus.RunID: 0}
	queue := []string{focus.RunID}
	beyond := false
	for len(queue) > 0 {
		r := queue[0]
		queue = queue[1:]
		for _, o := range adj[r] {
			if _, seen := dist[o]; seen {
				continue
			}
			if dist[r] == depth {
				beyond = true
				continue
			}
			dist[o] = dist[r] + 1
			queue = append(queue, o)
		}
	}
	if beyond {
		g.note("the reset lineage continues beyond the shown runs; increase depth to see more")
	}
	for i, base := range bases {
		run := runs[i].GetExecution().GetRunId()
		_, okBase := dist[base]
		_, okRun := dist[run]
		if base == "" || !okBase || !okRun {
			continue
		}
		g.edge(g.node(runRef{focus.Namespace, focus.WorkflowID, base}), g.node(runRef{focus.Namespace, focus.WorkflowID, run}), edgeReset, "")
	}
	// Runs of this workflow ID carry their own info; use it for any node.
	for run, info := range infos {
		if n := g.lookup(runRef{focus.Namespace, focus.WorkflowID, run}); n != nil && !n.known {
			g.fill(n, focus.Namespace, info)
		}
	}
}

// fillUnknown describes nodes that are still missing type and status.
func (g *graphBuilder) fillUnknown() {
	var todo []*graphNode
	for _, n := range g.order {
		if !n.known && n.RunID != "" {
			todo = append(todo, n)
		}
	}
	forEach(len(todo), g.h.cfg.Limits.ScanConcurrency, func(i int) {
		n := todo[i]
		if g.ctx.Err() != nil {
			return
		}
		info, err := g.describe(runRef{n.Namespace, n.WorkflowID, n.RunID})
		switch {
		case err == nil:
			g.fill(n, n.Namespace, info)
		case status.Code(err) == codes.NotFound:
			g.note("workflow " + n.WorkflowID + " (" + n.RunID + ") was not found; it may be deleted or in another namespace")
		default:
			g.fail("workflow "+n.WorkflowID, err)
		}
	})
}

func nsOr(ns, def string) string {
	if ns == "" {
		return def
	}
	return ns
}
