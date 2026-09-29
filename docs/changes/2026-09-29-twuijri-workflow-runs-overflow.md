# سير العمل: قائمة التشغيلات والمخرجات لا تخرج عن إطارها
المسؤول: twuijri · الفرع: fix/workflow-runs-overflow ← batch/2026-09-29c · الحالة: review

## المشكلة والهدف
صورة المالك (٢٠٢٦-٠٩-٢٩، تبويب Runs): نص قائمة اختيار التشغيل («Done · Sep 29, 2026, 3:41 PM · 1244errnc…») يركب على حقل
«Find a run»، ومخرجات خطوة الإرسال (JSON طويل بلا مسافات: `"message_ids":["921"],"delivered_to":[…]`) تخرج عن لوحة الخطوة.

## القرار والموافقات
- قائمة التشغيل بعرض ثابت `w-72 max-w-full min-w-0` فينتهي النص بـ«…» (المكوّن يقطع أصلًا إن حُدّ عرضه).
- المخرجات تلتفّ في أي موضع (`overflow-wrap:anywhere`، `min-w-0`).
- مخرج JSON (مثل نتيجة Send message) يُعرض منسّقًا على أسطر، من اليسار لليمين، بخط أحادي المسافة (`readableOutput`)؛ غيره كما هو.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
`packages/web/src/schedules/workflows/WorkflowEditor.tsx`، `StepPanel.tsx`، واختبار جديد `packages/web/tests/workflow-step-output.test.ts`. عرض فقط.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ npx vitest run tests/workflow-step-output.test.ts tests/workflow-editor.test.tsx
 Test Files  2 passed (2)
      Tests  21 passed (21)
```
typecheck الويب وeslint وprettier نظيفة.

## المخاطر والرجوع
عرض فقط. الرجوع: revert.

## التسليم والخطوة التالية
ضمن دفعة 2026-09-29c (PR واحد)، ينتظر دمج المالك.
