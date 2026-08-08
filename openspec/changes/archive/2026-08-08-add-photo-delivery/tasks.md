## 1. Lambda: 変換の中身

- [x] 1.1 `lambda/photo-resize/` を作り、独自の `package.json` を置く。依存は `sharp` と `@aws-sdk/client-s3` / `@aws-sdk/client-cloudfront` に限り、ルートの `package.json` には何も足さない
  - sharp 0.35.3（libvips 8.18.3）、AWS SDK 3.1106.0。devDependencies に `typescript` と `@types/node` を置いた。型検査のためだけのもので、配布物には入らない。
  - TypeScript はルートと同じ 6.0.3 に揃えた。既定で入るのは 7.x だが、1つのリポジトリに2つのメジャーが並ぶのを避けた。
- [x] 1.2 S3 の `ObjectCreated:*` イベントを受け取り、キーをデコードして（`+` とパーセントエンコードに注意）元写真を取得するところまでを書く
- [x] 1.3 元写真を1度だけデコードし、そこから4サイズを作る。長辺は thumbnail 240 / small 960 / medium 1920 / large 3840。各サイズは常に元写真から縮小し、`large` から `medium` を作るような連鎖にしない
  - `clone()` で入力を共有した4本のパイプラインにした。**「1度だけデコードする」という書き方は実装に合わない**ため、design.md の決定4を実態に合わせて直した（下の注記）。
- [x] 1.4 拡大を禁止する。元の長辺が指定より短いときは素通りさせ、そのサイズも元と同じ大きさで生成する（4つのサイズが常に揃う）
  - `resize({ width: n, height: n, fit: 'inside', withoutEnlargement: true })` の1つの指定で足りた。サイズごとの分岐は要らない。
- [x] 1.5 リサイズの**前に** EXIF Orientation を画素へ適用する。長辺の判定が回転後の縦横で行われることを、縦位置の写真で確かめる
  - `sharp(input).rotate()` を base に置き、`clone()` が引き継ぐ。3000×2000 に Orientation=6 を付けた写真の `small` が 640×960 になることを確認（回転しなければ 960×640 になる）。
- [x] 1.6 画素を sRGB に変換してから出力する。ICC プロファイルは埋めない
  - 実測で分かったこと：**libvips は読み込みの時点で埋め込みプロファイルを解釈し、既に sRGB へ変換している**。生の画素が P3(187,88,67) のファイルは、素通りでも sRGB(200,81,60) で出てくる。
  - `withIccProfile('srgb', { attach: false })` は画素の値としては既定と変わらない。それでも書いたのは、出力の色空間とプロファイルを埋めないことを暗黙の既定に頼らず宣言しておくため。ソースのコメントも実態に合わせてある。
- [x] 1.7 出力を WebP に固定する。metadata を引き継ぐ指定を**書かない**ことで付随情報を落とす（消す処理を足す形にしない）
- [x] 1.8 配信先のキーを `<size>/<元キーの拡張子を webp に替えたもの>` として組み立て、`Cache-Control: public, max-age=86400, s-maxage=31536000` と `Content-Type: image/webp` を付けて書き込む
  - 拡張子の置換は最後の区切りより後ろだけを見る。`2026/08.old/a` のようにディレクトリ名に点があっても壊さない。
- [x] 1.9 書き込みの前に配信先の `medium` の有無を調べ、**既にあったときだけ** 4つのパスに対する CloudFront の invalidation を発行する。初回の投入では発行しない
  - `HeadObject` の 404 だけを「無い」として扱い、それ以外は例外のまま通す。権限の不備を「無い」と読み替えると、差し替えたのに invalidate されないという形で静かに間違う。
  - この `HeadObject` には配信用バケットへの `s3:GetObject` と **`s3:ListBucket`** が要る。後者が無いと、存在しないキーに S3 が 404 ではなく 403 を返し、`exists` が例外を投げて再試行が空回りする（7.5 で実際に踏んだ）。タスク 3.11 のロールに反映した。
