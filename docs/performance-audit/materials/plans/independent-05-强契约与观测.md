# 独立总案 05 · 强契约与观测

> **战役**：performance-fix  
> **视角**：强契约与观测——双发消除、message-start 瘦身、PE-02 合并禁令、Progress 裁决、relay 帧上限、压测进 CI、V 项回填、负向断言体系  
> **创建**：2026-09-13  
> **性质**：独立完整修复总案，不绑定主控 91 草稿；与 91 的分歧见 §12。  
> **纪律**：本方案禁止假装 PE-02 已解禁；禁止静默砍 Progress；全部变更须过负向断言与五端物证。

---

## 0. 全局效果锁定与契约铁律

### 0.1 效果锁（不可降级）

本方案不接受以下「简化」：

1. **不得**以「前端没读 sequence」为由保留非增量事件双发——双发消除的唯一合法路径是契约升级 + 消费端确认，不是沉默保留双轨；
2. **不得**以「message-start 没人用」为由在未升 schema 前单侧删字段——瘦身必须走 engine-events schema PR + registry_drift + 生成 parser 全链；
3. **不得**静默砍 Progress——构造侧删除 / 接线 / 停止构造三选一，须用户显式裁决并登记在案；
4. **不得**在 PE-02 评审通过前于 emit 源头做 token N 合 1——旁路减负合法，源头合并违规；
5. **不得**以「弱契约」（响应向后兼容）为名跳过 commandMap / manifest 登记新增字段。

### 0.2 契约分级与闸门定义

全部本视角内工作单元分为三级：

| 级别 | 含义 | 闸门要求 |
| ---- | ---- | -------- |
| **T0** | 无契约变更；纯内部优化 / 旁路减负 / 已建设施接线 | 负向断言 + 五端物证即可 |
| **T1** | 弱契约：参数增强 / 响应扩字段（向后兼容） | T0 + manifest 双端同步 + 生成 parser 重生成 + registry_drift 绿 |
| **T2** | 强契约：schema 变更 / 语义变更 / 新事件 / 载荷收缩 / 背压分级调整 | T1 + **独立评审票**（engine-events 全链）+ schemaVersion 升级 + golden 更新 + 旧字段根除负向 + wire 对比 |

### 0.3 防幽灵契约与截肢降级（铁律）

- **幽灵契约**：调用未注册命令 / 解析未登记字段 / 前端 parser 接受 schema 中不存在的变体——一律 fail（`registry_drift` 扩展到「前端 commandMap 调用 ⊆ manifest」+「parser case 集 ⊆ events.rs enum」）。
- **截肢降级**：以「字段删了反正没人用」为由在生产路径删除语义、又不在测试中删除对应断言——负向断言必须同步：删字段后旧字段**零出现**（grep 级 + 行为级），且新字段在消费端**真实读取**（非解析后丢弃）。
- **补丁禁令**：禁止为通过 schema 校验而添加空壳字段；禁止 `// schema-compat` 静默忽略未登记键；禁止 `#[allow(dead_code)]` 保护已声明「不消费」的字段。

---

## 1. 全局效果与维度划分

### 1.1 目标态（本视角下的事件与观测架构）

```text
【引擎发射】
  MessageDelta：逐事件流出（PE-02 保持；评审通过后允许同 block 追加合并）
  MessageStart：仅摘要（sessionId/messageId/role/turnIndex——评审后瘦身）
  MessageEnd：全文（唯一权威载荷）
  ToolStart：进入执行前实时桥（T0/T1）
  ToolEnd：实时桥 + 收口去重（T2）
  ToolBatch：NoPersist / 桥剔除（T2）
  Progress：有接线则实时流（T2）/ 无接线则停止构造并删除构造侧（用户裁决后 T0/T2）

【传输层】
  实时轨：sequence=None 预览，真缓冲（时间窗/水位）
  收口轨：对 webview 降为轻量回执（或完全免发）；旁路（WS/push）只取 meta / Arc 共享
  前端：数据面事件 parse 恰 1 次；resolveEventType 每事件 1 次

【relay】
  帧 PayloadLen ≤ MAX_RELAY_PAYLOAD_BYTES（对齐桌面 1MiB）
  last_active 转发/PING 均刷新

【观测】
  压测（EventBuffer 20 万）进 ci-slow
  startup-budget fail 化 + 接 CI / check:desktop
  全部 V 项经 4000 Tauri MCP 生产包回填
  负向断言全量接入 CI，随修复演进

【契约 SSOT】
  engine-events.json + events.rs + 生成 parser + registry_drift + golden
  任何变更须走 §0.2 闸门，禁止旁路
```

### 1.2 维度划分（六维）

| 维度 | 名称 | 覆盖发现 | 逻辑角色 |
| ---- | ---- | -------- | -------- |
| **D1** | 旁路减负与已建接线（T0） | 03-V1、03-V2、03-V3、03-V4、15-FAN01、15-PSHP03、15-XOV01（部分）、16-P3、16-P1、16-P2、15-RLY01、15-RLY02、10-T3（最小可行：ToolStart 实时） | **评审前合法减负**；不动 schema；可立即并行 |
| **D2** | 强契约升级（T2） | 03-R2、03-C1、03-C3、10-T3（Progress 全裁决）、03-R8 | **评审后实现**；schema + parser + 双端 |
| **D3** | PE-02 重开与源头合并（T2） | 03-R1、03-R7、簇 C1 最终收敛 | **评审后实现**；PE-02 §3.1.2 放宽 |
| **D4** | relay 正确性与帧上限 | 15-RLY01、15-RLY02、15-RLY04、15-RLY05、15-RLY06、15-SRV* | 正确性 + 有界；帧上限可 T0，对端兼容 T1 |
| **D5** | 压测进 CI 与门禁接线 | 16-P3、16-P1、16-P2、16-P14、06-PF01 | 观测资产从休眠到激活 |
| **D6** | V 项回填与负向断言体系 | 全部 V 项、负向断言全链 | **持续轨**；每阶段收口必须回填 |

---

## 2. 依赖与逻辑顺序

> 顺序 = 依赖拓扑；不谈工期、人员、业务优先级。逻辑同权。

```text
Layer 0  契约评审票启动（流程，非实现）
    │   ├─ PE-02 合并禁令评审（D3 前置）
    │   ├─ engine-events schema 变更评审（D2 前置）
    │   └─ Progress 裁决用户会签（D2 前置）
    ▼
Layer 1  旁路减负与已建接线（D1 / D4 / D5 部分）—— T0，可并行
    │   （不动 schema；为后续强契约变更铺平消费端）
    ▼
Layer 2  弱契约扩展（T1）——参数增强 / 响应扩字段
    │   （save_session_body 增量、background_tasks 统一）
    ▼
Layer 3  强契约升级（D2）——评审通过后实现
    │   （双发消除、message-start 瘦身、Progress 裁决落地、tool-batch NoPersist）
    ▼
Layer 4  PE-02 放宽与源头合并（D3）——评审通过后实现
    │   （同 block 追加合并、真缓冲、可见性背压）
    ▼
Layer 5  观测终态（D5 完成 + D6 全量回填）
        （压测、负向断言全绿、V 项闭环）
```

