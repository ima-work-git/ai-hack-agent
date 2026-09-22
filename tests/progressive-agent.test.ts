import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../server/agent.ts';
import { BudgetLedger } from '../server/budget.ts';
import { ProviderError, type ProviderResult, type ResearchProvider } from '../server/provider-contract.ts';
import type { SocialProvider } from '../server/social-provider.ts';
import type { Assessment, EvidenceSource, ResearchInput, ResearchResult, SearchHit } from '../src/shared/contracts.ts';
import { verifiedSocialIdentityForTarget } from '../src/shared/social-accounts.ts';

// Public registry identity is required to exercise its account-link guard. All
// source prose below is deliberately synthetic; it asserts no real biography.
const target = { personName: '千代田まどか', companyName: 'Microsoft' };
const input: ResearchInput = { requestId: 'progressive-fixture-001', subjectRevision: 1, mode: 'live', scenario: 'normal', text: 'Microsoftのちょまどさん @chomado' };
const retrievedAt = '2026-09-22T00:00:00.000Z';
const header = '公開プロフィール: 千代田まどか (@chomado)\nMicrosoftの模擬プロフィールです。';
const facts = {
  profile: '模擬の技術イベントを企画しました。', recent1: '模擬の新製品を紹介しました。', recent2: '模擬の設計講座で発表しました。',
  archive: '模擬の過去の展示会に参加しました。', instagram: '模擬の工作イベントに参加しました。', facebook: '模擬の技術交流会を開催しました。',
};
function xSource(id: 'profile' | 'recent1' | 'recent2' | 'archive'): EvidenceSource {
  const numeric = { recent1: '101', recent2: '102', archive: '201' };
  const profile = id === 'profile';
  return { sourceId: id, kind: 'x', topic: profile ? 'profile' : id === 'archive' ? 'popular_x' : 'recent_x',
    url: `https://x.com/chomado${profile ? '' : `/status/${numeric[id]}`}`, title: '架空の試験資料', retrievedAt,
    text: profile ? `${header}\n${facts[id]}` : `${header}\n公開投稿: ${facts[id]}`,
    ...(profile ? {} : { xPost: { id: numeric[id], authorId: '123', username: 'chomado', createdAt: id === 'archive' ? '2020-01-01T00:00:00.000Z' : '2026-09-21T00:00:00.000Z',
      likeCount: 1, repostCount: 1, replyCount: 0, quoteCount: 0, text: facts[id], ...(id === 'archive' ? { selectionScope: 'full_archive_sample' as const } : {}) } }) };
}
function socialSource(platform: 'instagram' | 'facebook'): EvidenceSource {
  const account = verifiedSocialIdentityForTarget(target)!.accounts.find(account => account.platform === platform)!;
  return { sourceId: platform, kind: platform, topic: platform, retrievedAt,
    url: platform === 'instagram' ? 'https://www.instagram.com/p/fixture123/' : 'https://www.facebook.com/chomado/posts/123',
    title: '架空の追加資料', text: `${header}\n公開投稿: ${facts[platform]}`,
    socialPost: { platform, authorHandle: account.handle, profileUrl: account.profileUrl, identitySourceUrl: account.identitySourceUrl,
      createdAt: platform === 'instagram' ? '2026-09-21T12:00:00.000Z' : '2026-09-21T00:00:00.000Z', text: facts[platform] } };
}
const hit = (source: EvidenceSource): SearchHit => ({ url: source.url, title: source.title, topic: source.topic });
const result = <T>(value: T): ProviderResult<T> => ({ value, actualUsd: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function withAbort<T>(promise: Promise<T>, signal: AbortSignal, ignoreAbort: boolean): Promise<T> {
  if (ignoreAbort) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProviderError('CANCELLED', '模擬の中止'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function assessment(sources: EvidenceSource[]): Assessment {
  // Select newly arrived social sources as explicit candidates so this test
  // measures progressive delivery, not the model's subjective topic ranking.
  const selectedSocial = sources.filter(source => source.socialPost).sort((left, right) =>
    right.socialPost!.createdAt.localeCompare(left.socialPost!.createdAt)).slice(0, 1);
  const ranked = [...selectedSocial, ...sources.filter(source => !source.socialPost && source.topic !== 'profile'),
    ...sources.filter(source => source.topic === 'profile')];
  return { identityVerified: true, needsConfirmation: false, candidates: [], followUpQuery: null, reason: '模擬の本人照合',
    cards: ranked.slice(0, 4).map(source => ({ sourceId: source.sourceId, fact: facts[source.sourceId as keyof typeof facts],
      excerpt: source.text, suggestedQuestion: 'その活動で工夫した点は何ですか？' })) };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

async function fixture({ ignoreAbort = false, socialEnabled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'progressive-agent-'));
  const budget = new BudgetLedger({ directory, currency: 'USD', runLimitUsd: 10, dayLimitUsd: 20, eventLimitUsd: 30 });
  const budgetWork = new Set<Promise<unknown>>();
  const trackBudget = <T>(work: Promise<T>): Promise<T> => {
    const tracked = work.finally(() => budgetWork.delete(tracked));
    budgetWork.add(tracked);
    return tracked;
  };
  const realReserve = budget.reserve.bind(budget);
  const realSettle = budget.settle.bind(budget);
  const realSnapshot = budget.snapshot.bind(budget);
  const reserve = vi.spyOn(budget, 'reserve').mockImplementation((...args) => trackBudget(realReserve(...args)));
  vi.spyOn(budget, 'settle').mockImplementation((...args) => trackBudget(realSettle(...args)));
  vi.spyOn(budget, 'snapshot').mockImplementation((...args) => trackBudget(realSnapshot(...args)));
  cleanups.push(async () => {
    // Cancellation returns before accounting has necessarily finished. An
    // event-loop checkpoint drains promise continuations that can start a
    // settlement after the final result; then await all actual ledger I/O.
    // Repeat because a completed reservation can schedule its own settlement.
    do {
      await Promise.allSettled([...budgetWork]);
      await new Promise<void>(resolve => setImmediate(resolve));
    } while (budgetWork.size);
    await rm(directory, { recursive: true, force: true });
  });
  const archive = deferred<ProviderResult<SearchHit[]>>();
  const instagram = deferred<ProviderResult<EvidenceSource[]>>();
  const facebook = deferred<ProviderResult<EvidenceSource[]>>();
  const sources = [xSource('profile'), xSource('recent1'), xSource('recent2'), xSource('archive')];
  const provider: ResearchProvider = {
    mode: 'live',
    plan: vi.fn(async () => result({ target, needsConfirmation: false, candidates: [], query: '公式 プロフィール @chomado', reason: '模擬の計画' })),
    searchRecent: vi.fn(async () => result(sources.slice(0, 3).map(hit))),
    search: vi.fn(async () => result([])),
    searchArchive: vi.fn((_query, signal) => withAbort(archive.promise, signal, ignoreAbort)),
    fetchPage: vi.fn(async candidate => result(sources.find(source => source.url === candidate.url)!)),
    assess: vi.fn(async (_target, evidence) => result(assessment(evidence))),
  };
  const social: SocialProvider = {
    hasTarget: vi.fn(() => socialEnabled),
    lookupPlatform: vi.fn((_target, platform, signal) => withAbort((platform === 'instagram' ? instagram : facebook).promise, signal, ignoreAbort)),
    lookup: vi.fn(async () => result([])),
  };
  const snapshots: ResearchResult[] = [];
  const controller = new AbortController();
  const budgetRunId = randomUUID();
  const onSnapshot = vi.fn((snapshot: ResearchResult) => snapshots.push(snapshot));
  const start = () => runAgent(input, provider, { budget, budgetRunId, maximumCosts: { llm: 0.01, search: 0.02, page: 0.001 },
    signal: controller.signal, onSnapshot, social });
  return { budget, budgetRunId, reserve, archive, instagram, facebook, provider, social, snapshots, controller, onSnapshot, start, sources };
}

describe('progressive evidence orchestration', () => {
  it('labels actual quick, archive and social requests while keeping their observers isolated', async () => {
    const test = await fixture();
    const recent = test.provider.searchRecent!.bind(test.provider);
    test.provider.searchRecent = async (query, signal, observe) => {
      observe?.({ provider: 'x', operation: 'recent_posts', query: '@chomado' });
      return recent(query, signal);
    };
    const archive = test.provider.searchArchive!.bind(test.provider);
    test.provider.searchArchive = async (query, signal, observe) => {
      observe?.({ provider: 'x', operation: 'archive_search', query: 'from:chomado -is:retweet -is:reply' });
      return archive(query, signal);
    };
    const social = test.social.lookupPlatform.bind(test.social);
    test.social.lookupPlatform = async (subject, platform, signal, observe) => {
      observe?.({ provider: platform, operation: 'social_posts', query: `https://www.${platform}.com/chomado` });
      return social(subject, platform, signal);
    };
    const pending = test.start();
    await vi.waitFor(() => expect(test.snapshots).toHaveLength(1));
    expect(test.snapshots[0]!.trace.flatMap(event => event.search ? [event.search] : []))
      .toEqual([{ provider: 'x', operation: 'recent_posts', stage: 'initial', query: '@chomado' }]);
    test.archive.resolve(result([])); test.instagram.resolve(result([])); test.facebook.resolve(result([]));
    const final = await pending;
    const searches = final.trace.flatMap(event => event.search ? [event.search] : []);
    expect(searches).toHaveLength(4);
    // Independent budget reservations need not finish in platform order.
    expect(searches).toEqual(expect.arrayContaining([
      { provider: 'x', operation: 'recent_posts', stage: 'initial', query: '@chomado' },
      { provider: 'x', operation: 'archive_search', stage: 'archive', query: 'from:chomado -is:retweet -is:reply' },
      { provider: 'facebook', operation: 'social_posts', stage: 'social', query: 'https://www.facebook.com/chomado' },
      { provider: 'instagram', operation: 'social_posts', stage: 'social', query: 'https://www.instagram.com/chomado' },
    ]));
  });

  it('publishes QUICK while slow providers are unresolved, then updates independently for each arrival', async () => {
    const test = await fixture(); let completed = false;
    const pending = test.start().then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(test.social.lookupPlatform).toHaveBeenCalledTimes(2));
    expect(completed).toBe(false);
    expect(test.snapshots).toHaveLength(1);
    expect(test.snapshots[0]).toMatchObject({ reasonCode: 'PROGRESSIVE_QUICK', status: 'partial' });
    expect(test.snapshots[0]!.cards.map(card => card.sourceId)).toEqual(['recent1', 'recent2', 'profile']);
    const first = structuredClone(test.snapshots[0]);

    test.archive.resolve(result([hit(xSource('archive'))]));
    await vi.waitFor(() => expect(test.snapshots).toHaveLength(2));
    expect(test.snapshots[1]!.cards.some(card => card.sourceId === 'archive')).toBe(true);
    expect(completed).toBe(false);

    test.facebook.resolve({ value: [socialSource('facebook')] });
    await vi.waitFor(() => expect(test.snapshots).toHaveLength(3));
    expect(test.snapshots[2]!.cards.some(card => card.sourceId === 'facebook')).toBe(true);
    expect(completed).toBe(false);

    test.instagram.resolve({ value: [socialSource('instagram')] });
    const final = await pending;
    expect(test.snapshots).toHaveLength(4);
    expect(final.cards.map(card => card.sourceId)).toContain('instagram');
    expect(final.cards.filter(card => card.topic === 'instagram' || card.topic === 'facebook')).toHaveLength(1);
    expect(test.snapshots[0]).toEqual(first);
    expect(final.cards).toHaveLength(4);
    expect(final.sources.length).toBeLessThanOrEqual(6);
    expect(final.usage.llm).toBeLessThanOrEqual(6);
    expect(final.usage.searches).toBeLessThanOrEqual(5);
    expect(final.usage.pages).toBeLessThanOrEqual(9);
    expect(test.provider.searchRecent).toHaveBeenCalledOnce();
    expect(test.provider.searchArchive).toHaveBeenCalledOnce();
    expect(test.social.lookup).not.toHaveBeenCalled();
    expect(test.reserve.mock.calls.filter(([, cost]) => cost === 0.10)).toHaveLength(2);
    expect((await test.budget.snapshot(test.budgetRunId)).reservedUsd).toBeCloseTo(0.20);
    expect(final.usage.costKnown).toBe(false);
  });

  it('delivers quick evidence before an optional slow web search when the first assessment verifies identity', async () => {
    const test = await fixture({ socialEnabled: false });
    const web = deferred<ProviderResult<SearchHit[]>>();
    test.provider.search = vi.fn((_query, signal) => withAbort(web.promise, signal, false));
    const pending = test.start();
    try {
      await vi.waitFor(() => expect(test.snapshots[0]?.reasonCode).toBe('PROGRESSIVE_QUICK'), { timeout: 800 });
    } finally {
      test.controller.abort(); web.resolve(result([])); test.archive.resolve(result([]));
      await pending;
    }
  });

  it('does not wait for archive to finish before a completed social platform is displayed', async () => {
    const test = await fixture(); const pending = test.start();
    await vi.waitFor(() => expect(test.social.lookupPlatform).toHaveBeenCalledTimes(2));
    test.instagram.resolve(result([socialSource('instagram')]));
    await vi.waitFor(() => expect(test.snapshots).toHaveLength(2));
    expect(test.snapshots[1]!.cards.some(card => card.sourceId === 'instagram')).toBe(true);
    test.archive.resolve(result([])); test.facebook.resolve(result([]));
    expect((await pending).cards.some(card => card.sourceId === 'instagram')).toBe(true);
  });

  it('cancels promptly and ignores all late provider successes', async () => {
    const test = await fixture({ ignoreAbort: true }); const pending = test.start();
    await vi.waitFor(() => expect(test.social.lookupPlatform).toHaveBeenCalledTimes(2));
    expect(test.snapshots).toHaveLength(1);
    test.controller.abort();
    const final = await pending;
    expect(final.status).toBe('cancelled');
    expect(final.cards).toEqual([]); expect(final.sources).toEqual([]);
    test.archive.resolve(result([hit(xSource('archive'))]));
    test.instagram.resolve(result([socialSource('instagram')])); test.facebook.resolve(result([socialSource('facebook')]));
    await vi.waitFor(async () => expect((await test.budget.snapshot(test.budgetRunId)).reservedUsd).toBeLessThan(0.01));
    expect(test.snapshots).toHaveLength(1);
    expect(test.provider.assess).toHaveBeenCalledOnce();
  });

  it('retains initial verified cards when later provider calls fail', async () => {
    const test = await fixture(); const pending = test.start();
    await vi.waitFor(() => expect(test.social.lookupPlatform).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(test.provider.searchArchive).toHaveBeenCalledOnce());
    const firstCards = structuredClone(test.snapshots[0]!.cards);
    test.archive.reject(new ProviderError('PROVIDER_TIMEOUT', '模擬タイムアウト'));
    test.instagram.reject(new ProviderError('SOCIAL_UNAVAILABLE', '模擬障害'));
    test.facebook.reject(new ProviderError('SOCIAL_UNAVAILABLE', '模擬障害'));
    const final = await pending;
    expect(final.status).toBe('partial');
    expect(final.cards).toEqual(firstCards);
    expect(test.snapshots).toHaveLength(1);
    expect(final.trace.some(event => event.step === 'recovery')).toBe(true);
    expect(final.usage.reservedUsd).toBeGreaterThanOrEqual(0.20);
  });

  it('retains initial verified cards when an enrichment assessment fails', async () => {
    const test = await fixture(); const pending = test.start();
    await vi.waitFor(() => expect(test.social.lookupPlatform).toHaveBeenCalledTimes(2));
    const firstCards = structuredClone(test.snapshots[0]!.cards);
    test.provider.assess = vi.fn(async () => { throw new ProviderError('PROVIDER_TIMEOUT', '模擬の評価障害'); });
    test.archive.resolve(result([hit(xSource('archive'))])); test.instagram.resolve(result([])); test.facebook.resolve(result([]));
    const final = await pending;
    expect(final.cards).toEqual(firstCards);
    expect(test.snapshots).toHaveLength(1);
  });

  it.each([true, false])('clears published cards before unresolved provider cleanup when identity fails (needsConfirmation=%s)', async needsConfirmation => {
    const test = await fixture({ ignoreAbort: true }); let completed = false;
    const pending = test.start().then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(test.social.lookupPlatform).toHaveBeenCalledTimes(2));
    expect(test.snapshots[0]!.cards.length).toBeGreaterThan(0);
    test.provider.assess = vi.fn(async () => result({ identityVerified: false, needsConfirmation, candidates: [], cards: [], followUpQuery: null, reason: '模擬の別人候補' }));
    test.archive.resolve(result([hit(xSource('archive'))]));
    await vi.waitFor(() => expect(test.snapshots).toHaveLength(2));
    expect(completed).toBe(false); // Both social requests still await controlled responses.
    expect(test.snapshots[1]).toMatchObject({ status: 'awaiting_confirmation', reasonCode: 'IDENTITY_CONFIRMATION_REQUIRED', cards: [] });
    test.instagram.resolve(result([socialSource('instagram')])); test.facebook.resolve(result([socialSource('facebook')]));
    const final = await pending;
    expect(final.status).toBe('awaiting_confirmation');
    expect(final.cards).toEqual([]);
    expect(test.snapshots).toHaveLength(2);
    expect(test.provider.assess).toHaveBeenCalledOnce(); // Late social successes cannot restore the invalidated identity.
  });

  it('rejects social facts for a different account and rejects profile labels proposed as post facts', async () => {
    const test = await fixture(); const pending = test.start();
    await vi.waitFor(() => expect(test.social.lookupPlatform).toHaveBeenCalledTimes(2));
    const forged = socialSource('instagram'); forged.socialPost!.authorHandle = 'other_fixture';
    const mislabeled = socialSource('facebook');
    test.provider.assess = vi.fn(async (_target, sources) => result({ ...assessment(sources), cards: [
      { sourceId: forged.sourceId, fact: facts.instagram, excerpt: forged.text, suggestedQuestion: '工夫した点は何ですか？' },
      { sourceId: mislabeled.sourceId, fact: 'Microsoftの模擬プロフィールです。', excerpt: mislabeled.text, suggestedQuestion: '工夫した点は何ですか？' },
    ] }));
    test.archive.resolve(result([])); test.instagram.resolve(result([forged])); test.facebook.resolve(result([mislabeled]));
    const final = await pending;
    expect(final.cards.every(card => ['profile', 'recent1', 'recent2'].includes(card.sourceId))).toBe(true);
    expect(final.trace.some(event => event.step === 'discard')).toBe(true);
    expect(test.snapshots).toHaveLength(1);
  });

  it('does not contact social providers for an unsupported target', async () => {
    const test = await fixture({ socialEnabled: false }); test.archive.resolve(result([]));
    const final = await test.start();
    expect(final.cards.length).toBeGreaterThan(0);
    expect(test.social.lookupPlatform).not.toHaveBeenCalled();
    expect(test.reserve.mock.calls.some(([, cost]) => cost === 0.10)).toBe(false);
  });
});
