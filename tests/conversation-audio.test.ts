import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationAudio } from '../src/conversation-audio.ts';
const pcm = (seconds: number, value = 256) => {
  const bytes = new Uint8Array(seconds * 32000), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length; i += 2) view.setInt16(i, value, true);
  return bytes;
};
afterEach(() => vi.useRealTimers());
describe('bounded conversation capture', () => {
  it('processes during capture, bounds latest audio to twelve seconds and stops at three windows', async () => {
    vi.useFakeTimers(); const lengths: number[] = []; const onComplete = vi.fn();
    const capture = new ConversationAudio({ onWindow: async chunks => { lengths.push(chunks.reduce((n,c) => n+c.length,0)); }, onComplete });
    capture.start();
    for (let i=0;i<4;i++) { capture.append(pcm(8)); await vi.advanceTimersByTimeAsync(8000); }
    expect(lengths).toEqual([8*32000,12*32000,12*32000]); expect(onComplete).toHaveBeenCalledOnce();
  });
  it('serializes slow work and keeps only the latest pending window', async () => {
    vi.useFakeTimers(); let release!: () => void; const values: number[] = [];
    const capture = new ConversationAudio({ onWindow: async chunks => { values.push(new DataView(chunks.at(-1)!.buffer).getInt16(0,true)); if(values.length===1) await new Promise<void>(r=>{release=r;}); } });
    capture.start(); capture.append(pcm(8,256)); await vi.advanceTimersByTimeAsync(8000);
    capture.append(pcm(8,512)); await vi.advanceTimersByTimeAsync(8000);
    capture.append(pcm(8,768)); await vi.advanceTimersByTimeAsync(8000);
    expect(values).toEqual([256]); release(); await vi.advanceTimersByTimeAsync(0);
    expect(values).toEqual([256,768]); capture.cancel();
  });
  it('aborts work and drops queued audio on cancellation', async () => {
    vi.useFakeTimers(); let signal!: AbortSignal; let release!:()=>void; const onWindow=vi.fn(async (_chunks, current: AbortSignal)=>{signal=current;await new Promise<void>(r=>{release=r;});});
    const capture=new ConversationAudio({onWindow}); capture.start();capture.append(pcm(8));await vi.advanceTimersByTimeAsync(8000);
    capture.append(pcm(8));capture.finish();capture.cancel();expect(signal.aborted).toBe(true);release();await vi.advanceTimersByTimeAsync(0);expect(onWindow).toHaveBeenCalledOnce();
  });
  it('skips digital silence and flushes a final voiced window once', async () => {
    vi.useFakeTimers();const onWindow=vi.fn(async()=>{});const onComplete=vi.fn();const capture=new ConversationAudio({onWindow,onComplete});
    capture.start();capture.append(pcm(8,0));await vi.advanceTimersByTimeAsync(8000);expect(onWindow).not.toHaveBeenCalled();
    capture.append(pcm(2));capture.finish();await vi.advanceTimersByTimeAsync(0);capture.finish();expect(onWindow).toHaveBeenCalledOnce();expect(onComplete).toHaveBeenCalledOnce();
  });
});
