# «بروفايل» بدل «مساحة العمل» في نصوص الواجهة

المسؤول: twuijri · الفرع: feat/profile-wording · الحالة: review

## المشكلة والهدف

الشيء نفسه كان يحمل اسمين أمام المستخدم وثالثًا خلفه: «مساحة العمل / المساحة /
Workspace» في الواجهة، و«profile» في العقد (`X-Hub-Profile`، حقول `profile`)،
و«profile» في هرمز وإيكو. من يعرف أحدهما يتشتّت حين يرى الآخر. الهدف كلمة واحدة
في كل نص يراه المستخدم: **«بروفايل»** بالعربية و**"Profile"** بالإنجليزية.

## القرار والموافقات

- سؤال المالك (٢٠٢٦-٠٩-٢٣): «وش رايك نغير اسم الوورك سبيس الى بروفايل علشان ما
  نشتت المستخدم». واختار: «بروفايل» بالعربية و"Profile" بالإنجليزية في كل
  الواجهة، لأن هرمز وإيكو يسمّيانه profile والعقد يسمّيه `profile`.
- النطاق نصوص الواجهة فقط: لا تُعاد تسمية المعرّفات البرمجية ولا المسارات ولا
  مسارات الـAPI ولا `data-testid` (`workspace-…` باقية) ولا حقول العقد ولا
  القاعدة ولا كود الخادم.
- العربية بصيغة المذكّر: «البروفايل الافتراضي»، «بروفايل جديد»، «هذا البروفايل»،
  والجمع «البروفايلات».

## العقد

لا شيء. `packages/contracts` لم يُلمس.

## الملفات والتأثير

- `packages/web/src/i18n/ar.json` و`en.json` — كل قيمة ظاهرة تقول مساحة/مساحات
  العمل أو المساحة أو Workspace(s):
  - التنقّل والحساب والمستخدمون: «البروفايلات» / "Profiles"؛ «كل البروفايلات» /
    "All profiles"، "Every profile"؛ «البروفايلات…» / "Profiles…"؛
    «بروفايلات {name}» / "Profiles of {name}".
  - شريحة التبديل في الشريط العلوي، ومرشّح المهام، وحقل الجدولة ومرشّحها:
    «البروفايل» / "Profile"، و«كل البروفايلات» / "All profiles".
  - التهيئة الأولى: «اسم البروفايل (اختياري)»، «اسم أول بروفايل؛ …».
  - جمل «هذا البروفايل» / "this profile": الجلسات الفارغة، لا مزوّد نماذج، وقت
    التشغيل، و«خارج البروفايل الحالي».
  - صفحة البروفايلات: «بروفايلات منفصلة: …» (والإنجليزية كانت "Separate rooms"
    فصارت "Separate profiles")، «بروفايل جديد»، الشارتان «الحالي» و«الافتراضي»
    (كانتا مؤنّثتين)، «ابدأ فارغًا»، ونص الأرشفة بالمذكّر «يُطوى البروفايل…
    محادثاته…».
  - المستخدمون: «يفتح المحادثات والوكلاء في بروفايلاته»، «يدير المستخدمين
    والبروفايلات…»، «اختر بروفايلًا واحدًا على الأقل.»، «المشرف يدخل كل
    البروفايلات.».
- `docs/clients/navigation.json` — مصطلح `workspaces` صار "Profiles" /
  «البروفايلات» (اختبار التكافؤ يفرض أن يطابق مدخلُ اللغة المصطلحَ).
- `docs/clients/NAVIGATION.md` — صفّ `workspaces` في جدول المفردات يسجّل قرار
  المالك، والنثر الذي يسمّي الشريحة وأداة الإعدادات صار «البروفايل» / `Profiles`.
- الاختبارات: `tests/setup-screen.test.tsx` و`e2e/setup.spec.ts` (تسمية الحقل،
  وقيمة المثال «بروفايلي»)، `tests/people.test.tsx` (اسم المثال «الافتراضي»)،
  `e2e/smoke.spec.ts` الرحلة ١٣ (رابط «البروفايلات» وعنصر القائمة
  «البروفايلات…») ورحلة الجدولة (الخيار «كل البروفايلات»). معرّفات الاختبار لم تتغيّر.
- `packages/web/e2e/shots/` — ٥٩ لقطة أُعيد توليدها. كل واحدة فيها تغيّر نصّي
  حقيقي: شريحة التبديل «البروفايل» / "Profile" في الشريط العلوي تظهر في كل
  الشاشات بعد الدخول، و`setup-ar-light` فيها تسمية الحقل، و`sidebar-ar-light`
  فيها جملة الجلسات الفارغة. فُحص صندوق الفرق لكل لقطة، ورُوجعت بالعين
  `agent-mcp-ar-light` و`sidebar-ar-light` و`workspaces-ar-light` و`schedules-ar-light`.
- لا نص مكتوب مباشرة في المكوّنات يقول Workspace أو مساحة؛ كل النصوص من ملفات
  اللغة.

### ما بقي «workspace» ولماذا

- رسائل الخادم في `packages/server/src/i18n/ar.json` و`en.json` تقول «مساحة العمل»
  / "workspace" وتصل إلى الواجهة كما هي عبر `describeError`:
  `profile_required`، `profile_not_found`، `provider_not_configured`،
  `profile_unknown`، `default_profile_outside`، `slug_taken`،
  `default_profile_immutable`، `no_tts_provider`. خارج نطاق هذه المهمة (كود
  الخادم)، وتحتاج مهمة لاحقة.
- تفاصيل أخطاء لا تعرضها الواجهة حرفيًا: `models/service.ts`
  (`… is already added to this workspace`، `the workspace has no such model …`).
- مثال `workspace_name: 'مساحتي'` في `packages/contracts/openapi.yaml` (العقد)
  وفي `packages/server/src/modules/auth/setup.test.ts`.
- أسماء المفاتيح (`workspaces.*`، `shell.workspace`…)، والمكوّنات
  (`WorkspacesTab`، `WorkspaceSwitcher`)، ومعرّفات الاختبار، وعناوين الاختبارات
  وتعليقاتها، واسم اللقطة `workspaces-ar-light.png`: أسماء برمجية لا يراها
  المستخدم.

## الفحوص

بعد إعادة القاعدة على `origin/main` (1ae078f):

```text
$ pnpm lint
Checking formatting...
All matched files use Prettier code style!            (exit 0)

$ pnpm typecheck                                      (exit 0)

$ pnpm contracts:check-clients
check-clients  OK — 205 client file(s) scanned, 166 contract path(s) known.

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web

$ pnpm --filter @majlis/web test
 Test Files  30 passed (30)
      Tests  388 passed (388)

$ pnpm --filter @majlis/web build
✓ built in 691ms

$ cd packages/web && PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test
  23 passed (1.2m)
```

## المخاطر والرجوع

- تغيير نصوص فقط؛ لا بيانات ولا عقد ولا سلوك. الرجوع: `git revert` لهذا الالتزام.
- إلى أن تُحدَّث رسائل الخادم قد يرى المستخدم «مساحة العمل» في رسالة خطأ بجانب
  «البروفايل» في الواجهة.

## التسليم والخطوة التالية

- PR إلى `main` للمراجعة؛ الدمج للمالك وحده.
- الخطوة التالية: مهمة منفصلة لرسائل الخادم في `packages/server/src/i18n/*.json`
  المذكورة أعلاه، إن وافق المالك.
