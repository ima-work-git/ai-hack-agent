import { describe, expect, it } from 'vitest';
import { evidenceMatchesTarget, isTargetGroundedInTranscript, isVerifiedPublicSource, verifiedAliasForInputTarget, verifiedAliasForTarget, VERIFIED_IDENTITY_ALIASES } from '../src/shared/identity-aliases.ts';
import { VERIFIED_SOCIAL_IDENTITIES } from '../src/shared/social-accounts.ts';

const judges = [
  { input: '山崎 大志さん', canonical: '山崎大志', handle: 'taishiyade', company: 'AlphaByte', canonicalCompany: '株式会社AlphaByte', source: 'https://taishiyade.com/' },
  { input: '宇佐美 良治さん', canonical: '宇佐美良治', handle: 'tre_conigli', company: 'CyberACE', canonicalCompany: '株式会社CyberACE', source: 'https://cyberace.co.jp/event/2259/' },
  { input: 'かずなりさん', canonical: '伊東和成', handle: 'macopeninsutaba', company: 'サードスコープ', canonicalCompany: '株式会社サードスコープ', source: 'https://third-scope.com/about/' },
  { input: 'チョマドさん', canonical: '千代田まどか', handle: 'chomado', company: 'マイクロソフト', canonicalCompany: 'Microsoft', source: 'https://chomado.com/chomado/' },
];

describe('source-backed judge identities', () => {
  it.each(judges)('selects $handle without inventing a company from a companyless input', judge => {
    const target = { personName: judge.input, companyName: '' };
    const alias = verifiedAliasForTarget(target);
    expect(alias).toMatchObject({ scope: 'public-person', target: { personName: judge.canonical, companyName: '' }, xHandle: judge.handle });
    expect(alias?.sourceUrls).toContain(judge.source);
    expect(verifiedAliasForInputTarget(`${judge.input}の話題について`, alias!.target)?.xHandle).toBe(judge.handle);
    expect(isTargetGroundedInTranscript(`${judge.input}の話題です。`, '', alias!.target)).toBe(true);
    expect(isVerifiedPublicSource(`https://x.com/${judge.handle}/status/123`, target)).toBe(true);
    expect(isVerifiedPublicSource('https://x.com/unrelated/status/123', target)).toBe(false);
  });

  it.each(judges)('needs both person and company clues for $handle when company is explicit', judge => {
    const target = { personName: judge.input, companyName: judge.company };
    const alias = verifiedAliasForTarget(target);
    expect(alias?.target).toEqual({ personName: judge.canonical, companyName: judge.canonicalCompany });
    expect(verifiedAliasForInputTarget(`${judge.company}の${judge.input}`, alias!.target)?.xHandle).toBe(judge.handle);
    expect(verifiedAliasForInputTarget(`${judge.input}の話題です`, alias!.target)).toBeUndefined();
    expect(isTargetGroundedInTranscript(`${judge.input}の話題です`, `所属は${judge.company}です`, alias!.target)).toBe(true);
    expect(isTargetGroundedInTranscript('この製品について', `${judge.company}の${judge.input}`, alias!.target)).toBe(false);
    expect(verifiedAliasForTarget({ ...target, companyName: '知らない別会社' })).toBeUndefined();
  });

  it('preserves the exact checked Taishi aliases in the social registry and does not reuse the old X handle', () => {
    const social = VERIFIED_SOCIAL_IDENTITIES.find(record => record.id === 'taishi-yamasaki')!;
    const alias = verifiedAliasForTarget({ personName: social.canonicalName, companyName: '' })!;
    expect(alias.personNames).toEqual(social.personNames);
    expect(alias.xHandle).toBe('taishiyade');
    expect(alias.sourceUrls).toContain('https://note.com/taishiyade/n/n64b013945dfc');
    expect(isVerifiedPublicSource('https://x.com/taishi_jade', alias.target)).toBe(false);
    for (const personName of social.personNames) expect(verifiedAliasForTarget({ personName, companyName: '' })?.id).toBe(alias.id);
    for (const companyName of social.companyNames) expect(verifiedAliasForTarget({ personName: social.canonicalName, companyName })?.xHandle).toBe('taishiyade');
  });

  it('accepts only primary-source readings, normalized kana, and full published Latin names', () => {
    expect(verifiedAliasForTarget({ personName: 'イトウ カズナリさん', companyName: '' })?.xHandle).toBe('macopeninsutaba');
    expect(verifiedAliasForTarget({ personName: 'カズナリ', companyName: '' })?.target.personName).toBe('伊東和成');
    expect(verifiedAliasForTarget({ personName: 'Taishi Yamasaki', companyName: '' })?.xHandle).toBe('taishiyade');
    for (const personName of ['Taishi', 'やまさきたいし', 'やまざきたいし', 'うさみりょうじ', '伊藤和成', '知らない人物']) {
      expect(verifiedAliasForTarget({ personName, companyName: '' })).toBeUndefined();
    }
    const alias = verifiedAliasForTarget({ personName: 'いとうかずなり', companyName: '' })!;
    expect(alias.sourceUrls).toContain('https://ai-reskilling.jp/');
    expect(verifiedAliasForInputTarget('NotTaishiYamasakiです', { personName: '山崎大志', companyName: '' })).toBeUndefined();
  });

  it('requires fetched name/company evidence and rejects an unrelated account with an alias mention', () => {
    const target = { personName: '山崎大志', companyName: 'AlphaByte' };
    expect(evidenceMatchesTarget('山崎大志 AlphaByte', target, 'https://taishiyade.com/')).toBe(true);
    expect(evidenceMatchesTarget('山崎大志の個人プロフィール', target, 'https://taishiyade.com/')).toBe(false);
    expect(evidenceMatchesTarget('taishiyade AlphaByte', target, 'https://x.com/unrelated')).toBe(false);
    expect(isVerifiedPublicSource('https://taishiyade.com.evil.test/', target)).toBe(false);
    expect(isVerifiedPublicSource('https://x.com/MacopeninSUTABA', { personName: '伊東和成', companyName: '' })).toBe(true);
  });

  it('adds no duplicate identity lookup entries', () => {
    expect(new Set(VERIFIED_IDENTITY_ALIASES.map(alias => alias.id)).size).toBe(VERIFIED_IDENTITY_ALIASES.length);
    for (const judge of judges) {
      const alias = verifiedAliasForTarget({ personName: judge.canonical, companyName: '' });
      expect(alias).toBeDefined();
      expect(verifiedAliasForTarget(alias!.target)?.id).toBe(alias!.id);
    }
  });
});
