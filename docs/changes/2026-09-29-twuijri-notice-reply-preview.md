# إشعار «أنهى الوكيل الرد» يعرض بداية الرد
المسؤول: twuijri · الفرع: feat/notice-reply-preview ← batch/2026-09-29d · الحالة: review

## المشكلة والهدف
صورة المالك (٢٠٢٦-٠٩-٢٩، شاشة قفل الآيفون): كل الإشعارات «Hermes finished» وتحتها اسم المحادثة فقط («تحليل طلب ClickUp»)،
فلا يُعرف ماذا قال الوكيل إلا بفتح التطبيق. الطلب: «الإشعار أقل شيء يجيب بداية الرسالة».

## القرار والموافقات
- `SessionsNotifier.runFinished` يأخذ `replyPreview` اختياريًا (بداية الرد مسطّحة، نفس `preview()` قائمة المحادثات، حتى 300 حرف).
- إشعار `run_completed`: إن وُجد الرد صار العنوان «<الوكيل> · <اسم المحادثة>» (أو «رد جديد» لمحادثة بلا اسم) والنص بداية الرد
  بلا علامات Markdown (`**`، `__`، ````، العناوين `#`، الاقتباس `>`)؛ بلا رد يبقى كما كان.
- «الإشعار الخاص» (private push عبر المرحّل) يبقى يستبدل العنوان والنص بسطر عام — لا تغيير عليه.
- الإشعار في صندوق الوارد يأخذ الصياغة نفسها.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
`packages/server/src/modules/sessions/{engine,ports}.ts`، `packages/server/src/modules/index.ts`، `packages/server/src/modules/notify/notices.ts`
و`notices.test.ts`. نص الإشعار فقط.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ npx vitest run src/modules/notify/notices.test.ts src/modules/notify/notify.test.ts src/modules/sessions/direct-run.test.ts
 Test Files  3 passed (3)
      Tests  33 passed (33)
```
typecheck الخادم وeslint وprettier نظيفة.

## المخاطر والرجوع
نص الرد يظهر على شاشة القفل؛ من لا يريده يفعّل «الإشعار الخاص». الرجوع: revert.

## التسليم والخطوة التالية
ضمن دفعة 2026-09-29d.
