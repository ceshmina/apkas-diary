/**
 * 写真の目録。投入された写真1枚ごとの記録を、日記と同じテーブルに保持する。
 *
 * キー設計:
 *   pk = "PHOTO#<YYYY-MM-DD>"  日付でパーティションを切る（1日あたり数枚〜数十枚）
 *   sk = "<ファイル名>"         日内でファイル名順に並ぶ
 *
 * `sk` をファイル名にしているので、**同じ元写真のキーへの再投入は同じアイテムへの
 * 書き込みになる**。これは「同じキーへの再投入は派生画像を作り直す」（`photo-ingest`）
 * とそのまま対応する。並びがファイル名順になるのは、カメラの連番がそのまま撮影順に
 * なるためで、並びの安定を索引の側が満たす。
 *
 * **`gsi1pk` / `gsi1sk` は書かない。** GSI1 は sparse index なので、書かなければ写真は
 * 索引に載らない。公開サイトの生成が読むのは GSI1 だけであり（`listAllPublished`）、
 * 写真が同じテーブルに増えてもその入力は変わらない。
 *
 * 書き手は2つある。**投入（CLI・編集アプリケーション）と変換（Lambda）**で、
 * それぞれ別の面を書く。全体置換にすると投入側の書き込みが変換側の書いた `exif` を
 * 消すため、双方とも自分の持ち分だけを `SET` する（design.md 決定3）。変換側の実装は
 * `lambda/photo-resize/src/catalog.ts` にあり、パッケージが独立しているため**キーと
 * 属性の名前を二重に持っている。どちらかを変えるときは両方を直す。**
 */

import { randomUUID } from 'node:crypto'
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { assertValidDate, nowUtcIso } from '../date.js'
import { photoUrl, tableName } from '../env.js'
import { photoSourceOf, photoUrlOf } from '../photo.js'
import { docClient } from './client.js'

export const PHOTO_TYPE = 'photo'

/**
 * 本文に貼る既定のサイズ。目録が持つ URL もこれに揃える。
 *
 * 4つのサイズをすべて持つことはしない。`photo-delivery` が「サイズ名を差し替えれば
 * 同じ写真の別のサイズが得られる」を要件として持っているため、**1つあれば残りは
 * 問い合わせなしに導ける**。4つ持つと、配信ドメインが変わったときに直す対象が
 * 4倍になる（design.md 決定5）。
 */
const CATALOG_SIZE = 'medium' as const

/**
 * 元写真から読み取った撮影に関する情報。
 *
 * **位置情報は含まない。** 取り出す項目を列挙して選ぶ形にしてあり、読み取った全体を
 * 保存してからそこから除く形にはしていない（design.md 決定6）。保存しなければ、
 * 公開側へ漏れる経路が最初から存在しない。
 */
export interface PhotoExif {
  /** カメラのメーカー。 */
  make?: string
  /** カメラの機種。 */
  model?: string
  lensModel?: string
  /** mm。 */
  focalLength?: number
  /** F 値。 */
  fNumber?: number
  /** 秒。1/250 は 0.004 になる。 */
  exposureTime?: number
  iso?: number
  /**
   * 撮影日時。`YYYY-MM-DDTHH:MM:SS`。
   *
   * **末尾に `Z` を付けない。** EXIF の撮影日時はタイムゾーンを持たず、カメラの
   * 時計が指していた壁時計の値そのものである。UTC として読める形にすると、持って
   * いない情報を持っているかのように見える。`createdAt` / `updatedAt` が UTC の
   * ISO 8601 なのと形が違うのは、由来が違うためである。
   */
  takenAt?: string
}

export interface Photo {
  /**
   * 写真を指す識別子。
   *
   * 元写真のキーからも配信 URL からも独立している。置き場所や URL の規約が将来
   * 変わっても、同じ写真を指し続けられるようにするためである。**目録の中の識別子で
   * あり、配信 URL の組み立てには用いない**（design.md 決定2）。
   */
  id: string
  /** JST の暦日。`YYYY-MM-DD`。同じ日付のエントリとの紐付けそのもの。 */
  date: string
  filename: string
  /** アップロード先に置かれた元写真のキー。 */
  sourceKey: string
  /**
   * 配信 URL（`medium`）。
   *
   * 記録だけを読んだ側が、URL の組み立て規約を知らずに写真へ辿り着けるようにする
   * ためのもの（`photo-catalog`）。投入側だけが書くため、**変換が投入側より先に
   * 走った直後の短いあいだ欠けうる**。
   *
   * **このリポジトリの中では、表示に使う URL は `sourceKey` から組み立て直す。**
   * 手元にも編集アプリケーションにも配信 URL の基点（`PHOTO_URL`）があり、そちらの
   * ほうが常に今の配信ドメインを指す。記録された値は投入した時点のもので、ドメインが
   * 変わったあとは古いものを指したままになる。
   */
  url?: string
  exif?: PhotoExif
  /** 元写真の幅。回転を画素に適用したあとの値。 */
  width?: number
  height?: number
  /**
   * 派生画像が生成された時刻。UTC の ISO 8601。
   *
   * **これは配信可能かどうかの正ではない。** 目録は配信されているものの写しであり、
   * 配信できるかを決めるのは派生画像が配信先に在ることだけである（`photo-catalog`）。
   * 投入直後の待ち画面が配信先を直接見ているのはそのためで、こちらは記事編集画面の
   * 一覧が「そもそも作られたか」を1回の Query で知るために読む（design.md 決定8）。
   */
  renderedAt?: string
  /** UTC の ISO 8601。 */
  createdAt: string
  /** UTC の ISO 8601。 */
  updatedAt: string
}

