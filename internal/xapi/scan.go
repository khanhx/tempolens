package xapi

import (
	"context"
	"errors"
	"math"
	"net/http"
	"sync"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
)

// Partial reasons, reported in this order.
const (
	reasonCap     = "cap"
	reasonTimeout = "timeout"
	reasonError   = "error"
)

// Hit caps bound a scan's memory: hits kept per workflow and per response.
const (
	maxHitsPerWorkflow = 20
	maxHitsPerResponse = 5000
)

var (
	// errHistoryCap marks a history read stopped at historyEventCap.
	errHistoryCap = errors.New("history event cap reached")
	// errHitCap marks a workflow whose hits stopped at maxHitsPerWorkflow.
	errHitCap = errors.New("hit cap reached")
)

type hit struct {
	EventID    string  `json:"eventId,omitempty"`
	ActivityID string  `json:"activityId,omitempty"`
	Attempt    int32   `json:"attempt,omitempty"`
	EventTime  *string `json:"eventTime"`
	Detail     string  `json:"detail"`
}

type match struct {
	Namespace    string  `json:"namespace"`
	WorkflowID   string  `json:"workflowId"`
	RunID        string  `json:"runId"`
	WorkflowType string  `json:"workflowType"`
	Status       string  `json:"status"`
	StartTime    *string `json:"startTime"`
	CloseTime    *string `json:"closeTime"`
	Hits         []hit   `json:"hits"`
}

type scanResponse struct {
	Matches        []match  `json:"matches"`
	Candidates     int      `json:"candidates"`
	Scanned        int      `json:"scanned"`
	Partial        bool     `json:"partial"`
	PartialReasons []string `json:"partialReasons"`
	ElapsedMs      int64    `json:"elapsedMs"`
}

type candidate struct {
	ns   string
	info *workflowpb.WorkflowExecutionInfo
}

// examineFunc inspects one workflow. errHistoryCap and errHitCap mark a
// capped read whose hits are still valid.
type examineFunc func(ctx context.Context, c candidate) ([]hit, error)

// reasons collects partial reasons from concurrent workers.
type reasons struct {
	mu  sync.Mutex
	set map[string]bool
}

func (r *reasons) add(reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.set == nil {
		r.set = map[string]bool{}
	}
	r.set[reason] = true
}

func (r *reasons) list() []string {
	out := []string{}
	for _, k := range []string{reasonCap, reasonTimeout, reasonError} {
		if r.set[k] {
			out = append(out, k)
		}
	}
	return out
}

// scanCap reads max, clamped to min(max, TEMPOLENS_SCAN_MAX_WORKFLOWS, 1000).
func (h *Handler) scanCap(r *http.Request) (int, error) {
	limit := min(h.cfg.Limits.ScanMaxWorkflows, scanHardCap)
	v, err := intParam(r, "max", limit, 1, math.MaxInt32)
	return min(v, limit), err
}

// runScan lists candidates for query across namespaces (capped), examines
// them with bounded concurrency under the scan deadline, and reports
// partial results.
func (h *Handler) runScan(parent context.Context, names []string, query string, capN int, examine examineFunc) scanResponse {
	start := time.Now()
	ctx, cancel := context.WithTimeout(parent, h.cfg.Limits.ScanTimeout)
	defer cancel()
	var why reasons

	var cands []candidate
list:
	for i, ns := range names {
		var token []byte
		for {
			remaining := capN - len(cands)
			resp, err := h.wf.ListWorkflowExecutions(ctx, &workflowservice.ListWorkflowExecutionsRequest{
				Namespace: ns, Query: query, PageSize: int32(min(remaining, scanHardCap)), NextPageToken: token,
			})
			if err != nil {
				if isTimeout(ctx, err) {
					why.add(reasonTimeout)
					break list
				}
				why.add(reasonError)
				break
			}
			for _, info := range resp.GetExecutions() {
				if len(cands) == capN {
					break
				}
				cands = append(cands, candidate{ns: ns, info: info})
			}
			token = resp.GetNextPageToken()
			if len(cands) == capN {
				if len(token) > 0 || i < len(names)-1 {
					why.add(reasonCap)
				}
				break list
			}
			if len(token) == 0 {
				break
			}
		}
	}

	slots := make([]*match, len(cands))
	done := make([]bool, len(cands))
	var budgetMu sync.Mutex
	budget := maxHitsPerResponse
	forEach(len(cands), h.cfg.Limits.ScanConcurrency, func(i int) {
		if ctx.Err() != nil {
			why.add(reasonTimeout)
			return
		}
		budgetMu.Lock()
		exhausted := budget <= 0
		budgetMu.Unlock()
		if exhausted {
			why.add(reasonCap)
			return
		}
		c := cands[i]
		hits, err := examine(ctx, c)
		switch {
		case errors.Is(err, errHistoryCap), errors.Is(err, errHitCap):
			why.add(reasonCap)
		case err != nil && isTimeout(ctx, err):
			why.add(reasonTimeout)
			return
		case err != nil:
			why.add(reasonError)
			return
		}
		done[i] = true
		budgetMu.Lock()
		if len(hits) > budget {
			hits = hits[:budget]
			why.add(reasonCap)
		}
		budget -= len(hits)
		budgetMu.Unlock()
		if len(hits) > 0 {
			slots[i] = matchOf(c, hits)
		}
	})

	resp := scanResponse{Matches: []match{}, Candidates: len(cands), PartialReasons: why.list()}
	for i := range cands {
		if done[i] {
			resp.Scanned++
		}
		if slots[i] != nil {
			resp.Matches = append(resp.Matches, *slots[i])
		}
	}
	resp.Partial = len(resp.PartialReasons) > 0
	resp.ElapsedMs = time.Since(start).Milliseconds()
	return resp
}

func matchOf(c candidate, hits []hit) *match {
	return &match{
		Namespace:    c.ns,
		WorkflowID:   c.info.GetExecution().GetWorkflowId(),
		RunID:        c.info.GetExecution().GetRunId(),
		WorkflowType: c.info.GetType().GetName(),
		Status:       enumName(c.info.GetStatus()),
		StartTime:    timeString(c.info.GetStartTime()),
		CloseTime:    timeString(c.info.GetCloseTime()),
		Hits:         hits,
	}
}

// eachEvent pages through a run's history and calls fn for every event until
// fn returns false. It stops with errHistoryCap after historyEventCap events.
func (h *Handler) eachEvent(ctx context.Context, ns string, exec *commonpb.WorkflowExecution,
	filter enumspb.HistoryEventFilterType, fn func(*historypb.HistoryEvent) bool) error {
	var token []byte
	seen := 0
	for {
		resp, err := h.wf.GetWorkflowExecutionHistory(ctx, &workflowservice.GetWorkflowExecutionHistoryRequest{
			Namespace: ns, Execution: exec, NextPageToken: token, HistoryEventFilterType: filter,
		})
		if err != nil {
			return err
		}
		for _, e := range resp.GetHistory().GetEvents() {
			if seen++; seen > historyEventCap {
				return errHistoryCap
			}
			if !fn(e) {
				return nil
			}
		}
		if token = resp.GetNextPageToken(); len(token) == 0 {
			return nil
		}
	}
}
