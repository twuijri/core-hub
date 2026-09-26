# عائلة تصميم واحدة: الويب وسطح المكتب والآيفون والأندرويد
المسؤول: twuijri · الفرع: feat/design-family · الحالة: done

## المشكلة والهدف
توجيه المالك (٢٠٢٦-٠٩-٢٧):

- «أبي الويب وكل برامج سطح المكتب والآيفون والأندرويد يكونون عائلة وحدة، مهب كل واحد جو».
- «احترم إن الجوال لأنه صغير يحتاج تعيد توزيع الأشياء… مثل نقطة خضراء بدل كلمة أونلاين طويلة، يعني نسوي تطبيق
  بذكاء».
- «أبي أقوم أشوف تطبيقات كأنها حقة شركة عملاقة».

راجعتُ شاشات الآيفون (صور محاكي من CI، فاتح وداكن، عربي وإنجليزي) والويب (صور Playwright على عرض سطح المكتب وعرض
الجوال، عربي وإنجليزي، فاتح وداكن). أبرز ما لا يليق:

- **الأيقونات خليط:** الويب مرسوم باليد، والآيفون SF Symbols، والأندرويد Lucide؛ وصفوف الإعدادات في الويب بلا
  أيقونات إلا ثلاثة، وصفحات الوكيل بلا أيقونات.
- **الرد موقّع بـ«agent»** بدل اسم الوكيل (الهب يكتب هذا الاسم البديل)، والقدرات تظهر بأسمائها الخام
  (`learn`, `skill_commands`, `config_files`…) وبحروف صغيرة في الإنجليزية.
- **الجوال مزدحم:** الشريط العلوي يضغط العنوان إلى ست حروف (زرّا الصندوق والخلفية فارغان)، «متصل» كلمة طويلة في
  الدرج، و«راسل الوكيل… (Enter للإرسال، Shift+Enter لسطر جديد)» تلتف وتنقلب في العربية.
- **الشريط العلوي يكرر اسم المنتج** بجانب شعار الشريط الجانبي.
- **أزرار «إزالة» حمراء مصمتة** على كل بطاقة وكيل وجهاز.
- «1 tasks» و«1 tools».
- في الآيفون: «رجوع إلى المحادثات» صفٌّ يدفع قائمة الإعدادات للأسفل، والحالة «متاح» كلمة على كل وكيل، والقدرات
  سطر تقني طويل، وأزرار الصفحات رقائق بسهم `>` بدل أيقونة الصفحة، والتحميل مؤشر وحيد، والفارغ «لا شيء بعد» نصًا
  مجردًا، والخطأ ملاحظة وزر بلا عنوان، وبعض الأزرار أصغر من ٤٤ نقطة.
- (طلب إضافي من المنسق عن وكيل غرف الجوال) الويب: الرد في المحادثة والغرف وقائمة المحادثات بلا وجه الوكيل،
  ومنشئ رسالة الغرفة لا يرفق ملفات مع أن الهب يقبلها (§99).

## القرار والموافقات
كلها **مقترحة — للمالك أن يؤكد**:

1. **Lucide في كل العملاء** من حزمة `lucide-static` المثبّتة نفسها: الويب يولّد الخطوط إلى
   `packages/web/src/ui/lucide.generated.ts` (`scripts/icons/lucide-web.mjs`) والشاشات باقية على أسماء `Icon…`؛
   الآيفون بلا أي SF Symbol (خطوة في `ios.yml` ترفضها)، يرسم `LucideIcon`/`LucideLabel`. لكل وجهة في
   `navigation.json` صورة واحدة: `destinationIcons` (ويب) و`Icons.lucide(for:)` (آيفون) والجدول في
   `docs/design/family.md` (أندرويد). كل صف تنقّل يحمل أيقونته. خط Lucide الأصلي ٢ على شبكة ٢٤. إشعار ISC في
   `THIRD-PARTY-NOTICES.md` وتعليق ترخيص `/*! @license */` يبقى داخل الحزمة المبنية.
2. **الوكيل باسمه ووجهه في الويب** كما في الجوالين (`agents/identity.tsx`): الاسم من سجل الوكلاء بدل «agent»،
   واسم المقعد في الغرفة يغلب؛ الوجه صورته (`agents.getAvatar`، تُجلب بالرمز في الترويسة لا في الرابط) ثم علامته
   ثم أول حرف — في ردود المحادثة ورسائل الغرف ومقاعدها وقائمة المحادثات (وجه صغير `xs`).
