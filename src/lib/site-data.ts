/**
 * 公開サイトの生成に使うデータ。
 *
 * **この モジュールが、公開サイトのビルドにおける唯一のデータ入力である。**
 *
 * 入力は `listAllPublished()`（GSI1 の Query）だけに限る。GSI1 は下書きを
 * 載せない（sparse index）ため、ここから先に下書きは一切流れてこない。
 * 年別・月別・月日別といった切り口はすべて、この1回の取得結果をメモリ上で
 * まとめ直して作る。
 *
 * ベーステーブルを引く `listByYear` などをサイト生成から呼んではならない。
 * それらは下書きを含むため、公開状態でのフィルタが必要になり、
 * 「フィルタが存在しないから下書きが漏れない」という保証が失われる。
 */

import { monthDayOf, yearMonthOf, yearOf } from './date.js'
import { recentCount } from './env.js'
import { byDateAsc, byDateDesc, type Entry } from './store/entry.js'
import { listAllPublished } from './store/queries.js'

let cached: Promise<Entry[]> | undefined

/**
 * 公開済みエントリの全件（日付の昇順）。
 *
 * Astro は getStaticPaths をルートごとに呼ぶため、取得結果を使い回す。
 */
export function publishedEntries(): Promise<Entry[]> {
  if (!cached) {
    cached = listAllPublished()
  }
  return cached
}

function groupBy(entries: Entry[], keyOf: (entry: Entry) => string): Map<string, Entry[]> {
  const grouped = new Map<string, Entry[]>()
  for (const entry of entries) {
    const key = keyOf(entry)
    const bucket = grouped.get(key)
    if (bucket) {
      bucket.push(entry)
    } else {
      grouped.set(key, [entry])
    }
  }
  return grouped
}

/** 年（`2026`）ごと。 */
export async function entriesByYear(): Promise<Map<string, Entry[]>> {
  return groupBy(await publishedEntries(), (entry) => yearOf(entry.date))
}

/** 年月（`2026-08`）ごと。 */
export async function entriesByYearMonth(): Promise<Map<string, Entry[]>> {
  return groupBy(await publishedEntries(), (entry) => yearMonthOf(entry.date))
}

/** 月日（`08-01`）ごと。「N年前の今日」に使う。 */
export async function entriesByMonthDay(): Promise<Map<string, Entry[]>> {
  return groupBy(await publishedEntries(), (entry) => monthDayOf(entry.date))
}

/** 日付（`2026-08-01`）で1件。1日1件なので一意に決まる。 */
export async function entryByDate(): Promise<Map<string, Entry>> {
  const map = new Map<string, Entry>()
  for (const entry of await publishedEntries()) {
    map.set(entry.date, entry)
  }
  return map
}

/** トップページ用。新しい順。 */
export async function recentEntries(): Promise<Entry[]> {
  const entries = [...(await publishedEntries())]
  return entries.sort(byDateDesc).slice(0, recentCount())
}

/** エントリが存在する年の一覧。新しい順。 */
export async function years(): Promise<string[]> {
  return [...(await entriesByYear()).keys()].sort().reverse()
}

export type { Entry }
export { byDateAsc, byDateDesc }
