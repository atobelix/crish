# 分维详案 · D11 强契约 + D12 Relay/Push/Telemetry + D13 观测

> **战役**：performance-fix  
> **维度**：D11 强契约评审票与实现 · D12 Relay/Push/Telemetry 正确性 · D13 观测与负向断言终态  
> **依据**：`92-修复总方案.md` §4/§8 · `materials/plans/independent-05-强契约与观测.md` · T0/T1/T2 闸门 · PR-PE-02/SCHEMA/PROGRESS  
> **创建**：2026-09-13  
> **性质**：执行轮分维详案；实现前须过本维评审。  
> **纪律**：禁止未会签实现 PE-02/Progress；禁止 `git commit`（子 Agent 改动留工作区由主控收口）；禁止假装 PE-02 已解禁；禁止静默砍 Progress。  
> **主责**：D11 主责 05 框架；D12 主责 05；D13 主责 05+16。副票只读引用。

---

## 0. 效果锁与契约铁律（不可降级）

1. **不得**以「前端没读 sequence」为由保留非增量事件双发——双发消除唯一合法路径 = 契约升级 + 消费端确认；
2. **不得**在未升 schema 前单侧删 `message-start` 字段——瘦身必须走 engine-events schema PR + registry_drift + 生成 parser 全链；
3. **不得**静默砍 Progress——构造侧删除 / 接线 / 停止构造三选一，须用户显式会签并登记在案；
4. **不得**在 PE-02 评审通过前于 emit 源头做 token N 合 1——旁路减负合法（真缓冲 T0），源头合并违规（T2）；
5. **不得**以「弱契约」为名跳过 commandMap / manifest 登记新增字段；
6. **不得**把「模块自测绿」冒充全链验收——每票须五端物证 + 负向断言 + 防御脚本同步加强；
7. **不得**无日期保留 warn 门禁 / 兼容读 / 幽灵 persist 标志。

### 0.1 契约分级（采用 05 / 92 §8）

| 级 | 含义 | 闸门要求 |
| -- | ---- | -------- |
| **T0** | 无契约变更；纯内部优化 / 旁路减负 / 已建设施接线 | 负向断言 + 五端物证 |
| **T1** | 弱契约：参数增强 / 响应扩字段（向后兼容） | T0 + manifest 双端同步 + 生成 parser 重生成 + registry_drift 绿 |
| **T2** | 强契约：schema 变更 / 语义变更 / 新事件 / 载荷收缩 / 背压分级调整 | T1 + **独立评审票通过纪要** + schemaVersion 升级 + golden 更新 + 旧字段根除负向 + wire 对比 |

### 0.2 路径收敛总览（本三维）

| 概念 | 现路径 | 目标 | 主责维 |
| ---- | ------ | ---- | ------ |
| 非增量事件 webview 发射 | 2（实时全文 + 收口全文） | 1（实时全文 + 收口**回执**；旁路完整） | D11 |
| message-start 载荷 | 全文 | 摘要 `{sessionId,messageId,role,turnIndex}` | D11 |
| tool-batch 落库 | persist:true | 0（NoPersist）或审计轨 | D11 |
| Progress 构造 | 1（构造后丢弃） | 视会签：1（接线）或 0（停止构造） | D11 |
| PE-02 合并语义 | 严格禁止一切合并 | 允许同 block 追加合并（禁乱序/丢弃） | D11 |
| push 内存 pending | 1（无界 VecDeque） | 1（有界 + 落库 store + 周期消费） | D12 |
| 旁路 meta 解析 | 2（fanout 全量 + push 全量） | 1（emit 侧 meta 一次构造，旁路零全量 parse） | D12·与 D6 交叉 |
| relay last_active | 1（join 一次写，永不清新） | 1（AtomicU64 monotonic，转发/PING touch） | D12 |
| relay 帧上限 | 0 | 1（`MAX_RELAY_PAYLOAD_BYTES`） | D12 |
| telemetry cleanup | 库有壳无（0 调用） | 1（启动 spawn_blocking 一次） | D12 |
| EventBuffer 压测 | `#[ignore]` 休眠 | ci-slow 自动回归 | D13 |
| 体积门禁 | warn 孤岛 | fail + 进 CI（与 D9 主责协调） | D13·协调 D9 |
| V 项状态 | 「待测」散落 | 全量回填「已测/结论」 | D13 |
| 废弃 LS 岛 | 生产可读可写 | 0 读 0 写 + `check-store-islands` | D13·守护 D4 |

---

## 1. 依赖与逻辑序（禁工期/人员）

```text
Layer 0  会签票启动（流程，非实现）
    │   ├─ PR-PE-02 ── 阻塞 D11.3 / D11.4（PE-02 放宽 + 源头合并）
    │   ├─ PR-SCHEMA ─ 阻塞 D11.1 / D11.2 / D11.3-B / D11.5-A
    │   ├─ PR-PROGRESS 阻塞 D11.5 全路径（三选一用户会签）
    │   └─ PR-ORDER（可选）── 若 ToolStart 实时冲突顺序契约
    ▼
Layer 1  评审前合法旁路（T0，可与会签并行）
    │   D12.1–D12.4 / D13.1 压测接线 / D13.4 check-store-islands 骨架
    │   （不动 schema；铺平消费端与旁路）
    ▼
Layer 2  D12 正确性收口 + D13 防御接线（T0/T1）
    │   push pending 上限+接线；telemetry cleanup；relay last_active/帧上限
    ▼
Layer 3  D11 T2 实现（评审通过后）
    │   U-SCHEMA 单主责：双发消除 / message-start 瘦身 / tool-batch NoPersist / Progress 落地
    ▼
Layer 4  D11 PE-02 放宽 + 真缓冲联动（评审通过后）
    │   U-PE02 单主责：同 block 追加合并；与 D1 真缓冲 flush 时机对齐
    ▼
Layer 5  D13 终态（V 全量回填 + 负向断言 CI 全绿 + check-store-islands fail 化）
```

### 1.1 禁止顺序反例

1. 未完成评审前合法旁路（Layer 1）与消费端稳定（D6 单 parse / meta-only），不得直接改 schema；
2. 未升 schema，不得在 `message-start` 侧删字段或改 `tool-batch` persist 标志；
3. PE-02 评审未通过，不得在 `streaming.rs` / `push_live` 做同 block 文本拼接；**允许**改 flush 时机（真缓冲，T0，CFL-04）；
4. Progress 裁决未落地，不得静默删除 `shell.rs` 的 `ToolProgress` 构造；也禁止假接线传 `None`；
5. 压测未进 ci-slow，不得声称「EventBuffer 背压已验证」；
6. V 项未回填，不得把「静态审查通过」当作「运行时收益确认」；
7. 未会签，禁止实现 PE-02/Progress（本维铁律）。

