#!/usr/bin/env bash
#
# 指定した環境のデータからサイトを生成する。
#
# DynamoDB から公開済みエントリを取得して dist/ を作り、その副産物として
# 下書きを含む全エントリを export/ に Markdown で書き出す。
# 書き出しに失敗した場合はビルド全体が異常終了する。
#
#   npm run build -- staging

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

load_env "${1:-}"
require_env_vars DIARY_TABLE_NAME

echo "環境: $DIARY_ENV"
echo "テーブル: $DIARY_TABLE_NAME"
echo "書き出し先: $DIARY_EXPORT_DIR"
echo

exec npx astro build
