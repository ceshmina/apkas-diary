variable "environment" {
  description = "環境名。リソース名に含め、名前から所属環境が判別できるようにする。"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment は staging または production のいずれかである必要があります。"
  }
}

variable "domain_name" {
  description = "編集アプリケーションを配信する独自ドメイン。証明書の名義であり、alias レコードの名前でもある。"
  type        = string

  validation {
    condition     = endswith(var.domain_name, ".${var.hosted_zone_name}")
    error_message = "domain_name は hosted_zone_name のサブドメインである必要があります。"
  }
}

variable "hosted_zone_name" {
  description = <<-EOT
    domain_name が属する Route53 ホストゾーンの名前。
    ゾーンはこのシステム専用の資産ではないため、作成せず data で参照する。
    適用前に存在している必要がある。
  EOT
  type        = string
}

variable "table_name" {
  description = "日記エントリを保持する DynamoDB テーブル名。関数の環境変数に渡す。"
  type        = string
}

variable "table_arn" {
  description = <<-EOT
    日記エントリのテーブルの ARN。実行ロールの権限をこのテーブルと
    その索引だけに限るために使う。
  EOT
  type        = string
}

variable "publish_project_arn" {
  description = <<-EOT
    公開手続きの CodeBuild プロジェクトの ARN。

    編集アプリケーションに与えるのは、**このプロジェクト1つを起動する権限と、
    その状況を読む権限だけ**である。配信元ストレージと CDN への権限はこれを
    足しても増えない（editor-hosting の「実行基盤の権限は自環境の日記データ・
    写真の投入・公開手続きの起動に限られる」）。
  EOT
  type        = string
}

variable "photo_upload_bucket_arn" {
  description = <<-EOT
    元写真を置く S3 バケットの ARN。

    ブラウザからの投入で、編集アプリケーションが**このバケットへの書き込みを
    許す一時的な資格を発行する**ために使う。**署名は実行ロールの権限を超え
    られない**ので、ここに与える権限がそのまま資格の上限になる。

    与えるのは PutObject だけである。読み取りは与えない（main.tf の
    PutOriginals を参照）。
  EOT
  type        = string
}

variable "photo_delivery_bucket_arn" {
  description = <<-EOT
    派生画像が置かれる S3 バケットの ARN。

    投入した写真の変換が終わったかを見るためだけに使う。**書き込みは与えない。**
    ここに書けるのは変換 Lambda だけであり、公開されるものが元写真から機械的に
    作られたものに限られるのは、その権限の配り方によっている。
  EOT
  type        = string
}

variable "log_retention_days" {
  description = <<-EOT
    Lambda のログを残す日数。
    失敗の理由を後から読めればよく、無期限に貯める必要はない。
  EOT
  type        = number
  default     = 30
}

variable "reserved_concurrency" {
  description = <<-EOT
    関数の予約同時実行数。-1 は予約しないことを表す。

    認証は関数の中で行うため、認証されていない要求も関数を1回起動させる。
    暴走したときの上限を持ちたい場所ではあるが、**既定では予約しない。**

    アカウントの同時実行上限が引き上げられていない場合（初期値は 10）、
    未予約分を 10 未満にする予約は API 側で拒否される。つまりどの関数も
    1つも予約できない。この状態ではアカウントの上限そのものが同時実行の
    上限として働くため、予約が無くても暴走の範囲は限られている。

    上限を引き上げたときに、ここへ小さい数を入れる。
  EOT
  type        = number
  default     = -1
}

variable "throttle_rate_limit" {
  description = "API Gateway のステージで許す毎秒の要求数。関数に届く前に落とす。"
  type        = number
  default     = 20
}

variable "throttle_burst_limit" {
  description = "API Gateway のステージで許す瞬間的な要求数。"
  type        = number
  default     = 40
}

variable "tags" {
  description = "全リソースに付与するタグ。"
  type        = map(string)
  default     = {}
}
