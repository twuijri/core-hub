# محادثة حقيقية مع Hermes عبر الخادم: المشغّل، وقت التشغيل المُشرَف عليه، وربط المنافذ
المسؤول: twuijri · الفرع: feat/hermes-runner · الحالة: review

## المشكلة والهدف
آخر فجوة في المرحلة صفر: وحدة `sessions` كانت تعمل فقط مع مشغّل مكتوب بالسيناريو، ومحوّل
`hermes` كان `start()` فيه يرمي `not_implemented`، والمنافذ الثلاثة (`agents`، `runner`،
`scopes`) لم تكن موصولة في `src/modules/index.ts`. الهدف: دور كامل مع Hermes Agent الحقيقي
يمرّ عبر الخادم — من `POST /sessions/{id}/runs` إلى `run.completed` على `/rt/sessions` —
بالأحداث وبالترتيب الذي يعلنه العقد، والموافقات ذهابًا وإيابًا، ومع تحديد كيف تصل الحاوية
إلى Hermes وكيف يُشغَّل ويُراقَب.

## القرار والموافقات
- **الغرفة النظيفة (ADR 0004)**: لم يُفتَح أي ملف تحت `agent-studio/packages/*` ولا أي مصدر من
  Hermes Studio / Ekko Studio. ما قُرئ: وثائق هذا المستودع، وثائق Hermes العامة، ومصدر
  Hermes Agent (MIT) على GitHub لملفات `gateway/platforms/api_server.py` و
  `api_server_runs.py` و`gateway/config_env.py` و`tools/approval.py` و`hermes_cli/gateway.py`
  و`Dockerfile` و`pyproject.toml` — كلها مسجّلة بروابطها في `docs/inspirations/hermes-agent.md`.
  لم يُنسَخ أي كود.
- **ADR 0008 (جديد)**: المحوّل يقود سطح **API server `/v1/runs`** (HTTP + SSE) لا TUI gateway؛
  والمركز **يشرف على Hermes كعملية ابن** (`hermes gateway run`) داخل الحاوية بدل sidecar،
  مع اكتشاف بوابة خارجية إن وُجدت، و«غير مهيّأ» إن لم يوجد شيء. مفاتيح المزوّدين تبقى في بيت
  Hermes داخل المجلد `/data/hermes` ولا تمرّ بالمركز أبدًا.
- **وقت التشغيل المحلي على جهاز المالك**: يوجد Hermes (0.20.6) يعمل على `127.0.0.1:8642` من
  حزمة أخرى، ومفتاحه `API_SERVER_KEY` ليس بيدي ولم أحاول استخراجه من حاويات المالك (رُفض ذلك
  صراحةً وهو الصواب). لذلك الاختبار الحقيقي **مسوَّر** بـ`HERMES_E2E=1` + `HERMES_API_KEY`
  ويتخطّى نفسه بصراحة بدونهما؛ تشغيله الفعلي يحتاج المالك.
- **أصغر التغييرات في الوحدتين**: في `sessions` صار كل منفذ يقبل مصنعًا `(app) => port` (لأن
  الخدمات الحقيقية لكل تطبيق لا لكل عملية)، وصار `ScopeResolver.resolve(profile, request)`
  يستلم الطلب ليقرأ منه المبدأ. في `agents`: `targetFor`/`setRuntime`/`reprobe`/`restart` على
  الخدمة، وتصدير `agentRunner` و`hermesRuntimeFor`. في `auth`: ملف واحد `scopes.ts` وتصديره.
- **`agents.restart` لم يعد 501**: مع وجود مشرف على العملية صار له معنى صادق (يعيد تشغيل
  الابن المُدار فقط؛ 409 لغير ذلك).
- لم يُدفع الفرع ولم يُفتح PR ولم يُنشر شيء.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. كل حدث مُرسَل يُتحقَّق منه في الاختبارات مقابل مخطّطات
`packages/contracts/events/sessions/*` كما هي، وتسلسل الأحداث هو ما تعلنه `x-rt-events` في
`sessions.createRun`. عمليتان كانتا 501 صارتا منفَّذتين كما هما في العقد: `agents.restart`
(202 + job) وكل عمليات `sessions` تحت مصادقة `auth` الحقيقية (401/404 موثّقتان أصلًا).

