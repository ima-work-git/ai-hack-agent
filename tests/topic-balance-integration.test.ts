import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../server/agent.ts';
import { createLiveProvider } from '../server/providers.ts';
import type { ResearchProvider } from '../server/provider-contract.ts';
import type { Assessment, EvidenceSource, ResearchInput, SearchHit } from '../src/shared/contracts.ts';

// Entirely synthetic claims using a curated account mapping; no network or real biography assertion.
const target = { personName: '千代田まどか', companyName: 'Microsoft' };
const stamp = '2026-09-22T00:00:00Z';
const copiedBio = 'コピーされた模擬プロフィールの活動です。';
const header = `公開プロフィール: 千代田まどか (@chomado)\n${copiedBio}`;
const officialUrls = ['https://chomado.com/', 'https://chomado.com/chomado/'];
const input: ResearchInput = { text: 'Microsoftのちょまどさんについて', requestId: 'topic-balance-integration', subjectRevision: 1, mode: 'demo', scenario: 'normal' };
const officialFact = '千代田まどかは Microsoft の技術情報を紹介する模擬の公開プロフィールです。';
const facts = ['模擬の開発勉強会で新しいツールを紹介しました。', '模擬の公開イベントでプログラミングを実演しました。', '過去の模擬イベントで開発の工夫を紹介しました。'];
function sources(relation = true): EvidenceSource[] {
  const profile: EvidenceSource = { sourceId: 'x-profile', url: 'https://x.com/chomado', title: '模擬プロフィール', retrievedAt: stamp, text: header, kind: 'x', topic: 'profile' };
  const posts: EvidenceSource[] = facts.map((text, index) => ({
    sourceId: `post-${index + 1}`, url: `https://x.com/chomado/status/${101 + index}`, title: '模擬投稿', retrievedAt: stamp,
    text: `${header}\n公開投稿: ${text}`, kind: 'x', topic: index === 2 ? 'popular_x' : 'recent_x',
    xPost: { id: String(101 + index), authorId: '500', username: 'chomado', createdAt: index === 2 ? '2021-04-01T00:00:00Z' : stamp,
      likeCount: index === 2 ? 100 : 10, repostCount: 3, replyCount: 2, quoteCount: 1, text,
      ...(index === 2 ? { selectionScope: 'full_archive_sample' } : {}),
    },
  }));
  const web: EvidenceSource[] = officialUrls.map((url, index) => ({ sourceId: `web-${index + 1}`, url, title: '模擬の公式Web資料', retrievedAt: stamp, kind: 'web',
    text: relation ? index === 0 ? officialFact : 'Microsoft と千代田まどかの関係を説明する二つ目の模擬資料です。' : '別の人物と別の会社についての模擬資料です。',
  }));
  return [profile, ...posts, ...web];
}
function proposed(source: EvidenceSource, fact: string) {
  return { fact, sourceId: source.sourceId, excerpt: source.text, suggestedQuestion: 'その活動で印象に残ったことは？' };
}
function fixture(options: { relation?: boolean; identityVerified?: boolean; copiedHeaderFact?: boolean } = {}) {
  const all = sources(options.relation ?? true); const order: string[] = []; let searches = 0;
  const cards = [proposed(all[4]!, options.relation === false ? all[4]!.text : officialFact), proposed(all[3]!, facts[2]!), proposed(all[2]!, options.copiedHeaderFact ? copiedBio : facts[1]!), proposed(all[1]!, facts[0]!)];
  const provider: ResearchProvider = {
    mode: 'demo',
    plan: vi.fn(async () => ({ value: { target, needsConfirmation: false, candidates: [], query: '公式 プロフィール', reason: '模擬入力から抽出' }, actualUsd: 0 })),
    search: vi.fn(async () => {
      order.push(`search-${++searches}`);
      const hits: SearchHit[] = searches === 1 ? all.slice(0, 4).map(({ url, title, topic }) => ({ url, title, topic })) : [{ url: 'https://secondary.example.org/profile', title: '追加Web候補' }];
      return { value: hits, actualUsd: 0 };
    }),
    fetchPage: vi.fn(async hit => {
      const source = all.find(source => source.url === hit.url);
      if (!source) throw new Error('Unexpected mocked source');
      order.push(source.sourceId); return { value: source, actualUsd: 0 };
    }),
    assess: vi.fn<ResearchProvider['assess']>(async (_target, evidence) => {
      order.push('assess'); expect(evidence.map(source => source.sourceId)).toEqual(all.map(source => source.sourceId));
      return { value: { identityVerified: options.identityVerified ?? true, needsConfirmation: false, candidates: [], cards, followUpQuery: null, reason: '模擬の検証結果' }, actualUsd: 0 };
    }),
  };
  return { provider, all, order };
}

