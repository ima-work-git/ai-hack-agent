import { EventEmitter } from 'node:events';
import http, { type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { isPublicAddress, resolvePublicTarget, safeRequest, validatePublicUrl } from '../server/safe-fetch.ts';

type Reply = { status?: number; headers?: IncomingHttpHeaders; body?: string; stall?: boolean };
function transport(replies: Reply[]) {
  const calls: { url: URL; options: RequestOptions }[] = [];
  const request = ((url: URL, options: RequestOptions, callback: (res: unknown) => void) => {
    calls.push({ url, options });
    const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const reply = replies[calls.length - 1] ?? {};
      const res = Object.assign(new PassThrough(), {
        statusCode: reply.status ?? 200,
        headers: reply.headers ?? { 'content-type': 'text/plain' },
      });
      callback(res);
      if (!reply.stall) res.end(reply.body ?? 'public evidence');
    });
    return req;
  }) as unknown as typeof http.request;
  return { calls, request };
}
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

describe('public destination restrictions', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.31.0.1', '192.168.1.1',
    '169.254.169.254', '100.100.100.200', '192.0.0.8', '192.0.2.1', '198.18.0.1',
    '198.51.100.4', '203.0.113.7', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::a00:1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fe80::1%en0', '4000::1', '2001:20::1', '3fff::1', '3ffe::1', 'invalid'])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('allows global unicast %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['file:///etc/passwd', 'ftp://site.example.org/file', 'https://user:pass@site.example.org',
    'https://site.example.org:8080', 'http://127.1', 'http://2130706433', 'http://0x7f000001',
    'http://[::ffff:127.0.0.1]', 'http://localhost.', 'http://metadata.google.internal', 'http://intranet'])('rejects unsafe URL %s', (url) => {
    expect(() => validatePublicUrl(url)).toThrow();
  });

  it('rejects a DNS answer when any address is non-public, not just the chosen address', async () => {
    const fake = transport([]);
    await expect(safeRequest('https://site.example.org', {}, {
      request: fake.request,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
    })).rejects.toMatchObject({ code: 'UNSAFE_ADDRESS' });
    expect(fake.calls).toHaveLength(0);
  });

  it('checks literal IPv6 without invoking DNS', async () => {
    const resolve = vi.fn(publicDns);
    expect(await resolvePublicTarget(validatePublicUrl('https://[2606:4700:4700::1111]/'), resolve))
      .toEqual({ address: '2606:4700:4700::1111', family: 6 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('pins the approved address for connection and preserves hostname for Host and TLS', async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const fake = transport([{}]);
    await safeRequest('https://site.example.org/path', {}, { resolve, request: fake.request });
    const call = fake.calls[0]!;
    expect(call.url.hostname).toBe('site.example.org');
    expect(call.options.agent).toBe(false);
    const callback = vi.fn();
    call.options.lookup!('site.example.org', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('bounded redirects and responses', () => {
  it.each([NaN, Infinity, -1, 1.5])('does not disable limits for invalid bound %s', async (limit) => {
    const fake = transport([]);
    await expect(safeRequest('https://site.example.org', { maxBytes: limit }, { request: fake.request, resolve: publicDns }))
      .rejects.toMatchObject({ code: 'INVALID_LIMIT' });
    expect(fake.calls).toHaveLength(0);
  });

  it('blocks a redirect to private IP before making another request', async () => {
    const fake = transport([{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }]);
    await expect(safeRequest('https://site.example.org', {}, { request: fake.request, resolve: publicDns }))
      .rejects.toMatchObject({ code: 'UNSAFE_ADDRESS' });
    expect(fake.calls).toHaveLength(1);
  });

  it('revalidates DNS at every redirect and blocks rebinding on the same hostname', async () => {
    const fake = transport([{ status: 302, headers: { location: '/next' } }]);
    const resolve = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(safeRequest('https://site.example.org', {}, { request: fake.request, resolve }))
      .rejects.toMatchObject({ code: 'UNSAFE_ADDRESS' });
    expect(fake.calls).toHaveLength(1);
  });

  it('never follows more than three redirects even if a larger limit is requested', async () => {
    const fake = transport(Array.from({ length: 5 }, () => ({ status: 302, headers: { location: '/next' } })));
    await expect(safeRequest('https://site.example.org', { maxRedirects: 100 }, { request: fake.request, resolve: publicDns }))
      .rejects.toMatchObject({ code: 'REDIRECT_REJECTED' });
    expect(fake.calls).toHaveLength(4);
  });

  it('does not forward API secrets or POST payloads through a redirect', async () => {
    const fake = transport([{ status: 307, headers: { location: 'https://other.example.org/' } }]);
    await expect(safeRequest('https://site.example.org', {
      method: 'POST', headers: { Authorization: 'Bearer test-secret' }, body: 'private audio',
    }, { request: fake.request, resolve: publicDns })).rejects.toMatchObject({ code: 'REDIRECT_REJECTED' });
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    { headers: { 'content-length': '500' }, body: '' },
    { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(500) },
  ])('enforces the response byte limit', async (reply) => {
    const fake = transport([reply]);
    await expect(safeRequest('https://site.example.org', { maxBytes: 100 }, { request: fake.request, resolve: publicDns }))
      .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('rejects compressed payloads instead of decompressing an unbounded body', async () => {
    const fake = transport([{ headers: { 'content-encoding': 'gzip' } }]);
    await expect(safeRequest('https://site.example.org', {}, { request: fake.request, resolve: publicDns }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
  });

  it('includes DNS resolution in the deadline', async () => {
    await expect(safeRequest('https://site.example.org', { timeoutMs: 15 }, {
      resolve: () => new Promise(() => {}),
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('stops a stalled response at the deadline', async () => {
    const fake = transport([{ stall: true }]);
    await expect(safeRequest('https://site.example.org', { timeoutMs: 15 }, { request: fake.request, resolve: publicDns }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('honours cancellation before any network request', async () => {
    const fake = transport([]);
    await expect(safeRequest('https://site.example.org', { signal: AbortSignal.abort() }, { request: fake.request, resolve: publicDns }))
      .rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});
