import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createTranslator, type Language, type Translator } from './index.js';

interface I18nValue {
  language: Language;
  t: Translator;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18nValue>(() => ({ language, t: createTranslator(language) }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}

export function useT(): Translator {
  return useI18n().t;
}
