import { describe, expect, it, vi } from 'vitest';
import { createSocialProvider } from '../server/social-provider.ts';
import { verifiedSocialIdentityForTarget } from '../src/shared/social-accounts.ts';

const NOW = new Date('2026-09-22T13:00:00.000Z');
const target = { personName: 'ちょまど', companyName: '' };
const secondTarget = { personName: '山崎大志', companyName: '' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const signal = () => new AbortController().signal;
type Platform = 'instagram' | 'facebook';
type Change = (row: Record<string, unknown>, platform: Platform) => Record<string, unknown> | Record<string, unknown>[];

function apiMock(change: Change = row => row) {
  const runs = new Map<string, { platform: Platform; profile: string; handle: string }>();
  let next = 0;
  const api = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/v2/actors/')) {
      const platform = url.pathname.includes('instagram') ? 'instagram' : 'facebook';
      const body = JSON.parse(String(options?.body)) as { directUrls?: string[]; startUrls?: { url: string }[] };
      const profile = platform === 'instagram' ? body.directUrls![0]! : body.startUrls![0]!.url;
      const id = `run${++next}`;
      runs.set(id, { platform, profile, handle: new URL(profile).pathname.split('/')[1]! });
      return json({ data: { id, status: 'SUCCEEDED', defaultDatasetId: id, usageTotalUsd: platform === 'instagram' ? 0.0027 : 0.016 } });
    }
    if (url.pathname.startsWith('/v2/datasets/')) {
      const run = runs.get(url.pathname.split('/')[3]!)!;
      const row: Record<string, unknown> = run.platform === 'instagram'
        ? { inputUrl: run.profile, url: 'https://www.instagram.com/p/fixture_123/?utm_source=fixture', caption: '  技術イベントで公開デモを披露しました。\n次回も楽しみです。  ', timestamp: '2026-09-20T12:00:00Z', ownerUsername: run.handle }
        : { facebookUrl: run.profile, url: `https://www.facebook.com/${run.handle}/posts/fixture_456?utm_source=fixture`, text: '公開講演で開発の工夫を紹介しました。', time: '2026-09-21T12:00:00Z', pageName: run.handle };
      const rows = change(row, run.platform);
      return json(Array.isArray(rows) ? rows : [rows]);
    }
    throw new Error('Unexpected request');
  });
  return api;
}
function provider(api: typeof fetch, extra: Partial<Parameters<typeof createSocialProvider>[1]> = {}) {
  return createSocialProvider({ apiToken: 'fixture-social' }, { fetch: api, now: () => NOW, ...extra });
}

describe('verified public social account selection', () => {
  it('handles kana, honorific and explicit matching company, while rejecting name/company conflicts', () => {
    expect(verifiedSocialIdentityForTarget({ personName: 'チョマドさん', companyName: '日本マイクロソフト' })?.id).toBe('madoka-chiyoda');
    expect(verifiedSocialIdentityForTarget({ personName: 'Taishi Yamasaki', companyName: '株式会社AlphaByte' })?.id).toBe('taishi-yamasaki');
    expect(verifiedSocialIdentityForTarget({ ...target, companyName: '別会社' })).toBeUndefined();
    expect(verifiedSocialIdentityForTarget({ personName: 'unknown', companyName: '' })).toBeUndefined();
    expect(verifiedSocialIdentityForTarget({ personName: 'someonechomado', companyName: '' })).toBeUndefined();
  });

  it('does not call any API for unregistered accounts or explicit company mismatch', async () => {
    const api = apiMock();
    const live = provider(api);
    expect(live.hasTarget(target)).toBe(true);
    expect(live.hasTarget({ ...target, companyName: '別会社' })).toBe(false);
    expect(await live.lookup({ ...target, companyName: '別会社' }, signal())).toEqual({ value: [], actualUsd: 0 });
    expect(api).not.toHaveBeenCalled();
  });
});

