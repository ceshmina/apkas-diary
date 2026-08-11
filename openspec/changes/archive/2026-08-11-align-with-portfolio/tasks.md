## 1. 基準値を移す

- [x] 1.1 `src/styles/tokens.css` の配色を、ポートフォリオ（`../apkas/src/assets/style.css` の `:root`）の値に置き換える。明暗の両方を移す
- [x] 1.2 同ファイルに `--surface` と `--accent-soft` を足す（明暗の両方）
- [x] 1.3 同ファイルに `--font` `--page` `--radius` `--radius-sm` を足す。`--radius-sm` はポートフォリオにない値であり、この変更で決めたものだとコメントに残す
- [x] 1.4 同ファイルの先頭のコメントに、値の出どころ（`../apkas`）と変数名の対応表（`--fg` = `--ink`、`--fg-muted` = `--muted`、`--border` = `--line`）を書く

## 2. 本文の見え方を合わせる

- [x] 2.1 `src/styles/base.css` の `body` の書体を `var(--font)` に、行送りを 1.9、字間を 0.02em にする。`-webkit-font-smoothing: antialiased` も入れる
- [x] 2.2 `html` に `-webkit-text-size-adjust: 100%` を入れる
  - あわせて `color-scheme: light dark` と `accent-color: var(--accent)` も入れた（design 決定8）。暗い設定で日付の入力欄の暦とファイル選択のボタンが明るい前提のまま出ていたため。
- [x] 2.3 `:focus-visible` にアクセント色のリング（2px、offset 3px）を入れる
- [x] 2.4 `prefers-reduced-motion` の抑制ブロックを入れる
  - `*` は最も弱い指定なので `!important` が要る。Biome の `noImportantStyles` を範囲指定で抑制し、理由をコメントに書いた。写真の拡大表示は Web Animations API を使っており、この CSS の影響を受けない（あちらは自前で `prefers-reduced-motion` を見ている）。
- [x] 2.5 `pre` の角丸を `var(--radius-sm)` にする
- [x] 2.6 ページの構造としての見出しに当てる `.section-title`（右へ罫線を伸ばす、`--accent`、0.8rem、字間 0.2em）を足す。`h2` そのものには当てず、エントリ本文の `##` の見え方を変えない
  - 見出しの太さだけは `h1` `h2` に直接与えた（600）。ポートフォリオが `h1, h2, h3` に与えているもので、本文の見出しにも当たってよい。
  - 両方に現れるピル（`.pill` / `.pill.is-quiet`）もここに置いた（design 決定5）。

## 3. 公開サイトの骨格と部品

- [x] 3.1 `src/layouts/Base.astro` の `max-width` を `var(--page)` にし、`body` の左右の余白を 1.5rem に合わせる
- [x] 3.2 同ファイルの `head` に `theme-color` の `meta` を明暗2つ置く
- [x] 3.3 同ファイルのヘッダーのサイト名に字間を与え、フッターを淡い文字・0.8rem・字間 0.1em にする（ポートフォリオの `.footer` に合わせる）
  - サイト名は字間 0.04em、太さ 600 にした。**フッターには何もしていない。** 中身が空なので `color` も `font-size` も効かず、[refine-page-presentation](../archive/2026-08-02-refine-page-presentation/tasks.md) が同じ理由で削っている。区切り線と下余白だけのまま。
- [x] 3.4 `src/pages/index.astro` の「年別」の `h2` に `.section-title` を当てる
- [x] 3.5 `src/pages/index.astro` の年の並びと `src/pages/[year]/index.astro` の月の並びを、`--accent-soft` を地とするピルにする（ポートフォリオの `.tags`）
- [x] 3.6 `src/components/EntryList.astro` の行のホバーを確認する。下線のままとし、浮き上がりは持ち込まない
  - 変更なし。行は罫線1本で区切られた行であって箱ではない。
- [x] 3.7 `src/pages/[year]/[month]/[day].astro` と `src/pages/[year]/[month]/index.astro` の区切り線・文字の大きさが基準に沿っているか見て、独自の値が残っていれば基準へ寄せる
  - 変更なし。残っているのは配置（前後の導線の折り返し、写真の並びの間隔、説明の体裁）だけで、色と角丸は基準から来ている。

