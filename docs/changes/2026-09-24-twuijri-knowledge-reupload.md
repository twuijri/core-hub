# إعادة رفع الملف نفسه: بعد حذفه، أو باسم آخر
المسؤول: twuijri · الفرع: fix/knowledge-reupload · الحالة: review

## المشكلة والهدف
وجده PR أدوات الوكيل (#80) وسجّله في `2026-09-24-twuijri-agent-tools-live.md` §المخاطر: في وحدة
`knowledge` (مالكة بايتات المرفقات):

- رفع الملف نفسه **بعد حذفه** يعطي ⁨500⁩.
- رفع البايتات نفسها **باسم آخر** يعطي ⁨500⁩.

السبب (أعدت إنتاجه باختبارات على `main` قبل أي تعديل): مخزن البايتات معنون بالمحتوى — المفتاح
`<workspace>/<aa>/<sha256>` — فكل نسخة من البايتات نفسها في البروفايل لها **مفتاح التخزين نفسه**.
والجدول `attachments` عليه فهرس **فريد** على `storage_key` (`attachments_storage_key_uq` منذ
الهجرة `0000`). فالصف الثاني للبايتات نفسها يرتطم بالقيد: `UNIQUE constraint failed:
attachments.storage_key` ← ⁨500⁩. والحذف لا يزيل الصف (يضع `deleted_at` ليبقى المرجع «محذوفًا»)،
فحتى بعد الحذف يبقى المفتاح محجوزًا. والشيفرة نفسها كانت تفترض عدة صفوف (`referencesTo` يعدّ
الصفوف الحية على المفتاح قبل حذف البايتات) — القيد هو الذي يناقضها.

ولم تكشفه اختبارات الوحدة لأن `attachments.test.ts` كان يبني الجدول بيده **بلا** الفهرس الفريد.

وبسببه أبقى الويب حزمة المهارات المرفوعة بعد الاستيراد بدل حذفها.

## القرار والموافقات
- **البايتات مرة واحدة، والصف لكل رفع** (مقترح — ينتظر تأكيد المالك). خياران كانا مطروحين:
  نسخة بايتات لكل رفع، أو بايتات مشتركة بعدّ المراجع. اخترت الثاني لأنه **الموجود أصلًا**
  (المخزن معنون بالمحتوى و`referencesTo` قائم) فلا يلزم إلا رفع القيد الخاطئ. وأضفت عليه تغييرًا
  واحدًا: كان رفع الملف نفسه بالاسم والغرض نفسيهما **يعيد المعرّف القديم**؛ الآن كل رفع صف جديد.
  السبب: مع معرّف مشترك، حذف شخص لـ«رفعه» يحذف نسخة غيره (مثلًا ملف أُرفق مرتين في المحرّر ثم
  أُزيل من إحداهما، أو حزمة يحذفها الاستيراد وهي نفسها مرفوعة في مكان آخر). والبايتات لا تُحذف
  إلا مع آخر صف حي يشير إليها.
- **الهجرة `0013_attachments_shared_bytes`**: تُسقط الفهرس الفريد وتنشئ فهرسًا عاديًا على
  `(workspace, storage_key)` (هو ما يستعمله `referencesTo`). ولّدها Drizzle Kit ولا تمسّ أي صف،
  فلم تلزم كتابتها يدويًا؛ واختبرتها على قاعدة فيها صفوف (حيّة ومحذوفة وفي بروفايلين).
- **لا ⁨500⁩ بعد اليوم**: `registerBlob` يتحقق أن البايتات المشتركة ما زالت على القرص قبل كتابة الصف
  — إن حُذف آخر صف يستعملها بين وصول الرفع وتسجيله يجيب `409 conflict` بسبب
  `bytes_removed_during_upload` (والإرسال ثانية ينجح). و`AttachmentStore.create` يحوّل أي
  `SQLITE_CONSTRAINT_*` إلى `409 conflict` (`attachment_conflict`) بدل ⁨500⁩. رسالتان جديدتان
  بالعربية والإنجليزية في `packages/server/src/i18n`.
- **الويب يحذف حزمة المهارات بعد الاستيراد** (`useImportSkills`): نجح الاستيراد أو رُفض، تُحذف
  الملفات المرفوعة في `finally`، وفشل الحذف لا يخفي جواب الاستيراد. الحزمة نفسها مرة ثانية تُرفع
  الآن بنجاح ثم يرفضها الهب بـ`skill_exists` كما كان.
- **مواضع الرفع الأخرى** (فحصتها كلها):
  - مرفقات المحادثة (`Composer` ← `sessions.uploadAttachment` / الرفع المستأنف): المسار نفسه، مغطّى
    باختبارات API للحالتين وللرفع المستأنف.
  - استيراد البروفايل (#88): `discardUpload` كان يمسح الصف كليًا **تحايلًا** على القيد الفريد؛
    يبقى كما هو (لا مرجع للأرشيف بعد الاستيراد) وتغيّر تعليقه فقط. `profile-transfer.test.ts`
    («ويأخذ الملف نفسه ثانية باسم آخر») ما زال يمر.
  - صفحة المعرفة: لا ترفع شيئًا في الويب (قائمة فقط عبر `knowledge.listItems`).
  - `updates` (نشر إصدار من رابط) يمرّ عبر `registerBlob` نفسه: يأخذ الآن صفًا جديدًا لكل نشر.
  - تصدير البروفايل (`keepExport`) له مفتاح خاص (`kept/<ulid>`) لا يتشارك البايتات، فلا يتأثر.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `sessions.uploadAttachment`: **`409` موثّق جديدًا** (`Conflict`)، ووصف يقول إن كل رفع مرفق
  مستقل ولو كانت البايتات موجودة، وإن البايتات تُخزّن مرة وتُحذف مع آخر مرفق. `sessions.completeUpload`
  كان يوثّق `409` أصلًا.
- `docs/contracts/DECISIONS.md` §39.
- العملاء المولّدون: `pnpm contracts:generate` (المولّد TS غير ملتزم في المستودع؛ لا فرق يُلتزم).

## الملفات والتأثير
- `packages/server/src/modules/knowledge/schema.ts` — الفهرس الفريد ← فهرس عادي `(workspace, storage_key)`.
- `packages/server/drizzle/0013_attachments_shared_bytes.sql`، `meta/0013_snapshot.json`، `meta/_journal.json`.
- `packages/server/src/modules/knowledge/service.ts` — لا إعادة للصف القديم؛ `409` حين تختفي البايتات المشتركة؛ تعليقات.
- `packages/server/src/modules/knowledge/store.ts` — `create` يحوّل قيود SQLite إلى `409`؛ حُذف `findBySha` (لم يعد مستعملًا).
- `packages/server/src/modules/knowledge/blobs.ts` — تعليقات فقط.
- `packages/server/src/i18n/{ar,en}.json` — `knowledge.attachment_bytes_gone`، `knowledge.attachment_conflict`.
- `packages/contracts/openapi.yaml` — `409` ووصف `sessions.uploadAttachment`.
- `packages/web/src/agents/skills.ts` — `useImportSkills` يحذف الحزم المرفوعة.
- الاختبارات: `knowledge/attachments.test.ts` (يبني الجدول بالهجرات الحقيقية الآن، و«البايتات مرة
  والصف لكل رفع»، وإعادة الرفع بعد الحذف وباسم آخر، وحذف يُبقي بايتات يستعملها غيره، و`409` حين
  تختفي البايتات)، `knowledge/attachments-api.test.ts` (الحالتان عبر HTTP + الرفع المستأنف)،
  `agents/agent-tools.routes.test.ts` (حذف الحزمة بعد الاستيراد ثم رفعها ثانية ← `skill_exists`)،
  `tests/unit/attachments-shared-bytes-migration.test.ts`، `tests/contract/attachments.contract.test.ts`،
  `packages/web/tests/skill-import.test.tsx`.
- الوثائق: `docs/contracts/DECISIONS.md` §39، `docs/domain/knowledge.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
الاختبارات الجديدة **على الشيفرة القديمة** (قبل الإصلاح، الاختبارات فقط مضافة) — تفشل كما يجب:

```
$ vitest run --project unit src/modules/knowledge/attachments-api.test.ts   # على main
     × takes the very same file again after it was deleted
     × takes the same bytes under another name, and a delete keeps what the other still uses
     × gives each upload of the same file its own id, so deleting one leaves the other
     × completes a resumable upload of bytes an earlier (deleted) upload had
AssertionError: {"error":"Something went wrong on the hub.","code":"internal","details":{"request_id":"req-4"}}: expected 500 to be 201
      Tests  4 failed | 10 passed (14)

$ vitest run --project unit src/modules/knowledge/attachments.test.ts src/modules/agents/agent-tools.routes.test.ts   # الشيفرة القديمة
     × stores identical bytes once, one row per upload
     × takes the same bytes again after a delete, and under another name
     × keeps the bytes while another row still uses them, and removes them with the last
     × answers 409, not 500, when the shared bytes vanished before the row was written
     × lets the web delete the pack once imported, and still refuses it uploaded again
      Tests  5 failed | 46 passed (51)

$ vitest run tests/skill-import.test.tsx   # web، useImportSkills القديم
     × deletes every uploaded pack once the skills are installed
     × deletes them too when the hub refuses the pack, and keeps the refusal
     × answers the import even when a delete fails
      Tests  3 failed (3)
```

واختبار الهجرة يثبت العيب على المخطط القديم نفسه (قبل تطبيق `0013` يُرفض الصف الثاني بـ`UNIQUE`)
ثم أن الصفوف كلها باقية بعده. واختبار العقد الجديد لم أشغّله على الشيفرة القديمة؛ مساره هو مسار
اختبار الـAPI أعلاه نفسه.

بعد الإصلاح (كلها عبر `mj-run`):

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck                      → exit 0
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 258 client file(s) scanned, 172 contract path(s) known.
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ pnpm contract:test
 Test Files  4 passed (4)
      Tests  267 passed (267)
$ pnpm --filter @majlis/server test
 Test Files  97 passed | 14 skipped (111)
      Tests  1007 passed | 41 skipped (1048)
$ pnpm --filter @majlis/web test
 Test Files  49 passed (49)
      Tests  576 passed (576)
$ pnpm build
✓ built in 721ms
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  43 passed (2.8m)
```

(أعدت لقطات e2e إلى حالتها: لا تغيير مرئي في هذا الـPR.)

## المخاطر والرجوع
- **تغيّر سلوك صغير**: رفع الملف نفسه بالاسم نفسه كان يعيد المعرّف القديم؛ الآن معرّف جديد. لا
  عميل يعتمد على ذلك (بحثت في الويب والـCLI)، والمحرّر يعامل كل رفع شريحةً مستقلة.
- **صفوف أكثر، لا بايتات أكثر**: كل رفع صف، لكن البايتات مشتركة. محاولات استيراد بروفايل فاشلة
  قبل بدء المهمة تترك صفوفًا لا تُحذف (كما كانت تترك صفًا واحدًا من قبل) — تنظيفها خارج النطاق.
- **سباق نادر** بين حذف آخر صف ورفع البايتات نفسها: يعطي `409` صريحًا بدل صف يشير إلى لا شيء.
- **الرجوع**: إرجاع الـPR. الهجرة لا تُحذف (قاعدة الإلحاق فقط)؛ الرجوع الفعلي هجرة جديدة تعيد
  الفهرس الفريد — وتفشل إن وُجد صفّان على مفتاح واحد، فلا يُرجع إليه بعد أن تُستعمل الميزة.
- PostgreSQL: لا هجرات pg بعد (`drizzle/pg` غير موجود)، فلا شيء يتغيّر هناك.

## التسليم والخطوة التالية
- PR إلى `main` بالإنجليزية؛ الدمج للمالك وحده.
- ينتظر تأكيد المالك: «صف لكل رفع» (DECISIONS §39).
