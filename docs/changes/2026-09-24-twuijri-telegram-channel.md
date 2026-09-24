# ربط تيليجرام بهرمز لكل بروفايل من الويب، وإعداداته
المسؤول: twuijri · الفرع: feat/telegram-channel · الحالة: in-progress

## المشكلة والهدف
طلب المالك (2026-09-24): «ابي تربط التليجرام … لانه ما سويت الا واتساب وانا احتاج تليجرام».
صفحة «الوكلاء ← هرمز ← القنوات» تربط واتساب برمز QR (#80، #93)، ولا طريقة فيها لربط تيليجرام. تركه #80
لأن مسار هرمز الخاص (`hermes telegram`) قد يصنع البوت عبر خدمة خارجية من Nous، وهذا ليس ما نريده.

ثم وسّع المالك الطلب: «التليجرام فيه خصائص كثيره … يطلع ثينكينج … في اكثر من شغله». يريد كل ما يدعمه
هرمز لتيليجرام متاحًا من الصفحة، مثل إظهار تفكير النموذج.

الهدف: ربط تيليجرام في البروفايل المختار برمز بوت يصنعه الشخص بنفسه من ‎@BotFather‎، مع شرح بسيط، والتحقق
من الرمز عند تيليجرام، وحفظه سرًّا في `.env` البروفايل، وتشغيل بوابة البروفايل، والموافقات، وإلغاء الربط.
ومعه لوحة «إعدادات تيليجرام» فيها كل خيار يخص المستخدم، ولكل خيار عنصر تحكم وقيمة هرمز الافتراضية.

## القرار والموافقات
**ما قرأته في مصدر هرمز** (MIT، الوسم المثبّت `v2026.9.14`، من الصورة `ghcr.io/twuijri/majlis:latest`
تحت `/opt/hermes`)، بكلماتنا:
- الرمز في `TELEGRAM_BOT_TOKEN`. وجوده في البيئة يشغّل المنصّة، ما لم يقل `config.yaml`
  `platforms.telegram.enabled: false` صراحة (`gateway/config_env.py` §_Cred و§_enable_from_env).
- شكل الرمز الذي يقبله هرمز: أرقام، ثم نقطتان، ثم 30 حرفًا أو أكثر (`hermes_cli/setup_platforms.py`).
- بوابة البروفايل المسمّى تحمّل `.env` ذلك البروفايل وحده، فلا تتسرّب إليها مفاتيح الجذر
  (`hermes_cli/env_loader.py`).
- الغرباء: قيمة `unauthorized_dm_behavior` للمنصّة (`pair` | `ignore`) تغلب ما سواها. إن وُجدت قائمة
  `TELEGRAM_ALLOWED_USERS` ولم يُحدَّد شيء، صار السلوك الافتراضي «تجاهل» بصمت (`gateway/authz_mixin.py`
  §_get_unauthorized_dm_behavior). لذلك يكتب المركز `pair` صراحة.
- ملفات الاقتران `platforms/pairing/telegram-pending.json` كما في واتساب، وواجهة هرمز للاقتران تخدم كل المنصّات.
- **صورتنا لا تحوي مكتبة تيليجرام** (`python-telegram-bot`). الـDockerfile يثبّت هرمز بـ`.[cron,mcp]`
  فقط. هرمز يثبّتها وحده عند أول تشغيل للمنصّة (`tools/lazy_deps.py` §ensure،
  `platform.telegram` → `python-telegram-bot[webhooks]==22.8`) في `HERMES_LAZY_INSTALL_TARGET=/data/hermes-packages`،
  وهو ما تضبطه الصورة. معنى ذلك: أول ربط يحتاج أن يصل المركز إلى PyPI مرة واحدة، ثم تبقى المكتبة في
  وحدة البيانات بعد إعادة إنشاء الحاوية.

**القرار — الربط** (مقترح، والتأكيد للمالك):
1. زر «ربط تيليجرام» يفتح نافذة بثلاث خطوات: افتح ‎@BotFather‎، أرسل ‎/newbot‎، انسخ الرمز. بعدها خانة
   الرمز، وخانة اختيارية لمعرّفات من لا يحتاجون موافقة (`TELEGRAM_ALLOWED_USERS`) مع شرح ‎@userinfobot‎.
   لا نستعمل خدمة Nous الخارجية.
2. المركز يسأل تيليجرام `getMe` قبل أن يحفظ أي شيء:
   - رمز بشكل خاطئ لا يُرسَل إلى تيليجرام أصلًا (`token_invalid`).
   - رمز يرفضه تيليجرام يُعرض الرفض بكلمات تيليجرام نفسها (`token_rejected`).
   - تيليجرام لا يرد (`telegram_unreachable`).
   - بوت مربوط في بروفايل آخر يُذكر اسم ذلك البروفايل (`token_in_use`)، لأن تيليجرام لا يسمح إلا لعملية
     واحدة بسحب رسائل البوت.
3. الرمز يُحفظ في `.env` البروفايل نفسه (صلاحية 0600، كتابة ذرّية)، لا في `config.yaml`، ولا يعود إلى العميل
   أبدًا. ما يقوله تيليجرام عن البوت (الرقم، الاسم، ‎@username‎) يُحفظ في `platforms/telegram/hub-bot.json`،
   لتسمّي الصفحة البوت دون سؤال تيليجرام في كل قراءة. ولا يُستعمل هذا الملف إلا ما دام رقمه يطابق بداية الرمز.
4. البوابة في البروفايل المسمّى تبدأ أو يُعاد تشغيلها فورًا (مشرف #93). أما في الافتراضي فالبوابة تحمل خادم
   الـAPI ومحادثات الويب، وإعادة تشغيلها عند الربط ليست «رخيصة». لذلك يبقى زر «أعد تشغيل هرمز» كما في
   واتساب، والنافذة والصفحة تقولان ذلك صراحة. إلغاء الربط يوقف البوابة التي تخدم البروفايل ثم يعيد تشغيلها
   (كواتساب)، فيتوقف البوت عن الرد فورًا في كل بروفايل.
5. إلغاء الربط يحذف الرمز من `.env` (ومن `platforms.telegram.token` إن كتبه أحد يدويًا)، ويحذف ملاحظة
   البوت، ويطفئ القناة. تبقى قائمة المعتمدين والإعدادات. البوت نفسه يبقى في تيليجرام.
6. بعد الربط يُكتب في الصف «مربوط بحساب <الاسم> · ‎@bot‎». وتشرح الصفحة الخطوات: افتح ‎t.me/<bot>‎ (رابط)،
   أرسل أي رسالة، ثم وافق على الطلب تحت «طلبات بانتظار الموافقة». الموافقات من #93 تعمل لـ`telegram` كما هي.

**جرد خيارات تيليجرام في هرمز** (بكلماتنا؛ «ملف» = `config.yaml` البروفايل، «بيئة» = `.env` البروفايل):

| الخيار في اللوحة | ما يفعله | المفتاح في هرمز | الافتراضي | مشترك؟ |
|---|---|---|---|---|
| أشخاص لا يحتاجون موافقة | يراسلون بلا رمز اقتران | بيئة `TELEGRAM_ALLOWED_USERS` | لا أحد | لا |
| عندما يراسل البوتَ غريب | رمز اقتران أو تجاهل | `platforms.telegram.unauthorized_dm_behavior` (`pair`/`ignore`) | `pair` | لا |
| إظهار تفكير النموذج | كتلة التفكير قبل الإجابة | `display.platforms.telegram.show_reasoning` ← `display.show_reasoning` | معطّل | لا (مفتاح المنصّة) |
| شكل التفكير | `code`/`blockquote`/`subtext` | `display.platforms.telegram.reasoning_style` | `code` | لا |
| إظهار ما يفعله الوكيل | `off`/`new`/`all`/`verbose` | `display.platforms.telegram.tool_progress` | `off` لتيليجرام | لا |
| حذف رسائل التقدّم | بعد إجابة ناجحة | `display.platforms.telegram.cleanup_progress` | معطّل | لا |
| كتابة الإجابة أولًا بأول | تعديل رسالة واحدة | `display.platforms.telegram.streaming` ← `streaming.enabled` | معطّل | لا |
| الرد باقتباس | `off`/`first`/`all` | `platforms.telegram.reply_to_mode` · بيئة `TELEGRAM_REPLY_TO_MODE` | `first` | لا |
| التفاعلات | 👀 ثم ✅/❌ | `platforms.telegram.reactions` · بيئة `TELEGRAM_REACTIONS` | معطّل | لا |
| مؤشر «يكتب…» | | `platforms.telegram.typing_indicator` | مفعّل | لا |
| بلا معاينة للروابط | | `platforms.telegram.disable_link_previews` | معطّل | لا |
| صوت الإشعار | `important`/`all` | `display.platforms.telegram.notifications` · بيئة `HERMES_TELEGRAM_NOTIFICATIONS` | `important` | لا |
| المجموعات: الرد عند الإشارة فقط | | `platforms.telegram.require_mention` · بيئة `TELEGRAM_REQUIRE_MENTION` | معطّل | لا |
| هذه المجموعات فقط | معرّفات مجموعات | `platforms.telegram.allowed_chats` · بيئة `TELEGRAM_ALLOWED_CHATS` | فارغ | لا |
| مجموعات بلا حاجة للإشارة | | `platforms.telegram.free_response_chats` · بيئة `TELEGRAM_FREE_RESPONSE_CHATS` | فارغ | لا |
| أشخاص مسموح لهم في المجموعات | لا يمنح الخاص | بيئة `TELEGRAM_GROUP_ALLOWED_USERS` | فارغ | لا |
| قراءة رسائل المجموعة بلا رد | سياقًا | `platforms.telegram.observe_unmentioned_group_messages` · بيئة بالاسم نفسه | معطّل | لا |
| الرد على الإشارة في أي مجموعة | | `platforms.telegram.guest_mode` · بيئة `TELEGRAM_GUEST_MODE` | معطّل | لا |
| تجاهل رسائل بوتات أخرى | | `platforms.telegram.exclusive_bot_mentions` · بيئة بالاسم نفسه | مفعّل | لا |
| رسائل البوتات الأخرى | `none`/`all` | `platforms.telegram.allow_bots` · بيئة `TELEGRAM_ALLOW_BOTS` | `none` | لا |
| تحويل الصوت إلى نص | | `stt.enabled` | مفعّل | **نعم** |
| إظهار النص المحوَّل | | `stt.echo_transcripts` | مفعّل | **نعم** |
| الرد برسائل صوتية | | `voice.auto_tts` (و‎/voice‎ لكل محادثة) | معطّل | **نعم** |
| المحادثة الرئيسية | للمهام والتنبيهات | `platforms.telegram.home_channel {platform, chat_id, name}` · بيئة `TELEGRAM_HOME_CHANNEL` | لا شيء | لا |
| التنبيه عند العودة | | `platforms.telegram.gateway_restart_notification` | مفعّل | لا |
| عدد الأوامر في القائمة | 1–100 | `platforms.telegram.extra.command_menu.max_commands` | 60 | لا |
| بروكسي | | `platforms.telegram.proxy_url` · بيئة `TELEGRAM_PROXY` | لا شيء | لا |

قواعد الكتابة: يُكتب المفتاح حيث يقرؤه هرمز. في كتلة المنصّة يغلب `extra.<k>` ثم الكتلة الجذرية `telegram:`
على `platforms.telegram.<k>`، فيُعدَّل المفتاح في مكانه إن وُجد. وإن كان المتغيّر موجودًا في `.env` البروفايل
يُعدَّل هناك، لأنه يغلب الملف. قيم مثل `off` تُكتب بين علامتي تنصيص، لأن قارئ YAML 1.1 في هرمز يقرؤها
قيمة منطقية. والمعرّفات تُكتب نصوصًا. الخيارات المشتركة تظهر في اللوحة بشارة «يغيّر واتساب والقنوات الأخرى أيضًا».

**ما لم يُعرض، ولماذا**:
- ضبط النقل: أحجام وأوقات اتصالات HTTP، تأخير تجميع النص والوسائط، اكتشاف عناوين IP البديلة، مهلة المؤشر.
- وضع webhook: يحتاج عنوان HTTPS عامًّا ومنفذًا منشورًا لا تفتحه الصورة. السحب (polling) يعمل في كل مكان.
- خادم Bot API محلي (`base_url`، `local_mode`).
- خرائط منظّمة تحتاج محررًا خاصًّا بها: تعليمات وموديلات لكل محادثة، مواضيع الخاص والمجموعات، أنماط الإشارة
  (regex)، قوائم معرّفات المواضيع.
- التوجيه العام للبوابة (`notice_delivery`، `reply_in_thread`، جلسة لكل مستخدم).
- مفاتيح لا يقرؤها محوّل تيليجرام أصلًا: `reply_prefix`، `send_read_receipts`، `typing_status_text`.
- ما لا وجود له في هرمز: لا خيار للتنسيق (هرمز يرسل MarkdownV2 دائمًا)، وأنواع الصور وحدود الحجم ثابتة.

**القرار — اللوحة**: زر «الإعدادات» في صف تيليجرام المربوط يفتح لوحة من خمسة أقسام: من يراسل البوت · الردود
· المجموعات · الوسائط والصوت · متقدم. التغييرات تُجمع وتُحفظ معًا، لأن كل حفظ يعيد تشغيل بوابة البروفايل،
فيكون الحفظ الواحد إعادة تشغيل واحدة. لكل خيار «رجوع للافتراضي». المسمّيات والشرح عند العميل (ar/en)، مفتاحها
اسم الخيار.

قرار العقد: `docs/contracts/DECISIONS.md` §41.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عمليات جديدة:
  - `agents.linkChannel` (`POST /agents/{agent_id}/channels/{platform}/link`، الجسم
    `ChannelTokenLink {token, allowed_users?}`، `200` بالقناة).
  - `agents.getChannelSettings` (`GET …/channels/{platform}/settings` → `ChannelSettings`).
  - `agents.updateChannelSettings` (`PATCH …/settings`، الجسم `ChannelSettingsWrite {values}`).
- `ChannelLink.account_username` (جديد، مطلوب، ويقبل null)؛ `Channel.login` يقبل `token`؛
  `agents.unlinkChannel` يشمل `telegram`.
- العدد: 262 عملية، منها 204 منفّذة (كانت 259 و201).

## الملفات والتأثير
- الخادم:
  - `modules/agents/channels.ts`: قراءة تيليجرام وربطه وإلغاؤه.
  - `telegram-api.ts` (جديد): `getMe`.
  - `telegram-settings.ts` (جديد): جدول الخيارات والقراءة والكتابة.
  - `index.ts`: المسارات، إلغاء الربط، `login: token`.
- الويب:
  - `agents/AgentChannelsScreen.tsx`، `agents/TelegramSettingsPanel.tsx` (جديد)، `agents/skills.ts`،
    `agents/toolErrors.ts`، `i18n/ar.json` و`en.json`.
  - `e2e/hub.ts`: تيليجرام مُمثَّل، والاقتران لكل المنصّات.
  - رحلة 31 `e2e/zzzzz-channels-telegram.spec.ts`، ولقطاتها الثلاث. ولقطتا القنوات السابقتان تغيّرتا
    بسبب زر «ربط تيليجرام».
- الاختبارات:
  - الخادم: `telegram-link.routes.test.ts`، `telegram-settings.test.ts`، إضافات `channels.test.ts`،
    `tests/unit/telegram.real.test.ts` (هرمز الحقيقي).
  - الويب: `tests/channels-telegram.test.tsx`.
- الوثائق: `docs/STATUS.md`، `docs/contracts/DECISIONS.md` §41، هذا السجل.

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run` (حد ذاكرة 10 غ.ب).

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck            # exit 0
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 263 client file(s) scanned, 174 contract path(s) known.
$ pnpm i18n:check
i18n:check  web: 1254 keys, ar/en in parity
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ vitest run --project unit src/modules/agents/telegram-link.routes.test.ts
      Tests  11 passed (11)
$ vitest run --project unit src/modules/agents/telegram-settings.test.ts
      Tests  11 passed (11)
$ vitest run tests/channels-telegram.test.tsx   # web
      Tests  5 passed (5)
$ pnpm --filter @majlis/server test          # VITEST_MAX_WORKERS=3؛ قبل تحديث STATUS
 Test Files  1 failed | 99 passed | 15 skipped (115)
      Tests  1 failed | 1048 passed | 44 skipped (1093)
   (status.test.ts: «the contract grew or shrank: update docs/STATUS.md» — حُدِّث STATUS)
$ vitest run --project unit tests/unit/status.test.ts
      Tests  1 passed (1)
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzz-channels-pairing.spec.ts e2e/zzzzz-channels-telegram.spec.ts --workers=1
  ✓  1 … 30. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink (11.8s)
  ✓  2 … 31. Telegram linked by a bot token: the steps, the bot named, approvals, and Unlink (11.3s)
  2 passed (33.6s)
$ playwright test e2e/zzzzz-channels-telegram.spec.ts   # بعد إضافة خطوات الإعدادات
  ✓  1 … 31. Telegram linked by a bot token: the steps, the bot named, approvals, and Unlink (11.6s)
  1 passed (17.9s)
```

هرمز الحقيقي في حاوية واحدة، وتيليجرام مُمثَّل على هذا الجهاز (`platforms.telegram.extra.base_url`، يكتبه
الاختبار وحده). البروفايل «tgbot» صنعه هرمز، والربط والإعدادات كتبها كود المركز نفسه، والبوابة
`hermes -p tgbot gateway run` هي ما يشغّله المشرف:
```
$ MAJLIS_HERMES_IMAGE=majlis:local vitest run --project unit --reporter=verbose tests/unit/telegram.real.test.ts
 ✓ … is a channel the hub starts a gateway for, and the gateway connects with the profile’s token 20033ms
 ✓ … answers a stranger with a pairing code and keeps the request in the profile 8005ms
 ✓ … reads the saved settings where the panel wrote them 548ms
      Tests  3 passed (3)
(سجل البوابة)
[Telegram] Connecting to Telegram (attempt 1/8)…
[Telegram] Connected to Telegram (polling mode)
gateway.run: Unauthorized user: 555666777 (Noura) on telegram
```
البوابة ثبّتت `python-telegram-bot` بنفسها في مجلد البيانات، واتصلت بالرمز الموجود في `.env` البروفايل.
ردّت على الغريب برمز اقتران (`sendMessage`) رغم وجود قائمة المعتمدين، وكتبت طلبه في
`profiles/tgbot/platforms/pairing/telegram-pending.json`. ومحمّل الإعدادات في هرمز نفسه قرأ ما كتبته اللوحة:
`show_reasoning: true`، `require_mention: true`، `unauthorized_dm_behavior: pair`.

الصورة المنشورة `ghcr.io/twuijri/majlis:latest` (بتاريخ 2026-09-23) فشل عليها الاختباران الأوّلان. السجل قال:
`Platform 'Telegram' requirements not met`. وسؤال التثبيت الكسول مباشرة أعطى:
```
FAIL FeatureUnavailable("Feature 'platform.telegram' unavailable: pip install failed: pip not available and ensurepip failed …")
$ docker run --rm --entrypoint /opt/hermes/.venv/bin/python ghcr.io/twuijri/majlis:latest -m pip --version
/opt/hermes/.venv/bin/python: No module named pip
$ docker run --rm --entrypoint /opt/hermes/.venv/bin/python majlis:local -m pip --version
pip 25.0.1 from /opt/hermes/.venv/lib/python3.12/site-packages/pip (python 3.12)
```
معنى ذلك: تيليجرام يعمل على صورة مبنية من `main` الحالي (فيها pip داخل البيئة المختومة). ولا يعمل على
صورة `latest` المنشورة يوم 2026-09-23.

## المخاطر والرجوع
- **أول ربط يحتاج PyPI**: هرمز يثبّت `python-telegram-bot` في `/data/hermes-packages` عند أول تشغيل
  (بضع ثوانٍ). بلا إنترنت تبقى البوابة بلا تيليجرام، والصفحة تعرض خطأ البوابة. البديل، وهو مقترح للمالك:
  إضافة الحزمة إلى الصورة (بضعة م.ب).
- **صورة `latest` القديمة لا تكفي**: فيها لا يوجد pip داخل البيئة، فيفشل التثبيت الكسول. يلزم بناء صورة من
  `main` الحالي.
- الخيارات المشتركة (الصوت) تغيّر كل قنوات البروفايل، واللوحة تقول ذلك.
- حفظ الإعدادات في البروفايل الافتراضي لا يسري قبل «أعد تشغيل هرمز»، والصفحة تقول ذلك.
- الرجوع: عكس الدمج. الرمز يبقى في `.env` البروفايل، وهرمز يقرؤه كما يقرؤه دائمًا. المفاتيح التي كُتبت في
  `config.yaml` هي مفاتيح هرمز نفسها.

## التسليم والخطوة التالية
- طلب الدمج: https://github.com/twuijri/core-hub/pull/97 (بالإنجليزية إلى `main`).
- الخطوة التالية: CI أخضر، ثم دمج `main` (وإعادة التسمية Core Hub إن دُمجت أولًا) قبل المراجعة.
