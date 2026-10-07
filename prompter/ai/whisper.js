// Whisper(音声→文字)。Groq と OpenAI の、同じ形の口(/audio/transcriptions)に、
// 利用者が入れたAPIキーで、ブラウザから直接送る。
import { AIError, MESSAGES, httpError, retryAfterOf, withDetail } from './common.js';
import { silenceWav } from '../audio.js';

export const STT_PROVIDERS = {
  groq: {
    label: 'Whisper(Groq・無料枠あり)',
    short: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_で始まるキー',
    keyUrl: 'https://console.groq.com/keys',
    keySite: 'GroqCloud',
    defaultModel: 'whisper-large-v3',
    models: [
      { id: 'whisper-large-v3', label: 'whisper-large-v3(精度重視・標準)' },
      { id: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo(速い)' },
    ],
    // 無料枠(1分20回・1時間に音声2時間分。1回は10秒以上として数えられる)に収まるよう、5秒は間をあける
    minIntervalMs: 5000,
  },
  openai: {
    label: 'Whisper系(OpenAI・有料)',
    short: 'OpenAI',
    base: 'https://api.openai.com/v1',
    keyHint: 'sk-で始まるキー(ChatGPTと同じ)',
    keyUrl: 'https://platform.openai.com/api-keys',
    keySite: 'OpenAI Platform',
    defaultModel: 'gpt-transcribe',
    models: [
      { id: 'gpt-transcribe', label: 'gpt-transcribe(標準)' },
      { id: 'whisper-1', label: 'whisper-1(以前のWhisper)' },
    ],
    minIntervalMs: 500,
  },
};

export function sttProvider(id) {
  return Object.prototype.hasOwnProperty.call(STT_PROVIDERS, id) ? STT_PROVIDERS[id] : null;
}

const TIMEOUT = { transcribe: 30000, test: 20000 };
const PROMPT_MAX = 200; // Whisperが読むヒントは、224トークンまで(日本語はおよそ1文字1〜2トークン)

// Whisperに渡すヒント。よく出る言葉と、直前の発言(続きとして書いてもらうため)
export function buildPrompt({ hints = [], previous = '' } = {}) {
  const words = [...new Set(hints.map((h) => String(h).trim()).filter(Boolean))];
  let head = '';
  for (const w of words) {
    const next = head ? head + '、' + w : w;
    if (next.length > 120) break;
    head = next;
  }
  const prev = String(previous || '').trim().slice(-60);
  const prompt = (head ? '用語: ' + head + '。' : '') + prev;
  return prompt.slice(-PROMPT_MAX);
}

// Whisperが、無音や雑音のときに作ってしまいやすい文(動画の字幕で覚えた決まり文句など)
const HALLUCINATIONS = [
  /^ご視聴(いただき)?(誠に)?ありがとうございま(した|す)[。!！]*$/,
  /^(最後まで)?ご覧いただき(まして)?ありがとうございま(した|す)[。!！]*$/,
  /チャンネル登録/,
  /^(字幕|翻訳|編集)[:：は]/,
  /^(thanks?|thank you)( so much)? for watching[.!]*$/i,
  /^please subscribe/i,
];

const normalize = (s) => String(s || '').replace(/[\s、。,.!?！？・「」『』()（）[\]【】…:：-]/g, '');

// 文字にした結果を整える。決まり文句や、ヒントをそのまま返しただけのもの、記号だけのものは捨てる
export function cleanTranscript(text, prompt = '') {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const bare = normalize(t);
  if (!bare) return '';
  // (拍手)[音楽] ♪ のような、音の説明だけのもの
  if (/^([(（[【♪][^)）\]】]*[)）\]】]?\s*)+$/.test(t) || /^[♪〜~\s]+$/.test(t)) return '';
  // 同じ文字の繰り返しだけ(「ああああ」など)
  if (/^(.)\1{2,}$/.test(bare)) return '';
  if (HALLUCINATIONS.some((re) => re.test(t))) return '';
  // ヒントをそのまま返しただけ(静かなときに起きやすい)。短い語は、本当に話したこともあるので残す
  if (bare.length >= 8 && normalize(prompt).includes(bare)) return '';
  return t;
}

// 詳しい結果(verbose_json)の区切りのうち、「話していない」「繰り返しの作り話」らしいものを除く
function keptSegments(segments) {
  return segments.filter((s) => {
    if (!s || typeof s.text !== 'string') return false;
    const silent = Number(s.no_speech_prob) > 0.6 && Number(s.avg_logprob) < -1;
    const repetitive = Number(s.compression_ratio) > 2.4;
    return !silent && !repetitive;
  });
}

