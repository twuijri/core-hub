# اختبار الإملاء الصوتي المتقلّب، ونموذج الصور في دور هرمز حقيقي
المسؤول: twuijri · الفرع: fix/voice-test-and-image-e2e · الحالة: review

## المشكلة والهدف
1. **اختبار متقلّب:** `packages/web/tests/voice-dictation.test.tsx` يفشل أحيانًا بـ`expected 'en-US' to be 'ar-SA'`
   حين يكون الجهاز مشغولًا (نحو ١ من ١٢ تشغيلًا على فرع التكامل). المطلوب إصلاحه، وإن كان في المكوّن نفسه سباق
   يصيب المستخدم فيُصلَح المكوّن.
2. **نموذج الصور لم يُجرَّب في هرمز حقيقي:** مهمة صفحة النماذج (§72) أضافت دور «الصور» والإضافة
   `plugins/image_gen/corehub-images/` وقيم `COREHUB_IMAGE_*` و`image-edit remove-bg`، ولم يُشغَّل شيء منها في دور
   هرمز حقيقي. المطلوب تجربتها طرفًا لطرف بصورة Core Hub المبنية من هذا الفرع، بلا أي مفتاح حقيقي، وإصلاح ما ينكسر.

## القرار والموافقات
**١) الإملاء: السباق في المكوّن، لا في الاختبار وحده.** زر الميكروفون كان يعمل قبل أن تُقرأ إعدادات الكلام
وتفضيلات الشخص. من يضغط في تلك اللحظة (أول فتح للمحادثة) يحصل على لغة الواجهة بدل لغة الإملاء التي اختارها
(في مُعرِّف المتصفح: `en-US` بدل `ar-SA`)، أو على «يحتاج مزوّد تحويل كلام إلى نص» مع أن المزوّد موجود، لأن المحرّك
لم يُعرف بعد. الاختبار كان يضغط بعد أن **يُطلب** `preferences` لا بعد أن **يُطبَّق**. الإصلاح:
- `useVoicePreferences` يعطي `loading` (التفضيلات تُقرأ)، و`useDictation` يأخذ `languageLoading` ويجعل `loading`
  = إعدادات الكلام أو اللغة ما زالت تُقرأ (كان `loading` موجودًا ولا يستعمله أحد)، و`start()` لا يفعل شيئًا حينها.
- الزر معطّل حتى تُقرأ الاثنتان ويقول «جارٍ التحميل…» / "Loading…" (مفتاح `common.loading` الموجود، بلا نص جديد)،
  وكذلك الزر الدائري في وضع الصوت وهو جاهز.
- الاختباران ينتظران الحالة المطبَّقة (`waitFor(mic enabled)`)، واختبار جديد يؤخّر رد `preferences` ويثبت أن الزر
  معطّل ولا يبدأ شيئًا، ثم بعد الرد يستمع بـ`ar-SA`.

**٢) الصورة لم تكن تعود إلى المحادثة — أُصلح.** في أول دور حقيقي رسمت أداة هرمز `image_generate` عبر إضافة الهب
بنجاح، لكن الرد حمل الكلمات فقط: هرمز يحفظ الصورة في ذاكرته المؤقتة `cache/images/`، خارج مجلد مخرجات الدور الذي
يلتقط منه الهب الملفات. الإصلاح (مقترح — للمالك أن يؤكّد):
- محوّل هرمز (`hermes-tui.ts`) يقرأ جواب `image_generate` الناجح (`{"success": true, "image": "<مسار>"}` كما في مصدر
  هرمز MIT) ويبلّغ حدثًا داخليًا جديدًا `file.produced` بالمسار. رابط URL (خلفية تردّ برابط) يُترك لكلام النموذج،
  وأداة أخرى فيها حقل `image` لا تُحسب.
- المشغّل (`runner.ts`، `handOver`) **ينسخ** الملف إلى مجلد مخرجات الدور، فيرفقه المحرّك بالرد جزءَ `image` مثل أي
  ملف يتركه الوكيل هناك. نسخ لا نقل (ذاكرة هرمز تبقى)، ويُرفض الرابط الرمزي والمجلد والمفقود وما فوق ٢٥ م.ب،
  ولا يُكتب فوق اسم موجود (`-2`، `-3`…)، والرفض يُسجَّل ولا يُفشل الدور. لا تغيير في العقد.
- سطر في DECISIONS §72 يصف ذلك (لا رقم جديد: جزء من القرار نفسه).

