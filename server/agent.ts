import { randomUUID } from 'node:crypto';
import {
  AssessmentSchema, EvidenceSourceSchema, PlanDecisionSchema, ResearchInputSchema, ResearchResultSchema, SearchHitSchema, validatedCardDisplay,
} from '../src/shared/contracts.ts';
import type { Assessment, Candidate, Card, EvidenceSource, ResearchInput, ResearchResult, Target, TraceEvent } from '../src/shared/contracts.ts';
import { extractExplicitXHandles } from '../src/shared/x-account.ts';
import { evidenceMatchesCard, selectBalancedCards } from '../src/shared/card-balance.ts';
import { isAllowedConversationTopic } from '../src/shared/topic-policy.ts';
import { evidenceMatchesTarget, normalizeIdentity, verifiedAliasForInputTarget, verifiedAliasForTarget } from '../src/shared/identity-aliases.ts';
import type { ProviderResult, ResearchProvider } from './provider-contract.ts';
import { ProviderError } from './provider-contract.ts';
import { BudgetError, BudgetLedger } from './budget.ts';
import type { BudgetReservation } from './budget.ts';

export interface AgentOptions {
  signal?: AbortSignal;
  onEvent?: (event: TraceEvent) => void;
  budget?: BudgetLedger;
  maximumCosts?: { llm: number; search: number; page: number };
  now?: () => number;
  budgetRunId?: string;
  confirmedTarget?: Target;
}
class StopError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja');
const contains = (text: string, part: string) => !!normalize(part) && normalize(text).includes(normalize(part));
const matches = evidenceMatchesTarget;
const sourceUrlIsPublicShape = (url: string) => {
  try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
};

