/**
 * The top of the Speech to text and Text to speech tabs (contract decision §54): which
 * provider this profile speaks through, and that provider's model, language or voice.
 *
 * Before this card the tabs listed providers and said «لم يُختَر مزوّد» with nowhere to
 * choose one, so dictation and read-aloud could never be ready from the web. Choosing and
 * saving here is `models.updateSpeech`; the badge is the hub's own `ready`, and "Try the
 * voice" asks the hub to speak — what it plays is what a reply will sound like.
 */
import { useEffect, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import type { SpeechSettings } from '../types.js';
import { Badge, Button, Card, CardHeader, Field, Input, Select } from '../ui/index.js';
import { Notice } from '../ui/Notice.js';
import { playThroughAudioElement } from '../voice/player.js';
import { synthesize } from '../voice/speech-api.js';
import { useUpdateSpeech, useVoices } from './queries.js';

export function SpeechCard({ kind, side }: { kind: 'stt' | 'tts'; side: SpeechSettings['stt'] }) {
  const { t, language } = useI18n();
  const { client } = useAuth();
  const update = useUpdateSpeech();
  const [providerId, setProviderId] = useState<string | null>(side.active_provider_id);
  const chosen = side.providers.find((provider) => provider.id === providerId) ?? null;
  const [model, setModel] = useState('');
  const [speechLanguage, setSpeechLanguage] = useState('');
  const [voice, setVoice] = useState('');
  const [saved, setSaved] = useState(false);
  const [trying, setTrying] = useState<'idle' | 'playing' | { error: string }>('idle');
  const voices = useVoices(kind === 'tts' ? providerId : null);

  // What the hub holds for the provider in view, whenever the choice or the hub changes.
  useEffect(() => {
    setModel(chosen?.settings.model ?? '');
    setSpeechLanguage(chosen?.settings.language ?? '');
    setVoice(chosen?.settings.voice ?? '');
  }, [chosen?.id, chosen?.settings.model, chosen?.settings.language, chosen?.settings.voice]);
  useEffect(() => setProviderId(side.active_provider_id), [side.active_provider_id]);

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

  const tryVoice = async () => {
    setTrying('playing');
    try {
      const audio = await synthesize(client, { text: t('models.speech.try_text'), language });
      await playThroughAudioElement(audio, new AbortController().signal);
      setTrying('idle');
    } catch (error) {
      setTrying({ error: describeError(error, t) });
    }
  };

  const listed = voices.data ?? [];
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
            <Field label={t('models.speech.model')}>
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  data-testid={`speech-model-${kind}`}
                />
              )}
            </Field>
          )}
          {chosen && kind === 'tts' && (
            <div className="ch-field-row">
              <span className="ch-label">{t('models.speech.voice')}</span>
              {listed.length > 0 ? (
                <Select
                  value={voice || null}
                  onValueChange={(next) => setVoice(next ?? '')}
                  label={t('models.speech.voice')}
                  testId="speech-voice-tts"
                  options={listed.map((item) => ({ value: item.id, label: item.name }))}
                />
              ) : (
                <Input
                  dir="ltr"
                  aria-label={t('models.speech.voice')}
                  placeholder={t('models.speech.voice_hint')}
                  value={voice}
                  onChange={(event) => setVoice(event.target.value)}
                  data-testid="speech-voice-tts"
                />
              )}
            </div>
          )}
          {chosen && (
            <Field label={t('models.speech.language')}>
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  placeholder="ar"
                  value={speechLanguage}
                  onChange={(event) => setSpeechLanguage(event.target.value)}
                  data-testid={`speech-language-${kind}`}
                />
              )}
            </Field>
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
            {kind === 'tts' && side.ready && (
              <Button
                onClick={() => void tryVoice()}
                loading={trying === 'playing'}
                data-testid="speech-try"
              >
                {t('models.speech.try')}
              </Button>
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
