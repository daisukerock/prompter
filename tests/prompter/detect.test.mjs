import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCandidates, findRisks, markSegments, lineContaining } from '../../prompter/detect.js';

test('英字の略語を拾い、よくある略語は除く', () => {
  const found = findCandidates('今回のEBPMとKPIの件です。PCとOKは除く。The AIR is fine.');
  assert.deepEqual(found.map((f) => f.term), ['EBPM', 'KPI', 'AIR']);
  assert.equal(found[0].quote, '今回のEBPMとKPIの件です');
});

test('同じ略語は1回だけ拾う', () => {
  assert.equal(findCandidates('KPIとKPIとKPI').length, 1);
});

test('気をつけたい言葉を、1文ごとにまとめて拾う', () => {
  const risks = findRisks('契約条件はNDAを結んだうえで、必ず今週中に回答をお願いします。');
  assert.deepEqual(risks.map((r) => r.ruleId), ['legal', 'commit', 'deadline', 'request']);
  assert.ok(risks.every((r) => r.quote.startsWith('契約条件')));
  assert.deepEqual(findRisks('予算は500万円です。'), [{
    ruleId: 'money', level: 'yellow', label: '金額・数値', tip: '数値は出典を確認する。その場で断定しない。',
    matched: ['500万円'], quote: '予算は500万円です。',
  }]);
});

test('強調表示: 英字は単語の区切りで、大文字小文字を区別せずに一致させる', () => {
  const segs = markSegments('kpiとKPIs、それとAIRとAI。', ['KPI', 'AI']);
  assert.deepEqual(segs, [
    { text: 'kpi', mark: true },
    { text: 'とKPIs、それとAIRと' },
    { text: 'AI', mark: true },
    { text: '。' },
  ]);
});

test('強調表示: 長い語を優先し、重なりは作らない', () => {
  const segs = markSegments('ロジックモデルを見る', ['モデル', 'ロジックモデル']);
  assert.deepEqual(segs, [{ text: 'ロジックモデル', mark: true }, { text: 'を見る' }]);
});

test('語を含む文を探す', () => {
  const lines = ['最初の文です。', '次はKPIの話。続きの文。'];
  assert.equal(lineContaining(lines, 'kpi'), '次はKPIの話');
  assert.equal(lineContaining(lines, 'なし'), '最初の文です。');
});
