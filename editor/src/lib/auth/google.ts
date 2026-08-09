/**
 * Google による本人確認（OIDC の認可コードフロー）。
 *
 * Cognito などを挟まず直接扱う（design.md 決定4）。利用者が1人で、パスワードも
 * 属性も持たない以上、利用者の集合を管理する道具を間に置く意味がない。
 */

import { createHash, randomBytes } from 'node:crypto'
import type { EditorConfig } from '../config.js'
import { signToken, verifyToken } from './token.js'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** `iss` として認めるもの。Google は歴史的な事情で2通りを使う。 */
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** 認証の途中状態を持つ Cookie。ログインを始めてから戻ってくるまでの短い間だけ生きる。 */
export const PENDING_COOKIE = '__Host-diary-oauth'

/** 途中状態の寿命。ログイン画面を開いたまま放置された場合の上限でもある。 */
export const PENDING_TTL_SECONDS = 10 * 60

export interface PendingLogin {
  /** CSRF 対策。コールバックで受け取った値と突き合わせる。 */
  state: string
  /** PKCE の verifier。 */
  verifier: string
  /** ログイン後に戻る先。アプリケーション内のパスに限る。 */
  redirectTo: string
  exp: number
}

export interface IdTokenClaims {
  sub: string
  email: string
}

export type ClaimsResult = { ok: true; claims: IdTokenClaims } | { ok: false; reason: string }

function isPendingLogin(value: unknown): value is PendingLogin {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.state === 'string' &&
    typeof v.verifier === 'string' &&
    typeof v.redirectTo === 'string' &&
    typeof v.exp === 'number'
  )
}

/**
 * ログイン後の戻り先として受け入れてよいか。
 *
 * 自分のドメイン内のパスだけを通す。`//example.com` は「スキーム相対の URL」
 * として外部へ飛ぶため、先頭が `/` であることだけでは足りない。
 */
export function safeRedirectTo(raw: string | null | undefined): string {
  if (!raw) return '/'
  if (!raw.startsWith('/')) return '/'
  if (raw.startsWith('//')) return '/'
  return raw
}

export function createPendingLogin(redirectTo: string, nowSeconds: number): PendingLogin {
  return {
    state: randomBytes(32).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'),
    redirectTo: safeRedirectTo(redirectTo),
    exp: nowSeconds + PENDING_TTL_SECONDS,
  }
}

export function encodePendingLogin(pending: PendingLogin, key: string): string {
  return signToken(pending, key)
}

export function decodePendingLogin(
  raw: string | undefined,
  key: string,
  nowSeconds: number,
): PendingLogin | undefined {
  const payload = verifyToken<unknown>(raw, key)
  if (!isPendingLogin(payload)) return undefined
  if (payload.exp <= nowSeconds) return undefined
  return payload
}

export function redirectUri(config: EditorConfig): string {
  return `${config.baseUrl}/auth/callback`
}

/** Google の認証画面へ送るための URL。 */
export function authorizationUrl(config: EditorConfig, pending: PendingLogin): string {
  const challenge = createHash('sha256').update(pending.verifier).digest('base64url')

  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(config),
    response_type: 'code',

    // 要るのは「誰か」だけ。Gmail も Drive も見ない。
    scope: 'openid email',

    state: pending.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',

    // refresh token を受け取らない。1度きりの本人確認だけに使い、以後は
    // 自分のセッションで持つ。同意画面が Testing のままでも期限の影響を受けない。
    access_type: 'online',

    // 複数の Google アカウントを使い分けている場合に、黙って別のアカウントで
    // 通らないようにする。
    prompt: 'select_account',
  })

  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`
}

/**
 * 認可コードを ID トークンに交換する。
 *
 * ここで受け取った ID トークンは**署名を検証しない**（design.md 決定5）。
 * Google のトークンエンドポイントから TLS 上で直接受け取ったものであり、
 * 途中に信頼できない経路がない。検証が要るのは、ブラウザ経由で受け取った
 * 場合である。この判断はフローの形に依存しているので、ブラウザに ID トークンを
 * 渡す形に変えるなら署名検証を足すこと。
 */
export async function exchangeCode(
  config: EditorConfig,
  code: string,
  verifier: string,
  nowSeconds: number,
): Promise<ClaimsResult> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: redirectUri(config),
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
    })
  } catch {
    return { ok: false, reason: 'トークンエンドポイントに到達できませんでした' }
  }

  if (!response.ok) {
    // 本文には認可コードの断片が入りうるので記録に残さない。
    return { ok: false, reason: `トークンの交換に失敗しました（HTTP ${response.status}）` }
  }

  let idToken: unknown
  try {
    idToken = ((await response.json()) as Record<string, unknown>).id_token
  } catch {
    return { ok: false, reason: 'トークンエンドポイントの応答を解釈できませんでした' }
  }

  if (typeof idToken !== 'string') {
    return { ok: false, reason: '応答に ID トークンが含まれていません' }
  }

  return readIdToken(idToken, config.googleClientId, nowSeconds)
}

/**
 * ID トークンの主張を読み、宛先・発行者・期限・メールの確認状況を検める。
 *
 * 署名は見ない（`exchangeCode` の注記を参照）。見ないからこそ、ここで見る4つは
 * 必ず見る。
 */
export function readIdToken(idToken: string, clientId: string, nowSeconds: number): ClaimsResult {
  const parts = idToken.split('.')
  if (parts.length !== 3 || !parts[1]) {
    return { ok: false, reason: 'ID トークンの形式が不正です' }
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'ID トークンを解釈できませんでした' }
  }

  if (typeof payload.iss !== 'string' || !ISSUERS.includes(payload.iss)) {
    return { ok: false, reason: '発行者が Google ではありません' }
  }

  if (payload.aud !== clientId) {
    return { ok: false, reason: '宛先がこのアプリケーションではありません' }
  }

  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    return { ok: false, reason: 'ID トークンの期限が切れています' }
  }

  if (payload.email_verified !== true) {
    return { ok: false, reason: 'メールアドレスが確認されていません' }
  }

  const sub = payload.sub
  const email = payload.email
  if (typeof sub !== 'string' || sub === '' || typeof email !== 'string' || email === '') {
    return { ok: false, reason: '本人を特定できる主張が含まれていません' }
  }

  return { ok: true, claims: { sub, email } }
}

/**
 * 許可された利用者かどうか。
 *
 * 認証が成功したことと、使ってよいことは別である（editor-access-control）。
 * Google のアドレスは大文字小文字を区別しないため、揃えてから比べる。
 */
export function isAllowed(email: string, allowedEmail: string): boolean {
  return email.trim().toLowerCase() === allowedEmail.trim().toLowerCase()
}