3. **ملفات في رسائل الغرف (§99):** مشبك في منشئ الغرفة وسحب وإفلات ولصق، بالرفع نفسه ورقائق المحادثة
   (`attachments/tray.tsx`)؛ الصوت يذهب ملفًا لأن الغرفة لا تقبل كتلة صوت؛ ورسالة الغرفة تعرض صورها وملفاتها.
4. **صوت النص:** المنشئ «راسل Hermes…» بلا تلميح لوحة مفاتيح؛ «مهمة واحدة/1 task» و«أداة واحدة/1 tool»؛ أسماء
   القدرات كلها بالعربية والإنجليزية بحرف أول كبير.
5. **الجوال بذكاء (الويب تحت ٤٨rem):** «متصل» نقطة وحدها واسمها للقارئ (`Badge narrow="dot"`)؛ زرّا الصندوق
   والخلفية يختفيان وهما فارغان ويعودان بالعدد؛ الشريط العلوي لا يكرر اسم المنتج (يظهر اسم الهب فقط إن سمّاه المالك).
6. **الحذف على البطاقات هادئ** (`danger-quiet`: كلمات حمراء على السطح المحايد)، والأحمر المصمت للتأكيد داخل النافذة فقط.
7. **الآيفون:** بطاقة الوكيل بوجهه ونقطة حالة (والشارة فقط حين يكون هناك خلل)، القدرات سطر هادئ بلغة الشخص، رقائق
   الصفحات بأيقونة الصفحة (`ChipButtonStyle`)، إعادة التشغيل تدور؛ «رجوع إلى المحادثات» زر في شريط التنقل؛ التحميل
   صفوف هيكلية تتنفس (ساكنة مع تقليل الحركة)، والخطأ عنوان وجملة الهب وزر واحد، والفارغ أيقونة الصفحة
   (`EmptyStateView`/`EmptyRow`)؛ أهداف لمس ٤٤ نقطة (`tapTarget`) أو مساحة ضغط أوسع دون تغيير الرسم (`hitSlop`)؛
   اختيار المحادثات قرص مملوء بعلامة.
8. **وثيقة حيّة** `docs/design/family.md`: القيم المشتركة، جدول الأيقونات، أشكال المكوّنات، الحالات، صوت النص،
   تكييفات الجوال، وما يفحص كل قاعدة.

لم أغيّر `packages/ui-tokens` (لا رموز جديدة).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- الأيقونات: `scripts/icons/lucide-web.mjs` (جديد)، `packages/web/src/ui/{icons.tsx,lucide.generated.ts}`،
  `scripts/icons/lucide-mobile.json` (+ ملفات iOS/Android المولّدة)، `package.json` (`icons:lucide`)،
  `THIRD-PARTY-NOTICES.md`.
- الويب: `agents/identity.tsx` و`attachments/tray.tsx` (جديدان)، `chat/{MessageView,ChatScreen,Composer,ToolCallCard}.tsx`،
  `rooms/{RoomComposer,RoomsScreen,queries}`، `sessions/SessionList.tsx`، `shell/{Sidebar,TopBar,PendingActions,BackgroundTasks}.tsx`،
  `settings/SettingsNav.tsx`، `agents/{AgentNav,AgentManagerScreen}.tsx`، `ui/{Button,Badge,Avatar}.tsx`، `styles/kit.css`،
  `design/theme.tsx`، `tasks/TasksScreen.tsx`، أزرار الحذف في ثماني شاشات، ولغتا الواجهة.
- الآيفون: `Theme/Icon.swift` (جديد)، `Shell/{Components,AsyncContent,SidebarView,ShellView,PendingList}.swift`،
  `Screens/AgentsScreens.swift`، `Settings/*`، `Chat/*`، `Rooms/*`، `Sessions/SessionList.swift`، `Auth/LoginScreen.swift`،
  `Theme/Theme.swift`، ولغتا التطبيق؛ اختبار `CoreHubTests/FamilyTests.swift`؛ لقطات التدقيق الإضافية في
  `CoreHubUITests/StoreScreenshots.swift` (في `extra/` فلا تُرفع إلى المتجر).
- CI: خطوة «لا SF Symbols» في `.github/workflows/ios.yml`.
- الاختبارات: `tests/{lucide-icons,agent-identity}.test.tsx` (جديدان)، `tests/{rooms,topbar-name}.test.tsx`،
  `e2e/zzzzzzzzzzz-design-family.spec.ts` (جديد)، ولقطات Playwright الملتزمة للشاشات التي تغيّرت فقط.
