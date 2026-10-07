// Jev(TypeSafe)への送り方と、答え・エラーの読み方を、fetchを差し替えて確かめる(実際には通信しない)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Jev from '../../prompter/ai/jev.js';

let calls = [];
let responder = null;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

globalThis.fetch = (url, init = {}) => {
  const call = { url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null };
  calls.push(call);
  // 本物のfetchと同じく、中断されたら AbortError で失敗させる
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (init.signal) {
      if (init.signal.aborted) return abort();
      init.signal.addEventListener('abort', abort, { once: true });
    }
    Promise.resolve().then(() => responder(call, calls.length)).then(resolve, reject);
  });
};

beforeEach(() => {
  calls = [];
  responder = null;
});

const answer = (terms, risks, extra = {}) => ({
  model: 'jev-1.13.0',
  answers: { terms: { type: 'noul', noul: terms }, risks: { type: 'noul', noul: risks } },
  usage: { input_tokens: 152, output_tokens: 2 },
  ...extra,
});

test('発言を state に入れ、2つの「はい/いいえ」の問いで判定してもらう', async () => {
  responder = () => json(200, answer(0.97, 0.12));
  const usages = [];
  const verdict = await Jev.judge(' ts-key ', 'ステークホルダーの話です。', { onUsage: (u) => usages.push(u) });
  assert.deepEqual(verdict, { terms: 0.97, risks: 0.12, model: 'jev-1.13.0' });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.get('authorization'), 'Bearer ts-key');
  assert.equal(c.headers.get('content-type'), 'application/json');
  assert.equal(c.body.state, 'ステークホルダーの話です。');
  assert.equal(c.body.model, 'jev-latest');
  assert.deepEqual(Object.keys(c.body.questions), ['terms', 'risks']);
  for (const q of Object.values(c.body.questions)) {
    assert.equal(q.type, 'noul');
    assert.ok(q.instructions && q.criteria.true && q.criteria.false);
  }
  // 使ったトークン数は、どのサービス・モデルの分かを添えて知らせる
  assert.deepEqual(usages, [{ input: 152, output: 2, thinking: 0, cached: 0, searches: 0, provider: 'jev', model: 'jev-1.13.0' }]);
});

test('確率は0〜1に収める。答えが欠けていれば、読めなかったエラーにする', async () => {
  responder = () => json(200, answer(1.2, -0.1));
  assert.deepEqual(await Jev.judge('k', 'x'), { terms: 1, risks: 0, model: 'jev-1.13.0' });
  responder = () => json(200, { model: 'jev-1.13.0', answers: { terms: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 1 } });
  const usages = [];
  await assert.rejects(Jev.judge('k', 'x', { onUsage: (u) => usages.push(u) }), { code: 'parse' });
  assert.equal(usages.length, 1, '読めなくても、使った分は知らせる');
  responder = () => json(200, { answers: { terms: { type: 'noul', noul: '0.5' }, risks: { type: 'noul', noul: 0.5 } } });
  await assert.rejects(Jev.judge('k', 'x'), { code: 'parse' });
});

test('知らせる先で失敗しても、判定は捨てない', async () => {
  responder = () => json(200, answer(0.2, 0.9));
  const verdict = await Jev.judge('k', 'x', { onUsage: () => { throw new Error('boom'); } });
  assert.equal(verdict.risks, 0.9);
});

test('キーがなければ、呼ばずにエラーにする', async () => {
  await assert.rejects(Jev.judge('  ', 'x'), { code: 'config', message: /TypeSafeのAPIキーが入っていません/ });
  assert.equal(calls.length, 0);
});

test('エラーを、止めるべきものと、待てば戻るものに分ける', async () => {
  const cases = [
    [401, { detail: 'Invalid API key' }, {}, 'auth', /TypeSafeのAPIキーが正しくない/],
    [402, { detail: 'Insufficient credits' }, {}, 'quota', /残高/],
    [403, { error: { message: 'Key disabled' } }, {}, 'permission', /Jevを使えない.*Key disabled/],
    [404, { detail: 'Not Found' }, {}, 'notfound', /接続先が見つかりません/],
    [422, { detail: [{ loc: ['body', 'state'], msg: 'Field required', type: 'missing' }] }, {}, 'badrequest', /受け付けませんでした.*Field required/],
    [500, { message: 'oops' }, {}, 'server', /一時的な不具合/],
    [503, null, {}, 'server', /一時的な不具合/],
  ];
  for (const [status, body, headers, code, message] of cases) {
    responder = () => (body ? json(status, body, headers) : new Response('', { status }));
    await assert.rejects(Jev.judge('k', 'x'), { code, message }, String(status));
  }
});

test('混雑(429)のときは、示された待ち時間を読む(retry-after-ms を優先し、なければ retry-after)', async () => {
  responder = () => json(429, { detail: 'Too many requests' }, { 'retry-after-ms': '1500', 'retry-after': '9' });
  await assert.rejects(Jev.judge('k', 'x'), { code: 'ratelimit', retryAfterMs: 1500 });
  responder = () => json(429, { detail: 'Too many requests' }, { 'retry-after': '4' });
  await assert.rejects(Jev.judge('k', 'x'), { code: 'ratelimit', retryAfterMs: 4000 });
  responder = () => json(429, { detail: 'Too many requests' });
  await assert.rejects(Jev.judge('k', 'x'), { code: 'ratelimit', retryAfterMs: 0 });
});

test('つながらない(ブラウザが止めた場合も)・時間切れを、利用者向けのエラーにする', async () => {
  responder = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(Jev.judge('k', 'x'), { code: 'network', message: /Jevに接続できませんでした/ });
  responder = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(Jev.judge('k', 'x', { timeoutMs: 50 }), { code: 'timeout', message: /時間内に返りませんでした/ });
  assert.ok(Date.now() - started < 2000);
});

test('会議中の判定は、5秒で打ち切る(待たせずにAIへ送れるように)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  responder = () => new Promise(() => {});
  let settled = false;
  const pending = Jev.judge('k', 'x').catch((e) => {
    settled = true;
    return e;
  });
  t.mock.timers.tick(4999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).code, 'timeout');
});

test('接続テスト: 送りたい例文と、送らなくてよい例文を判定し、使った数を合わせて返す', async () => {
  responder = (call) => json(200, call.body.state.includes('ステークホルダー') ? answer(0.96, 0.81) : answer(0.03, 0.04));
  const usages = [];
  const out = await Jev.testConnection('k', { onUsage: (u) => usages.push(u) });
  assert.equal(calls.length, 2);
  assert.deepEqual(out.samples.map((s) => s.text), Jev.TEST_SAMPLES);
  assert.deepEqual(out.samples.map((s) => [s.verdict.terms, s.verdict.risks]), [[0.96, 0.81], [0.03, 0.04]]);
  assert.equal(out.usage.input, 304);
  assert.equal(out.usage.output, 4);
  assert.equal(usages.length, 2);
  assert.ok(out.ms >= 0);
});
