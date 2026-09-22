import { describe, expect, it } from 'vitest';
import { evidenceMatchesTarget, isTargetGroundedInTranscript, isVerifiedPublicSource, normalizeIdentity, verifiedAliasForInputTarget, verifiedAliasForTarget, VERIFIED_IDENTITY_ALIASES } from '../src/shared/identity-aliases.ts';
import { PUBLIC_FIGURE_CATALOG } from '../src/shared/public-figure-catalog.ts';

const target = { personName: '千代田まどか', companyName: 'Microsoft' };
describe('public-source verified identity aliases', () => {
  it.each(['ちょまど', 'ちょまどさん', '千代田 まどか', 'Madoka Chiyoda'])('requires an exact approved name/company tuple: %s', personName => {
    expect(verifiedAliasForTarget({ personName, companyName: 'マイクロソフト' })?.target).toEqual(target);
  });
  it.each([
    { personName: 'ちょまど', companyName: '別会社' },
    { personName: 'ちょまどに似た人', companyName: 'Microsoft' },
    { personName: '別人', companyName: 'Microsoft' },
  ])('does not broaden the approved identity', input => { expect(verifiedAliasForTarget(input)).toBeUndefined(); });
  it('requires both clues in input and retains source provenance', () => {
    const record = verifiedAliasForInputTarget('マイクロソフトのちょまどさんと話しました。', target);
    expect(record?.xHandle).toBe('chomado');
    expect(record?.sourceUrls).toContain('https://chomado.com/');
    expect(verifiedAliasForInputTarget('Madoka Chiyoda at Microsoft', target)?.xHandle).toBe('chomado');
    for (const text of ['ちょまど', 'Microsoft', 'ちょまど @other', 'chomado at NotMicrosoft']) {
      expect(verifiedAliasForInputTarget(text, target)).toBeUndefined();
    }
  });
  it('permits only known bilingual spellings, without creating facts or admitting another company', () => {
    expect(evidenceMatchesTarget('Madoka Chiyoda (Chomado). Microsoft.', target)).toBe(true);
    expect(evidenceMatchesTarget('千代田まどか。日本マイクロソフト。', target)).toBe(true);
    expect(evidenceMatchesTarget('ちょまど。別会社。', target)).toBe(false);
    expect(evidenceMatchesTarget('NotChomado at Microsoft.', target)).toBe(false);
    expect(evidenceMatchesTarget('Hanako Yamada at Akari Labs.', { personName: '山田花子', companyName: '株式会社灯' })).toBe(false);
  });
});


describe('public-person discovery and kana equivalence', () => {
  it.each([
    ['ひろゆき', '西村博之', 'hirox246'], ['ヒロユキ', '西村博之', 'hirox246'], ['西村博之', '西村博之', 'hirox246'],
    ['ホリエモン', '堀江貴文', 'takapon_jp'], ['ほりえもん', '堀江貴文', 'takapon_jp'], ['堀江貴文', '堀江貴文', 'takapon_jp'],
  ])('maps only supported public aliases without inventing an affiliation: %s', (name, canonical, handle) => {
    const record = verifiedAliasForTarget({ personName: name, companyName: '' });
    expect(record?.target).toEqual({ personName: canonical, companyName: '' }); expect(record?.xHandle).toBe(handle);
    expect(record?.sourceUrls.length).toBeGreaterThan(1);
    expect(verifiedAliasForTarget({ personName: name, companyName: '知らない会社' })).toBeUndefined();
  });
  it('requires CURRENT names even with empty company and normalizes kana for unregistered names', () => {
    const publicTarget = { personName: '西村博之', companyName: '' };
    expect(isTargetGroundedInTranscript('ヒロユキについて', '', publicTarget)).toBe(true);
    expect(isTargetGroundedInTranscript('ありがとう', 'ひろゆきについて', publicTarget)).toBe(false);
    expect(isTargetGroundedInTranscript('あおい先生です', '', { personName: 'アオイ', companyName: '' })).toBe(true);
    expect(normalizeIdentity('ホリエモン')).toBe(normalizeIdentity('ほりえもん'));
    expect(verifiedAliasForTarget({ personName: '架空作家', companyName: '' })).toBeUndefined();
  });
  it('does not treat another account or video as the curated primary source', () => {
    const publicTarget = { personName: '西村博之', companyName: '' };
    expect(evidenceMatchesTarget('ひろゆきです。', publicTarget, 'https://x.com/hirox246')).toBe(true);
    expect(evidenceMatchesTarget('ひろゆきです。', publicTarget, 'https://x.com/another')).toBe(false);
    expect(isVerifiedPublicSource('https://x.com.evil.example/hirox246', publicTarget)).toBe(false);
    expect(isVerifiedPublicSource('https://www.youtube.com/watch?v=other', { personName: '堀江貴文', companyName: '' })).toBe(false);
  });
});

