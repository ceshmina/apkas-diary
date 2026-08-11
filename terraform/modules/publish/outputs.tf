output "project_name" {
  description = <<-EOT
    公開手続きの CodeBuild プロジェクト名。
    編集アプリケーションが起動する対象。function.jsonnet が state から読む。
  EOT
  value       = aws_codebuild_project.publish.name
}

output "project_arn" {
  description = <<-EOT
    プロジェクトの ARN。編集アプリケーションの権限を、この1つに限るために使う。
    起動と状況の読み取りはこの資源に対してだけ許される。
  EOT
  value       = aws_codebuild_project.publish.arn
}

output "connection_arn" {
  description = <<-EOT
    GitHub との接続の ARN。

    **作られた直後は PENDING で、認可は人がコンソールで行う。** 状態は
    次のコマンドで確認できる。AVAILABLE でなければビルドはソースを取得できない。

      aws codestar-connections get-connection --connection-arn <この値> --profile <profile>

    **状態そのものは output にしない。** 認可は Terraform の外で行われるので、
    出力に置くと `terraform plan` が「PENDING -> AVAILABLE」の差分を出し続ける。
    このリポジトリは「plan が差分を出さないこと」を、lambroll の設定が
    黙って戻されていないかの唯一の検出手段にしている。常に差分が出る状態を
    作ると、その信号が読まれなくなる。
  EOT
  value       = aws_codestarconnections_connection.github.arn
}

output "role_arn" {
  description = <<-EOT
    公開手続きの実行ロール。配信元バケットと CloudFront を書き換えられる
    唯一の人でない主体。権限の確認（tasks 6.9）で引き受ける先。
  EOT
  value       = aws_iam_role.publish.arn
}

output "log_group_name" {
  description = "ビルドの記録が残るロググループ。"
  value       = aws_cloudwatch_log_group.publish.name
}
