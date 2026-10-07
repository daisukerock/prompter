import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEVEL, LEVELS, STOP_CODES, TROUBLE_AFTER, acronymsIn, afterFailure, afterSuccess, canAsk, initialGate, threshold, wantsAI,
} from '../../prompter/gate.js';
import { AIError } from '../../prompter/ai/common.js';

const NOW = 1_000_000;

test('知らない言葉か、気をつけたい点の、どちらかがありそうならAIに送る', () => {
  assert.equal(wantsAI({ terms: 0.9, risks: 0.01 }, 'normal'), true);
  assert.equal(wantsAI({ terms: 0.01, risks: 0.9 }, 'normal'), true);
  assert.equal(wantsAI({ terms: 0.05, risks: 0.1 }, 'normal'), false);
});

test('振り分けの強さで、送る基準を変える(取りこぼしを減らす ほど、よく送る)', () => {
  assert.ok(LEVELS.more < LEVELS.normal && LEVELS.normal < LEVELS.save);
  const verdict = { terms: 0.2, risks: 0.1 };
  assert.equal(wantsAI(verdict, 'more'), true);
  assert.equal(wantsAI(verdict, 'normal'), false);
  assert.equal(wantsAI({ terms: 0.4, risks: 0 }, 'normal'), true);
  assert.equal(wantsAI({ terms: 0.4, risks: 0 }, 'save'), false);
  // ちょうど基準の値なら送る
  assert.equal(wantsAI({ terms: LEVELS.save, risks: 0 }, 'save'), true);
  // 知らない値は、標準として扱う
  assert.equal(threshold('unknown'), LEVELS[DEFAULT_LEVEL]);
  assert.equal(threshold('toString'), LEVELS[DEFAULT_LEVEL]);
  assert.equal(threshold(undefined), LEVELS[DEFAULT_LEVEL]);
});

test('英字の略語を拾う(小文字にそろえる。よく知られた略語は拾わない)', () => {
  assert.deepEqual(acronymsIn('KPIとNDAの話。OKです。PoCも'), ['kpi', 'nda']);
  assert.deepEqual(acronymsIn('お疲れさまです。'), []);
});

test('キーの誤りや残高不足では、Jevを止める(設定を直すまで使わない)', () => {
  for (const code of STOP_CODES) {
    const gate = afterFailure({ ...initialGate(), failures: 2, retryAt: NOW + 5 }, new AIError(code, 'だめ: ' + code), NOW);
    assert.equal(gate.halted, 'だめ: ' + code);
    assert.equal(gate.failures, 0);
    assert.equal(canAsk(gate, NOW + 3_600_000), false, code);
  }
});

test('つながらないときは、待ってからまた聞く。続いたら知らせ、うまくいったら元に戻す', () => {
  const err = new AIError('network', 'Jevに接続できませんでした。');
  let gate = initialGate();
  const waits = [];
  for (let i = 1; i <= TROUBLE_AFTER; i++) {
    gate = afterFailure(gate, err, NOW);
    waits.push(gate.retryAt - NOW);
    assert.equal(gate.failures, i);
    assert.equal(gate.halted, '');
    assert.equal(gate.trouble, i < TROUBLE_AFTER ? '' : 'Jevに接続できませんでした。');
  }
  assert.deepEqual(waits, [5000, 10000, 20000]);
  assert.equal(canAsk(gate, NOW + 19_999), false);
  assert.equal(canAsk(gate, NOW + 20_000), true);
  // 時間切れ・不具合・読めない答えも、待ってからまた聞く
  for (const code of ['timeout', 'server', 'parse']) assert.equal(afterFailure(initialGate(), new AIError(code, 'x'), NOW).halted, '');
  gate = afterSuccess(gate);
  assert.deepEqual(gate, initialGate());
});

test('混雑(429)のときは、示された時間だけ待つ(示されなければ20秒)', () => {
  assert.equal(afterFailure(initialGate(), new AIError('ratelimit', 'x', { retryAfterMs: 7000 }), NOW).retryAt, NOW + 7000);
  assert.equal(afterFailure(initialGate(), new AIError('ratelimit', 'x', { retryAfterMs: 0 }), NOW).retryAt, NOW + 20000);
});

test('ほかの値(回数など)は、そのまま残す', () => {
  const gate = { ...initialGate(), judged: 4, skipped: 2 };
  assert.equal(afterFailure(gate, new AIError('network', 'x'), NOW).judged, 4);
  assert.equal(afterSuccess(gate).skipped, 2);
  assert.equal(afterFailure(initialGate(), null, NOW).failures, 1, 'エラーの形が分からなくても、待ってからまた聞く');
});
