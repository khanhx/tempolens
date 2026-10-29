package authz_test

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	namespacepb "go.temporal.io/api/namespace/v1"
	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/genproto/googleapis/api/annotations"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	"tempolens/internal/authz"
	"tempolens/internal/testutil"
)

type binding struct {
	fullMethod string
	httpMethod string
	path       string
}

var pathVar = regexp.MustCompile(`\{[^}]*\}`)

// fillPath replaces each {var} or {var=template} with "x" segments.
func fillPath(tmpl string) string {
	return pathVar.ReplaceAllStringFunc(tmpl, func(v string) string {
		inner := strings.Trim(v, "{}")
		if _, t, ok := strings.Cut(inner, "="); ok {
			return strings.NewReplacer("**", "x", "*", "x").Replace(t)
		}
		return "x"
	})
}

// bindings enumerates every HTTP binding, including additional_bindings.
func bindings(t *testing.T) []binding {
	t.Helper()
	var out []binding
	for _, f := range []protoreflect.FileDescriptor{
		workflowservice.File_temporal_api_workflowservice_v1_service_proto,
		operatorservice.File_temporal_api_operatorservice_v1_service_proto,
	} {
		for i := 0; i < f.Services().Len(); i++ {
			svc := f.Services().Get(i)
			for j := 0; j < svc.Methods().Len(); j++ {
				m := svc.Methods().Get(j)
				rule, _ := proto.GetExtension(m.Options(), annotations.E_Http).(*annotations.HttpRule)
				if rule == nil {
					continue
				}
				full := "/" + string(svc.FullName()) + "/" + string(m.Name())
				for _, r := range append([]*annotations.HttpRule{rule}, rule.GetAdditionalBindings()...) {
					var method, path string
					switch p := r.GetPattern().(type) {
					case *annotations.HttpRule_Get:
						method, path = http.MethodGet, p.Get
					case *annotations.HttpRule_Post:
						method, path = http.MethodPost, p.Post
					case *annotations.HttpRule_Delete:
						method, path = http.MethodDelete, p.Delete
					case *annotations.HttpRule_Put:
						method, path = http.MethodPut, p.Put
					case *annotations.HttpRule_Patch:
						method, path = http.MethodPatch, p.Patch
					default:
						t.Fatalf("%s: unsupported binding %T", full, p)
					}
					out = append(out, binding{full, method, fillPath(path)})
				}
			}
		}
	}
	if len(out) < 100 {
		t.Fatalf("only %d bindings found; descriptor options not loaded?", len(out))
	}
	return out
}

// validBody returns a body that passes the validators of a WRITE method.
func validBody(fullMethod string) string {
	switch fullMethod[strings.LastIndexByte(fullMethod, '/')+1:] {
	case "TerminateWorkflowExecution", "ResetWorkflowExecution":
		return `{"reason":"because"}`
	case "StartBatchOperation":
		return `{"reason":"because","visibilityQuery":"WorkflowType=\"X\"","terminationOperation":{}}`
	case "RegisterNamespace":
		return `{"namespace":"x","workflowExecutionRetentionPeriod":"86400s"}`
	}
	return `{}`
}

// allowedFor reports whether who may call an RPC of class c.
func allowedFor(c authz.Class, who testutil.Who) bool {
	switch c {
	case authz.ClassRead:
		return who != testutil.Nobody
	case authz.ClassWrite:
		return who == testutil.Writer || who == testutil.Admin
	case authz.ClassAdmin:
		return who == testutil.Admin
	}
	return false
}

