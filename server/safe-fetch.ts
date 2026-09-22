import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 8_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class SafeFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SafeFetchError';
  }
}

export interface ResolvedAddress { address: string; family: number }
export interface SafeResponse {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
export interface SafeRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Buffer | string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: readonly string[];
}
export interface SafeFetchDependencies {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: typeof http.request;
}

/** Accept globally routed addresses only, including after IPv4-mapped decoding. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%') || !ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv4') {
    // Some globally reachable anycast exceptions in these blocks are still not
    // needed for research. Deny the whole special-use block conservatively.
    const blocked = ['0.0.0.0/8', '100.64.0.0/10', '192.0.0.0/24',
      '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15',
      '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
    return !blocked.some((range) => parsed.match(ipaddr.parseCIDR(range)));
  }
  // Public IPv6 unicast is currently in 2000::/3. In particular, this excludes
  // local, mapped transition/NAT64 and unspecified address spaces.
  return parsed.match(ipaddr.parseCIDR('2000::/3')) &&
    !['2001::/23', '2001:db8::/32', '2002::/16', '3ffe::/16', '3fff::/20']
      .some((range) => parsed.match(ipaddr.parseCIDR(range)));
}

export function validatePublicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new SafeFetchError('UNSAFE_URL', 'URLの形式が不正です。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port !== '' && url.port !== '80' && url.port !== '443')) {
    throw new SafeFetchError('UNSAFE_URL', '公開HTTP(S)の許可されたURLだけを取得できます。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host.length > 253 || host.includes('%') ||
      /(^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(host) ||
      host.endsWith('.home.arpa') || (!isIP(host) && !host.includes('.')) ||
      (isIP(host) !== 0 && !isPublicAddress(host))) {
    throw new SafeFetchError('UNSAFE_ADDRESS', '内部・予約アドレスへの接続を拒否しました。');
  }
  url.hash = '';
  return url;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new SafeFetchError('ABORTED', '取得を中止しました。');
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

export async function resolvePublicTarget(
  url: URL,
  resolve: NonNullable<SafeFetchDependencies['resolve']> = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const literalFamily = isIP(host);
  let addresses: ResolvedAddress[];
  try { addresses = literalFamily ? [{ address: host, family: literalFamily }] : await resolve(host); }
  catch { throw new SafeFetchError('DNS_FAILED', '接続先の名前を解決できませんでした。'); }
  if (addresses.length === 0 || addresses.some(({ address, family }) =>
    !isPublicAddress(address) || isIP(address) !== family)) {
    throw new SafeFetchError('UNSAFE_ADDRESS', 'DNSに内部・予約アドレスが含まれるため取得しません。');
  }
  return addresses.find(({ family }) => family === 4) ?? addresses[0]!;
}

function requestOnce(
  url: URL, pinned: ResolvedAddress, options: SafeRequestOptions,
  signal: AbortSignal, maxBytes: number, dependency?: typeof http.request,
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: SafeResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(result!);
    };
    // The original hostname remains in Host/TLS SNI. Only the socket address is
    // pinned; http(s) must never resolve the name a second time after validation.
    const lookup: NonNullable<RequestOptions['lookup']> = (_hostname, lookupOptions, callback) => {
      if (typeof lookupOptions === 'object' && lookupOptions.all) {
        callback(null, [{ address: pinned.address, family: pinned.family }]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };
    const requester = dependency ?? (url.protocol === 'https:' ? https.request : http.request);
    const requestOptions: RequestOptions = {
      method: options.method ?? 'GET', agent: false, family: pinned.family,
      lookup, headers: { 'user-agent': 'AI-HACK-Research/0.1', 'accept-encoding': 'identity', ...options.headers },
    };
    let req: ReturnType<typeof http.request>;
    const onAbort = () => {
      const error = abortError(signal);
      req?.destroy(error);
      finish(error);
    };
    if (signal.aborted) { finish(abortError(signal)); return; }
    try {
      req = requester(url, requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        const response = { url: url.toString(), status, headers: res.headers };
        res.on('error', () => finish(new SafeFetchError('NETWORK_ERROR', '応答の読み取りに失敗しました。')));
        res.on('aborted', () => finish(new SafeFetchError('NETWORK_ERROR', '応答が途中で切断されました。')));
        if (REDIRECTS.has(status)) {
          finish(undefined, { ...response, body: Buffer.alloc(0) });
          res.destroy();
          return;
        }
        const encoding = res.headers['content-encoding'];
        if (encoding && encoding.toLowerCase() !== 'identity') {
          finish(new SafeFetchError('UNSUPPORTED_ENCODING', '圧縮応答はこの取得経路では利用できません。'));
          res.destroy();
          return;
        }
        const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (options.allowedContentTypes && !options.allowedContentTypes.includes(contentType)) {
          finish(new SafeFetchError('UNSUPPORTED_CONTENT', '対応していない応答形式です。'));
          res.destroy();
          return;
        }
        const declaredLength = Number(res.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          finish(new SafeFetchError('RESPONSE_TOO_LARGE', '応答が取得上限を超えています。'));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > maxBytes) {
            finish(new SafeFetchError('RESPONSE_TOO_LARGE', '応答が取得上限を超えています。'));
            res.destroy();
            req.destroy();
          } else { chunks.push(bytes); }
        });
        res.on('end', () => finish(undefined, { ...response, body: Buffer.concat(chunks) }));
      });
      req.on('error', () => finish(signal.aborted ? abortError(signal) : new SafeFetchError('NETWORK_ERROR', '接続に失敗しました。')));
      signal.addEventListener('abort', onAbort, { once: true });
      if (options.body) req.write(options.body);
      req.end();
    } catch {
      finish(new SafeFetchError('NETWORK_ERROR', '接続に失敗しました。'));
    }
  });
}

/** DNS + all redirects + response share one hard deadline. No cookies or auth forwarding. */
export async function safeRequest(
  input: string, options: SafeRequestOptions = {}, dependencies: SafeFetchDependencies = {},
): Promise<SafeResponse> {
  for (const limit of [options.timeoutMs, options.maxBytes, options.maxRedirects]) {
    if (limit !== undefined && (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
      throw new SafeFetchError('INVALID_LIMIT', '取得上限は有限の非負整数で指定してください。');
    }
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(new SafeFetchError('TIMEOUT', '取得が8秒以内に完了しませんでした。')), timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES));
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 3, 3));
  try {
    let url = validatePublicUrl(input);
    for (let redirects = 0; ; redirects += 1) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const pinned = await withAbort(resolvePublicTarget(url, dependencies.resolve), controller.signal);
      const result = await requestOnce(url, pinned, options, controller.signal, maxBytes, dependencies.request);
      if (!REDIRECTS.has(result.status)) return result;
      if (redirects >= maxRedirects || options.method === 'POST' || options.headers &&
          Object.keys(options.headers).some((key) => ['authorization', 'cookie'].includes(key.toLowerCase()))) {
        throw new SafeFetchError('REDIRECT_REJECTED', 'このリクエストの転送は許可されていません。');
      }
      const location = result.headers.location;
      if (!location) throw new SafeFetchError('INVALID_REDIRECT', '転送先がありません。');
      let destination: URL;
      try { destination = new URL(location, url); }
      catch { throw new SafeFetchError('INVALID_REDIRECT', '転送先の形式が不正です。'); }
      url = validatePublicUrl(destination.toString());
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
