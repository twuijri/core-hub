# تقليص صورة Docker بلا تغيير في السلوك
المسؤول: twuijri · الفرع: chore/slim-image · الحالة: review

## المشكلة والهدف
صورة `majlis:phase0` (فرع `feat/hermes-runner`) بحجم 1.24 GB كما يعرضه `docker image ls`. القياس
داخلها: `/opt/hermes/src` 199 MB، `/opt/hermes/.venv` 174 MB، `/opt/hermes/python` 109 MB،
طبقة Node ‏156 MB، طبقة apt (git + ripgrep + curl) 108 MB، أساس Debian ‏85 MB، `/app` 81 MB.
الهدف: أقل من 800 MB بوضوح مع بقاء كل شيء يعمل كما هو: المركز، Hermes 0.21.x تحت إشراف المركز
(managed)، أوامر `hermes model` / `hermes config` / `hermes doctor` عبر `docker compose exec`، وكل ما
يحتاجه Hermes وقت التشغيل.

ملاحظة على المقياس: `docker image ls` في Docker 29 (مخزن containerd) يعرض «DISK USAGE» = الطبقات
المفكوكة **+** المحتوى المضغوط معًا. لذلك تُذكر أدناه ثلاثة أرقام لكل صورة: المجموع المفكوك
(مجموع `docker history`، وهو ما يشغله القرص فعلًا على الخادم وما تعرضه إصدارات Docker الأقدم)،
والمحتوى المضغوط (ما يُسحب من GHCR)، ورقم `docker image ls` كما هو.

## القرار والموافقات
- **الغرفة النظيفة (ADR 0004)**: لم يُفتح أي ملف تحت `agent-studio/packages/*`. ما قُرئ: وثائق هذا
  المستودع، و`Dockerfile` الحالي، ومصدر Hermes Agent (MIT) **من داخل الصورة نفسها** (`/opt/hermes/src`
  للوسم `v2026.9.14`) لمعرفة ما يقرؤه وقت التشغيل: `pyproject.toml` (`[tool.setuptools.packages.find]`
  و`setup.py` الذي يشرح لماذا لا wheel)، `tools/lazy_deps.py`، `tools/checkpoint_manager.py`،
  `tools/working_diff.py`، `tools/subagent_worktree.py`، `tools/file_operations_search.py`،
  `hermes_cli/managed_uv.py`، `hermes_cli/model_catalog.py`، `hermes_cli/dep_ensure.py`،
  `hermes_cli/mcp_catalog.py`، `hermes_cli/plugin_catalog.py`، `agent/i18n.py`، `nix/hermes-agent.nix`.
  لم يُنسخ أي كود.
- **ما حُذف ولماذا كل حذف آمن** (كل بند تحقّق منه بالبحث في كود Hermes غير الاختباري):
  1. **نسخة Hermes (`/opt/hermes/src`) 199 → 65 MB**: حُذفت `tests` (41 MB)، `apps` (35، تطبيق سطح
     المكتب)، `website` (27، موقع الوثائق — أُبقي منه ملف واحد `website/static/api/model-catalog.json`
     لأن `hermes_cli/model_catalog.py` يقرؤه)، `ui-tui` و`web` (مصادر TUI واللوحة؛ لم تُبنَ يومًا في هذه
     الصورة — ADR 0008 §3: «لا لوحة ولا TUI»)، `evals`، `tests-js`، `contributors`، `nix`، `docker`،
     `.github`، ملفات التثبيت (`install.sh`، `setup-hermes.sh`)، `Dockerfile` و`docker-compose*.yml`
     الخاصة بـHermes، وترجمات README/CONTRIBUTING/SECURITY. لا مرجع لأي منها من كود التشغيل. أُبقي
     كل ما تُعلنه `packages.find` والوحدات الجذرية، وكل مجلد بيانات يُحلّ نسبةً إلى جذر المصدر:
     `skills`، `optional-skills`، `optional-mcps`، `plugin-catalog`، `locales`، `scripts`
     (`dep_ensure.py` يبحث عن `scripts/install.sh`)، `uv.lock` (`managed_uv.py`)،
     `cli-config.yaml.example`، `pyproject.toml`، `package.json`/`package-lock.json`، `SOUL.md`،
     `LICENSE`، `README.md`. تثبيت editable **بقي كما هو** — لا wheel: `setup.py` يرفضه صراحةً خارج Nix.
  2. **CPython المستقل (`/opt/hermes/python`) 109 → 57 MB**: `libpython3.12.so.1.0` (32 MB) — الثنائي
     `python3.12` مربوط إستاتيكيًا (`ldd` لا يذكر libpython) ولا امتداد واحد في venv يربطها (فُحصت كل
     `.so` بـ`ldd`)؛ Tcl/Tk ومعها `tkinter`/`idlelib`/`turtledemo`/`_tkinter` (لا استيراد لـtkinter في
     Hermes)؛ `include/` و`pkgconfig/` و`*-config` (لا مترجم في الصورة)؛ `share/man`؛ و`pip` الخاص
     بالمفسّر الأساسي (غير مرئي للـvenv لأن `include-system-site-packages = false`). **أُبقي**
     `ensurepip` لأن `tools/lazy_deps.py` يعتمد عليه في سلّم التثبيت الكسول (uv → pip → ensurepip)،
     و`share/terminfo` لأن `hermes sessions browse` و`hermes plugins` تستخدم `curses`. لا يزال في
     الصورة Python واحد فقط (لا python3 من Debian).
  3. **`/app` 81 → 61 MB**: `better-sqlite3` تشحن مصدر SQLite (`deps/`، 10 MB) ومصادر C++ وثنائيات
     مسبقة لثماني منصات؛ `lib/binding.js` يحمّل `prebuilds/<platform>-<arch>.node` (مجلد `build/`
     لا يحوي إلا ختم node-gyp). أُبقي `linux-x64` و`linux-arm64` — المنصتان اللتان يبنيهما
     `release.yml` — و`require('better-sqlite3')` يُنفَّذ داخل مرحلة البناء بعد الحذف ليثبت أن الثنائي
     المُبقى يُحمَّل.
  4. **طبقة Node 156 → 146 MB**: وقت التشغيل صار `debian:bookworm-slim` (وهو أساس
     `node:24-bookworm-slim` نفسه) مع نسخ ثنائي `node` و`npm` من مرحلة البناء. سقط yarn (5 MB)،
     corepack، رؤوس C لـNode (7 MB)، وطبقة apt الخاصة بصورة Node (wget/gnupg). **أُبقي npm** لأن
     `modules/agents/installer.ts` يثبّت وكلاء الكتالوج بـ`npm install --global --prefix`.
