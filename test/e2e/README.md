# Tempolens e2e (tester-owned)

LOCAL TEST ONLY. Nothing here is for production. Users, passwords and secrets are the local test values from `test/dex`.

## Parts

- `routes.tsv`: the authz route matrix (92 rows). Columns: id, method, path, body, headers (a variant), expected status for reader, writer, nogroups and padded, note. Generated from `docs/api-contract.md` Contract-Version 1 and INV §3. The matrix is maintained by hand. Re-check it against the contract at the start of each run.
- `authz.sh`: curl runner. It sets the Cookie header directly and never uses a cookie jar. It checks each status, validates error bodies as `google.rpc.Status`, checks the role on `/api/x/me`, takes a snapshot before and after the reader pass, runs the stream-cap and rate-burst checks, and exits non-zero on any mismatch.
- `login.ts`: drives the Dex password form and saves `out/<user>.cookie`.
- `functional.spec.ts`: skeleton blocks, all `fixme` until phase 10.

## Session key

`authz.sh` and `login.spec.ts` do not read the session key. A local server run reads it through `TEMPOLENS_SESSION_KEYS`, from `test/dex/session-keys.env`. Create the file with `test/dex/gen-session-keys.sh` when it is missing. The file is git-ignored.

## Run (phase 10)

```sh
cd test/e2e
npm ci
RUN_ID=<run-id> PARENT_RUN_ID=<seed-parent-1 run id> BASE=http://localhost:8236 ./authz.sh
npm run typecheck
```

Before `authz.sh`, reset the disposables: `reset-disposables --run-id <run-id> --count 13`. The matrix uses disposables 1 to 13. The batch rows match every running disposable of the run, so run them last.

## Pacing

The `/api/x` rows are spaced 0.25 s apart. The per-principal limit is 5 requests per second with a burst of 10, so faster calls would get false 429s.

## Assumptions to confirm in phase 10

- `TEMPOLENS_AUTH_READ_GROUPS` is unset in the e2e env, so `nogroups` and `padded` are read-only, like `reader`.
- Unknown JSON fields are rejected while decoding, before authz (rows D04, D05 expect 400 for everyone).
- `AddSearchAttributes` has no gateway route, so rows B05 and B04 expect 404 or 405, not 403.
