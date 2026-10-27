# محادثات القنوات: تفتح على آخر رسالة، وزر «انزل لآخر رسالة»، وملاحظة تنطوي، وشرح «أكمل في كور هب»
المسؤول: twuijri · الفرع: fix/channel-chat-polish · الحالة: review · ينزل مع 1.1.10

## المشكلة والهدف
ملاحظات المالك (2026-10-27، من الديسكتوب على هب 1.1.8):
1. **محادثة تيليقرام تفتح من فوق.** فتح محادثة تيليقرام أو واتساب، ثم الذهاب لمحادثة ثانية والرجوع،
   يرجعه دائمًا لأعلى المحادثة بدل آخر رسالة.
   - السبب: `ChannelConversationView.tsx` ما فيه أي تحكم بالتمرير، بينما المحادثة العادية تستعمل
     `useFollowBottom`.
2. **كلام فوق الرسائل.** سطر «يُنشر أولًا على تيليقرام…» وزر «أكمل في كور هب» تحت مربع الكتابة
   مرسومان فوق الرسائل بلا خلفية، فيتداخل الكلام مع الرسائل.
3. **زر النزول لآخر رسالة.** المالك: «اقصد اخر المحادثه مهب اولها… يعني تحت». زر صغير يطلع إذا طلع
   القارئ فوق، في المحادثات العادية ومحادثات القنوات، على كل المنصات.
4. **ملاحظة تنطوي.** «لو يكون له خيار اذا قريته… اقدر الغية».
5. **شرح الزر.** إذا وقف الماوس على «أكمل في كور هب» يطلع مربع شفاف شوي يشرحه، بلغة البرنامج، ويختفي
   أول ما يبعد الماوس. النص بموافقة المالك:
   «تبي تنسخ محادثة تيليقرام وتكمل الشغل عليها داخل الهب؟ اضغط هنا. تنفتح محادثة جديدة في الهب، واللي
   تكتبه فيها يبقى في الهب وما يروح لتيليقرام. المحادثة الأصلية ما تتغيّر.»
   - صحّح المالك كلمة «هنا» إلى «المحادثة الجديدة»، حتى لا تُفهم أن خانة الكتابة الحالية ما ترسل.

## القرار والموافقات
- طلبات المالك نفسه في المحادثة (2026-10-27)، ونص الشرح بموافقته. اسم القناة صار متغيّرًا
  (`{channel}`)، حتى يصح النص مع واتساب.
