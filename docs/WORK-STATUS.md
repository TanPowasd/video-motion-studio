# 持续目标与当前状态

总目标仍为：质量优先的通用视频创作软件，向 After Effects 的创作能力扩展，通过自有项目格式、TypeScript、CLI 与 MCP 供外部 agent 操作。软件本身不接入模型。该目标尚未完成。

当前优先级：广度、高性能、易优化，同时质量、自由度和外部 agent 工具链优先。用户要求自主选择相关功能批次、统一测试与 Git 提交，不因最近提到音频而持续只深化声音子系统。后续批次平衡通用视觉/视频能力、实测性能和MCP上下文成本。

当前工程/恢复/缓存/画面检查批次：剩余26个公开工具迁入core14、recovery3、cache3、review4及animation guide/effects LUT2；新增project_diagnostics使core为15。十七内置模块126能力统一Map分发，宿主只保留基础桥接和旧非公开drawingStroke，服务/媒体/任务生命周期继续归宿主；缓存活动请求、渲染、媒体与跟踪保护保持。项目worker插件不获得这些工程写句柄，只接收查询上下文并返回候选。124个旧工具方法/输入Schema保持，project_schema唯一扩展到全部35种权威资源，不改工程格式。

诊断默认20条/最高100，section选择诊断/冲突/待修复文件，files/codes/severities筛选，summary保留全量计数，coverage/nextOffset报告遗漏。默认消息240字符并标记截断；detail才返回完整选定消息、冲突双方或待修复页的hash/bytes，不复制全部源文件。查询不重读磁盘、不编译或写历史，过期revision/无效过滤拒绝；仍遍历现有证据，响应缩小不等于百万错误实时认证。多帧截图现在转发contextFrames，冻帧组件的祖先参数时钟与frame_capture一致。

真实MCP注入缺失123素材时发现：修复文件还原活动revision后，事务保存了文件但未清除pending/旧诊断。现相同revision也接受已验证状态，不增加撤销记录；只有待修复或诊断变化才通知，普通无变化事务不触发界面更新。新增回归覆盖恢复原版本/精确候选拒绝/一次撤销与重做、诊断分页/完整内容/冲突版本/只读错误及所有资源Schema。

该批验证：首次完整73文件421项通过；补恢复原版本修复后的完整复跑421项通过、1项新用例失败。原因用例把首次序列JSON字段顺序规范化误当成字节不变事务，改为完全相同的hash文件写入；最终诊断/服务两文件18项全部通过，其余72文件保持通过。真实MCP脚本另因测试组件缺少显式params.value被ANIMATION_TARGET正确拒绝，补充数值后验证了实际祖先时钟截图，没有放宽产品验证。最终类型/SDK声明/构建和便携完成；本批Rust未修改。

最终便携工程诊断/并发冲突保留双方/错误过滤/原版本修复/准确候选拒绝/undo-redo/嵌套图片/直接加载与CLI通过（artifacts/project-diagnostics-SfUbtl）：123错误精简3097对完整16153字节，约-80.8%；仍明确summary与遗漏，度量为JSON UTF8字节而非模型token。十七模块全部hostTools=0；通用130工具/126能力、3D/OBJ/材质/平面/剪辑音视频Agent通过（artifacts/agent-tools-OqyLJR）。默认10入口13729字节、诊断Schema1613/缓存129字节；refs/hash/短写/原生媒体不重复保持（artifacts/mcp-budget-FQcKR3），CLI全流程与退出码通过（artifacts/agent-cli-DTJlbq）。

最终便携画面audit→稳定ID修复→准确提交→PNG与导出一致/60帧MP4/一次撤销通过（artifacts/agent-review-svlD1j）。代理/重链接/缓存实际回收及源码/历史/检查点保护通过（artifacts/media-cache-4llxXU）；参考素材screen预览解码921600→230400像素，热均值3.831→1.925ms，只是该本机小场景，模块迁移没有被宣称为GPU或全片加速。插件内容缓存20次newContentDigests=0、超时worker恢复、pin/unpin/准确undo、60帧视频通过（artifacts/plugins-0KzDef）。

同一真实Electron隐藏窗口52项首页/新建/十七模块与翻页/插件注册、主题模板/跟踪/文字矢量/音乐/绘画/代理缓存组合通过（artifacts/desktop-projects-5hy08y），插件与媒体面板和修复后contact画面已检查。主UI包486.74kB保持，指南/SDK/可编辑示例说明同步；源码与文档阶段本地Git提交，不push，产物/缓存不入库。第三方原生像素/声音/UI ABI、插件安装打包、GPU、FFmpeg内置、4K/两小时正式验收仍未完成，整体目标active。后续继续通用视觉/视频、实测渲染性能和Agent批量取证，避免单系统深钻。

当前素材/绘画/合成/跟踪批次：29旧工具迁入统一注册表（media8，drawing7，composition10，tracking4），共用host state/transact/select、诊断、素材导入/缩略图和同一proxies/tracking任务资源。releaseMedia由宿主检查活动预览/音频/代理/跟踪/导出后释放reader，生命周期不分叉。绘画edit/publish服务缩小为snapshot/transact依赖；普通资源、生成覆盖、结构批量、共享场景、选区/源码/撤销保持原语义。新vmotion.tracking依赖media；注册表现13模块99工具：drawing8/8、composition10/10、tracking4/4完整module，media12/15仍mixed（缓存3项宿主），animation11/12mixed、effects12/17mixed。

新增assets_query与drawing_query，不改变123旧工具Schema/方法逐项比对结果。素材默认24摘要按IDs/类型/关键词/managed筛选，省略路径/metadata，detail明确全记录；counts是全注册类型统计，total筛选后，不自动探测文件。画稿默认24层/16笔迹，IDs与两个列表独立分页，pointCount/原外观/锁定位置保留；includePoints才返回指定pointOffset/pointLimit页和原压感。get/frame完整接口不变，错误ID/过期revision不会部分成功或写历史。仍解析整张画稿和遍历全部结构，响应小不等于百万点实时认证或自动文件可用性证明。

18项新查询/注册发现回归及23项完整客户端/共享场景/结构/插件回归通过。完整72文件416项回归、类型/SDK声明/构建全部通过；本批Rust未改、工程格式未迁移。当前便携真实MCP完整绘画素材与生成组件流程通过（artifacts/library-JmmHnC），素材3152对完整217440字节、画稿2794对219003字节，两者约-98.6/98.7%；点页与原压感一致，原生图片不重复JSON，选层发布/放置/重新编辑、generated源码保留/一次undo、原子structure batch、直接加载/打开服务CLI、60帧MP4通过。字节是JSON UTF8，不是模型token估算。

当前便携媒体代理/重链接/PNG/60帧导出通过（artifacts/media-cache-4uyXgj），1280源screen预览decode pixels921600→230400，与原生导出分辨率无关，不归因于模块迁移；稀疏跟踪24帧/稳定/失跟/取消/CLI/候选/undo通过（artifacts/tracking-tmCJNl）。通用129工具/125能力、原生3D/网格/材质/平面/剪辑音视频Agent通过（artifacts/agent-tools-dqSGnD），默认10入口13729字节保持；Schema refs/hash/新素材与笔迹查询122/123字节缓存/媒体不重复通过（artifacts/mcp-budget-bNtYLF）；外部插件/pin/超时/精确候选/视频通过（artifacts/plugins-GRAoV6），CLI短写/全量读取/PNG/退出码通过（artifacts/agent-cli-9d4Aw2）。

同一Electron隐藏窗口51项全工作流通过（artifacts/desktop-projects-REFCQm）：首页/新建/注册/迁移显示/主题模板/跟踪分析与标注/稳定候选/文字形状/音乐试听发布入轨/绘画拖拽选层发布与再编辑/代理auto预览/缓存保护与撤销。组合验收先发现脚本假定声音前无素材和代理使用第一个video，现比对试听前后manifest字节、按源路径resolve与preview.mkv行选择实际代理；没有放宽产品阈值/隐藏错误。面板、取证和成片画面已目视检查。主bundle486.74kB保持，指南/Schema/SDK说明同步；阶段本地Git提交、不push，产物/缓存不入库。剩余核心/cache/视觉检查模块、第三方像素/声音/UI ABI、GPU/4K/长片正式验收继续未完成，总目标active。

当前3D/矢量/属性批次：21旧工具迁入注册表：三维5（网格create/OBJ/inspect、材质plan、原生color/depth/object取证），vector6（graphics query/plan、SVG、bake、repeat query/create），animation10（drivers query/plan/curve、keys query/edit、time query/edit、参数query/edit/describe）。共用host.edit/transact/select和builtinCandidate，保持generated覆盖、hideSources、源码和共享撤销；已删除21个旧宿主分支。注册表现十模块68工具（新component_query1），vector/3D完整module；animation11/16、effects12/17与media3/13仍mixed。

新增component_query：默认16参数/32通道、paths选嵌套相对参数、两组分页/完整总数/nextOffset，array/object/string有界预览，includeSchema/fullValues显式读选定大数据。默认不构造全参数Schema/通道列表；仍解析和求值全部参数，value来源标记theme-and-keyframes，最终driver/pixel需其它证据，旧component_parameters保持完整字段/1000通道上限。默认值从实际metadata默认树取得，向量轴及object default覆盖正确。参数spec/索引/过期revision拒绝不改工程，页可超过第1000通道。

修复plugin ID第二段必须字母导致vmotion.3d无法通过plugins_inspect/依赖声明：允许数字起始分段，首段仍字母且vmotion.*保留。既有122工具逐项Schema/方法对比，只有plugins_inspect/package/plan的共享ID正则明确扩展，其余119不变；新增component_query。默认MCP10入口保持13729字节。最终便携外部MCP验证大数组/晚页、key/default、生成owner覆盖/一次undo/源码不变、模板端口、loaded直调/打开服务CLI、原生图片及60帧视频通过（artifacts/parameter-query-7192iq）：精简2122对完整57729字节（-96.3%），Schema2090/缓存125字节；字节非模型token估计。

本批验收：71文件414项完整回归通过，末尾组件/模板metadata可跳过不需要的Schema构建（模板逐帧apply也跳过），四文件25项复测和当前便携参数/模板流程再通过（artifacts/design-dCH8Ii、parameter-query-7192iq），缓存基线像素相同。类型/SDK声明/构建通过；Rust未修改，无新工程迁移。十模块共68插件注册工具，总目录127/123能力；通用真实便携3D/OBJ/材质/效果/剪辑音视频通过（artifacts/agent-tools-gQfsBl），矢量/文字原生/生成层候选与几何缓存/PNG/60帧MP4/一次撤销通过（artifacts/graphics-UPH5gw），表达式/布局/曲路径/跨场景/源码/120帧/原子undo通过（artifacts/drivers-batch-DSytDG）。

同一Electron窗口41项首页/新建、音频/剪辑/渲染/3D/vector模块迁移显示、主题模板、文字形状检查器、音乐试听发布和绘画流程通过（artifacts/desktop-projects-J0hdB9）；对应画面已检查。MCP refs/hash/短响应/媒体不重复及新component_query125字节缓存通过（artifacts/mcp-budget-ElL0j1），外部插件/pin/超时/候选导出通过（artifacts/plugins-g5ThA9），CLI全链通过（artifacts/agent-cli-LiiuaA）。主包486.74kB保持，指南/Schema/SDK例子同步。阶段源码/可编辑例子说明/检查脚本本地Git提交，不push，视频/缓存/release/artifacts不入库；剩余模块、第三方像素/声音/UI ABI、GPU/4K/长片正式验收继续未完成，总目标active。

