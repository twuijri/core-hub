import { describe, expect, it } from 'vitest';
import { normaliseHub, parsePairing } from '../src/pairing.js';

const ID = '01J8QK3ZR2W7M5N4P6T8V9X0YA';

describe('parsePairing', () => {
  it('reads the QR JSON, and the pre-rename type', () => {
    for (const type of ['corehub.pairing', 'majlis.pairing']) {
      const parsed = parsePairing(
        JSON.stringify({
          type,
          hub_url: 'https://hub.example/',
          pairing_id: ID,
          code: 'abcd-1234',
        }),
      );
      expect(parsed).toEqual({
        ok: true,
        pairing: { hub: 'https://hub.example', pairingId: ID, code: 'ABCD-1234' },
      });
    }
  });

  it('refuses JSON of another kind', () => {
    expect(parsePairing('{"type":"other","pairing_id":"x"}')).toEqual({
      ok: false,
      error: 'json_invalid',
    });
    expect(parsePairing('{nope')).toEqual({ ok: false, error: 'json_invalid' });
  });

  it('reads the pair link', () => {
    const parsed = parsePairing(
      `corehub://pair?hub=https%3A%2F%2Fhub.example%3A8443&id=${ID}&code=ZXCV-0000`,
    );
    expect(parsed).toEqual({
      ok: true,
      pairing: { hub: 'https://hub.example:8443', pairingId: ID, code: 'ZXCV-0000' },
    });
  });

  it('reads the hub, the id and the code in any order, and falls back to the known hub', () => {
    expect(parsePairing(`${ID} abcd https://hub.example`)).toMatchObject({
      ok: true,
      pairing: { code: 'ABCD' },
    });
    expect(parsePairing(`${ID} abcd`, 'https://known.example')).toMatchObject({
      ok: true,
      pairing: { hub: 'https://known.example' },
    });
    expect(parsePairing(`${ID} abcd`)).toEqual({ ok: false, error: 'fields_missing' });
  });

  it('refuses a hub that is not an origin', () => {
    expect(parsePairing(`https://hub.example/path ${ID} abcd`)).toEqual({
      ok: false,
      error: 'hub_invalid',
    });
    expect(normaliseHub('ftp://hub.example')).toBeNull();
    expect(normaliseHub('https://user:pw@hub.example')).toBeNull();
    expect(normaliseHub('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('says when nothing was given', () => {
    expect(parsePairing('   ')).toEqual({ ok: false, error: 'empty' });
  });
});
