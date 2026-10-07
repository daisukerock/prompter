import * as Detect from './detect.js';
import * as AI from './ai/index.js';
import * as Backup from './backup.js';
import * as Pacing from './pacing.js';
import * as Recovery from './recovery.js';
import * as Gate from './gate.js';
import * as Jev from './ai/jev.js';
import * as Whisper from './ai/whisper.js';
import * as Sound from './audio.js';
import * as Capture from './capture.js';
import * as SttQueue from './sttqueue.js';
import { parseSummary, todayString } from './ai/common.js';

const $ = (s) => document.querySelector(s);
const BUILD = 'dev'; // 公開するときに、版(コミット)に置き換わる(tools/stamp-version.mjs)
const FEED_MAX = 40; // 画面に残すカードの数
const DEDUPE_MS = 5 * 60 * 1000;
const AI_WAIT_MS = 1200; // 話の区切りを待ってから、まとめて送る
const AI_FLUSH_CHARS = 120; // これ以上たまったら、待たずに送る
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
  // 保存できなかったら false を返し、画面で知らせる(黙って失わないように)
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      storageFailed(e);
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* 無視 */ }
  },
  // 保存している文字数(目安)
  size(key) {
    try { return (localStorage.getItem(key) || '').length; } catch (e) { return 0; }
  },
};

// このタブの間だけ残す保存場所(読み込み直しても残り、タブを閉じると消える)
const tabStore = {
  get(key, fallback) {
    try {
      const v = sessionStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 無視 */ }
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
    jev: false, jevLevel: Gate.DEFAULT_LEVEL, // 送る前の振り分け(Jev)
    stt: 'groq', sttModels: {}, sttHints: '', // 聞き取り(Whisper。キーがなければ、標準の聞き取り)
  }, saved);
  // 以前の版の設定(「AIに聞く」の行き先が ai に入っていた)を引き継ぐ
  if (saved.ai && !saved.chat && CHAT_SITES[saved.ai]) s.chat = saved.ai;
  delete s.ai;
  delete s.autoWiki;
  if (!AI.PROVIDERS[s.provider]) s.provider = 'claude';
  if (!Object.prototype.hasOwnProperty.call(Gate.LEVELS, s.jevLevel)) s.jevLevel = Gate.DEFAULT_LEVEL;
  if (s.stt !== 'browser' && !Whisper.sttProvider(s.stt)) s.stt = 'groq';
  s.sttModels = Object.assign(Object.fromEntries(Object.entries(Whisper.STT_PROVIDERS).map(([id, w]) => [id, w.defaultModel])), s.sttModels);
  if (typeof s.sttHints !== 'string') s.sttHints = '';
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
  keys: {}, // AIサービスごとのAPIキー(JevのキーはTypeSafeの jev)。すぐ下の loadKeys で読む
  // interval: 送る間隔(上限にかかると広げる)、failures: 通信の失敗が続いた回数
  ai: { pending: [], timer: null, busy: false, halted: '', nextAt: 0, interval: Pacing.MIN_INTERVAL, failures: 0 },
  // 送る前の振り分け(Jev)。止めた理由などのほかに、判定した回数・AIに送らなかった回数と、AIに送った英字の略語を持つ
  jev: Object.assign(Gate.initialGate(), { judged: 0, skipped: 0, sentAcronyms: new Set() }),
  summaryBusy: 0,
  usage: {}, // この画面を開いてから使ったトークン(種類ごと)
  sttUsage: {}, // この画面を開いてから、聞き取り(Whisper)に送った音声(サービス・モデルごと)
  ui: 1, // 設定が変わってカードのボタンが変わるときに増やす
  filter: 'all',
  transcriptOpen: false,
};

state.keys = loadKeys(state.settings.rememberKey);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const persistSaved = () => store.set('pl_saved', Backup.compactSaved(state.saved, Date.now(), SUMMARY_FRESH_MS));
const persistKnown = () => store.set('pl_known', [...state.known]);
const persistSettings = () => store.set('pl_settings', state.settings);
// APIキーは、読み込み直しても消えないように、いつもこのタブにも控えておく。
// 「この端末に保存する」がオンなら端末にも保存し、オフなら、タブを閉じたときに消える
function loadKeys(remember) {
  const asKeys = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const tab = asKeys(tabStore.get('pl_keys', null));
  if (!remember) return tab;
  // 端末に保存したキーを優先し、端末に保存できなかったキー(保存領域がいっぱい、など)は、このタブの控えで補う
  return Object.assign({}, tab, asKeys(store.get('pl_keys', null)));
}

