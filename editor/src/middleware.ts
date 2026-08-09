/**
 * すべての要求が通る場所。
 *
 * ここで行うのは2つ。設定が揃っていることの確認と、応答に検索エンジン向けの
 * 指示を付けること。認証の確認もこの後のタスクでここに入る。
 */

import { defineMiddleware } from 'astro:middleware'
import { editorConfig } from './lib/config.js'

export const onRequest = defineMiddleware(async (_context, next) => {
  try {
    await editorConfig()
  } catch (error) {
    // 何をどこに設定すべきかは記録に残す。ブラウザには返さない。
    // 未認証の相手に SSM のパス構成を教える理由がない。
    console.error('設定を読み込めませんでした:', error instanceof Error ? error.message : error)

    return new Response('設定が未完了です。ログを確認してください。', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    })
  }

  const response = await next()

  // 認証を通らないと何も見えないので検索エンジンに載ることはないが、
  // ログイン画面だけは誰でも到達できる。載せる意味がないので断っておく。
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')

  return response
})
