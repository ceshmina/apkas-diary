## 1. レイアウトから不要な文言を落とす

- [x] 1.1 `src/layouts/Base.astro` のヘッダーから `nav` と「N年前の今日」リンクを削除する
- [x] 1.2 `src/layouts/Base.astro` から `data-on-this-day` のリンク差し替えスクリプトを削除する（差し替える対象がなくなるため）
- [x] 1.3 `src/layouts/Base.astro` のフッターから「この日記は静的に生成されています。」の段落を削除する。`footer` 要素と区切り線は残す
- [x] 1.4 ヘッダーの `nav` がなくなったことでレイアウトが崩れないか、`header` のスタイルを確認する
  - 子要素が1つになり `display: flex` 以下が効かなくなったため削除し、`padding` と `border-bottom` だけ残した。フッターも中身がなくなり `color` / `font-size` が効かないため、区切り線と下余白だけにした。

## 2. 月日ページの説明文を落とす

- [x] 2.1 `src/pages/on-this-day/[monthday].astro` から説明文の段落を削除する
- [x] 2.2 同ファイルの `getStaticPaths` のコメントから、「今日」の導線をクライアント側で解決する前提の記述を落とし、366通り生成する理由を現状に合わせて書き直す

## 3. 本文の hr に余白を与える

- [x] 3.1 `src/pages/[year]/[month]/[day].astro` の `.body` 配下の `hr` に前後の余白を足す
- [x] 3.2 `hr` を含む本文で、前後の段落との間隔が区切りとして読めることを確認する
  - `margin: 3rem 0`。隣接する段落の `1em` と相殺され、前後とも 48px 空く（既定は `0.5em` = 8px）。

## 4. 確認

- [x] 4.1 `npm run build` が通ることを確認する
  - 当初は実行できなかった。`astro.config.ts` が import する `src/export/markdown.js` がリポジトリに
    存在せず、config のロードで失敗していたため。`restore-content-export`（#4）が main に入ったので
    このブランチを rebase し、`npm run build -- staging` を実データで通した。382ページを生成し、
    書き出しも6件走った。
- [x] 4.2 Biome の lint / format が通ることを確認する
- [x] 4.3 ローカルで起動し、トップ・年別・月別・日別・月日ページの表示を確認する
  - 実データのビルド生成物で確認した。ヘッダーは
    `<header><a href="/" class="site-title">apkas-diary</a></header>` のみ、フッターは `<footer></footer>`、
    月日ページは見出しと一覧だけになっている。削除した4つの文言（「N年前の今日」「この日記は静的に
    生成されています」「data-on-this-day」「新しい年から並べています」）はいずれも0件。
  - 差し替えスクリプトを消したことで、`<script>` を含むページが全382ページ中0件になった。
- [x] 4.4 日別ページの「過去の同じ日」から月日ページへ辿れることを確認する（残る唯一の導線のため）
  - `/2026/08/01` の導線が `/on-this-day/08-01` を指すことを確認した。
- [x] 4.5 staging にデプロイし、稼働中のサイトで確認する
  - `npm run deploy -- staging`（382件を同期、削除対象0件）。invalidation `I64S7GUR1ES3TWDQUG0ZYVYE7L`
    が Completed。
  - https://diary.dev.apkas.net で、トップ・日別・年別・月別・月日ページが 200、下書きの
    `/2025/12/24` と `/2025/12` が 404。配信物に削除した文言と `<script>` がないこと、下書きの痕跡が
    ないことを確認した。`hr{margin:3rem 0}` も配信されている。