**ما رأيته في هرمز (ADR 0012، مصدره MIT في الصورة `/opt/hermes/src`):** `image_generate` مؤجَّلة افتراضيًا خلف جسر
البحث عن الأدوات (`tools/tool_search.py`، `_DEFAULT_DEFERRED_TOOLS`): لا تُعرض للنموذج مباشرة، بل يُذكر اسمها في
وصف `tool_search` — فقط حين تكون خلفيتها متاحة (`check_image_generation_requirements` → `is_available()` للإضافة)
— ويستدعيها النموذج عبر `tool_call`. هذا تصميم هرمز وليس عطلًا؛ النموذج المُبرمج يفعل ما يفعله نموذج حقيقي يرى
الاسم. و`tui_gateway` يرسل جواب الأداة محلَّلًا في `tool.complete` (`payload.result`)، ويُبلِّغ الاسم الداخلي
`image_generate` لا `tool_call`.

**ملاحظة خارج النطاق (لم تُصلح):** طلب الهب «Name this conversation» لتسمية المحادثة يصل هرمز ومعه الأدوات نفسها
(١٩ أداة)؛ نموذج حقيقي نادرًا ما يستدعي أداة هنا، لكنه ممكن. النموذج المُبرمج صار يجيب هذا الطلب بكلمات.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. الصورة تصل بجزء `image` الموجود في `Message.content`. في الخادم حدث داخلي جديد بين المحوّل والمشغّل
(`AgentEvent: file.produced`) لا يظهر في العقد. DECISIONS §72: فقرة «The picture comes back on the reply».

## الملفات والتأثير
- الويب: `packages/web/src/voice/useDictation.ts` (`languageLoading`، `loading` الفعلي، `start()` ينتظر)،
  `src/voice/context.tsx` (`VoicePreferences.loading`)، `src/voice/DictationControls.tsx` (الزر معطّل ويقول
  «جارٍ التحميل…»)، `src/chat/Composer.tsx` و`src/voice/VoiceStage.tsx` (يمرّران `languageLoading`؛ الزر الدائري
  ينتظر)، `tests/voice-dictation.test.tsx` (ينتظر الحالة المطبَّقة + اختبار جديد).
- الخادم: `packages/server/src/modules/agents/adapters/types.ts` (`file.produced`)، `adapters/hermes-tui.ts`
  (`producedImageOf`)، `runner.ts` (`handOver`، `LiveRun.outputDir`)، `adapters/hermes-tui.test.ts` و`runner.test.ts`
  (اختبارات جديدة)، `adapters/hermes-images.real.test.ts` (جديد، هرمز الحقيقي).
- حاوية الإثبات: `packages/server/tests/container/fake-provider.mjs` (وضع `--script images`: نموذج محادثة يطلب
  `image_generate`، و`/v1/images/generations|edits` لـ`gpt-image-1`، و`gemini-3.1-flash-image` يردّ بالصورة في
  `message.images` كما يفعل cli-proxy-api؛ صورة PNG ‏32×32 مربع أحمر على أخضر سادة، أو شفافة لـ`background:
  transparent`)، و`tests/container/prove-images.sh` (جديد).
- التوثيق: `docs/STATUS.md` (سطر النماذج وسطر الصوت)، `docs/contracts/DECISIONS.md` §72،
  `docs/changes/2026-09-26-twuijri-models-page-roles.md` (ما بقي)، `docs/changes/2026-09-26-twuijri-night-pr.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، واحدًا بعد الآخر، في `corehub-wt-imagee2e`.

**الاختبار المتقلّب — الملف وحده ٢٠ مرة، وكل الأنوية (٢٤) مشغولة بحلقات `while :; do :; done` في الوقت نفسه**
(`flaky-loop.sh` في مجلد المسودة):
```
# قبل (night/2026-09-26 عند 9142a1f)
run 4 FAILED: AssertionError: expected 'en-US' to be 'ar-SA' // Object.is equality
run 5 FAILED: AssertionError: expected 'en-US' to be 'ar-SA' // Object.is equality
run 6 FAILED: AssertionError: expected 'en-US' to be 'ar-SA' // Object.is equality
run 16 FAILED: AssertionError: expected 'en-US' to be 'ar-SA' // Object.is equality
run 19 FAILED: AssertionError: expected 'en-US' to be 'ar-SA' // Object.is equality
passed=15 failed=5 of 20 (under 24 busy loops)

