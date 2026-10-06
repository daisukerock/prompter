// ChatGPT(OpenAI)と、OpenAI互換の接続先(Ollama・LM Studio・OpenRouterなど)への接続。
// 利用者が入れたAPIキーで、ブラウザから直接呼ぶ。
import {
  AIError, MESSAGES, SYSTEM_ANALYZE, SYSTEM_EXPLAIN,
  buildAnalyzeInput, buildExplainInput, fetchJson, normalizeResult, parseJsonLoose,
} from './common.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

function baseUrl(cfg) {
  if (cfg.provider !== 'compatible') return OPENAI_BASE;
  const url = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new AIError('config', '接続先URLを、http(s)://から入力してください。');
  return url;
}

function headers(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey;
  return h;
}

// 考える量を指定できるモデル(OpenAI本家のみ)
function isReasoningModel(cfg) {
  return cfg.provider === 'openai' && /^(gpt-5|gpt-6|o\d)/.test(cfg.model);
}

// 任意の指定を受け付けなかった接続先とモデルは、次回から付けない
const plainModels = new Set();

async function chat(cfg, system, user, json) {
  const url = baseUrl(cfg) + '/chat/completions';
  const key = cfg.provider + ':' + cfg.model;
  const build = (withOptional) => {
    const body = {
      model: cfg.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
    if (withOptional && json) body.response_format = { type: 'json_object' };
    if (withOptional && isReasoningModel(cfg)) body.reasoning_effort = 'low';
    return body;
  };
  const withOptional = !plainModels.has(key);
  let data;
  try {
    data = await fetchJson(url, { headers: headers(cfg), body: build(withOptional) });
  } catch (e) {
    if (!(withOptional && e instanceof AIError && e.code === 'badrequest')) throw e;
    plainModels.add(key);
    data = await fetchJson(url, { headers: headers(cfg), body: build(false) });
  }
  const choice = data && data.choices && data.choices[0];
  if (!choice) throw new AIError('parse', MESSAGES.parse);
  if (choice.finish_reason === 'content_filter' || (choice.message && choice.message.refusal)) {
    throw new AIError('refusal', MESSAGES.refusal);
  }
  if (choice.finish_reason === 'length') throw new AIError('parse', 'AIの回答が、途中で切れました。');
  return String((choice.message && choice.message.content) || '');
}

export async function analyze(cfg, input) {
  const text = await chat(cfg, SYSTEM_ANALYZE, buildAnalyzeInput(input), true);
  return normalizeResult(parseJsonLoose(text));
}

export async function explain(cfg, term, quote) {
  const text = await chat(cfg, SYSTEM_EXPLAIN, buildExplainInput(term, quote), false);
  return text.trim();
}

export async function listModels(cfg) {
  const data = await fetchJson(baseUrl(cfg) + '/models', { method: 'GET', headers: headers(cfg) });
  const ids = ((data && data.data) || []).map((m) => m.id).filter(Boolean);
  // OpenAI本家は、文章を作るモデルだけに絞る(音声・画像・埋め込み用などを除く)
  const usable = cfg.provider === 'openai'
    ? ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
    : ids;
  return usable.sort().map((id) => ({ id, label: id }));
}
