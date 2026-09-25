# صفحة «الملفات»: إدارة مجلد عمل البروفايل من الويب
المسؤول: twuijri · الفرع: feat/workspace-files · الحالة: review

## المشكلة والهدف
الوكلاء يعملون في `/data/workspaces/<profile>/…` (مجلد لكل محادثة، ومجلدات المهام). الشخص لا يرى
هذه الملفات من أي عميل ولا يديرها: لا يستطيع أن ينزّل تقريرًا كتبه وكيل، ولا أن يصحّح ملفًا
نصيًا، ولا أن يضع ملفًا في مجلد عمل الوكيل.

الهدف: مدير ملفات **فقط** — بلا طرفية ولا تشغيل أوامر من أي نوع — محصور في مجلد البروفايل المختار
في الشريحة العلوية، للمالك والمشرف: تصفّح بمسار تنقّل، رفع بالسحب والإفلات، تنزيل ملف أو مجلد
مضغوط بحدود، مجلد جديد، إعادة تسمية، نقل، نسخ، حذف بتأكيد، معاينة، تحرير النص مع تلوين الصياغة
وفحص تعارض الحفظ، و«إرفاق بمحادثة».

## القرار والموافقات
كل ما يلي **مقترح — ينتظر تأكيد المالك** (المالك نائم؛ اتخذتُ القرار وسجّلته):

- **المكان: أدوات الإعدادات** (`settingsTools`، آخر القائمة بعد «الإضافات»)، المسار
  `/settings/files`، للمالك والمشرف (`roles: ["admin"]`). لماذا لا صفحة الوكيل: الملفات للبروفايل
  لا لوكيل بعينه (Hermes وClaude Code وغيرهما يعملون في المجلد نفسه)، و`agentLevel` يُعرض فقط بما
  يعلنه المحوّل. ولماذا لا الشريط: قاعدة المالك أن الشريط للأقسام اليومية، وهذه أداة تُفتح عند
  الحاجة. مسجّل في `docs/clients/NAVIGATION.md` §٢ و`navigation.json` (مصطلح `files`:
  Files / الملفات).
- **الوحدة: `knowledge`** (تملك الملفات وسجلّ المرفقات)، ١١ عملية جديدة `knowledge.*WorkspaceFile*`
  تحت `/workspace-files…`. DECISIONS **§56** (آخر رقم مستعمل في طلبات الدمج المفتوحة §55).
- **الحدود**:
  - الرفع والإرفاق ٢٥ MB (سقف المرفق الواحد نفسه).
  - التحرير ١ MiB نص UTF-8.
  - الضغط ونسخ المجلد ٢٠٠ MiB أو ٢٠٬٠٠٠ عنصر.
  - القائمة ٥٠٠٠ عنصر (`truncated`).
  - كلها في `WorkspaceFileLimits` مع كل قائمة، والرفض `413` قبل كتابة أو إرسال أي بايت.
- **الأمان**:
  - كل مسار نسبي إلى الجذر؛ المطلق و`..` الخارج وNUL تُرفض `400` بسبب صريح.
  - كل مجلد في الطريق يُحلّ بـ`realpath` ويجب أن يبقى داخل الجذر، فالرابط الرمزي الخارج
    (`/data/keys`، بيت Hermes، بروفايل آخر) يُرفض `symlink_outside`.
  - العمل على المسار الحقيقي؛ الرابط يُحذف ويُنقل كرابط ولا يُكتب عبره (`symlink`).
  - الملفات تُفتح بـ`O_NOFOLLOW` ويُعاد فحص مسار الواصف من `/proc/self/fd`.
  - الجذر لا يُحذف ولا يُنقل، والمجلد لا يدخل نفسه.
- **تعارض الحفظ بـETag قوي**:
  - الـETag بصمة sha256 للبايتات، لا وقت التعديل: كتابتان في ثانية واحدة تتشابهان بالوقت.
  - الرفض `409 conflict` بـ`details.reason = changed` والبصمة الحالية، ولا يُكتب شيء.
  - في المحرّر خياران: «تحميل النسخة الجديدة» أو «إبقاء نصي والكتابة فوقه».
- **لا يُعرض ما كتبه وكيل كصفحة**:
  - العرض المباشر للصور (عدا SVG) وPDF والنص فقط.
  - الباقي `application/octet-stream` مع `nosniff` و`CSP: sandbox`.
  - الويب يعرض HTML وSVG نصًا ملوّنًا.
- **«إرفاق بمحادثة» ينسخ**:
  - الملف يصير مرفقًا عاديًا (`purpose: message`).
  - تُفتح محادثة جديدة أو إحدى آخر ٨ محادثات في البروفايل نفسه، والملف في خانة الكتابة جاهز
    (`attachments/handoff.ts`).
  - التعديل اللاحق على الملف لا يغيّر المرفق.
- **كل كتابة في سجل التدقيق**: `workspace_file.*` — `created`، `written`، `uploaded`،
  `folder_created`، `moved`، `copied`، `deleted`، `attached`، وكذلك `zipped`.
