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
    await boot(); chooseLiveAndConsent(); click('conversation'); await flush();
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
    expect(element('card-board').textContent).not.toContain(FACT);
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
    await boot(); chooseLiveAndConsent(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('initial', '架空検証社の架空の検証参加者です。'); await flush();
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
    await boot(); chooseLiveAndConsent(); click('connect'); await flush(); click('conversation'); await flush();
    const stream = devices.streaming!;
    const lastView = () => devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(lastView().footer).toContain('G2 聞取中');
    expect(lastView().footer).toContain('発話待ち');
    stream.options.onDelta('first', '架空検証社の');
    await vi.advanceTimersByTimeAsync(500);
    expect(lastView().footer).toContain('架空検証社の');
    stream.options.onFinal('first', '架空検証社の架空の検証参加者です。'); await flush();
    await vi.advanceTimersByTimeAsync(500);
    const board = lastView().content;
    expect(board.split('\n')).toHaveLength(4);
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
  ])('shows the actual audio error category on glasses and permits restart: %s', async (message, label) => {
    await boot(); chooseLiveAndConsent(); click('connect'); await flush(); click('conversation'); await flush();
    devices.streaming!.options.onError(new Error(message)); await flush();
    const lastView = devices.g2!.render.mock.calls.at(-1)![0] as GlassesView;
    expect(lastView.footer).toContain(label);
    expect(element('status').textContent).toBe(message);
    expect(element('conversation').textContent).toBe('会話モードを再開');
    expect(element<HTMLButtonElement>('conversation').disabled).toBe(false);
    click('conversation'); await flush();
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).footer).toContain('G2 聞取中');
  });

  it('pauses capture for ambiguous candidates and selects within the original conversation budget', async () => {
    routes.set('/api/research', async init => {
      const input = JSON.parse(String(init.body)) as ResearchInput;
      if (input.selectedCandidateId) return resultResponse(input);
      const result = researchResult(input.requestId, input.subjectRevision);
      result.status = 'awaiting_confirmation'; result.cards = []; result.candidates = [{ id: 'candidate-a', personName: '架空の検証参加者', companyName: '架空検証社', reason: '同名の候補', sourceIds: [] }];
      return new Response(`${JSON.stringify({ type: 'result', result })}\n`);
    });
    await boot(); chooseLiveAndConsent(); click('conversation'); await flush();
    const stream = devices.streaming!;
    stream.options.onFinal('ambiguous', '架空検証社の架空の検証参加者です。'); await flush();
    expect(devices.phone!.recording).toBe(false);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(element('candidates').children).toHaveLength(1);
    stream.options.onFinal('late', '別の会社の人物です。'); await flush();
    expect(requests('/api/conversation/identify')).toHaveLength(1);
    (element('candidates').firstElementChild as HTMLButtonElement).click(); await flush();
    expect(requests('/api/research')).toHaveLength(2);
    expect(JSON.parse(String(requests('/api/research')[1]!.body))).toMatchObject({ selectedCandidateId: 'candidate-a', conversationId: '8a874d7b-6dda-41a2-8a27-d70e440b10ab' });
    expect(element('card-board').textContent).toContain(FACT);
  });

  it('cancels streaming and active identification, ignoring delayed final text and identification responses', async () => {
    const gate = deferred<Response>(); routes.set('/api/conversation/identify', () => gate.promise);
    await boot(); chooseLiveAndConsent(); click('conversation'); await flush();
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
    await boot(); chooseLiveAndConsent(); element<HTMLTextAreaElement>('text').value = 'old private conversation';
    await vi.advanceTimersByTimeAsync(900_000);
    expect(element<HTMLTextAreaElement>('text').value).toBe('');
    expect(element<HTMLInputElement>('consent').checked).toBe(false);
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
    await boot(); chooseLiveAndConsent(); element<HTMLTextAreaElement>('text').value = 'old private input'; click('research'); await flush();
    expect(element<HTMLTextAreaElement>('text').value).toBe('');
    expect(element('trace').children).toHaveLength(0);
    expect(element('workspace').classList.contains('hidden')).toBe(true);
    expect(element<HTMLInputElement>('consent').checked).toBe(false);
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

  it('prepares live G2 conversation from a QR without preregistration or starting the microphone', async () => {
    routes.set('/api/status', async () => jsonResponse({ liveEnabled: true, missing: [], streamingEnabled: true, accessCodeRequired: true }));
    window.history.replaceState(null, '', '/?conversation=1#login=' + 'c'.repeat(64));
    routes.set('/api/session/qr/redeem', async () => jsonResponse({ token: 'qr-session', revision: 0, expiresAt: Date.now() + 900_000, hasPrevious: false, interrupted: false }));
    await boot();
    expect(window.location.hash).toBe('');
    expect(element<HTMLSelectElement>('mode').value).toBe('live');
    expect(element<HTMLTextAreaElement>('text').value).toBe('');
    expect(devices.g2!.connect).toHaveBeenCalledOnce();
    expect(devices.g2!.startAudio).not.toHaveBeenCalled();
    expect(requests('/api/conversation')).toHaveLength(0);
    expect(requests('/api/research')).toHaveLength(0);
    element<HTMLInputElement>('consent').checked = true;
    element('consent').dispatchEvent(new Event('change'));
    click('conversation'); await flush();
    expect(devices.g2!.startAudio).toHaveBeenCalledWith({ continuous: true });
    expect(requests('/api/conversation')).toHaveLength(1);
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
    await boot(); chooseLiveAndConsent();
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
    expect(initialView.content.split('\n')).toEqual(words.map((word, index) => `${index + 1} 事:公開事実${word}。 問:質問${word}？`));
    click('next'); await flush();
    expect(element('card-count').textContent).toBe('2 / 4');
    expect(element('sources').querySelector('.source-fact')!.textContent).toBe('事実（全文）：公開事実に。');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).toBe(initialView.content);
    click('topic-3'); await flush();
    expect(element('card-count').textContent).toBe('4 / 4');
    expect(element('sources').querySelector('blockquote')!.textContent).toBe('公開事実よん。');
    expect((devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content).toBe(initialView.content);
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
    const rows = (devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content.split('\n');
    expect(rows).toHaveLength(4);
    expect(rows.filter(row => row.includes('事:未確認'))).toHaveLength(4 - count);
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
    const firstRow = (devices.g2!.render.mock.calls.at(-1)![0] as GlassesView).content.split('\n')[0]!;
    expect(firstRow).toContain(`事:${displayFact}`); expect(firstRow).toContain(`問:${displayQuestion}`); expect(firstRow).not.toContain('…');
    expect(firstRow).not.toContain('\ufffd');
    const width = Array.from(firstRow).reduce((sum, character) => sum + (/^[\x20-\x7e]$/.test(character) ? 1 : 2), 0);
    expect(width).toBeLessThanOrEqual(45);
  });

  it('does not silently use the phone microphone when the selected G2 is unavailable', async () => {
    await boot(); chooseLiveAndConsent();
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
