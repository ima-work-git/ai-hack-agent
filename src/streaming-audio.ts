export interface StreamingAudioOptions {
  onDelta: (itemId: string, text: string) => void;
  onFinal: (itemId: string, text: string) => void;
  onError: (error: Error) => void;
  onClose?: () => void;
  /** Test injection. Production uses the current origin's /api/asr. */
  endpoint?: string;
  createSocket?: (url: string) => WebSocket;
  /** Monotonic pacing clock; injectable without changing authentication time. */
  monotonicNow?: () => number;
}

const MAX_BUFFER_BYTES = 16_000 * 2 * 2;
const MAX_QUEUED_BYTES = 16_000 * 2 * 4;
const FRAME_BYTES = 3_200; // At most 100 ms of PCM per WebSocket message.
const PACE_BYTES_PER_MS = 32 * 1.10;
const READY_TIMEOUT_MS = 10_000;
interface Connection {
  socket: WebSocket;
  ready: boolean;
  opened: boolean;
  resolve: (ready: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  queue: Uint8Array;
  queuedBytes: number;
  readOffset: number;
  writeOffset: number;
  credit: number;
  paceAt: number;
  progressedAt: number;
  paceTimer?: ReturnType<typeof setTimeout>;
  resetGeneration: number;
}

/** Preparation audio is discarded. Ready audio is paced with a four-second
 * memory bound, absorbing transport bursts without allowing unbounded replay. */
export class StreamingAudio {
  private readonly options: StreamingAudioOptions;
  private connection: Connection | null = null;

  constructor(options: StreamingAudioOptions) { this.options = options; }
  private now(): number { return (this.options.monotonicNow ?? (() => performance.now()))(); }

  start(ticket: string): Promise<boolean> {
    if (this.connection) return Promise.resolve(false);
    let socket: WebSocket;
    try {
      if (typeof ticket !== 'string' || !ticket || ticket.length > 4096) throw new Error('invalid_ticket');
      const endpoint = this.options.endpoint ?? (() => {
        const url = new URL('/api/asr', window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.href;
      })();
      socket = this.options.createSocket?.(endpoint) ?? new WebSocket(endpoint);
    } catch {
      this.report(new Error('音声のストリーミング接続を開始できませんでした。'));
      return Promise.resolve(false);
    }
    let resolve!: (ready: boolean) => void;
    const result = new Promise<boolean>(done => { resolve = done; });
    const connection: Connection = {
      socket, ready: false, opened: false, resolve,
      queue: new Uint8Array(MAX_QUEUED_BYTES), queuedBytes: 0, readOffset: 0, writeOffset: 0,
      credit: FRAME_BYTES, paceAt: this.now(), progressedAt: this.now(), resetGeneration: 0,
      timer: setTimeout(() => this.finish(connection, new Error('音声接続の準備がタイムアウトしました。')), READY_TIMEOUT_MS),
    };
    this.connection = connection;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.connection !== connection || connection.opened) return;
      connection.opened = true;
      try { socket.send(JSON.stringify({ type: 'auth', ticket })); }
      catch { this.finish(connection, new Error('音声接続の認証を送信できませんでした。')); }
      ticket = '';
    };
    socket.onmessage = event => {
      if (this.connection !== connection) return;
      this.message(connection, event.data);
    };
    socket.onerror = () => this.finish(connection, new Error('音声のストリーミング接続でエラーが発生しました。'));
    socket.onclose = () => this.finish(connection,
      connection.ready ? undefined : new Error('音声接続の準備中に接続が終了しました。'));
    return result;
  }

  append(chunk: Uint8Array): void {
    const connection = this.connection;
    if (!connection || !connection.ready || !chunk.length) return;
    if (!(chunk instanceof Uint8Array) || chunk.length % 2 !== 0) {
      this.finish(connection, new Error('音声データの形式を確認できませんでした。')); return;
    }
    if (chunk.byteLength > MAX_QUEUED_BYTES - connection.queuedBytes) {
      this.finish(connection, new Error('音声の送信待ちが上限を超えたため、録音を停止しました。')); return;
    }
    if (!connection.queuedBytes) connection.progressedAt = this.now();
    const first = Math.min(chunk.byteLength, MAX_QUEUED_BYTES - connection.writeOffset);
    connection.queue.set(chunk.subarray(0, first), connection.writeOffset);
    connection.queue.set(chunk.subarray(first), 0);
    connection.writeOffset = (connection.writeOffset + chunk.byteLength) % MAX_QUEUED_BYTES;
    connection.queuedBytes += chunk.byteLength;
    this.drain(connection);
  }

  cancel(): void { if (this.connection) this.finish(this.connection); }

