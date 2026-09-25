/**
 * Which skill a finished tool call loaded, if any (contract decision §50).
 *
 * Read from Hermes's MIT source (tag v2026.9.14): the model loads a skill through the
 * `skill_view` tool, whose arguments are `name` (the skill, `plugin:skill` for a plugin's) and
 * an optional `file_path` for one of the skill's linked files. Hermes itself counts a
 * successful `skill_view` as the skill being used (`tools/skills_tool.py`, `bump_use`), and the
 * TUI gateway sends the arguments with `tool.start` and again with `tool.complete`.
 *
 * - Only a **completed** call counts: a failed one (an unknown skill) loaded nothing.
 * - Opening a linked file (`file_path`) is the same use as the skill it belongs to; the
 *   ledger keeps one use per run and skill, so it is not counted twice.
 * - `skill_manage` edits a skill, it does not use one, and is not counted.
 * - Coding agents over ACP name their tool calls by title and kind only; no argument says
 *   which skill was loaded, so their skill use is not counted.
 */
import type { ToolCallState } from './run-reducer.js';

export const SKILL_LOAD_TOOL = 'skill_view';

export function skillUseOf(call: Pick<ToolCallState, 'name' | 'input' | 'status'>): string | null {
  if (call.name !== SKILL_LOAD_TOOL || call.status !== 'succeeded') return null;
  const name = call.input?.name;
  if (typeof name !== 'string') return null;
  const skill = name.trim();
  return skill === '' ? null : skill.slice(0, 200);
}
