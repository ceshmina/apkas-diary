## 1. 公開サイトとの共有部分を切り出す

- [x] 1.1 `src/layouts/Base.astro` の `is:global` な CSS のうち、色の変数・字送り・本文要素（`h1` / `h2` / `img` / `pre` / `a` / `figure`）にかかわる部分を `src/styles/` へ移し、`Base.astro` から読む形にする。サイトのヘッダ・フッタに固有のものは移さない
  - `src/styles/tokens.css`（配色）と `src/styles/base.css`（字送りと本文要素）の2つに分けた。`Base.astro` に残したのは `header` / `main` / `footer` / `.site-title` の4つだけ。
  - `figure` は現状スタイルを持っていないため移すものがない。付けると見え方が変わるので、ここでは足さない。
- [x] 1.2 切り出しの前後で `npm run build -- staging` の生成物に差分が出ないことを確認する（見え方を変えない移動であること）
  - AWS の SSO が切れているため、DynamoDB Local に4件（公開3・下書き1）を入れて `astro build` を前後2回実行して比較した。
  - **HTML 本体は完全に同一。** CSS は**ルールの集合として同一だが、順序が変わる**。Astro は import した CSS をコンポーネントの `<style>` より先に出すため、共有分（`a` / `h1` / `h2` / `img` / `pre` / `.muted`）がサイト固有分（`header` / `main` / `footer` / `.site-title`）より前に来る。
  - 順序の変化が無害であることは、生成物に実在する 49 通りの (タグ, クラス) すべてについてカスケードを計算して確かめた。**計算結果が変わる要素は0件。** 入れ替わった 30 組のうちプロパティを共有するのは6組で、いずれも詳細度が異なる（`.site-title` > `a` など）ため順序によらず同じ側が勝つ。
  - 当初は `<style>` の外に置いた注記が HTML コメントとして生成物に出ていた。CSS コメントとして `<style>` の中に移した。
- [x] 1.3 `src/lib/store/put.ts` と `src/lib/store/queries.ts` が、編集アプリケーションからそのまま呼べる形になっているか確かめる。ビルド専用の前提（環境変数の読み方など）が混ざっていれば外す
  - どちらも `tableName()` / `awsRegion()` / `docClient()` にしか依存しておらず、そのまま呼べる。`putEntry` は GSI キー属性の付け外しと作成日時の引き継ぎまで持っており、編集アプリケーション側で書き込みを再実装する必要がない。
  - 唯一直したのは `src/lib/env.ts` の失敗メッセージ。`config/<環境>.env` を作れとだけ言っており、Lambda で動かしたときに嘘になる。両方の経路を案内する文面にした。
- [x] 1.4 下書きを含む全エントリを新しい順に引く読み取りが既存のクエリで満たせるか確かめる。足りなければ `src/lib/store/queries.ts` に足す（公開サイト向けの経路には手を入れない）
  - `scanAllIncludingDrafts()` で足りる。昇順で返るので、一覧側で反転して使う。新しいクエリは足さない。
  - 年ごとにパーティションを引いて走査を避ける案も考えたが、「何年前まで遡れば `limit` 件に届くか」を決める規則がデータに依存し、空白の年をまたぐ判断が必要になる。1日1件の日記では全件でも数千件で、既にビルドのたびに走査している経路でもあるため、素直に走査する。
  - doc コメントの「バックアップのための書き出し専用」は嘘になるので直した。公開サイトの生成がこの関数を呼ばないという肝心の部分は残してある。

## 2. 編集アプリケーションの骨格

