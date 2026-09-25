#!/usr/bin/env bash
# Files an agent leaves in the run's output folder come back on the reply (2026-09-26): the hub
# and its Hermes in one throwaway container, the scripted upstream
# (`fake-provider.mjs --script images-copy`) in a second one on a Docker network of their own.
# No real provider and no real key anywhere.
#
# The upstream's chat model does what the owner's `gemini-3.8-flash-high` did for «سوي صورة قط
# يطير»: Hermes's `image_generate` (the Images role is a chat model that draws, answering the way
# cli-proxy-api does), then `execute_code` to copy the picture into the output folder as
# `flying_cat.png`, then a reply that names the absolute path.
#
#   docker build -f packages/server/Dockerfile -t core-hub:replyfiles .
#   packages/server/tests/container/prove-reply-files.sh core-hub:replyfiles
#
# Nothing here touches the owner's machines: two containers and one network, all removed on exit,
# and one loopback port.
set -euo pipefail

IMAGE="${1:-core-hub:replyfiles}"
SUFFIX="$$"
NET="corehub-replyfiles-prove-$SUFFIX"
HUB="corehub-replyfiles-hub-$SUFFIX"
LAB="corehub-replyfiles-lab-$SUFFIX"
HUB_PORT="${HUB_PORT:-18919}"
KEY='sk-lab-replyfiles-key'
ADMIN_PASSWORD='prove-replyfiles-0000'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0

cleanup() {
  if [[ -z "${KEEP:-}" ]]; then
    docker rm -f "$HUB" "$LAB" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }
hub() { # hub <method> <path> [json]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "http://127.0.0.1:$HUB_PORT/api/v1$path" -H "authorization: Bearer $TOKEN" \
      -H 'x-hub-profile: default' -H 'content-type: application/json' -d "$body"
  else
    curl -sS -X "$method" "http://127.0.0.1:$HUB_PORT/api/v1$path" -H "authorization: Bearer $TOKEN" \
      -H 'x-hub-profile: default'
  fi
}
check() { # check <label> <command…>: prints PASS/FAIL, keeps going
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $label"; else
    echo "FAIL  $label"
    FAILED=1
  fi
}

docker network create "$NET" >/dev/null
docker run -d --name "$LAB" --network "$NET" -v "$HERE:/lab:ro" --entrypoint node "$IMAGE" \
  /lab/fake-provider.mjs --port 19099 --key "$KEY" --script images-copy >/dev/null
docker run -d --name "$HUB" --network "$NET" -p "127.0.0.1:$HUB_PORT:8080" \
  -e DATA_DIR=/data -e PORT=8080 -e HUB_ADMIN_PASSWORD="$ADMIN_PASSWORD" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$HUB_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
TOKEN="$(curl -sS -X POST "http://127.0.0.1:$HUB_PORT/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | json 'j.access_token')"

echo '=== 1. the upstream as a chat provider; Images role = gemini-3.1-flash-image ==='
PROVIDER_ID="$(hub POST /models/providers \
  "{\"label\":\"Lab\",\"kind\":\"llm\",\"base_url\":\"http://$LAB:19099/v1\",\"api_key\":\"$KEY\",\"api_mode\":\"chat_completions\"}" |
  json 'j.id')"
hub POST "/models/providers/$PROVIDER_ID/refresh" '{}' >/dev/null
for _ in $(seq 1 30); do
  [[ "$(hub GET /models | json 'j.items.length')" -ge 3 ]] && break
  sleep 1
done
CHAT_KEY="$(hub GET /models | json 'j.items.find(m=>m.key.includes("tiny-1")).key')"
hub PUT /models/defaults \
  "{\"default\":{\"provider_id\":\"$PROVIDER_ID\",\"model\":\"lab/tiny-1:free\"},\"image\":{\"provider_id\":\"$PROVIDER_ID\",\"model\":\"gemini-3.1-flash-image\"}}" |
  json 'JSON.stringify({default: j.default, image: j.image})'
for _ in $(seq 1 90); do
  if docker exec "$HUB" node -e \
    'fetch("http://127.0.0.1:8642/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
    >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo
