#!/usr/bin/env bash
#
# 写真変換 Lambda のコードと実行時設定をデプロイする。
#
#   npm run deploy:lambda -- staging
#
# インフラには触らない。関数の存在と S3 からの配線は Terraform が持っており、
# ここが差し替えるのはコードとメモリ・タイムアウト・環境変数だけである。
# コードだけを直したときに terraform apply は要らない。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then
  echo "使い方: npm run deploy:lambda -- <staging|production>" >&2
  exit 1
fi
shift

load_env "$ENV_NAME"
require_env_vars AWS_PROFILE

if ! command -v lambroll >/dev/null 2>&1; then
  echo "error: lambroll が見つかりません" >&2
  echo "       brew install fujiwara/tap/lambroll などで導入してください。" >&2
  exit 1
fi

# 関数の定義が読む値は Terraform の state にある。state の場所は backend.hcl が
# 唯一の出どころで、ここから組み立てる。config/<環境>.env に転記を増やさない。
BACKEND="terraform/envs/$ENV_NAME/backend.hcl"
if [[ ! -f "$BACKEND" ]]; then
  echo "error: $BACKEND がありません。" >&2
  echo "       cp $BACKEND.example $BACKEND して実値を埋めてください。" >&2
  exit 1
fi

backend_value() {
  awk -F'=' -v key="$1" '
    { name = $1; gsub(/[[:space:]]/, "", name) }
    name == key {
      value = $2
      gsub(/^[[:space:]]*"|"[[:space:]]*$/, "", value)
      print value
      exit
    }
  ' "$BACKEND"
}

STATE_BUCKET="$(backend_value bucket)"
STATE_KEY="$(backend_value key)"
if [[ -z "$STATE_BUCKET" || -z "$STATE_KEY" ]]; then
  echo "error: $BACKEND から bucket / key を読めませんでした。" >&2
  exit 1
fi
TFSTATE="s3://${STATE_BUCKET}/${STATE_KEY}"

# 適用先を取り違えると、別の環境の写真がこのコードで作られることになる。
# 実行前に対象を表示する。
ACCOUNT_ID="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)"

cat <<EOF
  環境      : $DIARY_ENV
  profile   : $AWS_PROFILE
  account   : $ACCOUNT_ID
  tfstate   : $TFSTATE

EOF

if [[ "$DIARY_ENV" == "production" ]]; then
  read -r -p "production の関数を差し替えます。よろしいですか [y/N]: " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "中止しました。"
    exit 1
  fi
fi

scripts/build-lambda.sh

echo "デプロイしています..."
exec lambroll deploy \
  --function lambda/photo-resize/function.jsonnet \
  --src lambda/photo-resize/build \
  --tfstate "$TFSTATE" \
  "$@"
