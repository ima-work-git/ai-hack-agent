import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ResearchInputSchema } from '../src/shared/contracts.ts';
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
const CancelSchema = z.object({ requestId: z.string(), subjectRevision: z.number().int().positive() }).strict();
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
  const sweep = setInterval(() => {
    store.sweep();
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
  const rateLimit = (req: IncomingMessage, scope: 'code' | 'restore') => {
    const address = `${scope}:${req.socket.remoteAddress ?? 'unknown'}`;
    const rate = attempts.get(address);
    const maximum = scope === 'code' ? 10 : 20;
    if (rate && rate.until > now() && rate.count >= maximum) throw new HttpError(429, 'ログイン試行の上限です。1分後に再試行してください。');
    attempts.set(address, { count: rate && rate.until > now() ? rate.count + 1 : 1, until: rate && rate.until > now() ? rate.until : now() + 60_000 });
  };
  const beginSession = (req: IncomingMessage) => {
    const previousId = sessionCookie(req);
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
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id, X-Subject-Revision' }); res.end(); return true;
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
      if (req.method === 'POST' && path === '/api/session/forget') {
        sameOrigin(req);
        z.object({}).strict().parse(await jsonBody(req));
        deviceLogins.revoke(deviceCookie(req));
        const authorization = req.headers.authorization;
        const authenticated = authorization?.startsWith('Bearer ') ? store.authenticate(authorization.slice(7)) : null;
        for (const id of new Set([sessionCookie(req), authenticated?.id])) if (id) { store.end(id); active.delete(id); }
        res.setHeader('Set-Cookie', [cookie(''), rememberedCookie('')]);
        sendJson(res, 200, { ended: true }); return true;
      }
      const authorization = req.headers.authorization;
      const session = authorization?.startsWith('Bearer ') ? store.authenticate(authorization.slice(7)) : null;
      if (!session) throw new HttpError(401, '再ログインしてください。');
      if (req.method === 'POST' && path === '/api/session/resume') {
        const previous = validResult(session.result, session.revision);
        sendJson(res, 200, { result: previous, input: previous ? session.lastInput : null, interrupted: session.interrupted }); return true;
      }
      if (req.method === 'DELETE' && path === '/api/session') {
        deviceLogins.revoke(deviceCookie(req));
        store.end(session.id); active.delete(session.id);
        res.setHeader('Set-Cookie', [cookie(''), rememberedCookie('')]); sendJson(res, 200, { ended: true }); return true;
      }
      if (req.method === 'POST' && path === '/api/cancel') {
        const body = CancelSchema.parse(await jsonBody(req));
        const current = active.get(session.id);
        if (!current || current.requestId !== body.requestId || current.revision !== body.subjectRevision) throw new HttpError(409, '現在の調査と一致しません。');
        store.cancel(session.id); active.delete(session.id); delete session.result; store.save(session);
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
        let confirmedTarget: Target | undefined;
        if (input.selectedCandidateId) {
          const prior = validResult(session.result, session.revision);
          const selected = prior?.status === 'awaiting_confirmation' ? prior.candidates.find(c => c.id === input.selectedCandidateId) : undefined;
          if (!selected || session.lastInput?.text !== input.text || session.lastInput.mode !== input.mode || session.lastInput.scenario !== input.scenario) throw new HttpError(409, '選択した候補が元の入力と一致しません。');
          confirmedTarget = { personName: selected.personName, companyName: selected.companyName };
        }
        session.revision = input.subjectRevision; session.lastInput = input; session.requestIds.push(input.requestId); delete session.result;
        const controller = store.start(session);
        active.set(session.id, { requestId: input.requestId, revision: input.subjectRevision, controller });
        const stillCurrent = () => active.get(session.id)?.controller === controller && !controller.signal.aborted && !!store.get(session.id);
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
            budgetRunId: uuidPattern.test(input.requestId) ? input.requestId : randomUUID(), confirmedTarget,
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
        const revision = req.headers['x-subject-revision'] === undefined ? session.revision + 1 : Number(req.headers['x-subject-revision']);
        if (!Number.isSafeInteger(revision) || revision <= session.revision) throw new HttpError(409, '音声の対象の版が古くなっています。');
        if (req.headers['content-type']?.split(';')[0]?.trim() !== 'audio/wav') throw new HttpError(415, 'WAV形式で送信してください。');
        const bytes = await readBody(req, 1_000_000);
        prepareAudio(bytes, 'audio/wav');
        // Recheck after reading: another request may have acquired the session in the meantime.
        if (session.running || !store.get(session.id)) throw new HttpError(409, 'この処理を開始できません。');
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
          const operation = (async () => {
            const reservation = await budget.reserve(requestId, config.sttMax);
            if (controller.signal.aborted) { await budget.settle(reservation, 0); throw new HttpError(408, '音声認識を停止しました。'); }
            const response = await liveProvider.transcribe!(bytes, 'audio/wav', controller.signal);
            await budget.settle(reservation, response.actualUsd ?? null);
            return z.string().trim().min(1).max(2000).parse(response.value);
          })();
          const text = await Promise.race([operation, interrupted]);
          if (!store.finish(session.id, controller)) throw new HttpError(409, '失効した音声認識の結果は破棄しました。');
          session.running = false; store.save(session); active.delete(session.id);
          sendJson(res, 200, { text });
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
  return { handle, close() { clearInterval(sweep); for (const id of active.keys()) { const session = store.get(id); if (session) { session.interrupted = true; store.save(session); } } store.close(); active.clear(); } };
}
