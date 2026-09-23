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
  /**
   * 場所。省略（`undefined`）は据え置き、`null`・空文字・空白のみは取り除く。
   *
   * 他の属性は省略を `??` で拾うだけで足りる。空のタイトルは空のタイトルとして
   * 正しく保存され、取り除くという状態が無いためである。場所だけは「持たない」が
   * 正当な状態なので、据え置きと削除を区別できなければ、一度付けた場所を
   * 編集画面から外せなくなる。
   */
  location?: string | null
}

export interface PutEntryResult {
  entry: Entry
  /** 新規作成なら true、既存エントリの更新なら false。 */
  created: boolean
}

/**
 * 場所を、保存する形に揃える。
 *
 * 前後の空白を落とし、空になったものは「持たない」に倒す。**この判断はここ1箇所に
 * だけ置く。** HTML のフォームは未入力を空文字として送るので、編集画面・CLI・
 * 取り込みのどこから来ても同じ結論になる場所に置く必要がある。呼び出し側それぞれで
 * 空文字を弾く形にすると、弾き漏らした経路からだけ空文字が入る。
 */
function normalizeLocation(value: string | null): string | undefined {
  if (value === null) return undefined

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * エントリを登録または更新する。
 *
 * 日付がキーであるため、既にエントリのある日付への登録は2件目を作らず
 * 既存エントリの更新になる。省略されたフィールドは既存の値を引き継ぐ。
 * 場所だけは、省略（据え置き）と取り除く指定を区別する（`PutEntryInput.location`）。
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

  // 指定が無ければ既存の値を保つ。指定があれば、正規化した結果をそのまま持たせる
  // （取り除く指定なら undefined になり、`toItem()` が属性そのものを書かない）。
  const location =
    input.location === undefined ? existing?.location : normalizeLocation(input.location)
  if (location !== undefined) {
    entry.location = location
  }

  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: toItem(entry),
    }),
  )

  return { entry, created: existing === undefined }
}
