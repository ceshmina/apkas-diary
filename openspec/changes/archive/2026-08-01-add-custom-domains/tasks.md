## 1. delivery モジュールに独自ドメインを組み込む

- [x] 1.1 `terraform/modules/delivery` の `required_providers` に `configuration_aliases = [aws.us_east_1]` を追加する
- [x] 1.2 `domain_name` と `hosted_zone_name` の変数を追加する。`domain_name` は `hosted_zone_name` で終わることを `validation` で確かめる
- [x] 1.3 `data "aws_route53_zone"` でホストゾーンを名前で参照する（`private_zone = false`）
- [x] 1.4 us-east-1 のプロバイダで `aws_acm_certificate` を作る。`validation_method = "DNS"`、`create_before_destroy = true`
- [x] 1.5 `domain_validation_options` を `for_each` して検証用の `aws_route53_record` を作る（Route53 は既定プロバイダで操作する）
- [x] 1.6 us-east-1 のプロバイダで `aws_acm_certificate_validation` を作り、発行完了を待たせる
- [x] 1.7 `aws_cloudfront_distribution` に `aliases` を設定し、`viewer_certificate` を ACM 証明書に切り替える（`ssl_support_method = "sni-only"`、`minimum_protocol_version = "TLSv1.2_2021"`）。証明書 ARN は `aws_acm_certificate_validation` から取り、発行前の更新が走らないようにする
- [x] 1.8 ディストリビューションを指す A と AAAA の alias レコードを作る（`evaluate_target_health = false`）
- [x] 1.9 `site_url` の出力を `https://${var.domain_name}` に変更し、既定ドメインを `distribution_domain_name` として別途出力する

## 2. 環境ごとの設定を追加する

- [x] 2.1 `terraform/envs/staging/providers.tf` に `us_east_1` のプロバイダエイリアスを追加する。`profile` / `allowed_account_ids` / `default_tags` は既定プロバイダと揃える
- [x] 2.2 `terraform/envs/staging/main.tf` の `module "delivery"` に `providers` ブロックと `domain_name = "diary.dev.apkas.net"` / `hosted_zone_name = "dev.apkas.net"` を渡す
- [x] 2.3 `terraform/envs/production` に対して 2.1 / 2.2 と同じ変更を行う。ドメインは `diary.apkas.net`、ゾーンは `apkas.net`
- [x] 2.4 両環境で `terraform init`（新しいプロバイダ設定の取り込み）と `terraform validate` が通ることを確かめる

## 3. staging に適用して確認する

- [x] 3.1 `terraform/envs/staging` で `terraform plan` を実行し、既存のバケットとテーブルが置き換え対象になっていないことを確認する
- [x] 3.2 `terraform apply` を実行する。証明書の発行と DNS 検証の完了まで待つ
- [x] 3.3 `https://diary.dev.apkas.net` がページを返し、証明書が警告なく検証されることを確認する
- [x] 3.4 `http://diary.dev.apkas.net` が HTTPS にリダイレクトされることを確認する
- [x] 3.5 存在しないパスが 404 ステータスと 404 ページを返すことを確認する（既存の挙動が独自ドメインでも保たれること）
- [x] 3.6 配信元バケットのオブジェクト URL への直接アクセスが拒否されることを確認する（既存要件の回帰確認）

## 4. production に適用して確認する

- [x] 4.1 `terraform/envs/production` で `terraform plan` を実行し、ホストゾーンに追加されるレコードが `diary.apkas.net` 関連のものだけであること、既存の MX / TXT / `photos.old` に変更がないことを確認する
- [x] 4.2 `terraform apply` を実行する
- [x] 4.3 `https://diary.apkas.net` に対して 3.3 から 3.6 と同じ確認を行う
- [x] 4.4 `dig`（または同等の手段）で `apkas.net` の MX が引けることを確認し、メール配送に影響が出ていないことを確かめる

## 5. 設定と文書を更新する

- [x] 5.1 `config/staging.env` と `config/production.env` の `SITE_URL` を `terraform output` の値に更新する
- [x] 5.2 `config/staging.env.example` と `config/production.env.example` の `SITE_URL` のコメントを、独自ドメインを転記する旨に更新する
- [x] 5.3 両環境で `npm run build` と `npm run deploy` を実行し、独自ドメインで更新後の内容が配信されることを確認する。あわせて生成物に `cloudfront.net` を指す絶対 URL が残っていないことを確かめる
- [x] 5.4 README にホストゾーンが事前に存在することを前提条件として追記する。state バケットと同じく、コード管理の外にある依存として位置づける
- [x] 5.5 README のサイト URL の記述と、ドメイン構成（どの環境がどのゾーンに属するか）を追記する
- [x] 5.6 DNS 検証が完了しない場合の切り分け手順を README に残す（委譲先ゾーンのレコードが外部から解決できるかを確かめる）
