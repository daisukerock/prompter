# プロンプター

会話を聞きながら、知らない用語・略語の意味と、気をつけたい点を、その場でカード表示するWebアプリです。
辞書は持たず、使う人が自分で選んだAI(自分のAPIキー)で動きます。対応しているのは、Claude・ChatGPT・Gemini・OpenAI互換のAIです。

- 公開ページ: https://daisukerock.github.io/prompter/
- 使い方と仕組み: [prompter/README.md](prompter/README.md)

## 構成

| 場所 | 中身 |
|---|---|
| `prompter/` | アプリ本体(HTML/CSS/JavaScript、ビルド不要)。GitHub Pagesでは、このフォルダだけを公開 |
| `tests/prompter/` | 単体テスト(`node --test tests/prompter/*.test.mjs`) |
| `tools/build-anthropic-sdk.sh` | 同梱のClaude公式SDKを作り直すスクリプト |
| `.github/workflows/pages.yml` | `main` への push で、`prompter/` をGitHub Pagesに公開 |
