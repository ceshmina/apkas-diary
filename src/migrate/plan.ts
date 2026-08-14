/**
 * 棚卸し。日記の本文から旧ホストの参照を集め、移行後の姿を台帳に書き出す。
 *
 * 読むのは DynamoDB である。`export/` の書き出しはビルドのたびに作り直されるミラーで
 * あって正ではなく、**最後にビルドした時点の本文**を移行の入力にすると、そのあとに書いた
 * 日記の写真が丸ごと落ちる。下書きも対象に含めるのは、下書きの本文にも旧ホストの参照が
 * あり、公開したときに旧ホストを指したままになるため。
 *
 * ここは1バイトも書き込まない。台帳を作るだけで、DynamoDB にも S3 にも旧ホストにも
 * 触らない。**確かめ終えるまで何も動かさない**ための工程である。
 */

import { scanAllIncludingDrafts } from '../lib/store/queries.js'
import { extractLegacyUrls, migratedPhotoUrl, parseLegacyUrl } from './legacy-photo.js'
import type { PhotoRecord } from './manifest.js'

/** 本文に現れてよい配信サイズ。 */
const EXPECTED_SIZE = 'medium'

export interface PlanResult {
  records: PhotoRecord[]
  /** 先へ進めない食い違い。1件でもあれば移行を始めない。 */
  problems: string[]
  /** 走査したエントリの数。 */
  scanned: number
  /** 旧ホストの参照を持っていたエントリの数。 */
  entries: number
}

/**
 * 台帳を組み立てる。
 *
 * `only` を渡すとその日付のエントリだけを対象にする。staging での予行や、落ちた行の
 * 作り直しのために使う。
 */
export async function planMigration(
  photoUrlBase: string,
  only?: ReadonlySet<string>,
): Promise<PlanResult> {
  const entries = await scanAllIncludingDrafts()
  const targets = only ? entries.filter((entry) => only.has(entry.date)) : entries

  const records: PhotoRecord[] = []
  const problems: string[] = []

  /** 旧 URL がどのエントリから参照されていたか。日付が一意に決まることを確かめる。 */
  const seenUrls = new Map<string, string>()
  /** `<日付>/<ファイル名>` の重複。移行後のキーがぶつかることを確かめる。 */
  const seenKeys = new Map<string, string>()

  let withRefs = 0

  for (const entry of targets) {
    const urls = extractLegacyUrls(entry.body)
    if (urls.length === 0) continue
    withRefs++

    // 同じ本文に同じ URL が2度以上現れることはある（同じ写真を並べる）。写真としては
    // 1枚なので台帳の行は1つにし、何度現れたかだけを数えておく。
    const counts = new Map<string, number>()
    for (const url of urls) {
      counts.set(url, (counts.get(url) ?? 0) + 1)
    }

    for (const [url, occurrences] of counts) {
      const ref = parseLegacyUrl(url)
      if (!ref) {
        problems.push(`${entry.date}: 想定した形の URL ではありません: ${url}`)
        continue
      }
      if (ref.size !== EXPECTED_SIZE) {
        problems.push(`${entry.date}: ${EXPECTED_SIZE} 以外のサイズを参照しています: ${url}`)
        continue
      }

      const seenAt = seenUrls.get(url)
      if (seenAt !== undefined) {
        // 同じ写真が複数の日記から参照されていると、属する日が一意に決まらない。
        // 決め方（design.md 決定2）そのものが成り立たなくなるので、黙って片方に
        // 寄せず止める。
        problems.push(`${url} が ${seenAt} と ${entry.date} の両方から参照されています`)
        continue
      }
      seenUrls.set(url, entry.date)

      const key = `${entry.date}/${ref.name}`
      const collidesWith = seenKeys.get(key)
      if (collidesWith !== undefined) {
        problems.push(`${entry.date}: ${ref.name} が ${collidesWith} と同じキーになります: ${url}`)
        continue
      }
      seenKeys.set(key, url)

      records.push({
        oldUrl: url,
        entryDate: entry.date,
        path: ref.path,
        name: ref.name,
        newUrl: migratedPhotoUrl(photoUrlBase, entry.date, ref.name),
        occurrences,
      })
    }
  }

  records.sort((a, b) =>
    a.entryDate === b.entryDate
      ? a.name.localeCompare(b.name)
      : a.entryDate.localeCompare(b.entryDate),
  )

  return { records, problems, scanned: targets.length, entries: withRefs }
}
