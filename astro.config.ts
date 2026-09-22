import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import type { AstroIntegration } from 'astro'
import { defineConfig, fontProviders } from 'astro/config'
import { exportEntries } from './src/export/markdown.js'
import { FONTS } from './src/styles/fonts.js'

// 書体のファイル（約360個）は、ビルドの終わりに一斉に取りにいく。Node は接続先の
// アドレスを1つずつ試し、1つあたり 250ms で次へ移るが、同時の接続が多いと届く側の
// アドレス（IPv4）でもこれを超え、試す先が尽きて取得が失敗する。手元の WSL では、
// 空の cache から毎回失敗した。公開手続き（CodeBuild）は cache を持たないので、
// 同じことが起きると再実行しても通らない。待つ時間を延ばしておく。
setDefaultAutoSelectFamilyAttemptTimeout(3000)

/**
 * 日記本文の Markdown 書き出しをビルドに組み込む。
 *
 * 書き出しはサイト生成の副次的な出力であり、別途の手動操作を必要としない。
 * 失敗した場合はここで例外が伝播し、ビルドが異常終了する。
 */
function diaryExport(): AstroIntegration {
  return {
    name: 'diary-export',
    hooks: {
      // 動的 import は使えない。このフックの時点では Vite のモジュールランナーが
      // 閉じており、モジュールを解決できないため。
      'astro:build:done': async ({ logger }) => {
        const { dir, written, removed } = await exportEntries()
        logger.info(`日記本文を書き出しました: ${written} 件 -> ${dir}`)
        if (removed > 0) {
          logger.info(`削除されたエントリのファイルを ${removed} 件消しました。`)
        }
      },
    },
  }
}

export default defineConfig({
  site: process.env.SITE_URL,
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
  integrations: [diaryExport()],

  // 書体はビルド時に Google Fonts から取り込み、`/_astro/fonts/` から配る。
  // 一覧の出どころは src/styles/fonts.ts で、編集アプリケーションも同じ一覧を読む。
  //
  // `subsets` は既定の `latin` のままにする。和文の断片には subset の注記が
  // 付かないので絞られず、すべて取り込まれる。落ちるのは `latin-ext` などで、
  // 本文にその文字が現れても代わりの書体で出るだけで欠けはしない。
  //
  // `optimizedFallbacks` は切る。これは代わりの末尾が総称のとき、Arial などの
  // 寸法を書体に合わせた代わりを作り、指定した代わりの**前に**差し込む仕組みで
  // ある。寸法は書体の最初のファイルから測るが、和文の書体の最初のファイルは
  // 英字を持たない漢字の断片で、`size-adjust` が 224%（明朝は 246%）になる。
  // 読み込みを待つあいだと読み込めなかったとき、英数字だけが倍の大きさで出る。
  // 和文の書体の代わりには OS の和文の書体を先に並べてあり（fonts.ts）、そちらを
  // 最初に使わせる。
  fonts: FONTS.map((font) => ({
    provider: fontProviders.google(),
    name: font.name,
    cssVariable: font.cssVariable,
    weights: [...font.weights],
    styles: [...font.styles],
    fallbacks: [...font.fallbacks],
    optimizedFallbacks: false,
  })),
})
