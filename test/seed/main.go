// Command seed populates the local Temporal with the Tempolens UI test matrix.
// LOCAL TEST ONLY. It runs against TEMPORAL_ADDRESS (default localhost:7233).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"google.golang.org/protobuf/types/known/durationpb"
)

const (
	taskQueue        = "tempolens-seed"
	namespaceA       = "tui-seed-a"
	namespaceB       = "tui-seed-b"
	disposablePrefix = "tempolens-e2e-disposable-"
	volumeCount      = 300
)

// Search attribute names, created per seed namespace with `temporal operator search-attribute create`.
const (
	searchAttrRun      = "SeedRun"
	searchAttrPriority = "SeedPriority"
	searchAttrCustomer = "SeedCustomer"
)

var customers = []string{"acme", "globex", "initech"}

// memoFixtures are the memo values of the seed-memo workflows, one map per workflow in order. The
// priorities sort as 1, 2, 5, 10 numerically and as 1, 10, 2, 5 as text, so a numeric sort and a
// text sort give different orders. The first two fixtures also start in tui-seed-b.
var memoFixtures = []map[string]any{
	{"owner": "alice", "priority": 2, "tags": []string{"blue"}, "team,region": "payments,eu", "deploy": map[string]any{"env": "dev"}},
	{"owner": "bob", "priority": 10, "tags": []string{"green", "red"}, "team,region": "payments,us", "deploy": map[string]any{"env": "prod"}},
	{"owner": "carol", "priority": 1, "tags": []string{"red"}, "team,region": "search,eu", "deploy": map[string]any{"env": "staging"}},
	{"owner": "dave", "priority": 5, "tags": []string{}, "team,region": "search,us", "deploy": map[string]any{"env": "prod"}},
}

// memoID is the workflow ID of memo fixture i (1-based), scoped to the run ID.
func memoID(runID string, i int) string {
	return fmt.Sprintf("seed-memo-%s-%d", runID, i)
}

// customerAttrs tags a workflow with a customer, cycling through the fixed list.
func customerAttrs(i int) map[string]any {
	return map[string]any{searchAttrCustomer: customers[i%len(customers)]}
}

// runAttrs tags a run-scoped workflow with its run ID and a priority.
func runAttrs(runID string, priority int) map[string]any {
	return map[string]any{searchAttrRun: runID, searchAttrPriority: int64(priority), searchAttrCustomer: "acme"}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: seed {seed|reset-disposables|worker|verify} [flags]")
		os.Exit(2)
	}
	ctx := context.Background()
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	runID := fs.String("run-id", defaultRunID(), "run ID used for the run-scoped sets")
	count := fs.Int("count", 10, "number of disposable runs (reset-disposables)")
	_ = fs.Parse(os.Args[2:])

	var err error
	switch os.Args[1] {
	case "seed":
		err = seed(ctx, *runID)
	case "reset-disposables":
		err = resetDisposables(ctx, *runID, *count)
	case "worker":
		err = runWorkers()
	case "verify":
		err = verify(ctx, *runID)
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func defaultRunID() string {
	return time.Now().UTC().Format("20060102-150405")
}

func temporalAddress() string {
	if v := os.Getenv("TEMPORAL_ADDRESS"); v != "" {
		return v
	}
	return "localhost:7233"
}

func dial(namespace string) (client.Client, error) {
	return client.Dial(client.Options{HostPort: temporalAddress(), Namespace: namespace})
}

// ensureNamespace registers the namespace (ignoring AlreadyExists) and polls until it serves requests.
func ensureNamespace(ctx context.Context, namespace string) error {
	nc, err := client.NewNamespaceClient(client.Options{HostPort: temporalAddress()})
	if err != nil {
		return err
	}
	defer nc.Close()
	err = nc.Register(ctx, &workflowservice.RegisterNamespaceRequest{
		Namespace:                        namespace,
		WorkflowExecutionRetentionPeriod: durationpb.New(24 * time.Hour),
	})
	var exists *serviceerror.NamespaceAlreadyExists
	if err != nil && !errors.As(err, &exists) {
		return fmt.Errorf("register %s: %w", namespace, err)
	}

	c, err := dial(namespace)
	if err != nil {
		return err
	}
	defer c.Close()
	deadline := time.Now().Add(60 * time.Second)
	for {
		_, descErr := nc.Describe(ctx, namespace)
		_, listErr := c.ListWorkflow(ctx, &workflowservice.ListWorkflowExecutionsRequest{Namespace: namespace, PageSize: 1})
		if descErr == nil && listErr == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("namespace %s not ready: describe=%v list=%v", namespace, descErr, listErr)
		}
		time.Sleep(2 * time.Second)
	}
}