### 2.1 禁止顺序反例

1. 未完成 D1 旁路减负，不得直接改 schema（消费端未稳定，变更风险叠乘）；
2. 未升 schema 前，不得在 `message-start` 侧删字段或在 `tool-batch-*` 侧改 `persist` 标志；
3. PE-02 评审未通过，不得在 `streaming.rs` / `push_live` 做同 block 文本拼接；
4. Progress 裁决未落地，不得静默删除 `shell.rs` 的 `ToolProgress` 构造；
5. 压测未进 CI，不得声称「EventBuffer 背压已验证」；
6. V 项未回填，不得把「静态审查通过」当作「运行时收益确认」。

---

## 3. 维度详案

### D1 · 旁路减负与已建接线（T0 · 评审前）

#### D1.1 数据面事件 parse 恰 1 次（03-V1）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-V1 |
| 文件域 | `apps/crish-desktop/src/api/chat-bridge/EventRouter.ts`、`dataPlaneRouter.ts`、`src/api/transport/tauriTransport.ts` |
| 逻辑步骤 | ① `EventRouter.onMsg` 在 `resolveEventType` 后立即 `isDataPlaneEventType(envelope.type)` 短路，不进 `parseBridgeEvent`；② `resolveEventType` 结果随 parsed 对象复用（fanout 处解析一次，向订阅者传递 `{type, raw}`）；③ 单测断言：数据面事件 `parseBridgeEvent` 调用计数 = 1 |
| 契约 | T0 |
| 负向断言 | `EventRouter` 测试：task-*/timer-*/cron-fired 在 EventRouter 侧 parse 计数 0；dataPlaneRouter 侧仍 = 1 |
| 删除面 | 删除 `EventRouter` 中「解析后才过滤数据面事件」的无效路径 |

#### D1.2 轮询双源收敛（03-V2 + I5）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-V2、03-I5 |
| 文件域 | `src/components/chat-card/useBackgroundTaskPolling.ts`、`useEngineState.ts`、`FlowDagView.tsx` |
| 逻辑步骤 | ① 链 B（`useBackgroundTaskPolling`）改为订阅 `engineStore.bgTasks`（链 A 已拉取），或删除链 B；② `FlowDagView` 的 `get_flow_snapshot` 补超时；③ 空转定时器（`getSubagentStatus` 恒 null 零 IPC）删除死代码 |
| 契约 | T0（不改命令响应形状） |
| 负向断言 | 稳态 `list_background_tasks` IPC 计数减半（探针）；`useBackgroundTaskPolling` 不再直接 invoke |
| 删除面 | `useBackgroundTaskPolling` 独立轮询路径；`getSubagentStatus` 死定时器 |

#### D1.3 invoke 悬挂治理（03-V3）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-V3 |
| 文件域 | `src/api/transport/tauriTransport.ts`、`tauriInvoke.ts` |
| 逻辑步骤 | ① `kind` 分类接入重试判定（`InvalidInput`/`NotFound` 不重试）；② 轮询 tick 加 in-flight 互斥；③ 重试加微退避 |
| 契约 | T0 |
| 负向断言 | 引擎卡死模拟下悬挂 invoke 数 ≤ 1；无效输入不触发重试 |

#### D1.4 水合可取消 + 增量投影（03-V4）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-V4 |
| 文件域 | `src/api/sessionEventHydrate.ts` |
| 逻辑步骤 | ① `AbortSignal` 贯穿 `fetchSessionEvents`；② 每页投影后丢弃原始事件；③ 可选并发预取下一页 |
| 契约 | T0 |
| 负向断言 | 切会话后 0 新增 IPC；40k 事件会话打开内存峰值下降 |

#### D1.5 旁路 meta-only / Arc 共享（03-R5、15-FAN01、15-PSHP03、15-XOV01 部分）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-R5、15-FAN01、15-PSHP03、15-XOV01 |
| 文件域 | `apps/agent-workbench/src-tauri/src/server/fanout.rs`、`push/pusher.rs` |
| 逻辑步骤 | ① `parse_event_meta` 改为：信封顶层已扁平——`serde_json::from_slice` 部分解析（先小缓冲找 `"type"` 键）或 emit 侧同步产出轻量 meta 结构（emit 一次构造，旁路零解析）；② 删除 `from_value(value.clone())` 深拷贝；③ push 侧 `on_event` 同改 meta-only；④ 多端开启时每事件 JSON 解析次数：webview 1 次（序列化）+ fanout 0 次全量 + push 0 次全量 = 收敛 |
| 契约 | T0（元字段语义不变） |
| 负向断言 | `parse_event_meta` 无 `from_value(value.clone())`；fanout 无全量 `AgentEvent` 反解析热路径；XOV01 多端解析次数 ≥3 → ≤1 可测 |
| 删除面 | `fanout.rs` 的 `value.clone()` 路径；`pusher.rs` 的全量 `AgentEvent` 反解析 |

#### D1.6 relay 帧上限（15-RLY02 · T0 内部）

| 项 | 内容 |
| -- | ---- |
| 发现 | 15-RLY02 |
| 文件域 | `crates/conex-relay/src/protocol.rs` |
| 逻辑步骤 | ① 引入 `MAX_RELAY_PAYLOAD_BYTES`（对齐桌面 `conex-types/src/device/version.rs:227` 的 1MiB）；② `decode` 超限直接 bail；③ `encode` 侧 debug_assert；④ 单测：超限帧拒绝；⑤ roundtrip 测试保留 |
| 契约 | T0（中继内部）；若移动端有独立帧上限约定，升 T1 联审 |
| 负向断言 | `payload_len > MAX_RELAY_PAYLOAD_BYTES` 时 decode 返回 Err；现有 roundtrip 全绿 |
| 预算常量 | 进 `perf_budget` 模块（与 D5 同源） |

#### D1.7 relay last_active 刷新（15-RLY01）

| 项 | 内容 |
| -- | ---- |
| 发现 | 15-RLY01 |
| 文件域 | `crates/conex-relay/src/session.rs`、`server.rs` |
| 逻辑步骤 | ① `last_active` 改 `AtomicU64` monotonic ms（避免 read 路径升级 write）；② `forward_frame` 成功 / PING 处理成功后 touch；③ GC 按新 last_active 判定；④ 单测：转发后 sleep 模拟不误清；无活动 91s 清 |
| 契约 | T0 |
| 负向断言 | 转发一帧后 `clean_stale_sessions` 不清 peer；join 后无活动 91s 清 peer |

#### D1.8 ToolStart 实时桥（10-T3 最小可行 · T0 范围内）