- [x] 2.1 `editor/` を作り、`astro.config.ts` を `output: 'server'` と `@astrojs/node`（standalone）で書く。公開サイトの `astro.config.ts` とは独立させ、書き出しの integration は入れない
  - **Astro のルートはリポジトリのルートのまま**にし、`srcDir` だけ `editor/src` に向けた。ルートを `editor/` に切ると、共有している `src/lib` と `src/styles` が Vite のルート外になる。実行は `astro build --config editor/astro.config.ts`。引数なしの `astro build` はこれまでどおり公開サイトを作る。
  - `outDir` / `publicDir` / `cacheDir` も `editor/` 側に向けた。`dist/` と `.astro/` は `.gitignore` が階層を問わず無視するので追記は要らない。
  - **HTML のストリーミングを切った**（`experimentalDisableStreaming`）。前段の API Gateway が応答を丸ごと受け取ってから返す以上、分割しても速くならない。分割しないほうが、生成の途中で例外が出たときに「途中まで正しく見えるページ」が返らずに済む。
  - **Astro のセッションの保存先を `/tmp` に向けた。** 既定のままだと node アダプタが `cacheDir/sessions` を**ビルド時の絶対パスで焼き込む**。Lambda にその場所は無く、書き込みもできない。セッション自体は使わないが、いつか触ったときに動く場所を指しておく。ビルド結果に `/home/shu/...` が残っていないことを確認した。
- [x] 2.2 `@astrojs/node` をルートの `package.json` に足す。Astro と Markdown プロセッサは公開サイトと同じ版を共有する（版がずれるとプレビューと公開結果が食い違う）
  - `@astrojs/node` 11.1.0（peer は `astro@^7.0.0`）。設定を読むのに `@aws-sdk/client-ssm` も足した。
- [x] 2.3 `npm run dev:editor` を足し、`http://localhost:4321` で開発サーバが立ち上がることを確認する。`load_env` を通し、環境名の指定を必須にする
  - `scripts/dev-editor.sh`。環境名なし・未知の環境名・`config/<環境>.env` 不在の3つで、いずれも起動前に止まることを確認した。production を指定したときは確認を求める（手元から本番データを読み書きするため）。
  - `EDITOR_BASE_URL`（`http://localhost:4321`）と `EDITOR_PARAM_PREFIX`（環境名から決まる）はこのスクリプトが渡す。`config/<環境>.env` に転記を増やさない。
  - 実際の起動確認は staging の設定が要るため 8.11 で行う。`astro dev --config editor/astro.config.ts` 自体が起動して応答することはここで確認した。
- [x] 2.4 `npm run check` の対象に `editor/` を含める。型検査と Lint が通ることを確認する
  - `astro check` をルートと `--config editor/astro.config.ts` の2回走らせる。**ファイルの網羅としては1回目で足りている**（`astro check` はルート配下の `.astro` を全部見るため）。2回目を残したのは、`editor/astro.config.ts` そのものの誤りが1回目では読み込まれず素通りするため。わざと型エラーを入れて、両方が検出することを確認した。
  - **`editor/dist` が検査対象に入っていた。** `tsconfig.json` の `exclude` が `"dist"`、biome の除外が `"!dist"` で、いずれもルート直下しか外れていなかった。両方 `**/dist` に直した。biome の `!.astro` も同じ理由で `!**/.astro` に直した。
  - CSS を `.astro` から出したことで biome の CSS フォーマッタが効くようになり、引用符が二重に直されるようになった。`css.formatter.quoteStyle` を `single` にして、これまでの字面のまま保つようにした。
- [x] 2.5 応答に `X-Robots-Tag: noindex` を付ける
  - `editor/src/middleware.ts` で全応答に付ける。設定不足で 500 を返す経路にも付けた。`<meta name="robots">` も入れてある。
- [x] 2.6 起動時に必要な設定が欠けていたら、何をどこに設定すべきかを添えて落ちるようにする（`src/lib/env.ts` と同じ流儀。SSM の仮値のままの場合もここで弾く）
  - `editor/src/lib/config.ts`。SSM の1つのパスの下から4つまとめて取り、`PLACEHOLDER`・空文字・不在のいずれも失敗として扱う。メッセージには**実行すべき `aws ssm put-parameter` のコマンドがそのまま入る**。
  - **詳細はログにだけ出し、ブラウザには返さない。** 未認証の相手に SSM のパス構成を教える理由がない。
  - 失敗したときはキャッシュを捨てる。起動直後の一時的な失敗（IAM の伝播待ちなど）を、以後ずっと同じ失敗として返し続けないため。
  - 手元での確認は、SSM の代役（`GetParametersByPath` だけ答える 30 行の HTTP サーバ）を立てて `AWS_ENDPOINT_URL_SSM` で向けた。仮値のまま／1つ欠け／実値ありの3通りで、500・500・200 になることと、ログのメッセージを確認した。

