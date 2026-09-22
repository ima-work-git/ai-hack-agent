import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { OpenAIStreamingASR } from './openai-streaming-asr.ts';
import type { BudgetLedger } from './budget.ts';

export interface StreamGrant {
  sessionId: string;
  conversationId: string;
  expiresAt: number;
  valid: () => boolean;
  onFinal: (text: string) => void;
}
interface RelayOptions {
  apiKey: string;
  model: string;
  maximumPerMinute: number;
  budget?: BudgetLedger;
  allowOrigin: (req: IncomingMessage) => boolean;
  takeTicket: (ticket: string) => StreamGrant;
  now: () => number;
}

/** Same-origin, one-use authentication. Only server-side credentials reach upstream. */
export function createStreamingRelay(options: RelayOptions) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 64_000, perMessageDeflate: false });
  const connections = new Map<WebSocket, { grant?: StreamGrant; close: () => void }>();
  server.on('connection', socket => {
    let ended = false; let authenticated = false; let ready = false;
    let upstream: OpenAIStreamingASR | undefined;
    let grant: StreamGrant | undefined;
    let bytes = 0; let reservedMinutes = 0; let queuedBytes = 0;
    let allowance = 64_000; let lastFrameAt = options.now(); let connectedAt = options.now();
    let pending = Promise.resolve();
    const send = (value: unknown) => {
      if (ended || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 64_000) { finish(); return; }
      socket.send(JSON.stringify(value));
    };
    const finish = () => {
      if (ended) return;
      ended = true; ready = false;
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 64_000) {
        try { socket.send(JSON.stringify({ type: 'closed' })); } catch { /* Teardown must still close upstream. */ }
      }
      clearTimeout(authTimer); clearInterval(expiryTimer);
      upstream?.stop(); connections.delete(socket); socket.terminate();
    };
    const fail = (message = '音声接続を終了しました。接続・費用上限を確認してください。') => { send({ type: 'error', message }); finish(); };
    const authTimer = setTimeout(() => fail('音声接続の認証が期限切れです。'), 5_000);
    const expiryTimer = setInterval(() => {
      if (grant && !grant.valid()) { finish(); return; }
      if (!ready || !grant) return;
      const ownGrant = grant;
      // Reserve the next minute five seconds before its connection-time boundary.
      const required = Math.ceil((options.now() - connectedAt + 5_000) / 60_000);
      if (required <= reservedMinutes) return;
      pending = pending.then(async () => {
        if (ended || !ownGrant.valid()) { finish(); return; }
        while (reservedMinutes < required) { await options.budget!.reserve(ownGrant.conversationId, options.maximumPerMinute); reservedMinutes++; }
      }).catch(() => fail());
    }, 1_000);
    connections.set(socket, { close: finish });
    socket.on('error', () => finish()); socket.on('close', () => finish());
    socket.on('message', (raw, binary) => {
      if (ended) return;
      const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      if (!authenticated) {
        if (binary || data.length > 256) { fail('音声接続の認証形式が不正です。'); return; }
        try {
          const auth = JSON.parse(data.toString());
          if (auth.type !== 'auth' || typeof auth.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(auth.ticket)) throw new Error('auth');
          grant = options.takeTicket(auth.ticket); authenticated = true; clearTimeout(authTimer);
          if ([...connections.values()].some(connection => connection.grant?.conversationId === grant!.conversationId)) throw new Error('duplicate');
          connections.set(socket, { grant, close: finish });
          const ownGrant = grant;
          pending = (async () => {
            if (!options.budget || !Number.isFinite(options.maximumPerMinute) || options.maximumPerMinute <= 0) throw new Error('budget');
            await options.budget.reserve(ownGrant.conversationId, options.maximumPerMinute); reservedMinutes = 1;
            if (ended || !ownGrant.valid()) { finish(); return; }
            connectedAt = options.now();
            upstream = new OpenAIStreamingASR({ apiKey: options.apiKey, model: options.model,
              onReady: () => { if (ended || !ownGrant.valid()) { finish(); return; } ready = true; send({ type: 'ready' }); },
              onDelta: (itemId, text) => { if (!ownGrant.valid()) { finish(); return; } send({ type: 'delta', itemId, text }); },
              onFinal: (itemId, text) => {
                if (ended || !ownGrant.valid()) { finish(); return; }
                const trimmed = text.trim().slice(0, 2000); if (!trimmed) return;
                ownGrant.onFinal(trimmed); send({ type: 'final', itemId, text: trimmed });
              }, onError: () => fail(), onClose: finish,
            });
            await upstream.start();
          })().catch(() => fail());
        } catch { fail('音声接続の認証が無効です。もう一度開始してください。'); }
        return;
      }
      if (!binary) {
        try { if (JSON.parse(data.toString()).type === 'stop') { finish(); return; } } catch { /* Invalid control fails closed. */ }
        fail(); return;
      }
      if (!ready || !grant?.valid() || !data.length || data.length > 64_000 || data.length % 2 || queuedBytes + data.length > 128_000) { fail(); return; }
      const at = options.now(); allowance = Math.min(64_000, allowance + Math.max(0, at - lastFrameAt) * 32); lastFrameAt = at;
      if (data.length > allowance) { fail('音声の送信速度が上限を超えました。'); return; }
      allowance -= data.length; queuedBytes += data.length;
      const copy = Buffer.from(data); const ownGrant = grant;
      pending = pending.then(async () => {
        if (ended || !ownGrant.valid()) { finish(); return; }
        const required = Math.max(Math.ceil((bytes + copy.length) / (32_000 * 60)), Math.ceil((options.now() - connectedAt + 5_000) / 60_000));
        while (reservedMinutes < required) { await options.budget!.reserve(ownGrant.conversationId, options.maximumPerMinute); reservedMinutes++; }
        if (ended || !ownGrant.valid()) { finish(); return; }
        upstream!.append(copy); bytes += copy.length;
      }).catch(() => fail()).finally(() => { queuedBytes -= copy.length; copy.fill(0); });
    });
  });
  return {
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (req.url?.split('?')[0] !== '/api/asr') return false;
      if (!options.apiKey || !options.allowOrigin(req) || connections.size >= 20) { socket.destroy(); return true; }
      server.handleUpgrade(req, socket, head, ws => server.emit('connection', ws, req)); return true;
    },
    closeConversation(id: string) { for (const connection of connections.values()) if (connection.grant?.conversationId === id) connection.close(); },
    close() { for (const connection of connections.values()) connection.close(); server.close(); },
  };
}
