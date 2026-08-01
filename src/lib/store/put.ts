/**
 * 日記エントリの書き込み。
 *
 * 書き込み経路をこの1箇所に集約する。GSI キー属性の付け外し（sparse index）と
 * createdAt / updatedAt の管理をここだけが知る。将来 API を足すときも
 * 同じロジックを通すこと。
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { assertValidDate, nowUtcIso } from '../date.js'
import { tableName } from '../env.js'
import { docClient } from './client.js'
import { type Entry, type EntryStatus, toItem } from './entry.js'
import { getEntry } from './queries.js'

export interface PutEntryInput {
  date: string
  title?: string
  body?: string
  status?: EntryStatus
}

export interface PutEntryResult {
  entry: Entry
  /** 新規作成なら true、既存エントリの更新なら false。 */
  created: boolean
}

/**
 * エントリを登録または更新する。
 *
 * 日付がキーであるため、既にエントリのある日付への登録は2件目を作らず
 * 既存エントリの更新になる。省略されたフィールドは既存の値を引き継ぐ。
 *
 * PutItem はアイテム全体を置き換えるので、公開状態を draft に戻したときは
 * 新しいアイテムに gsi1pk / gsi1sk が含まれず、GSI1 から自動的に外れる。
 */
export async function putEntry(input: PutEntryInput): Promise<PutEntryResult> {
  assertValidDate(input.date)

  const existing = await getEntry(input.date)
  const now = nowUtcIso()

  if (!existing && input.body === undefined) {
    throw new Error(
      `${input.date} のエントリはまだ存在しません。新規作成には本文（--file）が必要です。`,
    )
  }

  const entry: Entry = {
    date: input.date,
    title: input.title ?? existing?.title ?? '',
    body: input.body ?? existing?.body ?? '',
    status: input.status ?? existing?.status ?? 'draft',
    // 既存エントリの更新では作成日時を引き継ぐ。
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }

  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: toItem(entry),
    }),
  )

  return { entry, created: existing === undefined }
}
