package xapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	"tempolens/internal/authz"
	"tempolens/internal/testutil"
)

const (
	consoleInvoke = "/api/x/console/invoke"
	wfSvc         = "/temporal.api.workflowservice.v1.WorkflowService/"
	opSvc         = "/temporal.api.operatorservice.v1.OperatorService/"
)

// okResponder answers every call with an empty response of the method's
// output type, so a call that reaches the backend succeeds.
func okResponder(_ context.Context, method string, _ any) (any, error, bool) {
	svc, name, _ := strings.Cut(strings.TrimPrefix(method, "/"), "/")
	d, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(svc))
	if err != nil {
		return nil, nil, false
	}
	sd, ok := d.(protoreflect.ServiceDescriptor)
	if !ok {
		return nil, nil, false
	}
	md := sd.Methods().ByName(protoreflect.Name(name))
	if md == nil {
		return nil, nil, false
	}
	mt, err := protoregistry.GlobalTypes.FindMessageByName(md.Output().FullName())
	if err != nil {
		return nil, nil, false
	}
	return mt.New().Interface(), nil, true
}

// consoleEnv lifts the /api/x rate so table tests are not throttled.
func consoleEnv(t *testing.T) *testutil.Env {
	t.Helper()
	cfg := testutil.AuthConfig(t)
	cfg.Limits.XAPIRPS = 1000
	return testutil.NewEnv(t, cfg)
}

func consoleBody(method, request string) string {
	return `{"method":"` + method + `","request":` + request + `}`
}

// invokeConsole posts to the console with optional intent headers
// (confirm, reason; already percent-encoded).
func invokeConsole(t *testing.T, env *testutil.Env, who testutil.Who, body string, headers ...string) (int, string) {
	t.Helper()
	r := env.NewRequest(t, who, http.MethodPost, consoleInvoke, body)
	if len(headers) > 0 {
		r.Header.Set(authz.ConfirmHeader, headers[0])
	}
	if len(headers) > 1 {
		r.Header.Set(authz.ReasonHeader, headers[1])
	}
	w := env.Do(r)
	return w.Code, w.Body.String()
}

func TestConsoleRoles(t *testing.T) {
	read := consoleBody(wfSvc+"DescribeNamespace", `{"namespace":"ns"}`)
	write := consoleBody(wfSvc+"SignalWorkflowExecution", `{"namespace":"ns","workflowExecution":{"workflowId":"wf"},"signalName":"s"}`)
	adminOp := consoleBody(opSvc+"AddSearchAttributes", `{"namespace":"ns","searchAttributes":{"CustomKw":"INDEXED_VALUE_TYPE_KEYWORD"}}`)
	cases := []struct {
		name string
		body string
		who  testutil.Who
		want int
	}{
		{"read as reader", read, testutil.Reader, http.StatusOK},
		{"read as writer", read, testutil.Writer, http.StatusOK},
		{"read as admin", read, testutil.Admin, http.StatusOK},
		{"write as reader", write, testutil.Reader, http.StatusForbidden},
		{"write as writer", write, testutil.Writer, http.StatusOK},
		{"write as admin", write, testutil.Admin, http.StatusOK},
		{"admin as reader", adminOp, testutil.Reader, http.StatusForbidden},
		{"admin as writer", adminOp, testutil.Writer, http.StatusForbidden},
		{"admin as admin", adminOp, testutil.Admin, http.StatusOK},
	}
	env := consoleEnv(t)
	env.Fake.SetResponder(okResponder)
	for _, c := range cases {
		env.Fake.Reset()
		code, body := invokeConsole(t, env, c.who, c.body)
		if code != c.want {
			t.Errorf("%s: status %d, want %d: %s", c.name, code, c.want, body)
		}
		if reached := len(env.Fake.Calls()) == 1; reached != (c.want == http.StatusOK) {
			t.Errorf("%s: backend reached=%v", c.name, reached)
		}
	}
}

