#!/usr/bin/env bash
# Proves, against a real container and a real upstream, the two claims a unit test cannot make:
#
#   1. a key is checked against its provider when it is saved, and a key the provider refuses
#      is refused in the provider's own words and never written into Hermes's configuration;
#   3. a provider Hermes has no slug of its own for (a plain OpenAI-compatible endpoint) does
#      reach Hermes, is what the run uses, and carries the model id through byte for byte.
#
# The upstream is `fake-provider.mjs` on the host: it inspects the Authorization header and
# logs every request, so "the key reached the provider" is shown, not asserted.
#
#   docker build -f packages/server/Dockerfile -t core-hub:prop-fix .
#   packages/server/tests/container/prove.sh corehub:prop-fix
#
# Nothing here touches the owner's machines: one throwaway container, one loopback port.
set -euo pipefail

IMAGE="${1:-corehub:prop-fix}"
NAME="corehub-prove-$$"
ENDPOINT_PORT="${ENDPOINT_PORT:-19099}"
HUB_PORT="${HUB_PORT:-18080}"
GOOD_KEY='sk-lab-correct-key'
BAD_KEY='sk-WRONG-KEY'
ADMIN_PASSWORD='prove-me-0000'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
REQUESTS="$WORK/requests.txt"
: >"$REQUESTS"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n "${ENDPOINT_PID:-}" ]] && kill "$ENDPOINT_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hub() { # hub <method> <path> [json]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "http://127.0.0.1:$HUB_PORT/api/v1$path" \
      -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body"
  else
    curl -sS -X "$method" "http://127.0.0.1:$HUB_PORT/api/v1$path" -H "authorization: Bearer $TOKEN"
  fi
}

# Polls a run to a terminal state instead of guessing at a sleep.
await_run() { # await_run <session> <run>
  for _ in $(seq 1 60); do
    local state
    state="$(hub GET "/sessions/$1/runs/$2" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')"
    case "$state" in succeeded | failed | cancelled | interrupted) return 0 ;; esac
    sleep 2
  done
}

node "$HERE/fake-provider.mjs" --port "$ENDPOINT_PORT" --key "$GOOD_KEY" --log "$REQUESTS" \
  >"$WORK/endpoint.log" 2>&1 &
ENDPOINT_PID=$!
sleep 1

docker run -d --name "$NAME" \
  -p "$HUB_PORT:8080" \
  -e DATA_DIR=/data -e PORT=8080 -e HUB_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --add-host 'host.docker.internal:host-gateway' \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$HUB_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 1
done

TOKEN="$(curl -sS -X POST "http://127.0.0.1:$HUB_PORT/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))')"

BASE_URL="http://host.docker.internal:$ENDPOINT_PORT/v1"

echo '=== CASE B — a key the provider refuses is refused on save, in its own words ==='
hub POST /models/providers \
  "{\"label\":\"Lab\",\"kind\":\"llm\",\"base_url\":\"$BASE_URL\",\"api_key\":\"$BAD_KEY\",\"api_mode\":\"chat_completions\"}"
echo
echo '-- providers after the refusal (must be empty) --'
hub GET /models/providers
echo

echo '=== CASE A — a key it accepts: added, models loaded, default set ==='
PROVIDER="$(hub POST /models/providers \
  "{\"label\":\"Lab\",\"kind\":\"llm\",\"base_url\":\"$BASE_URL\",\"api_key\":\"$GOOD_KEY\",\"api_mode\":\"chat_completions\"}")"
echo "$PROVIDER"
PROVIDER_ID="$(printf '%s' "$PROVIDER" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
hub POST "/models/providers/$PROVIDER_ID/refresh" '{}' >/dev/null
sleep 3
echo '-- catalogue --'
hub GET /models
echo
echo '-- defaults (set automatically, nobody opened the Defaults tab) --'
hub GET /models/defaults
echo
echo '-- the self-check --'
hub GET /models/runtime
echo