## 3. 認証（Google OIDC）

- [x] 3.1 SSM Parameter Store から OAuth クライアント ID・secret・署名鍵・許可アカウントを読む処理を書く。起動時に一度だけ読み、モジュールスコープで保持する
  - 2.6 で作った `editor/src/lib/config.ts` がそのまま担う。`GetParametersByPath` 1回で4つとも取る。
- [x] 3.2 `/auth/login` を書く。`state` と PKCE の verifier を短命（10 分）の `__Host-` Cookie に置き、`openid email` のスコープで Google の認可エンドポイントへ送る
  - 途中状態（`state` / verifier / 戻り先）も**署名付き Cookie に預ける**。サーバ側に保存先を持たないので、セッションと同じ道具（`token.ts`）で足りる。
  - `access_type=online` を明示した。refresh token を受け取らないので、同意画面が Testing のままでも期限（7日）の影響を受けない。`prompt=select_account` も付けて、複数アカウントを使い分けているときに黙って別のアカウントで通らないようにした。
  - 認可 URL に verifier そのものが入らないこと（入るのは SHA-256 の challenge）と、client secret が漏れないことを検査した。
- [x] 3.3 `/auth/callback` を書く。Cookie の `state` と照合し、一致しなければ認証を成立させない
  - 途中状態は成功・失敗によらず**1度で捨てる**。
  - 拒否の理由は記録にだけ書き、画面には一律で `/login?error=1` を返す。どの検査で落ちたかを見せると、試している相手にどこまで通ったかを教えることになる。
- [x] 3.4 認可コードを client secret とともにトークンエンドポイントで交換する。`id_token` の `iss` / `aud` / `exp` / `email_verified` を検証する。署名検証は行わない（design 決定 5）
  - 交換の失敗時にトークンエンドポイントの応答本文を記録しない（認可コードの断片が入りうる）。
  - `iss` は `https://accounts.google.com` と `accounts.google.com` の両方を認める。Google は歴史的な事情で2通りを使う。
- [x] 3.5 `email` を許可アカウントと突き合わせ、一致しない場合は編集アプリケーションのいかなる内容も返さずに拒否する
  - 大文字小文字と前後の空白を無視して比べる。`ceshmina@gmail.com.evil.com` のような部分一致は通らないことを検査した。
  - 実際に別のアカウントでログインを試す確認は Google が要るため 8.2 で行う。
- [x] 3.6 セッション Cookie を発行する。`{ sub, email, exp }` に HMAC-SHA256 の署名を添え、`__Host-` 接頭辞・`HttpOnly`・`Secure`・`SameSite=Lax`・有効期間 7 日で置く
  - 形式は `base64url(JSON).base64url(HMAC)`。**JWT にはしなかった。** ヘッダを読んで検証方法を決める形は `alg: none` を受け入れる類の間違いの入り口になる。ここでは検証方法が1つしかなく、選ぶ余地がない。
  - `SameSite` は `Lax`。`Strict` にすると Google からのコールバック時に途中状態の Cookie が送られず、フローが成立しない。
- [x] 3.7 全ページ・全 API に共通で効く認証の確認を入れる。署名が検証できない、期限切れ、Cookie が無い、のいずれも未認証として扱う
  - `editor/src/middleware.ts` の1箇所だけ。素通りしてよいのは `/login` `/auth/login` `/auth/callback` と `/_astro/`（ビルド生成物）に限る。
  - 未認証の GET は `/login?redirect=...` へ 302、それ以外のメソッドは 401。
  - **Astro の CSRF 対策（`security.checkOrigin`）が既定で効いている**ことも確認できた。別オリジンからの POST は認証の確認に届く前に 403 になる。保存とログアウトの POST がこれに守られる。
