# بوابة النماذج بعد أول تجربة حيّة: رد مقطّع لا ينتهي، وحصة منتهية، واسم «الافتراضي»
المسؤول: twuijri · الفرع: feat/model-gateway-3 (يُدمج في feat/model-gateway-2، PR #231) · الحالة: in-progress

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

**قراءة الاستهلاك عبر حدود الأحرف**: `UsageTap` يفك البايتات بـ`StringDecoder` بدل كل قطعة وحدها (نسختها فقط؛ البوابة تمرّر البايتات كما هي).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء حتى الآن.

## الملفات والتأثير
- `packages/server/src/modules/agents/adapters/event-queue.ts`، `adapters/types.ts`، `adapters/acp.ts`، `runner.ts`.
- `packages/server/src/modules/models/gateway/cliproxy-config.ts`، `usage.ts`.
- اختبارات: `agents/runner-stream.test.ts` (جديد)، `models/gateway/gateway.test.ts`، `agents/model-gateway.real.test.ts`
  (دور عربي، ودور بعد دور رفضه المزوّد عبر المشغّل الحقيقي)، `models/gateway/gateway-stream.real.test.ts` (جديد).
- CI: مهمة `model-gateway-real` تشغّل الملف الحقيقي الجديد أيضًا.

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

## المخاطر والرجوع
- رمي الأحداث المخزّنة عند بدء دور ACP: لا يقول وكيل ACP شيئًا لدور لم يبدأ بعد؛ الوكلاء الفرعيون على قناتهم الخاصة.
- بلا تبريد يصل كل طلب إلى المزوّد (كما لو كلّمه الوكيل مباشرة)؛ البوابة هي من يقرر الفشل السريع.
- **الرجوع**: عكس الالتزام؛ لا ترحيل ولا عقد.

## التسليم والخطوة التالية
دُفع إلى feat/model-gateway-2 (PR #231). التالي في المهمة نفسها: فشل سريع وواضح عند نفاد الحصة، إخفاء المعرّف الداخلي،
«الافتراضي · <نموذج>» داخل المحادثة، وسلسلة البدائل.
