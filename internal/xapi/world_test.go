package xapi_test

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	namespacepb "go.temporal.io/api/namespace/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"tempolens/internal/config"
	"tempolens/internal/testutil"
)

// world is an in-memory Temporal: visibility with keyset paging (like SQL
// visibility), histories, describe results and namespace listings.
type world struct {
	mu         sync.Mutex
	namespaces []string
	execs      map[string][]*workflowpb.WorkflowExecutionInfo
	histories  map[string][]*historypb.HistoryEvent
	pending    map[string][]*workflowpb.PendingActivityInfo
	failNS     map[string]bool
	delay      time.Duration
	historyReq []*workflowservice.GetWorkflowExecutionHistoryRequest
	pageSize   int    // history page size
	store      string // GetClusterInfo visibilityStore
}

var base = time.Date(2026, 10, 27, 8, 0, 0, 0, time.UTC)

func newWorld(namespaces ...string) *world {
	return &world{
		namespaces: namespaces,
		execs:      map[string][]*workflowpb.WorkflowExecutionInfo{},
		histories:  map[string][]*historypb.HistoryEvent{},
		pending:    map[string][]*workflowpb.PendingActivityInfo{},
		failNS:     map[string]bool{},
		pageSize:   3,
		store:      "postgres12",
	}
}

type wfSpec struct {
	ns, wf, run, typ    string
	start, close        int // minutes after base; close < 0 means running
	status              enumspb.WorkflowExecutionStatus
	parentWF, parentRun string
	rootWF, rootRun     string
}

func (w *world) add(s wfSpec) *workflowpb.WorkflowExecutionInfo {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s.typ == "" {
		s.typ = "SeedWorkflow"
	}
	info := &workflowpb.WorkflowExecutionInfo{
		Execution: &commonpb.WorkflowExecution{WorkflowId: s.wf, RunId: s.run},
		Type:      &commonpb.WorkflowType{Name: s.typ},
		StartTime: timestamppb.New(base.Add(time.Duration(s.start) * time.Minute)),
		Status:    s.status,
	}
	if s.status == enumspb.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED {
		info.Status = enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED
		if s.close < 0 {
			info.Status = enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING
		}
	}
	if s.close >= 0 {
		info.CloseTime = timestamppb.New(base.Add(time.Duration(s.close) * time.Minute))
	}
	if s.parentWF != "" {
		info.ParentExecution = &commonpb.WorkflowExecution{WorkflowId: s.parentWF, RunId: s.parentRun}
	}
	if s.rootWF != "" {
		info.RootExecution = &commonpb.WorkflowExecution{WorkflowId: s.rootWF, RunId: s.rootRun}
	} else {
		info.RootExecution = &commonpb.WorkflowExecution{WorkflowId: s.wf, RunId: s.run}
	}
	w.execs[s.ns] = append(w.execs[s.ns], info)
	return info
}

func hkey(ns, wf, run string) string { return ns + "|" + wf + "|" + run }

func (w *world) setHistory(ns, wf, run string, events ...*historypb.HistoryEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for i, e := range events {
		e.EventId = int64(i + 1)
		if e.EventTime == nil {
			e.EventTime = timestamppb.New(base.Add(time.Duration(i) * time.Second))
		}
	}
	w.histories[hkey(ns, wf, run)] = events
}

// SQL visibility order: running first, close desc, start desc, run asc.
func less(a, b *workflowpb.WorkflowExecutionInfo) bool {
	ac, bc := closeOf(a), closeOf(b)
	if ac != bc {
		return ac > bc
	}
	as, bs := a.GetStartTime().AsTime(), b.GetStartTime().AsTime()
	if !as.Equal(bs) {
		return as.After(bs)
	}
	return a.GetExecution().GetRunId() < b.GetExecution().GetRunId()
}

func closeOf(i *workflowpb.WorkflowExecutionInfo) int64 {
	if i.GetCloseTime() == nil {
		return 1<<63 - 1
	}
	return i.GetCloseTime().AsTime().UnixNano()
}

