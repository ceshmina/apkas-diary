#!/usr/bin/env bash
#
# 環境名を検証し、対応する .env.<環境> を読み込んでエクスポートする。
# 各スクリプトから source して使う。
#
#   source "$(dirname "$0")/lib/load-env.sh"
#   load_env "$1"

load_env() {
  local env_name="${1:-}"

  if [[ -z "$env_name" ]]; then
    echo "error: 環境名を指定してください（staging または production）" >&2
    return 1
  fi

  # 対象環境は常に明示させる。既定値を持たせると取り違えの余地が生まれる。
  if [[ "$env_name" != "staging" && "$env_name" != "production" ]]; then
    echo "error: 環境名は staging または production です: $env_name" >&2
    return 1
  fi

  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

  # 設定ファイルを `config/` に置き `.env.<環境>` という名前にしないのは、
  # Vite が envDir（＝プロジェクトルート）の `.env` / `.env.<mode>` を
  # 自動で読み込むため。`astro build` のモードは環境によらず production なので、
  # ルートに `.env.production` があると staging のビルドにも読み込まれてしまう。
  local env_file="$repo_root/config/$env_name.env"
  if [[ ! -f "$env_file" ]]; then
    echo "error: $env_file がありません。" >&2
    echo "       cp config/$env_name.env.example config/$env_name.env して実値を埋めてください。" >&2
    return 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a

  export DIARY_ENV="$env_name"
  export DIARY_EXPORT_DIR="${DIARY_EXPORT_DIR:-$repo_root/export/$env_name}"
}

require_env_vars() {
  local missing=()
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "error: 次の変数が .env.$DIARY_ENV に設定されていません: ${missing[*]}" >&2
    echo "       terraform output の値を転記してください。" >&2
    return 1
  fi
}
