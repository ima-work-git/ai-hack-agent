/** Bounded live capture: latest 12 seconds, one operation at a time, a bounded number of windows. */
export interface ConversationAudioOptions {
  maxWindows?: number;
  onWindow: (chunks: Uint8Array[], signal: AbortSignal, sequence: number) => Promise<void>;
  onError?: (error: unknown) => void;
  onComplete?: () => void;
}
const WINDOW_BYTES = 16_000 * 2 * 12;
const MIN_BYTES = 16_000 * 2;
export class ConversationAudio {
  private readonly maximum: number;
  private readonly options: ConversationAudioOptions;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private received = 0;
  private lastSent = 0;
  private count = 0;
  private interval: ReturnType<typeof setInterval> | undefined;
  private pending = false;
  private busy = false;
  private ended = false;
  private cancelled = false;
  private completed = false;
  private controller: AbortController | null = null;
  constructor(options: ConversationAudioOptions) { this.options = options; this.maximum = Math.min(100, Math.max(1, options.maxWindows ?? 3)); }
  start() { if (!this.interval && !this.ended && !this.cancelled) this.interval = setInterval(() => this.queue(), 8_000); }
  append(chunk: Uint8Array) {
    if (this.ended || this.cancelled || this.completed || !chunk.length || chunk.length % 2) return;
    const copy = chunk.slice(-WINDOW_BYTES); this.chunks.push(copy); this.bytes += copy.length; this.received += chunk.length;
    while (this.bytes > WINDOW_BYTES) {
      const first = this.chunks[0]!; const excess = this.bytes - WINDOW_BYTES;
      if (first.length <= excess) { this.chunks.shift(); this.bytes -= first.length; first.fill(0); }
      else { this.chunks[0] = first.slice(excess); this.bytes -= excess; first.fill(0); }
    }
  }
  finish() { if (this.cancelled || this.completed) return; this.ended = true; clearInterval(this.interval); this.queue(); }
  cancel() {
    this.cancelled = true; this.pending = false; clearInterval(this.interval); this.controller?.abort(); this.clear();
  }
  private clear() { for (const chunk of this.chunks) chunk.fill(0); this.chunks = []; this.bytes = 0; }
  private complete() {
    if (this.completed || this.cancelled) return;
    this.completed = true; clearInterval(this.interval); this.clear(); this.options.onComplete?.();
  }
  private queue() {
    if (this.cancelled || this.completed) return;
    this.pending = true; if (!this.busy) void this.drain();
  }
  private async drain() {
    if (this.busy || this.cancelled || this.completed) return;
    this.busy = true;
    try {
      while (this.pending && !this.cancelled && this.count < this.maximum) {
        this.pending = false;
        if (this.received === this.lastSent || this.bytes < MIN_BYTES) break;
        this.lastSent = this.received;
        // Skip near-digital silence; this is not a claim of speech recognition.
        let squares = 0;
        for (const chunk of this.chunks) {
          const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          for (let i = 0; i < chunk.length; i += 2) squares += view.getInt16(i, true) ** 2;
        }
        if (Math.sqrt(squares / (this.bytes / 2)) < 80) continue;
        const snapshot = this.chunks.map(chunk => chunk.slice());
        const controller = new AbortController(); this.controller = controller;
        try { await this.options.onWindow(snapshot, controller.signal, ++this.count); }
        catch (error) { if (!this.cancelled) { this.options.onError?.(error); this.ended = true; this.pending = false; } }
        finally { for (const chunk of snapshot) chunk.fill(0); if (this.controller === controller) this.controller = null; }
      }
    } finally {
      this.busy = false;
      if (this.cancelled) return;
      if (this.count >= this.maximum || this.ended) this.complete();
    }
  }
}