// TestRouteMatrix checks every /api/v1 binding for the read, write and admin
// roles. Every binding path segment is "x", so a destructive request
// confirms "x" as the UI would.
func TestRouteMatrix(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	var prefixed, unprefixed, writes, admins int
	for _, b := range bindings(t) {
		rule, ok := authz.Lookup(b.fullMethod)
		if !ok {
			t.Errorf("%s has an HTTP binding but no rule", b.fullMethod)
			continue
		}
		body := ""
		if b.httpMethod != http.MethodGet {
			body = validBody(b.fullMethod)
		}

		if !strings.HasPrefix(b.path, "/api/v1/") {
			unprefixed++
			if b.httpMethod == http.MethodGet {
				continue
			}
			env.Fake.Reset()
			w := env.Do(env.NewRequest(t, testutil.Writer, b.httpMethod, b.path, body))
			if w.Code != http.StatusNotFound && w.Code != http.StatusMethodNotAllowed {
				t.Errorf("unprefixed %s %s: status %d, want 404/405", b.httpMethod, b.path, w.Code)
			}
			if n := len(env.Fake.Calls()); n != 0 {
				t.Errorf("unprefixed %s %s reached the backend", b.httpMethod, b.path)
			}
			continue
		}
		prefixed++
		name := b.httpMethod + " " + b.path + " (" + b.fullMethod + ")"

		// No session: 401, backend untouched.
		env.Fake.Reset()
		if w := env.Do(env.NewRequest(t, testutil.Nobody, b.httpMethod, b.path, body)); w.Code != http.StatusUnauthorized {
			t.Errorf("no session %s: status %d, want 401", name, w.Code)
		}
		if len(env.Fake.Calls()) != 0 {
			t.Errorf("no session %s: backend reached", name)
		}

		for _, who := range []testutil.Who{testutil.Reader, testutil.Writer, testutil.Admin} {
			env.Fake.Reset()
			r := env.NewRequest(t, who, b.httpMethod, b.path, body)
			if b.httpMethod != http.MethodGet {
				r.Header.Set(authz.ConfirmHeader, "x")
			}
			w := env.Do(r)
			calls := testutil.WithoutNamespaceCheck(env.Fake.Calls())
			if !allowedFor(rule.Class, who) {
				if w.Code != http.StatusForbidden {
					t.Errorf("who=%d %s: status %d, want 403 (%s)", who, name, w.Code, w.Body.String())
				}
				if len(calls) != 0 {
					t.Errorf("who=%d %s: backend reached", who, name)
				}
				if !strings.Contains(w.Body.String(), `"code":7`) {
					t.Errorf("who=%d %s: body is not a google.rpc.Status: %s", who, name, w.Body.String())
				}
				continue
			}
			if len(calls) != 1 || calls[0].Method != b.fullMethod {
				t.Errorf("who=%d %s: backend calls %v, want exactly %s (status %d %s)", who, name, calls, b.fullMethod, w.Code, w.Body.String())
			}
			switch {
			case rule.Class == authz.ClassWrite && who == testutil.Writer:
				writes++
			case rule.Class == authz.ClassAdmin:
				admins++
			}
		}
	}
	if prefixed < 100 || unprefixed == 0 || writes == 0 || admins == 0 {
		t.Fatalf("matrix too small: prefixed=%d unprefixed=%d writes=%d admins=%d", prefixed, unprefixed, writes, admins)
	}
	t.Logf("checked %d /api/v1 bindings (%d WRITE reached as writer, %d ADMIN as admin) and %d unprefixed bindings", prefixed, writes, admins, unprefixed)
}

// TestXAPIWriteRouteMatrix checks the /api/x routes for RPCs without an
// /api/v1 binding: each role gets exactly its RPC class, and Temporal is
// called only when allowed.
func TestXAPIWriteRouteMatrix(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	env.Fake.SetResponder(testutil.LiveNamespace)
	const wf, op = "/temporal.api.workflowservice.v1.WorkflowService/", "/temporal.api.operatorservice.v1.OperatorService/"
	for _, tc := range []struct {
		method, path, body, confirm, reason, rpc string
	}{
		{http.MethodDelete, "/api/x/workflow?namespace=ns&workflowId=a%2Fb&runId=r", "", "a%2Fb", "cleanup", wf + "DeleteWorkflowExecution"},
		{http.MethodDelete, "/api/x/namespace?namespace=tui-test-x", "", "tui-test-x", "", op + "DeleteNamespace"},
		{http.MethodPost, "/api/x/search-attributes?namespace=ns", `{"searchAttributes":{"CustomKw":"INDEXED_VALUE_TYPE_KEYWORD"}}`, "", "", op + "AddSearchAttributes"},
		{http.MethodDelete, "/api/x/search-attributes?namespace=ns&name=B&name=A", "", "B%2CA", "", op + "RemoveSearchAttributes"},
		{http.MethodGet, "/api/x/task-queue-partitions?namespace=ns&taskQueue=q", "", "", "", wf + "ListTaskQueuePartitions"},
	} {
		rule, _ := authz.Lookup(tc.rpc)
		for _, who := range []testutil.Who{testutil.Nobody, testutil.Reader, testutil.Writer, testutil.Admin} {
			env.Fake.Reset()
			r := env.NewRequest(t, who, tc.method, tc.path, tc.body)
			if tc.confirm != "" {
				r.Header.Set(authz.ConfirmHeader, tc.confirm)
			}
			if tc.reason != "" {
				r.Header.Set(authz.ReasonHeader, tc.reason)
			}
			w := env.Do(r)
			calls := testutil.WithoutNamespaceCheck(env.Fake.Calls())
			name := tc.method + " " + tc.path
			switch {
			case who == testutil.Nobody:
				if w.Code != http.StatusUnauthorized || len(calls) != 0 {
					t.Errorf("no session %s: status %d, %d backend calls", name, w.Code, len(calls))
				}
			case !allowedFor(rule.Class, who):
				if w.Code != http.StatusForbidden || len(calls) != 0 {
					t.Errorf("who=%d %s: status %d (%s), %d backend calls; want 403 and none", who, name, w.Code, w.Body.String(), len(calls))
				}
			default:
				if len(calls) != 1 || calls[0].Method != tc.rpc {
					t.Errorf("who=%d %s: status %d (%s), backend calls %v; want %s", who, name, w.Code, w.Body.String(), calls, tc.rpc)
				}
			}
		}
	}
}