| 项 | 内容 |
| -- | ---- |
| 发现 | 10-T3 |
| 文件域 | `crates/session-loop/src/loop/handlers/executing_tools.rs`、`exec_single.rs` |
| 逻辑步骤 | ① 顺序路径与并行组：`ToolStart` 在进入执行前经独立 `LiveEventSink` / 实时桥推送（不走持久化 events Vec）；② `ToolEnd` 仍收口持久化（收口去重属 D2）；③ 审批 requested 已有事件语义对齐前端；④ **Progress 全裁决不在本步**——本步只做 ToolStart 实时，不碰 `progress: None` |
| 契约 | T0（ToolStart 事件类型不变，仅发射时机提前；顺序契约 01 §五.6 需同步评审——若顺序契约要求「批收口广播」，升 T2） |
| 负向断言 | 并行组 N 个工具：前端在执行期间看到 N 个 tool-start（非批结束后同时涌入）；`emit_tool_events` 仍处理 ToolEnd/批事件 |
| 约束 | **禁止在未升 schema 前私自加事件类型**；ToolStart 实时 = 改发射时机，不改事件形状 |

#### D1.9 EventBuffer 压测进 ci-slow（16-P3）

| 项 | 内容 |
| -- | ---- |
| 发现 | 16-P3 |
| 文件域 | `.github/workflows/ci-slow.yml` |
| 逻辑步骤 | ① `ci-slow.yml` 增加 job：`cargo test -p crish-agent-workbench --release -- --ignored stress_ --nocapture`；② 事件/秒解析进 `::notice` 或 `perf-report/`；③ 可选：软水位/丢帧计数导出为可断言纯函数指标 |
| 契约 | T0 |
| 负向断言 | ci-slow 存在 `stress_` 步骤；破坏 Critical 必达的改动 → job 红 |
| 防回潮 | 丢帧语义（Critical 必达 / Soft 旧帧可丢）成为自动回归资产 |

#### D1.10 startup-budget fail 化 + CI 接线（16-P1 + 16-P2）

| 项 | 内容 |
| -- | ---- |
| 发现 | 16-P1、16-P2 |
| 文件域 | `scripts/check-startup-budget.mjs`、`.github/workflows/ci.yml`、`package.json` |
| 逻辑步骤 | ① `totalBytes` 进 warnings/errors（不再纯信息）；② `ci.yml` frontend-build 在 `check-dist` 后追加 `node scripts/check-startup-budget.mjs`；③ 与 check-dist 真源重叠（16-P14）：统一阈值口径，避免双套数字 |
| 契约 | T0 |
| 负向断言 | 静态图超预算时 CI 红；`check:desktop` 链含 startup-budget |

#### D1.11 relay 连接上限 + join_room 清理（15-RLY04 + RLY05）

| 项 | 内容 |
| -- | ---- |
| 发现 | 15-RLY04、15-RLY05 |
| 文件域 | `crates/conex-relay/src/server.rs`、`session.rs` |
| 逻辑步骤 | ① `RELAY_MAX_CONNS` 环境变量 + 默认（如 4096）；超限拒绝 WS 升级；② `join_room` 签名改为只返回 `session_token`（删除空壳 `mpsc::channel(1)`）；③ secret 改 `Arc<str>` |
| 契约 | T0 |
| 负向断言 | 超限拒绝测试；现有转发单测不变 |

#### D1.12 丢帧 warn 聚合（16-P4）

| 项 | 内容 |
| -- | ---- |
| 发现 | 16-P4 |
| 文件域 | `apps/agent-workbench/src-tauri/src/engine_channels.rs` |
| 逻辑步骤 | ① 丢帧 warn 移到 flush 聚合点（与 EmitReport.dropped 汇总一致），或按 run_id「首次 + 每 N 条 + 终态汇总」限速；② 计时保留（µs 级可接受） |
| 契约 | T0 |
| 负向断言 | 高丢帧场景 warn 次数 O(1)/O(轮次) 而非 O(丢帧次数) |

---

### D2 · 强契约升级（T2 · 评审后实现）

> **前置**：D1 全部完成；评审票（§4.1）通过；Progress 裁决会签完成。

#### D2.1 非增量事件双发消除（03-R2）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-R2 |
| 文件域 | `crates/conex-types/contracts/engine-events.json`、`crates/conex-types/src/events.rs`、`apps/agent-workbench/src-tauri/src/run/run_idle.rs`、`crates/session-loop/src/loop/handlers/mod.rs`、`packages/shared-types/src/generated/engine/parser.ts` |
| 契约变更 | 收口轨对 webview 降级为**轻量 sequence 回执**（`{type:"<event-type>", runId, sequence, eventId}` 摘要信封，不含 payload），或实时轨预分配 sequence（批量预取区间），收口轨 webview 完全免发；新增 `sequenceOnly` 标记或新回执事件类型，升 schemaVersion |
| 逻辑步骤 | ① 评审票通过；② 升 schemaVersion；③ `engine-events.json` 增回执事件 / 信封 `sequenceOnly` 字段；④ `events.rs` 同步 enum；⑤ `run_idle.rs` 收口循环：非 delta 事件若实时轨已发，webview 只发回执；⑥ 生成 parser 重生成；⑦ `registry_drift` + golden 更新；⑧ WS 扇出/push 旁路：保留完整事件给旁路（旁路走事件存储读取而非二次 emit）；⑨ 前端：按需消费回执（现状无消费者，回执仅日志级——保留消费端接口以备将来对账） |
| 负向断言 | run 全周期 wire 抓包：非增量事件跨 IPC 次数 = 1（回执不计 payload）；旧「全文双发」路径 grep 0 命中；`registry_drift` 绿 |
| 五端物证 | 触发端：真实 UI 发起 run；传输端：回执事件在 manifest；介质端：events 表落库 1 份（收口）；消费端：前端 EventRouter 正常处理；负向：旧全文双发路径根除 |
| 风险 | WS 扇出/push 依赖收口轨完整事件——保留完整事件给旁路，webview 单独降级 |

#### D2.2 message-start 载荷降摘要（03-C1）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-C1 |
| 文件域 | `engine-events.json`、`events.rs`、`loop/handlers/mod.rs`、`streaming.rs`、`parser.ts`、`messageHandlers.ts`（已空实现，不改） |
| 契约变更 | message-start 载荷降为摘要 `{sessionId, messageId, role, turnIndex}`；schemaVersion 升级；`registry_drift` + 生成 parser 同步；replay 投影不变（只读 end） |
| 逻辑步骤 | ① 评审票通过；② `engine-events.json` message-start fields 收缩；③ `events.rs` MessageStart 变体同步；④ `mod.rs` / `streaming.rs` 成对发射时 start 只带摘要；⑤ 生成 parser 重生成；⑥ 前端：`onMessageStart` 仍空实现（消费面为空已由 `handlerBehavior.test.ts` 锚定）；⑦ golden 更新；⑧ 旧字段（message 全文）根除负向 |
| 负向断言 | message-start payload 无 `message` 字段（grep 级）；message-end 仍携带全文；replay 投影测试全绿；`registry_drift` 绿 |
| 五端物证 | 触发端：真实 run；传输端：schema 契约在 manifest；介质端：events 表 message-start 行 payload 无全文；消费端：前端 handler 零改动；负向：旧全文字段根除 |
| 风险 | 低（消费面为空）；`parseAgentMessage` 递归校验不再对 start 触发 |

