## Why

サイトはいま CloudFront が自動で払い出すドメイン（`d111111abcdef8.cloudfront.net`）で配信されている。この名前は覚えられず、人に伝えられず、配信基盤を作り直すと変わってしまう。日記サイトは長く同じ URL であり続けることに価値があるため、配信の実装から独立した独自ドメインを与える。

`apkas.net` の Route53 ホストゾーンはすでに存在し、staging 用の `dev.apkas.net` も委譲済みで空のまま用意されている。必要な土台は揃っており、あとは証明書とレコードを足すだけの状態にある。

## What Changes

- staging を `diary.dev.apkas.net`、production を `diary.apkas.net` で配信する。
- 環境ごとに ACM 証明書を発行する。CloudFront の制約により、証明書は **us-east-1** に作る。検証は DNS 検証とし、検証用レコードも Terraform で管理する。
- CloudFront ディストリビューションに代替ドメイン名を設定し、既定証明書から ACM 証明書に切り替える。あわせて最小 TLS バージョンを `TLSv1.2_2021` に固定する。既定証明書を使っている間は指定できなかった項目である。
- ホストゾーンに A / AAAA の alias レコードを作る。CloudFront は IPv6 を有効にしているため、両方を作る。
- ホストゾーンそのものは **`data` 参照** とし、Terraform の管理対象に入れない。
- `SITE_URL` が独自ドメインを指すようになる。ただし生成物そのものは変わらない。この値は Astro の `site` に渡るが、現状のテンプレートは canonical タグを出力せず sitemap も生成しないため、自サイトを指す絶対 URL が生成物に1つも存在しないためである。`SITE_URL` を正しく保つのは、それらを導入したときに正しい値が使われるようにするためであり、この change の時点では観測できる差を生まない。

CloudFront の既定ドメインでのアクセスは、代替ドメイン名を足したあとも塞がれない。canonical が独自ドメインを指すため実害はないと判断し、この change では対処しない。

### スコープ外

- `apkas.net` の apex と `www` の扱い。
- 独自ドメインへの移行にともなうリダイレクト。移行元が存在しないため不要（下記「前提」を参照）。
- CI/CD からのデプロイ。`site-delivery` の既存要件どおり、デプロイはローカルの操作で完結したままとする。

### 前提

`diary.apkas.net` には GitHub Pages を指す CNAME が残っていたが、それを主張するリポジトリは存在せず 404 を返す状態だった。Route53 は同じ名前に CNAME と alias レコードを共存させられないため、この CNAME は本 change の作業に先立って手動で削除済みである。したがって既存コンテンツの移行やリダイレクトは発生しない。

## Capabilities

### New Capabilities

なし。独自ドメインでの配信は「訪問者にサイトを届ける経路」の一部であり、既存の `site-delivery` の関心事に収まる。

### Modified Capabilities

- `site-delivery`: 配信に使うドメインを要件に加える。サイトは環境ごとに定められた独自ドメインで配信され、そのドメインに対して有効な証明書が提示されなければならない。既存の「サイトは CDN 経由で一般公開される」のシナリオが CDN の払い出すドメインを前提に書かれているため、独自ドメインを前提とする記述に改める。
- `deployment-environments`: 環境の独立に関する要件を2点補う。ひとつは、環境の DNS リソースがその環境のアカウント内で完結し、一方の環境への適用が他方のホストゾーンを変更しないこと。もうひとつは、「すべてのリソースはコードで管理される」の例外に DNS のホストゾーンを加えること。ホストゾーンは日記サイト専用の資産ではなく、メールの MX など他の用途のレコードが同居しているため、この change の管理対象に含めない。

## Impact

**Terraform**

- `terraform/modules/delivery`: ACM 証明書、証明書の検証、Route53 の alias レコードを追加。`domain_name` と `hosted_zone_name` を受け取る。`viewer_certificate` を既定証明書から ACM 証明書に変更。`site_url` の出力が独自ドメインになる。us-east-1 のプロバイダを `configuration_aliases` で受け取る。
- `terraform/envs/staging`, `terraform/envs/production`: us-east-1 のプロバイダエイリアスを追加し、`allowed_account_ids` を同じく設定する。モジュール呼び出しにドメインとホストゾーンを渡す。

**設定と運用**

- `config/staging.env`, `config/production.env`: `SITE_URL` を独自ドメインに更新する。値は `terraform output` から転記する既存の運用のまま変わらない。
- README: ホストゾーンが事前に存在することを前提条件として記述する。state バケットと同じく、コード管理の外にある依存として扱う。

**AWS リソース**

- 各環境の CloudFront ディストリビューションが更新される（代替ドメイン名と証明書の変更）。反映には数分かかる。
- production のホストゾーンに日記サイトのレコードが追加される。既存の MX / TXT / `photos.old` のレコードには影響しない。

**アプリケーション**

- 変更なし。ページ内のリンクはすべて相対パスであり、自サイトを指す絶対 URL が生成物に存在しない。canonical タグと sitemap の導入は別の change とする。
