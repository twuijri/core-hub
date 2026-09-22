# إعادة هيكلة عميل الويب: الملحن، شرائح الوكلاء، الشريط النحيف، مجلد عمل لكل جلسة

المسؤول: twuijri · الفرع: feat/web-composer-shell · الحالة: review

## المشكلة والهدف

عميل الويب يعمل لكنه يبدو غير منتهٍ: الملحن صفّ أزرار بلا نظام، والشريط الجانبي
يحمل كل شيء (الوكلاء، النماذج، الأجهزة، المعرفة) أمام العين دائمًا، ولا يعرف
المستخدم أين يعمل الوكيل على القرص.

الهدف: تنفيذ «هيكل الشاشة» من قسم المرحلة ٢ في
`docs/inspirations/ADOPTION-BACKLOG.md` (البنود ٢.٥ إلى ٢.١٢) بجلدنا نحن:

1. ملحن واحد بسطح مستدير: نص ينمو، صف أدوات (+ · النموذج · وضع الصلاحيات ·
   المايك · الإرسال)، وحالات مقصودة.
2. شرائح الوكلاء فوق الملحن مباشرة، بترتيب يسحبه المستخدم ويبقى.
3. شريط جانبي نحيف، وكل ما يُضبط مرة واحدة ينتقل إلى صفحات داخل الإعدادات.
4. مجلد عمل لكل جلسة يصل فعليًا إلى مشغّل الوكيل.
5. ثلاثة اقتراحات بداية في المحادثة الفارغة، بالعربية والإنجليزية.

## القرار والموافقات

- المالك عاين AionUi حيًّا وأقرّ أخذ **الهيكل والسلوك** دون الهيئة البصرية؛ هذا
  مكتوب في «ما لا نأخذه» في نهاية سجل التبنّي. لم يُفتح أي مصدر لمنتج آخر أثناء
  هذا العمل (ADR 0004).
- **قرار المالك أثناء التنفيذ (2026-09-22)**: لا نكتب عناصر التفاعل بأيدينا؛
  نقف على طبقة headless ونحتفظ بجلدنا. المعتمَد في هذا الفرع: `radix-ui` 1.6.3
  (حزمة واحدة، رخصة MIT) للقائمة والمنتقي واللوحة المنبثقة وإدارة التركيز، مع
  **قاعدة تركيب ملزمة**: كل عنصر Radix يُغلَّف في مكوّن لنا تحت `src/ui/` يطبّق
  الرموز، والشاشات تستورد الغلاف لا العنصر. القاعدة مكتوبة في
  `packages/web/README.md` ويحرسها اختبار (`tests/ui-layer.test.ts`).
  لم نعتمد أي طقم مُنسَّق (MUI/Ant/Chakra/Mantine).
- وضع الصلاحيات يُربط بحقل الموافقات في واصف إعدادات الوكيل نفسه (ADR 0002):
  محوّلات ACP تعلن `approval_mode` (وهو عمود `agent_settings.approval_mode`
  بقيم `ask | auto_safe | auto_all`)، وهرمس يعلن `approvals_mode` بقيمه الثلاث.
  العميل لا يخترع القيم: يعرض ما يعلنه الواصف، ويترجم ما يعرفه منها.
- ترتيب شرائح الوكلاء لا حقل له في العقد، فهو تفضيل محلي في `localStorage` لكل
  مساحة عمل، على نمط ترتيب الجلسات (`sessions/order.ts`). حين يكبر العقد بحقل
  ترتيب، `agentOrder.ts` هو الملف الوحيد الذي يتغيّر.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)

عملية واحدة جديدة، مضافة قبل التنفيذ:

| العملية | المسار | ماذا تعيد |
|---|---|---|
| `sessions.listWorkingDirs` | `GET /sessions/working-dirs` | `WorkingDirs`: جذر مساحة العمل على القرص والمجلدات الموجودة تحته مباشرة |

مخططان جديدان: `WorkingDir` و`WorkingDirs`. `SessionCreate.working_dir`
و`SessionPatch.working_dir` و`Session.working_dir` كانت في العقد أصلًا؛ ما تغيّر
أن الخادم صار يحترمها بدل تخزين النص كما هو.

