# Tempolens test harness

LOCAL TEST ONLY. Nothing in this directory is for production. Every password, client secret and session key here is a throwaway value.

## Layout

- `seed/`: Go module `tempolens-seed` (Go 1.26.0). It seeds the local Temporal with the UI test matrix, runs the seed worker and verifies the matrix.
- `dex/`: local Dex (`dexidp/dex:v2.46.1`) on port 5599, with static users that carry groups. `docker-compose.e2e.yml` is its own compose project, `tempolens-e2e`, and its container is `tempolens-test-dex`.

## Seed

The seed targets `TEMPORAL_ADDRESS` (default `localhost:7233`). It uses only the namespaces `tui-seed-a`, `tui-seed-b` and `default`. It never touches `gateway`, `temporal-system`, or any other namespace.

```sh
cd test/seed
GOTOOLCHAIN=auto go run . seed --run-id <id>          # idempotent; started=0 on a repeat
GOTOOLCHAIN=auto go run . worker                       # foreground; run it in the background for the seed
GOTOOLCHAIN=auto go run . reset-disposables --run-id <id> --count 10
GOTOOLCHAIN=auto go run . verify --run-id <id>         # exits non-zero if any matrix row is missing or wrong
```

- `seed` registers `tui-seed-a` and `tui-seed-b` with 1 day of retention, then starts every fixed workflow with an existence check first, so reruns start nothing. It also creates the run-ID-scoped failed and timeout sets, the volume set and the two schedules.
- `seed` resets `seed-reset-1` once it has completed, which needs the worker running. Without a worker it prints a warning and `verify` reports the missing reset.
- `reset-disposables` terminates every running `tempolens-e2e-disposable-*` in `tui-seed-a` with reason `seed reset`, then starts `--count` fresh runs.
- `verify` checks each fixed row for its expected status, the can-1 run chain, the reset lineage, the volume count and the schedule pause state.

All seed workflows run on task queue `tempolens-seed`, so the live `default` worker never picks them up.

### Search attributes

`tui-seed-a` and `tui-seed-b` each have these attributes, created per namespace with `temporal operator search-attribute create --namespace <ns> --name <name> --type <type>`:

- `SeedRun` (Keyword): the failed, timeout and disposable runs.
- `SeedPriority` (Int): the failed, timeout and disposable runs.
- `SeedCustomer` (Keyword): the running and completed workflows, with values `acme`, `globex` and `initech`.

They are not defined in `default`, and the seed never sets them there. Creating them is a one-time setup step. The seed does not create them.

## Dex

```sh
docker compose -f test/dex/docker-compose.e2e.yml up -d dex
docker compose -f test/dex/docker-compose.e2e.yml down --remove-orphans   # when testing ends
```

Static users, all with the password `password`:

| User | Groups claim |
|---|---|
| `writer@example.test` | `tempolens-test:Platform Team` |
| `reader@example.test` | `tempolens-test:Some Team` |
| `nogroups@example.test` | none |
| `padded@example.test` | `" tempolens-test:Platform Team"` (leading space kept on purpose) |

To check the claims, request a password-grant token with the local client secret from `dex/config.yaml`, then decode the id_token payload.

`test/dex/session-keys.env` holds a local-only `TEMPOLENS_SESSION_KEYS` value. It is git-ignored and generated when missing:

```sh
test/dex/gen-session-keys.sh   # writes the file only if it does not exist
```

## Ports and containers

- Dex: `127.0.0.1:5599` (issuer), `127.0.0.1:8236` (the e2e tempolens server, phase 9; 8234 belongs to the dev server).
- Never reuse containers that this harness does not own: the upstream reference on `:8233` and the live Temporal on `:7233`. This harness only reads and writes the seed namespaces above.
