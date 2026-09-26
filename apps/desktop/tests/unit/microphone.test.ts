// The microphone for dictation (B11): the app's own page may record sound — never video, never
// another page — and the OS decides, asking the person on macOS while it has not been asked.
import { describe, expect, it } from 'vitest';
import {
  answerPermission,
  checkPermission,
  isAudioOnly,
  micSettingsUrl,
  type MicAccess,
  type MicHooks,
} from '../../src/main/microphone.js';

const ORIGIN = 'http://127.0.0.1:47112';

function hooks(platform: string, status: MicAccess, answer = true) {
  const asked: string[] = [];
  const value: MicHooks = {
    platform,
    status: () => status,
    ask: async () => {
      asked.push('asked');
      return answer;
    },
  };
  return { value, asked };
}

const mic = (url = `${ORIGIN}/chat`, mediaTypes: string[] = ['audio']) => ({
  permission: 'media',
  url,
  mediaTypes,
});

describe('permission requests', () => {
  it('lets the app’s page record sound (the old handler refused every microphone)', async () => {
    expect(await answerPermission(mic(), ORIGIN, hooks('linux', 'unknown').value)).toBe(true);
    expect(await answerPermission(mic(), ORIGIN, hooks('win32', 'granted').value)).toBe(true);
  });

  it('never gives the camera, the screen or another page', async () => {
    const h = hooks('linux', 'unknown').value;
    expect(await answerPermission(mic(`${ORIGIN}/chat`, ['video']), ORIGIN, h)).toBe(false);
    expect(await answerPermission(mic(`${ORIGIN}/chat`, ['audio', 'video']), ORIGIN, h)).toBe(
      false,
    );
    expect(await answerPermission(mic(`${ORIGIN}/chat`, []), ORIGIN, h)).toBe(false);
    expect(await answerPermission(mic('https://evil.example/'), ORIGIN, h)).toBe(false);
    expect(await answerPermission(mic('http://127.0.0.1:47112.evil/'), ORIGIN, h)).toBe(false);
    expect(
      await answerPermission({ permission: 'geolocation', url: `${ORIGIN}/` }, ORIGIN, h),
    ).toBe(false);
    expect(isAudioOnly(undefined)).toBe(false);
  });

  it('keeps notifications and the clipboard as before', async () => {
    const h = hooks('linux', 'unknown').value;
    for (const permission of ['notifications', 'clipboard-sanitized-write', 'clipboard-read'])
      expect(await answerPermission({ permission, url: `${ORIGIN}/` }, ORIGIN, h)).toBe(true);
  });

  it('on macOS asks the OS while it is undecided, and follows its answer', async () => {
    const yes = hooks('darwin', 'not-determined', true);
    expect(await answerPermission(mic(), ORIGIN, yes.value)).toBe(true);
    expect(yes.asked).toEqual(['asked']);
    const no = hooks('darwin', 'not-determined', false);
    expect(await answerPermission(mic(), ORIGIN, no.value)).toBe(false);
    const granted = hooks('darwin', 'granted');
    expect(await answerPermission(mic(), ORIGIN, granted.value)).toBe(true);
    expect(granted.asked).toEqual([]);
  });

  it('says no when the OS said no, without asking again', async () => {
    for (const platform of ['darwin', 'win32']) {
      for (const status of ['denied', 'restricted'] as const) {
        const h = hooks(platform, status);
        expect(await answerPermission(mic(), ORIGIN, h.value)).toBe(false);
        expect(h.asked).toEqual([]);
      }
    }
  });
});

describe('permission checks', () => {
  it('answers the page’s question about the microphone for its own origin only', () => {
    expect(checkPermission('media', ORIGIN, ORIGIN, { mediaType: 'audio' }, 'granted')).toBe(true);
    expect(checkPermission('media', ORIGIN, ORIGIN, { mediaType: 'video' }, 'granted')).toBe(false);
    expect(checkPermission('media', ORIGIN, ORIGIN, { mediaType: 'audio' }, 'denied')).toBe(false);
    expect(
      checkPermission('media', 'https://x.example', ORIGIN, { mediaType: 'audio' }, 'granted'),
    ).toBe(false);
    expect(checkPermission('notifications', ORIGIN, ORIGIN, {}, 'unknown')).toBe(true);
  });

  it('knows where each OS keeps its microphone switch', () => {
    expect(micSettingsUrl('darwin')).toContain('Privacy_Microphone');
    expect(micSettingsUrl('win32')).toBe('ms-settings:privacy-microphone');
    expect(micSettingsUrl('linux')).toBeNull();
  });
});
