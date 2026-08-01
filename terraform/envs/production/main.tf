locals {
  environment = "production"
}

module "storage" {
  source = "../../modules/storage"

  environment = local.environment

  # 本番の日記データは再取得が不可能なため、削除保護を有効にする。
  # 有効なあいだは terraform destroy でもテーブルを削除できない。
  deletion_protection = true
}

module "delivery" {
  source = "../../modules/delivery"

  environment    = local.environment
  aws_account_id = var.aws_account_id
}
