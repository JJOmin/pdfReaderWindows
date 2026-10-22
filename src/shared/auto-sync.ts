/**
 * When the desktop syncs with the store on its own (ADR 10 section 3): at once on start, 10 seconds
 * after the last change, every 2 minutes for the other devices' changes, and before the app quits.
 * A place in a document counts too, but at most once a minute. The clock and the timers are the
 * platform's, so a test can advance them.
 */
export const CHANGE_DELAY_MS = 10_000;
export const POLL_INTERVAL_MS = 120_000;
export const PLACE_EVERY_MS = 60_000;

export interface AutoSyncOptions {
  /** One sync. Errors are the caller's to report; this keeps going after them. */
  run(): Promise<unknown>;
  now(): number;
}

export class AutoSync {
  private enabled = true;
  private started = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  /** A change came while a sync was running, so that one cannot have carried it. */
  private again = false;
  private lastRun = 0;

  constructor(private readonly options: AutoSyncOptions) {}

  /** Syncs now and then on the poll interval. */
  start(): void {
    this.started = true;
    if (this.enabled) this.arm();
  }

  stop(): void {
    this.started = false;
    clearInterval(this.poll);
    clearTimeout(this.timer);
    this.poll = this.timer = undefined;
  }

  /** The user's setting: while off nothing runs by itself, and switching on syncs at once. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!this.started) return;
    if (on) this.arm();
    else {
      clearInterval(this.poll);
      clearTimeout(this.timer);
      this.poll = this.timer = undefined;
    }
  }

  /** Something the store should get. A mark or a prepared document goes after 10 s; a place later. */
  changed(kind: 'content' | 'place'): void {
    if (!this.started || !this.enabled) return;
    const now = this.options.now();
    if (kind === 'content') {
      clearTimeout(this.timer);
      this.schedule(CHANGE_DELAY_MS);
    } else if (this.timer === undefined) {
      this.schedule(Math.max(CHANGE_DELAY_MS, this.lastRun + PLACE_EVERY_MS - now));
    }
  }

  /** Sends what waits, for the moment the app quits. Resolves to whether there was anything. */
  async flush(): Promise<boolean> {
    if (this.timer === undefined && !this.again) return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.sync();
    return true;
  }

  private arm(): void {
    clearInterval(this.poll);
    this.poll = setInterval(() => void this.sync(), POLL_INTERVAL_MS);
    void this.sync();
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync();
    }, delay);
  }

  private async sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      await this.running;
      return;
    }
    this.lastRun = this.options.now();
    this.running = this.options
      .run()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => (this.running = undefined));
    await this.running;
    if (this.again) {
      this.again = false;
      await this.sync();
    }
  }
}
