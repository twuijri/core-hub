import { describe, it } from 'vitest';
import { pluginsModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: plugins', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(pluginsModule);
  });
});
