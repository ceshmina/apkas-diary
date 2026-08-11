locals {
  name         = "apkas-diary-editor-${var.environment}"
  param_prefix = "/apkas-diary/${var.environment}/editor"

  # 秘密は Terraform が持たない。入れ物だけを作り、値は人が入れる
  # （design.md 決定7）。仮値のまま起動したら、編集アプリケーションが
  # 何をどこに設定すべきかを添えて落ちる。
  parameters = {
    "google-client-id" = {
      type        = "String"
      description = "Google OAuth クライアント ID。apkas-${var.environment} プロジェクトで作る。"
    }
    "google-client-secret" = {
      type        = "SecureString"
      description = "Google OAuth クライアントの secret。"
    }
    "session-key" = {
      type        = "SecureString"
      description = "セッション Cookie の署名鍵。差し替えると全セッションが切れる。"
    }
    "allowed-email" = {
      type        = "String"
      description = "編集アプリケーションの利用を許可する Google アカウント。1つだけ。"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# 設定と秘密
#
# Secrets Manager ではなく Parameter Store を使うのは費用のため。前者は秘密1つ
# あたり月 $0.40 かかる。Standard の Parameter Store は無料で、必要な機能
# （SecureString、環境ごとの階層、IAM でのパス単位の許可）はすべて足りる。
# 「使っていないあいだに費用の出る構成要素を作らない」という方針とも噛み合う。
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "editor" {
  for_each = local.parameters

  name        = "${local.param_prefix}/${each.key}"
  type        = each.value.type
  description = each.value.description

  # **実値はここに書かない。** 入れるのは人で、入れ方は README にある。
  #
  #   aws ssm put-parameter --name <名前> --value '<実値>' --overwrite --profile <profile>
  #
  # ignore_changes を外すと、次の terraform apply が実値をこの仮値へ黙って
  # 戻す。秘密が state に載らないことと引き換えに、この1行が要になっている。
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = merge(var.tags, {
    Name = "${local.param_prefix}/${each.key}"
  })
}

# ---------------------------------------------------------------------------
# 実行
#
# 関数の**存在と配線**だけを Terraform が持つ。コードと実行時設定（メモリ・
# タイムアウト・環境変数・レイヤー）は lambroll が持ち、
# `npm run deploy:editor -- <環境>` で差し替わる（design.md 決定9）。
#
# 境界がここにあるのは、API Gateway の統合と aws_lambda_permission が、関数が
# 実在していないと作れないためである。
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "editor" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, {
    Name = local.name
  })
}

# 動かない中身。lambroll が最初のデプロイで置き換える。
#
# handler が `run.sh` なのは Lambda Web Adapter の作法による。レイヤーと
# AWS_LAMBDA_EXEC_WRAPPER は lambroll 側が持つため、**この仮の中身のままでは
# 関数は起動しない**。それでよい。この段階で 5xx が返ることは
# 「まだデプロイしていない」の合図であり、隠すべき状態ではない。
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    filename = "run.sh"
    content  = <<-EOT
      #!/bin/bash
      echo 'この関数はまだ lambroll でデプロイされていません。' \
           'npm run deploy:editor -- <環境> を実行してください。' >&2
      exit 1
    EOT
  }
}

resource "aws_lambda_function" "editor" {
  function_name = local.name
  role          = aws_iam_role.editor.arn

  # この5つは Terraform が唯一の宣言元。function.jsonnet は tfstate から読む。
  # 同じ値が2箇所に書かれる状態を作らない。
  runtime       = "nodejs22.x"
  handler       = "run.sh"
  architectures = ["arm64"]

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  # **同時実行の上限は Terraform が持つ。** 認証は関数の中で行うため、認証を
  # 通らない要求も関数を1回起動させる。lambroll はこれを設定しないので、
  # ignore_changes にも入れない。
  #
  # 既定は -1（予約しない）。アカウントの同時実行上限が初期値の 10 のままだと、
  # 未予約分を 10 未満にする予約は拒否され、どの関数も1つも予約できない。
  # その状態ではアカウントの上限そのものが同時実行の上限として働く。
  # 上限を引き上げたときに variables.tf の既定を変える。
  reserved_concurrent_executions = var.reserved_concurrency

  # メモリ・タイムアウト・環境変数はここに書かない。function.jsonnet が持つ。
  lifecycle {
    # function.jsonnet が設定するものをすべて並べる。**並べ忘れた項目は
    # terraform apply が黙って既定値へ戻す**ので、lambroll deploy の直後に
    # terraform plan が差分を出さないことを確認する（README・tasks 7.10）。
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
  depends_on = [aws_cloudwatch_log_group.editor]

  tags = merge(var.tags, {
    Name = local.name
  })
}

data "aws_iam_policy_document" "editor_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "editor" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.editor_assume_role.json

  tags = merge(var.tags, {
    Name = local.name
  })
}