echo '=== 2. «سوي صورة قط يطير»: image_generate, then execute_code copies it into out/ ==='
AGENT_ID="$(hub GET /agents | json '(j.items.find(a=>a.kind==="hermes"||a.slug==="hermes")||j.items[0]).id')"
SESSION="$(hub POST /sessions "{\"agent_id\":\"$AGENT_ID\",\"model\":\"$CHAT_KEY\"}" | json 'j.id')"
RUN_ID="$(hub POST "/sessions/$SESSION/runs" '{"content":[{"type":"text","text":"سوي صورة قط يطير"}]}' | json 'j.run_id')"
echo "session=$SESSION run=$RUN_ID"
# Hermes asks before `execute_code` runs a script; the person says yes, as the owner did.
for _ in $(seq 1 90); do
  case "$(hub GET "/sessions/$SESSION/runs/$RUN_ID" | json 'j.status')" in
    succeeded | failed | cancelled | interrupted) break ;;
  esac
  for approval in $(hub GET "/approvals?session_id=$SESSION" | json 'j.items.map(a=>a.id).join(" ")'); do
    echo "approving $approval: $(hub GET "/approvals/$approval" | json 'j.title')"
    hub POST "/approvals/$approval/respond" '{"decision":"approve_once"}' >/dev/null
  done
  sleep 2
done
hub GET "/sessions/$SESSION/runs/$RUN_ID" | json 'JSON.stringify({status:j.status,error:j.error})'
MESSAGES="$(hub GET "/sessions/$SESSION/messages")"
echo '-- the transcript --'
printf '%s' "$MESSAGES" | json 'j.items.map(m=>`${m.role}: ${JSON.stringify(m.content)}`).join("\n")'
echo '-- the tool calls --'
printf '%s' "$MESSAGES" |
  json 'j.items.flatMap(m=>m.tool_calls||[]).map(t=>`${t.name} ${t.status} -> ${String(t.output).slice(0,240)}`).join("\n")'
echo '-- the run folder on disk --'
docker exec "$HUB" sh -c "find /data/workspaces -path '*runs/$RUN_ID*' | sort" || true
echo '-- the session files --'
hub GET "/sessions/$SESSION/files" |
  json 'j.items.map(f=>`${f.name} ${f.mime} ${f.size_bytes}B sources=${f.sources}`).join("\n")' || true

reply() { printf '%s' "$MESSAGES" | json "(j.items.filter(m=>m.role==='assistant').pop()||{content:[]}).content$1"; }
check 'the run succeeded' test "$(hub GET "/sessions/$SESSION/runs/$RUN_ID" | json 'j.status')" = succeeded
check 'flying_cat.png, which execute_code wrote, is on the reply as an image' \
  test "$(reply '.filter(p=>p.type==="image"&&p.name==="flying_cat.png").length')" -ge 1
check 'the picture is on the reply once, not also as the copy the hub made' \
  test "$(reply '.filter(p=>p.type==="image").length')" -eq 1
check 'the hub told the model to name its files, not their path' \
  sh -c "docker logs '$LAB' 2>&1 | grep -q 'told to name files= true'"
check 'the reply names no internal path' \
  test "$(reply '.filter(p=>p.type==="text").map(p=>p.text).join("").match(/\/data\/|\.corehub\//)?"leak":"clean"')" = clean
check 'the Files panel lists flying_cat.png' sh -c \
  "curl -sS 'http://127.0.0.1:$HUB_PORT/api/v1/sessions/$SESSION/files' -H 'authorization: Bearer $TOKEN' -H 'x-hub-profile: default' | grep -q flying_cat.png"

echo
echo '=== what the upstream received ==='
docker logs "$LAB" 2>&1 | grep -v "authorization=" | sed -n '1,120p'
echo '=== hub log lines about files ==='
docker logs "$HUB" 2>&1 | grep -iE 'produced|output folder|file exchange|handed' | tail -20 || true

echo
if [[ "$FAILED" -eq 0 ]]; then echo 'ALL CHECKS PASSED'; else
  echo 'SOME CHECKS FAILED'
  exit 1
fi
