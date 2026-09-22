import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetLedger } from '../server/budget.ts';
import type { OpenAIStreamingASROptions } from '../server/openai-streaming-asr.ts';
import { createStreamingRelay } from '../server/ws-relay.ts';

const mocks = vi.hoisted(() => ({ servers: [] as EventEmitter[], upstreams: [] as { options: OpenAIStreamingASROptions; append: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] }));
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
  append = vi.fn(); stop = vi.fn();
  constructor(options: OpenAIStreamingASROptions) { this.options = options; mocks.upstreams.push(this); }
  async start() { this.options.onReady?.(); }
} }));
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  messages: Record<string, unknown>[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
  terminate = vi.fn(() => { this.readyState = 3; });
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { mocks.servers.length = 0; mocks.upstreams.length = 0; vi.useRealTimers(); });
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
  it('reserves connection time before the next minute and closes immediately when additional budget is denied', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    f.reserve.mockRejectedValueOnce(new Error('budget'));
    await vi.advanceTimersByTimeAsync(56_000);
    expect(f.reserve).toHaveBeenCalledTimes(2); expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.stop).toHaveBeenCalledOnce();
    f.relay.close();
  });
  it('closes once without recursive sends when downstream output is backpressured', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    socket.bufferedAmount = 64_001;
    expect(() => mocks.upstreams[0]!.options.onDelta?.('item', 'text')).not.toThrow();
    expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.stop).toHaveBeenCalledOnce();
    expect(socket.messages).not.toContainEqual({ type: 'closed' });
    f.relay.close(); expect(socket.terminate).toHaveBeenCalledOnce();
  });
  it('rejects oversized or excessive audio and stops upstream when the session expires', async () => {
    const f = setup(); const socket = f.connect(); f.auth(socket); await flush();
    socket.emit('message', Buffer.alloc(64_002), true); await flush(); expect(socket.terminate).toHaveBeenCalledOnce(); expect(mocks.upstreams[0]!.append).not.toHaveBeenCalled();
    f.relay.close();
    const next = setup(); const expired = next.connect(); next.auth(expired); await flush(); next.expire(); await vi.advanceTimersByTimeAsync(1_000);
    expect(expired.terminate).toHaveBeenCalledOnce(); next.relay.close();
  });
});
