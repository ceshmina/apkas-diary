/**
 * 公開サイトの生成に使うデータ。
 *
 * **このモジュールが、公開サイトのビルドにおけるデータ入力のすべてである。**
 * 入力は2つある。日記のエントリと、写真の目録。
 *
 * エントリの入力は `listAllPublished()`（GSI1 の Query）だけに限る。GSI1 は下書きを
 * 載せない（sparse index）ため、ここから先に下書きは一切流れてこない。
 * 年別・月別・月日別といった切り口はすべて、この1回の取得結果をメモリ上で
 * まとめ直して作る。
 *
 * ベーステーブルを引く `listByYear` などをサイト生成から呼んではならない。
 * それらは下書きを含むため、公開状態でのフィルタが必要になり、
 * 「フィルタが存在しないから下書きが漏れない」という保証が失われる。
 *
 * 写真の目録は、拡大表示に撮影機材を出すために読む（`photoEquipment()`）。**入力が2つに
 * なっても、下書きが漏れうる経路は1本のままである。**
 *
 *   - エントリの取得は `listAllPublished()` の1本だけで、ここは1文字も変わっていない。
 *   - 写真は公開・下書きの区別を持たない。写真は日記に属するのであって、公開状態を
 *     持たない。
 *   - 目録を引く日付は、**公開済みエントリの本文に現れた写真のもの**だけである。下書きの
 *     本文はこの経路に入らないので、下書きにしか貼られていない写真の日付は引かれない。
 *     仮に引いたとしても、引き当ては本文の URL で行うので、公開ページに現れない写真の
 *     記録が生成物に出ることはない。
 *
 * 一覧に並べる縮小画像（`thumbnailsOf()`）は、**入力を増やさない**。受け取ったエントリの
 * 本文を整形して、そこに写真として出るものを拾うだけである。一覧に渡るエントリはどれも
 * `publishedEntries()` から切り出したものなので、下書きの本文に貼られた写真が一覧に
 * 現れることはない。目録も引かない。URL を組み立てるのに要るものは本文の URL だけで揃う。
 */

import { monthDayOf, yearMonthOf, yearOf } from './date.js'
import { photoUrl, recentCount } from './env.js'
import { equipmentOf } from './equipment.js'
import { imageSourcesOf, renderMarkdown } from './markdown.js'
import { mapWithConcurrency } from './parallel.js'
import { photoDateOf, photoPathFromUrl, photoPathOf, photoUrlOfPath } from './photo.js'
import { byDateAsc, byDateDesc, type Entry } from './store/entry.js'
import { listPhotosByDate } from './store/photo.js'
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

/**
 * 目録を引くとき、同時に走らせる本数。
 *
 * 写真のある日の数だけ往復が要る（数百本）。順に回すと1本あたりの待ちがそのまま総時間に
 * なり、全部並べると1回のビルドで数百の接続を一度に開くことになる。待ち時間だけを重ねる
 * ちょうどの幅にする。
 */
const PHOTO_CONCURRENCY = 8

/** 本文に現れる写真の URL。Markdown の `![](...)` も、本文に直接書かれた `<img src="...">` も拾う。 */
const PHOTO_URL_PATTERN = /https?:\/\/[^\s)"'<>]+/g

let equipment: Promise<(src: string) => string | undefined> | undefined

/**
 * 本文の `img` の `src` から、拡大表示に出す撮影機材の1行を引く関数。
 *
 * **Map ではなく関数を返す。** 整形（`src/lib/markdown.ts`）は本文の `src` しか持って
 * おらず、そこから何を鍵にして引くかは写真の URL の規約の話である。関数にしておけば、
 * 規約を知っているのはここと `src/lib/photo.ts` だけで済み、整形は「引ければ付ける」
 * だけを知っていればよい。
 *
 * ビルド中に1度だけ作り、1,000を超える日別ページのすべてが同じものを見る
 * （`publishedEntries()` と同じ流儀）。
 *
 * 引くのは**公開済みエントリの本文に写真が現れた日**だけである。全件の走査はしない。
 * `src/lib/store/queries.ts` が「走査は公開サイトの生成の経路には現れない」「写真が
 * 増えるほどサイトの生成が重くなる、という結び付きは生じない」と書いているとおりで、
 * **日付ごとに引けば、増えるのは写真のある日の数であって枚数ではない。** 1日に何枚
 * 貼っても往復は1回で済む。
 *
 * 日付を**エントリの日付ではなく URL から**取るのは、本文が別の日の写真を指せるため。
 * いまは投入も移行も「日記の日付に置く」規約で動いているので実際には一致するが、一致を
 * 前提にすると、**一致しなくなった日に機材が静かに出なくなる**。URL から取れば前提が要らない。
 *
 * 突き合わせに配信パスを使う理由は `photoPathFromUrl` のコメントを参照（URL から元写真の
 * キーは導けない）。**両側とも `photoPathOf` から前向きに組み立てる。**
 */
export function photoEquipment(): Promise<(src: string) => string | undefined> {
  if (!equipment) {
    equipment = buildPhotoEquipment()
  }
  return equipment
}

async function buildPhotoEquipment(): Promise<(src: string) => string | undefined> {
  const base = photoUrl()
  const entries = await publishedEntries()

  const dates = new Set<string>()
  for (const entry of entries) {
    for (const url of entry.body.match(PHOTO_URL_PATTERN) ?? []) {
      const path = photoPathFromUrl(base, url)
      const date = path ? photoDateOf(path) : undefined
      if (date) dates.add(date)
    }
  }

  const found = new Map<string, string>()
  const days = await mapWithConcurrency([...dates], PHOTO_CONCURRENCY, (date) =>
    listPhotosByDate(date),
  )

  for (const photos of days) {
    for (const photo of photos) {
      const label = equipmentOf(photo.exif)
      if (label) found.set(photoPathOf(photo.sourceKey), label)
    }
  }

  return (src) => {
    const path = photoPathFromUrl(base, src)
    return path ? found.get(path) : undefined
  }
}

const thumbnails = new Map<string, Promise<string[]>>()

/**
 * エントリの一覧に並べる縮小画像（`thumbnail`）の URL。本文に写真として出る順に並び、
 * 同じ写真は1度だけ現れる。写真のないエントリでは空の配列。
 *
 * 拾うのは、日別ページと同じ整形を通した HTML の `img` である（`imageSourcesOf` の
 * コメント）。そのうち日記の写真の配信 URL だけを残し、配信パスで重複を除く。外部の
 * サイトの画像は `photoPathFromUrl` が `undefined` を返すので落ちる。
 *
 * 整形は機材の引き当てを渡さずに行う。一覧が要るのは `src` だけで、引き当てを渡すと
 * 目録を読み終えるまで待つことになる。
 *
 * **エントリの日付ごとに1度だけ作る。** トップ・年別・月別・月日ページは同じエントリを
 * 繰り返し載せるが、整形は1件につき1度で済む。1日1件なので、日付で一意に決まる。
 */
export function thumbnailsOf(entry: Entry): Promise<string[]> {
  let found = thumbnails.get(entry.date)
  if (!found) {
    found = buildThumbnails(entry.body)
    thumbnails.set(entry.date, found)
  }
  return found
}

async function buildThumbnails(body: string): Promise<string[]> {
  const base = photoUrl()
  const paths = new Set<string>()
  for (const src of imageSourcesOf(await renderMarkdown(body))) {
    const path = photoPathFromUrl(base, src)
    if (path) paths.add(path)
  }
  return [...paths].map((path) => photoUrlOfPath(base, 'thumbnail', path))
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
