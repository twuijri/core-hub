# تلميع الويب بعد تجربة الهب 1.1.1: شريط المحادثة الثابت، الإشعارات، الصور، محادثات القنوات، الاحتياطي
المسؤول: twuijri · الفرع: fix/web-polish · الحالة: review

## المشكلة والهدف
ملاحظات المالك من تجربة الهب 1.1.1 على الويب (٢٠٢٦-٠٩-٢٦):

1. **رأس المحادثة يتمرّر مع الرسائل** («هذا السطر ما سويناه انه ثابت؟ … لازم تكون كل هذي الأشياء ثابتة»): صف
   الوكيل والبروفايل ومجلد التشغيل وجملة «المجلد يثبت بعد أول تشغيل» والملفات وتبويبا المحادثة/المسار يختفي مع
   التمرير، والمجلد يظهر بمعرّفه الخام (ULID). ثم عدّل: «مع انه اذا صار ثابت بيضيق الصفحة… بيطلع فوق كأنه
   شريطين» — شريط واحد لا شريطان.
2. **الإعدادات ← الإشعارات «ما يصلني»**: مفتاحان في كل صف، والثاني «إرسال إلى الأجهزة» يتكرر سبع مرات. المطلوب
   جدول: الأحداث صفوف، وعمودان «في الهب» و«على الأجهزة»، وساعات الهدوء تحته.
3. **النماذج ← الصور**: عنوان «الأخيرة» يظهر مرتين، والنموذج الأخير (gpt-image-2) مذكور مرتين.
4. **نماذج الصور فقط في منتقيات المحادثة**: gpt-image-2 عبر اشتراك ChatGPT وgpt-image-1 وغيرهما تظهر في منتقيات
   نموذج المحادثة، واختيار أحدها للمحادثة يفشل.
5. **محادثات تيليجرام وواتساب في القائمة** للقراءة فقط من مخزن هرمز: لم يستطع المالك إخفاء واحدة ولا حذفها، واضطر
   إلى `hermes sessions delete` داخل الحاوية.
6. **`ChannelSettingsPanel.tsx`** يستعمل صنفًا غير موجود `border-border` (الصنف في المشروع `border-line`).
7. (أُضيف لاحقًا) **النماذج ← الافتراضيات ← «النماذج الاحتياطية»**: «الفيل باك خله سحب وترتيب مهب كذا أزرار، ما
   أحب هذي الفكرة» — الترتيب بالسحب بدل ▲/▼.

## ما رأيته في هرمز قبل الكتابة (ADR 0012)
قرأت مصدر هرمز (MIT) عند الوسم المثبّت `v2026.9.14` (`hermes_cli/web_routers/sessions.py` و`hermes_state_sessions.py`)،
ولم أنسخ منه شيئًا. بكلماتي:

- خادم هرمز الداخلي فيه `DELETE /api/sessions/{id}?profile=<p>`، وهو ما يفعله `hermes sessions delete`: يحذف صف
  الجلسة ورسائلها، ويحذف معها الجلسات الفرعية المفوَّضة، ويُبقي الفروع (يمسح إشارتها إلى الأب)، ويجيب `{"ok": true}`،
  أو `{"ok": true, "already_absent": true}` إن لم يجد شيئًا.
- هرمز يحلّ المعرّف الذي لا يعرفه على أنه **بادئة** لجلسة واحدة إن وُجدت. لذلك الهب يقرأ الصف بالمعرّف الكامل أولًا
  (`GET /api/sessions/{id}`) ولا يحذف إلا محادثة قناة معرّفها هو المطلوب بالضبط؛ وإلا `404`.

