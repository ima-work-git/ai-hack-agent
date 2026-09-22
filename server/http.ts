import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ResearchInputSchema, TargetSchema, PlanDecisionSchema } from '../src/shared/contracts.ts';
import type { ResearchInput, ResearchResult, Target } from '../src/shared/contracts.ts';
import type { AppConfig } from './config.ts';
import { SessionStore } from './sessions.ts';
import { DeviceLoginError, DeviceLoginStore } from './device-logins.ts';
import { BudgetError, BudgetLedger } from './budget.ts';
import { runAgent } from './agent.ts';
import { createFixtureProvider } from './fixtures.ts';
import { createLiveProvider, prepareAudio } from './providers.ts';
import type { ResearchProvider } from './provider-contract.ts';
import { ProviderError } from './provider-contract.ts';
import { createStreamingRelay } from './ws-relay.ts';
import { verifiedAliasForInputTarget } from '../src/shared/identity-aliases.ts';

interface HttpDependencies {
  store?: SessionStore;
  deviceLogins?: DeviceLoginStore;
  budget?: BudgetLedger;
  provider?: (input: ResearchInput) => ResearchProvider;
  liveProvider?: ResearchProvider;
  runAgent?: typeof runAgent;
  now?: () => number;
}
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CancelSchema = z.object({ requestId: z.string(), subjectRevision: z.number().int().positive(), conversationId: z.string().uuid().optional() }).strict();
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
function sendJson(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { req.resume(); throw new HttpError(413, '入力サイズの上限を超えています。'); }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', failed);
      if (error) { chunks.length = 0; req.resume(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > maximum) finish(new HttpError(413, '入力サイズの上限を超えています。')); else chunks.push(chunk); };
    const end = () => finish();
    const aborted = () => finish(new HttpError(400, '入力の送信が中断されました。'));
    const failed = () => finish(new HttpError(400, '入力を読み取れませんでした。'));
    const timer = setTimeout(() => finish(new HttpError(408, '入力の送信がタイムアウトしました。')), 5_000);
    req.on('data', data); req.on('end', end); req.on('aborted', aborted); req.on('error', failed);
  });
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'JSON形式で送信してください。');
  try { return JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSONを読み取れませんでした。'); }
}

