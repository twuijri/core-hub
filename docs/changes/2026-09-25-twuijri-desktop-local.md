# تطبيق سطح المكتب — الوضع المحلي (الجزء ٢ من ٤)
المسؤول: twuijri · الفرع: feat/desktop-local · الحالة: review

## المشكلة والهدف
الجزء الأول (#111) بنى الغلاف والوضع البعيد، وبطاقة «التشغيل على هذا الحاسوب» كانت تقول إنه ليس
في هذا الإصدار. ADR 0009 يطلب وضعًا محليًا: التطبيق يشغّل مركزًا مضمَّنًا على الجهاز وبياناته في
مجلد بيانات التطبيق، ويستخدم هرمز المثبَّت إن وُجد، وإلا يعرض «تثبيت هرمز» بمثبّت هرمز الرسمي ثم
يتبنّاه، ولا يحمل نسخة من هرمز أبدًا، وتبقى بيانات كل وضع منفصلة. تعليمات المالك قبل نومه:

> «كمل كل الشغل حتى لو تكمل تطبيق الديسك توب كامل … اي قرار تحتاجه مني اجله»

الفرع مبنيّ على `feat/desktop-app` (#111)، فطلب الدمج مكدَّس عليه.

## القرار والموافقات
كلها **مقترحة — تنتظر تأكيد المالك** (ADR 0021):

1. **المركز يُحمل حزمة واحدة** (`dist/hub`: كود الخادم نفسه وحدةً واحدة، والترحيلات، وملفات
   العقد، و`better-sqlite3` و`argon2`) خارج أرشيف التطبيق، ويُشغَّل ابنًا بـ Node الموجود داخل
   Electron. الوحدتان الأصليتان من نوع N-API وتأتيان مبنيّتين لكل الأنظمة، وجرّبتُ أنهما تعملان
   في Node الخاص بـ Electron دون إعادة بناء. حجم الحزمة 28 MB قبل الضغط، منها 17 MB ملفات SQLite
   لكل الأنظمة (تُقلَّم لنظام واحد عند التحزيم في الجزء ٤).
2. **يستمع على 127.0.0.1 فقط** وعلى منفذ حر، وبياناته في `<بيانات التطبيق>/local-hub` ونافذته في
   قسم تخزين `persist:local`، منفصلًا عن كل مركز بعيد.
3. **«يستخدم هرمز المثبَّت» يعني البرنامج لا المجلد**: يجد التطبيق برنامج `hermes` (في PATH ثم في
   الأماكن التي يضعه فيها مثبّت هرمز على لينكس وماك وويندوز) ويضع مجلده أول PATH المركز، فيشغّله
   المركز بمجلد هرمز خاص به داخل `local-hub` (الوضع `managed` في ADR 0008). وإن كانت بوابة هرمز
   تعمل أصلًا فيستخدمها كما هي. رفضت مشاركة `~/.hermes` لأن هرمز يحذّر من بوابتين على مجلد واحد،
   ولأن هرمز الشخص قد يكون يعمل عليه؛ ومفاتيح المزوّدين تُضاف مرة واحدة في كور هب (ADR 0010).
4. **تثبيت هرمز**: عند الضغط يُنزَّل سكربت هرمز الرسمي من موقعه (`install.sh` أو `install.ps1`)
   إلى ملف مؤقت ويُشغَّل بمصفوفة وسائط (`--non-interactive --skip-browser`)، والشاشة تعرض قبل ذلك
   بالضبط ما سيعمل، وتعرض مخرجاته أثناء التثبيت، ثم يبحث التطبيق من جديد ويبدأ الوضع المحلي.
5. **يمكن البدء دون هرمز** إن اختار الشخص ذلك: المركز يعمل ويظهر هرمز في وكلائه غير مثبَّت.
6. **مركز توقف وحده لا يُعاد تشغيله في حلقة**: يعود التطبيق إلى شاشة التشغيل الأول ويقول ذلك.
   وإنهاء التطبيق يوقف المركز (SIGTERM ثم SIGKILL بعد ١٠ ثوانٍ). والانتقال إلى مركز بعيد يوقفه.
7. `COREHUB_DESKTOP_HERMES_GATEWAY` يغيّر العنوان الذي يسأله التطبيق عن بوابة هرمز (بوابة على منفذ
   آخر، أو لا بوابة في الاختبار).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. المركز المضمَّن هو الخادم نفسه دون تعديل.

## الملفات والتأثير
- `apps/desktop/src/hub/entry.ts` (جديد): مدخل المركز المضمَّن — `buildServer({ webDir: null })`،
  والاستماع على 127.0.0.1، وإبلاغ المنفذ للتطبيق، والتوقف عند الإشارة أو غياب التطبيق.
- `apps/desktop/scripts/build-hub.mjs` (جديد) و`package.json` (البناء يشمله؛ `@corehub/server`
  اعتماد تطوير).
- `apps/desktop/src/shared/hermes-detect.ts` (جديد، صافٍ): أماكن هرمز على الأنظمة الثلاثة،
  وPATH المركز، ومثبّت هرمز الرسمي لكل نظام.
- `apps/desktop/src/main/hermes.ts` و`local-hub.ts` (جديدان): البحث والتثبيت، وتشغيل المركز
  ومراقبته وإيقافه.
- `apps/desktop/src/main/controller.ts` و`index.ts` و`src/shared/ipc.ts` و`src/preload/index.ts`
  و`src/renderer/welcome.ts|css` و`src/i18n/{ar,en}.json`.
- `packages/web`: `desktop/bridge-types.ts` (حالة الوضع المحلي)، `settings/ThisDeviceTab.tsx`
  (مجلد البيانات وهرمز المستخدَم)، ملفا اللغة، والاختبار.
- `docs/adr/0021-desktop-local-mode.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!

$ pnpm contracts:check-clients
check-clients  OK — 317 client file(s) scanned, 176 contract path(s) known.

$ pnpm i18n:check
i18n:check  desktop: 77 keys, ar/en in parity
i18n:check  OK

$ pnpm --filter @corehub/desktop typecheck      (بلا أخطاء)
$ pnpm --filter @corehub/web typecheck          (بلا أخطاء)

$ pnpm --filter @corehub/desktop test
 Test Files  6 passed (6)
      Tests  69 passed (69)

$ pnpm --filter @corehub/web exec vitest run tests/desktop-surface.test.tsx
      Tests  13 passed (13)

$ pnpm build && xvfb-run -a pnpm --filter @corehub/desktop test:smoke
Running 3 tests using 1 worker
  ✓  1 tests/smoke/desktop.spec.ts:44:1 › remote mode: connect, sign in, chat, This device (2.7s)
  ✓  2 tests/smoke/desktop.spec.ts:104:1 › pairing: a link from a signed-in device signs this computer in (1.4s)
  ✓  3 tests/smoke/desktop.spec.ts:139:1 › local mode: no Hermes found → the hub starts on this computer anyway → first-run setup (4.1s)
  3 passed (11.3s)
```
وقبل كتابة الكود شغّلت الحزمة المبنية يدويًا بـ Node الخاص بـ Electron وسألتها:
```
$ DATA_DIR=… PORT=18799 ELECTRON_RUN_AS_NODE=1 electron dist/hub/dist/app/hub.mjs
$ curl http://127.0.0.1:18799/api/v1/health
{"ok":true,"server_version":"0.0.0","uptime_seconds":4}
$ curl http://127.0.0.1:18799/api/v1/meta
{"name":"Core Hub",…,"setup_required":true,"setup_open":true,…}
```
اختبارات الكشف تغطي: لينكس (مثبّت المستخدم رغم PATH ناقص، PATH أولًا، `HERMES_HOME`، تثبيت الجذر)،
ماك (PATH المجرَّد لتطبيق يُفتح من Finder، Homebrew، البيئة داخل مجلد هرمز)، ويندوز
(`%LOCALAPPDATA%\hermes\bin` مع PATHEXT، ملف `.cmd` في PATH، المجلد من `USERPROFILE`). واختبار
الدخان الثالث يشغّل التطبيق على حاسوب بلا هرمز: تظهر شاشة «وكيل هرمز غير موجود» بأمر المثبّت
الرسمي، ثم «المتابعة دون هرمز» فيعمل المركز المضمَّن الحقيقي، ثم تهيئة أول تشغيل، ثم المحادثة،
و«هذا الجهاز» يقول «يعمل على هذا الحاسوب» ويعرض مجلد البيانات.

لم يُشغَّل مثبّت هرمز الحقيقي في أي اختبار (يُنزِّل ويُثبّت على الجهاز)؛ مساره مختبَر بتنزيل وتشغيل
مزيَّفين. CI على #113 — كلها ناجحة، ومنها اختبار الدخان تحت Xvfb (مع الوضع المحلي):
```
pass  Lint, typecheck, contracts, tests, build
pass  Desktop app smoke (Electron under Xvfb against the real hub)   1m13s
pass  Web smoke journeys (Playwright against the real hub)  5m23s
pass  Docker image builds and answers /health                3m6s
pass  db:generate + db:migrate (SQLite and PostgreSQL)       1m9s
pass  PR adds or updates a change record                    7s
pass  PR leaves graphify-out/ to the code-map bot           11s
```

## المخاطر والرجوع
- بوابة هرمز شخصية تعمل على 8642 يستخدمها المركز كما هي، ومفتاحه لن يطابقها؛ صفحة الوكلاء تقول
  حينها إن هرمز رفض. مذكور في ADR 0021.
- المثبّت يُنزَّل من موقع هرمز لحظة الضغط؛ إن تغيّرت وسائطه يفشل ويعرض مخرجاته.
- الرجوع: إعادة `localAvailable: false` في المتحكّم يعيد البطاقة إلى «ليس في هذا الإصدار».

## التسليم والخطوة التالية
- للمالك: تأكيد القرارات ١–٧ (أهمها ٣: برنامج هرمز مشترك ومجلده منفصل).
- التالي: الجزء ٣ — المساعد المحلي (MCP).
