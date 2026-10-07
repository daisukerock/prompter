// 聞き取り(音声認識)が途切れても、自分で立て直す仕組み。音声認識は、まねたものに差し替える
import { test, expect } from './fixtures.js';

test.use({ viewport: { width: 390, height: 844 } });

// 本物の代わりの音声認識。window.__speech から、聞こえた文・エラー・終了を起こせる
function installFakeSpeech() {
  const speech = { instances: [], failStart: 0, endRightAway: false, visibility: 'visible' };
  window.__speech = speech;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => speech.visibility });
  class FakeRecognition {
    constructor() {
      this.running = false;
      speech.instances.push(this);
    }
    start() {
      if (speech.failStart > 0) {
        speech.failStart--;
        throw new Error('InvalidStateError');
      }
      this.running = true;
      setTimeout(() => {
        if (this.onstart) this.onstart();
        // すぐ止まってしまう状態(通信できない、など)をまねる
        if (speech.endRightAway) setTimeout(() => this.fail('network'), 20);
      }, 10);
    }
    stop() {
      if (!this.running) return;
      this.running = false;
      setTimeout(() => { if (this.onend) this.onend(); }, 10);
    }
    abort() {
      this.running = false;
    }
    say(text) {
      const result = [{ transcript: text }];
      result.isFinal = true;
      if (this.onresult) this.onresult({ resultIndex: 0, results: [result] });
    }
    fail(code) {
      if (this.onerror) this.onerror({ error: code });
      this.end();
    }
    end() {
      this.running = false;
      if (this.onend) this.onend();
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
}

const label = (page) => page.locator('#listenLabel');
const latest = (page, fn, arg) => page.evaluate(({ fn, arg }) => {
  const list = window.__speech.instances;
  return list[list.length - 1][fn](arg);
}, { fn, arg });
const count = (page) => page.evaluate(() => window.__speech.instances.length);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFakeSpeech);
  await page.goto('index.html');
});

test('聞き取り開始→聞いた文がカードになり、押すと止まる', async ({ page }) => {
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await expect(page.locator('#listenBtn')).toHaveClass(/is-live/);
  await latest(page, 'say', 'NDAの話です。');
  await expect(page.locator('#cards .card-title').filter({ hasText: /^NDA$/ })).toHaveCount(1);
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞き取り開始');
  await expect(page.locator('#status')).toHaveText('');
});

test('普通の区切りで止まったら、すぐ作り直して聞き続ける(表示は変えない)', async ({ page }) => {
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await page.waitForTimeout(3100); // 3秒より長く聞いてから止まった = 普通の区切り
  await latest(page, 'end');
  await expect.poll(() => count(page)).toBe(2);
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await latest(page, 'say', 'SLAの話です。');
  await expect(page.locator('#cards .card-title').filter({ hasText: /^SLA$/ })).toHaveCount(1);
});

test('すぐ止まるのが続くと、間をあけて立て直し、そのことを表示する。直れば元に戻る', async ({ page }) => {
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await page.evaluate(() => { window.__speech.endRightAway = true; });
  await latest(page, 'fail', 'network');
  await expect(label(page)).toHaveText('立て直しています(押すと停止)');
  await expect(page.locator('#listenBtn')).toHaveClass(/is-recovering/);
  await expect(page.locator('#status')).toContainText('ネットワークにつながらないため');
  // 一瞬始まっても、すぐ止まるあいだは「聞いています」に戻さない(表示の変化をすべて記録して確かめる)
  await page.evaluate(() => {
    window.__labels = [];
    new MutationObserver(() => window.__labels.push(document.querySelector('#listenLabel').textContent))
      .observe(document.querySelector('#listenLabel'), { childList: true, characterData: true, subtree: true });
  });
  // 間をあけて試すので、作り直しは少しずつ(2.5秒で数回まで)
  const before = await count(page);
  await page.waitForTimeout(2500);
  expect(await count(page) - before).toBeLessThanOrEqual(3);
  expect(await page.evaluate(() => window.__labels.filter((t) => t.startsWith('聞いています')))).toEqual([]);

  await page.evaluate(() => { window.__speech.endRightAway = false; });
  await expect(label(page)).toHaveText('聞いています(押すと停止)', { timeout: 15_000 });
  await expect(page.locator('#status')).toHaveText('聞いています…(画面は点けたままにしてください)');
});

test('始められなかったときも、あとで立て直す', async ({ page }) => {
  await page.evaluate(() => { window.__speech.failStart = 1; });
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  expect(await count(page)).toBe(2);
});

test('マイクが使えないときは止めて、理由を出す', async ({ page }) => {
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await latest(page, 'fail', 'audio-capture');
  await expect(label(page)).toHaveText('聞き取り開始');
  await expect(page.locator('#status')).toHaveText('マイクを使えませんでした。ほかのアプリがマイクを使っていないか、確かめてください。');
  await page.waitForTimeout(800);
  expect(await count(page)).toBe(1);
});

test('画面が隠れている間は立て直さず、戻ったら立て直す', async ({ page }) => {
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await page.evaluate(() => {
    window.__speech.visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await latest(page, 'end');
  await page.waitForTimeout(1200);
  expect(await count(page)).toBe(1);
  await page.evaluate(() => {
    window.__speech.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => count(page)).toBe(2);
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
});

test('立て直し中でも、聞こえたらすぐ元の表示に戻す', async ({ page }) => {
  await page.click('#listenBtn');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await page.evaluate(() => { window.__speech.failStart = 1; });
  await latest(page, 'fail', 'network');
  await expect(label(page)).toHaveText('立て直しています(押すと停止)');
  await expect.poll(() => page.evaluate(() => {
    const list = window.__speech.instances;
    return list[list.length - 1].running;
  })).toBe(true);
  await latest(page, 'say', 'KPIの話です。');
  await expect(label(page)).toHaveText('聞いています(押すと停止)');
  await expect(page.locator('#cards .card-title').filter({ hasText: /^KPI$/ })).toHaveCount(1);
});
