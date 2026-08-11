#!/usr/bin/env bash
#
# 環境名を検証し、対応する config/<環境>.env を読み込んでエクスポートする。
# 各スクリプトから source して使う。
#
#   source "$(dirname "$0")/lib/load-env.sh"
#   load_env "$1"
#
# 設定の出どころは2つある。既定はファイルで、手元からの実行はこちら。
# もう1つは、設定がすでに環境変数として与えられている場合で、
# `DIARY_CONFIG_SOURCE=environment` で明示する。CodeBuild での公開手続きが
# これにあたる（`config/<環境>.env` はコミットされないため、そこには存在しない）。
#
# **ファイルが無いことを合図にしない。** それだと、手元で cp を忘れただけの
# 状態が黙って通り、設定の欠けが「実行できたが中身が違う」形で現れてしまう。

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

  local config_source="${DIARY_CONFIG_SOURCE:-file}"
  if [[ "$config_source" != "file" && "$config_source" != "environment" ]]; then
    echo "error: DIARY_CONFIG_SOURCE は file または environment です: $config_source" >&2
    return 1
  fi

  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

  if [[ "$config_source" == "file" ]]; then
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
  else
    # 設定を渡した側と、実行を指示された環境が食い違っていないことを見る。
    # 渡す側（CodeBuild のプロジェクト定義）と呼ぶ側（buildspec）は別の場所に
    # あり、片方だけ書き換わりうる。**別の環境の設定で別の環境に配る**という
    # 事故は、ここでしか止められない。
    if [[ -n "${DIARY_ENV:-}" && "$DIARY_ENV" != "$env_name" ]]; then
      echo "error: 渡された設定は $DIARY_ENV のものですが、$env_name が指定されました。" >&2
      return 1
    fi
  fi

  export DIARY_CONFIG_SOURCE="$config_source"
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
    # 直し方は設定の出どころによって変わる。ファイルなら人が転記する場所を、
    # 環境変数なら渡している側を案内する。
    if [[ "${DIARY_CONFIG_SOURCE:-file}" == "environment" ]]; then
      echo "error: 次の変数が渡されていません: ${missing[*]}" >&2
      echo "       CodeBuild プロジェクトの環境変数（terraform/modules/publish）を確認してください。" >&2
    else
      echo "error: 次の変数が config/$DIARY_ENV.env に設定されていません: ${missing[*]}" >&2
      echo "       terraform output の値を転記してください。" >&2
    fi
    return 1
  fi
}
