import { describe, it } from 'vitest';
import { notifyModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: notify', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(notifyModule);
  });
});
