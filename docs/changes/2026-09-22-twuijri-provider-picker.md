# إضافة المزوّد من قائمة أنواع، ومزوّدون محلّيون، ومفتاح لا يُرفض أبدًا
المسؤول: twuijri · الفرع: feat/provider-picker · الحالة: review

## المشكلة والهدف
طلب المالك في 2026-09-22 ثلاثة أشياء:

1. **شاشة النماذج مبعثرة.** كانت تعرض شبكة فيها كل مزوّد يعرفه المركز، ولكلٍّ صندوق مفتاح
   خاص به. يريد ما كان في منتجه السابق: قائمة بـ**المزوّدين الذين ضبطهم فقط**، وزر واحد
   واضح «إضافة مزوّد» يفتح حوارًا فيه: نوع المزوّد (جاهز | مخصّص)، قائمة المزوّدين الجاهزين،
   عنوان الخدمة مُعبّأ من النوع وقابلًا للتحرير، مفتاح واجهة (اختياري ومكتوب أنه اختياري)،
   ونموذج افتراضي بجانبه زر «اجلب» يسحب القائمة من المزوّد نفسه.
2. **المزوّدون المحلّيون أولًا**: يريد التجربة على خادم نماذج محلّي قبل أي شيء آخر —
   LM Studio و LiteLLM ومدخلة عامة «متوافق مع OpenAI»، و Ollama بالسلوك نفسه.
3. **عيب حقيقي وقع فيه على نسخته المنشورة**: أضاف مزوّدًا مخصّصًا (`cli-proxy-api` على
   `http://cli-proxy-api:8317/v1`)، فظهرت البطاقة بشارة «لا يحتاج مفتاحًا» وفي الوقت نفسه
   خطأ أحمر «Missing API key»، **ولا حقل لكتابة المفتاح أصلًا**. بكلماته: «أضفت المحلّي
   وما قدرت أدخل المفتاح، التدفّق ناقص».

## القرار والموافقات
- **الغرفة النظيفة (ADR 0004)**: لم يُفتح أي ملف تحت `~/project/agent-studio/packages/*` ولا
  أي مصدر من المنتج السابق. ما بُني هنا مبنيّ على **وصف مكتوب** لما يريده المالك، سُلّم في
  المحادثة، وعلى عقد هذا المستودع وحده.
- **فصل «ما أضفته» عن «ما يمكن إضافته»** (قرار العقد §26): صف في `providers` يوجد لأن أحدًا
  أضافه؛ والفهرس المُدمج صار قائمة **أنواع** يقرأها الحوار و`majlis providers presets`.
  قاعدة ADR 0006 («ظاهر وغير مضبوط، لا مخفيّ») لم تُلغَ — انتقلت إلى قائمة الأنواع.
- **لا قيمة تعني «المفتاح مرفوض»**. `ProviderPreset.key` إمّا `required` أو `optional` فقط،
  و`Provider.auth.kind: none` معناها **لا يُطلب مفتاح**، لا «لا يُقبل». كل مزوّد يقبل مفتاحًا
  (وكيل محلّي خلف master key حالة عادية)، والشيء الوحيد المسموح له أن يقول «المفتاح ناقص» هو
  ردّ المزوّد نفسه (401 بكلماته). هذا هو إصلاح العيب رقم ٣.
- **الحاوية**: المركز داخل حاوية، فـ`127.0.0.1` هنا هي الحاوية لا جهاز المالك. المركز يُبلغ
  فقط (`host.containerized`)، والعميل يُحذّر ويقترح `host.docker.internal`. **لا إعادة كتابة
  صامتة للعنوان**: مركز يعدّل ما كتبته مركز لا يمكن تشخيصه.
- لم يُدفع الفرع، ولم يُفتح PR، ولم يُنشر شيء.

## العقد (ما تغيّر في packages/contracts)
مسجَّل في `docs/contracts/DECISIONS.md` §26. كل عملية قائمة بقيت تعمل كما هي.

