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
  constructor(private readonly credential: () => string, private readonly send: typeof fetch = fetch,
    private readonly notify: (message: string) => void = () => {}) {
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
    const owner = this.credential();
    if (!owner) { this.frame = null; return; }
    if (!this.frame && !['connecting', 'connected', 'recording'].includes(status.state)) return;
    const retained = owner === this.owner ? this.frame?.view ?? null : null;
    this.owner = owner;
    this.frame = { view: ['connected', 'recording'].includes(status.state) ? retained : null,
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
    const timeout = setTimeout(() => controller.abort(), 6_000);
    const current = () => this.credential() === token && this.owner === token && this.frame !== null;
    const hasView = this.frame.view !== null;
    const report = (message: string) => { if (current()) { try { this.notify(message); } catch { /* UI diagnostics are best effort. */ } } };
    try {
      // Native WebView fetch must receive Window, never this publisher object.
      const response = await this.send.call(globalThis, '/api/glasses-mirror', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(this.frame), signal: controller.signal });
      if (!response.ok) {
        report(response.status === 401 ? 'PC同期：認証が切れました。Even Appを閉じてQRを読み直してください。'
          : `PC同期：送信できませんでした（${response.status}）。自動で再試行します。`);
      } else report(hasView ? 'PC同期：グラスの画面を送信済み' : 'PC同期：接続済み・グラスの表示受付を待っています');
    } catch { report('PC同期：通信待ち・自動で再試行します。音声認識は継続します。'); }
    finally {
      clearTimeout(timeout); this.sending = false;
      if (version !== this.version) void this.flush();
    }
  }
}
