import { z } from 'zod';
import { TargetSchema, type Target } from './contracts.ts';
import { isIdentityNameSpan, normalizeIdentity, VERIFIED_IDENTITY_ALIASES } from './identity-aliases.ts';
import { PUBLIC_FIGURE_CATALOG, type PublicFigureCatalogEntry } from './public-figure-catalog.ts';

export const SearchCandidateSchema = z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(300),
  query: z.string().min(1).max(300), target: TargetSchema,
}).strict();
export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;

interface SearchCandidateInput {
  targets: readonly Target[];
  /** Only this utterance can supply a person's name. */
  transcript: string;
  /** Previous speech may corroborate a company, never introduce a person. */
  companyContext?: string;
  catalog?: readonly PublicFigureCatalogEntry[];
}
interface Seed { target: Target; correction: boolean; }
const normalizeName = (value: string) => normalizeIdentity(value).replace(/(?:さん|氏|様)$/u, '');
const sameName = (value: string, names: readonly string[]) => names.some(name => normalizeName(value) === normalizeName(name));
const namesFor = (entry: PublicFigureCatalogEntry) => [entry.canonicalName, entry.kana, ...entry.publicNames, ...(entry.xHandle ? [entry.xHandle, `@${entry.xHandle}`] : [])].filter(Boolean);
const unsuitableName = /^(?:こんにちは|こんばんは|ありがとう(?:ございます)?|いい天気|あの人|その人|誰|名前)$/u;

