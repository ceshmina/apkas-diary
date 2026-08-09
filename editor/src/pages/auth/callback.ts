/**
 * ログインの完了。
 *
 * 失敗の理由は**記録にだけ**書き、利用者には一律に「入れなかった」とだけ返す。
 * どの検査で落ちたかを画面に出すと、試している相手にどこまで通ったかを教える。
 */

import type { APIRoute } from 'astro'
import { logAuth } from '../../lib/auth/audit.js'
import {
  decodePendingLogin,
  exchangeCode,
  isAllowed,
  PENDING_COOKIE,
} from '../../lib/auth/google.js'
import { createSession, setSessionCookie } from '../../lib/auth/session.js'

export const prerender = false

export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
  const config = locals.config
  const nowSeconds = Math.floor(Date.now() / 1000)

  const pending = decodePendingLogin(
    cookies.get(PENDING_COOKIE)?.value,
    config.sessionKey,
    nowSeconds,
  )

  // 途中状態は1度しか使わない。成功しても失敗してもここで捨てる。
  cookies.delete(PENDING_COOKIE, { path: '/' })

  const deny = (reason: string, email?: string) => {
    logAuth('denied', { reason, email })
    return redirect('/login?error=1', 302)
  }

  // Google 側で断られた場合（同意しなかった、テストユーザでない、など）。
  const googleError = url.searchParams.get('error')
  if (googleError) {
    return deny(`google が拒否しました: ${googleError}`)
  }

  if (!pending) {
    return deny('認証の途中状態がありません（期限切れか、Cookie が届いていない）')
  }

  const state = url.searchParams.get('state')
  if (!state || state !== pending.state) {
    return deny('state が一致しません')
  }

  const code = url.searchParams.get('code')
  if (!code) {
    return deny('認可コードがありません')
  }

  const result = await exchangeCode(config, code, pending.verifier, nowSeconds)
  if (!result.ok) {
    return deny(result.reason)
  }

  // 認証が成功したことと、使ってよいことは別である。
  if (!isAllowed(result.claims.email, config.allowedEmail)) {
    return deny('許可されていないアカウント', result.claims.email)
  }

  setSessionCookie(
    cookies,
    createSession(result.claims.sub, result.claims.email, nowSeconds),
    config.sessionKey,
  )
  logAuth('granted', { email: result.claims.email })

  return redirect(pending.redirectTo, 302)
}
