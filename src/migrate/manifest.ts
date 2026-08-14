/**
 * 移行の台帳。工程どうしの受け渡しはこのファイル1つだけを通る（design.md 決定4）。
 *
 * 台帳は写真1枚につき1行の JSON Lines で、各工程は自分の持ち分の項目を書き足していく。
 *
 *   plan    -> oldUrl / entryDate / path / name / newUrl
 *   fetch   -> origin
 *   ingest  -> sourceKey / ingestedAt
 *   verify  -> check
 *   rewrite -> 台帳は読むだけ。書き換えた本文は snapshots/ に控えを残す
 *
 * こうしておくと、**どの工程も途中で止めて再開できる**。取り込み済みの行は飛ばせるし、
 * 照合に落ちた行だけを投入し直せる。2,000枚を超える相手に「最初からやり直す」しか手が
 * ないのは実用にならない。
 *
 * 書き出しは一時ファイルを経由して置き換える。台帳は進み具合の唯一の記録であり、
 * 書いている途中で止まったときに**半分だけ書かれた台帳が残る**のがいちばん困る。
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 元写真をどこから取ってきたか。 */
export interface PhotoOrigin {
  /**
   * `sync`     手元に同期した旧バケットの元写真
   * `original` 旧ホストが配信している元写真
   * `large`    旧ホストの配信画像（元写真が無いときの代替。撮影情報は残っていない）
   */
  kind: 'sync' | 'original' | 'large'
  /** 取ってきた先。旧バケットの同期先のパス、または旧ホストの URL。 */
  from: string
  /** 手元のファイルのパス。投入はここから読む。 */
  path: string
  bytes: number
}

/** 移行後の状態の照合結果。 */
export interface PhotoCheck {
  /** 派生画像4サイズが配信先に揃っているか。 */
  sizes: boolean
  /** 目録に記録があるか。 */
  catalog: boolean
  /** 記録に撮影情報があるか。代替から投入したものは残らない。 */
  exif: boolean
  /** 照合した時刻。UTC の ISO 8601。 */
  at: string
}

export interface PhotoRecord {
  /** 本文に書かれている旧 URL。書き換えの対象そのもの。 */
  oldUrl: string
  /** 参照している日記の日付。目録の日付になる（design.md 決定2）。 */
  entryDate: string
  /** 旧ホストのサイズ名より後ろ。拡張子を含まない。元写真を取りにいくときに使う。 */
  path: string
  /** 拡張子を含まないファイル名。 */
  name: string
  /** 書き換え後の URL。拡張子によらず決まるため、棚卸しの時点で確定する。 */
  newUrl: string
  /** その本文に何度現れるか。書き換えの件数を数えるために持つ。 */
  occurrences: number
  origin?: PhotoOrigin
  /** 投入した元写真のキー。 */
  sourceKey?: string
  /** 投入した時刻。UTC の ISO 8601。再実行のときはこれがある行を飛ばす。 */
  ingestedAt?: string
  check?: PhotoCheck
}

/** 書き換える前の本文の控え。戻すために必要なものだけを持つ。 */
export interface EntrySnapshot {
  date: string
  title: string
  body: string
  status: string
  /** 控えを取った時刻。UTC の ISO 8601。 */
  at: string
}

export function manifestPath(dir: string): string {
  return join(dir, 'photos.jsonl')
}

/** 取ってきた元写真を置く場所。旧ホストのパスをそのまま写す。 */
export function sourceDir(dir: string): string {
  return join(dir, 'source')
}

export function snapshotDir(dir: string): string {
  return join(dir, 'snapshots')
}

export async function readManifest(dir: string): Promise<PhotoRecord[]> {
  let text: string
  try {
    text = await readFile(manifestPath(dir), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`台帳がありません: ${manifestPath(dir)}（先に plan を実行してください）`)
    }
    throw error
  }

  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PhotoRecord)
}

export async function writeManifest(dir: string, records: readonly PhotoRecord[]): Promise<void> {
  await mkdir(dir, { recursive: true })

  const path = manifestPath(dir)
  const tmp = `${path}.tmp`
  const lines = records.map((record) => JSON.stringify(record))
  await writeFile(tmp, `${lines.join('\n')}\n`, 'utf-8')
  await rename(tmp, path)
}

export async function manifestExists(dir: string): Promise<boolean> {
  try {
    await readFile(manifestPath(dir), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * 書き換える前の本文を控える。**すでに控えがあれば書かない。**
 *
 * 書き換えを2度走らせたときに、1度目で新 URL になった本文を控えとして上書きしてしまうと、
 * 戻す先が移行後の状態になり、控えの意味が無くなる。最初に取ったものだけが移行前の本文
 * である。
 */
export async function writeSnapshot(dir: string, snapshot: EntrySnapshot): Promise<boolean> {
  const target = snapshotDir(dir)
  await mkdir(target, { recursive: true })

  const path = join(target, `${snapshot.date}.json`)
  try {
    await writeFile(path, JSON.stringify(snapshot, null, 2), { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

export async function readSnapshots(dir: string): Promise<EntrySnapshot[]> {
  const target = snapshotDir(dir)

  let names: string[]
  try {
    names = await readdir(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const snapshots: EntrySnapshot[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    snapshots.push(JSON.parse(await readFile(join(target, name), 'utf-8')) as EntrySnapshot)
  }
  return snapshots
}
