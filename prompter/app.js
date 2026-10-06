import * as Detect from './detect.js';
import * as AI from './ai/index.js';
import { parseSummary, todayString } from './ai/common.js';

const $ = (s) => document.querySelector(s);
const FEED_MAX = 40; // 画面に残すカードの数
const DEDUPE_MS = 5 * 60 * 1000;
const AI_WAIT_MS = 1200; // 話の区切りを待ってから、まとめて送る
const AI_FLUSH_CHARS = 120; // これ以上たまったら、待たずに送る
const AI_MIN_INTERVAL = 1500; // 送る間隔の最小値
const CONTEXT_LINES = 2; // 手がかりとして一緒に送る、直前の文の数
const SETTINGS_VERSION = 3;
const SLOW_TEST_MS = 8000; // 接続テストでこれより遅ければ、速いモデルを案内する
const SUMMARY_FRESH_MS = 6 * 60 * 60 * 1000; // この時間内に作った要点は、作り直さずに見せる
const FAST_SUMMARY_MODEL = 'gemini-3.5-flash-lite';
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const EASE_IN = 'cubic-bezier(.4, 0, 1, 1)';
const EASE_SHEET = 'cubic-bezier(.16, 1, .3, 1)';
const CHAT_SITES = {
  claude: { name: 'Claude', url: 'https://claude.ai/new' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
};
const DEMO_LINES = [
  '今回のEBPMの進め方について、KPIの設定をお願いしたいです。',
  '来月末までにPoCを終えて、予算は500万円を見込んでいます。',
  '契約条件についてはNDAを結んだうえで、必ず今週中に回答をお願いします。',
  'トランプ大統領の関税の影響も、次の会議までに整理しておきたいですね。',
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

// ---------- 動き ----------
const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const wideQuery = window.matchMedia ? window.matchMedia('(min-width: 760px)') : null;
const isWide = () => !!(wideQuery && wideQuery.matches);

function motionOK() {
  return !(reduceMotion && reduceMotion.matches) && typeof Element.prototype.animate === 'function';
}

// 位置(transform)と透明度だけを動かす。動きを減らす設定の人には動かさない
function play(node, frames, opts) {
  if (!motionOK()) return null;
  try {
    return node.animate(frames, Object.assign({ duration: 300, easing: EASE }, opts));
  } catch (e) {
    return null;
  }
}

// 消える要素を、高さを縮めながら消す(下の要素が、すっと詰まる)
function leave(node) {
  node.dataset.leaving = '1';
  node.style.pointerEvents = 'none';
  if (!motionOK()) {
    node.remove();
    return;
  }
  const cs = getComputedStyle(node);
  node.style.overflow = 'hidden';
  const anim = play(node, [
    { height: node.offsetHeight + 'px', marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1, transform: 'none' },
    { height: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'scale(.96)' },
  ], { duration: 320, easing: EASE_IN, fill: 'forwards' });
  if (anim) anim.onfinish = () => node.remove();
  else node.remove();
}

// 並び(key の順)に合わせて、要素を足し・消し・並べ替える。
// 動いた要素は、前の位置との差を transform で埋めてから戻す(FLIP)ので、なめらかに動く
function syncList(container, items, { key, build, patch }) {
  const animate = motionOK();
  const current = new Map();
  [...container.children].forEach((node) => {
    if (!node.dataset.leaving) current.set(node.dataset.key, node);
  });
  const first = new Map();
  if (animate) current.forEach((node, k) => first.set(k, node.getBoundingClientRect()));

  const keep = new Set();
  const added = [];
  let anchor = null;
  for (const item of items) {
    const k = key(item);
    keep.add(k);
    let node = current.get(k);
    if (!node) {
      node = build(item);
      node.dataset.key = k;
      added.push(node);
    } else if (patch) {
      patch(node, item);
    }
    const target = anchor ? anchor.nextElementSibling : container.firstElementChild;
    if (node !== target) container.insertBefore(node, target);
    anchor = node;
  }
  current.forEach((node, k) => {
    if (!keep.has(k)) leave(node);
  });
  if (!animate) return added.length;

  current.forEach((node, k) => {
    if (!keep.has(k)) return;
    const a = first.get(k);
    const b = node.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      play(node, [{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: 420 });
    }
  });
  added.forEach((node, i) => {
    play(node, [
      { opacity: 0, transform: 'translateY(-18px) scale(.97)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 460, delay: i * 60, fill: 'backwards' });
  });
  return added.length;
}

// 中身を差し替えるとき、高さの変化もなめらかにする
function patchWithHeight(node, fill) {
  if (!motionOK() || !node.isConnected) {
    fill();
    return;
  }
  const before = node.offsetHeight;
  fill();
  const after = node.offsetHeight;
  if (Math.abs(after - before) < 2) return;
  node.style.overflow = 'hidden';
  const anim = play(node, [{ height: before + 'px' }, { height: after + 'px' }], { duration: 340 });
  if (anim) anim.onfinish = () => { node.style.overflow = ''; };
  else node.style.overflow = '';
}

// ---------- 設定 ----------
function defaultModels() {
  const models = {};
  Object.entries(AI.PROVIDERS).forEach(([id, p]) => { models[id] = p.defaultModel; });
  return models;
}

function loadSettings() {
  const saved = store.get('pl_settings', {});
  const s = Object.assign({
    provider: 'claude', models: {}, summaryModel: AI.PROVIDERS.gemini.defaultSummaryModel, baseUrl: '',
    rememberKey: true, aiEnabled: true, chat: 'claude', size: 'm', wake: true,
  }, saved);
  // 以前の版の設定(「AIに聞く」の行き先が ai に入っていた)を引き継ぐ
  if (saved.ai && !saved.chat && CHAT_SITES[saved.ai]) s.chat = saved.ai;
  delete s.ai;
  delete s.autoWiki;
  if (!AI.PROVIDERS[s.provider]) s.provider = 'claude';
  s.models = Object.assign(defaultModels(), s.models);
  // 版2: Geminiの既定を、応答の速いFlash-Liteに変えた(以前の既定のままなら切り替える)
  if ((saved.version || 1) < 2 && s.models.gemini === 'gemini-3.5-flash') s.models.gemini = 'gemini-3.5-flash-lite';
  s.version = SETTINGS_VERSION;
  return s;
}

const state = {
  listening: false,
  rec: null,
  wake: null,
  demoTimer: null,
  gen: 0, // 「消す」で増やし、それより前のAIの結果は捨てる
  lines: [], // {id, text}
  interim: '',
  cards: [], // 画面のカード(新しい順)
  seen: new Map(),
  marks: [], // 文字起こしで強調する語
  shownTerms: [], // AIが説明した語(AIへの「除外する語」に使う)
  saved: store.get('pl_saved', []).map((c) => Object.assign({ v: 1 }, c)),
  known: new Set(store.get('pl_known', [])),
  settings: loadSettings(),
  keys: store.get('pl_keys', {}), // AIサービスごとのAPIキー
  ai: { pending: [], timer: null, busy: false, halted: '', nextAt: 0 },
  summaryBusy: 0,
  ui: 1, // 設定が変わってカードのボタンが変わるときに増やす
  filter: 'all',
  transcriptOpen: false,
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
  const node = $('#toast');
  node.textContent = msg;
  node.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => node.classList.remove('show'), 2600);
}

function setStatus(msg, warn) {
  const node = $('#status');
  node.textContent = msg || '';
  node.classList.toggle('is-warn', !!warn);
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
const canSummary = () => AI.canSummarize(aiConfig());

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
  card.v = 1;
  card.fresh = true;
  if (card.kind === 'term') {
    remember(state.marks, card.term);
    if (!card.offline) remember(state.shownTerms, card.term);
  }
  state.cards.unshift(card);
  if (state.cards.length > FEED_MAX) state.cards.length = FEED_MAX;
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
  state.lines.push({ id: uid(), text });
  if (state.lines.length > 60) state.lines.shift();
  state.interim = '';
  if (aiActive()) {
    state.ai.pending.push(text);
    scheduleAI();
  } else {
    detectOffline([text]);
  }
  renderFeed();
  renderTranscript();
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
    renderFeed();
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
    renderFeed();
    renderTranscript();
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

// ---------- 部品 ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, onClick, cls) {
  const b = el('button', 'pill' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function svgIcon(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  });
  return svg;
}

// ---------- カードの描画 ----------
function cardVersion(card) {
  return (card.v || 0) + ':' + state.ui;
}

function fillCard(node, card, mode) {
  const risk = card.kind === 'risk';
  const fresh = node.classList.contains('is-fresh');
  node.className = 'card' + (risk ? ' risk-' + card.level : '') + (fresh ? ' is-fresh' : '');
  const parts = [];

  if (mode === 'live') {
    const x = el('button', 'card-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'このカードを閉じる');
    x.append(svgIcon(['M6 6l12 12M18 6L6 18']));
    x.addEventListener('click', () => dismissCard(card.id));
    parts.push(x);
  }

  const head = el('div', 'card-head');
  head.append(el('h3', 'card-title', card.title));
  if (card.sub) head.append(el('span', 'card-sub', card.sub));
  if (risk) head.append(el('span', 'card-tag', card.level === 'red' ? '要注意' : '確認'));
  if (mode === 'saved') {
    const st = card.status || 'new';
    head.append(el('span', 'status-pill st-' + st, STATUS_LABEL[st]));
  }
  parts.push(head, el('p', 'card-body', card.body));
  if (card.quote) parts.push(el('p', 'card-quote', '「' + card.quote + '」'));
  if (card.detail) {
    parts.push(el('p', 'card-detail' + (card.detail.error ? ' is-error' : '') + (card.detail.loading ? ' is-loading' : ''), card.detail.text));
  }
  if (card.summary && card.summary.items && card.summary.items.length) {
    const teaser = el('button', 'card-summary');
    teaser.type = 'button';
    teaser.append(el('span', 'k', '要点 ›'), el('span', 'v', card.summary.items.map((i) => i.text).join(' / ')));
    teaser.addEventListener('click', () => openSummary(card));
    parts.push(teaser);
  }

  const actions = el('div', 'card-actions');
  if (mode === 'live') {
    actions.append(button(risk ? '確認事項に保存' : '保存', () => saveCard(card), 'primary'));
    if (!risk) {
      actions.append(button('知っている', () => markKnown(card)));
      actions.append(button('詳しく', () => explainCard(card)));
      if (canSummary()) actions.append(button('要点', () => openSummary(card), 'accent'));
    }
    parts.push(actions);
  } else {
    const next = NEXT_STATUS[card.status || 'new'];
    actions.append(button(next === 'new' ? '新しいに戻す' : STATUS_LABEL[next] + 'にする', () => cycleStatus(card.id)));
    if (!risk) {
      actions.append(button('詳しく', () => explainCard(card)));
      if (canSummary()) actions.append(button('要点', () => openSummary(card), 'accent'));
    }
    actions.append(button('チャットで聞く', () => askInChat(card)));
    actions.append(button('削除', () => deleteSaved(card.id), 'danger'));
    const memo = el('textarea');
    memo.placeholder = 'メモ';
    memo.value = card.memo || '';
    memo.addEventListener('change', () => { card.memo = memo.value; persistSaved(); });
    parts.push(actions, memo);
  }
  node.replaceChildren(...parts);
}

function buildCard(card, mode) {
  const node = el('article', 'card');
  if (mode === 'live' && card.fresh) {
    node.classList.add('is-fresh');
    card.fresh = false;
    node.addEventListener('animationend', () => node.classList.remove('is-fresh'), { once: true });
  }
  fillCard(node, card, mode);
  node.dataset.v = cardVersion(card);
  return node;
}

function patchCard(node, card, mode) {
  const v = cardVersion(card);
  if (node.dataset.v === v) return;
  node.dataset.v = v;
  patchWithHeight(node, () => fillCard(node, card, mode));
}

function renderFeed() {
  const wrap = $('#feedWrap');
  const list = $('#cards');
  const keepTop = wrap.scrollTop < 40;
  const beforeHeight = list.offsetHeight;
  const added = syncList(list, state.cards, {
    key: (c) => c.id,
    build: (c) => buildCard(c, 'live'),
    patch: (node, c) => patchCard(node, c, 'live'),
  });
  // 読み返している最中に新しいカードが来ても、読んでいる場所がずれないようにする
  if (added && !keepTop) wrap.scrollTop += list.offsetHeight - beforeHeight;
  const empty = $('#cardsEmpty');
  const wasHidden = empty.hidden;
  empty.hidden = state.cards.length > 0;
  if (wasHidden && !empty.hidden) play(empty, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 360 });
}

function renderSaved() {
  $('#savedCount').textContent = state.saved.length;
  const list = state.saved.filter((c) => state.filter === 'all' || (c.status || 'new') === state.filter);
  syncList($('#savedList'), list, {
    key: (c) => c.id,
    build: (c) => buildCard(c, 'saved'),
    patch: (node, c) => patchCard(node, c, 'saved'),
  });
  $('#savedEmpty').hidden = list.length > 0;
}

// ---------- 文字起こしの描画(新しい行だけを足す) ----------
const lineNodes = new Map();

function fillLine(node, segs) {
  node.replaceChildren(...segs.map((s) => (s.mark ? el('mark', null, s.text) : document.createTextNode(s.text))));
}

function renderTranscript() {
  const box = $('#transcript');
  const interimNode = $('#interimLine');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  const ids = new Set(state.lines.map((l) => l.id));
  lineNodes.forEach((node, id) => {
    if (!ids.has(id)) {
      node.remove();
      lineNodes.delete(id);
    }
  });
  for (const line of state.lines) {
    const segs = Detect.markSegments(line.text, state.marks);
    const sig = segs.map((s) => (s.mark ? '*' : '') + s.text).join('|');
    let node = lineNodes.get(line.id);
    if (!node) {
      node = el('p', 'line');
      lineNodes.set(line.id, node);
      box.insertBefore(node, interimNode);
      fillLine(node, segs);
      node.dataset.sig = sig;
      play(node, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320 });
    } else if (node.dataset.sig !== sig) {
      fillLine(node, segs);
      node.dataset.sig = sig;
    }
  }
  if (interimNode.textContent !== state.interim) interimNode.textContent = state.interim;
  interimNode.hidden = !state.interim;
  if (nearBottom) box.scrollTo({ top: box.scrollHeight, behavior: motionOK() ? 'smooth' : 'auto' });
}

function updateBusy() {
  $('#busyBar').classList.toggle('is-on', state.ai.busy || state.summaryBusy > 0);
}

function updateAiUi() {
  const b = $('#aiToggle');
  const meta = AI.PROVIDERS[state.settings.provider];
  b.classList.remove('is-on', 'is-off', 'is-warn', 'is-busy');
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
    if (state.ai.busy) b.classList.add('is-busy');
    b.title = meta.label + 'に、文字起こしの直近の文を送っています。押すとオフにします。';
  } else {
    b.textContent = 'AIオフ';
    b.classList.add('is-off');
    b.title = 'オフの間は、会話を送りません。押すとオンにします。';
  }
  $('#setupBanner').hidden = aiReady();
  updateBusy();
}

// ---------- カードの操作 ----------
function dismissCard(id) {
  state.cards = state.cards.filter((c) => c.id !== id);
  renderFeed();
}

function saveCard(card) {
  const exists = state.saved.some((s) => s.key === card.key);
  if (!exists) {
    state.saved.unshift({
      id: uid(), key: card.key, kind: card.kind, term: card.term, title: card.title, sub: card.sub,
      body: card.body, quote: card.quote, level: card.level,
      detail: card.detail && !card.detail.loading ? card.detail : null,
      summary: card.summary || null,
      ts: Date.now(), status: 'new', memo: '', v: 1,
    });
    persistSaved();
    const badge = $('#savedCount');
    badge.classList.remove('bump');
    void badge.offsetWidth;
    badge.classList.add('bump');
  }
  state.cards = state.cards.filter((c) => c.id !== card.id);
  renderFeed();
  renderSaved();
  toast(exists ? 'すでに保存されています' : '保存しました');
}

function markKnown(card) {
  const term = card.term.toLowerCase();
  state.known.add(term);
  persistKnown();
  state.cards = state.cards.filter((c) => !(c.kind === 'term' && c.term.toLowerCase() === term));
  renderFeed();
  toast('「' + card.term + '」は、今後出しません');
}

function cycleStatus(id) {
  const c = state.saved.find((s) => s.id === id);
  if (!c) return;
  c.status = NEXT_STATUS[c.status || 'new'];
  c.v = (c.v || 0) + 1;
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

// 表示中と保存済みの両方にある同じカードへ、変更をそろえる
function updateCopies(key, apply) {
  [...state.cards, ...state.saved].forEach((c) => {
    if (c.key === key) {
      apply(c);
      c.v = (c.v || 0) + 1;
    }
  });
}

function setDetail(card, detail) {
  updateCopies(card.key, (c) => { c.detail = detail; });
  if (!detail.loading) persistSaved();
  renderFeed();
  renderSaved();
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
    const summary = c.summary && c.summary.items && c.summary.items.length
      ? '要点: ' + c.summary.items.map((i) => (i.label ? i.label + ': ' : '') + i.text).join(' / ')
      : '';
    return [
      '■ ' + c.title + (c.sub ? '(' + c.sub + ')' : ''),
      c.body,
      c.detail && !c.detail.error ? '詳しく: ' + c.detail.text : '',
      summary,
      c.quote ? '場面: ' + c.quote : '',
      c.memo ? 'メモ: ' + c.memo : '',
      d + ' / ' + STATUS_LABEL[c.status || 'new'],
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  if (!text) { toast('コピーするカードがありません'); return; }
  copyText(text).then(() => toast('一覧をコピーしました'), () => toast('コピーできませんでした'));
}

// ---------- 要点(Google検索で確かめた3行) ----------
const sheet = { open: false, card: null };
const runs = new Map(); // カードの key → 作成中の要点

function findCard(key) {
  return state.cards.find((c) => c.key === key) || state.saved.find((c) => c.key === key) || null;
}

function openSummary(card) {
  if (!canSummary()) {
    toast('「要点」は、いまはGeminiで使えます。設定でGeminiを選んでください');
    return;
  }
  if (!aiReady() || state.ai.halted) {
    showView('settings');
    toast('先に、AIの設定を確かめてください');
    return;
  }
  if (!state.settings.aiEnabled) {
    toast('AIがオフです。オンにすると「要点」を作れます');
    return;
  }
  sheet.card = card;
  const fresh = card.summary && Date.now() - (card.summary.at || 0) < SUMMARY_FRESH_MS;
  if (!fresh && !runs.has(card.key)) startSummary(card, state.settings.summaryModel);
  openSheet();
  renderSheet();
}

async function startSummary(card, model) {
  const run = { model, phase: 'waiting', text: '', error: null };
  runs.set(card.key, run);
  state.summaryBusy++;
  updateBusy();
  if (sheet.card && sheet.card.key === card.key) renderSheet();
  try {
    const result = await AI.summarize(aiConfig(), card.term, card.quote, {
      model,
      today: todayString(),
      onText: (text) => {
        if (runs.get(card.key) !== run) return;
        run.phase = 'streaming';
        run.text = text;
        if (sheet.open && sheet.card && sheet.card.key === card.key) renderSummaryItems(parseSummary(text), true);
      },
    });
    if (runs.get(card.key) !== run) return;
    runs.delete(card.key);
    const summary = {
      items: parseSummary(result.text), sources: result.sources, suggestionHtml: result.suggestionHtml,
      model: result.model, at: Date.now(), truncated: result.truncated,
    };
    updateCopies(card.key, (c) => { c.summary = summary; });
    persistSaved();
    renderFeed();
    renderSaved();
  } catch (e) {
    if (runs.get(card.key) !== run) return;
    run.phase = 'error';
    run.error = e;
  } finally {
    state.summaryBusy--;
    updateBusy();
    if (sheet.open && sheet.card && sheet.card.key === card.key) renderSheet();
  }
}

function retrySummary(model) {
  const card = sheet.card && (findCard(sheet.card.key) || sheet.card);
  if (!card) return;
  runs.delete(card.key);
  startSummary(card, model || state.settings.summaryModel);
}

function renderSummaryItems(items, typing) {
  const list = $('#sumList');
  while (list.children.length > items.length) list.lastElementChild.remove();
  items.forEach((item, i) => {
    let node = list.children[i];
    if (!node) {
      node = el('div', 'sum-item');
      node.append(el('span', 'sum-label'), el('p', 'sum-text'));
      list.append(node);
      play(node, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 380 });
    }
    const label = node.firstElementChild;
    const text = node.lastElementChild;
    label.textContent = item.label;
    label.hidden = !item.label;
    if (text.textContent !== item.text) text.textContent = item.text;
    text.classList.toggle('typing', !!typing && i === items.length - 1);
  });
  $('#sumWaiting').hidden = items.length > 0 || !typing;
}

let shownSuggestHtml = '';
function renderSuggest(html) {
  const box = $('#sumSuggest');
  if (!html) {
    box.hidden = true;
    box.replaceChildren();
    shownSuggestHtml = '';
    return;
  }
  box.hidden = false;
  if (html === shownSuggestHtml) return;
  // Googleの「検索候補」は、指定どおりの見た目で出す必要がある。
  // 中身は外部のHTMLなので、スクリプトを動かさない別枠(sandbox)の中に表示する
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('title', 'Google検索の候補');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">'
    + '<style>html,body{margin:0;background:transparent}</style></head><body>' + html + '</body></html>';
  box.replaceChildren(frame);
  shownSuggestHtml = html;
}

function renderSheet() {
  if (!sheet.open || !sheet.card) return;
  const card = findCard(sheet.card.key) || sheet.card;
  const run = runs.get(card.key);
  const summary = card.summary;
  $('#sheetTitle').textContent = card.title;
  $('#sheetQuote').textContent = card.quote ? '「' + card.quote + '」' : '';

  const waiting = !!run && run.phase === 'waiting';
  const streaming = !!run && run.phase === 'streaming';
  const error = run && run.phase === 'error' ? run.error : null;
  $('#sumWaitingText').textContent = 'Google検索で確かめています…(' + ((run && run.model) || '') + ')';
  $('#sumWaiting').hidden = !waiting;

  let items = [];
  if (run) items = parseSummary(run.text);
  else if (summary) items = summary.items || [];
  renderSummaryItems(items, streaming);
  if (waiting) $('#sumWaiting').hidden = false;

  const errNode = $('#sumError');
  errNode.hidden = !error;
  errNode.textContent = error ? error.message : '';

  const done = !run && summary;
  const meta = $('#sumMeta');
  meta.hidden = !done;
  if (done) {
    const at = new Date(summary.at);
    meta.textContent = at.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      + ' の検索結果・' + summary.model + (summary.truncated ? '(途中で切れています)' : '');
  }
  const sources = done ? summary.sources || [] : [];
  $('#sumSources').hidden = !sources.length;
  $('#sumSourceList').replaceChildren(...sources.map((s) => {
    const li = el('li');
    const a = el('a', null, s.title);
    a.href = s.uri;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a);
    return li;
  }));
  renderSuggest(done ? summary.suggestionHtml : '');

  const retry = $('#sheetRetry');
  retry.hidden = !(error || done);
  retry.textContent = error ? 'やり直す' : '最新にする';
  $('#sheetFast').hidden = !(error && run && run.model !== FAST_SUMMARY_MODEL);
  const saved = state.saved.some((s) => s.key === card.key);
  const save = $('#sheetSave');
  save.textContent = saved ? '保存済み' : '保存';
  save.disabled = saved;
}

function onSheetKey(e) {
  if (e.key === 'Escape') closeSheet();
}

function openSheet() {
  const s = $('#sheet');
  const b = $('#sheetBackdrop');
  if (sheet.open) return;
  sheet.open = true;
  $('#sumList').replaceChildren();
  s.hidden = false;
  b.hidden = false;
  s.style.transform = '';
  s.getAnimations && s.getAnimations().forEach((a) => a.cancel());
  b.getAnimations && b.getAnimations().forEach((a) => a.cancel());
  play(b, [{ opacity: 0 }, { opacity: 1 }], { duration: 280 });
  play(s, [{ transform: isWide() ? 'translateX(100%)' : 'translateY(100%)' }, { transform: 'none' }], { duration: 480, easing: EASE_SHEET });
  document.addEventListener('keydown', onSheetKey);
  $('#sheetClose').focus({ preventScroll: true });
}

function closeSheet() {
  if (!sheet.open) return;
  sheet.open = false;
  const s = $('#sheet');
  const b = $('#sheetBackdrop');
  const from = s.style.transform || 'none';
  const finish = () => {
    s.hidden = true;
    b.hidden = true;
    s.style.transform = '';
    s.getAnimations && s.getAnimations().forEach((a) => a.cancel());
    b.getAnimations && b.getAnimations().forEach((a) => a.cancel());
  };
  const anim = play(s, [{ transform: from }, { transform: isWide() ? 'translateX(100%)' : 'translateY(100%)' }], { duration: 300, easing: EASE_IN, fill: 'forwards' });
  play(b, [{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
  if (anim) anim.onfinish = finish;
  else finish();
  document.removeEventListener('keydown', onSheetKey);
  sheet.card = null;
}

// スマホでは、シートを下に引っぱって閉じられる
function bindSheetDrag() {
  const s = $('#sheet');
  let dragging = false;
  let startY = 0;
  let dy = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  const down = (e) => {
    if (isWide() || e.target.closest('button')) return;
    dragging = true;
    startY = e.clientY;
    lastY = e.clientY;
    lastT = performance.now();
    dy = 0;
    velocity = 0;
  };
  const move = (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    const now = performance.now();
    velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY;
    lastT = now;
    s.style.transform = 'translateY(' + dy + 'px)';
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    if (dy > 110 || velocity > 0.6) {
      closeSheet();
    } else {
      const from = s.style.transform;
      s.style.transform = '';
      play(s, [{ transform: from || 'none' }, { transform: 'none' }], { duration: 320, easing: EASE_SHEET });
    }
  };
  ['#sheetGrip', '#sheetHead'].forEach((sel) => $(sel).addEventListener('pointerdown', down));
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
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
    setStatus('このブラウザは、音声認識に対応していません。文字起こし欄の入力欄から試せます。', true);
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
  b.classList.toggle('is-live', state.listening);
  b.setAttribute('aria-pressed', String(state.listening));
  $('#listenLabel').textContent = state.listening ? '聞いています(押すと停止)' : '聞き取り開始';
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
  state.cards = [];
  state.marks = [];
  state.shownTerms = [];
  state.seen.clear();
  setStatus(baseStatus());
  // たくさんのカードは、1枚ずつではなく、まとめて薄くして消す
  const list = $('#cards');
  const box = $('#transcript');
  const fades = [
    play(list, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 220, easing: EASE_IN, fill: 'forwards' }),
    play(box, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }),
  ].filter(Boolean);
  const reset = () => {
    list.replaceChildren();
    lineNodes.forEach((node) => node.remove());
    lineNodes.clear();
    renderFeed();
    renderTranscript();
    // 中身を消してから、薄くした状態を元に戻す(古いカードが一瞬見えないように)
    fades.forEach((a) => a.cancel());
  };
  if (fades.length) fades[0].onfinish = reset;
  else reset();
}

// ---------- 画面の切り替え ----------
function showView(name) {
  const next = $('#view-' + name);
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  if (name === 'saved') renderSaved();
  if (name === 'settings') renderSettings();
  if (next.classList.contains('is-active')) return;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v === next));
  play(next, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
}

function toggleTranscript(force) {
  const panel = $('#transcriptPanel');
  const open = typeof force === 'boolean' ? force : !panel.classList.contains('is-expanded');
  panel.classList.toggle('is-expanded', open);
  $('#transcriptToggle').setAttribute('aria-expanded', String(open));
  state.transcriptOpen = open;
  const box = $('#transcript');
  setTimeout(() => box.scrollTo({ top: box.scrollHeight, behavior: motionOK() ? 'smooth' : 'auto' }), 60);
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

  const summaryRow = $('#summaryRow');
  summaryRow.hidden = !meta.summaryModels;
  if (meta.summaryModels) {
    const select = $('#summarySelect');
    const models = meta.summaryModels.slice();
    if (!models.some((m) => m.id === state.settings.summaryModel)) {
      models.push({ id: state.settings.summaryModel, label: state.settings.summaryModel });
    }
    select.replaceChildren(...models.map((m) => {
      const o = el('option', null, m.label);
      o.value = m.id;
      return o;
    }));
    select.value = state.settings.summaryModel;
  }

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

// カードのボタン(「要点」など)が変わるので、描き直す
function refreshCardButtons() {
  state.ui++;
  renderFeed();
  renderSaved();
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
  setTestResult('確認しています…(最大60秒)');
  try {
    const { result, ms } = await AI.testConnection(aiConfig());
    state.ai.halted = '';
    const terms = result.terms.map((t) => t.term + ':' + t.meaning).join(' / ');
    const risks = result.risks.map((r) => r.label).join('・');
    const slow = ms > SLOW_TEST_MS;
    setTestResult(
      'つながりました(' + (ms / 1000).toFixed(1) + '秒)。'
      + (terms ? ' 用語 ' + terms + '。' : ' 用語は見つかりませんでした。')
      + (risks ? ' 注意点 ' + risks + '。' : '')
      + (slow ? ' ただし、応答が遅いため、会議中はカードが遅れて出ます。速いモデル(Gemini 3.5 Flash-Lite、Claude Haiku 4.5など)をおすすめします。' : ''),
      slow ? 'warn' : 'ok',
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
  $('#transcriptToggle').addEventListener('click', () => toggleTranscript());
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
    renderFeed();
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

  // 要点のシート
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheetDone').addEventListener('click', closeSheet);
  $('#sheetRetry').addEventListener('click', () => retrySummary());
  $('#sheetFast').addEventListener('click', () => retrySummary(FAST_SUMMARY_MODEL));
  $('#sheetSave').addEventListener('click', () => {
    const card = sheet.card && findCard(sheet.card.key);
    if (card && !state.saved.some((s) => s.key === card.key)) {
      saveCard(card);
      renderSheet();
    }
  });
  bindSheetDrag();

  // AIの設定
  $('#providerSelect').addEventListener('change', (e) => {
    state.settings.provider = e.target.value;
    persistSettings();
    renderSettings();
    onAiSettingChanged();
    refreshCardButtons();
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
  $('#summarySelect').addEventListener('change', (e) => {
    state.settings.summaryModel = e.target.value;
    persistSettings();
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

persistSettings(); // 設定の版の切り替えを、保存しておく
applyDisplaySettings();
bind();
renderSettings();
updateAiUi();
renderFeed();
renderSaved();
renderTranscript();
if (!SR) setStatus('このブラウザは、音声認識に対応していません。文字起こし欄から入力して試せます。', true);
