package xapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	enumspb "go.temporal.io/api/enums/v1"
	failurepb "go.temporal.io/api/failure/v1"
	historypb "go.temporal.io/api/history/v1"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// closeEventTypes end a run; a search for one reads only the close event.
var closeEventTypes = map[enumspb.EventType]bool{
	enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED:        true,
	enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED:           true,
	enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT:        true,
	enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED:         true,
	enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED:       true,
	enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW: true,
}

// maxCauseDepth bounds the failure cause chain walk.
const maxCauseDepth = 20

// searchEvent finds workflows whose history has an event of a type and/or a
// failure whose message (or cause chain) contains failureText.
func (h *Handler) searchEvent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	var eventType enumspb.EventType
	if raw := strings.TrimSpace(q.Get("eventType")); raw != "" {
		v, ok := enumspb.EventType_value[raw]
		if !ok || v == 0 {
			writeError(w, badRequest("unknown eventType; use an enum name such as EVENT_TYPE_ACTIVITY_TASK_FAILED"))
			return
		}
		eventType = enumspb.EventType(v)
	}
	needle := strings.ToLower(strings.TrimSpace(q.Get("failureText")))
	if eventType == enumspb.EVENT_TYPE_UNSPECIFIED && needle == "" {
		writeError(w, badRequest("eventType or failureText is required"))
		return
	}
	query, err := userQuery(r)
	if err != nil {
		writeError(w, err)
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

	filter := enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT
	if closeEventTypes[eventType] {
		filter = enumspb.HISTORY_EVENT_FILTER_TYPE_CLOSE_EVENT
	}
	examine := func(ctx context.Context, c candidate) ([]hit, error) {
		var hits []hit
		capped := false
		err := h.eachEvent(ctx, c.ns, c.info.GetExecution(), filter, func(e *historypb.HistoryEvent) bool {
			if eventType != enumspb.EVENT_TYPE_UNSPECIFIED && e.GetEventType() != eventType {
				return true
			}
			detail := enumName(e.GetEventType())
			if needle != "" {
				msg, ok := matchFailure(e, needle)
				if !ok {
					return true
				}
				detail = msg
			}
			if len(hits) == maxHitsPerWorkflow {
				capped = true
				return false
			}
			hits = append(hits, hit{EventID: strconv.FormatInt(e.GetEventId(), 10), EventTime: timeString(e.GetEventTime()), Detail: detail})
			return true
		})
		if err == nil && capped {
			err = errHitCap
		}
		return hits, err
	}
	writeJSON(w, h.runScan(ctx, names, query, capN, examine))
}

var failureName = (&failurepb.Failure{}).ProtoReflect().Descriptor().FullName()

// matchFailure looks for needle (lower case) in the message of any Failure
// held directly by the event's attributes, and along its cause chain.
func matchFailure(e *historypb.HistoryEvent, needle string) (string, bool) {
	m := e.ProtoReflect()
	od := m.Descriptor().Oneofs().ByName("attributes")
	if od == nil {
		return "", false
	}
	fd := m.WhichOneof(od)
	if fd == nil {
		return "", false
	}
	attrs := m.Get(fd).Message()
	found, msg := false, ""
	attrs.Range(func(f protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		if f.Kind() != protoreflect.MessageKind || f.IsList() || f.IsMap() || f.Message().FullName() != failureName {
			return true
		}
		cur, _ := v.Message().Interface().(*failurepb.Failure)
		for depth := 0; cur != nil && depth < maxCauseDepth; depth++ {
			if strings.Contains(strings.ToLower(cur.GetMessage()), needle) {
				found, msg = true, cur.GetMessage()
				return false
			}
			cur = cur.GetCause()
		}
		return true
	})
	return msg, found
}
