import { describe, expect, it, vi } from 'vitest';
import { createLiveProvider } from '../server/providers.ts';
import type { ProviderConfig } from '../server/provider-contract.ts';

const now = new Date('2026-09-22T00:00:00.000Z');
const boundary = new Date('2026-09-15T00:00:00.000Z');
const user = { data: { id: '123', username: 'fixture_person', name: '架空花子', description: '架空会社の公開登壇者', protected: false } };
const config: ProviderConfig = { orcaApiKey: 'fixture-orca', orcaModel: 'fixture-model', tavilyApiKey: 'fixture-search',
  xEnabled: true, xBearerToken: 'fixture-x', xBalancedTopics: true };
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function post(id: string, createdAt: string, likes = 1, extra: Record<string, unknown> = {}) {
  return { id, author_id: '123', created_at: createdAt, text: `公開イベント${id}で製品設計について登壇しました。`,
    public_metrics: { like_count: likes, retweet_count: 2, reply_count: 3, quote_count: 4 }, ...extra };
}
const recent = (id = '100', extra: Record<string, unknown> = {}) => post(id, '2026-09-21T00:00:00.000Z', 1, extra);
const historic = (id = '200', likes = 10, extra: Record<string, unknown> = {}) => post(id, '2007-01-01T00:00:00.000Z', likes, extra);
function apiMock(recentPosts: unknown[] = [recent()], archivePosts: unknown[] = [historic()], archiveStatus = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/2/users/by/username/fixture_person') return json(user);
    if (url.pathname === '/2/users/123/tweets') return json({ data: recentPosts, meta: { result_count: recentPosts.length, next_token: 'must-not-follow' } });
    if (url.pathname === '/2/tweets/search/all' && url.searchParams.get('sort_order') === 'recency') return json({ meta: { result_count: 0 } });
    if (url.pathname === '/2/tweets/search/all') return json({ data: archivePosts, meta: { result_count: archivePosts.length, next_token: 'must-not-follow' } }, archiveStatus);
    throw new Error('Unexpected request');
  });
}
function providerWith(api: typeof fetch) {
  const page = vi.fn();
  return { provider: createLiveProvider(config, { fetch: api, fetchPage: page, now: () => now }), page };
}

