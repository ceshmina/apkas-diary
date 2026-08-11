## 1. スクリプトを2つの実行環境で共有できるようにする

手順の宣言元を1つに保つための下ごしらえ（design.md 決定2）。この章では手元の挙動を変えない。

- [x] 1.1 `scripts/lib/load-env.sh` に、設定をファイルではなく環境変数から受け取る経路を足す。`DIARY_CONFIG_SOURCE=environment` のときは `config/<環境>.env` を読まず、環境名の検証と `DIARY_ENV` / `DIARY_EXPORT_DIR` の設定だけを行う。未指定のときの挙動は現状のままとし、**ファイルが無いことを合図にしない**（手元で `cp` を忘れただけの状態が黙って通るのを避ける）
  - `DIARY_CONFIG_SOURCE` は `file`（既定）と `environment` の2値。知らない値は起動時に弾く。正規化した値を export するので、以降のスクリプトは分岐をこの1つの変数だけで書ける。
  - **environment のときは `DIARY_ENV` と引数の食い違いを見る**ようにした。設定を渡す側（CodeBuild のプロジェクト定義）と呼ぶ側（buildspec）は別のファイルにあり、片方だけ書き換わりうる。「別の環境の設定で別の環境に配る」はここでしか止められない。
- [x] 1.2 `scripts/deploy.sh` から `--profile "$AWS_PROFILE"` の明示指定を外し、環境変数 `AWS_PROFILE` に委ねる。`load_env` は `.env` の内容を `set -a` で export しているので手元の挙動は変わらない。`aws sts get-caller-identity` も同じ
  - 3箇所（`sts get-caller-identity` / `s3 sync` / `cloudfront create-invalidation`）すべてから外した。対象の表示は `profile : （実行ロール）` に落ちるようにして、どちらの資格情報で動いているかが目で分かる状態は保った。
- [x] 1.3 `require_env_vars AWS_PROFILE` を、ファイルから設定を読んだときだけの確認にする。`DIARY_CONFIG_SOURCE=environment` のときは実行ロールの資格情報を使うため、profile は存在しないのが正しい
  - `require_env_vars` の失敗メッセージも出どころで変えた。environment のときに「`config/staging.env` に転記してください」と言うのは嘘になる。
- [x] 1.4 `scripts/deploy.sh` の production 確認を、標準入力が端末なら従来どおりの対話、そうでなければ `DIARY_DEPLOY_CONFIRMED` が渡されているかで判断する形にする。**どちらも満たさない場合は中止する**（既定で通さない）
  - これが多層防御であって権限境界ではないこと（`StartBuild` を持つ主体は変数も渡せる）をコメントに残した。
- [x] 1.5 手元から `npm run build -- staging` と `npm run deploy -- staging` を実行し、1.1〜1.4 の前後で挙動が変わらないことを確認する。production の確認プロンプトが従来どおり出ることも確かめる
  - `aws` と `npx` を差し替えた状態で、`load_env` 7通り・`deploy.sh` 7通りを確認した。file mode の staging は `DIARY_ENV` / `AWS_PROFILE` / `DIARY_TABLE_NAME` / `DIARY_EXPORT_DIR` とも従来と同じ値になり、`--profile` が渡らないこと、呼ばれる aws のコマンドが3つのままであることを確かめた。
  - production は、端末ありで `n` → 中止（同期に到達しない）、`y` → 従来どおり実行。端末なしで確認なし → 中止、`DIARY_DEPLOY_CONFIRMED=yes` → 実行。4通りとも意図どおり。
  - 端末ありの確認には pty が要る。macOS の `script` は stdin を即座に閉じるため、そのままだと `read` が EOF になって「`n` と答えた」のと区別が付かない。入力を遅らせて確かめた（テスト側の都合であって、スクリプトの挙動ではない）。

## 2. buildspec

