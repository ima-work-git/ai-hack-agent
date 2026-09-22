import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveProvider } from '../server/providers.ts';
import type { ProviderConfig } from '../server/provider-contract.ts';
import type { EvidenceSource, SearchOperation } from '../src/shared/contracts.ts';

const now = new Date('2026-09-22T00:00:00.000Z');
const config: ProviderConfig = { orcaApiKey: 'fixture-orca', orcaModel: 'fixture-model', tavilyApiKey: 'fixture-search',
  xEnabled: true, xBearerToken: 'fixture-x', xBalancedTopics: true };
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const user = { id: '123', username: 'fixture_person', name: '架空花子', description: '架空会社の公開登壇者', protected: false };
const post = (id: string, created_at = '2026-09-21T00:00:00.000Z', likes = 1, extra: Record<string, unknown> = {}) => ({
  id, text: `公開イベント${id}で製品設計について登壇しました。`, author_id: '123', created_at,
  public_metrics: { like_count: likes, retweet_count: 1, reply_count: 0, quote_count: 0 }, ...extra,
});
function apiMock(recent: unknown[] = [post('100')], archive: unknown[] = [post('200', '2020-01-01T00:00:00.000Z', 10)]) {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname.includes('/by/username/')) return json({ data: { ...user, username: url.pathname.split('/').at(-1) } });
    if (url.pathname === '/2/users/123/tweets') return json({ data: recent, meta: { result_count: recent.length, next_token: 'not-followed' } });
    if (url.pathname === '/2/tweets/search/all') return json({ data: archive, meta: { result_count: archive.length, next_token: 'not-followed' } });
    if (url.hostname === 'api.tavily.com') return json({ results: [{ url: 'https://example.org/', title: '公開プロフィール' }] });
    throw new Error('Unexpected request');
  });
}
const providerWith = (api: typeof fetch) => createLiveProvider(config, { fetch: api, now: () => now });
afterEach(() => vi.useRealTimers());

