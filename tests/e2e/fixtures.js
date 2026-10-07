// 通しテストの共通部品
import { test as base, expect } from '@playwright/test';

// Googleの検索候補を入れる枠(sandbox)は、スクリプトを動かさない。テストの記録(trace)が
// その枠にスクリプトを入れようとして止められたときに出る表示で、枠が正しく働いている証拠
const SANDBOX_NOTICE = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/;

// 意図して起こしたエラー(401・503など)のほかに、コンソールのエラーやCSP違反が出たら失敗にする
export const test = base.extend({
  allowedErrors: [[], { option: true }],
  problems: [async ({ page, allowedErrors }, use) => {
    const problems = [];
    const allowed = (text) => SANDBOX_NOTICE.test(text) || allowedErrors.some((re) => re.test(text));
    page.on('pageerror', (e) => {
      if (!allowed(e.message)) problems.push('pageerror: ' + e.message);
    });
    page.on('console', (m) => {
      const text = m.text();
      if (m.type() !== 'error' && !/Content Security Policy|Refused to/.test(text)) return;
      if (!allowed(text)) problems.push('console: ' + text);
    });
    await use(problems);
    expect(problems, 'コンソールのエラーやCSP違反がないこと').toEqual([]);
  }, { auto: true }],
});

export { expect };

// AIサービスとキーを設定してから、読み込み直す
export async function useProvider(page, provider, key, extra = {}) {
  await page.goto('index.html');
  await page.evaluate(({ provider, key, extra }) => {
    localStorage.setItem('pl_settings', JSON.stringify({ version: 3, provider, aiEnabled: true, rememberKey: true, ...extra }));
    localStorage.setItem('pl_keys', JSON.stringify({ [provider]: key }));
  }, { provider, key, extra });
  await page.reload();
}

// 話した内容の代わりに、文字起こし欄から1文を送る
export async function say(page, text) {
  await page.evaluate((t) => {
    document.querySelector('#typeInput').value = t;
    document.querySelector('#typeForm').requestSubmit();
  }, text);
}

// 見出しに title を含む、聞く画面のカード
export function card(page, title) {
  return page.locator('#cards .card', { has: page.locator('.card-title', { hasText: title }) }).first();
}

// デモが終わり、AIへの送信も済むまで待つ
export async function demoDone(page) {
  await expect(page.locator('#status')).toHaveText('', { timeout: 40_000 });
  await expect(page.locator('#busyBar')).not.toHaveClass(/is-on/);
}

// 要点のシートが出る動きを終えるまで待つ(動いている途中は、つまむ場所がずれるため)
export async function sheetSettled(page) {
  await expect.poll(() => page.locator('#sheet').evaluate((s) => s.getAnimations().length)).toBe(0);
}

// 表の各行を「a | b | c」の形の文字にする
export function tableRows(page, selector) {
  return page.$$eval(selector + ' tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent).join(' | ')));
}

// 聞く画面の、使ったトークンの表示(空白を除く)
export async function chipText(page) {
  return (await page.textContent('#usageChip')).replace(/\s+/g, '');
}
