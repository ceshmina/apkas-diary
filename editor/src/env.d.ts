declare namespace App {
  interface Locals {
    /** 起動時に読んだ設定。middleware が入れる。 */
    config: import('./lib/config.js').EditorConfig
    /**
     * 認証された利用者。未認証なら `undefined`。
     *
     * ここに値があることは「署名が検証でき、期限内で、許可された利用者」まで
     * 確かめ終えていることを意味する。各ページで再確認しない。
     */
    session?: import('./lib/auth/session.js').Session
  }
}
