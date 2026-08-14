/**
 * 元写真を集める。
 *
 * 探す順は3つある（design.md 決定3）。
 *
 *   1. 手元に同期した旧バケット（`--sync-dir`）
 *   2. 旧ホストが配信している元写真（`/original/`）
 *   3. 旧ホストの配信画像（`/large/`）
 *
 * 1と2が元写真、3は代替である。**元写真かどうかで、目録に残るものが変わる。** 配信画像は
 * 派生の過程で撮影情報が落とされており（`photo-ingest`）、そこから作り直しても機材も
 * 撮影日時も戻らない。旧ホストが元写真を配信しているうちに移すというのが、この change を
 * 今やる理由そのものである（proposal.md - Why）。
 *
 * HEIC は探さない。変換 Lambda が積んでいる sharp は HEVC を復号できず、投入しても
 * 派生画像が1枚も作られない。**代替に倒したほうが、写真が表示されるだけましである。**
 *
 * 取ってきたものは手元に残す。同じものを2度取りにいかないためと、旧ホストが止まった
 * あとに元写真が手元にしか無くなるためである。
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { LEGACY_PHOTO_HOST } from './legacy-photo.js'
import type { PhotoOrigin, PhotoRecord } from './manifest.js'
import { sourceDir } from './manifest.js'
import { mapWithConcurrency } from './parallel.js'

/**
 * 元写真として探す拡張子。見つかった時点で打ち切るので、多い順に並べる。
 *
 * 大文字と小文字を別に挙げているのは、S3 のキーが大文字小文字を区別するため。
 * 旧ホストには `.jpg` と `.JPG` が混在している。
 */
const ORIGINAL_EXTENSIONS = ['.jpg', '.JPG', '.jpeg', '.JPEG', '.png', '.PNG', '.webp'] as const

const REQUEST_TIMEOUT_MS = 30_000

export interface FetchOptions {
  /** 移行の作業ディレクトリ。取ってきたものはこの下に置く。 */
  dir: string
  /** 旧バケットを同期した場所。無ければ旧ホストから取る。 */
  syncDir?: string
  concurrency: number
  dryRun: boolean
}

export interface FetchOutcome {
  record: PhotoRecord
  origin?: PhotoOrigin
  error?: string
}

/**
 * 同期した旧バケットの索引。
 *
 * パス全体（拡張子を除く）と、ファイル名だけ（拡張子を除く）の2つで引けるようにする。
 * 旧バケットのキーが旧ホストの URL と同じ形とは限らないため、**パスで引けなかったものを
 * ファイル名で拾う**。ファイル名が2つ以上のファイルに当たる場合は索引から外す。どちらを
 * 指しているか決められないものを、当てずっぽうで選ばない。
 */
interface SyncIndex {
  byPath: Map<string, string>
  byName: Map<string, string>
}

async function buildSyncIndex(root: string): Promise<SyncIndex> {
  const byPath = new Map<string, string>()
  const byName = new Map<string, string>()
  const ambiguous = new Set<string>()

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue

      const withoutExt = relative(root, full).replace(/\.[^./]*$/, '')
      byPath.set(withoutExt, full)

      const name = withoutExt.slice(withoutExt.lastIndexOf('/') + 1)
      if (byName.has(name)) ambiguous.add(name)
      else byName.set(name, full)
    }
  }

  await walk(root)
  for (const name of ambiguous) byName.delete(name)

  return { byPath, byName }
}

function legacyUrlOf(size: string, path: string, ext: string): string {
  return `https://${LEGACY_PHOTO_HOST}/${size}/${path}${ext}`
}

/** 旧ホストにその拡張子の元写真があるか。 */
async function exists(url: string): Promise<boolean> {
  const response = await fetch(url, {
    method: 'HEAD',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return response.ok
}

async function download(url: string, to: string): Promise<number> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`取得できませんでした（HTTP ${response.status}）: ${url}`)
  }

  const body = Buffer.from(await response.arrayBuffer())
  await mkdir(dirname(to), { recursive: true })
  await writeFile(to, body)
  return body.length
}

/** すでに手元にあるファイルの大きさ。無ければ undefined。 */
async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0 ? info.size : undefined
  } catch {
    return undefined
  }
}

async function resolveOne(
  record: PhotoRecord,
  index: SyncIndex | undefined,
  dir: string,
  dryRun: boolean,
): Promise<PhotoOrigin> {
  const synced = index?.byPath.get(record.path) ?? index?.byName.get(record.name)
  if (synced !== undefined) {
    const bytes = (await sizeOf(synced)) ?? 0
    return { kind: 'sync', from: synced, path: synced, bytes }
  }

  for (const ext of ORIGINAL_EXTENSIONS) {
    const url = legacyUrlOf('original', record.path, ext)
    if (!(await exists(url))) continue

    const to = join(sourceDir(dir), `${record.path}${ext}`)
    const already = await sizeOf(to)
    if (already !== undefined) return { kind: 'original', from: url, path: to, bytes: already }
    if (dryRun) return { kind: 'original', from: url, path: to, bytes: 0 }

    return { kind: 'original', from: url, path: to, bytes: await download(url, to) }
  }

  // 元写真が無い。配信画像から作り直す。撮影情報は戻らないが、写真そのものは新しい側へ
  // 移せる。ここに落ちた件数は最後にまとめて出し、多ければ止めて理由を見る。
  const url = legacyUrlOf('large', record.path, '.webp')
  const to = join(sourceDir(dir), `${record.path}.webp`)
  const already = await sizeOf(to)
  if (already !== undefined) return { kind: 'large', from: url, path: to, bytes: already }
  if (dryRun) return { kind: 'large', from: url, path: to, bytes: 0 }

  return { kind: 'large', from: url, path: to, bytes: await download(url, to) }
}

/**
 * 台帳の各行に元写真の取得元を書き込む。
 *
 * すでに取得元のある行は触らない。何度実行しても、まだ取れていないものだけを取りにいく。
 */
export async function fetchOrigins(
  records: readonly PhotoRecord[],
  options: FetchOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<FetchOutcome[]> {
  const index = options.syncDir ? await buildSyncIndex(options.syncDir) : undefined

  const pending = records.filter((record) => record.origin === undefined)
  let done = 0

  const outcomes = await mapWithConcurrency(pending, options.concurrency, async (record) => {
    try {
      const origin = await resolveOne(record, index, options.dir, options.dryRun)
      return { record, origin } satisfies FetchOutcome
    } catch (error) {
      return {
        record,
        error: error instanceof Error ? error.message : String(error),
      } satisfies FetchOutcome
    } finally {
      onProgress?.(++done, pending.length)
    }
  })

  return outcomes
}

/** 取得元の拡張子。投入するキーはこれで決まる。 */
export function originExtension(origin: PhotoOrigin): string {
  return extname(origin.path)
}
