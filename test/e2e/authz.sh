#!/usr/bin/env bash
# LOCAL TEST ONLY. Route matrix for the Tempolens authz contract (Contract-Version 1).
#
# Contract-Version 6. Reads routes.tsv and sends every row as reader, writer, admin, nogroups and
# padded. Each user is one pass. The reader pass must not change any target state, and neither
# the reader nor the writer pass may change the namespace list or the search attributes.
# Writer and admin passes start from a fresh set of disposables (reset-disposables). Every row
# is checked for its expected status; the run exits non-zero on any unexpected status or on a
# malformed error body.
#
# Usage:
#   BASE=http://localhost:8236 RUN_ID=<run-id> PARENT_RUN_ID=<runId of seed-parent-1> ./authz.sh
#
# Cookies: out/<user>.cookie holds the __Host-tempolens_session value for each user,
# written by login.ts. The cookie is sent as a header, never through a cookie jar.
# Row placeholders: ${RUN_ID}, ${PARENT_RUN_ID} and ${WHO} (the user name, so each user creates
# its own tui-test- workflows, schedules, batch jobs and namespaces).
# Row variants: a base variant, then optional +confirm=<value> and +reason=<value> tokens for
# the X-Tempolens-Confirm and X-Tempolens-Reason headers.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROUTES="$HERE/routes.tsv"
OUT="$HERE/out"
BASE="${BASE:-http://localhost:8236}"
RUN_ID="${RUN_ID:?RUN_ID is required}"
PARENT_RUN_ID="${PARENT_RUN_ID:?PARENT_RUN_ID is required}"
# The rows create tui-test- objects named with ${RUN_ID}. Each pass gets its own tag, so a re-run never
# meets batch jobs, schedules or namespaces that a finished pass left behind. The disposable reset keeps RUN_ID.
TAG="${RUN_ID}-$(date +%H%M%S)"
NS="tui-seed-a"
COOKIE_NAME="__Host-tempolens_session"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TOTAL=0
FAILS=0
PENDING=0

fail() {
  FAILS=$((FAILS + 1))
  echo "FAIL $*"
}

cookie_value() {
  local user="$1" value
  value="$(cat "$OUT/$user.cookie")"
  printf '%s' "$value"
}

