import { TargetSchema, type Target } from '../src/shared/contracts.ts';
import { normalizeIdentity, VERIFIED_IDENTITY_ALIASES } from '../src/shared/identity-aliases.ts';
import { PUBLIC_FIGURE_CATALOG, type PublicFigureCatalogEntry } from '../src/shared/public-figure-catalog.ts';
import { LunaCorrectionSchema, type createLunaCorrection } from './luna-correction.ts';
import { ProviderError } from './provider-contract.ts';
import { BudgetError } from './budget.ts';

type Correction = ReturnType<typeof createLunaCorrection>;
export interface PersonResolution { target: Target | null; hint?: string; candidate?: Target; usedLuna: boolean; }
const normalizedName = (value: string) => normalizeIdentity(value).replace(/(?:さん|氏|様)$/u, '');
const publicNames = (entry: PublicFigureCatalogEntry) => [entry.canonicalName, entry.kana, ...entry.publicNames];
const sameName = (value: string, names: readonly string[]) => names.some(name => normalizedName(name) === normalizedName(value));

/** Return the actual spoken span, including case/kana differences, not a generated spelling. */
function literal(text: string, value: string): string | undefined {
  const needle = normalizedName(value); if (!needle) return undefined;
  let normalized = ''; const spans: { start: number; end: number }[] = []; let index = 0;
  for (const character of text) {
    const part = normalizeIdentity(character);
    for (let i = 0; i < part.length; i++) spans.push({ start: index, end: index + character.length });
    normalized += part; index += character.length;
  }
  let from = 0;
  while (from <= normalized.length) {
    const found = normalized.indexOf(needle, from); if (found < 0) return undefined;
    const start = spans[found]?.start; const end = spans[found + needle.length - 1]?.end;
    if (start !== undefined && end !== undefined && (!/^[a-z0-9]+$/u.test(needle) ||
        !/[a-z0-9]/iu.test(text[start - 1] ?? '') && !/[a-z0-9]/iu.test(text[end] ?? ''))) return text.slice(start, end);
    from = found + 1;
  }
  return undefined;
}

function companyNames(entry: PublicFigureCatalogEntry): string[] {
  const names = (entry.companyClues ?? []).flatMap(clue => [clue.name, ...clue.aliases]);
  for (const alias of VERIFIED_IDENTITY_ALIASES) {
    if (alias.scope === 'person-company' && alias.target.personName === entry.canonicalName) names.push(...alias.companyNames);
  }
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}
function companyClue(entry: PublicFigureCatalogEntry, current: string, previous: string): string {
  for (const text of [current, previous]) for (const name of companyNames(entry)) {
    const found = literal(text, name); if (found) return found;
  }
  return '';
}
function compatible(entry: PublicFigureCatalogEntry, company: string): boolean {
  return !!company && companyNames(entry).some(name => normalizeIdentity(name) === normalizeIdentity(company));
}
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length]!;
}

/** Bounded candidates from names/readings or corroborated company clues, never popularity. */
export function shortlistPersonCandidates(rawName: string, company = '', catalog = PUBLIC_FIGURE_CATALOG): PublicFigureCatalogEntry[] {
  const raw = normalizedName(rawName);
  if (raw.length < 2 || raw.length > 100) return [];
  return catalog.map(entry => {
    const exact = sameName(rawName, publicNames(entry));
    const declared = sameName(rawName, entry.commonASRHomophones);
    const readings = [entry.kana, ...entry.publicNames].map(normalizedName).filter(name => /^[ぁ-ゖー]+$/u.test(name));
    const near = /^[ぁ-ゖー]+$/u.test(raw) && raw.length >= 3 && readings.some(name => distance(raw, name) <= (Math.max(raw.length, name.length) >= 8 ? 2 : 1));
    const companyMatches = compatible(entry, company);
    return { entry, score: (exact ? 100 : declared ? 80 : near ? 60 : 0) + (companyMatches ? 30 : 0) };
  }).filter(value => value.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, 8).map(value => value.entry);
}

function observedEntries(current: string, homophonesOnly = false) {
  return PUBLIC_FIGURE_CATALOG.flatMap(entry => {
    const names = homophonesOnly ? entry.commonASRHomophones : [...publicNames(entry), ...entry.commonASRHomophones];
    const found = names.map(name => literal(current, name)).find(Boolean);
    return found ? [{ entry, literalName: found }] : [];
  });
}

export function extractHomophoneTarget(current: string, previous: string): Target | null {
  const observed = observedEntries(current, true);
  if (observed.length !== 1) return null;
  const selected = observed[0]!;
  return { personName: selected.literalName, companyName: companyClue(selected.entry, current, previous) };
}

const confirmation = (entry: PublicFigureCatalogEntry, company: string, usedLuna = false): PersonResolution => ({
  target: null, candidate: { personName: entry.canonicalName, companyName: company },
  hint: `「${entry.canonicalName}」の候補があります。名前と会社の手掛かりだけでは確定できないため、本人を確認してください。`, usedLuna,
});

