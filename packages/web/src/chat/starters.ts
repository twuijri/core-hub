/**
 * Three things worth doing, under the composer of an empty chat (ADOPTION-BACKLOG 2.10).
 *
 * They are written in both languages here rather than in the locale files because they are
 * seed *content* — a sentence a person sends to an agent — not interface text, and the i18n
 * parity check would otherwise treat a reworded suggestion as a missing translation. They
 * read as work, not decoration: each one starts a real first turn.
 */
import type { Language } from '../i18n/index.js';

const SUGGESTIONS: Record<Language, readonly string[]> = {
  ar: [
    'اشرح لي بنية هذا المشروع وأين أبدأ',
    'اقرأ الملفات في مجلد العمل ولخّص ما تجده',
    'اكتب اختبارًا يفشل للسلوك الذي أصفه لك',
  ],
  en: [
    'Explain this project’s structure and where to start',
    'Read the files in the working folder and summarise them',
    'Write a failing test for the behaviour I describe',
  ],
};

export function starterSuggestions(language: Language): readonly string[] {
  return SUGGESTIONS[language] ?? SUGGESTIONS.en;
}
