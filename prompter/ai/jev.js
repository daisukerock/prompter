// Jev(TypeSafe)への接続。AIに送る前に、発言に「知らない言葉」や「気をつけたい点」がありそうかを判定してもらう。
// Jevは文章を作らず、「はい」である確率(0〜1)だけを返すので、速くて安い。
// 利用者が入れたAPIキーで、ブラウザから直接呼ぶ。
import { AIError, makeUsage, retryAfterOf, withDetail } from './common.js';

// 接続先。TypeSafe(本家)のAPIは、ブラウザからの直接の呼び出しを受け付けないため、ふだんはOpenRouter経由で呼ぶ。
// OpenRouterのSystem One APIは、TypeSafeと同じ形で受け取って同じ形で返し、モデル名(jev-latest)もそのまま通じる。
// keyName: キーを保存する名前(TypeSafeのキーは、以前から jev に保存している)
export const JEV_ROUTES = {
  openrouter: {
    label: 'OpenRouter経由(おすすめ)',
    short: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/systemone',
    keyName: 'openrouter',
    keyHint: 'sk-or-で始まるキー',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keySite: 'OpenRouterの「API Keys」',
    quota: 'OpenRouterのクレジット(残高)が足りないか、キーの利用上限に達しました。OpenRouterの画面で確認してください。',
    network: 'OpenRouterに接続できませんでした。ネットワークを確認してください。',
  },
  typesafe: {
    label: 'TypeSafe(直接)',
    short: 'TypeSafe',
    url: 'https://api.typesafe.ai/v1/systemone',
    keyName: 'jev',
    keyHint: 'TypeSafeのAPIキー',
    keyUrl: 'https://console.typesafe.ai/',
    keySite: 'TypeSafeのコンソール',
    quota: 'TypeSafeの残高が足りないか、利用上限に達しました。TypeSafeのコンソールで確認してください。',
    network: 'TypeSafeに接続できませんでした。TypeSafeは、ブラウザ(このアプリ)からの直接の接続を受け付けていないようです。接続先を「OpenRouter経由」にしてください。',
  },
};
export const DEFAULT_ROUTE = 'openrouter';
export const JEV_MODEL = 'jev-latest';

export function jevRoute(id) {
  return Object.prototype.hasOwnProperty.call(JEV_ROUTES, id) ? JEV_ROUTES[id] : null;
}

// 待ち時間の上限(会議中は、待たせずにAIへ送れるよう短く)
const TIMEOUT = { judge: 5000, test: 20000 };

// 毎回同じ文面で聞く。判定の基準は、AIへの依頼文(common.js の SYSTEM_ANALYZE)と合わせる
export const QUESTIONS = {
  terms: {
    type: 'noul',
    instructions: 'この発言に、一般の社会人がすぐには意味を説明できない語が含まれていますか?(略語、専門用語、業界用語、カタカナ語、制度名、法令名、組織名、まだ広く定着していない新語・造語・流行語、一部の業界や会社だけで通じる言い回しなど)',
    criteria: {
      true: '意味を確かめたくなる語が、1つ以上ある',
      false: '日常語や、ほとんどの人が知っている語だけ',
    },
  },
  risks: {
    type: 'noul',
    instructions: 'この発言に、聞き流すと後で困りそうな点が含まれていますか?(約束・断定、金額・数値、期限・日程、契約・法務、個人情報・機密、依頼・宿題、懸念・未決事項など)',
    criteria: {
      true: 'その場で確認や注意をしたほうがよい点が、1つ以上ある',
      false: 'あいさつ・相づち・雑談・進行の言葉など、注意の要らない発言だけ',
    },
  },
};

// 接続テストで使う文(AIに送りたい発言と、送らなくてよい発言)
export const TEST_SAMPLES = [
  'ステークホルダーとのコンセンサスが取れていないので、いったんペンディングです。',
  'お疲れさまです。今日は、いい天気ですね。',
];

// 利用者に見せる文。キー・残高・つながらないときの文は、接続先ごとに変える
const MESSAGES = {
  route: 'Jevの接続先が正しくありません。',
  permission: 'このキーでは、Jevを使えないようです。',
  notfound: 'Jevの接続先が見つかりませんでした。',
  ratelimit: 'Jevが混雑しているか、1分あたりの上限にかかりました。',
  server: 'Jev側で、一時的な不具合が起きています。',
  timeout: 'Jevの応答が、時間内に返りませんでした。',
  parse: 'Jevの回答を読み取れませんでした。',
  badrequest: 'Jevが、リクエストを受け付けませんでした。',
};

