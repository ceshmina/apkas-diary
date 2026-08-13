// 関数の定義。lambroll がこれを読んでコードと実行時設定を差し替える。
//
// 値は Terraform の state から直接引く（`--tfstate` で場所を渡す）。転記が
// 挟まらないので、転記し忘れという失敗の形が生まれない。
//
// **環境ごとのファイルは持たない。** staging と production の違いは、どの state
// を指すかだけである。呼び出し側（scripts/deploy-lambda.sh）が環境名から state の
// 場所を決めるので、対象環境を明示しない実行は成立しない。
//
// ここで自分で決めているのは MemorySize と Timeout だけ。関数の存在・ロール・
// runtime・handler・アーキテクチャは Terraform が唯一の宣言元であり、こちらは
// それを読むだけにしてある（design.md 決定9・10）。

local tfstate = std.native('tfstate');

{
  FunctionName: tfstate('module.photos.aws_lambda_function.resize.function_name'),
  Role: tfstate('module.photos.aws_iam_role.resize.arn'),
  Runtime: tfstate('module.photos.aws_lambda_function.resize.runtime'),
  Handler: tfstate('module.photos.aws_lambda_function.resize.handler'),
  Architectures: [tfstate('module.photos.aws_lambda_function.resize.architectures[0]')],

  // 長辺 3840px の WebP を4つ作る。メモリの割り当てが CPU の割り当ても決めるので、
  // 必要な容量そのものより大きめに取っている。実データで詰める（tasks 7 章）。
  MemorySize: 2048,
  Timeout: 60,

  Environment: {
    Variables: {
      DELIVERY_BUCKET: tfstate('module.photos.aws_s3_bucket.delivery.bucket'),
      DISTRIBUTION_ID: tfstate('module.photos.aws_cloudfront_distribution.photos.id'),

      // 写真の目録を書き足す先。**日記と同じテーブル**である。
      //
      // 実行ロールが触れるのは `PHOTO#` で始まるパーティションだけなので、ここが
      // 別の環境を指してもその先で権限に阻まれる。名前と権限の出どころが同じ
      // state にあり、片方だけずれた状態は作れない。
      DIARY_TABLE_NAME: tfstate('module.storage.aws_dynamodb_table.diary.name'),
    },
  },
}
