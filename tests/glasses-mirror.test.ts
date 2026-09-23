import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiHandler } from '../server/http.ts';
import { readConfig } from '../server/config.ts';
import { SessionStore } from '../server/sessions.ts';
import { GlassesMirrorSchema, GlassesMirrorStore, isLocalMirrorReader } from '../server/glasses-mirror.ts';

const frame = { view: { header: '人物一覧', content: 'テスト人物', footer: '音声認識中', textSize: 'small' as const }, state: 'connected' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'glasses-mirror-'));
  let now = Date.now();
  const config = readConfig({ PRIVATE_DIR: directory, APP_ACCESS_CODE: 'test-access-code-123', APP_ORIGIN: 'https://public.example' });
  const store = new SessionStore(directory, () => now);
  const api = createApiHandler(config, { store, now: () => now });
  cleanups.push(async () => { api.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (method: string, payload?: unknown, token?: string, extra: Record<string, string> = {}, address = '127.0.0.1', path = '/api/glasses-mirror') => {
    const req = Object.assign(Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]), {
      method, url: path, headers: { host: 'localhost:4173', origin: 'http://localhost:4173', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, socket: { remoteAddress: address },
    }) as unknown as IncomingMessage;
    const headers: Record<string, unknown> = {}; let status = 0; let text = '';
    const res = { destroyed: false, writableEnded: false, headersSent: false,
      setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = value; },
      writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; },
    } as unknown as ServerResponse;
    await api.handle(req, res);
    return { status, headers, body: JSON.parse(text) };
  };
  return { store, request, advance: (ms: number) => { now += ms; } };
}

describe('PC glasses mirror isolation', () => {
  it('requires bearer authentication and same-origin publishing, with schema and body limits', async () => {
    const f = await fixture(); const { token } = f.store.login();
    expect((await f.request('POST', frame)).status).toBe(401);
    expect((await f.request('POST', frame, token, { origin: 'https://elsewhere.invalid' })).status).toBe(403);
    expect((await f.request('POST', { ...frame, state: 2 }, token)).status).toBe(400);
    expect((await f.request('POST', { ...frame, extra: 'x'.repeat(17_000) }, token)).status).toBe(413);
    expect((await f.request('POST', frame, token)).status).toBe(200);
    const result = await f.request('GET');
    expect(result.status).toBe(200); expect(result.body.frame.view).toEqual(frame.view);
    expect(result.headers['cache-control']).toBe('no-store'); expect(result.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies the public tunnel, remote peers, forwarded peers and cross-site localhost reads', async () => {
    const f = await fixture(); const { token } = f.store.login(); await f.request('POST', frame, token);
    expect((await f.request('GET', undefined, undefined, { host: 'public.example', origin: 'https://public.example' })).status).toBe(403);
    expect((await f.request('GET', undefined, undefined, {}, '192.168.0.2')).status).toBe(403);
    expect((await f.request('GET', undefined, undefined, { 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
    expect((await f.request('GET', undefined, undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await f.request('GET', undefined, undefined, { origin: 'http://localhost:4174' })).status).toBe(403);
    expect((await f.request('OPTIONS')).status).toBe(403);
  });

  it('returns the newest active session, expires stale frames and clears ended sessions', async () => {
    const f = await fixture(); const a = f.store.login(); const b = f.store.login();
    await f.request('POST', frame, a.token); f.advance(1);
    await f.request('POST', { ...frame, state: 'newest' }, b.token);
    expect((await f.request('GET')).body.frame.state).toBe('newest');
    f.store.end(b.session.id); expect((await f.request('GET')).body.frame.state).toBe('connected');
    f.advance(120_000); expect((await f.request('GET')).body.frame).toBeNull();
    await f.request('POST', frame, a.token); f.advance(900_001);
    expect((await f.request('GET')).body.frame).toBeNull();
  });

  it('clears a frame on logout and bounds in-memory sessions', async () => {
    const f = await fixture(); const { token } = f.store.login(); await f.request('POST', frame, token);
    await f.request('DELETE', undefined, token, {}, '127.0.0.1', '/api/session');
    expect((await f.request('GET')).body.frame).toBeNull();
    let now = 0; const memory = new GlassesMirrorStore(() => true, () => now++);
    for (let i = 0; i < 25; i++) memory.publish(String(i), { ...frame, state: String(i) });
    for (let i = 5; i < 25; i++) memory.delete(String(i));
    expect(memory.latest()).toBeNull();
  });

  it('rejects unsafe schema additions and accepts only loopback hosts at the configured port', () => {
    expect(GlassesMirrorSchema.safeParse({ ...frame, sessionId: 'injected' }).success).toBe(false);
    expect(GlassesMirrorSchema.safeParse({ ...frame, view: { ...frame.view, textSize: 'large' } }).success).toBe(false);
    const req = { socket: { remoteAddress: '::1' }, headers: { host: '127.0.0.1:4173' } } as IncomingMessage;
    expect(isLocalMirrorReader(req, 4173)).toBe(true); expect(isLocalMirrorReader(req, 4174)).toBe(false);
  });
});
