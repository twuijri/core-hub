# شعار المجلس: حرف «C» الذي يحمل مربّعًا، بلون المجلس
المسؤول: twuijri · الفرع: feat/brand-mark · الحالة: review

## المشكلة والهدف
شعار المجلس كان حرف «م» داخل مربّع أخضر في القائمة الجانبية وفي بطاقة الدخول والتثبيت الأول
وصفحة «لا بروفايل»، وأيقونة المتصفح دائرة بيضاء في مربّع. طلب المالك (٢٠٢٦-٠٩-٢٤): «حطلي شعار
المجلس حاليا نفس شعار كور هب بالواننا الجديدة التركوازي». الشعار المقصود هو علامة هوية Core Hub
الخاصة بالمالك: حرف «C» مستدير الزوايا، في داخله حلقة مفتوحة من اليمين، وفي وسطها مربّع.

## القرار والموافقات
طلب المالك في الجلسة. التصميم:
- **العلامة مرسومة من جديد** من ثلاثة أشكال قيست من صورة المالك: المربّع الخارجي، والثقب (حلقة
  تنفتح يمينًا إلى الحافة)، والمربّع الداخلي. مسار واحد و`evenodd`، ولا نسخ من ملف في أي مشروع.
- **لون واحد يتبع السمة** (`currentColor`): لون `accent` في المكان الذي توضع فيه، أي التركوازي
  الغامق في السمة الفاتحة والفاتح في الداكنة. بلا مربّع خلفية في القائمة والبطاقات، كما في صورة
  المالك الأولى.
- **أيقونة المتصفح**: العلامة بيضاء على مربّع بلون `accent` الفاتح (`#0b6b5d`)، وهي نسخة المربّع
  الممتلئ من صور المالك؛ تُقرأ على شريط تبويبات فاتح وداكن.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/web/src/ui/brand/MajlisMark.tsx` (جديد): المكوّن والمسار (`MAJLIS_MARK_PATH`).
- `packages/web/src/shell/Sidebar.tsx`، `screens/LoginScreen.tsx`، `screens/SetupScreen.tsx`،
  `shell/ProfileGate.tsx`: العلامة مكان «م».
- `packages/web/src/styles/kit.css` (`.mj-sidebar-mark`) و`screens.css` (`.gate-mark`): لون
  `accent` بلا خلفية.
- `packages/web/index.html`: أيقونة المتصفح الجديدة.
- `packages/web/tests/brand-mark.test.tsx` (جديد): العلامة مسار واحد بـ`currentColor` و`evenodd`،
  وأيقونة المتصفح ترسم المسار نفسه فلا يفترقان.

## الفحوص (الأوامر ونواتجها الفعلية)
كل أمر ثقيل عبر غلاف الذاكرة (`systemd-run` بسقف ٧ غيغابايت، عاملان لـVitest).

```
$ pnpm typecheck                        # exit 0
$ pnpm --filter @majlis/web test        # exit 0
 Test Files  40 passed (40)
      Tests  517 passed (517)
$ pnpm lint                             # exit 0
All matched files use Prettier code style!
$ pnpm --filter @majlis/web build       # exit 0
✓ built in 702ms
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm exec vitest run tests/brand-mark.test.tsx
      Tests  2 passed (2)
# وعلى index.html القديم يفشل اختبار أيقونة المتصفح:
AssertionError: expected '<!doctype html>…' to contain 'M230 0H665A230 230 0 0 1 895 230V615A…'
```

ورسمتُ العلامة على خلفية فاتحة وداكنة وبالأحجام ١٦٠ و٦٤ و٣٢ بكسل وتأكدت أن الثقب والمربّع
الداخلي واضحان حتى في أيقونة المتصفح.

## المخاطر والرجوع
- صور `e2e/shots` القديمة تُظهر «م»؛ تتجدد حين تُشغَّل رحلات Playwright.
- الرجوع: استرجاع هذا الـcommit يعيد «م» والأيقونة القديمة.

## التسليم والخطوة التالية
PR إلى `main`. الخطوة التالية عند الحاجة: أيقونات التطبيقات (سطح المكتب والجوال) من المكوّن نفسه.
