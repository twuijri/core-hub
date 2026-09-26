// What the ChatGPT subscription offers beyond the list its backend answers (decision §110): every
// image model its image tool takes, and a Codex CLI version that follows the newest release so a
// model OpenAI ships behind a newer CLI appears without a hub release.
import { describe, expect, it, vi } from 'vitest';
import { CODEX_IMAGES, codexImageModels, imageProtocolOf, isImageOnlyModel } from './images.js';
import {
  CODEX_CLIENT_VERSION,
  CODEX_RELEASE_TTL_MS,
  CODEX_RELEASES_URL,
  codexClientVersion,
  codexReleaseVersion,
  codexVersionSource,
  compareVersions,
} from './live-models.js';

const release = (tag: string, prerelease = false) =>
  Promise.resolve(
    new Response(JSON.stringify({ tag_name: tag, prerelease }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

describe('the subscription’s image models', () => {
  it('offers the whole GPT Image family the tool takes, newest first', () => {
    expect(codexImageModels({})).toEqual([
      'gpt-image-2.5',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gpt-image-2',
      'gpt-image-1.5',
    ]);
    expect(codexImageModels({})).toContain(CODEX_IMAGES.model);
    for (const model of codexImageModels({})) {
      expect(imageProtocolOf('openai', model, 'openai-codex'), model).toBe('codex');
      // Image-only: never offered as a chat model (§87).
      expect(isImageOnlyModel(model), model).toBe(true);
    }
    // A chat model of the subscription does not draw through the tool.
    expect(imageProtocolOf('openai', 'gpt-5.5', 'openai-codex')).toBeNull();
  });

  it('takes new names from the hub’s environment, first, and ignores what is not an image model', () => {
    expect(
      codexImageModels({
        COREHUB_CODEX_IMAGE_MODELS: ' gpt-image-3 , gpt-5.5, ../x, gpt-image-2 ,',
      }),
    ).toEqual([
      'gpt-image-3',
      'gpt-image-2',
      'gpt-image-2.5',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gpt-image-1.5',
    ]);
  });
});

describe('the Codex CLI version the list is asked as', () => {
  it('reads only a released rust-v tag and compares versions numerically', () => {
    expect(codexReleaseVersion('rust-v0.157.1')).toBe('0.157.1');
    expect(codexReleaseVersion('rust-v0.158.0-alpha.1')).toBeNull();
    expect(codexReleaseVersion('v1.0.0')).toBeNull();
    expect(codexReleaseVersion(undefined)).toBeNull();
    expect(compareVersions('0.157.10', '0.157.9')).toBeGreaterThan(0);
    expect(compareVersions('0.157.0', '0.157.0')).toBe(0);
    expect(compareVersions('0.99.0', '0.157.0')).toBeLessThan(0);
  });

  it('follows the newest Codex release, only upward, and the environment still wins', async () => {
    const fetch = vi.fn(() => release('rust-v0.999.0'));
    const version = codexVersionSource({ env: () => ({}), fetch });
    expect(await version()).toBe('0.999.0');
    expect(fetch).toHaveBeenCalledWith(CODEX_RELEASES_URL, expect.anything());

    const older = codexVersionSource({ env: () => ({}), fetch: () => release('rust-v0.1.0') });
    expect(await older()).toBe(CODEX_CLIENT_VERSION);

    const pinned = codexVersionSource({
      env: () => ({ COREHUB_CODEX_CLIENT_VERSION: '0.150.0' }),
      fetch: () => release('rust-v0.999.0'),
    });
    expect(await pinned()).toBe('0.150.0');
    expect(codexClientVersion({}, '0.999.0')).toBe('0.999.0');
  });

  it('keeps the known version when GitHub cannot be read, and reads again only after twelve hours', async () => {
    let now = 0;
    const answers = [
      () => Promise.resolve(new Response('{"message":"rate limited"}', { status: 403 })),
      () => Promise.reject(new TypeError('offline')),
      () => release('rust-v0.998.0', true),
      () => release('rust-v0.999.0'),
    ];
    const fetch = vi.fn(() => answers.shift()!());
    const version = codexVersionSource({ env: () => ({}), fetch, now: () => now });

    expect(await version()).toBe(CODEX_CLIENT_VERSION);
    expect(await version()).toBe(CODEX_CLIENT_VERSION);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += CODEX_RELEASE_TTL_MS;
    expect(await version()).toBe(CODEX_CLIENT_VERSION);
    now += CODEX_RELEASE_TTL_MS;
    // A pre-release is not a release.
    expect(await version()).toBe(CODEX_CLIENT_VERSION);
    now += CODEX_RELEASE_TTL_MS;
    expect(await version()).toBe('0.999.0');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not hold the list back on a slow GitHub: the next ask uses the answer', async () => {
    let answer: (value: Response) => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const version = codexVersionSource({ env: () => ({}), fetch, waitMs: 10 });
    expect(await version()).toBe(CODEX_CLIENT_VERSION);
    answer(await release('rust-v0.999.0'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await version()).toBe('0.999.0');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
