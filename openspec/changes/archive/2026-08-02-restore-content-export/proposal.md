## Why

`astro.config.ts` が `./src/export/markdown.js` を import しているが、このファイルがリポジトリに存在しない。`.gitignore` の `export/` は、リポジトリ直下の書き出し先だけを意図したものだったが、パターンが先頭のスラッシュを持たないため `src/export/` にも一致する。`setup-diary-foundation` の実装時に `src/export/markdown.ts` はこれに巻き込まれ、コミットされないまま失われた。

そのため、リポジトリを clone した状態では `astro` を呼ぶコマンドがすべて config のロードで失敗する。`npm run build` も `npm run check` も `astro dev` も動かない。手元の作業ツリーにもファイルは残っておらず、git の履歴・stash・書き出し先の `export/` のいずれにも痕跡がないため、内容は復元できない。

これは `content-export` の要件がひとつも満たされていない状態でもある。日記本文をアプリケーションとクラウド基盤の外に出しておくという保全の仕組みが、実際には一度も動いていない。

## What Changes

- `.gitignore` の `export/` を `/export/` に変える。リポジトリ直下の書き出し先だけに一致させ、`src/export/` を巻き込まないようにする。
- `src/export/markdown.ts` を書き直す。`astro.config.ts` が期待する `exportEntries()` を提供し、`{ dir, written, removed }` を返す。
- 書き出しの形式を決め直す。失われたファイルの形式は復元できないため、`content-export` の要件を満たす形として改めて定める。YAML frontmatter に属性を置き、その下に本文をそのまま置く。ファイルは `<書き出し先>/<年>/<YYYY-MM-DD>.md` に1エントリ1ファイルで作る。
- 書き出し先に残っている、DynamoDB 側にもう存在しないエントリのファイルを削除する。`astro.config.ts` が `removed` を受け取ってログに出しており、削除は既定の動作として組み込まれている。

これは失われたファイルの穴埋めであり、`content-export` の要件そのものは変えない。仕様は `setup-diary-foundation` の時点で確定しており、実装がそれに追いついていないだけである。したがって delta spec は作らず、`.openspec.yaml` に `skip_specs: true` を置く。

### スコープ外

- GitHub Release への配置（`setup-diary-foundation` design.md 決定12）。CI 化の change で扱う。
- 書き出したファイルから DynamoDB へ書き戻す復元コマンド。形式は機械的に読めるものにするが、復元の手順を実装するのは別の話。
- `astro.config.ts` の構成そのもの。integration として書き出しを組み込む形は変えない。

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

なし。`content-export` の要件は変えず、既存の要件を満たす実装を用意する。

## Impact

**アプリケーション**

- `src/export/markdown.ts`: 新規作成。`scanAllIncludingDrafts()` で下書きを含む全件を取得し、書き出し先へ反映する。
- `.gitignore`: `export/` を `/export/` に変更。

**開発環境**

- clone した状態で `npm run check` と `astro dev` が動くようになる。現在はどちらも config のロードで失敗する。

**運用**

- `npm run build` が初めて書き出しを行うようになる。既存の書き出し先は存在しないため、初回は全件が新規作成になる。
