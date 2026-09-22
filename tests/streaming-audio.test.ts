import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingAudio } from '../src/streaming-audio.ts';

class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn((_data: string | ArrayBuffer) => {});
  close = vi.fn(() => { this.readyState = 3; });
  open() { this.readyState = 1; this.onopen?.(); }
  event(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function fixture() {
  const sockets: FakeSocket[] = [];
  const onDelta = vi.fn(); const onFinal = vi.fn(); const onError = vi.fn(); const onClose = vi.fn();
  const createSocket = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
  const audio = new StreamingAudio({ onDelta, onFinal, onError, onClose, endpoint: 'wss://example.test/api/asr', createSocket });
  return { audio, onDelta, onFinal, onError, onClose, createSocket, get socket() { return sockets.at(-1)!; } };
}

describe('streaming PCM client (mocked WebSocket)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('uses a same-origin websocket, authenticates once, and waits for server ready', async () => {
    vi.stubGlobal('window', { location: { href: 'https://app.example/path?ignored=1#ignored' } });
    const socket = new FakeSocket(); const factory = vi.fn(() => socket as unknown as WebSocket);
    const audio = new StreamingAudio({ onDelta: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), createSocket: factory });
    const ready = vi.fn(); const starting = audio.start('one-use-ticket').then(value => { ready(value); return value; });
    expect(factory).toHaveBeenCalledExactlyOnceWith('wss://app.example/api/asr');
    expect(socket.send).not.toHaveBeenCalled(); socket.open(); socket.onopen?.();
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'auth', ticket: 'one-use-ticket' }));
    await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
    socket.event({ type: 'ready' }); expect(await starting).toBe(true); audio.cancel();
  });

  it('drops preparation PCM without replay, then immediately sends only ready-state frames', async () => {
    const f = fixture(); const starting = f.audio.start('ticket');
    const first = new Uint8Array([1, 2]); f.audio.append(first); first.fill(9);
    f.audio.append(new Uint8Array([3, 4])); f.socket.open();
    expect(f.socket.send).toHaveBeenCalledTimes(1);
    f.socket.event({ type: 'ready' }); expect(await starting).toBe(true);
    expect(f.socket.send).toHaveBeenCalledTimes(1);
    const frame = new Uint8Array([5, 6]); f.audio.append(frame); frame.fill(9);
    expect(f.socket.send.mock.calls.slice(1).map(([value]) => [...new Uint8Array(value as ArrayBuffer)]))
      .toEqual([[5, 6]]);
    f.socket.event({ type: 'delta', itemId: 'a', text: '増分' });
    f.socket.event({ type: 'delta', itemId: 'a', text: 'です' });
    f.socket.event({ type: 'final', itemId: 'a', text: '増分です' });
    expect(f.onDelta.mock.calls).toEqual([['a', '増分'], ['a', 'です']]);
    expect(f.onFinal).toHaveBeenCalledExactlyOnceWith('a', '増分です');
    f.audio.cancel();
  });

  it('waits beyond two seconds with continuous preparation PCM without retaining it or stopping', async () => {
    const f = fixture(); const starting = f.audio.start('ticket');
    const ready = vi.fn(); void starting.then(ready); f.socket.open();
    for (let second = 0; second < 5; second++) {
      const frame = new Uint8Array(32_000).fill(second + 1);
      const copy = vi.spyOn(frame, 'slice');
      f.audio.append(frame);
      expect(copy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(ready).not.toHaveBeenCalled();
    expect(f.socket.send).toHaveBeenCalledTimes(1);
    expect(f.onError).not.toHaveBeenCalled(); expect(f.socket.close).not.toHaveBeenCalled();
    f.socket.event({ type: 'ready' }); expect(await starting).toBe(true);
    expect(f.socket.send).toHaveBeenCalledTimes(1);
    f.audio.append(new Uint8Array([7, 8]));
    expect([...new Uint8Array(f.socket.send.mock.calls[1]![0] as ArrayBuffer)]).toEqual([7, 8]);
    f.audio.cancel();
  });

  it('stops on transport backpressure without sending or retaining another frame', async () => {
    const f = fixture(); const starting = f.audio.start('ticket'); f.socket.open(); f.socket.event({ type: 'ready' }); await starting;
    f.socket.bufferedAmount = 63_998; f.audio.append(new Uint8Array(2)); expect(f.socket.send).toHaveBeenCalledTimes(2);
    f.socket.bufferedAmount = 64_000; f.audio.append(new Uint8Array(2));
    expect(f.socket.send).toHaveBeenCalledTimes(2); expect(f.onError).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledOnce();
  });

  it('cancels preparation and ignores delayed events from the previous connection after restart', async () => {
    const f = fixture(); const previous = f.audio.start('old'); const old = f.socket;
    const lateOpen = old.onopen!; const lateMessage = old.onmessage!; const lateClose = old.onclose!;
    f.audio.append(new Uint8Array(96_000));
    expect(await f.audio.start('duplicate')).toBe(false); f.audio.cancel(); expect(await previous).toBe(false);
    const next = f.audio.start('new'); f.socket.open(); f.socket.event({ type: 'ready' }); expect(await next).toBe(true);
    lateOpen(); lateMessage({ data: JSON.stringify({ type: 'final', itemId: 'old', text: 'obsolete' }) }); lateClose();
    expect(old.send).not.toHaveBeenCalled(); expect(f.onFinal).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled();
    f.audio.append(new Uint8Array(2)); expect(f.socket.send).toHaveBeenCalledTimes(2); f.audio.cancel();
  });

  it('times out preparation even with no PCM and clears the timeout after ready', async () => {
    const f = fixture(); const timedOut = f.audio.start('ticket'); await vi.advanceTimersByTimeAsync(10_000);
    expect(await timedOut).toBe(false); expect(f.onError).toHaveBeenCalledOnce();
    const next = f.audio.start('ticket'); f.socket.open(); f.socket.event({ type: 'ready' }); expect(await next).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); f.audio.append(new Uint8Array(2));
    expect(f.socket.close).not.toHaveBeenCalled(); f.audio.cancel();
  });

  it('keeps the ten-second preparation deadline even while dropping incoming PCM', async () => {
    const f = fixture(); const starting = f.audio.start('ticket'); f.socket.open();
    for (let second = 0; second < 10; second++) {
      f.audio.append(new Uint8Array(32_000));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(await starting).toBe(false);
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.onError.mock.calls[0]![0].message).toContain('準備がタイムアウト');
    expect(f.socket.send).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'closed', 'close', 'socket-error', 'invalid', 'odd-pcm'] as const)('stops once on %s and suppresses later frames', async reason => {
    const f = fixture(); const starting = f.audio.start('ticket'); f.socket.open(); f.socket.event({ type: 'ready' }); await starting;
    if (reason === 'error') f.socket.event({ type: 'error', message: '音声を処理できません。' });
    if (reason === 'closed') f.socket.event({ type: 'closed' });
    if (reason === 'close') f.socket.onclose?.();
    if (reason === 'socket-error') f.socket.onerror?.();
    if (reason === 'invalid') f.socket.event({ type: 'delta', itemId: 'x', text: 42 });
    if (reason === 'odd-pcm') f.audio.append(new Uint8Array(1));
    f.audio.append(new Uint8Array(2)); f.socket.event({ type: 'final', itemId: 'late', text: 'late' }); f.audio.cancel();
    expect(f.socket.send).toHaveBeenCalledTimes(1); expect(f.onFinal).not.toHaveBeenCalled(); expect(f.onClose).toHaveBeenCalledOnce();
  });
});
