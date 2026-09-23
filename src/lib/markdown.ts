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
 * 本文の `img` の `src` から、その写真の撮影機材の1行を引く。無ければ `undefined`。
 *
 * 何を鍵にして引くかは写真の URL の規約の話なので、**ここは知らない**。渡す側
 * （`src/lib/site-data.ts`）が規約を持ち、こちらは引ければ付けるだけを行う。
 */
export type EquipmentOf = (src: string) => string | undefined

/**
 * 本文の画像に手を入れる。2つのことを1つの visit で行う。
 *
 * **1つめ: 画像に添えられた説明を、画像の下に置くキャプションに組み替える。**
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
 * **2つめ: 撮影機材を `data-equipment` として載せる。** 拡大表示がここから読む
 * （`src/components/photo-zoom.ts`）。**引けなかった写真には属性を付けない。** 空の
 * 属性を付けると、読む側が「空文字か未設定か」を見分けることになる。記録の不在は
 * 不在のまま表す。
 *
 * **2つを別のプラグインに分けない。** 説明の組み替えは段落ごと差し替えるので、分けると
 * 差し替えの前後どちらで機材を載せるかが並び順に依存する。1つの visit の中で、載せて
 * から差し替えれば順序の問題が起きない。
 *
 * 整形の段階で行うのは、本文を書き換えずに済ませるため。**本文（データストアの値）は
 * 書かれたまま保持し、見せ方は表示側で解く。**
 */
/** 生の HTML の中の `<img …>`。属性値に `>` を含む本文は無い。 */
const RAW_IMG = /<img\b[^>]*>/gi

/** `src` の値。二重引用符・一重引用符・引用符なしのいずれも読む。 */
const RAW_SRC = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