- [x] 1.10 失敗を2種類に分ける。画像として読めなかった場合は記録を残して正常終了し、再試行させない。S3 の読み書きに失敗した場合は例外を投げて再試行に委ねる
- [x] 1.11 ローカルで実写真を入力にして関数を実行し、4つの出力の寸法・形式・metadata を確かめる（AWS に上げる前の段階で切り分けておく）
  - 7項目・38件の検査を書いて全て通した。長辺 4000px の横長、Orientation=6 の縦位置、長辺 1000px、PNG、本物の Display P3、画像でない入力、キー規約。
  - **最初のテストには欠陥があった**。`sharp(path).toBuffer()` でフィクスチャを読んでいたため、関数に渡る前に EXIF が落ちており、「EXIF が残っていない」が自明に真になっていた。`readFileSync` でバイト列のまま渡すよう直したところ、向きの検査が落ちて 1.5 の不備が見つかった。
  - P3 のフィクスチャも同様で、`withIccProfile('p3')` を素の合成画像に当てても画素は変換されない（入力側にプロファイルが無いため）。sRGB を明示的に付けた画像を経由させて、生の画素が P3(187,88,67) になっていることを確かめてから使った。
  - 検査スクリプトはリポジトリに残していない（このリポジトリにテストの枠組みがまだないため）。残すなら別途。

## 2. Lambda: ビルドと lambroll でのデプロイ

- [x] 2.1 lambroll を導入し、使ったバージョンを控える
  - lambroll v1.3.2（導入済みだった）。
- [x] 2.2 `lambda/photo-resize/function.jsonnet` を書く。`FunctionName` / `Role` / `Runtime` / `Handler` / `Architectures` は `tfstate` native function で Terraform の state から読む。ここで自分で決めるのは `MemorySize`（2048）と `Timeout`（60）だけにする
  - `local tfstate = std.native('tfstate');` で引く。`Architectures` は `...aws_lambda_function.resize.architectures[0]` で配列の添字も辿れた。
  - 合成した tfstate を用意して `lambroll render` で確かめた。7つの値がすべて state 由来で解決されることを、AWS に触らずに確認できる。
- [x] 2.3 `Environment.Variables` に配信先バケット名と CloudFront のディストリビューション ID を置く。これらも `tfstate` から読み、どこにも転記しない
- [x] 2.4 `scripts/build-lambda.sh` を書く。TypeScript をコンパイルし、`--os=linux --cpu=arm64` を指定して sharp を入れ、`lambroll deploy --src` に渡せるディレクトリを作る
  - `--libc=glibc` も明示した（Lambda の AL2023 は glibc）。
  - 実行時の依存の**版は `lambda/photo-resize/package.json` から読む**。ビルドスクリプトに版を書くと、直す場所が2つになる。
  - 毎回 `rm -rf build` する。古いファイルが残ると、直したはずの挙動が戻ったように見える。
- [x] 2.5 `.lambdaignore` を置き、TypeScript のソースや開発用の依存が配布物に入らないようにする
  - `--src` には作り直した `build/` を渡すので通常は何も引っかからない。作り方を変えたときの歯止めとして置いている。
- [x] 2.6 `scripts/deploy-lambda.sh` を書く。環境名を第1引数に取り、`load_env` を通し、`terraform/envs/<環境>/backend.hcl` から state の場所（`s3://<バケット>/<キー>`）を組み立てて `lambroll deploy --tfstate` に渡す。ビルドもここから呼ぶ
  - `deploy.sh` に倣って、実行前に環境・profile・アカウント ID・tfstate の場所を表示し、production では確認を求めるようにした。本番の関数を差し替える操作なので、サイトのデプロイと同じ重さで扱う。
- [x] 2.7 `npm run deploy:lambda` として `package.json` に登録する
- [x] 2.8 ビルドの中間生成物を `.gitignore` に足す
  - `lambda/*/build/` と `**/placeholder.zip`（3.8 が組み立てるもの）。
- [x] 2.9 配布物が Lambda の直接アップロード上限（50MB）に収まっていることを確認する。超える場合は S3 経由の配置に切り替える
  - 展開 51.3 MB、**zip 15.6 MB**。上限に対して十分な余裕がある。S3 経由への切り替えは要らない。
  - `build/node_modules/@img` に入ったのは `sharp-linux-arm64` と `sharp-libvips-linux-arm64` のみ。手元の darwin 用は混ざっていない。
