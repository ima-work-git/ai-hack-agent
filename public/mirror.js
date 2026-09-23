(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const status = byId('status');
  const screen = byId('screen');
  const viewport = byId('viewport');
  const content = byId('glass-content');
  const canvas = byId('small-content');
  const states = { idle: '待機中', connecting: 'グラスへ接続中', connected: 'グラスに接続済み', recording: '音声認識中', background: 'スマホが背景に移動しました', disconnected: 'グラスとの接続が切れています', unavailable: 'グラスに接続できません', error: 'グラスの状態を確認してください', disposed: '会話を終了しました' };
  let rendered = '';
  let timer;
  let controller;
  let stopped = false;
  let retentionTimer;
  let lastUpdatedAt = 0;
  function clearView(header = 'グラスとの接続を確認してください') {
    clearTimeout(retentionTimer);
    lastUpdatedAt = 0;
    rendered = '';
    canvas.hidden = true;
    canvas.width = 576; // Erase the backing bitmap, including hidden prior content.
    content.textContent = '';
    content.removeAttribute('aria-label');
    byId('glass-header').textContent = header;
    byId('glass-footer').textContent = '最新のグラス画面は受信していません';
  }
  function expireView() {
    if (lastUpdatedAt && Date.now() - lastUpdatedAt >= 120000) {
      clearView('受信が止まったため画面を消去しました');
      byId('hint').textContent = '再接続すると、新しく届いた画面を表示します。';
    }
  }
  function fit() { screen.style.transform = `scale(${viewport.clientWidth / 576})`; }
  new ResizeObserver(fit).observe(viewport);
  fit();
  function setStatus(text, kind = '') { status.textContent = text; status.className = `status ${kind}`; }
  function drawSmall(text) {
    const context = canvas.getContext('2d');
    if (!context || typeof Intl.Segmenter !== 'function') return false;
    context.font = '14px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
    context.textBaseline = 'top';
    const rows = [];
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    let top = 2;
    let gap = false;
    for (const original of text.replace(/\r/g, '').split('\n')) {
      const line = original.trim();
      if (!line) { if (rows.length) gap = true; continue; }
      if (gap) { top += 4; gap = false; }
      let row = '';
      const append = () => {
        if (top + 14 > 142) return false;
        rows.push({ text: row, top }); top += 16; row = ''; return true;
      };
      for (const { segment } of segmenter.segment(line)) {
        if (context.measureText(segment).width > 560) return false;
        if (row && context.measureText(row + segment).width > 560 && !append()) return false;
        row += segment;
      }
      if (row && !append()) return false;
    }
    if (!rows.length) return false;
    context.fillStyle = '#000'; context.fillRect(0, 0, 576, 144);
    context.fillStyle = '#a5ff9c';
    rows.forEach(row => context.fillText(row.text, 8, row.top));
    return true;
  }
  function render(view) {
    const key = JSON.stringify(view);
    if (key === rendered) return;
    rendered = key;
    byId('glass-header').textContent = view.header;
    byId('glass-footer').textContent = view.footer;
    const small = view.textSize === 'small' && drawSmall(view.content);
    canvas.hidden = !small;
    content.textContent = small ? '' : view.content;
    content.setAttribute('aria-label', view.content);
  }
  function validView(view) { return view && ['header', 'content', 'footer'].every(key => typeof view[key] === 'string' && view[key].length <= 2000); }
  async function poll() {
    if (stopped) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    let delay = 500;
    try {
      const response = await fetch('/api/glasses-mirror', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { frame } = await response.json();
      if (stopped) return;
      if (!frame) {
        setStatus('グラスからの受信待ち');
        byId('device').textContent = 'スマホ・グラスからの受信待ち';
        byId('updated').textContent = 'まだ受信していません';
        byId('hint').textContent = 'スマホからいつものQRを読み取り、会話モードを開いてください。';
        clearView('グラスを待っています');
        content.textContent = 'スマホからいつものQRで接続してください。\nグラスの表示がここにも届きます。';
        content.removeAttribute('aria-label');
        byId('glass-footer').textContent = 'この画面から音声認識は開始しません';
      } else {
        const timestamp = Number(frame.updatedAt);
        if (validView(frame.view) && Number.isFinite(timestamp) && Date.now() - timestamp < 120000) {
          render(frame.view);
          lastUpdatedAt = Math.min(timestamp, Date.now());
          clearTimeout(retentionTimer);
          retentionTimer = setTimeout(expireView, Math.max(0, 120000 - (Date.now() - lastUpdatedAt)));
        } else clearView(['connected', 'recording'].includes(frame.state) ? 'スマホに接続済み・グラス画面を待っています' : undefined);
        const stale = !Number.isFinite(timestamp) || Date.now() - timestamp > 10000;
        const connected = ['connected', 'recording'].includes(frame.state);
        setStatus(stale ? '受信が止まっています' : connected && validView(frame.view) ? 'ライブ表示中' : connected ? 'スマホ接続済み・画面待ち' : 'グラスの状態を確認', stale || !connected || !validView(frame.view) ? 'warning' : 'live');
        byId('device').textContent = states[frame.state] || 'グラスの状態を確認';
        byId('updated').textContent = Number.isFinite(timestamp) ? `最終受信 ${new Date(timestamp).toLocaleTimeString('ja-JP', { hour12: false })}` : '最終受信時刻を確認できません';
        byId('hint').textContent = stale ? '最後に受信した画面です。スマホの画面と接続状態を確認してください。' : !validView(frame.view) ? 'スマホから接続状態を受信しています。グラスの表示受付が完了すると画面が届きます。' : 'グラスの操作や音声状態に合わせて、この画面も自動で更新します。';
      }
    } catch {
      if (!stopped) {
        setStatus('PCサーバーとの接続を確認しています', 'warning');
        byId('hint').textContent = '自動で再接続しています。画面に残っている内容は最後に受信したものです。';
        delay = 1500;
      }
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      expireView();
      if (!stopped) timer = setTimeout(poll, delay);
    }
  }
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); controller?.abort(); clearView(); });
  window.addEventListener('pageshow', event => { if (event.persisted && stopped) { stopped = false; poll(); } });
  poll();
})();
