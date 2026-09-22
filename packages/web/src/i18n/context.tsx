import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { UiDirection } from '../ui/Direction.js';
import { createTranslator, directionOf, type Language, type Translator } from './index.js';

interface I18nValue {
  language: Language;
  t: Translator;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * The UI language, and with it the direction every primitive reads: a menu's arrow keys, a
 * select's popup side and a popover's alignment all flip with it. The primitives do not
 * look at `<html dir>`, so the direction is published here through `src/ui/Direction.tsx`,
 * next to the language that decides it (DESIGN §Language).
 */
export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18nValue>(() => ({ language, t: createTranslator(language) }), [language]);
  return (
    <I18nContext.Provider value={value}>
      <UiDirection dir={directionOf(language)}>{children}</UiDirection>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}

export function useT(): Translator {
  return useI18n().t;
}
