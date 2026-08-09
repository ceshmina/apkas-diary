## Context

動機は proposal.md の Why を、満たすべき振る舞いは `specs/entry-editing/spec.md`・`specs/editor-access-control/spec.md`・`specs/editor-hosting/spec.md` を参照。ここでは形を決めるうえで効いた、現状の作りと外側の制約を述べる。

**日記の正は DynamoDB にあり、書き込みの実装は既に1箇所にある。** `src/lib/store/put.ts` が、公開状態に応じた GSI のキー属性の付け外しまで含めて持っている。下書きが公開サイトに漏れないという保証は、この付け外しが正しいことにぶら下がっている。編集アプリケーションが独自に書き込みを実装すると、その保証を支える実装が2つになる。

**Markdown の整形はすでに単体の関数として取り出されている。** `src/lib/markdown.ts` の `renderMarkdown()` は Astro のプロセッサを直接呼ぶ形で書かれており、ビルド時でなくても呼べる。「整形結果が食い違わないように」という意図でそう書かれている以上、編集アプリケーションのプレビューもこの関数を通すべきである。

**Terraform と lambroll の分担は既に決まっている。** 関数の存在・ロール・runtime・handler・アーキテクチャは Terraform が唯一の宣言元、メモリ・タイムアウト・環境変数・レイヤーは `function.jsonnet` が持ち、Terraform 側は `ignore_changes` で無視する。`lambroll deploy` の直後に `terraform plan` が差分を出さないことを人が見張る、というところまで含めて型がある。

**独自ドメインの配信は `modules/delivery` と `modules/photos` に2つある。** どちらも S3 + CloudFront + OAC + ACM(us-east-1) + Route53 で、配信元は静的なオブジェクトである。編集アプリケーションはこの型に乗らない。配信するのは動的な応答であり、キャッシュしてはならず、POST を受ける。

**App Runner は選択肢から外れている。** コンテナをそのまま置いて、使わないあいだは 0 インスタンスまで縮む、という形はもう取れない。

**環境ごとの Google Cloud プロジェクト（`apkas-staging` / `apkas-production`）が既に存在する。** OAuth クライアントを環境ごとに分けて置く先はある。

**利用者は1名で、書き込みは1日に1〜数回である。** 同時編集も、権限の段階も、規模もない。ここで凝った仕組みを入れると、得るものより保守の重さのほうが大きい。

## Goals / Non-Goals

**Goals:**

- 使っていないあいだに料金の出る構成要素を**ひとつも作らない**こと。「安い」ではなく「起点が無い」状態にする。人が停止操作を忘れても費用が出ない。
- 日記の整形と保存が、公開サイトと編集アプリケーションで**同じコードを通る**こと。プレビューで見たものと公開されるものが食い違う余地を残さない。
- 認証を通っていない要求が、データに届く経路そのものを持たないこと。
- 削除できないことを、画面に削除ボタンを置かないことではなく、**実行ロールに権限が無いこと**で担保すること。
- 編集アプリケーションが壊れても、日記が書けなくなったり公開サイトが止まったりしないこと。

**Non-Goals:**

- 応答の速さ。初回の待ちは仕様として認めている（`editor-hosting` の上限 30 秒）。速くするための常時稼働・プロビジョニング済み同時実行・エッジキャッシュはいずれも採らない。
- 編集アプリケーションからのビルド・デプロイと写真の投入（proposal の Non-goals）。
- 複数利用者・権限管理・監査ログの体系。記録は失敗を追えれば足りる。
- オフライン編集、自動保存、下書きの版管理。

## Decisions

### 1. 実行は Lambda。常時稼働する計算資源を持たない

編集アプリケーションを Lambda 関数として動かす。要求が来たときだけ実行され、終われば何も残らない。

「使わないときは停止しておき、必要なときだけ立ち上げる」という要求は、裏返せば「待機している計算資源を持たない」ことである。停止と起動を人が行う形（EC2 を落としておく、ECS のタスク数を 0 にしておく）は、操作を忘れたときに費用が出続ける。忘れても費用が出ない形にできるなら、そちらのほうが要求を強く満たしている。

コールドスタートは許容されているので、Lambda の唯一の弱点は代償にならない。

**却下した案**:

- **ECS Fargate をタスク数 0 で置く**。計算資源そのものは 0 にできるが、前段の ALB が稼働の有無によらず時間あたりで課金される（月 $18 程度）。使わない月にも費用が出るので、Goals の第1項を満たさない。ALB を避けようとすると、タスクの IP を都度 DNS に反映する仕組みが要り、そこまでして得るものが無い。
- **EC2 を普段は停止しておく**。停止中も EBS は課金され、起動・停止の操作が人の手に残り、OS の更新も抱える。1日数分の用途に対して負債が大きい。

