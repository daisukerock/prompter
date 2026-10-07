import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FATAL_ERRORS, HEALTHY_RUN_MS, WARN_AFTER, nextRestart, recoveringMessage } from '../../prompter/recovery.js';

test('普通の区切りで止まったら、すぐ始め直し、失敗の数を0に戻す', () => {
  assert.deepEqual(nextRestart(HEALTHY_RUN_MS, 3), { delay: 0, failures: 0 });
  assert.deepEqual(nextRestart(60000, 0), { delay: 0, failures: 0 });
});

test('すぐ止まるのが続くと、0.5秒・1秒・2秒…と間をあける(最大8秒)', () => {
  let failures = 0;
  const delays = [];
  for (let i = 0; i < 7; i++) {
    const next = nextRestart(100, failures);
    failures = next.failures;
    delays.push(next.delay);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(failures, 7);
});

test('立て直し中の文: 通信が原因なら添え、続くときは強めに知らせる', () => {
  assert.equal(recoveringMessage('no-speech', 1), '聞き取りが途切れたので、立て直しています…');
  assert.match(recoveringMessage('network', 1), /^ネットワークにつながらないため、/);
  assert.match(recoveringMessage('', WARN_AFTER), /うまく続きません/);
});

test('マイクの許可がない・マイクが使えないときは、立て直さずに止める', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']) {
    assert.ok(FATAL_ERRORS[code], code);
  }
  for (const code of ['no-speech', 'network', 'aborted']) assert.equal(FATAL_ERRORS[code], undefined, code);
});
