variable "aws_region" {
  description = "リソースを作成するリージョン。"
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_profile" {
  description = <<-EOT
    操作対象の環境を決める AWS の named profile。
    空にすると AWS_PROFILE などの既定の解決順に委ねる。
  EOT
  type        = string
  default     = ""
}

variable "aws_account_id" {
  description = <<-EOT
    この環境の AWS アカウント ID。provider の allowed_account_ids に渡す。
    認証情報が別のアカウントを指していた場合、リソースを変更せずに失敗する。
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id は12桁の数字である必要があります。"
  }
}