---

## 2. 会签票启动与完成定义（D11 · Layer 0）

> 会签是**流程产物**不是实现；「启动即开」，完成定义 = **有通过/否决纪要**（92 §8；评审 02 AC-8：超期未决由主控升格用户，禁止默认静默 B 路径）。

### 2.1 会签票清单（强制启动）

| 评审票 | 阻塞的实现 | 评审内容 | 完成定义 | 前置 |
| ------ | ---------- | -------- | -------- | ---- |
| **PR-PE-02** | D11.3（同 block 合并）、D11.4（真缓冲联动）；映射 03-R1 / 03-R7 | PE-02 §3.1.2 放宽：允许同 messageId+block 类型追加合并；禁止乱序/丢弃；合并正确性测试方案；`streaming_incremental_contract` 锚点更新；`provider.rs:191-193` 契约注释修订案 | 纪要：通过（附条件）或否决（附理由+替代路径=仅真缓冲收益）；变更清单+负向断言设计写入票 | D6 消费端稳定（可与 Layer1 并行启动评审） |
| **PR-SCHEMA** | D11.1 双发消除、D11.2 message-start 瘦身、D11.3-B tool-batch NoPersist、D11.5-A Progress 接线 | engine-events 变更集：双发回执事件/`sequenceOnly` 字段 / message-start 摘要字段集 / tool-batch `persist:false` / tool-progress 新增；schemaVersion 升级策略；golden 更新；旧字段根除负向 | 纪要：变更集清单逐项通过/否决；schemaVersion 目标值写入票 | D6 消费端稳定 |
| **PR-PROGRESS** | D11.5 全路径 | 三选一会签（见 §3.5）；用户显式勾选；禁止静默砍 | 纪要：用户会签「路径 A/B/C」+ 登记日期；未会签前构造侧冻结 | 无（可与 D12/D13 并行立即启动） |
| **PR-LS-BODY** | D4 persist 切除的产品语义（本维只挂接，不主责） | LS 命令缺失 body 回退：删除或保留写明 | 纪要：产品语义裁决 | D4 启动后 |
| **PR-MOTION** | D8/D9 motion 删除前置 | motion/animated-icons 复核结论（CFL-13） | 纪要：bundle/import 复核 + 删/留 | D9 复核 |
| **PR-ORDER**（可选） | ToolStart 实时（若升 T2） | ToolStart 实时桥是否违反 01 §五.6「批收口广播」顺序契约（CFL-14） | 纪要：允许改时机 / 要求保持批收口 | D11.6 实现前 |

### 2.2 T2 实现门禁（铁律）

**任何 T2 工作单元进入实现分支前，必须同时满足：**

1. 对应评审票**纪要存在且为「通过」**（否决则该单元不得实现，替代路径登记）；
2. PR-PROGRESS：**用户会签完成**（路径 A/B/C 之一写入纪要）；
3. 变更清单完整：schema / events.rs / 生成 parser / golden / registry_drift / 前端消费端 / manifest；
4. 负向断言设计就绪（旧字段根除 + 新字段真实消费，非解析后丢弃）；
5. 五端物证清单写入任务书；
6. 文件域与 D1/D6/D9 互斥表已勾选（本详案 §5）；
7. **禁止** `--no-verify`、空壳字段、`// schema-compat` 静默忽略未登记键、`#[allow(dead_code)]` 保护已声明「不消费」的字段。

**评审前合法旁路（T0）不受本门禁约束**——见 §3.0，可在会签未决期并行。

### 2.3 评审通过标准（汇总 05 §4.2 + 评审 02）

| # | 标准 | 可证伪方式 |
| - | ---- | ---------- |
| 1 | 变更清单完整（全链） | 对照 schema→parser→golden→manifest 勾选表 |
| 2 | 负向断言设计 | 旧字段 grep 0 + 新字段消费路径测试名 |
| 3 | 五端物证清单 | 触发/传输/介质/消费/负向 五列非空 |
| 4 | 回归风险与锚点测试 | streaming_incremental_contract / registry_drift ID |
| 5 | 无幽灵契约 / 无截肢降级 | registry_drift 扩展断言 + 行为级消费 |

---

## 3. 分维任务详案

### 3.0 评审前合法旁路（D12 + D13 部分 · T0 · 可立即并行）

> 以下单元**不触碰 schema / PE-02 合并禁令**，可在会签未决期执行，为 T2 铺平消费端与旁路。

#### D12.1 旁路 meta-only / Arc 共享（15-PSHP03、15-FAN01、15-XOV01 部分；映射 03-R5）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `emit` 侧信封构造时同步产出轻量 `EventMeta { type, sessionId, sequence, backpressure, runId }`（emit 一次构造，旁路零全量 parse）；② fanout `parse_event_meta` 改消费 EventMeta；③ `PushAwareEmitter::on_event` 同改 meta-only；④ 删除 `from_value(value.clone())` 深拷贝；⑤ 多端开启时每事件 JSON 解析次数：webview 1（序列化）+ fanout 0 全量 + push 0 全量 |
| 删什么 | fanout/push 全量 `AgentEvent` 反解析热路径；`value.clone()` |
| 契约 | T0（元字段语义不变） |
| 文件域 | `src-tauri/src/server/fanout.rs`、`push/pusher.rs`、`core_event_bridge.rs`（meta 产出点） |
| 与 D6 交叉 | **D6 主责前端 transport 单 parse**（EventRouter 短路 + dataPlaneRouter）；本单元主责 **Rust 旁路**。`core_event_bridge.rs` meta 产出点与 D6 fanout/push meta 只读共享同一 EventMeta 定义——主控指定唯一产出方（建议 `core_event_bridge`），D6 消费不重复定义 |
| 负向断言 | `parse_event_meta` 无 `from_value(value.clone())`；fanout 无全量 `AgentEvent` 反解析热路径；XOV01 多端解析次数 ≥3 → ≤1 可测；「非推送事件不触发 AgentEvent 反序列化」计数 mock |
| 防御增量 | pusher/fanout 单测：非白名单事件 AgentEvent 构造次数 = 0 |

#### D12.2 relay last_active 刷新（15-RLY01）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `last_active` 改 `AtomicU64` monotonic ms（避免 read 路径升级 write）；② `forward_frame` 成功 / PING 处理成功后 touch；③ GC 按新 last_active 判定；④ 单测：转发后 sleep 模拟不误清；无活动 91s 清 |
| 删什么 | 「join 时刻 = 活性时刻」死字段语义 |
| 契约 | T0 |
| 文件域 | `crates/conex-relay/src/session.rs`、`server.rs` |
| 负向断言 | 转发一帧后 `clean_stale_sessions` 不清 peer；join 后无活动 91s 清 peer |
| 五端物证 | 触发=双客户端 join；传输=业务帧转发；介质=n/a；消费=GC 日志/单测；负向=活跃 peer 被清路径根除 |

