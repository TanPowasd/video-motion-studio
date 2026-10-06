# 类型与模块边界

重构保持 formatVersion=1、RPC 字符串名称和原生画面语义。MCP 结果投影保留同级字段、数组索引与版本字段；字段投影不会修改原结果。

工具定义声明完整 categories、keywords、annotations。内置注册表拒绝缺失元数据，Discovery 直接消费定义，不再维护工具名分类、关键词或权限补充表。类别词汇仅用于搜索别名。旧项目插件继续使用原有 Schema 默认值，诊断 PLUGIN_METADATA_DEFAULTS 提醒作者补齐声明，不修改源码。

hash、json、safePath、atomicWrite 位于 platform/project-files；service/project 的兼容转出保留，core 和 media 的通用文件操作直接依赖 platform。原子写仍保留 Windows 文件占用重试、原文件和错误诊断，事务 journal/history 留在工程服务。

运行 npm run typecheck、npm test、npm run build；MCP 发布前使用 node scripts/check-mcp-budget.mjs --packaged 核验真实 stdio、错误请求、准确候选、撤销和传输字节。

## RPC 与编辑器状态

内置方法各自声明 defineRpcHandler(Schema, handler)，RpcMethodMap 从处理器推导输入/输出。Application.dispatch 保留字符串动态入口，未知方法和项目插件结果是 unknown；已知方法返回具体结果，dispatchTyped/rpcTyped 收紧内部入参。内置 dispatch 也使用 unknown 并在方法边界解析，MCP 的公开 Schema 和响应形状保持兼容。多分支返回和可选数据由调用方显式判断，不默认断言存在。

编辑器入口只处理首页/工作区路由。reducer/store 管理 project、route、selection、preview、panels、code、drawing、assets、tasks、diagnostics；effects/controller 执行 RPC、SSE、媒体请求和草稿保存。useSyncExternalStore 按 selector 订阅，reducer 保留未修改切片引用。控制器命令使用稳定身份和当前闭包，素材/属性面板用 memo 防止不相关状态刷新触发渲染；画布、时间轴和现有 inspector 的交互与工程写入仍沿用共享事务。工作区销毁会关闭订阅、取消预览并释放 ImageBitmap。
