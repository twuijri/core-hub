# بنود الويب المؤجّلة (٢): شريط الأيقونات، سطر «وقت التشغيل»، الرسائل الأقدم، نموذج الإملاء
المسؤول: twuijri · الفرع: feat/web-parked-2 · الحالة: review

## المشكلة والهدف
وافق المالك على بناء بنود كانت مؤجّلة في قائمة الويب:
1. طيّ القائمة الجانبية إلى شريط أيقونات ضيّق على الشاشات العريضة (مثل ChatGPT).
2. قائمة فحوص «وقت التشغيل» في صفحة النماذج: سطر واحد حين تنجح كلها، ومفتوحة والفاشل أولًا حين يفشل شيء.
3. «تحميل الرسائل الأقدم» في المحادثات العادية: هل هو مبني؟ وإن لم يكن نبنيه.
4. نموذج الإملاء الافتراضي: OpenAI توقف `whisper-1` في ٢٠٢٧-٠٢-٢٦، والبديل `gpt-transcribe`.

## القرار والموافقات
القرار مكتوب في `docs/contracts/DECISIONS.md` §112. مقترح، ينتظر تأكيد المالك.

**١) شريط الأيقونات (الويب وسطح المكتب):**
- على نافذة عرضها 48rem فأكثر تنطوي القائمة إلى شريط عرضه زرّ كبير واحد (56px).
- الطيّ بزرّ في صفّ العلامة، أو بـ`Ctrl+Shift+S` (`⌘⇧S` على ماك). هذا اختصار ChatGPT نفسه. يُطابَق على مفتاح S الفعلي، فيعمل مع لوحة المفاتيح العربية (حيث يكتب «س»).
- المداخل نفسها بترتيبها: مداخل الشريط، ثم «محادثة» و«الغرف» أيقونتين. الضغط على إحداهما يفتح القائمة على قائمتها، لأن القائمة تحتاج المكان.
- داخل الإعدادات وصفحات الوكيل: قائمتهما أيقوناتٍ، ووجه الوكيل بلا اسمه.
- كل صفّ يبقى اسمه اسمه المقروء (مخفيًا بصريًا)، ويظهر تلميحًا نحو الصفحة: يسار الشريط بالعربية، يمينه بالإنجليزية.
- التذييل زرّ واحد: الحرف الأول للشخص ونقطة الاتصال. قائمته فيها: الإعدادات، اللغة، السمة، الخروج، الإصدار.
- الاختيار لهذا المتصفح (`localStorage` داخل try/catch)، لا للحساب.
- العرض يتحرك بمدة رمز الحركة، وبلا حركة تحت «تقليل الحركة».
- بالعربية الشريط على اليمين.
- درج الهاتف كما هو، لا ينطوي. لا وجهة جديدة ولا مدخل جديد.

**٢) بطاقة وقت التشغيل:**
- حين تنجح كل الفحوص: سطر واحد «وقت التشغيل جاهز · الفحوص 4/4». السطر كله زرّ يفتح القائمة.
- حين يفشل فحص: مفتوحة بنفسها، وفيها «نجح 2 من 4 فحوص»، والفاشل أولًا. كل نصف بترتيب خطوات التشغيل.
- (العدد في الواقع ٤ أو ٥ حسب ما يرجعه الخادم، لا ٦.)

**٣) الرسائل الأقدم:** كانت مبنية قبل هذا الفرع (2026-09-24). المحادثة تفتح بآخر ١٠٠ رسالة، والصعود يجلب الصفحة السابقة ويحفظ مكان القارئ، وفي البداية تقول «بداية المحادثة». الدليل:
- رحلة Playwright `packages/web/e2e/zzz-chat-history.spec.ts` رقم 24: ٢٦٠ رسالة، ١٠٠ ثم ٢٠٢ ثم ٢٦٤.
- اختبار الوحدة `packages/web/tests/older-messages.test.tsx`.
- لم نغيّر فيها شيئًا.

**٤) نموذج الإملاء:**
- إعداد `openai-stt` صار `gpt-transcribe`.
- الإعداد يُنسخ إلى صفّ المزوّد مرة واحدة عند إنشائه. فالصفوف الجديدة فقط تأخذه.
- صفّ موجود فيه `whisper-1` (أو أي نموذج اختاره شخص) يبقى كما هو.
- المحوّل المتوافق مع OpenAI ما زال يطلب `whisper-1` لصفّ بلا نموذج أصلًا، لأن خوادم Whisper المحلية تعرفه بهذا الاسم.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- **الشريط:**
  - جديد: `packages/web/src/shell/sidebarFold.ts` (الحفظ، الاختصار، الخطّاف).
  - `packages/web/src/shell/Sidebar.tsx`، `packages/web/src/shell/AppShell.tsx`.
  - `packages/web/src/ui/SidebarShell.tsx`: سياق الطيّ، والتلميح على كل صفّ، وزرّ في صفّ العلامة، والعنصر الختامي داخل `span`.
  - `packages/web/src/ui/Tooltip.tsx`: `inline-start`/`inline-end` تتبع اتجاه القراءة. قبلها كانت دائمًا يسار/يمين. لم يكن أحد يستخدمها.
  - `packages/web/src/ui/icons.tsx` و`lucide.generated.ts`: `panel-left-close` و`panel-left-open`، معكوستان في RTL.
  - `packages/web/src/agents/AgentNav.tsx`: الاسم وزرّ إعادة التشغيل يختفيان في الشريط.
  - `packages/web/src/styles/kit.css`.
