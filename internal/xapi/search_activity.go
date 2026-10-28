package xapi

import (
	"context"
	"net/http"
	"strconv"

	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/workflowservice/v1"
)

// searchActivity finds workflows by activity type: pending activities of
// running workflows (optionally stuck at attempt >= minAttempt), or
// ActivityTaskScheduled events in any workflow's history.
func (h *Handler) searchActivity(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	activityType, err := requiredParam(r, "activityType")
	if err != nil {
		writeError(w, err)
		return
	}
	mode := q.Get("mode")
	if mode == "" {
		mode = "pending"
	}
	if mode != "pending" && mode != "history" {
		writeError(w, badRequest("mode must be pending or history"))
		return
	}
	minAttempt, err := intParam(r, "minAttempt", 0, 1, 1<<30)
	if err != nil {
		writeError(w, err)
		return
	}
	if minAttempt > 0 && mode != "pending" {
		writeError(w, badRequest("minAttempt applies to mode=pending only"))
		return
	}
	capN, err := h.scanCap(r)
	if err != nil {
		writeError(w, err)
		return
	}
	names, _, err := h.namespaces(ctx, q.Get("namespaces"))
	if err != nil {
		writeError(w, err)
		return
	}

	query, err := userQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var examine examineFunc
	if mode == "pending" {
		query = withClause(query, `ExecutionStatus="Running"`)
		examine = func(ctx context.Context, c candidate) ([]hit, error) {
			resp, err := h.wf.DescribeWorkflowExecution(ctx, &workflowservice.DescribeWorkflowExecutionRequest{
				Namespace: c.ns, Execution: c.info.GetExecution(),
			})
			if err != nil {
				return nil, err
			}
			var hits []hit
			for _, pa := range resp.GetPendingActivities() {
				if pa.GetActivityType().GetName() != activityType || pa.GetAttempt() < int32(minAttempt) {
					continue
				}
				if len(hits) == maxHitsPerWorkflow {
					return hits, errHitCap
				}
				when := pa.GetLastStartedTime()
				if when == nil {
					when = pa.GetScheduledTime()
				}
				detail := "attempt " + strconv.Itoa(int(pa.GetAttempt())) + ", " + enumName(pa.GetState())
				if f := pa.GetLastFailure(); f != nil {
					detail += ": " + f.GetMessage()
				}
				hits = append(hits, hit{ActivityID: pa.GetActivityId(), Attempt: pa.GetAttempt(), EventTime: timeString(when), Detail: detail})
			}
			return hits, nil
		}
	} else {
		examine = func(ctx context.Context, c candidate) ([]hit, error) {
			var hits []hit
			capped := false
			err := h.eachEvent(ctx, c.ns, c.info.GetExecution(), enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT, func(e *historypb.HistoryEvent) bool {
				if a := e.GetActivityTaskScheduledEventAttributes(); a != nil && a.GetActivityType().GetName() == activityType {
					if len(hits) == maxHitsPerWorkflow {
						capped = true
						return false
					}
					hits = append(hits, hit{
						EventID: strconv.FormatInt(e.GetEventId(), 10), ActivityID: a.GetActivityId(),
						EventTime: timeString(e.GetEventTime()), Detail: "scheduled on task queue " + a.GetTaskQueue().GetName(),
					})
				}
				return true
			})
			if err == nil && capped {
				err = errHitCap
			}
			return hits, err
		}
	}
	writeJSON(w, h.runScan(ctx, names, query, capN, examine))
}
