import { describe, expect, it, vi } from 'vitest';
import { createLiveProvider } from '../server/providers.ts';
import type { EvidenceSource, Target } from '../src/shared/contracts.ts';

const target: Target = { personName: '架空花子', companyName: '架空研究所' };
const FACT = '公開研究会で設計手法を紹介しました。';
const OTHER_FACT = '地域の図書館で活動しています。';
const source = (sourceId: string, text: string): EvidenceSource => ({
  sourceId, text, url: `https://example.invalid/${sourceId}`, title: '架空の検証資料',
  retrievedAt: '2026-09-22T00:00:00Z', kind: 'web',
});
const primary = () => source('primary', `${target.companyName}の${target.personName}の公開プロフィールです。${FACT}`);
interface SelectionInput {
  target: Target;
  sources: Array<EvidenceSource & { cardEligible: boolean; excerpts: Array<{ excerptId: string; text: string; facts: Array<{ factId: string; text: string }> }> }>;
}
const emptyAssessment = () => ({ identityVerified: true, needsConfirmation: false, candidates: [], cards: [], followUpQuery: null, reason: '架空資料の検証' });
function select(input: SelectionInput, sourceId = 'primary', fact = FACT) {
  const candidate = input.sources.find(item => item.sourceId === sourceId)!.excerpts.flatMap(item => item.facts).find(item => item.text.includes(fact));
  if (!candidate) throw new Error('Test fixture did not supply the intended sentence');
  return { factId: candidate.factId, suggestedQuestion: '研究会ではどのような質問がありましたか。' };
}
function fixture(reply: (input: SelectionInput) => unknown = () => emptyAssessment()) {
  const inputs: SelectionInput[] = [];
  const api = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe('https://api.orcarouter.ai/v1/chat/completions');
    const request = JSON.parse(String(init?.body));
    const input = JSON.parse(request.messages[1].content) as SelectionInput;
    inputs.push(input);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(input)) } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  const provider = createLiveProvider({ orcaApiKey: 'fixture-key', orcaModel: 'fixture-model', tavilyApiKey: 'fixture-search-key' }, { fetch: api });
  const assess = (sources: EvidenceSource[] = [primary()], subject = target) => provider.assess(subject, sources, new AbortController().signal);
  return { api, inputs, assess };
}
const hasLoneSurrogate = (text: string) => [...text].some(character => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);

