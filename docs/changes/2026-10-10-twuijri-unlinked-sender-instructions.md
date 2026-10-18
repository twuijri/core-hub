# رسالة واضحة لمن يكلّم الوكيل من حساب تيليجرام/واتساب غير مربوط
المسؤول: twuijri · الفرع: fix/unlinked-sender-instructions · الحالة: review

## المشكلة والهدف
عاصم طلب تذكيرًا من تيليجرام بحساب غير مربوط بحسابه في الهب، فرفضت أدوات الهب (`hub_tools_sender_not_linked`) — وهذا مقصود (§79: الهوية تُثبت بالربط ولا تُكتب). لكن الجملة التي يقرؤها الوكيل كانت عامة («غير متاحة هنا؛ يمكن ربطه من الإعدادات»)، فلم يكن مضمونًا أن يقول الوكيل إن الطلب لم يُحفظ ولا كيف يُربط الحساب. المالك (٢٠٢٦-١٠-١٠): «اذا تبي يرد على الشخص بالتعليمات سوها».

## القرار والموافقات
الرفض نفسه لا يتغير. تغيّر نص الرفض الذي يصل للوكيل: يبدأ بـ«لم يُنفَّذ ولم يُحفظ شيء»، ويطلب منه إبلاغ الشخص بلغته، ويعطي الخطوات (الإعدادات ← الحساب ← حسابات المراسلة ← «ربط حساب»، ثم `/start` والرمز من الحساب نفسه خلال ١٠ دقائق، ثم إعادة الطلب)، وينهاه عن إعادة استدعاء الأدوات أو الادعاء بأن الطلب حُفظ.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء (الرمز `hub_tools_sender_not_linked` كما هو؛ تغيّر النص فقط).

## الملفات والتأثير
- `packages/server/src/modules/agents/hub-tools/service.ts`
- `packages/server/src/modules/agents/hub-tools/channel-identity.routes.test.ts`

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ npx vitest run --project unit src/modules/agents/hub-tools --maxWorkers=2
 Test Files  3 passed | 2 skipped (5)
      Tests  30 passed | 3 skipped (33)
$ npx prettier --check (الملفان)
All matched files use Prettier code style!
$ tsc --noEmit (packages/server)
exit 0
```

## المخاطر والرجوع
نص فقط. الرجوع بإعادة الجملة السابقة.

## التسليم والخطوة التالية
PR إلى main؛ يدخل 1.1.9.
