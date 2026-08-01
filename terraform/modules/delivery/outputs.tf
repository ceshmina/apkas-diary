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
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}
