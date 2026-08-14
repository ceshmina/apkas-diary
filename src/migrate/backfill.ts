/**
 * 目録に載っていない、新しい側の写真を拾い直す。
 *
 * 目録（`photo-catalog`）を入れる前に投入した写真には記録が無い。**元写真はアップロード用
 * バケットに残っている**ので、置き直せば変換 Lambda が動き、撮影情報まで含めた記録が
 * そのまま埋まる。旧ホストからの移行と違って、取りにいく先も、本文を書き換える必要も無い。
 *
 * 置き直しは同じキーへの自分自身のコピーで行う。中身は1バイトも変わらないまま
 * `ObjectCreated` が起き、S3 のイベントで変換が走る（design.md 決定6）。派生画像は同じ
 * 内容で上書きされるだけなので、表示は変わらない。
 *
 * 派生画像がすでにある写真なので、こちらは1枚ごとに CDN の無効化が走る。対象は目録を
 * 入れる前に投入したぶんだけで数が少なく、無料枠に収まる。旧ホストからの移行（初回の
 * 投入なので無効化は起きない）と性質が違うのはこの点である。
 */

import { CopyObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'
import { photoContentTypeOf, photoSourceOf } from '../lib/photo.js'
import { listPhotosByDate } from '../lib/store/photo.js'
import { mapWithConcurrency } from './parallel.js'

export interface BackfillTarget {
  sourceKey: string
  date: string
  filename: string
  /** 記録そのものが無いのか、変換の書き込みだけが無いのか。 */
  reason: 'no-record' | 'no-rendering'
}

/**
 * アップロード用バケットにある、日付の規約に沿ったキーをすべて挙げる。
 *
 * 規約から外れたキー（CLI の `--key` で入れたもの）は最初から目録の対象ではないので、
 * 拾い直しの対象にもしない。置き直しても目録には載らず、変換だけが無駄に走る。
 */
export async function listUploadedKeys(client: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined

  do {
    const result = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    )
    for (const object of result.Contents ?? []) {
      if (object.Key && photoSourceOf(object.Key)) keys.push(object.Key)
    }
    token = result.NextContinuationToken
  } while (token)

  return keys.sort()
}

/** 目録に届いていないものを選ぶ。 */
export async function findBackfillTargets(
  keys: readonly string[],
  concurrency: number,
): Promise<BackfillTarget[]> {
  const sources = keys.flatMap((key) => {
    const source = photoSourceOf(key)
    return source ? [{ sourceKey: key, ...source }] : []
  })

  const dates = [...new Set(sources.map((source) => source.date))].sort()
  const catalogs = new Map<string, Map<string, { renderedAt?: string }>>()

  await mapWithConcurrency(dates, concurrency, async (date) => {
    const photos = await listPhotosByDate(date)
    catalogs.set(date, new Map(photos.map((photo) => [photo.filename, photo])))
  })

  const targets: BackfillTarget[] = []
  for (const source of sources) {
    const photo = catalogs.get(source.date)?.get(source.filename)
    if (photo === undefined) {
      targets.push({ ...source, reason: 'no-record' })
    } else if (photo.renderedAt === undefined) {
      // 投入の側だけが書いた記録。変換が目録に届いていないので、撮影情報も寸法も無い。
      targets.push({ ...source, reason: 'no-rendering' })
    }
  }

  return targets
}

export interface BackfillOutcome {
  target: BackfillTarget
  copied: boolean
  error?: string
}

/**
 * 同じキーへ置き直して変換を起こす。
 *
 * `MetadataDirective: REPLACE` を指定しないと、コピー元の付随情報がそのまま引き継がれる。
 * 引き継ぎでは `ObjectCreated` は起きるものの、指定しない側に倒す理由が無いので明示する。
 * `ContentType` はキーの拡張子から入れ直す。元写真は公開されないため表示には影響しないが、
 * 置き直したことで欠けるのは筋が悪い。
 */
export async function backfillPhotos(
  client: S3Client,
  bucket: string,
  targets: readonly BackfillTarget[],
  concurrency: number,
  dryRun: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<BackfillOutcome[]> {
  let done = 0

  return mapWithConcurrency(targets, concurrency, async (target) => {
    try {
      if (dryRun) return { target, copied: false } satisfies BackfillOutcome

      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: target.sourceKey,
          CopySource: `${bucket}/${target.sourceKey}`,
          MetadataDirective: 'REPLACE',
          ContentType: photoContentTypeOf(target.filename),
        }),
      )

      return { target, copied: true } satisfies BackfillOutcome
    } catch (error) {
      return {
        target,
        copied: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies BackfillOutcome
    } finally {
      onProgress?.(++done, targets.length)
    }
  })
}