- [x] 2.10 `npm run check` が `lambda/` の TypeScript も対象にしていることを確認する（別 tsconfig になるなら check から呼ぶ）
  - `scripts/check-lambda.sh` を足して `npm run check` から呼ぶ形にした。依存が入っていなければ、実行すべきコマンドを添えて止まる（`load-env.sh` と同じ流儀）。
  - ルートの tsconfig の `exclude` に `lambda` を足した。入れたままだと `astro check` が sharp の型を要求し、サイト生成の型検査が Lambda の依存に縛られる。
  - biome の `includes` に `!lambda/*/build` を足した（コンパイル結果を整形対象にしていた）。`!node_modules` は `!**/node_modules` に直した。lambda 配下の `node_modules` に届いていなかった。
  - 通過を確認：astro check 25 ファイル 0 errors、biome 30 ファイル、lambda の `tsc --noEmit` も無指摘。biome が lambda のソースを実際に見ていることも個別に確認した。
- [x] 2.11 環境名を指定せずに `npm run deploy:lambda` を実行し、何もデプロイされないまま失敗することを確認する
  - 環境名なし → 使い方を出して終了。`prod` のような未知の名前 → `load_env` が拒否。いずれもビルドにも AWS にも到達しない。

## 3. Terraform: 写真のモジュール

- [x] 3.1 `terraform/modules/photos/` を作る。`modules/delivery` の証明書・DNS・OAC の形をなぞりつつ、惰性で写さない（決定 11・12 で意図的に違えている箇所がある）
  - 意図的に違えたところにはその理由をコメントで残した。`compress = false`、`default_root_object` なし、CloudFront Function なし、`custom_error_response` なし、配信用のバージョニング無効。
- [x] 3.2 アップロード用 S3 バケット `apkas-diary-photo-upload-<環境>-<アカウント ID>` を定義する。パブリックアクセス全ブロック、**バージョニング有効**、暗号化、未完了マルチパートの中止
  - 古いバージョンに期限は切っていない。サイト配信用の 30 日とは事情が違い、取り違えからの復旧に要るものを勝手に捨てない。
- [x] 3.3 配信用 S3 バケット `apkas-diary-photo-<環境>-<アカウント ID>` を定義する。パブリックアクセス全ブロック、**バージョニング無効**、暗号化
- [x] 3.4 us-east-1 の ACM 証明書と DNS 検証用レコード、検証待ちを定義する（`delivery` と同じ形）
- [x] 3.5 CloudFront ディストリビューションと OAC を定義する。`compress = false`、CloudFront Function なし、`viewer_protocol_policy = "redirect-to-https"`、TLSv1.2_2021
- [x] 3.6 配信用バケットのポリシーを、この CloudFront ディストリビューションからの `s3:GetObject` のみに限定する。`s3:ListBucket` は与えない
- [x] 3.7 A / AAAA の alias レコードを定義する
- [x] 3.8 `data "archive_file"` で placeholder を組み立てる。中身は「まだ lambroll でデプロイされていない」と記録して終わるハンドラにする。バイナリはコミットせず、生成物は `.gitignore` に足す
  - placeholder は CommonJS（`exports.handler`）にした。package.json を伴わない zip なので、ESM で書くと読み込みで落ちる。読めずに落ちるのではなく、理由を記録して終わってほしい。
  - 例外は投げない。何度再試行しても結果は変わらないので、決定3と同じ扱いにする。
  - `hashicorp/archive` プロバイダが増える。両環境の `.terraform.lock.hcl` が更新された。
- [x] 3.9 Lambda 関数の枠を定義する。宣言するのは `function_name` / `role` / `runtime`（nodejs22.x）/ `handler` / `architectures`（arm64）と placeholder だけで、メモリ・タイムアウト・環境変数は**書かない**（`function.jsonnet` が持つ）
- [x] 3.10 `lifecycle { ignore_changes }` に `function.jsonnet` が設定するものをすべて並べる（`filename`、`source_code_hash`、`memory_size`、`timeout`、`environment`、`layers`、`ephemeral_storage`）。`function_name` と `role` は並べない
  - `layers` と `ephemeral_storage` は今の `function.jsonnet` が設定していない。設定するようになったときに黙って戻されるのを避けたいので、先に入れてある旨をコメントに書いた。