| التغيير | لماذا |
|---|---|
| **عملية جديدة** `models.listProviderPresets` (`GET /models/provider-presets`) | «ما الذي يمكنني إضافته» سؤال مختلف عن «ماذا أضفت»؛ ترجع الأنواع مع `host { containerized, loopback_alias }` |
| **عملية جديدة** `models.probeProvider` (`POST /models/provider-probes`) | زر «اجلب»: قائمة نماذج عنوان لم يُحفَظ بعد. لا تخزّن شيئًا، والفشل `ok: false` بكلمات المزوّد |
| **مخطّطات جديدة** `ProviderPreset`, `ProviderHost`, `ProviderProbe`, `ProviderProbeResult` | أشكال العمليتين |
| `ProviderCreate.preset` (اختياري) | مع نوع جاهز تأتي اللاحقة والبروتوكول وعائلة الاعتماد والعنوان الافتراضي من الفهرس. بدونه: نقطة نهاية متوافقة مع OpenAI كما كان تمامًا — لا استدعاء قديم تغيّر |
| وصف `Provider.auth` | `none` = «لا يُطلب مفتاح»، ولا تعني أبدًا أن المفتاح مرفوض؛ العميل يعرض الحقل دائمًا |
| ملخّص `models.listProviders` و`createProvider` و`deleteProvider` | القائمة صارت «ما أضفته»؛ والحذف صار لأي مزوّد أضافه صاحبه، جاهزًا كان أو مخصّصًا |

`pnpm contracts:generate` أعاد توليد عميل TypeScript بلا فروق متبقّية (العملاء الأصليان
Kotlin/Swift يحتاجان JRE غير موجود في هذه البيئة — الأمر يقولها صراحةً).

## الملفات والتأثير

**`packages/server/src/modules/models/`**
- `catalogue.ts` — الفهرس صار قائمة أنواع: حقول `keyRequirement` (بدل `authKind`) و`local`
  و`repeatable`، و`baseUrl` صار يقبل `null` («لا عنوان يمكن تخمينه»). **مدخلات جديدة**:
  `lmstudio` (متوافق مع OpenAI، `http://127.0.0.1:1234/v1`، مفتاح اختياري)، `litellm`
  (بلا عنوان افتراضي، مفتاح اختياري)، `openai-compatible` (عامّة، تُضاف أكثر من مرة،
  المستخدم يسمّيها)؛ و`ollama` صار `optional` بدل «بلا مفتاح». حارس البنية تشدّد: مدخلة بلا
  متغيّر بيئة لا يحقّ لها ادّعاء اسم عند Hermes، ومدخلة متكرّرة لا تملك عائلة مشتركة.
- `store.ts` — **حُذف الزرع**. لم تعد هناك صفوف تُخلق تلقائيًا.
- `service.ts` — `listPresets()` و`probeProvider()`؛ و`createProvider` يقبل `preset` وينشئ
  **كل صفوف العائلة** في نداء واحد (إضافة OpenAI تملأ تبويبَي الصوت أيضًا)، ويحيي صفًا
  مؤرشفًا بنفس اللاحقة بدل الاصطدام بالفهرس الفريد، ويرفض إضافة النوع مرتين بـ409؛
  و`deleteProvider` يحذف أي مزوّد ويمسح المفتاح فقط حين يخرج آخر صف من عائلته؛
  و**`updateProvider` لم يعد يقلب `auth_kind` عند حفظ المفتاح أو مسحه** — هذا بالضبط ما
  صنع التناقض على البطاقة؛ و`hostInfo()` يكشف الحاوية من `/.dockerenv` أو
  `/run/.containerenv` (لا متغيّر بيئة خامس: الأربعة في `app/config.ts` هي كل الضبط).
- `adapters/types.ts` + `adapters/openai.ts` — `ProviderContext.requiresKey`؛ ومحوّل OpenAI
  لا يقول `no_key` إلا لمزوّد يطلب مفتاحًا فعلًا. مَن لا يطلبه يُسأل بلا مفتاح ويُنقل ردّه.
