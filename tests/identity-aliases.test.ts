import { describe, expect, it } from 'vitest';
import { evidenceMatchesTarget, verifiedAliasForInputTarget, verifiedAliasForTarget } from '../src/shared/identity-aliases.ts';

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
