#!/usr/bin/env bash
#
# 編集アプリケーションの配布物を作る。
#
#   scripts/build-editor.sh
#
# 出力は editor/build/。lambroll deploy --src がこれを固める。
# 通常は scripts/deploy-editor.sh から呼ばれる。
#
# 配置は Astro の node アダプタの前提に従う。**server/ と client/ を兄弟に
# 置き、サーバの入口が server/ という名前のディレクトリに居ること**が要る。
# アダプタは配信物の場所を、ビルド時の絶対パスからではなく、この2つの相対関係と
# 実行時の import.meta.url から解決する（node_modules/@astrojs/node の
# resolveClientDir）。潰すと配信物が見つからなくなる。

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BUILD_DIR="editor/build"

# 前回の残りを持ち越さない。配布物に古いファイルが紛れると、直したはずの挙動が
# 戻ったように見える。
rm -rf "$BUILD_DIR" editor/dist

echo "Astro をビルドしています..."
npx astro build --config editor/astro.config.ts

mkdir -p "$BUILD_DIR"
cp -R editor/dist/server editor/dist/client "$BUILD_DIR/"

# handler が指す起動スクリプト。実行権が要る。
install -m 0755 editor/run.sh "$BUILD_DIR/run.sh"

# ESM として読ませるために type: module が要る。ここは生成物なのでコミットしない。
cat > "$BUILD_DIR/package.json" <<'EOF'
{
  "name": "apkas-diary-editor-bundle",
  "private": true,
  "type": "module"
}
EOF

# 実行時の依存。**版はルートの package.json を唯一の出どころにする。**
# ここに版を書くと、直す場所が2つになる。
#
# 生成物が実際に参照しているものだけを選んで入れる形も試したが、**やめた。**
# Astro の生成物は素の import 文だけでは辿れない参照を持っており（`es-module-lexer`
# がそれで漏れた）、足りないことに気づくのが Lambda 上での起動失敗になる。
# 数十 MB を惜しんで、配ってから落ちる形を選ぶ理由がない。
DEPS="$(node -p "
  const deps = require('./package.json').dependencies
  Object.entries(deps).map(([name, range]) => name + '@' + range).join(' ')
")"

echo "実行時の依存を linux/arm64 向けに入れています..."
# --ignore-scripts を付けているのは、他のプラットフォーム向けに入れているため。
# postinstall は手元の環境を前提に動く（esbuild は入っている binary の版を
# 検査して落ちる）。ここで入れるものは実行時に postinstall の結果を必要としない。
# shellcheck disable=SC2086
npm install \
  --prefix "$BUILD_DIR" \
  --os=linux --cpu=arm64 --libc=glibc \
  --omit=dev --ignore-scripts --no-audit --no-fund --silent \
  $DEPS

# sharp を落とす。
#
# `astro` の依存として入ってくるが、読むのは既定の画像サービスだけである。
# editor/astro.config.ts でそれを noop に差し替えてあるので、生成物のどこにも
# sharp への参照が無い（ビルド結果を検索して確認できる）。**この 27MB は
# 実行時にただ置かれているだけ**で、直接アップロードの上限（zip 50MB）に対する
# 余裕を食っている。
#
# 依存を減らすのは一度失敗している（下の起動確認の注記を参照）ので、落とすのは
# 「設定から参照が無いと言い切れるもの」に限る。
rm -rf "$BUILD_DIR/node_modules/sharp" "$BUILD_DIR/node_modules/@img"

if grep -rqF "'sharp'" "$BUILD_DIR/server" 2>/dev/null; then
  echo "error: 生成物が sharp を参照しています。画像サービスの設定を確認してください。" >&2
  exit 1
fi

# **Markdown プロセッサは native binding を持つ。**
#
# satteri は実行環境ごとの binding を optionalDependencies として持ち、
# `--os` / `--cpu` の指定に従って1つだけ入る。入っていないとプレビューだけが
# 実行時に落ちる（起動はする。読み込みが renderMarkdown の中まで遅れるため）。
# 下の起動確認では捕まらないので、在ることをここで確かめる。
#
# 手元が linux/x64 でも入るのは arm64 版である。そちらが正しい。手元で配布物を
# 動かして本文の整形まで試したいときは、この環境向けの binding を足すこと。
BINDING="$BUILD_DIR/node_modules/@bruits/satteri-linux-arm64-gnu"
if [[ ! -d "$BINDING" ]]; then
  echo "error: Markdown プロセッサの binding がありません: $BINDING" >&2
  echo "       これが無いとプレビューだけが実行時に落ちます。" >&2
  echo "       satteri の optionalDependencies の名前が変わった可能性があります。" >&2
  exit 1
fi

# **配布物だけで起動できることを、リポジトリの外で確かめる。**
#
# この確認が要るのは、配布物をリポジトリの中で動かすと Node がひとつ上の
# node_modules まで見にいってしまい、配布物に入れ忘れた依存が手元では拾えて
# しまうためである。実際にそれで `es-module-lexer` の入れ忘れを見逃し、
# Lambda 上での起動失敗として初めて気づいた。
echo "配布物だけで起動できるか確かめています..."
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHECK_DIR"' EXIT
cp -R "$BUILD_DIR/." "$CHECK_DIR/"

CHECK_LOG="$CHECK_DIR/../editor-startup.log"
(
  cd "$CHECK_DIR"
  # 設定は読ませない。ここで見たいのは「モジュールが揃っていて listen するか」
  # だけで、SSM や DynamoDB に届くかどうかではない。
  HOST=127.0.0.1 PORT=45321 node ./server/entry.mjs > "$CHECK_LOG" 2>&1
) &
CHECK_PID=$!

STARTED=0
for _ in $(seq 1 50); do
  if ! kill -0 "$CHECK_PID" 2>/dev/null; then break; fi
  if curl -sf -o /dev/null -m 1 "http://127.0.0.1:45321/login" 2>/dev/null ||
     curl -s -o /dev/null -m 1 "http://127.0.0.1:45321/login" 2>/dev/null; then
    STARTED=1
    break
  fi
  sleep 0.2
done

kill "$CHECK_PID" 2>/dev/null || true
wait "$CHECK_PID" 2>/dev/null || true

if [[ "$STARTED" -ne 1 ]]; then
  echo "error: 配布物だけでは起動できませんでした。" >&2
  echo "       実行時の依存が足りていない可能性があります。" >&2
  echo "--- 起動時の出力 ---" >&2
  cat "$CHECK_LOG" >&2
  exit 1
fi
echo "  起動を確認しました。"

SIZE_KB="$(du -sk "$BUILD_DIR" | cut -f1)"
printf '配布物: %s (%s MB)\n' "$BUILD_DIR" "$(awk -v k="$SIZE_KB" 'BEGIN { printf "%.1f", k / 1024 }')"
