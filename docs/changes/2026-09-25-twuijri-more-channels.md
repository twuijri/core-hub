# ربط منصات مراسلة أخرى من صفحة القنوات، مثل تيليجرام
المسؤول: twuijri · الفرع: feat/more-channels · الحالة: review

## المشكلة والهدف
طلب المالك (2026-09-25): ربط منصات مراسلة أكثر من صفحة «الوكلاء ← هرمز ← القنوات»، بالطريقة التي
صنعها #97 لتيليجرام: ربط بالرمز مع تحقق، ولوحة إعدادات فيها خيارات هرمز لتلك المنصة، وموافقات
الاقتران، وإلغاء الربط. كل ذلك فوق #93 (بوابة لكل بروفايل).

قبل هذا التغيير كانت الصفحة تربط واتساب (QR) وتيليجرام (رمز بوت) فقط. أما بقية المنصات التي يدعمها
هرمز (Discord وSlack وMatrix وMattermost والبريد وSignal وغيرها) فلا تظهر إلا إذا كتب أحد كتلتها
في `config.yaml` بيده، وتظهر حقولها خامًا بلا شرح ولا تحقق ولا إعدادات.

الهدف:
1. إطار عام للمنصات: كل منصة تعلن متغيّرات الدخول، وطريقة التحقق منها، ومفاتيحها، وأقسام إعداداتها.
2. تنفيذ كامل لأكثر المنصات استعمالًا أولًا: Discord وSlack وMatrix وMattermost والبريد.
3. بقية منصات هرمز: نموذج عام من متغيّراتها المعلنة، بلا تحقق، مع ملاحظة.
4. حجم الصورة: فحص ما تنزّله كل منصة عند أول تشغيل، وإضافة ما يتسع ضمن 300 MB مضغوطة.

## القرار والموافقات
**ما قرأته في مصدر هرمز** (MIT، الوسم المثبّت `v2026.9.14`، `/opt/hermes/src` من الصورة)، بكلماتنا:
- **متى تعمل المنصة:** كل منصة لها خطوة في `gateway/config_env.py` §_ENV_STEPS (`_Cred`). إذا
  وُجدت متغيّرات دخولها في البيئة تعمل المنصة، ما لم يقل `config.yaml` صراحة `enabled: false`.
  وهي القاعدة نفسها التي طبّقها #97 على تيليجرام.
- **المتغيّرات المعلنة:** كل منصة في `plugins/platforms/<name>/plugin.yaml` تعلن `requires_env` و
  `optional_env`. ومنصات القلب (Signal وWeixin وQQ وBlueBubbles وWhatsApp Cloud) تعلنها في `_Cred` نفسها.
- **أين تُقرأ الإعدادات:** كل محوّل له جسر من YAML إلى البيئة (`apply_yaml_config_fn`، جدول
  `_YAML_BRIDGE`). والمحوّل نفسه يقرأ `extra` (أي الملف) **أولًا**، ثم البيئة. هذا يختلف عن تيليجرام
  الذي يقرأ البيئة أولًا. والقناة الرئيسية `platforms.<p>.home_channel`، ومتغيّرها (`<P>_HOME_CHANNEL`،
  وعند Matrix `MATRIX_HOME_ROOM`) يغلب الملف.
- **الغرباء:** بوابة هرمز ترد على المرسل المجهول برمز اقتران (`gateway/authz_mixin.py`). لكن محوّل
  Discord يرفض المرسل قبل أن تراه البوابة (`_is_allowed_user`: لا أحد بلا قائمة أو دور أو قناة). ومحوّل
  البريد كذلك (`_sender_accepted`)، وهرمز يجعل البريد «تجاهل» افتراضيًا. أما Slack وMatrix وMattermost
  فتقترن.
