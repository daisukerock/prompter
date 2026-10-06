import * as Detect from './detect.js';
import * as AI from './ai/index.js';

const $ = (s) => document.querySelector(s);
const MAX_ACTIVE = 3;
const DEDUPE_MS = 5 * 60 * 1000;
const AI_WAIT_MS = 1200; // 話の区切りを待ってから、まとめて送る
const AI_FLUSH_CHARS = 120; // これ以上たまったら、待たずに送る
const AI_MIN_INTERVAL = 1500; // 送る間隔の最小値
const CONTEXT_LINES = 2; // 手がかりとして一緒に送る、直前の文の数
const CHAT_SITES = {
  claude: { name: 'Claude', url: 'https://claude.ai/new' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
};
const DEMO_LINES = [
  '今回のEBPMの進め方について、KPIの設定をお願いしたいです。',
  '来月末までにPoCを終えて、予算は500万円を見込んでいます。',
  '契約条件についてはNDAを結んだうえで、必ず今週中に回答をお願いします。',
  'ステークホルダーとのコンセンサスが取れていないので、いったんペンディングです。',
  'SLAに関する懸念が残っていて、障害時のエスカレーションが未定です。',
  'RAGとLLMを組み合わせたMVPのロードマップを共有します。',
];
const STATUS_LABEL = { new: '新しい', studied: '調べた', learned: '覚えた' };
const NEXT_STATUS = { new: 'studied', studied: 'learned', learned: 'new' };

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても動かす */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* 無視 */ }
  },
};

function defaultModels() {
  const models = {};
  Object.entries(AI.PROVIDERS).forEach(([id, p]) => { models[id] = p.defaultModel; });
  return models;
}

function loadSettings() {
  const saved = store.get('pl_settings', {});
  const s = Object.assign({
    provider: 'claude', models: {}, baseUrl: '', rememberKey: true, aiEnabled: true,
    chat: 'claude', size: 'm', wake: true,
  }, saved);
  // 以前の版の設定(「AIに聞く」の行き先が ai に入っていた)を引き継ぐ
  if (saved.ai && !saved.chat && CHAT_SITES[saved.ai]) s.chat = saved.ai;
  delete s.ai;
  delete s.autoWiki;
  if (!AI.PROVIDERS[s.provider]) s.provider = 'claude';
  s.models = Object.assign(defaultModels(), s.models);
  return s;
}

const state = {
  listening: false,
  rec: null,
  wake: null,
  demoTimer: null,
  gen: 0, // 「表示を消す」で増やし、それより前のAIの結果は捨てる
  lines: [], // {text}
  interim: '',
  active: [],
  history: [],
  seen: new Map(),
  marks: [], // 文字起こしで強調する語
  shownTerms: [], // AIが説明した語(AIへの「除外する語」に使う)
  saved: store.get('pl_saved', []),
  known: new Set(store.get('pl_known', [])),
  settings: loadSettings(),
  keys: store.get('pl_keys', {}), // AIサービスごとのAPIキー
  ai: { pending: [], timer: null, busy: false, halted: '', nextAt: 0 },
  filter: 'all',
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const persistSaved = () => store.set('pl_saved', state.saved);
const persistKnown = () => store.set('pl_known', [...state.known]);
const persistSettings = () => store.set('pl_settings', state.settings);
function persistKeys() {
  if (state.settings.rememberKey) store.set('pl_keys', state.keys);
  else store.remove('pl_keys');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}

function setStatus(msg, warn) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('is-warn', !!warn);
}

function baseStatus() {
  if (state.listening) return '聞いています…(画面は点けたままにしてください)';
  if (state.demoTimer) return 'デモを再生中…';
  return '';
}

// ---------- AIの設定 ----------
function aiConfig() {
  const p = state.settings.provider;
  return { provider: p, apiKey: state.keys[p] || '', model: state.settings.models[p] || '', baseUrl: state.settings.baseUrl };
}
const aiReady = () => AI.isReady(aiConfig());
const aiActive = () => aiReady() && state.settings.aiEnabled && !state.ai.halted;
const isKnown = (term) => state.known.has(String(term).toLowerCase());