当前特效/剪辑/渲染批次：19个旧工具迁入注册表（effects新增effect/graph/visual/motion候选、粒子query/plan与转场7项；editing为分镜/序列计划/直接剪辑/字幕/整片audit7项；render为性能/start/list/status/cancel5项），移除对应宿主分支。BuiltinPluginHost通过共享transact/renders/exportState接口保留版本锁、错误工程阻止导出、任务取消和checkpoint生命周期。builtinCandidate共用stored/inline交付，保留业务元数据、contextFrames、采样、visual/determinism与固定expectedCandidateRevision；不改原算法或任意源码。迁移前121个工具输入Schema/方法逐一对比全部相同。

新增render_query：默认20条精简任务，ids/statuses/任务revision筛选、nextOffset/队列counts、detail=true完整输出/错误；hasError提示读render_status，旧render_list保持完整数组。内置能力现122/126工具，默认10入口不变；注册表7模块46工具，其中effects12/19仍mixed、media3/13mixed，editing7/7和render6/6完整module。查询只限制响应，渲染历史Map长期回收/持久化仍待深化。

21项相关测试通过；新增共享候选stored/inline同payload、不可替换计划、待修复工程阻止导出、100任务分页/筛选/完整错误取回回归。最终70文件410项完整回归、类型/SDK声明/构建通过。本批Rust未改，不改变原算法或工程格式，总目标active。

真实当前便携MCP效果图（artifacts/effect-graphs-Rgmqmh）与跨场景动作（artifacts/agent-motion-Ex4VXp）保持生成覆盖/源码/PNG/候选/120或60帧MP4/原子撤销；分镜代码+声音+章节/全片证据/120帧有声导出通过（artifacts/storyboard-batch-QDyedc），任务query357字节/原列表兼容/取消及转场+混音+性能像素对照通过（artifacts/workstation-batch-nUFAtJ）。缓存池像素保持相同；本次温均值4.68/3.94ms，未把代码迁移宣称为帧率加速。query与统计字节是JSON UTF8，不是模型token估计。

同一真实Electron窗口34项首页/创建/完整音频、剪辑与渲染模块显示/插件注册历史、主题模板、音乐试听发布与绘画工作流通过（artifacts/desktop-projects-vJAI5D），面板与成片抽样已目视检查。通用126工具/122能力及矩阵/深度/材质/平面/音视频Agent回归通过（artifacts/agent-tools-7VJzK0），默认10入口13729字节；Schema/短结果/媒体不重复通过（artifacts/mcp-budget-4Imf9n）；外部插件内容缓存/版本/准确候选/超时/pin/60帧导出通过（artifacts/plugins-BWKi5v），CLI短写/全量读取/退出码通过（artifacts/agent-cli-R4vgJM）。最终源码/Schema/指南/可编辑例子说明和当前便携包同步，工作阶段本地Git提交、不push；缓存/视频/release/artifacts不入源码。其余模块、第三方像素/声音/UI ABI、GPU、FFmpeg内置、4K/长片正式验收继续未完成。

当前批次：五个内置模块26工具已进入唯一工具/方法/版本/依赖验证注册表，以Map统一Application分发/MCP目录，清理22个旧宿主分支及重复媒体分发。声音的12个工具完整迁移（library/inspect/plan/preview/MIDI、timeline/preview/waveform/analyze、mix inspect/plan/audit），复用同一候选、revision检查、素材证据、媒体任务保护与PCM管线。effects/media真实为5/19与3/13部分迁移，插件查询和面板明确moduleTools/hostTools；其它宿主模块继续迁移。对迁移前121接口逐个比对，120个输入Schema不变；audio_timeline唯一扩展默认24条分页/offset/limit/totalClips/nextOffset、includeAll显式全量，源裁切/速度/淡化与有理数采样保持。无新增工具数量/默认入口。

插件性能/可靠性：项目内容LRU128项/8MiB估算字节，实际源文本探针先判断变化，未改变内容不反复SHA/JSON解析；变更/缺失/声明hash校验保持。20次冷/无缓存对照contentDigests20→1，内容hash相同，不宣称渲染加速或整体RAM。发现旧toggle.pin=false保留contentHash导致不能解除保护，现同时去除manifest/content pin，默认动作保持两者，解除/文件编辑同候选、一次撤销恢复。注册表拒绝重复ID/工具/处理器、无处理方法、版本/依赖错误与环；片段分页测试覆盖静音排除/嵌套/小数源时钟/原包络和100条精确分页。17项相关回归通过。

开发版及当前便携真实MCP声音流程已通过（artifacts/sound-batch-j20gxp、artifacts/sound-batch-A6UdqW）：12工具归属、合成/采样/鼓组、候选试听/音频取证、随机访问PCM、MIDI、90帧带音视频/WAV、错误恢复、源码保持/原子撤销；101片段分页8890对全量36957字节（约-76%），声音量化误差最多1个16位单位。这是JSON UTF8字节，无模型token估算；分页只缩短响应，当前仍遍历音频结构，不宣称长片实时/全局内存认证。

本批验收完成：70文件407项完整回归通过，类型/SDK声明/构建/便携同步。实际便携插件注册/源码hash/精确候选/视频/超时并发恢复/pin→解除→撤销通过（artifacts/plugins-PTXcD8），20次请求newContentDigests=0、缓存12384字节/8MiB；mix/转场/候选PCM/LUFS/120帧有声视频/一次撤销通过（artifacts/workstation-batch-WPFKtX）。同一Electron窗口33项首页/新建/插件迁移显示/注册/保存/撤销、主题模板、音乐试听入轨及绘画发布再编辑通过（artifacts/desktop-projects-PqipbK），截图和画面已目视检查。

通用125工具/121能力Agent回归通过（artifacts/agent-tools-HW0HZR），默认10入口13729字节；Schema refs/hash/短回复/媒体不重复通过（artifacts/mcp-budget-ilmdMD），便携CLI短写/完整读取/PNG/撤销/退出码通过（artifacts/agent-cli-MsP8KC）。主包486.74kB，插件面板lazy 3.16kB。本批Rust未改，工程格式未迁移；完整内置拆分、第三方像素/声音/UI ABI、GPU、4K/长片和FFmpeg内置继续未完成。源码/类型/可编辑例子说明和检查脚本本地Git提交，缓存/产物不入库、不push。总目标保持active。

用户要求各功能归入插件系统。已交付本地清单/注册/标准semver依赖、六种可发现资源、类型化worker工具与动态Agent接口，并抽出首个内置design模块。后续继续完整内置迁移与原生像素/声音/UI扩展ABI；完整插件平台尚未完成。

插件批次：project.plugins保持旧工程可选字段；清单/API/依赖/环/重复ID/路径/资源/固定清单hash均验证，toggle/remove批量候选可跨依赖原子处理，删除注册保留作者代码和普通引用。components/effectGraph/motion/theme/sound/sceneTemplate贡献使用原格式；组件可以直接放置，其他通过对应现有工具。definePlugin/definePluginTool在共享ComponentHost独立worker运行，按实际SDK/import依赖缓存，kind区分组件/插件、总12worker/128MiB JS堆/5秒调用、JSON预算，默认上下文空集合、显式读场景/序列/文件；query分页职责明确，plan两次输入一致性/素材检查/短stored候选/原生预检/准确提交一次撤销。pin是manifest，不宣称整个代码包固定或Node安全沙箱。源码/Schema/SDK/新工程指南、README和说明同步。

MCP增加plugins_inspect/plan，基础120能力/124全目录、默认仍10入口，项目工具按plugin.ID.tool发现。目录条件hash、Schema hash/分支（含_context）、直接加载、外部更新、禁用/升级/撤销刷新和一次合并list_changed。执行服务缓存动态Zod定义，目录比较改Map；无全目录反复注入。真实当前便携stdio完成注册/类型/未知参数/旧hash/未声明context拒绝、截图/准确预检提交、Schema版本更新、禁用后普通组件PNG字节不变、撤销恢复目录、60帧MP4、打开服务的CLI与partial接口（artifacts/plugins-Krkhv1）。启动目录13729字节、注册1169、计划771、查询291、Schema1738/缓存141、CLI分支1193，5次实际目录变化只5次通知；为UTF8字节，不是模型token估算。

完整回归69文件中396项通过、1项全模式MCP失败：原因动态目录将SDK空参数工具转换成Zod4 Mini，再交给Zod3转换器。修复后从权威定义生成空参数Schema；新增真实直接无参数工具未知字段检查，又发现SDK raw-shape先剥离未知字段，现保留字段后由共享invoke严格验证，返回TOOL_ARGUMENTS。最终MCP/discovery/plugins三文件14项复测全通过；末尾Context分支测试7项再通过，新增assetChecks候选保存/缺失证据拒绝覆盖。类型/SDK声明/构建通过；本批Rust未改。真实便携通用124工具3D/OBJ/材质/平面效果/剪辑音视频通过（artifacts/agent-tools-7NqK8Y）；refs/短回复/媒体不重复/CLI Schema缓存通过（artifacts/mcp-budget-2Pwm6Q）。

真实便携同窗口32项首页/新建/插件注册/源保留/禁用与一次撤销、模板端口/主题/版本、声音试听发布入轨和绘画拖拽/发布/再编辑全通过（artifacts/desktop-projects-k2oCbf）。插件面板按需加载3.03kB，原生管理截图已检查；版本库最初意外进入主包515.57kB，拆分registration与manifest后主入口回到486.69kB。examples/plugin-lab保持工程88679b6d，实际插件生成6秒720p30/180帧，五帧audit无提示，画面已目视检查；重建必须--rebuild，render-only保留编辑。包内包含可编辑代码/JSON资源。总体目标active，原生插件ABI、全部内置模块化、GPU/4K/长片与FFmpeg内置仍待完成。本批本地Git提交，不push，产物/缓存不入库。

末尾补真实无限循环故障注入发现共享ComponentHost超时后可能保留死worker缓存；现标记失败、跳过/清理死亡模块，并用Promise身份避免旧worker退出删除新模块。8项插件复测通过，覆盖5秒超时后同源码不同参数恢复、工程版不变、两次并发恢复只新编译一次；普通组件参数/性能两文件10项通过。最终同包真实MCP完整流程及无限循环→超时→两次并发恢复通过（artifacts/plugins-ZZ9V5M），7次目录变化合并7次通知；124工具3D/材质/平面/剪辑音视频回归再次通过（artifacts/agent-tools-fycdwC）。CLI便携精简修改/完整读取/图片/撤销/退出码通过（artifacts/agent-cli-1vBmyH）。最终构建/SDK/便携源码同步，本批本地Git提交，总目标继续active。

插件完整性与上下文优化追加：manifest 可声明 `files` 内容哈希，registration 可保存 contentHash；内容指纹覆盖 manifest、entry、贡献源和声明文件，入口源码变化会刷新 plugin Schema/目录hash，旧 expectedPluginHash 被拒绝。plugins_package/CLI plugins-package 提供分页 packageDigest、manifestHash/contentHash、依赖和文件大小/hash，默认不传源码；project_file_read 负责按范围取选定内容。query 工具返回 operations/files/assetChecks/samples 会报 PLUGIN_MODE，只有 plan 工具能返回候选。声明文件篡改在计划阶段阻止，旧 hash 仍兼容。

