// Jev(OpenRouter経由・TypeSafe)への送り方と、答え・エラーの読み方を、fetchを差し替えて確かめる(実際には通信しない)
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

const OR = { route: 'openrouter', apiKey: 'sk-or-test' };
const TS = { route: 'typesafe', apiKey: 'ts-key' };

test('発言を state に入れ、2つの「はい/いいえ」の問いで判定してもらう(ふだんは、OpenRouter経由)', async () => {
  assert.equal(Jev.DEFAULT_ROUTE, 'openrouter');
  // OpenRouterは、TypeSafeと同じ形で返し、モデル名に typesafe/ が付く(使った金額 cost も返す)
  responder = () => json(200, answer(0.97, 0.12, { model: 'typesafe/jev-1.13', usage: { input_tokens: 152, output_tokens: 2, cost: 0.0000064 } }));
  const usages = [];
  const verdict = await Jev.judge({ route: 'openrouter', apiKey: ' sk-or-test ' }, 'ステークホルダーの話です。', { onUsage: (u) => usages.push(u) });
  assert.deepEqual(verdict, { terms: 0.97, risks: 0.12, model: 'typesafe/jev-1.13' });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.get('authorization'), 'Bearer sk-or-test');
  assert.equal(c.headers.get('content-type'), 'application/json');
  // ブラウザから呼べるよう、ほかの見出しは付けない
  assert.deepEqual([...c.headers.keys()].sort(), ['authorization', 'content-type']);
  assert.equal(c.body.state, 'ステークホルダーの話です。');
  assert.equal(c.body.model, 'jev-latest');
  assert.deepEqual(Object.keys(c.body.questions), ['terms', 'risks']);
  for (const q of Object.values(c.body.questions)) {
    assert.equal(q.type, 'noul');
    assert.ok(q.instructions && q.criteria.true && q.criteria.false);
  }
  // 使ったトークン数は、どのサービス・モデルの分かを添えて知らせる
  assert.deepEqual(usages, [{ input: 152, output: 2, thinking: 0, cached: 0, searches: 0, provider: 'jev', model: 'typesafe/jev-1.13' }]);
});

test('TypeSafe(直接)を選べば、TypeSafeに同じ形で送る', async () => {
  responder = () => json(200, answer(0.4, 0.6));
  assert.deepEqual(await Jev.judge(TS, 'x'), { terms: 0.4, risks: 0.6, model: 'jev-1.13.0' });
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer ts-key');
  assert.equal(calls[0].body.model, 'jev-latest');
  assert.deepEqual(Object.keys(calls[0].body.questions), ['terms', 'risks']);
});

test('確率は0〜1に収める。答えが欠けていれば、読めなかったエラーにする', async () => {
  responder = () => json(200, answer(1.2, -0.1));
  assert.deepEqual(await Jev.judge(OR, 'x'), { terms: 1, risks: 0, model: 'jev-1.13.0' });
  responder = () => json(200, { model: 'jev-1.13.0', answers: { terms: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 1 } });
  const usages = [];
  await assert.rejects(Jev.judge(OR, 'x', { onUsage: (u) => usages.push(u) }), { code: 'parse' });
  assert.equal(usages.length, 1, '読めなくても、使った分は知らせる');
  responder = () => json(200, { answers: { terms: { type: 'noul', noul: '0.5' }, risks: { type: 'noul', noul: 0.5 } } });
  await assert.rejects(Jev.judge(OR, 'x'), { code: 'parse' });
});

test('知らせる先で失敗しても、判定は捨てない', async () => {
  responder = () => json(200, answer(0.2, 0.9));
  const verdict = await Jev.judge(OR, 'x', { onUsage: () => { throw new Error('boom'); } });
  assert.equal(verdict.risks, 0.9);
});

test('キーや接続先がなければ、呼ばずにエラーにする(どのキーが要るかは、接続先で変わる)', async () => {
  await assert.rejects(Jev.judge({ route: 'openrouter', apiKey: '  ' }, 'x'), { code: 'config', message: /OpenRouterのAPIキーが入っていません/ });
  await assert.rejects(Jev.judge({ route: 'typesafe', apiKey: '' }, 'x'), { code: 'config', message: /TypeSafeのAPIキーが入っていません/ });
  await assert.rejects(Jev.judge({ route: 'toString', apiKey: 'k' }, 'x'), { code: 'config', message: /接続先が正しくありません/ });
  await assert.rejects(Jev.judge(null, 'x'), { code: 'config' });
  assert.equal(calls.length, 0);
});

