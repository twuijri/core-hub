# ملف الموديلات المشترك لكل المزوّدين، وفحص أسبوعي يقارنه بالمصادر العامة
المسؤول: twuijri · الفرع: feat/models-catalog-providers · الحالة: review

## المشكلة والهدف
طلب المالك (٢٠٢٦-٠٩-٢٦، بتصرّف): الملف المشترك `catalog/models.json` (طلب #172، القرار §110) لا يكفي أن يحمل صور ChatGPT فقط.
يريد فيه Anthropic وكل المزوّدين. والمزوّد الذي لا يسمح بسحب قائمته نحفظ له ملفًا بالموديلات الجديدة بالترتيب.
وأسماء الموديلات لازم تكون صحيحة حرفيًا حتى لا يفشل أي اتصال.

قبل هذا الفرع كان في الملف مدخل واحد هو `openai-codex`. وكانت فيه ثلاث مشكلات:
- لا شيء يمنع مفتاح مزوّد مكتوبًا خطأ (مثلًا `gemini` بدل `google`). مثل هذا المدخل لا يقرؤه أي مركز.
- قائمة الملف لمزوّد صوتي كانت تُوسم `chat`، فيرميها صف الإملاء أو النطق.
- قائمة Scribe الموثّقة المدمجة في الصورة (§94) لا يستبدلها الملف أبدًا.

## القرار والموافقات
مقترح، ينتظر تأكيد المالك (إضافة على §110):
- **تعبئة الملف** لكل مزوّد له قائمة ثابتة عامة. المصدر صفحات المزوّد نفسه فقط: صفحة الموديلات وصفحة الإيقاف، لا قوائم طرف ثالث.
  - لا يدخل الملف أي معرّف موقوف أو متقاعد، ولا ما هو بدعوة فقط، ولا معاينة حلّ محلها إصدار.
  - الترتيب: الأحدث والأقوى أولًا.
- **المفتاح** هو اسم الإعداد (preset slug) لمزوّد المفتاح، ومعرّف Hermes لمزوّد تسجيل الدخول. هذا ما يبحث به `service.ts`.
- **مزوّدون بلا مدخل**:
  - OpenRouter: قائمته لكل حساب وطويلة.
  - Nous Portal: قائمته 417 معرّفًا، وهي عامة بلا مفتاح فيُسأل دائمًا.
  - Deepgram: قائمته عامة بلا مفتاح (`/v1/models` = 200).
  - Azure Speech: فيه أصوات، لا معرّفات موديلات.
  - المحلية والمخصّصة (Ollama وLM Studio وLiteLLM وOpenAI-compatible): عنوانها يكتبه المستخدم.
- **قائمة المزوّد الصوتي بنوعه**: قائمة `openai-stt` تُحفظ `stt`، وقائمة `elevenlabs` تُحفظ `tts`. وحين يرجع المحوّل القائمة الموثّقة المدمجة في الصورة (مزوّد بلا نقطة قائمة، §94)، تحلّ محلها قائمة الملف وتبقى موسومة «احتياطية».
- **اختبار الملف** `models-catalog-file.test.ts` يُفشل CI في هذه الحالات:
  - مفتاح لا يبحث به أي مركز.
  - معرّف يخالف قواعد المعرّف، أو مكرر، أو يسقطه المحلّل.
  - حقل غير معروف.
  - `image_models` أو `client_version` خارج `openai-codex`.
  - معرّف محادثة داخل قائمة صوتية.
  - ملف أكبر من 64 KB.
- **فحص أسبوعي** `.github/workflows/models-catalog-watch.yml`: يعمل كل اثنين أو يدويًا. صلاحياته `contents: read` و`issues: write` فقط، بلا أي سر.
  - يشغّل `scripts/models-catalog-watch.mjs` ويقارن الملف بثلاثة مصادر:
    - كتالوج CLI Proxy API العام (`router-for-me/models`)، وأقسامه تُربط بمفاتيحنا: `claude`←`anthropic`، و`gemini`/`aistudio`←`google`، و`codex-*`←`openai-codex`، و`xai`←`xai` و`xai-oauth`.
    - `codex_client_models.json`: الظاهر فقط.
    - أسماء صور Codex في `model_definitions.go`.
  - يفتح issue واحدة (وسم `models-catalog`، وإن تعذّر إنشاء الوسم فـ`enhancement`) ويحدّثها. فيها المعرّفات التي تظهر هناك ولا تظهر عندنا، والتي عندنا ولم يعد أي مصدر يذكرها. ويغلقها حين لا فرق.
  - لا يكتب الملف ولا يدفع شيئًا؛ إنسان يراجع ويعدّل بطلب دمج.
  - المعرّف المحسوم (متقاعد ما زال مصدر يذكره، أو معرّف لنا لا يذكره مصدر) يوضع في `catalog/watch-ignore.json` فلا يُذكر في أي اتجاه.
  - «مصادر المزوّدين العامة بلا مفتاح»: جرّبناها كلها. الوحيدان اللذان يجيبان بلا مفتاح هما Nous وDeepgram، وكلاهما بلا مدخل في الملف، فلا شيء يُقارن بهما اليوم.
- هذا الفرع مبني على #172 ويجب أن يُدمج بعده.

### ملاحظات للمالك (لم تتغيّر هنا)
- الموديل الافتراضي لإعداد `openai-stt` هو `whisper-1`، وقد أعلنت OpenAI إيقافه (يتوقف ٢٠٢٧-٠٢-٢٦، والبديل `gpt-transcribe`). الملف يحمل `gpt-transcribe` وحده؛ تغيير الافتراضي مهمة منفصلة.
- في #172 قائمة صور ChatGPT فيها `gpt-image-2.5`، لكن وثائق OpenAI API تذكر `gpt-image-2.5-sunburst` و`gpt-image-2.5-flare` فقط، ولا تذكر الاسم المجرّد. وتذكر أن `gpt-image-1.5` يتوقف في ٢٠٢٦-١٢-٠١. قد يقبل خادم الاشتراك الاسم المجرّد؛ لم نجرّبه. لم يُغيَّر `openai-codex` هنا.
- `claude-haiku-4-5` لا يتقاعد قبل ٢٠٢٦-١٠-١٥ حسب صفحة Anthropic. أبقيناه لأنه الـHaiku الوحيد، ويُراجع بعد ذلك التاريخ.
- `grok-build-0.1` «early access» عند xAI. قائمة `xai-oauth` مثل قائمة `xai`؛ xAI لا توثّق هذا الدخول، ودليل Hermes يقول إنه نفس المعرّفات مع قائمة سماح من xAI.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `catalog/models.json`: 16 مدخلًا.
- جديد:
  - `catalog/watch-ignore.json`
  - `.github/workflows/models-catalog-watch.yml`
  - `scripts/models-catalog-watch.mjs` واختباره `scripts/models-catalog-watch.test.mjs`
  - `packages/server/src/modules/models/models-catalog-file.test.ts`
- `packages/server/src/modules/models/service.ts` (`keyProviderModels`): نوع القائمة الصوتية، واستبدال القائمة الموثّقة. معه اختبار في `models-catalog.test.ts`، يفشل على الكود القديم.
- `models-catalog.ts`: تصدير `MODEL_ID` و`PROVIDER_KEY`.
- `package.json`: `scripts:test` يشمل `scripts/*.test.mjs`.
- `.github/workflows/ci.yml`: اسم الخطوة فقط.
- `catalog/README.md`، `docs/STATUS.md`، `docs/contracts/DECISIONS.md` (نقطة في §110).

### جدول المزوّدين (فُحص ٢٠٢٦-٠٩-٢٦)
| المفتاح | سحب القائمة حيًّا؟ | المصدر | المعرّفات المكتوبة |
|---|---|---|---|
| `anthropic` | نعم بالمفتاح (`/v1/models`) | platform.claude.com/docs/en/about-claude/models/overview، …/model-deprecations | claude-opus-5-5، claude-fable-5-1، claude-sonnet-5، claude-haiku-4-5، claude-fable-5، claude-opus-5، claude-opus-4-8، claude-opus-4-7، claude-opus-4-6، claude-sonnet-4-6 (10) |
| `openai` | نعم بالمفتاح | developers.openai.com/api/docs/models، …/deprecations، …/pricing | gpt-6-astra، gpt-6-sol، gpt-6-luna، gpt-5.6-sol، gpt-5.6-terra، gpt-5.6-luna، gpt-5.5، gpt-5.5-pro، gpt-5.4، gpt-5.4-pro، gpt-5.4-mini، gpt-5.4-nano (12) |
| `openai-stt` | نعم بالمفتاح | نفس صفحات OpenAI، ‏guides/speech-to-text | gpt-transcribe (1) |
| `openai-tts` | نعم بالمفتاح | developers.openai.com/api/docs/guides/text-to-speech | gpt-4o-mini-tts، tts-1-hd، tts-1 (3) |
| `openai-codex` | نعم بتسجيل الدخول | من #172، لم يتغيّر | 7 + 5 صور |
| `google` | نعم بالمفتاح | ai.google.dev/gemini-api/docs/models، …/deprecations، …/changelog | gemini-3.8-flash، gemini-3.1-pro-preview، gemini-3.7-flash، gemini-3.6-flash، gemini-3.5-flash، gemini-3.5-flash-lite، gemini-3-pro-image، gemini-3.1-flash-image، gemini-3.1-flash-lite-image (9) |
| `deepseek` | نعم بالمفتاح | api-docs.deepseek.com/quick_start/pricing، …/updates | deepseek-v4-pro، deepseek-flash (2) |
| `xai` | نعم بالمفتاح | docs.x.ai/developers/models، …/release-notes، …/migration/may-15-retirement | grok-4.7، grok-4.6، grok-4.5، grok-4.3، grok-4.20-0309-reasoning، grok-4.20-0309-non-reasoning، grok-4.20-multi-agent-0309، grok-build-0.1 (8) |
| `xai-oauth` | نعم بتسجيل الدخول | نفس صفحات xAI، ودليل Hermes xai-grok-oauth | نفس الثمانية |
| `minimax-oauth` | نعم بتسجيل الدخول | platform.minimax.io/docs/guides/models-intro، …/token-plan/* | MiniMax-M3، MiniMax-M2.7، MiniMax-M2.7-highspeed (3) |
| `groq` | نعم بالمفتاح | console.groq.com/docs/models، …/deprecations | openai/gpt-oss-120b، openai/gpt-oss-20b، qwen/qwen3.8-27b (معاينة) (3). Llama للمؤسسات فقط منذ ٢٠٢٦-٠٨-١٦ |
| `groq-stt` | نعم بالمفتاح | console.groq.com/docs/speech-to-text | whisper-large-v3-turbo، whisper-large-v3 (2) |
| `groq-tts` | نعم بالمفتاح | console.groq.com/docs/text-to-speech | canopylabs/orpheus-v1-english، canopylabs/orpheus-arabic-saudi (2) |
| `mistral` | نعم بالمفتاح | docs.mistral.ai/models، …/inference/model-lifecycle | mistral-medium-latest، mistral-large-latest، mistral-small-latest، codestral-latest، ministral-14b-latest، ministral-8b-latest، ministral-3b-latest (7) |
| `elevenlabs` | نعم بالمفتاح | elevenlabs.io/docs/overview/models | eleven_v3، eleven_multilingual_v2، eleven_flash_v2_5، eleven_flash_v2 (4)؛ turbo موقوف |
| `elevenlabs-stt` | **لا** (لا نقطة قائمة) | elevenlabs.io/docs/overview/models | scribe_v2 (1)؛ scribe_v1 موقوف |
| `openrouter` | نعم | — | تُرك: لكل حساب وطويل |
| `nous` | نعم، وعامة بلا مفتاح | inference-api.nousresearch.com/v1/models | تُرك: 417 معرّفًا ويُسأل دائمًا |
| `deepgram-stt` / `deepgram-tts` | نعم، وعامة بلا مفتاح | api.deepgram.com/v1/models | تُرك |
| `azure-stt` / `azure-tts` | لا موديلات | — | تُرك: أصوات فقط |

ما تُرك عمدًا وهو ليس موقوفًا:
- قائمة Gemini 2.5: وصولها محصور بمن استعملها قبل ٢٠٢٦-٠٩-١٨.
- Claude 4.5: `claude-sonnet-4-5` يتقاعد ٢٠٢٦-٠٩-٢٩، و`claude-opus-4-5` يتقاعد ٢٠٢٦-١١-٢٤.
- `gpt-5.2`/`gpt-5.1`/`gpt-4.1`/`gpt-4o`: قديمة ما زالت مذكورة.
- `chat-latest` و`gpt-oss-*` عند OpenAI.
- `eleven_v3_conversational` و`scribe_v2_realtime`: للزمن الحقيقي.

المعرّفات التي في قوائم الطرف الثالث وليست في وثائق المزوّد، فلم تُكتب:
- `claude-fable-5.1` بنقطة.
- `gpt-5.6-*-pro`.
- `gemini-3.1-pro` و`gemini-3-pro` بلا `-preview`.
- `deepseek-v4.1-flash`.
- `grok-4.7-build-fast` و`grok-composer-2.5-fast` و`grok-3-mini`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ mj-run npx vitest run src/modules/models/models-catalog.test.ts src/modules/models/models-catalog-file.test.ts \
    src/modules/models/codex-catalogue.test.ts src/modules/models/speech-providers.test.ts   # packages/server
 Test Files  4 passed (4)
      Tests  27 passed (27)
# اختبار الملف مع مفتاح `gemini` ومعرّف `claude opus` مكتوبين خطأً (ثم أُعيد الملف):
AssertionError: gemini is neither a preset slug nor a signed-in Hermes provider id
AssertionError: anthropic: claude opus: expected false to be true
# اختبار القائمة الصوتية على service.ts القديم:
AssertionError: expected [ 'scribe_v2' ] to deeply equal [ 'scribe_v1', 'scribe_v2' ]
$ mj-run npx tsc --noEmit -p tsconfig.json   # packages/server، بلا أخطاء
$ mj-run pnpm scripts:test && pnpm lint && pnpm change-record:check
ℹ tests 37
ℹ pass 37
ℹ fail 0
All matched files use Prettier code style!
change-record  OK — 1 record(s) valid
```

تشغيل الفاحص على المصادر الحية (٢٠٢٦-٠٩-٢٦).
قبل ملء `watch-ignore.json` ذكر:
- `anthropic`: 7 معرّفات متقاعدة أو قاربت (4.5 وما قبلها).
- `google`: 12 معرّفًا (2.5، معاينات موقوفة، أسماء `-latest`). وذكر صورنا الثلاث «لم تعد مذكورة»، لأن قسمي `gemini`/`aistudio` عندهم يذكران أسماء `-preview` الموقوفة فقط.
- `openai-codex`: `codex-auto-review` (مخفي).
- `xai` و`xai-oauth`: `grok-4.7-build-fast`، `grok-3-mini`، `grok-3-mini-fast`، `grok-composer-2.5-fast`.

كلها حُسمت في `watch-ignore.json`. بعدها:
```
$ node scripts/models-catalog-watch.mjs --summary sum.json
No differences.

Not covered by these sources (check by hand): `deepseek`, `elevenlabs`, `elevenlabs-stt`, `groq`, `groq-stt`, `groq-tts`, `minimax-oauth`, `mistral`, `openai`, `openai-stt`, `openai-tts`.
{ "differences": false, "changes": [], "errors": [], "sourcesRead": 3 }
```
- `actionlint` غير مثبّت على الجهاز فلم يُشغَّل. تحقّق `yaml.safe_load` من صحة الملف فقط.
- لم يُشغَّل سير العمل الأسبوعي على GitHub بعد، فهو يعمل من `main` فقط.
- الاختبارات الكاملة على GitHub CI.

## المخاطر والرجوع
- الملف يغيّر ما تعرضه كل المراكز بعد الدمج، لكنه يظهر فقط حين يتعذّر سؤال المزوّد، وقائمة المزوّد لحسابك تفوز دائمًا.
- الخطأ الوحيد الممكن اسم لا يقبله المزوّد. كل اسم منقول من صفحة المزوّد بتاريخ اليوم، وأغلب المعرّفات فُحصت يدويًا مرة ثانية على الصفحات.
- الفاحص يعتمد على شكل ملفات CLI Proxy API. إن تغيّر الشكل يذكر الخطأ في الـissue ولا يخترع فروقًا، وإن فشلت كل المصادر يفشل التشغيل.
- `gh label create` قد يُرفض بصلاحية `issues: write`؛ عندها يُستعمل `enhancement`.
- الرجوع: إرجاع هذا الطلب. يعود الملف إلى مدخل Codex وحده، ويُحذف سير العمل.

## التسليم والخطوة التالية
طلب دمج إلى `main`، مبني على #172 ويُدمج بعده.

بعد الدمج:
- تشغيل «Models catalogue watch» يدويًا مرة.
- قرار المالك في ملاحظتي `whisper-1` و`gpt-image-2.5`.
- مراجعة `claude-haiku-4-5` بعد ٢٠٢٦-١٠-١٥.
