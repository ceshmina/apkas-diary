#!/usr/bin/env tsx
/**
 * 写真を投入する CLI。
 *
 * `scripts/photo.sh <環境>` 経由で呼ばれ、環境変数は呼び出し側が読み込む。
 *
 *   npm run photo -- staging --file ~/photos/IMG_1234.jpg --date 2026-08-08
 *   npm run photo -- staging --file ~/photos/walk.jpg --key 2026/08/08/walk.jpg
 *
 * ここがするのはアップロード用バケットへ置くところまでで、派生画像を作るのは
 * S3 のイベントで起動する Lambda である。生成は非同期なので、投入した URL が
 * すぐに読めるとは限らない。読めるようになるまで短いあいだ待ってから URL を出す。
 */

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { assertValidDate, dayOf, monthOf, yearOf } from '../lib/date.js'
import { awsRegion, photoDeliveryBucket, photoUploadBucket, photoUrl } from '../lib/env.js'
import { PHOTO_SIZES, photoKeyOf, photoUrlOf } from '../lib/photo.js'

interface Args {
  file?: string
  date?: string
  key?: string
}

const USAGE = `使い方:
  npm run photo -- <staging|production> --file <path> (--date <YYYY-MM-DD> | --key <key>)

オプション:
  --file <path>          投入する元写真（必須）。
  --date <YYYY-MM-DD>    この日付から YYYY/MM/DD/<ファイル名> をキーにする。
  --key <key>            キーを直接指定する。--date とは排他。

例:
  npm run photo -- staging --file ~/photos/IMG_1234.jpg --date 2026-08-08
  npm run photo -- staging --file ~/photos/walk.jpg --key 2026/08/08/walk.jpg
`

/**
 * 生成を待つ上限と間隔。
 *
 * 上限に達しても失敗とはしない。生成が遅れているのか失敗したのかは記録を見れば
 * 分かることで、待ちきれなかったことをエラーとして扱う理由がない。
 */
const WAIT_TIMEOUT_MS = 30_000
const WAIT_INTERVAL_MS = 2_000

/**
 * 元写真の Content-Type。
 *
 * 元写真は公開されないため表示には影響しない。手元に落として開いたときのために
 * 付けておくだけで、変換は中身を見て行われる。
 */
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

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
      case '--file':
      case '--date':
      case '--key': {
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

/**
 * 元写真のキーを決める。
 *
 * 日付でディレクトリを切るのは、写真が1日の日記に属するという実態に合わせるため。
 * 日付はこのシステム全体の並べ替えの軸でもある。
 */
function keyOf(args: Args): string {
  if (args.key !== undefined) {
    const key = args.key.replace(/^\/+/, '')
    if (key === '' || key.endsWith('/')) {
      throw new Error(`--key が空か、ディレクトリを指しています: ${args.key}`)
    }
    return key
  }

  // parseArgs の後に date か key のどちらかがあることは呼び出し側が確かめている。
  const date = args.date as string
  const file = args.file as string
  return `${yearOf(date)}/${monthOf(date)}/${dayOf(date)}/${basename(file)}`
}

/** SDK のエラーから HTTP のステータスを取り出す。 */
function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}

/**
 * 配信先の `medium` の最終更新時刻。まだ無ければ undefined。
 *
 * 4つは常に揃って書かれるので、1つ見れば残りの状態も決まる。
 */
async function probeUpdatedAt(client: S3Client, key: string): Promise<string | undefined> {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: photoDeliveryBucket(), Key: photoKeyOf('medium', key) }),
    )
    return head.LastModified?.toISOString()
  } catch (error) {
    // 404 だけを「まだ無い」として扱う。それ以外の失敗を待ちに含めると、
    // 権限の不備を「生成が遅い」と読み替えて上限まで黙って待つことになる。
    if (statusOf(error) !== 404) {
      throw error
    }
    return undefined
  }
}

/**
 * 派生画像が出来上がるまで待つ。
 *
 * 「存在するか」ではなく「**投入前から変わったか**」で見る。同じキーへの再投入では
 * 前回の派生画像が残っているため、存在だけを見ると投入した直後に「できました」と
 * 言ってしまい、待ちが素通りになる。差し替えのときこそ、古い内容の URL を本文に
 * 書いてしまわないよう待つ意味がある。
 *
 * 内容ではなく時刻で比べるのは、同じ写真を投入し直したときに内容が変わらないため。
 * 内容で比べると、成功しているのに上限まで待って「まだ現れていない」と言う。
 */
async function waitForDerivative(
  client: S3Client,
  key: string,
  before: string | undefined,
): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS

  while (Date.now() < deadline) {
    const updatedAt = await probeUpdatedAt(client, key)
    if (updatedAt !== undefined && updatedAt !== before) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
  }

  return false
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.file) {
    console.error(USAGE)
    throw new Error('--file は必須です')
  }
  if (args.date === undefined && args.key === undefined) {
    console.error(USAGE)
    throw new Error('--date か --key のどちらかが必要です')
  }
  if (args.date !== undefined && args.key !== undefined) {
    throw new Error('--date と --key は同時に指定できません')
  }
  if (args.date !== undefined) {
    assertValidDate(args.date)
  }

  const key = keyOf(args)
  const body = await readFile(args.file)
  const client = new S3Client({ region: awsRegion() })

  // 投入の前に今の状態を控える。差し替えのときに「変わったこと」で待てるようにする。
  const before = await probeUpdatedAt(client, key)

  await client.send(
    new PutObjectCommand({
      Bucket: photoUploadBucket(),
      Key: key,
      Body: body,
      ContentType: CONTENT_TYPES[extname(args.file).toLowerCase()] ?? 'application/octet-stream',
    }),
  )

  console.log(`投入しました: ${key}`)
  console.log(`  bucket  : ${photoUploadBucket()}`)
  console.log(`  size    : ${(body.length / 1024).toFixed(0)} KB`)
  console.log()

  process.stdout.write('派生画像の生成を待っています...')
  const ready = await waitForDerivative(client, key, before)
  console.log(ready ? ' できました。' : ' まだ現れていません。')
  console.log()

  const base = photoUrl()
  for (const size of PHOTO_SIZES) {
    console.log(`  ${size.padEnd(9)} ${photoUrlOf(base, size, key)}`)
  }

  if (!ready) {
    console.log()
    console.log('生成が終わっていません。数秒おいてから URL を開いてください。')
    console.log('いつまでも現れない場合は Lambda のログに理由が残っています。')
  }
}

main().catch((error: unknown) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
