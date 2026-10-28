#!/usr/bin/env bash
# LOCAL TEST ONLY. Functional spot check of /api/x as a read user (contract v3).
# Covers the cross-namespace list and its paging, the counts, the stuck finder, event search,
# the graph for a mid-tree child and for a reset base run, and the history export.
#
# Usage:
#   BASE=http://localhost:8236 PARENT_RUN_ID=<seed-parent-1 run> FAILED_RUN_ID=<seed failed set run, e.g. t2> \
#     ./api-x-spot.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-http://localhost:8236}"
PARENT_RUN_ID="${PARENT_RUN_ID:?PARENT_RUN_ID is required}"
FAILED_RUN_ID="${FAILED_RUN_ID:?FAILED_RUN_ID is required}"
NS="tui-seed-a"
COOKIE="__Host-tempolens_session=$(cat "$HERE/out/reader.cookie")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0

fail() {
  FAILS=$((FAILS + 1))
  echo "FAIL $*"
}

ok() {
  echo "ok   $*"
}

# /api/x is rate limited per principal, so pace the calls below 5/s.
xget() {
  sleep 0.3
  curl -sS -o "$TMP/out" -D "$TMP/hdr" -w '%{http_code}' -H "Cookie: $COOKIE" -H "X-Tempolens: 1" "$BASE$1"
}

# Plain API reads (not /api/x), used to look up IDs. No pacing needed.
vget() {
  curl -sS -o "$TMP/v1" -w '%{http_code}' -H "Cookie: $COOKIE" -H "X-Tempolens: 1" "$BASE$1"
}

# 1. Cross-namespace list with paging: walk every page and check for duplicates.
echo "== 1. list namespaces=* paging"
: > "$TMP/rows"
token=""
pages=0
while :; do
  q="/api/x/workflows?namespaces=*&pageSize=100"
  [ -n "$token" ] && q="$q&pageToken=$(printf '%s' "$token" | jq -sRr @uri)"
  code="$(xget "$q")"
  if [ "$code" != "200" ]; then
    fail "list page $((pages + 1)): $code $(head -c 200 "$TMP/out")"
    break
  fi
  pages=$((pages + 1))
  jq -r '.executions[] | "\(.namespace)|\(.execution.execution.workflowId)|\(.execution.execution.runId)"' "$TMP/out" >> "$TMP/rows"
  token="$(jq -r '.nextPageToken' "$TMP/out")"
  [ -z "$token" ] && break
  if [ "$pages" -ge 20 ]; then
    fail "list: more than 20 pages, stopping"
    break
  fi
done
total_rows="$(wc -l < "$TMP/rows" | tr -d ' ')"
distinct_rows="$(sort -u "$TMP/rows" | wc -l | tr -d ' ')"
if [ "$total_rows" -gt 100 ] && [ "$pages" -ge 2 ]; then
  ok "list: $pages pages, $total_rows rows"
else
  fail "list: expected more than one page, got $pages pages and $total_rows rows"
fi
if [ "$total_rows" = "$distinct_rows" ]; then
  ok "list: no duplicates across pages"
else
  fail "list: $((total_rows - distinct_rows)) duplicate row(s) across pages"
fi
LIST_TOTAL="$total_rows"

# 2. Counts sum up. The totals come from the count endpoint, so they must match the list total.
echo "== 2. counts"
code="$(xget "/api/x/workflows/count?namespaces=*")"
if [ "$code" != "200" ]; then
  fail "counts: $code $(head -c 200 "$TMP/out")"
else
  total="$(jq -r '.total' "$TMP/out")"
  by_status="$(jq -r '[.byStatus[]] | add // 0' "$TMP/out")"
  per_ns="$(jq -r '[.perNamespace[].total] | add // 0' "$TMP/out")"
  if [ "$total" = "$by_status" ] && [ "$total" = "$per_ns" ]; then
    ok "counts: total $total = sum(byStatus) = sum(perNamespace)"
  else
    fail "counts: total $total, sum(byStatus) $by_status, sum(perNamespace) $per_ns"
  fi
  if [ "$total" = "$LIST_TOTAL" ]; then
    ok "counts: total matches the list total ($LIST_TOTAL)"
  else
    fail "counts: total $total differs from the list total $LIST_TOTAL"
  fi
