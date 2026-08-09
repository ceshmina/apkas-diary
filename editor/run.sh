#!/bin/bash
#
# Lambda での起動。関数の handler がこのファイルを指している。
#
# Lambda Web Adapter（レイヤー）が AWS_LAMBDA_EXEC_WRAPPER 経由でこれを実行し、
# 立ち上がった HTTP サーバへ Lambda の呼び出しを橋渡しする。手元で動かすときは
# `npm run dev:editor` を使うので、このファイルは通らない。

set -euo pipefail

# サーバが listen する先。Web Adapter が同じ値を見て待ち受ける。
export HOST=127.0.0.1
export PORT="${AWS_LWA_PORT:-8080}"

exec node ./server/entry.mjs