#### D2.3 tool-batch 双事件降 NoPersist / 桥剔除（03-C3）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-C3 |
| 文件域 | `engine-events.json`、`events.rs`、`parser.ts`、`toolHandlers.ts`（空实现） |
| 契约变更 | tool-batch-start/end 降 `persist:false`（NoPersist）或从实时桥剔除只留落库审计；升 schemaVersion |
| 逻辑步骤 | ① 评审票通过；② `engine-events.json` 两事件 `persist:false`；③ 前端 `parseBridgeEvent` 前按类型短路跳过 strict 校验（与 D1.1 同一机制）；④ 水合投影确认 replay 本就不消费；⑤ golden 更新 |
| 负向断言 | tool-batch 事件落库计数 0（或仅审计轨）；前端 strict parser 对 batch 事件 0 调用；`registry_drift` 绿 |

#### D2.4 Progress 裁决落地（10-T3 全裁决）

| 项 | 内容 |
| -- | ---- |
| 发现 | 10-T3 |
| 文件域 | 视裁决路径而定 |
| 裁决路径 | **三选一，用户会签，禁止静默砍** |
| 路径 A · 接线 | 新增 `tool-progress` 非持久事件（schema 新增）；执行器 `progress` 回调接线；shell `execute_stream` 的 `ToolProgress` 构造接上桥；前端消费（Terminal 增量输出 / 卡片进度） |
| 路径 B · 停止构造 | 删除 shell `execute_stream` 的 `ToolProgress` 构造（省 CPU）；执行器 `progress: None` 保持；**不新增事件类型**；会签记录「Progress 功能正式下线，省 CPU」 |
| 路径 C · 部分接线 | 仅 shell 路径接线（最高频）；其他工具保持 None；登记「后续工具接线」为独立任务 |
| 逻辑步骤 | ① 用户会签选路径；② 路径 A：schema 新增 + 双端实现 + 负向；③ 路径 B：删除构造侧 + 负向（`ToolProgress` 构造 grep 0 命中）；④ 路径 C：shell 接线 + 其他工具登记 |
| 负向断言 | 路径 A：tool-progress 事件在 manifest + 前端消费；路径 B：`ToolProgress` 构造 0 命中 + 会签记录；路径 C：shell 路径 tool-progress 流 + 其他工具无构造 |
| **禁止** | 未会签前删除构造；未升 schema 前私自加 `tool-progress` 类型；静默砍 |

#### D2.5 可见性背压（03-R8 · 部分依赖 D3）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-R8 |
| 文件域 | `engine_channels.rs`、`core_event_bridge.rs`、`tauriTransport.ts` |
| 契约变更 | 设计评审（非 schema 强变更，但涉及桥层语义） |
| 逻辑步骤 | ① 最小化档：Tauri 窗口焦点/最小化事件 → 桥层降频（flush 周期放大到 200ms）；② 完整档：前端可见性信号回传（invoke 注册），隐藏时 delta 走 EventBuffer 缓冲、可见时 flush——**依赖 D3 真缓冲化**；③ 恢复可见时的文本完整性（缓冲未丢帧，EventBuffer 压测覆盖） |
| 负向断言 | 最小化窗口 CPU 对比（下降 ≥80%）；恢复可见时累计文本逐字节等价 |

---

### D3 · PE-02 放宽与源头合并（T2 · 评审后实现）

> **前置**：PE-02 评审票通过（§4.1）；D1 完成（消费端稳定）。

#### D3.1 同 block 追加合并（03-R1）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-R1 |
| 文件域 | `crates/session-loop/src/provider.rs`（契约注释）、`loop/handlers/streaming.rs`、`engine_channels.rs`、`push/pusher.rs`、`server/fanout.rs` |
| 契约变更 | PE-02 §3.1.2 放宽为「允许同 messageId+block 类型的追加合并，禁止乱序/丢弃」；升 schemaVersion（信封无需变，delta 语义不变）；`provider.rs` 契约注释同步 |
| 逻辑步骤 | ① 评审票通过（PE-02 重开）；② `provider.rs:191-193` 契约注释放宽；③ `BridgeLiveSink::push_live` 内加 8–16ms 时间窗微批（同 session+messageId 的 TextDelta 文本拼接后合并 emit）；④ 合并保持顺序（前端 batcher 语义一致）；⑤ 合并正确性测试（合并前后前端累计文本逐字节等价）；⑥ `buffer.rs` 20 万条压测全绿 + 末尾 delta 延迟 ≤ 窗口上限；⑦ `streaming_incremental_contract.rs` 锚点更新（合并后仍满足收敛性：全文 == delta 拼接） |
| 负向断言 | 合并前后前端累计文本逐字节等价；乱序/丢弃测试红；`streaming_incremental_contract` T1–T4 全绿（合并语义下）；PE-02 契约注释与代码一致 |
| 五端物证 | 触发端：真实 run；传输端：delta 事件在 manifest（形状不变）；介质端：收口 events 表 delta 不落库（NoPersist）；消费端：前端 batcher 累加正确；负向：跨帧/乱序/丢弃路径根除 |
| **禁止** | 评审前在 `streaming.rs` / `push_live` 做拼接；跨 message/block 合并；丢弃 delta |

#### D3.2 真缓冲化（03-R7）

| 项 | 内容 |
| -- | ---- |
| 发现 | 03-R7 |
| 文件域 | `engine_channels.rs`、`engine_channels/src/buffer.rs` |
| 逻辑步骤 | ① `push_live` 改为「入队 + 条件 flush（时间窗到期或 Critical 水位）」，缓冲层从伪缓冲变为真节流点；② 与 D3.1 合并方案一体；③ 补时间窗 flush 的及时性测试（末尾 delta 延迟 ≤ 窗口 + flush 周期） |
| 契约 | T0（缓冲内部）；与 D3.1 联动 |
| 负向断言 | 实时轨缓冲水位/时间窗测试；末尾 delta 延迟 ≤ 窗口上限 |

---

### D4 · relay 正确性与帧上限

> 与 D1.6/D1.11 重叠部分已在 D1 完成；本维补充剩余项。

#### D4.1 Pong 回环修复（15-RLY06）

