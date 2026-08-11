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

    # Lambda の placeholder をインラインの内容から組み立てるためだけに使う。
    # zip をリポジトリに置かずに済ませる。
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

locals {
  upload_bucket_name   = "apkas-diary-photo-upload-${var.environment}-${var.aws_account_id}"
  delivery_bucket_name = "apkas-diary-photo-${var.environment}-${var.aws_account_id}"
  function_name        = "apkas-diary-photo-resize-${var.environment}"
}

# ---------------------------------------------------------------------------
# アップロード用のストレージ
#
# 人が写真を置くのはここだけ。ここに置かれたものは公開されない。
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "upload" {
  bucket = local.upload_bucket_name

  tags = merge(var.tags, {
    Name = local.upload_bucket_name
  })
}

resource "aws_s3_bucket_public_access_block" "upload" {
  bucket = aws_s3_bucket.upload.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# 元写真は作り直せない。同じキーへの投入は上書きになるため、取り違えたときに
# 戻せる必要がある。派生画像と違って、失うと二度と手に入らない。
resource "aws_s3_bucket_versioning" "upload" {
  bucket = aws_s3_bucket.upload.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "upload" {
  bucket = aws_s3_bucket.upload.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# 編集アプリケーションの画面から元写真を直接 POST するために要る。
#
# **CORS は権限ではない。** ブラウザに応答を読ませてよいオリジンを宣言するだけで、
# 署名のない要求は CORS があってもなくても拒否される。書き込めるのは、編集
# アプリケーションが発行した presigned POST を持っている場合に限られる。
#
# 許すのは編集アプリケーションのオリジンだけにしてある。ここを広げると、別のサイト
# 上のスクリプトが（資格を手に入れたときに）応答を読めるようになる。
resource "aws_s3_bucket_cors_configuration" "upload" {
  bucket = aws_s3_bucket.upload.id

  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = var.upload_cors_origins

    # POST するフィールドはすべて本文の中にあり、独自ヘッダは付けない。
    # それでも許しておくのは、ブラウザが付けうるヘッダで弾かれないようにするため。
    allowed_headers = ["*"]

    # 応答から読むのは本文（Key を含む XML）だけで、ヘッダは読まない。
    expose_headers = ["ETag"]

    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "upload" {
  bucket = aws_s3_bucket.upload.id

  depends_on = [aws_s3_bucket_versioning.upload]

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    # 元写真は大きく、途中で切れた投入の残骸が課金され続けるのを防ぐ。
    # 古いバージョンそのものは期限を切らない。取り違えからの復旧に要る。
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------
# 配信用のストレージ
#
# 書けるのは Lambda だけ、読めるのは CloudFront だけ。人が写真を置く手順を
# 作らないことで、「公開されるのは元写真から機械的に作られたものに限る」を
# 経路の形として持たせている。
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "delivery" {
  bucket = local.delivery_bucket_name

  tags = merge(var.tags, {
    Name = local.delivery_bucket_name
  })
}

resource "aws_s3_bucket_public_access_block" "delivery" {
  bucket = aws_s3_bucket.delivery.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# バージョニングは有効にしない。派生画像は元写真からいつでも作り直せるので、
# 古い版に価値がない。写真1枚につき4つの版が貯まるだけになる。
# サイト配信用バケットが有効なのは、`sync --delete` の受け皿という別の事情による。

resource "aws_s3_bucket_server_side_encryption_configuration" "delivery" {
  bucket = aws_s3_bucket.delivery.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# ---------------------------------------------------------------------------
# ドメインと証明書
#
# ホストゾーンはこのシステム専用の資産ではない。ゾーンそのものは管理下に置かず
# data で参照し、このシステムが必要とするレコードだけを作る。
# ---------------------------------------------------------------------------

data "aws_route53_zone" "photos" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "photos" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, {
    Name = var.domain_name
  })
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.photos.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      type   = option.resource_record_type
      record = option.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.photos.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "photos" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.photos.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

# ---------------------------------------------------------------------------
# 配信
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "photos" {
  name                              = "apkas-diary-photos-${var.environment}"
  description                       = "apkas-diary ${var.environment} の写真配信元へのアクセス制御"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "photos" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "apkas-diary photos ${var.environment}"
  price_class     = var.price_class

  aliases = [var.domain_name]

  # default_root_object は置かない。写真の URL は常にオブジェクトを直接指すので、
  # 配信ドメインの根に返すものがない。
  #
  # CloudFront Function も持たない。サイト側の rewrite-index.js は拡張子のない
  # パスに /index.html を補うためのもので、ここには補うものがない。

  origin {
    origin_id                = "s3-photos"
    domain_name              = aws_s3_bucket.delivery.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.photos.id
  }

  default_cache_behavior {
    target_origin_id = "s3-photos"
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]

    # WebP は既に圧縮されている。その上に gzip / brotli をかけてもほとんど縮まず、
    # CPU と時間だけを使う。サイト側が true なのは HTML と CSS と JS を配るためで、
    # 同じ形をここでなぞらない。
    compress = false

    # 一般公開だが通信は暗号化を強制する。日記のページは HTTPS で配信されるので、
    # ここに HTTP が混じると混在コンテンツになって写真が表示されない。
    viewer_protocol_policy = "redirect-to-https"

    # AWS 管理ポリシー CachingOptimized。
    # 実際の保持期間は Lambda が付ける Cache-Control が決める。
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # custom_error_response は置かない。OAC のポリシーが s3:GetObject しか許さない
  # ため、存在しないキーに対して S3 は 404 ではなく 403 を返す。これをそのまま通す。
  #
  # 応答コードを差し替えるには、返すページの実体を配信用バケットに置くことになる。
  # 「置かれるのは元写真から作られた派生画像だけ」を、応答コードの見栄えのために
  # 崩す取引になる。参照する側にとって 403 と 404 はどちらも「読めなかった」である。

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # ARN は証明書そのものではなく検証リソースから取る。
  # 発行が完了する前にこのディストリビューションが更新されるのを防ぐため。
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.photos.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = merge(var.tags, {
    Name = "apkas-diary-photos-${var.environment}"
  })
}

# 配信元バケットはこのディストリビューションからのみ読める。
#
# s3:ListBucket は与えない。与えると存在しないキーに 404 を返せるようになるが、
# 同時に配信ドメインの根への要求がバケットのオブジェクト一覧として返りうる。
# 応答コードの見栄えのために、どの写真があるかを数え上げられる穴を開けない。
data "aws_iam_policy_document" "delivery" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.delivery.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.photos.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "delivery" {
  bucket = aws_s3_bucket.delivery.id
  policy = data.aws_iam_policy_document.delivery.json

  depends_on = [aws_s3_bucket_public_access_block.delivery]
}

# ディストリビューションは IPv6 を有効にしているため、A だけでは IPv6 のみの
# 経路から到達できない。両方を作る。
resource "aws_route53_record" "photos" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.photos.zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name    = aws_cloudfront_distribution.photos.domain_name
    zone_id = aws_cloudfront_distribution.photos.hosted_zone_id

    # CloudFront はヘルスチェックの対象にできない。
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# 変換
#
# 関数の**存在と配線**だけを Terraform が持つ。コードと実行時設定は lambroll が
# 持ち、`npm run deploy:lambda -- <環境>` で差し替わる（design.md 決定9）。
#
# 境界がここにあるのは、S3 のイベント通知と aws_lambda_permission が、関数が
# 実在していないと作れないためである。トリガーの配線を Terraform に置く以上、
# 関数の実体が先に要る。
# ---------------------------------------------------------------------------

# 動かない中身。lambroll が最初のデプロイで置き換える。
#
# それまでのあいだに写真が投入されたとき、記録を読めば理由がそのまま分かるように
# しておく。zip をリポジトリに置かずに済ませるため、内容はここに直接書く。
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    filename = "index.js"
    content  = <<-EOT
      // Terraform が作る仮の中身。実装は lambroll が載せる。
      exports.handler = async () => {
        console.error(
          'この関数はまだ lambroll でデプロイされていません。' +
            'npm run deploy:lambda -- <環境> を実行してから、写真を投入し直してください。'
        )
      }
    EOT
  }
}

resource "aws_lambda_function" "resize" {
  function_name = local.function_name
  role          = aws_iam_role.resize.arn

  # この5つは Terraform が唯一の宣言元。function.jsonnet は tfstate から読む。
  # 同じ値が2箇所に書かれる状態を作らない。
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  # メモリ・タイムアウト・環境変数はここに書かない。function.jsonnet が持つ。
  lifecycle {
    # function.jsonnet が設定するものをすべて並べる。**並べ忘れた項目は
    # terraform apply が黙って既定値へ戻す**ので、lambroll deploy の直後に
    # terraform plan が差分を出さないことを確認する（README・tasks 7.4）。
    #
    # layers と ephemeral_storage は今の function.jsonnet が設定していない。
    # 設定するようになったときに気づけないと困る種類のものなので、先に入れてある。
    #
    # role / function_name / runtime / handler / architectures は並べない。
    # ロールを作り直して ARN が変わったとき、Terraform が追従する必要がある。
    ignore_changes = [
      filename,
      source_code_hash,
      memory_size,
      timeout,
      environment,
      layers,
      ephemeral_storage,
    ]
  }

  # ロググループを Terraform が持つので、関数より先に作られる必要がある。
  # 先に関数が呼ばれると Lambda が保持期間なしで自動生成してしまう。
  depends_on = [aws_cloudwatch_log_group.resize]

  tags = merge(var.tags, {
    Name = local.function_name
  })
}

resource "aws_cloudwatch_log_group" "resize" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, {
    Name = local.function_name
  })
}

data "aws_iam_policy_document" "resize_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "resize" {
  name               = local.function_name
  assume_role_policy = data.aws_iam_policy_document.resize_assume_role.json

  tags = merge(var.tags, {
    Name = local.function_name
  })
}

data "aws_iam_policy_document" "resize" {
  statement {
    sid       = "ReadOriginals"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.upload.arn}/*"]
  }

  statement {
    sid    = "WriteDerivatives"
    effect = "Allow"

    # HeadObject は s3:GetObject で認可される。差し替えかどうかの判定にこれが要る。
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.delivery.arn}/*"]
  }

  statement {
    sid    = "ProbeDerivatives"
    effect = "Allow"

    # **存在しないキーに 404 を返させるために要る。**
    #
    # S3 は、s3:ListBucket をバケットに対して持たない主体からの要求には、キーが
    # 無い場合でも 403 を返す。キーの有無を外から数え上げられないようにするための
    # 振る舞いで、s3:GetObject をいくら与えても変わらない。
    #
    # 404 が返らないと、関数は「まだ無い」と「読めない」を区別できず、初回の投入が
    # 権限の失敗として落ち続ける。
    #
    # これは配信側の CloudFront に ListBucket を与えないこと（このファイル上部の
    # バケットポリシー）とは別の話である。あちらは閲覧者が一覧を得られる経路を
    # 開けない話で、こちらはこの関数だけが持つ権限。閲覧の経路は何も変わらない。
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.delivery.arn]
  }

  statement {
    sid       = "InvalidateReplaced"
    effect    = "Allow"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.photos.arn]
  }

  statement {
    sid     = "WriteLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    # ロググループは Terraform が作るので logs:CreateLogGroup は与えない。
    # 保持期間の付いていないグループが実行時に生まれる経路を残さない。
    #
    # ARN に `:*` が付くかどうかはプロバイダの版で揺れる。落としてから足すことで
    # どちらでも同じ形になる。
    resources = ["${trimsuffix(aws_cloudwatch_log_group.resize.arn, ":*")}:*"]
  }
}

resource "aws_iam_role_policy" "resize" {
  name   = local.function_name
  role   = aws_iam_role.resize.id
  policy = data.aws_iam_policy_document.resize.json
}

# ---------------------------------------------------------------------------
# 起動
# ---------------------------------------------------------------------------

resource "aws_lambda_permission" "allow_upload_bucket" {
  statement_id  = "AllowExecutionFromUploadBucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.resize.function_name
  principal     = "s3.amazonaws.com"

  source_arn     = aws_s3_bucket.upload.arn
  source_account = var.aws_account_id
}

resource "aws_s3_bucket_notification" "upload" {
  bucket = aws_s3_bucket.upload.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.resize.arn
    events              = ["s3:ObjectCreated:*"]
  }

  # 通知の作成時に S3 は呼び出せることを検証する。許可が先になければ失敗する。
  depends_on = [aws_lambda_permission.allow_upload_bucket]
}
