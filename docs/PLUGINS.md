# 插件与创作包

本批交付本地插件注册、语义版本/依赖、可发现的资源贡献、独立 worker 中的类型化 Agent 工具、动态 MCP 目录及桌面管理。软件仍不接入模型。主题与模板已经抽出为 `src/plugins/design.ts`，既有工具名/工程格式/候选与撤销行为保持兼容；其他内置工具已标明模块归属，运行入口仍部分由宿主分发，完整内置拆分继续推进。

## 注册和依赖

工程可选 `plugins` 数组记录 `{source,enabled,hash?,contentHash?}`；无此字段的旧工程正常打开。清单及代码/资源放在 components 下，进入固定工程快照、文件同步、事务与历史。清单 kind=vmotion-plugin、apiVersion=1，声明稳定 id/name/version、语义版本 dependencies、TypeScript entry、tools、contributions 与可选 `files:[{path,hash}]`。版本与 range 使用标准 semver；缺失/禁用/不兼容依赖、环、重复 ID、未来 API、错误路径、资源缺失或声明文件哈希不匹配会阻止候选。`vmotion.*` 内置 ID 保留。

`plugins_plan` 支持 hash 检查的 files、register/toggle/remove actions 和 component placements。pin=true 固定直接内容闭包的 `contentHash`；旧 `hash` 仍兼容只固定清单的工程。内容闭包包含清单、entry、贡献 source 和显式 `files`，复杂 TypeScript import 应将依赖列入 files。更新时可在 toggle 中明确重新 pin 或解除 pin。默认源码允许修改，工具调用和导出使用工程固定版本。无网络下载/依赖安装；项目已有第三方包遵循现有组件编译规则。

contributions 支持 component/effectGraph/motion/theme/sound/sceneTemplate，分别使用原有 TS 或 JSON 格式。组件可以由 plugins_plan 直接放置，其他贡献通过其匹配的现有工具编辑/应用，查询返回确切 source。普通组件与资源引用独立于库开关，禁用只撤下工具/可发现库；移除注册保留文件，不丢弃已创作的画面。删除文件需要明确 files delete，并走正常引用与可用性检查。

## 工具 SDK

```ts
import {definePlugin, definePluginTool, node} from '@vmotion/sdk';
export default definePlugin({name:'标题包',tools:{
  title: definePluginTool({
    parameters: {text:{type:'string',default:'标题'}},
    run(ctx,p) {
      return {
        operations:[{type:'addNode',sceneId:'intro',
          node:node({id:'title',type:'text',text:p.text,width:800})}],
        samples:[{sceneId:'intro',frame:0}],summary:{id:'title'}
      };
    }
  })
}});
```

清单 tools 的 id/parameters 要与导出相符；manifest 将 description/mode/categories/keywords/reads 保留为无需执行代码的发现元数据。参数复用 SDK 的数字、字符串、颜色、布尔、枚举、向量、数组和对象定义/默认值/约束。保存/预检会类型检查，并加载启用的工具以确认参数定义相同。保留字段 revision、expectedPluginHash、_context 不得用作业务参数。

ctx 默认只含工程尺寸/时基/名称/版本及空场景、序列、素材、文件集合；_context 显式选择 sceneIds/sequenceIds/files，须在清单 reads 中声明。reads.assets=true 才提供素材列表。最大 16 场景、8 序列、64 文件，总序列化上下文最多 8MiB，超预算报错而非暗中截断。

query 返回任意 JSON 数据，最大 256KiB；作者应分页/过滤。plan 返回 operations/files/assetChecks/samples/summary，函数使用相同输入求值两次，变化则拒绝。候选结果最大 8MiB，summary 最大16KiB；默认磁盘 planId，不重复传图层数组/源码。统一 project_preflight 检查类型、引用、素材证据、实际图片与确定性，project_apply 原样提交，一次撤销。供应的资产检查保存在候选，实际可用性仍由原服务验证。两次求值是错误证据检查，不是任意代码确定性的数学证明。

复用 ComponentHost 的编译依赖/SDK 指纹缓存、独立 worker、5 秒调用超时、128MiB JS 堆限制，组件与插件总共最多 12 个模块 worker。源码/import 改动失效，插件/普通组件使用不同缓存键。堆限制不等于整机 RAM；本地 TS 作为用户信任的代码执行，Node API 没有安全沙箱限制。受支持的创作协议返回候选，宿主不向函数传服务写句柄；这不阻止自定义代码使用文件系统。

超时或 worker 退出会淘汰死亡模块；并发重试复用一个新编译，旧 worker 的退出事件不会删除新实例。真实故障流程用无限循环触发5秒超时，随后同源码正常输入恢复，工程版保持不变。源码候选修改还会推导场景入/中/末帧，最多12实际样本并报告coverage；可通过显式samples审阅其它范围。

## MCP、CLI 和桌面

插件工具名为 `plugin.<id>.<tool>`。默认仍只有 10 个 MCP 入口；tools_search 可按 pluginId 查询，tool_schema 支持分支/ifHash，tool_call 执行隐藏能力，tools_load 仅加载本连接需要的工具。`plugins_package` 只返回分页文件元数据、字节数和 hash，不把源码重复放进上下文；选定范围使用 project_file_read。清单变化按 catalogHash 条件刷新，禁用/升级/撤销即时影响发现；tools/list 自身也刷新，支持外部有效文件修改。一次目录变化合并为一次 list_changed。命名管道连接打开的桌面服务时同样走此流程。

```text
vmotion plugins-inspect --project . --request inspect.json
vmotion plugins-plan --project . --request plan.json
vmotion tools-search --project . --plugin example.creative
vmotion tool-schema --project . --name plugin.example.creative.compose --paths title,accent
vmotion tool-call --project . --name plugin.example.creative.compose --request arguments.json
```

不指定 --project 的 tools-search/tool-schema 仍查询内置接口。桌面“插件”面板按需加载，支持本地路径注册、贡献来源、启用/禁用/移除和共享撤销。核心/工具 Schema、SDK 声明及新工程 AGENTS.md 同步。

`examples/plugin-lab` 包含实际组件、主题、效果图和两个工具；6秒720p30示例由插件生成，保持可编辑参数和普通关键帧。作者脚本必须显式 --rebuild，--render-only 保留编辑；便携包包含源码资源。`check-plugins.mjs --packaged` 使用真实外部 stdio MCP，覆盖注册、短目录/候选、图片、类型/旧hash/上下文拒绝、升级、禁用后像素保持、撤销、60帧MP4和连接当前服务的CLI。

尚未交付原生像素/声音处理 ABI、自定义 UI 运行时、插件市场/安装、依赖自动打包和所有内置功能的完整模块迁移。当前插件协议可扩展代码组件、资源与 Agent 工作流；后续在同一注册/版本/候选模型上继续扩展。
