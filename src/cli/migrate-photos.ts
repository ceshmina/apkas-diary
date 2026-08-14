#!/usr/bin/env tsx

/**
 * 旧ホストに残った写真を新しい側へ移す CLI。
 *
 * `scripts/migrate-photos.sh <環境> <工程>` 経由で呼ばれ、環境変数は呼び出し側が読み込む。
 * 移行のためのコマンドで、済んだあとも何をどう移したかを読み直せるように残す。
 *
 *   npm run migrate-photos -- staging plan
 *   npm run migrate-photos -- staging fetch --sync-dir ~/old-photos/original
 *   npm run migrate-photos -- staging ingest
 *   npm run migrate-photos -- staging verify
 *   npm run migrate-photos -- staging rewrite --dry-run
 *
 * 工程は台帳（`migration/<環境>/photos.jsonl`）を挟んで前から順につながっている。
 * どの工程も途中で止めて再開でき、済んだ行は飛ばす。**本文を書き換える `rewrite` だけが
 * 後戻りできない**ので、そこに至る前に `verify` まで通しておくこと。
 */

import { S3Client } from '@aws-sdk/client-s3'
import { isValidDate } from '../lib/date.js'
import {
  awsRegion,
  photoDeliveryBucket,
  photoUploadBucket,
  photoUrl,
  tableName,
} from '../lib/env.js'
import { backfillPhotos, findBackfillTargets, listUploadedKeys } from '../migrate/backfill.js'
import { fetchOrigins } from '../migrate/fetch.js'
import { ingestPhotos } from '../migrate/ingest.js'
import {
  manifestExists,
  manifestPath,
  type PhotoRecord,
  readManifest,
  readSnapshots,
  snapshotDir,
  writeManifest,
} from '../migrate/manifest.js'
import { planMigration } from '../migrate/plan.js'
import { rewriteEntries, rollbackEntries } from '../migrate/rewrite.js'
import { isMigrated, verifyPhotos } from '../migrate/verify.js'

const COMMANDS = [
  'plan',
  'fetch',
  'ingest',
  'verify',
  'rewrite',
  'rollback',
  'backfill',
  'report',
] as const

type Command = (typeof COMMANDS)[number]

interface Args {
  command: Command
  dir?: string
  syncDir?: string
  only?: string
  concurrency?: string
  dryRun: boolean
  force: boolean
}

const USAGE = `使い方:
  npm run migrate-photos -- <staging|production> <工程> [options]

工程:
  plan       日記の本文から旧ホストの参照を集め、台帳を作る。書き込みは行わない。
  fetch      元写真を集める。旧バケットの同期先を優先し、無ければ旧ホストから取る。
  ingest     元写真をアップロード用バケットへ置く。派生画像と目録は変換 Lambda に任せる。
  verify     派生画像と目録が揃ったかを照合し、結果を台帳に書く。
  rewrite    照合の通った日の本文を新しい URL に書き換える。**後戻りできない工程。**
  rollback   控えから本文を戻す。
  backfill   目録に載っていない、新しい側の写真を置き直して拾う。
  report     台帳の集計を出す。

オプション:
  --dir <dir>            作業ディレクトリ。既定は migration/<環境>。
  --sync-dir <dir>       旧バケットを同期した場所（fetch）。
  --only <日付,日付,...>  指定した日付だけを対象にする。
  --concurrency <n>      並行して走らせる数。既定は 6。
  --dry-run              書き込まず、対象と件数だけを表示する。
  --force                plan で既存の台帳を作り直す（進み具合を捨てる）。

例:
  npm run migrate-photos -- staging plan
  npm run migrate-photos -- production fetch --sync-dir ~/old-photos/original
  npm run migrate-photos -- production rewrite --dry-run
`

const DEFAULT_CONCURRENCY = 6

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv

  if (command === '-h' || command === '--help' || command === undefined) {
    console.log(USAGE)
    process.exit(command === undefined ? 1 : 0)
  }
  if (!COMMANDS.includes(command as Command)) {
    throw new Error(`不明な工程です: ${command}（${COMMANDS.join(' / ')}）`)
  }

  const args: Args = { command: command as Command, dryRun: false, force: false }

  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]

    if (key === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (key === '--force') {
      args.force = true
      continue
    }

    const value = rest[i + 1]

    switch (key) {
      case '--dir':
      case '--sync-dir':
      case '--only':
      case '--concurrency': {
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`${key} に値が指定されていません`)
        }
        if (key === '--dir') args.dir = value
        else if (key === '--sync-dir') args.syncDir = value
        else if (key === '--only') args.only = value
        else args.concurrency = value
        i++
        break
      }
      default:
        throw new Error(`不明な引数です: ${key}`)
    }
  }

  return args
}

