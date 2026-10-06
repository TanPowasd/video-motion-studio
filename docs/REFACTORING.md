# 类型与模块边界

重构保持 formatVersion=1、RPC 字符串名称和原生画面语义。MCP 结果投影保留同级字段、数组索引与版本字段；字段投影不会修改原结果。

工具定义声明完整 categories、keywords、annotations。内置注册表拒绝缺失元数据，Discovery 直接消费定义，不再维护工具名分类、关键词或权限补充表。类别词汇仅用于搜索别名。旧项目插件继续使用原有 Schema 默认值，诊断 PLUGIN_METADATA_DEFAULTS 提醒作者补齐声明，不修改源码。

hash、json、safePath、atomicWrite 位于 platform/project-files；service/project 的兼容转出保留，core 和 media 的通用文件操作直接依赖 platform。原子写仍保留 Windows 文件占用重试、原文件和错误诊断，事务 journal/history 留在工程服务。

运行 npm run typecheck、npm test、npm run build；MCP 发布前使用 node scripts/check-mcp-budget.mjs --packaged 核验真实 stdio、错误请求、准确候选、撤销和传输字节。
