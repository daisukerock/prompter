// 公開するファイルに版(コミット)を付ける。
// 読み込み先のURLに ?v=版 を付けて、更新の直後に古いファイルと新しいファイルが混ざらないようにする
// (GitHub Pagesは、ファイルを最大10分ほど端末に残すため)。
// 使い方: node tools/stamp-version.mjs <元のフォルダ> <出力先> <版>
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// './x.js' や '../x.js' を読み込む書き方(import … from / export … from / import(…) / import '…')
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?#]+?\.js)\2/g;

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(path));
    else out.push(path);
  }
  return out;
}

// text の中の find を、ちょうど1か所だけ置き換える(見つからない・複数あるときは止める)
function replaceOnce(text, find, replacement, where) {
  const count = text.split(find).length - 1;
  if (count !== 1) throw new Error(where + ': 「' + find + '」が' + count + 'か所あります(1か所のはず)');
  return text.replace(find, () => replacement);
}

export async function stamp(src, out, version) {
  if (!/^[0-9A-Za-z._-]{1,40}$/.test(version)) throw new Error('版の書き方が正しくありません: ' + version);
  const v = '?v=' + version;
  await rm(out, { recursive: true, force: true });
  await cp(src, out, { recursive: true });

  let rewritten = 0;
  for (const file of await listFiles(out)) {
    const rel = relative(out, file);
    // 同梱のSDKは1つにまとめたファイルなので、中は書き換えない
    if (!rel.endsWith('.js') || rel.split(sep)[0] === 'vendor') continue;
    const text = await readFile(file, 'utf8');
    let next = text.replace(IMPORT_RE, (m, head, q, spec) => {
      rewritten++;
      return head + q + spec + v + q;
    });
    if (rel === 'app.js') next = replaceOnce(next, "const BUILD = 'dev';", "const BUILD = '" + version + "';", rel);
    if (next !== text) await writeFile(file, next);
  }
  if (!rewritten) throw new Error('読み込み先が見つかりませんでした');

  const htmlPath = join(out, 'index.html');
  let html = await readFile(htmlPath, 'utf8');
  html = replaceOnce(html, '<meta name="app-version" content="dev">', '<meta name="app-version" content="' + version + '">', 'index.html');
  for (const name of ['boot.js', 'app.js']) html = replaceOnce(html, 'src="' + name + '"', 'src="' + name + v + '"', 'index.html');
  html = replaceOnce(html, 'href="style.css"', 'href="style.css' + v + '"', 'index.html');
  await writeFile(htmlPath, html);
  return { rewritten };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [src, out, version] = process.argv.slice(2);
  if (!src || !out || !version) {
    console.error('使い方: node tools/stamp-version.mjs <元のフォルダ> <出力先> <版>');
    process.exit(2);
  }
  const { rewritten } = await stamp(src, out, version);
  console.log('版 ' + version + ' を付けました(読み込み先 ' + rewritten + 'か所)→ ' + out);
}