- `index.ts` — المساران الجديدان، وحذف نداءات الزرع.
- `i18n/{ar,en}.json` — `models.probe.failed`.

**`packages/server/drizzle/0002_unseeded_providers.sql`** (مكتوبة يدويًا: ترحيل **بيانات** لا
مخطّط، و`db:generate` يقول «لا تغييرات») — تحذف بقايا الزرع القديم: `builtin = 1` وبلا مفتاح
وبلا أي نموذج. أي صف استُخدم فعلًا له مفتاح أو قائمة نماذج ويبقى كما هو.

**`packages/cli/src/commands/models.ts`** — `providers presets` جديد؛ و`providers add` يقبل
معرّف نوع و`--base-url` و`--name` و`--no-key`، ويطلب المفتاح لكل مزوّد (حتى غير الطالب له)
ويقبل التخطّي بـEnter؛ و`providers remove` يحذف أي مزوّد، و`--clear-key` يمسح المفتاح فقط؛
و`providers list` يعرض العنوان ويقول «اختياري» بدل «ناقص» لمن لا يطلب مفتاحًا. تحذير
loopback مطبوع من العميل نفسه.

**`packages/web/src/models/`** — `ModelsScreen.tsx` أُعيدت كتابته: إجراءان في الرأس على تبويب
`General` وحده (تحديث قائمة النماذج، إضافة مزوّد) كما تنصّ `NAVIGATION` §3، ومُرشِّح تحت
التبويبات، وبطاقة لكل مزوّد مضبوط فيها الشارات (جاهز/مخصّص/الافتراضي الحالي/موقوف) وصفوف
(المزوّد، العنوان، عدد النماذج) ورقائق النماذج ومُحدِّد النموذج الافتراضي، وإجراءات: اجعله
الافتراضي · أسماء العرض · النماذج الظاهرة · تحديث · اختبار · تعديل · مسح المفتاح · حذف.
`AddProviderDialog.tsx` جديد (زجاجي، لأنه «كروم عائم» حسب `DESIGN.md`)، و`loopback.ts`
دالّتان صافيتان للتحذير والاقتراح، و`queries.ts` مضاف إليه `useProviderPresets`
و`useProbeProvider` و`useSaveModel`.

**الوثائق** — `docs/contracts/DECISIONS.md` §26، `docs/contracts/COVERAGE.md`،
`docs/domain/models.md` (لا زرع؛ و`auth_kind` متطلَّب لا حالة)، `docs/STATUS.md`،
و`docs/DEPLOY.md` §3 (المفاتيح صارت في شاشة النماذج، والنسخ الاحتياطي لـ`data.key`) و**§3b
جديد**: خادم نماذج على جهازك، بجدول العناوين وسطر
`extra_hosts: ["host.docker.internal:host-gateway"]`. السطر نفسه أُضيف إلى
`docker-compose.yml` المرجعي.

## ما تُرك عن قصد
- **«التحديد الجماعي»** (اختيار عدة مزوّدين والتصرّف بهم دفعة واحدة): مذكور كـ«إن اتّسق
  فقط». لم يُشحن — يحتاج شريط إجراءات ونموذج اختيار وحالة تأكيد للحذف الجماعي، وهو تغيير
  قائم بذاته أكبر من بقيّة الشاشة مجتمعة. المُرشِّح شُحن.
- **«أسماء العرض» و«النماذج الظاهرة»**: مدعومتان بالعقد (`models.putModel.alias` و
  `ProviderPatch.visibility`)، ونُفِّذتا كلوحة واحدة داخل البطاقة (جدول: النموذج · اسم العرض ·
  ظاهر) يفتحها الزرّان. لم يُصنع لهما حوار منفصل.
- `models.transcribe` وتسجيل الدخول بـOAuth ما زالت 501 موثّقة كما كانت.

## الفحوص (الأوامر ونواتجها الفعلية)

