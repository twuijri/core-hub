# الإعدادات: قائمة جانبية بدل شريط التبويبات، وثلاثة رموز للسمة بدل كلمة
المسؤول: twuijri · الفرع: feat/settings-nav · الحالة: review

## المشكلة والهدف
ملاحظتان من المالك على النسخة المنشورة (٢٢ سبتمبر ٢٠٢٦):

1. «قسم الستنق المفروض اذا دخلته يعطيني قائمة جانبيه للسيتنق مهب زي كذا… والخيارات
   هذي تكون بالقائمة مهب بالنص» — شاشة الإعدادات كانت شريط تبويبات في الأعلى، ثم
   بطاقات «الإدارة» وأزرار «الأدوات» مبثوثة في وسط الصفحة. فالدخول إلى صفحة إدارة
   يخفي كل ما عداها، ولا يوجد مكان واحد يقول ما الذي تحويه الإعدادات.
2. «كلمة سستم هنا تشتت لو تخليها ايكونات نفس اكثر الانظمه: شمس وقمر وصورة شاشة» —
   شريحة السمة في تذييل القائمة الجانبية كانت زرًا يكتب اسم الخيار الحالي («النظام»)
   ويدوّر بين الثلاثة عند الضغط. الكلمة وحدها تُقرأ كعنوان للصف لا كخيار من ثلاثة،
   ولا يظهر منها أن هناك ثلاثة أصلًا.

## القرار والموافقات
- **الإعدادات شاشة واحدة بقائمة على جانبها.** كل وجهة تحت الإعدادات — التبويبات
  (`settingsTabs`) والإدارة (`settingsManagement`) والأدوات (`settingsTools`) — سطر في
  تلك القائمة، في ثلاث مجموعات معنونة. القائمة حاضرة على **كل** صفحة إعدادات، بما فيها
  صفحات الإدارة التي لها شاشاتها الخاصة (مدير الوكلاء، النماذج، اتصالات الأجهزة،
  والصفحات المؤجَّلة)، فالدخول إلى واحدة لا يخفي البقية.
- **القائمة مبنية من قطع القائمة الجانبية نفسها**، لا مرسومة من جديد: أُضيف إلى الطقم
  `SidebarPanel` — الصفوف نفسها داخل صفحة بدل أن تكون بجانبها، بلا زجاج وبلا ارتفاع
  خاص — ويُستعمل مع `SidebarGroup` و`SidebarRow` القائمين. سطر الإعدادات وسطر القائمة
  الجانبية صار الشيء نفسه.
- **على الهاتف لا مكان لعمودين.** دون 60rem تختفي القائمة من الصفحات الفرعية وتبقى
  صفحة الإعدادات نفسها هي القائمة، وتعرض الصفحة المفتوحة رابط العودة (`SettingsBack`).
  هذا يقرره ملف الأنماط، فلا تحتاج أي شاشة أن تعرف العرض.
- **حُذف `TabsNav` من الطقم.** كان شريط التبويبات المربوط بالمسارات، وشاشة الإعدادات
  مستعمله الوحيد. قاعدة الطقم في `ui-layer.test.ts` تقول إن مكوّنًا لا تستعمله أي شاشة
  تصميمٌ لم يُختبر على صفحة حقيقية — فحُذف بدل أن يُترك معلّقًا. `Tabs`/`TabPanel`
  (تبويبات في مكانها، بلا مسار) باقيان ويستعملهما `DeviceConnectionsScreen`.
- **السمة ثلاثة رموز بلا كلمة:** شمس · قمر · شاشة، بترتيب فاتح ثم داكن ثم النظام
  (وعليه أُعيد ترتيب `THEME_CHOICES`). صارت مجموعة اختيار (`radiogroup`) لا زرَّ
  تدوير، فالخيارات الثلاثة ظاهرة والمقصود منها بيّن.