/**
 * 作業ディレクトリ。
 *
 * 既定を環境ごとに分けるのは、staging の台帳で production を触るという取り違えを
 * 起こさないため。`DIARY_ENV` は呼び出し側のシェルが必ず入れる。
 */
function workDir(args: Args): string {
  if (args.dir) return args.dir

  const env = process.env.DIARY_ENV
  if (!env) {
    throw new Error(
      'DIARY_ENV が設定されていません。scripts/migrate-photos.sh から実行してください。',
    )
  }
  return `migration/${env}`
}

function parseOnly(args: Args): Set<string> | undefined {
  if (!args.only) return undefined

  const dates = args.only
    .split(',')
    .map((date) => date.trim())
    .filter(Boolean)
  for (const date of dates) {
    if (!isValidDate(date)) {
      throw new Error(`--only の日付が不正です: ${date}（YYYY-MM-DD 形式の実在する日付）`)
    }
  }
  return new Set(dates)
}

function concurrencyOf(args: Args): number {
  if (!args.concurrency) return DEFAULT_CONCURRENCY

  const value = Number(args.concurrency)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--concurrency は 1 以上の整数です: ${args.concurrency}`)
  }
  return value
}

function progressOf(label: string, step = 100): (done: number, total: number) => void {
  return (done, total) => {
    if (done % step === 0 || done === total) console.log(`  ${label} ${done} / ${total}`)
  }
}

/** 台帳を読み、`--only` の対象だけを返す。書き戻しは常に全件で行う。 */
async function loadManifest(
  dir: string,
  only: Set<string> | undefined,
): Promise<{ all: PhotoRecord[]; targets: PhotoRecord[] }> {
  const all = await readManifest(dir)
  const targets = only ? all.filter((record) => only.has(record.entryDate)) : all
  return { all, targets }
}

/**
 * 棚卸し。
 *
 * 既にある台帳の進み具合は引き継ぐ。写真の同一性は旧 URL で見て、参照している日付と
 * ファイル名まで一致するものだけを引き継ぐ。**日付が変わっていれば置き場所も変わる**ので、
 * 投入済みという印だけを持ち越すと、古い場所に置いたものを移行済みとみなしてしまう。
 *
 * `--only` を付けたときは、指定した日のぶんだけを作り直して台帳に差し戻す。走査していない
 * 日の行をそのまま残すのは、**部分的な棚卸しが台帳の残りを消してしまわない**ようにするため。
 */
async function commandPlan(args: Args, dir: string, only: Set<string> | undefined): Promise<void> {
  const result = await planMigration(photoUrl(), only)

  console.log(`テーブル  : ${tableName()}`)
  console.log(`配信の基点: ${photoUrl()}`)
  console.log(`台帳      : ${manifestPath(dir)}`)
  console.log()
  console.log(`走査したエントリ: ${result.scanned} 件`)
  console.log(`参照を持つ日記  : ${result.entries} 件`)
  console.log(`旧ホストの写真  : ${result.records.length} 枚`)

  if (result.problems.length > 0) {
    console.log()
    console.log(`食い違い ${result.problems.length} 件:`)
    for (const problem of result.problems) {
      console.log(`  - ${problem}`)
    }
    throw new Error('食い違いが残っているうちは移行を始めません。')
  }

  let records = result.records

  if (!args.force && (await manifestExists(dir))) {
    const existing = await readManifest(dir)
    const previous = new Map(existing.map((record) => [record.oldUrl, record]))
    let carried = 0

    for (const record of records) {
      const before = previous.get(record.oldUrl)
      if (!before || before.entryDate !== record.entryDate || before.name !== record.name) continue

      record.origin = before.origin
      record.sourceKey = before.sourceKey
      record.ingestedAt = before.ingestedAt
      record.check = before.check
      carried++
    }

    console.log(`前の台帳から引き継いだ進み具合: ${carried} 枚`)

    if (only) {
      const kept = existing.filter((record) => !only.has(record.entryDate))
      records = [...kept, ...records].sort((a, b) =>
        a.entryDate === b.entryDate
          ? a.name.localeCompare(b.name)
          : a.entryDate.localeCompare(b.entryDate),
      )
      console.log(`走査しなかった日の行: ${kept.length} 枚（そのまま残します）`)
    }
  }

  if (args.dryRun) {
    console.log()
    console.log('下見のみ。台帳は書いていません。')
    return
  }

  await writeManifest(dir, records)
  console.log()
  console.log(`台帳を書きました: ${manifestPath(dir)}（${records.length} 枚）`)
}

async function commandFetch(args: Args, dir: string, only: Set<string> | undefined): Promise<void> {
  const { all, targets } = await loadManifest(dir, only)

  const outcomes = await fetchOrigins(
    targets,
    {
      dir,
      syncDir: args.syncDir,
      concurrency: concurrencyOf(args),
      dryRun: args.dryRun,
    },
    progressOf('取得'),
  )

  const counts = { sync: 0, original: 0, large: 0 }
  const errors: string[] = []

  for (const outcome of outcomes) {
    if (outcome.origin) {
      outcome.record.origin = outcome.origin
      counts[outcome.origin.kind]++
    } else {
      errors.push(`${outcome.record.oldUrl}: ${outcome.error}`)
    }
  }

  if (!args.dryRun) await writeManifest(dir, all)

  const resolved = counts.sync + counts.original + counts.large
  console.log()
  console.log(`取得元が決まった写真: ${resolved} 枚`)
  console.log(`  同期した旧バケット: ${counts.sync}`)
  console.log(`  旧ホストの元写真  : ${counts.original}`)
  console.log(`  旧ホストの配信画像: ${counts.large}（撮影情報は残りません）`)

  if (resolved > 0 && counts.large / resolved > 0.1) {
    console.log()
    console.log('配信画像に落ちた割合が1割を超えています。先へ進む前に理由を確かめてください。')
  }
  reportErrors(errors)
}

async function commandIngest(
  args: Args,
  dir: string,
  only: Set<string> | undefined,
): Promise<void> {
  const { all, targets } = await loadManifest(dir, only)

  const outcomes = await ingestPhotos(
    targets,
    {
      bucket: photoUploadBucket(),
      region: awsRegion(),
      concurrency: concurrencyOf(args),
      dryRun: args.dryRun,
    },
    progressOf('投入'),
  )

  let ingested = 0
  const errors: string[] = []

  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      errors.push(`${outcome.record.oldUrl}: ${outcome.error}`)
      continue
    }
    outcome.record.sourceKey = outcome.sourceKey
    if (outcome.ingestedAt !== undefined) {
      outcome.record.ingestedAt = outcome.ingestedAt
      ingested++
    }
  }

  if (!args.dryRun) await writeManifest(dir, all)

  console.log()
  console.log(`投入先: ${photoUploadBucket()}`)
  console.log(args.dryRun ? `投入する写真: ${outcomes.length} 枚（下見）` : `投入: ${ingested} 枚`)
  console.log('派生画像の生成と目録への記録は変換 Lambda が行います。verify で確かめてください。')
  reportErrors(errors)
}

async function commandVerify(
  args: Args,
  dir: string,
  only: Set<string> | undefined,
): Promise<void> {
  const { all, targets } = await loadManifest(dir, only)

  const outcomes = await verifyPhotos(
    targets,
    {
      deliveryBucket: photoDeliveryBucket(),
      region: awsRegion(),
      concurrency: concurrencyOf(args),
    },
    progressOf('照合'),
  )

  const errors: string[] = []
  for (const outcome of outcomes) {
    if (outcome.check) outcome.record.check = outcome.check
    else errors.push(`${outcome.record.oldUrl}: ${outcome.error}`)
  }

  await writeManifest(dir, all)

  const checked = outcomes.filter((outcome) => outcome.check !== undefined).length
  const noSizes = targets.filter((record) => record.check?.sizes === false)
  const noCatalog = targets.filter((record) => record.check?.catalog === false)
  const noExif = targets.filter((record) => record.check?.exif === false)

  console.log()
  console.log(`照合した写真: ${checked} 枚`)
  console.log(`  派生画像が揃っていない: ${noSizes.length}`)
  console.log(`  目録に届いていない    : ${noCatalog.length}`)
  console.log(`  撮影情報が無い        : ${noExif.length}`)

  for (const record of [...noSizes, ...noCatalog].slice(0, 20)) {
    console.log(`    - ${record.entryDate} ${record.name}`)
  }
  reportErrors(errors)
}

async function commandRewrite(
  args: Args,
  dir: string,
  only: Set<string> | undefined,
): Promise<void> {
  const { targets } = await loadManifest(dir, only)

  const outcomes = await rewriteEntries(targets, { dir, dryRun: args.dryRun })

  const rewritten = outcomes.filter((outcome) => outcome.replaced > 0)
  const already = outcomes.filter((outcome) => outcome.done)
  const skipped = outcomes.filter((outcome) => outcome.skipped !== undefined)
  const replaced = rewritten.reduce((sum, outcome) => sum + outcome.replaced, 0)

  console.log(`対象の日記: ${outcomes.length} 件`)
  console.log(`  書き換え: ${rewritten.length} 件（${replaced} 箇所）`)
  console.log(`  済み    : ${already.length} 件`)
  console.log(`  見送り  : ${skipped.length} 件`)

  for (const outcome of skipped) {
    console.log(`    - ${outcome.date}: ${outcome.skipped}`)
  }

  console.log()
  if (args.dryRun) {
    console.log('下見のみ。本文は書き換えていません。')
  } else {
    console.log(`書き換える前の本文は ${snapshotDir(dir)} に控えてあります。`)
    console.log('戻すときは rollback を実行してください。')
  }
}

async function commandRollback(dir: string, only: Set<string> | undefined): Promise<void> {
  const snapshots = await readSnapshots(dir)
  const targets = only ? snapshots.filter((snapshot) => only.has(snapshot.date)) : snapshots

  if (targets.length === 0) {
    console.log(`控えがありません: ${snapshotDir(dir)}`)
    return
  }

  const outcomes = await rollbackEntries(targets)
  const restored = outcomes.filter((outcome) => outcome.restored)

  console.log(`控え: ${targets.length} 件`)
  console.log(`  戻した  : ${restored.length} 件`)
  console.log(`  そのまま: ${outcomes.length - restored.length} 件`)

  for (const outcome of outcomes.filter((o) => o.skipped !== undefined)) {
    console.log(`    - ${outcome.date}: ${outcome.skipped}`)
  }
}

async function commandBackfill(args: Args): Promise<void> {
  const client = new S3Client({ region: awsRegion() })
  const bucket = photoUploadBucket()
  const concurrency = concurrencyOf(args)

  const keys = await listUploadedKeys(client, bucket)
  const targets = await findBackfillTargets(keys, concurrency)

  console.log(`アップロード用バケット: ${bucket}`)
  console.log(`日付の規約に沿った元写真: ${keys.length} 枚`)
  console.log(`目録に届いていない写真  : ${targets.length} 枚`)
  console.log(`  記録が無い      : ${targets.filter((t) => t.reason === 'no-record').length}`)
  console.log(`  変換が届いていない: ${targets.filter((t) => t.reason === 'no-rendering').length}`)

  for (const target of targets.slice(0, 20)) {
    console.log(`    - ${target.sourceKey}`)
  }
  if (targets.length > 20) console.log(`    ... 他 ${targets.length - 20} 枚`)

  if (targets.length === 0) return
  if (args.dryRun) {
    console.log()
    console.log('下見のみ。置き直していません。')
    return
  }

  console.log()
  const outcomes = await backfillPhotos(
    client,
    bucket,
    targets,
    concurrency,
    false,
    progressOf('置き直し', 20),
  )

  const copied = outcomes.filter((outcome) => outcome.copied)
  console.log()
  console.log(`置き直しました: ${copied.length} 枚`)
  console.log('目録に届いたかは、しばらく待ってから backfill --dry-run で確かめてください。')
  reportErrors(outcomes.flatMap((o) => (o.error ? [`${o.target.sourceKey}: ${o.error}`] : [])))
}

/** 台帳の集計。移行が何を残したかを、あとから読み直せるようにする。 */
async function commandReport(dir: string, only: Set<string> | undefined): Promise<void> {
  const { targets } = await loadManifest(dir, only)

  const dates = new Set(targets.map((record) => record.entryDate))
  const migrated = targets.filter(isMigrated)
  const fromLarge = targets.filter((record) => record.origin?.kind === 'large')
  const noExif = targets.filter((record) => record.check?.exif === false)
  const bytes = targets.reduce((sum, record) => sum + (record.origin?.bytes ?? 0), 0)

  console.log(`台帳: ${manifestPath(dir)}`)
  console.log()
  console.log(`写真          : ${targets.length} 枚（${dates.size} 日分）`)
  console.log(`  取得済み    : ${targets.filter((r) => r.origin !== undefined).length}`)
  console.log(`  投入済み    : ${targets.filter((r) => r.ingestedAt !== undefined).length}`)
  console.log(`  照合が通った: ${migrated.length}`)
  console.log()
  console.log(`元写真が無く配信画像から作ったもの: ${fromLarge.length} 枚`)
  console.log(`撮影情報が残らなかったもの        : ${noExif.length} 枚`)
  console.log(`集めた元写真の総量                : ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
}

function reportErrors(errors: readonly string[]): void {
  if (errors.length === 0) return

  console.log()
  console.log(`失敗 ${errors.length} 件:`)
  for (const error of errors.slice(0, 20)) {
    console.log(`  - ${error}`)
  }
  if (errors.length > 20) console.log(`  ... 他 ${errors.length - 20} 件`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dir = workDir(args)
  const only = parseOnly(args)

  switch (args.command) {
    case 'plan':
      return commandPlan(args, dir, only)
    case 'fetch':
      return commandFetch(args, dir, only)
    case 'ingest':
      return commandIngest(args, dir, only)
    case 'verify':
      return commandVerify(args, dir, only)
    case 'rewrite':
      return commandRewrite(args, dir, only)
    case 'rollback':
      return commandRollback(dir, only)
    case 'backfill':
      return commandBackfill(args)
    case 'report':
      return commandReport(dir, only)
  }
}

main().catch((error: unknown) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