// ---------- カードの作成 ----------
function aiTermCard(t, lines) {
  return {
    id: uid(), kind: 'term', key: 't:' + t.term.toLowerCase(), term: t.term,
    title: t.term, sub: t.full, body: t.meaning, quote: Detect.lineContaining(lines, t.term), level: 'term',
  };
}

function aiRiskCard(r, lines) {
  const quote = r.quote || lines[lines.length - 1] || '';
  return {
    id: uid(), kind: 'risk', key: 'r:' + r.label + ':' + quote, term: r.label,
    title: r.label, sub: '', body: r.tip, quote, level: r.level,
  };
}

function offlineTermCard(c) {
  return {
    id: uid(), kind: 'term', key: 'o:' + c.term.toLowerCase(), term: c.term, offline: true,
    title: c.term, sub: '意味は未取得',
    body: aiReady()
      ? 'AIがオフのため、意味は出していません。「詳しく」で、チャットのAIに聞けます。'
      : 'AIを設定すると、意味がその場で出ます。「詳しく」で、チャットのAIに聞けます。',
    quote: c.quote, level: 'term',
  };
}

// 同じ1文で見つかった注意点は、1枚にまとめる(赤を先に、最大3件)
function offlineRiskCard(group) {
  const sorted = group.slice().sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1)).slice(0, 3);
  const quote = sorted[0].quote;
  const title = sorted.map((r) => r.label).join('・');
  return {
    id: uid(), kind: 'risk', key: 'r:' + quote, term: title, title,
    sub: [...new Set(sorted.flatMap((r) => r.matched))].slice(0, 4).join('・'),
    body: sorted.map((r) => r.tip).join('\n'), quote,
    level: sorted.some((r) => r.level === 'red') ? 'red' : 'yellow',
  };
}

function remember(list, term) {
  if (list.includes(term)) return;
  list.push(term);
  if (list.length > 200) list.shift();
}

function pushCard(card) {
  if (card.kind === 'term' && isKnown(card.term)) return false;
  const now = Date.now();
  const last = state.seen.get(card.key);
  if (last && now - last < DEDUPE_MS) return false;
  state.seen.set(card.key, now);
  card.ts = now;
  if (card.kind === 'term') {
    remember(state.marks, card.term);
    if (!card.offline) remember(state.shownTerms, card.term);
  }
  state.active.unshift(card);
  while (state.active.length > MAX_ACTIVE) state.history.unshift(state.active.pop());
  if (state.history.length > 50) state.history.length = 50;
  return true;
}

// 後から積んだカードが上に出る。上から「要注意」「用語」「確認」の順にする
function pushBatch(termCards, riskCards) {
  riskCards.filter((c) => c.level !== 'red').forEach(pushCard);
  termCards.slice().reverse().forEach(pushCard);
  riskCards.filter((c) => c.level === 'red').forEach(pushCard);
}

// AIを使わない簡易判定(英字の略語と、気をつけたい言葉)
function detectOffline(lines) {
  const text = lines.join('\n');
  const termCards = Detect.findCandidates(text).filter((c) => !isKnown(c.term)).map(offlineTermCard);
  const groups = new Map();
  Detect.findRisks(text).forEach((r) => {
    if (!groups.has(r.quote)) groups.set(r.quote, []);
    groups.get(r.quote).push(r);
  });
  pushBatch(termCards, [...groups.values()].map(offlineRiskCard));
}

// ---------- 発言の受け取りとAIへの送信 ----------
function addFinalLine(text) {
  text = String(text || '').trim();
  if (!text) return;
  state.lines.push({ text });
  if (state.lines.length > 60) state.lines.shift();
  state.interim = '';
  if (aiActive()) {
    state.ai.pending.push(text);
    scheduleAI();
  } else {
    detectOffline([text]);
  }
  renderAll();
}

function scheduleAI() {
  const ai = state.ai;
  clearTimeout(ai.timer);
  const chars = ai.pending.join('').length;
  ai.timer = setTimeout(flushAI, chars >= AI_FLUSH_CHARS ? 0 : AI_WAIT_MS);
}

function excludeList() {
  return [...new Set([...state.shownTerms, ...state.known])].slice(-80);
}

