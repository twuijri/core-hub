# التذييل: لا يكرر اختيار البروفايل، ولا شريحة «النموذج الافتراضي»
المسؤول: twuijri · الفرع: fix/sidebar-footer-duplicates · الحالة: review

## المشكلة والهدف
لاحظ المالك (٢٠٢٦-٠٩-٢٤، بلقطة) أن اختيار البروفايل مكرر: في الشريط العلوي يمينًا وفي التذييل
يسارًا، وسأل عن شريحة «Default model» بجانبه. الشريحة كانت نصًا ثابتًا («النموذج الافتراضي»)
لا يذكر اسم النموذج ولا يفعل شيئًا عند الضغط. الهدف: تذييل أنظف بلا تكرار ولا شريحة بلا فائدة.

## القرار والموافقات
المالك: «وش رايك نشيل الي تحت يسار ؟» ثم «ايه» على حذف الاثنين. واتفقنا أن مكان البروفايل في
الويب وسطح المكتب هو الشريط العلوي، أما الجوال فمكانه **لم يُقرَّر** («ما ابي نضيق الشاشة … لو
خلينا شريط علوي دائم بيضيقها»). النموذج يُختار في خانة الكتابة وفي صفحة النماذج.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/web/src/shell/Sidebar.tsx`: حُذف صف البروفايل والشريحة من التذييل.
- `packages/web/src/shell/WorkspaceSwitcher.tsx`: حُذف خيار `compact` الذي لم يعد له مستخدم.
- `packages/web/src/i18n/{ar,en}.json`: حُذف `shell.model_chip` و`shell.model_default`.
- `docs/clients/navigation.json`: `topBarChips.workspace` جديد، و`footerChips` بلا `workspace`
  ولا `model`؛ مع ملاحظة أن الجوال لم يُقرَّر.
- `docs/clients/NAVIGATION.md`: فقرة الشريط العلوي والتذييل بالقرار نفسه.
- لقطات Playwright: التذييل ظاهر في كل لقطة، فتغيّرت كلها.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck        # exit 0
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web
$ pnpm --filter @majlis/web test
      Tests  417 passed (417)
$ pnpm --filter @majlis/web build        # ok
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  25 passed (1.6m)
```

## المخاطر والرجوع
شكل فقط؛ اختيار البروفايل باقٍ في الشريط العلوي. الرجوع باسترجاع الـ commit.

## التسليم والخطوة التالية
PR إلى `main`. مكان اختيار البروفايل في الجوال يُناقش مع تطبيق الجوال.
