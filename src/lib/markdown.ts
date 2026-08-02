/**
 * 本文の Markdown を HTML に整形する。
 *
 * Astro 自身が使っているプロセッサを直接呼ぶことで、将来 `.md` ファイルを
 * 扱うようになったときも整形結果が食い違わないようにする。
 */

import {
  createSatteriMarkdownProcessor,
  type SatteriMarkdownProcessorOptions,
} from '@astrojs/markdown-satteri'

type Processor = Awaited<ReturnType<typeof createSatteriMarkdownProcessor>>

/**
 * 整形結果の木に対して働くプラグイン。
 *
 * 型は processor のオプションから引く。`satteri` から直接 import すると、
 * 直接の依存でないパッケージに型が縛られる。
 */
type HastPlugin = NonNullable<SatteriMarkdownProcessorOptions['hastPlugins']>[number]

/** 空白だけのテキストを除いた子の数。段落に画像しかないことの判定に使う。 */
function contentChildCount(node: {
  children: readonly { type: string; value?: string }[]
}): number {
  return node.children.filter((child) => child.type !== 'text' || (child.value ?? '').trim() !== '')
    .length
}

/**
 * 画像に添えられた説明を、画像の下に置くキャプションに組み替える。
 *
 *   <p><img src="…" alt="会場"></p>
 *   -> <figure><img src="…" alt="会場"><figcaption>会場</figcaption></figure>
 *
 * `![説明](…)` の `[]` に書かれた文は、既定では `alt` になるだけで画面に出ない。
 * `alt` は画像を表示できないときの代替であって、著者が画像に添えた文ではない。
 * 書かれた文が読めないまま残るのを避けるため、表示される要素に移す。
 * `alt` は消さない。代替としての役目は変わらないため。
 *
 * 組み替えるのは、段落の中に画像が単独で置かれている場合に限る。文章の途中に
 * 置かれた画像まで `figure` にすると、その段落が分断されてしまう。
 *
 * 整形の段階で行うのは、本文を書き換えずに済ませるため。本文は書かれたまま
 * 保持し、見せ方は表示側で解く。
 */
const imageFigurePlugin: HastPlugin = {
  name: 'image-figure',
  element: {
    filter: ['img'],
    visit(node, ctx) {
      const alt = node.properties?.alt
      if (typeof alt !== 'string' || alt === '') return

      const parent = ctx.parent(node)
      if (parent?.type !== 'element' || parent.tagName !== 'p') return
      if (contentChildCount(parent) !== 1) return

      // 段落ごと差し替える。`figure` を段落の中に入れることはできない。
      ctx.replaceNode(parent, {
        type: 'element',
        tagName: 'figure',
        properties: {},
        children: [
          { type: 'element', tagName: 'img', properties: { ...node.properties }, children: [] },
          {
            type: 'element',
            tagName: 'figcaption',
            properties: {},
            children: [{ type: 'text', value: alt }],
          },
        ],
      })
    },
  },
}

let cached: Promise<Processor> | undefined

function processor(): Promise<Processor> {
  if (!cached) {
    cached = createSatteriMarkdownProcessor({ hastPlugins: [imageFigurePlugin] })
  }
  return cached
}

export async function renderMarkdown(body: string): Promise<string> {
  const result = await (await processor()).render(body)
  return result.code
}
