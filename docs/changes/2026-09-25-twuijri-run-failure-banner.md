# خطأ التشغيل الفاشل يبقى تحت دوره فقط، وإعادة تشغيل هرمز من مكانها
المسؤول: twuijri · الفرع: fix/run-failure-banner · الحالة: review

## المشكلة والهدف
**١. «الخطا يبتل ما يروح»** (المالك، 2026-09-25، على مركز الاختبار): فشل تشغيل في محادثة بسبب تعطّل
مزوّد خارجي — `The run failed: HTTP 503: auth_unavailable … (agent_error)` — فظهر الشريط الأحمر فوق
مربع الكتابة. أرسل رسالة أخرى فنجح التشغيل (ظهر الرد و«53525 in · 874 out»)، لكن الشريط الأحمر بقي
فوق مربع الكتابة كأن آخر تشغيل هو الفاشل.

السبب في `main`: `ChatScreen.tsx` كان يأخذ **أول** تشغيل فاشل في `state.runs` بلا نظر إلى ما بعده
(`Object.values(state.runs).find(r => r.status === 'failed')`) ويرسمه تحت آخر المحادثة مباشرة فوق
مربع الكتابة. التشغيل الناجح التالي لا يمحوه، فيبقى إلى إعادة تحميل الصفحة. وبعد إعادة التحميل يختفي
تمامًا لأن `SessionDetail.runs` يحمل التشغيلات الحيّة فقط، فلا يبقى على الدور الفاشل إلا شارة «فشل».

**٢. بطاقة «وقت التشغيل» في صفحة النماذج**: تعرض ✕ أحمر «The runtime has not restarted since the
last change.» ولم يفهمها المالك. معناها: تغيّرت الإعدادات بعد آخر تشغيل لهرمز.

**٣. (طلب المالك أثناء العمل)**: «خل جنب كلمة هرمز والايقونه زر ريستارت … اذا ضغطته يدور واذا اكتمل
يوقف ويطلع تنبيه انه دن» — زر إعادة تشغيل صغير بجانب اسم الوكيل في قائمته الجانبية.

## القرار والموافقات
- **الخطأ ملك الدور الذي فشل**: يُرسم تحت ردّ ذلك التشغيل داخل دوره، أو تحت رسالة الشخص التي بدأته
  إذا فشل قبل أن يكتب الوكيل شيئًا (`failBeforeStart` لا يصنع رسالة للوكيل). لا يُرسم شيء فوق مربع
  الكتابة إطلاقًا، فلا يمكن أن يظهر بعد تشغيل أحدث ناجح. الدالة `failuresByMessage` نقية ومختبرة.
- القاعدة القديمة باقية: ردّ فاشل فيه نص الوكيل نفسه لا يحتاج سطرًا ثانيًا، إلا
  `provider_not_configured` الذي لا يدلّ نصُّ الوكيل على مخرجه.
- **بعد إعادة التحميل** يبقى الخطأ على الدور الفاشل وحده: الويب يقرأ `sessions.listRuns?status=failed`
  (موجود في العقد، مئة تشغيل كحد) مع التشغيلات الحيّة، ويعيد قراءته حين يفشل تشغيل حيّ لأن إعادة
  المزامنة تُبقي الحيّة فقط.
- **زر ×** يخفي الخطأ في هذا العرض؛ يعود على دوره بعد إعادة التحميل (مقترح — للمالك أن يؤكد).
- **بطاقة وقت التشغيل**: فحص `gateway_reloaded` حين يفشل صار **تحذيرًا** كهرماني (⚠، `data-tone=warning`)
  لا ✕ أحمر، بنص «غيّرت الإعدادات بعد آخر تشغيل لـ Hermes — أعد تشغيله لتطبيقها.» / "Settings changed
  after Hermes last started — restart it to apply them."، ومعه «إعادة التشغيل الآن» / "Restart now"
  للمالك والمشرف فقط، يستدعي `agents.restart` ويعيد قراءة الفحوص عند انتهاء المهمة.
- **التحقق من الفحص نفسه**: الفحص يقارن `lastWriteAt` (آخر كتابة للمركز في ملفات هرمز) بـ
  `startedAt` لعملية هرمز (`runtime.status().startedAt`، يُحدَّث في كل `launch`، و`agents.restart`
  يقتل العملية فيعيد إطلاقها). عند الإقلاع يُطلَق هرمز أولًا ثم يكتب `reconcile` الملفات، فيظهر التحذير
  حتى تنتهي إعادة التشغيل المجدولة (أو اليدوية). المقارنة صحيحة؛ أضفت اختبارًا يثبت أن الكتابة بعد بدء
  هرمز تُظهر التحذير وأن إعادة التشغيل تزيله. لم أجد خطأ في المقارنة يحتاج إصلاحًا.