export function messagesFor(route) {
  return {
    ...MESSAGES,
    config: route.short + 'のAPIキーが入っていません。',
    auth: route.short + 'のAPIキーが正しくないようです。',
    quota: route.quota,
    network: route.network,
  };
}

// エラーの本文から、理由の文を取り出す(TypeSafeは detail に入れて返すことが多い)
function detailOf(body) {
  if (!body || typeof body !== 'object') return '';
  const { error, message, detail } = body;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  if (typeof message === 'string') return message;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail.message === 'string') return detail.message;
  if (Array.isArray(detail)) return detail.filter((d) => d && typeof d.msg === 'string').map((d) => d.msg).join('; ');
  return '';
}

// 何ミリ秒後にやり直せばよいか(TypeSafeは retry-after-ms も返す)
function retryAfterMsOf(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after-ms') : null;
  const ms = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : retryAfterOf(headers, null);
}

function statusError(route, status, body, headers) {
  const m = messagesFor(route);
  const detail = detailOf(body);
  if (status === 401) return new AIError('auth', m.auth);
  if (status === 402) return new AIError('quota', m.quota);
  if (status === 403) return new AIError('permission', withDetail(m.permission, detail));
  if (status === 404) return new AIError('notfound', m.notfound);
  if (status === 408) return new AIError('timeout', m.timeout);
  if (status === 429) return new AIError('ratelimit', m.ratelimit, { retryAfterMs: retryAfterMsOf(headers) });
  if (status >= 500) return new AIError('server', m.server);
  // ブラウザからの呼び出しを断られた(TypeSafeは、400「Disallowed CORS origin」を返すことがある)
  if (/cors/i.test(detail)) return new AIError('badrequest', withDetail(m.network, detail));
  return new AIError('badrequest', withDetail(m.badrequest, detail));
}

async function post(route, apiKey, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(route.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
    if (!res.ok) throw statusError(route, res.status, data, res.headers);
    return data;
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (e && e.name === 'AbortError') throw new AIError('timeout', MESSAGES.timeout);
    throw new AIError('network', route.network);
  } finally {
    clearTimeout(timer);
  }
}

// 「はい」である確率を読む(0〜1の数でなければ、読めなかった扱い)
function noulOf(answers, name) {
  const a = answers && answers[name];
  const v = a && typeof a.noul === 'number' ? a.noul : NaN;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

// 発言を判定する。cfg: { route: 接続先(JEV_ROUTES の名前), apiKey }。
// 返す terms: 知らない言葉がありそうな確率、risks: 気をつけたい点がありそうな確率。
// opts.onUsage(使った数) で、使ったトークン数を知らせる(知らせる先で失敗しても、判定は捨てない)
export async function judge(cfg, text, opts = {}) {
  const route = jevRoute(cfg && cfg.route);
  if (!route) throw new AIError('config', MESSAGES.route);
  const key = String((cfg && cfg.apiKey) || '').trim();
  if (!key) throw new AIError('config', messagesFor(route).config);
  const data = await post(route, key, { state: String(text || ''), model: JEV_MODEL, questions: QUESTIONS }, opts.timeoutMs || TIMEOUT.judge);
  const model = String((data && data.model) || JEV_MODEL);
  const u = data && data.usage;
  const usage = u ? makeUsage({ input: u.input_tokens, output: u.output_tokens }) : null;
  if (usage && typeof opts.onUsage === 'function') {
    try {
      opts.onUsage({ ...usage, provider: 'jev', model });
    } catch (e) { /* 無視 */ }
  }
  const terms = noulOf(data && data.answers, 'terms');
  const risks = noulOf(data && data.answers, 'risks');
  if (terms === null || risks === null) throw new AIError('parse', MESSAGES.parse);
  return { terms, risks, model };
}

// 例文で、実際に呼べるかを確かめる(判定の結果と、使ったトークン数の合計も返す)
export async function testConnection(cfg, opts = {}) {
  const started = Date.now();
  let total = null;
  const onUsage = (u) => {
    total = total ? { ...total, input: total.input + u.input, output: total.output + u.output } : u;
    if (typeof opts.onUsage === 'function') opts.onUsage(u);
  };
  const verdicts = await Promise.all(TEST_SAMPLES.map((text) => judge(cfg, text, { timeoutMs: TIMEOUT.test, onUsage })));
  return {
    samples: TEST_SAMPLES.map((text, i) => ({ text, verdict: verdicts[i] })),
    ms: Date.now() - started,
    usage: total,
  };
}
