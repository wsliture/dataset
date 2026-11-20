# 历史案例标注平台前端

使用 Node.js 24 和 npm。按 [平台启动说明](../README.md) 启动 PostgreSQL、BGE-M3 和 Fastify，再在本目录运行 `npm ci` 和 `npm run dev`。开发时 Vite 转发 `/api`，生产构建由 Fastify 同源提供。

页面从 `/api/v1` 读取和写入文档、案例与检索结果。聊天会话在路由切换时保留，刷新页面会清空会话。

`npm test` 验证 HTTP 契约和页面辅助函数，`npm run build` 执行类型检查并生成 `dist/`。页面行为见 [前端开发规格](../docs/frontend.md)。
