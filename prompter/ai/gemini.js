// Gemini(Google)への接続。利用者が入れたAPIキーで、ブラウザから直接呼ぶ。
import {
  AIError, MESSAGES, RESULT_SCHEMA, SYSTEM_ANALYZE, SYSTEM_EXPLAIN, SYSTEM_SUMMARY,
  buildAnalyzeInput, buildExplainInput, buildSummaryInput, fetchJson, httpError, normalizeResult,
  parseJsonLoose, readSse,
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

const BLOCKED = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'];

async function errorOf(res) {
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && data.error && (data.error.message || data.error.status);
  return httpError(res.status, detail);
}

// 検索の裏付け情報は、何回かに分けて届くことがあるので、まとめる
function mergeMeta(meta, next) {
  if (!next) return meta;
  const base = meta || { groundingChunks: [], webSearchQueries: [], searchEntryPoint: null };
  return {
    groundingChunks: base.groundingChunks.concat(next.groundingChunks || []),
    webSearchQueries: [...new Set(base.webSearchQueries.concat(next.webSearchQueries || []))],
    searchEntryPoint: next.searchEntryPoint || base.searchEntryPoint,
  };
}

// 情報源(https のものだけ。同じ名前は1つにまとめる)
function sourcesOf(meta) {
  const out = [];
  const seen = new Set();
  for (const chunk of (meta && meta.groundingChunks) || []) {
    const web = chunk && chunk.web;
    if (!web || !/^https:\/\//.test(String(web.uri || ''))) continue;
    const title = String(web.title || web.uri);
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, uri: web.uri });
  }
  return out.slice(0, 8);
}

// 「要点」: Google検索で確かめながら、3行の要点を少しずつ受け取る
export async function summarize(cfg, term, quote, opts = {}) {
  const model = String(opts.model || cfg.model || '').trim().replace(/^models\//, '');
  const url = GEMINI_BASE + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse';
  const key = 'summary:' + model;
  const build = (withOptional) => {
    const thinking = withOptional ? thinkingConfig(model) : null;
    return {
      systemInstruction: { parts: [{ text: SYSTEM_SUMMARY }] },
      contents: [{ role: 'user', parts: [{ text: buildSummaryInput(term, quote, opts.today) }] }],
      tools: [{ google_search: {} }],
      generationConfig: thinking ? { thinkingConfig: thinking } : {},
    };
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 90000);
  const send = (withOptional) => fetch(url, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(build(withOptional)),
    signal: ctrl.signal,
  });
  try {
    const withOptional = !plainModels.has(key);
    let res = await send(withOptional);
    if (!res.ok) {
      const err = await errorOf(res);
      if (!(withOptional && err.code === 'badrequest')) throw err;
      // 考える量の指定を受け付けないモデルなら、外して1回だけ送り直す
      plainModels.add(key);
      res = await send(false);
      if (!res.ok) throw await errorOf(res);
    }
    let text = '';
    let meta = null;
    let finish = '';
    await readSse(res, (chunk) => {
      if (chunk.error) throw httpError(chunk.error.code || 500, chunk.error.message);
      if (chunk.promptFeedback && chunk.promptFeedback.blockReason) throw new AIError('refusal', MESSAGES.refusal);
      const cand = chunk.candidates && chunk.candidates[0];
      if (!cand) return;
      if (cand.groundingMetadata) meta = mergeMeta(meta, cand.groundingMetadata);
      if (cand.finishReason) finish = cand.finishReason;
      const parts = (cand.content && cand.content.parts) || [];
      const added = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      if (added) {
        text += added;
        if (opts.onText) opts.onText(text);
      }
    });
    if (BLOCKED.includes(finish)) throw new AIError('refusal', MESSAGES.refusal);
    if (!text.trim()) throw new AIError('parse', MESSAGES.parse);
    return {
      text: text.trim(),
      sources: sourcesOf(meta),
      queries: (meta && meta.webSearchQueries) || [],
      // Googleの規約で、検索で裏付けた結果には、この「検索候補」の表示が必要
      suggestionHtml: (meta && meta.searchEntryPoint && meta.searchEntryPoint.renderedContent) || '',
      model,
      truncated: finish === 'MAX_TOKENS',
    };
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (e && e.name === 'AbortError') throw new AIError('timeout', MESSAGES.timeout);
    throw new AIError('network', MESSAGES.network);
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(cfg) {
  const data = await fetchJson(GEMINI_BASE + '/models?pageSize=200', { method: 'GET', headers: headers(cfg) });
  return ((data && data.models) || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => m.id && /^gemini/.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
