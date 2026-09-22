import WebSocket from 'ws';
import type { ClientOptions, RawData } from 'ws';

// Server-only. The caller must authorize and reserve cost BEFORE start/append.
// https://developers.openai.com/api/docs/guides/realtime-transcription
// https://developers.openai.com/cookbook/examples/migrating_from_whisper_to_gpt_transcribe
const ENDPOINT = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MAX_BUFFER = 256 * 1024;
const MAX_EVENT = 64 * 1024;
export interface OpenAIStreamingASROptions {
  apiKey: string;
  model?: string;
  keywords?: string[];
  signal?: AbortSignal;
  onReady?: () => void;
  onDelta?: (itemId: string, delta: string) => void;
  onFinal?: (itemId: string, text: string) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}
export type ASRSocket = Pick<WebSocket, 'on' | 'send' | 'close' | 'terminate' | 'readyState' | 'bufferedAmount'>;
export interface OpenAIStreamingASRDependencies {
  connect?: (url: string, options: ClientOptions) => ASRSocket;
}

/** Streaming linear 16 kHz -> 24 kHz conversion. Carries phase and one sample
 * across packets; arbitrary packet boundaries cannot duplicate/drop a segment. */
export class PCM16To24Resampler {
  private previous = 0;
  private inputIndex = 0;
  private nextNumerator = 0;
  convert(bytes: Uint8Array): Buffer {
    if (bytes.byteLength % 2) throw new Error('PCM16 requires complete samples');
    const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const output: number[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 2) {
      const sample = input.getInt16(offset, true);
      const index = this.inputIndex++;
      while (this.nextNumerator <= index * 3) {
        const fraction = index ? (this.nextNumerator - (index - 1) * 3) / 3 : 1;
        output.push(Math.round(this.previous + (sample - this.previous) * fraction));
        this.nextNumerator += 2;
      }
      this.previous = sample;
    }
    const result = Buffer.allocUnsafe(output.length * 2);
    output.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
    return result;
  }
  clear(): void { this.previous = 0; this.inputIndex = 0; this.nextNumerator = 0; }
}

export class OpenAIStreamingASR {
  private options: OpenAIStreamingASROptions;
  private dependencies: OpenAIStreamingASRDependencies;
  private socket?: ASRSocket;
  private ready = false;
  private stopped = false;
  private startPromise?: Promise<void>;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private timeout?: ReturnType<typeof setTimeout>;
  private commitTimer?: ReturnType<typeof setInterval>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private pendingSamples = 0;
  private resampler = new PCM16To24Resampler();
  private items = new Map<string, { length: number; final: boolean; sequence?: number; previousId?: string | null }>();
  private latestCommittedId: string | null = null;
  private lastFinalSequence = -1;
  private onAbort = () => this.stop();