- [x] 2.1 リポジトリのルートに `buildspec.yml` を置く。`install` フェーズで `runtime-versions: nodejs: 22`（`.node-version` と揃える）と `npm ci`、`build` フェーズで `scripts/build.sh "$DIARY_ENV"` → `scripts/deploy.sh "$DIARY_ENV"` をこの順に並べる
  - `env: shell: bash` を明示した。buildspec version 0.2 は全コマンドを同じシェルの実体で走らせるので、`$DIARY_ENV` が2つのコマンドをまたいで効く。
  - `scripts/*.sh` は git 上で 100755 なので、`bash` を前置せずそのまま呼べる。
  - 使われた commit を `install` の最初に出す。ログだけを見ている状態でも、何を配ったかが分かる。
- [x] 2.2 `post_build` に配信物へ触る処理を置かない。`build` が失敗しても `post_build` は実行されるため、ここに `s3 sync` 相当のものがあると「生成に失敗した実行が配信物を書き換える」経路になる（design.md 決定8）。置くのは結果の要約だけにする
  - `CODEBUILD_BUILD_SUCCEEDING` を見て成否を1行出すだけにした。理由をコメントに残してある。
- [x] 2.3 `build` フェーズの途中で失敗したとき、後続のコマンドが実行されないことを確認する（意図的に失敗させて確かめる。6.4 で実機確認する）
  - [buildspec の文書](https://docs.aws.amazon.com/codebuild/latest/userguide/build-spec-ref.html)の `finally` の説明が明示している。「`commands` に3つあって最初が失敗した場合、CodeBuild は**残りの2つを飛ばして** `finally` を実行する」。したがって `build.sh` が失敗した実行は `deploy.sh` に到達しない。
  - YAML として読めることを `yaml` パーサで確認した（フェーズ・コマンドの並びが意図どおりに解釈される）。実機での確認は 6.6。

## 3. 公開手続きの Terraform モジュール

- [x] 3.1 `terraform/modules/publish/` を作る。持つのは CodeStar Connection・source credential・CodeBuild プロジェクト・実行ロール・ロググループ
  - `versions.tf` / `variables.tf` / `main.tf` / `outputs.tf` の4つ。us-east-1 のプロバイダは受け取らない（証明書もディストリビューションも持たないため）。
- [x] 3.2 `aws_codestarconnections_connection`（provider type: GitHub）と `aws_codebuild_source_credential`（`auth_type = "CODECONNECTIONS"`、token に接続の ARN）を書く。**接続は `PENDING` で作られ、認可は人が行う**ことをコメントに残す（`deployment-environments` の4つ目の例外）
  - **source credential はアカウント・リージョン・server_type につき1つしか持てない。** staging と production はアカウントが分かれているので、それぞれが自分の接続を1つ持つ形に収まる。同居させる構成は採れないことをコメントに残した。
  - `depends_on` で資格情報の登録をプロジェクトより先にした。逆順だとソースの検証に失敗する。
- [x] 3.3 CodeBuild プロジェクトのソースを GitHub のリポジトリに向け、`buildspec.yml` を使う。`source_version` は `refs/heads/main`。実行環境は `ARM_CONTAINER` / `BUILD_GENERAL1_SMALL` / `aws/codebuild/amazonlinux-aarch64-standard:3.0`
  - `git_clone_depth = 1`。履歴は読まない。使われた commit は `CODEBUILD_RESOLVED_SOURCE_VERSION` から分かる。
  - `artifacts` は `NO_ARTIFACTS`、`cache` は `NO_CACHE`。生成物は deploy.sh が S3 へ直接同期するので、同じものを2箇所に置かない。
  - `queued_timeout` を 15 分にした。既定の 480 分だと、同時実行の上限に当たって積まれた1件が何時間も後に動きうる。
- [x] 3.4 `concurrent_build_limit = 1` を置く。**画面側の判定とは別に、2つの `s3 sync --delete` が重ならないことを構造で担保する**（design.md 決定6）ことをコメントに残す
- [x] 3.5 プロジェクトの環境変数として、ビルドが読むものをすべて渡す。`DIARY_ENV` / `DIARY_CONFIG_SOURCE=environment` / `AWS_REGION` / `DIARY_TABLE_NAME` / `SITE_BUCKET` / `CLOUDFRONT_DISTRIBUTION_ID` / `SITE_URL` / `PHOTO_URL` / `DIARY_RECENT_COUNT`。`src/lib/env.ts` と `scripts/deploy.sh` が要求するものを突き合わせ、漏れがないことを確認する
  - 突き合わせた結果、**`PHOTO_UPLOAD_BUCKET` と `PHOTO_BUCKET` は渡さないのが正しい**。`src/lib/env.ts` の `required()` は呼ばれたときにだけ落ちる遅延評価で、この2つを読むのは写真を投入する CLI だけである。サイトの生成が使うのは `PHOTO_URL`（URL の規約）まで。渡さなければ、公開手続きから写真の置き場所に触れる余地がそもそも無い。
  - `AWS_PROFILE` も渡さない。資格情報は実行ロールから来る。
- [x] 3.6 `DIARY_RECENT_COUNT` を module の変数にし、既定を 20（`config/*.env.example` と同じ）にする。**この値は現状 `config/<環境>.env` にしか無く、放っておくと手元とクラウドで別の値になりうる**。同じ生成物が出ることの前提が崩れる場所なので、既定が食い違っていないことを確認する
  - `config/staging.env.example` / `config/production.env.example` とも 20 で、既定と一致している。片方だけ変えると生成物が変わることを variables.tf の description に書いた。
- [x] 3.7 実行ロールの権限を書く。DynamoDB は `Query`（base table と GSI1）と `Scan` のみで**書き込みを与えない**。S3 は自環境の配信元バケットへの `PutObject` / `DeleteObject` / `ListBucket`（`sync --delete` に要る）。CloudFront は自環境のディストリビューションへの `CreateInvalidation`。ログは自分のロググループのみ。**写真のバケットには触れない**
  - コードを読んだ結果、**`Query` はベーステーブルに要らない**と分かった。サイトの生成が読むのは `listAllPublished()`（GSI1 の Query）だけで、ベーステーブルを引くのは `scanAllIncludingDrafts()`（export の Scan）のみ。`Query` を索引の ARN 1つに限れる。
  - `GetObject` も与えなかった。`aws s3 sync` は宛先の一覧（大きさと更新時刻）で比較しており、中身を読まない。使っていない権限を「念のため」で置かない（editor モジュールと同じ方針）。もし sync が要求するようなら 6.4 で失敗して分かる。
  - 接続を使う権限は、`codestar-connections:` と `codeconnections:` の**両方の接頭辞**を同じ ARN に対して並べた。AWS が改名の途中にあり、接頭辞は資源の ARN 側と一致しないと効かない。一致しないほうは何にも当たらずに終わる。
- [x] 3.8 ロググループを Terraform で作り、保持を 30 日にする（写真変換 Lambda・編集アプリケーションと揃える）。プロジェクトのログ設定をそのグループに向ける
  - `stream_name` は指定しない。ビルドごとに別のストリームになり、実行を取り違えずに読める。
- [x] 3.9 output に `project_name`・`project_arn`・`connection_arn` を出す。`project_arn` は編集アプリケーションの権限に、`connection_arn` は承認状態の確認に使う
  - `connection_status` と `role_arn` と `log_group_name` も出した。前者は「認可がまだ」を `terraform output` だけで判別できるようにするため、`role_arn` は 6.9 の権限確認で引き受ける先。
- [x] 3.10 `terraform/envs/staging/main.tf` と `terraform/envs/production/main.tf` から module を呼ぶ。バケット・ディストリビューション ID・テーブル名・写真の URL は既存の module の出力をそのまま渡す（`config` への転記を増やさない）
  - `repository_url` は両環境で同じ値になるが、既定値を持たせず root から渡す形にした。どの環境が何を配っているかを root だけ読んで確かめられる状態を保つため。
- [x] 3.11 `terraform/envs/*/outputs.tf` に `publish_project_name` を足す。転記はしない（`function.jsonnet` が state から読む）
  - 併せて `publish_connection_arn` / `publish_connection_status` / `publish_role_arn` も出した。
  - `terraform fmt -recursive` と、backend を外した複製での `terraform validate` を staging・production の両方で通した（**Success**）。実際の `plan` は資格情報が要るので 6.1。

## 4. 編集アプリケーションの権限と設定

- [x] 4.1 `terraform/modules/editor/` に公開手続きのプロジェクト ARN を受け取る変数を足し、IAM ポリシーに `codebuild:StartBuild` / `codebuild:BatchGetBuilds` / `codebuild:ListBuildsForProject` を**そのプロジェクト1つに限って**足す。3つとも project ARN で資源指定できる
  - `publish_project_arn` の1つだけを受け取る形にした。プロジェクト**名**は module に渡していない。名前は環境名から決まる規則（`apkas-diary-publish-<環境>`）で、Lambda では `function.jsonnet` が state の output から、手元では `dev-editor.sh` が環境名から決める。既に `EDITOR_PARAM_PREFIX` がそうなっており、転記を増やさない形に揃えた。
- [x] 4.2 ポリシーの末尾にある「S3 と CloudFront への権限は与えない」のコメントを更新する。**起動する権限と配信物を書き換える権限は別物である**ことを、次に読む人が分かる形で残す（design.md 決定4）
  - 「このコードが乗っ取られても、配信物へ任意の内容を書き込む経路にはならない」まで書いた。削除の操作を画面ではなく権限で塞いでいるのと同じ考え方であることにも触れてある。
- [x] 4.3 `editor/function.jsonnet` に `PUBLISH_PROJECT_NAME` を足し、tfstate の出力から読む
  - 名前と権限の出どころが同じ state にあるので、片方だけずれた状態は作れない。仮にここが別の環境を指しても、実行ロールが起動を許されているのは自環境の1つだけなので、その先で権限に阻まれる。
- [x] 4.4 `scripts/dev-editor.sh` にも同じ環境変数を渡す。手元で画面を直すときに、この経路だけ動かないという状態を作らない
  - **手元でも本物のプロジェクトを指す**（手元用の別の実行環境は持たない）。押せば実際にビルドが走るので staging で試すこと、と起動時の表示とコメントに書いた。
  - 起動時の一覧に「公開手続き」の行を足した。どのプロジェクトを叩く状態で立ち上がっているかが目で分かる。
  - backend を外した複製で `terraform validate` を再度通した（staging・production とも Success）。

## 5. 編集アプリケーションの画面と経路

- [x] 5.1 `@aws-sdk/client-codebuild` をルートの `package.json` に足す
- [x] 5.2 `editor/src/lib/publish.ts` を書く。最新のビルドを引く関数（`ListBuildsForProject` の先頭を `BatchGetBuilds`）と、起動する関数（`StartBuild`）の2つ。**ビルド ID をどこにも保存しない**（design.md 決定5）
  - CodeBuild の6つの状態を画面向けに4つ（進行中・成功・失敗・中止）へ畳んだ。`FAILED` / `FAULT` / `TIMED_OUT` はどれも「失敗した、原因はログにある」で、区別しても次にすることは変わらない。生の値は `rawStatus` に残してある。
  - **知らない状態は「失敗」に寄せた。** 配られていないものを配られたと表示するほうが、余分に失敗と言うより害が大きい。
  - 設定は `EditorConfig` に足した（`environment` と `publishProjectName`）。`PUBLISH_PROJECT_NAME` や `DIARY_ENV` が欠けていれば**起動時に**落ちる。ボタンを押した瞬間に初めて分かる形にしない。
  - `DIARY_ENV` に知らない値が来たら弾く。綴りを間違えた値が「production ではない」と解釈されると、確認なしで本番に配れてしまう。
- [x] 5.3 起動する関数は、production のとき `DIARY_DEPLOY_CONFIRMED` を環境変数の override として渡す。これは多層防御であって権限境界ではないことをコメントに残す
- [x] 5.4 `/publish` の GET を書く。最新のビルドの状態（進行中・成功・失敗）、開始時刻、**実行に使われた commit（`resolvedSourceVersion`）**を表示する。一度も実行されていない場合の表示も用意する
  - 時刻は `Asia/Tokyo` を明示して整形する。実行環境のタイムゾーンは UTC なので、明示しないと書いた人の感覚とずれた時刻が出る。
  - 状況が読めなかった場合は、その旨を出す。**「読めない」を「実行されていない」と見せない。**
  - 失敗のときは CloudWatch Logs へのリンク（`logs.deepLink`）を出す。これが `site-publishing` の「原因を辿るための手がかり」にあたる。
- [x] 5.5 `/publish` の POST を書く。起動の前に最新のビルドを見て、**進行中なら新たに起動せず**その旨を返す。成功したら 303 で GET へ送る（再読み込みで二重に起動しないように、既存の保存と同じ形にする）
- [x] 5.6 production では、押しただけでは始まらない一段を挟む。確認を経ていない POST は起動しない
  - staging はボタンが `action=start`、production は `action=confirm` を送る。確認の画面から送られる `confirmed=yes` が無い `start` は、起動せず確認へ戻す。
- [x] 5.7 進行中のあいだ、画面が定期的に更新されるようにする。数分に一度しか押されない操作なので、常時接続の仕組みは持ち込まない
  - `Base.astro` に `refreshSeconds` を足し、`<meta http-equiv="refresh">` を出す形にした。JavaScript は増やしていない（この編集アプリケーションはこれまでフォームだけで出来ている）。
  - **起動した直後も5秒だけ読み直す。** 一覧に新しい実行が現れるまでに少し間があり、その間は直前の実行が最新として返る。放っておくと古い結果が出たままになる。
  - 終わった状態を表示しているあいだは読み直さない。
- [x] 5.8 一覧画面（`editor/src/pages/index.astro`）から `/publish` への導線を置く。公開状態のエントリが最後の反映より後に更新されているかは判定しない（判定の根拠を持たないまま「未反映」と示すと嘘になる）
- [x] 5.9 `/publish` を `middleware.ts` の `PUBLIC_PATHS` に**足さない**ことを確認する。未認証の POST が 401 で止まることを確かめる
  - 足していない。未認証の GET は `/login?redirect=%2Fpublish` へ 302、POST は 401「認証が必要です。」を確認した。
  - **その手前にもう一段あった。** Astro の CSRF 判定（`checkOrigin`）が middleware より先に働き、`Origin` の付かない・別オリジンからの POST は 403「Cross-site POST form submissions are forbidden」で止まる。401 が見えるのは同一オリジンからの未認証 POST に限られる。
- [x] 5.10 `npm run check` が通ることを確認する
  - `astro check` ×2（45 ファイル、0 errors / 0 warnings / 0 hints）、`biome check`（52 ファイル）、`check-lambda.sh` すべて通過。
  - 併せて、**SSM と CodeBuild の代役を立てて画面を実際に動かした**（AWS には接続していない）。確認したのは次の 14 通り。
    - 未認証: GET → `/login` へ 302、POST → 401、別オリジンの POST → 403
    - staging: 実行なし → 「まだ一度も実行されていない」／成功 → バッジ・commit の短縮表示・ログへのリンク／進行中 → バッジ・現在の段（BUILD）・`content="5"` の再読み込み・ボタンが `disabled`／失敗 → バッジ・`TIMED_OUT`・「配信物に届いていない」の注記
    - 起動: 進行中に押す → **StartBuild は呼ばれず** `?busy=1` へ 303／そうでなければ `?started=1` へ 303 し、`{projectName}` だけで呼ばれる（staging に override は付かない）
    - production: ボタンの submit 値が `confirm` になる／`action=confirm` → 確認の画面、StartBuild は呼ばれない／`confirmed` 無しの `start` → 確認へ戻り、StartBuild は呼ばれない／`confirmed=yes` → `environmentVariablesOverride` に `DIARY_DEPLOY_CONFIRMED=yes` を載せて呼ばれる

## 6. staging での確認

**この章の途中で判明した順序の制約**: CodeBuild は GitHub から clone するため、`buildspec.yml` と改修した `scripts/` が**共有された版に載るまで実機確認ができない**。これは `site-publishing` の「共有された版に由来する」がそのまま効いた結果である。ブランチを push し、`start-build --source-version <ブランチ>` で検証した（**Terraform の設定は変えていない**。プロジェクトの既定は `main` のまま）。

- [x] 6.1 `cd terraform/envs/staging && terraform apply`。接続が `PENDING` で作られることを確認する
  - **6 added / 1 changed / 0 destroyed。** 追加は publish の6つ、変更は `module.editor.aws_iam_role_policy.editor` の in-place のみ。破壊も再作成も無い。
  - `publish_connection_status = "PENDING"` を確認。
- [x] 6.2 AWS コンソールで GitHub 接続を承認し、状態が `AVAILABLE` になることを確認する
  - **この確認が設計の欠陥を1つ炙り出した。** 承認後に `terraform plan` を打つと `publish_connection_status = "PENDING" -> "AVAILABLE"` の差分が出た。認可は Terraform の外で行われるので、状態を output に置くと**差分が出続ける**。このリポジトリは「plan が差分を出さないこと」を lambroll の設定が黙って戻されていないかの唯一の検出手段にしており、常に差分が出る状態はその信号を潰す。**output から外し**、状態は `aws codestar-connections get-connection` で見る形に直した（README も同様に修正）。
- [x] 6.3 承認前の状態でビルドを起動し、**ソースの取得で失敗する**ことを確認する（`deployment-environments` の「未認可の接続」のシナリオ）
  - **順序を入れ替えて 6.2 の前に実施した。** 承認してしまうと二度と確認できない。
  - `DOWNLOAD_SOURCE` で FAILED。メッセージは `Connection apkas-diary-staging is not available`。生成にも反映にも到達していない。
  - 副次的に、接続を使う IAM 権限が効いていることも分かった（「権限が無い」ではなく「接続が使えない」で止まっている）。
- [x] 6.4 `npm run deploy:editor -- staging` のあと、ボタンからビルドを起動して成功することを確認する。**手元から `npm run build -- staging && npm run deploy -- staging` した生成物と、ボタンから配られた生成物が一致すること**を確かめる（`site-publishing` の「異なる場所からの起動」）
  - ビルド成功。フェーズ内訳は PROVISIONING 3 秒 / DOWNLOAD_SOURCE 51 秒 / INSTALL 6 秒 / BUILD 15 秒。
  - **生成物は 409 ファイルすべて、パスも内容の MD5 も完全に一致した。** 手元の `dist/` と S3 上のオブジェクトの ETag を突き合わせて確認（`src/` は `main` と差分が無いため、手元のビルドは `main` のビルドと同じ入力になる）。
  - 編集アプリケーションの経路も実機で確認した。SSM の署名鍵から 15 分で失効する検証用セッションを作り、配備済みの `https://admin.dev.apkas.net/publish` を叩いた。**画面に出た commit は実際にビルドしたブランチ HEAD と一致**し、時刻も JST で正しく出た。
  - **`s3:GetObject` は要らなかった。** 与えていない状態で `aws s3 sync --delete` が通っている。3.7 の判断（使っていない権限を置かない）が正しかったことが実測で確かめられた。
  - **Lambda からの `StartBuild` も実機で通した。** 実行中でない状態でボタンを押すと 303 で `?started=1` へ進み、プロジェクトのビルドが1件増える。そのビルドは `main`（`15f1dc9`）を解決し、`DOWNLOAD_SOURCE` で `YAML file does not exist` として失敗した。**`main` にまだ `buildspec.yml` が無いためで、経路そのものは通っている。** マージ後は同じ操作がそのまま成功する（生成物が一致することは、同じ内容を `--source-version` で走らせて確認済み）。
- [x] 6.5 実行中に再度押し、2つ目が起動しないことを確認する
  - 実行中にボタンを3回押し、3回とも `?busy=1` へ 303。**プロジェクトのビルド総数は1つも増えていない**（押す前後で 2→3 は、この検証のために CLI から起動した1件のみ）。画面には「すでに実行中だった。」「終わるまで押せない。」が出て、ボタンは `disabled`。
- [x] 6.6 生成が失敗する状態を作って起動し、配信中の内容が変化しないことを確認する
  - 存在しないモジュールを import するページを持つ一時ブランチを作って push し、それをビルドした。
  - **`BUILD` フェーズの `scripts/build.sh` で FAILED。** 同じフェーズの次のコマンドである `scripts/deploy.sh` は実行されていない（2.3 で文書から確認した挙動が実機でも成立した）。
  - **配信物 409 ファイルは1つも変化しなかった。** 画面にも「失敗した実行は配信物に届いていない」が出る。
  - 検証用ブランチは remote・local とも削除済み。
- [x] 6.7 未認証の状態で `/publish` に POST し、401 で止まることを確認する
  - 配備済みの staging で確認。`Origin` なしの POST は 403（Astro の CSRF 判定）、`Origin` ありの未認証 POST は 401「認証が必要です。」、GET は `/login?redirect=%2Fpublish` へ 302。
- [x] 6.8 編集アプリケーションの実行ロールを引き受けて、配信元バケットへの書き込みと CloudFront の invalidate が**拒否される**ことを確認する（`editor-hosting` の「配信物への直接の到達」）
  - **ロールを引き受ける代わりに `iam simulate-principal-policy` を使った。** editor の実行ロールは `lambda.amazonaws.com` しか信頼しないので人からは引き受けられず、また実際に書き込みを試すと成功した場合に配信物が壊れる。シミュレーションなら副作用なしに、資源ごとの判定を正確に読める。
  - 許可: 自環境の公開手続きへの `StartBuild` / `BatchGetBuilds` / `ListBuildsForProject`、日記への `PutItem`。
  - 拒否（すべて `implicitDeny`）: サイト配信元への `PutObject` / `DeleteObject`、写真バケットへの `PutObject` / `GetObject`、CloudFront の `CreateInvalidation`、**production の公開手続きへの `StartBuild`**、日記の `DeleteItem`。
- [x] 6.9 CodeBuild の実行ロールを引き受けて、DynamoDB への書き込みが拒否されること、写真のバケットに到達できないことを確認する
  - 許可: GSI1 への `Query`、ベーステーブルへの `Scan`、サイト配信元への `PutObject` / `DeleteObject` / `ListBucket`、サイトの CDN への `CreateInvalidation`。
  - 拒否: 日記への `PutItem` / `UpdateItem` / `DeleteItem` / `BatchWriteItem`（**書き込みは1つも無い**）、ベーステーブルへの `Query`（索引しか要らない）、サイト配信元への `GetObject`、写真バケットの読み書き、写真の CDN への `CreateInvalidation`。
- [x] 6.10 `terraform plan` が差分を出さないことを確認する
  - 6.2 で見つかった output を外したあと、**No changes. Your infrastructure matches the configuration.**
- [x] 6.11 ビルドの所要時間と、1回あたりのおおよその費用を記録する（README に書く値）
  - **実測 48〜79 秒**（成功 2 件、平均 63 秒）。design.md の見込みは「2〜3 分」だったので、実際はその半分以下。
  - **時間の半分以上は GitHub からのソース取得**（51 秒）で、サイトの生成そのものは 15 秒、`npm ci` は 6 秒。速くしたいならキャッシュではなくソース取得を見る場所だと分かった。
  - 費用は課金が分単位切り上げで1回1〜2分。**`arm1.small` には月 100 分の無料枠**があり、1日数回の公開なら収まる。超過分も分あたり $0.005 未満（Tokyo の `general1.small` が $0.005/分、arm はそれ以下）。README を実測値に置き換えた。

## 7. production への展開

- [ ] 7.1 `cd terraform/envs/production && terraform apply`
- [ ] 7.2 GitHub 接続を承認する（staging とは別の接続）
- [ ] 7.3 `npm run deploy:editor -- production`
- [ ] 7.4 production の画面で、確認を経ないと起動しないことを確認する。取り消したときに何も起きないことも確かめる
- [ ] 7.5 コンソールから `DIARY_DEPLOY_CONFIRMED` を渡さずに `StartBuild` し、deploy の段に進まないことを確認する
- [ ] 7.6 確認を経て起動し、production のサイトが更新されることを確認する。staging のサイトが変化していないことも確かめる
- [ ] 7.7 `terraform plan` が差分を出さないことを確認する

## 8. 文書

- [x] 8.1 README の冒頭の構成図に公開手続きを描き足す。「編集アプリケーションの責務は DynamoDB への書き込みまで」「公開サイトへの反映は手元の `npm run build` / `npm run deploy` で行う」の記述を書き換える
  - 図の【ビルド】に「これを走らせる場所が2つある。どちらも同じ scripts/ を通る」を足した。冒頭の一文も「ローカルでビルドした静的サイト」から実行場所を限定しない書き方に直した。
  - 責務の記述は「書き込むのは DynamoDB まで**で、配信物には触れない**」に置き換えた。ボタンが付いても権限が増えていないことが、最初の段落で分かるようにしてある。
- [x] 8.2 初期セットアップに「GitHub 接続の承認」の手順を足す。環境ごとに1度だけであること、承認しないとボタンからは配れないことを書く
  - **手順 10 として末尾に置いた。** 5（インフラの作成）の直後が論理的だが、そこに挟むと 6〜9 の番号がずれ、5 の本文にある「実装を載せるのは次の手順」が指す先も変わる。6〜9 は接続に依存しないので、末尾で困らない。
  - 状態の確認は `terraform output publish_connection_status` でできるようにしてある（PENDING / AVAILABLE）。
- [x] 8.3 日々の運用に、ブラウザからの公開の手順を足す。**手元の未コミットの変更は配られない**こと、所要時間、1回あたりの費用、production では確認を求められることを書く
  - 「ブラウザから書く」の下に「ブラウザから公開する」を足した。実行中は押せないこと、失敗した実行は配信物に届いていないことも書いてある。
  - 所要時間（2〜3分）と費用（$0.01 程度）は**見込みの値**で書いた。実測は 6.11 で置き換える。
- [x] 8.4 ローカルからの `npm run build` / `npm run deploy` が引き続き使えること、GitHub が使えないときの手段であることを書く
  - 節の見出しを「ビルドとデプロイ」から「手元からビルドとデプロイ」に変えた。2つある経路のうちの1つだと分かる。
  - 手元からは**コミットしていない変更もそのまま配られる**という違いも書いた。使い分けの基準になる。
- [x] 8.5 「設計上の要点」に、起動する権限と配信物を書き換える権限を分けていることを足す。既存の「編集アプリケーションはエントリを削除できない」と同じ考え方であることに触れる
  - 4つ足した（権限の分離／手順の宣言元が1つ／公開の経路を集約しない／公開手続きが読むのは公開分だけで書き込みを持たない）。既存の2つ（削除できない・使っていないあいだの費用）も、今回の変更を織り込んで直した。
- [x] 8.6 ディレクトリ構成に `terraform/modules/publish/` と `buildspec.yml` を足す
  - 併せて `editor/src/lib` と `pages` の説明も直した（公開手続きの起動と `/publish` が増えている）。
- [x] 8.7 CI（型検査・Lint）を GitHub Actions 側に置く方針を README に一言残す。この change では作らないが、CodeBuild を CI に使わない理由が後から分かるようにする
  - 「開発」の節に置いた。**混ぜると片方の都合でもう片方が止まる**（Lint の失敗で日記が公開できない）ことを理由として書いた。
  - 併せて、編集画面の公開状態のヒント文を直した。`npm run build` と `npm run deploy` を名指ししていたが、いまはブラウザからも反映できる。`/publish` への導線に置き換えた。
  - `npm run format` と `npm run check` を通した（0 errors / 0 warnings / 0 hints、修正なし）。
