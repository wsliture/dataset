
# 历史案例标注平台前端

使用 Node.js 24 和 npm。在本目录执行：

```powershell
npm install
npm run dev
```

打开终端显示的本地地址。首次启动加载 CNAS 风格的模拟数据。从「案例检索」发送 `SJA1000`，可查看关联测试需求和出处。数据集、文档和案例修改保存在当前浏览器的本地存储中。聊天会话在路由切换时保留，刷新页面会清空会话。

文档管理可选择非空的 `.docx` 文件，模拟导入会生成预置切片。源资料和测试需求使用不同的样例内容。所有请求由浏览器内的模拟客户端处理。前端接口与页面约定见[开发规格](../docs/frontend.md)。

## 检查和预览构建

```powershell
npm test
npm run build
npm run preview
```

`npm run build` 先运行 TypeScript 类型检查，再生成 `dist/`。部署到其他静态服务器时配置 SPA 回退，将前端子路由交由 `index.html` 处理。
