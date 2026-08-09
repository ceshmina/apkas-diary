/**
 * 認証にかかわる出来事の記録。
 *
 * 残すのは「いつ・何が起きたか・拒否ならなぜか」の3つ（editor-access-control）。
 * トークンも認可コードも秘密も書かない。
 *
 * **1行1件の JSON として出す。** 記録に載る値には外から来るものが混ざる
 * （Google が返したエラー、相手が名乗ったアドレス）。`key=value` を並べる形だと、
 * その値の中に `event=granted` のような文字列を仕込まれたときに、行を目で追う
 * 側からも素朴な検索からも紛らわしくなる。JSON なら値は必ず引用符の中に収まり、
 * 別のフィールドにも別の行にもなりえない。CloudWatch Logs Insights が
 * そのまま項目として拾えるという利点も付いてくる。
 */

export type AuthEvent = 'granted' | 'denied' | 'logout'

/**
 * 記録に混ぜてよい形に均す。
 *
 * JSON にする時点で改行も引用符も無害になるが、制御文字はそもそも読めないので
 * 落とす。長さも切る。相手が長い値を送りつけて記録を埋める形を作らせない。
 */
function sanitize(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 読めない制御文字を落とすのが目的。
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200)
}

export function logAuth(event: AuthEvent, detail: { email?: string; reason?: string } = {}): void {
  const line = JSON.stringify({
    tag: 'auth',
    event,
    at: new Date().toISOString(),
    ...(detail.email ? { email: sanitize(detail.email) } : {}),
    ...(detail.reason ? { reason: sanitize(detail.reason) } : {}),
  })

  // 拒否だけを警告として出す。あとから絞り込めるようにしておく。
  if (event === 'denied') {
    console.warn(line)
  } else {
    console.info(line)
  }
}
