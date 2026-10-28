package xapi_test

import (
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	failurepb "go.temporal.io/api/failure/v1"
	historypb "go.temporal.io/api/history/v1"
	workflowpb "go.temporal.io/api/workflow/v1"

	"tempolens/internal/config"
	"tempolens/internal/testutil"
)

type scanResp struct {
	Matches []struct {
		Namespace  string `json:"namespace"`
		WorkflowID string `json:"workflowId"`
		Status     string `json:"status"`
		Hits       []struct {
			EventID    string `json:"eventId"`
			ActivityID string `json:"activityId"`
			Attempt    int    `json:"attempt"`
			Detail     string `json:"detail"`
		} `json:"hits"`
	} `json:"matches"`
	Candidates     int      `json:"candidates"`
	Scanned        int      `json:"scanned"`
	Partial        bool     `json:"partial"`
	PartialReasons []string `json:"partialReasons"`
}

// scanWorld has running workflows with pending activities and closed ones
// with histories.
func scanWorld() *world {
	w := newWorld("ns-a", "ns-b")
	for i := 0; i < 4; i++ {
		ns := []string{"ns-a", "ns-b"}[i%2]
		wf := fmt.Sprintf("run-%d", i)
		w.add(wfSpec{ns: ns, wf: wf, run: "r" + wf, start: i, close: -1})
		w.pending[hkey(ns, wf, "r"+wf)] = []*workflowpb.PendingActivityInfo{{
			ActivityId: "5", ActivityType: &commonpb.ActivityType{Name: "AlwaysFail"}, Attempt: int32(i + 1),
			LastFailure: &failurepb.Failure{Message: "boom"},
		}}
	}
	failed := &historypb.HistoryEvent{
		EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
		Attributes: &historypb.HistoryEvent_WorkflowExecutionFailedEventAttributes{WorkflowExecutionFailedEventAttributes: &historypb.WorkflowExecutionFailedEventAttributes{
			Failure: &failurepb.Failure{Message: "outer", Cause: &failurepb.Failure{Message: "Disk QUOTA exceeded"}},
		}},
	}
	scheduled := &historypb.HistoryEvent{
		EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
		Attributes: &historypb.HistoryEvent_ActivityTaskScheduledEventAttributes{ActivityTaskScheduledEventAttributes: &historypb.ActivityTaskScheduledEventAttributes{
			ActivityId: "7", ActivityType: &commonpb.ActivityType{Name: "Charge"},
		}},
	}
	w.add(wfSpec{ns: "ns-a", wf: "closed-1", run: "c1", start: 10, close: 20, status: enumspb.WORKFLOW_EXECUTION_STATUS_FAILED})
	w.setHistory("ns-a", "closed-1", "c1", started("", "c1"), plainEvent(enumspb.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED),
		scheduled, plainEvent(enumspb.EVENT_TYPE_ACTIVITY_TASK_STARTED), failed)
	w.add(wfSpec{ns: "ns-b", wf: "closed-2", run: "c2", start: 11, close: 21})
	w.setHistory("ns-b", "closed-2", "c2", started("", "c2"), completed())
	return w
}

