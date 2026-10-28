# Contributing to Tempolens

Thanks for helping. Tempolens is a community project and is not affiliated with Temporal Technologies. Please keep changes small and focused, and open an issue first for anything that changes the HTTP contract or the authorization model.

## Development setup

You need:

- Go 1.26 (`go.mod` says `go 1.26.0`; with an older Go, `GOTOOLCHAIN=auto` downloads it);
- Node 22 for the web app;
- a Temporal frontend on `127.0.0.1:7233`, for example `temporal server start-dev`.

```sh
make dev                                      # server on :8234, auth disabled, role read
TEMPOLENS_AUTH_DISABLED_ROLE=admin make dev   # every action, still no login
cd web && npm ci && npm run dev               # Vite on :5173, proxies /api and /auth to :8234
```

`make dev` disables login and only answers on `localhost`. Never run with `TEMPOLENS_AUTH_DISABLED=true` anywhere else. For a login flow, `test/dex` has a local Dex with throwaway users (see `test/README.md`). Copy `.env.example` to `.env` (gitignored) when you need a fuller configuration.

## Tests and checks

CI (`.github/workflows/ci.yml`) runs all of these; please run them before opening a pull request.

| What | Command |
|---|---|
| Go tests | `go test -p 3 -race ./...` |
| Go lint | `make lint` (gofmt from the Go 1.26 toolchain, then `go vet ./...`) |
| Web | `cd web && npm run typecheck && npm run lint && npm test && npm run build && npm run budget` |
| Image | `make image` (builds only; nothing is pushed) |

`npm run budget` fails when the first-load bundle exceeds 60 KB gzip or any route exceeds 120 KB. The end-to-end tests in `test/e2e` need a local Temporal, the seed (`test/seed`) and the test Dex; `test/README.md` explains how to run them.

Unit tests never call a real Temporal: they use the in-process fake in `internal/testutil`. Tests that touch a live Temporal must create their own namespaces with the `tui-test-` prefix and remove them afterwards.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(xapi): …`, `fix(web): …`, `docs: …`, `test: …`, `chore: …`. Common scopes are `authz`, `auth`, `config`, `gateway`, `xapi`, `server`, `web` and `docker`.
- One logical change per commit, and every commit builds and passes its tests.
- Never commit secrets, `.env` files or local deployment config (`deploy/local/` is gitignored).

## Adding or reclassifying an RPC

Every gRPC call goes through one interceptor (`internal/authz/interceptor.go`) that denies any method it does not know. When the Temporal API gains a method, or the UI needs a new one:

1. **Classify it** in `internal/authz/policy.go`:
   - READ: add it to `wfRead` or `opRead`.
   - BLOCK: add it to `wfBlock` or `opBlock`.
   - WRITE: add a `writeRules` entry.
   - ADMIN: add an `adminRules` entry.

   A mutating rule names its env-flag `Actions`. It also names the `Stamp` path of its `identity` field, or sets `NoStamp` when the request has none.
2. **Validate it.** Put request checks in `internal/authz/validators.go`. They return `InvalidArgument` (400) for incomplete requests and `PermissionDenied` (403) for forbidden variants. Destructive actions also set `Confirm`, so the server requires `X-Tempolens-Confirm` to name the target.
3. **Gate it.** A new kind of action needs:
   - a flag in `internal/config/config.go`;
   - an `Action` in `policy.go`, mapped to that flag in `NewPolicy` and added to `AllActions`, plus `AdminActions` if it is admin-only.

   `/api/x/me` then reports it in `disabledActions` on its own.
4. **Route it.** Methods with an HTTP binding in `go.temporal.io/api` are served under `/api/v1` automatically. Methods without one need a handler in `internal/xapi`.
5. **Test it.** `TestEveryMethodClassified` fails until every method has a class. Update the expected sets in `TestWriteSetIsExact` or `TestAdminSetIsExact`. Add validator cases and denial cases. The route matrices check every binding for every role.
6. **Document it.** Update `docs/api-contract.md` (bump `Contract-Version` when the contract changes) and, for new env variables, the README configuration table and `.env.example`.

## Reporting security issues

Please do not open a public issue for a vulnerability. Contact the maintainers privately through the repository's security advisory page.
