#!/usr/bin/env bash
#
# 日記エントリを登録・更新する。
#
#   npm run entry -- staging --date 2026-08-01 --file today.md --title "散歩"
#   npm run entry -- staging --date 2026-08-01 --status published

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then
  echo "使い方: npm run entry -- <staging|production> --date <YYYY-MM-DD> [options]" >&2
  exit 1
fi
shift

load_env "$ENV_NAME"
require_env_vars DIARY_TABLE_NAME

exec npx tsx src/cli/put-entry.ts "$@"
