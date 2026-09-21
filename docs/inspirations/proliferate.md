# Proliferate

- المستودع: <https://github.com/proliferate-ai/proliferate>
- الرخصة: **AGPL-3.0** — تم التحقق من ملف `LICENSE` (نص GNU AGPL v3 الكامل) بتاريخ 2026-09-21. الشارة في README مطابقة. AGPL رخصة حقوق متروكة شبكية: أي كود منه يجعل خادمنا كله خاضعًا لها. لذلك **أفكار فقط**.

## ماذا يفعل (في خمسة أسطر)
1. «AI IDE» مفتوح المصدر: تطبيق سطح مكتب (Tauri/Rust) + control plane بلغة Python + runtime «AnyHarness» بلغة Rust، يشغّل Claude Code وCodex وOpenCode وCursor وGrok عبر harness أصلي لكل وكيل.
2. كل مهمة تحصل على **git worktree** معزول بفرعه وطرفيته ومحادثته وحالة مراجعته؛ وكلاء متوازون في مساحة واحدة.
3. **Subagents**: الوكيل ينشئ وكلاء أبناء في المساحة نفسها عبر MCP منتج (`proliferate_workspace`، 20 أداة)، بسقف 8 أبناء للأب، عمق واحد، واستيقاظ الأب مرة واحدة بالضبط عند اكتمال الابن.
4. **Workflows** (الجيل الثاني): تعريف محفوظ ومُتحقَّق منه يُجمَّد حرفيًا في «invocation» عند التشغيل، ثم run على الـ runtime كسلسلة خطية من عقد، كل عقدة جلسة عادية؛ أنواع العقد `agent` و`human_in_loop`.
5. تكاملات مشتركة (MCP، مهارات، Computer Use، Browser Use)، واستضافة ذاتية للـ control plane (Docker، AWS، K8s، معزول عن الإنترنت).

## الأفكار التي نتبنّاها
| الفكرة | الوحدة عندنا | كيف نطبّقها نحن |
|---|---|---|
| تعريف سير العمل يُجمَّد في «invocation» غير قابل للتغيير عند التشغيل (إعادة تشغيل مطابقة) | `schedules` (workflows) | كل run يحمل نسخة مجمّدة من التعريف والوسائط؛ تعديل التعريف لا يغيّر runs جارية |
| عقدة `human_in_loop` وحالة `awaiting_human` على مستوى العقدة والـ run | `schedules` (approvals inside runs) | يطابق «approvals inside runs» في ARCHITECTURE |
| مراجع بين العقد: `@input:name` و`@doc:slug` مع تحقق صارم بدل نص حر | `schedules` | مدخلات وقوالب مستندات جزء من مخطط العقد |
| أفعال على العقدة: `approve`, `fail-redo`, `undo-advance`, `resume`, `adhoc-nodes`, `cancel` | `schedules` | أفعال في العقد على `/api/v1/schedules/runs/{id}/nodes/{id}` |
| «الجلسة قبل الحوسبة»: سجل الـ run يوجد قبل أي بيئة، والوضع (placement) لاحق | `board` + `schedules` | يطابق الثابت 4 (HTTP يعيد job id فورًا) |
| غلاف ميزانية يُقلَّص فقط عند التفريع، سقف عمق، إلغاء الشجرة كاملة | `schedules` + `audit` | `parent_run_id`, `depth`, `budget` على الـ run |
| قوانين الوكلاء الأبناء: الابن جلسة عادية، العلاقة هي السلطة، سقف الأبناء يشمل المغلقين، الابن لا يفوّض | `sessions` + `rooms` | `session_links(relation=subagent)`؛ الاستيقاظ رسالة في نسخة الأب |
| مفردات «العمل المفوَّض»: `title` + `generatedName` + `shortId`، وحالات `needs_attention / failed / running / queued / finished / closed` | `sessions`/`rooms` (العقد) | أسماء ودّية مستقرة للوكلاء الأبناء في كل العملاء |
| أحداث run: `run.created/placed/status_changed/spawned_child/result_recorded/cancelled_tree` | `/rt/schedules` | صيغة `<entity>.<verb>` عندنا |

## الأفكار التي نرفضها ولماذا
- **نطاق IDE** (محرّر، طرفيات، Tauri): Majlis مركز لا IDE.
- **control plane سحابي بمؤسسات وفوترة**: خارج النطاق.
- **runtime خاص (AnyHarness)**: عندنا ACP + محوّل Hermes.
- **سلسلة خطية فقط**: نبقي DAG كما في ARCHITECTURE، مع تجميد التعريف كما فعلوا.
- **مواصفات «target» غير المنفّذة على `main`** (Runs): نُلهَم بها ولا نعتمد عليها.

## ما لا نأخذه تحت هذه الرخصة
AGPL-3.0: **صفر كود**، لا مخططات (`specs/areas/anyharness-db-schema.sql`)، لا fixtures/عقود JSON، لا ملفات OpenAPI/SDK مولَّدة، لا نصوص وثائق أو مواصفات (`specs/`, `guides/`)، لا نظام تصميم (`DESIGN_SYSTEM.md`)، لا أصول (`assets/`, أيقونات المزوّدين)، ولا اسم «Proliferate». الأيقونات المستوردة عندهم (Material Icon Theme، MIT) ليست منهم ولا نأخذها من هنا.

## روابط
- README عبر `gh api repos/proliferate-ai/proliferate/readme`.
- `specs/systems/subagents/README.md`, `specs/systems/subagents/delegated-work.md`, `specs/systems/automations/README.md`, `specs/systems/automations/runs.md`.
