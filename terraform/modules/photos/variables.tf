variable "environment" {
  description = "環境名。リソース名に含め、名前から所属環境が判別できるようにする。"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment は staging または production のいずれかである必要があります。"
  }
}

variable "aws_account_id" {
  description = "S3 バケット名を全世界で一意にするために付与するアカウント ID。"
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id は12桁の数字である必要があります。"
  }
}

variable "domain_name" {
  description = "写真を配信する独自ドメイン。証明書の名義であり、alias レコードの名前でもある。"
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

variable "upload_cors_origins" {
  description = <<-EOT
    アップロード用バケットへブラウザから直接 POST できるオリジン。

    編集アプリケーションの画面が、発行された presigned POST で元写真を送るために要る。
    **CORS は権限ではない**（署名のない要求は変わらず拒否される）が、応答を読ませて
    よい相手を宣言するものなので、編集アプリケーションのオリジンだけに限る。

    staging には手元での開発に使う localhost を含める。production には含めない。
  EOT
  type        = list(string)

  validation {
    condition     = length(var.upload_cors_origins) > 0
    error_message = "upload_cors_origins には少なくとも1つのオリジンが必要です。"
  }
}

variable "price_class" {
  description = "CloudFront の価格クラス。個人サイトのため既定では最も安いものを使う。"
  type        = string
  default     = "PriceClass_200"
}

variable "log_retention_days" {
  description = <<-EOT
    Lambda のログを残す日数。
    失敗の理由を後から読めればよく、無期限に貯める必要はない。
  EOT
  type        = number
  default     = 30
}

variable "tags" {
  description = "全リソースに付与するタグ。"
  type        = map(string)
  default     = {}
}
