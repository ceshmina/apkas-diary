#!/usr/bin/env tsx
/**
 * 日記エントリを登録・更新する CLI。
 *
 * `scripts/entry.sh <環境>` 経由で呼ばれ、環境変数は呼び出し側が読み込む。
 *
 *   npm run entry -- staging --date 2026-08-01 --file today.md --title "散歩"
 *   npm run entry -- staging --date 2026-08-01 --status published
 */

import { readFile } from 'node:fs/promises'
import { isValidDate } from '../lib/date.js'
import { tableName } from '../lib/env.js'
import { isEntryStatus } from '../lib/store/entry.js'
import { putEntry } from '../lib/store/put.js'

interface Args {
  date?: string
  file?: string
  title?: string
  status?: string
}

const USAGE = `使い方:
  npm run entry -- <staging|production> --date <YYYY-MM-DD> [options]

オプション:
  --date <YYYY-MM-DD>          対象の日付（必須）。JST の暦日。
  --file <path>                本文の Markdown ファイル。新規作成時は必須。
  --title <text>               タイトル。
  --status <draft|published>   公開状態。省略時は新規なら draft、更新なら現状維持。

例:
  npm run entry -- staging --date 2026-08-01 --file ~/notes/today.md --title "散歩"
  npm run entry -- staging --date 2026-08-01 --status published
`

function parseArgs(argv: string[]): Args {
  const args: Args = {}

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]

    if (key === '-h' || key === '--help') {
      console.log(USAGE)
      process.exit(0)
    }

    const value = argv[i + 1]

    switch (key) {
      case '--date':
      case '--file':
      case '--title':
      case '--status': {
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`${key} に値が指定されていません`)
        }
        args[key.slice(2) as keyof Args] = value
        i++
        break
      }
      default:
        throw new Error(`不明な引数です: ${key}`)
    }
  }

  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.date) {
    console.error(USAGE)
    throw new Error('--date は必須です')
  }
  if (!isValidDate(args.date)) {
    throw new Error(`日付が不正です: ${args.date}（YYYY-MM-DD 形式の実在する日付）`)
  }
  if (args.status !== undefined && !isEntryStatus(args.status)) {
    throw new Error(`--status は draft か published のいずれかです: ${args.status}`)
  }

  const body = args.file === undefined ? undefined : await readFile(args.file, 'utf-8')

  const { entry, created } = await putEntry({
    date: args.date,
    title: args.title,
    body,
    status: args.status,
  })

  const action = created ? '作成' : '更新'
  console.log(`${action}しました: ${entry.date}（${entry.status}）`)
  console.log(`  table   : ${tableName()}`)
  console.log(`  title   : ${entry.title || '(なし)'}`)
  console.log(`  body    : ${entry.body.length} 文字`)

  if (entry.status === 'published') {
    console.log('  公開状態です。次のビルドから公開サイトに現れます。')
  } else {
    console.log('  下書きです。公開サイトには現れません（GSI に載らないため）。')
  }
}

main().catch((error: unknown) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
