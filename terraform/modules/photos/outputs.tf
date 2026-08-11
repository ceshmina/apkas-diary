output "upload_bucket_name" {
  description = "元写真を置く S3 バケット名。.env の PHOTO_UPLOAD_BUCKET に転記する。"
  value       = aws_s3_bucket.upload.bucket
}

output "upload_bucket_arn" {
  description = <<-EOT
    元写真を置く S3 バケットの ARN。
    編集アプリケーションの実行ロールを、このバケットへの書き込みだけに限るために使う。
  EOT
  value       = aws_s3_bucket.upload.arn
}

output "delivery_bucket_name" {
  description = "派生画像が置かれる S3 バケット名。人が書き込む先ではない。"
  value       = aws_s3_bucket.delivery.bucket
}

output "delivery_bucket_arn" {
  description = <<-EOT
    派生画像が置かれる S3 バケットの ARN。
    編集アプリケーションが変換の完了を見るための読み取りを、このバケットに限るために使う。
    **書き込みは誰にも渡さない。** ここへ書けるのは変換 Lambda だけである。
  EOT
  value       = aws_s3_bucket.delivery.arn
}

output "distribution_id" {
  description = "写真配信の CloudFront ディストリビューション ID。"
  value       = aws_cloudfront_distribution.photos.id
}

output "photo_url" {
  description = "写真の配信 URL の基点。.env の PHOTO_URL に転記する。"
  value       = "https://${var.domain_name}"
}

output "distribution_domain_name" {
  description = <<-EOT
    CloudFront が払い出すドメイン名。
    独自ドメインの手前で切り分けたいときに直接叩く。転記の必要はない。
  EOT
  value       = aws_cloudfront_distribution.photos.domain_name
}

output "function_name" {
  description = <<-EOT
    変換 Lambda の関数名。
    lambroll は state を直接読むため転記の必要はない。ログを探すときに使う。
  EOT
  value       = aws_lambda_function.resize.function_name
}