// startFixed starts a workflow unless the ID already has a run. It reports whether a new run started.
// The existence check comes first because the SDK does not report a duplicate start as an error.
func startFixed(ctx context.Context, c client.Client, id string, fn any, reuse enumspb.WorkflowIdReusePolicy, attrs, memo map[string]any, timeout time.Duration, args ...any) (bool, error) {
	_, err := c.DescribeWorkflowExecution(ctx, id, "")
	var notFound *serviceerror.NotFound
	if err == nil {
		return false, nil
	}
	if !errors.As(err, &notFound) {
		return false, fmt.Errorf("describe %s: %w", id, err)
	}
	return true, startRun(ctx, c, id, fn, reuse, attrs, memo, timeout, args...)
}

// startRun starts a run unconditionally, subject to the ID reuse policy.
func startRun(ctx context.Context, c client.Client, id string, fn any, reuse enumspb.WorkflowIdReusePolicy, attrs, memo map[string]any, timeout time.Duration, args ...any) error {
	opts := client.StartWorkflowOptions{
		ID:                       id,
		TaskQueue:                taskQueue,
		WorkflowIDReusePolicy:    reuse,
		SearchAttributes:         attrs,
		Memo:                     memo,
		WorkflowExecutionTimeout: timeout,
	}
	if _, err := c.ExecuteWorkflow(ctx, opts, fn, args...); err != nil {
		return fmt.Errorf("start %s: %w", id, err)
	}
	return nil
}

type counter struct {
	started int
	skipped int
}

func (k *counter) record(id string, started bool, err error) error {
	if err != nil {
		return err
	}
	if started {
		k.started++
		fmt.Printf("  started %s\n", id)
	} else {
		k.skipped++
	}
	return nil
}

