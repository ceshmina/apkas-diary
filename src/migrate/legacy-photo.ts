/**
 * 旧ホスト（`photos.old.apkas.net`）に置かれた写真の参照を読み、新しい規約へ移す規則。
 *
 * 移行のあいだだけ必要になる知識——**旧ホストのパスの形**と、そこから新しい置き場所を
 * どう決めるか——をここ1つに閉じる。新しい側の規約（`src/lib/photo.ts`）には旧ホストの
 * ことを持ち込まない。移行が済めばこのモジュールごと不要になる。
 *
 * 旧ホストのパスには2つの形がある。
 *
 *   medium/202412/20241214-124403.webp     月でディレクトリを切る形（2,345件）
 *   medium/2025/04/25/AR500058.webp        日でディレクトリを切る形（20件）
 *
 * **どちらの形でも、新しいキーはパスから決めない。** 属する日は参照している日記の日付を
 * 使う（design.md 決定2）。日記は時差を吸収した暦日で書かれており、ファイル名に埋まった
 * 撮影日時とは前後の日にずれることがある。編集画面の一覧に求められているのは「その日記が
 * 使っている写真が出ること」なので、日記の側の日付に合わせる。パスから取れるのはファイル名
 * だけである。
 */

import { photoSourceKeyOf, photoUrlOf } from '../lib/photo.js'

/** 旧ホスト。移行の対象はこのホストを指す参照だけ。 */
export const LEGACY_PHOTO_HOST = 'photos.old.apkas.net'

/**
 * 本文に現れる旧ホストの URL。
 *
 * 終端の文字集合が `)` と `"` の両方を含むのは、参照が2つの書き方で現れるため。
 * Markdown の `![](...)` は括弧で閉じ、本文に直接書かれた `<img src="...">` は引用符で
 * 閉じる（旧サイトから引き継いだ画像グリッド）。**どちらか一方だけを拾う形にすると、
 * 片方の書き方の参照が丸ごと移行から漏れる。**
 */
const LEGACY_URL = new RegExp(
  `https://${LEGACY_PHOTO_HOST.replace(/\./g, '\\.')}/[^\\s)"'<>]+`,
  'g',
)

/** サイズ名より後ろの形。月でディレクトリを切る形と、日でディレクトリを切る形。 */
const LEGACY_PATH_SHAPES = [/^\d{6}\/[^/]+$/, /^\d{4}\/\d{2}\/\d{2}\/[^/]+$/] as const

export interface LegacyPhotoRef {
  /** 本文に書かれている URL そのもの。書き換えの対象。 */
  url: string
  /** 配信サイズ。本文に現れるのは `medium` だけである（そうでないものは呼び出し側が弾く）。 */
  size: string
  /** サイズ名より後ろ。拡張子を含まない。例 `202412/20241214-124403`。 */
  path: string
  /** 拡張子を含まないファイル名。新しい置き場所でもこの名前を保つ。 */
  name: string
}

/**
 * 本文から旧ホストの URL をすべて取り出す。現れた順で、重複も含めて返す。
 *
 * 同じ URL が1つの本文に2度現れることは避けられない形ではない（同じ写真を並べる）ため、
 * 重複を落とすのは呼び出し側に任せる。**取り出す側では落とさない。** ここで落とすと、
 * 何度現れたかを書き換えの側が知れなくなる。
 */
export function extractLegacyUrls(body: string): string[] {
  return body.match(LEGACY_URL) ?? []
}

/**
 * 旧ホストの URL を読む。想定した形でなければ `undefined` を返す。
 *
 * 形から外れたものを黙って通さないのは、**移行から漏れた参照が旧ホストを指したまま
 * 本文に残る**という形の失敗を避けるため。旧ホストはいずれ止まるので、漏れは静かな
 * リンク切れになる。呼び出し側は `undefined` を件数ではなくエラーとして扱うこと。
 */
export function parseLegacyUrl(url: string): LegacyPhotoRef | undefined {
  const prefix = `https://${LEGACY_PHOTO_HOST}/`
  if (!url.startsWith(prefix)) return undefined

  const rest = url.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined

  const size = rest.slice(0, slash)
  const withExt = rest.slice(slash + 1)

  // 拡張子を落とす。新しい側では派生画像の拡張子はキーから決まるので、
  // 旧ホストで何と呼ばれていたかは持ち越さない。
  const path = withExt.replace(/\.[^./]*$/, '')
  if (path === '' || !LEGACY_PATH_SHAPES.some((shape) => shape.test(path))) return undefined

  const name = path.slice(path.lastIndexOf('/') + 1)
  return { url, size, path, name }
}

/**
 * 移行後の配信 URL。
 *
 * **元写真の拡張子を知らなくても決まる。** 派生画像のキーは元写真のキーの拡張子を `webp`
 * に替えたものなので（`photoKeyOf`）、`.jpg` で投入しても `.webp` で投入しても同じ URL に
 * なる。棚卸しの時点で本文の書き換え先を確定できるのはこのためで、元写真を1枚も取りに
 * いかないうちに、置換の対応表を作り終えられる。
 */
export function migratedPhotoUrl(base: string, entryDate: string, name: string): string {
  return photoUrlOf(base, 'medium', photoSourceKeyOf(entryDate, `${name}.webp`))
}

/**
 * 移行後の元写真のキー。拡張子は取ってきた元写真のものをそのまま使う。
 *
 * 新規の投入とまったく同じ関数を通す。**移行で入れた写真だけキーの形が違う、という状態を
 * 作らない。** 目録に載るかどうかもこの形で決まる（`photoSourceOf`）。
 */
export function migratedSourceKey(entryDate: string, name: string, ext: string): string {
  return photoSourceKeyOf(entryDate, `${name}${ext}`)
}

/**
 * 本文の旧 URL を新 URL に差し替える。
 *
 * Markdown として解釈し直すことはしない。URL の文字列をそのまま置き換えるだけである。
 * 本文には旧サイトから引き継いだ HTML が直接書かれており（`migrate-legacy-diary`）、
 * 解釈して組み立て直すと**書かれたとおりに保つ**という前提が崩れる。URL は本文の中で
 * 十分に長く一意なので、文字列の置換で取り違えは起きない。
 *
 * 対応表に無い旧 URL が残っていても、ここでは何もしない。残りの検出は呼び出し側が行う。
 */
export function rewriteLegacyUrls(body: string, replacements: ReadonlyMap<string, string>): string {
  let result = body
  for (const [oldUrl, newUrl] of replacements) {
    result = result.replaceAll(oldUrl, newUrl)
  }
  return result
}
