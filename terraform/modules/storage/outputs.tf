output "table_name" {
  description = "日記エントリを保持する DynamoDB テーブル名。.env の DIARY_TABLE_NAME に転記する。"
  value       = aws_dynamodb_table.diary.name
}

output "table_arn" {
  description = "テーブルの ARN。"
  value       = aws_dynamodb_table.diary.arn
}

output "gsi1_name" {
  description = "公開エントリを日付順に引く GSI の名前。"
  value       = "gsi1"
}