新增包索引、代码变化、声明文件 hash 和 query/plan 模式测试；插件 focused 11项通过。最终封装插件实测注册候选/代码 hash 变化/旧 hash 拒绝/包1194字节/Schema缓存141字节/10次目录通知/超时恢复/60帧视频/CLI分支通过（artifacts/plugins-KHi4Yu）。封装通用目录现125工具/121能力（artifacts/agent-tools-cObOFg）；MCP预算与原生媒体短响应继续通过（artifacts/mcp-budget-dKA6WT）。主 bundle 486.74kB，release 内容与源码/Schema/docs/examples/plugin-lab逐文件一致（183项）。

最终验证：69个测试文件、402项全回归通过；最终构建/封装/桌面32项综合（artifacts/desktop-projects-54T1FY）及插件包/MCP/Agent检查全部通过。未将输出视频、缓存、release或artifacts加入Git。本批只完成插件内容完整性、按需包索引和模式校验；完整原生插件ABI、市场安装、依赖自动打包、全部内置模块迁移、GPU与长片验收仍是后续工作，总目标保持active。

后续内置迁移已启动：`src/plugins/math.ts` 提供 vmotion.math 内置模块，统一注册 linear_algebra 与 matrix3d 的 Schema、MCP/CLI 调用和 Application 分发；原工具名、请求形状、数值证据和既有 3D/数学回归保持不变。插件面板将其标为 module，搜索/分类仍按 math 与 3d 路由。mcp-discovery 6项、MCP/插件12项复测通过；最终封装125工具/121能力、矩阵/线性代数/深度/材质/平面/音视频Agent回归通过（artifacts/agent-tools-0qGrTa），插件完整流程继续通过（artifacts/plugins-weq2nz），MCP预算短响应通过（artifacts/mcp-budget-79n3On）。

视觉模块迁移完成：`src/plugins/visual.ts` 抽出 effects_guide/effects_inspect/effect_graph_inspect/visual_templates/motion_templates，继续复用宿主 renderer/snapshot，只把查询分发和工具元数据模块化；effect/visual/motion 的 plan 工具仍走原候选流程。插件面板、搜索分类和 builtin runtime 显示 vmotion.effects=module。MCP/discovery/插件/完整客户端18项复测通过，工具总数与能力数不增加，Schema/CLI兼容保持。

媒体模块迁移完成：`src/plugins/media.ts` 抽出 media_status/media_inspect/media_sample，复用素材指纹、代理状态和原生帧证据；重链接、代理生成和导出仍由宿主计划流程保护。vmotion.media 在插件面板/Agent目录标记为 module。媒体与插件18项复测通过，完整封装验收待最终构建后补录。

媒体迁移最终封装：125工具/121能力、矩阵/深度/材质/平面/音视频Agent流程通过（artifacts/agent-tools-2I7y7u），插件完整性/超时/源码hash/包索引通过（artifacts/plugins-fpAgvC），MCP短Schema/媒体不重复通过（artifacts/mcp-budget-n5IwIJ）。本轮未改变工具数量和默认10入口，主包仍486.74kB。

主题/版本模板/Agent接口批次：已交付 typed 品牌Token、parent/alias循环和约束检查、实时原生/参数绑定、字面baseline/显式局部值、reset/detach/toggle；以及固定manifest/源场景/实际编译依赖代码版本、持久端口实例、三方默认值升级、参数/图层改名迁移和私有可编辑副本。生成层写owner覆盖，原作者源码保持。发布的素材、共享场景、SDK/外部包和live主题仍为项目依赖，动态共享代码需要明确allowSharedCode；不是任意代码独立打包。重叠端口拒绝，实例键/内部覆盖/主题链接迁移有错误保护。新增theme_inspect/plan、template_inspect/plan复用准确候选/画面预检/原样提交/一次撤销。

主题/模板解析LRU各128项、4/8MiB估算字节，按实际源文本/父级/依赖失效，只复制写入分支；resourceCache=false提供相同像素基线。真实便携MCP 18次采样中准备/解析各18→1、像素完全相同，单次热均值1.996→1.599ms，仅本机小场景。6秒720p示例均值4.14/3.80ms，没有每个场景都加速的结论。主UI入口505.87→486.13kB，绘画12.55kB/声音8.26kB改按需加载，构建不再报主包大小警告。

本批68文件390项完整回归通过；末尾重叠端口保护与Schema分支两文件14项针对复测通过，类型/SDK声明/构建通过。实际便携stdio MCP发布/主题/端口键/自定义覆盖/升级/冲突/私有副本/60帧MP4/随机检查/精确撤销和CLI通过（artifacts/design-2SlErp）。默认10入口14073字节、118能力/122全目录；发布/主题/升级计划1186/792/1308字节，Schema分支3474对完整compact95188字节（约-96.4%），顺序归一hash、非法path拒绝、缓存响应120/123/126字节。Schema refs/hash/短回复/原生媒体不重复通过（artifacts/mcp-budget-b8ikg5）；通用3D/OBJ/材质/平面效果/剪辑音视频通过（artifacts/agent-tools-I8ZrJt）；便携CLI创建/精简修改/完整读取/撤销/退出码通过（artifacts/agent-cli-AwR15j）。字节实测不是模型token估算。

真实便携桌面端口检查器、主题有效值、选择新版保持自定义标题、私有副本/一次撤销、lazy声音草稿试听/编辑发布/入轨通过（artifacts/desktop-projects-KMoVRN）；lazy绘画实际拖拽/笔迹保存/发布主素材库/视频入轨/再次编辑通过（artifacts/desktop-projects-3VLcjn）。设计/绘画截图已目视检查。examples/design-lab保持工程43d97036，6秒720p30/180帧成片，五帧audit零错误/提示，画面已目视检查；新建/重建守卫与render-only保留编辑，重建采用后续版本、旧版本不覆盖，指南用单个自动更新段落。工具目录/Schema/SDK参考/新工程agent指南和说明同步。整体插件系统、GPU、长片正式验收、完整媒体运行时与跨项目模板包仍未完成，总目标active。

收尾已核实隔离重建V1/V2→V3/V4，旧6个发布文件hash不变、指南只一段、audit零提示（artifacts/design-rebuild-check/rebuild-report.json），未重建用户已编辑示例。最终构建/SDK/封装完成后，实际同包MCP主题模板完整流程再通过（artifacts/design-nkqMmE）；18→1准备次数/像素一致保持，热均值1.828/1.741ms，说明缓存收益不能仅由小场景计时推断。Schema/媒体/短回复检查再通过（artifacts/mcp-budget-TNc1y1）。同一实际Electron窗口合并运行设计+声音+绘画28项验证全通过，并确认重新打开的画稿是保留笔迹的独立可编辑文档（artifacts/desktop-projects-gNU2Nv）。本批源码、Schema、文档和可编辑例子本地Git提交；产物/缓存不入Git、不push。总目标仍active。

电影/运动批次：原始视频稀疏点/自动角点/显式重设、金字塔LK/光度NCC/双向校验、置信/失跟、确定性鲁棒平移/相似/仿射、点/变换贴附、四点贴图、稳定/展开角度与log-scale平滑/明确zoom，已接可编辑tracking资源、独立worker背景队列/取消、SDK/CLI/MCP与桌面检查器。绑定按实际source时钟/floor帧、视频留边和目标parent/TRS换算，普通矩阵/角点键可编辑、来源TS保留、默认保护旧矩阵和拒绝失跟、显式hold计数与一次撤销。默认前后完整源摘要验证，元数据改变但摘要相同的素材复制可重绑定，候选固定当前metadata检查；portable=false显式仅使用size/mtime。并非相机解算、一般透视平面、光流、转描、GPU或长片完整验收。

视频RGBA解码改为直接写帧缓冲，一次复制完成装配，保留concat显式基线；源像素相同，计数覆盖JS装配而非FFmpeg/IPC所有内存。独立worker仅驻留前后金字塔/192MiB堆限制，分析1–3600帧/32点/1280维、队列4/完成记录32/文件16MiB，Buffer统计不等于整机RAM。全点拟合一致时跳过128子集尝试，平滑使用前缀和。随机跳帧不依赖历史状态缓存。

本批67文件382项完整回归通过，类型/SDK声明/构建/便携更新通过。验证涵盖亚像素/旋转、低纹理/遮挡/显式重设、拟合早期ID离群点、强度旋转不塌缩、角度跨180平滑、不同父级/留边/源变速、手机90旋转、复制素材摘要、取消/源锁释放、生成覆盖/源码保持、真实稳定后像素、frame直接/concat一致与失跟/冲突拒绝。测试旋转素材最初使用旧metadata选项，FFmpeg8未写rotation；改为-display_rotation并实际ffprobe确认。示例初版标记只有单方向条纹，算法正确报lowTexture；改为二维纹理后4点180帧全有效，不放宽阈值。examples/tracking-lab最终dc192be7，6秒720p30/180帧，五帧检查无提示；原图/跟踪证据/成片画面已目视检查，素材/JSON可修改，重建--rebuild/保留--render-only。

实际便携stdio MCP完整验证背景任务/分页/Schema缓存/原生标注/生成贴附和四点pin/准确候选preflight→apply→undo/平滑zoom稳定/24帧MP4/随机帧/取消/CLI bridge/错误请求与源变更拒绝（artifacts/tracking-XiUNE1）。启动10入口13866字节、114能力/118全目录；短job246字节、计划1471字节、分页1744对完整3890字节；Schema未改缓存123/126字节。8帧JS装配复制7311360→1843200字节（约-75%），像素hash一致；总均值46.67/46.69ms，冷编译/解码主导，不宣称这一微基准帧率加速。24帧4点分析约275ms/typed缓冲峰值1072640字节，720p示例源640图180帧分析约1164ms/峰值4262400字节，仅这台机器/素材的证据。

真实便携桌面首页/新建/最近/RGBA、运动分析/质量计数、标注图、保存资源、准确稳定/本地范围/zoom、撤销保留数据通过，截图已目视检查（artifacts/desktop-projects-Xkn6aQ）。桌面脚本最初在报告出现前查本地范围输入，已修正验证顺序，没有增加超时掩盖问题。独立Schema/hash/ref/短响应/媒体不重复与CLI通过（artifacts/mcp-budget-PzcfRU）；通用3D/OBJ/材质/平面效果/剪辑与音视频通过（artifacts/agent-tools-RDMWuy）；便携CLI短修改/完整读取/撤销/退出码通过（artifacts/agent-cli-qw25fK）。便携内置跟踪例子的原素材标注通过，复制后轨迹仍可用（artifacts/tracking-packaged-example.png）。末尾补缺失源的ASSET_CHANGED归一化、示例指南自动更新标记；源变更/失跟/素材复制两项针对复测及类型检查通过。当前源码/Schema/可编辑示例/验证脚本本地Git提交，视频与缓存不入库，不push。Rust没有修改。FFmpeg/FFprobe仍依赖PATH，GPU/长片与自动实时重绑定保持待实现，总目标active。

文字/矢量批次：路径文字、固定布局字/词/行范围选择器、多组文字数值动画与有序 trim/round/dash/outline/transform/boolean/closed-offset 已接工程/SDK/生成覆盖；渲染、文字多边形选框和 graphics_inspect 共用结果。graphics_plan 按稳定 ID 批量操作、键/表达式目标重映射、表达式显式索引引用保护、默认磁盘短候选与准确 preflight/apply/一次撤销。缓存静态排版度量/最终原生路径，LRU 项数/键与序列化字节有界；不缓存帧。graphicsCache=false 提供同像素真实性能基线，字体注册失效。高级字素分拆不保证复杂脚本连写；offset 只支持封闭轮廓，dash 为 on/off/phase，两者边界均明确说明。