- [x] 3.11 Lambda の実行ロールを定義する。アップロード用バケットからの `GetObject`、配信用バケットへの `PutObject` と `HeadObject`、このディストリビューションに対する `CreateInvalidation`、CloudWatch Logs への書き込みに限る
  - 配信用バケットには `s3:GetObject` も与えた。`HeadObject` はこれで認可される（1.9 の注記）。
  - **`s3:ListBucket`（バケット本体に対して）も要る。** これが無いと、存在しないキーへの `HeadObject` が 404 ではなく 403 になる。S3 がキーの有無を外から数え上げさせないための振る舞いで、`s3:GetObject` では代替できない。7.5 で踏んで足した。
  - これは決定12（CloudFront に `ListBucket` を与えない）とは無関係。あちらはバケットポリシーで閲覧者の経路を絞る話、こちらはこの関数のロールだけが持つ権限で、閲覧の経路は何も変わらない。
  - `logs:CreateLogGroup` は**与えない**。ロググループは Terraform が作るので、保持期間の付いていないグループが実行時に生まれる経路を残さない。
  - ロググループの ARN は `trimsuffix(arn, ":*") + ":*"` で組み立てた。プロバイダの版によって末尾の `:*` の有無が揺れるため、どちらでも同じ形になるようにしてある。
- [x] 3.12 アップロード用バケットの `ObjectCreated:*` 通知と、その呼び出しを許す Lambda 側の権限を定義する
  - 通知は `depends_on` で許可の後に作る。S3 は通知の作成時に呼び出せることを検証するため、順序が逆だと失敗する。
- [x] 3.13 CloudWatch Logs のロググループを定義し、保持期間を設定する（無期限に貯めない）。関数が初回に呼ばれて自動生成する前に、Terraform 側が作る形にする
  - 既定 30 日。`log_retention_days` で変えられる。関数から `depends_on` を張って順序を固定した。
- [x] 3.14 出力を定義する（アップロード用バケット名、配信用バケット名、ディストリビューション ID、写真の配信 URL、CloudFront が払い出すドメイン名）。lambroll は tfstate を直接読むので、そのための出力は足さない
  - 関数名も出したが、これは転記用ではなくログを探すときのため。

## 4. Terraform: 環境からの呼び出し

- [x] 4.1 `envs/staging/main.tf` から `photos` モジュールを呼ぶ。`domain_name = "photos.dev.apkas.net"` / `hosted_zone_name = "dev.apkas.net"`
- [x] 4.2 `envs/production/main.tf` から同じく呼ぶ。`domain_name = "photos.apkas.net"` / `hosted_zone_name = "apkas.net"`
- [x] 4.3 両環境の `outputs.tf` に、`config/<環境>.env` へ転記する値を足す
  - 転記するのは `PHOTO_UPLOAD_BUCKET` と `PHOTO_URL` の2つだけ。残り（配信用バケット・ディストリビューション ID・関数名）は「転記しない」と明記して出している。lambroll が state を直接読むため。
- [x] 4.4 `terraform plan` が既存のサイト配信・DynamoDB のリソースに1つも変更を出さないことを確認する
  - staging で `Plan: 22 to add, 0 to change, 0 to destroy.`
  - plan の JSON を読んで、22 件の追加がすべて `module.photos.` 配下であることを機械的に確認した。**`module.photos` の外への変更は0件。**
  - `terraform.tfvars` と `backend.hcl` は例から作った（いずれも gitignore 対象）。state のキーは実際のバケットの中身と突き合わせて確かめてある。

## 5. 投入 CLI

- [x] 5.1 `scripts/photo.sh` を書く。`scripts/entry.sh` と同じく環境名を第1引数に取り、`load_env` を通し、`require_env_vars` で必要な変数を検査する
- [x] 5.2 `src/cli/put-photo.ts` を書く。`--file` と `--date` を受け、キーを `YYYY/MM/DD/<ファイル名>` に組み立てる。`--key` でキー全体を明示できるようにする
  - `--date` と `--key` は排他にした。両方あるとどちらが効くかを覚えることになる。
  - URL 規約は `src/lib/photo.ts` に置いた。**同じ規約が Lambda 側にもある**（パッケージが分かれていて共有できない）。両方のコメントに、片方を変えたらもう片方も直す旨を書いてある。
  - 検証を確認：`--file` のみ／`--date` のみ／不正な日付／両方指定／`--key /`／`--key ""` のいずれも、投入の手前でエラーになる。