func TestConsoleResponseIsProtoJSON(t *testing.T) {
	env := consoleEnv(t)
	var deadline time.Duration
	env.Fake.SetResponder(func(ctx context.Context, method string, _ any) (any, error, bool) {
		if d, ok := ctx.Deadline(); ok {
			deadline = time.Until(d)
		}
		return &workflowservice.CountWorkflowExecutionsResponse{Count: 42}, nil, true
	})
	code, body := invokeConsole(t, env, testutil.Reader, consoleBody(wfSvc+"CountWorkflowExecutions", `{"namespace":"ns"}`))
	if code != http.StatusOK || !strings.Contains(body, `"count":"42"`) {
		t.Fatalf("status %d body %s, want count as an /api/v1 int64 string", code, body)
	}
	if got := env.Fake.Calls()[0].Req.(*workflowservice.CountWorkflowExecutionsRequest).GetNamespace(); got != "ns" {
		t.Fatalf("backend namespace %q", got)
	}
	// Every console call, including a long-poll, is bounded by the call timeout.
	if deadline <= 0 || deadline > 30*time.Second {
		t.Fatalf("backend saw deadline %v, want at most 30s", deadline)
	}
}

func TestConsoleDestructiveNeedsConfirm(t *testing.T) {
	env := consoleEnv(t)
	env.Fake.SetResponder(okResponder)
	terminate := consoleBody(wfSvc+"TerminateWorkflowExecution", `{"namespace":"ns","workflowExecution":{"workflowId":"a/b c"},"reason":"cleanup"}`)
	deleteNS := consoleBody(opSvc+"DeleteNamespace", `{"namespace":"tui-test-x"}`)
	cases := []struct {
		name    string
		who     testutil.Who
		body    string
		headers []string
		want    int
	}{
		{"terminate without confirm", testutil.Writer, terminate, nil, http.StatusBadRequest},
		{"terminate with wrong confirm", testutil.Writer, terminate, []string{"other"}, http.StatusBadRequest},
		{"terminate as reader", testutil.Reader, terminate, []string{"a%2Fb%20c"}, http.StatusForbidden},
		{"terminate confirmed", testutil.Writer, terminate, []string{"a%2Fb%20c"}, http.StatusOK},
		{"delete namespace without confirm", testutil.Admin, deleteNS, nil, http.StatusBadRequest},
		{"delete namespace with wrong confirm", testutil.Admin, deleteNS, []string{"tui-test-y"}, http.StatusBadRequest},
		{"delete namespace as writer", testutil.Writer, deleteNS, []string{"tui-test-x"}, http.StatusForbidden},
		{"delete namespace confirmed", testutil.Admin, deleteNS, []string{"tui-test-x"}, http.StatusOK},
	}
	for _, c := range cases {
		env.Fake.Reset()
		code, body := invokeConsole(t, env, c.who, c.body, c.headers...)
		if code != c.want {
			t.Errorf("%s: status %d, want %d: %s", c.name, code, c.want, body)
		}
		if reached := len(env.Fake.Calls()) == 1; reached != (c.want == http.StatusOK) {
			t.Errorf("%s: backend reached=%v", c.name, reached)
		}
	}
}

