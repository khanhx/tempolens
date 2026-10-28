package xapi

import (
	"encoding/json"
	"net/http"

	"go.temporal.io/api/workflowservice/v1"
)

type nsCount struct {
	Total    int64            `json:"total"`
	ByStatus map[string]int64 `json:"byStatus"`
}

type countResponse struct {
	Total        int64              `json:"total"`
	ByStatus     map[string]int64   `json:"byStatus"`
	PerNamespace map[string]nsCount `json:"perNamespace"`
	Errors       []xError           `json:"errors"`
}

// counts sums CountWorkflowExecutions ... GROUP BY ExecutionStatus across
// namespaces. A failing namespace is reported and left out of the totals.
func (h *Handler) counts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userQ, err := userQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	names, _, err := h.namespaces(ctx, r.URL.Query().Get("namespaces"))
	if err != nil {
		writeError(w, err)
		return
	}
	query := withGroupBy(userQ)

	results := make([]*workflowservice.CountWorkflowExecutionsResponse, len(names))
	errs := make([]error, len(names))
	forEach(len(names), h.cfg.Limits.FanoutConcurrency, func(i int) {
		results[i], errs[i] = h.wf.CountWorkflowExecutions(ctx, &workflowservice.CountWorkflowExecutionsRequest{
			Namespace: names[i], Query: query,
		})
	})

	resp := countResponse{ByStatus: map[string]int64{}, PerNamespace: map[string]nsCount{}, Errors: []xError{}}
	for i, ns := range names {
		if errs[i] != nil {
			resp.Errors = append(resp.Errors, errorOf(ns, errs[i]))
			continue
		}
		c := nsCount{Total: results[i].GetCount(), ByStatus: map[string]int64{}}
		for _, g := range results[i].GetGroups() {
			if len(g.GetGroupValues()) == 0 {
				continue
			}
			s := groupValue(g.GetGroupValues()[0].GetData())
			c.ByStatus[s] += g.GetCount()
			resp.ByStatus[s] += g.GetCount()
		}
		resp.Total += c.Total
		resp.PerNamespace[ns] = c
	}
	writeJSON(w, resp)
}

// groupValue decodes a json/plain payload such as "\"Running\"".
func groupValue(data []byte) string {
	var s string
	if json.Unmarshal(data, &s) == nil {
		return s
	}
	return string(data)
}