- [x] 5.3 アップロード用バケットへ元写真を置く
  - 元写真の `Content-Type` は拡張子から付ける。公開されないので表示には影響しないが、手元に落として開くときのために。変換は中身を見て行われる。
- [x] 5.4 配信先に `medium` が現れるまで短く待つ（上限は数十秒）。上限に達しても失敗とはせず、まだ現れていないことを伝えて終わる
  - 2秒おき、上限 30 秒。**配信 URL ではなく配信用 S3 バケットを見る。** URL を叩くと、まだ無いあいだの 403 が CloudFront に載り（既定で 10 秒）、自分の問い合わせが原因で読めない時間を作ってしまう。
  - このため `PHOTO_BUCKET` が要る。**design の「転記するのは2つだけ」から1つ増えた**（tasks 4.3 の注記も含めて更新済み）。lambroll のための転記は増えていない。
  - 404 だけを「まだ無い」として扱う。それ以外の失敗を待ちに含めると、権限の不備を「生成が遅い」と読み替えて上限まで黙って待つ。
- [x] 5.5 4つのサイズの URL を表示する。本文にそのまま貼れる形にする
  - 各段を符号化する。空白を含むファイル名でもそのまま貼れる（`a b.jpg` → `a%20b.webp`）。
- [x] 5.6 `npm run photo` として `package.json` に登録する
  - あわせて `@aws-sdk/client-s3` をルートの依存に足した。純粋な JavaScript で、native binary は持ち込まない。
- [x] 5.7 環境名を指定せずに実行し、何も投入されないまま失敗することを確認する
  - 環境名なし → 使い方を出して終了。`prod` → `load_env` が拒否。`config/staging.env` が無ければその手前で止まる。

## 6. 設定とドキュメント

- [x] 6.1 `config/staging.env.example` と `config/production.env.example` に、アップロード用バケット名と写真の配信 URL を足す（lambroll のための値は足さない）
  - 実際には3つになった。`PHOTO_UPLOAD_BUCKET` / `PHOTO_BUCKET` / `PHOTO_URL`。`PHOTO_BUCKET` が増えた理由は 5.4 に書いた。lambroll のための転記は増えていない。
- [x] 6.2 README に、写真のキー規約（`YYYY/MM/DD/<ファイル名>`）と URL 規約（`/<size>/<キー>.webp`）を書く
  - 4つの URL を並べて「サイズ名以外はすべて一致する」ことと、4つが常に揃うことを明記した。参照する側が存在を確かめずに済むのが規約の効き目なので、そこを言葉にしておく。
  - EXIF が全部落ちること、向きと色は保たれることも書いた。
- [x] 6.3 README の「必要なツール」に lambroll を足す
  - あわせて冒頭の図に写真の経路を、環境の表に写真の URL を足した。
- [x] 6.4 README に Lambda のデプロイ手順を書く。インフラは `terraform apply`、コードは `npm run deploy:lambda -- <環境>` で、コードだけを直したときに apply は要らないことを明記する
  - 初期セットアップに「6. 写真変換 Lambda のデプロイ」を挟んだ（環境設定ファイルは 7 に繰り下げ）。`terraform apply` の直後は関数が動かない中身であることも書いた。
  - 日々の運用側にも「変換のコードを直す」を置いて、`lambroll rollback` とログの場所に触れた。
  - 「1. 依存関係」に `npm --prefix lambda/photo-resize install` を足した。ルートと別に持つ理由も添えた。
- [x] 6.5 README に、`lambroll deploy` の直後は `terraform plan` で差分が出ないことを確かめる、と書く。`ignore_changes` の並びが `function.jsonnet` と食い違っていないかを見張る唯一の手段になる
  - セットアップと日々の運用の両方に書いた。1度きりの確認ではなく毎回のものなので、片方だけだと読み落とす。
- [x] 6.6 README に写真の投入手順を書く
- [x] 6.7 README に写真を消す手順を書く（両方のバケットから手で消し、invalidate する。自動では連鎖しないこと）
  - そのまま貼れるコマンドの形にした。連鎖させない理由（原本の消し損ねが配信物を巻き込むのを避ける）も添えた。
