#!/usr/bin/env bash
#
# 生成済みのサイトを S3 に同期し、CloudFront のキャッシュを無効化する。
#
#   npm run deploy -- staging
#
# --delete により、前回のデプロイに存在して今回なくなったページは配信されなくなる。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

load_env "${1:-}"
require_env_vars SITE_BUCKET CLOUDFRONT_DISTRIBUTION_ID AWS_PROFILE

if ! command -v aws >/dev/null 2>&1; then
  echo "error: aws CLI が見つかりません" >&2
  exit 1
fi

if [[ ! -d dist ]]; then
  echo "error: dist/ がありません。先に npm run build -- $DIARY_ENV を実行してください。" >&2
  exit 1
fi

# 適用先を取り違えると公開内容が入れ替わるため、実行前に対象を表示する。
ACCOUNT_ID="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)"

cat <<EOF
  環境         : $DIARY_ENV
  profile      : $AWS_PROFILE
  account      : $ACCOUNT_ID
  bucket       : $SITE_BUCKET
  distribution : $CLOUDFRONT_DISTRIBUTION_ID

EOF

if [[ "$DIARY_ENV" == "production" ]]; then
  read -r -p "production に反映します。よろしいですか [y/N]: " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "中止しました。"
    exit 1
  fi
fi

echo "S3 に同期しています..."
aws s3 sync dist/ "s3://${SITE_BUCKET}/" \
  --delete \
  --profile "$AWS_PROFILE"

echo "CloudFront のキャッシュを無効化しています..."
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths '/*' \
  --profile "$AWS_PROFILE" \
  --query 'Invalidation.Id' \
  --output text)"

echo "invalidation: $INVALIDATION_ID"
echo
echo "完了しました。${SITE_URL:-（SITE_URL 未設定）}"
