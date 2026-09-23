// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { G2RuntimeOptions, GlassesView } from '../src/integrations/g2-runtime.ts';
import type { PhoneAudioOptions } from '../src/phone-audio.ts';
import type { StreamingAudioOptions } from '../src/streaming-audio.ts';
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
interface MockStreaming {
  options: StreamingAudioOptions;
  start: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}
const devices = vi.hoisted(() => ({ g2: null as MockG2 | null, phone: null as MockPhone | null, streaming: null as MockStreaming | null }));
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
vi.mock('../src/streaming-audio.ts', () => ({
  StreamingAudio: class implements MockStreaming {
    constructor(public options: StreamingAudioOptions) { devices.streaming = this; }
    start = vi.fn(async (_ticket: string) => true);
    append = vi.fn();
    cancel = vi.fn(() => { this.options.onClose?.(); });
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
function openResearchStreams() {
  const streams: Array<{ input: ResearchInput; signal: AbortSignal; body: ReadableStreamDefaultController<Uint8Array> }> = [];
  routes.set('/api/research', async init => new Response(new ReadableStream<Uint8Array>({
    start(body) { streams.push({ input: JSON.parse(String(init.body)) as ResearchInput, signal: init.signal as AbortSignal, body }); },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
  return streams;
}
function pushResearchEvent(body: ReadableStreamDefaultController<Uint8Array>, event: unknown) {
  body.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
}
function fourCardResult(input: ResearchInput, prefix = '速報', reasonCode = 'PROGRESSIVE_QUICK'): ResearchResult {
  const value = researchResult(input.requestId, input.subjectRevision);
  value.reasonCode = reasonCode;
  const original = value.cards[0]!; const source = value.sources[0]!;
  value.cards = Array.from({ length: 4 }, (_, index) => ({ ...original,
    cardId: `fixture-card-${index}`, sourceId: `fixture-source-${index}`, fact: `架空の${prefix}${index + 1}です。`, excerpt: `架空の${prefix}${index + 1}です。`,
  }));
  value.sources = value.cards.map(card => ({ ...source, sourceId: card.sourceId, text: card.fact }));
  return value;
}
async function boot() { await import('../src/main.ts'); await flush(); }
function chooseLive() {
  element<HTMLSelectElement>('mode').value = 'live';
  element('mode').dispatchEvent(new Event('change'));
}
async function recordPhone() {
  chooseLive();
  click('record'); await flush();
  expect(devices.phone!.start).toHaveBeenCalledOnce();
  devices.phone!.options.onAudio(new Uint8Array([0, 0, 255, 127]));
}
async function selectLatestPerson() { click('show-latest'); await flush(); }
async function confirmGlassesAudioAction() {
  devices.g2!.options.onAction?.('previous'); await flush();
  devices.g2!.options.onAction?.('primary'); await flush();
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
    routes.clear(); devices.g2 = null; devices.phone = null; devices.streaming = null;
    window.history.replaceState(null, '', '/');
    document.body.innerHTML = '<div id="app"></div>';
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    documentEvents = vi.spyOn(document, 'addEventListener');
    windowEvents = vi.spyOn(window, 'addEventListener');
    fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      const route = routes.get(path);
      if (route) return route(init);
      if (path === '/api/status') return jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, streamingEnabled: true, xEnabled: false, accessCodeRequired: false, version: 'fixture' });
      if (path === '/api/session') return jsonResponse(init.method === 'DELETE' ? {} : { token: 'fixture-session-token', revision: 3, expiresAt: Date.now() + 900_000, hasPrevious: true, interrupted: false });
      if (path === '/api/session/restore') return new Response('{}', { status: 401 });
      if (path === '/api/session/forget') return jsonResponse({ ended: true });
      if (path === '/api/conversation') return jsonResponse({ conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab', expiresAt: Date.now() + 900_000 });
      if (path === '/api/conversation/reset') return jsonResponse({ revision: 6, resetAt: Date.now() });
      if (path === '/api/conversation/keepalive') return jsonResponse({ expiresAt: Date.now() + 900_000, revision: 3 });
      if (path === '/api/conversation/stream') return jsonResponse({ ticket: 'fixture-stream-ticket' });
      if (path === '/api/conversation/identify') return jsonResponse({ text: '架空検証社の架空の検証参加者です。', targets: [{ personName: '架空の検証参加者', companyName: '架空検証社' }], hasPersonMention: true });
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


  describe('recognized-person history navigation', () => {
    const names = ['架空参加者あ', '架空参加者い', '架空参加者う', '架空参加者え', '架空参加者お', '架空参加者か'];
    const target = (name: string) => ({ personName: name, companyName: '架空会社' });
    const view = () => devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    const people = () => [...element('people-list').querySelectorAll<HTMLButtonElement>('button')];
    function namedResult(input: ResearchInput, name: string): ResearchResult {
      const value = fourCardResult(input, name, 'COMPLETE'); value.target = target(name); return value;
    }
    function fixtures() {
      routes.set('/api/conversation/identify', async init => {
        const text = (JSON.parse(String(init.body)) as { text: string }).text;
        return jsonResponse({ text, targets: names.filter(name => text.includes(name)).map(target), hasPersonMention: true });
      });
      routes.set('/api/research', async init => {
        const input = JSON.parse(String(init.body)) as ResearchInput;
        const name = names.find(name => input.text.includes(name))!;
        return new Response(`${JSON.stringify({ type: 'result', result: namedResult(input, name) })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } });
      });
    }
    async function start() { fixtures(); await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush(); }
    async function say(index: number, item = `speech-${index}`) { devices.streaming!.options.onFinal(item, names[index]!); await flush(); }
    async function action(value: 'primary' | 'secondary' | 'next' | 'previous') { devices.g2!.options.onAction?.(value); await flush(); }

    it('starts on an empty list and keeps recognition and results there until a person is explicitly selected', async () => {
      await start(); const voice = devices.streaming!;
      expect(view().header).toContain('認識した人物 0/0');
      expect(view().textSize).toBeUndefined();
      expect(people()).toHaveLength(0); expect(element('sources').children).toHaveLength(0);
      expect(element('card-count').textContent).toBe('0 / 0');
      await say(0); await say(1);
      expect(people()).toHaveLength(2);
      expect(view().header).toContain('認識した人物');
      expect(view().content).toContain(names[0]); expect(view().content).toContain(names[1]);
      expect(view().content).not.toContain('⭐️推奨質問：');
      expect(element('sources').children).toHaveLength(0); expect(element('card-count').textContent).toBe('0 / 0');
      const paid = requests('/api/research').length; const identifies = requests('/api/conversation/identify').length;
      await action('next'); expect(view().content).toContain(`→ 2 ${names[1]}`);
      await action('previous'); expect(view().content).toContain(`→ 1 ${names[0]}`);
      await action('next'); await action('primary');
      expect(view().header).toContain(names[1]); expect(element('hud-target').textContent).toBe(names[1]);
      expect(view().content).toContain('⭐️推奨質問：');
      expect(view().textSize).toBe('small');
      await action('secondary'); expect(view().header).toContain('認識した人物');
      expect(view().textSize).toBeUndefined();
      expect(element('sources').children).toHaveLength(0); expect(element('card-count').textContent).toBe('0 / 0');
      expect(requests('/api/research')).toHaveLength(paid); expect(requests('/api/conversation/identify')).toHaveLength(identifies);
      await say(2);
      expect(people()).toHaveLength(3); expect(view().header).toContain('認識した人物');
      expect(element('sources').children).toHaveLength(0); expect(element('card-count').textContent).toBe('0 / 0');
      expect(requests('/api/research')).toHaveLength(paid + 1);
      expect(requests('/api/conversation/reset')).toHaveLength(0); expect(requests('/api/conversation')).toHaveLength(1);
      expect(voice.cancel).not.toHaveBeenCalled(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
      devices.g2!.options.onAudio?.(new Uint8Array([1, 2])); expect(voice.append).toHaveBeenCalled();
    });

    it('selects the latest person only on an explicit click and never follows the next recognized person', async () => {
      await start(); await say(0); click('show-latest'); await flush();
      expect(element('hud-target').textContent).toBe(names[0]);
      await say(1);
      expect(element('hud-target').textContent).toBe(names[0]); expect(view().header).toContain(names[0]);
      click('show-latest'); await flush(); expect(element('hud-target').textContent).toBe(names[1]);
      await say(2);
      expect(element('hud-target').textContent).toBe(names[1]); expect(view().header).toContain(names[1]);
      expect(requests('/api/research')).toHaveLength(3); expect(requests('/api/conversation/reset')).toHaveLength(0);
      expect(devices.streaming!.cancel).not.toHaveBeenCalled();
    });

    it('keeps the selected person after an explicit audio retry until another person is selected', async () => {
      await start(); await say(0); people()[0]!.click(); await flush();
      const voice = devices.streaming!; const original = view().content;
      await confirmGlassesAudioAction();
      expect(requests('/api/conversation/reset')).toHaveLength(1);
      expect(view().header).toContain(names[0]); expect(view().content).toBe(original);
      await say(1);
      expect(people()).toHaveLength(2); expect(requests('/api/research')).toHaveLength(2);
      expect(view().header).toContain(names[0]); expect(view().content).toBe(original);
      expect(element('hud-target').textContent).toBe(names[0]);
      await selectLatestPerson(); expect(view().header).toContain(names[1]);
      expect(requests('/api/research')).toHaveLength(2); expect(requests('/api/conversation')).toHaveLength(1);
      expect(voice.cancel).not.toHaveBeenCalled(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
    });

    it('appends in recognition order and keeps selected questions and excerpts while other people arrive, with no extra search or ASR reset', async () => {
      await start(); const voice = devices.streaming!;
      await say(0); await say(1); await say(1, 'repeated');
      expect(people()).toHaveLength(2); expect(people()[0]!.textContent).toContain(names[0]); expect(people()[1]!.textContent).toContain(names[1]);
      expect(requests('/api/research')).toHaveLength(2);
      people()[0]!.click(); await flush();
      expect(element('hud-target').textContent).toBe(names[0]); expect(element('sources').textContent).toContain(names[0]);
      await action('next'); expect(view().footer).toContain('出典へ進む？');
      await say(2); expect(view().footer).toContain('出典へ進む？');
      await action('secondary'); expect(view().header).toContain(names[0]);
      expect(people()).toHaveLength(3); expect(view().header).toContain(names[0]); expect(view().content).not.toContain(names[2]);
      await action('next'); await action('primary'); const excerpt = view().content;
      expect(view().textSize).toBe('small');
      expect(view().header).toContain('該当文');
      await say(3);
      expect(view().header).toContain('該当文'); expect(view().content).toBe(excerpt); expect(element('sources').textContent).toContain(names[0]);
      expect(requests('/api/research')).toHaveLength(4); expect(requests('/api/conversation/reset')).toHaveLength(0);
      expect(voice.cancel).not.toHaveBeenCalled(); expect(devices.g2!.startAudio).toHaveBeenCalledOnce(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
      click('show-latest'); await flush(); expect(view().header).toContain(names[3]);
    });

    it('pages through the person list, preserves focus on new arrivals, opens with one tap and returns source → questions → list with double taps', async () => {
      await start(); for (let index = 0; index < 5; index++) await say(index);
      await action('secondary'); expect(view().header).toBe('認識した人物 1/5');
      expect(view().content).toContain(names[0]); expect(view().content).not.toContain(names[4]);
      await action('previous'); expect(view().header).toBe('認識した人物 1/5');
      for (let index = 0; index < 4; index++) await action('next');
      expect(view().header).toBe('認識した人物 5/5'); expect(view().content).toContain(names[4]);
      await say(5); expect(view().header).toBe('認識した人物 5/6');
      await action('secondary'); expect(view().header).toBe('認識した人物 5/6');
      await action('primary'); expect(view().header).toContain(names[4]);
      await action('next'); expect(view().footer).toContain('出典へ進む？');
      await action('secondary'); expect(view().header).toContain(names[4]); expect(view().header).not.toContain('認識した人物');
      await action('next'); await action('primary'); expect(view().header).toContain('該当文');
      await action('secondary'); expect(view().header).toContain(names[4]); expect(view().header).not.toContain('該当文');
      await action('previous'); expect(view().footer).toContain('人物を聞き直す？');
      await action('secondary'); expect(view().header).toContain(names[4]);
      await action('secondary'); expect(view().header).toBe('認識した人物 5/6');
      expect(requests('/api/conversation/reset')).toHaveLength(0); expect(requests('/api/research')).toHaveLength(6);
      expect(devices.streaming!.cancel).not.toHaveBeenCalled();
    });

    it('lists every extracted ambiguous person without invented questions or launching research on selection', async () => {
      await start(); devices.streaming!.options.onFinal('both', `${names[0]}と${names[1]}`); await flush();
      expect(people()).toHaveLength(2); expect(people()[0]!.textContent).toContain('未確認'); expect(requests('/api/research')).toHaveLength(0);
      people()[1]!.click(); await flush(); expect(element('hud-target').textContent).toBe(names[1]);
      expect(element('sources').textContent).toBe(''); expect(element('card-board').querySelectorAll('.topic-card:not(.empty)')).toHaveLength(0);
      expect(view().content).toContain('未確認'); expect(view().header).toBe(names[1]);
      await action('secondary'); await action('primary'); expect(view().header).toBe(names[1]);
      expect(requests('/api/research')).toHaveLength(0); expect(requests('/api/conversation/reset')).toHaveLength(0);
    });

    it('does not select the latest search candidates from an unconfirmed historical person', async () => {
      await start(); devices.streaming!.options.onFinal('both', `${names[0]}と${names[1]}`); await flush();
      people()[0]!.click(); await flush();
      const choices = [{ id: 'latest-candidate', label: '別の候補', query: names[2], target: target(names[2]!) }];
      routes.set('/api/conversation/identify', async () => jsonResponse({ text: names[2], targets: [], hasPersonMention: true, searchCandidates: choices }));
      await say(2); await action('next'); await action('primary');
      expect(view().header).toBe(names[0]); expect(view().footer).not.toContain('候補を選ぶ');
      expect(requests('/api/conversation/search-choice')).toHaveLength(0); expect(requests('/api/research')).toHaveLength(0);
    });

    it('keeps the list visible during progressive updates and opens the selected person’s final snapshot', async () => {
      await start(); const streams = openResearchStreams(); await say(0);
      await action('secondary'); expect(view().header).toContain('認識した人物');
      pushResearchEvent(streams[0]!.body, { type: 'update', result: namedResult(streams[0]!.input, names[0]!) }); await flush();
      expect(view().header).toContain('認識した人物'); expect(view().content).toContain('質問あり');
      const final = namedResult(streams[0]!.input, names[0]!); final.cards[0]!.fact = '追加確認した架空の事実です。'; final.cards[0]!.excerpt = final.cards[0]!.fact;
      pushResearchEvent(streams[0]!.body, { type: 'result', result: final }); streams[0]!.body.close(); await flush();
      expect(view().header).toContain('認識した人物'); await action('primary'); expect(element('fact').textContent).toBe(final.cards[0]!.fact);
    });

    it('does not label a historical person as fixed or save a rejected mismatched result while another person is locked', async () => {
      await start(); await say(0); const streams = openResearchStreams(); await say(1);
      const work = streams[0]!; pushResearchEvent(work.body, { type: 'update', result: namedResult(work.input, names[1]!) }); await flush();
      await selectLatestPerson();
      click('lock-person'); await flush(); expect(element('hud-target').textContent).toContain('固定：');
      people()[0]!.click(); await flush(); expect(element('hud-target').textContent).toBe(names[0]); expect(view().header).not.toContain('固定');
      expect(element<HTMLButtonElement>('lock-person').disabled).toBe(true);
      pushResearchEvent(work.body, { type: 'result', result: namedResult(work.input, names[2]!) }); work.body.close(); await flush();
      expect(people()).toHaveLength(2); expect(element('people-list').textContent).not.toContain(names[2]); expect(view().header).toContain(names[0]);
      click('show-latest'); await flush(); expect(element('hud-target').textContent).toBe(`固定：${names[1]}`);
    });

    it('discards expired card content and pending source navigation while retaining the unconfirmed person entry', async () => {
      await start(); await say(0); people()[0]!.click(); await flush(); await action('next'); await action('primary');
      expect(view().header).toContain('該当文'); await action('next');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(people()).toHaveLength(1); expect(people()[0]!.textContent).toContain('有効な質問なし');
      expect(element('sources').textContent).toBe(''); expect(element('card-board').textContent).not.toContain(names[0]);
      expect(view().header).toBe(names[0]); expect(view().footer).not.toContain('出典へ進む？');
      await action('primary'); expect(view().header).not.toContain('該当文');
    });

    it('removes a selected person at the fixed retention deadline without leaving stale question or source DOM', async () => {
      await start();
      routes.set('/api/research', async init => {
        const value = namedResult(JSON.parse(String(init.body)) as ResearchInput, names[0]!);
        for (const card of value.cards) card.expiresAt = new Date(Date.now() + 1_800_000).toISOString();
        return new Response(`${JSON.stringify({ type: 'result', result: value })}\n`);
      });
      await say(0); people()[0]!.click(); await flush(); expect(element('sources').textContent).toContain(names[0]);
      await vi.advanceTimersByTimeAsync(900_000);
      expect(people()).toHaveLength(0); expect(view().header).toContain('認識した人物 0/0');
      expect(element('sources').textContent).toBe(''); expect(element('card-board').textContent).not.toContain(names[0]);
      expect(devices.streaming!.cancel).not.toHaveBeenCalled();
    });

    it.each(['cancel', 'background', 'pagehide', 'end', 'g2-background', 'g2-disconnected', 'g2-error', 'auth-expired', 'asr-error'] as const)('clears selected history on %s and rejects late identification and research', async stop => {
      await start(); await say(0); people()[0]!.click(); await flush();
      const streams = openResearchStreams(); await say(1);
      const delayed = deferred<Response>(); routes.set('/api/conversation/identify', () => delayed.promise);
      await say(2); const oldVoice = devices.streaming!;
      if (stop === 'background') { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); }
      else if (stop === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      else if (stop.startsWith('g2-')) devices.g2!.options.onStatus?.({ state: stop === 'g2-background' ? 'background' : stop === 'g2-error' ? 'error' : 'disconnected' });
      else if (stop === 'asr-error') oldVoice.options.onError(new Error('音声の接続が切れました。'));
      else if (stop === 'auth-expired') { routes.set('/api/conversation/keepalive', async () => new Response('{}', { status: 401 })); await vi.advanceTimersByTimeAsync(60_000); }
      else click(stop);
      await flush();
      delayed.resolve(jsonResponse({ text: names[2], targets: [target(names[2]!)], hasPersonMention: true }));
      pushResearchEvent(streams[0]!.body, { type: 'result', result: namedResult(streams[0]!.input, names[1]!) }); streams[0]!.body.close();
      oldVoice.options.onFinal('too-late', names[3]!); await flush();
      expect(people()).toHaveLength(0); expect(element('sources').textContent).toBe(''); expect(element('card-board').textContent).not.toContain(names[0]);
    });

    it.each(['background', 'disconnected'] as const)('clears history and rejects late identification when G2 becomes %s while using the phone microphone', async state => {
      await start(); click('cancel'); await flush(); element<HTMLSelectElement>('microphone').value = 'phone'; click('conversation'); await flush();
      await say(0); people()[0]!.click(); await flush();
      const delayed = deferred<Response>(); routes.set('/api/conversation/identify', () => delayed.promise); await say(1);
      devices.g2!.options.onStatus?.({ state }); await flush();
      delayed.resolve(jsonResponse({ text: names[1], targets: [target(names[1]!)], hasPersonMention: true })); await flush();
      expect(people()).toHaveLength(0); expect(element('sources').textContent).toBe(''); expect(devices.phone!.recording).toBe(false);
    });
  });

  it('renders four verified updates on phone and G2 before the research stream closes, then replaces them with final cards', async () => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush();
    element<HTMLTextAreaElement>('text').value = '架空検証社の架空の検証参加者'; click('research'); await flush();
    const stream = streams[0]!;
    pushResearchEvent(stream.body, { type: 'update', result: fourCardResult(stream.input) }); await flush();
    expect(element('status').textContent).toContain('速報・追加調査中');
    expect(element('card-board').querySelectorAll('.topic-card:not(.empty)')).toHaveLength(4);
    expect(element('fact').textContent).toBe('架空の速報1です。');
    expect(element<HTMLButtonElement>('research').disabled).toBe(true);
    const quickView = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(quickView.header).toContain('速報・追加調査中'); expect(quickView.content).toContain('架空の速報4です。');
    pushResearchEvent(stream.body, { type: 'result', result: fourCardResult(stream.input, '確定', 'EVIDENCE_VERIFIED') }); stream.body.close(); await flush();
    expect(element('fact').textContent).toBe('架空の確定1です。');
    expect(element('status').textContent).not.toContain('追加調査中');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).header).not.toContain('追加調査中');
    expect(element<HTMLButtonElement>('research').disabled).toBe(false);
  });

  it('ignores update events for a different request or revision without closing the current stream', async () => {
    const streams = openResearchStreams();
    await boot(); click('connect'); await flush(); element<HTMLTextAreaElement>('text').value = '架空の検証参加者'; click('research'); await flush();
    const stream = streams[0]!;
    pushResearchEvent(stream.body, { type: 'update', result: fourCardResult({ ...stream.input, requestId: 'wrong-request-id' }, '旧ID') });
    pushResearchEvent(stream.body, { type: 'update', result: fourCardResult({ ...stream.input, subjectRevision: stream.input.subjectRevision + 1 }, '旧版') }); await flush();
    expect(element('fact').textContent).toBe('未確認');
    expect(devices.g2!.render.mock.calls.some(([view]) => /旧ID|旧版/.test((view as GlassesView).content))).toBe(false);
    pushResearchEvent(stream.body, { type: 'result', result: fourCardResult(stream.input) }); stream.body.close(); await flush();
    expect(element('fact').textContent).toBe('架空の速報1です。');
  });

  it.each(['cancel', 'end', 'mode-change'] as const)('clears progressive cards after %s and discards late stream updates on phone and glasses', async action => {
    const streams = openResearchStreams();
    await boot(); click('connect'); await flush(); element<HTMLTextAreaElement>('text').value = '架空の検証参加者'; click('research'); await flush();
    const stream = streams[0]!;
    pushResearchEvent(stream.body, { type: 'update', result: fourCardResult(stream.input) }); await flush();
    expect(element('fact').textContent).toBe('架空の速報1です。');
    if (action === 'mode-change') chooseLive(); else click(action);
    await flush(); devices.g2!.render.mockClear();
    pushResearchEvent(stream.body, { type: 'update', result: fourCardResult(stream.input, '古い追加情報') }); stream.body.close(); await flush();
    expect(element('fact').textContent).toBe('未確認'); expect(element('sources').textContent).toBe('');
    expect(devices.g2!.render.mock.calls.some(([view]) => (view as GlassesView).content.includes('古い追加情報'))).toBe(false);
  });

  it.each(['disconnect', 'error-event', 'failed-result'] as const)('preserves verified cards when an open enrichment stream ends with %s', async outcome => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('first', '架空の検証参加者'); await flush();
    const stream = streams[0]!;
    pushResearchEvent(stream.body, { type: 'update', result: fourCardResult(stream.input, '確かな話題', 'PROGRESSIVE_ENRICHING') }); await flush();
    await selectLatestPerson();
    if (outcome === 'error-event') pushResearchEvent(stream.body, { type: 'error', code: 'PROVIDER_TIMEOUT', message: '追加調査が時間切れでした。' });
    if (outcome === 'failed-result') {
      const failed = researchResult(stream.input.requestId, stream.input.subjectRevision);
      failed.status = 'failed'; failed.cards = []; failed.reasonCode = 'PROVIDER_TIMEOUT';
      pushResearchEvent(stream.body, { type: 'result', result: failed });
    }
    stream.body.close(); await flush();
    expect(element('fact').textContent).toBe('架空の確かな話題1です。');
    expect(element('status').textContent).toContain('確認済みの話題を表示しています');
    expect(element('status').textContent).not.toContain('追加調査中');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).toContain('架空の確かな話題4です。');
    expect(devices.streaming!.cancel).not.toHaveBeenCalled(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
  });

  it('removes progressive cards and their source details when identity confirmation is later required', async () => {
    const streams = openResearchStreams();
    await boot(); click('connect'); await flush(); element<HTMLTextAreaElement>('text').value = '架空の検証参加者'; click('research'); await flush();
    const stream = streams[0]!;
    pushResearchEvent(stream.body, { type: 'update', result: fourCardResult(stream.input) }); await flush();
    const ambiguous = researchResult(stream.input.requestId, stream.input.subjectRevision);
    ambiguous.status = 'awaiting_confirmation'; ambiguous.cards = [];
    ambiguous.candidates = [{ id: 'fixture-candidate', personName: '架空の検証参加者', companyName: '別の架空検証社', reason: '同姓同名', sourceIds: [] }];
    pushResearchEvent(stream.body, { type: 'result', result: ambiguous }); stream.body.close(); await flush();
    expect(element('fact').textContent).toBe('未確認'); expect(element('sources').textContent).toBe('');
    expect(element('candidates').children).toHaveLength(1);
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).header).toContain('相手の確認');
  });

  it('identifies ordinary and same-person speech while enrichment stays open, without cancelling or hiding its cards', async () => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const voice = devices.streaming!; voice.options.onFinal('first', '架空の検証参加者'); await flush();
    const stream = streams[0]!; pushResearchEvent(stream.body, { type: 'update', result: fourCardResult(stream.input) }); await flush();
    await selectLatestPerson();
    voice.options.onFinal('same', '架空の検証参加者'); await flush();
    routes.set('/api/conversation/identify', async () => jsonResponse({ text: '良い天気ですね', targets: [], hasPersonMention: false }));
    voice.options.onFinal('ordinary', '良い天気ですね'); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(3); expect(streams).toHaveLength(1);
    expect(stream.signal.aborted).toBe(false); expect(element('fact').textContent).toBe('架空の速報1です。');
    expect(element('status').textContent).toContain('速報・追加調査中'); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
    pushResearchEvent(stream.body, { type: 'result', result: fourCardResult(stream.input, '最終', 'EVIDENCE_VERIFIED') }); stream.body.close(); await flush();
    expect(element('fact').textContent).toBe('架空の最終1です。');
  });

  it('researches a new person before enrichment finishes, displays them only on selection, and rejects old updates and the old final result', async () => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const voice = devices.streaming!; voice.options.onFinal('first', '架空の検証参加者'); await flush();
    const first = streams[0]!; pushResearchEvent(first.body, { type: 'update', result: fourCardResult(first.input) }); await flush();
    await selectLatestPerson();
    routes.set('/api/conversation/identify', async () => jsonResponse({ text: '別の架空人物です', targets: [{ personName: '別の架空人物', companyName: '' }], hasPersonMention: true }));
    voice.options.onFinal('new-person', '別の架空人物です'); await flush();
    expect(streams).toHaveLength(2); expect(first.signal.aborted).toBe(true); expect(element('fact').textContent).toBe('架空の速報1です。');
    const next = streams[1]!;
    expect(next.input.subjectRevision).toBeGreaterThan(first.input.subjectRevision);
    expect(next.input.requestId).not.toBe(first.input.requestId);
    const nextResult = fourCardResult(next.input, '次の人物'); nextResult.target = { personName: '別の架空人物', companyName: '' };
    pushResearchEvent(next.body, { type: 'update', result: nextResult }); await flush();
    expect(element('fact').textContent).toBe('架空の速報1です。');
    await selectLatestPerson();
    devices.g2!.render.mockClear();
    pushResearchEvent(first.body, { type: 'update', result: fourCardResult(first.input, '以前の人物') });
    pushResearchEvent(first.body, { type: 'result', result: fourCardResult(first.input, '以前の人物', 'EVIDENCE_VERIFIED') }); first.body.close(); await flush();
    expect(element('fact').textContent).toBe('架空の次の人物1です。');
    expect(devices.g2!.render.mock.calls.some(([view]) => (view as GlassesView).content.includes('以前の人物'))).toBe(false);
    pushResearchEvent(next.body, { type: 'result', result: { ...nextResult, reasonCode: 'EVIDENCE_VERIFIED' } }); next.body.close(); await flush();
    expect(devices.streaming!.cancel).not.toHaveBeenCalled();
  });

  it.each(['instagram', 'facebook'] as const)('shows the %s source badge and the actual publication date on enriched cards', async platform => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush();
    element<HTMLTextAreaElement>('text').value = '架空の検証参加者'; click('research'); await flush();
    const stream = streams[0]!; pushResearchEvent(stream.body, { type: 'update', result: fourCardResult(stream.input) }); await flush();
    const final = fourCardResult(stream.input, 'SNS資料', 'EVIDENCE_VERIFIED');
    const source = final.sources[0]!;
    source.kind = platform; source.topic = platform; final.cards[0]!.topic = platform;
    source.url = `https://www.${platform}.com/${platform === 'instagram' ? 'p/fixture-post' : 'fixture-person/posts/123'}`;
    source.socialPost = { platform, authorHandle: 'fixture-person', profileUrl: `https://www.${platform}.com/fixture-person`,
      identitySourceUrl: 'https://example.invalid/verified-person', createdAt: '2025-06-26T07:51:26.000Z', text: final.cards[0]!.fact };
    pushResearchEvent(stream.body, { type: 'result', result: final }); stream.body.close(); await flush();
    const label = platform === 'instagram' ? 'Instagram' : 'Facebook';
    expect(element('topic-0').querySelector('.topic-number')!.textContent).toContain(label);
    expect(element('sources').querySelector('.source-topic')!.textContent).toContain(label);
    expect(element('sources').querySelector('.source-post-date')!.textContent).toContain(new Date(source.socialPost.createdAt).toLocaleString('ja-JP'));
    expect(element('sources').querySelector<HTMLAnchorElement>('a')!.href).toBe(source.url);
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).toContain(label);
    expect(element('status').textContent).not.toContain('追加調査中');
  });

  it('restores a remembered device without showing previous cards or starting work', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, accessCodeRequired: true }));
    routes.set('/api/session/restore', async () => jsonResponse({ token: 'restored', revision: 4, expiresAt: Date.now() + 900_000, hasPrevious: true, interrupted: false }));
    await boot();
    expect(element('workspace').classList.contains('hidden')).toBe(false);
    expect(requests('/api/session')).toHaveLength(0);
    expect(requests('/api/session/restore')).toHaveLength(1);
    expect(requests('/api/session/resume')).toHaveLength(0);
    expect(requests('/api/research')).toHaveLength(0);
    expect(element('fact').textContent).not.toBe(FACT);
    expect(element('resume-notice').classList.contains('hidden')).toBe(false);
    expect(devices.phone!.start).not.toHaveBeenCalled();
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
  });

  it('shows the access code form when no remembered login exists and honors opting out', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, accessCodeRequired: true }));
    await boot();
    expect(element('workspace').classList.contains('hidden')).toBe(true);
    expect(element<HTMLInputElement>('remember-device').checked).toBe(true);
    element<HTMLInputElement>('access-code').value = 'fixture-access-code';
    element<HTMLInputElement>('remember-device').checked = false;
    element('login-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(JSON.parse(String(requests('/api/session')[0]!.body))).toEqual({ accessCode: 'fixture-access-code', rememberDevice: false });
    expect(element('workspace').classList.contains('hidden')).toBe(false);
  });

  it('streams partial text immediately, researches final identities and captures beyond 30 seconds without duplicate searches', async () => {
    let text = { text: '架空検証社の架空の検証参加者です。', targets: [{ personName: '架空の検証参加者', companyName: '架空検証社' }], hasPersonMention: true };
    routes.set('/api/conversation/identify', async () => jsonResponse(text));
    await boot(); chooseLive(); click('conversation'); await flush();
    expect(devices.phone!.start).toHaveBeenCalledWith({ continuous: true });
    const stream = devices.streaming!;
    expect(stream.start).toHaveBeenCalledExactlyOnceWith('fixture-stream-ticket');
    expect(JSON.parse(String(requests('/api/conversation/stream')[0]!.body))).toEqual({ conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab' });
    const pcm = new Uint8Array([0, 1, 2, 3]); devices.phone!.options.onAudio(pcm);
    expect(stream.append).toHaveBeenCalledExactlyOnceWith(pcm);
    stream.options.onDelta('first', '架空検証社の');
    expect(element<HTMLTextAreaElement>('text').value).toBe('架空検証社の');
    stream.options.onDelta('first', '架空の検証参加者です。');
    expect(element<HTMLTextAreaElement>('text').value).toBe(text.text);
    expect(requests('/api/conversation/identify')).toHaveLength(0);
    expect(requests('/api/research')).toHaveLength(0);
    stream.options.onFinal('first', text.text); await flush();
    await selectLatestPerson();
    expect(requests('/api/transcribe')).toHaveLength(0);
    expect(requests('/api/conversation/identify')).toHaveLength(1);
    expect(requests('/api/research')).toHaveLength(1);
    const input = JSON.parse(String(requests('/api/research')[0]!.body));
    expect(input.conversationId).toBe('8a874d7b-6dda-41a2-8a27-d70e440b10ab');
    expect(JSON.parse(String(requests('/api/conversation/identify')[0]!.body)))
      .toMatchObject({ requestId: input.requestId, subjectRevision: input.subjectRevision, conversationId: input.conversationId, text: text.text });
    expect(devices.phone!.recording).toBe(true);
    expect(element<HTMLButtonElement>('record').disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    stream.options.onFinal('second', text.text); await flush();
    expect(requests('/api/research')).toHaveLength(1);
    expect(requests('/api/conversation/identify')).toHaveLength(2);
    expect(devices.phone!.recording).toBe(true);
    text = { text: '今日は良い天気ですね。', targets: [], hasPersonMention: false };
    stream.options.onFinal('weather', text.text); await flush();
    expect(element('card-board').textContent).toContain(FACT);
    text = { text: '別の会社の架空さんも参加します。', targets: [], hasPersonMention: true };
    stream.options.onFinal('other', text.text); await flush();
    expect(element('card-board').textContent).toContain(FACT); // A selected person stays visible while another is unresolved.
    click('record'); await flush();
    expect(devices.phone!.recording).toBe(false);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(JSON.parse(String(requests('/api/cancel').at(-1)!.body))).toMatchObject({ conversationId: input.conversationId });
  });

  it('researches company-less names while cards are visible and preserves them during ordinary conversation', async () => {
    let identified = { personName: '架空の検証参加者', companyName: '架空検証社' };
    let hasPersonMention = true;
    routes.set('/api/conversation/identify', async init => {
      const { text } = JSON.parse(String(init.body));
      return jsonResponse({ text, targets: hasPersonMention ? [identified] : [], hasPersonMention });
    });
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      const result = researchResult(input.requestId, input.subjectRevision);
      result.target = { ...identified };
      result.cards[0]!.fact = `画面遷移の架空テスト資料${requests('/api/research').length}です。`;
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`, { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('initial', '架空検証社の架空の検証参加者です。'); await flush();
    await selectLatestPerson();
    expect(element('card-board').textContent).toContain('架空テスト資料1');

    for (const [index, [spoken, canonical]] of [
      ['ひろゆき', '西村博之'], ['ほりえもん', '堀江貴文'], ['架空作家', '架空作家'],
    ].entries()) {
      identified = { personName: spoken!, companyName: '' };
      stream.options.onFinal(`person-${index}`, `${spoken}について話しましょう。`); await flush();
      expect(requests('/api/conversation/identify')).toHaveLength(index + 2);
      expect(requests('/api/research')).toHaveLength(index + 2);
      const identifiedInput = JSON.parse(String(requests('/api/conversation/identify').at(-1)!.body));
      const researchInput = JSON.parse(String(requests('/api/research').at(-1)!.body));
      expect(identifiedInput.text).toBe(`${spoken}について話しましょう。`);
      expect(researchInput.text).toContain(`氏名「${canonical}」`);
      expect(researchInput.text).toContain('所属は未指定');
      expect(researchInput.text).not.toContain('会社名「');
      expect(researchInput.text).not.toContain('架空検証社');
      await selectLatestPerson();
      expect(element('card-board').textContent).toContain(`架空テスト資料${index + 2}`);
    }
    const visibleCards = element('card-board').textContent;
    hasPersonMention = false;
    stream.options.onFinal('ordinary', '今日は良い天気ですね。'); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(5);
    expect(requests('/api/research')).toHaveLength(4);
    expect(element('card-board').textContent).toBe(visibleCards);
    expect(devices.phone!.recording).toBe(true);
    click('record'); await flush();
  });

  it('shows live ASR status on G2 while preserving four cards and clears it on stop', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!;
    const lastView = () => devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(lastView().header).toContain('認識した人物 0/0');
    expect(lastView().footer).toContain('聞取中');
    stream.options.onDelta('first', '架空検証社の');
    await vi.advanceTimersByTimeAsync(500);
    expect(lastView().footer).toContain('架空検証社の');
    stream.options.onFinal('first', '架空検証社の架空の検証参加者です。'); await flush();
    await selectLatestPerson();
    await vi.advanceTimersByTimeAsync(500);
    const board = lastView().content;
    expect(board.split('\n\n')).toHaveLength(4);
    stream.options.onDelta('next', 'こんにちは');
    await vi.advanceTimersByTimeAsync(500);
    expect(lastView().content).toBe(board);
    expect(lastView().footer).toContain('こんにちは');
    click('record'); await flush();
    expect(lastView().footer).toBe('音声停止');
    stream.options.onDelta('late', '遅れた音声');
    await vi.advanceTimersByTimeAsync(500);
    expect(lastView().footer).toBe('音声停止');
    expect(lastView().footer).not.toContain('こんにちは');
  });

  it.each([
    ['費用上限に達しました。', '費用上限で停止'],
    ['音声認識サービスへ接続できませんでした。', '音声API接続失敗'],
    ['音声接続の準備がタイムアウトしました。', '音声の接続待ち切れ'],
    ['音声接続の準備が遅れたため、録音を停止しました。', '音声の接続待ち切れ'],
    ['音声の送信が遅れたため、録音を停止しました。', '音声送信が不安定'],
    ['音声データの形式を確認できませんでした。', '音声データを確認'],
  ])('shows the actual audio error category on glasses and permits restart: %s', async (message, label) => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onError(new Error(message)); await flush();
    const lastView = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(lastView.footer).toContain(label);
    expect(element('status').textContent).toContain(message);
    expect(element('conversation').textContent).toBe('会話モードを再開');
    expect(element<HTMLButtonElement>('conversation').disabled).toBe(false);
    click('conversation'); await flush();
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).footer).toContain('聞取中');
  });

  it('waits for ASR readiness before starting the G2 microphone and clearly displays preparation', async () => {
    await boot(); chooseLive(); click('connect'); await flush();
    const ready = deferred<boolean>();
    click('conversation'); devices.streaming!.start.mockReturnValueOnce(ready.promise); await flush();
    expect(devices.streaming!.start).toHaveBeenCalledWith('fixture-stream-ticket');
    expect(devices.g2!.startAudio).not.toHaveBeenCalled(); expect(devices.phone!.start).not.toHaveBeenCalled();
    expect(element('status').textContent).toContain('準備完了後に話してください');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).footer).toContain('音声準備中');
    devices.g2!.options.onStatus?.({ state: 'connected' }); await flush();
    expect(devices.streaming!.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
    ready.resolve(true); await flush();
    expect(devices.g2!.startAudio).toHaveBeenCalledExactlyOnceWith({ continuous: true });
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).footer).toContain('聞取中');
    expect(element('status').textContent).toContain('ストリーミング認識中');
    devices.g2!.options.onStatus?.({ state: 'connected' }); await flush();
    expect(devices.streaming!.cancel).toHaveBeenCalledOnce();
  });

  it.each(['audio_start_timeout', 'audio_start_failed', 'display_timeout'] as const)('preserves the G2 %s error instead of silently showing stopped', async reason => {
    await boot(); chooseLive(); click('connect'); await flush();
    devices.g2!.startAudio.mockImplementationOnce(async () => { devices.g2!.options.onStatus?.({ state: 'error', reason }); return false; });
    click('conversation'); await flush();
    expect(element('conversation').textContent).toBe('会話モードを再開');
    expect(element('status').textContent).not.toBe('停止しました。遅れて届いた結果は表示しません。');
    expect(element('status').textContent).toMatch(/G2|通信/);
    expect(devices.streaming!.cancel).toHaveBeenCalledOnce();
    expect(devices.g2!.stopAudio).toHaveBeenCalledOnce();
    expect(requests('/api/conversation')).toHaveLength(1);
  });

  it.each(['g2', 'phone'] as const)('keeps the reason after %s input loses G2 until explicit restart', async source => {
    await boot(); chooseLive(); click('connect'); await flush();
    element<HTMLSelectElement>('microphone').value = source;
    click('conversation'); await flush();
    const stream = devices.streaming!; const sessions = requests('/api/conversation').length;
    devices.g2!.options.onStatus?.({ state: 'disconnected', reason: 'device_disconnected' }); await flush();
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(element('connection-notice').classList.contains('hidden')).toBe(false);
    expect(element('connection-notice-message').textContent).toContain('G2の接続が切れた');
    expect(element('connection-notice-help').textContent).toContain('会話モードを再開');
    devices.g2!.options.onStatus?.({ state: 'connected', reason: 'resume_required' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(element('connection-notice').classList.contains('hidden')).toBe(false);
    expect(requests('/api/conversation')).toHaveLength(sessions);
    click('conversation'); await flush();
    expect(requests('/api/conversation')).toHaveLength(sessions + 1);
    expect(element('connection-notice').classList.contains('hidden')).toBe(true);
  });

  it('retains the background reason when browser visibility changes before the SDK event', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    devices.g2!.options.onStatus?.({ state: 'background', reason: 'background' }); await flush();
    expect(element('connection-notice-message').textContent).toContain('画面がバックグラウンド');
    expect(element('connection-notice').classList.contains('hidden')).toBe(false);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it('requires reopening after an unresolved display timeout', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const sessions = requests('/api/conversation').length;
    const connects = devices.g2!.connect.mock.calls.length;
    devices.g2!.options.onStatus?.({ state: 'error', reason: 'display_timeout', recovery: 'reopen' }); await flush();
    expect(devices.streaming!.cancel).toHaveBeenCalledOnce();
    expect(element('connection-notice-message').textContent).toContain('G2の表示更新の応答');
    expect(element('connection-notice-help').textContent).toContain('同じQRコードを読み直して');
    expect(element('connection-notice-help').textContent).not.toContain('会話モードを再開');
    expect(element<HTMLButtonElement>('conversation').disabled).toBe(true);
    expect(element<HTMLButtonElement>('connect').disabled).toBe(true);
    click('conversation'); click('connect'); await flush();
    expect(requests('/api/conversation')).toHaveLength(sessions);
    expect(devices.g2!.connect).toHaveBeenCalledTimes(connects);
    devices.g2!.options.onStatus?.({ state: 'connected', reason: 'stopped' }); await flush();
    expect(element('connection-notice').classList.contains('hidden')).toBe(false);
    expect(element<HTMLButtonElement>('conversation').disabled).toBe(true);
  });

  it('does not repaint an active microphone with the idle connection screen', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const count = devices.g2!.connect.mock.calls.length;
    click('connect'); await flush();
    expect(devices.g2!.connect).toHaveBeenCalledTimes(count);
    expect(devices.streaming!.cancel).not.toHaveBeenCalled();
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).footer).toContain('聞取中');
  });

  it('starts the phone microphone inside the tap while ASR is still preparing', async () => {
    const setup = deferred<Response>(); routes.set('/api/conversation', () => setup.promise);
    await boot(); chooseLive(); click('conversation');
    expect(devices.phone!.start).toHaveBeenCalledExactlyOnceWith({ continuous: true });
    expect(devices.streaming!.start).not.toHaveBeenCalled(); expect(devices.g2!.startAudio).not.toHaveBeenCalled();
    const ready = deferred<boolean>(); devices.streaming!.start.mockReturnValueOnce(ready.promise);
    setup.resolve(jsonResponse({ conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab', expiresAt: Date.now() + 900_000 })); await flush();
    expect(devices.streaming!.start).toHaveBeenCalledOnce();
    expect(element('status').textContent).toContain('準備完了後に話してください');
    ready.resolve(true); await flush();
    expect(devices.phone!.start).toHaveBeenCalledOnce(); expect(devices.phone!.recording).toBe(true);
    expect(element('status').textContent).toContain('ストリーミング認識中');
  });

  it.each(['cancel', 'background', 'session-end', 'pagehide', 'g2-disconnected', 'g2-background', 'g2-error'] as const)('does not start the G2 microphone when ASR becomes ready after %s', async action => {
    await boot(); chooseLive(); click('connect'); await flush();
    const ready = deferred<boolean>();
    click('conversation'); const stream = devices.streaming!; stream.start.mockReturnValueOnce(ready.promise); await flush();
    if (action === 'cancel') click('cancel');
    else if (action === 'background') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    } else if (action === 'session-end') {
      click('end');
    } else if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    else devices.g2!.options.onStatus?.({ state: action === 'g2-disconnected' ? 'disconnected' : action === 'g2-background' ? 'background' : 'error' });
    await flush(); ready.resolve(true); await flush();
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(devices.g2!.startAudio).not.toHaveBeenCalled(); expect(devices.phone!.start).not.toHaveBeenCalled();
    expect(requests('/api/research')).toHaveLength(0);
  });

  it('ignores readiness from a canceled generation while a new G2 conversation is active', async () => {
    await boot(); chooseLive(); click('connect'); await flush();
    const ready = deferred<boolean>();
    click('conversation'); const old = devices.streaming!; old.start.mockReturnValueOnce(ready.promise); await flush();
    click('cancel'); await flush(); click('conversation'); await flush();
    const current = devices.streaming!;
    expect(current).not.toBe(old); expect(devices.g2!.startAudio).toHaveBeenCalledOnce();
    const stops = devices.g2!.stopAudio.mock.calls.length;
    ready.resolve(true); await flush();
    expect(devices.g2!.startAudio).toHaveBeenCalledOnce(); expect(devices.g2!.stopAudio).toHaveBeenCalledTimes(stops);
    expect(current.cancel).not.toHaveBeenCalled();
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).footer).toContain('聞取中');
  });

  it.each(['false', 'throw'] as const)('closes the ready ASR connection if the G2 microphone fails with %s', async failure => {
    await boot(); chooseLive(); click('connect'); await flush();
    if (failure === 'false') devices.g2!.startAudio.mockResolvedValueOnce(false);
    else devices.g2!.startAudio.mockRejectedValueOnce(new Error('G2のマイクを開始できませんでした。'));
    click('conversation'); await flush();
    expect(devices.streaming!.start).toHaveBeenCalledOnce();
    expect(devices.streaming!.cancel).toHaveBeenCalledOnce(); expect(devices.g2!.stopAudio).toHaveBeenCalledOnce();
    expect(requests('/api/cancel')).toHaveLength(1);
    expect(element('status').textContent).toContain('マイクを開始できません');
    expect(element<HTMLButtonElement>('conversation').disabled).toBe(false);
  });

  it('keeps capture for ambiguous candidates and selects within the original conversation budget', async () => {
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      if (input.selectedCandidateId) return resultResponse(input);
      const result = researchResult(input.requestId, input.subjectRevision);
      result.status = 'awaiting_confirmation'; result.cards = []; result.candidates = [{ id: 'candidate-a', personName: '架空の検証参加者', companyName: '架空検証社', reason: '同名の候補', sourceIds: [] }];
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`);
    });
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('ambiguous', '架空検証社の架空の検証参加者です。'); await flush();
    expect(devices.phone!.recording).toBe(true);
    expect(stream.cancel).not.toHaveBeenCalled();
    expect(element('candidates').children).toHaveLength(1);
    expect(element('card-board').textContent).not.toContain(FACT);
    expect(requests('/api/conversation/identify')).toHaveLength(1);
    (element('candidates').firstElementChild as HTMLButtonElement).click(); await flush();
    await selectLatestPerson();
    expect(requests('/api/research')).toHaveLength(2);
    expect(JSON.parse(String(requests('/api/research')[1]!.body))).toMatchObject({ selectedCandidateId: 'candidate-a', conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab' });
    expect(element('card-board').textContent).toContain(FACT);
  });

  it('keeps the list visible while showing an uncertain correction on the phone, then researches a named correction with its success hint', async () => {
    routes.set('/api/conversation/identify', async init => {
      const { text } = JSON.parse(String(init.body));
      return jsonResponse(text === '広行について' ? { text, targets: [], hasPersonMention: true, correctionHint: '聞き取った名前の候補です。まだ本人とは確認できていません。', correctionCandidate: { personName: 'ひろゆき', companyName: '' } }
        : { text, targets: [{ personName: 'ひろゆき', companyName: '' }], hasPersonMention: true, correctionHint: '言い直した名前を候補として公開情報を確認します。' });
    });
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('uncertain', '広行について'); await flush();
    expect(element('correction-hint').textContent).toContain('候補：ひろゆき');
    expect(element('correction-hint').textContent).toContain('まだ本人とは確認できていません');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).header).toContain('認識した人物');
    expect(element('card-board').textContent).not.toContain(FACT); expect(requests('/api/research')).toHaveLength(0);
    expect(stream.cancel).not.toHaveBeenCalled();
    stream.options.onFinal('corrected', 'ひろゆきです'); await flush();
    await selectLatestPerson();
    expect(requests('/api/research')).toHaveLength(1);
    expect(JSON.parse(String(requests('/api/research')[0]!.body)).text).toContain('西村博之');
    expect(element('correction-hint').textContent).toContain('言い直した名前');
    expect(element('card-board').textContent).toContain(FACT);
    expect(stream.cancel).not.toHaveBeenCalled(); expect(devices.g2!.startAudio).toHaveBeenCalledOnce();
  });

  it.each(['/api/conversation/identify', '/api/research'])('keeps ASR active after a temporary %s failure and retries only after new speech', async path => {
    routes.set(path, async () => new Response(JSON.stringify({ message: '人物調査のサービスが一時的に利用できません。' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('first', '架空検証社の架空の検証参加者です。'); await flush();
    expect(element('status').textContent).toContain('聞き取りは続いています');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).header).toContain('認識した人物');
    expect(element('status').textContent).toContain('調査サービスに接続できませんでした');
    expect(element('status').textContent).not.toContain('名前や所属を言い直してください');
    expect(stream.cancel).not.toHaveBeenCalled(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
    const sent = requests(path).length; await vi.advanceTimersByTimeAsync(5000); expect(requests(path)).toHaveLength(sent);
    routes.delete(path); stream.options.onFinal('retry', '架空検証社の架空の検証参加者です。'); await flush();
    await selectLatestPerson();
    expect(requests(path)).toHaveLength(sent + 1); expect(element('card-board').textContent).toContain(FACT);
    expect(devices.g2!.startAudio).toHaveBeenCalledOnce();
  });

  it.each([
    ['INVALID_PROVIDER_RESPONSE', '調査サービスの回答を読み取れませんでした'],
    ['INVALID_OR_UNAVAILABLE_RESPONSE', '調査サービスの回答を読み取れませんでした'],
    ['OPERATION_TIMEOUT', '応答が時間切れ'],
    ['DEADLINE_EXCEEDED', '応答が時間切れ'],
    ['PROVIDER_TIMEOUT', '応答が時間切れ'],
    ['RATE_LIMITED', '調査サービスが混雑しています'],
    ['SOURCES_UNAVAILABLE', '調査サービスに接続できませんでした'],
  ])('explains a failed research result %s without blaming the name or stopping ASR', async (reasonCode, expectedMessage) => {
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      const result = researchResult(input.requestId, input.subjectRevision);
      result.status = 'failed'; result.cards = []; result.reasonCode = reasonCode; result.message = '調査を完了できませんでした。入力を確認してください。';
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`);
    });
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('failure', '架空検証社の架空の検証参加者です。'); await flush();
    const view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.header).toContain('認識した人物');
    expect(element('status').textContent).toContain('同じ名前');
    expect(element('status').textContent).toContain(expectedMessage);
    expect(element('status').textContent).toContain('聞き取りは続いています');
    expect(element('status').textContent).not.toContain('名前や所属を言い直');
    expect(stream.cancel).not.toHaveBeenCalled(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
    routes.delete('/api/research'); stream.options.onFinal('retry', '架空検証社の架空の検証参加者です。'); await flush();
    await selectLatestPerson();
    expect(requests('/api/research')).toHaveLength(2); expect(element('card-board').textContent).toContain(FACT);
  });

  it.each([
    [429, 'RATE_LIMITED', '調査サービスが混雑しています'],
    [504, 'PROVIDER_TIMEOUT', '応答が時間切れ'],
    [502, 'INVALID_PROVIDER_RESPONSE', '調査サービスの回答を読み取れませんでした'],
  ] as const)('preserves caught HTTP error codes for recovery feedback %s', async (httpStatus, code, expectedMessage) => {
    routes.set('/api/conversation/identify', async () => new Response(JSON.stringify({ message: '外部サービスの応答を処理できません。', code }), { status: httpStatus }));
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('failure', '架空検証社の架空の検証参加者です。'); await flush();
    expect(element('status').textContent).toContain(expectedMessage);
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).header).toContain('認識した人物');
    expect(stream.cancel).not.toHaveBeenCalled(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
  });

  it.each([
    ['http', 'BUDGET_EXHAUSTED', 429, '設定した費用上限に達しました'],
    ['http', 'BUDGET_LEDGER_INVALID', 500, '費用管理の状態を確認する必要があります'],
    ['result', 'BUDGET_EXHAUSTED', 200, '設定した費用上限に達しました'],
    ['result', 'BUDGET_NOT_CONFIGURED', 200, '費用管理の状態を確認する必要があります'],
  ] as const)('gives a cost-management action for manual research %s %s instead of retrying the name', async (kind, code, httpStatus, expectedMessage) => {
    routes.set('/api/research', async init => {
      if (kind === 'http') return new Response(JSON.stringify({ code, message: '費用管理の確認が必要です。' }), { status: httpStatus });
      const input = JSON.parse(String(init.body)) as ResearchInput;
      const result = researchResult(input.requestId, input.subjectRevision);
      result.status = 'failed'; result.cards = []; result.reasonCode = code;
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`);
    });
    await boot(); chooseLive(); click('connect'); await flush();
    element<HTMLTextAreaElement>('text').value = '架空検証社の架空の検証参加者です。';
    click('research'); await flush();
    expect(element('status').textContent).toContain(expectedMessage);
    expect(element('status').textContent).toContain('費用の設定・利用状況を確認');
    expect(element('status').textContent).not.toMatch(/混雑|同じ名前/);
    const view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.content).toContain(expectedMessage);
    expect(view.footer).toContain('費用の設定・利用状況を確認');
  });

  it('asks to reopen the same QR for an incompatible result, without exposing schema details or stopping ASR', async () => {
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      return new Response(`${JSON.stringify({ type: 'result', result: { ...researchResult(input.requestId, input.subjectRevision), unexpectedField: 'private-validator-fixture' } })}\n`);
    });
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('failure', '架空検証社の架空の検証参加者です。'); await flush();
    const view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.header).toContain('認識した人物');
    expect(element('status').textContent).toContain('画面で調査結果を読み込めませんでした');
    expect(element('status').textContent).toContain('同じQRを読み直して');
    expect(element('status').textContent).not.toMatch(/unexpectedField|unrecognized_keys|private-validator-fixture|Zod/);
    expect(stream.cancel).not.toHaveBeenCalled(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
    expect(element('card-board').textContent).not.toContain(FACT);
  });

  it.each([
    [429, '費用上限に達しました。', 'BUDGET_EXHAUSTED'],
    [401, 'ログイン期限が切れました。', 'AUTH_EXPIRED'],
    [409, '会話モードが終了または失効しました。', 'CONVERSATION_EXPIRED'],
  ] as const)('still stops capture for a conversation boundary %s', async (httpStatus, message, code) => {
    routes.set('/api/conversation/identify', async () => new Response(JSON.stringify({ message, code }), { status: httpStatus, headers: { 'Content-Type': 'application/json' } }));
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('first', '架空検証社の架空の検証参加者です。'); await flush();
    expect(stream.cancel).toHaveBeenCalledOnce(); expect(devices.phone!.recording).toBe(false);
    stream.options.onFinal('late', '次の人物です'); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(1);
  });

  it('accepts a spoken correction after an ambiguous result without stopping or reopening the microphone', async () => {
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      const result = researchResult(input.requestId, input.subjectRevision);
      if (requests('/api/research').length === 1) { result.status = 'awaiting_confirmation'; result.cards = []; }
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`);
    });
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('first', '架空検証社の架空の検証参加者です。'); await flush();
    expect(element('card-board').textContent).not.toContain(FACT);
    stream.options.onFinal('correction', '違います。架空検証社の架空の検証参加者です。'); await flush();
    await selectLatestPerson();
    expect(requests('/api/conversation/identify')).toHaveLength(2); expect(requests('/api/research')).toHaveLength(2);
    expect(element('card-board').textContent).toContain(FACT);
    expect(devices.phone!.recording).toBe(true); expect(devices.phone!.start).toHaveBeenCalledOnce(); expect(stream.cancel).not.toHaveBeenCalled();
  });

  it.each(['phone-button', 'glasses-tap'] as const)('clears the subject for new speech via %s and ignores old partial/final and delayed identification', async action => {
    const old = deferred<Response>();
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('initial', '架空の検証参加者です。'); await flush();
    await selectLatestPerson();
    routes.set('/api/conversation/identify', () => old.promise);
    expect(element<HTMLButtonElement>('retry-listening').disabled).toBe(false);
    stream.options.onFinal('old-final', '架空検証社の架空の検証参加者です。'); await flush();
    const oldRequest = requests('/api/conversation/identify')[1]!;
    stream.options.onDelta('old-partial', '古い発話の途中');
    if (action === 'phone-button') click('retry-listening'); else await confirmGlassesAudioAction();
    await flush();
    expect(requests('/api/conversation/reset')).toHaveLength(1);
    expect(JSON.parse(String(requests('/api/conversation/reset')[0]!.body))).toEqual({ conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab' });
    expect(oldRequest.signal!.aborted).toBe(true); expect(element('card-board').textContent).toContain(FACT);
    expect(stream.cancel).not.toHaveBeenCalled(); expect(devices.phone!.recording).toBe(true);
    expect(devices.phone!.start).toHaveBeenCalledOnce(); expect(devices.phone!.stop).not.toHaveBeenCalled();
    stream.options.onFinal('old-partial', '古い発話です'); await flush();
    routes.delete('/api/conversation/identify');
    stream.options.onFinal('fresh-final', '架空検証社の架空の検証参加者です。'); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(3); expect(requests('/api/research')).toHaveLength(2);
    expect(JSON.parse(String(requests('/api/research')[1]!.body)).subjectRevision).toBeGreaterThan(6);
    old.resolve(jsonResponse({ text: '古い別人の応答です', targets: [{ personName: '古い別人', companyName: '' }], hasPersonMention: true })); await flush();
    expect(requests('/api/research')).toHaveLength(2); expect(element('card-board').textContent).toContain(FACT);
    expect(element<HTMLTextAreaElement>('text').value).not.toContain('古い別人');
    expect(requests('/api/transcribe')).toHaveLength(0);
  });

  it('resets an active research without displaying its late result and permits the same subject after reset', async () => {
    const old = deferred<Response>(); routes.set('/api/research', () => old.promise);
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('first', '架空検証社の架空の検証参加者です。'); await flush();
    const oldInput = JSON.parse(String(requests('/api/research')[0]!.body)) as ResearchInput;
    click('retry-listening'); await flush();
    expect(requests('/api/research')[0]!.signal!.aborted).toBe(true);
    routes.delete('/api/research'); stream.options.onFinal('fresh', '架空検証社の架空の検証参加者です。'); await flush();
    expect(requests('/api/research')).toHaveLength(2);
    const currentBoard = element('card-board').textContent;
    const stale = researchResult(oldInput.requestId, oldInput.subjectRevision); stale.cards[0]!.fact = '古い無効な人物カード';
    old.resolve(new Response(`${JSON.stringify({ type: 'result', result: stale })}\n`)); await flush();
    expect(element('card-board').textContent).toBe(currentBoard);
    expect(element('card-board').textContent).not.toContain('古い無効'); expect(stream.cancel).not.toHaveBeenCalled();
  });

  it('locks the current person using the phone button while ASR continues, and an explicit audio confirmation permits a fresh identity', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('first', '架空の検証参加者です'); await flush();
    await selectLatestPerson();
    click('lock-person');
    await flush();
    expect(element('person-state').textContent).toContain('架空の検証参加者さんを固定中');
    expect(element('hud-target').textContent).toContain('固定：');
    stream.options.onDelta('next', '別の架空人物');
    stream.options.onFinal('next', '別の架空人物の話です'); await flush();
    expect(element<HTMLTextAreaElement>('text').value).toContain('別の架空人物');
    expect(requests('/api/conversation/identify')).toHaveLength(1);
    expect(requests('/api/research')).toHaveLength(1);
    expect(stream.cancel).not.toHaveBeenCalled(); expect(devices.g2!.startAudio).toHaveBeenCalledOnce(); expect(devices.g2!.stopAudio).not.toHaveBeenCalled();
    await confirmGlassesAudioAction();
    expect(requests('/api/conversation/reset')).toHaveLength(1);
    expect(element('person-state').textContent).not.toContain('固定中');
    stream.options.onFinal('fresh', '架空の検証参加者です'); await flush();
    expect(requests('/api/research')).toHaveLength(2);
  });

  it('discards a delayed identification on lock but accepts enrichment of the locked person', async () => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('first', '架空の検証参加者です'); await flush();
    pushResearchEvent(streams[0]!.body, { type: 'update', result: fourCardResult(streams[0]!.input) }); await flush();
    await selectLatestPerson();
    const delayed = deferred<Response>(); routes.set('/api/conversation/identify', () => delayed.promise);
    stream.options.onFinal('late', '次の別人の話です'); await flush();
    const pending = requests('/api/conversation/identify').at(-1)!;
    click('lock-person'); await flush();
    expect(pending.signal!.aborted).toBe(true); expect(streams[0]!.signal.aborted).toBe(false);
    delayed.resolve(jsonResponse({ text: '別人', targets: [{ personName: '別人', companyName: '' }], hasPersonMention: true })); await flush();
    pushResearchEvent(streams[0]!.body, { type: 'result', result: fourCardResult(streams[0]!.input, '追加確認', 'COMPLETE') }); streams[0]!.body.close(); await flush();
    expect(requests('/api/research')).toHaveLength(1);
    expect(element('person-state').textContent).toContain('固定中');
    expect(element('card-board').textContent).toContain('追加確認');
  });

  it('cannot lock an unverified target and clears the lock on session end', async () => {
    await boot(); chooseLive(); click('conversation'); await flush();
    click('lock-person'); await flush();
    expect(element('person-state').textContent).not.toContain('固定中');
    devices.streaming!.options.onFinal('first', '架空の検証参加者です'); await flush();
    await selectLatestPerson();
    click('lock-person'); await flush(); expect(element('person-state').textContent).toContain('固定中');
    click('end'); await flush();
    expect(element('person-state').textContent).not.toContain('固定中');
    expect(element<HTMLButtonElement>('lock-person').disabled).toBe(true);
  });

  it('allows a confirmed upward scroll to restart G2 audio after a rate error, without automatic restart', async () => {
    await boot(); chooseLive(); element<HTMLSelectElement>('microphone').value = 'g2';
    click('connect'); await flush(); click('conversation'); await flush();
    const old = devices.streaming!;
    old.options.onError(new Error('音声の送信速度が上限を超えました。')); await flush();
    expect(element('status').textContent).toContain('1回タップ');
    expect(devices.g2!.startAudio).toHaveBeenCalledOnce();
    await confirmGlassesAudioAction();
    expect(devices.streaming).not.toBe(old);
    expect(devices.g2!.startAudio).toHaveBeenCalledTimes(2);
    expect(requests('/api/conversation')).toHaveLength(2);
    expect(element('status').textContent).toContain('ストリーミング認識中');
    old.options.onError(new Error('古い切断')); await flush();
    expect(devices.streaming!.cancel).not.toHaveBeenCalled();
  });

  it('waits for the old G2 microphone stop acknowledgement before a confirmed restart', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stopping = deferred<boolean>(); devices.g2!.stopAudio.mockReturnValueOnce(stopping.promise);
    devices.streaming!.options.onError(new Error('音声の送信速度が上限を超えました。')); await flush();
    await confirmGlassesAudioAction();
    expect(requests('/api/conversation')).toHaveLength(1);
    expect(devices.g2!.startAudio).toHaveBeenCalledOnce();
    stopping.resolve(true); await flush();
    expect(requests('/api/conversation')).toHaveLength(2);
    expect(devices.g2!.startAudio).toHaveBeenCalledTimes(2);
  });

  it('does not resume from a queued retry after the session ends during microphone shutdown', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stopping = deferred<boolean>(); devices.g2!.stopAudio.mockReturnValueOnce(stopping.promise);
    devices.streaming!.options.onError(new Error('音声接続が切れました。')); await flush();
    await confirmGlassesAudioAction();
    click('end'); await flush();
    stopping.resolve(true); await flush();
    expect(requests('/api/conversation')).toHaveLength(1);
  });

  it('keeps an active visible conversation alive, updates expiry, and stops heartbeat after the session ends', async () => {
    routes.set('/api/conversation/keepalive', async () => jsonResponse({ expiresAt: Date.now() + 900_000, revision: 12 }));
    await boot(); chooseLive(); click('conversation'); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests('/api/conversation/keepalive')).toHaveLength(1);
    devices.streaming!.options.onFinal('new', '架空検証社の架空の検証参加者です。'); await flush();
    expect(JSON.parse(String(requests('/api/research')[0]!.body)).subjectRevision).toBe(13);
    await vi.advanceTimersByTimeAsync(841_000);
    expect(devices.phone!.recording).toBe(true); expect(element('workspace').classList.contains('hidden')).toBe(false);
    const sent = requests('/api/conversation/keepalive').length;
    click('end'); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests('/api/conversation/keepalive')).toHaveLength(sent); expect(devices.phone!.recording).toBe(false);
  });

  it('cancels streaming and active identification, ignoring delayed final text and identification responses', async () => {
    const gate = deferred<Response>(); routes.set('/api/conversation/identify', () => gate.promise);
    await boot(); chooseLive(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('first', '架空検証社の架空の検証参加者です。'); await flush();
    const sent = requests('/api/conversation/identify')[0]!;
    const { requestId, subjectRevision, conversationId } = JSON.parse(String(sent.body));
    click('record'); await flush();
    expect(sent.signal!.aborted).toBe(true);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(JSON.parse(String(requests('/api/cancel')[0]!.body))).toMatchObject({ requestId, subjectRevision, conversationId });
    stream.options.onDelta('late', 'late partial'); stream.options.onFinal('late', 'late transcript');
    gate.resolve(jsonResponse({ text: 'late transcript', targets: [{ personName: '架空の検証参加者', companyName: '架空検証社' }] })); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(1);
    expect(requests('/api/research')).toHaveLength(0);
    expect(element<HTMLTextAreaElement>('text').value).not.toContain('late transcript');
    expect(devices.phone!.recording).toBe(false);
  });

  it('starts a fresh session after expiry without retaining conversation or replaying paid work', async () => {
    routes.set('/api/session/restore', async () => jsonResponse({ token: 'fresh', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false }));
    await boot(); chooseLive(); element<HTMLTextAreaElement>('text').value = 'old private conversation';
    await vi.advanceTimersByTimeAsync(900_000);
    expect(element<HTMLTextAreaElement>('text').value).toBe('');
    expect(document.getElementById('consent')).toBeNull();
    expect(element('workspace').classList.contains('hidden')).toBe(false);
    expect(requests('/api/session/restore')).toHaveLength(1);
    expect(requests('/api/research')).toHaveLength(0);
    expect(devices.phone!.start).not.toHaveBeenCalled();
  });

  it('forgets device login on explicit end and does not restore it again', async () => {
    await boot(); click('end'); await flush();
    expect(requests('/api/session/forget')).toHaveLength(1);
    expect(element('workspace').classList.contains('hidden')).toBe(true);
    expect(element('login-status').textContent).toContain('ログインの記憶を削除');
    await vi.advanceTimersByTimeAsync(900_000);
    expect(requests('/api/session/restore')).toHaveLength(0);
  });

  it('ignores an old cancellation 401 received after fresh authentication', async () => {
    const cancelled = deferred<Response>();
    routes.set('/api/cancel', () => cancelled.promise);
    routes.set('/api/session/restore', async () => jsonResponse({ token: 'fresh-token', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false }));
    await boot(); element<HTMLTextAreaElement>('text').value = 'old input'; click('research'); await flush();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(requests('/api/cancel')).toHaveLength(1);
    cancelled.resolve(new Response('{}', { status: 401 })); await flush();
    expect(element('workspace').classList.contains('hidden')).toBe(false);
    element<HTMLTextAreaElement>('text').value = 'new input'; click('research'); await flush();
    expect(new Headers(requests('/api/research').at(-1)!.headers).get('Authorization')).toBe('Bearer fresh-token');
  });

  it('clears private conversation on a current credential rejection before reauthentication', async () => {
    routes.set('/api/research', async () => new Response('{}', { status: 401 }));
    await boot(); chooseLive(); element<HTMLTextAreaElement>('text').value = 'old private input'; click('research'); await flush();
    expect(element<HTMLTextAreaElement>('text').value).toBe('');
    expect(element('trace').children).toHaveLength(0);
    expect(element('workspace').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('consent')).toBeNull();
    element('login-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(element<HTMLTextAreaElement>('text').value).toBe('');
  });

  it('serializes remembered restore and manual login, then prevents double submit', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, accessCodeRequired: true }));
    const restoring = deferred<Response>(); const loggingIn = deferred<Response>();
    routes.set('/api/session/restore', () => restoring.promise);
    routes.set('/api/session', () => loggingIn.promise);
    const pendingBoot = boot(); await vi.waitFor(() => expect(requests('/api/session/restore')).toHaveLength(1));
    expect(element<HTMLButtonElement>('login-form').querySelector('button')!.disabled).toBe(true);
    element('login-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(requests('/api/session')).toHaveLength(0);
    restoring.resolve(new Response('{}', { status: 401 })); await pendingBoot;
    element('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    element('login-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(requests('/api/session')).toHaveLength(1);
    loggingIn.resolve(jsonResponse({ token: 'new', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false })); await flush();
    expect(element('workspace').classList.contains('hidden')).toBe(false);
  });

  it('redeems a QR once after erasing its fragment, remembers login and starts no work', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, accessCodeRequired: true }));
    const ticket = 'a'.repeat(64);
    window.history.replaceState(null, '', '/#login=' + ticket);
    routes.set('/api/session/qr/redeem', async init => {
      expect(window.location.hash).toBe('');
      expect(JSON.parse(String(init.body))).toEqual({ ticket });
      return jsonResponse({ token: 'qr-session', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false });
    });
    await boot();
    expect(requests('/api/session/qr/redeem')).toHaveLength(1);
    expect(element('workspace').classList.contains('hidden')).toBe(false);
    expect(element<HTMLInputElement>('access-code').value).toBe('');
    expect(requests('/api/research')).toHaveLength(0);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
    expect(devices.phone!.start).not.toHaveBeenCalled();
  });

  it('automatically starts G2 conversation once after verified QR redemption without preregistration', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], streamingEnabled: true, accessCodeRequired: true }));
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'c'.repeat(64));
    routes.set('/api/session/qr/redeem', async () => jsonResponse({ token: 'qr-session', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false }));
    await boot();
    expect(window.location.hash).toBe('');
    expect(element<HTMLSelectElement>('mode').value).toBe('live');
    expect(element<HTMLTextAreaElement>('text').value).toBe('');
    expect(devices.g2!.connect).toHaveBeenCalledOnce();
    expect(devices.g2!.startAudio).toHaveBeenCalledExactlyOnceWith({ continuous: true });
    expect(requests('/api/conversation')).toHaveLength(1);
    expect(requests('/api/session/restore')).toHaveLength(0);
    expect(requests('/api/research')).toHaveLength(0);
    expect(element('status').textContent).toContain('ストリーミング認識中');
    expect(element('people-list').children).toHaveLength(0);
    expect(element('sources').children).toHaveLength(0);
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).header).toContain('認識した人物 0/0');
    click('conversation'); click('connect'); await flush();
    expect(devices.g2!.startAudio).toHaveBeenCalledOnce();
    expect(requests('/api/conversation')).toHaveLength(1);
    expect(devices.g2!.connect).toHaveBeenCalledOnce();
    click('cancel'); await flush();
    document.dispatchEvent(new Event('visibilitychange')); await flush();
    expect(requests('/api/conversation')).toHaveLength(1);
  });

  it('requires successful conversation QR redemption even with a remembered login', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], streamingEnabled: true, accessCodeRequired: true }));
    routes.set('/api/session/restore', async () => jsonResponse({ token: 'remembered', revision: 0, expiresAt: Date.now() + 900_000 }));
    routes.set('/api/session/qr/redeem', async () => new Response('{}', { status: 401 }));
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'd'.repeat(64));
    await boot();
    expect(requests('/api/session/qr/redeem')).toHaveLength(1);
    expect(requests('/api/session/restore')).toHaveLength(0);
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
  });

  it.each([false, true])('explains unavailable QR streaming with liveEnabled=%s instead of leaving an idle screen', async liveEnabled => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled, missing: [], streamingEnabled: false, accessCodeRequired: true }));
    routes.set('/api/session/qr/redeem', async () => jsonResponse({ token: 'qr', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false }));
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'a'.repeat(64));
    await boot();
    expect(element('status').textContent).toContain('音声認識の設定');
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled(); expect(devices.phone!.start).not.toHaveBeenCalled();
  });

  it('never auto-starts on a conversation query without a fresh QR fragment', async () => {
    window.history.replaceState(null, '', '/?conversation=1');
    await boot();
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
    click('conversation'); await flush();
    expect(requests('/api/conversation')).toHaveLength(1);
  });

  it.each(['cancel', 'background', 'pagehide', 'end'] as const)('discards the pending automatic QR start after %s during G2 connection', async action => {
    const auth = deferred<Response>();
    routes.set('/api/session/qr/redeem', () => auth.promise);
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'e'.repeat(64));
    const starting = boot();
    await vi.waitFor(() => expect(requests('/api/session/qr/redeem')).toHaveLength(1));
    const connecting = deferred<boolean>();
    devices.g2!.connect.mockReturnValueOnce(connecting.promise);
    auth.resolve(jsonResponse({ token: 'qr', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false }));
    await starting;
    expect(devices.g2!.connect).toHaveBeenCalledOnce();
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(element<HTMLButtonElement>('cancel').disabled).toBe(false);
    if (action === 'background') { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); }
    else if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    else click(action);
    await flush();
    devices.g2!.options.onStatus?.({ state: 'connected' }); connecting.resolve(true); await flush();
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await flush();
    expect(requests('/api/conversation')).toHaveLength(0);
  });

  it('discards a failed G2 connection arriving after canceling QR auto-start', async () => {
    const auth = deferred<Response>(); routes.set('/api/session/qr/redeem', () => auth.promise);
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'e'.repeat(64));
    const starting = boot(); await vi.waitFor(() => expect(requests('/api/session/qr/redeem')).toHaveLength(1));
    const connecting = deferred<boolean>(); devices.g2!.connect.mockReturnValueOnce(connecting.promise);
    auth.resolve(jsonResponse({ token: 'qr', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false })); await starting;
    click('cancel'); await flush(); const stopped = element('status').textContent;
    connecting.resolve(false); await flush();
    expect(element('status').textContent).toBe(stopped);
    expect(element('conversation').textContent).toBe('会話モードを開始');
    expect(requests('/api/conversation')).toHaveLength(0);
  });

  it('cancels the automatic start if backgrounded while QR authentication is pending', async () => {
    const auth = deferred<Response>(); routes.set('/api/session/qr/redeem', () => auth.promise);
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'f'.repeat(64));
    const starting = boot(); await vi.waitFor(() => expect(requests('/api/session/qr/redeem')).toHaveLength(1));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); await flush();
    auth.resolve(jsonResponse({ token: 'qr', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false })); await starting;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); await flush();
    expect(requests('/api/conversation')).toHaveLength(0); expect(devices.g2!.startAudio).not.toHaveBeenCalled();
  });

  it('explains unavailable G2 auto-start without silently using the phone microphone', async () => {
    const auth = deferred<Response>(); routes.set('/api/session/qr/redeem', () => auth.promise);
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'a'.repeat(64));
    const starting = boot(); await vi.waitFor(() => expect(requests('/api/session/qr/redeem')).toHaveLength(1));
    devices.g2!.connect.mockResolvedValueOnce(false);
    auth.resolve(jsonResponse({ token: 'qr', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false })); await starting;
    expect(element('status').textContent).toContain('Evenアプリ内');
    expect(element('conversation').textContent).toBe('会話モードを再開');
    expect(devices.phone!.start).not.toHaveBeenCalled(); expect(requests('/api/conversation')).toHaveLength(0);
  });

  it('uses an existing remembered login without spending another QR grant', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, accessCodeRequired: true }));
    window.history.replaceState(null, '', '/#login=' + 'b'.repeat(64));
    routes.set('/api/session/restore', async () => jsonResponse({ token: 'restored', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false }));
    await boot();
    expect(window.location.hash).toBe('');
    expect(requests('/api/session/qr/redeem')).toHaveLength(0);
    expect(element('workspace').classList.contains('hidden')).toBe(false);
  });

  it('shows QR failure without retrying, leaking the grant, or starting paid work', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, accessCodeRequired: true }));
    const ticket = 'c'.repeat(64); window.history.replaceState(null, '', '/#login=' + ticket);
    routes.set('/api/session/qr/redeem', async () => new Response('{}', { status: 401 }));
    await boot();
    expect(requests('/api/session/qr/redeem')).toHaveLength(1);
    expect(element('login-status').textContent).toContain('使用済みか期限切れ');
    expect(document.body.textContent).not.toContain(ticket);
    expect(window.location.hash).toBe('');
    expect(requests('/api/research')).toHaveLength(0);
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

  it('keeps short recording available when streaming is not configured', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], sttEnabled: true, streamingEnabled: false, accessCodeRequired: false }));
    await boot(); chooseLive();
    expect(element<HTMLButtonElement>('conversation').disabled).toBe(true);
    expect(element<HTMLButtonElement>('record').disabled).toBe(false);
    click('record'); await flush();
    expect(devices.phone!.start).toHaveBeenCalledOnce();
    devices.phone!.options.onAudio(new Uint8Array([0, 0, 255, 127]));
    click('record'); await flush();
    expect(requests('/api/transcribe')).toHaveLength(1);
    expect(requests('/api/conversation/stream')).toHaveLength(0);
    expect(devices.streaming).toBeNull();
  });

  it('shows an actionable error and permits retry when an explicit stop captured no audio', async () => {
    await boot(); chooseLive();
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

  it.each(['cancel', 'session-end', 'pagehide'] as const)('never sends audio after %s while microphone stop is pending', async action => {
    await boot(); await recordPhone();
    const stopped = delayPhoneStop();
    click('record'); await flush();
    expect(requests('/api/transcribe')).toHaveLength(0);
    expect(element<HTMLButtonElement>('record').disabled).toBe(true);
    if (action === 'cancel') click('cancel');
    else if (action === 'session-end') {
      click('end');
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
    await boot(); chooseLive();
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
    await boot(); chooseLive();
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

  it('shows four fact/question pairs together and keeps the G2 board unchanged while selecting source details', async () => {
    const value = researchResult();
    const words = ['いち', 'に', 'さん', 'よん'];
    value.cards = words.map((word, index) => ({ ...value.cards[0]!, cardId: `card-${index}`,
      fact: `公開事実${word}。`, suggestedQuestion: `質問${word}？`, excerpt: `公開事実${word}。` }));
    value.sources[0]!.text = value.cards.map(card => card.excerpt).join(' ');
    routes.set('/api/session/resume', async () => jsonResponse({ result: value }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    expect([...element('card-board').querySelectorAll('.topic-fact')].map(node => node.textContent))
      .toEqual(value.cards.map(card => card.fact));
    expect([...element('card-board').querySelectorAll('.topic-question')].map(node => node.textContent))
      .toEqual(value.cards.map(card => card.suggestedQuestion));
    expect(element('card-board').querySelectorAll('button:disabled')).toHaveLength(0);
    expect(element('hud-expiry').textContent).toBe('4 / 4件確認');
    const initialView = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(initialView.content.split('\n\n')).toEqual(words.map((word, index) => `${index + 1} 事実:公開事実${word}。\n⭐️推奨質問：質問${word}？`));
    click('next'); await flush();
    expect(element('card-count').textContent).toBe('2 / 4');
    expect(element('sources').querySelector('.source-fact')!.textContent).toBe('事実（全文）：公開事実に。');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).toBe(initialView.content);
    click('topic-3'); await flush();
    expect(element('card-count').textContent).toBe('4 / 4');
    expect(element('sources').querySelector('blockquote')!.textContent).toBe('公開事実よん。');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).toBe(initialView.content);
  });

  it('labels two recent X cards, one past X card and one profile card, with post evidence on the phone', async () => {
    const value = researchResult();
    const topics = ['recent_x', 'recent_x', 'popular_x', 'profile'] as const;
    const labels = ['最近X', '最近X', '過去X', '人物・会社 / Web'];
    value.cards = topics.map((topic, index) => ({ ...value.cards[0]!, topic, cardId: `topic-card-${index}`,
      sourceId: `topic-source-${index}`, fact: `公開事実${index + 1}です。`, suggestedQuestion: `活動${index + 1}の工夫は？`, excerpt: `公開事実${index + 1}です。` }));
    value.sources = topics.map((topic, index) => ({ ...value.sources[0]!, topic, sourceId: `topic-source-${index}`,
      text: value.cards[index]!.fact, kind: index === 3 ? 'web' : 'x',
      ...(index === 3 ? {} : { xPost: { id: String(100 + index), authorId: '900', username: 'fixture_user', text: value.cards[index]!.fact,
        createdAt: '2026-09-20T03:00:00.000Z', likeCount: 1200, repostCount: 34, replyCount: 5, quoteCount: 6,
        ...(topic === 'popular_x' ? { selectionScope: 'full_archive_sample' as const } : {}) } }),
    }));
    routes.set('/api/session/resume', async () => jsonResponse({ result: value }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    expect([...element('card-board').querySelectorAll('.topic-number')].map(node => node.textContent))
      .toEqual(labels.map((label, index) => `${index + 1} / ${label} · 原文・出典 ↗`));
    const board = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(board.content.split('\n\n')).toEqual(labels.map((label, index) => `${index + 1} ${label} 事実:公開事実${index + 1}です。\n⭐️推奨質問：活動${index + 1}の工夫は？`));
    expect(board.content).not.toContain('…');
    expect(element('sources').querySelector('.source-post-date')!.textContent).toContain('2026/9/20');
    expect(element('sources').querySelector('.source-post-metrics')!.textContent).toBe('取得時の反響：いいね 1,200 / リポスト 34 / 返信 5 / 引用 6');
    expect(element('sources').querySelector('.source-selection-scope')).toBeNull();
    click('topic-2'); await flush();
    expect(element('sources').querySelector('.source-topic')!.textContent).toBe('話題：過去X');
    expect(element('sources').querySelector('.source-selection-scope')!.textContent).toBe('過去の反響：全期間の検索候補から選定');
    expect(element('sources').textContent).not.toMatch(/歴代最多|全投稿中|最多いいね/);
    click('topic-3'); await flush();
    expect(element('sources').querySelector('.source-topic')!.textContent).toBe('話題：人物・会社');
    expect(element('sources').querySelector('.source-post-metrics')).toBeNull();
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).toBe(board.content);
  });

  it.each(['x', 'instagram', 'facebook'] as const)('opens numbered %s source details with actual post text and a safe original link', async kind => {
    const value = researchResult(); const source = value.sources[0]!;
    const text = '取得した投稿の全文です。<script>悪意ある文字も文字として表示</script>';
    source.kind = kind;
    source.url = kind === 'x' ? 'https://x.com/fixture/status/100' : `https://${kind}.com/p/fixture`;
    if (kind === 'x') source.xPost = { text, id: '100', authorId: '99', username: 'fixture', createdAt: '2026-09-20T00:00:00Z', likeCount: 0, repostCount: 0, replyCount: 0, quoteCount: 0 };
    else source.socialPost = { text, platform: kind, authorHandle: 'fixture', profileUrl: source.url, identitySourceUrl: 'https://example.invalid', createdAt: '2026-09-20T00:00:00Z' };
    routes.set('/api/session/resume', async () => jsonResponse({ result: value }));
    await boot(); click('resume'); await flush();
    click('topic-0'); await flush();
    const label = kind === 'x' ? 'X' : kind === 'instagram' ? 'Instagram' : 'Facebook';
    expect(element('sources').querySelector('.source-platform')!.textContent).toBe(`出典：${label}`);
    expect(element('sources').querySelector('.source-original')!.textContent).toBe(text);
    expect(element('sources').querySelector('script')).toBeNull();
    const link = element('sources').querySelector('a')!;
    expect(link.href).toBe(source.url); expect(link.rel).toBe('noopener noreferrer');
    expect(element('card-board').textContent).toContain(label);
    expect(document.activeElement).toBe(element('evidence-panel'));
  });

  it('lets G2 scroll through every quoted character then return to the four-card board', async () => {
    const value = researchResult();
    value.cards[0]!.excerpt = '架空の根拠資料についての説明です。'.repeat(15);
    value.sources[0]!.text = value.cards[0]!.excerpt;
    routes.set('/api/session/resume', async () => jsonResponse({ result: value }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    const board = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    let complete = '';
    for (let i = 0; i < 10; i++) {
      devices.g2!.options.onAction?.('next'); await flush();
      devices.g2!.options.onAction?.('primary'); await flush();
      const view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
      if (!view.header.includes('該当文')) { expect(view.content).toBe(board.content); break; }
      expect(view.content).not.toContain('…');
      expect(view.content.split('\n').length).toBeLessThanOrEqual(6);
      complete += view.content.replaceAll('\n', '');
    }
    expect(complete).toBe(value.cards[0]!.excerpt);
  });

  it('has no consent checkbox, does not auto-start on a normal URL, and permits explicit start under prior consent', async () => {
    await boot(); chooseLive();
    expect(document.getElementById('consent')).toBeNull();
    expect(element('audio-notice').textContent).toContain('事前に済んでいる');
    expect(devices.phone!.start).not.toHaveBeenCalled();
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(element<HTMLButtonElement>('conversation').disabled).toBe(false);
    click('conversation'); await flush();
    expect(requests('/api/conversation')).toHaveLength(1);
    click('cancel'); await flush();
    expect(devices.streaming!.cancel).toHaveBeenCalled();
  });

  it('never turns a plain, repeated, or stale source tap into an audio reset', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('person', '架空の検証参加者です'); await flush();
    await selectLatestPerson();
    devices.g2!.options.onAction?.('next'); await flush();
    devices.g2!.options.onAction?.('primary'); await flush();
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).header).toContain('該当文');
    for (let i = 0; i < 4; i++) { devices.g2!.options.onAction?.('primary'); await flush(); }
    expect(requests('/api/conversation/reset')).toHaveLength(0);
    expect(requests('/api/conversation')).toHaveLength(1);
    expect(devices.streaming!.cancel).not.toHaveBeenCalled();
  });

  it('asks separately before retrying audio and lets a double tap cancel it without locking', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('person', '架空の検証参加者です'); await flush();
    await selectLatestPerson();
    devices.g2!.options.onAction?.('previous'); await flush();
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).footer).toContain('人物を聞き直す？');
    devices.g2!.options.onAction?.('secondary'); await flush();
    expect(requests('/api/conversation/reset')).toHaveLength(0);
    expect(element('person-state').textContent).not.toContain('固定中');
    await confirmGlassesAudioAction();
    expect(requests('/api/conversation/reset')).toHaveLength(1);
    devices.g2!.options.onAction?.('primary'); await flush();
    expect(requests('/api/conversation/reset')).toHaveLength(1);
  });

  it('does not restart stopped audio from a plain tap or an old source confirmation', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('person', '架空の検証参加者です'); await flush();
    await selectLatestPerson();
    devices.g2!.options.onAction?.('next'); await flush();
    devices.streaming!.options.onError(new Error('音声接続が切れました。')); await flush();
    devices.g2!.options.onAction?.('primary'); await flush();
    expect(requests('/api/conversation')).toHaveLength(1);
    await confirmGlassesAudioAction();
    expect(requests('/api/conversation')).toHaveLength(2);
  });

  it('asks in the footer before leaving the question board; double tap stays and single tap enters the source', async () => {
    routes.set('/api/session/resume', async () => jsonResponse({ result: researchResult() }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    const view = () => devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    const original = view().content;
    devices.g2!.options.onAction?.('next'); await flush();
    expect(view().content).toBe(original); expect(view().footer).toContain('1回=進む 2回=そのまま');
    devices.g2!.options.onAction?.('secondary'); await flush();
    expect(view().content).toBe(original); expect(view().footer).not.toContain('進む？');
    expect(requests('/api/conversation/reset')).toHaveLength(0);
    devices.g2!.options.onAction?.('next'); await flush();
    devices.g2!.options.onAction?.('primary'); await flush();
    expect(view().header).toContain('該当文'); expect(view().content.replaceAll('\n', '')).toBe(FACT);
    expect(requests('/api/conversation/reset')).toHaveLength(0);
    devices.g2!.options.onAction?.('next'); await flush();
    expect(view().content.replaceAll('\n', '')).toBe(FACT); expect(view().footer).toContain('質問に戻る？');
    devices.g2!.options.onAction?.('primary'); await flush();
    expect(view().content).toBe(original);
  });

  it('keeps the confirmation visible through an ASR delta and does not reset or lock the person on its answer', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('person', '架空の検証参加者です'); await flush();
    await selectLatestPerson();
    devices.g2!.options.onAction?.('next'); await flush();
    stream.options.onDelta('talk', '会話を継続'); await vi.advanceTimersByTimeAsync(500);
    const view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.footer).toContain('2回=そのまま');
    devices.g2!.options.onAction?.('secondary'); await flush();
    expect(element('person-state').textContent).not.toContain('固定中');
    expect(requests('/api/conversation/reset')).toHaveLength(0); expect(stream.cancel).not.toHaveBeenCalled();
  });

  it.each(['secondary', 'primary'] as const)('aligns a board and its sources after %s dismisses a confirmation whose source was replaced', async action => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('person', '架空の検証参加者です'); await flush();
    const work = streams[0]!; const initial = fourCardResult(work.input, '最初');
    pushResearchEvent(work.body, { type: 'update', result: initial }); await flush();
    await selectLatestPerson();
    const view = () => devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    const initialBoard = view().content;
    devices.g2!.options.onAction?.('next'); await flush();
    const enriched = fourCardResult(work.input, '追加', 'COMPLETE');
    enriched.cards = enriched.cards.map((card, index) => ({ ...card, cardId: `new-card-${index}`, sourceId: `new-source-${index}` }));
    enriched.sources = enriched.sources.map((source, index) => ({ ...source, sourceId: `new-source-${index}` }));
    pushResearchEvent(work.body, { type: 'result', result: enriched }); work.body.close(); await flush();
    expect(view().content).toBe(initialBoard); expect(view().footer).toContain('2回=そのまま');
    devices.g2!.options.onAction?.(action); await flush();
    expect(view().content).toContain(enriched.cards[0]!.fact);
    expect(view().content).not.toContain(initial.cards[0]!.fact);
    expect(view().header).not.toContain('該当文');
    devices.g2!.options.onAction?.('next'); await flush();
    devices.g2!.options.onAction?.('primary'); await flush();
    expect(view().content.replaceAll('\n', '')).toBe(enriched.cards[0]!.excerpt);
    expect(requests('/api/conversation/reset')).toHaveLength(0);
  });

  it.each(['secondary', 'primary'] as const)('remaps the same source passage and page offset after progressive reordering on %s', async action => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('person', '架空の検証参加者です'); await flush();
    const work = streams[0]!; const initial = fourCardResult(work.input);
    initial.cards[1]!.excerpt = 'B'.repeat(440); initial.sources[1]!.text = initial.cards[1]!.excerpt;
    pushResearchEvent(work.body, { type: 'update', result: initial }); await flush();
    await selectLatestPerson();
    const view = () => devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    for (let i = 0; i < 3; i++) {
      devices.g2!.options.onAction?.('next'); await flush();
      devices.g2!.options.onAction?.('primary'); await flush();
    }
    expect(view().header).toContain('2/3'); const shown = view().content;
    devices.g2!.options.onAction?.('next'); await flush();
    const enriched = structuredClone(initial); enriched.reasonCode = 'COMPLETE';
    enriched.cards = [enriched.cards[1]!, enriched.cards[0]!, ...enriched.cards.slice(2)].map((card, index) => ({ ...card, cardId: `regenerated-${index}` }));
    pushResearchEvent(work.body, { type: 'result', result: enriched }); work.body.close(); await flush();
    expect(view().content).toBe(shown);
    devices.g2!.options.onAction?.(action); await flush();
    expect(view().header).toMatch(/^1 .*該当文/u);
    expect(view().header).toContain(action === 'secondary' ? '2/3' : '3/3');
    expect(view().content.replaceAll('\n', '')).toBe('B'.repeat(action === 'secondary' ? 216 : 8));
  });

  it('displays the actual search operation and allows a stored alternative to research in the same conversation', async () => {
    const choices = [
      { id: 'search-first', label: '第一候補', query: '架空の検証参加者 公式 プロフィール', target: { personName: '架空の検証参加者', companyName: '' } },
      { id: 'search-second', label: '別の候補', query: '別の架空人物 公開活動 登壇', target: { personName: '別の架空人物', companyName: '' } },
    ];
    routes.set('/api/conversation/identify', async () => jsonResponse({ text: '架空の検証参加者です', targets: [choices[0]!.target], hasPersonMention: true, searchCandidates: choices }));
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!; stream.options.onFinal('person', '架空の検証参加者です'); await flush();
    pushResearchEvent(streams[0]!.body, { type: 'trace', event: { eventId: 1, step: 'search', at: new Date().toISOString(), message: '公開情報を検索', search: { provider: 'x', query: 'from:fixture_user -is:retweet -is:reply', operation: 'archive_search', stage: 'archive' } } }); await flush();
    expect(element('current-search').textContent).toBe('X・過去投稿検索：from:fixture_user -is:retweet -is:reply');
    expect(element('search-choices').children).toHaveLength(2);
    const selectedId = 'fea2e8bc-d39f-4292-bd94-0da29e641a70';
    routes.set('/api/conversation/search-choice', async () => jsonResponse({ requestId: selectedId, subjectRevision: 10, revision: 9, ...choices[1] }));
    (element('search-choices').children[1] as HTMLButtonElement).click(); await flush();
    expect(requests('/api/conversation/search-choice')).toHaveLength(1);
    expect(JSON.parse(String(requests('/api/conversation/search-choice')[0]!.body))).toEqual({ conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab', choiceId: 'search-second' });
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(streams[1]!.input).toMatchObject({ requestId: selectedId, subjectRevision: 10, text: choices[1]!.query, conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab' });
    stream.options.onFinal('while-manual', '元の人物です'); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(1); expect(stream.cancel).not.toHaveBeenCalled();
    pushResearchEvent(streams[1]!.body, { type: 'result', result: researchResult(selectedId, 10) }); streams[1]!.body.close(); streams[0]!.body.close(); await flush();
  });

  it.each(['candidate', 'audio'] as const)('keeps an empty list gesture sequence inert before explicit phone %s action', async destination => {
    const choices = [{ id: 'candidate-one', label: '候補', query: '架空人物', target: { personName: '架空人物', companyName: '' } }];
    routes.set('/api/conversation/identify', async () => jsonResponse({ text: '架空人物', targets: [], hasPersonMention: true, searchCandidates: choices }));
    routes.set('/api/conversation/search-choice', async () => jsonResponse({ requestId: 'fea2e8bc-d39f-4292-bd94-0da29e641a70', subjectRevision: 10, revision: 9, ...choices[0] }));
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('ambiguous', '架空人物'); await flush();
    devices.g2!.options.onAction?.(destination === 'candidate' ? 'previous' : 'next'); await flush();
    devices.g2!.options.onAction?.(destination === 'candidate' ? 'next' : 'previous'); await flush();
    const view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.header).toContain('認識した人物 0/0');
    expect(view.footer).toContain('上下=選択');
    devices.g2!.options.onAction?.('primary'); await flush();
    expect(requests('/api/conversation/reset')).toHaveLength(0);
    expect(requests('/api/conversation/search-choice')).toHaveLength(0);
    if (destination === 'candidate') (element('search-choices').children[0] as HTMLButtonElement).click();
    else click('retry-listening');
    await flush();
    expect(requests('/api/conversation/reset')).toHaveLength(destination === 'audio' ? 1 : 0);
    expect(requests('/api/conversation/search-choice')).toHaveLength(destination === 'candidate' ? 1 : 0);
    expect(devices.streaming!.cancel).not.toHaveBeenCalled();
  });

  it('resynchronizes the visible board with its sources after cancelling audio confirmation during enrichment', async () => {
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('person', '架空の検証参加者です'); await flush();
    const work = streams[0]!; const initial = fourCardResult(work.input, '最初');
    pushResearchEvent(work.body, { type: 'update', result: initial }); await flush();
    await selectLatestPerson();
    devices.g2!.options.onAction?.('previous'); await flush();
    const enriched = fourCardResult(work.input, '追加', 'COMPLETE');
    pushResearchEvent(work.body, { type: 'result', result: enriched }); work.body.close(); await flush();
    const view = () => devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view().content).toContain(initial.cards[0]!.fact);
    devices.g2!.options.onAction?.('secondary'); await flush();
    expect(view().content).toContain(enriched.cards[0]!.fact);
    devices.g2!.options.onAction?.('next'); await flush(); devices.g2!.options.onAction?.('primary'); await flush();
    expect(view().content.replaceAll('\n', '')).toBe(enriched.cards[0]!.excerpt);
    expect(requests('/api/conversation/reset')).toHaveLength(0);
  });

  it('uses list gestures only for people while search alternatives remain explicitly selectable on the phone', async () => {
    const choices = [{ id: 'candidate-one', label: '候補', query: '架空人物 公式 プロフィール', target: { personName: '架空人物', companyName: '' } }];
    routes.set('/api/conversation/identify', async () => jsonResponse({ text: '架空人物です', targets: [choices[0]!.target, { personName: '別の架空人物', companyName: '' }], hasPersonMention: true, searchCandidates: choices }));
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('ambiguous', '架空人物です'); await flush();
    devices.g2!.options.onAction?.('next'); await flush();
    let view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.header).toContain('認識した人物 2/2'); expect(view.content).toContain('→ 2 別の架空人物');
    expect(view.content).not.toContain('公式 プロフィール');
    devices.g2!.options.onAction?.('primary'); await flush();
    view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.header).toBe('別の架空人物'); expect(view.content).toContain('未確認');
    expect(requests('/api/conversation/search-choice')).toHaveLength(0);
    devices.g2!.options.onAction?.('secondary'); await flush();
    expect(requests('/api/conversation/search-choice')).toHaveLength(0); expect(requests('/api/conversation/reset')).toHaveLength(0);
    routes.set('/api/conversation/search-choice', async () => jsonResponse({ requestId: 'fea2e8bc-d39f-4292-bd94-0da29e641a70', subjectRevision: 10, revision: 9, ...choices[0] }));
    (element('search-choices').children[0] as HTMLButtonElement).click(); await flush();
    expect(requests('/api/conversation/search-choice')).toHaveLength(1);
    expect(requests('/api/research')).toHaveLength(1); expect(requests('/api/conversation/reset')).toHaveLength(0);
    expect(devices.streaming!.cancel).not.toHaveBeenCalled();
  });

  it('lets an explicit phone retry during selected-candidate research resume identification on new speech', async () => {
    const choices = [{ id: 'candidate-one', label: '候補', query: '架空人物', target: { personName: '架空人物', companyName: '' } }];
    routes.set('/api/conversation/identify', async () => jsonResponse({ text: '架空人物', targets: [], hasPersonMention: true, searchCandidates: choices }));
    routes.set('/api/conversation/search-choice', async () => jsonResponse({ requestId: 'fea2e8bc-d39f-4292-bd94-0da29e641a70', subjectRevision: 10, revision: 9, ...choices[0] }));
    const streams = openResearchStreams();
    await boot(); chooseLive(); click('conversation'); await flush(); devices.streaming!.options.onFinal('ambiguous', '架空人物'); await flush();
    (element('search-choices').children[0] as HTMLButtonElement).click(); await flush();
    expect(streams).toHaveLength(1);
    click('retry-listening'); await flush();
    expect(requests('/api/conversation/reset')).toHaveLength(1); expect(streams[0]!.signal.aborted).toBe(true);
    devices.streaming!.options.onFinal('fresh-person', '架空人物です'); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(2);
    streams[0]!.body.close(); await flush();
  });

  it('clears a pending source confirmation on audio error and requires a separate restart confirmation', async () => {
    await boot(); chooseLive(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onFinal('person', '架空の検証参加者です'); await flush();
    await selectLatestPerson();
    devices.g2!.options.onAction?.('next'); await flush();
    devices.streaming!.options.onError(new Error('音声接続が切れました。')); await flush();
    const view = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(view.footer).not.toContain('2回=そのまま');
    await confirmGlassesAudioAction();
    expect(requests('/api/conversation')).toHaveLength(2);
    expect(devices.g2!.startAudio).toHaveBeenCalledTimes(2);
  });

  it('discards a search-choice response after session end without paid research', async () => {
    const choices = [{ id: 'candidate-one', label: '候補', query: '架空人物', target: { personName: '架空人物', companyName: '' } }];
    routes.set('/api/conversation/identify', async () => jsonResponse({ text: '架空人物', targets: [], hasPersonMention: true, searchCandidates: choices }));
    const response = deferred<Response>(); routes.set('/api/conversation/search-choice', () => response.promise);
    await boot(); chooseLive(); click('conversation'); await flush(); devices.streaming!.options.onFinal('ambiguous', '架空人物'); await flush();
    (element('search-choices').children[0] as HTMLButtonElement).click(); await flush();
    click('end'); await flush();
    response.resolve(jsonResponse({ requestId: 'fea2e8bc-d39f-4292-bd94-0da29e641a70', subjectRevision: 10, revision: 9, ...choices[0] })); await flush();
    expect(requests('/api/research')).toHaveLength(0);
  });

  it('keeps the real category when a profile fills a missing past-X slot, including source-only metadata', async () => {
    const value = researchResult();
    const topics = ['recent_x', 'recent_x', 'profile', 'profile'] as const;
    value.cards = topics.map((_, index) => ({ ...value.cards[0]!, cardId: `fallback-card-${index}`, sourceId: `fallback-source-${index}` }));
    value.sources = topics.map((topic, index) => ({ ...value.sources[0]!, topic, sourceId: `fallback-source-${index}` }));
    routes.set('/api/session/resume', async () => jsonResponse({ result: value }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    expect(element('hud-expiry').textContent).toBe('4 / 4件確認');
    expect([...element('card-board').querySelectorAll('.topic-number')].map(node => node.textContent))
      .toEqual(['1 / 最近X · 原文・出典 ↗', '2 / 最近X · 原文・出典 ↗', '3 / 人物・会社 · 原文・出典 ↗', '4 / 人物・会社 · 原文・出典 ↗']);
    expect(element('card-board').textContent).not.toContain('過去X');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).not.toContain('過去X');
  });

  it.each([0, 1])('leaves unsupported slots unconfirmed when only %s cards have evidence', async count => {
    const value = researchResult();
    value.cards = value.cards.slice(0, count);
    if (!count) { value.status = 'no_evidence'; value.sources = []; }
    routes.set('/api/session/resume', async () => jsonResponse({ result: value }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    const missing = element('card-board').querySelectorAll<HTMLButtonElement>('.topic-card.empty');
    expect(missing).toHaveLength(4 - count);
    for (const slot of missing) {
      expect(slot.disabled).toBe(true);
      expect(slot.querySelector('.topic-fact')!.textContent).toBe('未確認');
      expect(slot.querySelector('.topic-question')!.textContent).toBe('確認後に表示');
    }
    const rows = (devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content.split('\n\n');
    expect(rows).toHaveLength(4);
    expect(rows.filter(row => row.includes('事実:未確認'))).toHaveLength(4 - count);
  });

  it('shows complete concise pairs without ellipses and retains the full original in source details', async () => {
    const value = researchResult();
    const fact = '😀架空の検証対象が公開した活動記録を紹介しています。'.repeat(3);
    const question = '今回の公開活動でどのようなことを学びましたか？'.repeat(3);
    const displayFact = '公開した活動記録'; const displayQuestion = '活動で学んだことは？';
    value.cards[0] = { ...value.cards[0]!, fact, suggestedQuestion: question, excerpt: fact, displayFact, displayQuestion };
    value.sources[0]!.text = fact;
    routes.set('/api/session/resume', async () => jsonResponse({ result: value }));
    await boot(); click('connect'); await flush(); click('resume'); await flush();
    expect(element('fact').textContent).toBe(displayFact);
    expect(element('question').textContent).toBe(displayQuestion);
    expect(element('sources').querySelector('.source-fact')!.textContent).toBe(`事実（全文）：${fact}`);
    expect(element('sources').querySelector('blockquote')!.textContent).toBe(fact);
    const firstRow = (devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content.split('\n\n')[0]!;
    expect(firstRow).toContain(`事実:${displayFact}`); expect(firstRow).toContain(`⭐️推奨質問：${displayQuestion}`); expect(firstRow).not.toContain('…');
    expect(firstRow).not.toContain('\ufffd');
    const width = Math.max(...firstRow.split('\n').map(line => Array.from(line).reduce((sum, character) => sum + (/^[\x20-\x7e]$/.test(character) ? 1 : 2), 0)));
    expect(width).toBeLessThanOrEqual(45);
  });

  it('does not silently use the phone microphone when the selected G2 is unavailable', async () => {
    await boot(); chooseLive();
    element<HTMLSelectElement>('microphone').value = 'g2';
    devices.g2!.connect.mockResolvedValue(false);
    click('conversation'); await flush();
    expect(devices.g2!.connect).toHaveBeenCalledOnce();
    expect(devices.phone!.start).not.toHaveBeenCalled();
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(element('status').textContent).toContain('G2のマイクに接続できません');
    element<HTMLSelectElement>('microphone').value = 'phone';
    click('conversation'); await flush();
    expect(devices.phone!.start).toHaveBeenCalledWith({ continuous: true });
  });

  it.each([0, 0.00846])('keeps the reserved cost primary when a live result reports preliminary USD %s', async reportedUsd => {
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      const result = researchResult(input.requestId, input.subjectRevision);
      result.usage = { ...result.usage, reservedUsd: 0.063, reportedUsd, reportedCostCalls: 1 };
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`);
    });
    await boot(); chooseLive();
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
    if (action === 'new-recording') { chooseLive(); click('record'); }
    else if (action === 'mode-change') chooseLive();
    else click('end');
    await flush();
    response.resolve(jsonResponse({ result: researchResult() })); await flush();
    expect(element('fact').textContent).not.toBe(FACT);
    expect(element('card-count').textContent).toBe('0 / 0');
    expect(devices.g2!.render.mock.calls.some(([view]) => (view as GlassesView).content.includes('架空の検証'))).toBe(false);
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
    expect(devices.g2!.render.mock.calls.some(([view]) => (view as GlassesView).content.includes('架空の検証'))).toBe(false);
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
  });
});
