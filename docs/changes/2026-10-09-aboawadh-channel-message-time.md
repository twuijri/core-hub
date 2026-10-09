# محادثات القنوات: وقت كل رسالة وتاريخها
المسؤول: aboawadh · الفرع: feat/channel-message-time · الحالة: review

## المشكلة والهدف
محادثة تيليجرام أو واتساب المفتوحة في المركز تُقرأ بعد وقوعها، ولا يظهر فيها متى أُرسلت كل رسالة: لا يُعرف هل الرد جاء
بعد دقيقة أو بعد يوم، ولا متى طلب الشخص ما طلب. الوقت موجود أصلًا في كل رسالة (`ChannelMessage.created_at`، حقل إلزامي
في العقد)، والواجهة لا تعرضه.

الهدف: وقت كل رسالة تحتها، دائمًا، والتاريخ الكامل عند التمرير ولقارئ الشاشة.

## القرار والموافقات
- مكوّن `ChannelTime` في `ChannelConversationView.tsx` تحت كل رسالة: رسالة الشخص، ورد الوكيل، وما كُتب من المركز (لا
  الرسالة التي لم يستلمها Hermes بعد، فلا وقت لها).
- الكلمات نفسها التي تقولها المحادثة (`messageTime` من `MessageActions.tsx`): الساعة اليوم، «أمس» والساعة، ثم التاريخ
  القصير والساعة، بلغة القارئ وأرقام لاتينية، والسنة فقط إن لم تكن هذه السنة.
- يظهر دائمًا، لا عند التمرير كما في المحادثة الحية: محادثة القناة تُقرأ بعد الحدث، فـ«متى» فيها أهم.
- التاريخ الكامل (`dateStyle: full` + الساعة، في منطقة القارئ) في `<Tooltip>` من `src/ui/Tooltip.tsx` وفي `aria-label`،
  لا في `title` (قاعدة الطبقة: لا تلميح من المتصفح). العنصر `<time dateTime>` بالقيمة الأصلية.
- لا نص جديد للترجمة: `chat.time_yesterday` موجود.

الموافقات: مقترح لمراجعة المالك.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. `created_at` في كل رسالة أصلًا.

## الملفات والتأثير
- `packages/web/src/chat/ChannelConversationView.tsx` — `ChannelTime` تحت الرسائل الثلاث.
- `packages/web/src/styles/chat.css` — `.msg-time-channel`: سطر تحت الرسالة، إلى جهة الشخص في رسالته.
- `packages/web/tests/channel-conversations.test.tsx` — اختبار: وقت لكل رسالة بقيمتها الأصلية، والتاريخ الكامل في التسمية.
- الأثر: الويب فقط؛ الجوالات على حالها.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ pnpm --filter @corehub/web exec vitest run
 Test Files  133 passed (133)
      Tests  1621 passed (1621)

$ pnpm --filter @corehub/web typecheck
(exit 0)

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm i18n:check
i18n:check  android: 2641 keys, ar/en in parity
i18n:check  OK
```

```
$ pnpm change-record:check
$ node scripts/check-change-record.mjs
change-record  OK — 1 record(s) valid
```

## المخاطر والرجوع
- سطر صغير تحت كل رسالة؛ لا بيانات جديدة ولا طلبات جديدة.
- الرجوع: إرجاع الطلب.

## التسليم والخطوة التالية
بعد الدمج: الجوالات (أندرويد وiOS) تأخذ القاعدة نفسها في شاشة محادثة القناة، في طلب منفصل.
