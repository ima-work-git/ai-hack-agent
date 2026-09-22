import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { OpenAIStreamingASR } from './openai-streaming-asr.ts';
import { BudgetError, type BudgetLedger } from './budget.ts';
import { PUBLIC_FIGURE_CATALOG } from '../src/shared/public-figure-catalog.ts';

export interface StreamGrant {
  sessionId: string;
  conversationId: string;
  expiresAt: number;
  valid: () => boolean;
  onFinal: (text: string) => void;
  keywords?: readonly string[];
}
interface RelayOptions {
  apiKey: string;
  model: string;
  maximumPerMinute: number;
  budget?: BudgetLedger;
  allowOrigin: (req: IncomingMessage) => boolean;
  takeTicket: (ticket: string) => StreamGrant;
  now: () => number;
  monotonicNow?: () => number;
}

const relayErrors = {
  BUDGET_EXHAUSTED: '音声認識の費用上限に達しました。上限設定を確認してください。',
  BUDGET_UNAVAILABLE: '音声認識の費用管理を確認できないため停止しました。設定を確認してください。',
  AUTH_EXPIRED: '音声接続の認証期限が切れました。もう一度ログインして開始してください。',
  AUTH_INVALID: '音声接続の認証が無効です。もう一度開始してください。',
  AUTH_FORMAT: '音声接続の認証形式が不正です。もう一度開始してください。',
  DUPLICATE_CONNECTION: 'この会話の音声接続はすでに開始されています。終了してから再開してください。',
  NOT_READY: '音声認識の接続準備が完了していません。もう一度開始してください。',
  AUDIO_FORMAT: '音声データの形式またはサイズが不正なため停止しました。',
  CONTROL_FORMAT: '音声接続の操作形式が不正なため停止しました。',
  RESET_TIMEOUT: '音声入力の切替確認がタイムアウトしました。再開してください。',
  QUEUE_BACKPRESSURE: '音声の送信待ちが上限を超えました。接続を確認して再開してください。',
  RATE_LIMIT: '音声の送信速度が上限を超えました。接続を確認して再開してください。',
  CONNECTION: '音声認識との接続に失敗しました。接続を確認して再開してください。',
  ASR_ERROR: '音声認識サービスの処理でエラーが発生しました。',
} as const;
type RelayErrorCode = keyof typeof relayErrors;
// 16 kHz mono PCM16 is 32,000 B/s. Allow bounded capture-clock/scheduling
// variation, not an unlimited stream: at most four seconds burst + 1.15x rate.
const RATE_BURST_BYTES = 128_000;
const RATE_BYTES_PER_MS = 32 * 1.15;
const catalogKeywords = PUBLIC_FIGURE_CATALOG.slice(0, 15).map(entry => entry.publicNames[0] ?? entry.canonicalName);
const recognitionKeywords = (values: readonly string[]) => [...new Set([...values, ...catalogKeywords])].filter(word => typeof word === 'string' && word.trim() && word.length <= 80 && !/[<>\r\n]/u.test(word)).slice(0, 20);
const safeStartErrors = new Set(['音声接続を終了しました。', '音声認識の設定が不足しています。', '対応していない音声モデルです。', '音声認識の用語設定を確認してください。', '音声認識は接続されていません。']);

export interface StreamingRelay {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  resetConversation?: (id: string) => boolean;
  updateKeywordsConversation?: (id: string, keywords: readonly string[]) => boolean;
  closeConversation(id: string): void;
  close(): void;
}

