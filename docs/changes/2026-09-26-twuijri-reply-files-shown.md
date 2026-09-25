# ملفات الرد تظهر عليه: الصورة التي تركها الوكيل تُرسم في المحادثة
المسؤول: twuijri · الفرع: fix/reply-files-shown · الحالة: review

## المشكلة والهدف
على الهب الحي (1.1.0، النموذج `gemini-3.8-flash-high` عبر مزوّد cli-proxy) طلب المالك «سوي صورة قط يطير».
استعمل الدور ثلاث أدوات (`tool_describe` · `image_generate` · `execute_code`)، وقال الرد إن الصورة حُفظت وطبع
مسارها الكامل `/data/workspaces/default/<…>/.corehub/runs/<run>/out/flying_cat.png`، **ولم تظهر أي صورة**
(«ما فتحلي الصورة»). وفي تجربة سابقة على هب آخر ربط الرد `majlis/runs/<id>/out/test.txt` والمسار المطلق: المسارات
الداخلية تتسرّب إلى الرد.

الهدف: كل ملف جديد يكتبه الوكيل في مجلد مخرجات الدور يُرفق بالرد؛ الصور تُرسم فيه، وغيرها رقاقة باسمه تفتح
المعاينة الموجودة؛ ولا مسار داخلي ظاهر في الرد. وقائمة الملفات والتطبيقات على الهاتف تُظهر المرفقات نفسها.

## القرار والموافقات
**السبب الجذري: الويب لم يرسم مرفقات ردود الوكيل أصلًا.** في `packages/web/src/chat/MessageView.tsx` كان
`<Attachments>` يُرسم في فرع رسالة الشخص فقط؛ فرع رد الوكيل يرسم الأدوات والتفكير والنص ولا شيء غيرها — منذ أول
شاشة محادثة (`458eab74`). الخادم كان يعمل: أعدتُ إنتاج دور المالك بهرمز الحقيقي في Docker (الفقرة «الفحوص»)
فوجدت الرد على الكود القديم يحمل **صورتين** (`corehub_…png` التي نسخها الهب من ذاكرة هرمز حسب §72،
و`flying_cat.png` التي كتبها `execute_code`)، وقائمة ملفات المحادثة تذكرهما؛ لكن الواجهة لا تعرضهما.
تحقّقت من كل ما في المهمة:
- **الجامع يلتقط ما تكتبه الأدوات الأخرى:** نعم؛ `collectOutputs` يقرأ المجلد كله عند نهاية الدور (لا ما نسخه وحده).
- **التوقيت:** الجمع في `finalise` بعد انتهاء البث، أي بعد آخر أداة. سليم.
- **رقم الدور:** الموجّه يسمّي مجلد الدور نفسه؛ في الإعادة وُجد الملف تحت رقم الدور الصحيح.
- **المجلد المخفي `.corehub/`:** لا يُستبعد في الجمع.
- **مسار الصورة مع نموذج صور محادثة (cli-proxy):** هرمز يحفظ في `cache/images/` كالعادة ونسخة §72 تعمل
  (`prove-images.sh` يمر على الصورة الجديدة).
- **الهاتف:** iOS (`MessageAttachments` في `agentCard`) وAndroid (`Attachments` في `AgentMessage`) يعرضان
  أسماء مرفقات الرد أصلًا؛ لا رسم للصورة داخل الرد عليهما (انظر المخاطر).

**الإصلاح:**
1. **الويب يرسم ملفات الرد** (الشخص والوكيل معًا): الصورة تُرسم في الرسالة — تُجلب بايتاتها بترويسة الحامل ثم
   `URL.createObjectURL`، لأن العقد يمنع الرمز في الرابط فلا يصلح `<img src>` مباشر — وتفتح بجانب المحادثة
   (§48). أي ملف آخر رقاقة باسمه تفتح المعاينة نفسها. حتى تصل البايتات، أو إن تعذّرت، تبقى الصورة اسمًا كأي ملف.
2. **صورة واحدة لا اثنتان:** عند نهاية الدور يحذف المشغّل (`runner.ts`، `dropDuplicateHandOvers`) **نسخته هو**
   من صورة §72 إذا ترك الوكيل البايتات نفسها في المجلد باسم من عنده. لا يحذف إلا ما نسخه، ولا إلا لملف مطابق
   بايتًا ببايت؛ وما لا يُقرأ يبقى.
