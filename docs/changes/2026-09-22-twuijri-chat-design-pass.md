# جولة تصميم شاشة المحادثة، وطقم المكوّنات الكامل

المسؤول: twuijri · الفرع: feat/chat-design-pass · الحالة: review

## المشكلة والهدف

فتح المالك محادثة فلم يستطع تمييز رسالته من ردّ الوكيل: كلاهما ملتصق بالحافة نفسها،
فالمحادثة تُقرأ عمودًا واحدًا من نصّ متشابه. وكان «التفكير» يُعرض طيّةً نصّية داخل السجل،
فيبدو كأن الوكيل يكتب مقالًا عن نفسه بدل أن يكون **حالة** تقول إنه حيّ ومنذ متى.
وتوجيهه كان حرفيًا: «design, then design, then design».

الأهداف الأربعة:

1. **جانبان للمحادثة**: الإنسان يمينًا دائمًا، الوكيل يسارًا دائمًا، في كل لغة، بسطحين
   مختلفين، وبتجميع الرسائل المتتالية من المتحدّث نفسه في دَورٍ واحد.
2. **مؤشّر تفكير حقيقي**: شيء يتحرّك، والكلمة، و**الثواني تعدّ تصاعديًا**، والخطوة الحالية
   حين يعلنها الوكيل — ثم ينطوي بعد انتهاء التشغيل إلى جملة هادئة خلفها النص.
3. **طقم مكوّنات كامل** في `packages/web/src/ui/` بأسلوب shadcn/ui (الكود عندنا، والرموز
   وحدها تلوّنه، والسلوك من Radix)، **وإعادة بناء الشاشات القائمة منه**.
4. **تقييم `@assistant-ui/react`** لسطح المحادثة: نتبنّاه أو نرفضه بحجّة مكتوبة.

## القرار والموافقات

- **قاعدة الجانبين قاعدة فيزيائية لا منطقية**، وكُتبت في `docs/clients/DESIGN.md` §The
  conversation كي لا يُعاد فتحها: الصفّ الحامل للرسالة يثبّت `direction: ltr`، وكل ما يقرّر
  حافةً (المحاذاة، الزاوية المشدودة، جهة الصورة الرمزية) يُحسب على هذا الاتجاه الثابت
  بخصائص منطقية عادية. والمحتوى يبقى صاحب اتجاه نفسه: كل فقاعة `dir="auto"` ومعزولة، وكل
  نص مختلط داخل الصف (عدّاد الرموز، المدّة) يحمل `dir="auto"` خاصًّا به وإلا أعاد الصفُّ
  ترتيب أرقامه.
- **الرسالة الفارغة ليست دَورًا.** يفتح المركز التشغيل بإنشاء رسالة مساعد فارغة
  (`engine.ts`)، وقبل أن يصلها نص أو أداة لا شيء يُرسم؛ ورسمها يحشر فقاعة خالية بين رسالتين
  من الشخص نفسه فيمنع تجميعهما. القرار: `isSilentShell` في `chat/turns.ts` يُسقطها.
- **«لا دوّامة بلا عدّاد» قاعدة المؤشّر الوحيدة**: الدوّامة وحدها لا تفرّق بين «يفكّر»
  و«علِق». `prefers-reduced-motion` يوقف النقاط ويُبقي الثواني، لأن العدد معلومة لا زخرفة.
- **الطقم ليس مجلّدًا**: ثلاث قواعد يفرضها اختبار — مدخل واحد (`src/ui/index.ts`)، وكل
  مكوّن مستعمل في شاشة واحدة على الأقل، ولا لون حرفي في `styles/kit.css`.
- **`@assistant-ui/react` (MIT، 0.15.21): لا نتبنّاه الآن.** التفصيل في الفقرة الأخيرة
  وفي `docs/inspirations/assistant-ui.md`.
- **لم يُنسخ أي كود من طرف ثالث**؛ `THIRD-PARTY-NOTICES.md` يوضّح لماذا يبقى فارغًا رغم أن
  الطقم «بأسلوب shadcn/ui»، والمصدران مسجّلان في `docs/inspirations/`.
