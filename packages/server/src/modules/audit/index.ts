// Module `audit`: owns usage, costs, logs, performance snapshots and jobs.
// Public surface of the module: other modules and app/ import this file only.
//
// Phase 0 uses the write side only: `sessions` records what a run cost and
// runs a run as a job (invariant 4). The read side (`audit.getReport`) is a
// Phase 4 screen and stays `501` through the app's contract stubs, as does
// the jobs kernel (`jobs.list` / `jobs.get` / `jobs.cancel`, `/rt/jobs`).
import { defineModule } from '../../lib/module.js';

export const auditModule = defineModule({
  name: 'audit',
  registerRoutes(_app) {
    // `audit.getReport` is Phase 4 (docs/ROADMAP.md); it answers 501 until then.
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = auditModule.registerRoutes.bind(auditModule);
export const registerEvents = auditModule.registerEvents.bind(auditModule);

export { AuditService } from './service.js';
export type {
  CostSource,
  JobCreate,
  JobStatus,
  UsageOrigin,
  UsageTotals,
  UsageWrite,
} from './service.js';