- الوثائق: `docs/design/family.md` (جديد).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا عبر `mj-run` بعد دمج `night/2026-09-27`:

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm --filter @corehub/web typecheck
web typecheck: exit 0
$ pnpm i18n:check
i18n:check  web: 2959 keys, ar/en in parity
i18n:check  desktop: 92 keys, ar/en in parity
i18n:check  ios: 441 keys, ar/en in parity
i18n:check  OK
$ node scripts/icons/lucide-web.mjs --check
lucide web icons up to date (78 icons, lucide-static 1.48.0)
$ node scripts/icons/lucide-mobile.mjs --check
lucide: 68 shared + 39 Android icon(s) from lucide-static 1.48.0 up to date
$ (packages/web) vitest run
 Test Files  97 passed (97)
      Tests  1301 passed (1301)
```

Playwright (بعد `pnpm build`، `PLAYWRIGHT_CHANNEL=chrome`، عامل واحد):

```
$ playwright test e2e/zzzzzzzzzzz-design-family.spec.ts
  ✓  1 … the family pass: the audited screens, desktop and phone, both languages and themes (39.6s)
  ✓  2 … the family rules hold: icons on every row, Lucide strokes, a dot on a phone (1.0s)
  2 passed (47.8s)
$ playwright test --workers=1 e2e/zz-design.spec.ts e2e/zzzzzz-rooms.spec.ts e2e/zzz-agents-top-level.spec.ts \
    e2e/zzzzzz-pending-actions.spec.ts e2e/zz-agent-tools.spec.ts e2e/zzzzzz-subagents-background.spec.ts
  10 passed (46.3s)
```

قاعدة «الجديد يفشل على القديم»: الاختبار الثاني في المواصفة الجديدة شُغّل على الفرع قبل التغيير وفشل
(`getByTestId('settings-nav').locator('a').first().locator('svg')` — `Expected: 1, Received: 0`).

الآيفون على GitHub (تشغيل يدوي على الفرع): `iOS` (بناء واختبارات المحاكي، ومنها `FamilyTests`) — نجح في
36213101852 و36214437672؛ `iOS store screenshots` بالفاتح والداكن — نجح في 36213103086 و36214438878 (منه صور «بعد»).

CI على #165 عند `bc4b4f14` (رأس `night/2026-09-27` بعد آخر دمج لي):

```
CI       36216787513  success  — Lint/typecheck/contracts/client tests/build, Web smoke journeys (Playwright),
                                 Desktop app smoke (Electron under Xvfb), server shards 1–3, migrations, Docker
iOS      36216787539  success  — Build and test on the iOS simulator
Android  36216787517  success
```

ما صلّحته في الطريق: اختبار الويب الجديد `agent-identity` كان فيه مسار هب مكتوب باليد فأوقف `check-clients`
(أزلته)؛ ووجه الوكيل في قائمة المحادثات أخذ معرّف الاختبار `session-agent` نفسه الذي يحمله زر الوكيل في رأس
المحادثة، فأسقط رحلتي الدخان ١ و٨ (صار `session-row-agent`، والرحلتان تنجحان محليًا وفي CI). وخارج نطاقي، لإبقاء
#165 أخضر: رحلة الدخان ١ تعدّ الآن أربعة صفوف إدارة (أضيفت «المراكز المرتبطة»)، و`nav.linked_hubs` في لغتي
الآيفون (كان `L10nTests` يفشل).

صور قبل/بعد (خارج المستودع): مجلد `design-family/` في مساحة عمل الجلسة — `ios-before/`، `ios-after/`،
`web-before/`، `web-after/`.

## المخاطر والرجوع
- لقطات Playwright الأخرى الملتزمة ستختلف عند إعادة توليدها (أيقونات الشريط الجانبي في كل صفحة)؛ لم ألتزم إلا
  لقطات الشاشات التي غيّرتها.
- رسم الأيقونات تغيّر في كل مكان؛ الأسماء في الشاشات لم تتغير، فالرجوع باسترجاع الالتزامات يعيد الرسم القديم.
- ملف `lucide-mobile.json` مشترك مع وكيل الأندرويد: أُضيفت الأسماء المشتركة إلى `icons`، ونُقل منها ما كان في
  `android` تلقائيًا.

## التسليم والخطوة التالية
دُمج في `night/2026-09-27` (#165) على مراحل، وCI أخضر عند `bc4b4f14`. التالي للمالك: مراجعة القرارات المقترحة
أعلاه؛ ولوكيل الأندرويد: جدول الأيقونات وتكييفات الجوال في `docs/design/family.md`.
