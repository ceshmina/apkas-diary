## 1. 基準値を移す

- [ ] 1.1 `src/styles/tokens.css` の配色を、ポートフォリオ（`../apkas/src/assets/style.css` の `:root`）の値に置き換える。明暗の両方を移す
- [ ] 1.2 同ファイルに `--surface` と `--accent-soft` を足す（明暗の両方）
- [ ] 1.3 同ファイルに `--font` `--page` `--radius` `--radius-sm` を足す。`--radius-sm` はポートフォリオにない値であり、この変更で決めたものだとコメントに残す
- [ ] 1.4 同ファイルの先頭のコメントに、値の出どころ（`../apkas`）と変数名の対応表（`--fg` = `--ink`、`--fg-muted` = `--muted`、`--border` = `--line`）を書く

## 2. 本文の見え方を合わせる

- [ ] 2.1 `src/styles/base.css` の `body` の書体を `var(--font)` に、行送りを 1.9、字間を 0.02em にする。`-webkit-font-smoothing: antialiased` も入れる
- [ ] 2.2 `html` に `-webkit-text-size-adjust: 100%` を入れる
- [ ] 2.3 `:focus-visible` にアクセント色のリング（2px、offset 3px）を入れる
- [ ] 2.4 `prefers-reduced-motion` の抑制ブロックを入れる
- [ ] 2.5 `pre` の角丸を `var(--radius-sm)` にする
- [ ] 2.6 ページの構造としての見出しに当てる `.section-title`（右へ罫線を伸ばす、`--accent`、0.8rem、字間 0.2em）を足す。`h2` そのものには当てず、エントリ本文の `##` の見え方を変えない

## 3. 公開サイトの骨格と部品

- [ ] 3.1 `src/layouts/Base.astro` の `max-width` を `var(--page)` にし、`body` の左右の余白を 1.5rem に合わせる
- [ ] 3.2 同ファイルの `head` に `theme-color` の `meta` を明暗2つ置く
- [ ] 3.3 同ファイルのヘッダーのサイト名に字間を与え、フッターを淡い文字・0.8rem・字間 0.1em にする（ポートフォリオの `.footer` に合わせる）
- [ ] 3.4 `src/pages/index.astro` の「年別」の `h2` に `.section-title` を当てる
- [ ] 3.5 `src/pages/index.astro` の年の並びと `src/pages/[year]/index.astro` の月の並びを、`--accent-soft` を地とするピルにする（ポートフォリオの `.tags`）
- [ ] 3.6 `src/components/EntryList.astro` の行のホバーを確認する。下線のままとし、浮き上がりは持ち込まない
- [ ] 3.7 `src/pages/[year]/[month]/[day].astro` と `src/pages/[year]/[month]/index.astro` の区切り線・文字の大きさが基準に沿っているか見て、独自の値が残っていれば基準へ寄せる

## 4. 編集アプリケーションの共通部品

- [ ] 4.1 `editor/src/layouts/Base.astro` の `max-width` を `var(--page)` にし、`theme-color` の `meta` を明暗2つ置く
- [ ] 4.2 同ファイルの `<style is:global>` に、通知（`.notice`）・ボタン・入力欄・状態のピルの体裁を集める。囲みは `--surface` を地に `var(--radius)`、ボタンと入力欄は `var(--radius-sm)`、ピルは 999px と `--accent-soft`
- [ ] 4.3 境界線を持つ箱のリンク（`.button`）に、ホバーで境界線がアクセント色に変わり 2px 浮く体裁を与える。フォームのボタンは色の変化だけにする

## 5. 編集アプリケーションの各ページ

- [ ] 5.1 `editor/src/pages/index.astro`：`.button` `.status` `.entries` の宣言のうち、共通へ移したものを消す。年の並びをピルにする
- [ ] 5.2 `editor/src/pages/login.astro`：`.denied` `.button` を共通へ寄せる
- [ ] 5.3 `editor/src/pages/publish.astro`：`.notice` `.badge` `.confirm` `.actions button` を共通へ寄せ、「直近の実行」の `h2` に `.section-title` を当てる
- [ ] 5.4 `editor/src/pages/entries/[date].astro`：`.notice` `input` `textarea` `fieldset` `.actions button` を共通へ寄せ、「表示の確認」の `h2` に `.section-title` を当てる
- [ ] 5.5 `editor/src/pages/entries/new.astro`：`.error` `input` `button` を共通へ寄せる
- [ ] 5.6 `editor/src/pages/photos/new.astro`：`.notice` `input` `button` を共通へ寄せる
- [ ] 5.7 `editor/src/pages/photos/uploaded.astro`：`.notice` `.snippet` `.tag` `.figure img` `.placeholder` を共通へ寄せる
- [ ] 5.8 `editor/src/pages/` を横断し、各ページの `<style>` に残っているのが「その画面にしかない配置」だけであることを確認する

## 6. 確認

- [ ] 6.1 `npm run check`（`astro check` × 2、Biome、Lambda の確認）が通ることを確認する
- [ ] 6.2 `npm run build -- staging` が通り、生成されたページ数が変わらないことを確認する
- [ ] 6.3 手元で公開サイトを開き、トップ・年別・月別・日別・月日・404 を、明暗それぞれの設定で確認する
- [ ] 6.4 写真の並び（`table`）と Markdown の見出し・`hr`・箇条書きを含むエントリで、本文の見え方を確認する
- [ ] 6.5 手元で編集アプリケーションを開き（`npm run dev:editor`）、一覧・編集・プレビュー・日付選択・写真・公開・ログインの各画面を、明暗それぞれの設定で確認する
- [ ] 6.6 キーボードだけで両アプリケーションを辿り、位置が常に見えることを確認する
- [ ] 6.7 狭い画面幅で、囲み・ピル・入力欄・前後の導線が横にはみ出さないことを確認する
- [ ] 6.8 編集アプリケーションのプレビューと、公開サイトの同じエントリの見え方が一致することを確認する
- [ ] 6.9 staging にデプロイし、稼働中の公開サイトと編集アプリケーションで確認する
- [ ] 6.10 ポートフォリオ（`../apkas/src/index.html` を手元で開く）と日記を並べ、地・書体・アクセント・囲みが同じに見えることを確認する

## 7. 記録

- [ ] 7.1 README の該当箇所に、体裁の基準がポートフォリオにあること、写しを持っていることを書く
