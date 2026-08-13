/**
 * アップロード用バケットに置かれた元写真から、配信用の派生画像を作る。
 *
 * 起動は S3 の `ObjectCreated:*` 通知。人が呼ぶ入口はない。「投入したが
 * リサイズを忘れた写真」という状態が作れないことを、経路の形で担保している。
 *
 * 配信用バケットへ書けるのはこの関数だけである。公開されるものが元写真から
 * 機械的に作られたものに限られるのは、その権限の配り方によっている。
 */

import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { type Rendering, readExif, recordRendering } from './catalog.js'

/**
 * 生成するサイズと、その長辺の px 数。
 *
 * medium と large は旧ホスト（photos.old.apkas.net）から引き継いだ規約で、
 * 日別ページの拡大表示が `/medium/` と `/large/` の対応を前提にしている。
 */
const SIZES = {
  thumbnail: 240,
  small: 960,
  medium: 1920,
  large: 3840,
} as const

type SizeName = keyof typeof SIZES

const SIZE_NAMES = Object.keys(SIZES) as SizeName[]

/**
 * 差し替えかどうかを判定するために存在を調べるサイズ。
 *
 * 4つは常に揃って書かれるので、1つ調べれば残りの有無も決まる。
 */
const PROBE_SIZE: SizeName = 'medium'

/**
 * 同じ URL の写真は内容が変わらないのが常態なので、CDN では1年持たせる。
 * ブラウザを1日で切るのは、差し替えたときに追いつく上限をそこに置くため。
 * CDN 側は差し替えのたびに invalidate するので待たなくてよい。
 */
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=31536000'

/** CloudFront の CallerReference の上限。 */
const CALLER_REFERENCE_MAX = 128

const s3 = new S3Client({})
const cloudfront = new CloudFrontClient({})

export interface Derivative {
  size: SizeName
  body: Buffer
}

/**
 * 元写真から4つの派生画像を作る。
 *
 * `rotate()` を引数なしで呼ぶと、EXIF の Orientation が画素そのものに適用される。
 * これがリサイズより前になければならないのは、長辺がどちらの辺かの判定を回転後の
 * 縦横で行う必要があるためである。回転して縦長になる写真の長辺は、回転前の幅では
 * なく高さにある。
 *
 * 色については、libvips が読み込みの時点で埋め込みプロファイルを解釈し、画素を
 * sRGB へ変換している。`withIccProfile('srgb', { attach: false })` は、その結果を
 * 出力の色空間として明示的に固定し、あわせてプロファイルを埋めないことを宣言する。
 * sRGB は Web の既定なので、埋めなくても同じ色で表示される。
 *
 * 画素の値としては既定の振る舞いと変わらない。それでも書くのは、「プロファイルを
 * 落とす」と「色を保つ」が両立している状態を、暗黙の既定に頼らずここで言い切って
 * おくためである。変換せずにプロファイルだけ落とすと、広い色空間で記録された写真は
 * 色が変わる。
 *
 * metadata を引き継ぐ指定（`keepMetadata` / `keepExif` / `withMetadata`）は
 * どこにも書かない。sharp は明示しない限り入力の EXIF・IPTC・XMP を出力へ運ばない
 * ので、**書かないことがそのまま「すべて除去する」になる**。消す処理を足す形に
 * しないのは、書き忘れが安全な側に倒れるようにするためである。
 */
export async function renderDerivatives(input: Buffer): Promise<Derivative[]> {
  const source = sharp(input).rotate()

  // clone() は入力を共有した別のパイプラインを作る。サイズごとに縮小の指定が変わる
  // ので、libvips は各パイプラインで元写真の読み込み倍率を選べる。240px を作るのに
  // 4000px を丸ごと展開しなくて済む。
  //
  // どのサイズも元写真から直接縮小する。large から medium を作るような連鎖にすると、
  // 縮小のたびの誤差が積み重なる。
  return Promise.all(
    SIZE_NAMES.map(async (size) => ({
      size,
      body: await source
        .clone()
        .resize({
          width: SIZES[size],
          height: SIZES[size],
          fit: 'inside',
          // 元より大きいサイズを求められても引き伸ばさない。素通りした結果、その
          // サイズの派生画像は元と同じ大きさになる。4つは元写真の大きさによらず
          // 常に揃うので、参照する側は存在を確かめずに URL を組み立てられる。
          withoutEnlargement: true,
        })
        .withIccProfile('srgb', { attach: false })
        .webp()
        .toBuffer(),
    })),
  )
}

/**
 * 元写真から、目録に残すものを読み取る。
 *
 * **付随情報を除去する前に読む。** 除去は出力の側で起きること（`renderDerivatives`
 * が引き継ぐ指定を書かないこと）であり、入力にはまだ残っている。読み取りは生成に
 * いっさい影響しない——ここで作るパイプラインは画素を出力せず、ヘッダだけを読む。
 *
 * 寸法は `metadata()` の `autoOrient` から取る。素の `width` / `height` は EXIF の
 * 回転を考慮しない値であり、縦位置の写真では配信される画像と縦横が入れ替わる。
 * `renderDerivatives` が `rotate()` を通しているのと同じ向きを、目録も持つ。
 */
async function readSource(input: Buffer): Promise<Rendering> {
  const metadata = await sharp(input).metadata()

  return {
    exif: readExif(metadata.exif),
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
  }
}

