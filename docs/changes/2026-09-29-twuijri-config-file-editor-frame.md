# ملفات إعداد الوكلاء: مربّع الكتابة ظاهر دائمًا
المسؤول: twuijri · الفرع: batch/2026-09-29b · الحالة: review

## المشكلة والهدف
صورة المالك (٢٠٢٦-٠٩-٢٩، صفحة ملفات إعداد Goose، `~/.config/goose/config.yaml` «لم يُنشأ بعد»): مربّع الكتابة لا يظهر
إلا بعد الضغط في وسط الصفحة. المحرر `CodeEditor` بلا إطار ولا خلفية، وصفحة الملفات في الـworkspace تلفّه بـ`files-editor-frame`
بينما صفحة ملفات إعداد الوكيل لا تفعل. الهدف: المربّع ظاهر دائمًا، والملف الفارغ يقول أين تكتب.

## القرار والموافقات
- `AgentConfigFilesScreen.tsx` يلفّ المحرر بـ`files-editor-frame` (إطار وخلفية، نفس صفحة الملفات).
- `CodeEditor` يأخذ `placeholder` اختياريًا، بلون النص الخافت (`::placeholder`؛ نص المحرر نفسه شفاف لأن طبقة التلوين تحته).
- نص جديد `config_files.empty_placeholder` بالعربية والإنجليزية.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
`packages/web/src/agents/AgentConfigFilesScreen.tsx`، `packages/web/src/workspace-files/CodeEditor.tsx`،
`packages/web/src/styles/screens.css`، `packages/web/src/i18n/{ar,en}.json`، `packages/web/tests/config-files.test.tsx`. عرض فقط.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ npx vitest run tests/config-files.test.tsx
 Test Files  1 passed (1)
      Tests  3 passed (3)
$ pnpm i18n:check
i18n:check  OK
```
typecheck الويب وeslint وprettier نظيفة.

## المخاطر والرجوع
عرض فقط. الرجوع: revert.

## التسليم والخطوة التالية
دفعة 2026-09-29b، ينتظر دمج المالك.
