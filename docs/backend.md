# 历史案例标注平台后端开发规格

## 1. 交付范围

在 `dataset/api/` 建立独立 npm 项目，使用 Node.js 24、TypeScript ESM、Fastify 和 `pg`。服务负责 DOCX 导入、切片编辑、案例发布与撤回、筛选和导出，以及通过 PostgreSQL/pgvector 和内网 BGE-M3 执行混合检索。部署时与 Web 同源，前端静态资源支持 SPA 路由回退，`/api/` 下的请求始终走 API 路由及其错误处理。Phase 2 后续通过只读检索接口接入。组织级权限和自动生成测试需求留待后续版本。

业务范围见 [PRD](prd.md)，解析和检索依据 [技术规格](tech.md)，单文档删除、表格行和导出依据 [前端规格](frontend.md)。接口与 [DatasetClient](../web/src/client.ts) 对齐。当前 [前端入口](../web/src/main.tsx) 直接实例化模拟客户端，联调时实现 HTTP 适配器，生产入口使用同源 API，开发与测试可显式启用模拟客户端。当前页面在会话内保存聊天记录，并在数据集删除后清除已展示和在途响应中的对应结果。

## 2. HTTP 契约

路径均相对 `/api/v1`，下表的 `D` 表示 `/datasets/:datasetId`。资源 ID 为 UUID，响应时间戳采用 UTC ISO 8601，版本为正整数。资源按完整路径作用域查找。JSON 字段使用驼峰。

| 方法与路径 | 输入 | 成功响应 | 客户端及页面 |
| --- | --- | --- | --- |
| GET /datasets | 无 | 200，`DatasetSummary[]` | `listDatasets`，首页 |
| POST /datasets | `{ name, note? }` | 201，`Dataset` | `saveDataset`，首页新建 |
| GET D | 无 | 200，`Dataset` | `getDataset`，数据集布局 |
| PATCH D | `{ name, note? }` | 200，`Dataset` | `saveDataset`，首页编辑 |
| DELETE D | 无 | 204 | `deleteDataset`，首页删除 |
| GET D/documents | 无 | 200，`Doc[]` | `listDocuments`，文档管理与标注工作台 |
| POST D/documents | multipart 单文件，`type` 和 `file` | 201，解析后的 `Doc` | `importDocument`，文档上传 |
| GET D/documents/:documentId | 无 | 200，`Doc` | 独立文档详情，当前预览使用列表中的 `Doc` |
| DELETE D/documents/:documentId | 无 | 204 | `deleteDocument`，文档管理 |
| PATCH D/documents/:documentId/slices/:sliceId | `{ text, version }` | 200，刷新后的完整 `Doc` | `updateSlice`，文档预览 |
| GET D/cases | 筛选和分页参数 | 200，`{ items: CaseDetail[], total: number }` | `listCases`，案例列表 |
| POST D/cases | `CaseInput` | 201，`CaseDetail` | `saveCase`，工作台新建 |
| GET D/cases/:caseId | 无 | 200，`CaseDetail` | `getCase`，工作台和案例详情 |
| PATCH D/cases/:caseId | `CaseInput & { version }` | 200，`CaseDetail` | `saveCase`，工作台编辑 |
| POST D/cases/:caseId/publish | `{ version }` | 200，`CaseDetail` | `publishCase`，工作台确认 |
| POST D/cases/:caseId/withdraw | `{ version }` | 200，`CaseDetail` | `withdrawCase`，案例列表停用 |
| GET D/cases/export | 列表筛选参数 | 200，UTF-8 JSONL 正文 | `exportCases`，案例列表下载 |
| POST /search | `{ query, limit? }` | 200，`{ results: SearchResult[] }` | `search`，聊天页与未来 Phase 2 调用方 |

### 响应字段与筛选

