# 历史案例标注平台

## 本地启动

需要 Node.js 24、npm 和 Docker Compose。在本目录启动 PostgreSQL/pgvector 和 CPU 版 Infinity。首次运行会拉取容器并下载 BGE-M3，下载后的模型与数据库均存储在 Docker 卷中。

```powershell
docker compose up -d
docker compose logs -f embedding
```

模型文件已缓存时，可在启动 Compose 前设置 `DATASET_HF_OFFLINE=1`，让 Infinity 从卷内加载固定版本。

在模型已就绪后执行以下命令，启动同源 Web 和 API。应用默认监听本机，下面的数据库连接仅用于 Compose 开发环境。

```powershell
npm --prefix web ci
npm --prefix web run build
npm --prefix api ci
$env:DATABASE_URL = 'postgres://dataset:dataset-local@127.0.0.1:55439/dataset'
npm --prefix api run migrate
npm --prefix api run build
npm --prefix api start
```

打开 [http://127.0.0.1:4190](http://127.0.0.1:4190)。首次进入时数据库为空，可创建数据集，再导入两侧 DOCX 并标注。开发 Web 时分别执行 `npm --prefix api run dev` 和 `npm --prefix web run dev`。Vite 默认将 `/api` 代理到本机 4190 端口，使用 `DATASET_API_ORIGIN` 可覆盖目标。

## 配置与数据

| 变量 | 默认值或用途 |
| --- | --- |
| `DATABASE_URL` | 必填。数据库连接字符串 |
| `DOCUMENT_ROOT` | `api/storage/`，保存原始文档和结构 JSON |
| `WEB_ROOT` | `web/dist/`，Fastify 提供同源静态文件及 SPA 路由 |
| `HOST`、`PORT` | `127.0.0.1`、`4190` |
| `UPLOAD_LIMIT`、`DOCX_EXPANDED_LIMIT` | 25 MiB、250 MiB，按字节配置 |
| `EMBEDDING_BASE_URL`、`EMBEDDING_MODEL` | `http://127.0.0.1:57997/v1`、`BAAI/bge-m3` |
| `EMBEDDING_API_KEY` | 可选，留在服务端 |
| `EMBEDDING_DIMENSION`、`EMBEDDING_BATCH_SIZE`、`EMBEDDING_TIMEOUT_MS` | `1024`、`8`、`30000` |
| `SEARCH_MIN_COSINE`、`SEARCH_CANDIDATES` | `0.55`、`100`，初始值，按代表性查询评估调整 |

部署时将数据库和文档目录分别挂载到持久存储。切换模型或维度时，停止 API，使用新模型配置运行 `npm --prefix api run reindex`。重建脚本生成待替换向量，复核候选及文本版本后在一个事务内切换。失败时旧索引仍可使用，使用原模型配置恢复 API。

## 验证

```powershell
npm --prefix web test
npm --prefix api run typecheck
$env:DATASET_TEST_DATABASE_URL = 'postgres://dataset:dataset-local@127.0.0.1:55439/dataset'
npm --prefix api test
```

数据库集成测试创建并清理自己的测试数据，使用专用数据库可以避免已有案例影响检索断言。异常用例使用受控模型响应。运行真实模型、浏览器和小型检索基线时，先构建 Web，启动 Compose 模型，再设置 `DATASET_TEST_REAL_MODEL=1`。可用 `DATASET_BROWSER_CHANNEL=msedge` 选择已安装的 Edge，或在 `api/` 用 `npx playwright install chromium` 安装测试浏览器。

业务细节见 [后端开发规格](docs/backend.md)，本地真实模型结果见 [首轮检索基线](docs/retrieval-baseline.md)。DOCX 解析迁自后端规格指定的 Phase 2 提交，运行时随本项目独立安装。
