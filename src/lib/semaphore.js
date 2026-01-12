export class Semaphore {
  constructor(maxConcurrency) {
    const parsed = Number(maxConcurrency);
    this.max = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

