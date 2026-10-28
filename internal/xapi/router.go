// Package xapi implements the Tempolens /api/x endpoints. Handlers are
// stateless apart from short caches; every RPC goes through the shared,
// intercepted Temporal connection, so it is authorized like /api/v1.
package xapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/temporalproto"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/timestamppb"

	"tempolens/internal/apierr"
	"tempolens/internal/auth"
	"tempolens/internal/authz"
	"tempolens/internal/config"
	"tempolens/internal/limits"
)

const (
	pageSizeMax     = 100
	pageSizeDefault = 50
	graphDepthMax   = 3
	// scanHardCap is the ceiling for any scan's candidate count.
	scanHardCap = 1000
	// historyEventCap stops a per-workflow history read.
	historyEventCap = 10000
	// busyRetryAfter is the Retry-After when no scan slot is free.
	busyRetryAfter = 5
	cacheTTL       = 30 * time.Second

	// Graph walks are interactive (clicking from node to node), so they have
	// their own budget instead of sharing the scan and request limits: a
	// per-user bucket at the /api/x rate with a burst of at least
	// graphBurstMin, at most graphWalksPerUser concurrent walks per user, and
	// a global pool of graphPoolFactor x TEMPOLENS_SCAN_MAX_INFLIGHT walks,
	// waited for up to graphSlotWait before answering 429.
	graphBurstMin     = 20
	graphWalksPerUser = 2
	graphPoolFactor   = 2
	graphSlotWait     = 2 * time.Second
	graphRetryAfter   = 1
)

// Options are the handler dependencies.
type Options struct {
	Config *config.Config
	// Conn is the intercepted Temporal connection.
	Conn    grpc.ClientConnInterface
	Keys    *auth.Keyring
	Policy  *authz.Policy
	Log     *slog.Logger
	Version string
}

// Handler serves /api/x/*. It expects the session middleware to have put a
// principal in the request context.
type Handler struct {
	cfg      *config.Config
	wf       workflowservice.WorkflowServiceClient
	op       operatorservice.OperatorServiceClient
	keys     [][]byte
	policy   *authz.Policy
	log      *slog.Logger
	version  string
	rate     *limits.Rate
	inflight chan struct{}
	now      func() time.Time

	graphRate  *limits.Rate
	graphSlots chan struct{}
	graphUsers *limits.Streams

	mu       sync.Mutex
	nsNames  []string
	nsAt     time.Time
	nsByID   map[string]string
	nsIDByNS map[string]string
}

// New returns the /api/x handler.
func New(o Options) *Handler {
	rps := o.Config.Limits.XAPIRPS
	return &Handler{
		cfg:      o.Config,
		wf:       workflowservice.NewWorkflowServiceClient(o.Conn),
		op:       operatorservice.NewOperatorServiceClient(o.Conn),
		keys:     o.Keys.PageTokenKeys(),
		policy:   o.Policy,
		log:      o.Log,
		version:  o.Version,
		rate:     limits.NewRate(rps, int(math.Ceil(2*rps))),
		inflight: make(chan struct{}, o.Config.Limits.ScanMaxInflight),
		now:      time.Now,

		graphRate:  limits.NewRate(rps, max(graphBurstMin, int(math.Ceil(4*rps)))),
		graphSlots: make(chan struct{}, graphPoolFactor*o.Config.Limits.ScanMaxInflight),
		graphUsers: limits.NewStreams(graphWalksPerUser),
		nsByID:     map[string]string{},
		nsIDByNS:   map[string]string{},
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil {
		apierr.Write(w, http.StatusUnauthorized, codes.Unauthenticated, "no valid session")
		return
	}
	bucket := h.rate
	if r.URL.Path == "/api/x/graph" {
		bucket = h.graphRate
	}
	if ok, wait := bucket.Allow(p.Key()); !ok {
		apierr.TooMany(w, int(math.Ceil(wait.Seconds())), "too many requests; slow down")
		return
	}
	// Section 3.8 routes check their own methods; every other route is GET.
	switch r.URL.Path {
	case "/api/x/workflow":
		h.deleteWorkflow(w, r)
		return
	case "/api/x/namespace":
		h.deleteNamespace(w, r)
		return
	case "/api/x/search-attributes":
		h.searchAttributes(w, r)
		return
	case "/api/x/task-queue-partitions":
		h.taskQueuePartitions(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		apierr.Write(w, http.StatusMethodNotAllowed, codes.Unimplemented, "method not allowed")
		return
	}
	switch r.URL.Path {
	case "/api/x/me":
		h.me(w, r)
	case "/api/x/workflows":
		h.workflows(w, r)
	case "/api/x/workflows/count":
		h.counts(w, r)
	case "/api/x/search/activity":
		h.withScanSlot(h.searchActivity)(w, r)
	case "/api/x/search/event":
		h.withScanSlot(h.searchEvent)(w, r)
	case "/api/x/graph":
		h.withGraphSlot(p.Key(), h.graph)(w, r)
	case "/api/x/history-export":
		h.export(w, r)
	default:
		apierr.Write(w, http.StatusNotFound, codes.NotFound, "no such API route")
	}
}

// withScanSlot takes a process-wide scan slot or answers 429.
func (h *Handler) withScanSlot(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case h.inflight <- struct{}{}:
			defer func() { <-h.inflight }()
			next(w, r)
		default:
			apierr.TooMany(w, busyRetryAfter, "too many scans in progress; retry shortly")
		}
	}
}