## الملفات والتأثير
**`packages/server/src/modules/agents/`**
- `adapters/hermes.ts` — `start()` حقيقي: `HermesSession` فوق `HermesTransport`
  (`httpHermesTransport` للـHTTP/SSE، ومنقول مكتوب بالسيناريو في الاختبارات)، تحويل إطارات
  `/v1/runs` إلى أحداث المحوّل، الموافقات بـ`choice`، الإيقاف بـ`/stop`، `parseSse`.
- `adapters/types.ts` — توسيع إضافي لمفردات `AgentEvent` (`usage`، `context`، حقول الأدوات
  والموافقات)، و`AgentTarget.sessionRef/model/reasoningEffort`.
- `adapters/event-queue.ts` — الطابور المشترك بين ACP وHermes (كان داخل `acp.ts`).
- `runner.ts` — `AgentRunner` (المنفذ `start/stream/send/interrupt`)، وجلسة حيّة واحدة لكل
  جلسة مركز، ودالة صافية `toRunnerEvent` للتحويل إلى أحداث `sessions`، وخريطة القرارات
  (`approve_once/…/deny` ↔ خيارات الوكيل).
- `hermes-runtime.ts` — المشرف: external/managed/absent، مفتاح API مولَّد في
  `${DATA_DIR}/keys/hermes-api.secret` (0600)، إعادة تشغيل بتراجع أسّي، فحص `/health`،
  سجلات الابن في سجل المركز، إيقاف مع الخادم.
- `ports.ts` — `AgentRunnerPort` وأنواعه (إعادة صياغة بنيوية لمنفذ `sessions`).
- `service.ts` — `targetFor`، `setRuntime`، `reprobe`، `restart`. `index.ts` — سياق لكل
  تطبيق (خدمة + محوّلات + مشغّل + وقت تشغيل)، خطّافا `onReady`/`onClose`، مسار
  `agents.restart`، تصديرات `agentRunner`/`hermesRuntimeFor`.
- اختبارات: `adapters/hermes.test.ts`، `runner.test.ts`، `hermes-runtime.test.ts`،
  `hermes.e2e.test.ts` (مسوَّر)، وتعديل اختبار في `adapters/adapters.test.ts`.

**`packages/server/src/modules/sessions/`**: `index.ts` (مصانع المنافذ)، `scope.ts`
و`routes.ts` (الطلب إلى `resolve`).
**`packages/server/src/modules/auth/`**: `scopes.ts` (جديد) + تصدير في `index.ts`.
**`packages/server/src/modules/index.ts`**: سطر التركيب
`createSessionsModule({ agents: agentDirectory, runner: agentRunner, scopes: principalScopeResolver })`.
**`packages/server/src/i18n/{ar,en}.json`**: `jobs.restart_started/restart_done`.
**`packages/server/package.json` + `pnpm-lock.yaml`**: `ajv`/`ajv-formats` إلى `dependencies` (انظر الفحوص).
**الصورة**: `packages/server/Dockerfile` (مرحلة `hermes`: CPython 3.12 مستقل عبر `uv` + venv
بتثبيت editable لـ`hermes-agent[cron,mcp]` من checkout للوسم `v2026.9.14` + `aiohttp`؛ وقت التشغيل يضيف
`git`/`ripgrep`/`ca-certificates` و`HERMES_HOME=/data/hermes`)، `docker-compose.yml` (تعليق).
**الوثائق**: `docs/adr/0008-hermes-runtime.md`، `docs/DEPLOY.md`،
`docs/inspirations/hermes-agent.md` (قسم `/v1/runs` والروابط)، `docs/domain/agents.md`.

### ما يعمل فعلًا وما يعمل ضد بدائل فقط
| الجزء | الدليل |
|---|---|
| تحويل إطارات Hermes → أحداث العقد بالترتيب المعلن | `runner.test.ts` عبر HTTP + السوكِت الحقيقيين مع Hermes مكتوب بالسيناريو خلف المحوّل الحقيقي (لا شبكة) |
| الموافقات ذهابًا (`approval.request` → `approval.requested`) وإيابًا (`respond` → `POST …/approval {choice}`) | `runner.test.ts`, `hermes.test.ts` |
| الإلغاء (`cancel` → `/stop` → `run.cancelled`)، الفشل بنص Hermes نفسه | `runner.test.ts` |
| تحليل SSE وبعث `Bearer` وقراءة ظرف خطأ Hermes | `hermes.test.ts` على بايتات حقيقية و`fetch` مزيّف |
| المشرف: الأوضاع الثلاثة، بيئة الابن ومفتاحه، إعادة التشغيل، الإيقاف | `hermes-runtime.test.ts` بمُشغِّل مزيّف |
| النطاق من `auth` (401 بلا رمز، 404 لمساحة مجهولة، `owner_id` الحقيقي) | `runner.test.ts` |
| **محادثة مع Hermes حقيقي** | `hermes.e2e.test.ts` — **لم يُشغَّل هنا** (يحتاج `HERMES_API_KEY` من المالك) |
| **الصورة تُبنى وHermes داخلها يقلع تحت إشراف المركز** | انظر الفحوص أدناه |

