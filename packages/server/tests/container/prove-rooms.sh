#!/usr/bin/env bash
# Rooms against a real Hermes (DECISIONS §69): one throwaway container of the hub image, the
# scripted upstream (`fake-provider.mjs --script rooms`) as its model, and a room with two
# Hermes seats. A person mentions the planner; Hermes answers through its real TUI gateway,
# the reply mentions the coder, the room hands it the turn, the coder answers; then the room's
# summary is asked of Hermes.
#
#   docker build -f packages/server/Dockerfile -t core-hub:rooms .
#   packages/server/tests/container/prove-rooms.sh core-hub:rooms
#
# Nothing here touches the owner's machines: one container, loopback ports of its own.
set -euo pipefail

IMAGE="${1:-core-hub:rooms}"
NAME="corehub-rooms-prove-$$"
ENDPOINT_PORT="${ENDPOINT_PORT:-19199}"
HUB_PORT="${HUB_PORT:-18190}"
KEY='sk-lab-rooms-key'
ADMIN_PASSWORD='prove-rooms-0000'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
REQUESTS="$WORK/requests.txt"
: >"$REQUESTS"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n "${ENDPOINT_PID:-}" ]] && kill "$ENDPOINT_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }
hub() { # hub <method> <path> [json]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "http://127.0.0.1:$HUB_PORT/api/v1$path" -H "authorization: Bearer $TOKEN" \
      -H 'x-hub-profile: default' -H 'content-type: application/json' -H 'accept-language: ar' -d "$body"
  else
    curl -sS -X "$method" "http://127.0.0.1:$HUB_PORT/api/v1$path" -H "authorization: Bearer $TOKEN" \
      -H 'x-hub-profile: default'
  fi
}

node "$HERE/fake-provider.mjs" --port "$ENDPOINT_PORT" --key "$KEY" --log "$REQUESTS" --script rooms \
  >"$WORK/endpoint.log" 2>&1 &
ENDPOINT_PID=$!
sleep 1

docker run -d --name "$NAME" -p "127.0.0.1:$HUB_PORT:8080" \
  -e DATA_DIR=/data -e PORT=8080 -e HUB_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --add-host 'host.docker.internal:host-gateway' "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$HUB_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
TOKEN="$(curl -sS -X POST "http://127.0.0.1:$HUB_PORT/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | json 'j.access_token')"

echo '=== the model: the scripted upstream ==='
PROVIDER_ID="$(hub POST /models/providers \
  "{\"label\":\"Lab\",\"kind\":\"llm\",\"base_url\":\"http://host.docker.internal:$ENDPOINT_PORT/v1\",\"api_key\":\"$KEY\",\"api_mode\":\"chat_completions\"}" |
  json 'j.id')"
hub POST "/models/providers/$PROVIDER_ID/refresh" '{}' >/dev/null
sleep 3
echo -n 'waiting for the gateway to answer: '
for _ in $(seq 1 90); do
  if docker exec "$NAME" node -e 'fetch("http://127.0.0.1:8642/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
    echo up
    break
  fi
  sleep 2
done
AGENT_ID="$(hub GET /agents | json 'j.items.find(a=>a.kind==="hermes"||a.slug==="hermes").id')"
echo "hermes=$AGENT_ID"

echo '=== a room with two Hermes seats ==='
ROOM="$(hub POST /rooms "{\"name\":\"غرفة Hermes\",\"seats\":[{\"agent_id\":\"$AGENT_ID\",\"name\":\"المخطِّط\",\"description\":\"يضع الخطة\"},{\"agent_id\":\"$AGENT_ID\",\"name\":\"المبرمج\",\"description\":\"ينفّذ\"}]}")"
echo "$ROOM" | json 'JSON.stringify(j.seat_results)'
ROOM_ID="$(echo "$ROOM" | json 'j.room.id')"
PLANNER="$(echo "$ROOM" | json 'j.room.seats[0].id')"

echo '=== a person mentions the planner ==='
hub POST "/rooms/$ROOM_ID/messages" \
  "{\"content\":[{\"type\":\"text\",\"text\":\"@المخطِّط ضع خطة للصفحة الرئيسية\"}],\"mentions\":[{\"kind\":\"seat\",\"seat_id\":\"$PLANNER\"}]}"
echo
for _ in $(seq 1 90); do
  DONE="$(hub GET "/rooms/$ROOM_ID/messages" | json 'j.items.filter(m=>m.role==="assistant"&&m.status!=="streaming").length')"
  [[ "$DONE" -ge 2 ]] && break
  sleep 2
done
echo '-- the transcript --'
hub GET "/rooms/$ROOM_ID/messages" |
  json 'j.items.map(m=>`${m.seq} ${m.role} ${m.author.name} [${m.status}] ${m.content.map(c=>c.text).join("")}${m.handoff?"  → handoff depth "+m.handoff.depth:""}`).join("\n")'
echo '-- the handoff chains --'
hub GET "/rooms/$ROOM_ID/handoffs" | json 'JSON.stringify(j.items.map(c=>({status:c.status,depth:c.depth,stop_reason:c.stop_reason})))'
echo '-- the runs --'
hub GET "/rooms/$ROOM_ID/runs" | json 'j.items.map(r=>`${r.status} seat=${r.seat_id} room=${r.room_id} error=${r.error?.code??""}`).join("\n")'

echo '=== the summary, asked of Hermes ==='
hub POST "/rooms/$ROOM_ID/memory/refresh" '{}'
echo
for _ in $(seq 1 45); do
  STATUS="$(hub GET "/rooms/$ROOM_ID/memory" | json 'j.status')"
  [[ "$STATUS" != 'summarizing' ]] && break
  sleep 2
done
hub GET "/rooms/$ROOM_ID/memory"
echo

echo '=== WHAT THE ENDPOINT WAS ASKED ==='
grep 'asked=' "$REQUESTS" | cut -c1-200
