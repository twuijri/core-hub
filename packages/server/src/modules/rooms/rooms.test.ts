import { describe, it } from 'vitest';
import { roomsModule } from './index.js';
import { expectModuleRegistered } from '../../../tests/unit/helpers.js';

describe('module: rooms', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(roomsModule);
  });
});
