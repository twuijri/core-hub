// Display: theme, glass intensity, UI language and text size. Local first (they must work
// before sign-in), mirrored to `auth.setPreferences` for the fields the contract knows.
import { usePreferences, useSavePreferences } from '../hub/queries.js';
import { describeError } from '../auth/client.js';
import {
  GLASS_CHOICES,
  TEXT_SCALES,
  THEME_CHOICES,
  useTheme,
  type DisplayPrefs,
} from '../design/theme.js';
import { useI18n } from '../i18n/context.js';
import { LANGUAGES } from '../i18n/index.js';
import { Notice } from '../ui/Notice.js';

export function DisplayTab({ only }: { only?: Array<keyof DisplayPrefs> }) {
  const { t } = useI18n();
  const { prefs, update } = useTheme();
  const preferences = usePreferences();
  const save = useSavePreferences();
  const show = (key: keyof DisplayPrefs) => !only || only.includes(key);

  const change = (patch: Partial<DisplayPrefs>) => {
    update(patch);
    const server = preferences.data;
    if (!server) return;
    const next = { ...prefs, ...patch };
    save.mutate({
      ...server,
      theme: next.theme,
      locale: next.language,
      text_scale: next.textScale,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {show('theme') && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('display.theme.label')}</legend>
          <div
            className="segmented self-start"
            role="radiogroup"
            aria-label={t('display.theme.label')}
          >
            {THEME_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={prefs.theme === choice}
                aria-pressed={prefs.theme === choice}
                onClick={() => change({ theme: choice })}
                data-testid={`theme-${choice}`}
              >
                {t(`display.theme.${choice}`)}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {show('glass') && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('display.glass.label')}</legend>
          <p className="text-xs text-muted">{t('display.glass.hint')}</p>
          <div
            className="segmented self-start"
            role="radiogroup"
            aria-label={t('display.glass.label')}
          >
            {GLASS_CHOICES.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={prefs.glass === level}
                aria-pressed={prefs.glass === level}
                onClick={() => change({ glass: level })}
                data-testid={`glass-${level}`}
              >
                {t(`display.glass.${level}`)}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {show('language') && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('display.language')}</legend>
          <div
            className="segmented self-start"
            role="radiogroup"
            aria-label={t('display.language')}
          >
            {LANGUAGES.map((language) => (
              <button
                key={language}
                type="button"
                role="radio"
                aria-checked={prefs.language === language}
                aria-pressed={prefs.language === language}
                onClick={() => change({ language })}
                data-testid={`language-${language}`}
              >
                {language === 'ar' ? 'العربية' : 'English'}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {show('textScale') && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t('display.text_scale')}</legend>
          <div
            className="segmented self-start"
            role="radiogroup"
            aria-label={t('display.text_scale')}
          >
            {TEXT_SCALES.map((scale) => (
              <button
                key={scale}
                type="button"
                role="radio"
                aria-checked={prefs.textScale === scale}
                aria-pressed={prefs.textScale === scale}
                onClick={() => change({ textScale: scale })}
              >
                {Math.round(scale * 100)}%
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      {preferences.isError && <Notice tone="warning">{t('display.local_only')}</Notice>}
    </div>
  );
}
