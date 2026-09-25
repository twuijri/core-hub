import { describe, it } from 'vitest';
import { devicesModule } from '../index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: devices', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(devicesModule);
  });
});
