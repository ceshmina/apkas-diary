locals {
  environment = "staging"
}

module "storage" {
  source = "../../modules/storage"

  environment = local.environment

  # staging は構成の検証用であり、作り直しを許容する。
  deletion_protection = false
}

module "delivery" {
  source = "../../modules/delivery"

  environment    = local.environment
  aws_account_id = var.aws_account_id
}
