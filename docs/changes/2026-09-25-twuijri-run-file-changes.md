# الملفات التي غيّرها كل تشغيل، مع الفروق
المسؤول: twuijri · الفرع: feat/run-file-changes · الحالة: review

## المشكلة والهدف
بعد معاينة ملفات المحادثة (#106، §48) بقي سؤال الشخص بعد كل رد: **ماذا غيّر الوكيل في ملفاتي في هذا
التشغيل؟** الهدف: تحت آخر رد لكل تشغيل بطاقة مختصرة «غيّر N ملفات (+a −b)» تسرد كل ملف بعدد أسطره
المضافة والمحذوفة، والضغط على ملف يفتح فروقه في لوحة الملفات بجانب المحادثة (موحّدة بأرقام الأسطر،
وجنبًا إلى جنب على الشاشة العريضة)، مع زر يفتح الملف نفسه. وتظهر البطاقة على التشغيلات القديمة
متى سُجّلت بياناتها. هذا الطلب مكدّس على #106 (stacked) لأنه يبني على لوحته وعلى مراجع الأدوات.

## القرار والموافقات
المهمة من المالك (موجز الليلة ٢٠٢٦-٠٩-٢٥: «الملفات التي غيّرها كل تشغيل» كانت الخطوة التالية التي
سمّاها #106). المالك نائم، فالقرارات التالية **مقترحة، والمالك يؤكد**؛ قرار العقد DECISIONS **§49**
(§47 لطلب شجرات المهام #105 المفتوح، و§48 لمعاينة الملفات #106).

- **يُسجَّل عند نهاية التشغيل ولا يُعاد حسابه**: تُلتقط حالة مجلد العمل قبل تسليم الدور للوكيل،
  وتُقارن بالمجلد عند نهايته، ويُحفظ الناتج — الملفات وفروقها — مع التشغيل. فالجواب هو ما فعله
  *ذلك التشغيل* مهما تغيّرت الملفات بعده. وتُكتب التغييرات **قبل** إرسال `run.completed` فيجدها
  العميل حين يعيد القراءة.
- **git حين يكون المجلد داخل مستودع أو شجرة عمل** (جلسة المهمة في شجرتها، #105): يُكتب المجلد
  شجرةَ git عبر **نسخة** من الفهرس (`GIT_INDEX_FILE`) في البداية والنهاية، وتقارن git الشجرتين
  (`--numstat`، والنقل بـ `-M`، ورقعة لكل ملف). تُحسب التعديلات المتتبَّعة والملفات غير المتتبَّعة،
  لا المتجاهَلة ولا مجلدات المركز `.corehub`. **فهرس الشخص وفرعه ومخبؤه لا تُمس.** ملف غير متتبَّع
  أكبر من ٢ م.ب لا يُكتب في كائنات المستودع (كان سيضخّم `.git` كل تشغيل): يُقارن بحجمه ووقته وفرقه
  `too_large`. مجلد يتجاهله المستودع يُقرأ مجلدًا عاديًّا. كل أمر git مصفوفة وسائط بمهلة ٢٠ ثانية
  وحد للمخرجات و`core.fsmonitor=false`.
- **لقطة حين لا git**: يُقرأ المجلد في البداية إلى ٨ مستويات و١٠٬٠٠٠ مدخل (`complete: false` بعدها)،
  وتُحفظ في الذاكرة الملفات النصية حتى ٢٥٦ ك.ب (٨ م.ب للتشغيل، و٤ م.ب إضافية لملف تسمّيه أداة
  أثناء التشغيل ولم تحفظه البداية). الفروق يحسبها المركز (Myers، ٣ أسطر سياق؛ فوق ٥٠٬٠٠٠ سطر أو
  ٢٠٠٠ تعديل يَعُد فقط). ملف تغيّر بلا نسخة سابقة يُسرد بلا أعداد و`diff: unavailable`. والنقل يُعرف
  حين تظهر بايتات ملف محذوف بعينها باسم آخر.
- **الحدود**: ٢٠٠ ملف تُحفظ لكل تشغيل (الأوائل بالمسار؛ المجاميع تعدّ الكل و`truncated` تقول ذلك)،
  ٢٥٦ ك.ب فرقًا للملف (يُقص عند سطر)، ٢ م.ب فروقًا للتشغيل (ما بعدها `too_large`)، ١ م.ب أكبر ملف
  يُحسب فرقه بلا git. الثنائي (بايت NUL في أول ٨٠٠٠، اختبار git) `binary` بلا أعداد.
- **ثلاث عمليات ولا حدث لحظي**: القائمة لكل الجلسة (`GET /sessions/{id}/changes`) لتُرسم البطاقات
  كلها بطلب واحد، وتشغيل واحد، وفرق ملف واحد نصًّا يرسمه العميل. المسار الذي اقترحه §48
  (`…/runs/{run_id}/files`) صار `…/changes` كي لا يُقرأ قائمة ملفات ثانية.
- **الواجهة**: البطاقة تحت **آخر** رد للتشغيل فقط، بخمسة ملفات ثم «اعرض الكل»؛ صيغ الجمع العربية
  الست (`Intl.PluralRules`)؛ البطاقة باتجاه لغة الواجهة داخل صف المحادثة الثابت يسارًا-يمينًا،
  والمسارات والأعداد والكود LTR معزولة. الفرق تبويب في لوحة #106 (`diff:<run>:<path>`)؛ «جنبًا إلى
  جنب» يظهر من عرض ١٠٢٤ بكسل.

مرفوض: إعادة حساب الفرق عند الطلب من معرّفي الشجرتين (كائنات git غير المرجعية يحذفها `git gc`، والمجلد
العادي لا نسخة ثانية له)؛ الاعتماد على فروق أدوات ACP وحدها (Hermes لا يرسلها، وأمر shell يكتب ملفًا
لا يرسل شيئًا)؛ commit أو ref مخفي في مستودع الشخص كل تشغيل (يغيّر مستودعه)؛ حدث لحظي لكل تغيير.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- ثلاث عمليات جديدة: `sessions.listChanges` — `GET /sessions/{session_id}/changes` (صفحة
  `cursor`/`limit`)، `sessions.getRunChanges` — `GET /sessions/{session_id}/runs/{run_id}/changes`
  (404 إن لم يُسجَّل شيء)، `sessions.getRunChangeDiff` —
  `GET /sessions/{session_id}/runs/{run_id}/changes/diff?path=` (400 بلا `path`، 404 لملف لم يغيّره).
- مخططات جديدة: `RunFileChangeKind`, `RunFileDiffState`, `RunFileChange`, `RunChanges`,
  `RunChangesList`, `RunFileDiff`. لا حدث جديد ولا تغيير في قائم.
- DECISIONS §49، و`COVERAGE.md` (صف المحادثة). قاعدة البيانات: الترحيل `0016` — جدول
  `run_file_changes` وعمود `runs.changes` (والتشغيلات الأقدم `NULL` بلا صفوف).

## الملفات والتأثير
الخادم (`packages/server`):
- `modules/sessions/run-changes.ts` (جديد): `startChangeTracking` بطريقتيه (`GitTracker`,
  `SnapshotTracker`)، `runGit` (spawn بمصفوفة، مهلة، حد مخرجات)، والحدود `CHANGE_CAPS`.
- `modules/sessions/line-diff.ts` (جديد): فرق الأسطر (Myers) والكتل الموحّدة و`isBinary`.
- `modules/sessions/engine.ts`: `trackChanges` قبل `runner.start`، `touch` عند بدء أداة تسمّي ملفًا
  (`fileRefsOf` من #106)، `recordChanges` في `finalise` قبل الحدث النهائي.
- `schema.ts` (`runFileChanges`, `runs.changes`)، `store.ts` (`saveRunChanges`, `runFileChangesOf`,
  `runFileChange`, `runsWithChanges`)، `mappers.ts`، `service.ts`، `routes.ts`.
- `drizzle/0016_run_file_changes.sql` + `meta/`.
- الاختبارات: `run-changes.test.ts` (مستودع git حقيقي مؤقت وشجرة عمل ومجلد فرعي، وبلا git: إنشاء
  وتعديل وحذف ونقل وثنائي والحدود)، `line-diff.test.ts`، `changes-api.test.ts` (المسارات الحقيقية
  والمحرك، بلقطة وبgit)، `tests/contract/changes.contract.test.ts`.

الويب (`packages/web`):
- `src/files/changes.ts` (جديد: مفتاح التبويب، آخر رد للتشغيل، قراءة الفرق الموحّد، الصفوف
  المتقابلة، صيغة الجمع)، `RunChangesCard.tsx` (جديد)، `DiffView.tsx` (جديد)، `queries.ts`
  (`useSessionChanges`, `useRunDiff`)، `context.tsx` (`changes`, `useOpenDiff`)، `FilePreviewPanel.tsx`
  (تبويب الفرق).
- `chat/MessageView.tsx` (البطاقة تحت آخر رد للتشغيل)، `chat/ChatScreen.tsx` (`changesRevision`)،
  `types.ts`، `styles/chat.css`، `i18n/{ar,en}.json` (`changes.*`, `diff.*`).
- `tests/run-changes.test.tsx`، `tests/i18n.test.ts` (العائلات الديناميكية)، `e2e/hub.ts` (سيناريو
  «عدّل المشروع»)، `e2e/zzzzzz-run-changes.spec.ts` (الرحلة ٣٣)، `e2e/shots/33-*.png`، وصور الرحلة
  ٣٢ تغيّرت لأن بطاقة تشغيلها الأول تظهر الآن تحت ردها.

الوثائق: `docs/contracts/DECISIONS.md` §49، `docs/contracts/COVERAGE.md`، `docs/domain/sessions.md`
(`runs.changes`، `run_file_change`)، `docs/STATUS.md` (٢١١ من ٢٦٩؛ sessions ٣٣ من ٣٧).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا ما يمسّه التغيير فقط (قاعدة السرعة)؛ الحزم الكاملة يشغّلها CI:
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck
exit=0
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 296 client file(s) scanned, 181 contract path(s) known.
$ pnpm contract:test
 Test Files  6 passed (6)
      Tests  283 passed (283)
$ pnpm i18n:check
i18n:check  web: 1384 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ (server) vitest run --project unit sessions/{run-changes,line-diff,changes-api,sessions-run,direct-run,sessions-api,files-api,trajectory-api}.test.ts tests/unit/{status,task-runs}.test.ts
 Test Files  10 passed (10)
      Tests  69 passed (69)
$ (web) vitest run tests/{run-changes,file-preview,message-layout,tool-calls,trajectory}.test.tsx tests/{i18n,logical-css,ui-layer}.test.ts
 Test Files  8 passed (8)
      Tests  250 passed (250)
$ pnpm build
dist/assets/index-DqKUhI4o.js          1,520.93 kB │ gzip: 457.19 kB │ map: 6,071.02 kB
✓ built in 974ms
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzzzz-chat-files.spec.ts e2e/zzzzzz-run-changes.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zzzzzz-chat-files.spec.ts:36:1 › 32. files a run wrote open beside the chat from the Files list and the tool card (2.9s)
  ✓  2 [chromium] › e2e/zzzzzz-run-changes.spec.ts:35:1 › 33. a run’s changed files are counted under its reply and open as a diff (2.9s)
  2 passed (12.2s)
```
الرحلة ٣٣ تثبت: تشغيل يكتب ثلاثة ملفات فبطاقته «غيّر 3 ملفات»؛ تشغيل ثانٍ يعدّل `data.csv` و`notes.md`
وينشئ `plan.md` فبطاقته تحت رده «غيّر 3 ملفات» و`+6−1` باتجاه LTR، وكل ملف بأعداده (`+1−1`،
`+1−0`، `+4−0`)؛ الضغط يفتح الفرق بجانب المحادثة (تبويب «data.csv (التغييرات)»، LTR، السطر ٣ قبل
وبعد)، ثم «جنبًا إلى جنب»، ثم «افتح الملف» يفتح CSV بقيمته الجديدة، وفرق الملف الجديد أسطر مضافة كلها.

الاختبارات الجديدة تفشل على الكود القديم: تستورد `run-changes.ts` و`line-diff.ts` و`src/files/changes.ts`
و`RunChangesCard`/`DiffView` غير الموجودة، والعمليات الثلاث كانت `501`، ولا بطاقة `run-changes` في الصفحة.

**CI على هذا الطلب**: تُلصق نتيجته هنا بعد اكتماله.

## المخاطر والرجوع
- **لم يُجرَّب على Hermes حقيقي ولا على مستودع كبير**: في مستودع كبير يضيف `git add -A` على نسخة الفهرس
  زمنًا قبل بدء التشغيل وبعده (مقيّد بمهلة ٢٠ ثانية لكل أمر؛ عند الفشل يُكمل التشغيل بلا بطاقة ويُسجَّل
  السبب). وتُكتب كائنات git للملفات المعدّلة وغير المتتبَّعة الصغيرة في `.git` (يحذفها `git gc` لاحقًا).
- **git يشغّل مرشحات المستودع** (`clean` في `.gitattributes`/`config`) عند `add`: هي من إعداد المستودع
  نفسه الذي يشغّل فيه الوكيل أوامره أصلًا؛ `core.fsmonitor` معطّل.
- **بلا git**: تغيير في ملف لم تقرأه البداية (مجلد أكبر من الحد) وملف لم تحفظ نسخته يُسرد بلا فرق؛
  تعديل بالحجم نفسه في الجزء ذاته من الثانية نفسها لا يُرى (المقارنة بالحجم والوقت).
- **الذاكرة**: لقطة التشغيل بلا git تحفظ حتى ١٢ م.ب نصًّا لكل تشغيل حي.
- التشغيل الذي انقطع بإعادة تشغيل المركز لا يُسجَّل له شيء.
- الرجوع: استرجاع الـ commits؛ الترحيل `0016` إضافة جدول وعمود قابلة للإسقاط، ولا تغيير في قائم.

## التسليم والخطوة التالية
طلب دمج بالإنجليزية إلى `feat/chat-file-preview` (مكدّس على #106)، ويُعاد توجيهه إلى `main` بعد دمج
#106. المالك يؤكد قرارات §49 المقترحة ويجرّب على Hermes حقيقي وعلى شجرة مهمة (#105). التالي الممكن:
بطاقة حية أثناء التشغيل، وزر «تراجع عن تغييرات هذا التشغيل».
