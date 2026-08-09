/**
 * すべての要求が通る場所。
 *
 * 設定の確認と認証の確認をここだけで行う。ページごとに書くと、書き忘れた
 * ページが素通りになる。**素通りできる経路をここ以外に作らないこと。**
 */

import { defineMiddleware } from 'astro:middleware'
import { decodeSession, SESSION_COOKIE } from './lib/auth/session.js'
import { editorConfig } from './lib/config.js'

/**
 * 認証を通らずに到達してよい場所。
 *
 * ログインの入口と出口だけ。ここに1つ足すたびに「未認証で何が見えるか」が
 * 増えるので、足すときは中身が日記に触れないことを確かめること。
 */
const PUBLIC_PATHS = new Set(['/login', '/auth/login', '/auth/callback'])

/**
 * ビルド生成物。ログイン画面の見た目に要る。
 *
 * 中身はビルドの成果物だけで、日記のデータは通らない。
 */
const PUBLIC_PREFIXES = ['/_astro/']

/** 手元での開発に使うホスト。HSTS を付けてはいけない相手。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
}

/**
 * どの応答にも必ず付ける。
 *
 * **成功した応答だけに付けると足りない。** 設定不足の 500 や未認証の 401 が
 * 最初の1回になることは十分ありうる。そこで HSTS を付け損ねると、その利用者の
 * ブラウザは次も HTTP を試しうる。付ける場所を1つにして、経路ごとの
 * 付け忘れが起きない形にしておく。
 */
function withSecurityHeaders(response: Response, hostname: string): Response {
  // 認証を通らないと何も見えないので検索エンジンに載ることはないが、
  // ログイン画面だけは誰でも到達できる。載せる意味がないので断っておく。
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')

  // API Gateway のカスタムドメインは 443 しか受けないため、平文の要求は
  // そもそも届かない。これはその手前の話で、**利用者のブラウザに二度と
  // HTTP で試させない**ための指示である。手元の開発には付けない。
  // localhost に付けると、以後 http://localhost が繋がらなくなる。
  if (!LOCAL_HOSTS.has(hostname)) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  return response
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { hostname } = context.url

  let config: Awaited<ReturnType<typeof editorConfig>>
  try {
    config = await editorConfig()
  } catch (error) {
    // 何をどこに設定すべきかは記録に残す。ブラウザには返さない。
    // 未認証の相手に SSM のパス構成を教える理由がない。
    console.error('設定を読み込めませんでした:', error instanceof Error ? error.message : error)

    return withSecurityHeaders(
      new Response('設定が未完了です。ログを確認してください。', {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
      hostname,
    )
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const session = decodeSession(
    context.cookies.get(SESSION_COOKIE)?.value,
    config.sessionKey,
    nowSeconds,
  )

  context.locals.config = config
  context.locals.session = session

  const { pathname } = context.url

  if (!session && !isPublic(pathname)) {
    // **どのパスでも同じ応答を返す。** 日付を指すパスに対して、エントリが
    // あるときと無いときで応答が変わると、未認証の相手に存在の有無が伝わる。
    // データに触る前にここで折り返すので、そもそも差が生まれない。
    const method = context.request.method

    if (method === 'GET' || method === 'HEAD') {
      const target = `${pathname}${context.url.search}`
      return withSecurityHeaders(
        context.redirect(`/login?redirect=${encodeURIComponent(target)}`, 302),
        hostname,
      )
    }

    return withSecurityHeaders(
      new Response('認証が必要です。', {
        status: 401,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
      hostname,
    )
  }

  return withSecurityHeaders(await next(), hostname)
})
