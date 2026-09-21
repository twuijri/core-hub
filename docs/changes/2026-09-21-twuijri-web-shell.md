# عميل الويب — المرحلة ١: نظام التصميم، هيكل التطبيق، وشاشة المحادثة
المسؤول: twuijri · الفرع: feat/web-shell · الحالة: review

## المشكلة والهدف
اكتملت المرحلة صفر بعميل مرجعي من الطرفية (`packages/cli`). لا يوجد بعد عميل ويب يطبّق
`docs/clients/NAVIGATION.md` فوق العقد، ولا نظام تصميم واحد تُشتق منه السمات والألوان
لبقية العملاء (سطح المكتب والهواتف لاحقًا).

الهدف (توجيه المالك 2026-09-21): عميل ويب محوره المحادثة — قائمة جانبية، عمود قراءة واحد
متمركز (≈48rem)، ملحن (composer) عائم في الأسفل، لوحة جانبية يمنى قابلة للسحب والطيّ
للمخرجات/الكود/المعاينة/اللوحة؛ مظهر «زجاجي» (شفافية وتمويه على الأطر العائمة فقط،
والمحتوى صلب)؛ نظام رموز تصميم واحد (JSON مصدرًا + متغيّرات CSS مولَّدة) بمقياس زجاج
واحد (0..3) وسمتين فاتحة/داكنة، يحترم `prefers-reduced-transparency` و
`prefers-reduced-motion` تلقائيًا، وباختبار تباين WCAG AA محسوب من الرموز؛ سحب وإفلات
بمكتبة واحدة وبمكافئ لوحة مفاتيح لكل سحب؛ العربية أولًا مع RTL كامل والإنجليزية، وخصائص
CSS منطقية فقط.

## القرار والموافقات
- **الغرفة النظيفة (ADR 0004):** لم يُفتح أي ملف تحت `agent-studio/packages/*` ولا كود واجهة
  لأي منتج آخر. كل شيء مشتق من العقد ووثائق هذا المستودع والعميل المرجعي `packages/cli`
  (أنماطه للمصادقة والتجديد والاستئناف أُعيدت كتابتها للمتصفح، ولم يُستورد منه شيء).
- **الحزم:** `packages/ui-tokens` (`@majlis/ui-tokens`): `tokens.json` مصدر الحقيقة،
  `scripts/build.mjs` يولّد `dist/tokens.css` و`dist/tokens.js/.d.ts`؛ اختبار التباين يقرأ
  الملف نفسه. `packages/web` (`@majlis/web`): Vite 8 + React 19 + TypeScript strict +
  React Router 8 + TanStack Query 5 (HTTP عبر `createHubClient` المولَّد) + socket.io-client
  لـ`/rt/*` + Tailwind 4 (الرموز متغيّرات CSS تُعرَّف في `@theme`) + Vitest/Testing Library +
  Playwright. لم يُختَر vanilla-extract: Tailwind 4 يقبل متغيّرات CSS مباشرة ولا يحتاج
  طبقة بناء إضافية، والرموز تبقى في JSON لا في TypeScript كي تُصدَّر إلى Kotlin/Swift.
- **السحب والإفلات:** `@dnd-kit` (core + sortable) وحدها: إعادة ترتيب الجلسات في القائمة
  (بـ`KeyboardSensor` لمكافئ لوحة المفاتيح)، إسقاط الملفات في الملحن (HTML drag events مع
  زر «إرفاق» كمكافئ)، وتغيير حجم اللوحة اليمنى (مؤشر + أسهم لوحة المفاتيح على المقبض).
- **ترتيب الجلسات:** العقد لا يملك حقل ترتيب يدوي (`pinned` فقط)؛ الترتيب اليدوي يُحفظ محليًا
  لكل مساحة عمل (`localStorage`) ويُوثَّق كقيد. التثبيت والأرشفة عبر `sessions.update`.
- **مقياس الزجاج** ليس في `Preferences` بالعقد؛ يُحفظ محليًا مع السمة واللغة، وتُرسل السمة
  واللغة وحجم النص إلى `auth.setPreferences` عند تسجيل الدخول.
- **التسمية «المهام»:** بقرار المالك (2026-09-21) المقطع `board` صار `tasks` (Tasks / المهام) في
  الخريطة والمصطلحات وملفي اللغة ومسار الويب `/tasks`؛ وسم العقد `board` يُعاد تسميته في
  فرع موازٍ، ولم يُمسّ هنا.
