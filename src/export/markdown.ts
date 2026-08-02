/**
 * 日記本文の Markdown 書き出し。
 *
 * DynamoDB・AWS アカウント・このアプリケーションのいずれを失っても日記そのものは
 * 読み続けられる、という状態を担保するための保全（`content-export`）。サイト生成の
 * 副次的な出力として毎回走り、別途の手動操作を必要としない。
 *
 * 書き出しは冪等でなければならない。異なる時点の結果を突き合わせて欠落や意図しない
 * 変化を検証できることが目的であり、内容の変わらない再実行が差分を生んではならない。
 * そのためファイルの中身には、ビルド時刻・実行順・ロケール・タイムゾーンに依存する値を
 * 一切含めない。日付は文字列のまま扱い、`Date` を経由しない。
 */

import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { yearOf } from '../lib/date.js'
import { exportDir } from '../lib/env.js'
import type { Entry } from '../lib/store/entry.js'
import { scanAllIncludingDrafts } from '../lib/store/queries.js'

const YEAR_DIR = /^\d{4}$/
const ENTRY_FILE = /^(\d{4})-\d{2}-\d{2}\.md$/

export interface ExportResult {
  dir: string
  written: number
  removed: number
}

/**
 * エントリ1件をファイルの中身にする。
 *
 * YAML frontmatter に属性を置き、その下に本文をそのまま置く。エディタで開くだけで
 * 日付・タイトル・公開状態・本文が読め、かつ標準的な YAML パーサで機械的にも読める。
 *
 * 本文中の `---`（hr）とは衝突しない。frontmatter は先頭の `---` から次の `---` まで
 * を見る規則であり、本文がどこで `---` を使っても解釈は変わらない。
 *
 * 属性の並びは固定する。実行ごとに変われば、内容が同じでも差分が出てしまう。
 */
function render(entry: Entry): string {
  const frontmatter = [
    '---',
    `date: ${entry.date}`,
    `status: ${entry.status}`,
    // title だけは任意の文字列で、`: ` を含む・`#` で始まる・引用符で始まる・改行を
    // 含むといった場合に素で書くと壊れる。YAML 1.2 は JSON のスーパーセットなので、
    // JSON の文字列リテラルをそのまま二重引用符スカラーとして書ける。
    // エスケープの規則を自前で持たずに済む。
    `title: ${JSON.stringify(entry.title)}`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    '---',
    '',
    '',
  ].join('\n')

  // 本文は加工せずそのまま繋ぐ。末尾に改行を足さないのは、バックアップとして
  // 本文をバイト単位で保つほうが正しいため。
  return frontmatter + entry.body
}

/** `2026-08-02` -> `2026/2026-08-02.md`。日付から一意に定まる。 */
function relPathOf(date: string): string {
  return join(yearOf(date), `${date}.md`)
}

/**
 * 書き出し先に残っている、いまのエントリに対応しないファイルを消す。
 *
 * 消さずに残すと、異なる時点の書き出し結果を比較したときに、その間に生じた削除が
 * 差分として現れない。
 *
 * 対象は `<年>/<YYYY-MM-DD>.md` の形に一致し、かつ年のディレクトリ名と日付の年が
 * 揃っているものだけに限る。書き出し先を丸ごと作り直さないのは、DIARY_EXPORT_DIR が
 * 誤って別のディレクトリを指したまま走ったときの被害が大きすぎるため。
 */
async function removeStale(dir: string, expected: Set<string>): Promise<number> {
  let removed = 0

  for (const year of await readdir(dir, { withFileTypes: true })) {
    if (!year.isDirectory() || !YEAR_DIR.test(year.name)) continue

    const yearPath = join(dir, year.name)

    for (const file of await readdir(yearPath, { withFileTypes: true })) {
      if (!file.isFile()) continue

      const match = ENTRY_FILE.exec(file.name)
      if (!match || match[1] !== year.name) continue
      if (expected.has(join(year.name, file.name))) continue

      await rm(join(yearPath, file.name))
      removed++
    }

    // 空になった年のディレクトリは残さない。同じデータからは常に同じツリーに
    // なるようにするため。中身が残っていれば rmdir は失敗するので、消し過ぎない。
    if ((await readdir(yearPath)).length === 0) {
      await rmdir(yearPath)
    }
  }

  return removed
}

/**
 * 下書きを含む全エントリを書き出す。
 *
 * 下書きも対象に含めるのはバックアップが目的だからで、公開サイトの生成とは経路を
 * 分けてある（`scanAllIncludingDrafts` のコメントを参照）。
 *
 * 例外は握りつぶさず、そのまま呼び出し側へ伝播させる。書き出しの失敗はサイト生成の
 * 失敗として扱わなければならない。
 */
export async function exportEntries(): Promise<ExportResult> {
  const dir = exportDir()
  const entries = await scanAllIncludingDrafts()

  // エントリが0件でも基底ディレクトリは作る。書き出しが走って対象がなかったのか、
  // 書き出しそのものが走らなかったのかを、跡から区別できるようにするため。
  await mkdir(dir, { recursive: true })
  for (const year of new Set(entries.map((entry) => yearOf(entry.date)))) {
    await mkdir(join(dir, year), { recursive: true })
  }

  const expected = new Set<string>()
  for (const entry of entries) {
    const rel = relPathOf(entry.date)
    expected.add(rel)
    await writeFile(join(dir, rel), render(entry), 'utf8')
  }

  return { dir, written: entries.length, removed: await removeStale(dir, expected) }
}
