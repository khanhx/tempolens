package xapi_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"tempolens/internal/config"
	"tempolens/internal/testutil"
)

type listResp struct {
	Executions []struct {
		Namespace string `json:"namespace"`
		Execution struct {
			Execution struct {
				WorkflowID string `json:"workflowId"`
				RunID      string `json:"runId"`
			} `json:"execution"`
			StartTime string `json:"startTime"`
			CloseTime string `json:"closeTime"`
			Status    string `json:"status"`
		} `json:"execution"`
	} `json:"executions"`
	NextPageToken string `json:"nextPageToken"`
	Errors        []struct {
		Namespace string `json:"namespace"`
		Code      int    `json:"code"`
	} `json:"errors"`
}

func getJSON(t *testing.T, env *testutil.Env, who testutil.Who, path string, out any) int {
	t.Helper()
	w := env.Do(env.NewRequest(t, who, http.MethodGet, path, ""))
	if w.Code == http.StatusOK && out != nil {
		if err := json.Unmarshal(w.Body.Bytes(), out); err != nil {
			t.Fatalf("%s: decode: %v\n%s", path, err, w.Body.String())
		}
	}
	return w.Code
}

// interleaved builds 3 namespaces with 10 rows each whose times interleave,
// plus one running row per namespace.
func interleaved() *world {
	w := newWorld("ns-a", "ns-b", "ns-c")
	for i, ns := range []string{"ns-a", "ns-b", "ns-c"} {
		for j := 0; j < 10; j++ {
			m := j*3 + i
			w.add(wfSpec{ns: ns, wf: fmt.Sprintf("%s-wf-%02d", ns, j), run: fmt.Sprintf("run-%s-%02d", ns, j), start: m, close: m + 100})
		}
		w.add(wfSpec{ns: ns, wf: ns + "-running", run: "run-" + ns + "-running", start: 500 + i, close: -1})
	}
	return w
}

// rowID identifies an emitted row.
func rowID(ns, run string) string { return ns + "/" + run }

func TestListGlobalOrderAndPaging(t *testing.T) {
	w := interleaved()
	env := newEnv(t, w, nil)

	var all []string
	var prevKey string
	token := ""
	for page := 0; page < 10; page++ {
		path := "/api/x/workflows?namespaces=*&pageSize=7"
		if token != "" {
			path += "&pageToken=" + url.QueryEscape(token)
		}
		var resp listResp
		if code := getJSON(t, env, testutil.Reader, path, &resp); code != http.StatusOK {
			t.Fatalf("page %d: status %d", page, code)
		}
		for _, e := range resp.Executions {
			// Running rows first, then close time desc: sortable as a string
			// once running rows map to a high key.
			key := e.Execution.CloseTime
			if key == "" {
				key = "9999"
			}
			key += "|" + e.Execution.StartTime
			if prevKey != "" && key > prevKey {
				t.Fatalf("out of order: %s after %s", key, prevKey)
			}
			prevKey = key
			all = append(all, rowID(e.Namespace, e.Execution.Execution.RunID))
		}
		token = resp.NextPageToken
		if token == "" {
			break
		}
	}
	if len(all) != 33 {
		t.Fatalf("emitted %d rows over all pages, want 33", len(all))
	}
	seen := map[string]bool{}
	for _, id := range all {
		if seen[id] {
			t.Fatalf("duplicate row %s", id)
		}
		seen[id] = true
	}
	// Running rows lead.
	for i := 0; i < 3; i++ {
		if !strings.HasSuffix(all[i], "-running") {
			t.Fatalf("row %d is %s, want a running row first", i, all[i])
		}
	}
}

func TestListNewRowBetweenPages(t *testing.T) {
	w := interleaved()
	env := newEnv(t, w, nil)

	var p1 listResp
	getJSON(t, env, testutil.Reader, "/api/x/workflows?namespaces=*&pageSize=10", &p1)
	// A newer running workflow arrives before page 2.
	w.add(wfSpec{ns: "ns-b", wf: "late", run: "run-late", start: 900, close: -1})

	emitted := map[string]bool{}
	for _, e := range p1.Executions {
		emitted[rowID(e.Namespace, e.Execution.Execution.RunID)] = true
	}
	token := p1.NextPageToken
	for token != "" {
		var p listResp
		if code := getJSON(t, env, testutil.Reader, "/api/x/workflows?namespaces=*&pageSize=10&pageToken="+url.QueryEscape(token), &p); code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
		for _, e := range p.Executions {
			id := rowID(e.Namespace, e.Execution.Execution.RunID)
			if emitted[id] {
				t.Fatalf("duplicate row %s after insertion", id)
			}
			emitted[id] = true
		}
		token = p.NextPageToken
	}
	if emitted[rowID("ns-b", "run-late")] {
		t.Fatal("the newer row sorts before the window and must not shift it")
	}
	if len(emitted) != 33 {
		t.Fatalf("emitted %d older rows, want all 33 (none skipped)", len(emitted))
	}
}

