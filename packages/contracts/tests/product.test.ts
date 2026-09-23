/**
 * The guard on a rename.
 *
 * `PRODUCT` is meant to change. `STABLE` is not, and the difference is not obvious from
 * reading either of them — so it is asserted here, with the reason attached, because the
 * failure mode of getting it wrong is silence rather than an error.
 */
import { describe, expect, it } from 'vitest';
import { PRODUCT, STABLE, derived } from '../src/product.js';

describe('the product name', () => {
  it('drives every convention named after it', () => {
    expect(derived.configDir).toBe(PRODUCT.id);
    expect(derived.envPrefix).toBe(`${PRODUCT.id.toUpperCase()}_`);
    expect(derived.storagePrefix).toBe(`${PRODUCT.id}.`);
    expect(derived.runFilesDir).toBe(`.${PRODUCT.id}`);
    expect(derived.webhookSignatureHeader).toBe(`x-${PRODUCT.id}-signature`);
    expect(derived.pairingType).toBe(`${PRODUCT.id}.pairing`);
  });
});

describe('the identifiers a rename must not touch', () => {
  it('are literals, and stay these exact literals', () => {
    // If a rename lands and this test fails, the fix is to put the old string back —
    // not to update the expectation. Each line below says what breaks otherwise.
    //
    // Deterministic ids are seeded with this. A different seed is a different workspace
    // id for the same workspace: nothing errors, the hub just stops finding yesterday's
    // rows.
    expect(STABLE.idNamespace).toBe('majlis');
    // This is inside every token already signed. Changing it signs everyone out at once,
    // starting with whoever is doing the rename.
    expect(STABLE.jwtIssuer).toBe('majlis');
    // This marks the providers the hub owns inside Hermes's own config.yaml. Changing it
    // orphans them: the hub stops recognising what it put there and Hermes keeps using it.
    expect(STABLE.hermesProviderPrefix).toBe('majlis-');
  });

  it('are not tied to the product name, which is the point', () => {
    // They happen to match today. The test above is what keeps them from moving when
    // PRODUCT.id does.
    expect(typeof STABLE.idNamespace).toBe('string');
    expect(STABLE.idNamespace).not.toBe(derived.envPrefix);
  });
});