- **الوصولية لم تُقايَض بالرموز:** أُضيف إلى `Segmented` خيار `icons` — «كل خيار رمزه
  وحده» — وهو يُبقي لكل خيار اسمه في `aria-label` وفي تلميحنا، ويحتفظ بلوحة المفاتيح
  ودلالات `radio` كما هي. لا يُستعمل إلا لمجموعة تُقرأ رموزها بلا كلمة، وهي هنا
  الوحيدة. وصفحة «العرض» أخذت الرموز نفسها **مع** كلماتها، فالمكانان يتفقان.
- **الغرفة النظيفة (ADR 0004 و0012):** لم يُفتح أي كود واجهة لمنتج آخر. الشكل مشتق من
  وثائقنا وطقمنا.

## العقد
لا تغيير. لا مسار جديد ولا حقل جديد: كل وجهة كانت لها عنوانها من قبل، والتغيير في
كيفية الوصول إليها لا في وجودها. `navigation.json` لم تتغيّر قوائمه.

## الملفات والتأثير
- `packages/web/src/settings/SettingsLayout.tsx` — جديد: الإطار الذي تلبسه كل صفحة
  إعدادات (القائمة + الصفحة + رابط العودة على الشاشات الضيّقة).
- `packages/web/src/settings/SettingsScreen.tsx` — أُعيدت كتابته حول الإطار؛ ذهب شريط
  التبويبات وبطاقات الإدارة وأزرار الأدوات من وسط الصفحة.
- `packages/web/src/agents/AgentManagerScreen.tsx` · `packages/web/src/models/ModelsScreen.tsx`
  · `packages/web/src/screens/DeviceConnectionsScreen.tsx` · `packages/web/src/screens/PlaceholderScreen.tsx`
  — كلها داخل الإطار، وذهب منها رابط العودة المنفرد. صفحة مؤجَّلة تحت الإعدادات لم تعد
  تحمل مسار فتات الخبز لأن القائمة تقوله.
- `packages/web/src/ui/SidebarShell.tsx` · `packages/web/src/ui/index.ts` — `SidebarPanel`.
- `packages/web/src/ui/Tabs.tsx` · `packages/web/src/ui/index.ts` — حذف `TabsNav`.
- `packages/web/src/ui/Segmented.tsx` — خيار `icons`.
- `packages/web/src/ui/icons.tsx` — `IconSun` · `IconMoon` · `IconDisplay`.
- `packages/web/src/design/theme.tsx` — ترتيب `THEME_CHOICES` و`themeIcon()`.
- `packages/web/src/shell/Sidebar.tsx` — شريحة السمة صارت الرموز الثلاثة.
- `packages/web/src/settings/DisplayTab.tsx` — الرموز نفسها مع الكلمات.
- `packages/web/src/styles/kit.css` · `screens.css` — `mj-sidebar-panel` وتخطيط
  `mj-settings` (خصائص منطقية فقط، وبلا لون حرفي).
- `packages/ui-tokens/tokens.json` — `layout.settings-nav` = 14rem.
- `packages/web/tests/ui-layer.test.ts` — جرد الطقم: `SidebarGroup` و`SidebarPanel`
  دخلا، `TabsNav` خرج.
- `packages/web/e2e/zz-design.spec.ts` — الرحلة تتنقّل من القائمة لا من رابط العودة،
  وتتحقق من المجموعات الثلاث.
- `docs/clients/NAVIGATION.md` · `docs/clients/DESIGN.md` — القرار مكتوب حيث يُقرأ.

## الفحوص
شُغّلت كلها في هذا الفرع بعد آخر تعديل (Node 24.21.0، pnpm 12.5.1):

- `pnpm lint` — نظيف (ESLint + Prettier).
- `pnpm --filter @majlis/web typecheck` — نظيف.
- `pnpm i18n:check` — الويب ٤١٠ مفاتيح، عربي/إنجليزي متطابقان.
- `pnpm nav:check` — ٣٤ وجهة، ٣٨ مصطلحًا، مسارات الويب كاملة.
- `pnpm -r test` — contracts 11 · ui-tokens 105 · cli 64 · server 428 (وتخطّيان مشروطان)
  · web 297. صفر إخفاقات.
