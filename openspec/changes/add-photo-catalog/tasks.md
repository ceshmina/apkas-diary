## 1. 目録の型と読み書き

投入側（CLI・編集アプリケーション）が共有する1枚の宣言元を先に作る。ここでは呼び出す側にまだ手を入れない。

- [x] 1.1 `src/lib/store/photo.ts` に写真の記録の型を置く。属性は `id` / `date` / `filename` / `sourceKey` / `url` / `exif` / `width` / `height` / `renderedAt` / `createdAt` / `updatedAt`、および `type = 'photo'`（design.md 決定1・3）
  - キーの組み立て（`pk = PHOTO#<YYYY-MM-DD>` / `sk = <ファイル名>`）をこのファイルだけが知る形にする。`entry.ts` の `entryPk` / `entrySk` と同じ並びにする
  - **`gsi1pk` / `gsi1sk` を書かない**こと、その結果として写真が GSI1 に載らず公開サイトの生成の入力が変わらないことをコメントに残す
  - `url` に入れるのは `medium` の配信 URL 1つだけであること、他のサイズはサイズ名の差し替えで導けること（`photo-delivery` の要件）を書き残す（決定5）
- [x] 1.2 元写真のキーから日付とファイル名を取り出す関数を `src/lib/photo.ts` に足す。`photoSourceKeyOf` の逆にあたる。`YYYY/MM/DD/<ファイル名>` に沿わないキーでは `undefined` を返す
  - **日付の軸から外れたキー（CLI の `--key`）は目録に載せられない**ことが、この関数の戻り値で表せる形にする
- [x] 1.3 `src/lib/store/photo.ts` に投入側の書き込みを置く。`UpdateItem` で自分の持ち分だけを `SET` し、`id` と `createdAt` は `if_not_exists` で包む（決定3・決定4）
  - **`PutItem`（全体置換）にしない理由**——変換側が書いた `exif` を消すため——をコメントに残す。`putEntry` が `PutItem` なのと逆になることも書いておく
  - 何度実行しても同じ結果になること（`/photos/uploaded` が数秒ごとに読み直されるため）を書き残す
- [x] 1.4 `src/lib/store/photo.ts` に日付から写真を引く読み取りを置く。`pk = PHOTO#<日付>` の 1 パーティションに閉じる `Query`。並びは `sk`（ファイル名）の昇順
- [x] 1.5 `npm run check` を通す

## 2. CLI からの登録

- [x] 2.1 `src/cli/put-photo.ts` に、投入のあとで目録へ登録する処理を足す。登録は生成を待つ前に行う（記録が先にあることで、編集画面の一覧に「準備中」として並ぶ）
- [x] 2.2 `--key` で日付の規約に沿わない場所へ置いた場合は登録せず、**登録しなかったことを出力に出す**（`photo-catalog` の「日付の軸から外れたキーへの投入」）。黙って落とさない
- [x] 2.3 `scripts/photo.sh` の `require_env_vars` に `DIARY_TABLE_NAME` を足す。**`config/<環境>.env` に既にある値なので転記は増えない**（決定12）
- [x] 2.4 登録の失敗で投入そのものを失敗にしないこと（元写真は既に置かれており、生成は走っている）を確かめる。失敗は出力に出す

## 3. Terraform: 変換 Lambda の権限とテーブルの受け渡し

写真のバケット・CloudFront・S3 の通知の配線には手を入れない。

- [x] 3.1 `terraform/modules/photos/variables.tf` にテーブルの ARN を受け取る変数を足す。**名前は受け取らない**（`function.jsonnet` が tfstate から直接読むため、同じ値が2経路で渡る状態を作らない。編集アプリケーションのバケットと同じ扱い）
- [x] 3.2 `terraform/modules/photos/main.tf` の変換 Lambda の IAM ポリシーに `dynamodb:UpdateItem` を足し、`ForAllValues:StringLike` の `dynamodb:LeadingKeys = ["PHOTO#*"]` を条件に付ける（決定7）
  - **`GetItem` / `Query` / `PutItem` / `DeleteItem` は与えない。** 読むことも消すこともできないことをコメントに残す
  - 条件が日記のエントリ（`ENTRY#<年>`）への到達を断つものであること、**書けたことをもって担保としない**（8.2 で実際に確かめる）ことを書き残す
- [x] 3.3 `terraform/envs/staging/main.tf` と `terraform/envs/production/main.tf` で、`module.storage` のテーブル ARN を `module.photos` に渡す
- [x] 3.5 `terraform/modules/editor/main.tf` に編集アプリケーションが目録を扱うための権限を足す。**既に持っているのは `GetItem` / `PutItem` / `Scan` の3つだけで、`Query` も `UpdateItem` も無かった**
  - `dynamodb:Query`（条件なし）: その日の写真を引く。条件を付けない理由（`Scan` で同じテーブルを丸ごと読めるので、読み取りの片方だけを絞っても境界にならない）をコメントに残す
  - `dynamodb:UpdateItem`（`LeadingKeys` を `PHOTO#*` に限る）: 目録に記録する。**こちらは絞る**理由（エントリへの書き込みを `putEntry` の `PutItem` 1本に保ち、GSI キー属性の付け外しを飛ばした半端な更新の経路を作らない）をコメントに残す
  - 同じ `LeadingKeys` でも変換 Lambda とは狙いが違うことを書き分ける
  - `DeleteItem` / `BatchWriteItem` を与えないことは変えない