- [x] 3.8 未認証の要求に対して、エントリの存在の有無が判別できる情報を返さないことを確認する（存在する日付と存在しない日付で応答が変わらない）
  - **データに触る前に middleware で折り返すので、そもそも差が生まれない。** 存在する日付（2026-08-01）と存在しない日付（2099-12-31）で status も本文も完全に一致することを確認した。
- [x] 3.9 `/auth/logout` を書く。セッション Cookie を失効させ、以後の要求が未認証になることを確認する
  - POST のみ。GET では 404 になることを確認した。リンクを踏ませるだけでセッションを切れる形にしない。
- [x] 3.10 認証の成功・拒否・ログアウトを記録に残す。日時と、拒否の場合は理由を含める。トークンや秘密そのものは記録しない
  - **1行1件の JSON にした。** 最初は `key=value` を並べる形にしていたが、Google が返すエラー文字列がそのまま `reason` に載るため、`?error=boom%0A[auth]+event%3Dgranted` を送ると**改行は無害化されるものの `event=granted` という文字列が同じ行に残り**、目で追うときにも素朴な検索にも紛らわしかった。JSON なら値は必ず引用符の中に収まる。CloudWatch Logs Insights がそのまま項目として拾えるのも都合がよい。
  - 制御文字を落とし、200 文字で切る。長い値を送りつけて記録を埋める形を作らせない。実際に 400 文字を送って切られることを確認した。
- [x] 3.11 改竄したセッション Cookie、自作したセッション Cookie、期限切れのセッション Cookie の3つで、いずれも未認証として扱われることを確認する
  - 3つとも 302（未認証）になること、改竄して差し込んだアドレスが画面に出ないことを確認した。期限は境界（`exp - 1` は通り `exp` は通らない）も見た。
  - 純粋な部分の検査 28 件と、起動したアプリケーションに対する検査 26 件を書いた。前者は `tsx` で直接、後者は SSM の代役を立てて `curl` で叩く。いずれもリポジトリには残していない（このリポジトリにテストの枠組みがまだないため）。

## 4. 編集の画面

- [x] 4.1 エントリ一覧の画面を作る。下書きと公開の双方を日付の降順で並べ、各項目から日付・タイトル・公開状態が判別できるようにする
  - 既定では新しい 100 件だけを出し、それより古いものは年で辿らせる。年ごとの件数は**走査済みの結果から数える**ので、絞り込みのための追加の読み取りはない。
  - タイトルの無いエントリは「（無題）」と薄く出す。公開サイトは「日付そのものを見出しにする」形にしているが、こちらは一覧で日付が既に隣にあるため、同じ手が使えない。
- [x] 4.2 エントリが1件もない場合に、空であることを示し、そこから新規作成に進めるようにする
  - 空のテーブルを別に作って確認した。
- [x] 4.3 新規作成の画面を作る。日付の既定を JST の当日にし、`YYYY-MM-DD` 形式を検証する
  - **「新規作成」という別の保存経路を作らなかった。** `/entries/new` は日付を選ぶだけの入口で、選んだら `/entries/<日付>` に送る。作成と編集で通る道が1本になる。
  - `src/lib/date.ts` に `todayJst()` を足した。エポックを 9 時間ずらして UTC の暦日として読む形にしてある。実行環境のタイムゾーンに依存しないので、**深夜 0 時から 9 時のあいだに Lambda（UTC）が前日を既定にする**という形の間違いが起きない。
- [x] 4.4 既にエントリのある日付を指定した場合、2件目を作らず既存エントリの内容を読み込んだ編集画面になることを確認する
  - 既存の日付を開くと本文・タイトル・公開状態が入っていること、未登録の日付では「新規」と出て他の日の本文が漏れないことを確認した。