/** Correction supplies a research target only; downstream source verification remains mandatory. */
export async function resolvePersonTarget(input: {
  currentTranscript: string; previousTranscript: string; target: Target | null; correct?: Correction;
}, signal: AbortSignal): Promise<PersonResolution> {
  signal.throwIfAborted();
  const current = input.currentTranscript.slice(0, 2000); const previous = input.previousTranscript.slice(-2000);
  let proposed = input.target;
  if (proposed === null) {
    const observed = observedEntries(current);
    if (observed.length !== 1) return { target: null, ...(observed.length ? { hint: '複数の人物名が聞こえました。調べる相手を確認してください。' } : {}), usedLuna: false };
    const selected = observed[0]!;
    proposed = { personName: selected.literalName, companyName: companyClue(selected.entry, current, previous) };
  }
  const parsed = TargetSchema.safeParse(proposed);
  if (!parsed.success) return { target: null, usedLuna: false };
  const original = parsed.data;
  if (/^(?:こんにちは|こんばんは|ありがとう(?:ございます)?|いい天気|あの人|その人|誰|名前)$/u.test(normalizedName(original.personName))) return { target: null, usedLuna: false };
  const namedEntry = PUBLIC_FIGURE_CATALOG.find(entry => sameName(original.personName, publicNames(entry)));
  const rawName = literal(current, original.personName) ?? (namedEntry ? [...publicNames(namedEntry), ...namedEntry.commonASRHomophones].map(name => literal(current, name)).find(Boolean) : undefined);
  if (!rawName) return { target: null, usedLuna: false };
  let company = original.companyName ? literal(current, original.companyName) ?? literal(previous, original.companyName) : '';
  if (original.companyName && !company) {
    if (namedEntry && compatible(namedEntry, original.companyName)) company = companyClue(namedEntry, current, previous);
    if (!company) return { target: null, usedLuna: false };
  }
  const rawTarget = { personName: rawName, companyName: company ?? '' };
  const shortlist = shortlistPersonCandidates(rawName, rawTarget.companyName);
  if (!shortlist.length) return { target: rawTarget, usedLuna: false };
  const exact = shortlist.filter(entry => sameName(rawName, publicNames(entry)));
  const declared = shortlist.filter(entry => sameName(rawName, entry.commonASRHomophones));
  const strong = exact.length ? exact : declared;
  if (strong.length === 1) {
    const entry = strong[0]!;
    if (rawTarget.companyName && !compatible(entry, rawTarget.companyName)) {
      return { target: rawTarget, candidate: { personName: entry.canonicalName, companyName: '' }, hint: '同音・別名の公開人物候補はありますが、会話で指定された会社と一致しません。入力された人物と会社をそのまま調べます。', usedLuna: false };
    }
    const clue = rawTarget.companyName || companyClue(entry, current, previous);
    if (exact.length || clue) return { target: { personName: entry.canonicalName, companyName: clue }, usedLuna: false,
      ...(normalizedName(rawName) !== normalizedName(entry.canonicalName) ? { hint: `「${rawName}」を${clue ? '会社名の手掛かり' : '確認済みの公開表記'}から「${entry.canonicalName}」の候補として調べます。` } : {}),
    };
    return confirmation(entry, '', false);
  }
  if (!input.correct) return confirmation(shortlist[0]!, rawTarget.companyName);
  // Keep the current utterance complete and only the literal company clue from old context.
  const recentTranscript = `${rawTarget.companyName ? `${rawTarget.companyName}\n` : ''}${current}`;
  let corrected;
  try {
    corrected = await input.correct({ recentTranscript, rawName, rawCompany: rawTarget.companyName,
      curatedCandidates: shortlist.map(entry => ({ publicFigureId: entry.id, canonicalName: entry.canonicalName,
        aliases: [...entry.publicNames, entry.kana, ...entry.commonASRHomophones].slice(0, 12),
        ...(compatible(entry, rawTarget.companyName) ? { companyName: rawTarget.companyName } : {}),
      })),
    }, signal);
  } catch (error) {
    if (signal.aborted || error instanceof BudgetError || error instanceof ProviderError && error.code === 'CANCELLED') throw error;
    return { ...confirmation(shortlist[0]!, rawTarget.companyName, true), hint: '人名の補正を確認できませんでした。候補を確認するか、名前を聞き直してください。' };
  }
  signal.throwIfAborted();
  const value = LunaCorrectionSchema.safeParse(corrected.value);
  if (!value.success) return confirmation(shortlist[0]!, rawTarget.companyName, true);
  const correction = value.data;
  const entry = shortlist.find(entry => entry.id === correction.publicFigureId && entry.canonicalName === correction.correctedName);
  if (!entry || correction.literalName !== rawName || !current.includes(correction.evidenceInTranscript) || !correction.evidenceInTranscript.includes(rawName)) return confirmation(shortlist[0]!, rawTarget.companyName, true);
  if (rawTarget.companyName && !compatible(entry, rawTarget.companyName)) return {
    target: rawTarget, candidate: { personName: entry.canonicalName, companyName: '' }, usedLuna: true,
    hint: '人名の補正候補と会話中の会社が一致しないため、人物と会社の入力を維持します。',
  };
  // Confidence alone never permits replacing a person's name.
  if (!correction.needsConfirmation && correction.confidence >= 0.9 && compatible(entry, rawTarget.companyName)) {
    return { target: { personName: entry.canonicalName, companyName: rawTarget.companyName }, usedLuna: true,
      hint: `「${rawName}」を会社名と音声補正から「${entry.canonicalName}」の候補として調べます。`,
    };
  }
  return confirmation(entry, rawTarget.companyName, true);
}
