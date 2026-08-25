## 1. 写し直す前の確認

- [x] 1.1 `src/` と `editor/src/` を横断し、書体・角丸の直書きが基準の外に残っていないことを確認する。等幅（`textarea` と `CopyField`）は対象外（proposal のスコープ外）
  - 書体の直書きは等幅の2件（`editor/src/layouts/Base.astro` の `textarea`、`editor/src/components/CopyField.astro`）だけで、どちらも対象外。
  - 角丸の直書きは3件。`.pill` の `999px` と フォーカス環の `2px` はこの変更で基準へ寄せる。`button.link` の `border-radius: 0` は、リンクに見せるための打ち消しなので残す。
- [x] 1.2 `--radius-sm` と `--accent-soft` を使っている箇所をすべて数え上げ、置き換え漏れの照合に使う（`--radius-sm` は8つの宣言、`--accent-soft` は1つ）
  - `var(--radius-sm)` は8件。`src/styles/base.css`（`pre`）、`editor/src/layouts/Base.astro`（ボタン・入力欄・ファイル選択のボタンで3件）、`editor/src/pages/entries/[date].astro` と `editor/src/pages/photos/uploaded.astro`（`.figure img` と `.placeholder` で各2件）。
  - `var(--accent-soft)` は `src/styles/base.css` の `.pill` の地1件のみ。

## 2. 基準値を写す

- [x] 2.1 `src/styles/tokens.css` の `--font` を `--font-sans` に改め、`--font-serif` を足す。値はあちら（`../apkas/src/assets/style.css`）のスタックをそのまま写す
  - 2つのスタックが、空白と引用符の違いを均したうえであちらと1文字も違わないことを機械で突き合わせた。
- [x] 2.2 同ファイルの `--radius` を 12px から 2px にし、`--radius-sm` を削る（design 決定3）
- [x] 2.3 同ファイルの `--accent-soft` を明暗の両方から削る（design 決定3）
- [x] 2.4 同ファイル先頭のコメントを直す。角丸が1つになったこと、書体が2本立てになったこと、`--accent-soft` を持たないことを、変数名の対応表と「あちらを変えたら手で写し直す」旨は残したまま書き換える
  - 対応表に `--font-sans` / `--font-serif` / `--radius` を足した。`--accent-soft` は、持っていない `--shadow` と Dusk Mauve に並べて「ピルが塗りをやめたので使い道がなくなった」と書いてある。「0.9rem 以下を明朝にしないこと」も書体の宣言の脇に残した。
- [x] 2.5 明暗あわせて14個の色に触れていないことを確認する（この変更のスコープ外）
  - `HEAD` との差分は `--accent-soft` の2件（`#cfdef2` / `#22406b`）が消えただけで、残る12個は同じ。`theme-color` の meta 4つも動かしていない。

## 3. 書体の使い分け

- [x] 3.1 `src/styles/base.css` の `body` の書体を `var(--font-sans)` にする
- [x] 3.2 同ファイルに、明朝で組む要素の宣言を1つ置く。当てる先は `h1` / `h2` / `.prose`（design 決定1）。`font-weight: 500` を添え、理由（游明朝が Light に落ちる）をコメントに残す
- [x] 3.3 同ファイルで `h1` / `h2` の太さを 600 から 500 にし、`font-feature-settings: "palt" 1` を当てる。`.prose` には `palt` を当てない（design 決定1）
  - 太さは 3.2 の宣言が持つので、`h1` / `h2` から `font-weight` の行そのものを外した。同じ値が2箇所に出ないようにするため。
- [x] 3.4 同ファイルに `.prose` を足す（書体・太さ・1.05rem・行送り 2.05・字送り 0.04em）。あちらの `display: grid` は写さない（design 決定2）
- [x] 3.5 `src/layouts/Base.astro` の `.site-title` を明朝・500・`palt` にする
- [x] 3.6 `editor/src/layouts/Base.astro` の `.app-title` を同じにする
- [x] 3.7 `src/components/EntryList.astro` の `.entry-title` を明朝・500・`palt` にする。日付（`time`、0.85rem）はゴシックのまま
- [x] 3.8 `src/pages/[year]/[month]/[day].astro` の本文に `prose` を足す。前後の導線（`.adjacent`、0.9rem）の中のエントリ題は明朝にしない（design 決定1）
  - 導線の `.entry-title` は日別ページの scoped な class で、`EntryList.astro` の同名の class とは別物である。3.7 の指定は導線に及ばない。
