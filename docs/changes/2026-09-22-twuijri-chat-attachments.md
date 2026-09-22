# الملفات في محادثة المجلس: تخزينها، وصولها إلى الوكيل، وعودتها منه

المسؤول: twuijri · الفرع: feat/chat-attachments · الحالة: review

## المشكلة والهدف

محادثة Hermes كانت تعمل نصًّا فقط. النصف الناقص هو الملفات: المستخدم يرسل ملفًا،
الوكيل يقرؤه، الوكيل يعيد ملفًا، المستخدم ينزّله. في `main` كانت عمليات المرفقات
الثماني في العقد تُجيب `501`، ولا توجد بايتات مخزّنة أصلًا، و`promptText` في المشغّل
كان يكتب `[attachment file <id>]` — نصٌّ لا يستطيع أي وكيل أن يفعل به شيئًا.

الهدف: مسار كامل وحقيقي — رفع، تخزين، تمرير إلى الوكيل، التقاط ما ينتجه، تنزيل —
بالحدود والأخطاء التي يعلنها العقد، مع طبقة بيانات جاهزة للعملاء **دون لمس شكل
شاشة المحادثة** (فرع `feat/chat-design-pass` يعيد بناءها الآن بالتوازي).

## القرار والموافقات

- **الغرفة النظيفة (ADR 0004 بتعديل ADR 0012)**: لم يُفتح أي مصدر من Hermes Studio /
  Ekko Studio ولا نسخة المالك منه. ما قُرئ خارج هذا المستودع: مصدر Hermes Agent (MIT)
  **داخل صورة المركز** (`/opt/hermes/src`) — تحديدًا `gateway/platforms/api_server_runs.py`
  (معالج `POST /v1/runs`) و`tools/file_tools_paths.py` (كيف تُحلّ المسارات في أدوات
  الملفات). لم يُنسَخ كود.
- **الحقيقة المقرّرة من ذلك المصدر**: سطح `POST /v1/runs` يقبل حقل `input` نصيًّا واحدًا
  ولا يملك أي قناة مرفقات ولا حقل `cwd`؛ وأدوات ملفات Hermes تقبل **مسارًا مطلقًا** كما
  هو (`_resolve_path_for_task`: المسار المطلق يُعاد محلولًا بلا تثبيت على جذر). لذلك
  القرار: **المركز يكتب البايتات في مجلد عمل الجلسة ويسمّي المسار في النص**. هذا ليس حلًّا
  التفافيًّا بل الطريق الوحيد الذي يدعمه هذا السطح فعلًا، وقد أُثبت بتشغيل حقيقي (أدناه).
- **`knowledge` يملك البايتات** كما تقول `docs/domain/knowledge.md` §attachment و
  `DECISIONS.md` §15، رغم أن العقد يعلن العمليات الثماني تحت وسم `sessions`. الوسم يحدّد
  العميل، لا مالك البيانات. `sessions` يحمل المعرّفات فقط، ويسأل `knowledge` عبر منفذ.
- **مجلدان لكل دور** تحت مجلد عمل الجلسة:
  `…/.majlis/runs/<run id>/in` و`…/out`. «لكل دور» لأنه الشيء الوحيد الذي يجعل سؤال
  «ماذا أنتج هذا الدور؟» قابلًا للإجابة بلا مسح الشجرة كلها؛ و«مخفي» كي يبقى مجلد عمل
  هو أيضًا مستودع git صالحًا للقراءة.
- **اعتماد جديد**: `@fastify/multipart@10.1.1` (ملحق Fastify الرسمي، MIT). البديل كان
  كتابة محلّل multipart متدفّق بأيدينا؛ رُفض: الملحق يفرض حدود الأجزاء والحجم وهو
  المسار المختبَر لهذه المخاطر بالذات. لا كود منسوخ، فلا حاجة لإدخال في
  `THIRD-PARTY-NOTICES.md` (اعتماد npm لا نسخة مصدر).
- لم يُدفَع الفرع، ولم يُفتح PR، ولم يُنشر شيء.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

**لا شيء في `openapi.yaml`.** العمليات الثماني معلنة أصلًا وبقيت كما هي:

| العملية | المسار | ما صارت تفعله |
|---|---|---|
| `sessions.uploadAttachment` | `POST /attachments` | multipart متدفّق، ≤ 25 م.ب، يعيد `Attachment` |
| `sessions.getAttachment` | `GET /attachments/{id}` | البيانات الوصفية |
| `sessions.deleteAttachment` | `DELETE /attachments/{id}` | 204، و**409** إن كانت رسالة تشير إليه |
| `sessions.downloadAttachment` | `GET /attachments/{id}/content` | بث، و`Range` → 206 |
| `sessions.startUpload` | `POST /attachment-uploads` | ≤ 50 م.ب، قطع 256 ك.ب |
| `sessions.uploadChunk` | `PUT /attachment-uploads/{id}?offset=` | 409 مع `expected_offset` عند إزاحة خاطئة |
| `sessions.abortUpload` | `DELETE /attachment-uploads/{id}` | 204 |
| `sessions.completeUpload` | `POST /attachment-uploads/{id}/complete` | 409 إن نقصت بايتات، وإلا `Attachment` |

تغيّر واحد في **مكتبة العميل المولَّدة** (`packages/contracts/src/client.ts`)، لا في
الوثيقة: `body` يقبل الآن `Blob | ArrayBuffer` فيمرّ كما هو بدل `JSON.stringify`
(قطع الرفع المستأنف)، و`responseKind: 'bytes'` يقرأ الجسم بايتات لا نصًّا (التنزيل).
بدونهما كان كل ملف ثنائي يعود تالفًا عبر العميل.

## الملفات والتأثير

### `packages/server/src/modules/knowledge/` (السجل: البايتات والحدود)
- `limits.ts` — أرقام العقد في مكان واحد (25/50 م.ب، 256 ك.ب، 5 دقائق خمول، 255 حرفًا).
- `media.ts` — `sanitiseFilename` (الاسم الأساس فقط: `../../etc/passwd` → `passwd`، لا
  NUL ولا محارف تحكّم ولا نقطة بادئة ولا أسماء ويندوز المحجوزة، بحدّ 255)، و`sniffMime`
  (24 توقيعًا بايتيًّا ثم الامتداد للنصوص ثم `application/octet-stream`)،
  و`contentDispositionOf` (دائمًا `attachment`، والاسم العربي بصيغة RFC 5987).
- `blobs.ts` — `BlobStore`: كتابة متدفّقة عبر تجزئة إلى ملف مؤقت ثم `rename` إلى
  `${DATA_DIR}/attachments/<workspace>/<aa>/<sha256>`، قراءة متدفّقة مع نطاق، `parseRange`.
- `store.ts` — استعلامات `attachments`، كلها مقيّدة بـ`workspace`.
- `uploads.ts` — سجلّ الرفع المستأنف في الذاكرة (لا جدول: نصف ملف لا قيمة له بعد
  إعادة تشغيل، و`404` هي إحدى الحالات الموثّقة).
- `service.ts` — حالات الاستخدام، و`capture` (ملف أنتجه وكيل) و`materialise`.
- `serialize.ts` — الصف → `Attachment`، وشكل رابط التنزيل الوحيد.
- `index.ts` — تركيب الملحق `@fastify/multipart` وقارئ `application/octet-stream`،
  والمسارات الثمانية عبر `defineRoute`، ومنفذ `attachmentsPort`.
- `schema.ts` — `AttachmentMeta` كسبت `purpose` و`producedPath` (json، **بلا ترحيل**).

### `packages/server/src/modules/sessions/`
- `run-files.ts` (جديد) — مجلدا الدور، و`OutputWatcher` (مراقبة `fs.watch` لمجلد واحد)،
  و`collectOutputs` بالسقوف (20 ملفًا، 25 م.ب للملف، 100 م.ب مجموعًا، عمق 3، وتخطّي
  الروابط الرمزية).
- `ports.ts` — `AttachmentsPort` و`AgentFileExchange`، و`AgentPromptBlock` كسبت
  `name/mime/sizeBytes/path`.
- `engine.ts` — `prepareFiles` قبل `runner.start` (نسخ المرفقات، إنشاء `out`، بناء
  النص)، و`collectProduced` في `finalise` (التقاط ما كُتب، أجزاء الرسالة و
  `attachment_ids`، وسطر صريح بما رفضته السقوف).
- `service.ts` — رفض `404` قبل كتابة الرسالة إن كان معرّف مرفق لا يوجد؛ وتمرير
  البيانات الوصفية إلى المحوّل.
