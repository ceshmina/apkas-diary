## 1. 着手前の確認

- [x] 1.1 `src/` と `editor/src/` を横断し、`var(--accent)`・`var(--border)`・`var(--radius)`・`var(--font-serif)`・`var(--font-sans)` の参照をすべて数え上げ、置き換え漏れの照合に使う（着手時点で `var(--accent)` は19件：`base.css` 6、`editor/src/layouts/Base.astro` 6、`editor/src/pages/entries/[date].astro` 3、`EntryList.astro` 2、日別ページ 2）
- [x] 1.2 色と書体の直書きが基準の外に残っていないことを確認する。`PhotoZoom.astro` の暗幕と説明、`textarea` と `CopyField` の等幅は対象外（proposal のスコープ外）

## 2. 書体の一覧と読み込み

- [x] 2.1 `src/styles/fonts.ts` を新設し、4つの書体の一覧（書体名・書体の変数名・太さ・字形・代わりの書体）を置く。欧文だけの書体には総称の代わりを付けない（design 決定1・3・4）
- [x] 2.2 `astro.config.ts` の `fonts` に、一覧を `fontProviders.google()` と組にして渡す（design 決定2）
- [x] 2.3 `src/layouts/Base.astro` に書体ごとの `<Font>` を置く。先読みは Instrument Serif の `latin`・`normal` だけにする（design 決定3）
- [x] 2.4 公開サイトをビルドし、`dist/_astro/fonts/` に和文の断片がすべて取り込まれていること（Zen角ゴシック New は2つの太さで約240個、Zen Old Mincho は約120個）、`latin-ext` などが落ちていること、配信物の増分が約 5.4 MB であることを確かめる
- [x] 2.5 `editor/src/layouts/Base.astro` で、同じ一覧から Google Fonts の CSS2 の URL を組み立てて `<link>` で読み、同じ名前の書体の変数を `:root` に定義する。`preconnect` も置く（design 決定2）
- [x] 2.6 `editor/astro.config.ts` に `fonts` を足していないこと、編集アプリケーションの配布物に書体のファイルが入っていないことを確かめる

## 3. 基準値（`tokens.css`）

- [x] 3.1 `src/styles/tokens.css` の色を design 決定5の値にし、暗い設定のブロックを削る
- [x] 3.2 同ファイルに書体の役割の変数（`--font-display` / `--font-serif` / `--font-sans` / `--font-ui`）を置き、書体の変数から作る。欧文の書体の後ろに和文の書体を続ける（design 決定4）
- [x] 3.3 同ファイルに `--text-prose`（15px、幅 42.5rem 以上で 15.5px）と `--radius-pill` を足す（design 決定5）
- [x] 3.4 同ファイル先頭のコメントを書き換える。ポートフォリオの写しであること、写し直しの運用、変数名の対応表を消し、日記が基準の出どころであること、朱の使いどころ（design 決定6）、コントラストの実測値（design 決定5）を書く
- [x] 3.5 `src/layouts/Base.astro` と `editor/src/layouts/Base.astro` の `theme-color` を、`media` のない `#ffffff` の1つにする

## 4. 共有する体裁（`base.css`）

- [x] 4.1 `html` の `color-scheme` を `light` にする。コメントの「明暗の設定に追従させる」も直す
- [x] 4.2 `body` の書体を `--font-sans` に、左右の余白を 1.25rem にする（design 決定5）
- [x] 4.3 `h1` / `h2` を `--font-serif` の 600（Zen Old Mincho、design 決定3）にし、`.prose` を明朝の宣言から外して `--font-sans` の 400・`--text-prose`・行送り 2.0・字送り 0.04em にする（design 決定9）
- [x] 4.4 本文のリンク（字は `--fg`、`--fg-muted` の下線、ホバーで朱）、`strong`（500）、`hr`（朱の短い線、左寄せ、前後 2.6rem）を置く。日別ページの `.body hr` の余白の指定は、ここへ寄せて消す（design 決定6・9）
- [x] 4.5 `.visually-hidden` を足す（design 決定7）
- [x] 4.6 `.pill` を design 決定10の体裁にする（`--fg` の枠、`--radius-pill`、`--font-ui` の 500、`.is-quiet` は枠を透明に、`aria-current` は `--fg` の塗りの白抜き、ホバーで朱）
- [x] 4.7 `.section-title` を、ラベル（`--font-sans` の 500、0.75rem、字送り 0.24em、淡い字）と右へ伸びる `--border` の罫線にする。飾りの英字を前に添えるときの子要素の体裁も置く（design 決定8）
- [x] 4.8 `:focus-visible` を 1px の朱の線にし、`border-radius` の指定を外す（design 決定6）