## الملفات والتأثير

**الخادم**
- `packages/server/src/modules/sessions/working-dir.ts` (جديد): جذر مساحة العمل
  `${DATA_DIR}/workspaces/<profile>`، وحلّ المسار، والرفض بمغلّف
  `400 validation_failed` لأي مسار خارج الجذر، وعدم اتّباع أي وصلة رمزية على
  الطريق (`lstat` لكل جزء)، وسرد المجلدات.
- `sessions/service.ts`: `create` تنشئ المجلد فعلًا (أو تولّد اسمًا باسم الجلسة
  وهو فريد بالبناء) وتحذف الجلسة إن رُفض المسار؛ `update` ترفض تغيير المجلد بعد
  أول تشغيل بـ`409 state_invalid`؛ `workingDirs` تخدم العملية الجديدة.
- `sessions/routes.ts` + `sessions/index.ts`: المسار الجديد **قبل**
  `/sessions/:session_id`، و`dataDir` من `hub.config`.
- المجلد يصل إلى المشغّل كما هو: `engine.ts` كان يمرّر `session.workingDir`
  و`agents/runner.ts` يستعمله `cwd` — اختبار يثبت ذلك الآن.

**الويب**
- `chat/Composer.tsx`: أُعيد بناؤه. سطح واحد، نص ينمو بلا قفزة (توأم خفي في
  `.composer-grow`، بلا قياس في JS)، وصف أدوات بالترتيب المتفق عليه، وسبع حالات
  على `data-state` من دالة صافية `chat/composer-state.ts`.
- `chat/AgentChips.tsx` + `chat/agentOrder.ts`: الشرائح فوق الملحن، سحب بلوحة
  المفاتيح أيضًا (dnd-kit)، والترتيب يبقى لكل مساحة عمل.
- `chat/WorkingDirPicker.tsx`: اختيار مجلد موجود أو تسمية جديد أو ترك المركز
  يولّده؛ يظهر في رأس المحادثة ويُقفل بعد أول تشغيل مع ذكر السبب.
- `chat/starters.ts`: ثلاثة اقتراحات بالعربية والإنجليزية.
- `chat/useComposerControls.ts`: النماذج من الكتالوج، والموافقات من واصف الوكيل.
- `chat/firstMessage.ts` + `screens/NewChatScreen.tsx`: «محادثة جديدة» صارت
  محادثة لا استمارة؛ أول رسالة تُنشئ الجلسة ثم تُرسَل من شاشة المحادثة **بعد**
  اكتمال الاشتراك.
- `chat/useSessionStream.ts`: `status: 'ready'` صارت تعني «مشترك» لا «جُلب فقط»
  (بمهلة قصوى ٥ ثوانٍ). المركز يعيد بثّ السجل عند الاستئناف فقط
  (`after_seq > 0`)، فتشغيل يبدأ قبل الاشتراك كان يفقد أوائل أحداثه — وهو خلل
  حقيقي كشفته الرحلة الخامسة.
- `ui/Menu.tsx`, `ui/Select.tsx`, `ui/Popover.tsx` (جديدة): أغلفة Radix.
  `i18n/context.tsx` يركّب `Direction.DirectionProvider` مرة واحدة لأن Radix
  لا يقرأ `<html dir>`.
- `shell/Sidebar.tsx`: الشريط صار مدخلين (محادثة جديدة، بحث) + المقاطع + قائمة
  المحادثات. `settings/SettingsScreen.tsx`: قسم «الإدارة» الجديد،
  و`settings/SettingsBack.tsx` في كل صفحة إدارة.
- `styles/app.css`: أنماط الملحن والشرائح والأغلفة، بالرموز فقط، بخصائص منطقية
  فقط، وبحلقة تركيز واحدة (`:focus-visible` في الطبقة الأساسية).