## القرار والموافقات
**١. شريط واحد ثابت (مقترح — للمالك أن يؤكد التفاصيل):** عناصر المحادثة انتقلت إلى الشريط العلوي نفسه للتطبيق،
بعد العنوان، عبر «فتحة» في الشريط (`shell/topBarSlot.tsx`) تُرسم فيها العناصر ببوابة React، فتبقى في سياق
المحادثة (بروفايلها، ملفاتها، تبويباتها) وإن كان الشريط حولها للشخص. الترتيب: الوكيل (علامته و▾، واسمه في التلميح
والاسم المقروء) ← المجلد (أيقونة؛ نافذتها تقول اسمه ومساره كاملًا و«المجلد يثبت بعد أول تشغيل») ← الملفات (أيقونة
وعدد) ← مبدّل المحادثة | المسار (حبة صغيرة). المجلد الذي ولّده الهب (اسمه ULID) يُسمّى «مجلد تلقائي» ولا يظهر
المعرّف إلا في المسار. شارة البروفايل لا تتكرر: شريط الشخص فيه بروفايله، وشارة بروفايل المحادثة تظهر فقط إن كان
بروفايلًا آخر. لا شيء مثبّت تحت الشريط. تحت عرض ٦٤٠ بكسل للشريط (الجوال والنوافذ الضيقة) يبقى الوكيل وتنتقل
البقية إلى لوحة «المزيد» (⋯) — فلا يحتاج الشريط صفًا ثانيًا، ولهذا لم أبنِ بديل «إخفاء الصف الثاني عند التمرير».
على الجوال تنزاح كلمة «البروفايل» بجانب المنتقي (يبقى اسمًا مقروءًا له) ليتسع العنوان. شاشة محادثة القناة أخذت
الشريط نفسه (شارة القناة، والبروفايل إن اختلف، و⋯ للإجراءات).

**٢. الإشعارات جدول:** صف لكل حدث، وعمودان «في الهب» و«على الأجهزة» بعناوين، ولكل مفتاح اسم مقروء «الحدث —
العمود»؛ ساعات الهدوء تحت الجدول. حُذف المفتاح النصي `notify.push_switch`.

**٣. «الأخيرة» مرة واحدة:** النموذج في مجموعة «الأخيرة» لا يتكرر تحتها (مقترح؛ كانت القاعدة الموثقة أن يتكرر تحت
مزوّده). تحت «الأخيرة» تأخذ البقية عنوانًا دائمًا (المزوّد، أو «الكل» إن لم يكن للخيارات مزوّد) كي لا تُقرأ جزءًا من
«الأخيرة». والعنوان العالق أعلى القائمة لا يظهر إلا بعد أن يتمرّر صف العنوان نفسه خارجها، ويُرسم فوق القائمة لا
بجانبها — فلا يتكرر أي عنوان في أي منتقٍ.

**٤. نماذج الصور فقط (DECISIONS §87، مقترح — للمالك أن يؤكد):** `Model.image_only` في العقد، يقوله الهب لعائلات
Images API (gpt-image — ومنها نموذج الاشتراك — وDALL·E وImagen وFLUX …). الويب يُسقطها من كل منتقٍ لنموذج
المحادثة: الكاتب، الافتراضيات (المحادثة والمهام المساعدة)، السلسلة الاحتياطية، النموذج الافتراضي في بطاقة المزوّد،
وخطوة سير العمل. تبقى في تبويب الصور. النموذج الذي يرسم ويحادث (`gemini-*-image`) ليس منها. الهب لا يرفض اختيارًا
محفوظًا سابقًا.

**٥. محادثات القنوات (DECISIONS §88، مقترح — للمالك أن يؤكد):**
- «إخفاء من قائمتي»: علامة في الهب لكل شخص ولكل بروفايل (جدول `channel_conversation_hides`)، لا تلمس هرمز ولا قوائم
  الآخرين. القائمة تُسقط المخفية إلا مع `hidden=include`؛ الويب يطلبها معلَّمة ويعرض في آخر القائمة «إظهار المحادثات
  المخفية (n)»، وللمخفية «إظهار مرة أخرى».
- «حذف من هرمز…» للمالك والمشرفين فقط: عبر `DELETE /api/sessions/{id}` في هرمز بعد قراءة الصف بالمعرّف الكامل،
  وبتأكيد يقول إنه نهائي للجميع ولا يمكن استرجاعه وإن المحادثة في القناة نفسها لا تتأثر. يُسجَّل في التدقيق، وتُمحى
  علامات الإخفاء عليها.
- الإجراءات في قائمة ⋯ للصف (وبالنقر الأيمن) وفي ⋯ شريط المحادثة المفتوحة.

