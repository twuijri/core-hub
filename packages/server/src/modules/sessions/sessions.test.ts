import { describe, it } from 'vitest';
import { sessionsModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: sessions', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(sessionsModule);
  });
});