**الخريطة والوثائق**
- `docs/clients/navigation.json`: نوع مدخل جديد `settings-management` وقائمة
  `settingsManagement`؛ الوجهات الأربع انتقلت من `rail` إليها ومساراتها صارت
  تحت `/settings/...` (ومعها مستوى الوكيل `/settings/agents/:agentId/...`).
  `scripts/navigation-check.mjs` يعرف القائمة الجديدة، و`docs/clients/NAVIGATION.md`
  يشرحها. كل وجهة ما زالت بمدخل أساسي واحد بالضبط.
- `packages/web/README.md`: طبقات الطرف الثالث ورخصها وقاعدة التركيب.

**الاختبارات**
- `packages/server/src/modules/sessions/working-dir.test.ts` (جديد، ١٢ اختبارًا).
- `packages/web/tests/composer.test.tsx` (جديد، ١٧)، `tests/agent-chips.test.tsx`
  (جديد، ١٠)، `tests/ui-layer.test.ts` (جديد، ٢).
- `packages/web/e2e/smoke.spec.ts`: الرحلة ١ صارت «اختر مجلدًا ثم أرسل»، ورحلة
  خامسة جديدة للإيقاف أثناء البث. `e2e/hub.ts`: سيناريو «أوقفني»، ووقفات
  السيناريو صارت قابلة للمقاطعة.

## الفحوص (الأوامر ونواتجها الفعلية)

كلها على الفرع بعد إعادة الأساس على `origin/main` (ee40677)، Node 24.21.0.

```
$ pnpm contracts:lint
Woohoo! Your API description is valid. 🎉
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm contracts:check-clients
check-clients  OK — 114 client file(s) scanned, 163 contract path(s) known.

$ pnpm nav:check
nav:check  OK — 35 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web

$ pnpm i18n:check
i18n:check  server: 95 keys, ar/en in parity
i18n:check  cli: 212 keys, ar/en in parity
i18n:check  web: 310 keys, ar/en in parity
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK

$ pnpm typecheck
(لا أخطاء؛ كل الحزم مرّت)

$ pnpm test
 Test Files  3 passed (3)          # contracts
      Tests  11 passed (11)
 Test Files  1 passed (1)          # ui-tokens (تباين WCAG)
      Tests  89 passed (89)
 Test Files  11 passed (11)        # cli
      Tests  60 passed (60)
 Test Files  37 passed | 1 skipped (38)   # server
      Tests  288 passed | 2 skipped (290)
 Test Files  13 passed (13)        # web
      Tests  128 passed (128)

$ pnpm contract:test
 Test Files  2 passed (2)
      Tests  251 passed (251)

$ pnpm lint
Checking formatting...
All matched files use Prettier code style!

$ pnpm build
dist/assets/index-C91IxzE6.css   36.24 kB │ gzip:   7.82 kB
dist/assets/index-DYQjMDUI.js   994.56 kB │ gzip: 309.80 kB │ map: 4,538.35 kB
✓ built in 597ms

$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
Running 5 tests using 1 worker
  ✓  1 … 4. first run: the setup token from /data creates the owner and signs in (1.0s)
  ✓  2 … 1. new chat → pick a folder → streamed markdown reply with reasoning, tool card and code (2.4s)
  ✓  3 … 2. an approval card answers once / session / always / deny through the hub (934ms)
  ✓  4 … 3. a socket drop mid-run resumes with after_seq and loses nothing (8.8s)
  ✓  5 … 5. the send button becomes stop mid-stream, and stop ends the run (867ms)
  5 passed (18.2s)
```

اللقطات في `packages/web/e2e/shots/`: `new-chat-ar-light.png`،
`new-chat-en-dark.png`، `working-dir-ar-light.png`،
`chat-streaming-ar-light.png`، `settings-management-ar-light.png`، مع تحديث
`chat-reply-ar-light.png` و`chat-reply-en-dark.png` و`settings-ar-dark.png`
و`settings-en-light.png` و`approval-ar-light.png` و`chat-pane-ar-light.png`.

### ما لم يُنفَّذ، وسببه

- **المايك موجود ومعطّل بنص ظاهر**: `models.transcribe` ما زالت 501
  (`docs/STATUS.md`). الزر يقول ذلك بدل أن يكذب.
