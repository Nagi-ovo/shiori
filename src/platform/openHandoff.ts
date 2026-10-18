type TimerHandle = ReturnType<typeof setTimeout>;

export type OpenHandoffQueueOptions<T> = {
  open: (target: T) => void | Promise<void>;
  onError?: (error: unknown, target: T) => void;
  key?: (target: T) => string;
  dedupeMs: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
};

export class OpenHandoffQueue<T> {
  private readonly open: (target: T) => void | Promise<void>;
  private readonly onError: (error: unknown, target: T) => void;
  private readonly keyForTarget: (target: T) => string;
  private readonly dedupeMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly activeKeys = new Set<string>();
  private readonly recentKeys = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(options: OpenHandoffQueueOptions<T>) {
    this.open = options.open;
    this.onError = options.onError ?? (() => undefined);
    this.keyForTarget = options.key ?? ((target) => String(target));
    this.dedupeMs = options.dedupeMs;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  enqueue(target: T): void {
    const key = this.keyForTarget(target);
    if (!key || this.shouldSkip(key)) return;
    this.activeKeys.add(key);
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.open(target);
        } catch (err) {
          this.onError(err, target);
        } finally {
          this.markRecent(key);
        }
      });
    void this.chain;
  }

  enqueueAll(targets: readonly T[]): void {
    for (const target of targets) {
      this.enqueue(target);
    }
  }

  whenIdle(): Promise<void> {
    return this.chain;
  }

  private shouldSkip(key: string): boolean {
    if (this.activeKeys.has(key)) return true;
    const last = this.recentKeys.get(key);
    return last !== undefined && this.now() - last < this.dedupeMs;
  }

  private markRecent(key: string): void {
    this.activeKeys.delete(key);
    const completedAt = this.now();
    this.recentKeys.set(key, completedAt);
    this.setTimer(() => {
      if (this.recentKeys.get(key) === completedAt) {
        this.recentKeys.delete(key);
      }
    }, this.dedupeMs);
  }
}
