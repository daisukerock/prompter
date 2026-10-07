// 保存カードのバックアップ(書き出し・読み込み)と、端末に保存するときの形。
// 画面には触らない関数だけを置く(テストしやすいように)

import { todayString } from './ai/common.js';

export const BACKUP_APP = 'prompter';
export const BACKUP_VERSION = 1;

// 書き出すファイルの中身。APIキーと設定は入れない
export function makeBackup({ saved, known }, now = new Date()) {
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    saved: saved.map(forStorage),
    known: [...known],
  };
}

export function backupFileName(now = new Date()) {
  return 'prompter-backup-' + todayString(now) + '.json';
}

// 「詳しく」を聞いている途中の状態は残さない(読み込み直すと、ずっと「聞いています」になるため)
function forStorage(card) {
  return card.detail && card.detail.loading ? { ...card, detail: null } : card;
}

// 端末に保存する形。作ってから時間がたった要点は、開くと作り直すので、
// 大きな「検索候補」のHTMLは保存しない(保存領域を使い切らないように)
export function compactSaved(saved, now, freshMs) {
  return saved.map((card) => {
    const c = forStorage(card);
    const s = c.summary;
    if (!s || !s.suggestionHtml || now - (s.at || 0) < freshMs) return c;
    return { ...c, summary: { ...s, suggestionHtml: '' } };
  });
}

// 前回の書き出しより後に保存したカードの数
export function unexportedCount(saved, lastExportAt) {
  if (!lastExportAt) return saved.length;
  return saved.filter((c) => (c.ts || 0) > lastExportAt).length;
}

const STATUSES = ['new', 'studied', 'learned'];
const text = (v, max) => String(v == null ? '' : v).slice(0, max);
const time = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

// 読み込んだファイルの中身は信用しない。決まった項目だけを、決まった長さで取り出す
function cleanSummary(s, now, freshMs) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.items)) return null;
  const items = s.items
    .filter((i) => i && typeof i.text === 'string' && i.text.trim())
    .slice(0, 6)
    .map((i) => ({ label: text(i.label, 20), text: text(i.text, 400) }));
  if (!items.length) return null;
  const sources = (Array.isArray(s.sources) ? s.sources : [])
    .filter((x) => x && /^https:\/\//.test(String(x.uri)))
    .slice(0, 8)
    .map((x) => ({ title: text(x.title || x.uri, 200), uri: text(x.uri, 2000) }));
  return {
    items,
    sources,
    // 検索候補のHTMLは持ち込まない。開くと作り直す扱いにする
    suggestionHtml: '',
    model: text(s.model, 80),
    at: Math.min(time(s.at, 0), now - freshMs),
    truncated: !!s.truncated,
    usage: null,
  };
}

export function cleanCard(raw, { now, freshMs, makeId }) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'risk' ? 'risk' : 'term';
  const title = text(raw.title || raw.term, 200).trim();
  if (!title) return null;
  const term = text(raw.term || title, 200).trim();
  return {
    id: makeId(),
    key: text(raw.key, 400) || (kind === 'risk' ? 'r:' : 't:') + term.toLowerCase(),
    kind,
    term,
    title,
    sub: text(raw.sub, 200),
    body: text(raw.body, 2000),
    quote: text(raw.quote, 1000),
    level: kind === 'risk' ? (raw.level === 'red' ? 'red' : 'yellow') : 'term',
    novel: kind === 'term' && raw.novel === true,
    unsure: kind === 'term' && raw.unsure === true,
    detail: raw.detail && typeof raw.detail.text === 'string' && !raw.detail.loading
      ? { text: text(raw.detail.text, 4000), error: !!raw.detail.error }
      : null,
    summary: cleanSummary(raw.summary, now, freshMs),
    ts: time(raw.ts, now),
    status: STATUSES.includes(raw.status) ? raw.status : 'new',
    memo: text(raw.memo, 4000),
    v: 1,
  };
}

export class BackupError extends Error {}

// 書き出したファイルを読む。形が違えば BackupError
export function parseBackup(source, { now = Date.now(), freshMs, makeId }) {
  let data;
  try {
    data = JSON.parse(source);
  } catch (e) {
    throw new BackupError('JSONとして読めません');
  }
  if (!data || data.app !== BACKUP_APP || !Array.isArray(data.saved)) throw new BackupError('プロンプターの書き出しファイルではありません');
  if (Number(data.version) > BACKUP_VERSION) throw new BackupError('新しい版のファイルです');
  const cards = data.saved.slice(0, 5000).map((c) => cleanCard(c, { now, freshMs, makeId })).filter(Boolean);
  const known = (Array.isArray(data.known) ? data.known : [])
    .filter((t) => typeof t === 'string' && t.trim())
    .slice(0, 5000)
    .map((t) => t.trim().toLowerCase().slice(0, 100));
  return { cards, known };
}

// いまのカードに、読み込んだカードを足す(同じカードは足さない)。新しい順に並べる
export function mergeSaved(existing, incoming) {
  const keys = new Set(existing.map((c) => c.key));
  const added = [];
  let skipped = 0;
  for (const card of incoming) {
    if (keys.has(card.key)) {
      skipped++;
      continue;
    }
    keys.add(card.key);
    added.push(card);
  }
  const saved = existing.concat(added).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { saved, added: added.length, skipped };
}