// 詳しい結果を返せるモデル(区切りごとに、話していない確率がわかる)
const verbose = (model) => /whisper/.test(model);

// 受け付けなかった指定(ヒントなど)は、次から付けない
const plainModels = new Set();

// 待ち時間を、本文の「try again in 1m2.5s」からも読む(見出しが読めないブラウザ向け)
function retryAfterFromMessage(message) {
  const m = String(message || '').match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  return m ? Math.round(((Number(m[1]) || 0) * 60 + Number(m[2])) * 1000) : 0;
}

function errorFrom(p, status, data, headers) {
  const message = data && data.error && (data.error.message || data.error.status);
  if (status === 401) return new AIError('auth', p.short + 'のAPIキーが正しくないようです。設定を確認してください。');
  if (status === 403) return new AIError('permission', withDetail('このキーでは、' + p.short + 'の聞き取りを使えないようです', message) + '。');
  if (status === 404) return new AIError('notfound', '聞き取りのモデルが見つかりません。設定で選び直してください。');
  if (status === 429) {
    // 1日の上限(Groqは「per day」と書いて返す)は、待っても戻らない
    if (/per day|\(RPD\)|\(ASD\)|insufficient_quota/i.test(String(message) + ' ' + String(data && data.error && data.error.code))) {
      return new AIError('quota', '音声の聞き取りの、1日の上限に達しました。');
    }
    return new AIError('ratelimit', MESSAGES.ratelimit, { retryAfterMs: retryAfterOf(headers, data) || retryAfterFromMessage(message) });
  }
  if (status === 413) return new AIError('badrequest', '音声が大きすぎて、受け付けられませんでした。');
  return httpError(status, message, data, headers);
}

async function post(cfg, wav, fields, timeoutMs) {
  const p = sttProvider(cfg.provider);
  if (!p) throw new AIError('config', '聞き取りの方法が選ばれていません。');
  const key = String(cfg.apiKey || '').trim();
  if (!key) throw new AIError('config', p.short + 'のAPIキーが入っていません。');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  Object.entries(fields).forEach(([k, v]) => { if (v !== undefined && v !== '') form.append(k, String(v)); });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(p.base + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
      signal: ctrl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
    }
    if (!res.ok) throw errorFrom(p, res.status, data, res.headers);
    return data;
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (e && e.name === 'AbortError') throw new AIError('timeout', '音声の聞き取りの応答が、時間内に返りませんでした。');
    throw new AIError('network', withDetail(p.short + 'に接続できませんでした。ネットワークを確認してください', 'ブラウザからの接続が許可されていない可能性もあります') + '。');
  } finally {
    clearTimeout(timer);
  }
}

// 音声(WAV)を文字にする。opts.prompt: ヒント、opts.onUsage({ provider, model, seconds }): 送った音声の長さ
export async function transcribe(cfg, wav, opts = {}) {
  const p = sttProvider(cfg.provider);
  const model = String(cfg.model || (p && p.defaultModel) || '').trim();
  const key = (p ? cfg.provider : '') + ':' + model;
  const detailed = verbose(model);
  const build = (withOptional) => ({
    model,
    language: 'ja',
    response_format: withOptional && detailed ? 'verbose_json' : 'json',
    temperature: withOptional ? 0 : undefined,
    prompt: withOptional ? opts.prompt : undefined,
  });
  const withOptional = !plainModels.has(key);
  let data;
  try {
    data = await post(cfg, wav, build(withOptional), opts.timeoutMs || TIMEOUT.transcribe);
  } catch (e) {
    if (!(withOptional && e instanceof AIError && e.code === 'badrequest')) throw e;
    plainModels.add(key);
    data = await post(cfg, wav, build(false), opts.timeoutMs || TIMEOUT.transcribe);
  }
  if (typeof opts.onUsage === 'function') {
    try {
      opts.onUsage({ provider: cfg.provider, model, seconds: Math.max(0, (wav.length - 44) / 2 / 16000) });
    } catch (e) { /* 無視 */ }
  }
  const segments = data && Array.isArray(data.segments) ? data.segments : null;
  const text = segments ? keptSegments(segments).map((s) => s.text.trim()).join('') : String((data && data.text) || '');
  return cleanTranscript(text, opts.prompt);
}

// 1秒の無音を送って、キーとモデルで呼べるかを確かめる
export async function testConnection(cfg, opts = {}) {
  const started = Date.now();
  await transcribe(cfg, silenceWav(1), { timeoutMs: TIMEOUT.test, onUsage: opts.onUsage });
  return { ms: Date.now() - started };
}
