variable "environment" {
  description = "環境名。リソース名に含め、名前から所属環境が判別できるようにする。"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment は staging または production のいずれかである必要があります。"
  }
}

# ---------------------------------------------------------------------------
# ソース
# ---------------------------------------------------------------------------

variable "repository_url" {
  description = <<-EOT
    サイトの定義を取得するリポジトリの URL。

    **staging と production で同じ値になる。** 環境ごとに違うのは接続と
    プロジェクトであって、配る元のコードは1つである。それでも既定値を
    持たせずに環境の root から渡すのは、どの環境が何を配っているかを
    root だけ読んで確かめられる状態を保つため。
  EOT
  type        = string
}

variable "source_branch" {
  description = <<-EOT
    ビルドの対象とするブランチ。

    ボタンが配るのは常にこのブランチの最新であり、手元の未コミットの変更は
    配られない（site-publishing の「共有された版に由来する」）。
  EOT
  type        = string
  default     = "main"
}

# ---------------------------------------------------------------------------
# ビルドが読む値
#
# ここに並ぶのは config/<環境>.env に人が転記していたものと同じ集合である。
# 出どころは terraform output なので、**この経路には転記が挟まらない。**
# ---------------------------------------------------------------------------

variable "table_name" {
  description = "日記エントリを保持する DynamoDB テーブル名。DIARY_TABLE_NAME に渡す。"
  type        = string
}

variable "table_arn" {
  description = "日記エントリのテーブルの ARN。実行ロールの読み取りをこのテーブルだけに限るために使う。"
  type        = string
}

variable "gsi1_name" {
  description = <<-EOT
    公開エントリを引く GSI の名前。

    サイトの生成が読むのはこの索引だけで、ベーステーブルは読まない。
    実行ロールの Query をこの索引の ARN に限れるのはそのため。
  EOT
  type        = string
}

variable "site_bucket_name" {
  description = "サイト配信元の S3 バケット名。SITE_BUCKET に渡す。"
  type        = string
}

variable "site_bucket_arn" {
  description = "サイト配信元バケットの ARN。実行ロールの書き込みをこのバケットだけに限るために使う。"
  type        = string
}

variable "distribution_id" {
  description = "サイト配信の CloudFront ディストリビューション ID。CLOUDFRONT_DISTRIBUTION_ID に渡す。"
  type        = string
}

variable "site_url" {
  description = "サイトの公開 URL。SITE_URL に渡す。"
  type        = string
}

variable "photo_url" {
  description = "写真の配信 URL の基点。PHOTO_URL に渡す。生成されたページ中の写真がここを指す。"
  type        = string
}

variable "recent_count" {
  description = <<-EOT
    トップページに表示する最新エントリの件数。DIARY_RECENT_COUNT に渡す。

    **既定は config/<環境>.env.example と同じ 20 にしてある。** この値は
    生成物の中身を変えるので、手元とここで食い違うと「どこから起動しても
    同じ生成物」という前提が崩れる。片方だけ変えないこと。
  EOT
  type        = number
  default     = 20
}

# ---------------------------------------------------------------------------
# 実行環境
# ---------------------------------------------------------------------------

variable "compute_type" {
  description = "CodeBuild の計算資源の大きさ。実行した分だけ課金される。"
  type        = string
  default     = "BUILD_GENERAL1_SMALL"
}

variable "build_image" {
  description = <<-EOT
    ビルドに使うイメージ。Node 22 を持つ ARM の標準イメージ。

    arm64 を選ぶのは、既存の Lambda 2つと揃うことと、同じ性能あたりの
    単価が安いことによる。Node の版は buildspec.yml の runtime-versions が
    決めるので、イメージを上げても .node-version との対応は崩れない。
  EOT
  type        = string
  default     = "aws/codebuild/amazonlinux-aarch64-standard:3.0"
}

variable "build_timeout_minutes" {
  description = <<-EOT
    1回のビルドに許す時間。実測で2〜3分なので、余裕を見て切り上げてある。

    上限を持つのは、暴走したビルドが課金され続けるのを止めるためである。
  EOT
  type        = number
  default     = 20
}

variable "queued_timeout_minutes" {
  description = <<-EOT
    同時実行の上限に当たって待たされたビルドを、諦めるまでの時間。

    既定の 480 分のままだと、擦り抜けて積まれた1件が何時間も後に動きうる。
    押した人がとうに画面を閉じている時刻に配信が変わる状態を作らない。
  EOT
  type        = number
  default     = 15
}

variable "log_retention_days" {
  description = "ビルドのログを残す日数。他の実行系（Lambda 2つ）と揃えてある。"
  type        = number
  default     = 30
}

variable "tags" {
  description = "全リソースに付与するタグ。"
  type        = map(string)
  default     = {}
}
