## 1. Lambda: 変換の中身

- [ ] 1.1 `lambda/photo-resize/` を作り、独自の `package.json` を置く。依存は `sharp` と `@aws-sdk/client-s3` / `@aws-sdk/client-cloudfront` に限り、ルートの `package.json` には何も足さない
- [ ] 1.2 S3 の `ObjectCreated:*` イベントを受け取り、キーをデコードして（`+` とパーセントエンコードに注意）元写真を取得するところまでを書く
- [ ] 1.3 元写真を1度だけデコードし、そこから4サイズを作る。長辺は thumbnail 240 / small 960 / medium 1920 / large 3840。各サイズは常に元写真から縮小し、`large` から `medium` を作るような連鎖にしない
- [ ] 1.4 拡大を禁止する。元の長辺が指定より短いときは素通りさせ、そのサイズも元と同じ大きさで生成する（4つのサイズが常に揃う）
- [ ] 1.5 リサイズの**前に** EXIF Orientation を画素へ適用する。長辺の判定が回転後の縦横で行われることを、縦位置の写真で確かめる
- [ ] 1.6 画素を sRGB に変換してから出力する。ICC プロファイルは埋めない
- [ ] 1.7 出力を WebP に固定する。metadata を引き継ぐ指定を**書かない**ことで付随情報を落とす（消す処理を足す形にしない）
- [ ] 1.8 配信先のキーを `<size>/<元キーの拡張子を webp に替えたもの>` として組み立て、`Cache-Control: public, max-age=86400, s-maxage=31536000` と `Content-Type: image/webp` を付けて書き込む
- [ ] 1.9 書き込みの前に配信先の `medium` の有無を調べ、**既にあったときだけ** 4つのパスに対する CloudFront の invalidation を発行する。初回の投入では発行しない
- [ ] 1.10 失敗を2種類に分ける。画像として読めなかった場合は記録を残して正常終了し、再試行させない。S3 の読み書きに失敗した場合は例外を投げて再試行に委ねる
- [ ] 1.11 ローカルで実写真を入力にして関数を実行し、4つの出力の寸法・形式・metadata を確かめる（AWS に上げる前の段階で切り分けておく）

## 2. Lambda: ビルドと lambroll でのデプロイ

- [ ] 2.1 lambroll を導入し、使ったバージョンを控える
- [ ] 2.2 `lambda/photo-resize/function.jsonnet` を書く。`FunctionName` / `Role` / `Runtime` / `Handler` / `Architectures` は `tfstate` native function で Terraform の state から読む。ここで自分で決めるのは `MemorySize`（2048）と `Timeout`（60）だけにする
- [ ] 2.3 `Environment.Variables` に配信先バケット名と CloudFront のディストリビューション ID を置く。これらも `tfstate` から読み、どこにも転記しない
- [ ] 2.4 `scripts/build-lambda.sh` を書く。TypeScript をコンパイルし、`--os=linux --cpu=arm64` を指定して sharp を入れ、`lambroll deploy --src` に渡せるディレクトリを作る
- [ ] 2.5 `.lambdaignore` を置き、TypeScript のソースや開発用の依存が配布物に入らないようにする
- [ ] 2.6 `scripts/deploy-lambda.sh` を書く。環境名を第1引数に取り、`load_env` を通し、`terraform/envs/<環境>/backend.hcl` から state の場所（`s3://<バケット>/<キー>`）を組み立てて `lambroll deploy --tfstate` に渡す。ビルドもここから呼ぶ
- [ ] 2.7 `npm run deploy:lambda` として `package.json` に登録する
- [ ] 2.8 ビルドの中間生成物を `.gitignore` に足す
- [ ] 2.9 配布物が Lambda の直接アップロード上限（50MB）に収まっていることを確認する。超える場合は S3 経由の配置に切り替える
- [ ] 2.10 `npm run check` が `lambda/` の TypeScript も対象にしていることを確認する（別 tsconfig になるなら check から呼ぶ）
- [ ] 2.11 環境名を指定せずに `npm run deploy:lambda` を実行し、何もデプロイされないまま失敗することを確認する

## 3. Terraform: 写真のモジュール

