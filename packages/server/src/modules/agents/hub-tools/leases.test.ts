import { describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/index.js', () => {
  let n = 0;
  return { issueRunToken: () => `token-${++n}`, revokeRunToken: () => undefined };
});

const { RunLeases } = await import('./leases.js');

const WS = 'ws-1';
const HUB_CALL = 'mcp__corehub__tasks_list';

function run(leases: InstanceType<typeof RunLeases>, runId: string, userId: string) {
  leases.open({ runId, sessionId: `s-${runId}`, workspaceId: WS, userId });
}

describe("a gateway's call to the hub's tools, with the hub's Hermes conversations inside it", () => {
  it("is a hub run's once that run announced it", async () => {
    const leases = new RunLeases();
    run(leases, 'R1', 'alice');
    // Nothing announced: never a run's, however long it waits.
    expect(await leases.attribute(WS, 0, 'gateway')).toEqual({
      ok: false,
      reason: 'hub_tools_no_live_run',
    });
    leases.toolStarted('R1', HUB_CALL);
    const result = await leases.attribute(WS, 0, 'gateway');
    expect(result.ok && result.lease.userId).toBe('alice');
  });

  it('waits for the announcement that travels separately from the call', async () => {
    const leases = new RunLeases();
    run(leases, 'R1', 'alice');
    const pending = leases.attribute(WS, 500, 'gateway');
    setTimeout(() => leases.toolStarted('R1', HUB_CALL), 60);
    const result = await pending;
    expect(result.ok && result.lease.userId).toBe('alice');
  });

  it("is refused beside somebody else's channel turn once a run announced", async () => {
    const leases = new RunLeases();
    run(leases, 'R1', 'alice');
    leases.openChannel({
      key: 'telegram:1',
      workspaceId: WS,
      userId: null,
      refusal: 'hub_tools_sender_not_linked',
    });
    leases.toolStarted('R1', HUB_CALL);
    expect(await leases.attribute(WS, 0, 'gateway')).toEqual({
      ok: false,
      reason: 'hub_tools_run_ambiguous',
    });
  });

  it("stays the channel turn's when no run announced it", async () => {
    const leases = new RunLeases();
    run(leases, 'R1', 'alice');
    leases.openChannel({
      key: 'telegram:2',
      workspaceId: WS,
      userId: null,
      refusal: 'hub_tools_sender_not_linked',
    });
    expect(await leases.attribute(WS, 0, 'gateway')).toEqual({
      ok: false,
      reason: 'hub_tools_sender_not_linked',
    });
  });

  it('acts for one person when the run and the channel turn are both theirs', async () => {
    const leases = new RunLeases();
    run(leases, 'R1', 'alice');
    leases.openChannel({
      key: 'telegram:3',
      workspaceId: WS,
      userId: 'alice',
      refusal: null,
    });
    leases.toolStarted('R1', HUB_CALL);
    const result = await leases.attribute(WS, 0, 'gateway');
    expect(result.ok && result.lease.runId).toBe('R1');
  });

  it("never picks between two people's announced runs", async () => {
    const leases = new RunLeases();
    run(leases, 'R1', 'alice');
    run(leases, 'R2', 'bob');
    leases.toolStarted('R1', HUB_CALL);
    leases.toolStarted('R2', HUB_CALL);
    expect(await leases.attribute(WS, 0, 'gateway')).toEqual({
      ok: false,
      reason: 'hub_tools_run_ambiguous',
    });
  });
});
