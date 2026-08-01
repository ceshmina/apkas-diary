import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { awsRegion } from '../env.js'

let cached: DynamoDBDocumentClient | undefined

/**
 * DynamoDB のドキュメントクライアント。
 *
 * ビルド中に何度も呼ばれるため使い回す。認証情報は AWS_PROFILE などの
 * 既定の解決順に委ねる。
 *
 * DYNAMODB_ENDPOINT を設定すると接続先を上書きする。DynamoDB Local に
 * 向けて AWS へ接続せずに動作確認するための口で、通常の運用では設定しない。
 */
export function docClient(): DynamoDBDocumentClient {
  if (!cached) {
    const endpoint = process.env.DYNAMODB_ENDPOINT

    cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: awsRegion(), endpoint }), {
      marshallOptions: {
        // 空文字は空文字のまま保持する（本文が空の下書きを潰さないため）。
        convertEmptyValues: false,
        removeUndefinedValues: true,
      },
    })
  }
  return cached
}