### 2. 前段は API Gateway HTTP API。CloudFront + OAC は採らない

独自ドメインでの受け口は API Gateway の HTTP API（payload format 2.0）とし、Lambda を直接統合する。Lambda の Function URL は作らない。

このリポジトリの既存2つの配信はいずれも CloudFront であり、素直にいけば CloudFront + OAC + Lambda Function URL になる。**これは POST が通らないため採れない。** OAC が Lambda オリジンに付ける SigV4 署名は本文を署名対象に含めるが、Lambda は unsigned payload を受け付けない。したがって PUT / POST を使う場合、**閲覧者の側が本文の SHA-256 を計算して `x-amz-content-sha256` ヘッダに入れて送る**ことが要求される（[AWS の文書に明記されている](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)）。日記の本文を保存するアプリケーションで、保存のたびにブラウザ側で本文をハッシュしてヘッダに載せる前提を置くのは、素の `<form method="post">` が動かないということであり、あとから普通のフォームを1つ足した人が原因の分からない署名エラーに当たる。回避策（Lambda@Edge で署名し直す）はあるが、費用の出ない構成のために関数をもう1つ増やすのは本末転倒である。

HTTP API を選ぶと、この問題はそもそも存在しない。加えて次が得られる。

- **待機費用がない。** リクエスト課金のみ（100 万件あたり $1.00）で、時間あたりの課金がない。カスタムドメインにも追加料金がない。
- **証明書が同一リージョンで済む。** CloudFront が要求する us-east-1 の証明書ではなく、`ap-northeast-1` の ACM 証明書をそのまま使える。`aws.us_east_1` プロバイダを渡す必要がない。
- **統合タイムアウトが既定で 30 秒**であり、`editor-hosting` の「30 秒以内に応答」という上限とそのまま一致する。上限を超えたときに無応答で放置されず 504 が返る、という振る舞いがプラットフォーム側で担保される。
- **反映が速い。** CloudFront のディストリビューションは作成・更新のたびに数分待つ。ドメインを持つ動的アプリケーションの試行錯誤には向かない。

`editor-hosting` の「実行基盤には配信経路を経由してのみ到達できる」は、OAC で塞ぐのではなく **Function URL を作らない**ことで満たす。関数を呼べるのは API Gateway だけであり、迂回する到達点が存在しない。OAC より強い形になる。

**HTTPS の強制のされ方が CloudFront とは違う。** CloudFront は 80 番で受けてから 301 で HTTPS へ導けるが、API Gateway のカスタムドメインは 443 しか受け付けない。平文の要求は届かず、接続そのものが確立しない。`editor-hosting` の要求は当初「HTTPS にリダイレクトされる」と書いていたが、この形では満たせないので**「暗号化されていない経路で要求を受け付けない」に改めた**。導く時点でその要求の宛先と Cookie は既に平文で流れている以上、リダイレクトより接続を成立させないほうが強い。あわせて、応答に `Strict-Transport-Security` を付けてブラウザ側にも HTTP を試させない（手元の localhost には付けない。付けると以後 `http://localhost` が繋がらなくなる）。

キャッシュは持たない。単一利用者の動的な画面であり、キャッシュは害にしかならない。CloudFront を挟まないことで「キャッシュを無効にする設定」を保つ必要もなくなる。

### 3. アプリケーションは Astro の SSR。Lambda Web Adapter で載せる

編集アプリケーションを Astro の `output: 'server'`（`@astrojs/node` の standalone）として書き、[Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) のレイヤーを通して Lambda で動かす。Web Adapter は API Gateway のイベントを HTTP に直して、関数の中で立ち上がった素の HTTP サーバへ流す。Lambda 固有のハンドラ形式に合わせるコードを書かずに済む。

Astro を選ぶ理由は、**整形経路を二重に持たないため**である。`specs/entry-editing` の「保存の前に公開後の表示を確認できる／公開サイトと同じ解釈規則に従う」は、`renderMarkdown()` を呼べば満たせる。この関数は Astro のプロセッサを直接呼ぶ形で書かれており、Astro の外から使うには Astro とプラグインを依存として抱えることになる。抱えるなら同じ枠組みで書くほうが、版のずれが起こりえない。字面（見出しの大きさ、行間、画像の扱い）を公開サイトと揃えるのも同じ理由で楽になる（決定 10）。

**却下した案**: Hono などの軽い枠組みで書く。起動は速くなる（数百 ms 対 1〜2 秒）が、速さは Non-Goals に置いている。得られない代わりに、Markdown の整形と表示規則を公開サイトと共有する手当てが必要になる。