- **الحزم الكسولة** (`tools/lazy_deps.py`): Discord (`discord.py[voice]` و`brotlicffi`)، Slack
  (`slack-bolt` و`slack-sdk`)، Matrix (`mautrix[encryption]` و`aiosqlite` و`asyncpg` و`aiohttp-socks`)،
  Feishu وDingTalk وTeams وGoogle Chat وWeCom callback. أما Mattermost والبريد فلا تحتاج شيئًا: الأولى
  `aiohttp` وهو في الصورة، والثاني مكتبة بايثون القياسية.

**القرار** (مقترح، والتأكيد للمالك):
1. **الإطار** (`modules/agents/channel-platforms.ts`): كل منصة معلنة مرة واحدة: متغيّرات الدخول (المفتاح
   كما يقرؤه هرمز، وهل هو سرّي أو مطلوب، وشكله)، ومتغيّر قائمة المسموح لهم، وهل يُتحقق منها، وهل تقترن
   أو تحتاج قائمة، وإعداداتها، ومصدر مكتبتها، وهل تحتاج عنوانًا عامًّا. وعملية جديدة
   `agents.listChannelPlatforms` تعرض ذلك للعميل. الكلمات والخطوات عند العميل (ar/en)، ومفتاحها
   المنصة والمتغيّر، كما في §41.
2. **الربط** عبر `agents.linkChannel` بحقل `credentials`. أولًا يُفحص الشكل، ثم تُسأل المنصة سؤالًا رخيصًا
   قبل حفظ أي شيء:

   | المنصة | السؤال |
   |---|---|
   | Discord | `GET /users/@me` |
   | Slack | `auth.test` برمز البوت، ثم `apps.connections.open` برمز التطبيق (يعطي عنوان مقبس ولا يفتح شيئًا) |
   | Matrix | `GET /_matrix/client/v3/account/whoami` |
   | Mattermost | `GET /api/v4/users/me` |
   | البريد | تسجيل دخول IMAP ثم SMTP، يُغلقان فورًا بلا قراءة ولا إرسال |

   الرفض يأتي بكلمات المنصة نفسها (`credentials_rejected`)، وعدم الرد `platform_unreachable`. القيم
   تُحفظ في `.env` البروفايل (0600، بالاقتباس الذي يكتبه هرمز)، وتُفعَّل القناة. ويُكتب
   `unauthorized_dm_behavior: pair` للمنصات التي تقترن فقط. ما قالته المنصة عن الحساب يُحفظ في
   `platforms/<p>/hub-account.json` مع بصمة للمتغيّرات، فلا يُسمّى حساب بعد تغيير الرمز يدويًا.
3. **الإعدادات:** محرّك #97 صار عامًّا (`channel-settings.ts`)، وتيليجرام أحد جداوله. لكل منصة كاملة
   جدول بكلماتنا: الإشارات، والسلاسل (threads)، والقنوات أو الغرف المسموحة، والأشخاص، والقناة
   الرئيسية، وإظهار التفكير وتقدّم الأدوات. ما يقرؤه المحوّل من الملف أولًا يُكتب في الملف، وإن كان
   متغيّره في `.env` يُحدَّث هناك أيضًا حتى لا يتعارضا.
4. **إلغاء الربط** يحذف المتغيّرات المعلنة وملاحظة الحساب، ويطفئ القناة، ويُبقي القائمة والإعدادات.
   البوابة تبقى متوقّفة أثناء الحذف، كما في تيليجرام.
5. **Discord والبريد لا يقترنان:** نافذة الربط تطلب قائمة المسموح لهم، وتنبّه أن القائمة الفارغة تعني
   ألّا يُرد على أحد.
6. **بقية المنصات** (16 منصة: Signal وSMS وFeishu وDingTalk وWeCom وWeixin وQQ وLINE وGoogle Chat
   وTeams وHome Assistant وntfy وIRC وBlueBubbles وWhatsApp Cloud API وSimpleX) تُربط بنموذج من
   متغيّراتها. لا تحقق ولا لوحة إعدادات، والنافذة تقول ذلك. المركز لا يكتب لها سياسة الغرباء، فيبقى
   افتراضي هرمز. والتي تنزّل مكتبتها عند أول تشغيل أو تحتاج عنوانًا عامًّا عليها شارة.
