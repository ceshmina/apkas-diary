terraform {
  # S3 backend のネイティブロック（use_lockfile）を使うため 1.10 以降を要求する。
  # 従来必要だったロック用の DynamoDB テーブルは作らない。
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # 実値は backend.hcl に置き、コミットしない。
  #   terraform init -backend-config=backend.hcl
  backend "s3" {}
}
