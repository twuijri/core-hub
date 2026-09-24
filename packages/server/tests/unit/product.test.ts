/**
 * The rename, proved rather than promised.
 *
 * `contracts/product.ts` splits the product's name from its old one and from the identifier
 * a rename must not touch. This checks the split holds **where it is used**: that the
 * things named after the product really do come from one constant, that the old names are
 * still accepted where something older may say them, and that the frozen seed is frozen —
 * because the way that mistake shows up is silence, not an error.
 */
import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { LEGACY, PRODUCT, STABLE, derived } from '@corehub/contracts';
import { RUN_FILES_DIR } from '../../src/modules/sessions/run-files.js';
import {
  HERMES_PROVIDER_PREFIX,
  LEGACY_HERMES_PROVIDER_PREFIX,
  hermesKeyEnvOf,
  legacyHermesKeyEnvOf,
} from '../../src/modules/models/catalogue.js';
import { LOCAL_OWNER_ID, derivedId } from '../../src/modules/sessions/scope.js';
import { JWT_ISSUER, verifyAccessToken } from '../../src/modules/auth/tokens.js';
import { mintSessionRef } from '../../src/modules/agents/runner.js';
import { testHub } from './helpers.js';

describe('what follows the product name', () => {
  it('is one constant, not a string typed in each file', () => {
    expect(RUN_FILES_DIR).toBe(derived.runFilesDir);
    expect(derived.runFilesDir).toBe('.corehub');
    expect(HERMES_PROVIDER_PREFIX).toBe('corehub-');
    expect(hermesKeyEnvOf('custom-cli-proxy-api', undefined)).toBe(
      'COREHUB_PROVIDER_CUSTOM_CLI_PROXY_API_API_KEY',
    );
    expect(mintSessionRef('hermes', '01ABC')).toBe('corehub-01abc');
    expect(JWT_ISSUER).toBe('corehub');
  });

  it('is the name the hub introduces itself with', async () => {
    const hub = await testHub();
    try {
      const response = await hub.app.inject({ method: 'GET', url: '/api/v1/meta' });
      expect((response.json() as { name: string }).name).toBe(PRODUCT.name);
      expect(PRODUCT.name).toBe('Core Hub');
    } finally {
      await hub.close();
    }
  });
});

describe('what the product was called before', () => {
  it('still names the provider blocks and key variables the hub migrates', () => {
    expect(LEGACY_HERMES_PROVIDER_PREFIX).toBe('majlis-');
    expect(legacyHermesKeyEnvOf('COREHUB_PROVIDER_LAB_API_KEY')).toBe(
      'MAJLIS_PROVIDER_LAB_API_KEY',
    );
    // A name the world agrees on has no old name: it was never the hub's.
    expect(legacyHermesKeyEnvOf('GROQ_API_KEY')).toBeNull();
  });

  it('still signs nobody out: a token from before the rename is accepted', async () => {
    const key = new Uint8Array(32).fill(7);
    const now = Date.now();
    const iat = Math.floor(now / 1000);
    const old = await new SignJWT({ role: 'admin', sid: 'S1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(LEGACY.jwtIssuer)
      .setSubject('U1')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(key);
    await expect(verifyAccessToken(key, old, now)).resolves.toMatchObject({ sub: 'U1' });
    const stranger = await new SignJWT({ role: 'admin', sid: 'S1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('someone-else')
      .setSubject('U1')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(key);
    await expect(verifyAccessToken(key, stranger, now)).rejects.toThrow();
  });
});

describe('what must survive a rename', () => {
  it('derives the same local owner id whatever the product is called', () => {
    // The id is a hash of a namespace and a name. A different namespace is a different
    // id for the same thing — and nothing errors, which is what makes it dangerous.
    expect(STABLE.idNamespace).toBe('majlis');
    expect(LOCAL_OWNER_ID).toBe(derivedId('majlis.user', 'local-owner'));
  });
});
