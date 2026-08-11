/**
 * 認証された状態。
 *
 * 実体は署名付きの Cookie ひとつで、サーバ側には何も残らない。利用者が1人で、
 * 失効させたい対象が「自分の全セッション」しかない以上、保存先を持つ動機がない
 * （署名鍵を差し替えれば全部落ちる）。
 */

import type { AstroCookies } from 'astro'
import { signToken, verifyToken } from './token.js'

/** Cookie の名前。`__Host-` は Secure・Path=/・Domain なしをブラウザ側で強制する。 */
export const SESSION_COOKIE = '__Host-diary-session'

/**
 * 有効期間。
 *
 * Google 側のセッションが生きていれば再ログインはクリック1回で終わるため、
 * 長く持つ理由がない。7 日は「毎日書いているあいだは切れない」の下限。
 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export interface Session {
  /** Google アカウントの識別子。メールアドレスと違い変わらない。 */
  sub: string
  email: string
  /** 失効時刻（UNIX 秒）。 */
  exp: number
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.sub === 'string' && typeof v.email === 'string' && typeof v.exp === 'number'
}

export function createSession(sub: string, email: string, nowSeconds: number): Session {
  return { sub, email, exp: nowSeconds + SESSION_TTL_SECONDS }
}

export function encodeSession(session: Session, key: string): string {
  return signToken(session, key)
}

/**
 * Cookie の値からセッションを取り出す。
 *
 * 署名が検証できない・形式が違う・期限が切れている、のいずれも `undefined`。
 * 呼び出し側はこの3つを区別せず、まとめて未認証として扱う。
 */
export function decodeSession(
  raw: string | undefined,
  key: string,
  nowSeconds: number,
): Session | undefined {
  const payload = verifyToken<unknown>(raw, key)
  if (!isSession(payload)) return undefined
  if (payload.exp <= nowSeconds) return undefined
  return payload
}

/**
 * 発行。属性は editor-access-control の要求そのまま。
 *
 * **`sameSite` を `strict` にしてはいけない。** このアプリケーションには、別の
 * サイトからのリダイレクトで戻ってくる経路が2つある——Google の認証からの
 * `/auth/callback` と、写真を投入した S3 からの `/photos/uploaded` である。
 * `lax` はトップレベルの GET ナビゲーションでは別サイト起点でも Cookie を送るので
 * どちらも成立するが、`strict` にすると**どちらも未認証として扱われる**。
 */
export function setSessionCookie(cookies: AstroCookies, session: Session, key: string): void {
  cookies.set(SESSION_COOKIE, encodeSession(session, key), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

/** 失効。値を消し、有効期限も過去にする。 */
export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}