describe('bounded public social adapter', () => {
  it('starts both official actors with explicit charge/time/post caps and uses Bearer headers only', async () => {
    const api = apiMock();
    const result = await provider(api).lookup(target, signal());
    expect(api).toHaveBeenCalledTimes(4);
    const starts = api.mock.calls.filter(([url]) => String(url).includes('/actors/'));
    expect(starts).toHaveLength(2);
    expect(starts.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v2/actors/apify~instagram-scraper/runs', '/v2/actors/apify~facebook-posts-scraper/runs',
    ]);
    for (const [input, options] of api.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.apify.com');
      expect(url.searchParams.has('token')).toBe(false);
      expect(options).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer fixture-social' } });
      expect(options?.headers).not.toHaveProperty('Cookie');
    }
    for (const [url, options] of starts) {
      expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ timeout: '60', maxItems: '3', maxTotalChargeUsd: '0.1', restartOnError: 'false', waitForFinish: '0' });
      expect(JSON.parse(String(options?.body)).resultsLimit).toBe(3);
    }
    expect(result.value.map(source => source.kind)).toEqual(['instagram', 'facebook']);
    expect(result.reportedUsd).toBeCloseTo(0.0187);
    expect(result).not.toHaveProperty('actualUsd');
  });

  it('preserves post text and dates, removes tracking, and does not turn the static account link into identity proof', async () => {
    const sources = (await provider(apiMock()).lookup(target, signal())).value;
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ url: 'https://www.instagram.com/p/fixture_123/', topic: 'instagram',
      socialPost: { platform: 'instagram', authorHandle: 'chomado', profileUrl: 'https://www.instagram.com/chomado', identitySourceUrl: 'https://linktr.ee/chomado',
        createdAt: '2026-09-20T12:00:00.000Z', text: '  技術イベントで公開デモを披露しました。\n次回も楽しみです。  ' } });
    expect(sources[0]!.text).toBe(`公開プロフィール: 千代田まどか (@chomado)\n公開投稿: ${sources[0]!.socialPost!.text}`);
    expect(sources.every(source => source.retrievedAt === NOW.toISOString())).toBe(true);
    expect(sources[0]).not.toHaveProperty('identityVerified');
  });

  it('selects the most recently published item per platform even when upstream rows are unsorted', async () => {
    const api = apiMock((row, platform) => [
      { ...row, [platform === 'instagram' ? 'timestamp' : 'time']: '2020-01-01T00:00:00Z' },
      { ...row, [platform === 'instagram' ? 'timestamp' : 'time']: '2026-09-22T00:00:00Z' },
      { ...row, [platform === 'instagram' ? 'timestamp' : 'time']: '2026-01-01T00:00:00Z' },
    ]);
    expect((await provider(api).lookup(target, signal())).value.map(source => source.socialPost?.createdAt))
      .toEqual(['2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z']);
  });

  it.each([
    ['different author', (row: Record<string, unknown>, platform: Platform) => ({ ...row, [platform === 'instagram' ? 'ownerUsername' : 'pageName']: 'unrelated' })],
    ['missing author', (row: Record<string, unknown>, platform: Platform) => ({ ...row, [platform === 'instagram' ? 'ownerUsername' : 'pageName']: undefined })],
    ['conflicting request provenance', (row: Record<string, unknown>) => ({ ...row, inputUrl: 'https://www.instagram.com/someone_else' })],
    ['future date', (row: Record<string, unknown>, platform: Platform) => ({ ...row, [platform === 'instagram' ? 'timestamp' : 'time']: '2026-09-22T13:00:00.001Z' })],
    ['invalid date', (row: Record<string, unknown>, platform: Platform) => ({ ...row, [platform === 'instagram' ? 'timestamp' : 'time']: 'not-a-date' })],
    ['blank content', (row: Record<string, unknown>, platform: Platform) => ({ ...row, [platform === 'instagram' ? 'caption' : 'text']: '  ' })],
    ['oversized content', (row: Record<string, unknown>, platform: Platform) => ({ ...row, [platform === 'instagram' ? 'caption' : 'text']: 'x'.repeat(30_001) })],
    ['invalid host', (row: Record<string, unknown>) => ({ ...row, url: 'https://www.instagram.com.evil.test/p/post/' })],
    ['credentials in URL', (row: Record<string, unknown>) => ({ ...row, url: 'https://name:password@www.instagram.com/p/post/' })],
    ['non-post URL', (row: Record<string, unknown>, platform: Platform) => ({ ...row, url: `https://www.${platform}.com/chomado` })],
  ] as const)('rejects %s rather than creating a sourced fact', async (_name, change) => {
    expect((await provider(apiMock(change)).lookup(target, signal())).value).toEqual([]);
  });

  it('normalizes only approved hosts and accepts FB reel URLs only alongside the matching actual author', async () => {
    const api = apiMock((row, platform) => ({ ...row, url: platform === 'instagram' ? 'https://instagram.com/reel/fixture_1/' : 'https://m.facebook.com/reel/123456/?tracking=drop' }));
    expect((await provider(api).lookup(target, signal())).value.map(source => source.url)).toEqual(['https://www.instagram.com/reel/fixture_1/', 'https://www.facebook.com/reel/123456/']);
  });

  it('rejects another FB account path even when returned metadata claims the expected author', async () => {
    const api = apiMock((row, platform) => platform === 'facebook' ? { ...row, url: 'https://www.facebook.com/unrelated/posts/123' } : row);
    expect((await provider(api).lookup(target, signal())).value.map(source => source.kind)).toEqual(['instagram']);
  });

  it('keeps the other platform when one actor fails without retrying the paid start', async () => {
    const base = apiMock();
    const api = vi.fn<typeof fetch>().mockImplementation(async (url, options) => String(url).includes('facebook-posts-scraper') ? json({}, 503) : base(url, options));
    const result = await provider(api).lookup(target, signal());
    expect(result.value.map(source => source.kind)).toEqual(['instagram']);
    expect(api.mock.calls.filter(([url]) => String(url).includes('facebook-posts-scraper'))).toHaveLength(1);
    expect(result).not.toHaveProperty('actualUsd');
  });

  it('bounds response bytes and rejects a dataset with more than the requested three rows', async () => {
    const tooMany = apiMock(row => [row, row, row, row]);
    expect((await provider(tooMany).lookup(target, signal())).value).toEqual([]);
    const base = apiMock();
    const api = vi.fn<typeof fetch>().mockImplementation(async (url, options) => String(url).includes('/datasets/')
      ? new Response('[]', { headers: { 'content-length': '2000001' } }) : base(url, options));
    expect((await provider(api).lookup(target, signal())).value).toEqual([]);
  });

  it('scales both actor caps to a smaller caller reservation and never invents final USD', async () => {
    const api = apiMock();
    const result = await createSocialProvider({ apiToken: 'fixture', maximumChargeUsd: 0.10 }, { fetch: api, now: () => NOW }).lookup(target, signal());
    expect(api.mock.calls.filter(([url]) => String(url).includes('/actors/')).every(([url]) => new URL(String(url)).searchParams.get('maxTotalChargeUsd') === '0.05')).toBe(true);
    expect(result).not.toHaveProperty('actualUsd');
  });
});

