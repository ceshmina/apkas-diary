#!/usr/bin/env bash
#
# 写真を投入する。
#
#   npm run photo -- staging --file ~/photos/IMG_1234.jpg --date 2026-08-08
#
# 置くのはアップロード用バケットまで。派生画像は S3 のイベントで起動する
# Lambda が作る。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then
  echo "使い方: npm run photo -- <staging|production> --file <path> (--date <YYYY-MM-DD> | --key <key>)" >&2
  exit 1
fi
shift

load_env "$ENV_NAME"

# DIARY_TABLE_NAME は目録への記録に要る。**config/<環境>.env に既にある値なので
# 転記は増えない**（サイト生成と編集アプリケーションが読んでいるものと同じ）。
# ここで確かめるのは、欠けたまま投入して**記録の段になって初めて落ちる**のを
# 避けるためである。
require_env_vars DIARY_TABLE_NAME PHOTO_UPLOAD_BUCKET PHOTO_BUCKET PHOTO_URL

exec npx tsx src/cli/put-photo.ts "$@"