- [x] 4.5 編集画面を作る。タイトル・本文・公開状態を編集でき、現在の公開状態が保存の前に判別できるようにする
  - 下書き／公開はラジオボタン。開いた時点でどちらが選ばれているかが見える。
- [x] 4.6 保存を `src/lib/store/put.ts` 経由で行う。GSI のキー属性の付け外しを編集アプリケーション側で実装しない
  - 公開で保存すると `gsi1pk` / `gsi1sk` が付き、下書きに戻すと外れて本文は残ることを、DynamoDB のアイテムを直接見て確認した。
  - 保存後は 303 で `?saved=1` へ戻す。POST の結果をそのまま描画すると、再読み込みで二重に保存される。
- [x] 4.7 保存の成否を利用者に明示する。失敗した場合は入力した本文を画面に残したまま再試行できるようにする
  - 失敗を実際に起こして確かめた。**20 万文字の本文**を送ると DynamoDB のアイテム上限（400KB）を超えて `PutItem` が失敗する。このとき 200 で「保存できませんでした」が出て、タイトルも本文もフォームに残り、DynamoDB 側は書き換わっていない。
- [x] 4.8 プレビューを作る。`src/lib/markdown.ts` の `renderMarkdown()` を通し、1.1 で切り出した字面の中に表示する
  - **プレビューはサーバ側で作る。** 同じフォームの submit ボタンを2つにして、`action=preview` なら保存せずに整形結果を添えて返す。クライアント側の JavaScript を持たずに済み、保存の失敗時と同じ経路で入力が残る。
  - **公開サイトとの一致を実測で確かめた。** 見出し・強調・リンク・箇条書き・画像（`figure` への組み替えを含む）・コードブロック・引用を含む本文を公開として保存し、生成した公開サイトの `<div class="body">` の中身と、プレビューの `<article>` の中身を比較したところ**バイト単位で一致**した。
  - プレビューで保存されないこと（DynamoDB のアイテムが変わらないこと）も確認した。
- [x] 4.9 削除の操作をどこにも置かないことを確認する。公開の取り下げは下書きへの切り替えで行う
  - 一覧・日付選択・編集の3画面に「削除」の文字列が現れないことを確認した。実行ロールに `DeleteItem` を与えないほうが本体の担保で、それはタスク 5.4 と 8.5。
- [x] 4.10 編集アプリケーションで保存したエントリが `npm run build -- staging` の生成物と `export/` に現れること、CLI で登録したエントリが一覧に現れることを確認する
  - 編集アプリケーションで保存 → `astro build` → `dist/2030/03/04/index.html` と `export/2030/2030-03-04.md` の両方に現れることを確認した。
  - 逆向きは本物の CLI（`src/cli/put-entry.ts`、`scripts/entry.sh` が最後に呼ぶもの）で登録し、一覧に日付・タイトル・公開状態が出ることを確認した。
- [x] 4.11 作成日時・更新日時が CLI から保存した場合と同じ規則で記録されることを確認する
  - `putEntry` を通るので規則は同一。更新したときに作成日時が引き継がれ、更新日時だけが変わることを確認した。

## 5. Terraform: editor モジュール

