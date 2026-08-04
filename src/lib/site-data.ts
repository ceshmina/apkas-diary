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

/** 隣接するエントリへの導線に出す最小限。本文は運ばない。 */
export interface EntryLink {
  date: string
  title: string
}

/** エントリと、その両隣の公開済みエントリ。 */
export interface EntryNeighbors {
  entry: Entry
  /** 1つ新しいエントリ。最新のエントリでは存在しない。 */
  newer?: EntryLink
  /** 1つ古いエントリ。最古のエントリでは存在しない。 */
  older?: EntryLink
}

/**
 * 公開済みエントリの全件を、両隣とともに返す。
 *
 * 隣接は暦上の前日・翌日ではなく、公開済みエントリの並びの上での隣とする。
 * 日記の書かれない日のほうが多いため、暦で解くと導線の大半がエントリの
 * 存在しない日付を指してしまう。月や年をまたいで隣接することがある。
 *
 * 下書きは `publishedEntries()` に最初から含まれないため、隣接の解決に
 * 下書きが関与することはない。除外のためのフィルタもここには存在しない。
 *
 * 隣には日付とタイトルだけを持たせる。日別ページは1000件を超え、その1件ずつに
 * 前後2件ぶんの本文を持たせる意味がない。手元になければ誤って描画することもない。
 */
export async function entriesWithNeighbors(): Promise<EntryNeighbors[]> {
  const entries = await publishedEntries()

  // `publishedEntries()` は日付の昇順。1つ後ろが新しく、1つ前が古い。
  return entries.map((entry, i) => ({
    entry,
    newer: toEntryLink(entries[i + 1]),
    older: toEntryLink(entries[i - 1]),
  }))
}

function toEntryLink(entry: Entry | undefined): EntryLink | undefined {
  if (!entry) return undefined
  return { date: entry.date, title: entry.title }
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