- `mappers.ts` — `ContentBlock` صار يحمل `name` و`mime` و`size_bytes` كما يعلن العقد.
- `store.ts` — `isAttachmentReferenced`. `index.ts` — منفذ جديد + `attachmentReferences`.
- `unavailable.ts` — `noAttachments`: الافتراضي الصادق (لا شيء يُحلّ، ولا بايت يُكتب).
- `testing/fake-runner.ts` — خطّاف `onStart` كي يتصرّف الوكيل المكتوب بالسيناريو كوكيل.

### `packages/server/src/modules/agents/`
- `runner.ts` — `promptText` صار يكتب قائمة الملفات بمساراتها المطلقة وسطر مجلد المخرجات.
- `ports.ts` — `RunnerFileExchange` وحقول المرفق.

### `packages/server/src/lib/contract.ts`
`bodyRequired` صار يشترط وجود مخطّط `application/json`. بدون ذلك كان كل جسم
multipart / octet-stream يُرفض بـ`400` قبل أن يصل إلى معالجه — خللٌ كان سيظهر مع أول
عملية غير JSON في العقد (وهي هذه).

### العملاء
- `packages/web/src/attachments/queries.ts` (جديد) — **طبقة البيانات فقط**. ما يستدعيه
  المؤلِّف (composer) مذكور في رأس الملف كجدول:
  - `useUploadAttachment().upload({ file, onProgress, signal })` — رفع مع تقدّم وإلغاء،
    ينتقل تلقائيًّا إلى المسار المستأنف فوق 25 م.ب، و`resumeId`/`resumeOffset` للاستئناف.
  - `useDeleteAttachment().mutate(id)` · `useAttachment(id)`
  - `useDownloadAttachment().save(block)` و`.blob(block)` — الرمز في الترويسة، لذا
    `<a href>` وحده لا يكفي.
  - `blocksFor(text, uploaded)` — كتل `sessions.createRun`.
  - `attachmentsOf(message.content)` — مرفقات رسالة، بأسمائها وأحجامها ورابطها.
  - لا استعلام «قائمة مرفقات»: العقد لا يعلن عملية كهذه، وكتل الرسالة هي المصدر.
- `packages/web/src/chat/Composer.tsx` — **بلا أي تغيير في البنية أو الأنماط**: استُبدل
  نداء `client.raw('post','/attachments')` الداخلي بالخطّاف المشترك، وأضيف حقلا
  `progress` و`cancel` إلى صفّ `Pending`. المعلّم (markup) وأصنافه كما هي حرفيًّا.
- `packages/cli/src/commands/files.ts` (جديد) — `files upload|show|download|delete`،
  و`uploadFile` مشتركة مع `chat --attach FILE` (قابل للتكرار).
- `packages/cli/src/args.ts` — خيارات قابلة للتكرار (`multiple`).

### الوثائق
`docs/domain/knowledge.md` (ما يفرضه المتجر فعلًا، والمجلدان)، `docs/domain/sessions.md`
(§الملفات في الدور)، `docs/STATUS.md` (89 → 97 عملية).

## الفحوص (الأوامر ونواتجها الفعلية)

`node v24.21.0` / `pnpm 12.5.1`، worktree نظيف من `origin/main` (`2f62d38`).

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!
[exit 0]

$ pnpm typecheck                     # contracts + server + cli + web + ui-tokens
[exit 0]

$ pnpm i18n:check
i18n:check  server: 98 keys, ar/en in parity
i18n:check  cli: 249 keys, ar/en in parity
i18n:check  web: 361 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web

$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm contracts:check-clients
check-clients  OK — 133 client file(s) scanned, 165 contract path(s) known.

$ pnpm test
 Test Files  3 passed (3)                 # @majlis/contracts   11 tests
 Test Files  1 passed (1)                 # @majlis/ui-tokens   95 tests
 Test Files  11 passed (11)               # @majlis/cli         63 tests
 Test Files  41 passed | 1 skipped (42)   # @majlis/server     359 passed, 2 skipped
 Test Files  18 passed (18)               # @majlis/web        208 tests

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  253 passed (253)

$ pnpm build
✓ built in 744ms
$ node packages/cli/dist/bin.js --help
  …
  files upload       Upload a file and print its attachment id
  files show         Show one attachment
  files download     Download an attachment to a file (or `-` for stdout)
  files delete       Delete an attachment no message references yet

