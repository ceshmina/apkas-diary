/**
 * 使う書体と太さの一覧。
 *
 * 公開サイトと編集アプリケーションの双方が、ここから書体の読み込みを作る。
 * 届け方は2つで異なる。
 *
 * - 公開サイト：`astro.config.ts` の `fonts` がこの一覧をビルド時に Google Fonts
 *   から取り込み、`/_astro/fonts/` から配る。訪問者のブラウザが Google へ要求を
 *   送ることはない（visual-identity「公開サイトの書体は公開サイト自身から届く」）。
 * - 編集アプリケーション：`editor/src/layouts/Base.astro` がこの一覧から Google
 *   Fonts の URL を組み立てて読む。自分で配ると書体のファイル（数 MB）が Lambda の
 *   配布物に入り、直接アップロードの上限（50 MB）に近づく。
 *
 * **書体を足す・替えるときは、この一覧だけを変える。** どちらのアプリケーション
 * にも同じ書体・同じ太さが届き、プレビューと公開後の字面がずれない。画面の CSS は
 * `tokens.css` の役割の変数（`--font-display` など）だけを使い、ここで定める書体の
 * 変数を直接は参照しない。
 *
 * **和文の太さを1つ足すごとに、訪問者の読む量が増える。** 和文の書体は1つの太さが
 * 約120の断片に分かれ、ページに現れる文字を含む断片だけが読まれる。同じ字でも
 * 太さが違えば別の断片を読むので、題の明朝は 600 の1つに絞ってある。本文の
 * ゴシックに 700 を持たないのも同じ理由で、`strong` は 500 で組む（base.css）。
 * 持たない太さを指定すると、ブラウザが疑似的に太らせて字面が崩れる。
 *
 * **欧文だけの書体には、総称の代わり（`serif` など）を付けない。** 役割の変数では、
 * 欧文の書体の後ろに和文の書体を続けている（`--font-display` は Instrument Serif
 * → Zen Old Mincho）。総称は、そこに現れない文字も含めてすべて受け止めてしまう。
 * 欧文の書体の直後に `serif` があると、題字に混ざった和文（編集アプリケーションの
 * 題「apkas-diary 編集」の「編集」など）が和文の書体まで届かず、OS の明朝で出る。
 *
 * 和文の書体の代わりには、OS の和文の書体を先に並べる。読み込みを待つあいだと
 * 読み込めなかったときの字面が、読み込んだ後の字面に近くなる。
 */

export interface DiaryFont {
  /** Google Fonts での書体名。 */
  name: string
  /** 書体の変数。`tokens.css` の役割の変数がこれを参照する。 */
  cssVariable: `--font-${string}`
  weights: readonly [number, ...number[]]
  styles: readonly ['normal' | 'italic', ...('normal' | 'italic')[]]
  /** 読み込みを待つあいだと、読み込めなかったときに代わりに使う書体。 */
  fallbacks: readonly string[]
}

export const FONTS = [
  {
    // 題字・日付の数字・英字の見出し語
    name: 'Instrument Serif',
    cssVariable: '--font-instrument-serif',
    weights: [400],
    styles: ['normal', 'italic'],
    fallbacks: [],
  },
  {
    // 欧文のラベル（月・曜日の略記、導線の日付、ピル、一覧への導線）
    name: 'Instrument Sans',
    cssVariable: '--font-instrument-sans',
    weights: [500],
    styles: ['normal'],
    fallbacks: [],
  },
  {
    // 題（記事・一覧・導線の題、本文の `##`、画面の見出し）
    name: 'Zen Old Mincho',
    cssVariable: '--font-zen-old-mincho',
    weights: [600],
    styles: ['normal'],
    fallbacks: ['Hiragino Mincho ProN', 'Yu Mincho', 'serif'],
  },
  {
    // 本文・和文のラベル・画面の地。500 は和文のラベルに使う
    name: 'Zen Kaku Gothic New',
    cssVariable: '--font-zen-kaku-gothic-new',
    weights: [400, 500],
    styles: ['normal'],
    fallbacks: ['Hiragino Sans', 'Yu Gothic', 'Meiryo', 'sans-serif'],
  },
] as const satisfies readonly DiaryFont[]