async function flushAI() {
  const ai = state.ai;
  clearTimeout(ai.timer);
  ai.timer = null;
  if (ai.busy || !ai.pending.length) return;
  if (!aiActive()) {
    detectOffline(ai.pending.splice(0));
    renderAll();
    return;
  }
  const wait = ai.nextAt - Date.now();
  if (wait > 0) {
    ai.timer = setTimeout(flushAI, wait);
    return;
  }

  const batch = ai.pending.splice(0);
  const start = Math.max(0, state.lines.length - batch.length);
  const context = state.lines.slice(Math.max(0, start - CONTEXT_LINES), start).map((l) => l.text);
  const gen = state.gen;
  ai.busy = true;
  updateAiUi();
  try {
    const result = await AI.analyze(aiConfig(), { context, utterance: batch.join('\n'), exclude: excludeList() });
    if (gen !== state.gen) return;
    const termCards = result.terms.filter((t) => !isKnown(t.term)).map((t) => aiTermCard(t, batch));
    const riskCards = result.risks.map((r) => aiRiskCard(r, batch));
    pushBatch(termCards, riskCards);
    setStatus(baseStatus());
  } catch (e) {
    if (gen !== state.gen) return;
    handleAIError(e, batch);
  } finally {
    ai.busy = false;
    ai.nextAt = Math.max(ai.nextAt, Date.now() + AI_MIN_INTERVAL);
    updateAiUi();
    renderAll();
    if (ai.pending.length) scheduleAI();
  }
}

function handleAIError(e, batch) {
  const code = e && e.code;
  const msg = (e && e.message) || 'AIの呼び出しで、エラーが起きました。';
  if (['auth', 'permission', 'notfound', 'config'].includes(code)) {
    // 設定を直すまでは送らない
    state.ai.halted = msg;
    setStatus(msg + ' いまは簡易判定で動いています。', true);
  } else if (code === 'ratelimit') {
    state.ai.nextAt = Date.now() + 20000;
    setStatus(msg, true);
  } else if (['network', 'timeout', 'server'].includes(code)) {
    state.ai.nextAt = Date.now() + 5000;
    setStatus(msg, true);
  } else {
    setStatus(msg, true);
  }
  // AIで確かめられなかった分は、簡易判定で拾う
  detectOffline(batch);
}

