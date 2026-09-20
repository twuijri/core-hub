import { describe, it } from 'vitest';
import { schedulesModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: schedules', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(schedulesModule);
  });
});
