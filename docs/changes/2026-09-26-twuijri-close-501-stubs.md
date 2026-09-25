# إغلاق ما بقي من ردود ‎501‎: الجرد، ثم بناء ما اتّضح اتجاهه
المسؤول: twuijri · الفرع: feat/close-501-stubs · الحالة: in-progress

## المشكلة والهدف
بقيت في العقد عمليات يجيبها المركز بـ`501 not_implemented`، وبقيت في `docs/STATUS.md` جمل «لم يُبنَ» متفرقة. المطلوب:
1. جرد كامل لكل عملية ما زالت ‎501‎ ولكل ملاحظة «لم يُبنَ»، وتصنيف كل بند:
   **(أ)** يُبنى الآن لأن اتجاهه محسوم في ADR أو DECISIONS أو المواصفات أو STATUS؛
   **(ب)** يحتاج قرارًا من المالك (مع السؤال)؛
   **(ج)** مرشّح للحذف من العقد لأنه صار بلا معنى (مع السبب، بلا حذف).
2. بناء بنود (أ) مجموعةً مجموعة، الأنفع أولًا، حتى ثلاث مجموعات تقريبًا، ثم التوقف ليبقى طلب الليلة قابلًا للمراجعة.

## القرار والموافقات

### الجرد (قيس على فرع الليلة، ٢٠٢٦-٠٩-٢٦)
الطريقة: اختبار مؤقت (لم يُلتزم) يبني المركز بـ`testHub()` ويطبع `app.hub.stubs` — وهي كل عملية في العقد لم يركّبها أي
وحدة، فيجيبها `routes.ts` بـ‎501‎ — مع `operationId` كل واحدة. ثم بحث عن `notImplemented` / `not_implemented` داخل الوحدات.

```
total 315 stubs 20
agents.getAvatar	GET /agents/{agent_id}/avatar
agents.listConfigFiles	GET /agents/{agent_id}/config-files
agents.getConfigFile	GET /agents/{agent_id}/config-files/{file_key}
agents.putConfigFile	PUT /agents/{agent_id}/config-files/{file_key}
agents.getJourney	GET /agents/{agent_id}/journey
agents.listPresets	GET /agents/{agent_id}/presets
agents.getPreset	GET /agents/{agent_id}/presets/{preset_id}
agents.deletePreset	DELETE /agents/{agent_id}/presets/{preset_id}
agents.activatePreset	POST /agents/{agent_id}/presets/{preset_id}/activate
devices.listRequests	GET /device-requests
devices.createRequest	POST /device-requests
devices.getRequest	GET /device-requests/{request_id}
devices.respondRequest	POST /device-requests/{request_id}/respond
devices.getRelay	GET /relay
devices.setRelay	PUT /relay
devices.listPeers	GET /peers
devices.requestPeer	POST /peers
devices.deletePeer	DELETE /peers/{peer_id}
devices.updatePeer	PATCH /peers/{peer_id}
devices.createPeerInvite	POST /peer-invites
```

ما ترميه الوحدات نفسها بـ`not_implemented` ليس فجوة في العقد: محوّل «الحزام» (`adapters/process.ts`) غير قابل للاختيار
أصلًا، و`respond()` في الوكيل المباشر لا يُستدعى لأنه بلا أدوات، و`target.sessionRef` في محوّل هرمز حارس داخلي،
و`audit.getReport` له منشئ لكل نوع فلا يصل إلى فرع ‎501‎.

**العدّ: ٢٠ عملية ‎501‎ — (أ) ٦، (ب) ٥، (ج) ٩.** ومعها ١٠ ملاحظات «لم يُبنَ» ليست عمليات ‎501‎ (أدناه).

#### (أ) يُبنى الآن
| البند | العمليات | لماذا الاتجاه محسوم |
|---|---|---|
| رحلة الوكيل (Journey) | `agents.getJourney` | هرمز يعلن القسم `journey` في الكتالوج، والعقد له مخطط `Journey`، وهرمز نفسه يبني «ما تعلّمه» رسمًا (`agent/learning_graph.py`، ويقدّمه خادمه `GET /api/learning/graph?profile=` — ADR 0015). يُقرأ من هرمز في البروفايل المختار كما تُقرأ الإضافات والاقتران. |
| طلبات قدرات الجهاز | `devices.listRequests`، `createRequest`، `getRequest`، `respondRequest` | DECISIONS §14 (مفتاح ثابت، مصافحة القدرات، الطلب «مهمة»، رموز أخطاء ثابتة، شكل نتيجة الموقع)، وأحداث `request.created` / `request.completed` معرّفة في العقد، وADR 0022 يقول إن خدمة مركز بعيد لجهاز الشخص تمر بهذه الطلبات «حين تبنيها وحدة الأجهزة». |
| صورة الوكيل | `agents.getAvatar` (ورفع `avatar` في `agents.update` الذي يرفضه الخادم اليوم بحجة أن المرفقات «المرحلة ٤») | المرحلة ٤ اكتملت، والنمط نفسه مبني للأشخاص والبروفايلات (`avatar_mime` وملف تحت `<DATA_DIR>/avatars/…`، `docs/domain/auth.md`). |