- موافقة المالك على الدمج لم تُطلب بعد: لا دفع ولا طلب دمج في هذه الجولة.

## العقد

**لا شيء.** لم يتغيّر أي مسار ولا أي حدث في `packages/contracts`. كل ما هنا عميلُ ويب فوق
العقد القائم، و`pnpm contracts:check-clients` أخضر.

المستعمَل من العقد كما هو، بلا إضافة: `Run.started_at` / `Run.finished_at` للعدّاد والمدّة،
`Reasoning.duration_ms` لمدّة التفكير حين يعلنها المحوّل، `ToolCall.status` للخطوة الحالية،
و`Preferences.show_reasoning` لمفتاح العرض.

## الملفات والتأثير

### الرموز
- `packages/ui-tokens/tokens.json` — ألوان سطح الوكيل (`agent-bubble*`)، وحدّ فقاعة الشخص
  (`user-bubble-border`)، ولون المؤشّر (`thinking*`)، ومقاسات المحادثة
  (`bubble-max: 70%`, `avatar-sm/md`, `turn-gap`, `group-gap`)، وخمسة أزواج تباين جديدة.

### الطقم (جديد في `packages/web/src/ui/`)
`index.ts` (المدخل الواحد)، `Button.tsx`، `Input.tsx` (+`Textarea`)، `Label.tsx`
(+`Field`)، `Radio.tsx`، `Switch.tsx`، `Dialog.tsx` (+`Sheet`)، `AlertDialog.tsx`،
`ContextMenu.tsx`، `Tabs.tsx` (+`TabPanel`/`TabsNav`)، `Card.tsx`، `Badge.tsx`،
`Avatar.tsx`، `Separator.tsx`، `Skeleton.tsx`، `Toast.tsx`، `Table.tsx`،
`ScrollArea.tsx`، `Breadcrumb.tsx`، `EmptyState.tsx`، `SidebarShell.tsx`.
معدّلة: `Menu.tsx` (+`MenuSeparator`)، `ConfirmDialog.tsx` (صار فوق `AlertDialog`).

### الأنماط
- `styles/kit.css` (جديد) — دهان كل تحكّم؛ **صفر لون حرفي**، كل قيمة رمز.
- `styles/chat.css` (جديد) — المحادثة، المؤشّر، الطيّة، بطاقة الأداة، بطاقة الموافقة.
- `styles/screens.css` (جديد) — **الترتيب فقط**: بابا الدخول والتهيئة، صف الجلسة، بطاقات
  الإعدادات والوكلاء والمزوّدين.
- `styles/app.css` — يستورد الثلاثة، و`.mj-dialog` فقد عرضه الثابت لصالح مقاسات الطقم.

### المحادثة
- `chat/turns.ts` (جديد) — `sideOf`/`speakerOf`/`turnsOf`/`isSilentShell`/`runProgress`/
  `currentTool`/`thoughtSeconds`. دوال صافية، وهي موضع القاعدة كلها.
- `chat/useElapsed.ts` (جديد) — ثوانٍ تعدّ من وقت المركز لا من وقت فتح الشاشة.
- `chat/RunStatus.tsx` (جديد) — المؤشّر الحيّ.
- `chat/Reasoning.tsx` (جديد) — «فكّر لمدة ١٢ ث» خلفها النص، مطويّة.
- `chat/MessageView.tsx` — أُعيدت كتابته (+`Transcript`)؛ `ChatScreen.tsx`،
  `Composer.tsx` (+`status`)، `ToolCallCard.tsx`، `ApprovalCard.tsx`، `Markdown.tsx`.

