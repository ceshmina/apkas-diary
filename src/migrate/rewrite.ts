/**
 * 本文の書き換え。旧ホストへの参照を新しい URL に差し替える。
 *
 * **この工程だけが後戻りできない。** ここまでの工程は追記しかせず、旧ホストにも1バイトも
 * 書かないので、いつ止めても捨てても日記は元のままである。本文に手を入れた瞬間から、
 * 移行の失敗が「日記が読めない」という形で表に出る。だから最後に置き、条件を厳しくし、
 * 控えを取ってから書く。
 *
 * 書くのは `putEntry` を通す。GSI キー属性の付け外しと `createdAt` の引き継ぎを知って
 * いるのはあの関数だけで（`src/lib/store/put.ts`）、ここで組み立て直すと下書きが公開側の
 * 索引に載る・作成日時が今になる、といった形で壊れる。
 *
 * 書き換えの前に本文を読み直し、棚卸しの時点と同じ参照が並んでいることを確かめる。
 * 突き合わせるのは本文全体ではなく**旧ホストの参照の集合**である。日記を書き足しただけ
 * なら書き換えて構わないし、写真の差し替えがあったならその日は飛ばして棚卸しからやり直す
 * 必要がある。見るべきはそこだけである。
 */

import { nowUtcIso } from '../lib/date.js'
import { putEntry } from '../lib/store/put.js'
import { getEntry } from '../lib/store/queries.js'
import { extractLegacyUrls, rewriteLegacyUrls } from './legacy-photo.js'
import type { PhotoRecord } from './manifest.js'
import { writeSnapshot } from './manifest.js'
import { isMigrated } from './verify.js'

export interface RewriteOptions {
  /** 移行の作業ディレクトリ。控えはこの下に置く。 */
  dir: string
  dryRun: boolean
}

export interface RewriteOutcome {
  date: string
  /** 置き換えた箇所の数。 */
  replaced: number
  /** 書き換えなかった理由。書き換えた場合は無い。 */
  skipped?: string
  /** すでに書き換え済みだった。 */
  done?: boolean
}

/**
 * 台帳にある日付を順に書き換える。
 *
 * 1日ずつ、その日の写真がすべて移行できていることを確かめてから書く。1枚でも欠けている
 * 日は丸ごと飛ばす。**同じ日記の中に、新しい側の写真と旧ホストの参照が混ざる状態を作らない。**
 * 混ざると、旧ホストを止めたときにどの日記が欠けるのかが分からなくなる。
 */
export async function rewriteEntries(
  records: readonly PhotoRecord[],
  options: RewriteOptions,
): Promise<RewriteOutcome[]> {
  const byDate = new Map<string, PhotoRecord[]>()
  for (const record of records) {
    const list = byDate.get(record.entryDate)
    if (list) list.push(record)
    else byDate.set(record.entryDate, [record])
  }

  const outcomes: RewriteOutcome[] = []

  for (const date of [...byDate.keys()].sort()) {
    const group = byDate.get(date) as PhotoRecord[]
    outcomes.push(await rewriteOne(date, group, options))
  }

  return outcomes
}

async function rewriteOne(
  date: string,
  group: readonly PhotoRecord[],
  options: RewriteOptions,
): Promise<RewriteOutcome> {
  const unfinished = group.filter((record) => !isMigrated(record))
  if (unfinished.length > 0) {
    return {
      date,
      replaced: 0,
      skipped: `照合が通っていない写真が ${unfinished.length} 枚あります`,
    }
  }

  const entry = await getEntry(date)
  if (!entry) {
    return { date, replaced: 0, skipped: 'エントリがありません' }
  }

  const present = new Set(extractLegacyUrls(entry.body))
  const expected = new Set(group.map((record) => record.oldUrl))

  // すでに書き換え済み。作業を止めて再開したときにここへ来る。
  if (present.size === 0 && group.every((record) => entry.body.includes(record.newUrl))) {
    return { date, replaced: 0, done: true }
  }

  const missing = [...expected].filter((url) => !present.has(url))
  const unknown = [...present].filter((url) => !expected.has(url))
  if (missing.length > 0 || unknown.length > 0) {
    return {
      date,
      replaced: 0,
      skipped:
        `棚卸しのあとに本文が変わっています` +
        `（消えた参照 ${missing.length} / 台帳に無い参照 ${unknown.length}）`,
    }
  }

  const replacements = new Map(group.map((record) => [record.oldUrl, record.newUrl]))
  const body = rewriteLegacyUrls(entry.body, replacements)
  const replaced = group.reduce((sum, record) => sum + record.occurrences, 0)

  // 置き換え漏れがないことを、置き換えたあとの本文そのもので確かめる。対応表と実際の
  // 本文が食い違っていた場合、ここで気づかなければ旧ホストへの参照が静かに残る。
  const remaining = extractLegacyUrls(body)
  if (remaining.length > 0) {
    return { date, replaced: 0, skipped: `旧ホストの参照が ${remaining.length} 件残ります` }
  }

  if (options.dryRun) return { date, replaced }

  await writeSnapshot(options.dir, {
    date: entry.date,
    title: entry.title,
    body: entry.body,
    status: entry.status,
    at: nowUtcIso(),
  })

  // 本文だけを渡す。題も公開状態も移行の対象ではなく、渡さなければ既存の値がそのまま
  // 引き継がれる（`putEntry`）。
  await putEntry({ date: entry.date, body })

  return { date, replaced }
}

export interface RollbackOutcome {
  date: string
  restored: boolean
  /** 戻さなかった理由。 */
  skipped?: string
}

/**
 * 控えから本文を戻す。
 *
 * 戻すのは本文だけである。題と公開状態は書き換えていないので、控えの値で上書きすると、
 * **移行のあとに編集された題を移行前に引き戻す**ことになる。
 */
export async function rollbackEntries(
  snapshots: readonly { date: string; body: string }[],
): Promise<RollbackOutcome[]> {
  const outcomes: RollbackOutcome[] = []

  for (const snapshot of snapshots) {
    const entry = await getEntry(snapshot.date)
    if (!entry) {
      outcomes.push({ date: snapshot.date, restored: false, skipped: 'エントリがありません' })
      continue
    }
    if (entry.body === snapshot.body) {
      outcomes.push({ date: snapshot.date, restored: false, skipped: 'すでに控えと同じです' })
      continue
    }

    await putEntry({ date: snapshot.date, body: snapshot.body })
    outcomes.push({ date: snapshot.date, restored: true })
  }

  return outcomes
}
