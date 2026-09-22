export type PhoneAudioStopReason = 'user' | 'limit' | 'error';

export interface PhoneAudioDependencies {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext: (options: AudioContextOptions) => AudioContext;
  now: () => number;
}

export interface PhoneAudioOptions {
  onAudio: (chunk: Uint8Array) => void;
  onStopped: (reason: PhoneAudioStopReason) => void;
  onError?: (message: string) => void;
  dependencies?: Partial<PhoneAudioDependencies>;
}

const RATE = 16_000;
const MAX_SAMPLES = RATE * 30;
const MAX_DURATION_MS = 30_000;
const START_TIMEOUT_MS = 10_000;

interface Capture {
  closed: boolean;
  started: boolean;
  deadline: number;
  samples: number;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  gain?: GainNode;
  timer?: ReturnType<typeof setTimeout>;
  startTimer?: ReturnType<typeof setTimeout>;
  cancelStart: () => void;
  endedHandlers: Array<{ track: MediaStreamTrack; handler: () => void }>;
  partialWeight: number;
  partialSum: number;
}

/** Explicit, memory-only microphone capture. The caller owns WAV conversion and sending. */
export class PhoneAudio {
  private readonly deps: PhoneAudioDependencies;
  private capture: Capture | null = null;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: PhoneAudioOptions) {
    this.deps = {
      getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
      createAudioContext: options => new AudioContext(options),
      now: () => performance.now(),
      ...options.dependencies,
    };
  }

  get recording(): boolean { return Boolean(this.capture?.started && !this.capture.closed); }

  async start(): Promise<boolean> {
    if (this.capture || this.closing) return false;
    let cancelStart!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancelStart = () => reject(new Error('cancelled')); });
    const capture: Capture = {
      closed: false, started: false, deadline: 0, samples: 0, cancelStart,
      endedHandlers: [], partialWeight: 0, partialSum: 0,
    };
    this.capture = capture;
    // Attach immediately, including when a synchronous browser API throws below.
    void cancelled.catch(() => {});
    try {
      const context = this.deps.createAudioContext({ sampleRate: RATE });
      capture.context = context;
      if (!Number.isFinite(context.sampleRate) || context.sampleRate <= 0) throw new Error('sample_rate');
      // Resume in the explicit user gesture, before waiting for microphone permission.
      const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
      void resumed.catch(() => {});
      const streamReady = this.deps.getUserMedia({
        audio: { sampleRate: RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false,
      }).then(stream => {
        if (capture.closed || this.capture !== capture) {
          this.stopTracks(stream);
          throw new Error('cancelled');
        }
        capture.stream = stream;
        capture.deadline = this.deps.now() + MAX_DURATION_MS;
        capture.timer = setTimeout(() => { void this.finish(capture, 'limit'); }, MAX_DURATION_MS);
        if (!stream.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('no_audio');
        for (const track of stream.getTracks()) {
          const handler = () => { void this.finish(capture, 'error', 'マイクとの接続が切れました。もう一度開始してください。'); };
          track.addEventListener('ended', handler);
          capture.endedHandlers.push({ track, handler });
        }
        return stream;
      });
      const timeout = new Promise<never>((_, reject) => {
        capture.startTimer = setTimeout(() => reject(new Error('start_timeout')), START_TIMEOUT_MS);
      });
      const [stream] = await Promise.race([Promise.all([streamReady, resumed]), timeout, cancelled]);
      if (capture.closed || this.capture !== capture) return false;
      clearTimeout(capture.startTimer);
      if (this.deps.now() >= capture.deadline) { await this.finish(capture, 'limit'); return false; }
      if (context.state !== 'running') throw new Error('context_not_running');
      capture.source = context.createMediaStreamSource(stream);
      // The MVP uses the broadly supported legacy PCM callback; actual phone/WebView
      // compatibility still requires a device test. No audio is played or persisted.
      capture.processor = context.createScriptProcessor(4096, 1, 1);
      capture.gain = context.createGain();
      capture.gain.gain.value = 0;
      capture.processor.onaudioprocess = event => {
        if (!capture.started || capture.closed || this.capture !== capture) return;
        if (this.deps.now() >= capture.deadline) { void this.finish(capture, 'limit'); return; }
        try { this.emitPcm(capture, event.inputBuffer.getChannelData(0), context.sampleRate); }
        catch { void this.finish(capture, 'error', '音声を読み取れませんでした。手入力または再録音をお試しください。'); }
      };
      context.onstatechange = () => {
        if (capture.started && !capture.closed && context.state !== 'running') {
          void this.finish(capture, 'error', '音声処理が中断しました。もう一度開始してください。');
        }
      };
      capture.source.connect(capture.processor);
      capture.processor.connect(capture.gain);
      capture.gain.connect(context.destination);
      capture.started = true;
      return true;
    } catch (error) {
      if (!capture.closed) {
        const denied = error instanceof Error && ['NotAllowedError', 'SecurityError'].includes(error.name);
        const message = denied ? 'マイクの使用を許可するか、手入力をご利用ください。'
          : error instanceof Error && error.message === 'start_timeout' ? 'マイクを開始できませんでした。許可状態を確認して再度お試しください。'
          : 'マイクを開始できませんでした。手入力をご利用ください。';
        await this.finish(capture, 'error', message);
      }
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.capture) await this.finish(this.capture, 'user');
    else if (this.closing) await this.closing;
  }

  private emitPcm(capture: Capture, input: Float32Array, inputRate: number): void {
    const ratio = inputRate / RATE;
    const remaining = MAX_SAMPLES - capture.samples;
    const capacity = Math.min(remaining, Math.ceil((input.length + capture.partialWeight) / ratio));
    const pcm = new Uint8Array(capacity * 2);
    const view = new DataView(pcm.buffer);
    let written = 0;
    // Weighted box resampling maintains fractional phase across callbacks and avoids
    // simply dropping every nth input sample when the device ignores 16 kHz.
    for (const raw of input) {
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      let weight = 1;
      while (weight > 1e-9 && written < remaining) {
        const used = Math.min(weight, ratio - capture.partialWeight);
        capture.partialSum += sample * used;
        capture.partialWeight += used;
        weight -= used;
        if (capture.partialWeight >= ratio - 1e-9) {
          const value = Math.max(-1, Math.min(1, capture.partialSum / ratio));
          view.setInt16(written * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
          written++;
          capture.partialWeight = 0;
          capture.partialSum = 0;
        }
      }
      if (written >= remaining) break;
    }
    capture.samples += written;
    if (written) this.options.onAudio(pcm.subarray(0, written * 2));
    if (capture.samples >= MAX_SAMPLES) void this.finish(capture, 'limit');
  }

  private stopTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) { try { track.stop(); } catch { /* Stop other tracks as well. */ } }
  }

  private finish(capture: Capture, reason: PhoneAudioStopReason, message?: string): Promise<void> {
    if (capture.closed) return this.closing ?? Promise.resolve();
    capture.closed = true;
    capture.started = false;
    if (this.capture === capture) this.capture = null;
    clearTimeout(capture.timer);
    clearTimeout(capture.startTimer);
    capture.cancelStart();
    for (const { track, handler } of capture.endedHandlers) track.removeEventListener('ended', handler);
    if (capture.stream) this.stopTracks(capture.stream);
    if (capture.processor) capture.processor.onaudioprocess = null;
    if (capture.context) capture.context.onstatechange = null;
    for (const node of [capture.source, capture.processor, capture.gain]) {
      try { node?.disconnect(); } catch { /* Already disconnected. */ }
    }
    // Stop tracks synchronously. Closing an AudioContext must not hang cancellation.
    const context = capture.context;
    const closing = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2_000);
      const done = () => { clearTimeout(timer); resolve(); };
      try {
        if (context && context.state !== 'closed') void context.close().then(done, done);
        else done();
      } catch { done(); }
    });
    this.closing = closing;
    void closing.then(() => { if (this.closing === closing) this.closing = null; });
    if (message) { try { this.options.onError?.(message); } catch { /* Cleanup remains complete. */ } }
    try { this.options.onStopped(reason); } catch { /* Cleanup remains complete. */ }
    return closing;
  }
}
