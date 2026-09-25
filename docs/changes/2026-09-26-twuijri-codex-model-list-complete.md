# قائمة نماذج اشتراك ChatGPT كاملة: نسأل بإصدار Codex CLI لا بـ 0.0.0
المسؤول: twuijri · الفرع: fix/codex-model-list-complete · الحالة: review

## المشكلة والهدف
بعد PR #156 (الإصدار 1.1.1) صارت قائمة `openai-codex` حيّة، لكنها ناقصة على حساب Pro للمالك:
Core Hub يعرض gpt-5.5 وgpt-5.6-luna/sol/terra وgpt-6-astra (ومعها gpt-image-2 الذي نضيفه نحن)، بينما
CLI Proxy API للحساب نفسه يعرض أيضًا gpt-6-sol وgpt-6-luna وgpt-oss-120b-medium وgpt-image-1.5.
الهدف: أن نعرض ما يعطيه الخادم للحساب كاملًا، ولا شيء نخترعه («يسحب الي يقدمه المزود ما يخترع من نفسه»).

### ما لاحظته (ADR 0012، بكلماتي)
- **Codex CLI** (openai/codex، Apache-2.0، الوسم `rust-v0.157.0`، قراءة فقط): يطلب
  `GET …/models?client_version=<إصداره>` حيث الإصدار هو إصدار الحزمة نفسه (0.157.0) بلا لاحقة؛
  وكل نموذج في الرد فيه `visibility` (`list`/`hide`/`none`) و`priority`.
- **Hermes** (MIT) في `main` بعد الوسم الذي نثبّته كتب: `0.0.0` كان يعيد كامل قائمة الحساب، لكنه منذ
  طرح GPT-6 Sol/Luna يعيد قائمة قديمة مجمّدة (astra وثلاثي 5.6)، وأي إصدار ≥ أحدث
  `minimal_client_version` يعيد كل ما يحق للحساب (مجرَّب حيًّا 2026-09-22). هذا يطابق ما رآه المالك تمامًا.
- **CLI Proxy API** (MIT، `router-for-me/CLIProxyAPI`؛ قرأت ملف بياناته وأسماء الثوابت فقط، لا نسخ):
  قائمة Codex عنده **ثابتة لكل خطة** في ملف `models.json` (codex-pro: gpt-5.5، gpt-6-astra/sol/luna،
  gpt-5.6-sol/terra/luna، codex-auto-review)؛ `gpt-oss-120b-medium` من مزوّد آخر عنده (Antigravity)
  يظهر في مجموعة GPT نفسها؛ و`gpt-image-1.5` و`gpt-image-2` أسماء تعرّفها نقطة الصور عنده وتمرّرها لأداة
  الصور في Codex. إذن هذه الثلاثة ليست من قائمة الخادم.

## القرار والموافقات
- السبب الجذري: كنا نرسل `client_version=0.0.0`، فيحجب الخادم النماذج التي تطلب عميلًا أحدث.
- نرسل إصدار آخر Codex CLI منشور: `CODEX_CLIENT_VERSION = '0.157.0'` في `live-models.ts` مع تعليق
  بمصدره وطريقة رفعه (أحدث وسم `rust-v*` في openai/codex)، ويمكن للمالك تغييره دون إصدار بـ
  `COREHUB_CODEX_CLIENT_VERSION`. لا رقم مخترع (Hermes يرسل 99.0.0؛ اخترنا رقم العميل الرسمي الحقيقي).
- إن رُفض الإصدار أو رجعت قائمة فارغة نسأل بـ `0.0.0` مرة واحدة بدل عرض لا شيء.
- الترويسات: نبقي ترويسات تعريف Hermes و`ChatGPT-Account-Id`؛ لم أجد في Codex CLI معاملًا آخر يغيّر
  القائمة غير `client_version`.
- لا نضيف gpt-oss-120b-medium (ليس من Codex) ولا gpt-image-1.5: لم يُرَ يرسم عبر اشتراك حقيقي، فبقي
  خارجًا حتى يُجرَّب (مقترح — للمالك أن يطلب إضافته بجانب gpt-image-2).
- مذكور في DECISIONS §83 (تعديل بتاريخه، لا رقم جديد).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/server/src/modules/models/live-models.ts`: `CODEX_CLIENT_VERSION`، `codexClientVersion()`،
  البرنامج يأخذ الإصدار معاملًا ويرجع إلى `0.0.0` عند الرفض أو القائمة الفارغة.
- الاختبارات: `models/codex-subscription.test.ts` (الخادم المكتوب يحجب حسب `minimal_client_version`،
  و`0.0.0` يعيد القائمة المجمّدة، وحساب يرفض الإصدار فنرجع إلى `0.0.0`)، و`codex-subscription.real.test.ts`.
- الوثائق: `docs/contracts/DECISIONS.md` (§83)، `docs/domain/models.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run`:
```
$ vitest run src/modules/models/          (server)
 Test Files  12 passed | 1 skipped (13)
      Tests  181 passed | 3 skipped (184)
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run --maxWorkers=1 --reporter=verbose \
    src/modules/models/codex-subscription.real.test.ts          # Hermes v0.21.3 (2026.9.14)
 ✓ lists the account's models with Hermes's own resolver and identity headers 394ms
 ✓ draws a PNG through the image_generation tool with the token Hermes hands the script 363ms
      Tests  2 passed (2)
```
الاختبار الجديد يثبت: الإصدار الأعلى يعيد أكثر (0.0.0 ← 3 نماذج، 0.157.0 ← 5 مع gpt-6-sol/luna،
0.200.0 ← ومعها نموذج أحدث)، وطلبنا يرسل `client_version=0.157.0`، والرجوع إلى `0.0.0` حين يُرفض.
على الكود القديم يفشل (كان يرسل `0.0.0` ثابتًا، ولا يوجد `CODEX_CLIENT_VERSION`).
حاويتا الاختبار الحقيقي بـ `--rm`؛ لم تبقَ حاوية.

أول CI (التشغيل 36199485661) فشل في جزأين من اختبارات الخادم:
- `tests/unit/config.test.ts`: قاعدة «ملف الإعداد وحده يقرأ `process.env`» — كان `live-models.ts` يقرأ
  `COREHUB_CODEX_CLIENT_VERSION` مباشرة. أُصلح: القيمة تأتي من `hub.config.hostEnv` عبر
  `LiveListing.clientVersion()`.
- `src/modules/auth/tokens.test.ts` (انتهاء صلاحية رمز): لا علاقة له بالتغيير، ونجح محليًا — تذبذب توقيت.
```
$ vitest run tests/unit/config.test.ts src/modules/auth/tokens.test.ts src/modules/models/
 Test Files  14 passed | 1 skipped (15)
      Tests  194 passed | 3 skipped (197)
```

## المخاطر والرجوع
- لم يُجرَّب على حساب حقيقي؛ إن حجب الخادم نموذجًا أحدث من 0.157.0 مستقبلًا، يُرفع الثابت أو يُضبط
  `COREHUB_CODEX_CLIENT_VERSION`.
- الرجوع: التراجع عن الدمج.

## التسليم والخطوة التالية
- المالك: «تحديث النماذج» على مزوّد ChatGPT بعد الترقية، والتأكد من ظهور gpt-6-sol وgpt-6-luna.
- قرار المالك: هل نضيف gpt-image-1.5 بجانب gpt-image-2 بعد تجربته؟