func seed(ctx context.Context, runID string) error {
	for _, ns := range []string{namespaceA, namespaceB} {
		if err := ensureNamespace(ctx, ns); err != nil {
			return err
		}
	}
	ca, err := dial(namespaceA)
	if err != nil {
		return err
	}
	defer ca.Close()
	cb, err := dial(namespaceB)
	if err != nil {
		return err
	}
	defer cb.Close()

	k := &counter{}
	reject := enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE
	start := func(c client.Client, id string, fn any, attrs map[string]any, timeout time.Duration, args ...any) error {
		started, err := startFixed(ctx, c, id, fn, reject, attrs, nil, timeout, args...)
		return k.record(id, started, err)
	}
	startMemo := func(c client.Client, id string, memo map[string]any) error {
		started, err := startFixed(ctx, c, id, SeedMemo, reject, map[string]any{searchAttrRun: runID}, memo, 0)
		return k.record(id, started, err)
	}

	// Running and completed workflows, in both seed namespaces.
	for _, c := range []client.Client{ca, cb} {
		for i := 1; i <= 3; i++ {
			if err := start(c, fmt.Sprintf("seed-running-%d", i), SeedWaiting, customerAttrs(i), 0); err != nil {
				return err
			}
		}
		for i := 1; i <= 5; i++ {
			if err := start(c, fmt.Sprintf("seed-completed-%d", i), SeedGreet, customerAttrs(i), 0, fmt.Sprintf("seed-%d", i)); err != nil {
				return err
			}
		}
	}

	// Namespace A only: the rest of the matrix.
	cancelTarget := "seed-cancel-target-1"
	if err := start(ca, "seed-stuck-1", SeedStuck, nil, 0); err != nil {
		return err
	}
	if err := start(ca, cancelTarget, SeedWaitForSignal, nil, 0); err != nil {
		return err
	}
	if err := start(ca, "seed-parent-1", SeedParent, nil, 0); err != nil {
		return err
	}
	if err := start(ca, "seed-parent-running-1", SeedParentRunning, nil, 0); err != nil {
		return err
	}
	if err := start(ca, "seed-can-1", SeedContinueAsNew, nil, 0, 0); err != nil {
		return err
	}
	if err := start(ca, "seed-reset-1", SeedGreet, nil, 0, "seed-reset"); err != nil {
		return err
	}
	big := BigPayload{ID: 9007199254740993, Blob: strings.Repeat("x", 100*1024)}
	if err := start(ca, "seed-bigpayload-1", SeedBig, nil, 0, big); err != nil {
		return err
	}
	// Signals and cancels the running and cancel-target workflows, so it runs after both exist.
	if err := start(ca, "seed-signaler-1", SeedSignaler, nil, 0); err != nil {
		return err
	}
	// Terminated is started and then terminated by the seeder, once, on the first seed.
	terminatedStarted, err := startFixed(ctx, ca, "seed-terminated-1", SeedWaitForSignal, reject, nil, nil, 0)
	if err := k.record("seed-terminated-1", terminatedStarted, err); err != nil {
		return err
	}
	if terminatedStarted {
		if err := ca.TerminateWorkflow(ctx, "seed-terminated-1", "", "seed: intentional termination"); err != nil {
			return fmt.Errorf("terminate seed-terminated-1: %w", err)
		}
	}

	// Run-scoped failed and timeout sets, one fresh set per run ID.
	for i := 1; i <= 3; i++ {
		id := fmt.Sprintf("seed-failed-%s-%d", runID, i)
		if err := start(ca, id, SeedFailing, runAttrs(runID, i), 0); err != nil {
			return err
		}
	}
	if err := start(ca, fmt.Sprintf("seed-timeout-%s-1", runID), SeedWaitForSignal, runAttrs(runID, 1), 5*time.Second); err != nil {
		return err
	}

	// Memo set: run-scoped, with memo values for the table columns. Only the first two also start in
	// tui-seed-b, for the all-namespaces view. A parent runs one child, for the parent and root columns.
	for i, memo := range memoFixtures {
		if err := startMemo(ca, memoID(runID, i+1), memo); err != nil {
			return err
		}
		if i < 2 {
			if err := startMemo(cb, memoID(runID, i+1), memo); err != nil {
				return err
			}
		}
	}
	if err := start(ca, fmt.Sprintf("seed-memo-parent-%s", runID), SeedMemoParent, map[string]any{searchAttrRun: runID}, 0, runID); err != nil {
		return err
	}

	// Volume set, skipped when it is already complete.
	existingVolume, err := countWorkflows(ctx, ca, namespaceA, "WorkflowType = 'SeedVolume' AND ExecutionStatus = 'Completed'")
	if err != nil {
		return err
	}
	if existingVolume < volumeCount {
		for i := 1; i <= volumeCount; i++ {
			if err := start(ca, fmt.Sprintf("seed-volume-%04d", i), SeedVolume, nil, 0, i); err != nil {
				return err
			}
		}
	}

	if err := ensureSchedule(ctx, ca, "tempolens-seed-sched-active", time.Hour, false); err != nil {
		return err
	}
	if err := ensureSchedule(ctx, ca, "tempolens-seed-sched-paused", time.Hour, true); err != nil {
		return err
	}

	// The reset target must complete before it can be reset.
	if err := resetCompletedWorkflow(ctx, ca, namespaceA, "seed-reset-1"); err != nil {
		return err
	}

	fmt.Printf("seed complete: run-id=%s started=%d already-seeded=%d\n", runID, k.started, k.skipped)
	return nil
}

func countWorkflows(ctx context.Context, c client.Client, namespace, query string) (int64, error) {
	resp, err := c.CountWorkflow(ctx, &workflowservice.CountWorkflowExecutionsRequest{Namespace: namespace, Query: query})
	if err != nil {
		return 0, err
	}
	return resp.GetCount(), nil
}

func ensureSchedule(ctx context.Context, c client.Client, id string, every time.Duration, paused bool) error {
	sc := c.ScheduleClient()
	handle := sc.GetHandle(ctx, id)
	_, err := handle.Describe(ctx)
	if err == nil {
		fmt.Printf("  schedule exists %s\n", id)
		return nil
	}
	var notFound *serviceerror.NotFound
	if !errors.As(err, &notFound) {
		return fmt.Errorf("describe schedule %s: %w", id, err)
	}
	_, err = sc.Create(ctx, client.ScheduleOptions{
		ID:     id,
		Spec:   client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: every}}},
		Paused: paused,
		Action: &client.ScheduleWorkflowAction{
			ID:        id + "-run",
			Workflow:  SeedScheduled,
			TaskQueue: taskQueue,
		},
	})
	if err != nil {
		return fmt.Errorf("create schedule %s: %w", id, err)
	}
	fmt.Printf("  created schedule %s (paused=%t)\n", id, paused)
	return nil
}

