#!/usr/bin/env bash
# The image model (decision §72) against the real image: the hub and its Hermes in one throwaway
# container, the scripted upstream (`fake-provider.mjs --script images`) in a second one on a
# Docker network of their own. No real provider and no real key anywhere.
#
#   1. The upstream is added as a chat provider through the hub's API; its two image models
#      (`gpt-image-1` on the Images API, `gemini-3.1-flash-image` answering on chat completions
#      the way cli-proxy-api does) come back with `image_output`; the Images role is set.
#   2. What the hub wrote into Hermes's home: the four `COREHUB_IMAGE_*` values, `image_gen`
#      and `plugins.enabled` in `config.yaml`, and the backend folder.
#   3. A real chat turn for each image model: the upstream's chat model asks for Hermes's own
#      `image_generate` tool, Hermes draws through the hub's backend, and the picture comes back
#      into the conversation as an image on the reply.
#   4. The `image-generate` skill's script and `image-edit remove-bg`, run inside the container
#      with the profile's own `.env`, for both models; `image-convert transparent-bg` finishes
#      the cut-out a chat model returns on a flat colour.
#
#   docker build -f packages/server/Dockerfile -t core-hub:images .
#   packages/server/tests/container/prove-images.sh core-hub:images
#
# Nothing here touches the owner's machines: two containers and one network, all removed on exit,
# and one loopback port.
set -euo pipefail

IMAGE="${1:-core-hub:images}"
RUN_ID_SUFFIX="$$"
NET="corehub-images-prove-$RUN_ID_SUFFIX"
HUB="corehub-images-hub-$RUN_ID_SUFFIX"
LAB="corehub-images-lab-$RUN_ID_SUFFIX"
HUB_PORT="${HUB_PORT:-18917}"
KEY='sk-lab-images-key'
ADMIN_PASSWORD='prove-images-0000'
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
in_hub() { docker exec "$HUB" sh -c "$1"; }

docker network create "$NET" >/dev/null
# The upstream runs on the image's own Node, so nothing else is pulled.
docker run -d --name "$LAB" --network "$NET" -v "$HERE:/lab:ro" --entrypoint node "$IMAGE" \
  /lab/fake-provider.mjs --port 19099 --key "$KEY" --script images >/dev/null
docker run -d --name "$HUB" --network "$NET" -p "127.0.0.1:$HUB_PORT:8080" \
  -e DATA_DIR=/data -e PORT=8080 -e HUB_ADMIN_PASSWORD="$ADMIN_PASSWORD" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:$HUB_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
TOKEN="$(curl -sS -X POST "http://127.0.0.1:$HUB_PORT/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" | json 'j.access_token')"

echo '=== 1. the upstream as a chat provider, and its image models ==='
PROVIDER_ID="$(hub POST /models/providers \
  "{\"label\":\"Lab\",\"kind\":\"llm\",\"base_url\":\"http://$LAB:19099/v1\",\"api_key\":\"$KEY\",\"api_mode\":\"chat_completions\"}" |
  json 'j.id')"
echo "provider=$PROVIDER_ID"
hub POST "/models/providers/$PROVIDER_ID/refresh" '{}' >/dev/null
for _ in $(seq 1 30); do
  [[ "$(hub GET /models | json 'j.items.length')" -ge 3 ]] && break
  sleep 1
done
hub GET /models | json 'j.items.map(m=>`${m.key}  [${(m.capabilities||[]).join(",")}]`).join("\n")'
CHAT_KEY="$(hub GET /models | json 'j.items.find(m=>m.key.includes("tiny-1")).key')"

set_image() { # set_image <model id>
  hub PUT /models/defaults \
    "{\"default\":{\"provider_id\":\"$PROVIDER_ID\",\"model\":\"lab/tiny-1:free\"},\"image\":{\"provider_id\":\"$PROVIDER_ID\",\"model\":\"$1\"}}" |
    json 'JSON.stringify({default: j.default, image: j.image, inherited: j.inherited})'
}

await_gateway() {
  for _ in $(seq 1 90); do
    if docker exec "$HUB" node -e \
      'fetch("http://127.0.0.1:8642/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
}

await_run() { # await_run <session> <run>
  for _ in $(seq 1 90); do
    case "$(hub GET "/sessions/$1/runs/$2" | json 'j.status')" in
      succeeded | failed | cancelled | interrupted) return 0 ;;
    esac
    sleep 2
  done
}

AGENT_ID="$(hub GET /agents | json '(j.items.find(a=>a.kind==="hermes"||a.slug==="hermes")||j.items[0]).id')"

