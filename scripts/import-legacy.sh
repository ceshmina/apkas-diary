#!/usr/bin/env bash
#
# 旧サイト（eskarun）の記事を DynamoDB に取り込む。移行のための一時的なコマンド。
#
#   npm run import-legacy -- staging --source ../../apkas/eskarun/_articles --dry-run

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then
  echo "使い方: npm run import-legacy -- <staging|production> --source <旧記事のディレクトリ> [options]" >&2
  exit 1
fi
shift

load_env "$ENV_NAME"
require_env_vars DIARY_TABLE_NAME

exec npx tsx src/cli/import-legacy.ts "$@"