// ---------- 描画 ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, onClick, cls) {
  const b = el('button', 'btn btn-sm' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function cardNode(card, mode) {
  const risk = card.kind === 'risk';
  const n = el('article', 'card' + (risk ? ' risk-' + card.level : ''));
  n.dataset.id = card.id;

  const head = el('div', 'card-head');
  head.append(el('h3', 'card-title', card.title));
  if (card.sub) head.append(el('span', 'card-sub', card.sub));
  if (risk) head.append(el('span', 'card-tag', card.level === 'red' ? '要注意' : '確認'));
  if (mode === 'saved') {
    const st = card.status || 'new';
    head.append(el('span', 'status-pill st-' + st, STATUS_LABEL[st]));
  }
  n.append(head);
  n.append(el('p', 'card-body', card.body));
  if (card.quote) n.append(el('p', 'card-quote', '「' + card.quote + '」'));
  if (card.detail) n.append(el('p', 'card-detail' + (card.detail.error ? ' is-error' : ''), card.detail.text));

  const actions = el('div', 'card-actions');
  if (mode === 'live') {
    actions.append(button(risk ? '確認事項に保存' : '保存', () => saveCard(card), 'btn-primary'));
    if (!risk) {
      actions.append(button('知っている', () => markKnown(card)));
      actions.append(button('詳しく', () => explainCard(card)));
    }
    actions.append(button('✕', () => dismissCard(card.id)));
    n.append(actions);
    return n;
  }

  const next = NEXT_STATUS[card.status || 'new'];
  actions.append(button(next === 'new' ? '新しいに戻す' : STATUS_LABEL[next] + 'にする', () => cycleStatus(card.id)));
  if (!risk) actions.append(button('詳しく', () => explainCard(card)));
  actions.append(button('チャットで聞く', () => askInChat(card)));
  actions.append(button('削除', () => deleteSaved(card.id), 'btn-danger'));
  const memo = el('textarea');
  memo.placeholder = 'メモ';
  memo.value = card.memo || '';
  memo.addEventListener('change', () => { card.memo = memo.value; persistSaved(); });
  n.append(actions, memo);
  return n;
}

function renderCards() {
  $('#cards').replaceChildren(...state.active.map((c) => cardNode(c, 'live')));
  $('#cardsEmpty').hidden = state.active.length > 0;
  $('#historyBox').hidden = state.history.length === 0;
  $('#historyCount').textContent = state.history.length;
  $('#history').replaceChildren(...state.history.slice(0, 20).map((c) => cardNode(c, 'live')));
}

function renderTranscript() {
  const box = $('#transcript');
  const nodes = state.lines.map((l) => {
    const p = el('p', 'line');
    Detect.markSegments(l.text, state.marks).forEach((s) => {
      p.append(s.mark ? el('mark', null, s.text) : document.createTextNode(s.text));
    });
    return p;
  });
  if (state.interim) nodes.push(el('p', 'line interim', state.interim));
  box.replaceChildren(...nodes);
  box.scrollTop = box.scrollHeight;
}

function renderSaved() {
  $('#savedCount').textContent = state.saved.length;
  const list = state.saved.filter((c) => state.filter === 'all' || (c.status || 'new') === state.filter);
  $('#savedList').replaceChildren(...list.map((c) => cardNode(c, 'saved')));
  $('#savedEmpty').hidden = list.length > 0;
}

function renderAll() {
  renderCards();
  renderTranscript();
  renderSaved();
}

function updateAiUi() {
  const b = $('#aiToggle');
  const meta = AI.PROVIDERS[state.settings.provider];
  b.classList.remove('is-on', 'is-off', 'is-warn');
  if (!aiReady()) {
    b.textContent = 'AI未設定';
    b.classList.add('is-warn');
    b.title = '押すと、AIの設定画面を開きます';
  } else if (state.ai.halted) {
    b.textContent = 'AI停止中';
    b.classList.add('is-warn');
    b.title = state.ai.halted + '(押すと設定画面を開きます)';
  } else if (state.settings.aiEnabled) {
    b.textContent = (state.ai.busy ? 'AI確認中…' : 'AIオン') + '・' + meta.short;
    b.classList.add('is-on');
    b.title = meta.label + 'に、文字起こしの直近の文を送っています。押すとオフにします。';
  } else {
    b.textContent = 'AIオフ';
    b.classList.add('is-off');
    b.title = 'オフの間は、会話を送りません。押すとオンにします。';
  }
  $('#setupBanner').hidden = aiReady();
}

// ---------- カードの操作 ----------
function removeLive(id) {
  state.active = state.active.filter((c) => c.id !== id);
  state.history = state.history.filter((c) => c.id !== id);
}

function dismissCard(id) {
  const c = state.active.find((x) => x.id === id);
  if (c) state.history.unshift(c);
  state.active = state.active.filter((x) => x.id !== id);
  renderCards();
}

function saveCard(card) {
  const exists = state.saved.some((s) => s.key === card.key);
  if (!exists) {
    state.saved.unshift({
      id: uid(), key: card.key, kind: card.kind, term: card.term, title: card.title, sub: card.sub,
      body: card.body, quote: card.quote, level: card.level, detail: card.detail && !card.detail.loading ? card.detail : null,
      ts: Date.now(), status: 'new', memo: '',
    });
    persistSaved();
  }
  removeLive(card.id);
  renderAll();
  toast(exists ? 'すでに保存されています' : '保存しました');
}

function markKnown(card) {
  state.known.add(card.term.toLowerCase());
  persistKnown();
  state.active = state.active.filter((c) => !(c.kind === 'term' && c.term.toLowerCase() === card.term.toLowerCase()));
  removeLive(card.id);
  renderCards();
  toast('「' + card.term + '」は、今後出しません');
}

function cycleStatus(id) {
  const c = state.saved.find((s) => s.id === id);
  if (!c) return;
  c.status = NEXT_STATUS[c.status || 'new'];
  if (c.status === 'learned' && c.kind === 'term') {
    state.known.add(c.term.toLowerCase());
    persistKnown();
  }
  persistSaved();
  renderSaved();
}

function deleteSaved(id) {
  state.saved = state.saved.filter((s) => s.id !== id);
  persistSaved();
  renderSaved();
}

// 表示中と保存済みの両方にある同じカードへ、説明をそろえる
function setDetail(card, detail) {
  const key = card.key;
  [...state.active, ...state.history, ...state.saved].forEach((c) => {
    if (c === card || c.key === key) c.detail = detail;
  });
  if (!detail.loading) persistSaved();
  renderAll();
}

async function explainCard(card) {
  // AIがオフ・未設定のときは、会話を送らずに、チャットのAIで聞く
  if (!aiActive()) {
    askInChat(card);
    return;
  }
  if (card.detail && card.detail.loading) return;
  setDetail(card, { text: 'AIに聞いています…', loading: true });
  try {
    const text = await AI.explain(aiConfig(), card.term, card.quote);
    setDetail(card, { text: text || 'AIから、説明が返りませんでした。' });
  } catch (e) {
    setDetail(card, { text: (e && e.message) || '説明を取得できませんでした。', error: true });
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('clipboard unavailable'));
}

function askInChat(card) {
  const site = CHAT_SITES[state.settings.chat] || CHAT_SITES.claude;
  const q = card.kind === 'risk'
    ? '次の発言について、確認しておくべき点を3つ、短く挙げてください。\n発言:「' + card.quote + '」'
    : '「' + card.term + '」について、短く分かりやすく説明してください。\n出てきた場面:「' + (card.quote || '') + '」\nよくある誤解や、注意点があれば教えてください。';
  const open = () => window.open(site.url, '_blank', 'noopener');
  copyText(q).then(
    () => { toast('質問文をコピーしました。' + site.name + 'に貼り付けてください'); open(); },
    () => { toast('コピーできませんでした'); open(); },
  );
}

function exportList() {
  const list = state.saved.filter((c) => state.filter === 'all' || (c.status || 'new') === state.filter);
  const text = list.map((c) => {
    const d = new Date(c.ts).toLocaleDateString('ja-JP');
    return [
      '■ ' + c.title + (c.sub ? '(' + c.sub + ')' : ''),
      c.body,
      c.detail && !c.detail.error ? '詳しく: ' + c.detail.text : '',
      c.quote ? '場面: ' + c.quote : '',
      c.memo ? 'メモ: ' + c.memo : '',
      d + ' / ' + STATUS_LABEL[c.status || 'new'],
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  if (!text) { toast('コピーするカードがありません'); return; }
  copyText(text).then(() => toast('一覧をコピーしました'), () => toast('コピーできませんでした'));
}

// ---------- 聞き取り ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

async function requestWake() {
  if (!state.settings.wake || !('wakeLock' in navigator)) return;
  try { state.wake = await navigator.wakeLock.request('screen'); } catch (e) { state.wake = null; }
}
function releaseWake() {
  if (state.wake) { state.wake.release().catch(() => {}); state.wake = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.listening) requestWake();
});

function startListening() {
  if (!SR) {
    setStatus('このブラウザは、音声認識に対応していません。下の入力欄に文を入れて試せます。', true);
    return;
  }
  const rec = new SR();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) addFinalLine(r[0].transcript);
      else interim += r[0].transcript;
    }
    state.interim = interim;
    renderTranscript();
  };
  rec.onerror = (ev) => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      stopListening();
      setStatus('マイクが許可されていません。ブラウザの設定で許可してください。', true);
    } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
      setStatus('音声認識でエラーが出ました(' + ev.error + ')', true);
    }
  };
  rec.onend = () => {
    if (!state.listening) return;
    try {
      rec.start();
    } catch (e) {
      stopListening();
      setStatus('聞き取りが止まりました。もう一度「聞き取り開始」を押してください。', true);
    }
  };
  state.rec = rec;
  state.listening = true;
  try { rec.start(); } catch (e) { /* すでに開始済み */ }
  requestWake();
  updateListenUi();
  setStatus(baseStatus());
}

