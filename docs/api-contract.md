Contract-Version: 7

# Tempolens HTTP API contract

This file is the contract between the Tempolens server (`cmd/tempolens`, `internal/**`), the SPA (`web/**`) and the tests (`test/**`). It covers `/auth/*`, `/api/x/*`, `/healthz`, `/readyz`, and the rules for using the upstream-compatible `/api/v1/*` surface.

Change control: the frontend and tester request changes through the lead. The backend edits this file and bumps `Contract-Version` on every change. After version 1, changes are additive only, unless the lead approves a breaking change.

## 1. General rules

### 1.1 Origin, methods and CSRF

- Every route is same-origin. The server sends no CORS headers and answers no preflight.
- Every request whose method is not `GET` or `HEAD` (in practice `POST` and `DELETE`) must send both:
  - `X-Tempolens: 1`, and
  - `Origin` exactly equal to `TEMPOLENS_PUBLIC_ORIGIN` (for example `http://localhost:8234`).

  Otherwise the server answers 403 before any other processing. This applies in every mode, including auth disabled, and to `POST /auth/logout`.
- `/api/v1/*` accepts `GET`, `POST` and `DELETE`. The `/api/x` routes accept the methods listed for them in section 3 (`GET` unless stated). Every other route accepts only `GET` and `HEAD`. Any other method returns 405.
- Request bodies are limited to 4 MiB (413 above that); `POST /api/x/console/invoke` is limited to 1 MiB (3.9).
- When auth is disabled (`TEMPOLENS_AUTH_DISABLED=true`, local dev only), every request must carry a `Host` of `localhost` or `127.0.0.1`, with any port. Any other `Host` gets 403 on every route.

### 1.2 Sessions

- Auth uses a sealed, HttpOnly cookie, `__Host-tempolens_session`. The SPA never reads it and never sends an `Authorization` header. Fetches use `credentials: 'same-origin'`.
- The session has an absolute lifetime (`TEMPOLENS_SESSION_TTL`, default 8h) and is never refreshed. On expiry the user logs in again through Dex.
- When auth is disabled, there is no cookie: every request runs as a fixed principal with role `TEMPOLENS_AUTH_DISABLED_ROLE` (default `read`).
- Public routes (no session needed): `/healthz`, `/readyz`, `/auth/*`, `/assets/*`.
- Without a valid session:
  - an API call (`/api/v1/*`, `/api/x/*`) returns 401;
  - any other `GET` (an HTML navigation such as `/namespaces/default/workflows`) returns 302 to `/auth/sso?returnTo=<path+query>`.

### 1.3 Status codes

| Status | Meaning | SPA behaviour |
|---|---|---|
| 400 | Validation failed: bad parameter, unknown JSON field, missing `reason`, bad page token | Show the message |
| 401 | No session, session expired, or the user's groups no longer grant access | Redirect to `/auth/sso?returnTo=<location.pathname + location.search>` (keep the URL) |
| 403 | Denied: role, env flag, forbidden variant, namespace guard, CSRF, Host | Show the message; do not retry |
| 404 | Unknown route, or a Temporal NotFound | Show not found |
| 405 | Method not allowed on that route | – |
| 413 | Body over 4 MiB (1 MiB on the console, 3.9) | – |
| 429 | Per-principal or global limit reached. Carries `Retry-After: <seconds>` | Back off for `Retry-After` |
| 501 | The Temporal server does not implement the RPC (for example Nexus or workflow pause on 1.24) | Show a "not available on this server" state |
| 503 | Auth not ready (OIDC discovery pending), or Temporal unavailable | Show a retry state |

### 1.4 Evaluation order

A request is checked in this order; the first failing check decides the status, and Temporal is called only when every check passes:

