#!/usr/bin/env bash
#
# 編集アプリケーションを手元で動かす。
#
#   npm run dev:editor -- staging
#
# 認証を迂回する経路は用意していない。手元で動かしても Google のログインを通る
# （design.md 決定11）。そのため staging の OAuth クライアントに
# http://localhost:4321/auth/callback が登録されている必要がある。
#
# 読み書きの対象は指定した環境の DynamoDB テーブルであり、設定値も同じ環境の
# SSM パラメータから読む。手元用の別のデータは持たない。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then
  echo "使い方: npm run dev:editor -- <staging|production>" >&2
  exit 1
fi
shift

load_env "$ENV_NAME"
require_env_vars DIARY_TABLE_NAME

PORT="${PORT:-4321}"

# 自分の URL は Google に渡す redirect URI の組み立てに使う。手元では localhost。
export EDITOR_BASE_URL="http://localhost:${PORT}"

# パラメータの置き場所は環境名から決まる。config/<環境>.env に転記を増やさない。
export EDITOR_PARAM_PREFIX="${EDITOR_PARAM_PREFIX:-/apkas-diary/${DIARY_ENV}/editor}"

# 公開手続きのプロジェクト名も同じく環境名から決まる（terraform/modules/publish
# の local.name と同じ規則）。**手元でも本物のプロジェクトを指す。** 押せば
# 実際にビルドが走るので、staging で試すこと。
export PUBLISH_PROJECT_NAME="${PUBLISH_PROJECT_NAME:-apkas-diary-publish-${DIARY_ENV}}"

cat <<EOF
  環境        : $DIARY_ENV
  テーブル    : $DIARY_TABLE_NAME
  パラメータ  : $EDITOR_PARAM_PREFIX
  公開手続き  : $PUBLISH_PROJECT_NAME
  URL         : $EDITOR_BASE_URL

EOF

if [[ "$DIARY_ENV" == "production" ]]; then
  echo "production のデータを手元から読み書きします。" >&2
  read -r -p "よろしいですか [y/N]: " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "中止しました。"
    exit 1
  fi
fi

exec npx astro dev --config editor/astro.config.ts --port "$PORT" "$@"
