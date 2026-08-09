/**
 * ログアウト。
 *
 * POST のみ受ける。リンクを踏ませるだけで他人のセッションを切れる形にしない。
 */

import type { APIRoute } from 'astro'
import { logAuth } from '../../lib/auth/audit.js'
import { clearSessionCookie } from '../../lib/auth/session.js'

export const prerender = false

export const POST: APIRoute = async ({ cookies, redirect, locals }) => {
  clearSessionCookie(cookies)
  logAuth('logout', { email: locals.session?.email })

  // 303。POST の結果として GET のページへ移る。
  return redirect('/login', 303)
}
