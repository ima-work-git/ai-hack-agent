import type { GlassesView, G2Status } from './integrations/g2-runtime';

type Frame = { view: GlassesView | null; state: string; reason?: string };

/** Best-effort app-display mirror: one in-flight request, latest frame wins.
 * No microphone data, retained history or paid provider requests are sent. */
export class GlassesMirrorPublisher {
  private frame: Frame | null = null;
  private owner = '';
  private version = 0;
  private sending = false;
  private status: G2Status = { state: 'idle' };
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly credential: () => string, private readonly send: typeof fetch = fetch) {
    this.timer = setInterval(() => { void this.flush(); }, 5_000);
  }
  display(view: GlassesView): void {
    const owner = this.credential();
    if (!owner) return;
    this.owner = owner;
    this.frame = { view: { ...view }, state: this.status.state, reason: this.status.reason };
    this.version++;
    void this.flush();
  }
  updateStatus(status: G2Status): void {
    this.status = { ...status };
    if (!this.frame) return;
    this.frame = { view: ['connected', 'recording'].includes(status.state) ? this.frame.view : null,
      state: status.state, reason: status.reason };
    this.version++;
    void this.flush();
  }
  dispose(): void { clearInterval(this.timer); this.frame = null; }
  private async flush(): Promise<void> {
    if (!this.frame || this.sending) return;
    const token = this.credential();
    if (!token || token !== this.owner) { this.frame = null; return; }
    const version = this.version;
    this.sending = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      await this.send('/api/glasses-mirror', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(this.frame), signal: controller.signal });
    } catch { /* Mirror transport is independent of ASR and native display. */ }
    finally {
      clearTimeout(timeout); this.sending = false;
      if (version !== this.version) void this.flush();
    }
  }
}
