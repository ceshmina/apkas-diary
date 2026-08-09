output "editor_url" {
  description = "編集アプリケーションの URL。"
  value       = "https://${var.domain_name}"
}

output "function_name" {
  description = "編集アプリケーションの Lambda 関数名。lambroll は state を直接読むので転記は不要。"
  value       = aws_lambda_function.editor.function_name
}

output "role_arn" {
  description = "実行ロールの ARN。権限の確認（tasks 8.5 / 8.6）で引き受ける先。"
  value       = aws_iam_role.editor.arn
}

output "param_prefix" {
  description = "設定と秘密を置く SSM のパス。実値の投入先。"
  value       = local.param_prefix
}

output "api_id" {
  description = "API Gateway の HTTP API の ID。"
  value       = aws_apigatewayv2_api.editor.id
}

# 独自ドメインの手前で切り分けたいときに直接叩く。
output "api_endpoint" {
  description = "API Gateway が払い出すエンドポイント。"
  value       = aws_apigatewayv2_api.editor.api_endpoint
}

output "log_group_name" {
  description = "実行の記録が残るロググループ。"
  value       = aws_cloudwatch_log_group.editor.name
}
