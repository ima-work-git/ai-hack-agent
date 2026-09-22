import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApiHandler } from '../server/http.ts';
import { readConfig } from '../server/config.ts';
import type { AppConfig } from '../server/config.ts';
import { SessionStore } from '../server/sessions.ts';
import { createFixtureProvider, DEMO_TEXT } from '../server/fixtures.ts';
import type { ResearchProvider } from '../server/provider-contract.ts';
import { pcmToWav } from '../server/providers.ts';
import type { ResearchInput } from '../src/shared/contracts.ts';
import * as streamingRelay from '../server/ws-relay.ts';

const cleanups: (() => Promise<void>)[] = [];
async function fixture(options: { config?: Partial<AppConfig>; provider?: (input: ResearchInput) => ResearchProvider; liveProvider?: ResearchProvider; live?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-hack-http-'));
  let now = Date.now();
  const config = { ...readConfig({ PRIVATE_DIR: directory, APP_ACCESS_CODE: 'test-access-code-123', ...(options.live ? {
    AGENT_LIVE_ENABLED: 'true', RUN_BUDGET_USD: '0.015', DAY_BUDGET_USD: '1', EVENT_BUDGET_USD: '2',
    MAX_LLM_CALL_USD: '0.01', MAX_SEARCH_CALL_USD: '0.02', MAX_PAGE_CALL_USD: '0', MAX_STT_CALL_USD: '0.01',
    ORCAROUTER_API_KEY: 'test-not-a-key', ORCAROUTER_MODEL: 'test-model', TAVILY_API_KEY: 'test-not-a-key',
    STT_API_KEY: 'test-not-a-key', STT_API_BASE_URL: 'https://example.invalid/v1', STT_MODEL: 'test-model',
  } : {}) }), ...options.config };
  let store = new SessionStore(directory, () => now);
  const createHandler = () => createApiHandler(config, { store, now: () => now, provider: options.provider, liveProvider: options.liveProvider });
  let api = createHandler();
  cleanups.push(async () => { api.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) => {
    const headers = Object.fromEntries(Object.entries({ Host: 'localhost:4173', Origin: 'http://localhost:4173', ...init.headers }).map(([key, value]) => [key.toLowerCase(), value]));
    const req = Object.assign(Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]), { method: init.method ?? 'GET', url: path, headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    const responseHeaders = new Headers();
    const chunks: string[] = [];
    let endBody!: (text: string) => void;
    const bodyDone = new Promise<string>(resolve => { endBody = resolve; });
    let ready!: () => void;
    const headersDone = new Promise<void>(resolve => { ready = resolve; });
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      destroyed: false, writableEnded: false, headersSent: false, statusCode: 200,
      setHeader(name: string, value: string | string[]) { responseHeaders.delete(name); for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item); },
      writeHead(status: number, extra: Record<string, string> = {}) { this.statusCode = status; for (const [k, v] of Object.entries(extra)) responseHeaders.set(k, v); this.headersSent = true; ready(); return this; },
      flushHeaders() { this.headersSent = true; ready(); },
      write(value: string) { chunks.push(value); return true; },
      end(value = '') { chunks.push(value); this.writableEnded = true; this.headersSent = true; ready(); endBody(chunks.join('')); emitter.emit('close'); return this; },
    });
    void api.handle(req, res as unknown as ServerResponse).then(handled => { if (!handled) res.writeHead(404).end(); });
    await headersDone;
    return { status: res.statusCode, headers: responseHeaders, text: () => bodyDone, json: async () => JSON.parse(await bodyDone) };
  };
  const login = async (cookie?: string, accessCode = 'test-access-code-123', rememberDevice = false) => {
    const response = await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ accessCode, rememberDevice }) });
    return { response, body: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  };
  const body = (revision = 1, extra: Record<string, unknown> = {}) => ({ text: DEMO_TEXT, requestId: randomUUID(), subjectRevision: revision, mode: 'demo', scenario: 'normal', ...extra });
  const research = async (token: string, data: ReturnType<typeof body> & Record<string, unknown> = body()) => {
    const response = await request('/api/research', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
    const text = await response.text();
    return { response, events: text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
  return { config, directory, get store() { return store; }, get api() { return api; }, request, login, body, research, advance: (duration: number) => { now += duration; },
    restart: (accessCode?: string) => { api.close(); if (accessCode !== undefined) config.accessCode = accessCode; store = new SessionStore(directory, () => now); api = createHandler(); } };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('conversation-wide audio and research budget', () => {
  const start = (f: Awaited<ReturnType<typeof fixture>>, token: string) => f.request('/api/conversation', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const transcribe = (f: Awaited<ReturnType<typeof fixture>>, token: string, conversationId: string, requestId = randomUUID(), revision = 1) => f.request('/api/transcribe', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav', 'X-Conversation-Id': conversationId,
      'X-Request-Id': requestId, 'X-Subject-Revision': String(revision) }, body: pcmToWav(new Uint8Array(32)),
  });

  it('issues a short-lived stream ticket only for the authenticated same-origin conversation and rejects fabricated finals', async () => {
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', plan: vi.fn(createFixtureProvider('normal').plan) };
    const f = await fixture({ live: true, liveProvider: provider, config: { streamingApiKey: 'not-a-real-key', streamingModel: 'gpt-live-transcribe', streamingAudioMaxPerMinute: 0.03 } });
    f.config.status.streamingEnabled = true;
    const auth = await f.login(); const other = await f.login(); const group = await (await start(f, auth.body.token)).json();
    const ticket = (token: string, headers: Record<string, string> = {}) => f.request('/api/conversation/stream', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ conversationId: group.conversationId }) });
    expect((await ticket(other.body.token)).status).toBe(409);
    expect((await ticket(auth.body.token, { Origin: 'https://foreign.invalid' })).status).toBe(403);
    const response = await ticket(auth.body.token); const body = await response.json();
    expect(response.status).toBe(200); expect(body.ticket).toMatch(/^[a-f0-9]{64}$/); expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    const identified = await f.request('/api/conversation/identify', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: group.conversationId, requestId: randomUUID(), subjectRevision: 1, text: 'Fabricated transcript' }) });
    expect(identified.status).toBe(409); expect(provider.plan).not.toHaveBeenCalled();
    f.advance(900_001); expect((await ticket(auth.body.token)).status).toBe(401);
  });

  it('identifies only a once-received streaming final and charges identification and research to its conversation', async () => {
    let takeTicket!: (ticket: string) => streamingRelay.StreamGrant;
    const spy = vi.spyOn(streamingRelay, 'createStreamingRelay').mockImplementation(options => {
      takeTicket = options.takeTicket;
      return { upgrade: () => false, closeConversation: vi.fn(), close: vi.fn() };
    });
    try {
      const normal = createFixtureProvider('normal');
      const provider: ResearchProvider = { ...normal, mode: 'live', plan: vi.fn(async (input, signal) => ({ ...await normal.plan(input, signal), actualUsd: 0.001 })) };
      const f = await fixture({ live: true, liveProvider: provider, config: { maximumCosts: { llm: 0.001, search: 0.001, page: 0 }, streamingApiKey: 'fake-key', streamingModel: 'gpt-live-transcribe', streamingAudioMaxPerMinute: 0.03 } });
      f.config.status.streamingEnabled = true;
      const auth = await f.login(); const group = await (await start(f, auth.body.token)).json();
      const issued = await f.request('/api/conversation/stream', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: group.conversationId }) });
      const ticket = (await issued.json()).ticket; const grant = takeTicket(ticket);
      expect(() => takeTicket(ticket)).toThrow(); grant.onFinal(DEMO_TEXT);
      const requestId = randomUUID();
      const identify = (id = requestId) => f.request('/api/conversation/identify', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: group.conversationId, requestId: id, subjectRevision: 1, text: DEMO_TEXT }) });
      const identified = await identify(); expect(identified.status).toBe(200);
      expect((await identified.json()).targets).toHaveLength(1);
      expect((await identify(randomUUID())).status).toBe(409);
      expect((await f.research(auth.body.token, f.body(1, { mode: 'live', conversationId: group.conversationId, requestId }))).response.status).toBe(200);
      const ledger = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8'));
      expect(Object.keys(ledger.runs)).toEqual([group.conversationId]); expect(ledger.runs[group.conversationId].spent).toBe(2_000);
      f.advance(900_001); expect(grant.valid()).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('reserves STT, research and later windows against one server-issued parent budget', async () => {
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: vi.fn(async () => ({ value: DEMO_TEXT })) };
    const f = await fixture({ live: true, liveProvider: provider }); const auth = await f.login();
    const begun = await start(f, auth.body.token); const group = await begun.json();
    expect(begun.status).toBe(200); expect(group.expiresAt).toBe(auth.body.expiresAt);
    const requestId = randomUUID();
    expect((await transcribe(f, auth.body.token, group.conversationId, requestId)).status).toBe(200);
    const researched = await f.research(auth.body.token, f.body(1, { mode: 'live', conversationId: group.conversationId, requestId }));
    expect(researched.events.at(-1).result.reasonCode).toBe('BUDGET_EXHAUSTED');
    expect(researched.events.at(-1).result.usage.reservedUsd).toBe(0.01);
    expect((await transcribe(f, auth.body.token, group.conversationId, randomUUID(), 2)).status).toBe(429);
    expect(provider.transcribe).toHaveBeenCalledOnce();
    const ledger = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8'));
    expect(Object.keys(ledger.runs)).toEqual([group.conversationId]);
    expect(ledger.runs[group.conversationId].reserved).toBe(10_000);
  });

  it('binds completed STT to its owner, request, revision and one research without permitting a missing group', async () => {
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: vi.fn(async () => ({ value: DEMO_TEXT, actualUsd: 0 })) };
    const f = await fixture({ live: true, liveProvider: provider, config: { maximumCosts: { llm: 0.001, search: 0.001, page: 0 } } });
    const auth = await f.login(); const other = await f.login(); const group = await (await start(f, auth.body.token)).json(); const requestId = randomUUID();
    expect((await transcribe(f, other.body.token, group.conversationId, requestId)).status).toBe(409);
    expect((await f.research(auth.body.token, f.body(1, { mode: 'live', conversationId: group.conversationId, requestId }))).response.status).toBe(409);
    expect((await transcribe(f, auth.body.token, group.conversationId, requestId)).status).toBe(200);
    expect((await transcribe(f, auth.body.token, group.conversationId, requestId)).status).toBe(409);
    expect((await f.research(auth.body.token, f.body(1, { mode: 'live', requestId }))).response.status).toBe(409);
    expect((await f.research(auth.body.token, f.body(2, { mode: 'live', conversationId: group.conversationId, requestId }))).response.status).toBe(409);
    const data = f.body(1, { mode: 'live', conversationId: group.conversationId, requestId });
    expect((await f.research(auth.body.token, data)).response.status).toBe(200);
    expect((await f.research(auth.body.token, { ...data, subjectRevision: 2 })).response.status).toBe(409);
    expect((await transcribe(f, auth.body.token, group.conversationId, randomUUID(), 2)).status).toBe(200);
  });

  it('allows windows without research but stops at the server-side one-hundred-window limit', async () => {
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: vi.fn(async () => ({ value: DEMO_TEXT, actualUsd: 0 })) };
    const f = await fixture({ live: true, liveProvider: provider }); const auth = await f.login(); const group = await (await start(f, auth.body.token)).json();
    for (let i = 0; i < 100; i++) expect((await transcribe(f, auth.body.token, group.conversationId)).status).toBe(200);
    expect((await transcribe(f, auth.body.token, group.conversationId)).status).toBe(429);
    expect(provider.transcribe).toHaveBeenCalledTimes(100);
  });

  it.each([{ targets: [], hasPersonMention: false }, { targets: [{ personName: '架空花子', companyName: '架空研究所' }], hasPersonMention: true }])('forwards optional validated target metadata and conversation context without an extra call: %j', async ({ targets, hasPersonMention }) => {
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: vi.fn(async () => ({ value: DEMO_TEXT, actualUsd: 0, transcriptTargets: targets, transcriptHasPersonMention: hasPersonMention })) };
    const f = await fixture({ live: true, liveProvider: provider }); const auth = await f.login(); const group = await (await start(f, auth.body.token)).json();
    const response = await transcribe(f, auth.body.token, group.conversationId);
    expect(await response.json()).toEqual({ text: DEMO_TEXT, targets, hasPersonMention });
    expect(provider.transcribe).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.transcribe!).mock.calls[0]![3]).toBe('');
    expect((await transcribe(f, auth.body.token, group.conversationId)).status).toBe(200);
    expect(provider.transcribe).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.transcribe!).mock.calls[1]![3]).toBe(DEMO_TEXT);
    const nextGroup = await (await start(f, auth.body.token)).json();
    expect((await transcribe(f, auth.body.token, nextGroup.conversationId)).status).toBe(200);
    expect(vi.mocked(provider.transcribe!).mock.calls[2]![3]).toBe('');
  });

  it('continues a confirmed candidate within its original conversation budget and rejects forged or unrelated groups', async () => {
    const normal = createFixtureProvider('normal');
    const ambiguous = createFixtureProvider('ambiguous');
    const plan = vi.fn<ResearchProvider['plan']>(async (input, signal) => ({ ...await normal.plan(input, signal), actualUsd: 0.001 }));
    plan.mockImplementationOnce(ambiguous.plan);
    const provider: ResearchProvider = { ...normal, mode: 'live', plan, transcribe: vi.fn(async () => ({ value: DEMO_TEXT, actualUsd: 0 })) };
    const f = await fixture({ live: true, liveProvider: provider, config: { maximumCosts: { llm: 0.001, search: 0.001, page: 0 } } });
    const auth = await f.login(); const group = await (await start(f, auth.body.token)).json(); const requestId = randomUUID();
    expect((await transcribe(f, auth.body.token, group.conversationId, requestId)).status).toBe(200);
    const first = await f.research(auth.body.token, f.body(1, { mode: 'live', conversationId: group.conversationId, requestId }));
    expect(first.events.at(-1).result.status).toBe('awaiting_confirmation');
    const selected = first.events.at(-1).result.candidates[0];
    const confirmation = f.body(2, { mode: 'live', conversationId: group.conversationId, selectedCandidateId: selected.id });
    expect((await f.research(auth.body.token, { ...confirmation, selectedCandidateId: 'forged' })).response.status).toBe(409);
    expect((await f.research(auth.body.token, { ...confirmation, text: 'changed input' })).response.status).toBe(409);
    expect((await f.research(auth.body.token, { ...confirmation, conversationId: randomUUID() })).response.status).toBe(409);
    expect((await f.research(auth.body.token, { ...confirmation, conversationId: undefined })).response.status).toBe(409);
    const next = await f.research(auth.body.token, confirmation);
    expect(next.response.status).toBe(200);
    expect(next.events.at(-1).result.target).toEqual({ personName: selected.personName, companyName: selected.companyName });
    expect(plan).toHaveBeenCalledTimes(2);
    expect(provider.transcribe).toHaveBeenCalledOnce();
    const ledger = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8'));
    expect(Object.keys(ledger.runs)).toEqual([group.conversationId]);
    expect(ledger.runs[group.conversationId].spent).toBe(1_000);
  });

  it('rejects concurrent start and cancels the entire group while STT is pending', async () => {
    let started!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: vi.fn(async () => {
      started(); await new Promise<void>(resolve => { release = resolve; }); return { value: DEMO_TEXT };
    }) };
    const f = await fixture({ live: true, liveProvider: provider }); const auth = await f.login(); const group = await (await start(f, auth.body.token)).json(); const requestId = randomUUID();
    const pending = transcribe(f, auth.body.token, group.conversationId, requestId); await entered;
    expect((await start(f, auth.body.token)).status).toBe(409);
    expect((await f.request('/api/cancel', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: group.conversationId, requestId, subjectRevision: 1 }) })).status).toBe(200);
    expect((await pending).status).toBe(408);
    release();
    expect((await f.research(auth.body.token, f.body(1, { mode: 'live', conversationId: group.conversationId, requestId }))).response.status).toBe(409);
    expect(provider.transcribe).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'replace', 'forget', 'expiry', 'restart'] as const)('invalidates a conversation after %s before any additional provider work', async action => {
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: vi.fn(async () => ({ value: DEMO_TEXT, actualUsd: 0 })) };
    const f = await fixture({ live: true, liveProvider: provider }); const auth = await f.login(); const group = await (await start(f, auth.body.token)).json();
    if (action === 'cancel') expect((await f.request('/api/cancel', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: group.conversationId, requestId: randomUUID(), subjectRevision: 1 }) })).status).toBe(200);
    if (action === 'replace') await start(f, auth.body.token);
    if (action === 'forget') await f.request('/api/session/forget', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    if (action === 'expiry') f.advance(900_000);
    if (action === 'restart') f.restart();
    expect([401, 409]).toContain((await transcribe(f, auth.body.token, group.conversationId)).status);
    expect(provider.transcribe).not.toHaveBeenCalled();
  });
});

