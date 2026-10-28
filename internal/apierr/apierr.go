// Package apierr writes JSON error bodies in the google.rpc.Status shape
// ({code, message, details}) that every Tempolens API error uses.
package apierr

import (
	"net/http"
	"strconv"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"go.temporal.io/api/temporalproto"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// marshal emits default values so "details" is always an array.
var marshal = temporalproto.CustomJSONMarshalOptions{EmitDefaultValues: true}

// fallback is written when a status cannot be marshaled.
const fallback = `{"code":13,"message":"failed to marshal error","details":[]}`

// Write sends an error with an explicit HTTP status and gRPC code.
func Write(w http.ResponseWriter, httpStatus int, code codes.Code, msg string) {
	writeStatus(w, httpStatus, status.New(code, msg))
}

// WriteStatus sends a gRPC status with the HTTP status mapped from its code.
func WriteStatus(w http.ResponseWriter, st *status.Status) {
	writeStatus(w, runtime.HTTPStatusFromCode(st.Code()), st)
}

// TooMany sends 429 with a Retry-After header in whole seconds (at least 1).
func TooMany(w http.ResponseWriter, retryAfterSeconds int, msg string) {
	if retryAfterSeconds < 1 {
		retryAfterSeconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
	Write(w, http.StatusTooManyRequests, codes.ResourceExhausted, msg)
}

func writeStatus(w http.ResponseWriter, httpStatus int, st *status.Status) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	h.Del("Content-Length")
	body, err := marshal.Marshal(st.Proto())
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(fallback))
		return
	}
	w.WriteHeader(httpStatus)
	_, _ = w.Write(body)
}
