# apkas-diary

個人の日記サイト。日記データは DynamoDB を正とし、ローカルでビルドした静的サイトを S3 + CloudFront で配信する。写真は別の経路で、投入すると Lambda が派生画像を作って配信用の S3 + CloudFront に置く。

```
【ビルド】
  DynamoDB ─┬─ 公開分（GSI1） ──▶ Astro ──▶ 静的サイト ──▶ S3 ──▶ CloudFront ──▶ 閲覧
            └─ 下書き含む全件 ──▶ Markdown 書き出し ──▶ export/（コミットしない）

【写真】
  元写真 ──▶ S3（アップロード用）──▶ Lambda ──▶ S3（配信用）──▶ CloudFront ──▶ 閲覧
                      │                  │
                 原本を保管         4サイズ・WebP・EXIF 全除去
```

現在の仕様は [openspec/specs/](openspec/specs/)、基盤構築時の設計判断は [openspec/changes/archive/2026-08-01-setup-diary-foundation/design.md](openspec/changes/archive/2026-08-01-setup-diary-foundation/design.md) を参照。

## 必要なツール

| ツール | バージョン | 備考 |
| --- | --- | --- |
| Node.js | 22 以上 | `.node-version` を参照 |
| Terraform | 1.10 以上 | S3 backend のネイティブロック（`use_lockfile`）を使うため |
| AWS CLI | v2 | デプロイと bootstrap で使う |
| lambroll | 1.3 以上 | 写真変換 Lambda のデプロイに使う。`brew install fujiwara/tap/lambroll` |

AWS は **staging と production でアカウントを分け、named profile で切り替える**。
リージョンはいずれも `ap-northeast-1`。

| 環境 | profile | サイトの URL | 写真の URL |
| --- | --- | --- | --- |
| staging | `apkas-staging.admin` | https://diary.dev.apkas.net | https://photos.dev.apkas.net |
| production | `apkas-production.admin` | https://diary.apkas.net | https://photos.apkas.net |

認証は IAM Identity Center（SSO）。期限が切れたらログインし直す。

```bash
aws sso login --profile apkas-staging.admin
aws sso login --profile apkas-production.admin
```

## 初期セットアップ

### 1. 依存関係

```bash
npm ci
npm --prefix lambda/photo-resize install   # 写真変換 Lambda の依存
```

Lambda の依存は**ルートとは別に持つ**。sharp が Linux 用の native binary を持つため、サイト生成の依存に混ぜたくない。入れていないと `npm run check` と `npm run deploy:lambda` が、実行すべきコマンドを添えて止まる。

### 2. Terraform state 用バケットの作成（環境ごとに1度だけ）

state の保存先そのものは Terraform では作れない（自己参照になる）ため、手で1度だけ作成する。

```bash
scripts/bootstrap-state.sh apkas-staging.admin
scripts/bootstrap-state.sh apkas-production.admin
```

スクリプトは以下を設定したバケットを作成する。冪等なので再実行しても安全。

- バージョニング有効（state の履歴を保持し、破損時に戻せる）
- パブリックアクセス全ブロック
- デフォルト暗号化（SSE-S3）

作成されるバケット名は `apkas-diary-tfstate-<アカウント ID>` の形式。完了時に `backend.hcl` に書く内容が表示される。

### 3. DNS ホストゾーンの用意（環境ごとに1度だけ）

サイトは環境ごとの独自ドメインで配信する。Terraform は**ホストゾーンを作らず、`data` で参照するだけ**なので、適用の前にゾーンが存在している必要がある。

| 環境 | ドメイン | 属するホストゾーン | ゾーンのあるアカウント |
| --- | --- | --- | --- |
| staging | `diary.dev.apkas.net` / `photos.dev.apkas.net` | `dev.apkas.net` | staging |
| production | `diary.apkas.net` / `photos.apkas.net` | `apkas.net` | production |

```
apkas.net                    [production account]
├── MX / TXT                 メールなど他の用途。Terraform は触らない
├── diary                    ← このリポジトリが作る
├── photos                   ← このリポジトリが作る
└── dev.apkas.net  NS ──┐    staging アカウントへの委譲
                        ▼
        dev.apkas.net        [staging account]
        ├── diary            ← このリポジトリが作る
        └── photos           ← このリポジトリが作る
```

写真のドメインも同じゾーンに収まる。新しいホストゾーンは要らない。

