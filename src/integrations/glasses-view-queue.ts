import type { GlassesView } from './g2-runtime';

type PendingView = { view: GlassesView; token: string; epoch: number; resolve: (accepted: boolean) => void };

/** Let native writes finish even when speech changes faster than Bluetooth.
 * Only the newest waiting view is retained; lifecycle invalidation drops it. */
export class GlassesViewQueue {
  private pending: PendingView | null = null;
  private busy = false;
  private epoch = 0;
  constructor(private readonly render: (view: GlassesView, token: string) => Promise<boolean>,
    private readonly current: (token: string) => boolean) {}

  enqueue(view: GlassesView, token: string): Promise<boolean> {
    if (!this.current(token)) return Promise.resolve(false);
    this.pending?.resolve(false);
    const result = new Promise<boolean>(resolve => {
      this.pending = { view: { ...view }, token, epoch: this.epoch, resolve };
    });
    void this.drain();
    return result;
  }

  invalidate(): void {
    this.epoch++;
    this.pending?.resolve(false);
    this.pending = null;
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending) {
        const job = this.pending;
        this.pending = null;
        let accepted = false;
        if (job.epoch === this.epoch && this.current(job.token)) {
          try { accepted = await this.render(job.view, job.token); } catch { /* Native runtime reports its own failures. */ }
        }
        job.resolve(accepted && job.epoch === this.epoch && this.current(job.token));
      }
    } finally { this.busy = false; }
  }
}
