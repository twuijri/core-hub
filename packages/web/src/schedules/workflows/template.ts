/**
 * The variables of a step's words (`{{input}}`, `{{trigger.*}}`, `{{steps.<id>.output}}`), read
 * the way the hub reads them (`packages/server/src/modules/schedules/expr.ts`, `pathsIn`): the
 * same pattern, so the web never names a variable the hub would not, or misses one.
 *
 * The hub still renders the test itself; this only says which values to ask for and shows the
 * preview of what will be sent (DECISIONS §124).
 */
const VARIABLE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Every variable of `text`, once each, in the order they first appear. */
export function variablesIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const path = match[1] ?? '';
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** The variables of `text` that have no value in `values` (an empty one counts as none). */
export function missingIn(text: string, values: Readonly<Record<string, string>>): string[] {
  return variablesIn(text).filter((path) => !values[path]);
}

/** `text` with each variable that has a value put in; one without stays as `{{path}}`. */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(VARIABLE, (whole, path: string) => (values[path] ? values[path] : whole));
}

/** Only the values that are filled, for the request. */
export function filledValues(
  text: string,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of variablesIn(text)) if (values[path]) out[path] = values[path];
  return out;
}
