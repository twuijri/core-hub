# نشاط أدوات الدور: نافذة حيّة ثم سطر واحد مطويّ
المسؤول: twuijri · الفرع: feat/tool-activity-collapse · الحالة: review

## المشكلة والهدف
أرسل المالك (2026-09-26) لقطة من الآيفون: كل أداة استعملها الوكيل تظهر بطاقة كبيرة مستقلة فوق الجواب (skill_view، vision_analyze، terminal، vision_analyze …). مع كثرة الأدوات يصير الرد مزدحمًا؛ في الويب ملحوظ وفي الجوال أسوأ. المطلوب مثل فكرة «النشاط»: أثناء عمل الوكيل تظهر آخر الخطوات فقط — **4 في الويب و2 في الجوال** — وتتلاشى الأقدم مع وصول الجديدة؛ وعند انتهاء الدور تنطوي كلها في **سطر واحد مضغوط** (مثل «4 خطوات · 1 د 05 ث» مع علامة حمراء وعدد إن فشل شيء) يُفتح على القائمة الكاملة عند الحاجة. يبقى نص الجواب هو الأساس على الشاشة.

## القرار والموافقات
طلب المالك في المحادثة (2026-09-26). القرارات الجديدة مسجّلة في DECISIONS §111 — **مقترحة، بانتظار تأكيد المالك**:

- النافذة الحية 4 استدعاءات في الويب و2 في iOS وAndroid. الاستدعاء الجاري أو المنتظر للموافقة يبقى ظاهرًا دائمًا، وكذلك **الفاشل** حتى ينتهي الدور، كي لا يختفي خطأ بينما الوكيل يكمل. الباقي سطر «+ك خطوات سابقة» يفتحها ويطويها.
- حركة لطيفة: الخطوة الجديدة تنزلق وتظهر، والقديمة تخفت (الويب: أقدم خطوة ظاهرة تخفت؛ الجوالان: تنزلق خارجًا). لا حركة مع «تقليل الحركة» في المنصات الثلاث.
- عند انتهاء الدور: سطر واحد = عدد الخطوات، المدة، عدد الفاشل بلون الخطر (فقط إن وُجد)، وأسماء آخر الأدوات كشرائح صغيرة (3 في الويب، 2 في الجوال). الضغط يفتح القائمة الكاملة بالبطاقات نفسها. حالة الفتح لكل رسالة ولا تُحفظ.
- المدة: من بداية أول استدعاء إلى نهاية آخرها إن حملت كلها الوقتين، وإلا مجموع المدد، وإلا لا تُعرض. أقل من دقيقة «42 ث»، ومن دقيقة «1 د 05 ث»، ولا تقل عن ثانية.
- صيغ الجمع العربية الست (صفر، واحد، اثنان، قليل، كثير، غيره) في الويب (`Intl.PluralRules` كما في `changes.summary`)، وAndroid (`<plurals>`)، وiOS (دالة `PluralCategory` صغيرة لأن التطبيق يقرأ فهرسه بنفسه).
- أُضيفت أيقونة Lucide `wrench` إلى iOS (كانت لـAndroid وحده) لتكون أيقونة الأدوات واحدة في المنصات الثلاث.
- الأسئلة التي طرحها الوكيل (`AnsweredQuestions` في الويب) تبقى كما هي. لم يُلمس كود عرض الملفات والمرفقات في الجوال (مهمة موازية).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. كل عميل يقرأ `ToolCall` الذي عنده أصلًا (`status`, `duration_ms`, `started_at`, `finished_at`).

## الملفات والتأثير
- الويب: `packages/web/src/chat/toolActivity.ts` (القاعدة كدالة نقية)، `ToolCallCard.tsx` (`ToolCalls` يستعملها: نافذة حية، سطر «+ك»، سطر مطوي بالعدد والمدة والفاشل والشرائح؛ النصوص بلغة الواجهة معزولة بـ`dir="auto"` لأن المجموعة داخل إطار الرسالة الثابت من اليسار لليمين)، `styles/chat.css` (الشرائح، الانزلاق والخفوت، `prefers-reduced-motion`)، `i18n/{ar,en}.json` (`tool.activity.*`، وحُذفت مفاتيح `tool.count*` و`tool.earlier` و`tool.hide_earlier` و`tool.failed_count` التي لم تعد مستعملة)، `tests/tool-calls.test.tsx`، رحلة `e2e/zzzzzzzzzzzzz-tool-activity.spec.ts` ونص `e2e/hub.ts` («خطوات كثيرة»: ست أدوات، الأولى تفشل والسادسة تطول).
- Android: `chat/ToolActivity.kt` (القاعدة)، `ui/components/ToolActivityView.kt` (العرض بمكوّنات التطبيق على ui-tokens)، سطر واحد في `ChatParts.kt`، `res/values*/strings_tool_activity.xml`، `test/.../chat/ToolActivityTest.kt`، `testDebug/.../shots/ToolActivityShots.kt`.
- iOS: `Chat/ToolActivity.swift` (القاعدة + صيغ الجمع)، `Chat/ToolActivityView.swift`، سطر في `ChatScreen.swift`، `i18n/{ar,en}.json`، `CoreHubTests/ToolActivityTests.swift`، أيقونة `wrench` (`scripts/icons/lucide-mobile.json`، `Generated/Lucide.swift`، `Assets.xcassets/Lucide/wrench.imageset`).
- الوثائق: `docs/contracts/DECISIONS.md` §111، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، ما يمس التغيير فقط (عبر `mj-run`):

