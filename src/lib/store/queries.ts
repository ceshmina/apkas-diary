/**
 * 日記エントリの読み取り。
 *
 * 対象外のエントリを走査しないことを設計の要件としている。
 * どの関数がどの索引を使うかは、それぞれのコメントを参照。
 *
 * **同じテーブルには写真の目録も同居している**（`src/lib/store/photo.ts`）。エントリ
 * 以外のものが読み取りの結果に現れないことは、この1枚が担保する。**呼び出し側に
 * 種類での絞り込みは無い**（`diary-entry-store`）。振り分けを呼び出し側に置くと、
 * 振り分けの漏れがそのまま公開サイトの生成物に現れる。下書きの除外を取得側のフィルタ
 * に戻さないのと同じ判断である。
 *
 * 混ざらない根拠は関数によって違う。
 *
 * - `getEntry` / `listByYear` / `listByMonth`: パーティションキーが `ENTRY#<年>`。
 *   写真は `PHOTO#<YYYY-MM-DD>` にあり、**そもそも読む範囲に入らない。**
 * - `listRecent` / `listAllPublished`: GSI1 を読む。写真は GSI キー属性を持たないので
 *   sparse index に載らない。**索引に存在しない。**
 * - `scanAllIncludingDrafts`: 走査なので写真のアイテムも辿る。落とすのは `type` の
 *   条件で、**これだけが条件による除外**である。
 */

import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { assertValidDate, pad2 } from '../date.js'
import { tableName } from '../env.js'
import { docClient } from './client.js'
import {
  byDateAsc,
  ENTRY_TYPE,
  type Entry,
  entryPk,
  entrySk,
  fromItem,
  GSI1_NAME,
  GSI1_PK,
} from './entry.js'

/**
 * 特定の日のエントリを1件取得する。
 *
 * URL に年が含まれるためパーティションキーを組み立てられる。Query ですらなく
 * GetItem で済み、他の日のエントリは読み取られない。
 *
 * ベーステーブルを引くため、下書きも返る。公開サイトの生成には使わないこと。
 */
export async function getEntry(date: string): Promise<Entry | undefined> {
  assertValidDate(date)

  const result = await docClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: entryPk(date), sk: entrySk(date) },
    }),
  )

  return result.Item ? fromItem(result.Item) : undefined
}

/**
 * 指定した年のエントリを日付順に取得する。
 *
 * ベーステーブルの1パーティションに閉じるため、他の年は読み取られない。
 * 下書きも返る。公開サイトの生成には使わないこと。
 */
export async function listByYear(year: string): Promise<Entry[]> {
  return queryBaseTable(`ENTRY#${year}`)
}

/**
 * 指定した年月のエントリを日付順に取得する。
 *
 * ソートキーの前方一致で月に絞るため、同じ年の他の月は読み取られない。
 * 下書きも返る。公開サイトの生成には使わないこと。
 */
export async function listByMonth(year: string, month: string): Promise<Entry[]> {
  return queryBaseTable(`ENTRY#${year}`, `${year}-${month}`)
}

async function queryBaseTable(pk: string, skPrefix?: string): Promise<Entry[]> {
  const entries: Entry[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const result = await docClient().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: skPrefix
          ? '#pk = :pk AND begins_with(#sk, :skPrefix)'
          : '#pk = :pk',
        ExpressionAttributeNames: skPrefix ? { '#pk': 'pk', '#sk': 'sk' } : { '#pk': 'pk' },
        ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':skPrefix': skPrefix } : { ':pk': pk },
        ExclusiveStartKey: lastKey,
      }),
    )

    for (const item of result.Items ?? []) {
      entries.push(fromItem(item))
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return entries.sort(byDateAsc)
}

/**
 * 公開済みエントリを日付の降順で、指定件数まで取得する。
 *
 * GSI1 は下書きを載せない（sparse index）ため、公開状態での絞り込みは行わない。
 */
export async function listRecent(limit: number): Promise<Entry[]> {
  const result = await docClient().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: GSI1_NAME,
      KeyConditionExpression: '#gsi1pk = :gsi1pk',
      ExpressionAttributeNames: { '#gsi1pk': 'gsi1pk' },
      ExpressionAttributeValues: { ':gsi1pk': GSI1_PK },
      ScanIndexForward: false,
      Limit: limit,
    }),
  )

  return (result.Items ?? []).map(fromItem)
}

/**
 * 公開済みエントリを全件、日付の昇順で取得する。
 *
 * 公開サイトの生成における唯一の入力。GSI1 は下書きを載せないため、
 * 取得側に公開状態でのフィルタは存在しない。フィルタが存在しないので、
 * フィルタのバグによって下書きが漏れることがない。
 */
export async function listAllPublished(): Promise<Entry[]> {
  const entries: Entry[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const result = await docClient().send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: GSI1_NAME,
        KeyConditionExpression: '#gsi1pk = :gsi1pk',
        ExpressionAttributeNames: { '#gsi1pk': 'gsi1pk' },
        ExpressionAttributeValues: { ':gsi1pk': GSI1_PK },
        ExclusiveStartKey: lastKey,
      }),
    )

    for (const item of result.Items ?? []) {
      entries.push(fromItem(item))
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return entries.sort(byDateAsc)
}

/**
 * 下書きを含む全エントリを日付の昇順で取得する。
 *
 * 使うのはバックアップのための書き出しと、編集アプリケーションの一覧。
 * どちらも下書きを見せる側であり、公開サイトの生成はこの関数を呼ばない。
 * GSI1 には下書きが載らないため、ベーステーブルを走査する必要がある。
 *
 * サイト生成と経路を分けているのは、サイト生成の入力に下書きが最初から
 * 存在しないという保証を守るため。1回の読み取りに統合すると、下書きの除外が
 * コード上のフィルタに戻り、保証がコードの正しさ依存になる。
 *
 * `type` の条件は写真の目録も落とす。**走査なので写真のアイテムも辿ることになり、
 * 消費する容量は写真の枚数だけ増える。** これを受け入れているのは、この関数を呼ぶのが
 * 編集アプリケーションの一覧と書き出しの2つだけで、**公開サイトの生成の経路には
 * 現れない**ためである（`diary-entry-store` の「索引を用いるエントリの取得は他の種類の
 * ものに影響されない」）。写真が増えるほどサイトの生成が重くなる、という結び付きは
 * 生じない。
 */
export async function scanAllIncludingDrafts(): Promise<Entry[]> {
  const entries: Entry[] = []
  let lastKey: Record<string, unknown> | undefined

  do {
    const result = await docClient().send(
      new ScanCommand({
        TableName: tableName(),
        FilterExpression: '#type = :type',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: { ':type': ENTRY_TYPE },
        ExclusiveStartKey: lastKey,
      }),
    )

    for (const item of result.Items ?? []) {
      entries.push(fromItem(item))
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return entries.sort(byDateAsc)
}

/** `listByMonth` に渡す月を数値から作る補助。 */
export function monthKey(month: number): string {
  return pad2(month)
}
