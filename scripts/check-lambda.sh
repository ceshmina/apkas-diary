#!/usr/bin/env bash
#
# Lambda の TypeScript を型検査する。
#
# ルートの tsconfig は Astro のものを継いでおり、lambda/ は対象から外してある。
# sharp の型を引くのに lambda/photo-resize/node_modules が要り、それをルートの
# 型検査の前提にしたくないためである。npm run check から1本で通せるように、
# 呼び分けだけをここに置く。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

LAMBDA_DIR="lambda/photo-resize"

if [[ ! -d "$LAMBDA_DIR/node_modules" ]]; then
  echo "error: $LAMBDA_DIR の依存が入っていません。" >&2
  echo "       npm --prefix $LAMBDA_DIR install を実行してください。" >&2
  exit 1
fi

npm --prefix "$LAMBDA_DIR" run check
