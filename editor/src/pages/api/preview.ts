/**
 * 本文の Markdown を整形して返す。
 *
 * 記事の編集画面が、入力に追随してプレビューを更新するために叩く（`entry-editing` の
 * 「表示は入力に追随して更新される」）。返すのはページではなく **HTML の断片**で、
 * 受け取った側はそれをプレビューの面に差し込むだけで済む。
 *
 * **整形をブラウザ側に持たない。** `renderMarkdown()` の実体は satteri（Rust の napi
 * バインディング）で、ブラウザで動かすには WASM を運ぶことになる。別実装を載せれば
 * 「公開サイトと同じ解釈規則」が実装の同一性ではなく願いに変わる（design.md 決定1）。
 * ここを通せば、公開サイトの `.md` とまったく同じ経路になる。
 *
 * `/entries/preview` ではなく `/api/preview` に置いているのは、`entries/[date]` の隣に
 * **日付ではない `/entries/…`** を作らないため。これは編集画面のための経路であって、
 * エントリの1つではない。
 *
 * **データストアに触れない。** 保存の手段をこの経路が持たないことによって、`entry-editing`
 * の「確認と保存の区別」——表示を確かめただけの本文が保存されない——が満たされる。
 *
 * 認証は middleware が見ている。ここを `PUBLIC_PATHS` に足さないこと。未認証の POST は
 * 401 になり、本文は整形されない。
 */

import type { APIRoute } from 'astro'
import { renderMarkdown } from '../../../../src/lib/markdown.js'

export const prerender = false

/**
 * 受け取る本文の上限。
 *
 * 日記の本文はこの桁に届かない（数万字でも数十 KB）。届く要求は誤りか、この経路の
 * 用途から外れたものである。
 */
const MAX_BODY_BYTES = 100 * 1024

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export const POST: APIRoute = async ({ request }) => {
  // 宣言された大きさで先に断る。読んでから測ると、断る相手のぶんだけ本文を
  // メモリに載せることになる。
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return text('本文が大きすぎます。', 413)
  }

  /*
   * 本文は `text/plain` の body そのものとして受け取る。JSON で包むと、送る側と
   * 受ける側の両方に「1つしかない値を取り出す」処理が生まれる。
   *
   * `text/plain` を選ぶことにはもう1つ意味がある。Astro の CSRF 判定
   * （`security.checkOrigin`）が見る content type に含まれるため、保存のフォームと
   * **同じ関門**を通る。`astro.config.ts` の `allowedDomains` がそのまま効く。
   */
  const body = await request.text()

  // 宣言が無い、あるいは宣言と実体が食い違う場合に備えて、読んだものでも測る。
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return text('本文が大きすぎます。', 413)
  }

  let html: string
  try {
    html = await renderMarkdown(body)
  } catch (error) {
    // **ページを返さない。** 受け取る側は断片しか期待しておらず、エラーページを
    // 差し込まれるとプレビューの面にサイトの骨格が現れる。
    console.error('プレビューの整形に失敗:', error instanceof Error ? error.message : error)
    return text('整形できませんでした。', 500)
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 保存されていない本文から作ったものであり、どこにも残してよいものではない。
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * POST 以外は 405。
 *
 * 既定では未定義のメソッドが 404 になり、「経路が無い」と「そのメソッドを受けない」の
 * 区別が付かない。GET で叩かれたときに何も返さないことを、はっきりさせておく。
 */
export const ALL: APIRoute = () => text('POST のみ受け付けます。', 405)