- [ ] 3.1 `terraform/modules/photos/` を作る。`modules/delivery` の証明書・DNS・OAC の形をなぞりつつ、惰性で写さない（決定 11・12 で意図的に違えている箇所がある）
- [ ] 3.2 アップロード用 S3 バケット `apkas-diary-photo-upload-<環境>-<アカウント ID>` を定義する。パブリックアクセス全ブロック、**バージョニング有効**、暗号化、未完了マルチパートの中止
- [ ] 3.3 配信用 S3 バケット `apkas-diary-photo-<環境>-<アカウント ID>` を定義する。パブリックアクセス全ブロック、**バージョニング無効**、暗号化
- [ ] 3.4 us-east-1 の ACM 証明書と DNS 検証用レコード、検証待ちを定義する（`delivery` と同じ形）
- [ ] 3.5 CloudFront ディストリビューションと OAC を定義する。`compress = false`、CloudFront Function なし、`viewer_protocol_policy = "redirect-to-https"`、TLSv1.2_2021
- [ ] 3.6 配信用バケットのポリシーを、この CloudFront ディストリビューションからの `s3:GetObject` のみに限定する。`s3:ListBucket` は与えない
- [ ] 3.7 A / AAAA の alias レコードを定義する
- [ ] 3.8 `data "archive_file"` で placeholder を組み立てる。中身は「まだ lambroll でデプロイされていない」と記録して終わるハンドラにする。バイナリはコミットせず、生成物は `.gitignore` に足す
- [ ] 3.9 Lambda 関数の枠を定義する。宣言するのは `function_name` / `role` / `runtime`（nodejs22.x）/ `handler` / `architectures`（arm64）と placeholder だけで、メモリ・タイムアウト・環境変数は**書かない**（`function.jsonnet` が持つ）
- [ ] 3.10 `lifecycle { ignore_changes }` に `function.jsonnet` が設定するものをすべて並べる（`filename`、`source_code_hash`、`memory_size`、`timeout`、`environment`、`layers`、`ephemeral_storage`）。`function_name` と `role` は並べない
- [ ] 3.11 Lambda の実行ロールを定義する。アップロード用バケットからの `GetObject`、配信用バケットへの `PutObject` と `HeadObject`、このディストリビューションに対する `CreateInvalidation`、CloudWatch Logs への書き込みに限る
- [ ] 3.12 アップロード用バケットの `ObjectCreated:*` 通知と、その呼び出しを許す Lambda 側の権限を定義する
- [ ] 3.13 CloudWatch Logs のロググループを定義し、保持期間を設定する（無期限に貯めない）。関数が初回に呼ばれて自動生成する前に、Terraform 側が作る形にする
- [ ] 3.14 出力を定義する（アップロード用バケット名、配信用バケット名、ディストリビューション ID、写真の配信 URL、CloudFront が払い出すドメイン名）。lambroll は tfstate を直接読むので、そのための出力は足さない

## 4. Terraform: 環境からの呼び出し

- [ ] 4.1 `envs/staging/main.tf` から `photos` モジュールを呼ぶ。`domain_name = "photos.dev.apkas.net"` / `hosted_zone_name = "dev.apkas.net"`
- [ ] 4.2 `envs/production/main.tf` から同じく呼ぶ。`domain_name = "photos.apkas.net"` / `hosted_zone_name = "apkas.net"`
- [ ] 4.3 両環境の `outputs.tf` に、`config/<環境>.env` へ転記する値を足す
- [ ] 4.4 `terraform plan` が既存のサイト配信・DynamoDB のリソースに1つも変更を出さないことを確認する

## 5. 投入 CLI

- [ ] 5.1 `scripts/photo.sh` を書く。`scripts/entry.sh` と同じく環境名を第1引数に取り、`load_env` を通し、`require_env_vars` で必要な変数を検査する
- [ ] 5.2 `src/cli/put-photo.ts` を書く。`--file` と `--date` を受け、キーを `YYYY/MM/DD/<ファイル名>` に組み立てる。`--key` でキー全体を明示できるようにする
- [ ] 5.3 アップロード用バケットへ元写真を置く
- [ ] 5.4 配信先に `medium` が現れるまで短く待つ（上限は数十秒）。上限に達しても失敗とはせず、まだ現れていないことを伝えて終わる
- [ ] 5.5 4つのサイズの URL を表示する。本文にそのまま貼れる形にする
- [ ] 5.6 `npm run photo` として `package.json` に登録する
- [ ] 5.7 環境名を指定せずに実行し、何も投入されないまま失敗することを確認する

## 6. 設定とドキュメント

- [ ] 6.1 `config/staging.env.example` と `config/production.env.example` に、アップロード用バケット名と写真の配信 URL を足す（lambroll のための値は足さない）
- [ ] 6.2 README に、写真のキー規約（`YYYY/MM/DD/<ファイル名>`）と URL 規約（`/<size>/<キー>.webp`）を書く
- [ ] 6.3 README の「必要なツール」に lambroll を足す
- [ ] 6.4 README に Lambda のデプロイ手順を書く。インフラは `terraform apply`、コードは `npm run deploy:lambda -- <環境>` で、コードだけを直したときに apply は要らないことを明記する
- [ ] 6.5 README に、`lambroll deploy` の直後は `terraform plan` で差分が出ないことを確かめる、と書く。`ignore_changes` の並びが `function.jsonnet` と食い違っていないかを見張る唯一の手段になる
- [ ] 6.6 README に写真の投入手順を書く
- [ ] 6.7 README に写真を消す手順を書く（両方のバケットから手で消し、invalidate する。自動では連鎖しないこと）
- [ ] 6.8 README のディレクトリ構成に `lambda/` と `modules/photos/` を足す

## 7. staging での確認

### 適用とデプロイ

