/**
 * Bounded FIFO job queue with fixed concurrency. When the queue is full,
 * `submit` rejects immediately (the app reports "busy" to the user) rather
 * than letting work pile up without bound.
 */
export class JobQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
  ) {}

  get stats() {
    return {
      running: this.running,
      queued: this.waiting.length,
      concurrency: this.concurrency,
      maxQueued: this.maxQueued,
    };
  }

  async submit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.maxQueued) throw new QueueFullError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('compile queue is full');
  }
}