# بعد
passed=20 failed=0 of 20 (under 24 busy loops)
```
الاختبار الجديد وما تغيّر يفشلان على المكوّن القديم (الاختبارات الجديدة، `src/` القديم):
```
     × falls back to the browser’s recognizer when the hub has no provider, and says so 39ms
     × waits for the dictation language before it can listen, so a quick press is never in the wrong language 30ms
AssertionError: expected 'en-US' to be 'ar-SA' // Object.is equality
      Tests  2 failed | 2 passed (4)
```

**صورة Core Hub من هذا الفرع** (`docker build -f packages/server/Dockerfile -t core-hub:imagee2e .` → exit 0)،
ثم `packages/server/tests/container/prove-images.sh core-hub:imagee2e` (حاويتان وشبكة Docker خاصة، تُحذف كلها عند
الخروج؛ المزوّد المزيّف على الشبكة، المفتاح `sk-lab-images-key` مزيّف). أول تشغيل قبل إصلاح الرد:
```
assistant: [{"type":"text","text":"the lab endpoint answered"}]      ← النموذج المبرمج لم يكن يعرف جسر tool_call
... بعد تعليمه tool_call:
assistant [{"type":"text","text":"\n\nHere is the red fox you asked for."}]
  tool_calls: image_generate succeeded -> {"success":true,"image":"/data/hermes/cache/images/corehub_20260925_144543_97e44b91.png",...}
FAIL  Images API (gpt-image-1): the reply carries the picture as an image
```
بعد الإصلاح (الناتج الفعلي، مختصرًا بحذف أسطر GET/POST):
```
=== 1. the upstream as a chat provider, and its image models ===
custom-lab/gemini-3.1-flash-image  [image_output]
custom-lab/gpt-image-1  [image_output]
custom-lab/lab/tiny-1:free  []

=== 2. what the hub wrote into Hermes's home (Images role = gpt-image-1) ===
COREHUB_IMAGE_API_KEY=sk-lab…
COREHUB_IMAGE_BASE_URL=http://corehub-images-lab-1563491:19099/v1
COREHUB_IMAGE_MODEL=gpt-image-1
COREHUB_IMAGE_PROVIDER=compatible
image_gen: {'provider': 'corehub-images'}
plugins.enabled: ['image_gen/corehub-images']
-rw-r--r-- 1 hub hub  5457 Sep 25 14:55 __init__.py
-rw-r--r-- 1 hub hub 23403 Sep 25 14:55 image_api.py
-rw-r--r-- 1 hub hub   234 Sep 25 14:55 plugin.yaml

=== 3. a real chat turn, Images role = gpt-image-1 ===
{"status":"succeeded","model":"custom-lab/lab/tiny-1:free","error":null}
user: [{"type":"text","text":"ارسم لي ثعلبًا أحمر"}]
assistant: [{"type":"text","text":"\n\nHere is the red fox you asked for."},{"type":"image","attachment_id":"01M3CH100Z0YDKZ4E915NE3NGY","url":"/api/v1/attachments/01M3CH100Z0YDKZ4E915NE3NGY/content","name":"corehub_20260925_145532_970dde25.png","mime":"image/png","size_bytes":107}]
image_generate succeeded {"prompt":"a red fox in flat style","aspect_ratio":"square"} -> {"success":true,"image":"/data/hermes/cache/images/corehub_20260925_145532_970dde25.png","model":"gpt-image-1",...,"provider":"corehub-images"}
corehub_20260925_145532_970dde25.png image/png 107B sources=attachment
PASS  Images API (gpt-image-1): the run succeeded
PASS  Images API (gpt-image-1): the reply carries the picture as an image
/tmp/corehub-images-1563491.png: PNG image data, 32 x 32, 8-bit/color RGB, non-interlaced
PASS  Images API (gpt-image-1): the picture on the reply is a PNG

=== 3. a real chat turn, Images role = gemini-3.1-flash-image ===
{"status":"succeeded","model":"custom-lab/lab/tiny-1:free","error":null}
assistant: [{"type":"text","text":"\n\nHere is the red fox you asked for."},{"type":"image","attachment_id":"01M3CH13FGBDQ9N3FRJCCATQW7",...,"name":"corehub_20260925_145535_1371c955.png","mime":"image/png","size_bytes":107}]
image_generate succeeded ... -> {"success":true,"image":"/data/hermes/cache/images/corehub_20260925_145535_1371c955.png","model":"gemini-3.1-flash-image",...,"provider":"corehub-images","note":"Here is the picture."}
PASS  chat image model (gemini-3.1-flash-image): the run succeeded
PASS  chat image model (gemini-3.1-flash-image): the reply carries the picture as an image
PASS  chat image model (gemini-3.1-flash-image): the picture on the reply is a PNG