function stopListening() {
  state.listening = false;
  if (state.rec) {
    try { state.rec.stop(); } catch (e) { /* 無視 */ }
    state.rec = null;
  }
  releaseWake();
  state.interim = '';
  updateListenUi();
  setStatus(baseStatus());
  renderTranscript();
}

function updateListenUi() {
  const b = $('#listenBtn');
  b.textContent = state.listening ? '■ 停止' : '● 聞き取り開始';
  b.classList.toggle('is-live', state.listening);
}

function runDemo() {
  if (state.demoTimer) return;
  let i = 0;
  const step = () => {
    if (i >= DEMO_LINES.length) {
      state.demoTimer = null;
      setStatus(baseStatus());
      return;
    }
    addFinalLine(DEMO_LINES[i++]);
    state.demoTimer = setTimeout(step, 3000);
  };
  state.demoTimer = setTimeout(step, 0);
  setStatus(baseStatus());
}

function clearScreen() {
  clearTimeout(state.demoTimer);
  state.demoTimer = null;
  clearTimeout(state.ai.timer);
  state.ai.timer = null;
  state.ai.pending = [];
  state.gen++;
  state.lines = [];
  state.interim = '';
  state.active = [];
  state.history = [];
  state.marks = [];
  state.shownTerms = [];
  state.seen.clear();
  setStatus(baseStatus());
  renderAll();
}

