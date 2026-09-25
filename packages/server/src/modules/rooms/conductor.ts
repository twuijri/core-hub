/**
 * Agents in the room (DECISIONS §57, part 2): who takes a turn, what it is told, how its reply
 * reaches the room while it is being written, and when the turn passes to another agent.
 *
 * - **A turn** is a run in the seat's own conversation (`sessions`), started with the room as
 *   the seat has not yet seen it (`context.ts`). Its reply is a room message opened at once —
 *   so the room shows who is about to answer — and filled as the run streams: the seat
 *   session's deltas, reasoning and tools are re-emitted on `/rt/rooms` against that message.
 *   When the run ends the message holds the agent's words, or says it failed or was stopped.
 * - **Handoffs.** A reply that mentions another seat passes the turn to it (the first one
 *   mentioned), when the room allows handoffs. A chain starts at the first pass from a turn a
 *   person started and stops at the room's depth cap, or at a loop — the same pass twice in
 *   one chain. A stopped chain may go one more round (`continueHandoff`).
 * - **Stop** cancels a seat's running and queued turns; its chains stop as `interrupted`.
 *
 * One conductor per hub (per Socket.IO server): it holds what is live — which run belongs to
 * which seat and room message, and what each seat is doing — in memory, the way typing is.
 * A restart settles whatever it cut short (`settle`).
 */
import type { FastifyBaseLogger } from 'fastify';
import { HubError, notFound } from '../../lib/errors.js';
import type { EngineScope, SeatSessions, TurnResult } from '../sessions/index.js';
import {
  judgeHandoff,
  mentionedSeats,
  seatPrompt,
  unseenFor,
  type ContextMessage,
  type ContextSeat,
} from './context.js';
import type { RoomsRealtime } from './realtime.js';
import { toChain, toRoomMessage, toSeat, type SeatStatus } from './serialize.js';
import type { RoomLive } from './service.js';
import type { ChainRow, RoomMessageRow, RoomRow, RoomsStore, SeatRow } from './store.js';

type Json = Record<string, unknown>;

interface LiveRun {
  runId: string;
  jobId: string;
  roomId: string;
  seatId: string;
  sessionId: string;
  messageId: string;
  scope: EngineScope;
  chainId: string | null;
}

export interface Dispatched {
  seat_id: string;
  run_id: string;
  job_id: string;
  queue_position: number | null;
}

export class Conductor implements RoomLive {
  private readonly runs = new Map<string, LiveRun>();
  private readonly status = new Map<string, SeatStatus>();
  private readonly settledRuns = new Set<Promise<void>>();
  private listening = false;