```
$ pnpm typecheck
(بلا أخطاء؛ يبني contracts وui-tokens ثم tsc --noEmit لكل حزمة)

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm -r --if-present test
 Test Files  3 passed (3)                 contracts
      Tests  11 passed (11)
 Test Files  1 passed (1)                 ui-tokens
      Tests  89 passed (89)
 Test Files  10 passed (10)               cli
      Tests  57 passed (57)
 Test Files  36 passed | 1 skipped (37)   server
      Tests  284 passed | 2 skipped (286)
 Test Files  9 passed (9)                 web
      Tests  96 passed (96)

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  249 passed (249)

$ pnpm contracts:lint
openapi.yaml: validated in 513ms
Woohoo! Your API description is valid. 🎉
contracts:lint  OK

$ pnpm contracts:generate
contracts:generate:ts  wrote generated/ts/schema.ts
contracts:generate:native  Java runtime not found; Kotlin/Swift clients not generated.

$ pnpm contracts:check-clients
check-clients  OK — 98 client file(s) scanned, 163 contract path(s) known.

$ pnpm nav:check
nav:check  OK — 35 destinations, 37 terms, ar/en complete, routes for web

$ pnpm i18n:check
i18n:check  server: 94 keys, ar/en in parity
i18n:check  cli: 218 keys, ar/en in parity
i18n:check  web: 294 keys, ar/en in parity
i18n:check  OK

$ pnpm db:generate
No schema changes, nothing to migrate 😴     (0002 ترحيل بيانات مكتوب يدويًا)

$ rm -rf /tmp/majlis-dbtest && DATA_DIR=/tmp/majlis-dbtest pnpm db:migrate
{"level":30,"service":"majlis","msg":"db: migrations applied (sqlite)"}

# تحقّق مباشر من ترحيل البيانات 0002 على قاعدة فيها أربعة صفوف مصنوعة يدويًا:
#   p-untouched (builtin, بلا مفتاح, بلا نماذج) · p-keyed (builtin بمفتاح)
#   p-used (builtin بلا مفتاح لكن له نموذج) · p-custom (غير builtin)
remaining: p-custom, p-keyed, p-used

$ pnpm build
✓ built in 588ms   (web)، وبقية الحزم بلا أخطاء

$ node packages/cli/dist/bin.js --help
  providers list     List the providers this workspace added, with their address and whether a key is stored.
  providers presets  List the provider types you can add, local model servers included.
  providers add      Add a provider from a preset, or store a key for one you already added.
  providers test     Ask the provider whether the stored key works.
  providers remove   Remove a provider, or (--clear-key) only forget its stored key.

$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  ✓  1 [chromium] › login → new session → streamed markdown reply … (2.1s)
  ✓  2 [chromium] › an approval card answers once / session / always / deny … (869ms)
  ✓  3 [chromium] › a socket drop mid-run resumes with after_seq … (3.4s)
  3 passed (9.8s)
```

### ما تغطّيه الاختبارات الجديدة
- `packages/server/src/modules/models/catalogue.test.ts` (جديد، 10): المدخلات الثلاث الجديدة
  بقيمها، وأن لا مدخلة ترفض مفتاحًا، وحرّاس البنية الثلاثة، وكشف الحاوية.
- `models-api.test.ts`: مساحة عمل جديدة بلا مزوّدين + قائمة الأنواع؛ **المسار الكامل لمزوّد
  بلا مفتاح** (اجلب قبل الحفظ ← أضف ← وصلت النماذج ← اختبار ناجح ← اجعله الافتراضي) على
  `fetch` مكتوب بالسيناريو بلا شبكة؛ **اختبار انحدار العيب**: مزوّد مخصّص بلا مفتاح ←
  401 المزوّد بكلماته لا جملتنا ← حفظ مفتاح له ← `auth.kind` يبقى `none` ← نجاح؛ ورفض
  الإضافة المكرّرة، ورفض نوع مجهول، ورفض LiteLLM بلا عنوان، وحذف أي مزوّد وإعادة إضافته.
