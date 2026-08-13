/**
 * 写真の目録（`photo-catalog`）への書き足し。
 *
 * 変換が書くのは、元写真から読み取った撮影に関する情報・寸法・生成が終わったこと
 * の3つだけである。置き場所と配信 URL は投入の側が書く。**それぞれが自分の持ち分
 * だけを `SET` する**ので、どちらが先に走っても最終的な記録は同じになる
 * （design.md 決定3・決定4）。
 *
 * キーの組み立てと属性の名前は `src/lib/store/photo.ts` と**同じものを二重に持って
 * いる**。この Lambda は sharp の native binary を持つ独立したパッケージであり、
 * サイト生成の依存に混ぜないために `src/lib` を跨いで import しない構成になっている。
 * キーと URL の規約（`src/lib/photo.ts` と `index.ts`）が既に二重になっているのと
 * 同じ扱いで、**どちらかを変えるときは両方を直す。**
 */

import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import exifReader from 'exif-reader'

/** `src/lib/store/photo.ts` の `PHOTO_TYPE` と同じ値。 */
const PHOTO_TYPE = 'photo'

/** `src/lib/photo.ts` の `SOURCE_KEY_PATTERN` と同じ形。 */
const SOURCE_KEY_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)$/

let cached: DynamoDBDocumentClient | undefined

function docClient(): DynamoDBDocumentClient {
  if (!cached) {
    cached = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: {
        // 読み取れなかった項目は属性ごと落とす。`null` を書くと、欠けていることと
        // 空であることの区別が消える。
        removeUndefinedValues: true,
      },
    })
  }
  return cached
}

/**
 * 元写真から読み取る撮影に関する情報。
 *
 * **位置情報の項目を持たない。** 読み取ったうえで除外するのではなく、取り出す対象に
 * 含めない（design.md 決定6）。除外する形だと、書き忘れは「位置情報が入っている」
 * として現れる。列挙して選ぶ形なら、書き忘れは「項目が足りない」として現れる。
 * **失敗が安全な側に倒れるほうを採る**——この関数が付随情報を「消す処理を足す」の
 * ではなく「引き継ぐ指定を書かない」ことで除去しているのと同じ判断である。
 */
export interface CatalogExif {
  make?: string
  model?: string
  lensModel?: string
  focalLength?: number
  fNumber?: number
  exposureTime?: number
  iso?: number
  /** `YYYY-MM-DDTHH:MM:SS`。末尾に `Z` を付けない（`takenAtOf` を参照）。 */
  takenAt?: string
}

export interface Rendering {
  exif?: CatalogExif
  width?: number
  height?: number
}

interface Source {
  date: string
  filename: string
}

/**
 * 元写真のキーから、属する日付とファイル名を取り出す。
 *
 * `src/lib/photo.ts` の `photoSourceOf` と同じ規則。日付の規約に沿わないキーでは
 * `undefined` を返し、そのキーは目録に載らない。手元の CLI には日付という軸から
 * 外れた場所へ置ける入口があり、そこへ置かれた写真は属する日を持たない。
 */
function sourceOf(sourceKey: string): Source | undefined {
  const m = SOURCE_KEY_PATTERN.exec(sourceKey)
  if (!m) return undefined

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])

  // 暦上実在するかを、UTC で組み立てて読み直すことで見る。閏日もこれで通る。
  // 実行環境のタイムゾーン設定に依存しない（`src/lib/date.ts` の `weekdayOf` と
  // 同じ形）。
  const t = new Date(Date.UTC(year, month - 1, day))
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) {
    return undefined
  }

  return { date: `${m[1]}-${m[2]}-${m[3]}`, filename: m[4] as string }
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 撮影日時を壁時計の文字列にする。
 *
 * **末尾に `Z` を付けない。** EXIF の撮影日時はタイムゾーンを持たず、カメラの時計が
 * 指していた値そのものである。`exif-reader` はこれを `Date.UTC` で組み立てて返すので、
 * UTC として読み直せば元の値がそのまま戻る。`Z` を付けると、持っていない情報を
 * 持っているかのように見える。
 */
function takenAtOf(value: unknown): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined
  return value.toISOString().slice(0, 19)
}