## 4. 編集アプリケーションの共通部品

- [x] 4.1 `editor/src/layouts/Base.astro` の `max-width` を `var(--page)` にし、`theme-color` の `meta` を明暗2つ置く
- [x] 4.2 同ファイルの `<style is:global>` に、通知（`.notice`）・ボタン・入力欄・状態のピルの体裁を集める。囲みは `--surface` を地に `var(--radius)`、ボタンと入力欄は `var(--radius-sm)`、ピルは 999px と `--accent-soft`
  - ピルは公開サイトにも出るので `src/styles/base.css` に置いた。ここに集めたのは `.notice` `.confirm` `button` / `.button` `input` `textarea` `label` `fieldset` `legend` `.actions` `.head` `.lead` / `.note` と、ファイル選択のボタン。
- [x] 4.3 境界線を持つ箱のリンク（`.button`）に、ホバーで境界線がアクセント色に変わり 2px 浮く体裁を与える。フォームのボタンは色の変化だけにする

## 5. 編集アプリケーションの各ページ

- [x] 5.1 `editor/src/pages/index.astro`：`.button` `.status` `.entries` の宣言のうち、共通へ移したものを消す。年の並びをピルにする
  - 年のピルは、いま見ている年だけを地のある側にした。`aria-current` は残してある。
- [x] 5.2 `editor/src/pages/login.astro`：`.denied` `.button` を共通へ寄せる
  - `.denied` は `.notice` に置き換えた。同じものを別の名前で持つ理由がない。
- [x] 5.3 `editor/src/pages/publish.astro`：`.notice` `.badge` `.confirm` `.actions button` を共通へ寄せ、「直近の実行」の `h2` に `.section-title` を当てる
  - `.badge` は `.pill` に置き換え。`.status` セクションの `border-top` は、`.section-title` の罫線と二重になるので外した。
- [x] 5.4 `editor/src/pages/entries/[date].astro`：`.notice` `input` `textarea` `fieldset` `.actions button` を共通へ寄せ、「表示の確認」の `h2` に `.section-title` を当てる
  - `.preview` の `border-top` も、罫線と二重になるので外した。
- [x] 5.5 `editor/src/pages/entries/new.astro`：`.error` `input` `button` を共通へ寄せる
- [x] 5.6 `editor/src/pages/photos/new.astro`：`.notice` `input` `button` を共通へ寄せる
- [x] 5.7 `editor/src/pages/photos/uploaded.astro`：`.notice` `.snippet` `.tag` `.figure img` `.placeholder` を共通へ寄せる
- [x] 5.8 `editor/src/pages/` を横断し、各ページの `<style>` に残っているのが「その画面にしかない配置」だけであることを確認する
  - 残ったのは、一覧の行組み・写真の一覧の2段組み・フォームの並べ方・件数の透過度など。色と角丸の宣言は各ページから消えた。

## 6. 確認

- [x] 6.1 `npm run check`（`astro check` × 2、Biome、Lambda の確認）が通ることを確認する
- [x] 6.2 `npm run build -- staging` が通り、生成されたページ数が変わらないことを確認する
  - 409 ページ。`getStaticPaths` を持つファイルには触れていない。
- [x] 6.3 手元で公開サイトを開き、トップ・年別・月別・日別・月日・404 を、明暗それぞれの設定で確認する
  - 生成物を手元で配信し、headless Chrome で `prefers-color-scheme` を切り替えて撮って確認した。
- [x] 6.4 写真の並び（`table`）と Markdown の見出し・`hr`・箇条書きを含むエントリで、本文の見え方を確認する
  - 写真を横に並べたエントリで、並びと説明が崩れていないことを確認した。
- [x] 6.5 手元で編集アプリケーションを開き、一覧・編集・プレビュー・日付選択・写真・公開・ログインの各画面を、明暗それぞれの設定で確認する
  - ログイン画面は `npm run dev:editor -- staging` の実物で確認した。認証の要る画面は、**認証の判定だけを差し替えた使い捨ての複製**（`editor/.preview-src`、確認後に削除）を別ポートで動かして確認した。データ・設定・画面はすべて実物で、`editor/src` には手を入れていない。
  - **保存後のプレビュー（POST を要する表示）だけは未確認。** 整形は `renderMarkdown()` と `src/styles/` を通るため、公開サイトの本文で見たものと同じになる。