turn() { # turn <label> <image model>
  local label="$1" model="$2"
  echo
  echo "=== 3. a real chat turn, Images role = $model ==="
  set_image "$model"
  await_gateway
  local session run run_id
  session="$(hub POST /sessions "{\"agent_id\":\"$AGENT_ID\",\"model\":\"$CHAT_KEY\"}" | json 'j.id')"
  run="$(hub POST "/sessions/$session/runs" '{"content":[{"type":"text","text":"ارسم لي ثعلبًا أحمر"}]}')"
  run_id="$(printf '%s' "$run" | json 'j.run_id')"
  await_run "$session" "$run_id"
  echo '-- the run --'
  hub GET "/sessions/$session/runs/$run_id" | json 'JSON.stringify({status:j.status,model:j.model,error:j.error})'
  echo '-- the transcript --'
  hub GET "/sessions/$session/messages" |
    json 'j.items.map(m=>`${m.role}: ${JSON.stringify(m.content)}`).join("\n")'
  echo '-- the tool calls --'
  hub GET "/sessions/$session/messages" |
    json 'j.items.flatMap(m=>m.tool_calls||[]).map(t=>`${t.name} ${t.status} ${JSON.stringify(t.arguments)} -> ${String(t.output).slice(0,300)}`).join("\n")'
  echo '-- the session files --'
  hub GET "/sessions/$session/files" |
    json 'j.items.map(f=>`${f.name} ${f.mime} ${f.size_bytes}B sources=${f.sources}`).join("\n")' || true
  local images
  images="$(hub GET "/sessions/$session/messages" |
    json 'j.items.filter(m=>m.role==="assistant").flatMap(m=>m.content||[]).filter(p=>p.type==="image").length')"
  check "$label: the run succeeded" test "$(hub GET "/sessions/$session/runs/$run_id" | json 'j.status')" = succeeded
  check "$label: the reply carries the picture as an image" test "$images" -ge 1
  local url
  url="$(hub GET "/sessions/$session/messages" |
    json '(j.items.filter(m=>m.role==="assistant").flatMap(m=>m.content||[]).find(p=>p.type==="image")||{}).url||""')"
  echo "-- the picture, downloaded from the reply: $url --"
  curl -sS "http://127.0.0.1:$HUB_PORT$url" -H "authorization: Bearer $TOKEN" -o "/tmp/corehub-images-$RUN_ID_SUFFIX.png"
  file "/tmp/corehub-images-$RUN_ID_SUFFIX.png" 2>/dev/null || head -c 8 "/tmp/corehub-images-$RUN_ID_SUFFIX.png" | od -c | head -1
  check "$label: the picture on the reply is a PNG" sh -c "head -c 4 /tmp/corehub-images-$RUN_ID_SUFFIX.png | grep -q PNG"
  rm -f "/tmp/corehub-images-$RUN_ID_SUFFIX.png"
}

echo
echo '=== 2. what the hub wrote into Hermes'"'"'s home (Images role = gpt-image-1) ==='
set_image gpt-image-1
in_hub 'grep "^COREHUB_IMAGE_" /data/hermes/.env | sed -E "s/^(COREHUB_IMAGE_API_KEY=.{6}).*/\1…/"'
in_hub 'python3 - <<EOF
import yaml
c = yaml.safe_load(open("/data/hermes/config.yaml"))
print("image_gen:", c.get("image_gen"))
print("plugins.enabled:", (c.get("plugins") or {}).get("enabled"))
EOF' 2>/dev/null || in_hub 'grep -A3 -E "^(image_gen|plugins):" /data/hermes/config.yaml'
in_hub 'ls -l /data/hermes/plugins/image_gen/corehub-images/'

turn 'Images API (gpt-image-1)' gpt-image-1
turn 'chat image model (gemini-3.1-flash-image)' gemini-3.1-flash-image

echo
echo '=== 4. the skills inside the container, with the profile'"'"'s own .env ==='
SKILLS=/data/hermes/skills/core-hub
skill() { # skill <model> <command…>: runs image_api.py as Hermes's terminal would, in /tmp/skills
  local model="$1"
  shift
  set_image "$model" >/dev/null
  in_hub "cd /tmp && mkdir -p skills && cd skills && set -a && . /data/hermes/.env && set +a && $*"
}
for model in gpt-image-1 gemini-3.1-flash-image; do
  echo "-- image-generate, $model --"
  out="$(skill "$model" "python3 $SKILLS/image-generate/scripts/image_api.py generate --prompt 'a red fox in flat style' --out out-$model")"
  echo "$out"
  check "image-generate ($model) drew a file" sh -c "printf '%s' '$out' | grep -q '\"ok\": true'"
  src="$(printf '%s' "$out" | json 'j.files[0]')"
  echo "-- image-edit remove-bg, $model --"
  cut="$(skill "$model" "python3 $SKILLS/image-edit/scripts/image_api.py remove-bg --image $src --out cut-$model")"
  echo "$cut"
  check "remove-bg ($model) answered" sh -c "printf '%s' '$cut' | grep -q '\"ok\": true'"
  if printf '%s' "$cut" | grep -q '"transparent": false'; then
    file="$(printf '%s' "$cut" | json 'j.files[0]')"
    echo "-- image-convert transparent-bg (the next step remove-bg named) --"
    done_="$(skill "$model" "python3 $SKILLS/image-convert/scripts/image_tools.py transparent-bg $file")"
    echo "$done_"
    check "transparent-bg ($model) cleared the flat colour" sh -c "printf '%s' '$done_' | grep -q '\"ok\": true'"
  else
    check "remove-bg ($model) is transparent from the model" sh -c "printf '%s' '$cut' | grep -q '\"transparent\": true'"
  fi
done
echo '-- the pictures, read back with Pillow --'
in_hub '/opt/hermes/.venv/bin/python - <<EOF
from pathlib import Path
from PIL import Image
root = Path("/tmp/skills")
for p in sorted(root.rglob("*.png")):
    im = Image.open(p)
    corner = im.convert("RGBA").getpixel((0, 0))
    middle = im.convert("RGBA").getpixel((16, 16))
    print(p.relative_to(root), im.size, im.mode, "corner", corner, "middle", middle)
EOF'

echo
echo '=== what the upstream received ==='
docker logs "$LAB" 2>&1 | grep -v "authorization=" | sed -n '1,200p'

echo
if [[ "$FAILED" -eq 0 ]]; then echo 'ALL CHECKS PASSED'; else
  echo 'SOME CHECKS FAILED'
  exit 1
fi
