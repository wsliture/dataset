#!/bin/sh
set -eu
cd "$(dirname "$0")"
./compose.sh ps
echo 'Web 入口为 http://服务器IP:8090'