3. **لا مسارات داخلية — (a) و(b) معًا (مقترح — للمالك أن يؤكّد):**
   - (a) سطر مجلد المخرجات في الموجّه يطلب من الوكيل أن يذكر الملف باسمه فقط، لا بهذا المجلد ولا بأي مسار على
     الجهاز. يصل كل العملاء لأنه يغيّر كلام النموذج نفسه، لكنه طلب قد يتجاهله نموذج.
   - (b) الويب يرسم مسار مجلد الدور في كلام الرد (`<…>/.corehub/runs/<run>/<in|out>/<ملف>`، وكذلك
     `majlis/runs/…` القديم، في النص والرموز المضمّنة والروابط، خارج كتل الشيفرة) على أنه `<ملف>`، فتحوّله إشارات
     الملفات الموجودة إلى رابط يفتحه. الكلام المخزَّن لا يتغيّر (النسخ ينسخ كلام الوكيل كما هو). وحين يتكرر الاسم في
     المحادثة يُقصد الملف الذي يحمله هذا الرد.
   - لماذا لا نعيد كتابة نص الرد على الخادم: تغيير كلام النموذج المخزَّن خطر (قد يكسر شيفرة أو اقتباسًا)، و(b)
     عرض فقط يمكن الرجوع عنه. ولماذا ليس (a) وحده: نموذج المالك نفسه قد لا يطيع. مسارات مساحة العمل العامة
     (`/data/workspaces/…/report.html` خارج مجلد الدور) تبقى لآلية §48 الموجودة (تربط الاسم) مع (a).
- سطر في DECISIONS §72 «…and is seen there» وفقرة «Proposed» فيه. لا رقم جديد: جزء من القرار نفسه.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. الصورة جزء `image` موجود في `Message.content`، والملفات الأخرى `file`.

## الملفات والتأثير
- الويب: `src/chat/MessageView.tsx` (`Attachments` على ردود الوكيل أيضًا، `InlineImage`، `hideRunPaths`،
  `own`)، `src/chat/Markdown.tsx` (`own`: الاسم يعني ملف الرد نفسه، `fileForWord`)، `src/files/run-paths.ts`
  (جديد)، `src/styles/chat.css` (`.msg-image`، خصائص منطقية)، `tests/reply-files.test.tsx` (جديد)،
  `e2e/zzzzzzzzz-reply-files.spec.ts` (رحلة 35، جديدة) و`e2e/hub.ts` (خطوة `produce` تكتب في مجلد مخرجات الدور،
  ونص «قط يطير»)، `e2e/shots/35-reply-picture.png`.
- الخادم: `src/modules/agents/runner.ts` (`dropDuplicateHandOvers`، `LiveRun.handedOver`، سطر الموجّه)،
  `runner.test.ts` (ثلاثة اختبارات)، `tests/container/fake-provider.mjs` (وضع `--script images-copy`: نموذج
  يستدعي `image_generate` ثم `execute_code` ينسخ الصورة إلى `out/flying_cat.png` ثم يرد بالمسار — أو بالاسم إن
  طلب الموجّه ذلك)، `tests/container/prove-reply-files.sh` (جديد، هرمز حقيقي).
- التوثيق: `docs/STATUS.md` (سطر الويب وسطر النماذج)، `docs/contracts/DECISIONS.md` §72.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run` في `corehub-wt-replyfiles`.

**إعادة إنتاج دور المالك بهرمز الحقيقي** — صورة من `origin/main` (`docker build -f packages/server/Dockerfile -t
core-hub:replyfiles-old .`)، ثم `packages/server/tests/container/prove-reply-files.sh core-hub:replyfiles-old`
(حاويتان وشبكة خاصة تُحذف عند الخروج، مفتاح مزيّف، الموافقة على `execute_code` كما فعل المالك):
```
assistant: [{"type":"text","text":"\n\nI generated the image and saved it to: /data/workspaces/default/01M3D3WF026C1MW50829SHHRVH/.corehub/runs/01M3D3WF15NG8JKWM5NK4R3XB7/out/flying_cat.png"},{"type":"image",...,"name":"corehub_20260925_202514_d33a55b5.png",...},{"type":"image",...,"name":"flying_cat.png",...}]
PASS  the run succeeded
PASS  flying_cat.png, which execute_code wrote, is on the reply as an image
FAIL  the picture is on the reply once, not also as the copy the hub made
FAIL  the hub told the model to name its files, not their path
FAIL  the reply names no internal path
PASS  the Files panel lists flying_cat.png
   told to name files= false
