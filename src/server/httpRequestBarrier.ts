export class HttpRequestsClosingError extends Error {
  constructor() {
    super("HTTP service is closing");
    this.name = "HttpRequestsClosingError";
  }
}

export class HttpRequestBarrier {
  private accepting = true;
  private readonly inFlight = new Set<Promise<void>>();
  private closePromise?: Promise<void>;

  run(operation: () => Promise<void>): Promise<void> {
    if (!this.accepting) {
      return Promise.reject(new HttpRequestsClosingError());
    }
    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(operation)
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
    return tracked;
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.accepting = false;
    this.closePromise = this.drain();
    return this.closePromise;
  }

  private async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}
