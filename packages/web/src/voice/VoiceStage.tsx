/**
 * Voice mode (contract decision §54): a full-screen stage for talking with the agent.
 *
 *   tap (or hold) → listening → tap (or release) → the take is transcribed → sent as a
 *   message → the reply streams in and is spoken sentence by sentence as it arrives →
 *   listening again
 *
 * The state is always on screen — «أستمع» / «أفكّر» / «أتكلّم» — and "Interrupt" stops the
 * voice (and the run, if it is still going) and listens again. Neither the hub's STT nor its
 * TTS streams, so this is turn by turn, and the stage says so rather than pretending to be a
 * live call.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useI18n } from '../i18n/context.js';
import type { ContentBlock, Message } from '../types.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { IconMic, IconStop } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';
import { textOf } from '../chat/transcript.js';
import { StreamingChunker, languageOf } from './chunking.js';
import { usePlayerSnapshot, useVoice, useVoicePreferences } from './context.js';
import { DictationNotice, useElapsedSeconds } from './DictationControls.js';
import type { Reading } from './player.js';
import { dictationHint } from './recorder.js';
import { useDictation } from './useDictation.js';

export type StagePhase = 'ready' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

/** The id the stage's readings carry in the shared player. */
export const VOICE_MODE_ID = 'voice-mode';

/** A press longer than this is "hold to talk": letting go sends. */
const HOLD_MS = 400;

interface Turn {
  /** The messages that were there when the words were sent: the reply is none of them. */
  before: Set<string>;
  reading: Reading | null;
  chunker: StreamingChunker;
  replyId: string | null;
}

