import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_RATE, concat, downsample, encodeWav, levelDb, silenceWav } from '../../prompter/audio.js';

test('音の大きさ(dBFS): 無音はとても小さい値、半分の振幅は約-6dB', () => {
  assert.equal(levelDb(new Float32Array(100)), -120);
  assert.ok(Math.abs(levelDb(new Float32Array(100).fill(0.5)) - -6.02) < 0.01);
  assert.equal(levelDb(new Float32Array(0)), -120);
});

test('分かれて届いた音を、順に1つにつなぐ', () => {
  const out = concat([Float32Array.of(1, 2), Float32Array.of(3), new Float32Array(0), Float32Array.of(4, 5)]);
  assert.deepEqual([...out], [1, 2, 3, 4, 5]);
});

test('48kHzから16kHzへ: 3つずつの平均にする。44.1kHzからも長さを合わせる', () => {
  const input = Float32Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual([...downsample(input, 48000)], [1, 4, 7, 10]);
  const cd = downsample(new Float32Array(44100).fill(0.25), 44100);
  assert.equal(cd.length, 16000);
  assert.ok(cd.every((v) => Math.abs(v - 0.25) < 1e-6));
  assert.deepEqual([...downsample(Float32Array.of(0.1, 0.2), 16000)], [Float32Array.of(0.1)[0], Float32Array.of(0.2)[0]]);
  assert.throws(() => downsample(new Float32Array(10), 8000), /低すぎ/);
});

test('16kHz・16bit・1チャンネルのWAVにする(見出しの値と、はみ出した音の切りつめ)', () => {
  const wav = encodeWav(Float32Array.of(0, 0.5, -0.5, 2, -2));
  const view = new DataView(wav.buffer);
  const text = (at, n) => String.fromCharCode(...wav.slice(at, at + n));
  assert.equal(wav.length, 44 + 10);
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + 10);
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, '1チャンネル');
  assert.equal(view.getUint32(24, true), TARGET_RATE);
  assert.equal(view.getUint32(28, true), TARGET_RATE * 2);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true)), [0, 16383, -16384, 32767, -32768]);
});

test('接続テスト用の無音: 指定した秒数ぶんの長さ', () => {
  assert.equal(silenceWav(1).length, 44 + 32000);
});
