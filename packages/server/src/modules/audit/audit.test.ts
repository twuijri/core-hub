import { describe, it } from 'vitest';
import { auditModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: audit', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(auditModule);
  });
});
