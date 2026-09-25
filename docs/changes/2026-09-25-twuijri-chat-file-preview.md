# معاينة ملفات المحادثة بجانبها
المسؤول: twuijri · الفرع: feat/chat-file-preview · الحالة: review

## المشكلة والهدف
قال المالك (٢٠٢٦-٠٩-٢٥): «وبذات اني اقدر استعرض الملفات بالمحادثه». حين يكتب الوكيل ملفًا أو
يعدّله أثناء المحادثة (في مجلد عمل الجلسة تحت `/data/workspaces/<profile>/…`، أو شجرة عمل المهمة)،
أو يرفق الشخص ملفًا، يفتحه الشخص في لوحة **بجانب المحادثة** دون تنزيل: HTML وPDF والصور وMarkdown
والكود والنص وCSV وXLSX وDOCX وPPTX، وما سواها معلوماته وزر تنزيل.

## القرار والموافقات
موافقة المالك على الهدف: كلامه أعلاه، وهو أولويته في هذه الدفعة. قرار العقد: DECISIONS §48
(§46 يطالب به طلبا دمج مفتوحان #104 و#105، فأُخذ §48 لتفادي التصادم؛ §47 يبقى لمن يُدمج منهما ثانيًا).

قرارات منتج جديدة — **مقترحة، والمالك يؤكد**:
- **الحد هو مجلد عمل الجلسة، لا البروفايل**: المحادثة تقرأ مجلدها وحده. جلسة المهمة تعمل في مجلد
  تشغيلها (وهو شجرة git الخاصة بالمهمة حين تكون لها، #105)، فتغطيها القاعدة نفسها بلا جذر ثانٍ.
- **HTML يُعرض في إطار معزول** (`sandbox="allow-scripts"` بلا `allow-same-origin`) مع سياسة CSP:
  تعمل سكربتات الصفحة، وتُحمَّل السكربتات والأنماط والصور والخطوط عبر https (فالتقرير الذي يرسم
  بمكتبة من CDN يرسم)، لكنها **لا تتصل بشيء** (`connect-src 'none'`) ولا ترسل نموذجًا ولا تفتح
  إطارًا. «افتح في تبويب جديد» يفتح إطارًا معزولًا حول الصفحة، لا الصفحة نفسها بأصل التطبيق؛ ولا
  يُفتح SVG في تبويب أصلًا. الروابط النسبية داخل الصفحة (صورة بجانبها) لا تُحمَّل — انظر المخاطر.
- **حدود المعاينة لكل نوع**: HTML ٥ م.ب، PDF ٣٠، الصور ٢٠، Markdown والكود والنص ٢، CSV ٥،
  Office ١٥؛ فوقها «أكبر من أن يُعرض هنا» مع التنزيل. التنزيل حده ١٠٠ م.ب.
- **قراءة المجلد محدودة**: أربعة مستويات، ٢٠٠٠ مدخل يُنظر فيها، ٢٠٠ ملف تُعرض (الأحدث)،
  والمجلدات المخفية (`.git`، مجلدات تشغيل المركز `.corehub`) و`node_modules` تُتخطى — إلا ملفًا
  سمّته أداة.
- **ملفات أوفيس تُقرأ في المتصفح** بـ `fflate` (MIT، يُحمَّل عند أول ملف أوفيس فقط: ١٣٫٥ ك.ب،
  ٥٫٧ مضغوطًا) وبحدود ZIP صارمة (٥٠٠٠ مدخل، ٣٠ م.ب للجزء، ١٢٠ م.ب للمجموع كما يصرّح الأرشيف، وكل
  جزء يُفك في مخزن بحجمه المصرَّح بالضبط). لم يُستعمل `mammoth` لـ DOCX: يفك بلا حدود ويضيف
  وزنًا؛ المستند يُرسم نصًّا وعناوين وقوائم وجداول بعناصر React (لا HTML يحتاج تعقيمًا). PPTX
  **مخطط** بعناوين الشرائح ونصوصها لأنه لا مُرسِم صغير بترخيص متساهل، والواجهة تقول ذلك.
- **القائمة تُقرأ من جديد** عند انتهاء استدعاء أداة أو تغيّر حالة تشغيل (لا حدث لحظي جديد)، وتبويب
  الملف المفتوح يُعاد تحميله حين يتغير `modified_at` أو الحجم.
- **الروابط**: اسم ملف في الرد (كلمة كاملة، أو `code`، أو رابط Markdown نسبي) يصير رابطًا فقط إن
  طابق مسار ملف مسرود أو اسمه الفريد؛ لا تخمين في النص.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عمليتان جديدتان: `sessions.listFiles` — `GET /sessions/{session_id}/files`، و`sessions.readFile`
  — `GET /sessions/{session_id}/files/content?path=&download=` (200 بايتات، 400 خارج المجلد/رابط
  رمزي/ليس ملفًا، 404، 413).
- مخططات جديدة: `SessionFile`, `SessionFileList`, `SessionFilePreview`, `SessionFileSource`.
- لا حدث لحظي جديد ولا تغيير في قائم. DECISIONS §48، و`COVERAGE.md` (صف المحادثة).
- إضافة متوافقة: وكيل ACP يُسجَّل الآن `rawInput` استدعائه (مع `locations` ومسارات `diff`) كوسائط
  الاستدعاء بعد أن كانت `{}`.

## الملفات والتأثير
الخادم (`packages/server`):
- `modules/sessions/files.ts` (جديد): `resolveInside` (كل مقطع `lstat`، لا روابط رمزية، ملف عادي
  فقط)، `openInside` (`O_NOFOLLOW` والحجم من الواصف المفتوح)، `fileTypeOf` (النوع من الاسم، والكود
  `text/plain`)، `scanFolder` المحدود، `fileRefsOf` (مسارات الأدوات **مع التشغيل** — أساس «ملفات كل
  تشغيل» القادمة)، `listSessionFiles`.
- `modules/sessions/service.ts`: `listFiles`, `openFile`. `modules/sessions/routes.ts`: المساران،
  بترويسات `nosniff` و`CSP: sandbox; default-src 'none'` و`no-store` و`Content-Disposition`.
- `modules/agents/adapters/acp.ts`: `acpToolInput`.
- الاختبارات: `sessions/files.test.ts`, `sessions/files-api.test.ts`,
  `agents/adapters/adapters.test.ts` (توقع `input` + اختبار `acpToolInput`)،
  `tests/contract/files.contract.test.ts`.

الويب (`packages/web`):
- `src/files/` (جديد): `context.tsx` (الملفات والتبويبات، `useOpenFile`)، `queries.ts`،
  `FilePreviewPanel.tsx` (التبويبات، التنزيل، التبويب الجديد، عرض المصدر، المعاينة لكل نوع)،
  `FilesList.tsx` (زر «الملفات» والقائمة)، `OfficePreview.tsx` (كسول)، `office/{zip,xlsx,docx,pptx}.ts`،
  `csv.ts`, `html.ts`, `kinds.ts`, `mentions.ts`.
- `chat/ChatScreen.tsx` (المزوّد حول الإطار، الزر في العنوان)، `chat/ToolCallCard.tsx` (رابط الملف في
  بطاقة الأداة)، `chat/Markdown.tsx` (روابط أسماء الملفات)، `chat/MessageView.tsx` (المرفقات تُفتح).
- `shell/pane.tsx` (`usePaneOptional`)، `styles/chat.css` (أنماط الملفات، واللوحة ملء الشاشة على
  الهاتف)، `ui/icons.tsx` (`IconExternal`)، `types.ts`، `i18n/{ar,en}.json` (مفاتيح `files.*`).
- `package.json` + `pnpm-lock.yaml`: `fflate ^0.8.3`.
- `e2e/hub.ts` (سيناريو «اكتب الملفات» وخطوة `write`)، `e2e/zzzzzz-chat-files.spec.ts` (الرحلة ٣٢)،
  `e2e/shots/32-chat-files-*.png`، `tests/file-preview.test.tsx`.

الوثائق: `docs/contracts/DECISIONS.md` §48، `docs/contracts/COVERAGE.md`، `docs/STATUS.md` (٢٠٧ من
٢٦٥)، `THIRD-PARTY-NOTICES.md` (fflate).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا ما يمسّه التغيير فقط (قاعدة السرعة)؛ الحزم الكاملة يشغّلها CI:
```
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!
$ pnpm typecheck
exit=0
$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 290 client file(s) scanned, 177 contract path(s) known.
$ pnpm contract:test
 Test Files  5 passed (5)
      Tests  277 passed (277)
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ (server) vitest run --project unit src/modules/sessions/files.test.ts src/modules/sessions/files-api.test.ts src/modules/agents/adapters/adapters.test.ts tests/unit/status.test.ts
 Test Files  4 passed (4)
      Tests  36 passed (36)
$ (web) vitest run tests/file-preview.test.tsx tests/tool-calls.test.tsx tests/message-layout.test.tsx tests/trajectory.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/ui-layer.test.ts
 Test Files  7 passed (7)
      Tests  234 passed (234)
$ pnpm build
dist/assets/OfficePreview-CcEmTM80.js     13.45 kB │ gzip:   5.66 kB │ map:   134.74 kB
dist/assets/index-CXmlSyAS.js          1,498.58 kB │ gzip: 451.01 kB │ map: 5,994.91 kB
✓ built in 784ms
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-chat-files.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-chat-files.spec.ts:36:1 › 32. files a run wrote open beside the chat from the Files list and the tool card (2.8s)
  1 passed (9.1s)
```
الرحلة ٣٢ تثبت: الملفات الثلاثة في القائمة؛ HTML في إطار `allow-scripts` وسكربته يعمل ولا يصل إلى
الصفحة الأم؛ «افتح في تبويب جديد» إطار معزول كذلك؛ عرض المصدر؛ CSV جدول؛ Markdown من رابط بطاقة
الأداة؛ اسم في الرد يفتح ملفه؛ تشغيل ثانٍ يعيد كتابة التقرير فيتحدّث تبويبه المفتوح؛ وعلى الهاتف
(٣٩٠×٨٤٤) اللوحة ملء الشاشة وتُغلق إلى المحادثة.

الاختبارات الجديدة تفشل على الكود القديم: تستورد `files.ts` و`src/files/*` غير الموجودة، والمساران
كانا `404`/`501`، واختبار ACP كان يتوقع استدعاءً بلا `input`.

**CI**: النتيجة في طلب الدمج (تُحدَّث هنا بعد اخضراره).

## المخاطر والرجوع
- **لم يُجرَّب على Hermes حقيقي**: مسارات أدوات Hermes تُقرأ من وسائطه أو من سطر المعاينة لأدوات
  الملفات (`write_file`, `patch`…)؛ إن لم يرسل Hermes المسار فالملف يظهر من قراءة المجلد على أي حال
  (بلا رابط في بطاقة الأداة). وكلاء ACP: المسارات من `rawInput`/`locations`/`diff` في `tool_call`
  الأول فقط؛ ما يأتي في تحديثات لاحقة لا يُسجَّل.
- **HTML**: الموارد النسبية (صورة بجانب التقرير) لا تُحمَّل في الإطار؛ والصفحة تستطيع تحميل
  موارد https (تتبّع ممكن نظريًا، ولا وصول لبيانات التطبيق).
- **الأرقام والتواريخ في XLSX** تُعرض كما خُزّنت (التاريخ رقمه التسلسلي)؛ DOCX بلا صور ولا تخطيط.
- **الأداء**: القائمة تُقرأ مع كل أداة تنتهي؛ القراءة محدودة (٢٠٠٠ مدخل) لكنها قراءة قرص في كل مرة.
- الرجوع: استرجاع الـ commits؛ لا ترحيل قاعدة بيانات ولا حدث جديد. تغيير ACP (`input` صار `rawInput`)
  يظهر وسائط أكثر في بطاقات أدوات ACP فقط.

## التسليم والخطوة التالية
طلب دمج إلى `main` بالإنجليزية للمراجعة؛ المالك يؤكد القرارات المقترحة أعلاه ويجرّب على Hermes
حقيقي في بيئة التست. **المهمة التالية**: «الملفات التي غيّرها كل تشغيل» (قائمة فروق تحت الرد)،
تبني على `fileRefsOf` (المراجع مع تشغيلها) ومسار `GET /sessions/{id}/runs/{run_id}/files` المقترح
في §48.
