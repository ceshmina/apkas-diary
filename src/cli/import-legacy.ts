#!/usr/bin/env tsx

/**
 * 旧サイト（eskarun）の記事を DynamoDB に取り込む CLI。
 *
 * `scripts/import-legacy.sh <環境>` 経由で呼ばれ、環境変数は呼び出し側が読み込む。
 * 旧サイトからの移行のためのコマンド。移行後も突き合わせのために残してある。
 *
 *   npm run import-legacy -- staging --source ../../apkas/eskarun/_articles --dry-run
 *   npm run import-legacy -- staging --source ../../apkas/eskarun/_articles --only 2023-11-01,2024-09-29
 *
 * 既定は下見（--dry-run 相当ではなく）ではなく実行だが、対象の絞り込みを明示しない限り
 * 見つかった記事をすべて対象にする。まず --dry-run で件数と警告を確かめること。
 */

import { collectArticles, type LegacyArticle } from '../legacy/source.js'
import { isValidDate } from '../lib/date.js'
import { tableName } from '../lib/env.js'
import { isEntryStatus } from '../lib/store/entry.js'
import { putEntry } from '../lib/store/put.js'
import { getEntry } from '../lib/store/queries.js'

interface Args {
  source?: string
  from?: string
  to?: string
  only?: string
  status?: string
  dryRun: boolean
}

const USAGE = `使い方:
  npm run import-legacy -- <staging|production> --source <旧記事のディレクトリ> [options]

オプション:
  --source <dir>               旧サイトの記事ディレクトリ（必須）。再帰的にたどる。
  --from <YYYY-MM-DD>          この日付以降だけを対象にする。
  --to <YYYY-MM-DD>            この日付以前だけを対象にする。
  --only <日付,日付,...>       指定した日付だけを対象にする。--from / --to より優先する。
  --status <draft|published>   取り込み時の公開状態。既定は published。
                               元の frontmatter に status があればそちらを優先する。
  --dry-run                    書き込まず、対象と警告だけを表示する。

例:
  npm run import-legacy -- staging --source ../../apkas/eskarun/_articles --dry-run
  npm run import-legacy -- staging --source ../../apkas/eskarun/_articles --only 2023-11-01
`

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false }

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]

    if (key === '-h' || key === '--help') {
      console.log(USAGE)
      process.exit(0)
    }
    if (key === '--dry-run') {
      args.dryRun = true
      continue
    }

    const value = argv[i + 1]

    switch (key) {
      case '--source':
      case '--from':
      case '--to':
      case '--only':
      case '--status': {
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`${key} に値が指定されていません`)
        }
        args[key.slice(2) as 'source' | 'from' | 'to' | 'only' | 'status'] = value
        i++
        break
      }
      default:
        throw new Error(`不明な引数です: ${key}`)
    }
  }

  return args
}

function assertDateOption(name: string, value: string | undefined): void {
  if (value !== undefined && !isValidDate(value)) {
    throw new Error(`${name} の日付が不正です: ${value}（YYYY-MM-DD 形式の実在する日付）`)
  }
}

/**
 * 対象を絞り込む。
 *
 * --only は日付の集合をそのまま指定するもので、範囲指定より意図が具体的なため優先する。
 * 指定された日付に記事がない場合は、黙って0件にせずエラーにする。指定を打ち間違えたのか、
 * 元の記事がないのかを取り違えないため。
 */
function selectArticles(articles: LegacyArticle[], args: Args): LegacyArticle[] {
  if (args.only) {
    const wanted = args.only
      .split(',')
      .map((date) => date.trim())
      .filter(Boolean)
    for (const date of wanted) {
      assertDateOption('--only', date)
    }

    const byDate = new Map(articles.map((article) => [article.date, article]))
    const missing = wanted.filter((date) => !byDate.has(date))
    if (missing.length > 0) {
      throw new Error(`--only に指定した日付の記事が見つかりません: ${missing.join(', ')}`)
    }

    return wanted.map((date) => byDate.get(date) as LegacyArticle)
  }

  return articles.filter(
    (article) =>
      (args.from === undefined || article.date >= args.from) &&
      (args.to === undefined || article.date <= args.to),
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.source) {
    console.error(USAGE)
    throw new Error('--source は必須です')
  }
  assertDateOption('--from', args.from)
  assertDateOption('--to', args.to)
  if (args.status !== undefined && !isEntryStatus(args.status)) {
    throw new Error(`--status は draft か published のいずれかです: ${args.status}`)
  }
  const defaultStatus = args.status ?? 'published'

  const { articles, warnings } = await collectArticles(args.source)
  const targets = selectArticles(articles, args)

  console.log(`読み取り元: ${args.source}`)
  console.log(`テーブル  : ${tableName()}`)
  console.log(`記事      : ${articles.length} 件（うち対象 ${targets.length} 件）`)
  console.log(`既定の状態: ${defaultStatus}`)
  console.log()

  if (warnings.length > 0) {
    console.log(`警告 ${warnings.length} 件:`)
    for (const warning of warnings) {
      console.log(`  - ${warning}`)
    }
    console.log()
  }

  if (args.dryRun) {
    // 上書きになる日付を先に示す。移行は既存のエントリを書き換えうる操作であり、
    // 何が置き換わるのかを実行前に知れないと確認のしようがない。
    const existing: string[] = []
    for (const article of targets) {
      if (await getEntry(article.date)) existing.push(article.date)
    }

    for (const article of targets) {
      const mark = existing.includes(article.date) ? '更新' : '新規'
      const status = article.status ?? defaultStatus
      console.log(
        `  ${mark} ${article.date} [${status}] ${article.title || '(タイトルなし)'} ` +
          `(${article.body.length} 文字) <- ${article.path}`,
      )
    }
    console.log()
    console.log(
      `下見のみ。書き込みは行っていません（新規 ${targets.length - existing.length} 件 / 更新 ${existing.length} 件）。`,
    )
    return
  }

  let created = 0
  let updated = 0

  for (const article of targets) {
    const result = await putEntry({
      date: article.date,
      title: article.title,
      body: article.body,
      status: article.status ?? defaultStatus,
    })

    if (result.created) created++
    else updated++

    if ((created + updated) % 50 === 0) {
      console.log(`  ${created + updated} / ${targets.length} 件`)
    }
  }

  console.log(`取り込みました: 新規 ${created} 件 / 更新 ${updated} 件`)
}

main().catch((error: unknown) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
