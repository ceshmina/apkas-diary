provider "aws" {
  region = var.aws_region

  # 空のときは AWS_PROFILE などの既定の解決順に委ねる。
  profile = var.aws_profile != "" ? var.aws_profile : null

  # 環境の取り違えを防ぐ最後の砦。
  # 与えられた認証情報がこのアカウントを指していない場合、
  # Terraform はリソースを1つも変更せずに失敗する。
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "apkas-diary"
      Environment = local.environment
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront が参照できる証明書は us-east-1 のものに限られるため、
# 証明書のためだけにこのプロバイダを持つ。
#
# allowed_account_ids を省くと、環境の取り違えに対する守りが証明書だけ
# 抜けることになる。既定のプロバイダと同じ設定を明示的に繰り返す。
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  profile             = var.aws_profile != "" ? var.aws_profile : null
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "apkas-diary"
      Environment = local.environment
      ManagedBy   = "terraform"
    }
  }
}
