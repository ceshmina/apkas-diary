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

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment    = local.environment
  aws_account_id = var.aws_account_id

  # ドメイン名は DNS を引けば分かる公開情報であり、隠す必要がない。
  # environment と同じくこの環境を定義づける値なので、ここに直接書く。
  #
  # apkas.net のゾーンにはメールの MX など他の用途のレコードが同居する。
  # モジュールはゾーンを data で参照し、日記サイトのレコードだけを作る。
  domain_name      = "diary.apkas.net"
  hosted_zone_name = "apkas.net"
}

# 写真の配信。日記サイトとはバケットもディストリビューションも分けてある。
# サイトのデプロイは `aws s3 sync --delete` で配信元を丸ごと同期するため、
# 同じバケットに写真を置くと1度のデプロイで全部消える。
module "photos" {
  source = "../../modules/photos"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment    = local.environment
  aws_account_id = var.aws_account_id

  domain_name      = "photos.apkas.net"
  hosted_zone_name = "apkas.net"
}

# 編集アプリケーション。ブラウザから日記を書くための入口。
#
# 公開サイトや写真と違い、配信するのは静的なオブジェクトではなく動的な応答で
# あり、POST を受ける。前段は CloudFront ではなく API Gateway の HTTP API に
# なっており、us-east-1 のプロバイダを受け取らない（design.md 決定2）。
#
# 書き込む先は storage と同じテーブル。CLI と同じエントリを読み書きする。
module "editor" {
  source = "../../modules/editor"

  environment = local.environment

  domain_name      = "admin.apkas.net"
  hosted_zone_name = "apkas.net"

  table_name = module.storage.table_name
  table_arn  = module.storage.table_arn
}
