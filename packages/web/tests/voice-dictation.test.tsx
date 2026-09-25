// The composer's microphone (DECISIONS §54): a take goes to `models.transcribe` and its words
// land in the composer for review; with no STT provider the browser's own recognizer is used
// and marked; with neither, the composer says so and links to Models. jsdom has no microphone,
// so `getUserMedia`, `MediaRecorder` and the recognizer are small fakes here.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { Composer } from '../src/chat/Composer.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

const side = (ready: boolean) => ({
  active_provider_id: ready ? '01J8QK3ZR2W7M5N4P6T8V9X0PX' : null,
  ready,
  reason: ready ? null : 'No speech-to-text provider is chosen.',
  providers: [],
});

interface Sent {
  audio: File | null;
  language: string | null;
  duration: string | null;
}

function renderComposer(options: { sttReady: boolean; transcript?: string }) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const sent: Sent[] = [];
  const served = new Set<string>();
  const json = (value: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const fetchImpl = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/models/speech')) {
      served.add('speech');
      return json({ stt: side(options.sttReady), tts: side(false) });
    }
    if (url.endsWith('/auth/me/preferences')) {
      served.add('preferences');
      return json({
        voice: {
          input_mode: 'device',
          dictation_language: 'ar',
          output_mode: 'server',
          auto_speak: false,
        },
      });
    }
    if (url.endsWith('/models/speech/transcriptions')) {
      const form = init.body as FormData;
      const audio = form.get('audio');
      sent.push({
        audio: audio instanceof File ? audio : null,
        language: form.get('language') as string | null,
        duration: form.get('duration_ms') as string | null,
      });
      return json({
        text: options.transcript ?? 'شغّل الاختبارات',
        language: 'ar',
        duration_ms: 1200,
        provider_id: '01J8QK3ZR2W7M5N4P6T8V9X0PX',
        model: 'whisper-1',
      });
    }
    return json({ items: [] });
  }) as typeof fetch;
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <Composer
                  busy={false}
                  disabled={false}
                  onSend={async () => {}}
                  onCancel={async () => {}}
                />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return { sent, served };
}

/** A `MediaRecorder` that yields one chunk of "audio" when stopped. */
class FakeRecorder {
  static isTypeSupported = (mime: string) => mime.startsWith('audio/webm');
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }),
    });
    this.onstop?.();
  }
}

const track = { stop: vi.fn() };
beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

const mic = () => screen.getByTestId('composer-mic');
const input = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;

describe('dictation', () => {
  it('records, sends the take to the hub, and puts the words in the composer for review', async () => {
    const { sent, served } = renderComposer({ sttReady: true });
    // The engine and the language are known once the settings are read.
    await waitFor(() => expect(served.has('speech') && served.has('preferences')).toBe(true));
    await act(async () => {});
    fireEvent.change(input(), { target: { value: 'Please' } });

    fireEvent.click(mic());
    await waitFor(() => expect(mic()).toHaveAttribute('data-phase', 'recording'));
    expect(screen.getByTestId('dictation-status')).toHaveTextContent('Listening');
    expect(mic()).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(mic());
    await waitFor(() => expect(input().value).toBe('Please شغّل الاختبارات'));
    expect(mic()).toHaveAttribute('data-phase', 'idle');
    // Nothing was sent as a message: the words wait in the composer.
    expect(screen.getByTestId('send')).toBeEnabled();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.audio?.name).toBe('dictation.webm');
    expect(sent[0]!.language).toBe('ar');
    expect(Number(sent[0]!.duration)).toBeGreaterThanOrEqual(0);
    // The microphone is released after the take.
    expect(track.stop).toHaveBeenCalled();
  });

  it('with no provider and no recognizer, says so and links to Models', async () => {
    renderComposer({ sttReady: false });
    await waitFor(() => expect(mic()).toBeEnabled());
    fireEvent.click(mic());
    const error = await screen.findByTestId('dictation-error');
    expect(error).toHaveTextContent('needs a speech-to-text provider');
    expect(screen.getByTestId('dictation-setup')).toHaveAttribute(
      'href',
      '/settings/models?tab=stt_providers',
    );
  });

  it('falls back to the browser’s recognizer when the hub has no provider, and says so', async () => {
    let recognizer: {
      onstart: (() => void) | null;
      onresult: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      lang: string;
    } | null = null;
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = true;
      onstart: (() => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        recognizer = this;
      }
      start() {
        this.onstart?.();
      }
      stop() {
        this.onresult?.({
          resultIndex: 0,
          results: [Object.assign([{ transcript: 'hello there' }], { isFinal: true })],
        });
        this.onend?.();
      }
      abort() {}
    }
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    const { sent, served } = renderComposer({ sttReady: false });
    await waitFor(() => expect(served.has('preferences')).toBe(true));
    await act(async () => {});
    fireEvent.click(mic());
    await waitFor(() => expect(screen.getByTestId('dictation-browser')).toBeInTheDocument());
    // The preference said Arabic; the recognizer needs a full tag.
    expect(recognizer!.lang).toBe('ar-SA');
    fireEvent.click(mic());
    await waitFor(() => expect(input().value).toBe('hello there'));
    expect(sent).toHaveLength(0);
  });
});
