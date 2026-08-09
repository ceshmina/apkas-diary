import node from '@astrojs/node'
import { defineConfig, sessionDrivers } from 'astro/config'

/**
 * 編集アプリケーションのビルド設定。
 *
 * 公開サイトとは別のアプリケーションだが、**同じ Astro プロジェクトのルート**
 * （リポジトリのルート）で動かす。`srcDir` だけをこちらに向けることで、
 * `src/lib` や `src/styles` を素直な相対 import で共有できる。ルートを
 * `editor/` に切ると、共有しているものが Vite のルート外になってしまう。
 *
 * 実行は `astro build --config editor/astro.config.ts`（リポジトリのルートから）。
 * 引数なしの `astro build` はこれまでどおり公開サイトを作る。
 */
export default defineConfig({
  srcDir: './editor/src',
  outDir: './editor/dist',
  publicDir: './editor/public',
  cacheDir: './editor/.astro',

  // 公開サイトの生成物と混ざらないよう、キャッシュも出力も editor/ 側に置く。

  output: 'server',
  adapter: node({
    mode: 'standalone',

    // 応答を分割して送らない。前段の API Gateway が応答を丸ごと受け取ってから
    // 返す以上、分割しても速くならない。分割しないほうが、生成の途中で例外が
    // 出たときに「途中まで正しく見えるページ」が返らずに済む。
    experimentalDisableStreaming: true,
  }),

  trailingSlash: 'never',

  security: {
    /**
     * 前段が渡す `X-Forwarded-Proto` / `X-Forwarded-Host` を、ここに挙げた
     * ホストに限って信じる。
     *
     * **これが無いと保存が全部 403 になる。** TLS は API Gateway で終端し、
     * 関数には平文で届くため、Astro は要求の URL を `http://` として組み立てる。
     * 一方ブラウザが送る `Origin` は `https://` なので、Astro の CSRF 判定
     * （`security.checkOrigin`、既定で有効）が別オリジンと見なす。フォームの
     * POST がひとつ残らず弾かれる。
     *
     * 素性の知れないホストまで信じると、`X-Forwarded-Host` を差し込まれて
     * `Astro.url` を操作されうる。ここに挙げた2つに限る。
     */
    allowedDomains: [
      { hostname: 'admin.apkas.net', protocol: 'https' },
      { hostname: 'admin.dev.apkas.net', protocol: 'https' },
    ],
  },

  // 画像処理を行わない。
  //
  // 既定の画像サービスは sharp を使う。編集アプリケーションは `<Image>` を
  // 持たず、本文中の画像は Markdown から出た素の `<img>`（配信は写真の
  // CloudFront）なので、処理する対象がそもそもない。既定のままだと、使わない
  // native binary を Lambda まで運ぶことになる。
  image: { service: { entrypoint: 'astro/assets/services/noop' } },

  // Astro のセッションは使わない（認証の状態は署名付き Cookie が持つ。design 決定6）。
  // 既定のままだと node アダプタが `cacheDir/sessions` をセッションの保存先として
  // **ビルド時の絶対パスで焼き込む**。Lambda にその場所は無く、書き込みもできない。
  // 使っていないので今は誰も触らないが、いつか触ったときに動く場所へ向けておく。
  session: { driver: sessionDrivers.fsLite({ base: '/tmp/astro-sessions' }) },

  // 公開サイトの `site` は絶対 URL の生成に使うが、編集アプリケーションは
  // 自分のドメインを外に出さないため設定しない。
})