function persistKeys() {
  tabStore.set('pl_keys', state.keys);
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
  if (state.listening && listen.shown === 'starting') return 'マイクを準備しています…(許可を求められたら「許可」を押してください)';
  if (state.listening && listen.engine === 'whisper') return '聞いています…(Whisper・' + sttShort() + '。画面は点けたままにしてください)';
  if (state.listening && whisper.off) return '聞いています…(標準の聞き取り。Whisperは止めています)';
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
const jevReady = () => !!String(state.keys.jev || '').trim();
const jevActive = () => !!state.settings.jev && jevReady() && !state.jev.halted;

// ---------- 使ったトークン ----------
const USAGE_KINDS = { analyze: '自動判定', gate: '振り分け(Jev)', explain: '詳しく', summary: '要点', test: '接続テスト' };
const TALLY_KEYS = ['n', 'input', 'output', 'thinking', 'cached', 'searches'];
const numberFormat = new Intl.NumberFormat('ja-JP');
const fmt = (n) => numberFormat.format(Number(n) || 0);
const emptyTally = () => Object.fromEntries(TALLY_KEYS.map((k) => [k, 0]));

function addTally(tally, add) {
  TALLY_KEYS.forEach((k) => { tally[k] = (Number(tally[k]) || 0) + (Number(add[k]) || 0); });
  return tally;
}

// 大きな数は「万」でまとめる(例: 12,345 → 1.2万)
function compact(n) {
  const short = (v, unit) => v.toFixed(1).replace(/\.0$/, '') + unit;
  if (n >= 1e8) return short(n / 1e8, '億');
  if (n >= 1e4) return short(n / 1e4, '万');
  return fmt(n);
}

// 例: 「入力 1,234・出力 567(うち思考 120)」
function tokenText(u) {
  return '入力 ' + fmt(u.input) + '・出力 ' + fmt(u.output) + (u.thinking ? '(うち思考 ' + fmt(u.thinking) + ')' : '');
}

// 例: 「使ったトークン: 入力 1,234・出力 567・Google検索 2回」。サービスが返した数だけを書く
function describeUsage(u) {
  const parts = [];
  if (u.input || u.output) parts.push('使ったトークン: ' + tokenText(u));
  if (u.searches) parts.push('Google検索 ' + fmt(u.searches) + '回');
  return parts.join('・');
}

// 今日の分(端末の日付で区切る)。別のタブで足した分を消さないよう、足す前に読み直す
function loadTodayUsage() {
  const saved = store.get('pl_usage', null);
  const date = todayString();
  if (saved && saved.date === date && saved.models && typeof saved.models === 'object' && !Array.isArray(saved.models)) return saved;
  return { date, models: {} };
}

function recordUsage(kind, usage) {
  if (!usage) return;
  const one = Object.assign({}, usage, { n: 1 });
  addTally(state.usage[kind] || (state.usage[kind] = emptyTally()), one);
  const today = loadTodayUsage();
  const id = usage.provider + '/' + usage.model;
  if (!today.models[id]) today.models[id] = Object.assign({ provider: usage.provider, model: usage.model }, emptyTally());
  addTally(today.models[id], one);
  store.set('pl_usage', today);
  renderUsage();
}

// ---------- カードの作成 ----------
// 意味に自信がない語は、分かっていることだけを出し、確かめ方を添える
function unsureHint() {
  return canSummary()
    ? '意味は、まだはっきりしません。「要点」で、Google検索して確かめられます。'
    : '意味は、まだはっきりしません。「詳しく」で聞くか、あとで確かめてください。';
}

function aiTermCard(t, lines) {
  return {
    id: uid(), kind: 'term', key: 't:' + t.term.toLowerCase(), term: t.term,
    title: t.term, sub: t.full, body: t.meaning || unsureHint(), quote: Detect.lineContaining(lines, t.term), level: 'term',
    novel: !!t.novel, unsure: t.sure === false,
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

  // たまりすぎた分は、新しい発言を優先して送り、入りきらない古い分は簡易判定に回す
  const { send: batch, older } = Pacing.takeBatch(ai.pending.splice(0));
  if (older.length) detectOffline(older);
  const start = Math.max(0, state.lines.length - batch.length);
  const context = state.lines.slice(Math.max(0, start - CONTEXT_LINES), start).map((l) => l.text);
  const gen = state.gen;
  ai.busy = true;
  updateAiUi();
  let sent = false;
  try {
    // Jevが「知らない言葉も、気をつけたい点もなさそう」と判定した発言は、AIに送らない。
    // AIに送って済んだときと同じく、前の失敗の表示(「約20秒待ってから再開します」など)は消す
    if (!(await passesGate(batch))) {
      if (gen === state.gen) setStatus(baseStatus());
      return;
    }
    if (gen !== state.gen) return;
    // 判定を待つ間に、AIがオフになったときは、送らずに簡易判定で拾う
    if (!aiActive()) {
      detectOffline(batch);
      return;
    }
    sent = true;
    const result = await AI.analyze(aiConfig(), { context, utterance: batch.join('\n'), exclude: excludeList() }, {
      onUsage: (u) => recordUsage('analyze', u),
    });
    if (gen !== state.gen) return;
    const termCards = result.terms.filter((t) => !isKnown(t.term)).map((t) => aiTermCard(t, batch));
    const riskCards = result.risks.map((r) => aiRiskCard(r, batch));
    pushBatch(termCards, riskCards);
    ai.failures = 0;
    ai.interval = Pacing.relax(ai.interval);
    setStatus(baseStatus());
  } catch (e) {
    if (gen !== state.gen) return;
    handleAIError(e, batch);
  } finally {
    ai.busy = false;
    // 送る間隔は、AIに送ったときだけ空ける
    if (sent) ai.nextAt = Math.max(ai.nextAt, Date.now() + ai.interval);
    updateAiUi();
    renderFeed();
    renderTranscript();
    if (ai.pending.length) scheduleAI();
  }
}

// 送る前の振り分け。AIに送るなら true。
// Jevを使わないとき・つながらないときも true(取りこぼさないように、振り分けずに送る)
async function passesGate(batch) {
  const jev = state.jev;
  const text = batch.join('\n');
  // まだAIに送っていない英字の略語があれば、Jevに聞かずに送る
  const acronyms = Gate.acronymsIn(text);
  const fresh = acronyms.some((t) => !jev.sentAcronyms.has(t) && !isKnown(t));
  const send = fresh || !jevActive() || !Gate.canAsk(jev, Date.now()) || await askJev(text);
  if (send) acronyms.forEach((t) => jev.sentAcronyms.add(t));
  return send;
}

// Jevに聞く。AIに送るなら true(Jevで失敗したときも true)
async function askJev(text) {
  const jev = state.jev;
  try {
    const verdict = await Jev.judge(state.keys.jev, text, { onUsage: (u) => recordUsage('gate', u) });
    const recovered = !!jev.trouble;
    Object.assign(jev, Gate.afterSuccess(jev));
    const send = Gate.wantsAI(verdict, state.settings.jevLevel);
    jev.judged++;
    if (!send) jev.skipped++;
    if (recovered) setJevResult('');
    renderUsage();
    return send;
  } catch (e) {
    jevFailed(e);
    return true;
  }
}

// Jevで失敗したとき。止めたときと、つながらないのが続いたときに、1回だけ知らせる
function jevFailed(e) {
  const jev = state.jev;
  const before = { halted: jev.halted, trouble: jev.trouble };
  Object.assign(jev, Gate.afterFailure(jev, e, Date.now()));
  if (jev.halted && !before.halted) toast('Jevを止めました(設定を確認してください)。振り分けずにAIに送ります');
  else if (jev.trouble && !before.trouble) toast('Jevにつながらないため、振り分けずにAIに送っています');
  renderJevState();
  updateAiUi();
}

function handleAIError(e, batch) {
  const ai = state.ai;
  const code = e && e.code;
  const msg = (e && e.message) || 'AIの呼び出しで、エラーが起きました。';
  if (['auth', 'permission', 'notfound', 'config', 'quota'].includes(code)) {
    // 設定を直すか、上限が戻るまでは送らない
    ai.halted = msg;
    setStatus(msg + ' いまは簡易判定で動いています。', true);
  } else if (code === 'ratelimit') {
    // 送る間隔を広げ、サービスが示した時間(なければ20秒)待つ
    ai.interval = Pacing.widen(ai.interval);
    const wait = Pacing.rateLimitWait(e.retryAfterMs);
    ai.nextAt = Date.now() + wait;
    setStatus('利用上限か混雑のため、約' + Math.ceil(wait / 1000) + '秒待ってから再開します。', true);
  } else if (['network', 'timeout', 'server'].includes(code)) {
    // 失敗が続くほど、長く待つ
    ai.failures++;
    const wait = Pacing.backoff(ai.failures);
    ai.nextAt = Date.now() + wait;
    setStatus(msg + ' 約' + Math.round(wait / 1000) + '秒後に、もう一度試します。', true);
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
  // まだ広く定着していない語・意味に自信がない語は、そのことが分かるようにする
  if (!risk && card.novel) head.append(el('span', 'card-tag tag-new', '新しい言葉'));
  if (!risk && card.unsure) head.append(el('span', 'card-tag tag-unsure', '意味は要確認'));
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
  renderBackup();
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
    b.title = meta.label + 'に、文字起こしの直近の文を送っています。' + (jevActive() ? '送る前に、Jevで振り分けています。' : '') + '押すとオフにします。';
  } else {
    b.textContent = 'AIオフ';
    b.classList.add('is-off');
    b.title = 'オフの間は、会話を送りません。押すとオンにします。';
  }
  $('#setupBanner').hidden = aiReady();
  updateBusy();
}

// ---------- 使ったトークンの表示 ----------
// 数字を、いま出ている値から、なめらかに数え上げる(記録を消したときは、すぐに戻す)
const counter = { shown: 0, raf: 0 };
function countTo(node, to) {
  cancelAnimationFrame(counter.raf);
  const from = counter.shown;
  if (!motionOK() || to <= from) {
    counter.shown = to;
    node.textContent = compact(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 700);
    counter.shown = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    node.textContent = compact(counter.shown);
    if (t < 1) counter.raf = requestAnimationFrame(step);
  };
  counter.raf = requestAnimationFrame(step);
}

// 回数・入力・出力の表と、その下の補足
function usageBlock(head, rows, total) {
  const line = (label, t) => {
    const tr = el('tr');
    const th = el('th', null, label);
    th.scope = 'row';
    tr.append(th, el('td', null, fmt(t.n)), el('td', null, fmt(t.input)), el('td', null, fmt(t.output)));
    return tr;
  };
  const headRow = el('tr');
  [head, '回数', '入力', '出力'].forEach((h) => {
    const th = el('th', null, h);
    th.scope = 'col';
    headRow.append(th);
  });
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  rows.forEach(([label, t]) => tbody.append(line(label, t)));
  const table = el('table', 'usage-table');
  table.append(thead, tbody);
  if (rows.length > 1) {
    const tfoot = el('tfoot');
    tfoot.append(line('合計', total));
    table.append(tfoot);
  }
  const notes = [];
  if (total.thinking) notes.push('出力のうち、AIが考えた分 ' + fmt(total.thinking));
  if (total.cached) notes.push('入力のうち、キャッシュから読んだ分 ' + fmt(total.cached));
  if (total.searches) notes.push('Google検索 ' + fmt(total.searches) + '回');
  return notes.length ? [table, el('p', 'note', notes.join('。') + '。')] : [table];
}

function renderUsage() {
  const rows = Object.keys(USAGE_KINDS)
    .filter((k) => state.usage[k] && state.usage[k].n)
    .map((k) => [USAGE_KINDS[k], state.usage[k]]);
  const total = rows.reduce((sum, [, t]) => addTally(sum, t), emptyTally());
  const tokens = total.input + total.output;

  // 聞く画面の小さな表示(この画面を開いてからの合計)
  const chip = $('#usageChip');
  const appearing = chip.hidden && tokens > 0;
  chip.hidden = tokens === 0;
  $('.live-status').classList.toggle('has-usage', tokens > 0);
  if (tokens > 0) chip.title = 'この画面を開いてから使ったトークン: ' + tokenText(total) + '。' + (gateText() ? gateText() + '。' : '') + '押すと内訳を出します';
  if (appearing) play(chip, [{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'none' }], { duration: 380 });
  countTo($('#usageValue'), tokens);

  // 設定画面の表
  const session = rows.length ? usageBlock('種類', rows, total) : [el('p', 'note', 'まだ使っていません。')];
  if (gateText()) session.push(el('p', 'note gate-stats', gateText() + '。'));
  const sttSession = sttUsageText(state.sttUsage);
  if (sttSession) session.push(el('p', 'note stt-stats', '聞き取り(Whisper): ' + sttSession + '。'));
  $('#usageSession').replaceChildren(...session);
  const today = loadTodayUsage();
  const models = Object.values(today.models)
    .filter((m) => m && Number(m.n) > 0)
    .sort((a, b) => b.n - a.n);
  const d = new Date();
  $('#usageTodayTitle').textContent = '今日(' + (d.getMonth() + 1) + '月' + d.getDate() + '日)、モデルごと';
  const modelRows = models.map((m) => [String(m.model || '不明') + (m.provider === 'compatible' ? '(互換AI)' : ''), m]);
  const modelTotal = models.reduce((sum, m) => addTally(sum, m), emptyTally());
  const todayBlocks = models.length ? usageBlock('モデル', modelRows, modelTotal) : [el('p', 'note', 'まだ使っていません。')];
  const sttToday = sttUsageText(today.stt);
  if (sttToday) todayBlocks.push(el('p', 'note stt-stats', '聞き取り(Whisper): ' + sttToday + '。'));
  $('#usageToday').replaceChildren(...todayBlocks);
}

// 例: 「3分20秒」「1時間5分」
function durationText(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s >= 3600) return Math.floor(s / 3600) + '時間' + Math.floor((s % 3600) / 60) + '分';
  if (s >= 60) return Math.floor(s / 60) + '分' + (s % 60) + '秒';
  return s + '秒';
}

// 例: 「whisper-large-v3 12回・音声 3分20秒」(モデルごと、「/」で区切る)
function sttUsageText(tally) {
  const rows = Object.values(tally && typeof tally === 'object' ? tally : {}).filter((t) => t && Number(t.n) > 0);
  return rows.map((t) => String(t.model || '不明') + ' ' + fmt(t.n) + '回・音声 ' + durationText(t.seconds)).join(' / ');
}

// 聞き取り(Whisper)に送った音声を数える(この画面を開いてからと、今日の分)
function recordSttUsage(u) {
  if (!u) return;
  const id = u.provider + '/' + u.model;
  const add = (tally) => {
    const t = tally[id] || (tally[id] = { provider: u.provider, model: u.model, n: 0, seconds: 0 });
    t.n = (Number(t.n) || 0) + 1;
    t.seconds = (Number(t.seconds) || 0) + (Number(u.seconds) || 0);
  };
  add(state.sttUsage);
  const today = loadTodayUsage();
  if (!today.stt || typeof today.stt !== 'object' || Array.isArray(today.stt)) today.stt = {};
  add(today.stt);
  store.set('pl_usage', today);
  renderUsage();
}

// 例: 「Jevの振り分けで、AIに送らずに済んだ発言: 7回(判定 12回のうち)」
function gateText() {
  const { judged, skipped } = state.jev;
  return judged ? 'Jevの振り分けで、AIに送らずに済んだ発言: ' + fmt(skipped) + '回(判定 ' + fmt(judged) + '回のうち)' : '';
}

function showUsageDetail() {
  showView('settings');
  const group = $('#usageGroup');
  requestAnimationFrame(() => group.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' }));
  group.classList.remove('is-flash');
  void group.offsetWidth;
  group.classList.add('is-flash');
}

// ---------- カードの操作 ----------
function dismissCard(id) {
  state.cards = state.cards.filter((c) => c.id !== id);
  renderFeed();
}

function saveCard(card) {
  const exists = state.saved.some((s) => s.key === card.key);
  let stored = true;
  if (!exists) {
    state.saved.unshift({
      id: uid(), key: card.key, kind: card.kind, term: card.term, title: card.title, sub: card.sub,
      body: card.body, quote: card.quote, level: card.level, novel: !!card.novel, unsure: !!card.unsure,
      detail: card.detail && !card.detail.loading ? card.detail : null,
      summary: card.summary || null,
      ts: Date.now(), status: 'new', memo: '', v: 1,
    });
    stored = persistSaved();
    requestPersist();
    const badge = $('#savedCount');
    badge.classList.remove('bump');
    void badge.offsetWidth;
    badge.classList.add('bump');
  }
  state.cards = state.cards.filter((c) => c.id !== card.id);
  renderFeed();
  renderSaved();
  toast(exists ? 'すでに保存されています' : stored ? '保存しました' : '画面には残しましたが、端末に保存できませんでした');
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
    const text = await AI.explain(aiConfig(), card.term, card.quote, { onUsage: (u) => recordUsage('explain', u) });
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
      '■ ' + c.title + (c.sub ? '(' + c.sub + ')' : '') + (c.novel ? '[新しい言葉]' : '') + (c.unsure ? '[意味は要確認]' : ''),
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

// ---------- 保存の失敗と、バックアップ ----------
let storageWarnedAt = 0;

// 端末に保存できなかったことを、画面の上に出して知らせる(続けて失敗しても、1分に1回まで)
function storageFailed(error) {
  const bar = $('#storageBanner');
  if (!bar || !bar.hidden || Date.now() - storageWarnedAt < 60000) return;
  storageWarnedAt = Date.now();
  const full = !!error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22 || error.code === 1014);
  $('#storageText').textContent = full
    ? '端末の保存領域がいっぱいで、保存できませんでした。保存カードを書き出してから、いらないカードを削除してください。'
    : 'この端末では、データを保存できませんでした(プライベートブラウズや、保存を止める設定など)。画面を閉じると、保存カードや設定が消えます。';
  bar.hidden = false;
  play(bar, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 300 });
}

// 保存カードを、ブラウザが勝手に消さないように頼む(対応しているブラウザだけ)
let persistAsked = false;
function requestPersist() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  navigator.storage.persisted().then((done) => done || navigator.storage.persist()).catch(() => {});
}