#### D12.3 relay 帧上限（15-RLY02 · T0 内部）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 引入 `MAX_RELAY_PAYLOAD_BYTES`（对齐桌面 `conex-types/src/device/version.rs:227` 的 1MiB；进 `perf_budget` 模块与 D0/D13 同源）；② `decode` 超限直接 bail；③ `encode` 侧 debug_assert；④ 单测：超限帧拒绝；⑤ roundtrip 保留 |
| 契约 | T0（中继内部）；若移动端有独立帧上限约定 → 升 T1 联审（PR-RELAY-FRAME 可选） |
| 文件域 | `crates/conex-relay/src/protocol.rs` |
| 负向断言 | `payload_len > MAX_RELAY_PAYLOAD_BYTES` 时 decode 返回 Err；现有 roundtrip 全绿 |

#### D12.4 relay 连接上限 / Pong 回环 / 房间锁（15-RLY03–06、SRV* 补充）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `RELAY_MAX_CONNS` 环境变量+默认（如 4096）超限拒绝 WS 升级；② `join_room` 只返回 `session_token`（删空壳 `mpsc::channel(1)`）；③ secret 改 `Arc<str>`；④ Pong 写回发送方 `tx_to_peer`（修复回环）；⑤ `PeerJoined` 通知移出 write 临界区；⑥ 桌面 SRV01–04：出站 Critical 满缓冲 await→非阻塞/超时；device_activities 克隆→Arc；publish 先 clone tx 列表再发送；Critical 队列有界+溢出策略明确 |
| 删什么 | 空壳 `mpsc::channel(1)`；错误 Pong 转发路径；持锁遍历发送 |
| 契约 | T0 |
| 文件域 | `crates/conex-relay/src/{protocol,session,server}.rs`、`src-tauri/src/server/{ws,fanout}.rs` |
| 负向断言 | 超限拒绝测试；Ping 回环测试；出站队列有界；Critical 溢出可观测 |

#### D13.1 EventBuffer 压测进 ci-slow（16-P3）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `ci-slow.yml` 增加 job：`cargo test -p crish-agent-workbench --release -- --ignored stress_ --nocapture`；② 事件/秒解析进 `::notice` 或 `perf-report/`；③ 可选：软水位/丢帧计数导出为可断言纯函数指标；④ **丢帧语义（Critical 必达 / Soft 旧帧可丢）成为自动回归资产** |
| 契约 | T0 |
| 文件域 | `.github/workflows/ci-slow.yml`（**协调 D9**：startup-budget 接线归 D9 主责，本维只接 stress_） |
| 负向断言 | ci-slow 存在 `stress_` 步骤；破坏 Critical 必达的改动 → job 红 |
| 防回潮 | 事件/秒基线可对比；`#[ignore]` 资产不再休眠 |

#### D13.2 丢帧 warn 聚合（16-P4；映射 independent-05 D1.12）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 丢帧 warn 移到 flush 聚合点（与 `EmitReport.dropped` 汇总一致），或按 run_id「首次 + 每 N 条 + 终态汇总」限速；② 计时保留（µs 级可接受） |
| 删什么 | 高丢帧场景 O(丢帧次数) warn 路径 |
| 契约 | T0 |
| 文件域 | `src-tauri/src/engine_channels.rs` |
| 负向断言 | 洪峰 enqueue 丢帧时 warn 次数 ≤ 每 flush 1 次（tracing-test cap） |
| 与 D1 交叉 | 真缓冲（D1 引擎减载 / 03-R7）改 flush 时机后，本单元的聚合点与 D1 flush 单测**串行合并**，避免双改 `engine_channels.rs` |

#### D12.5 push decision 引擎 prune + folded 上限（15-PSHP04/05）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `task_owner_run` / `run_term_source` 与 `run_failed_at` 同策略 retain（如最近 256/128）；② `folded` 加 `MAX_FOLDED`（如 500）丢最旧；③ `take_night_summary` 接 drain loop 或 1h 定时 |
| 删什么 | 无淘汰 HashMap 路径；无上限 folded |
| 契约 | T0 |
| 文件域 | `push/engine.rs` |
| 负向断言 | 插入 N 条后 prune 断言 len 上界；超限丢弃 + 定时 take 装配测试 |

---

### 3.1 D12 · push pending 上限 + 周期接线（T0/T1 · 正确性止血）

> 15-PSHP01/02/06；与 telemetry cleanup 同批「能力有、接线无」根治。

#### D12.6 内存 pending 上限 + PendingApprovalStore 装配（15-PSHP01）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 启动装配：`PendingApprovalStore::new(conn)` + `with_pending_store`（可选 `with_dedupe_backend(Sqlite…)`）；② 内存队列加 `MAX_MEMORY_PENDING`（建议 256，进 perf_budget）超限**丢最旧非审批条目**（审批条目优先落库）；③ 指标暴露 `pending_len` → status_diagnostics |
| 删什么 | 无界 `VecDeque` 增长路径；无 store 时「只进不出」语义 |
| 契约 | T0（装配+上限）；若诊断字段为新 IPC 响应字段 → T1（manifest 双端同步） |
| 文件域 | `push/pusher.rs`、`push/pending.rs`、`main.rs`（装配） |
| 负向断言 | 装配测试：offline 设备 → pending 落库；超限丢弃测试；`pending_len` 可读 |
| 五端物证 | 触发=离线设备+高频事件；传输=mark_pending 路径；介质=SQLite pending 表/内存上界；消费=status 诊断；负向=无界增长 grep/压测 |
| V 回填 | 15-V2 pending_len 曲线（D13 轨） |

#### D12.7 send_pending_batch 周期接线 + 无通道跳过（15-PSHP02 + PSHP06）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① push drain loop 内 select 定时（30–60s）调用 `send_pending_batch`（需 resolver + channels 装配）；② **无任何 vendor 通道装配时跳过 take_pending**（禁止空转 requeue）；③ 对「通道未装配」条目退避（指数/阶梯）而非固定下轮全量；④ 永久无法投递（设备未登记超 N 天）丢弃并记审计；⑤ 审批重推阶梯因 take_due 周期推进 |
| 删什么 | 「周期 drain 挂点待装配」死注释路径；无通道 requeue 风暴 |
| 契约 | T0（接线）；周期常量进 perf_budget（D0 SSOT） |
| 文件域 | `push/vendor/consumer.rs`、`push/mod.rs`、`main.rs`（drain loop） |
| 负向断言 | enqueue → tick → 模拟 delivered → 队列清空；无通道列表时 take 不导致 requeue 风暴 |
| 五端物证 | 触发=离线→上线；传输=vendor 投递；介质=pending 出队；消费=审批阶梯推进；负向=只进不出路径根除 |
| V 回填 | 15-V7 厂商凭据缺失时空转 CPU |

