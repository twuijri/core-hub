/**
 * Asking the person before an agent uses a program on this computer (ADR 0025): once per
 * session, in a native dialog — Allow (this call), Allow for this session, or Deny — whether
 * the agent runs on a hub on a server or on the hub on this computer. "This session" lasts
 * until the app quits or the program is switched off. One dialog at a time: a second call that
 * arrives while the person is still deciding waits for that answer.
 */
export type ConsentAnswer = 'once' | 'session' | 'deny';

export interface ConsentQuestion {
  programId: string;
  programName: string;
  tool: string;
  /** Where the agent runs: the hub on this computer, or a hub elsewhere (its address). */
  via: 'local' | 'hub';
  hub: string | null;
  profile: string | null;
}

export class ConsentGate {
  private readonly allowed = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly ask: (question: ConsentQuestion) => Promise<ConsentAnswer>) {}

  /** Whether this call may go ahead; asks the person when this session has no answer yet. */
  check(question: ConsentQuestion): Promise<boolean> {
    const next = this.chain.then(async () => {
      if (this.allowed.has(question.programId)) return true;
      let answer: ConsentAnswer;
      try {
        answer = await this.ask(question);
      } catch {
        answer = 'deny';
      }
      if (answer === 'session') this.allowed.add(question.programId);
      return answer !== 'deny';
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Whether the person already allowed this program for the session. */
  allowedForSession(programId: string): boolean {
    return this.allowed.has(programId);
  }

  /** Switched off, or its settings changed: the next use asks again. */
  forget(programId?: string): void {
    if (programId === undefined) this.allowed.clear();
    else this.allowed.delete(programId);
  }
}
