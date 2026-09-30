# بوابة النماذج بعد أول تجربة حيّة: رد مقطّع لا ينتهي، وحصة منتهية، واسم «الافتراضي»
المسؤول: twuijri · الفرع: feat/model-gateway-3 (يُدمج في feat/model-gateway-2، PR #231) · الحالة: review

## المشكلة والهدف
أول تجربة حيّة على مركز المالك (صورة PR #229، ‏v1.1.5-preview.34): السلسلة تعمل (Claude Code ← بوابة المركز ← CLIProxyAPI
المرفق ← مزوّد المالك «CLI Proxy» ← المصدر). وظهر:

1. **رد مقطّع لا ينتهي** (الأولوية): بعد دور فشل بـ429 سأل المالك «هلا» على `gpt-6-sol` فوصل «لا كيفقدرساعد؟» بدل
   «هلا! كيف أقدر أساعد؟»، وبقيت المحادثة «يكتب…» و«يفكر 170 ث».
2. انتظار صامت 109 ث ثم خطأ 429 فيه معرّف المزوّد الداخلي (`h01m3az…/gemini-3.8-flash-high`)؛ المطلوب فشل سريع وواضح
   باسم المزوّد والنموذج، وألا يظهر المعرّف الداخلي للناس.
3. منتقي النماذج داخل محادثة Claude Code يقول «النموذج الافتراضي» بدل «الافتراضي · <نموذج>» (شاشة المحادثة الجديدة صحيحة).
4. النظر في سلسلة البدائل عند نفاد الحصة.

## القرار والموافقات
**السبب الجذري للبند 1 (مُثبت بإعادة إنتاج)**: ليس البوابة ولا CLIProxyAPI ولا فك UTF-8. كل دور في المحادثة يقرأ طابور أحداث
جلسة الوكيل الواحد (`adapters/event-queue.ts`) بقارئ خاص (`runner.pump`). الدور الذي ينهيه المشغّل بنفسه — رفض الوكيل
الطلب (`send()` رُفض: «API Error: 429») — كان يترك قارئه منتظرًا على الطابور للأبد، فالدور التالي يضيف قارئًا ثانيًا، والطابور
يوزّع الأحداث على المنتظرين بالتناوب: القارئ الميت يبتلع كلمة من كل اثنتين، وقد يأخذ `run.completed` فلا ينتهي الدور. الإصلاح:
- `EventQueue.iterator()` صار له `return()` يرفع انتظاره من الطابور، و`discardBuffered()`.
- المشغّل يحرّر قارئ الدور حين ينتهي الدور كيفما انتهى (`end` ← `release`)، ويقرأ بحلقة `while (!run.ended)`.
- `AgentSession.discardStale()` (اختياري؛ ACP فقط): قبل أن يبدأ دور جديد يُرمى ما قاله الوكيل بعد انتهاء الدور السابق.
- يمسّ كل المحوّلات لأنها تشترك في `EventQueue` (Hermes أيضًا بعد طلب مرفوض).

**CLIProxyAPI بلا تبريد**: بعد 429 واحد كان CLIProxyAPI «يبرّد» صف المزوّد مدة متصاعدة، فحتى بعد تعافي المزوّد يقول «All credentials
… are cooling down» بالمعرّف الداخلي. كل صف مفتاح واحد فلا بديل يُدار إليه: `routing.cooldown.disable-cooling: true`
و`routing.retry.request-retry: 0` و`max-retry-interval: 0`؛ خطأ المزوّد يعود للبوابة كما هو فتقرّر.

**حصة منتهية تفشل بسرعة وبوضوح** (DECISIONS §142، مقترح — بانتظار تأكيد المالك):
- البوابة تعرف «الحصة انتهت»: 402 من المزوّد، أو 429/403 كلماته تقول quota أو credit أو billing أو usage limit أو
  `RESOURCE_EXHAUSTED` أو `insufficient_quota` أو «cooling down» من CLIProxyAPI. تجيب فورًا بغلاف لغة الوكيل وبكلام لا يعيد
  المحاولة عليه: 429 مع `x-should-retry: false`، و`rate_limit_error` (Anthropic)، و`insufficient_quota` (OpenAI)، و`ErrorInfo`
  بسبب `MODEL_CAPACITY_EXHAUSTED` لـGemini CLI (يعدّه خطأ حصة نهائيًا — قرأته في كوده). الرسالة تسمّي المزوّد والنموذج
  بأسمائهما المعروفة. الدور نفسه لا يسأل ذلك النموذج ثانية (محاولات الوكيل تُجاب من البوابة)، والدور الجديد يسأل.
  حدّ المعدّل العابر (429 بلا تلك الكلمات) يبقى للوكيل يعيده كما كان.
- **سلسلة البدائل** (§54 تذكر حدّ المعدّل ضمن ما تُستعمل له): رخيصة وصحيحة هنا فنُفّذت — تنقل البوابة الدور إلى أول نموذج في
  السلسلة تقدر تخدمه، لبقية الدور، ويقول الدور ذلك (`model_fallback` كما يفعل Hermes). بلا بديل يفشل الدور.
- **خطأ الدور**: `rate_limited` وجملة بلغة الشخص («نفدت حصة «X» من «Y». اختر نموذجًا آخر لهذه المحادثة.») و
  `details: {reason: quota_exhausted, provider, model, provider_id, model_id}`. الوكيل الذي يكتب الخطأ جوابًا وينهي الدور
  (Goose وKimi وPi) يفشل بالطريقة نفسها؛ والذي يعيد المحاولة بنفسه دقائق (OpenCode وQwen Code، قِسته) يوقفه المركز بعد 8 ث
  (`session/cancel`)، ودور ACP التالي ينتظر انتهاء الموقوف (15 ث حدًا) ويرمي ما قاله في طريقه.
- **الويب**: ملاحظة الفشل تقول الجملة بلغة الشخص وزرًا «اختر نموذجًا آخر» يفتح منتقي المحادثة، وتظهر حتى تحت رد فيه كلام
  الوكيل عن الخطأ. تطبيق أقدم يعرض الجملة والرمز كما كان. الجوال يعرض جملة المركز (بلغة الطلب) دون زر — متابعة لاحقة.
- **لا معرّف داخلي**: أي خطأ تمرّره البوابة يُستبدل فيه `h<معرّف الصف>/…` باسم المزوّد والنموذج.
- **رفض الإعادة داخل الوكلاء نفسها**: `CLAUDE_CODE_MAX_RETRIES` موجود في Claude Code، و`request_max_retries` في Codex، لكن
  الحل عند البوابة يعمّ الوكلاء التسعة دون أن يمسّ إعادة المحاولة المفيدة لحدّ عابر، فلم أغيّرهما.
- **الحالة الحية أثناء الانتظار**: لم تُنفّذ — مع الفشل السريع لم يعد هناك انتظار طويل للحصة؛ إظهار «المزوّد مشغول، يعيد
  المحاولة» لحدّ عابر يحتاج حدثًا جديدًا في العقد، متابعة لاحقة.

**«الافتراضي · <نموذج>» داخل المحادثة**: منطق الويب صحيح حين يسمّي صف الوكيل افتراضيه (أثبتّه باختبار يرسم شاشة المحادثة، والخادم
يعيد `default_model` لـClaude Code على مصدر المركز). صورة المالك كانت من #229. أُضيف رجوع متين: إن لم يسمِّ صف الوكيل افتراضيًا
يُسمّى افتراضي البروفايل من `models.getDefaults` (للبرمجة أولًا ثم المحادثة)، في شاشة المحادثة المفتوحة والجديدة معًا. الجوال
يقرأ `default_model` منذ المرحلة الثانية، ولم يُضف له هذا الرجوع.

**قراءة الاستهلاك عبر حدود الأحرف**: `UsageTap` يفك البايتات بـ`StringDecoder` بدل كل قطعة وحدها (نسختها فقط؛ البوابة تمرّر البايتات كما هي).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا تغيير في `openapi.yaml`. `Run.error.details` موجود أصلًا في غلاف `Error` (`additionalProperties`)؛ صار يحمل تفاصيل الحصة
المنتهية. `rate_limited` موجود في `ErrorCode`. DECISIONS §142 يوثّق ذلك.

## الملفات والتأثير
- `packages/server/src/modules/agents/adapters/event-queue.ts`، `adapters/types.ts`، `adapters/acp.ts`، `runner.ts`.
- `packages/server/src/modules/models/gateway/cliproxy-config.ts`، `usage.ts`.
- اختبارات: `agents/runner-stream.test.ts` (جديد)، `models/gateway/gateway.test.ts`، `agents/model-gateway.real.test.ts`
  (دور عربي، ودور بعد دور رفضه المزوّد عبر المشغّل الحقيقي)، `models/gateway/gateway-stream.real.test.ts` (جديد).
- CI: مهمة `model-gateway-real` تشغّل الملف الحقيقي الجديد أيضًا.
- الحصة: `models/gateway/gateway.ts` و`tokens.ts` و`testing/fake-cliproxy.mjs`، `models/service.ts` (`providerLabel`)،
  `agents/ports.ts` و`runner.ts` و`adapters/acp.ts`، `sessions/ports.ts` و`run-reducer.ts` و`engine.ts` و`mappers.ts` و`schema.ts`
  (`timing.failure`، بلا ترحيل)، `server/src/i18n/{ar,en}.json`، والاختبارات `gateway.test.ts` و`runner-gateway.test.ts`
  و`sessions/run-quota-error.test.ts` (جديد) و`model-gateway.real.test.ts`.
- الويب: `chat/RunFailureNotice.tsx` و`ChatScreen.tsx` و`useComposerControls.ts` و`screens/NewChatScreen.tsx` و`i18n/{ar,en}.json`،
  واختبارات `run-quota-notice.test.tsx` و`chat-default-model.test.tsx` (جديدان) و`default-model-label.test.ts`.
- الوثائق: DECISIONS §142، `docs/guides/any-model-any-agent.md`، STATUS.

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبار الحقيقي على الكود القديم (Claude Code الحقيقي + CLIProxyAPI 8.0.4 + المشغّل) يعيد إنتاج ما رآه المالك حرفيًا:

```
 × after a turn the provider refused, the next turn streams Arabic intact and ends (the runner)
AssertionError: expected 'لا كيفقدرساعد' to be 'هلا! كيف أقدر أساعد؟'
```

وبعد الإصلاح:

```
$ COREHUB_REAL_GATEWAY=1 COREHUB_REAL_ACP_DATA=~/.cache/corehub-agent/acp-data \
    pnpm exec vitest run --project unit --maxWorkers=1 src/modules/agents/model-gateway.real.test.ts -t "Arabic"
 ✓ Claude Code streams Arabic intact, cut inside its letters, and ends the turn 1138ms
 ✓ after a turn the provider refused, the next turn streams Arabic intact and ends (the runner) 891ms
$ COREHUB_REAL_GATEWAY=1 pnpm exec vitest run --project unit --maxWorkers=1 src/modules/models/gateway/gateway-stream.real.test.ts
 ✓ an Arabic answer cut every 0..7 bytes arrives whole, and ends (8 tests)
 ✓ with reasoning between the tokens, the text is whole and ends
 ✓ through the owner’s chain (Responses → his CLIProxyAPI → Chat → ours → Messages)
      Tests  10 passed (10)
$ pnpm exec vitest run --project unit --maxWorkers=1 src/modules/agents/runner-stream.test.ts
      Tests  3 passed (3)      # على الكود القديم: 2 failed («لا كيفقدرساعد»، وانتظار لا ينتهي)
$ pnpm exec vitest run --project unit --maxWorkers=2 src/modules/agents/runner-stream.test.ts src/modules/agents/runner.test.ts \
    src/modules/agents/runner-gateway.test.ts src/modules/agents/adapters/
      Tests  161 passed | 23 skipped (184)
$ pnpm exec vitest run --project unit --maxWorkers=2 src/modules/models/gateway/gateway.test.ts src/modules/models/gateway/hub-gateway.test.ts
      Tests  26 passed (26)
$ pnpm --filter @corehub/server typecheck   # exit 0
$ pnpm lint                                 # All matched files use Prettier code style!
```

الحصة المنتهية، مع CLIProxyAPI 8.0.4 الحقيقي والوكلاء التسعة الحقيقيين والمشغّل الحقيقي (مزوّد وهمي يجيب 429
`RESOURCE_EXHAUSTED`)، ثم دور ثانٍ في المحادثة نفسها ينجح — مع ملف التقطيع العربي:

```
$ COREHUB_REAL_GATEWAY=1 COREHUB_REAL_GATEWAY_ALL=1 COREHUB_REAL_ACP_DATA=~/.cache/corehub-agent/acp-data \
    pnpm exec vitest run --project unit --maxWorkers=1 --reporter=verbose \
    src/modules/agents/model-gateway.real.test.ts src/modules/models/gateway/gateway-stream.real.test.ts
 ✓ claude-code fails within seconds, and plainly, when the provider’s quota is spent, and the chat goes on 511ms
 ✓ codex fails within seconds, … 548ms
 ✓ gemini-cli fails within seconds, … 5360ms
 ✓ goose fails within seconds, … 7414ms
 ✓ opencode fails within seconds, … 9681ms
 ✓ qwen-code fails within seconds, … 9261ms
 ✓ kimi-code fails within seconds, … 934ms
 ✓ grok-build fails within seconds, … 538ms
 ✓ pi fails within seconds, … 1478ms
 ✓ after a turn the provider refused, the next turn streams Arabic intact and ends (the runner) 868ms
 ✓ (والتسعة round-trip، وتقطيع العربي 0..7 بايت، وسلسلة المالك)
 Test Files  2 passed (2)
      Tests  31 passed (31)
```

قبل إيقاف المركز للدور قِست: OpenCode أنهى بعد 76 ث، وQwen Code لم ينهِ في 300 ث؛ وGoose وKimi وPi كانت تنهي الدور «ناجحًا»
بنص الخطأ. وقبل إصلاح الانتظار في ACP كان الدور التالي بعد إيقاف OpenCode/Qwen ينتهي فارغًا.

```
$ pnpm exec vitest run --project unit --maxWorkers=2 src/modules/agents/ src/modules/models/gateway/ \
    src/modules/sessions/run-reducer.test.ts src/modules/sessions/run-quota-error.test.ts \
    src/modules/sessions/direct-fallback.test.ts src/modules/sessions/sessions-run.test.ts src/modules/sessions/direct-run.test.ts
 Test Files  75 passed | 24 skipped (99)
      Tests  890 passed | 88 skipped (978)
$ pnpm --filter @corehub/web exec vitest run --maxWorkers=2 <كل اختبار يرسم ChatScreen/NewChatScreen/RunFailureNotice> \
    tests/run-quota-notice.test.tsx tests/default-model-label.test.ts
 Test Files  10 passed (10)
      Tests  71 passed (71)
$ pnpm typecheck   # exit 0
$ pnpm lint        # All matched files use Prettier code style!
$ pnpm i18n:check  # ios: 2734 keys, ar/en in parity · android: 2593 keys, ar/en in parity · OK
```

## المخاطر والرجوع
- رمي الأحداث المخزّنة عند بدء دور ACP: لا يقول وكيل ACP شيئًا لدور لم يبدأ بعد؛ الوكلاء الفرعيون على قناتهم الخاصة.
- بلا تبريد يصل كل طلب إلى المزوّد (كما لو كلّمه الوكيل مباشرة)؛ البوابة هي من يقرر الفشل السريع.
- تصنيف «الحصة انتهت» بالكلمات: 429 من Google لحدّ الدقيقة يقول أيضًا «Resource has been exhausted» فيُعامل كحصة منتهية
  (طلب المالك صراحة: فشل سريع). الدور التالي يسأل من جديد.
- إيقاف الوكيل بعد 8 ث يعتمد على `session/cancel` في ACP؛ جُرّب مع OpenCode وQwen Code.
- **الرجوع**: عكس الالتزامات؛ لا ترحيل (حقل JSON اختياري في `runs.timing`) ولا تغيير في العقد.

## التسليم والخطوة التالية
دُفع إلى feat/model-gateway-2 (PR #231). التالي: تجربة المالك على صورة من feat/model-gateway-2؛ تأكيد مقترحات §142؛ متابعات:
حالة حية «المزوّد مشغول، يعيد المحاولة» لحدّ عابر (حدث جديد في العقد)، وزر «اختر نموذجًا آخر» على iOS وAndroid، ورجوع الجوال
إلى افتراضي البروفايل.
