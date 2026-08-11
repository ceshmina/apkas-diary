/**
 * ブラウザからの写真の投入。
 *
 * **元写真はここを通らない。** 編集アプリケーションが出すのは、アップロード先へ
 * 置くことを許す一時的な資格だけで、写真そのものはブラウザから S3 へ直接送られる
 * （design.md 決定1）。実行基盤が1つの要求として受け取れる大きさに、写真が縛られ
 * ないのはこのためである。
 *
 * 資格は presigned POST として発行する。素の HTML フォームがそのまま S3 へ POST
 * できる形なので、CORS の設定も client script も要らない（決定2）。加えて policy
 * の条件として、置ける場所と大きさを**署名の中に**閉じ込められる。
 *
 * キーの規約は `src/lib/photo.ts` が持つ。手元の CLI と同じ関数を通るので、どちらの
 * 入口から入れても同じ場所に置かれる。
 */

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { assertValidDate } from '../../../src/lib/date.js'
import { awsRegion, photoDeliveryBucket, photoUploadBucket } from '../../../src/lib/env.js'
import { photoDatePrefixOf, photoKeyOf } from '../../../src/lib/photo.js'

/**
 * S3 が POST の受け取り時に、送られたファイル名で置き換える変数。
 *
 * 署名を作る時点で利用者はまだファイルを選んでいないため、キーの最後の段を確定
 * できない。**確定できるのは「置いてよい場所」までである。** テンプレートリテラル
 * に直接書くと TypeScript 側の展開と衝突するので、素の文字列として持つ。
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: S3 が展開する変数であり、TypeScript の展開ではない。
const S3_FILENAME = '${filename}'

/**
 * 資格の有効期間。
 *
 * フォームを開いてからファイルを選び、送り終えるまでを収める。policy の期限は
 * S3 が要求を受け取った時点で見るため、細い回線で大きな写真を送っている最中に
 * 切れうる。切れてもやり直せばよい（元写真は置かれていない）。
 */
const TICKET_TTL_SECONDS = 15 * 60

/**
 * 投入できる元写真の大きさ。
 *
 * 上限は、スマートフォンと一般的なカメラの JPEG が確実に収まり、かつ変換 Lambda
 * （2048MB / 60 秒）が現実に扱える範囲として置いている。**変換側の限界そのもの
 * ではなく、いちばん手軽な入口に置く歯止めである。** 超えるものは手元の CLI から
 * 入れる。
 *
 * 下限は空のファイルを弾くためだけのもの。
 */
export const MIN_UPLOAD_BYTES = 1
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * 生成を待つ上限。署名の時刻から数える。
 *
 * 上限に達しても失敗とはしない。**待ちきれなかったことをエラーとして扱う理由が
 * ない**（`put-photo.ts` と同じ判断）。ただし待ち続けもしない。読めない形式を
 * 投入したときは派生画像が永遠に現れず、待つ画面がそのまま止まってしまう。
 * このリポジトリでいちばん起きやすいのは HEIC で、変換に使う sharp が HEVC を
 * デコードできないため、投入は成功するのに生成だけが起きない。
 *
 * CLI の 30 秒より長くしてあるのは、こちらが**投入の前**から数え始めるためである。
 * 大きな写真を細い回線で送っているあいだも、この時間が進む。
 */
export const WAIT_TIMEOUT_MS = 90_000

/**
 * 生成が終わったかを調べるサイズ。
 *
 * 4つは常に揃って書かれるので、1つ見れば残りの状態も決まる。
 */
const PROBE_SIZE = 'medium' as const

let cached: S3Client | undefined

function client(): S3Client {
  if (!cached) {
    cached = new S3Client({ region: awsRegion() })
  }
  return cached
}

export interface UploadTicket {
  /** フォームの `action`。アップロード先バケットへの POST 先。 */
  url: string
  /**
   * 隠しフィールドとして並べるもの。
   *
   * **`file` はこれらより後ろに置くこと。** S3 は POST のフィールドを順に読み、
   * ファイルより後ろにあるものを見ない。
   */
  fields: Record<string, string>
  /**
   * 署名した時刻（UNIX ミリ秒）。
   *
   * 完了の判定に使う（`probeDerivative`）。**署名は元写真が置かれるより必ず前**
   * なので、これより新しい派生画像があれば、それはこの投入から作られたものである。
   */
  signedAt: number
}

/**
 * 指定した日付の下へ元写真を置くための資格を発行する。
 *
 * `Key` を `<日付の接頭辞>${filename}` にすると、SDK は policy に
 * `["starts-with", "$key", "<日付の接頭辞>"]` を入れる。**置ける場所は署名された
 * 日付の下に閉じ込められ**、利用者が任意のキーを指定する余地がない。同じ条件を
 * `Conditions` にも明示しているのは、この担保を SDK の内部の振る舞いに預けない
 * ため（同じ条件は SDK 側で重複が畳まれる）。
 *
 * **`Content-Type` のフィールドは置かない**（design.md 決定9）。置かないと元写真は
 * `binary/octet-stream` になるが、元写真は配信されないので表示に影響せず、変換は
 * 中身を見て行われる。ブラウザが埋める形にすると、スクリプトが動かない環境で空の
 * 値が条件に反し、投入そのものが失敗する。
 *
 * 戻り先を文字列ではなく関数で受け取るのは、**その URL に署名の時刻を載せる必要が
 * ある**ため。時刻を先に決めてから署名するので、URL に書いた時刻と署名の時刻が
 * 食い違うことが起こりえない。
 */