func TestSearchActivityPending(t *testing.T) {
	env := newEnv(t, scanWorld(), nil)
	var resp scanResp
	path := "/api/x/search/activity?namespaces=*&activityType=AlwaysFail&mode=pending&minAttempt=3"
	if code := getJSON(t, env, testutil.Reader, path, &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if resp.Candidates != 4 || resp.Scanned != 4 || resp.Partial || len(resp.Matches) != 2 {
		t.Fatalf("resp = %+v", resp)
	}
	for _, m := range resp.Matches {
		if m.Hits[0].Attempt < 3 || m.Hits[0].ActivityID != "5" || m.Status != "WORKFLOW_EXECUTION_STATUS_RUNNING" {
			t.Fatalf("match = %+v", m)
		}
	}
	// The running clause was appended to the user query, wrapped.
	for _, c := range env.Fake.Calls() {
		if q, ok := c.Req.(interface{ GetQuery() string }); ok && c.Method == "/temporal.api.workflowservice.v1.WorkflowService/ListWorkflowExecutions" {
			if q.GetQuery() != `ExecutionStatus="Running"` {
				t.Fatalf("query = %q", q.GetQuery())
			}
		}
	}
}

func TestSearchActivityHistory(t *testing.T) {
	env := newEnv(t, scanWorld(), nil)
	var resp scanResp
	path := "/api/x/search/activity?namespaces=ns-a&activityType=Charge&mode=history&query=" + url.QueryEscape(`WorkflowId="closed-1"`)
	if code := getJSON(t, env, testutil.Reader, path, &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(resp.Matches) != 1 || resp.Matches[0].Hits[0].EventID != "3" || resp.Matches[0].Hits[0].ActivityID != "7" {
		t.Fatalf("resp = %+v", resp)
	}
	if code := getJSON(t, env, testutil.Reader, "/api/x/search/activity?namespaces=ns-a&activityType=X&mode=history&minAttempt=2", nil); code != http.StatusBadRequest {
		t.Fatalf("minAttempt with history: %d, want 400", code)
	}
	if code := getJSON(t, env, testutil.Reader, "/api/x/search/activity?namespaces=ns-a", nil); code != http.StatusBadRequest {
		t.Fatalf("missing activityType: %d, want 400", code)
	}
}

func TestSearchEvent(t *testing.T) {
	w := scanWorld()
	env := newEnv(t, w, nil)
	var resp scanResp
	q := url.QueryEscape(`ExecutionStatus="Failed"`)
	path := "/api/x/search/event?namespaces=*&eventType=EVENT_TYPE_WORKFLOW_EXECUTION_FAILED&failureText=quota&query=" + q
	if code := getJSON(t, env, testutil.Reader, path, &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(resp.Matches) != 1 || resp.Matches[0].Hits[0].Detail != "Disk QUOTA exceeded" {
		t.Fatalf("resp = %+v", resp)
	}
	w.mu.Lock()
	reqs := w.historyReq
	w.mu.Unlock()
	if len(reqs) == 0 || reqs[0].GetHistoryEventFilterType() != enumspb.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT {
		t.Fatalf("close event type must read only the close event: %v", reqs)
	}

	for name, p := range map[string]string{
		"no criteria":   "/api/x/search/event?namespaces=*",
		"bad eventType": "/api/x/search/event?namespaces=*&eventType=FAILED",
	} {
		if code := getJSON(t, env, testutil.Reader, p, nil); code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", name, code)
		}
	}
}

func TestScanCap(t *testing.T) {
	env := newEnv(t, scanWorld(), nil)
	var resp scanResp
	getJSON(t, env, testutil.Reader, "/api/x/search/activity?namespaces=*&activityType=AlwaysFail&max=3", &resp)
	if resp.Candidates != 3 || !resp.Partial || len(resp.PartialReasons) != 1 || resp.PartialReasons[0] != "cap" {
		t.Fatalf("resp = %+v", resp)
	}
	// max above the configured cap is clamped, not rejected.
	env = newEnv(t, scanWorld(), func(c *config.Config) { c.Limits.ScanMaxWorkflows = 2 })
	getJSON(t, env, testutil.Reader, "/api/x/search/activity?namespaces=*&activityType=AlwaysFail&max=5000", &resp)
	if resp.Candidates != 2 || resp.PartialReasons[0] != "cap" {
		t.Fatalf("clamped scan = %+v", resp)
	}
	if code := getJSON(t, env, testutil.Reader, "/api/x/search/activity?namespaces=*&activityType=A&max=0", nil); code != http.StatusBadRequest {
		t.Fatalf("max=0: %d, want 400", code)
	}
}

func TestScanHistoryCap(t *testing.T) {
	w := newWorld("ns-a")
	w.pageSize = 1000
	w.add(wfSpec{ns: "ns-a", wf: "long", run: "l1", start: 1, close: 2})
	events := []*historypb.HistoryEvent{started("", "l1")}
	for i := 0; i < 10001; i++ {
		events = append(events, plainEvent(enumspb.EVENT_TYPE_TIMER_STARTED))
	}
	w.setHistory("ns-a", "long", "l1", events...)
	env := newEnv(t, w, nil)

	// A history over 10,000 events stops the read: partial cap, no match.
	var resp scanResp
	getJSON(t, env, testutil.Reader, "/api/x/search/event?namespaces=*&eventType=EVENT_TYPE_ACTIVITY_TASK_SCHEDULED", &resp)
	if !resp.Partial || resp.PartialReasons[0] != "cap" || len(resp.Matches) != 0 || resp.Scanned != 1 {
		t.Fatalf("history cap: %+v", resp)
	}

	// Hits stop at 20 per workflow, also reported as cap.
	resp = scanResp{}
	getJSON(t, env, testutil.Reader, "/api/x/search/event?namespaces=*&eventType=EVENT_TYPE_TIMER_STARTED", &resp)
	if !resp.Partial || resp.PartialReasons[0] != "cap" || len(resp.Matches) != 1 || len(resp.Matches[0].Hits) != 20 {
		t.Fatalf("per-workflow hit cap: partial=%v reasons=%v hits=%d", resp.Partial, resp.PartialReasons, len(resp.Matches[0].Hits))
	}
}

// TestScanResponseHitCap: 300 workflows x 20 hits exceeds the 5,000-hit
// response cap.
func TestScanResponseHitCap(t *testing.T) {
	w := newWorld("ns-a")
	w.pageSize = 1000
	for i := 0; i < 300; i++ {
		wf, run := fmt.Sprintf("busy-%03d", i), fmt.Sprintf("b%03d", i)
		w.add(wfSpec{ns: "ns-a", wf: wf, run: run, start: i, close: i + 1})
		events := []*historypb.HistoryEvent{started("", run)}
		for j := 0; j < 20; j++ {
			events = append(events, plainEvent(enumspb.EVENT_TYPE_TIMER_STARTED))
		}
		w.setHistory("ns-a", wf, run, events...)
	}
	env := newEnv(t, w, func(c *config.Config) { c.Limits.ScanMaxWorkflows = 300 })
	var resp scanResp
	getJSON(t, env, testutil.Reader, "/api/x/search/event?namespaces=*&eventType=EVENT_TYPE_TIMER_STARTED&max=300", &resp)
	total := 0
	for _, m := range resp.Matches {
		total += len(m.Hits)
	}
	if total != 5000 || !resp.Partial || resp.PartialReasons[0] != "cap" || resp.Candidates != 300 {
		t.Fatalf("total hits %d, partial=%v reasons=%v candidates=%d", total, resp.Partial, resp.PartialReasons, resp.Candidates)
	}
}

func TestScanTimeout(t *testing.T) {
	w := scanWorld()
	env := newEnv(t, w, func(c *config.Config) { c.Limits.ScanTimeout = 150 * time.Millisecond })
	w.delay = 100 * time.Millisecond
	var resp scanResp
	start := time.Now()
	if code := getJSON(t, env, testutil.Reader, "/api/x/search/activity?namespaces=*&activityType=AlwaysFail", &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if !resp.Partial || resp.PartialReasons[len(resp.PartialReasons)-1] != "timeout" {
		t.Fatalf("resp = %+v", resp)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("the scan did not stop at its deadline")
	}
}

func TestScanInflightLimit(t *testing.T) {
	w := scanWorld()
	env := newEnv(t, w, func(c *config.Config) { c.Limits.ScanMaxInflight = 2 })
	w.delay = 300 * time.Millisecond
	codes := make([]int, 3)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Stagger so two scans hold the slots when the third arrives.
			time.Sleep(time.Duration(i) * 50 * time.Millisecond)
			r := env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/x/search/activity?namespaces=ns-a&activityType=AlwaysFail", "")
			if i == 2 {
				r = env.NewRequest(t, testutil.Writer, http.MethodGet, "/api/x/search/event?namespaces=ns-a&eventType=EVENT_TYPE_TIMER_STARTED", "")
			}
			w := env.Do(r)
			codes[i] = w.Code
			if w.Code == http.StatusTooManyRequests && w.Header().Get("Retry-After") != "5" {
				t.Errorf("Retry-After = %q", w.Header().Get("Retry-After"))
			}
		}()
	}
	wg.Wait()
	if codes[0] != http.StatusOK || codes[1] != http.StatusOK || codes[2] != http.StatusTooManyRequests {
		t.Fatalf("codes = %v, want [200 200 429]", codes)
	}
}

func TestPerPrincipalRate(t *testing.T) {
	env := newEnv(t, scanWorld(), func(c *config.Config) { c.Limits.XAPIRPS = 1 })
	// Burst is 2x the rate.
	for i := 0; i < 2; i++ {
		if code := getJSON(t, env, testutil.Reader, "/api/x/me", nil); code != http.StatusOK {
			t.Fatalf("request %d: %d", i+1, code)
		}
	}
	w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/x/me", ""))
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("over the burst: %d", w.Code)
	}
	if code := getJSON(t, env, testutil.Writer, "/api/x/me", nil); code != http.StatusOK {
		t.Fatalf("another principal: %d, want 200", code)
	}
}