- **زر إعادة التشغيل بجانب اسم الوكيل** (`AgentNav`): أيقونة صغيرة، تلميحها «إعادة تشغيل Hermes» /
  "Restart Hermes"، للمالك والمشرف فقط، ولوكيل من نوع `hermes` له وقت تشغيل (`runtime.state` ليس
  `not_applicable`) — الخادم يرفض غيره بـ `409`. أثناء العمل تدور الأيقونة و`aria-busy` والزر معطّل؛
  عند انتهاء المهمة تتوقف ويظهر إشعار «تمّت إعادة التشغيل» / "Restarted"، أو «تعذّرت إعادة التشغيل»
  مع خطأ المهمة بكلماتها.
- **خطاف واحد** `useRestartAgent` خلف الزرّين: يرسل الطلب، يتابع المهمة (`useJob`) حتى تنتهي، ثم الإشعار
  وإعادة قراءة الوكلاء والفحوص.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء. `sessions.listRuns` و`agents.restart` و`jobs.get` موجودة.

## الملفات والتأثير
- `packages/web/src/chat/RunFailureNotice.tsx`: `failuresByMessage` وزر الإخفاء.
- `packages/web/src/chat/MessageView.tsx`: خانة `notice` داخل الدور، و`noticeFor` في `Transcript`.
- `packages/web/src/chat/ChatScreen.tsx`: حذف الشريط فوق مربع الكتابة؛ قراءة التشغيلات الفاشلة؛ الإخفاء.
- `packages/web/src/agents/useRestartAgent.ts` (جديد)، `packages/web/src/agents/AgentNav.tsx`،
  `packages/web/src/models/RuntimeChecks.tsx`، `packages/web/src/ui/icons.tsx` (`IconRestart`).
- `packages/web/src/i18n/{ar,en}.json`: نص `gateway_reloaded.missing` الجديد، و`restart_now`،
  و`agents.restart_named` / `restart_done` / `restart_failed`.
- الاختبارات: `packages/web/tests/run-failure-notice.test.tsx` (موسّع)،
  `packages/web/tests/agent-restart.test.tsx` (جديد)،
  `packages/server/src/modules/models/models-api.test.ts` (اختبار واحد جديد).
- `docs/STATUS.md`: سطر في قسم الويب.

## الفحوص (الأوامر ونواتجها الفعلية)
محليًا، عبر `mj-run`، ما يمسّه التغيير فقط:
```
$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck
exit=0

$ pnpm i18n:check
i18n:check  web: 1321 keys, ar/en in parity
i18n:check  OK

$ pnpm --filter @corehub/web exec vitest run tests/run-failure-notice.test.tsx tests/agent-restart.test.tsx tests/message-layout.test.tsx tests/models-screen.test.tsx tests/agents-top-level.test.tsx
 Test Files  5 passed (5)
      Tests  59 passed (59)

$ pnpm --filter @corehub/server exec vitest run src/modules/models/models-api.test.ts -t "restart clears|check by check"
 Test Files  1 passed (1)
      Tests  2 passed | 38 skipped (40)
```
الاختبارات الجديدة تفشل على الكود القديم: `failuresByMessage` و`useRestartAgent` و`agent-restart` و
`runtime-restart-now` لم تكن موجودة، والنص القديم ✕ كان أحمر.

Playwright: لم أضف فحصًا — تشغيل فاشل يحتاج وكيلًا مبرمجًا للفشل في مركز e2e، وإعادة التشغيل تحتاج
هرمز يديره المركز (غير موجود في e2e، فيرد `409`). ليس رخيصًا؛ اختبارات الوحدة تغطي السلوك.

CI: يُملأ بعد الدفع.

## المخاطر والرجوع
- طلب إضافي واحد عند فتح كل محادثة (`listRuns?status=failed&limit=100`). محادثة فيها أكثر من مئة تشغيل
  فاشل تفقد أقدمها بعد إعادة التحميل — الأدوار الأقدم غالبًا خارج الصفحة المحمّلة أصلًا.
- الزر المعطّل يُلفّ بعنصر يحمل التلميح (سلوك `Button` القائم)، فيفقد التركيز أثناء الدوران.
- الرجوع: `git revert` للدمج؛ لا ترحيل ولا تغيير عقد.

## التسليم والخطوة التالية
PR إلى `main` بالإنجليزية، ثم مراقبة CI حتى يخضرّ. المالك يؤكد قرار زر × (يخفي في العرض فقط).