#### D12.8 dispatch 文案渲染共享（15-PSHP07 · 低优先并入）

| 项 | 内容 |
| -- | ---- |
| 做什么 | 同一 decision 的 message **渲染一次**后对各 device 改写 id/seq（或共享 title/body Arc） |
| 契约 | T0 |
| 文件域 | `push/pusher.rs`、`push/copy.rs`（只读） |
| 负向断言 | 多设备 dispatch 单测：文案 format 次数 = 1 |

---

### 3.2 D12 · telemetry cleanup（15-TEL01）

#### D12.9 cleanup_logs 启动接线（15-TEL01）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `main.rs` 在 `init_default` 后 `spawn_blocking` 调一次 `cleanup_logs(&log_dir, &LogRetention::default())`；② 或接入已有稳定性 H9 方案（`docs/stability-closure/10-analysis/02-runtime-health-observability.md`）；③ 壳层 smoke：断言调用次数 = 1/启动 |
| 删什么 | 「注释承诺启动执行一次」的断链（承诺→事实） |
| 契约 | T0（库实现完备，仅接线） |
| 文件域 | `apps/agent-workbench/src-tauri/src/main.rs`（壳层装配段）、`crates/conex-telemetry/src/file.rs`（只读，库已完备） |
| 负向断言 | 库层保留策略单测已有全绿；壳层 smoke 断言 `cleanup_logs` 调用；启动后日志目录不无限增长（集成级可选） |
| 五端物证 | 触发=冷启动；传输=spawn_blocking；介质=日志目录策略；消费=retention 生效；负向=零调用路径根除 |
| 说明 | TEL02/03（双通道同步写、Mutex）**本维不强制**——release 默认 info 已正确；若 debug 热路径日志问题复发，单独立项，不阻塞本票 |

---

### 3.3 D11 · 强契约实现（T2 · 评审通过后）

> **前置**：Layer 1 旁路完成；对应评审票纪要「通过」；PR-PROGRESS 用户会签。

#### D11.1 非增量事件双发消除（03-R2 · INV-1）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 评审票通过；② 升 schemaVersion；③ `engine-events.json` 增回执事件类型或信封 `sequenceOnly` 字段；④ `events.rs` 同步 enum/变体；⑤ `run_idle.rs` 收口循环：非 delta 事件若实时轨已发，**webview 只发轻量回执** `{type:"<event-type>", runId, sequence, eventId}`（不含 payload）；⑥ 生成 parser 重生成；⑦ registry_drift + golden 更新；⑧ **WS 扇出/push 旁路：保留完整事件给旁路**（旁路走事件存储读取而非二次 emit 为备选）；⑨ 前端按需消费回执（现状无消费者，回执仅日志级——保留消费端接口以备将来对账） |
| 契约变更 | 收口轨对 webview 降级为轻量 sequence 回执，或实时轨预分配 sequence + 收口 webview 完全免发；升 schemaVersion |
| 删什么 | 收口非 delta 全文再投递（DEL-9 / 06 U17）；「全文双发」路径 grep 0 |
| 契约级 | **T2 · PR-SCHEMA** |
| 文件域 | `conex-types/contracts/engine-events.json`、`conex-types/src/events.rs`、`run/run_idle.rs`、`session-loop/loop/handlers/mod.rs`、`packages/shared-types/src/generated/engine/parser.ts` |
| 负向断言 | run 全周期 wire：非增量事件跨 webview IPC 恰 1 遍（回执不计 payload）；旧全文双发路径 grep 0；registry_drift 绿 |
| 五端物证 | 触发=真实 UI 发起 run；传输=回执事件在 manifest；介质=events 表落库 1 份（收口）；消费=EventRouter 正常处理；负向=旧全文双发根除 |
| **双发=webview 回执+旁路完整（铁律）** | 「双发消除」**不得**理解为收口轨全删。webview 与旁路分离：webview 降回执；fanout/push **保留完整事件**（从既有 emit 侧事件或存储读取，禁止二次 IPC 全文）。CFL-16 |
| 与 D1 交叉 | D1（引擎减载）NoPersist/真缓冲不改变本票「收口 webview 降回执」语义；但 D1 若动 `run_idle` 收口写路径，须与本单元串行 |

#### D11.2 message-start 载荷降摘要（03-C1）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `engine-events.json` message-start fields 收缩为 `{sessionId, messageId, role, turnIndex}`；② `events.rs` MessageStart 变体同步；③ `mod.rs`/`streaming.rs` 成对发射时 start 只带摘要；④ 生成 parser 重生成；⑤ 前端 `onMessageStart` 仍空实现（`handlerBehavior.test.ts` 锚定）；⑥ golden 更新；⑦ 旧字段（message 全文）根除负向 |
| 删什么 | message-start payload 的 `message` 全文字段（物理删除+grep 0） |
| 契约级 | **T2 · PR-SCHEMA** |
| 文件域 | 同 D11.1 schema 链 + `messageHandlers.ts`（不改空实现） |
| 负向断言 | message-start payload 无 `message` 字段（grep 级）；message-end 仍携带全文；replay 投影测试全绿（投影以 end 为准，`engine-events.json:141`）；registry_drift 绿 |
| 五端物证 | 触发=真实 run；传输=schema 在 manifest；介质=events 表 start 行无全文；消费=handler 零改动；负向=旧全文字段根除 |
| 叠乘说明 | 与 D11.1 合并后：全文传输 4 遍（start/end × 实时/收口）→ 2 遍（end × 实时/回执后仅 end 实时全文 + 回执；C1 后 start 无全文） |

#### D11.3 tool-batch 双事件降 NoPersist（03-C3）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① `engine-events.json` tool-batch-start/end `persist:false`（或从实时桥剔除只留落库审计）；② 前端 `parseBridgeEvent` 前按类型短路跳过 strict 校验（与 D6 数据面短路同一机制）；③ 水合投影确认 replay 本就不消费；④ golden 更新；⑤ schemaVersion 升级 |
| 删什么 | tool-batch 独立落库（概念收敛为「不再独立落库」）；幽灵 persist 标志 |
| 契约级 | **T2 · PR-SCHEMA** |
| 文件域 | schema 链 + `toolHandlers.ts`（空实现） |
| 负向断言 | tool-batch 事件落库计数 0（或仅审计轨显式）；前端 strict parser 对 batch 事件 0 调用；registry_drift 绿 |