state の保存先と同じく、ホストゾーンはコード管理の外に置く例外である。`apkas.net` は日記サイト専用の資産ではなく、メールの MX など他の用途のレコードが同居しているため、このリポジトリの `terraform destroy` で消せる場所に置かない。

環境を表す `dev` をサービス名の**内側**に置いている（`dev.diary` ではなく `diary.dev`）。こうすると staging のレコードは委譲済みの `dev.apkas.net` ゾーンに収まり、staging の構築・再構築が production のホストゾーンにいっさい触れずに済む。

ゾーンがまだない場合は、親ゾーンからの NS 委譲を含めて手で用意する。既存の環境ではどちらも作成済み。

### 4. Terraform の設定

環境ごとに `terraform.tfvars` と `backend.hcl` を作る。実値はコミットしない。

```bash
cd terraform/envs/staging
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example      backend.hcl
```

`aws_account_id` は provider の `allowed_account_ids` に渡され、**認証情報が別の環境を指していた場合はリソースを1つも変更せずに失敗する**。取り違えの防止機構なので必ず正しい値を入れる。

### 5. インフラの作成

**staging から適用し、動作を確認してから production に進むこと。**

```bash
cd terraform/envs/staging
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

CloudFront ディストリビューションの作成には数分かかる。ACM 証明書の DNS 検証も同じく数分待つ。証明書が発行されるまで CloudFront の更新は始まらない。サイトと写真で2つずつ作られるので、初回はその両方を待つことになる。

この時点で写真変換の Lambda は**動かない中身のまま**作られる。実装を載せるのは次の手順。

#### DNS 検証が終わらないとき

`aws_acm_certificate_validation` で止まったまま進まない場合、検証用レコードが外部から解決できていない可能性が高い。ホストゾーンにレコードは作られているのに検証が通らないなら、**親ゾーンからの NS 委譲**を疑う。

```bash
# 委譲先ゾーンの NS が親から引けるか
dig +short NS dev.apkas.net

# 検証用レコードが外部から解決できるか（値は terraform の出力に出ている名前）
dig +short _xxxxxxxx.diary.dev.apkas.net CNAME
```

前者が空、または後者が引けない場合は委譲が機能していない。ゾーンの NS レコードと、親ゾーンに登録された NS が一致しているかを確認する。

### 6. 写真変換 Lambda のデプロイ

`terraform apply` が作るのは関数の**枠だけ**で、中身は「まだデプロイされていない」と記録して終わる仮のものである。実装は lambroll が載せる。

```bash
npm run deploy:lambda -- staging
```

このスクリプトはビルド（TypeScript のコンパイルと、sharp を linux/arm64 向けに入れ直すところ）も行う。関数名・ロール・配信先バケット・ディストリビューション ID は Terraform の state から直接読むので、転記するものはない。state の場所は `terraform/envs/<環境>/backend.hcl` から組み立てる。

デプロイの直後に、**`terraform plan` が差分を出さないことを確認する。**

```bash
cd terraform/envs/staging && terraform plan
```

関数のメモリ・タイムアウト・環境変数は lambroll が持ち、Terraform 側では `ignore_changes` で無視している。この一覧に漏れがあると、次の `terraform apply` が lambroll の設定を黙って既定値へ戻す。**それに気づく手段はこの plan だけ**なので、`lambroll deploy` のたびに見る。

### 7. 環境設定ファイル

```bash
cp config/staging.env.example    config/staging.env
cp config/production.env.example config/production.env
```

`terraform output` の値を転記する。

```bash
cd terraform/envs/staging && terraform output
```

設定を `config/<環境>.env` に置き `.env.<環境>` という名前にしていないのは、
**Vite がプロジェクトルートの `.env` / `.env.<mode>` を自動で読み込む**ため。
`astro build` のモードは対象環境によらず常に `production` なので、ルートに
`.env.production` があると staging のビルドにもその内容が混入する。環境の
取り違えを避けるため、Vite の名前空間の外に置いている。

## 日々の運用

すべてのコマンドは環境名（`staging` / `production`）を第1引数に取る。**対象環境を明示しないと実行できない。**

### エントリを追加・更新する

Markdown ファイルを書いて登録する。同じ日付に対する再登録は、2件目を作らず既存エントリの更新になる。

```bash
# 下書きとして登録
npm run entry -- staging --date 2026-08-01 --file ~/notes/today.md --title "散歩" --status draft