- `Dataset` 返回 `id, name, note, status, updatedAt`。名称去除首尾空白后必填，备注省略时保存空字符串。`DatasetSummary` 另含 `documents: { source, test_requirement }`、`cases: { draft, published, withdrawn }` 及 `searchable`，各计数始终为数字。`searchable` 使用第 5 节的案例资格，归档计为 0。列表按 `updatedAt` 降序、`id` 升序。首页名称筛选由前端执行。
- `Doc` 返回 `id, name, datasetId, type, slices, warnings, importedAt`。`type` 为 `source` 或 `test_requirement`，`warnings` 为字符串数组。切片对象包含 `Excerpt` 字段及 `kind, version`，行切片另返回 `parentSliceId` 和从 1 开始的 `rowOrder`。列表和详情均按原文块顺序返回切片，行紧随整表并按行顺序排列。`Excerpt` 包含 `sliceId, text, documentId, documentName, sectionPath, sourceRef`，其中 `sectionPath` 为标题数组，`sourceRef` 为可展示定位。
- `CaseInput` 包含字符串 `title, testObject, interfaceType, scenario, keywords, conditions, note`，以及字符串数组 `categories, sourceSliceIds, testRequirementSliceIds`。草稿可使用空字符串和空数组。标题和测试对象去除首尾空白，类别使用前端枚举的原始值。详情返回上述全部字段以及 `id, datasetId, version, status, updatedAt, sourceSlices, testRequirementSlices, valid`。摘录保留各侧选区顺序。`valid` 表示满足发布内容和引用校验，独立于生命周期状态。
- `status` 和 `category` 分别精确匹配状态和数组成员。`q` 在标题及当前双侧切片正文做字面子串匹配，`testObject, interfaceType, scenario` 在对应字段做字面子串匹配。子串双方统一 NFKC、去首尾空白并转小写。空筛选视为省略，不同筛选条件取交集。`updatedSince` 接收含时区的 ISO 时间，下界包含该时刻。分页参数为正整数，默认 `page=1`、`pageSize=20`，每页最多 100 条，超出返回 400。列表按案例更新时间降序、ID 升序，`total` 为分页前数量，计数和列表使用同一快照。
- 导出注册为静态路径，忽略 `page` 和 `pageSize`。使用与列表一致的筛选和排序，另外要求数据集使用中、案例已发布且 `valid`。每行是同一读取快照中的 `CaseDetail`，把 `id` 改为 `caseId` 并增加 `schemaVersion: 1`，末尾换行。用 `application/x-ndjson; charset=utf-8` 返回，空结果返回 200 和空正文。HTTP 适配器以文本读取，由页面处理空结果和下载。
- `SearchResult` 返回 `datasetId, datasetName, caseId, caseTitle, matchedSourceSlices, testRequirementSlices`。双侧数组使用 `Excerpt`，响应顺序由服务端确定。

### 错误与上传交互

统一返回 `{ code, message }`，其中 `message` 可直接展示，避免暴露内部路径、模型响应和数据库细节。HTTP 适配器将非成功响应映射为 `ClientError(status, code, message)`。

| HTTP | 错误码 | 触发条件 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 参数、字段、发布条件、切片引用或直接修改派生整表无效 |
| 400 | `DOCX_PARSE_FAILED`、`DOCX_EMPTY` | 文件损坏、无法解析或无可用文本 |
| 404 | `NOT_FOUND` | 数据集不存在，或指定作用域下找不到资源 |
| 409 | `VERSION_CONFLICT` | 版本、派生整表或索引准备所依赖的状态已变化 |
| 409 | `DATASET_ARCHIVED`、`INVALID_CASE_STATE`、`DOCUMENT_NAME_CONFLICT` | 修改归档内容、案例状态转换不允许、同侧存在同名文档 |
| 409 | `DOCUMENT_REFERENCED` | 当前或历史案例引用该文档，另返回 `blockingCases: [{ id, title }]`，同一案例只出现一次，消息含可展示标题 |
| 413 | `DOCX_TOO_LARGE` | 上传或实际解压总大小超限 |
| 503 | `EMBEDDING_UNAVAILABLE` | 模型不可达、超时或响应不符合向量契约 |
| 500 | `INTERNAL_ERROR` | 其他未处理失败，由请求标识关联服务端日志 |

每个上传请求处理一个文件，`type` 与 `file` 可按任意顺序出现。HTTP 适配器发送真实 `File`。需要展示解析阶段时，通过上传完成事件调用 `onParsing`，最终成功以 201 响应为准。客户端多文件导入仍按单文件分别跟踪和重试。

## 3. DOCX 解析与文件生命周期