#### D11.4 PE-02 放宽 · 同 block 追加合并（03-R1 · PR-PE-02）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 评审票通过（PE-02 重开）；② `provider.rs:191-193` 契约注释放宽为「允许同 messageId+block 类型的追加合并，禁止乱序/丢弃」；③ `BridgeLiveSink::push_live` 内加 8–16ms 时间窗微批（同 session+messageId 的 TextDelta 文本拼接后合并 emit）；④ 合并保持顺序（前端 batcher 语义一致）；⑤ 合并正确性测试（合并前后前端累计文本**逐字节等价**）；⑥ EventBuffer 20 万条压测全绿 + 末尾 delta 延迟 ≤ 窗口上限；⑦ `streaming_incremental_contract.rs` 锚点更新（合并后仍满足：全文 == delta 拼接）；⑧ 升 schemaVersion（信封无需变，delta 语义不变——评审确认后） |
| 删什么 | 严格禁止合并的旧注释语义（改约束内容，不删约束本体）；「伪缓冲立即 flush」路径（与 D1 真缓冲一体，CFL-04） |
| 契约级 | **T2 · PR-PE-02** |
| 文件域 | `session-loop/src/provider.rs`（契约注释）、`loop/handlers/streaming.rs`、`engine_channels.rs`、`push/pusher.rs`、`server/fanout.rs`、`streaming_incremental_contract.rs` |
| 负向断言 | 合并前后累计文本逐字节等价；乱序/丢弃测试红；contract T1–T4 全绿（合并语义下）；PE-02 注释与代码一致 |
| 五端物证 | 触发=真实长流 run；传输=delta 形状不变在 manifest；介质=收口 delta 不落库（NoPersist）；消费=前端 batcher 累加正确；负向=跨帧/乱序/丢弃路径根除 |
| **禁止** | 评审前在 streaming/push_live 做拼接；跨 message/block 合并；丢弃 delta |
| 与 D1 交叉 | D1 真缓冲=改 flush 时机（T0，可先做）；本票=改事件体合并（T2）。二者共改 `engine_channels.rs`——**串行**：D1 flush 落地后本票在其上加合并窗 |

#### D11.5 Progress 裁决落地（10-T3 全裁决 · PR-PROGRESS）

**三选一，用户会签，禁止静默砍（CFL-12）：**

| 路径 | 语义 | 实现 | 负向断言 |
| ---- | ---- | ---- | -------- |
| **A · 接线** | 新增 `tool-progress` 非持久事件 | schema 新增 + 执行器 progress 回调接线 + shell `execute_stream` 的 `ToolProgress` 构造接上桥 + 前端消费（Terminal 增量/卡片进度） | tool-progress 在 manifest + 前端真实消费；NoPersist 落库 0 |
| **B · 停止构造** | Progress 功能正式下线，省 CPU | 删除 shell `execute_stream` 的 `ToolProgress` 构造；执行器 `progress: None` 保持；**不新增事件类型**；会签记录 | `ToolProgress` 构造 grep 0 + 会签记录日期 |
| **C · 部分接线** | 仅 shell 路径接线（最高频） | shell 接线 + 其他工具保持 None；登记「后续工具接线」为独立任务 | shell 路径 tool-progress 流 + 其他工具无构造 |

| 项 | 内容 |
| -- | ---- |
| 契约级 | 路径 A：**T2 · PR-SCHEMA + PR-PROGRESS**；路径 B：T0 删除+会签；路径 C：T2 限 shell |
| 文件域 | 视裁决：`engine-events.json`、`events.rs`、`executing_tools.rs`、`exec_single.rs`、`shell` 相关、`toolHandlers.ts` |
| **禁止** | 未会签前删除构造；未升 schema 前私自加 `tool-progress` 类型；假接线传 `None`；静默砍 |
| 与 D1 交叉 | ToolStart 最小实时（10-T3 的 T0 子集，若独立推进）与本票同文件区——`executing_tools.rs` 串行；CFL-14 若顺序契约冲突升 PR-ORDER |

#### D11.6 ToolStart 实时桥（10-T3 最小可行 · T0 范围，可选前置）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 顺序路径与并行组：`ToolStart` 在进入执行前经独立 LiveEventSink 推送（不走持久化 events Vec）；② `ToolEnd` 仍收口持久化（收口去重属 D2/D11 后续）；③ **不在本步碰 Progress** |
| 契约 | T0（事件类型不变，仅发射时机提前）；若顺序契约要求「批收口广播」→ 升 T2 · PR-ORDER |
| 文件域 | `session-loop/src/loop/handlers/executing_tools.rs`、`exec_single.rs` |
| 负向断言 | 并行组 N 工具：前端执行期间看到 N 个 tool-start（非批结束后同时涌入） |

#### D11.7 可见性背压（03-R8 · 依赖 D11.4 真缓冲）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 最小化档：Tauri 窗口焦点/最小化 → 桥层降频（flush 周期放大）；② 完整档：前端可见性信号回传，隐藏时 delta 走 EventBuffer 缓冲、可见时 flush（依赖真缓冲）；③ 恢复可见时文本完整性（缓冲未丢帧，压测覆盖） |
| 契约 | 设计评审（非 schema 强变更，桥层语义） |
| 文件域 | `engine_channels.rs`、`core_event_bridge.rs`、`tauriTransport.ts`（信号注册） |
| 负向断言 | 最小化窗口 CPU 对比（下降 ≥80% 绝对探针）；恢复可见时累计文本逐字节等价 |
| 与 D1 交叉 | flush 周期常量与 D1 真缓冲同源（perf_budget）；前端信号面与 D6 transport 串行 |

---

### 3.4 D13 · 观测与负向断言终态（持续轨）

#### D13.3 V 项回填轨（90 §5 + 本视角相关 V）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 每阶段收口前，经 **4000 Tauri MCP** 生产包（debug 构建）回填对应 V 项；② **禁止 9222/浏览器插件/仅 5174 独立页**；③ 回填时更新各报告对应小节 + 90 §5 表登记日期与结论摘要；④ V 项状态初始「待测」→ 回填后「已测/结论」 |
| 本视角优先 V 项 | 见下表 |
| 契约 | T0（观测流程） |
| 负向断言 | 90 §5 表无「待测」项（全量回填后）；回填记录含日期 + 结论摘要；禁止「静态审查通过」冒充运行时确认 |
| 通道纪律 | 仅 4000 Tauri MCP；mock/沙箱种子环境禁止作验收（AGENTS §15） |

**优先 V 项表：**