- [x] 6.8 README のディレクトリ構成に `lambda/` と `modules/photos/` を足す
  - 「設計上の要点」にも3項目足した。配信用に人が書かないこと、バケットを分ける理由、Terraform と lambroll の境界。

## 7. staging での確認

### 適用とデプロイ

- [x] 7.1 `terraform apply` を実行する。証明書の DNS 検証が通ることを確認する。この時点では関数は placeholder のまま
  - 適用の途中で `iam.amazonaws.com` の名前解決が一度失敗し、IAM ロールの作成で止まった。再実行で通った（一時的なもの）。証明書の DNS 検証は問題なく完了。
  - 作られたのは 22 リソース。CloudFront の作成に約3分。
- [x] 7.2 placeholder のまま写真を投入し、変換されずに終わること、記録に「まだ lambroll でデプロイされていない」と残ることを確認する（この窓の失敗が読み取れる形になっているかの確認）
  - ログに意図した文言がそのまま出た。**再試行されず1回で終わっている**（placeholder が例外を投げないため）。
  - 配信先は空のまま。メモリは 128MB（Terraform が宣言していない既定値）で、設計どおり。
- [x] 7.3 `npm run deploy:lambda -- staging` で実装を載せる。tfstate から値が引けていること（ロール・環境変数・メモリ・タイムアウト）を関数の設定で確認する
  - 7つの値がすべて tfstate 由来で解決された：Runtime `nodejs22.x` / Handler `index.handler` / Architectures `arm64` / MemorySize 2048 / Timeout 60 / Role の ARN / 環境変数2つ。転記はゼロ。
- [x] 7.4 直後に `terraform plan` を実行し、差分が出ないことを確認する。差分が出たら `ignore_changes` に並べ忘れがある
  - `No changes. Your infrastructure matches the configuration.` lambroll が MemorySize・Timeout・Environment・コードを設定したあとで差分が出ない。`ignore_changes` の並びに漏れはない。
- [x] 7.5 7.2 で投入した写真をもう一度投入し、今度は変換されることを確認する
  - **ここで権限の不足が見つかった。** S3 は、`s3:ListBucket` を**バケットに対して**持たない主体には、キーが存在しない場合でも 404 ではなく 403 を返す。`s3:GetObject` をいくら与えても変わらない。
  - そのため `exists()` が例外を投げ、初回の投入が権限の失敗として落ちていた。ロールに `s3:ListBucket`（配信用バケット）を足して解決。
  - これは決定12（CloudFront に ListBucket を与えない）とは別の話。あちらは閲覧者が一覧を得る経路の話で、こちらはこの関数だけが持つ権限。閲覧の経路は変わらない。
- [x] 7.6 コードを1行変えて `npm run deploy:lambda -- staging` だけを実行し、`terraform apply` なしで反映されることを確認する（別ライフサイクルになっていることの確認）
  - 定数を1つ変えて `npm run deploy:lambda -- staging` だけを実行 → version 2 がデプロイされ、zip の大きさも1バイト変わった。`terraform apply` なしで `terraform plan` は `No changes` のまま。
  - 確認後、定数を戻して再デプロイ（version 3）。

### 生成されるもの

- [x] 7.7 長辺 4000px 程度の横長の写真を投入し、4つの長辺が 240 / 960 / 1920 / 3840 になること、いずれも元と同じ縦横比であることを確認する
  - 240x180 / 960x720 / 1920x1440 / 3840x2880。縦横比はいずれも 1.3333。4つとも WebP。
- [x] 7.8 縦位置の写真を投入し、指定の長さが**高さ**に適用されることを確認する
  - `small` が 640x960。回転が適用されなければ 960x640 になる。
- [x] 7.9 長辺 1000px 程度の写真を投入し、`medium` と `large` が拡大されずに 1000px で、かつ**どちらも存在する**ことを確認する
  - thumbnail 240 / small 960 / medium 1000 / large 1000。**medium と large は元と同じ 1000px で、どちらも存在する。**
- [x] 7.10 PNG を投入し、出力が WebP になることを確認する
  - PNG を投入して WebP が返った。

### 付随情報

