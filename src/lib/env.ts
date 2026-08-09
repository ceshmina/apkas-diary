/**
 * 環境変数の読み取り。
 *
 * 手元での実行では実値を `config/<環境>.env` に置き、`scripts/build.sh` などが
 * 読み込んでからプロセスに渡す。編集アプリケーションを Lambda で動かすときは
 * `editor/function.jsonnet` が Terraform の state から引いて関数に渡す。
 * いずれの経路でも値が欠けている場合は、何をどこで設定すべきかを含めて失敗させる。
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。` +
        '手元での実行では config/staging.env / config/production.env に terraform output の値を、' +
        'Lambda では editor/function.jsonnet に設定してください。',
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

/** 元写真を投入する S3 バケット。 */
export function photoUploadBucket(): string {
  return required('PHOTO_UPLOAD_BUCKET')
}

/**
 * 派生画像が置かれる S3 バケット。
 *
 * 書き込むのは Lambda だけで、こちらは生成が終わったかを見るために読むだけ。
 * 配信 URL を叩いて調べる形にすると、まだ無いあいだの 403 が CDN に載り、
 * 自分の問い合わせが原因でしばらく読めないままになる。
 */
export function photoDeliveryBucket(): string {
  return required('PHOTO_BUCKET')
}

/** 写真の配信 URL の基点。 */
export function photoUrl(): string {
  return required('PHOTO_URL')
}
