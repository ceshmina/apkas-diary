/**
 * 写真を置く場所と、配信される URL の規約。
 *
 * 元写真をどこに置くか（`photoDatePrefixOf` / `photoSourceKeyOf`）と、そこから
 * 派生画像の URL がどう決まるか（`photoKeyOf` / `photoUrlOf`）を、投入から配信まで
 * ひと続きでここに置いている。**投入の入口は手元の CLI とブラウザの2つあるが、
 * 規約はこのファイル1つが持つ。** 入口ごとに別の規則が生まれると、あとから
 * 「どちらで入れたか」を思い出さないと写真に辿り着けなくなる。
 *
 * サイズ名を先頭に置き、元写真のキーは拡張子だけを webp に替える。サイズ名以外が
 * すべて一致するので、1つのサイズの URL からその写真の他のサイズを導ける。
 * 日別ページの拡大表示（`src/components/photo-zoom.ts`）が既にこの形に依存している。
 *
 * 同じ規約を `lambda/photo-resize/src/index.ts` も持っている。あちらは派生画像を
 * 書く側、こちらは URL を組み立てて見せる側で、パッケージが分かれているため共有して
 * いない。**どちらかを変えるときは両方を直す。**
 */

import { dayOf, isValidDate, monthOf, yearOf } from './date.js'

export const PHOTO_SIZES = ['thumbnail', 'small', 'medium', 'large'] as const

export type PhotoSize = (typeof PHOTO_SIZES)[number]

/**
 * 日付に対応する、元写真のキーの接頭辞。末尾の区切りを含む。
 *
 * 日付でディレクトリを切るのは、写真が1日の日記に属するという実態に合わせるため。
 * 日付はこのシステム全体の並べ替えの軸でもある。
 *
 * ファイル名と切り離して出しているのは、ブラウザからの投入が**ファイル名の決まる
 * 前にこの接頭辞だけを必要とする**ため。署名を作る時点で利用者はまだファイルを
 * 選んでおらず、「置いてよい場所」だけが決まっている。
 */
export function photoDatePrefixOf(date: string): string {
  return `${yearOf(date)}/${monthOf(date)}/${dayOf(date)}/`
}

/**
 * 日付とファイル名から、元写真を置くキーを組み立てる。
 *
 * `filename` はパスではなくファイル名を受け取る。手元の CLI はパスから取り出して
 * から渡し、ブラウザからの投入では S3 が受け取ったファイル名がここに入る。
 */
export function photoSourceKeyOf(date: string, filename: string): string {
  return `${photoDatePrefixOf(date)}${filename}`
}

/** `photoSourceKeyOf` が作る形。日付の3段と、区切りを含まないファイル名。 */
const SOURCE_KEY_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)$/

export interface PhotoSource {
  /** JST の暦日。`YYYY-MM-DD`。 */
  date: string
  filename: string
}

/**
 * 元写真のキーから、属する日付とファイル名を取り出す。`photoSourceKeyOf` の逆。
 *
 * 日付の規約に沿わないキーでは `undefined` を返す。手元の CLI には `--key` で
 * **日付という軸から外れた場所へ置ける**入口があり、そこへ置かれた写真は属する日を
 * 持たない。目録は日付を軸に引くものなので、載せられるかどうかがこの戻り値で決まる
 * （`photo-catalog` の「日付の軸から外れたキーへの投入」）。
 *
 * 暦上実在しない日付（`2026/02/30/a.jpg` など）も外す。目録のキーになる値であり、
 * エントリの日付と突き合わせられなければ意味がない。
 */
export function photoSourceOf(sourceKey: string): PhotoSource | undefined {
  const m = SOURCE_KEY_PATTERN.exec(sourceKey)
  if (!m) return undefined

  const date = `${m[1]}-${m[2]}-${m[3]}`
  if (!isValidDate(date)) return undefined

  return { date, filename: m[4] as string }
}

/**
 * 元写真のキーから、配信される派生画像のキーを組み立てる。
 *
 * 拡張子の置換が最後の区切りより後ろだけを見るのは、`2026/08.old/a` のように
 * ディレクトリ名に点があっても壊さないため。
 */
export function photoKeyOf(size: PhotoSize, sourceKey: string): string {
  return `${size}/${sourceKey.replace(/\.[^./]*$/, '')}.webp`
}

/**
 * 元写真のキーから、配信される URL を組み立てる。
 *
 * 各段を符号化するのは、空白を含むファイル名でもそのまま本文に貼れるようにするため。
 */
export function photoUrlOf(base: string, size: PhotoSize, sourceKey: string): string {
  const path = photoKeyOf(size, sourceKey).split('/').map(encodeURIComponent).join('/')
  return `${base.replace(/\/+$/, '')}/${path}`
}
