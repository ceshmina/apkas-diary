/**
 * 編集アプリケーションの設定。
 *
 * 秘密（OAuth クライアントの secret、セッションの署名鍵）と、許可する
 * Google アカウントは SSM Parameter Store に置く。Terraform が作るのは
 * パラメータの入れ物だけで、値は人が `aws ssm put-parameter` で入れる
 * （design.md 決定7）。リポジトリにも配布物にも秘密が入らない。
 *
 * 読み取りは起動後の最初の要求で1度だけ行い、以後は使い回す。要求のたびに
 * 取りにいくと、1回の編集で何度も KMS の復号を呼ぶことになる。
 */

import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm'
import { awsRegion, tableName } from '../../../src/lib/env.js'

/**
 * Terraform がパラメータを作るときに入れる仮の値。
 *
 * この値のまま動かすと、Google の認証は「クライアントが存在しない」で失敗し、
 * 署名鍵は全員に既知になる。仮値であることを検出して起動時に落とす。
 */
const PLACEHOLDER = 'PLACEHOLDER'

/** SSM に置くパラメータの名前（プレフィックスからの相対）。 */
const PARAMS = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  sessionKey: 'session-key',
  allowedEmail: 'allowed-email',
} as const

/** 対象環境。production だけは公開の前に確認の一段を挟む。 */
export type Environment = 'staging' | 'production'

export interface EditorConfig {
  /** 自分の URL。Google に渡す redirect URI の組み立てに使う。末尾にスラッシュを持たない。 */
  baseUrl: string
  environment: Environment
  tableName: string
  /**
   * 起動できる公開手続きの名前。
   *
   * **実行ロールが起動を許されているのもこの1つだけ**なので、ここが別の環境を
   * 指しても、その先で権限に阻まれる。名前と権限の出どころは同じ state にある。
   */
  publishProjectName: string
  googleClientId: string
  googleClientSecret: string
  /** セッション Cookie の署名鍵。 */
  sessionKey: string
  /** 利用を許可する Google アカウント。1つだけ。 */
  allowedEmail: string
}

function requiredEnv(name: string, hint: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません。${hint}`)
  }
  return value
}

function paramPrefix(): string {
  const raw = requiredEnv(
    'EDITOR_PARAM_PREFIX',
    '手元では scripts/dev-editor.sh が、Lambda では editor/function.jsonnet が設定します。',
  )
  return raw.replace(/\/+$/, '')
}

async function fetchParameters(prefix: string): Promise<Map<string, string>> {
  const client = new SSMClient({ region: awsRegion() })
  const values = new Map<string, string>()
  let nextToken: string | undefined

  // 4つとも同じパスの下にあるので、名前を並べて個別に引かずまとめて取る。
  do {
    const result = await client.send(
      new GetParametersByPathCommand({
        Path: prefix,
        WithDecryption: true,
        NextToken: nextToken,
      }),
    )

    for (const p of result.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) {
        values.set(p.Name.slice(prefix.length + 1), p.Value)
      }
    }
    nextToken = result.NextToken
  } while (nextToken)

  return values
}

function take(values: Map<string, string>, name: string, prefix: string): string {
  const value = values.get(name)

  if (value === undefined) {
    throw new Error(
      `SSM パラメータ ${prefix}/${name} がありません。` +
        'terraform apply でパラメータが作られているか確認してください。',
    )
  }

  if (value === PLACEHOLDER || value === '') {
    throw new Error(
      `SSM パラメータ ${prefix}/${name} に実値が入っていません。` +
        `aws ssm put-parameter --name ${prefix}/${name} --value '<実値>' --overwrite で設定してください。`,
    )
  }

  return value
}

const SET_BY =
  '手元では scripts/dev-editor.sh が、Lambda では editor/function.jsonnet が設定します。'

/**
 * 対象環境。
 *
 * 知らない値を通さないのは、`production` かどうかで確認の一段が付くか決まる
 * ため。綴りを間違えた値が「production ではない」と解釈されると、確認なしで
 * 本番に配れてしまう。**判定を通す前に落とす。**
 */
function environment(): Environment {
  const raw = requiredEnv('DIARY_ENV', SET_BY)

  if (raw !== 'staging' && raw !== 'production') {
    throw new Error(`環境変数 DIARY_ENV は staging または production です: ${raw}`)
  }
  return raw
}

async function load(): Promise<EditorConfig> {
  const prefix = paramPrefix()
  const values = await fetchParameters(prefix)

  return {
    baseUrl: requiredEnv('EDITOR_BASE_URL', SET_BY).replace(/\/+$/, ''),
    environment: environment(),
    tableName: tableName(),
    publishProjectName: requiredEnv('PUBLISH_PROJECT_NAME', SET_BY),
    googleClientId: take(values, PARAMS.clientId, prefix),
    googleClientSecret: take(values, PARAMS.clientSecret, prefix),
    sessionKey: take(values, PARAMS.sessionKey, prefix),
    allowedEmail: take(values, PARAMS.allowedEmail, prefix),
  }
}

let cached: Promise<EditorConfig> | undefined

/**
 * 設定を取得する。
 *
 * 失敗した場合はキャッシュを捨てる。起動直後の一時的な失敗（IAM の伝播待ちなど）
 * を、以後ずっと同じ失敗として返し続けないため。
 */
export function editorConfig(): Promise<EditorConfig> {
  if (!cached) {
    cached = load().catch((error) => {
      cached = undefined
      throw error
    })
  }
  return cached
}
