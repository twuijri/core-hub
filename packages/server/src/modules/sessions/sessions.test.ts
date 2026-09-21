import { describe, expect, it } from 'vitest';
import { modules } from '../index.js';
import { sessionsModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: sessions', () => {
  it('is composed by the app with routes and events registered', async () => {
    // The app composes the wired instance (`src/modules/index.ts`: agents + runner + auth
    // scopes), not the unwired default this file exports for tests and demos.
    const composed = modules.find((module) => module.name === 'sessions');
    expect(composed).toBeDefined();
    expect(composed).not.toBe(sessionsModule);
    await expectModuleRegistered(composed!);
  });
});