- [x] 3.4 `terraform fmt -recursive` と、backend を外した複製での `terraform validate` を staging・production の両方で通す

## 4. 変換 Lambda: EXIF の読み取りと目録への書き足し

- [x] 4.1 `lambda/photo-resize/package.json` に `exif-reader` と `@aws-sdk/client-dynamodb` / `@aws-sdk/lib-dynamodb` を足す。版は既存の AWS SDK に揃える
- [x] 4.2 `lambda/photo-resize/function.jsonnet` の `Environment.Variables` に `DIARY_TABLE_NAME` を足す。値は tfstate（`module.storage.aws_dynamodb_table.diary.name`）から引く（決定12）
- [x] 4.3 元写真から撮影に関する情報を取り出す処理を書く。sharp の `metadata()` が返すバッファを `exif-reader` に渡し、**取り出す項目を列挙して選ぶ**（決定6）
  - 対象は `Make` / `Model` / `LensModel` / `FocalLength` / `FNumber` / `ExposureTime` / `ISO` / `DateTimeOriginal`
  - **位置情報を読み取る箇所を作らない。** 読み取ったうえで除外する形にしない理由（書き忘れが安全な側に倒れる）をコメントに残す。変換が付随情報を「引き継ぐ指定を書かない」ことで除去しているのと同じ判断であることを指しておく
  - 解釈に失敗しても例外を投げない。項目が欠けたまま先へ進む
- [x] 4.4 寸法を `rotate()` を適用したあとの値から取る。目録の寸法と配信される画像の向きが食い違わないようにする（決定6）
- [x] 4.5 派生画像を配信先へ書いたあとに、目録へ `exif` / `width` / `height` / `renderedAt` を `UpdateItem` で書き足す。`id` と `createdAt` は `if_not_exists` で包み、**投入側より先に走っても記録が成立する**ようにする（決定4）
  - キーの組み立てと属性の名前は `src/lib/store/photo.ts` と同じものを**二重に持つ**。共有しない理由（パッケージが独立している）と、**どちらかを変えるときは両方を直す**ことをコメントに残す（決定11）。キーと URL の規約が既に二重になっているのと同じ扱いである
  - 日付の規約に沿わないキーでは書き込みを行わない（1.2 と同じ判定を持つ）
- [x] 4.6 目録への書き込みの失敗で例外を投げない。`console.error` に残して終える（`photo-ingest` の「目録への記録の失敗は派生画像の生成を妨げない」）
  - 書き込みは派生画像を置いたあとに行う。順序を入れ替えないことを書き残す
- [x] 4.7 `npm --prefix lambda/photo-resize install` を実行し、`npm run check` を通す

## 5. 編集アプリケーション: 投入結果からの登録

- [x] 5.1 `editor/src/pages/photos/uploaded.astro` の描画で、受け取ったキーそれぞれを目録へ登録する（決定9）。`acceptReturnedKey` を通ったキーだけを対象にする
- [x] 5.2 登録が失敗しても結果の表示を止めない。投入と生成は既に済んでおり、**示すべき URL は目録と関係なく組み立てられる**
- [x] 5.3 読み直し（`refreshSeconds`）のたびに登録が走ることを前提に、結果が変わらないことを確かめる（1.3 の `if_not_exists`）

## 6. 編集アプリケーション: 記事編集画面の写真一覧

- [x] 6.1 `editor/src/pages/entries/[date].astro` の描画で、その日の写真を 1.4 の読み取りで引く（決定10）
- [x] 6.2 写真を**フォームの外**に並べる。サムネイル・本文に貼れる記述（`medium`）・各サイズの URL を、`uploaded.astro` と同じ形の要素で出す（`entry-editing` の「投入直後との一致」）
  - 読み取り専用の要素だけで構成し、編集中のタイトルと本文に触れないことを確かめる
- [x] 6.3 `renderedAt` を持たない写真は**画像を出さず**、まだであることを示す（決定8）。まだ無いあいだの要求が CDN に載るのを避ける理由をコメントに残す
- [x] 6.4 写真が1枚もない日は、その旨を出し、フォームの「保存して写真を追加」へ導く。**この節から `/photos/new` へ素のリンクを置かない**——リンクは編集画面を離れるので、書きかけの本文が保存されないまま失われる（`entry-editing` の「保存が起きることの明示」）
- [x] 6.5 一覧の表示が失敗しても編集そのものを止めない。日記を書けることのほうが重い

## 7. エントリの読み取りが写真を拾わないことの確認

コードを足すのではなく、既にある保証が写真の同居によって崩れないことを確かめる。

