## 1. キーの規約を1箇所にまとめる

投入の入口が2つになる前に、キーを決める規則の宣言元を1つにしておく。ここでは手元の CLI の挙動を変えない。

- [ ] 1.1 `src/lib/photo.ts` に、日付とファイル名から元写真のキーを組み立てる関数を足す（`YYYY/MM/DD/<ファイル名>`）。既に同じファイルにある `photoKeyOf` / `photoUrlOf` と並べ、**投入から配信までの規約がこのファイルに揃っている**状態にする
- [ ] 1.2 `src/cli/put-photo.ts` の `keyOf` を 1.1 の関数を呼ぶ形に直す。`--key` の分岐はそのまま残す。CLI の出力と挙動が変わらないことを確認する
- [ ] 1.3 `@aws-sdk/s3-presigned-post` を依存に足す。版は既存の `@aws-sdk/client-s3` と揃える

## 2. Terraform: 編集アプリケーションの権限と受け渡し

写真の module（バケット・CloudFront・変換 Lambda）には手を入れない。

- [ ] 2.1 `terraform/modules/editor/variables.tf` に、アップロード用バケットと配信用バケットの ARN を受け取る変数を足す。**名前は受け取らない**（`function.jsonnet` が tfstate から直接読むため、同じ値が2経路で渡る状態を作らない）
- [ ] 2.2 `terraform/modules/editor/main.tf` の IAM ポリシーに3つのステートメントを足す（design.md 決定7）。アップロード用バケット `/*` への `s3:PutObject`、配信用バケット `/*` への `s3:GetObject`、配信用バケットへの `s3:ListBucket`
  - **アップロード用バケットへの `s3:GetObject` は与えない。** 元写真は付随情報を除去する前のもので、撮影場所を含みうる。置ける入口が、置いたものを持ち出せる経路になってはならない理由をコメントに残す
  - **`s3:ListBucket` が要る理由**（持たない主体には「無い」が 403 で返り、「まだ無い」と「読めない」を区別できない）をコメントに残す。変換 Lambda の `ProbeDerivatives` と同じ事情であることを指しておく
  - 配信用バケットへの書き込みと写真配信の CloudFront への権限を**与えない**ことを、既存の「S3 と CloudFront への権限は与えない」のコメントとともに書き直す
- [ ] 2.3 `terraform/envs/staging/main.tf` と `terraform/envs/production/main.tf` で、`module.photos` の出力を `module.editor` に渡す。バケットの ARN を出力していなければ `terraform/modules/photos/outputs.tf` に足す
- [ ] 2.4 `terraform fmt -recursive` と、backend を外した複製での `terraform validate` を staging・production の両方で通す

## 3. 設定の受け渡し

新しい転記を作らない。値の出どころは tfstate（Lambda）と `config/<環境>.env`（手元）のまま。

- [ ] 3.1 `editor/function.jsonnet` の `Environment.Variables` に `PHOTO_UPLOAD_BUCKET` / `PHOTO_BUCKET` / `PHOTO_URL` を足す。いずれも tfstate から読む（バケット名は `module.photos` のリソースから、URL は `output.photo_url` から）
- [ ] 3.2 `scripts/dev-editor.sh` の `require_env_vars` にこの3つを足し、起動時の表示にも出す。**`load_env` が `config/<環境>.env` を `set -a` で読むので値は既に来ている**ので、足すのは欠けたときに気づく仕組みだけである
- [ ] 3.3 `config/staging.env.example` / `config/production.env.example` の「編集アプリケーション」の節にある「ここに足すものはない」を直す。写真の3つを編集アプリケーションも読むようになったことを書く（**転記は増えない**ことも併せて書く）

## 4. 投入の資格と完了の確認

画面から切り離した形で先に用意する。

- [ ] 4.1 presigned POST を作る処理を書く（design.md 決定2・3・6）。`key` は `<日付>/${filename}`、policy の条件は `["starts-with", "$key", "<日付>/"]` と `content-length-range` 1〜50MB、`Fields` に `success_action_redirect`、期限は 15 分
  - `Content-Type` のフィールドは**置かない**（決定9）。理由をコメントに残す
  - `${filename}` が S3 側で置換される変数であること、日付の閉じ込めが `starts-with` によることを書き残す
- [ ] 4.2 派生画像が出来たかを見る処理を書く。配信用バケットの `medium` に対する `HeadObject` を行い、**署名した時刻より後に書かれているか**で判定する（決定4）。404 だけを「まだ無い」として扱い、それ以外の失敗は投げる（`put-photo.ts` の `probeUpdatedAt` と同じ形）
  - 署名時刻より**古い**派生画像が存在した場合は「以前にも使われたキーである」＝差し替えとして区別できるようにする
  - **配信 URL を叩いて調べない**こと、その理由（まだ無いあいだの 403 が CDN に載る）をコメントに残す
- [ ] 4.3 S3 から戻ってきた `key` を検証する処理を書く。署名した日付の下にあることを確かめ、外れていれば結果を出さない

## 5. 投入の画面