1. Host allowlist (auth disabled only) → 403.
2. CSRF (`X-Tempolens`, `Origin`) on non-GET/HEAD → 403.
3. Session → 401 on `/api/*` (an unauthenticated HTML navigation gets the 302 of section 1.2 instead, after the method check).
4. Route and method: unknown path → 404; method not allowed on that path → 405 (`code: 12`), including a gateway path that exists only for other methods. 501 is never used for routing.
5. Body size (over 4 MiB) → 413.
6. JSON decoding of the body, including unknown fields → 400. This happens before authorization, so a read user also gets 400 or 413 here.
7. Authorization of the RPC, in this order: unknown RPC → 403; namespace guard (`temporal-system`, empty namespace) → 403; role and class → 403 (401 if the user's groups no longer grant access); env flags → 403.
8. Validators (section 2, rule 5), including protected namespaces → 400 or 403. They run only after authorization passes, so a read user gets 403 even for a request a write user would get 400 for.
9. Confirmation (section 1.6): a missing or mismatched `X-Tempolens-Confirm`, or a missing `X-Tempolens-Reason` where required → 400.

An RPC that has no `/api/v1` route at all (for example DeleteWorkflowExecution or AddSearchAttributes) is unreachable through `/api/v1`: the request gets 404 or 405 from step 3, never 403. Section 3.8 serves the few the UI needs under `/api/x`, through the same authorization.

### 1.5 Error body

Every JSON error body, from `/api/v1`, `/api/x` and the middleware alike, has the `google.rpc.Status` shape:

```json
{ "code": 7, "message": "permission denied: role read cannot call TerminateWorkflowExecution", "details": [] }
```

`code` is the gRPC code: 3 InvalidArgument (400), 4 DeadlineExceeded (504), 5 NotFound (404), 7 PermissionDenied (403), 8 ResourceExhausted (429), 12 Unimplemented (405/501), 14 Unavailable (503), 16 Unauthenticated (401). `details` is always an array, possibly empty. The `message` wording is not part of the contract; clients must branch on the HTTP status and `code` only.

A 429 `{code:8}` has two sources:
- **Tempolens' own limits** (the `/api/x` rate, scan slots, graph budget, per-user streams) always send `Retry-After` in whole seconds.
- **Temporal's ResourceExhausted** (for example "Max concurrent batch operations is reached" on a batch start, or a Temporal rate limit) is passed through on `/api/v1` and `/api/x` alike as 429 with Temporal's message and details, but **without** `Retry-After`, because Temporal does not provide one.

Clients should treat a 429 without `Retry-After` as "try again later" and not retry automatically in a tight loop.

The `/auth/*` routes are browser navigations: their errors are short `text/plain` pages with the status codes listed in section 4.

### 1.6 Destructive actions: confirmation and reason headers

Destructive requests must name their target in `X-Tempolens-Confirm`, so the UI's typed confirmation is enforced by the server. The value is the target, percent-encoded with `encodeURIComponent`. A missing, undecodable or mismatched value, or a request whose target is empty, → 400 `{code:3}`, and Temporal is not called. The check runs after the role, flag and validator checks, so a user without the role still gets 403.

| Action | Route | `X-Tempolens-Confirm` must equal |
|---|---|---|
| Terminate a workflow | `POST /api/v1/namespaces/{ns}/workflows/{wf}/terminate` | the workflow ID |
| Delete a workflow | `DELETE /api/x/workflow` (3.8) | the workflow ID |
| Batch terminate or batch delete | `POST /api/v1/namespaces/{ns}/batch-operations/{jobId}` | the job ID |
| Delete a namespace | `DELETE /api/x/namespace` (3.8) | the namespace name |
| Remove search attributes | `DELETE /api/x/search-attributes` (3.8) | the attribute names, comma-separated in request order |

`X-Tempolens-Reason` (percent-encoded) carries the reason for a workflow delete, whose request has no `reason` field; it is required there (missing or blank → 400) and is written to the audit line. Other actions keep their `reason` field.

Every destructive action writes an audit line after Temporal answers, with `target` and the result `code`.

## 2. `/api/v1/*`: upstream gateway surface

`/api/v1/*` is the grpc-gateway surface generated from `go.temporal.io/api` v1.64.0 (WorkflowService and OperatorService). Paths, query parameters and response JSON are identical to upstream `temporalio/ui` 2.53.0:

- lowerCamel field names;
- enums as names, for example `WORKFLOW_EXECUTION_STATUS_RUNNING`;
- int64 values as strings, for example `"eventId": "5"`;
- payloads as `{"metadata":{"encoding":"<base64>"},"data":"<base64>"}`, with no payload shorthand.

Rules:

1. **Workflow IDs** and other path parameters are `encodeURIComponent`'d exactly once. `%2F` inside a workflow ID is preserved.
2. **Unknown JSON fields** in a request body are rejected with 400 (`code: 3`).
3. **Every RPC is authorized by name** (READ, WRITE, ADMIN, BLOCK), never by path. A user whose role is below the RPC's class, or anyone calling a BLOCK RPC, gets 403 `{code:7}` and Temporal is not called. The classification table is `internal/authz/policy.go`.

   | Role | Gets | From |
   |---|---|---|
   | `read` | READ | every authenticated user (or `TEMPOLENS_AUTH_READ_GROUPS`) |
   | `write` | READ + WRITE | a group in `TEMPOLENS_AUTH_WRITE_GROUPS` |
   | `admin` | READ + WRITE + ADMIN | a group in `TEMPOLENS_AUTH_ADMIN_GROUPS` (no default) |

   - **WRITE:**
     - StartWorkflowExecution, SignalWorkflowExecution, SignalWithStartWorkflowExecution, UpdateWorkflowExecution;
     - RequestCancelWorkflowExecution, TerminateWorkflowExecution, ResetWorkflowExecution, DeleteWorkflowExecution;
     - PauseWorkflowExecution, UnpauseWorkflowExecution;
     - StartBatchOperation (terminate, cancel, reset), StopBatchOperation;
     - CreateSchedule, UpdateSchedule, PatchSchedule, DeleteSchedule;
     - RespondActivityTaskCompletedById, RespondActivityTaskFailedById (CLI `activity complete` / `activity fail`);
     - PauseActivity, UnpauseActivity, ResetActivity, UpdateActivityOptions (Unimplemented on Temporal 1.24, so they answer 501 there; gate them on capabilities);
     - OperatorService CreateNexusEndpoint, UpdateNexusEndpoint, DeleteNexusEndpoint.
   - **ADMIN:** RegisterNamespace, UpdateNamespace, OperatorService DeleteNamespace, OperatorService AddSearchAttributes, OperatorService RemoveSearchAttributes, and StartBatchOperation with `deletionOperation` (batch delete).
   - **READ** includes the CLI reads: ListTaskQueuePartitions, GetWorkerBuildIdCompatibility, GetWorkerVersioningRules, GetWorkerTaskReachability, GetClusterInfo, GetSystemInfo. QueryWorkflow is READ.
   - **BLOCK**, for every user: DeprecateNamespace, remote-cluster calls, worker versioning and deployment writes (UpdateWorkerVersioningRules and UpdateWorkerBuildIdCompatibility are off by default on Temporal 1.24 and not used by the UI), UpdateWorkflowExecutionOptions, ExecuteMultiOperation, workflow rules, standalone activities and Nexus operations, and the worker protocol.
4. **Env flags** move RPCs to BLOCK (403 for everyone):

   | Flag | Blocks |
   |---|---|
   | `TEMPOLENS_DISABLE_WRITE_ACTIONS` | every WRITE and ADMIN RPC |
   | `TEMPOLENS_WORKFLOW_TERMINATE_DISABLED` | TerminateWorkflowExecution; batch `terminationOperation` |
   | `TEMPOLENS_WORKFLOW_CANCEL_DISABLED` | RequestCancelWorkflowExecution; batch `cancellationOperation` |
   | `TEMPOLENS_WORKFLOW_SIGNAL_DISABLED` | SignalWorkflowExecution, SignalWithStartWorkflowExecution |
   | `TEMPOLENS_WORKFLOW_UPDATE_DISABLED` | UpdateWorkflowExecution |
   | `TEMPOLENS_WORKFLOW_RESET_DISABLED` | ResetWorkflowExecution; batch `resetOperation` |
   | `TEMPOLENS_WORKFLOW_PAUSE_DISABLED` | PauseWorkflowExecution, UnpauseWorkflowExecution |
   | `TEMPOLENS_BATCH_ACTIONS_DISABLED` | StartBatchOperation, StopBatchOperation |
   | `TEMPOLENS_START_WORKFLOW_DISABLED` | StartWorkflowExecution; SignalWithStartWorkflowExecution; CreateSchedule; UpdateSchedule; PatchSchedule with `triggerImmediately` or `backfillRequest` |
   | `TEMPOLENS_SCHEDULE_ACTIONS_DISABLED` | CreateSchedule, UpdateSchedule, PatchSchedule, DeleteSchedule |
   | `TEMPOLENS_NEXUS_ACTIONS_DISABLED` | CreateNexusEndpoint, UpdateNexusEndpoint, DeleteNexusEndpoint |
   | `TEMPOLENS_WORKFLOW_DELETE_DISABLED` | DeleteWorkflowExecution; batch `deletionOperation` |
   | `TEMPOLENS_ACTIVITY_ACTIONS_DISABLED` | RespondActivityTaskCompletedById, RespondActivityTaskFailedById, PauseActivity, UnpauseActivity, ResetActivity, UpdateActivityOptions |
   | `TEMPOLENS_NAMESPACE_ACTIONS_DISABLED` | RegisterNamespace, UpdateNamespace, DeleteNamespace |
   | `TEMPOLENS_SEARCH_ATTRIBUTE_ACTIONS_DISABLED` | AddSearchAttributes, RemoveSearchAttributes |

5. **Validators** run on WRITE RPCs before Temporal is called:
   - TerminateWorkflowExecution, ResetWorkflowExecution and StartBatchOperation require a non-empty (trimmed) `reason` → else 400.
   - StartBatchOperation:
     - only `terminationOperation`, `cancellationOperation`, `resetOperation`, or (admin only) `deletionOperation` → any other operation (signal, update options, activity operations) is 403;
     - `visibilityQuery` must be non-empty → else 403;
     - `executions` and `targetExecutions` must be absent or empty → else 403. To act on selected rows, send `visibilityQuery: 'RunId="a" OR RunId="b"'` (at most 100 rows).
   - ResetWorkflowExecution and a batch `resetOperation` must not carry `postResetOperations` → else 403.
   - StartWorkflowExecution and SignalWithStartWorkflowExecution must not carry `completionCallbacks` or `requestEagerExecution: true` → else 403 (SignalWithStart has neither field in api v1.64; the check applies if it gains them).
   - RegisterNamespace needs a `namespace` name and a positive `workflowExecutionRetentionPeriod` → else 400.
   - UpdateNamespace must not set `promoteNamespace` → else 403.
   - DeleteNamespace needs `namespace` (and no `namespaceId`) → else 400. It is refused (403) for `default`, `temporal-system` and every name in `TEMPOLENS_PROTECTED_NAMESPACES` (default `default`). Deletion is asynchronous on Temporal 1.24: the namespace is first renamed and marked deleted, so show "deleting", not "gone".
   - RemoveSearchAttributes is refused (403) for Temporal's system search attributes and any name starting with `Temporal`. AddSearchAttributes needs at least one name and a namespace → else 400.
   - CreateNexusEndpoint and UpdateNexusEndpoint must not target the `temporal-system` namespace (`spec.target.worker.namespace`) → else 403.
   - Namespace guard: any WRITE on `temporal-system` → 403; a namespace-scoped WRITE with an empty namespace → 403; a READ on `temporal-system` while `TEMPOLENS_SHOW_TEMPORAL_SYSTEM_NAMESPACE` is false → 403. With that flag false, `ListNamespaces` (`GET /api/v1/namespaces`) also leaves `temporal-system` out of its response.
6. **Identity.** The server overwrites the request's `identity` with `tempolens:<email>`, using the email only when the id_token has `email_verified: true` and the subject (`sub`) otherwise (`tempolens:local-dev` when auth is disabled). Whatever identity the client sends is ignored.
7. **Headers are not forwarded.** No HTTP header (including `Authorization` and `Grpc-Metadata-*`) reaches Temporal as gRPC metadata.
8. **Long-poll.** History long-polls use `GET /api/v1/namespaces/{ns}/workflows/{wf}/history?execution.runId={run}&waitNewEvent=true&nextPageToken=…`. Concurrent long-polls plus `/api/x/history-export` downloads are capped per principal at `TEMPOLENS_MAX_STREAMS_PER_USER` (default 4); the next one gets 429.
9. **Unprefixed paths** (`/namespaces/...`, `/cluster/...` without `/api/v1`) are never routed to Temporal. A non-GET there returns 405; a GET serves the SPA.
10. **Raw history.** Upstream's `/api/v1/namespaces/{ns}/workflows/{wf}/run/{run}/history.json` is not served by the server. Use `/api/x/history-export` (section 3.7).
11. **RPCs that Temporal 1.24 does not implement** return 501 `{code:12}`. Gate the feature on `/api/v1/system-info` capabilities instead of probing.

### 2.1 `GET /api/v1/settings`

Kept in the upstream shape for compatibility. New SPA code should use `/api/x/me` instead.

```json
{
  "Auth": { "Enabled": true, "Options": null, "RedirectToProvider": true },
  "DefaultNamespace": "default",
  "ShowTemporalSystemNamespace": false,
  "NavCollapsedByDefault": false,
  "FeedbackURL": "",
  "DisableNewsFetch": true,
  "Codec": { "Endpoint": "", "PassAccessToken": false, "IncludeCredentials": false, "DefaultErrorMessage": "", "DefaultErrorLink": "" },
  "Version": "0.1.0",
  "DisableWriteActions": false,
  "WorkflowTerminateDisabled": false,
  "WorkflowCancelDisabled": false,
  "WorkflowSignalDisabled": false,
  "WorkflowUpdateDisabled": false,
  "WorkflowResetDisabled": false,
  "WorkflowPauseDisabled": false,
  "BatchActionsDisabled": false,
  "StartWorkflowDisabled": false,
  "HideWorkflowQueryErrors": false,
  "RefreshWorkflowCountsDisabled": false,
  "ActivityCommandsDisabled": false
}
```

`DisableWriteActions` is `true` when the caller's role is `read` or `TEMPOLENS_DISABLE_WRITE_ACTIONS` is set. The per-action fields mirror the env flags of section 2, rule 4. `ActivityCommandsDisabled` is `true` when `DisableWriteActions` is, or when `TEMPOLENS_ACTIVITY_ACTIONS_DISABLED` is set.

## 3. `/api/x/*`: Tempolens extensions

Common rules:

- `GET` only, except the routes in 3.8 and `POST /api/x/console/invoke` (3.9). Every RPC these handlers make goes through the same authorization as `/api/v1`, so read users can use every `GET /api/x` route, and the 3.8 write routes need the role their RPC requires.
- Each principal is rate limited (`TEMPOLENS_XAPI_RPS`, default 5/s, burst 10) → 429 with `Retry-After`. `/api/x/graph` has its own budget instead (below).
- Scans (`/search/*`) also take a process-wide slot (`TEMPOLENS_SCAN_MAX_INFLIGHT`, default 2) → 429 with `Retry-After: 5` when none is free.
- Graph walks are interactive and have their own budget, shared with nothing else:
  - a per-principal bucket at `TEMPOLENS_XAPI_RPS` with a burst of max(20, 4 × rate) (default 5/s, burst 20);
  - at most 2 concurrent walks per principal;
  - a process-wide pool of 2 × `TEMPOLENS_SCAN_MAX_INFLIGHT` walks (default 4). A request waits up to 2 s for a free slot.

  Any of these limits answers 429 with `Retry-After: 1`.
- `namespaces` is a comma-separated list, or `*` for every namespace the user may read (`temporal-system` is excluded unless `TEMPOLENS_SHOW_TEMPORAL_SYSTEM_NAMESPACE` is on). A name outside that set → 400. More than `TEMPOLENS_FANOUT_MAX_NAMESPACES` (default 50) → 400. Missing → 400.
- `query` is a Temporal visibility query (the same syntax as `/api/v1`). The server always wraps it as `(<query>)` before appending its own clauses. It returns 400 for `ORDER BY` outside string literals (case-insensitive; results always use the visibility order), for unbalanced parentheses, and for an unterminated string literal.
- Unlike `/api/v1`, counts and sizes in `/api/x` responses are JSON numbers. `eventId` stays a string, to match `/api/v1` history JSON. Times are RFC 3339 strings with nanoseconds, or `null` when absent. Workflow status is the enum name (`WORKFLOW_EXECUTION_STATUS_RUNNING`); an unknown status is `WORKFLOW_EXECUTION_STATUS_UNSPECIFIED`.

### 3.1 `GET /api/x/me`

Identity, role and UI settings. The SPA loads it once at start and after a 401 re-login.

```json
{
  "user": { "sub": "CgR0ZXN0EgVsb2NhbA", "email": "alice@example.com", "name": "Alice" },
  "role": "write",
  "authEnabled": true,
  "settings": {
    "defaultNamespace": "default",
    "showSystemNamespace": false,
    "disabledActions": ["namespace", "searchAttribute", "batchDelete"],
    "protectedNamespaces": ["default", "temporal-system"],
    "codec": {
      "endpoint": "",
      "includeCredentials": false,
      "defaultErrorMessage": "",
      "defaultErrorLink": ""
    },
    "limits": {
      "scanMaxWorkflows": 200,
      "fanoutMaxNamespaces": 50,
      "pageSizeMax": 100,
      "graphDepthMax": 3
    },
    "version": "0.1.0"
  }
}
```

- `user` is `null` when auth is disabled (`authEnabled: false`). `user.email` is `""` when the IdP did not mark the email as verified.
- `role` is `"read"`, `"write"` or `"admin"`.
- `disabledActions` lists the actions the UI must hide, drawn from `terminate`, `cancel`, `signal`, `update`, `reset`, `pause`, `batch`, `start`, `schedule`, `nexus`, `delete`, `activity`, `namespace`, `searchAttribute`, `batchDelete`, in that order. It holds:
  - every action whose env flag is set (`schedule` = `TEMPOLENS_SCHEDULE_ACTIONS_DISABLED`, `nexus` = `TEMPOLENS_NEXUS_ACTIONS_DISABLED`, `delete` = `TEMPOLENS_WORKFLOW_DELETE_DISABLED`, `activity` = `TEMPOLENS_ACTIVITY_ACTIONS_DISABLED`, `namespace` = `TEMPOLENS_NAMESPACE_ACTIONS_DISABLED`, `searchAttribute` = `TEMPOLENS_SEARCH_ATTRIBUTE_ACTIONS_DISABLED`; `batchDelete` follows `batch` and `delete`);
  - for `write`, also the admin-only actions `namespace`, `searchAttribute` and `batchDelete`;
  - all fifteen when the role is `read` or `TEMPOLENS_DISABLE_WRITE_ACTIONS` is set.

  Signal-with-start is hidden when `start` or `signal` is. The server enforces the same rules (section 2), so hiding is a convenience, not the protection.
- `protectedNamespaces` lists the namespaces that can never be deleted, sorted and deduplicated: `default`, `temporal-system` and every name in `TEMPOLENS_PROTECTED_NAMESPACES`. The server refuses their deletion (403, section 2 rule 5); the UI should not offer it.
- `version` is the Tempolens build version.

### 3.2 `GET /api/x/workflows`

Cross-namespace workflow list, merged into one ordering.

Parameters: `namespaces` (required), `query` (optional), `pageSize` (1–100, default 50; outside that range → 400), `pageToken` (optional, opaque, from the previous response).

```json
{
  "executions": [
    {
      "namespace": "tui-seed-a",
      "execution": {
        "execution": { "workflowId": "seed-running-1", "runId": "0193e4c4-6f1e-7b5a-9d0c-7f1e2a3b4c5d" },
        "type": { "name": "SeedWorkflow" },
        "startTime": "2026-10-27T08:00:00.123456Z",
        "status": "WORKFLOW_EXECUTION_STATUS_RUNNING",
        "historyLength": "5",
        "executionTime": "2026-10-27T08:00:00.123456Z",
        "memo": {},
        "taskQueue": "tempolens-seed",
        "rootExecution": { "workflowId": "seed-running-1", "runId": "0193e4c4-6f1e-7b5a-9d0c-7f1e2a3b4c5d" }
      }
    }
  ],
  "nextPageToken": "eyJ2IjoxLCJxIjoi...",
  "errors": [
    { "namespace": "tui-seed-b", "code": 14, "message": "unavailable" }
  ]
}
```

- `execution` is a `WorkflowExecutionInfo` in exactly the `/api/v1` JSON form (int64 as strings).
- Ordering, on both SQL and Elasticsearch visibility (Temporal 1.24): running workflows first, then `closeTime` desc, `startTime` desc, `runId` asc. Elasticsearch has no `runId` tie-breaker, so there rows with identical close and start times may come back in a different order across pages.
- `nextPageToken` is `""` on the last page. The token is HMAC-protected and bound to the same `namespaces` and `query`: a tampered token, or one reused with different parameters, returns 400. Tokens do not survive a server restart when auth is disabled.
- A namespace that fails is reported in `errors` (gRPC `code`) and the rest of the page is still returned. It stays in `nextPageToken` at its last good position, so the next page retries it. `errors` is always present, possibly empty.

### 3.3 `GET /api/x/workflows/count`

Parameters: `namespaces` (required), `query` (optional).

```json
{
  "total": 42,
  "byStatus": { "Running": 10, "Completed": 25, "Failed": 5, "Terminated": 2 },
  "perNamespace": {
    "tui-seed-a": { "total": 30, "byStatus": { "Running": 8, "Completed": 17, "Failed": 5 } },
    "default": { "total": 12, "byStatus": { "Running": 2, "Completed": 8, "Terminated": 2 } }
  },
  "errors": []
}
```

- `byStatus` keys are the visibility `ExecutionStatus` values: `Running`, `Completed`, `Failed`, `Canceled`, `Terminated`, `ContinuedAsNew`, `TimedOut`. A status with no workflows is omitted.
- A failing namespace is left out of the totals and reported in `errors` (same shape as 3.2).

### 3.4 `GET /api/x/search/activity`

Finds workflows by activity type. Bounded scan.

Parameters:

- `namespaces` (required), `query` (optional, narrows the candidates);
- `activityType` (required, exact activity type name);
- `mode`: `pending` (default) scans the pending activities of running workflows; `history` scans `ActivityTaskScheduled` events in the history of any workflow;
- `minAttempt` (optional, `pending` only, integer ≥ 1): match only pending activities whose `attempt` is at least this value, the stuck-activity finder. Sending it with `mode=history` returns 400;
- `max` (optional): candidate cap, clamped to `min(max, TEMPOLENS_SCAN_MAX_WORKFLOWS, 1000)`.

### 3.5 `GET /api/x/search/event`

Finds workflows by history event. Bounded scan.

Parameters:

- `namespaces` (required), `query` (optional);
- `eventType` (optional): the enum name, for example `EVENT_TYPE_ACTIVITY_TASK_FAILED`;
- `failureText` (optional): case-insensitive substring matched against the failure message and its cause chain;
- at least one of `eventType` and `failureText` is required → else 400;
- `max` (optional): as in 3.4.

### 3.4–3.5 response

```json
{
  "matches": [
    {
      "namespace": "tui-seed-a",
      "workflowId": "seed-stuck-1",
      "runId": "0193e4c4-7a10-7c2b-8e1f-0a1b2c3d4e5f",
      "workflowType": "StuckWorkflow",
      "status": "WORKFLOW_EXECUTION_STATUS_RUNNING",
      "startTime": "2026-10-27T08:00:00Z",
      "closeTime": null,
      "hits": [
        {
          "activityId": "5",
          "attempt": 4,
          "eventTime": "2026-10-27T08:03:10Z",
          "detail": "AlwaysFail: activity failed on purpose"
        }
      ]
    }
  ],
  "candidates": 200,
  "scanned": 200,
  "partial": true,
  "partialReasons": ["cap"],
  "elapsedMs": 812
}
```

- A hit carries `eventId` (history hits), `activityId` (activity hits) and `attempt` (pending activity hits) when they apply; absent keys are omitted. `eventTime` is the event time, or for a pending activity its last started (else scheduled) time. `detail` is a short human-readable summary, such as the failure message; its wording is not part of the contract.
- `candidates` is the number of workflows the visibility query returned, after the cap. `scanned` is how many were fully examined.
- `partial` is true when the result may be incomplete. `partialReasons` is a subset of `cap` (candidate cap reached, a history over 10,000 events, more than 20 hits in one workflow, or more than 5,000 hits in the response; hits beyond a cap are dropped), `timeout` (`TEMPOLENS_SCAN_TIMEOUT` reached) and `error` (an RPC failed for some workflow). It is `[]` when `partial` is false.

### 3.6 `GET /api/x/graph`

Relationship graph around one run.

Parameters: `namespace` (required), `workflowId` (required), `runId` (required), `depth` (1–3, default 2; above 3 → 400).

What is included:

- **The parent/child tree, whatever `depth` is.** Every member of the focus's tree comes from one visibility query on `RootWorkflowId`/`RootRunId`, up to 500 members. Ancestors are always present. If the root is unknown or the tree is truncated, the tree is also walked per node from the focus within `depth` hops, so the focus's own neighbourhood is complete.
- **The expensive edges, bounded by `depth`:**
  - continue-as-new: up to `depth` × 10 runs before and after the focus (30 at depth 3);
  - reset lineage: reset edges within `depth` reset hops of the focus;
  - signal and cancel: the focus history at hop 1; each further hop reads the histories of the runs found at the previous hop (partners with a known run ID).

  A note says when a continue-as-new chain or a reset lineage continues beyond `depth`.

```json
{
  "nodes": [
    {
      "id": "n0",
      "namespace": "tui-seed-a",
      "workflowId": "seed-parent-1",
      "runId": "0193e4c4-0000-7000-8000-000000000001",
      "workflowType": "ParentWorkflow",
      "status": "WORKFLOW_EXECUTION_STATUS_COMPLETED",
      "startTime": "2026-10-27T08:00:00Z",
      "closeTime": "2026-10-27T08:00:09Z",
      "focus": false,
      "root": true
    },
    {
      "id": "n1",
      "namespace": "tui-seed-a",
      "workflowId": "seed-parent-1/child-0",
      "runId": "0193e4c4-0000-7000-8000-000000000002",
      "workflowType": "ChildWorkflow",
      "status": "WORKFLOW_EXECUTION_STATUS_COMPLETED",
      "startTime": "2026-10-27T08:00:01Z",
      "closeTime": "2026-10-27T08:00:05Z",
      "focus": true,
      "root": false
    }
  ],
  "edges": [
    { "from": "n0", "to": "n1", "kind": "child", "eventId": "7" }
  ],
  "truncated": false,
  "partial": false,
  "notes": []
}
```

- Node `id` is opaque and unique within one response; refer to runs by `namespace`/`workflowId`/`runId`.
- Exactly one node has `focus: true` (the requested run). `root: true` marks the root of the parent/child tree.
- Edge direction and `kind`:

  | `kind` | `from` → `to` | `eventId` (when known) |
  |---|---|---|
  | `child` | parent → child | parent's `StartChildWorkflowExecutionInitiated` |
  | `continuedAsNew` | previous run → next run | previous run's close event |
  | `reset` | base run → run created by the reset | – |
  | `signal` | sender → target | sender's `SignalExternalWorkflowExecutionInitiated` |
  | `cancelRequest` | requester → target | requester's `RequestCancelExternalWorkflowExecutionInitiated` |

- A target that cannot be resolved still appears as a node with status `WORKFLOW_EXECUTION_STATUS_UNSPECIFIED` and null times; its `runId` may be `""`.
- A signal or cancel sent by workflow ID only (no run ID) gives a target node with `runId: ""`. An incoming signal or cancel names its sender without a namespace; the sender is shown in the focus run's namespace.
- `resetRunId` is not populated by Temporal 1.24.3, so reset edges come from each run's `WorkflowTaskFailed` event with cause `RESET_WORKFLOW` and its `baseRunId`. Opening either the base run or the reset run shows the edge.
- `truncated` is true when the graph stopped at 300 nodes or the tree at 500 members. `partial` is true on a timeout or an RPC error. `notes` holds human-readable strings about edges that could not be determined.

### 3.7 `GET /api/x/history-export`

Downloads the full raw history of one run.

Parameters: `namespace`, `workflowId`, `runId` (all required).

- Response: `200`, `Content-Type: application/json`, `Content-Disposition: attachment; filename="<runId>-events.json"`. The body is a JSON array of `HistoryEvent` objects in the `/api/v1` JSON form, oldest first: `[{"eventId":"1",...},{"eventId":"2",...}]`. An empty history is `[]`.
- The body is streamed page by page. An error before the first byte returns a normal JSON error. An error after streaming began ends the response early, so the body is not valid JSON; clients must treat a parse failure as a failed download.
- Counts toward `TEMPOLENS_MAX_STREAMS_PER_USER` (429 above it).

### 3.8 Write and admin routes for RPCs without an `/api/v1` binding

These RPCs have no HTTP binding in api v1.64, so Tempolens serves them here. They follow `/api/v1` conventions:
- CSRF headers on non-GET (1.1);
- the request body is the RPC's request message in `/api/v1` JSON form, with unknown fields → 400;
- the response is the RPC's response message in the same form;
- errors are `google.rpc.Status`.

Query parameters override the same body fields.

| Method and path | RPC | Class | Parameters / body |
|---|---|---|---|
| `DELETE /api/x/workflow?namespace=&workflowId=&runId=` | DeleteWorkflowExecution | WRITE | `runId` optional (empty = current run). Needs `X-Tempolens-Confirm: <workflowId>` and `X-Tempolens-Reason`. Asynchronous: the execution can stay visible for a few seconds, so show "deleting" |
| `DELETE /api/x/namespace?namespace=` | OperatorService DeleteNamespace | ADMIN | optional body `{"namespaceDeleteDelay":"…"}`. Needs `X-Tempolens-Confirm: <namespace>`. Answers `{"deletedNamespace":"<renamed>"}` |
| `POST /api/x/search-attributes?namespace=` | OperatorService AddSearchAttributes | ADMIN | body `{"searchAttributes":{"<name>":"INDEXED_VALUE_TYPE_KEYWORD", …}}` |
| `DELETE /api/x/search-attributes?namespace=&name=a&name=b` | OperatorService RemoveSearchAttributes | ADMIN | Needs `X-Tempolens-Confirm: a,b` (names in request order) |
| `GET /api/x/task-queue-partitions?namespace=&taskQueue=` | ListTaskQueuePartitions | READ | – |

### 3.9 Command console

The console invokes Temporal RPCs by name. There is no shell and no CLI binary on the server: each call is one gRPC call on the same intercepted connection as every other route, so roles, env flags, the namespace guard, validators, confirmation and reason headers (1.6), identity stamping, metadata replacement and audit apply unchanged.

**Allowlist.** The console accepts exactly the unary RPCs of `temporal.api.workflowservice.v1.WorkflowService` and `temporal.api.operatorservice.v1.OperatorService` that the authorization policy classes READ, WRITE or ADMIN. The list is derived from the policy, so reclassifying an RPC changes the console with it. BLOCK RPCs, unclassified RPCs, streaming RPCs and every other service are refused with 403 before Temporal is called.

#### `GET /api/x/console/methods`

Any authenticated role. Returns the allowlist of this server, sorted by `service` then `name`:

```json
{ "methods": [
  { "method": "/temporal.api.operatorservice.v1.OperatorService/DeleteNamespace", "service": "OperatorService", "name": "DeleteNamespace", "class": "ADMIN" },
  { "method": "/temporal.api.workflowservice.v1.WorkflowService/DescribeNamespace", "service": "WorkflowService", "name": "DescribeNamespace", "class": "READ" }
] }
```

- `service` is `WorkflowService` or `OperatorService`; `class` is `READ`, `WRITE` or `ADMIN`.
- `class` is the static class. `StartBatchOperation` is listed as `WRITE`; its deletion variant needs admin when called.
- The list does not reflect env flags or `TEMPOLENS_DISABLE_WRITE_ACTIONS`; use `/api/x/me` (`disabledActions`) for those. A call to a disabled action gets 403.

#### `POST /api/x/console/invoke`

CSRF headers as for every non-GET request (1.1). Body (at most 1 MiB):

```json
{ "method": "/temporal.api.workflowservice.v1.WorkflowService/DescribeNamespace",
  "request": { "namespace": "default" } }
```

- `method` is the full gRPC method name, `/<package>.<Service>/<Method>`.
- `request` is the RPC's request message in `/api/v1` JSON form (lowerCamel field names, enum names, int64 as strings, payloads as `{"metadata":{…},"data":"<base64>"}`). Unknown fields → 400. Omitted or `null` means the empty request.
- Destructive RPCs need `X-Tempolens-Confirm` (and workflow delete `X-Tempolens-Reason`) exactly as in 1.6; the target rules are the RPC's, for example the workflow ID for TerminateWorkflowExecution, the namespace for DeleteNamespace, the job ID for a batch terminate or delete, and the comma-separated names for RemoveSearchAttributes.
- Response `200`: the RPC's response message in `/api/v1` JSON form, with no wrapper.
- Every call is bounded by a 30 s timeout, so a long-poll (for example GetWorkflowExecutionHistory with `waitNewEvent`, or PollWorkflowExecutionUpdate) returns at most after 30 s, with 504 `{code:4}` if Temporal has not answered. A confirmed destructive call runs to completion even if the client disconnects, so its audit line carries the real result.
- Rate limited by the `/api/x` per-principal limit (429 with `Retry-After`).

Errors, all `google.rpc.Status` (1.5); checks run in this order and Temporal is called only when every one passes:

| Status | When |
|---|---|
| 429 | `/api/x` rate limit |
| 405 | Not `POST` (`GET` or `HEAD` for `/console/methods`) |
| 413 `{code:3}` | Body over 1 MiB |
| 400 `{code:3}` | Body is not one JSON object `{method, request}`, has another top-level field, or `method` is not of the form `/<package>.<Service>/<Method>` |
| 403 `{code:7}` | `method` is not on the allowlist (BLOCK, unknown, streaming, another service). Writes an audit `deny` line (`code: PermissionDenied`, `reason: method not allowed in the console`) |
| 400 `{code:3}` | `request` does not decode into the method's request message (unknown field, wrong type) |
| 400/401/403 | The authorization, validator and confirmation checks of 1.4 steps 7–9 |
| any | Temporal's own error, mapped as on `/api/v1` (for example 404, 501 for an RPC the server does not implement, 504 on the timeout) |

## 4. Auth routes

### 4.1 `GET /auth/sso?returnTo=<path+query>`

Starts the OIDC login (authorization code + PKCE S256 + state + nonce) and answers 302 to Dex. Each login gets its own cookie, `__Host-tempolens_oauth_<first 8 characters of its state>`, valid for 10 minutes, so logins started in several tabs all complete. When a browser already holds 5 login cookies, they are cleared first.

- `returnTo` must be a relative path plus an optional query, starting with a single `/`, for example `/namespaces/default/workflows?query=...`. Anything else (a scheme, a host, `//…`, a backslash, control characters, raw or after one unescape) is replaced by `/`. The SPA sends `location.pathname + location.search`.
- Returns 503 (`text/plain`) until OIDC discovery has succeeded.
- When auth is disabled, returns 302 to the sanitised `returnTo`.

### 4.2 `GET <callback path>`

The path of `TEMPOLENS_AUTH_CALLBACK_URL`, normally `/auth/sso/callback`. Completes the login, sets `__Host-tempolens_session`, and answers 302 to the saved `returnTo`.

| Status | When |
|---|---|
| 302 | Login OK |
| 400 | State mismatch, missing or expired login cookie, or a missing `code` |
| 401 | Token exchange or id_token verification failed (audience, nonce, signature) |
| 403 | `TEMPOLENS_AUTH_READ_GROUPS` is set and no read, write or admin group matches (audited as `login_denied`) |
| 503 | OIDC discovery still pending |

Role mapping, with claim groups compared exactly (untrimmed): `admin` if a group is in `TEMPOLENS_AUTH_ADMIN_GROUPS`; otherwise `write` if a group is in `TEMPOLENS_AUTH_WRITE_GROUPS`; otherwise `read` if `TEMPOLENS_AUTH_READ_GROUPS` is unset or a group matches it; otherwise 403. Groups are re-checked against the env on every request: an admin whose admin group was removed drops to `write` (if a write group still matches) or `read`. With auth disabled, `TEMPOLENS_AUTH_DISABLED_ROLE` may be `read`, `write` or `admin`.

### 4.3 `POST /auth/logout`

CSRF-checked like every non-GET request (section 1.1). Clears the session cookie and returns 204 with no body. It does not log out of Dex. The SPA then navigates to `/`, which leads to a new login. With auth disabled it is a no-op 204.

## 5. Health routes

- `GET /healthz` → 200 `{"status":"ok"}`. Process liveness only.
- `GET /readyz` → 200 when Temporal answers its health check (and, when auth is on, OIDC discovery has succeeded), else 503. Cached for 5 s.

  ```json
  { "status": "ok", "temporal": "ok", "oidc": "ok" }
  ```

  ```json
  { "status": "unavailable", "temporal": "unavailable", "oidc": "pending" }
  ```

  `status` is `ok` or `unavailable`. `temporal` is `ok` or `unavailable`; the cause is logged on the server, never returned. `oidc` is `ok`, `pending` or `disabled`.

## 6. SPA and static routes

- `GET /assets/*`: hashed assets, `Cache-Control: public, max-age=31536000, immutable`, pre-gzipped.
- Any other `GET` outside `/api/`, `/auth/` and the health routes returns `index.html` (`Cache-Control: no-cache`), so upstream deep links such as `/namespaces/{ns}/workflows/{wf}/{run}/history` keep working.
- Security headers on every response: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. Inline scripts and inline `<style>` elements are not allowed.

## 7. Local development

`make dev` runs the real server on port 8234 (override with `DEV_PORT`) with auth disabled and role `read`, so only `localhost` and `127.0.0.1` Host headers are accepted (section 1.1); `TEMPOLENS_AUTH_DISABLED_ROLE=write make dev` gives write. Every route in this contract is served; the phase 1 stub no longer exists.