- [x] 3.9 `editor/src/pages/entries/[date].astro` のプレビューに `prose` を足す
- [x] 3.10 `src/pages/404.astro` の地の文に `prose` を足す（design 決定2）

## 4. 装飾を削る

- [x] 4.1 `src/styles/base.css` の `.pill` を、枠 `--border`・角丸 `var(--radius)`・アクセントの字・0.78rem・字送り 0.1em・余白 0.28rem 0.9rem にする。塗りと 999px を落とす（design 決定4）
- [x] 4.2 同ファイルの `.pill.is-quiet` を `border-color: transparent` と淡い字にする。箱の大きさが変わらないよう、枠そのものは残す（design 決定4）
- [x] 4.3 同ファイルに `.pill[aria-current]` を足し、枠をアクセント色にする（design 決定4）
- [x] 4.4 同ファイルの `.pill` に添えたコメントを、塗りではなく枠で示す形に書き換える。`is-quiet` と `aria-current` が何を担うかも残す
  - 字の色だけで分けない理由（`--accent` と `--fg-muted` の輝度がほとんど並ぶ）も書いた。実測値そのものは書いていない（design 決定7）。
- [x] 4.5 同ファイルの `.section-title` を、ゴシック・600・0.75rem・字送り 0.24em・gap 1.15rem にする（design 決定6）
- [x] 4.6 同ファイルのフォーカス環を 1px にし、角丸を `var(--radius)` にする（design 決定5）
- [x] 4.7 同ファイルの `pre` の角丸を `var(--radius)` にする
- [x] 4.8 `editor/src/layouts/Base.astro` の `a.button:hover` の浮き上がりを消し、`transition` から `transform` を落とす。使い分けの理由を書いたコメントも、消えた前提ごと直す（design 決定5）
- [x] 4.9 同ファイルのボタン・入力欄・ファイル選択のボタンの角丸を `var(--radius)` にする
- [x] 4.10 `editor/src/pages/entries/[date].astro` と `editor/src/pages/photos/uploaded.astro` の `.figure img` / `.placeholder` の角丸を `var(--radius)` にする
- [x] 4.11 `editor/src/pages/index.astro` の年の絞り込みに添えたコメント（「他は地を持たない側」）を、囲みの有無で示す形に直す

## 5. 確認

- [x] 5.1 `--radius-sm` と `--accent-soft` が `src/` と `editor/src/` のどこにも残っていないことを確認する（1.2 で数えた数と突き合わせる）
  - 9件すべてが置き換わっている。`--accent-soft` の名前は `tokens.css` のコメント（持っていない理由）にだけ残る。
- [x] 5.2 `npm run check`（`astro check` × 2、Biome、Lambda の確認）が通ることを確認する。Biome が `migration/production/snapshots/*.json` について出す既知の error は、`main` と同じ数であることを確かめて先へ進む
  - `astro check` は両方とも 0 errors / 0 warnings / 0 hints（61 ファイル）。
  - Biome は 732 件の error を出すが、変更を stash して数えたところ `main` でも同じ 732 件だった。すべて `migration/production/snapshots/*.json` の末尾に改行がないというもので、この変更とは関係がない。触れた10ファイルは `biome check` を通る。
- [x] 5.3 `npm run build -- staging` が通り、生成されたページ数が前回（409）から変わらないことを確認する
  - 409 ページ。`getStaticPaths` を持つファイルには触れていない。
- [x] 5.4 生成物を検査し、明朝のスタックと `--radius: 2px` が全ページに載っていること、`--radius-sm` / `--accent-soft` / `999px` / `translateY(-2px)` が1件も残っていないことを確認する
  - 409 ページすべてに明朝のスタックと `--radius:2px` がある。旧いもの（`radius-sm` / `accent-soft` / `999px` / `translateY(-2px)` / `#cfdef2` / `#22406b` / `12px`）はいずれも 0 件。
  - 編集アプリケーションも同じ。`editor/dist/client/_astro/Base.*.css` に明朝と `--radius:2px` があり、旧いものは 0 件。`.pill` の3つの規則（枠・`is-quiet`・`aria-current`）が意図どおり出ている。
