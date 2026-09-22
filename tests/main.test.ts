// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { G2RuntimeOptions, GlassesView } from '../src/integrations/g2-runtime.ts';
import type { PhoneAudioOptions } from '../src/phone-audio.ts';
import type { ResearchInput, ResearchResult } from '../src/shared/contracts.ts';

interface MockG2 {
  options: G2RuntimeOptions;
  connect: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  invalidateViews: ReturnType<typeof vi.fn>;
  startAudio: ReturnType<typeof vi.fn>;
  stopAudio: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}
interface MockPhone {
  options: PhoneAudioOptions;
  recording: boolean;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}
const devices = vi.hoisted(() => ({ g2: null as MockG2 | null, phone: null as MockPhone | null }));
vi.mock('../src/integrations/g2-runtime.ts', () => ({
  G2Runtime: class implements MockG2 {
    constructor(public options: G2RuntimeOptions) { devices.g2 = this; }
    connect = vi.fn(async () => { this.options.onStatus?.({ state: 'connected' }); return true; });
    render = vi.fn(async (_view: GlassesView, _token: string) => true);
    invalidateViews = vi.fn();
    startAudio = vi.fn(async () => { this.options.onStatus?.({ state: 'recording' }); return true; });
    stopAudio = vi.fn(async () => { this.options.onStatus?.({ state: 'connected', reason: 'stopped' }); return true; });
    dispose = vi.fn(async () => { this.options.onStatus?.({ state: 'disposed' }); });
  },
}));
vi.mock('../src/phone-audio.ts', () => ({
  PhoneAudio: class implements MockPhone {
    recording = false;
    constructor(public options: PhoneAudioOptions) { devices.phone = this; }
    start = vi.fn(async () => { this.recording = true; return true; });
    stop = vi.fn(async () => {
      if (this.recording) { this.recording = false; this.options.onStopped('user'); }
    });
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const click = (id: string) => element<HTMLButtonElement>(id).click();
const flush = () => vi.advanceTimersByTimeAsync(0);
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const FACT = '架空の検証イベントに登壇したという固定資料です。';
function researchResult(requestId = 'fixture-resume-request', subjectRevision = 3): ResearchResult {
  return {
    requestId, subjectRevision, mode: 'live', status: 'ready',
    target: { personName: '架空の検証参加者', companyName: '架空検証社' }, candidates: [],
    cards: [{
      cardId: 'fixture-card', fact: FACT, suggestedQuestion: '検証イベントでは何を紹介しましたか。',
      sourceId: 'fixture-source', excerpt: FACT, requestId, subjectRevision,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }],
    sources: [{ sourceId: 'fixture-source', url: 'https://example.invalid/fixture', title: '架空の検証資料', retrievedAt: new Date().toISOString(), text: FACT, kind: 'fixture' }],
    trace: [], reasonCode: 'fixture', message: '検証用の結果です。',
    usage: { llm: 0, searches: 0, pages: 0, elapsedMs: 1, reservedUsd: 0, actualUsd: null, costKnown: false },
  };
}
const resultResponse = (input: ResearchInput) => new Response(`${JSON.stringify({ type: 'result', result: researchResult(input.requestId, input.subjectRevision) })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } });

let fetchMock: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;
const routes = new Map<string, (init: RequestInit) => Promise<Response>>();
let documentEvents: MockInstance<typeof document.addEventListener>;
let windowEvents: MockInstance<typeof window.addEventListener>;
function requests(path: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url) === path).map(([, init]) => init!);
}
async function boot() { await import('../src/main.ts'); await flush(); }
function chooseLiveAndConsent() {
  element<HTMLSelectElement>('mode').value = 'live';
  element('mode').dispatchEvent(new Event('change'));
  element<HTMLInputElement>('consent').checked = true;
  element('consent').dispatchEvent(new Event('change'));
}
async function recordPhone() {
  chooseLiveAndConsent();
  click('record'); await flush();
  expect(devices.phone!.start).toHaveBeenCalledOnce();
  devices.phone!.options.onAudio(new Uint8Array([0, 0, 255, 127]));
}
function delayPhoneStop() {
  const gate = deferred<void>();
  devices.phone!.stop.mockImplementation(() => {
    const phone = devices.phone!;
    if (phone.recording) { phone.recording = false; phone.options.onStopped('user'); }
    return gate.promise;
  });
  return gate;
}

describe('main UI lifecycle regressions — DOM actions and outgoing requests, mocked devices/API', () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T02:00:00Z'));
    routes.clear(); devices.g2 = null; devices.phone = null;
    document.body.innerHTML = '<div id="app"></div>';
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    documentEvents = vi.spyOn(document, 'addEventListener');
    windowEvents = vi.spyOn(window, 'addEventListener');
    fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      const route = routes.get(path);
      if (route) return route(init);
      if (path === '/api/status') return jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, xEnabled: false, accessCodeRequired: false, version: 'fixture' });
      if (path === '/api/session') return jsonResponse(init.method === 'DELETE' ? {} : { token: 'fixture-session-token', revision: 3, expiresAt: Date.now() + 900_000, hasPrevious: true, interrupted: false });
      if (path === '/api/transcribe') return jsonResponse({ text: '架空検証社の架空の検証参加者です。' });
      if (path === '/api/research') return resultResponse(JSON.parse(String(init.body)) as ResearchInput);
      if (path === '/api/cancel') return jsonResponse({ cancelled: true });
      throw new Error(`Unexpected test request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    // resetModules does not unregister listeners installed by a side-effect entry point.
    for (const [type, listener, options] of documentEvents.mock.calls) {
      if (type === 'visibilitychange') document.removeEventListener(type, listener, options);
    }
    for (const [type, listener, options] of windowEvents.mock.calls) {
      if (type === 'pagehide') window.removeEventListener(type, listener, options);
    }
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('normal explicit phone stop sends one WAV and displays the researched card without touching G2 audio', async () => {
    await boot(); await recordPhone();
    click('record'); await flush();
    expect(requests('/api/transcribe')).toHaveLength(1);
    const upload = requests('/api/transcribe')[0]!;
    expect(new Headers(upload.headers).get('Content-Type')).toBe('audio/wav');
    expect((upload.body as Blob).size).toBe(48);
    expect(requests('/api/research')).toHaveLength(1);
    expect(element('fact').textContent).toBe(FACT);
    expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
  });

  it('shows an actionable error and permits retry when an explicit stop captured no audio', async () => {
    await boot(); chooseLiveAndConsent();
    click('record'); await flush();
    expect(devices.phone!.start).toHaveBeenCalledOnce();
    click('record'); await flush();
    expect(requests('/api/transcribe')).toHaveLength(0);
    expect(requests('/api/research')).toHaveLength(0);
    expect(element('status').textContent).toContain('音声を取得できませんでした');
    expect(element('status').classList.contains('error')).toBe(true);
    expect(element('record').textContent).toBe('音声で入力');
    expect(element<HTMLButtonElement>('record').disabled).toBe(false);
    click('record'); await flush();
    devices.phone!.options.onAudio(new Uint8Array([0, 0, 255, 127]));
    click('record'); await flush();
    expect(requests('/api/transcribe')).toHaveLength(1);
    expect(element('fact').textContent).toBe(FACT);
  });

  it.each(['cancel', 'consent', 'pagehide'] as const)('never sends audio after %s while microphone stop is pending', async action => {
    await boot(); await recordPhone();
    const stopped = delayPhoneStop();
    click('record'); await flush();
    expect(requests('/api/transcribe')).toHaveLength(0);
    expect(element<HTMLButtonElement>('record').disabled).toBe(true);
    if (action === 'cancel') click('cancel');
    else if (action === 'consent') {
      element<HTMLInputElement>('consent').checked = false;
      element('consent').dispatchEvent(new Event('change'));
    } else window.dispatchEvent(new Event('pagehide'));
    stopped.resolve(); await flush();
    expect(requests('/api/transcribe')).toHaveLength(0);
    expect(requests('/api/research')).toHaveLength(0);
    expect(element('fact').textContent).not.toBe(FACT);
    expect(element('status').classList.contains('error')).toBe(false);
  });

  it('leaving the page during active recording stops hardware without starting transcription', async () => {
    await boot(); await recordPhone();
    window.dispatchEvent(new Event('pagehide')); await flush();
    expect(devices.phone!.stop).toHaveBeenCalled();
    expect(devices.g2!.dispose).toHaveBeenCalled();
    expect(requests('/api/transcribe')).toHaveLength(0);
    expect(requests('/api/research')).toHaveLength(0);
  });

  it('does not stop a new recording when an obsolete microphone start resolves late', async () => {
    await boot(); chooseLiveAndConsent();
    const oldStart = deferred<boolean>();
    devices.phone!.start.mockReturnValueOnce(oldStart.promise);
    click('record'); await flush(); click('cancel'); await flush();
    click('record'); await flush();
    const stopsBeforeLateResult = devices.phone!.stop.mock.calls.length;
    oldStart.resolve(false); await flush();
    expect(devices.phone!.stop).toHaveBeenCalledTimes(stopsBeforeLateResult);
    expect(devices.phone!.recording).toBe(true);
    expect(element('record').textContent).toBe('録音を止めて調べる');
    devices.phone!.options.onAudio(new Uint8Array([0, 0]));
    click('record'); await flush();
    expect(requests('/api/transcribe')).toHaveLength(1);
    expect(element('fact').textContent).toBe(FACT);
  });

  it('cancels a pending G2 stop without sending its retained audio', async () => {
    await boot(); chooseLiveAndConsent();
    click('connect'); await flush(); click('record'); await flush();
    devices.g2!.options.onAudio?.(new Uint8Array([0, 0, 255, 127]));
    const stopped = deferred<boolean>();
    devices.g2!.stopAudio.mockReturnValue(stopped.promise);
    click('record'); await flush(); click('cancel');
    stopped.resolve(true); await flush();
    expect(requests('/api/transcribe')).toHaveLength(0);
    expect(devices.phone!.start).not.toHaveBeenCalled();
  });

  it('ignores a late transcription response after cancellation and sends no research', async () => {
    const response = deferred<Response>();
    routes.set('/api/transcribe', () => response.promise);
    await boot(); await recordPhone(); click('record'); await flush();
    const upload = requests('/api/transcribe')[0]!;
    click('cancel'); await flush();
    expect(upload.signal?.aborted).toBe(true);
    response.resolve(jsonResponse({ text: 'THIS CANCELLED TRANSCRIPT MUST NOT APPEAR' })); await flush();
    expect(element<HTMLTextAreaElement>('text').value).not.toContain('CANCELLED');
    expect(requests('/api/research')).toHaveLength(0);
  });

  it('shows a valid explicitly resumed card as a positive control', async () => {
    routes.set('/api/session/resume', async () => jsonResponse({ result: researchResult() }));
    await boot(); click('resume'); await flush();
    expect(element('fact').textContent).toBe(FACT);
    expect(element('card-count').textContent).toBe('1 / 1');
    expect(devices.phone!.start).not.toHaveBeenCalled();
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
  });

  it.each([0, 0.00846])('keeps the reserved cost primary when a live result reports preliminary USD %s', async reportedUsd => {
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      const result = researchResult(input.requestId, input.subjectRevision);
      result.usage = { ...result.usage, reservedUsd: 0.063, reportedUsd, reportedCostCalls: 1 };
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`);
    });
    await boot(); chooseLiveAndConsent();
    element<HTMLTextAreaElement>('text').value = '架空検証社の架空の検証参加者';
    click('research'); await flush();
    expect(element('fact').textContent).toBe(FACT);
    expect(element('metric-cost').textContent).toBe('$0.063');
    expect(element('cost-label').textContent).toBe(`実費未確定・上限額を留保 / 一部API報告額（暫定）$${reportedUsd.toFixed(6)}`);
    expect(element('cost-label').textContent).not.toContain('計測された費用');
  });

  it('keeps a demo visibly simulated even if cost metadata is present', async () => {
    const result = researchResult();
    result.mode = 'demo';
    result.usage = { ...result.usage, reservedUsd: 0.063, actualUsd: 0.00846, costKnown: true,
      reportedUsd: 0.00846, reportedCostCalls: 1 };
    routes.set('/api/session/resume', async () => jsonResponse({ result }));
    await boot(); click('resume'); await flush();
    expect(element('fact').textContent).toBe(FACT);
    expect(element('metric-cost').textContent).toBe('模擬');
    expect(element('cost-label').textContent).toBe('実費は未計測');
    expect(element('result-note').textContent).toContain('架空の人物・固定資料によるデモ');
    expect(element('cost-label').textContent).not.toContain('API報告額');
  });

  it.each(['new-recording', 'mode-change', 'end-session'] as const)('discards a late resume response after %s, on both phone and glasses', async action => {
    const response = deferred<Response>();
    routes.set('/api/session/resume', () => response.promise);
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    expect(requests('/api/session/resume')).toHaveLength(1);
    if (action === 'new-recording') { chooseLiveAndConsent(); click('record'); }
    else if (action === 'mode-change') chooseLiveAndConsent();
    else click('end');
    await flush();
    response.resolve(jsonResponse({ result: researchResult() })); await flush();
    expect(element('fact').textContent).not.toBe(FACT);
    expect(element('card-count').textContent).toBe('0 / 0');
    expect(devices.g2!.render.mock.calls.some(([view]) => (view as GlassesView).content.includes(FACT))).toBe(false);
    expect(requests('/api/transcribe')).toHaveLength(0);
  });

  it('uses a newer request ID and revision after cancellation and rejects the obsolete result', async () => {
    const firstResponse = deferred<Response>();
    let firstInput: ResearchInput | undefined;
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      if (!firstInput) { firstInput = input; return firstResponse.promise; }
      return resultResponse(input);
    });
    await boot();
    element<HTMLTextAreaElement>('text').value = '架空検証社の架空の検証参加者';
    click('research'); await flush(); click('cancel'); await flush();
    const first = requests('/api/research')[0]!;
    expect(first.signal?.aborted).toBe(true);
    click('research'); await flush();
    expect(requests('/api/research')).toHaveLength(2);
    const next = JSON.parse(String(requests('/api/research')[1]!.body)) as ResearchInput;
    expect(next.requestId).not.toBe(firstInput!.requestId);
    expect(next.subjectRevision).toBeGreaterThan(firstInput!.subjectRevision);
    const cancelled = JSON.parse(String(requests('/api/cancel')[0]!.body)) as { requestId: string; subjectRevision: number };
    expect(cancelled).toEqual({ requestId: firstInput!.requestId, subjectRevision: firstInput!.subjectRevision });
    const obsolete = researchResult(firstInput!.requestId, firstInput!.subjectRevision);
    obsolete.cards[0]!.fact = 'OBSOLETE CARD MUST NOT APPEAR';
    firstResponse.resolve(new Response(`${JSON.stringify({ type: 'result', result: obsolete })}\n`)); await flush();
    expect(element('fact').textContent).toBe(FACT);
    expect(document.body.textContent).not.toContain('OBSOLETE CARD');
  });

  it('does not replay old cards when G2 reconnects after a background interruption', async () => {
    routes.set('/api/session/resume', async () => jsonResponse({ result: researchResult() }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    expect(element('fact').textContent).toBe(FACT);
    devices.g2!.render.mockClear();
    devices.g2!.options.onStatus?.({ state: 'background', reason: 'background' });
    devices.g2!.options.onStatus?.({ state: 'connected', reason: 'resume_required' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(element('fact').textContent).not.toBe(FACT);
    expect(devices.g2!.render.mock.calls.some(([view]) => (view as GlassesView).content.includes(FACT))).toBe(false);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
  });
});
