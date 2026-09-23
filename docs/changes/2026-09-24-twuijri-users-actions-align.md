# صفحة المستخدمين: زر «كلمة المرور» في مكان واحد لكل الصفوف
المسؤول: twuijri · الفرع: fix/users-row-actions-align · الحالة: review

## المشكلة والهدف
أرسل المالك (٢٠٢٦-٠٩-٢٤، بلقطة) أن زر «Password» في صف المالك ليس في مكانه في صف العضو:
«كلمة باسسورد مهب موزونه صح ؟». صف المالك ليس فيه حذف ولا «⋯»، فكان الزر يأخذ آخر الخلية،
بينما في صف العضو يسبقه زرّان. الهدف: الزر في المكان نفسه في كل الصفوف.

## القرار والموافقات
طلب المالك الإصلاح في الجلسة. أزرار كل صف صارت في ثلاث خانات ثابتة (`ActionSlots` في
`UsersTab.tsx`): كلمة المرور، ثم الحذف، ثم «⋯». الخانة التي لا زر فيها تبقى فارغة بعرضها، فيصطف
«كلمة المرور» عموديًا. ينطبق هذا على صف المالك وعلى صفك أنت (لا حذف فيه).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `packages/web/src/people/UsersTab.tsx`: `ActionSlots` وتغليف أزرار الصفين بها.
- `packages/web/e2e/shots/people-ar-light.png`: اللقطة الجديدة، الزر مصطف في الصفين.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @majlis/web exec vitest run tests/people.test.tsx
      Tests  14 passed (14)
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck        # exit 0
$ pnpm --filter @majlis/web build        # ok
$ PLAYWRIGHT_CHANNEL=chrome pnpm web:e2e
  25 passed (1.7m)
```

## المخاطر والرجوع
تغيير شكل فقط. الرجوع باسترجاع الـ commit.

## التسليم والخطوة التالية
PR إلى `main` للمراجعة.
