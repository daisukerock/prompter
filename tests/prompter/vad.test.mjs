import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSegmenter } from '../../prompter/vad.js';

const FRAME_MS = 40;
const RATE = 16000;
const SPEECH = 0.1; // 約-20dB
const QUIET = 0.0005; // 約-66dB

// [振幅, ミリ秒] の並びを、40ミリ秒ずつ渡して、区切れた発言を集める
function run(pattern, opts) {
  const seg = createSegmenter(opts);
  const out = [];
  const speakingLog = [];
  for (const [amp, ms] of pattern) {
    for (let t = 0; t < ms; t += FRAME_MS) {
      const r = seg.push(new Float32Array((RATE * FRAME_MS) / 1000).fill(amp), FRAME_MS);
      if (r) out.push(r);
      speakingLog.push(seg.speaking);
    }
  }
  return { out, seg, speakingLog };
}

// 話し声らしい音(音節の間に、短く静かになる)
function syllables(ms) {
  const pattern = [];
  for (let t = 0; t < ms; t += 240) pattern.push([SPEECH, 200], [QUIET, 40]);
  return pattern;
}

test('静かなままなら、何も区切らない', () => {
  const { out, speakingLog } = run([[QUIET, 5000]]);
  assert.equal(out.length, 0);
  assert.ok(speakingLog.every((s) => !s));
});

test('話して黙ったら、始まりの前の少しと、終わりの静かな少しを含めて1つにする', () => {
  const { out } = run([[QUIET, 1000], [SPEECH, 1000], [QUIET, 1500]]);
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.speechMs, 1000);
  assert.ok(s.ms >= 1400 && s.ms <= 1800, '前後を含めた長さ: ' + s.ms);
  assert.equal(s.frames.length * FRAME_MS, s.ms);
});

test('短い間(0.4秒)なら同じ発言、長い間(1.2秒)なら別の発言にする', () => {
  assert.equal(run([[QUIET, 1000], [SPEECH, 800], [QUIET, 400], [SPEECH, 800], [QUIET, 1500]]).out.length, 1);
  assert.equal(run([[QUIET, 1000], [SPEECH, 800], [QUIET, 1200], [SPEECH, 800], [QUIET, 1500]]).out.length, 2);
});

test('物音のような短い音は、発言にしない', () => {
  assert.equal(run([[QUIET, 1000], [SPEECH, 80], [QUIET, 1500]]).out.length, 0);
  assert.equal(run([[QUIET, 1000], [SPEECH, 200], [QUIET, 1500]]).out.length, 0);
});

test('長く話し続けたら、12秒をこえて少し静かになったところで区切る(20秒はこえない)', () => {
  const { out } = run([[QUIET, 1000], ...syllables(30000), [QUIET, 1500]]);
  assert.ok(out.length >= 3, '区切った数: ' + out.length);
  assert.ok(out.every((s) => s.ms <= 20000));
  assert.ok(out[0].ms >= 12000 && out[0].ms <= 13000, '最初の区切り: ' + out[0].ms);
});

test('静かにならないまま長すぎるときは、上限の長さで区切る', () => {
  const { out } = run([[QUIET, 1000], ...syllables(12000), [QUIET, 1500]], { softMaxMs: 999999, hardMaxMs: 5000 });
  assert.ok(out.length >= 2);
  assert.ok(out.slice(0, -1).every((s) => s.ms >= 4900 && s.ms <= 5040), out.map((s) => s.ms).join(','));
});

test('ずっと続く雑音(空調など)は、周りの音として覚え、発言にし続けない', () => {
  const { out } = run([[QUIET, 2000], [0.03, 30000]]);
  assert.ok(out.length <= 1, '区切った数: ' + out.length);
  assert.ok(out.every((s) => s.ms < 8000));
});

test('雑音が大きい場所でも、雑音に慣れたあとは、それより大きい話し声を1つの発言として聞き取る', () => {
  // 雑音が始まった直後は、話し声と区別できずに1つ区切ることがある(数秒で雑音として覚える)
  const { out } = run([[QUIET, 2000], [0.01, 8000], [SPEECH, 1000], [0.01, 2000]]);
  assert.ok(out.length <= 2, '区切った数: ' + out.length);
  assert.equal(out[out.length - 1].speechMs, 1000);
});

test('止めるときは、話している途中の分も区切って返す', () => {
  const { seg } = run([[QUIET, 1000], [SPEECH, 1600]]);
  assert.equal(seg.speaking, true);
  const last = seg.flush();
  assert.equal(last.speechMs, 1600);
  assert.equal(seg.speaking, false);
  assert.equal(seg.flush(), null);
});
