variable "environment" {
  description = "環境名。リソース名に含め、名前から所属環境が判別できるようにする。"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment は staging または production のいずれかである必要があります。"
  }
}

variable "deletion_protection" {
  description = <<-EOT
    テーブルの削除保護。日記データは再取得が不可能なため production では有効にする。
    有効なあいだは terraform destroy でもテーブルを削除できない。
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "全リソースに付与するタグ。"
  type        = map(string)
  default     = {}
}