- 迁移基线为主仓库提交 `fd9afc212a6666bd12a1b6f203965e602db441dc` 的 [Phase 2 解析说明](../../docs/phase2-parsing.md) 和 `src/tools/` 下的 `docx-heading-numbering.ts`、`docx-heading-resolver.ts`、`filldata-parser.ts`、`document-structure-artifact.ts`。复制 DOCX 链路及其 ZIP、XML、表格依赖，移植 `tests/tools/` 下相应的标题解析、结构产物与 DOCX 分段用例。Node.js ESM 通过 `createRequire` 加载 Mammoth 的 CommonJS 内部模块，锁定通过迁移测试的版本。
- 恢复自动编号，保留中文标题、附录、显式编号优先以及目录和列表抑制。按顶层正文块原始顺序建立章节和切片，使用修正后的章节 ID。标题前正文和无标题正文均进入前置章节。普通段落逐段切片，明确条款正文合为 `clause`，表格原位生成 `table` 和子级 `table_row`。行文本保留列标题与单元格的对应关系，行级出处可区分原表和具体行。整表文本按行顺序以换行拼接。解析告警随 `Doc` 返回，有可用切片即可继续标注。
- 应用为每个文档分配 UUID，持久目录内保存原始 DOCX 和 `document-structure.json`。结构保存 `sections, warnings` 和技术规格约定的章节字段。切片编辑写入数据库。以路径安全的用户文件名作为显示名称，同数据集同类型下按 NFKC、去首尾空白并转小写判定重名，通过数据库唯一约束处理并发。
- 将请求流写入持久卷上的临时目录，校验 DOCX 包结构、上传大小和实际解压累计大小。默认上传上限 25 MiB、解压上限 250 MiB，均可配置。成功解析后在数据库事务中锁定并复核数据集，登记文档与切片，将产物目录在同一文件系统内重命名到最终位置后提交。已确认回滚时清理暂存和最终产物。提交结果不明确时先以文档 ID 核实提交结果，保留仍可能被已提交记录引用的产物。
- 删除文档或数据集时，在业务删除事务中写入文件清理任务，提交后异步按存储键清理。任务可重复执行，目标已消失视为成功。启动及定期回收已过宽限期的无主目录。回收与导入使用同一文档级存储锁，并在删除前复核数据库文档引用，覆盖进程中断和提交结果未知的情况。

## 4. 数据模型与写事务

| 实体 | 字段及约束 |
| --- | --- |
| `datasets` | UUID、名称、备注、状态 `active / archived`、更新时间。新建为 `active` |
| `documents` | UUID、数据集外键、类型、显示名及规范化名、存储键、解析告警、导入时间。数据集、类型及规范化名联合唯一 |
| `slices` | UUID、文档外键、章节 ID 和路径、原文顺序、出处、类型、父表 ID、行序、文本、版本。父表须在同文档中，行序在父表内唯一。源侧另存全文列、规范化标识、向量及对应文本版本和模型标识 |
| `cases` | UUID、数据集外键、表单字段、状态、版本、更新时间 |
| `case_slices` | 案例与切片外键、分栏与选区顺序。案例和切片联合唯一，分栏由文档类型复核 |
| `case_revisions`、`case_revision_slices` | 每次成功保存或状态变更记录该版本的字段、状态、时间与有序切片引用。案例和版本联合唯一，历史引用可按切片反向查询 |
| `file_cleanup_jobs` | 持久记录待清理存储键、尝试次数和下次执行时间，任务生命周期独立于已删除业务记录 |

案例与切片版本从 1 开始。每次成功写入递增相应版本和更新时间，数据集更新时间反映其内部写操作。所有写事务先锁定数据集并复核其存在和状态，再获取必要的案例、文档和切片锁。涉及多个切片时按 ID 顺序加锁。归档数据集允许查看和整集删除，内部写操作返回 409。

- **保存与状态转换**。新建或修改后状态为 `draft`，已确认和已停用案例修改后重新进入草稿。每次保存检查已选 ID 去重、同数据集、正确分栏和整表与所属行互斥。发布允许从草稿或已停用状态进入，要求非空标题、测试对象、至少一个类别和双侧有效引用。撤回仅允许 `published → withdrawn`。保存当前字段、关联、版本与历史使用同一事务。
- **发布**。先读取案例及所选源切片快照，并在事务外为缺少当前文本版本和当前模型向量的源切片生成向量。写事务复核期望案例版本、状态、引用和源切片版本，再一并提交索引、案例状态和历史。如果切片变化，返回版本冲突，避免发布基于旧文本的向量。
- **切片编辑**。去除首尾空白并拒绝空文本。有行的整表通过编辑行更新。先按当前快照计算新文本与派生整表，并为其中被有效已发布案例引用的源切片准备新向量。事务内复核被编辑切片和父表版本以及受影响切片的最新发布引用。如果新出现发布引用且缺少对应新向量，返回 409。原子更新行、父表、两者版本、全文和向量。未被已发布案例引用的源切片更新时清空其旧向量，测试需求侧只更新被引用的展示文本。模型失败时保留原有已提交状态。
- **删除**。单文档删除在锁内查询当前与历史引用，任何状态的案例均可构成阻塞。整集删除在单个事务内清除案例、历史、文档、切片及关联索引，同时登记文件清理任务。搜索资格从实时关联计算，撤回一个案例后，共享切片仍可服务其他有效已发布案例。删除事务提交后的新查询排除该数据集。

