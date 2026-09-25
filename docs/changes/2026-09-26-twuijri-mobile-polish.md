# تلميع تطبيقي الجوال من ملاحظات المالك (iOS وأندرويد)
المسؤول: twuijri · الفرع: fix/mobile-polish · الحالة: in-progress

## المشكلة والهدف
ملاحظات المالك من الاستخدام الفعلي على iPhone (TestFlight 1.1.0 (109))، وكل بند يُصلَح على
المنصتين معًا. هذا السجل بيت ملاحظات الجوال في هذا الفرع؛ كل بند تحت عنوانه.

### ١) الكيبورد في المحادثة
«المفروض اذا ضغطت بالوسط على المحادثه ينزل الكيبورد». النقر على المحادثة خارج مربع الكتابة لا
يُنزل الكيبورد، وسحب القائمة لا يُنزله على أندرويد.

### ٢) القائمة الجانبية فوق الكيبورد
«المفروض اذا فتحت القائمة الجانبية يصغير الكيبورد». الدرج يُفتح والكيبورد باقٍ فوقه.

### ٣) شعار الدرج وما يغطيه الكيبورد
رأس الدرج يعرض شارة نصية «CH» بدل علامة كور هب الحقيقية. والمطلوب أيضًا التأكد أن مربع الكتابة
وآخر رسالة يبقيان فوق الكيبورد، وأن صفوف أسفل الدرج (الحساب، اللغة، المظهر، الخروج، الإصدار) لا
يغطيها الكيبورد.

### ٤–٧) بنود وصلت لاحقًا (قيد العمل)
المرفقات في مربع الكتابة، ومصدر الصوت (مزوّد الهب أو الجوال)، وأيقونات Lucide، وحالة إذن
الإشعارات. تُكتب تفاصيلها هنا حين تُبنى.

## القرار والموافقات
طلب المالك (2026-09-25). القرارات:

**١) الكيبورد في المحادثة**
- iOS: المحادثة كانت فيها `.scrollDismissesKeyboard(.interactively)` أصلًا (السحب يُنزل الكيبورد
  مع الإصبع). أُضيف نقر يُنزله: `dismissesKeyboardOnTap()` إيماءة نقر **متزامنة**
  (`simultaneousGesture`) فوق قائمة الرسائل، فلا تأخذ النقر من الأزرار ولا الروابط ولا تحديد النص.
  والإنزال نفسه `Keyboard.dismiss()` (`resignFirstResponder` على التطبيق كله). وفي «محادثة جديدة»
  النقر على المساحة الفارغة فوق الوكلاء ومربع الكتابة يُنزله أيضًا.
- iOS: قارئ عند آخر رسالة يبقى عندها حين يظهر الكيبورد (علامة القاع في القائمة ظاهرة عند
  `keyboardWillShow` ⇐ تمرير إلى القاع عند `keyboardDidShow`). قارئ صعد يقرأ القديم لا يُحرَّك.
- أندرويد: `imePadding` كان موجودًا. أُضيف: نقر على المحادثة يُنزل الكيبورد
  (`detectTapGestures` على الأب؛ الأبناء يرون النقر أولًا فزر الموافقة يعمل ولا يُنزله)، وسحب
  القائمة يُنزله مرة لكل سحبة (`NestedScrollConnection`، مصدر `UserInput` فقط، لا تمرير برمجي).
  وحين يصغر عرض القائمة لأن الكيبورد ظهر، قارئ كان عند آخر رسالة يُمرَّر بقدر ما صغرت فيبقى آخرها
  ظاهرًا فوق مربع الكتابة.
- **لماذا «مصبّ تركيز» على أندرويد لا `clearFocus()`**: اختبار Robolectric أظهر أن مسح التركيز
  يُفقد نافذة Compose تركيزها، فيعيد أندرويد التركيز إليها، فتعطيه Compose لأول عنصر قابل للتركيز —
  وهو مربع الكتابة نفسه، فيعود الكيبورد. الحل: `KeyboardDismisser` ينقل التركيز إلى منطقة بلا حقل نص
  (`Modifier.keyboardSink`: قائمة الرسائل، أو الدرج) ثم يُخفي الـIME، ولا يمسح التركيز إلا إن لم يجد
  المصبّ.

**٢) الدرج**
- iOS: `DrawerState` (جديد) يُنزل الكيبورد **قبل** أي حركة للدرج، فتحًا وإغلاقًا (بزر القائمة، أو
  النقر على الظل، أو اختيار صف). الإغلاق أيضًا لأن بحث المحادثات داخل الدرج حقل نص. قائمة الدرج
  صار سحبها يُنزل الكيبورد (`.scrollDismissesKeyboard(.interactively)`).
