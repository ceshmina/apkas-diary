## Context

動機は proposal.md の Why を参照。ここでは方式の選定に効く現状だけを挙げる。

- サイトの生成とデプロイは `scripts/build.sh`（DynamoDB → `dist/` と `export/`）と `scripts/deploy.sh`（`aws s3 sync --delete` → CloudFront invalidate）の2本で、いずれも `config/<環境>.env` を読む。この設定ファイルは**コミットされない**。
- 環境の選択は named profile（`AWS_PROFILE`）で行う。`deploy.sh` は production で対話的な確認を求める。
- 配信先バケット・ディストリビューション ID・テーブル名は、すでに `terraform output` として環境ごとの root module に存在する。
- 編集アプリケーションの実行ロールには **S3 と CloudFront の権限がいっさい無い**。「画面に置かない」ではなく「権限を与えない」で担保する形が、削除操作の不在（`entry-editing`）と合わせて既存の設計の芯になっている。
- 編集アプリケーションは Lambda + API Gateway。**応答は 30 秒が上限**で、これは統合タイムアウトとして基盤側が担保している。2〜3分かかるビルドを同期的に待つことはできない。
- 関数のコードは lambroll、インフラは Terraform、という分担が既にある。

## Goals / Non-Goals

**Goals:**

- 公開の手順の宣言元を1つに保つ。手元から配ったものとボタンから配ったものが食い違わない。
- 「起動できること」と「配信物を書き換えられること」を別々の権限に保つ。編集アプリケーションの権限の増分を、起動と状況取得だけに閉じる。
- 転記を増やさない。Terraform が既に知っている値を、人が別のところへ書き写す作業を作らない。
- 起動口を後から増やせる形にする。この change で作るのは1つだが、2つ目（GitHub Actions など）が同じ定義を共有できる。

**Non-Goals:**

- ビルドの高速化。数分待つことは許容する。キャッシュの仕組みを持たない。
- 実行環境での CI（型検査・Lint・テスト）。公開手続きは「main の内容を配る」ことだけを担う。
- デプロイの履歴を独自に保持すること。実行基盤が持つ記録を読むだけにする。

## Decisions

### 決定1: ビルドとデプロイの実行場所を AWS CodeBuild にする

検討した案:

| 案 | 内容 | 判断 |
| --- | --- | --- |
| **A. CodeBuild** | 環境ごとに1つのプロジェクト。同一アカウント内で実行 | **採用** |
| B. GitHub Actions 単独 | 編集アプリケーションが `workflow_dispatch` を叩き、Actions が AWS へ配る | 却下 |
| C. ビルド専用の Lambda / Fargate | 自前の実行環境を用意する | 却下 |
| D. 現状維持 | 手元からのみ | 却下（proposal の Why） |

A を採る理由:

1. **転記が増えない。** 配信先バケット・ディストリビューション ID・テーブル名は、CodeBuild プロジェクトを定義する root module がすでに output として持っている。同じ module 内で環境変数として渡せるので、人が書き写す場所が生まれない。B ではこれらを repo variables へ転記するか、Actions の実行中に tfstate か SSM を引く仕掛けを足すことになる。**この repo が一貫して避けてきたのは、まさにこの転記である。**
2. **production の資格情報が AWS の外に出ない。** B は GitHub → AWS の OIDC ロールに、production の配信元バケットと CloudFront への書き込み権限を与えることになる。repo への write 権限が、本番の配信物への write 権限に接続する。日記は再取得のきかない個人の記録であり、その経路を増やさない。
3. **環境の取り違えが構造的に起きない。** staging のプロジェクトに付くロールは staging のバケットしか書けない。`allowed_account_ids` と同じ性質の防護が、実行ロールの資源指定として自然に効く。
4. **待機費用がゼロ。** `editor-hosting` の方針をそのまま満たす。ARM の `BUILD_GENERAL1_SMALL` は分あたり $0.0034 程度で、1回 2〜3 分・月 30 回でも $0.3 に届かない。常時課金される部品は増えない。

C を却下するのは、Astro のビルドに `node_modules` が要るためコンテナイメージと ECR が実質必須になり、**サイトのコードを直すたびにイメージを作り直す**必要が出るからである。CodeBuild と同じ従量課金性を、より多い部品数で得ることになる。

**CI は GitHub Actions 側に置く**（この change では作らない）。CodeBuild が担うのは「main の内容を配る」ことだけとし、型検査・Lint はコードの変更に対して回す別の場所に置く。片方の都合でもう片方が止まらない。

### 決定2: buildspec は repo に置き、`scripts/build.sh` と `scripts/deploy.sh` をそのまま呼ぶ

手順の宣言元を1つに保つ。buildspec を Terraform にインライン展開すると、同じ手順が手元用のスクリプトと Terraform の文字列の2箇所に存在し、片方だけ直したときに**ボタンから配ったものと手元から配ったものが変わる**。`site-publishing` の「どこから起動しても同じ生成物」は、この一致に依っている。

