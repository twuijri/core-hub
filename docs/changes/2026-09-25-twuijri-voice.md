# الصوت في عميل الويب: إملاء، قراءة الردود، والوضع الصوتي
المسؤول: twuijri · الفرع: feat/voice · الحالة: review

## المشكلة والهدف
زر الميكروفون في الملحّن كان معطّلًا ويقول إن `models.transcribe` ما زال `501`، وزر «استمع»
تحت كل رسالة معطّل كذلك. صفحة النماذج فيها تبويبا «تحويل الكلام إلى نص» و«تحويل النص إلى كلام»
لكنهما يعرضان المزوّدين ويقولان «لم يُختَر مزوّد» دون أي مكان للاختيار، فلا يصبح الكلام جاهزًا
أبدًا من الويب — وهذا ما سمّاه تقرير المراقب «مزوّدو كلام يعملون فعلًا». والمزوّد المخصّص
(خادم كلام متوافق مع OpenAI) لم يكن يُضاف إلا كمزوّد محادثة، ويُرفض بلا مفتاح عند التحويل.

الهدف: إملاء حقيقي عبر مزوّد STT في المركز، وقراءة الردود عبر مزوّد TTS، ووضع صوتي كامل
الشاشة، وتبويبا الكلام في النماذج يعملان من البداية إلى النهاية.