  constructor(options: OpenAIStreamingASROptions, dependencies: OpenAIStreamingASRDependencies = {}) {
    this.options = options; this.dependencies = dependencies;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped || this.options.signal?.aborted) return Promise.reject(new Error('音声接続を終了しました。'));
    if (!this.options.apiKey.trim() || this.options.apiKey.length > 4096 || /[\r\n]/u.test(this.options.apiKey)) return Promise.reject(new Error('音声認識の設定が不足しています。'));
    const model = this.options.model ?? 'gpt-live-transcribe';
    if (model !== 'gpt-live-transcribe') return Promise.reject(new Error('対応していない音声モデルです。'));
    const keywords = this.options.keywords ?? [];
    if (keywords.length > 20 || keywords.some(word => !word || word.length > 80 || /[<>\r\n]/u.test(word))) return Promise.reject(new Error('音声認識の用語設定を確認してください。'));
    this.startPromise = new Promise<void>((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; });
    this.options.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timeout = setTimeout(() => this.fail('音声認識への接続が時間内に完了しませんでした。'), 8000);
    try {
      this.socket = (this.dependencies.connect ?? ((url, options) => new WebSocket(url, options)))(ENDPOINT, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` }, maxPayload: MAX_EVENT,
        perMessageDeflate: false, handshakeTimeout: 8000, followRedirects: false,
      });
      this.socket.on('open', () => {
        if (this.stopped) return;
        this.send({ type: 'session.update', session: { type: 'transcription', audio: { input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model, languages: ['ja'], delay: 'low', ...(keywords.length ? { keywords } : {}),
            prompt: '日本語の会話です。聞こえた発話だけを文字起こしし、用語ヒントを発話に挿入しないでください。' },
          turn_detection: null,
        } } } });
      });
      this.socket.on('message', (data, isBinary) => this.receive(data, isBinary));
      this.socket.on('error', () => this.fail('音声認識サービスへ接続できませんでした。'));
      this.socket.on('close', () => {
        if (this.closeTimer) clearTimeout(this.closeTimer);
        if (!this.stopped) this.fail('音声認識との接続が終了しました。');
      });
    } catch { this.fail('音声認識サービスへ接続できませんでした。'); }
    return this.startPromise;
  }

  append(pcm16k: Uint8Array): void {
    if (!this.ready || this.stopped) throw new Error('音声認識は接続されていません。');
    if (!(pcm16k instanceof Uint8Array) || !pcm16k.byteLength || pcm16k.byteLength % 2 || pcm16k.byteLength > 64_000) {
      this.fail('音声データの形式またはサイズが不正です。');
      throw new Error('音声データの形式またはサイズが不正です。');
    }
    const pcm24k = this.resampler.convert(pcm16k);
    if (pcm24k.length) {
      const sent = this.send({ type: 'input_audio_buffer.append', audio: pcm24k.toString('base64') });
      if (sent) this.pendingSamples += pcm24k.length / 2;
      pcm24k.fill(0);
      if (!sent) throw new Error('音声送信を停止しました。');
    }
  }

  /** Immediate cancellation: no final commit or later transcript callback. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.ready = false;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.commitTimer) clearInterval(this.commitTimer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.rejectStart?.(new Error('音声接続を終了しました。'));
    this.resolveStart = undefined; this.rejectStart = undefined;
    this.pendingSamples = 0; this.resampler.clear(); this.items.clear();
    this.latestCommittedId = null; this.lastFinalSequence = -1;
    const socket = this.socket;
    if (socket) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
        this.closeTimer = setTimeout(() => socket.terminate(), 1000);
        this.closeTimer.unref();
      }
    }
    this.notify(() => this.options.onClose?.());
  }

  private send(event: unknown): boolean {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(event);
    if (this.socket.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFER) { this.fail('音声送信が追いつかないため停止しました。'); return false; }
    try { this.socket.send(text, error => { if (error) this.fail('音声の送信に失敗しました。'); }); return !this.stopped; }
    catch { this.fail('音声の送信に失敗しました。'); return false; }
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (this.stopped) return;
    const size = Array.isArray(data) ? data.reduce((sum, buffer) => sum + buffer.length, 0) : data.byteLength;
    if (isBinary || size > MAX_EVENT) { this.fail('音声認識の応答サイズまたは形式が不正です。'); return; }
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      const event: unknown = JSON.parse(bytes.toString('utf8'));
      if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') throw new Error();
      const value = event as Record<string, unknown>;
      if (value.type === 'error' || value.type === 'conversation.item.input_audio_transcription.failed') { this.fail('音声認識サービスが処理を受け付けませんでした。'); return; }
      if (value.type === 'session.updated') {
        if (!value.session || typeof value.session !== 'object' || !('type' in value.session) || value.session.type !== 'transcription') throw new Error();
        if (this.ready) return;
        this.ready = true;
        if (this.timeout) clearTimeout(this.timeout);
        this.commitTimer = setInterval(() => {
          if (this.pendingSamples >= 2400 && this.send({ type: 'input_audio_buffer.commit' })) this.pendingSamples = 0;
        }, 5000);
        this.resolveStart?.(); this.resolveStart = undefined; this.rejectStart = undefined;
        this.notify(() => this.options.onReady?.());
        return;
      }
      if (value.type === 'input_audio_buffer.committed') {
        if (!this.ready || typeof value.item_id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/u.test(value.item_id) ||
          !(value.previous_item_id === null || typeof value.previous_item_id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/u.test(value.previous_item_id))) throw new Error();
        const previousId = value.previous_item_id;
        const known = this.items.get(value.item_id);
        if (known?.sequence !== undefined) { if (known.previousId !== previousId) throw new Error(); return; }
        // Never invent an order if a predecessor acknowledgement is missing.
        if (previousId !== this.latestCommittedId) return;
        if (!known && this.items.size >= 512) throw new Error();
        const sequence = previousId === null ? 0 : this.items.get(previousId)!.sequence! + 1;
        this.items.set(value.item_id, { length: known?.length ?? 0, final: false, sequence, previousId });
        this.latestCommittedId = value.item_id;
        return;
      }
      const isFinal = value.type === 'conversation.item.input_audio_transcription.completed';
      if (!isFinal && value.type !== 'conversation.item.input_audio_transcription.delta') return;
      if (!this.ready || typeof value.item_id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/u.test(value.item_id)) throw new Error();
      const text = isFinal ? value.transcript : value.delta;
      if (typeof text !== 'string' || text.length > 8000) throw new Error();
      const prior = this.items.get(value.item_id);
      // Live partials precede commit and stay provisional. Only known-old
      // items are suppressed; an unordered final must never change a subject.
      if (prior?.final || prior?.sequence !== undefined && prior.sequence < this.lastFinalSequence) return;
      if (isFinal && prior?.sequence === undefined) return;
      if (!prior && this.items.size >= 512) throw new Error();
      const length = isFinal ? text.length : (prior?.length ?? 0) + text.length;
      if (length > 8000) throw new Error();
      this.items.set(value.item_id, { ...prior, length, final: isFinal });
      if (isFinal) this.lastFinalSequence = prior!.sequence!;
      const itemId = value.item_id;
      this.notify(() => isFinal ? this.options.onFinal?.(itemId, text) : this.options.onDelta?.(itemId, text));
    } catch { this.fail('音声認識の応答を検証できませんでした。'); }
  }
  private notify(callback: () => void): void { try { callback(); } catch { /* Consumer cannot break socket cleanup. */ } }
  private fail(message: string): void {
    if (this.stopped) return;
    this.notify(() => this.options.onError?.(message));
    this.stop();
  }
}