func TestListTokenValidation(t *testing.T) {
	w := interleaved()
	env := newEnv(t, w, nil)
	var p1 listResp
	getJSON(t, env, testutil.Reader, "/api/x/workflows?namespaces=ns-a,ns-b&pageSize=5", &p1)
	tok := p1.NextPageToken
	if tok == "" {
		t.Fatal("expected a next page")
	}
	payload, sig, _ := strings.Cut(tok, ".")
	tampered := payload[:len(payload)-2] + "AA" + "." + sig

	for name, path := range map[string]string{
		"tampered HMAC":       "/api/x/workflows?namespaces=ns-a,ns-b&pageSize=5&pageToken=" + url.QueryEscape(tampered),
		"other query":         "/api/x/workflows?namespaces=ns-a,ns-b&query=" + url.QueryEscape(`WorkflowType="X"`) + "&pageToken=" + url.QueryEscape(tok),
		"other namespaces":    "/api/x/workflows?namespaces=ns-a,ns-c&pageToken=" + url.QueryEscape(tok),
		"garbage":             "/api/x/workflows?namespaces=ns-a,ns-b&pageToken=abc",
		"page size too large": "/api/x/workflows?namespaces=ns-a&pageSize=101",
		"page size zero":      "/api/x/workflows?namespaces=ns-a&pageSize=0",
		"unknown namespace":   "/api/x/workflows?namespaces=ns-a,nope",
		"hidden namespace":    "/api/x/workflows?namespaces=temporal-system",
		"no namespaces":       "/api/x/workflows",
	} {
		if code := getJSON(t, env, testutil.Reader, path, nil); code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, code)
		}
	}
	// The same selection in another order is the same selection.
	if code := getJSON(t, env, testutil.Reader, "/api/x/workflows?namespaces=ns-b,ns-a&pageSize=5&pageToken="+url.QueryEscape(tok), nil); code != http.StatusOK {
		t.Errorf("reordered namespaces: status %d, want 200", code)
	}
}

func TestListFanoutCap(t *testing.T) {
	w := interleaved()
	env := newEnv(t, w, func(c *config.Config) { c.Limits.FanoutMaxNamespaces = 2 })
	if code := getJSON(t, env, testutil.Reader, "/api/x/workflows?namespaces=*", nil); code != http.StatusBadRequest {
		t.Fatalf("over the fan-out cap: %d, want 400", code)
	}
}