$ MAJLIS_E2E_PORT=8891 MAJLIS_E2E_SETUP_PORT=8892 PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  7 passed (25.4s)
```

(المنفذان غير الافتراضيين لأن `8791` مشغول على هذا الجهاز بعملية `e2e/hub.ts` أخرى ليست
لي؛ لم تُقتَل.)

`pnpm db:generate` غير مطلوب: لا جدول جديد ولا عمود جديد — `attachments` موجود في
`0000_loving_doorman.sql`، و`purpose`/`producedPath` داخل عمود `meta` من نوع json.

### الاختبارات الجديدة

| الملف | ماذا يثبت |
|---|---|
| `knowledge/attachments.test.ts` (37 حالة) | تعقيم الاسم (12 حالة جدولية)، شمّ النوع من البايتات (exe يدّعي PNG)، الرفض بـ`payload_too_large` مع `details.max_bytes` ولا ملف مؤقت متروك، إزالة التكرار، عزل مساحات العمل، الرفض 409 والحذف، التقاط ملف الوكيل، الرفع المستأنف وأخطاؤه، تحليل `Range` |
| `knowledge/attachments-api.test.ts` (10 حالات) | العمليات الثماني عبر HTTP موقَّعًا، الأجسام مطابقة لمخطّطات العقد (`Attachment`, `Upload`)، ونجاح + رفض واحد على الأقل لكل عملية |
| `sessions/run-files.test.ts` (7 حالات) | مرفق المستخدم يصل إلى `in/` ويُسمّى مساره في `prompt`؛ `404` قبل كتابة الرسالة لمعرّف مجهول؛ `409` لحذف ملف تستعمله رسالة؛ ملفات `out/` تصير مرفقات على الرد وتُنزَّل بالرابط المعلن؛ السقوف الأربعة |
| `cli/tests/integration/cli.test.ts` (+2) | `files upload/show/download/delete` ضد خادم حقيقي بايتًا ببايت، و`chat --attach` يسلّم الوكيل مسارًا يفتحه |
| `web/tests/attachments.test.tsx` (7 حالات) | الكتل المرسلة والمقروءة، والرفع: التقدّم، الإلغاء (`AbortError`)، ظرف الخطأ كـ`HubApiError`، والرفض قبل إرسال بايت |

## الدليل الحقيقي: الصورة تُبنى، وتُشغَّل، وتتبادل الملفات

بُنيت الصورة من `packages/server/Dockerfile` (`DOCKER_BUILDKIT=0`, `999MB`) ثم شُغّلت
بمخزن بيانات نظيف. Hermes الحقيقي داخل الصورة يرفض العمل بلا مفتاح مزوّد، فبوابة
**مكتوبة بالسيناريو** على `127.0.0.1:8642` أخذت مكانه (وضع `external` في ADR 0008): هي
تنفّذ نفس السطح (`/health`, `POST /v1/runs`, `GET /v1/runs/{id}/events` بـSSE)، وتتصرّف
كوكيل يستعمل الملفات — تقرأ المسار من النص وتكتب في مجلد المخرجات. **كل ما عداها حقيقي**:
الصورة، المركز، المصادقة، الرفع multipart، متجر البايتات، محرّك الدور، محوّل Hermes،
والتنزيل. النموذج وحده مكتوب بالسيناريو لأن مفتاح المزوّد ليس بحوزتي.

```
$ docker run -d --name majlis-attach -p 127.0.0.1:18090:8080 \
    -e HUB_ADMIN_PASSWORD=… -v majlis-attach-data:/data -v <proof>:/opt/proof:ro \
    --entrypoint sh majlis:attachments -c 'node /opt/proof/hermes-stub.mjs & exec node packages/server/dist/main.js'

# سجل المركز:
[stub] hermes gateway on 127.0.0.1:8642
{"endpoint":"http://127.0.0.1:8642","msg":"hermes: using the gateway already running"}
{"mode":"external","endpoint":"http://127.0.0.1:8642","msg":"agents: hermes runtime"}
{"modules":[…13…],"stubs":150,"database":"sqlite","dataDir":"/data","web":true,"msg":"core hub listening"}
```

`stubs` صارت 150 بعد أن كانت 158: العمليات الثماني لم تعد جذوعًا.

```
$ node proof.mjs http://127.0.0.1:18090 …
health 200 {"ok":true,"server_version":"0.0.0","uptime_seconds":8}
login 200
hermes agent {"status":"available","runtime":{"state":"running","url":"http://127.0.0.1:8642","error":null}}

