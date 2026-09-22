# الوكيل المباشر (direct) — محادثة من المركز إلى المزوّد بلا وقت تشغيل بينهما
المسؤول: twuijri · الفرع: feat/direct-agent · الحالة: review

## المشكلة والهدف

التركيب الأول بعد التنصيب كان يعرض وكيلًا واحدًا: هرمس. وكل رسالة تمرّ
ثلاث قفزات — المتصفح إلى المركز، المركز إلى بوابة هرمس، هرمس إلى المزوّد —
وهذا ما يجعل المحادثة البسيطة أبطأ من المنتجات التي تكتب رسالتها إلى
المزوّد مباشرة.

قرار المالك (2026-09-22، `docs/inspirations/ADOPTION-BACKLOG.md` §٢.١٥):
التركيب الجديد يعرض **وكيلين**: هرمس، ووكيل **«مباشر»** يراسل النموذج
المختار بلا وقت تشغيل بينهما. قفزة واحدة بدل ثلاث.

الهدف في هذا الفرع: مدخل كتالوج مدمج، ومحوّل ومشغّل يبثّان من المزوّد عبر
محوّلات `models` الموجودة ومخزن الاعتماد المشترك، بأحداث التشغيل نفسها
وبآلة الحالة نفسها، وبأخطاء صريحة.

## القرار والموافقات

- **مدخل كتالوج مدمج** `direct`: `install: { kind: 'bundled' }`، فمصدره
  `builtin` ولا يُثبَّت ولا يُزال (الحارس نفسه الذي يحمي هرمس في
  `lifecycleJob`). يظهر في `agents.list` كأي وكيل ويمكن أن يكون وكيل جلسة.
- **نوع المحوّل `builtin`**: كان محجوزًا في العقد منذ البداية
  (`AgentKind` §`builtin` — "the hub's own lightweight agent") وبلا محوّل
  يطالب به. هذا الفرع هو ما يملؤه. لا تغيير في العقد.
- **إعادة استعمال محوّلات `models`، لا عميل HTTP جديد**: أُضيف فعل خامس
  `chat` إلى `ProviderAdapter` بجوار `test` و`listModels` و`listVoices`
  و`synthesize`، ونُفِّذ في `openai` و`anthropic` و`google` و`ollama`.
  المفاتيح تبقى داخل `models` ولا يراها `agents` أبدًا (ADR 0010): المنفذ
  الذي يعبر الحدّ هو `directChat(workspace, request)` و`modelFacts(...)`،
  وكلاهما يعيد أحداثًا لا صفوفًا ولا مفاتيح.
- **اختيار النموذج**: نموذج الجلسة أو افتراضي مساحة العمل هو الذي يقرّر
  المزوّد. لا يضبط المستخدم شيئًا جديدًا لهذا الوكيل.
- **بلا أدوات في هذه النسخة**: المهارات وMCP فوق المسار المباشر هي البند
  §٢.١٦ من `ADOPTION-BACKLOG.md` وتخصّ فرعًا لاحقًا. لم يُبنَ منها نصف
  شيء هنا: `capabilities` للوكيل هي `['streaming', 'vision', 'resume']`
  فقط، ولا `tools` ولا `approvals` ولا `mcp` ولا `skills`.
- **لا مساس بشريط الشرائح في الويب ولا بسطح المحادثة**: فرع مواز يملكهما.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

**لا شيء.** `AgentKind` يحوي `builtin` و`AgentInstall.source` يحوي
`builtin` منذ العقد الأول؛ هذا الفرع يستعمل ما كان محجوزًا ولا يضيف مسارًا
ولا حدثًا. تسلسل أحداث التشغيل هو تسلسل العقد نفسه، لأن المشغّل يُغذّي
`sessions/run-reducer.ts` ذاته.

## الملفات والتأثير

### `models` — فعل البثّ ومنفذه