describe('balanced topics through the complete agent', () => {
  it('gathers four initial X sources, follows official Web evidence once and orders two recent, one popular, one profile', async () => {
    const f = fixture(); const result = await runAgent(input, f.provider);
    expect(result.status).toBe('ready'); expect(result.sources).toHaveLength(6);
    expect(result.cards.map(card => card.topic)).toEqual(['recent_x', 'recent_x', 'popular_x', 'profile']);
    expect(result.cards.map(card => card.sourceId)).toEqual(['post-2', 'post-1', 'post-3', 'web-1']);
    expect(f.order).toEqual(['search-1', 'x-profile', 'post-1', 'post-2', 'post-3', 'search-2', 'web-1', 'web-2', 'assess']);
    expect(f.provider.search).toHaveBeenNthCalledWith(1, expect.stringContaining('@chomado'), expect.any(AbortSignal));
    expect(vi.mocked(f.provider.search).mock.calls[1]![0]).not.toContain('@');
    expect(result.usage).toMatchObject({ searches: 2, pages: 6, llm: 2 });
    expect(result.usage.llm).toBeLessThanOrEqual(3); expect(f.provider.assess).toHaveBeenCalledOnce();
    for (const card of result.cards) {
      const source = result.sources.find(source => source.sourceId === card.sourceId)!;
      expect(source.text).toContain(card.excerpt); expect(card.excerpt).toContain(card.fact);
      if (source.xPost) expect(source.xPost.text).toContain(card.fact);
    }
  });

  it('rejects copied profile facts from a post even when the identity and separate company evidence are valid', async () => {
    const result = await runAgent(input, fixture({ copiedHeaderFact: true }).provider);
    expect(result.cards).toHaveLength(3);
    expect(result.cards.some(card => card.fact === copiedBio)).toBe(false);
    expect(result.cards.map(card => card.sourceId)).not.toContain('post-2');
    expect(result.status).toBe('partial'); expect(result.reasonCode).toBe('TOPIC_BALANCE_PARTIAL');
  });

  it('requires actual person/company Web text before accepting company-bound account posts', async () => {
    const result = await runAgent(input, fixture({ relation: false }).provider);
    expect(result.sources).toHaveLength(6); expect(result.sources.filter(source => source.kind === 'web')).toHaveLength(2);
    expect(result.cards).toEqual([]); expect(result.status).not.toBe('ready');
  });

  it('does not turn source classification or a known account into identity verification', async () => {
    const result = await runAgent(input, fixture({ identityVerified: false }).provider);
    expect(result.sources).toHaveLength(6); expect(result.cards).toEqual([]); expect(result.status).not.toBe('ready');
    expect(result.trace.some(event => event.message.includes('本人性'))).toBe(true);
  });
});

interface SentSource {
  sourceId: string; topic?: string; cardEligible: boolean; text: string;
  post?: { publishedAt: string; selectionScope?: string };
  excerpts: { excerptId: string; text: string; facts: { factId: string; text: string }[] }[];
}
const assessment = (cards: unknown[]): Omit<Assessment, 'cards'> & { cards: unknown[] } => ({ identityVerified: true, needsConfirmation: false, candidates: [], cards, followUpQuery: null, reason: '模擬評価' });
const completion = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });

describe('OrcaRouter balanced assessment candidate boundaries', () => {
  it('offers only actual post sentences, includes all six sources and maps selected IDs to exact unedited excerpts', async () => {
    const all = sources(); let sent: SentSource[] = [];
    const api = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.orcarouter.ai/v1/chat/completions');
      const body = JSON.parse(String(init?.body)); const payload = JSON.parse(body.messages[1].content) as { sources: SentSource[] };
      sent = payload.sources; expect(sent).toHaveLength(6);
      expect(body.messages[0].content).toContain('TWO recent_x');
      expect(body.messages[0].content).toContain('ONE popular_x');
      expect(body.messages[0].content).toContain('ONE profile');
      expect(body.messages[0].content).toContain('NOT the most popular post in history');
      const selections = ['post-2', 'post-1', 'post-3', 'web-1'].map(id => {
        const entry = sent.find(source => source.sourceId === id)!; const original = all.find(source => source.sourceId === id)!;
        expect(entry.cardEligible).toBe(true);
        for (const excerpt of entry.excerpts) {
          expect(original.text).toContain(excerpt.text);
          for (const fact of excerpt.facts) {
            expect(excerpt.text).toContain(fact.text);
            if (original.xPost) { expect(original.xPost.text).toContain(fact.text); expect(fact.text).not.toContain(copiedBio); }
          }
        }
        const expected = original.xPost?.text ?? officialFact;
        const fact = entry.excerpts.flatMap(excerpt => excerpt.facts).find(fact => fact.text === expected)!;
        expect(fact).toBeDefined();
        return { factId: fact.factId, suggestedQuestion: 'その活動で印象に残ったことは？' };
      });
      expect(sent.find(source => source.sourceId === 'post-3')).toMatchObject({ topic: 'popular_x', post: { selectionScope: 'full_archive_sample', publishedAt: '2021-04-01T00:00:00Z' } });
      return completion(assessment(selections));
    });
    const provider = createLiveProvider({ orcaApiKey: 'fixture-only', orcaModel: 'fixture-model', tavilyApiKey: 'fixture-only' }, { fetch: api });
    const result = await provider.assess(target, all, new AbortController().signal);
    expect(api).toHaveBeenCalledOnce(); expect(result.value.cards).toHaveLength(4);
    expect(result.value.cards.find(card => card.sourceId === 'post-3')?.suggestedQuestion).toBe('2021年、投稿のきっかけは？');
    for (const card of result.value.cards) {
      const original = all.find(source => source.sourceId === card.sourceId)!;
      expect(original.text).toContain(card.excerpt); expect(card.excerpt).toContain(card.fact);
      expect(card.fact).toBe(original.xPost?.text ?? officialFact);
      expect(card).not.toHaveProperty('factId');
    }
  });

  it('offers a complete short quoted post instead of an unclosed quote fragment', async () => {
    const all = sources(); const source = all[3]!;
    const raw = '先日の会話。友人「この展示が好きです。」私は「また行きたい。」と話しました。';
    source.text = `${source.text.slice(0, source.text.indexOf('\n公開投稿: '))}\n公開投稿: ${raw}`;
    source.xPost = { ...source.xPost!, text: raw };
    const api = vi.fn<typeof fetch>(async (_url, init) => {
      const sent = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).sources as SentSource[];
      const facts = sent.find(entry => entry.sourceId === source.sourceId)!.excerpts.flatMap(excerpt => excerpt.facts);
      expect(facts.some(fact => fact.text === raw)).toBe(true);
      for (const fact of facts) expect((fact.text.match(/「/g) ?? []).length).toBe((fact.text.match(/」/g) ?? []).length);
      return completion(assessment([]));
    });
    await createLiveProvider({ orcaApiKey: 'fixture', orcaModel: 'fixture', tavilyApiKey: 'fixture' }, { fetch: api }).assess(target, all, new AbortController().signal);
    expect(api).toHaveBeenCalledOnce();
  });

  it('does not offer copied headers when raw post metadata and the actual source body disagree', async () => {
    const all = sources(); all[1] = { ...all[1]!, xPost: { ...all[1]!.xPost!, text: '本文と一致しない投稿メタデータです。' } };
    const api = vi.fn<typeof fetch>(async (_url, init) => {
      const sent = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).sources as SentSource[];
      const post = sent.find(source => source.sourceId === 'post-1')!;
      expect(post.excerpts.flatMap(excerpt => excerpt.facts)).toEqual([]);
      return completion(assessment([{ factId: 'made-up-post-header-id', suggestedQuestion: '活動について教えてください。' }]));
    });
    const provider = createLiveProvider({ orcaApiKey: 'fixture-only', orcaModel: 'fixture-model', tavilyApiKey: 'fixture-only' }, { fetch: api });
    expect((await provider.assess(target, all, new AbortController().signal)).value.cards).toEqual([]);
    expect(api).toHaveBeenCalledOnce();
  });
});