- [x] 6.6 キーボードだけで両アプリケーションを辿り、位置が常に見えることを確認する
  - Tab で辿り、アクセント色のリングが出ることを確認した。
- [x] 6.7 狭い画面幅で、囲み・ピル・入力欄・前後の導線が横にはみ出さないことを確認する
  - 390px 幅で全14ページの `scrollWidth` を測り、はみ出しが無いことを確認した。
  - この確認で、編集アプリケーションのヘッダと `.head` が折り返さず、題が1文字ずつに潰れることが分かった。`flex-wrap: wrap` を足して直した（design 決定9）。
- [x] 6.8 編集アプリケーションのプレビューと、公開サイトの同じエントリの見え方が一致することを確認する
  - 出どころが `src/styles/` の1つであることをコードで確認した。プレビューそのものの表示は 6.5 のとおり未確認。
- [x] 6.9 staging にデプロイし、稼働中の公開サイトと編集アプリケーションで確認する
  - 公開サイト：`npm run deploy -- staging`（409件を同期、削除対象0件）。invalidation `IDQ69J40RXGEGWS38G6JADR3KW`。
  - 編集アプリケーション：`npm run deploy:editor -- staging`（version 8、alias を更新）。
  - https://diary.dev.apkas.net と https://admin.dev.apkas.net/login を明暗それぞれで表示し、配信物に新しい基準値（`#faf8f5` / `#15120f` / `#b0512a` / `40rem`）が載っていること、青（`#375e8a`）が1件も残っていないことを確認した。
  - デプロイ後に `terraform plan` を実行し、差分が出ないことを確認した（`deploy-editor.sh` が求めている確認。関数の実行時設定が `ignore_changes` から漏れていないか）。
- [x] 6.10 ポートフォリオ（`../apkas/src/index.html` を手元で開く）と日記を並べ、地・書体・アクセント・囲みが同じに見えることを確認する
  - 値が同じであることと、日記側の見え方の両方を確認した。

## 7. 記録

- [x] 7.1 README の該当箇所に、体裁の基準がポートフォリオにあること、写しを持っていることを書く

## 8. production への反映

**このブランチのまま手元から配っている。** `main` にはまだ入っていないため、編集アプリケーションの「公開」ボタン（GitHub の `main` を作り直して配る）が押されると、公開サイトだけが元の体裁に戻る。マージまでのあいだ、あのボタンを押さないこと。

- [x] 8.1 `npm run build -- production`（1098 件から 1513 ページ）
- [x] 8.2 `npm run deploy -- production`。invalidation `IETL9UCKG6LSI1ZYFOLDTVAGFC`
- [x] 8.3 編集アプリケーションを production へ（lambroll、version 4、alias を更新）
  - `npm run deploy:editor -- production` は tfstate の読み取りで失敗した。**変更とは無関係の資格情報の問題**で、`apkas-production.admin` は `credential_process`（aws-sso-util）と旧来の SSO 設定の両方を持っており、Go 製のツール（lambroll・Terraform）は後者を選んで期限切れの token に当たる。AWS CLI は前者を使うので通る。`aws configure export-credentials` で得た資格情報を渡し、`build-editor.sh` を経た `editor/build` に対して `lambroll deploy` を直接実行した（スクリプトが最後に行う手順と同じもの）。
- [x] 8.4 https://diary.apkas.net と https://admin.apkas.net/login を明暗それぞれで確認。新しい基準値が配信物に載っており、青（`#375e8a`）は残っていない
- [x] 8.5 production で `terraform plan` に差分が出ないことを確認する（`deploy-editor.sh` が求めている確認）
  - `No changes.`。関数の実行時設定が `ignore_changes` の一覧から漏れていないことを確認した。
  - 一度は 8.3 と同じ理由で実行できなかった。backend の `profile` は Terraform が自分で読むため、環境変数の資格情報では上書きできない。`aws sso login` を通したあとに実行した。
