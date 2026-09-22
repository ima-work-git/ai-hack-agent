import './style.css';
import { ResearchInputSchema, ResearchResultSchema, type ResearchInput, type ResearchResult, type RuntimeStatus, type TraceEvent, type Scenario } from './shared/contracts.ts';
import { G2Runtime, type G2Status } from './integrations/g2-runtime.ts';
import { PhoneAudio } from './phone-audio.ts';
import { pcmToWav } from './audio.ts';

const DEMO_TEXT = '架空・みなもデザイン株式会社の星野あおいさんについて調べたい。';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="masthead"><div class="wordmark"><span class="mark" aria-hidden="true">◌</span><div><div class="eyebrow">AI HACK · EVEN G2</div><h1>会話アシスタント <span class="muted">/ 仮称</span></h1></div></div><span class="pill" id="connection">スマートフォン表示</span></header>
<section class="panel login hidden" id="login"><div class="eyebrow">WELCOME BACK</div><h2>セッションを始める</h2><p class="muted">会話のデータは最長15分で削除されます。再開時もマイクは自動で起動しません。</p><form id="login-form"><label for="access-code">利用コード</label><input type="password" id="access-code" autocomplete="current-password" minlength="16"><div class="controls"><button class="primary" type="submit">開始する</button></div><p class="status" id="login-status" role="status"></p></form></section>
<main class="workspace hidden" id="workspace"><div class="intro"><div><div class="eyebrow">LESS SEARCHING, MORE CONVERSATION</div><h1>目の前の会話に、次のきっかけを。</h1><p>公開情報の調査と根拠の確認を、エージェントに任せる。</p></div><span class="mode-badge" id="mode-badge">体験デモ · 架空の人物・固定データ</span></div>
<div class="notice hidden" id="resume-notice">前のセッションがあります。内容を表示するには、再開してください。<div class="controls"><button id="resume">前の内容を再開</button></div></div>
<div class="grid"><div><section class="panel"><div class="section-head"><h2>会話から調べる</h2><span class="section-number">01 / INPUT</span></div><p class="muted">氏名と会社名を手がかりに、公開情報を確認します。</p>
<div class="field-row"><div><label for="mode">利用モード</label><select id="mode"><option value="demo">体験デモ</option><option value="live" id="live-option" disabled>実APIで調査</option></select></div><div id="scenario-field"><label for="scenario">確認する場面</label><select id="scenario"><option value="normal">通常・自律的な追加調査</option><option value="ambiguous">同姓同名・候補を確認</option><option value="failure">検索障害・一部の根拠を表示</option><option value="no_evidence">根拠なし・推測せず終了</option></select></div></div>
<label for="text">会社名と氏名、または会話の文字起こし</label><textarea id="text" maxlength="2000" placeholder="例：〇〇株式会社の〇〇さんです。" spellcheck="false"></textarea>
<div class="controls"><button id="sample">架空の会話を入力</button><button id="connect">G2を接続</button></div>
<label class="check"><input id="consent" type="checkbox"><span>音声を使う前に、会話相手へ説明し同意を得ました。音声は最大30秒で停止し、文字起こし後に破棄します。</span></label>
<div class="controls"><button id="record" disabled>音声で入力</button><span class="muted" id="audio-hint">音声入力は実APIの設定後に使えます</span></div>
<div class="controls"><button id="research" class="primary">調査を始める →</button><button id="cancel" disabled>中止</button><button id="end" class="danger">終了して削除</button></div><p class="status" id="status" role="status" aria-live="polite">架空の会話を入力すると、調査の流れを体験できます。</p><div id="candidates" class="candidates"></div>
</section><section class="panel"><div class="section-head"><h2>エージェントの判断</h2><span class="section-number">02 / PROCESS</span></div><p id="trace-empty" class="empty-trace">調査中の判断と復旧の記録がここに表示されます。</p><ol id="trace" class="trace" aria-label="調査の処理履歴"></ol><details><summary>実APIの設定状況</summary><p class="muted" id="configuration"></p><p class="muted">APIキーと費用上限はサーバー側で設定します。</p></details></section></div>
<div><div class="section-head"><h2>会話のヒント</h2><span class="section-number">03 / INSIGHT</span></div><div class="device"><span class="dot" id="device-dot"></span><span id="device-status">Even G2 · 画面プレビュー</span></div><section class="hud" aria-label="グラス表示のプレビュー"><div class="hud-top"><span id="hud-mode">DEMO / FICTIONAL DATA</span><span id="hud-target">WAITING</span></div><div class="hud-body"><p class="hud-fact" id="fact">話題は、根拠とともに。</p><p class="hud-question" id="question">会話を入力して調査を始めると、<br>確認した情報と質問のヒントが届きます。</p></div><div class="hud-foot"><span id="hud-source">公開情報だけを調査</span><span id="hud-expiry">MAX 3 CARDS</span></div></section><nav class="card-nav" aria-label="カード切替"><button id="previous" aria-label="前のカード" disabled>←</button><span id="card-count">0 / 0</span><button id="next" aria-label="次のカード" disabled>→</button></nav>
<div class="notice" id="result-note">体験デモでは外部APIに通信せず、架空の人物・会社の固定資料を使います。</div><div class="metrics"><div class="metric"><strong id="metric-time">—</strong><span>調査にかかった時間</span></div><div class="metric"><strong id="metric-calls">—</strong><span>AI / 検索 / 本文</span></div><div class="metric"><strong id="metric-cost">—</strong><span id="cost-label">実費は未計測</span></div></div><section class="panel evidence-panel"><div class="section-head"><h2>情報の根拠</h2><span class="section-number">04 / EVIDENCE</span></div><p class="muted" id="source-empty">本文の引用・出典・取得時刻を、カードごとに確認できます。</p><div id="sources"></div></section></div></div></main>
<footer class="footer"><span>AI HACK 2026 · 業務を自律化するAIエージェント</span><span>人の確認が必要なときは、立ち止まる。</span></footer>`;

let runtimeStatus: RuntimeStatus;
let token = '';
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
let g2: G2Runtime;

const status = (text: string, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
function refreshControls() {
  $('research').toggleAttribute('disabled', running || recording || audioBusy);
  $('cancel').toggleAttribute('disabled', !running && !recording && !audioBusy);
  $('mode').toggleAttribute('disabled', running || recording || audioBusy);
  $('scenario').toggleAttribute('disabled', running || recording || audioBusy);
  $('record').toggleAttribute('disabled', audioBusy || running || !runtimeStatus?.sttEnabled || ($<HTMLSelectElement>('mode').value !== 'live') || !$<HTMLInputElement>('consent').checked);
  $('record').textContent = recording ? '録音を止めて調べる' : '音声で入力';
}
function newViewToken() { viewToken = `${currentId}:${revision}`; g2?.invalidateViews(viewToken); }
function clearResult() {
  result = null; cardIndex = 0;
  $('candidates').replaceChildren(); $('sources').replaceChildren(); $('source-empty').classList.remove('hidden');
  $('fact').textContent = '話題は、根拠とともに。'; $('question').textContent = '調査を始めると、確認した情報と質問のヒントが届きます。';
  $('hud-target').textContent = 'WAITING'; $('hud-source').textContent = '公開情報だけを調査'; $('hud-expiry').textContent = 'MAX 3 CARDS';
  $('card-count').textContent = '0 / 0'; $('previous').setAttribute('disabled', ''); $('next').setAttribute('disabled', '');
}
async function sendView(header: string, content: string, footer: string) {
  if (connected) await g2.render({ header: header.slice(0, 60), content: content.slice(0, 380), footer: footer.slice(0, 100) }, viewToken);
}
function renderCard() {
  const cards = result?.cards.filter(c => Date.parse(c.expiresAt) > Date.now()) || [];
  if (!cards.length) {
    if (result?.cards.length) { clearResult(); status('カードの有効期限が切れました。必要なら再調査してください。'); void sendView('会話アシスタント', 'カードの有効期限が切れました。', '再調査してください'); }
    return;
  }
  cardIndex = (cardIndex + cards.length) % cards.length;
  const card = cards[cardIndex]!;
  const source = result!.sources.find(s => s.sourceId === card.sourceId)!;
  $('fact').textContent = card.fact; $('question').textContent = `質問のヒント：${card.suggestedQuestion}`;
  $('hud-target').textContent = result!.target?.personName || '';
  $('hud-source').textContent = source.kind === 'fixture' ? '架空の固定資料' : new URL(source.url).hostname;
  $('hud-expiry').textContent = `${new Date(card.expiresAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで`;
  $('card-count').textContent = `${cardIndex + 1} / ${cards.length}`;
  $('previous').toggleAttribute('disabled', cards.length < 2); $('next').toggleAttribute('disabled', cards.length < 2);
  $('sources').replaceChildren(); $('source-empty').classList.add('hidden');
  const evidence = document.createElement('div'); evidence.className = 'source';
  const title = document.createElement('h3'); title.textContent = source.title;
  const quote = document.createElement('blockquote'); quote.textContent = card.excerpt;
  const date = document.createElement('p'); date.className = 'muted'; date.textContent = `取得：${new Date(source.retrievedAt).toLocaleString('ja-JP')}`;
  evidence.append(title, quote, date);
  if (source.kind !== 'fixture' && /^https?:\/\//.test(source.url)) { const link = document.createElement('a'); link.href = source.url; link.textContent = '出典を開く ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer'; evidence.append(link); }
  $('sources').append(evidence);
  void sendView(`${result!.mode === 'demo' ? '[架空デモ] ' : ''}${result!.target?.personName || ''} ${cardIndex + 1}/${cards.length}`, `${card.fact}\n\n質問：${card.suggestedQuestion}`, `${$('hud-source').textContent} / 5分で失効`);
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
  $('candidates').replaceChildren();
  if (value.status === 'awaiting_confirmation') {
    for (const candidate of value.candidates) { const button = document.createElement('button'); button.textContent = `${candidate.personName} / ${candidate.companyName} を選ぶ`; button.onclick = () => { if (lastInput) { $<HTMLTextAreaElement>('text').value = lastInput.text; void research(candidate.id); } }; $('candidates').append(button); }
  }
  if (!value.cards.length) { $('fact').textContent = value.status === 'awaiting_confirmation' ? '相手の確認が必要です。' : '確認できた情報はありません。'; $('question').textContent = value.message; void sendView('会話アシスタント', $('fact').textContent!, 'スマートフォンで確認'); }
  renderCard();
}
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers); if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) { const body = await response.json().catch(() => ({})); if (response.status === 401) { token = ''; clearResult(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden'); } throw new Error(body.message || '処理できませんでした。接続・設定・入力を確認してください。'); }
  return response;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function login() {
  try {
    const response = await api('/api/session', json({ accessCode: $<HTMLInputElement>('access-code').value }));
    const data = await response.json(); token = data.token; revision = data.revision; expiresAt = data.expiresAt;
    $<HTMLInputElement>('access-code').value = ''; $('login').classList.add('hidden'); $('workspace').classList.remove('hidden');
    $('resume-notice').classList.toggle('hidden', !data.hasPrevious && !data.interrupted);
    if (data.interrupted) status('前の調査が中断されました。マイクは停止しています。必要なら再調査してください。');
    refreshControls();
  } catch (error) { $('login-status').textContent = error instanceof Error ? error.message : '開始できませんでした。'; }
}
async function research(selectedCandidateId?: string, preparedId?: string) {
  const text = $<HTMLTextAreaElement>('text').value.trim(); if (!text) { status('会社名と氏名、または会話を入力してください。'); return; }
  if (running || recording || audioBusy || !token) return;
  $('resume-notice').classList.add('hidden');
  currentId = preparedId || crypto.randomUUID(); revision += 1; newViewToken(); clearResult();
  $('trace').replaceChildren(); $('trace-empty').classList.remove('hidden');
  running = true; refreshControls(); controller = new AbortController(); const ownController = controller; const ownId = currentId;
  const input: ResearchInput = { text, requestId: ownId, subjectRevision: revision, mode: $<HTMLSelectElement>('mode').value as 'demo' | 'live', scenario: $<HTMLSelectElement>('scenario').value as Scenario, ...(selectedCandidateId ? { selectedCandidateId } : {}) };
  lastInput = input; status('公開情報を調べています…'); await sendView('会話アシスタント', '公開情報を調査中…', '中止はスマートフォンから');
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
  } catch (error) { if (currentId === ownId && !ownController.signal.aborted) { status(error instanceof Error ? error.message : '調査を完了できませんでした。', true); await sendView('会話アシスタント', '調査を完了できませんでした。', '入力・設定・接続を確認'); } }
  finally { if (controller === ownController) { running = false; controller = null; refreshControls(); } }
}
async function cancel() {
  const oldId = currentId; const oldRevision = revision; controller?.abort(); controller = null; running = false;
  currentId = crypto.randomUUID(); revision += 1; newViewToken(); clearResult();
  await stopRecording(false);
  if (oldId && token) void api('/api/cancel', json({ requestId: oldId, subjectRevision: oldRevision })).catch(() => {});
  status('停止しました。遅れて届いた結果は表示しません。'); await sendView('会話アシスタント', '調査を停止しました。', '入力待ち'); refreshControls();
}
function g2Status(state: G2Status) {
  connected = state.state === 'connected' || state.state === 'recording';
  const labels: Record<string, string> = { idle: '画面プレビュー', connecting: 'G2へ接続中', connected: 'G2接続受付済み', recording: 'G2で録音中', background: 'バックグラウンド・停止', disconnected: 'G2切断', unavailable: 'Evenアプリ内で接続してください', error: 'G2接続を確認してください', disposed: 'G2接続終了' };
  $('device-status').textContent = `Even G2 · ${labels[state.state] || state.state}`; $('connection').textContent = connected ? 'G2接続受付済み' : 'スマートフォン表示'; $('device-dot').classList.toggle('on', connected);
  if (recording && audioSource === 'g2' && state.state !== 'recording') void stopRecording(state.state === 'connected');
  if (['background', 'disconnected', 'error', 'disposed'].includes(state.state)) { currentId = crypto.randomUUID(); newViewToken(); clearResult(); }
}
function acceptAudio(chunk: Uint8Array) {
  if (!recording || audioBytes + chunk.length > 960_000) return;
  audioChunks.push(chunk.slice()); audioBytes += chunk.length;
}
g2 = new G2Runtime({ onStatus: g2Status, onAudio: acceptAudio, onAction: action => { if (action === 'next') { cardIndex++; renderCard(); } else if (action === 'previous') { cardIndex--; renderCard(); } else if (action === 'exit') void cancel(); } });
const phone = new PhoneAudio({ onAudio: acceptAudio, onStopped: reason => { if (recording && audioSource === 'phone') void stopRecording(reason !== 'error'); }, onError: message => status(message, true) });
async function startRecording() {
  if (!runtimeStatus.sttEnabled || !$<HTMLInputElement>('consent').checked || $<HTMLSelectElement>('mode').value !== 'live' || running || audioBusy) return;
  const generation = ++audioGeneration;
  audioSource = connected ? 'g2' : 'phone'; audioChunks = []; audioBytes = 0; recording = true; currentId = crypto.randomUUID();
  newViewToken(); clearResult(); void sendView('会話アシスタント', '録音中・最大30秒', '停止はスマートフォンから'); status('録音しています。30秒以内に停止します。'); refreshControls();
  const ok = audioSource === 'g2' ? await g2.startAudio() : await phone.start();
  if (generation !== audioGeneration) return;
  if (!ok || !recording) { await stopRecording(false); status('録音を開始できませんでした。接続とマイクの許可を確認してください。', true); return; }
  audioTimer = setTimeout(() => { void stopRecording(true); }, 30_000);
}
async function stopRecording(transcribe: boolean) {
  if (!transcribe) {
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
  if (!valid() || !chunks.length) { chunks.length = 0; if (generation === audioGeneration) { audioBusy = false; refreshControls(); } return; }
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
$('connect').onclick = async () => { const ok = await g2.connect({ header: '会話アシスタント', content: '接続しました。スマートフォンから調査を開始してください。', footer: 'マイクは停止中' }, viewToken); if (!ok) status('Evenアプリからこの画面を開いて接続してください。通常のブラウザーではプレビューを利用できます。'); };
$('consent').onchange = () => { if (!$<HTMLInputElement>('consent').checked) void stopRecording(false); refreshControls(); };
$('record').onclick = () => { if (recording) void stopRecording(true); else void startRecording(); };
$('mode').onchange = () => { currentId = crypto.randomUUID(); newViewToken(); clearResult(); void sendView('会話アシスタント', '調査を開始してください。', 'マイクは停止中'); const demo = $<HTMLSelectElement>('mode').value === 'demo'; $('scenario-field').classList.toggle('hidden', !demo); $('mode-badge').textContent = demo ? '体験デモ · 架空の人物・固定データ' : '実API · 公開情報を調査'; $('hud-mode').textContent = demo ? 'DEMO / FICTIONAL DATA' : 'LIVE / PUBLIC SOURCES'; $('result-note').textContent = demo ? '体験デモでは外部APIに通信せず、架空の人物・会社の固定資料を使います。' : '個人の非公開情報は調査しません。情報が曖昧な場合は確認を求めます。'; refreshControls(); };
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
$('end').onclick = async () => { await cancel(); try { await api('/api/session', { method: 'DELETE' }); token = ''; expiresAt = 0; lastInput = null; $<HTMLTextAreaElement>('text').value = ''; $('trace').replaceChildren(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden'); $('login-status').textContent = 'セッションの会話データを削除しました。'; } catch (e) { status(e instanceof Error ? e.message : '削除を確認できませんでした。'); } };
document.addEventListener('visibilitychange', () => { if (document.hidden) { void cancel(); } });
window.addEventListener('pagehide', () => { audioGeneration++; recording = false; audioBusy = false; clearTimeout(audioTimer); audioChunks = []; controller?.abort(); void phone.stop(); void g2.dispose(); });
setInterval(() => { if (result?.cards.some(card => Date.parse(card.expiresAt) <= Date.now())) renderCard(); if (token && expiresAt <= Date.now()) { void cancel(); token = ''; clearResult(); $('workspace').classList.add('hidden'); $('login').classList.remove('hidden'); $('login-status').textContent = '15分経過したため終了しました。再度開始してください。'; } }, 15_000);
try {
  runtimeStatus = await (await fetch('/api/status', { cache: 'no-store' })).json();
  $('live-option').toggleAttribute('disabled', !runtimeStatus.liveEnabled); $('configuration').textContent = runtimeStatus.liveEnabled ? '実APIでの調査を利用できます。課金額は設定した上限内で予約します。' : `未設定：${runtimeStatus.missing.join('、')}`;
  if (runtimeStatus.sttEnabled) $('audio-hint').textContent = 'G2接続時はグラス、未接続時はスマートフォンのマイクを使用';
  $('login').classList.remove('hidden'); if (!runtimeStatus.accessCodeRequired) { $('access-code').classList.add('hidden'); document.querySelector('label[for="access-code"]')?.classList.add('hidden'); await login(); }
} catch { $('login').classList.remove('hidden'); $('login-status').textContent = 'サーバーに接続できません。再読み込みしてください。'; }
