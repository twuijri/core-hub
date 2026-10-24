# Gemini Desktop — من إضافة المالك لـ CLIProxyAPI

- المصدر: إضافة **Gemini Desktop** في مستودع المالك
  [twuijri/cpa-plugin-api-key-manager](https://github.com/twuijri/cpa-plugin-api-key-manager)،
  المجلد `plugins/gemini-desktop`، الإصدار `0.2.0-preview` (Go). المالك نفسه بناها وجرّبها على
  خادمه.
- الرخصة: **MIT** (ملف `LICENSE` في المجلد نفسه، «Gemini Desktop plugin contributors»)، وجسر الـ C ABI
  فيها مشتق من router-for-me/cpa-plugin-gemini-cli (MIT) ولم نأخذه.
- ما أخذناه: حقائق البروتوكول — عميل OAuth الخاص بتطبيق Gemini للكمبيوتر ونطاقاته، اسما الطريقتين
  `ProcessQuery` و`GetUserStatus`، وأرقام حقول protobuf وامتداداته، وطريقة قراءة أوضاع الحساب
  وتسميتها. كتبناها من جديد بـ TypeScript في `packages/server/src/modules/models/gemini-desktop/`؛ لم
  يُنسخ ملف منها. الإسناد وإشعار الرخصة في `THIRD-PARTY-NOTICES.md`.
- ما فعلناه مختلفًا: الإضافة تفتح محادثة جديدة في سجل Gemini لكل رسالة (تجمع المحادثة كلها في نص
  واحد). كور هب يُبقي كل محادثة عنده محادثة واحدة في Gemini، بحقل اكتُشف على حساب حي
  (`docs/research/gemini-desktop-2026-10.md`)، ويحفظ الحسابات في مخزنه المشفّر لا في ملفات. القرار:
  DECISIONS §155.