- **ما لم يُحذف عمدًا**: `git` (≈95 MB مع perl الذي يعتمد عليه في Debian) لأن أدوات Hermes نفسها
  تناديه: نقاط الاستعادة قبل التعديل (`checkpoint_manager.py`)، `working_diff.py`،
  `subagent_worktree.py`؛ `ripgrep` لأن `file_operations_search.py` يعتمد عليه؛ `curl` لأن
  `managed_uv.py` يجلب uv به؛ وكل حزم venv لأنها كلها في `dependencies` الأساسية لـ`pyproject.toml`
  (Pillow وpillow-heif وnemo-relay وuvloop وcryptography مثبَّتة بالضبط وموثَّقة هناك). لا Alpine/musl:
  `nemo_relay/_native.abi3.so` و`uvloop` و`pydantic_core` و`cryptography` عجلات مترجَمة لا Python
  صافيًا، فالتبديل لن يكون بلا تغيير.
- لم يُدفع الفرع ولم يُفتح PR ولم يُنشر شيء.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/Dockerfile` — مراحل `prod-deps` و`hermes` تقلّم ما لا يُحمَّل وقت التشغيل
  (بقوائم مشروحة في التعليقات)؛ مرحلة `runtime` من `debian:bookworm-slim` + نسخ `node`/`npm` من
  مرحلة `base`؛ `apt-get clean`. الأمر والمنافذ والمستخدم والـHEALTHCHECK وكل مسار (`/opt/hermes/src`،
  `/opt/hermes/.venv`، `/data`) كما كانت. البناء على buildx وعلى المنشئ القديم (`DOCKER_BUILDKIT=0`).
- `docs/DEPLOY.md` — فقرة عن وزن الصورة وما يشغله.
- لا تغيير في كود الخادم ولا العقد ولا الاختبارات.

## الفحوص (الأوامر ونواتجها الفعلية)
الكود (لم يتغير) على `node v24.21.0` / `pnpm 12.5.1` في worktree من `origin/feat/hermes-runner`:

```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
[exit 0]

$ pnpm typecheck
packages/server typecheck: Done
packages/cli typecheck: Done
[exit 0]

$ pnpm test
packages/contracts test:  Test Files  3 passed (3)      Tests  11 passed (11)
packages/cli test:        Test Files  10 passed (10)    Tests  55 passed (55)
packages/server test:     Test Files  30 passed | 1 skipped (31)   Tests  187 passed | 1 skipped (188)
[exit 0]

$ pnpm build
packages/cli build: Done
packages/server build: Done
[exit 0]
```

**بناء الصورة** (`DOCKER_BUILDKIT=0` لأن buildx غير مثبّت على هذا الجهاز؛ في CI تعمل مع buildx):

```
$ DOCKER_BUILDKIT=0 docker build -f packages/server/Dockerfile -t majlis:slim .
Successfully built 1ca5721728ad
Successfully tagged majlis:slim

