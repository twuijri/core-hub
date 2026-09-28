/**
 * Reading a value out of a run, and asking a yes/no question about it.
 *
 * A workflow needs two small things that look like programming and must not become it:
 * `{{trigger.body.id}}` inside a prompt, and `amount > 100` on a branch. Both are done
 * here, and **neither evaluates code**. There is no `eval`, no `Function`, no template
 * engine: a path is split on dots and walked, and a condition is one comparison. A
 * webhook's payload is written by whoever calls the door, so anything that could run it
 * is a remote shell with extra steps.
 *
 * What a person can write is therefore small on purpose:
 *
 *   {{trigger.body.user.name}}        a path — objects and arrays, `0` indexes
 *   {{steps.classify.output}}          another step's result
 *   trigger.body.amount > 100          a comparison against a number
 *   trigger.body.kind == "invoice"     against a string
 *   trigger.body.items empty           against nothing at all
 *
 * Anything else is refused when the workflow is **saved**, not when it runs at 3 a.m.
 */

/** What a node can see: the trigger's payload and every finished step's output. */
export interface Context {
  trigger: unknown;
  steps: Record<string, { output: unknown }>;
  /** What a person typed when they ran it by hand — the contract's `{{input}}`. */
  input?: unknown;
}

/** Paths are bounded so a crafted payload cannot make the walk expensive. */
const MAX_DEPTH = 12;
const MAX_RENDERED = 64 * 1024;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

/**
 * Walk a dotted path. `undefined` for anything missing — a workflow that refers to a
 * field the payload did not carry is a workflow with a hole in it, and a hole reads as
 * empty rather than as a crash at the eleventh step.
 */
export function read(path: string, ctx: Context): unknown {
  if (!PATH.test(path)) return undefined;
  const parts = path.split('.');
  if (parts.length > MAX_DEPTH) return undefined;
  let value: unknown = ctx as unknown;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0) return undefined;
      value = value[index];
      continue;
    }
    if (typeof value !== 'object') return undefined;
    // Own properties only: `constructor`, `__proto__` and friends are not data.
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** How a value becomes text inside a prompt. Objects go in as JSON, which is what a
    model can read back; `undefined` becomes empty rather than the word "undefined". */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Substitute `{{path}}` in a template. Unknown paths become empty, and the result is
 * capped — a step must not be able to build a megabyte prompt out of a payload.
 */
export function render(template: string, ctx: Context): string {
  const out = template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, path: string) =>
    stringify(read(path, ctx)),
  );
  return out.length > MAX_RENDERED ? out.slice(0, MAX_RENDERED) : out;
}

/**
 * The paths of a template that read as nothing (`undefined`) in `ctx`, once each, in the
 * order they first appear. A run renders such a hole as empty; "Send test message" refuses
 * to send it (§124), so a test never delivers a literal `{{…}}` or a silent gap.
 */
export function unresolvedIn(template: string, ctx: Context): string[] {
  const out: string[] = [];
  for (const path of pathsIn(template)) {
    if (!out.includes(path) && read(path, ctx) === undefined) out.push(path);
  }
  return out;
}

/** Every path a template mentions, so a workflow can be checked before it is saved. */
export function pathsIn(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((match) => match[1] ?? '');
}

export const OPERATORS = [
  '==',
  '!=',
  '>=',
  '<=',
  '>',
  '<',
  'contains',
  'matches',
  'exists',
  'empty',
] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  path: string;
  operator: Operator;
  /** Absent for `exists` and `empty`. */
  value?: string | undefined;
}

export class ConditionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ConditionError';
  }
}

/**
 * Parse one comparison. Deliberately not a grammar: no `and`, no `or`, no parentheses.
 * Two conditions are two nodes, and a shape you can see beats a line you have to read.
 */
export function parseCondition(text: string): Condition {
  const trimmed = text.trim();
  if (trimmed === '') throw new ConditionError('condition_empty');
  // The unary ones first, so `x exists` is not read as a path called "x exists".
  for (const unary of ['exists', 'empty'] as const) {
    const suffix = ` ${unary}`;
    if (trimmed.endsWith(suffix)) {
      const path = trimmed.slice(0, -suffix.length).trim();
      if (!PATH.test(path)) throw new ConditionError('condition_path_invalid');
      return { path, operator: unary };
    }
  }
  // Longest operators first: `>=` must not be read as `>`.
  for (const operator of ['==', '!=', '>=', '<=', 'contains', 'matches', '>', '<'] as const) {
    const at = trimmed.indexOf(` ${operator} `);
    if (at === -1) continue;
    const path = trimmed.slice(0, at).trim();
    const raw = trimmed.slice(at + operator.length + 2).trim();
    if (!PATH.test(path)) throw new ConditionError('condition_path_invalid');
    if (raw === '') throw new ConditionError('condition_value_missing');
    // One comparison, so one value. Without this, `a > 1 and b < 2` parses as "compare
    // against the string `1 and b < 2`" — nonsense that answers false forever instead of
    // saying it was never understood.
    if (!isQuoted(raw) && /\s/.test(raw)) throw new ConditionError('condition_value_invalid');
    if (operator === 'matches') {
      try {
        new RegExp(unquote(raw));
      } catch {
        throw new ConditionError('condition_regex_invalid');
      }
    }
    return { path, operator, value: unquote(raw) };
  }
  throw new ConditionError('condition_operator_missing');
}

