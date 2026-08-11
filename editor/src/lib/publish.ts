/**
 * 公開手続きの起動と状況の取得。
 *
 * 編集アプリケーションが持つのは「始めること」と「見ること」だけである。
 * 何をどこへ配るかは手続きの側（buildspec.yml と scripts/）が持っており、
 * 実行ロールも別である。ここから配信物へ直接書き込む経路は存在しない。
 *
 * **ビルドの ID をどこにも保存しない。** プロジェクトの最新の実行を引けば
 * 現在の状況が分かるので、セッションにも DynamoDB にも状態を持たずに済む。
 * 別のブラウザで開いても同じものが見え、将来べつの起動口が増えても、そこから
 * 始まった実行が同じ画面に現れる（design.md 決定5）。
 */

import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
  StartBuildCommand,
} from '@aws-sdk/client-codebuild'
import { awsRegion } from '../../../src/lib/env.js'
import type { EditorConfig } from './config.js'

/**
 * 利用者に見せる状態。
 *
 * CodeBuild の状態は6種類あるが、画面で意味を持つのはこの4つに畳める。
 * FAILED / FAULT / TIMED_OUT はどれも「失敗した、原因はログにある」であり、
 * 区別して見せても次にすることは変わらない。
 */
export type PublishState = 'running' | 'succeeded' | 'failed' | 'stopped'

export interface PublishStatus {
  id: string
  state: PublishState
  /** CodeBuild が返した生の状態。失敗の区別を知りたいときのために残す。 */
  rawStatus: string
  startedAt?: Date
  endedAt?: Date
  /** 実行に使われた commit。手元の未コミットの変更が配られないことを、目で確かめるためのもの。 */
  commit?: string
  /** 進行中に今どの段にいるか（INSTALL / BUILD など）。 */
  phase?: string
  /** 失敗の原因に辿り着くための手がかり。CloudWatch Logs へのリンク。 */
  logsUrl?: string
}

let cached: CodeBuildClient | undefined

function client(): CodeBuildClient {
  if (!cached) {
    cached = new CodeBuildClient({ region: awsRegion() })
  }
  return cached
}

function toState(status: string | undefined): PublishState {
  switch (status) {
    case 'IN_PROGRESS':
      return 'running'
    case 'SUCCEEDED':
      return 'succeeded'
    case 'STOPPED':
      return 'stopped'
    default:
      // FAILED / FAULT / TIMED_OUT、および知らない値。
      // **知らない状態を「成功」に寄せない。** 配られていないものを配られたと
      // 表示するほうが、余分に失敗と言うより害が大きい。
      return 'failed'
  }
}

/**
 * 最新の実行を1件取得する。1度も実行されていない場合は undefined。
 *
 * 一覧は新しい順に返るので、先頭だけを引けばよい。
 */
export async function latestPublish(config: EditorConfig): Promise<PublishStatus | undefined> {
  const listed = await client().send(
    new ListBuildsForProjectCommand({
      projectName: config.publishProjectName,
      sortOrder: 'DESCENDING',
    }),
  )

  const id = listed.ids?.[0]
  if (!id) return undefined

  const fetched = await client().send(new BatchGetBuildsCommand({ ids: [id] }))
  const build = fetched.builds?.[0]
  if (!build) return undefined

  return {
    id,
    state: toState(build.buildStatus),
    rawStatus: build.buildStatus ?? 'UNKNOWN',
    startedAt: build.startTime,
    endedAt: build.endTime,
    commit: build.resolvedSourceVersion,
    phase: build.currentPhase,
    logsUrl: build.logs?.deepLink,
  }
}

/**
 * 公開手続きを起動する。
 *
 * 完了は待たない。編集アプリケーションの応答には 30 秒の上限があり、ビルドは
 * それより長くかかる。始めたことだけを返し、進み具合は状況の画面で見る。
 */
export async function startPublish(config: EditorConfig): Promise<void> {
  await client().send(
    new StartBuildCommand({
      projectName: config.publishProjectName,

      // production の確認は起動口の側で取る（design.md 決定7）。ここまで来た
      // ということは画面で確認を経ている。それを scripts/deploy.sh に伝える。
      //
      // **これは多層防御であって権限境界ではない。** StartBuild の権限を持つ
      // 主体はこの変数も渡せる。効いているのは「その権限を持つのが編集
      // アプリケーションと管理者だけ」であることのほうで、この変数が塞ぐのは
      // 「コンソールから素で起動してしまった」程度の事故である。
      environmentVariablesOverride:
        config.environment === 'production'
          ? [{ name: 'DIARY_DEPLOY_CONFIRMED', value: 'yes', type: 'PLAINTEXT' }]
          : undefined,
    }),
  )
}
