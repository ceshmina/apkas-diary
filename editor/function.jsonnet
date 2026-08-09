// 関数の定義。lambroll がこれを読んでコードと実行時設定を差し替える。
//
// 値は Terraform の state から直接引く（`--tfstate` で場所を渡す）。転記が
// 挟まらないので、転記し忘れという失敗の形が生まれない。
//
// **環境ごとのファイルは持たない。** staging と production の違いは、どの state
// を指すかだけである。呼び出し側（scripts/deploy-editor.sh）が環境名から state の
// 場所を決めるので、対象環境を明示しない実行は成立しない。
//
// ここで自分で決めているのは MemorySize・Timeout・Layers・Environment だけ。
// 関数の存在・ロール・runtime・handler・アーキテクチャ・予約同時実行は
// Terraform が唯一の宣言元であり、こちらはそれを読むだけにしてある
// （design.md 決定9）。

local tfstate = std.native('tfstate');

{
  FunctionName: tfstate('module.editor.aws_lambda_function.editor.function_name'),
  Role: tfstate('module.editor.aws_iam_role.editor.arn'),
  Runtime: tfstate('module.editor.aws_lambda_function.editor.runtime'),
  Handler: tfstate('module.editor.aws_lambda_function.editor.handler'),
  Architectures: [tfstate('module.editor.aws_lambda_function.editor.architectures[0]')],

  // Lambda Web Adapter。素の HTTP サーバを Lambda の呼び出しに橋渡しする
  // （design.md 決定3）。**版は人が上げる。** ARN が壊れていると関数は起動の
  // 時点で落ちるので、staging で確かめてから production に進むこと。
  Layers: [
    'arn:aws:lambda:ap-northeast-1:753240598075:layer:LambdaAdapterLayerArm64:28',
  ],

  // メモリの割り当てが CPU の割り当ても決める。課金は GB 秒なので、小さくすれば
  // 安くなるとは限らない（起動が遅いほど初期化の課金時間も伸びる）。実測して
  // 詰める（tasks 8.7）。
  MemorySize: 1024,

  // API Gateway の統合タイムアウトが 30 秒。それより先に関数側が諦めても、
  // 利用者に返るものは変わらない。合わせておく。
  Timeout: 30,

  Environment: {
    Variables: {
      // Web Adapter を起動の入口に挟む。これが無いと handler の run.sh は
      // Node のモジュールとして読まれ、起動しない。
      AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',

      // Astro の standalone サーバを立てる先。run.sh が同じ値を見る。
      AWS_LWA_PORT: '8080',
      PORT: '8080',

      // 起動できたかの確認先。認証を通らなくても実体のあるページが返る場所を選ぶ。
      AWS_LWA_READINESS_CHECK_PATH: '/login',

      // **どんな状態番号でも「起動した」とみなす。** 既定（100-499）のままだと、
      // 設定が未投入で 500 を返す状態が「まだ起動していない」と解釈され、
      // 原因の分かる 500 ではなくタイムアウトとして現れる。ここで見たいのは
      // 「HTTP サーバが応答するようになったか」であって、設定の正しさではない。
      AWS_LWA_READINESS_CHECK_HEALTHY_STATUS: '100-599',

      DIARY_TABLE_NAME: tfstate('module.storage.aws_dynamodb_table.diary.name'),

      // 自分の URL と、設定の置き場所。どちらも出力として定義済みのものを読む。
      // 同じ文字列を組み立てる規則が2箇所に分かれない。
      EDITOR_BASE_URL: tfstate('output.editor_url'),
      EDITOR_PARAM_PREFIX: tfstate('output.editor_param_prefix'),
    },
  },
}