/** 属性値として書ける形にする。機材名に現れることはまず無いが、値は元写真由来である。 */
function attributeValue(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * 生の HTML の中の `<img>` にも `data-equipment` を足す。
 *
 * **旧サイトから引き継いだ記事は、画像を横に並べるために `table` を本文に直接書いて
 * いる**（`migrate-legacy-diary`）。その中の `<img>` は Markdown の記法を通っていない
 * ので木の `img` にはならず、1つの `raw` として素通りする。拡大表示はそれらの写真も
 * 並びに入れる（`photo-zoom.ts` の `wrap()` は本文のすべての `img` を辿る）ので、
 * **ここを外すと、過去の写真の大半に機材が出ない。**
 *
 * 木ではなく文字列に手を入れるのは、**ここが最初から文字列だから**である。生の HTML を
 * 解釈して木に変えてしまうと、いままで書かれたとおり素通りしていた1,000件近い記事の
 * 出力が、この change のついでに変わりうる。触るのは `<img>` の1タグだけにとどめる。
 */
function withEquipmentInRaw(html: string, equipment: EquipmentOf): string {
  return html.replace(RAW_IMG, (tag) => {
    if (/\sdata-equipment[\s=]/i.test(tag)) return tag

    const found = RAW_SRC.exec(tag)
    const src = found?.[1] ?? found?.[2] ?? found?.[3]
    if (!src) return tag

    const label = equipment(src.replace(/&amp;/gi, '&'))
    if (!label) return tag

    // `<img …>` にも `<img … />` にも足せるよう、閉じの手前に差し込む。
    const close = tag.endsWith('/>') ? 2 : 1
    return `${tag.slice(0, -close).trimEnd()} data-equipment="${attributeValue(label)}"${tag.slice(-close)}`
  })
}

/**
 * 整形した本文の HTML から、`img` の `src` を現れる順に返す。エントリの一覧に並べる
 * 縮小画像を、本文のどの写真から作るかを決めるのに使う（`src/lib/site-data.ts`）。
 *
 * **整形の前の Markdown からは拾わない。** 本文には、画面に写真として出ない URL も
 * 書かれうる。production には `!` の抜けた `[](https://…/medium/….webp)` が1件あり、
 * これは空のリンクとして整形され、日別ページに写真は出ていない。何が画像として出るかを
 * 決めているのは整形なので、その結果から読めば、一覧と日別ページが食い違わない。
 *
 * 整形の結果は、Markdown 由来の `img` と、素通りした生の `<img>`（旧サイトから
 * 引き継いだ `table` の中の写真）が混ざったものである。どちらも `RAW_IMG` /
 * `RAW_SRC` で読める。コードブロックの中の `<img` は整形で `&lt;img` になるので
 * 拾わない。
 */
export function imageSourcesOf(html: string): string[] {
  const sources: string[] = []
  for (const [tag] of html.matchAll(RAW_IMG)) {
    const found = RAW_SRC.exec(tag)
    const src = found?.[1] ?? found?.[2] ?? found?.[3]
    if (src) sources.push(src.replace(/&amp;/gi, '&'))
  }
  return sources
}

function imagePlugin(equipment?: EquipmentOf): HastPlugin {
  return {
    name: 'image',
    raw(node) {
      if (!equipment) return
      const value = withEquipmentInRaw(node.value, equipment)
      if (value === node.value) return
      return { type: 'raw', value }
    },
    element: {
      filter: ['img'],
      visit(node, ctx) {
        const src = node.properties?.src
        const label = equipment && typeof src === 'string' ? equipment(src) : undefined
        const properties = label
          ? { ...node.properties, 'data-equipment': label }
          : { ...node.properties }

        const alt = node.properties?.alt
        const parent = ctx.parent(node)
        const captioned =
          typeof alt === 'string' &&
          alt !== '' &&
          parent?.type === 'element' &&
          parent.tagName === 'p' &&
          contentChildCount(parent) === 1

        if (captioned) {
          // 段落ごと差し替える。`figure` を段落の中に入れることはできない。
          ctx.replaceNode(parent, {
            type: 'element',
            tagName: 'figure',
            properties: {},
            children: [
              { type: 'element', tagName: 'img', properties, children: [] },
              {
                type: 'element',
                tagName: 'figcaption',
                properties: {},
                children: [{ type: 'text', value: alt }],
              },
            ],
          })
          return
        }

        // 木のノードは読み取り専用なので、属性を足すときは同じ `img` に差し替える。
        // 説明の無い写真・段落の途中に置かれた写真・並べて置かれた写真がここを通る。
        if (label) {
          ctx.replaceNode(node, { type: 'element', tagName: 'img', properties, children: [] })
        }
      },
    },
  }
}

/**
 * 組み立てた processor。**引き当ての関数ごとに1つ持つ。**
 *
 * プラグインは processor を作るときに決まるので、呼び出しごとに違う関数を渡すなら
 * processor も分かれる。公開サイトのビルドが渡すのは memo 化された1つの関数
 * （`photoEquipment()`）なので、実際に作られるのは**渡す側が1つ、渡さない側が1つ**の
 * 2つだけである。呼び出しのたびに作り直すと、1,000を超えるページの生成でそのたびに
 * 初期化が走る。
 */
const withEquipment = new WeakMap<EquipmentOf, Promise<Processor>>()
let plain: Promise<Processor> | undefined

function processor(equipment?: EquipmentOf): Promise<Processor> {
  if (!equipment) {
    if (!plain) {
      plain = createSatteriMarkdownProcessor({ hastPlugins: [imagePlugin()] })
    }
    return plain
  }

  const found = withEquipment.get(equipment)
  if (found) return found

  const created = createSatteriMarkdownProcessor({ hastPlugins: [imagePlugin(equipment)] })
  withEquipment.set(equipment, created)
  return created
}

/**
 * 本文を整形する。
 *
 * `equipment` は任意。渡さない呼び出し（編集アプリケーションのプレビュー）は、
 * この引数が無かったときとまったく同じものを出す。プレビューは本文の整形を確かめる
 * 場であり、拡大の仕掛けを持たない。
 */
export async function renderMarkdown(body: string, equipment?: EquipmentOf): Promise<string> {
  const result = await (await processor(equipment)).render(body)
  return result.code
}
