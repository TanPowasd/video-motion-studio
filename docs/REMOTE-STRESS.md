# 远程协调压力测试

脚本：`scripts/stress-remote.mjs`（`npm run stress:remote -- [参数]`），不属于 `test:fast`。原始数据：`docs/remote-stress-results.json`。

## 方法

脚本创建临时工程，以子进程启动 `vmotion remote serve`，再在同一进程（可选 `--procs` 分摊到 worker）内模拟 N 个客机。每个客机注册 presence、保持一条 SSE `/api/remote/events` 长连接，并按角色循环：

- **disjoint**：各改自己的节点（可自动合并）；
- **conflict**：多人改同一属性（制造冲突，被拒后 pull 重试）；
- **viewer**：只读令牌，轮询 `status` / `pull`。

`mixed` 场景按 60% / 20% / 20% 分配角色。统计每档：提交吞吐、push / pull 延迟分位、拒绝率与错误码、SSE 存活与事件延迟、协调进程 RSS / CPU，并在结束时核对所有客机 revision 与主机一致、`vmotion validate` 通过。

参数：`--clients 1,10,50,100,200`、`--duration 25`（秒/档）、`--think 200`（毫秒）、`--scenario mixed|disjoint|conflict|viewer`、`--procs`、`--cpu-prof <dir>`、`--merge a.json,b.json`、`--out`。

## 环境

Linux arm64 沙箱，2 vCPU，7.8 GB，Node 22；压测端与协调节点同机（数值偏保守）。基于 7c35162（v0.1.5 之前的远程协调实现）。

## 结果（mixed，think 200 ms，每档 25 s）

| 客机 | 提交/秒 | push p50 / p95 | pull p50 | 同属性被拒 | 不同节点被拒 | 其他错误 | 峰值 RSS |
|---|---|---|---|---|---|---|---|
| 1 | 4.08 | 29 / 47 ms | 10 ms | – | 0% | 0 | 206 MB |
| 10 | **16.7** | 76 / 156 ms | 37 ms | 55% | 49.5% | 0 | 387 MB |
| 50 | 0.8 | 1.55 / 2.21 s | 797 ms | 99% | 93.7% | 0 | 468 MB |
| 100 | 0.32 | 6.87 / 7.39 s | 3.32 s | 96% | 96.3% | 0 | 483 MB |
| 200 | 0.08 | 13.7 / 15.6 s | 8.15 s | 100% | 98.3% | 0 | 682 MB |

- 所有被拒 push 均为 409；不同节点编辑者全部是 `REVISION_CONFLICT`，从未出现 `REMOTE_CONFLICT`（即并非真实内容冲突）。
- SSE：每档全部连接存活，变更事件 100% 送达，p95 延迟 ≤ 30 ms。
- 终态：每档所有客机最终与主机 revision 一致，无丢失更新，`vmotion validate` 通过。
- 协调进程 CPU 平均约 90–110%；200 个只读 viewer 仅轮询 status + SSE 没有问题。
- 仅同属性冲突：5 客机 15.7 提交/秒；20 客机降到 2.7/秒，92% 被拒。
- 99 个轮询 viewer 会把 pull 封顶在约 40 次/秒，并把唯一编辑者的 push p50 拉到 5.2 s。
- 50 客机重复测量波动 0.8–2.05 提交/秒。

结论：当前单协调节点可稳定支撑约 **10 个高频编辑者**；**≥ 50** 进入 `REVISION_CONFLICT` 活锁——几乎所有 push 被拒，几乎不产生提交。真实协作者推送频率远低于每 200 ms 一次，可容纳更多人，但未测；修复前建议同时编辑者 < 20。

## 瓶颈（50 客机 CPU profile）与建议，按收益排序

1. **push 的冲突判定窗口过宽**：`push()` 在 `exclusive` 内 reload，随后在锁外 merge + validate，最后 `commitSnapshot(expectedRevision)`；期间任何提交都会导致拒绝，即使能干净合并。重试又加重负载，形成正反馈。
   建议：整个 push 放在一个锁区间内完成，或在 `REVISION_CONFLICT` 时由服务端自动基于最新 revision 重新三路合并（rebase）。预计不同节点编辑的拒绝率降至 ≈0，吞吐维持在 ~16/s 上限附近而不崩溃。
2. **所有 pull / viewer 请求排在同一把全局锁后**：每次 pull 都从磁盘重载并全量 schema 解析整个工程（即使无变化），解析占 CPU 16.5%，另有 19.5% 时间 CPU 空闲等锁。
   建议：pull 直接读内存快照；`reload()` 先比较原始文本再解析，并按文件哈希缓存解析结果。
3. **presence 广播随人数平方增长**：每个请求都 `notePeer` 并推送完整 peers 列表，每条 SSE 连接各自重新序列化；200 客机 25 s 内产生 3.57 GB，占 CPU 8.2%；写入不处理背压，推高 RSS。`MAX_PEERS = 128` 淘汰的是最早连接者而非最久不活跃者，200 客机时约 72 个在线 peer 不在列表里且频繁抖动。
   建议：仅在可见变化时广播，节流并一次序列化共享给所有连接，遵守背压，改为真正的 LRU 淘汰。
4. 次要：每次 push 两次全量 validate、每次提交同步写历史；客户端重试应带指数退避与抖动。
