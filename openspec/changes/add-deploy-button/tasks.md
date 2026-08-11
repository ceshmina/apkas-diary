## 1. スクリプトを2つの実行環境で共有できるようにする

手順の宣言元を1つに保つための下ごしらえ（design.md 決定2）。この章では手元の挙動を変えない。

- [ ] 1.1 `scripts/lib/load-env.sh` に、設定をファイルではなく環境変数から受け取る経路を足す。`DIARY_CONFIG_SOURCE=environment` のときは `config/<環境>.env` を読まず、環境名の検証と `DIARY_ENV` / `DIARY_EXPORT_DIR` の設定だけを行う。未指定のときの挙動は現状のままとし、**ファイルが無いことを合図にしない**（手元で `cp` を忘れただけの状態が黙って通るのを避ける）
- [ ] 1.2 `scripts/deploy.sh` から `--profile "$AWS_PROFILE"` の明示指定を外し、環境変数 `AWS_PROFILE` に委ねる。`load_env` は `.env` の内容を `set -a` で export しているので手元の挙動は変わらない。`aws sts get-caller-identity` も同じ
- [ ] 1.3 `require_env_vars AWS_PROFILE` を、ファイルから設定を読んだときだけの確認にする。`DIARY_CONFIG_SOURCE=environment` のときは実行ロールの資格情報を使うため、profile は存在しないのが正しい
- [ ] 1.4 `scripts/deploy.sh` の production 確認を、標準入力が端末なら従来どおりの対話、そうでなければ `DIARY_DEPLOY_CONFIRMED` が渡されているかで判断する形にする。**どちらも満たさない場合は中止する**（既定で通さない）
- [ ] 1.5 手元から `npm run build -- staging` と `npm run deploy -- staging` を実行し、1.1〜1.4 の前後で挙動が変わらないことを確認する。production の確認プロンプトが従来どおり出ることも確かめる

## 2. buildspec

- [ ] 2.1 リポジトリのルートに `buildspec.yml` を置く。`install` フェーズで `runtime-versions: nodejs: 22`（`.node-version` と揃える）と `npm ci`、`build` フェーズで `scripts/build.sh "$DIARY_ENV"` → `scripts/deploy.sh "$DIARY_ENV"` をこの順に並べる
- [ ] 2.2 `post_build` に配信物へ触る処理を置かない。`build` が失敗しても `post_build` は実行されるため、ここに `s3 sync` 相当のものがあると「生成に失敗した実行が配信物を書き換える」経路になる（design.md 決定8）。置くのは結果の要約だけにする
- [ ] 2.3 `build` フェーズの途中で失敗したとき、後続のコマンドが実行されないことを確認する（意図的に失敗させて確かめる。6.4 で実機確認する）

## 3. 公開手続きの Terraform モジュール