describe('catalog names stay separate from ASR corrections', () => {
  it.each(PUBLIC_FIGURE_CATALOG)('accepts the source-backed kana of $canonicalName without inventing an X account', record => {
    const companyName = record.id === 'madoka-chiyoda' ? 'Microsoft' : '';
    const alias = verifiedAliasForTarget({ personName: record.kana, companyName });
    expect(alias?.target).toEqual({ personName: record.canonicalName, companyName });
    expect(alias?.xHandle).toBe(record.xHandle);
    expect(isTargetGroundedInTranscript(`${record.kana}さんの話です。${companyName}`, '', alias!.target)).toBe(true);
  });

  it('never treats ASR homophones as verified names or current-transcript grounding', () => {
    const target = { personName: '西村博之', companyName: '' };
    expect(verifiedAliasForTarget({ personName: '広行', companyName: '' })).toBeUndefined();
    expect(verifiedAliasForInputTarget('広行さんの話題です', target)).toBeUndefined();
    expect(isTargetGroundedInTranscript('広行さんの話題です', 'ひろゆき', target)).toBe(false);
    expect(evidenceMatchesTarget('広行さんが公開イベントに登壇します。', target, 'https://modein.co.jp/corp/')).toBe(false);
    for (const record of PUBLIC_FIGURE_CATALOG) for (const spelling of record.commonASRHomophones) {
      expect(VERIFIED_IDENTITY_ALIASES.some(alias => alias.personNames.includes(spelling))).toBe(false);
    }
  });

  it('preserves the existing company-scoped Chomado rule', () => {
    expect(verifiedAliasForTarget({ personName: 'ちょまど', companyName: '' })).toBeUndefined();
    expect(verifiedAliasForTarget({ personName: 'ちよだまどか', companyName: 'Microsoft' })?.xHandle).toBe('chomado');
    expect(verifiedAliasForTarget({ personName: 'ちよだまどか', companyName: 'made in Japan' })).toBeUndefined();
  });

  it('does not grant unknown accounts or nonstandard ports to catalog entries', () => {
    const target = { personName: '孫正義', companyName: '' };
    expect(verifiedAliasForTarget(target)?.xHandle).toBeUndefined();
    expect(isVerifiedPublicSource('https://x.com/masason', target)).toBe(false);
    expect(isVerifiedPublicSource('https://group.softbank:444/about/officer/son', target)).toBe(false);
    expect(isVerifiedPublicSource('https://group.softbank/about/officer/son', target)).toBe(true);
    expect(evidenceMatchesTarget('Masayoshi Son', target, 'https://unrelated.example/profile')).toBe(false);
  });
});

describe('explicit source-backed company relationships', () => {
  const canonical = { personName: '西村博之', companyName: '株式会社made in Japan' };
  const sourceUrl = 'https://modein.co.jp/corp/';
  it.each(['株式会社メイドインジャパン', 'メイドインジャパン', 'made in Japan', '株式会社made in Japan'])(
    'keeps both identity and the requested company when canonicalizing %s', companyName => {
      const alias = verifiedAliasForTarget({ personName: 'ひろゆき', companyName });
      expect(alias?.target).toEqual(canonical);
      expect(alias?.sourceUrls[0]).toBe(sourceUrl);
      expect(verifiedAliasForInputTarget(`${companyName}のひろゆきさん`, canonical)?.target).toEqual(canonical);
      expect(evidenceMatchesTarget('株式会社made in Japan。代表取締役社長 西村博之。', { personName: '西村博之', companyName }, sourceUrl)).toBe(true);
    },
  );
  it('requires a company clue in the input and evidence, even on the approved domain', () => {
    expect(verifiedAliasForInputTarget('ひろゆきさん', canonical)).toBeUndefined();
    expect(verifiedAliasForInputTarget('別会社のひろゆきさん', canonical)).toBeUndefined();
    expect(isTargetGroundedInTranscript('ひろゆきさん', 'メイドインジャパンの話です', canonical)).toBe(true);
    expect(isTargetGroundedInTranscript('メイドインジャパンです', 'ひろゆきさん', canonical)).toBe(false);
    expect(isTargetGroundedInTranscript('ひろゆきさん', '別会社', canonical)).toBe(false);
    expect(evidenceMatchesTarget('西村博之は別会社の代表です。', canonical, sourceUrl)).toBe(false);
    expect(evidenceMatchesTarget('株式会社made in Japan。別人が代表です。', canonical, sourceUrl)).toBe(false);
    expect(evidenceMatchesTarget('ひろゆき。Notmade in Japanの代表です。', canonical, sourceUrl)).toBe(false);
    expect(verifiedAliasForTarget({ personName: 'ひろゆき', companyName: 'Microsoft' })).toBeUndefined();
    expect(verifiedAliasForTarget({ personName: 'ホリエモン', companyName: 'made in Japan' })).toBeUndefined();
  });
});