describe('bounded balanced X topics', () => {
  it('makes exactly one lookup, one five-post recent page, and one twenty-post full-archive page', async () => {
    const api = apiMock();
    const { provider, page } = providerWith(api);
    const result = await provider.search('@fixture_person', signal());
    expect(api).toHaveBeenCalledTimes(3);
    const urls = api.mock.calls.map(call => new URL(String(call[0])));
    expect(urls.map(url => url.origin)).toEqual(Array(3).fill('https://api.x.com'));
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({ max_results: '5', exclude: 'retweets,replies',
      'tweet.fields': 'created_at,public_metrics,author_id' });
    expect(Object.fromEntries(urls[2]!.searchParams)).toEqual({ query: 'from:fixture_person -is:retweet -is:reply',
      start_time: '2006-03-21T00:00:00Z', end_time: boundary.toISOString(), sort_order: 'relevancy', max_results: '20',
      'tweet.fields': 'created_at,public_metrics,author_id' });
    for (const [, options] of api.mock.calls) expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer fixture-x' } });
    expect(result).not.toHaveProperty('actualUsd');
    expect(result).not.toHaveProperty('reportedUsd');
    for (const hit of result.value) await provider.fetchPage(hit, signal());
    expect(page).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('prioritizes profile + newest two + popular one, then bounded alternatives; popularity is not reply count', async () => {
    const api = apiMock([
      recent('104', { created_at: '2026-09-18T00:00:00Z' }), recent('102', { created_at: '2026-09-20T00:00:00Z' }),
      recent('103', { created_at: '2026-09-19T00:00:00Z' }), recent('101'), recent('105', { created_at: '2026-09-17T00:00:00Z' }),
    ], [historic('201', 20), historic('202', 1, { public_metrics: { like_count: 1, retweet_count: 0, quote_count: 0, reply_count: 100000 } }),
      historic('203', 5, { public_metrics: { like_count: 5, retweet_count: 15, quote_count: 10, reply_count: 0 } }), historic('204', 1)]);
    const { provider } = providerWith(api);
    const { value: hits } = await provider.search('@fixture_person', signal());
    expect(hits).toHaveLength(9);
    expect(hits.slice(0, 4).map(hit => [hit.url.split('/').at(-1), hit.topic])).toEqual([
      ['fixture_person', 'profile'], ['101', 'recent_x'], ['102', 'recent_x'], ['203', 'popular_x'],
    ]);
    expect(hits.filter(hit => hit.topic === 'recent_x')).toHaveLength(5);
    expect(hits.filter(hit => hit.topic === 'popular_x')).toHaveLength(3);
    expect(hits.some(hit => hit.url.endsWith('/202'))).toBe(false);
    const popular = await provider.fetchPage(hits[3]!, signal());
    expect(popular.value).toMatchObject({ topic: 'popular_x', xPost: { id: '203', authorId: '123', username: 'fixture_person',
      createdAt: '2007-01-01T00:00:00.000Z', likeCount: 5, repostCount: 15, replyCount: 0, quoteCount: 10,
      selectionScope: 'full_archive_sample', text: historic('203').text } });
    expect(popular.value.title).toContain('全期間検索の取得候補');
    expect(popular.value.title).not.toMatch(/最多|歴代|1位/);
  });

  it('preserves exact raw post text, with metadata separate from the profile and only historical selectionScope', async () => {
    const text = '  架空花子です。\n設計の展示を始めました。  ';
    const { provider } = providerWith(apiMock([recent('100', { text })], []));
    const { value: hits } = await provider.search('@fixture_person', signal());
    const profile = (await provider.fetchPage(hits[0]!, signal())).value;
    const source = (await provider.fetchPage(hits[1]!, signal())).value;
    expect(profile.topic).toBe('profile');
    expect(profile).not.toHaveProperty('xPost');
    expect(source.xPost?.text).toBe(text);
    expect(source.xPost).not.toHaveProperty('selectionScope');
    expect(source.text).toBe(`公開プロフィール: 架空花子 (@fixture_person)\n架空会社の公開登壇者\n公開投稿: ${text}`);
    expect(source.xPost).not.toHaveProperty('public_metrics');
  });

  it('starts recent and archive together after the public lookup without waiting for one another', async () => {
    let resolveRecent!: (value: Response) => void;
    let resolveArchive!: (value: Response) => void;
    const api = vi.fn<typeof fetch>().mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.includes('/by/username/')) return json(user);
      return new Promise(resolve => { if (path.endsWith('/tweets')) resolveRecent = resolve; else resolveArchive = resolve; });
    });
    const result = providerWith(api).provider.search('@fixture_person', signal());
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(3));
    resolveArchive(json({ data: [historic()] }));
    resolveRecent(json({ data: [recent()] }));
    expect((await result).value.map(hit => hit.topic)).toEqual(['profile', 'recent_x', 'popular_x']);
  });

  it('requires actual author/date, excludes future posts, and applies the seven-day cutoff only to archive', async () => {
    const api = apiMock([
      recent('100', { created_at: boundary.toISOString() }), recent('101', { author_id: '999' }),
      recent('102', { created_at: '2026-09-22T00:00:00.001Z' }), recent('103', { created_at: '2026-09-14T23:59:59Z' }),
      recent('104', { created_at: 'not-a-date' }),
    ], [historic('200', 1, { created_at: '2026-09-14T23:59:59.999Z' }), historic('201', 100, { created_at: boundary.toISOString() }),
      historic('202', 100, { created_at: '2006-03-20T00:00:00Z' }), historic('203', 100, { author_id: '999' }),
      historic('204', 100, { created_at: '2026-09-23T00:00:00Z' }), historic('205', 100, { created_at: undefined })]);
    const { value: hits } = await providerWith(api).provider.search('@fixture_person', signal());
    expect(hits.map(hit => hit.url.split('/').at(-1))).toEqual(['fixture_person', '100', '103', '200']);
  });

  it('admits account-latest posts older than seven days with their actual visible date and excludes them from archive candidates', async () => {
    const olderLatest = recent('100', { created_at: '2022-08-01T10:20:30.000Z' });
    const secondLatest = recent('101', { created_at: '2021-04-03T00:00:00.000Z' });
    const api = apiMock([secondLatest, olderLatest], [historic('100', 1000, { created_at: olderLatest.created_at }),
      historic('101', 500, { created_at: secondLatest.created_at }), historic('200', 10)]);
    const { provider } = providerWith(api);
    const { value: hits } = await provider.search('@fixture_person', signal());
    expect(hits.map(hit => [hit.url.split('/').at(-1), hit.topic])).toEqual([
      ['fixture_person', 'profile'], ['100', 'recent_x'], ['101', 'recent_x'], ['200', 'popular_x'],
    ]);
    const latestSource = (await provider.fetchPage(hits[1]!, signal())).value;
    expect(latestSource.xPost?.createdAt).toBe('2022-08-01T10:20:30.000Z');
    expect(latestSource.xPost?.text).toBe(olderLatest.text);
    expect(new URL(String(api.mock.calls[1]![0])).searchParams.has('start_time')).toBe(false);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('deduplicates within and across recent/archive before publishing candidate URLs', async () => {
    const api = apiMock([recent('100'), recent('100')], [historic('100', 100), historic('200'), historic('200')]);
    const hits = (await providerWith(api).provider.search('@fixture_person', signal())).value;
    expect(hits.map(hit => hit.url.split('/').at(-1))).toEqual(['fixture_person', '100', '200']);
  });

  it('skips unsafe topic posts and never fills a historical slot with unmeasured or zero engagement', async () => {
    const api = apiMock([recent('100', { text: '病気の治療について話します。' }), recent('101')], [
      historic('200', 1000, { text: '感染症の診断と治療についてです。' }), historic('201', 100, { public_metrics: undefined }),
      historic('202', 0, { public_metrics: { like_count: 0, retweet_count: 0, quote_count: 0, reply_count: 100 } }),
      historic('203', 10, { public_metrics: { like_count: -1, retweet_count: 2, quote_count: 4, reply_count: 3 } }),
      historic('204', 10, { public_metrics: { like_count: '10', retweet_count: 2, quote_count: 4, reply_count: 3 } }),
      historic('205', 10, { public_metrics: { like_count: 10, retweet_count: 2, quote_count: 4 } }),
    ]);
    const { value: hits } = await providerWith(api).provider.search('@fixture_person', signal());
    expect(hits.map(hit => [hit.url.split('/').at(-1), hit.topic])).toEqual([['fixture_person', 'profile'], ['101', 'recent_x']]);
  });

  it('accepts renamed repost_count but rejects conflicting or nonfinite metric aliases', async () => {
    const api = apiMock([], [
      historic('200', 1, { public_metrics: { like_count: 1, repost_count: 2, reply_count: 0, quote_count: 0 } }),
      historic('201', 1, { public_metrics: { like_count: 1, retweet_count: 2, repost_count: 3, reply_count: 0, quote_count: 0 } }),
      historic('202', 1, { public_metrics: { like_count: Infinity, retweet_count: 2, reply_count: 0, quote_count: 0 } }),
    ]);
    const { provider } = providerWith(api);
    const { value: hits } = await provider.search('@fixture_person', signal());
    expect(hits.map(hit => hit.url.split('/').at(-1))).toEqual(['fixture_person', '200']);
    expect((await provider.fetchPage(hits[1]!, signal())).value.xPost?.repostCount).toBe(2);
  });

  it.each([400, 401, 403, 429, 500])('retains recent/profile when archive responds %i without any fallback or retry', async status => {
    const api = apiMock([recent()], [], status);
    const { provider } = providerWith(api);
    const { value: hits } = await provider.search('@fixture_person', signal());
    expect(hits.map(hit => hit.topic)).toEqual(['profile', 'recent_x']);
    expect((await provider.fetchPage(hits[1]!, signal())).value.xPost?.id).toBe('100');
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('treats an oversized archive response as unavailable instead of raising the sample cap', async () => {
    const api = apiMock([recent()], Array.from({ length: 21 }, (_, index) => historic(String(200 + index))));
    const hits = (await providerWith(api).provider.search('@fixture_person', signal())).value;
    expect(hits.map(hit => hit.topic)).toEqual(['profile', 'recent_x']);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('ranks only the returned twenty archive candidates without fetching a continuation', async () => {
    const api = apiMock([recent()], Array.from({ length: 20 }, (_, index) => historic(String(200 + index), index + 1)));
    const hits = (await providerWith(api).provider.search('@fixture_person', signal())).value;
    expect(hits.filter(hit => hit.topic === 'popular_x').map(hit => hit.url.split('/').at(-1))).toEqual(['219', '218', '217']);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('makes just one recency archive fallback for an empty timeline and retains at most five latest candidates', async () => {
    const api = apiMock([], [historic('200')]);
    const base = api.getMockImplementation()!;
    const observed: number[] = [];
    api.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/search/all')) observed.push(Date.now());
      if (url.pathname.endsWith('/tweets')) return json({ meta: { result_count: 0 } });
      if (url.searchParams.get('sort_order') === 'recency') return json({ data: Array.from({ length: 10 }, (_, i) => recent(String(100 + i), {
        created_at: new Date(now.getTime() - (10 - i) * 24 * 60 * 60_000).toISOString(),
      })), meta: { result_count: 10, next_token: 'must-not-follow' } });
      return base(input, init);
    });
    const { value: hits } = await providerWith(api).provider.search('@fixture_person', signal());
    expect(hits.slice(0, 4).map(hit => [hit.url.split('/').at(-1), hit.topic])).toEqual([
      ['fixture_person', 'profile'], ['109', 'recent_x'], ['108', 'recent_x'], ['200', 'popular_x'],
    ]);
    expect(hits.filter(hit => hit.topic === 'recent_x')).toHaveLength(5);
    expect(hits.length).toBeLessThanOrEqual(9);
    expect(api).toHaveBeenCalledTimes(4);
    expect(observed[1]! - observed[0]!).toBeGreaterThanOrEqual(990);
    const fallback = new URL(String(api.mock.calls[3]![0]));
    expect(Object.fromEntries(fallback.searchParams)).toEqual({ query: 'from:fixture_person -is:retweet -is:reply',
      start_time: '2006-03-21T00:00:00Z', sort_order: 'recency', max_results: '10', 'tweet.fields': 'created_at,public_metrics,author_id' });
  });

  it('does not fetch extra candidates when a nonempty timeline is entirely rejected by topic/identity checks', async () => {
    const api = apiMock([recent('100', { text: '病気の治療を始めました。' }), recent('101', { author_id: '999' })], [historic()]);
    const hits = (await providerWith(api).provider.search('@fixture_person', signal())).value;
    expect(hits.map(hit => hit.topic)).toEqual(['profile', 'popular_x']);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('retains profile/history when the one recency fallback fails', async () => {
    const api = apiMock([], [historic()]);
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (input, init) => new URL(String(input)).searchParams.get('sort_order') === 'recency'
      ? json({}, 403) : base(input, init));
    const hits = (await providerWith(api).provider.search('@fixture_person', signal())).value;
    expect(hits.map(hit => hit.topic)).toEqual(['profile', 'popular_x']);
    expect(api).toHaveBeenCalledTimes(4);
  });

  it('propagates cancellation during the recency fallback request', async () => {
    const controller = new AbortController();
    const api = apiMock([], [historic()]);
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (input, init) => {
      if (new URL(String(input)).searchParams.get('sort_order') === 'recency') controller.abort();
      return base(input, init);
    });
    await expect(providerWith(api).provider.search('@fixture_person', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(api).toHaveBeenCalledTimes(4);
  });

  it('cancels the archive-rate wait without sending the fallback', async () => {
    const controller = new AbortController();
    const api = apiMock([], [historic()]);
    const result = providerWith(api).provider.search('@fixture_person', controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(3));
    controller.abort();
    await rejected;
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('never hides abort as an unavailable archive slot', async () => {
    const controller = new AbortController();
    const api = apiMock();
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/search/all')) controller.abort();
      return base(input, init);
    });
    await expect(providerWith(api).provider.search('@fixture_person', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(api).toHaveBeenCalledTimes(3);
  });

  it.each([{ ...user.data, protected: true }, { ...user.data, username: 'other_person' }])('stops before post requests when account is not the requested public account', async data => {
    const api = vi.fn<typeof fetch>().mockResolvedValue(json({ data }));
    await expect(providerWith(api).provider.search('@fixture_person', signal())).rejects.toMatchObject({ code: 'X_PUBLIC_ONLY' });
    expect(api).toHaveBeenCalledOnce();
  });

  it('preserves the two-request legacy path when balancing is disabled or not configured', async () => {
    for (const xBalancedTopics of [false, undefined]) {
      const api = apiMock([{ id: '100', author_id: '123', text: '公開投稿です。' }]);
      const provider = createLiveProvider({ ...config, xBalancedTopics }, { fetch: api, now: () => now });
      const result = await provider.search('@fixture_person', signal());
      expect(api).toHaveBeenCalledTimes(2);
      expect(result.value).toHaveLength(2);
      expect(result.value.every(hit => !hit.topic)).toBe(true);
    }
  });
});
