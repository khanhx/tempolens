package xapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"

	"tempolens/internal/auth"
	"tempolens/internal/config"
	"tempolens/internal/testutil"
)

func exportOf(t *testing.T, env *testutil.Env, path string) *httptest.ResponseRecorder {
	t.Helper()
	return env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, path, ""))
}

func TestExport(t *testing.T) {
	w := newWorld("ns-a")
	w.add(wfSpec{ns: "ns-a", wf: "one", run: "r1", start: 1, close: 2})
	w.setHistory("ns-a", "one", "r1", started("", "r1"), completed())
	w.add(wfSpec{ns: "ns-a", wf: "many", run: "r2", start: 1, close: 2})
	var events []*historypb.HistoryEvent
	events = append(events, started("", "r2"))
	for i := 0; i < 10; i++ {
		events = append(events, plainEvent(enumspb.EVENT_TYPE_TIMER_STARTED))
	}
	w.setHistory("ns-a", "many", "r2", append(events, completed())...)
	w.setHistory("ns-a", "empty", "r3")
	env := newEnv(t, w, nil)

	for _, tc := range []struct {
		wf, run string
		n       int
	}{{"one", "r1", 2}, {"many", "r2", 12}, {"empty", "r3", 0}} {
		rec := exportOf(t, env, "/api/x/history-export?namespace=ns-a&workflowId="+tc.wf+"&runId="+tc.run)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d %s", tc.wf, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="`+tc.run+`-events.json"` {
			t.Fatalf("Content-Disposition = %q", got)
		}
		var arr []map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &arr); err != nil {
			t.Fatalf("%s: not a JSON array: %v\n%s", tc.wf, err, rec.Body.String())
		}
		if len(arr) != tc.n {
			t.Fatalf("%s: %d events, want %d", tc.wf, len(arr), tc.n)
		}
		if tc.n > 0 && (arr[0]["eventId"] != "1" || arr[0]["eventType"] != "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED") {
			t.Fatalf("%s: first event = %v (want the /api/v1 JSON form)", tc.wf, arr[0])
		}
	}
	if tc := "empty"; strings.TrimSpace(exportOf(t, env, "/api/x/history-export?namespace=ns-a&workflowId="+tc+"&runId=r3").Body.String()) != "[]" {
		t.Fatal("an empty history must export as []")
	}

	if rec := exportOf(t, env, "/api/x/history-export?namespace=ns-a&workflowId=nope&runId=x"); rec.Code != http.StatusNotFound ||
		!strings.Contains(rec.Body.String(), `"code":5`) {
		t.Fatalf("missing run: %d %s", rec.Code, rec.Body.String())
	}
	for _, p := range []string{
		"/api/x/history-export?namespace=ns-a&workflowId=one",
		"/api/x/history-export?namespace=ns-a&workflowId=one&runId=a%22b",
	} {
		if rec := exportOf(t, env, p); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", p, rec.Code)
		}
	}
}

type meResp struct {
	User *struct {
		Email string `json:"email"`
	} `json:"user"`
	Role        string `json:"role"`
	AuthEnabled bool   `json:"authEnabled"`
	Settings    struct {
		DisabledActions     []string       `json:"disabledActions"`
		ProtectedNamespaces []string       `json:"protectedNamespaces"`
		Limits              map[string]int `json:"limits"`
		Version             string         `json:"version"`
	} `json:"settings"`
}

func TestMe(t *testing.T) {
	env := newEnv(t, newWorld("ns-a"), func(c *config.Config) {
		c.Disabled.Reset = true
		c.Disabled.Schedule = true
	})
	var me meResp
	getJSON(t, env, testutil.Writer, "/api/x/me", &me)
	if me.Role != "write" || me.User == nil || me.User.Email != "writer@example.com" || !me.AuthEnabled || me.Settings.Version != "test" {
		t.Fatalf("writer me = %+v", me)
	}
	// A writer also loses the admin-only actions.
	if strings.Join(me.Settings.DisabledActions, ",") != "reset,schedule,namespace,searchAttribute,batchDelete" {
		t.Fatalf("writer disabledActions = %v", me.Settings.DisabledActions)
	}
	if me.Settings.Limits["pageSizeMax"] != 100 || me.Settings.Limits["graphDepthMax"] != 3 || me.Settings.Limits["scanMaxWorkflows"] != 200 {
		t.Fatalf("limits = %v", me.Settings.Limits)
	}

	getJSON(t, env, testutil.Reader, "/api/x/me", &me)
	if me.Role != "read" || strings.Join(me.Settings.DisabledActions, ",") !=
		"terminate,cancel,signal,update,reset,pause,batch,start,schedule,nexus,delete,activity,namespace,searchAttribute,batchDelete" {
		t.Fatalf("reader me = %+v", me)
	}

	// An admin loses only the env-disabled actions.
	getJSON(t, env, testutil.Admin, "/api/x/me", &me)
	if me.Role != "admin" || strings.Join(me.Settings.DisabledActions, ",") != "reset,schedule" {
		t.Fatalf("admin me = %+v", me)
	}

	// A write session whose group was removed from the env is read.
	cfg := testutil.AuthConfig(t)
	cfg.Auth.WriteGroups = []string{"another group"}
	env = newEnv(t, newWorld("ns-a"), func(c *config.Config) { *c = *cfg; c.Limits.XAPIRPS = 1000 })
	getJSON(t, env, testutil.Writer, "/api/x/me", &me)
	if me.Role != "read" || len(me.Settings.DisabledActions) != 15 {
		t.Fatalf("revoked writer me = %+v", me)
	}

	// An admin session whose admin group was removed drops to write.
	cfg = testutil.AuthConfig(t)
	cfg.Auth.AdminGroups = nil
	cfg.Auth.WriteGroups = append(cfg.Auth.WriteGroups, testutil.AdminGroup)
	env = newEnv(t, newWorld("ns-a"), func(c *config.Config) { *c = *cfg; c.Limits.XAPIRPS = 1000 })
	p := testutil.Principal(testutil.Admin)
	p.WriteGroup = testutil.AdminGroup
	r := env.NewRequest(t, testutil.Nobody, http.MethodGet, "/api/x/me", "")
	r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: env.SessionCookie(t, p)})
	if w := env.Do(r); !strings.Contains(w.Body.String(), `"role":"write"`) {
		t.Fatalf("demoted admin me = %s", w.Body.String())
	}
}