- أندرويد: `DismissKeyboardWhenDrawerMoves` يراقب `drawer.targetValue`، فيغطي الفتح بالزر وبالسحب
  من الحافة، والإغلاق. الدرج هو مصبّ التركيز عند فتحه. وعمود الدرج صار عليه `imePadding` فحين يكتب
  المستخدم في بحث الدرج يرتفع أسفل الدرج فوق الكيبورد بدل أن يُغطى.
- الاتجاه لم يتغير: iOS `.move(edge: .leading)` وأندرويد `ModalNavigationDrawer` كلاهما من حافة
  بداية القراءة، أي من اليمين بالعربية، كما كانا.

**٣) الشعار**
- العلامة نفسها التي في الويب (`CoreHubMark`، مرسومة بلون `accent` بلا مربّع، كرأس الشريط الجانبي في
  الويب). المصدر واحد: `scripts/icons/build-icons.mjs` صار يكتب أيضًا
  `Assets.xcassets/BrandMark.imageset` (SVG قالب، يُحفظ متجهًا فيبقى حادًا بكل حجم) و
  `res/drawable/ic_brand_mark.xml` (متجه أبيض يلوّنه التطبيق). `BrandMark` في التطبيقين صار يرسمها،
  فتظهر في الدرج وشاشة الدخول و«محادثة جديدة» (iOS) وشاشة الربط (أندرويد).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء حتى الآن.

## الملفات والتأثير
- `scripts/icons/build-icons.mjs`: مخرجان جديدان للعلامة داخل التطبيقين.
- iOS: `Shell/Keyboard.swift` (جديد: `Keyboard`، `dismissesKeyboardOnTap`، `DrawerState`)،
  `Shell/ShellView.swift`، `Shell/SidebarView.swift`، `Shell/Components.swift` (`BrandMark`)،
  `Chat/ChatScreen.swift`، `Chat/NewChatScreen.swift`،
  `Resources/Assets.xcassets/BrandMark.imageset/**` (مولَّد)،
  `CoreHubTests/KeyboardTests.swift` (جديد).
- أندرويد: `ui/components/Keyboard.kt` (جديد)، `ui/components/Common.kt` (`BrandMark`)،
  `ui/screens/ChatScreen.kt`، `ui/screens/Shell.kt`، `res/drawable/ic_brand_mark.xml` (مولَّد)،
  `app/build.gradle.kts` و`gradle/libs.versions.toml` (Robolectric وأدوات اختبار Compose، للاختبار
  فقط)، `src/testDebug/.../KeyboardDismissTest.kt` (جديد).

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا (كل أمر ثقيل عبر `mj-run`؛ أندرويد بـJDK 17 وSDK 35؛ لا Xcode محليًا، فـiOS على CI):

```
$ pnpm icons:build
icons: 26 files written          # 23 كما كانت بلا تغيير + 3 جديدة للعلامة
$ ./gradlew --no-daemon --max-workers=2 testDebugUnitTest --tests 'hub.core.android.ui.KeyboardDismissTest'
# مع جعل KeyboardDismisser.dismiss() لا يفعل شيئًا (السلوك القديم):
KeyboardDismissTest > tappingTheConversationPutsTheKeyboardAway FAILED
KeyboardDismissTest > openingTheDrawerPutsTheKeyboardAwayFirst FAILED
KeyboardDismissTest > draggingTheConversationPutsTheKeyboardAway FAILED
5 tests completed, 3 failed
# بالكود الجديد:
BUILD SUCCESSFUL
$ ./gradlew --no-daemon --max-workers=2 assembleDebug test lint     (apps/android)
BUILD SUCCESSFUL in 44s
tests 165 skipped 4 failed 0      # debug + release unit tests
lint: 0 errors, 21 warnings       # لا تحذير في الملفات المتغيرة
```

## المخاطر والرجوع
- إيماءة النقر في iOS متزامنة: نقر زر داخل رسالة (مثل «تحميل الأقدم») يُنزل الكيبورد أيضًا، كما في
  Messages. على أندرويد الزر يحتفظ بنقرته والكيبورد يبقى. فرق صغير مقبول بين المنصتين.
- Robolectric يُنزَّل أول مرة في CI (مكتبات أندرويد للاختبار)؛ يزيد وقت وظيفة أندرويد قليلًا، ولا
  يدخل في التطبيق المبني.
- الرجوع: إرجاع هذا الفرع؛ لا بيانات ولا عقد تغيّر.

## التسليم والخطوة التالية
البنود ١–٣ مبنية ومختبرة محليًا على أندرويد؛ iOS ينتظر CI. التالي: البنود ٤–٧ في الفرع نفسه.