- **العضو لا يدخل** (`x-roles: [owner, admin]`): محادثات كل الأعضاء في مجلد البروفايل نفسه، فرؤية
  لكل شخص تحتاج مجلدات مملوكة لأشخاص — قرار لاحق إن أراده المالك.
- **معاينة #106**: لم يُدمج بعد، فالمعاينة هنا نص وصور وPDF كما في المهمة. لم أمسّ `src/files/`
  التي يضيفها #106؛ مجلدي `src/workspace-files/`.
- **تلوين الصياغة**:
  - `lowlight` (MIT، موجود أصلًا في القفل عبر `rehype-highlight`) صار اعتمادًا مباشرًا للويب بلا
    نسخة جديدة.
  - المحرّر طبقتان: نص ملوّن تحت `textarea` شفاف.
  - النثر (Markdown والنص) بخط القراءة حتى تتصل الحروف العربية، والشيفرة بالخط الثابت ومن اليسار.
- **ضاغط zip مكتوب هنا** (`knowledge/zip.ts`، نحو ١٥٠ سطرًا: deflate مع واصف بيانات وأسماء
  UTF-8) بدل مكتبة: الحدود أقل بكثير من حاجة ZIP64، فلا اعتماد ولا إشعار ترخيص جديد في الصورة.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `openapi.yaml`: ١١ عملية بوسم `knowledge`، كلها `x-roles: [owner, admin]` وبـ`X-Hub-Profile`:
  - `knowledge.listWorkspaceFiles` و`knowledge.deleteWorkspaceFile` (`/workspace-files`).
  - `knowledge.downloadWorkspaceFile` (`/workspace-files/content`، بايتات مع ETag، `disposition`).
  - `knowledge.downloadWorkspaceFolder` (`/workspace-files/archive`، ‏`application/zip`، `413`).
  - `knowledge.readWorkspaceText` و`knowledge.writeWorkspaceText` (`/workspace-files/text`؛
    `413`/`415`، و`409` للتعارض).
  - `knowledge.uploadWorkspaceFile` (`/workspace-files/upload`، multipart، `overwrite`).
  - `knowledge.createWorkspaceFolder` و`knowledge.moveWorkspaceFile` و`knowledge.copyWorkspaceFile`.
  - `knowledge.attachWorkspaceFile` (يعيد `Attachment`).
- مخططات جديدة: `WorkspaceFileEntry`، `WorkspaceFileLimits`، `WorkspaceFolder`، `WorkspaceText`،
  `WorkspaceTextWrite`، `WorkspacePathBody`، `WorkspaceFileTransfer`؛ معامل `WorkspaceFilePath`؛
  استجابة مشتركة `UnsupportedMediaType` (`415`).
- وصف وسم `knowledge` لم يعد «stub».
- `docs/contracts/DECISIONS.md` §56، و`docs/contracts/COVERAGE.md` سطر `files`.
- العملاء المولّدون: TS يُولَّد في البناء (غير ملتزم)؛ `contracts:check-clients` نظيف.

## الملفات والتأثير
- الخادم (`packages/server/src/modules/knowledge/`):
  - `workspace-files.ts` — قواعد المسار والعمليات والحدود.
  - `workspace-files-routes.ts` — الـHTTP وسطر التدقيق.
  - `zip.ts` — الضاغط.
  - `index.ts` — سطر تسجيل واحد.
  - `schema.ts` — `AttachmentMeta.workspacePath` (JSON، بلا هجرة).
  - رسائل الخطأ بالعربية والإنجليزية في `packages/server/src/i18n/{ar,en}.json` (`knowledge.workspace_*`).
- اختبارات الخادم:
  - `workspace-files.test.ts` (٢٤): الحدود والتسلل والروابط والسقوف وCRUD والـzip.
  - `workspace-files-api.test.ts` (٧): المخططات والعضو `403` والتدقيق والإرفاق.
  - `tests/contract/workspace-files.contract.test.ts` (٤).
- الويب (`packages/web/src/workspace-files/`):
  - `FilesTool.tsx` — الصفحة.
  - `FilePreviewDialog.tsx`، `TextEditorDialog.tsx`، `AttachToChatDialog.tsx` — الحوارات.
  - `CodeEditor.tsx` — المحرّر.
  - `paths.ts`، `queries.ts` — المسارات وطبقة البيانات.
- خارج المجلد في الويب:
  - `attachments/handoff.ts` — الخانة بين الصفحة وخانة الكتابة.
  - `chat/Composer.tsx` — يلتقط الملفات المسلَّمة عند التركيب (سطور قليلة).
  - `settings/SettingsScreen.tsx` — مدخل واحد في `SECTIONS`.
  - `ui/icons.tsx` — `IconFile`.
  - `styles/screens.css` — إضافة في آخر الملف.
  - `i18n/{ar,en}.json` — `nav.files` و`files.*`، ٧١ مفتاحًا لكل لغة.
