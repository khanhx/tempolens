package main

import (
	"context"
	"errors"
	"time"

	"go.temporal.io/sdk/activity"
)

// SleepHeartbeat sleeps for d, heartbeating every 5 s. It returns early when cancelled.
func SleepHeartbeat(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		case <-tick.C:
			activity.RecordHeartbeat(ctx, time.Now().UTC().Format(time.RFC3339))
		}
	}
}

// AlwaysFail is the failing activity used by the stuck and failed workflows.
func AlwaysFail(_ context.Context) error {
	return errors.New("seed: intentional activity failure")
}

// Greet is the trivial activity used by the completed workflows.
func Greet(_ context.Context, name string) (string, error) {
	return "hello, " + name, nil
}
