/**
 * 署名付きの短い文字列。
 *
 * セッションと OAuth の途中状態は、どちらもサーバ側に保存せず、署名を添えた
 * Cookie として利用者に預ける（design.md 決定6）。保存先を持たない代わりに、
 * 「利用者が中身を書き換えられない」ことを署名で担保する。
 *
 * 形式は `base64url(JSON).base64url(HMAC-SHA256)`。JWT に似ているが、
 * アルゴリズムを申告するヘッダを持たない。ヘッダを読んで検証方法を決める形は、
 * `alg: none` を受け入れてしまう類の間違いの入り口になる。ここでは
 * 検証方法が1つしかなく、選ぶ余地がない。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

function encodeBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(body: string, key: string): string {
  return createHmac('sha256', key).update(body).digest('base64url')
}

/** 中身を JSON にして署名を添える。 */
export function signToken(payload: unknown, key: string): string {
  const body = encodeBase64Url(JSON.stringify(payload))
  return `${body}.${sign(body, key)}`
}

/**
 * 署名を検証して中身を返す。
 *
 * 署名が合わない、形式が違う、JSON として読めない、のいずれも `undefined` を
 * 返す。呼び出し側から見て「検証できなかった」は1種類でよく、どこで落ちたかを
 * 区別すると、その区別が攻撃者への手がかりになる。
 */
export function verifyToken<T>(token: string | undefined, key: string): T | undefined {
  if (!token) return undefined

  const separator = token.indexOf('.')
  if (separator <= 0) return undefined

  const body = token.slice(0, separator)
  const signature = token.slice(separator + 1)

  const expected = Buffer.from(sign(body, key))
  const actual = Buffer.from(signature)

  // 長さが違うと timingSafeEqual が例外を投げる。先に弾く。
  if (expected.length !== actual.length) return undefined
  if (!timingSafeEqual(expected, actual)) return undefined

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T
  } catch {
    return undefined
  }
}
