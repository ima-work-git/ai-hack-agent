import type { Target } from './contracts.ts';

/** Curated identity links, never model-generated aliases or proof of a new fact.
 * Adding a record requires checking public primary sources and explicit scope.
 * The Japanese corporate name below is also historical; do not infer current
 * legal-entity employment from this identity mapping.
 */
export const VERIFIED_IDENTITY_ALIASES = [{
  id: 'madoka-chiyoda-chomado',
  scope: 'person-company',
  target: { personName: '千代田まどか', companyName: 'Microsoft' },
  personNames: ['千代田まどか', 'Madoka Chiyoda', 'ちょまど', 'Chomado'],
  companyNames: ['Microsoft', 'マイクロソフト', '日本マイクロソフト'],
  xHandle: 'chomado',
  checkedOn: '2026-09-22',
  sourceUrls: ['https://chomado.com/', 'https://chomado.com/chomado/', 'https://developer.microsoft.com/ja-jp/advocates/madoka-chiyoda'],
}, {
  id: 'hiroyuki-nishimura', scope: 'public-person',
  target: { personName: '西村博之', companyName: '' },
  personNames: ['西村博之', 'ひろゆき', 'Hiroyuki Nishimura'], companyNames: [],
  xHandle: 'hirox246', checkedOn: '2026-09-22',
  sourceUrls: ['https://guild.to/', 'https://guild.to/news/弊社のメンバー達がノンタイトルで激突すること/', 'https://shueisha.online/list/persons/65a92f368ce1158c700000ca'],
}, {
  id: 'takafumi-horie', scope: 'public-person',
  target: { personName: '堀江貴文', companyName: '' },
  personNames: ['堀江貴文', 'ホリエモン', 'Takafumi Horie'], companyNames: [],
  xHandle: 'takapon_jp', checkedOn: '2026-09-22',
  sourceUrls: ['https://snsgroup.jp/', 'https://zeroichi.media/', 'https://columbia.jp/artist-info/horiemon/prof.html', 'https://www.youtube.com/watch?v=uFkcC8UYQy4'],
}] as const;
export type VerifiedIdentityAlias = typeof VERIFIED_IDENTITY_ALIASES[number];

export const normalizeIdentity = (value: string) => value.normalize('NFKC').replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60)).replace(/\s+/g, '').toLocaleLowerCase('ja');
const normalize = normalizeIdentity;
const personName = (value: string) => normalize(value).replace(/(?:さん|氏|様)$/, '');
const listed = (value: string, names: readonly string[]) => names.some(name => normalize(name) === normalize(value));
function contains(text: string, name: string): boolean {
  const haystack = normalize(text); const needle = normalize(name);
  if (!needle) return false;
  // Latin aliases must be whole names, not substrings of another identity.
  if (/^[a-z0-9]+$/.test(needle)) return new RegExp(`(^|[^a-z0-9])${Array.from(needle).join('\\s*')}(?=$|[^a-z0-9])`, 'u').test(text.normalize('NFKC').toLocaleLowerCase('ja'));
  return haystack.includes(needle);
}

export function verifiedAliasForTarget(target: Target): VerifiedIdentityAlias | undefined {
  const matches = VERIFIED_IDENTITY_ALIASES.filter(record => listed(personName(target.personName), record.personNames) &&
    (record.scope === 'public-person' ? !target.companyName.trim() : listed(target.companyName, record.companyNames)));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Company-linked aliases need both clues; public-person aliases never invent a company. */
export function verifiedAliasForInputTarget(text: string, target: Target): VerifiedIdentityAlias | undefined {
  const record = verifiedAliasForTarget(target);
  return record && record.personNames.some(name => contains(text, name)) &&
    (record.scope === 'public-person' || record.companyNames.some(name => contains(text, name))) ? record : undefined;
}

/** A current person name is mandatory. Context may only supply a company clue.
 * Missing company permits research, not identity confirmation. */
export function isTargetGroundedInTranscript(current: string, context: string, target: Target): boolean {
  const alias = verifiedAliasForTarget(target);
  const personPresent = alias ? alias.personNames.some(name => contains(current, name)) : contains(current, target.personName);
  if (!personPresent) return false;
  if (!target.companyName.trim()) return true;
  const combined = `${current}\n${context}`;
  return alias ? alias.companyNames.some(name => contains(combined, name)) : contains(combined, target.companyName);
}

/** A curated account/domain helps match a known public identity; other figures
 * can be discovered through primary-source assessment without registration. */
export function isVerifiedPublicSource(url: string, target: Target): boolean {
  const record = verifiedAliasForTarget(target);
  if (record?.scope !== 'public-person') return false;
  try {
    const candidate = new URL(url);
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password) return false;
    if (['x.com', 'twitter.com'].includes(candidate.hostname)) return candidate.pathname.split('/')[1]?.toLowerCase() === record.xHandle;
    return record.sourceUrls.some(value => {
      const verified = new URL(value);
      return candidate.hostname === verified.hostname && (verified.pathname === '/' || candidate.pathname === verified.pathname && (!verified.search || candidate.search === verified.search));
    });
  } catch { return false; }
}

/** Necessary source co-occurrence only. Attribution and ambiguity still require assessment. */
export function evidenceMatchesTarget(text: string, target: Target, sourceUrl?: string): boolean {
  const record = verifiedAliasForTarget(target);
  if (record?.scope === 'public-person') return record.personNames.some(name => contains(text, name)) &&
    (isVerifiedPublicSource(sourceUrl ?? '', target) || contains(text, record.target.personName));
  if (record) return record.personNames.some(name => contains(text, name)) && record.companyNames.some(name => contains(text, name));
  if (!target.companyName.trim()) return contains(text, target.personName);
  return [target.personName, target.companyName].every(name => Boolean(normalize(name)) && normalize(text).includes(normalize(name)));
}
