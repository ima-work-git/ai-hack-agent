import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlassesMirrorPublisher } from '../src/glasses-mirror';

afterEach(() => { vi.useRealTimers(); });
describe('glasses mirror publisher', () => {
  it('coalesces queued frames and never includes audio or a previous login frame', async () => {
    vi.useFakeTimers();
    let token = 'first-session';
    let release!: (response: Response) => void;
    const send = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(done => { release = done; }))
      .mockResolvedValue(new Response('{}'));
    const publisher = new GlassesMirrorPublisher(() => token, send);
    publisher.updateStatus({ state: 'connected' });
    for (const content of ['first', 'middle', 'latest']) publisher.display({ header: 'header', content, footer: 'footer' });
    expect(send).toHaveBeenCalledTimes(1);
    release(new Response('{}'));
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1]![1]!.body as string)).toEqual({ view: { header: 'header', content: 'latest', footer: 'footer' }, state: 'connected' });
    token = 'other-session';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    publisher.dispose();
  });
  it('clears the view on disconnect and retries a transport error without throwing', async () => {
    vi.useFakeTimers();
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response('{}'));
    const publisher = new GlassesMirrorPublisher(() => 'session', send);
    publisher.display({ header: 'header', content: 'private view', footer: 'footer' });
    await vi.advanceTimersByTimeAsync(1);
    publisher.updateStatus({ state: 'disconnected', reason: 'link_lost' });
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(send.mock.calls.at(-1)![1]!.body as string)).toEqual({ view: null, state: 'disconnected', reason: 'link_lost' });
    publisher.dispose();
  });
});
