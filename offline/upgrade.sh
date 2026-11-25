#!/bin/sh
set -eu
umask 077
source_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
compose="$source_dir/bin/docker-compose"
config=docker-compose.offline-arm64.yml
files="$config compose.sh install.sh logs.sh start.sh status.sh stop.sh upgrade.sh README-OFFLINE.md"

fail() { echo "错误：$*" >&2; exit 1; }
[ "$#" -eq 1 ] || fail "用法：sh upgrade.sh /现有/dataset部署目录"
target=$(CDPATH= cd -- "$1" && pwd) || fail "旧部署目录不存在"
[ "$source_dir" != "$target" ] || fail "请将新版离线包解压到独立目录"
case "$(uname -m)" in
  aarch64|arm64) ;;
  *) fail "此离线包需要 ARM64 Linux" ;;
esac
docker info >/dev/null
for file in $files bin/docker-compose dataset-arm64-images.tar SHA256SUMS; do
  [ -f "$source_dir/$file" ] || fail "新版离线包缺少 $file"
done
(cd "$source_dir" && sha256sum -c SHA256SUMS)
chmod +x "$compose"
[ -f "$target/.env" ] && [ -f "$target/$config" ] || fail "旧部署缺少 .env 或 $config"
old_compose() {
  "$compose" --project-directory "$target" --env-file "$target/.env" -f "$target/$config" "$@"
}
old_compose config --quiet
"$compose" --project-directory "$target" --env-file "$target/.env" -f "$source_dir/$config" config --quiet

lock="$target/.dataset-upgrade.lock"
mkdir "$lock" || fail "已有升级在运行：$lock"
backup=
stopping=0
finish() {
  result=$?
  if [ "$result" -ne 0 ] && [ "$stopping" -eq 1 ]; then
    echo "升级未完成，服务可能处于停止或部分启动状态。备份目录：$backup" >&2
    echo "请参照新版包 README-OFFLINE.md 的「升级失败与恢复」检查和恢复部署。" >&2
  fi
  rmdir "$lock"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

postgres=$(old_compose ps -q postgres)
api=$(old_compose ps -a -q api)
web=$(old_compose ps -a -q web)
[ -n "$postgres" ] && [ -n "$api" ] && [ -n "$web" ] || fail "请先启动完整的旧部署"
project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$postgres")
db_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$postgres")
documents_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/documents"}}{{.Name}}{{end}}{{end}}' "$api")
[ -n "$project" ] && [ "$db_volume" = "${project}_dataset-db" ] &&
  [ "$documents_volume" = "${project}_documents" ] || fail "旧部署的数据卷与标准编排不匹配"
docker volume inspect "$db_volume" "$documents_volume" >/dev/null

backup=$(mktemp -d "$(dirname "$target")/dataset-backup.XXXXXXXX")
mkdir "$backup/deployment"
for file in $files .env bin/docker-compose; do
  if [ -f "$target/$file" ]; then
    mkdir -p "$backup/deployment/$(dirname "$file")"
    cp -p "$target/$file" "$backup/deployment/$file"
  fi
done
postgres_image=$(docker inspect --format '{{.Image}}' "$postgres")
for service in postgres api web; do
  case "$service" in postgres) id=$postgres ;; api) id=$api ;; web) id=$web ;; esac
  image=$(docker inspect --format '{{.Image}}' "$id")
  printf '%s %s\n' "$service" "$image"
  docker image tag "$image" "dataset-backup-$service:${backup##*.}"
done > "$backup/previous-images.txt"

docker load -i "$source_dir/dataset-arm64-images.tar"
stopping=1
old_compose stop web api
old_compose exec -T postgres pg_dump -U dataset -d dataset -Fc > "$backup/dataset.dump"
[ -s "$backup/dataset.dump" ] || fail "PostgreSQL 备份为空"
old_compose exec -T postgres pg_restore -l < "$backup/dataset.dump" >/dev/null
docker run --rm --pull never --platform linux/arm64 --entrypoint tar \
  --mount "type=volume,source=$documents_volume,target=/documents,readonly" \
  "$postgres_image" -czf - -C /documents . > "$backup/documents.tar.gz"
[ -s "$backup/documents.tar.gz" ] || fail "文档卷备份为空"
(cd "$backup" && sha256sum dataset.dump documents.tar.gz > BACKUP-SHA256SUMS)

mkdir -p "$target/bin"
for file in $files bin/docker-compose; do
  temporary="$target/$file.upgrade.$$"
  cp "$source_dir/$file" "$temporary"
  case "$file" in *.sh|bin/docker-compose) chmod 755 "$temporary" ;; esac
  mv -f "$temporary" "$target/$file"
done
"$target/start.sh"
stopping=0
echo "升级完成。升级前备份：$backup"
