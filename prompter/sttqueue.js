// Whisperに送る順番を待っている発言(音)の扱いと、失敗したときの決め方。
// 画面には触らない関数だけを置く(テストしやすいように)
import { backoff, rateLimitWait } from './pacing.js';

export const MAX_QUEUE_MS = 180000; // つながらない間にためておくのは、3分ぶんまで(古いものから捨てる)
export const MERGE_MAX_MS = 30000; // まとめて送るのは、30秒ぶんまで
export const GAP_MS = 300; // まとめるときに、発言の間に入れる無音
export const FALLBACK_AFTER = 2; // 一度も文字にできないまま、つながらないのがこの回数続いたら、標準の聞き取りに切り替える

// 発言 { samples, ms } を、後ろに足す。たまりすぎたら、古いものから捨てる
export function enqueue(queue, item, maxMs = MAX_QUEUE_MS) {
  const next = queue.concat([item]);
  let total = next.reduce((n, x) => n + x.ms, 0);
  let dropped = 0;
  while (next.length > 1 && total > maxMs) {
    total -= next.shift().ms;
    dropped++;
  }
  return { queue: next, dropped };
}

// 前から、まとめて送る分を取り出す(1つは必ず取り出す)
export function takeMerged(queue, maxMs = MERGE_MAX_MS) {
  let ms = 0;
  let n = 0;
  while (n < queue.length && (n === 0 || ms + GAP_MS + queue[n].ms <= maxMs)) {
    ms += (n ? GAP_MS : 0) + queue[n].ms;
    n++;
  }
  return { items: queue.slice(0, n), rest: queue.slice(n) };
}

// 取り出した発言の音を、間に短い無音をはさんで、1つにつなぐ
export function joinSamples(items, rate = 16000) {
  const gap = Math.round((GAP_MS / 1000) * rate);
  const out = new Float32Array(items.reduce((n, x, i) => n + x.samples.length + (i ? gap : 0), 0));
  let at = 0;
  items.forEach((x, i) => {
    if (i) at += gap;
    out.set(x.samples, at);
    at += x.samples.length;
  });
  return out;
}

// 設定を直さないと使えないエラー(キーの誤り・1日の上限など)
export const STOP_CODES = ['auth', 'permission', 'notfound', 'config', 'quota', 'badrequest'];

// Whisperで失敗したあと、どうするか。
// fallback: 標準の聞き取りに切り替える / retry: wait ミリ秒待ってから、同じ発言を送り直す
// succeeded: この聞き取りで、一度でも文字にできたか(できていなければ、つながらない原因は設定や環境の可能性が高い)
export function afterSttError({ failures = 0, succeeded = false } = {}, error) {
  const code = error && error.code;
  if (STOP_CODES.includes(code)) return { action: 'fallback', failures: 0, wait: 0 };
  if (code === 'ratelimit') return { action: 'retry', failures, wait: rateLimitWait(error.retryAfterMs) };
  const next = failures + 1;
  if (!succeeded && next >= FALLBACK_AFTER) return { action: 'fallback', failures: 0, wait: 0 };
  return { action: 'retry', failures: next, wait: backoff(next) };
}