- **خارج هذا الفرع:** شارة الموديل في محادثات القنوات (قرار المالك معلّق). وروابط المستودع والإصدارات
  (فرع `feat/repo-links`، #260).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- **الويب والديسكتوب:**
  - `chat/followBottom.ts`: `useScrolledAway` جديد، وهو المسافة عن الأسفل، بهامش 240 بكسل حتى لا
    يرمش الزر مع رد يكبر.
  - `chat/JumpToLatest.tsx` جديد: زر دائري ↓ فوق المربع.
  - `chat/Composer.tsx`: مكان `jump` في المرسى.
  - `chat/ChatScreen.tsx`: الزر في المحادثة العادية.
  - `chat/ChannelConversationView.tsx`:
    - `useFollowBottom` على نص المحادثة: تفتح على آخر رسالة، وتلحق الجديد، ولا تسحب القارئ وهو يقرأ
      القديم.
    - تنزل بعد ما يرسل الشخص.
    - الزر.
    - مرسى بخلفية: `composer-dock-solid`.
  - `chat/ChannelComposer.tsx` و`chat/channelHint.ts`:
    - الملاحظة تنطوي بزر ×، والاختيار في `localStorage` لهذا المتصفح.
    - إذا انطوت يبقى زر ⓘ بجانب الإرسال، يعرض نفس الكلام عند الوقوف عليه، ويرجّعها إذا ضُغط.
    - قارئ الشاشة يسمع الوصف دائمًا.
  - `chat/ContinueChannel.tsx` و`ui/Tooltip.tsx`: نوع `note` من التلميح، أعرض وشبه شفاف.
  - `styles/app.css`، و`ui/icons.tsx` (`arrow-down` و`info`)، و`ui/lucide.generated.ts`.
  - النصوص: `i18n/ar.json` و`i18n/en.json`.
- **iOS:**
  - `Chat/JumpToLatest.swift` جديد.
  - `Chat/ChatScreen.swift`: الزر فوق النص.
  - `Chat/ChannelConversationScreen.swift`:
    - `defaultScrollAnchor(.bottom)` والزر.
    - الملاحظة تنطوي (`@AppStorage`) ويبقى زر ⓘ.
    - ضغطة مطوّلة على «أكمل في كور هب» تعرض الشرح، عن طريق `contextMenu` بمعاينة.
  - النصوص: `i18n/{en,ar}.json` و`i18n/channel_send.{en,ar}.json`.
  - الأيقونة: `Generated/Lucide.swift` و`arrow-down.imageset`.
- **Android:**
  - `ui/components/JumpToLatest.kt` جديد، فيه `rememberScrolledAway` والزر.
  - `ChatScreen.kt` و`ChannelChatScreen.kt`: الزر.
  - `ChannelSendUi.kt`:
    - الملاحظة تنطوي ويبقى زر ⓘ.
    - ضغطة مطوّلة على «أكمل في كور هب» تعرض بطاقة الشرح شبه الشفافة، وتختفي بلمسة.
  - `kit/Controls.kt`: `HubButton` يقبل `onLongClick` اختياريًا، وهي إضافة لا تغيّر الموجود.
  - `AppGraph.kt`: `AppPrefs.channelSendHintHidden`.
  - النصوص: `i18n/{en,ar}.json` و`i18n/channel_send.{en,ar}.json`.
  - الأيقونة: `kit/Lucide.kt` و`lucide_arrow_down.xml`.
- `scripts/icons/lucide-mobile.json`: إضافة `arrow-down`.
- **الجوالات قبل التغيير:** كانت تفتح محادثة القناة على آخر رسالة أصلًا، وتضع الملاحظة على خلفية.
  فالخلل 1 و2 خاص بالويب والديسكتوب، والإضافات 3 و4 و5 على المنصات الثلاث.

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ npx tsc --noEmit -p packages/web                       → بلا أخطاء
$ npx vitest run --maxWorkers=2 tests/composer*.test.tsx tests/chat*.test.tsx \
    tests/older-messages.test.tsx tests/search-jump.test.tsx tests/channel*.test.tsx tests/jump-latest.test.tsx
  Test Files  12 passed (12) · Tests 106 passed (106)        (قبل إضافة jump-latest)
  tests/jump-latest.test.tsx  6 passed
  tests/channel-send.test.tsx 6 passed (3 جديدة: تفتح على آخر رسالة، الملاحظة تنطوي وتبقى، شرح الزر يظهر ويختفي)
  اختبار «تفتح على آخر رسالة» يفشل لو شُيل ref من نص المحادثة (جرّبته).
$ npx eslint (الملفات المعدّلة) && npx prettier --check     → نظيف
$ node scripts/i18n-check.mjs                               → web 3708 · ios 2785 · android 2645 مفتاح، ar/en متطابقة، OK
$ node scripts/icons/lucide-web.mjs --check && node scripts/icons/lucide-mobile.mjs --check → up to date
$ pnpm run scripts:test                                     → 126 pass
$ ./gradlew :app:compileDebugKotlin                          → نجح
$ ./gradlew :app:testDebugUnitTest --tests ChannelSendShots --tests JumpToLatestTest
  ChannelSendShots 7/7 (2 جديدة: الملاحظة تنطوي وترجع، الضغطة المطوّلة تشرح وتختفي) · JumpToLatestTest 1/1
```
- **iOS:** ما يُبنى على هذا الجهاز (لينكس)، فالبناء واختبار `ChannelSendTests` الجديد على CI.

## المخاطر والرجوع
- **المرسى بخلفية:** خاص بمحادثات القنوات فقط (`composer-dock-solid`)، فمظهر المحادثة العادية الزجاجي
  ما تغيّر.
- **الزر على الآيفون:** يعتمد على ظهور علامة آخر القائمة، وهو نفس ما تستعمله الشاشة أصلًا لـ`atBottom`.
- **الرجوع:** بإرجاع الفرع. لا بيانات ولا عقد.

## التسليم والخطوة التالية
- PR إلى `main` ومتابعة CI حتى يخضر. الدمج للمالك.
- ينزل مع 1.1.10.
- الصور:
  - أندرويد: في `apps/android/app/build/shots/channel-send/` محليًا، مثل `android-hint-hidden-light-en.png`.
  - الويب: ما فيه صورة حية لأن تشغيل هب كامل محليًا خارج نطاق هذا الفرع.