- `pnpm build` ثم `PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e` — **١٢ رحلة من ١٢ تمرّ**،
  ومنها الرحلة التي تتنقّل داخل الإعدادات من القائمة نفسها.

```
 Test Files  3 passed (3)          contracts
      Tests  11 passed (11)
 Test Files  1 passed (1)          ui-tokens
      Tests  105 passed (105)
 Test Files  11 passed (11)        cli
      Tests  64 passed (64)
 Test Files  45 passed | 1 skipped (46)   server
      Tests  428 passed | 2 skipped (430)
 Test Files  24 passed (24)        web
      Tests  297 passed (297)

  ✓   1 [chromium] › e2e/setup.spec.ts:18:3 › 4. first run: the setup token … (1.4s)
  ✓   2 [chromium] › e2e/smoke.spec.ts:56:3 › 1. new chat → … streamed markdown reply (3.3s)
  ✓   3 [chromium] › e2e/smoke.spec.ts:174:3 › 6. the agent row gives up labels … (1.2s)
  ✓   4 [chromium] › e2e/smoke.spec.ts:243:3 › 2. an approval card answers … (1.0s)
  ✓   5 [chromium] › e2e/smoke.spec.ts:261:3 › 3. a socket drop mid-run resumes … (9.1s)
  ✓   6 [chromium] › e2e/smoke.spec.ts:278:3 › 5. the send button becomes stop … (1.3s)
  ✓   7 [chromium] › e2e/smoke.spec.ts:302:3 › 8. changing the agent … forks … (7.0s)
  ✓   8 [chromium] › e2e/smoke.spec.ts:338:3 › 9. a session names itself … (1.5s)
  ✓   9 [chromium] › e2e/smoke.spec.ts:369:3 › 7. 443 models: the picker searches … (2.3s)
  ✓  10 [chromium] › e2e/zz-design.spec.ts:59:3 › a multi-turn conversation … (2.4s)
  ✓  11 [chromium] › e2e/zz-design.spec.ts:141:3 › a live run is visibly alive … (8.9s)
  ✓  12 [chromium] › e2e/zz-design.spec.ts:196:3 › agents, models, sessions, settings
                                                   and the sign-in door … (2.4s)

  12 passed (46.2s)
```

خطأ واحد حقيقي كشفته الرحلات وأُصلح قبل التسليم: قاعدة إخفاء القائمة على الشاشات
الضيّقة كانت أعلى أولوية (`specificity`) من قاعدة إظهارها داخل `@media`، فبقيت القائمة
مخفيّة على كل العروض. صارت القاعدتان في نطاقي عرض متقابلين (`max-width` و`min-width`)
فلا تتنافسان أصلًا. لقطات `e2e/shots` أُعيد توليدها في الركضة نفسها.

## المخاطر والرجوع
- القائمة تسع ١٩ سطرًا بدور المالك (مالك). بدور «عضو» تقصر تلقائيًا لأن الصفوف مرشّحة
  بالدور، والمجموعة الفارغة لا تُرسم. لو طالت أكثر في مرحلة لاحقة فالعلاج قسم قابل
  للطي، لا شريط تبويبات ثانٍ.
- الرجوع: الفرع وحده؛ لا ترحيل ولا تغيير عقد ولا حالة محفوظة تتأثر. تفضيل السمة يُقرأ
  ويُكتب كما كان (`majlis.display`)، وإعادة ترتيب `THEME_CHOICES` لا تمسّ المخزَّن لأن
  القراءة بالعضوية لا بالموضع.

## التسليم والخطوة التالية
الفرع `feat/settings-nav` مرتّب فوق `main` بعد دمج #23 و#24، ومرفوع بطلب دمج ينتظر
المالك. لا شيء يُنشر ولا صورة تُبنى قبل قراره.

الخطوة التالية بعد الدمج: صورة واحدة من `main` تجمع #23 و#24 وهذا الفرع، فلا يُصدر
المالك مرتين.