## 5. 日付の部品

- [x] 5.1 `src/lib/date.ts` に、月（Jan–Dec）と曜日（Sun–Sat）の略記と、日付を英語の部分（日、月と年、曜日）と1行の形（Mon, Sep 21, 2026）に組む関数を足す。年を省く指定を受け付ける。読み上げ用の和文には既存の `formatDateJa` を使う（design 決定7）
- [x] 5.2 `src/components/DateBlock.astro` を新設する。和文の日付（`formatDateJa`）を `.visually-hidden` で置き、見た目の英語の部分は `aria-hidden` にする。見た目の並べ方は CSS grid で行い、月・年と曜日は欧文のラベルの字面（Sep 2026 / Sun の形のまま、大文字にしない）にする。朱の丸を付けるかどうかを引数で選べるようにする（design 決定7・10）
- [x] 5.3 `src/components/EntryList.astro` の行を、日付の部品と題にする。狭い画面では月・年と曜日を「·」で1行に並べ、題をその下に置く。幅 42.5rem 以上では3列にする。ホバーで日の数字が朱になり、題に朱の下線が出る（design 決定6・7）
- [x] 5.4 `src/pages/[year]/[month]/[day].astro` の頭を、日付の部品（朱の丸つき）とタイトルの `h1` にする。タイトルがないときは `h1` が部品を包む（design 決定7）

## 6. ページの見出しと導線

- [x] 6.1 `src/components/PageHead.astro` を新設する。飾りの大きな語（`aria-hidden`）と和文の `h1`、件数を置く場所を持つ。英字の語はイタリック、期間を表す語（年の数字、月の略記）はローマンで組む（design 決定8）
- [x] 6.2 トップ（Recent）、年別（2026）、月別（Sep）、過去の同じ日（On this day）、404（Not found）にこの部品を当てる。トップの「年別」の節の題に、飾りの Archive を添える。`h1` と `<title>` は和文のまま残す
- [x] 6.3 年別のピルを数字だけ（2026）、年別ページの月のピルを略記（Sep）にする。「年」「月」は `.visually-hidden` で読み上げに残す（design 決定8）
- [x] 6.4 日別ページの前後の導線を、飾りの `← Newer` / `Older →` と、1行の日付（Mon, Sep 21, 2026。読み上げは和文）と題の組にする。幅があるときは左右2列にし、古い側は常に右の列に置く（diary-site-pages の向きの要件）
- [x] 6.5 一覧への導線を英語にする（日別ページの下は Sep 2026 / 2026 / On this day、月別ページの下は 2026）。読み上げには「2026年9月の一覧」「2026年の一覧」「過去の同じ日」を渡す。体裁は `--border` の枠のピルと欧文のラベルの字面（design 決定8・10）
- [x] 6.6 画像の説明（`figcaption` と表の説明のセル）を左寄せにし、先頭に朱の「—」を付ける。写真の並びの間隔はいまのまま保つ（design 決定9）
- [x] 6.7 `src/layouts/Base.astro` のヘッダー（題字と朱の丸、下に `--fg` の線）とフッター（線をやめて余白だけにする）を design 決定10のとおりにする。コメントのポートフォリオへの言及も直す

## 7. 編集アプリケーション

- [x] 7.1 `editor/src/layouts/Base.astro` の題（`.app-title`）を、公開サイトの題字と同じ字面にする（design 決定10）
- [x] 7.2 同ファイルのボタン・`.primary`・無効のボタン・`button.link`・入力欄・ファイル選択のボタンを design 決定10の体裁にする。`.primary` のホバーは塗りを変えず、朱の輪にする（design 決定6）
- [x] 7.3 同ファイルの通知（`.notice` の左の線は `--fg`、`.notice.error` は朱）、確認の囲み（`--fg` の枠）、`fieldset` を design 決定10の体裁にする
- [x] 7.4 `editor/src/pages/entries/[date].astro` の選択中のタブを `--fg` の塗りの白抜きにし、「最新でない」の表示は朱のままにする（design 決定6）。プレビューの本文が公開サイトの日別ページと同じ字面になることを、同じ幅の画面で確かめる
- [x] 7.5 `editor/src/pages/` のほかの画面（一覧の年のピル、写真の縮小画像と置き換え待ちの枠、公開の画面）が新しい基準で崩れていないことを確かめる。年のピルに添えたコメント（「アクセント色」）を直す