**٦.** `border-border` ← `border-line`، ومعه اختبار حارس: كل `border-<لون>` في الويب يسمّي لونًا معرّفًا في السمة.

**٧. السلسلة الاحتياطية بالسحب:** مقبض سحب لكل صف (dnd-kit، ومستشعر لوحة المفاتيح: المسافة للإمساك، والأسهم
للتحريك، والمسافة للإفلات، وEscape للإلغاء، مع إعلانات للقارئ بالعربية والإنجليزية)، والأرقام تتبع الصف أثناء السحب،
ويُحفظ الترتيب مرة واحدة عند الإفلات بالطريقة نفسها. أُزيلت ▲/▼ (مستشعر لوحة المفاتيح يغني عنها)، والحذف ✕ صغير
في الصف. لا قائمة مرتّبة أخرى بأزرار ▲/▼ في صفحة النماذج.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Model.image_only` (اختياري).
- `ChannelConversation.hidden` (اختياري)، ومعامل `hidden=include` في `sessions.listChannelConversations`.
- عمليات جديدة: `sessions.hideChannelConversation` (`PUT /channel-conversations/{id}/hidden`)،
  `sessions.unhideChannelConversation` (`DELETE …/hidden`)، `sessions.deleteChannelConversation`
  (`DELETE /channel-conversations/{id}`، `x-roles: [owner, admin]`).
- DECISIONS §87 و§88.

## الملفات والتأثير
- العقد: `packages/contracts/openapi.yaml`؛ `docs/contracts/DECISIONS.md` (§87، §88).
- الخادم: `modules/models/images.ts` (`isImageOnlyModel`)، `serialize.ts`؛ `modules/sessions/channel-conversations.ts`
  (`ChannelSource.delete`، `remove`)، `channel-hides.ts` (جديد)، `schema.ts` (الجدول)، `service.ts`، `routes.ts`،
  `testing/scripted-channels.ts`؛ `modules/index.ts` (منفذ الحذف إلى لوحة هرمز)؛ ترحيل
  `drizzle/0028_channel_conversation_hides.sql`.
- الويب: `shell/topBarSlot.tsx` (جديد)، `shell/AppShell.tsx`، `shell/TopBar.tsx`، `shell/WorkspaceSwitcher.tsx`؛
  `chat/ConversationBar.tsx` (جديد)، `chat/ChatScreen.tsx`، `chat/SessionAgent.tsx`، `chat/WorkingDirPicker.tsx`،
  `chat/ChannelConversationView.tsx`، `chat/useComposerControls.ts`؛ `files/FilesList.tsx`؛ `sessions/ChannelActions.tsx`
  (جديد)، `sessions/channels.ts`، `sessions/SessionList.tsx`؛ `notify/NotificationsTab.tsx`؛ `models/FallbackList.tsx`،
  `models/fallbacks.ts`، `models/queries.ts` (`chatModels`)، `models/ModelsScreen.tsx`؛ `schedules/workflows/StepPanel.tsx`؛
  `ui/Combobox.tsx`، `ui/combobox-filter.ts`، `ui/Menu.tsx` (`side`)، `ui/icons.tsx` (عين/عين مشطوبة)؛
  `agents/ChannelSettingsPanel.tsx`؛ `styles/chat.css`، `styles/app.css`؛ `i18n/ar.json` و`en.json`.
- الاختبارات: خادم `models/images-role.test.ts`، `sessions/channel-conversations.test.ts`؛ ويب
  `conversation-bar.test.tsx` (جديد)، `theme-colors.test.ts` (جديد)، `channel-conversations.test.tsx`،
  `notifications.test.tsx`، `combobox.test.tsx`، `combobox-filter.test.ts`، `model-fallback-signin.test.tsx`؛ Playwright
  `smoke.spec.ts`، `zzz-profiles.spec.ts`، `zzzzzz-chat-files.spec.ts`، `zzzzzzzzz-reply-files.spec.ts`،
  `zzzzzzzz-channel-conversations.spec.ts` (33b جديد).
- اللقطات: حُدّثت لقطات شاشات المحادثة والإشعارات والنماذج والمنتقي ومحادثة القناة فقط، وأُضيفت
  `chat-bar-folder-ar-light`، `32-chat-bar-phone-more`، `channel-hidden-ar-light`، `channel-delete-confirm-ar-light`؛
  وأُرجع ما تغيّر في غيرها.
- التوثيق: `docs/STATUS.md`، `docs/domain/sessions.md`، `docs/domain/models.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`، واحدًا بعد الآخر، في الشجرة `corehub-wt-webpolish` بعد دمج `origin/night/2026-09-27`:

```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck                → exit 0
$ pnpm contracts:lint
contracts:lint  validating 96 event schema file(s)
contracts:lint  OK                (تحذير واحد قائم في الفرع عن مثال `program`، ليس من هذا التغيير)
$ pnpm contracts:check-clients
check-clients  OK — 634 client file(s) scanned, 233 contract path(s) known.
$ pnpm contract:test
 Test Files  19 passed (19)
      Tests  378 passed (378)