/** Same-origin, one-use authentication. Only server-side credentials reach upstream. */
export function createStreamingRelay(options: RelayOptions): StreamingRelay {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const server = new WebSocketServer({ noServer: true, maxPayload: 64_000, perMessageDeflate: false });
  const connections = new Map<WebSocket, { grant?: StreamGrant; close: () => void; reset: () => boolean; updateKeywords: (keywords: readonly string[]) => boolean }>();
  server.on('connection', socket => {
    let ended = false; let authenticated = false; let ready = false;
    let upstream: OpenAIStreamingASR | undefined;
    let grant: StreamGrant | undefined;
    let bytes = 0; let reservedMinutes = 0; let queuedBytes = 0;
    let allowance = RATE_BURST_BYTES; let lastFrameAt = monotonicNow(); let connectedAt = options.now();
    let pending = Promise.resolve();
    let inputGeneration = 0; let resetRequested = false;
    let awaitingResetAck: number | undefined; let resetAckTimer: ReturnType<typeof setTimeout> | undefined;
    let keywords: readonly string[] = catalogKeywords;
    const send = (value: unknown) => {
      if (ended || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 64_000) { console.warn('[streaming-asr]', 'DOWNSTREAM_BACKPRESSURE'); finish(); return; }
      try { socket.send(JSON.stringify(value)); } catch { console.warn('[streaming-asr]', 'DOWNSTREAM_SEND'); finish(); }
    };
    const finish = () => {
      if (ended) return;
      ended = true; ready = false;
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 64_000) {
        try { socket.send(JSON.stringify({ type: 'closed' })); } catch { /* Teardown must still close upstream. */ }
      }
      clearTimeout(authTimer); clearInterval(expiryTimer);
      clearTimeout(resetAckTimer);
      upstream?.stop(); connections.delete(socket); socket.terminate();
    };
    const fail = (code: RelayErrorCode, message: string = relayErrors[code]) => {
      if (ended) return;
      // Fixed categories only: never log audio, transcripts, tickets or raw errors.
      console.warn('[streaming-asr]', code);
      send({ type: 'error', message }); finish();
    };
    const failException = (error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'BUDGET_EXHAUSTED') { fail('BUDGET_EXHAUSTED'); return; }
      if (error instanceof BudgetError || typeof code === 'string' && /^BUDGET_|^INVALID_COST$|^INVALID_BUDGET_RUN_ID$/.test(code)) { fail('BUDGET_UNAVAILABLE'); return; }
      // Only our adapter's exact fixed pre-start errors may bypass onError.
      if (error instanceof Error && safeStartErrors.has(error.message)) { fail('ASR_ERROR', error.message); return; }
      fail('CONNECTION');
    };
    const authTimer = setTimeout(() => fail('AUTH_EXPIRED'), 5_000);
    const expiryTimer = setInterval(() => {
      if (grant && !grant.valid()) { fail('AUTH_EXPIRED'); return; }
      if (!ready || !grant) return;
      const ownGrant = grant;
      // Reserve the next minute five seconds before its connection-time boundary.
      const required = Math.ceil((options.now() - connectedAt + 5_000) / 60_000);
      if (required <= reservedMinutes) return;
      pending = pending.then(async () => {
        if (ended) return;
        if (!ownGrant.valid()) { fail('AUTH_EXPIRED'); return; }
        while (reservedMinutes < required) { await options.budget!.reserve(ownGrant.conversationId, options.maximumPerMinute); reservedMinutes++; }
      }).catch(failException);
    }, 1_000);
    const reset = () => {
      if (ended || !grant?.valid()) return false;
      inputGeneration++; resetRequested = true;
      awaitingResetAck = inputGeneration;
      clearTimeout(resetAckTimer);
      resetAckTimer = setTimeout(() => fail('RESET_TIMEOUT'), 5000);
      send({ type: 'reset', generation: inputGeneration });
      if (ended) return false;
      if (ready && upstream) { resetRequested = false; return upstream.resetInput(); }
      return true;
    };
    const updateKeywords = (values: readonly string[]) => {
      if (ended || !grant?.valid()) return false;
      keywords = recognitionKeywords(values); return upstream ? upstream.updateKeywords(keywords) : true;
    };
    connections.set(socket, { close: finish, reset, updateKeywords });
    socket.on('error', () => fail('CONNECTION')); socket.on('close', () => finish());
    socket.on('message', (raw, binary) => {
      if (ended) return;
      const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      if (!authenticated) {
        if (binary || data.length > 256) { fail('AUTH_FORMAT'); return; }
        try {
          const auth = JSON.parse(data.toString());
          if (auth.type !== 'auth' || typeof auth.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(auth.ticket)) throw new Error('auth');
          grant = options.takeTicket(auth.ticket); authenticated = true; clearTimeout(authTimer);
          if ([...connections.values()].some(connection => connection.grant?.conversationId === grant!.conversationId)) { fail('DUPLICATE_CONNECTION'); return; }
          keywords = recognitionKeywords(grant.keywords ?? []);
          connections.set(socket, { grant, close: finish, reset, updateKeywords });
          const ownGrant = grant;
          pending = (async () => {
            if (!options.budget || !Number.isFinite(options.maximumPerMinute) || options.maximumPerMinute <= 0) throw new BudgetError('BUDGET_NOT_CONFIGURED');
            await options.budget.reserve(ownGrant.conversationId, options.maximumPerMinute); reservedMinutes = 1;
            if (ended) return;
            if (!ownGrant.valid()) { fail('AUTH_EXPIRED'); return; }
            connectedAt = options.now();
            upstream = new OpenAIStreamingASR({ apiKey: options.apiKey, model: options.model, keywords,
              onReady: () => {
                if (ended) return;
                if (!ownGrant.valid()) { fail('AUTH_EXPIRED'); return; }
                ready = true;
                if (resetRequested) { resetRequested = false; upstream!.resetInput(); }
                send({ type: 'ready' });
              },
              onDelta: (itemId, text) => { if (!ownGrant.valid()) { fail('AUTH_EXPIRED'); return; } send({ type: 'delta', itemId, text }); },
              onFinal: (itemId, text) => {
                if (ended) return;
                if (!ownGrant.valid()) { fail('AUTH_EXPIRED'); return; }
                const trimmed = text.trim().slice(0, 2000); if (!trimmed) return;
                ownGrant.onFinal(trimmed); send({ type: 'final', itemId, text: trimmed });
              }, onError: message => fail('ASR_ERROR', message), onClose: finish,
            });
            await upstream.start();
          })().catch(failException);
        } catch { fail('AUTH_INVALID'); }
        return;
      }
      if (!binary) {
        try {
          const control = JSON.parse(data.toString());
          if (control.type === 'stop') { finish(); return; }
          if (control.type === 'reset_ack' && Number.isSafeInteger(control.generation) && control.generation > 0 && control.generation <= inputGeneration) {
            if (control.generation === awaitingResetAck) { awaitingResetAck = undefined; clearTimeout(resetAckTimer); }
            return;
          }
        } catch { /* Invalid control fails closed. */ }
        fail('CONTROL_FORMAT'); return;
      }
      if (!grant?.valid()) { fail('AUTH_EXPIRED'); return; }
      if (!ready) { fail('NOT_READY'); return; }
      if (!data.length || data.length > 64_000 || data.length % 2) { fail('AUDIO_FORMAT'); return; }
      // Ignore in-flight old audio until the client has cleared its queue and
      // acknowledged the latest reset on this same ordered WebSocket.
      if (awaitingResetAck !== undefined) return;
      if (queuedBytes + data.length > 128_000) { fail('QUEUE_BACKPRESSURE'); return; }
      const at = Math.max(lastFrameAt, monotonicNow()); allowance = Math.min(RATE_BURST_BYTES, allowance + (at - lastFrameAt) * RATE_BYTES_PER_MS); lastFrameAt = at;
      if (data.length > allowance) { fail('RATE_LIMIT'); return; }
      allowance -= data.length; queuedBytes += data.length;
      const copy = Buffer.from(data); const ownGrant = grant; const audioGeneration = inputGeneration;
      pending = pending.then(async () => {
        if (ended || audioGeneration !== inputGeneration) return;
        if (!ownGrant.valid()) { fail('AUTH_EXPIRED'); return; }
        const required = Math.max(Math.ceil((bytes + copy.length) / (32_000 * 60)), Math.ceil((options.now() - connectedAt + 5_000) / 60_000));
        while (reservedMinutes < required) { await options.budget!.reserve(ownGrant.conversationId, options.maximumPerMinute); reservedMinutes++; }
        if (ended || audioGeneration !== inputGeneration) return;
        if (!ownGrant.valid()) { fail('AUTH_EXPIRED'); return; }
        upstream!.append(copy); bytes += copy.length;
      }).catch(failException).finally(() => { queuedBytes -= copy.length; copy.fill(0); });
    });
  });
  return {
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (req.url?.split('?')[0] !== '/api/asr') return false;
      if (!options.apiKey || !options.allowOrigin(req) || connections.size >= 20) { socket.destroy(); return true; }
      server.handleUpgrade(req, socket, head, ws => server.emit('connection', ws, req)); return true;
    },
    resetConversation(id: string): boolean {
      let reset = false; for (const connection of connections.values()) if (connection.grant?.conversationId === id) reset = connection.reset() || reset; return reset;
    },
    updateKeywordsConversation(id: string, keywords: readonly string[]): boolean {
      let updated = false; for (const connection of connections.values()) if (connection.grant?.conversationId === id) updated = connection.updateKeywords(keywords) || updated; return updated;
    },
    closeConversation(id: string) { for (const connection of connections.values()) if (connection.grant?.conversationId === id) connection.close(); },
    close() { for (const connection of connections.values()) connection.close(); server.close(); },
  };
}