$ docker image ls majlis
IMAGE           ID             DISK USAGE   CONTENT SIZE
majlis:phase0   3b9a4c96c900       1.24GB          294MB      # قبل
majlis:slim     1ca5721728ad        924MB          212MB      # بعد

$ docker image inspect --format '{{.Size}}'      # المحتوى المضغوط
majlis:phase0  293755479
majlis:slim    212140924
```

| المقياس | قبل (`phase0`) | بعد (`slim`) |
|---|---|---|
| مجموع الطبقات المفكوكة (`docker history`) | ≈947 MB | ≈712 MB |
| المحتوى المضغوط (ما يُسحب) | 294 MB | 212 MB |
| `docker image ls` DISK USAGE (مفكوك + مضغوط) | 1.24 GB | 924 MB |

`docker history majlis:slim` (الطبقات ذات الحجم):

```
85.3MB   debian:bookworm-slim
108MB    apt-get install ca-certificates curl git ripgrep + useradd hub
127MB    COPY /usr/local/bin/node            (من مرحلة base)
18.9MB   COPY /usr/local/lib/node_modules/npm
309MB    COPY /opt/hermes                     (كان 504MB)
57.9MB   COPY /app  (prod deps)               (كان 81.1MB)
5.4MB    openapi.yaml + events + contracts/dist + server/dist + drizzle
```

القياس داخل الصورة الجديدة:

```
$ docker run --rm --entrypoint sh majlis:slim -c 'du -sh /opt/hermes/src /opt/hermes/.venv /opt/hermes/python /app'
65M   /opt/hermes/src      (كان 199M)
174M  /opt/hermes/.venv    (كما هو — كل حزمة فيه في dependencies الأساسية)
57M   /opt/hermes/python   (كان 109M)
61M   /app                 (كان 83M)
$ which git rg curl node npm npx yarn python3 hermes
/usr/bin/git /usr/bin/rg /usr/bin/curl /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx
/opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/hermes        # لا yarn
git version 2.39.5 · ripgrep 13.0.0 · v24.21.0 · npm 11.19.0 · Hermes Agent v0.21.3 (2026.9.14) · Python 3.12.13
```

**اختبار الحاوية نفسه كما في `2026-09-21-twuijri-hermes-runner.md`:**

```
$ docker run -d --name majlis-slim-smoke -p 127.0.0.1:18081:8080 \
    -e HUB_ADMIN_PASSWORD=smoke-test-password -v majlis-slim-smoke-data:/data majlis:slim
{"msg":"hermes: gateway started (managed)","pid":19,"home":"/data/hermes"}
{"msg":"agents: hermes runtime","mode":"managed","endpoint":"http://127.0.0.1:8642"}
{"hermes":true,"msg":"│           ☤ Hermes Gateway Starting...                 │"}
{"msg":"hermes: gateway healthy","endpoint":"http://127.0.0.1:8642"}        # بعد 21 ثانية

$ docker exec majlis-slim-smoke curl -fsS http://127.0.0.1:8642/health
{"status": "ok", "platform": "hermes-agent", "version": "0.21.3"}