/**
 * sharp が返した EXIF のバッファから、目録に残す項目を取り出す。
 *
 * 解釈に失敗しても投げない。項目が欠けたまま先へ進む（`photo-catalog` の「情報が
 * 欠けていることを理由に、記録そのものを作らないでいてはならない」）。
 */
export function readExif(exif: Buffer | undefined): CatalogExif | undefined {
  if (!exif) return undefined

  let parsed: ReturnType<typeof exifReader>
  try {
    parsed = exifReader(exif)
  } catch (error) {
    console.error('付随情報を解釈できませんでした', error)
    return undefined
  }

  const image = parsed.Image ?? {}
  const photo = parsed.Photo ?? {}

  const result: CatalogExif = {
    make: textOf(image.Make),
    model: textOf(image.Model),
    lensModel: textOf(photo.LensModel),
    focalLength: numberOf(photo.FocalLength),
    fNumber: numberOf(photo.FNumber),
    exposureTime: numberOf(photo.ExposureTime),
    iso: numberOf(photo.ISOSpeedRatings),
    takenAt: takenAtOf(photo.DateTimeOriginal),
  }

  // ひとつも取れなければ属性ごと置かない。空の入れ物は、読み取れたが空だったのか
  // 読み取れなかったのかを区別できない。
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

/**
 * 目録に、変換の結果を書き足す。
 *
 * 日付の規約に沿わないキーでは何もせず `false` を返す。
 *
 * `id` と `createdAt` を `if_not_exists` で包むのは、**変換が投入の側より先に走る
 * ことがあるため**である。生成は投入と同期せず、ブラウザからの投入では利用者が
 * 結果の画面へ到達する前に変換が終わっていることが普通に起きる。双方が別々に発行
 * した識別子のうち先に書いたほうが残り、あとから書いたほうは自分の発行したものを
 * 捨てる（design.md 決定4）。
 *
 * 属性名をすべて別名で置くのは、`type` / `date` が DynamoDB の予約語であるため。
 * 一部だけ別名にすると、予約語かどうかを属性ごとに覚えることになる。
 */
export async function recordRendering(
  sourceKey: string,
  rendering: Rendering,
  renderedAt: string,
): Promise<boolean> {
  const source = sourceOf(sourceKey)
  if (!source) return false

  const tableName = process.env.DIARY_TABLE_NAME
  if (!tableName) {
    throw new Error('環境変数 DIARY_TABLE_NAME が設定されていません')
  }

  // `type` / `date` / `filename` / `sourceKey` はキーから決まるので、投入の側が
  // 書いても同じ値になる。双方が書くことで、どちらが先に走ってもアイテムが自分を
  // 説明できる。
  const sets = [
    'SET #type = :type',
    '#date = :date',
    '#filename = :filename',
    '#sourceKey = :sourceKey',
    '#renderedAt = :renderedAt',
    '#id = if_not_exists(#id, :id)',
    '#createdAt = if_not_exists(#createdAt, :now)',
    '#updatedAt = :now',
  ]

  const names: Record<string, string> = {
    '#type': 'type',
    '#date': 'date',
    '#filename': 'filename',
    '#sourceKey': 'sourceKey',
    '#renderedAt': 'renderedAt',
    '#id': 'id',
    '#createdAt': 'createdAt',
    '#updatedAt': 'updatedAt',
  }

  const values: Record<string, unknown> = {
    ':type': PHOTO_TYPE,
    ':date': source.date,
    ':filename': source.filename,
    ':sourceKey': sourceKey,
    ':renderedAt': renderedAt,
    ':id': randomUUID(),
    ':now': renderedAt,
  }

  // 読み取れなかったものは式そのものに現れない。既に入っている値を消さない。
  if (rendering.exif) {
    sets.push('#exif = :exif')
    names['#exif'] = 'exif'
    values[':exif'] = rendering.exif
  }
  if (rendering.width !== undefined) {
    sets.push('#width = :width')
    names['#width'] = 'width'
    values[':width'] = rendering.width
  }
  if (rendering.height !== undefined) {
    sets.push('#height = :height')
    names['#height'] = 'height'
    values[':height'] = rendering.height
  }

  await docClient().send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: `PHOTO#${source.date}`, sk: source.filename },
      UpdateExpression: sets.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  )

  return true
}
