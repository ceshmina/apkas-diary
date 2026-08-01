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

variable "price_class" {
  description = "CloudFront の価格クラス。個人サイトのため既定では最も安いものを使う。"
  type        = string
  default     = "PriceClass_200"
}

variable "tags" {
  description = "全リソースに付与するタグ。"
  type        = map(string)
  default     = {}
}
