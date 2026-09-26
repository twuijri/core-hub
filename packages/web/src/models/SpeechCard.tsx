/**
 * The top of the Speech to text and Text to speech tabs (contract decision §63): which
 * provider this profile speaks through, and that provider's model, language or voice.
 *
 * Before this card the tabs listed providers and said «لم يُختَر مزوّد» with nowhere to
 * choose one, so dictation and read-aloud could never be ready from the web. Choosing and
 * saving here is `models.updateSpeech`; the badge is the hub's own `ready`.
 *
 * The model, language and voice are picked from what the provider offers — its own lists, or
 * its documented ones where it has no endpoint — and can always be typed (DECISIONS §87).
 * "Preview" speaks a short sample through the provider, model and voice **on screen**, before
 * they are saved, in Arabic or English: what it plays is what a reply will sound like.
 */
import { useEffect, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import type { SpeechSettings } from '../types.js';
import { Badge, Button, Card, CardHeader, Segmented, Select } from '../ui/index.js';
import { Notice } from '../ui/Notice.js';
import { baseLanguage } from '../voice/languages.js';
import { playThroughAudioElement } from '../voice/player.js';
import { synthesize } from '../voice/speech-api.js';
import { useUpdateSpeech } from './queries.js';
import { SpeechLanguageField, SpeechModelField, SpeechVoiceField } from './SpeechPickers.js';

/** The preview's sample: Arabic or English, the voice's own language when it is one of them. */
type Sample = 'ar' | 'en';

export function SpeechCard({ kind, side }: { kind: 'stt' | 'tts'; side: SpeechSettings['stt'] }) {
  const { t, language: ui } = useI18n();
  const { client } = useAuth();
  const update = useUpdateSpeech();
  const [providerId, setProviderId] = useState<string | null>(side.active_provider_id);
  const chosen = side.providers.find((provider) => provider.id === providerId) ?? null;
  const [model, setModel] = useState('');
  const [speechLanguage, setSpeechLanguage] = useState('');
  const [voice, setVoice] = useState('');
  const [saved, setSaved] = useState(false);
  const [sample, setSample] = useState<Sample>(ui === 'ar' ? 'ar' : 'en');
  const [trying, setTrying] = useState<'idle' | 'playing' | { error: string }>('idle');

  // What the hub holds for the provider in view, whenever the choice or the hub changes.
  useEffect(() => {
    setModel(chosen?.settings.model ?? '');
    setSpeechLanguage(chosen?.settings.language ?? '');
    setVoice(chosen?.settings.voice ?? '');
  }, [chosen?.id, chosen?.settings.model, chosen?.settings.language, chosen?.settings.voice]);
  useEffect(() => setProviderId(side.active_provider_id), [side.active_provider_id]);

  const pickVoice = (next: string, language?: string | null) => {
    setVoice(next);
    // A voice that speaks Arabic or English previews in its own language.
    const base = baseLanguage(language ?? null);
    if (base === 'ar' || base === 'en') setSample(base);
  };

  const save = () => {
    setSaved(false);
    update.mutate(
      {
        kind,
        providerId,
        settings: {
          model: model.trim() || null,
          language: speechLanguage.trim() || null,
          ...(kind === 'tts' ? { voice: voice.trim() || null } : {}),
        },
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  const preview = async () => {
    if (!chosen) return;
    setTrying('playing');
    try {
      const audio = await synthesize(client, {
        text: t(sample === 'ar' ? 'models.speech.sample_ar' : 'models.speech.sample_en'),
        language: sample,
        providerId: chosen.id,
        model: model.trim() || null,
        voice: voice.trim() || null,
      });
      await playThroughAudioElement(audio, new AbortController().signal);
      setTrying('idle');
    } catch (error) {
      setTrying({ error: describeError(error, t) });
    }
  };

  return (
    <Card tone="raised" className="mb-3" data-testid={`speech-card-${kind}`}>
      <CardHeader
        title={t(kind === 'stt' ? 'models.speech.active_stt' : 'models.speech.active_tts')}
        subtitle={t(kind === 'stt' ? 'models.speech.hint_stt' : 'models.speech.hint_tts')}
        actions={
          <Badge tone={side.ready ? 'success' : 'warning'} testId={`speech-ready-${kind}`}>
            {t(side.ready ? 'models.speech.ready' : 'models.speech.not_ready')}
          </Badge>
        }
      />
      {side.providers.length === 0 ? (
        <p className="text-sm text-muted">{t('models.speech.add_hint')}</p>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="ch-field-row">
            <span className="ch-label">{t('models.speech.provider')}</span>
            <Select
              value={providerId ?? '__none'}
              onValueChange={(next) => setProviderId(!next || next === '__none' ? null : next)}
              label={t('models.speech.provider')}
              testId={`speech-provider-${kind}`}
              options={[
                { value: '__none', label: t('models.speech.none') },
                ...side.providers.map((provider) => ({
                  value: provider.id,
                  label: provider.label,
                })),
              ]}
            />
          </div>
          {chosen && (
            <SpeechModelField
              kind={kind}
              providerId={chosen.id}
              value={model}
              onChange={setModel}
            />
          )}
          {chosen && kind === 'tts' && (
            <SpeechVoiceField
              providerId={chosen.id}
              model={model}
              value={voice}
              onChange={pickVoice}
            />
          )}
          {chosen && (
            <SpeechLanguageField kind={kind} value={speechLanguage} onChange={setSpeechLanguage} />
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button
              type="submit"
              variant="primary"
              loading={update.isPending}
              data-testid={`speech-save-${kind}`}
            >
              {t('models.speech.save')}
            </Button>
            {kind === 'tts' && chosen && (
              <>
                <Button
                  onClick={() => void preview()}
                  loading={trying === 'playing'}
                  data-testid="speech-try"
                >
                  {t('models.speech.try')}
                </Button>
                <Segmented
                  label={t('models.speech.sample')}
                  size="sm"
                  value={sample}
                  onChange={(next) => setSample(next === 'ar' ? 'ar' : 'en')}
                  testId="speech-sample"
                  options={[
                    {
                      value: 'ar',
                      label: 'العربية',
                      itemProps: { 'data-testid': 'speech-sample-ar', lang: 'ar' },
                    },
                    {
                      value: 'en',
                      label: 'English',
                      itemProps: { 'data-testid': 'speech-sample-en', lang: 'en' },
                    },
                  ]}
                />
              </>
            )}
            {saved && !update.isPending && (
              <span className="text-sm text-muted" role="status">
                {t('models.speech.saved')}
              </span>
            )}
          </div>
        </form>
      )}
      {update.isError && <Notice tone="danger">{describeError(update.error, t)}</Notice>}
      {typeof trying === 'object' && (
        <Notice tone="danger">{t('models.speech.try_failed', { detail: trying.error })}</Notice>
      )}
    </Card>
  );
}
