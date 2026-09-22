import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIStreamingASR, PCM16To24Resampler } from '../server/openai-streaming-asr.ts';
import type { ASRSocket } from '../server/openai-streaming-asr.ts';

class Socket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(text: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(text)); callback?.(); }
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  terminate = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  open() { this.readyState = 1; this.emit('open'); }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  committed(itemId: string, previousId: string | null = null) { this.message({ type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: previousId }); }
}
const instances: OpenAIStreamingASR[] = [];
function fixture(signal?: AbortSignal) {
  const socket = new Socket();
  const connect = vi.fn(() => socket as unknown as ASRSocket);
  const callbacks = { onReady: vi.fn(), onDelta: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
  const asr = new OpenAIStreamingASR({ apiKey: 'synthetic-server-key', keywords: ['マイクロソフト', 'ちょまど'], signal, ...callbacks }, { connect });
  instances.push(asr);
  async function ready() {
    const pending = asr.start(); socket.open();
    socket.message({ type: 'session.updated', session: { type: 'transcription' } }); await pending;
  }
  return { asr, socket, connect, ...callbacks, ready };
}
afterEach(() => { instances.splice(0).forEach(asr => asr.stop()); vi.useRealTimers(); });
const pcm = (samples: number[]) => { const bytes = Buffer.alloc(samples.length * 2); samples.forEach((sample, i) => bytes.writeInt16LE(sample, i * 2)); return bytes; };

describe('server streaming transcription — mocked sockets only', () => {
  it('waits for transcription setup acknowledgement and keeps the key in server-side headers', async () => {
    const f = fixture(); const pending = f.asr.start();
    expect(() => f.asr.append(pcm([0]))).toThrow();
    f.socket.open();
    expect(f.connect).toHaveBeenCalledWith('wss://api.openai.com/v1/realtime?intent=transcription', expect.objectContaining({ headers: { Authorization: 'Bearer synthetic-server-key' }, maxPayload: 65536, followRedirects: false }));
    expect(f.socket.sent[0]).toMatchObject({ type: 'session.update', session: { type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null,
      transcription: { model: 'gpt-live-transcribe', languages: ['ja'], delay: 'low', keywords: ['マイクロソフト', 'ちょまど'] },
    } } } });
    expect(JSON.stringify(f.socket.sent)).not.toContain('synthetic-server-key');
    f.socket.message({ type: 'session.created', session: { type: 'transcription' } });
    expect(f.onReady).not.toHaveBeenCalled();
    f.socket.message({ type: 'session.updated', session: { type: 'transcription' } });
    await pending; expect(f.onReady).toHaveBeenCalledOnce();
  });
  it('preserves interpolation and phase across arbitrary even packet boundaries', () => {
    const bytes = pcm([0, 3000, 6000, 9000, -3000, -9000, 0]);
    const whole = new PCM16To24Resampler().convert(bytes);
    const stream = new PCM16To24Resampler();
    const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 8), bytes.subarray(8)];
    expect(Buffer.concat(chunks.map(chunk => stream.convert(chunk)))).toEqual(whole);
    expect(Array.from({ length: 4 }, (_, i) => whole.readInt16LE(i * 2))).toEqual([0, 2000, 4000, 6000]);
    const oneSecond = new PCM16To24Resampler().convert(Buffer.alloc(32000));
    expect(oneSecond.length).toBeGreaterThanOrEqual(47998);
    expect(oneSecond.length).toBeLessThanOrEqual(48000);
  });
  it('appends and forwards provisional deltas immediately before committing audio each five seconds', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.ready();
    f.asr.append(Buffer.alloc(3200));
    expect(f.socket.sent.at(-1)?.type).toBe('input_audio_buffer.append');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: '山田' });
    expect(f.onDelta).toHaveBeenCalledWith('item_1', '山田');
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.commit')).toHaveLength(0);
    f.asr.append(Buffer.alloc(3200));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
    f.socket.committed('item_1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
  });
  it('keeps final events keyed by item and drops duplicate finals or stale deltas', async () => {
    const f = fixture(); await f.ready();
    f.socket.committed('item_1'); f.socket.committed('item_2', 'item_1');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: '一番目' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_2', transcript: '二番目' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_2', transcript: '重複' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_2', delta: '遅着' });
    expect(f.onFinal.mock.calls).toEqual([['item_1', '一番目'], ['item_2', '二番目']]);
    expect(f.onDelta).not.toHaveBeenCalled();
    f.asr.stop();
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_3', transcript: '停止後' });
    expect(f.onFinal).toHaveBeenCalledTimes(2); expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('does not roll a newer final back to a late older turn or an item with unknown commit order', async () => {
    const f = fixture(); await f.ready();
    f.socket.committed('item_1'); f.socket.committed('item_2', 'item_1');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_2', transcript: '新しい対象' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: '古い対象' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: '遅い途中結果' });
    f.socket.committed('unknown-order', 'missing-predecessor');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unknown-order', transcript: '順序不明' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'not-committed', delta: '未確定' });
    expect(f.onFinal.mock.calls).toEqual([['item_2', '新しい対象']]);
    expect(f.onDelta.mock.calls).toEqual([['not-committed', '未確定']]);
    f.socket.committed('item_3', 'item_2');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_3', transcript: '次の対象' });
    expect(f.onFinal.mock.calls.at(-1)).toEqual(['item_3', '次の対象']);
    expect(f.onError).not.toHaveBeenCalled();
  });
  it('keeps forwarding more than 600 committed turns with bounded retired history and no replay of recent old items', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.ready();
    for (let i = 0; i < 800; i++) {
      const id = `turn_${i}`;
      f.asr.append(Buffer.alloc(6400)); await vi.advanceTimersByTimeAsync(5000);
      f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, delta: '途中' });
      f.socket.committed(id, i ? `turn_${i - 1}` : null);
      f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: `発話${i}` });
    }
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.commit')).toHaveLength(800);
    expect(f.onFinal).toHaveBeenCalledTimes(800); expect(f.onDelta).toHaveBeenCalledTimes(800);
    expect(f.onFinal.mock.calls.at(-1)).toEqual(['turn_799', '発話799']);
    // This item has been evicted, but is still in the bounded tombstone window.
    f.socket.committed('turn_300', 'turn_299');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'turn_300', delta: '古い人物' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'turn_300', transcript: '古い人物' });
    // Even an ancient final outside the tombstone window has no known order.
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'turn_0', transcript: 'さらに古い人物' });
    expect(f.onDelta).toHaveBeenCalledTimes(800); expect(f.onFinal).toHaveBeenCalledTimes(800);
    expect(f.asr.resetInput()).toBe(true); f.socket.message({ type: 'input_audio_buffer.cleared' });
    f.asr.append(Buffer.alloc(6400)); await vi.advanceTimersByTimeAsync(5000);
    f.socket.committed('after-reset', 'turn_799');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'after-reset', transcript: '新しい人物' });
    expect(f.onFinal).toHaveBeenLastCalledWith('after-reset', '新しい人物');
    expect(f.onError).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledOnce();
  });
  it('clears pending audio without reconnecting and suppresses old and clear-in-flight items while preserving commit order', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.ready();
    f.asr.append(Buffer.alloc(6400));
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'old', delta: '古い対象' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.asr.resetInput()).toBe(true); expect(f.asr.resetInput()).toBe(true);
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.clear')).toHaveLength(1);
    const priorAppends = f.socket.sent.filter(event => event.type === 'input_audio_buffer.append').length;
    f.asr.append(pcm([30000, 30000]));
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.append')).toHaveLength(priorAppends);
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'during-clear', delta: 'リセット中の対象' });
    f.socket.message({ type: 'input_audio_buffer.cleared' });
    // This old commit was already sent before reset, but its acknowledgement
    // can arrive later. It still advances sequence without becoming a subject.
    f.socket.committed('old');
    f.socket.committed('during-clear', 'old');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: '古い確定' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'during-clear', transcript: 'クリア前の確定' });
    f.asr.append(pcm([0, 0]));
    const appended = f.socket.sent.at(-1)!;
    expect(Buffer.from(appended.audio as string, 'base64')).toEqual(new PCM16To24Resampler().convert(pcm([0, 0])));
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'new', delta: '新しい対象' });
    f.socket.committed('new', 'during-clear');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new', transcript: '新しい確定' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'old', delta: '遅着' });
    expect(f.onDelta.mock.calls).toEqual([['old', '古い対象'], ['new', '新しい対象']]);
    expect(f.onFinal.mock.calls).toEqual([['new', '新しい確定']]);
    expect(f.onError).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledOnce();
  });

  it('suppresses an unseen late commit from before reset and never commits discarded clear-window PCM', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.ready();
    f.asr.append(Buffer.alloc(6400)); await vi.advanceTimersByTimeAsync(5000);
    f.asr.resetInput(); f.asr.append(Buffer.alloc(6400));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
    f.socket.message({ type: 'input_audio_buffer.cleared' });
    f.socket.committed('unseen-old');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'unseen-old', delta: '古い対象' });
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'unseen-old', transcript: '古い対象' });
    expect(f.onDelta).not.toHaveBeenCalled(); expect(f.onFinal).not.toHaveBeenCalled();
    f.asr.append(Buffer.alloc(6400)); await vi.advanceTimersByTimeAsync(5000);
    f.socket.committed('new', 'unseen-old');
    f.socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new', transcript: '新しい対象' });
    expect(f.onFinal).toHaveBeenCalledExactlyOnceWith('new', '新しい対象');
  });

  it('times out a missing clear acknowledgement instead of silently holding the microphone stream forever', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.ready(); f.asr.resetInput();
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith('音声入力のリセットが時間内に完了しませんでした。');
    expect(f.onClose).toHaveBeenCalledOnce(); expect(f.asr.resetInput()).toBe(false);
  });

  it('updates bounded recognition hints without restarting, forcing output, or forwarding invalid hint strings', async () => {
    const f = fixture(); await f.ready();
    expect(f.asr.updateKeywords(['ひろゆき', 'ホリエモン'])).toBe(true);
    const update = f.socket.sent.at(-1) as { session: { audio: { input: { transcription: { keywords: string[]; prompt: string } } } } };
    expect(update.session.audio.input.transcription.keywords).toEqual(['ひろゆき', 'ホリエモン']);
    expect(update.session.audio.input.transcription.prompt).toContain('用語ヒントを発話に挿入しない');
    f.socket.message({ type: 'session.updated', session: { type: 'transcription' } });
    expect(f.onReady).toHaveBeenCalledOnce(); expect(f.connect).toHaveBeenCalledOnce();
    const count = f.socket.sent.length;
    expect(f.asr.updateKeywords(['<injected>'])).toBe(false);
    expect(f.asr.updateKeywords(Array.from({ length: 21 }, (_, i) => `name${i}`))).toBe(false);
    expect(f.socket.sent).toHaveLength(count);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it.each(['odd', 'oversized', 'backpressure'])('fails closed for %s audio without sending more audio', async kind => {
    const f = fixture(); await f.ready();
    if (kind === 'backpressure') f.socket.bufferedAmount = 256 * 1024;
    expect(() => f.asr.append(Buffer.alloc(kind === 'odd' ? 3 : kind === 'oversized' ? 64002 : 320))).toThrow();
    expect(f.socket.sent.filter(event => event.type === 'input_audio_buffer.append')).toHaveLength(0);
    expect(f.onError).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledOnce();
  });
  it.each(['json', 'binary', 'size', 'upstream-error'])('rejects %s responses and never exposes an upstream error detail', async kind => {
    const f = fixture(); await f.ready();
    if (kind === 'json') f.socket.emit('message', Buffer.from('{'), false);
    if (kind === 'binary') f.socket.emit('message', Buffer.from('{}'), true);
    if (kind === 'size') f.socket.emit('message', Buffer.alloc(65537), false);
    if (kind === 'upstream-error') f.socket.message({ type: 'error', error: { message: 'synthetic-server-key private-text' } });
    expect(f.onError).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.onError.mock.calls)).not.toContain('synthetic-server-key');
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('times out configuration and aborts an opening connection without reconnecting', async () => {
    vi.useFakeTimers(); const f = fixture();
    const rejected = expect(f.asr.start()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8000); await rejected;
    expect(f.socket.terminate).toHaveBeenCalledOnce(); expect(f.connect).toHaveBeenCalledOnce();
    const controller = new AbortController(); const a = fixture(controller.signal);
    const aborted = expect(a.asr.start()).rejects.toThrow(); controller.abort(); await aborted;
    expect(a.socket.terminate).toHaveBeenCalledOnce(); expect(a.onClose).toHaveBeenCalledOnce();
  });
  it('does not create a socket with no key or a pre-aborted request', async () => {
    const connect = vi.fn();
    await expect(new OpenAIStreamingASR({ apiKey: '' }, { connect }).start()).rejects.toThrow();
    await expect(new OpenAIStreamingASR({ apiKey: 'fixture', signal: AbortSignal.abort() }, { connect }).start()).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