describe('progressive X retrieval', () => {
  it('observes actual lookup, recent and archive inputs before each API call, without claiming a cached lookup ran', async () => {
    const actual: SearchOperation[] = []; const api = apiMock(); const base = api.getMockImplementation()!;
    api.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const expected = url.pathname.endsWith('/search/all')
        ? { provider: 'x', operation: 'archive_search', query: url.searchParams.get('query') }
        : { provider: 'x', operation: url.pathname.endsWith('/tweets') ? 'recent_posts' : 'account_lookup', query: '@fixture_person' };
      expect(actual.at(-1)).toEqual(expected);
      expect(actual).toHaveLength(api.mock.calls.length);
      return base(input, init);
    });
    const provider = providerWith(api); const observe = (search: SearchOperation) => { actual.push(search); };
    await provider.searchRecent!('@FIXTURE_PERSON', signal(), observe);
    expect(actual.map(search => search.operation)).toEqual(['account_lookup', 'recent_posts']);
    await provider.searchRecent!('@fixture_person', signal(), observe);
    expect(actual).toHaveLength(2);
    await provider.searchArchive!('@fixture_person', signal(), observe);
    expect(actual.at(-1)).toEqual({ provider: 'x', operation: 'archive_search', query: 'from:fixture_person -is:retweet -is:reply' });
    expect(JSON.stringify(actual)).not.toContain(config.xBearerToken);
  });

  it('keeps per-call observers isolated and does not notify a cancelled request', async () => {
    const api = apiMock(); const provider = providerWith(api);
    const first = vi.fn(); const second = vi.fn();
    await Promise.all([provider.searchRecent!('@first_fixture', signal(), first), provider.searchRecent!('@other_fixture', signal(), second)]);
    expect(first.mock.calls.map(([search]) => search.query)).toEqual(['@first_fixture', '@first_fixture']);
    expect(second.mock.calls.map(([search]) => search.query)).toEqual(['@other_fixture', '@other_fixture']);
    const controller = new AbortController(); controller.abort();
    await expect(provider.searchRecent!('@third_fixture', controller.signal, first)).rejects.toBeDefined();
    expect(first).toHaveBeenCalledTimes(2); expect(api).toHaveBeenCalledTimes(4);
    await expect(provider.searchRecent!('@last_fixture', signal(), () => { throw new Error('display failed'); })).resolves.toBeDefined();
  });

  it('observes the precise web query sent to the search API', async () => {
    const observed = vi.fn();
    const api = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(observed).toHaveBeenLastCalledWith({ provider: 'web', operation: 'web_search', query: body.query });
      return json({ results: [] });
    });
    await providerWith(api).searchRecent!('架空花子 架空会社 公開活動', signal(), observed);
    expect(observed).toHaveBeenCalledOnce();
    expect(JSON.stringify(observed.mock.calls)).not.toContain(config.tavilyApiKey);
  });

  it('returns profile and latest posts with two calls and never starts an archive request', async () => {
    const api = apiMock();
    const base = api.getMockImplementation()!;
    api.mockImplementation((input, init) => new URL(String(input)).pathname.endsWith('/search/all')
      ? new Promise(() => {}) : base(input, init));
    const provider = providerWith(api);
    const result = await provider.searchRecent!('@fixture_person', signal());
    expect(result.value.map(hit => hit.topic)).toEqual(['profile', 'recent_x']);
    expect(api).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('actualUsd');
    const source = await provider.fetchPage(result.value[1]!, signal());
    expect(source.value.xPost).toMatchObject({ id: '100', username: user.username, authorId: user.id });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('enriches with one archive call using the validated public account and excludes recent IDs', async () => {
    const oldRecent = post('100', '2020-01-01T00:00:00.000Z', 100);
    const api = apiMock([oldRecent], [oldRecent, post('200', '2008-01-01T00:00:00.000Z', 10),
      post('201', '2009-01-01T00:00:00.000Z', 50), post('202', '2007-01-01T00:00:00.000Z', 30),
      post('203', '2006-06-01T00:00:00.000Z', 1), post('204', '2006-06-01T00:00:00.000Z', 999, { author_id: '999' })]);
    const provider = providerWith(api);
    const first = await provider.searchRecent!('@fixture_person', signal());
    const archive = await provider.searchArchive!('@FIXTURE_PERSON', signal());
    expect(api).toHaveBeenCalledTimes(3);
    expect(archive.value.map(hit => hit.url.split('/').at(-1))).toEqual(['201', '202', '200']);
    expect(first.value.length + archive.value.length).toBeLessThanOrEqual(10);
    const url = new URL(String(api.mock.calls[2]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'from:fixture_person -is:retweet -is:reply',
      start_time: '2006-03-21T00:00:00Z', end_time: '2026-09-15T00:00:00.000Z', sort_order: 'relevancy',
      max_results: '20', 'tweet.fields': 'created_at,public_metrics,author_id' });
    expect((await provider.fetchPage(archive.value[0]!, signal())).value.xPost?.selectionScope).toBe('full_archive_sample');
  });

  it('keeps an empty timeline fast without any archive recency fallback', async () => {
    const api = apiMock([]); const provider = providerWith(api);
    expect((await provider.searchRecent!('@fixture_person', signal())).value.map(hit => hit.topic)).toEqual(['profile']);
    expect(api).toHaveBeenCalledTimes(2);
    expect((await provider.searchArchive!('@fixture_person', signal())).value).toHaveLength(1);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('filters wrong-author, future, unsafe and malformed recent posts without filling with history', async () => {
    const api = apiMock([post('100'), post('101', undefined, 1, { author_id: '999' }),
      post('102', '2026-09-23T00:00:00.000Z'), post('103', undefined, 1, { text: '病気の治療について。' }),
      post('104', undefined, 1, { created_at: 'invalid' })]);
    const result = await providerWith(api).searchRecent!('@fixture_person', signal());
    expect(result.value.map(hit => hit.url.split('/').at(-1))).toEqual(['fixture_person', '100']);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each([{ ...user, protected: true }, { ...user, username: 'other_person' }, undefined])(
    'does not reuse a rejected or unknown account', async invalid => {
      const api = apiMock(); const base = api.getMockImplementation()!;
      api.mockImplementationOnce(async () => json({ data: invalid }));
      const provider = providerWith(api);
      await expect(provider.searchRecent!('@fixture_person', signal())).rejects.toBeDefined();
      expect(api).toHaveBeenCalledOnce();
      api.mockImplementation(base);
      expect((await provider.searchArchive!('@fixture_person', signal())).value).toHaveLength(1);
      expect(api).toHaveBeenCalledTimes(4);
    });

  it('does not reuse a public lookup when its timeline failed validation', async () => {
    const api = apiMock(); const base = api.getMockImplementation()!;
    api.mockImplementationOnce(async () => json({ data: user })).mockImplementationOnce(async () => json({ errors: [{}] }));
    const provider = providerWith(api);
    await expect(provider.searchRecent!('@fixture_person', signal())).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    api.mockImplementation(base);
    await provider.searchArchive!('@fixture_person', signal());
    expect(api).toHaveBeenCalledTimes(5);
  });

  it('expires the cross-phase identity/recent-ID cache after one minute', async () => {
    vi.useFakeTimers(); const api = apiMock(); const provider = providerWith(api);
    await provider.searchRecent!('@fixture_person', signal());
    await vi.advanceTimersByTimeAsync(60_001);
    await provider.searchArchive!('@fixture_person', signal());
    expect(api).toHaveBeenCalledTimes(5);
  });

  it('bounds the shared identity cache to 32 accounts', async () => {
    const api = apiMock([]); const provider = providerWith(api);
    for (let index = 0; index < 33; index++) await provider.searchRecent!(`@fixture_${index}`, signal());
    expect(api).toHaveBeenCalledTimes(66);
    await provider.searchArchive!('@fixture_0', signal());
    expect(api).toHaveBeenCalledTimes(69);
  });

  it('never turns cancellation into cached successful work', async () => {
    const controller = new AbortController(); const api = apiMock(); const base = api.getMockImplementation()!;
    api.mockImplementationOnce(async () => json({ data: user })).mockImplementationOnce(async () => {
      controller.abort(); return json({ data: [post('100')] });
    });
    const provider = providerWith(api);
    await expect(provider.searchRecent!('@fixture_person', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    api.mockImplementation(base);
    await provider.searchRecent!('@fixture_person', signal());
    expect(api).toHaveBeenCalledTimes(4);
    await expect(provider.searchArchive!('@fixture_person', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(api).toHaveBeenCalledTimes(4);
  });

  it('preserves the quick result when archive fails and does not retry or consume quick evidence', async () => {
    const api = apiMock(); const provider = providerWith(api);
    const first = await provider.searchRecent!('@fixture_person', signal());
    api.mockImplementationOnce(async () => json({}, 429));
    await expect(provider.searchArchive!('@fixture_person', signal())).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await provider.fetchPage(first.value[1]!, signal())).value.xPost?.id).toBe('100');
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('uses ordinary bounded web search for no handle and no-op archive enrichment', async () => {
    const api = apiMock(); const provider = providerWith(api);
    expect((await provider.searchRecent!('架空花子 架空会社', signal())).value).toHaveLength(1);
    expect(await provider.searchArchive!('架空花子 架空会社', signal())).toEqual({ value: [], actualUsd: 0 });
    expect(api).toHaveBeenCalledOnce();
    expect(String(api.mock.calls[0]![0])).toBe('https://api.tavily.com/search');
    await expect(provider.searchRecent!('@one @two', signal())).rejects.toMatchObject({ code: 'AMBIGUOUS_X_ACCOUNT' });
    await expect(provider.searchArchive!(' ', signal())).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(api).toHaveBeenCalledOnce();
  });
});

describe('social assessment facts', () => {
  // Registry-backed account with entirely synthetic source prose; no live biography assertion.
  const target = { personName: '千代田まどか', companyName: 'Microsoft' };
  const identity: EvidenceSource = { sourceId: 'identity-x', kind: 'x', topic: 'profile', url: 'https://x.com/chomado',
    title: '模擬プロフィール', retrievedAt: now.toISOString(), text: '公開プロフィール: 千代田まどか (@chomado)\nMicrosoftの模擬プロフィールです。' };
  const assessment = { identityVerified: true, needsConfirmation: false, candidates: [], cards: [], followUpQuery: null, reason: '一致' };
  const body = '公開イベントで製品設計について登壇しました。';
  function socialSource(platform: 'instagram' | 'facebook', rawBody = body): EvidenceSource {
    return { sourceId: `social-${platform}`, kind: platform, topic: platform, url: platform === 'instagram' ? 'https://www.instagram.com/p/fixture123/' : 'https://www.facebook.com/chomado/posts/123',
      title: '公開投稿', retrievedAt: now.toISOString(), text: `公開プロフィール: Microsoftの千代田まどか\n専用の模擬プロフィール紹介。\n公開投稿: ${rawBody}`,
      socialPost: { platform, authorHandle: 'chomado', profileUrl: `https://www.${platform}.com/chomado`,
        identitySourceUrl: 'https://linktr.ee/chomado', createdAt: '2026-09-21T00:00:00.000Z', text: body } };
  }
  it.each(['instagram', 'facebook'] as const)('offers only the %s post body as fact candidates', async platform => {
    const api = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init!.body)); const data = JSON.parse(request.messages[1].content);
      const facts = data.sources[0].excerpts.flatMap((excerpt: { facts: { factId: string; text: string }[] }) => excerpt.facts);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.every((fact: { text: string }) => fact.text === body)).toBe(true);
      expect(data.sources[0].socialPost).toMatchObject({ platform, publishedAt: '2026-09-21T00:00:00.000Z' });
      return json({ choices: [{ message: { content: JSON.stringify({ ...assessment, cards: [{ factId: facts[0].factId, suggestedQuestion: '登壇で工夫した点は何ですか？' }] }) } }] });
    });
    const result = await providerWith(api).assess(target, [socialSource(platform), identity], signal());
    expect(result.value.cards[0]?.fact).toBe(body);
  });
  it('offers no body facts when trusted body metadata disagrees with the supplied source text', async () => {
    const api = vi.fn<typeof fetch>(async (_input, init) => {
      const data = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
      expect(data.sources[0].excerpts.flatMap((excerpt: { facts: unknown[] }) => excerpt.facts)).toEqual([]);
      return json({ choices: [{ message: { content: JSON.stringify(assessment) } }] });
    });
    await providerWith(api).assess(target, [socialSource('instagram', '別の本文。'), identity], signal());
  });
});

describe('specific historical questions', () => {
  const body = '模擬の製品展示で木製の試作機を披露しました。';
  const target = { personName: '千代田まどか', companyName: 'Microsoft' };
  const source: EvidenceSource = { sourceId: 'historic-fixture', kind: 'x', topic: 'popular_x', url: 'https://x.com/chomado/status/123',
    title: '模擬の過去投稿', retrievedAt: now.toISOString(), text: `公開プロフィール: 千代田まどか (@chomado)\nMicrosoftの模擬プロフィールです。\n公開投稿: ${body}`,
    xPost: { id: '123', authorId: '456', username: 'chomado', createdAt: '2020-01-01T00:00:00.000Z',
      likeCount: 10, repostCount: 1, replyCount: 0, quoteCount: 0, selectionScope: 'full_archive_sample', text: body } };
  async function assessQuestion(suggestedQuestion: string, displayQuestion?: string) {
    const api = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init!.body)); const data = JSON.parse(request.messages[1].content);
      expect(request.messages[0].content).toContain('Ask for an answer the fact does not already give');
      expect(request.messages[0].content).toContain('preserve the same specific focus');
      const fact = data.sources[0].excerpts.flatMap((excerpt: { facts: { factId: string; text: string }[] }) => excerpt.facts)
        .find((fact: { text: string }) => fact.text === body);
      expect(fact).toBeDefined();
      return json({ choices: [{ message: { content: JSON.stringify({ identityVerified: true, needsConfirmation: false,
        candidates: [], followUpQuery: null, reason: '模擬の一致', cards: [{ factId: fact.factId, suggestedQuestion, ...(displayQuestion ? { displayQuestion } : {}) }] }) } }] });
    });
    return (await providerWith(api).assess(target, [source], signal())).value.cards;
  }
  it('adds historical context while preserving the concrete subject instead of injecting a generic question', async () => {
    const [card] = await assessQuestion('試作機を木製にした理由は？', '木製を選んだ理由は何ですか？');
    expect(card?.suggestedQuestion).toBe('当時、試作機を木製にした理由は？');
    expect(card?.displayQuestion).toBe('当時、木製を選んだ理由は何ですか？');
    expect(card?.fact).toBe(body);
  });
  it('preserves a specific historical full question when a short display helper is absent', async () => {
    const question = '当時、木製の試作機を展示するまでにどのような試行錯誤がありましたか？';
    const [card] = await assessQuestion(question);
    expect(card?.suggestedQuestion).toBe(question); expect(card).not.toHaveProperty('displayQuestion');
  });
  it('omits a short helper that cannot fit the qualifier, leaving the full question available', async () => {
    const short = '木製の試作機を展示する際に一番工夫した点は何ですか？';
    expect(short.length).toBeLessThanOrEqual(26);
    const [card] = await assessQuestion('当時、木製の試作機で最も工夫したことは？', short);
    expect(card?.suggestedQuestion).toContain('木製の試作機'); expect(card).not.toHaveProperty('displayQuestion');
  });
  it.each(['本当にご自身で作ったんですか？', 'その活動で工夫した点は何ですか？', 'すごいですね、成功の秘訣は？',
    '最近の投稿で紹介した内容、どのように活用してほしいと思っていますか？',
    '過去の投稿で特に印象に残った反応はありましたか？',
    '取締役COOとしての役割で、特に大切にしていることは何ですか？'])(
    'omits an unsuitable full question without inventing a fallback: %s', async question => {
      expect(await assessQuestion(question)).toEqual([]);
    });
  it.each(['本当にご自身で作ったんですか？', '投稿のきっかけは？', 'どうでしたか？', 'その話題、特に興味深かった点は何ですか？', '木製を選んだ理由は？'])(
    'discards only a bad display helper and preserves the respectful specific full question: %s', async short => {
      const question = '当時、木製の試作機で特に工夫したところは何ですか？';
      const [card] = await assessQuestion(question, short);
      expect(card?.suggestedQuestion).toBe(question);
      expect(card?.fact).toBe(body);
      expect(card).not.toHaveProperty('displayQuestion');
    });
  it('keeps a specific and respectful full/short pair intact', async () => {
    const question = '当時、木製の試作機で特に工夫したところは何ですか？';
    const short = '当時、木製の試作機の工夫は何ですか？';
    const [card] = await assessQuestion(question, short);
    expect(card).toMatchObject({ suggestedQuestion: question, displayQuestion: short, fact: body });
  });
});
