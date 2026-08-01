terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"

      # CloudFront が使える証明書は us-east-1 のものに限られる。
      # 呼び出し側から us-east-1 のプロバイダを受け取る。
      configuration_aliases = [aws.us_east_1]
    }
  }
}

locals {
  bucket_name = "apkas-diary-site-${var.environment}-${var.aws_account_id}"
}

# ---------------------------------------------------------------------------
# 配信元のオブジェクトストレージ
#
# 直接公開はしない。CloudFront の OAC からのみ読めるように制限し、
# 公開範囲の制御を CloudFront という単一の入口に集約する。
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "site" {
  bucket = local.bucket_name

  tags = merge(var.tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# デプロイは `aws s3 sync --delete` で行うため、誤った同期で消えた生成物を
# 戻せるようにバージョニングを有効にしておく。
resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# 古いバージョンを無期限に貯めない。生成物は再ビルドで復元できるため短めでよい。
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  depends_on = [aws_s3_bucket_versioning.site]

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------
# ドメインと証明書
#
# ホストゾーンはこのシステム専用の資産ではない。メールの MX など他の用途の
# レコードが同居するため、ゾーンそのものは管理下に置かず data で参照し、
# このシステムが必要とするレコードだけを作る。
# ---------------------------------------------------------------------------

data "aws_route53_zone" "site" {
  name         = var.hosted_zone_name
  private_zone = false
}

# CloudFront が参照できる証明書は us-east-1 のものに限られる。
resource "aws_acm_certificate" "site" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  # ドメイン名を変えるとき、使用中の証明書を先に消そうとして失敗するのを避ける。
  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, {
    Name = var.domain_name
  })
}

# 検証用のレコード。Route53 はグローバルサービスなので既定のプロバイダで操作する。
resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.site.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      type   = option.resource_record_type
      record = option.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.site.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  # 証明書を作り直すと同名のレコードが再び現れる。手動の削除を挟まずに済ませる。
  allow_overwrite = true
}

# 証明書が ISSUED になる前にディストリビューションの更新が走ると失敗する。
# ここで発行の完了まで待たせ、CloudFront をこのリソースに依存させる。
resource "aws_acm_certificate_validation" "site" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

# ---------------------------------------------------------------------------
# 配信
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "apkas-diary-${var.environment}"
  description                       = "apkas-diary ${var.environment} のサイト配信元へのアクセス制御"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# S3 の REST エンドポイントは、サブディレクトリに対する index ドキュメントの
# 解決を行わない。`/2026/08/01` のようなパスを `/2026/08/01/index.html` に
# 解決するため、ビューアリクエストの時点で URI を書き換える。
resource "aws_cloudfront_function" "rewrite_index" {
  name    = "apkas-diary-${var.environment}-rewrite-index"
  runtime = "cloudfront-js-2.0"
  comment = "拡張子を持たないパスに /index.html を補う"
  publish = true
  code    = file("${path.module}/functions/rewrite-index.js")
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "apkas-diary ${var.environment}"
  default_root_object = "index.html"
  price_class         = var.price_class

  aliases = [var.domain_name]

  origin {
    origin_id                = "s3-site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id = "s3-site"
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    compress         = true

    # 閲覧に認証を要さない一般公開サイトだが、通信は暗号化を強制する。
    viewer_protocol_policy = "redirect-to-https"

    # AWS 管理ポリシー CachingOptimized。
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite_index.arn
    }
  }

  # OAC 経由では ListBucket を許可しないため、存在しないオブジェクトに対して
  # S3 は 404 ではなく 403 を返す。どちらも 404 ページに寄せる。
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # ARN は証明書そのものではなく検証リソースから取る。
  # 発行が完了する前にこのディストリビューションが更新されるのを防ぐため。
  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate_validation.site.certificate_arn

    # 専用 IP は月額が発生し、必要がない。
    ssl_support_method = "sni-only"

    # 既定証明書を使っている間は指定できなかった項目。
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = merge(var.tags, {
    Name = "apkas-diary-${var.environment}"
  })
}

# 配信元バケットは CloudFront のこのディストリビューションからのみ読める。
data "aws_iam_policy_document" "site" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ディストリビューションは IPv6 を有効にしているため、A だけでは IPv6 のみの
# 経路から到達できない。両方を作る。
resource "aws_route53_record" "site" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.site.zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name    = aws_cloudfront_distribution.site.domain_name
    zone_id = aws_cloudfront_distribution.site.hosted_zone_id

    # CloudFront はヘルスチェックの対象にできない。
    evaluate_target_health = false
  }
}