**却下した案**: Astro に公式の AWS アダプタを探して使う、あるいは `app.render(request)` を呼ぶ薄いハンドラを自作する。前者は存在しない。後者は Lambda のイベント形式と Fetch API の `Request` を相互変換するコードを自分で保つことになる。Web Adapter はその変換を外に出すためのものであり、自作する理由がない。

### 4. 認証は Google の OIDC を自分で扱う。Cognito を挟まない

Authorization Code フローを編集アプリケーションが直接実装する。`state` と PKCE を用い、`openid email` のスコープだけを要求する。

**却下した案**: Cognito User Pool を立て、Google を外部 IdP として設定する。トークンの管理を AWS 側に寄せられるが、この用途で得るものが小さい。利用者は1人で、パスワードも MFA も属性も持たない。User Pool は「利用者の集合を管理する」ための道具であり、集合の要素が1つ、しかもその1つの認証は結局 Google に委ねるなら、間に挟まる分だけ構成要素と設定面が増える。ホストされた UI のドメインと証明書も別に要る。

自前で扱うと言っても、実装する範囲は次だけである。

- `/auth/login`: `state` と PKCE の verifier を短命の Cookie に置き、Google の認可エンドポイントへ送る。
- `/auth/callback`: Cookie の `state` と照合し、認可コードを client secret とともにトークンエンドポイントで交換し、返ってきた `id_token` の `email` / `email_verified` を許可リストと突き合わせ、セッション Cookie を発行する。
- `/auth/logout`: セッション Cookie を失効させる。

### 5. ID token の署名は検証しない

トークンエンドポイントから TLS 上で直接受け取った `id_token` については、JWKS を引いての署名検証を行わない。Google 自身が、トークンエンドポイントから直接受け取ったトークンは検証不要と述べている。検証が要るのは、信頼できない経路（ブラウザ経由の implicit フローなど）で受け取った場合である。

省くことで `jose` などの依存と、JWKS の取得・キャッシュ・鍵交代の面倒が丸ごと消える。代わりに `iss` / `aud` / `exp` と `email_verified` は必ず見る。

**この判断はフローの形に依存している。** もし将来ブラウザに `id_token` を渡す形に変えるなら、署名検証は必須になる。

### 6. セッションは署名付き Cookie。サーバ側に状態を持たない

セッションの実体を `{ sub, email, exp }` の JSON とし、HMAC-SHA256 の署名を添えて Cookie に入れる。セッションテーブルもキャッシュも持たない。

利用者が1人で、失効させたい対象が「自分の全セッション」しかない以上、サーバ側に状態を置く動機がない（署名鍵を差し替えれば全部落ちる）。DynamoDB のテーブルも ElastiCache も増やさずに済み、Goals の「待機費用ゼロ」とも噛み合う。

Cookie の属性は次のとおり。

- **`__Host-` 接頭辞**。`Secure` かつ `Path=/` かつ `Domain` 属性なしを強制する。サブドメインから被せられる経路が閉じる。
- **`HttpOnly`**。スクリプトから読めない（`editor-access-control` の要求）。
- **`SameSite=Lax`**。Google からのコールバックはトップレベルの GET なので Lax で通る。`Strict` にすると `state` Cookie がコールバック時に送られず、フローが成立しない。
- **有効期間 7 日**。Google 側のセッションが生きていれば再ログインはクリック1回で終わるため、短くしても実害が小さい。7 日は「毎日書くあいだは切れない」の下限として置いた数字で、運用して合わなければ変える。

### 7. 秘密は SSM Parameter Store に置き、Terraform は入れ物だけを持つ

OAuth クライアントの ID / secret、セッションの署名鍵、許可する Google アカウントを、SSM Parameter Store の `/apkas-diary/<環境>/editor/` 以下に置く。Terraform は**パラメータのリソースだけ**を作り、値には差し替え用の仮値を入れて `lifecycle { ignore_changes = [value] }` を付ける。実値は `aws ssm put-parameter --overwrite` で人が入れる。

こうすると、`deployment-environments` の修正後の要求（「識別子と秘密を保持するリソースは構成管理コードで定義される／値そのものは構成管理コードにも状態にも含めない」）をそのまま満たす。秘密が tfstate に載ることもない。

Secrets Manager ではなく Parameter Store を選ぶのは費用である。Secrets Manager は秘密1つあたり月 $0.40 かかる。Standard の Parameter Store は無料で、必要な機能（SecureString、環境ごとの階層、IAM でのパス単位の許可）はすべて足りる。