// TestXAPIConfirmOverHTTP: the destructive /api/x routes need the
// confirmation header (and the delete reason) before Temporal is called.
func TestXAPIConfirmOverHTTP(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	for _, tc := range []struct {
		name, method, path, confirm, reason string
		want                                int
	}{
		{"workflow delete without confirm", http.MethodDelete, "/api/x/workflow?namespace=ns&workflowId=wf", "", "r", http.StatusBadRequest},
		{"workflow delete with mismatched confirm", http.MethodDelete, "/api/x/workflow?namespace=ns&workflowId=wf", "wf2", "r", http.StatusBadRequest},
		{"workflow delete without reason", http.MethodDelete, "/api/x/workflow?namespace=ns&workflowId=wf", "wf", "", http.StatusBadRequest},
		{"workflow delete with undecodable confirm", http.MethodDelete, "/api/x/workflow?namespace=ns&workflowId=wf", "%zz", "r", http.StatusBadRequest},
		{"namespace delete without confirm", http.MethodDelete, "/api/x/namespace?namespace=tui-test-x", "", "", http.StatusBadRequest},
		{"namespace delete of default", http.MethodDelete, "/api/x/namespace?namespace=default", "default", "", http.StatusForbidden},
		{"search attribute remove without confirm", http.MethodDelete, "/api/x/search-attributes?namespace=ns&name=A", "", "", http.StatusBadRequest},
		{"search attribute remove of a system attribute", http.MethodDelete, "/api/x/search-attributes?namespace=ns&name=WorkflowId", "WorkflowId", "", http.StatusForbidden},
		{"terminate without confirm", http.MethodPost, "/api/v1/namespaces/ns/workflows/wf/terminate", "", "", http.StatusBadRequest},
		{"batch terminate with mismatched confirm", http.MethodPost, "/api/v1/namespaces/ns/batch-operations/j", "k", "", http.StatusBadRequest},
		{"wrong method on a write route", http.MethodPost, "/api/x/namespace?namespace=tui-test-x", "tui-test-x", "", http.StatusMethodNotAllowed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env.Fake.Reset()
			body := ""
			switch {
			case strings.Contains(tc.path, "/terminate"):
				body = `{"reason":"r"}`
			case strings.Contains(tc.path, "/batch-operations/"):
				body = `{"reason":"r","visibilityQuery":"a=1","terminationOperation":{}}`
			}
			r := env.NewRequest(t, testutil.Admin, tc.method, tc.path, body)
			if tc.confirm != "" {
				r.Header.Set(authz.ConfirmHeader, tc.confirm)
			}
			if tc.reason != "" {
				r.Header.Set(authz.ReasonHeader, tc.reason)
			}
			w := env.Do(r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if len(env.Fake.Calls()) != 0 {
				t.Fatal("backend reached")
			}
		})
	}
}

