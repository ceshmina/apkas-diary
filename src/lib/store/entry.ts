/**
 * 日記エントリの型と、DynamoDB アイテムとの相互変換。
 *
 * キー設計:
 *   pk     = "ENTRY#<年>"     年でパーティションを切る（1年あたり最大366アイテム）
 *   sk     = "<YYYY-MM-DD>"   年内で日付順に並ぶ
 *   gsi1pk = "ENTRY"（定数）  公開エントリのみに付与する
 *   gsi1sk = "<YYYY-MM-DD>"   公開エントリのみに付与する
 */

import { assertValidDate, yearOf } from '../date.js'

export const ENTRY_TYPE = 'entry'
export const GSI1_NAME = 'gsi1'
export const GSI1_PK = 'ENTRY'

export type EntryStatus = 'draft' | 'published'

export interface Entry {
  /** JST の暦日。`YYYY-MM-DD`。 */
  date: string
  title: string
  /** 本文。Markdown のまま保持し、HTML には変換しない。 */
  body: string
  status: EntryStatus
  /**
   * その日を過ごした場所。任意。
   *
   * 旧サイトの `Osaka, Japan` のような表記を、解釈せず1つの文字列として持つ。
   * 都市と国に分けないのは、集計の都合を保存の形に持ち込まないため。33地点すべてが
   * `<都市>, <国>` の形をしていたのは書き手がそう書いていたというだけで、将来も
   * そうとは限らない。分解が要るとなったときに、そのときの必要に合わせて分解する。
   *
   * **持たないときは `undefined`。空文字は取らない。** 空文字と不在の2つの表現を
   * 作ると、読む側が毎回どちらかを判断することになる。正規化は `putEntry()` が行う。
   */
  location?: string
  /** UTC の ISO 8601。 */
  createdAt: string
  /** UTC の ISO 8601。 */
  updatedAt: string
}

export interface EntryItem extends Entry {
  pk: string
  sk: string
  type: typeof ENTRY_TYPE
  gsi1pk?: string
  gsi1sk?: string
}

export function entryPk(date: string): string {
  return `ENTRY#${yearOf(date)}`
}

export function entrySk(date: string): string {
  return date
}

export function isEntryStatus(value: unknown): value is EntryStatus {
  return value === 'draft' || value === 'published'
}

/**
 * エントリを DynamoDB アイテムに変換する。
 *
 * 下書きのあいだは gsi1pk / gsi1sk 属性そのものを書かない。DynamoDB の GSI は
 * キー属性を持たないアイテムを索引に載せない（sparse index）ため、下書きは
 * GSI1 から自動的に外れる。公開サイトの生成は GSI1 を読むだけで公開分のみを
 * 得るので、取得側のフィルタのバグによる下書き漏洩が起こりえない。
 *
 * この付け外しを知る場所はこの関数だけに閉じる。将来 API を足すときも
 * 同じロジックを通すこと。
 */
export function toItem(entry: Entry): EntryItem {
  assertValidDate(entry.date)

  const item: EntryItem = {
    pk: entryPk(entry.date),
    sk: entrySk(entry.date),
    type: ENTRY_TYPE,
    date: entry.date,
    title: entry.title,
    body: entry.body,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }

  if (entry.status === 'published') {
    item.gsi1pk = GSI1_PK
    item.gsi1sk = entry.date
  }

  // 場所を持つときだけ属性を書く。持たないことを空文字で表さない。下書きのあいだ
  // gsi1pk / gsi1sk を書かないのと同じ流儀で、不在は不在のまま置く。読む側に
  // 「空文字は持っていないという意味だ」という解釈を求めずに済む。
  if (entry.location !== undefined) {
    item.location = entry.location
  }

  return item
}

export function fromItem(item: Record<string, unknown>): Entry {
  const date = item.date
  const status = item.status

  if (typeof date !== 'string') {
    throw new Error(`アイテムに date がありません: ${JSON.stringify(item)}`)
  }
  if (!isEntryStatus(status)) {
    throw new Error(`アイテムの status が不正です: ${JSON.stringify(status)}（date=${date}）`)
  }

  const entry: Entry = {
    date,
    title: typeof item.title === 'string' ? item.title : '',
    body: typeof item.body === 'string' ? item.body : '',
    status,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  }

  // 空文字は持っていないものとして読む。書き込みの側では入らない形にしてあるが、
  // 手で直したアイテムや古い書き込みが混じっても、読み取りの結果が2通りにならない。
  if (typeof item.location === 'string' && item.location !== '') {
    entry.location = item.location
  }

  return entry
}

/** 日付の昇順。文字列比較で足りる。 */
export function byDateAsc(a: Entry, b: Entry): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0
}

/** 日付の降順。 */
export function byDateDesc(a: Entry, b: Entry): number {
  return -byDateAsc(a, b)
}