// withGraphSlot bounds graph walks per user and globally. A full global
// pool is waited on briefly, since walks are short and interactive.
func (h *Handler) withGraphSlot(user string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		release, ok := h.graphUsers.Acquire(user)
		if !ok {
			apierr.TooMany(w, graphRetryAfter, "too many graph walks in progress for this user")
			return
		}
		defer release()
		timer := time.NewTimer(graphSlotWait)
		defer timer.Stop()
		select {
		case h.graphSlots <- struct{}{}:
			defer func() { <-h.graphSlots }()
			next(w, r)
		case <-timer.C:
			apierr.TooMany(w, graphRetryAfter, "too many graph walks in progress; retry shortly")
		case <-r.Context().Done():
		}
	}
}

// badRequest is a client error reported as 400.
type badRequest string

func (b badRequest) Error() string { return string(b) }

// writeError maps a badRequest to 400 and anything else to its gRPC status.
func writeError(w http.ResponseWriter, err error) {
	var br badRequest
	if errors.As(err, &br) {
		apierr.Write(w, http.StatusBadRequest, codes.InvalidArgument, string(br))
		return
	}
	apierr.WriteStatus(w, status.Convert(err))
}

func writeJSON(w http.ResponseWriter, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		apierr.Write(w, http.StatusInternalServerError, codes.Internal, "failed to encode response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

var protoJSON = temporalproto.CustomJSONMarshalOptions{}

// rawProto renders m in the /api/v1 JSON form.
func rawProto(m proto.Message) (json.RawMessage, error) {
	b, err := protoJSON.Marshal(m)
	return json.RawMessage(b), err
}

// timeString renders a timestamp as RFC 3339 with nanoseconds, or nil.
func timeString(ts *timestamppb.Timestamp) *string {
	if ts == nil {
		return nil
	}
	s := ts.AsTime().UTC().Format(time.RFC3339Nano)
	return &s
}

// enumName returns the proto name of an enum value, e.g.
// WORKFLOW_EXECUTION_STATUS_RUNNING.
func enumName(e protoreflect.Enum) string {
	if v := e.Descriptor().Values().ByNumber(e.Number()); v != nil {
		return string(v.Name())
	}
	return strconv.Itoa(int(e.Number()))
}

// intParam parses an optional integer query parameter within [lo, hi].
func intParam(r *http.Request, name string, def, lo, hi int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < lo || v > hi {
		return 0, badRequest(name + " must be an integer between " + strconv.Itoa(lo) + " and " + strconv.Itoa(hi))
	}
	return v, nil
}

func requiredParam(r *http.Request, name string) (string, error) {
	v := r.URL.Query().Get(name)
	if strings.TrimSpace(v) == "" {
		return "", badRequest(name + " is required")
	}
	return v, nil
}

// forEach runs fn(i) for i in [0,n) with at most limit goroutines.
func forEach(n, limit int, fn func(i int)) {
	if limit < 1 {
		limit = 1
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer func() { <-sem; wg.Done() }()
			fn(i)
		}(i)
	}
	wg.Wait()
}

// isTimeout reports whether err comes from an expired deadline.
func isTimeout(ctx context.Context, err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || status.Code(err) == codes.DeadlineExceeded || ctx.Err() != nil
}