=== 4. the skills inside the container, with the profile's own .env ===
{"ok": true, "command": "generate", "provider": "compatible", "model": "gpt-image-1", "files": ["out-gpt-image-1/a-red-fox-in-flat-style-20260925-145537-1.png"], "note": null}
{"ok": true, "command": "remove-bg", "provider": "compatible", "model": "gpt-image-1", "files": [...], "transparent": true, "note": null}
{"ok": true, "command": "generate", "provider": "chat", "model": "gemini-3.1-flash-image", "files": [...], "note": "Here is the picture."}
{"ok": true, "command": "remove-bg", "provider": "chat", "model": "gemini-3.1-flash-image", "files": [...], "transparent": false, "background": "pure green (#00FF00)", "next": "python3 <image-convert skill_dir>/scripts/image_tools.py transparent-bg ..."}
{"ok": true, "file": "cut-gemini-3.1-flash-image/...-transparent.png", "format": "PNG", "width": 32, "height": 32, "bytes": 128, "background": "#00ff00", "cleared_share": 0.75}
cut-gemini-3.1-flash-image/...-1-transparent.png (32, 32) RGBA corner (0, 255, 0, 0) middle (220, 30, 30, 255)
cut-gpt-image-1/...-1.png (32, 32) RGBA corner (0, 0, 0, 0) middle (220, 30, 30, 255)
PASS  image-generate (gpt-image-1) drew a file
PASS  remove-bg (gpt-image-1) answered
PASS  remove-bg (gpt-image-1) is transparent from the model
PASS  image-generate (gemini-3.1-flash-image) drew a file
PASS  remove-bg (gemini-3.1-flash-image) answered
PASS  transparent-bg (gemini-3.1-flash-image) cleared the flat colour

=== what the upstream received ===
   tools offered= 19 image_generate=false deferred image_generate=true asked="ارسم لي ثعلبًا أحمر\n\nWrite any file ..."
   asked for tool= tool_call
   images api= /v1/images/generations sources=0 transparent=false
   tool answered= {"success": true, "image": "/data/hermes/cache/images/corehub_20260925_145532_970dde25.png", "model": "gpt-image-1", ...}
   ...
   drawing chat= modalities=["image","text"] sources=0 asked="a red fox in flat style"
   tool answered= {"success": true, "image": "/data/hermes/cache/images/corehub_20260925_145535_1371c955.png", "model": "gemini-3.1-flash-image", ...}
   images api= /v1/images/edits sources=1 transparent=true
   drawing chat= modalities=["image","text"] sources=1 asked="Cut out the main subject and place it on a perfectly flat, solid pure green (#00"
ALL CHECKS PASSED
```
بعدها `docker ps -a | grep corehub-images` و`docker network ls | grep corehub-images` فارغان.

**الاختبار الحقيقي القابل للتكرار** (هرمز من الصورة، الهب في العملية):
```
$ COREHUB_HERMES_IMAGE=core-hub:imagee2e vitest run --project unit src/modules/agents/adapters/hermes-images.real.test.ts --reporter=verbose
gpt-image-1: Hermes saved /tmp/corehub-images-real-home-vs372g/cache/images/corehub_20260925_145357_40362dc1.png
 ✓ ... offers both of the upstream’s image models as image models 4ms
 ✓ ... draws with gpt-image-1 through Hermes's own image_generate, and the picture comes back 2662ms
 ✓ ... draws with gemini-3.1-flash-image through Hermes's own image_generate, and the picture comes back 2756ms
remove-bg gpt-image-1: {"ok":true,...,"transparent":true,...,"corner":[0,0,0,0],"middle":[220,30,30,255]}
remove-bg gemini-3.1-flash-image: {"ok":true,...,"transparent":false,...,"cleared":{"ok":true,...,"background":"#00ff00","cleared_share":0.75},"corner":[0,255,0,0],"middle":[220,30,30,255]}
 ✓ ... cuts a subject out with remove-bg: transparent from gpt-image, cleared from a flat colour otherwise 786ms
 Test Files  1 passed (1)
      Tests  4 passed (4)

