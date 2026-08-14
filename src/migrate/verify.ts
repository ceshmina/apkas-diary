/**
 * 照合。移行後の姿が本当にできているかを確かめる。
 *
 * 投入が通ったことは、写真が新しい側で成立したことを意味しない。変換 Lambda は目録への
 * 書き込みに失敗しても投入そのものを失敗にしない設計であり（`photo-catalog` の「目録は
 * 配信の正ではない」）、**投入の成功だけを見て本文を書き換えると、記録の無い写真が混じった
 * まま旧ホストへの参照を捨てることになる**。ここで機械的に突き合わせてから先へ進む。
 *
 * 見るのは配信先のバケットであって、CDN 経由の URL ではない。まだ無いあいだの応答が
 * CDN に載ると、自分の問い合わせが原因でしばらく読めないままになる（`src/lib/env.ts`）。
 *
 * 撮影情報の有無も記録するが、これは合否ではない。代替から投入したものには最初から
 * 残っていないし、目録は情報が欠けていても記録を作る（`photo-catalog`）。件数を出して
 * 移行の質を見るためのものである。
 */

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { nowUtcIso } from '../lib/date.js'
import { PHOTO_SIZES, photoKeyOf } from '../lib/photo.js'
import { listPhotosByDate, type Photo } from '../lib/store/photo.js'
import type { PhotoCheck, PhotoRecord } from './manifest.js'
import { mapWithConcurrency } from './parallel.js'

export interface VerifyOptions {
  deliveryBucket: string
  region: string
  concurrency: number
}

export interface VerifyOutcome {
  record: PhotoRecord
  check?: PhotoCheck
  error?: string
}

/** 派生画像が4サイズとも配信先にあるか。 */
async function hasAllSizes(client: S3Client, bucket: string, sourceKey: string): Promise<boolean> {
  for (const size of PHOTO_SIZES) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: photoKeyOf(size, sourceKey) }))
    } catch (error) {
      // 404 だけを「まだ無い」として扱う。それ以外を欠落に混ぜると、権限の不備を
      // 生成の失敗として読み替えてしまう。
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
      if (status === 404) return false
      throw error
    }
  }
  return true
}

/**
 * 台帳の各行を照合する。
 *
 * 目録は日付ごとに1回だけ引く。写真1枚ごとに引くと同じパーティションを何度も読むことに
 * なり、1日に数十枚ある日ではそのぶんがまるごと無駄になる。
 */
export async function verifyPhotos(
  records: readonly PhotoRecord[],
  options: VerifyOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<VerifyOutcome[]> {
  const client = new S3Client({ region: options.region })
  const targets = records.filter((record) => record.sourceKey !== undefined)

  const dates = [...new Set(targets.map((record) => record.entryDate))].sort()
  const catalogs = new Map<string, Map<string, Photo>>()

  await mapWithConcurrency(dates, options.concurrency, async (date) => {
    const photos = await listPhotosByDate(date)
    catalogs.set(date, new Map(photos.map((photo) => [photo.filename, photo])))
  })

  let done = 0

  return mapWithConcurrency(targets, options.concurrency, async (record) => {
    const sourceKey = record.sourceKey as string

    try {
      const sizes = await hasAllSizes(client, options.deliveryBucket, sourceKey)
      const filename = sourceKey.slice(sourceKey.lastIndexOf('/') + 1)
      const photo = catalogs.get(record.entryDate)?.get(filename)

      return {
        record,
        check: {
          sizes,
          // 記録の書き手は投入と変換の2つあり、**両方が届いて初めて記録が揃う**。
          // `url` は投入の側だけが、`renderedAt` は変換の側だけが書くので、この2つが
          // あることが両方の到達を示す。片方だけで通すと、配信 URL を持たない記録
          // （`photo-catalog` の「記録は配信 URL と元写真のキーを持つ」を満たさない）を
          // 揃ったものとして数えてしまう。
          catalog: photo !== undefined && photo.url !== undefined && photo.renderedAt !== undefined,
          exif: photo?.exif !== undefined,
          at: nowUtcIso(),
        },
      } satisfies VerifyOutcome
    } catch (error) {
      return {
        record,
        error: error instanceof Error ? error.message : String(error),
      } satisfies VerifyOutcome
    } finally {
      onProgress?.(++done, targets.length)
    }
  })
}

/** 移行が成立したといえる行か。撮影情報の有無は条件に含めない。 */
export function isMigrated(record: PhotoRecord): boolean {
  return record.check?.sizes === true && record.check?.catalog === true
}