| الملف | التأثير |
|---|---|
| `packages/server/src/modules/models/adapters/types.ts` | أنواع `ChatMessage` و`ChatRequest` و`ChatEvent`، والفعل `chat` على `ProviderAdapter` |
| `packages/server/src/modules/models/adapters/stream.ts` | جديد: فتح مجرى SSE وقراءة سطوره، بمهلة وإلغاء، وتحويل الفشل إلى قيمة لا استثناء |
| `packages/server/src/modules/models/adapters/openai.ts` | `chat`: `POST {base}/chat/completions` بـ`stream: true` و`stream_options.include_usage` |
| `packages/server/src/modules/models/adapters/anthropic.ts` | `chat`: `POST {base}/v1/messages` بـ`stream: true` |
| `packages/server/src/modules/models/adapters/google.ts` | `chat`: `POST {base}/models/{id}:streamGenerateContent?alt=sse` |
| `packages/server/src/modules/models/adapters/ollama.ts` | `chat`: سطح أولاما المتوافق مع OpenAI تحت `/v1` (ADR 0012 §النتائج) |
| `packages/server/src/modules/models/adapters/elevenlabs.ts` | `chat`: رفض صريح — مزوّد صوت لا نموذج محادثة |
| `packages/server/src/modules/models/service.ts` | `chat()` يحلّ صفّ المزوّد والمفتاح والمحوّل ويحسب التكلفة من تسعيرة النموذج؛ `modelFacts()` تقول للمحوّل المباشر أيقبل النموذج صورة |
| `packages/server/src/modules/models/index.ts` | المنفذ المسجَّل لـ`agents` يكسب `directChat` و`modelFacts` |

### `agents` — الوكيل والمحوّل

| الملف | التأثير |
|---|---|
| `packages/server/src/modules/agents/catalog/direct.ts` | جديد: المدخل المدمج (`direct`، «مباشر» / "Direct"، رخصة المشروع نفسها) |
| `packages/server/src/modules/agents/catalog/types.ts` | `adapter` يقبل `builtin`؛ حقل `nameAr` الاختياري؛ `binary`/`protocolArgs` تقبل الفراغ لمدخل بلا عملية |
| `packages/server/src/modules/agents/catalog/index.ts` | تسجيل المدخل والحارس: مدخل `builtin` لا يُثبَّت، وله اسم عربي |
| `packages/server/src/modules/agents/adapters/direct.ts` | جديد: `AgentAdapter` للنوع `builtin` — جلسة في الذاكرة لكل جلسة مركز، وبثّ الدور من منفذ `models` |
| `packages/server/src/modules/agents/adapters/types.ts` | `AgentTarget.workspace`، و`PromptInput.blocks` و`modelProviderId` (اختياريان؛ المحوّلات القائمة تتجاهلهما) |
| `packages/server/src/modules/agents/adapters/index.ts` | تسجيل المحوّل تحت `builtin` |
| `packages/server/src/modules/agents/ports.ts` | `AgentModelsPort` يكسب `directChat` و`modelFacts`، وأنواعهما |
| `packages/server/src/modules/agents/service.ts` | `selectionFor` يعيد `providerId` أيضًا؛ `targetFor` يضع مساحة العمل؛ الاسم يُعرَّب عند العرض |
| `packages/server/src/modules/agents/runner.ts` | `PromptInput` يحمل الكتل ومعرّف المزوّد إلى جانب النص |
| `packages/server/src/modules/agents/index.ts` | ربط منفذ `models` بالمحوّل المباشر؛ تمرير لغة الطلب إلى `list`/`get` |

### الوثائق

`docs/domain/agents.md` (قسم «الوكيل المباشر»)، `docs/domain/models.md`
(قسم «البثّ المباشر» وحدود المرفقات)، `docs/STATUS.md`.

## حدود المرفقات (معلنة هنا وفي `docs/domain/models.md`)

| النوع | السلوك | الحدّ |
|---|---|---|
| نصّي (`text/*`، `application/json`، `*+json`، `*+xml`، `*+yaml`، وامتدادات `.md .txt .csv .tsv .log .yml .yaml .json .xml .ts .js .py .sh .sql`) | يُدرَج في نصّ الطلب داخل سياج مرمّز باسم الملف | ٦٤ ك.بايت للملف الواحد، ٢٥٦ ك.بايت لكل الملفات في الدور |
| صورة (`image/png`، `image/jpeg`، `image/webp`، `image/gif`) | تُرسَل مضمّنة base64 إلى نموذج يقبل الصور | ٥ م.بايت للصورة، ٢٠ م.بايت للدور |
| صورة إلى نموذج لا يقبل الصور | رفض الدور بـ`unsupported_media_type` مع اسم الملف واسم النموذج | — |
| أي شيء آخر (PDF، صوت، ثنائي) | رفض الدور بـ`unsupported_media_type` مع اسم الملف ونوعه وسبب الرفض | — |
| نصّي أكبر من الحدّ | رفض الدور بـ`payload_too_large` مع الحجم والحدّ | — |

