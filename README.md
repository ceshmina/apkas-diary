# apkas-diary

個人の日記サイト。日記データは DynamoDB を正とし、ローカルでビルドした静的サイトを S3 + CloudFront で配信する。

```
【ビルド】
  DynamoDB ─┬─ 公開分（GSI1） ──▶ Astro ──▶ 静的サイト ──▶ S3 ──▶ CloudFront ──▶ 閲覧
            └─ 下書き含む全件 ──▶ Markdown 書き出し ──▶ export/（コミットしない）
```

設計の詳細は [openspec/changes/setup-diary-foundation/design.md](openspec/changes/setup-diary-foundation/design.md) を参照。

## 必要なツール

| ツール | バージョン | 備考 |
| --- | --- | --- |
| Node.js | 22 以上 | `.node-version` を参照 |
| Terraform | 1.10 以上 | S3 backend のネイティブロック（`use_lockfile`）を使うため |
| AWS CLI | v2 | デプロイと bootstrap で使う |

AWS は **staging と production でアカウントを分け、named profile で切り替える**。
リージョンはいずれも `ap-northeast-1`。

| 環境 | profile |
| --- | --- |
| staging | `apkas-staging.admin` |
| production | `apkas-production.admin` |

認証は IAM Identity Center（SSO）。期限が切れたらログインし直す。

```bash
aws sso login --profile apkas-staging.admin
aws sso login --profile apkas-production.admin
```

## 初期セットアップ

### 1. 依存関係

```bash
npm ci
```

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

### 3. Terraform の設定

環境ごとに `terraform.tfvars` と `backend.hcl` を作る。実値はコミットしない。

```bash
cd terraform/envs/staging
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example      backend.hcl
```

`aws_account_id` は provider の `allowed_account_ids` に渡され、**認証情報が別の環境を指していた場合はリソースを1つも変更せずに失敗する**。取り違えの防止機構なので必ず正しい値を入れる。

### 4. インフラの作成

**staging から適用し、動作を確認してから production に進むこと。**

```bash
cd terraform/envs/staging
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
```

CloudFront ディストリビューションの作成には数分かかる。

### 5. 環境設定ファイル

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

## ディレクトリ構成

```
.
├── src/
│   ├── lib/          # 日付ユーティリティ、環境変数、DynamoDB アクセス
│   ├── export/       # Markdown 書き出し
│   ├── cli/          # エントリ登録 CLI
│   ├── layouts/      # Astro のレイアウト
│   ├── components/   # Astro のコンポーネント
│   └── pages/        # Astro のページ（ルーティング）
├── scripts/          # bootstrap / build / deploy / entry
├── terraform/
│   ├── modules/
│   │   ├── storage/  # DynamoDB
│   │   └── delivery/ # S3 + CloudFront + OAC
│   └── envs/
│       ├── staging/
│       └── production/
├── export/           # 書き出された日記（コミットしない）
└── openspec/         # 仕様と変更提案
```

## 開発

```bash
npm run check          # 型チェックと Lint
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