const isStandalone = () => !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone);

// 保存カードと「知っている」語を、ファイルに書き出す(APIキーと設定は入れない)
function exportBackup() {
  const data = Backup.makeBackup({ saved: state.saved, known: state.known });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = el('a');
  a.href = url;
  a.download = Backup.backupFileName();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  store.set('pl_backup', { at: Date.now() });
  renderBackup();
  toast(state.saved.length + '枚のカードを、ファイルに書き出しました');
}

// 書き出したファイルを読み込み、いまの保存カードに足す
async function importBackup(file) {
  if (!file) return;
  let merged;
  try {
    const data = Backup.parseBackup(await file.text(), { now: Date.now(), freshMs: SUMMARY_FRESH_MS, makeId: uid });
    merged = Backup.mergeSaved(state.saved, data.cards);
    state.saved = merged.saved;
    data.known.forEach((t) => state.known.add(t));
  } catch (e) {
    toast('読み込めませんでした。プロンプターで書き出したファイルを選んでください');
    return;
  }
  const stored = persistSaved();
  persistKnown();
  requestPersist();
  renderSaved();
  toast(!stored ? '読み込みましたが、端末に保存できませんでした'
    : merged.added + '枚を読み込みました' + (merged.skipped ? '(' + merged.skipped + '枚は、すでにありました)' : ''));
}

