# برامج هذا الجهاز: المركز على الخادم يصل إلى الحاسوب، ودافنشي أولًا
المسؤول: twuijri · الفرع: feat/device-programs (يُدمج في night/2026-09-27، PR #165) · الحالة: review

## المشكلة والهدف
يعمل المالك بمركز على خادم وتطبيق سطح المكتب في الوضع البعيد. الوكيل لم يكن يصل إلى حاسوبه: المساعد
المحلي (ADR 0022) على الحلقة المحلية فقط، وطلبات الأجهزة (§74) لا يطلبها وكيل، ولا شيء في التطبيق يجيبها
والنافذة مغلقة، ولا شيء يشغّل برنامجًا آخر.

الهدف (قرارات المالك ٢٠٢٦-٠٩-٢٦، «ايه»، ثم إضافته الليلة: «يعمل على ويندوز ولينكس كما على ماك»):
1. **الوصول البعيد**: العملية الرئيسية في التطبيق تُبقي اتصالًا صادرًا بـ`/rt/devices` (ولو من شريط النظام،
   مع إعادة المحاولة المتدرجة)، وتجيب طلبات الجهاز؛ ومجموعة أدوات «devices» للوكيل على المركز؛ البروفايلات
   التي تستعمل الجهاز (الافتراضي: كل بروفايلات صاحبه)؛ جهاز غير متصل ← «غير متصل» فورًا؛ طلب لكل استدعاء أداة
   مع بقاء البرنامج يعمل بين الاستدعاءات، وجواب «يعمل» سريع وأداة حالة للأعمال الطويلة، ومهلة لكل قدرة،
   والملفات الكبيرة عبر الرفع المستأنف. الوضع المحلي يبقى عبر المساعد المحلي.
2. **المجلد الافتراضي** `~/Core Hub` (ويندوز `%USERPROFILE%\Core Hub`) مشاركًا للكتابة حين يُشغَّل المساعد ولا
   مجلد مشاركًا — بكلمات المالك: «كنا قلنا اذا المستخدم ما اختار مجلد حنا نسوي مجلد في اليوزر الأساسي لنا نحط فيه
   ملفاتنا مثل كلود».
3. **برامج هذا الجهاز**: اكتشاف تسجيلات MCP لدى Claude Desktop (وإضافاته) وClaude Code وCodex وCursor وWindsurf
   على ماك وويندوز ولينكس؛ كل برنامج مطفأ ويُشغَّل لكل بروفايل؛ المساعد يشغّله ابنًا له ويمرّر أدواته؛ «يحتاج
   إعدادًا» بحقول تُحرَّر في كور هب؛ فحص جاهزية DaVinci Resolve بخطوات الإصلاح.
4. **الموافقة** مرة في الجلسة بنافذة نظام (اسمح / اسمح لهذه الجلسة / ارفض) في الوضعين، وتسجيل كل استدعاء. لا تحكم
   بالشاشة ولا تشغيل أوامر في هذه المرحلة.
5. **ملفات البرنامج** (فيديو مصدَّر) تظهر في المحادثة، والفيديو يعمل بالبث بالمدى.

قاعدة الواجهة من المالك: «كل شي خله في قسم واحد "هذا الجهاز"، داخله قسم برامج هذا الجهاز … ما يفتح صفحة جديدة».

مصدر سلوك التطبيق القديم الوحيد: وصف المراقب بكلمات عادية (`app-control-spec.md`)؛ لم يُفتح شيء من agent-studio
(ADR 0004). المراجع العامة: مواصفة MCP (نقل stdio، الإشعار بالتقدم)، صيغة حزم MCP (`manifest.json`
و`user_config` و`${__dirname}`)، ووثائق برمجة DaVinci Resolve العامة (`RESOLVE_SCRIPT_API` و`RESOLVE_SCRIPT_LIB`
و`scriptapp("Resolve")` وتفضيل External scripting، واشتراط Studio).

## القرار والموافقات
النطاق كله قرار المالك. ما لم يسمّه المالك **مقترح — ينتظر تأكيد المالك** (ADR 0025، DECISIONS §89 و§90):

1. **اتصال صادر من العملية الرئيسية** بـ`/rt/devices` برمز الجهاز الذي أعطاه الإقران، مختومًا بسلسلة مفاتيح النظام
   (Keychain / DPAPI / libsecret؛ لينكس بلا حلقة مفاتيح يحفظه كما هو كما تفعل التطبيقات هناك). إعادة المحاولة من ثانية
   حتى دقيقة؛ رمز يرفضه المركز (أُلغي الربط هناك) لا يُعاد تجربته حتى يربط الشخص من جديد؛ يُجدَّد الرمز عند الاتصال
   مرة في اليوم على الأكثر. **الربط من الصفحة**: الصفحة تصنع إقرانًا بتسجيل دخول الشخص نفسه وتسلّمه للتطبيق فيطالب
   به؛ الرمز لا يصل إلى الصفحة أبدًا. والإقران من شاشة البداية يحتفظ بالرمز أيضًا.
2. **طلب لكل استدعاء**: `files` (أدوات المساعد نفسها + `send_file`) و`apps` (`call` لأداة برنامج، أو `status`).
   **رمز دور الوكيل** يطلب هذين النوعين فقط من جهاز صاحب الدور، ويحمل الطلب رقم الدور. غير ذلك يحتاج نطاق `device`.
3. **الأعمال الطويلة**: استدعاء لم ينتهِ بعد ٢٠ ثانية من السماح يُجاب `{state: running, call_id, progress}` والبرنامج
   مستمر؛ `status` يعيد التقدم أو النتيجة. المهلة الافتراضية لكل قدرة: `files` ٦٠ ث، `apps` ١٢٠ ث (قد يُسأل الشخص
   أولًا)، والباقي ٣٠ ث. **غير متصل فورًا** لـ`files` و`apps` و`screen` (قدرات الهاتف تبقى على اللحاق عند العودة §74).
4. **مجموعة `devices`** في أدوات المركز (§67): `devices.list` و`list_folder` و`read_file` و`fetch_file` و`run_status`
   للقراءة، و`write_file` و`open` و`run` للكتابة. **مطفأة حتى يشغّلها مشرف** ولو كانت أدوات المركز مشغّلة. أدوات عامة
   لا أداة لكل برنامج: هرمز يسرد أدوات البروفايل قبل أن يسمّي أي دور شخصًا.
5. **البروفايلات**: `Device.profiles` (null = كل بروفايلات صاحبه) يغيّرها صاحبها فقط؛ طلب من بروفايل خارجها `403
   device_not_in_profile`. والبرنامج مطفأ حتى يختار الشخص بروفايلاته على الحاسوب.
6. **الاكتشاف دون تثبيت**: المسارات لكل نظام — ماك Application Support، ويندوز `%APPDATA%\Claude` **ونسخة المتجر**
   `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`، لينكس `XDG_CONFIG_HOME`؛ و`~/.claude.json`
   (ومشاريعه)، و`$CODEX_HOME` أو `~/.codex/config.toml`، و`~/.cursor/mcp.json`، و`~/.codeium/windsurf/mcp_config.json`.
   المكرر يظهر مرة؛ الخادم الشبكي يُعرض ولا يُمرَّر؛ المطفأ في مصدره لا يُعرض. الأسرار التي أعطاها الشخص لـClaude
   Desktop **لا تُقرأ** من مخزنه: يعطيها هنا مرة وتُختم.
7. **التشغيل عبر المساعد فقط**: ابن للتطبيق بمصفوفة وسائط؛ في ويندوز يجد التطبيق البرنامج عبر `PATH`/`PATHEXT`
   ويشغّل `.cmd` عبر `cmd.exe /d /s /c` مع اقتباس كل وسيط وتهريب رموز `cmd`. في الوضع المحلي أدوات البرنامج أدوات
   للمساعد (`<program>__<tool>`) للبروفايل الذي يسمّيه `X-Corehub-Profile` (زر «أضف إلى هرمز» يضعه).
8. **الموافقة** مرة في الجلسة في الوضعين (بخلاف التطبيق القديم الذي لم يسأل محليًا)؛ «الجلسة» حتى إغلاق التطبيق أو
   إطفاء البرنامج أو تغيير إعداده. كل استدعاء (برنامج أو ملف، محلي أو من المركز) في «آخر استعمال».
9. **ملفات للمحادثة**: `devices.fetch_file` يرفع الملف من مجلد مشارك بالرفع المستأنف (٥٠ م.ب حدًا) ويضعه المركز على
   رد الدور. **تذكرة بث** (§90): مسار عشوائي لمرفق واحد لمدة ساعة يُشغَّل منه `<video>` بالمدى دون رمز الحامل.
10. **جاهزية Resolve** على الأنظمة الثلاثة: التكامل موجود ومشغّل، Resolve يعمل (`pgrep` أو `tasklist`)، وResolve نفسه
    يُسأل عبر بيئة برمجته الموثّقة عن اسمه (Studio أو لا)؛ إن لم يجب وهو يعمل فالخطوتان «External scripting: Local»
    و«Studio».
11. **الصفحة**: كل ذلك داخل «هذا الجهاز» في قسم «الوكلاء على هذا الحاسوب»: المفتاح، ثم أجزاء مطوية — الاتصال بالمركز
    (أو العنوان المحلي)، المجلدات المشاركة (مجلد كور هب معلَّم)، **برامج هذا الجهاز**، آخر استعمال.
12. **تعديل ADR 0022**: القرارات ٢ و٣ و٧ (مذكور في ADR 0025 وفي رأس 0022).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- `Device` يكسب `profiles` و`helper` (اختياريان)؛ مخططات جديدة `DeviceHelper` و`DeviceHelperFolder`
  و`DeviceProgram` و`DeviceProgramTool`؛ `DevicePatch` يكسب `profiles` و`helper`.
- `DeviceRequestCreate.timeout_ms` بلا افتراضي ثابت (يصف الافتراضي لكل قدرة)؛ وصف `createRequest` و`params`/`result`
  لـ`files` و`apps`.
- `HubToolGroupId` يكسب `devices`.
- عمليتان جديدتان: `sessions.createAttachmentStream` (`POST /attachments/{id}/stream`) و`sessions.streamAttachment`
  (`GET /attachment-streams/{ticket}`، بلا حامل، `Range`)، ومخطط `AttachmentStream`.
- تعريفات `Device` في مخططات أحداث `/rt/devices` نُسخت من العقد.

## الملفات والتأثير
- **العقد**: `packages/contracts/openapi.yaml`، `events/common.schema.json` و`events/devices/*`.
- **الخادم**: `modules/devices` (`schema.ts` عمودان، `index.ts` التقرير والبروفايلات ورمز الدور، `requests.ts`
  المهل وغير المتصل ونتائج `files`/`apps`)، `drizzle/0029_device_helper.sql`؛ `modules/agents/hub-tools/catalog.ts`
  (مجموعة `devices`) و`service.ts` (مطفأة افتراضيًا، `handOver`)، `agents/index.ts`؛ `modules/sessions/engine.ts`
  (`handOver` على الرد) و`index.ts`؛ `modules/knowledge/streams.ts` (جديد) و`index.ts`؛ `modules/index.ts`؛
  `i18n` (جملة «غير متصل»).
- **سطح المكتب**: جديد `src/main/{device-link,device-answers,this-computer,programs,mcp-stdio,consent,discovery,resolve}.ts`
  و`src/shared/{programs,windows-command}.ts`؛ معدَّل `controller.ts` و`helper.ts` و`hub.ts` و`preload` و`shared/{config,helper,ipc}.ts`
  والترجمة (نافذة الموافقة)؛ اعتماديتان مدمجتان في الحزمة: `socket.io-client` و`smol-toml` (MIT).
- **الويب**: `desktop/HelperSection.tsx` (مُعاد تنظيمه)، جديد `DeviceLinkPanel.tsx` و`ProgramsSection.tsx`
  و`chat/InlineMedia.tsx`؛ `bridge-types.ts`؛ `chat/MessageView.tsx`؛ `styles/chat.css`؛ الترجمة.
- **الاختبارات**: الخادم `tests/unit/device-programs.e2e.test.ts` (الطريق كله) و`tests/unit/device-helper.test.ts`،
  وتحديث `hub-tools.test.ts` و`hub-tools.routes.test.ts`؛ سطح المكتب `tests/unit/programs.test.ts`
  و`tests/unit/program-host.test.ts` و`tests/fixtures/fake-resolve-mcp.mjs` وتحديث `hub.test.ts` و`tests/smoke/desktop.spec.ts`
  (بيت اختباري `COREHUB_DESKTOP_HOME`)؛ الويب `desktop-surface.test.tsx` و`reply-files.test.tsx`.
- **التوثيق**: `docs/adr/0025-device-programs-and-remote-reach.md` (جديد)، رأس `0022`، `DECISIONS` §89 و§90،
  `docs/domain/devices.md`، `docs/STATUS.md`.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run` في `corehub-wt-devprograms`، قبل الدمج بفرع الليلة:

```
pnpm lint                 → exit 0 — All matched files use Prettier code style!
pnpm typecheck            → exit 0
pnpm contracts:lint       → contracts:lint  validating 96 event schema file(s) … OK
pnpm contracts:check-clients → check-clients  OK — 640 client file(s) scanned, 232 contract path(s) known.
pnpm i18n:check           → web: 2757 keys … desktop: 87 keys … ar/en in parity · OK
pnpm nav:check            → nav:check  OK — 38 destinations …
pnpm contract:test        → Test Files  19 passed (19) · Tests  375 passed (375)
server (vitest, الملفات المتأثرة: device-requests, device-helper, device-programs.e2e, status,
  hub-tools, hub-tools.routes, runner, run-files, attachments)
                          → Test Files  9 passed (9) · Tests  117 passed (117)
desktop (vitest, الحزمة كلها) → Test Files  11 passed (11) · Tests  131 passed (131)
web (vitest: desktop-surface, reply-files, hub-tools-card, i18n, logical-css)
                          → Test Files  5 passed (5) · Tests  310 passed (310)
```

**الاختبار الشامل** (`tests/unit/device-programs.e2e.test.ts`): مركز حقيقي على منفذ، وكود سطح المكتب نفسه دون
Electron، وبرنامج بديل لتكامل Resolve عبر stdio، وهرمز بنموذج مكتوب يستدعي `hub-mcp`. يثبت: البرنامج يُكتشف من إضافة
Claude Desktop ويحتاج مفتاحه؛ تشغيل المساعد يصنع `~/Core Hub` مشاركًا للكتابة؛ الربط من «الصفحة» بإقران حقيقي
والاتصال الصادر والتقرير يصل المركز؛ ثم دور محادثة: إنشاء مشروع، استيراد مقطعين، خط زمني، تصدير يجيب «يعمل» ثم يُتابع
حتى ينتهي، ثم `fetch_file` — **سؤال موافقة واحد**، **كل استدعاء في السجل**، و**الـMP4 على الرد** ويُبث بالمدى
(`206`, `ftypisom`).

لم يُشغَّل محليًا: مجموعة الخادم كاملة، ومجموعة الويب كاملة، وPlaywright للويب، واختبار دخان سطح المكتب (Electron غير
منزّل هنا). بعد آخر دمج لفرع الليلة (أخذ §87 و§88 والهجرة `0028` قبلي، فصارت هذه §89 و§90 و`0029` وأُعيد توليد
الهجرة بـ`db:generate`) أُعيد تشغيل: lint وtypecheck وفحوص العقد وi18n وnav وchange-record وcontract:test (380 ناجحة)
واختبارات الخادم المتأثرة (7 ملفات، 44 اختبارًا) وسطح المكتب كله (13 ملفًا، 145) والويب المتأثر (27)، كلها ناجحة،
و`db:generate` بعدها «No schema changes».

**CI على الفرع** (`workflow_dispatch` لـ`ci.yml`، التشغيل 36206163131، بعد دمج فرع الليلة) — كله أخضر:
```
✓ Lint, typecheck, contracts, client tests, build in 6m5s
✓ db:generate + db:migrate (SQLite and PostgreSQL) in 1m18s
✓ Server unit tests (shard 1/3) in 4m16s · (2/3) in 4m10s · (3/3) in 1m54s
✓ Desktop app smoke (Electron under Xvfb against the real hub) in 1m20s
✓ Web smoke journeys (Playwright against the real hub) in 6m28s
✓ Docker image builds and answers /health in 4m22s
✓ Lint, typecheck, contracts, tests, build in 3s
```

**CI على طلب الليلة #165** بعد دفع هذا الفرع إلى `night/2026-09-27` (`74aa2c72`) — كله أخضر، ومنه مثبّتات سطح المكتب
على الأنظمة الثلاثة:
```
✓ Lint, typecheck, contracts, client tests, build 4m49s · ✓ Server unit tests 1/3 4m13s · 2/3 4m14s · 3/3 2m43s
✓ Desktop app smoke (Electron under Xvfb against the real hub) 1m23s · ✓ Web smoke journeys 7m17s
✓ Installers (macos-latest) 2m8s · (ubuntu-latest) 3m11s · (windows-latest) 6m30s
✓ db:generate + db:migrate 1m11s · ✓ Docker image 3m29s · ✓ Android 4m4s · ✓ iOS simulator 4m32s
✓ PR adds or updates a change record · ✓ PR leaves graphify-out/ to the code-map bot
```

## المخاطر والرجوع
- **البرنامج يعمل بصلاحيات حساب الشخص**: ما يقف بين الوكيل وبينه هو نافذة الموافقة وسجل الاستعمال ومجموعة `devices`
  المطفأة افتراضيًا. هذا أكبر خطر، كما في سجلات التطبيق القديم.
- تصدير فوق ٥٠ م.ب لا يعود إلى المحادثة (حد الرفع المستأنف)؛ يبقى في المجلد المشارك.
- طلب معلّق يموت إن انقطع الاتصال؛ لا إيقاظ لجهاز غير متصل.
- فحص Studio يعتمد على اسم المنتج الذي يعطيه Resolve نفسه؛ إن لم يجب Resolve تُعرض الخطوتان معًا.
- لم يُجرَّب مع Resolve حقيقي ولا على ويندوز حقيقي (منطق ويندوز مختبر بمسارات مصطنعة).
- الرجوع: التراجع عن الدمج؛ الهجرة `0029` تضيف عمودين قابلين لـnull فقط.

## التسليم والخطوة التالية
**فحص المالك على ماك حقيقي، خطوة بخطوة:**
1. ثبّت DaVinci Resolve **Studio** وافتحه. من القائمة: Preferences ← System ← General ← **External scripting using ←
   Local**، ثم أعد تشغيل Resolve.
2. ثبّت تكامل Resolve مع الذكاء الاصطناعي في Claude Desktop (إضافة أو إدخال في `claude_desktop_config.json`) وتأكد أنه
   يعمل من Claude نفسه مرة.
3. ثبّت نسخة التست من كور هب على الماك، واتصل بمركزك على الخادم (الوضع البعيد) وسجّل الدخول.
4. الإعدادات ← **هذا الجهاز** ← «الوكلاء على هذا الحاسوب»: شغّل المفتاح. تأكد أن `~/Core Hub` ظهر في «المجلدات المشاركة»
   بعلامة «مجلد كور هب» وأنه للكتابة. انسخ مقطعين أو ثلاثة إلى `~/Core Hub/clips`.
5. في «الاتصال بهذا المركز» اضغط **«اربط هذا الحاسوب بالمركز»**؛ يجب أن تظهر الشارة «متصل». (اختياري: اترك البروفايلات
   كلها مختارة.)
6. افتح «برامج هذا الجهاز»: يجب أن يظهر **DaVinci Resolve** بمصدره. إن قال «يحتاج إعدادًا» أدخل المفتاح المطلوب واحفظ.
   اختر البروفايل الذي ستستعمله. تأكد أن «ما يقدّمه» امتلأ بأدوات Resolve. اضغط **«افحص»** في بطاقة DaVinci Resolve:
   المطلوب «جاهز» بلا خطوات.
7. في المركز (من الويب أو التطبيق): وكلاء ← هرمز ← MCP ← «أدوات كور هب»: شغّلها للبروفايل، ثم مجموعة **«حواسيبك»**
   واسمح لها بالتغيير.
8. في محادثة جديدة مع هرمز في ذلك البروفايل: «في DaVinci على جهازي: أنشئ مشروعًا اسمه Trip، استورد المقاطع من
   `~/Core Hub/clips`، ضعها على خط زمني، وصدّرها MP4 في `~/Core Hub`، ثم اعرضه لي هنا».
9. المتوقع: **نافذة موافقة واحدة** على الماك («اسمح لهذه الجلسة»)؛ المشروع والخط الزمني يظهران في Resolve؛ الـMP4 في
   `~/Core Hub`؛ **الفيديو يظهر في الرد ويعمل**؛ وفي «آخر استعمال» كل استدعاء بشارة «من المركز».
10. أغلق نافذة التطبيق (يبقى في شريط النظام) وأعد الطلب بخطوة صغيرة: يجب أن يجيب دون فتح النافذة.

إن فشلت خطوة: صوّر «آخر استعمال» وبطاقة DaVinci Resolve ونص رد الوكيل.

الخطوة التالية بعد تأكيد المالك: ويندوز ولينكس على أجهزة حقيقية؛ ثم (بترتيب المواصفة) روابط ملفات الجهاز المبثوثة
مباشرة، والأوامر بموافقة لكل أمر، ولقطات الشاشة والفأرة ولوحة المفاتيح — كل واحدة بـADR يراجع استثناءات ADR 0022.
