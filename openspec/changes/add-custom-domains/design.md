## Context

動機は proposal.md の Why を参照。ここでは approach を決めるうえで効いた既存の状況だけを述べる。

`apkas.net` の Route53 ホストゾーンは **production アカウント**にあり、日記サイト専用の資産ではない。Google Workspace の MX、所有権確認の TXT、別サイトの CloudFront を指すレコードが同居している。

そのゾーンからは `dev.apkas.net` が **staging アカウント**のホストゾーンへ NS 委譲されている。委譲は済んでいるが、委譲先のゾーンには SOA と NS 以外のレコードが1つもない。staging 用のサブドメインをこの下に置く意図で用意され、まだ使われていない状態にある。

```
apkas.net              [production account]
├── MX / TXT                              他用途・触らない
├── photos.old.apkas.net  CNAME           他用途・触らない
└── dev.apkas.net  NS ──┐                 委譲済み
                        ▼
        dev.apkas.net  [staging account]  レコードなし
```

配信側は環境ごとに CloudFront ディストリビューションが1つあり、いずれも既定証明書（`cloudfront_default_certificate = true`）で動いている。Terraform の env はどちらも `ap-northeast-1` のプロバイダを1つだけ持つ。

## Goals / Non-Goals

**Goals:**

- 独自ドメインの割り当てを、既存の環境分離の考え方（アカウント分割、`allowed_account_ids` による取り違え防止）と矛盾なく成立させる。
- 証明書の発行から DNS への反映までを `terraform apply` の内側で完結させ、手作業の待ち合わせを残さない。
- ホストゾーンに同居する他用途のレコードを、この repo の Terraform が壊せない構造にする。

**Non-Goals:**

- ホストゾーンそのもののライフサイクル管理。作成・委譲・移管はこの repo の外で行う。
- DNS を使った他の用途（メール、他サイト）の面倒を見ること。

## Decisions

### 1. staging は `diary.dev.apkas.net` とする

環境を表す `dev` をサービス名の**外側**ではなく**内側**に置く。すなわち `dev.diary.apkas.net` ではなく `diary.dev.apkas.net`。

決め手はドメイン名の読みやすさではなく、**production アカウントへの書き込みが発生するかどうか**だった。

| | `diary.dev.apkas.net` | `dev.diary.apkas.net` |
| --- | --- | --- |
| 使うゾーン | 既存の `dev.apkas.net`（staging） | 新規の `dev.diary.apkas.net`（staging） |
| production ゾーンへの追加 | なし | NS 委譲レコードが必要 |
| staging 構築時の他環境への依存 | なし | staging のゾーンの NS を production 側へ転記する工程が要る |
| 既存の委譲 | 活きる | 使われないまま残る |

後者を選ぶと、staging を構築・再構築するたびに production のゾーンを触る可能性が生まれる。「片方への操作が他方に波及しない」という既存の線引きに、細いが恒久的な依存が1本渡る。前者はその線を跨がない。

`dev.diary.apkas.net` のほうが「diary の dev」と素直に読めるという利点は認めたうえで、環境分離を優先した。将来 `photos.dev.apkas.net` のように他サービスの staging を足すときも同じ枠に収まる。

### 2. ホストゾーンは `data` 参照とし、レコードだけを管理する

`aws_route53_zone` リソースとして取り込まない。`data "aws_route53_zone"` で参照し、この change が必要とするレコードだけを `aws_route53_record` として作る。

理由は、production のゾーンがこのシステム専用ではないこと。リソースとして取り込むと、`terraform destroy` がメール配送を落としうる構図になる。ゾーンの内容の大半はこの repo が知らない情報であり、知らないものを管理下に置くべきではない。

代償として「すべてのリソースはコードで管理される」に例外が1つ増える。state バケットに続く2つ目の例外であり、spec 側でも例外として明示する。

