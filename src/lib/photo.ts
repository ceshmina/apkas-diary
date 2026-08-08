/**
 * 配信される写真の URL 規約。
 *
 * サイズ名を先頭に置き、元写真のキーは拡張子だけを webp に替える。サイズ名以外が
 * すべて一致するので、1つのサイズの URL からその写真の他のサイズを導ける。
 * 日別ページの拡大表示（`src/components/photo-zoom.ts`）が既にこの形に依存している。
 *
 * 同じ規約を `lambda/photo-resize/src/index.ts` も持っている。あちらは派生画像を
 * 書く側、こちらは URL を組み立てて見せる側で、パッケージが分かれているため共有して
 * いない。**どちらかを変えるときは両方を直す。**
 */

export const PHOTO_SIZES = ['thumbnail', 'small', 'medium', 'large'] as const

export type PhotoSize = (typeof PHOTO_SIZES)[number]

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