  private message(connection: Connection, data: unknown): void {
    try {
      if (typeof data !== 'string' || data.length > 32_000) throw new Error('invalid_event');
      const event: unknown = JSON.parse(data);
      if (!event || typeof event !== 'object' || !('type' in event)) throw new Error('invalid_event');
      const value = event as Record<string, unknown>;
      if (value.type === 'error') {
        const message = typeof value.message === 'string' && value.message.length <= 500
          ? value.message : '音声のストリーミング処理を続けられませんでした。';
        this.finish(connection, new Error(message)); return;
      }
      if (value.type === 'closed') { this.finish(connection); return; }
      if (value.type === 'reset') {
        if (!connection.opened || !Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) throw new Error('invalid_reset');
        if ((value.generation as number) <= connection.resetGeneration) return;
        connection.resetGeneration = value.generation as number;
        this.clearQueue(connection);
        // The ACK follows all already-sent old PCM on this same ordered socket.
        // New PCM may follow only after the local queue has been erased.
        if (connection.socket.readyState !== 1) throw new Error('closed_socket');
        connection.socket.send(JSON.stringify({ type: 'reset_ack', generation: value.generation }));
        return;
      }
      if (value.type === 'ready') {
        if (!connection.opened) throw new Error('not_authenticated');
        if (connection.ready) return;
        connection.ready = true;
        clearTimeout(connection.timer);
        connection.resolve(true);
        return;
      }
      if (!connection.ready || !['delta', 'final'].includes(String(value.type))
        || typeof value.itemId !== 'string' || !value.itemId || value.itemId.length > 200
        || typeof value.text !== 'string' || value.text.length > 20_000) throw new Error('invalid_event');
      if (value.type === 'delta') this.options.onDelta(value.itemId, value.text);
      else this.options.onFinal(value.itemId, value.text);
    } catch { this.finish(connection, new Error('音声認識の応答を確認できませんでした。')); }
  }

  private clearQueue(connection: Connection): void {
    if (connection.paceTimer !== undefined) clearTimeout(connection.paceTimer);
    connection.paceTimer = undefined;
    connection.queue.fill(0); connection.queuedBytes = 0;
    connection.readOffset = 0; connection.writeOffset = 0;
    connection.credit = FRAME_BYTES; connection.paceAt = this.now(); connection.progressedAt = connection.paceAt;
  }

  private drain(connection: Connection): void {
    if (this.connection !== connection || !connection.ready) return;
    if (connection.paceTimer !== undefined) clearTimeout(connection.paceTimer);
    connection.paceTimer = undefined;
    const at = Math.max(connection.paceAt, this.now());
    if (connection.queuedBytes && at - connection.progressedAt > 4000) {
      this.finish(connection, new Error('音声の送信が遅れたため、録音を停止しました。')); return;
    }
    connection.credit = Math.min(FRAME_BYTES, connection.credit + (at - connection.paceAt) * PACE_BYTES_PER_MS);
    connection.paceAt = at;
    while (connection.queuedBytes) {
      const size = Math.min(FRAME_BYTES, connection.queuedBytes);
      if (connection.credit < size) {
        connection.paceTimer = setTimeout(() => this.drain(connection), Math.max(1, Math.ceil((size - connection.credit) / PACE_BYTES_PER_MS)));
        return;
      }
      const frame = new Uint8Array(size);
      const first = Math.min(size, MAX_QUEUED_BYTES - connection.readOffset);
      frame.set(connection.queue.subarray(connection.readOffset, connection.readOffset + first));
      frame.set(connection.queue.subarray(0, size - first), first);
      connection.queue.fill(0, connection.readOffset, connection.readOffset + first);
      connection.queue.fill(0, 0, size - first);
      connection.readOffset = (connection.readOffset + size) % MAX_QUEUED_BYTES;
      connection.queuedBytes -= size; connection.credit -= size;
      if (!this.send(connection, frame)) return;
      connection.progressedAt = at;
    }
  }

  private send(connection: Connection, chunk: Uint8Array): boolean {
    if (this.connection !== connection) return false;
    if (connection.socket.readyState !== 1 || connection.socket.bufferedAmount + chunk.byteLength > MAX_BUFFER_BYTES) {
      this.finish(connection, new Error('音声の送信が遅れたため、録音を停止しました。')); return false;
    }
    try { connection.socket.send(chunk.slice().buffer); return true; }
    catch { this.finish(connection, new Error('音声データを送信できませんでした。')); return false; }
  }

  private report(error: Error): void { try { this.options.onError(error); } catch { /* Cleanup must complete. */ } }
  private finish(connection: Connection, error?: Error): void {
    if (this.connection !== connection) return;
    this.connection = null;
    clearTimeout(connection.timer);
    this.clearQueue(connection);
    connection.resolve(false);
    connection.socket.onopen = connection.socket.onmessage = connection.socket.onerror = connection.socket.onclose = null;
    try { connection.socket.close(); } catch { /* An already failed socket may reject close. */ }
    if (error) this.report(error);
    try { this.options.onClose?.(); } catch { /* Cleanup is complete. */ }
  }
}