- [x] 7.11 GPS・撮影日時・機材名を含む写真を投入し、4つの出力の metadata を読み出して、元写真に由来する項目がひとつも残っていないことを確認する（`exiftool` などで）
  - 4サイズすべてで、GPS・DateTimeOriginal・Make・Model・Artist・Software・ExifIFD・XMP・IPTC のいずれも0件。
- [x] 7.12 EXIF Orientation を持つ縦位置の写真を投入し、metadata を持たないビューアで開いても向きが正しいことを確認する
  - `exiftool -Orientation` が空。向きは画素に焼き込まれている（7.8 の寸法がその証拠）。
- [x] 7.13 広い色空間で記録された写真を投入し、元写真と並べて色が変わっていないことを確認する（7.11 とは別の検査になる）
  - 生の画素が P3(187,88,67) のファイルから sRGB(200,81,60) が出た。意図した色 sRGB(200,80,60) と一致（差は JPEG の丸め）。ICC プロファイルは埋まっていない。

### 元写真

- [x] 7.14 派生画像の生成後も、アップロード用バケットに元写真が残っていることを確認する
  - 9,809,230 bytes のまま残っている。
- [x] 7.15 元写真を配信ドメインから取得できないことを確認する
  - `https://photos.dev.apkas.net/2026/08/08/landscape.jpg` は 403。配信されるのはサイズ名の付いた派生画像だけ。
- [x] 7.16 同じキーに別の元写真を上書きし、上書き前の版をバージョニングから取り戻せることを確認する
  - バージョンが5つ積まれ、`IsLatest=false` の版を `--version-id` で取り戻せた（9,781,855 bytes = 差し替え前の内容）。

### 再投入と失敗

- [x] 7.17 同じキーに別の内容の写真を投入し、4つとも新しい内容に入れ替わることを確認する。invalidation が発行されていることも確認する
  - ETag が `5b4e1ec7…` → `ebae441b…` に変わり、invalidation が4パスちょうどで発行された。
  - **ここで CLI の欠陥が見つかった。** 再投入では probe 対象が既に存在するため、`waitForDerivative` が即座に true を返し、生成中でも「できました」と報告していた。差し替えのときこそ待つ意味があるのに、そこだけ待ちが素通りになっていた。
  - 「存在するか」ではなく「**投入前から最終更新時刻が変わったか**」で待つよう直した。内容（ETag）で比べないのは、同じ写真を投入し直したときに変わらず、成功しているのに上限まで待ってしまうため。
  - 直したうえで測り直し、待ちが終わった時点で内容が入れ替わっていることを確認。
- [x] 7.18 初回の投入では invalidation が発行されていないことを確認する
  - 初回の生成の直後、`list-invalidations` は `null`（0件）。差し替えのときだけ発行されている。
- [x] 7.19 画像でないファイルを置き、配信先に何も置かれないこと、失敗が記録に残ること、再試行されずに終わることを確認する
  - 配信先のオブジェクト数は 20 → 20 で変化なし。ログに「画像として読めませんでした」が**1回だけ**出た（再試行に回っていない）。
- [x] 7.20 その直後に正常な写真を投入し、通常どおり生成されることを確認する
  - 直後に投入した写真は通常どおり生成された。
- [x] 7.21 HEIC を投入し、読めるかどうかを確認する。読めない場合は README に「JPEG に変換してから投入する」と書く（design の Open Question）
  - **読めない。** sharp の同梱 libheif は入力が AVIF に限られ（`sharp.format.heif.input.fileSuffix` が `['.avif']`）、HEVC のデコーダを含まない。AV1 で符号化した HEIF は読めた。
  - macOS の `sips` が作る HEIC では、その手前で libheif の参照数の上限（iref 48 > 16）にも当たった。いずれにせよ実用にならない。
  - README に「HEIC は投入できない」節を足し、`sips -s format jpeg` での変換を書いた。design の Open Question はこれで解消。

### 配信

- [x] 7.22 `https://photos.dev.apkas.net/medium/<キー>.webp` が認証なしで返ること、証明書が有効であることを確認する
  - HTTP 200 / TLS 検証 0（成功）/ `image/webp` / 1,290,396 bytes。
- [x] 7.23 `medium` の URL のサイズ名だけを `thumbnail` / `small` / `large` に差し替えて、いずれも同じ写真の別サイズが返ることを確認する
  - 4つのサイズ名すべてで 200。
