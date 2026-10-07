import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackupError, backupFileName, compactSaved, makeBackup, mergeSaved, parseBackup, unexportedCount,
} from '../../prompter/backup.js';

const HOUR = 60 * 60 * 1000;
const FRESH = 6 * HOUR;
const NOW = Date.UTC(2026, 9, 7, 3, 0, 0);
let n = 0;
const makeId = () => 'id' + (++n);
const opts = { now: NOW, freshMs: FRESH, makeId };

function card(extra = {}) {
  return {
    id: 'a', key: 't:kpi', kind: 'term', term: 'KPI', title: 'KPI', sub: '重要業績評価指標',
    body: '目標の達成度を測る指標', quote: 'KPIの設定', level: 'term', detail: null, summary: null,
    ts: NOW - HOUR, status: 'new', memo: '', v: 3, ...extra,
  };
}

test('書き出す中身: 保存カードと「知っている」語だけ。APIキーや設定は入れない', () => {
  const data = makeBackup({ saved: [card()], known: new Set(['nda']) }, new Date(NOW));
  assert.equal(data.app, 'prompter');
  assert.equal(data.version, 1);
  assert.equal(data.exportedAt, '2026-10-07T03:00:00.000Z');
  assert.deepEqual(data.known, ['nda']);
  assert.equal(data.saved.length, 1);
  assert.deepEqual(Object.keys(data).sort(), ['app', 'exportedAt', 'known', 'saved', 'version']);
  assert.match(backupFileName(new Date(2026, 9, 7)), /^prompter-backup-2026-10-07\.json$/);
});

test('書き出して読み込むと、同じカードに戻る(idは付け直す)', () => {
  const original = card({ detail: { text: '詳しい説明' }, status: 'studied', memo: 'メモ', novel: true, unsure: true });
  const back = parseBackup(JSON.stringify(makeBackup({ saved: [original], known: ['nda'] })), opts);
  assert.equal(back.cards.length, 1);
  const c = back.cards[0];
  assert.notEqual(c.id, original.id);
  for (const k of ['key', 'kind', 'term', 'title', 'sub', 'body', 'quote', 'level', 'ts', 'status', 'memo', 'novel', 'unsure']) assert.equal(c[k], original[k], k);
  assert.deepEqual(c.detail, { text: '詳しい説明', error: false });
  assert.deepEqual(back.known, ['nda']);
});

test('読み込むファイルは信用しない: 危ないリンク・検索候補のHTML・おかしな値を取り除く', () => {
  const raw = {
    app: 'prompter', version: 1,
    saved: [
      card({
        kind: 'risk', level: 'purple', status: 'hacked', title: 'x'.repeat(500),
        summary: {
          items: [{ label: '何の話', text: '話題' }, { text: 123 }],
          sources: [{ title: 'ok', uri: 'https://example.com/a' }, { title: 'bad', uri: 'javascript:alert(1)' }],
          suggestionHtml: '<script>alert(1)</script>', model: 'gemini-3.5-flash', at: NOW - HOUR,
        },
        detail: { text: '聞いています…', loading: true },
      }),
      null, 'text', { title: '' }, { title: 'NDA', kind: 'term' },
    ],
    known: ['  KPI ', 3, ''],
  };
  const back = parseBackup(JSON.stringify(raw), opts);
  assert.equal(back.cards.length, 2);
  const [risk, nda] = back.cards;
  assert.equal(risk.level, 'yellow');
  assert.equal(risk.status, 'new');
  assert.equal(risk.title.length, 200);
  assert.equal(risk.detail, null, '聞いている途中の状態は持ち込まない');
  assert.deepEqual(risk.summary.sources, [{ title: 'ok', uri: 'https://example.com/a' }]);
  assert.equal(risk.summary.suggestionHtml, '');
  assert.deepEqual(risk.summary.items, [{ label: '何の話', text: '話題' }]);
  assert.ok(NOW - risk.summary.at >= FRESH, '開くと作り直す扱いにする');
  assert.equal(nda.key, 't:nda');
  assert.equal(nda.ts, NOW);
  assert.deepEqual(back.known, ['kpi']);
});

test('プロンプターの書き出しファイルでなければ、読み込まない', () => {
  assert.throws(() => parseBackup('not json', opts), BackupError);
  assert.throws(() => parseBackup('{"saved":[]}', opts), BackupError);
  assert.throws(() => parseBackup('{"app":"prompter","saved":{}}', opts), BackupError);
  assert.throws(() => parseBackup('{"app":"prompter","version":99,"saved":[]}', opts), BackupError);
});

test('読み込んだカードは、同じものを除いて足し、新しい順に並べる', () => {
  const existing = [card({ key: 't:kpi', ts: 300 }), card({ key: 't:nda', ts: 100 })];
  const incoming = [card({ key: 't:kpi', ts: 999 }), card({ key: 't:poc', ts: 200 }), card({ key: 't:poc', ts: 50 })];
  const result = mergeSaved(existing, incoming);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.saved.map((c) => c.key), ['t:kpi', 't:poc', 't:nda']);
});

test('端末に保存する形: 古い要点の検索候補HTMLと、聞いている途中の状態は残さない', () => {
  const fresh = card({ key: 'a', summary: { items: [], suggestionHtml: '<div>新</div>', at: NOW - HOUR } });
  const old = card({ key: 'b', summary: { items: [], suggestionHtml: '<div>古</div>', at: NOW - 7 * HOUR } });
  const loading = card({ key: 'c', detail: { text: 'AIに聞いています…', loading: true } });
  const out = compactSaved([fresh, old, loading], NOW, FRESH);
  assert.equal(out[0].summary.suggestionHtml, '<div>新</div>');
  assert.equal(out[1].summary.suggestionHtml, '');
  assert.equal(out[2].detail, null);
  assert.equal(old.summary.suggestionHtml, '<div>古</div>', '画面で持っている値は変えない');
});

test('前回の書き出しより後に保存したカードを数える', () => {
  const saved = [card({ ts: 300 }), card({ ts: 200 }), card({ ts: 100 })];
  assert.equal(unexportedCount(saved, null), 3);
  assert.equal(unexportedCount(saved, 150), 2);
  assert.equal(unexportedCount(saved, 400), 0);
});