# والمحوّل والمشغّل قبل الإصلاح (runner.ts/hermes-tui.ts/types.ts من 9142a1f):
     × draws with gpt-image-1 through Hermes's own image_generate, and the picture comes back 2799ms
     × draws with gemini-3.1-flash-image through Hermes's own image_generate, and the picture comes back 2841ms
AssertionError: expected [] to have a length of 1 but got +0

$ COREHUB_HERMES_IMAGE=core-hub:imagee2e vitest run --project unit tests/unit/skill-library.real.test.ts
 ✓ ... Hermes lists every library skill in the core-hub category, in default and in a profile it made 921ms
 ✓ ... runs image-generate end to end in a Hermes turn, against a scripted image endpoint 2916ms
      Tests  2 passed (2)
```

**الوحدات والفحوص العامة:**
```
$ vitest run --project unit src/modules/agents/runner.test.ts src/modules/agents/adapters/hermes-tui.test.ts \
    src/modules/agents/adapters/adapters.test.ts src/modules/agents/adapters/hermes-tui-commands.test.ts
 Test Files  4 passed (4)
      Tests  85 passed (85)
# الاختبارات الثلاثة الجديدة على runner.ts/hermes-tui.ts/types.ts القديمة:
     × hands on the picture Hermes’s image_generate saved, and nothing another tool names (§72) 4ms
     × copies it into the run’s output folder before the run ends, and leaves the original 1ms
     × refuses a link, a folder, a missing file or a run with no output folder, and never overwrites 0ms
      Tests  3 failed | 48 passed (51)

$ (web) vitest run tests/voice-dictation.test.tsx tests/composer.test.tsx
 Test Files  2 passed (2)
      Tests  20 passed (20)
$ (web) vitest run tests/hermes-settings.test.tsx tests/workspace-files.test.tsx tests/slash-commands.test.tsx \
    tests/composer.test.tsx tests/voice-dictation.test.tsx tests/rooms.test.tsx tests/voice-recorder.test.ts tests/voice-chunking.test.ts
 Test Files  8 passed (8)
      Tests  78 passed (78)

$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            → exit 0
$ pnpm i18n:check
i18n:check  OK
```
نتيجة CI على #144 عند `e632a2a` (فيه هذه المهمة): ١٧ من ١٧ ناجحة — CI (lint وtypecheck والعقد واختبارات العملاء
والبناء، وشرائح الخادم الثلاث، وdb:migrate على SQLite وPostgreSQL، وصورة Docker، ورحلات الويب ٧د٢٤ث، وسطح المكتب)،
وAndroid وiOS وInstallers الثلاثة وChange record.

**لم أشغّل** (قواعد السرعة؛ CI يشغّلها): حزم الخادم والويب كاملة، و`pnpm build`، ورحلات Playwright (رحلة
`zzzzzzz-voice.spec.ts` تنتظر أن يُفعَّل الزر أصلًا).

## المخاطر والرجوع
- **الزر ينتظر** حتى تُقرأ إعدادات الكلام والتفضيلات: إن تأخّر الهب يرى الشخص «جارٍ التحميل…» بدل ضغطة بلغة
  خاطئة. إن فشل طلب التفضيلات يُعتبر مقروءًا (`isLoading` ينتهي) ويعود الزر بلغة «تلقائي» كما قبل.
- **الصورة تُنسخ** إلى مجلد مخرجات الدور: نسخة ثانية على القرص لكل صورة (حجمها كحجم الصورة). يعمل حيث يرى الهب
  ملفات هرمز (هرمز داخل الصورة أو بجانب الهب)؛ هرمز بعيد على جهاز آخر يعطي مسارًا لا يوجد هنا، فيُسجَّل
  `missing` وتبقى الكلمات كما كانت قبل الإصلاح.
- الرجوع: revert لهذا الفرع؛ لا ترحيل ولا عقد.

## التسليم والخطوة التالية
- للمالك أن يؤكّد: نسخ صورة `image_generate` إلى الرد تلقائيًا، وزر الميكروفون المعطّل مع «جارٍ التحميل…».
- الباقي من §72: التجربة على cli-proxy-api الحقيقي بـ`gemini-3.1-flash-image` (شكل الرد جُرِّب على خادم مُبرمج فقط).
- يُنظر لاحقًا: هل ينبغي أن يصل طلب تسمية المحادثة إلى هرمز بلا أدوات.
