export interface StreamingAudioOptions {
  onDelta: (itemId: string, text: string) => void;
  onFinal: (itemId: string, text: string) => void;
  onError: (error: Error) => void;
  onClose?: () => void;
  /** Test injection. Production uses the current origin's /api/asr. */
  endpoint?: string;
  createSocket?: (url: string) => WebSocket;
}

const MAX_BUFFER_BYTES = 16_000 * 2 * 2;
const READY_TIMEOUT_MS = 10_000;
interface Connection {
  socket: WebSocket;
  ready: boolean;
  opened: boolean;
  resolve: (ready: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  pending: Uint8Array[];
  bytes: number;
}

/** Immediate PCM streaming; only connection setup may buffer up to two seconds. */
export class StreamingAudio {
  private readonly options: StreamingAudioOptions;
  private connection: Connection | null = null;

  constructor(options: StreamingAudioOptions) { this.options = options; }

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
      socket, ready: false, opened: false, resolve, pending: [], bytes: 0,
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
    if (!connection || !chunk.length) return;
    if (!(chunk instanceof Uint8Array) || chunk.length % 2 !== 0) {
      this.finish(connection, new Error('音声データの形式を確認できませんでした。')); return;
    }
    if (connection.ready) { this.send(connection, chunk); return; }
    if (connection.bytes + chunk.byteLength > MAX_BUFFER_BYTES) {
      this.finish(connection, new Error('音声接続の準備が遅れたため、録音を停止しました。')); return;
    }
    connection.pending.push(chunk.slice());
    connection.bytes += chunk.byteLength;
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
      if (value.type === 'ready') {
        if (!connection.opened) throw new Error('not_authenticated');
        if (connection.ready) return;
        connection.ready = true;
        clearTimeout(connection.timer);
        for (const chunk of connection.pending) {
          if (!this.send(connection, chunk)) return;
          chunk.fill(0);
        }
        connection.pending = []; connection.bytes = 0;
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
    for (const chunk of connection.pending) chunk.fill(0);
    connection.pending = []; connection.bytes = 0;
    connection.resolve(false);
    connection.socket.onopen = connection.socket.onmessage = connection.socket.onerror = connection.socket.onclose = null;
    try { connection.socket.close(); } catch { /* An already failed socket may reject close. */ }
    if (error) this.report(error);
    try { this.options.onClose?.(); } catch { /* Cleanup is complete. */ }
  }
}
