import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_FIGURE_CATALOG } from '../src/shared/public-figure-catalog.ts';
import { evidenceMatchesTarget, isTargetGroundedInTranscript, isVerifiedPublicSource, verifiedAliasForInputTarget, verifiedAliasForTarget } from '../src/shared/identity-aliases.ts';
import { buildSearchCandidates } from '../src/shared/search-candidates.ts';
import { extractHomophoneTarget, resolvePersonTarget } from '../server/person-resolver.ts';
import type { createLunaCorrection } from '../server/luna-correction.ts';

const addedIds = ['koma-ai-yorozuya', 'shohei-ohtani', 'sam-altman', 'elon-musk', 'andrej-karpathy', 'yutaka-matsuo', 'oki-matsumoto', 'yoshiaki-murakami', 'daisuke-okanohara', 'toru-nishikawa', 'takayuki-fukatsu'];
const records = addedIds.map(id => PUBLIC_FIGURE_CATALOG.find(entry => entry.id === id)!);
const koma = { personName: 'こま', companyName: '' };
const signal = () => new AbortController().signal;

describe('primary-source public-person additions', () => {
  it.each(records)('researches $canonicalName from sourced names and kana with no inferred employer or model correction', async entry => {
    const correct = vi.fn<ReturnType<typeof createLunaCorrection>>();
    for (const personName of [entry.canonicalName, entry.kana, entry.kana.replace(/[ぁ-ゖ]/gu, character => String.fromCharCode(character.charCodeAt(0) + 0x60))]) {
      const transcript = `${personName}さんについて`;
      const expected = { personName: entry.canonicalName, companyName: '' };
      expect(verifiedAliasForTarget({ personName, companyName: '' })?.target).toEqual(expected);
      expect(isTargetGroundedInTranscript(transcript, '', expected)).toBe(true);
      expect(await resolvePersonTarget({ currentTranscript: transcript, previousTranscript: '', target: null, correct }, signal()))
        .toMatchObject({ target: expected, usedLuna: false });
      expect(buildSearchCandidates({ targets: [], transcript }).some(choice => choice.target.personName === entry.canonicalName)).toBe(true);
      expect(verifiedAliasForTarget({ personName, companyName: '架空の別会社' })).toBeUndefined();
    }
    expect(correct).not.toHaveBeenCalled();
    expect(entry.officialProfileUrl).toMatch(/^https:\/\//u);
    expect(entry.readingBasis).toMatch(/primary-source$/u);
    expect(entry.checkedOn).toBe('2026-09-23');
  });

  it.each([
    ['こま', 'ai_yorozuya'], ['サム・アルトマン', 'sama'], ['イーロン・マスク', 'elonmusk'],
    ['Andrej Karpathy', 'karpathy'], ['岡野原大輔', 'hillbig'], ['深津貴之', 'fladdict'],
  ])('accepts only the linked personal X account for %s', (personName, handle) => {
    const target = { personName, companyName: '' };
    expect(verifiedAliasForTarget(target)?.xHandle).toBe(handle);
    expect(isVerifiedPublicSource(`https://x.com/${handle}/status/123`, target)).toBe(true);
    expect(isVerifiedPublicSource(`https://x.com/${handle}_fan/status/123`, target)).toBe(false);
    expect(isVerifiedPublicSource(`https://x.com.evil.invalid/${handle}`, target)).toBe(false);
  });

  it.each(['大谷翔平', '松尾豊', '松本大', '村上世彰', '西川徹'])('retains Web discovery without inventing an X account for %s', personName => {
    const target = { personName, companyName: '' }; const alias = verifiedAliasForTarget(target)!;
    expect(alias.target).toEqual(target); expect(alias.xHandle).toBeUndefined();
    expect(isVerifiedPublicSource('https://x.com/unverified_fan', target)).toBe(false);
    expect(isVerifiedPublicSource(alias.sourceUrls[0]!, target)).toBe(true);
    expect(buildSearchCandidates({ targets: [], transcript: `${personName}さんについて` }).some(choice => choice.query.includes(personName))).toBe(true);
  });

  it.each(['こまさん', 'コマさん', '@ai_yorozuya', 'ai_yorozuya'])('grounds the source-backed organizer name %s', name => {
    expect(verifiedAliasForInputTarget(`${name}について`, koma)?.xHandle).toBe('ai_yorozuya');
    expect(isTargetGroundedInTranscript(`${name}について`, '', koma)).toBe(true);
  });

  it.each(['こまを回す', 'コマンドを実行する', 'ここまでです', 'こまったな', 'こまが足りない',
    '漫画の4コマ。', '漫画の４ コマ。', '最後の一コマ。', '映画のひとコマ。'])('does not reinterpret ordinary speech as the organizer: %s', async transcript => {
    expect(verifiedAliasForInputTarget(transcript, koma)).toBeUndefined();
    expect(isTargetGroundedInTranscript(transcript, '', koma)).toBe(false);
    expect(await resolvePersonTarget({ currentTranscript: transcript, previousTranscript: '', target: null }, signal())).toEqual({ target: null, usedLuna: false });
    expect(buildSearchCandidates({ targets: [], transcript })).toEqual([]);
  });
});

describe('user-provided organizer surname stays a selectable search hint', () => {
  it.each(['高野さんについて', 'たかのさんです', 'タカノさん', '高野', '大会責任者の高野さん', '大会責任者 高野さん'])('labels the user-provided hint without silently adopting it: %s', async transcript => {
    const name = transcript.includes('高野') ? '高野' : transcript.includes('タカノ') ? 'タカノ' : 'たかの';
    const raw = { personName: name, companyName: '' };
    for (const targets of [[], [raw], [koma]]) {
      const choices = buildSearchCandidates({ targets, transcript });
      const candidates = choices.filter(choice => choice.target.personName === 'こま');
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every(choice => choice.label.includes('ユーザー指定の呼称・要確認'))).toBe(true);
      expect(candidates.every(choice => choice.target.companyName === '')).toBe(true);
      expect(choices.length).toBeLessThanOrEqual(4);
    }
    expect(verifiedAliasForTarget(raw)).toBeUndefined();
    expect(verifiedAliasForInputTarget(transcript, koma)).toBeUndefined();
    expect(isTargetGroundedInTranscript(transcript, '', koma)).toBe(false);
    expect(evidenceMatchesTarget(transcript, koma, 'https://x.com/ai_yorozuya')).toBe(false);
    expect(extractHomophoneTarget(transcript, '')).toBeNull();
    expect(await resolvePersonTarget({ currentTranscript: transcript, previousTranscript: '', target: null }, signal())).toEqual({ target: null, usedLuna: false });
    expect(await resolvePersonTarget({ currentTranscript: transcript, previousTranscript: '', target: koma }, signal())).toEqual({ target: null, usedLuna: false });
  });

  it.each(['高野豆腐を食べる', '高野山に行く', '高野太郎さん', 'たかのりさん', 'タカノハナです', '今日はありがとう'])('does not offer the organizer from another name or ordinary word: %s', transcript => {
    expect(buildSearchCandidates({ targets: [], transcript, companyContext: '高野さん' }).some(choice => choice.target.personName === 'こま')).toBe(false);
  });

  it('retains a different explicit company and the literal surname without offering the organizer', () => {
    const target = { personName: '高野', companyName: '株式会社別会社' };
    const choices = buildSearchCandidates({ targets: [target], transcript: '株式会社別会社の高野さんです' });
    expect(choices[0]?.target).toEqual(target);
    expect(choices.some(choice => choice.target.personName === 'こま')).toBe(false);
    expect(buildSearchCandidates({ targets: [{ ...target, personName: 'こま' }], transcript: '株式会社別会社の高野さんです' })
      .some(choice => choice.target.personName === 'こま')).toBe(false);
  });
});
