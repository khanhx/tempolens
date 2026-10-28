package main

import (
	"errors"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// BigPayload carries a large JSON body and an int64 above 2^53 so that the UI's
// bigint-safe decoding is exercised.
type BigPayload struct {
	ID   int64  `json:"id"`
	Blob string `json:"blob"`
}

// SeedWaiting runs until the "finish" signal arrives. While it waits, a heartbeating
// activity sleeps for an hour. It serves the running, disposable and parent-child cases.
func SeedWaiting(ctx workflow.Context) (string, error) {
	state := "waiting"
	if err := workflow.SetQueryHandler(ctx, "state", func() (string, error) { return state, nil }); err != nil {
		return "", err
	}
	if err := workflow.SetUpdateHandler(ctx, "setValue", func(_ workflow.Context, v string) (string, error) {
		old := state
		state = v
		return old, nil
	}); err != nil {
		return "", err
	}

	actCtx, cancel := workflow.WithCancel(ctx)
	defer cancel()
	sleep := workflow.ExecuteActivity(workflow.WithActivityOptions(actCtx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Hour,
		HeartbeatTimeout:    30 * time.Second,
	}), SleepHeartbeat, time.Hour)

	finished := false
	workflow.Go(ctx, func(gctx workflow.Context) {
		workflow.GetSignalChannel(gctx, "finish").Receive(gctx, nil)
		finished = true
	})
	if err := workflow.Await(ctx, func() bool { return finished }); err != nil {
		return "", err
	}
	cancel()
	_ = sleep.Get(ctx, nil)
	return "finished", nil
}

// SeedWaitForSignal blocks until "finish" arrives or the run is cancelled, terminated or timed out.
func SeedWaitForSignal(ctx workflow.Context) error {
	finished := false
	workflow.Go(ctx, func(gctx workflow.Context) {
		workflow.GetSignalChannel(gctx, "finish").Receive(gctx, nil)
		finished = true
	})
	return workflow.Await(ctx, func() bool { return finished })
}

// SeedStuck keeps retrying an activity that always fails, so the pending attempt count grows.
func SeedStuck(ctx workflow.Context) error {
	actCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 1,
			MaximumAttempts:    0,
		},
	})
	return workflow.ExecuteActivity(actCtx, AlwaysFail).Get(ctx, nil)
}

// SeedGreet completes after one activity call.
func SeedGreet(ctx workflow.Context, name string) (string, error) {
	var out string
	err := workflow.ExecuteActivity(workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
	}), Greet, name).Get(ctx, &out)
	return out, err
}

// SeedFailing exhausts two activity attempts, then fails the workflow.
func SeedFailing(ctx workflow.Context) error {
	actCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 1,
			MaximumAttempts:    2,
		},
	})
	if err := workflow.ExecuteActivity(actCtx, AlwaysFail).Get(ctx, nil); err != nil {
		return errors.New("seed: intentional failure")
	}
	return nil
}

// SeedParent starts two children; the first child starts a grandchild. All complete.
func SeedParent(ctx workflow.Context) error {
	childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		TaskQueue: taskQueue,
	})
	a := workflow.ExecuteChildWorkflow(childCtx, SeedChild, 1)
	b := workflow.ExecuteChildWorkflow(childCtx, SeedChild, 0)
	if err := a.Get(ctx, nil); err != nil {
		return err
	}
	return b.Get(ctx, nil)
}

// SeedChild completes after an optional grandchild, one level per depth.
func SeedChild(ctx workflow.Context, depth int) error {
	if depth <= 0 {
		return nil
	}
	return workflow.ExecuteChildWorkflow(workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		TaskQueue: taskQueue,
	}), SeedChild, depth-1).Get(ctx, nil)
}

// SeedParentRunning keeps a child waiting on a signal, so both the parent and the child stay Running.
func SeedParentRunning(ctx workflow.Context) error {
	return workflow.ExecuteChildWorkflow(workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		TaskQueue:  taskQueue,
		WorkflowID: "seed-parent-running-1-child",
	}), SeedWaitForSignal).Get(ctx, nil)
}

// SeedContinueAsNew continues as new until n reaches 3, giving a chain of four runs.
func SeedContinueAsNew(ctx workflow.Context, n int) error {
	if n < 3 {
		return workflow.NewContinueAsNewError(ctx, SeedContinueAsNew, n+1)
	}
	return nil
}

// SeedSignaler signals a running workflow and requests cancellation of another one.
func SeedSignaler(ctx workflow.Context) error {
	if err := workflow.SignalExternalWorkflow(ctx, "seed-running-1", "", "note", "from seed-signaler-1").Get(ctx, nil); err != nil {
		return err
	}
	return workflow.RequestCancelExternalWorkflow(ctx, "seed-cancel-target-1", "").Get(ctx, nil)
}

// SeedBig returns the input unchanged, so the input and result are both large.
func SeedBig(_ workflow.Context, in BigPayload) (BigPayload, error) {
	return in, nil
}

// SeedVolume is a trivial workflow used to fill pagination and sort windows.
func SeedVolume(_ workflow.Context, _ int) error {
	return nil
}

// SeedScheduled is the action of the seed schedules.
func SeedScheduled(_ workflow.Context) error {
	return nil
}