- [ ] 5.1 `/photos/new` を作る。日付（既定は JST の当日、query で受け取れる）とファイルを選ぶフォームで、`action` はアップロード用バケット、`method` は POST、`enctype` は `multipart/form-data`。4.1 の隠しフィールドを並べる
  - `success_action_redirect` は `<自分の URL>/photos/uploaded` に、署名時刻と日付と戻り先を query として載せる
  - 応答に `Cache-Control: no-store` を付ける（一時的な資格が載るため）
  - 上限（50MB）と、超えるものは手元の CLI から入れることを画面に書く
- [ ] 5.2 `/photos/uploaded` を作る。戻ってきた `key` から4つのサイズの URL を `photoUrlOf` で組み立てて並べ、**本文にそのまま貼れる Markdown**（`medium` を使う。日別ページの拡大表示が `/medium/` → `/large/` の差し替えに依存しているため）を選択できる形で出す
  - 4.2 の判定を行い、まだなら `refreshSeconds` を渡して数秒後に読み直す。完了したら読み直しをやめる（`/publish` と同じ形）
  - 差し替えだった場合はその旨を出す
  - `return` が `/entries/` で始まるときだけ「編集に戻る」リンクを出す。**自動では飛ばさない**
- [ ] 5.3 押す前にファイルの大きさを見る小さなスクリプトを、**任意の上乗せとして**足す。動かなくても投入は成立し、上限を超えたときに S3 の生の XML を見ることになるだけであることをコメントに残す。`accept` 属性も併せて付ける
- [ ] 5.4 `editor/src/lib/auth/session.ts` に、**`SameSite` を `Strict` にすると S3 からの戻りが未認証になる**ことを書き残す（Google の認証からの戻りと同じ性質）

## 6. 編集画面からの導線

- [ ] 6.1 `editor/src/pages/entries/[date].astro` に**「保存して写真を追加」**を足す。既存の保存と同じ経路（`putEntry`）を通ってから `/photos/new?date=<日付>&return=/entries/<日付>` へ送る。保存に失敗したときは移動せず、入力を残したまま失敗を示す（既存の保存と同じ扱い）
  - ボタンの文言で保存を伴うことが分かる形にする（`entry-editing` に足した要件）
- [ ] 6.2 `editor/src/pages/index.astro` の入口に、日付を指定しない単独の投入への導線を足す
- [ ] 6.3 `/photos/*` が `middleware.ts` の `PUBLIC_PATHS` に**入っていない**ことを確認する（認証を通らずに資格が得られる経路を作らない）

## 7. 検証

- [ ] 7.1 `npm run check` を通す（`astro check` は編集アプリケーション側も見る）
- [ ] 7.2 手元で `npm run dev:editor -- staging` を動かし、`/photos/new` が資格を出せること、3.2 の確認が欠けた設定で落ちることを見る
  - 手元からは S3 への POST が本物の staging バケットに届く。戻り先が `http://localhost:4321` になることも確かめる
- [ ] 7.3 staging に `terraform apply` し、`npm run deploy:editor -- staging` を実行する。`terraform plan` が差分を出さないことを確認する（`function.jsonnet` が設定する項目は `ignore_changes` に並んでいるが、環境変数を足したので念のため見る）
- [ ] 7.4 staging で実機の確認を行う
  - 通常の投入 → 4つの URL が示され、完了が示されたあとに URL を開くと画像が返る
  - **CLI との一致** → 同じ日付・同じファイル名で `npm run photo` から投入したものと同じキー・同じ URL になる
  - **差し替え** → 既にあるキーへ別の内容を投入し、完了表示が古い派生画像で満たされないこと、差し替えと示されることを見る
  - **大きい写真** → 10MB を超える写真が投入できる（決定1 が回避した上限に触れないこと）
  - **上限超過** → 50MB を超えるファイルで、5.3 のスクリプトが押す前に止めること、およびスクリプトを無効にすると S3 のエラーになること
  - **期限切れ** → `/photos/new` を開いたまま 15 分以上放置してから送ると失敗し、元写真が置かれないこと
  - **書きかけの本文** → 本文を入力した状態から 6.1 で移動し、戻ったときに内容が残っていること
- [ ] 7.5 編集アプリケーションの実行ロールを引き受けて、**与えていない操作が拒否される**ことを確かめる
  - アップロード用バケットの `GetObject`・`ListBucket` → 拒否
  - 配信用バケットの `PutObject`・`DeleteObject` → 拒否
  - 写真配信の CloudFront への `CreateInvalidation` → 拒否
  - 他方の環境のバケット → 拒否
- [ ] 7.6 production に同じ順で適用し、7.4 の通常の投入だけを確認する

## 8. ドキュメント

- [ ] 8.1 README の写真の手順に、ブラウザからの経路を書く。上限（50MB）、超えるときは CLI を使うこと、生成が非同期であること、キーの規則が CLI と同じであることを含める
- [ ] 8.2 README の編集アプリケーションの節に、実行ロールが写真について持つ権限（置ける・出来たかを見られる／読めない・配信元は書けない）を書く
