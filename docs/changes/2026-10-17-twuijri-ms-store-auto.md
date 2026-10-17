# رفع كل إصدار إلى متجر مايكروسوفت تلقائيًا
المسؤول: twuijri · الفرع: feat/ms-store-auto · الحالة: review

## المشكلة والهدف
ملف `.msix` يُبنى ويُرفق بكل إصدار على GitHub، لكن إرساله إلى Partner Center كان يدويًا (`docs/RELEASING.md` كان يقول «حتى يقرر المالك يبقى الرفع يدويًا»). قرار المالك الدائم (٢٠٢٦-١٠-٠٥): كل إصدار يذهب إلى كل المتاجر معًا بلا خطوة بشرية. الهدف: بعد نشر إصدار `v*` يُرسَل `Core-Hub-X.Y.Z-x64.msix` كإرسال (submission) جديد للمنتج `9MT62R5V3P5N` ويُعتمد للفحص (certification) وحده.

## القرار والموافقات
- أداة مايكروسوفت الرسمية: Microsoft Store Developer CLI (`msstore` الإصدار v0.4.3) يثبّتها إجراء مايكروسوفت `microsoft/microsoft-store-apppublisher` v1.4 مثبّتًا بالـ commit `cc9910a8d59f2eb55cbb83df0a3800cf3b5300e0`.
- سير عمل جديد `ms-store-publish.yml` (`workflow_call` + `workflow_dispatch` بمدخل `tag`، الفارغ = آخر إصدار)، ووظيفة `ms-store` في آخر `publish-release.yml` بعد وظيفة `publish` (إصدار يصنعه `GITHUB_TOKEN` لا يطلق حدث `release`). صلاحياته `contents: read` فقط، ولا يُمرَّر له إلا السر الذي يستعمله (درس PR #234: المستدعى لا يطلب أكثر مما يعطيه المستدعي).
- مشغّل Windows: `msstore` يحفظ بيانات الدخول في Credential Manager، وعلى Linux يحتاج keyring غير موجود في المشغّل (قرأت `CredentialManagerUnix.cs` في مصدر الأداة).
- الخطوات: تحميل الـ msix بـ `gh release download` ← `msstore reconfigure` بالقيم الأربع ثم إيقاف التتبع ← فحص الإرسال المعلّق ← `msstore publish … --noCommit --priceId Free` ← «ما الجديد» ← `msstore submission publish` ثم الانتظار حتى يخرج من `CommitStarted`.
- إرسال قيد المعالجة عند مايكروسوفت (`CommitStarted`/`PreProcessing`/`Certification`/`Release`/`PendingPublication`/`Publishing`): خطأ واضح باسم الإرسال وحالته ورابطه، ولا يُرسل شيء (Partner Center يقبل إرسالًا واحدًا في كل مرة؛ الأداة كانت ستحاول حذفه وتفشل بغموض). مسودة غير مكتملة أو إرسال فاشل: تحذير ثم تستبدله الأداة (سلوكها الموثّق).
- `--priceId Free`: المنتج مجاني أصلًا، وبدونه ترفض الأداة منتجًا تسعيره لكل سوق. متغير اختياري `MS_STORE_PRICE_ID` يغيّره.
- «ما الجديد»: ملاحظات Google Play للوسم نفسه (`apps/android/fastlane/metadata/android/{en-US,ar}/changelogs/default.txt`) إن كان سطرها الأول يذكر رقم النسخة، وإلا سطر واحد يشير لصفحة الإصدار على GitHub؛ عربي للقائمة العربية وإنجليزي لغيرها، بطريقة مايكروسوفت الموثّقة (`submission get` ثم `submission update --payload`). إن فشل: تحذير، ويكمل الإرسال بالنص السابق.
- بيانات الدخول ناقصة: إشعار «Microsoft Store skipped» بما ينقص، وتنتهي الوظيفة خضراء (الإصدار نفسه منشور قبلها).

## العقد (ما تغيّر في packages/contracts، أو «لا شيء»)
لا شيء.

## الملفات والتأثير
- `.github/workflows/ms-store-publish.yml` (جديد)
- `.github/workflows/publish-release.yml` (وظيفة `ms-store` بعد `publish`، وتعليق الرأس)
- `docs/RELEASING.md` (المقدمة، «The GitHub release»، قسم جديد «Automatic submission» بطريقة إنشاء بيانات الدخول وإعادة التشغيل)
- `docs/STATUS.md` (سطر «الرفع إلى المتجر يدوي»)
- لا يمس الإصدار نفسه: وظيفة مستقلة بعد نشره، وفشلها لا يلغيه.

ما يضيفه المالك في GitHub → Settings → Secrets and variables → Actions:
- متغيرات: `MS_STORE_TENANT_ID`، `MS_STORE_SELLER_ID`، `MS_STORE_CLIENT_ID` (و`MS_STORE_PRICE_ID` اختياري)
- سر: `MS_STORE_CLIENT_SECRET`

## الفحوص (الأوامر ونواتجها الفعلية)
```
$ ~/.cache/actionlint-1.7.12/actionlint --version
1.7.12
$ PATH=~/.cache/shellcheck-v0.11.0:$PATH ~/.cache/actionlint-1.7.12/actionlint .github/workflows/ms-store-publish.yml
(لا شيء) exit 0
$ PATH=~/.cache/shellcheck-v0.11.0:$PATH ~/.cache/actionlint-1.7.12/actionlint .github/workflows/publish-release.yml
3 ملاحظات shellcheck (SC2012، SC2086 ×2) في خطوات publish الموجودة أصلًا؛ نفس الثلاث على main قبل التغيير، ولا شيء في الوظيفة الجديدة
$ prettier --check .github/workflows/ms-store-publish.yml .github/workflows/publish-release.yml
All matched files use Prettier code style!
$ (خطوة فحص بيانات الدخول، بقيمة واحدة من أربع)
::notice title=Microsoft Store skipped::Not set: variable MS_STORE_SELLER_ID, variable MS_STORE_CLIENT_ID, secret MS_STORE_CLIENT_SECRET (Settings → Secrets and variables → Actions). ...
ready=false
$ (بالأربع)
ready=true
$ (اختيار الملاحظات على الوسوم الحقيقية: ملف v1.1.8 ما زال «أول إصدار لكور هب في Google Play.»)
v1.1.8: fallback
v1.1.7: fallback
$ (تحويل jq على مثال إرسال: en-us وar وقائمة بلا BaseListing)
{"Pricing":{"PriceId":"Free"},"Listings":{"en-us":{"BaseListing":{"ReleaseNotes":"Core Hub 1.1.9\n\n• a"}},"ar":{"BaseListing":{"ReleaseNotes":"كور هب 1.1.9"}},"fr-fr":{"Platform":null}}}
$ node scripts/check-change-record.mjs --base origin/main
(ناتجه في الأسفل بعد الالتزام)
```

## المخاطر والرجوع
- لم يُشغَّل على Partner Center: ينتظر بيانات الدخول. أول تشغيل حقيقي هو الدليل.
- مايكروسوفت: الأداة تحدّث فقط تطبيقًا نُشر إرساله الأول من Partner Center، ومجانيًا فقط. إن لم يُنشر الإرسال الأول بعد يتوقف الفحص بخطأ «قيد المعالجة».
- `--priceId Free` يضع سعرًا أساسيًا واحدًا بدل أسعار الأسواق؛ صحيح ما دام المنتج مجانيًا.
- حالة `PendingCommit` قد تكون مسودة عدّلها المالك يدويًا في Partner Center: تُستبدل مع تحذير.
- سر العميل في Entra له تاريخ انتهاء؛ عند انتهائه تفشل خطوة الدخول برسالة الأداة.
- الرجوع: حذف وظيفة `ms-store` من `publish-release.yml` (أو حذف السر) يعيد الرفع اليدوي.

## التسليم والخطوة التالية
طلب دمج إلى `main`. بعد الدمج: يضيف المالك المتغيرات الثلاثة والسر، ثم يشغّل Actions → Microsoft Store publish على آخر إصدار (أو ينتظر الإصدار القادم) ويتأكد من الإرسال في Partner Center.
