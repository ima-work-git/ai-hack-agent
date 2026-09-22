import './style.css';
import { ResearchInputSchema, ResearchResultSchema, type Card, type EvidenceSource, type ResearchInput, type ResearchResult, type RuntimeStatus, type TraceEvent, type Scenario } from './shared/contracts.ts';
import { G2Runtime, type G2Status, type GlassesView } from './integrations/g2-runtime.ts';
import { PhoneAudio } from './phone-audio.ts';
import { StreamingAudio } from './streaming-audio.ts';
import { verifiedAliasForTarget } from './shared/identity-aliases.ts';
import { TargetSchema } from './shared/contracts.ts';
import { SearchCandidateSchema, type SearchCandidate } from './shared/search-candidates.ts';
import { pcmToWav } from './audio.ts';

// A short-lived QR grant is read once, then removed before any API request.
let qrLoginTicket = new URLSearchParams(window.location.hash.slice(1)).get('login') || '';
const conversationLaunch = new URLSearchParams(window.location.search).get('conversation') === '1';
const qrConversationEntry = conversationLaunch && /^[a-f0-9]{64}$/.test(qrLoginTicket);
let qrAutoStartPending = qrConversationEntry;
if (new URLSearchParams(window.location.hash.slice(1)).has('login')) {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
let pageLeaving = false;

const DEMO_TEXT = '架空・みなもデザイン株式会社の星野あおいさんについて調べたい。';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BOARD_MARKUP = Array.from({ length: 4 }, (_, index) => `<button type="button" class="topic-card empty" id="topic-${index}" disabled aria-label="${index + 1}件目は未確認"><span class="topic-number">${index + 1} / 未確認</span><span class="topic-row"><span class="topic-caption">事実</span><span class="topic-fact"${index === 0 ? ' id="fact"' : ''}>未確認</span></span><span class="topic-row"><span class="topic-caption">推奨質問</span><span class="topic-question"${index === 0 ? ' id="question"' : ''}>確認後に表示</span></span></button>`).join('');
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="masthead"><div class="wordmark"><span class="mark" aria-hidden="true">◌</span><div><div class="eyebrow">AI HACK · EVEN G2</div><h1>これで誰でも雑談マスター</h1></div></div><span class="pill" id="connection">スマートフォン表示</span></header>
<section class="panel login hidden" id="login"><div class="eyebrow">WELCOME BACK</div><h2>セッションを始める</h2><p class="muted">会話データは15分保持し、その後削除します。終了・バックグラウンドでは録音を停止します。再開時もマイクは自動で起動しません。</p><form id="login-form"><label for="access-code">利用コード</label><input type="password" id="access-code" autocomplete="current-password" minlength="16"><label class="check"><input id="remember-device" type="checkbox" checked><span>この端末では12時間、利用コードの入力を省略する</span></label><div class="controls"><button class="primary" type="submit">開始する</button></div><p class="status" id="login-status" role="status"></p></form></section>
<main class="workspace hidden" id="workspace"><div class="intro"><div><div class="eyebrow">LESS SEARCHING, MORE CONVERSATION</div><h1>目の前の会話に、次のきっかけを。</h1><p>公開情報の調査と根拠の確認を、エージェントに任せる。</p></div><span class="mode-badge" id="mode-badge">体験デモ · 架空の人物・固定データ</span></div>
<div class="notice hidden" id="resume-notice">前のセッションがあります。内容を表示するには、再開してください。<div class="controls"><button id="resume">前の内容を再開</button></div></div>
<div class="grid"><div><section class="panel"><div class="section-head"><h2>会話から調べる</h2><span class="section-number">01 / INPUT</span></div><p class="muted">氏名と会社名を手がかりに、公開情報を確認します。</p>
<div class="field-row"><div><label for="mode">利用モード</label><select id="mode"><option value="demo">体験デモ</option><option value="live" id="live-option" disabled>実APIで調査</option></select></div><div id="scenario-field"><label for="scenario">確認する場面</label><select id="scenario"><option value="normal">通常・自律的な追加調査</option><option value="ambiguous">同姓同名・候補を確認</option><option value="failure">検索障害・一部の根拠を表示</option><option value="no_evidence">根拠なし・推測せず終了</option></select></div></div>
<label for="text">人物名（会社名は任意）、または会話の文字起こし</label><p class="muted">事前登録・入力は不要です。会話モードを開始すると、会話から人物を見つけ、会社名などの手がかりも使って調べます。</p><textarea id="text" maxlength="2000" placeholder="会話モードでは自動で文字が入ります。手入力もできます。" spellcheck="false"></textarea>
<div class="controls"><button id="sample">架空の会話を入力</button><button id="connect">G2を接続</button></div>
<p class="muted" id="audio-notice">会話相手への説明・同意は事前に済んでいる運用です。会話用QRから開くと、G2接続後に音声認識を自動開始します。音声をOpenAIへ送信し、OrcaRouterで調査します。音声は保存しません。「中止」でいつでも停止できます。</p>
<label for="microphone">使うマイク</label><select id="microphone"><option value="g2" ${conversationLaunch ? 'selected' : ''}>Even G2のマイク</option><option value="phone" ${conversationLaunch ? '' : 'selected'}>スマートフォンのマイク</option></select>
<div class="controls"><button id="conversation" disabled>会話モードを開始</button><button id="retry-listening" disabled>聞き直す</button><button id="lock-person" disabled>この人物で固定</button><button id="record" disabled>短く録音して調べる</button><span class="muted" id="audio-hint">音声入力は実APIの設定後に使えます</span></div>
<p class="muted" id="person-state" role="status">G2：下スクロールで出典、一覧の上スクロールで聞き直しを確認。1回で実行・2回で取消。通常の2回は人物固定。</p><div class="controls"><button id="research" class="primary">調査を始める →</button><button id="cancel" disabled>中止</button><button id="end" class="danger">終了して削除</button></div><p class="muted">「終了して削除」で、この端末のログインの記憶も解除します。</p><p class="status" id="status" role="status" aria-live="polite">架空の会話を入力すると、調査の流れを体験できます。</p><section id="search-panel" class="search-panel hidden" aria-label="検索キーワード"><h3>検索キーワード</h3><p id="current-search" role="status"></p><p class="muted">別候補を選ぶと、今の調査を止めてその語で調べ直します。候補は本人確認済みという意味ではありません。</p><div id="search-choices" class="candidates"></div></section><p class="status hidden" id="correction-hint" role="status"></p><div id="candidates" class="candidates"></div>
</section><section class="panel"><div class="section-head"><h2>エージェントの判断</h2><span class="section-number">02 / PROCESS</span></div><p id="trace-empty" class="empty-trace">調査中の判断と復旧の記録がここに表示されます。</p><ol id="trace" class="trace" aria-label="調査の処理履歴"></ol><details><summary>実APIの設定状況</summary><p class="muted" id="configuration"></p><p class="muted">APIキーと費用上限はサーバー側で設定します。</p></details></section></div>
<div><div class="section-head"><h2>調査結果と質問 · 4件一覧</h2><span class="section-number">03 / INSIGHT</span></div><div class="device"><span class="dot" id="device-dot"></span><span id="device-status">Even G2 · 画面プレビュー</span></div><section class="hud" aria-label="4件の調査結果と質問"><div class="hud-top"><span id="hud-mode">DEMO / FICTIONAL DATA</span><span id="hud-target">WAITING</span></div><div class="topic-board" id="card-board">${BOARD_MARKUP}</div><div class="hud-foot"><span id="hud-source">各カードを押すと原文・出典を表示</span><span id="hud-expiry">0 / 4件確認</span></div></section><nav class="card-nav" aria-label="出典詳細の選択"><button id="previous" aria-label="前の出典" disabled>← 前の出典</button><span id="card-count">0 / 0</span><button id="next" aria-label="次の出典" disabled>次の出典 →</button></nav>
<div class="notice" id="result-note">体験デモでは外部APIに通信せず、架空の人物・会社の固定資料を使います。</div><div class="metrics"><div class="metric"><strong id="metric-time">—</strong><span>調査にかかった時間</span></div><div class="metric"><strong id="metric-calls">—</strong><span>AI / 検索 / 本文</span></div><div class="metric"><strong id="metric-cost">—</strong><span id="cost-label">実費は未計測</span></div></div><section class="panel evidence-panel" id="evidence-panel" tabindex="-1"><div class="section-head"><h2>情報の根拠</h2><span class="section-number">04 / EVIDENCE</span></div><p class="muted" id="source-empty">本文の引用・出典・取得時刻を、カードごとに確認できます。</p><div id="sources"></div></section></div></div></main>
<footer class="footer"><span>AI HACK 2026 · 業務を自律化するAIエージェント</span><span>人の確認が必要なときは、立ち止まる。</span></footer>`;

let runtimeStatus: RuntimeStatus;
let token = '';
let authGeneration = 0;
let authBusy = false;
let revision = 0;
let currentId = '';
let viewToken = 'initial';
let result: ResearchResult | null = null;
let cardIndex = 0;
let sourcePage = -1;
type SourcePosition = { cardId: string; sourceId: string; excerpt: string; page: number };
let sourcePosition: SourcePosition | null = null;
let pendingNavigation: { page: number; position: SourcePosition | null; view: string } | null = null;
let pendingSearchChoice: string | null = null;
let pendingAudioAction: { action: 'retry' | 'restart'; view: string } | null = null;
let searchCandidateIndex = -1;
let searchCandidates: SearchCandidate[] = [];
let currentSearch = '';
let choosingSearch = false;

let lockedPerson: ResearchResult['target'] = null;
let lastInput: ResearchInput | null = null;
let running = false;
let controller: AbortController | null = null;
let identifyController: AbortController | null = null;
let identifyingRequest: { requestId: string; subjectRevision: number } | null = null;
let expiresAt = 0;
let connected = false;
let recording = false;
let audioBusy = false;
let audioGeneration = 0;
let audioChunks: Uint8Array[] = [];
let audioBytes = 0;
let audioTimer: ReturnType<typeof setTimeout> | undefined;
let audioSource: 'g2' | 'phone' = 'phone';
let microphoneConnecting = false;
let glassesConnecting: Promise<boolean> | null = null;
let stoppingAudio: Promise<unknown> | null = null;
let conversation: StreamingAudio | null = null;
let pendingTranscript: { itemId: string; text: string } | null = null;
let identifyingTranscript = false;
let transcriptDrainId = 0;
let conversationSubjectGeneration = 0;
let resettingConversation = false;
let keepaliveController: AbortController | null = null;
const ignoredTranscriptItems = new Set<string>();
let completedTranscript = '';
const partialTranscripts = new Map<string, string>();
let conversationRunning = false;
let conversationId = '';
let conversationRequestRevision = 0;
let conversationLastKey = '';
let conversationLastAt = 0;
let g2: G2Runtime;
type VoicePhase = 'off' | 'connecting' | 'listening' | 'paused' | 'stopped' | 'error';
let voicePhase: VoicePhase = 'off';
let voicePreview = '';
let voiceErrorLabel = '音声接続エラー・再開してください';
let voiceDisplayTimer: ReturnType<typeof setTimeout> | undefined;
const emptyGlassesView = (): GlassesView => ({ header: 'これで誰でも雑談マスター', content: '会話を待っています', footer: 'マイクは停止中' });
let glassesView = emptyGlassesView();

const status = (text: string, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
function refreshControls() {
  $('research').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning);
  $('cancel').toggleAttribute('disabled', !running && !recording && !audioBusy && !microphoneConnecting && !qrAutoStartPending);
  $('microphone').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning || microphoneConnecting);
  $('mode').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning);
  $('scenario').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning);
  $('record').toggleAttribute('disabled', !recording && (microphoneConnecting || audioBusy || running || !runtimeStatus?.sttEnabled || ($<HTMLSelectElement>('mode').value !== 'live')));
  $('conversation').toggleAttribute('disabled', microphoneConnecting || recording || audioBusy || running || conversationRunning || !runtimeStatus?.streamingEnabled || ($<HTMLSelectElement>('mode').value !== 'live'));
  $('retry-listening').toggleAttribute('disabled', !conversationRunning || !conversationId || resettingConversation);
  $('lock-person').toggleAttribute('disabled', !conversationRunning || resettingConversation || !hasCurrentCards() || !result?.target);
  $('lock-person').textContent = lockedPerson ? '固定を解除して聞き直す' : 'この人物で固定';
  $('person-state').textContent = lockedPerson ? `${lockedPerson.personName}さんを固定中。聞き取りは継続。一覧で上スクロール→1回で解除・聞き直し。` : 'G2：下スクロールで出典、一覧の上スクロールで聞き直しを確認。1回で実行・2回で取消。通常の2回は人物固定。';
  renderSearchCandidates();
  $('conversation').textContent = voicePhase === 'error' ? '会話モードを再開' : '会話モードを開始';
  $('record').textContent = recording ? conversationRunning ? '会話モードを終了' : '録音を止めて調べる' : '音声で入力';
  if (voicePhase !== 'off') queueVoiceDisplay();
}
function newViewToken() { lockedPerson = null; sourcePage = -1; sourcePosition = null; pendingNavigation = null; pendingSearchChoice = null; pendingAudioAction = null; viewToken = `${currentId}:${revision}`; glassesView = emptyGlassesView(); g2?.invalidateViews(viewToken); }
// Count wide characters conservatively and preserve complete Unicode characters.
function shortText(text: string, maximumWidth: number): string {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  const width = (character: string) => /^[\x20-\x7e]$/.test(character) ? 1 : 2;
  if (characters.reduce((total, character) => total + width(character), 0) <= maximumWidth) return characters.join('');
  let used = 0; let clipped = '';
  for (const character of characters) { if (used + width(character) > maximumWidth - 2) break; clipped += character; used += width(character); }
  return `${clipped}…`;
}
function topicLabel(card: Card): string {
  const source = result?.sources.find(source => source.sourceId === card.sourceId);
  const topic: string | undefined = card.topic ?? source?.topic;
  const kind: string | undefined = source?.kind;
  return topic === 'instagram' || kind === 'instagram' ? 'Instagram'
    : topic === 'facebook' || kind === 'facebook' ? 'Facebook'
    : topic === 'recent_x' ? '最近X' : topic === 'popular_x' ? '過去X' : topic === 'profile' ? '人物・会社' : '';
}
function sourceLabel(source: EvidenceSource): string {
  return ({ x: 'X', instagram: 'Instagram', facebook: 'Facebook', web: 'Web', fixture: '架空資料' })[source.kind];
}
function cardLabel(card: Card): string {
  const category = topicLabel(card);
  const source = result?.sources.find(entry => entry.sourceId === card.sourceId);
  if (!source || source.kind === 'fixture') return category;
  const platform = sourceLabel(source);
  return category.includes(platform) ? category : [category, platform].filter(Boolean).join(' / ');
}
// Six short lines per page preserve the complete quoted passage without an ellipsis.
function excerptPages(text: string): string[] {
  const lines: string[] = []; let line = ''; let width = 0;
  for (const character of Array.from(text.replace(/\s+/g, ' ').trim())) {
    const size = /^[\x20-\x7e]$/.test(character) ? 1 : 2;
    if (width + size > 36) { lines.push(line); line = ''; width = 0; }
    line += character; width += size;
  }
  if (line) lines.push(line);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += 6) pages.push(lines.slice(i, i + 6).join('\n'));
  return pages.length ? pages : ['該当文はありません'];
}
function positionAt(cards: Card[], index: number): SourcePosition | null {
  if (index < 0) return null;
  for (const card of cards) {
    const count = excerptPages(card.excerpt).length;
    if (index < count) return { cardId: card.cardId, sourceId: card.sourceId, excerpt: card.excerpt, page: index };
    index -= count;
  }
  return null;
}
function pageAt(cards: Card[], position: SourcePosition | null): number {
  if (!position) return -1;
  // Reassessment regenerates card IDs. An unchanged source and exact excerpt
  // can still anchor the same passage; a substituted source never can.
  const index = cards.findIndex(card => card.cardId === position.cardId && card.sourceId === position.sourceId);
  const match = index >= 0 ? index : cards.findIndex(card => card.sourceId === position.sourceId && card.excerpt === position.excerpt);
  if (match < 0) return -1;
  const count = excerptPages(cards[match]!.excerpt).length;
  return cards.slice(0, match).reduce((total, card) => total + excerptPages(card.excerpt).length, 0) + Math.min(position.page, count - 1);
}
function navigateGlassesSource(direction: 1 | -1) {
  const cards = result?.cards.filter(card => Date.parse(card.expiresAt) > Date.now()).slice(0, 4) ?? [];
  if (direction === -1 && (voicePhase === 'error' || (sourcePage < 0 && conversationRunning))) {
    pendingNavigation = null; pendingSearchChoice = null;
    pendingAudioAction = { action: conversationRunning ? 'retry' : 'restart', view: viewToken };
    void renderGlassesView(); return;
  }
  pendingAudioAction = null;
  if (!cards.length && searchCandidates.length && conversationRunning && !choosingSearch) {
    searchCandidateIndex = (searchCandidateIndex + direction + searchCandidates.length) % searchCandidates.length;
    pendingSearchChoice = searchCandidates[searchCandidateIndex]!.id;
    renderSearchView(); return;
  }
  const pages = cards.flatMap(card => excerptPages(card.excerpt).map(() => card.cardId));
  if (!pages.length || pendingNavigation) return;
  let page = sourcePage + direction;
  if (page >= pages.length) page = -1;
  if (page < -1) page = pages.length - 1;
  pendingNavigation = { page, position: positionAt(cards, page), view: viewToken };
  // Keep the current content and its native scroll position. Only the footer
  // asks for permission; neither scrolling nor a double tap changes the page.
  void renderGlassesView();
}
function settleNavigation(accept: boolean): boolean {
  if (pendingAudioAction) {
    const choice = pendingAudioAction; pendingAudioAction = null;
    if (accept && choice.view === viewToken && token && !document.hidden && !pageLeaving) {
      if (choice.action === 'retry' && conversationRunning) { void retryConversation(); return true; }
      if (choice.action === 'restart' && voicePhase === 'error' && !conversationRunning) { void startConversation(); return true; }
    }
    if (hasCurrentCards()) renderCard();
    else if (conversationRunning && searchCandidates.length) renderSearchView();
    else void renderGlassesView();
    return true;
  }
  if (pendingSearchChoice) {
    const id = pendingSearchChoice; pendingSearchChoice = null;
    if (accept) void chooseSearchCandidate(id); else if (hasCurrentCards()) renderCard(); else renderSearchView();
    return true;
  }
  if (!pendingNavigation) return false;
  const choice = pendingNavigation; pendingNavigation = null;
  const cards = result?.cards.filter(card => Date.parse(card.expiresAt) > Date.now()).slice(0, 4) ?? [];
  const destination = pageAt(cards, choice.position);
  if (accept && choice.view === viewToken && (choice.page === -1 || destination >= 0)) {
    sourcePage = choice.page === -1 ? -1 : destination; sourcePosition = choice.position;
  }
  // Staying on the current screen still applies any completed enrichment, so
  // the visible card and its next source navigation always use the same data.
  renderCard();
  return true;
}
function renderSearchCandidates(values: SearchCandidate[] = searchCandidates) {
  searchCandidates = values;
  if (pendingSearchChoice && !values.some(candidate => candidate.id === pendingSearchChoice)) pendingSearchChoice = null;
  $('search-panel').classList.toggle('hidden', !currentSearch && !values.length);
  $('current-search').textContent = currentSearch || '検索を準備しています。選択できる検索候補：';
  $('search-choices').replaceChildren();
  for (const [index, candidate] of values.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.disabled = choosingSearch || resettingConversation || !conversationRunning;
    button.textContent = `${index + 1}. ${candidate.label}：${candidate.query}`;
    button.onclick = () => { void chooseSearchCandidate(candidate.id); };
    $('search-choices').append(button);
  }
}
function clearSearch() {
  currentSearch = ''; pendingSearchChoice = null; searchCandidateIndex = -1;
  renderSearchCandidates([]);
}
function renderSearchView() {
  if (hasCurrentCards() || !conversationRunning) return;
  const selected = searchCandidates.find(candidate => candidate.id === pendingSearchChoice);
  const choices = searchCandidates.map((candidate, index) => `${candidate.id === pendingSearchChoice ? '→' : ''}${index + 1} ${candidate.query}`).join('\n\n');
  void sendView(selected ? 'この検索候補に変更しますか？' : '公開情報を検索中', `${currentSearch || '検索を準備中'}\n\n${choices}${choices ? '\n候補選択はスクロール' : ''}`, '1回=選択 2回=そのまま');
}
function isProgressive(value: ResearchResult | null): boolean {
  return value?.reasonCode === 'PROGRESSIVE_QUICK' || value?.reasonCode === 'PROGRESSIVE_ENRICHING';
}
function hasCurrentCards(): boolean {
  return !!result && result.requestId === currentId && result.subjectRevision === revision &&
    result.cards.some(card => card.requestId === currentId && card.subjectRevision === revision && Date.parse(card.expiresAt) > Date.now());
}
function renderBoard(cards: Card[]) {
  for (let index = 0; index < 4; index++) {
    const slot = $<HTMLButtonElement>(`topic-${index}`); const card = cards[index];
    const label = card ? cardLabel(card) : '';
    slot.disabled = !card; slot.classList.toggle('empty', !card); slot.classList.toggle('selected', !!card && index === cardIndex);
    slot.setAttribute('aria-pressed', String(!!card && index === cardIndex));
    slot.setAttribute('aria-label', card ? `${index + 1}件目${label ? `・${label}` : ''}の原文と出典を表示` : `${index + 1}件目は未確認`);
    slot.querySelector('.topic-number')!.textContent = `${index + 1} / ${card ? `${label ? `${label} · ` : ''}原文・出典 ↗` : '未確認'}`;
    slot.querySelector('.topic-fact')!.textContent = card ? card.displayFact || card.fact : '未確認';
    slot.querySelector('.topic-question')!.textContent = card ? card.displayQuestion || card.suggestedQuestion : '確認後に表示';
    slot.onclick = card ? () => { cardIndex = index; renderCard(); const panel = $('evidence-panel'); panel.focus({ preventScroll: true }); panel.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); } : null;
  }
}
function clearResult(preserveSelection = false) {
  if (!preserveSelection) { lockedPerson = null; sourcePage = -1; sourcePosition = null; pendingNavigation = null; pendingAudioAction = null; }
  result = null; cardIndex = 0;
  $('candidates').replaceChildren(); $('sources').replaceChildren(); $('source-empty').classList.remove('hidden');
  renderBoard([]);
  $('hud-target').textContent = 'WAITING'; $('hud-source').textContent = '各カードを押すと原文・出典を表示'; $('hud-expiry').textContent = '0 / 4件確認';
  $('card-count').textContent = '0 / 0'; $('previous').setAttribute('disabled', ''); $('next').setAttribute('disabled', '');
}
async function sendView(header: string, content: string, footer: string) {
  glassesView = { header: header.slice(0, 60), content: content.slice(0, 1800), footer: footer.slice(0, 100) };
  await renderGlassesView();
}
async function renderGlassesView() {
  if (!connected || document.hidden || pageLeaving) return;
  let footer = glassesView.footer;
  if (voicePhase !== 'off') {
    const source = audioSource === 'g2' ? 'G2' : 'スマホ';
    const labels: Record<Exclude<VoicePhase, 'off'>, string> = {
      connecting: `${source} 音声準備中・発話はお待ちください`, listening: `${source} 聞取${running || audioBusy ? '・調査' : ''}中`,
      paused: '音声一時停止・スマホで確認', stopped: '音声停止', error: voiceErrorLabel,
    };
    footer = labels[voicePhase];
    if (voicePhase === 'listening') {
      if (lockedPerson) footer += '・人物固定';
      const latest = Array.from(voicePreview.replace(/\s+/g, ' ').trim()).slice(-16).join('');
      footer += latest ? `｜${latest}` : '｜発話待ち';
    }
    footer = shortText(footer, 46);
  }
  if (pendingAudioAction) footer = `${pendingAudioAction.action === 'retry' ? '人物を聞き直す' : '音声を再開する'}？ 1回=実行 2回=そのまま`;
  else if (pendingNavigation) footer = `${pendingNavigation.page === -1 ? '一覧に戻る' : '出典へ進む'}？ 1回=進む 2回=そのまま`;
  else if (pendingSearchChoice) footer = '候補を選ぶ？ 1回=選ぶ 2回=そのまま';
  await g2.render({ ...glassesView, footer }, viewToken);
}
function queueVoiceDisplay(immediate = false) {
  if (immediate) { clearTimeout(voiceDisplayTimer); voiceDisplayTimer = undefined; void renderGlassesView(); return; }
  if (voiceDisplayTimer !== undefined) return;
  // Recognition deltas can arrive rapidly. Coalesce them instead of saturating Bluetooth.
  voiceDisplayTimer = setTimeout(() => { voiceDisplayTimer = undefined; void renderGlassesView(); }, 500);
}
function setVoicePhase(phase: VoicePhase) {
  voicePhase = phase;
  if (phase !== 'listening') voicePreview = '';
  queueVoiceDisplay(true);
}
function reportVoiceError(message: string) {
  voiceErrorLabel = /費用|予算/.test(message) ? '費用上限で停止・再開してください'
    : /認証|ログイン|期限/.test(message) ? '利用期限・QRを読み直してください'
    : /マイク|許可/.test(message) ? 'マイク未接続・G2接続を確認'
    : /準備|タイムアウト|時間内/.test(message) ? '音声の接続待ち切れ・再開してください'
    : /送信速度/.test(message) ? '音声の送信速度超過・再開してください'
    : /遅れ|追いつ|送信待ち/.test(message) ? '音声送信が不安定・再開してください'
    : /サイズ|形式/.test(message) ? '音声データを確認・再開してください'
    : /受け付け/.test(message) ? '音声API受付エラー・再開してください'
    : /応答.*検証|応答.*確認/.test(message) ? '音声API応答エラー・再開してください'
    : /サービス|音声認識/.test(message) ? '音声API接続失敗・再開してください'
    : '音声接続切れ・再開してください';
  setVoicePhase('error'); status(`${message} G2は上スクロールで再開確認→1回タップ、スマホは「会話モードを再開」で再開できます。`, true);
  void sendView('音声を再開できます', 'G2は上スクロール→1回タップで再開\nスマホは「会話モードを再開」', voiceErrorLabel); refreshControls();
}
function renderCard() {
  const cards = result?.cards.filter(c => Date.parse(c.expiresAt) > Date.now()).slice(0, 4) || [];
  if (!cards.length) {
    if (result?.cards.length) { clearResult(); refreshControls(); status('カードの有効期限が切れました。必要なら再調査してください。'); void sendView('これで誰でも雑談マスター', 'カードの有効期限が切れました。', '再調査してください'); }
    return;
  }
  cardIndex = (cardIndex + cards.length) % cards.length;
  const card = cards[cardIndex]!;
  const source = result!.sources.find(s => s.sourceId === card.sourceId)!;
  renderBoard(cards);
  $('hud-target').textContent = `${lockedPerson ? '固定：' : ''}${result!.target?.personName || ''}`;
  $('hud-source').textContent = '短い事実と質問 / 原文・出典はカードを選択';
  $('hud-expiry').textContent = `${cards.length} / 4件確認`;
  $('card-count').textContent = `${cardIndex + 1} / ${cards.length}`;
  $('previous').toggleAttribute('disabled', cards.length < 2); $('next').toggleAttribute('disabled', cards.length < 2);
  $('sources').replaceChildren(); $('source-empty').classList.add('hidden');
  const evidence = document.createElement('div'); evidence.className = 'source';
  const title = document.createElement('h3'); title.textContent = `${cardIndex + 1}. ${source.title}`;
  const platform = document.createElement('p'); platform.className = 'source-platform'; platform.textContent = `出典：${sourceLabel(source)}`;
  const fullFact = document.createElement('p'); fullFact.className = 'source-fact'; fullFact.textContent = `事実（全文）：${card.fact}`;
  const fullQuestion = document.createElement('p'); fullQuestion.textContent = `質問の提案：${card.suggestedQuestion}`;
  const quote = document.createElement('blockquote'); quote.textContent = card.excerpt;
  const date = document.createElement('p'); date.className = 'muted'; date.textContent = `取得：${new Date(source.retrievedAt).toLocaleString('ja-JP')}`;
  const expiry = document.createElement('p'); expiry.className = 'muted'; expiry.textContent = `有効期限：${new Date(card.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  evidence.append(title, platform, fullFact, fullQuestion);
  const quoteLabel = document.createElement('p'); quoteLabel.className = 'muted'; quoteLabel.textContent = '根拠となった該当文'; evidence.append(quoteLabel, quote);
  const originalText = source.xPost?.text ?? source.socialPost?.text;
  if (originalText) {
    const originalLabel = document.createElement('h4'); originalLabel.textContent = '取得した元投稿';
    const original = document.createElement('blockquote'); original.className = 'source-original'; original.textContent = originalText;
    evidence.append(originalLabel, original);
  }
  evidence.append(date, expiry);
  const label = topicLabel(card);
  if (label) { const category = document.createElement('p'); category.className = 'source-topic muted'; category.textContent = `話題：${label}`; evidence.insertBefore(category, fullFact); }
  if (source.xPost) {
    const post = source.xPost;
    if (post.createdAt) {
      const posted = document.createElement('p'); posted.className = 'source-post-date muted';
      posted.textContent = `投稿：${new Date(post.createdAt).toLocaleString('ja-JP')}`; evidence.append(posted);
    }
    const counts = [['いいね', post.likeCount], ['リポスト', post.repostCount], ['返信', post.replyCount], ['引用', post.quoteCount]] as const;
    const visibleCounts = counts.filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0);
    if (visibleCounts.length) {
      const metrics = document.createElement('p'); metrics.className = 'source-post-metrics muted';
      metrics.textContent = `取得時の反響：${visibleCounts.map(([name, count]) => `${name} ${count!.toLocaleString('ja-JP')}`).join(' / ')}`; evidence.append(metrics);
    }
    if (post.selectionScope === 'full_archive_sample') {
      const scope = document.createElement('p'); scope.className = 'source-selection-scope muted';
      scope.textContent = '過去の反響：全期間の検索候補から選定'; evidence.append(scope);
    }
  }
  if (source.socialPost) {
    const posted = document.createElement('p'); posted.className = 'source-post-date muted';
    posted.textContent = `投稿：${new Date(source.socialPost.createdAt).toLocaleString('ja-JP')}`; evidence.append(posted);
  }
  if (source.kind !== 'fixture' && /^https?:\/\//.test(source.url)) { const link = document.createElement('a'); link.href = source.url; link.textContent = `${sourceLabel(source)}で${source.xPost || source.socialPost ? '元投稿' : '出典'}を開く ↗`; link.target = '_blank'; link.rel = 'noopener noreferrer'; evidence.append(link); }
  $('sources').append(evidence);
  const rows = Array.from({ length: 4 }, (_, index) => {
    const entry = cards[index];
    const label = entry ? cardLabel(entry) : '';
    return entry ? `${index + 1}${label ? ` ${label}` : ''} 事実:${(entry.displayFact || entry.fact).replace(/\s+/g, ' ')}\n推奨質問:${(entry.displayQuestion || entry.suggestedQuestion).replace(/\s+/g, ' ')}` : `${index + 1} 事実:未確認\n推奨質問:—`;
  });
  refreshControls();
  if (pendingNavigation || pendingSearchChoice || pendingAudioAction) { void renderGlassesView(); return; }
  if (sourcePosition) sourcePage = pageAt(cards, sourcePosition);
  if (sourcePage >= 0) {
    const pages = cards.flatMap((entry, index) => {
      const sections = excerptPages(entry.excerpt);
      return sections.map((content, page) => ({ content, index, entry, page, count: sections.length }));
    });
    sourcePage = Math.min(sourcePage, pages.length - 1);
    const page = pages[sourcePage]!;
    sourcePosition = positionAt(cards, sourcePage);
    void sendView(`${lockedPerson ? '固定 ' : ''}${page.index + 1} ${cardLabel(page.entry) || '出典'} 該当文 ${page.page + 1}/${page.count}`, page.content, 'スクロールで続き・最後の次は一覧');
    return;
  }
  sourcePosition = null;
  void sendView(`${result!.mode === 'demo' ? '[架空] ' : ''}${lockedPerson ? '固定 ' : ''}${shortText(result!.target?.personName || '', 28)} ${cards.length}/4件${isProgressive(result) ? ' 速報・追加調査中' : ''}`, rows.join('\n\n'), '下=出典確認 上=聞き直し確認 / 2回=固定');
}
function addTrace(event: TraceEvent) {
  if (event.search) {
    const platforms = { web: 'Web', x: 'X', instagram: 'Instagram', facebook: 'Facebook' };
    const actions = { web_search: '検索', account_lookup: 'アカウント照会', recent_posts: '最近の投稿取得', archive_search: '過去投稿検索', social_posts: '投稿取得' };
    currentSearch = `${platforms[event.search.provider]}・${actions[event.search.operation]}：${event.search.query}`;
    renderSearchCandidates(); renderSearchView();
  }
  if ($('trace').children.length >= 60) return;
  $('trace-empty').classList.add('hidden');
  const li = document.createElement('li'); const time = document.createElement('time'); time.textContent = new Date(event.at).toLocaleTimeString('ja-JP');
  li.append(time, document.createTextNode(event.search ? `${event.message} ${event.search.query}` : event.message)); $('trace').append(li); $('trace').scrollTop = $('trace').scrollHeight;
}
function showResult(value: ResearchResult) {
  const failure = value.status === 'failed' ? researchFailure({ code: value.reasonCode, message: value.message }) : undefined;
  if (failure && hasCurrentCards() && !mustStopConversation({ code: value.reasonCode, message: value.message })) {
    preserveCurrentCards({ code: value.reasonCode, message: value.message }); return;
  }
  if (lockedPerson && value.cards.length && value.target && (value.target.personName !== lockedPerson.personName || value.target.companyName !== lockedPerson.companyName)) {
    status('固定した人物と異なる調査結果は表示しません。変更は一覧の上スクロールから聞き直してください。'); return;
  }
  if (!value.cards.length) lockedPerson = null;
  clearResult(true); result = value;
  const message = isProgressive(value) ? `速報・追加調査中。${value.message}` : failure ? `${failure.message} ${failure.action}` : value.message;
  status(message);
  $('result-note').textContent = value.mode === 'demo' ? '架空の人物・固定資料によるデモです。表示の動作確認であり、実APIやG2実機の動作証明ではありません。' : message;
  $('metric-time').textContent = `${(value.usage.elapsedMs / 1000).toFixed(1)}秒`;
  $('metric-calls').textContent = `${value.usage.llm} / ${value.usage.searches} / ${value.usage.pages}`;
  $('metric-cost').textContent = value.mode === 'demo' ? '模擬' : value.usage.costKnown ? `$${value.usage.actualUsd?.toFixed(4)}` : `$${value.usage.reservedUsd.toFixed(3)}`;
  $('cost-label').textContent = value.mode === 'demo' ? '実費は未計測' : value.usage.costKnown ? '計測された費用' : '実費未確定・上限額を留保';
  if (value.mode === 'live' && value.usage.reportedUsd !== undefined) {
    $('cost-label').textContent += ` / 一部API報告額（暫定）$${value.usage.reportedUsd.toFixed(6)}`;
  }
  $('candidates').replaceChildren();
  if (value.status === 'awaiting_confirmation') {
    for (const candidate of value.candidates) { const button = document.createElement('button'); button.textContent = `${candidate.personName}${candidate.companyName ? ` / ${candidate.companyName}` : ''} を選ぶ`; button.onclick = () => { if (lastInput) { $<HTMLTextAreaElement>('text').value = lastInput.text; void research(candidate.id, undefined, conversationId || undefined); } }; $('candidates').append(button); }
  }
  if (!value.cards.length) {
    renderBoard([]); $('hud-target').textContent = value.target?.personName || '対象未確認'; $('hud-expiry').textContent = '0 / 4件確認';
    void sendView(failure ? '調査を一時停止' : value.status === 'awaiting_confirmation' ? '相手の確認が必要です' : '確認できた情報はありません',
      failure ? failure.message : Array.from({ length: 4 }, (_, index) => `${index + 1} 事実:未確認\n推奨質問:—`).join('\n\n'), failure?.action ?? 'スマートフォンで確認');
  }
  renderCard();
}
function preserveCurrentCards(error: unknown): boolean {
  if (!hasCurrentCards() || mustStopConversation(error)) return false;
  const failure = researchFailure(error);
  const message = `${failure.message} 確認済みの話題を表示しています。${conversationRunning ? '聞き取りは続いています。' : ''}`;
  result = { ...result!, status: 'partial', reasonCode: 'PROGRESSIVE_ENRICHMENT_INTERRUPTED', message };
  status(message); $('result-note').textContent = message; renderCard();
  return true;
}
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const sentToken = token; const sentGeneration = authGeneration;
  const headers = new Headers(init.headers); if (sentToken) headers.set('Authorization', `Bearer ${sentToken}`);
  const response = await fetch(path, { ...init, headers, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) { const body = await response.json().catch(() => ({})); if (response.status === 401 && token === sentToken && authGeneration === sentGeneration) { token = ''; expiresAt = 0; controller?.abort(); controller = null; identifyController?.abort(); identifyController = null; running = false; currentId = crypto.randomUUID(); newViewToken(); void stopRecording(false); clearConversation(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden'); $('login-status').textContent = 'ログインの有効期限が切れました。再読み込みするか、利用コードで開始してください。'; } throw Object.assign(new Error(typeof body?.message === 'string' ? body.message : '処理できませんでした。接続・設定・入力を確認してください。'), { status: response.status, code: typeof body?.code === 'string' ? body.code : undefined }); }
  return response;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function acceptSession(data: { token: string; revision: number; expiresAt: number; hasPrevious: boolean; interrupted: boolean }, fromQr = false) {
  token = data.token; revision = data.revision; expiresAt = data.expiresAt;
  $<HTMLInputElement>('access-code').value = ''; $('login').classList.add('hidden'); $('workspace').classList.remove('hidden');
  $('resume-notice').classList.toggle('hidden', !data.hasPrevious && !data.interrupted);
  if (data.interrupted) status('前の調査が中断されました。マイクは停止しています。必要なら再調査してください。');
  if (conversationLaunch && runtimeStatus.liveEnabled) {
    $<HTMLSelectElement>('mode').value = 'live'; $('mode').dispatchEvent(new Event('change'));
    if (!fromQr || !qrAutoStartPending) {
      status('人物・会社の入力は不要です。「会話モードを開始」を押してください。');
      if (!connected) void connectGlasses();
    }
  }
  if (fromQr && qrAutoStartPending) void startQrConversation();
  refreshControls();
}
function setAuthBusy(busy: boolean) {
  authBusy = busy;
  for (const control of $('login-form').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) control.disabled = busy;
}
async function login() {
  if (authBusy) return; setAuthBusy(true);
  const generation = ++authGeneration;
  try {
    const response = await api('/api/session', json({ accessCode: $<HTMLInputElement>('access-code').value, rememberDevice: runtimeStatus.accessCodeRequired && $<HTMLInputElement>('remember-device').checked }));
    const data = await response.json(); if (generation !== authGeneration) return;
    acceptSession(data);
  } catch (error) { if (generation === authGeneration) $('login-status').textContent = error instanceof Error ? error.message : '開始できませんでした。'; }
  finally { setAuthBusy(false); }
}
async function restoreLogin(): Promise<boolean> {
  if (authBusy) return false; setAuthBusy(true);
  const generation = ++authGeneration;
  const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 8_000);
  try {
    const response = await fetch('/api/session/restore', { ...json({}), credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
    if (!response.ok) {
      if (response.status !== 401 && generation === authGeneration) $('login-status').textContent = 'ログインを再開できませんでした。利用コードで開始できます。';
      return false;
    }
    const data = await response.json(); if (generation !== authGeneration) return false;
    acceptSession(data); return true;
  } catch {
    if (generation === authGeneration) $('login-status').textContent = '接続を確認して再読み込みするか、利用コードで開始してください。';
    return false;
  } finally { clearTimeout(timeout); setAuthBusy(false); }
}
async function redeemQrLogin(): Promise<boolean> {
  if (authBusy || pageLeaving || document.hidden || !qrLoginTicket) return false;
  const ticket = qrLoginTicket; qrLoginTicket = '';
  if (!/^[a-f0-9]{64}$/.test(ticket)) { $('login-status').textContent = 'ログイン用QRを読み取れませんでした。新しいQRを読み込んでください。'; return false; }
  setAuthBusy(true); const generation = ++authGeneration;
  const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 8_000);
  try {
    const response = await api('/api/session/qr/redeem', { ...json({ ticket }), signal: abort.signal });
    const data = await response.json(); if (generation !== authGeneration) return false;
    status('QRでログインしました。G2を接続して開始できます。'); acceptSession(data, true); return true;
  } catch {
    if (generation === authGeneration) $('login-status').textContent = 'このQRは使用済みか期限切れです。接続を確認し、新しいログイン用QRを読み込んでください。';
    return false;
  } finally { clearTimeout(timeout); setAuthBusy(false); }
}
function clearConversation() {
  clearSearch();
  $('correction-hint').textContent = ''; $('correction-hint').classList.add('hidden');
  clearResult(); lastInput = null; $<HTMLTextAreaElement>('text').value = '';
  $('trace').replaceChildren(); $('trace-empty').classList.remove('hidden');
  $('resume-notice').classList.add('hidden');
}
async function expireSession() {
  const generation = ++authGeneration; expiresAt = 0;
  await cancel(); if (generation !== authGeneration) return;
  token = ''; clearConversation(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden');
  $('login-status').textContent = '利用期限が切れたため会話データを削除しました。';
  if (await restoreLogin()) status('前の会話データを削除し、新しいセッションを開始しました。マイクは停止しています。');
}
async function research(selectedCandidateId?: string, preparedId?: string, activeConversationId?: string) {
  const text = $<HTMLTextAreaElement>('text').value.trim(); if (!text) { status('人物名、または会話を入力してください。'); return; }
  if (running || recording && !activeConversationId || audioBusy || !token) return;
  $('resume-notice').classList.add('hidden');
  currentSearch = ''; if (!activeConversationId) renderSearchCandidates([]); else renderSearchCandidates();
  currentId = preparedId || crypto.randomUUID(); revision += 1; newViewToken(); clearResult();
  if (activeConversationId) conversationRequestRevision = revision;
  $('trace').replaceChildren(); $('trace-empty').classList.remove('hidden');
  running = true; refreshControls(); controller = new AbortController(); const ownController = controller; const ownId = currentId;
  const ownRevision = revision; const ownView = viewToken;
  const valid = () => currentId === ownId && revision === ownRevision && viewToken === ownView && !ownController.signal.aborted;
  const input: ResearchInput = { text, requestId: ownId, subjectRevision: ownRevision, mode: $<HTMLSelectElement>('mode').value as 'demo' | 'live', scenario: $<HTMLSelectElement>('scenario').value as Scenario, ...(selectedCandidateId ? { selectedCandidateId } : {}), ...(activeConversationId ? { conversationId: activeConversationId } : {}) };
  lastInput = input; status('公開情報を調べています…');
  let gotResult = false;
  try {
    await sendView('これで誰でも雑談マスター', '公開情報を調査中…', '中止はスマートフォンから');
    if (!valid()) return;
    const response = await api('/api/research', { ...json(input), signal: ownController.signal });
    if (!valid()) { await response.body?.cancel(); return; }
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffered = ''; let bytes = 0;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (!valid()) { await reader.cancel(); break; }
      bytes += chunk.value.length; if (bytes > 1_000_000) { await reader.cancel(); throw new Error('応答のサイズが上限を超えました。'); }
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split('\n'); buffered = lines.pop()!;
      for (const line of lines) {
        if (!valid()) break;
        if (!line.trim()) continue; const message = JSON.parse(line);
        if (message.type === 'trace') addTrace(message.event);
        else if (message.type === 'result' || message.type === 'update') {
          const parsed = parseResearchResult(message.result);
          if (parsed.requestId === ownId && parsed.subjectRevision === ownRevision && valid()) {
            if (message.type === 'result') gotResult = true;
            showResult(parsed);
          }
        }
        else if (message.type === 'error') throw Object.assign(new Error(message.message), { code: typeof message.code === 'string' ? message.code : undefined });
      }
    }
    if (!gotResult && valid()) throw new Error('接続が中断されました。再調査してください。');
    if (activeConversationId && valid() && result?.requestId === ownId) {
      if (result.status === 'awaiting_confirmation') {
        conversationLastKey = ''; conversationLastAt = 0;
        status('聞き取りを続けています。名前や所属を言い直すか、候補を選んでください。「聞き直す」で対象をリセットできます。');
      }
      if (mustStopConversation({ code: result.reasonCode, message: result.message })) throw Object.assign(new Error(result.message), { code: result.reasonCode });
      if (result.status === 'failed') await waitForNextUtterance({ code: result.reasonCode, message: result.message });
    }
  } catch (error) { if (valid()) { if (preserveCurrentCards(error)) return; if (activeConversationId) { if (mustStopConversation(error)) { await stopRecording(false); reportVoiceError(error instanceof Error ? error.message : '会話の調査を続けられませんでした。'); } else await waitForNextUtterance(error); return; } const failure = researchFailure(error); status(`${failure.message} ${failure.action}`, true); await sendView('これで誰でも雑談マスター', failure.message, failure.action); } }
  finally { if (controller === ownController) { running = false; controller = null; refreshControls(); } }
}
async function cancel() {
  clearSearch();
  const wasConversation = conversationRunning;
  const oldId = currentId; const oldRevision = revision; abortConversation(); controller?.abort(); controller = null; running = false;
  currentId = crypto.randomUUID(); revision += 1; newViewToken(); clearResult();
  await stopRecording(false);
  if (!wasConversation && oldId && token) void api('/api/cancel', json({ requestId: oldId, subjectRevision: oldRevision })).catch(() => {});
  status('停止しました。遅れて届いた結果は表示しません。'); await sendView('これで誰でも雑談マスター', '調査を停止しました。', '入力待ち'); refreshControls();
}
function g2Status(state: G2Status) {
  connected = state.state === 'connected' || state.state === 'recording';
  const labels: Record<string, string> = { idle: '画面プレビュー', connecting: 'G2へ接続中', connected: 'G2接続受付済み', recording: 'G2で録音中', background: 'バックグラウンド・停止', disconnected: 'G2切断', unavailable: 'Evenアプリ内で接続してください', error: 'G2接続を確認してください', disposed: 'G2接続終了' };
  $('device-status').textContent = `Even G2 · ${labels[state.state] || state.state}`; $('connection').textContent = connected ? 'G2接続受付済み' : 'スマートフォン表示'; $('device-dot').classList.toggle('on', connected);
  const awaitingGlassesMicrophone = conversationRunning && voicePhase === 'connecting' && state.state === 'connected';
  const failedConversationAudio = recording && conversationRunning && audioSource === 'g2' && ['error', 'disconnected'].includes(state.state);
  if (failedConversationAudio) {
    // Stop synchronously, then preserve the SDK reason. cancel() would erase
    // this error and invalidate the start routine before it could report it.
    void stopRecording(false);
  } else if (recording && audioSource === 'g2' && state.state !== 'recording' && !awaitingGlassesMicrophone) {
    if (conversationRunning) void cancel(); else void stopRecording(state.state === 'connected');
  }
  if (['background', 'disconnected', 'error', 'disposed'].includes(state.state)) { currentId = crypto.randomUUID(); newViewToken(); clearResult(); }
  if (failedConversationAudio) {
    const reason = state.reason === 'audio_start_timeout' ? 'G2マイクの開始確認が時間内に届きませんでした。'
      : state.reason === 'audio_start_failed' ? 'G2のマイクを開始できませんでした。接続と許可を確認してください。'
      : state.reason === 'audio_stop_failed' ? 'G2マイクの停止を確認できません。Evenアプリで接続し直してください。'
      : state.state === 'disconnected' ? 'G2の接続が切れたため、音声認識を停止しました。'
      : 'G2との通信でエラーが発生し、音声認識を停止しました。';
    reportVoiceError(reason);
  }
}
function acceptAudio(chunk: Uint8Array) {
  if (recording && conversationRunning) { conversation?.append(chunk); return; }
  if (!recording || audioBytes + chunk.length > 960_000) return;
  audioChunks.push(chunk.slice()); audioBytes += chunk.length;
}
g2 = new G2Runtime({ onStatus: g2Status, onAudio: acceptAudio, onAction: action => {
  if (action === 'next') navigateGlassesSource(1);
  else if (action === 'previous') navigateGlassesSource(-1);
  else if (action === 'primary') {
    if (settleNavigation(true)) return;
    // A late or duplicate navigation tap must never become an audio reset.
    if (hasCurrentCards() && voicePhase !== 'error') navigateGlassesSource(1);
    else status('聞き直すには上スクロールで確認を表示し、1回タップしてください。');
  } else if (action === 'secondary') { if (!settleNavigation(false)) lockCurrentPerson(); }
  else if (action === 'exit') void cancel();
} });
function lockCurrentPerson() {
  if (!conversationRunning || resettingConversation || !hasCurrentCards() || !result?.target || document.hidden || pageLeaving) return;
  lockedPerson = { ...result.target }; choosingSearch = false;
  // Leave the current person's additional sources running, but reject an
  // identification response that was already in flight when the user locked.
  conversationSubjectGeneration++; transcriptDrainId++; identifyingTranscript = false;
  pendingTranscript = null; identifyController?.abort(); identifyController = null; identifyingRequest = null; audioBusy = false;
  status(`${lockedPerson.personName}さんを固定しました。聞き取りは続けます。変更は一覧の上スクロールから聞き直してください。`);
  renderCard(); refreshControls();
}
const phone = new PhoneAudio({ onAudio: acceptAudio, onStopped: reason => { if (recording && audioSource === 'phone') { if (conversationRunning) void cancel(); else void stopRecording(reason !== 'error'); } }, onError: message => status(message, true) });
function abortConversation() {
  qrAutoStartPending = false;
  pendingNavigation = null; pendingSearchChoice = null; pendingAudioAction = null;
  choosingSearch = false;
  lockedPerson = null;
  const wasActive = conversationRunning;
  const group = conversationId;
  const activeRequest = running ? { requestId: currentId, subjectRevision: conversationRequestRevision || revision }
    : identifyingRequest ?? { requestId: currentId, subjectRevision: conversationRequestRevision || Math.max(1, revision + 1) };
  conversationSubjectGeneration++; transcriptDrainId++; identifyingTranscript = false; resettingConversation = false; ignoredTranscriptItems.clear();
  identifyController?.abort(); identifyController = null; identifyingRequest = null;
  keepaliveController?.abort(); keepaliveController = null;
  const stream = conversation; conversation = null; conversationRunning = false; conversationId = ''; pendingTranscript = null; partialTranscripts.clear(); completedTranscript = ''; stream?.cancel();
  if (wasActive) setVoicePhase('stopped');
  if (group && token) {
    controller?.abort(); controller = null; running = false;
    void api('/api/cancel', json({ ...activeRequest, conversationId: group })).catch(() => {});
  }
}
function mustStopConversation(error: unknown): boolean {
  const details = error && typeof error === 'object' ? error as { status?: number; code?: string; message?: string } : {};
  return details.status === 401 || details.status === 403 || details.status === 429 && !details.code ||
    /^(?:BUDGET_|AUTH_|SESSION_|CONVERSATION_EXPIRED|CONVERSATION_NOT_FOUND)/u.test(details.code ?? '') ||
    /費用|予算|認証|ログイン|利用期限|(?:セッション|会話モード).*(?:終了|失効|期限)/u.test(details.message ?? '');
}
function parseResearchResult(value: unknown): ResearchResult {
  const parsed = ResearchResultSchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error('画面で調査結果を読み込めませんでした。'), { code: 'RESPONSE_FORMAT_MISMATCH' });
  return parsed.data;
}
function researchFailure(error: unknown): { message: string; action: string } {
  const details = error && typeof error === 'object' ? error as { code?: string; status?: number; name?: string } : {};
  const code = details.code ?? '';
  const retry = '少し待って、同じ名前でもう一度話してください。';
  if (code.startsWith('BUDGET_')) {
    return {
      message: code === 'BUDGET_EXHAUSTED' ? '設定した費用上限に達しました。' : '費用管理の状態を確認する必要があります。',
      action: '費用の設定・利用状況を確認してから調査を再開してください。',
    };
  }
  if (code === 'RESPONSE_FORMAT_MISMATCH' || details.name === 'ZodError' || details.name === 'SyntaxError') {
    return { message: '画面で調査結果を読み込めませんでした。', action: '同じQRを読み直して画面を開き直してください。' };
  }
  if (/TIMEOUT|DEADLINE_EXCEEDED/u.test(code) || details.status === 408 || details.status === 504) {
    return { message: '調査サービスの応答が時間切れになりました。', action: retry };
  }
  if (code === 'RATE_LIMITED' || details.status === 429) return { message: '調査サービスが混雑しています。', action: retry };
  if (code === 'INVALID_PROVIDER_RESPONSE' || code === 'INVALID_OR_UNAVAILABLE_RESPONSE') {
    return { message: '調査サービスの回答を読み取れませんでした。', action: retry };
  }
  if (code === 'PROVIDER_UNAUTHORIZED' || code === 'PROVIDER_CREDITS' || code === 'LIVE_DISABLED') {
    return { message: '調査サービスの設定・利用状況を確認する必要があります。', action: 'スマートフォンで利用状況を確認してください。' };
  }
  if (/PROVIDER_|SOURCES_UNAVAILABLE/u.test(code) || details.status && details.status >= 500 || details.name === 'TypeError') {
    return { message: '調査サービスに接続できませんでした。', action: retry };
  }
  return { message: '調査を完了できませんでした。', action: '接続を確認し、同じ名前でもう一度話してください。' };
}
async function waitForNextUtterance(error: unknown) {
  const failure = researchFailure(error);
  conversationLastKey = ''; conversationLastAt = 0;
  if (preserveCurrentCards(error)) return;
  newViewToken(); clearResult();
  status(`${failure.message} 聞き取りは続いています。${failure.action}`);
  // The footer shows live microphone status during a conversation; keep the
  // recovery action in the main content so it remains visible on the glasses.
  await sendView('聞き取りを続けています', `${failure.message}\n${failure.action}`, '次の発話を待っています');
}
async function processConversationTranscript(text: string, generation: number) {
  const subjectGeneration = conversationSubjectGeneration;
  const own = new AbortController();
  const valid = () => !own.signal.aborted && subjectGeneration === conversationSubjectGeneration && !resettingConversation && !choosingSearch && !lockedPerson && generation === audioGeneration && conversationRunning && !!token && !document.hidden ;
  if (!valid()) return;
  const id = crypto.randomUUID(); const identifyRevision = revision + 1;
  identifyController = own; identifyingRequest = { requestId: id, subjectRevision: identifyRevision }; audioBusy = true; refreshControls();
  try {
    const response = await api('/api/conversation/identify', { ...json({ text, requestId: id, subjectRevision: identifyRevision, conversationId }), signal: own.signal });
    const data = await response.json(); if (!valid()) return;
    $<HTMLTextAreaElement>('text').value = typeof data.text === 'string' ? data.text : '';
    const choices = SearchCandidateSchema.array().max(4).safeParse(data.searchCandidates);
    if (choices.success) renderSearchCandidates(choices.data);
    const parsed = TargetSchema.array().max(3).safeParse(data.targets);
    const targets = parsed.success ? parsed.data : [];
    const correctionHint = typeof data.correctionHint === 'string' ? data.correctionHint.trim().slice(0, 400) : '';
    const correctionCandidate = TargetSchema.safeParse(data.correctionCandidate);
    const candidateNotice = targets.length === 0 && correctionCandidate.success
      ? `候補：${correctionCandidate.data.personName}。名前を言い直してください。` : '';
    const correctionNotice = [candidateNotice, correctionHint].filter(Boolean).join(' ');
    $('correction-hint').textContent = correctionNotice;
    $('correction-hint').classList.toggle('hidden', !correctionNotice);
    if (targets.length !== 1) {
      if (targets.length > 1 || data.hasPersonMention !== false || correctionNotice) {
        conversationLastKey = ''; conversationLastAt = 0;
        controller?.abort(); controller = null; running = false;
        currentId = id;
        newViewToken(); clearResult();
        await sendView('人物を確認', correctionNotice || (targets.length > 1 ? '複数の人物が出ています。' : '人物名や所属などを教えてください。'), '断定せず、言い直しを待っています');
        if (!valid()) return;
      }
      if (!isProgressive(result)) status(correctionNotice || (targets.length > 1 ? '複数の人物が出ています。調べたい人物を一人ずつ話してください。' : '聞き取り中です。人物名が出たら公開情報を調べます。'));
      return;
    }
    const target = verifiedAliasForTarget(targets[0]!)?.target ?? targets[0]!;
    const key = `${target.companyName}|${target.personName}`.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    if (conversationLastKey === key && (running || Date.now() - conversationLastAt < (result?.cards.length ? 120_000 : 30_000))) {
      if (!isProgressive(result)) status(`${target.personName}さんの話題を表示しながら聞き取り中です。対象が変わると調べ直します。`); return;
    }
    conversationLastKey = key; conversationLastAt = Date.now();
    $<HTMLTextAreaElement>('text').value = `人物の候補：氏名「${target.personName}」${target.companyName ? `、会社名「${target.companyName}」` : '、所属は未指定'}。本人の公開プロフィールで確認してください。直近の発話：${data.text}`;
    controller?.abort(); controller = null; running = false; audioBusy = false;
    // Recognition and identification continue while the current person's
    // additional sources load. Only a different/ambiguous person invalidates it.
    void research(undefined, id, conversationId);
  } finally { if (identifyController === own) { identifyController = null; identifyingRequest = null; } if (subjectGeneration === conversationSubjectGeneration && generation === audioGeneration) audioBusy = false; refreshControls(); }
}
async function drainTranscripts(generation: number) {
  if (identifyingTranscript || resettingConversation || choosingSearch || lockedPerson) return;
  const drainId = ++transcriptDrainId;
  identifyingTranscript = true;
  try {
    while (drainId === transcriptDrainId && pendingTranscript && conversationRunning && !resettingConversation && generation === audioGeneration) {
      const next = pendingTranscript; pendingTranscript = null;
      await processConversationTranscript(next.text, generation);
    }
  } catch (error) {
    if (drainId === transcriptDrainId && generation === audioGeneration && conversationRunning) {
      const message = error instanceof Error ? error.message : '人物の調査を完了できませんでした。';
      if (mustStopConversation(error)) { await stopRecording(false); reportVoiceError(message); }
      else await waitForNextUtterance(error);
    }
  } finally { if (drainId === transcriptDrainId) { identifyingTranscript = false; if (pendingTranscript && conversationRunning && !resettingConversation) void drainTranscripts(audioGeneration); } }
}
async function keepConversationAlive() {
  if (!conversationRunning || !conversationId || !token || document.hidden || pageLeaving || keepaliveController) return;
  const group = conversationId; const generation = audioGeneration; const expectedToken = token;
  const own = new AbortController(); keepaliveController = own;
  const timeout = setTimeout(() => own.abort(), 8_000);
  const valid = () => generation === audioGeneration && conversationRunning && conversationId === group && token === expectedToken && !document.hidden && !pageLeaving;
  try {
    const data = await (await api('/api/conversation/keepalive', { ...json({ conversationId: group }), signal: own.signal })).json();
    if (!valid()) return;
    if (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) throw new Error('会話の利用期限を確認できませんでした。もう一度開始してください。');
    expiresAt = data.expiresAt;
    if (Number.isInteger(data.revision) && data.revision >= 0) revision = Math.max(revision, data.revision);
  } catch (error) {
    if (valid()) { await stopRecording(false); reportVoiceError(error instanceof Error ? error.message : '会話の接続を確認できませんでした。もう一度開始してください。'); }
  } finally { clearTimeout(timeout); if (keepaliveController === own) keepaliveController = null; }
}
async function retryConversation() {
  if (!conversationRunning || !conversationId || resettingConversation || !token || document.hidden || pageLeaving) return;
  const group = conversationId; const generation = audioGeneration; const subjectGeneration = ++conversationSubjectGeneration;
  clearSearch(); choosingSearch = false;
  resettingConversation = true; transcriptDrainId++; identifyingTranscript = false;
  for (const itemId of partialTranscripts.keys()) ignoredTranscriptItems.add(itemId);
  if (pendingTranscript) ignoredTranscriptItems.add(pendingTranscript.itemId);
  while (ignoredTranscriptItems.size > 64) ignoredTranscriptItems.delete(ignoredTranscriptItems.values().next().value!);
  pendingTranscript = null; partialTranscripts.clear(); completedTranscript = ''; voicePreview = '';
  identifyController?.abort(); identifyController = null; identifyingRequest = null;
  controller?.abort(); controller = null; running = false; audioBusy = true;
  conversationLastKey = ''; conversationLastAt = 0; currentId = crypto.randomUUID(); revision++;
  newViewToken(); clearResult(); $('correction-hint').textContent = ''; $('correction-hint').classList.add('hidden'); lastInput = null; $<HTMLTextAreaElement>('text').value = '';
  $('trace').replaceChildren(); $('trace-empty').classList.remove('hidden');
  status('対象をリセットしています。聞き取りは続いています。');
  void sendView('聞き直します', '対象をリセット中です', '音声は再送しません'); refreshControls();
  const own = new AbortController(); controller = own;
  const valid = () => generation === audioGeneration && subjectGeneration === conversationSubjectGeneration && conversationRunning && conversationId === group && !own.signal.aborted;
  try {
    const data = await (await api('/api/conversation/reset', { ...json({ conversationId: group }), signal: own.signal })).json();
    if (!valid()) return;
    if (Number.isInteger(data.revision) && data.revision >= 0) revision = Math.max(revision, data.revision);
    conversationRequestRevision = revision + 1;
    status('聞き取りを続けています。調べたい人物の名前や所属を、もう一度話してください。');
    await sendView('もう一度話してください', '名前や所属を言い直してください', '音声は再送しません');
  } catch (error) {
    if (valid()) { await stopRecording(false); reportVoiceError(error instanceof Error ? error.message : '対象をリセットできませんでした。会話モードを再開してください。'); }
  } finally {
    if (subjectGeneration === conversationSubjectGeneration) { resettingConversation = false; audioBusy = false; }
    if (controller === own) controller = null;
    refreshControls();
  }
}
async function chooseSearchCandidate(choiceId: string) {
  if (choosingSearch || resettingConversation || !conversationRunning || !conversationId || !token || document.hidden || pageLeaving) return;
  const choice = searchCandidates.find(candidate => candidate.id === choiceId); if (!choice) return;
  const group = conversationId; const generation = audioGeneration; const subjectGeneration = ++conversationSubjectGeneration;
  choosingSearch = true; resettingConversation = true; transcriptDrainId++; identifyingTranscript = false;
  for (const itemId of partialTranscripts.keys()) ignoredTranscriptItems.add(itemId);
  if (pendingTranscript) ignoredTranscriptItems.add(pendingTranscript.itemId);
  while (ignoredTranscriptItems.size > 64) ignoredTranscriptItems.delete(ignoredTranscriptItems.values().next().value!);
  pendingTranscript = null; partialTranscripts.clear(); completedTranscript = ''; voicePreview = '';
  identifyController?.abort(); identifyController = null; identifyingRequest = null;
  controller?.abort(); running = false; audioBusy = true;
  currentId = crypto.randomUUID(); newViewToken(); clearResult(); currentSearch = '';
  const own = new AbortController(); controller = own;
  const valid = () => generation === audioGeneration && subjectGeneration === conversationSubjectGeneration && conversationRunning && conversationId === group && !own.signal.aborted && !!token && !document.hidden && !pageLeaving;
  renderSearchCandidates(); status(`検索候補「${choice.query}」へ切り替えています。`); refreshControls();
  try {
    const data = await (await api('/api/conversation/search-choice', { ...json({ conversationId: group, choiceId }), signal: own.signal })).json();
    if (!valid()) return;
    const target = TargetSchema.parse(data.target);
    if (typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.requestId) || !Number.isSafeInteger(data.subjectRevision) || data.subjectRevision <= revision || typeof data.query !== 'string' || data.query.length > 300) throw new Error('検索候補の応答を確認できませんでした。');
    revision = data.subjectRevision - 1;
    conversationLastKey = `${target.companyName}|${target.personName}`.normalize('NFKC').replace(/\s+/g, '').toLowerCase(); conversationLastAt = Date.now();
    $<HTMLTextAreaElement>('text').value = data.query;
    resettingConversation = false; audioBusy = false; controller = null;
    await research(undefined, data.requestId, group);
  } catch (error) {
    if (valid()) { status(error instanceof Error ? error.message : '検索候補を変更できませんでした。', true); void sendView('候補を選び直してください', '変更を完了できませんでした', '音声認識は継続中'); }
  } finally {
    if (subjectGeneration === conversationSubjectGeneration) { resettingConversation = false; audioBusy = false; choosingSearch = false; }
    if (controller === own) controller = null;
    renderSearchCandidates(); refreshControls();
  }
}
async function startQrConversation() {
  if (!qrAutoStartPending) return;
  // Consume this verified QR launch once. Stop/background/logout invalidates
  // the generation while G2 and ASR are preparing; never re-arm on reconnect.
  qrAutoStartPending = false;
  if (!token || document.hidden || pageLeaving) return;
  if (!runtimeStatus.liveEnabled || !runtimeStatus.streamingEnabled) {
    status('音声認識の設定を確認できません。会話モードを自動開始できませんでした。', true); return;
  }
  status('QRでログインしました。G2接続後に音声認識を自動開始します。');
  if (!connected && !await prepareGlassesMicrophone()) return;
  await startConversation();
}
async function startConversation() {
  if (!token || document.hidden || pageLeaving) return;
  if (stoppingAudio) {
    const generation = audioGeneration;
    try { await stoppingAudio; } catch { return; }
    if (generation !== audioGeneration || !token || document.hidden || pageLeaving) return;
    return startConversation();
  }
  if (!runtimeStatus.streamingEnabled || $<HTMLSelectElement>('mode').value !== 'live' || running || recording || audioBusy || conversationRunning || microphoneConnecting) return;
  if ($<HTMLSelectElement>('microphone').value === 'g2' && !connected) { if (await prepareGlassesMicrophone()) void startConversation(); return; }
  clearSearch();
  const generation = ++audioGeneration; conversationRunning = true; recording = true;
  conversationId = ''; conversationRequestRevision = 0; conversationLastKey = ''; conversationLastAt = 0;
  completedTranscript = ''; partialTranscripts.clear(); pendingTranscript = null; ignoredTranscriptItems.clear(); resettingConversation = false; conversationSubjectGeneration++;
  $('correction-hint').textContent = ''; $('correction-hint').classList.add('hidden');
  audioSource = $<HTMLSelectElement>('microphone').value === 'g2' ? 'g2' : 'phone'; currentId = crypto.randomUUID(); newViewToken(); clearResult();
  const source = audioSource;
  setVoicePhase('connecting');
  const stream = new StreamingAudio({
    onDelta: (itemId, delta) => {
      if (generation !== audioGeneration || !conversationRunning) return;
      if (resettingConversation) { if (ignoredTranscriptItems.size < 64) ignoredTranscriptItems.add(itemId); return; }
      if (ignoredTranscriptItems.has(itemId)) return;
      if (!partialTranscripts.has(itemId) && partialTranscripts.size >= 8) partialTranscripts.delete(partialTranscripts.keys().next().value!);
      partialTranscripts.set(itemId, ((partialTranscripts.get(itemId) ?? '') + delta).slice(-2000));
      voicePreview = partialTranscripts.get(itemId)!; queueVoiceDisplay();
      $<HTMLTextAreaElement>('text').value = `${completedTranscript}\n${[...partialTranscripts.values()].join(' ')}`.trim().slice(-2000);
    },
    onFinal: (itemId, text) => {
      if (generation !== audioGeneration || !conversationRunning || !text.trim() || resettingConversation || ignoredTranscriptItems.has(itemId)) return;
      partialTranscripts.delete(itemId); completedTranscript = `${completedTranscript}\n${text}`.trim().slice(-1200);
      voicePreview = text; queueVoiceDisplay();
      $<HTMLTextAreaElement>('text').value = completedTranscript;
      if (!lockedPerson && !choosingSearch) { pendingTranscript = { itemId, text: text.slice(0, 2000) }; void drainTranscripts(generation); }
    },
    onError: error => { if (generation === audioGeneration) { void stopRecording(false); reportVoiceError(error.message); } },
    onClose: () => { if (generation === audioGeneration && conversationRunning) { void stopRecording(false); reportVoiceError('音声接続が終了しました。会話モードを再開してください。'); } },
  });
  conversation = stream;
  const valid = () => generation === audioGeneration && conversationRunning && recording && conversation === stream
    && !!token && !document.hidden && !pageLeaving;
  status('音声認識を準備しています。準備完了後に話してください。'); refreshControls();
  try {
    const setup = api('/api/conversation', json({})).then(response => response.json()); void setup.catch(() => {});
    // iPhone permission requires a tap-time phone start. Its preparation PCM is
    // discarded by StreamingAudio; the G2 microphone waits for ASR readiness.
    const microphone = source === 'phone' ? phone.start({ continuous: true }) : Promise.resolve(true);
    const [group, opened] = await Promise.all([setup, microphone]);
    if (!valid()) return;
    if (!opened || typeof group.conversationId !== 'string') throw new Error('マイクを開始できませんでした。接続と許可を確認してください。');
    conversationId = group.conversationId;
    const ticketResponse = await api('/api/conversation/stream', json({ conversationId }));
    const ticket = await ticketResponse.json(); if (!valid()) return;
    const ready = await stream.start(ticket.ticket); if (!valid()) return;
    if (!ready) throw new Error('音声接続の準備を完了できませんでした。');
    if (source === 'g2') {
      status('音声認識の準備ができました。G2のマイクを開始しています…');
      const microphoneReady = await g2.startAudio({ continuous: true });
      if (!valid()) return;
      if (!microphoneReady) throw new Error('G2のマイクを開始できませんでした。接続と許可を確認してください。');
    }
    setVoicePhase('listening'); refreshControls();
    status('ストリーミング認識中です。話している途中から文字が表示され、人物名を見つけたら公開情報を調べます。');
    await sendView('会話モード', '音声をストリーミング認識中', '終了はスマートフォンから');
  } catch (error) { if (generation === audioGeneration) { await stopRecording(false); reportVoiceError(error instanceof Error ? error.message : '会話モードを開始できませんでした。'); } }
}
async function startRecording() {
  if (!runtimeStatus.sttEnabled || $<HTMLSelectElement>('mode').value !== 'live' || running || audioBusy || microphoneConnecting) return;
  if ($<HTMLSelectElement>('microphone').value === 'g2' && !connected) { if (await prepareGlassesMicrophone()) void startRecording(); return; }
  setVoicePhase('off');
  const generation = ++audioGeneration;
  audioSource = $<HTMLSelectElement>('microphone').value === 'g2' ? 'g2' : 'phone'; audioChunks = []; audioBytes = 0; recording = true; currentId = crypto.randomUUID();
  newViewToken(); clearResult(); void sendView('これで誰でも雑談マスター', '録音中・最大30秒', '停止はスマートフォンから'); status('録音しています。30秒以内に停止します。'); refreshControls();
  const ok = audioSource === 'g2' ? await g2.startAudio() : await phone.start();
  if (generation !== audioGeneration) return;
  if (!ok || !recording) { await stopRecording(false); status('録音を開始できませんでした。接続とマイクの許可を確認してください。', true); return; }
  audioTimer = setTimeout(() => { void stopRecording(true); }, 30_000);
}
async function stopRecording(transcribe: boolean) {
  if (!transcribe) {
    abortConversation();
    audioGeneration++; recording = false; audioBusy = false; clearTimeout(audioTimer);
    audioChunks = []; audioBytes = 0;
    const pending = audioSource === 'g2' ? g2.stopAudio() : phone.stop();
    stoppingAudio = pending;
    try { await pending; } finally { if (stoppingAudio === pending) stoppingAudio = null; refreshControls(); }
    return;
  }
  if (!recording) return;
  const generation = audioGeneration;
  recording = false; audioBusy = true; clearTimeout(audioTimer);
  const chunks = audioChunks; audioChunks = []; audioBytes = 0; const id = currentId;
  const valid = () => generation === audioGeneration && id === currentId && !!token && !document.hidden;
  refreshControls();
  await (audioSource === 'g2' ? g2.stopAudio() : phone.stop());
  const canTranscribe = valid();
  if (!canTranscribe || !chunks.length) {
    if (canTranscribe && !chunks.length) status('音声を取得できませんでした。マイクの許可と接続を確認して、もう一度録音してください。', true);
    chunks.length = 0; if (generation === audioGeneration) { audioBusy = false; refreshControls(); } return;
  }
  controller = new AbortController(); const own = controller; status('音声を文字に変換しています…');
  try {
    const wav = pcmToWav(chunks); chunks.length = 0;
    if (!valid()) return;
    const response = await api('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Request-Id': id, 'X-Subject-Revision': String(revision + 1) }, body: new Blob([wav as BlobPart], { type: 'audio/wav' }), signal: own.signal });
    const data = await response.json();
    if (!valid() || own.signal.aborted) return;
    $<HTMLTextAreaElement>('text').value = data.text; audioBusy = false; controller = null; await research(undefined, id);
  } catch (error) { if (valid() && !own.signal.aborted) status(error instanceof Error ? error.message : '文字起こしに失敗しました。', true); }
  finally { chunks.length = 0; if (controller === own) controller = null; if (generation === audioGeneration) audioBusy = false; refreshControls(); }
}
$('login-form').onsubmit = event => { event.preventDefault(); void login(); };
$('sample').onclick = () => { $<HTMLTextAreaElement>('text').value = DEMO_TEXT; };
$('research').onclick = () => { void research(); }; $('cancel').onclick = () => { void cancel(); };
$('previous').onclick = () => { cardIndex--; renderCard(); }; $('next').onclick = () => { cardIndex++; renderCard(); };
async function connectGlasses() {
  if (glassesConnecting) return glassesConnecting;
  // A second connect must not repaint the listening screen with an idle view.
  if (connected) return true;
  const generation = audioGeneration; const expectedToken = token;
  const pending = (async () => {
    const ok = await g2.connect({ header: 'これで誰でも雑談マスター',
      content: microphoneConnecting ? 'G2接続後に音声認識を準備します。' : '登録は不要です。会話モードを開始してください。',
      footer: microphoneConnecting ? 'G2マイクの接続準備中' : 'マイクは停止中' }, viewToken);
    if (generation !== audioGeneration || token !== expectedToken || document.hidden || pageLeaving) return false;
    if (ok && !recording) $<HTMLSelectElement>('microphone').value = 'g2';
    if (!ok) status('Evenアプリからこの画面を開いて接続してください。通常のブラウザーではプレビューを利用できます。', true);
    return ok;
  })();
  glassesConnecting = pending;
  try { return await pending; } finally { if (glassesConnecting === pending) glassesConnecting = null; }
}
async function prepareGlassesMicrophone() {
  const generation = audioGeneration; const expectedToken = token;
  microphoneConnecting = true; status('G2のマイクへ接続しています…'); refreshControls();
  const valid = () => generation === audioGeneration && !!token && token === expectedToken && !document.hidden && !pageLeaving;
  try {
    const ok = await connectGlasses();
    if (!valid()) return false;
    if (!ok) reportVoiceError('G2のマイクに接続できません。Evenアプリ内で開き、グラスの接続を確認してください。');
    return ok && connected;
  } catch {
    if (valid()) reportVoiceError('G2のマイクへ接続できませんでした。Evenアプリとグラスの接続を確認してください。');
    return false;
  } finally { microphoneConnecting = false; refreshControls(); }
}
$('connect').onclick = () => { void connectGlasses(); };
$('conversation').onclick = () => { void startConversation(); };
$('retry-listening').onclick = () => { void retryConversation(); };
$('lock-person').onclick = () => { if (lockedPerson) void retryConversation(); else lockCurrentPerson(); };
$('record').onclick = () => { if (conversationRunning) void cancel(); else if (recording) void stopRecording(true); else void startRecording(); };
$('mode').onchange = () => { currentId = crypto.randomUUID(); newViewToken(); clearResult(); void sendView('これで誰でも雑談マスター', '調査を開始してください。', 'マイクは停止中'); const demo = $<HTMLSelectElement>('mode').value === 'demo'; $('scenario-field').classList.toggle('hidden', !demo); $('mode-badge').textContent = demo ? '体験デモ · 架空の人物・固定データ' : '実API · 公開情報を調査'; $('hud-mode').textContent = demo ? 'DEMO / FICTIONAL DATA' : 'LIVE / PUBLIC SOURCES'; $('result-note').textContent = demo ? '体験デモでは外部APIに通信せず、架空の人物・会社の固定資料を使います。' : '個人の非公開情報は調査しません。情報が曖昧な場合は確認を求めます。'; refreshControls(); };
$('resume').onclick = async () => {
  if (running || recording || audioBusy) return;
  const expectedToken = token; const expectedView = viewToken;
  try {
    const data = await (await api('/api/session/resume', json({}))).json();
    if (!token || token !== expectedToken || viewToken !== expectedView || running || recording || audioBusy || document.hidden) return;
    $('resume-notice').classList.add('hidden');
    if (data.result) {
      const resumed = parseResearchResult(data.result);
      if (data.input) { lastInput = ResearchInputSchema.parse(data.input); $<HTMLTextAreaElement>('text').value = lastInput.text; $<HTMLSelectElement>('scenario').value = lastInput.scenario; }
      $<HTMLSelectElement>('mode').value = resumed.mode; $('mode').dispatchEvent(new Event('change'));
      currentId = resumed.requestId; newViewToken(); showResult(resumed); $('trace').replaceChildren(); for (const event of resumed.trace) addTrace(event);
    } else status('再表示できる有効なカードはありません。必要なら再調査してください。');
  } catch (e) { if (token === expectedToken && viewToken === expectedView) { const failure = researchFailure(e); status(`${failure.message} ${failure.action}`); } }
};
$('end').onclick = async () => { if (authBusy) return; setAuthBusy(true); authGeneration++; await cancel(); try { await api('/api/session/forget', json({})); token = ''; expiresAt = 0; clearConversation(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden'); $('login-status').textContent = '会話データと、この端末のログインの記憶を削除しました。'; } catch (e) { status(e instanceof Error ? e.message : '削除を確認できませんでした。'); } finally { setAuthBusy(false); } };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { void cancel(); }
  else if (!token && qrLoginTicket && runtimeStatus && !authBusy && !pageLeaving) { void redeemQrLogin(); }
});
window.addEventListener('pagehide', () => { pageLeaving = true; qrLoginTicket = ''; abortConversation(); clearTimeout(voiceDisplayTimer); voiceDisplayTimer = undefined; voicePreview = ''; authGeneration++; audioGeneration++; recording = false; audioBusy = false; clearTimeout(audioTimer); audioChunks = []; controller?.abort(); void phone.stop(); void g2.dispose(); });
setInterval(() => { void keepConversationAlive(); }, 60_000);
setInterval(() => { if (result?.cards.some(card => Date.parse(card.expiresAt) <= Date.now())) renderCard(); if (token && expiresAt > 0 && expiresAt <= Date.now()) void expireSession(); }, 15_000);
try {
  runtimeStatus = await (await fetch('/api/status', { cache: 'no-store' })).json();
  $('live-option').toggleAttribute('disabled', !runtimeStatus.liveEnabled); $('configuration').textContent = runtimeStatus.liveEnabled ? '実APIでの調査を利用できます。課金額は設定した上限内で予約します。' : `未設定：${runtimeStatus.missing.join('、')}`;
  if (runtimeStatus.streamingEnabled || runtimeStatus.sttEnabled) $('audio-hint').textContent = 'G2のマイクを使えます。接続できない場合もスマホへ自動では切り替えません。';
  $('login').classList.remove('hidden');
  // Auto-capture requires successful redemption of this QR, even when a
  // remembered login exists. A query parameter alone is not a start request.
  if (qrConversationEntry) await redeemQrLogin();
  else if (!runtimeStatus.accessCodeRequired) { $('access-code').classList.add('hidden'); document.querySelector('label[for="access-code"]')?.classList.add('hidden'); await login(); }
  else if (await restoreLogin()) { qrLoginTicket = ''; } else await redeemQrLogin();
} catch { $('login').classList.remove('hidden'); $('login-status').textContent = 'サーバーに接続できません。再読み込みしてください。'; }