- **الخريطة:** كل شاشة وجهة واحدة من `docs/clients/navigation.json`. أُضيف إلى الملف قسم
  `surfaceRoutes.web` (المسار لكل وجهة على الويب) ويتحقق منه `nav:check` (كل مفتاح وجهة
  معروفة، كل وجهة على الويب لها مسار، لا مسار مكرر). الوجهات التي لم تصل وحداتها بعد
  (الغرف، اللوحة، الجدولة، المعرفة، النماذج، ...) لها شاشة صريحة تقول «تصل في المرحلة N»
  — لا حالة فارغة صامتة. الدخول وإقران QR ليسا وجهتين: الدخول قبل المصادقة، والإقران
  داخل `device_connections` (تبويب App) كما تقول الخريطة.
- **الخدمة من المركز:** `packages/server/src/app/web.ts` يقدّم `packages/web/dist` على `/`
  بـ`@fastify/static` مع رجوع SPA إلى `index.html` لأي مسار لا يبدأ بـ`/api/` أو `/rt`؛
  `/api/*` المجهول يبقى `404 {error, code}`. إن غاب المجلد (تشغيل CLI فقط) لا يتغير شيء.
  لا متغيّر بيئة جديد (الثابت 5).
- لم يُدفع الفرع ولم يُفتح PR ولم يُنشر شيء.

## العقد
لا تغيير في `openapi.yaml` ولا في `events/`. تغيير واحد في غلاف العميل المولَّد
`packages/contracts/src/client.ts`: قبول `FormData` كجسم (يُرسل كما هو بلا `Content-Type`
يدوي) كي يعمل `sessions.uploadAttachment` من المتصفح. ما لوحظ: عمليات المرفقات تجيب `501`
على الخادم اليوم؛ منطقة الإسقاط تعرض الخطأ كما هو.

## الملفات والتأثير
**جديد `packages/ui-tokens/`**: `tokens.json` (المصدر)، `scripts/build.mjs` (يولّد
`dist/tokens.css` بمتغيّرات `--mj-*`: سمتان، مستويات الزجاج 0..3، معالجة
`prefers-reduced-transparency` و`prefers-reduced-motion`؛ و`dist/tokens.js/.d.ts`)،
`src/contrast.ts` (لمعان WCAG ونسبة التباين والتركيب فوق الشفافية)،
`tests/contrast.test.ts` (89 فحصًا: كل زوج نص/خلفية معلَن في السمتين، والنص فوق الزجاج
عند كل مستوى)، `README.md`.

**جديد `packages/web/`**: `index.html`، `vite.config.ts` (وكيل `/api` و`/rt` في التطوير)،
`tsconfig*.json`، `vitest.config.ts`، `playwright.config.ts`، `README.md`.
- `src/styles/app.css` — Tailwind 4 مغذًّى بالرموز عبر `@theme inline`؛ صنف `.glass` الوحيد
  للأطر العائمة؛ تنسيق Markdown والكود بألوان الرموز؛ خصائص منطقية فقط.
- `src/i18n/{ar,en}.json` + `index.ts` + `context.tsx` — 204 مفتاحًا.
- `src/design/theme.tsx` — السمة/الزجاج/اللغة/حجم النص على جذر المستند، محليًا ثم
  `auth.setPreferences`.
- `src/navigation/manifest.ts` (قراءة الملف من المستودع، الأدوار، القدرات)، `routes.tsx`
  (سجلّ المسارات من `surfaceRoutes.web`).
- `src/auth/store.ts` (المخزن)، `client.ts` (تجديد واحد عند `401 token_expired` واستباقي
  قرب الانتهاء)، `context.tsx` (دخول/خروج/تبديل مساحة العمل بلا تنقّل).
- `src/realtime/{socket,envelope,context}.ts(x)` — المسافات على `/rt`، الظرف، مقبس واحد لكل
  مسافة، نقطة الاتصال.
- `src/hub/queries.ts` — TanStack Query؛ كل مفتاح يحمل مساحة العمل.
- `src/shell/{AppShell,Sidebar,TopBar,SplitPane,pane,WorkspaceSwitcher}.tsx` — الهيكل.
- `src/chat/transcript.ts` (مخفّض صافٍ)، `useSessionStream.ts` (الاشتراك، `after_seq`،
  إعادة المزامنة عند `truncated`)، `Markdown.tsx`، `ToolCallCard.tsx`، `ApprovalCard.tsx`،
  `MessageView.tsx`، `Composer.tsx`، `ChatScreen.tsx`.
- `src/sessions/{SessionList.tsx,order.ts}` — تصفية/تثبيت/أرشفة/حذف/إعادة ترتيب بـdnd-kit.
- `src/agents/{AgentManagerScreen.tsx,useJobs.ts}` — التثبيت/الإزالة/إعادة التشغيل وتقدّم
  المهمة من `/rt/jobs`، وقائمة «تحت الوكيل» من القدرات.
