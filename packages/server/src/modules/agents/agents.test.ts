import { describe, it } from 'vitest';
import { agentsModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: agents', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(agentsModule);
  });
});
