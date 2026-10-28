#!/usr/bin/env bash
# LOCAL TEST ONLY. Image size and idle memory for Tempolens and upstream temporalio/ui 2.53.0.
# Starts two fresh containers on the same local Temporal, measures them, then runs measure.mjs for
# the first-load weight and writes out/metrics.json. Run it on its own, never alongside another run.
#
# Containers: tempolens-measure-new (127.0.0.1:8238, auth disabled) and tempolens-measure-upstream
# (127.0.0.1:8235). An upstream UI already running on 8233 is never touched.
#
# Env: NEW_IMAGE (default tempolens:local), UP_IMAGE (default temporalio/ui:2.53.0),
#      TEMPORAL_ADDRESS (default host.docker.internal:7233), IDLE_SECS (default 60).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
NEW_IMAGE="${NEW_IMAGE:-tempolens:local}"
UP_IMAGE="${UP_IMAGE:-temporalio/ui:2.53.0}"
TEMPORAL="${TEMPORAL_ADDRESS:-host.docker.internal:7233}"
IDLE_SECS="${IDLE_SECS:-60}"
NEW_NAME=tempolens-measure-new
UP_NAME=tempolens-measure-upstream
NEW_PORT=8238
UP_PORT=8235

mkdir -p "$OUT"

cleanup() {
  docker rm -f "$NEW_NAME" "$UP_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for port in "$NEW_PORT" "$UP_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is busy; find its owner with lsof before measuring" >&2
    exit 1
  fi
done

cleanup

NEW_BYTES="$(docker image inspect -f '{{.Size}}' "$NEW_IMAGE")"
UP_BYTES="$(docker image inspect -f '{{.Size}}' "$UP_IMAGE")"

docker run -d --name "$NEW_NAME" -p "127.0.0.1:$NEW_PORT:8080" \
  --add-host host.docker.internal:host-gateway \
  -e TEMPORAL_ADDRESS="$TEMPORAL" \
  -e TEMPOLENS_AUTH_DISABLED=true \
  -e TEMPOLENS_LISTEN_ADDR=0.0.0.0 \
  -e TEMPOLENS_PUBLIC_ORIGIN="http://localhost:$NEW_PORT" \
  "$NEW_IMAGE" >/dev/null
docker run -d --name "$UP_NAME" -p "127.0.0.1:$UP_PORT:8080" \
  --add-host host.docker.internal:host-gateway \
  -e TEMPORAL_ADDRESS="$TEMPORAL" \
  -e TEMPORAL_CLOUD_UI=false \
  "$UP_IMAGE" >/dev/null

for url in "http://127.0.0.1:$NEW_PORT/healthz" "http://127.0.0.1:$UP_PORT/api/v1/settings"; do
  ready=0
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$url"; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    echo "not ready: $url" >&2
    exit 1
  fi
done

stats() {
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' "$NEW_NAME" "$UP_NAME"
}

echo "== idle, cold (no traffic for $IDLE_SECS s)"
sleep "$IDLE_SECS"
COLD_STATS="$(stats)"
echo "$COLD_STATS"

# The first-load measurement loads the workflow list and the history page once in each UI.
jq -n \
  --arg newImage "$NEW_IMAGE" --argjson newBytes "$NEW_BYTES" \
  --arg upImage "$UP_IMAGE" --argjson upBytes "$UP_BYTES" \
  --arg cold "$COLD_STATS" \
  '{
    images: {
      tempolens: {image: $newImage, bytes: $newBytes},
      upstream: {image: $upImage, bytes: $upBytes}
    },
    idleMemoryCold: $cold
  }' > "$OUT/metrics-runtime.json"

(cd "$HERE" && node measure.mjs)

echo "== idle, after one load ($IDLE_SECS s)"
sleep "$IDLE_SECS"
AFTER_STATS="$(stats)"
echo "$AFTER_STATS"

jq --arg after "$AFTER_STATS" '.idleMemoryAfterLoad = $after' "$OUT/metrics.json" > "$OUT/metrics.tmp" \
  && mv "$OUT/metrics.tmp" "$OUT/metrics.json"
rm -f "$OUT/metrics-runtime.json"
echo "wrote $OUT/metrics.json"
