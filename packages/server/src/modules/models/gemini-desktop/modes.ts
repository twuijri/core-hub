/**
 * The modes a Gemini Desktop account offers (`RobinService.GetUserStatus`, DECISIONS §155), and
 * the hub's model ids for them.
 *
 * The answer's mode policy (field 34 → repeated 2 → 1) is authoritative, disabled modes included;
 * the older list (repeated field 17) is read only when there is no policy, and never brings back a
 * mode the policy disabled. Read as the owner's plugin reads it (`models.go`, MIT).
 */
import { parseWire, type WireField } from './protobuf.js';

export const GEMINI_DESKTOP_AUTO = 'gemini-desktop-auto';
const PREFIX = 'gemini-desktop-';
const MAX_MODES = 64;

/** One mode of an account: the title its picker shows and what selects it. */
export interface NativeMode {
  /** `titleForPicker` (14), else the short title (6); the legacy list's title (19). */
  title: string;
  category: number;
  variantId: string | null;
  configId: string | null;
}

function cleanText(value: string, limit: number, required: boolean): boolean {
  if (value.length > limit || (required && value.trim() === '')) return false;
  // Control and format characters never belong in a title the picker shows.
  return !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validMode(mode: NativeMode): boolean {
  return (
    Number.isInteger(mode.category) &&
    mode.category > 0 &&
    mode.category <= 2_147_483_647 &&
    cleanText(mode.title, 128, true) &&
    cleanText(mode.variantId ?? '', 256, false) &&
    cleanText(mode.configId ?? '', 128, false)
  );
}

function readMode(data: Buffer, modern: boolean): { mode: NativeMode; disabled: boolean } {
  const [categoryField, titleField, fallbackField] = modern ? [3, 14, 6] : [23, 19, 2];
  const mode: NativeMode = { title: '', category: 0, variantId: null, configId: null };
  let fallback = '';
  let disabled = false;
  const text = (item: WireField) => {
    if (item.kind !== 2) throw new Error('invalid mode text');
    return item.bytes.toString('utf8');
  };
  for (const item of parseWire(data)) {
    if (item.field === 1) mode.configId = text(item) || null;
    else if (item.field === categoryField) {
      if (item.kind !== 0 || item.int > 2_147_483_647n) throw new Error('invalid mode category');
      mode.category = Number(item.int);
    } else if (item.field === titleField) mode.title = text(item);
    else if (item.field === fallbackField) fallback = text(item);
    else if (modern && item.field === 4) {
      if (item.kind !== 0) throw new Error('invalid disabled flag');
      disabled = item.int !== 0n;
    } else if (modern && item.field === 5) mode.variantId = text(item) || null;
  }
  if (!mode.title) mode.title = fallback;
  if (!validMode(mode)) throw new Error('invalid native mode');
  return { mode, disabled };
}

/** The account's enabled modes. Throws on an answer that is not the status message. */
export function parseUserStatus(answer: Buffer): NativeMode[] {
  const legacy: NativeMode[] = [];
  const policies: Buffer[] = [];
  for (const item of parseWire(answer)) {
    if (item.field === 17) {
      if (item.kind !== 2) throw new Error('invalid legacy mode field');
      legacy.push(readMode(item.bytes, false).mode);
    } else if (item.field === 34) {
      if (item.kind !== 2) throw new Error('invalid mode policy field');
      policies.push(item.bytes);
    }
  }
  let modes: NativeMode[] = [];
  if (policies.length > 0) {
    for (const policy of policies) {
      for (const group of parseWire(policy)) {
        if (group.field !== 2) continue;
        if (group.kind !== 2) throw new Error('invalid policy config');
        for (const entry of parseWire(group.bytes)) {
          if (entry.field !== 1) continue;
          if (entry.kind !== 2) throw new Error('invalid policy mode');
          const { mode, disabled } = readMode(entry.bytes, true);
          if (disabled) continue;
          if (!mode.configId) {
            mode.configId = legacy.find((old) => old.category === mode.category)?.configId ?? null;
          }
          modes.push(mode);
        }
      }
    }
  } else {
    modes = legacy;
  }
  const out: NativeMode[] = [];
  const seen = new Set<string>();
  const ids = new Map<string, string>();
  for (const mode of modes) {
    const key = `${mode.category}:${mode.variantId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = modeModelId(mode);
    const before = ids.get(id);
    // Two different selections under one name: the name could not say which one is meant.
    if (before !== undefined && before !== key) throw new Error('ambiguous native mode name');
    ids.set(id, key);
    out.push(mode);
    if (out.length > MAX_MODES) throw new Error('too many native modes');
  }
  return out;
}

/**
 * The hub's id for a mode: `gemini-desktop-` and its title, lowercased, letters and digits kept,
 * a dot kept between two digits («3.5 Flash-Lite» → `gemini-desktop-3.5-flash-lite`). These are
 * the provider's own local names, not Gemini API model ids.
 */
export function modeModelId(mode: Pick<NativeMode, 'title' | 'category'>): string {
  const chars = [...mode.title.toLowerCase()];
  let out = '';
  let separator = false;
  chars.forEach((char, i) => {
    const decimalDot =
      char === '.' && i > 0 && /\p{Nd}/u.test(chars[i - 1]!) && /\p{Nd}/u.test(chars[i + 1] ?? '');
    if (/[\p{L}\p{Nd}]/u.test(char) || decimalDot) {
      if (separator && out) out += '-';
      out += char;
      separator = false;
    } else {
      separator = true;
    }
  });
  return out ? `${PREFIX}${out}` : `${PREFIX}mode-${mode.category}`;
}

/** The label the picker shows for a mode. */
export function modeLabel(mode: Pick<NativeMode, 'title'>): string {
  return `Gemini ${mode.title}`;
}

/** The mode an account has under a model id, or null (an unknown name is never `auto`). */
export function modeOf(modes: readonly NativeMode[], modelId: string): NativeMode | null {
  return modes.find((mode) => modeModelId(mode) === modelId) ?? null;
}
