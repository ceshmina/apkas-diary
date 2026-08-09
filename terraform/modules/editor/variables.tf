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
    関数の予約同時実行数。

    認証は関数の中で行うため、認証されていない要求も関数を1回起動させる。
    暴走したときの上限をここで持つ。利用者は1人なので小さくてよい。
  EOT
  type        = number
  default     = 5
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