function isQuoted(raw: string): boolean {
  return /^".*"$/s.test(raw) || /^'.*'$/s.test(raw);
}

function unquote(raw: string): string {
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  return quoted ? (quoted[1] ?? '') : raw;
}

/** A value is "empty" when there is nothing to act on: absent, blank, `[]`, `{}`. */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Answer the question. A comparison against a number compares numbers **when both sides
 * are numbers**, and compares text otherwise — so `"10" > "9"` is not quietly false.
 */
export function evaluate(condition: Condition, ctx: Context): boolean {
  const actual = read(condition.path, ctx);
  switch (condition.operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'empty':
      return isEmpty(actual);
    case 'contains':
      return stringify(actual).includes(condition.value ?? '');
    case 'matches':
      // Bounded by the value being a saved pattern, not a payload's: the payload is the
      // subject, never the expression.
      return new RegExp(condition.value ?? '').test(stringify(actual));
    default:
      break;
  }
  const expected = condition.value ?? '';
  const left = Number(actual);
  const right = Number(expected);
  const numeric =
    actual !== null &&
    actual !== '' &&
    typeof actual !== 'boolean' &&
    Number.isFinite(left) &&
    Number.isFinite(right);
  switch (condition.operator) {
    case '==':
      return numeric ? left === right : stringify(actual) === expected;
    case '!=':
      return numeric ? left !== right : stringify(actual) !== expected;
    case '>':
      return numeric ? left > right : stringify(actual) > expected;
    case '>=':
      return numeric ? left >= right : stringify(actual) >= expected;
    case '<':
      return numeric ? left < right : stringify(actual) < expected;
    case '<=':
      return numeric ? left <= right : stringify(actual) <= expected;
  }
}

// ------------------------------------------------------------ several rules (§123)

/** A condition step's rules, as stored (`WorkflowRules`). */
export interface Rules {
  match: 'all' | 'any';
  items: Array<{ path: string; operator: string; value: string | null }>;
}

/** Whether a path is one `read` can walk. */
export function isPath(path: string): boolean {
  return PATH.test(path);
}

/** A step answers from its rules when it has at least one; otherwise from its `input`. */
export function hasRules(rules: Rules | null | undefined): rules is Rules {
  return !!rules && Array.isArray(rules.items) && rules.items.length > 0;
}

const UNARY = new Set<string>(['exists', 'empty']);

/**
 * What is wrong with one rule, as a reason code (`rule_path_invalid`, `rule_operator_invalid`,
 * `rule_value_missing`, `rule_regex_invalid`), or `null` when it can be answered.
 */
export function ruleProblem(rule: {
  path: string;
  operator: string;
  value: string | null;
}): string | null {
  if (typeof rule.path !== 'string' || !PATH.test(rule.path.trim())) return 'rule_path_invalid';
  if (!(OPERATORS as readonly string[]).includes(rule.operator)) return 'rule_operator_invalid';
  if (!UNARY.has(rule.operator) && (rule.value === null || rule.value === undefined)) {
    return 'rule_value_missing';
  }
  if (rule.operator === 'matches') {
    try {
      new RegExp(rule.value ?? '');
    } catch {
      return 'rule_regex_invalid';
    }
  }
  return null;
}

/** Every rule held (`all`), or one did (`any`). A rule that cannot be answered is an error. */
export function evaluateRules(rules: Rules, ctx: Context): boolean {
  const answers = rules.items.map((rule) => {
    const reason = ruleProblem(rule);
    if (reason) throw new ConditionError(reason);
    return evaluate(
      {
        path: rule.path.trim(),
        operator: rule.operator as Operator,
        value: UNARY.has(rule.operator) ? undefined : (rule.value ?? ''),
      },
      ctx,
    );
  });
  return rules.match === 'any' ? answers.some(Boolean) : answers.every(Boolean);
}

/** The rules in words, for the step's record: `all: trigger.event == "taskCreated"; …`. */
export function rulesText(rules: Rules): string {
  const lines = rules.items.map((rule) =>
    UNARY.has(rule.operator)
      ? `${rule.path} ${rule.operator}`
      : `${rule.path} ${rule.operator} ${JSON.stringify(rule.value ?? '')}`,
  );
  return `${rules.match}: ${lines.join('; ')}`;
}