fi

# 3. Stuck finder: pending activities with attempt >= 3 must find seed-stuck-1.
echo "== 3. stuck finder"
code="$(xget "/api/x/search/activity?namespaces=$NS&activityType=AlwaysFail&mode=pending&minAttempt=3&max=50")"
if [ "$code" != "200" ]; then
  fail "stuck: $code $(head -c 200 "$TMP/out")"
else
  if jq -e '.matches[] | select(.workflowId == "seed-stuck-1" and .namespace == "tui-seed-a")' "$TMP/out" >/dev/null; then
    attempt="$(jq -r '[.matches[] | select(.workflowId == "seed-stuck-1") | .hits[].attempt] | max' "$TMP/out")"
    ok "stuck: seed-stuck-1 found, attempt $attempt"
  else
    fail "stuck: seed-stuck-1 not in matches: $(head -c 300 "$TMP/out")"
  fi
fi

# 4. Event search: the failed runs of the failed set must match by failure text and by event type.
echo "== 4. event search for the failed runs"
# The unnarrowed scan only examines the first 100 candidates, so it must say so instead of missing silently.
code="$(xget "/api/x/search/event?namespaces=$NS&failureText=intentional%20activity%20failure&max=100")"
if [ "$code" = "200" ] && jq -e '.partial == true and (.partialReasons | index("cap") != null)' "$TMP/out" >/dev/null; then
  ok "event: unnarrowed scan reports partial with reason cap"
else
  fail "event: unnarrowed scan did not report partial cap: $code $(head -c 200 "$TMP/out")"
fi
# Narrowed by workflow type, the three failed runs are inside the candidate window.
q="$(printf '%s' "WorkflowType = 'SeedFailing'" | jq -sRr @uri)"
code="$(xget "/api/x/search/event?namespaces=$NS&query=$q&failureText=intentional%20activity%20failure&max=100")"
if [ "$code" != "200" ]; then
  fail "event by failure text: $code $(head -c 200 "$TMP/out")"
else
  for i in 1 2 3; do
    if jq -e --arg w "seed-failed-$FAILED_RUN_ID-$i" '.matches[] | select(.workflowId == $w)' "$TMP/out" >/dev/null; then
      ok "event: $FAILED_RUN_ID-$i matched by failure text"
    else
      fail "event: seed-failed-$FAILED_RUN_ID-$i not matched by failure text"
    fi
  done
fi
code="$(xget "/api/x/search/event?namespaces=$NS&query=$q&eventType=EVENT_TYPE_ACTIVITY_TASK_FAILED&max=100")"
if [ "$code" = "200" ] && jq -e --arg w "seed-failed-$FAILED_RUN_ID-1" '.matches[] | select(.workflowId == $w)' "$TMP/out" >/dev/null; then
  ok "event: seed-failed-$FAILED_RUN_ID-1 matched by event type"
else
  fail "event by event type: $code, failed run not found"
fi

# 5. Graph for a mid-tree child. The child's child (grandchild) must be in the walk, and the child
#    must hang off the parent with a child edge.
echo "== 5. graph for a mid-tree child"
CHILD_ID="${PARENT_RUN_ID}_5"
vcode="$(vget "/api/v1/namespaces/$NS/workflows?query=$(printf '%s' "WorkflowId = '$CHILD_ID'" | jq -sRr @uri)&pageSize=5")"
CHILD_RUN="$(jq -r '.executions[0].execution.runId // empty' "$TMP/v1")"
if [ "$vcode" != "200" ] || [ -z "$CHILD_RUN" ]; then
  fail "graph child: could not find $CHILD_ID ($vcode)"