var statusNames = map[enumspb.WorkflowExecutionStatus]string{
	enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING:          "Running",
	enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED:        "Completed",
	enumspb.WORKFLOW_EXECUTION_STATUS_FAILED:           "Failed",
	enumspb.WORKFLOW_EXECUTION_STATUS_TERMINATED:       "Terminated",
	enumspb.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW: "ContinuedAsNew",
}

// matches evaluates the conjunctions the server builds: Field="value" terms
// joined by AND, with optional parentheses.
func matches(info *workflowpb.WorkflowExecutionInfo, query string) bool {
	query, _, _ = strings.Cut(query, "GROUP BY")
	query = strings.NewReplacer("(", "", ")", "").Replace(query)
	for _, term := range strings.Split(query, " AND ") {
		term = strings.TrimSpace(term)
		if term == "" {
			continue
		}
		field, val, ok := strings.Cut(term, "=")
		if !ok {
			panic("unsupported query term: " + term)
		}
		val = strings.Trim(val, `"`)
		var got string
		switch field {
		case "ExecutionStatus":
			got = statusNames[info.GetStatus()]
		case "WorkflowId":
			got = info.GetExecution().GetWorkflowId()
		case "WorkflowType":
			got = info.GetType().GetName()
		case "ParentWorkflowId":
			got = info.GetParentExecution().GetWorkflowId()
		case "ParentRunId":
			got = info.GetParentExecution().GetRunId()
		case "RootWorkflowId":
			got = info.GetRootExecution().GetWorkflowId()
		case "RootRunId":
			got = info.GetRootExecution().GetRunId()
		default:
			panic("unsupported query field: " + field)
		}
		if got != val {
			return false
		}
	}
	return true
}

type cursor struct {
	Close int64  `json:"c"`
	Start int64  `json:"s"`
	Run   string `json:"r"`
}

func (w *world) list(req *workflowservice.ListWorkflowExecutionsRequest) (*workflowservice.ListWorkflowExecutionsResponse, error) {
	if w.failNS[req.GetNamespace()] {
		return nil, status.Error(codes.Unavailable, "namespace backend down")
	}
	var rows []*workflowpb.WorkflowExecutionInfo
	for _, info := range w.execs[req.GetNamespace()] {
		if matches(info, req.GetQuery()) {
			rows = append(rows, info)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return less(rows[i], rows[j]) })
	if tok := req.GetNextPageToken(); len(tok) > 0 {
		var c cursor
		_ = json.Unmarshal(tok, &c)
		probe := &workflowpb.WorkflowExecutionInfo{
			Execution: &commonpb.WorkflowExecution{RunId: c.Run},
			StartTime: timestamppb.New(time.Unix(0, c.Start)),
		}
		if c.Close != 1<<63-1 {
			probe.CloseTime = timestamppb.New(time.Unix(0, c.Close))
		}
		i := sort.Search(len(rows), func(i int) bool { return less(probe, rows[i]) })
		rows = rows[i:]
	}
	size := int(req.GetPageSize())
	if size <= 0 {
		size = 1000
	}
	resp := &workflowservice.ListWorkflowExecutionsResponse{}
	if len(rows) > size {
		last := rows[size-1]
		tok, _ := json.Marshal(cursor{Close: closeOf(last), Start: last.GetStartTime().AsTime().UnixNano(), Run: last.GetExecution().GetRunId()})
		resp.NextPageToken = tok
		rows = rows[:size]
	}
	resp.Executions = rows
	return resp, nil
}