/**
 * 配信先のキー。サイズ名を先頭に置き、拡張子を webp に替える。
 *
 * サイズ名以外がすべて一致するので、参照する側はその部分だけを差し替えれば
 * 同じ写真の別のサイズに辿り着ける。拡張子の置換が最後の区切りより後ろだけを
 * 見るのは、`2026/08.old/a` のようにディレクトリ名に点があっても壊さないため。
 */
export function deliveryKeyOf(size: SizeName, sourceKey: string): string {
  return `${size}/${sourceKey.replace(/\.[^./]*$/, '')}.webp`
}

/**
 * CloudFront の invalidation は、オブジェクトのキーではなく要求 URL のパスで指定する。
 * 区切りの `/` は残したまま、各段だけを符号化する。
 */
function invalidationPathOf(deliveryKey: string): string {
  return `/${deliveryKey.split('/').map(encodeURIComponent).join('/')}`
}

interface S3EventRecord {
  s3: {
    bucket: { name: string }
    object: { key: string }
  }
}

export interface S3Event {
  Records: S3EventRecord[]
}

export async function handler(event: S3Event): Promise<void> {
  const deliveryBucket = requireEnv('DELIVERY_BUCKET')
  const distributionId = requireEnv('DISTRIBUTION_ID')

  for (const record of event.Records) {
    await processRecord(record, deliveryBucket, distributionId)
  }
}

async function processRecord(
  record: S3EventRecord,
  deliveryBucket: string,
  distributionId: string,
): Promise<void> {
  const sourceBucket = record.s3.bucket.name
  // 通知に載るキーは URL 符号化されており、空白は `+` になっている。
  const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))
  const source = `s3://${sourceBucket}/${sourceKey}`

  // 読み出しの失敗は一時的なことがある。例外を投げて Lambda の再試行に委ねる。
  const object = await s3.send(new GetObjectCommand({ Bucket: sourceBucket, Key: sourceKey }))
  if (!object.Body) {
    throw new Error(`本文が空です: ${source}`)
  }
  const input = Buffer.from(await object.Body.transformToByteArray())

  let derivatives: Derivative[]
  try {
    derivatives = await renderDerivatives(input)
  } catch (error) {
    // 画像として読めなかった。同じ入力を何度試しても結果は変わらないので、例外を
    // 投げずに記録だけ残して終える。再試行に回さないことで、後から投入されたものの
    // 処理がここで止まらない。
    console.error(`画像として読めませんでした: ${source}`, error)
    return
  }

  // 既に配信中のものを差し替えるときだけ、あとで CDN に伝える。初回の投入では
  // キャッシュに何も載っていないため、消す要求を出す理由がない。
  const replacing = await exists(deliveryBucket, deliveryKeyOf(PROBE_SIZE, sourceKey))

  await Promise.all(
    derivatives.map(({ size, body }) =>
      s3.send(
        new PutObjectCommand({
          Bucket: deliveryBucket,
          Key: deliveryKeyOf(size, sourceKey),
          Body: body,
          ContentType: 'image/webp',
          CacheControl: CACHE_CONTROL,
        }),
      ),
    ),
  )
  console.log(`生成しました: ${source} -> ${SIZE_NAMES.join(' / ')}`)

  if (replacing) {
    await invalidate(distributionId, sourceKey)
    console.log(`差し替えのため invalidate しました: ${sourceKey}`)
  }

  await recordInCatalog(sourceKey, input)
}

/**
 * 目録に書き足す。
 *
 * **派生画像を置いたあとに行う。順序を入れ替えない。** 書くのは「生成が終わった」
 * ことであり、終わる前に書けば嘘になる。
 *
 * **失敗しても投げない。** 例外を投げると Lambda が再試行し、既に済んでいる生成を
 * もう一度やり直すことになる。目録は配信されているものの写しであり（`photo-catalog`）、
 * 写しを作れなかったことで元のほうを繰り返さない。同じ元写真を投入し直せば記録は
 * 揃う（`photo-ingest` の「目録への記録の失敗は派生画像の生成を妨げない」）。
 */
async function recordInCatalog(sourceKey: string, input: Buffer): Promise<void> {
  try {
    const rendering = await readSource(input)
    const recorded = await recordRendering(sourceKey, rendering, new Date().toISOString())

    if (recorded) {
      console.log(`目録に記録しました: ${sourceKey}`)
    } else {
      console.log(`目録には記録しません（日付の規約に沿わないキー）: ${sourceKey}`)
    }
  } catch (error) {
    console.error(`目録に記録できませんでした: ${sourceKey}`, error)
  }
}

/**
 * 配信先に同じキーのオブジェクトがあるか。
 *
 * 404 だけを「無い」として扱い、それ以外の失敗は例外のまま通す。権限の不備や
 * 一時的な障害を「無い」と読み替えると、差し替えたのに invalidate されないという
 * 形で静かに間違う。
 */
async function exists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status === 404) {
      return false
    }
    throw error
  }
}

async function invalidate(distributionId: string, sourceKey: string): Promise<void> {
  const paths = SIZE_NAMES.map((size) => invalidationPathOf(deliveryKeyOf(size, sourceKey)))

  await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        // 同じ写真を続けて投入し直しても衝突しない値にする。先頭に時刻を置くので、
        // 長いキーが上限で切り落とされても一意性は保たれる。
        CallerReference: `${Date.now()}-${sourceKey}`.slice(0, CALLER_REFERENCE_MAX),
        Paths: { Quantity: paths.length, Items: paths },
      },
    }),
  )
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません`)
  }
  return value
}
