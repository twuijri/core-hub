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
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_MS = 24 * 60 * 60_000;
const PREFIX = 'chgw_';
/**
 * A Hermes profile's token (DECISIONS §143): long-lived, because Hermes is — its channels and cron
 * run at night and read the token from its `.env`. It names the profile and is signed with a
 * secret of the hub's (`<DATA_DIR>/gateway/hermes-token.key`), so it survives a hub restart without
 * being stored anywhere but that profile's own `.env`; a new secret revokes every one.
 */
const HERMES_PREFIX = 'chgwh_';

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

/** A provider said a model's quota is spent (or every credential for it is cooling down). */
export interface GatewayQuotaFailure {
  providerId: string;
  model: string;
  /** The provider's name as the person gave it, and the model's: never the hub's internal ids. */
  providerLabel: string;
  modelLabel: string;
  /** The provider's own words, with the hub's internal names taken out. */
  said: string;
}

/** The turn moved on to the next model of the profile's fallback chain (contract §54). */
export interface GatewayFallback {
  failed: GatewayQuotaFailure;
  answered: { providerId: string; model: string; modelLabel: string };
}

/** The turn a token serves right now. */
export interface GatewayTurn {
  runId: string;
  providerId: string;
  model: string;
  /** The turn's totals so far, per model, after each call (cumulative, as adapters report). */
  report(usage: GatewayTurnUsage): void;
  /**
   * The profile's fallback chain after the turn's model (contract decision §54): where a turn
   * whose provider says its quota is spent moves on to. Absent or empty: nowhere.
   */
  fallbacks?: readonly { providerId: string; model: string }[];
  /** The provider is limiting for now: the gateway waits this long once, then asks again. */
  waiting?(wait: { providerLabel: string; modelLabel: string; seconds: number }): void;
  /** The turn's model is out of quota and nothing of the chain could take over. */
  exhausted?(failure: GatewayQuotaFailure): void;
  /** The turn moved on down the chain. */
  fellBack?(move: GatewayFallback): void;
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
  /** This turn's models a provider said are out of quota (`<row>\n<model>`): not asked again. */
  exhausted: Set<string>;
  /** The chain's model this turn moved on to, once its own ran out. */
  redirect: { providerId: string; model: string } | null;
  /** This turn's models the gateway already waited once for (a passing limit). */
  waited: Set<string>;
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
      exhausted: new Set(),
      redirect: null,
      waited: new Set(),
    };
    this.records.set(token, record);
    return record;
  }

  /**
   * The Hermes token of a profile: `chgwh_<workspace, base64url>.<signature>`. Null without a secret (a hub
   * whose gateway cannot serve Hermes).
   */
  hermesToken(workspace: string, secret: Buffer | null): string | null {
    if (!secret || !workspace || workspace.length > 200) return null;
    // The workspace in base64url: a Hermes profile the hub has no workspace for is
    // `hermes-profile:<name>`, and a token is one word.
    const named = Buffer.from(workspace, 'utf8').toString('base64url');
    return `${HERMES_PREFIX}${named}.${hermesSignature(workspace, secret)}`;
  }

  /** The grant of a Hermes profile's token, made when first presented (stateless, signed). */
  private hermesGrant(presented: string, secret: Buffer | null): GatewayGrantRecord | null {
    if (!secret) return null;
    const match = /^chgwh_([A-Za-z0-9_-]{1,280})\.([A-Za-z0-9_-]+)$/.exec(presented);
    if (!match) return null;
    const workspace = Buffer.from(match[1]!, 'base64url').toString('utf8');
    const expected = Buffer.from(hermesSignature(workspace, secret));
    const given = Buffer.from(match[2]!);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const known = this.records.get(presented);
    if (known) return known;
    const record: GatewayGrantRecord = {
      workspace,
      agentId: 'hermes',
      agentSlug: 'hermes',
      sessionId: '',
      userId: null,
      alive: () => true,
      token: presented,
      expiresAt: Number.POSITIVE_INFINITY,
      turn: null,
      lastRunId: null,
      selection: null,
      totals: new Map(),
      revoked: false,
      exhausted: new Set(),
      waited: new Set(),
      redirect: null,
    };
    this.records.set(presented, record);
    return record;
  }

  /** The live record a presented token names, or null (unknown, revoked, expired, process gone). */
  resolve(
    presented: string | null | undefined,
    hermesSecret: Buffer | null = null,
  ): GatewayGrantRecord | null {
    if (presented?.startsWith(HERMES_PREFIX)) return this.hermesGrant(presented, hermesSecret);
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
      if (record.turn?.runId !== turn.runId) {
        record.totals.clear();
        // A new turn asks again: a quota may have come back, and the person may have picked
        // another model.
        if (record.lastRunId !== turn.runId) {
          record.exhausted.clear();
          record.waited.clear();
          record.redirect = null;
        }
      }
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

function hermesSignature(workspace: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(`hermes:${workspace}`).digest('base64url');
}