| 项 | 内容 |
| -- | ---- |
| 发现 | 15-RLY06 |
| 文件域 | `crates/conex-relay/src/server.rs`、`protocol.rs` |
| 逻辑步骤 | ① Pong 写回发送方连接的 `tx_to_peer`（join 时把本连接 tx 与 role 绑定后，PING 分支直接 `tx.send(Pong)`）；或删除应用层 Ping 依赖 WS 控制帧；② 单测：client 发 Ping，同一 client 的 rx 收到 Pong |
| 契约 | T0（修复功能缺陷） |
| 负向断言 | Ping 回环测试；现有转发单测不变 |

#### D4.2 房间锁优化（15-RLY03）

| 项 | 内容 |
| -- | ---- |
| 发现 | 15-RLY03 |
| 文件域 | `crates/conex-relay/src/session.rs`、`server.rs` |
| 逻辑步骤 | ① secret 改 `Arc<str>`（已在 D1.11）；② `PeerJoined` 通知移出 write 临界区（先 clone tx 再 drop 锁）；③ 房间表保持 RwLock（规模未到前不拆 sharded map） |
| 契约 | T0 |
| 负向断言 | 现有转发单测不变；可选并发 join bench |

#### D4.3 SRV 面治理（15-SRV01–SRV04）

| 项 | 内容 |
| -- | ---- |
| 发现 | 15-SRV01、15-SRV02、15-SRV03、15-SRV04 |
| 文件域 | `apps/agent-workbench/src-tauri/src/server/ws.rs`、`fanout.rs` |
| 逻辑步骤 | ① SRV01：WS 出站 Critical 满缓冲时 await send 改为非阻塞（或超时）；② SRV02：device_activities 全量克隆改为引用/Arc；③ SRV03：`WsBroadcast::publish` 持锁遍历改为先 clone tx 列表再发送；④ SRV04：Critical 超限「必达」时队列有上界（溢出策略明确） |
| 契约 | T0 |
| 负向断言 | 出站队列有界；Critical 溢出可观测 |

---

### D5 · 压测进 CI 与门禁接线

> 与 D1.9/D1.10 重叠部分已在 D1 完成；本维补充 criterion 覆盖与真源合并。

#### D5.1 criterion 覆盖 perf 域（16-P8）

| 项 | 内容 |
| -- | ---- |
| 发现 | 16-P8 |
| 文件域 | `apps/agent-workbench/src-tauri/benches/`、`crates/conex-markdown/benches/` |
| 逻辑步骤 | ① 修 `perf/diff` O(n²) 行号（16-P9）；② 补 `EventBuffer` / `perf/jsonl` / `perf/encoding` criterion 基线；③ ci-slow 已跑 `cargo bench --workspace`——新 bench 自动生效；④ baseline compare（仿 `compare-benchmarks.ts`） |
| 契约 | T0 |
| 负向断言 | criterion 基线存在；ci-slow 跑 bench；diff O(n²) 修复后基线更新 |

#### D5.2 统一 diff 解析 SSOT（16-P5）

| 项 | 内容 |
| -- | ---- |
| 发现 | 16-P5 |
| 文件域 | 涉及双实现的 diff 解析文件 |
| 逻辑步骤 | ① 裁决唯一 SSOT；② 物理删除双实现之一；③ 负向：旧实现 grep 0 命中 |
| 契约 | T0 |
| 负向断言 | 唯一 diff 实现；双实现之一根除 |

#### D5.3 perf 资产接线（16-P6、16-P7、06-PF01）

| 项 | 内容 |
| -- | ---- |
| 发现 | 16-P6、16-P7、06-PF01 |
| 文件域 | `apps/agent-workbench/src-tauri/perf/`、`conex-fs` |
| 逻辑步骤 | ① `perf/jsonl` 死资产：评估接入 `core_messages_to_jsonl` 或删除；② `perf/fs` mmap `read_chunk`：评估接入预览分页读（06-S）或明确「保留 bench 资产、不接生产」并写入路线图；③ 负向：零消费资产要么接线要么删除 |
| 契约 | T0 |
| 负向断言 | 零消费 perf 资产 0 个（接线或删除） |

#### D5.4 store-writes 与 line-counts 加固（16-P12、16-P13）

| 项 | 内容 |
| -- | ---- |
| 发现 | 16-P12、16-P13 |
| 文件域 | `scripts/check-no-raw-setstate.mjs`、`scripts/check-line-counts.mjs` |
| 逻辑步骤 | ① store-writes：多行 DEV 豁免 + 跨行检测；② line-counts：`__tests__` 目录不整体跳过（只跳测试文件）；③ 夹具单测 |
| 契约 | T0 |
| 负向断言 | 多行 DEV 不误报；跨行漏报修复 |

---

### D6 · V 项回填与负向断言体系（持续轨）

#### D6.1 V 项回填流程

| 项 | 内容 |
| -- | ---- |
| 发现 | 90 §5 全部 V 项（16 主题簇） |
| 文件域 | 各报告 V 项小节 + 90 §5 表 |
| 逻辑步骤 | ① 每阶段收口前，经 **4000 Tauri MCP** 生产包（debug 构建）回填对应 V 项；② 禁止 9222/浏览器插件/仅 5174 独立页；③ 回填时更新各报告对应小节 + 90 §5 表登记日期与结论摘要；④ V 项状态初始「待测」→ 回填后「已测/结论」 |
| 契约 | T0（观测流程） |
| 负向断言 | 90 §5 表无「待测」项（全量回填后）；回填记录含日期 + 结论摘要 |

#### D6.2 优先 V 项（本视角相关）

| V 项 | 主题 | 成功判据 | 通道 |
| ---- | ---- | -------- | ---- |
| 03-V1 | 双发确认 | 非增量事件双发比 = 2.0（修复前基线） | tracing + MCP |
| 03-V4 | 数据面双解析 | task-* 事件解析 ×2（修复前）→ ×1（修复后） | MCP + 计数 |
| 03-V7 | 旁路 parse | 大 payload 事件 >1ms/条（修复前）→ meta-only 后 <0.1ms | MCP |
| 03-V8 | 最小化 CPU | 与前台无差异（修复前）→ 下降 ≥80%（修复后） | MCP |
| 10-V3 | ToolStart 实时 | 并行组 N 工具：执行期间看到 N 个 tool-start | MCP |
| 10-V4 | Progress | 视裁决路径：路径 A 有 tool-progress 流 / 路径 B 构造 0 命中 | MCP + grep |
| 15-V2 | pending 有界 | pending_len ≤ 上限 | 诊断字段 |
| 15-V4 | relay 活跃 | 双客户端持续互发 10min 不被 GC | GC 日志 |
| 15-V5 | 多端 emit | 8 设备连接下 emit P50/P99（多端开 vs 关） | 微基准 |
| 16-V1 | 静态图 | 静态图合计真实值 | 生产 build + 门禁 |
| 16-V6 | EventBuffer | 有界后队列 ≤ 水位；压测不进红 | 采样 + stress |
| 全部 | 契约回归 | schemaVersion 升级后旧前端容忍（fail-open 测试） | 测试 |