func TestUnknownJSONFieldRejected(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	w := env.Do(env.NewRequest(t, testutil.Writer, http.MethodPost,
		"/api/v1/namespaces/ns/workflows/wf/terminate", `{"reason":"r","bogus":1}`))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":3`) {
		t.Fatalf("status %d body %s, want 400 code 3", w.Code, w.Body.String())
	}
	if len(env.Fake.Calls()) != 0 {
		t.Fatal("backend reached")
	}
}

func TestForbiddenVariantsOverHTTP(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	for _, tc := range []struct {
		name, path, body string
		want             int
	}{
		{"batch signal", "/api/v1/namespaces/ns/batch-operations/j", `{"reason":"r","visibilityQuery":"a=1","signalOperation":{}}`, http.StatusForbidden},
		{"batch deletion", "/api/v1/namespaces/ns/batch-operations/j", `{"reason":"r","visibilityQuery":"a=1","deletionOperation":{}}`, http.StatusForbidden},
		{"batch executions", "/api/v1/namespaces/ns/batch-operations/j", `{"reason":"r","visibilityQuery":"a=1","terminationOperation":{},"executions":[{"workflowId":"a"}]}`, http.StatusForbidden},
		{"batch empty query", "/api/v1/namespaces/ns/batch-operations/j", `{"reason":"r","terminationOperation":{}}`, http.StatusForbidden},
		{"batch empty reason", "/api/v1/namespaces/ns/batch-operations/j", `{"visibilityQuery":"a=1","terminationOperation":{}}`, http.StatusBadRequest},
		{"reset post-reset ops", "/api/v1/namespaces/ns/workflows/wf/reset", `{"reason":"r","postResetOperations":[{}]}`, http.StatusForbidden},
		{"reset empty reason", "/api/v1/namespaces/ns/workflows/wf/reset", `{}`, http.StatusBadRequest},
		{"terminate on temporal-system", "/api/v1/namespaces/temporal-system/workflows/wf/terminate", `{"reason":"r"}`, http.StatusForbidden},
		{"terminate empty reason", "/api/v1/namespaces/ns/workflows/wf/terminate", `{"reason":" "}`, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env.Fake.Reset()
			w := env.Do(env.NewRequest(t, testutil.Writer, http.MethodPost, tc.path, tc.body))
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
			if len(env.Fake.Calls()) != 0 {
				t.Fatal("backend reached")
			}
		})
	}
}

func TestForwardedHeadersStripped(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	r := env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/v1/namespaces/ns/workflows", "")
	r.Header.Set("Authorization", "Bearer secret")
	r.Header.Set("Grpc-Metadata-Foo", "bar")
	r.Header.Set("X-Foo", "baz")
	env.Do(r)
	calls := env.Fake.Calls()
	if len(calls) != 1 {
		t.Fatalf("backend calls = %d", len(calls))
	}
	for k := range calls[0].MD {
		switch k {
		case "client-name", "client-version", ":authority", "content-type", "user-agent":
		default:
			t.Errorf("metadata key %q reached Temporal", k)
		}
	}
}

// TestXAPIReadAllowed checks /api/x is open to readers and closed without a
// session. The interceptor-on-path proof lands with the real /api/x handlers.
func TestXAPIReadAllowed(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	if w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/x/me", "")); w.Code != http.StatusOK {
		t.Fatalf("/api/x/me as reader: %d", w.Code)
	}
	if w := env.Do(env.NewRequest(t, testutil.Nobody, http.MethodGet, "/api/x/me", "")); w.Code != http.StatusUnauthorized {
		t.Fatalf("/api/x/me without session: %d", w.Code)
	}
}

func TestNamespacesListHidesSystemOverHTTP(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	env.Fake.SetResponder(func(_ context.Context, method string, _ any) (any, error, bool) {
		if !strings.HasSuffix(method, "/ListNamespaces") {
			return nil, nil, false
		}
		resp := &workflowservice.ListNamespacesResponse{}
		for _, n := range []string{"temporal-system", "default"} {
			resp.Namespaces = append(resp.Namespaces, &workflowservice.DescribeNamespaceResponse{NamespaceInfo: &namespacepb.NamespaceInfo{Name: n}})
		}
		return resp, nil, true
	})
	w := env.Do(env.NewRequest(t, testutil.Reader, http.MethodGet, "/api/v1/namespaces", ""))
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "temporal-system") || !strings.Contains(w.Body.String(), `"default"`) {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
}

