import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetError, type BudgetLedger } from '../server/budget.ts';
import type { OpenAIStreamingASROptions } from '../server/openai-streaming-asr.ts';
import { createStreamingRelay } from '../server/ws-relay.ts';

const mocks = vi.hoisted(() => ({ startError: undefined as unknown, servers: [] as EventEmitter[], upstreams: [] as { options: OpenAIStreamingASROptions; append: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; resetInput: ReturnType<typeof vi.fn>; updateKeywords: ReturnType<typeof vi.fn> }[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { WebSocket: { OPEN: 1 }, WebSocketServer: class extends EventEmitter {
    constructor() { super(); mocks.servers.push(this); }
    close() {}
    handleUpgrade() { throw new Error('Unexpected upgrade'); }
  } };
});
vi.mock('../server/openai-streaming-asr.ts', () => ({ OpenAIStreamingASR: class {
  options: OpenAIStreamingASROptions;
  append = vi.fn(); stop = vi.fn(); resetInput = vi.fn(() => true); updateKeywords = vi.fn(() => true);
  constructor(options: OpenAIStreamingASROptions) { this.options = options; mocks.upstreams.push(this); }
  async start() { if (mocks.startError) throw mocks.startError; this.options.onReady?.(); }
} }));
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  messages: Record<string, unknown>[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
  terminate = vi.fn(() => { this.readyState = 3; });
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { mocks.startError = undefined; mocks.servers.length = 0; mocks.upstreams.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); });
const setup = () => {
  vi.useFakeTimers();
  const reserve = vi.fn(async () => ({ id: 'reservation' })); let available = true; let valid = true;
  const onFinal = vi.fn();
  const relay = createStreamingRelay({ apiKey: 'fake-key', model: 'gpt-live-transcribe', maximumPerMinute: 0.03,
    budget: { reserve } as unknown as BudgetLedger, now: Date.now, allowOrigin: () => false,
    takeTicket: () => { if (!available) throw new Error('used'); available = false; return { sessionId: 'session', conversationId: 'group', expiresAt: Date.now() + 900_000, valid: () => valid, onFinal }; },
  });
  const server = mocks.servers.at(-1)!;
  const connect = () => { const socket = new Socket(); server.emit('connection', socket); return socket; };
  const auth = (socket: Socket) => socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', ticket: 'a'.repeat(64) })), false);
  return { relay, reserve, connect, auth, onFinal, expire: () => { valid = false; } };
};
describe('authenticated streaming relay', () => {
  it('reserves before opening upstream, forwards PCM and bounded events, refuses replay and closes on group cancellation', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    expect(f.reserve).toHaveBeenCalledWith('group', 0.03); expect(socket.messages).toContainEqual({ type: 'ready' });
    socket.emit('message', Buffer.alloc(16_000), true); await flush();
    expect(mocks.upstreams[0]!.append).toHaveBeenCalledOnce();
    mocks.upstreams[0]!.options.onDelta?.('item', 'hello'); mocks.upstreams[0]!.options.onFinal?.('item', 'hello world');
    expect(socket.messages).toContainEqual({ type: 'delta', itemId: 'item', text: 'hello' }); expect(f.onFinal).toHaveBeenCalledWith('hello world');
    const replay = f.connect(); f.auth(replay); await flush(); expect(replay.terminate).toHaveBeenCalledOnce(); expect(f.reserve).toHaveBeenCalledOnce();
    f.relay.closeConversation('group'); expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.stop).toHaveBeenCalledOnce();
    f.relay.close();
  });
  it('resets only the matching conversation, discards queued old PCM, and keeps the same sockets and budget', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    const upstream = mocks.upstreams[0]!;
    expect(upstream.options.keywords).toContain('ひろゆき'); expect(upstream.options.keywords).toContain('ホリエモン');
    expect(upstream.options.keywords!.length).toBeLessThanOrEqual(20);
    socket.emit('message', Buffer.alloc(16_000), true);
    expect(f.relay.resetConversation?.('other-group')).toBe(false);
    expect(f.relay.resetConversation?.('group')).toBe(true); await flush();
    expect(upstream.resetInput).toHaveBeenCalledOnce(); expect(upstream.append).not.toHaveBeenCalled();
    socket.emit('message', Buffer.alloc(16_000), true); await flush();
    expect(upstream.append).toHaveBeenCalledOnce(); expect(upstream.stop).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled(); expect(f.reserve).toHaveBeenCalledOnce();
    expect(f.relay.updateKeywordsConversation?.('group', ['架空企業', '架空太郎'])).toBe(true);
    expect(upstream.updateKeywords).toHaveBeenCalledWith(expect.arrayContaining(['架空企業', '架空太郎', 'ひろゆき']));
    expect(upstream.updateKeywords.mock.calls[0]![0].length).toBeLessThanOrEqual(20);
    f.relay.close();
  });

  it('reserves connection time before the next minute and closes immediately when additional budget is denied', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    f.reserve.mockRejectedValueOnce(new BudgetError('BUDGET_EXHAUSTED'));
    await vi.advanceTimersByTimeAsync(56_000);
    expect(socket.messages).toContainEqual({ type: 'error', message: '音声認識の費用上限に達しました。上限設定を確認してください。' });
    expect(f.reserve).toHaveBeenCalledTimes(2); expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.stop).toHaveBeenCalledOnce();
    f.relay.close();
  });
  it('closes once without recursive sends when downstream output is backpressured', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    socket.bufferedAmount = 64_001;
    expect(() => mocks.upstreams[0]!.options.onDelta?.('item', 'text')).not.toThrow();
    expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.stop).toHaveBeenCalledOnce();
    expect(socket.messages).not.toContainEqual({ type: 'closed' });
    expect(console.warn).toHaveBeenCalledWith('[streaming-asr]', 'DOWNSTREAM_BACKPRESSURE');
    f.relay.close(); expect(socket.terminate).toHaveBeenCalledOnce();
  });
  it('rejects oversized or excessive audio and stops upstream when the session expires', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    socket.emit('message', Buffer.alloc(64_002), true); await flush(); expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.append).not.toHaveBeenCalled();
    f.relay.close();
    const next = setup(); const expired = next.connect(); next.auth(expired); await flush(); next.expire(); await vi.advanceTimersByTimeAsync(1_000);
    expect(expired.messages).toContainEqual({ type: 'error', message: '音声接続の認証期限が切れました。もう一度ログインして開始してください。' });
    expect(expired.terminate).toHaveBeenCalledOnce(); next.relay.close();
  });
  it('reports initial budget exhaustion without connecting to ASR', async () => {
    const f = setup(); f.reserve.mockRejectedValueOnce({ code: 'BUDGET_EXHAUSTED', message: 'private ledger path' });
    const socket = f.connect(); f.auth(socket); await flush();
    expect(socket.messages).toContainEqual({ type: 'error', message: '音声認識の費用上限に達しました。上限設定を確認してください。' });
    expect(mocks.upstreams).toHaveLength(0);
    expect(JSON.stringify(socket.messages)).not.toContain('private');
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[streaming-asr]', 'BUDGET_EXHAUSTED'); f.relay.close();
  });
  it.each([
    ['音声認識への接続が時間内に完了しませんでした。'],
    ['音声送信が追いつかないため停止しました。'],
    ['音声認識の応答を検証できませんでした。'],
  ])('forwards the adapter fixed reason without converting it to a generic failure: %s', async message => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    mocks.upstreams[0]!.options.onError?.(message);
    expect(socket.messages).toContainEqual({ type: 'error', message });
    expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.stop).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[streaming-asr]', 'ASR_ERROR'); f.relay.close();
  });
  it('hides raw connection errors and distinguishes a broken budget ledger', async () => {
    const f = setup(); mocks.startError = new Error('fake-secret-token https://private.example/transcript');
    const socket = f.connect(); f.auth(socket); await flush();
    expect(socket.messages).toContainEqual({ type: 'error', message: '音声認識との接続に失敗しました。接続を確認して再開してください。' });
    expect(JSON.stringify([socket.messages, vi.mocked(console.warn).mock.calls])).not.toMatch(/fake-secret|private.example|transcript/);
    f.relay.close(); mocks.startError = undefined;
    const next = setup(); next.reserve.mockRejectedValueOnce(new BudgetError('BUDGET_LEDGER_INVALID'));
    const broken = next.connect(); next.auth(broken); await flush();
    expect(broken.messages).toContainEqual({ type: 'error', message: '音声認識の費用管理を確認できないため停止しました。設定を確認してください。' }); next.relay.close();
  });
  it.each([
    ['format', 3, '音声データの形式またはサイズが不正なため停止しました。'],
    ['rate', 64_000, '音声の送信速度が上限を超えました。接続を確認して再開してください。'],
  ])('distinguishes invalid PCM from excessive send rate: %s', async (kind, length, message) => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    socket.emit('message', Buffer.alloc(length), true);
    if (kind === 'rate') socket.emit('message', Buffer.alloc(2), true);
    await flush();
    expect(socket.messages).toContainEqual({ type: 'error', message });
    expect(socket.terminate).toHaveBeenCalledOnce(); f.relay.close();
  });

});
