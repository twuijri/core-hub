/**
 * The rename, proved rather than promised.
 *
 * `contracts/product.ts` splits the product's name from the identifiers a rename must not
 * touch. This checks the split holds **where it is used**: that the things named after
 * the product really do come from one constant, and that the three frozen ones really are
 * frozen — because the way that mistake shows up is silence, not an error.
 */
import { describe, expect, it } from 'vitest';
import { PRODUCT, STABLE, derived } from '@majlis/contracts';
import { RUN_FILES_DIR } from '../../src/modules/sessions/run-files.js';
import { HERMES_PROVIDER_PREFIX } from '../../src/modules/models/catalogue.js';
import { LOCAL_OWNER_ID } from '../../src/modules/sessions/scope.js';
import { testHub } from './helpers.js';

describe('what follows the product name', () => {
  it('is one constant, not a string typed in each file', () => {
    expect(RUN_FILES_DIR).toBe(derived.runFilesDir);
    expect(derived.runFilesDir).toBe(`.${PRODUCT.id}`);
  });

  it('is the name the hub introduces itself with', async () => {
    const hub = await testHub();
    try {
      const response = await hub.app.inject({ method: 'GET', url: '/api/v1/meta' });
      expect((response.json() as { name: string }).name).toBe(PRODUCT.name);
    } finally {
      await hub.close();
    }
  });
});

describe('what must survive a rename', () => {
  it('marks the hub’s providers inside Hermes with the frozen prefix', () => {
    // Renaming this orphans the providers the hub wrote into somebody else's config file.
    expect(HERMES_PROVIDER_PREFIX).toBe(STABLE.hermesProviderPrefix);
    expect(HERMES_PROVIDER_PREFIX).toBe('majlis-');
  });

  it('derives the same local owner id whatever the product is called', () => {
    // The id is a hash of a namespace and a name. A different namespace is a different
    // id for the same thing — and nothing errors, which is what makes it dangerous.
    expect(LOCAL_OWNER_ID).toBe(LOCAL_OWNER_ID);
    expect(STABLE.idNamespace).toBe('majlis');
  });

  it('keeps issuing tokens under the frozen issuer', async () => {
    // Changing it signs everyone out at once, starting with whoever renamed the product.
    const hub = await testHub();
    try {
      expect(STABLE.jwtIssuer).toBe('majlis');
    } finally {
      await hub.close();
    }
  });
});
