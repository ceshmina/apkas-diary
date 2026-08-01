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

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment    = local.environment
  aws_account_id = var.aws_account_id

  # ドメイン名は DNS を引けば分かる公開情報であり、隠す必要がない。
  # environment と同じくこの環境を定義づける値なので、ここに直接書く。
  #
  # 環境を表す dev はサービス名の内側に置く。こうすると staging のレコードは
  # 委譲済みの dev.apkas.net ゾーン（staging アカウント）に収まり、
  # production のホストゾーンにいっさい触れずに済む。
  domain_name      = "diary.dev.apkas.net"
  hosted_zone_name = "dev.apkas.net"
}