func TestMeProtectedNamespaces(t *testing.T) {
	for _, tc := range []struct {
		configured []string
		want       string
	}{
		{nil, "default,temporal-system"},
		{[]string{"default"}, "default,temporal-system"},
		{[]string{"payments", "default", "billing", "payments", "temporal-system"}, "billing,default,payments,temporal-system"},
	} {
		env := newEnv(t, newWorld("ns-a"), func(c *config.Config) { c.ProtectedNamespaces = tc.configured })
		var me meResp
		getJSON(t, env, testutil.Reader, "/api/x/me", &me)
		if got := strings.Join(me.Settings.ProtectedNamespaces, ","); got != tc.want {
			t.Errorf("configured %q: protectedNamespaces = %q, want %q", tc.configured, got, tc.want)
		}
	}
}

func TestMeAuthDisabled(t *testing.T) {
	for role, disabled := range map[config.Role]string{
		config.RoleWrite: `"disabledActions":["namespace","searchAttribute","batchDelete"]`,
		config.RoleAdmin: `"disabledActions":[]`,
	} {
		env := newEnv(t, newWorld("ns-a"), func(c *config.Config) {
			c.Auth = config.Auth{Disabled: true, DisabledRole: role}
		})
		w := env.Do(env.NewRequest(t, testutil.Nobody, http.MethodGet, "/api/x/me", ""))
		if !strings.Contains(w.Body.String(), `"user":null`) || !strings.Contains(w.Body.String(), disabled) ||
			!strings.Contains(w.Body.String(), `"authEnabled":false`) || !strings.Contains(w.Body.String(), `"role":"`+string(role)+`"`) {
			t.Fatalf("auth-disabled %s me = %s", role, w.Body.String())
		}
	}
}

// TestXAPIThroughInterceptor checks every /api/x route works for a reader
// and that every RPC it made carries the metadata only the authz
// interceptor sets.
func TestXAPIThroughInterceptor(t *testing.T) {
	w := graphWorld()
	env := newEnv(t, w, nil)
	for _, p := range []string{
		"/api/x/me",
		"/api/x/workflows?namespaces=*",
		"/api/x/workflows/count?namespaces=*",
		"/api/x/search/activity?namespaces=*&activityType=X",
		"/api/x/search/event?namespaces=*&eventType=EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED",
		"/api/x/graph?namespace=ns-a&workflowId=c1&runId=c1r",
		"/api/x/history-export?namespace=ns-a&workflowId=c1&runId=c1r",
	} {
		if code := getJSON(t, env, testutil.Reader, p, nil); code != http.StatusOK {
			t.Errorf("reader %s: %d", p, code)
		}
		if code := getJSON(t, env, testutil.Nobody, p, nil); code != http.StatusUnauthorized {
			t.Errorf("no session %s: %d", p, code)
		}
	}
	calls := env.Fake.Calls()
	if len(calls) < 10 {
		t.Fatalf("only %d calls recorded", len(calls))
	}
	for _, c := range calls {
		if got := c.MD.Get("client-name"); len(got) != 1 || got[0] != "tempolens" {
			t.Fatalf("%s bypassed the interceptor (metadata %v)", c.Method, c.MD)
		}
	}
	if !strings.Contains(env.Logs(), `"path":"/api/x/workflows"`) {
		t.Fatal("request log missing")
	}

	// Reads on temporal-system are denied by the interceptor even when the
	// handler would pass them on: the graph does not pre-check namespaces.
	if code := getJSON(t, env, testutil.Reader, "/api/x/graph?namespace=temporal-system&workflowId=a&runId=b", nil); code != http.StatusForbidden {
		t.Fatalf("graph on temporal-system: %d, want 403 from the interceptor", code)
	}
	if code := getJSON(t, env, testutil.Reader, "/api/x/history-export?namespace=temporal-system&workflowId=a&runId=b", nil); code != http.StatusForbidden {
		t.Fatalf("export on temporal-system: %d, want 403 from the interceptor", code)
	}
}