此批完整回归65文件366项通过；末尾字距居中/AST索引引用保护/关闭缓存少序列化增量，5文件35项针对复测通过，短查询/批量scope复用后服务3项复测通过，旧textMotion混合粒度修正后两文件13项通过；类型与SDK声明/构建通过。首轮SDK声明超过TS长度，已给NodeShape/patch显式类型。examples/typography-lab保持版本e541c1db，实际6秒720p30/180帧导出、五帧检查零提示，截图已目视检查；--render-only保持已有编辑，重建需显式--rebuild。

真实封装 stdio MCP：10入口13866字节、110能力/114全目录工具；新Schema refs/hash短缓存123/126字节、计划951字节，默认16单位查询2447字节对完整8327字节，默认值与四位精度声明可见；不是模型token估计。生成层两类修改、最终求值分页、CLI一致、错误请求不改文件、准确候选原生画面/提交、随机PNG、缓存基线像素一致、60帧MP4、稳定ID排序复制关闭和两次原子撤销、来源TS不变均通过（artifacts/graphics-4o1IdP）。640场景热均值1.73→1.12ms，720p演示5.69→1.81ms，仅本机此场景证据，不代替参考机实时/4K/长片验收。Schema/ref/hash/媒体不重复/CLI全检查通过（artifacts/mcp-budget-tmcqlI），通用3D/材质/效果/剪辑音视频通过（artifacts/agent-tools-onBl5l），便携CLI退出码/短修改/撤销通过（artifacts/agent-cli-JvjTuj）。实际桌面测试发现新检查器与AnimationInspector重复React key导致切层旧面板残留，现key加graphics前缀，最终实际窗口新增/关闭文字动画、保存路径文字、切层无旧面板、形状排序/复制/独立ID和一次撤销全部通过，截图已目视检查（artifacts/desktop-projects-l5fuDw）。Rust未改源码，原生求值新数值通道对照通过。最后当前包 graphics MCP 再跑相同完整流程通过（artifacts/graphics-rqeie9），热均值1.69→1.16ms，原图像素仍完全一致；独立三个Schema与说明已打包。源码/示例/Schema/验证脚本本地Git提交，不含缓存或视频，不push。总体目标仍active。

媒体/工程批次已完成稳定ID重链接候选（兼容/明确替换、新metadata/checks）、后台FFV1代理/取消/缓存复用/失效、实际自动预览与屏幕解码、空闲读取释放，以及可审阅的缓存预算/路径/lease/引用保护清理。Windows解码reader会锁源文件，新增释放动作等待exit；最初等待close导致管道未排空挂起，现销毁输出流后等exit，10项针对复测和最终63文件355项全回归通过，没有调高超时。重链接撤销允许仅MISSING_ASSET的外部可用性错误，保留诊断/最后有效预览，格式/代码错误与普通事务验证仍拒绝。真实开发MCP检查也修正了测试中640预览与1280默认导出尺寸不匹配的问题，以相同尺寸PNG比较后通过。

真实便携MCP验证代理进度/取消、原始证据、移动路径恢复的准确候选、稳定ID/撤销/重做、失效代理拒绝、缓存实际回收16字节及源/候选/检查点保留、原图PNG字节一致和60帧MP4（artifacts/media-cache-Wa1b9R）。1280源的640预览解码921600→230400像素（-75%），当次热均值5.14→2.47ms；不是所有codec/长片性能承诺。重链接回复1261字节、缓存计划608字节。实际Electron管理面板生成代理后auto预览报1个代理，缓存预算/保护说明、首页/新建/最近/RGBA通过，截图待最终目视检查（artifacts/desktop-projects-RdY1tI）。通用便携3D/材质/特效/剪辑与音视频仍通过，108能力/112工具、启动10入口13866字节、全量496025字节（artifacts/agent-tools-atmOfZ）；Schema/ref/hash/短回复/媒体不重复/CLI缓存通过（artifacts/mcp-budget-5nDOBt）。字体/绘画/声音文档不转普通重链接；代理仅用于预览，导出原素材，FFmpeg/FFprobe仍外置。缓存没有常驻自动配额，历史/候选/检查点/编译模块不删除；源码、引用缓存也保留。最终说明/CLI/封装同步与本地Git提交进行中。总体目标active，继续广度/性能/外部Agent批次，不询问下一步。

最后目视检查发现代理完成后面板缓存字节仍沿用打开时的旧值；已让完成事件同时刷新素材和缓存，实际桌面验证0.2MiB更新、auto使用代理、预算计划/保护及启动工作流通过，截图已检查（artifacts/desktop-projects-joVckX）。修复后最终便携媒体MCP同一完整流程通过（artifacts/media-cache-a31v9V），解码量仍减少75%，单次热均值4.46→1.82ms，不把这次重复缓存数据作为跨设备承诺。便携CLI创建/Schema/短修改/完整读取/撤销/退出码通过（artifacts/agent-cli-qDflhn）。最后仅变更面板刷新及指南/工具说明，核心355项回归与关闭修复针对验证仍适用，构建/便携已同步；本地Git提交此批，缓存/产物不入源码。

新批次“通用纹理/光效＋区域性能＋Agent组合模板”：已实现texture图节点七种确定性场、域扭曲/色表/透明插值，displace通道/中点/alpha/空间，普通栈gradientMap/bloom/radialRays及SDK；visual_templates/plan九组合资源，保持用户编辑/生成源码、支持参数键和准确候选/一次撤销。纹理/noise使用变换保守区域像素块，map/rays按有效范围求值；render_profile bounded/full像素一致并报告fieldPixels/累计256M预算。开发MCP已验证摘要、图层map、光效、随机跳转、PNG字节一致、60帧MP4、错误恢复与撤销；4秒720p120帧六面板示例已导出并目视检查，复杂CPU例子仍较重不宣称实时。测试揭示纹理Schema与像素依赖循环，已拆为独立texture-schema；命名效果length可连接，数组length仍拒绝。11项针对新增检查通过，全回归/封装/真实MCP验收与Git提交进行中。整体目标active，广度/性能/Agent并重，不询问下一步。

此批验收：61 文件347项完整回归通过；最后区域像素块增量与旧图节点共20项针对复测通过，构建与便携更新完成。真实封装MCP完成9组模板短摘要/单组图查询、代码生成覆盖/源码保持、参数键/随机访问、同级layer map、普通bloom/rays、失效请求恢复、PNG byte parity、60帧MP4及原子撤销（artifacts/visual-fields-D0GQHh）。640×360真实测量纹理求值25359对230400、热均值6.43对10.08ms；字段hash相同。模板摘要4244字节/计划3334字节。桌面检查器实际新增并保存3效果、启动/新建/最近/RGBA通过，截图已检查（artifacts/desktop-projects-5vMphC）；声音发布与入轨另通过（artifacts/desktop-projects-4Y3MdW）。通用MCP全目录检查原脚本漏掉只属effects类别的工具，现按发现返回的全部category加载并断言总数；102能力/106工具全量通过，启动仍10入口13866字节、全量489559字节（artifacts/agent-tools-PIm7W5）。Schema/ref/hash/原生媒体及短响应通过（artifacts/mcp-budget-jkgcMa），新图Schema94825→29295字节、缓存127字节；便携CLI创建/Schema/修改/撤销/退出码通过（artifacts/agent-cli-q3xwFP）。导出和缓存不入库，示例/Schema/源码/说明本地Git提交；原生Rust未改动。复杂CPU特效实时、高级GPU/ROI缓存仍未完成，总体目标保持active，后续继续跨通用创作/性能/Agent批次。

最终区域像素块版本对既有示例使用 --render-only 重渲染并保持工程版本ab7fb084：720p120帧导出/接触表/性能JSON成功，bounded/full像素hash一致，field work为350548/18432000，单次热平均369/1160ms。仍是重CPU例子，不满足实时预览，之后优化不应把仅小场景指标泛化。最新说明/Agent示例同步到当前便携包。

最后增加真实封装的普通 radialRays.length 关键帧检查：effects_plan 两端键、animation_inspect 在30帧读取0.2+0.5×30/59的准确值、生成覆盖、原生画面/PNG一致/60帧MP4/一次撤销均通过（artifacts/visual-fields-LotzAL）。源代码不变，离散samples/levels不写连续键。最终源/文档/可编辑例子本地Git提交，未推送远端。

新批次“分镜编排＋全片检查＋预览传输”已实现：storyboard JSON、章节/镜头/配音稳定 ID、累计有理数边界、短修改/分页、场景/代码/声音与剪辑一次候选/撤销；声源采用源码 hash 并传递采样 checks，支持未写盘声音草稿。sequence_audit 遍历结构并按边界/章节/均匀时间分层抽样，来源对象 locator 与真实复合画面像素/覆盖/遗漏明确。桌面 RGBA 无损传输避开 PNG 编解码，保持版本/时钟/过期检测；格式分开的最后有效画面，PNG API/MCP 保留。开发真实 MCP 已完成同一草稿创作闭环、120 帧带声 MP4与整批撤销；开发 HTTP 640/1280 raw/PNG像素一致，720p 传输准备约18.6→1.6ms、总约23→11ms，但raw为3.7MB本地数据，非远程/整机FPS承诺。8 秒240帧可编辑storyboard-lab已导出，58文件333项全回归通过，封装/MCP/UI及Git验收进行中。总目标active，不询问下一步，保持广度与实测优化。

该批最终验收：含发布恢复新增测试的59文件336项完整回归通过；构建与便携完成。曾遇到 Windows EPERM 且重叠封装过程缺少互斥：启动目录已从有效 staging 恢复；脚本现采用独占 owner lock、短时占用重试和失败回滚，故障注入验证旧包可恢复、stage保留、路径限定与并发拒绝。没有把启动缺失检查失败跳过。真实便携 MCP 创建新声音/场景/分镜同一候选、保存前声音/全片 composite 检查、分页/重排/hash保护、120帧带声音MP4和整批撤销通过（artifacts/storyboard-batch-bVDHbR）；计划回应1356字节、检查6990字节，覆盖16候选/12取样/4遗漏明确。实际便携HTTP raw/PNG在640/1280像素完全一致，1280传输准备约23.4ms对3.0ms，总约27–29ms对13.6–14.6ms，raw3.7MB且本地收益，未宣称所有场景/远程/整机实时。真实桌面ImageData→ImageBitmap显示、首页/新建/最近与声音编辑发布入轨通过（artifacts/desktop-projects-zLwhmd）。默认10入口13866字节，100能力/104工具，全目录455844字节；hash/ref/短修改/媒体不重复与CLI检查通过（artifacts/mcp-budget-L9j7qi），通用3D/材质/特效/剪辑及音视频保持通过（artifacts/agent-tools-BKRRvL）；便携CLI创建/Schema/短修改/完整读取/撤销/退出码通过（artifacts/agent-cli-sVXKpW）。storyboard-lab的240帧视频与跨全时段contact已目视检查。源码、Schema、可编辑例子和说明本地Git提交，缓存/成片不入库；整体通用软件目标保持active。后续继续通用视觉/媒体、效果与预览性能和Agent批量工作流，避免单系统深钻。