そのために scripts 側へ最小の改修を入れる。

- **設定の受け取り口を増やす。** `config/<環境>.env` はコミットされないので CodeBuild には存在しない。`load_env` に「設定はすでに環境変数として与えられている」経路（`DIARY_CONFIG_SOURCE=environment`）を足し、その場合はファイルを読まずに必要な変数が揃っているかだけを確かめる。ファイルが無いことを合図にしないのは、手元で `cp` を忘れただけの状態が黙って通ってしまうため。
- **`--profile` の明示指定をやめる。** AWS CLI は環境変数 `AWS_PROFILE` を自分で読む。`load_env` は `.env` の内容を `set -a` で export しているので、手元の挙動は変わらない。CodeBuild では `AWS_PROFILE` が未設定になり、実行ロールの資格情報が使われる。`require_env_vars AWS_PROFILE` は、ファイルから読んだときだけの確認に移す。
- **production の確認を非対話でも成立させる。** 現在の `read -r -p` は TTY を前提にしている。CodeBuild では `DIARY_DEPLOY_CONFIRMED` が渡されているかを見る形に分岐させる（決定6）。

### 決定3: ソースは CodeStar Connection 経由で GitHub の main から取る

CodeBuild のソースを GitHub に直接向け、認証は CodeStar Connection（`aws_codestarconnections_connection` + `aws_codebuild_source_credential` の `CODECONNECTIONS`）で通す。

S3 にソースの束を置く案と比べた:

- 束を置く案は「束を上げる」一手が増え、**ボタンが配るのが「最後に上げた束」**になる。それが今の main と一致しているかは、人が覚えておくことになる。
- GitHub から直接取れば「ボタン＝今の main を配る」が説明不要で成り立つ。

代償は2つある。

1. **接続の承認がコンソールでの手作業になる。** Terraform が作れるのは `PENDING` 状態の接続までで、GitHub 側の認可は人が行う。tfstate バケット・ホストゾーン・Google OAuth クライアントに続く4つ目の例外として `deployment-environments` に追記した。
2. **デプロイ時に GitHub の可用性に依存する。** これは `site-delivery` の「ローカルからの経路は他の実行手段の可用性に依存しない」で受け止める。GitHub が落ちていても手元からは配れる。

手元の未コミットの変更が配られないことは仕様である（`site-publishing` の「共有された版に由来する」）。驚きを減らすため、**実行に使われた commit を画面に出す**（`resolvedSourceVersion`）。

### 決定4: 編集アプリケーションに与える権限は3つ、資源は自環境のプロジェクト1つ