# A provider change recycles the gateway (ADR 0010 §3), and the gateway is a Python process
# that takes seconds to answer again. A run posted into that window fails `agent_unavailable`
# by design — it is a different failure from the two this task names, so wait it out here
# rather than proving the wrong thing.
echo -n 'waiting for the recycled gateway to answer again: '
for _ in $(seq 1 90); do
  if docker exec "$NAME" node -e \
    'fetch("http://127.0.0.1:8642/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
    >/dev/null 2>&1; then
    echo 'up'
    break
  fi
  sleep 2
done

echo '=== what the hub wrote into Hermes'"'"'s home ==='
echo '--- .env ---'
docker exec "$NAME" sh -c 'cat /data/hermes/.env 2>/dev/null || echo "(no .env)"'
echo '--- config.yaml ---'
docker exec "$NAME" sh -c 'cat /data/hermes/config.yaml 2>/dev/null || echo "(no config.yaml)"'

echo '=== the gateway'"'"'s own environment (the hardening: not only the file) ==='
docker exec "$NAME" sh -c '
for d in /proc/[0-9]*; do
  c=$(tr "\0" " " < $d/cmdline 2>/dev/null)
  # The gateway itself, not the shell that is looking for it (whose own cmdline
  # necessarily contains the words it is grepping for).
  case "$c" in
    */bin/hermes\ gateway\ run*)
      echo "pid=${d#/proc/} cmd=$c"
      tr "\0" "\n" < $d/environ 2>/dev/null | grep -E "^(HERMES_HOME|COREHUB_PROVIDER_|API_SERVER_PORT)" |
        sed -E "s/^(COREHUB_PROVIDER_[A-Z0-9_]+=.{8}).*/\1…/; s#^(HERMES_HOME=.{8}).*#\1…#" ;;
  esac
done'

echo '=== a run, with the model the composer chose ==='
AGENT_ID="$(hub GET /agents |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).items.find(x=>x.kind==="hermes"||x.slug==="hermes")||JSON.parse(s).items[0];console.log(a.id)})')"
MODEL_KEY="$(hub GET /models |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items[0].key))')"
echo "agent=$AGENT_ID composer model key=$MODEL_KEY"
SESSION_ID="$(hub POST /sessions "{\"agent_id\":\"$AGENT_ID\",\"model\":\"$MODEL_KEY\"}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
echo "session=$SESSION_ID"
echo -n 'run accepted: '
RUN="$(hub POST "/sessions/$SESSION_ID/runs" '{"content":[{"type":"text","text":"say hello"}]}')"
echo "$RUN"
RUN_ID="$(printf '%s' "$RUN" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).run_id))')"
await_run "$SESSION_ID" "$RUN_ID"
echo '-- the run --'
hub GET "/sessions/$SESSION_ID/runs/$RUN_ID" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({status:r.status,model:r.model,error:r.error,usage:r.usage},null,2))})'
echo '-- the transcript --'
hub GET "/sessions/$SESSION_ID/messages" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).items)console.log(m.role,":",JSON.stringify(m.content))})'

echo '=== CASE C — the upstream starts refusing the key it accepted (a revoked key) ==='
curl -sS -X POST "http://127.0.0.1:$ENDPOINT_PORT/__control" -H 'content-type: application/json' \
  -d '{"rejecting":true}'
echo
echo -n 'run accepted: '
RUN2="$(hub POST "/sessions/$SESSION_ID/runs" '{"content":[{"type":"text","text":"say hello again"}]}')"
echo "$RUN2"
RUN2_ID="$(printf '%s' "$RUN2" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).run_id))')"
await_run "$SESSION_ID" "$RUN2_ID"
hub GET "/sessions/$SESSION_ID/runs/$RUN2_ID" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({status:r.status,model:r.model,error:r.error},null,2))})'

echo '=== WHAT THE ENDPOINT RECEIVED ==='
cat "$REQUESTS"
