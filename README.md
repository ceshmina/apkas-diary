# apkas-diary

個人の日記サイト。日記データは DynamoDB を正とし、そこから生成した静的サイトを S3 + CloudFront で配信する。写真は別の経路で、投入すると Lambda が派生画像を作って配信用の S3 + CloudFront に置く。日記の追加・修正は手元の CLI からでも、ブラウザの編集アプリケーションからでも行える。公開サイトへの反映も、手元からでもブラウザからでも行える。

```
【編集】
  ブラウザ ──▶ API Gateway ──▶ Lambda（Astro SSR）──▶ DynamoDB
                                    ▲
                              Google でログイン

  手元の CLI（npm run entry）─────────────────────▶ DynamoDB

【ビルド】
  DynamoDB ─┬─ 公開分（GSI1） ──▶ Astro ──▶ 静的サイト ──▶ S3 ──▶ CloudFront ──▶ 閲覧
            └─ 下書き含む全件 ──▶ Markdown 書き出し ──▶ export/（コミットしない）

  これを走らせる場所が2つある。どちらも同じ scripts/build.sh と scripts/deploy.sh を通る。

  手元（npm run build / npm run deploy）──▶ 手元のコードから
  CodeBuild（ブラウザの「公開」ボタン）──▶ GitHub の main から

【写真】
  元写真 ──▶ S3（アップロード用）──▶ Lambda ──▶ S3（配信用）──▶ CloudFront ──▶ 閲覧
                      │                  │
                 原本を保管         4サイズ・WebP・EXIF 全除去
```

**編集アプリケーションが書き込むのは DynamoDB までで、配信物には触れない。** 公開の操作でできるのは CodeBuild のプロジェクトを1つ起動することだけで、S3 と CloudFront を書き換える権限は編集アプリケーションの実行ロールに無い。押せることと書けることを別の権限に分けてある。

現在の仕様は [openspec/specs/](openspec/specs/)、基盤構築時の設計判断は [openspec/changes/archive/2026-08-01-setup-diary-foundation/design.md](openspec/changes/archive/2026-08-01-setup-diary-foundation/design.md) を参照。

## 必要なツール

| ツール | バージョン | 備考 |
| --- | --- | --- |
| Node.js | 22 以上 | `.node-version` を参照 |
| Terraform | 1.10 以上 | S3 backend のネイティブロック（`use_lockfile`）を使うため |
| AWS CLI | v2 | デプロイと bootstrap で使う |
| lambroll | 1.3 以上 | 写真変換 Lambda と編集アプリケーションのデプロイに使う |

