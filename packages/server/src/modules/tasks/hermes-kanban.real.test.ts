/**
 * The bridge against **the real Hermes kanban**, not a fake that agrees with us.
 *
 * It runs the pinned release's own CLI from source (`tests/fixtures/hermes-kanban.py`),
 * so every argv is parsed by Hermes's argparse and executed by Hermes's command code, on
 * a real board in a throwaway `HERMES_HOME`.
 *
 * It needs a checkout of Hermes at the release the image pins. Point `HERMES_SRC` at one
 * and it runs; without it the suite is skipped **and says why**, rather than passing
 * silently:
 *
 *   git clone --depth 1 --branch v2026.9.14 https://github.com/NousResearch/hermes-agent
 *   HERMES_SRC=$PWD/hermes-agent pnpm --filter @corehub/server test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HermesRefusal,
  createHermesKanban,
  processRunner,
  type HermesKanban,
} from './hermes-kanban.js';

const source = process.env.HERMES_SRC;
const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.resolve(here, '../../../tests/fixtures/hermes-kanban.py');

describe.skipIf(!source)(
  'the bridge against the real Hermes kanban (set HERMES_SRC to a v2026.9.14 checkout)',
  () => {
    let home: string;
    let kanban: HermesKanban;

    beforeAll(() => {
      home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-kanban-'));
      kanban = createHermesKanban(
        processRunner({
          command: 'python3',
          prefix: [shim],
          home,
          env: { PATH: process.env.PATH, PYTHONPATH: source },
        }),
      );
    });
    afterAll(() => rmSync(home, { recursive: true, force: true }));

    it('creates a card Hermes then lists, in the language it was written in', async () => {
      const card = await kanban.create({
        title: 'جرّب الجسر',
        body: 'من المركز',
        idempotencyKey: '01J8QK3ZR2W7M5N4P6T8V9X0A1',
      });
      expect(card.id).toMatch(/^t_[0-9a-f]{8}$/);
      // Without --triage, Hermes files a new card as ready.
      expect(card.status).toBe('ready');
      const listed = await kanban.list();
      expect(listed.find((t) => t.id === card.id)?.title).toBe('جرّب الجسر');
    });

    it('returns the same card when a create is retried with the same key', async () => {
      const key = '01J8QK3ZR2W7M5N4P6T8V9X0A2';
      const first = await kanban.create({ title: 'مرّة', idempotencyKey: key });
      const again = await kanban.create({ title: 'مرّة', idempotencyKey: key });
      expect(again.id).toBe(first.id);
    });

    it('moves a card through the verbs the board offers, and Hermes agrees', async () => {
      const card = await kanban.create({
        title: 'دورة',
        idempotencyKey: '01J8QK3ZR2W7M5N4P6T8V9X0A3',
      });
      const expectStatus = async (status: string) =>
        expect((await kanban.show(card.id))?.status).toBe(status);

      await kanban.move(card.id, 'ready', 'blocked', 'ننتظر المفتاح');
      await expectStatus('blocked');
      await kanban.move(card.id, 'blocked', 'ready');
      await expectStatus('ready');
      await kanban.move(card.id, 'ready', 'review');
      await expectStatus('review');
      await kanban.move(card.id, 'review', 'done');
      await expectStatus('done');
      await kanban.move(card.id, 'done', 'archived');
      await expectStatus('archived');
    });

    it('lands a card sent back to todo on ready — the same column, Hermes’s choice', async () => {
      const card = await kanban.create({
        title: 'رجوع',
        idempotencyKey: '01J8QK3ZR2W7M5N4P6T8V9X0A4',
      });
      await kanban.move(card.id, 'ready', 'blocked', 'x');
      await kanban.move(card.id, 'blocked', 'todo');
      expect((await kanban.show(card.id))?.status).toBe('ready');
    });

    it('relays Hermes’s refusal in Hermes’s words', async () => {
      const card = await kanban.create({
        title: 'رفض',
        idempotencyKey: '01J8QK3ZR2W7M5N4P6T8V9X0A5',
      });
      await kanban.move(card.id, 'ready', 'scheduled', 'later');
      const refused = kanban.move(card.id, 'todo', 'ready');
      await expect(refused).rejects.toBeInstanceOf(HermesRefusal);
      await expect(refused).rejects.toThrow(/promote only applies to 'todo' or 'blocked'/);
    });
  },
);
