# نسخة واحدة لكل مخرجات كور هب، تبدأ من 1.1.0
المسؤول: twuijri · الفرع: chore/one-version-1.1.0 · الحالة: done

## المشكلة والهدف
كانت كل حزمة `0.0.0`، والمركز خارج الصورة يقول `0.0.0`، وتطبيق أندرويد `versionName = "0.1.0"`
مكتوبًا في Gradle، وiOS `MARKETING_VERSION: 0.1.0`، وسطح المكتب `0.0.0` ما لم يُختم. وأرقام البناء
الموقّعة = رقم تشغيل سير العمل، بينما تطبيقات الفورك القديم بنفس المعرّف `com.twuijri.corehub` بلغت
1.0.2 على TestFlight وأرقام بناء حتى 63؛ فالتطبيقات الجديدة يجب أن تكون أحدث منها.

الهدف: نسخة واحدة لكل ما يُسلَّم (المركز، الويب، الصورة، سطح المكتب، أندرويد، iOS) من مصدر واحد.

## القرار والموافقات
قرار المالك (٢٠٢٦-٠٩-٢٦): «خل كل النسخ تبدا من 1.1.0 … مهب بس الايفون علشان يكونون كلهم اصدار واحد».

ما بُني عليه (ضمن توجيه المالك، مقترح — للمالك أن يؤكد):
- مصدر النسخة الوحيد: `version` في `package.json` الجذر = `1.1.0`، وكل حزم مساحة العمل تحمل الرقم
  نفسه، و`pnpm version:check --write` ينسخه إليها وإلى iOS والـDockerfile عند الرفع.
- النسخة الجذرية `X.Y.Z` صرفة (App Store لا يقبل غيرها)؛ المعاينة تضيف لاحقتها وقت البناء فقط.
- تشغيل يدوي لـ`release.yml` يقول `1.1.0-preview.<run>` بدل اسم الوسم.
- أرقام البناء الموقّعة = رقم التشغيل + 100، والبناء المحلي يبقى 1.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء في العقد. رقم حزمة `@corehub/contracts` صار `1.1.0` (ليس نسخة العقد `info.version`).

## الملفات والتأثير
- `package.json` الجذر: `1.1.0` وسكربت `version:check`؛ وكل `package.json` في `packages/*` و`apps/*` = `1.1.0`.
- `scripts/version-check.mjs` (جديد): يفشل إن اختلف أي `package.json` في مساحة العمل، أو
  `MARKETING_VERSION` في iOS، أو القيمة الافتراضية لـ`ARG COREHUB_VERSION`، أو إن كتب أندرويد
  `versionName` بدل قراءته من الجذر، أو إن كان وسم `v*` (من `GITHUB_REF` أو `--tag`) بنسخة أخرى.
  `--write` ينسخ نسخة الجذر إلى النسخ المكتوبة.
- `packages/server/src/app/server.ts` (`readVersion`): بلا ختم يقرأ `package.json` الجذر (المسمّى
  `corehub` فقط)، ثم `package.json` الخادم نفسه (في المركز المضمَّن في سطح المكتب)، ثم `0.0.0`.
  `config.ts`: تعليقات فقط.
- `packages/web/vite.config.ts`: الاحتياط من `package.json` الجذر.
- `packages/server/Dockerfile`: `ARG COREHUB_VERSION=1.1.0`.
- `apps/android/app/build.gradle.kts`: `versionName = rootVersion` مقروءًا بـ`JsonSlurper` من الجذر.
- `apps/ios/project.yml`: `MARKETING_VERSION: 1.1.0` (نسخة يتحقق منها الفحص).
- `apps/desktop/scripts/package.mjs`: بلا `COREHUB_VERSION` يختم نسخة الجذر.
- `.github/workflows/ci.yml`: خطوة `pnpm version:check` في مهمة "Lint, typecheck, contracts, client tests, build" (لم يتغيّر اسم أي مهمة).
- `release.yml`: خطوة تحسب النسخة (فحص + `<root>-preview.<run>` للتشغيل اليدوي) وتمررها للبناء
  وملصق `org.opencontainers.image.version`؛ رفض `latest` وفحص الوسم على `main` كما هما.
