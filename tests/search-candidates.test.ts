import { describe, expect, it } from 'vitest';
import { buildSearchCandidates, SearchCandidateSchema } from '../src/shared/search-candidates.ts';
import { verifiedAliasForTarget } from '../src/shared/identity-aliases.ts';
import type { Target } from '../src/shared/contracts.ts';

describe('grounded, visible search choices', () => {
  it('offers bounded, deterministic alternatives for an unregistered literal person', () => {
    const target = { personName: '架空山田', companyName: '架空工房' };
    const input = { targets: [target], transcript: '架空工房の架空山田さんです。' };
    const choices = buildSearchCandidates(input);
    expect(choices).toHaveLength(4);
    expect(choices[0]).toMatchObject({ target, query: '"架空山田" "架空工房"' });
    expect(choices[1]).toMatchObject({ target: { ...target, companyName: '' }, query: '"架空山田"' });
    expect(choices.map(choice => choice.query)).toContain('"架空山田" "架空工房" 公式プロフィール');
    expect(choices.every(choice => SearchCandidateSchema.safeParse(choice).success)).toBe(true);
    expect(new Set(choices.map(choice => choice.id)).size).toBe(4);
    expect(buildSearchCandidates(input)).toEqual(choices);
  });

  it.each(['', 'こんにちは。', '株式会社メイドインジャパンについて', 'マイクロソフトについて'])('does not invent a person from %s', transcript => {
    expect(buildSearchCandidates({ targets: [], transcript })).toEqual([]);
  });

  it('requires the person in current speech; previous speech supplies only a company', () => {
    const target = { personName: '架空山田', companyName: '架空工房' };
    expect(buildSearchCandidates({ targets: [target], transcript: 'ありがとうございます。', companyContext: '架空工房の架空山田' })).toEqual([]);
    expect(buildSearchCandidates({ targets: [target], transcript: '架空山田です。', companyContext: '架空工房' })[0]?.target).toEqual(target);
    expect(buildSearchCandidates({ targets: [target], transcript: '架空山田です。' })).toEqual([]);
  });

  it('discovers a spoken public name even when identification returned no target', () => {
    const choices = buildSearchCandidates({ targets: [], transcript: 'ホリエモンさんについて' });
    expect(choices[0]?.target).toEqual({ personName: '堀江貴文', companyName: '' });
    expect(choices.every(choice => choice.target.companyName === '')).toBe(true);
    expect(choices.some(choice => choice.target.personName === '西村博之')).toBe(false);
  });

  it('keeps ASR spelling and proposed correction distinct, without verifying an alias', () => {
    const target = { personName: '広行', companyName: '' };
    const choices = buildSearchCandidates({ targets: [target], transcript: '広行さんです' });
    expect(choices[0]?.target).toEqual(target);
    const correction = choices.find(choice => choice.target.personName === '西村博之');
    expect(correction?.label).toContain('補正候補・要確認');
    expect(verifiedAliasForTarget(target)).toBeUndefined();
  });

  it('marks an already-canonical proposal based only on a homophone as unconfirmed', () => {
    const choices = buildSearchCandidates({ targets: [{ personName: '西村博之', companyName: '' }], transcript: '広行さんです' });
    expect(choices[0]?.target.personName).toBe('広行');
    expect(choices.find(choice => choice.target.personName === '西村博之')?.label).toContain('補正候補・要確認');
  });

  it('offers a close kana correction only from a literal supplied name', () => {
    const choices = buildSearchCandidates({ targets: [{ personName: 'ひろゆぎ', companyName: '' }], transcript: 'ひろゆぎさんです' });
    expect(choices.find(choice => choice.target.personName === '西村博之')?.label).toContain('補正候補・要確認');
    expect(buildSearchCandidates({ targets: [], transcript: 'ひろゆぎさんです' })).toEqual([]);
  });

  it('never replaces an explicitly conflicting company with a famous person relationship', () => {
    const target = { personName: '広行', companyName: '株式会社別会社' };
    const choices = buildSearchCandidates({ targets: [target], transcript: '株式会社別会社の広行さんです' });
    expect(choices[0]?.target).toEqual(target);
    expect(choices.every(choice => choice.target.personName === '広行')).toBe(true);
    expect(choices.some(choice => choice.query.includes('made in Japan'))).toBe(false);
  });

  it('accepts source-backed names and spoken company variants without inventing employment', () => {
    const choices = buildSearchCandidates({ targets: [{ personName: '千代田まどか', companyName: 'Microsoft' }], transcript: 'マイクロソフトのチョマドさんです' });
    expect(choices[0]?.target).toEqual({ personName: '千代田まどか', companyName: 'Microsoft' });
    expect(choices.some(choice => choice.label.includes('補正候補'))).toBe(false);
  });

  it('prioritizes different grounded people before query variants and caps the list', () => {
    const targets: Target[] = Array.from({ length: 6 }, (_, index) => ({ personName: `架空人物${index + 1}`, companyName: '' }));
    const choices = buildSearchCandidates({ targets, transcript: targets.map(target => target.personName).join('、') });
    expect(choices.map(choice => choice.target)).toEqual(targets.slice(0, 4));
  });

  it('rejects ungrounded proposals and Latin names embedded in a different identity', () => {
    expect(buildSearchCandidates({ targets: [{ personName: '西村博之', companyName: '' }], transcript: '架空の山田さんです' })).toEqual([]);
    expect(buildSearchCandidates({ targets: [{ personName: 'Hiroyuki Nishimura', companyName: '' }], transcript: 'notHiroyukiNishimuraName' })).toEqual([]);
    expect(buildSearchCandidates({ targets: [], transcript: 'notchomadoName' })).toEqual([]);
  });

  it('deduplicates repeated targets without modifying the input', () => {
    const target = Object.freeze({ personName: '架空山田', companyName: '' });
    const input = Object.freeze({ targets: Object.freeze([target, target]), transcript: '架空山田さんです' });
    const choices = buildSearchCandidates(input);
    expect(choices).toHaveLength(3);
    expect(new Set(choices.map(choice => choice.query)).size).toBe(3);
    expect(target).toEqual({ personName: '架空山田', companyName: '' });
  });

  it.each(['たいしたことないです', 'たいして変わりません', 'まだ試したいし考えたいし'])('does not extract Taishi from ordinary speech: %s', transcript => {
    expect(buildSearchCandidates({ targets: [], transcript })).toEqual([]);
    expect(buildSearchCandidates({ targets: [{ personName: 'たいし', companyName: '' }], transcript })).toEqual([]);
    expect(buildSearchCandidates({ targets: [{ personName: '山崎大志', companyName: '' }], transcript })).toEqual([]);
  });

  it.each(['たいしさんです', 'アルファバイトのたいしさん', 'Taishi です', 'やまさきたいしさんです'])('accepts a grounded judge name: %s', transcript => {
    const choices = buildSearchCandidates({ targets: [], transcript });
    expect(choices.some(choice => choice.target.personName === '山崎大志')).toBe(true);
    expect(choices.some(choice => choice.label.includes('補正候補'))).toBe(false);
  });

  it('lets the user remove an activity description mistaken for a company without inventing AlphaByte', () => {
    const target = { personName: 'Taishi', companyName: 'AI Language Learning App' };
    const choices = buildSearchCandidates({ targets: [target], transcript: 'Taishi AI Language Learning App' });
    expect(choices[0]?.target).toEqual(target);
    expect(choices.find(choice => choice.target.companyName === '')).toMatchObject({
      target: { personName: 'Taishi', companyName: '' }, query: '"Taishi"', label: expect.stringContaining('所属を外して検索'),
    });
    expect(choices.every(choice => !choice.query.includes('AlphaByte'))).toBe(true);
    expect(verifiedAliasForTarget(target)).toBeUndefined();
  });

  it.each(['かすなり', '数なり', 'かつなり'])('keeps %s selectable but unconfirmed even with the judge company', name => {
    const target = { personName: name, companyName: 'サードスコープ' };
    const choices = buildSearchCandidates({ targets: [target], transcript: `サードスコープの${name}さんです` });
    expect(choices[0]?.target).toEqual(target);
    expect(choices.find(choice => choice.target.personName === '伊東和成')?.label).toContain('補正候補・要確認');
    expect(verifiedAliasForTarget(target)).toBeUndefined();
  });
});
