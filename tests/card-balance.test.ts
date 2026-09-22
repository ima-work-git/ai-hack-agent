import { describe, expect, it } from 'vitest';
import { CardSchema, EvidenceSourceSchema, ProposedCardSchema, ResearchResultSchema, SearchHitSchema, type Card, type CardTopic, type EvidenceSource, type XPost } from '../src/shared/contracts.ts';
import { evidenceMatchesCard, selectBalancedCards } from '../src/shared/card-balance.ts';

const stamp = '2026-09-22T00:00:00Z';
const post = (id = '100'): XPost => ({ id, authorId: '500', username: 'chomado', createdAt: stamp, likeCount: 20, repostCount: 3, replyCount: 2, quoteCount: 1, text: `公開イベントの話題 ${id}` });
const source = (id: string, topic?: CardTopic, postId?: string): EvidenceSource => ({
  sourceId: id, url: postId ? `https://x.com/chomado/status/${postId}` : `https://example.org/${id}`, title: id, retrievedAt: stamp,
  kind: postId ? 'x' : 'web', text: '公開資料本文', ...(topic ? { topic } : {}), ...(postId ? { xPost: post(postId) } : {}),
});
const card = (id: string, fact = `事実 ${id}`, topic?: CardTopic): Card => ({ sourceId: id, fact, excerpt: fact, suggestedQuestion: '詳しく教えていただけますか？', cardId: id, expiresAt: stamp, requestId: 'fixture-request', subjectRevision: 1, ...(topic ? { topic } : {}) });

describe('source-based four-card balance', () => {
  it('selects two distinct recent posts, one popular post and one profile despite candidate order', () => {
    const sources = [source('profile'), source('popular', 'popular_x', '30'), source('recent3', 'recent_x', '13'), source('recent1', 'recent_x', '11'), source('recent2', 'recent_x', '12')];
    const result = selectBalancedCards(sources.map(item => card(item.sourceId)), sources);
    expect(result.map(item => item.sourceId)).toEqual(['recent3', 'recent1', 'popular', 'profile']);
    expect(result.map(item => item.topic)).toEqual(['recent_x', 'recent_x', 'popular_x', 'profile']);
  });

  it('balances a larger proposed pool before the public four-card limit while preserving proposal fields', () => {
    const sources = [source('profile'), source('profile2'), source('r1', 'recent_x', '11'), source('p', 'popular_x', '30'), source('r2', 'recent_x', '12'), source('profile3')];
    const proposals = sources.map(item => ({ sourceId: item.sourceId, fact: `事実 ${item.sourceId}`,
      excerpt: `出典にある事実 ${item.sourceId}`, suggestedQuestion: `${item.sourceId} の経験は？`,
      displayFact: `短い事実 ${item.sourceId}`, displayQuestion: 'どのような経験でしたか？', provenance: { verified: true } }));
    const result = selectBalancedCards(proposals, sources);
    expect(result.map(item => item.sourceId)).toEqual(['r1', 'r2', 'p', 'profile']);
    for (const selected of result) {
      const original = proposals.find(item => item.sourceId === selected.sourceId)!;
      expect(selected).toEqual({ ...original, topic: sources.find(item => item.sourceId === selected.sourceId)!.topic ?? 'profile' });
      expect(selected.provenance).toBe(original.provenance);
      expect(selected.displayQuestion).toBe('どのような経験でしたか？');
    }
    expect(proposals.every(item => !('topic' in item))).toBe(true);
  });

  it('rejects duplicate facts and duplicate posts even across sources and categories', () => {
    const sources = [source('r1', 'recent_x', '11'), source('r1-copy', 'recent_x', '11'), source('r2', 'recent_x', '12'), source('p-copy', 'popular_x', '11'), source('p', 'popular_x', '30'), source('profile')];
    const cards = [card('r1', '同じ 事実'), card('r1-copy'), card('r2', '同じ事実'), card('p-copy'), card('p'), card('profile')];
    const result = selectBalancedCards(cards, sources);
    expect(result.map(item => item.sourceId)).toEqual(['r1', 'p', 'profile']);
    expect(result).toHaveLength(3);
  });

  it('fills missing classes only with actual verified cards and retains their real source labels', () => {
    const sources = [source('a'), source('b'), source('c'), source('d'), source('e')];
    const originals = sources.map(item => card(item.sourceId, `事実 ${item.sourceId}`, 'popular_x'));
    const selected = selectBalancedCards([...originals, card('missing-source')], sources);
    expect(selected).toHaveLength(4); expect(selected.every(item => item.topic === 'profile')).toBe(true);
    expect(originals.every(item => item.topic === 'popular_x')).toBe(true);
    expect(selectBalancedCards([], sources)).toEqual([]);
    const unclassifiedPost = source('legacy', undefined, '500');
    expect(selectBalancedCards([card('legacy', '旧投稿', 'recent_x')], [unclassifiedPost])[0]?.topic).toBe('profile');
  });

  it('also deduplicates legacy X status URLs without metadata', () => {
    const first = source('first', 'recent_x', '90'); const second = source('second', 'popular_x', '90');
    delete first.xPost; delete second.xPost; second.url = 'https://twitter.com/chomado/status/90';
    expect(selectBalancedCards([card('first'), card('second')], [first, second])).toHaveLength(1);
  });
});

