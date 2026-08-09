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

# 実行時に要る依存を、**生成物が実際に参照しているものから決める。**
#
# ルートの dependencies をそのまま入れると、Astro のビルドにしか要らないもの
# （esbuild など）まで Lambda に運ぶことになる。Astro は自身のランタイムを
# 生成物に取り込むので、必要なのは取り込まれずに残った参照だけである。
#
# 版は手元の node_modules に入っているものを厳密に指定する。範囲で書くと、
# ここで動かして確かめたものと配るものが別になりうる。
echo "実行時の依存を洗い出しています..."
DEPS="$(node -e '
const fs = require("node:fs")
const path = require("node:path")

const files = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (p.endsWith(".mjs") || p.endsWith(".js")) files.push(p)
  }
})("editor/dist/server")

const pattern =
  /(?:^|[\s;{}(,])(?:import|export)[\s\S]{0,200}?from\s*["\x27]([^"\x27]+)["\x27]|import\s*\(\s*["\x27]([^"\x27]+)["\x27]\s*\)|require\(\s*["\x27]([^"\x27]+)["\x27]\s*\)/g

const names = new Set()
for (const file of files) {
  const source = fs.readFileSync(file, "utf8")
  let m
  while ((m = pattern.exec(source))) {
    const spec = m[1] || m[2] || m[3]
    if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue
    const parts = spec.split("/")
    names.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0])
  }
}

const out = []
for (const name of [...names].sort()) {
  const manifest = `node_modules/${name}/package.json`
  if (!fs.existsSync(manifest)) {
    console.error(`error: ${name} が node_modules にありません。npm ci を実行してください。`)
    process.exit(1)
  }
  out.push(`${name}@${JSON.parse(fs.readFileSync(manifest, "utf8")).version}`)
}
console.log(out.join(" "))
')"

echo "  $(tr ' ' '\n' <<< "$DEPS" | wc -l) 個: $DEPS"

echo "実行時の依存を linux/arm64 向けに入れています..."
# --ignore-scripts を付けているのは、他のプラットフォーム向けに入れているため。
# postinstall は手元の環境を前提に動く（esbuild の版検査など）ので、走らせると
# 落ちる。ここで入れるものはいずれも純粋な JavaScript で、postinstall に
# 依存しない。
# shellcheck disable=SC2086
npm install \
  --prefix "$BUILD_DIR" \
  --os=linux --cpu=arm64 --libc=glibc \
  --omit=dev --ignore-scripts --no-audit --no-fund --silent \
  $DEPS

SIZE_KB="$(du -sk "$BUILD_DIR" | cut -f1)"
printf '配布物: %s (%s MB)\n' "$BUILD_DIR" "$(awk -v k="$SIZE_KB" 'BEGIN { printf "%.1f", k / 1024 }')"