func TestListNamespaceErrorIsReported(t *testing.T) {
	w := interleaved()
	w.failNS["ns-b"] = true
	env := newEnv(t, w, nil)
	var resp listResp
	if code := getJSON(t, env, testutil.Reader, "/api/x/workflows?namespaces=*&pageSize=100", &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(resp.Executions) != 22 || len(resp.Errors) != 1 || resp.Errors[0].Namespace != "ns-b" || resp.Errors[0].Code != 14 {
		t.Fatalf("rows=%d errors=%+v", len(resp.Executions), resp.Errors)
	}
}

func TestCounts(t *testing.T) {
	w := interleaved()
	w.add(wfSpec{ns: "ns-c", wf: "failed", run: "f1", start: 1, close: 2, status: 3})
	w.failNS["ns-b"] = true
	env := newEnv(t, w, nil)
	var resp struct {
		Total        int64                        `json:"total"`
		ByStatus     map[string]int64             `json:"byStatus"`
		PerNamespace map[string]map[string]any    `json:"perNamespace"`
		Errors       []struct{ Namespace string } `json:"errors"`
	}
	if code := getJSON(t, env, testutil.Reader, "/api/x/workflows/count?namespaces=*", &resp); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if resp.Total != 23 || resp.ByStatus["Running"] != 2 || resp.ByStatus["Completed"] != 20 || resp.ByStatus["Failed"] != 1 {
		t.Fatalf("counts = %+v", resp)
	}
	if len(resp.Errors) != 1 || resp.Errors[0].Namespace != "ns-b" || resp.PerNamespace["ns-b"] != nil {
		t.Fatalf("errors=%+v perNamespace=%v", resp.Errors, resp.PerNamespace)
	}
	var running struct{ Total int64 }
	getJSON(t, env, testutil.Reader, "/api/x/workflows/count?namespaces=ns-a&query="+url.QueryEscape(`ExecutionStatus="Running"`), &running)
	if running.Total != 1 {
		t.Fatalf("filtered count = %d, want 1", running.Total)
	}
}

// pageAll walks every page and returns the emitted row IDs in order.
func pageAll(t *testing.T, env *testutil.Env, base string, between func(page int)) []string {
	t.Helper()
	var all []string
	token := ""
	for page := 0; page < 50; page++ {
		path := base
		if token != "" {
			path += "&pageToken=" + url.QueryEscape(token)
		}
		var resp listResp
		if code := getJSON(t, env, testutil.Reader, path, &resp); code != http.StatusOK {
			t.Fatalf("page %d: status %d", page, code)
		}
		for _, e := range resp.Executions {
			all = append(all, rowID(e.Namespace, e.Execution.Execution.RunID))
		}
		if token = resp.NextPageToken; token == "" {
			return all
		}
		if between != nil {
			between(page)
		}
	}
	t.Fatal("pagination did not terminate")
	return nil
}

func assertComplete(t *testing.T, all []string, want int) {
	t.Helper()
	seen := map[string]bool{}
	for _, id := range all {
		if seen[id] {
			t.Fatalf("duplicate row %s", id)
		}
		seen[id] = true
	}
	if len(all) != want {
		t.Fatalf("emitted %d rows, want %d", len(all), want)
	}
}

// TestListElasticsearchOrder: Temporal 1.24 Elasticsearch visibility sorts
// CloseTime desc with missing first, so running rows lead there too and
// paging is complete.
func TestListElasticsearchOrder(t *testing.T) {
	w := interleaved()
	w.store = "elasticsearch"
	env := newEnv(t, w, nil)
	all := pageAll(t, env, "/api/x/workflows?namespaces=*&pageSize=7", nil)
	assertComplete(t, all, 33)
	for i := 0; i < 3; i++ {
		if !strings.HasSuffix(all[i], "-running") {
			t.Fatalf("row %d is %s, want running rows first", i, all[i])
		}
	}
}

// TestListNamespaceRecoversOnResumedPage: a namespace that fails on a
// resumed page is retried from the same position on the next page.
func TestListNamespaceRecoversOnResumedPage(t *testing.T) {
	w := interleaved()
	env := newEnv(t, w, nil)
	all := pageAll(t, env, "/api/x/workflows?namespaces=*&pageSize=5", func(page int) {
		w.mu.Lock()
		defer w.mu.Unlock()
		switch page {
		case 0:
			w.failNS["ns-b"] = true
		case 1:
			w.failNS["ns-b"] = false
		}
	})
	assertComplete(t, all, 33)

	// The failing page reports the error and keeps ns-b in the token.
	w2 := interleaved()
	env2 := newEnv(t, w2, nil)
	var p1, p2 listResp
	getJSON(t, env2, testutil.Reader, "/api/x/workflows?namespaces=*&pageSize=5", &p1)
	w2.failNS["ns-b"] = true
	getJSON(t, env2, testutil.Reader, "/api/x/workflows?namespaces=*&pageSize=5&pageToken="+url.QueryEscape(p1.NextPageToken), &p2)
	if len(p2.Errors) != 1 || p2.Errors[0].Namespace != "ns-b" || p2.NextPageToken == "" {
		t.Fatalf("errors=%+v next=%q", p2.Errors, p2.NextPageToken)
	}
	payload, _, _ := strings.Cut(p2.NextPageToken, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(payload)
	if !strings.Contains(string(raw), `"ns-b"`) {
		t.Fatalf("ns-b dropped from the token: %s", raw)
	}
}

func TestListRejectsBadQueries(t *testing.T) {
	env := newEnv(t, interleaved(), nil)
	for _, p := range []string{
		"/api/x/workflows?namespaces=*&query=" + url.QueryEscape(`WorkflowType="X" ORDER BY StartTime DESC`),
		"/api/x/workflows/count?namespaces=*&query=" + url.QueryEscape(`a) OR (b`),
		"/api/x/search/activity?namespaces=*&activityType=A&query=" + url.QueryEscape(`(WorkflowType="X"`),
		"/api/x/search/event?namespaces=*&eventType=EVENT_TYPE_TIMER_STARTED&query=" + url.QueryEscape(`WorkflowId="x`),
	} {
		w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, p, ""))
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":3`) {
			t.Errorf("%s: %d %s, want 400", p, w.Code, w.Body.String())
		}
	}
	if len(env.Fake.Calls()) > 1 {
		t.Fatalf("rejected queries reached Temporal: %d calls", len(env.Fake.Calls()))
	}
}
