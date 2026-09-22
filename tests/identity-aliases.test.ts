import { describe, expect, it } from 'vitest';
import { evidenceMatchesTarget, isTargetGroundedInTranscript, isVerifiedPublicSource, normalizeIdentity, verifiedAliasForInputTarget, verifiedAliasForTarget } from '../src/shared/identity-aliases.ts';

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