- `src/settings/{SettingsScreen,AccountTab,DisplayTab,ThemeTool}.tsx`.
- `src/screens/{Login,NewChat,Search,History,DeviceConnections,Placeholder}Screen.tsx`.
- `src/ui/{icons.tsx,Notice.tsx}`، `src/types.ts`، `src/app.tsx`، `src/main.tsx`.
- الاختبارات `tests/`: `navigation.parity.test.tsx` (القواعد 1–7)، `workspace.test.tsx`
  (القاعدة 8)، `logical-css.test.ts`، `i18n.test.ts`، `transcript.test.ts`،
  `auth-client.test.ts`، `theme.test.tsx`، `approval-card.test.tsx` — 73 فحصًا.
- `e2e/hub.ts` (الخادم الحقيقي + مشغّل مكتوب بالسيناريو بتوقفات فعلية + نقطة اختبار
  لإسقاط المقابس)، `e2e/smoke.spec.ts` (الرحلات الثلاث + لقطات الشاشة).

**الخادم**: جديد `packages/server/src/app/web.ts` و`tests/unit/web.test.ts` (7 فحوص)؛
تعديل `app/server.ts` (`webDir`، `hub.web`)، `main.ts` (سطر السجل)، `tests/unit/helpers.ts`
(`webDir: null`)، `package.json` (`@fastify/static`)، `Dockerfile` (نسخ `ui-tokens`
و`web` و`cli` و`docs/clients/navigation.json` إلى مرحلة البناء، ونسخ `packages/web/dist`
إلى وقت التشغيل).

**العقد**: `packages/contracts/src/client.ts` (FormData).
**الخريطة**: `docs/clients/navigation.json` (`surfaceRoutes.web`، `tasks`)،
`docs/clients/NAVIGATION.md`، `scripts/navigation-check.mjs`.
**الربط**: `package.json` (سكربتات `web:dev`/`web:e2e`/`tokens:build`؛
`--workspace-concurrency=1` في `typecheck`/`test`/`build` — انظر المخاطر)،
`pnpm-lock.yaml`، `eslint.config.js` (tsx + globals المتصفح)، `scripts/i18n-check.mjs`
(`web` إلزامي)، `.github/workflows/ci.yml` (فحص وجود `dist/index.html`، وظيفة `web-e2e`،
وفحص `/chat` في اختبار الصورة)، `.dockerignore`، `.gitignore`، `.prettierignore`.
**الوثائق**: `AGENTS.md`، `docs/DEPLOY.md`، `docs/clients/README.md`،
`docs/harness/{README,validation}.md`.

### ما يعمل (مُثبَت بالاختبار من طرف إلى طرف ضد الخادم الحقيقي)
دخول → جلسة جديدة (الوكيل من سجلّ الخادم) → رد مبثوث Markdown بعناوين وتشديد وكود ملوّن
وطيّة تفكير وبطاقة أداة تُفتح في اللوحة الجانبية (والمقبض يعمل بلوحة المفاتيح) → السمة
الداكنة ومستوى الزجاج والإنجليزية LTR من الإعدادات → بطاقة موافقة بأزرار مرة/الجلسة/دائمًا/رفض
تمرّ عبر `sessions.respondApproval` → إسقاط المقبس أثناء التشغيل واستئناف بـ`after_seq`
بلا فقد → الصورة تُبنى وتخدم العميل من `/` مع الروابط العميقة ولا تحجب `/api`.

## الفحوص
شُغِّلت محليًا على `feat/web-shell` (Node v24.21.0، pnpm 12.5.1) بعد آخر التزام للكود:

```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!
exit=0

$ pnpm i18n:check
i18n:check  server: 72 keys, ar/en in parity
i18n:check  cli: 167 keys, ar/en in parity
i18n:check  web: 204 keys, ar/en in parity
i18n:check  desktop: apps/desktop/src/i18n not present yet — skipped
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 35 destinations, 37 terms, ar/en complete, routes for web

$ pnpm contracts:lint
contracts:lint  validating 90 event schema file(s)
contracts:lint  OK

$ pnpm contracts:check-clients
check-clients  OK — 92 client file(s) scanned, 161 contract path(s) known.

$ pnpm typecheck        # contracts, ui-tokens, cli, server, web
exit=0

$ pnpm test
 Test Files  3 passed (3)                Tests  11 passed (11)     # contracts
 Test Files  1 passed (1)                Tests  89 passed (89)     # ui-tokens (التباين)
 Test Files  10 passed (10)              Tests  55 passed (55)     # cli
 Test Files  31 passed | 1 skipped (32)  Tests  193 passed | 1 skipped (194)  # server
 Test Files  8 passed (8)                Tests  73 passed (73)     # web
exit=0

$ pnpm contract:test
 Test Files  2 passed (2)     Tests  247 passed (247)

$ pnpm build
dist/index.html                   0.71 kB │ gzip:   0.44 kB
✓ built in 602ms
exit=0
$ node packages/cli/dist/bin.js --version
0.0.0

$ pnpm --filter @majlis/web test:e2e        # Playwright، chromium، ضد الخادم الحقيقي
  ✓  1 … 1. login → new session → streamed markdown reply with reasoning, tool card and code (1.8s)
  ✓  2 … 2. an approval card answers once / session / always / deny through the hub (802ms)
  ✓  3 … 3. a socket drop mid-run resumes with after_seq and loses nothing (3.2s)
  3 passed (8.2s)

$ node scripts/check-change-record.mjs --files docs/changes/2026-09-21-twuijri-web-shell.md
change-record  OK — 1 record(s) valid

$ DOCKER_BUILDKIT=0 docker build -f packages/server/Dockerfile -t majlis:web-shell .
Successfully tagged majlis:web-shell          # 1.3 GB
$ docker run -d --name majlis-web-smoke -p 127.0.0.1:18081:8080 -e HUB_ADMIN_PASSWORD=… majlis:web-shell
health: {"ok":true,"server_version":"0.0.0","uptime_seconds":2}
root: 200 text/html; charset=utf-8
deep link /chat/abc: id="root"
asset assets/index-6RNpAEWS.js: 200 cache-control=public, max-age=31536000, immutable
api 404: {"error":"The requested item does not exist.","code":"not_found"}
log: "web":true
```
لقطات الشاشة (Playwright): `login-ar-light`، `chat-empty-ar-light`، `chat-reply-ar-light`،
`chat-pane-ar-light`، `settings-ar-dark`، `chat-reply-en-dark`، `settings-en-light`،
`approval-ar-light` — أُنتجت في مجلد العمل المؤقت للمساعد (`MAJLIS_SHOTS`)، لا في المستودع.

لم يُشغَّل: `pnpm contracts:generate` كاملًا (Kotlin/Swift؛ العقد لم يتغيّر، و`generate:ts`
يجري ضمن typecheck/build)، هجرة PostgreSQL (لا تغيير في المخطط)، وتشغيل ضد Hermes حقيقي
(المشغّل المكتوب بالسيناريو فقط، كما طُلب).

## المخاطر والرجوع
- **الحجم:** حزمة JS واحدة ≈ 847 KB (265 KB gzip) بلا تقسيم؛ Vite يحذّر. مقبول للمرحلة،
  ويُقسَّم لاحقًا (react-markdown/highlight في chunk كسول).
- **تحذير بناء:** `@majlis/contracts` يصدّر `document.ts` (node:fs) مع العميل؛ Vite يعزله
  للمتصفح ولا يُستدعى. الأنظف لاحقًا: مدخل `@majlis/contracts/client` منفصل.
- **سباق التوليد:** في بناء الصورة الأول فشل `pnpm build` لأن الحزم الخمس تعيد توليد
  `generated/ts/schema.ts` بالتوازي (الخطر الذي توقّعه سجل العميل المرجعي). العلاج المطبَّق:
  `--workspace-concurrency=1` في سكربتات الجذر؛ البناء أبطأ قليلًا لكنه حتمي.
- **المرفقات:** `sessions.uploadAttachment` تجيب `501` على الخادم اليوم؛ منطقة الإسقاط تعرض
  الخطأ باسم العملية ولا تدّعي النجاح. الملفات المرفوعة لا تُرسل حتى تنجح.
- **الترتيب اليدوي للجلسات** محلي لكل متصفح (لا حقل في العقد)؛ يُنقل إلى العقد إن أراده المالك
  متزامنًا بين الأجهزة.
- **مستوى الزجاج** محلي (ليس في `Preferences`).
- **`this_device`** لا شاشة له على الويب بقصد (الخريطة تحصره في سطح المكتب والهواتف).
- **الوجهات المؤجّلة** (الغرف، المهام، الجدولة، المعرفة، النماذج، تبويبات الإعدادات عدا
  الحساب/العرض/السمة، الأدوات عدا السمة، مستوى الوكيل) شاشات صريحة تقول المرحلة؛ لا وظيفة.
- **الرجوع:** حذف `packages/web` و`packages/ui-tokens` وملف `app/web.ts` وسطور الربط؛ الخادم
  بلا `dist` يعمل كما كان (مُختبَر: `/` تبقى `404 {error, code}`).

## التسليم والخطوة التالية
1. مراجعة المالك للفرع `feat/web-shell` (7 التزامات فوق `feat/phase-0-complete`). لم يُدفع
   ولم يُفتح PR بطلب المكلِّف.
2. بعد الدمج: بناء صورة `test` ونشرها على مكدّس التست (Checkpoint A) ثم فتح `/` من المتصفح
   والاقتران بهاتف حقيقي.
3. المرحلة التالية للويب: تقسيم الحزمة، شاشة الغرف والمهام عند وصول وحدتيهما، إكمال تبويبات
   الإعدادات، ومدخل `@majlis/contracts/client` للمتصفح.