最新纠正：用户明确要求“广度＋高性能＋好优化”，不要因为提到音频就持续钻音频。当前批次已转为通用场景转场/隔离合成、组件依赖编译缓存/JSON 类型诊断失效、临时画布复用与 MCP 性能报告；已完成的总线/侧链/响度代码作为收敛增量一同验证，不继续扩张 DAW。8 秒二维数学/原生三维＋八种转场示例已导出 240 帧，逐帧池/基线 hash 一致；开发 MCP 实测 4 次分配/26 次复用对基线 30 次分配。默认 10 入口、97 能力/101 工具。针对缓存/透明端点/预检/状态代码及音频随机范围/路由/候选检查通过，完整回归、便携与 Git 在验收中；总目标未完成。

该通用批次最终验证：56 文件 326 项完整回归通过，构建与当前便携更新通过。真实封装 MCP 批量生成两个转场、声明场景引用、准确候选性能/原生预检/提交、池与不保留基线像素一致、错误恢复、声音准确候选/响度、120 帧带音 MP4 和一次撤销通过（artifacts/workstation-batch-7JvHSG）。640×360、9 样本下画布分配 30→4，复用 26；当次热平均约 4.07→3.31 ms，仅为此设备/场景证据。1280×720 数学/原生三维示例热平均 25.48/25.52 ms 差异很小，不能把分配下降当作所有场景的显著提速。全转场端点与透明加法颜色、导入 JSON/缺目录类型失效、重复帧状态错误保留已验证；不使用结果缓存掩盖状态代码。MCP 启动 10 入口 13866 字节、97 能力/101 全量工具，目录 447984 字节；接口 hash/本地引用/媒体不重复/短响应/CLI 一致通过（artifacts/mcp-budget-ogKto0）。通用 3D/OBJ/材质/特效/剪辑音视频保持通过（artifacts/agent-tools-LzPRS4），真实桌面首页/新建/最近项与声音发布入轨通过（artifacts/desktop-projects-4PAo1p）。原生 Rust 未改动，GPU/共享纹理、效果 ROI、编码/预览传输和正式参考设备长片验收仍未完成。下一批继续跨通用视觉/媒体、实测性能与 Agent 工具推进，不钻单个子系统，不询问下一步；整体目标 active。

最后文案/SDK指南同步后的包再次通过同一真实 MCP 流程（artifacts/workstation-batch-3uHuYW），分配仍为 4/30、像素一致；热平均 3.14/3.11 ms，显示微基准耗时有波动，优化结论仅限明确的分配/重编译减少。便携 CLI 创建/Schema/简短修改/完整读取/撤销/退出码保持通过（artifacts/agent-cli-6nr3TK）。最终说明与可编辑例子同步到当前便携包，本地 Git 提交此批。

最新用户方向：当前 3D 阶段完成后，优先继续优化 AI 使用与平面特效制作，不再扩张 3D 工程线来拖延该主线。完整软件总目标保持不变。

最新目标更新（本轮覆盖旧偏好）：质量、自由度和外部 AI/代码/MCP 接入仍优先；不需要询问下一步，按相关功能批次自主推进。

最新流程偏好：一次开发多个相关功能，整批完成后统一测试和提交；开发阶段只跑必要的针对检查，避免每个小改动重复完整回归/封装。下一批候选为表达式+布局+曲线路径、分镜+全片检查+声音路由、或时间分支+转场+高级粒子，已向用户询问选择。

用户已选择下一批“属性表达式＋布局约束＋曲线路径动作”，按同一求值/依赖系统联动实现后统一验收，不再逐个模块反复完整打包。

用户随后选择“音效制作和音乐制作”，确认同时支持合成乐器编曲与已有音频/采样加工。本批加入声音 JSON 资源、确定性 48 kHz 多轨 synth/FM/noise/drums/sampler、ADSR/扫频、节拍速度映射、 gain/pan 自动化、无循环 bus/send 与 gain/EQ/distortion/delay/chorus/reverb/compressor/limiter；长采样磁盘 PCM 分页，变调带限 sinc。sound_library/inspect/plan/preview/midi 与 CLI/SDK 接入原候选流程，试听未保存准确候选，采样指纹保护和一次撤销；素材库独立声音页支持音符/JSON 草稿、试听、发布及放置。针对测试覆盖频谱、分块/跳转一致、尾音、MIDI 延音/标准精度、候选/保存/时间轴音频一致、31 秒采样与打包重渲染；原创 sound-lab 已导出 14 秒 1280×720/30fps、420 帧 MP4 与 WAV，采样画面已检查。全回归/封装/MCP/UI验收进行中，默认 10 入口、92 能力/96 全量工具。不是完整 DAW、响度/true-peak 标准或外部插件实现，总体目标未完成。

2026-10-05 声音制作与 MCP context 批次最终验证：51 文件 309 项全回归通过，构建及当前便携更新通过。真实封装 MCP 完成合成/采样/鼓组合并候选、保存前原生 audio 试听、保存与时间轴 PCM 一致、带尾音随机访问、分页/错误恢复、MIDI、声音驱动画面、源码保持、90 帧 AAC MP4、PCM WAV 及资源/放置一次撤销（artifacts/sound-batch-T1ieNy）；WAV 与试听的量化最大误差为 1 个 16 位单位。桌面首页/新建/最近项及声音独立页、音符保存前试听、发布与音轨放置通过，截图已检查（artifacts/desktop-projects-3lagsA）。初始 UI 放置检查失败是测试只检查第一视频片段的文字，实际音频已经显示并保存；按全部片段文字检查后通过，没有把失败跳过。

用户额外明确“重点测试 MCP，优化 token”。tool_schema 现在使用有效本地 $ref，并保留 expanded 模式；接口 hash/ifHash 可跳过未变化的重复 Schema，CLI 一致。真实便携客户端通过各引用闭合、缓存命中/刷新、错误不写工程、原生媒体不重复 Base64、直接工具按需加载/恢复与响应大小检查（artifacts/mcp-budget-kVwCbr）：声音计划接口 38169→14821 字节（-61.2%）、图计划 80397→25549（-68.2%）、缓存命中 120–127 字节；初始 10 入口 13852 字节，同一修改 compact 432 字节对完整读取 45764 字节。这是 JSON 字节证据，实际 token 由外部模型分词决定。通用便携 MCP 的 3D/材质/剪辑/特效与音视频仍通过（artifacts/agent-tools-tUxk2G），92 能力/96 工具，完整目录 430503 字节；便携 CLI 创建、Schema、修改、完整读取、撤销与退出码通过。原生 Rust 本轮未改动；FFmpeg/FFprobe 未内置。源码/Schema/文档/原创铃声与可编辑例子本地提交 Git，导出和缓存不入库。按照最新目标自主选择后续相关批次，不询问下一步，总目标保持 active。

该批已接入统一 post-keyframe 属性求值：有界轻量语法树数值表达式、base/value/self/parent/scene/layer稳定引用和循环诊断；声明box锚点/比例尺寸/留边/宽高比及祖先矩阵换算；SVG原生规范化、自适应弧长、切线/自动朝向、repeat与路径引用。渲染与选框/动画检查共用驱动结果，独立组先求父级再隔离，外部依赖保留。drivers_inspect/plan/curve_path与CLI/SDK批量候选统一跨场景、组件覆盖、配置键显式移除和一次撤销。开发版真实MCP已实际导出两场景120帧MP4、PNG字节一致、循环失败恢复、源码保持/原子撤销；4秒1280×720120帧drivers-lab已目视检查。SDK声明超过TS长度限制已通过明确SceneShape类型修复构建；回归揭示把TS编译器引入SDK会使128MB组件Worker生成错误堆栈时OOM，现使用只解析所需子集的轻量词法/优先级解析器，不提高运行时内存上限。运行错误源码位置/预检检测针对复测通过。默认10入口87能力91工具，完整软件目标未完成。

属性驱动批次最终验证：49 个文件、294 项完整回归通过，构建与便携更新通过。轻量解析器版本的真实便携 MCP 完成表达式/布局/路径跨原生与生成图层、弧长/切线证据、依赖循环恢复、动画真实值、原生预检、随机跳转、PNG 字节一致、120 帧 MP4 与一次原子撤销（artifacts/drivers-batch-n6ACc0），采样画面已检查。通用便携 MCP 的 3D/OBJ/材质/平面效果/剪辑/音视频导出保持通过（artifacts/agent-tools-tbD9IM），默认 10 入口、87 能力/91 工具，目录实测 13586/412158 字节。CLI 创建、发现/Schema、精简修改/全量读取、撤销、PNG 与明确退出码通过；真实桌面首页、新建/重复保护、失败保留及最近项目重启检查通过（artifacts/desktop-projects-sQXQLz）。源码、Schema、文档与可编辑示例纳入本地 Git；导出和封装不入库。Rust 本轮未改动，媒体运行时尚未内置，整体软件目标保持未完成，下一批等待用户选择。

用户已选清单第1项可编程特效节点图。本轮新增 effectGraph inline/资源格式与SDK、拓扑/参数/资源循环检查，input/pass/blend/mask/transform/displace/noise/solid/subgraph， typed连接（数字缩放、颜色、枚举、布尔/结构值）、子图默认参数与 effects.N.params.* 键。Raster pass抽出共享普通堆栈实现，引用计数释放分支图面；输入绑定同级图层，固定快照资源，不反向改组件代码。effect_graph_inspect/plan 支持节点筛选/字段证据、hash保护的稳定ID短编辑、跨场景应用、明确重置旧参数/键、一次撤销与覆盖报告。默认10入口84能力88工具。开发版真实MCP已导出60帧视频、像素PNG一致、节点短编辑/生成组覆盖/参数键/原子撤销，examples/effect-graph-lab已导出4秒1280×720/30fps120帧并目视检查。完成279项全回归及坍缩/typed连接额外测试，最终回归/封装/Git提交后补录。仍无图内时间分支/多输出/GPU/交互节点画布/自定义像素内核，完整版总目标未完成；下一阶段应询问用户。

节点图最终验证：46文件281项完整回归通过，构建与便携更新通过。真实便携MCP完成多输入/嵌套资源/链接参数键/生成覆盖/节点筛选/hash短编辑/失败重连保护/PNG字节一致/60帧MP4/资源与图层一次撤销（artifacts/effect-graphs-0hNaqU）。通用MCP的原有3D/材质/剪辑/时间平面能力及音视频导出保持通过，默认10入口84能力88工具，目录实测13586/389781字节；真实桌面首页、新建与最近项目重启检查通过。单批代码/文档/示例将提交本地Git；Rust未改动，整体目标保持未完成。存活图面估算明确不含外部捕获和内部scratch，实际预算由渲染器执行。

用户选择“平面特效：动感模糊、拖尾、粒子与变形”，随后明确要求 Git。原目录无仓库，已初始化 main 并提交源码基线 0363299，忽略 dist/release/node_modules/缓存/导出/.dsh-tmp。本轮新增时间图层 effects motionBlur/echo，重算历史原始/生成图，完整遮罩/透明度只乘一次，顺序效果可继续处理历史结果；focused 组件也使用重新生成 provider，线性父级参数时钟取样。查询/像素/深度和内存预算明确，错误后释放。新增 particleField/particleState 解析出生、重力/阻力、范围发射、条纹/渐变/旋转，particles_inspect/plan 提供分页证据及参数化组件短候选。liquify 提供 push/twirl/inflate 平滑反向采样笔刷、局部矩阵及动画字段。默认10入口/82能力/86工具。开发版真实 MCP 与示例已实际导出，随机跳转/PNG字节一致/组件源码保持/发射器原子撤销通过；1280×720/30fps 4秒120帧 temporal-lab 已目视检查。父级整体变换需把效果放到相应拥有层；无光流、GPU或累积粒子物理。最终回归/封装/Git特性提交结束后补录，完整软件目标未完成。