function renderBackup() {
  const info = store.get('pl_backup', null);
  const lastAt = info && info.at;
  const pending = Backup.unexportedCount(state.saved, lastAt);
  // 保存カードの画面: まだ書き出していないカードがあれば知らせる
  $('#backupHint').hidden = !pending;
  if (pending) $('#backupHintText').textContent = (lastAt ? '前回の書き出しの後に保存したカードが、' : 'まだ書き出していないカードが、') + pending + '枚あります。';
  // 設定画面
  const n = state.saved.length;
  const size = n ? '(約' + Math.max(1, Math.round(store.size('pl_saved') / 1024)) + 'KB)' : '';
  const when = lastAt
    ? '最後の書き出し: ' + new Date(lastAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '。'
    : 'まだ書き出していません。';
  $('#backupStatus').textContent = '保存カード ' + n + '枚' + size + '。' + when;
  $('#evictionNote').hidden = isStandalone();
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
  let used = null;
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
      onUsage: (u) => {
        used = u;
        recordUsage('summary', u);
      },
    });
    if (runs.get(card.key) !== run) return;
    runs.delete(card.key);
    const summary = {
      items: parseSummary(result.text), sources: result.sources, suggestionHtml: result.suggestionHtml,
      model: result.model, at: Date.now(), truncated: result.truncated,
      usage: used ? { input: used.input, output: used.output, thinking: used.thinking, searches: used.searches } : null,
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
    const used = summary.usage ? describeUsage(summary.usage) : '';
    meta.textContent = at.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      + ' の検索結果・' + summary.model + (summary.truncated ? '(途中で切れています)' : '')
      + (used ? '\n' + used : '');
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
// 聞き取りの様子。running: 認識器が動いている / shown: 画面に出している状態
// (off: 止めている、starting: マイクの準備中、on: 聞いている、recovering: 立て直し中)
// troubleSince: すぐ止まるようになった時刻(0なら調子よし)
const listen = {
  running: false, shown: 'off', startedAt: 0, failures: 0, lastError: '', troubleSince: 0,
  restartTimer: null, showTimer: null, healthyTimer: null,
  engine: 'browser', // browser: 標準の聞き取り(端末の音声認識) / whisper: Whisper
};
// Whisperで聞き取るときの様子。capture: マイク、queue: 送る順番を待っている発言、busy: 送っている途中、
// nextAt: 次に送ってよい時刻、failures: 続けて失敗した回数、succeeded: この画面で一度でも文字にできたか、
// off: Whisperを止めた理由(標準の聞き取りに切り替えた。設定を直すか、テストが通ると戻す)
const whisper = {
  capture: null, opening: false, openedAt: 0, session: 0, speaking: false, queue: [], busy: false, timer: null,
  nextAt: 0, failures: 0, succeeded: false, warned: false, off: '',
};
const WHISPER_NO_SOUND_MS = 3000; // マイクを開いてから、これだけ音が届かなければ、使えない扱いにする
const deadRecognizers = new WeakSet(); // 作り直して捨てた認識器(遅れて届く知らせは無視する)
const LISTEN_LABEL = {
  off: '聞き取り開始',
  starting: 'マイクを準備しています…',
  on: '聞いています(押すと停止)',
  recovering: '立て直しています(押すと停止)',
};

async function requestWake() {
  if (!state.settings.wake || !('wakeLock' in navigator)) return;
  try { state.wake = await navigator.wakeLock.request('screen'); } catch (e) { state.wake = null; }
}
function releaseWake() {
  if (state.wake) { state.wake.release().catch(() => {}); state.wake = null; }
}

// 画面に戻ったら、画面を点けたままにし直し、止まっていた聞き取りを立て直す
function onPageVisible() {
  if (document.visibilityState !== 'visible' || !state.listening) return;
  requestWake();
  if (listen.engine === 'whisper') ensureWhisperCapture();
  else if (!listen.running) openRecognizer();
}
document.addEventListener('visibilitychange', onPageVisible);
window.addEventListener('pageshow', onPageVisible);

function startListening() {
  const useWhisper = whisperReady();
  if (!useWhisper && !SR) {
    setStatus('このブラウザは、音声認識に対応していません。文字起こし欄の入力欄から試せます。', true);
    return;
  }
  state.listening = true;
  listen.failures = 0;
  listen.lastError = '';
  listen.troubleSince = 0;
  listen.engine = useWhisper ? 'whisper' : 'browser';
  setListenShown('starting');
  setStatus(baseStatus());
  if (useWhisper) startWhisper();
  else openRecognizer();
  requestWake();
}

// 認識器は使い回さず、毎回作り直す(止まったあとに使い回すと、動かないことがあるため)
function openRecognizer() {
  clearTimeout(listen.restartTimer);
  closeRecognizer();
  const rec = new SR();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onstart = () => {
    if (rec !== state.rec) return;
    listen.running = true;
    listen.startedAt = Date.now();
    if (!listen.troubleSince) {
      clearTimeout(listen.showTimer);
      setListenShown('on');
      setStatus(baseStatus());
      return;
    }
    // すぐ止まるのが続いたあとは、始まっただけでは戻さない。しばらく動き続けたら(または聞こえたら)戻す
    clearTimeout(listen.healthyTimer);
    listen.healthyTimer = setTimeout(() => {
      if (rec === state.rec && listen.running) markListenHealthy();
    }, Recovery.HEALTHY_RUN_MS);
  };
  rec.onresult = (ev) => {
    if (deadRecognizers.has(rec)) return;
    if (listen.troubleSince && rec === state.rec) markListenHealthy();
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) addFinalLine(r[0].transcript);
      else interim += r[0].transcript;
    }
    state.interim = state.listening ? interim : '';
    renderTranscript();
  };
  rec.onerror = (ev) => {
    if (rec !== state.rec) return;
    listen.lastError = ev.error;
    const fatal = Recovery.FATAL_ERRORS[ev.error];
    if (fatal) {
      stopListening();
      setStatus(fatal, true);
    }
    // それ以外(無音・通信など)は、止まったあと(onend)に立て直す
  };
  rec.onend = () => {
    if (rec !== state.rec) return;
    state.rec = null;
    listen.running = false;
    if (state.listening) scheduleRestart();
  };
  state.rec = rec;
  try {
    rec.start();
  } catch (e) {
    state.rec = null;
    scheduleRestart();
  }
}

