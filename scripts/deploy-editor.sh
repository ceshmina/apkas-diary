#!/usr/bin/env bash
#
# 編集アプリケーションのコードと実行時設定をデプロイする。
#
#   npm run deploy:editor -- staging
#
# インフラには触らない。関数の存在・ロール・API Gateway からの配線は Terraform が
# 持っており、ここが差し替えるのはコードとメモリ・タイムアウト・レイヤー・環境変数
# だけである。画面を直しただけのときに terraform apply は要らない。
#
# デプロイの直後に `terraform plan` が差分を出さないことを確認すること。関数の
# 実行時設定は Terraform 側で ignore_changes にしてあり、その一覧に漏れがあると
# 次の terraform apply が lambroll の設定を黙って既定値へ戻す。気づく手段は
# その plan だけである。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

ENV_NAME="${1:-}"
if [[ -z "$ENV_NAME" ]]; then
  echo "使い方: npm run deploy:editor -- <staging|production>" >&2
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

# 適用先を取り違えると、別の環境の日記を編集する画面がこのコードで動くことになる。
# 実行前に対象を表示する。
ACCOUNT_ID="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)"

cat <<EOF
  環境      : $DIARY_ENV
  profile   : $AWS_PROFILE
  account   : $ACCOUNT_ID
  tfstate   : $TFSTATE

EOF

if [[ "$DIARY_ENV" == "production" ]]; then
  read -r -p "production の編集アプリケーションを差し替えます。よろしいですか [y/N]: " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "中止しました。"
    exit 1
  fi
fi

scripts/build-editor.sh

echo "デプロイしています..."
exec lambroll deploy \
  --function editor/function.jsonnet \
  --src editor/build \
  --tfstate "$TFSTATE" \
  "$@"