SOME CHECKS FAILED
```
بعد الإصلاح (`core-hub:replyfiles` من هذا الفرع):
```
approving 01M3D402BYBRMQSQRJMFJ4RV2G: execute_code script execution. ...
{"status":"succeeded","error":null}
assistant: [{"type":"text","text":"\n\nI generated the image and saved it as flying_cat.png."},{"type":"image","attachment_id":"01M3D404E05EGDX0D77VGJW0YE","url":"/api/v1/attachments/01M3D404E05EGDX0D77VGJW0YE/content","name":"flying_cat.png","mime":"image/png","size_bytes":107}]
image_generate succeeded -> {"success":true,"image":"/data/hermes/cache/images/corehub_20260925_202704_ebc5c322.png","model":"gemini-3.1-flash-image",...}
execute_code succeeded -> {"status":"success","output":"saved /data/workspaces/default/01M3D3ZT5ETNY7N98B7V8Z7GQF/.corehub/runs/01M3D3ZT6DV2DQC4222XVC9NXS/out/flying_cat.png 107\n",...}
-- the session files --
flying_cat.png image/png 107B sources=attachment
PASS  the run succeeded
PASS  flying_cat.png, which execute_code wrote, is on the reply as an image
PASS  the picture is on the reply once, not also as the copy the hub made
PASS  the hub told the model to name its files, not their path
PASS  the reply names no internal path
PASS  the Files panel lists flying_cat.png
   told to name files= true
ALL CHECKS PASSED
```
و`prove-images.sh core-hub:replyfiles` (لا تراجع في §72): `ALL CHECKS PASSED` (12 PASS). لا حاويات متبقية.

**اختبارات الخادم الجديدة تفشل على الكود القديم** (`runner.ts` من `origin/main`):
```
     × keeps one picture when the agent copies the drawn one into the folder under its own name 8ms
     × removes only its own copy, only for identical bytes, and looks into sub-folders 0ms
     × tells the agent to name its files, not their path 2ms
AssertionError: expected [ 'corehub_20260926_1.png', …(1) ] to deeply equal [ 'flying_cat.png' ]
      Tests  3 failed | 30 skipped (33)
```
وبعد: `pnpm exec vitest run src/modules/agents/runner.test.ts` → `Tests  33 passed (33)`.

**اختبار الويب الجديد يفشل على الكود القديم** (`MessageView.tsx` و`Markdown.tsx` من `origin/main`):
```
     × draws its picture, fetched with the bearer header, and opens it beside the chat 1048ms
     × shows any other file as its name, which opens the same preview 1012ms
     × means its own file by a name an older file of the conversation also has 1015ms
      Tests  3 failed | 2 passed (5)
```
وبعد، مع ملفات الويب التي تمسّ `MessageView`/`Markdown`:
```
pnpm exec vitest run tests/reply-files.test.tsx tests/file-preview.test.tsx tests/message-layout.test.tsx tests/run-failure-notice.test.tsx tests/run-changes.test.tsx tests/tool-calls.test.tsx tests/model-fallback-signin.test.tsx tests/search-jump.test.tsx tests/logical-css.test.ts
 Test Files  9 passed (9)
      Tests  359 passed (359)
```
**رحلة المتصفح 35** (`pnpm build` → exit 0، ثم `PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test
e2e/zzzzzzzzz-reply-files.spec.ts`): الصورة مرسومة في الرد (`naturalWidth` 48)، الكلام يقول `flying_cat.png`
رابطًا ولا `.corehub` ولا `/data/`، الضغط يفتحها بجانب المحادثة، و«الملفات (1)»:
```
  ✓  1 [chromium] › e2e/zzzzzzzzz-reply-files.spec.ts:28:1 › 35. the picture an agent left for the person is drawn on its reply (1.4s)
  1 passed (8.9s)
```
**بقية الفحوص:** `pnpm lint` → `All matched files use Prettier code style!`؛ `pnpm typecheck` → exit 0 (0 أخطاء)؛
`pnpm i18n:check` → `i18n:check  OK` (لا نصوص جديدة: `files.open` موجود). الأجنحة الكاملة على CI.

## المخاطر والرجوع
- **الهاتف:** iOS وAndroid يعرضان اسم مرفق الرد لا الصورة نفسها، ولا يخفيان مسار مجلد الدور في الكلام؛ (a) يخفّف
  الثاني. رسم الصورة على الهاتف يحتاج جلبًا بالحامل في Swift/Kotlin — مهمة منفصلة.
- (a) طلب لا ضمان: نموذج قد يكتب المسار رغمه؛ (b) يغطي الويب حينها. مسار مساحة عمل خارج مجلد الدور يبقى ظاهرًا
  إلا اسمه المربوط.
- حذف النسخة المكررة يقرأ الملفين المتساويين حجمًا فقط (≤ 25 م.ب للنسخة)؛ ملف لا يُقرأ يُبقي النسخة.
- الرجوع: عكس هذا الفرع؛ لا ترحيل ولا تغيير عقد.

## التسليم والخطوة التالية
PR واحد إلى `main` بالإنجليزية بعد أن يخضرّ CI. للمالك: تأكيد القرارين المقترحين، وتجربة الطلب نفسه على صورة
الاختبار. بعده: رسم الصورة داخل الرد على iOS وAndroid.