/** Find an actual span, preserving Latin word boundaries before space removal. */
function literal(text: string, name: string): string | undefined {
  const needle = normalizeName(name); if (!needle) return;
  let normalized = ''; let offset = 0;
  const spans: Array<{ start: number; end: number }> = [];
  for (const character of text) {
    const part = normalizeIdentity(character);
    for (let i = 0; i < part.length; i++) spans.push({ start: offset, end: offset + character.length });
    normalized += part; offset += character.length;
  }
  let from = 0;
  while (from <= normalized.length) {
    const found = normalized.indexOf(needle, from); if (found < 0) return;
    const start = spans[found]?.start; const end = spans[found + needle.length - 1]?.end;
    if (start !== undefined && end !== undefined && isIdentityNameSpan(text, name, start, end)) return text.slice(start, end);
    from = found + 1;
  }
  return;
}
function companiesFor(entry: PublicFigureCatalogEntry): string[] {
  return [...new Set([
    ...(entry.companyClues ?? []).flatMap(company => [company.name, ...company.aliases]),
    ...VERIFIED_IDENTITY_ALIASES.filter(alias => alias.target.personName === entry.canonicalName).flatMap(alias => alias.companyNames),
  ])].sort((a, b) => b.length - a.length);
}
function observedCompany(entry: PublicFigureCatalogEntry, current: string, context: string): string {
  for (const text of [current, context]) for (const name of companiesFor(entry)) {
    const match = literal(text, name); if (match) return match;
  }
  return '';
}
function nearName(raw: string, entry: PublicFigureCatalogEntry): boolean {
  const name = normalizeName(raw);
  // Very short aliases such as たいし are too close to ordinary words; only
  // exact, boundary-checked aliases or declared ASR variants may propose them.
  if (!/^[ぁ-ゖー]{4,100}$/u.test(name)) return false;
  return namesFor(entry).map(normalizeName).filter(value => /^[ぁ-ゖー]{4,100}$/u.test(value)).some(value => {
    const limit = Math.max(value.length, name.length) >= 8 ? 2 : 1;
    if (Math.abs(value.length - name.length) > limit) return false;
    let previous = Array.from({ length: value.length + 1 }, (_, index) => index);
    for (let i = 1; i <= name.length; i++) {
      const row = [i];
      for (let j = 1; j <= value.length; j++) row[j] = Math.min(row[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + Number(name[i - 1] !== value[j - 1]));
      previous = row;
    }
    return previous[value.length]! <= limit;
  });
}
const quote = (value: string) => `"${value.normalize('NFKC').replace(/["\\\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()}"`;
const queryFor = (target: Target) => [quote(target.personName), ...(target.companyName ? [quote(target.companyName)] : [])].join(' ');
const labelFor = (seed: Seed) => `${seed.target.personName}${seed.target.companyName ? ` / ${seed.target.companyName}` : ''}${seed.correction ? '（補正候補・要確認）' : ''}`;
function stableId(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 0x01000193); }
  return `search-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Search options only, never verified identities. Selection must be resolved
 * against the server's stored options, not a client-supplied target or query. */
export function buildSearchCandidates(input: SearchCandidateInput): SearchCandidate[] {
  const current = input.transcript.slice(0, 2000); const context = (input.companyContext ?? '').slice(-2000);
  if (!current.trim()) return [];
  const catalog = (input.catalog ?? PUBLIC_FIGURE_CATALOG).slice(0, 256);
  const seeds: Seed[] = []; const seedKeys = new Set<string>();
  const addSeed = (target: Target, correction: boolean) => {
    const key = `${normalizeName(target.personName)}|${normalizeIdentity(target.companyName)}`;
    if (seedKeys.has(key)) return;
    seedKeys.add(key); seeds.push({ target: { ...target }, correction });
  };
  const raw: Target[] = [];
  for (const proposed of input.targets.slice(0, 8)) {
    const parsed = TargetSchema.safeParse(proposed); if (!parsed.success) continue;
    const target = parsed.data;
    if (normalizeName(target.personName).length < 2 || unsuitableName.test(normalizeName(target.personName))) continue;
    const record = catalog.find(entry => sameName(target.personName, namesFor(entry)));
    const direct = literal(current, target.personName);
    const publicMention = record && namesFor(record).some(name => literal(current, name));
    const homophone = record && record.commonASRHomophones.find(name => literal(current, name));
    if (!direct && !publicMention && !homophone) continue;
    const companySpoken = !target.companyName || literal(current, target.companyName) || literal(context, target.companyName) ||
      record && companiesFor(record).some(name => normalizeIdentity(name) === normalizeIdentity(target.companyName)) && observedCompany(record, current, context);
    if (!companySpoken) continue;
    raw.push(target);
    if (!direct && !publicMention && homophone) addSeed({ personName: literal(current, homophone)!, companyName: target.companyName }, false);
    addSeed(target, !direct && !publicMention);
  }
  // Prefer explicit public names, then declared homophones, then bounded kana
  // corrections of a name actually supplied by the current identification.
  const matches = catalog.map(entry => {
    const exact = namesFor(entry).some(name => literal(current, name));
    const declared = entry.commonASRHomophones.some(name => literal(current, name));
    const near = raw.some(target => literal(current, target.personName) && nearName(target.personName, entry));
    return { entry, score: exact ? 3 : declared ? 2 : near ? 1 : 0 };
  }).filter(match => match.score).sort((a, b) => b.score - a.score);
  for (const { entry, score } of matches) {
    const relevant = raw.filter(target => sameName(target.personName, [...namesFor(entry), ...entry.commonASRHomophones]) || nearName(target.personName, entry));
    const suppliedCompany = relevant.find(target => target.companyName)?.companyName;
    // Do not attach a famous candidate to a different, explicitly supplied employer.
    if (suppliedCompany && !companiesFor(entry).some(name => normalizeIdentity(name) === normalizeIdentity(suppliedCompany))) continue;
    addSeed({ personName: entry.canonicalName, companyName: suppliedCompany ?? observedCompany(entry, current, context) }, score < 3);
  }
  const candidates: SearchCandidate[] = []; const keys = new Set<string>();
  const append = (seed: Seed, suffix = '', target = seed.target) => {
    if (candidates.length >= 4) return;
    const query = `${queryFor(target)}${suffix ? ` ${suffix}` : ''}`;
    const key = JSON.stringify([target.personName, target.companyName, query]);
    if (keys.has(key)) return;
    const baseId = stableId(key); let id = baseId; let serial = 1;
    while (candidates.some(candidate => candidate.id === id)) id = `${baseId}-${serial++}`;
    const candidate = SearchCandidateSchema.safeParse({ id, query, target,
      label: `${labelFor({ ...seed, target })}${suffix ? `｜${suffix}` : target.companyName !== seed.target.companyName ? '｜所属を外して検索' : ''}` });
    if (!candidate.success) return;
    keys.add(key); candidates.push(candidate.data);
  };
  for (const seed of seeds) append(seed);
  for (const seed of seeds) if (seed.target.companyName) append(seed, '', { ...seed.target, companyName: '' });
  for (const suffix of ['公式プロフィール', '公開活動 登壇']) for (const seed of seeds) append(seed, suffix);
  return candidates;
}
