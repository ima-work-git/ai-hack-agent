// Only the public endpoint record is fetched. QR credentials never leave the fragment
// until the final, validated destination redeems them through its own same-origin API.
export const ENDPOINT_API = 'https://api.github.com/repos/ima-work-git/ai-hack-agent/contents/endpoint.json';
const MAX_RESPONSE_BYTES = 32_768;
const MAX_ENDPOINT_BYTES = 2_048;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN = /^[a-f0-9]{64}$/;
const ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function readLoginFragment(hash) {
  if (typeof hash !== 'string' || !/^#login=[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_QR');
  return hash.slice(7);
}

function timestamp(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) throw new Error('INVALID_ENDPOINT');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('INVALID_ENDPOINT');
  return time;
}

export function validateEndpoint(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'expiresAt,origin,updatedAt,version'
    || value.version !== 1 || typeof value.origin !== 'string' || !ORIGIN.test(value.origin)
    || !Number.isFinite(now)) throw new Error('INVALID_ENDPOINT');
  const updatedAt = timestamp(value.updatedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (expiresAt <= updatedAt || updatedAt > now + 60_000) throw new Error('INVALID_ENDPOINT');
  if (expiresAt <= now) throw new Error('EXPIRED_ENDPOINT');
  return { version: 1, origin: value.origin, updatedAt: value.updatedAt, expiresAt: value.expiresAt };
}

export function destinationFor(endpoint, ticket, now = Date.now()) {
  const checked = validateEndpoint(endpoint, now);
  if (typeof ticket !== 'string' || !TOKEN.test(ticket)) throw new Error('INVALID_QR');
  // Incoming query parameters, paths and alternate destinations are never forwarded.
  return `${checked.origin}/?conversation=1#login=${ticket}`;
}

async function limitedJson(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error('INVALID_RESPONSE');
  }
  if (!response.body) throw new Error('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('INVALID_RESPONSE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function decodeContents(value) {
  if (!value || value.type !== 'file' || value.encoding !== 'base64'
    || value.name !== 'endpoint.json' || value.path !== 'endpoint.json'
    || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_ENDPOINT_BYTES
    || typeof value.content !== 'string' || value.content.length > MAX_ENDPOINT_BYTES * 2) {
    throw new Error('INVALID_RESPONSE');
  }
  const encoded = value.content.replace(/\n/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('INVALID_RESPONSE');
  }
  const raw = atob(encoded);
  if (raw.length !== value.size || raw.length > MAX_ENDPOINT_BYTES) throw new Error('INVALID_RESPONSE');
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function fetchEndpoint(fetcher = globalThis.fetch, now = Date.now) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(ENDPOINT_API);
    url.searchParams.set('ref', 'live-endpoint');
    url.searchParams.set('_timestamp', String(now()));
    const response = await fetcher(url.href, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('ENDPOINT_UNAVAILABLE'); }
    return validateEndpoint(decodeContents(await limitedJson(response)), now());
  } finally { clearTimeout(timeout); }
}

export function createLauncher({ hash, clearUrl, replace, onState, fetcher = globalThis.fetch, now = Date.now }) {
  let ticket = '';
  let busy = false;
  try { ticket = readLoginFragment(hash); } catch { /* Show a fixed message, never the supplied fragment. */ }
  // Remove the credential from this history entry before any outbound request.
  try { clearUrl(); } catch { ticket = ''; }

  async function retry() {
    if (busy) return;
    if (!ticket) { onState('invalid-qr'); return; }
    busy = true;
    onState('loading');
    try {
      const endpoint = await fetchEndpoint(fetcher, now);
      const destination = destinationFor(endpoint, ticket, now());
      onState('opening');
      replace(destination);
    } catch {
      busy = false;
      onState('unavailable');
    }
  }
  return { retry, ready: retry() };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const status = document.getElementById('launch-status');
  const help = document.getElementById('launch-help');
  const retry = document.getElementById('launch-retry');
  if (status && help && retry) {
    const launcher = createLauncher({
      hash: window.location.hash,
      clearUrl: () => window.history.replaceState(null, '', window.location.pathname),
      replace: destination => window.location.replace(destination),
      onState: state => {
        const messages = {
          loading: '接続先を確認しています。',
          opening: '接続しています。',
          unavailable: '接続先を確認できませんでした。',
          'invalid-qr': '利用するQRコードをもう一度読み取ってください。',
        };
        status.textContent = messages[state];
        help.textContent = 'PCの起動とネット接続を確認してください。';
        retry.disabled = state !== 'unavailable';
      },
    });
    retry.addEventListener('click', () => { void launcher.retry(); });
  }
}