export function createApiHandler(config: AppConfig, dependencies: HttpDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const store = dependencies.store ?? new SessionStore(config.budget.directory, now);
  const deviceLogins = dependencies.deviceLogins ?? new DeviceLoginStore(config.budget.directory, config.accessCode, now);
  const budget = dependencies.budget ?? (config.status.liveEnabled ? new BudgetLedger(config.budget) : undefined);
  const liveProvider = dependencies.liveProvider ?? createLiveProvider(config.providers);
  const research = dependencies.runAgent ?? runAgent;
  const configuredOrigin = new URL(config.origin);
  const origins = new Set([config.origin, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  const attempts = new Map<string, { count: number; until: number }>();
  const active = new Map<string, { requestId: string; revision: number; controller: AbortController }>();
  const conversations = new Map<string, { id: string; expiresAt: number; transcriptContext: string; finalTexts: string[]; requests: Map<string, { revision: number; transcribed: boolean; researchStarted: boolean }> }>();
  const streamTickets = new Map<string, { sessionId: string; conversationId: string; expiresAt: number }>();
  const dropConversation = (sessionId: string) => {
    const group = conversations.get(sessionId);
    if (group) relay.closeConversation(group.id);
    conversations.delete(sessionId);
    for (const [ticket, grant] of streamTickets) if (grant.sessionId === sessionId) streamTickets.delete(ticket);
  };
  const conversationFor = (sessionId: string, id: string) => {
    const conversation = conversations.get(sessionId);
    if (!uuidPattern.test(id) || !conversation || conversation.id !== id || conversation.expiresAt <= now() || !store.get(sessionId)) {
      if (conversation && (conversation.expiresAt <= now() || !store.get(sessionId))) dropConversation(sessionId);
      throw new HttpError(409, '会話モードが終了または失効しました。もう一度開始してください。');
    }
    return conversation;
  };
  const qrTickets = new Map<string, { issuerSessionId: string; expiresAt: number }>();
  const sweepQrTickets = () => {
    for (const [hash, ticket] of qrTickets) if (ticket.expiresAt <= now() || !store.get(ticket.issuerSessionId)) qrTickets.delete(hash);
  };
  const sweep = setInterval(() => {
    store.sweep();
    sweepQrTickets();
    for (const [sessionId, conversation] of conversations) if (conversation.expiresAt <= now() || !store.get(sessionId)) {
      const current = active.get(sessionId);
      if (current && conversation.requests.has(current.requestId)) { store.cancel(sessionId); active.delete(sessionId); }
      dropConversation(sessionId);
    }
    // An unavailable credential file must never turn a timer error into a crash.
    try { deviceLogins.sweep(); } catch { /* Authentication reads the store again and fails closed. */ }
    for (const [id] of active) if (!store.get(id)) active.delete(id);
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
  }, 10_000);
  sweep.unref();
  const cookie = (id: string, expiresAt?: number) => `sessionId=${id}; Path=/api; HttpOnly; SameSite=Strict${configuredOrigin.protocol === 'https:' ? '; Secure' : ''}; ${expiresAt ? `Expires=${new Date(expiresAt).toUTCString()}` : 'Max-Age=0'}`;
  const rememberedCookie = (token: string, expiresAt?: number) => `rememberedDevice=${token}; Path=/api; HttpOnly; SameSite=Strict${configuredOrigin.protocol === 'https:' ? '; Secure' : ''}; ${expiresAt ? `Expires=${new Date(expiresAt).toUTCString()}` : 'Max-Age=0'}`;
  const readCookie = (req: IncomingMessage, name: string, pattern: RegExp) => {
    const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
    return values.length === 1 && pattern.test(values[0]!) ? values[0] : undefined;
  };
  const sessionCookie = (req: IncomingMessage) => readCookie(req, 'sessionId', /^[a-f0-9]{32}$/);
  const deviceCookie = (req: IncomingMessage) => readCookie(req, 'rememberedDevice', /^[a-f0-9]{64}$/);
  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin) || new URL(origin).host.toLowerCase() !== req.headers.host?.toLowerCase()) throw new HttpError(403, '許可されていない接続元です。');
  };
  const relay = createStreamingRelay({
    apiKey: config.streamingApiKey, model: config.streamingModel, maximumPerMinute: config.streamingAudioMaxPerMinute,
    budget, now, allowOrigin: req => { try { sameOrigin(req); return true; } catch { return false; } },
    takeTicket: ticket => {
      const hash = createHash('sha256').update(ticket).digest('hex');
      const grant = streamTickets.get(hash); streamTickets.delete(hash);
      if (!grant || grant.expiresAt <= now()) throw new HttpError(401, '音声接続が失効しました。');
      const group = conversationFor(grant.sessionId, grant.conversationId);
      return { ...grant, expiresAt: group.expiresAt,
        valid: () => conversations.get(grant.sessionId) === group && group.expiresAt > now() && !!store.get(grant.sessionId),
        onFinal: text => { group.finalTexts.push(text); if (group.finalTexts.length > 8) group.finalTexts.shift(); group.transcriptContext = `${group.transcriptContext}\n${text}`.trim().slice(-2000); },
      };
    },
  });
  const rateLimit = (req: IncomingMessage, scope: 'code' | 'restore') => {
    const address = `${scope}:${req.socket.remoteAddress ?? 'unknown'}`;
    const rate = attempts.get(address);
    const maximum = scope === 'code' ? 10 : 20;
    if (rate && rate.until > now() && rate.count >= maximum) throw new HttpError(429, 'ログイン試行の上限です。1分後に再試行してください。');
    attempts.set(address, { count: rate && rate.until > now() ? rate.count + 1 : 1, until: rate && rate.until > now() ? rate.until : now() + 60_000 });
  };
  const beginSession = (req: IncomingMessage) => {
    const previousId = sessionCookie(req);
    if (previousId) dropConversation(previousId);
    if (previousId && store.get(previousId)?.running) {
      store.cancel(previousId); active.delete(previousId);
      const previous = store.get(previousId); if (previous) { previous.interrupted = true; store.save(previous); }
    }
    return store.login(previousId);
  };
  const validResult = (result: ResearchResult | undefined, revision: number) => {
    if (!result || result.subjectRevision !== revision) return null;
    if (result.cards.some(card => Date.parse(card.expiresAt) <= now())) return null;
    return result;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url?.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const origin = req.headers.origin;
      if (!req.headers.host || !hosts.has(req.headers.host.toLowerCase()) || origin && !origins.has(origin)) throw new HttpError(403, '許可されていない接続元です。');
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Credentials', 'true'); }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id, X-Subject-Revision, X-Conversation-Id' }); res.end(); return true;
      }
      if (req.method === 'GET' && path === '/api/status') { sendJson(res, 200, config.status); return true; }
      if (req.method === 'POST' && path === '/api/session') {
        rateLimit(req, 'code');
        const body = z.object({ accessCode: z.string().max(512).default(''), rememberDevice: z.boolean().default(false) }).strict().parse(await jsonBody(req));
        if (!safeEqual(body.accessCode, config.accessCode)) throw new HttpError(401, '利用コードが一致しません。');
        const remembered = body.rememberDevice ? deviceLogins.issue(deviceCookie(req)) : undefined;
        if (!body.rememberDevice) deviceLogins.revoke(deviceCookie(req));
        const { session, token } = beginSession(req);
        res.setHeader('Set-Cookie', [cookie(session.id, session.expiresAt), remembered ? rememberedCookie(remembered.token, remembered.expiresAt) : rememberedCookie('')]);
        sendJson(res, 200, { token, expiresAt: session.expiresAt, revision: session.revision, hasPrevious: !!validResult(session.result, session.revision), interrupted: session.interrupted });
        return true;
      }
      if (req.method === 'POST' && path === '/api/session/restore') {
        sameOrigin(req); rateLimit(req, 'restore');
        z.object({}).strict().parse(await jsonBody(req));
        if (!deviceLogins.authenticate(deviceCookie(req))) {
          res.setHeader('Set-Cookie', rememberedCookie(''));
          throw new HttpError(401, '利用コードで開始してください。');
        }
        const { session, token } = beginSession(req);
        res.setHeader('Set-Cookie', cookie(session.id, session.expiresAt));
        sendJson(res, 200, { token, expiresAt: session.expiresAt, revision: session.revision, hasPrevious: !!validResult(session.result, session.revision), interrupted: session.interrupted });
        return true;
      }
      if (req.method === 'POST' && path === '/api/session/qr/redeem') {
        sameOrigin(req); rateLimit(req, 'restore');
        const body = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await jsonBody(req));
        const hash = createHash('sha256').update(body.ticket).digest('hex');
        const grant = qrTickets.get(hash);
        // Consume synchronously before issuing any credential. Concurrent or
        // retried requests cannot reuse a grant, including after later failures.
        qrTickets.delete(hash);
        if (!grant || grant.expiresAt <= now() || !store.get(grant.issuerSessionId)) throw new HttpError(401, 'QRコードが失効しました。新しいQRコードで開始してください。');
        const remembered = deviceLogins.issue(deviceCookie(req));
        const { session, token } = store.login();
        res.setHeader('Set-Cookie', [cookie(session.id, session.expiresAt), rememberedCookie(remembered.token, remembered.expiresAt)]);
        sendJson(res, 200, { token, expiresAt: session.expiresAt, revision: session.revision, hasPrevious: false, interrupted: false });
        return true;
      }
      if (req.method === 'POST' && path === '/api/session/forget') {
        sameOrigin(req);
        z.object({}).strict().parse(await jsonBody(req));
        deviceLogins.revoke(deviceCookie(req));
        const authorization = req.headers.authorization;
        const authenticated = authorization?.startsWith('Bearer ') ? store.authenticate(authorization.slice(7)) : null;
        for (const id of new Set([sessionCookie(req), authenticated?.id])) if (id) { store.end(id); active.delete(id); dropConversation(id); }
        res.setHeader('Set-Cookie', [cookie(''), rememberedCookie('')]);
        sendJson(res, 200, { ended: true }); return true;
      }
      const authorization = req.headers.authorization;
      const session = authorization?.startsWith('Bearer ') ? store.authenticate(authorization.slice(7)) : null;
      if (!session) throw new HttpError(401, '再ログインしてください。');
      if (req.method === 'POST' && path === '/api/conversation/stream') {
        sameOrigin(req);
        const body = z.object({ conversationId: z.string().uuid() }).strict().parse(await jsonBody(req));
        if (!config.status.streamingEnabled || !budget) throw new HttpError(403, 'ストリーミング音声の設定が未完了です。');
        const group = conversationFor(session.id, body.conversationId);
        for (const [hash, grant] of streamTickets) if (grant.expiresAt <= now() || grant.sessionId === session.id) streamTickets.delete(hash);
        if (streamTickets.size >= 20) throw new HttpError(429, '音声接続が混雑しています。');
        const ticket = randomBytes(32).toString('hex'); const expiresAt = Math.min(now() + 60_000, group.expiresAt);
        streamTickets.set(createHash('sha256').update(ticket).digest('hex'), { sessionId: session.id, conversationId: group.id, expiresAt });
        sendJson(res, 200, { ticket, expiresAt }); return true;
      }
      if (req.method === 'POST' && path === '/api/conversation/identify') {
        sameOrigin(req);
        const body = z.object({ conversationId: z.string().uuid(), requestId: z.string().uuid(), subjectRevision: z.number().int().positive(), text: z.string().trim().min(1).max(2000) }).strict().parse(await jsonBody(req));
        if (!config.status.streamingEnabled || !budget) throw new HttpError(403, 'ストリーミング音声の設定が未完了です。');
        const group = conversationFor(session.id, body.conversationId);
        if (session.running || body.subjectRevision <= session.revision || group.requests.has(body.requestId) || session.requestIds.includes(body.requestId)) throw new HttpError(409, 'この音声の処理を開始できません。');
        if (group.requests.size >= 100) throw new HttpError(429, 'この会話の処理回数が上限です。');
        const finalIndex = group.finalTexts.indexOf(body.text);
        if (finalIndex < 0) throw new HttpError(409, '確定した音声文字起こしと一致しません。');
        group.finalTexts.splice(finalIndex, 1);
        const window = { revision: body.subjectRevision, transcribed: false, researchStarted: false }; group.requests.set(body.requestId, window);
        const controller = store.start(session); active.set(session.id, { requestId: body.requestId, revision: body.subjectRevision, controller });
        const disconnected = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', disconnected);
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const reservation = await budget.reserve(group.id, config.maximumCosts.llm);
          if (controller.signal.aborted) { await budget.settle(reservation, 0); throw new HttpError(408, '音声の解析を停止しました。'); }
          const planned = await liveProvider.plan({ text: `引用された会話の中の人物候補を抽出してください。直近発話に氏名がない場合はtarget=nullにしてください。前の会話は所属の補助だけです。\n${JSON.stringify({ previousTranscript: group.transcriptContext.slice(-1200), currentTranscript: body.text.slice(-650) })}`.slice(0, 2000), requestId: body.requestId, subjectRevision: body.subjectRevision, mode: 'live', scenario: 'normal', conversationId: group.id }, controller.signal);
          await budget.settle(reservation, planned.actualUsd ?? null);
          const plan = PlanDecisionSchema.parse(planned.value);
          if (controller.signal.aborted || conversations.get(session.id) !== group || !store.finish(session.id, controller)) throw new HttpError(409, '停止または失効した解析です。');
          const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja');
          const current = normalize(body.text); const context = normalize(group.transcriptContext);
          const proposed = plan.needsConfirmation ? plan.candidates : plan.target ? [plan.target] : [];
          const targets = proposed.filter(target => current.includes(normalize(target.personName)) && context.includes(normalize(target.companyName)) ||
            verifiedAliasForInputTarget(group.transcriptContext, target) && verifiedAliasForInputTarget(`${body.text}\n${target.companyName}`, target)).slice(0, 3).map(({ personName, companyName }) => ({ personName, companyName }));
          window.transcribed = true; session.running = false; store.save(session); active.delete(session.id);
          sendJson(res, 200, { text: body.text, targets, hasPersonMention: true });
        } finally { clearTimeout(timer); res.off('close', disconnected); if (active.get(session.id)?.controller === controller) { store.cancel(session.id); active.delete(session.id); } }
        return true;
      }
      if (req.method === 'POST' && path === '/api/conversation') {
        sameOrigin(req); z.object({}).strict().parse(await jsonBody(req));
        if (!store.authenticate(authorization!.slice(7))) throw new HttpError(401, '再ログインしてください。');
        if (session.running) throw new HttpError(409, '処理が進行中です。停止してから開始してください。');
        if ((!config.status.sttEnabled && !config.status.streamingEnabled) || !config.status.liveEnabled || !budget) throw new HttpError(403, '会話モードの音声・実API設定が未完了です。');
        const conversation = { id: randomUUID(), expiresAt: session.expiresAt, transcriptContext: '', finalTexts: [] as string[], requests: new Map<string, { revision: number; transcribed: boolean; researchStarted: boolean }>() };
        dropConversation(session.id); conversations.set(session.id, conversation);
        sendJson(res, 200, { conversationId: conversation.id, expiresAt: conversation.expiresAt }); return true;
      }
      if (req.method === 'POST' && path === '/api/session/qr') {
        sameOrigin(req);
        z.object({}).strict().parse(await jsonBody(req));
        // Body reading is asynchronous: the issuer may expire or log out meanwhile.
        if (!store.authenticate(authorization!.slice(7))) throw new HttpError(401, '再ログインしてください。');
        sweepQrTickets();
        if (qrTickets.size >= 5) throw new HttpError(429, '発行済みQRコードの上限です。使用または失効後に再度お試しください。');
        const ticket = randomBytes(32).toString('hex');
        const expiresAt = Math.min(now() + 10 * 60_000, session.expiresAt);
        qrTickets.set(createHash('sha256').update(ticket).digest('hex'), { issuerSessionId: session.id, expiresAt });
        sendJson(res, 200, { ticket, expiresAt }); return true;
      }
      if (req.method === 'POST' && path === '/api/session/resume') {
        const previous = validResult(session.result, session.revision);
        sendJson(res, 200, { result: previous, input: previous ? session.lastInput : null, interrupted: session.interrupted }); return true;
      }
      if (req.method === 'DELETE' && path === '/api/session') {
        deviceLogins.revoke(deviceCookie(req));
        store.end(session.id); active.delete(session.id); dropConversation(session.id);
        res.setHeader('Set-Cookie', [cookie(''), rememberedCookie('')]); sendJson(res, 200, { ended: true }); return true;
      }
      if (req.method === 'POST' && path === '/api/cancel') {
        const body = CancelSchema.parse(await jsonBody(req));
        const current = active.get(session.id);
        if (body.conversationId) {
          const conversation = conversationFor(session.id, body.conversationId);
          if (current && (!conversation.requests.has(current.requestId) || current.requestId !== body.requestId || current.revision !== body.subjectRevision)) throw new HttpError(409, '現在の調査と一致しません。');
        } else if (!current || current.requestId !== body.requestId || current.revision !== body.subjectRevision) throw new HttpError(409, '現在の調査と一致しません。');
        store.cancel(session.id); active.delete(session.id); dropConversation(session.id); delete session.result; store.save(session);
        sendJson(res, 200, { cancelled: true }); return true;
      }
      if (req.method === 'POST' && path === '/api/research') {
        const input = ResearchInputSchema.parse(await jsonBody(req));
        if (!uuidPattern.test(input.requestId)) throw new HttpError(400, '調査の要求IDはUUIDで送信してください。');
        if (!store.get(session.id)) throw new HttpError(401, 'セッションが期限切れです。再ログインしてください。');
        if (input.mode === 'live' && !config.status.liveEnabled) throw new HttpError(403, '実APIの設定と費用上限が未完了です。');
        if (session.running) throw new HttpError(409, '調査が進行中です。停止してから開始してください。');
        if (session.lastInput?.requestId === input.requestId || session.requestIds.includes(input.requestId)) throw new HttpError(409, 'この要求IDは処理済みです。');
        if (session.requestIds.length >= 100) throw new HttpError(429, 'このセッションの調査回数上限です。終了して新しいセッションを開始してください。');
        if (input.subjectRevision <= session.revision) throw new HttpError(409, '対象の版が古くなっています。状態を再取得してください。');
        const conversation = input.conversationId ? conversationFor(session.id, input.conversationId) : undefined;
        const window = conversation?.requests.get(input.requestId);
        const confirmsConversation = !!input.selectedCandidateId && session.lastInput?.conversationId === conversation?.id;
        if (conversation && (input.mode !== 'live' || !confirmsConversation && (!window?.transcribed || window.researchStarted || window.revision !== input.subjectRevision))) throw new HttpError(409, 'この会話の音声処理と調査要求が一致しません。');
        if (!conversation && conversations.get(session.id)?.requests.has(input.requestId)) throw new HttpError(409, '会話の識別子が必要です。');
        let confirmedTarget: Target | undefined;
        if (input.selectedCandidateId) {
          if (session.lastInput?.conversationId && input.conversationId !== session.lastInput.conversationId) throw new HttpError(409, '元の会話の識別子が必要です。');
          const prior = validResult(session.result, session.revision);
          const selected = prior?.status === 'awaiting_confirmation' ? prior.candidates.find(c => c.id === input.selectedCandidateId) : undefined;
          if (!selected || session.lastInput?.text !== input.text || session.lastInput.mode !== input.mode || session.lastInput.scenario !== input.scenario) throw new HttpError(409, '選択した候補が元の入力と一致しません。');
          confirmedTarget = { personName: selected.personName, companyName: selected.companyName };
        }
        session.revision = input.subjectRevision; session.lastInput = input; session.requestIds.push(input.requestId); delete session.result;
        if (window) window.researchStarted = true;
        const controller = store.start(session);
        active.set(session.id, { requestId: input.requestId, revision: input.subjectRevision, controller });
        const stillCurrent = () => active.get(session.id)?.controller === controller && !controller.signal.aborted && !!store.get(session.id) && (!conversation || conversations.get(session.id) === conversation && conversation.expiresAt > now());
        const disconnected = () => { if (!res.writableEnded && stillCurrent()) { session.interrupted = true; store.cancel(session.id); active.delete(session.id); } };
        res.on('close', disconnected);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const sendLine = (value: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(value) + '\n'); };
        try {
          let provider = dependencies.provider?.(input) ?? (input.mode === 'demo' ? createFixtureProvider(input.scenario) : liveProvider);
          if (confirmedTarget && input.mode === 'live') {
            const original = provider;
            const selected = confirmedTarget;
            provider = { ...original, plan: (raw, signal) => original.plan({ ...raw, text: `氏名: ${selected.personName}\n会社: ${selected.companyName}`, selectedCandidateId: undefined }, signal) };
          }
          const result = await research(input, provider, {
            signal: controller.signal, now, budget, maximumCosts: config.maximumCosts,
            budgetRunId: conversation?.id ?? input.requestId, confirmedTarget,
            onEvent: event => { if (stillCurrent()) sendLine({ type: 'trace', event }); },
          });
          if (stillCurrent() && store.finish(session.id, controller)) {
            session.running = false; session.result = result; store.save(session); active.delete(session.id);
            sendLine({ type: 'result', result });
          } else sendLine({ type: 'error', message: '停止または失効した調査の結果は破棄しました。' });
        } catch {
          sendLine({ type: 'error', message: '調査を完了できませんでした。入力・設定・接続を確認してください。' });
        } finally {
          res.off('close', disconnected);
          if (active.get(session.id)?.controller === controller) { store.cancel(session.id); active.delete(session.id); }
          if (!res.destroyed && !res.writableEnded) res.end();
        }
        return true;
      }
      if (req.method === 'POST' && path === '/api/transcribe') {
        if (!config.status.sttEnabled || !budget || !liveProvider.transcribe) throw new HttpError(403, '音声認識の設定と費用上限が未完了です。');
        if (session.running) throw new HttpError(409, '別の処理が進行中です。');
        const requestId = req.headers['x-request-id'];
        if (typeof requestId !== 'string' || !uuidPattern.test(requestId)) throw new HttpError(400, '音声の要求IDが必要です。');
        const conversationId = req.headers['x-conversation-id'];
        if (conversationId !== undefined && (typeof conversationId !== 'string' || !uuidPattern.test(conversationId))) throw new HttpError(400, '会話の識別子が不正です。');
        const revision = req.headers['x-subject-revision'] === undefined ? session.revision + 1 : Number(req.headers['x-subject-revision']);
        if (!Number.isSafeInteger(revision) || revision <= session.revision) throw new HttpError(409, '音声の対象の版が古くなっています。');
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'audio/wav') throw new HttpError(415, 'WAV形式で送信してください。');
        const bytes = await readBody(req, 1_000_000);
        prepareAudio(bytes, 'audio/wav');
        // Recheck after reading: another request may have acquired the session in the meantime.
        if (session.running || !store.get(session.id)) throw new HttpError(409, 'この処理を開始できません。');
        const conversation = typeof conversationId === 'string' ? conversationFor(session.id, conversationId) : undefined;
        if (!conversation && conversations.get(session.id)?.requests.has(requestId)) throw new HttpError(409, '会話の識別子が必要です。');
        if (conversation?.requests.has(requestId) || session.requestIds.includes(requestId)) throw new HttpError(409, 'この音声要求は処理済みです。');
        if (conversation && conversation.requests.size >= 100) throw new HttpError(429, 'この会話の音声処理回数が上限に達しました。');
        const window = { revision, transcribed: false, researchStarted: false };
        conversation?.requests.set(requestId, window);
        const controller = store.start(session);
        active.set(session.id, { requestId, revision, controller });
        const disconnected = () => { if (!res.writableEnded && active.get(session.id)?.controller === controller) { session.interrupted = true; store.cancel(session.id); active.delete(session.id); } };
        res.on('close', disconnected);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const interrupted = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new HttpError(408, '音声認識が中断またはタイムアウトしました。')), { once: true });
          timer = setTimeout(() => controller.abort(), 8_000);
        });
        try {
          let transcriptTargets: Target[] | undefined;
          let transcriptHasPersonMention: boolean | undefined;
          const operation = (async () => {
            const reservation = await budget.reserve(conversation?.id ?? requestId, config.sttMax);
            if (controller.signal.aborted) { await budget.settle(reservation, 0); throw new HttpError(408, '音声認識を停止しました。'); }
            const response = await liveProvider.transcribe!(bytes, 'audio/wav', controller.signal, conversation?.transcriptContext);
            await budget.settle(reservation, response.actualUsd ?? null);
            if (response.transcriptTargets !== undefined) transcriptTargets = z.array(TargetSchema).max(3).parse(response.transcriptTargets);
            if (response.transcriptHasPersonMention !== undefined) transcriptHasPersonMention = z.boolean().parse(response.transcriptHasPersonMention);
            return z.string().trim().min(1).max(2000).parse(response.value);
          })();
          const text = await Promise.race([operation, interrupted]);
          if (conversation && (conversations.get(session.id) !== conversation || conversation.expiresAt <= now())) throw new HttpError(409, '会話モードが終了または失効しました。');
          if (!store.finish(session.id, controller)) throw new HttpError(409, '失効した音声認識の結果は破棄しました。');
          window.transcribed = true;
          if (conversation) conversation.transcriptContext = `${conversation.transcriptContext}\n${text}`.trim().slice(-2000);
          session.running = false; store.save(session); active.delete(session.id);
          sendJson(res, 200, { text, ...(transcriptTargets === undefined ? {} : { targets: transcriptTargets }), ...(transcriptHasPersonMention === undefined ? {} : { hasPersonMention: transcriptHasPersonMention }) });
        } finally {
          if (timer) clearTimeout(timer);
          bytes.fill(0);
          res.off('close', disconnected);
          if (active.get(session.id)?.controller === controller) { store.cancel(session.id); active.delete(session.id); }
        }
        return true;
      }
      throw new HttpError(404, 'このAPIはありません。');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError || error instanceof ProviderError && error.code === 'INVALID_AUDIO' || error instanceof DeviceLoginError && error.code === 'NOT_CONFIGURED' ? 400 : error instanceof BudgetError && error.code === 'BUDGET_EXHAUSTED' || error instanceof DeviceLoginError && error.code === 'CAPACITY' ? 429 : 500;
      const message = error instanceof HttpError ? error.message : error instanceof DeviceLoginError && error.code === 'CAPACITY' ? '記憶できる端末数の上限です。端末の記憶を解除するか、記憶せず開始してください。' : status === 400 ? '入力の形式を確認してください。' : '処理を完了できませんでした。';
      if (res.headersSent) { if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ type: 'error', message }) + '\n'); }
      else sendJson(res, status, { message });
      return true;
    }
  }
  return { handle, upgrade: relay.upgrade, close() { relay.close(); streamTickets.clear(); clearInterval(sweep); qrTickets.clear(); conversations.clear(); for (const id of active.keys()) { const session = store.get(id); if (session) { session.interrupted = true; store.save(session); } } store.close(); active.clear(); } };
}