// 作り直すときに、前の認識器を捨てる
function closeRecognizer() {
  const rec = state.rec;
  state.rec = null;
  listen.running = false;
  if (!rec) return;
  deadRecognizers.add(rec);
  try { rec.abort(); } catch (e) { /* 無視 */ }
}

// 止まった認識器を立て直す。普通の区切りならすぐ、すぐ止まるのが続くなら間をあける
function scheduleRestart() {
  const ran = listen.startedAt ? Date.now() - listen.startedAt : 0;
  listen.startedAt = 0;
  clearTimeout(listen.healthyTimer);
  const next = Recovery.nextRestart(ran, listen.failures);
  listen.failures = next.failures;
  if (next.failures && !listen.troubleSince) listen.troubleSince = Date.now();
  if (listen.shown === 'recovering') {
    // すでに出しているなら、文だけ新しくする(失敗が続けば、強めの文になる)
    setStatus(Recovery.recoveringMessage(listen.lastError, listen.failures), true);
  } else {
    // 立て直しが長引いたら(すぐ止まるのが続く、または始め直せない)、画面に出す。一瞬の区切りでは出さない
    clearTimeout(listen.showTimer);
    const since = listen.troubleSince || Date.now();
    listen.showTimer = setTimeout(() => {
      if (state.listening && (listen.troubleSince || !listen.running)) setListenShown('recovering');
    }, Math.max(0, since + Recovery.SHOW_RECOVERING_MS - Date.now()));
  }
  clearTimeout(listen.restartTimer);
  // 画面が隠れている間は立て直さない(画面に戻ったときに立て直す)
  if (document.visibilityState === 'hidden') return;
  listen.restartTimer = setTimeout(() => {
    if (state.listening && !listen.running) openRecognizer();
  }, next.delay);
}

// 調子が戻ったら、元の表示に戻す
function markListenHealthy() {
  listen.troubleSince = 0;
  listen.failures = 0;
  clearTimeout(listen.showTimer);
  clearTimeout(listen.healthyTimer);
  setListenShown('on');
  setStatus(baseStatus());
}

// dropQueue: Whisperに送る前の発言を捨てる(聞き取りの設定を変えたとき)
function stopListening(dropQueue) {
  state.listening = false;
  clearTimeout(listen.restartTimer);
  clearTimeout(listen.showTimer);
  clearTimeout(listen.healthyTimer);
  listen.troubleSince = 0;
  listen.running = false;
  listen.startedAt = 0;
  const rec = state.rec;
  state.rec = null;
  // 言いかけの最後の言葉は、受け取ってから終える(stop は、聞こえた分を確定してから止まる)
  if (rec) {
    try { rec.stop(); } catch (e) { /* 無視 */ }
  }
  releaseWake();
  state.interim = '';
  // Whisperは、話している途中の分も区切って送る(送り終えるまで「文字にしています」と出す)
  stopWhisperCapture(!dropQueue);
  setListenShown('off');
  setStatus(baseStatus());
  renderTranscript();
}

// ---------- Whisperでの聞き取り ----------
function sttConfig() {
  const id = state.settings.stt;
  return { provider: id, apiKey: state.keys[id] || '', model: state.settings.sttModels[id] || '' };
}
const sttShort = () => (Whisper.sttProvider(state.settings.stt) || { short: '' }).short;
const sttKeyReady = () => !!Whisper.sttProvider(state.settings.stt) && !!String(state.keys[state.settings.stt] || '').trim();
// Whisperで聞き取れるか(キーがあり、止めておらず、この端末でマイクの音を取り込める)
const whisperReady = () => sttKeyReady() && !whisper.off && Capture.captureSupported();