# 内容を確認してから公開する
npm run entry -- staging --date 2026-08-01 --status published
```

`--status published` にすると GSI のキー属性が付与され、次のビルドから公開サイトに現れる。`draft` に戻すとキー属性が外れ、公開サイトから消える。この付け外しはこのコマンドだけが行う。

### ビルドとデプロイ

```bash
npm run build  -- staging   # DynamoDB から取得して dist/ を生成し、export/ に書き出す
npm run deploy -- staging   # dist/ を S3 に同期し、CloudFront を invalidate する
```

`npm run build` は副産物として `export/` に全エントリ（下書きを含む）を Markdown で書き出す。これは DynamoDB や AWS アカウントを失った場合の備えで、リポジトリにはコミットしない。

### 写真を投入する

```bash
npm run photo -- staging --file ~/photos/IMG_1234.jpg --date 2026-08-08
```

`--date` から**キー**が `YYYY/MM/DD/<ファイル名>` として決まる。キーを直接指定したいときは `--key 2026/08/08/walk.jpg`（`--date` とは排他）。

置くのはアップロード用バケットまでで、そこから先は S3 のイベントで起動する Lambda が行う。コマンドは派生画像が現れるまで最大 30 秒待ってから、4つの URL を表示する。

配信される URL は**サイズ名を先頭に置き、拡張子を `.webp` に替えたもの**になる。

```
https://photos.dev.apkas.net/thumbnail/2026/08/08/IMG_1234.webp   長辺  240px
https://photos.dev.apkas.net/small/2026/08/08/IMG_1234.webp       長辺  960px
https://photos.dev.apkas.net/medium/2026/08/08/IMG_1234.webp      長辺 1920px
https://photos.dev.apkas.net/large/2026/08/08/IMG_1234.webp       長辺 3840px
```

**サイズ名以外はすべて一致する。** 1つの URL を持っていれば、その部分を差し替えるだけで他のサイズに辿り着ける。日別ページの拡大表示はこの規約に依存している。

4つは元写真の大きさによらず常に揃う。元より大きいサイズを求められても引き伸ばさず、そのサイズは元と同じ大きさで作られる。参照する側が「このサイズはあるか」を確かめる必要はない。

配信される写真からは **EXIF・IPTC・XMP がすべて落ちる**。GPS による撮影場所も、撮影日時も、機材名も残らない。向きと色は落とす前に画素へ反映されるので、見え方は変わらない。

元写真はアップロード用バケットに残る。サイズを足したくなったとき、品質を変えたくなったときに、手元から入れ直さずに作り直せる。

#### HEIC は投入できない

**iPhone の標準形式（HEIC）は読めない。** 変換に使っている sharp の同梱 libheif は入力が AVIF に限られ、HEVC のデコーダを含まない（ライセンス上の事情）。投入しても派生画像は作られず、ログに「画像として読めませんでした」と残る。

手元で JPEG に変換してから投入する。

```bash
sips -s format jpeg IMG_1234.heic --out IMG_1234.jpg
```

受け付けられるのは JPEG・PNG・WebP・TIFF・AVIF など、sharp が読める静止画。

#### 写真を差し替える

同じキーに投入し直すと4つとも作り直され、CloudFront も更新される（Lambda が invalidate する）。ブラウザのキャッシュは最大1日で追いつく。

元写真のほうは上書きされるが、バケットのバージョニングが有効なので前の版は残っている。

#### 写真を消す

**自動では連鎖しない。** 元写真を消しても配信中の派生画像は消えない。両方を手で消す。

```bash
KEY=2026/08/08/IMG_1234
PROFILE=apkas-staging.admin

# 元写真（バージョニングが有効なので、完全に消すには全バージョンを消す必要がある）
aws s3 rm "s3://<PHOTO_UPLOAD_BUCKET>/$KEY.jpg" --profile "$PROFILE"

# 派生画像
for size in thumbnail small medium large; do
  aws s3 rm "s3://<PHOTO_BUCKET>/$size/$KEY.webp" --profile "$PROFILE"
done

# CDN から落とす
aws cloudfront create-invalidation \
  --distribution-id "<photo_distribution_id>" \
  --paths "/thumbnail/$KEY.webp" "/small/$KEY.webp" "/medium/$KEY.webp" "/large/$KEY.webp" \
  --profile "$PROFILE"