describe('single-use QR login', () => {
  const issue = (f: Awaited<ReturnType<typeof fixture>>, token: string, headers: Record<string, string> = {}, body = '{}') =>
    f.request('/api/session/qr', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body });
  const redeem = (f: Awaited<ReturnType<typeof fixture>>, ticket: string, headers: Record<string, string> = {}) =>
    f.request('/api/session/qr/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ticket }) });

  it('creates a new remembered login without copying either issuer or browser conversation or executing work', async () => {
    const provider = vi.fn(() => createFixtureProvider('normal'));
    const liveProvider = { ...createFixtureProvider('normal'), transcribe: vi.fn(async () => ({ value: DEMO_TEXT })) };
    const f = await fixture({ provider, liveProvider });
    const issuer = await f.login(); await f.research(issuer.body.token);
    const browser = await f.login(); await f.research(browser.body.token);
    const issued = await issue(f, issuer.body.token); const grant = await issued.json();
    expect(issued.status).toBe(200); expect(grant.ticket).toMatch(/^[a-f0-9]{64}$/);
    expect(grant.expiresAt).toBe(issuer.body.expiresAt - 5 * 60_000);
    const response = await redeem(f, grant.ticket, { Cookie: browser.cookie }); const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ revision: 0, hasPrevious: false, interrupted: false });
    expect(body).not.toHaveProperty('result'); expect(body).not.toHaveProperty('input');
    expect(body.token.split('.')[0]).not.toBe(issuer.body.token.split('.')[0]);
    expect(body.token.split('.')[0]).not.toBe(browser.body.token.split('.')[0]);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.getSetCookie().some(cookie => /^rememberedDevice=[a-f0-9]{64};/.test(cookie))).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2); expect(liveProvider.transcribe).not.toHaveBeenCalled();
    expect(await readFile(join(f.directory, 'device-logins.json'), 'utf8')).not.toContain(grant.ticket);
    expect((await readdir(f.directory)).some(name => /qr|ticket/.test(name))).toBe(false);
    expect((await redeem(f, grant.ticket)).status).toBe(401);
  });

  it('allows exactly one simultaneous redemption and rejects altered tickets', async () => {
    const f = await fixture(); const issuer = await f.login();
    const grant = await (await issue(f, issuer.body.token)).json();
    const altered = (grant.ticket[0] === 'a' ? 'b' : 'a') + grant.ticket.slice(1);
    expect((await redeem(f, altered)).status).toBe(401);
    const responses = await Promise.all([redeem(f, grant.ticket), redeem(f, grant.ticket)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
  });

  it('requires bearer authorization to issue and same-origin strict JSON at both endpoints', async () => {
    const f = await fixture(); const issuer = await f.login();
    expect((await issue(f, 'invalid')).status).toBe(401);
    const grant = await (await issue(f, issuer.body.token)).json();
    for (const Origin of ['', 'https://attacker.invalid', 'http://127.0.0.1:4173']) {
      expect((await issue(f, issuer.body.token, { Origin })).status).toBe(403);
      expect((await redeem(f, grant.ticket, { Origin })).status).toBe(403);
    }
    expect((await issue(f, issuer.body.token, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await issue(f, issuer.body.token, {}, '{"extra":true}')).status).toBe(400);
    expect((await redeem(f, grant.ticket, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await f.request('/api/session/qr/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: grant.ticket, extra: true }) })).status).toBe(400);
    expect((await redeem(f, grant.ticket)).status).toBe(200);
  });

  it.each(['ticket-expiry', 'issuer-expiry', 'issuer-logout', 'restart'] as const)('invalidates an unused ticket after %s', async action => {
    const f = await fixture(); const issuer = await f.login();
    if (action === 'issuer-expiry') f.advance(14 * 60_000);
    const grant = await (await issue(f, issuer.body.token)).json();
    if (action === 'issuer-expiry') expect(grant.expiresAt).toBe(issuer.body.expiresAt);
    if (action === 'ticket-expiry') f.advance(10 * 60_000);
    if (action === 'issuer-expiry') f.advance(60_000);
    if (action === 'issuer-logout') await f.request('/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${issuer.body.token}` } });
    if (action === 'restart') f.restart();
    expect((await redeem(f, grant.ticket)).status).toBe(401);
  });

  it('caps outstanding tickets at five and recovers capacity after expiry', async () => {
    const f = await fixture(); const issuer = await f.login();
    for (let i = 0; i < 5; i++) expect((await issue(f, issuer.body.token)).status).toBe(200);
    expect((await issue(f, issuer.body.token)).status).toBe(429);
    f.advance(10 * 60_000);
    expect((await issue(f, issuer.body.token)).status).toBe(200);
  });

  it('shares the restore rate limit for unauthenticated redemption attempts', async () => {
    const f = await fixture();
    for (let i = 0; i < 20; i++) expect((await redeem(f, 'a'.repeat(64))).status).toBe(401);
    expect((await redeem(f, 'a'.repeat(64))).status).toBe(429);
    f.advance(60_000);
    expect((await redeem(f, 'a'.repeat(64))).status).toBe(401);
  });
});

describe('remembered-device HTTP authentication', () => {
  const post = (f: Awaited<ReturnType<typeof fixture>>, path: 'restore' | 'forget', cookie: string, headers: Record<string, string> = {}, body = '{}') =>
    f.request(`/api/session/${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body });
  const remembered = (cookie: string) => cookie.split('; ').find(value => value.startsWith('rememberedDevice='))!;

  it('requires opt-in and refuses to restore from a conversation cookie alone', async () => {
    const f = await fixture();
    const response = await f.request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: f.config.accessCode }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(response.headers.getSetCookie().find(value => value.startsWith('rememberedDevice='))).toContain('Max-Age=0');
    expect((await post(f, 'restore', cookie)).status).toBe(401);
  });

  it('restores a valid session, rotates its bearer, and neither extends either TTL nor returns or executes its previous data', async () => {
    const provider = vi.fn(() => createFixtureProvider('normal'));
    const liveProvider = { ...createFixtureProvider('normal'), transcribe: vi.fn(async () => ({ value: DEMO_TEXT })) };
    const f = await fixture({ provider, liveProvider });
    const auth = await f.login(undefined, undefined, true);
    const first = await f.research(auth.body.token);
    expect(first.events.at(-1).result.status).toBe('ready');
    const before = await readFile(join(f.directory, 'device-logins.json'), 'utf8');
    f.advance(60_000);
    const restored = await post(f, 'restore', auth.cookie);
    const body = await restored.json();
    expect(restored.status).toBe(200);
    expect(body).toMatchObject({ expiresAt: auth.body.expiresAt, hasPrevious: true, revision: 1 });
    expect(body.token).not.toBe(auth.body.token);
    expect(body.token.split('.')[0]).toBe(auth.body.token.split('.')[0]);
    expect(body).not.toHaveProperty('result'); expect(body).not.toHaveProperty('input');
    expect(restored.headers.getSetCookie()).toHaveLength(1);
    expect(restored.headers.get('set-cookie')).not.toContain('rememberedDevice');
    expect(await readFile(join(f.directory, 'device-logins.json'), 'utf8')).toBe(before);
    expect((await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}` } })).status).toBe(401);
    expect(provider).toHaveBeenCalledOnce(); expect(liveProvider.transcribe).not.toHaveBeenCalled();
  });

  it('survives restart while creating an empty session after the original conversation expires at fifteen minutes', async () => {
    const f = await fixture(); const auth = await f.login(undefined, undefined, true);
    await f.research(auth.body.token);
    f.restart();
    expect((await post(f, 'restore', auth.cookie)).status).toBe(200);
    f.advance(900_000);
    const restored = await post(f, 'restore', auth.cookie); const body = await restored.json();
    expect(restored.status).toBe(200);
    expect(body).toMatchObject({ hasPrevious: false, revision: 0, interrupted: false });
    expect(body.token.split('.')[0]).not.toBe(auth.body.token.split('.')[0]);
    expect(await readdir(join(f.directory, 'sessions'))).not.toContain(`${auth.body.token.split('.')[0]}.enc`);
    const previous = await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${body.token}` } });
    expect(await previous.json()).toMatchObject({ result: null, input: null });
  });

  it('expires device access at twelve hours without sliding the expiry on restore', async () => {
    const f = await fixture(); const auth = await f.login(undefined, undefined, true);
    f.advance(12 * 60 * 60_000 - 1);
    expect((await post(f, 'restore', auth.cookie)).status).toBe(200);
    f.advance(1);
    expect((await post(f, 'restore', auth.cookie)).status).toBe(401);
  });

  it('requires same-origin JSON for restore and forget, rejects extra data and altered cookies', async () => {
    const f = await fixture(); const auth = await f.login(undefined, undefined, true);
    for (const path of ['restore', 'forget'] as const) {
      for (const Origin of ['', 'https://attacker.invalid', 'http://127.0.0.1:4173']) expect((await post(f, path, auth.cookie, { Origin })).status).toBe(403);
      expect((await post(f, path, auth.cookie, { 'Content-Type': 'text/plain' })).status).toBe(415);
      expect((await post(f, path, auth.cookie, {}, '{"accessCode":"injected"}')).status).toBe(400);
    }
    const original = remembered(auth.cookie); const token = original.split('=')[1]!;
    const wrong = `${original.split('=')[0]}=${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
    expect((await post(f, 'restore', wrong)).status).toBe(401);
    expect((await post(f, 'restore', `${auth.cookie}; ${original}`)).status).toBe(401);
    expect((await post(f, 'restore', auth.cookie)).status).toBe(200);
  });

  it('sets HTTPS-only device cookies and revokes the server record on authenticated logout', async () => {
    const f = await fixture({ config: { origin: 'https://fixture.invalid' } });
    const auth = await f.login(undefined, undefined, true);
    const cookies = auth.response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) expect(cookie).toContain('Path=/api; HttpOnly; SameSite=Strict; Secure; Expires=');
    const logout = await f.request('/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${auth.body.token}`, Cookie: auth.cookie } });
    expect(logout.status).toBe(200);
    expect(logout.headers.getSetCookie()).toHaveLength(2);
    for (const cookie of logout.headers.getSetCookie()) expect(cookie).toContain('Max-Age=0');
    f.restart();
    expect((await post(f, 'restore', auth.cookie)).status).toBe(401);
    expect(JSON.parse(await readFile(join(f.directory, 'device-logins.json'), 'utf8')).devices).toEqual([]);
  });

  it('forgets both credentials and conversation data without a live bearer after expiry', async () => {
    const f = await fixture(); const auth = await f.login(undefined, undefined, true);
    await f.research(auth.body.token); f.advance(900_001);
    const forgotten = await post(f, 'forget', auth.cookie);
    expect(forgotten.status).toBe(200);
    expect(await forgotten.json()).toEqual({ ended: true });
    expect(forgotten.headers.getSetCookie()).toHaveLength(2);
    expect(await readdir(join(f.directory, 'sessions'))).toEqual([]);
    expect((await post(f, 'restore', auth.cookie)).status).toBe(401);
  });

  it('forget stops an active request and discards a delayed result', async () => {
    const provider = createFixtureProvider('normal');
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    provider.search = async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { value: [], actualUsd: 0 }; };
    const f = await fixture({ provider: () => provider }); const auth = await f.login(undefined, undefined, true);
    const pending = f.research(auth.body.token); await entered;
    expect((await post(f, 'forget', auth.cookie)).status).toBe(200);
    const response = await pending;
    expect(response.events.at(-1).type).toBe('error');
    expect(response.events.some(event => event.type === 'result')).toBe(false);
    release();
    expect(await readdir(join(f.directory, 'sessions'))).toEqual([]);
  });

  it('remember=false revokes an old device record and a new explicit code login rotates remembered credentials', async () => {
    const f = await fixture(); const original = await f.login(undefined, undefined, true);
    const rotated = await f.login(original.cookie, undefined, true);
    expect(remembered(rotated.cookie)).not.toBe(remembered(original.cookie));
    expect((await post(f, 'restore', original.cookie)).status).toBe(401);
    expect((await post(f, 'restore', rotated.cookie)).status).toBe(200);
    const plain = await f.login(rotated.cookie);
    expect(plain.response.status).toBe(200);
    expect(plain.response.headers.getSetCookie().find(value => value.startsWith('rememberedDevice='))).toContain('Max-Age=0');
    expect((await post(f, 'restore', rotated.cookie)).status).toBe(401);
  });

  it('fails closed on changed access codes or corrupt persistence but permits fresh verified code login', async () => {
    const f = await fixture(); const original = await f.login(undefined, undefined, true);
    f.restart('replacement-fixture-code');
    expect((await post(f, 'restore', original.cookie)).status).toBe(401);
    const fresh = await f.login(original.cookie, 'replacement-fixture-code', true);
    expect(fresh.response.status).toBe(200);
    await writeFile(join(f.directory, 'device-logins.json'), '{corrupt');
    expect((await post(f, 'restore', fresh.cookie)).status).toBe(401);
  });

  it('rate-limits restore attempts independently from the access-code route', async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 20; attempt++) expect((await post(f, 'restore', '')).status).toBe(401);
    expect((await post(f, 'restore', '')).status).toBe(429);
    expect((await f.login()).response.status).toBe(200);
    f.advance(60_000);
    expect((await post(f, 'restore', '')).status).toBe(401);
  });
});