// 聞き取りのヒント: 設定の「よく出る言葉」と、カードに出た言葉(新しい順)
function sttHintList() {
  const own = String(state.settings.sttHints || '').split(/[、,，\n]+/).map((w) => w.trim()).filter(Boolean);
  return own.concat(state.shownTerms.slice(-15).reverse());
}

async function startWhisper() {
  const session = ++whisper.session;
  whisper.opening = true;
  try {
    const cap = await Capture.openCapture({
      workletUrl: 'capture-worklet.js?v=' + BUILD,
      onSegment: queueSegment,
      onSpeaking: (on) => {
        whisper.speaking = on;
        updateWhisperInterim();
      },
      onLost: () => {
        if (session === whisper.session) recoverWhisperCapture();
      },
    });
    if (session !== whisper.session || !state.listening || listen.engine !== 'whisper') {
      cap.stop();
      return;
    }
    whisper.capture = cap;
    whisper.opening = false;
    whisper.openedAt = Date.now();
    listen.running = true;
    setListenShown('on');
    setStatus(baseStatus());
    // 音が届かないまま(端末の不具合など)なら、黙って何も起きない状態にせず、標準の聞き取りに切り替える
    setTimeout(() => {
      if (whisper.capture === cap && cap.frames === 0 && state.listening) fallbackToBrowser('マイクの音を受け取れませんでした。');
    }, WHISPER_NO_SOUND_MS);
  } catch (e) {
    if (session !== whisper.session) return;
    whisper.opening = false;
    if (!state.listening) return;
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotFoundError') {
      stopListening();
      setStatus(Recovery.FATAL_ERRORS[name === 'NotFoundError' ? 'audio-capture' : 'not-allowed'], true);
      return;
    }
    fallbackToBrowser('この端末では、Whisper用に音声を取り込めませんでした。');
  }
}

// マイクを閉じる。keepQueue なら、まだ送っていない発言は送り続ける
function stopWhisperCapture(keepQueue) {
  whisper.session++;
  whisper.opening = false;
  const cap = whisper.capture;
  whisper.capture = null;
  if (cap) cap.stop();
  whisper.speaking = false;
  if (!keepQueue) {
    whisper.queue = [];
    clearTimeout(whisper.timer);
  }
  updateWhisperInterim();
}

// マイクが止められた(電話の着信など)ときは、少し待って開き直す
function recoverWhisperCapture() {
  if (!state.listening || listen.engine !== 'whisper') return;
  stopWhisperCapture(true);
  listen.running = false;
  // しばらく聞けていたなら、新しい止まり方として数え直す
  if (Date.now() - whisper.openedAt > 10000) listen.failures = 0;
  listen.failures++;
  if (listen.failures > 3) {
    stopListening();
    setStatus('マイクが止まりました。もう一度「聞き取り開始」を押してください。', true);
    return;
  }
  setListenShown('recovering');
  clearTimeout(listen.restartTimer);
  if (document.visibilityState === 'hidden') return; // 画面に戻ったときに開き直す
  listen.restartTimer = setTimeout(() => {
    if (state.listening && listen.engine === 'whisper' && !whisper.capture && !whisper.opening) startWhisper();
  }, 1000 * listen.failures);
}

// 画面に戻ったとき: 止まっていた音の処理を動かし直す。マイクが止まっていれば開き直す
async function ensureWhisperCapture() {
  const cap = whisper.capture;
  if (!cap) {
    if (!whisper.opening) startWhisper();
    return;
  }
  if (!cap.live || !(await cap.resume())) recoverWhisperCapture();
}

function queueSegment(seg) {
  const r = SttQueue.enqueue(whisper.queue, seg);
  whisper.queue = r.queue;
  if (r.dropped) {
    whisper.warned = true;
    setStatus('Whisperに送れない間にたまった発言のうち、古い分を捨てました。', true);
  }
  updateWhisperInterim();
  pumpWhisper();
}

// 待っている発言を、まとめてWhisperに送る(サービスの上限に合わせて、間をあける)
async function pumpWhisper() {
  clearTimeout(whisper.timer);
  whisper.timer = null;
  if (whisper.busy || !whisper.queue.length) return;
  const wait = whisper.nextAt - Date.now();
  if (wait > 0) {
    whisper.timer = setTimeout(pumpWhisper, wait);
    return;
  }
  const { items, rest } = SttQueue.takeMerged(whisper.queue);
  whisper.queue = rest;
  const cfg = sttConfig();
  const provider = Whisper.sttProvider(cfg.provider);
  const prompt = Whisper.buildPrompt({ hints: sttHintList(), previous: state.lines.length ? state.lines[state.lines.length - 1].text : '' });
  const gen = state.gen;
  whisper.busy = true;
  updateWhisperInterim();
  try {
    const text = await Whisper.transcribe(cfg, Sound.encodeWav(SttQueue.joinSamples(items)), { prompt, onUsage: recordSttUsage });
    whisper.failures = 0;
    whisper.succeeded = true;
    if (whisper.warned) {
      whisper.warned = false;
      setStatus(baseStatus());
    }
    // 「消す」を押したあとに届いた分は、出さない
    if (text && gen === state.gen) addFinalLine(text);
  } catch (e) {
    if (gen === state.gen) handleWhisperError(e, items);
  } finally {
    whisper.busy = false;
    whisper.nextAt = Math.max(whisper.nextAt, Date.now() + (provider ? provider.minIntervalMs : 0));
    updateWhisperInterim();
    if (whisper.queue.length) pumpWhisper();
  }
}

function handleWhisperError(e, items) {
  const r = SttQueue.afterSttError({ failures: whisper.failures, succeeded: whisper.succeeded }, e);
  whisper.failures = r.failures;
  const msg = (e && e.message) || '音声の聞き取りで、エラーが起きました。';
  if (r.action === 'fallback') {
    fallbackToBrowser(msg);
    return;
  }
  // 同じ発言を、待ってから送り直す
  whisper.queue = items.concat(whisper.queue);
  whisper.nextAt = Date.now() + r.wait;
  whisper.warned = true;
  setStatus(msg + ' 約' + Math.ceil(r.wait / 1000) + '秒後に、もう一度送ります。', true);
}