#### (ب) يحتاج قرار المالك
| البند | العمليات | السؤال |
|---|---|---|
| ملفات إعداد الوكيل | `agents.listConfigFiles`، `getConfigFile`، `putConfigFile` | العقد وضعها لشاشتين: إعدادات وكلاء البرمجة (مثل `~/.claude/CLAUDE.md` و`settings.json`) و«ملفات» البروفايل لهرمز. الثانية حلّ محلّها «الملفات» (DECISIONS §65) وصفحة إعدادات هرمز (§58). السؤال: هل تريد أن يحرّر المشرف ملفَّي وكيل البرمجة من الويب؟ وإن نعم: هذه الملفات في بيت مستخدم المركز **مشتركة بين كل البروفايلات** (وكلاء البرمجة لا يعرفون البروفايل) — أتقبل ذلك، أم تريد بيتًا لكل بروفايل؟ |
| مرحّل الرسائل (Relay) | `devices.getRelay`، `setRelay` | العقد يعرض مسارين: `official` (خدمة ترحيل رسمية) و`cloudflare`. لا توجد خدمة رسمية، والنشر اليوم خلف وكيل عكسي (`docs/DEPLOY.md`). هل تريد مرحّلًا أصلًا؟ وإن نعم: نفق Cloudflare بحسابك، أم خدمة نديرها؟ وإن لا: تنتقل العمليتان إلى (ج). |

#### (ج) مرشّح للحذف من العقد (لم يُحذف شيء)
| البند | العمليات | السبب |
|---|---|---|
| الإعدادات المسبقة (Presets) | `agents.listPresets`، `getPreset`، `deletePreset`، `activatePreset` | وُضعت لوكيل واحد (`dsh`، تعليق العقد «presets (dsh)») ليس في الكتالوج؛ لا وكيل يعلن القسم `presets`، ولا وجهة لها في `navigation.json`. تُحذف العمليات الأربع ومخطط `AgentPreset` وقيمة `presets` من `AgentSection` إن وافقت. |
| المراكز الأقران (Peers) | `devices.listPeers`، `requestPeer`، `updatePeer`، `deletePeer`، `createPeerInvite` | ربط مركز بمركز آخر جاء من تطبيقات قديمة؛ لا ADR ولا خارطة طريق تقول ماذا يفعل الربط بعد قيامه (مشاركة وكلاء؟ محادثات؟)، وهو سطح أمني كبير. إن أردته فهو (ب) بسؤال «ماذا يتشارك مركزان مربوطان؟». |

#### ملاحظات «لم يُبنَ» ليست ‎501‎
| الملاحظة (من STATUS) | التصنيف | التفصيل |
|---|---|---|
| مجموعة `usage` في أدوات المركز لوكلائه (MCP) | (أ) — لم تُبنَ الليلة | §67 رفضها «لأنه لا عملية تُربط بها بعد»؛ `audit.getUsage` موجودة الآن، وتُقرأ بصلاحيات صاحب التشغيل كبقية المجموعات. |
| مجموعة `devices` في أدوات MCP | (أ) بعد طلبات الأجهزة — لم تُبنَ الليلة | تُربط بـ`devices.createRequest`؛ الموافقة يعرضها الجهاز نفسه (§14). |
| مجموعة `browser` في أدوات MCP | (ب) | لا عملية في العقد؛ ولهرمز أدوات متصفح خاصة به. ماذا تعني «متصفح» هنا؟ |
| رسائل القنوات لا تستعمل أدوات المركز | (ب) | لا شخص يملك تشغيل رسالة وصلت من تيليجرام/واتساب، والأدوات تعمل «بصفة الشخص» (§67). من يُحسب صاحبها: مالك البروفايل؟ شخص مربوط بالمرسل؟ لا أحد؟ |
| المهمة لا تنتظر ما تعتمد عليه قبل البدء | (أ) — لم تُبنَ الليلة | STATUS نفسه يصف السلوك المطلوب؛ يبقى اختيار صغير: `auto_start` ينتظر حتى تصير كل الاعتمادات `done`، وبدء الشخص اليدوي لا يُمنع. |
| ntfy مرسلَ إشعارات احتياطيًا | (ب) | §66: «الخطوة التالية إن أراد المالك طريقًا لأندرويد بلا Google». |
| إنشاء بوت تيليجرام بالرمز (QR) | (ج) للملاحظة لا للعقد | استُبدل عمدًا بربط رمز BotFather (§64)؛ خدمة هرمز الخارجية غير مستعملة. الجملة في STATUS يمكن حذفها. |
| محوّل «الحزام» (PTY) | (ب) | ADR 0002 يعلنه، ولا وكيل في الكتالوج يحتاجه (كل وكلاء البرمجة يتكلمون ACP). يُبقى معلنًا أم يُطوى بقرار يحلّ محلّ جزء من ADR 0002؟ |
| الصوت في تطبيق سطح المكتب | (أ) — خارج نطاق الليلة | الويب له الصوت (§63)؛ صفحة سطح المكتب تقول «ليس بعد». تخص `apps/desktop`. |
| صفحة iOS تقول إن `rooms` ‏‎501‎ | قديم | `rooms` مبنية كلها (٢٨ من ٢٨)؛ النص في وصف تطبيق iOS في STATUS قديم. لا يُلمس `apps/ios` هنا. |

### ترتيب البناء
١) رحلة الوكيل (الأقرب إلى هرمز الحقيقي وأصغرها)، ٢) طلبات قدرات الجهاز، ٣) صورة الوكيل. بعدها أتوقف.

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
يُحدَّث مع كل مجموعة.

## الملفات والتأثير
يُحدَّث مع كل مجموعة.

## الفحوص (الأوامر ونواتجها الفعلية)
تُلصق مع كل مجموعة.

## المخاطر والرجوع
يُحدَّث مع كل مجموعة.

## التسليم والخطوة التالية
الجرد مكتوب؛ المجموعة الأولى قيد البناء.
