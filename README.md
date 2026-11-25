# 历史案例标注平台

## 本地启动

在本目录启动 Docker Compose。首次运行会拉取镜像、在容器内安装锁定的依赖并下载 BGE-M3，API 会自动执行数据库迁移。

```powershell
docker compose up --build -d
docker compose logs -f api web embedding
```

打开 [http://localhost:8081](http://localhost:8081)。Web 和 API 自动监听源码改动。修改依赖锁文件后重启对应容器，修改 Compose 环境配置后重新执行 `docker compose up -d`。

```powershell
docker compose restart api web
```

文档保存在 `api/storage/`，数据库与模型缓存保存在原有 Docker 卷。模型文件已缓存时，可在启动前设置 `DATASET_HF_OFFLINE=1`。若已有生效的模型地址指向宿主机的 `127.0.0.1:57997`，请在「模型设置」改为 `http://embedding:7997/v1/embeddings`，测试后保存。

## ARM64 离线部署

在联网且支持构建 ARM64 镜像的机器上，使用 Windows PowerShell 5.1 或 PowerShell 7，从本目录执行：

```powershell
.\scripts\build-arm64-offline.ps1
```

将生成的 `release/dataset-arm64-offline.tar.gz` 传到目标机，解压并按 [离线部署说明](offline/README-OFFLINE.md) 安装或升级。离线 Web 入口为 `http://服务器IP:8090`。应用通过「模型设置」连接内网已有的 Embedding 服务。

已有交付包时，用 `-OutputDirectory release/dataset-arm64-offline-8090` 指定新输出目录。已下载的 ARM64 Compose 二进制会从 `release/download-cache` 复用。

## 配置与数据

| 变量 | 默认值或用途 |
| --- | --- |
| `DATABASE_URL` | 必填。数据库连接字符串 |
| `DOCUMENT_ROOT` | `api/storage/`，保存原始文档和结构 JSON |
| `WEB_ROOT` | `web/dist/`，Fastify 提供同源静态文件及 SPA 路由 |
| `HOST`、`PORT` | `127.0.0.1`、`4190` |
| `UPLOAD_LIMIT`、`DOCX_EXPANDED_LIMIT` | 25 MiB、250 MiB，按字节配置 |
| `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL` | `http://127.0.0.1:57997/v1`、`BAAI/bge-m3` |
| `EMBEDDING_API_KEY` | 可选，首次保存前使用的服务端密钥 |
| `EMBEDDING_DIMENSION`、`EMBEDDING_BATCH_SIZE`、`EMBEDDING_TIMEOUT_MS` | `1024`、`8`、`30000` |
| `SEARCH_MIN_COSINE`、`SEARCH_CANDIDATES` | `0.55`、`100`，初始值，按代表性查询评估调整 |

在「模型设置」填写 API 容器可访问的完整 OpenAI Embeddings URL。BGE-M3 测试连接成功时应返回 1024 维。配置随 PostgreSQL 持久化，保存后可触发已发布案例的索引重建。任何能访问站点的人都能设置 API 可访问的模型地址。

本地维护时，`docker compose exec api npm run reindex` 使用当前生效的配置重建索引。重建失败时旧索引仍可使用。

## 验证

```powershell
npm --prefix web test
npm --prefix api run typecheck
$env:DATASET_TEST_DATABASE_URL = 'postgres://dataset:dataset-local@127.0.0.1:55439/dataset'
npm --prefix api test
```

数据库集成测试创建并清理自己的测试数据，使用专用数据库可以避免已有案例影响检索断言。异常用例使用受控模型响应。运行真实模型、浏览器和小型检索基线时，先构建 Web，启动 Compose 模型，再设置 `DATASET_TEST_REAL_MODEL=1`。可用 `DATASET_BROWSER_CHANNEL=msedge` 选择已安装的 Edge，或在 `api/` 用 `npx playwright install chromium` 安装测试浏览器。

业务细节见 [后端开发规格](docs/backend.md)，本地真实模型结果见 [首轮检索基线](docs/retrieval-baseline.md)。DOCX 解析迁自后端规格指定的 Phase 2 提交，运行时随本项目独立安装。