- [ ] 3.1 `terraform/modules/publish/` を作る。持つのは CodeStar Connection・source credential・CodeBuild プロジェクト・実行ロール・ロググループ
- [ ] 3.2 `aws_codestarconnections_connection`（provider type: GitHub）と `aws_codebuild_source_credential`（`auth_type = "CODECONNECTIONS"`、token に接続の ARN）を書く。**接続は `PENDING` で作られ、認可は人が行う**ことをコメントに残す（`deployment-environments` の4つ目の例外）
- [ ] 3.3 CodeBuild プロジェクトのソースを GitHub のリポジトリに向け、`buildspec.yml` を使う。`source_version` は `refs/heads/main`。実行環境は `ARM_CONTAINER` / `BUILD_GENERAL1_SMALL` / `aws/codebuild/amazonlinux-aarch64-standard:3.0`
- [ ] 3.4 `concurrent_build_limit = 1` を置く。**画面側の判定とは別に、2つの `s3 sync --delete` が重ならないことを構造で担保する**（design.md 決定6）ことをコメントに残す
- [ ] 3.5 プロジェクトの環境変数として、ビルドが読むものをすべて渡す。`DIARY_ENV` / `DIARY_CONFIG_SOURCE=environment` / `AWS_REGION` / `DIARY_TABLE_NAME` / `SITE_BUCKET` / `CLOUDFRONT_DISTRIBUTION_ID` / `SITE_URL` / `PHOTO_URL` / `DIARY_RECENT_COUNT`。`src/lib/env.ts` と `scripts/deploy.sh` が要求するものを突き合わせ、漏れがないことを確認する
- [ ] 3.6 `DIARY_RECENT_COUNT` を module の変数にし、既定を 20（`config/*.env.example` と同じ）にする。**この値は現状 `config/<環境>.env` にしか無く、放っておくと手元とクラウドで別の値になりうる**。同じ生成物が出ることの前提が崩れる場所なので、既定が食い違っていないことを確認する
- [ ] 3.7 実行ロールの権限を書く。DynamoDB は `Query`（base table と GSI1）と `Scan` のみで**書き込みを与えない**。S3 は自環境の配信元バケットへの `PutObject` / `DeleteObject` / `ListBucket`（`sync --delete` に要る）。CloudFront は自環境のディストリビューションへの `CreateInvalidation`。ログは自分のロググループのみ。**写真のバケットには触れない**
- [ ] 3.8 ロググループを Terraform で作り、保持を 30 日にする（写真変換 Lambda・編集アプリケーションと揃える）。プロジェクトのログ設定をそのグループに向ける
- [ ] 3.9 output に `project_name`・`project_arn`・`connection_arn` を出す。`project_arn` は編集アプリケーションの権限に、`connection_arn` は承認状態の確認に使う
- [ ] 3.10 `terraform/envs/staging/main.tf` と `terraform/envs/production/main.tf` から module を呼ぶ。バケット・ディストリビューション ID・テーブル名・写真の URL は既存の module の出力をそのまま渡す（`config` への転記を増やさない）
- [ ] 3.11 `terraform/envs/*/outputs.tf` に `publish_project_name` を足す。転記はしない（`function.jsonnet` が state から読む）

## 4. 編集アプリケーションの権限と設定

- [ ] 4.1 `terraform/modules/editor/` に公開手続きのプロジェクト ARN を受け取る変数を足し、IAM ポリシーに `codebuild:StartBuild` / `codebuild:BatchGetBuilds` / `codebuild:ListBuildsForProject` を**そのプロジェクト1つに限って**足す。3つとも project ARN で資源指定できる
- [ ] 4.2 ポリシーの末尾にある「S3 と CloudFront への権限は与えない」のコメントを更新する。**起動する権限と配信物を書き換える権限は別物である**ことを、次に読む人が分かる形で残す（design.md 決定4）
- [ ] 4.3 `editor/function.jsonnet` に `PUBLISH_PROJECT_NAME` を足し、tfstate の出力から読む
- [ ] 4.4 `scripts/dev-editor.sh` にも同じ環境変数を渡す。手元で画面を直すときに、この経路だけ動かないという状態を作らない

## 5. 編集アプリケーションの画面と経路

- [ ] 5.1 `@aws-sdk/client-codebuild` をルートの `package.json` に足す
- [ ] 5.2 `editor/src/lib/publish.ts` を書く。最新のビルドを引く関数（`ListBuildsForProject` の先頭を `BatchGetBuilds`）と、起動する関数（`StartBuild`）の2つ。**ビルド ID をどこにも保存しない**（design.md 決定5）
- [ ] 5.3 起動する関数は、production のとき `DIARY_DEPLOY_CONFIRMED` を環境変数の override として渡す。これは多層防御であって権限境界ではないことをコメントに残す
- [ ] 5.4 `/publish` の GET を書く。最新のビルドの状態（進行中・成功・失敗）、開始時刻、**実行に使われた commit（`resolvedSourceVersion`）**を表示する。一度も実行されていない場合の表示も用意する
- [ ] 5.5 `/publish` の POST を書く。起動の前に最新のビルドを見て、**進行中なら新たに起動せず**その旨を返す。成功したら 303 で GET へ送る（再読み込みで二重に起動しないように、既存の保存と同じ形にする）
- [ ] 5.6 production では、押しただけでは始まらない一段を挟む。確認を経ていない POST は起動しない
- [ ] 5.7 進行中のあいだ、画面が定期的に更新されるようにする。数分に一度しか押されない操作なので、常時接続の仕組みは持ち込まない
- [ ] 5.8 一覧画面（`editor/src/pages/index.astro`）から `/publish` への導線を置く。公開状態のエントリが最後の反映より後に更新されているかは判定しない（判定の根拠を持たないまま「未反映」と示すと嘘になる）
- [ ] 5.9 `/publish` を `middleware.ts` の `PUBLIC_PATHS` に**足さない**ことを確認する。未認証の POST が 401 で止まることを確かめる
- [ ] 5.10 `npm run check` が通ることを確認する

