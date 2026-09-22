import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonHistory } from '../src/person-history.ts';
import type { ResearchResult, Target } from '../src/shared/contracts.ts';

const NOW = Date.UTC(2026, 8, 23, 12);
const TTL = 15 * 60_000;
const ALICE: Target = { personName: 'かとう あき', companyName: 'テスト社' };
const BOB: Target = { personName: '架空の別人物', companyName: '架空の別会社' };
function result(target: Target = ALICE, id = 'first', cardExpiry = NOW + 5 * 60_000): ResearchResult {
  const fact = `${target.personName}さんが架空の試作機を紹介した。`;
  return { requestId: id, subjectRevision: 1, mode: 'live', target: structuredClone(target), status: 'ready',
    cards: [{ cardId: `${id}-card`, sourceId: `${id}-source`, fact, excerpt: fact,
      suggestedQuestion: '試作機で気に入っている点は何ですか？', expiresAt: new Date(cardExpiry).toISOString(), requestId: id, subjectRevision: 1 }],
    sources: [{ sourceId: `${id}-source`, url: 'https://example.invalid/fixture', kind: 'fixture', title: '模擬資料',
      retrievedAt: new Date(NOW).toISOString(), text: fact }],
    candidates: [], trace: [{ eventId: 1, step: 'fixture', message: '模擬調査', at: new Date(NOW).toISOString() }],
    reasonCode: 'EVIDENCE_VERIFIED', message: '架空の検証結果',
    usage: { llm: 1, searches: 1, pages: 1, elapsedMs: 1, reservedUsd: 0.01, actualUsd: null, costKnown: false } };
}

