#!/usr/bin/env bash
# Claude公式SDK(@anthropic-ai/sdk)を、ブラウザでそのまま読み込める1ファイルにまとめる。
# 出力: prompter/vendor/anthropic-sdk.js
# 使い方: bash tools/build-anthropic-sdk.sh [SDKのバージョン]
set -euo pipefail

VERSION="${1:-0.131.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm install --silent "@anthropic-ai/sdk@${VERSION}" esbuild@0.25 >/dev/null

cat > entry.mjs <<'JS'
export { default as Anthropic } from '@anthropic-ai/sdk';
export { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema';
JS

npx esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2020 --minify \
  --legal-comments=inline \
  --banner:js="// @anthropic-ai/sdk ${VERSION} (MIT License, Copyright Anthropic). Built by tools/build-anthropic-sdk.sh" \
  --outfile="$ROOT/prompter/vendor/anthropic-sdk.js"

cp node_modules/@anthropic-ai/sdk/LICENSE "$ROOT/prompter/vendor/anthropic-sdk.LICENSE.txt"

echo "built prompter/vendor/anthropic-sdk.js (@anthropic-ai/sdk ${VERSION})"
