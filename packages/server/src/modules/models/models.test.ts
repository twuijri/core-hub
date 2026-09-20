import { describe, it } from 'vitest';
import { modelsModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: models', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(modelsModule);
  });
});
