/**
 * 投入。集めた元写真をアップロード用バケットへ置く。
 *
 * **ここがすることは置くところまでで、目録には触らない**（design.md 決定1）。派生画像を
 * 作るのも記録を書くのも、S3 のイベントで起動する既存の変換 Lambda である。移行のために
 * 目録を直接書く経路を作ると、「目録へ書けるのは投入と変換だけ」（`photo-catalog`）が
 * 崩れるうえに、記録の形を Lambda と二重に持つことになる。**移行で入れた写真だけ記録の
 * 形が違う**、という状態をいちばん避けたい。
 *
 * 置き場所は新規の投入とまったく同じ規約に従う（`photoSourceKeyOf`）。日付の規約から
 * 外れたキーに置くと派生画像だけができて目録に載らないので、キーの組み立ては
 * `migratedSourceKey` に任せ、ここでは組み立て直さない。
 */

import { readFile } from 'node:fs/promises'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { nowUtcIso } from '../lib/date.js'
import { photoContentTypeOf } from '../lib/photo.js'
import { originExtension } from './fetch.js'
import { migratedSourceKey } from './legacy-photo.js'
import type { PhotoRecord } from './manifest.js'
import { mapWithConcurrency } from './parallel.js'

export interface IngestOptions {
  bucket: string
  region: string
  concurrency: number
  dryRun: boolean
}

export interface IngestOutcome {
  record: PhotoRecord
  sourceKey?: string
  ingestedAt?: string
  error?: string
}

/**
 * 台帳のうち、元写真があってまだ投入していない行を投入する。
 *
 * 投入済みの行は飛ばす。何度実行しても、残っているものだけが対象になる。
 */
export async function ingestPhotos(
  records: readonly PhotoRecord[],
  options: IngestOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<IngestOutcome[]> {
  const client = new S3Client({ region: options.region })

  const pending = records.filter(
    (record) => record.origin !== undefined && record.ingestedAt === undefined,
  )
  let done = 0

  return mapWithConcurrency(pending, options.concurrency, async (record) => {
    // origin があることは上で絞り込んである。
    const origin = record.origin as NonNullable<PhotoRecord['origin']>
    const sourceKey = migratedSourceKey(record.entryDate, record.name, originExtension(origin))

    try {
      if (options.dryRun) return { record, sourceKey } satisfies IngestOutcome

      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: sourceKey,
          Body: await readFile(origin.path),
          ContentType: photoContentTypeOf(origin.path),
        }),
      )

      return { record, sourceKey, ingestedAt: nowUtcIso() } satisfies IngestOutcome
    } catch (error) {
      return {
        record,
        error: error instanceof Error ? error.message : String(error),
      } satisfies IngestOutcome
    } finally {
      onProgress?.(++done, pending.length)
    }
  })
}
