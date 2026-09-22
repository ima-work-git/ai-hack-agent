import type { Target } from './contracts.ts';
import { PUBLIC_FIGURE_CATALOG } from './public-figure-catalog.ts';

/** Only canonical names, published names and source-backed readings enter this
 * identity layer. ASR correction hints are deliberately not imported as aliases.
 * Company clues describe a verified relationship, not proof of current employment.
 */
export interface VerifiedIdentityAlias {
  readonly id: string;
  readonly scope: 'person-company' | 'public-person';
  readonly target: Target;
  readonly personNames: readonly string[];
  readonly companyNames: readonly string[];
  readonly xHandle?: string;
  readonly checkedOn: string;
  readonly sourceUrls: readonly string[];
}

const companyAliases: readonly VerifiedIdentityAlias[] = [{
  id: 'madoka-chiyoda-chomado', scope: 'person-company',
  target: { personName: '千代田まどか', companyName: 'Microsoft' },
  personNames: ['千代田まどか', 'ちよだまどか', 'Madoka Chiyoda', 'ちょまど', 'Chomado'],
  companyNames: ['Microsoft', 'マイクロソフト', '日本マイクロソフト'],
  xHandle: 'chomado', checkedOn: '2026-09-22',
  sourceUrls: ['https://chomado.com/', 'https://chomado.com/chomado/', 'https://developer.microsoft.com/ja-jp/advocates/madoka-chiyoda'],
}];

const existingPublicSources: Readonly<Record<string, readonly string[]>> = {
  'hiroyuki-nishimura': ['https://guild.to/', 'https://guild.to/news/弊社のメンバー達がノンタイトルで激突すること/', 'https://shueisha.online/list/persons/65a92f368ce1158c700000ca'],
  'takafumi-horie': ['https://snsgroup.jp/', 'https://zeroichi.media/', 'https://columbia.jp/artist-info/horiemon/prof.html', 'https://www.youtube.com/watch?v=uFkcC8UYQy4'],
  // The two-page follow-up allowance must include the public activity profile
  // and the self-published account link; reading references remain available later.
  'kazunari-ito': ['https://third-scope.com/about/', 'https://qiita.com/KNR109'],
  'taishi-yamasaki': ['https://taishiyade.com/', 'https://note.com/taishiyade/n/n64b013945dfc'],
  'tre-conigli': ['https://cyberace.co.jp/event/2259/', 'https://zenn.dev/tre_conigli', 'https://code-agents.connpass.com/event/342240/'],
};
const unique = (values: readonly string[]) => [...new Set(values)];
const catalogAliases: VerifiedIdentityAlias[] = PUBLIC_FIGURE_CATALOG.flatMap(record => {
  // A primary-source public identity can be researched without an employer.
  // Keep company-scoped records separate: this adds no affiliation and never
  // changes which supplied company/name pairs the existing records accept.
  const personNames = unique([record.canonicalName, record.kana, ...record.publicNames]);
  const sourceUrls = unique([...(existingPublicSources[record.id] ?? []), record.officialProfileUrl, ...(record.readingSourceUrl ? [record.readingSourceUrl] : []), ...(record.xHandleSourceUrl ? [record.xHandleSourceUrl] : [])]);
  const common = { scope: 'public-person' as const, personNames, ...(record.xHandle ? { xHandle: record.xHandle } : {}), checkedOn: record.checkedOn };
  return [{ ...common, id: record.id, target: { personName: record.canonicalName, companyName: '' }, companyNames: [], sourceUrls },
    ...(record.companyClues ?? []).map((company, index) => ({
      ...common, id: `${record.id}-company-${index + 1}`,
      target: { personName: record.canonicalName, companyName: company.name },
      companyNames: unique([company.name, ...company.aliases]),
      // Fetch this relationship's primary text first within the existing allowance.
      sourceUrls: unique([company.sourceUrl, ...sourceUrls]),
    })),
  ];
});

export const VERIFIED_IDENTITY_ALIASES: readonly VerifiedIdentityAlias[] = [...companyAliases, ...catalogAliases];

export const normalizeIdentity = (value: string) => value.normalize('NFKC').replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60)).replace(/\s+/g, '').toLocaleLowerCase('ja');
const normalize = normalizeIdentity;
const personName = (value: string) => normalize(value).replace(/(?:さん|氏|様)$/, '');
const listed = (value: string, names: readonly string[]) => names.some(name => normalize(name) === normalize(value));

/** Validate a name match at UTF-16 offsets in the supplied text. Short kana
 * names also occur inside everyday words, e.g. たいし in たいしたことない. */
export function isIdentityNameSpan(text: string, name: string, start: number, end: number): boolean {
  const needle = personName(name);
  if (/^@?[a-z0-9_]+$/u.test(needle)) {
    const before = (text[start - 1] ?? '').normalize('NFKC').toLowerCase();
    const after = (text[end] ?? '').normalize('NFKC').toLowerCase();
    return !/[a-z0-9_]/u.test(before) && !/[a-z0-9_]/u.test(after);
  }
  const before = normalize(text.slice(0, start)).at(-1) ?? '';
  const after = normalize(text.slice(end));
  if (/^[ぁ-ゖー]{2,3}$/u.test(needle)) {
    if (/[ぁ-ゖー]/u.test(before) && !/[のはがをにとで]/u.test(before)) return false;
    if (/^[ぁ-ゖー]/u.test(after) && !/^(?:さん|さま|くん|ちゃん|です|は|が|を|に|の|と|で)/u.test(after)) return false;
  }
  return true;
}

function contains(text: string, name: string): boolean {
  const haystack = normalize(text); const needle = normalize(name);
  if (!needle) return false;
  // Latin aliases must be whole names, not substrings of another identity.
  if (/^[a-z0-9]+$/.test(needle)) return new RegExp(`(^|[^a-z0-9])${Array.from(needle).join('\\s*')}(?=$|[^a-z0-9])`, 'u').test(text.normalize('NFKC').toLocaleLowerCase('ja'));
  let from = 0;
  while (from <= haystack.length) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) return false;
    if (isIdentityNameSpan(haystack, needle, found, found + needle.length)) return true;
    from = found + 1;
  }
  return false;
}

export function verifiedAliasForTarget(target: Target): VerifiedIdentityAlias | undefined {
  const matches = VERIFIED_IDENTITY_ALIASES.filter(record => listed(personName(target.personName), record.personNames) &&
    (record.target.companyName ? listed(target.companyName, record.companyNames) : !target.companyName.trim()));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Any company-bearing alias needs both supplied clues; empty-company aliases never invent one. */
export function verifiedAliasForInputTarget(text: string, target: Target): VerifiedIdentityAlias | undefined {
  const record = verifiedAliasForTarget(target);
  return record && record.personNames.some(name => contains(text, name)) &&
    (!record.target.companyName || record.companyNames.some(name => contains(text, name))) ? record : undefined;
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
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port) return false;
    if (['x.com', 'twitter.com'].includes(candidate.hostname)) return !!record.xHandle && candidate.pathname.split('/')[1]?.toLowerCase() === record.xHandle;
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
    (!record.target.companyName || record.companyNames.some(name => contains(text, name))) &&
    (isVerifiedPublicSource(sourceUrl ?? '', target) || contains(text, record.target.personName));
  if (record) return record.personNames.some(name => contains(text, name)) && record.companyNames.some(name => contains(text, name));
  if (!target.companyName.trim()) return contains(text, target.personName);
  return [target.personName, target.companyName].every(name => Boolean(normalize(name)) && normalize(text).includes(normalize(name)));
}
