// Package testutil provides an in-process fake Temporal frontend and a full
// HTTP server harness for tests. It is imported only by external test
// packages (package foo_test).
package testutil

import (
	"context"
	"net"
	"sync"
	"testing"

	"go.temporal.io/api/operatorservice/v1"
	"go.temporal.io/api/workflowservice/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"
)

// Call is one RPC that reached the fake server.
type Call struct {
	Method string
	Req    proto.Message
	MD     metadata.MD
}

// Responder may answer a call instead of the default Unimplemented server.
// handled=false falls through to the default.
type Responder func(ctx context.Context, method string, req any) (resp any, err error, handled bool)

// FakeTemporal records every RPC that reaches it. Unless a Responder handles
// a call, WorkflowService and OperatorService answer Unimplemented and the
// health service answers SERVING.
type FakeTemporal struct {
	lis *bufconn.Listener

	mu        sync.Mutex
	calls     []Call
	responder Responder
}

// StartFakeTemporal starts the fake server; it stops when the test ends.
func StartFakeTemporal(t testing.TB) *FakeTemporal {
	t.Helper()
	f := &FakeTemporal{lis: bufconn.Listen(1 << 20)}
	srv := grpc.NewServer(grpc.UnaryInterceptor(f.record))
	workflowservice.RegisterWorkflowServiceServer(srv, workflowservice.UnimplementedWorkflowServiceServer{})
	operatorservice.RegisterOperatorServiceServer(srv, operatorservice.UnimplementedOperatorServiceServer{})
	hs := health.NewServer()
	hs.SetServingStatus("temporal.api.workflowservice.v1.WorkflowService", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(srv, hs)
	go func() { _ = srv.Serve(f.lis) }()
	t.Cleanup(srv.Stop)
	return f
}

// SetResponder installs r for subsequent calls.
func (f *FakeTemporal) SetResponder(r Responder) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responder = r
}

// Dial returns a client connection with the given interceptors; it closes
// when the test ends.
func (f *FakeTemporal) Dial(t testing.TB, unary grpc.UnaryClientInterceptor, stream grpc.StreamClientInterceptor) *grpc.ClientConn {
	t.Helper()
	opts := []grpc.DialOption{
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return f.lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	}
	if unary != nil {
		opts = append(opts, grpc.WithChainUnaryInterceptor(unary))
	}
	if stream != nil {
		opts = append(opts, grpc.WithChainStreamInterceptor(stream))
	}
	conn, err := grpc.NewClient("passthrough:///bufnet", opts...)
	if err != nil {
		t.Fatalf("dial fake temporal: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// Calls returns a copy of the recorded calls.
func (f *FakeTemporal) Calls() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Call(nil), f.calls...)
}

// Reset forgets the recorded calls.
func (f *FakeTemporal) Reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

func (f *FakeTemporal) record(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	c := Call{Method: info.FullMethod, MD: md.Copy()}
	if m, ok := req.(proto.Message); ok {
		c.Req = proto.Clone(m)
	}
	f.mu.Lock()
	f.calls = append(f.calls, c)
	r := f.responder
	f.mu.Unlock()
	if r != nil {
		if resp, err, handled := r(ctx, info.FullMethod, req); handled {
			return resp, err
		}
	}
	return handler(ctx, req)
}
