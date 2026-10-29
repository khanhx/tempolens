# Tempolens e2e (tester-owned)

LOCAL TEST ONLY. Nothing here is for production. Users, passwords and secrets are the local test values from `test/dex`.

## Parts

- `routes.tsv`: the authz route matrix (92 rows). Columns: id, method, path, body, headers (a variant), expected status for reader, writer, nogroups and padded, note. Generated from `docs/api-contract.md` Contract-Version 1 and INV §3. The matrix is maintained by hand. Re-check it against the contract at the start of each run.
- `authz.sh`: curl runner. It sets the Cookie header directly and never uses a cookie jar. It checks each status, validates error bodies as `google.rpc.Status`, checks the role on `/api/x/me`, takes a snapshot before and after the reader pass, runs the stream-cap and rate-burst checks, and exits non-zero on any mismatch.
- `login.ts`: drives the Dex password form and saves `out/<user>.cookie`.
- `functional.spec.ts`: skeleton blocks, all `fixme` until phase 10.
- `columns.spec.ts`: workflow list columns in the single-namespace and all-namespaces views (sort cycle, add, reorder, drag, remove, reset, memo and property columns, and a hand-written single-encoded `cols` link with a comma key). Needs `RUN_ID` from a seed run with the memo set.
- `console.spec.ts`: the command console, per role. Reads run on `tui-seed-a`. Writes run only on `tui-test-*` data that the spec creates and removes: a workflow started and terminated through the console, and a namespace created and deleted by admin. Covers the read user's disabled mutating command (CLI and raw) with its reason, the server's 403 for read and write on the same calls, the typed confirm, the admin-only refusal for write, a raw read, and a parse error. Needs `RUN_ID` and the `reader`, `writer` and `admin` cookies.
- `test/report/console-capture.spec.ts` shares the same console states as screenshots, and `build-columns-report.mjs` embeds them with the table shots in `plans/reports/tester-261029-0816-columns-console-e2e.html`.

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
