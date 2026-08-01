import type { AstroIntegration } from 'astro'
import { defineConfig } from 'astro/config'
import { exportEntries } from './src/export/markdown.js'

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
})