## الفحوص (الأوامر ونواتجها الفعلية)
كلها على `node v24.21.0` / `pnpm 12.5.1` في worktree نظيف بعد إعادة الأساس على
`origin/feat/auth-and-agents` (`534431c`):

```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
[exit 0]

$ pnpm typecheck                       # contracts + server، tsc --noEmit
[exit 0]

$ pnpm i18n:check
i18n:check  server: 72 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 35 destinations, 37 terms, ar/en complete

$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK

$ pnpm test
 Test Files  3 passed (3)              # @majlis/contracts
      Tests  11 passed (11)
 Test Files  30 passed | 1 skipped (31)   # @majlis/server (unit)
      Tests  187 passed | 1 skipped (188)  # المتخطَّى = hermes.e2e.test.ts بلا HERMES_E2E

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  247 passed (247)

$ pnpm build
[exit 0]

$ pnpm db:generate
No schema changes, nothing to migrate 😴

$ DATA_DIR=$(mktemp -d) pnpm db:migrate    # قاعدة SQLite جديدة
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}

$ cd packages/server && npx vitest run --project unit src/modules/agents/hermes.e2e.test.ts
 Test Files  1 skipped (1)             # بلا HERMES_E2E=1: يتخطّى بصراحة، لا ينجح زورًا
```

**بناء الصورة وتشغيلها (على جهاز المطوّر، `DOCKER_BUILDKIT=0` لأن buildx غير مثبّت هنا):**

```
$ docker build -f packages/server/Dockerfile -t majlis:runner .
Successfully built 551a54a4f89a            # الحجم 1.24 GB (مقابل ≈6 GB لصورة Hermes الرسمية)

$ docker run -d --name majlis-smoke -p 127.0.0.1:18080:8080 \
    -e HUB_ADMIN_PASSWORD=smoke-test-password -v majlis-smoke-data:/data majlis:runner
# سجل المركز (مقتطف):
{"msg":"hermes: gateway started (managed)","pid":20,"home":"/data/hermes"}
{"msg":"agents: hermes runtime","mode":"managed","endpoint":"http://127.0.0.1:8642"}
{"msg":"core hub listening", "modules":[…13…], "database":"sqlite","dataDir":"/data"}
{"hermes":true,"msg":"│           ☤ Hermes Gateway Starting...                 │"}
{"msg":"hermes: gateway healthy","endpoint":"http://127.0.0.1:8642"}      # بعد ≈18 ثانية

$ docker exec majlis-smoke curl -fsS http://127.0.0.1:8642/health
{"status": "ok", "platform": "hermes-agent", "version": "0.21.3"}

$ node smoke.mjs http://127.0.0.1:18080 smoke-test-password     # تسجيل دخول → agents → session → run
health 200 {"ok":true,"server_version":"0.0.0","uptime_seconds":19}
login 200
hermes agent {"status":"available","runtime":{"state":"running","url":"http://127.0.0.1:8642","error":null}}
session 201 01M32KHDJAGC3H3J1VJKYCEQTE
run accepted 202 {"job_id":"…","run_id":"01M32KHDJGFKXGTGQFE8477ADS","message_id":"…","queue_position":null}
run final {"status":"failed","error":{"error":"⚠️ Provider authentication failed: No inference provider
  configured. Run 'hermes model' to choose a provider and model, or set an API key (OPENROUTER_API_KEY,
  OPENAI_API_KEY, etc.) in ~/.hermes/.env.","code":"agent_error"},"usage":null}
messages [{"role":"user","status":"complete","text":"Reply with one word: مرحبا"},
          {"role":"assistant","status":"failed","text":""}]

$ curl -X POST …/api/v1/agents/<hermes id>/restart        # agents.restart
{"job_id":"01M32KHPFXYWQWHEHP1YEMJM8R"}
{"msg":"hermes: restart requested","pid":20} … {"msg":"hermes: gateway started (managed)","pid":220}

$ docker restart majlis-smoke                               # البيانات تبقى
sessions after restart: ['smoke']
$ docker exec majlis-smoke stat -c "%a %n" /data/keys/hermes-api.secret
600 /data/keys/hermes-api.secret
```

