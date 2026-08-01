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
