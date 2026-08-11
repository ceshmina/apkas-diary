locals {
  name = "apkas-diary-publish-${var.environment}"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# ソースコード基盤との接続
#
# **Terraform が作れるのは PENDING の接続までである。** GitHub 側の認可は人が
# コンソールで行う。tfstate の保存先・DNS のホストゾーン・Google の OAuth
# クライアントに続く、コード管理の外に置く4つ目の例外にあたる
# （deployment-environments の「すべてのリソースはコードで管理される」）。
#
# 認可を待たずに `terraform apply` は完了する。**その状態でビルドを起動すると
# ソースの取得で失敗する。** 隠さずに失敗させるのが正しい。認可し忘れた環境が
# 「動いているように見えて古い内容を配り続ける」形にはならない。
# ---------------------------------------------------------------------------

resource "aws_codestarconnections_connection" "github" {
  name          = "apkas-diary-${var.environment}"
  provider_type = "GitHub"

  tags = merge(var.tags, {
    Name = "apkas-diary-${var.environment}"
  })
}

# 接続を CodeBuild のソース資格情報として登録する。
#
# **これはアカウントとリージョンにつき1つしか持てない**（server_type ごと）。
# staging と production はアカウントが分かれているので、それぞれが自分の
# 接続を1つ持つ形に自然に収まる。同居させる構成は採れない。
resource "aws_codebuild_source_credential" "github" {
  auth_type   = "CODECONNECTIONS"
  server_type = "GITHUB"
  token       = aws_codestarconnections_connection.github.arn
}

# ---------------------------------------------------------------------------
# 実行の記録
#
# 保持期間を Terraform が持つ。設定せずに実行させると、CodeBuild が保持期間の
# 無いグループを勝手に作る（写真変換 Lambda・編集アプリケーションと同じ理由）。
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "publish" {
  name              = "/aws/codebuild/${local.name}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, {
    Name = local.name
  })
}

# ---------------------------------------------------------------------------
# 実行ロール
#
# **配信元バケットと CloudFront を書き換えられる、唯一の人でない主体がこれ。**
# 起動する側（編集アプリケーション）にこの権限は無く、持っているのは
# 「このプロジェクトを始めること」だけである（design.md 決定4）。
#
# 与える資源はすべて自環境のものに限る。他方の環境にも、写真にも届かない。
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "publish_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "publish" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.publish_assume_role.json

  tags = merge(var.tags, {
    Name = local.name
  })
}

data "aws_iam_policy_document" "publish" {
  # **日記は読むだけ。** 公開手続きが書き込む先は配信物であって、データではない。
  # PutItem も UpdateItem も DeleteItem も与えない。ビルドがデータを壊す経路が
  # 権限の側に存在しない。
  #
  # サイトの生成が読むのは GSI1 だけ（listAllPublished）なので、Query は索引の
  # ARN に限る。ベーステーブルへの Query は与えない。
  statement {
    sid     = "QueryPublishedEntries"
    effect  = "Allow"
    actions = ["dynamodb:Query"]

    resources = ["${var.table_arn}/index/${var.gsi1_name}"]
  }

  # export/ への書き出し（scanAllIncludingDrafts）はベーステーブルを走査する。
  # 下書きを含む全件を読む唯一の経路で、公開サイトの生成はこれを呼ばない。
  statement {
    sid     = "ScanAllEntriesForExport"
    effect  = "Allow"
    actions = ["dynamodb:Scan"]

    resources = [var.table_arn]
  }

  # `aws s3 sync --delete` に要るもの。**写真のバケットには触れない。**
  # 元写真も派生画像も別のバケットにあり、ここからは名前すら解決できない。
  statement {
    sid     = "ListSiteBucket"
    effect  = "Allow"
    actions = ["s3:ListBucket"]

    resources = [var.site_bucket_arn]
  }

  statement {
    sid    = "WriteSiteObjects"
    effect = "Allow"

    # GetObject は与えない。sync は宛先の一覧（大きさと更新時刻）だけで
    # 比較しており、中身は読まない。使っていない権限を「念のため」で置かない。
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = ["${var.site_bucket_arn}/*"]
  }

  # 配信中の内容を更新後のものへ入れ替える。無効化の作成だけで、
  # ディストリビューションの設定を変える権限は与えない。
  statement {
    sid     = "InvalidateSiteCache"
    effect  = "Allow"
    actions = ["cloudfront:CreateInvalidation"]

    resources = [
      "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${var.distribution_id}",
    ]
  }

  # ソースを取得するために接続を使う。
  #
  # 資源は自環境の接続1つに限る。**行動の接頭辞を2つ並べているのは、AWS が
  # codestar-connections から codeconnections へ改名する途中にあるため。**
  # 接頭辞は資源の ARN の側と一致していないと効かず、どちらが要求されるかは
  # 経路によって変わる。両方を同じ ARN に対して並べておけば、一致しないほうは
  # 何にも当たらずに終わる。
  statement {
    sid    = "UseSourceConnection"
    effect = "Allow"

    actions = [
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
      "codestar-connections:UseConnection",
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codeconnections:UseConnection",
    ]

    resources = [aws_codestarconnections_connection.github.arn]
  }

  # ロググループは Terraform が作るので logs:CreateLogGroup は与えない。
  # 保持期間の付いていないグループが実行時に生まれる経路を残さない。
  statement {
    sid     = "WriteLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]

    resources = ["${trimsuffix(aws_cloudwatch_log_group.publish.arn, ":*")}:*"]
  }

  # SSM・Secrets Manager への権限は与えない。公開手続きが読む値はすべて
  # プロジェクトの環境変数として渡っており、秘密は1つも要らない。
}

