// Gemini(Google)への接続。利用者が入れたAPIキーで、ブラウザから直接呼ぶ。
import {
  AIError, MESSAGES, RESULT_SCHEMA, SYSTEM_ANALYZE, SYSTEM_EXPLAIN,
  buildAnalyzeInput, buildExplainInput, fetchJson, normalizeResult, parseJsonLoose,
} from './common.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function modelId(cfg) {
  return String(cfg.model || '').trim().replace(/^models\//, '');
}

function headers(cfg) {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey };
}

// 会議中は速さを優先して、考える量を少なめにする(モデルの世代で指定の仕方が違う)
function thinkingConfig(model) {
  if (/^gemini-[3-9].*flash-lite/.test(model)) return { thinkingLevel: 'minimal' };
  if (/^gemini-[3-9]/.test(model)) return { thinkingLevel: 'low' };
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  return null;
}

// 任意の指定を受け付けなかったモデルは、次回から付けない
const plainModels = new Set();

async function generate(cfg, system, user, json, timeoutMs) {
  const model = modelId(cfg);
  const url = GEMINI_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';
  const build = (withOptional) => {
    const generationConfig = {};
    if (json) generationConfig.responseMimeType = 'application/json';
    if (withOptional && json) generationConfig.responseJsonSchema = RESULT_SCHEMA;
    const thinking = withOptional ? thinkingConfig(model) : null;
    if (thinking) generationConfig.thinkingConfig = thinking;
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig,
    };
  };
  const withOptional = !plainModels.has(model);
  let data;
  try {
    data = await fetchJson(url, { headers: headers(cfg), body: build(withOptional), timeoutMs });
  } catch (e) {
    if (!(withOptional && e instanceof AIError && e.code === 'badrequest')) throw e;
    plainModels.add(model);
    data = await fetchJson(url, { headers: headers(cfg), body: build(false), timeoutMs });
  }
  if (data && data.promptFeedback && data.promptFeedback.blockReason) throw new AIError('refusal', MESSAGES.refusal);
  const candidate = data && data.candidates && data.candidates[0];
  if (!candidate) throw new AIError('parse', MESSAGES.parse);
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(candidate.finishReason)) {
    throw new AIError('refusal', MESSAGES.refusal);
  }
  if (candidate.finishReason === 'MAX_TOKENS') throw new AIError('parse', 'AIの回答が、途中で切れました。');
  const parts = (candidate.content && candidate.content.parts) || [];
  // 考えた過程(thought)は除いて、回答だけを使う
  return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
}

export async function analyze(cfg, input, opts = {}) {
  const text = await generate(cfg, SYSTEM_ANALYZE, buildAnalyzeInput(input), true, opts.timeoutMs);
  return normalizeResult(parseJsonLoose(text));
}

export async function explain(cfg, term, quote, opts = {}) {
  const text = await generate(cfg, SYSTEM_EXPLAIN, buildExplainInput(term, quote), false, opts.timeoutMs);
  return text.trim();
}

export async function listModels(cfg) {
  const data = await fetchJson(GEMINI_BASE + '/models?pageSize=200', { method: 'GET', headers: headers(cfg) });
  return ((data && data.models) || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => m.id && /^gemini/.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
