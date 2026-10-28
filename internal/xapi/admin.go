package xapi

import (
	"errors"
	"io"
	"net/http"

	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/api/operatorservice/v1"
	taskqueuepb "go.temporal.io/api/taskqueue/v1"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/proto"

	"tempolens/internal/apierr"
)

// Routes for RPCs that have no /api/v1 binding (contract section 3.8). They
// call Temporal through the same intercepted connection, so authorization,
// validators, confirmation and audit are the interceptor's.

const maxAdminBody = 4 << 20

// strictJSON rejects unknown fields, like the /api/v1 gateway.
var strictJSON = temporalproto.CustomJSONUnmarshalOptions{}

// readBody decodes an optional JSON body into m.
func readBody(w http.ResponseWriter, r *http.Request, m proto.Message) error {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAdminBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return badRequest("request body exceeds 4 MiB")
		}
		return badRequest("unreadable request body")
	}
	if len(data) == 0 {
		return nil
	}
	if err := strictJSON.Unmarshal(data, m); err != nil {
		return badRequest(err.Error())
	}
	return nil
}

// method answers 405 unless r uses want.
func method(w http.ResponseWriter, r *http.Request, want string) bool {
	if r.Method != want {
		w.Header().Set("Allow", want)
		apierr.Write(w, http.StatusMethodNotAllowed, codes.Unimplemented, "method not allowed")
		return false
	}
	return true
}

// writeProto writes a response message in the /api/v1 JSON form.
func writeProto(w http.ResponseWriter, m proto.Message) {
	body, err := rawProto(m)
	if err != nil {
		apierr.Write(w, http.StatusInternalServerError, codes.Internal, "failed to encode response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

// deleteWorkflow serves DELETE /api/x/workflow (DeleteWorkflowExecution).
func (h *Handler) deleteWorkflow(w http.ResponseWriter, r *http.Request) {
	if !method(w, r, http.MethodDelete) {
		return
	}
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
	resp, err := h.wf.DeleteWorkflowExecution(r.Context(), &workflowservice.DeleteWorkflowExecutionRequest{
		Namespace:         ns,
		WorkflowExecution: &commonpb.WorkflowExecution{WorkflowId: wfID, RunId: r.URL.Query().Get("runId")},
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeProto(w, resp)
}

// deleteNamespace serves DELETE /api/x/namespace (OperatorService DeleteNamespace).
func (h *Handler) deleteNamespace(w http.ResponseWriter, r *http.Request) {
	if !method(w, r, http.MethodDelete) {
		return
	}
	req := &operatorservice.DeleteNamespaceRequest{}
	if err := readBody(w, r, req); err != nil {
		writeError(w, err)
		return
	}
	ns, err := requiredParam(r, "namespace")
	if err != nil {
		writeError(w, err)
		return
	}
	req.Namespace = ns
	resp, err := h.op.DeleteNamespace(r.Context(), req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeProto(w, resp)
}

// searchAttributes serves POST (add) and DELETE (remove) /api/x/search-attributes.
func (h *Handler) searchAttributes(w http.ResponseWriter, r *http.Request) {
	ns, err := requiredParam(r, "namespace")
	switch {
	case r.Method != http.MethodPost && r.Method != http.MethodDelete:
		w.Header().Set("Allow", "POST, DELETE")
		apierr.Write(w, http.StatusMethodNotAllowed, codes.Unimplemented, "method not allowed")
		return
	case err != nil:
		writeError(w, err)
		return
	}
	if r.Method == http.MethodPost {
		req := &operatorservice.AddSearchAttributesRequest{}
		if err := readBody(w, r, req); err != nil {
			writeError(w, err)
			return
		}
		req.Namespace = ns
		resp, err := h.op.AddSearchAttributes(r.Context(), req)
		if err != nil {
			writeError(w, err)
			return
		}
		writeProto(w, resp)
		return
	}
	resp, err := h.op.RemoveSearchAttributes(r.Context(), &operatorservice.RemoveSearchAttributesRequest{
		Namespace: ns, SearchAttributes: r.URL.Query()["name"],
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeProto(w, resp)
}

// taskQueuePartitions serves GET /api/x/task-queue-partitions (ListTaskQueuePartitions).
func (h *Handler) taskQueuePartitions(w http.ResponseWriter, r *http.Request) {
	if !method(w, r, http.MethodGet) {
		return
	}
	ns, err := requiredParam(r, "namespace")
	if err != nil {
		writeError(w, err)
		return
	}
	tq, err := requiredParam(r, "taskQueue")
	if err != nil {
		writeError(w, err)
		return
	}
	resp, err := h.wf.ListTaskQueuePartitions(r.Context(), &workflowservice.ListTaskQueuePartitionsRequest{
		Namespace: ns, TaskQueue: &taskqueuepb.TaskQueue{Name: tq},
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeProto(w, resp)
}