| V 项 | 主题 | 成功判据 | 通道 | 关联维 |
| ---- | ---- | -------- | ---- | ------ |
| 03-V1 | 双发确认 | 非增量双发比 = 2.0（修复前基线）→ 修复后 = 1.0（回执） | tracing + MCP | D11.1 |
| 03-V4 | 数据面双解析 | task-* ×2（修复前）→ ×1（修复后） | MCP + 计数 | D6 / D12.1 |
| 03-V7 | 旁路 parse | 大 payload >1ms/条 → meta-only 后 <0.1ms | MCP | D12.1 |
| 03-V8 | 最小化 CPU | 与前台无差异（修复前）→ 下降 ≥80% | MCP | D11.7 |
| 10-V3 | ToolStart 实时 | 并行组 N 工具：执行期间看到 N 个 tool-start | MCP | D11.6 |
| 10-V4 | Progress | 视会签：A 有流 / B 构造 0 / C shell 有流 | MCP + grep | D11.5 |
| 15-V2 | pending 有界 | pending_len ≤ MAX_MEMORY_PENDING | 诊断字段 | D12.6 |
| 15-V4 | relay 活跃 | 双客户端持续互发 10min 不被 GC | GC 日志 | D12.2 |
| 15-V5 | 多端 emit | 8 设备连接下 emit P50/P99（多端开 vs 关） | 微基准 | D12.1 |
| 15-V7 | 凭据缺失空转 | 无通道 tick CPU ≈ 0 | 无通道列表 | D12.7 |
| 16-V1 | 静态图 | 静态图合计真实值 + 门禁 fail | 生产 build + 门禁 | D13·协调 D9 |
| 16-V6 | EventBuffer | 有界后队列 ≤ 水位；压测不进红 | 采样 + stress | D13.1 |
| 全部 | 契约回归 | schemaVersion 升级后旧前端容忍（fail-open 测试） | 测试 | D11 |

#### D13.4 check-store-islands（新脚本 · 守护 INV-4 / D4）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 新脚本 `scripts/check-store-islands.mjs`：禁止写已删 LS 岛；`sessionStore` partialize **不含** `sessions`；禁止生产路径读 `crish_session_store` 内 sessions 大键/旧镜像键；② 接入 `check:desktop`；③ 夹具单测（正例：无 sessions partialize 绿；反例：partialize 含 sessions / 读旧键红） |
| 删什么 | （伴随 D4）LS body 镜像写路径；兼容读（票 A 产品裁决后） |
| 契约 | T0（门禁脚本） |
| 文件域 | `scripts/check-store-islands.mjs`（新建）、`package.json`（check:desktop 链追加） |
| 负向断言 | 脚本对夹具红/绿正确；INV-4「生产 0 读 0 写」由脚本+行为单测双锁 |
| 与 D4 交叉 | **D4 主责 persist 切除实现**（partialize 去 sessions + 旧键 migration + 删读代码）；本维主责 **门禁脚本落地与 fail 化**。脚本断言列表以 D4 删除面清单为准——D4 删完后脚本 fail 才绿；禁止 D4 未删时脚本永久白名单豁免（AC-2）。OVL-24：与 check-no-raw-setstate 加固同票协调，禁止两份脚本逻辑分叉 |
| 与 D6 交叉 | 无直接文件域重叠；D6 传输收敛不改 LS 面 |

#### D13.5 startup-budget / 体积门禁协调（16-P1/P2/P14 · **主责 D9，本维只读协调**）

| 项 | 内容 |
| -- | ---- |
| 本维动作 | ① 确认 ci-slow/`check:desktop` 不出现与 D9 双写的体积阈值第二真源；② EventBuffer stress job 与 startup-budget job 在 ci 中互不覆盖文件域；③ 若 D9 未接线，本维在收口检查表登记「16-P1/P2 归 D9 主责，本维不代做」 |
| 禁止 | 与 D9 双 Agent 竞写 `ci.yml` frontend-build 同一行（C-X2）；本维不碰 `check-startup-budget.mjs` 主逻辑 |

#### D13.6 criterion 覆盖与 perf 资产（16-P5–P8、PF01 · 可选并入 U-BENCH）

| 项 | 内容 |
| -- | ---- |
| 做什么 | ① 修 `perf/diff` O(n²) 行号（16-P9）；② 补 EventBuffer / perf/jsonl / encoding criterion；③ diff 解析 SSOT 裁决后物理删除双实现之一；④ 零消费 perf 资产（jsonl/mmap）接线或删除+登记 |
| 契约 | T0 |
| 文件域 | `src-tauri/benches/`、`conex-markdown/benches/`、`perf/`、diff 双实现文件 |
| 负向断言 | criterion 基线存在；唯一 diff 实现；零消费 perf 资产 0 个 |
| 说明 | 若与首轮 U-BENCH 切片冲突，本维只提需求由 U-BENCH 执行，验收回 D13 |

#### D13.7 负向断言体系（持续轨 · 收口条件）

**每修一类问题，同步加强对应防御脚本 / 守护单测；负向断言清单：**

| 断言 | 类型 | 依赖单元 |
| ---- | ---- | -------- |
| 数据面事件 parse 恰 1 次 | 测试探针 | D6 / D12.1 |
| `list_background_tasks` 单源 | IPC 计数 | D6 |
| `parse_event_meta` 无全量 `from_value(value.clone())` | grep | D12.1 |
| `payload_len ≤ MAX_RELAY_PAYLOAD_BYTES` | 单测 | D12.3 |
| 转发后 `last_active` 刷新 | 单测 | D12.2 |
| pending_len ≤ 上限 + 落库装配 | 单测 | D12.6 |
| send_pending_batch 周期 tick + 无通道跳过 | 集成 | D12.7 |
| `cleanup_logs` 壳层调用 = 1/启动 | smoke | D12.9 |
| EventBuffer stress 进 ci-slow | CI job | D13.1 |
| 丢帧 warn O(1)/O(轮次) | tracing-test | D13.2 |
| 非增量事件跨 webview IPC 恰 1 遍 | wire 对比 | D11.1 |
| message-start 无 `message` 全文字段 | grep + schema | D11.2 |
| tool-batch NoPersist | 落库计数 | D11.3 |
| Progress 路径 A/B/C 各自负向 | grep + 事件流 | D11.5 |
| 合并前后累计文本逐字节等价 | 单测 | D11.4 |
| 乱序/丢弃 delta 路径 | 单测红 | D11.4 |
| `registry_drift` 绿 | 测试 | 全部 T2 |
| 旧字段根除（schema 升级后） | grep + 行为 | D11 |
| 废弃 LS 岛 0 读 0 写 | check-store-islands + 行为 | D13.4 / D4 |
| 零消费 perf 资产 0 个 | grep | D13.6 |

**收口条件**：上表全部进 CI 或守护单测且绿；相对型验收改为绝对探针（评审 02 AC-3）。

---

## 4. 与 D1 / D6 交叉（汇报项）

### 4.1 与 D1（引擎减载：NoPersist / 真缓冲 / 审计有界 / 工具输出 RS）交叉