- **«المهارات» في قائمة «+»**: حُذفت. شاشة مهارات الوكيل 501 (وحدة `agents`
  ١١ من ٤٠)، ومدخل يفتح فراغًا أسوأ من غيابه. المهمة تسمح بحذفها.
- **`shiki` و`@tanstack/react-virtual` و`react-hook-form`** من قرار المالك: لم
  تُعتمد هنا. الأولان يخصّان عارض المحادثة والثالث استمارات الإعدادات، وكلها
  خارج نطاق هذا الفرع؛ إدخالها الآن يخالف «لا تخلط إعادة هيكلة غير ذات صلة».
  مكتوبة في `packages/web/README.md` تحت «مخطَّط، لم يُعتمد بعد».
- **اختبارات الوحدة تفتح قوائم Radix بلوحة المفاتيح لا بالفأرة**: jsdom يتوقف
  عن إرسال `pointerdown` صالح بعد أول تفاعل `user-event` في الملف. مسار الفأرة
  تغطّيه رحلات Playwright، ومسار لوحة المفاتيح مطلوب أصلًا.
- **اختيار شريحة وكيل مختلف داخل محادثة مفتوحة** يفتح «محادثة جديدة» مع ذلك
  الوكيل (`?agent=`) ولا يبدّل وكيل الجلسة القائمة: العقد لا يسمح بتبديل
  `agent_id` بعد الإنشاء، والتظاهر بذلك كذب.

## المخاطر والرجوع

- تحريك المداخل إلى الإعدادات يغيّر مسارات الويب لأربع شاشات ولمستوى الوكيل؛
  الرجوع = إعادتها إلى `rail` في `docs/clients/navigation.json` وإرجاع
  `surfaceRoutes.web`. لا هجرة بيانات.
- إنشاء المجلدات هو أول كتابة على القرص من وحدة `sessions`. كل مسار مقيَّد تحت
  `${DATA_DIR}/workspaces/<profile>`، والرفض بمغلّف الخطأ، والوصلات الرمزية
  مرفوضة لا متبوعة. جلسة قديمة بـ`working_dir` خارج الجذر تبقى كما هي (لا يعاد
  التحقق منها بأثر رجعي)، وأي تعديل لاحق عليها يخضع للقاعدة الجديدة.
- `status: 'ready'` صارت تنتظر الاشتراك بمهلة ٥ ثوانٍ؛ مركز لا يُوصَل إليه يعرض
  المحادثة بعدها كما كان، ونقطة الاتصال تقول الحقيقة.
- Radix تبعية جديدة (MIT، 73 حزمة فرعية). لا كود منسوخ، فلا إضافة في
  `THIRD-PARTY-NOTICES.md`.

## التسليم والخطوة التالية

فرع عمل فقط: **لم يُدفع ولم يُفتح طلب دمج** في هذه الجولة، بانتظار قرار المالك.
الخطوة التالية بعد المراجعة: بقية المرحلة ٢ من سجل التبنّي — ٢.١١ (صفوف مدير
الوكلاء بتبويبات وأعداد)، ٢.١٣ (شريط استهلاك الرموز)، ٢.١٤ (استيراد النماذج
دفعةً) — ثم بقية طبقات المالك (`shiki`، `react-virtual`، `react-hook-form`)
كلٌّ في فرعها.

## تحديث (المنسّق، 2026-09-22)
رُكِّب الفرع فوق `feat/provider-picker` (طلب الدمج #16) لأن الاثنين يمسّان شاشة النماذج
ولقطات الرحلات. التعارض الوحيد الحقيقي كان رأس شاشة النماذج: أُخذ رأس المزوّدات الجديد
كاملًا، وأُعيد فوقه رابط الرجوع إلى الإعدادات الذي أضافه هذا الفرع. اللقطات أُخذت من هذا
الفرع لأنها تعكس الشاشات بعد التغيير. الفحوص بعد التركيب: lint وtypecheck وbuild نظيفة،
الوحدات 11 + 89 + 61 + 305 + 142، العقد 253، والرحلات الخمس تنجح.
