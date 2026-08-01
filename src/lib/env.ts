/**
 * 環境変数の読み取り。
 *
 * 実値は `.env.<環境>` に置き、`scripts/build.sh` などが読み込んでから
 * プロセスに渡す。値が欠けている場合は、何をどこで設定すべきかを含めて失敗させる。
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。` +
        '.env.staging / .env.production を作成し、terraform output の値を転記してください。',
    )
  }
  return value
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`環境変数 ${name} は正の整数である必要があります: ${raw}`)
  }
  return value
}

export function awsRegion(): string {
  return process.env.AWS_REGION ?? 'ap-northeast-1'
}

export function tableName(): string {
  return required('DIARY_TABLE_NAME')
}

/** トップページに表示する最新エントリの件数。 */
export function recentCount(): number {
  return optionalNumber('DIARY_RECENT_COUNT', 20)
}

/** Markdown の書き出し先。バージョン管理の対象外。 */
export function exportDir(): string {
  return process.env.DIARY_EXPORT_DIR ?? 'export'
}

/** サイトの公開 URL。未設定でもビルドは通す。 */
export function siteUrl(): string | undefined {
  return process.env.SITE_URL || undefined
}