export async function runAgent(rawInput: ResearchInput, provider: ResearchProvider, options: AgentOptions = {}): Promise<ResearchResult> {
  const input = ResearchInputSchema.parse(rawInput);
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + 20_000;
  const budgetRunId = options.budgetRunId ?? randomUUID();
  const handles = extractExplicitXHandles(input.text);
  const trace: TraceEvent[] = [];
  const sources: EvidenceSource[] = [];
  const attemptedSourceUrls = new Set<string>();
  let cards: Card[] = [];
  let target: Target | null = null;
  let candidates: Candidate[] = [];
  let hadFailure = false;
  let publicIdentityVerified = false;
  let balancedTopics = false;
  let counts = { llm: 0, search: 0, page: 0 };
  let observedCost = 0;
  let reservedCost = 0;
  let reportedCost = 0;
  let reportedCostCalls = 0;
  let knownCost = true;
  const limits = { llm: 3, search: 2, page: 4 };
  const emit = (step: string, message: string) => {
    if (trace.length >= 60) return;
    const event = { eventId: trace.length + 1, step, message: `${input.mode === 'demo' ? '模擬：' : ''}${message}`, at: new Date(now()).toISOString() };
    trace.push(event);
    try { options.onEvent?.(event); } catch { /* An observer must not alter the research outcome. */ }
  };
  const check = () => {
    if (options.signal?.aborted) throw new StopError('CANCELLED');
    if (now() >= deadline) throw new StopError('DEADLINE_EXCEEDED');
  };
  const call = async <T>(kind: keyof typeof counts, operation: (signal: AbortSignal) => Promise<ProviderResult<T>>, operationTimeoutMs = 8_000): Promise<T> => {
    check();
    if (counts[kind] >= limits[kind]) throw new StopError('CALL_LIMIT');
    let reservation: BudgetReservation | undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop: (error: unknown) => void = () => {};
    const abort = () => { controller.abort(); rejectStop(new StopError('CANCELLED')); };
    const timeoutMs = Math.max(0, Math.min(operationTimeoutMs, deadline - now()));
    const stop = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
      timer = setTimeout(() => { controller.abort(); reject(new StopError(now() >= deadline ? 'DEADLINE_EXCEEDED' : 'OPERATION_TIMEOUT')); }, timeoutMs);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const pending = Promise.resolve().then(async () => {
      if (input.mode === 'live') {
        reservation = await options.budget!.reserve(budgetRunId, options.maximumCosts![kind]);
        reservedCost += options.maximumCosts![kind];
      }
      try {
        check();
        if (controller.signal.aborted) throw new StopError('OPERATION_TIMEOUT');
      } catch (error) {
        // Nothing has been sent: this reservation can be released without guessing a charge.
        if (reservation) { await options.budget!.settle(reservation, 0); reservedCost -= options.maximumCosts![kind]; }
        throw error;
      }
      counts[kind] += 1;
      return operation(controller.signal);
    }).then(async result => {
      // Response-time reports are display metadata, never settlement authority.
      if (result.reportedUsd !== undefined && Number.isFinite(result.reportedUsd) && result.reportedUsd >= 0) {
        reportedCost += result.reportedUsd;
        reportedCostCalls += 1;
      }
      const actual = result.actualUsd;
      if (actual !== undefined && (!Number.isFinite(actual) || actual < 0)) throw new ProviderError('INVALID_COST', '費用応答が不正です。');
      if (reservation) {
        await options.budget!.settle(reservation, actual ?? null);
        if (actual !== undefined) reservedCost -= options.maximumCosts![kind];
      }
      if (actual === undefined) knownCost = false; else observedCost += actual;
      return result.value;
    }).catch(error => { knownCost = false; throw error; });
    try {
      const result = await Promise.race([pending, stop]);
      check();
      return result;
    } catch (error) {
      knownCost = false;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  };
  const finish = async (status: ResearchResult['status'], reasonCode: string, message: string): Promise<ResearchResult> => {
    if (status === 'cancelled') { cards = []; sources.length = 0; candidates = []; }
    emit(status, message);
    // Accounting is already durably recorded by each operation. No extra lock wait after deadline.
    const reservedUsd = Math.max(0, reservedCost);
    const actualUsd: number | null = knownCost ? observedCost : null;
    return ResearchResultSchema.parse({
      requestId: input.requestId, subjectRevision: input.subjectRevision, mode: input.mode, status, target, candidates, cards, sources, trace,
      reasonCode, message: `${input.mode === 'demo' ? '模擬データ（架空の人物・会社）。' : ''}${message}`,
      usage: { llm: counts.llm, searches: counts.search, pages: counts.page, elapsedMs: Math.max(0, now() - started), reservedUsd, actualUsd, costKnown: knownCost,
        ...(reportedCostCalls ? { reportedUsd: reportedCost, reportedCostCalls } : {}) },
    });
  };
  const fatal = (error: unknown) => error instanceof StopError && error.code !== 'OPERATION_TIMEOUT' || error instanceof BudgetError;
  const queryForTarget = (query: string, preferExplicitAccount: boolean) => {
    if (!target) throw new StopError('TARGET_UNRESOLVED');
    // Model-selected topics stay inside the research purpose; source text cannot become an exfiltration query.
    const allowedTopics = ['公式', 'プロフィール', '事業', '登壇', '公開活動', 'インタビュー', '趣味', '経歴', 'official', 'profile', 'business', 'conference'];
    const topics = allowedTopics.filter(topic => query.toLowerCase().includes(topic)).slice(0, 3);
    const subject = `${target.personName} ${target.companyName}`.replaceAll('@', '').trim();
    // Only the first search carries the user-specified account. Follow-up terms
    // cannot force another timeline call instead of the requested web research.
    return `${subject} ${topics.length ? topics.join(' ') : '公式 プロフィール'}${preferExplicitAccount && handles.length === 1 ? ` @${handles[0]}` : ''}`;
  };
  const gather = async (query: string, initialSearch: boolean) => {
    // Keep at least two of the four total attempts available for follow-up web
    // evidence, even when the initial timeline/search returns many candidates.
    let pageCeiling = initialSearch ? Math.min(limits.page, counts.page + 2) : limits.page;
    emit('search', target?.companyName ? '対象の氏名と会社名に絞って公開情報を検索します。' : '氏名から公式プロフィールと公開活動の根拠を検索します。');
    let hits;
    try { hits = SearchHitSchema.array().max(10).parse(await call('search', signal => provider.search(queryForTarget(query, initialSearch), signal))); }
    catch (error) { if (fatal(error)) throw error; hadFailure = true; emit('recovery', '検索を取得できませんでした。別の検索か検証済みの情報へ縮退します。'); return; }
    if (initialSearch && hits.some(hit => hit.topic)) {
      balancedTopics = true; limits.page = 6; pageCeiling = 4;
      emit('balance', '最近のX投稿2件・過去の反響1件・人物や会社1件の配分で根拠を集めます。');
    }
    const knownPublicPerson = !initialSearch && target ? verifiedAliasForTarget(target) : undefined;
    if (knownPublicPerson && (knownPublicPerson.scope === 'public-person' || balancedTopics)) {
      // These are known public identity locations, not cached factual evidence.
      // Fetch their real text within the same page allowance, then apply all
      // normal identity, attribution and exact-quotation guards.
      const primary = knownPublicPerson.sourceUrls.slice(0, 2).map(url => ({ url, title: '公開プロフィールの取得候補' }));
      hits = [...primary, ...hits.filter(hit => !primary.some(candidate => candidate.url === hit.url))].slice(0, 10);
    }
    for (const hit of hits) {
      if (counts.page >= pageCeiling) break;
      if (!sourceUrlIsPublicShape(hit.url) || attemptedSourceUrls.has(hit.url) || sources.some(s => s.url === hit.url)) continue;
      attemptedSourceUrls.add(hit.url);
      try {
        const source = EvidenceSourceSchema.parse(await call('page', signal => provider.fetchPage(hit, signal)));
        if (!sourceUrlIsPublicShape(source.url) || input.mode === 'live' && source.kind === 'fixture' || sources.some(s => s.sourceId === source.sourceId)) {
          hadFailure = true; emit('discard', '取得元の識別子または形式が不正なため資料を除外しました。'); continue;
        }
        sources.push(source);
        emit('fetch', '本文を取得しました。検索抜粋だけでは根拠に採用しません。');
      } catch (error) {
        if (fatal(error)) throw error;
        hadFailure = true;
        emit('recovery', 'ページを取得できませんでした。残る公開資料を調べます。');
      }
    }
  };
  const assess = async (): Promise<Assessment> => {
    check();
    emit('assess', '対象の一致と本文の根拠を評価します。');
    return AssessmentSchema.parse(await call('llm', signal => provider.assess(target!, sources, signal), balancedTopics ? 12_000 : 8_000));
  };
  const applyAssessment = (assessment: Assessment): boolean => {
    if (assessment.needsConfirmation) {
      candidates = assessment.candidates.filter(candidate => candidate.sourceIds.length > 0 && candidate.sourceIds.every(id => {
        const source = sources.find(s => s.sourceId === id);
        return source && matches(source.text, candidate, source.url);
      }));
      cards = []; // No personal facts are shown while identity remains ambiguous.
      return false;
    }
    publicIdentityVerified = Boolean(target && !target.companyName && assessment.identityVerified && assessment.publicPersonVerified &&
      assessment.publicIdentitySourceIds?.length && assessment.publicIdentitySourceIds.every(id => {
        const source = sources.find(item => item.sourceId === id);
        return source && sourceUrlIsPublicShape(source.url) && matches(source.text, target!, source.url);
      }));
    if (!assessment.identityVerified || !target || !target.companyName && !publicIdentityVerified) {
      cards = []; emit('discard', '本人性と公開活動を確認できる根拠が足りないため、人物の事実を採用しません。'); return true;
    }
    for (const proposal of assessment.cards) {
      if (!isAllowedConversationTopic(proposal.fact, proposal.suggestedQuestion, proposal.displayQuestion)) {
        emit('discard', '健康や私生活に関わる話題を含むため、カード全体を除外しました。'); continue;
      }
      const source = sources.find(s => s.sourceId === proposal.sourceId);
      if (!source || !contains(source.text, proposal.excerpt) || !evidenceMatchesCard(proposal.excerpt, target, source, sources) || !contains(proposal.excerpt, proposal.fact) || source.xPost && !contains(source.xPost.text, proposal.fact)) {
        emit('discard', '出典、対象名・所属、本文引用の検査に通らないカードを棄却しました。'); continue;
      }
      if (cards.some(c => normalize(c.fact) === normalize(proposal.fact)) || cards.length >= 8) continue;
      const { displayFact, displayQuestion, ...verifiedProposal } = proposal;
      cards.push({ ...verifiedProposal, ...validatedCardDisplay(proposal.fact, proposal.excerpt, displayFact, displayQuestion), cardId: randomUUID(), expiresAt: new Date(now() + 300_000).toISOString(), requestId: input.requestId, subjectRevision: input.subjectRevision });
    }
    if (balancedTopics) cards = selectBalancedCards(cards, sources);
    else cards = cards.slice(0, 4);
    emit('verify', `${cards.length}件のカードが本文引用と対象照合の検査を通りました。`);
    return true;
  };

  try {
    if (provider.mode !== input.mode) throw new StopError('PROVIDER_MODE_MISMATCH');
    if (input.mode === 'live' && (!options.budget || !options.maximumCosts ||
        ![options.maximumCosts.llm, options.maximumCosts.search, options.maximumCosts.page].every(v => Number.isFinite(v) && v >= 0))) throw new StopError('BUDGET_NOT_CONFIGURED');
    if (input.mode === 'live' && options.budgetRunId) {
      const prior = await options.budget!.snapshot(budgetRunId);
      observedCost = prior.actualUsd; reservedCost = prior.reservedUsd; knownCost = prior.costKnown;
    }
    if (handles.length > 1) return finish('awaiting_confirmation', 'MULTIPLE_HANDLES', '複数のXアカウントがあります。調べたいアカウントを1件に絞ってください。');
    emit('plan', '入力から調査対象を抽出し、調査先を計画します。');
    const plan = PlanDecisionSchema.parse(await call('llm', signal => provider.plan(input, signal)));
    target = plan.target;
    candidates = plan.candidates;
    if (options.confirmedTarget && (!target || normalizeIdentity(target.personName) !== normalizeIdentity(options.confirmedTarget.personName) || normalizeIdentity(target.companyName) !== normalizeIdentity(options.confirmedTarget.companyName))) {
      target = options.confirmedTarget;
      return finish('awaiting_confirmation', 'SELECTED_TARGET_MISMATCH', '選択した対象と抽出結果が一致しませんでした。名前と会社を確認してください。');
    }
    if (plan.needsConfirmation || !target) return finish('awaiting_confirmation', 'IDENTITY_CONFIRMATION_REQUIRED', '対象を絞るため、氏名・会社名または候補を確認してください。');
    const verifiedAlias = verifiedAliasForInputTarget(input.text, target);
    if (verifiedAlias?.xHandle) {
      if (handles.length && handles[0] !== verifiedAlias.xHandle) return finish('awaiting_confirmation', 'ACCOUNT_IDENTITY_CONFLICT', '入力されたアカウントと確認済みの人物情報が一致しません。対象を確認してください。');
      if (!handles.length) handles.push(verifiedAlias.xHandle);
    }
    if (input.selectedCandidateId) emit('human_confirmation', '利用者が選んだ候補で調査を再開します。');
    await gather(plan.query, true);
    if (!sources.length && counts.search < limits.search) {
      // An empty timeline/search is missing evidence, not evidence of an
      // ambiguous identity. Use the remaining web search before asking a model.
      emit('recovery', '初回の調査で本文を取得できなかったため、別の公開情報を探します。');
      emit('replan', '氏名と会社名によるWeb検索へ切り替え、残りの取得枠で根拠を確認します。');
      await gather(plan.query, false);
    }
    if (!sources.length) {
      return finish(hadFailure ? 'failed' : 'no_evidence', hadFailure ? 'SOURCES_UNAVAILABLE' : 'NO_VERIFIABLE_EVIDENCE',
        hadFailure ? '情報源を取得できず、根拠を確認できませんでした。入力または接続を確認してください。' : '対象に結び付く本文の根拠が見つかりませんでした。');
    }
    if (balancedTopics && counts.search < limits.search && counts.page < limits.page) {
      emit('replan', '人物・会社の公式情報を追加し、投稿者と所属の根拠を照合します。');
      await gather('公式 プロフィール 事業', false);
    }
    let assessment = await assess();
    const accepted = applyAssessment(assessment);
    // X may lack primary identity evidence or useful facts. A candidate
    // ambiguity still stops immediately; use only the existing Web allowance.
    const needsPublicWeb = (!target.companyName || !!verifiedAliasForTarget(target)) && assessment.candidates.length === 0 &&
      ((!accepted && (!assessment.identityVerified || !target.companyName && (!assessment.publicPersonVerified || !assessment.publicIdentitySourceIds?.length))) ||
        (accepted && (assessment.identityVerified || publicIdentityVerified) && cards.length < 4)) &&
      sources.every(source => source.kind === 'x') && counts.search < limits.search && counts.llm < limits.llm && counts.page < limits.page;
    if (!accepted && !needsPublicWeb) return finish('awaiting_confirmation', 'IDENTITY_CONFIRMATION_REQUIRED', '所属や候補に曖昧さがあります。確認後に調査を再開してください。');
    if ((needsPublicWeb || assessment.followUpQuery) && counts.search < limits.search && counts.llm < limits.llm && cards.length < 4) {
      emit('replan', needsPublicWeb ? 'Xの資料を補うため、公式Webプロフィールで本人性と話題の根拠を追加で確認します。' : '根拠を補うため、追加の公開活動を自律的に調べます。');
      const priorSources = sources.length;
      await gather(assessment.followUpQuery || '公式 プロフィール', false);
      if (needsPublicWeb && sources.length === priorSources) {
        if (!accepted) return finish('awaiting_confirmation', 'PUBLIC_IDENTITY_CONFIRMATION_REQUIRED', '公式プロフィールの根拠を追加取得できませんでした。活動名や公式URLなどの手掛かりを確認してください。');
      } else {
        assessment = await assess();
        if (!applyAssessment(assessment)) return finish('awaiting_confirmation', 'IDENTITY_CONFIRMATION_REQUIRED', '追加資料で対象に曖昧さが見つかりました。候補を確認してください。');
      }
    }
    if (!target.companyName && !publicIdentityVerified) return finish('awaiting_confirmation', 'PUBLIC_IDENTITY_CONFIRMATION_REQUIRED', '公開プロフィールだけでは対象を一人に絞れませんでした。活動名、所属や公式URLなどの手掛かりを確認してください。');
    if (balancedTopics && cards.length) {
      const recent = cards.filter(card => card.topic === 'recent_x').length;
      const popular = cards.filter(card => card.topic === 'popular_x').length;
      const profile = cards.filter(card => card.topic === 'profile').length;
      if (recent !== 2 || popular !== 1 || profile !== 1) {
        emit('balance', `最近X${recent}件・過去の反響${popular}件・人物や会社${profile}件。取得・検証できない枠は別の確認済み話題で補います。`);
        return finish('partial', 'TOPIC_BALANCE_PARTIAL', '希望の配分に必要な投稿を確認できなかったため、取得した根拠のある話題を表示します。');
      }
    }
    if (cards.length) return finish(hadFailure ? 'partial' : 'ready', hadFailure ? 'PARTIAL_SOURCES_UNAVAILABLE' : 'EVIDENCE_VERIFIED', hadFailure ? '取得できなかった資料があります。確認できた根拠だけを表示します。' : '本文と対象を照合した話題カードを表示します。');
    return finish(hadFailure ? 'failed' : 'no_evidence', hadFailure ? 'SOURCES_UNAVAILABLE' : 'NO_VERIFIABLE_EVIDENCE', hadFailure ? '一部の資料を取得できず、取得済みの資料からも対象と事実を照合できませんでした。入力や接続を確認してください。' : '対象に結び付く本文の根拠が見つかりませんでした。');
  } catch (error) {
    const reason = error instanceof StopError || error instanceof BudgetError || error instanceof ProviderError ? error.code : 'INVALID_OR_UNAVAILABLE_RESPONSE';
    if (reason === 'CANCELLED') return finish('cancelled', reason, '調査を停止しました。遅れて届いた結果は表示しません。');
    return finish(cards.length ? 'partial' : 'failed', reason, cards.length ? '上限または障害で終了しました。検証済みのカードだけを表示します。' : '調査を完了できませんでした。入力・設定・接続を確認して再開してください。');
  }
}
