// Package audit writes one structured JSON line per write, denial, login and
// logout. Payload contents are never logged.
package audit

import (
	"context"
	"log/slog"
)

// Event types.
const (
	EventWrite       = "write"
	EventDeny        = "deny"
	EventLogin       = "login"
	EventLoginDenied = "login_denied"
	EventLogout      = "logout"
)

// Event is one audit line. Empty fields are omitted.
type Event struct {
	Event      string
	User       string
	Role       string
	Method     string
	Namespace  string
	WorkflowID string
	RunID      string
	ScheduleID string
	JobID      string
	BatchOp    string
	Reason     string
	// Target is the confirmed target of a destructive action.
	Target     string
	Code       string
	DurationMs int64
}

// Logger emits audit events through slog.
type Logger struct {
	log *slog.Logger
}

// New returns an audit logger writing to log.
func New(log *slog.Logger) *Logger { return &Logger{log: log} }

// Log writes e at INFO level with "audit": true.
func (a *Logger) Log(e Event) {
	attrs := []slog.Attr{slog.Bool("audit", true), slog.String("event", e.Event)}
	for _, f := range []struct{ k, v string }{
		{"user", e.User}, {"role", e.Role}, {"method", e.Method}, {"namespace", e.Namespace},
		{"workflowId", e.WorkflowID}, {"runId", e.RunID}, {"scheduleId", e.ScheduleID},
		{"jobId", e.JobID}, {"batchOp", e.BatchOp}, {"reason", e.Reason}, {"target", e.Target}, {"code", e.Code},
	} {
		if f.v != "" {
			attrs = append(attrs, slog.String(f.k, f.v))
		}
	}
	if e.Event == EventWrite || e.Event == EventDeny {
		attrs = append(attrs, slog.Int64("durationMs", e.DurationMs))
	}
	a.log.LogAttrs(context.Background(), slog.LevelInfo, "audit", attrs...)
}
