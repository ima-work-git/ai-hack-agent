import { XPostSchema, type Card, type CardTopic, type EvidenceSource, type Target } from './contracts.ts';
import { evidenceMatchesTarget, normalizeIdentity, verifiedAliasForTarget } from './identity-aliases.ts';

/** Only the trusted adapter's source classification controls the displayed label. */
export const sourceTopic = (source: EvidenceSource): CardTopic => source.topic ?? 'profile';

function postId(source: EvidenceSource): string | undefined {
  if (source.kind !== 'x') return undefined;
  if (source.xPost) return source.xPost.id;
  try {
    const url = new URL(source.url);
    if (!['x.com', 'twitter.com'].includes(url.hostname.toLowerCase())) return undefined;
    return /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,25})\/?$/u.exec(url.pathname)?.[1];
  } catch { return undefined; }
}

/** Input cards must already pass evidence verification. Never manufacture a missing category. */
export function selectBalancedCards<T extends Pick<Card, 'sourceId' | 'fact'>>(cards: T[], sources: EvidenceSource[]): Array<T & { topic: CardTopic }> {
  const sourceMap = new Map(sources.map(source => [source.sourceId, source]));
  const candidates = cards.flatMap(card => {
    const source = sourceMap.get(card.sourceId);
    return source ? [{ card: { ...card, topic: sourceTopic(source) }, source }] : [];
  });
  const selected: Array<T & { topic: CardTopic }> = []; const facts = new Set<string>(); const posts = new Set<string>();
  const add = (candidate: typeof candidates[number]): boolean => {
    const fact = normalizeIdentity(candidate.card.fact); const post = postId(candidate.source);
    if (selected.length >= 4 || !fact || facts.has(fact) || post && posts.has(post)) return false;
    selected.push(candidate.card); facts.add(fact); if (post) posts.add(post); return true;
  };
  for (const [topic, wanted] of [['recent_x', 2], ['popular_x', 1], ['profile', 1]] as const) {
    let count = 0;
    for (const candidate of candidates) {
      if (count >= wanted) break;
      if (candidate.card.topic === topic && add(candidate)) count++;
    }
  }
  for (const candidate of candidates) { if (selected.length >= 4) break; add(candidate); }
  return selected;
}

function aliasInExcerpt(excerpt: string, names: readonly string[]): boolean {
  const normalized = normalizeIdentity(excerpt);
  return names.some(name => {
    const needle = normalizeIdentity(name); if (!needle) return false;
    if (/^[a-z0-9]+$/u.test(needle)) {
      return new RegExp(`(^|[^a-z0-9])${Array.from(needle).join('\\s*')}(?=$|[^a-z0-9])`, 'u').test(excerpt.normalize('NFKC').toLocaleLowerCase('ja'));
    }
    return normalized.includes(needle);
  });
}

/** A known account's post can use separate web evidence of its author's company.
 * The provider must first bind authorId to the fetched username; metadata alone
 * is not a new account mapping. Fact/excerpt inclusion remains the caller's check.
 */
export function evidenceMatchesCard(excerpt: string, target: Target, source: EvidenceSource, sources: EvidenceSource[]): boolean {
  if (evidenceMatchesTarget(excerpt, target, source.url)) return true;
  if (source.kind !== 'x') return false;
  const parsed = XPostSchema.safeParse(source.xPost);
  const alias = verifiedAliasForTarget(target);
  if (!parsed.success || !alias?.xHandle || alias.xHandle.toLowerCase() !== parsed.data.username.toLowerCase()) return false;
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['x.com', 'twitter.com'].includes(url.hostname.toLowerCase())) return false;
    const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/u.exec(url.pathname);
    if (!match || match[1]!.toLowerCase() !== parsed.data.username.toLowerCase() || match[2] !== parsed.data.id) return false;
  } catch { return false; }
  if (!aliasInExcerpt(excerpt, alias.personNames)) return false;
  return sources.some(other => other.sourceId !== source.sourceId && other.kind === 'web' && evidenceMatchesTarget(other.text, target, other.url));
}