- اختبارات الويب: `tests/workspace-files.test.tsx` (١١)، و`e2e/zzzzzz-workspace-files.spec.ts`
  (رفع بالسحب، إعادة تسمية، تحرير وحفظ، حذف) مع لقطتين `e2e/shots/33-files-*.png`.
- الوثائق:
  - `docs/clients/navigation.json` و`NAVIGATION.md`.
  - `docs/STATUS.md`: ‏217 من 275، وسطر `knowledge` وسطر الويب.
  - `packages/web/package.json` و`pnpm-lock.yaml`: `lowlight` مباشرًا، ٣ أسطر في القفل.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، محليًا، على هذا الفرع (بعد `git fetch`؛ `main` لم يتحرك منذ التفرّع):

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck        → exit 0 (كل الحزم، بلا خطأ)

$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm contracts:check-clients
check-clients  OK — 291 client file(s) scanned, 185 contract path(s) known.

$ pnpm i18n:check
i18n:check  web: 1386 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 35 destinations, 2 pre-auth screens (login, setup), 40 terms, ar/en complete, routes for web

# server (unit): workspace-files.test.ts, workspace-files-api.test.ts, tests/unit/status.test.ts
 Test Files  3 passed (3)
      Tests  32 passed (32)

# server (contract): كل مشروع العقد (contract.test.ts يغطي العمليات الإحدى عشرة بلا رمز)
 Test Files  5 passed (5)
      Tests  289 passed (289)

# web: workspace-files, navigation.parity, i18n, ui-layer, logical-css, composer
 Test Files  6 passed (6)
      Tests  225 passed (225)

$ pnpm build   → ✓ built in 807ms (vite)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test zzzzzz-workspace-files.spec.ts
  ✓  1 [chromium] › e2e/zzzzzz-workspace-files.spec.ts:44:3 › Files › uploads by drop, renames, edits and saves, then deletes (1.7s)
  1 passed (7.9s)
```

الاختبارات الجديدة تسقط على الكود القديم بالضرورة: العمليات كانت غير موجودة في العقد ولا في
الخادم (لا وحدة `workspace-files` ولا صفحة `files`). لم أشغّل حزم الخادم والويب وPlaywright كاملة
محليًا (قاعدة السرعة)؛ يشغّلها CI على كل دفع — نتيجته في «التسليم».

## المخاطر والرجوع
- **سباق الروابط (TOCTOU)**: وكيل يعمل في المجلد قد يبدّل مجلدًا برابط بين الفحص والتنفيذ.
  - القراءة والكتابة مغطّاتان بـ`O_NOFOLLOW` وإعادة فحص الواصف.
  - إنشاء المجلدات والنقل والحذف تعمل على المسار الحقيقي المفحوص قبل لحظة، ويبقى لها هامش ضيق
    لا يغلقه Node بلا `openat`.
  - لا شيء منها يقرأ أو يكتب محتوى خارج الجذر عبر رابط موجود.
- **الأعضاء**: غير مسموح لهم الآن؛ إن أراد المالك ذلك يلزم قرار في ملكية المجلدات.
- **حجم الحزمة**: `lowlight` كان مضمَّنًا أصلًا عبر `rehype-highlight`؛ لا زيادة ملحوظة.
- **تعارض دمج متوقَّع** مع #106 (الأيقونات، `i18n`، `screens.css`، `STATUS`، `DECISIONS`) —
  إضافات فقط، تُحل بالإبقاء على الطرفين.
- **الرجوع**: عكس الدمج يزيل الصفحة والعمليات. لا هجرة ولا حالة مخزّنة جديدة؛ الملفات على القرص
  لا تتأثر. سطور التدقيق الموجودة تبقى في `audit_events`.

## التسليم والخطوة التالية
- طلب الدمج #130 (بالإنجليزية): https://github.com/twuijri/core-hub/pull/130
- **CI على آخر دفع للشيفرة (التشغيل 36100797390): أخضر كله.**
  - Lint, typecheck, contracts, tests, build: نجح (13m43s).
  - Web smoke journeys (Playwright against the real hub): نجح (5m19s).
  - Docker image builds and answers /health: نجح.
  - db:generate + db:migrate (SQLite وPostgreSQL): نجح.
  - change record وgraphify-out: نجحا.
- التشغيل الأول سقط في `zz-design.spec.ts`: كان يعدّ سبع أدوات في قائمة الإعدادات والآن ثمانٍ.
  صحّحت العدد مع تعليق، وأبقيت لقطة `design-settings-ar-light.png` الجديدة التي تُظهر «الملفات»،
  وأرجعت بقية اللقطات غير المتعلقة. أعدت تشغيل هذا الملف محليًا: `3 passed`.
- `main` لم يتحرك منذ التفرّع (`git fetch` قبل الدفع الأخير)، فلا دمج لازم.
- ينتظر تأكيد المالك على: المكان (أدوات الإعدادات)، الحدود، منع الأعضاء، §56.
- بعد دمج #106: استبدال معاينة هذه الصفحة بعارضه (Office وCSV وHTML المعزول) في مهمة لاحقة.