#### D6.3 负向断言体系

| 项 | 内容 |
| -- | ---- |
| 逻辑步骤 | ① 每修一类问题，同步加强对应防御脚本 / 守护单测；② 负向断言覆盖（但不限于）： |

**负向断言清单（本视角）**：

| 断言 | 类型 | 依赖维度 |
| ---- | ---- | -------- |
| 数据面事件 parse 恰 1 次 | 测试探针 | D1.1 |
| `list_background_tasks` 单源 | IPC 计数 | D1.2 |
| `parse_event_meta` 无全量 `from_value(value.clone())` | grep | D1.5 |
| `payload_len ≤ MAX_RELAY_PAYLOAD_BYTES` | 单测 | D1.6 |
| 转发后 `last_active` 刷新 | 单测 | D1.7 |
| EventBuffer stress 进 ci-slow | CI job | D1.9 |
| 静态图超预算 CI 红 | CI | D1.10 |
| 非增量事件跨 IPC 恰 1 遍 | wire 对比 | D2.1 |
| message-start 无 `message` 全文字段 | grep + schema | D2.2 |
| tool-batch NoPersist | 落库计数 | D2.3 |
| Progress 裁决路径 A/B/C 各自负向 | grep + 事件流 | D2.4 |
| 合并前后累计文本逐字节等价 | 单测 | D3.1 |
| 乱序/丢弃 delta 路径 | 单测红 | D3.1 |
| `registry_drift` 绿 | 测试 | 全部 |
| 旧字段根除（schema 升级后） | grep + 行为 | D2 |
| 零消费 perf 资产 0 个 | grep | D5.3 |

---

## 4. 契约评审票（必须评审后才能动）

### 4.1 评审票清单

| 评审票 | 阻塞的实现 | 评审内容 | 前置 |
| ------ | ---------- | -------- | ---- |
| **PR-PE-02** | D3.1、D3.2、03-R1 | PE-02 §3.1.2 放宽：允许同 block 追加合并；禁止乱序/丢弃；合并正确性测试方案；`streaming_incremental_contract` 锚点更新 | D1 完成（消费端稳定） |
| **PR-SCHEMA** | D2.1、D2.2、D2.3、D2.4-A | engine-events schema 变更：双发回执 / message-start 瘦身 / tool-batch NoPersist / tool-progress 新增；schemaVersion 升级；golden 更新；旧字段根除 | D1 完成 |
| **PR-PROGRESS** | D2.4 全路径 | Progress 裁决：三选一（接线 / 停止构造 / 部分接线）；用户会签 | 无（可与 D1 并行启动） |
| **PR-RELAY-FRAME** | D1.6 若移动端有独立约定 | relay 帧上限与移动端兼容 | D1.6 内部实现（T0）可先做 |
| **PR-ORDER** | D1.8 若顺序契约要求「批收口广播」 | ToolStart 实时桥是否违反 01 §五.6 事件顺序契约 | D1.8 实现前 |

### 4.2 评审通过标准

1. 变更清单完整（schema / parser / 生成脚本 / golden / registry_drift / 前端消费端）；
2. 负向断言设计（旧字段根除 + 新字段真实消费）；
3. 五端物证清单；
4. 回归风险与锚点测试；
5. 无幽灵契约 / 无截肢降级。

---

## 5. 评审前合法旁路减负（汇总）

> 以下工作单元**不触碰 schema / PE-02**，可在评审期间并行执行，为后续强契约变更铺平消费端：

| 单元 | 发现 | 效果 |
| ---- | ---- | ---- |
| D1.1 数据面 parse ×1 | 03-V1 | 消费端稳定，schema 变更后前端 parse 面收敛 |
| D1.2 轮询双源 | 03-V2 | IPC 面收敛 |
| D1.3 invoke 悬挂 | 03-V3 | 引擎卡死时无堆积 |
| D1.4 水合可取消 | 03-V4 | 大会话打开体验 |
| D1.5 旁路 meta-only | 03-R5、15-FAN01 | 多端开启时解析次数收敛；schema 变更后旁路零全量 parse |
| D1.6 relay 帧上限 | 15-RLY02 | OOM 面消除 |
| D1.7 relay last_active | 15-RLY01 | 功能缺陷修复 |
| D1.8 ToolStart 实时 | 10-T3 最小 | 前端在执行期间看到工具启动 |
| D1.9 压测进 CI | 16-P3 | EventBuffer 背压成为自动回归资产 |
| D1.10 门禁接线 | 16-P1/P2 | 启动体积成为硬门禁 |
| D1.11 relay 连接上限 | 15-RLY04 | 洪水防护 |
| D1.12 丢帧 warn 聚合 | 16-P4 | 日志 IO 收敛 |
| D4.1–D4.3 relay 剩余 | 15-RLY03/05/06、SRV* | 正确性 + 有界 |

---

## 6. 本方案要删掉什么 / 收敛什么

> 按主控 v3 §二要求，每条修复任务回答「这个概念现在几条路径 → 收敛到几条」。

| 概念 | 现状路径数 | 收敛到 | 删除/收敛动作 |
| ---- | ---------- | ------ | -------------- |
| 数据面事件 parse | 2（dataPlaneRouter + EventRouter） | 1 | D1.1：EventRouter 短路，数据面只在 dataPlaneRouter parse |
| 轮询 `list_background_tasks` | 2（useEngineState 4s + useBackgroundTaskPolling 3s） | 1 | D1.2：链 B 订阅 store 或删除 |
| 旁路 meta 解析 | 2（fanout 全量 parse + push 全量 parse） | 1（meta-only 共享） | D1.5：emit 侧一次构造 meta，旁路零全量 parse |
| 实时轨缓冲 | 2（伪缓冲 + 立即 flush） | 1（真缓冲） | D3.2：push_live 改条件 flush |
| message-start 载荷 | 1（全文） | 1（摘要） | D2.2：瘦身（不删事件，删冗余载荷） |
| 非增量事件 webview 发射 | 2（实时 + 收口全文） | 1（实时全文 + 收口回执） | D2.1：收口轨 webview 降回执 |
| tool-batch 落库 | 1（persist:true） | 0（NoPersist） | D2.3：降 NoPersist（概念收敛为「不再独立落库」） |
| Progress 构造 | 1（构造后丢弃） | 视裁决：1（接线）或 0（停止构造） | D2.4：会签后收敛 |
| diff 解析 | 2（双实现） | 1（SSOT） | D5.2：物理删除双实现之一 |
| perf 资产零消费 | 多个（jsonl/mmap/incremental highlight） | 0 或 1（接线） | D5.3：接线或删除 |
| relay Pong 路径 | 1（错误转发给对端） | 1（正确回环） | D4.1：修复（不增路径） |
| 体积门禁 | 2（check-dist + startup-budget，真源重叠） | 1（真源合并） | D1.10 + D5：统一阈值口径 |
| 旧 schema 字段（message-start.message、tool-batch persist） | 1（存在） | 0 | D2.1–D2.3：schema 升级后物理删除 + 负向根除 |
| PE-02 禁止合并注释 | 1（严格禁止） | 1（放宽为同 block 追加合并） | D3.1：评审后修订（不删约束，改约束内容） |