| 主题 | D1 责任 | D11/D12/D13 责任 | 串行/并行 |
| ---- | ------- | ----------------- | ---------- |
| NoPersist 跳取号 | D1 主实现（`orchestrator/events.rs` reserve=0） | D11.3 tool-batch persist 标志为 schema 侧对应 | D1 先（T0）；D11.3 后（T2） |
| 真缓冲 flush 时机 | D1 主实现（`push_live` 条件 flush，T0） | D11.4 在其上加同 block 合并窗（T2）；D11.7 可见性背压依赖真缓冲 | **串行**：D1 → D11.4/D11.7 |
| 引擎出口文件域 | `run_launch`/`executing_tools` 出口（D1） | D11.5/D11.6 同文件区 Progress/ToolStart | **串行**主控协调；Progress 会签优先锁构造侧 |
| 工具输出 RS / Arc | D1 主责 | D11 只消费 tool-end 事件形状，不改 output_budget | 只读依赖 |
| EventBuffer 语义 | D1 有界/水位 | D13.1 压测锁定 Critical 必达；D13.2 warn 聚合与 D1 flush 单测合并 | **串行** `engine_channels.rs` |

### 4.2 与 D6（传输收敛：单 parse / 轮询 / meta-only 旁路）交叉

| 主题 | D6 责任 | D11/D12/D13 责任 | 串行/并行 |
| ---- | ------- | ----------------- | ---------- |
| 数据面 parse ×1 | D6 主责（EventRouter 短路 + dataPlaneRouter） | D12.1 Rust 旁路 meta-only；D11.3 前端 batch 短路复用 D6 机制 | 文件域不同可并行；**短路机制 SSOT 归 D6** |
| 旁路 meta-only | D6 认领 fanout/push meta（独立-01 T-L4-B） | **92 §4：D6 文件域含 fanout/push meta**——与本详案 D12.1 重叠 | **主控裁决唯一主责**：建议 D6 主责定义+产出点；D12.1 只读消费同一 EventMeta，禁止双写 |
| 双发 webview 回执 | D6 传输面不改收口轨 | D11.1 主责 schema+收口回执 | D11 主责；D6 消费回执接口只读 |
| ToolStart/visible 信号 | D6 transport 信号注册 | D11.6/D11.7 | 串行 `tauriTransport.ts` |
| 轮询双源 | D6 主责 | 本维不碰 | 无交叉 |

### 4.3 文件域互斥总表（本三维）