// resetCompletedWorkflow resets a completed workflow to its first workflow task, once.
// A second run already in the chain means the reset was done earlier.
func resetCompletedWorkflow(ctx context.Context, c client.Client, namespace, id string) error {
	runs, err := countWorkflows(ctx, c, namespace, fmt.Sprintf("WorkflowId = '%s'", id))
	if err != nil {
		return err
	}
	if runs >= 2 {
		return nil
	}
	deadline := time.Now().Add(60 * time.Second)
	var baseRun string
	for {
		desc, err := c.DescribeWorkflowExecution(ctx, id, "")
		if err != nil {
			return fmt.Errorf("describe %s: %w", id, err)
		}
		if desc.GetWorkflowExecutionInfo().GetStatus() == enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED {
			baseRun = desc.GetWorkflowExecutionInfo().GetExecution().GetRunId()
			break
		}
		if time.Now().After(deadline) {
			fmt.Printf("  warning: %s not completed within 60s; reset deferred, rerun seed with the worker running\n", id)
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	finishEventID, err := firstWorkflowTaskCompletedEventID(ctx, c, id, baseRun)
	if err != nil {
		return err
	}
	_, err = c.WorkflowService().ResetWorkflowExecution(ctx, &workflowservice.ResetWorkflowExecutionRequest{
		Namespace:                 namespace,
		WorkflowExecution:         &commonpb.WorkflowExecution{WorkflowId: id, RunId: baseRun},
		Reason:                    "seed reset-lineage",
		WorkflowTaskFinishEventId: finishEventID,
		RequestId:                 "seed-reset-" + baseRun,
	})
	if err != nil {
		return fmt.Errorf("reset %s: %w", id, err)
	}
	fmt.Printf("  reset %s from run %s\n", id, baseRun)
	return nil
}

func firstWorkflowTaskCompletedEventID(ctx context.Context, c client.Client, id, runID string) (int64, error) {
	iter := c.GetWorkflowHistory(ctx, id, runID, false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	for iter.HasNext() {
		ev, err := iter.Next()
		if err != nil {
			return 0, err
		}
		if ev.GetEventType() == enumspb.EVENT_TYPE_WORKFLOW_TASK_COMPLETED {
			return ev.GetEventId(), nil
		}
	}
	return 0, fmt.Errorf("no WorkflowTaskCompleted event in %s/%s", id, runID)
}

// listRunningWithPrefix returns the running execution IDs in the namespace that start with prefix.
func listRunningWithPrefix(ctx context.Context, c client.Client, namespace, prefix string) ([]string, error) {
	query := fmt.Sprintf("ExecutionStatus = 'Running' AND WorkflowType = '%s'", "SeedWaiting")
	var ids []string
	var token []byte
	for {
		resp, err := c.ListWorkflow(ctx, &workflowservice.ListWorkflowExecutionsRequest{
			Namespace:     namespace,
			PageSize:      100,
			Query:         query,
			NextPageToken: token,
		})
		if err != nil {
			return nil, err
		}
		for _, ex := range resp.GetExecutions() {
			if id := ex.GetExecution().GetWorkflowId(); strings.HasPrefix(id, prefix) {
				ids = append(ids, id)
			}
		}
		token = resp.GetNextPageToken()
		if len(token) == 0 {
			return ids, nil
		}
	}
}

func resetDisposables(ctx context.Context, runID string, count int) error {
	if err := ensureNamespace(ctx, namespaceA); err != nil {
		return err
	}
	c, err := dial(namespaceA)
	if err != nil {
		return err
	}
	defer c.Close()

	running, err := listRunningWithPrefix(ctx, c, namespaceA, disposablePrefix)
	if err != nil {
		return err
	}
	for _, id := range running {
		if err := c.TerminateWorkflow(ctx, id, "", "seed reset"); err != nil {
			return fmt.Errorf("terminate %s: %w", id, err)
		}
	}
	// Wait until the terminated runs are closed, so the fresh starts do not collide.
	deadline := time.Now().Add(30 * time.Second)
	for {
		still, err := listRunningWithPrefix(ctx, c, namespaceA, disposablePrefix)
		if err != nil {
			return err
		}
		if len(still) == 0 {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%d disposable runs still open after terminate", len(still))
		}
		time.Sleep(time.Second)
	}

	reuse := enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE
	for i := 1; i <= count; i++ {
		attrs := runAttrs(runID, i)
		if err := startRun(ctx, c, fmt.Sprintf("%s%d", disposablePrefix, i), SeedWaiting, reuse, attrs, nil, 0); err != nil {
			return err
		}
	}
	fmt.Printf("reset-disposables: terminated=%d started=%d run-id=%s\n", len(running), count, runID)
	return nil
}

func runWorkers() error {
	var clients []client.Client
	var workers []worker.Worker
	for _, ns := range []string{namespaceA, namespaceB} {
		c, err := dial(ns)
		if err != nil {
			return err
		}
		clients = append(clients, c)
		w := worker.New(c, taskQueue, worker.Options{})
		for _, fn := range []any{SeedWaiting, SeedWaitForSignal, SeedStuck, SeedGreet, SeedFailing, SeedParent, SeedChild,
			SeedParentRunning, SeedContinueAsNew, SeedSignaler, SeedBig, SeedVolume, SeedMemo, SeedMemoParent, SeedScheduled} {
			w.RegisterWorkflow(fn)
		}
		for _, fn := range []any{SleepHeartbeat, AlwaysFail, Greet} {
			w.RegisterActivity(fn)
		}
		if err := w.Start(); err != nil {
			return fmt.Errorf("start worker for %s: %w", ns, err)
		}
		workers = append(workers, w)
		fmt.Printf("worker started: namespace=%s queue=%s\n", ns, taskQueue)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	for _, w := range workers {
		w.Stop()
	}
	for _, c := range clients {
		c.Close()
	}
	return nil
}

// expectation is one row of the matrix that verify checks.
type expectation struct {
	namespace string
	id        string
	status    string // SCREAMING_SNAKE status name without the enum prefix, e.g. RUNNING
}

func fixedExpectations(runID string) []expectation {
	var out []expectation
	add := func(ns, id, status string) { out = append(out, expectation{ns, id, status}) }
	for _, ns := range []string{namespaceA, namespaceB} {
		for i := 1; i <= 3; i++ {
			add(ns, fmt.Sprintf("seed-running-%d", i), "RUNNING")
		}
		for i := 1; i <= 5; i++ {
			add(ns, fmt.Sprintf("seed-completed-%d", i), "COMPLETED")
		}
	}
	add(namespaceA, "seed-stuck-1", "RUNNING")
	add(namespaceA, "seed-terminated-1", "TERMINATED")
	add(namespaceA, "seed-parent-1", "COMPLETED")
	add(namespaceA, "seed-parent-running-1", "RUNNING")
	add(namespaceA, "seed-can-1", "COMPLETED")
	add(namespaceA, "seed-signaler-1", "COMPLETED")
	add(namespaceA, "seed-cancel-target-1", "CANCELED")
	add(namespaceA, "seed-reset-1", "COMPLETED")
	add(namespaceA, "seed-bigpayload-1", "COMPLETED")
	for i := 1; i <= 3; i++ {
		add(namespaceA, fmt.Sprintf("seed-failed-%s-%d", runID, i), "FAILED")
	}
	add(namespaceA, fmt.Sprintf("seed-timeout-%s-1", runID), "TIMED_OUT")
	for i := 1; i <= len(memoFixtures); i++ {
		add(namespaceA, memoID(runID, i), "COMPLETED")
		if i <= 2 {
			add(namespaceB, memoID(runID, i), "COMPLETED")
		}
	}
	add(namespaceA, fmt.Sprintf("seed-memo-parent-%s", runID), "COMPLETED")
	add(namespaceA, fmt.Sprintf("seed-memo-parent-%s-child", runID), "COMPLETED")
	return out
}

func verify(ctx context.Context, runID string) error {
	var problems []string
	clients := map[string]client.Client{}
	for _, ns := range []string{namespaceA, namespaceB} {
		c, err := dial(ns)
		if err != nil {
			return err
		}
		defer c.Close()
		clients[ns] = c
	}

	for _, e := range fixedExpectations(runID) {
		c := clients[e.namespace]
		want := enumspb.WorkflowExecutionStatus(enumspb.WorkflowExecutionStatus_value["WORKFLOW_EXECUTION_STATUS_"+e.status])
		// Timers such as the 5 s workflow timeout fire after seed returns, so a fresh seed needs a short wait.
		deadline := time.Now().Add(30 * time.Second)
		for {
			desc, err := c.DescribeWorkflowExecution(ctx, e.id, "")
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s/%s: missing (%v)", e.namespace, e.id, err))
				break
			}
			got := desc.GetWorkflowExecutionInfo().GetStatus()
			if got == want {
				break
			}
			if time.Now().After(deadline) {
				problems = append(problems, fmt.Sprintf("%s/%s: status %s, want %s", e.namespace, e.id, got, e.status))
				break
			}
			time.Sleep(time.Second)
		}
	}

	ca := clients[namespaceA]
	if runs, err := countWorkflows(ctx, ca, namespaceA, "WorkflowId = 'seed-can-1'"); err != nil {
		return err
	} else if runs != 4 {
		problems = append(problems, fmt.Sprintf("seed-can-1: %d runs, want 4", runs))
	}
	if runs, err := countWorkflows(ctx, ca, namespaceA, "WorkflowId = 'seed-reset-1'"); err != nil {
		return err
	} else if runs < 2 {
		problems = append(problems, fmt.Sprintf("seed-reset-1: %d runs, want at least 2 (base + reset)", runs))
	}
	if n, err := countWorkflows(ctx, ca, namespaceA, "WorkflowType = 'SeedVolume' AND ExecutionStatus = 'Completed'"); err != nil {
		return err
	} else if n < volumeCount {
		problems = append(problems, fmt.Sprintf("volume set: %d completed, want %d", n, volumeCount))
	}

	// The run-scoped sets must carry SeedRun = run ID. Disposables share the run ID too, so count by type.
	for _, want := range []struct {
		workflowType string
		count        int64
	}{{"SeedFailing", 3}, {"SeedWaitForSignal", 1}, {"SeedMemo", int64(len(memoFixtures))}} {
		query := fmt.Sprintf("%s = '%s' AND WorkflowType = '%s'", searchAttrRun, runID, want.workflowType)
		if n, err := countWorkflows(ctx, ca, namespaceA, query); err != nil {
			return err
		} else if n != want.count {
			problems = append(problems, fmt.Sprintf("SeedRun=%s %s: %d workflows, want %d", runID, want.workflowType, n, want.count))
		}
	}

	// Each memo workflow must carry every fixture key, including the key with a comma.
	for i, memo := range memoFixtures {
		desc, err := ca.DescribeWorkflowExecution(ctx, memoID(runID, i+1), "")
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: missing (%v)", memoID(runID, i+1), err))
			continue
		}
		for key := range memo {
			if _, ok := desc.GetWorkflowExecutionInfo().GetMemo().GetFields()[key]; !ok {
				problems = append(problems, fmt.Sprintf("%s: memo key %q missing", memoID(runID, i+1), key))
			}
		}
	}

	for id, paused := range map[string]bool{"tempolens-seed-sched-active": false, "tempolens-seed-sched-paused": true} {
		desc, err := ca.ScheduleClient().GetHandle(ctx, id).Describe(ctx)
		if err != nil {
			problems = append(problems, fmt.Sprintf("schedule %s: missing (%v)", id, err))
			continue
		}
		if desc.Schedule.State.Paused != paused {
			problems = append(problems, fmt.Sprintf("schedule %s: paused=%t, want %t", id, desc.Schedule.State.Paused, paused))
		}
	}

	printCounts(ctx, clients)

	if len(problems) > 0 {
		for _, p := range problems {
			fmt.Fprintln(os.Stderr, "MISSING/MISMATCH:", p)
		}
		return fmt.Errorf("verify failed: %d problem(s)", len(problems))
	}
	fmt.Printf("verify OK: run-id=%s, %d fixed expectations, schedules and volume checked\n", runID, len(fixedExpectations(runID)))
	return nil
}

func printCounts(ctx context.Context, clients map[string]client.Client) {
	statuses := []string{"Running", "Completed", "Failed", "TimedOut", "Terminated", "Canceled", "ContinuedAsNew"}
	for _, ns := range []string{namespaceA, namespaceB} {
		var parts []string
		for _, s := range statuses {
			n, err := countWorkflows(ctx, clients[ns], ns, fmt.Sprintf("ExecutionStatus = '%s'", s))
			if err != nil {
				n = -1
			}
			parts = append(parts, fmt.Sprintf("%s=%d", s, n))
		}
		fmt.Printf("counts %s: %s\n", ns, strings.Join(parts, " "))
	}
}
