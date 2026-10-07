# プロンプター

会話を聞きながら、知らない用語・略語の意味と、気をつけたい点を、その場でカード表示するWebアプリです。
辞書は持たず、使う人が自分で選んだAI(自分のAPIキー)で動きます。対応しているのは、Claude・ChatGPT・Gemini・OpenAI互換のAIです。
TypeSafeのJevで、送る価値がありそうな発言だけをAIに送るように振り分けることもできます(AIの呼び出しを減らす)。

- 公開ページ: https://daisukerock.github.io/prompter/
- 使い方と仕組み: [prompter/README.md](prompter/README.md)

## 構成

| 場所 | 中身 |
|---|---|
| `prompter/` | アプリ本体(HTML/CSS/JavaScript、ビルド不要)。GitHub Pagesでは、このフォルダだけを公開 |
| `tests/prompter/` | 単体テスト(`npm test`) |
| `tests/e2e/` | 通しテスト(ブラウザで画面を動かし、AIの応答は模擬する。`npx playwright test`) |
| `package.json`・`playwright.config.js` | テストの道具の設定(アプリ本体には不要) |
| `tools/build-anthropic-sdk.sh` | 同梱のClaude公式SDKを作り直すスクリプト |
| `tools/stamp-version.mjs` | 公開するファイルの読み込み先に版を付ける(`npm run build` で `_site/` に作る) |
| `.github/workflows/test.yml` | PRごとに、単体テストと通しテストを実行 |
| `.github/workflows/pages.yml` | `main` への push で、テストが通ったときだけ、版を付けた `prompter/` をGitHub Pagesに公開 |
