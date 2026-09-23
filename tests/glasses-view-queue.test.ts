import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { G2Runtime, type G2Bridge, type GlassesView } from '../src/integrations/g2-runtime';
import { GlassesViewQueue } from '../src/integrations/glasses-view-queue';

const view = (footer: string, content = '人物一覧'): GlassesView => ({ header: '雑談マスター', content, footer });

function fixture() {
  let active = 0;
  let maximumActive = 0;
  const bridge: G2Bridge = {
    createStartUpPageContainer: vi.fn(async () => 0),
    textContainerUpgrade: vi.fn(async () => {
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 700));
      active--; return true;
    }),
    audioControl: vi.fn(async () => true),
    onEvenHubEvent: vi.fn(() => () => {}),
    onDeviceStatusChanged: vi.fn(() => () => {}),
  };
  const onDisplay = vi.fn();
  const runtime = new G2Runtime({ bridge, onDisplay });
  let token = 'first';
  runtime.invalidateViews(token);
  const queue = new GlassesViewQueue((frame, currentToken) => runtime.render(frame, currentToken), currentToken => currentToken === token);
  const changeSubject = (nextToken = 'second') => { token = nextToken; queue.invalidate(); runtime.invalidateViews(token); };
  return { runtime, queue, onDisplay, changeSubject, maximumActive: () => maximumActive };
}

describe('serialized glasses views under continuous recognition', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps acknowledging actual displays while 500 ms speech updates outpace native writes', async () => {
    const f = fixture();
    await f.runtime.connect(undefined, 'first');
    const first = f.queue.enqueue(view('initial'), 'first');
    let latest = first;
    for (let i = 1; i <= 10; i++) {
      await vi.advanceTimersByTimeAsync(500);
      latest = f.queue.enqueue(view(`speech-${i}`), 'first');
    }
    // Publishing already progresses while updates continue, not only after silence.
    expect(f.onDisplay.mock.calls.length).toBeGreaterThan(1);
    expect(await first).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await latest).toBe(true);
    expect(f.onDisplay).toHaveBeenLastCalledWith({ ...view('speech-10'), textSize: undefined });
    expect(f.maximumActive()).toBe(1);
    await f.runtime.dispose();
  });

  it.each(['first', 'second'])('drops obsolete content across navigation/token invalidation (%s)', async nextToken => {
    const f = fixture();
    await f.runtime.connect(undefined, 'first');
    const obsolete = f.queue.enqueue(view('old', '以前の人物'), 'first');
    const dropped = f.queue.enqueue(view('old-later', '以前の人物'), 'first');
    await vi.advanceTimersByTimeAsync(300);
    f.changeSubject(nextToken);
    const current = f.queue.enqueue(view('new', '新しい人物'), nextToken);
    expect(await dropped).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await obsolete).toBe(false);
    expect(await current).toBe(true);
    expect(f.onDisplay).toHaveBeenCalledExactlyOnceWith({ ...view('new', '新しい人物'), textSize: undefined });
    await f.runtime.dispose();
  });
});