`codebuild:StartBuild` / `codebuild:BatchGetBuilds` / `codebuild:ListBuildsForProject` の3つを、自環境のプロジェクト ARN に限って与える。この3つはいずれも project ARN での資源指定に対応している（[CodeBuild permissions reference](https://docs.aws.amazon.com/codebuild/latest/userguide/auth-and-access-control-permissions-reference.html)）。

**S3 と CloudFront の権限は1つも増えない。** 編集アプリケーションが起こせるのは「定められた手順を始めること」だけで、何をどこへ書くかは手順の側が持つ。`entry-editing` が削除を画面ではなく権限で塞いでいるのと同じ形である。

検討して却下した案: **DynamoDB に「公開要求」を書き、Streams から Lambda が起動する。** 編集アプリケーションの権限を日記データだけに保てるが、部品が2つ増えるうえ、起動の失敗が利用者に返らない（要求は書けたがビルドは始まらなかった、という穴が生まれる）。押した結果がその場で分かることを優先する。

CodeBuild の実行ロールに与えるのは、

- DynamoDB: `Query`（GSI1 と base table）と `Scan`。**書き込みは与えない。** 公開手続きは日記を読むだけである。
- S3: 自環境の配信元バケットへの `PutObject` / `DeleteObject` / `ListBucket`（`sync --delete` に要る）。写真のバケットには触れない。
- CloudFront: 自環境のディストリビューションへの `CreateInvalidation`。
- CloudWatch Logs: 自分のロググループのみ。

### 決定5: 実行の状態は保存せず、プロジェクトの最新のビルドを見る

編集アプリケーション側にビルド ID を持たない。`ListBuildsForProject` は新しい順に ID を返すので、先頭を `BatchGetBuilds` で引けば「今どうなっているか」が分かる。

- セッションにも DynamoDB にも状態を持たなくてよい。**編集アプリケーションが書き込むのは日記だけ**という現状が保たれる。
- 別の画面・別のブラウザで開いても同じ状況が見える。
- 将来 GitHub Actions やコンソールから起動されたビルドも、同じ画面に現れる。起動口を増やしても表示側を直さなくてよい。

Lambda の 30 秒の上限があるため、押した要求の中で完了を待つことはしない。起動して即座に返し、状況の画面へ送る。画面の更新は定期的な再読み込みで足りる（数分に一度しか押されない操作に、常時接続の仕組みを持ち込まない）。

### 決定6: 多重起動は画面で抑止し、構造でも塞ぐ

- **画面側**: 起動の前に最新のビルドの状態を見て、進行中なら新たに始めずその旨を返す。これが `site-publishing` の利用者から見える挙動である。
- **構造側**: プロジェクトに `concurrent_build_limit = 1` を置く。画面側の判定と実際の起動のあいだには隙間があり、連打すれば擦り抜けうる。**2つの `s3 sync --delete` が重なると、どちらの生成物とも一致しない状態が配信される。** そこだけは判定ではなく構造で塞ぐ。

### 決定7: production の確認は起動口の側で行う

- 手元: `deploy.sh` の対話確認をそのまま残す。
- ブラウザ: 押しただけでは始まらず、確認の一段を挟む。
- 加えて、CodeBuild 側は `DIARY_DEPLOY_CONFIRMED` が環境変数の override として渡されていることを要求する。コンソールから素で `StartBuild` しても deploy の段に進まない。

3つ目は**多層防御であって権限境界ではない**。`StartBuild` の権限を持つ主体は override も渡せる。境界として効いているのは「`StartBuild` を持つのが編集アプリケーションと管理者だけ」という点であり、`DIARY_DEPLOY_CONFIRMED` は事故を1段減らすだけのものと理解しておく。

### 決定8: 失敗が配信物を壊さない置き方

buildspec の `build` フェーズに `scripts/build.sh` → `scripts/deploy.sh` をこの順で置く。CodeBuild は同一フェーズ内で先行するコマンドが失敗すると後続を実行しないので、**生成に失敗した実行は `s3 sync` に到達しない**。

`post_build` は `build` が失敗しても実行される。したがって**そこに配信物へ触る処理を置かない**。置くのは結果の表示だけにする。

### 決定9: 実行環境は ARM の標準イメージ、キャッシュは持たない

- イメージ: `aws/codebuild/amazonlinux-aarch64-standard:3.0`、`ARM_CONTAINER` / `BUILD_GENERAL1_SMALL`。buildspec の `runtime-versions` で `nodejs: 22` を指定する（`.node-version` と揃える。このイメージは Node 22 / 24 を持つ）。
- ARM を選ぶのは、既存の Lambda 2つが arm64 で揃っていること、および同じ性能あたりの単価が安いことによる。
- **キャッシュは持たない。** 起動が数日に1度では local cache はまず当たらず、S3 cache は保存先とその寿命の管理が増える。`npm ci` の 30〜60 秒を惜しんで部品を増やさない。
- ログは CloudWatch Logs に置き、保持は 30 日（写真変換 Lambda・編集アプリケーションと揃える）。

## Risks / Trade-offs

- **GitHub 接続が未承認・失効している** → ソースの取得で失敗し、ボタンからは配れなくなる。ローカルからの経路は無傷なので、公開する手段は残る。承認の手順を README に置き、失敗時のメッセージから接続を疑えるようにする。
- **`aws s3 sync` が途中で失敗すると部分反映になる** → 現行のローカルデプロイと同じ性質で、この change で悪化しない。失敗は画面に出るので、再実行で収束する。「生成が終わる前に配信物へ書かない」ことは決定8で担保されるが、書いている最中の中断までは防げない。
- **権限の新しい集中先ができる** → CodeBuild の実行ロールは、配信元バケットと CloudFront を書ける唯一の非人間の主体になる。資源を自環境の1バケット・1ディストリビューションに限定し、DynamoDB には読み取りしか与えないことで範囲を狭める。写真のバケットには触れない。
- **押せば課金が始まる** → 押せるのは認証を通った1アカウントだけで、連打は決定6で抑止される。それでも「無料ではない操作を画面に置いた」ことは事実なので、実行時間と回数を README に書いておく。
- **手元でしか確認していない変更はボタンから出ない** → 意図した挙動だが驚きになりうる。実行に使われた commit を画面に出して、何が配られたかを見えるようにする。
- **公開手続きの手順を直すのがコードの変更になった** → `scripts/*.sh` と `buildspec.yml` を直すと、次の実行から挙動が変わる。Terraform の `apply` を挟まない。これは lambroll と同じ「インフラと中身のライフサイクルを分ける」形で、この repo では既知の性質である。

## Migration Plan

1. staging に `terraform apply`。CodeStar Connection は `PENDING` で作られる。
2. AWS コンソールで GitHub 接続を承認する（環境ごとに1度だけ）。
3. staging で `npm run deploy:editor -- staging`。ボタンから実行し、生成物が手元からのデプロイと一致することを確認する。
4. `terraform plan` が差分を出さないことを確認する（既存の運用と同じ）。
5. production に同じ順で適用する。

**ロールバック**: publish のモジュール呼び出しを外して `terraform apply` すれば、プロジェクトも接続も消える。編集アプリケーションのボタンは `lambroll rollback` で戻る。**ローカルからの経路は最初から最後まで変わらない**ので、この change のどの段階で止めてもサイトは配れる。
