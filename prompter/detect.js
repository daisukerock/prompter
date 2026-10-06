// AIを使わない簡易判定と、文字起こしの強調表示。
// 辞書は持たない。AIが未設定・オフのときに、英字の略語と、気をつけたい言葉だけを拾う。

const ASCII_WORD = /[A-Za-z0-9]/;
const IGNORE_ACRONYMS = new Set([
  'OK', 'NG', 'PC', 'TV', 'ID', 'PM', 'AM', 'US', 'UK', 'EU', 'JP', 'NO', 'USB', 'GPS', 'CD', 'DVD',
  'SNS', 'ATM', 'URL', 'PDF', 'WEB', 'MAC', 'LINE', 'TEL', 'FAX', 'CM', 'VS', 'ABC', 'THE', 'AND',
]);

export const RISK_RULES = [
  {
    id: 'legal', level: 'red', label: '契約・法務',
    re: /(契約|解約|違約金|損害賠償|訴訟|法的|著作権|ライセンス|秘密保持|個人情報|機密|独占|免責)/g,
    tip: 'その場で同意せず、持ち帰って確認する。',
  },
  {
    id: 'commit', level: 'red', label: '断定・約束',
    re: /(必ず|絶対|間違いなく|100%|100％|保証|お約束|確約|責任を持って)/g,
    tip: '後で守れるか確認する。言質になりやすい。',
  },
  {
    id: 'money', level: 'yellow', label: '金額・数値',
    re: /([0-9０-９][0-9０-９,，.]*\s*(?:円|万円|億円|兆円|ドル|%|％|パーセント|割))/g,
    tip: '数値は出典を確認する。その場で断定しない。',
  },
  {
    id: 'deadline', level: 'yellow', label: '期限・日程',
    re: /(\d{1,2}月\d{1,2}日|\d{1,2}日(?:まで|以内)|来週|今週中|今月中|来月末|月末|年度末|期限|締切|締め切り|納期|至急|明日まで|本日中)/g,
    tip: 'いつまでに、誰がやるのかを確認する。',
  },
  {
    id: 'request', level: 'yellow', label: '依頼・宿題',
    re: /(お願いします|お願いできますか|お願いしたい|対応してください|やっていただけ|ご対応|ご確認ください|ご共有ください)/g,
    tip: '自分への依頼か、期限はいつかを確認する。',
  },
  {
    id: 'concern', level: 'yellow', label: '懸念・不確実',
    re: /(未定|未確定|遅延|遅れ|懸念|リスク|問題|トラブル|クレーム|不具合|障害)/g,
    tip: '影響範囲と、対応方法を確認する。',
  },
];

function isAscii(s) {
  return /^[\x20-\x7E]+$/.test(s);
}

// 英数字だけの語は、前後が英数字でないものだけを一致とみなす(大文字・小文字は区別しない)
export function indexOfWord(text, key, from) {
  const ascii = isAscii(key);
  const hay = ascii ? text.toLowerCase() : text;
  const needle = ascii ? key.toLowerCase() : key;
  let i = hay.indexOf(needle, from || 0);
  while (i !== -1) {
    if (!ascii) return i;
    const before = i > 0 ? text[i - 1] : '';
    const after = i + key.length < text.length ? text[i + key.length] : '';
    if (!(before && ASCII_WORD.test(before)) && !(after && ASCII_WORD.test(after))) return i;
    i = hay.indexOf(needle, i + 1);
  }
  return -1;
}

export function sentenceAround(text, index) {
  const seps = /[。！？!?\n]/;
  let s = index;
  while (s > 0 && !seps.test(text[s - 1])) s--;
  let e = index;
  while (e < text.length && !seps.test(text[e])) e++;
  return text.slice(s, e).trim();
}

// 英字の略語(2〜6文字の大文字)を、意味の分からない語の候補として拾う
export function findCandidates(text) {
  const found = [];
  // 英数字の連なりを取り出し、大文字だけの2〜6文字のものを残す(後読みは古いSafariで使えないため使わない)
  const re = /[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(text))) {
    const w = m[0];
    if (!/^[A-Z]{2,6}$/.test(w)) continue;
    if (IGNORE_ACRONYMS.has(w) || found.some((f) => f.term === w)) continue;
    found.push({ term: w, index: m.index, quote: sentenceAround(text, m.index) });
  }
  return found;
}

// 気をつけたい言葉を拾う。同じ規則は、1文につき1件にまとめる
export function findRisks(text) {
  const risks = [];
  const sentences = (text.match(/[^。！？!?\n]+[。！？!?\n]?/g) || []).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    for (const rule of RISK_RULES) {
      rule.re.lastIndex = 0;
      const hits = sentence.match(rule.re);
      if (hits) {
        risks.push({
          ruleId: rule.id, level: rule.level, label: rule.label,
          tip: rule.tip, matched: [...new Set(hits)].slice(0, 3), quote: sentence,
        });
      }
    }
  }
  return risks;
}

// 文の中で、指定した語を強調するための区切りを作る
export function markSegments(text, terms) {
  const ranges = [];
  const keys = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    let from = 0;
    for (;;) {
      const i = indexOfWord(text, key, from);
      if (i === -1) break;
      from = i + key.length;
      if (!ranges.some(([a, b]) => i < b && i + key.length > a)) ranges.push([i, i + key.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const segs = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) segs.push({ text: text.slice(pos, a) });
    segs.push({ text: text.slice(a, b), mark: true });
    pos = b;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos) });
  return segs;
}

// 複数の文の中から、その語を含む文を探す(なければ最初の文)
export function lineContaining(lines, term) {
  for (const line of lines) {
    const i = indexOfWord(line, term, 0);
    if (i !== -1) return sentenceAround(line, i);
  }
  return lines[0] || '';
}
