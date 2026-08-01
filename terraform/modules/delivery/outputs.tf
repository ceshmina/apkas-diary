output "bucket_name" {
  description = "サイト配信元の S3 バケット名。.env の SITE_BUCKET に転記する。"
  value       = aws_s3_bucket.site.bucket
}

output "bucket_arn" {
  description = "サイト配信元バケットの ARN。"
  value       = aws_s3_bucket.site.arn
}

output "distribution_id" {
  description = "CloudFront ディストリビューション ID。.env の CLOUDFRONT_DISTRIBUTION_ID に転記する。"
  value       = aws_cloudfront_distribution.site.id
}

output "site_url" {
  description = "サイトの URL。.env の SITE_URL に転記する。"
  value       = "https://${var.domain_name}"
}

output "distribution_domain_name" {
  description = <<-EOT
    CloudFront が払い出すドメイン名。
    独自ドメインの手前で切り分けたいときに直接叩く。転記の必要はない。
  EOT
  value       = aws_cloudfront_distribution.site.domain_name
}
