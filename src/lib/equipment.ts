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
 * | 機種 + レンズ（レンズが機種名を含まない） | `X-T5, XF33mmF1.4 R LM WR` |
 * | 機種 + レンズ（レンズが機種名を含む） | `iPhone 15 Pro` |
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

  if (!model) return lens
  if (!lens || saysModel(lens, model)) return model

  return `${model}${SEPARATOR}${lens}`
}

/**
 * レンズの名称が機種の名称を言い直しているか。
 *
 * スマートフォンの `LensModel` は `iPhone 15 Pro back triple camera 6.86mm f/1.78` の
 * ように機種名を含む。機材が一体である以上、レンズの名称は機種の別名でしかないので、
 * 同じ名前を1行のうちに2度出さない。固定レンズの機種（`X100V` など）も同じ形で落ちる。
 *
 * **メーカーや機種の一覧は持たない。** `Apple` / `Google` / … と並べる形も考えたが、
 * 一覧に載っていない端末が来た日に、レンズ名として長い文字列がそのまま出る——しかも
 * 気づくのは、その写真を拡大して見たときである。記録された値どうしの関係で決めるなら、
 * 知らない機材にも同じ規則が働く。
 */
function saysModel(lens: string, model: string): boolean {
  return lens.toLowerCase().includes(model.toLowerCase())
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