data "aws_iam_policy_document" "editor" {
  # **エントリを削除できないことを、ここで担保している。**
  #
  # 画面に削除ボタンを置かないことで満たすと、あとから足せてしまう。権限が
  # 無ければ、足そうとした時点で失敗する（entry-editing の「削除する手段を
  # 持たない」）。DeleteItem も BatchWriteItem も与えない。
  #
  # 与えるのは編集アプリケーションが実際に使う3つだけ。UpdateItem を持たない
  # のは putEntry が PutItem しか使わないため、Query を持たないのは一覧が
  # ベーステーブルの走査で足りているため（tasks 1.4）。使っていない権限を
  # 「将来のため」に置かない。必要になったら、そこで失敗して気づけばよい。
  statement {
    sid    = "ReadWriteEntries"
    effect = "Allow"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Scan",
    ]

    resources = [var.table_arn]
  }

  # 自分の設定だけを読む。他の環境のパスには届かない。
  #
  # GetParametersByPath はパスそのものに対する許可を要求するため、末尾に /* を
  # 付けた形だけでは足りない。両方を並べる。
  statement {
    sid     = "ReadOwnParameters"
    effect  = "Allow"
    actions = ["ssm:GetParametersByPath"]

    resources = [
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.param_prefix}",
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.param_prefix}/*",
    ]
  }

  # SecureString の復号。鍵は AWS 管理の alias/aws/ssm で、ARN が環境ごとに
  # 変わるうえ data で引くと権限が要る。SSM 経由の復号に限る条件を付けて
  # 資源側は絞らない、という定石の形にしてある。
  statement {
    sid     = "DecryptOwnParameters"
    effect  = "Allow"
    actions = ["kms:Decrypt"]

    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${data.aws_region.current.region}.amazonaws.com"]
    }
  }

  statement {
    sid     = "WriteLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]

    # ロググループは Terraform が作るので logs:CreateLogGroup は与えない。
    # 保持期間の付いていないグループが実行時に生まれる経路を残さない。
    resources = ["${trimsuffix(aws_cloudwatch_log_group.editor.arn, ":*")}:*"]
  }

  # 公開手続きを**起動する**権限と、その状況を**読む**権限。
  #
  # **これは配信物を書き換える権限ではない。** 編集アプリケーションが起こせる
  # のは「定められた手順を、定められた入力で始めること」だけで、何をどこへ
  # 書くかは手順の側（公開手続きの実行ロール）が持つ。このコードが乗っ取られ
  # ても、配信物へ任意の内容を書き込む経路にはならない。
  #
  # 削除の操作を画面ではなく権限で塞いでいるのと同じ考え方で、境界を「画面に
  # 何を置いたか」ではなく「何ができるか」の側に置いている。
  #
  # 3つとも資源をプロジェクトの ARN で絞れる。自環境の1つに限っており、
  # 他方の環境の公開手続きには届かない。
  statement {
    sid    = "StartAndWatchPublish"
    effect = "Allow"

    actions = [
      "codebuild:StartBuild",
      "codebuild:BatchGetBuilds",
      "codebuild:ListBuildsForProject",
    ]

    resources = [var.publish_project_arn]
  }

  # 元写真を置く権限。**置くことだけを与える。**
  #
  # ブラウザからの投入では、編集アプリケーションがこのバケットへの書き込みを許す
  # 一時的な資格（presigned POST）を発行し、写真そのものはブラウザから S3 へ直接
  # 送られる。**署名は実行ロールの権限を超えられない**ので、ここが資格の上限になる。
  #
  # **s3:GetObject を与えない。** 元写真は付随情報を除去する前のもので、撮影場所を
  # 含みうる。置ける入口であることが、過去に置いたものを持ち出せる経路になっては
  # ならない（editor-hosting の「投入したもの以外の元写真を読み出す権限も与えない」）。
  #
  # 代償として、投入の前に「同じキーが既にある」ことを確かめられない。取り違えて
  # 上書きしても元写真が失われないことは、バケットの versioning が担保している。
  statement {
    sid       = "PutOriginals"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${var.photo_upload_bucket_arn}/*"]
  }

  # 派生画像が出来たかを見る権限。**読むだけで、書かない。**
  #
  # 生成は投入と同期しないため、投入した直後は URL を開いても画像が返らない。
  # 貼ってよい状態になったことを画面で示すために、配信先の medium を HeadObject
  # で調べる。
  #
  # **配信 URL を叩いて調べる形にはしない。** まだ無いあいだの 403 が CDN に載り、
  # 自分の問い合わせが原因でしばらく読めないままになる（src/lib/env.ts と
  # src/cli/put-photo.ts に同じ判断がある）。
  statement {
    sid       = "ProbeDerivatives"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${var.photo_delivery_bucket_arn}/*"]
  }

  # **存在しないキーに 404 を返させるために要る。**
  #
  # S3 は、s3:ListBucket をバケットに対して持たない主体からの要求には、キーが無い
  # 場合でも 403 を返す。s3:GetObject をいくら与えても変わらない。404 が返らないと
  # 「まだ無い」と「読めない」を区別できず、最初の投入が権限の失敗として現れる。
  #
  # 変換 Lambda が同じ理由で同じ権限を持っている
  # （terraform/modules/photos/main.tf の ProbeDerivatives）。閲覧者が一覧を得られる
  # 経路とは無関係で、配信側の CloudFront には引き続き ListBucket を与えていない。
  statement {
    sid       = "ProbeDerivativeExistence"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.photo_delivery_bucket_arn]
  }

  # **写真について与えたのは「置くこと」と「出来たかを見ること」だけである。**
  # 配信されるものを直接書き換える権限にはならない。派生画像の配信元へ書けるのは
  # 変換 Lambda だけで、invalidation もその Lambda が行う。
  #
  # **公開サイトの配信元ストレージと CDN、および写真配信の CloudFront への権限は
  # 与えない。** 公開手続きを起動できるようになっても、写真を投入できるように
  # なっても、ここは変わらない。
}

resource "aws_iam_role_policy" "editor" {
  name   = local.name
  role   = aws_iam_role.editor.id
  policy = data.aws_iam_policy_document.editor.json
}

# ---------------------------------------------------------------------------
# 配信
#
# 前段は API Gateway の HTTP API とし、CloudFront + OAC は使わない。
# OAC が Lambda オリジンに付ける SigV4 署名は本文を署名対象に含めるが、Lambda は
# unsigned payload を受け付けないため、**POST を使うにはブラウザ側で本文の
# SHA-256 を計算して x-amz-content-sha256 に載せる必要がある**（design.md 決定2）。
# 日記を保存するアプリケーションでその前提は置けない。
#
# **Lambda の Function URL は作らない。** 関数へ届く経路が API Gateway だけに
# なり、迂回できる到達点が存在しなくなる（editor-hosting）。
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "editor" {
  name          = local.name
  description   = "apkas-diary editor ${var.environment}"
  protocol_type = "HTTP"

  # CORS は設定しない。別オリジンから叩くクライアントを持たない。

  tags = merge(var.tags, {
    Name = local.name
  })
}

resource "aws_apigatewayv2_integration" "editor" {
  api_id           = aws_apigatewayv2_api.editor.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.editor.invoke_arn

  payload_format_version = "2.0"

  # editor-hosting の「30 秒以内に応答」の上限は、ここでプラットフォーム側が
  # 担保する。超えたときは無応答で放置されず 504 が返る。
  timeout_milliseconds = 30000
}

# すべてのパスとメソッドを1つの関数へ渡す。経路の一覧を API Gateway 側に
# 持たせない。どのパスが存在するかはアプリケーションだけが知る。
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.editor.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.editor.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.editor.id
  name        = "$default"
  auto_deploy = true

  # 認証を通らない要求も関数を起動させる。関数に届く前にここで絞る。
  default_route_settings {
    throttling_rate_limit  = var.throttle_rate_limit
    throttling_burst_limit = var.throttle_burst_limit
  }

  tags = merge(var.tags, {
    Name = local.name
  })
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowExecutionFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.editor.function_name
  principal     = "apigateway.amazonaws.com"

  source_arn = "${aws_apigatewayv2_api.editor.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# 独自ドメイン
#
# ホストゾーンはこのシステム専用の資産ではない。ゾーンそのものは管理下に置かず
# data で参照し、このシステムが必要とするレコードだけを作る。
#
# 証明書はこの環境と同じリージョンのもので足りる。CloudFront を挟まないため
# us-east-1 の証明書を要求されない。
# ---------------------------------------------------------------------------

data "aws_route53_zone" "editor" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "editor" {
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
    for option in aws_acm_certificate.editor.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      type   = option.resource_record_type
      record = option.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.editor.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "editor" {
  certificate_arn         = aws_acm_certificate.editor.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "editor" {
  domain_name = var.domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.editor.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"

    # IPv6 のみの経路からも届くようにする。AAAA レコードを作る前提でもある。
    ip_address_type = "dualstack"
  }

  tags = merge(var.tags, {
    Name = var.domain_name
  })
}

resource "aws_apigatewayv2_api_mapping" "editor" {
  api_id      = aws_apigatewayv2_api.editor.id
  domain_name = aws_apigatewayv2_domain_name.editor.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "editor" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.editor.zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name    = aws_apigatewayv2_domain_name.editor.domain_name_configuration[0].target_domain_name
    zone_id = aws_apigatewayv2_domain_name.editor.domain_name_configuration[0].hosted_zone_id

    # API Gateway の regional エンドポイントはヘルスチェックの対象にしない。
    evaluate_target_health = false
  }
}