describe('bounded evidence selection — mocked model, no network or assertion of semantic identity', () => {
  it('maps a known selection to the exact original source and raw contiguous excerpt', async () => {
    const f = fixture(data => ({ ...emptyAssessment(), cards: [select(data)] }));
    const original = primary();
    const result = await f.assess([original]);
    expect(result.value.cards).toHaveLength(1);
    const selected = f.inputs[0]!.sources[0]!.excerpts[0]!;
    expect(result.value.cards[0]).toEqual({ fact: FACT, suggestedQuestion: '研究会ではどのような質問がありましたか。', sourceId: original.sourceId, excerpt: selected.text });
    expect(original.text.includes(result.value.cards[0]!.excerpt)).toBe(true);
    expect(result.value.cards[0]).not.toHaveProperty('excerptId');
    expect(result.value.cards[0]).not.toHaveProperty('factId');
    expect(selected.facts.find(item => item.factId === select(f.inputs[0]!).factId)!.text).toBe(FACT);
    expect(f.api).toHaveBeenCalledOnce();
  });

  it('drops unknown fact IDs without falling back to the source or inventing a quote', async () => {
    const f = fixture(data => ({ ...emptyAssessment(), cards: [{ ...select(data), factId: 'not-in-this-response' }] }));
    expect((await f.assess()).value.cards).toEqual([]);
  });

  it('does not reuse a valid fact ID from an earlier assessment', async () => {
    let previousId = '';
    const f = fixture(data => {
      const card = select(data);
      if (!previousId) { previousId = card.factId; return { ...emptyAssessment(), cards: [card] }; }
      expect(card.factId).not.toBe(previousId);
      return { ...emptyAssessment(), cards: [{ ...card, factId: previousId }] };
    });
    expect((await f.assess()).value.cards).toHaveLength(1);
    expect((await f.assess()).value.cards).toEqual([]);
  });

  it.each([
    '公開研究会で設計方法を紹介しました。',
    '公開研究会で…紹介しました。',
    '公開研究会で 設計手法を紹介しました。',
  ])('rejects a model-authored paraphrased, concatenated, or rewritten fact: %s', async fact => {
    const f = fixture(data => ({ ...emptyAssessment(), cards: [{ ...select(data), fact }] }));
    await expect(f.assess()).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  it('does not attach another source’s exact fact to the selected source', async () => {
    const f = fixture(data => ({ ...emptyAssessment(), cards: [{ ...select(data), fact: OTHER_FACT }] }));
    const other = source('other', `${target.companyName}の${target.personName}は、${OTHER_FACT}`);
    await expect(f.assess([primary(), other])).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    expect(f.inputs[0]!.sources.find(item => item.sourceId === 'other')!.excerpts.length).toBeGreaterThan(0);
  });

  it('binds a selected sentence to its own source even when another eligible source comes first', async () => {
    const other = source('other', `${target.companyName}の${target.personName}の資料です。${OTHER_FACT}`);
    const f = fixture(data => ({ ...emptyAssessment(), cards: [select(data, 'other', OTHER_FACT)] }));
    const result = await f.assess([primary(), other]);
    expect(result.value.cards).toEqual([{ fact: OTHER_FACT, sourceId: 'other', excerpt: other.text,
      suggestedQuestion: '研究会ではどのような質問がありましたか。' }]);
  });

  it('does not widen a selected excerpt to use a fact elsewhere in the same source', async () => {
    const text = primary().text + '余'.repeat(1500) + `${target.companyName}の${target.personName}は、${OTHER_FACT}`;
    const f = fixture(data => ({ ...emptyAssessment(), cards: [{ ...select(data), fact: OTHER_FACT }] }));
    await expect(f.assess([source('primary', text)])).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    expect(f.inputs[0]!.sources[0]!.text).toContain(OTHER_FACT);
  });

  it.each([{ sourceId: 'primary' }, { excerpt: 'a model-authored quotation' }, { excerptId: 'an-old-contract-id' }])('rejects extra model-authored evidence fields %j', async extra => {
    const f = fixture(data => ({ ...emptyAssessment(), cards: [{ ...select(data), ...extra }] }));
    await expect(f.assess()).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
  });

  it('retains all four sources, including conflicting and ineligible evidence, and preserves ambiguity flags', async () => {
    const conflict = source('conflict', `${target.personName}は別の架空会社の所属です。`);
    const companyOnly = source('company-only', `${target.companyName}についての資料。`);
    const otherPerson = source('other-person', '別の架空人物の資料。');
    const originals = [conflict, companyOnly, primary(), otherPerson];
    const f = fixture(() => ({ ...emptyAssessment(), identityVerified: false, needsConfirmation: true, reason: '架空資料の所属に矛盾があります。' }));
    const result = await f.assess(originals);
    expect(result.value).toMatchObject({ identityVerified: false, needsConfirmation: true, cards: [] });
    const sent = f.inputs[0]!.sources;
    expect(sent.map(item => item.sourceId).sort()).toEqual(originals.map(item => item.sourceId).sort());
    for (const original of originals) expect(sent.find(item => item.sourceId === original.sourceId)!.text).toBe(original.text);
    expect(sent.find(item => item.sourceId === 'primary')!.excerpts.length).toBeGreaterThan(0);
    expect(sent.find(item => item.sourceId === 'conflict')!.excerpts).toEqual([]);
    expect(sent.find(item => item.sourceId === 'company-only')!.excerpts).toEqual([]);
  });

  it.each([
    { personName: '架空花子', companyName: '架空研究所', raw: '架 空 花 子は架空　研究所で、' },
    { personName: 'ガク', companyName: 'AKARI LABS', raw: 'カ\u3099クはＡＫＡＲＩ　ＬＡＢＳで、' },
  ])('allows existing identity normalization but preserves raw Unicode and whitespace: $personName', async ({ personName, companyName, raw }) => {
    const text = `${raw}${FACT} 😀余白を含む元の本文。`;
    const f = fixture(data => ({ ...emptyAssessment(), cards: [select(data)] }));
    const result = await f.assess([source('primary', text)], { personName, companyName });
    expect(result.value.cards).toHaveLength(1);
    expect(result.value.cards[0]!.excerpt).toBe(text);
    expect(result.value.cards[0]!.excerpt.length).toBeLessThanOrEqual(1000);
  });

  it('never includes text or identity beyond the 10,000-character source cap', async () => {
    const tail = 'OUT_OF_CAP_ONLY_IDENTITY';
    const long = source('primary', `${'余'.repeat(10_000)}${target.personName} ${target.companyName} ${tail}`);
    const f = fixture();
    await f.assess([long]);
    expect(f.inputs[0]!.sources[0]!.text).toHaveLength(10_000);
    expect(f.inputs[0]!.sources[0]!.cardEligible).toBe(false);
    expect(f.inputs[0]!.sources[0]!.excerpts).toEqual([]);
    expect(JSON.stringify(f.inputs[0]!.sources)).not.toContain(tail);
  });

  it('does not join distant identities, or names split across different sources, into a quote', async () => {
    const f = fixture();
    await f.assess([
      source('distant', `${target.personName}${'余'.repeat(1000)}${target.companyName} ${FACT}`),
      source('person-only', target.personName), source('company-only', `${target.companyName} ${FACT}`),
    ]);
    for (const item of f.inputs[0]!.sources) expect(item.excerpts).toEqual([]);
  });

  it('never aliases a translated name or another affiliation into an eligible quote', async () => {
    const f = fixture();
    await f.assess([source('translated', `Fictional Hanako ${target.companyName} ${FACT}`),
      source('other-company', `${target.personName} 別の架空会社 ${FACT}`)]);
    for (const item of f.inputs[0]!.sources) expect(item.excerpts).toEqual([]);
  });

  it('keeps raw windows within 1,000 UTF-16 units without splitting surrogate pairs', async () => {
    const heading = `${target.personName} ${target.companyName} `;
    const text = (heading.padEnd(499, '余') + '😀' + heading).padEnd(999, '余') + '😀' + heading + '余'.repeat(800);
    const f = fixture();
    await f.assess([source('primary', text)]);
    const excerpts = f.inputs[0]!.sources[0]!.excerpts;
    expect(excerpts.length).toBeGreaterThan(0);
    for (const excerpt of excerpts) {
      expect(excerpt.text.length).toBeLessThanOrEqual(1000);
      expect(text.includes(excerpt.text)).toBe(true);
      expect(hasLoneSurrogate(excerpt.text)).toBe(false);
    }
  });

  it('only trims sentence edges and never rewrites internal whitespace or Unicode', async () => {
    const fact = 'ＡＩ  を使い、カ\u3099イドを紹介しました。';
    const text = `${target.personName}は${target.companyName}所属です。\n\t  ${fact}  \n`;
    const f = fixture(data => ({ ...emptyAssessment(), cards: [select(data, 'primary', fact)] }));
    const result = await f.assess([source('primary', text)]);
    expect(result.value.cards[0]!.fact).toBe(fact);
    expect(text.includes(result.value.cards[0]!.fact)).toBe(true);
  });

  it('keeps a 200-unit whole sentence but excludes a 201-unit sentence without shortening it', async () => {
    const exactLimit = `${'可'.repeat(199)}。`;
    const overLimit = `${'長'.repeat(200)}。`;
    const text = `${target.personName}は${target.companyName}所属です。${exactLimit}${overLimit}${FACT}`;
    const f = fixture(data => ({ ...emptyAssessment(), cards: [select(data, 'primary', exactLimit)] }));
    const result = await f.assess([source('primary', text)]);
    expect(result.value.cards[0]!.fact).toBe(exactLimit);
    const candidates = f.inputs[0]!.sources[0]!.excerpts.flatMap(excerpt => excerpt.facts.map(item => item.text));
    expect(candidates).toContain(exactLimit);
    expect(candidates).toContain(FACT);
    expect(candidates.some(text => text.includes('長'))).toBe(false);
  });

  it('does not turn either clipped edge of a long sentence into a shorter fact', async () => {
    const identity = `${target.personName}は${target.companyName}所属です。`;
    const longFirst = `${'長'.repeat(550)}末尾だけを採用してはいけません。`;
    const longLast = `${'尾'.repeat(650)}という記述は事実ではありません。`;
    const text = `${longFirst}${identity}${FACT}${longLast}`;
    const f = fixture();
    await f.assess([source('primary', text)]);
    const excerpts = f.inputs[0]!.sources[0]!.excerpts;
    expect(excerpts.length).toBeGreaterThan(1);
    const candidates = excerpts.flatMap(excerpt => excerpt.facts.map(item => item.text));
    expect(candidates).toContain(FACT);
    expect(candidates.every(candidate => [identity, FACT].includes(candidate))).toBe(true);
  });

  it('does not expose a sentence truncated at the 10,000-unit payload boundary', async () => {
    const identity = `${target.personName}は${target.companyName}所属です。`;
    const beginning = `${'前'.repeat(9700)}。${identity}`;
    const lastSentence = `${'未'.repeat(80)}OUT_OF_CAP_NEGATIONを示す文ではありません。`;
    const text = beginning.padEnd(9950, ' ') + lastSentence;
    const f = fixture();
    await f.assess([source('primary', text)]);
    const sent = f.inputs[0]!.sources[0]!;
    expect(sent.text).toHaveLength(10_000);
    expect(sent.excerpts.length).toBeGreaterThan(0);
    expect(sent.excerpts.flatMap(excerpt => excerpt.facts).some(candidate => candidate.text.includes('未'))).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('OUT_OF_CAP_NEGATION');
  });

  it('offers at most eight complete sentence choices in an excerpt', async () => {
    const identity = `${target.personName}は${target.companyName}所属です。`;
    const text = identity + Array.from({ length: 20 }, (_, index) => `第${index}回の公開活動です。`).join('');
    const f = fixture();
    await f.assess([source('primary', text)]);
    const excerpt = f.inputs[0]!.sources[0]!.excerpts[0]!;
    expect(excerpt.facts).toHaveLength(8);
    expect(new Set(excerpt.facts.map(candidate => candidate.factId)).size).toBe(8);
    expect(excerpt.facts.every(candidate => text.includes(candidate.text))).toBe(true);
  });

  it('bounds repeated-identity windows while retaining the full capped source text', async () => {
    const text = `${target.personName} ${target.companyName} ${FACT}`.repeat(1000);
    const sources = Array.from({ length: 4 }, (_, index) => source(`source-${index}`, text));
    const f = fixture();
    await f.assess(sources);
    const sent = f.inputs[0]!.sources;
    expect(sent).toHaveLength(4);
    for (const item of sent) {
      expect(item.text).toHaveLength(10_000);
      expect(item.excerpts.length).toBeGreaterThan(0);
      expect(item.excerpts.length).toBeLessThanOrEqual(4);
      for (const excerpt of item.excerpts) {
        expect(excerpt.text.length).toBeLessThanOrEqual(1000);
        expect(excerpt.facts.length).toBeLessThanOrEqual(8);
        for (const candidate of excerpt.facts) {
          expect(candidate.text.length).toBeLessThanOrEqual(200);
          expect(excerpt.text).toContain(candidate.text);
        }
      }
    }
    expect(sent.reduce((size, item) => size + item.text.length + item.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0), 0)).toBeLessThanOrEqual(56_000);
  });
});