lambroll は macOS なら `brew install fujiwara/tap/lambroll`。Linux では [release](https://github.com/fujiwara/lambroll/releases) の tarball を落として PATH の通った場所に置く。

```bash
curl -sSL -o /tmp/lambroll.tar.gz \
  https://github.com/fujiwara/lambroll/releases/download/v1.5.1/lambroll_v1.5.1_linux_amd64.tar.gz
tar xzf /tmp/lambroll.tar.gz -C /tmp
install -m 0755 /tmp/lambroll ~/.local/bin/lambroll
```

AWS は **staging と production でアカウントを分け、named profile で切り替える**。
リージョンはいずれも `ap-northeast-1`。

| 環境 | profile | サイトの URL | 写真の URL | 編集の URL |
| --- | --- | --- | --- | --- |
| staging | `apkas-staging.admin` | https://diary.dev.apkas.net | https://photos.dev.apkas.net | https://admin.dev.apkas.net |
| production | `apkas-production.admin` | https://diary.apkas.net | https://photos.apkas.net | https://admin.apkas.net |

認証は IAM Identity Center（SSO）。期限が切れたらログインし直す。

```bash
aws sso login --profile apkas-staging.admin
aws sso login --profile apkas-production.admin
```

編集アプリケーションの利用者確認は **Google Cloud** に委ねる。環境ごとにプロジェクトが分かれている。

| 環境 | Google Cloud プロジェクト |
| --- | --- |
| staging | `apkas-staging` |
| production | `apkas-production` |

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

### 7. 編集アプリケーションの OAuth クライアント（環境ごとに1度だけ）

利用者の本人確認は Google に委ねる。そのためのクライアントは **Google Cloud のコンソールで手で作る**。state の保存先・DNS のホストゾーンと並ぶ、コード管理の外に置く例外である。

例外にしているのは、Terraform の Google プロバイダで OAuth クライアントを扱う口（`google_iap_client`）が IAP のブランドに紐づいたものに限られ、個人の Google アカウントで作る「ウェブアプリケーション」のクライアントを作れないため。無理に寄せると、AWS の適用に Google Cloud の資格情報が要る形になり、環境の取り違えを防ぐ仕組みも二重になる。

1. 対象のプロジェクト（staging なら `apkas-staging`）で **OAuth 同意画面**を設定する。個人の Google アカウントなら User type は External になるので、**自分をテストユーザに登録する**。
2. **認証情報 → OAuth クライアント ID → ウェブアプリケーション**を作る。承認済みのリダイレクト URI に次を登録する。

   | 環境 | リダイレクト URI |
   | --- | --- |
   | staging | `https://admin.dev.apkas.net/auth/callback` と `http://localhost:4321/auth/callback` |
   | production | `https://admin.apkas.net/auth/callback` のみ |

   **production に localhost を登録しない。** 手元から本番の認証を通せる経路を作らない。

3. クライアント ID と secret、セッションの署名鍵、許可するアカウントを SSM に入れる。`terraform apply` が作るのは**入れ物だけ**で、値は仮の `PLACEHOLDER` が入っている。

   ```bash
   PREFIX=$(cd terraform/envs/staging && terraform output -raw editor_param_prefix)
   PROFILE=apkas-staging.admin

   aws ssm put-parameter --profile "$PROFILE" --overwrite \
     --name "$PREFIX/google-client-id"     --value '<クライアント ID>'
   aws ssm put-parameter --profile "$PROFILE" --overwrite \
     --name "$PREFIX/google-client-secret" --value '<secret>'
   aws ssm put-parameter --profile "$PROFILE" --overwrite \
     --name "$PREFIX/session-key"          --value "$(openssl rand -base64 32)"
   aws ssm put-parameter --profile "$PROFILE" --overwrite \
     --name "$PREFIX/allowed-email"        --value 'you@example.com'
   ```

   **staging と production で別のクライアント・別の署名鍵を使う。** 片方の秘密が漏れても、もう片方には入れない。

   値を入れたあと `terraform plan` が差分を出さないことを確認する。パラメータは `ignore_changes = [value]` を付けてあり、これが効いていないと次の `apply` が実値を仮値へ戻す。

### 8. 編集アプリケーションのデプロイ

写真変換 Lambda と同じく、`terraform apply` が作るのは関数の枠だけである。

```bash
npm run deploy:editor -- staging
```

ビルド（Astro のビルドと、実行時の依存を linux/arm64 向けに揃えるところ）もこのスクリプトが行う。関数名・ロール・URL・パラメータの置き場所は Terraform の state から読むので、転記するものはない。

デプロイの直後に、写真変換 Lambda と同じ理由で **`terraform plan` が差分を出さないことを確認する。**

### 9. 環境設定ファイル

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

このファイルが要るのは**手元からの実行だけ**である。CodeBuild での公開手続きには
同じ集合が Terraform から環境変数として渡っており、そちらに転記は無い。

### 10. GitHub 接続の承認（環境ごとに1度だけ）

ブラウザの「公開」ボタンから配るには、CodeBuild が GitHub からソースを取れる
必要がある。接続そのものは `terraform apply` が作るが、**作られるのは `PENDING`
の状態までで、GitHub 側の認可は人が行う**。state の保存先・DNS のホストゾーン・
Google の OAuth クライアントに並ぶ、コード管理の外に置く4つ目の例外である。

Terraform で認可まで済ませられないのは、GitHub 側で当該アカウントに AWS の
Connector アプリを入れる操作が要るためで、これは資格情報ではなく人の同意にあたる。

```bash
ARN=$(cd terraform/envs/staging && terraform output -raw publish_connection_arn)
aws codestar-connections get-connection --connection-arn "$ARN" \
  --profile apkas-staging.admin --query Connection.ConnectionStatus --output text   # PENDING
```

AWS コンソールの **Developer Tools → 設定 → 接続**でその接続を開き、「保留中の接続を
更新」から GitHub の認可を通す。同じコマンドが `AVAILABLE` を返せば完了。

状態を `terraform output` に出していないのは、認可が Terraform の外で行われるためである。
出力に置くと `terraform plan` が「PENDING -> AVAILABLE」の差分を出し続け、**差分の有無を
見張るという運用そのものが効かなくなる**（この plan は lambroll の設定が黙って戻されて
いないかを知る唯一の手段でもある）。

**承認しないまま「公開」を押すと、ビルドはソースの取得で失敗する。** 黙って古い
内容を配り続けることはない。失敗は編集アプリケーションの画面に出る。

接続は環境ごとに別で、staging の承認は production に影響しない。片方の接続を
失効させても、もう片方は動き続ける。

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

`--status published` にすると GSI のキー属性が付与され、次のビルドから公開サイトに現れる。`draft` に戻すとキー属性が外れ、公開サイトから消える。

### ブラウザから書く

手元の環境が無くても書けるように、ブラウザから使える編集アプリケーションがある。

| 環境 | URL |
| --- | --- |
| staging | https://admin.dev.apkas.net |
| production | https://admin.apkas.net |

Google アカウントでログインする。許可されたアカウント以外は、認証に成功しても入れない。セッションは7日で切れる。

できることは CLI と同じで、読み書きするデータも同じである。

- エントリの一覧（**下書きも見える**。既定では新しい 100 件、それより古いものは年で辿る）
- 日付を指定して新規作成・編集（既にある日付を開くと、その内容を読み込んだ編集になる）
- 下書きと公開の切り替え
- 書きながらのプレビュー（**公開サイトとまったく同じ整形**で表示される）
- 写真の投入（「写真を投入する」の節）
- 公開サイトへの反映（次節）

記事の編集画面では、**本文の入力とプレビューが同時に見える**。広い画面（60rem 以上）では左右に並び、狭い画面では「編集」「プレビュー」のタブで切り替える。プレビューは手を止めると追随して更新されるので、確認のために押すものは無い。タイトル・公開状態・保存・その日の写真は、どちらを見ていても画面にある。

**プレビューは保存ではない。** 追随して更新されても、データストアに入るのは保存を押したときだけである。整形はサーバ側の `renderMarkdown()`——公開サイトの `.md` が通るのと同じ関数——を叩いており、ブラウザ側に別の Markdown 実装を持たない。そのため入力のたびに小さな要求が飛ぶが、書き込みは伴わない。

スクリプトが動かない環境でも確認そのものは残る。開いた時点の整形結果はサーバが描いており、追随しない代わりに「表示を確認」のボタンが現れる。狭い画面では切り替えの代わりに入力とプレビューが縦に並ぶ。

**削除はできない。** 画面に無いだけでなく、実行ロールに `DeleteItem` を与えていない。公開を取り下げたいときは下書きに戻す。本文は残る。

境界を画面ではなく権限に置いてあるのは削除に限らない。実行ロールが持つのは次の4つだけである。

| できること | できないこと |
| --- | --- |
| 自環境の日記テーブルの読み書き（`DeleteItem` は無い） | 他方の環境のリソース |
| 自分の設定（SSM）の読み取り | 公開サイトの配信元と CDN への書き込み |
| 自環境の公開手続きの起動と状況の読み取り | **派生画像の配信元への書き込み**、写真配信の CDN |
| **自環境のアップロード先への書き込みと、派生画像が出来たかの確認** | **元写真の読み出し**（置けるが、置いたものは読めない） |

写真について与えたのは「置くこと」と「出来たかを見ること**だけ**」で、配信されるものを直接書き換える権限にはならない。公開されるのは元写真から機械的に作られた派生画像に限られ、そこへ書けるのは変換 Lambda だけ、という構造は変わっていない。元写真を読めないようにしてあるのは、**元写真が EXIF を落とす前のもの**であり、置ける入口が過去に置いたものを持ち出せる経路になってはならないためである。

初回のアクセスは、使っていない時間が長いほど待つ（コールドスタート）。1〜3 秒程度で、30 秒を超えることはない。待っているあいだも料金は発生しない。使わない月の費用はゼロである。

#### ブラウザから公開する

一覧の「公開」から `/publish` に入る。押すと CodeBuild が動き、サイトを作り直して配信に反映する。

**配られるのは GitHub の `main` の内容である。** 手元にだけあるコミットしていない変更は含まれない。どの commit で走ったかは画面に出るので、意図した版が配られたかはそこで確かめられる。

- 所要は **1 分前後**（staging での実測は 48〜79 秒。**その半分以上は GitHub からのソース取得**で、サイトの生成自体は 15 秒ほど）。押した時点で応答が返り、進行中・成功・失敗が画面に出る。進行中のあいだは5秒ごとに自動で更新される。
- 費用は**実質ゼロ**。課金は分単位の切り上げで1回あたり1〜2分だが、CodeBuild には `arm1.small` で**月 100 分の無料枠**がある。1日数回の公開ならその範囲に収まる。超えたとしても分あたり $0.005 未満で、月に数十円の桁を出ない。実行していないあいだは発生しない。
- **実行中は押せない。** 2つの同期が重なると、どちらの生成物とも一致しない状態が配信されるため、画面でもプロジェクトの設定（`concurrent_build_limit = 1`）でも塞いである。
- **production では確認の一段が入る。** 押しただけでは始まらず、「実行する」を選んで初めて動く。
- 失敗したときは CloudWatch Logs へのリンクが出る。**失敗した実行は配信物に届いていない**（生成に失敗すると反映の段に進まない）ので、配信中の内容は直前のまま変わらない。

反映されない・古いままだと感じたときは、まず接続の状態を疑う。承認が切れていると、ソースの取得の段で失敗する。

#### 手元で動かす

画面を直すときは手元で動かす。**認証を迂回する経路は用意していない**ので、手元でも Google のログインを通る。

```bash
npm run dev:editor -- staging
```

読み書きの対象は指定した環境の DynamoDB テーブルで、設定も同じ環境の SSM から読む。手元用の別のデータは持たない。

### 手元からビルドとデプロイ

```bash
npm run build  -- staging   # DynamoDB から取得して dist/ を生成し、export/ に書き出す
npm run deploy -- staging   # dist/ を S3 に同期し、CloudFront を invalidate する
```

`npm run build` は副産物として `export/` に全エントリ（下書きを含む）を Markdown で書き出す。これは DynamoDB や AWS アカウントを失った場合の備えで、リポジトリにはコミットしない。

**ブラウザからの公開と同じスクリプトが動く。** CodeBuild の `buildspec.yml` が呼ぶのもこの2本で、違うのは資格情報の出どころ（named profile か実行ロールか）と、production の確認の取り方（対話か `DIARY_DEPLOY_CONFIRMED` か）だけである。手順の宣言元が1つなので、どちらから配っても同じものが出る。

**この経路はブラウザからの公開に依存しない。** GitHub が落ちていても、接続の承認が切れていても、CodeBuild に障害が出ていても、手元からは配れる。配る手段を1つに集約していないのは、日記が書き手ひとりの記録であり、公開の経路が失われたまま復旧を待つ状況を作らないためである。

手元からは**コミットしていない変更もそのまま配られる**。ブラウザからの公開との違いはここにある。試しに見た目を変えて確かめたいときは手元から、書いたものを普通に公開するときはブラウザから、と使い分ければよい。

### 写真を投入する

入口は2つある。**どちらから入れても同じ場所に置かれ、同じ URL になる。**

```bash
npm run photo -- staging --file ~/photos/IMG_1234.jpg --date 2026-08-08
```

`--date` から**キー**が `YYYY/MM/DD/<ファイル名>` として決まる。キーを直接指定したいときは `--key 2026/08/08/walk.jpg`（`--date` とは排他）。

置くのはアップロード用バケットまでで、そこから先は S3 のイベントで起動する Lambda が行う。コマンドは派生画像が現れるまで最大 30 秒待ってから、4つの URL を表示する。

投入すると**目録**にも記録される（次節）。`--key` で日付の規約から外れた場所へ置いたものは記録されず、その旨がコマンドの出力に出る。

#### ブラウザから投入する

編集アプリケーションの「写真」から入る。書いている途中なら、編集画面の**「保存して写真を追加」**から入るとその日付が選ばれた状態になる（写真の投入は編集画面を離れるので、**先に保存してから移る**。書きかけの本文は失われない）。

- **複数枚をまとめて選べる。** S3 の POST は1回に1枚しか受け取らないので、画面上のスクリプトが選ばれた枚数だけ順に送る。**1枚の失敗が他の枚を巻き戻さない**（どれが失敗したかは画面に出る）。
- **元写真は編集アプリケーションを経由しない。** ブラウザから S3 へ直接送られる。実行基盤が受け取れる要求の大きさ（10MB 弱）に縛られないのはこのためである。
- キーは CLI の `--date` と同じ `YYYY/MM/DD/<ファイル名>` になる。**キーを直接指定する手段はブラウザ側にはない。** 署名した日付の外へ置こうとすると S3 が断る。
- 上限は1枚あたり **50MB**。超えるものは CLI から入れる。
- **生成は非同期である。** 投入した直後は URL を開いても画像は返らない。結果の画面が数秒おきに確かめ、準備できた写真から順に**その写真を表示する**（意図したものが入ったかを目で確かめられる）。まだのものは表示しない——出来ていない URL をブラウザに取りにいかせると、その 403 が CDN に載る。
- 同じキーに入れ直した場合、**前の派生画像が残っていることを「終わった」とは扱わない**ので、古い URL を本文に貼ってしまうことがない。差し替えだったことは画面に出る。
- 準備できた写真には、本文にそのまま貼れる Markdown（`medium`）が付く。他の3つのサイズもそこから開ける。
- 90 秒待っても現れないときは待つのをやめる。**いちばん多い原因は HEIC**（次節）で、その場合は待っても現れない。

投入を許す資格は、その日付の下へ**書き込むことだけ**を、15 分のあいだ許すものである。既にある元写真を読むことも、消すこともできない。1枚ぶんの署名をその画面で選んだ全枚数に使い回す（policy がファイル名を含まないため成立する）。

アップロード用バケットには、編集アプリケーションのオリジンだけを許す CORS を入れてある。**CORS は権限ではない**——署名のない要求は変わらず拒否される。staging には手元での開発に使う `http://localhost:4321` も入っている。

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

#### 投入した写真の目録

投入された写真は、日記と**同じ DynamoDB テーブル**に1枚ずつ記録される。**登録する操作は無い。** 投入したことがそのまま記録になる。

記録は2つの主体が書く。

| 書く側 | 書くもの |
| --- | --- |
| 投入（CLI・編集アプリケーション） | 識別子・日付・ファイル名・元写真のキー・配信 URL |
| 変換（Lambda） | 撮影に関する情報・元写真の寸法・生成が終わったこと |

生成は投入と同期しないので、**変換のほうが先に書くこともある。** どちらが先でも最終的な記録は同じになり、識別子は一度決まったら変わらない。同じキーへ入れ直しても記録は1件のままで、識別子は変わらない。

記録されるのは次の項目である。

```
id          写真を指す識別子。置き場所や URL の規約が変わっても、これは変わらない
date        属する JST の暦日。同じ日付のエントリとの紐付けそのもの
filename    ファイル名
sourceKey   アップロード用バケットに置かれた元写真のキー
url         配信 URL（medium）
exif        機材・レンズ・焦点距離・絞り・シャッター速度・ISO・撮影日時
width/height 元写真の寸法（回転を反映したあとの向き）
renderedAt  派生画像が生成された時刻
```

**位置情報は記録しない。** GPS の座標は、読み取ったうえで捨てるのではなく、**取り出す対象に含めていない**。日記に使う用途がなく、保存しなければ公開側へ漏れる経路が最初から存在しない。撮影に関する情報を読み取るのは付随情報を落とす前で、**配信される派生画像から読み取れないことは変わらない**。

キーは `pk = PHOTO#<YYYY-MM-DD>` / `sk = <ファイル名>`。日記のエントリは `ENTRY#<年>` にあり、公開エントリの索引（GSI1）に写真は載らない。**同じテーブルにあるが、エントリの読み取りには現れない。** 公開サイトの生成と Markdown の書き出しは、写真が何枚増えても変わらない。

変換 Lambda に与えた DynamoDB の権限は `UpdateItem` ひとつで、条件（`dynamodb:LeadingKeys`）によって `PHOTO#` で始まるパーティションに限られている。**日記のエントリには届かない。** 読むことも消すこともできない。

目録は**配信されているものの写し**である。記録が無くても、派生画像があれば写真は配信される。逆に、記録があることは派生画像が出来ていることを意味しない。投入直後の待ち画面が配信元を直接見ているのはそのためで、目録の `renderedAt` を判定の正としていない。

**過去に投入した写真も目録にある。** 旧サイトから引き継いだ 2,365 枚は、旧ホスト（`photos.old.apkas.net`）から元写真を取り直して投入し直してあり、目録機能より前に投入した 30 枚も置き直して記録を埋めてある。どちらも新規の投入とまったく同じ経路を通したので、**いつ入れた写真かによって記録の形は変わらない**。撮影に関する情報も全数に入っている——元写真には付随情報が残っており、除去されているのは配信される派生画像のほうだけだった。移行の経緯は `openspec/changes/archive/` の `migrate-legacy-photos` にある。

日付の規約から外れたキーに置いたもの（CLI の `--key`）と、画像として読めないものだけが目録に無い。前者は属する日を持たず、後者は派生画像そのものが作られない。

#### 記事の編集画面から写真を扱う

エントリの編集画面に、**その日に投入した写真**が並ぶ。投入した直後の画面と同じもの——サムネイル・本文にそのまま貼れる記述（`medium`）・4つのサイズの URL——が、**いつ開いても**得られる。

- 一覧はフォームの外にあり、読み取り専用の要素だけでできている。見ても、記述を写しても、**書きかけのタイトルと本文は失われない。**
- 派生画像がまだのものは「準備中」と出て、画像は表示しない。出来ていない URL をブラウザに取りにいかせると、その 403 が CDN に載るため。
- **この節から投入の画面へのリンクは置いていない。** 素のリンクは編集画面を離れるので、書きかけの本文が保存されないまま失われる。写真を足すときは、これまでどおりフォームの**「保存して写真を追加」**から入る。
- 一覧を読めなくても編集と保存は動く。日記を書けることのほうが重い。

#### HEIC は投入できない

**iPhone の標準形式（HEIC）は読めない。** 変換に使っている sharp の同梱 libheif は入力が AVIF に限られ、HEVC のデコーダを含まない（ライセンス上の事情）。投入しても派生画像は作られず、ログに「画像として読めませんでした」と残る。**これは入口によらない。** ブラウザからでも、置くところまでは通って生成だけが起きない。

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

### 編集アプリケーションの手入れ

#### 画面やコードを直す

```bash
npm run deploy:editor -- staging
cd terraform/envs/staging && terraform plan   # 差分が出ないことを確認する
```

写真変換 Lambda と同じで、`terraform apply` は要らない。戻したいときは `lambroll rollback`。

実行の記録は `/aws/lambda/apkas-diary-editor-<環境>`（保持 30 日）。認証にかかわる出来事は1行1件の JSON で残る。

```bash
aws logs tail /aws/lambda/apkas-diary-editor-staging --follow --profile apkas-staging.admin \
  | grep '"tag":"auth"'
```

`event` は `granted` / `denied` / `logout` のいずれか。拒否には `reason` が付く。トークンも認可コードも記録しない。

#### 秘密を入れ替える

いずれも `terraform apply` は要らない。値を入れ替え、関数を作り直させるだけである。関数は起動時に一度だけ SSM を読むため、**入れ替えただけでは動いているインスタンスに反映されない**。

```bash
PREFIX=$(cd terraform/envs/staging && terraform output -raw editor_param_prefix)
PROFILE=apkas-staging.admin

# セッションの署名鍵。差し替えると全セッションが即座に切れる。
aws ssm put-parameter --profile "$PROFILE" --overwrite \
  --name "$PREFIX/session-key" --value "$(openssl rand -base64 32)"

# クライアントの secret を再発行したとき（Google Cloud のコンソールで作り直す）
aws ssm put-parameter --profile "$PROFILE" --overwrite \
  --name "$PREFIX/google-client-secret" --value '<新しい secret>'

# 反映させる。コードは変わらないが、これで新しいインスタンスが起動する。
npm run deploy:editor -- staging
```

許可するアカウントを変えるときも同じで、`allowed-email` を入れ替えて配り直す。**アプリケーションのコードは触らない。**

**秘密が漏れたとき**は、Google Cloud のコンソールでそのクライアントの secret を無効化するのが先である。SSM の値を書き換えても、古い secret が生きているあいだは他所から使える。もう一方の環境は別のクライアント・別の署名鍵なので、巻き込まれない。

#### 配布物について知っておくこと

`npm run deploy:editor` が作る配布物（`editor/build/`）は **linux/arm64 向け**である。Markdown プロセッサ（satteri）が native binding を持つため、手元の環境では読めない。

そのため、**配布物をそのまま手元で動かしても本文の整形だけが落ちる**。手元で動かしたいときは `npm run dev:editor` を使う（こちらは手元の `node_modules` を使うので問題ない）。配布物のほうを試したい場合は、この環境向けの binding を足す。

```bash
cp -R node_modules/@bruits/satteri-linux-x64-gnu editor/build/node_modules/@bruits/
```

ビルドは最後に、**リポジトリの外に写した配布物が単体で起動できるか**を確かめる。中で動かすと Node がひとつ上の `node_modules` まで探しにいってしまい、入れ忘れた依存が手元では拾えてしまうためである。

#### Web Adapter のレイヤーを上げる

`editor/function.jsonnet` の `Layers` に書いた ARN の版を上げ、`npm run deploy:editor -- staging` で配る。**ARN が壊れていると関数は起動の時点で落ちる**ので、staging で動作を確かめてから production に進む。

## ディレクトリ構成

```
.
├── src/
│   ├── lib/          # 日付ユーティリティ、環境変数、DynamoDB アクセス、写真の URL 規約
│   ├── export/       # Markdown 書き出し
│   ├── cli/          # エントリ登録・写真投入 CLI
│   ├── styles/       # 体裁の基準（配色・書体・寸法）と本文要素。編集アプリケーションと共有する
│   ├── layouts/      # Astro のレイアウト
│   ├── components/   # Astro のコンポーネント
│   └── pages/        # Astro のページ（ルーティング）
├── lambda/
│   └── photo-resize/ # 写真の変換。独自の package.json を持つ（sharp を隔離するため）
├── editor/           # 編集アプリケーション。Astro の SSR
│   ├── src/
│   │   ├── lib/      # 設定（SSM）・認証（セッション・Google OIDC・記録）・公開手続きの起動
│   │   ├── layouts/
│   │   ├── pages/    # 一覧・日付選択・編集・公開・ログイン、および整形だけを返す /api/preview
│   │   └── middleware.ts  # 設定の確認と認証の確認。素通りできる経路はここ以外に無い
│   ├── astro.config.ts    # ルートは repo のまま、srcDir だけ editor/src に向ける
│   ├── function.jsonnet   # lambroll が読む。値は tfstate から引く
│   └── run.sh             # Lambda での起動（Web Adapter が実行する）
├── buildspec.yml     # CodeBuild が読む。手順は持たず scripts/ を呼ぶだけ
├── scripts/          # bootstrap / build / deploy / entry / photo / lambda / editor
├── terraform/
│   ├── modules/
│   │   ├── storage/  # DynamoDB
│   │   ├── delivery/ # サイト配信。S3 + CloudFront + OAC
│   │   ├── photos/   # 写真。S3 ×2 + CloudFront + OAC + Lambda の枠
│   │   ├── editor/   # 編集。API Gateway + Lambda の枠 + SSM の入れ物
│   │   └── publish/  # 公開手続き。CodeBuild + GitHub 接続 + 実行ロール
│   └── envs/
│       ├── staging/
│       └── production/
├── export/           # 書き出された日記（コミットしない）
└── openspec/         # 仕様と変更提案
```

`lambda/` だけがルートと別の `package.json` を持つ。sharp が Linux 用の native binary を持ち、サイト生成の `npm ci` に持ち込みたくないためである。関数のコードは Terraform の管理下になく、`lambroll` が別に配る。

`editor/` はルートの `package.json` を共有する。**Astro のルートもリポジトリのルートのまま**にしてあり、`srcDir` だけを `editor/src` に向けている。こうすると `src/lib`（日付・DynamoDB アクセス・Markdown の整形）と `src/styles` を素直な相対 import で共有でき、公開サイトと編集アプリケーションで Astro や Markdown プロセッサの版がずれない。プレビューと公開結果を一致させる前提がここにある。

`buildspec.yml` は**手順を持たない**。`npm ci` のあと `scripts/build.sh` と `scripts/deploy.sh` を順に呼ぶだけである。ここに手順を書き写すと、ボタンから配ったものと手元から配ったものが食い違う余地が生まれる。したがって公開の手順を直すのはコードの変更であって、`terraform apply` は要らない（関数の中身を lambroll が持つのと同じ、インフラと中身のライフサイクルの分離）。

## 開発

```bash
npm run check          # 型チェックと Lint（editor/ と lambda/ の型検査も含む）
npm run format         # 整形と自動修正
```

**CI は CodeBuild に置かない。** 公開手続きが担うのは「`main` の内容を配る」ことだけで、型検査・Lint・テストはコードの変更に対して回すものである。両者を1つの実行に混ぜると、片方の都合でもう片方が止まる（Lint の失敗で日記が公開できない、あるいは公開のための実行環境の都合が CI の速さを縛る）。CI を置くなら GitHub Actions 側に置く。この repo にはまだ `.github/` が無く、置くのは別の change になる。

`astro check` は2回走る。1回目（ルートの設定）でリポジトリ配下の `.astro` は全部見ているが、2回目（`--config editor/astro.config.ts`）を残しているのは、**`editor/astro.config.ts` そのものの誤りが1回目では読み込まれず素通りする**ためである。

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
- **関数の存在は Terraform、中身は lambroll**。インフラと関数のコードは変わる頻度が違う。境界がここにあるのは、S3 のイベント通知（写真）と API Gateway の統合（編集）が関数の実在を要求するためで、その代償として `ignore_changes` の一覧を人が保つ必要がある（`terraform plan` で見張る）。
- **編集アプリケーションはエントリを削除できない**。画面に削除の操作が無いだけでなく、実行ロールに `DeleteItem` と `BatchWriteItem` を与えていない。画面から消すやり方だと、あとから足せてしまう。権限が無ければ、足そうとした時点で失敗する。同じ理由で、与えているのは実際に使うものだけである。エントリには `GetItem` / `PutItem` / `Scan`、写真の目録のために `Query` と `UpdateItem` が加わる。**`UpdateItem` は `PHOTO#` の下に限ってある**——エントリへの書き込みを `putEntry` の `PutItem` 1本に保ち、GSI キー属性の付け外しを飛ばした半端な更新が生まれる経路を作らないため。
- **公開を起こす権限と、配信物を書き換える権限を分けてある**。編集アプリケーションに「公開」ボタンが付いても、実行ロールに S3 と CloudFront の権限は1つも増えていない。増えたのは自環境の CodeBuild プロジェクト1つに対する `StartBuild` / `BatchGetBuilds` / `ListBuildsForProject` だけで、起こせるのは「定められた手順を、定められた入力で始めること」に限られる。何をどこへ書くかは手順の側が持つ。**このコードが乗っ取られても、配信物へ任意の内容を書き込む経路にはならない。** 削除を画面ではなく権限で塞いでいるのと同じ考え方を、配信物にも当てている。
- **公開の手順は1箇所にしかない**。`buildspec.yml` は手順を持たず、手元と同じ `scripts/build.sh` と `scripts/deploy.sh` を呼ぶ。宣言元が1つなので、ボタンから配ったものと手元から配ったものが食い違わない。設定の出どころだけが違い（`config/<環境>.env` か Terraform が渡す環境変数か）、それは `DIARY_CONFIG_SOURCE` の1つの分岐に閉じている。
- **公開の経路を1つに集約しない**。ブラウザからの公開は GitHub と CodeBuild に依存するが、手元からの `npm run build` / `npm run deploy` はそのどちらにも依存しない。日記は書き手ひとりの記録であり、公開の手段が失われたまま復旧を待つ状況を作らない。同じ理由で、書く手段も CLI とブラウザの2つある。
- **編集の前段は CloudFront ではなく API Gateway**。他の2つの配信と揃わないのは POST のためである。CloudFront の OAC が Lambda オリジンに付ける SigV4 署名は本文を署名対象に含めるが、Lambda は unsigned payload を受け付けない。そのため PUT / POST を使うには**ブラウザ側で本文の SHA-256 を計算して `x-amz-content-sha256` に載せる**ことが要求される（[AWS の文書](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)）。日記を保存するアプリケーションでその前提は置けない。
- **使っていないあいだに費用の出る構成要素を持たない**。編集アプリケーションのために増えたのは Lambda・API Gateway・ACM・SSM の Standard パラメータ、公開手続きのために増えたのは CodeBuild と接続で、いずれも時間あたりの課金がない。ALB（月 $18 程度）も EC2 の EBS も Secrets Manager（秘密1つあたり月 $0.40）も避けている。起動・停止の操作が人の手に残らないので、止め忘れという失敗の形も無い。公開手続きにビルドのキャッシュを持たせていないのも、数十秒を惜しんで保存先とその寿命の管理を増やさないためである。
- **編集アプリケーションは日記を書くための唯一の入口ではない**。Google の障害や OAuth クライアントの失効で入れなくなっても、`npm run entry` からの登録は従来どおり動く。公開サイトの配信も編集アプリケーションに依存しない。
- **公開手続きが読むのは公開分だけ、書くのは配信物だけ**。実行ロールに与えた DynamoDB の権限は GSI1 への `Query`（サイトの生成）とベーステーブルへの `Scan`（`export/` への書き出し）の2つで、**書き込みは1つも無い**。ビルドが日記を壊す経路が権限の側に存在しない。写真のバケットにも届かない。
- **プレビューと公開結果は同じコードを通る**。`src/lib/markdown.ts` の `renderMarkdown()` と `src/styles/` を両者で共有している。整形の規則も字面も出どころが1つなので、食い違う余地がない。書きながらの追随も同じ関数を叩く（`/api/preview`）。ブラウザ側に Markdown の実装を持たないのは、持った時点で「同じ整形」が実装の同一性ではなく願いになるためで、実体である satteri をブラウザで動かすには WASM を運ぶことになる。
- **体裁の基準はポートフォリオにある**。配色・書体・本文の幅・角丸は [apkas.net](https://apkas.net)（別リポジトリの `apkas`）の `src/assets/style.css` を出どころとし、`src/styles/tokens.css` はその写しを持つ。ポートフォリオから日記へ辿ったときに別のサイトに見えないことと、画面を足すたびに角丸や余白をその場で決めずに済むことの両方をここで担保している。**別リポジトリ・別配信なので CSS そのものは共有できない。** あちらの値を変えたときは、こちらも手で写し直す。