export function photoPk(date: string): string {
  return `PHOTO#${date}`
}

export function photoSk(filename: string): string {
  return filename
}

export function photoFromItem(item: Record<string, unknown>): Photo {
  const id = item.id
  const date = item.date
  const sourceKey = item.sourceKey

  if (typeof id !== 'string' || typeof date !== 'string' || typeof sourceKey !== 'string') {
    throw new Error(`写真のアイテムに id / date / sourceKey がありません: ${JSON.stringify(item)}`)
  }

  return {
    id,
    date,
    sourceKey,
    filename: typeof item.filename === 'string' ? item.filename : '',
    url: typeof item.url === 'string' ? item.url : undefined,
    exif: isExif(item.exif) ? item.exif : undefined,
    width: typeof item.width === 'number' ? item.width : undefined,
    height: typeof item.height === 'number' ? item.height : undefined,
    renderedAt: typeof item.renderedAt === 'string' ? item.renderedAt : undefined,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  }
}

function isExif(value: unknown): value is PhotoExif {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 投入された写真を目録に記録する。
 *
 * 日付の規約に沿わないキー（CLI の `--key`）では記録せず `undefined` を返す。属する日を
 * 持たない写真は、日付を軸に引く目録に載せられない。**呼び出し側は、記録しなかった
 * ことを利用者に示すこと**（`photo-catalog`）。
 *
 * 書き込みは `PutItem`（全体置換）ではなく `UpdateItem`。全体置換にすると、変換側が
 * 先に書いた `exif` を消してしまう——しかも消えるのは**あとから書き直せない情報**で
 * ある。エントリの書き込み（`putEntry`）が `PutItem` なのと逆になるのは、エントリの
 * 書き手が1つ、写真の書き手が2つという違いによる。
 *
 * `id` と `createdAt` を `if_not_exists` で包むのは、**変換が投入側より先に走ることが
 * あるため**である。生成は投入と同期せず、ブラウザからの投入では利用者が結果の画面へ
 * 到達する前に変換が終わっていることが普通に起きる。双方が別々に発行した識別子の
 * うち、先に書いたほうが残り、あとから書いたほうは自分の発行したものを捨てる。
 * **どちらが先でも最終的な記録は同じになり、識別子は一度決まったら変わらない**
 * （design.md 決定4）。
 *
 * 何度実行しても同じ結果になる。`/photos/uploaded` は生成を待つあいだ数秒ごとに
 * 読み直され、そのたびにここを通る。
 */
export async function putPhoto(sourceKey: string): Promise<Photo | undefined> {
  const source = photoSourceOf(sourceKey)
  if (!source) return undefined

  const now = nowUtcIso()

  // 属性名をすべて別名で置くのは、`type` / `date` / `url` が DynamoDB の予約語で
  // あるため。一部だけ別名にすると、予約語かどうかを属性ごとに覚えることになる。
  const result = await docClient().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: photoPk(source.date), sk: photoSk(source.filename) },

      // `type` / `date` / `filename` / `sourceKey` は**キーから決まる**ので、変換側が
      // 書いても同じ値になる。双方が書くことで、どちらが先に走ってもアイテムが
      // 自分を説明できる。`url` だけは投入側しか組み立てられない。
      UpdateExpression: [
        'SET #type = :type',
        '#date = :date',
        '#filename = :filename',
        '#sourceKey = :sourceKey',
        '#url = :url',
        '#id = if_not_exists(#id, :id)',
        '#createdAt = if_not_exists(#createdAt, :now)',
        '#updatedAt = :now',
      ].join(', '),

      ExpressionAttributeNames: {
        '#type': 'type',
        '#date': 'date',
        '#filename': 'filename',
        '#sourceKey': 'sourceKey',
        '#url': 'url',
        '#id': 'id',
        '#createdAt': 'createdAt',
        '#updatedAt': 'updatedAt',
      },

      ExpressionAttributeValues: {
        ':type': PHOTO_TYPE,
        ':date': source.date,
        ':filename': source.filename,
        ':sourceKey': sourceKey,
        ':url': photoUrlOf(photoUrl(), CATALOG_SIZE, sourceKey),
        ':id': randomUUID(),
        ':now': now,
      },

      // 併せて書かれたぶんも含めた結果を返す。変換が既に書き終えていれば、
      // `exif` まで入った記録をそのまま受け取る。
      ReturnValues: 'ALL_NEW',
    }),
  )

  return photoFromItem(result.Attributes ?? {})
}

/**
 * 指定した日に属する写真を、ファイル名の昇順で取得する。
 *
 * `pk = PHOTO#<日付>` の1パーティションに閉じるため、他の日の写真は読み取られない。
 * 索引の並びがそのまま結果の並びになるので、読み出すたびに同じ順で並ぶ。
 */
export async function listPhotosByDate(date: string): Promise<Photo[]> {
  assertValidDate(date)

  const photos: Photo[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const result = await docClient().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': photoPk(date) },
        ExclusiveStartKey: lastKey,
      }),
    )

    for (const item of result.Items ?? []) {
      photos.push(photoFromItem(item))
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return photos
}