## 6. staging での確認

- [ ] 6.1 `cd terraform/envs/staging && terraform apply`。接続が `PENDING` で作られることを確認する
- [ ] 6.2 AWS コンソールで GitHub 接続を承認し、状態が `AVAILABLE` になることを確認する
- [ ] 6.3 承認前の状態でビルドを起動し、**ソースの取得で失敗する**ことを確認する（`deployment-environments` の「未認可の接続」のシナリオ）
- [ ] 6.4 `npm run deploy:editor -- staging` のあと、ボタンからビルドを起動して成功することを確認する。**手元から `npm run build -- staging && npm run deploy -- staging` した生成物と、ボタンから配られた生成物が一致すること**を確かめる（`site-publishing` の「異なる場所からの起動」）
- [ ] 6.5 実行中に再度押し、2つ目が起動しないことを確認する
- [ ] 6.6 生成が失敗する状態を作って起動し、配信中の内容が変化しないことを確認する
- [ ] 6.7 未認証の状態で `/publish` に POST し、401 で止まることを確認する
- [ ] 6.8 編集アプリケーションの実行ロールを引き受けて、配信元バケットへの書き込みと CloudFront の invalidate が**拒否される**ことを確認する（`editor-hosting` の「配信物への直接の到達」）
- [ ] 6.9 CodeBuild の実行ロールを引き受けて、DynamoDB への書き込みが拒否されること、写真のバケットに到達できないことを確認する
- [ ] 6.10 `terraform plan` が差分を出さないことを確認する
- [ ] 6.11 ビルドの所要時間と、1回あたりのおおよその費用を記録する（README に書く値）

## 7. production への展開

- [ ] 7.1 `cd terraform/envs/production && terraform apply`
- [ ] 7.2 GitHub 接続を承認する（staging とは別の接続）
- [ ] 7.3 `npm run deploy:editor -- production`
- [ ] 7.4 production の画面で、確認を経ないと起動しないことを確認する。取り消したときに何も起きないことも確かめる
- [ ] 7.5 コンソールから `DIARY_DEPLOY_CONFIRMED` を渡さずに `StartBuild` し、deploy の段に進まないことを確認する
- [ ] 7.6 確認を経て起動し、production のサイトが更新されることを確認する。staging のサイトが変化していないことも確かめる
- [ ] 7.7 `terraform plan` が差分を出さないことを確認する

## 8. 文書

- [ ] 8.1 README の冒頭の構成図に公開手続きを描き足す。「編集アプリケーションの責務は DynamoDB への書き込みまで」「公開サイトへの反映は手元の `npm run build` / `npm run deploy` で行う」の記述を書き換える
- [ ] 8.2 初期セットアップに「GitHub 接続の承認」の手順を足す。環境ごとに1度だけであること、承認しないとボタンからは配れないことを書く
- [ ] 8.3 日々の運用に、ブラウザからの公開の手順を足す。**手元の未コミットの変更は配られない**こと、所要時間、1回あたりの費用、production では確認を求められることを書く
- [ ] 8.4 ローカルからの `npm run build` / `npm run deploy` が引き続き使えること、GitHub が使えないときの手段であることを書く
- [ ] 8.5 「設計上の要点」に、起動する権限と配信物を書き換える権限を分けていることを足す。既存の「編集アプリケーションはエントリを削除できない」と同じ考え方であることに触れる
- [ ] 8.6 ディレクトリ構成に `terraform/modules/publish/` と `buildspec.yml` を足す
- [ ] 8.7 CI（型検査・Lint）を GitHub Actions 側に置く方針を README に一言残す。この change では作らないが、CodeBuild を CI に使わない理由が後から分かるようにする
