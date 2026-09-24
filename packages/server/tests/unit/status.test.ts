/**
 * `docs/STATUS.md` says how much of the contract this hub actually implements. This test
 * is what stops that number from being a wish.
 *
 * The hub itself knows: every contract operation nobody mounted is registered as the
 * documented `501` stub and listed in `app.hub.stubs`. So the count is measured, not
 * maintained — and the rule is one-directional on purpose: **the document may understate
 * what is built, never overstate it.** A module that lands without its line being updated
 * makes the document stale, which is a nuisance; a module that was never built while the
 * document says it was is a lie, which is not allowed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOperations, loadOpenApiDocument } from '@corehub/contracts';
import { testHub } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** `GET /api/v1/agents/{agent_id}` -> the pattern `app.hub.stubs` records. */
function patternOf(op: { method: string; path: string }): string {
  return `${op.method.toUpperCase()} /api/v1${op.path.replace(/\{(\w+)\}/g, ':$1')}`;
}

describe('what the hub says it implements', () => {
  it('implements at least as many operations as docs/STATUS.md claims', async () => {
    const hub = await testHub();
    try {
      const document = loadOpenApiDocument();
      expect(document, 'packages/contracts/openapi.yaml').toBeTruthy();
      const operations = listOperations(document!);
      const stubs = new Set(hub.app.hub.stubs);
      const implemented = operations.filter((op) => !stubs.has(patternOf(op))).length;

      const status = readFileSync(path.join(repoRoot, 'docs/STATUS.md'), 'utf8');
      const claim = /\*\*(\d+) of (\d+) contract operations are implemented\.\*\*/.exec(status);
      expect(claim, 'docs/STATUS.md must state the count').toBeTruthy();

      const [, claimedImplemented, claimedTotal] = claim!;
      expect(Number(claimedTotal), 'the contract grew or shrank: update docs/STATUS.md').toBe(
        operations.length,
      );
      expect(
        implemented,
        `docs/STATUS.md claims ${claimedImplemented} implemented; the hub answers ${implemented}`,
      ).toBeGreaterThanOrEqual(Number(claimedImplemented));
    } finally {
      await hub.close();
    }
  });
});