7. **الصورة:** أضفت مكتبتي Discord وSlack بمثبّتات هرمز نفسها (قائمة `IMAGE_CHANNELS` في
   `Dockerfile`). **Matrix لم تُضف:** كانت ستجعل الصورة 299.9 MB، أي 0.14 MB فقط تحت الحد، وأي تغيير
   لاحق سيتجاوزه. تبقى تُنزَّل عند أول تشغيل، والصفحة تقول ذلك. إضافتها لاحقًا كلمة واحدة في
   `IMAGE_CHANNELS`.

قرار العقد: `docs/contracts/DECISIONS.md` §56.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
- عملية جديدة `agents.listChannelPlatforms` (`GET /agents/{agent_id}/channel-platforms` →
  `ChannelPlatformList`)، ومخططات `ChannelPlatform` و`ChannelCredentialField`.
- `ChannelTokenLink`: `token` لم يعد مطلوبًا، وأُضيف `credentials` (المتغيّر ← القيمة). عناصر
  `allowed_users` صارت `^[^,\s]{1,320}$`.
- `Channel.login` يقبل `credentials`. وتحدّث شرح `ChannelLink.account_username` و`linkChannel`
  و`unlinkChannel` و`getChannelSettings`.
- العدد: 265 عملية، منها 207 منفّذة (كانت 264 و206).

## الملفات والتأثير
- الخادم (`packages/server/src/modules/agents/`):
  - `channel-platforms.ts` (جديد): الكتالوج، وجداول الإعدادات، والربط وإلغاؤه بالمتغيّرات.
  - `channel-validate.ts` (جديد): أسئلة المنصات، ومنها IMAP وSMTP.
  - `channel-settings.ts` (جديد): محرّك الإعدادات العام.
  - `profile-env.ts` (جديد): `.env` البروفايل (نُقل من `channels.ts`، ومعه اقتباس هرمز).
  - `telegram-settings.ts`: جدول تيليجرام فوق المحرّك.
  - `channels.ts`: المنصات المربوطة بالمتغيّرات في القائمة، و`unlinkPlatform`.
  - `index.ts`: المسارات.
- الصورة: `packages/server/Dockerfile`، و`scripts/image-sealed-check.mjs` (فحصان جديدان).
- الويب:
  - `agents/AgentChannelsScreen.tsx`: «منصات أخرى»، ونافذة «ربط <المنصة>»، و«كيف تبدأ».
  - `agents/ChannelSettingsPanel.tsx` (كان `TelegramSettingsPanel.tsx`): لوحة لأي منصة.
  - `agents/skills.ts`، `agents/toolErrors.ts`، `i18n/ar.json` و`en.json`.
  - `e2e/hub.ts`: Discord مُمثَّل.
  - رحلة 41 `e2e/zzzzz-channels-discord.spec.ts`، ولقطاتها الثلاث. وتغيّرت لقطات القنوات السابقة
    الخمس بسبب قسم «منصات أخرى».
- الاختبارات:
  - الخادم: `channel-link.routes.test.ts`، `channel-validate.test.ts` (خادما IMAP وSMTP محلّيان)،
    `tests/contract/channels.contract.test.ts`، `tests/unit/channels.real.test.ts` (هرمز الحقيقي).
    وعُدّلت ثلاثة مواضع في اختبارين قديمين كانت تستعمل Slack مثالًا لمنصة «غير مدعومة»، فصار المثال `webhook`.
  - الويب: `tests/channels-platforms.test.tsx`.
- الوثائق: `docs/STATUS.md`، `docs/DEPLOY.md`، `docs/contracts/DECISIONS.md` §56، هذا السجل.

**الحجم** (`docker save … | gzip -1 | wc -c`، الصورتان من هذا الفرع، والفرق الوحيد `IMAGE_CHANNELS`):

