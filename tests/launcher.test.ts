import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
// @ts-expect-error The standalone launcher is browser JavaScript, without a build step.
import { createLauncher, destinationFor, ENDPOINT_API, fetchEndpoint, readLoginFragment, validateEndpoint } from '../launcher/launch.mjs';

const NOW = Date.UTC(2026, 8, 23, 3);
const TICKET = 'a'.repeat(64); // Synthetic format-only credential; never a real grant.
const ORIGIN = 'https://fixture-chat-master.trycloudflare.com';
const endpoint = (overrides = {}) => ({
  version: 1, origin: ORIGIN,
  updatedAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 600_000).toISOString(), ...overrides,
});
function contents(value: unknown = endpoint(), overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { type: 'file', name: 'endpoint.json', path: 'endpoint.json', encoding: 'base64',
    size: bytes.length, content: bytes.toString('base64').replace(/.{60}/g, '$&\n'), ...overrides };
}
function response(value: unknown = endpoint(), overrides = {}) {
  return new Response(JSON.stringify(contents(value, overrides)), { headers: { 'content-type': 'application/json' } });
}
afterEach(() => { vi.useRealTimers(); });

describe('fixed QR launcher destination restrictions', () => {
  it('accepts only one exact lowercase-hex login fragment', () => {
    expect(readLoginFragment(`#login=${TICKET}`)).toBe(TICKET);
    for (const hash of ['', `login=${TICKET}`, `#login=${TICKET.toUpperCase()}`, '#login=short',
      `#login=${TICKET}&login=${TICKET}`, `#login=${TICKET}&next=https://example.com`,
      `#other=1&login=${TICKET}`, `#login=%61${TICKET.slice(1)}`, `#login=${TICKET}\n`]) {
      expect(() => readLoginFragment(hash)).toThrow();
    }
  });

  it('forwards only conversation=1 and the validated fragment to the exact approved origin', () => {
    expect(destinationFor(endpoint(), TICKET, NOW)).toBe(`${ORIGIN}/?conversation=1#login=${TICKET}`);
    expect(() => destinationFor(endpoint(), `${TICKET}&next=evil`, NOW)).toThrow();
  });

  it.each([
    'http://fixture.trycloudflare.com', 'https://fixture.trycloudflare.com/',
    'https://fixture.trycloudflare.com/path', 'https://fixture.trycloudflare.com?next=evil',
    'https://fixture.trycloudflare.com#secret', 'https://user@fixture.trycloudflare.com',
    'https://fixture.trycloudflare.com:443', 'https://fixture.trycloudflare.com.evil.test',
    'https://evil.test/fixture.trycloudflare.com', 'https://nested.fixture.trycloudflare.com',
    'https://Fixture.trycloudflare.com', 'https://-fixture.trycloudflare.com',
    'javascript:alert(1)', '//fixture.trycloudflare.com', 'https://localhost',
    `https://${'a'.repeat(64)}.trycloudflare.com`,
  ])('rejects unapproved or non-origin destination %s', origin => {
    expect(() => validateEndpoint(endpoint({ origin }), NOW)).toThrow();
  });

  it('rejects extra fields, wrong versions, expired endpoints and invalid timestamp ordering', () => {
    for (const value of [null, [], { ...endpoint(), secret: TICKET }, endpoint({ version: '1' }),
      endpoint({ version: 2 }), endpoint({ expiresAt: new Date(NOW).toISOString() }),
      endpoint({ expiresAt: new Date(NOW - 120_000).toISOString() }),
      endpoint({ updatedAt: new Date(NOW + 60_001).toISOString() }),
      endpoint({ updatedAt: '2026-02-30T00:00:00.000Z' }), endpoint({ updatedAt: NOW }),
      endpoint({ expiresAt: '2026-09-24T12:00:00Z' })]) {
      expect(() => validateEndpoint(value, NOW)).toThrow();
    }
    expect(validateEndpoint(endpoint(), NOW)).toEqual(endpoint());
  });
});