// ---------- 画面の切り替え ----------
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  if (name === 'saved') renderSaved();
  if (name === 'settings') renderSettings();
}

// ---------- 設定画面 ----------
function setModelOptions(models, note) {
  const pick = $('#modelPick');
  const current = state.settings.models[state.settings.provider] || '';
  const first = el('option', null, models.length ? '候補から選ぶ' : '候補はありません');
  first.value = '';
  const options = models.map((m) => {
    const o = el('option', null, m.label && m.label !== m.id ? m.label + ' — ' + m.id : m.id);
    o.value = m.id;
    return o;
  });
  pick.replaceChildren(first, ...options);
  pick.value = models.some((m) => m.id === current) ? current : '';
  if (note != null) $('#modelNote').textContent = note;
}

function renderSettings() {
  const p = state.settings.provider;
  const meta = AI.PROVIDERS[p];
  $('#providerSelect').value = p;
  $('#baseUrlRow').hidden = !meta.needsBaseUrl;
  $('#baseUrlInput').value = state.settings.baseUrl || '';
  const key = $('#keyInput');
  key.value = state.keys[p] || '';
  key.placeholder = meta.keyHint;
  const keyNote = $('#keyNote');
  if (meta.keyUrl) {
    const a = el('a', null, meta.keySite);
    a.href = meta.keyUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    keyNote.replaceChildren(document.createTextNode('キーは、'), a, document.createTextNode('で作れます。'));
  } else {
    keyNote.textContent = 'APIキーが要らない接続先なら、空欄のままにします。';
  }
  $('#rememberKey').checked = !!state.settings.rememberKey;
  $('#modelInput').value = state.settings.models[p] || '';
  setModelOptions(meta.suggestions, meta.defaultModel
    ? '既定は ' + meta.defaultModel + ' です。使えるモデルは「モデル一覧を取得」で確かめられます。'
    : 'モデル名を入れるか、「モデル一覧を取得」から選んでください。');
  $('#chatSelect').value = state.settings.chat;
  $('#sizeSelect').value = state.settings.size;
  $('#wakeLock').checked = !!state.settings.wake;
}

function setTestResult(text, kind) {
  const r = $('#testResult');
  r.textContent = text;
  r.className = 'test-result' + (kind ? ' is-' + kind : '');
}

function onAiSettingChanged() {
  state.ai.halted = '';
  setTestResult('');
  updateAiUi();
}

async function fetchModels() {
  const btn = $('#modelsBtn');
  btn.disabled = true;
  $('#modelNote').textContent = 'モデルの一覧を取得しています…';
  try {
    const models = await AI.listModels(aiConfig());
    setModelOptions(models, models.length
      ? models.length + '件のモデルが見つかりました。上の候補から選べます。'
      : 'モデルが見つかりませんでした。');
  } catch (e) {
    $('#modelNote').textContent = (e && e.message) || 'モデルの一覧を取得できませんでした。';
  } finally {
    btn.disabled = false;
  }
}

async function runTest() {
  const btn = $('#testBtn');
  btn.disabled = true;
  setTestResult('確認しています…');
  try {
    const { result, ms } = await AI.testConnection(aiConfig());
    state.ai.halted = '';
    const terms = result.terms.map((t) => t.term + ':' + t.meaning).join(' / ');
    const risks = result.risks.map((r) => r.label).join('・');
    setTestResult(
      'つながりました(' + (ms / 1000).toFixed(1) + '秒)。'
      + (terms ? ' 用語 ' + terms + '。' : ' 用語は見つかりませんでした。')
      + (risks ? ' 注意点 ' + risks + '。' : ''),
      'ok',
    );
  } catch (e) {
    setTestResult((e && e.message) || '接続できませんでした。', 'error');
  } finally {
    btn.disabled = false;
    updateAiUi();
  }
}