func TestConsoleRejectsBeforeBackend(t *testing.T) {
	big := consoleBody(wfSvc+"DescribeNamespace", `{"namespace":"`+strings.Repeat("x", 1<<20)+`"}`)
	cases := []struct {
		name string
		body string
		want int
	}{
		{"blocked method", consoleBody(wfSvc+"PollWorkflowTaskQueue", `{"namespace":"ns"}`), http.StatusForbidden},
		{"blocked operator method", consoleBody(opSvc+"AddOrUpdateRemoteCluster", `{}`), http.StatusForbidden},
		{"other service", consoleBody("/grpc.health.v1.Health/Check", `{}`), http.StatusForbidden},
		{"unknown method", consoleBody(wfSvc+"NoSuchMethod", `{}`), http.StatusForbidden},
		{"unknown service", consoleBody("/example.v1.Shell/Exec", `{}`), http.StatusForbidden},
		{"short method name", consoleBody("DescribeNamespace", `{}`), http.StatusBadRequest},
		{"missing method", `{"request":{}}`, http.StatusBadRequest},
		{"unknown request field", consoleBody(wfSvc+"DescribeNamespace", `{"namespace":"ns","bogus":1}`), http.StatusBadRequest},
		{"request not an object", consoleBody(wfSvc+"DescribeNamespace", `"ns"`), http.StatusBadRequest},
		{"unknown body field", `{"method":"` + wfSvc + `DescribeNamespace","request":{},"extra":true}`, http.StatusBadRequest},
		{"malformed JSON", `{"method":`, http.StatusBadRequest},
		{"trailing data", consoleBody(wfSvc+"DescribeNamespace", `{}`) + `{}`, http.StatusBadRequest},
		{"empty body", ``, http.StatusBadRequest},
		{"body over cap", big, http.StatusRequestEntityTooLarge},
	}
	env := consoleEnv(t)
	env.Fake.SetResponder(okResponder)
	for _, c := range cases {
		env.Fake.Reset()
		code, body := invokeConsole(t, env, testutil.Admin, c.body)
		if code != c.want {
			t.Errorf("%s: status %d, want %d: %s", c.name, code, c.want, body)
		}
		var st struct {
			Code    int             `json:"code"`
			Details json.RawMessage `json:"details"`
		}
		if err := json.Unmarshal([]byte(body), &st); err != nil || st.Code == 0 || st.Details == nil {
			t.Errorf("%s: body is not a google.rpc.Status: %s", c.name, body)
		}
		if n := len(env.Fake.Calls()); n != 0 {
			t.Errorf("%s: %d backend calls, want none", c.name, n)
		}
	}
}

