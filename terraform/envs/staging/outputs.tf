# 以下の値を config/staging.env に転記する。

output "table_name" {
  description = "DIARY_TABLE_NAME"
  value       = module.storage.table_name
}

output "bucket_name" {
  description = "SITE_BUCKET"
  value       = module.delivery.bucket_name
}

output "distribution_id" {
  description = "CLOUDFRONT_DISTRIBUTION_ID"
  value       = module.delivery.distribution_id
}

output "site_url" {
  description = "SITE_URL"
  value       = module.delivery.site_url
}

# 転記しない。独自ドメインの手前で切り分けたいときに直接叩く。
output "distribution_domain_name" {
  description = "CloudFront が払い出すドメイン名"
  value       = module.delivery.distribution_domain_name
}

# --- 写真 ---

output "photo_upload_bucket" {
  description = "PHOTO_UPLOAD_BUCKET"
  value       = module.photos.upload_bucket_name
}

output "photo_url" {
  description = "PHOTO_URL"
  value       = module.photos.photo_url
}

# 以下は転記しない。

output "photo_delivery_bucket" {
  description = "派生画像が置かれるバケット。人が書き込む先ではない"
  value       = module.photos.delivery_bucket_name
}

output "photo_distribution_id" {
  description = "写真配信の CloudFront ディストリビューション ID"
  value       = module.photos.distribution_id
}

output "photo_distribution_domain_name" {
  description = "写真配信で CloudFront が払い出すドメイン名"
  value       = module.photos.distribution_domain_name
}

output "photo_function_name" {
  description = "変換 Lambda の関数名。lambroll は state を直接読むので転記は不要"
  value       = module.photos.function_name
}