```
$ pnpm lint
$ eslint . && prettier --check .
All matched files use Prettier code style!

$ pnpm typecheck        → exit 0

$ pnpm i18n:check
i18n:check  web: 3199 keys, ar/en in parity
i18n:check  ios: 704 keys, ar/en in parity
i18n:check  OK

$ pnpm contracts:check-clients
check-clients  OK — 791 client file(s) scanned, 254 contract path(s) known.

$ pnpm nav:check
nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop

$ vitest run tests/tool-calls.test.tsx tests/i18n.test.ts tests/logical-css.test.ts tests/file-preview.test.tsx
 Test Files  4 passed (4)
      Tests  341 passed (341)

$ pnpm build && PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzzzzzzzzzz-tool-activity.spec.ts e2e/zzzzzz-chat-files.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zzzzzz-chat-files.spec.ts:36:1 › 32. files a run wrote open beside the chat from the Files list and the tool card (3.1s)
  ✓  2 [chromium] › e2e/zzzzzzzzzzzzz-tool-activity.spec.ts:26:1 › the live window keeps the latest steps and a failure; the finished turn folds into one row (7.7s)
  2 passed (20.0s)

$ ./gradlew --max-workers=2 :app:testDebugUnitTest --tests ToolActivityShots --tests ToolActivityTest --tests StringsParityTest --tests ChatReducerTest :app:lintDebug
BUILD SUCCESSFUL in 47s
hub.core.android.chat.ChatReducerTest 8 failures 0 errors 0
hub.core.android.ui.StringsParityTest 3 failures 0 errors 0
hub.core.android.chat.ToolActivityTest 6 failures 0 errors 0
hub.core.android.shots.ToolActivityShots 4 failures 0 errors 0
```
(الأرقام بعد اسم الصنف: عدد الاختبارات ثم عدد الإخفاقات 0.)

اختبارات القاعدة الجديدة تفشل على الكود القديم (الوحدة `toolActivity` لم تكن موجودة، ونصوص «+2 earlier steps» و«3 steps» و«1m 05s» جديدة). iOS لا يُبنى على لينكس: الاختبارات في CI فقط.

اللقطات التي نُظر إليها:
- الويب (عربي فاتح): `tool-activity-live-ar-light.png` (خمسة صفوف: الفاشل الأول + آخر أربعة، وسطر «+ خطوة سابقة»)، `tool-activity-folded-ar-light.png` («6 خطوات · 6 ث · فشلت خطوة» والشرائح)، `tool-activity-open-ar-light.png`. أول لقطة كشفت أن «6 خطوات» و«+ خطوة سابقة» تُقرأ مقلوبة داخل إطار الرسالة LTR؛ أُصلح بـ`dir="auto"`.
- Android (Robolectric، `apps/android/app/build/shots/tool-activity/`): `android-tool-activity-live-en/ar`، `android-tool-activity-folded-en/ar`، `android-tool-activity-open-en`. أول لقطة كشفت قصّ الشريحة في منتصف الاسم؛ صارت كل شريحة تأخذ حصتها وتنتهي بـ«…».

CI على PR #178 (أول دفع، commit قبل هذا التحديث): 17 فحصًا ناجحًا، منها:

```
Android build, unit tests, lint                        pass  4m55s
Build and test on the iOS simulator                    pass  4m42s
Web smoke journeys (Playwright against the real hub)   pass  9m4s
Lint, typecheck, contracts, client tests, build        pass  5m15s
Server unit tests (shard 1/3, 2/3, 3/3)                pass
Desktop app smoke (Electron under Xvfb against the real hub)  pass
Docker image builds and answers /health                pass
```

## المخاطر والرجوع
- الواجهة فقط؛ لا بيانات ولا عقد. الرجوع = عكس الدمج.
- iOS لم يُبنَ محليًا؛ الاعتماد على وظيفة iOS في CI.
- الأرقام العربية في Android تُكتب بالأرقام الهندية (٤٣ ث) كما في بقية التطبيق، وفي iOS والويب بالأرقام اللاتينية كما هو قائم فيهما.
- لم يُجرَّب على هاتفي المالك.

## التسليم والخطوة التالية
طلب دمج واحد إلى `main` بعد نجاح CI؛ يؤكد المالك أرقام النافذة (4 و2) وقاعدة الطيّ في DECISIONS §111 بعد تجربتها.
