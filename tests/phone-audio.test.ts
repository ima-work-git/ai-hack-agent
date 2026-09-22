import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneAudio } from '../src/phone-audio.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class FakeTrack extends EventTarget {
  readyState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
}
function fakeStream() {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}
const fakeNode = () => ({ connect: vi.fn(), disconnect: vi.fn() });
function fakeContext(sampleRate: number) {
  const processor = { ...fakeNode(), onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null };
  const source = fakeNode();
  const gain = { ...fakeNode(), gain: { value: 1 } };
  const context = {
    sampleRate, state: 'suspended', destination: {}, onstatechange: null as (() => void) | null,
    resume: vi.fn(async () => { context.state = 'running'; }),
    close: vi.fn(async () => { context.state = 'closed'; }),
    createMediaStreamSource: vi.fn(() => source),
    createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(() => gain),
  };
  return { context, processor, source, gain };
}
function fixture(rate = 16_000) {
  const contexts: ReturnType<typeof fakeContext>[] = [];
  const streams: ReturnType<typeof fakeStream>[] = [];
  const getUserMedia = vi.fn(async () => {
    const stream = fakeStream(); streams.push(stream); return stream.stream;
  });
  const createAudioContext = vi.fn((_options: AudioContextOptions) => {
    const ctx = fakeContext(rate); contexts.push(ctx); return ctx.context as unknown as AudioContext;
  });
  const onAudio = vi.fn<(chunk: Uint8Array) => void>();
  const onStopped = vi.fn();
  const onError = vi.fn();
  const audio = new PhoneAudio({ onAudio, onStopped, onError, dependencies: { getUserMedia, createAudioContext, now: () => Date.now() } });
  return {
    audio, getUserMedia, createAudioContext, onAudio, onStopped, onError,
    get ctx() { return contexts[contexts.length - 1]!; },
    get stream() { return streams[streams.length - 1]!; },
    emit(input: Float32Array) {
      contexts[contexts.length - 1]!.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => input } } as unknown as AudioProcessingEvent);
    },
    pcm() {
      const chunks = onAudio.mock.calls.map(([chunk]) => chunk);
      const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
      return out;
    },
  };
}

