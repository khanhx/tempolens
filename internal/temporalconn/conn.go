// Package temporalconn dials the single gRPC connection to the Temporal
// frontend. Every call made by Tempolens goes through it, and therefore
// through the authorization interceptor.
package temporalconn

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	"tempolens/internal/config"
)

const (
	serviceConfig  = `{"loadBalancingConfig": [{"round_robin":{}}]}`
	maxBackoff     = 10 * time.Second
	minConnectWait = 20 * time.Second
	maxRecvMsgSize = 64 << 20
)

// Dial creates the client connection with the given interceptors. The
// connection is lazy: it does not fail when Temporal is down.
func Dial(cfg *config.Config, unary grpc.UnaryClientInterceptor, stream grpc.StreamClientInterceptor) (*grpc.ClientConn, error) {
	creds := insecure.NewCredentials()
	if cfg.TLS.Enabled() {
		tc, err := tlsConfig(cfg.TLS)
		if err != nil {
			return nil, err
		}
		creds = credentials.NewTLS(tc)
	}
	cp := grpc.ConnectParams{Backoff: backoff.DefaultConfig, MinConnectTimeout: minConnectWait}
	cp.Backoff.MaxDelay = maxBackoff
	return grpc.NewClient(cfg.TemporalAddress,
		grpc.WithTransportCredentials(creds),
		grpc.WithChainUnaryInterceptor(unary),
		grpc.WithChainStreamInterceptor(stream),
		grpc.WithDefaultServiceConfig(serviceConfig),
		grpc.WithDisableServiceConfig(),
		grpc.WithConnectParams(cp),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxRecvMsgSize)),
	)
}

func tlsConfig(t config.TLS) (*tls.Config, error) {
	tc := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		ServerName:         t.ServerName,
		InsecureSkipVerify: t.InsecureSkipVerify, // opt-in via TEMPORAL_TLS_INSECURE_SKIP_VERIFY
	}
	if t.CAFile != "" {
		pem, err := os.ReadFile(t.CAFile)
		if err != nil {
			return nil, fmt.Errorf("TEMPORAL_TLS_CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("TEMPORAL_TLS_CA: no PEM certificates found")
		}
		tc.RootCAs = pool
	}
	if t.CertFile != "" {
		cert, err := tls.LoadX509KeyPair(t.CertFile, t.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("TEMPORAL_TLS_CERT/KEY: %w", err)
		}
		tc.Certificates = []tls.Certificate{cert}
	}
	return tc, nil
}
