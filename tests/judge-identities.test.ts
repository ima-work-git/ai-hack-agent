import { describe, expect, it } from 'vitest';
import { evidenceMatchesTarget, isTargetGroundedInTranscript, isVerifiedPublicSource, verifiedAliasForInputTarget, verifiedAliasForTarget, VERIFIED_IDENTITY_ALIASES } from '../src/shared/identity-aliases.ts';
import { VERIFIED_SOCIAL_IDENTITIES, verifiedSocialIdentityForTarget } from '../src/shared/social-accounts.ts';
import { PUBLIC_FIGURE_CATALOG } from '../src/shared/public-figure-catalog.ts';

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

  it('accepts primary-source readings, normalized kana, and published Latin names', () => {
    expect(verifiedAliasForTarget({ personName: 'イトウ カズナリさん', companyName: '' })?.xHandle).toBe('macopeninsutaba');
    expect(verifiedAliasForTarget({ personName: 'カズナリ', companyName: '' })?.target.personName).toBe('伊東和成');
    expect(verifiedAliasForTarget({ personName: 'Taishi Yamasaki', companyName: '' })?.xHandle).toBe('taishiyade');
    for (const personName of ['Taishi', 'たいし', 'タイシ', 'やまさきたいし', 'ヤマサキ タイシ']) {
      expect(verifiedAliasForTarget({ personName, companyName: '' })?.xHandle).toBe('taishiyade');
      expect(verifiedSocialIdentityForTarget({ personName, companyName: '' })?.id).toBe('taishi-yamasaki');
    }
    expect(verifiedAliasForTarget({ personName: 'うさみりょうじ', companyName: '' })?.xHandle).toBe('tre_conigli');
    expect(verifiedAliasForTarget({ personName: 'ウサミ リョウジ', companyName: '株式会社CyberACE' })?.target).toEqual({ personName: '宇佐美良治', companyName: '株式会社CyberACE' });
    for (const personName of ['やまざきたいし', 'Ryoji Usami', '伊藤和成', '知らない人物', 'かすなり', '数なり', 'かつなり']) {
      expect(verifiedAliasForTarget({ personName, companyName: '' })).toBeUndefined();
    }
    const alias = verifiedAliasForTarget({ personName: 'いとうかずなり', companyName: '' })!;
    expect(alias.sourceUrls).toContain('https://ai-reskilling.jp/');
    expect(verifiedAliasForInputTarget('NotTaishiYamasakiです', { personName: '山崎大志', companyName: '' })).toBeUndefined();
    expect(verifiedAliasForInputTarget('NotTaishiです', { personName: '山崎大志', companyName: '' })).toBeUndefined();
  });

  it('records primary reading evidence and separates product descriptions from companies', () => {
    expect(PUBLIC_FIGURE_CATALOG.find(record => record.id === 'kazunari-ito')).toMatchObject({
      kana: 'いとうかずなり', commonASRHomophones: ['かすなり', '数なり', 'かつなり'], asrCorrectionRequiresConfirmation: true,
      readingSourceUrl: 'https://ai-reskilling.jp/', readingBasis: 'kana-primary-source',
    });
    expect(PUBLIC_FIGURE_CATALOG.find(record => record.id === 'taishi-yamasaki')).toMatchObject({
      kana: 'やまさきたいし', readingSourceUrl: 'https://gist.github.com/Taishi-Y', readingBasis: 'romanized-primary-source',
    });
    expect(PUBLIC_FIGURE_CATALOG.find(record => record.id === 'tre-conigli')).toMatchObject({
      kana: 'うさみりょうじ', readingSourceUrl: 'https://www.wantedly.com/companies/company_5212273/post_articles/889192', readingBasis: 'kana-primary-source',
    });
    expect(verifiedAliasForTarget({ personName: 'Taishi', companyName: 'AI Language Learning App' })).toBeUndefined();
    expect(verifiedSocialIdentityForTarget({ personName: 'Taishi', companyName: 'AI Language Learning App' })).toBeUndefined();
    expect(VERIFIED_SOCIAL_IDENTITIES.some(record => ['kazunari-ito', 'tre-conigli'].includes(record.id))).toBe(false);
  });

  it.each([
    { personName: '伊東和成', companyName: 'サードスコープ', primary: 'https://third-scope.com/about/', accountLink: 'https://qiita.com/KNR109', reading: 'https://ai-reskilling.jp/' },
    { personName: '山崎大志', companyName: 'AlphaByte', primary: 'https://taishiyade.com/', accountLink: 'https://note.com/taishiyade/n/n64b013945dfc', reading: 'https://gist.github.com/Taishi-Y' },
  ])('keeps public activity and the self-published account link in the two-page allowance for $personName', ({ personName, companyName, primary, accountLink, reading }) => {
    for (const company of ['', companyName]) {
      const alias = verifiedAliasForTarget({ personName, companyName: company })!;
      expect(alias.sourceUrls.slice(0, 2)).toEqual([primary, accountLink]);
      expect(alias.sourceUrls.slice(2)).toContain(reading);
      expect(new Set(alias.sourceUrls).size).toBe(alias.sourceUrls.length);
    }
  });

  it('requires a short kana name boundary in speech and fetched evidence', () => {
    const target = { personName: '山崎大志', companyName: '' };
    for (const text of ['たいしたことないです', 'たいして変わらないです', 'これをしたいし、あれもしたい']) {
      expect(verifiedAliasForInputTarget(text, target)).toBeUndefined();
      expect(isTargetGroundedInTranscript(text, '', target)).toBe(false);
      expect(evidenceMatchesTarget(text, target, 'https://taishiyade.com/')).toBe(false);
    }
    for (const text of ['たいし', 'タイシさん', 'AlphaByteのたいしさん', 'たいしのアプリ', 'たいしです']) {
      expect(verifiedAliasForInputTarget(text, target)?.xHandle).toBe('taishiyade');
      expect(isTargetGroundedInTranscript(text, '', target)).toBe(true);
    }
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