### الشاشات المُعاد بناؤها من الطقم
`shell/Sidebar.tsx`، `shell/AppShell.tsx` (درج الهاتف صار `Sheet`)،
`sessions/SessionList.tsx` (+قائمة زرّ يمين)، `screens/LoginScreen.tsx`،
`screens/SetupScreen.tsx`، `screens/SearchScreen.tsx`، `screens/PlaceholderScreen.tsx`،
`screens/DeviceConnectionsScreen.tsx` (صارت `Tabs` حقيقية)،
`settings/SettingsScreen.tsx`، `settings/AccountTab.tsx` (جدول)،
`settings/DisplayTab.tsx` (+مفتاح `show_reasoning`)، `agents/AgentManagerScreen.tsx`،
`models/ModelsScreen.tsx`، `models/AddProviderDialog.tsx`.

### الاختبارات والحارس
- `tests/turns.test.ts` (جديد، 19 اختبارًا)، `tests/message-layout.test.tsx` (جديد، 11)،
  `tests/run-status.test.tsx` (جديد، 7).
- `tests/ui-layer.test.ts` — وُسّع بقواعد الطقم الثلاث + فحص «لا لون حرفي» + فحص الخصائص
  المنطقية في الأنماط الثلاثة.
- `e2e/zz-design.spec.ts` (جديد) — لقطات 1440×900 وتأكيدات هندسية.
- `e2e/hub.ts` — سيناريوهان للمشغّل المكتوب: ردّ إنجليزي بجدول وكود، وتشغيل صامت يسمح
  بتصوير المؤشّر وتجميع رسالتين.
- `tests/models-screen.test.tsx` — `checkbox` صار `switch` لتفعيل المزوّد.

### الوثائق
`docs/clients/DESIGN.md` (§The conversation، §The thinking indicator، §The kit)،
`docs/inspirations/shadcn-ui.md` و`assistant-ui.md` و`README.md`، `THIRD-PARTY-NOTICES.md`.

### تغييرات سلوك ظاهرة للمستخدم (مقصودة)
1. التفكير أثناء التشغيل انتقل من طيّة في السجل إلى سطر حيّ فوق الملحن.
2. الرسالة المساعدة الفارغة (ومؤشّر `▍`) لم تعد تُرسم.
3. حذف مزوّد صار يسأل أولًا (`AlertDialog`) — كان يحذف فورًا.
4. تفعيل المزوّد صار مفتاحًا لا مربّع تأشير.
5. صفّ الجلسة صار له قائمة زرّ يمين (وكل بنودها ما زالت أزرارًا ظاهرة).
6. جواب السؤال الحرّ في بطاقة الموافقة صار حقلًا متعدّد الأسطر (Enter يرسل).
7. «إظهار تفكير الوكيل» صار مفتاحًا في الإعدادات ← العرض.

## الفحوص

```
$ pnpm --filter @majlis/ui-tokens test
 Test Files  1 passed (1)
      Tests  105 passed (105)

$ pnpm tokens:build
ui-tokens  wrote dist/tokens.css, dist/tokens.js, dist/tokens.d.ts

$ pnpm i18n:check
i18n:check  server: 96 keys, ar/en in parity
i18n:check  cli: 231 keys, ar/en in parity
i18n:check  web: 385 keys, ar/en in parity
i18n:check  OK

$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 38 terms, ar/en complete, routes for web

$ pnpm contracts:check-clients
check-clients  OK — 159 client file(s) scanned, 165 contract path(s) known.

$ pnpm lint
$ eslint . && prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ pnpm typecheck
(لا أخطاء؛ web يفحص tsconfig.json و tsconfig.test.json معًا)

$ pnpm test
 Test Files  3 passed (3)          # contracts
      Tests  11 passed (11)
 Test Files  1 passed (1)          # ui-tokens
      Tests  105 passed (105)
 Test Files  11 passed (11)        # cli
      Tests  61 passed (61)
 Test Files  38 passed | 1 skipped (39)   # server
      Tests  305 passed | 2 skipped (307)
 Test Files  20 passed (20)        # web
      Tests  269 passed (269)

$ pnpm build
✓ 903 modules transformed.
dist/assets/index-*.css     78.79 kB │ gzip:  13.77 kB
dist/assets/index-*.js   1,125.68 kB │ gzip: 347.27 kB
✓ built in 675ms

$ pnpm web:e2e
  ✓   1 setup.spec.ts   › 4. first run: the setup token from /data creates the owner and signs in (1.1s)
  ✓   2 smoke.spec.ts   › 1. new chat → pick a folder → streamed markdown reply … (3.4s)
  ✓   3 smoke.spec.ts   › 6. the agent row gives up labels before options … (1.2s)
  ✓   4 smoke.spec.ts   › 2. an approval card answers once / session / always / deny (889ms)
  ✓   5 smoke.spec.ts   › 3. a socket drop mid-run resumes with after_seq and loses nothing (8.9s)
  ✓   6 smoke.spec.ts   › 5. the send button becomes stop mid-stream, and stop ends the run (1.2s)
  ✓   7 smoke.spec.ts   › 7. 443 models: the picker searches … (2.0s)
  ✓   8 zz-design.spec.ts › a multi-turn conversation reads as a conversation … (2.3s)
  ✓   9 zz-design.spec.ts › a live run is visibly alive: the word, the seconds counting up, and the step (8.8s)
  ✓  10 zz-design.spec.ts › agents, models, sessions, settings and the sign-in door are made of the kit (2.3s)
  10 passed (37.5s)
```