resource "aws_iam_role_policy" "publish" {
  name   = local.name
  role   = aws_iam_role.publish.id
  policy = data.aws_iam_policy_document.publish.json
}

# ---------------------------------------------------------------------------
# 公開手続き
#
# **手順そのものはここに持たない。** buildspec.yml がリポジトリの側にあり、
# それが呼ぶのは手元と同じ scripts/build.sh と scripts/deploy.sh である
# （design.md 決定2）。ここに書き写すと、ボタンから配ったものと手元から
# 配ったものが食い違う余地が生まれる。
#
# したがって手順を直すのはコードの変更であって、terraform apply は要らない。
# 関数の中身を lambroll が持つのと同じ、インフラと中身のライフサイクルの分離。
# ---------------------------------------------------------------------------

resource "aws_codebuild_project" "publish" {
  name          = local.name
  description   = "apkas-diary の公開サイトを ${var.environment} に配る"
  service_role  = aws_iam_role.publish.arn
  build_timeout = var.build_timeout_minutes

  # 同時実行の上限を CodeBuild 側で1に固定する。
  #
  # 起動の抑止は編集アプリケーションの画面でも行うが、判定と実際の起動の
  # あいだには隙間がある。**2つの `s3 sync --delete` が重なると、どちらの
  # 生成物とも一致しない状態が配信される。** そこは判定ではなく構造で塞ぐ
  # （design.md 決定6）。
  concurrent_build_limit = 1

  # 上限に当たって積まれたビルドを、いつまでも待たせない。
  queued_timeout = var.queued_timeout_minutes

  source {
    type            = "GITHUB"
    location        = var.repository_url
    git_clone_depth = 1

    # 履歴は要らない。読むのは作業ツリーだけで、使われた commit は
    # CODEBUILD_RESOLVED_SOURCE_VERSION から分かる。

    # buildspec.yml はリポジトリのルートの既定の位置にある。
    report_build_status = false
  }

  # 配るのはこのブランチの最新。起動時に上書きもできるが、既定はこれ。
  source_version = "refs/heads/${var.source_branch}"

  # 生成物は S3 へ直接同期する（deploy.sh）。CodeBuild の artifact として
  # 出す先は持たない。同じものを2箇所へ置く意味がない。
  artifacts {
    type = "NO_ARTIFACTS"
  }

  # キャッシュを持たない。起動が数日に1度では local cache はまず当たらず、
  # S3 cache は保存先とその寿命の管理が増える。npm ci の数十秒を惜しんで
  # 部品を増やさない（design.md 決定9）。
  cache {
    type = "NO_CACHE"
  }

  environment {
    type                        = "ARM_CONTAINER"
    compute_type                = var.compute_type
    image                       = var.build_image
    image_pull_credentials_type = "CODEBUILD"

    # 以下は config/<環境>.env に人が転記していたものと同じ集合である。
    # 出どころが terraform output なので、ここには転記が挟まらない。
    #
    # **秘密は1つも無い。** 値はいずれもバケット名やドメインで、コンソールに
    # 平文で並んで困るものではない。困るものが増えたときは parameter-store に
    # 移すこと（環境変数に置かない）。

    environment_variable {
      name = "DIARY_CONFIG_SOURCE"
      # 設定はファイルではなくここから来る、と scripts/lib/load-env.sh に伝える。
      # config/<環境>.env はコミットされないので、ソースの中には存在しない。
      value = "environment"
    }

    environment_variable {
      name  = "DIARY_ENV"
      value = var.environment
    }

    environment_variable {
      name  = "AWS_REGION"
      value = data.aws_region.current.region
    }

    environment_variable {
      name  = "DIARY_TABLE_NAME"
      value = var.table_name
    }

    environment_variable {
      name  = "SITE_BUCKET"
      value = var.site_bucket_name
    }

    environment_variable {
      name  = "CLOUDFRONT_DISTRIBUTION_ID"
      value = var.distribution_id
    }

    environment_variable {
      name  = "SITE_URL"
      value = var.site_url
    }

    environment_variable {
      name  = "PHOTO_URL"
      value = var.photo_url
    }

    environment_variable {
      name  = "DIARY_RECENT_COUNT"
      value = var.recent_count
    }

    # PHOTO_UPLOAD_BUCKET と PHOTO_BUCKET は渡さない。参照するのは写真を
    # 投入する CLI だけで、サイトの生成は写真の URL の規約しか使わない。
    # 渡さなければ、ここから写真の置き場所に触れる余地がそもそも無い。
    #
    # AWS_PROFILE も渡さない。資格情報は実行ロールから来る。
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.publish.name

      # stream_name は指定しない。ビルドごとに別のストリームになり、
      # 実行を取り違えずに読める。
    }

    s3_logs {
      status = "DISABLED"
    }
  }

  tags = merge(var.tags, {
    Name = local.name
  })

  # 資格情報の登録より先にプロジェクトが作られると、ソースの検証に失敗する。
  depends_on = [aws_codebuild_source_credential.github]
}
