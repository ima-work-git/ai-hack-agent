import type { ProviderConfig } from './provider-contract.ts';
import type { RuntimeStatus } from '../src/shared/contracts.ts';
import { z } from 'zod';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024–65535');
  const accessCode = env.APP_ACCESS_CODE || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && accessCode.length < 16) throw new Error('Remote hosting requires APP_ACCESS_CODE of at least 16 characters');
  const origin = env.APP_ORIGIN || `http://localhost:${port}`;
  const originUrl = new URL(origin);
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.username || originUrl.password || originUrl.origin !== origin) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path');
  const providers: ProviderConfig = {
    orcaApiKey: env.ORCAROUTER_API_KEY || env.ORCA_API_KEY || '',
    orcaModel: env.ORCAROUTER_MODEL || env.ORCA_MODEL || '',
    orcaSttModel: env.ORCAROUTER_STT_MODEL || '',
    tavilyApiKey: env.TAVILY_API_KEY || '',
    xBalancedTopics: env.X_BALANCED_TOPICS !== 'false',
    xEnabled: env.X_API_ENABLED === 'true', xBearerToken: env.X_API_BEARER_TOKEN || env.X_BEARER_TOKEN || '',
    sttApiKey: env.STT_API_KEY || '', sttBaseUrl: env.STT_API_BASE_URL || '', sttModel: env.STT_MODEL || '',
  };
  const missing: string[] = [];
  const amount = (name: string, label: string, zeroAllowed = false) => {
    const value = env[name] === undefined || env[name] === '' ? NaN : Number(env[name]);
    if (!Number.isFinite(value) || (zeroAllowed ? value < 0 : value <= 0)) { missing.push(label); return 0; }
    return value;
  };
  const suspensionFrom = env.BUDGET_LIMITS_SUSPEND_FROM || '';
  const suspensionUntil = env.BUDGET_LIMITS_SUSPEND_UNTIL || '';
  let limitSuspension: { startsAt: number; endsAt: number } | undefined;
  if (suspensionFrom || suspensionUntil) {
    const timestamp = z.iso.datetime({ offset: true });
    const startsAt = Date.parse(suspensionFrom); const endsAt = Date.parse(suspensionUntil);
    if (!timestamp.safeParse(suspensionFrom).success || !timestamp.safeParse(suspensionUntil).success ||
        !Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || endsAt <= startsAt || endsAt - startsAt > 48 * 60 * 60_000) {
      throw new Error('Budget suspension requires explicit ISO timestamps with timezone and a positive window of at most 48 hours');
    }
    limitSuspension = { startsAt, endsAt };
  }
  const budget = {
    directory: env.PRIVATE_DIR || '.private', currency: 'USD' as const,
    runLimitUsd: amount('RUN_BUDGET_USD', '1回の調査の費用上限'),
    dayLimitUsd: amount('DAY_BUDGET_USD', '1日の費用上限'),
    eventLimitUsd: amount('EVENT_BUDGET_USD', 'イベント全体の費用上限'),
    limitSuspension,
  };
  const maximumCosts = {
    llm: amount('MAX_LLM_CALL_USD', 'LLMの1呼出あたり最大見積額'),
    search: amount('MAX_SEARCH_CALL_USD', '検索の1呼出あたり最大見積額'),
    page: amount('MAX_PAGE_CALL_USD', 'ページ取得の最大見積額（無料なら0を明示）', true),
  };
  if (!providers.orcaApiKey) missing.push('OrcaRouterのAPIキー');
  if (!providers.orcaModel) missing.push('OrcaRouterのモデル');
  if (!providers.tavilyApiKey) missing.push('Web検索のAPIキー');
  if (accessCode.length < 16) missing.push('16文字以上の利用コード');
  if (providers.xEnabled) {
    if (!providers.xBearerToken) missing.push('Xの読取トークン');
    maximumCosts.search = Math.max(maximumCosts.search, amount('X_MAX_SEARCH_COST_USD', 'X検索全体の最大見積額（ユーザー1件＋直近5件＋過去20件＋空時補完10件）'));
  }
  const explicitStt = Boolean(providers.sttApiKey || providers.sttBaseUrl || providers.sttModel);
  const sttComplete = explicitStt ? Boolean(providers.sttApiKey && providers.sttBaseUrl && providers.sttModel) : Boolean(providers.orcaApiKey && providers.orcaSttModel);
  const sttMax = Number(env.MAX_STT_CALL_USD || NaN);
  const liveEnabled = env.AGENT_LIVE_ENABLED === 'true' && missing.length === 0;
  const streamingApiKey = env.OPENAI_API_KEY || '';
  const personCorrection = { apiKey: env.PERSON_CORRECTION_ENABLED === 'false' ? '' : streamingApiKey, model: env.PERSON_CORRECTION_MODEL || 'gpt-5.6-luna' };
  const streamingModel = env.OPENAI_STREAMING_ASR_MODEL || 'gpt-live-transcribe';
  const streamingAudioMaxPerMinute = Number(env.STREAMING_ASR_MAX_USD_PER_MINUTE || NaN);
  const status: RuntimeStatus = {
    streamingEnabled: liveEnabled && !!streamingApiKey && streamingModel === 'gpt-live-transcribe' && Number.isFinite(streamingAudioMaxPerMinute) && streamingAudioMaxPerMinute > 0,
    liveEnabled, missing: env.AGENT_LIVE_ENABLED === 'true' ? missing : ['実APIモードの有効化', ...missing],
    sttEnabled: liveEnabled && sttComplete && Number.isFinite(sttMax) && sttMax > 0,
    xEnabled: liveEnabled && !!providers.xEnabled,
    accessCodeRequired: accessCode.length > 0, version: '0.1.0',
  };
  return { host, port, origin, accessCode, providers, budget, maximumCosts, sttMax, status, streamingApiKey, streamingModel, streamingAudioMaxPerMinute, personCorrection };
}
export type AppConfig = ReturnType<typeof readConfig>;
