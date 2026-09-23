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
 * 組み立てた URL から**目録の記録を引き当てる**ための道もここに置く（`photoPathOf` /
 * `photoPathFromUrl` / `photoDateOf`）。本文が写真について知っているのは配信 URL だけ
 * なので、突き合わせはその1本を両側から組み立てて行う。**逆に URL から元写真のキーを
 * 導く関数は無い。導けないためである**（`photoPathFromUrl` のコメント）。
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
 * 元写真のキーから、**配信パス**——配信キーからサイズ名を除いた部分——を組み立てる。
 *
 *   2026/08/13/DSCF1234.JPG  ->  2026/08/13/DSCF1234.webp
 *
 * サイズによらず同じ1つの値になるので、**同じ写真を指すかどうかの突き合わせに使える**。
 * 本文に貼られた URL がどのサイズであっても、サイズ名を落とせばここに揃う。
 *
 * 拡張子の置換が最後の区切りより後ろだけを見るのは、`2026/08.old/a` のように
 * ディレクトリ名に点があっても壊さないため。
 */
export function photoPathOf(sourceKey: string): string {
  return `${sourceKey.replace(/\.[^./]*$/, '')}.webp`
}

/**
 * 元写真のキーから、配信される派生画像のキーを組み立てる。
 *
 * サイズ名と配信パスの2つでできている。**この形を1箇所で決めておく**ことで、URL を
 * 読む側（`photoPathFromUrl`）が同じ切れ目を別に覚えずに済む。
 */
export function photoKeyOf(size: PhotoSize, sourceKey: string): string {
  return `${size}/${photoPathOf(sourceKey)}`
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

/**
 * 配信 URL から**配信パス**を取り出す。`photoUrlOf` が組み立てたものを解く。
 *
 *   https://photos.apkas.net/medium/2026/08/13/DSCF1234.webp
 *                            ~~~~~~ サイズ名（捨てる）
 *   -> 2026/08/13/DSCF1234.webp
 *
 * 基点が一致しないもの、サイズ名が知らないもの、サイズ名より後ろが無いものは
 * `undefined`。本文には外のサイトの画像も書かれうるので、**形から外れたものを
 * 黙って通さない**。
 *
 * 各段を `decodeURIComponent` で戻すのは、`photoUrlOf` が段ごとに符号化している
 * ため。空白を含むファイル名はここで元に戻る。壊れた符号化は例外になるので、
 * 「読めなかった」に倒す——本文の1箇所のためにビルドを止めるものではない。
 *
 * **URL から元写真のキー（`sourceKey`）を導く関数はここに無い。導けないためである。**
 * 配信キーは元写真の拡張子を `webp` に替えたもので（`photoKeyOf`）、`.jpg` から
 * 入れても `.JPG` から入れても `.HEIC` から入れても同じ URL になる。目録の `sk` は
 * 拡張子を含むファイル名なので、URL から `sk` は組み立てられない。
 *
 * 「`.jpg` だろう」と当てて引く形にはしない。**当たっているうちは動き、外れたときに
 * その写真だけ静かに機材が出ない**。それは記録を持たない写真と見分けがつかないので、
 * 壊れていることに気づけない。突き合わせは配信パスで行い、両側とも `photoPathOf` から
 * 前向きに組み立てる（`src/lib/site-data.ts`）。
 */
export function photoPathFromUrl(base: string, url: string): string | undefined {
  const prefix = `${base.replace(/\/+$/, '')}/`
  if (!url.startsWith(prefix)) return undefined

  const rest = url.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined

  const size = rest.slice(0, slash)
  if (!PHOTO_SIZES.includes(size as PhotoSize)) return undefined

  const encoded = rest.slice(slash + 1)
  if (encoded === '') return undefined

  try {
    return encoded.split('/').map(decodeURIComponent).join('/')
  } catch {
    return undefined
  }
}

/**
 * 配信パスから、その写真が属する日付を取り出す。
 *
 * 配信パスは元写真のキーと同じ形（日付の3段と、区切りを含まないファイル名）を
 * しているので、`photoSourceOf` の規約がそのまま使える。暦上実在しない日付を外す
 * ことも同じで、**目録を引くための値がエントリの日付と突き合わせられない**という
 * 状態を作らない。
 *
 * 取り出すのは日付だけである。ファイル名は拡張子が `webp` に替わっており、元写真の
 * ファイル名——目録の `sk`——とは別物なので返さない。
 */
export function photoDateOf(path: string): string | undefined {
  return photoSourceOf(path)?.date
}

/**
 * 元写真の Content-Type。パスでもファイル名でも受け取る。
 *
 * 元写真は公開されないため表示には影響しない。手元に落として開いたときのために付けて
 * おくだけで、変換は中身を見て行われる。知らない拡張子でも投入は止めない。
 *
 * 拡張子を最後の区切りより後ろだけで探すのは、`2026/08.old/a` のようにディレクトリ名に
 * 点があっても、そちらを拡張子と読み違えないため（`photoKeyOf` と同じ理由）。
 */
export function photoContentTypeOf(path: string): string {
  const filename = path.slice(path.lastIndexOf('/') + 1)
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'

  return CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}
