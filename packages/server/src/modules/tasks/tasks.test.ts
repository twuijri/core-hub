import { describe, it } from 'vitest';
import { tasksModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: tasks', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(tasksModule);
  });
});
