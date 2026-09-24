/**
 * The guard on a rename.
 *
 * `PRODUCT` is meant to change, `LEGACY` keeps what it was, and `STABLE` never changes —
 * the difference is not obvious from reading any of them, so it is asserted here, with
 * the reason attached, because the failure mode of getting it wrong is silence.
 */
import { describe, expect, it } from 'vitest';
import { LEGACY, PRODUCT, STABLE, derived, readProductEnv } from '../src/product.js';

describe('the product name', () => {
  it('is Core Hub', () => {
    expect(PRODUCT.id).toBe('corehub');
    expect(PRODUCT.name).toBe('Core Hub');
    expect(PRODUCT.nameAr).toBe('كور هب');
  });

  it('drives every convention named after it', () => {
    expect(derived.configDir).toBe(PRODUCT.id);
    expect(derived.envPrefix).toBe(`${PRODUCT.id.toUpperCase()}_`);
    expect(derived.storagePrefix).toBe(`${PRODUCT.id}.`);
    expect(derived.runFilesDir).toBe(`.${PRODUCT.id}`);
    expect(derived.webhookSignatureHeader).toBe(`x-${PRODUCT.id}-signature`);
    expect(derived.pairingType).toBe(`${PRODUCT.id}.pairing`);
    expect(derived.hermesProviderPrefix).toBe(`${PRODUCT.id}-`);
    expect(derived.jwtIssuer).toBe(PRODUCT.id);
  });

  it('keeps every old name next to its new one, and none of them is the new one', () => {
    for (const key of Object.keys(LEGACY) as (keyof typeof LEGACY)[]) {
      if (key === 'id' || key === 'name') continue;
      expect(key in derived, key).toBe(true);
      expect(LEGACY[key]).not.toBe(derived[key as keyof typeof derived]);
    }
  });
});

describe('the identifier a rename must not touch', () => {
  it('is a literal, and stays this exact literal', () => {
    // Deterministic ids are seeded with this. A different seed is a different profile id
    // for the same profile: nothing errors, the hub just stops finding yesterday's rows.
    // If a rename makes this fail, put the old string back — do not update the expectation.
    expect(STABLE.idNamespace).toBe('majlis');
  });
});

describe('an environment variable under its old name', () => {
  it('is read when the new name is not set, and says which old name it came from', () => {
    expect(readProductEnv({ MAJLIS_VERSION: '1.2.3' }, 'VERSION')).toEqual({
      value: '1.2.3',
      legacyName: 'MAJLIS_VERSION',
    });
  });

  it('loses to the new name when both are set', () => {
    expect(readProductEnv({ MAJLIS_VERSION: 'old', COREHUB_VERSION: 'new' }, 'VERSION')).toEqual({
      value: 'new',
      legacyName: null,
    });
  });

  it('counts an empty value as unset', () => {
    expect(readProductEnv({ COREHUB_VERSION: ' ', MAJLIS_VERSION: '' }, 'VERSION')).toEqual({
      value: undefined,
      legacyName: null,
    });
  });
});