// Whisperが使えないときは、標準の聞き取りに切り替えて、止まらずに続ける
function fallbackToBrowser(reason) {
  whisper.off = reason || 'Whisperを使えませんでした。';
  stopWhisperCapture(false);
  renderSttState();
  if (!state.listening) {
    toast('Whisperが使えないため、次からは標準の聞き取りを使います');
    return;
  }
  if (!SR) {
    stopListening();
    setStatus(whisper.off + ' この端末には、標準の聞き取りもありません。', true);
    return;
  }
  toast('Whisperが使えないため、標準の聞き取りに切り替えました');
  listen.engine = 'browser';
  listen.failures = 0;
  listen.running = false;
  openRecognizer();
  setStatus('Whisperが使えないため、標準の聞き取りに切り替えました。' + whisper.off, true);
}

// 文字起こし欄の、言いかけの行: 話している間は「…」、送っている間は「文字にしています」
function updateWhisperInterim() {
  if (listen.engine !== 'whisper') return;
  const sending = whisper.busy || whisper.queue.length > 0;
  state.interim = whisper.speaking && state.listening ? '…' : sending ? '(文字にしています…)' : '';
  renderTranscript();
}

function setListenShown(shown) {
  listen.shown = shown;
  updateListenUi();
  if (shown === 'recovering') setStatus(Recovery.recoveringMessage(listen.lastError, listen.failures), true);
}

function updateListenUi() {
  const shown = state.listening ? listen.shown : 'off';
  const b = $('#listenBtn');
  b.classList.toggle('is-live', shown === 'on');
  b.classList.toggle('is-recovering', shown === 'recovering');
  b.setAttribute('aria-pressed', String(state.listening));
  $('#listenLabel').textContent = LISTEN_LABEL[shown];
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
  state.jev.sentAcronyms.clear();
  state.seen.clear();
  whisper.queue = [];
  clearTimeout(whisper.timer);
  updateWhisperInterim();
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
  if (name === 'settings') {
    renderSettings();
    renderUsage();
  }
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

  renderSttSettings();

  $('#jevEnabled').checked = !!state.settings.jev;
  $('#jevKeyInput').value = state.keys.jev || '';
  $('#jevLevel').value = state.settings.jevLevel;
  renderJevState();

  $('#chatSelect').value = state.settings.chat;
  $('#sizeSelect').value = state.settings.size;
  $('#wakeLock').checked = !!state.settings.wake;
}

function setTestResult(text, kind) {
  const r = $('#testResult');
  r.textContent = text;
  r.className = 'test-result' + (kind ? ' is-' + kind : '');
}

// 聞き取り(Whisper)の設定
function renderSttSettings() {
  const id = state.settings.stt;
  const p = Whisper.sttProvider(id);
  $('#sttSelect').value = id;
  ['#sttKeyRow', '#sttModelRow', '#sttHintsRow', '#sttTestRow'].forEach((sel) => { $(sel).hidden = !p; });
  if (p) {
    $('#sttKeyLabel').textContent = p.short + 'のAPIキー';
    const key = $('#sttKeyInput');
    key.value = state.keys[id] || '';
    key.placeholder = p.keyHint;
    const a = el('a', null, p.keySite);
    a.href = p.keyUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    $('#sttKeyNote').replaceChildren(document.createTextNode('キーは、'), a,
      document.createTextNode(id === 'openai' ? 'で作れます。ChatGPTと同じキーです。' : 'で、無料で作れます。'));
    const models = p.models.slice();
    const current = state.settings.sttModels[id];
    if (current && !models.some((m) => m.id === current)) models.push({ id: current, label: current });
    $('#sttModelSelect').replaceChildren(...models.map((m) => {
      const o = el('option', null, m.label);
      o.value = m.id;
      return o;
    }));
    $('#sttModelSelect').value = current;
  }
  $('#sttHints').value = state.settings.sttHints || '';
  renderSttState();
}

function setSttResult(text, kind) {
  const r = $('#sttResult');
  r.textContent = text;
  r.className = 'test-result' + (kind ? ' is-' + kind : '');
}

// Whisperを止めているときは、その理由を出す
function renderSttState() {
  if (whisper.off) setSttResult('Whisperを止めています。' + whisper.off + ' いまは標準の聞き取りを使っています。設定を直すか、「聞き取りテスト」が通ると戻ります。', 'error');
}

// 聞き取りの方法・モデルを変えたら、止めた記録を消す。聞いている途中なら、新しい設定で聞き直す
function onSttSettingChanged(restart) {
  whisper.off = '';
  whisper.failures = 0;
  setSttResult('');
  if (restart && state.listening) {
    stopListening(true);
    startListening();
  }
}

async function runSttTest() {
  const btn = $('#sttTestBtn');
  btn.disabled = true;
  setSttResult('確認しています…');
  try {
    const { ms } = await Whisper.testConnection(sttConfig(), { onUsage: recordSttUsage });
    whisper.off = '';
    whisper.failures = 0;
    const switchNow = state.listening && listen.engine === 'browser' && whisperReady();
    setSttResult('つながりました(' + (ms / 1000).toFixed(1) + '秒)。'
      + (switchNow ? 'Whisperでの聞き取りに切り替えました。' : '「聞き取り開始」を押すと、Whisperで聞き取ります。'), 'ok');
    if (switchNow) {
      stopListening(true);
      startListening();
    }
  } catch (e) {
    setSttResult((e && e.message) || '接続できませんでした。', 'error');
  } finally {
    btn.disabled = false;
  }
}

function setJevResult(text, kind) {
  const r = $('#jevResult');
  r.textContent = text;
  r.className = 'test-result' + (kind ? ' is-' + kind : '');
}

// Jevを止めているとき・つながらないときは、その理由を出す
function renderJevState() {
  const jev = state.jev;
  if (jev.halted) {
    setJevResult('Jevを止めています。' + jev.halted + ' いまは振り分けずに、すべてAIに送っています。キーを直すか、「Jev接続テスト」が通ると再開します。', 'error');
  } else if (jev.trouble) {
    setJevResult('Jevにつながりません。' + jev.trouble + ' いまは振り分けずにAIに送り、ときどき試しています。', 'warn');
  }
}

// Jevの設定が変わったら、止めた記録を消して、最初から試す
function onJevSettingChanged() {
  Object.assign(state.jev, Gate.initialGate());
  setJevResult('');
  updateAiUi();
}

const percent = (p) => Math.round(p * 100) + '%';

async function runJevTest() {
  const btn = $('#jevTestBtn');
  btn.disabled = true;
  setJevResult('確認しています…');
  try {
    const { samples, ms, usage } = await Jev.testConnection(state.keys.jev, { onUsage: (u) => recordUsage('test', u) });
    Object.assign(state.jev, Gate.initialGate());
    const level = state.settings.jevLevel;
    // 例文ごとに1行: 「…」知らない言葉 93%・気をつけたい点 71% → AIに送ります
    const lines = samples.map(({ text, verdict }) => '「' + text + '」知らない言葉 ' + percent(verdict.terms)
      + '・気をつけたい点 ' + percent(verdict.risks) + ' → ' + (Gate.wantsAI(verdict, level) ? 'AIに送ります' : 'AIに送りません'));
    const used = usage ? describeUsage(usage) + '。' : '';
    setJevResult(['つながりました(' + (ms / 1000).toFixed(1) + '秒)。', ...lines, used].filter(Boolean).join('\n'), 'ok');
  } catch (e) {
    setJevResult((e && e.message) || 'Jevに接続できませんでした。', 'error');
  } finally {
    btn.disabled = false;
    updateAiUi();
  }
}

