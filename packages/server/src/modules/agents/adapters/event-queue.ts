/**
 * Async queue shared by the adapters: producers push events as they arrive over the wire,
 * the consumer awaits them in order. One queue lives for the life of an `AgentSession`;
 * every turn reads from it until its own terminal event.
 */
import type { AgentEvent } from './types.js';

export class EventQueue {
  private readonly buffer: AgentEvent[] = [];
  private readonly waiting: ((value: IteratorResult<AgentEvent>) => void)[] = [];
  private done = false;

  get closed(): boolean {
    return this.done;
  }

  push(event: AgentEvent): void {
    if (this.done) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.buffer.push(event);
  }

  end(): void {
    this.done = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  /**
   * Drops what is buffered and nobody has read yet. A new turn calls it before it starts
   * reading: whatever the agent said after the last turn ended belongs to that turn.
   */
  discardBuffered(): number {
    return this.buffer.splice(0).length;
  }

  /**
   * One reader. `return()` (a `for await` that breaks, or the runner when the turn it reads
   * for has ended) takes its pending wait off the queue: a reader left waiting would be
   * handed the next event, and with two readers the queue deals events out in turns — the
   * owner's «لا كيفقدرساعد؟» for «هلا! كيف أقدر أساعد؟» (2026-09-30).
   */
  iterator(): AsyncIterable<AgentEvent> {
    const done: IteratorResult<AgentEvent> = { value: undefined as never, done: true };
    let finished = false;
    let pending: ((value: IteratorResult<AgentEvent>) => void) | null = null;
    const next = (): Promise<IteratorResult<AgentEvent>> => {
      if (finished) return Promise.resolve(done);
      const buffered = this.buffer.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      if (this.done) return Promise.resolve(done);
      return new Promise((resolve) => {
        const waiter = (value: IteratorResult<AgentEvent>) => {
          pending = null;
          resolve(value);
        };
        pending = waiter;
        this.waiting.push(waiter);
      });
    };
    const stop = (): Promise<IteratorResult<AgentEvent>> => {
      finished = true;
      const waiter = pending;
      if (waiter) {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        waiter(done);
      }
      return Promise.resolve(done);
    };
    return { [Symbol.asyncIterator]: () => ({ next, return: stop }) };
  }
}
