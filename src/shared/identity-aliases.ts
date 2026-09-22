import type { Target } from './contracts.ts';

/** Curated identity links, never model-generated aliases or proof of a new fact.
 * Adding a record requires checking public primary sources and explicit scope.
 * The Japanese corporate name below is also historical; do not infer current
 * legal-entity employment from this identity mapping.
 */
export const VERIFIED_IDENTITY_ALIASES = [{
  id: 'madoka-chiyoda-chomado',
  target: { personName: '千代田まどか', companyName: 'Microsoft' },
  personNames: ['千代田まどか', 'Madoka Chiyoda', 'ちょまど', 'Chomado'],
  companyNames: ['Microsoft', 'マイクロソフト', '日本マイクロソフト'],
  xHandle: 'chomado',
  checkedOn: '2026-09-22',
  sourceUrls: ['https://chomado.com/', 'https://chomado.com/chomado/', 'https://developer.microsoft.com/ja-jp/advocates/madoka-chiyoda'],
}] as const;
export type VerifiedIdentityAlias = typeof VERIFIED_IDENTITY_ALIASES[number];

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja');
const personName = (value: string) => normalize(value).replace(/(?:さん|氏|様)$/, '');
const listed = (value: string, names: readonly string[]) => names.some(name => normalize(name) === normalize(value));
function contains(text: string, name: string): boolean {
  const haystack = normalize(text); const needle = normalize(name);
  // Latin aliases must be whole names, not substrings of another identity.
  if (/^[a-z0-9]+$/.test(needle)) return new RegExp(`(^|[^a-z0-9])${Array.from(needle).join('\\s*')}(?=$|[^a-z0-9])`, 'u').test(text.normalize('NFKC').toLocaleLowerCase('ja'));
  return haystack.includes(needle);
}

export function verifiedAliasForTarget(target: Target): VerifiedIdentityAlias | undefined {
  const matches = VERIFIED_IDENTITY_ALIASES.filter(record => listed(personName(target.personName), record.personNames) && listed(target.companyName, record.companyNames));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Both names must be in the user's input; a handle or a nickname alone is insufficient. */
export function verifiedAliasForInputTarget(text: string, target: Target): VerifiedIdentityAlias | undefined {
  const record = verifiedAliasForTarget(target);
  return record && record.personNames.some(name => contains(text, name)) && record.companyNames.some(name => contains(text, name)) ? record : undefined;
}

/** Necessary source co-occurrence only. Attribution and ambiguity still require assessment. */
export function evidenceMatchesTarget(text: string, target: Target): boolean {
  const record = verifiedAliasForTarget(target);
  if (record) return record.personNames.some(name => contains(text, name)) && record.companyNames.some(name => contains(text, name));
  return [target.personName, target.companyName].every(name => Boolean(normalize(name)) && normalize(text).includes(normalize(name)));
}
