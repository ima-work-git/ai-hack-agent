import './style.css';
import { ResearchInputSchema, ResearchResultSchema, type Card, type ResearchInput, type ResearchResult, type RuntimeStatus, type TraceEvent, type Scenario } from './shared/contracts.ts';
import { G2Runtime, type G2Status, type GlassesView } from './integrations/g2-runtime.ts';
import { PhoneAudio } from './phone-audio.ts';
import { StreamingAudio } from './streaming-audio.ts';
import { verifiedAliasForTarget } from './shared/identity-aliases.ts';
import { TargetSchema } from './shared/contracts.ts';
import { pcmToWav } from './audio.ts';

// A short-lived QR grant is read once, then removed before any API request.
let qrLoginTicket = new URLSearchParams(window.location.hash.slice(1)).get('login') || '';
const conversationLaunch = new URLSearchParams(window.location.search).get('conversation') === '1';
if (new URLSearchParams(window.location.hash.slice(1)).has('login')) {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
let pageLeaving = false;

const DEMO_TEXT = '架空・みなもデザイン株式会社の星野あおいさんについて調べたい。';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BOARD_MARKUP = Array.from({ length: 4 }, (_, index) => `<button type="button" class="topic-card empty" id="topic-${index}" disabled aria-label="${index + 1}件目は未確認"><span class="topic-number">${index + 1} / 未確認</span><span class="topic-row"><span class="topic-caption">事実</span><span class="topic-fact"${index === 0 ? ' id="fact"' : ''}>未確認</span></span><span class="topic-row"><span class="topic-caption">質問</span><span class="topic-question"${index === 0 ? ' id="question"' : ''}>確認後に表示</span></span></button>`).join('');
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="masthead"><div class="wordmark"><span class="mark" aria-hidden="true">◌</span><div><div class="eyebrow">AI HACK · EVEN G2</div><h1>これで誰でも雑談マスター</h1></div></div><span class="pill" id="connection">スマートフォン表示</span></header>
<section class="panel login hidden" id="login"><div class="eyebrow">WELCOME BACK</div><h2>セッションを始める</h2><p class="muted">会話のデータは最長15分で削除されます。再開時もマイクは自動で起動しません。</p><form id="login-form"><label for="access-code">利用コード</label><input type="password" id="access-code" autocomplete="current-password" minlength="16"><label class="check"><input id="remember-device" type="checkbox" checked><span>この端末では12時間、利用コードの入力を省略する</span></label><div class="controls"><button class="primary" type="submit">開始する</button></div><p class="status" id="login-status" role="status"></p></form></section>
<main class="workspace hidden" id="workspace"><div class="intro"><div><div class="eyebrow">LESS SEARCHING, MORE CONVERSATION</div><h1>目の前の会話に、次のきっかけを。</h1><p>公開情報の調査と根拠の確認を、エージェントに任せる。</p></div><span class="mode-badge" id="mode-badge">体験デモ · 架空の人物・固定データ</span></div>
<div class="notice hidden" id="resume-notice">前のセッションがあります。内容を表示するには、再開してください。<div class="controls"><button id="resume">前の内容を再開</button></div></div>
<div class="grid"><div><section class="panel"><div class="section-head"><h2>会話から調べる</h2><span class="section-number">01 / INPUT</span></div><p class="muted">氏名と会社名を手がかりに、公開情報を確認します。</p>
<div class="field-row"><div><label for="mode">利用モード</label><select id="mode"><option value="demo">体験デモ</option><option value="live" id="live-option" disabled>実APIで調査</option></select></div><div id="scenario-field"><label for="scenario">確認する場面</label><select id="scenario"><option value="normal">通常・自律的な追加調査</option><option value="ambiguous">同姓同名・候補を確認</option><option value="failure">検索障害・一部の根拠を表示</option><option value="no_evidence">根拠なし・推測せず終了</option></select></div></div>
<label for="text">人物名（会社名は任意）、または会話の文字起こし</label><p class="muted">事前登録・入力は不要です。会話モードを開始すると、会話から人物を見つけ、会社名などの手がかりも使って調べます。</p><textarea id="text" maxlength="2000" placeholder="会話モードでは自動で文字が入ります。手入力もできます。" spellcheck="false"></textarea>
<div class="controls"><button id="sample">架空の会話を入力</button><button id="connect">G2を接続</button></div>
<label class="check"><input id="consent" type="checkbox"><span>音声を使う前に、会話相手へ説明し同意を得ました。会話モードは音声をOpenAIへ逐次送信して認識し、OrcaRouterで調査します。音声は保存しません。短い録音は最大30秒です。</span></label>
<label for="microphone">使うマイク</label><select id="microphone"><option value="g2" ${conversationLaunch ? 'selected' : ''}>Even G2のマイク</option><option value="phone" ${conversationLaunch ? '' : 'selected'}>スマートフォンのマイク</option></select>
<div class="controls"><button id="conversation" disabled>会話モードを開始</button><button id="record" disabled>短く録音して調べる</button><span class="muted" id="audio-hint">音声入力は実APIの設定後に使えます</span></div>
<div class="controls"><button id="research" class="primary">調査を始める →</button><button id="cancel" disabled>中止</button><button id="end" class="danger">終了して削除</button></div><p class="muted">「終了して削除」で、この端末のログインの記憶も解除します。</p><p class="status" id="status" role="status" aria-live="polite">架空の会話を入力すると、調査の流れを体験できます。</p><div id="candidates" class="candidates"></div>
</section><section class="panel"><div class="section-head"><h2>エージェントの判断</h2><span class="section-number">02 / PROCESS</span></div><p id="trace-empty" class="empty-trace">調査中の判断と復旧の記録がここに表示されます。</p><ol id="trace" class="trace" aria-label="調査の処理履歴"></ol><details><summary>実APIの設定状況</summary><p class="muted" id="configuration"></p><p class="muted">APIキーと費用上限はサーバー側で設定します。</p></details></section></div>
<div><div class="section-head"><h2>調査結果と質問 · 4件一覧</h2><span class="section-number">03 / INSIGHT</span></div><div class="device"><span class="dot" id="device-dot"></span><span id="device-status">Even G2 · 画面プレビュー</span></div><section class="hud" aria-label="4件の調査結果と質問"><div class="hud-top"><span id="hud-mode">DEMO / FICTIONAL DATA</span><span id="hud-target">WAITING</span></div><div class="topic-board" id="card-board">${BOARD_MARKUP}</div><div class="hud-foot"><span id="hud-source">各カードを押すと原文・出典を表示</span><span id="hud-expiry">0 / 4件確認</span></div></section><nav class="card-nav" aria-label="出典詳細の選択"><button id="previous" aria-label="前の出典" disabled>← 前の出典</button><span id="card-count">0 / 0</span><button id="next" aria-label="次の出典" disabled>次の出典 →</button></nav>
<div class="notice" id="result-note">体験デモでは外部APIに通信せず、架空の人物・会社の固定資料を使います。</div><div class="metrics"><div class="metric"><strong id="metric-time">—</strong><span>調査にかかった時間</span></div><div class="metric"><strong id="metric-calls">—</strong><span>AI / 検索 / 本文</span></div><div class="metric"><strong id="metric-cost">—</strong><span id="cost-label">実費は未計測</span></div></div><section class="panel evidence-panel"><div class="section-head"><h2>情報の根拠</h2><span class="section-number">04 / EVIDENCE</span></div><p class="muted" id="source-empty">本文の引用・出典・取得時刻を、カードごとに確認できます。</p><div id="sources"></div></section></div></div></main>
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
let lastInput: ResearchInput | null = null;
let running = false;
let controller: AbortController | null = null;
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
let conversation: StreamingAudio | null = null;
let pendingTranscript: { itemId: string; text: string } | null = null;
let identifyingTranscript = false;
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
let voiceDisplayTimer: ReturnType<typeof setTimeout> | undefined;
const emptyGlassesView = (): GlassesView => ({ header: 'これで誰でも雑談マスター', content: '会話を待っています', footer: 'マイクは停止中' });
let glassesView = emptyGlassesView();

const status = (text: string, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
function refreshControls() {
  $('research').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning);
  $('cancel').toggleAttribute('disabled', !running && !recording && !audioBusy && !microphoneConnecting);
  $('microphone').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning || microphoneConnecting);
  $('mode').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning);
  $('scenario').toggleAttribute('disabled', running || recording || audioBusy || conversationRunning);
  $('record').toggleAttribute('disabled', !recording && (microphoneConnecting || audioBusy || running || !runtimeStatus?.sttEnabled || ($<HTMLSelectElement>('mode').value !== 'live') || !$<HTMLInputElement>('consent').checked));
  $('conversation').toggleAttribute('disabled', microphoneConnecting || recording || audioBusy || running || conversationRunning || !runtimeStatus?.streamingEnabled || ($<HTMLSelectElement>('mode').value !== 'live') || !$<HTMLInputElement>('consent').checked);
  $('record').textContent = recording ? conversationRunning ? '会話モードを終了' : '録音を止めて調べる' : '音声で入力';
  if (voicePhase !== 'off') queueVoiceDisplay();
}
function newViewToken() { viewToken = `${currentId}:${revision}`; glassesView = emptyGlassesView(); g2?.invalidateViews(viewToken); }
// Count wide characters conservatively and preserve complete Unicode characters.
function shortText(text: string, maximumWidth: number): string {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  const width = (character: string) => /^[\x20-\x7e]$/.test(character) ? 1 : 2;
  if (characters.reduce((total, character) => total + width(character), 0) <= maximumWidth) return characters.join('');
  let used = 0; let clipped = '';
  for (const character of characters) { if (used + width(character) > maximumWidth - 2) break; clipped += character; used += width(character); }
  return `${clipped}…`;
}
function renderBoard(cards: Card[]) {
  for (let index = 0; index < 4; index++) {
    const slot = $<HTMLButtonElement>(`topic-${index}`); const card = cards[index];
    slot.disabled = !card; slot.classList.toggle('empty', !card); slot.classList.toggle('selected', !!card && index === cardIndex);
    slot.setAttribute('aria-pressed', String(!!card && index === cardIndex));
    slot.setAttribute('aria-label', card ? `${index + 1}件目の原文と出典を表示` : `${index + 1}件目は未確認`);
    slot.querySelector('.topic-number')!.textContent = `${index + 1} / ${card ? '原文・出典 ↗' : '未確認'}`;
    slot.querySelector('.topic-fact')!.textContent = card ? card.displayFact || card.fact : '未確認';
    slot.querySelector('.topic-question')!.textContent = card ? card.displayQuestion || card.suggestedQuestion : '確認後に表示';
    slot.onclick = card ? () => { cardIndex = index; renderCard(); } : null;
  }
}
function clearResult() {
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
      connecting: `${source} 音声接続中`, listening: `${source} 聞取${running || audioBusy ? '・調査' : ''}中`,
      paused: '音声一時停止・スマホで確認', stopped: '音声停止', error: '音声エラー・スマホで再開',
    };
    footer = labels[voicePhase];
    if (voicePhase === 'listening') {
      const latest = Array.from(voicePreview.replace(/\s+/g, ' ').trim()).slice(-16).join('');
      footer += latest ? `｜${latest}` : '｜発話待ち';
    }
    footer = shortText(footer, 46);
  }
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
function renderCard() {
  const cards = result?.cards.filter(c => Date.parse(c.expiresAt) > Date.now()).slice(0, 4) || [];
  if (!cards.length) {
    if (result?.cards.length) { clearResult(); status('カードの有効期限が切れました。必要なら再調査してください。'); void sendView('これで誰でも雑談マスター', 'カードの有効期限が切れました。', '再調査してください'); }
    return;
  }
  cardIndex = (cardIndex + cards.length) % cards.length;
  const card = cards[cardIndex]!;
  const source = result!.sources.find(s => s.sourceId === card.sourceId)!;
  renderBoard(cards);
  $('hud-target').textContent = result!.target?.personName || '';
  $('hud-source').textContent = '短い事実と質問 / 原文・出典はカードを選択';
  $('hud-expiry').textContent = `${cards.length} / 4件確認`;
  $('card-count').textContent = `${cardIndex + 1} / ${cards.length}`;
  $('previous').toggleAttribute('disabled', cards.length < 2); $('next').toggleAttribute('disabled', cards.length < 2);
  $('sources').replaceChildren(); $('source-empty').classList.add('hidden');
  const evidence = document.createElement('div'); evidence.className = 'source';
  const title = document.createElement('h3'); title.textContent = source.title;
  const fullFact = document.createElement('p'); fullFact.className = 'source-fact'; fullFact.textContent = `事実（全文）：${card.fact}`;
  const fullQuestion = document.createElement('p'); fullQuestion.textContent = `質問の提案：${card.suggestedQuestion}`;
  const quote = document.createElement('blockquote'); quote.textContent = card.excerpt;
  const date = document.createElement('p'); date.className = 'muted'; date.textContent = `取得：${new Date(source.retrievedAt).toLocaleString('ja-JP')}`;
  const expiry = document.createElement('p'); expiry.className = 'muted'; expiry.textContent = `有効期限：${new Date(card.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  evidence.append(title, fullFact, fullQuestion, quote, date, expiry);
  if (source.kind !== 'fixture' && /^https?:\/\//.test(source.url)) { const link = document.createElement('a'); link.href = source.url; link.textContent = '出典を開く ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer'; evidence.append(link); }
  $('sources').append(evidence);
  const rows = Array.from({ length: 4 }, (_, index) => {
    const entry = cards[index];
    return entry ? `${index + 1} 事:${(entry.displayFact || entry.fact).replace(/\s+/g, ' ')} 問:${(entry.displayQuestion || entry.suggestedQuestion).replace(/\s+/g, ' ')}` : `${index + 1} 事:未確認 問:—`;
  });
  void sendView(`${result!.mode === 'demo' ? '[架空] ' : ''}${shortText(result!.target?.personName || '', 28)} ${cards.length}/4件`, rows.join('\n'), '事=事実 問=質問 / 原文はスマホ');
}
function addTrace(event: TraceEvent) {
  if ($('trace').children.length >= 60) return;
  $('trace-empty').classList.add('hidden');
  const li = document.createElement('li'); const time = document.createElement('time'); time.textContent = new Date(event.at).toLocaleTimeString('ja-JP');
  li.append(time, document.createTextNode(event.message)); $('trace').append(li); $('trace').scrollTop = $('trace').scrollHeight;
}
function showResult(value: ResearchResult) {
  result = value; cardIndex = 0; status(value.message);
  $('result-note').textContent = value.mode === 'demo' ? '架空の人物・固定資料によるデモです。表示の動作確認であり、実APIやG2実機の動作証明ではありません。' : value.message;
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
    void sendView(value.status === 'awaiting_confirmation' ? '相手の確認が必要です' : '確認できた情報はありません',
      Array.from({ length: 4 }, (_, index) => `${index + 1} 事:未確認 問:—`).join('\n'), 'スマートフォンで確認');
  }
  renderCard();
}
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const sentToken = token; const sentGeneration = authGeneration;
  const headers = new Headers(init.headers); if (sentToken) headers.set('Authorization', `Bearer ${sentToken}`);
  const response = await fetch(path, { ...init, headers, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) { const body = await response.json().catch(() => ({})); if (response.status === 401 && token === sentToken && authGeneration === sentGeneration) { token = ''; expiresAt = 0; controller?.abort(); controller = null; running = false; currentId = crypto.randomUUID(); newViewToken(); void stopRecording(false); clearConversation(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden'); $('login-status').textContent = 'ログインの有効期限が切れました。再読み込みするか、利用コードで開始してください。'; } throw new Error(body.message || '処理できませんでした。接続・設定・入力を確認してください。'); }
  return response;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function acceptSession(data: { token: string; revision: number; expiresAt: number; hasPrevious: boolean; interrupted: boolean }) {
  token = data.token; revision = data.revision; expiresAt = data.expiresAt;
  $<HTMLInputElement>('access-code').value = ''; $('login').classList.add('hidden'); $('workspace').classList.remove('hidden');
  $<HTMLInputElement>('consent').checked = false;
  $('resume-notice').classList.toggle('hidden', !data.hasPrevious && !data.interrupted);
  if (data.interrupted) status('前の調査が中断されました。マイクは停止しています。必要なら再調査してください。');
  if (conversationLaunch && runtimeStatus.liveEnabled) {
    $<HTMLSelectElement>('mode').value = 'live'; $('mode').dispatchEvent(new Event('change'));
    status('人物・会社の入力は不要です。同意を確認して「会話モードを開始」を押してください。');
    if (!connected) void connectGlasses();
  }
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
    acceptSession(data); status('QRでログインしました。G2を接続して開始できます。'); return true;
  } catch {
    if (generation === authGeneration) $('login-status').textContent = 'このQRは使用済みか期限切れです。接続を確認し、新しいログイン用QRを読み込んでください。';
    return false;
  } finally { clearTimeout(timeout); setAuthBusy(false); }
}
function clearConversation() {
  clearResult(); lastInput = null; $<HTMLTextAreaElement>('text').value = '';
  $('trace').replaceChildren(); $('trace-empty').classList.remove('hidden');
  $('resume-notice').classList.add('hidden'); $<HTMLInputElement>('consent').checked = false;
}
async function expireSession() {
  const generation = ++authGeneration; expiresAt = 0;
  await cancel(); if (generation !== authGeneration) return;
  token = ''; clearConversation(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden');
  $('login-status').textContent = '15分経過したため会話データを削除しました。';
  if (await restoreLogin()) status('前の会話データを削除し、新しいセッションを開始しました。マイクは停止しています。');
}
async function research(selectedCandidateId?: string, preparedId?: string, activeConversationId?: string) {
  const text = $<HTMLTextAreaElement>('text').value.trim(); if (!text) { status('人物名、または会話を入力してください。'); return; }
  if (running || recording && !activeConversationId || audioBusy || !token) return;
  $('resume-notice').classList.add('hidden');
  currentId = preparedId || crypto.randomUUID(); revision += 1; newViewToken(); clearResult();
  $('trace').replaceChildren(); $('trace-empty').classList.remove('hidden');
  running = true; refreshControls(); controller = new AbortController(); const ownController = controller; const ownId = currentId;
  const input: ResearchInput = { text, requestId: ownId, subjectRevision: revision, mode: $<HTMLSelectElement>('mode').value as 'demo' | 'live', scenario: $<HTMLSelectElement>('scenario').value as Scenario, ...(selectedCandidateId ? { selectedCandidateId } : {}), ...(activeConversationId ? { conversationId: activeConversationId } : {}) };
  lastInput = input; status('公開情報を調べています…'); await sendView('これで誰でも雑談マスター', '公開情報を調査中…', '中止はスマートフォンから');
  let gotResult = false;
  try {
    const response = await api('/api/research', { ...json(input), signal: ownController.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffered = ''; let bytes = 0;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (currentId !== ownId || ownController.signal.aborted) { await reader.cancel(); break; }
      bytes += chunk.value.length; if (bytes > 1_000_000) { await reader.cancel(); throw new Error('応答のサイズが上限を超えました。'); }
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split('\n'); buffered = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue; const message = JSON.parse(line);
        if (message.type === 'trace') addTrace(message.event);
        else if (message.type === 'result') { const parsed = ResearchResultSchema.parse(message.result); if (parsed.requestId === ownId && parsed.subjectRevision === revision) { gotResult = true; showResult(parsed); } }
        else if (message.type === 'error') throw new Error(message.message);
      }
    }
    if (!gotResult && !ownController.signal.aborted) throw new Error('接続が中断されました。再調査してください。');
  } catch (error) { if (currentId === ownId && !ownController.signal.aborted) { status(error instanceof Error ? error.message : '調査を完了できませんでした。', true); await sendView('これで誰でも雑談マスター', '調査を完了できませんでした。', '入力・設定・接続を確認'); } }
  finally { if (controller === ownController) { running = false; controller = null; refreshControls(); } }
}
async function cancel() {
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
  if (recording && audioSource === 'g2' && state.state !== 'recording') { if (conversationRunning) void cancel(); else void stopRecording(state.state === 'connected'); }
  if (['background', 'disconnected', 'error', 'disposed'].includes(state.state)) { currentId = crypto.randomUUID(); newViewToken(); clearResult(); }
}
function acceptAudio(chunk: Uint8Array) {
  if (recording && conversationRunning) { conversation?.append(chunk); return; }
  if (!recording || audioBytes + chunk.length > 960_000) return;
  audioChunks.push(chunk.slice()); audioBytes += chunk.length;
}
g2 = new G2Runtime({ onStatus: g2Status, onAudio: acceptAudio, onAction: action => { if (action === 'next') { cardIndex++; renderCard(); } else if (action === 'previous') { cardIndex--; renderCard(); } else if (action === 'exit') void cancel(); } });
const phone = new PhoneAudio({ onAudio: acceptAudio, onStopped: reason => { if (recording && audioSource === 'phone') { if (conversationRunning) void cancel(); else void stopRecording(reason !== 'error'); } }, onError: message => status(message, true) });
function abortConversation() {
  const wasActive = conversationRunning;
  const group = conversationId;
  const stream = conversation; conversation = null; conversationRunning = false; conversationId = ''; pendingTranscript = null; partialTranscripts.clear(); completedTranscript = ''; stream?.cancel();
  if (wasActive) setVoicePhase('stopped');
  if (group && token) {
    controller?.abort(); controller = null; running = false;
    void api('/api/cancel', json({ requestId: currentId, subjectRevision: conversationRequestRevision || Math.max(1, revision + 1), conversationId: group })).catch(() => {});
  }
}
async function processConversationTranscript(text: string, generation: number) {
  const valid = () => generation === audioGeneration && conversationRunning && !!token && !document.hidden && $<HTMLInputElement>('consent').checked ;
  if (!valid()) return;
  const id = crypto.randomUUID(); currentId = id; conversationRequestRevision = revision + 1;
  const own = new AbortController(); controller = own; audioBusy = true; refreshControls();
  try {
    const response = await api('/api/conversation/identify', { ...json({ text, requestId: id, subjectRevision: conversationRequestRevision, conversationId }), signal: own.signal });
    const data = await response.json(); if (!valid()) return;
    $<HTMLTextAreaElement>('text').value = typeof data.text === 'string' ? data.text : '';
    const parsed = TargetSchema.array().max(3).safeParse(data.targets);
    const targets = parsed.success ? parsed.data : [];
    if (targets.length !== 1) {
      if (targets.length > 1 || data.hasPersonMention !== false) {
        newViewToken(); clearResult();
        await sendView('人物を確認', targets.length > 1 ? '複数の人物が出ています。' : '人物名や所属などを教えてください。', '同じ人として結び付けません');
      }
      status(targets.length > 1 ? '複数の人物が出ています。調べたい人物を一人ずつ話してください。' : '聞き取り中です。人物名が出たら公開情報を調べます。');
      return;
    }
    const target = verifiedAliasForTarget(targets[0]!)?.target ?? targets[0]!;
    const key = `${target.companyName}|${target.personName}`.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    if (conversationLastKey === key && Date.now() - conversationLastAt < (result?.cards.length ? 120_000 : 30_000)) {
      status(`${target.personName}さんの話題を表示しながら聞き取り中です。対象が変わると調べ直します。`); return;
    }
    conversationLastKey = key; conversationLastAt = Date.now();
    $<HTMLTextAreaElement>('text').value = `人物の候補：氏名「${target.personName}」${target.companyName ? `、会社名「${target.companyName}」` : '、所属は未指定'}。本人の公開プロフィールで確認してください。直近の発話：${data.text}`;
    audioBusy = false; if (controller === own) controller = null;
    await research(undefined, id, conversationId);
    if (result?.status === 'awaiting_confirmation' && valid()) {
      const stream = conversation; conversation = null; conversationRunning = false; recording = false; audioBusy = false; audioGeneration++; pendingTranscript = null; stream?.cancel();
      setVoicePhase('paused');
      await (audioSource === 'g2' ? g2.stopAudio() : phone.stop());
      status('相手の確認のため聞き取りを一時停止しました。候補を選び、会話モードを再開してください。');
    }
    if (result?.reasonCode === 'BUDGET_EXHAUSTED') throw new Error('費用上限に達したため、会話モードを終了しました。');
  } finally { if (controller === own) controller = null; if (generation === audioGeneration) audioBusy = false; refreshControls(); }
}
async function drainTranscripts(generation: number) {
  if (identifyingTranscript) return;
  identifyingTranscript = true;
  try {
    while (pendingTranscript && conversationRunning && generation === audioGeneration) {
      const next = pendingTranscript; pendingTranscript = null;
      await processConversationTranscript(next.text, generation);
    }
  } catch (error) {
    if (generation === audioGeneration && conversationRunning) { await stopRecording(false); setVoicePhase('error'); status(error instanceof Error ? error.message : '会話の調査を続けられませんでした。', true); }
  } finally { identifyingTranscript = false; if (pendingTranscript && conversationRunning) void drainTranscripts(audioGeneration); }
}
async function startConversation() {
  if (!runtimeStatus.streamingEnabled || !$<HTMLInputElement>('consent').checked || $<HTMLSelectElement>('mode').value !== 'live' || running || recording || audioBusy || conversationRunning || microphoneConnecting) return;
  if ($<HTMLSelectElement>('microphone').value === 'g2' && !connected) { if (await prepareGlassesMicrophone()) void startConversation(); return; }
  const generation = ++audioGeneration; conversationRunning = true; recording = true;
  conversationId = ''; conversationRequestRevision = 0; conversationLastKey = ''; conversationLastAt = 0;
  completedTranscript = ''; partialTranscripts.clear(); pendingTranscript = null;
  audioSource = $<HTMLSelectElement>('microphone').value === 'g2' ? 'g2' : 'phone'; currentId = crypto.randomUUID(); newViewToken(); clearResult();
  setVoicePhase('connecting');
  conversation = new StreamingAudio({
    onDelta: (itemId, delta) => {
      if (generation !== audioGeneration || !conversationRunning) return;
      if (!partialTranscripts.has(itemId) && partialTranscripts.size >= 8) partialTranscripts.delete(partialTranscripts.keys().next().value!);
      partialTranscripts.set(itemId, ((partialTranscripts.get(itemId) ?? '') + delta).slice(-2000));
      voicePreview = partialTranscripts.get(itemId)!; queueVoiceDisplay();
      $<HTMLTextAreaElement>('text').value = `${completedTranscript}\n${[...partialTranscripts.values()].join(' ')}`.trim().slice(-2000);
    },
    onFinal: (itemId, text) => {
      if (generation !== audioGeneration || !conversationRunning || !text.trim()) return;
      partialTranscripts.delete(itemId); completedTranscript = `${completedTranscript}\n${text}`.trim().slice(-1200);
      voicePreview = text; queueVoiceDisplay();
      $<HTMLTextAreaElement>('text').value = completedTranscript;
      pendingTranscript = { itemId, text: text.slice(0, 2000) }; void drainTranscripts(generation);
    },
    onError: error => { if (generation === audioGeneration) { void stopRecording(false); setVoicePhase('error'); status(error.message, true); } },
    onClose: () => { if (generation === audioGeneration && conversationRunning) { void stopRecording(false); setVoicePhase('error'); status('音声接続が終了しました。会話モードを再開してください。'); } },
  });
  status('ストリーミング音声認識へ接続しています…'); refreshControls();
  try {
    const setup = api('/api/conversation', json({})).then(response => response.json()); void setup.catch(() => {});
    // Start the microphone within the user's tap for iPhone permission handling.
    const microphone = audioSource === 'g2' ? g2.startAudio({ continuous: true }) : phone.start({ continuous: true });
    const [group, opened] = await Promise.all([setup, microphone]);
    if (generation !== audioGeneration) return;
    if (!opened || !recording || typeof group.conversationId !== 'string') throw new Error('マイクを開始できませんでした。接続と許可を確認してください。');
    conversationId = group.conversationId;
    const ticketResponse = await api('/api/conversation/stream', json({ conversationId }));
    const ticket = await ticketResponse.json(); if (generation !== audioGeneration) return;
    if (!await conversation!.start(ticket.ticket) || generation !== audioGeneration) return;
    setVoicePhase('listening');
    status('ストリーミング認識中です。話している途中から文字が表示され、人物名を見つけたら公開情報を調べます。');
    await sendView('会話モード', '音声をストリーミング認識中', '終了はスマートフォンから');
  } catch (error) { if (generation === audioGeneration) { await stopRecording(false); setVoicePhase('error'); status(error instanceof Error ? error.message : '会話モードを開始できませんでした。', true); } }
}
async function startRecording() {
  if (!runtimeStatus.sttEnabled || !$<HTMLInputElement>('consent').checked || $<HTMLSelectElement>('mode').value !== 'live' || running || audioBusy || microphoneConnecting) return;
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
    await (audioSource === 'g2' ? g2.stopAudio() : phone.stop()); refreshControls(); return;
  }
  if (!recording) return;
  const generation = audioGeneration;
  recording = false; audioBusy = true; clearTimeout(audioTimer);
  const chunks = audioChunks; audioChunks = []; audioBytes = 0; const id = currentId;
  const valid = () => generation === audioGeneration && id === currentId && !!token && !document.hidden && $<HTMLInputElement>('consent').checked;
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
  const ok = await g2.connect({ header: 'これで誰でも雑談マスター', content: '登録は不要です。スマートフォンで同意を確認し、会話モードを開始してください。', footer: 'マイクは停止中' }, viewToken);
  if (ok) $<HTMLSelectElement>('microphone').value = 'g2';
  if (!ok) status('Evenアプリからこの画面を開いて接続してください。通常のブラウザーではプレビューを利用できます。');
  return ok;
}
async function prepareGlassesMicrophone() {
  const generation = audioGeneration; const expectedToken = token;
  microphoneConnecting = true; status('G2のマイクへ接続しています…'); refreshControls();
  try {
    const ok = await connectGlasses();
    if (!ok) status('G2のマイクに接続できません。Evenアプリとグラスの接続を確認してください。スマホを使う場合はマイクを選び直してください。', true);
    return ok && connected && generation === audioGeneration && !!token && token === expectedToken && !document.hidden && !pageLeaving;
  } finally { microphoneConnecting = false; refreshControls(); }
}
$('connect').onclick = () => { void connectGlasses(); };
$('consent').onchange = () => { if (!$<HTMLInputElement>('consent').checked) void stopRecording(false); refreshControls(); };
$('conversation').onclick = () => { void startConversation(); };
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
      const resumed = ResearchResultSchema.parse(data.result);
      if (data.input) { lastInput = ResearchInputSchema.parse(data.input); $<HTMLTextAreaElement>('text').value = lastInput.text; $<HTMLSelectElement>('scenario').value = lastInput.scenario; }
      $<HTMLSelectElement>('mode').value = resumed.mode; $('mode').dispatchEvent(new Event('change'));
      currentId = resumed.requestId; newViewToken(); showResult(resumed); $('trace').replaceChildren(); for (const event of resumed.trace) addTrace(event);
    } else status('再表示できる有効なカードはありません。必要なら再調査してください。');
  } catch (e) { if (token === expectedToken && viewToken === expectedView) status(e instanceof Error ? e.message : '再開できませんでした。'); }
};
$('end').onclick = async () => { if (authBusy) return; setAuthBusy(true); authGeneration++; await cancel(); try { await api('/api/session/forget', json({})); token = ''; expiresAt = 0; clearConversation(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden'); $('login-status').textContent = '会話データと、この端末のログインの記憶を削除しました。'; } catch (e) { status(e instanceof Error ? e.message : '削除を確認できませんでした。'); } finally { setAuthBusy(false); } };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { void cancel(); }
  else if (!token && qrLoginTicket && runtimeStatus && !authBusy && !pageLeaving) { void redeemQrLogin(); }
});
window.addEventListener('pagehide', () => { pageLeaving = true; qrLoginTicket = ''; abortConversation(); clearTimeout(voiceDisplayTimer); voiceDisplayTimer = undefined; voicePreview = ''; authGeneration++; audioGeneration++; recording = false; audioBusy = false; clearTimeout(audioTimer); audioChunks = []; controller?.abort(); void phone.stop(); void g2.dispose(); });
setInterval(() => { if (result?.cards.some(card => Date.parse(card.expiresAt) <= Date.now())) renderCard(); if (token && expiresAt > 0 && expiresAt <= Date.now()) void expireSession(); }, 15_000);
try {
  runtimeStatus = await (await fetch('/api/status', { cache: 'no-store' })).json();
  $('live-option').toggleAttribute('disabled', !runtimeStatus.liveEnabled); $('configuration').textContent = runtimeStatus.liveEnabled ? '実APIでの調査を利用できます。課金額は設定した上限内で予約します。' : `未設定：${runtimeStatus.missing.join('、')}`;
  if (runtimeStatus.streamingEnabled || runtimeStatus.sttEnabled) $('audio-hint').textContent = 'G2のマイクを使えます。接続できない場合もスマホへ自動では切り替えません。';
  $('login').classList.remove('hidden'); if (!runtimeStatus.accessCodeRequired) { $('access-code').classList.add('hidden'); document.querySelector('label[for="access-code"]')?.classList.add('hidden'); await login(); } else if (await restoreLogin()) { qrLoginTicket = ''; } else await redeemQrLogin();
} catch { $('login').classList.remove('hidden'); $('login-status').textContent = 'サーバーに接続できません。再読み込みしてください。'; }