## 8. 記録

- [x] 8.1 `README.md` の「体裁の基準はポートフォリオにある」の節を、日記が基準の出どころであることと、書体の届け方（公開サイトは自分で配り、編集アプリケーションは Google Fonts から読む）に書き換える。ディレクトリ説明の `styles/` の行も見直す
- [x] 8.2 `src/styles/fonts.ts` に、書体を足す・替えるときの注意をコメントで残す。一覧を変えれば両方のアプリケーションに効くこと、和文の太さを増やすと訪問者の読む量が増えること、欧文だけの書体に総称の代わりを付けない理由（design 決定3・4）

## 9. 確認

- [x] 9.1 `npm run check`（astro check ×2、biome、lambda の検査）が通ることを確かめる
- [x] 9.2 公開サイトをビルドし、`npm run preview` で全種類のページを PC 幅とスマートフォン幅で開いて、見本（`mockup.html` の B′）と見比べる
- [x] 9.3 公開サイトの書体の要求がすべて自分のオリジンへ向いていること、日別ページで読む和文の断片がページの文字に応じた数に限られることを、ブラウザのネットワークの記録で確かめる（spec「公開サイトの書体は公開サイト自身から届く」）
- [x] 9.4 書体の要求をブロックした状態で、本文・題・日付が代わりの書体で読めることを確かめる（spec「書体を読み込めない」）
- [x] 9.5 暗い設定のブラウザで、公開サイトと編集アプリケーションが白地で出ること、ブラウザの枠が白いこと、編集の日付の入力欄とファイル選択が明るい側で描かれることを確かめる（spec「配色は白い地の1通りとする」）
- [x] 9.6 キーボードで辿ったときにフォーカスが朱の線で見えること、ピルがフォーカスで角張らないこと、動きを減らす設定で色の遷移が止まることを確かめる
- [x] 9.7 スクリーンリーダーで、日付の部品と前後の導線の日付が「2026年9月20日（日）」のように和文で読まれること、ピルと一覧への導線が「2026年」「9月」「2026年9月の一覧」と読まれること、飾りの英字が見出しとして読まれないことを確かめる（spec「欧文で示した日付の読み上げ」「欧文で示した導線の読み上げ」「飾りの英字と見出し」）
- [x] 9.8 幅 390px で、大きな日付・ピル・前後の導線・写真の並びが横にはみ出さないことを確かめる
- [x] 9.9 `tokens.css` の値からコントラストを計算し直し、文字は 4.5:1、文字でないもの（フォーカスの線、入力欄の枠）は 3:1 を満たすことを確かめる
- [x] 9.10 編集アプリケーションの配布物を zip にした大きさが、変更前（38.6 MB）からほぼ変わらないことを確かめる（design 決定2）

## 10. 配る（design の Migration Plan）

- [x] 10.1 staging に公開サイトと編集アプリケーションを配り、design の Migration Plan の見る点を確かめる
- [x] 10.2 年別・月別・過去の同じ日・404 の見出しの語と、年別ページの月のピル（Sep）を書き手に見せて確かめる（design 決定8・Risks）
- [x] 10.3 題の明朝（Zen Old Mincho 600）が、一覧の題（1rem）と前後の導線の題（0.95rem）で重く見えないか確かめる。重ければ 500 の1つに替える（design 決定1・3・Risks）
- [x] 10.4 Windows の拡大率 100% で、本文（15px の Zen角ゴシック New）が読めることを確かめる
- [ ] 10.5 `main` にマージする
- [x] 10.6 マージの後に、production へ公開サイトと編集アプリケーションを配る

## 11. 仕様の後始末

- [ ] 11.1 archive のときに、`openspec/specs/visual-identity/spec.md` の Purpose を書き換える。delta は Purpose を運ばないため、「ポートフォリオと同じ基準の下に置く」のままでは要件と食い違う