- [x] 7.1 `scanAllIncludingDrafts` の `type = 'entry'` の条件が、写真のアイテム（`type = 'photo'`）を落とすことを確かめる。**呼び出し側に種類での絞り込みを足さない**（`diary-entry-store` の「呼び出し側での振り分け」）
- [x] 7.2 `getEntry` / `listByYear` / `listByMonth` / `listRecent` / `listAllPublished` のいずれも、写真のアイテムに触れないことを確かめる。前3つは `ENTRY#<年>` のパーティションに閉じ、後2つは GSI1 を読む
- [x] 7.3 `src/lib/store/queries.ts` の該当箇所に、**同じテーブルに写真が同居していること**と、それがこれらの読み取りに現れない理由をコメントとして残す

## 8. staging での検証

- [x] 8.1 適用の順で staging に反映する。`terraform apply` → `npm run deploy:lambda -- staging` → `npm run deploy:editor -- staging`（design.md の Migration Plan）
- [x] 8.2 **`dynamodb:LeadingKeys` の条件が実際に効いていることを確かめる。** 変換 Lambda の実行ロールを引き受け、`ENTRY#2026` に対する `UpdateItem` が拒否されること、`PHOTO#2026-08-13` に対する `UpdateItem` が通ることを両方見る
- [x] 8.3 CLI から写真を投入し、目録に記録が現れること、しばらく後に `exif` と `renderedAt` が埋まることを確かめる
- [x] 8.4 ブラウザから写真を投入し、CLI から投入したものと同じ形の記録になることを確かめる
- [x] 8.5 機材名と GPS 情報を含む写真を投入し、**目録に機材名があり座標が無い**こと、および**派生画像からはどちらも読み取れない**ことを確かめる（`photo-ingest` の「読み取りと除去の両立」）
- [x] 8.6 縦位置の写真を投入し、目録の `width` / `height` が配信される画像の向きと一致することを確かめる
- [x] 8.7 同じキーへ別の内容の元写真を投入し直し、記録が1件のままで `id` が変わらないことを確かめる
- [x] 8.8 撮影に関する情報を持たない画像（スクリーンショットなど）を投入し、記録は作られて項目だけが欠けることを確かめる
- [x] 8.9 `--key` で日付の軸から外れた場所へ投入し、派生画像は生成され、目録には載らず、その旨が出力されることを確かめる
- [x] 8.10 写真を投入した日のエントリを編集画面で開き、写真が並ぶこと・貼れる記述が投入直後の画面と同じであること・書きかけの本文が失われないことを確かめる
- [x] 8.11 生成がまだの写真が「準備中」として示され、生成後の読み直しで画像が出ることを確かめる
- [x] 8.12 `npm run build -- staging` を実行し、生成物と書き出しに写真のアイテムが現れないことを確かめる（`diary-entry-store`）
- [x] 8.13 `lambroll deploy` の直後に `terraform plan` が差分を出さないことを確かめる（`function.jsonnet` に環境変数が増えたため、`ignore_changes` の `environment` が効いていること）

## 9. 記録と後始末

- [x] 9.1 README に写真の目録の節を足す。何が記録され、何が**記録されないか**（位置情報）、記事編集画面から写真をどう扱うかを書く
- [x] 9.2 README の写真を入れる手順に、目録への登録が投入に伴って起きることを追記する。人が登録する操作は無いことを書く
- [x] 9.3 過去に投入した写真が目録に無いこと、それが意図した状態であることを README に残す。既存の記事の表示に影響しないことも書く
- [x] 9.4 `npm run check` と `npm run format` を通す
- [ ] 9.5 production へ 8.1 と同じ順で反映し、8.3 と 8.10 にあたる確認を行う

## 10. 貼れる記述をワンボタンで写す

staging の検証（8章）のあとに足した要望。**production への反映（9.5）はこれを含めてから行う。**

- [x] 10.1 `editor/src/components/CopyField.astro` を作る。記述の入力欄と複製のボタンを持ち、**投入を終えた画面と記事の編集画面の双方が使う**（design.md 決定13）
  - 部品を1つにすることで「双方が同じものを示す」（`entry-editing`）を写しではなく構造で満たすことをコメントに残す
  - **入力欄は残す。** 複製が働かない環境でも記述が読み取れることをコメントに残す
- [x] 10.2 複製の処理を書く。`navigator.clipboard` が無い場合は入力欄を選択するだけにして、**何も起きないまま終わらせない**
  - `?.` で黙って素通りさせない（写せていないのに「写した」と出る）理由をコメントに残す
  - 複製したかどうかがボタンの文言で分かるようにする
- [x] 10.3 `entries/[date].astro` と `photos/uploaded.astro` の記述の欄をこの部品に置き換える。両方から重複していた `.snippet` のスタイルを外す
- [x] 10.4 `npm run check` と `npm run format` を通す
- [x] 10.5 staging へ反映し（`npm run deploy:editor -- staging`）、双方の画面で押して本文に貼れることを確かめる。複数枚並んだ中の1枚を押したとき、その写真の記述だけが得られることも見る
