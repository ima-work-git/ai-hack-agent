import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EvidenceSourceSchema, type EvidenceSource, type Target } from '../src/shared/contracts.ts';
import { verifiedSocialIdentityForTarget, type VerifiedSocialAccount, type VerifiedSocialIdentity } from '../src/shared/social-accounts.ts';
import { ProviderError, type ProviderResult } from './provider-contract.ts';

const API_ORIGIN = 'https://api.apify.com';
const MAX_JSON_BYTES = 2_000_000;
const MAX_POSTS = 3;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const STATUS = new Set(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED']);
const ACTORS = {
  instagram: { id: 'apify~instagram-scraper', fields: 'inputUrl,url,caption,timestamp,ownerUsername',
    input: (url: string) => ({ directUrls: [url], resultsType: 'posts', resultsLimit: MAX_POSTS, addParentData: false }) },
  facebook: { id: 'apify~facebook-posts-scraper', fields: 'inputUrl,facebookUrl,url,time,pageName,text',
    input: (url: string) => ({ startUrls: [{ url }], resultsLimit: MAX_POSTS, captionText: false }) },
} as const;

export interface SocialProvider {
  hasTarget(target: Target): boolean;
  lookupPlatform(target: Target, platform: VerifiedSocialAccount['platform'], signal: AbortSignal): Promise<ProviderResult<EvidenceSource[]>>;
  lookup(target: Target, signal: AbortSignal): Promise<ProviderResult<EvidenceSource[]>>;
}
export interface SocialProviderDependencies {
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** May reduce the production maximum (32), principally for eviction tests. */
  cacheMaximumEntries?: number;
}
interface Run { id: string; status: string; defaultDatasetId?: string; usageTotalUsd?: number }
interface ActorResult { source?: EvidenceSource; reportedUsd?: number }
interface CacheEntry { expiresAt: number; value: EvidenceSource[]; expiry?: ReturnType<typeof setTimeout> }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function invalid(): never { throw new ProviderError('INVALID_SOCIAL_RESPONSE', '追加SNSの応答を検証できませんでした。'); }
function runData(value: unknown, expectedId?: string): Run {
  const data = object(object(value)?.data);
  if (!data || !identifier(data.id) || (expectedId && expectedId !== data.id) || typeof data.status !== 'string' || !STATUS.has(data.status)) invalid();
  return { id: data.id, status: data.status, ...(identifier(data.defaultDatasetId) ? { defaultDatasetId: data.defaultDatasetId } : {}),
    ...(amount(data.usageTotalUsd) ? { usageTotalUsd: data.usageTotalUsd } : {}) };
}

function socialUrl(raw: unknown, platform: VerifiedSocialAccount['platform']): URL | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return;
  try {
    const url = new URL(raw);
    const hosts = platform === 'instagram' ? ['instagram.com', 'www.instagram.com'] : ['facebook.com', 'www.facebook.com', 'm.facebook.com'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) return;
    url.hostname = platform === 'instagram' ? 'www.instagram.com' : 'www.facebook.com';
    url.hash = '';
    return url;
  } catch { return; }
}
function profileMatches(raw: unknown, account: VerifiedSocialAccount): boolean {
  const url = socialUrl(raw, account.platform);
  return Boolean(url && url.pathname.replace(/\/$/, '').toLowerCase() === `/${account.handle.toLowerCase()}`);
}
function postUrl(raw: unknown, account: VerifiedSocialAccount): string | undefined {
  const url = socialUrl(raw, account.platform);
  if (!url) return;
  if (account.platform === 'instagram') {
    if (!/^\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return;
    url.search = '';
  } else {
    const parts = url.pathname.split('/').filter(Boolean);
    const owned = parts.length === 3 && parts[0]?.toLowerCase() === account.handle.toLowerCase() &&
      ['posts', 'videos'].includes(parts[1]!) && /^[A-Za-z0-9_-]+$/.test(parts[2]!);
    const reel = /^\/reel\/\d+\/?$/.test(url.pathname);
    const permalink = url.pathname === '/permalink.php' && /^\d+$/.test(url.searchParams.get('id') ?? '') && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('story_fbid') ?? '');
    if (!owned && !reel && !permalink) return;
    const kept = new URLSearchParams();
    if (permalink) { kept.set('id', url.searchParams.get('id')!); kept.set('story_fbid', url.searchParams.get('story_fbid')!); }
    url.search = kept.toString();
  }
  return url.toString();
}