القراءة الصحيحة لهذا الناتج: المسار الكامل عبر Hermes **الحقيقي** (0.21.3 داخل الصورة، تحت
إشراف المركز) يعمل: `POST /v1/runs` قُبل، بث SSE وصل، الحدث الختامي `run.failed` تُرجم إلى
`run.failed` على العقد بنص Hermes نفسه. الفشل هو الفشل الصادق المتوقّع في حاوية بلا مفتاح
مزوّد — تعيينه بيد المالك (`docs/DEPLOY.md` §3). **لم يُنفَّذ** دور بردّ نموذج حقيقي
(`hermes.e2e.test.ts`) لأن مفتاح API للبوابة المحلية على هذا الجهاز ليس بحوزتي.

أخطاء اكتُشفت أثناء بناء الصورة وأُصلحت هنا:
- `hermes-agent` يرفض بناء wheel من git (`Building wheels or sdists for hermes-agent is not
  supported`)، فصار التثبيت **editable** من checkout للوسم في `/opt/hermes/src`.
- `ajv`/`ajv-formats` كانا `devDependencies` بينما `src/lib/contract.ts` يستوردهما وقت
  التشغيل → الحاوية كانت تسقط بـ`ERR_MODULE_NOT_FOUND` (خلل سابق من فرع الوكلاء، كان سيُسقط
  وظيفة docker في CI أيضًا). نُقلا إلى `dependencies` وحُدّث `pnpm-lock.yaml`.

## المخاطر والرجوع
- **الاختبار الحقيقي لم يُنفَّذ بعد**: أشكال الإطارات مأخوذة من مصدر `main` (0.21.3) بينما
  البوابة المحلية 0.20.6 والوسم المثبّت في الصورة `v2026.9.14`؛ اختلاف صغير في حقل قد يظهر
  فقط عند التشغيل الحقيقي. الحماية: كل حقل مجهول يُسقَط لا يُخمَّن، والحدث الختامي يحمل النص
  كاملًا (`output`) فلا يضيع الرد حتى لو غابت الفروق.
- **مطابقة `tool.completed` بالاسم**: `/v1/runs` لا يرقّم نداءات الأدوات؛ نداءان متوازيان
  بالاسم نفسه قد يتبادلان المخرجات. مقبول للمرحلة صفر وموثّق في ADR 0008.
- **`answer` النصي غير مدعوم** (لا `clarify` على هذا السطح): `409 state_invalid` صراحةً.
- **الجلسات الحيّة في الذاكرة**: إعادة تشغيل المركز تفقد عمليات ACP الأبناء (تُفتح من جديد)
  ولا تفقد محادثات Hermes (معرّفها ثابت `majlis-<ulid>` يحمّله Hermes من قاعدته).
- **مفتاح البوابة الخارجية**: لو كانت البوابة خارجية بمفتاح مختلف عن ملف المركز، تفشل الأدوار
  بـ`agent_unavailable` مع رسالة واضحة (`docs/DEPLOY.md`).
- **الرجوع**: إزالة سطر التركيب في `src/modules/index.ts` يعيد `sessions` إلى المنافذ
  الافتراضية (404/422) بلا أثر آخر؛ حذف مرحلة `hermes` من `Dockerfile` يعيد الصورة السابقة.
  لا ترحيل جديد لقاعدة البيانات.

## التسليم والخطوة التالية
1. مراجعة المالك لهذا الفرع (ADR 0008 خاصةً). لا PR ولا دفع بلا طلب.
2. على جهاز المالك: `HERMES_E2E=1 HERMES_API_KEY=… pnpm --filter @majlis/server exec vitest
   run --project unit src/modules/agents/hermes.e2e.test.ts` ضد البوابة المحلية، ثم بناء
   الصورة و`docker compose up` مع `hermes model` داخل الحاوية (`docs/DEPLOY.md` §3-4).
3. بعدها: عميل `packages/cli` المرجعي (ADR 0007) لإثبات المرحلة صفر، ثم سطح TUI gateway
   للتوجيه وأسئلة `clarify`.
