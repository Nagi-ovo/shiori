/**
 * The render queue of the web worker, with the desktop render thread's rules
 * (src-tauri/src/pdf_core.rs): lower priority numbers first (tiles on
 * screen, then backdrops, then thumbnails), arrival order within one; a
 * cancelled ticket is skipped when it comes up; once the queue drains, any
 * ticket still marked was cancelled after it had already been drawn.
 */
export type RenderJob = { ticket: number; priority: number };

export class RenderQueue<J extends RenderJob> {
  #jobs: Array<{ job: J; seq: number }> = [];
  #seq = 0;
  #cancelled = new Set<number>();

  get size(): number {
    return this.#jobs.length;
  }

  push(job: J): void {
    this.#jobs.push({ job, seq: this.#seq++ });
  }

  cancel(tickets: Iterable<number>): void {
    for (const ticket of tickets) this.#cancelled.add(ticket);
  }

  /** The next job, and whether it was cancelled; undefined when empty. */
  take(): { job: J; cancelled: boolean } | undefined {
    if (this.#jobs.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.#jobs.length; i += 1) {
      const a = this.#jobs[i]!;
      const b = this.#jobs[best]!;
      if (a.job.priority < b.job.priority || (a.job.priority === b.job.priority && a.seq < b.seq)) best = i;
    }
    const [{ job }] = this.#jobs.splice(best, 1) as [{ job: J; seq: number }];
    const cancelled = this.#cancelled.delete(job.ticket);
    if (this.#jobs.length === 0) this.#cancelled.clear();
    return { job, cancelled };
  }
}
