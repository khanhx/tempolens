# Tempolens

**A lightweight web UI for Temporal.**

Tempolens is a community project. It is not affiliated with, endorsed by, or supported by Temporal Technologies. It is an independent, smaller alternative to the official [`temporalio/ui`](https://github.com/temporalio/ui) and keeps its `/api/v1` HTTP contract and URL deep links. Parts of its logic are ported from `temporalio/ui` (MIT): the raw-history streaming export, and the payload and route conventions. Thanks to the upstream authors.

## What it is

One Docker image: a Go server that talks gRPC directly to the Temporal frontend, with a Preact single-page app embedded in it.

How it differs from upstream:

- **Server-enforced roles.** Logins through Dex (OIDC) get a `read`, `write` or `admin` role from their groups. Every gRPC call is authorized by RPC name in one interceptor that denies anything it does not know. Write actions are validated (mandatory reasons, safe batch variants only, typed confirmation for destructive ones), stamped with the user's identity, and written to an audit log.
- **Beyond parity.** Cross-namespace lists, counts and search; find workflows by activity type, event type or failure text; a stuck-activity finder; honest sorting; a per-run timeline and a relationship graph.
- **CLI parity in the browser.** Each action shows its equivalent `temporal` CLI command.
- **Command console.** Run Temporal commands from the UI, in a `temporal` CLI-like syntax or as raw RPCs. There is no shell on the server: each command is one RPC through the same authorization, validation, confirmation and audit as every other action.
  - Start a workflow in three modes: start, execute (wait for the result, like `temporal workflow execute`) and signal-with-start.
  - Delete workflows, and complete or fail an activity by ID.
  - See task-queue partitions and worker versioning, and a cluster page with cluster info, server capabilities and Tempolens health.
  - Admins can create, update and delete namespaces, and add and remove custom search attributes.
  - Destructive actions (terminate, delete, batch terminate and delete, namespace delete, search attribute remove) need the target's name typed in, and the server checks it too.
- **Lighter.** A static binary on distroless, a small first-load bundle, and no tokens kept in the browser or the server.

The HTTP contract is in [docs/api-contract.md](docs/api-contract.md).

## Quick start (Docker)

You need a Temporal frontend reachable from Docker (the default is the host's `7233`).

```sh
docker compose up --build        # http://localhost:8234, read-only
TEMPOLENS_AUTH_DISABLED_ROLE=write docker compose up --build   # allow write actions
docker compose down
```

`docker-compose.yml` is for local development only. It disables login, binds `127.0.0.1:8234`, and accepts only `localhost` and `127.0.0.1` Host headers. Use `TEMPORAL_ADDRESS=...` to point at another Temporal, and `TEMPOLENS_HOST_PORT=...` to use another host port (still bound to `127.0.0.1`). With a plain `docker run` and auth disabled, also pass `-e TEMPOLENS_LISTEN_ADDR=0.0.0.0` and publish on `127.0.0.1` only (`-p 127.0.0.1:8234:8080`). Without it the server listens on the container's loopback and is unreachable.

## Native development

Go 1.26 is required (`go.mod` says `go 1.26.0`; with an older local Go, `GOTOOLCHAIN=auto` downloads it). The web app needs Node 22.

```sh
make dev                      # server on :8234, auth disabled, role read
TEMPOLENS_AUTH_DISABLED_ROLE=write make dev   # or admin, for namespace and search-attribute admin
cd web && npm ci && npm run dev   # Vite on :5173, proxies /api and /auth to :8234
```

| Target | Does |
|---|---|
| `make test` / `make lint` | Go tests (`go test -p 3 ./...`) / gofmt from the Go 1.26 toolchain plus `go vet` |
| `make build` | `bin/tempolens` with the embedded UI from `internal/ui/dist` |
| `make web embed build` | Build the SPA, copy it into `internal/ui/dist`, build the binary |
| `make image` | `docker build -t tempolens:local .` |
| `make compose-up` / `make compose-down` | Start or stop the local-dev compose |

## Configuration

Configuration is environment variables only. Tempolens reads `TEMPOLENS_*`, `TEMPORAL_ADDRESS`, `TEMPORAL_TLS_*` and `PORT`. It does not read upstream `TEMPORAL_UI_*` or `TEMPORAL_AUTH_*` variables. It never reads `TEMPORAL_PORT`, because Kubernetes service links put `tcp://…` in it.

| Env | Default | Meaning |
|---|---|---|
| `TEMPORAL_ADDRESS` | `127.0.0.1:7233` | Temporal frontend gRPC target |
| `TEMPOLENS_PORT`, else `PORT` | `8080` | HTTP listen port |
| `TEMPOLENS_LISTEN_ADDR` | every interface (auth on); `127.0.0.1` (auth disabled) | Listen address: an IP, `localhost`, or `0.0.0.0`/`::` for every interface. The effective address is logged at start |
| `TEMPOLENS_PUBLIC_ORIGIN` | origin of the callback URL (auth on); `http://localhost:$PORT` (auth off) | `scheme://host[:port]` the browser uses. Every non-GET request must send this `Origin` and `X-Tempolens: 1` |
| `TEMPORAL_TLS_CA` / `_CERT` / `_KEY` | "" | TLS/mTLS to Temporal (file paths). TLS is on when CA or CERT is set |
| `TEMPORAL_TLS_SERVER_NAME` | "" | SNI / verification name |
| `TEMPORAL_TLS_INSECURE_SKIP_VERIFY` | `false` | Skip certificate verification |
| `TEMPOLENS_DEFAULT_NAMESPACE` | `default` | Namespace that `/` opens |
| `TEMPOLENS_SHOW_TEMPORAL_SYSTEM_NAMESPACE` | `false` | When false, reads on `temporal-system` are denied. Writes on it are always denied |
| `TEMPOLENS_PROTECTED_NAMESPACES` | `default` | Comma list of namespaces that can never be deleted, e.g. `default,payments`. `default` and `temporal-system` are always protected |
| `TEMPOLENS_DISABLE_WRITE_ACTIONS` | `false` | Read-only for everyone, admins included |
| `TEMPOLENS_WORKFLOW_{TERMINATE,CANCEL,SIGNAL,UPDATE,RESET,PAUSE}_DISABLED`, `TEMPOLENS_BATCH_ACTIONS_DISABLED`, `TEMPOLENS_START_WORKFLOW_DISABLED` | `false` | Block the matching RPCs on the server and hide the actions in the UI. A batch also checks the flag of its operation type. `START_WORKFLOW_DISABLED` also blocks schedule create, update, trigger and backfill |
| `TEMPOLENS_SCHEDULE_ACTIONS_DISABLED` | `false` | Blocks every schedule write |
| `TEMPOLENS_NEXUS_ACTIONS_DISABLED` | `false` | Blocks Nexus endpoint create, update and delete |
| `TEMPOLENS_WORKFLOW_DELETE_DISABLED` | `false` | Blocks workflow delete and batch delete |
| `TEMPOLENS_ACTIVITY_ACTIONS_DISABLED` | `false` | Blocks activity complete/fail by ID and the activity commands |
| `TEMPOLENS_NAMESPACE_ACTIONS_DISABLED` | `false` | Blocks namespace create, update and delete |
| `TEMPOLENS_SEARCH_ATTRIBUTE_ACTIONS_DISABLED` | `false` | Blocks search attribute add and remove |
| `TEMPOLENS_AUTH_DISABLED` | `false` | `true` turns login off (local development only): a loud warning on start, a `127.0.0.1` listen address unless `TEMPOLENS_LISTEN_ADDR` says otherwise, the localhost Host allowlist, and a refusal to start if `TEMPOLENS_AUTH_PROVIDER_URL` is set |
| `TEMPOLENS_AUTH_DISABLED_ROLE` | `read` | Role for everyone when auth is disabled: `read`, `write` or `admin` |
| `TEMPOLENS_AUTH_PROVIDER_URL` | required | OIDC issuer (discovery) URL. Discovery is retried in the background; until it succeeds, `/auth/sso` and `/readyz` return 503 |
| `TEMPOLENS_AUTH_CLIENT_ID` / `_CLIENT_SECRET` | required | Confidential OIDC client |
| `TEMPOLENS_AUTH_CALLBACK_URL` | required | Full callback URL, e.g. `https://tempolens.example.com/auth/sso/callback`. Its path becomes the callback route |
| `TEMPOLENS_AUTH_SCOPES` | `openid,profile,email,groups` | Comma or space list. `openid` and `groups` are always added |
| `TEMPOLENS_AUTH_ADMIN_GROUPS` | "" | Comma list of groups that get `admin` (which includes `write`), e.g. `acme:Platform Admins`. Same matching as write groups. Empty means nobody is admin |
| `TEMPOLENS_AUTH_WRITE_GROUPS` | "" | Comma list of groups that get `write`. Entries are trimmed; inner spaces are kept (`acme:Platform Team`). Empty means nobody can write |
| `TEMPOLENS_AUTH_READ_GROUPS` | "" | Optional. When set, a login matching no read, write or admin group is refused (403). When unset, every authenticated user can read |
| `TEMPOLENS_SESSION_TTL` | `8h` | Absolute session lifetime. There is no refresh; users log in again |
| `TEMPOLENS_SESSION_KEYS` | required when auth is on | Comma list of base64 32-byte keys. The first seals; all open (rotation). Generate with `openssl rand -base64 32` |
| `TEMPOLENS_CODEC_ENDPOINT` | "" | Codec server URL, called by the browser |
| `TEMPOLENS_CODEC_INCLUDE_CREDENTIALS` | `false` | Send cookies to the codec server |
| `TEMPOLENS_CODEC_DEFAULT_ERROR_MESSAGE` / `_LINK` | "" | Codec error banner |
| `TEMPOLENS_LOG_LEVEL` | `info` | `debug` also logs each login's groups, to diagnose IdP claims |
| `TEMPOLENS_SCAN_MAX_WORKFLOWS` | `200` (at most 1000) | Candidate cap per search |
| `TEMPOLENS_SCAN_CONCURRENCY` / `_TIMEOUT` / `_MAX_INFLIGHT` | `8` / `20s` / `2` | Search and graph workers, deadline, and process-wide concurrent searches (excess → 429). Graph walks have their own pool of 2× `_MAX_INFLIGHT`, at most 2 per user, and wait up to 2 s for a slot |
| `TEMPOLENS_FANOUT_CONCURRENCY` / `_MAX_NAMESPACES` | `8` / `50` | Cross-namespace fan-out bounds |
| `TEMPOLENS_XAPI_RPS` | `5` (burst 2×) | Per-user request rate on `/api/x` (excess → 429). The graph has a separate bucket at the same rate with a burst of max(20, 4×), for click-through browsing |
| `TEMPOLENS_MAX_STREAMS_PER_USER` | `4` | Per-user concurrent history long-polls plus exports (excess → 429) |

Startup fails fast, with every problem listed, when auth is on and a provider, client, callback or session-key setting is missing, a session key is not 32 bytes, the public origin cannot be derived, or auth is disabled while a provider URL is set. A Dex outage is not fatal.

## Login with Dex

- An existing confidential Dex client works unchanged. Register the callback URL above as a redirect URI.
- `groups` is added to the requested scopes automatically.
- Set `TEMPOLENS_AUTH_WRITE_GROUPS`, and optionally `TEMPOLENS_AUTH_ADMIN_GROUPS` and `TEMPOLENS_AUTH_READ_GROUPS`. Claim groups are compared exactly, without trimming. To see the groups a user really gets, log in once with `TEMPOLENS_LOG_LEVEL=debug`.
- Set `TEMPOLENS_SESSION_KEYS` (`openssl rand -base64 32`). To rotate, put the new key first and keep the old one until sessions expire.
- The session is an encrypted, HttpOnly `__Host-tempolens_session` cookie holding the user, role and matched group; no IdP token is kept. The email is used for attribution only when the IdP marks it `email_verified`; otherwise the subject (`sub`) is used. Groups are re-checked against the env on every request, so removing a group revokes access after a restart. Logout is local: Dex has no end-session endpoint.

## Roles and write actions

- **read**: every read RPC, including queries (`QueryWorkflow`, such as the stack trace), and all of `/api/x`. With `TEMPOLENS_SHOW_TEMPORAL_SYSTEM_NAMESPACE` off, `temporal-system` is also left out of namespace lists.
- **write** (includes read): start, signal, signal-with-start, update, cancel, terminate, reset, pause, unpause and delete workflows; activity complete and fail by ID; batch terminate, cancel and reset; stop batch; schedule create, update, patch and delete; Nexus endpoint writes. The activity commands (pause, unpause, reset, update options) are allowed too, but Temporal 1.24 does not implement them.
- **admin** (includes write): namespace create, update and delete; search attribute add and remove; batch delete.
- **Blocked for everyone**: namespace deprecation, remote-cluster calls, deployment and versioning changes, workflow rules, and the worker protocol.

The full per-RPC list is in [docs/api-contract.md](docs/api-contract.md).

Write requests are validated before Temporal is called:

- terminate, reset and batch require a non-empty `reason` (400);
- a batch must target a non-empty `visibilityQuery` and use the terminate, cancel, reset or (admin only) delete operation; executions lists, signal and the other operation types are refused (403);
- reset and batch reset may not carry `postResetOperations` (403);
- starting a workflow, including signal-with-start, may not request completion callbacks or eager execution (403);
- a namespace needs a name and a retention period to be created (400); `default`, `temporal-system` and `TEMPOLENS_PROTECTED_NAMESPACES` cannot be deleted (403). Deletion is asynchronous in Temporal;
- Temporal's system search attributes cannot be removed (403);
- destructive actions must name their target in the `X-Tempolens-Confirm` header, which the UI fills from its typed confirmation: terminate, workflow delete, batch terminate and delete, namespace delete and search attribute remove (400 when missing or different). Workflow delete also needs an `X-Tempolens-Reason` header;
- a Nexus endpoint may not target the `temporal-system` namespace (403);
- writes on `temporal-system` and namespace-scoped writes with no namespace are refused (403).

The `identity` of every write is set by the server to `tempolens:<email>`, and incoming HTTP headers are never forwarded to Temporal.

## Audit log

Every write, denial, login, refused login and logout is one JSON line on stdout. Payloads are never logged.

```json
{"time":"…","level":"INFO","msg":"audit","audit":true,"event":"write","user":"alice@example.com","role":"write","method":"TerminateWorkflowExecution","namespace":"orders","workflowId":"order-42","reason":"stuck since deploy","code":"OK","durationMs":12}
```

`event` is one of `write`, `deny`, `login`, `login_denied` and `logout`. Other fields, when they apply: `runId`, `scheduleId`, `jobId`, `batchOp`, and `target`, the confirmed target of a destructive action. A write line is written after Temporal answers, so `code` is the real result.

## Health

- `GET /healthz`: liveness, which checks the process only. Use it for the Kubernetes liveness probe.
- `GET /readyz`: 200 when Temporal answers its health check and, with auth on, OIDC discovery has succeeded; otherwise 503 with `{"status","temporal","oidc"}`, where `temporal` is `ok` or `unavailable` (the cause is logged as a warning, never returned). Cached for 5 s. Use it for the readiness probe.
- `tempolens healthcheck`: the image's Docker `HEALTHCHECK`. It reads only `TEMPOLENS_PORT`/`PORT` and `TEMPOLENS_LISTEN_ADDR` and calls `/healthz` on the listen address (`127.0.0.1` when listening on every interface), so it needs no shell and no other configuration.

## Security notes

- **Restrict Temporal's frontend port.** Tempolens enforces roles on the path through it, but Temporal 1.24 without an authorizer accepts anything that reaches `:7233` directly. A NetworkPolicy (or equivalent) that allows only Tempolens and your workers to reach the frontend is a prerequisite for the roles to mean anything.
- Auth-disabled mode is for localhost only. It listens on `127.0.0.1` unless `TEMPOLENS_LISTEN_ADDR` is set (the compose file sets `0.0.0.0` inside the container and publishes the port on `127.0.0.1` only). It also accepts only `localhost`/`127.0.0.1` Host headers, against DNS rebinding, and refuses to start with a provider URL set.
- All routes are same-origin. Non-GET requests need `X-Tempolens: 1` and the public `Origin`. Responses carry a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff` and `Referrer-Policy: same-origin`.
- The image runs as a non-root user on distroless, without a shell.

## Moving from temporalio/ui

The two images read disjoint variables (except `TEMPORAL_ADDRESS` and `TEMPORAL_TLS_*`), so both sets can sit in one Deployment during the switch, and rolling back is restoring the old image.

| Upstream variable | Tempolens variable | Note |
|---|---|---|
| `TEMPORAL_ADDRESS` | `TEMPORAL_ADDRESS` | Unchanged |
| `TEMPORAL_UI_PORT` | `TEMPOLENS_PORT` (or `PORT`) | Default 8080 in both |
| `TEMPORAL_AUTH_ENABLED=true` | – | Auth is on by default; only `TEMPOLENS_AUTH_DISABLED=true` turns it off |
| `TEMPORAL_AUTH_TYPE=oidc` | – | OIDC is the only mode |
| `TEMPORAL_AUTH_PROVIDER_URL` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_CALLBACK_URL` | `TEMPOLENS_AUTH_PROVIDER_URL` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_CALLBACK_URL` | Same values; the Dex config is unchanged |
| `TEMPORAL_AUTH_SCOPES` | `TEMPOLENS_AUTH_SCOPES` (optional) | `groups` is added automatically |
| – | `TEMPOLENS_AUTH_WRITE_GROUPS`, `TEMPOLENS_SESSION_KEYS` (new secret) | Required for write access and for sessions |
| `TEMPORAL_DISABLE_WRITE_ACTIONS=true` | `TEMPOLENS_DISABLE_WRITE_ACTIONS` | Do not carry it over unless global read-only is wanted; write groups now control writes |
| `TEMPORAL_WORKFLOW_*_DISABLED`, `TEMPORAL_BATCH_ACTIONS_DISABLED`, `TEMPORAL_START_WORKFLOW_DISABLED` | `TEMPOLENS_` equivalents | Now enforced by the server |
| `TEMPORAL_DEFAULT_NAMESPACE`, `TEMPORAL_SHOW_TEMPORAL_SYSTEM_NAMESPACE` | `TEMPOLENS_` equivalents | – |
| `TEMPORAL_CODEC_ENDPOINT` / `_INCLUDE_CREDENTIALS` / `_DEFAULT_ERROR_MESSAGE` / `_LINK` | `TEMPOLENS_CODEC_*` equivalents | – |
| `TEMPORAL_TLS_CA` / `_CERT` / `_KEY` / `_SERVER_NAME` | same names | `TEMPORAL_TLS_*_DATA` is not supported (mount files); verification is on by default |
| `TEMPORAL_CODEC_PASS_ACCESS_TOKEN`, `TEMPORAL_AUTH_ISSUER_URL`, `_REDIRECT_TO_PROVIDER`, `_USE_ID_TOKEN_AS_BEARER`, `TEMPORAL_CORS_*`, `TEMPORAL_CSRF_COOKIE_INSECURE`, `TEMPORAL_UI_PUBLIC_PATH`, `TEMPORAL_UI_SERVER_TLS_*`, `TEMPORAL_FORWARD_HEADERS`, news, feedback, nav, hide-errors, refresh-counts and activity-commands flags | – | No equivalent: no tokens are kept, same-origin only, served at the root path, TLS terminates at the ingress, or the feature was dropped |

**Switch checklist.**

1. Add the `TEMPOLENS_*` variables, including the new `TEMPOLENS_SESSION_KEYS` secret.
2. Point the probes at `/healthz` (liveness) and `/readyz` (readiness).
3. Confirm the Dex group strings with one `TEMPOLENS_LOG_LEVEL=debug` login, then set the write (and optional admin and read) groups.
4. Make sure the Temporal frontend port is network-restricted.

**Not carried over from upstream:**

- token refresh: the session has a fixed lifetime;
- the news feed;
- translations: English only;
- table density;
- activity pause, unpause, reset and update-options: not implemented by Temporal 1.24;
- the worker heartbeat list and worker deployments: not implemented by Temporal 1.24;
- standalone activities and Nexus operations;
- passing the access token to the codec server, since no token is kept;
- external payload download;
- the cosmetic settings flags;
- the "common errors" page.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, the checks CI runs ([.github/workflows/ci.yml](.github/workflows/ci.yml)), the commit convention and how to classify a new RPC. [.env.example](.env.example) lists a typical configuration with placeholder values.

## License

MIT, see [LICENSE](LICENSE).