**经主控验证，本视角内无「纯新增无旧路径可删」项**——全部工作单元均含删除/收敛动作。

---

## 7. 文件域与并行边界

| 单元 | 主要文件域 | 并行边界 |
| ---- | ---------- | -------- |
| **U-XPORT-FE** | `EventRouter.ts`、`dataPlaneRouter.ts`、`tauriTransport.ts`、`tauriInvoke.ts`、`sessionEventHydrate.ts`、`useBackgroundTaskPolling.ts`、`useEngineState.ts`、`FlowDagView.tsx` | 与 U-EVENT / U-SCHEMA 无交集 |
| **U-BYPASS-RS** | `fanout.rs`、`pusher.rs`、`engine_channels.rs`、`core_event_bridge.rs` | 与 U-SCHEMA / U-PE02 无交集（D1 阶段）；D2/D3 阶段与 U-SCHEMA / U-PE02 串行 |
| **U-RELAY** | `crates/conex-relay/src/{protocol,session,server}.rs` | 独立 crate，与一切无交集 |
| **U-TOOLSTART** | `executing_tools.rs`、`exec_single.rs` | 与 U-SCHEMA（Progress）串行（同一文件区） |
| **U-SCHEMA** | `engine-events.json`、`events.rs`、`parser.ts`、`mod.rs`、`streaming.rs`、`run_idle.rs`、`messageHandlers.ts` | **强契约区**；评审后单 Agent 主责；与 U-XPORT-FE / U-BYPASS-RS 串行 |
| **U-PE02** | `provider.rs`、`streaming.rs`、`engine_channels.rs`、`pusher.rs`、`fanout.rs`、`streaming_incremental_contract.rs` | **PE-02 区**；评审后单 Agent 主责；与 U-SCHEMA / U-TOOLSTART 串行 |
| **U-CI** | `ci.yml`、`ci-slow.yml`、`check-startup-budget.mjs`、`package.json` | 与一切无交集 |
| **U-BENCH** | `benches/`、`perf/`、`conex-fs` | 与一切无交集 |
| **U-NEG** | 全部 check-* 与守护单测 | 只读依赖各单元；收口时统一更新 |

**并行规则**：

1. D1 阶段：U-XPORT-FE / U-BYPASS-RS / U-RELAY / U-TOOLSTART / U-CI / U-BENCH 可并行（文件域不相交）；
2. D2 阶段：U-SCHEMA 单 Agent 主责；U-XPORT-FE 若有交集（parser 消费）串行；
3. D3 阶段：U-PE02 单 Agent 主责；U-BYPASS-RS（缓冲）串行合并；
4. 跨单元只允许只读依赖或主控协调串行合并。

---

## 8. 验收：功能 + 负产出 + 五端物证

### 8.1 功能验收（按维度）

| 维度 | 功能验收 |
| ---- | -------- |
| D1 | 数据面 parse ×1；轮询单源；invoke 无悬挂；水合可取消；旁路 meta-only；relay 帧有界 + last_active 刷新 + Pong 回环；ToolStart 实时；压测进 CI；门禁 CI 红 |
| D2 | 非增量事件跨 IPC ×1；message-start 无全文；tool-batch NoPersist；Progress 裁决落地；可见性背压 |
| D3 | 合并前后累计文本等价；乱序/丢弃测试红；真缓冲时间窗及时性 |
| D4 | relay 正确性全绿 |
| D5 | criterion 基线存在；diff SSOT；零消费 perf 资产 0 |
| D6 | V 项全量回填；负向断言全绿 |

### 8.2 负产出验收（每阶段至少一项）

| 阶段 | 负产出 |
| ---- | ------ |
| D1 | 删除：EventRouter 无效 parse 路径 + 轮询双源 + `from_value(value.clone())` + 空壳 `mpsc::channel(1)` + 丢帧 warn O(n) 路径；路径收敛：数据面 parse 2→1、轮询 2→1、旁路 parse 全量→meta |
| D2 | 删除：message-start 全文字段 + tool-batch persist 标志 +（路径 B）ToolProgress 构造；路径收敛：webview 非增量发射 2→1 |
| D3 | 删除：伪缓冲「立即 flush」路径；路径收敛：缓冲 2→1（真缓冲） |
| D4 | 删除：错误 Pong 转发路径；路径收敛：Pong 回环 1→1（正确） |
| D5 | 删除：双 diff 实现之一 + 零消费 perf 资产；路径收敛：体积门禁 2→1（真源） |
| D6 | 删除：「待测」V 项状态；路径收敛：负向断言从散落到 CI 全绿 |

### 8.3 五端物证（强契约项）

| 端 | D2.1 双发消除 | D2.2 message-start 瘦身 | D2.4-A Progress 接线 |
| -- | ------------- | ---------------------- | -------------------- |
| 触发端 | 真实 UI 发起 run | 同左 | 同左（含长 shell） |
| 传输端 | 回执事件在 engine-events.json + manifest | message-start 摘要字段在 manifest | tool-progress 在 manifest |
| 介质端 | events 表 message/tool 事件落库 1 份 | message-start 行 payload 无全文 | tool-progress 不落库（NoPersist） |
| 消费端 | 前端 EventRouter 正常处理 run | 前端 handler 零改动（已空实现） | 前端消费 tool-progress（路径 A） |
| 负向 | 旧全文双发路径 grep 0 | 旧 message 字段 grep 0 | 路径 B：ToolProgress 构造 grep 0 |

---

## 9. 依赖拓扑（汇总图）

```text
Layer 0  评审票启动
    │   ├─ PR-PE-02（可与 D1 并行启动）
    │   ├─ PR-SCHEMA
    │   ├─ PR-PROGRESS（用户会签，可立即启动）
    │   ├─ PR-RELAY-FRAME（可选）
    │   └─ PR-ORDER（可选）
    ▼
Layer 1  D1 旁路减负 + D4 relay + D5 部分 + D6 轨启动
    │   （T0；并行单元：U-XPORT-FE / U-BYPASS-RS / U-RELAY / U-TOOLSTART / U-CI / U-BENCH）
    ▼
Layer 2  D2 强契约升级（评审通过后）
    │   （U-SCHEMA 单主责；与 U-XPORT-FE / U-BYPASS-RS 串行）
    ▼
Layer 3  D3 PE-02 放宽（评审通过后）
    │   （U-PE02 单主责；与 U-BYPASS-RS 缓冲串行）
    ▼
Layer 4  D5 完成 + D6 全量回填
        （负向断言全绿；V 项无「待测」）
```

---

## 10. 与 90 索引映射

