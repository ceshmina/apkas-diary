/**
 * 投入。集めた元写真をアップロード用バケットへ置き、目録に記録する。
 *
 * **手元の CLI（`src/cli/put-photo.ts`）とまったく同じ2つを行う**（design.md 決定1）。
 * 元写真を置き、`putPhoto` で記録を書く。派生画像の生成と、撮影に関する情報の書き足しは
 * S3 のイベントで起動する既存の変換 Lambda が行う。移行のための経路は1つも作らない。
 *
 * 目録の書き手を増やしてはいない。`photo-catalog` が許す書き手は投入と変換の2つで、
 * `putPhoto` はその投入の側そのものである。**移行は投入である。** ここを飛ばすと配信 URL
 * （`url`）を書く者がいなくなり、「記録は配信 URL と元写真のキーを持つ」を満たさない
 * 記録が、移行したぶんだけできる。**移行で入れた写真だけ記録の形が違う**、という状態を
 * いちばん避けたい。
 *
 * 置き場所は新規の投入とまったく同じ規約に従う（`photoSourceKeyOf`）。日付の規約から
 * 外れたキーに置くと派生画像だけができて目録に載らないので、キーの組み立ては
 * `migratedSourceKey` に任せ、ここでは組み立て直さない。
 */

import { readFile } from 'node:fs/promises'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { nowUtcIso } from '../lib/date.js'
import { photoContentTypeOf } from '../lib/photo.js'
import { putPhoto } from '../lib/store/photo.js'
import { originExtension } from './fetch.js'
import { migratedSourceKey } from './legacy-photo.js'
import type { PhotoRecord } from './manifest.js'
import { mapWithConcurrency } from './parallel.js'

export interface IngestOptions {
  bucket: string
  region: string
  concurrency: number
  dryRun: boolean
  /** 投入済みの行もやり直す。置き直しは上書きなので、増えも壊れもしない。 */
  force: boolean
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
 *
 * 投入の印（`ingestedAt`）は、置くことと記録することの**両方が済んでから**書く。手元の
 * CLI は記録に失敗しても投入そのものを失敗にしないが、あちらは人が結果を見ていて投入し
 * 直せる。2,000枚を相手に黙って進むと、記録の欠けた写真がどれだったかを追う手立てが
 * 無くなる。置き直しは同じキーへの上書きなので、やり直しても増えも壊れもしない。
 */
export async function ingestPhotos(
  records: readonly PhotoRecord[],
  options: IngestOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<IngestOutcome[]> {
  const client = new S3Client({ region: options.region })

  const pending = records.filter(
    (record) => record.origin !== undefined && (options.force || record.ingestedAt === undefined),
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

      // 変換より先に走ることも後になることもある。どちらでも同じ記録になる
      // （`putPhoto`）。日付の規約に沿ったキーしか作っていないので、載らなかったのなら
      // キーの組み立てのほうが壊れている。
      const photo = await putPhoto(sourceKey)
      if (!photo) throw new Error(`日付の規約に沿わないキーになりました: ${sourceKey}`)

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