# 1) رفع باسم عدائي (`../../order.csv`) ونوع مكذوب:
upload 201 {"id":"01M348ZSYV4AA79YJ87BHGRW33","name":"order.csv","mime":"text/csv; charset=utf-8",
            "size_bytes":19,"kind":"file","url":"/api/v1/attachments/01M348ZSYV4AA79YJ87BHGRW33/content",
            "purpose":"message","sha256":"bbadf0b1fd46e8d88f949822b0399a5bb5bef9f7cc57ed3e72456723ee9d9cca"}

# 2) جلسة ودور يحمل الملف:
session 201 01M348ZSZ7G11V8N3AR0WAYZNG working_dir /data/workspaces/default/01M348ZSZ7G11V8N3AR0WAYZNG
run accepted 202 {"job_id":"…","run_id":"01M348ZSZKY9K5QDT87FTG4A41","message_id":"…","queue_position":null}
run job succeeded
run {"status":"succeeded","error":null,"usage":{"input_tokens":11,"output_tokens":7,"cost":null}}
```

ما وصل البوابة فعلًا (من سجل البوابة المكتوبة بالسيناريو):

```
[stub] input:
read the attached file and write a summary

Attached files (read them from these paths):
- order.csv (text/csv; charset=utf-8, 19 bytes) — /data/workspaces/default/01M348ZSZ7G11V8N3AR0WAYZNG/.majlis/runs/01M348ZSZKY9K5QDT87FTG4A41/in/order.csv

Write any file the user should be able to download into: /data/workspaces/default/01M348ZSZ7G11V8N3AR0WAYZNG/.majlis/runs/01M348ZSZKY9K5QDT87FTG4A41/out
Files left there when the turn ends are attached to your reply automatically.
```

والنسخة على القرص داخل الحاوية:

```
$ docker exec majlis-attach find /data/workspaces -type f -o -type d | sort
/data/workspaces/default/01M348ZSZ7G11V8N3AR0WAYZNG/.majlis/runs/01M348ZSZKY9K5QDT87FTG4A41/in
/data/workspaces/default/01M348ZSZ7G11V8N3AR0WAYZNG/.majlis/runs/01M348ZSZKY9K5QDT87FTG4A41/in/order.csv
/data/workspaces/default/01M348ZSZ7G11V8N3AR0WAYZNG/.majlis/runs/01M348ZSZKY9K5QDT87FTG4A41/out
/data/workspaces/default/01M348ZSZ7G11V8N3AR0WAYZNG/.majlis/runs/01M348ZSZKY9K5QDT87FTG4A41/out/summary.md
```

ثم النسخة كما يراها العميل — الرد يحمل الملف الذي أنتجه الوكيل:

```
message {"role":"user","status":"complete","content":[
  {"type":"text","text":"read the attached file and write a summary"},
  {"type":"file","name":"order.csv","mime":"text/csv; charset=utf-8","size_bytes":19,
   "url":"/api/v1/attachments/01M348ZSYV4AA79YJ87BHGRW33/content"}]}
message {"role":"assistant","status":"complete","content":[
  {"type":"text","text":"read order.csv: 3 line(s), 19 bytes\nfirst line: id,total\nwrote summary.md"},
  {"type":"file","name":"summary.md","mime":"text/markdown; charset=utf-8","size_bytes":50,
   "url":"/api/v1/attachments/01M348ZT08SG0EKR9BXKWMP7SN/content"}]}

download 200 {"content-type":"text/markdown; charset=utf-8",
              "content-disposition":"attachment; filename=\"summary.md\"; filename*=UTF-8''summary.md",
              "content-length":"50"}
--- produced file ---
# summary

source: order.csv
lines: 3
sha-ish: 19

range 206 "bytes 0-8/50" "# summary"
delete a file a message uses 409 {"error":"A message already points at this file, so it cannot be deleted.",
                                  "code":"conflict","details":{"attachment_id":"…","reason":"referenced_by_message"}}
delete an unused file 204