平面阶段最终验证：44 文件267项 TypeScript全回归通过，构建/便携更新通过；实际便携 MCP 完成组件历史采样、刷键、发射组件参数、一次撤销、源码保持、随机跳转、原生图片、PNG字节一致、60帧MP4（artifacts/planar-motion-dZ8RK4）。通用 MCP 的3D/OBJ/材质/特效/剪辑/音视频回归通过，默认10入口82能力86工具，目录实测13586/260462字节；CLI创建/接口/事务/退出码以及真实桌面首页/切换/最近重启保持通过。组合示例4秒1280×720/30fps、120帧已导出及目视检查，late参数时钟修复另有回归。Rust本轮未改动。用户要求列后续功能，已写 FUTURE-WORK.md 的26项优先级表并同步原Roadmap/AE状态；建议下一步特效节点图，但须由用户选择。本轮已建立Git，最终特性与文档将本地提交；不推送未指定远端，完整目标保持未完成。

用户随后选择“Agent 动画编排：动作组合、参数模板、跨场景复用”。新增 motion_templates/motion_plan 与 SDK applyMotionCues/parseMotionTemplate：参数化 normalized keys、帧/秒统一换算、每目标延迟/绑定、静态/求值基准、明确通道冲突保护、同属性动作范围与端点冲突检查；共享 JSON 资源可与跨场景图层同一候选提交，生成组写覆盖且源码保持。默认 10 入口、80 能力/84 全量工具。开发版真实 MCP 已导出 4 秒 640×360/30fps、120 帧的两场景动画，验证共享入场/强调/退场、不同参数/延迟、图片不足报告及补充候选预检、原生接触表、PNG 字节一致、资源/场景一次撤销；当前例子已重应用为可编辑完成状态。已目视检查接触表，完整回归/封装验证结束后补录。全软件目标未完成。

动作阶段最终验证：41 文件 253 项完整回归通过，构建和当前便携更新通过。补充重复通道替换保护后，动作 5 项复测和便携跨场景 MCP 导出再次通过。当前便携真实 MCP 还通过审计/修复、精确提交、PNG 一致、60 帧视频、一次撤销；隐藏桌面通过首页/空白/模板/重复保护/切换失败保留/最近重启与重新打开。通用 MCP 的 3D/网格/材质/平面效果/剪辑及音视频导出保持通过，默认 10 入口、80 能力/84 工具，目录实测 13586/232927 字节。动作示例 artifacts/agent-motion-Ck5Xaz 及最终运行目录均含可编辑工程和 120 帧 MP4；源码保持，模板/场景一次撤销后已重应用。Rust 本轮未改动。整体目标保持未完成；下一阶段应继续询问用户方向，不自动扩张范围。

用户已选择下一步“Agent 创作闭环”。新增 visual_repair_plan，以原生完整文字高度及变换几何，对展开稳定 ID 生成适配文字、画布/父级移动和移回画布的明确候选；自动定位组件/共享引用覆盖，默认平移整条关键帧轨迹，currentKey 改局部姿态。返回前后审计、精确存储计划，原样 preflight/apply 一次撤销；不自动判断重叠、裁剪或运动的艺术意图。findings 新增稳定 ID/locator，render_start 与 CLI render --revision 拒绝审阅后的版本变化。默认 10 入口、78 能力/82 全量工具。开发版真实 MCP 已完成前后原生图、组件两项修复、预检/提交、源码保持、旧版导出拒绝、PNG 字节一致、2 秒 640×360/30fps 60 帧 MP4 和一次撤销；整体目标未完成，完整回归及便携结束后补录。

本轮最终验证：当前便携版真实隐藏窗口通过首页、新建、重复保护、失败保留、模板切换、返回首页、最近项持久化和重新打开；截图已检查。便携 MCP 完成同一修复闭环、精确提交、源码保留、PNG 字节一致、60 帧 MP4 与一次撤销，并留下已修复的可编辑工程 artifacts/agent-review-FdOSvZ。通用 MCP 回归仍通过 3D/OBJ/材质/特效/剪辑/音视频导出；初始 10 入口、78 能力/82 工具，目录实测 13586/225616 字节。CLI 空白/模板创建、帧图、事务/撤销、接口搜索和退出码通过。TypeScript 回归覆盖 40 文件 248 项；完整运行其余 247 项通过，新增工具引起的固定数量断言已改为目录/指南/分页计数一致性，相关发现/审计/修复 16 项复测通过。构建与便携更新完成，Rust 未改动。整体软件仍未完成；已向用户询问动画编排、平面特效或长视频组织的下一阶段选择。

2026-10-04 用户发现封装默认打开示例、找不到新建项目：确认启动写死 examples/science，新建只藏在工程设置且仅创建示例。现改为启动首页、新建/打开/最近项目、编辑器顶部按钮与 Ctrl+N/O。共享创建逻辑支持空白工程、科普模板、尺寸/有理数帧率/时长，CLI init 默认空白。打开候选成功后才切换活动服务，失败保留原工程；不覆盖非空目录，最近项最多 12 条，release 提供明确的当前版启动入口。真实隐藏 Electron 窗口已验证创建、重复保护、失败保留、切换、回首页、重启最近项和重新打开，截图已检查。39 文件 244 项测试及构建通过，便携验证结束后补录。整体通用软件目标未完成。

承接中断的平面实现已接入 meshWarp/cornerPin、透视 UV、局部 tile 四采样、区域外保留、预算拒绝和点位关键帧，SDK 与 effects_plan 复用；网格数量、恒等/零值、移动清空、透明颜色、旋转/镜像、对角无裂缝、透视和通道复制已测试。该增量不等于自由笔刷液化或完整 AE 能力。进一步 agent/平面能力按下一步选择推进。

2026-10-04 本轮转向 AI 与平面特效：waveWarp/twirl/bulge/rgbSplit/linearWipe/radialWipe 接入普通堆栈，默认局部矩阵/region，预览比例/旋转/位移一致，预乘 Alpha 采样和端点精确。effects_guide/inspect/plan 以稳定效应 ID、数值通道与短计划提供批量操作；复制/排序/删除保留逻辑键，修改已有数字字段更新当前键，生成图层保存覆盖且源码不变。effect.enabled 可无损禁用，同层 ID 唯一；新增效果默认拟合内容边界。默认仍为 10 入口，77 能力/81 全量工具。

已完成 8 秒 1280×720/30fps、240 帧 effects2d-lab 及五帧确定性检查，六项扭曲/转场画面已目视检查。CPU 区域收紧包含位移/圆半径和 wrap 边缘，验证挪走像素透明、零强度与端点精确、局部/旋转/低分辨率坐标、透明色散、键迁移及原子撤销/PNG一致。发现分段缓存只依据工程版，更新渲染实现可能沿用旧画面；现纳入运行核心/SDK/原生/Canvas/Node 指纹，检查点校验对应版本，旧缓存不混用。最终回归、当前实现重渲与便携验证结果结束后补录。整体目标未完成，详见 EFFECTS2D.md。

平面阶段最终验证：37 文件、233 项 TypeScript 测试通过，构建与便携更新通过。开发/便携真实 MCP 以 effects_plan 对两层同时添加效果、获取接触表、提交稳定 ID 并一次撤销，随后网格/材质/剪辑/音视频导出保持通过；默认 10 入口、77 能力/81 工具，目录实测 13577/217212 字节。CLI 精简/完整读取/PNG/退出码通过。渲染测试验证不匹配运行时的检查点确实重新生成帧。当前实现完整重渲效果示例 240 帧完成；固定视口避免演示效果挤入卡片标题，五帧与画面已检查。Rust 本轮未改动，沿用 10 项通过记录；光流、液化/网格变形、GPU、完整节点图等仍待实现，整体目标继续未完成。

2026-10-04 本轮加入平滑角点法线与可编辑材质：按面积/折角生成法线，OBJ normal 引用进入平滑材质，非均匀/镜像法线用逆转置变换，裁剪/采样按透视插值。Rust 与 TS 回退实现 GGX/Smith/Schlick 金属度/粗糙度直接光照、方向/点光、自发光、双面、曝光和 SDR 色调映射；未声明材质的旧项目保持原平面路径。scene3d_materials 以稳定实例 ID 查询/计划修改，不传顶点数组，存储候选预检/原样提交一次撤销；已有数值通道在所选帧写键，材质重置清理通道，动画灯光数组替换需要显式重置键。

examples/material-gallery 已实际导出 6 秒 1280×720/30fps、180 帧，展示平面/平滑、光滑/粗糙金属、自发光和移动点光，五帧预检无诊断、重复渲染一致；原生证据 backend=rust 且有真实像素，画面已目视检查。验证正常/近裁剪着色属性、非均匀法线、镜像、光照距离衰减、原生/回退 RGB 容差 1 和深度/面 ID 一致、数值键、材质计划与 PNG 导出/预览一致。完整回归/便携验证结束后补录；IBL、纹理、阴影、透明材质/HDR/GPU 等仍未实现，整体目标未完成。

材质阶段最终验证：36 文件、225 项 TypeScript 与 10 项 Rust 测试通过，构建与便携更新通过。开发/便携真实外部 MCP 均验证材质短计划预检、原样提交、Rust 材质证据与独立撤销，再完成网格/OBJ/素材/音视频导出；默认 10 入口、74 能力/78 全量工具，目录实测 13547/185812 字节。便携全量预检/审计/参数/声音/路径/重复器/引用通过，CLI 正确退出码与字段错误定位通过。FFprobe 确认材质示例为 6 秒 1280×720/30fps、180 帧。当前 3D 阶段到此收尾，下一工作优先 AI 操作效率与平面特效，不以纹理/GPU等尚未完成项延迟该用户主线；整体通用视频软件目标继续保持未完成。

