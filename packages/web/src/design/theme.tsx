// The person's display preferences — theme, glass intensity, UI language, text scale — kept
// locally (they must apply before sign-in) and mirrored to `auth.setPreferences` once signed
// in (theme, locale, text_scale exist in the contract; the glass level does not, so it stays
// local). Writes land on <html> as data-theme / data-glass / dir / lang / --mj-text-scale;
// the generated tokens.css reacts to those.
import { derived } from '@majlis/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_GLASS, type GlassLevel } from '@majlis/ui-tokens';
import { browserLanguage, directionOf, isLanguage, type Language } from '../i18n/index.js';
import { IconDisplay, IconMoon, IconSun } from '../ui/icons.js';

export type ThemeChoice = 'system' | 'light' | 'dark';
// Light, dark, then "follow the system" — the order every desktop shows them in, and the
// order their three symbols read in: sun, moon, screen.
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

/**
 * The next theme in the cycle: light → dark → system → light.
 *
 * The order is the one a person reaches for — the two they choose between first, and the
 * one that hands the choice back to the machine last.
 */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  const at = THEME_CHOICES.indexOf(choice);
  return THEME_CHOICES[(at + 1) % THEME_CHOICES.length] ?? 'light';
}

/** The symbol for a theme choice. One drawing, so the footer and the Display page agree. */
export function themeIcon(choice: ThemeChoice, size = 14) {
  const Icon = choice === 'light' ? IconSun : choice === 'dark' ? IconMoon : IconDisplay;
  return <Icon size={size} />;
}
export const GLASS_CHOICES: readonly GlassLevel[] = ['0', '1', '2', '3'];
export const TEXT_SCALES: readonly number[] = [0.9, 1, 1.1, 1.25];

export interface DisplayPrefs {
  theme: ThemeChoice;
  glass: GlassLevel;
  language: Language;
  textScale: number;
}

const STORAGE_KEY = `${derived.storagePrefix}display`;

export function readStoredPrefs(storage: Pick<Storage, 'getItem'> | null): DisplayPrefs {
  const fallback: DisplayPrefs = {
    theme: 'system',
    glass: DEFAULT_GLASS,
    language: typeof navigator === 'undefined' ? 'ar' : browserLanguage(),
    textScale: 1,
  };
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DisplayPrefs>;
    return {
      theme: THEME_CHOICES.includes(parsed.theme as ThemeChoice)
        ? (parsed.theme as ThemeChoice)
        : fallback.theme,
      glass: GLASS_CHOICES.includes(parsed.glass as GlassLevel)
        ? (parsed.glass as GlassLevel)
        : fallback.glass,
      language: isLanguage(parsed.language) ? parsed.language : fallback.language,
      textScale:
        typeof parsed.textScale === 'number' && parsed.textScale >= 0.85 && parsed.textScale <= 1.45
          ? parsed.textScale
          : fallback.textScale,
    };
  } catch {
    return fallback;
  }
}

/** Paints the preferences on the document root. Exported so tests can call it directly. */
export function applyPrefs(
  prefs: DisplayPrefs,
  root: HTMLElement = document.documentElement,
): void {
  if (prefs.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.theme);
  root.setAttribute('data-glass', prefs.glass);
  root.setAttribute('lang', prefs.language);
  root.setAttribute('dir', directionOf(prefs.language));
  root.style.setProperty('--mj-text-scale', String(prefs.textScale));
}

interface ThemeValue {
  prefs: DisplayPrefs;
  update(patch: Partial<DisplayPrefs>): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: Partial<DisplayPrefs>;
}) {
  const [prefs, setPrefs] = useState<DisplayPrefs>(() => ({
    ...readStoredPrefs(typeof localStorage === 'undefined' ? null : localStorage),
    ...initial,
  }));
  useEffect(() => {
    applyPrefs(prefs);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Private mode or a full store: the preference still applies for this page.
    }
  }, [prefs]);
  const update = useCallback((patch: Partial<DisplayPrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
  }, []);
  const value = useMemo(() => ({ prefs, update }), [prefs, update]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme outside ThemeProvider');
  return value;
}