# الرفع المستأنف عبر نفس الواجهة:
upload start 201 {"id":"…","size_bytes":614400,"chunk_bytes":262144,"next_offset":0,"expires_at":"…"}
chunk 200 next_offset 262144 → 524288 → 614400
upload complete 201 {"size_bytes":614400,"sha256":"2e43196f0b263f8ad3a912056cc166a1a44d49baabca1e17b21034bd6202345f"}
resumable bytes match true
```

وبعد إعادة تشغيل الحاوية، البيانات باقية:

```
$ docker restart majlis-attach
session after restart 01M348ZSZ7G11V8N3AR0WAYZNG
produced file still on the reply: {"name":"summary.md","url":"/api/v1/attachments/01M348ZT08SG0EKR9BXKWMP7SN/content"}
bytes after restart: # summary | source: order.csv | lines: 3 | sh…
```

### ما لم يُثبَت هنا

- **دور بردّ نموذج حقيقي يقرأ ملفًا**: يحتاج مفتاح مزوّد على جهاز المالك. البوابة
  المكتوبة بالسيناريو تثبت الأنابيب كلها، لا فهم النموذج للتعليمات. الخطوة عند المالك:
  ضبط مزوّد ثم إرسال ملف وسؤال عنه.
- **وكيل ACP** (Claude Code وغيره): يستلم نفس `files` في `RunnerRunRequest` لكن محوّل
  ACP لم يُعدَّل ليستعمله بعد؛ يعمل اليوم لأن `cwd` هو مجلد عمل الجلسة نفسه، والملفات
  تحت `.majlis/runs/<run>/in` قابلة للقراءة، لكن لا سطر يخبره بها. تُضاف مع أول مهمة
  تمسّ محوّل ACP.
- **الصوت والتفريغ**: خارج النطاق صراحةً. `models.transcribe` ما يزال `501` — لكنه صار
  ممكنًا الآن بعد وصل قارئ multipart، وهذا مذكور في تعليق وحدة `models`.

## المخاطر والرجوع

- **الوكيل قد يتجاهل مجلد المخرجات** ويكتب في جذر مجلد العمل؛ عندها لا يظهر الملف في
  الرد (لكنه موجود على القرص). عمدًا: مسح الشجرة على كل دور هو ما رفضته المهمة.
- **سطر المخرجات يُضاف إلى كل دور** ولو بلا مرفقات، لأن «اصنع لي CSV» يجب أن ينزَّل بلا
  رفع مسبق. ثمنه سطران في كل نص. الرجوع: شرط واحد في `engine.prepareFiles`.
- **`.majlis/` يتراكم** داخل مجلد العمل: مجلد لكل دور. لا تنظيف تلقائي بعد؛ `expires_at`
  موجود في الجدول ولم يُستعمل لهذه المجلدات. المهمة التالية.
- **الرفع المستأنف في الذاكرة**: إعادة تشغيل المركز تُنسي الرفعات المفتوحة (404 موثّقة)،
  وملفاتها المؤقتة تُحذف في `onClose` — لا في انهيار مفاجئ، فتبقى تحت
  `attachments/<workspace>/.tmp` حتى تنظيف لاحق.
- **`fs.watch` قد لا يعمل** على بعض أنظمة الملفات؛ لذلك الجواب يأتي دائمًا من `readdir`
  واحد في نهاية الدور، والمراقب تلميح فقط.
- **الاعتماد الجديد** `@fastify/multipart`: الرجوع بإزالته يعيد `sessions.uploadAttachment`
  وحدها إلى 501؛ باقي السبع لا تحتاجه.
- **الرجوع الكامل**: حذف سطر `attachments: attachmentsPort` في `src/modules/index.ts`
  يعيد المنفذ إلى `noAttachments` (لا ملفات، بلا كذب)، وحذف مسارات `knowledge/index.ts`
  يعيد الثماني إلى جذوع 501. لا ترحيل قاعدة بيانات للتراجع عنه.

## التسليم والخطوة التالية

1. مراجعة المالك. لا دفع ولا PR بلا طلب صريح.
2. عند دمجه: فرع `feat/chat-design-pass` يستدعي `packages/web/src/attachments/queries.ts`
   كما هو موصوف في رأس الملف؛ لا يحتاج تغييرًا في الخادم.
3. بعدها، بالترتيب: تنظيف مجلدات `.majlis/runs` القديمة، سطر المرفقات في محوّل ACP، ثم
   `models.transcribe` (صار ممكنًا: قارئ multipart موصول).
