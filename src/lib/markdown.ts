/**
 * 本文の Markdown を HTML に整形する。
 *
 * Astro 自身が使っているプロセッサを直接呼ぶことで、将来 `.md` ファイルを
 * 扱うようになったときも整形結果が食い違わないようにする。
 */

import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri'

type Processor = Awaited<ReturnType<typeof createSatteriMarkdownProcessor>>

let cached: Promise<Processor> | undefined

function processor(): Promise<Processor> {
  if (!cached) {
    cached = createSatteriMarkdownProcessor({})
  }
  return cached
}

export async function renderMarkdown(body: string): Promise<string> {
  const result = await (await processor()).render(body)
  return result.code
}
