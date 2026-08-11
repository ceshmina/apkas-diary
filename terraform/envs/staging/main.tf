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

  domain_name      = "photos.dev.apkas.net"
  hosted_zone_name = "dev.apkas.net"
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

  domain_name      = "admin.dev.apkas.net"
  hosted_zone_name = "dev.apkas.net"

  table_name = module.storage.table_name
  table_arn  = module.storage.table_arn

  # 起動できる対象は自環境の公開手続き1つに限る。**配信元と CDN への権限は
  # これを渡しても増えない。** 押せることと書けることは別の権限である。
  publish_project_arn = module.publish.project_arn
}

# 公開手続き。書いたものを配信に反映する側。
#
# **編集アプリケーションはこれを起動できるだけで、配信物には触れない。**
# バケットと CloudFront を書き換えられるのはこのモジュールが作る実行ロールに
# 限られる（design.md 決定4）。
#
# 渡している値は、これまで config/staging.env に人が転記していたものと同じ
# 集合である。出どころが同じ root の output なので、この経路には転記が挟まらない。
module "publish" {
  source = "../../modules/publish"

  environment = local.environment

  # 配る元のコードは環境によらず1つ。違うのは接続とプロジェクトのほう。
  repository_url = "https://github.com/ceshmina/apkas-diary.git"

  table_name = module.storage.table_name
  table_arn  = module.storage.table_arn
  gsi1_name  = module.storage.gsi1_name

  site_bucket_name = module.delivery.bucket_name
  site_bucket_arn  = module.delivery.bucket_arn
  distribution_id  = module.delivery.distribution_id
  site_url         = module.delivery.site_url

  photo_url = module.photos.photo_url
}