- `packages/cli/tests/integration/cli.test.ts`: `providers presets`، وإضافة خادم محلّي
  بـ`--base-url --no-key`، ثم إعطاؤه مفتاحًا بعد ذلك، ثم `--clear-key` ثم الحذف.
- `packages/web/tests/models-screen.test.tsx` (19): النوع الجاهز يعبّئ العنوان، LiteLLM يطلبه،
  «مخصّص» يطلب اسمًا، المزوّد الاختياري لا يُطلب منه مفتاح ويُقبل منه واحد، «اجلب» يعرض كلمات
  المزوّد عند الفشل ولا يخترع نماذج، تحذير loopback بالعربية والإنجليزية بلا إعادة كتابة،
  وحقل المفتاح موجود على بطاقة مزوّد لا يطلب مفتاحًا (العيب نفسه).

## المخاطر والرجوع
- **تذبذب قائم في مجموعة اختبارات الخادم** (ليس من هذا التغيير): تشغيل `pnpm test` بالتوازي
  على هذه الآلة (24 نواة) يُسقط أحيانًا اختبارات بثّ غير مترابطة
  (`agents/runner`, `sessions-run`, أو «module … is composed»). أثبتُّ أنه سابق لهذا العمل:
  على `origin/main` + التزام العقد وحده، `pnpm --filter @majlis/server test` سقط بـ10 اختبارات،
  وبـ`--no-file-parallelism` نجح 267/267. وبعد هذا العمل: مرّة سقط اثنان، والمرّة التالية
  بالأمر نفسه نجح 284/284، وبالتسلسل نجح 284/284. لم أُصلحه هنا لأنه إصلاح هارنس مستقل
  (سطر في `vitest.config.ts` أو مهلة) ولا يجوز خلطه بهذه المهمة — لكنه **الخطوة التالية
  المقترحة**، لأنه يجعل دليل أي مهمة قابلًا للشك.
- **حذف الترحيل 0002 لصفوف**: يحذف فقط `builtin` بلا مفتاح وبلا نموذج — أي بقايا الزرع. لو
  كان المالك قد أضاف Ollama واستُخدم فعلًا، فله نماذج ويبقى. الرجوع: العودة إلى الالتزام
  السابق وإسقاط `drizzle/0002_*` (ثم إعادة إضافة ما ضاع من الشاشة، وهي إضافة بلا مفتاح).
- **شاشة النماذج تبدأ فارغة بعد الترقية** لمن كان يرى الشبكة القديمة. هذا مقصود وهو الطلب،
  ولكنه تغيير مرئي: أول ما يراه المالك زرّ «إضافة مزوّد» وجملة تشرح.
- **`probeProvider` يجعل المركز يطلب عنوانًا يكتبه المدير**. محصور بـ`owner/admin` مثل
  `createProvider` الذي يفعل الشيء نفسه أصلًا عبر التحديث، ولا يخزّن المفتاح المُمرَّر.
- **لم تُستخدم أي مفاتيح حقيقية**، ولم يُقرأ مفتاح من أي مكان. كل الشبكة في الاختبارات
  مكتوبة بالسيناريو. ما لا يمكن إثباته بلا جهاز المالك: أن LM Studio/LiteLLM الحقيقيين
  يجيبان بالشكل المفترض، وأن `host.docker.internal` مُعرّف على مضيفه.

## التسليم والخطوة التالية
- أربعة التزامات على `feat/provider-picker` من `origin/main`. **لم يُدفع ولم يُفتح PR.**
- الخطوة التالية بعد موافقة المالك: دفع الفرع، PR بالإنجليزية إلى `main`، ثم تجربته على
  الحزمة الحقيقية مع LM Studio: أضف النوع، اكتب `http://host.docker.internal:1234/v1`،
  اضغط «اجلب»، واختر النموذج.
- مقترح مستقل: تثبيت تذبذب مجموعة اختبارات الخادم أعلاه.
