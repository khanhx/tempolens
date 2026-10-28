package xapi

import (
	"net/http"
	"regexp"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/api/workflowservice/v1"
)

// exportWriteWindow is how long each page may take to write; it is renewed
// per page so long histories outlive the server WriteTimeout.
const exportWriteWindow = 60 * time.Second

// safeRunID guards the Content-Disposition filename.
var safeRunID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// export streams a run's full history as a JSON array of events in the
// /api/v1 form, oldest first. An error after the first byte aborts the
// response, so clients see a failed download rather than a short file.
func (h *Handler) export(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns, err := requiredParam(r, "namespace")
	if err != nil {
		writeError(w, err)
		return
	}
	wfID, err := requiredParam(r, "workflowId")
	if err != nil {
		writeError(w, err)
		return
	}
	runID, err := requiredParam(r, "runId")
	if err != nil {
		writeError(w, err)
		return
	}
	if !safeRunID.MatchString(runID) {
		writeError(w, badRequest("runId has unexpected characters"))
		return
	}
	exec := &commonpb.WorkflowExecution{WorkflowId: wfID, RunId: runID}
	page := func(token []byte) (*workflowservice.GetWorkflowExecutionHistoryResponse, error) {
		return h.wf.GetWorkflowExecutionHistory(ctx, &workflowservice.GetWorkflowExecutionHistoryRequest{
			Namespace: ns, Execution: exec, NextPageToken: token,
		})
	}

	resp, err := page(nil)
	if err != nil {
		writeError(w, err)
		return
	}
	rc := http.NewResponseController(w)
	hdr := w.Header()
	hdr.Set("Content-Type", "application/json")
	hdr.Set("Cache-Control", "no-store")
	hdr.Set("Content-Disposition", `attachment; filename="`+runID+`-events.json"`)
	w.WriteHeader(http.StatusOK)

	first := true
	write := func(b []byte) {
		if _, err := w.Write(b); err != nil {
			panic(http.ErrAbortHandler)
		}
	}
	write([]byte("["))
	for {
		_ = rc.SetWriteDeadline(time.Now().Add(exportWriteWindow))
		for _, e := range resp.GetHistory().GetEvents() {
			b, err := protoJSON.Marshal(e)
			if err != nil {
				h.log.Warn("history export: encode failed", "namespace", ns, "error", err.Error())
				panic(http.ErrAbortHandler)
			}
			if !first {
				write([]byte(","))
			}
			first = false
			write(b)
		}
		_ = rc.Flush()
		token := resp.GetNextPageToken()
		if len(token) == 0 {
			break
		}
		if resp, err = page(token); err != nil {
			h.log.Warn("history export: aborted mid-stream", "namespace", ns, "error", err.Error())
			panic(http.ErrAbortHandler)
		}
	}
	write([]byte("]"))
}
