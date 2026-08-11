# 環境名。編集アプリケーションが読む（production だけは公開の前に確認を挟む）。
# 転記はしない。function.jsonnet が state から読む。
output "environment" {
  description = "環境名"
  value       = local.environment
}

# 以下の値を config/production.env に転記する。

output "table_name" {
  description = "DIARY_TABLE_NAME"
  value       = module.storage.table_name
}

output "bucket_name" {
  description = "SITE_BUCKET"
  value       = module.delivery.bucket_name
}

output "distribution_id" {
  description = "CLOUDFRONT_DISTRIBUTION_ID"
  value       = module.delivery.distribution_id
}

output "site_url" {
  description = "SITE_URL"
  value       = module.delivery.site_url
}

# 転記しない。独自ドメインの手前で切り分けたいときに直接叩く。
output "distribution_domain_name" {
  description = "CloudFront が払い出すドメイン名"
  value       = module.delivery.distribution_domain_name
}

# --- 写真 ---

output "photo_upload_bucket" {
  description = "PHOTO_UPLOAD_BUCKET"
  value       = module.photos.upload_bucket_name
}

output "photo_url" {
  description = "PHOTO_URL"
  value       = module.photos.photo_url
}

# 以下は転記しない。

output "photo_delivery_bucket" {
  description = "派生画像が置かれるバケット。人が書き込む先ではない"
  value       = module.photos.delivery_bucket_name
}

output "photo_distribution_id" {
  description = "写真配信の CloudFront ディストリビューション ID"
  value       = module.photos.distribution_id
}

output "photo_distribution_domain_name" {
  description = "写真配信で CloudFront が払い出すドメイン名"
  value       = module.photos.distribution_domain_name
}

output "photo_function_name" {
  description = "変換 Lambda の関数名。lambroll は state を直接読むので転記は不要"
  value       = module.photos.function_name
}

# --- 編集アプリケーション ---

output "editor_url" {
  description = "編集アプリケーションの URL"
  value       = module.editor.editor_url
}

output "editor_param_prefix" {
  description = "OAuth クライアントと署名鍵を入れる SSM のパス"
  value       = module.editor.param_prefix
}

# 以下は転記しない。

output "editor_function_name" {
  description = "編集アプリケーションの関数名。lambroll は state を直接読むので転記は不要"
  value       = module.editor.function_name
}

output "editor_role_arn" {
  description = "編集アプリケーションの実行ロール。権限の確認で引き受ける先"
  value       = module.editor.role_arn
}

output "editor_api_id" {
  description = "編集アプリケーションの API Gateway の ID"
  value       = module.editor.api_id
}

output "editor_api_endpoint" {
  description = "独自ドメインの手前で切り分けたいときに叩くエンドポイント"
  value       = module.editor.api_endpoint
}

# --- 公開手続き ---
#
# いずれも転記しない。プロジェクト名は editor/function.jsonnet が state から
# 直接読み、接続の ARN は認可の確認（aws codestar-connections get-connection）に使う。
#
# **接続の状態は output にしない。** 認可は Terraform の外で行われるため、
# 置くと plan が「PENDING -> AVAILABLE」の差分を出し続け、差分の有無を
# 見張るという運用そのものが効かなくなる。

output "publish_project_name" {
  description = "公開手続きの CodeBuild プロジェクト名。編集アプリケーションが起動する対象"
  value       = module.publish.project_name
}

output "publish_connection_arn" {
  description = <<-EOT
    GitHub との接続。**作られた直後は PENDING で、認可は人がコンソールで行う。**
    AVAILABLE でないあいだ、公開手続きはソースを取得できない。
  EOT
  value       = module.publish.connection_arn
}

output "publish_role_arn" {
  description = "公開手続きの実行ロール。配信元と CDN を書き換えられる唯一の主体"
  value       = module.publish.role_arn
}