**却下した案**: ゾーンを import して丸ごと管理する。他用途のレコードをこの repo の Terraform に書き写す必要があり、DNS の管理をこのプロジェクトに引き寄せてしまう。日記サイトのリポジトリが持つべき責務ではない。

ゾーンは名前で引く（`hosted_zone_name`）。ID は不透明で、どのゾーンを指しているか読んで分からない。各アカウントに該当する public zone は1つしかないため、名前で一意に定まる。

### 3. ドメイン名とゾーン名は tfvars ではなく env の `main.tf` に直接書く

`aws_account_id` のように `terraform.tfvars` へ追い出さない。ドメイン名は DNS を引けば誰でも分かる公開情報であり、隠す理由がない。加えて `environment = "staging"` と同じく**その env を定義づける値**なので、env の `main.tf` に並んでいるほうが構成が読みやすい。

```hcl
# envs/staging/main.tf
module "delivery" {
  source = "../../modules/delivery"

  environment      = local.environment
  aws_account_id   = var.aws_account_id
  domain_name      = "diary.dev.apkas.net"
  hosted_zone_name = "dev.apkas.net"
}
```

### 4. 証明書と DNS レコードは `delivery` モジュールの中に置く

`domain` のような別モジュールに切らない。切ると依存が往復するため。

```
alias レコード ──必要とする──▶ CloudFront の domain_name / hosted_zone_id
CloudFront ────必要とする──▶ 証明書の ARN
```

証明書とレコードを1つのモジュールに分離すると、そのモジュールと `delivery` が相互に参照し合う。分けるなら「証明書モジュール」と「レコードは delivery の中」という非対称な形になり、境界が説明しづらい。ドメインは「訪問者にサイトが届く経路」の一部であり、`delivery` の関心事に収まる。

### 5. ACM は us-east-1 のプロバイダエイリアスで作る

CloudFront が使える証明書は us-east-1 のものに限られる。env に2つ目のプロバイダを定義し、モジュールへ `configuration_aliases` で渡す。

```hcl
# envs/*/providers.tf
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  profile             = var.aws_profile != "" ? var.aws_profile : null
  allowed_account_ids = [var.aws_account_id]   # 既定プロバイダと同じ守りをかける
  default_tags        = { ... }                # 既定プロバイダと揃える
}
```

`allowed_account_ids` を us-east-1 側にも必ず付ける。ここを空けると、環境の取り違えに対する守りが証明書だけ抜ける。

DNS 検証レコードを作る Route53 はグローバルサービスであり、既定プロバイダ（`ap-northeast-1`）から操作してよい。us-east-1 に置くのは証明書と、その検証完了を待つリソースだけ。

### 6. 証明書の検証完了を `aws_acm_certificate_validation` で待つ

証明書が `ISSUED` になる前に distribution の更新が走ると失敗する。検証用レコードの作成と、検証完了の待ち合わせを Terraform に入れ、CloudFront はその完了に依存させる。

```
aws_acm_certificate (us-east-1)
        │ domain_validation_options
        ▼
aws_route53_record (検証用 CNAME)
        │
        ▼
aws_acm_certificate_validation (us-east-1)   ← ISSUED まで待つ
        │ certificate_arn
        ▼
aws_cloudfront_distribution (aliases + viewer_certificate)
        │ domain_name / hosted_zone_id
        ▼
aws_route53_record (A / AAAA alias)
```

証明書には `create_before_destroy` を付ける。ドメイン名を変える場面で、使用中の証明書を先に消そうとして失敗するのを避ける。

### 7. A と AAAA の両方を alias で作る

ディストリビューションは `is_ipv6_enabled = true` で動いている。A だけ作ると IPv6 のみの経路から到達できない。CNAME ではなく alias を使うのは、Route53 の alias が追加課金なしで、かつ apex にも使える一貫した方法であるため（今回は apex ではないが、方法を揃える意味がある）。

### 8. 最小 TLS バージョンを `TLSv1.2_2021` にする