$ pnpm i18n:check
i18n:check  web: … ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 38 destinations, 2 pre-auth screens (login, setup), 43 terms, ar/en complete, routes for web, ios, android, desktop

# الخادم: ملفات هذا التغيير
$ vitest run src/modules/models/images-role.test.ts src/modules/sessions/channel-conversations.test.ts \
    src/modules/sessions/channel-continuation.test.ts tests/unit/status.test.ts
 Test Files  4 passed (4)

# الويب: ملفات هذا التغيير وما يمسّه
$ vitest run tests/conversation-bar.test.tsx tests/model-fallback-signin.test.tsx tests/channel-conversations.test.tsx \
    tests/notifications.test.tsx tests/combobox.test.tsx tests/combobox-filter.test.ts tests/theme-colors.test.ts \
    tests/all-profiles.test.tsx tests/session-agent.test.tsx tests/reply-files.test.tsx tests/channel-continue.test.tsx \
    tests/models-screen.test.tsx tests/logical-css.test.ts tests/i18n.test.ts tests/session-menu.test.tsx \
    tests/composer.test.tsx tests/workflow-editor.test.tsx
 Test Files  17 passed (17)
      Tests  602 passed (602)

$ pnpm build                    → exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/smoke.spec.ts e2e/zzz-profiles.spec.ts e2e/zzzzzz-chat-files.spec.ts \
    e2e/zzzzzz-chat-trajectory.spec.ts e2e/zzzzzzz-model-fallback.spec.ts e2e/zzzzzzzz-channel-conversations.spec.ts \
    e2e/zzzzzzzzz-reply-files.spec.ts --workers=1
  28 passed (1.8m)
```

الاختبارات الجديدة تفشل على الشيفرة القديمة: الشريط كان داخل الصفحة لا في الشريط العلوي؛ «الأخيرة» والنموذج كانا
يتكرران؛ لم يكن جدول ولا أعمدة؛ لم تكن عمليات إخفاء/حذف ولا قائمة للصف؛ `border-border` جُرِّب فعلًا وفشل الحارس
عليه؛ و▲/▼ كانت موجودة ولا مقبض سحب.

CI على طلب الليلة #165: يُكتب هنا بعد التشغيل.

## المخاطر والرجوع
- الشريط العلوي يحمل الآن عناصر المحادثة؛ صفحة بلا عناصر لا تتغير (الفتحة فارغة ومخفية).
- الحذف من هرمز نهائي؛ محصور في المالك والمشرفين، وبتأكيد، وبالمعرّف الكامل لمحادثة قناة فقط. لم يُجرَّب بعد على
  هرمز حقيقي (هرمز مُحاكى في الاختبارات فقط).
- ترحيل يضيف جدولًا فقط. الرجوع: استرجاع الدمج؛ الجدول يبقى بلا ضرر.

## التسليم والخطوة التالية
يُدمج في `night/2026-09-27` (طلب الليلة #165). للمالك أن يؤكد: شكل الشريط الواحد ولوحة «المزيد»، و§87، و§88،
وقاعدة «الأخيرة مرة واحدة». التالي: تجربة الحذف على هرمز حقيقي في مكدس الاختبار.
