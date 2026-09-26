// The speech tabs' pickers (DECISIONS §91): a Groq voice chosen from the provider's documented
// list — by language and gender, searchable, every language offered — previewed before it is
// saved; a dictation language from Auto, the popular languages or a typed code; and a speech
// provider added with the key its family already holds.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { AddProviderDialog } from '../src/models/AddProviderDialog.js';
import { SpeechCard } from '../src/models/SpeechCard.js';
import type { ProviderPreset, SpeechSettings } from '../src/types.js';
import type * as PlayerModule from '../src/voice/player.js';
import { chooseInCombobox, chooseOption, stubListViewport } from './helpers/ui.js';

const played = vi.hoisted(() => ({ blobs: [] as Blob[] }));
vi.mock('../src/voice/player.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PlayerModule>();
  return {
    ...actual,
    playThroughAudioElement: (blob: Blob) => {
      played.blobs.push(blob);
      return Promise.resolve();
    },
  };
});

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

const GROQ_TTS = '01J8QK3ZR2W7M5N4P6T8V9X0GT';
const GROQ_STT = '01J8QK3ZR2W7M5N4P6T8V9X0GS';

const ARABIC = 'canopylabs/orpheus-arabic-saudi';
const ENGLISH = 'canopylabs/orpheus-v1-english';

const VOICES = [
  { id: 'autumn', name: 'Autumn', language: 'en', gender: 'female', models: [ENGLISH] },
  { id: 'troy', name: 'Troy', language: 'en', gender: 'male', models: [ENGLISH] },
  {
    id: 'fahad',
    name: 'Fahad',
    language: 'ar-SA',
    gender: 'male',
    description: 'Saudi dialect',
    models: [ARABIC],
  },
  {
    id: 'noura',
    name: 'Noura',
    language: 'ar-SA',
    gender: 'female',
    description: 'Saudi dialect',
    models: [ARABIC],
  },
  // A language outside the popular ones: behind "All languages".
  { id: 'lebo', name: 'Lebo', language: 'zu-ZA', gender: 'female', models: [ENGLISH] },
];

function model(provider: string, id: string, kind: string) {
  return {
    key: `${provider}/${id}`,
    provider_id: provider === 'groq-tts' ? GROQ_TTS : GROQ_STT,
    provider,
    model: id,
    alias: null,
    kind,
    visible: true,
    custom: false,
    preview: false,
    disabled: false,
    context_window: null,
    capabilities: [],
    pricing: null,
  };
}

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function fakeHub() {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    sent.push({ url, method: init?.method ?? 'GET', body });
    const json = (value: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }),
      );
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/models/speech/voices')) {
      const wanted = parsed.searchParams.get('model');
      return json({
        source: 'documented',
        items: VOICES.filter((voice) => !wanted || voice.models.includes(wanted)),
      });
    }
    if (parsed.pathname.endsWith('/models/speech/speech')) {
      return Promise.resolve(
        new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
          headers: { 'Content-Type': 'audio/wav', 'X-Speech-Provider': 'groq-tts' },
        }),
      );
    }
    if (parsed.pathname.endsWith('/models')) {
      const kind = parsed.searchParams.get('kind');
      return json({
        items:
          kind === 'tts'
            ? [model('groq-tts', ENGLISH, 'tts'), model('groq-tts', ARABIC, 'tts')]
            : [model('groq-stt', 'whisper-large-v3-turbo', 'stt')],
        next_cursor: null,
      });
    }
    return json({ items: [] });
  };
  return { sent, fetchImpl };
}

function side(kind: 'stt' | 'tts'): SpeechSettings['stt'] {
  const id = kind === 'tts' ? GROQ_TTS : GROQ_STT;
  return {
    active_provider_id: id,
    ready: true,
    reason: null,
    providers: [
      {
        id,
        slug: kind === 'tts' ? 'groq-tts' : 'groq-stt',
        label: kind === 'tts' ? 'Groq — text to speech' : 'Groq — speech to text',
        kind,
        configured: true,
        api_key: '[stored]',
        settings: {
          model: kind === 'tts' ? ENGLISH : 'whisper-large-v3-turbo',
          language: null,
          base_url: null,
          voice: null,
        },
      },
    ],
  } as SpeechSettings['stt'];
}