describe('bounded memory-only person history', () => {
  let history: PersonHistory;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); history = new PersonHistory(); });
  afterEach(() => { history.clear(); vi.useRealTimers(); });

  it('appends in first-recognized order and updates only spelling-equivalent person/company keys', () => {
    const first = history.rememberTarget(ALICE);
    const second = history.rememberTarget(BOB, NOW + 1);
    expect(history.rememberTarget({ personName: ' ｶﾄｳ　ｱｷ ', companyName: ' てすと 社 ' }, NOW + 100)).toBe(first);
    const latin = history.rememberTarget({ personName: 'Ａｌｉｃｅ Ｌｅｅ', companyName: ' ＡＢＣ ' });
    expect(history.rememberTarget({ personName: 'alicelee', companyName: 'abc' })).toBe(latin);
    expect(history.entries().map(entry => entry.id)).toEqual([first, second, latin]);
    expect(history.get(first)).toMatchObject({ target: ALICE, recognizedAt: NOW, expiresAt: NOW + TTL, status: 'researching' });
  });

  it('never merges distinct companies, absent affiliation, honorifics, or guessed aliases', () => {
    for (const target of [ALICE, { ...ALICE, companyName: '' }, { ...ALICE, companyName: '別会社' },
      { ...ALICE, personName: 'かとうあきさん' }, { ...ALICE, personName: '加藤亜希' }]) history.rememberTarget(target);
    expect(history.entries()).toHaveLength(5);
  });

  it('evicts the oldest recognition at 30 people, rather than changing order on repeated recognition', () => {
    const ids = Array.from({ length: 30 }, (_, index) => history.rememberTarget({ ...ALICE, personName: `架空人物${index}` }, NOW + index));
    expect(history.rememberTarget({ ...ALICE, personName: '架空人物0' }, NOW + 100)).toBe(ids[0]);
    const newest = history.rememberTarget(BOB, NOW + 101);
    expect(history.get(ids[0]!)).toBeUndefined();
    expect(history.entries().map(entry => entry.id)).toEqual([...ids.slice(1), newest]);
    expect(vi.getTimerCount()).toBe(30);
  });

  it('makes deep snapshots on both input and every read', () => {
    const input = result(); const id = history.rememberResult(input)!;
    input.target!.personName = 'changed'; input.cards[0]!.fact = 'changed'; input.sources[0]!.text = 'changed'; input.trace[0]!.message = 'changed';
    const a = history.get(id)!;
    expect(a.target).toEqual(ALICE); expect(a.result!.cards[0]!.fact).not.toBe('changed');
    a.target.companyName = 'changed'; a.result!.cards[0]!.suggestedQuestion = 'changed'; a.result!.sources[0]!.text = 'changed';
    const list = history.entries(); list[0]!.result!.usage.llm = 99; list.splice(0);
    expect(history.get(id)!.target).toEqual(ALICE);
    expect(history.get(id)!.result).toMatchObject({ usage: { llm: 1 }, trace: [{ message: '模擬調査' }] });
    expect(history.get(id)!.result!.cards[0]!.suggestedQuestion).not.toBe('changed');
  });

  it('updates progressive results as coherent complete snapshots, without unioning old evidence', () => {
    const first = result(); first.status = 'partial'; first.reasonCode = 'PROGRESSIVE_QUICK';
    const id = history.rememberResult(first)!;
    expect(history.get(id)!.status).toBe('partial');
    const final = result(ALICE, 'enriched');
    expect(history.rememberResult(final, NOW + 10_000)).toBe(id);
    expect(history.get(id)).toMatchObject({ recognizedAt: NOW, expiresAt: NOW + TTL, status: 'ready', result: final });
    expect(history.get(id)!.result!.cards.map(card => card.cardId)).toEqual(['enriched-card']);
  });

  it.each(['failed', 'no_evidence', 'ready', 'partial', 'cancelled'] as const)('retains only previous unexpired evidence after a %s result without cards', status => {
    const first = result(); const id = history.rememberResult(first)!;
    const failed = result(ALICE, 'new-request'); failed.status = status; failed.cards = [];
    history.rememberResult(failed, NOW + 1000);
    expect(history.get(id)).toMatchObject({ status: 'partial', result: { requestId: 'first', status: 'partial', cards: first.cards, sources: first.sources } });
    expect(history.get(id)!.expiresAt).toBe(NOW + TTL);
    expect(history.get(id)!.result!.cards[0]!.expiresAt).toBe(first.cards[0]!.expiresAt);
  });

  it('revokes old cards when further evidence requires identity confirmation', () => {
    const id = history.rememberResult(result())!;
    const ambiguous = result(); ambiguous.status = 'awaiting_confirmation';
    history.rememberResult(ambiguous, NOW + 1);
    expect(history.get(id)).toMatchObject({ status: 'unconfirmed', result: { cards: [], sources: [] } });
    const failed = result(); failed.status = 'failed'; failed.cards = [];
    history.rememberResult(failed, NOW + 2);
    expect(history.get(id)).toMatchObject({ status: 'failed', result: { cards: [], sources: [] } });
  });

  it('does not borrow a previous person or company result when another target fails', () => {
    const id = history.rememberResult(result())!;
    for (const target of [BOB, { ...ALICE, companyName: '別会社' }]) {
      const failed = result(target); failed.status = 'failed'; failed.cards = [];
      const next = history.rememberResult(failed)!;
      expect(next).not.toBe(id); expect(history.get(next)).toMatchObject({ status: 'failed', result: { cards: [], sources: [] } });
    }
    expect(history.get(id)!.status).toBe('ready');
  });

  it('does not insert a result without an identified target', () => {
    const unidentified = result(); unidentified.target = null;
    expect(history.rememberResult(unidentified)).toBeNull();
    expect(history.entries()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it('removes each expired card and unreferenced source, marks empty when the last question expires', () => {
    const first = result(ALICE, 'first', NOW + 1000);
    const second = result(ALICE, 'second', NOW + 2000);
    first.cards.push({ ...second.cards[0]!, requestId: first.requestId }); first.sources.push(second.sources[0]!);
    first.sources.push({ ...second.sources[0]!, sourceId: 'unreferenced' });
    const id = history.rememberResult(first)!;
    expect(history.get(id)!.result!.sources).toHaveLength(2);
    const partial = history.get(id, NOW + 1000)!;
    expect(partial.status).toBe('partial'); expect(partial.result!.cards.map(card => card.cardId)).toEqual(['second-card']);
    expect(partial.result!.sources.map(source => source.sourceId)).toEqual(['second-source']);
    expect(partial.result!.cards[0]!.expiresAt).toBe(second.cards[0]!.expiresAt);
    expect(history.entries(NOW + 2000)[0]).toMatchObject({ status: 'empty', result: { cards: [], sources: [] } });
  });

  it('never retains expired evidence as failure fallback or accepts mismatched research IDs and missing sources', () => {
    const id = history.rememberResult(result(ALICE, 'old', NOW + 1))!;
    const failed = result(); failed.status = 'failed'; failed.cards = [];
    history.rememberResult(failed, NOW + 2);
    expect(history.get(id, NOW + 2)).toMatchObject({ status: 'failed', result: { cards: [], sources: [] } });
    for (const edit of [(r: ResearchResult) => { r.cards[0]!.requestId = 'other'; },
      (r: ResearchResult) => { r.cards[0]!.subjectRevision = 99; },
      (r: ResearchResult) => { r.sources = []; }]) {
      const invalid = result(); edit(invalid); history.rememberResult(invalid, NOW + 3);
      expect(history.get(id, NOW + 3)).toMatchObject({ status: 'empty', result: { cards: [], sources: [] } });
    }
  });

  it('expires at first recognition plus 15 minutes despite reads, recognition and new results', () => {
    const id = history.rememberTarget(ALICE);
    history.rememberResult(result(ALICE, 'late', NOW + 2 * TTL), NOW + TTL - 1);
    expect(history.rememberTarget(ALICE, NOW + TTL - 1)).toBe(id);
    expect(history.get(id, NOW + TTL - 1)!.expiresAt).toBe(NOW + TTL);
    expect(history.entries(NOW + TTL)).toEqual([]); expect(history.get(id, NOW + TTL)).toBeUndefined();
    const next = history.rememberTarget(ALICE, NOW + TTL);
    expect(next).not.toBe(id); expect(history.get(next, NOW + TTL)!.recognizedAt).toBe(NOW + TTL);
  });

  it('physically releases entries and timers at expiry even without reads, and clears all snapshots explicitly', async () => {
    history.rememberResult(result()); history.rememberTarget(BOB);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(TTL);
    expect(vi.getTimerCount()).toBe(0); expect(history.entries()).toEqual([]);
    const id = history.rememberResult(result(ALICE, 'new', Date.now() + TTL))!;
    history.clear(); expect(history.get(id)).toBeUndefined(); expect(history.entries()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
});
