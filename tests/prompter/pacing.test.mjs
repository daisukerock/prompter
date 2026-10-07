import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_MAX_CHARS, MAX_INTERVAL, MIN_INTERVAL, backoff, rateLimitWait, relax, takeBatch, widen } from '../../prompter/pacing.js';

test('上限にかかるたびに送る間隔を倍に広げ、うまくいくと少しずつ戻す', () => {
  let interval = MIN_INTERVAL;
  const widened = [];
  for (let i = 0; i < 5; i++) widened.push(interval = widen(interval));
  assert.deepEqual(widened, [3000, 6000, 12000, MAX_INTERVAL, MAX_INTERVAL]);
  let steps = 0;
  while (interval > MIN_INTERVAL) {
    interval = relax(interval);
    steps++;
  }
  assert.equal(interval, MIN_INTERVAL);
  assert.ok(steps >= 5, '一気には戻さない');
});

test('上限にかかったときの待ち時間: サービスが示した時間を優先し、2秒〜2分に収める', () => {
  assert.equal(rateLimitWait(37000), 37000);
  assert.equal(rateLimitWait(0), 20000);
  assert.equal(rateLimitWait(undefined), 20000);
  assert.equal(rateLimitWait(100), 2000);
  assert.equal(rateLimitWait(600000), 120000);
});

test('通信の失敗が続くほど長く待つ(最大60秒)', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(backoff), [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
});

test('たまった発言は、新しいものから上限まで送り、古い分は分けて返す', () => {
  const lines = ['あ'.repeat(200), 'い'.repeat(150), 'う'.repeat(100), 'え'.repeat(100)];
  const { send, older } = takeBatch(lines, BATCH_MAX_CHARS);
  assert.deepEqual(send, [lines[1], lines[2], lines[3]]);
  assert.deepEqual(older, [lines[0]]);
  assert.deepEqual(takeBatch(['短い文'], 360), { send: ['短い文'], older: [] });
  // 長すぎる1文でも、最新の1文は必ず送る
  assert.deepEqual(takeBatch(['古い', 'x'.repeat(500)], 360), { send: ['x'.repeat(500)], older: ['古い'] });
  assert.deepEqual(takeBatch([], 360), { send: [], older: [] });
});