## 5. 混合检索

1. 对 `query` 去首尾空白后校验非空，`limit` 省略时为 5，显式值须为正整数。调用模型后，从同一个数据库读取快照生成候选和响应。案例须来自 `active` 数据集、状态为 `published` 且满足第 4 节发布校验。仅其关联的源切片参与匹配。首页可检索计数使用相同案例资格。
2. 关键词路使用相同版本的中文分词和标识规范化处理索引与查询，保留 NFKC 小写后的完整报文 ID、接口名和字段名，避免将完整标识拆分后当成精确命中。使用 PostgreSQL `simple` 生成 `tsvector`，通过 GIN 查询。完整标识匹配优先，其次按全文相关度降序，最后按切片 ID 升序。
3. 语义路以当前版本、当前模型的源侧向量计算精确余弦距离，应用最低余弦相似度门槛，距离升序、切片 ID 升序。两路先过滤再分别截取候选，候选上限按配置且至少覆盖请求条数。门槛和候选池大小通过人工标注查询集校准，首版使用精确搜索。
4. 按切片 ID 合并两路，单路贡献为 `1 / (60 + rank)`，排名从 1 起算，未召回贡献为 0。分数降序、切片 ID 升序。用每个案例最高的命中切片融合分数排序，同分按案例 ID 升序，合并重复案例后截取 `limit`。每个结果返回该案例所有入围的源切片，按融合排序排列，以及选区顺序下的全部测试需求切片。两路均无候选时返回 `{ results: [] }`。

模型调用配置地址下的 OpenAI 兼容 `POST /v1/embeddings`，地址配置含 `/v1` 时追加 `/embeddings`。请求含模型名和单条或批量文本。按返回 `index` 恢复顺序，校验索引完整且唯一、条数、维度、有限值及非零范数。BGE-M3 默认 1024 维，上线前使用内网实例验证。模型超时或响应无效返回 503。聊天页和外部调用使用同一检索实现，相同数据、模型、检索配置、查询和条数得到相同结果及顺序。

## 6. 部署与验收

- 提供依赖锁文件、构建和启动命令以及数据库迁移。迁移启用 `vector` 扩展并建立外键、引用查询、全文和候选过滤索引。独立持久化 PostgreSQL 和文档目录。配置数据库连接、文档目录、解析限额、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、可选 `EMBEDDING_API_KEY`、向量维度、模型超时及批大小、语义门槛和候选池上限。启动校验配置，日志记录请求标识、数据库、解析和模型失败类别及耗时。
- 模型或维度切换先以新配置重建可检索源切片向量，再切换查询。首版维护窗口内暂停涉及向量的写入和查询，校验新索引覆盖后恢复服务。切换前保留旧索引，以便重建失败时恢复旧配置。
- **导入与文件**。对照 Phase 2 验证真实双侧 DOCX 的标题编号、附录、目录、重复 ID、表格顺序、合并单元格和定位。覆盖无标题、告警、空内容、损坏、上传和解压超限、重名并发、重试、提交失败与崩溃后清理。
- **标注和导出**。两个源切片配对三个测试需求切片，分别查询两个源切片均返回该案例及全部三条摘录。覆盖空说明、草稿缺项、跨数据集和错误分栏、整表与行互斥、单文档当前和历史引用、版本冲突，以及跨页导出的内容、排序和空正文。
- **并发与失败**。覆盖发布与切片编辑交错、同表不同行并发、模型故障回滚、共享源切片的单案例撤回，以及数据集删除后新请求、当前与在途聊天结果的可见性。检查索引与当前文本版本一致。
- **联调与基线**。接入正式 HTTP 适配器，在 requirements-manager 和 matrix-embedded-agent 均未启动时完成导入、标注、发布、导出和查询。对照聊天页与直接 API 的结果及顺序，覆盖空输入、无匹配、模型超时、维度异常和恢复。以同一人工标注集比较关键词、语义和混合检索，覆盖同义改写、精确标识、接口描述、关键数值和单位差异及无匹配查询。记录前五条命中率、无匹配误返回率和代表性失败样例，首轮测评后确定 Phase 2 接入门槛。
