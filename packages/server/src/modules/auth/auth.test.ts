import { describe, it } from 'vitest';
import { authModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: auth', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(authModule);
  });
});
