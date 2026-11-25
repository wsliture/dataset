#!/bin/sh
set -eu
cd "$(dirname "$0")"

case "$(uname -m)" in
  aarch64|arm64) ;;
  *) echo "此离线包需要 ARM64 Linux。" >&2; exit 1 ;;
esac

sha256sum -c SHA256SUMS
chmod +x bin/docker-compose ./*.sh
bin/docker-compose version
docker info >/dev/null
docker load -i dataset-arm64-images.tar
if [ ! -f .env ]; then
  (umask 077; cp .env.example .env)
fi
echo "安装完成。设置 .env 中的 POSTGRES_PASSWORD 后，执行 sh start.sh。"