test('エラーを、止めるべきものと、待てば戻るものに分ける', async () => {
  const cases = [
    [OR, 401, { error: { code: 401, message: 'No auth credentials found' } }, 'auth', /OpenRouterのAPIキーが正しくない/],
    [TS, 401, { detail: 'Invalid API key' }, 'auth', /TypeSafeのAPIキーが正しくない/],
    [OR, 402, { error: { code: 402, message: 'Insufficient credits' } }, 'quota', /OpenRouterのクレジット/],
    [TS, 402, { detail: 'Insufficient credits' }, 'quota', /TypeSafeの残高/],
    [OR, 403, { error: { message: 'Key limit exceeded' } }, 'permission', /Jevを使えない.*Key limit exceeded/],
    [TS, 404, { detail: 'Not Found' }, 'notfound', /接続先が見つかりません/],
    [TS, 422, { detail: [{ loc: ['body', 'state'], msg: 'Field required', type: 'missing' }] }, 'badrequest', /受け付けませんでした.*Field required/],
    [OR, 500, { message: 'oops' }, 'server', /一時的な不具合/],
    [OR, 529, { error: { message: 'Provider returned error' } }, 'server', /一時的な不具合/],
    [TS, 503, null, 'server', /一時的な不具合/],
  ];
  for (const [cfg, status, body, code, message] of cases) {
    responder = () => (body ? json(status, body) : new Response('', { status }));
    await assert.rejects(Jev.judge(cfg, 'x'), { code, message }, cfg.route + ' ' + status);
  }
});

test('TypeSafeに、ブラウザからの接続を断られたら(読めた場合)、OpenRouter経由を勧めて止める', async () => {
  responder = () => json(400, { detail: 'Disallowed CORS origin' });
  await assert.rejects(Jev.judge(TS, 'x'), { code: 'badrequest', message: /受け付けていないようです。接続先を「OpenRouter経由」にしてください。.*Disallowed CORS origin/ });
});

test('混雑(429)のときは、示された待ち時間を読む(retry-after-ms を優先し、なければ retry-after)', async () => {
  responder = () => json(429, { detail: 'Too many requests' }, { 'retry-after-ms': '1500', 'retry-after': '9' });
  await assert.rejects(Jev.judge(TS, 'x'), { code: 'ratelimit', retryAfterMs: 1500 });
  responder = () => json(429, { error: { code: 429, message: 'Rate limit exceeded' } }, { 'retry-after': '4' });
  await assert.rejects(Jev.judge(OR, 'x'), { code: 'ratelimit', retryAfterMs: 4000 });
  responder = () => json(429, { detail: 'Too many requests' });
  await assert.rejects(Jev.judge(OR, 'x'), { code: 'ratelimit', retryAfterMs: 0 });
});

test('つながらない(ブラウザが止めた場合も)・時間切れを、利用者向けのエラーにする', async () => {
  responder = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(Jev.judge(OR, 'x'), { code: 'network', message: /^OpenRouterに接続できませんでした。ネットワークを確認してください。$/ });
  // TypeSafeは、ブラウザからの接続を受け付けないので、OpenRouter経由を勧める
  responder = () => Promise.reject(new TypeError('Load failed'));
  await assert.rejects(Jev.judge(TS, 'x'), { code: 'network', message: /TypeSafeに接続できませんでした。.*受け付けていないようです。接続先を「OpenRouter経由」にしてください。/ });
  responder = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(Jev.judge(OR, 'x', { timeoutMs: 50 }), { code: 'timeout', message: /時間内に返りませんでした/ });
  assert.ok(Date.now() - started < 2000);
});

test('会議中の判定は、5秒で打ち切る(待たせずにAIへ送れるように)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  responder = () => new Promise(() => {});
  let settled = false;
  const pending = Jev.judge(OR, 'x').catch((e) => {
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
  const out = await Jev.testConnection(OR, { onUsage: (u) => usages.push(u) });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.url === 'https://openrouter.ai/api/v1/systemone'));
  assert.deepEqual(out.samples.map((s) => s.text), Jev.TEST_SAMPLES);
  assert.deepEqual(out.samples.map((s) => [s.verdict.terms, s.verdict.risks]), [[0.96, 0.81], [0.03, 0.04]]);
  assert.equal(out.usage.input, 304);
  assert.equal(out.usage.output, 4);
  assert.equal(usages.length, 2);
  assert.ok(out.ms >= 0);
});