else
  code="$(xget "/api/x/graph?namespace=$NS&workflowId=$CHILD_ID&runId=$CHILD_RUN&depth=2")"
  if [ "$code" != "200" ]; then
    fail "graph child: $code $(head -c 200 "$TMP/out")"
  else
    cp "$TMP/out" "$TMP/graph-child.json"
    if jq -e --arg w "$CHILD_ID" '.nodes[] | select(.focus == true and .workflowId == $w)' "$TMP/out" >/dev/null; then
      ok "graph child: focus node is $CHILD_ID"
    else
      fail "graph child: no focus node for $CHILD_ID"
    fi
    if jq -e --arg w "seed-parent-1" '.nodes[] | select(.root == true and .workflowId == $w)' "$TMP/out" >/dev/null; then
      ok "graph child: seed-parent-1 is the root"
    else
      fail "graph child: seed-parent-1 is not marked root"
    fi
    if jq -e '.edges[] | select(.kind == "child")' "$TMP/out" >/dev/null; then
      ok "graph child: child edge present"
    else
      fail "graph child: no child edge"
    fi
    # The grandchild hangs off the focus node by a child edge.
    if jq -e '(.nodes[] | select(.focus == true) | .id) as $f | .edges[] | select(.from == $f and .kind == "child")' "$TMP/out" >/dev/null; then
      ok "graph child: grandchild edge from the focus node"
    else
      fail "graph child: no child edge from the focus node to a grandchild"
    fi
  fi
fi

# 6. Graph for the reset base run of seed-reset-1: the older run, with a reset edge to the new run.
echo "== 6. graph for the reset base run"
vcode="$(vget "/api/v1/namespaces/$NS/workflows?query=$(printf '%s' "WorkflowId = 'seed-reset-1'" | jq -sRr @uri)&pageSize=10")"
BASE_RUN="$(jq -r '[.executions[]] | sort_by(.startTime) | .[0].execution.runId // empty' "$TMP/v1")"
if [ "$vcode" != "200" ] || [ -z "$BASE_RUN" ]; then
  fail "graph reset: could not find the seed-reset-1 base run ($vcode)"
else
  code="$(xget "/api/x/graph?namespace=$NS&workflowId=seed-reset-1&runId=$BASE_RUN&depth=2")"
  if [ "$code" != "200" ]; then
    fail "graph reset: $code $(head -c 200 "$TMP/out")"
  else
    if jq -e '.edges[] | select(.kind == "reset")' "$TMP/out" >/dev/null; then
      ok "graph reset: reset edge from base run $BASE_RUN"
    else
      fail "graph reset: no reset edge from base run $BASE_RUN"
    fi
  fi
fi

# 7. History export: a JSON array, oldest first, with the attachment header.
echo "== 7. history export"
code="$(xget "/api/x/history-export?namespace=$NS&workflowId=seed-parent-1&runId=$PARENT_RUN_ID")"
if [ "$code" != "200" ]; then
  fail "export: $code $(head -c 200 "$TMP/out")"
else
  if grep -qi '^content-disposition: attachment' "$TMP/hdr"; then
    ok "export: attachment header present"
  else
    fail "export: no attachment Content-Disposition"
  fi
  if jq -e 'type == "array" and length > 0 and .[0].eventId == "1"' "$TMP/out" >/dev/null; then
    ids_ok="$(jq -r '[.[].eventId | tonumber] | . as $a | [range(1; length) | $a[.] > $a[. - 1]] | all' "$TMP/out")"
    if [ "$ids_ok" = "true" ]; then
      ok "export: $(jq 'length' "$TMP/out") events, oldest first"
    else
      fail "export: event IDs are not increasing"
    fi
  else
    fail "export: body is not a non-empty history array starting at eventId 1"
  fi
fi

echo "== spot check: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
