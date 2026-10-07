import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_AFTER, GAP_MS, MERGE_MAX_MS, STOP_CODES, afterSttError, enqueue, joinSamples, takeMerged } from '../../prompter/sttqueue.js';
import { AIError } from '../../prompter/ai/common.js';

const item = (ms, v = 0) => ({ ms, samples: new Float32Array((ms / 1000) * 16000).fill(v) });

test('たまりすぎたら、古い発言から捨てる(いちばん新しい発言は残す)', () => {
  let q = [];
  let dropped = 0;
  for (let i = 0; i < 5; i++) {
    const r = enqueue(q, item(1000, i), 3000);
    q = r.queue;
    dropped += r.dropped;
  }
  assert.deepEqual(q.map((x) => x.samples[0]), [2, 3, 4]);
  assert.equal(dropped, 2);
  assert.equal(enqueue([], item(9000), 3000).queue.length, 1, '1つだけなら、長くても捨てない');
});

test('まとめて送るのは、間の無音も含めて30秒まで。1つは必ず取り出す', () => {
  const q = [item(10000), item(10000), item(10000), item(1000)];
  const { items, rest } = takeMerged(q);
  assert.equal(items.length, 2, '10+0.3+10+0.3+10 は30秒をこえる');
  assert.equal(rest.length, 2);
  assert.ok(2 * 10000 + GAP_MS <= MERGE_MAX_MS);
  assert.equal(takeMerged([item(40000)]).items.length, 1);
  assert.deepEqual(takeMerged([]), { items: [], rest: [] });
});

test('つなぐときは、発言の間に短い無音をはさむ', () => {
  const out = joinSamples([item(1000, 0.5), item(500, -0.5)]);
  const gap = (GAP_MS / 1000) * 16000;
  assert.equal(out.length, 16000 + gap + 8000);
  assert.equal(out[15999], 0.5);
  assert.equal(out[16000], 0);
  assert.equal(out[16000 + gap], -0.5);
});

test('キーの誤り・1日の上限などは、標準の聞き取りに切り替える', () => {
  for (const code of STOP_CODES) {
    assert.equal(afterSttError({ failures: 0, succeeded: true }, new AIError(code, 'x')).action, 'fallback', code);
  }
});

test('混雑(上限)のときは、示された時間だけ待って送り直す(失敗の回数には数えない)', () => {
  const r = afterSttError({ failures: 1, succeeded: true }, new AIError('ratelimit', 'x', { retryAfterMs: 7000 }));
  assert.deepEqual(r, { action: 'retry', failures: 1, wait: 7000 });
  assert.equal(afterSttError({}, new AIError('ratelimit', 'x')).wait, 20000);
});

test('一度も文字にできないまま、つながらないのが続いたら切り替える(ブラウザから使えない設定の可能性が高い)', () => {
  const err = new AIError('network', 'x');
  const first = afterSttError({ failures: 0, succeeded: false }, err);
  assert.equal(first.action, 'retry');
  assert.equal(first.wait, 5000);
  assert.equal(afterSttError({ failures: FALLBACK_AFTER - 1, succeeded: false }, err).action, 'fallback');
});

test('文字にできていた後の通信の失敗は、間をあけて送り直し続ける', () => {
  let st = { failures: 0, succeeded: true };
  const waits = [];
  for (let i = 0; i < 5; i++) {
    const r = afterSttError(st, new AIError(i % 2 ? 'timeout' : 'server', 'x'));
    assert.equal(r.action, 'retry');
    waits.push(r.wait);
    st = { failures: r.failures, succeeded: true };
  }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000]);
});
