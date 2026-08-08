#!/usr/bin/env bash
#
# Lambda の配布物を作る。
#
#   scripts/build-lambda.sh
#
# 出力は lambda/photo-resize/build/。lambroll deploy --src がこれを固める。
# 通常は scripts/deploy-lambda.sh から呼ばれる。
#
# sharp は native binary を持つ。手元は macOS、動かす先は Lambda の linux/arm64
# なので、実行時の依存はプラットフォームを明示して入れ直す。手元用のものが
# 混ざったまま上げると、関数は読み込みの時点で落ちる。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

LAMBDA_DIR="lambda/photo-resize"
BUILD_DIR="$LAMBDA_DIR/build"

if [[ ! -d "$LAMBDA_DIR/node_modules" ]]; then
  echo "error: $LAMBDA_DIR の依存が入っていません。" >&2
  echo "       npm --prefix $LAMBDA_DIR install を実行してください。" >&2
  exit 1
fi

# 前回の残りを持ち越さない。配布物に古いファイルが紛れると、直したはずの挙動が
# 戻ったように見える。
rm -rf "$BUILD_DIR"

echo "TypeScript をコンパイルしています..."
npm --prefix "$LAMBDA_DIR" run build

# tsc が出すのは build/index.js だけ。実行に要るものをここで揃える。
# バージョンは lambda/photo-resize/package.json を唯一の出どころにする。
DEPS="$(node -p "
  const deps = require('./$LAMBDA_DIR/package.json').dependencies
  Object.entries(deps).map(([name, range]) => name + '@' + range).join(' ')
")"

# ESM として読ませるために type: module が要る。ここは生成物なのでコミットしない。
cat > "$BUILD_DIR/package.json" <<'EOF'
{
  "name": "apkas-diary-photo-resize-bundle",
  "private": true,
  "type": "module"
}
EOF

echo "実行時の依存を linux/arm64 向けに入れています..."
# shellcheck disable=SC2086
npm install \
  --prefix "$BUILD_DIR" \
  --os=linux --cpu=arm64 --libc=glibc \
  --omit=dev --no-audit --no-fund --silent \
  $DEPS

SIZE_KB="$(du -sk "$BUILD_DIR" | cut -f1)"
printf '配布物: %s (%s MB)\n' "$BUILD_DIR" "$(awk -v k="$SIZE_KB" 'BEGIN { printf "%.1f", k / 1024 }')"