function wrap(fetchImpl: typeof fetch, children: ReactNode, language: 'ar' | 'en' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <MemoryRouter>{children}</MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

let undoViewport: () => void = () => undefined;
beforeEach(() => {
  undoViewport = stubListViewport();
  played.blobs = [];
});
afterEach(() => {
  undoViewport();
  cleanup();
});

/** The rows the open voice list shows, as their visible text. */
async function voiceRows(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
  screen.getByTestId('speech-voice-pick').focus();
  await user.keyboard('{Enter}');
  const rows = await screen.findAllByTestId('combobox-option');
  const texts = rows.map((row) => row.textContent ?? '');
  await user.keyboard('{Escape}');
  return texts;
}

describe('speech voice picker (§91)', () => {
  it("offers the model's own voices with language and gender, and says the list is documented", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub();
    wrap(fetchImpl, <SpeechCard kind="tts" side={side('tts')} />);

    await waitFor(() => expect(screen.getByTestId('speech-voice-pick')).toBeTruthy());
    expect(screen.getByTestId('speech-voices-documented')).toHaveTextContent(
      'provider’s documentation',
    );
    // The English model: its voices, the popular languages first; Zulu waits behind the filter.
    let rows = await voiceRows(user);
    expect(rows.some((row) => row.includes('Autumn') && row.includes('Female'))).toBe(true);
    expect(rows.some((row) => row.includes('Lebo'))).toBe(false);
    await chooseOption(user, screen.getByTestId('speech-voice-filter'), /All languages/);
    rows = await voiceRows(user);
    expect(rows.some((row) => row.includes('Lebo') && row.includes('Zulu'))).toBe(true);

    // The Arabic model: the Saudi voices, and only them.
    await chooseInCombobox(user, screen.getByTestId('speech-model-pick-tts'), ARABIC);
    await waitFor(async () => {
      const arabic = await voiceRows(user);
      expect(arabic.map((row) => row.split(/Female|Male/)[0])).toEqual(['Fahad', 'Noura']);
    });
    rows = await voiceRows(user);
    expect(rows.find((row) => row.startsWith('Noura'))).toMatch(/Female.*Arabic.*Saudi dialect/);
  });

  it('previews the chosen voice before saving, in Arabic or English', async () => {
    const user = userEvent.setup();
    const { fetchImpl, sent } = fakeHub();
    wrap(fetchImpl, <SpeechCard kind="tts" side={side('tts')} />);

    await waitFor(() => expect(screen.getByTestId('speech-model-pick-tts')).toBeTruthy());
    await chooseInCombobox(user, screen.getByTestId('speech-model-pick-tts'), ARABIC);
    await waitFor(() => expect(screen.getByTestId('speech-voice-pick')).toBeTruthy());
    await chooseInCombobox(user, screen.getByTestId('speech-voice-pick'), 'Noura');
    expect(screen.getByTestId('speech-voice-tts')).toHaveValue('noura');

    // An Arabic voice previews in Arabic.
    await user.click(screen.getByTestId('speech-try'));
    await waitFor(() => expect(played.blobs).toHaveLength(1));
    const preview = sent.find((item) => item.url.endsWith('/models/speech/speech'))!;
    expect(preview.body).toEqual({
      text: 'مرحبًا، هكذا ستُقرأ الردود بهذا الصوت.',
      language: 'ar',
      provider_id: GROQ_TTS,
      model: ARABIC,
      voice: 'noura',
    });
    // Nothing was saved by previewing.
    expect(sent.some((item) => item.method === 'PATCH')).toBe(false);

    // English on request, and a voice id typed by hand is what is previewed.
    await user.click(screen.getByTestId('speech-sample-en'));
    await user.clear(screen.getByTestId('speech-voice-tts'));
    await user.type(screen.getByTestId('speech-voice-tts'), 'my-cloned-voice');
    await user.click(screen.getByTestId('speech-try'));
    await waitFor(() => expect(played.blobs).toHaveLength(2));
    const second = sent.filter((item) => item.url.endsWith('/models/speech/speech'))[1]!;
    expect(second.body).toMatchObject({
      language: 'en',
      voice: 'my-cloned-voice',
      text: 'Hello, this is how replies will sound in this voice.',
    });
  });

  it('picks a spoken language from Auto, the popular languages, every language, or a typed code', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeHub();
    wrap(fetchImpl, <SpeechCard kind="stt" side={side('stt')} />, 'ar');

    await waitFor(() => expect(screen.getByTestId('speech-language-pick-stt')).toBeTruthy());
    // Empty is "detect automatically".
    expect(screen.getByTestId('speech-language-stt')).toHaveValue('');
    screen.getByTestId('speech-language-pick-stt').focus();
    await user.keyboard('{Enter}');
    const rows = (await screen.findAllByTestId('combobox-option')).map((row) => row.textContent);
    await user.keyboard('{Escape}');
    expect(rows[0]).toContain('اكتشاف تلقائي');
    // English, Arabic and Spanish are all there, named in the interface language.
    expect(rows.slice(1, 4).join(' ')).toMatch(/الإنجليزية.*العربية.*الإسبانية/);

    // A language far from the popular ones, found by search.
    await chooseInCombobox(user, screen.getByTestId('speech-language-pick-stt'), 'السواحلية');
    expect(screen.getByTestId('speech-language-stt')).toHaveValue('sw');
    // And a code typed by hand.
    await user.clear(screen.getByTestId('speech-language-stt'));
    await user.type(screen.getByTestId('speech-language-stt'), 'ar-EG');
    expect(screen.getByTestId('speech-language-stt')).toHaveValue('ar-EG');
  });
});

