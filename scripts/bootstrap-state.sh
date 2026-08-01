#!/usr/bin/env bash
#
# Terraform state 用の S3 バケットを作成する。
#
# state の保存先そのものは Terraform では作れない（自己参照になる）ため、
# 環境ごとに1度だけ手で実行する。冪等なので再実行しても安全。
#
# usage: scripts/bootstrap-state.sh <aws-profile> [region]

set -euo pipefail

PROFILE="${1:-}"
REGION="${2:-ap-northeast-1}"

if [[ -z "$PROFILE" ]]; then
  echo "usage: $0 <aws-profile> [region]" >&2
  echo "  例: $0 apkas-diary-staging" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "error: aws CLI が見つかりません" >&2
  exit 1
fi

echo "profile '$PROFILE' の認証情報を確認しています..."
if ! CALLER="$(aws sts get-caller-identity --profile "$PROFILE" --output json 2>&1)"; then
  echo "error: profile '$PROFILE' で認証できませんでした" >&2
  echo "$CALLER" >&2
  exit 1
fi

ACCOUNT_ID="$(echo "$CALLER" | grep -o '"Account": *"[0-9]*"' | grep -o '[0-9]\{12\}')"
ARN="$(echo "$CALLER" | grep -o '"Arn": *"[^"]*"' | sed 's/.*: *"//; s/"$//')"
BUCKET="apkas-diary-tfstate-${ACCOUNT_ID}"

# 環境の取り違えは日記データの喪失に直結するため、作成前に対象を明示して確認する。
cat <<EOF

  profile     : $PROFILE
  account     : $ACCOUNT_ID
  identity    : $ARN
  region      : $REGION
  bucket      : $BUCKET

EOF

read -r -p "この AWS アカウントに state バケットを作成します。よろしいですか [y/N]: " answer
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "中止しました。"
  exit 1
fi

if aws s3api head-bucket --bucket "$BUCKET" --profile "$PROFILE" >/dev/null 2>&1; then
  echo "バケット $BUCKET は既に存在します。設定のみ適用します。"
else
  echo "バケット $BUCKET を作成しています..."
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --profile "$PROFILE" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" \
      --profile "$PROFILE" >/dev/null
  fi
fi

# state の履歴を保持する。破損や誤った apply から戻せるようにするため。
echo "バージョニングを有効化しています..."
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled \
  --profile "$PROFILE"

echo "パブリックアクセスをブロックしています..."
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
  --profile "$PROFILE"

echo "デフォルト暗号化を設定しています..."
aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' \
  --profile "$PROFILE"

cat <<EOF

完了しました。

backend.hcl に以下を記述してください。
（<env> は staging または production に読み替える）

  bucket       = "$BUCKET"
  key          = "<env>/terraform.tfstate"
  region       = "$REGION"
  profile      = "$PROFILE"
  encrypt      = true
  use_lockfile = true

EOF