func (w *world) respond(ctx context.Context, method string, req any) (any, error, bool) {
	if w.delay > 0 {
		select {
		case <-time.After(w.delay):
		case <-ctx.Done():
			return nil, status.Error(codes.DeadlineExceeded, "slow"), true
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	switch r := req.(type) {
	case *workflowservice.ListNamespacesRequest:
		resp := &workflowservice.ListNamespacesResponse{}
		for _, n := range append([]string{"temporal-system"}, w.namespaces...) {
			resp.Namespaces = append(resp.Namespaces, &workflowservice.DescribeNamespaceResponse{
				NamespaceInfo: &namespacepb.NamespaceInfo{Name: n, Id: "id-" + n, State: enumspb.NAMESPACE_STATE_REGISTERED},
			})
		}
		return resp, nil, true
	case *workflowservice.GetClusterInfoRequest:
		return &workflowservice.GetClusterInfoResponse{VisibilityStore: w.store}, nil, true
	case *workflowservice.ListWorkflowExecutionsRequest:
		resp, err := w.list(r)
		return resp, err, true
	case *workflowservice.CountWorkflowExecutionsRequest:
		if w.failNS[r.GetNamespace()] {
			return nil, status.Error(codes.Unavailable, "namespace backend down"), true
		}
		counts := map[string]int64{}
		var total int64
		for _, info := range w.execs[r.GetNamespace()] {
			if matches(info, r.GetQuery()) {
				counts[statusNames[info.GetStatus()]]++
				total++
			}
		}
		resp := &workflowservice.CountWorkflowExecutionsResponse{Count: total}
		for s, n := range counts {
			data, _ := json.Marshal(s)
			resp.Groups = append(resp.Groups, &workflowservice.CountWorkflowExecutionsResponse_AggregationGroup{
				GroupValues: []*commonpb.Payload{{Data: data}}, Count: n,
			})
		}
		return resp, nil, true
	case *workflowservice.DescribeWorkflowExecutionRequest:
		for _, info := range w.execs[r.GetNamespace()] {
			e := info.GetExecution()
			if e.GetWorkflowId() == r.GetExecution().GetWorkflowId() && (r.GetExecution().GetRunId() == "" || e.GetRunId() == r.GetExecution().GetRunId()) {
				return &workflowservice.DescribeWorkflowExecutionResponse{
					WorkflowExecutionInfo: info,
					PendingActivities:     w.pending[hkey(r.GetNamespace(), e.GetWorkflowId(), e.GetRunId())],
				}, nil, true
			}
		}
		return nil, status.Error(codes.NotFound, "workflow not found"), true
	case *workflowservice.GetWorkflowExecutionHistoryRequest:
		w.historyReq = append(w.historyReq, r)
		events, ok := w.histories[hkey(r.GetNamespace(), r.GetExecution().GetWorkflowId(), r.GetExecution().GetRunId())]
		if !ok {
			return nil, status.Error(codes.NotFound, "history not found"), true
		}
		if r.GetHistoryEventFilterType() == enumspb.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT {
			last := events[len(events)-1]
			switch last.GetEventType() {
			case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED, enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
				enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT, enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED,
				enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED, enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW:
				events = events[len(events)-1:]
			default:
				events = nil
			}
		}
		from := 0
		if tok := r.GetNextPageToken(); len(tok) > 0 {
			from, _ = strconv.Atoi(string(tok))
		}
		to := min(from+w.pageSize, len(events))
		resp := &workflowservice.GetWorkflowExecutionHistoryResponse{History: &historypb.History{Events: events[from:to]}}
		if to < len(events) {
			resp.NextPageToken = []byte(strconv.Itoa(to))
		}
		return resp, nil, true
	}
	return nil, nil, false
}

// newEnv starts a full server whose fake Temporal is backed by w.
func newEnv(t *testing.T, w *world, mutate func(*config.Config)) *testutil.Env {
	t.Helper()
	cfg := testutil.AuthConfig(t)
	cfg.Limits.XAPIRPS = 1000
	if mutate != nil {
		mutate(cfg)
	}
	env := testutil.NewEnv(t, cfg)
	env.Fake.SetResponder(w.respond)
	return env
}

// Event constructors.

func started(prevRun, origRun string) *historypb.HistoryEvent {
	return &historypb.HistoryEvent{
		EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
		Attributes: &historypb.HistoryEvent_WorkflowExecutionStartedEventAttributes{WorkflowExecutionStartedEventAttributes: &historypb.WorkflowExecutionStartedEventAttributes{
			ContinuedExecutionRunId: prevRun, OriginalExecutionRunId: origRun,
		}},
	}
}

func plainEvent(t enumspb.EventType) *historypb.HistoryEvent {
	return &historypb.HistoryEvent{EventType: t}
}

func completed() *historypb.HistoryEvent {
	return plainEvent(enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED)
}