| الصورة | بايت | MB |
|---|---|---|
| تيليجرام وحده (كما في main) | 284,372,845 | 284.4 |
| + Discord + Slack (هذا الفرع) | 291,987,418 | 292.0 |
| الفرق | +7,614,573 | +7.6 |
| لو أُضيف Matrix أيضًا (قياس، لم يُعتمد) | 299,862,679 | 299.9 |

## الفحوص (الأوامر ونواتجها الفعلية)
كلها عبر `mj-run` (حد ذاكرة 10 غ.ب).

```
$ pnpm lint
All matched files use Prettier code style!
$ pnpm typecheck          # exit 0، و0 × "error TS"
$ pnpm contracts:lint
contracts:lint  OK
$ pnpm contracts:check-clients
check-clients  OK — 283 client file(s) scanned, 177 contract path(s) known.
$ pnpm contract:test
 Test Files  5 passed (5)
      Tests  277 passed (277)
$ pnpm i18n:check
i18n:check  OK
$ pnpm nav:check
nav:check  OK — 34 destinations, 2 pre-auth screens (login, setup), 39 terms, ar/en complete, routes for web
$ vitest run --project unit src/modules/agents/channel-link.routes.test.ts src/modules/agents/channel-validate.test.ts
      Tests  20 passed (20)
$ vitest run --project unit src/modules/agents/telegram-settings.test.ts src/modules/agents/telegram-link.routes.test.ts src/modules/agents/channels.test.ts src/modules/agents/channels-gateway.routes.test.ts src/modules/agents/hermes-gateways.test.ts
      Tests  76 passed (76)
$ vitest run --project unit tests/unit/status.test.ts
      Tests  1 passed (1)
$ vitest run tests/channels-platforms.test.tsx tests/channels-telegram.test.tsx tests/i18n.test.ts   # الويب
      Tests  14 passed (14)
$ vitest run tests/pending-actions.test.tsx tests/channels-pairing.test.tsx tests/settings-pages.test.tsx tests/agents-top-level.test.tsx
      Tests  31 passed (31)
$ pnpm build   # exit 0
$ PLAYWRIGHT_CHANNEL=chrome playwright test e2e/zzzzz-channels-discord.spec.ts e2e/zzzzz-channels-telegram.spec.ts e2e/zzzzz-channels-pairing.spec.ts --workers=1
  ✓  1 … 41. Discord linked like Telegram: the steps, the bot named, its settings, and Unlink (1.6s)
  ✓  2 … 30. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink (11.5s)
  ✓  3 … 31. Telegram linked by a bot token: the steps, the bot named, approvals, and Unlink (11.8s)
  3 passed (32.3s)
```

الاختبار الذي كشف خطأً قبل إصلاحه: بعد حفظ «القناة الرئيسية» ثم إلغاء الربط، بقي Discord «مربوطًا»،
لأن عقدة `home_channel` كانت تُعدّ حقلًا معبّأً. الآن لا يُحسب مربوطًا إلا بمتغيّرات الدخول أو بحقل سرّي
في الملف (`channels.contract.test.ts`).

**فحص الصورة المختومة** على صورة هذا الفرع (`core-hub:morechannels`):
```
ok    Hermes's Telegram client is in the image (no network, nothing installed) — /opt/hermes/.venv/lib/python3.12/site-packages/telegram/__init__.py
ok    Hermes's Discord client is in the image (no network, nothing installed) — /opt/hermes/.venv/lib/python3.12/site-packages/discord/__init__.py
ok    Hermes's Slack client is in the image (no network, nothing installed) — /opt/hermes/.venv/lib/python3.12/site-packages/slack_bolt/__init__.py
…(الفحوص الـ15 الأخرى ok)
image:sealed-check  OK
```
`ensure()` في هرمز نفسه، بلا شبكة، على الصورتين:
```
== core-hub:morechannels-base        (تيليجرام وحده)
platform.discord FAIL FeatureUnavailable Feature 'platform.discord' unavailable: pip install failed: …
platform.slack FAIL FeatureUnavailable Feature 'platform.slack' unavailable: pip install failed: …
platform.matrix FAIL FeatureUnavailable Feature 'platform.matrix' unavailable: pip install failed: …
== core-hub:morechannels
platform.discord available
platform.slack available
platform.matrix FAIL FeatureUnavailable Feature 'platform.matrix' unavailable: pip install failed: …
```