function newestSource(items: unknown, identity: VerifiedSocialIdentity, account: VerifiedSocialAccount, now: Date): EvidenceSource | undefined {
  if (!Array.isArray(items) || items.length > MAX_POSTS) invalid();
  const sources: EvidenceSource[] = [];
  for (const item of items) {
    const raw = object(item);
    if (!raw) continue;
    const author = account.platform === 'instagram' ? raw.ownerUsername : raw.pageName;
    const text = account.platform === 'instagram' ? raw.caption : raw.text;
    const date = account.platform === 'instagram' ? raw.timestamp : raw.time;
    const url = postUrl(raw.url, account);
    // The actor is called with exactly one known profile. It must independently
    // return that author's handle; request URL or post URL alone is insufficient.
    if (typeof author !== 'string' || author.toLowerCase() !== account.handle.toLowerCase() || typeof text !== 'string' ||
      !text.trim() || text.length > 30_000 || typeof date !== 'string' || !url) continue;
    const provenance = [raw.inputUrl, raw.facebookUrl].filter(value => value !== undefined && value !== null);
    if (provenance.some(value => !profileMatches(value, account))) continue;
    const timestamp = Date.parse(date);
    if (!Number.isFinite(timestamp) || timestamp > now.getTime()) continue;
    const createdAt = new Date(timestamp).toISOString();
    const value = EvidenceSourceSchema.safeParse({
      sourceId: `src-${createHash('sha256').update(url).digest('hex').slice(0, 20)}`, url,
      title: `${identity.canonicalName} — ${account.platform === 'instagram' ? 'Instagram' : 'Facebook'} 公開投稿（${createdAt.slice(0, 10)}）`,
      retrievedAt: now.toISOString(), kind: account.platform, topic: account.platform,
      text: `公開プロフィール: ${identity.canonicalName} (@${account.handle})\n公開投稿: ${text}`,
      socialPost: { platform: account.platform, authorHandle: account.handle, profileUrl: account.profileUrl, identitySourceUrl: account.identitySourceUrl, createdAt, text },
    });
    if (value.success) sources.push(value.data);
  }
  return sources.sort((a, b) => b.socialPost!.createdAt.localeCompare(a.socialPost!.createdAt))[0];
}

/** Bounded server-only public data adapter. It never uses social login cookies,
 * follows redirects, receives arbitrary actor IDs, or resolves arbitrary URLs. */