describe('social cancellation and bounded cache', () => {
  it('fetches and caches each platform separately so a slower or empty IG result never delays FB', async () => {
    const api = apiMock((row, platform) => platform === 'instagram' ? [] : row);
    const live = provider(api);
    const facebook = await live.lookupPlatform(target, 'facebook', signal());
    expect(facebook.value.map(source => source.kind)).toEqual(['facebook']);
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.some(([url]) => String(url).includes('instagram'))).toBe(false);
    expect((await live.lookupPlatform(target, 'instagram', signal())).value).toEqual([]);
    expect(api).toHaveBeenCalledTimes(4);
    expect((await live.lookupPlatform(target, 'facebook', signal())).actualUsd).toBe(0);
    expect(api).toHaveBeenCalledTimes(4);
  });

  it('starts nothing when already cancelled', async () => {
    const api = apiMock(); const controller = new AbortController(); controller.abort();
    await expect(provider(api).lookup(target, controller.signal)).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });

  it('awaits aborts for both active runs after cancellation, with an independent cleanup signal', async () => {
    const controller = new AbortController();
    let sleeping = 0;
    const api = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith('/v2/actors/')) return json({ data: { id: path.includes('instagram') ? 'ig-run' : 'fb-run', status: 'RUNNING' } });
      if (path.endsWith('/abort')) {
        expect(options?.signal?.aborted).toBe(false);
        return json({ data: { id: path.split('/')[3], status: 'ABORTED' } });
      }
      throw new Error('Unexpected request');
    });
    const pending = provider(api, { sleep: async (_milliseconds, abort) => {
      sleeping += 1;
      await new Promise<void>((_resolve, reject) => abort.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } }).lookup(target, controller.signal);
    const outcome = pending.catch(error => error as Error);
    await vi.waitFor(() => expect(sleeping).toBe(2));
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(api.mock.calls.filter(([url]) => String(url).includes('/abort?'))).toHaveLength(2);
    expect(api.mock.calls.filter(([url]) => String(url).includes('/datasets/'))).toHaveLength(0);
  });

  it('captures creation IDs arriving after cancellation and awaits abort without fetching their datasets', async () => {
    const controller = new AbortController();
    const starts: ((response: Response) => void)[] = [];
    const api = vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith('/v2/actors/')) return new Promise(resolve => { starts.push(resolve); });
      expect(path.endsWith('/abort')).toBe(true);
      expect(options?.signal?.aborted).toBe(false);
      return json({ data: { id: path.split('/')[3], status: 'ABORTED' } });
    });
    const outcome = provider(api).lookup(target, controller.signal).catch(error => error as Error);
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    controller.abort();
    starts.forEach((resolve, index) => resolve(json({ data: { id: `late-run-${index}`, status: 'RUNNING' } })));
    expect(await outcome).toBeInstanceOf(Error);
    expect(api.mock.calls.filter(([url]) => String(url).includes('/abort?'))).toHaveLength(2);
  });

  it('aborts a known run when an invalid status would otherwise detach paid work', async () => {
    const api = vi.fn<typeof fetch>().mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      return json({ data: { id: path.includes('instagram') ? 'ig-run' : 'fb-run', status: path.endsWith('/abort') ? 'ABORTED' : 'UNRECOGNIZED' } });
    });
    expect((await provider(api).lookup(target, signal())).value).toEqual([]);
    expect(api.mock.calls.filter(([url]) => String(url).includes('/abort?'))).toHaveLength(2);
  });

  it('stops overdue actors and awaits bounded cleanup when its 75-second deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const api = vi.fn<typeof fetch>().mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        return json({ data: { id: 'deadline-run', status: path.endsWith('/abort') ? 'ABORTED' : 'RUNNING' } });
      });
      const pending = provider(api, { sleep: async (_milliseconds, abort) => {
        await new Promise<void>((_resolve, reject) => abort.addEventListener('abort', () => reject(new Error('deadline')), { once: true }));
      } }).lookupPlatform(target, 'instagram', signal());
      await vi.advanceTimersByTimeAsync(75_000);
      expect(await pending).toEqual({ value: [] });
      expect(api.mock.calls.filter(([url]) => String(url).includes('/abort?'))).toHaveLength(1);
      expect(api.mock.calls.filter(([url]) => String(url).includes('/actors/'))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not retry an uncertain creation request or report an unknown cost as zero', async () => {
    vi.useFakeTimers();
    try {
      const api = vi.fn<typeof fetch>().mockImplementation(async (_input, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('network timeout')), { once: true });
      }));
      const pending = provider(api).lookupPlatform(target, 'instagram', signal());
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toEqual({ value: [] });
      expect(api).toHaveBeenCalledTimes(1);
      expect(new URL(String(api.mock.calls[0]![0])).searchParams.get('timeout')).toBe('60');
    } finally { vi.useRealTimers(); }
  });

  it('reuses immutable results for five minutes, preserves retrieval time, then refetches expired data', async () => {
    let clock = NOW;
    const api = apiMock();
    const live = provider(api, { now: () => clock });
    const first = await live.lookup(target, signal());
    first.value[0]!.text = 'caller mutation';
    clock = new Date(NOW.getTime() + 299_999);
    const cached = await live.lookup(target, signal());
    expect(cached.actualUsd).toBe(0);
    expect(cached.reportedUsd).toBeUndefined();
    expect(cached.value[0]!.text).not.toBe('caller mutation');
    expect(cached.value[0]!.retrievedAt).toBe(NOW.toISOString());
    expect(api).toHaveBeenCalledTimes(4);
    clock = new Date(NOW.getTime() + 300_000);
    expect((await live.lookup(target, signal())).actualUsd).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(8);
  });

  it('uses only a thirty-second negative cache and evicts the least-recently-used identity at capacity', async () => {
    let clock = NOW;
    const negativeApi = apiMock(() => []);
    const negative = provider(negativeApi, { now: () => clock });
    await negative.lookup(target, signal());
    clock = new Date(NOW.getTime() + 29_999);
    expect((await negative.lookup(target, signal())).actualUsd).toBe(0);
    expect(negativeApi).toHaveBeenCalledTimes(4);
    clock = new Date(NOW.getTime() + 30_000);
    await negative.lookup(target, signal());
    expect(negativeApi).toHaveBeenCalledTimes(8);
    const api = apiMock();
    const bounded = provider(api, { cacheMaximumEntries: 2 });
    await bounded.lookup(target, signal());
    await bounded.lookup(secondTarget, signal());
    await bounded.lookup(target, signal());
    expect(api).toHaveBeenCalledTimes(12);
  });
});