2026-10-04 本轮扩展程序化网格与 OBJ：SDK sphereMesh/cylinderMesh/coneMesh/torusMesh/planeMesh/surfaceMesh、bounds/normalize/baked transform/topology inspection 与 parseOBJ；球体/圆锥无退化极点，共享接缝，实体面方向与闭合边测试通过。OBJ 支持正负索引、分组筛选、材质颜色、共面凹轮廓耳切，保留 UV/normal 角点元数据；错误有源行号，MTL/贴图/平滑着色不宣称支持。网格保存为 components/meshes/*.json，scene3d 实例可 meshSource 引用，渲染/选取/agent 深度证据读取固定快照，资源更新影响共享实例，静态/结构/覆盖依赖检查阻止删除。

新增 mesh_generate/mesh_import/mesh_inspect 三项 agent 能力，默认仍为 10 个发现入口，73 项创作能力/77 个全量工具。生成/导入可自动适配相机并放置到场景/组/组件；候选/资源/图层原子提交一次撤销。大量顶点不重复返回，使用内容校验的存储 planId，通过原 preflight/apply 完成审核；不允许替换计划的操作、文件、基础 revision 或素材证据，delivery=inline 保留自由组合。真实外部 MCP 网关已验证存储计划画面预检、资源放置/检查、Rust 深度图与一次撤销；目录实测初始 13547/full 169387 字节。

examples/mesh-gallery 已导出 8 秒 1280×720/30fps、240 帧，六张卡展示球体/圆环/圆柱/圆锥/函数曲面/导入凹轮廓 OBJ；五帧预检无诊断且重复渲染一致，OBJ 深度证据 Rust 路径有实际像素。已目视检查示例画面。资源与候选诚信测试覆盖字节 SHA/BOM、非法编码、缺口不填充、共享修改、固定快照、结构内删除保护、状态未写入与原子撤销；全回归与便携验证结束后补录。贴图/PBR/平滑法线/透明材质/glTF/骨骼/GPU 等仍未实现，整体目标保持未完成。详见 MESHES.md。

该轮回归暴露 Windows 原子日志替换的短暂 EPERM：真实 MCP 压力脚本在第 4 轮捕获 journal.json rename 失败，导致偶发撤销/重做错误。atomicWrite 现有界重试 EPERM/EACCES/EBUSY（六次，最多 385ms 退避），保留已有目标并清理失败临时文件，持久失败返回 FILE_WRITE/文件/systemCode/尝试数；不对 ENOSPC 等非暂态错误重试。故障注入测试覆盖短锁、持久权限错误、磁盘错误；开发版和便携版真实 MCP 各 50 轮编辑/撤销/重做通过。另修复实例负缩放时面法线/剔除方向，使镜像实体仍显示正确外侧。

便携版默认 10 入口/73 项能力/77 全量工具，真实外部客户端通过 mesh_generate 和 mesh_import 的短计划 ID、原生图像预检、资源/放置提交、mesh_inspect、Rust 深度图、一次撤销与带音视频导出。CLI 搜索/接口/精简修改/全量读取/撤销/PNG/明确退出码通过。资源打包后头部渲染与原项目像素一致，已验证无需原始 OBJ。完整回归结果结束后补录；Rust 未改动，沿用上一轮 8 项通过记录。

最终验证：35 个文件、217 项 TypeScript 测试通过，构建与便携包更新通过；开发/便携 50 轮历史压力与网格/OBJ/存储计划完整 MCP 流程均通过。便携全量模式在 mesh-gallery 的预检、参数、声音、审计、路径、重复器与共享引用通过；空画稿图片检查明确跳过。FFprobe 确认 mesh-gallery.mp4 为 1280×720/30fps、240 帧、8 秒。此前出现的 Windows 日志替换问题已通过实际重复操作及故障注入验证修复。整体目标仍未完成。

2026-10-04 本轮新增 agent 按需工具发现：MCP 默认 10 个入口，tools_search 搜索中文/英文能力摘要、tool_schema 查询单个接口、tool_call 使用统一 schema 执行全部 70 项能力、tools_load 按名称/类别加载本连接直接工具。mode=replace 恢复核心集合，四个发现入口始终可用；无效工具名不部分加载，实际集合变化只发送一次 list_changed，连接之间相互独立。--tools all 提供 74 个全量工具和传统结果，旧直接工作流已测试兼容。统一 invoke 返回 structuredContent 与原生 media blocks，写操作默认只保留 revision/ID/诊断/撤销与专用结果，不重复返回全源码；素材导入明确返回 importedAsset/Artwork。服务端命名管道在发送前压缩结果，连接探测使用精简 ping。参数/版本/素材错误带恢复建议，未绕过任何事务/锁/预检。

实际开发版外部 MCP 测量初始目录 13671 字节、全量目录 158510 字节，减少约 91.4%（不是 token 估计）。客户端通过精简网关实际完成素材图片、矩阵与三张深度证据、精确剪辑候选预检/提交、带声音导出与撤销。CLI tools-search 的“深度”优先找到 scene3d_render，单工具 Schema 查询通过。额外修复单图层 composition_edit_layer 忽略 contextFrames 的问题；冻结组件按祖先参数生成图层时能正确编辑。完整回归曾通过 201 项，修复后内容时间/发现接口 14 项通过；最后回归与便携包验证结束后补录。该轮以工具链为主，不改变人机工作区。整体目标仍未完成，详见 AGENT-DISCOVERY.md。

工具发现最终验证：33 文件、202 项完整回归通过，构建与便携包更新通过；后续深层参数错误归一化的 4 项 MCP 发现/编辑测试通过，提交/撤销/重做场景另重复三次通过。实际便携版默认 10 入口、70 创作能力、全量 74 工具；与开发版同样实测 13671/158510 字节目录。精简模式实际完成三张 Rust 深度图/像素对象、素材取证、计划预检/原样提交、带声音导出和撤销；完整模式的预检/声音/审计/参数/路径/重复器/引用保持兼容。开发版/便携 CLI 验证搜索优先级、单 Schema、精简修改、完整读取、撤销、inline PNG，以及有效参数但项目预检失败退出码 2、参数格式失败退出码 1/TOOL_ARGUMENTS/字段路径。文档与模板已更新。Rust 未改动，沿用上一轮 8 项通过记录；完整通用视频软件目标仍未完成。

2026-10-04 本轮在矩阵 3D 基础上加入可保存的 scene3d 数据/图层与 scene3DLayer SDK、Rust 分块深度栅格器、1/4 点抗锯齿和等价 TypeScript 回退。视锥裁剪后按采样点比较 NDC 深度，eye-depth 按 inverse W 透视插值；交叉面和实体网格不再依赖整面排序。相机/TRS/矩阵/光照数值字段支持统一关键帧；原生动画求值不重复传输网格拓扑。原生像素缓冲与预览/导出共用，选框用投影实际几何。scene3d_render MCP/CLI 返回彩色/深度/面 ID PNG、实际可见像素数、稳定实例/面 ID 与像素 picks，并支持当前版本/独立组件路径；大量面标签分页并写 labels.json，原生超大请求与覆盖预算有明确拒绝。

本轮实际 examples/depth3d-lab 已导出 8 秒 1280×720/30fps、240 帧对照动画，五帧预检无诊断且重复渲染一致；agent 证据左右 picks 分别定位 red-plane/blue-plane。测试验证逆序三角形输出一致、原生/回退像素/面 ID/深度一致、透视深度、抗锯齿边缘、相邻面无孔洞、随机帧、JSON 保存、PNG 导出/预览一致、紧选框、非法数据保留工程与数值 3D 键。原生 8 项测试通过；开发版真实外部 MCP 验证 70 工具、三张深度证据图、矩阵投影、素材取证、精确候选提交、带声音导出与撤销。完整回归和便携验证结果结束后补录。当前仍缺贴图、平滑法线/PBR、世界内半透明材质、阴影、GPU 与模型资产导入；完整软件目标未完成。详见 DEPTH3D.md。

深度 3D 最终验证：32 个文件、197 项 TypeScript 测试和 8 项 Rust 测试通过，构建与便携包更新通过。原生错误码传播调整后的 7 项深度测试追加通过。开发版/便携版实际外部 MCP 客户端均验证 70 工具、Rust 三张深度证据图与 red/blue 像素定位、矩阵投影、素材图片、精确计划预检/提交、带音视频 MP4 与撤销。便携版在 depth3d-lab 也通过预检/审计/参数/声音/路径/重复器/引用查询；空画稿列表的图片检查明确跳过。FFprobe 确认 depth3d-demo.mp4 为 1280×720/30fps、240 帧、8 秒。示例画面已目视检查，穿插两侧遮挡正确；总体目标保持未完成。

2026-10-04 最新重点为外部 agent 使用效率；用户进一步明确线性代数优化主要服务于矩阵驱动的 3D 画面。本轮新增 4×4 Model/View/Projection、XYZ/TRS/pivot、层级世界矩阵、透视/正交相机、批量顶点、六面视锥多边形裁剪、背面剔除、方向平面光照与跨物体面深度排序，SDK scene3D/mesh3D 生成稳定 ID 的原生路径。matrix3d MCP/CLI 返回矩阵、裁剪状态和分页面几何，agent_guide 的 3d 路线连接现有预检/提交。examples/matrix3d-lab 已导出 10 秒 1280×720/30fps、300 帧双相机层级动画，五帧重复求值通过；本机 5000 点测试批量投影与逐点屏幕坐标误差为 0。当前为 CPU 矢量路径输出，没有像素深度缓冲/贴图/PBR/阴影；Painter 排序不保证穿插多边形遮挡，完整 3D 目标未完成。

本轮同时新增 media_inspect/media_sample 的实际素材探测、独立解码取样、原生源接触表与文件指纹；sequence_plan 返回 append/insert/overwrite 的具体 candidate/apply 请求，固定 ID 与候选 revision。支持独立链接音轨、防止重复声音、保留 split source/fade windows、移动标记/范围、锁定检查与拒绝单边链接覆盖。sourceOut 为排除端点，分数末帧声音补静音。project_preflight/project_apply 支持 assetChecks，并在事务队列完成验证后再检查素材。指纹是 size/mtime，不是内容摘要，外部进程无文件锁保证。agent_guide 提供精简路线，降低重复查 Schema 和拼底层操作的负担。线性数值 SDK/CLI/MCP 包括复用 LU、列主元 QR 拟合、批量坐标变换与共轭梯度轨迹；实际 12 秒示例已导出，详见 LINEAR-ALGEBRA.md。

最终回归为 31 文件、190 项 TypeScript 测试通过，构建和便携包更新通过。新增素材旧时长回归：sequence_plan 把实际探测 metadata/fingerprint 固定进候选操作，避免替换媒体后渲染仍被旧时长截断。实际开发版与便携版外部 MCP 客户端验证 69 工具、矩阵投影、素材取样图片、精确候选预检/提交、带声音 MP4 导出与撤销；便携版另验证画面预检、音频预览、视觉审计、原生路径、重复器、共享引用与结构化参数。绘画文档为空的工程不执行画稿图片检查，不把跳过记为通过。3D 基准本机单次测量 5000 点批量投影约 51.8 倍，屏幕坐标误差 0；不作为跨设备承诺。Rust 未修改，沿用上轮 5 项通过记录。完整三维与长期总目标仍未完成。

此前已经完成的时间/剪辑/预览工作补录：time_inspect/time_edit 支持视频/组件/场景引用的视觉 rate/reverse/freeze/repeat/remap 与祖先 contextFrames；预览改为先解码 PNG 再提交到固定 canvas，分辨率稳定、时钟/版本过滤过期帧。sequence_edit 提供 split/trim/slip/move/ripple/link/locks/markers/workArea/BPM；真实 PCM 验证 split 在 1×/1.5×/0.75× 淡化阶段保持相位。SRT/VTT 导入生成可编辑 cue JSON 与组件、原生中文文字测量防截断。examples/editing-lab 9 秒带声音实际视频、examples/time-lab 8 秒示例已导出；productions/deepseek-v4-1-flash 已导出 147.2 秒 1080p30 中文配音/字幕/音乐介绍，官方来源资料在工程 sources 中。最终完整回归为 31 文件、190 项 TypeScript 测试通过，构建成功。Rust 未修改，上轮 5 项通过。开发版实际外部 MCP 客户端已验证 69 工具、素材图片、矩阵投影、计划预检、相同候选提交、带音视频导出和撤销；便携包已重建，运行验证通过。

最新共享场景打通预合成、已有场景引用、实例独立页、内部属性/关键帧与结构覆盖、共享源编辑和实例重置。场景可声明自己的 width/height；预览、导出、相机与内部选取使用同一 source→instance 坐标。原生相邻图层预合成保留遮罩/层级/关键帧/原堆叠位置并支持一次撤销；代码生成叶节点按所选帧捕获，保留源码并明确 captureMode。MCP scene_precompose/scene_place/scene_references/scene_reset_instance 与 CLI 对应命令提供完整操作；声明依赖包括结构新增/覆盖，缺失与循环在保存前拒绝，DAG 验证缓存避免重复递归。visual_audit 已展开场景内部文字并返回实例编辑路径。界面实测生成共享信息卡、第二实例 x=400、内部文字覆盖、源文字改为“来源更新”时另一实例同步且第二实例保留“当前实例”、重置/撤销保留引用位置。修复窄画布区域的工具栏文案折行，按区域宽度显示图标并保留按钮名称。147 项 TypeScript 与 5 项 Rust 测试通过；便携版 58 个 MCP 工具、预合成和引用查询、实际帧返回通过，打包示例帧与开发版像素一致。examples/shared-scene-lab 完成 8 秒 1920×1080/30fps、240 帧导出及五帧检查。当前用户工程 revision 9c9a2fd1 保持不变，无诊断或冲突。实例当前共享所属场景帧号，未加入实例时间重映射、场景内声音路由或背景遮挡像素审计。整体目标仍未完成，详见 SHARED-SCENES.md。

最新重复器完成线性/网格/放射排列、数量小数渐入、序号偏移、中心/旋转/缩放/斜切、镜像、透明度渐变与反向叠放。SDK repeatGraph 支持按副本的纯函数回调，保持层级与遮罩命名空间、稳定 copy-N ID 和独立副本数据。repeat_describe 给 agent 提供矩阵/边界预测；repeat_create 从同父级来源创建完整可编辑 TS 组件，保留原生动画、来源代码和生成结构覆盖，创建/隐藏/模块写入可原子撤销。图层 matrix[0..5] 仿射变换与 numeric matrix.N 通道接入统一渲染/选取/遮罩/路径快照，并提供高级矩阵检查器。界面实测组内创建重复器、网格切换、数量 0f=3 / 60f=8.5 / 30f=5.75、第二副本独立斜切 c=.3 与直接拖动 (x=43.55,y=34.84) 保存，结束数量增加到 10.5 后覆盖仍保留。修复透明/未启用/遮罩图层在创建时无法查询几何的问题，常规选取仍按可见状态判断。最新 137 项 TypeScript 与 5 项 Rust 测试通过；8 秒 1080p/30fps、240 帧示例和五帧检查通过。便携版 54 个 MCP 工具、矩阵查询、完整创建与真实帧渲染通过；打包帧与开发版像素一致。docs/REPEATERS.md 与 examples/repeater-lab 提供说明与完整示例。来源基准图层图是创建时的副本，后续原结构变化不自动同步；沿任意曲线路径重复、原生形状算子栈和 GPU 实例化仍待实现。整体目标保持未完成。

最新矢量动画加入原生布尔运算（合并/相减/交集/排除/反向相减）、自交简化、路径圆角、实线描边转轮廓、总弧长环绕裁切、虚线与端点/拐角样式。渲染和选框共用路径，边界包含实际尖角和端点。SDK 返回新 SVG，不泄漏可变原生路径；修复组件编译对原生 canvas 依赖的打包方式，并为大型操作 Schema 提供紧凑类型声明。MCP path_geometry/vector_bake 与 CLI path/vector-bake 接入同一算法；图层快照支持代码生成结构/覆盖、版本检查、保留来源与一次撤销。界面实测四段虚线保存，裁切 0f=40% / 60f=90% / 30f=65%，Ctrl 多选相减生成新图层并隐藏来源，撤销恢复两源图层而保留此前曲线关键帧。125 项 TypeScript 与 5 项 Rust 测试通过，8 秒 1920×1080/30fps、240 帧示例导出完成；五个采样帧无排版提示，PNG 导出与预览逐帧一致性通过。便携 MCP 的 52 个工具与原生几何、画稿/画面/音频响应通过。当前服务已更新，用户原工程 revision 9c9a2fd1 保持不变，无诊断或冲突。静态路径快照不烘焙像素效果或源码动画；虚线转轮廓、逐轮廓裁切和鼠标路径控制点编辑仍待实现。详见 VECTOR-ANIMATION.md。

最新画面检查提供跨帧原生几何反馈：中文文字被高度裁掉的确定问题、画布越界、父级裁剪、文字重叠、不透明矩形遮挡与采样位移/突跳提示。报告含稳定对象 ID、所属组件路径、帧号、指标、不确定性、检查预算与标注图；原生文字行、继承透明度和旋转/镜像裁剪参与计算。界面点击提示已验证可定位并选中组件内部文字，修复参数后同范围提示消失；结果弹窗不挤压画布。MCP/CLI visual_audit/audit 与候选预检 visual=true 共用规则，确定错误可阻止提交，几何提示只作为 warning。最新 115 项 TypeScript 与 5 项 Rust 测试通过，便携 MCP 的 50 个工具及标注图片返回通过。examples/visual-audit-lab 修复前覆盖五种问题，修复后同四帧未触发规则，并完成 4 秒 1080p/30fps、120 帧 MP4 导出。检查只覆盖采样时间，遮罩/效果/透明媒体不作最终像素可见性证明，scene 引用内部和公式专用布局检查尚未实现。

最新声音工作流接通主时间轴分段预览：48 kHz 采样位置、Web Audio 时钟、暂停/跳转、监听静音/音量与电平，缓冲上限有界。复用导出混音器，修复中段试听淡化重置、嵌套音量/包络遗漏、原速变速处理与变速分段相位不一致；变速源缓存为临时文件原子生成并可取消。原速/1.5 倍/0.75 倍相邻片段与连续混音的样本一致性测试通过。新导入媒体记录真实时长/尺寸/声道，轨道默认长度按素材时长计算。MCP audio_timeline/audio_preview 返回实际音频和 RMS/峰值/波形检查，便携版 49 个工具与实际声音生成通过。最新完整回归为 107 项 TypeScript 与 5 项 Rust 测试通过；12 秒 1080p/30fps 声音同步示例导出完成。单独合成仍为静音画面预览；音频总线与场景内视频声音路由待实现。

最新关键帧工具完成统一批量命令：创建/替换、删除、缓动、复制、时间/数值平移缩放、通道/帧/范围筛选、碰撞诊断与跨原始/生成图层原子撤销。时间轴支持关键帧 Ctrl 多选、整组拖动、复制/粘贴按钮和快捷键、Ctrl+A、独立删除；动画检查器支持精确帧/数值输入、批量动作、曲线拖动和贝塞尔控制点。界面实际验证两通道 180f→190f、控制点保存、粘贴 210f 后删除仅删除键而不删除图层。animation_inspect 提供分页键值与数值/速度估计，animation_edit、CLI animation/animate、SDK editKeyframes/sampleAnimation 共用规则。97 项 TypeScript 测试通过；Rust 未改动，上轮 5 项测试通过。便携包更新并验证 47 个 MCP 工具及动画查询。

最新参数系统支持 SDK 类型推导、枚举、布尔、二维/三维向量、数组、嵌套对象、默认值及严格约束验证。属性面板按声明生成控件，默认数值一键建立关键帧；MCP/CLI 可查询静态/当前求值、Schema 和可动画路径，编辑嵌套参数、重置、关键帧及数组项目。数组插入/删除/排序同步映射项目动画，生成的嵌套组件编辑保存在所属覆盖中。examples/parameter-lab 展示数据和布局参数动画，便携包包含该示例。最新 91 项 TypeScript 测试和 5 项 Rust 测试通过；界面布尔/枚举/数组/关键帧/撤销实际验证通过，便携 MCP 的 45 个工具与结构化参数查询通过，打包示例在 90 帧读出预期数据 56、位置 x=187.5。

最新一轮完成 agent 候选代码流程：project_context 精简查询、project_file_read 分段读取与 hash、project_schema 按需 schema、project_preflight 格式/类型/组件/采样帧检查、project_apply 原子提交。新增模块和删除模块按候选版本查找，预检失败保留原工程；支持待修复 JSON/TypeScript 的 pending 版本，重复渲染像素比较能发现有状态代码。编辑器提供相同的源码预检、错误行列定位、候选画面与原文件 hash 检查，并保留切换/刷新后的未保存草稿。最新完整回归为 85 项 TypeScript 测试通过，相关服务/预检测试追加验证通过；Rust 未改动，上轮 5 项测试通过。便携包已更新，打包版 MCP 的 43 个工具、两帧预检图片、schema 查询和候选 revision 已实际验证。

最近这一轮为有效进展：新增像素合成/调色/抠像能力、嵌套属性与贝塞尔关键帧、声音分析；随后按用户要求优先重构 UI 并完成任意组的独立合成导航。

当前 UI 已实测：点击场景后使用局部时间轴，进入代码组件与内部组，编辑生成图层属性保存为覆盖、撤销恢复、独立播放位置、返回导航、时间轴缩放与面板调整。选择工具按用户修正采用 AE 风格：普通点击切换，Ctrl 添加/取消多选，任意已选图层直接拖动整组，空白处拖框选择，一次撤销恢复整组，Esc 取消临时拖动。多层修改共用原子事务，支持不同父级坐标换算和组件覆盖，父子同时选择避免重复位移。修复了指针捕获层级错误和绘画画布拦截文字；已有位置动画在当前帧更新关键帧。素材库改为拖入放置或双击添加，画稿按绘画资源处理。

这一轮已完成：组件内部结构新增/删除/复制/编组/排序、原生组内容边界、代码行号滚动同步、重启恢复撤销/重做（兼容旧事务备份）。独立绘画文档支持图层、笔压、橡皮、图层复制/排序/混合/透明度，支持整张画稿与选定图层发布；素材库显示缩略图，拖入主时间轴已实际验证生成画稿片段。用户现有 12 个旧画稿的缩略图均已检查存在实际像素。外部 MCP 客户端验证了创建、绘画、图片检查、发布和轨道放置，并提供素材图片检查与实际图层边界查询；CLI 提供相同的画稿与素材命令。最新完整回归为 76 项 TypeScript 测试与 5 项 Rust 测试通过，构建和便携包更新通过。

便携包无界面检查通过：打包的 Electron/Node 运行时验证工程、读取两图层画稿、生成画稿与时间轴 PNG；打包版 MCP 与外部客户端连接成功，38 个工具可发现并返回画稿图片。修复了 Electron 内置 Node 模式的 CLI 参数解析。窗口启动检查被自动审批拒绝（工具未给出具体原因），此轮没有宣称完成窗口启动验证。

需要继续推进的 UI 部分：可停靠布局、更多剪辑手势与批量属性编辑、专业声音总线/场景内声音路由、完整速度图与空间切线、跨合成引用、专业绘画选区/笔刷与逐帧曝光表、缓存磁盘配额管理。代码生成内容的结构编辑保存在 `structure`，属性与动画保存在 `overrides`，源码保持可编程。

新合成与声音示例的生成脚本已建立，音频生成表达式转义已修正，但它的完整演示成片尚未验证。不要将这个示例的存在当成全片验收。

结构化参数示例已完成 8 秒 1920×1080/30fps、240 帧 MP4 导出，工程版本 c1b12508；数据数组数值与向量位置关键帧经由正式渲染管线完成。产物：examples/parameter-lab/exports/structured-parameters-1080p.mp4。

关键帧验收工程经过界面缩放/拖动/贝塞尔编辑后，正式导出 8 秒 1280×720/30fps、240 帧 MP4，工程版本 de82d33d。产物：artifacts/keyframe-retimed-preview.mp4；不修改用户工程来进行临时鼠标测试。

更广泛的能力与未完成项以 `AE-CAPABILITIES.md`、`ROADMAP.md` 为准。GPU、完整三维灯光、跟踪/转描、HDR、专业长片性能与正式媒体运行时打包都仍未完成，不应标记总体目标完成。