**هرمز الحقيقي** في حاوية بلا شبكة (`--network none`). البروفايل «desk» صنعه هرمز. كود المركز نفسه
ربط فيه Discord وSlack وMattermost وكتب الإعدادات. بعدها قرأها محمّل هرمز، ثم شغّلنا البوابة التي
يشغّلها المشرف (`hermes -p desk gateway run`):
```
$ COREHUB_HERMES_IMAGE=core-hub:morechannels vitest run --project unit --reporter=verbose tests/unit/channels.real.test.ts
 ✓ … is what Hermes’s own loader reads 680ms
discord: connecting
slack: connecting
mattermost: connecting
 ✓ … runs Discord and Slack from the image’s own libraries, installing nothing 9015ms
      Tests  2 passed (2)
```
ما قرأه محمّل هرمز:
- Discord: مفعّل، والرمز من `.env`، و`require_mention=false`، و`auto_thread=false`، والقنوات
  `'1111,2222'`، والقناة الرئيسية `3333`.
- Slack: مفعّل، و`reply_in_thread=false`، وسياسة الغرباء `pair`.
- Mattermost: `reply_mode=thread`.
- إظهار التفكير لـ Discord: `true`.

الحالة `connecting` لأن لا شبكة، والمهم أن المحوّلين بدآ من مكتبات الصورة. وعلى صورة تيليجرام وحده
فشل الاختبار الثاني بعد 120 ثانية: لم يظهر Discord ولا Slack في ملف حالة البوابة.

CI على #129 (الالتزام `9f234ce`، التشغيل 36099771693): كل الفحوص الستة خضراء.
```
Docker image builds and answers /health                 pass  3m9s
Lint, typecheck, contracts, tests, build                pass  17m50s
PR adds or updates a change record                      pass  13s
PR leaves graphify-out/ to the code-map bot             pass  8s
Web smoke journeys (Playwright against the real hub)    pass  4m25s
db:generate + db:migrate (SQLite and PostgreSQL)        pass  1m2s
```
`main` لم يتحرّك منذ تفرّع هذا الفرع (`git log HEAD..origin/main` فارغ)، فلا دمج مطلوب.

## المخاطر والرجوع
- **الحجم** +7.6 MB مضغوطة (292.0 MB، داخل 100–300).
- **Matrix والمنصات العامة ذات المكتبات** (Feishu وDingTalk وTeams وGoogle Chat) تحتاج PyPI عند أول
  تشغيل، والصفحة تقول ذلك بشارة وملاحظة.
- **المنصات العامة لا يُتحقق منها:** قيمة خاطئة تظهر كخطأ هرمز في صف المنصة بعد تشغيل البوابة.
- **Slack ما زال بلا اختبار على حساب حقيقي**، وكذلك Discord وMatrix وMattermost والبريد: التحقق مُمثَّل
  بواجهات مكتوبة، والتحميل والتشغيل مثبتان على هرمز الحقيقي بلا شبكة. التحقق من البريد عبر TLS
  و STARTTLS مكتوب لكن الاختبار المحلي يمر بنص صريح.
- إعدادات Discord في البروفايل الافتراضي لا تسري قبل «أعد تشغيل هرمز»، كما في تيليجرام.
- **الرجوع:** عكس الدمج. المتغيّرات في `.env` هي أسماء هرمز نفسه، والمفاتيح في `config.yaml` مفاتيحه،
  فيقرؤها هرمز كما هي. تبقى ملاحظة `hub-account.json`، وهي لا تضر.

## التسليم والخطوة التالية
- طلب الدمج: https://github.com/twuijri/core-hub/pull/129 (بالإنجليزية إلى `main`).
- الخطوة التالية: CI أخضر، ثم تجربة المالك بحساب Discord أو Slack حقيقي على صورة من هذا الفرع.
