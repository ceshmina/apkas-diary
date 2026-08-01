/**
 * 日記エントリの読み取り。
 *
 * 対象外のエントリを走査しないことを設計の要件としている。
 * どの関数がどの索引を使うかは、それぞれのコメントを参照。
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
 * バックアップのための書き出し専用。GSI1 には下書きが載らないため、
 * ベーステーブルを走査する必要がある。
 *
 * サイト生成と経路を分けているのは、サイト生成の入力に下書きが最初から
 * 存在しないという保証を守るため。1回の読み取りに統合すると、下書きの除外が
 * コード上のフィルタに戻り、保証がコードの正しさ依存になる。
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
