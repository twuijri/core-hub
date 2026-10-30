# التشغيل المحلي: الهب يثبّت Ollama ويشغّله ويدير نماذجه على الكمبيوتر
المسؤول: twuijri · الفرع: feat/local-runtime-ollama · الحالة: review

## المشكلة والهدف
- **الحاجة:** يبي المالك (2026-10-30) يصلّح مشاكل جهازه أو الهب حتى لو كان النت هو المشكلة. يعني يحتاج نموذج يشتغل على الجهاز نفسه.
- **الفكرة:** الهب يحمّل البرامج الخارجية من مصدرها مثل ما يسوي مع الوكلاء، ويديرها. كذا ما ينضاف شي على حجم الهب، والبرامج تتحدّث من نفس الشركة متى ما بغى.
- **بكلامه:** «اذا موجود بالجهاز يصير يديره ويبين انه يديره ومهب هو الي حمل. اما اذا مهب موجود يحمله هو ويصير يديره ادارة كامل يعني لو وقفت الهب ياقف معه واقدر امسح الموديلات منه واضيف منه واحدث اولاما منه وكل شي من الهب».

## القرار والموافقات
- **المكان:** الكمبيوتر بس. السيرفر لا، والجوال يمكن بعدين (المالك، 2026-10-30).
- **المشغّل:** Ollama أول (المالك: «خلاص نستخدم اولاما»).
  - **الماك:** حوالي 180 MB، وMLX داخله.
  - **ويندوز ولينكس:** ينزل بس ملفات كرت الشاشة اللي يحتاجها الجهاز (المالك).
- **لينكس:** ما ردّ عليه المالك صراحة، فطبّقت توصيتي: التحميل كامل (1.45 GB) بس الملفات الزايدة ما تنفك على القرص. ملف لينكس ما يقبل التحميل الجزئي.
- **مين يقدر يستخدمه:** المالك والمدراء فقط، مثل تثبيت الوكلاء. هذا اختيار المنفّذ.
- **التفاصيل:** القرار الكامل في ADR 0032.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- **إضافة فقط، تسع عمليات تحت `/models/local-runtime`:**
  - `getLocalRuntime` و`removeLocalRuntime`؛
  - `installLocalRuntime` و`updateLocalRuntime`؛
  - `startLocalRuntime` و`stopLocalRuntime`؛
  - `listLocalModels` و`pullLocalModel` و`deleteLocalModel`.
- **مخططات جديدة:**
  - `LocalRuntime` و`LocalModels` و`LocalModel`؛
  - `LocalModelLoaded` و`LocalModelSuggestion` و`LocalModelPull`.
- **ما تغيّر شي موجود:** المهام تستخدم الأنواع الحالية `install` و`update`، فما فيه قيمة `JobKind` جديدة توصل للجوالات القديمة.
- `contracts:compat`: «لا تغيير كاسر مقابل v1.1.9».

## الملفات والتأثير
- **السيرفر، `packages/server/src/modules/models/local-runtime/` (جديد):**
  - `ollama-release.ts`: آخر إصدار من تحويلة `releases/latest`، ويقرأ `sha256sum.txt`.
  - `gpu.ts`: يكشف كرت الشاشة. `nvidia-smi` يحدد CUDA 13 أو 12، و`/sys/class/drm` أو PowerShell للاسم.
  - `remote-zip.ts`: يقرأ فهرس ملف zip من بعيد ويحمّل الأجزاء المطلوبة بس، ويتحقق من CRC-32.
  - `ollama-install.ts`: الخطة والتثبيت.
    - الماك ولينكس: يتحقق من SHA-256، ويفك الملف ويستثني مجلدات CUDA اللي الجهاز ما يحتاجها.
    - ويندوز: تحميل جزئي.
    - التثبيت يصير في مجلد مؤقت، وما يستبدل القديم إلا إذا اكتمل.
  - `ollama-process.ts`: يشغّل Ollama كعملية تابعة للهب على `127.0.0.1`، ويعيد تشغيله إذا طاح (ثلاث مرات بالدقيقة كحد أقصى).
  - `ollama-api.ts`: أوامر version وtags وps وpull وdelete.
  - `suggestions.ts`: ست نماذج مقترحة، كلها تدعم الأدوات.
  - `service.ts`: نوعين، managed وexternal، والمهام، وربط المزوّد.
- **السيرفر، ملفات موجودة:**
  - `models/index.ts`:
    - `localRuntimeFor`.
    - يربط صف المزوّد `ollama` المشترك. يحرّك الصف الموجود بس إذا الهب هو اللي يشغّل Ollama.
    - التشغيل يبدأ وقت ما يجهز الهب (onReady)، ويوقف وقت ما يقفل (onClose).
    - المسارات التسعة.
  - `app/config.ts`: `COREHUB_LOCAL_MODELS` اختياري.
    - `auto`: يشتغل بس في هب تطبيق الكمبيوتر، اللي فيه `relayHost`.
    - `on` يشغّله في أي هب، و`off` يطفيه في كل مكان.