describe('authenticated HTTP boundary', () => {
  it('rejects hostile Origin/Host and leaves non-API routes to the app', async () => {
    const f = await fixture();
    expect((await f.request('/api/status', { headers: { Origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await f.request('/api/status', { headers: { Host: 'attacker.invalid' } })).status).toBe(403);
    expect((await f.request('/index.html')).status).toBe(404);
    const response = await f.request('/api/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
  });
  it('requires access code then bearer credentials and sets protected cookies', async () => {
    const f = await fixture();
    expect((await f.login(undefined, 'wrong')).response.status).toBe(401);
    expect((await f.request('/api/session/resume', { method: 'POST' })).status).toBe(401);
    const auth = await f.login();
    expect(auth.response.status).toBe(200);
    expect(auth.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(auth.body).toMatchObject({ revision: 0, hasPrevious: false, interrupted: false });
  });
  it('requires monotonic revisions, refuses duplicate IDs and resumes only on explicit request', async () => {
    const f = await fixture();
    const auth = await f.login();
    const data = f.body();
    const first = await f.research(auth.body.token, data);
    expect(first.events.at(-1).result.status).toBe('ready');
    expect((await f.research(auth.body.token, data)).response.status).toBe(409);
    expect((await f.research(auth.body.token, f.body(1))).response.status).toBe(409);
    const reauth = await f.login(auth.cookie);
    expect(reauth.body.hasPrevious).toBe(true);
    expect(reauth.body.result).toBeUndefined();
    expect((await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}` } })).status).toBe(401);
    const resumed = await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${reauth.body.token}` } });
    expect((await resumed.json()).result.requestId).toBe(data.requestId);
    f.advance(300_001);
    const expiredCards = await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${reauth.body.token}` } });
    expect((await expiredCards.json()).result).toBeNull();
  });
  it('expires authenticated sessions and clears cookies and recovery data on end', async () => {
    const f = await fixture();
    const auth = await f.login();
    f.advance(900_001);
    expect((await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}` } })).status).toBe(401);
    const fresh = await f.login();
    const ended = await f.request('/api/session', { method: 'DELETE', headers: { Authorization: `Bearer ${fresh.body.token}` } });
    expect(ended.status).toBe(200);
    expect(ended.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${fresh.body.token}` } })).status).toBe(401);
  });
  it('validates candidate membership and original input before another run', async () => {
    const f = await fixture();
    const auth = await f.login();
    const first = await f.research(auth.body.token, f.body(1, { scenario: 'ambiguous' }));
    const candidate = first.events.at(-1).result.candidates[1];
    expect((await f.research(auth.body.token, f.body(2, { scenario: 'ambiguous', selectedCandidateId: 'forged' }))).response.status).toBe(409);
    expect((await f.research(auth.body.token, f.body(2, { scenario: 'ambiguous', selectedCandidateId: candidate.id, text: 'different' }))).response.status).toBe(409);
    const next = await f.research(auth.body.token, f.body(2, { scenario: 'ambiguous', selectedCandidateId: candidate.id }));
    expect(next.events.at(-1).result.target.companyName).toBe(candidate.companyName);
  });
  it('only cancels the matching active run, blocks concurrency, and discards late output', async () => {
    const fixtureProvider = createFixtureProvider('normal');
    let release!: () => void;
    const started = new Promise<void>(resolve => {
      fixtureProvider.search = async () => { resolve(); await new Promise<void>(r => { release = r; }); return { value: [], actualUsd: 0 }; };
    });
    const f = await fixture({ provider: () => fixtureProvider });
    const auth = await f.login();
    const data = f.body();
    const pending = f.research(auth.body.token, data);
    await started;
    expect((await f.research(auth.body.token, f.body(2))).response.status).toBe(409);
    const cancel = (requestId: string) => f.request('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.body.token}` }, body: JSON.stringify({ requestId, subjectRevision: 1 }) });
    expect((await cancel('wrong-request')).status).toBe(409);
    expect((await cancel(data.requestId)).status).toBe(200);
    const result = await pending;
    expect(result.events.at(-1).type).toBe('error');
    release();
    const resumed = await f.request('/api/session/resume', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}` } });
    expect((await resumed.json()).result).toBeNull();
  });
  it('gates STT and live research without sending data to a provider', async () => {
    const provider = { ...createFixtureProvider('normal'), mode: 'live' as const, transcribe: vi.fn(async () => ({ value: 'no' })) };
    const f = await fixture({ liveProvider: provider });
    const auth = await f.login();
    expect((await f.request('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'audio/wav', 'X-Request-Id': randomUUID() }, body: pcmToWav(new Uint8Array(32)) })).status).toBe(403);
    expect(provider.transcribe).not.toHaveBeenCalled();
    expect((await f.research(auth.body.token, f.body(1, { mode: 'live' }))).response.status).toBe(403);
  });
  it('rejects oversized JSON before starting work and throttles repeated login attempts', async () => {
    const f = await fixture();
    const auth = await f.login();
    const response = await f.request('/api/research', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(20_000) }) });
    expect(response.status).toBe(413);
    for (let i = 0; i < 9; i++) await f.login(undefined, 'wrong');
    expect((await f.login()).response.status).toBe(429);
  });
  it('allows skipped revisions, requires UUID IDs and remembers earlier requests', async () => {
    const f = await fixture();
    const auth = await f.login();
    expect((await f.research(auth.body.token, f.body(1, { requestId: 'not-a-uuid' }))).response.status).toBe(400);
    const first = f.body(3);
    expect((await f.research(auth.body.token, first)).events.at(-1).result.status).toBe('ready');
    expect((await f.research(auth.body.token, f.body(7))).response.status).toBe(200);
    expect((await f.research(auth.body.token, { ...first, subjectRevision: 8 })).response.status).toBe(409);
  });
  it('validates WAV before reserving and carries unknown STT charges into the same research budget', async () => {
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: vi.fn(async () => ({ value: DEMO_TEXT })) };
    const f = await fixture({ live: true, liveProvider: provider });
    const auth = await f.login();
    const requestId = randomUUID();
    const headers = { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'audio/wav', 'X-Request-Id': requestId, 'X-Subject-Revision': '3' };
    const invalid = await f.request('/api/transcribe', { method: 'POST', headers, body: new Uint8Array([1, 2]) });
    expect(invalid.status).toBe(400);
    expect(provider.transcribe).not.toHaveBeenCalled();
    const valid = await f.request('/api/transcribe', { method: 'POST', headers, body: pcmToWav(new Uint8Array(32)) });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ text: DEMO_TEXT });
    const ledger = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8'));
    expect(ledger.event.reserved).toBe(10_000);
    const research = await f.research(auth.body.token, f.body(3, { requestId, mode: 'live' }));
    expect(research.events.at(-1).result.reasonCode).toBe('BUDGET_EXHAUSTED');
    expect(research.events.at(-1).result.usage).toMatchObject({ reservedUsd: 0.01, costKnown: false, actualUsd: null, llm: 0 });
  });
  it('times out STT even when the provider ignores abort and retains its unknown charge', async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let finish!: () => void;
    const provider: ResearchProvider = { ...createFixtureProvider('normal'), mode: 'live', transcribe: async () => {
      signalStarted(); await new Promise<void>(resolve => { finish = resolve; }); return { value: DEMO_TEXT };
    } };
    const f = await fixture({ live: true, liveProvider: provider });
    const auth = await f.login();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = f.request('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${auth.body.token}`, 'Content-Type': 'audio/wav', 'X-Request-Id': randomUUID() }, body: pcmToWav(new Uint8Array(32)) });
      await started;
      await vi.advanceTimersByTimeAsync(8_001);
      expect((await pending).status).toBe(408);
      const ledger = JSON.parse(await readFile(join(f.directory, 'budget.json'), 'utf8'));
      expect(ledger.event.reserved).toBe(10_000);
      finish();
    } finally { vi.useRealTimers(); }
  });
});