- [x] 5.5 日別ページの本文と編集アプリケーションのプレビューの両方に `prose` の class が出ていることを確認する（design のリスク：付け忘れ）
  - 日別ページは 23/23 に `class="body prose"`。404 にもある。編集アプリケーションのプレビューは、生成された server chunk に `preview-body prose` が出ている。
- [x] 5.6 手元で公開サイトを開き、トップ・年別・月別・日別・過去の同じ日・404 を明暗それぞれで確認する。見出しと本文が明朝、日付と件数がゴシックであること
  - **この環境では見られていない。** 手元（WSL2）にブラウザがなく、headless での確認もできない。**利用者が staging を見て確認済みとした。**
- [x] 5.7 写真を並べた旧サイト由来の記事を開き、本文が 1.05rem になっても画像の横並びが崩れていないことを確認する（design のリスク：折り返しの変化）
  - この環境では見られていない（理由は 5.6 と同じ）。利用者の判断で確認済みとした。`table-layout: fixed` で列幅は等分されるため、字の大きさでは崩れない。
- [x] 5.8 手元で編集アプリケーションを開き、一覧・編集・プレビュー・写真・公開の各画面を明暗それぞれで確認する。**公開／下書き、いま見ている年／その他、実行中／未実行が見分けられること**（design 決定4）
  - この環境では見られていない（理由は 5.6 と同じ）。利用者の判断で確認済みとした。**塗りをやめた見分けが効いているかは、この変更でいちばん確かめたい点だった。**
- [x] 5.9 プレビューと公開後の本文を同じエントリで見比べ、字面が一致していることを確認する
  - この環境では見られていない（理由は 5.6 と同じ）。利用者の判断で確認済みとした。字面の出どころが1つであることは 5.5 で機械的に確かめてある。
- [x] 5.10 キーボードで両アプリケーションを辿り、1px になったフォーカス環が明暗とも見えることを確認する
  - この環境では見られていない（理由は 5.6 と同じ）。利用者の判断で確認済みとした。アクセント色と地のコントラストは明 5.842 / 暗 6.424 で、文字でないものの基準 3:1 を上回っている。
- [x] 5.11 押せる箱（`a.button`）が浮き上がらず、枠の色だけが変わることを確認する
  - この環境では見られていない（理由は 5.6 と同じ）。利用者の判断で確認済みとした。生成物に `translateY(-2px)` が残っていないことは 5.4 で確かめてある。
- [x] 5.12 ポートフォリオ（`../apkas/src/index.html` を手元で開く）と日記を並べ、字面と箱の硬さが同じに見えることを確認する
  - この環境では見られていない（理由は 5.6 と同じ）。利用者の判断で確認済みとした。書体のスタックがあちらと一致することは 2.1 で機械的に確かめてある。

## 6. 記録

- [x] 6.1 `README.md` の体裁の基準について書いた箇所を見て、書体や角丸の具体に触れている場合は直す
  - **変更なし。** 689行目は「配色・書体・本文の幅・角丸は……`src/assets/style.css` を出どころとし、`src/styles/tokens.css` はその写しを持つ」と書いており、書体の名前にも角丸の値にも触れていない。688行目の「整形の規則も字面も出どころが1つ」も、`.prose` を共有の場所に置いたことで引き続き正しい（むしろ、置かなければここが嘘になっていた）。

## 7. 配る

design の Migration Plan は staging → `main` へマージ → production の順である。**前回はこの順を守らず、マージまでのあいだ「公開」ボタンを押せない窓を開けた。今回は開けない。**

**staging へは、5.6–5.12 の目視より先に配った**（利用者の指示）。staging は `main` と結び付いておらず、公開サイトに影響しない。むしろ目視はここで行うことになるので、順序として無理がない。