| 本方案维度 | 90 簇 / 阶段 | 发现 ID |
| ---------- | ------------ | ------- |
| D1 | 阶段 3 部分（03-N）、阶段 4 部分（旁路）、阶段 5 relay、阶段 6 门禁 | 03-V1–V4、03-R5、15-FAN01、15-PSHP03、15-XOV01、15-RLY01–06、15-SRV*、16-P1–P4、10-T3 最小 |
| D2 | 阶段 4（强契约） | 03-R2、03-C1、03-C3、10-T3 全裁决、03-R8 |
| D3 | 阶段 4（PE-02） | 03-R1、03-R7、簇 C1 最终收敛 |
| D4 | 阶段 5（relay） | 15-RLY03–06、15-SRV* |
| D5 | 阶段 6（观测） | 16-P5–P14、06-PF01 |
| D6 | 阶段 6（V 回填）+ 全部 | 90 §5 全部 V 项 |

---

## 11. 与 91 系统性修复总方案的分歧

| # | 议题 | 91 立场 | 本方案立场 | 理由 |
| -- | ---- | ------- | ---------- | ---- |
| 1 | **强契约层位置** | Layer 8（置后，依赖 L2/L4 稳定） | Layer 0 评审票启动 + Layer 2 实现（评审与 D1 并行，实现依赖 D1） | 评审是流程不是实现——PE-02 / Progress 裁决可立即启动会签；实现仍依赖 D1 消费端稳定 |
| 2 | **Progress 裁决** | 「接线或停止构造（用户裁决，禁止静默砍）」 | 三选一（接线 / 停止构造 / 部分接线），PR-PROGRESS 独立评审票，用户会签 | 部分接线（仅 shell）是合理中间态；91 只列两极，缺中间路径 |
| 3 | **V 项回填时机** | Layer 9（终态） | D6 持续轨，每阶段收口回填 | 运行时验证不应等全部静态修复完成；分阶段回填更早暴露回归 |
| 4 | **负向断言体系** | §13 防御脚本总表（清单式） | D6.3 负向断言体系（每修一类同步加强，CI 全绿为收口条件） | 负向断言是持续轨不是终态清单；「随修复演进」需明确收口条件 |
| 5 | **relay 帧上限** | 阶段 5（设计+契约） | D1.6 T0 内部实现（可立即）；对端兼容升 T1 | 帧上限是中继内部防御，不阻塞 schema；移动端若有独立约定再联审 |
| 6 | **ToolStart 实时** | 未单列（仅在 T3 修复方案中提及） | D1.8 最小可行 T0（改发射时机不改事件形状）；顺序契约冲突升 PR-ORDER | 91 将 T3 整体推入强契约层，但 ToolStart 实时可在 T0 范围内先落地，降低批收口涌入 |
| 7 | **PE-02 与旁路减负顺序** | L2（旁路）→ L8（PE-02）严格分层 | D1（旁路）与 PR-PE-02 评审并行启动；实现串行 | 评审流程与实现依赖分离——评审票可提前，实现必须等 D1 |
| 8 | **message-start 瘦身字段** | 「载荷降摘要」 | 明确摘要字段集 `{sessionId, messageId, role, turnIndex}` + 旧字段根除负向 | 91 未定义摘要字段集，本方案显式化以防「瘦身」变成「半删」 |
| 9 | **tool-batch 处置** | 未单列（仅在 C3 提及） | D2.3 降 NoPersist / 桥剔除，升 schemaVersion | 91 将 C3 归入「残余成本」低优先，本方案升格为 T2 正式变更（避免幽灵 persist 标志） |
| 10 | **双发消除旁路保留** | 「WS 扇出/push 旁路依赖收口轨事件做转发——需保留完整事件给旁路」 | 同意保留完整事件给旁路，但 webview 单独降回执；明确「旁路走事件存储读取而非二次 emit」为备选 | 与 91 一致但更显式：webview 与旁路分离，避免「双发消除」被理解为「收口轨全删」 |

---

## 12. 立即执行指令（本方案启动时）

按依赖拓扑，**首轮并行工作单元**（文件域不相交、无强契约）：

1. **U-XPORT-FE** — D1.1–D1.4（前端传输收敛）  
2. **U-BYPASS-RS** — D1.5（旁路 meta-only）+ D1.12（丢帧 warn 聚合）  
3. **U-RELAY** — D1.6、D1.7、D1.11 + D4.1–D4.3（relay 全部 T0）  
4. **U-TOOLSTART** — D1.8（ToolStart 实时，T0 范围）  
5. **U-CI** — D1.9、D1.10（压测进 CI + 门禁接线）  
6. **U-BENCH** — D5.1–D5.4（criterion + diff SSOT + perf 资产）  

**评审票启动**（与首轮并行）：

- **PR-PE-02** — PE-02 放宽评审（§4.1）  
- **PR-PROGRESS** — Progress 裁决用户会签（§4.2 D2.4）  

**第二轮**（评审通过后）：

- **U-SCHEMA** — D2.1–D2.4（强契约升级）  
- **U-PE02** — D3.1、D3.2（PE-02 放宽 + 真缓冲）  

**第三轮**（收口）：

- **U-NEG** — 负向断言全量接入 CI  
- **U-VERIFY** — D6 V 项全量回填  

---

## 13. 附录：关键代码锚点（证据）

| 主张 | 证据 |
| ---- | ---- |
| PE-02 合并禁令明文 | `crates/session-loop/src/provider.rs:191-193`「禁止跨帧/跨块聚合后一次性 emit」 |
| PE-02 契约 SoT | `docs/rust-rewrite/plans/PE-02-streaming-markdown-plan.md` §3.1.2 |
| 非增量事件双发 | `run_idle.rs:1397-1428`（收口二次 emit）；`mod.rs:173-179`（单点双轨） |
| message-start 全文零消费 | `engine-events.json:141`「水合投影以 message-end 为准」；`messageHandlers.ts:72-77` 空实现 |
| Progress 恒 None | `exec_single.rs:536-558`（`progress: None`）；`executing_tools.rs:89-98`（批收口广播） |
| 旁路全量 parse | `fanout.rs:281-293`（`from_value(value.clone())`）；`pusher.rs:408-413` |
| relay 帧无上限 | `crates/conex-relay/src/protocol.rs:105-119`（无 MAX 校验） |
| relay last_active 不刷新 | `session.rs:166-177`（forward_frame 不写）；`server.rs:42-53`（GC） |
| EventBuffer 压测 ignore | `apps/agent-workbench/src-tauri/src/buffer.rs:349-456`（`#[ignore]`） |
| startup-budget 孤岛 | `16-可观测性与perf资产审查报告.md` P2 |
| schemaVersion=1 | `engine-events.json:3` |

---

_本方案为独立完整总案；执行轮按 §12 派发；每单元交付必须携带五端物证清单与负向断言，禁止以「模块自测绿」替代。_