# Change one character in the middle of the sealed value, so the decoded bytes always change.
tampered_value() {
  local value idx c new
  value="$(cookie_value "$1")"
  idx=$((${#value} / 2))
  c="${value:idx:1}"
  if [ "$c" = "A" ]; then new=B; else new=A; fi
  printf '%s%s%s' "${value:0:idx}" "$new" "${value:idx+1}"
}

# Sends one request. Sets CODE, the response body in $TMP/body and headers in $TMP/headers.
send() {
  local method="$1" path="$2" body="$3" variant="$4" user="$5" base i
  local -a hdr=() tokens=()
  base="${variant%%+*}"
  IFS='+' read -r -a tokens <<< "$variant"
  case "$base" in
    no-csrf) hdr+=(-H "Origin: $BASE") ;;
    origin-evil) hdr+=(-H "X-Tempolens: 1" -H "Origin: http://evil.test") ;;
    no-origin) hdr+=(-H "X-Tempolens: 1") ;;
    *) hdr+=(-H "X-Tempolens: 1" -H "Origin: $BASE") ;;
  esac
  case "$base" in
    no-cookie) ;;
    tampered-cookie) hdr+=(-H "Cookie: $COOKIE_NAME=$(tampered_value "$user")") ;;
    *) hdr+=(-H "Cookie: $COOKIE_NAME=$(cookie_value "$user")") ;;
  esac
  for ((i = 1; i < ${#tokens[@]}; i++)); do
    case "${tokens[i]}" in
      confirm=*) hdr+=(-H "X-Tempolens-Confirm: ${tokens[i]#confirm=}") ;;
      reason=*) hdr+=(-H "X-Tempolens-Reason: ${tokens[i]#reason=}") ;;
      *) fail "unknown variant token ${tokens[i]}" ;;
    esac
  done
  local -a data=()
  if [ "$body" = "-" ]; then
    :
  elif [ "$body" = "@4mib+1" ]; then
    printf '{"reason":"' > "$TMP/big"
    head -c $((4 * 1024 * 1024 + 1)) /dev/zero | tr '\0' 'a' >> "$TMP/big"
    printf '"}' >> "$TMP/big"
    hdr+=(-H "Content-Type: application/json")
    data=(--data-binary "@$TMP/big")
  else
    printf '%s' "$body" > "$TMP/req"
    hdr+=(-H "Content-Type: application/json")
    data=(--data-binary "@$TMP/req")
  fi
  # /api/x is rate limited per principal (5/s, burst 10). Pace the read calls below that.
  case "$path" in /api/x/*) sleep 0.25 ;; esac
  # Temporal allows one batch job to start per namespace at a time, and the slot frees a moment after
  # the previous job closes, so batch starts are paced.
  case "$path" in */batch-operations/*) [ "$method" = POST ] && sleep 3 ;; esac
  CODE="$(curl -sS -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X "$method" \
    ${hdr[@]+"${hdr[@]}"} ${data[@]+"${data[@]}"} "$BASE$path")"
}

# Expected is an exact status, or several separated by "|".
matches() {
  local IFS='|' e
  for e in $1; do
    [ "$e" = "$2" ] && return 0
  done
  return 1
}

# Error bodies with a JSON content type must be google.rpc.Status: numeric code and details array.
check_error_shape() {
  local label="$1"
  if [ "$CODE" -ge 400 ] && grep -qi '^content-type: application/json' "$TMP/headers"; then
    if ! jq -e '(.code | type == "number") and (.details | type == "array")' "$TMP/body" >/dev/null 2>&1; then
      fail "$label: error body is not google.rpc.Status: $(head -c 200 "$TMP/body")"
    fi
  fi
}

# Streams: five concurrent long-polls for one user. At least one must be 429 (cap is 4).
# A long-poll the server ends early never overlaps the others, so an attempt that finishes in under 5 s
# proves nothing and is retried. Only an attempt that held its streams for the full window and saw no 429 fails.
check_stream_cap() {
  local user="$1" path="$2" label="$3" i attempt start elapsed
  for attempt in 1 2 3; do
    : > "$TMP/caps"
    start=$(date +%s)
    for i in 1 2 3 4 5; do
      curl -s -o /dev/null -w '%{http_code}\n' --max-time 6 \
        -H "Cookie: $COOKIE_NAME=$(cookie_value "$user")" -H "X-Tempolens: 1" \
        "$BASE$path" >> "$TMP/caps" &
    done
    wait
    elapsed=$(( $(date +%s) - start ))
    if grep -q '^429$' "$TMP/caps"; then
      echo "ok   $label $user stream cap: $(tr '\n' ' ' < "$TMP/caps") (attempt $attempt)"
      return 0
    fi
    [ "$elapsed" -lt 5 ] || break
    sleep 3
  done
  fail "$label $user: no 429 among 5 concurrent streams: $(tr '\n' ' ' < "$TMP/caps") (last attempt ${elapsed}s)"
}

# Env-limited update (A03). The writer's request must reach Temporal and be refused by the server's
# namespace config, which shows as Temporal's message and a "write" audit line. The reader must get
# Tempolens' own 403 before Temporal, which shows as "permission denied" and a "deny" audit line.
# Both get code 7, so the message and the audit event tell them apart. SERVER_LOG is the server's
# stdout log (JSON lines). Without it the audit part is skipped and reported.
check_env_update() {
  local user="$1" method="$2" path="$3" body="$4" label="$5" email msg want_event event
  email="$user@example.test"
  send "$method" "$path" "$body" default "$user"
  msg="$(jq -r '.message // ""' "$TMP/body" 2>/dev/null || echo "")"
  if [ "$CODE" != "403" ] || [ "$(jq -r '.code // 0' "$TMP/body" 2>/dev/null)" != "7" ]; then
    fail "$label $user: expected 403 code 7, got $CODE: $(head -c 200 "$TMP/body")"
    return
  fi
  case "$user" in
    reader|nogroups|padded) want_event=deny ;;
    *) want_event=write ;;
  esac
  if [ "$want_event" = write ]; then
    if [[ "$msg" != *"disabled on this namespace"* ]]; then
      fail "$label $user: 403 is not Temporal's message: $msg"
      return
    fi
  elif [[ "$msg" != "permission denied"* ]]; then
    fail "$label $user: 403 is not a Tempolens denial: $msg"
    return
  fi
  if [ -n "${SERVER_LOG:-}" ] && [ -f "$SERVER_LOG" ]; then
    event="$(jq -r --arg u "$email" --arg m "$method" \
      'select(.msg == "audit" and .user == $u and .method == "UpdateWorkflowExecution") | .event' \
      "$SERVER_LOG" 2>/dev/null | tail -1)"
    if [ "$event" != "$want_event" ]; then
      fail "$label $user: last audit event '$event', want '$want_event'"
      return
    fi
    echo "ok   $label $user env-update 403 code 7 ($msg), audit=$event"
  else
    echo "ok   $label $user env-update 403 code 7 ($msg), audit not checked (SERVER_LOG unset)"
  fi
}

# Burst: 15 rapid calls for one user. At least one 429 must carry Retry-After.
check_rate_burst() {
  local user="$1" path="$2" label="$3" i seen=0
  for i in $(seq 1 15); do
    CODE="$(curl -s -o /dev/null -D "$TMP/rh" -w '%{http_code}' \
      -H "Cookie: $COOKIE_NAME=$(cookie_value "$user")" -H "X-Tempolens: 1" "$BASE$path")"
    if [ "$CODE" = "429" ] && grep -qi '^retry-after:' "$TMP/rh"; then
      seen=1
      break
    fi
  done
  if [ "$seen" = "1" ]; then
    echo "ok   $label $user rate burst: 429 with Retry-After after $i calls"
  else
    fail "$label $user: no 429 with Retry-After in 15 rapid calls"
  fi
}

# State the reader pass must not change: target workflows, the temporary schedule and the Nexus list.
snapshot() {
  local file="$1" i code st
  : > "$file"
  for i in $(seq 1 13); do
    code="$(curl -s -o "$TMP/snap" -w '%{http_code}' -H "Cookie: $COOKIE_NAME=$(cookie_value reader)" \
      -H "X-Tempolens: 1" "$BASE/api/v1/namespaces/$NS/workflows/tempolens-e2e-disposable-$i")"
    st="$(jq -r '.workflowExecutionInfo.status // "-"' "$TMP/snap" 2>/dev/null || echo "-")"
    echo "disposable-$i $code $st" >> "$file"
  done
  code="$(curl -s -o "$TMP/snap" -w '%{http_code}' -H "Cookie: $COOKIE_NAME=$(cookie_value reader)" \
    -H "X-Tempolens: 1" "$BASE/api/v1/namespaces/$NS/schedules/tempolens-seed-sched-active")"
  echo "schedule-active $code" >> "$file"
  code="$(curl -s -o "$TMP/snap" -w '%{http_code}' -H "Cookie: $COOKIE_NAME=$(cookie_value reader)" \
    -H "X-Tempolens: 1" "$BASE/api/v1/nexus/endpoints")"
  echo "nexus-list $code $(jq -r '.endpoints | length' "$TMP/snap" 2>/dev/null || echo -)" >> "$file"
}

# Namespace list and search attributes of the seed namespaces, read as reader. Compared before and
# after the reader and writer passes: neither role may create, update or delete a namespace or add
# or remove a search attribute.
snapshot_admin_state() {
  local file="$1" ns code
  : > "$file"
  code="$(curl -s -o "$TMP/snap" -w '%{http_code}' -H "Cookie: $COOKIE_NAME=$(cookie_value reader)" \
    -H "X-Tempolens: 1" "$BASE/api/v1/namespaces")"
  echo "namespaces $code" >> "$file"
  jq -r '.namespaces[]?.namespaceInfo | "\(.name) \(.state)"' "$TMP/snap" 2>/dev/null | sort >> "$file"
  for ns in tui-seed-a tui-seed-b; do
    code="$(curl -s -o "$TMP/snap" -w '%{http_code}' -H "Cookie: $COOKIE_NAME=$(cookie_value reader)" \
      -H "X-Tempolens: 1" "$BASE/api/v1/namespaces/$ns/search-attributes")"
    echo "search-attributes $ns $code" >> "$file"
    jq -r '((.customAttributes // {}) | keys[]), ((.systemAttributes // {}) | keys[] | "system:" + .)' \
      "$TMP/snap" 2>/dev/null | sort >> "$file"
  done
}

# The writer and admin passes change disposables, so each starts from a fresh set of 13.
reset_disposables() {
  (cd "$HERE/../seed" && GOTOOLCHAIN=auto go run . reset-disposables --run-id "$RUN_ID" --count 13 >/dev/null)
}

run_pass() {
  local user="$1" id method path body variant reader writer admin nogroups padded note expected
  while IFS=$'\t' read -r id method path body variant reader writer admin nogroups padded note; do
    [ "$id" = "id" ] && continue
    case "$user" in
      reader) expected="$reader" ;;
      writer) expected="$writer" ;;
      admin) expected="$admin" ;;
      nogroups) expected="$nogroups" ;;
      padded) expected="$padded" ;;
    esac
    path="${path//\$\{RUN_ID\}/$TAG}"
    path="${path//\$\{PARENT_RUN_ID\}/$PARENT_RUN_ID}"
    path="${path//\$\{WHO\}/$user}"
    body="${body//\$\{RUN_ID\}/$TAG}"
    body="${body//\$\{WHO\}/$user}"
    variant="${variant//\$\{RUN_ID\}/$TAG}"
    variant="${variant//\$\{WHO\}/$user}"
    TOTAL=$((TOTAL + 1))
    # PENDING_IDS is an extended regex of row IDs whose feature is not built yet (for example /api/x before phase 5).
    if [ -n "${PENDING_IDS:-}" ] && [[ "$id" =~ $PENDING_IDS ]]; then
      PENDING=$((PENDING + 1))
      echo "pend $id $user $method $variant (feature not built yet)"
      continue
    fi
    if [ "$variant" = "env-update" ]; then
      check_env_update "$user" "$method" "$path" "$body" "$id"
      continue
    fi
    if [ "$variant" = "stream-cap" ]; then
      check_stream_cap "$user" "$path" "$id"
      continue
    fi
    if [ "$variant" = "rate-burst" ]; then
      check_rate_burst "$user" "$path" "$id"
      continue
    fi
    send "$method" "$path" "$body" "$variant" "$user"
    if matches "$expected" "$CODE"; then
      echo "ok   $id $user $method $variant $CODE"
    else
      fail "$id $user $method $path [$variant]: expected $expected, got $CODE: $(head -c 200 "$TMP/body")"
    fi
    # list-no-system: the namespace list must leave temporal-system out (contract v4).
    if [ "$variant" = "list-no-system" ] && [ "$CODE" = "200" ] && grep -q 'temporal-system' "$TMP/body"; then
      fail "$id $user: namespace list contains temporal-system"
    fi
    check_error_shape "$id $user"
    if [ "$path" = "/api/x/me" ] && [ "$CODE" = "200" ]; then
      case "$user" in
        writer) want_role=write ;;
        admin) want_role=admin ;;
        *) want_role=read ;;
      esac
      got_role="$(jq -r '.role' "$TMP/body")"
      [ "$got_role" = "$want_role" ] || fail "$id $user: role $got_role, want $want_role"
    fi
  done < "$ROUTES"
}

# Compares two snapshot files and records one ok or fail line.
expect_same() {
  local before="$1" after="$2" label="$3"
  if diff -u "$before" "$after"; then
    echo "ok   $label"
  else
    fail "$label (see diff above)"
  fi
}

# B01 stops the batch that A09 starts, so that batch must still be running when the stop arrives. A09 cancels one
# workflow per second over its query. Each pass starts its own set of STOP_SET running SeedWaiting workflows, under a
# tag this run uses only, so the batch cannot drain before B01 runs. The sets are terminated at the end of the run.
STOP_SET=20
stop_set_id() { echo "tui-test-authz-stop-$1-${TAG}-$2"; }
stop_set_seed() { echo "stop-$1-${TAG}"; }

start_stop_set() {
  local user="$1" i id code value body
  value="$(printf '"%s"' "$(stop_set_seed "$user")" | base64 | tr -d '\n')"
  for i in $(seq 1 "$STOP_SET"); do
    id="$(stop_set_id "$user" "$i")"
    body="{\"workflowType\":{\"name\":\"SeedWaiting\"},\"taskQueue\":{\"name\":\"tempolens-seed\"},\"searchAttributes\":{\"indexedFields\":{\"SeedRun\":{\"metadata\":{\"encoding\":\"anNvbi9wbGFpbg==\"},\"data\":\"$value\"}}}}"
    code="$(curl -s -o "$TMP/setup" -w '%{http_code}' -X POST -H "Cookie: $COOKIE_NAME=$(cookie_value admin)" \
      -H "X-Tempolens: 1" -H "Origin: $BASE" -H "Content-Type: application/json" -d "$body" \
      "$BASE/api/v1/namespaces/$NS/workflows/$id")"
    if [ "$code" != "200" ]; then
      echo "FAIL setup: start $id returned $code: $(head -c 200 "$TMP/setup")"
      exit 1
    fi
    sleep 0.25
  done
}

cleanup_stop_set() {
  local user="$1" i id code
  for i in $(seq 1 "$STOP_SET"); do
    id="$(stop_set_id "$user" "$i")"
    # 404 means the batch already cancelled the workflow. Any other code is a cleanup failure.
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $COOKIE_NAME=$(cookie_value admin)" \
      -H "X-Tempolens: 1" -H "Origin: $BASE" -H "X-Tempolens-Confirm: $id" -H "Content-Type: application/json" \
      -d '{"reason":"authz-stop-cleanup"}' "$BASE/api/v1/namespaces/$NS/workflows/$id/terminate")"
    case "$code" in
      200|404) ;;
      *) fail "cleanup $id: terminate returned $code" ;;
    esac
    sleep 0.25
  done
}

echo "== snapshot before reader pass"
snapshot "$TMP/before"
snapshot_admin_state "$TMP/admin-before-reader"
echo "== reader pass"
run_pass reader
echo "== snapshot after reader pass"
snapshot "$TMP/after"
snapshot_admin_state "$TMP/admin-after-reader"
expect_same "$TMP/before" "$TMP/after" "reader pass changed no target state"
expect_same "$TMP/admin-before-reader" "$TMP/admin-after-reader" "reader pass changed no namespace or search attribute"
echo "== stop sets for the batch rows (writer and admin)"
start_stop_set writer
start_stop_set admin
echo "== writer pass (fresh disposables)"
reset_disposables
snapshot_admin_state "$TMP/admin-before-writer"
run_pass writer
snapshot_admin_state "$TMP/admin-after-writer"
expect_same "$TMP/admin-before-writer" "$TMP/admin-after-writer" "writer pass changed no namespace or search attribute"
echo "== admin pass (fresh disposables)"
reset_disposables
run_pass admin
echo "== nogroups pass"
run_pass nogroups
echo "== padded pass"
run_pass padded

# Logout with a foreign Origin must not end the writer session (F04).
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE_NAME=$(cookie_value writer)" \
  -H "X-Tempolens: 1" "$BASE/api/x/me")"
if [ "$CODE" = "200" ]; then
  echo "ok   F04 writer session still valid after rejected logout"
else
  fail "F04 writer session invalid after rejected logout: $CODE"
fi

echo "== cleanup of the stop sets"
cleanup_stop_set writer
cleanup_stop_set admin
echo "== row-user checks: $TOTAL, pending: $PENDING, failures: $FAILS"
[ "$FAILS" -eq 0 ]
