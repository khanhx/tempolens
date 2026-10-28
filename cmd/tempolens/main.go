// Command tempolens is a lightweight web UI for Temporal.
//
// Usage:
//
//	tempolens [serve]     run the HTTP server (default)
//	tempolens healthcheck GET /healthz on the local port; exit 0 when healthy
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"tempolens/internal/audit"
	"tempolens/internal/auth"
	"tempolens/internal/authz"
	"tempolens/internal/config"
	"tempolens/internal/health"
	"tempolens/internal/server"
	"tempolens/internal/temporalconn"
	"tempolens/internal/ui"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		os.Exit(serve())
	case "healthcheck":
		os.Exit(healthcheck())
	case "-h", "--help", "help":
		fmt.Fprintln(os.Stdout, "usage: tempolens [serve|healthcheck]")
	default:
		fmt.Fprintf(os.Stderr, "tempolens: unknown command %q\nusage: tempolens [serve|healthcheck]\n", cmd)
		os.Exit(2)
	}
}

func serve() int {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.FromEnv()
	if err != nil {
		log.Error("invalid configuration", "error", err.Error())
		return 1
	}
	log = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)

	log.Info("starting tempolens", "version", version, "config", cfg)
	if cfg.Auth.Disabled {
		log.Warn("AUTH IS DISABLED: every request runs as a fixed local principal; use for local development only",
			"role", string(cfg.Auth.DisabledRole), "listenAddr", cfg.ListenAddr())
	}
	if len(cfg.Auth.ScopesAdded) > 0 {
		log.Info("added required OIDC scopes", "scopes", cfg.Auth.ScopesAdded)
	}
	if !cfg.Auth.Disabled && len(cfg.Auth.WriteGroups) == 0 {
		log.Warn("TEMPOLENS_AUTH_WRITE_GROUPS is empty: nobody can perform write actions")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	handler, oidcProvider, err := build(ctx, cfg, log)
	if err != nil {
		log.Error("startup failed", "error", err.Error())
		return 1
	}
	if oidcProvider != nil {
		go oidcProvider.Run(ctx)
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", srv.Addr)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		log.Error("server failed", "error", err.Error())
		return 1
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "error", err.Error())
		return 1
	}
	if err := <-errc; err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server failed", "error", err.Error())
		return 1
	}
	return 0
}

// build assembles the server. The returned OIDC provider is nil when auth is
// disabled; otherwise the caller starts its discovery loop.
func build(ctx context.Context, cfg *config.Config, log *slog.Logger) (http.Handler, *auth.OIDC, error) {
	var keys *auth.Keyring
	var err error
	if cfg.Auth.Disabled {
		keys, err = auth.RandomKeyring()
	} else {
		keys, err = auth.NewKeyring(cfg.Auth.SessionKeys)
	}
	if err != nil {
		return nil, nil, err
	}

	auditLog := audit.New(log)
	policy := authz.NewPolicy(cfg)
	icpt := authz.NewInterceptor(policy, auditLog, log, version)
	conn, err := temporalconn.Dial(cfg, icpt.Unary, authz.StreamDeny)
	if err != nil {
		return nil, nil, err
	}

	var provider *auth.OIDC
	oidcState := func() string { return health.OIDCDisabled }
	if !cfg.Auth.Disabled {
		provider = auth.NewOIDC(cfg.Auth, keys, auditLog, log)
		oidcState = func() string {
			if provider.Ready() {
				return health.OIDCOK
			}
			return health.OIDCPending
		}
	}

	uiHandler, err := ui.New(ui.Dist())
	if err != nil {
		return nil, nil, err
	}
	h, err := server.New(ctx, server.Options{
		Config:  cfg,
		Conn:    conn,
		Keys:    keys,
		OIDC:    provider,
		Policy:  policy,
		Health:  health.New(conn, oidcState, log),
		UI:      uiHandler,
		Audit:   auditLog,
		Log:     log,
		Version: version,
	})
	if err != nil {
		return nil, nil, err
	}
	return h, provider, nil
}

// healthTarget is the /healthz URL for the listen address: loopback when
// the server listens on every interface, otherwise the configured host.
// Only TEMPOLENS_LISTEN_ADDR and the port are read.
func healthTarget(getenv func(string) string) (string, error) {
	port, err := config.Port(getenv)
	if err != nil {
		return "", err
	}
	host, err := config.ListenHost(getenv, false)
	if err != nil {
		return "", err
	}
	if host == "" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/healthz", nil
}

// healthcheck reads only the port and listen address, never the full
// configuration, so it works in a distroless image regardless of other env.
func healthcheck() int {
	target, err := healthTarget(os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(target)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthcheck: status", resp.StatusCode)
		return 1
	}
	return 0
}
