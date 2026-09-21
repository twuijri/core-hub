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

  iterator(): AsyncIterable<AgentEvent> {
    const next = (): Promise<IteratorResult<AgentEvent>> => {
      const buffered = this.buffer.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      if (this.done) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((resolve) => this.waiting.push(resolve));
    };
    return { [Symbol.asyncIterator]: () => ({ next }) };
  }
}