- `android-signed.yml` و`ios-signed.yml`: خطوة "Build number" = `run_number + 100`؛ وهما و`desktop-signed.yml`
  يشغّلون `version-check` على وسم `v*`. أوصاف مدخل `version` في `desktop.yml` و`desktop-signed.yml` و`ios-signed.yml`.
- الاختبارات: `packages/server/tests/unit/version.test.ts`، `packages/contracts/tests/version-check.test.ts`.
- الوثائق: `docs/RELEASING.md` (قسم «One version»)، `docs/STATUS.md` (قسم Version)، `apps/desktop/README.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (كل أمر ثقيل عبر `mj-run`؛ أندرويد بـJDK 17):

```
$ pnpm version:check
version: 1.1.0 everywhere (8 places)
$ GITHUB_REF=refs/tags/v1.0.2 node scripts/version-check.mjs      → exit 1
  tag v1.0.2: does not match the root version 1.1.0
$ GITHUB_REF=refs/tags/v1.1.0 node scripts/version-check.mjs
version: 1.1.0 everywhere (8 places, tag v1.1.0)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck                                                   → exit 0
$ pnpm --filter @corehub/contracts exec vitest run tests/version-check.test.ts
 Test Files  1 passed (1)      Tests  7 passed (7)
$ pnpm --filter @corehub/server exec vitest run --project unit tests/unit/version.test.ts tests/unit/config.test.ts tests/unit/http.test.ts
 Test Files  3 passed (3)      Tests  20 passed (20)
$ ./gradlew --no-daemon --max-workers=2 assembleDebug   (apps/android)
BUILD SUCCESSFUL in 1m 5s
$ aapt2 dump badging app-debug.apk
package: name='com.twuijri.corehub' versionCode='1' versionName='1.1.0' …
$ pnpm --filter @corehub/web build                     → الحزمة تحمل `1.1.0`
$ COREHUB_VERSION=1.1.0-preview.7 pnpm --filter @corehub/web build → الحزمة تحمل `1.1.0-preview.7`
```

CI على #144 عند الإيداع `80812eb` (كل التشغيلات ناجحة):

```
CI (run 36163262163): success — كل المهام، ومنها "Lint, typecheck, contracts, client tests, build":
  One version everywhere (root package.json; docs/RELEASING.md)  version: 1.1.0 everywhere (8 places)
  Docker image builds and answers /health: success
Android: success · iOS: success · Desktop installers: success · Change record: success
```

لم يُشغَّل: أي سير عمل موقّع أو `release.yml` (لم يوافق المالك على رفع TestFlight ولا صورة المعاينة)،
فحساب `run_number + 100` وملصق الصورة لم يُريا على بناء حقيقي؛ ولا `xcodegen` محليًا (لا ماك).

## المخاطر والرجوع
- وسم `v*` بنسخة تخالف الجذر يُرفض الآن في `release.yml` والبناءات الموقّعة (مقصود).
- `metadata-action` يضيف ملصق النسخة المخصّص بعد المولَّد، فيغلب — لم يُتحقق منه على صورة منشورة.
- رقم البناء قفز من رقم التشغيل إلى رقم التشغيل + 100؛ لا يمكن النزول عنه لاحقًا في المتاجر.
- الرجوع: revert لهذا الفرع يعيد `0.0.0` و`0.1.0` وأرقام التشغيل كما كانت.

## التسليم والخطوة التالية
- دُمج في `night/2026-09-26` (#144) عند `80812eb`؛ CI أخضر.
- الخطوة التالية للمالك: عند الموافقة، تشغيل `ios-signed.yml` برفع TestFlight للتحقق من 1.1.0 (1xx)،
  ثم وسم `v1.1.0` على `main` بعد دمج #143 و#144.