- **العقد:** `packages/contracts/openapi.yaml`.
- **الويب:**
  - `models/LocalRuntimeCard.tsx` (جديد): بطاقة «التشغيل المحلي» في تبويب المزوّدين.
    - تظهر للمالك والمدير بس، وإذا كان `available` صحيح.
    - ثلاث حالات: «ما فيه Ollama»، و«ثبّته كور هب»، و«موجود قبل في الجهاز».
    - التثبيت والتحديث والتشغيل والإيقاف والحذف، مع شريط تقدّم.
    - النماذج: المثبّتة، والمحمّلة الحين، والمقترحة. تقدر تنزّل أي اسم، وفيه تقدّم وإلغاء لكل تنزيل.
  - `models/queries.ts`:
    - الأوامر (hooks) الجديدة.
    - `useProviders` يعيد القراءة كل ثانيتين ما دام فيه مزوّد قائمة نماذجه تتحدّث (`loading`). قبلها كانت بطاقة Ollama تبقى على «0 نماذج» بعد التنزيل لين تحدّث الصفحة.
  - `ModelsScreen.tsx`، و`types.ts`، و`i18n/{en,ar}.json`: ‏51 مفتاح `models.local.*`.
  - `tests/i18n.test.ts`، و`tests/local-runtime-card.test.tsx`: ‏7 اختبارات.
- **الوثائق:**
  - `docs/adr/0032-local-models-ollama.md`؛
  - `docs/domain/models.md`؛
  - `docs/DEPLOY.md`.
- **الاختبارات:**
  - `local-runtime.test.ts`: ‏13 اختبار بدون نت.
  - `local-runtime-api.test.ts`: اختباران عبر HTTP.
  - `local-runtime.real.test.ts`: يحتاج `COREHUB_REAL_OLLAMA=1`.
  - `tests/unit/config.test.ts`.
- **ما تغيّر شي في تطبيق الكمبيوتر:** الهب يعرف إنه هب التطبيق من `relayHost`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ COREHUB_REAL_OLLAMA=1 COREHUB_REAL_OLLAMA_DIR=~/corehub-ollama-real npx vitest run src/modules/models/local-runtime/local-runtime.real.test.ts
  Tests 2 passed (82 s): Ollama 0.40.13 حقيقي على لينكس x64 (كرت AMD): تثبيت → يشتغل → سحب smollm2:135m
  → محادثة عبر /v1/chat/completions → حذف → إيقاف → إزالة
  ويندوز (من فهرس الملف الحقيقي): 39.7 MB بدون NVIDIA · 644.4 MB مع CUDA 13
$ npx vitest run src/modules/models/local-runtime src/modules/models/local-runtime-api.test.ts --maxWorkers=2
  15 passed | 2 skipped (الحقيقية)
$ npx vitest run src/modules/models/models-api.test.ts tests/unit/config.test.ts --maxWorkers=2
  52 passed | 1 skipped
$ pnpm contracts:lint      → OK
$ node packages/contracts/scripts/compat.mjs → OK — no breaking change against v1.1.9
$ npx tsc --noEmit -p packages/server → بلا أخطاء
$ pnpm typecheck                → exit 0
$ pnpm lint                     → eslint + prettier نظيف
$ pnpm contracts:check-clients  → OK — 1187 client file(s), 283 contract path(s)
$ pnpm i18n:check               → OK (ar/en متطابقة)
$ npx vitest run tests/local-runtime-card.test.tsx tests/i18n.test.ts tests/models-screen.test.tsx --maxWorkers=2   (packages/web)
  Test Files 3 passed · Tests 42 passed
تجربة في المتصفح (هب محلي بـ COREHUB_LOCAL_MODELS=on، والويب مبني):
  بالعربي → ثبّت Ollama (قرابة 1.4 GB، شريط تقدّم RTL) → «ثبّته كور هب · 0.40.13 يعمل»
  → نزّل smollm2:135m → ظهر في القائمة وفي بطاقة المزوّد Ollama (http://127.0.0.1:11434)
  إيقاف الهب بـ SIGTERM والنافذة مفتوحة → Ollama وقف معه
  قتل الهب بـ SIGKILL (انهيار) → Ollama ظل شغّال → تشغيل الهب من جديد وقّف الباقي ثم شغّل واحد جديد
```

## المخاطر والرجوع
- **ويندوز:**
  - ما نقدر نتحقق من SHA-256 حق الملف كامل، لأننا ما نحمّله كامل.
  - الحماية هنا: TLS من إصدار الشركة نفسها، وCRC-32 لكل جزء من فهرس الملف. هذي مقايضة قبلها المالك عشان الحجم.
- **التحديثات:** Ollama يتحدّث لآخر إصدار من الشركة بدون مراجعة منّا، بعكس الوكلاء اللي لهم بصمة مثبّتة.
- **إذا انهار الهب انهيار مفاجئ** (مو إغلاق عادي): يظل Ollama شغّال لين يشتغل الهب مرة ثانية.
  - الهب يحفظ رقم العملية في `ollama.pid`.
  - أول ما يشتغل، يوقف العملية القديمة بشرط إن أمرها فيه «ollama».
  - إذا أُغلق الهب بالطريقة العادية، يوقف Ollama في `preClose`، يعني قبل ما ينتظر الاتصالات المفتوحة تنتهي.
- **اللي ما تجرّب على جهاز حقيقي:**
  - ويندوز: جرّبت الخطة وحجم التحميل بس، مو التثبيت كامل.
  - الماك: ما تجرّب أبد.
- **الرجوع:**
  - `COREHUB_LOCAL_MODELS=off` يخفي الميزة.
  - أو نسوي revert للـPR. كل شي إضافة، وما فيه بيانات في قاعدة البيانات. ملفات `<DATA_DIR>/runtimes/ollama` تنحذف يدوياً.

## التسليم والخطوة التالية
- PR إلى main ينتظر دمج المالك.
- **بعد الدمج:** تجربة على ويندوز وماك من نسخة تجريبية للكمبيوتر.
- **لاحقاً:**
  - مساعد Hermes يحوّل على النموذج المحلي إذا انقطع النت.
  - llama.cpp مباشر إذا كان تحميل CUDA كبير.
  - اكتشاف LM Studio.
  - الجوال.