describe('PhoneAudio — explicit memory-only phone capture (REQ-001, REQ-008; mocked browser)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('does not request a microphone until explicit start, then requests mono 16 kHz without video', async () => {
    const f = fixture();
    expect(f.audio.recording).toBe(false);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.createAudioContext).not.toHaveBeenCalled();
    expect(await f.audio.start()).toBe(true);
    expect(f.createAudioContext).toHaveBeenCalledWith({ sampleRate: 16_000 });
    expect(f.getUserMedia).toHaveBeenCalledWith({
      audio: { sampleRate: 16_000, channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false,
    });
    expect(f.audio.recording).toBe(true);
    expect(f.ctx.gain.gain.value).toBe(0);
    expect(await f.audio.start()).toBe(false);
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    await f.audio.stop();
  });

  it('emits clipped signed PCM16LE and keeps non-finite input silent', async () => {
    const f = fixture();
    await f.audio.start();
    f.emit(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity]));
    const pcm = f.pcm();
    const view = new DataView(pcm.buffer);
    expect(Array.from({ length: pcm.length / 2 }, (_, index) => view.getInt16(index * 2, true)))
      .toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0]);
    await f.audio.stop();
  });

  it('resamples actual 48 kHz input to 16 kHz by averaging the complete input interval', async () => {
    const f = fixture(48_000);
    await f.audio.start();
    f.emit(new Float32Array([1, 0, -1, 0.5, 0.5, 0.5]));
    const pcm = f.pcm();
    expect(pcm.length).toBe(4);
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(16384);
    await f.audio.stop();
  });

  it('preserves resampling phase across uneven callbacks at 44.1 kHz', async () => {
    const input = Float32Array.from({ length: 44_100 }, (_, i) => ((i % 100) - 50) / 100);
    const full = fixture(44_100);
    const split = fixture(44_100);
    await full.audio.start();
    await split.audio.start();
    full.emit(input);
    for (let offset = 0; offset < input.length; offset += 127) split.emit(input.subarray(offset, offset + 127));
    expect(full.pcm().length).toBe(32_000);
    expect(split.pcm()).toEqual(full.pcm());
    await full.audio.stop();
    await split.audio.stop();
  });

  it('converts a lower device rate to the same 16 kHz PCM contract', async () => {
    const f = fixture(8_000);
    await f.audio.start();
    f.emit(new Float32Array([1, -1]));
    expect([...f.pcm()]).toEqual([255, 127, 255, 127, 0, 128, 0, 128]);
    await f.audio.stop();
  });

  it('stops tracks and closes the context once, immediately suppressing already queued callbacks', async () => {
    const f = fixture();
    await f.audio.start();
    const queued = f.ctx.processor.onaudioprocess!;
    const stopped = f.audio.stop();
    expect(f.audio.recording).toBe(false);
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    queued({ inputBuffer: { getChannelData: () => new Float32Array([1]) } } as unknown as AudioProcessingEvent);
    expect(f.onAudio).not.toHaveBeenCalled();
    await stopped;
    await f.audio.stop();
    expect(f.ctx.context.close).toHaveBeenCalledOnce();
    expect(f.ctx.source.disconnect).toHaveBeenCalledOnce();
    expect(f.ctx.processor.disconnect).toHaveBeenCalledOnce();
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('user');
  });

  it('stops at 30 seconds even when no frames arrive', async () => {
    const f = fixture();
    await f.audio.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.audio.recording).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.audio.recording).toBe(false);
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('limit');
  });

  it('rejects frames after the deadline even if the timer callback was suspended', async () => {
    const f = fixture();
    await f.audio.start();
    vi.setSystemTime(Date.now() + 30_001);
    f.emit(new Float32Array([1, 1]));
    expect(f.onAudio).not.toHaveBeenCalled();
    expect(f.audio.recording).toBe(false);
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('limit');
  });

  it('caps PCM at exactly 960,000 bytes and never emits an excess sample', async () => {
    const f = fixture();
    await f.audio.start();
    f.emit(new Float32Array(479_999).fill(0.5));
    expect(f.audio.recording).toBe(true);
    f.emit(new Float32Array([1, 1, 1]));
    expect(f.pcm().byteLength).toBe(960_000);
    expect(f.audio.recording).toBe(false);
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('limit');
    f.emit(new Float32Array([1]));
    expect(f.pcm().byteLength).toBe(960_000);
  });

  it('handles permission denial without recording and closes the created context', async () => {
    const f = fixture();
    const denied = new Error('fixture-permission-detail');
    denied.name = 'NotAllowedError';
    f.getUserMedia.mockRejectedValueOnce(denied);
    expect(await f.audio.start()).toBe(false);
    expect(f.audio.recording).toBe(false);
    expect(f.ctx.context.close).toHaveBeenCalledOnce();
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('error');
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.onError.mock.calls[0]?.[0]).not.toContain('fixture-permission-detail');
  });

  it('times out permission acquisition and stops a microphone that resolves afterward', async () => {
    const f = fixture();
    const permission = deferred<MediaStream>();
    f.getUserMedia.mockReturnValueOnce(permission.promise);
    const starting = f.audio.start();
    expect(await f.audio.start()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await starting).toBe(false);
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('error');
    const late = fakeStream();
    permission.resolve(late.stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(f.onAudio).not.toHaveBeenCalled();
    expect(f.audio.recording).toBe(false);
  });

  it('cancels pending permission promptly and ignores the late permission result', async () => {
    const f = fixture();
    const permission = deferred<MediaStream>();
    f.getUserMedia.mockReturnValueOnce(permission.promise);
    const starting = f.audio.start();
    await f.audio.stop();
    expect(await starting).toBe(false);
    const late = fakeStream();
    permission.resolve(late.stream);
    await Promise.resolve();
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('user');
  });

  it('stops an obsolete permission result without stopping a newer explicit recording', async () => {
    const f = fixture();
    const permission = deferred<MediaStream>();
    f.getUserMedia.mockReturnValueOnce(permission.promise);
    const previous = f.audio.start();
    await f.audio.stop();
    expect(await previous).toBe(false);
    expect(await f.audio.start()).toBe(true);
    const current = f.stream;
    const late = fakeStream();
    permission.resolve(late.stream);
    await Promise.resolve();
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(f.audio.recording).toBe(true);
    await f.audio.stop();
  });

  it('stops a granted microphone if AudioContext resume never completes', async () => {
    const f = fixture();
    const ctx = fakeContext(16_000);
    ctx.context.resume.mockReturnValueOnce(new Promise(() => {}));
    f.createAudioContext.mockReturnValueOnce(ctx.context as unknown as AudioContext);
    const starting = f.audio.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await starting).toBe(false);
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(ctx.context.close).toHaveBeenCalledOnce();
  });

  it('does not resume automatically after context suspension, and requires a new explicit start', async () => {
    const f = fixture();
    await f.audio.start();
    f.ctx.context.state = 'suspended';
    f.ctx.context.onstatechange?.();
    await Promise.resolve();
    expect(f.audio.recording).toBe(false);
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('error');
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    await f.audio.stop();
    expect(await f.audio.start()).toBe(true);
    expect(f.getUserMedia).toHaveBeenCalledTimes(2);
    await f.audio.stop();
  });

  it('ends capture if the microphone disconnects', async () => {
    const f = fixture();
    await f.audio.start();
    f.stream.track.dispatchEvent(new Event('ended'));
    expect(f.audio.recording).toBe(false);
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('error');
    await f.audio.stop();
  });

  it('stops safely when an audio consumer throws', async () => {
    const f = fixture();
    f.onAudio.mockImplementationOnce(() => { throw new Error('consumer'); });
    await f.audio.start();
    f.emit(new Float32Array([1]));
    expect(f.audio.recording).toBe(false);
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(f.onStopped).toHaveBeenCalledExactlyOnceWith('error');
  });

  it('bounds stop waiting when closing the context stalls and blocks restart while closing', async () => {
    const f = fixture();
    await f.audio.start();
    f.ctx.context.close.mockReturnValueOnce(new Promise(() => {}));
    const stopped = f.audio.stop();
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(await f.audio.start()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;
    expect(f.audio.recording).toBe(false);
  });
});