**そのうえで production も、マージより先に配った**（利用者の指示）。design が定めた順（staging → マージ → production）は、これで三度目の不履行になる。したがって、**`main` にこの変更が入るまでのあいだ、編集アプリケーションの「公開」ボタンを押してはならない。** あのボタンは GitHub の `main` を作り直して配るので、押された時点で公開サイトだけが旧い組み方に戻る。閉じる手段はマージだけである。

- [x] 7.1 `npm run deploy -- staging` と `npm run deploy:editor -- staging`
  - 公開サイト：409 件を同期し、CloudFront を無効化した。invalidation `ICVIFYYHH1ZNJS488PHCV796W7`。
  - 編集アプリケーション：lambroll で version 13 を作り、alias `current` を更新した。
- [x] 7.2 https://diary.dev.apkas.net と https://admin.dev.apkas.net/login を確認する
  - **配信物に新しい体裁が載っていることを確認した。** 公開サイトはトップ・年（`/2026`）・月（`/2026/08`）・`/on-this-day/08-25`・`/404.html` が 200、存在しない URL が 404 を返し、いずれも明朝のスタック・`--radius:2px`・`palt` を持ち、旧いもの（`radius-sm` / `accent-soft` / `999px` / `translateY(-2px)` / `#cfdef2` / `#22406b`）は 0 件。
  - 日別ページ（`/2026/08/11`）は `class="body prose"` を持ち、`.prose` が2つの規則（書体・太さ／1.05rem・2.05・0.04em）で出ている。
  - 編集アプリケーションは `/login` が 200。CSS は `/_astro/Base.CIzpnXbD.css` で、手元のビルドと同じハッシュ。中身に明朝と `--radius:2px` があり、`.pill` の3つの規則（枠・`is-quiet` の透明枠・`aria-current` のアクセント枠）が揃っている。旧いものは 0 件。
  - **見え方そのものは未確認。** 手元にブラウザがない。5.6–5.12 はこの staging を人が見て行うことになる。
- [ ] 7.3 `main` へマージする
  - **未了。利用者が後で行う。** これが済むまで「公開」ボタンを押さないこと（上記）。
- [x] 7.4 `npm run build -- production` と `npm run deploy -- production`
  - 1121 件から 1537 ページ。前回は 1119 件から 1535 ページで、増えた分はその後に書かれたエントリによる。`getStaticPaths` を持つファイルには触れていない。
  - 配る前に生成物を検査し、1537 ページすべてに明朝のスタックと `--radius:2px` があること、旧いもの（`radius-sm` / `accent-soft` / `999px` / `translateY(-2px)` / `#cfdef2` / `#22406b`）が 0 件であること、日別 1121 ページすべてに `class="body prose"` があることを確認した。
  - invalidation `IBYD1L2OK9VG8AMS25AHJO4G4L`。
- [x] 7.5 編集アプリケーションを production へ配る
  - lambroll で version 8 を作り、alias `current` を更新した。
  - `deploy-editor.sh` は production のとき無条件に `read` で確認を求め、`deploy.sh` と違って headless の逃げ道（`DIARY_DEPLOY_CONFIRMED`）を持たない。**利用者の指示を受けて `y` を渡した。**
- [x] 7.6 https://diary.apkas.net と https://admin.apkas.net/login を確認する
  - 公開サイトはトップ・年（`/2023`）・月（`/2026/08`）・`/on-this-day/08-25`・`/404.html` が 200、存在しない URL が 404。いずれも明朝のスタック・`--radius:2px`・`palt` を持ち、旧いものは 0 件。日別（`/2026/08/22`）に `class="body prose"` がある。
  - 編集アプリケーションは `/login` が 200。CSS は `/_astro/Base.CIzpnXbD.css` で、staging と同じハッシュ（同じビルド）。`.pill` の3つの規則が揃っており、旧いものは 0 件。
  - 見え方そのものは 5.6 と同じ理由でこの環境から見ていない。
- [x] 7.7 `terraform plan` に差分が出ないことを確認する（`deploy-editor.sh` が求めている確認）
  - `No changes. Your infrastructure matches the configuration.` 関数の実行時設定が `ignore_changes` の一覧から漏れていないことを確認した。