func TestConsoleWriteAuditedAndStamped(t *testing.T) {
	env := consoleEnv(t)
	env.Fake.SetResponder(func(_ context.Context, method string, _ any) (any, error, bool) {
		return nil, status.Error(codes.NotFound, "workflow not found"), true
	})
	body := consoleBody(wfSvc+"SignalWorkflowExecution",
		`{"namespace":"ns","workflowExecution":{"workflowId":"wf"},"signalName":"s","identity":"spoofed"}`)
	code, resp := invokeConsole(t, env, testutil.Writer, body)
	if code != http.StatusNotFound || !strings.Contains(resp, `"code":5`) {
		t.Fatalf("status %d body %s, want Temporal's NotFound", code, resp)
	}
	calls := env.Fake.Calls()
	if len(calls) != 1 {
		t.Fatalf("%d backend calls", len(calls))
	}
	if got := calls[0].Req.(*workflowservice.SignalWorkflowExecutionRequest).GetIdentity(); got != "tempolens:writer@example.com" {
		t.Errorf("identity %q reached Temporal", got)
	}
	for k := range calls[0].MD {
		switch k {
		case "client-name", "client-version", ":authority", "content-type", "user-agent":
		default:
			t.Errorf("unexpected metadata key %q reached Temporal", k)
		}
	}
	logs := env.Logs()
	for _, want := range []string{`"event":"write"`, `"code":"NotFound"`, `"user":"writer@example.com"`,
		`"method":"SignalWorkflowExecution"`, `"workflowId":"wf"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("audit line lacks %s: %s", want, logs)
		}
	}
}

func TestConsoleRouteMethodsAndCSRF(t *testing.T) {
	env := consoleEnv(t)
	if w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, consoleInvoke, "")); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET invoke: %d", w.Code)
	}
	if w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodPost, "/api/x/console/methods", "{}")); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST methods: %d", w.Code)
	}
	r := env.NewRequest(t, testutil.Admin, http.MethodPost, consoleInvoke, consoleBody(wfSvc+"DescribeNamespace", `{}`))
	r.Header.Del("X-Tempolens")
	if w := env.Do(r); w.Code != http.StatusForbidden {
		t.Errorf("invoke without CSRF header: %d", w.Code)
	}
	if w := env.Do(env.NewRequest(t, testutil.Nobody, http.MethodPost, consoleInvoke, consoleBody(wfSvc+"DescribeNamespace", `{}`))); w.Code != http.StatusUnauthorized {
		t.Errorf("invoke without session: %d", w.Code)
	}
	if n := len(env.Fake.Calls()); n != 0 {
		t.Errorf("%d backend calls, want none", n)
	}
}

func TestConsoleMethodsList(t *testing.T) {
	env := consoleEnv(t)
	var got struct {
		Methods []authz.ConsoleMethod `json:"methods"`
	}
	if code := getJSON(t, env, testutil.Reader, "/api/x/console/methods", &got); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(got.Methods) != len(authz.ConsoleMethods()) {
		t.Fatalf("%d methods, want %d", len(got.Methods), len(authz.ConsoleMethods()))
	}
	byName := map[string]authz.ConsoleMethod{}
	for _, m := range got.Methods {
		byName[m.Method] = m
	}
	want := map[string]authz.ConsoleMethod{
		wfSvc + "DescribeNamespace":          {Method: wfSvc + "DescribeNamespace", Service: "WorkflowService", Name: "DescribeNamespace", Class: "READ"},
		wfSvc + "TerminateWorkflowExecution": {Method: wfSvc + "TerminateWorkflowExecution", Service: "WorkflowService", Name: "TerminateWorkflowExecution", Class: "WRITE"},
		opSvc + "DeleteNamespace":            {Method: opSvc + "DeleteNamespace", Service: "OperatorService", Name: "DeleteNamespace", Class: "ADMIN"},
	}
	for name, w := range want {
		if byName[name] != w {
			t.Errorf("%s: %+v, want %+v", name, byName[name], w)
		}
	}
	if _, ok := byName[wfSvc+"PollWorkflowTaskQueue"]; ok {
		t.Error("a BLOCK method is listed")
	}
}

func TestConsoleUsesXAPIRateLimit(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	env.Fake.SetResponder(okResponder)
	body := consoleBody(wfSvc+"DescribeNamespace", `{"namespace":"ns"}`)
	for i := 0; ; i++ {
		r := env.NewRequest(t, testutil.Reader, http.MethodPost, consoleInvoke, body)
		w := env.Do(r)
		if w.Code == http.StatusTooManyRequests {
			if w.Header().Get("Retry-After") == "" {
				t.Fatal("429 without Retry-After")
			}
			if i == 0 {
				t.Fatal("first call throttled")
			}
			return
		}
		if w.Code != http.StatusOK || i > 100 {
			t.Fatalf("call %d: status %d, want the per-user limit to answer 429", i, w.Code)
		}
	}
}

// TestConsoleAllowlistDenyAudited: a method refused by the console allowlist
// writes the interceptor's deny line, without calling Temporal.
func TestConsoleAllowlistDenyAudited(t *testing.T) {
	env := consoleEnv(t)
	for method, short := range map[string]string{
		wfSvc + "PollWorkflowTaskQueue": "PollWorkflowTaskQueue",
		"/example.v1.Shell/Exec":        "Exec",
	} {
		code, body := invokeConsole(t, env, testutil.Writer, consoleBody(method, `{}`))
		if code != http.StatusForbidden {
			t.Fatalf("%s: status %d: %s", method, code, body)
		}
		var found bool
		for _, line := range strings.Split(env.Logs(), "\n") {
			var ev map[string]any
			if json.Unmarshal([]byte(line), &ev) != nil || ev["audit"] != true || ev["method"] != short {
				continue
			}
			found = ev["event"] == "deny" && ev["user"] == "writer@example.com" && ev["role"] == "write" &&
				ev["code"] == "PermissionDenied" && ev["reason"] == "method not allowed in the console"
			if _, ok := ev["durationMs"]; !ok {
				found = false
			}
			if !found {
				t.Errorf("%s: unexpected audit line %s", method, line)
			}
		}
		if !found {
			t.Errorf("%s: no deny audit line in %s", method, env.Logs())
		}
	}
	if n := len(env.Fake.Calls()); n != 0 {
		t.Errorf("%d backend calls, want none", n)
	}
}