```

連鎖させないのは、原本を1つ消し損ねた操作が配信物まで巻き込むのを避けるためである。本文から参照が消えた写真が配信され続けても実害はないが、逆は取り返しがつかない。

#### 変換のコードを直す

```bash
npm run deploy:lambda -- staging
cd terraform/envs/staging && terraform plan   # 差分が出ないことを確認する
```

`terraform apply` は要らない。インフラと関数のコードは別のライフサイクルで動く。1つ前のコードに戻したいときは `lambroll rollback`。

失敗したときの理由は CloudWatch Logs に残る（ロググループは `/aws/lambda/apkas-diary-photo-resize-<環境>`、保持 30 日）。

## ディレクトリ構成

```
.
├── src/
│   ├── lib/          # 日付ユーティリティ、環境変数、DynamoDB アクセス、写真の URL 規約
│   ├── export/       # Markdown 書き出し
│   ├── cli/          # エントリ登録・写真投入 CLI
│   ├── layouts/      # Astro のレイアウト
│   ├── components/   # Astro のコンポーネント
│   └── pages/        # Astro のページ（ルーティング）
├── lambda/
│   └── photo-resize/ # 写真の変換。独自の package.json を持つ（sharp を隔離するため）
├── scripts/          # bootstrap / build / deploy / entry / photo / lambda
├── terraform/
│   ├── modules/
│   │   ├── storage/  # DynamoDB
│   │   ├── delivery/ # サイト配信。S3 + CloudFront + OAC
│   │   └── photos/   # 写真。S3 ×2 + CloudFront + OAC + Lambda の枠
│   └── envs/
│       ├── staging/
│       └── production/
├── export/           # 書き出された日記（コミットしない）
└── openspec/         # 仕様と変更提案
```

`lambda/` だけがルートと別の `package.json` を持つ。sharp が Linux 用の native binary を持ち、サイト生成の `npm ci` に持ち込みたくないためである。関数のコードは Terraform の管理下になく、`lambroll` が別に配る。

## 開発

```bash
npm run check          # 型チェックと Lint（lambda/ の型検査も含む）
npm run format         # 整形と自動修正
```

### AWS に接続せずに動かす

`DYNAMODB_ENDPOINT` を設定すると接続先を上書きできる。DynamoDB Local に向ければ、
AWS アカウントなしでビルドまで通せる。

```bash
docker run -d --name apkas-ddb-local -p 8000:8000 amazon/dynamodb-local:latest
```

`config/staging.env` に以下を足す（実際の AWS を使うときは消す）。

```
DYNAMODB_ENDPOINT=http://localhost:8000
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
```

テーブルは `terraform/modules/storage` と同じスキーマ（`pk` / `sk` と GSI `gsi1`）で
手元に作る必要がある。`AWS_PROFILE` と静的キーを同時に設定すると SDK が profile を
優先するため、ローカルに向けるときは `AWS_PROFILE` を外すこと。

## 設計上の要点

- **データの正は DynamoDB**。静的サイトはその射影であり、`export/` の Markdown はバックアップ。
- **下書きの除外は sparse index による**。`draft` のあいだは GSI のキー属性そのものを書かないため、公開サイトの生成は GSI を読むだけで公開分のみを得る。取得側にフィルタが存在しないので、下書きが漏れる経路が構造的にない。
- **日付は JST の暦日を文字列として扱う**。`Date` 型に変換すると実行環境のタイムゾーンで前後の日にずれるため、比較・整列・グルーピングはすべて文字列で行う。
- **写真は配信用バケットに人が書かない**。書けるのは Lambda だけで、そこに置かれるのは元写真から機械的に作られたものに限られる。「EXIF が残っていないこと」を毎回の注意ではなく経路の不在で守っている。
- **写真の元と配信は別のバケット**。サイトのデプロイは `aws s3 sync --delete` で配信元を丸ごと同期するため、写真が同居していると1度のデプロイで消える。バージョニングも、作り直せない元写真の側にだけ付けてある。
- **関数の存在は Terraform、中身は lambroll**。インフラと関数のコードは変わる頻度が違う。境界がここにあるのは、S3 のイベント通知が関数の実在を要求するためで、その代償として `ignore_changes` の一覧を人が保つ必要がある（`terraform plan` で見張る）。