export function createSocialProvider(config: { apiToken: string; maximumChargeUsd?: number }, dependencies: SocialProviderDependencies = {}): SocialProvider {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); });
  const maximum = config.maximumChargeUsd ?? 0.20;
  if (!config.apiToken.trim() || !Number.isFinite(maximum) || maximum <= 0 || maximum > 0.20) throw new Error('Invalid social provider configuration');
  const requestedCapacity = dependencies.cacheMaximumEntries ?? 32;
  const capacity = Number.isFinite(requestedCapacity) ? Math.max(1, Math.min(32, Math.floor(requestedCapacity))) : 32;
  const cache = new Map<string, CacheEntry>();
  const deleteCached = (key: string) => {
    const entry = cache.get(key);
    if (entry?.expiry) clearTimeout(entry.expiry);
    cache.delete(key);
  };

  async function api(path: string, signal: AbortSignal, body?: unknown, timeoutMs = 8_000): Promise<unknown> {
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/v2/') || url.searchParams.has('token')) invalid();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      combined.throwIfAborted();
      const response = await request(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${config.apiToken}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderError(response.status === 429 ? 'SOCIAL_RATE_LIMITED' : 'SOCIAL_UNAVAILABLE', '追加SNSを現在取得できません。'); }
      if (Number(response.headers.get('content-length')) > MAX_JSON_BYTES) { await response.body?.cancel(); invalid(); }
      if (!response.body) invalid();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const onAbort = () => { void reader.cancel().catch(() => {}); };
      combined.addEventListener('abort', onAbort, { once: true });
      try {
        while (true) {
          combined.throwIfAborted();
          const { done, value } = await reader.read();
          combined.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_JSON_BYTES) { await reader.cancel(); invalid(); }
          chunks.push(value);
        }
      } finally { combined.removeEventListener('abort', onAbort); reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { invalid(); }
    } finally { clearTimeout(timer); }
  }

  async function run(identity: VerifiedSocialIdentity, account: VerifiedSocialAccount, signal: AbortSignal): Promise<ActorResult> {
    let active: Run | undefined;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 75_000);
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      combined.throwIfAborted();
      const actor = ACTORS[account.platform];
      const query = new URLSearchParams({ timeout: '60', maxItems: String(MAX_POSTS), maxTotalChargeUsd: String(Math.min(0.10, maximum / 2)), restartOnError: 'false', waitForFinish: '0' });
      // Await run creation even on cancellation so its returned ID can be aborted.
      // An uncertain POST is never retried; its remote 60-second timeout remains.
      const created = await api(`/v2/actors/${actor.id}/runs?${query}`, new AbortController().signal, actor.input(account.profileUrl));
      const raw = object(object(created)?.data);
      if (raw && identifier(raw.id)) active = { id: raw.id, status: 'RUNNING' };
      active = runData(created);
      combined.throwIfAborted();
      while (!TERMINAL.has(active.status)) {
        await sleep(1500, combined);
        combined.throwIfAborted();
        active = runData(await api(`/v2/actor-runs/${active.id}`, combined), active.id);
      }
      if (active.status !== 'SUCCEEDED') return { ...(active.usageTotalUsd !== undefined ? { reportedUsd: active.usageTotalUsd } : {}) };
      if (!active.defaultDatasetId) invalid();
      const params = new URLSearchParams({ format: 'json', clean: 'true', limit: String(MAX_POSTS), fields: actor.fields });
      const items = await api(`/v2/datasets/${active.defaultDatasetId}/items?${params}`, combined);
      return { source: newestSource(items, identity, account, now()), ...(active.usageTotalUsd !== undefined ? { reportedUsd: active.usageTotalUsd } : {}) };
    } catch {
      return { ...(active?.usageTotalUsd !== undefined ? { reportedUsd: active.usageTotalUsd } : {}) };
    } finally {
      clearTimeout(timer);
      if (active && !TERMINAL.has(active.status)) {
        // Fresh bounded signal: an already-cancelled request must still stop the
        // paid remote work. Await cleanup rather than detach it from the request.
        try { await api(`/v2/actor-runs/${active.id}/abort?gracefully=false`, new AbortController().signal, {}, 5_000); } catch { /* Server timeout and charge cap still apply if cancellation is unconfirmed. */ }
      }
    }
  }

  const lookupPlatform: SocialProvider['lookupPlatform'] = async (target, platform, signal) => {
      signal.throwIfAborted();
      const identity = verifiedSocialIdentityForTarget(target);
      const account = identity?.accounts.find(value => value.platform === platform);
      if (!identity || !account) return { value: [], actualUsd: 0 };
      const clock = now().getTime();
      for (const [key, entry] of cache) if (entry.expiresAt <= clock) deleteCached(key);
      const key = `${identity.id}:${platform}`;
      const existing = cache.get(key);
      if (existing) { cache.delete(key); cache.set(key, existing); return { value: structuredClone(existing.value), actualUsd: 0 }; }
      const outcome = await run(identity, account, signal);
      signal.throwIfAborted();
      const value = outcome.source ? [outcome.source] : [];
      const ttl = value.length ? 300_000 : 30_000;
      const entry: CacheEntry = { value: structuredClone(value), expiresAt: now().getTime() + ttl };
      deleteCached(key);
      cache.set(key, entry);
      entry.expiry = setTimeout(() => { if (cache.get(key) === entry) deleteCached(key); }, ttl);
      entry.expiry.unref();
      while (cache.size > capacity) deleteCached(cache.keys().next().value!);
      return { value, ...(outcome.reportedUsd !== undefined ? { reportedUsd: outcome.reportedUsd } : {}) };
  };
  return {
    hasTarget: target => Boolean(verifiedSocialIdentityForTarget(target)),
    lookupPlatform,
    async lookup(target, signal) {
      // Wait for every platform's cancellation cleanup before surfacing abort.
      const settled = await Promise.allSettled((['instagram', 'facebook'] as const).map(platform => lookupPlatform(target, platform, signal)));
      signal.throwIfAborted();
      const outcomes = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const reports = outcomes.flatMap(outcome => outcome.reportedUsd === undefined ? [] : [outcome.reportedUsd]);
      return { value: outcomes.flatMap(outcome => outcome.value),
        ...(outcomes.length === 2 && outcomes.every(outcome => outcome.actualUsd === 0) ? { actualUsd: 0 } : {}),
        ...(reports.length ? { reportedUsd: reports.reduce((sum, item) => sum + item, 0) } : {}) };
    },
  };
}
