# Agent 按需工具发现

默认 `vmotion mcp --project ...` 使用 compact 模式，只暴露 10 个常用入口：agent_guide、project_context、project_file_read、project_preflight、project_apply、frame_capture，以及 tools_search、tool_schema、tool_call、tools_load。84 项实际创作能力全部仍可使用。完整模式 `--tools all` 返回 88 个直接工具和发现入口，兼容原有直接调用与结果形状。

初始 tools/list 不必携带所有剪辑、绘画、矩阵、声音和结构操作的 Schema。加入平面特效接口后的实际测量 compact 目录约 13.6KB，完整目录约 217.2KB；这是协议 JSON 字节数，不是模型 token 计数，随接口版本变化。

建议从 project_context 定位工程，agent_guide 确定工作流，再按以下方式操作：

```json
{"name":"tools_search","arguments":{"query":"深度","category":"3d","limit":5}}
{"name":"tool_schema","arguments":{"name":"scene3d_render"}}
{"name":"tool_call","arguments":{
  "name":"scene3d_render",
  "arguments":{"source":{"sceneId":"intro","nodeId":"world","frame":90},"width":640}
}}
```

tools_search 返回名称、摘要、类别、参数字段和读写提示，不返回完整输入 Schema。搜索支持英文名称/描述和中文词，offset/limit 分页；明确工具名称匹配优先，专用词优先于大类标签。可用类别为 core、animation、effects、composition、vector、drawing、media、editing、audio、3d、math、render、recovery，类别允许交叉。

tool_schema 返回选定能力的完整 inputSchema、语义与调用方式。tool_call 验证同一输入 Schema，调用相同工程服务与历史记录；可调用未出现在 tools/list 的能力。返回 structuredContent 与兼容文本，画面/声音作为原生 MCP media blocks 返回，不把 base64 混进结构化诊断。

需要连续使用某类直接工具时加载：

```json
{"name":"tools_load","arguments":{"categories":["animation","composition"],"mode":"add"}}
{"name":"tools_load","arguments":{"names":["matrix3d","scene3d_render"],"mode":"replace"}}
{"name":"tools_load","arguments":{"mode":"replace"}}
```

add 保留已有可选工具；replace 先恢复六个基本创作工具再加载指定项。四个发现入口始终可用。每次实际变化只发送一次 tools/list_changed；重复加载相同集合不发送额外通知。工具加载只影响本次 MCP 连接，另一 agent 与桌面会话不受影响，工程和撤销记录不改变。未知名称使整次加载失败，不部分加载。不能刷新工具列表的客户端直接使用 tool_call，无需动态加载。

compact 模式下的写操作默认只返回 revision、选区、诊断、冲突与撤销状态，保留创建对象/素材/片段等专用结果。画稿修改返回图层 ID 和笔迹数量，完整笔迹用 drawing_get 获取。素材导入明确返回 importedAsset；PSD/OpenRaster 返回 importedArtwork 的素材 ID。project_inspect 是显式全量读取，仍可通过 tool_call 调用。需要原结果时使用 `tool_call` 的 response=full；`--tools all` 的直接工具保留原有结果形状。

错误提供 code、原诊断/参数路径和对应恢复建议。REVISION_CONFLICT 重新读 context；FILE_HASH_CONFLICT 重新读文件；ASSET_CHANGED 重新取证素材；参数错误先读 tool_schema。工具路由不会绕过 revision、文件 hash、素材证据、轨道锁、冲突和原子事务。

存储候选支持 `{planId}`，自动读取内容校验的缓存操作；mesh_generate/mesh_import 默认使用该方式，参见 MESHES.md。FILE_WRITE 提供文件、系统错误和尝试数；Windows 短暂占用在有界退避后重试，持久失败应解决实际存储问题并重新读取 context。

桌面已打开时，新工程服务在命名管道返回前就压缩 agent 结果，避免把整个源码快照来回传输。连接探测使用精简 ping；旧服务缺少新接口时保留已有桥接兼容。CLI 也使用同一工具定义与调用规则：

```powershell
node dist/cli/index.mjs tools-search --query 深度 --category 3d
node dist/cli/index.mjs tool-schema --name scene3d_render
node dist/cli/index.mjs tool-call --project my-project --name sequence_edit --request edit.json
node dist/cli/index.mjs tool-call --project my-project --name project_inspect --full
node dist/cli/index.mjs mcp --project my-project --tools all
```

CLI 的 request 文件为具体能力的参数对象，不含外层 name/arguments。默认媒体返回文件路径，--inline 额外输出 media 数据。readonly/destructive/idempotent 提示用于 agent 识别能力性质，不是权限或批准机制；调用能力仍取决于工具参数与工程实际状态。软件本身不接入模型。
