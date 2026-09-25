/**
 * The composer's `/` commands (decision §52): what each one is, when it is offered, and how
 * the text in the composer is read as one.
 *
 * Three kinds, by who carries the command out:
 *
 * - `hub`: this client, with operations it already had — a new chat, a fork, archiving,
 *   the model picker, clearing the screen. Every agent gets them.
 * - `action`: the hub asks the agent through an operation of its own — `sessions.compress`,
 *   `sessions.steerRun`. Offered only when the agent has the capability.
 * - `message`: sent as the message it is; the agent reads the command word itself
 *   (`/goal`, `/plan`, `/learn`, `/skill <name>`). Offered only with the capability.
 *
 * Anything else that starts with `/` is an ordinary message, sent as typed.
 */
export type SlashCommandId =
  | 'compress'
  | 'steer'
  | 'goal'
  | 'plan'
  | 'learn'
  | 'skill'
  | 'new'
  | 'fork'
  | 'archive'
  | 'model'
  | 'clear-screen';

export interface SlashCommand {
  id: SlashCommandId;
  /** The word after `/`. */
  name: string;
  kind: 'hub' | 'action' | 'message';
  /** The agent capability that must be present; `null` = every agent. */
  capability: string | null;
  /** `none`: runs as soon as it is picked. `optional` / `required`: waits for words after it. */
  argument: 'none' | 'optional' | 'required';
}

/** In the order the menu lists them: the agent's own first, then the hub's. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'compress',
    name: 'compress',
    kind: 'action',
    capability: 'compress',
    argument: 'optional',
  },
  { id: 'steer', name: 'steer', kind: 'action', capability: 'steer', argument: 'required' },
  {
    id: 'skill',
    name: 'skill',
    kind: 'message',
    capability: 'skill_commands',
    argument: 'required',
  },
  { id: 'plan', name: 'plan', kind: 'message', capability: 'plans', argument: 'required' },
  { id: 'goal', name: 'goal', kind: 'message', capability: 'goals', argument: 'optional' },
  { id: 'learn', name: 'learn', kind: 'message', capability: 'learn', argument: 'optional' },
  { id: 'new', name: 'new', kind: 'hub', capability: null, argument: 'none' },
  { id: 'fork', name: 'fork', kind: 'hub', capability: null, argument: 'none' },
  { id: 'archive', name: 'archive', kind: 'hub', capability: null, argument: 'none' },
  { id: 'model', name: 'model', kind: 'hub', capability: null, argument: 'optional' },
  { id: 'clear-screen', name: 'clear-screen', kind: 'hub', capability: null, argument: 'none' },
];

/** The commands this agent can be given; an agent without a capability never sees its command. */
export function availableCommands(
  capabilities: readonly string[] | null | undefined,
): SlashCommand[] {
  const has = new Set(capabilities ?? []);
  return SLASH_COMMANDS.filter(
    (command) => command.capability === null || has.has(command.capability),
  );
}

/**
 * The word being typed after `/`, while the composer holds nothing else: `/com` → `com`,
 * `/` → ``. `null` once there is a space (the command is chosen) or no leading `/`.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(text);
  return match ? (match[1] ?? '') : null;
}

/** `/skill rev` → `rev` while the skill's name is being typed; `null` otherwise. */
export function skillQuery(text: string): string | null {
  const match = /^\/skill[ \t]+(\S*)$/.exec(text);
  return match ? (match[1] ?? '') : null;
}

/**
 * The commands matching what was typed: names that start with it first, then names or
 * descriptions that contain it, each group in menu order. Case and direction do not matter.
 */
export function filterCommands<T extends { name: string }>(
  items: readonly T[],
  query: string,
  describe: (item: T) => string = () => '',
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...items];
  const starts = items.filter((item) => item.name.toLowerCase().startsWith(q));
  const contains = items.filter(
    (item) =>
      !starts.includes(item) &&
      (item.name.toLowerCase().includes(q) || describe(item).toLowerCase().includes(q)),
  );
  return [...starts, ...contains];
}

/**
 * The command a finished message is, among those offered: `/compress the API` →
 * `{compress, 'the API'}`. `null` for anything else, which is then sent as typed.
 */
export function parseCommand(
  text: string,
  offered: readonly SlashCommand[],
): { command: SlashCommand; arg: string } | null {
  const match = /^\/([a-z-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const command = offered.find((candidate) => candidate.name === match[1]);
  if (!command) return null;
  return { command, arg: (match[2] ?? '').trim() };
}

/** The next index in a list of `length`, wrapping at both ends (arrow keys in the menu). */
export function moveActive(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}
