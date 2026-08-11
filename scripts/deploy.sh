#!/usr/bin/env bash
#
# 生成済みのサイトを S3 に同期し、CloudFront のキャッシュを無効化する。
#
#   npm run deploy -- staging
#
# --delete により、前回のデプロイに存在して今回なくなったページは配信されなくなる。
#
# 手元からも、クラウド側の公開手続き（CodeBuild）からも、**このスクリプトが
# 実行される**。手順の宣言元を1つに保つためで、両者の違いは資格情報の出どころ
# （named profile か実行ロールか）と、production の確認の取り方だけである。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh

load_env "${1:-}"
require_env_vars SITE_BUCKET CLOUDFRONT_DISTRIBUTION_ID

# profile を要求するのは手元からの実行だけ。設定を環境変数で受け取っている
# ときは実行ロールの資格情報を使うため、profile は存在しないのが正しい。
if [[ "$DIARY_CONFIG_SOURCE" == "file" ]]; then
  require_env_vars AWS_PROFILE
fi

# aws CLI には --profile を渡さない。load_env が AWS_PROFILE を export して
# おり、CLI はそれを自分で読む。渡さないことで、実行ロールで動く経路が
# 同じコマンドのまま成立する。
if ! command -v aws >/dev/null 2>&1; then
  echo "error: aws CLI が見つかりません" >&2
  exit 1
fi

if [[ ! -d dist ]]; then
  echo "error: dist/ がありません。先に npm run build -- $DIARY_ENV を実行してください。" >&2
  exit 1
fi

# 適用先を取り違えると公開内容が入れ替わるため、実行前に対象を表示する。
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

cat <<EOF
  環境         : $DIARY_ENV
  profile      : ${AWS_PROFILE:-（実行ロール）}
  account      : $ACCOUNT_ID
  bucket       : $SITE_BUCKET
  distribution : $CLOUDFRONT_DISTRIBUTION_ID

EOF

# production への反映は、どの経路からでも人の意思を要求する。
#
# 端末があるときは対話で訊く。無いとき（CodeBuild など）は、起動した側が
# DIARY_DEPLOY_CONFIRMED を渡していることをもって確認とみなす。**どちらも
# 満たさなければ中止する。** 既定で通る経路を作らない。
#
# なおこれは多層防御であって権限境界ではない。StartBuild の権限を持つ主体は
# この変数も渡せる。境界として効いているのは、その権限を持つのが編集
# アプリケーションと管理者だけであることのほう。
if [[ "$DIARY_ENV" == "production" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "production に反映します。よろしいですか [y/N]: " answer
    if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
      echo "中止しました。"
      exit 1
    fi
  elif [[ "${DIARY_DEPLOY_CONFIRMED:-}" != "yes" ]]; then
    echo "error: production への反映には確認が要ります。" >&2
    echo "       端末から実行するか、DIARY_DEPLOY_CONFIRMED=yes を渡してください。" >&2
    exit 1
  fi
fi

echo "S3 に同期しています..."
aws s3 sync dist/ "s3://${SITE_BUCKET}/" \
  --delete

echo "CloudFront のキャッシュを無効化しています..."
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths '/*' \
  --query 'Invalidation.Id' \
  --output text)"

echo "invalidation: $INVALIDATION_ID"
echo
echo "完了しました。${SITE_URL:-（SITE_URL 未設定）}"
