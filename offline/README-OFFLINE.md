# dataset ARM64 离线部署

目标机需要 ARM64 Linux 和 Docker Engine。交付包内置 Docker Compose v2.39.2。将交付包解压到部署目录并执行：

```sh
sh install.sh
# 编辑 .env，设置 POSTGRES_PASSWORD
./start.sh
```

浏览器打开 `http://服务器IP:8090`。在「模型设置」输入 API 容器可达的完整 Embeddings URL、模型名和可选密钥，测试成功后保存。BGE-M3 通常返回 1024 维。服务在模型配置前即可启动和导入 DOCX。

```sh
./status.sh
./logs.sh api
./logs.sh web
./logs.sh postgres
./stop.sh
```

数据库和 DOCX 分别保存在项目的 `dataset-db` 和 `documents` Docker 卷中。停机或重建容器时保留卷。初次启动后修改 `.env` 不会改变 PostgreSQL 中的已有密码。

## 原地升级

保持旧部署的 PostgreSQL 运行，将新版完整包解压到独立目录。从新版目录执行：

```sh
sh upgrade.sh /现有/dataset部署目录
```

脚本兼容原先没有包内 Compose 的部署。它会暂停旧 Web 和 API，备份数据库和文档卷，再将新版文件放入旧部署目录并启动服务。旧 `.env`、项目名和两个数据卷继续沿用。升级完成后，在旧部署目录运行 `./status.sh`，并访问 8090 验证案例、文档和模型设置。

## 升级失败与恢复

按脚本报告的备份路径检查 `deployment/`、`dataset.dump`、`documents.tar.gz` 和 `previous-images.txt`。用 `sha256sum -c BACKUP-SHA256SUMS` 验证数据备份。先使用 `./status.sh` 和 `./logs.sh api` 检查当前应用和迁移状态。若需完整回退，停止当前服务并保留当前卷，将备份恢复到独立的数据库和文档卷进行核验。旧部署文件位于 `deployment/`，旧镜像已用 `dataset-backup-<服务名>` 标签保留。恢复旧镜像前先核查数据库迁移兼容性。