describe('adding a speech provider (§91)', () => {
  const PRESETS = [
    {
      id: 'groq-tts',
      label: 'Groq — text to speech',
      kind: 'tts',
      api_mode: 'native',
      base_url: 'https://api.groq.com/openai/v1',
      base_url_required: false,
      key: 'required',
      local: false,
      repeatable: false,
      keys_url: 'https://console.groq.com/keys',
      sign_in: false,
      base_url_example: null,
      key_on_file: ['all'],
    },
    {
      id: 'azure-tts',
      label: 'Azure Speech — text to speech',
      kind: 'tts',
      api_mode: 'native',
      base_url: null,
      base_url_required: true,
      key: 'required',
      local: false,
      repeatable: false,
      keys_url: null,
      sign_in: false,
      base_url_example: 'https://<region>.api.cognitive.microsoft.com',
      key_on_file: [],
    },
  ] as ProviderPreset[];

  it('adds with the key the family already holds, and asks no chat model of a speech provider', async () => {
    const { fetchImpl } = fakeHub();
    wrap(
      fetchImpl,
      <AddProviderDialog
        kind="tts"
        presets={PRESETS}
        host={{ containerized: false, loopback_alias: 'host.docker.internal' }}
        taken={{ all: new Set(), profile: new Set() }}
        profileName="default"
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('add-submit')).toBeTruthy());
    expect(screen.getByText(/already has a key saved here/)).toBeTruthy();
    expect(screen.getByTestId('add-submit')).toBeEnabled();
    expect(screen.queryByTestId('add-default-model')).toBeNull();

    // Azure: its key is not on file, and the address field shows the shape to type.
    await chooseOption(userEvent, screen.getByTestId('add-preset'), /Azure Speech/);
    expect(screen.getByTestId('add-base-url')).toHaveAttribute(
      'placeholder',
      'https://<region>.api.cognitive.microsoft.com',
    );
    expect(screen.getByTestId('add-submit')).toBeDisabled();
  });
});