- [x] 7.24 HTTP で要求して HTTPS にリダイレクトされることを確認する
  - 301 で `https://` に飛ぶ。
- [x] 7.25 配信用・アップロード用のいずれも、バケットのオブジェクト URL に直接アクセスして拒否されることを確認する
  - 配信用・アップロード用ともバケットのオブジェクト URL は 403。
- [x] 7.26 存在しないキーと、定義されていないサイズ名でエラーが返り、画像が返らないことを確認する
  - 存在しないキー・未定義のサイズ名ともに 403（決定12 のとおり 404 には寄せていない）。画像は返らない。
- [x] 7.27 配信ドメインの根と、サイズ名だけのパスを要求し、オブジェクトの一覧が返らないことを確認する
  - 配信ドメインの根は 403 で本文 111 bytes、`ListBucketResult` は0件。サイズ名だけのパスも 403。
- [x] 7.28 同じ写真を2度要求し、2度目が CDN のキャッシュから返ること（`X-Cache: Hit from cloudfront`）を確認する
  - `x-cache: Hit from cloudfront`。`cache-control: public, max-age=86400, s-maxage=31536000` がそのまま返っている。

### サイトとの独立

- [x] 7.29 `npm run deploy -- staging` を実行したあと、配信中の写真がすべて生きていることを確認する
  - `npm run deploy -- staging`（`sync --delete` を含む）の後も、配信中の写真は 24 個のまま。`medium` は 200。
- [x] 7.30 写真を投入したあと、日記サイトの配信物が変化していないことを確認する
  - サイト配信元は 408 オブジェクトで、`.webp` やサイズ名のプレフィックスは0件。写真が混ざる経路がない。
- [x] 7.31 staging に投入した写真が production の配信ドメインに現れないことを確認する（production の適用後）
  - staging にしかないキー（`2026/08/09/graphic.webp`）は staging が 200、production が 403。
  - 配信中のオブジェクト数は staging 24 / production 12 で、互いに混ざっていない。

## 8. production への展開

- [x] 8.1 `npm run check` が通ることを確認する
  - astro check 0 errors / biome 32 ファイル / lambda の `tsc --noEmit` いずれも無指摘。
- [x] 8.2 production で `terraform apply` → `npm run deploy:lambda -- production` の順に実行する
  - plan は `22 to add, 0 to change, 0 to destroy`。JSON を読んで、追加がすべて `module.photos.` 配下であることを確認（**外への変更は0件**）。
  - lambroll は version 1 をデプロイ。production の確認プロンプトも意図どおり出た。
- [x] 8.3 直後に `terraform plan` が差分を出さないことを確認する
  - `No changes. Your infrastructure matches the configuration.`
  - 関数の設定も tfstate 由来で解決されている（arm64 / 2048MB / 60s / 環境変数2つ）。
- [x] 8.4 `config/production.env` に output を転記する
  - `PHOTO_UPLOAD_BUCKET` / `PHOTO_BUCKET` / `PHOTO_URL` を含め、output から転記した。
- [x] 8.5 実際の写真を1枚投入し、7章の主要な確認（4サイズ・EXIF なし・向き・色・URL 規約・直接アクセス拒否）を production でもう一度行う
  - 4サイズ：240x180 / 960x720 / 1920x1440 / 3840x2880、縦横比 1.3333、すべて WebP。元写真由来の metadata は4つとも0件。
  - 向き：Orientation=6 の写真の `small` が 640x960（長辺が高さ）。
  - 色：生の画素が P3 のファイルから sRGB(200,81,60) が出た。ICC は埋まっていない。
  - URL 規約：サイズ名の差し替えだけで4つとも 200。
  - 直接アクセス：配信用・アップロード用のバケット URL とも 403。配信ドメインから元写真も 403。根は 403 で `ListBucketResult` 0件。HTTP は HTTPS へ 301。
- [x] 8.6 日記サイトの配信が変わっていないことを確認する（本文の参照は旧ホストのまま。この change でページの見た目は1つも変わらない）
  - https://diary.apkas.net は 200、写真のある `/2024/09/29` も 200。
  - 本文が指す写真ホストは `photos.old.apkas.net` のみ。`photos.apkas.net` への参照は**0件**。
  - この change でページの見た目は1つも変わっていない。