اللقطات (1440×900) في `packages/web/e2e/shots/`:
`design-chat-ar-light.png`، `design-chat-ar-dark.png`، `design-chat-en-dark.png`،
`design-thinking-ar-light.png`، `design-grouped-ar-light.png`،
`design-agents-ar-light.png`، `design-agents-ar-dark.png`،
`design-models-ar-light.png`، `design-models-ar-dark.png`،
`design-settings-ar-light.png`، `design-display-ar-light.png`،
`design-add-provider-ar-light.png`، `design-sidebar-ar-dark.png`،
`design-login-ar-light.png`.

اللقطة ليست الدليل وحدها: `zz-design.spec.ts` يقيس في المتصفح أن فقاعة الشخص تلامس حافة
العمود اليمنى وأن عرضها دون ‎75%‎ منه، وأن سطح الوكيل يبدأ عند الحافة اليسرى وبلون خلفية
مختلف عن فقاعة الشخص، وأن الفجوة فوق رسالة مجمَّعة أصغر من `--mj-layout-turn-gap`، وأن
العدّاد رقمه أكبر بعد ثوانٍ.

## المخاطر والرجوع

| الخطر | الحدّ منه |
|---|---|
| `direction: ltr` على صف الرسالة قد يقلب ترتيب نصّ مختلط داخله | كل نص داخل الصف يحمل `dir="auto"` (الفقاعة، المدّة، عدّاد الرموز، الشارات، ملخّص التفكير)، ويؤكّده اختبار الوحدة ولقطة en-dark بمحتوى عربي |
| إسقاط الرسالة الفارغة قد يُخفي دَورًا انتهى بلا نص | `isSilentShell` مشروط بـ `status === 'streaming'` وحده؛ رسالة منتهية أو مقطوعة بلا نص تبقى ظاهرة بشارتها، ومختبَرة |
| طقم من ثلاثين مكوّنًا قد يتعفّن | ثلاثة اختبارات: مدخل واحد، كل مكوّن مستعمل في شاشة، لا لون حرفي |
| العدّاد كل ثانية قد يُتعب قارئ الشاشة | الثواني `aria-hidden`، والمنطقة الحيّة هي الكلمة وحدها |
| `zz-design.spec.ts` يترك جلسات في مركز الاختبار | الاسم يجعله آخر ملف يعمل، وسبب ذلك مكتوب في رأسه |
| الرجوع | كل ما في الجولة داخل `packages/web` و`packages/ui-tokens/tokens.json` والوثائق؛ الرجوع = `git revert` للفرع كاملًا، ولا هجرة بيانات ولا تغيير عقد |

## التسليم والخطوة التالية

الفرع جاهز للمراجعة، **لم يُدفع ولم يُفتح طلب دمج** (بانتظار المالك، TEAM-RULES §2).

### تقييم `@assistant-ui/react` — لماذا لا، الآن