export async function createUploadTicket(
  date: string,
  redirectTo: (signedAt: number) => string,
): Promise<UploadTicket> {
  assertValidDate(date)

  const prefix = photoDatePrefixOf(date)

  // **署名は元写真が置かれるより必ず前**である。利用者はこの時点でまだファイルを
  // 選んでいない。完了の判定はこの時刻との比較で行う（`probeDerivative`）。
  const signedAt = Date.now()

  const { url, fields } = await createPresignedPost(client(), {
    Bucket: photoUploadBucket(),
    Key: `${prefix}${S3_FILENAME}`,
    Conditions: [
      ['starts-with', '$key', prefix],
      ['content-length-range', MIN_UPLOAD_BYTES, MAX_UPLOAD_BYTES],
    ],

    // 保存に成功したら S3 がここへ 303 で戻し、bucket / key / etag を query に足す。
    // 既に query を持つ URL でも S3 が正しく繋ぐ。
    Fields: { success_action_redirect: redirectTo(signedAt) },
    Expires: TICKET_TTL_SECONDS,
  })

  return { url, fields, signedAt }
}

/**
 * S3 から戻ってきたキーを、この投入のものとして受け取ってよいか確かめる。
 *
 * 見るのは2つ。**署名した日付の下にあること**と、そこから先が単一のファイル名で
 * あること。後者は policy では表せない（`starts-with` は接頭辞しか見ないので、
 * `2026/08/11/../x` も条件を満たす）。区切りを含むキーはブラウザからは生まれない
 * ので、ここで断っておく。
 *
 * 受け取れないときは `undefined`。結果の画面を出さない。
 */
export function acceptReturnedKey(date: string, key: string | null): string | undefined {
  if (!key) return undefined

  const prefix = photoDatePrefixOf(date)
  if (!key.startsWith(prefix)) return undefined

  const filename = key.slice(prefix.length)
  if (filename === '' || filename.includes('/')) return undefined

  return key
}

export interface DerivativeProbe {
  /** この投入から作られた派生画像が配信先に現れている。 */
  ready: boolean
  /**
   * 署名より前に書かれた派生画像が見えた。
   *
   * 同じキーが以前にも使われていた——つまり差し替えである、ということ。
   * **作り直しが終わるとこの事実は消える**ので、見えたときに拾っておく。
   */
  replaced: boolean
}

/**
 * 派生画像が出来たかを調べる。
 *
 * **配信 URL は叩かない。** まだ無いあいだの 403 が CDN に載り、自分の問い合わせが
 * 原因でしばらく読めないままになる（`src/lib/env.ts` と `src/cli/put-photo.ts` に
 * 同じ判断がある）。待つための操作が、待っている当のものを遅らせる。
 *
 * 「存在するか」ではなく「**署名した時刻より後に書かれたか**」で見る。差し替えの
 * ときは前回の派生画像が残っているため、存在だけを見ると投入した直後に「できま
 * した」と言ってしまう。
 *
 * S3 の `LastModified` は秒単位に切り捨てられるので、署名と生成が同じ秒に収まると
 * 「まだ」に倒れる。**倒れる先をそちらにしてある**のは、古い内容を指す URL を本文に
 * 書かせるより、数秒よけいに待たせるほうが軽いためである。投入と変換が1秒で終わる
 * ことは実際には無い。
 */
export async function probeDerivative(
  sourceKey: string,
  signedAt: number,
): Promise<DerivativeProbe> {
  try {
    const head = await client().send(
      new HeadObjectCommand({
        Bucket: photoDeliveryBucket(),
        Key: photoKeyOf(PROBE_SIZE, sourceKey),
      }),
    )

    const writtenAt = head.LastModified?.getTime()
    if (writtenAt === undefined) return { ready: false, replaced: false }

    return { ready: writtenAt > signedAt, replaced: writtenAt <= signedAt }
  } catch (error) {
    // 404 だけを「まだ無い」として扱う。それ以外の失敗を待ちに含めると、権限の
    // 不備を「生成が遅い」と読み替えて、いつまでも待ち続けることになる。
    //
    // 404 が返るのは実行ロールが配信先バケットに s3:ListBucket を持つためである。
    // 持たない主体には、キーが無い場合でも 403 が返る。
    if (statusOf(error) !== 404) throw error
    return { ready: false, replaced: false }
  }
}

/** SDK のエラーから HTTP のステータスを取り出す。 */
function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}
