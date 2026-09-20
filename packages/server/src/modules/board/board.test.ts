import { describe, it } from 'vitest';
import { boardModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: board', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(boardModule);
  });
});