function applyDisplaySettings() {
  document.documentElement.dataset.size = state.settings.size;
}

function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  $('#listenBtn').addEventListener('click', () => (state.listening ? stopListening() : startListening()));
  $('#demoBtn').addEventListener('click', runDemo);
  $('#clearBtn').addEventListener('click', clearScreen);
  $('#setupBtn').addEventListener('click', () => showView('settings'));
  $('#aiToggle').addEventListener('click', () => {
    if (!aiReady() || state.ai.halted) {
      showView('settings');
      return;
    }
    state.settings.aiEnabled = !state.settings.aiEnabled;
    persistSettings();
    if (!state.settings.aiEnabled) {
      // まだ送っていない分は、送らずに簡易判定へ回す
      const pending = state.ai.pending.splice(0);
      if (pending.length) detectOffline(pending);
    }
    updateAiUi();
    renderAll();
    toast(state.settings.aiEnabled ? 'AIをオンにしました' : 'AIをオフにしました。会話は送りません');
  });
  $('#typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#typeInput');
    addFinalLine(input.value);
    input.value = '';
  });
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    renderSaved();
  });
  $('#exportBtn').addEventListener('click', exportList);

  // AIの設定
  $('#providerSelect').addEventListener('change', (e) => {
    state.settings.provider = e.target.value;
    persistSettings();
    renderSettings();
    onAiSettingChanged();
  });
  $('#baseUrlInput').addEventListener('change', (e) => {
    state.settings.baseUrl = e.target.value.trim();
    persistSettings();
    onAiSettingChanged();
  });
  $('#keyInput').addEventListener('input', (e) => {
    state.keys[state.settings.provider] = e.target.value.trim();
    persistKeys();
    onAiSettingChanged();
  });
  $('#keyShowBtn').addEventListener('click', () => {
    const input = $('#keyInput');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#keyShowBtn').textContent = show ? '隠す' : '表示';
  });
  $('#rememberKey').addEventListener('change', (e) => {
    state.settings.rememberKey = e.target.checked;
    persistSettings();
    persistKeys();
    toast(e.target.checked ? 'APIキーを、この端末に保存します' : 'APIキーは、画面を閉じると消えます');
  });
  $('#modelInput').addEventListener('change', (e) => {
    state.settings.models[state.settings.provider] = e.target.value.trim();
    persistSettings();
    onAiSettingChanged();
  });
  $('#modelPick').addEventListener('change', (e) => {
    if (!e.target.value) return;
    $('#modelInput').value = e.target.value;
    state.settings.models[state.settings.provider] = e.target.value;
    persistSettings();
    onAiSettingChanged();
  });
  $('#modelsBtn').addEventListener('click', fetchModels);
  $('#testBtn').addEventListener('click', runTest);
  $('#keyClearBtn').addEventListener('click', () => {
    state.keys[state.settings.provider] = '';
    persistKeys();
    renderSettings();
    onAiSettingChanged();
    toast('APIキーを削除しました');
  });

  // そのほかの設定
  $('#chatSelect').addEventListener('change', (e) => { state.settings.chat = e.target.value; persistSettings(); });
  $('#sizeSelect').addEventListener('change', (e) => {
    state.settings.size = e.target.value;
    persistSettings();
    applyDisplaySettings();
  });
  $('#wakeLock').addEventListener('change', (e) => { state.settings.wake = e.target.checked; persistSettings(); });
  $('#resetKnown').addEventListener('click', () => {
    state.known.clear();
    persistKnown();
    toast('リセットしました');
  });
  $('#resetAll').addEventListener('click', () => {
    if (!confirm('保存したカードを、すべて削除します。よろしいですか?')) return;
    state.saved = [];
    persistSaved();
    renderSaved();
    toast('削除しました');
  });
}

applyDisplaySettings();
bind();
renderSettings();
updateAiUi();
renderAll();
if (!SR) setStatus('このブラウザは、音声認識に対応していません。入力欄から試せます。', true);
