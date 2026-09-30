/**
 * The usage ledger keeps one row per (run, model): an adapter's running totals replace it, and a
 * writer that reports each call on its own (the model gateway's call that ended after its turn,
 * ADR 0029) adds to it instead.
 */
import { describe, expect, it } from 'vitest';
import { memoryDb } from '../../../tests/unit/helpers.js';
import { AuditService } from './service.js';

const base = {
  workspace: '01KWORKSPACE00000000000000',
  ownerId: '01KOWNER000000000000000000',
  runId: '01KRUN00000000000000000000',
  sessionId: '01KSESSION0000000000000000',
  agentId: '01KAGENT000000000000000000',
  providerId: null,
  modelLabel: 'Coder',
};

describe('usage ledger', () => {
  it('replaces a running total, and adds a per-call report', () => {
    const audit = new AuditService(memoryDb() as never);
    audit.recordUsage({
      ...base,
      inputTokens: 10,
      outputTokens: 2,
      costMicroUsd: 5,
      costSource: 'estimated',
    });
    audit.recordUsage({
      ...base,
      inputTokens: 25,
      outputTokens: 6,
      costMicroUsd: 12,
      costSource: 'estimated',
    });
    expect(audit.totalsForRun(base.workspace, base.runId)).toMatchObject({
      inputTokens: 25,
      outputTokens: 6,
      costMicroUsd: 12,
    });
    audit.recordUsage({
      ...base,
      inputTokens: 7,
      outputTokens: 1,
      cacheReadTokens: 3,
      costMicroUsd: 4,
      costSource: 'estimated',
      accumulate: true,
    });
    audit.recordUsage({
      ...base,
      inputTokens: 1,
      outputTokens: 1,
      costSource: 'unknown',
      accumulate: true,
    });
    expect(audit.totalsForRun(base.workspace, base.runId)).toMatchObject({
      inputTokens: 33,
      outputTokens: 8,
      cacheReadTokens: 3,
      costMicroUsd: 16,
    });
    // A per-call report for a run with no row yet starts it.
    audit.recordUsage({
      ...base,
      runId: '01KRUN00000000000000000001',
      inputTokens: 4,
      accumulate: true,
    });
    expect(audit.totalsForRun(base.workspace, '01KRUN00000000000000000001')).toMatchObject({
      inputTokens: 4,
    });
  });
});