関数は起動時に一度だけ読み、モジュールスコープで保持する。要求のたびには読まない。

**許可アカウントもパラメータに置く**のは、`editor-access-control` の「コードに埋め込んではならない／設定の変更だけで反映できる」を満たすためである。`function.jsonnet` の環境変数に書くとリポジトリに載る。

### 8. 「削除できない」を IAM で担保する

編集アプリケーションの実行ロールに与える DynamoDB の権限は `GetItem` / `PutItem` / `UpdateItem` / `Query` に限り、**`DeleteItem` と `BatchWriteItem` を与えない**。対象はテーブルとその GSI のみ、リソース ARN で限定する。

`specs/entry-editing` の「エントリを削除する手段を持たない」を、画面に削除ボタンを置かないことで満たすと、あとから足せてしまう。権限が無ければ、足そうとした時点で失敗する。このリポジトリが写真で採った「公開されるものは Lambda 経由のものに限る」と同じ考え方である。

同じ理由で、S3（公開サイトの配信元・写真の両方）と CloudFront への権限は一切与えない。編集アプリケーションが触れるのは自環境の日記テーブルと、自分の設定パラメータだけになる。

### 9. Terraform が枠、lambroll が中身。photo-resize と同じ分担にする

新しい Terraform モジュール `modules/editor` が、次を持つ。

- Lambda 関数の**枠**（中身は仮のアーカイブ。`filename` / `source_code_hash` / `memory_size` / `timeout` / `environment` / `layers` / `ephemeral_storage` を `ignore_changes`）
- 実行ロールとポリシー（決定 8）
- CloudWatch Logs のロググループ（保持 30 日。関数より先に作る）
- API Gateway HTTP API、既定ステージ（自動デプロイ）、Lambda 統合、`$default` ルート、`aws_lambda_permission`
- カスタムドメイン（`ap-northeast-1` の ACM 証明書＋DNS 検証）、API マッピング、Route53 の A / AAAA alias
- SSM パラメータの入れ物（決定 7）

コードと実行時設定は `editor/function.jsonnet` と `scripts/deploy-editor.sh` が配る。値は tfstate から引き、転記を作らない。photo-resize がそうしているのと同じである。分担の理由も同じで、API Gateway の統合が関数の実在を要求する一方、アプリケーションのコードはインフラよりずっと頻繁に変わる。

Web Adapter のレイヤー ARN は `function.jsonnet` に書く。`layers` は既に `ignore_changes` に並んでいる項目であり、lambroll 側が持つべきものとして最初から想定されている。

**メモリは 1024 MB から始める。** Lambda はメモリの割り当てで CPU の割り当ても決まり、課金は GB 秒である。起動が遅いほど初期化の課金時間も伸びるため、小さくすれば安くなるとは限らない。実測して詰める（tasks）。

**流量は API Gateway のステージで絞る。** 認証は関数の中で行うため、認証されていない要求も関数を1回起動させる。API Gateway のスロットリング（既定ルートの rate / burst）で、関数に届く前に落とす。あわせて関数に予約同時実行を設定し、万一の暴走時の上限を持つ。

### 10. 表示の規則と字面を公開サイトと共有する

`src/layouts/Base.astro` に `is:global` で書かれている CSS のうち、色・字送り・本文要素（`h1` / `h2` / `img` / `pre` / `a` / `figure`）にかかわる部分を `src/styles/` へ切り出し、公開サイトと編集アプリケーションの双方から読む。サイトのヘッダやフッタなど、公開サイトに固有のものは残す。

プレビューは `renderMarkdown()` の結果を、この共有された字面の中に置いて表示する。整形の規則（決定 3）と見え方の両方が同じ出どころになる。

**これは公開サイト側に手を入れる変更である。** 現状の見え方を変えないことを、切り出しの前後で確認する。

### 11. 手元での開発も本物の Google ログインを通す

`npm run dev:editor` は Astro の開発サーバを立ち上げ、`http://localhost:4321` で動かす。このオリジンを staging の OAuth クライアントの redirect URI に登録し、**認証を迂回する開発用の経路は作らない**。

認証を飛ばす仕組みは、いつか本番に紛れ込む形の代表である。作らなければ紛れ込まない。手元から読む設定（SSM のパラメータ、DynamoDB のテーブル）はいずれも staging のものになる。

`Secure` 属性の付いた Cookie は `http://localhost` に対しても設定できる（主要ブラウザは localhost を secure context として扱う）。`__Host-` 接頭辞もそのまま使える。

### 12. ドメインは `admin.<環境のゾーン>`