既定証明書を使っている間は指定できなかった項目。ACM 証明書に切り替えると `minimum_protocol_version` が選べるようになるので、この機会に現在の推奨値へ固定する。`ssl_support_method` は `sni-only`（専用 IP は月額が発生し、必要がない）。

### 9. CloudFront の既定ドメインは塞がない

代替ドメイン名を足しても `*.cloudfront.net` でのアクセスは残る。塞ぐには WAF や Function でホストヘッダを見る必要があり、個人サイトに対して割に合わない。生成物の canonical URL は `SITE_URL` 経由で独自ドメインを指すため、検索エンジンから見た正典は一意に定まる。切り分けの際に既定ドメインを直接叩けることは、むしろ利点として残す。

### 10. `site_url` の出力を独自ドメインに差し替える

モジュールの `site_url` 出力を `https://${var.domain_name}` に変える。この値は `config/<環境>.env` の `SITE_URL` に転記され、Astro の `site` に渡り、canonical とサイトマップに現れる。既定ドメインは `distribution_domain_name` として別途出力し、切り分け用に参照できるようにする。

## Risks / Trade-offs

**staging の委譲が実際に機能するかは未検証** → `dev.apkas.net` ゾーンには SOA と NS しかなく、名前解決が親から子へ正しく流れることを一度も確認していない。委譲が壊れていれば ACM の DNS 検証が完了せず、`terraform apply` が待ち続けて失敗する。staging から先に適用するため、production に影響する前に発覚する。検証が滞る場合は、レコードを1つ作って外部から解決できるかを確かめれば切り分けられる。

**証明書の検証待ちで apply が長くなる** → DNS 検証は通常数分で終わるが、失敗すると既定のタイムアウトまで待つ。上記の切り分け手段を README に残す。

**CloudFront の代替ドメイン名はグローバルに一意** → 他の AWS アカウントが同じ名前を先に登録していると `CNAMEAlreadyExists` で失敗する。`diary.apkas.net` の CNAME は削除済みで、`diary.dev.apkas.net` は存在したことがないため、競合の可能性は低い。

**production のゾーンにこの repo が書き込む** → `data` 参照は読み取りだが、レコードの作成・削除は行う。誤ったゾーンを指せば他用途のレコードと衝突しうる。守りは `allowed_account_ids` と、ゾーンを名前で引くこと（ID の取り違えより検知しやすい）。作るレコード名は `diary.apkas.net` に限定され、既存のレコード名とは重ならない。

**`terraform destroy` でサイトのドメインが解決しなくなる** → レコードは管理下にあるため消える。ゾーンと他用途のレコードは残る。意図した挙動であり、これを避ける仕組みは入れない。

**ドメイン名の変更は distribution の更新をともなう** → 反映に数分かかる。頻度の低い操作なので許容する。

## Migration Plan

既存の `diary.apkas.net` の CNAME（GitHub Pages を指し、404 を返していた）は、この change の作業に先立って手動で削除済み。Route53 は同じ名前に CNAME と alias を共存させられないため、これが残っていると production の apply が衝突で失敗する。移行元のコンテンツは存在しないので、リダイレクトの手当ては不要。

1. **staging に適用する。** 証明書の発行、検証、distribution の更新、alias の作成までが1回の apply で通る。
2. **staging を確認する。** `https://diary.dev.apkas.net` がページを返し、証明書が警告なく検証されること。`http://` が HTTPS へ、存在しないパスが 404 ページへ落ちることも合わせて見る（既存の挙動が独自ドメインでも保たれることの確認）。
3. **`config/staging.env` の `SITE_URL` を更新し、再ビルド・再デプロイする。** canonical とサイトマップが独自ドメインに変わる。
4. **production に同じ手順を適用する。**

**ロールバック**: alias レコードを削除し、distribution の代替ドメイン名と証明書の指定を外せば、既定ドメインでの配信に戻る。既定ドメインは一貫して生きているため、切り戻しの経路がサイトの停止をともなわない。`SITE_URL` を戻して再デプロイすれば canonical も戻る。
