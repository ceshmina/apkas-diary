/**
 * 目録に記録された撮影機材から、拡大表示に出す1行を組み立てる。
 *
 * **判断はビルド時に1度だけ行い、出来上がった1行を配る。** ブラウザ側に規則を持たせない。
 * 拡大表示は写真に添えられた説明も文字列として受け取っているので（`photo-zoom.ts`）、
 * 扱いが揃う。
 *
 * 目録が持つ撮影に関する項目のうち、ここが読むのは機種とレンズの2つだけである。焦点距離・
 * 絞り・シャッター速度・ISO 感度・撮影日時は読まない。**出さないものは、ブラウザに届く形に
 * もしない**（`diary-site-pages` の「配信物に現れるのは機材の名称に限る」）。
 */

import type { PhotoExif } from './store/photo.js'

/** 機種とレンズのあいだ。 */
const SEPARATOR = ', '

/**
 * 出す1行。記録が無ければ `undefined`。
 *
 * | 記録 | 出るもの |
 * | --- | --- |
 * | 機種のみ | `X-T5` |
 * | 機種 + レンズ | `X-T5, XF33mmF1.4 R LM WR` |
 * | 機種 + レンズ（レンズを出さない機種） | `iPhone 15 Pro` |
 * | 機種 + レンズ（レンズが機種名を含む） | `X100V` |
 * | 機種 + レンズ（名称と呼べる字を含まない） | `ILCE-7CM2` |
 * | レンズのみ | `XF33mmF1.4 R LM WR` |
 * | どちらも無い | `undefined` |
 *
 * **`make` は使わない。** EXIF の `Make` はメーカーの書いた字面がそのまま入っており
 * （`FUJIFILM` / `SONY`）、前に付けると大文字の揺れを画面に持ち込むことになる。加えて
 * `Canon EOS R6` のように `Model` が既にメーカー名を含むものがあり、重複を避ける判定を
 * もう1つ増やすことになる。出さなければ、どちらも起きない。`Model` だけで機種は一意に
 * 定まる。
 *
 * 空文字は `undefined` に倒す。記録が無いことと、空の値が記録されていることを、呼び出し
 * 側で見分けさせない。
 */
export function equipmentOf(exif: PhotoExif | undefined): string | undefined {
  const model = textOf(exif?.model)
  const lens = textOf(exif?.lensModel)

  if (!model) return isName(lens) ? lens : undefined
  if (!lens || !isName(lens) || hidesLens(model) || saysModel(lens, model)) return model

  return `${model}${SEPARATOR}${lens}`
}

/**
 * レンズの名称を出さない機種。機種名がこれで始まるものが当たる（大文字小文字は無視）。
 *
 * **一覧を持つことは避けたかったが、値だけでは分けられない。** レンズを選べない機材の
 * 多くは、レンズの名称に焦点距離と絞りしか書かない（`35.0 mm f/2.0`）。ところが
 * **レンズを交換する機材にもまったく同じ字面を書くものがある**——`NIKON D5600` の
 * `18.0-55.0 mm f/3.5-5.6` / `70.0-300.0 mm f/4.5-6.3` / `35.0 mm f/1.8` は、3本を
 * 使い分けた記録である。字面が同じで、望ましい結果が逆になる。
 *
 * だから「どういう字面か」ではなく「どの機材か」で決める。載せるのは、**レンズを選べない
 * 機材と、レンズが機材と一体である機材**に限る。そこではレンズの名称が、機種名から分かる
 * こと以上を何も言っていない。**レンズを交換する機材をここに載せてはならない。**
 *
 * 機種そのものではなく**系列の名前**で持つ。同じ系列の次の機種を買っても足さずに済み、
 * 系列はメーカーが交換式と分けて付けているためである（Sony の `DSC-` は Cyber-shot、
 * 交換式は `ILCE-`。富士フイルムの `X100` は固定レンズ、交換式は `X-T` / `X-H`）。
 *
 * レンズの名称を記録しない機種も載せている。いまは何も変わらないが、**その機材を
 * どう扱うかという分類**であり、記録が現れた日に同じ結論になる。
 *
 * 代償は、ここに無い種類の機材を使いはじめた日に1行足す必要があることである。足すまでは
 * レンズの名称が出るだけで、誤った機材名が出ることはない。
 */
const MODELS_WITHOUT_LENS_NAME = [
  // スマートフォン。レンズは複数あるが、名称は機種名を言い直したうえに画角の数字が
  // 続くだけである（`iPhone 15 Pro back triple camera 6.86mm f/1.78`）。
  'iPhone',
  // Xperia。いまレンズの名称は記録されていない。
  'XQ-',

  // 固定レンズのコンパクト機。
  // Sony Cyber-shot。`DSC-RX1RM3` は `35.0 mm f/2.0` とだけ書く。
  'DSC-',
  // RICOH GR。`GR LENS 18.3mm F2.8` / `GR LENS 26mm F2.8` で、機種名と1対1に対応する。
  'RICOH GR',
  // LEICA D-Lux。`DC VARIO-SUMMILUX 1:1.7-2.8/10.9-34 ASPH.` は一体の固定ズーム。
  'LEICA D-Lux',
  // 富士フイルム X100 系。いまレンズの名称は記録されていない。
  'X100',
] as const

function hidesLens(model: string): boolean {
  const lowered = model.toLowerCase()
  return MODELS_WITHOUT_LENS_NAME.some((name) => lowered.startsWith(name.toLowerCase()))
}

/**
 * レンズの名称が機種の名称を言い直しているか。**一覧の取りこぼしを受け止める側。**
 *
 * 一覧に無い機材でも、レンズの名称が機種名を含んでいれば同じ名前を2度出すことになる。
 * 一覧に載っていない端末を使った日に長い文字列がそのまま出る——しかも気づくのは、その
 * 写真を拡大して見たときである——という形の失敗を、ここで浅くしておく。
 */
function saysModel(lens: string, model: string): boolean {
  return lens.toLowerCase().includes(model.toLowerCase())
}

/**
 * 名称と呼べるものか。字も数字も含まないものは名称ではない。
 *
 * レンズの接点を持たない機材を付けたとき、`----` とだけ書かれることがある（実際に
 * ある）。**「読めなかった」を書き写したものであって、レンズの名前ではない。**
 */
function isName(text: string | undefined): text is string {
  return text !== undefined && /[\p{L}\p{N}]/u.test(text)
}

/**
 * 表示に出せる形に整え、空なら「無い」に倒す。
 *
 * 制御文字を先に落とす。**EXIF の文字列は固定長の領域に書かれることがあり、末尾が
 * NUL で埋まっている機種が実際にある**（`RICOH GR IIIx\u0000`）。`trim()` は空白しか
 * 落とさないので、これを先に外さないと NUL がそのままページに載る。
 *
 * そのうえで前後の空白を落とす。機種名を空白で埋める機材もある。
 */
function textOf(value: string | undefined): string | undefined {
  const text = value?.replace(/\p{Cc}/gu, '').trim()
  return text ? text : undefined
}