| 单元 | 唯一文件域 | 与 D1 | 与 D6 | 与 D9 |
| ---- | ---------- | ------ | ------ | ------ |
| D11.1–3 schema 链 | engine-events.json、events.rs、parser.ts、run_idle、mod.rs、golden | run_idle 与 D1 出口串行 | parser 消费只读 | 无 |
| D11.4 PE-02 | provider.rs、streaming.rs、engine_channels、push_live | engine_channels **与 D1 串行** | fanout/pusher 只读 meta | 无 |
| D11.5–6 Progress/ToolStart | executing_tools、exec_single、shell 构造点 | 出口文件区 **与 D1 串行** | 无 | 无 |
| D12.1 meta-only | fanout、pusher、core_event_bridge | bridge 只读 | **与 D6 主责协调唯一产出点** | 无 |
| D12.2–4 relay | conex-relay/**、server/{ws,fanout} | 无 | server fanout 与 D6 meta 读点串行 | 无 |
| D12.5–8 push | push/**、main.rs 装配 | 无 | 无 | 无 |
| D12.9 telemetry | main.rs 装配段（telemetry） | 无 | 无 | 无 |
| D13.1–2 CI/丢帧 | ci-slow.yml、engine_channels | engine_channels 与 D1/D11.4 串行 | 无 | ci-slow 与 D9 ci.yml job 文件不同可并行 |
| D13.3 V 回填 | 各报告 V 节、90 §5 | 只读 | 只读 | 只读 |
| D13.4 store-islands | scripts/check-store-islands.mjs、package.json | 无 | 无 | check:desktop 链与 D9 协调追加顺序 |

---

## 5. 删除面总表（负产出）

| # | 删除/收敛项 | 证据锚 | 类型 | 单元 |
| - | ----------- | ------ | ---- | ---- |
| 1 | 收口非 delta 全文 webview 再投递 | run_idle.rs:1405-1421 | 收敛→回执 | D11.1 |
| 2 | message-start.message 全文字段 | engine-events + events.rs | 物理删除 | D11.2 |
| 3 | tool-batch persist 标志 / 独立落库 | engine-events | 收敛→NoPersist | D11.3 |
| 4 | 严格禁止合并的 PE-02 旧注释语义 | provider.rs:191-193 | 修订约束内容 | D11.4 |
| 5 | 伪缓冲立即 flush | engine_channels push_live | 收敛→真缓冲 | D11.4+D1 |
| 6 | （会签 B）ToolProgress 构造 | shell execute_stream | 物理删除 | D11.5 |
| 7 | fanout/push 全量 AgentEvent parse + value.clone() | fanout.rs / pusher.rs | 收敛→meta | D12.1 |
| 8 | last_active 死字段语义 | session.rs | 修正→touch | D12.2 |
| 9 | 空壳 mpsc::channel(1) | join_room | 物理删除 | D12.4 |
| 10 | 错误 Pong 转发 | server.rs | 修正 | D12.4 |
| 11 | 无界 VecDeque pending | pusher.rs mark_pending | 收敛→有界+store | D12.6 |
| 12 | 「drain 挂点待装配」死注释路径 | push/mod.rs:106 | 接线后删注释 | D12.7 |
| 13 | cleanup_logs 零调用断链 | main.rs 装配 | 接线 | D12.9 |
| 14 | 无淘汰 task_owner_run / run_term_source / folded | push/engine.rs | 收敛→prune | D12.5 |
| 15 | O(丢帧次数) warn | engine_channels | 收敛→聚合 | D13.2 |
| 16 | V 项「待测」状态 | 90 §5 | 状态清零 | D13.3 |
| 17 | LS sessions 岛可写可读（伴随 D4） | sessionStore partialize | 守护+切除 | D13.4 |

**经对照：本三维全部工作单元均含删除/收敛/接线动作——无「纯新增无旧路径可删」项。**

---

## 6. 验收：功能 + 负产出 + 五端物证

### 6.1 功能验收（按维）

| 维 | 功能验收 |
| -- | -------- |
| D11 | 会签纪要 3 份（PE-02/SCHEMA/PROGRESS）存在；非增量跨 webview IPC ×1；message-start 无全文；tool-batch NoPersist；Progress 会签路径落地；合并前后文本等价；ToolStart 执行期可见（若做） |
| D12 | pending ≤ 上限且落库+周期消费；无通道不空转；cleanup_logs 调用；relay last_active 刷新+帧有界+Pong 回环；meta-only 旁路 |
| D13 | ci-slow 含 stress_；丢帧 warn O(1)；check-store-islands 进 check:desktop 且 fail 化；V 项无「待测」；负向断言清单 CI 绿 |

### 6.2 负产出验收（每阶段至少一项）

| 阶段 | 负产出 |
| ---- | ------ |
| Layer 1 | 删除：value.clone() 全量 parse + 空壳 mpsc + 无界 pending 增长 + cleanup 断链 + O(n) warn；接线：stress/CI |
| Layer 3 | 删除：全文双发 webview 路径 + message-start 全文字段 + tool-batch persist 幽灵标志 +（B）ToolProgress 构造 |
| Layer 4 | 删除：伪缓冲立即 flush；收敛：合并语义下 contract 仍绿 |
| Layer 5 | 删除：V「待测」；收敛：负向断言从散落到 CI 全绿；LS 岛 0 读 0 写锁定 |

### 6.3 五端物证（强契约项摘要）

| 端 | D11.1 双发消除 | D11.2 start 瘦身 | D11.4 PE-02 合并 | D11.5-A Progress | D12.6 pending | D12.9 cleanup |
| -- | -------------- | ---------------- | ---------------- | ---------------- | ------------- | ------------- |
| 触发 | 真实 run | 真实 run | 长流 run | 含长 shell | 离线+高频 | 冷启动 |
| 传输 | 回执在 manifest | 摘要在 manifest | delta 形状不变 | tool-progress 在 manifest | mark_pending | spawn_blocking |
| 介质 | 落库 1 份 | start 行无全文 | delta 不落库 | NoPersist | SQLite pending | 日志目录策略 |
| 消费 | EventRouter 正常 | handler 零改动 | batcher 等价 | 前端消费/或 B 无构造 | pending_len 诊断 | retention 生效 |
| 负向 | 旧双发 grep 0 | 旧 message grep 0 | 乱序丢弃红 | B 构造 grep 0 | 无界路径根除 | 零调用根除 |

---

## 7. 防御脚本 / 守护测试增量

| 资产 | 动作 | 单元 |
| ---- | ---- | ---- |
| `check-store-islands.mjs` | **新建** + check:desktop 接入 | D13.4 |
| `registry_drift` | 扩展：前端 commandMap ⊆ manifest；parser case ⊆ events.rs enum；T2 后全绿 | D11 全部 |
| streaming_incremental_contract | 合并语义锚点更新 + 保留必跑 | D11.4 |
| handlerBehavior.test.ts | message-start 空实现锚定保持 | D11.2 |
| pusher/fanout 单测 | meta-only + 非白名单零 parse + pending 上限 | D12.1/6/7 |
| telemetry 库单测 | 保留 + 壳层 smoke | D12.9 |
| ci-slow stress_ job | 新增 | D13.1 |
| tracing-test warn cap | 丢帧 warn ≤ 每 flush 1 | D13.2 |
| 夹具单测 | store-islands 红/绿 | D13.4 |

---

## 8. 执行派发建议（逻辑切片，不谈工期）

**首轮并行（T0，文件域不相交）：**

| 单元 | 维 | 内容 |
| ---- | -- | ---- |
| U-RELAY | D12 | D12.2–4 relay 全部 T0 |
| U-PUSH | D12 | D12.1(旁路侧)+D12.5–8 push/telemetry |
| U-CI-OBS | D13 | D13.1 压测 ci-slow + D13.2 warn 聚合（engine_channels 与 D1 协调点标注） |
| U-STORE-ISL | D13 | D13.4 check-store-islands 脚本骨架+夹具 |
| U-META-BRIDGE | D12/D6 | D12.1 core_event_bridge EventMeta 产出（与 D6 只读共享定义） |

**会签启动（与首轮并行）：**

- PR-PE-02 / PR-SCHEMA / PR-PROGRESS 纪要流程立即启动；
- PR-PROGRESS 用户勾选路径 A/B/C。

**第二轮（评审通过后）：**

| 单元 | 维 | 内容 |
| ---- | -- | ---- |
| U-SCHEMA | D11 | D11.1–3、D11.5（按会签）单主责 |
| U-PE02 | D11 | D11.4、D11.7 单主责（engine_channels 与 D1 串行合入） |

**第三轮（收口）：**

| 单元 | 维 | 内容 |
| ---- | -- | ---- |
| U-NEG | D13 | D13.7 负向断言全量接入 CI |
| U-VERIFY | D13 | D13.3 V 项经 4000 MCP 全量回填 |

---

## 9. 附录：关键代码锚点（证据）

| 主张 | 证据 |
| ---- | ---- |
| PE-02 合并禁令明文 | `crates/session-loop/src/provider.rs:191-193`；PE-02 §3.1.2 |
| 非增量事件双发 | `run_idle.rs:1405-1421`；`mod.rs` 双轨 |
| message-start 全文零消费 | `engine-events.json:141`；`messageHandlers.ts` 空实现 |
| Progress 恒 None | `exec_single.rs:536-558`；`executing_tools.rs:89-98` |
| 旁路全量 parse | `fanout.rs:281-293`；`pusher.rs:408-413` |
| push pending 无界 | `pusher.rs:118,258-278`；main.rs 未 with_pending_store |
| send_pending_batch 未接线 | `vendor/consumer.rs:192`；`push/mod.rs:106` 自注 |
| cleanup_logs 未调用 | `conex-telemetry/file.rs:355`；main.rs 零调用 |
| relay last_active 不刷新 | `session.rs:166-177`；`server.rs:42-53` |
| relay 帧无上限 | `conex-relay/src/protocol.rs:105-119` |
| EventBuffer 压测 ignore | `buffer.rs:349-456` |
| partialize 全量 sessions | `sessionStore.ts:64-69` |
| schemaVersion=1 | `engine-events.json:3` |
| 真缓冲伪 flush | `engine_channels.rs:715-720` |

---

## 10. 会签清单与交叉汇报（摘要）

**会签清单（强制启动）**：

1. PR-PE-02 — 同 block 追加合并（通过/否决纪要）
2. PR-SCHEMA — engine-events 变更集（双发回执/start 瘦身/tool-batch/Progress-A）
3. PR-PROGRESS — 三选一用户会签（A/B/C）
4. （挂接）PR-LS-BODY / PR-MOTION — 归 D4/D9 主责，本维只读
5. （可选）PR-ORDER — ToolStart 顺序契约

**与 D1 交叉**：真缓冲与合并窗串行；engine_channels/出口文件域主控协调；NoPersist 先于 tool-batch schema 票。

**与 D6 交叉**：数据面短路与 meta 产出点唯一 SSOT；双发回执归 D11；transport 信号串行。

---

_本详案为 D11+D12+D13 执行稿；实现前须过本维评审；子 Agent 禁止 git commit；主控验证五端物证与负向断言后收口。_
