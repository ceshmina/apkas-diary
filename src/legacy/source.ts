/**
 * 旧サイト（eskarun）の記事ファイルを読み、この日記のエントリの形に直す。
 *
 * 旧サイトからの移行のためのモジュール。取り込みが済んだあとも、保存した内容を元ファイルと
 * 突き合わせ直せるように残してある。旧サイトは記事を `_articles/<年>/<年月>/<YYYYMMDD>.md`
 * というファイルツリーで持っており、日付はファイル名だけが持っている。本文中の情報から
 * 日付を推定する余地を残さないよう、日付はファイル名からのみ決める。
 *
 * 旧サイトの frontmatter には `title` / `status` / `location` が現れる。`location` は
 * 旧サイトの表示のための属性で、この日記は場所を扱わないため取り込まない。元のファイルは
 * 残るので、必要になったときに読み直せる。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidDate } from '../lib/date.js'
import { type EntryStatus, isEntryStatus } from '../lib/store/entry.js'

/** `20240826.md` のような、日付そのものをファイル名にした記事だけを対象にする。 */
const ARTICLE_FILE = /^(\d{4})(\d{2})(\d{2})\.md$/

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/

export interface LegacyArticle {
  /** `YYYY-MM-DD`。ファイル名から決まる。 */
  date: string
  title: string
  body: string
  /** frontmatter に `status` があればその値。なければ未指定。 */
  status?: EntryStatus
  /** 読み取り元。取り違えを追えるように残す。 */
  path: string
}

/**
 * frontmatter を読む。
 *
 * 旧サイトの frontmatter は1行1属性の `key: value` だけで、複数行の値も引用符も現れない
 * ことを確認したうえで、この最小の解釈にとどめている。YAML パーサを足すほどの形ではない。
 * 想定外の行が現れたら黙って無視せず、呼び出し側に返して気づけるようにする。
 */
function parseFrontmatter(text: string): {
  attrs: Map<string, string>
  unknownLines: string[]
  body: string
} {
  const match = FRONTMATTER.exec(text)
  if (!match) return { attrs: new Map(), unknownLines: [], body: text }

  const attrs = new Map<string, string>()
  const unknownLines: string[] = []

  for (const line of (match[1] ?? '').split('\n')) {
    if (line.trim() === '') continue

    const sep = line.indexOf(': ')
    if (sep <= 0) {
      unknownLines.push(line)
      continue
    }
    attrs.set(line.slice(0, sep).trim(), line.slice(sep + 2).trim())
  }

  return { attrs, unknownLines, body: text.slice(match[0].length) }
}

/**
 * 本文を整える。
 *
 * frontmatter 直後の空行を落とし、末尾を改行1つに揃えるだけで、それ以外は元のまま残す。
 * 旧サイトの本文には HTML がそのまま書かれている箇所があるが、書き換えない。本文は
 * Markdown として保持するという原則を守りつつ、元の記述を保存側で失わないためである
 * （表示のしかたは表示側の問題として扱う）。
 */
function normalizeBody(body: string): string {
  return `${body.replace(/^\n+/, '').replace(/\s+$/, '')}\n`
}

export interface ParseResult {
  article?: LegacyArticle
  /** 取り込みはするが、人が確認したほうがよい点。 */
  warnings: string[]
}

export function parseArticle(path: string, fileName: string, text: string): ParseResult {
  const warnings: string[] = []

  const match = ARTICLE_FILE.exec(fileName)
  if (!match) return { warnings: [`ファイル名が日付の形式ではありません: ${path}`] }

  const date = `${match[1]}-${match[2]}-${match[3]}`
  if (!isValidDate(date)) {
    return { warnings: [`ファイル名の日付が暦上存在しません: ${path}`] }
  }

  const { attrs, unknownLines, body } = parseFrontmatter(text)

  for (const line of unknownLines) {
    warnings.push(`frontmatter に解釈できない行があります（無視します）: ${path}: ${line}`)
  }

  // 旧サイトには `tilte` と綴りを誤った記事があり、旧サイトではタイトルなしとして
  // 表示されていた。移行の機会に本来の意図どおり取り込む。
  const typo = attrs.get('tilte')
  if (typo !== undefined) {
    warnings.push(`frontmatter の綴り誤り 'tilte' を title として取り込みます: ${path}`)
  }

  const status = attrs.get('status')
  if (status !== undefined && !isEntryStatus(status)) {
    return {
      warnings: [
        ...warnings,
        `status が draft / published のいずれでもありません: ${path}: ${status}`,
      ],
    }
  }

  return {
    article: {
      date,
      title: attrs.get('title') ?? typo ?? '',
      body: normalizeBody(body),
      status: status as EntryStatus | undefined,
      path,
    },
    warnings,
  }
}

export interface CollectResult {
  articles: LegacyArticle[]
  warnings: string[]
}

/**
 * ディレクトリを再帰的にたどって記事を集める。
 *
 * 旧サイトは同じ日付のファイルを1つしか持たないが、ディレクトリ構成が崩れて重複していても
 * 気づけるよう、重複は警告として返し、取り込みは行わない。日付がエントリの一意キーであるため、
 * 重複を黙って上書きすると、どちらが残ったのかが後から分からなくなる。
 */
export async function collectArticles(root: string): Promise<CollectResult> {
  const found = new Map<string, LegacyArticle>()
  const warnings: string[] = []
  const duplicated = new Set<string>()

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue

      const result = parseArticle(path, entry.name, await readFile(path, 'utf-8'))
      warnings.push(...result.warnings)

      const article = result.article
      if (!article) continue

      const existing = found.get(article.date)
      if (existing) {
        warnings.push(
          `同じ日付のファイルが複数あります（どちらも取り込みません）: ${existing.path} / ${path}`,
        )
        duplicated.add(article.date)
        continue
      }
      found.set(article.date, article)
    }
  }

  await walk(root)

  for (const date of duplicated) {
    found.delete(date)
  }

  return {
    articles: [...found.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    warnings,
  }
}