الرفض دور فاشل بسبب مُسمّى، لا تجاهل صامت ولا اقتطاع بلا إخبار.

## خريطة الأخطاء

| الحال | الرمز | نصّ المزوّد |
|---|---|---|
| لا مزوّد مضبوط / لا نموذج مختار / صفّ المزوّد معطّل أو محذوف | `provider_not_configured` | — (نصّ المركز) |
| المزوّد يطلب مفتاحًا ولا مفتاح محفوظ | `provider_not_configured` | — |
| ٤٠١ / ٤٠٣ | `provider_unauthorized` | يُحفظ حرفيًا |
| ٤٢٩ | `rate_limited` | يُحفظ حرفيًا |
| ٤٠٤، أو ٤٠٠ يذكر `model_not_found` / `unknown model` / `does not exist` | `not_found` | يُحفظ حرفيًا |
| تعذّر الوصول (DNS، رفض، مهلة) | `agent_unavailable` | نصّ الشبكة |
| أي رمز آخر | `agent_error` | يُحفظ حرفيًا |
| مرفق مرفوض | `unsupported_media_type` / `payload_too_large` | — |

لا يُعاد كتابة نصّ المزوّد في أي حال؛ الرمز تسمية فوقه لا بديل عنه.

## الفحوص (الأوامر ونواتجها الفعلية)

```
pnpm lint            All matched files use Prettier code style!
pnpm typecheck       0 errors
pnpm test            contracts 11 · ui-tokens 105 · cli 64 · server 408 (2 skipped) · web 296
pnpm contract:test   254 passed
pnpm contracts:lint  OK
pnpm nav:check       OK
pnpm i18n:check      OK
pnpm build           OK
pnpm web:e2e         12 passed
```
أُعيد تشغيلها كلها على الشجرة المُركَّبة فوق `main` بعد دمج طلبات #20 و#21 و#22، لا على شجرة
وسيطة. الإثبات على حاوية حقيقية (طلب ملتقط من نقطة مكتوبة بالسيناريو) مذكور أعلاه بنصّه.

## المخاطر والرجوع

- **ذاكرة المحادثة في الذاكرة فقط**: جلسة المحوّل المباشر تحتفظ بسجلّ
  الأدوار في ذاكرة العملية (كما تحتفظ بوابة هرمس بسجلّها عندها). إعادة
  تشغيل الخادم تبدأ سياقًا جديدًا؛ نصّ المحادثة المخزَّن في `sessions`
  سليم، لكن النموذج لا يراه. الحلّ التالي منفذ نصّ من `sessions` إلى
  المشغّل، وهو تغيير في `sessions/ports.ts` يخصّ فرعًا مستقلًا.
- **بلا أدوات**: مقصود (§٢.١٦).
- **Google وOllama**: نُفِّذ البثّ لهما ولم يُختبرا إلا بنقطة نهاية مكتوبة
  في الاختبار، كحال بقية محوّلات `models` في هذا المستودع (لا شبكة في
  المجموعة).
- **الرجوع**: حذف الفرع. المدخل مدمج ولا يكتب شيئًا في مجلد البيانات، وصفّ
  `agents` الخاص به يبقى يتيمًا حتى إعادة التشغيل التالية فيُزال من
  الكتالوج عند غيابه (الصفّ يبقى لكن `agents.list` لا يعرضه كمثبَّت).

## التسليم والخطوة التالية

ينتظر مراجعة المالك ودمجه بعد `feat/chips-fork-titles`. الخطوة التالية للوضع المباشر:
المهارات والأدوات فوقه (البند ٢.١٦ في سجل ما نأخذه)، ثم حفظ سياق المحادثة خارج ذاكرة
العملية حتى لا يبدأ من الصفر بعد إعادة التشغيل.