- **البطاقة:** `packages/web/src/models/RuntimeChecks.tsx`.
- **النصوص:** `packages/web/src/i18n/{ar,en}.json`.
  - جديد: `shell.fold` و`shell.unfold` و`shell.person_menu` و`models.runtime.ready` و`models.runtime.passed`.
  - حُذف (لم يعد مستخدمًا): `models.runtime.all_ok` و`show` و`hide`.
- **الخادم:** `packages/server/src/modules/models/catalogue.ts` (`OPENAI_STT_DEFAULT_MODEL`).
- **الاختبارات:**
  - جديد: `packages/web/tests/sidebar-rail.test.tsx` و`packages/web/e2e/zzzz-sidebar-rail.spec.ts` ولقطتاه في `e2e/shots/sidebar-rail-{ar,en}-light.png`.
  - معدّل: `packages/web/tests/models-screen.test.tsx`، `packages/server/src/modules/models/speech-api.test.ts`، `packages/server/tests/contract/speech.contract.test.ts`.
- **الوثائق:** `docs/clients/NAVIGATION.md` §١، `docs/design/family.md` §2، `docs/contracts/DECISIONS.md` §112، `docs/STATUS.md`.
- لم نلمس `apps/ios` ولا `apps/android` ولا `tokens.json`. عرض الشريط محسوب من رموز موجودة: زرّ كبير + هامشان.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run`. الاختبار الجديد للنموذج سقط على الكود القديم قبل التغيير:
```
$ vitest run src/modules/models/speech-api.test.ts -t gpt-transcribe   (على catalogue.ts القديم)
     × starts a new OpenAI speech-to-text row on gpt-transcribe, not the retiring whisper-1 1232ms
      Tests  1 failed | 9 skipped (10)
```
بعد التغيير:
```
$ pnpm exec vitest run src/modules/models/speech-api.test.ts tests/contract/speech.contract.test.ts   (packages/server)
 Test Files  2 passed (2)
      Tests  16 passed (16)

$ pnpm exec vitest run tests/sidebar-rail.test.tsx tests/models-screen.test.tsx tests/agent-restart.test.tsx tests/run-failure-notice.test.tsx tests/older-messages.test.tsx tests/agents-top-level.test.tsx tests/navigation.parity.test.tsx tests/lucide-icons.test.tsx tests/logical-css.test.ts tests/i18n.test.ts   (packages/web)
 Test Files  10 passed (10)
      Tests  395 passed (395)

$ pnpm build   (ثم)
$ PLAYWRIGHT_CHANNEL=chrome pnpm --filter @corehub/web exec playwright test e2e/zzzz-sidebar-rail.spec.ts --workers=1
  ✓  1 [chromium] › e2e/zzzz-sidebar-rail.spec.ts:45:1 › the sidebar folds into a rail, remembers it, and stands on the reading side (5.4s)
  1 passed (14.5s)

$ pnpm typecheck        → exit 0, 0 × "error TS"
$ pnpm lint
All matched files use Prettier code style!
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 39 destinations, 2 pre-auth screens (login, setup), 44 terms, ar/en complete, routes for web, ios, android, desktop
$ pnpm contracts:check-clients
check-clients  OK — 785 client file(s) scanned, 254 contract path(s) known.
$ pnpm contracts:lint
contracts:lint  OK
```
اللقطتان اللتان راجعناهما:
- `sidebar-rail-ar-light.png`: الشريط على اليمين، وتلميح «محادثة جديدة» على يساره.
- `sidebar-rail-en-light.png`: الشريط على اليسار في صفحة المهام، وتلميح «Tasks» على يمينه.

أول لقطة أظهرت أيقونة «محادثة» مميّزة وأنت في صفحة المهام. صحّحناها: الأيقونة تتميّز فقط حين تكون في قائمتها.

نتيجة CI: تُضاف بعد الدفع.

## المخاطر والرجوع
- **`.ch-sidebar` صار `overflow: hidden`** حتى لا يظهر المحتوى أثناء الطيّ.
  - القوائم المنبثقة والتلميحات تُرسم في `portal` فلا تتأثر.
  - إن ظهر قصّ في مكان ما، يُرفع هذا السطر.
- **صفوف الشريط صارت `className` نصًا** بدل دالة، حتى يلفّها التلميح. `NavLink` ما زال يضيف `active` بنفسه.
- **التلميح في Radix قد يبقى مفتوحًا** إن قفز المؤشر خارج الزرّ دفعة واحدة (سلوك منطقة السماح في Radix). الرحلة تحرّك المؤشر بخطوات.
- **الرجوع:** عكس الالتزامات. لا ترحيل ولا تغيير في العقد.
  - صفوف `openai-stt` التي أُنشئت بـ`gpt-transcribe` تبقى عليه بعد الرجوع، ويغيّرها الشخص من صفحة النماذج إن أراد.

## التسليم والخطوة التالية
- طلب دمج واحد إلى `main` بالإنجليزية.
- على المالك تأكيد §112:
  - الاختصار `Ctrl+Shift+S`.
  - أن «محادثة» و«الغرف» في الشريط تفتحان القائمة.
  - صيغة سطر «وقت التشغيل جاهز · الفحوص 4/4».
  - `gpt-transcribe` للصفوف الجديدة فقط.