describe('public GitHub endpoint retrieval', () => {
  it('makes exactly one credential-free request to a fixed branch and decodes its base64 contents', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    expect(await fetchEndpoint(fetcher, () => NOW)).toEqual(endpoint());
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${ENDPOINT_API}?ref=live-endpoint&_timestamp=${NOW}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/vnd.github+json' } });
    expect(JSON.stringify([url, init])).not.toContain(TICKET);
  });

  it('rejects invalid API contents, API failures and destinations that expire during retrieval', async () => {
    for (const overrides of [{ type: 'symlink' }, { encoding: 'none' }, { name: 'other.json' },
      { path: 'other/endpoint.json' }, { size: 2_049 }, { size: 0 }, { size: 3 },
      { content: 'bad?base64' }, { content: 'a'.repeat(4_097) }]) {
      await expect(fetchEndpoint(vi.fn().mockResolvedValue(response(endpoint(), overrides)), () => NOW)).rejects.toThrow();
    }
    await expect(fetchEndpoint(vi.fn().mockResolvedValue(new Response('{}', { status: 404 })), () => NOW)).rejects.toThrow();
    const now = vi.fn().mockReturnValueOnce(NOW).mockReturnValue(NOW + 600_000);
    await expect(fetchEndpoint(vi.fn().mockResolvedValue(response()), now)).rejects.toThrow('EXPIRED_ENDPOINT');
  });

  it('bounds both advertised and streamed response sizes and cancels an oversized body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32_769)); }, cancel,
    });
    await expect(fetchEndpoint(vi.fn().mockResolvedValue(new Response(body)), () => NOW)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    await expect(fetchEndpoint(vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'content-length': '32769' },
    })), () => NOW)).rejects.toThrow();
  });

  it('aborts a stalled request and does not poll or retry it automatically', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = expect(fetchEndpoint(fetcher, () => NOW)).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('launcher recovery and secret handling', () => {
  it('clears the original URL before fetching and performs only a top-level replacement', async () => {
    const actions: string[] = [];
    const replace = vi.fn();
    const fetcher = vi.fn(async () => { actions.push('fetch'); return response(); });
    const onState = vi.fn();
    const launcher = createLauncher({ hash: `#login=${TICKET}`, now: () => NOW, fetcher, replace,
      clearUrl: () => actions.push('clear'), onState });
    await launcher.ready;
    expect(actions).toEqual(['clear', 'fetch']);
    expect(replace).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/?conversation=1#login=${TICKET}`);
    expect(onState.mock.calls.flat()).toEqual(['loading', 'opening']);
    expect(JSON.stringify(onState.mock.calls)).not.toContain(TICKET);
    await launcher.retry();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('requires a valid QR and successful URL cleanup before requesting any endpoint', async () => {
    for (const hash of ['', `#login=${TICKET}&next=evil`]) {
      const fetcher = vi.fn(); const replace = vi.fn(); const onState = vi.fn();
      const launcher = createLauncher({ hash, fetcher, replace, onState, clearUrl: vi.fn() });
      await launcher.ready;
      expect(fetcher).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
      expect(onState).toHaveBeenLastCalledWith('invalid-qr');
    }
    const fetcher = vi.fn();
    await createLauncher({ hash: `#login=${TICKET}`, fetcher, replace: vi.fn(), onState: vi.fn(),
      clearUrl: () => { throw new Error('history unavailable'); } }).ready;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains the credential only in memory for manual recovery from expiry or connection failures', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(endpoint({ expiresAt: new Date(NOW).toISOString() })))
      .mockResolvedValueOnce(response());
    const replace = vi.fn(); const onState = vi.fn(); const clearUrl = vi.fn();
    const launcher = createLauncher({ hash: `#login=${TICKET}`, now: () => NOW, fetcher, replace, onState, clearUrl });
    await launcher.ready;
    expect(replace).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith('unavailable');
    await launcher.retry();
    expect(clearUrl).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/?conversation=1#login=${TICKET}`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('offers manual retry after a synchronous navigation failure without reflecting its details', async () => {
    const replace = vi.fn().mockImplementationOnce(() => { throw new Error(TICKET); });
    const onState = vi.fn();
    const launcher = createLauncher({ hash: `#login=${TICKET}`, now: () => NOW,
      fetcher: vi.fn().mockImplementation(() => response()), replace, onState, clearUrl: vi.fn() });
    await launcher.ready;
    expect(onState).toHaveBeenLastCalledWith('unavailable');
    expect(JSON.stringify(onState.mock.calls)).not.toContain(TICKET);
    await launcher.retry();
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it('ships only local scripts/styles, a GitHub-only connection policy, and clear recovery guidance', async () => {
    const html = await readFile(new URL('../launcher/index.html', import.meta.url), 'utf8');
    const script = await readFile(new URL('../launcher/launch.mjs', import.meta.url), 'utf8');
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain("script-src 'self'; style-src 'self'; connect-src https://api.github.com;");
    expect(html).toContain('src="./launch.mjs"'); expect(html).toContain('href="./style.css"');
    expect(html).toContain('PCの起動とネット接続を確認'); expect(html).toContain('再確認');
    expect(html).not.toMatch(/\bon\w+=|http-equiv="refresh"/);
    expect([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].every(match => match[1]!.trim() === '')).toBe(true);
    expect(script).not.toMatch(/localStorage|sessionStorage|document\.cookie|setInterval|console\./);
    expect(html + script).not.toContain(TICKET);
  });
});