## القرار والموافقات
قرار العقد §55 (رقم 54 أخذه طلب #121) في `docs/contracts/DECISIONS.md` — **مقترح، بانتظار تأكيد المالك**:

- **الخادم:** بُني `models.transcribe`: التسجيل يُقرأ من `multipart/form-data` (قارئ المركز
  الوحيد الذي تسجّله وحدة `knowledge`) بأي ترتيب للحقول، حتى 25 م.ب (سقف Whisper؛ `413`
  فوقه)، ويُرسل إلى مزوّد STT المختار للبروفايل عبر واجهة OpenAI `audio/transcriptions`،
  ولا يُحفظ شيء. كل فشل مسمّى: `422 no_stt_provider` / `provider_disabled` / سبب المزوّد
  بكلماته، و`400 no_speech` للتسجيل الصامت. الامتداد يُضاف لاسم الملف من نوعه (المتصفح
  يسمّيه `blob`). المزوّد المخصّص بنوع `stt`/`tts` يُسأل بلا مفتاح في الاتجاهين.
- **الويب — الإملاء:** الميكروفون يسجّل (`MediaRecorder`) ثم يرسل التسجيل إلى المركز ويضع
  النص في الملحّن للمراجعة؛ لا يُرسل شيئًا بنفسه. لغة الإملاء (تلقائي / العربية / English)
  في قائمة صغيرة بجانب الميكروفون، محفوظة في `Preferences.voice.dictation_language` على
  المركز. بلا مزوّد STT: متعرّف المتصفح نفسه (Web Speech API) إن وُجد، مع سطر يقول ذلك؛
  وبلا الاثنين: رسالة واضحة ورابط إلى النماذج ← تحويل الكلام إلى نص.
- **الويب — القراءة:** زر مكبّر تحت كل رد يقرأه عبر TTS المركز أو يوقفه؛ الرد يُقسَّم على
  حدود الجمل إلى قطع ≤ 400 حرف (أقل بكثير من حد العقد 2 000)، وكتلة الكود تُعلَن «كتلة كود»
  ولا تُتلى، وعلامات Markdown والروابط تُحذف. القطعة التالية تُجلب أثناء تشغيل الحالية.
  «اقرأ الردود تلقائيًا» في القائمة نفسها (`Preferences.voice.auto_speak`). بلا مزوّد TTS
  يُستعمل صوت المتصفح إن وُجد، وإلا يقول الزر السبب مع رابط النماذج.
- **الويب — الوضع الصوتي:** شاشة كاملة: اضغط (أو اضغط مطوّلًا) لتتكلم ← تحويل ← إرسال ←
  الرد يُقرأ جملةً جملة أثناء وصوله ← يستمع من جديد. الحالة ظاهرة دائمًا (أستمع / أحوّل /
  أفكّر / أتكلّم) وزر «قاطِع» يوقف الصوت والتشغيل ويستمع. لا مزوّد يبثّ، فهو دورًا بدور،
  والشاشة تقول ذلك.
- **صفحة النماذج:** بطاقة أعلى تبويبي الكلام تختار مزوّد البروفايل وتضبط نموذجه ولغته وصوته
  (مع قائمة الأصوات إن كان المزوّد يعطيها) وشارة «جاهز» من المركز نفسه وزر «جرّب الصوت».
  نافذة «إضافة مزوّد» ← مخصّص تسأل عن نوعه: محادثة / تحويل كلام إلى نص / تحويل نص إلى كلام.
- **لماذا لا يُحترم `input_mode` / `output_mode` في الويب:** المتعرّف في Chrome خدمة سحابية
  لشركة المتصفح، فتسميته «على الجهاز» تضلّل؛ الويب يستعمل المركز متى كان جاهزًا والمتصفح
  احتياطًا فقط، ويترك الحقلين للهواتف (§55). مقترح.

لم يُشغَّل Hermes حقيقي ولا Docker: المهمة لا تمسّ Hermes.

## العقد
- `models.transcribe`: وصف كامل للأخطاء، وحقل multipart اختياري جديد `duration_ms`
  (إضافي، لا يكسر عميلًا). لا مسار ولا حدث جديد.
- `docs/contracts/DECISIONS.md` §55.

## الملفات والتأثير
- الخادم: `packages/server/src/modules/models/{index.ts,service.ts}` (المسار وقارئ التسجيل
  و`transcribe` و`activeSpeechRow` الذي يحلّ المزوّد كما تحلّه التبويبات)،
  `adapters/{types.ts,http.ts,openai.ts}` (`transcribe` و`requestForm` والتحويل بلا مفتاح
  للمزوّد الذي لا يطلبه)، `src/i18n/{ar,en}.json`.
- الاختبارات: `speech-api.test.ts` (جديد: OpenAI مبرمج + خادم كلام HTTP حقيقي على منفذ
  محلي)، `tests/contract/speech.contract.test.ts` (جديد)، حذف اختبار «ما زال 501» من
  `models-api.test.ts`.
- الويب: `src/voice/` (جديد: `chunking.ts`, `recorder.ts`, `player.ts`, `speech-api.ts`,
  `useDictation.ts`, `context.tsx`, `DictationControls.tsx`, `SpeakButton.tsx`,
  `VoiceStage.tsx`)، `chat/{Composer,ChatScreen,MessageActions,MessageView}.tsx`،
  `models/{SpeechCard.tsx,ModelsScreen.tsx,AddProviderDialog.tsx,queries.ts}`،
  `ui/Dialog.tsx` (حجم `full`)، `styles/chat.css`، `i18n/{ar,en}.json`،
  تعليق قديم في `attachments/queries.ts`.
- اختبارات الويب: `tests/voice-{chunking,recorder}.test.ts`, `tests/voice-dictation.test.tsx`
  (جديدة)، حذف اختبار «الميكروفون معطّل» من `tests/composer.test.tsx`، ورحلة Playwright
  `e2e/zzzzzzz-voice.spec.ts` مع STT/TTS مبرمجين في `e2e/hub.ts`، ولقطتان جديدتان.
- الوثائق: `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، ما يمسّه التغيير فقط (عبر `mj-run`):

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm i18n:check
i18n:check  web: 1372 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 295 client file(s) scanned, 176 contract path(s) known.
$ pnpm --filter @corehub/server typecheck && pnpm --filter @corehub/web typecheck
(no errors)
$ (server) vitest run --project unit models-api.test.ts speech-api.test.ts adapters/adapters.test.ts
 Test Files  3 passed (3)
      Tests  65 passed | 1 skipped (66)
$ (server) vitest run --project contract contract.test.ts speech.contract.test.ts
 Test Files  2 passed (2)
      Tests  269 passed (269)
$ (web) vitest run composer voice-chunking voice-recorder voice-dictation message-layout models-screen i18n logical-css
 Test Files  8 passed (8)
      Tests  252 passed (252)
$ pnpm build && PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzzz-voice.spec.ts
  ✓  1 [chromium] › e2e/zzzzzzz-voice.spec.ts:51:1 › 32. dictation lands in the composer, a reply is read aloud, and voice mode goes round (5.6s)
  1 passed (11.8s)
```

الاختبارات الجديدة تفشل على الكود القديم: `models.transcribe` كان يجيب `501`، والميكروفون
وزر القراءة كانا معطّلين.

CI على طلب الدمج #123 (التشغيل 36092725337، قبل إعادة ترقيم القرار إلى §55 فقط):

```
Lint, typecheck, contracts, tests, build            pass  13m10s
Web smoke journeys (Playwright against the real hub) pass  5m40s
Docker image builds and answers /health             pass  2m43s
db:generate + db:migrate (SQLite and PostgreSQL)    pass  1m3s
PR leaves graphify-out/ to the code-map bot         pass  9s
PR adds or updates a change record                  pass  12s
```

## المخاطر والرجوع
- **المتصفحات:** Safari يسجّل `audio/mp4`؛ Whisper يقبله، وأي خادم متوافق قد لا يقبله. Firefox
  بلا Web Speech API، فالاحتياط غير متاح فيه (يقول ذلك ويربط بالنماذج).
- **التشغيل التلقائي:** قراءة الردود تلقائيًا قد يمنعها المتصفح قبل أول تفاعل مع الصفحة؛
  الفشل يظهر بجانب الرد لا بصمت.
- **التكلفة:** كل قطعة طلب TTS منفصل؛ القراءة التلقائية مطفأة افتراضيًا.
- **غير مجرّب بعد:** مفتاح OpenAI حقيقي، وخادم Whisper محلي حقيقي — مثبت فقط مقابل مزوّدين
  مبرمجين وخادم HTTP محلي مكتوب.
- الرجوع: التراجع عن الطلب يعيد `models.transcribe` إلى `501` والأزرار المعطّلة؛ لا
  هجرة قاعدة بيانات ولا تغيير في التفضيلات المخزّنة.

## التسليم والخطوة التالية
- طلب الدمج بالإنجليزية إلى `main`، والمالك يؤكد §55 (خصوصًا: الويب يترك
  `input_mode`/`output_mode` للهواتف، وقراءة الردود بقطع ≤ 400 حرف).
- بعد الدمج: تجربة المالك بمفتاح OpenAI حقيقي على ستاك التست.
- لاحقًا: STT لـ ElevenLabs (Scribe) إن أراده المالك؛ بث حقيقي إن ظهر مزوّد يبثّ.