جُرّب فعلًا ولم يُرفض على الورق: ثُبّتت الحزمة في مساحة مؤقتة، وكُتب تكامل واقعي بشكل
رسائل مختزِلنا عبر `convertMessage`، و`onNew` يرسل POST، و`onCancel` يرسل POST،
و`onRespondToToolApproval` يجيب موافقة — **مرّ `tsc --noEmit` بلا خطأ وصُيِّر بـ
`renderToString`**، وبمكوّناتنا وحدها بلا Tailwind ولا CLI ولا أي ملف CSS كان الناتج
HTML كلّه من عندنا بلا أي `style=` مضمّن. والمفاجأة أن العقد يناسبنا أكثر مما توقّعنا:
`useExternalStoreRuntime` حقله الإلزامي الوحيد `onNew`، و`isRunning` يتجاوز استنتاج الحالة
من آخر رسالة (أي أن نموذجنا «الخادم يملك التشغيل والعميل مشترك» نموذج معروف عندهم)،
و`onCancel` دالّة وعد لا `AbortController`، وبوابة الموافقة **مملوكة للخادم** في نوع
الرسالة نفسه بحالات `cancelled`/`expired`، وهي أقرب شيء رأيناه لعقدنا. ولا تعارض في
Radix: الحزمة تعتمد `radix-ui` الموحّدة `^1.6.7` نفسها ولا تشحن أي CSS؛ كل المخاطر
(Tailwind، `lucide-react`، حزم `@radix-ui/*` المنفصلة، انتكاسات RTL المتكرّرة) تسكن الطبقة
المنسَّقة `@assistant-ui/react-ui` التي لن تُثبَّت.

ومع ذلك: ما نشتريه **آلة حالة، لا واجهة** — لا مكوّن موافقة ولا بطاقة أداة ولا طيّة تفكير
في الحزمة، أنواع وخطّافات فقط، فكل بكسل سنكتبه نحن على أي حال. وآلة الحالة تلك نملكها
أصلًا في `chat/transcript.ts`، مختزِلًا صافيًا مختبَرًا. فالثمن اليوم ‎86.1 kB‎ مضغوطة
ومصدران للحقيقة و‎450‎ إصدارًا ما زالت تحت `0.x` بقفزات كاسرة (0.5 → 0.7 → 0.15)، مقابل صفر
مكسب بصري في جولةٍ عنوانها التصميم. القرار إذًا: **لا الآن**، ونعيد النظر عند بناء التفرّع
أو التحرير-وإعادة-التوليد أو المرفقات الكاملة، وعندها نبدأ بـ spike على شاشة واحدة داخل
شجرة العمل — فما لم نتحقّق منه بعد هو بناء Vite 8 حقيقي في المتصفح وتفاعل CSS مع ترتيب
طبقات Tailwind 4. التفصيل كلّه في `docs/inspirations/assistant-ui.md`.

### حدود معروفة، والخطوة التالية

1. **مدّة التفكير تضيع بعد إعادة التحميل.** `sessions.get` يعيد التشغيلات **الحيّة** فقط
   (`service.ts §get` → `liveRuns`)، ومحوّل Hermes لا يملأ `Reasoning.duration_ms`. فالدَور
   المفتوح أمامك يقول «فكّر لمدة ١٢ ث»، وبعد إعادة تحميل الصفحة يقول «التفكير» فقط. هذا
   مقصود — رقم مخترَع أسوأ من لا رقم — والعلاج الصحيح في الخادم: أن يملأ المحرّك
   `reasoning.duration_ms` عند اكتمال التشغيل. جولة خادم مستقلّة، لا تُخلط بجولة تصميم.
2. اسم الوكيل يصل `Hermes` في البث و`agent` بعد إعادة التحميل من `listMessages` (بيانات
   المركز، ظاهر في `design-chat-en-dark.png`) — يُتابَع مع وحدة الجلسات.
3. الحزمة تجاوزت ‎500 kB‎ قبل الضغط (تحذير Vite قائم من قبل هذه الجولة) — تقسيم الحزمة
   بنداً مستقلاً.
