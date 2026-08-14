#!/usr/bin/env bash
#
# 旧ホストに残った写真を新しい側へ移す。移行のための一時的なコマンド。
#
#   npm run migrate-photos -- staging plan
#   npm run migrate-photos -- production rewrite --dry-run

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then
  echo "使い方: npm run migrate-photos -- <staging|production> <工程> [options]" >&2
  exit 1
fi
shift

load_env "$ENV_NAME"
require_env_vars DIARY_TABLE_NAME PHOTO_UPLOAD_BUCKET PHOTO_BUCKET PHOTO_URL

exec npx tsx src/cli/migrate-photos.ts "$@"