// TestXAPINamespaceDeleteSurvivesDisconnect: a client that disconnects
// during DELETE /api/x/namespace does not cancel the Temporal call, and the
// audit line has the real result.
func TestXAPINamespaceDeleteSurvivesDisconnect(t *testing.T) {
	env := testutil.NewEnv(t, nil)
	started, release := make(chan struct{}, 1), make(chan struct{})
	backendCode := make(chan string, 1)
	env.Fake.SetResponder(func(ctx context.Context, method string, req any) (any, error, bool) {
		if resp, err, ok := testutil.LiveNamespace(ctx, method, req); ok {
			return resp, err, ok
		}
		started <- struct{}{}
		select {
		case <-release:
			backendCode <- "OK"
			return &operatorservice.DeleteNamespaceResponse{DeletedNamespace: "tui-test-x-deleted"}, nil, true
		case <-ctx.Done():
			backendCode <- "Canceled"
			return nil, ctx.Err(), true
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	r := env.NewRequest(t, testutil.Admin, http.MethodDelete, "/api/x/namespace?namespace=tui-test-x", "").WithContext(ctx)
	r.Header.Set(authz.ConfirmHeader, "tui-test-x")
	done := make(chan struct{})
	go func() { env.Do(r); close(done) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("backend never called")
	}
	cancel()
	time.Sleep(100 * time.Millisecond)
	close(release)
	<-done
	if got := <-backendCode; got != "OK" {
		t.Fatalf("backend call ended with %s, want OK", got)
	}
	if logs := env.Logs(); !strings.Contains(logs, `"method":"DeleteNamespace"`) || !strings.Contains(logs, `"code":"OK"`) {
		t.Fatalf("audit lacks the real result: %s", logs)
	}
}

// TestConsoleRouteMatrix sends every console method through
// /api/x/console/invoke as every role: each role gets exactly its RPC class,
// and Temporal is called only when allowed.
func TestConsoleRouteMatrix(t *testing.T) {
	cfg := testutil.AuthConfig(t)
	cfg.Limits.XAPIRPS = 1000
	env := testutil.NewEnv(t, cfg)
	env.Fake.SetResponder(testutil.LiveNamespace)
	methods := authz.ConsoleMethods()
	if len(methods) < 50 {
		t.Fatalf("console allowlist too small: %d", len(methods))
	}
	for _, m := range methods {
		req, _ := newRequest(t, m.Method)
		reqJSON, err := temporalproto.CustomJSONMarshalOptions{}.Marshal(req)
		if err != nil {
			t.Fatalf("%s: marshal: %v", m.Name, err)
		}
		body := `{"method":"` + m.Method + `","request":` + string(reqJSON) + `}`
		in := authz.IntentFrom(confirmed(context.Background(), m.Method, req))
		rule, _ := authz.Lookup(m.Method)
		if rule.DynamicClass != nil {
			rule.Class = rule.DynamicClass(req)
		}
		for _, who := range []testutil.Who{testutil.Nobody, testutil.Reader, testutil.Writer, testutil.Admin} {
			env.Fake.Reset()
			r := env.NewRequest(t, who, http.MethodPost, "/api/x/console/invoke", body)
			if in.HasConfirm {
				r.Header.Set(authz.ConfirmHeader, url.PathEscape(in.Confirm))
			}
			r.Header.Set(authz.ReasonHeader, in.Reason)
			w := env.Do(r)
			calls := testutil.WithoutNamespaceCheck(env.Fake.Calls())
			switch {
			case who == testutil.Nobody:
				if w.Code != http.StatusUnauthorized || len(calls) != 0 {
					t.Errorf("no session %s: status %d, %d backend calls", m.Name, w.Code, len(calls))
				}
			case !allowedFor(rule.Class, who):
				if w.Code != http.StatusForbidden || len(calls) != 0 {
					t.Errorf("who=%d %s: status %d (%s), %d backend calls; want 403 and none", who, m.Name, w.Code, w.Body.String(), len(calls))
				}
			default:
				if len(calls) != 1 || calls[0].Method != m.Method {
					t.Errorf("who=%d %s: status %d (%s), backend calls %v; want %s", who, m.Name, w.Code, w.Body.String(), calls, m.Method)
				}
			}
		}
	}
}