staging は `admin.dev.apkas.net`、production は `admin.apkas.net`。既存の `diary.*` / `photos.*` と同じ規則で、環境を表す `dev` はサービス名の内側に置く。staging のレコードは委譲済みの `dev.apkas.net` ゾーンに収まり、production のホストゾーンに触れない。

検索エンジンに載る意味がないので、応答には `X-Robots-Tag: noindex` を付ける。

## Risks / Trade-offs

**[コールドスタートが 30 秒に収まらない]** → Astro の SSR は初期化に依存の読み込みを伴う。1024 MB での初期化時間を実測し、収まらなければメモリを上げる（決定 9）。それでも足りなければ配布物を減らす（未使用の AWS SDK クライアントを外す）。仕様の上限を超える場合、API Gateway が 504 を返すので無応答にはならない。

**[Google の障害・OAuth クライアントの失効で編集できなくなる]** → 日記が書けなくなるわけではない。CLI からの登録は Google に依存しない（`editor-hosting` の「編集手段を失っているあいだの登録」）。編集アプリケーションは補助の入口であり、唯一の入口にはしない。

**[認証されていない要求も Lambda を起動し、費用になる]** → ドメインは公開情報ではないが、証明書の透明性ログから知られうる。API Gateway のスロットリングと予約同時実行で上限を作る（決定 9）。WAF は月額がかかるので採らない。

**[Web Adapter のレイヤー ARN がリージョンと版に固有]** → `function.jsonnet` に直接書くため、版を上げるのは人の操作になる。ARN が壊れていると関数は起動時に落ちる。staging で先に確認してから production に進む手順（既存の運用と同じ）で受ける。

**[パラメータの実値を入れ忘れると、原因の分かりにくい失敗になる]** → 仮値のまま起動したら「まだ設定されていません」と明示して落ちるようにする。`src/lib/env.ts` が環境変数に対してやっているのと同じ扱いにする。

**[署名鍵を差し替えると全セッションが切れる]** → 意図した性質である（決定 6）。切れても Google の再ログインで復帰できる。

**[CSS の切り出しで公開サイトの見え方が変わる]** → 切り出しは移動だけとし、同時に整理しない。前後で生成物の差分を確認する（決定 10）。

**[前段で TLS を終端するため、Astro が要求を http と解釈する]** → そのままだと `Astro.url.origin` が `http://…` になり、ブラウザが送る `Origin: https://…` と食い違って、Astro の CSRF 対策（`security.checkOrigin`、既定で有効）が**フォームの POST をひとつ残らず 403 にする**。`security.allowedDomains` に配信ドメインを挙げて `X-Forwarded-Proto` を信じさせることで解く。素性の知れないホストまで信じると `Astro.url` を操作されるので、挙げるのは 2 つのドメインに限る。

**[最終更新の取り違え]** → 複数のタブで同じ日付を開いて別々に保存すると、あとの保存が前の保存を消す。利用者が1人なので楽観的に扱い、検出の仕組みは入れない。取り返しは DynamoDB の PITR（既に有効）で付ける。

## Migration Plan

新規の追加であり、既存の動作を変えるのは決定 10 の CSS の切り出しだけである。既存のデータにも移行はない。

1. staging に Terraform を適用し、枠・API・ドメイン・パラメータの入れ物を作る。
2. `apkas-staging` プロジェクトに OAuth クライアントを作り、redirect URI（`https://admin.dev.apkas.net/auth/callback` と `http://localhost:4321/auth/callback`）を登録する。
3. SSM のパラメータに実値を入れる（client ID / secret、署名鍵、許可アカウント）。
4. `npm run deploy:editor -- staging` でコードを配る。直後に `terraform plan` が差分を出さないことを確認する。
5. staging で一通り確認する（ログイン、拒否、一覧、作成、編集、公開の切り替え、プレビュー、ログアウト、コールドスタートの実測）。
6. `apkas-production` に OAuth クライアントを作り、同じ手順を production に対して行う。

**戻し方**: コードは `lambroll rollback`。インフラは `modules/editor` の呼び出しを外して `terraform apply` すれば、編集アプリケーションだけが消える。日記テーブルにも公開サイトにも写真にも触らない。

## Open Questions

- **セッションの有効期間 7 日が妥当か**（決定 6）。実際に使ってみないと分からない。パラメータではなく定数で持ち、変えたくなったらコードを直す。仕様にも設計にも影響しない。
- **Google Cloud の OAuth 同意画面を External のままにするか**。`apkas.net` が Google Workspace のドメインであれば Internal にでき、テストユーザの登録が不要になる。どちらでもフローは変わらない。staging を作る手順の中で分かる。
