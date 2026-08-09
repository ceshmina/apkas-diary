/**
 * ログインの開始。
 *
 * CSRF 対策の `state` と PKCE の verifier を作り、短命の Cookie に預けてから
 * Google の認証画面へ送る。サーバ側にはここでも何も残さない。
 */

import type { APIRoute } from 'astro'
import {
  authorizationUrl,
  createPendingLogin,
  encodePendingLogin,
  PENDING_COOKIE,
  PENDING_TTL_SECONDS,
} from '../../lib/auth/google.js'

export const prerender = false

export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
  const config = locals.config
  const nowSeconds = Math.floor(Date.now() / 1000)

  const pending = createPendingLogin(url.searchParams.get('redirect') ?? '/', nowSeconds)

  cookies.set(PENDING_COOKIE, encodePendingLogin(pending, config.sessionKey), {
    httpOnly: true,
    secure: true,
    // Google からの戻りはトップレベルの GET なので Lax で送られる。
    // Strict にすると、この Cookie がコールバックに届かずフローが成立しない。
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_TTL_SECONDS,
  })

  return redirect(authorizationUrl(config, pending), 302)
}