- [ ] 5.1 `terraform/modules/editor/` を作る。`ap-northeast-1` で完結させ、`aws.us_east_1` プロバイダは受け取らない
- [ ] 5.2 CloudWatch Logs のロググループを保持 30 日で作る。関数より先に作られるようにする
- [ ] 5.3 Lambda 関数の枠を作る。`runtime` / `handler` / `architectures`（arm64）は Terraform を唯一の宣言元とし、`filename` / `source_code_hash` / `memory_size` / `timeout` / `environment` / `layers` / `ephemeral_storage` を `ignore_changes` に並べる
- [ ] 5.4 実行ロールを作る。DynamoDB への権限は `GetItem` / `PutItem` / `UpdateItem` / `Query` に限り、`DeleteItem` と `BatchWriteItem` を**与えない**。対象はテーブルとその GSI の ARN のみにする
- [ ] 5.5 SSM のパラメータ（クライアント ID・secret・署名鍵・許可アカウント）を `/apkas-diary/<環境>/editor/` 以下に作る。値は仮値とし、`ignore_changes = [value]` を付ける。secret と署名鍵は SecureString にする
- [ ] 5.6 実行ロールに、自環境のパラメータのパス配下のみを読む権限と、その復号に必要な権限を与える。S3・CloudFront への権限は与えない
- [ ] 5.7 API Gateway HTTP API と既定ステージを作る。Lambda を payload format 2.0 で統合し、`$default` ルートを置く。`aws_lambda_permission` で API からの呼び出しだけを許可する
- [ ] 5.8 Lambda の Function URL を**作らない**ことを確認する（関数へ届く経路が API Gateway だけであること）
- [ ] 5.9 既定ステージにスロットリング（rate / burst）を設定する。あわせて関数に予約同時実行を設定する
- [ ] 5.10 ACM 証明書（`ap-northeast-1`）と DNS 検証、API Gateway のカスタムドメイン、API マッピング、Route53 の A / AAAA alias を作る。ドメインは staging が `admin.dev.apkas.net`、production が `admin.apkas.net`
- [ ] 5.11 `terraform/envs/staging` と `terraform/envs/production` から `module "editor"` を呼ぶ。ドメイン名とホストゾーン名は既存の呼び出しと同じ流儀で env 側に直接書く
- [ ] 5.12 `outputs.tf` に、編集アプリケーションの URL・関数名・API の ID・パラメータのプレフィックスを出す
- [ ] 5.13 staging に `terraform apply` し、リソースが作られること、`https://admin.dev.apkas.net` が証明書の警告なく応答することを確認する（この時点の中身は仮のアーカイブでよい）

## 6. Google Cloud: OAuth クライアント

- [ ] 6.1 `apkas-staging` プロジェクトで OAuth 同意画面を設定する。External の場合は自分をテストユーザに登録する
- [ ] 6.2 ウェブアプリケーションの OAuth クライアントを作り、redirect URI に `https://admin.dev.apkas.net/auth/callback` と `http://localhost:4321/auth/callback` を登録する
- [ ] 6.3 クライアント ID・secret と、生成した署名鍵、許可する Google アカウントを `aws ssm put-parameter --overwrite` で staging のパラメータに入れる
- [ ] 6.4 `terraform plan` が差分を出さないことを確認する（`ignore_changes = [value]` が効いていること）
- [ ] 6.5 tfstate に secret と署名鍵の実値が含まれていないことを確認する

## 7. パッケージングとデプロイ

- [ ] 7.1 `editor/function.jsonnet` を書く。`FunctionName` / `Role` / `Runtime` / `Handler` / `Architectures` は tfstate から読む。`MemorySize`（初期値 1024）と `Timeout` はここで決める
- [ ] 7.2 `Environment.Variables` にテーブル名・自身の URL・パラメータのプレフィックス・Lambda Web Adapter 用の設定（`AWS_LAMBDA_EXEC_WRAPPER` など）を置く。値は tfstate から読み、転記を作らない
- [ ] 7.3 `Layers` に Lambda Web Adapter の arm64 レイヤー ARN（`ap-northeast-1`）を書く。使った版を控える
- [ ] 7.4 `scripts/build-editor.sh` を書く。Astro をビルドし、実行時に必要な依存だけを揃えた配布ディレクトリを作る。毎回作り直す
- [ ] 7.5 `editor/.lambdaignore` を置き、TypeScript のソースや開発用のファイルが配布物に混ざらないようにする
- [ ] 7.6 配布物のサイズを確認する。直接アップロードの上限（zip 50MB）に収まらない場合は S3 経由の配置に切り替える
- [ ] 7.7 `scripts/deploy-editor.sh` を書く。環境名を第1引数に取り、`load_env` を通し、`backend.hcl` から state の場所を組み立てて `lambroll deploy --tfstate` に渡す。実行前に環境・profile・アカウントを表示し、production では確認を求める
- [ ] 7.8 `npm run deploy:editor` として `package.json` に登録する。ビルドの中間生成物を `.gitignore` に足す
- [ ] 7.9 環境名を指定せずに `npm run deploy:editor` を実行し、何もデプロイされないまま失敗することを確認する
- [ ] 7.10 `npm run deploy:editor -- staging` を実行し、直後に `terraform plan` が差分を出さないことを確認する（`ignore_changes` の並べ忘れがないこと）