  constructor(
    private readonly store: () => RoomsStore,
    private readonly seats: () => SeatSessions | null,
    private readonly realtime: RoomsRealtime,
    private readonly people: (userId: string) => string | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ------------------------------------------------------------- RoomLive

  seatStatus(seatId: string): SeatStatus {
    return this.status.get(seatId) ?? 'idle';
  }

  liveRuns(roomId: string): string[] {
    return [...this.runs.values()].filter((run) => run.roomId === roomId).map((run) => run.runId);
  }

  /** Resolves when every turn started so far has been settled — for tests. */
  async idle(): Promise<void> {
    while (this.settledRuns.size > 0) await Promise.all([...this.settledRuns]);
  }

  // ------------------------------------------------------------- starting turns

  private port(): SeatSessions {
    const port = this.seats();
    if (!port) {
      throw new HubError('agent_unavailable', { details: { status: 'no_runtime' } });
    }
    if (!this.listening) {
      this.listening = true;
      port.listen((profile, sessionId, event, payload) =>
        this.onSessionEvent(profile, sessionId, event, payload),
      );
    }
    return port;
  }

  /**
   * One turn for each seat, after `trigger` (the message that woke them). Each gets a room
   * message at once — the reply it is about to write — and a run in its own conversation.
   * A seat that cannot take the turn (its agent was removed) gets a failed reply saying so
   * rather than silence.
   */
  async dispatch(
    scope: EngineScope,
    room: RoomRow,
    targets: readonly SeatRow[],
    trigger: RoomMessageRow,
    chain: ChainRow | null = null,
  ): Promise<Dispatched[]> {
    const out: Dispatched[] = [];
    for (const seat of targets) {
      try {
        out.push(await this.startTurn(scope, room, seat, trigger, chain));
      } catch (error) {
        this.log.warn({ err: error, seatId: seat.id }, 'rooms: a seat could not take its turn');
        const failed = this.store().appendMessage({
          workspace: room.workspace,
          ownerId: scope.userId,
          roomId: room.id,
          authorKind: 'seat',
          authorName: seat.alias,
          seatId: seat.id,
          sessionId: seat.sessionId,
          content: error instanceof Error ? error.message : String(error),
          parts: [],
          status: 'failed',
        });
        this.realtime.toRoom(scope.profile, room.id, 'message.created', {
          message: toRoomMessage(failed, scope.profile, seat),
        });
        if (chain) this.stopChain(scope, chain, 'error', failed.id, String(failed.content));
      }
    }
    return out;
  }

  private async startTurn(
    scope: EngineScope,
    room: RoomRow,
    seat: SeatRow,
    trigger: RoomMessageRow,
    chain: ChainRow | null,
  ): Promise<Dispatched> {
    const port = this.port();
    const store = this.store();
    const prompt = this.promptFor(room, seat, trigger.seq);
    const handle = await port.start(scope, { sessionId: seat.sessionId, seatId: seat.id, prompt });
    // What the seat has now been shown; the next turn starts after it.
    store.updateSeat(room.id, seat.id, { seenSeq: Math.max(seat.seenSeq, trigger.seq) });
    const reply = store.appendMessage({
      workspace: room.workspace,
      ownerId: scope.userId,
      roomId: room.id,
      authorKind: 'seat',
      authorName: seat.alias,
      seatId: seat.id,
      sessionId: seat.sessionId,
      content: '',
      parts: [],
      runId: handle.runId,
      status: 'streaming',
      replyToId: trigger.id,
    });
    const live: LiveRun = {
      runId: handle.runId,
      jobId: handle.jobId,
      roomId: room.id,
      seatId: seat.id,
      sessionId: seat.sessionId,
      messageId: reply.id,
      scope,
      chainId: chain?.id ?? null,
    };
    this.runs.set(handle.runId, live);
    this.realtime.toRoom(scope.profile, room.id, 'message.created', {
      message: toRoomMessage(reply, scope.profile, seat),
    });
    const run = port.runs(scope, [handle.runId])[0];
    const queued = run?.status === 'queued';
    this.setStatus(scope, room.id, seat, queued ? 'queued' : 'running');
    const settling = handle.done
      .then((result) => this.finish(live, result))
      .catch((error: unknown) =>
        this.log.warn({ err: error, runId: live.runId }, 'rooms: settling a turn failed'),
      );
    this.settledRuns.add(settling);
    void settling.finally(() => this.settledRuns.delete(settling));
    return {
      seat_id: seat.id,
      run_id: handle.runId,
      job_id: handle.jobId,
      queue_position: (run?.queue_position as number | null | undefined) ?? null,
    };
  }

  private promptFor(room: RoomRow, seat: SeatRow, uptoSeq: number): string {
    const store = this.store();
    const seats = store.seats(room.id);
    const from = Math.max(seat.seenSeq, room.contextFromSeq);
    const messages: ContextMessage[] = store
      .messagesAfter(room.id, from)
      .filter((row) => row.seq <= uptoSeq)
      .map((row) => ({
        seq: row.seq,
        authorKind: row.authorKind,
        authorName: row.authorName ?? '',
        seatId: row.seatId ?? null,
        content: row.content,
        status: row.status,
      }));
    const asContext = (row: SeatRow): ContextSeat => ({
      id: row.id,
      name: row.alias,
      description: row.description ?? null,
      instructions: row.persona ?? null,
    });
    return seatPrompt({
      roomName: room.name,
      seat: asContext(seat),
      others: seats.filter((row) => row.id !== seat.id).map(asContext),
      people: store
        .members(room.id)
        .map((member) => this.people(member.userId))
        .filter((name): name is string => !!name),
      summary: room.memory ?? null,
      handoffEnabled: room.handoffEnabled,
      unseen: unseenFor(seat.id, messages),
    });
  }

  // ------------------------------------------------------------- live stream

  private setStatus(scope: EngineScope, roomId: string, seat: SeatRow, next: SeatStatus): void {
    if (this.seatStatus(seat.id) === next) return;
    if (next === 'idle') this.status.delete(seat.id);
    else this.status.set(seat.id, next);
    const fresh = this.store().seat(roomId, seat.id) ?? seat;
    this.realtime.toRoom(scope.profile, roomId, 'seat.updated', {
      room_id: roomId,
      seat: toSeat(fresh, next),
    });
  }

  private runIdOf(payload: Json): string | null {
    const direct = payload.run_id;
    if (typeof direct === 'string') return direct;
    const run = payload.run as { id?: unknown } | undefined;
    if (run && typeof run.id === 'string') return run.id;
    const approval = payload.approval as { run_id?: unknown } | undefined;
    if (approval && typeof approval.run_id === 'string') return approval.run_id;
    return null;
  }

  /** A seat session's event, re-emitted on the room with the room's ids (DECISIONS §1). */
  private onSessionEvent(_profile: string, _sessionId: string, event: string, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const payload = raw as Json;
    const runId = this.runIdOf(payload);
    const live = runId ? this.runs.get(runId) : undefined;
    if (!live) return;
    const seat = this.store().seat(live.roomId, live.seatId);
    if (!seat) return;
    const { scope, roomId } = live;
    const withRoom = (run: unknown) => ({ ...(run as Json), room_id: roomId, seat_id: seat.id });
    switch (event) {
      case 'run.queued':
        this.setStatus(scope, roomId, seat, 'queued');
        this.realtime.toRoom(scope.profile, roomId, event, { run: withRoom(payload.run) });
        return;
      case 'run.started':
        this.setStatus(scope, roomId, seat, 'running');
        this.realtime.toRoom(scope.profile, roomId, event, { run: withRoom(payload.run) });
        return;
      case 'message.delta':
        this.setStatus(scope, roomId, seat, 'running');
        this.realtime.toRoom(scope.profile, roomId, event, {
          session_id: live.sessionId,
          message_id: live.messageId,
          run_id: live.runId,
          delta: String(payload.delta ?? ''),
        });
        return;
      case 'reasoning.delta':
        this.setStatus(scope, roomId, seat, 'thinking');
        this.realtime.toRoom(scope.profile, roomId, event, {
          session_id: live.sessionId,
          message_id: live.messageId,
          run_id: live.runId,
          delta: String(payload.delta ?? ''),
        });
        return;
      case 'tool.started':
      case 'tool.completed':
      case 'tool.failed':
        this.setStatus(scope, roomId, seat, 'running');
        this.realtime.toRoom(scope.profile, roomId, event, {
          session_id: live.sessionId,
          message_id: live.messageId,
          run_id: live.runId,
          tool_call: payload.tool_call,
        });
        return;
      case 'approval.requested':
        this.setStatus(scope, roomId, seat, 'waiting_approval');
        this.realtime.toRoom(scope.profile, roomId, event, { approval: payload.approval });
        return;
      case 'approval.resolved':
        this.setStatus(scope, roomId, seat, 'running');
        this.realtime.toRoom(scope.profile, roomId, event, { approval: payload.approval });
        return;
      default:
        // run.completed / failed / cancelled are the room's to announce, once its message
        // holds the reply (`finish`).
        return;
    }
  }

  // ------------------------------------------------------------- endings

  private async finish(live: LiveRun, result: TurnResult): Promise<void> {
    this.runs.delete(live.runId);
    const store = this.store();
    const { scope } = live;
    const room = store.getRoom(scope.workspace, live.roomId);
    const seat = room ? store.seat(room.id, live.seatId) : undefined;
    if (!room || !seat) return;
    const port = this.seats();
    const run = port?.runs(scope, [live.runId])[0];
    const usage = (run?.usage as Json | null | undefined) ?? null;
    const status =
      result.status === 'succeeded'
        ? 'complete'
        : result.status === 'cancelled'
          ? 'interrupted'
          : 'failed';
    const text =
      status === 'complete' ? result.output : result.output || result.error || result.status;
    const message = store.updateMessage(live.messageId, {
      content: text,
      parts: text ? [{ type: 'text', text }] : [],
      status,
      usage,
    }) as RoomMessageRow;
    const tokens =
      Number((usage as { input_tokens?: number } | null)?.input_tokens ?? 0) +
      Number((usage as { output_tokens?: number } | null)?.output_tokens ?? 0);
    const fresh = tokens
      ? (store.updateRoom(scope.workspace, room.id, { totalTokens: room.totalTokens + tokens }) ??
        room)
      : room;
    if (![...this.runs.values()].some((other) => other.seatId === seat.id)) {
      this.setStatus(scope, room.id, seat, 'idle');
    }
    const wire = { ...(run ?? { id: live.runId }), room_id: room.id, seat_id: seat.id };
    const payloadMessage = toRoomMessage(message, scope.profile, seat);
    if (status === 'complete') {
      this.realtime.toRoom(scope.profile, room.id, 'run.completed', {
        run: wire,
        message: payloadMessage,
      });
    } else {
      this.realtime.toRoom(scope.profile, room.id, 'message.created', { message: payloadMessage });
      this.realtime.toRoom(
        scope.profile,
        room.id,
        status === 'interrupted' ? 'run.cancelled' : 'run.failed',
        { run: wire },
      );
    }
    if (tokens) {
      this.realtime.toRoom(scope.profile, room.id, 'room.updated', {
        room: this.roomSummary(scope, fresh),
      });
    }
    await this.afterReply(scope, fresh, seat, message, live.chainId, status);
  }

  /** `room.updated` as every member may see it: no invite code, no manage flag. */
  private roomSummary(scope: EngineScope, room: RoomRow): Json {
    const store = this.store();
    return {
      id: room.id,
      profile: scope.profile,
      owner_id: room.ownerId,
      created_at: room.createdAt.toISOString(),
      updated_at: room.updatedAt.toISOString(),
      name: room.name,
      working_dir: room.workingDir ?? null,
      invite_code: null,
      can_manage: false,
      can_mention_all: room.canMentionAll,
      member_count: store.memberCounts([room.id]).get(room.id) ?? 0,
      total_tokens: room.totalTokens,
      summary_policy: {
        every_turns: room.summaryEveryTurns,
        model: room.summaryModel ?? null,
        provider: room.summaryProvider ?? null,
      },
      handoff: { enabled: room.handoffEnabled, max_depth: room.handoffMaxDepth ?? null },
      seats: store.seats(room.id).map((row) => toSeat(row, this.seatStatus(row.id))),
      last_active_at: room.lastMessageAt ? room.lastMessageAt.toISOString() : null,
      lead_seat_id: room.leadSeatId ?? null,
      archived_at: room.archivedAt ? room.archivedAt.toISOString() : null,
    };
  }

  /**
   * After a reply: does it pass the turn? Only a finished reply, only while the room allows
   * handoffs, and only to a seat still in the room. A chain that carried this turn completes
   * when the reply passes nothing on, and fails when the turn failed.
   */
  private async afterReply(
    scope: EngineScope,
    room: RoomRow,
    seat: SeatRow,
    reply: RoomMessageRow,
    chainId: string | null,
    status: 'complete' | 'failed' | 'interrupted',
  ): Promise<void> {
    const store = this.store();
    const chain = chainId ? (store.chain(room.id, chainId) ?? null) : null;
    if (chain && chain.status !== 'active') return;
    if (status !== 'complete') {
      if (chain) {
        if (status === 'interrupted') this.stopChain(scope, chain, 'interrupted', reply.id, null);
        else this.endChain(scope, chain, 'failed', reply.content || 'failed');
      }
      return;
    }
    const others = store.seats(room.id).filter((row) => row.id !== seat.id);
    const target = room.handoffEnabled
      ? mentionedSeats(
          reply.content,
          others.map((row) => ({ id: row.id, name: row.alias, row })),
          seat.id,
        )[0]?.row
      : undefined;
    if (!target) {
      if (chain) this.endChain(scope, chain, 'completed', null);
      return;
    }
    let next: ChainRow;
    if (!chain) {
      next = store.createChain({
        room,
        ownerId: scope.userId,
        fromSeatId: seat.id,
        toSeatId: target.id,
        maxDepth: room.handoffMaxDepth ?? null,
        lastMessageId: reply.id,
      });
    } else {
      const verdict = judgeHandoff({
        from: seat.id,
        to: target.id,
        depth: chain.depth,
        visited: chain.visited ?? [],
        maxDepth: chain.maxDepth ?? null,
      });
      if (!verdict.go) {
        store.updateChain(chain.id, { fromSeatId: seat.id, toSeatId: target.id });
        this.stopChain(scope, store.chain(room.id, chain.id)!, verdict.reason, reply.id, null);
        return;
      }
      next = store.updateChain(chain.id, {
        fromSeatId: seat.id,
        toSeatId: target.id,
        depth: verdict.depth,
        visited: verdict.visited,
        lastMessageId: reply.id,
      }) as ChainRow;
    }
    await this.pass(scope, room, seat, target, reply, next);
  }

  /** The turn goes to `target`: the reply says so, the chain says so, and the target runs. */
  private async pass(
    scope: EngineScope,
    room: RoomRow,
    from: SeatRow,
    target: SeatRow,
    reply: RoomMessageRow,
    chain: ChainRow,
  ): Promise<Dispatched[]> {
    const store = this.store();
    const marked = store.updateMessage(reply.id, {
      handoff: { to_seat_id: target.id, chain_id: chain.id, depth: chain.depth },
      mentionList: [{ kind: 'seat', seat_id: target.id }],
    }) as RoomMessageRow;
    this.realtime.toRoom(scope.profile, room.id, 'message.created', {
      message: toRoomMessage(marked, scope.profile, from),
    });
    this.realtime.toRoom(scope.profile, room.id, 'handoff.updated', {
      room_id: room.id,
      chain: toChain(chain),
    });
    const fresh = store.getRoom(scope.workspace, room.id) ?? room;
    return this.dispatch(scope, fresh, [target], marked, chain);
  }

  private stopChain(
    scope: EngineScope,
    chain: ChainRow,
    reason: 'max_depth' | 'loop_detected' | 'interrupted' | 'error',
    lastMessageId: string | null,
    error: string | null,
  ): void {
    const stopped = this.store().updateChain(chain.id, {
      status: reason === 'error' ? 'failed' : 'stopped',
      stopReason: reason,
      error,
      ...(lastMessageId ? { lastMessageId } : {}),
    }) as ChainRow;
    this.realtime.toRoom(scope.profile, chain.roomId, 'handoff.updated', {
      room_id: chain.roomId,
      chain: toChain(stopped),
    });
  }

  private endChain(
    scope: EngineScope,
    chain: ChainRow,
    status: 'completed' | 'failed',
    error: string | null,
  ): void {
    const ended = this.store().updateChain(chain.id, {
      status,
      error,
      stopReason: status === 'failed' ? 'error' : null,
    }) as ChainRow;
    this.realtime.toRoom(scope.profile, chain.roomId, 'handoff.updated', {
      room_id: chain.roomId,
      chain: toChain(ended),
    });
  }

  // ------------------------------------------------------------- operations

  /** `rooms.continueHandoff`: one more pass for a stopped chain, through the guard once. */
  async continueChain(
    scope: EngineScope,
    room: RoomRow,
    chainId: string,
  ): Promise<{ job_id: string }> {
    const store = this.store();
    const chain = store.chain(room.id, chainId);
    if (!chain) throw notFound({ resource: 'handoff_chain', id: chainId });
    if (chain.status !== 'stopped' || chain.continueUsed) {
      throw new HubError('state_invalid', {
        details: { reason: chain.continueUsed ? 'continue_used' : 'chain_not_stopped' },
      });
    }
    const target = store.seat(room.id, chain.toSeatId);
    const trigger = chain.lastMessageId ? store.message(room.id, chain.lastMessageId) : undefined;
    const from = store.seat(room.id, chain.fromSeatId);
    if (!target || target.status === 'left' || !trigger || !from) {
      throw new HubError('state_invalid', { details: { reason: 'chain_target_gone' } });
    }
    const verdict = judgeHandoff({
      from: chain.fromSeatId,
      to: chain.toSeatId,
      depth: chain.depth,
      visited: chain.visited ?? [],
      maxDepth: chain.maxDepth ?? null,
      once: true,
    });
    const next = store.updateChain(chain.id, {
      status: 'active',
      stopReason: null,
      continueUsed: true,
      depth: verdict.depth,
      visited: verdict.go ? verdict.visited : (chain.visited ?? []),
      // One more round: the cap moves by the one pass it lets through.
      maxDepth: chain.maxDepth === null ? null : Math.max(chain.maxDepth, verdict.depth),
    }) as ChainRow;
    const started = await this.pass(scope, room, from, target, trigger, next);
    const first = started[0];
    if (!first) throw new HubError('agent_unavailable', { details: { seat_id: target.id } });
    return { job_id: first.job_id };
  }

  /** `rooms.stopSeat`: every running and queued turn of the seat is cancelled. */
  async stopSeat(scope: EngineScope, room: RoomRow, seat: SeatRow): Promise<void> {
    const port = this.seats();
    const mine = [...this.runs.values()].filter((run) => run.seatId === seat.id);
    for (const run of mine) {
      await port?.cancel(scope, run.sessionId, run.runId);
    }
    for (const chain of this.store().chains(room.id, true)) {
      if (chain.fromSeatId === seat.id || chain.toSeatId === seat.id) {
        this.stopChain(scope, chain, 'interrupted', null, null);
      }
    }
  }

  /** Every live turn of a room (a delete, a cleared context). */
  async stopRoom(scope: EngineScope, roomId: string): Promise<void> {
    const port = this.seats();
    for (const run of [...this.runs.values()].filter((r) => r.roomId === roomId)) {
      await port?.cancel(scope, run.sessionId, run.runId).catch(() => {});
    }
  }

  /**
   * After a restart: a reply left streaming belongs to a run the restart ended. It is closed
   * with how the run stands (the sessions module fails such runs at boot), and a chain left
   * active is stopped as interrupted — nobody is left to carry it.
   */
  settle(): number {
    const store = this.store();
    const port = this.seats();
    let settled = 0;
    for (const message of store.streamingMessages()) {
      const outcome = message.runId ? port?.outcome(message.workspace, message.runId) : null;
      const text = outcome?.output || outcome?.error || '';
      store.updateMessage(message.id, {
        status: outcome?.status === 'succeeded' ? 'complete' : 'interrupted',
        content: text,
        parts: text ? [{ type: 'text', text }] : [],
      });
      settled += 1;
    }
    store.stopActiveChains();
    return settled;
  }
}
