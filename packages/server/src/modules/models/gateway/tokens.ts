/**
 * The model gateway's session tokens (ADR 0029 §Tokens).
 *
 * The hub mints one when it starts a coding agent's process for a conversation and hands it to
 * that process only, in place of any provider key. It names the profile, the person, the agent
 * and the conversation; the model it resolves to is the one the current turn chose, set by the
 * hub before each turn (`setTurn`). It lives in the hub's memory only, dies with the process
 * (`alive`), is revoked when the hub closes the session, and expires after `TOKEN_TTL_MS` in any
 * case. A token the hub does not hold is refused, whoever sends it.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_MS = 24 * 60 * 60_000;
const PREFIX = 'chgw_';

/** One call's usage, priced, as the gateway reports it to a turn. */
export interface GatewayTurnUsage {
  modelLabel: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costMicroUsd?: number;
  costSource: 'estimated' | 'unknown';
}

/** The turn a token serves right now. */
export interface GatewayTurn {
  runId: string;
  providerId: string;
  model: string;
  /** The turn's totals so far, per model, after each call (cumulative, as adapters report). */
  report(usage: GatewayTurnUsage): void;
}

export interface GatewayGrantInput {
  workspace: string;
  agentId: string;
  agentSlug: string;
  sessionId: string;
  userId: string | null;
  /** False once the agent's process is gone. */
  alive(): boolean;
}

export interface GatewayGrantRecord extends GatewayGrantInput {
  token: string;
  expiresAt: number;
  turn: GatewayTurn | null;
  /** The last turn's run, for a call that lands after it ended (a background title). */
  lastRunId: string | null;
  /** The last turn's model, for a call made between turns. */
  selection: { providerId: string; model: string } | null;
  /** Per run, per model: what the turn has used so far. */
  totals: Map<string, GatewayTurnUsage>;
  revoked: boolean;
}

export class GatewayTokens {
  private readonly records = new Map<string, GatewayGrantRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(input: GatewayGrantInput): GatewayGrantRecord {
    this.sweep();
    const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
    const record: GatewayGrantRecord = {
      ...input,
      token,
      expiresAt: this.now() + TOKEN_TTL_MS,
      turn: null,
      lastRunId: null,
      selection: null,
      totals: new Map(),
      revoked: false,
    };
    this.records.set(token, record);
    return record;
  }

  /** The live record a presented token names, or null (unknown, revoked, expired, process gone). */
  resolve(presented: string | null | undefined): GatewayGrantRecord | null {
    if (!presented || !presented.startsWith(PREFIX)) return null;
    const record = this.records.get(presented);
    if (!record) return null;
    // The map lookup found it; compare in constant time all the same.
    const a = Buffer.from(record.token);
    const b = Buffer.from(presented);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (record.revoked || this.now() > record.expiresAt || !record.alive()) {
      this.records.delete(presented);
      return null;
    }
    return record;
  }

  setTurn(record: GatewayGrantRecord, turn: GatewayTurn | null): void {
    if (turn) {
      if (record.turn?.runId !== turn.runId) record.totals.clear();
      record.lastRunId = turn.runId;
      record.selection = { providerId: turn.providerId, model: turn.model };
    }
    record.turn = turn;
  }

  revoke(record: GatewayGrantRecord): void {
    record.revoked = true;
    record.turn = null;
    this.records.delete(record.token);
  }

  /** How many tokens are live (tests, diagnostics). */
  get size(): number {
    return this.records.size;
  }

  private sweep(): void {
    const at = this.now();
    for (const [token, record] of this.records) {
      if (record.revoked || at > record.expiresAt || !record.alive()) this.records.delete(token);
    }
  }
}