export function VoiceStage({
  messages,
  busy,
  onSend,
  onCancel,
  onClose,
}: {
  messages: readonly Message[];
  busy: boolean;
  onSend(blocks: ContentBlock[]): Promise<void>;
  onCancel(): Promise<void>;
  onClose(): void;
}) {
  const { t, language: ui } = useI18n();
  const voice = useVoice();
  const player = usePlayerSnapshot(voice?.player);
  const preferences = useVoicePreferences();
  const [heard, setHeard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turn = useRef<Turn | null>(null);
  const [waiting, setWaiting] = useState(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const dictation = useDictation({
    language: dictationHint(preferences.dictationLanguage, ui),
    onText: (words) => {
      setHeard(words);
      setError(null);
      turn.current = {
        before: new Set(messagesRef.current.map((message) => message.id)),
        reading: null,
        chunker: new StreamingChunker(),
        replyId: null,
      };
      setWaiting(true);
      onSend([{ type: 'text', text: words }]).catch((failure: unknown) => {
        turn.current = null;
        setWaiting(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      });
    },
  });
  const seconds = useElapsedSeconds(dictation.state);
  const listenAgain = useRef(dictation.start);
  listenAgain.current = dictation.start;
  const closed = useRef(false);

  // The reply, as it streams: every sentence that is safe to say goes to the voice.
  useEffect(() => {
    const current = turn.current;
    if (!current || !voice) return;
    const reply = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && !current.before.has(message.id));
    if (!reply) return;
    const text = textOf(reply);
    if (!current.reading) {
      current.replyId = reply.id;
      current.reading = voice.player.open(VOICE_MODE_ID, {
        language: languageOf(text || heard || ''),
        source: voice.source ?? 'hub',
      });
      const reading = current.reading;
      void reading.done.then(() => {
        if (turn.current?.reading !== reading) return;
        turn.current = null;
        setWaiting(false);
        // The conversation goes on: listening again, unless the stage was closed.
        if (!closed.current) listenAgain.current();
      });
    }
    if (reply.status === 'streaming') {
      for (const chunk of current.chunker.push(text)) current.reading.push(chunk);
    } else {
      for (const chunk of current.chunker.finish(text)) current.reading.push(chunk);
      current.reading.end();
    }
  }, [messages, voice, heard]);

  // A run that ended with nothing to say leaves the stage ready rather than thinking forever.
  useEffect(() => {
    if (!waiting || busy || !turn.current || turn.current.reading) return;
    const timer = setTimeout(() => {
      if (turn.current && !turn.current.reading) {
        turn.current = null;
        setWaiting(false);
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [waiting, busy]);

  const speaking = player.id === VOICE_MODE_ID && player.phase !== 'idle';
  const phase: StagePhase =
    dictation.state.phase === 'recording' || dictation.state.phase === 'requesting'
      ? 'listening'
      : dictation.state.phase === 'transcribing'
        ? 'transcribing'
        : speaking
          ? 'speaking'
          : waiting
            ? 'thinking'
            : 'ready';

  const interrupt = useCallback(() => {
    turn.current = null;
    setWaiting(false);
    voice?.player.stop();
    if (busy) void onCancel().catch(() => {});
    dictation.start();
  }, [voice, busy, onCancel, dictation]);

  const close = useCallback(() => {
    closed.current = true;
    turn.current = null;
    voice?.player.stop();
    dictation.cancel();
    onClose();
  }, [voice, dictation, onClose]);

  // Tap to start and tap to send, or hold and let go.
  const pressedAt = useRef<number | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    if (phase === 'ready') {
      pressedAt.current = Date.now();
      dictation.start();
    } else if (phase === 'listening') {
      pressedAt.current = null;
      dictation.stop();
    } else if (phase === 'speaking' || phase === 'thinking') {
      pressedAt.current = null;
      interrupt();
    }
  };
  const onPointerUp = () => {
    const started = pressedAt.current;
    pressedAt.current = null;
    if (started !== null && Date.now() - started > HOLD_MS) dictation.stop();
  };
  const onKey = () => {
    if (phase === 'ready') dictation.start();
    else if (phase === 'listening') dictation.stop();
    else if (phase === 'speaking' || phase === 'thinking') interrupt();
  };

  const lastReply = turn.current?.replyId
    ? messages.find((message) => message.id === turn.current?.replyId)
    : undefined;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      size="full"
      title={t('voice.stage.title')}
      description={t('voice.stage.turn_by_turn')}
      closeLabel={t('voice.stage.close')}
      testId="voice-stage"
    >
      <div className="voice-stage" data-state={phase}>
        <p className="voice-stage-state" role="status" data-testid="voice-stage-state">
          {t(`voice.stage.${phase}`)}
          {phase === 'listening' && dictation.state.phase === 'recording' && ` · ${seconds}`}
        </p>
        <button
          type="button"
          className="voice-orb"
          data-state={phase}
          aria-label={
            phase === 'ready'
              ? t('voice.stage.ready')
              : phase === 'listening'
                ? t('voice.stage.tap_to_send')
                : t('voice.stage.interrupt')
          }
          disabled={phase === 'transcribing'}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onKey();
            }
          }}
          data-testid="voice-orb"
        >
          {phase === 'listening' ? <IconStop size={40} /> : <IconMic size={40} />}
        </button>
        <p className="text-sm text-muted">{t('voice.stage.hint')}</p>
        <DictationNotice dictation={dictation} />
        {error && <Notice tone="danger">{error}</Notice>}
        {player.error?.id === VOICE_MODE_ID && (
          <Notice tone="danger">{player.error.message}</Notice>
        )}
        {heard && (
          <p className="voice-stage-line" dir="auto" data-testid="voice-heard">
            <span className="text-faint">{t('voice.stage.you_said')}</span> {heard}
          </p>
        )}
        {lastReply && textOf(lastReply).trim() && (
          <p className="voice-stage-line voice-stage-reply" dir="auto" data-testid="voice-reply">
            {textOf(lastReply)}
          </p>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {(phase === 'speaking' || phase === 'thinking') && (
            <Button onClick={interrupt} data-testid="voice-interrupt">
              {t('voice.stage.interrupt')}
            </Button>
          )}
          <Button variant="ghost" onClick={close} data-testid="voice-close">
            {t('voice.stage.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
