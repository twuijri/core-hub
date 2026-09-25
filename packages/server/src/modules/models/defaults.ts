/**
 * The workspace's model assignments.
 *
 * The contract splits them in two: `ModelDefaults.default` (the model a chat uses when
 * nothing else was chosen) and `auxiliary.assignments` (the smaller jobs the hub does for
 * itself). The database stores both as `model_defaults` rows keyed by role, so "which
 * model writes titles" is one row and not a JSON blob nobody can index.
 *
 * `coding` is an auxiliary role on purpose: the owner picks one chat model and one coding
 * model, and a coding agent inherits the coding one (ADR 0010 §Which default an agent
 * inherits) without anybody opening that agent's settings.
 */
import type { ModelRole } from './schema.js';

export interface AuxiliaryTask {
  key: Exclude<ModelRole, 'chat' | 'image'>;
  label: { ar: string; en: string };
}

/**
 * The auxiliary roles, in the order the screen shows them. `key` is what the contract's
 * `ModelDefaults.auxiliary.assignments` is keyed by, so it is part of the API: adding one
 * is a contract-visible change, which is why the list lives in one reviewed place.
 */
export const AUXILIARY_TASKS: readonly AuxiliaryTask[] = [
  {
    key: 'coding',
    label: { ar: 'وكلاء البرمجة', en: 'Coding agents' },
  },
  {
    key: 'title',
    label: { ar: 'توليد العناوين', en: 'Title generation' },
  },
  {
    key: 'summary',
    label: { ar: 'التلخيص', en: 'Summarization' },
  },
  {
    key: 'embedding',
    label: { ar: 'التضمين', en: 'Embeddings' },
  },
];

export const AUXILIARY_KEYS: readonly string[] = AUXILIARY_TASKS.map((task) => task.key);

export function isAuxiliaryKey(value: string): value is AuxiliaryTask['key'] {
  return AUXILIARY_KEYS.includes(value);
}

/**
 * Which assignment an agent inherits when nobody pinned a model to it.
 *
 * Hermes is the conversational runtime the hub is built around (ADR 0006), so it takes
 * the workspace's chat default; everything else in the registry is a coding CLI and takes
 * the coding assignment, falling back to chat when the owner set only one.
 */
export function roleForAdapter(adapterKind: string): ModelRole {
  return adapterKind === 'hermes' ? 'chat' : 'coding';
}