describe('known-account posts with separately verified company evidence', () => {
  const target = { personName: '千代田まどか', companyName: 'Microsoft' };
  const excerpt = 'ちょまどは公開の技術イベントを紹介しています。';
  const tweet = { ...source('tweet', 'recent_x', '100'), text: excerpt };
  const profile: EvidenceSource = { ...source('company-profile'), url: 'https://developer.microsoft.com/ja-jp/advocates/madoka-chiyoda', text: '千代田まどか (ちょまど) は Microsoft の公開技術イベントを紹介しています。' };

  it('allows a known bound post with a literal person alias and separate web evidence of the company relationship', () => {
    expect(evidenceMatchesCard(excerpt, target, tweet, [tweet, profile])).toBe(true);
    expect(evidenceMatchesCard('Chomado introduces a technical event.', target, tweet, [profile])).toBe(true);
    expect(evidenceMatchesCard(profile.text, target, profile, [profile])).toBe(true);
  });

  it('does not relax profile/company evidence or invent an account mapping', () => {
    expect(evidenceMatchesCard(excerpt, target, tweet, [tweet])).toBe(false);
    expect(evidenceMatchesCard(excerpt, target, tweet, [{ ...profile, text: '千代田まどかのプロフィール' }])).toBe(false);
    expect(evidenceMatchesCard(excerpt, target, tweet, [{ ...profile, kind: 'x' }])).toBe(false);
    expect(evidenceMatchesCard(excerpt, target, { ...tweet, kind: 'web' }, [profile])).toBe(false);
    expect(evidenceMatchesCard(excerpt, { ...target, companyName: '別の会社' }, tweet, [{ ...profile, text: '千代田まどか 別の会社' }])).toBe(false);
    expect(evidenceMatchesCard('山田花子の投稿', { personName: '山田花子', companyName: 'Microsoft' }, tweet, [{ ...profile, text: '山田花子 Microsoft' }])).toBe(false);
    expect(evidenceMatchesCard('投稿に人物名はありません。', target, tweet, [profile])).toBe(false);
    expect(evidenceMatchesCard('notChomadoSuffix introduces a technical event.', target, tweet, [profile])).toBe(false);
  });

  it.each([
    'http://x.com/chomado/status/100', 'https://evil.example/chomado/status/100', 'https://x.com.evil.example/chomado/status/100',
    'https://x.com/another/status/100', 'https://x.com/chomado/status/999', 'https://x.com/chomado',
    'https://user:password@x.com/chomado/status/100', 'https://x.com:8443/chomado/status/100',
  ])('refuses unbound or non-post URLs: %s', url => {
    expect(evidenceMatchesCard(excerpt, target, { ...tweet, url }, [profile])).toBe(false);
  });

  it('requires valid post metadata, including matching account and bounded counts', () => {
    expect(evidenceMatchesCard(excerpt, target, { ...tweet, xPost: undefined }, [profile])).toBe(false);
    for (const patch of [{ username: 'another' }, { authorId: 'not-an-id' }, { createdAt: 'yesterday' }, { likeCount: -1 }, { replyCount: 1.5 }]) {
      expect(evidenceMatchesCard(excerpt, target, { ...tweet, xPost: { ...post(), ...patch } }, [profile])).toBe(false);
    }
  });
});

describe('topic metadata contracts', () => {
  it('accepts adapter metadata and card topics while forbidding model-proposed topic labels', () => {
    expect(SearchHitSchema.parse({ url: 'https://x.com/chomado/status/100', title: '投稿', topic: 'recent_x' }).topic).toBe('recent_x');
    const evidence = { ...source('sample', 'popular_x', '100'), xPost: { ...post(), selectionScope: 'full_archive_sample' } };
    expect(EvidenceSourceSchema.parse(evidence).xPost?.selectionScope).toBe('full_archive_sample');
    expect(EvidenceSourceSchema.safeParse({ ...evidence, xPost: { ...evidence.xPost, untrusted: true } }).success).toBe(false);
    expect(CardSchema.parse(card('sample', '事実', 'popular_x')).topic).toBe('popular_x');
    expect(ProposedCardSchema.safeParse({ fact: '事実', excerpt: '事実', sourceId: 'sample', suggestedQuestion: '質問？', topic: 'popular_x' }).success).toBe(false);
    const result = { requestId: 'fixture-request', subjectRevision: 1, mode: 'demo', status: 'ready', target: null, candidates: [], cards: [], sources: Array.from({ length: 6 }, (_, index) => source(String(index))), trace: [], reasonCode: '', message: '', usage: { llm: 0, searches: 0, pages: 0, elapsedMs: 0, reservedUsd: 0, actualUsd: 0, costKnown: true } };
    expect(ResearchResultSchema.safeParse(result).success).toBe(true);
    expect(ResearchResultSchema.safeParse({ ...result, sources: [...result.sources, source('extra')] }).success).toBe(false);
  });
});