$ node smoke.mjs http://127.0.0.1:18081 smoke-test-password
health 200 {"ok":true,"server_version":"0.0.0","uptime_seconds":32}
login 200
hermes agent {"id":"01M32P61EHZRQ552XF0G9ZCMV4","status":"available","runtime":{"state":"running","url":"http://127.0.0.1:8642","error":null}}
session 201 01M32P70FBYE02XT3MK0D01PY0
run accepted 202 {"job_id":"01M32P70FK9M6V8SJQSRFM8GF5","run_id":"01M32P70FKBZAJKD2E74J9MWX1","message_id":"…","queue_position":null}
run final {"status":"failed","error":{"error":"⚠️ Provider authentication failed: No inference provider
  configured. Run 'hermes model' to choose a provider and model, or set an API key (OPENROUTER_API_KEY,
  OPENAI_API_KEY, etc.) in ~/.hermes/.env.","code":"agent_error"},"usage":null}
messages [{"role":"user","status":"complete","text":"Reply with one word: مرحبا"},
          {"role":"assistant","status":"failed","text":""}]

$ docker exec majlis-slim-smoke hermes doctor            # HERMES_HOME=/data/hermes، exit 0
  ✓ Python 3.12.13 · ✓ Virtual environment active · ✓ Version files consistent (0.21.3)
  ✓ SSL CA certificate bundle is valid · ✓ git · ✓ ripgrep (rg) · ✓ Node.js
  ⚠ Venv entry point not found (hermes not in venv/bin/ or .venv/bin/ …)   # كما في phase0 (يبحث تحت جذر المصدر)
  Found 3 issue(s) to address:  (.env، مفاتيح المزوّد، نقطة الدخول — الثلاثة نفسها في phase0)

$ diff <(hermes doctor على phase0) <(hermes doctor على slim)     # البيت نفسه /tmp/hermes-doctor في الصورتين
96,97c96,97
<   ✓ web search (keenable)
>   ✓ web search (parallel)      # دوران round-robin في Hermes نفسه (config_defaults.py:356)، لا علاقة له بالصورة
# 133 سطرًا في كلتيهما، لا فرق آخر

$ docker exec majlis-slim-smoke hermes config --help      # usage: hermes config {show,edit,get,set,unset,path,env-path,check,migrate}
$ docker exec majlis-slim-smoke hermes model --help       # usage: hermes model [-h] [--refresh] …
$ docker exec majlis-slim-smoke hermes config get model   # (فارغ، exit 0 — لا نموذج مهيّأ)

$ POST /api/v1/agents/01M32P61EHZRQ552XF0G9ZCMV4/restart   {}
agents.restart 202 {"job_id":"01M32PB8DG5MC3FATB90MFG95N"}
job {"status":"succeeded","error":null}
{"msg":"hermes: restart requested","pid":19}
{"msg":"hermes: gateway stopped for restart","code":1}
{"msg":"hermes: gateway started (managed)","pid":220}

$ docker restart majlis-slim-smoke
sessions: ["smoke"]                                        # البيانات بقيت
$ docker exec majlis-slim-smoke stat -c "%a %n" /data/keys/hermes-api.secret
600 /data/keys/hermes-api.secret
```

## المخاطر والرجوع
- **الحجم لم ينزل عن 800 MB بمقياس `docker image ls` الجديد** (924 MB = 712 مفكوك + 212 مضغوط)؛
  نزل عنه بوضوح بالمقياس التقليدي (712 MB مفكوكًا، 212 MB سحبًا). ما بقي كبيرًا هو ما لا يُحذف بلا
  تغيير في السلوك: venv بتبعيات Hermes المعلنة (174 MB)، `git` مع perl (≈95 MB)، وثنائي Node
  (127 MB). خيارات لاحقة **لم تُطبَّق** لأنها تمسّ ثنائيات طرف ثالث أو تحتاج قرار المالك:
  `strip` لثنائي Node (يحمل debug_info؛ قياس: 126.6 → 108.5 MB)؛ `strip --strip-debug` لمكتبات
  العجلات (`libx265` 22.8 MB في pillow-heif وغيرها)؛ بناء git بلا perl من المصدر (≈−75 MB، مع فقدان
  الأوامر الفرعية المكتوبة بـperl مثل `git send-email`).
- **الملفات المحذوفة من نسخة Hermes** لا يشير إليها كود التشغيل، لكن أمرًا لم يُختبر هنا قد يلمس
  ملفًا محذوفًا (مثل `hermes update` أو `hermes desktop` — كلاهما بلا معنى داخل صورة غير قابلة
  للتحديث). الحماية: `hermes --version` و`hermes doctor` كاملان يُنفَّذان بعد التقليم، والأول داخل
  البناء نفسه.
- **`libpython3.12.so` محذوفة**: أي حزمة تُثبَّت لاحقًا كسولًا (`lazy_deps`) وتربط libpython ديناميكيًا
  ستفشل في الاستيراد. عجلات manylinux لا تفعل ذلك بحكم المعيار، وكل ما في venv الآن فُحص بـ`ldd`.
- **اعتماد وقت التشغيل على مرحلة `base`** لثنائي Node: نسخة Node في الصورة = نسخة البناء دائمًا
  (`node:24-bookworm`)، وهذا أدقّ من السابق حيث كان الاثنان وسمين منفصلين.
- **الرجوع**: إعادة `packages/server/Dockerfile` إلى ما قبل هذا الالتزام تعيد الصورة السابقة بلا أي
  أثر على `/data` — لا تغيير في المسارات ولا في التهيئة ولا في قاعدة البيانات.

## التسليم والخطوة التالية
1. مراجعة المالك لهذا الفرع، خصوصًا قوائم الحذف في `Dockerfile` وقرار إبقاء git/perl. لا PR ولا دفع
   بلا طلب.
2. بعد الدمج: بناء صورة `test` عبر `release.yml`/الإجراء المعتاد على `linux/amd64,linux/arm64`؛ فحص
   الحذف الشرطي للـprebuilds على arm64 يجري داخل البناء نفسه (`require('better-sqlite3')`).
3. إن أراد المالك النزول أكثر: قرار صريح في أحد الخيارات الثلاثة أعلاه (strip لـNode، strip لمكتبات
   العجلات، git بلا perl)، كلٌّ في تغيير مستقل بقياس قبل/بعد.
