# 以下の値を .env.production に転記する。

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