- [ ] 7.1 `terraform apply` を実行する。証明書の DNS 検証が通ることを確認する。この時点では関数は placeholder のまま
- [ ] 7.2 placeholder のまま写真を投入し、変換されずに終わること、記録に「まだ lambroll でデプロイされていない」と残ることを確認する（この窓の失敗が読み取れる形になっているかの確認）
- [ ] 7.3 `npm run deploy:lambda -- staging` で実装を載せる。tfstate から値が引けていること（ロール・環境変数・メモリ・タイムアウト）を関数の設定で確認する
- [ ] 7.4 直後に `terraform plan` を実行し、差分が出ないことを確認する。差分が出たら `ignore_changes` に並べ忘れがある
- [ ] 7.5 7.2 で投入した写真をもう一度投入し、今度は変換されることを確認する
- [ ] 7.6 コードを1行変えて `npm run deploy:lambda -- staging` だけを実行し、`terraform apply` なしで反映されることを確認する（別ライフサイクルになっていることの確認）

### 生成されるもの

- [ ] 7.7 長辺 4000px 程度の横長の写真を投入し、4つの長辺が 240 / 960 / 1920 / 3840 になること、いずれも元と同じ縦横比であることを確認する
- [ ] 7.8 縦位置の写真を投入し、指定の長さが**高さ**に適用されることを確認する
- [ ] 7.9 長辺 1000px 程度の写真を投入し、`medium` と `large` が拡大されずに 1000px で、かつ**どちらも存在する**ことを確認する
- [ ] 7.10 PNG を投入し、出力が WebP になることを確認する

### 付随情報

- [ ] 7.11 GPS・撮影日時・機材名を含む写真を投入し、4つの出力の metadata を読み出して、元写真に由来する項目がひとつも残っていないことを確認する（`exiftool` などで）
- [ ] 7.12 EXIF Orientation を持つ縦位置の写真を投入し、metadata を持たないビューアで開いても向きが正しいことを確認する
- [ ] 7.13 広い色空間で記録された写真を投入し、元写真と並べて色が変わっていないことを確認する（7.11 とは別の検査になる）

### 元写真

- [ ] 7.14 派生画像の生成後も、アップロード用バケットに元写真が残っていることを確認する
- [ ] 7.15 元写真を配信ドメインから取得できないことを確認する
- [ ] 7.16 同じキーに別の元写真を上書きし、上書き前の版をバージョニングから取り戻せることを確認する

### 再投入と失敗

- [ ] 7.17 同じキーに別の内容の写真を投入し、4つとも新しい内容に入れ替わることを確認する。invalidation が発行されていることも確認する
- [ ] 7.18 初回の投入では invalidation が発行されていないことを確認する
- [ ] 7.19 画像でないファイルを置き、配信先に何も置かれないこと、失敗が記録に残ること、再試行されずに終わることを確認する
- [ ] 7.20 その直後に正常な写真を投入し、通常どおり生成されることを確認する
- [ ] 7.21 HEIC を投入し、読めるかどうかを確認する。読めない場合は README に「JPEG に変換してから投入する」と書く（design の Open Question）

### 配信

- [ ] 7.22 `https://photos.dev.apkas.net/medium/<キー>.webp` が認証なしで返ること、証明書が有効であることを確認する
- [ ] 7.23 `medium` の URL のサイズ名だけを `thumbnail` / `small` / `large` に差し替えて、いずれも同じ写真の別サイズが返ることを確認する
- [ ] 7.24 HTTP で要求して HTTPS にリダイレクトされることを確認する
- [ ] 7.25 配信用・アップロード用のいずれも、バケットのオブジェクト URL に直接アクセスして拒否されることを確認する
- [ ] 7.26 存在しないキーと、定義されていないサイズ名でエラーが返り、画像が返らないことを確認する
- [ ] 7.27 配信ドメインの根と、サイズ名だけのパスを要求し、オブジェクトの一覧が返らないことを確認する
- [ ] 7.28 同じ写真を2度要求し、2度目が CDN のキャッシュから返ること（`X-Cache: Hit from cloudfront`）を確認する

### サイトとの独立

- [ ] 7.29 `npm run deploy -- staging` を実行したあと、配信中の写真がすべて生きていることを確認する
- [ ] 7.30 写真を投入したあと、日記サイトの配信物が変化していないことを確認する
- [ ] 7.31 staging に投入した写真が production の配信ドメインに現れないことを確認する（production の適用後）

## 8. production への展開

- [ ] 8.1 `npm run check` が通ることを確認する
- [ ] 8.2 production で `terraform apply` → `npm run deploy:lambda -- production` の順に実行する
- [ ] 8.3 直後に `terraform plan` が差分を出さないことを確認する
- [ ] 8.4 `config/production.env` に output を転記する
- [ ] 8.5 実際の写真を1枚投入し、7章の主要な確認（4サイズ・EXIF なし・向き・色・URL 規約・直接アクセス拒否）を production でもう一度行う
- [ ] 8.6 日記サイトの配信が変わっていないことを確認する（本文の参照は旧ホストのまま。この change でページの見た目は1つも変わらない）