## 8. staging での確認

- [ ] 8.1 許可されたアカウントでログインでき、一覧・作成・編集・公開の切り替え・プレビュー・ログアウトがひととおり動くことを確認する
- [ ] 8.2 許可されていない Google アカウントでログインを試み、拒否され、エントリの内容がいっさい返らないことを確認する
- [ ] 8.3 未認証の状態で各ページと保存の経路に直接要求を送り、拒否され、データが読み取られも変更もされないことを確認する
- [ ] 8.4 HTTP でアクセスして HTTPS にリダイレクトされることを確認する
- [ ] 8.5 実行ロールの権限で `DeleteItem` が拒否されることを確認する（AWS CLI で実行ロールを引き受けて試す）
- [ ] 8.6 実行ロールで他方の環境のテーブル、および写真・公開サイトのバケットへの操作が拒否されることを確認する
- [ ] 8.7 十分な時間を置いてからアクセスし、コールドスタートを含む最初の応答が 30 秒以内に返ることを実測する。結果に応じて `MemorySize` を詰める
- [ ] 8.8 2回目以降の要求で起動の待ちが生じないことを確認する
- [ ] 8.9 CloudWatch Logs に実行の記録が残り、保持期間が設定されていることを確認する
- [ ] 8.10 編集アプリケーションを止めた状態（関数を壊す、あるいは同時実行を 0 にする）で、公開サイトと写真が配信され続け、`npm run entry` からの登録も従来どおり動くことを確認する
- [ ] 8.11 手元の `npm run dev:editor -- staging` でも本物の Google ログインを通して動くことを確認する（認証を迂回する経路が無いこと）

## 9. production への展開

- [ ] 9.1 `apkas-production` プロジェクトで OAuth 同意画面と OAuth クライアントを作り、redirect URI に `https://admin.apkas.net/auth/callback` を登録する（localhost は登録しない）
- [ ] 9.2 production に `terraform apply` する
- [ ] 9.3 production のパラメータに実値を入れる。**staging と異なるクライアント・異なる署名鍵**にする
- [ ] 9.4 `npm run deploy:editor -- production` を実行し、直後に `terraform plan` が差分を出さないことを確認する
- [ ] 9.5 staging の資格情報では production の編集アプリケーションに入れないことを確認する
- [ ] 9.6 production で 8.1〜8.4 と同じ確認を行う

## 10. ドキュメント

- [ ] 10.1 README の冒頭の図に編集アプリケーションの経路を足す
- [ ] 10.2 初期セットアップに、Google Cloud での OAuth クライアントの作成と SSM への実値の投入を足す。**これはコード管理の外に置く例外**であることと、その理由を書く
- [ ] 10.3 日々の運用に、編集アプリケーションの URL と使い方、および「公開サイトへの反映は従来どおり手元の `npm run build` / `npm run deploy`」であることを書く
- [ ] 10.4 環境ごとの表（URL の一覧）に編集アプリケーションの行を足す
- [ ] 10.5 ディレクトリ構成に `editor/` と `terraform/modules/editor/` を足す
- [ ] 10.6 設計上の要点に、「削除できないことを IAM で担保している」「CloudFront ではなく API Gateway を選んだ理由」「使わないあいだに費用の出る構成要素を持たない」を足す
- [ ] 10.7 秘密の入れ替え（署名鍵の差し替え、クライアント secret の再発行）の手順を書く
- [ ] 10.8 `config/staging.env.example` / `config/production.env.example` に、編集アプリケーションのために増えた項目があれば足す
