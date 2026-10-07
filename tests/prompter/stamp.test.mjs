import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stamp } from '../../tools/stamp-version.mjs';

const HTML = '<meta name="app-version" content="dev">\n<link rel="stylesheet" href="style.css">\n<script src="boot.js"></script>\n<script type="module" src="app.js"></script>\n';

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'stamp-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, 'src', name, '..'), { recursive: true });
    await writeFile(join(dir, 'src', name), text);
  }
  return dir;
}

test('読み込み先・版・画面のリンクに、版を付ける(同梱SDKの中は変えない)', async () => {
  const dir = await fixture({
    'index.html': HTML,
    'app.js': "import * as A from './ai/index.js';\nimport { x } from \"./ai/common.js\";\nconst BUILD = 'dev';\n",
    'ai/index.js': "import { y } from './common.js';\nexport * from './common.js';\nconst load = () => import( './claude.js' );\nimport './side.js';\nimport k from 'https://example.com/k.js';\n",
    'ai/claude.js': "const sdk = import('../vendor/sdk.js');\n",
    'vendor/sdk.js': "export const s = 'from \"./inside.js\"';\n",
  });
  try {
    const { rewritten } = await stamp(join(dir, 'src'), join(dir, 'out'), 'abc123');
    assert.equal(rewritten, 7);
    const read = (name) => readFile(join(dir, 'out', name), 'utf8');
    assert.equal(await read('app.js'), "import * as A from './ai/index.js?v=abc123';\nimport { x } from \"./ai/common.js?v=abc123\";\nconst BUILD = 'abc123';\n");
    const index = await read('ai/index.js');
    assert.match(index, /from '\.\/common\.js\?v=abc123';\nexport \* from '\.\/common\.js\?v=abc123';/);
    assert.match(index, /import\( '\.\/claude\.js\?v=abc123' \)/);
    assert.match(index, /import '\.\/side\.js\?v=abc123';/);
    assert.match(index, /from 'https:\/\/example\.com\/k\.js';/, '外のURLは変えない');
    assert.equal(await read('ai/claude.js'), "const sdk = import('../vendor/sdk.js?v=abc123');\n");
    assert.equal(await read('vendor/sdk.js'), "export const s = 'from \"./inside.js\"';\n");
    assert.equal(await read('index.html'), HTML
      .replace('content="dev"', 'content="abc123"')
      .replace('style.css', 'style.css?v=abc123')
      .replace('boot.js', 'boot.js?v=abc123')
      .replace('src="app.js"', 'src="app.js?v=abc123"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('置き換える場所が見つからなければ、公開を止める', async () => {
  for (const [files, message] of [
    [{ 'index.html': HTML, 'app.js': "import a from './a.js';\n" }, /BUILD/],
    [{ 'index.html': HTML.replace('<meta name="app-version" content="dev">\n', ''), 'app.js': "import a from './a.js';\nconst BUILD = 'dev';\n" }, /app-version/],
    [{ 'index.html': HTML, 'app.js': "const BUILD = 'dev';\n" }, /読み込み先/],
  ]) {
    const dir = await fixture(files);
    try {
      await assert.rejects(stamp(join(dir, 'src'), join(dir, 'out'), 'v1'), message);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  await assert.rejects(stamp('.', '/tmp/never', 'bad version!'), /版の書き方/);
});