function onAiSettingChanged() {
  state.ai.halted = '';
  // 送る間隔も、最初から測り直す
  state.ai.interval = Pacing.MIN_INTERVAL;
  state.ai.failures = 0;
  state.ai.nextAt = 0;
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
    const { result, ms, usage } = await AI.testConnection(aiConfig(), { onUsage: (u) => recordUsage('test', u) });
    state.ai.halted = '';
    const terms = result.terms.map((t) => t.term + ':' + (t.meaning || '(意味は要確認)')).join(' / ');
    const risks = result.risks.map((r) => r.label).join('・');
    const slow = ms > SLOW_TEST_MS;
    const used = usage ? describeUsage(usage) : '';
    setTestResult(
      'つながりました(' + (ms / 1000).toFixed(1) + '秒)。'
      + (terms ? ' 用語 ' + terms + '。' : ' 用語は見つかりませんでした。')
      + (risks ? ' 注意点 ' + risks + '。' : '')
      + (used ? ' ' + used + '。' : '')
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
  $('#usageChip').addEventListener('click', showUsageDetail);
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
  $('#backupHintBtn').addEventListener('click', exportBackup);
  $('#backupExport').addEventListener('click', exportBackup);
  $('#backupFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    importBackup(file);
  });
  $('#storageExport').addEventListener('click', exportBackup);
  $('#storageClose').addEventListener('click', () => { $('#storageBanner').hidden = true; });

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
    if (state.settings.stt === state.settings.provider) $('#sttKeyInput').value = state.keys[state.settings.provider];
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
    toast(e.target.checked ? 'APIキーを、この端末に保存します' : 'APIキーは、このタブを閉じると消えます(読み込み直しても残ります)');
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

  // 聞き取り(Whisper)
  $('#sttSelect').addEventListener('change', (e) => {
    state.settings.stt = e.target.value;
    persistSettings();
    renderSttSettings();
    onSttSettingChanged(true);
    toast(Whisper.sttProvider(e.target.value)
      ? (sttKeyReady() ? 'Whisper(' + sttShort() + ')で聞き取ります' : sttShort() + 'のAPIキーを入れると、Whisperで聞き取ります')
      : '標準の聞き取りを使います');
  });
  $('#sttKeyInput').addEventListener('input', (e) => {
    const id = state.settings.stt;
    if (!Whisper.sttProvider(id)) return;
    state.keys[id] = e.target.value.trim();
    persistKeys();
    onSttSettingChanged(false);
    // OpenAIのキーは、ChatGPTと同じ
    if (id === state.settings.provider) {
      $('#keyInput').value = state.keys[id];
      onAiSettingChanged();
    }
  });
  $('#sttKeyShowBtn').addEventListener('click', () => {
    const input = $('#sttKeyInput');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#sttKeyShowBtn').textContent = show ? '隠す' : '表示';
  });
  $('#sttModelSelect').addEventListener('change', (e) => {
    state.settings.sttModels[state.settings.stt] = e.target.value;
    persistSettings();
    onSttSettingChanged(true);
  });
  $('#sttHints').addEventListener('change', (e) => {
    state.settings.sttHints = e.target.value;
    persistSettings();
  });
  $('#sttTestBtn').addEventListener('click', runSttTest);

  // 送る前の振り分け(Jev)
  $('#jevEnabled').addEventListener('change', (e) => {
    state.settings.jev = e.target.checked;
    persistSettings();
    onJevSettingChanged();
    if (!e.target.checked) toast('Jevの振り分けをオフにしました');
    else if (jevReady()) toast('Jevで振り分けてから、AIに送ります');
    else toast('TypeSafeのAPIキーを入れると、振り分けを始めます');
  });
  $('#jevKeyInput').addEventListener('input', (e) => {
    state.keys.jev = e.target.value.trim();
    persistKeys();
    onJevSettingChanged();
  });
  $('#jevKeyShowBtn').addEventListener('click', () => {
    const input = $('#jevKeyInput');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#jevKeyShowBtn').textContent = show ? '隠す' : '表示';
  });
  $('#jevLevel').addEventListener('change', (e) => {
    state.settings.jevLevel = e.target.value;
    persistSettings();
  });
  $('#jevTestBtn').addEventListener('click', runJevTest);
  $('#jevKeyClearBtn').addEventListener('click', () => {
    state.keys.jev = '';
    persistKeys();
    $('#jevKeyInput').value = '';
    onJevSettingChanged();
    toast('TypeSafeのAPIキーを削除しました');
  });

  // そのほかの設定
  $('#chatSelect').addEventListener('change', (e) => { state.settings.chat = e.target.value; persistSettings(); });
  $('#sizeSelect').addEventListener('change', (e) => {
    state.settings.size = e.target.value;
    persistSettings();
    applyDisplaySettings();
  });
  $('#wakeLock').addEventListener('change', (e) => { state.settings.wake = e.target.checked; persistSettings(); });
  $('#usageReset').addEventListener('click', () => {
    state.usage = {};
    state.sttUsage = {};
    store.remove('pl_usage');
    renderUsage();
    toast('トークンの記録を消しました');
  });
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

// 画面(index.html)と、このファイルの版が違うとき(更新の直後に古いファイルが残っていた)は、
// 1回だけ読み込み直して、そろえる。読み込み直しても違うときは、そのまま動かす
function versionMatches() {
  const meta = document.querySelector('meta[name="app-version"]');
  const page = meta ? meta.content : 'dev';
  if (page === BUILD) return true;
  let tried = null;
  try {
    tried = sessionStorage.getItem('pl_reload_for');
    if (tried !== BUILD) sessionStorage.setItem('pl_reload_for', BUILD);
  } catch (e) {
    // 読み込み直したことを記録できない端末では、読み込み直しが止まらなくなるので、そのまま動かす
    return true;
  }
  if (tried === BUILD) return true;
  location.reload();
  return false;
}

function start() {
  persistSettings(); // 設定の版の切り替えを、保存しておく
  applyDisplaySettings();
  bind();
  renderSettings();
  updateAiUi();
  renderUsage();
  renderFeed();
  renderSaved();
  renderTranscript();
  $('#appVersion').textContent = '版: ' + BUILD;
  if (!SR) setStatus('このブラウザは、音声認識に対応していません。文字起こし欄から入力して試せます。', true);
  if (window.__prompterStarted) window.__prompterStarted();
}

if (versionMatches()) start();
