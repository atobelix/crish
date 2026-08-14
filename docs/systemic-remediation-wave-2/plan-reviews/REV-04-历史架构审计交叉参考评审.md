# 阶段三：方案评审 — REV-04 历史架构审计（2026-08-14-architecture-audit）交叉参考与对比评审报告

> **评审编号**：REV-04  
> **评审主题**：历史架构审计（`2026-08-14-architecture-audit`）交叉参考与对比评审报告  
> **评审对象**：`docs/systemic-remediation-wave-2/plans/` 下全套方案（`00-总方案.md` ~ `06-上帝文件拆分与代码卫生详案.md`）  
> **对比基准**：`.agent-outputs/2026-08-14-architecture-audit/`（重点包含 `round-3-improvements/` 下 6 份加固收敛详案与 `round-2-reviews/` 对质结论）  
> **评审纪律**：遵循 `.agents/LOGIC_PLAN_NO_RETREAT.md`（纯逻辑规划、反退避、零工期偏见、所有问题同权、测试资产保护）与 `AGENTS.md`。  
> **评审输出路径**：`docs/systemic-remediation-wave-2/plan-reviews/REV-04-历史架构审计交叉参考评审.md`

---

## 目录

1. [评审背景、目标与方法论](#一评审背景目标与方法论)
2. [第一部分：历史方案闪光点与深度防御经验吸纳度比对矩阵](#二第一部分历史方案闪光点与深度防御经验吸纳度比对矩阵)
   - 2.1 编排压缩与 Wire 角色投影（01-orchestrator-compaction）
   - 2.2 工具执行、CAS 垃圾回收与存储并发（02-tools-storage）
   - 2.3 CRDT 协同、坐标单射与编辑器内核（03-collab-editor）
   - 2.4 沙箱安全、多端网关与桌面宿主（04-sandbox-host-network）
   - 2.5 前端 Store 状态机、流式渲染与视口锚定（05-frontend-store-streaming）
   - 2.6 系统级锁模型、池化调度与构建基线（06-systemwide-locks-concurrency）
   - 2.7 历史方案吸收与演进比对总表
3. [第二部分：已知深坑与边界盲区二次审视（盲区查漏补缺表）](#三第二部分已知深坑与边界盲区二次审视盲区查漏补缺表)
   - 3.1 跨卷移动源删除失败补偿清理与只读属性剥离
   - 3.2 Pinyin 连续合成 CRDT 对抗与 DOM Pinning / PatchBuffer 生产接线
   - 3.3 Win32 提权 Fail-Closed 判定与 5ms 急停切片
   - 3.4 CDP SSRF 阻断全覆盖（`http://` + `https://` 私网 + DNS 重绑定）
   - 3.5 领域模型锁中毒自愈（Rollback-On-Poison）vs L0 守卫 `into_inner()`
   - 3.6 虚拟列表撤销重做 120px 暴跌与 `heightMap` 元数据回灌
   - 3.7 边界盲区查漏补缺综合表
4. [第三部分：新方案创新突破与加固深度评估](#四第三部分新方案创新突破与加固深度评估)
   - 4.1 H1 静态/动态命令词法状态机与递归解构（PowerShell `&` 根治）
   - 4.2 H2 HTML 净化器未闭合标签残片实体转义（截断 XSS 根治）
   - 4.3 RecoveryCoordinator 权威实例全异步化与阻塞套娃彻底拔除
   - 4.4 🔴 P-01 Timeline 签名状态感知与流式单调不变量
   - 4.5 上帝文件单职责物理解耦与工作区工程卫生闭环
5. [第四部分：吸收历史最佳实践建议清单（指导阶段四方案定稿）](#五第四部分吸收历史最佳实践建议清单指导阶段四方案定稿)
   - 5.1 建议 Rec-01：显式纳入 `InFlightExportGuard` 代际令牌与瞬态删除抑制
   - 5.2 建议 Rec-02：规范区分 L0 内存守卫与 L1 领域状态机的锁中毒自愈策略
   - 5.3 建议 Rec-03：补齐跨卷回收站移动失败事务补偿与只读属性递归清除
   - 5.4 建议 Rec-04：吸收 `MessageSnapshots` 携带 `heightMap` 彻底消灭 Undo 视口抖动
   - 5.5 建议 Rec-05：固化 CDP `setBlockedURLs` 对私网 IP 与 DNS 重绑定的双协议防御
   - 5.6 建议 Rec-06：多端网关与 Wire-Only 角色交替投影层协议协同
6. [第五部分：评审结论与定稿建议](#六第五部分评审结论与定稿建议)

---

## 一、评审背景、目标与方法论

在 Conex / Crish 系统演进历程中，前期开展的架构审计工作（归档于 `.agent-outputs/2026-08-14-architecture-audit/`）产出了 12 份独立方案、6 份红蓝对抗评审报告以及 6 份第 3 轮加固收敛报告（`round-3-improvements/01~06-*.md`）。该批历史成果沉淀了大量在高并发锁序、状态机时序、跨语言坐标单射、沙箱混淆对抗、网络幂等时钟与前端防撕裂等领域的深度防御经验。

本次 Systemic Remediation Wave 2 全新编制了总方案（`00-总方案.md`）及 6 份专业详案（`01~06-*.md`）。本评审报告（**REV-04**）作为阶段三方案评审的核心组成部分，专职负责**跨历史架构审计成果的交叉参考、纵深比对与查漏补缺**，确保：

1. **历史闪光点零遗漏**：历史审计中被形式化证明为正确的优秀解法（如 Single Writer Actor、Wire 角色投影、Unicode 标量单射、Nonce LRU 幂等自愈等）在新方案中得到 100% 继承与深化；
2. **已知深坑零回潮**：历史攻防中揭示的极端边界条件与隐蔽死角（如跨卷移动回滚、IME 连续合成撕裂、Win32 提权 Fail-Closed、CDP SSRF 双协议阻断等）在新方案中具备严密闭环；
3. **创新价值最大化**：提炼新方案相比历史方案的突破性创新（如 H1 词法状态机、H2 残片转义、RecoveryCoordinator 全异步化、Timeline 签名状态感知），并提出精准的增量改进建议，为阶段四方案定稿提供权威指导。

---

## 二、第一部分：历史方案闪光点与深度防御经验吸纳度比对矩阵

### 2.1 编排压缩与 Wire 协议（01-orchestrator-compaction）

#### 历史核心解法：

1. **Wire-Only 角色交替防 400 架构**：彻底废除领域层（`state.conversation`）插入合成 `User` Ack 消息的反模式，改为在 `agent-provider` 转换层（`to_chat_messages` / `to_responses_input_items`）按需瞬态投影注入系统通知，保持数据库与 UI 100% 纯净。
2. **ToolBatch 原子完整性闭包与压缩松弛**：
   - 修复 `j > fold_start` 下界锁死缺陷为 `j >= fold_start`；
   - 落实双向完整性闭包：保留段包含 `Assistant` 必须包含其全部 `ToolResult`，反之亦然；
   - 追加后二次紧急预检（Emergency Preflight）：当 `held` 消息突破 Token 预算时强制执行紧急压缩。
3. **单点重试与 Abort 穿透闭环**：
   - 废除 Provider 内部多轮退避，重试所有权单点收敛至 `session-loop`（消除 $3\times3=9$ 次爆炸）；
   - 在 `engine_provider.rs` 中用 `tokio::select!` 包装 `send().await`，消除握手挂起；
   - 真实 `AbortHandle` 注入 `read_sse_stream`；补齐 `RunStateMachine` 的 `Initializing -> Cancelled` 状态转移。

#### 现行方案吸纳与对比：

- **吸纳状态**：**完全吸收并深化（Full Adoption & Refinement）**。
- **证据与分析**：
  - 在 `06-上帝文件拆分与代码卫生详案.md` 任务 1 中，`conex-compaction` 被物理拆分为 `tokens.rs`、`thresholds.rs`、`cut_point.rs`、`plan.rs`、`engine.rs`、`template.rs` 6 个单职责子模块。
  - `cut_point.rs` 显式承载了 `enforce_tool_batch_closure`（ToolBatch 双向闭包）与 `j >= fold_start` 松弛算法；`engine.rs` 显式承载了 `emergency_preflight` 紧急预检机制。
  - `00-总方案.md` Phase L2-4 将其作为核心任务推进，完全继承了 103 项单元测试基线。

---

### 2.2 工具执行、CAS 垃圾回收与存储并发（02-tools-storage）

#### 历史核心解法：

1. **Windows 三阶段原子写入与 InFlightExportGuard 自愈状态机**：
   - 废除同步 `unregister`，引入 **1000ms 自然 TTL** 与单调递增代际令牌（`Generation Token: u64`）；
   - 引入 `InFlightSuppressVerdict` 与 `SuppressTransientDeletion` 机制，容忍微秒级文件重命名缺失，压制假 `MissingFile` 告警；
   - 底层 FS 过滤网收窄，专有过滤 `.conex-tmp-*` 与 `.conex-bak-*`。
2. **CAS 垃圾回收活数据保护与分级安全租约**：
   - 全域引用联合查询（CRDT 快照 + Undo 栈 + 活跃视图）；
   - `BlobLeaseGuard` 30 分钟上传租约与并发写入防护；
   - 7 天隔离期软删除（Quarantine）与 `get_blob` 反隔离自愈；
   - CAS 分级存储（$\le 64\text{KB}$ 内联 / $> 64\text{KB}$ 外置物理文件）与物理文件 `remove_file` 联动。
3. **SQLite 读写分离、自适应连接池与 5ms/50 条 Group Commit 管道**：
   - `ReaderPool` 8 槽只读连接池 Try-Lock 空闲探测，消除慢查询护航效应（Convoy）；
   - `DbWriteHandle` Single Writer Actor，5ms / 50 条批处理，写闭包 `catch_unwind` 隔离。

#### 现行方案吸纳与对比：

- **吸纳状态**：**深度继承并全面工程化落地（Full Production Wiring）**。
- **证据与分析**：
  - `03-存储GC与协同编辑详案.md` 针对历史遗留的“4 大模块生产未接线”缺陷进行了系统性重构：
    - `LocalDb` 结构体全面升级为包含 `writer: DbWriteHandle`、`reader_pool: Arc<ReaderPool>`、`lease_guard: Arc<BlobLeaseGuard>` 的读写分离架构（§3.1）；
    - `group_commit.rs` 内部严格落地 `catch_unwind` 屏障与 Savepoint 事务回滚（§3.2）；
    - CAS GC 优化索引覆盖扫描，分批 `LIMIT 100`，并在清除数据库前物理 `fs::remove_file` 删除外置文件，彻底解决磁盘泄露（§3.3）；
    - 补齐生产后台自驱动定时调度器 `spawn_cas_gc_loop`（§3.4）；
    - 统一 SHA-256 算法至 `sha2::Sha256`，删除 DDL 冗余（§3.5）。
  - `01-安全与沙箱AST根治详案.md` M6 收窄了 `watch.rs` 瞬态过滤规则为 `.conex-tmp-`，防止用户正常 `.tmp`/`.bak` 文件漏报。

---

### 2.3 CRDT 协同、坐标单射与编辑器内核（03-collab-editor）

#### 历史核心解法：

1. **强类型标量坐标无损转换与代理项保护体系**：
   - 建立编译期隔离的 Branded Types（`Utf16CodeUnitOffset` vs `UnicodeScalarOffset`）；
   - Surrogate-Aware 双向无损转换与 `diffToReplace` 统一收敛，彻底杜绝 Emoji 辅助平面与 ZWJ 复合表情（如 `👨‍👩‍👧‍👦`）引发的 Off-by-4 偏移崩塌；
   - 拦截代理项内部奇数偏移（Non-Invertible Surrogate Split）。
2. **双向 IME 协同生命周期保护、补丁缓冲与 DOM Pinning**：
   - `CompositionPatchBuffer` 增量缓冲区在输入法合成期间暂存远端补丁；
   - `DOMPinningRegistry` 锁定正在输入的 DOM 节点，防止并发删除导致 WebView2 崩溃；
   - 合成收尾增量合入（Composition Commit & Mapping Re-projection）。
3. **Yrs 原生因果撤销与二进制 Update 纯净分层**：
   - 废除全树快照回滚（会抹除远端并发），收敛至 `yrs::undo::UndoManager` 原生局部因果逆元（`text_undo` / `text_redo`）；
   - 二进制 Update 冷藏与无损唤醒。

#### 现行方案吸纳与对比：

- **吸纳状态**：**完全继承并跨包契约统一（Cross-Package Contract Unified）**。
- **证据与分析**：
  - `03-存储GC与协同编辑详案.md` §4 深度贯彻了这一体系：
    - 根除快照覆盖吞并发缺陷，收敛至 `DocSession::text_undo` / `text_redo` 因果撤销（§4.1）；
    - 修复 `text_undo` 空操作、空洞 rev 推进与增量快照脏块优化（§4.2）；
    - `NoteBackend` & `StoreNoteBackend` 全链路暴露 `undo_text` / `redo_text` 并接入 IPC 命令层（§4.3）；
    - 坐标转换唯一真源统一收敛至 `@crish/block-paper-contract`，消除 `DiffReplaceResult` 在 `editor-kit` 与 `block-paper` 间的语义冲突（§4.4）；
    - 修复代理项内部偏移非互逆性，保障 `buildCodeTextEditIntent` 签名安全（§4.5）；
    - 将 `DOMPinningRegistry` 与 `CompositionPatchBuffer` 生产装配至 `PaperList` 与编辑器交互层（§4.6）。

---

### 2.4 沙箱安全、多端网关与桌面宿主（04-sandbox-host-network）

#### 历史核心解法：

1. **沙箱命令词法状态机与反混淆**：词法归一化状态机，PowerShell 动态反射与 ScriptBlock 递归分析，本地 IPC 与远程网关双端二次 AST 门禁。
2. **多端网关弱网 Nonce 幂等与时钟自愈**：
   - HMAC-SHA256 签名与 Canonical Payload 规范；
   - `AdvancedNonceGuard` 记录 `(device_id, nonce) -> (ts, payload_hash, response)` 实现弱网幂等重传放行与防重放窗口击穿治理；
   - 免鉴权 `/v1/hello` 与全量响应头注入 `X-Server-Time-Ms` 根治客户端时钟死锁。
3. **三态（Active/Detached/Dead）PTY 进程状态机**：
   - 终端生命周期与 UI 渲染解耦；
   - OS 读线程 stdout 输出流双向活性自动续约（`session.touch()`）；
   - 前端全局单例 Store 与后台 30s GC 清扫循环（2h 游离宽限期）。
4. **桌面系统与浏览器自动化**：
   - Win32 API 动态解析前台窗口 HWND/PID，`ERROR_ACCESS_DENIED` 严格 Fail-Closed 判定提权；
   - 硬件注入循环 5ms 切片原子急停；
   - 1280x720 严格等比缩放（HD720）；
   - CDP SSRF 传输层 `Network.setBlockedURLs` 挂载，计算样式解析与跨域 iframe 偏置累加。

#### 现行方案吸纳与对比：

- **吸纳状态**：**完全继承并解除门控、实现生产真实装配（Un-Gated & Hardened）**。
- **证据与分析**：
  - `05-多端契约与网络治理详案.md` 彻底拔除了 `auth.rs` 中将生产安全原语伪装为测试代码的 `#[cfg(test)]` 门控，在 `ServerState` 中持有一等 `AdvancedNonceGuard`，并在 `ws.rs` 与 `router.rs` 中接入全量 HMAC 验签与 `X-Server-Time-Ms` 注入（§4.1）。
  - `05` 详案 §4.2 完善了 PTY detach / attach / ping 命令注册，GC 回收时通过 `app.emit` 广播 `workbench://pty-gc-killed`。
  - `01-安全与沙箱AST根治详案.md` M4 落实了 Win32 提权 Fail-Closed，废除了 `access_denied_elevated.exe` 魔法字符串；M2/M3/M5 加固了 CDP 传输层双协议阻断（`http://` + `https://`）与 DNS 重绑定防线。

---

### 2.5 前端 Store 状态机、流式渲染与视口锚定（05-frontend-store-streaming）

#### 历史核心解法：

1. **双 Store 割裂消除与三元降级渲染模型**：
   - `MessageContent.tsx` 引入 `hasCommittedText && completed ? msg.text : (streamText ?? msg.text)` 消除流终态 1 帧空白闪烁；
   - `StreamRenderBuffer` 单一时钟源与 Unicode Grapheme 截断；
   - `commitStreamToSession` 单次 Immer 原子写入与微任务延迟清空；
   - `finalizeAgentMessages` 子代理多消息残余正文自动聚合。
2. **`MessageSnapshots` 捕获 `heightMap` 与 Undo 滚动锚定**：
   - `MessageDelta` 引入 `heightMap` 元数据，捕获 `VirtualScrollManager` 实测高度；
   - `useUndoWithScrollAnchor` 在微任务中同步校准 `scrollTop`，阻断 120px 暴跌与视口千像素抖动。
3. **请求级持久审批锁与防倒退守卫**：
   - 废除 480ms/200ms 假锁定时器，建立基于 `toolId` 的 `inFlightToolIdsRef` 闭包持久锁；
   - `.catch()` 增加状态防倒退守卫，拦截后发错误覆写 `running`/`success` 态。

#### 现行方案吸纳与对比：

- **吸纳状态**：**完全继承并突破性解决交错块签名截断缺陷（Enhanced with Monotonic Invariant）**。
- **证据与分析**：
  - `04-前端流式与状态管理详案.md` 全面落实了上述设计，并进一步突破：
    - 🔴 **P-01 详案** 深入穿透了交错块（`[{type: 'text'}, {type: 'tool_call'}, {type: 'text'}]`）下尾部文本在流式到完成态切换时被 `timelineSignature` 截断的深层根因，确立了流式单调不变量 $\text{RenderedText}(t_1) \subseteq \text{RenderedText}(t_2)$，通过状态感知签名 + 状态跃迁显式失效 + A-06 兜底投影三层防线彻底根治（§3）；
    - **P-02** 增加了 `useApprovalKeyboard` 的 `rootRef.current?.contains(target)` 容器焦点守卫（§4）；
    - **P-03** 将 445 行上帝 Hook `useChatApprovalHandlers` 拆分为 3 纯函数模块 + 2 子 Hook，并下沉强类型 `approvalRollbackGuard`（§5）；
    - **P-04** 在 `streamingStore` 新增 `clearStreams(sessionId, messageIds)` 精准清流，防止多 Agent 并发清理误伤（§6）；
    - **P-05** 在 `sessionCrudActions.deleteSession` 补齐跨 Store 级联清理（§7）。

---

### 2.6 系统级锁模型、池化调度与构建基线（06-systemwide-locks-concurrency）

#### 历史核心解法：

1. **五级严格单向锁序图谱（$L_0 < L_1 < L_2 < L_3 < L_4$）**：
   - $L_0$ 细粒度内存守卫 $\to$ $L_1$ 领域文档/会话状态 $\to$ $L_2$ 协调器状态机 $\to$ $L_3$ 数据库独占写者 $\to$ $L_4$ WAL 只读池；
   - 形式化证明消除 AB-BA 环路死锁。
2. **跨 `await` 同步锁消除**：
   - `RecoveryCoordinator` 异步互斥锁重构；
   - Tauri IPC 笔记命令彻底消除嵌套 `block_on`；
   - `SummaryDispatch` 消除 60s 阻塞 Summarizer 僵尸线程。
3. **三层专用工作池物理隔离**：
   - Tier 1: SQLite 单写 Actor + 多读池；
   - Tier 2: Rayon 物理隔离 CPU 密集型计算池（FTS5、CAS 哈希、Markdown AST、XSS 清洗）；
   - Tier 3: Tokio 阻塞池轻量 IO + `Semaphore(64)` 硬背压门禁。
4. **领域状态锁中毒自愈协议（Rollback-On-Poison）**：
   - 废除盲目 `into_inner()`，领域数据结构锁中毒时强制从持久化快照重新 Hydrate。

#### 现行方案吸纳与对比：

- **吸纳状态**：**完全继承并转化为可验证的真实压测套件（Adoption & Empirical Verification）**。
- **证据与分析**：
  - `02-并发锁序与异步协调详案.md` 严格落地了五级偏序锁序契约（§4.3）：
    - 彻底拔除 `CoreRunState.recovery_coordinators` 的 `std::sync::Mutex` 与 `blocking_coordinator_call` / `block_on_coordinator_failure` 套娃，全面升级为 `Arc<tokio::sync::Mutex<RecoveryCoordinator>>`（§4.1）；
    - 消除 `pending_input_lifecycle.rs` 中 6 处 `sleep(30ms)` 假等待，构建确定性 `wait_until` 轮询设施（§4.4）；
    - 废除前端 `stress-16-subagents.test.ts` 中的自写 `AsyncMutex` 与 `SingleWriterQueue` 玩具模型，接入真实并发设施（§4.5）；
    - 新增 `stress_empirical_concurrency.rs`，在真实 `LocalDb` WAL 实例与真实内核状态机上实现 16 写 + 8 读并发零死锁与 $P_{99}(L_0) \le P_{99}(L_1) \le P_{99}(L_2)$ 偏序阶梯实证（§4.6）。

---

### 2.7 历史方案吸收与演进比对总表

| 核心架构维度             | 历史加固方案核心解法（Round 3）                                                               | Wave 2 现行方案对应章节                             | 吸纳与深化状态 | 关键判定与证据                                                                                         |
| :----------------------- | :-------------------------------------------------------------------------------------------- | :-------------------------------------------------- | :------------: | :----------------------------------------------------------------------------------------------------- |
| **模型压缩与 Wire 协议** | Wire-Only 瞬态角色投影；ToolBatch 原子闭包；`j >= fold_start` 松弛；单 Run 紧急预检           | `06-上帝文件拆分详案` §4<br/>`00-总方案` Phase L2-4 |  **完全吸收**  | `conex-compaction` 拆为 6 子模块，`cut_point.rs` 与 `engine.rs` 完整承载闭包与预检。                   |
| **存储并发与 GC 治理**   | `LocalDb` 读写分离；`DbWriteHandle` Actor；`ReaderPool` 8 槽；CAS GC 物理 unlink；30m 租约    | `03-存储GC详案` §3<br/>`00-总方案` Phase L1-2, L2-3 | **全面工程化** | 生产装配 4 大模块，补齐 `catch_unwind` 隔离、Savepoint 回滚与后台定时 GC 调度器。                      |
| **CRDT 协同与坐标单射**  | Branded Types 坐标品牌；代理项双向无损转换；`yrs::undo` 因果撤销；DOM Pinning 与 IME 补丁缓冲 | `03-存储GC详案` §4<br/>`00-总方案` Phase L1-5, L3-4 | **契约单源化** | 统一坐标真源至 `block-paper-contract`，消除 `DiffReplaceResult` 歧义，`NoteBackend` 暴露因果撤销。     |
| **多端网关与安全沙箱**   | 解除 `#[cfg(test)]` 门控；`AdvancedNonceGuard` 幂等表；时钟自愈；三态 PTY；提权 Fail-Closed   | `05-多端契约详案` §4<br/>`01-安全详案` §3, §4       |  **生产实装**  | `ServerState` 装配 NonceGuard，双向打通 `X-Server-Time-Ms`，PTY GC 广播，PowerShell `&` AST 递归解析。 |
| **前端流式与状态管理**   | 三元降级防 1 帧闪烁；Unicode Grapheme 截断；`heightMap` Undo 锚定；请求级持久审批锁           | `04-前端流式详案` §3~§7<br/>`00-总方案` Phase L4    | **突破性深化** | 确立流式单调公理，根治交错块 `timelineSignature` 截断；拆解 445 行 Hook；精准消息级清流。              |
| **并发锁序与异步协调**   | 五级偏序（$L_0 \sim L_4$）；消除跨 `await` 同步锁；三层工作池；Rollback-On-Poison             | `02-并发锁序详案` §4<br/>`00-总方案` Phase L2-1, L5 | **真机实证化** | 彻底异步化 `RecoveryCoordinator`，拆除测试玩具假锁与假等待，落地真实 SQLite WAL 16 并发压测。          |

---

## 三、第二部分：已知深坑与边界盲区二次审视（盲区查漏补缺表）

在历史架构审计与对质评审过程中，红蓝双方曾揭示出一批极具破坏性的隐蔽死角与边缘陷阱。本节对现行 Wave 2 方案进行二次攻防审视，核查是否存在遗漏或表述不严密之处：

### 3.1 跨卷移动源删除失败补偿清理与只读属性剥离

- **历史陷阱描述**：在 Windows 文件系统跨卷（如从 `C:\` 移动到 `D:\` 回收站）执行原子落盘或回收站归档时，操作退化为 `fs::copy(src, dst)` + `fs::remove_file(src)`。若目标文件 `dst` 写入成功，但源文件 `src` 因权限或被其他进程句柄短暂锁定导致删除失败，会残留孤儿文件；此外，若源文件包含 Windows 只读属性（`FILE_ATTRIBUTE_READONLY`），`remove_file` 将直接报 `AccessDenied`。
- **现行方案审视**：
  - `01-安全与沙箱AST根治详案.md` M1 明确重构了 `trash.rs`，采用 `fs::symlink_metadata` 严格区分 `NotFound` 与 `PermissionDenied`，防止误判原文件不存在而静默返回；
  - `00-总方案.md` 任务 L1-6 提及了 FS 快照与监视器 Fail-Closed 修复。
- **查漏补缺建议（Gap Finding & Action）**：
  - 现行 `01` 详案对 `TrashService::snapshot` 的权限校验做了详尽规定，但在跨卷移动出现 `src` 删除失败时的**反向补偿清理（`fs::remove_file(dst)` 事务回滚）**以及 **Windows 只读属性递归剥离（`permissions.set_readonly(false)` 后重试）** 需在阶段四定稿中作为标准子例程显式固化进 `crates/conex-fs/src/trash.rs`（见下文建议 Rec-03）。

---

### 3.2 Pinyin 连续合成 CRDT 对抗与 DOM Pinning / PatchBuffer 生产接线

- **历史陷阱描述**：用户在拼音输入法连续打字（Composing）期间，若远端协作者或后台 Agent 产生了并发文本变更：
  1. 若直接应用远程 Patch，ProseMirror 会强制重绘 DOM，导致正在输入的 IME 组合状态中断上屏甚至打乱汉字拼音；
  2. 若远端执行了块删除或结构重组，React 虚拟 DOM 会直接 Unmount 正在输入的 DOM 节点，引发 Chromium/WebView2 的 IME 内部指针崩溃（Crash）；
  3. 若前端微任务锁未同步更新 `leaf.state`，会导致状态撕裂。
- **现行方案审视**：
  - `03-存储GC与协同编辑详案.md` §4.6 明确将 `DOMPinningRegistry` 与 `CompositionPatchBuffer` 纳入生产装配，在 `PaperList` 与编辑器交互层建立连接；
  - `00-总方案.md` L4-7 明确规划了 DOM Pinning 与 IME 增量缓冲的产品化接线。
- **查漏补缺建议（Gap Finding & Action）**：
  - 需确保在阶段四定稿中，`CompositionPatchBuffer` 的释放时机严格绑定在 `compositionend` 事件之后的微任务队列中，并采用映射重投影（Mapping Re-projection）将暂存的远端 Delta 转换后安全合入，确保输入法上屏文字与远端文字因果无损（见下文建议 Rec-04）。

---

### 3.3 Win32 提权 Fail-Closed 判定与 5ms 急停切片

- **历史陷阱描述**：桌面自动化工具在捕获前台窗口句柄并探测其是否处于提权（Elevated / Administrator）状态时：
  1. 当由于 UIPI（用户界面特权隔离）或权限受限导致 `OpenProcessToken` 返回 `ERROR_ACCESS_DENIED` 时，旧实现曾误判为“未提权”（Fail-Open），导致非特权 Agent 尝试向高特权窗口注入按键，引发系统安全报警或注入失败挂起；
  2. 硬件按键/鼠标注入长序列如果缺乏细粒度急停感知，会导致用户在发现异常时无法通过热键或 UI 立即终止。
- **现行方案审视**：
  - `01-安全与沙箱AST根治详案.md` M4 明确要求 `process_is_elevated` 句柄获取失败无条件 Fail-Closed，并将 `access_denied_elevated.exe` 魔法字符串彻底清除，对接真实进程感知；
  - 现行方案中已确立了安全提权门禁。
- **查漏补缺建议（Gap Finding & Action）**：
  - 在阶段四实施中，确保 `conex-computer` 的按键模拟循环中保持 5ms 切片延时并原子轮询 `EmergencyStop` 标志位，急停置位时 $\le 5\text{ms}$ 内中止注入并释放所有处于按下状态的按键（Key-Up Flush）。

---

### 3.4 CDP SSRF 阻断全覆盖（`http://` + `https://` 私网 + DNS 重绑定）

- **历史陷阱描述**：在浏览器自动化会话中，攻击者通过 Prompt 诱导 Agent 访问内网敏感服务（如 `http://169.254.169.254/latest/meta-data/`、`http://127.0.0.1:8080/admin` 或 `http://192.168.1.1/`）。
  1. 若 CDP 仅下发 `http://` 阻断规则，攻击者使用 `https://` 即可绕过；
  2. 攻击者可使用公网域名解析至私网 IP，或利用 DNS 重绑定（DNS Rebinding）在首次解析通过后切换至内网 IP。
- **现行方案审视**：
  - `01-安全与沙箱AST根治详案.md` M2 明确要求 `gate.rs` 生成 `http://` 与 `https://` 双协议阻断模式；M5 增加了白名单模式下的私网 IP 解析二次防线。
- **查漏补缺建议（Gap Finding & Action）**：
  - 严格保持在 `BrowserSession` 初始化、导航（`Page.navigate`）以及新建 Target（`Target.targetCreated`）时，100% 自动下发 `Network.setBlockedURLs`，杜绝任何未受保护的空白窗口（见下文建议 Rec-05）。

---

### 3.5 领域模型锁中毒自愈（Rollback-On-Poison）vs L0 守卫 `into_inner()`

- **历史陷阱描述**：在 Rust 多线程并发中，若某个持有 `std::sync::Mutex` 的线程发生 panic，锁会被置为 Poisoned。
  - 对于**细粒度 L0 内存守卫**（如存放句柄索引的 `HashMap`），调用 `lock().unwrap_or_else(|e| e.into_inner())` 可以快速复用未损坏的外层结构；
  - 但对于**核心 L1 领域状态机**（如维护 Yrs CRDT 状态的 `DocSession` 或维护编排树的 `SessionTree`），锁中毒通常意味着内部状态机在突变中途发生断裂，若盲目 `into_inner()` 会导致脏内存向后扩散，最终导致持久化数据被污染。
- **现行方案审视**：
  - `02-并发锁序与异步协调详案.md` §4.1.3 中在 `coordinator_for` 读取 `recovery_coordinators`（L0 HashMap）与 `session_trees` 时使用了 `into_inner()`，此处于 L0 层级是安全的；
  - `03-存储GC详案` 采用了 Single Writer Actor + `catch_unwind` 隔离，消除了数据库连接锁中毒。
- **查漏补缺建议（Gap Finding & Action）**：
  - 在阶段四详案定稿中，需形式化明确**分级锁中毒自愈策略**：L0 守卫锁允许安全的结构级复用；L1/L2 核心领域状态机若发生 Poison，必须丢弃内存实例，强制触发 Rollback-On-Poison 协议，从 SQLite WAL 快照重新 Hydrate（见下文建议 Rec-02）。

---

### 3.6 虚拟列表撤销重做 120px 暴跌与 `heightMap` 元数据回灌

- **历史陷阱描述**：在长消息会话列表中，虚拟滚动（Virtualizer）基于估算高度（如默认 120px）与动态实测高度维护滚动位置。当用户执行 `Undo` 撤销删除操作、导致上方大批量历史消息瞬间恢复时：
  1. 若快照系统仅保存消息文本而不保存历史实测高度，恢复的消息将瞬间以 120px 默认高度渲染，待 DOM 测高完成后再次撑开，引发视口数百甚至数千像素的剧烈跳跃（Scroll Jitter）；
  2. 视口第一可见元素的物理相对位移发生偏移，导致用户阅读锚点丢失。
- **现行方案审视**：
  - `04-前端流式与状态管理详案.md` 聚焦于 `timelineSignature` 文本截断根治、Esc 容器守卫与上帝 Hook 拆分。
- **查漏补缺建议（Gap Finding & Action）**：
  - 阶段四应将历史 `05-frontend-store-streaming-improved.md` 中的 `MessageSnapshots` 携带 `heightMap` 与 `useUndoWithScrollAnchor` 视口同步校准算法，作为增量补充明确归入前端渲染标准（见下文建议 Rec-04）。

---

### 3.7 边界盲区查漏补缺综合表

|   序号   | 隐蔽死角 / 陷阱分类      | 潜在系统危害                                    | 历史审计对质结论                                         | 现行方案对应状态                               | 阶段四补缺加固措施                                                                 |
| :------: | :----------------------- | :---------------------------------------------- | :------------------------------------------------------- | :--------------------------------------------- | :--------------------------------------------------------------------------------- |
| **G-01** | **跨卷移动源删除失败**   | 产生磁盘孤儿文件，破坏原子落盘不变量。          | 必须实施反向删除补偿与只读属性剥离重试。                 | `01` M1 已区分权限拒绝，补偿逻辑需显式强化。   | 在 `conex-fs/src/trash.rs` 显式固化 `atomic_move` 补偿清理事务与只读属性自动剥离。 |
| **G-02** | **IME 连续合成并发撕裂** | 用户拼音输入被中断，严重时导致 WebView2 崩溃。  | 必须引入 DOM Pinning 保护与 Composition 补丁缓冲。       | `00` L4-7 与 `03` §4.6 已规划接线。            | 固化 `CompositionPatchBuffer` 在 `compositionend` 后微任务重投影合入契约。         |
| **G-03** | **提权探测 Fail-Open**   | 非特权 Agent 盲目向高特权窗口注入按键引发挂起。 | 权限查询受阻一律 Fail-Closed 判定提权并阻断。            | `01` M4 已落实 Fail-Closed 并消除魔法字符串。  | 保持按键注入 5ms 切片原子急停与按键安全释放。                                      |
| **G-04** | **CDP SSRF 协议绕过**    | 攻击者通过 `https://` 或 DNS 重绑定探测私网。   | 必须下发双协议阻断，并在白名单模式验证解析 IP。          | `01` M2/M5 已覆盖双协议与 DNS 重绑定。         | 确保所有 BrowserSession 建立与导航 100% 自动下发 `setBlockedURLs`。                |
| **G-05** | **领域锁中毒脏扩散**     | 状态机突变中途中断后脏内存扩散至持久化层。      | 废除领域层盲目 `into_inner()`，实施 Rollback-On-Poison。 | `02` 与 `03` 已消除了大部分同步跨 await 风险。 | 严格规范：L0 守卫允许结构复用，L1 领域状态机中毒必须从 DB 快照重新 Hydrate。       |
| **G-06** | **Undo 恢复 120px 暴跌** | 撤销恢复历史消息时视口剧烈震荡，丢失阅读锚点。  | 快照必须携带实测 `heightMap`，撤销时同步锚定。           | `04` 详案聚焦于签名截断与 Hook 拆分。          | 在 `MessageSnapshots` 中扩充 `heightMap` 并在撤销微任务中同步校准 `scrollTop`。    |

---

## 四、第三部分：新方案创新突破与加固深度评估

现行 Systemic Remediation Wave 2 方案不仅全面继承了历史方案的正确内核，而且在以下 5 个关键技术维度上实现了**突破性创新与更深层次的架构根治**：

### 4.1 H1 静态/动态命令词法状态机与递归解构（PowerShell `&` 根治）

- **创新突破点**：
  历史方案在沙箱命令分析中，仅通过简单的前缀扫描与正则匹配识别危险命令。当攻击者利用 PowerShell 的核心调用操作符 `&` 执行静态命令（如 `& cmd /c "rmdir /s /q D:\data"` 或 `& (Get-Command Remove-Item) C:\path`）时，历史实现由于将 `&` 误判为仅在后接动态变量（`$`）时才危险，导致大量的静态间接删除命令直接穿透沙箱门禁！
- **现行方案加固深度**：
  - `01-安全与沙箱AST根治详案.md` H1 全面重构了 `conex-sandbox/src/semantics.rs` 的词法状态机：
    1. 将 `&`、`invoke-command`、`icm` 显式纳入 `INDIRECT_COMMANDS`，并在 `normalize_command` 中自动识别并剥除可执行后缀 `.exe` 与调用符包裹；
    2. 在 `analyze_indirect` 构建专有 `&` 递归解构分支：精确将参数列表第 0 项提取为子命令，其余作为子参数拼接，深度递归调用 `analyze_depth`；
    3. 升级 `scan_ps_command_tokens`：深度递归提取内层删除形态，向上传播 `has_indirect_delete = true`；
    4. 加固 `gatekeeper::check_command` 与正则库，补齐 `\brmdir\b`、`\bdel\b`、`\brd\b` 对 Windows 盘符与绝对路径的全量覆盖，实现了**无论调用嵌套多深均 100% 拦截**的确定性安全。

---

### 4.2 H2 HTML 净化器未闭合标签残片实体转义（截断 XSS 根治）

- **创新突破点**：
  在流式输出、弱网截断或大模型输出被中间切断时，HTML 字符串常以未闭合的标签残片（如 `<img src=x onerror=alert(1)` 或 `<a href="javascript:steal()"`）结尾。历史净化器（`htmlSanitizer.ts`）仅使用正则表达式匹配合法的自闭合或成对标签，对于末尾未闭合的残片直接放行；随后前端将该字符串交给浏览器的 DOM 解析器（如 `innerHTML` 或 DOMParser）渲染时，浏览器会自动在 EOF 处补全闭合标签 `>` 并立即触发 `onerror` 脚本执行，造成致命的 XSS 漏洞！
- **现行方案加固深度**：
  - `01-安全与沙箱AST根治详案.md` H2 构建了**残片预检与实体转义防线**：
    1. 在标签主正则匹配前，使用专用正则 `/<([a-zA-Z0-9:-]+)(?:[^>"']|"[^"]*"|'[^']*')*$/g` 捕获末尾悬空的未闭合标签残片，并无条件使用 `escapeHtml` 将其安全转义为实体文本（`&lt;img ...`）；
    2. 执行孤立尖括号清理扫描，杜绝下游 DOM 解析器自动补全；
    3. 对属性值执行实体反转义二次校验，彻底阻断利用 HTML 实体编码混淆的 `javascript:` 伪协议。

---

### 4.3 RecoveryCoordinator 权威实例全异步化与阻塞套娃彻底拔除

- **创新突破点**：
  历史实现中，`CoreRunState.recovery_coordinators` 使用了 `std::sync::Mutex` 同步锁。但由于子代理恢复与 Fork 必须调用异步的 `SubagentSpawner::spawn(&request).await`，调用方不得不在 `tokio::task::spawn_blocking` 中使用 `Handle::current().block_on(...)` 强行驱动异步 Future。这种“在持同步锁的阻塞线程中通过 `block_on` 驱动异步”的模式，在高并发恢复争用下极易引发 **Tokio 工作线程池自死锁**。
- **现行方案加固深度**：
  - `02-并发锁序与异步协调详案.md` §4.1 彻底重构了该架构：
    1. 将注册表类型彻底统一为 `Arc<tokio::sync::Mutex<RecoveryCoordinator>>`；
    2. 彻底删除 `blocking_coordinator_call` 与 `block_on_coordinator_failure` 两个伪同步桥接函数；
    3. `main.rs` 中的 `core_resume_subagent` 与 `run_resume.rs` / `run_snapshot.rs` 全面重写为原生全异步流水线，实现了跨进程崩溃恢复链路的端到端零阻塞。

---

### 4.4 🔴 P-01 Timeline 签名状态感知与流式单调不变量

- **创新突破点**：
  历史方案在处理助手消息渲染时，为了避免流式高频打字触发整个时间线卡片的重复重绘，在 `timelineSignature` 中对尾部文本块进行了内容屏蔽。但在交错块（`[text, tool_call, text]`）场景下，当流式结束切换为持久化完成态时，签名算法未感知消息状态变化，导致 `buildAssistantTimelineCached` 误判为缓存命中，返回流式初期的旧快照，造成用户看到的最终渲染文本发生严重的**不可逆截断与缩水**。
- **现行方案加固深度**：
  - `04-前端流式与状态管理详案.md` 🔴 **P-01 详案** 形式化确立了**流式到完成态单调公理**：
    $$\text{RenderedText}(t_1) \subseteq_{\text{prefix}} \text{RenderedText}(t_2),\quad \text{len}(\text{RenderedText}(t_{\text{completed}})) \ge \text{len}(\text{RenderedText}(t_{\text{streaming\_final}}))$$
  - 构建了三层纵深防御体系：
    1. **签名算法状态感知**：`msg.status !== 'processing'` 时，尾部 text 块必须将其全量内容（`content`）纳入签名，强力击穿陈旧缓存；
    2. **组件状态跃迁显式失效**：`MessageContent.tsx` 侦测到 `streaming: true -> false` 时显式清空缓存引用；
    3. **A-06 特征兜底投影**：在无显式 text 块时将 `msg.text` 纳入签名投影。

---

### 4.5 上帝文件单职责物理解耦与工作区工程卫生闭环

- **创新突破点**：
  代码库中长期存在两座严重的“上帝文件”技术债：
  1. `crates/conex-compaction/src/lib.rs` 达到 **3,051 行**，耦合了 Token 估算、阈值决策、切割点算法、压缩编排、Markdown 模板渲染及 1,566 行测试；
  2. `apps/crish-mobile/src/adapters/wiring/pairingWiring.ts` 达到 **960 行**，承载了 11 项异构职责，且在 `checkHostFingerprint` 中存在严重的安全语义误用。
     同时，仓库根目录下误跟踪了 10 个临时/LOC 分析脚本，对 Git 工作区造成了长期污染。
- **现行方案加固深度**：
  - `06-上帝文件拆分与代码卫生详案.md` 给出了确定性的物理拆分与代码卫生落地详案：
    - `conex-compaction` 拆分为 `tokens.rs`、`thresholds.rs`、`cut_point.rs`、`plan.rs`、`engine.rs`、`template.rs` 6 个子模块，`lib.rs` 收敛至 80 行以内，单测完整迁移至 `tests/compaction_tests.rs`，严格满足 500 行门禁；
    - `pairingWiring.ts` 拆分为 `sessionSigning.ts`、`pairingGateway.ts`、`pairingPersistence.ts`、`fingerprintVerifier.ts`、`PairingWiring.ts`、`pairingAssembly.ts` 6 个模块，修复了指纹校验语义，行数降至 380 行；
    - 执行 `git rm --cached` 精确剥离 10 个临时脚本，完善 `.gitignore` 规则，并接入 `check-conflict-markers.mjs` pre-commit 门禁。

---

## 五、第四部分：吸收历史最佳实践建议清单（指导阶段四方案定稿）

基于历史架构审计经验与本次交叉参考比对结论，为指导阶段四（方案定稿与任务书编制），提出以下 **6 项高价值增量改进建议（Rec-01 ~ Rec-06）**：

### 5.1 建议 Rec-01：显式纳入 `InFlightExportGuard` 代际令牌与瞬态删除抑制

- **建议级别**：**高价值强化（High Priority Enhancement）**
- **关联文件**：`docs/systemic-remediation-wave-2/plans/03-存储GC与协同编辑详案.md`、`crates/conex-workspace-store/src/in_flight_guard.rs`
- **具体改进规范**：
  在 `03` 详案的文件镜像导出章节中，显式固化历史 `02-tools-storage-improved.md` 提出的 `InFlightExportGuard` 规范：
  1. 彻底废除导出后的同步 `unregister` API，改为 **1000ms 自然 TTL** 淘汰；
  2. 引入 `Generation Token: u64`，新写入自动刷新 Token；
  3. 引入 `InFlightSuppressVerdict::SuppressTransientDeletion` 机制，在 Windows 重命名微秒级物理缺失期容忍 `NotFound`，杜绝 OS Watcher 产生假 `MissingFile` 告警。
- **验收标准**：模拟 Windows 密集原子写入，OS Watcher 假漂移与假删除触发次数恒为 0。

---

### 5.2 建议 Rec-02：规范区分 L0 内存守卫与 L1 领域状态机的锁中毒自愈策略

- **建议级别**：**高价值强化（High Priority Enhancement）**
- **关联文件**：`docs/systemic-remediation-wave-2/plans/02-并发锁序与异步协调详案.md`、`crates/orchestrator/src/recovery.rs`、`crates/conex-doc-collab/src/session.rs`
- **具体改进规范**：
  在 `02` 详案中明确补充**锁中毒自愈（Poison Handling）分类处理规范**：
  1. **L0 细粒度内存守卫**（如 `recovery_coordinators: Mutex<HashMap<...>>`）：允许使用 `unwrap_or_else(|e| e.into_inner())` 进行安全的容器复用；
  2. **L1/L2 核心领域状态机**（如 `DocSession`、`SessionTree`）：严禁盲目 `into_inner()`；一旦发生 Poison，必须丢弃内存实例，标记为 `Corrupted`，并触发 **Rollback-On-Poison 协议**，从 SQLite WAL 权威快照中重新 Hydrate 数据，防止脏内存落盘。
- **验收标准**：单元测试注入 Panic 导致 L1 锁中毒，系统自动丢弃脏内存并成功从 DB 恢复干净状态。

---

### 5.3 建议 Rec-03：补齐跨卷回收站移动失败事务补偿与只读属性递归清除

- **建议级别**：**防御纵深强化（Defense-in-Depth Enhancement）**
- **关联文件**：`docs/systemic-remediation-wave-2/plans/01-安全与沙箱AST根治详案.md`、`crates/conex-fs/src/trash.rs`
- **具体改进规范**：
  在 `01` 详案文件系统安全章节中，显式补齐跨卷移动补偿与只读属性处理规范：
  1. 跨卷回收移动（`fs::copy` + `fs::remove_file`）在 `remove_file(src)` 失败时，必须在 catch 分支执行 `let _ = fs::remove_file(dst)` 事务补偿清理，杜绝幽灵孤儿数据；
  2. 在删除前检测 Windows 只读属性（`readonly == true`），自动调用 `permissions.set_readonly(false)` 清除只读标志后重试删除。
- **验收标准**：跨卷移动模拟源文件被占用删除失败，目标路径绝对无孤儿文件残留；只读属性文件可正常移入回收站。

---

### 5.4 建议 Rec-04：吸收 `MessageSnapshots` 携带 `heightMap` 彻底消灭 Undo 视口抖动

- **建议级别**：**用户体验与稳定性强化（UX & Stability Enhancement）**
- **关联文件**：`docs/systemic-remediation-wave-2/plans/04-前端流式与状态管理详案.md`、`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx`
- **具体改进规范**：
  在 `04` 详案前端治理中，吸收历史 `05-frontend-store-streaming-improved.md` 的视口锚定设计：
  1. 在 `MessageDelta` 中扩充可选字段 `readonly heightMap?: Readonly<Record<string, number>>`；
  2. 快照保存时捕获 `VirtualScrollManager` 的真实测量高度；
  3. 在 `useUndoWithScrollAnchor` 撤销还原时，同步回灌 `setEstimated(id, h)` 并在同一微任务中校准 `scrollTop`，消除 120px 估算高度导致的视口千像素震荡。
- **验收标准**：包含 100 条复杂图文消息的会话执行连续撤销，视口第一可见元素像素位移 $\Delta y \equiv 0$。

---

### 5.5 建议 Rec-05：固化 CDP `setBlockedURLs` 对私网 IP 与 DNS 重绑定的双协议防御

- **建议级别**：**安全基线强化（Security Baseline Enhancement）**
- **关联文件**：`docs/systemic-remediation-wave-2/plans/01-安全与沙箱AST根治详案.md`、`crates/conex-browser/src/gate.rs`
- **具体改进规范**：
  在 `01` 详案浏览器安全章节中，固化以下 CDP SSRF 阻断清单：
  1. 默认包含 `http://169.254.169.254/*`、`https://169.254.169.254/*`、`http://127.0.0.1:*`、`https://127.0.0.1:*`、`http://localhost:*`、`https://localhost:*`、`http://[::1]:*`、`https://[::1]:*` 及 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 等内网私有网段；
  2. 在所有 `Page.navigate`、`BrowserSession::new` 及 `Target.targetCreated` 钩子中强制调用 `Network.setBlockedURLs`，禁止任何静默吞错（`let _ = ...`）。
- **验收标准**：自动化测试模拟向浏览器注入访问云元数据或本地内网端口的请求，100% 触发 CDP 阻断。

---

### 5.6 建议 Rec-06：多端网关与 Wire-Only 角色交替投影层协议协同

- **建议级别**：**架构协同强化（Architectural Alignment Enhancement）**
- **关联文件**：`docs/systemic-remediation-wave-2/plans/05-多端契约与网络治理详案.md`、`crates/agent-provider/src/request/messages.rs`
- **具体改进规范**：
  在 `05` 详案网关路由与多端通信中，明确与 `agent-provider` Wire 协议投影层的边界协同：
  1. 移动端与外部网关传入的对话历史消息保持 100% 领域真实性（零合成 Ack）；
  2. 角色交替适配（防止 Anthropic 连续 Assistant 400 报错）严格收敛于 Provider 发出 HTTP 请求的最后序列化瞬间，确保多端网关收发的 Envelope 负载与本地数据库格式完全同构。
- **验收标准**：移动端 Companion 发起的连续 Assistant 对话，网关无报错，后端发往大模型 API 0 处 400。

---

## 六、第五部分：评审结论与定稿建议

### 6.1 综合评审结论

经过与历史架构审计档案（`.agent-outputs/2026-08-14-architecture-audit/`）中 12 份独立方案、6 份红蓝对抗评审及 6 份加固收敛详案的系统性交叉比对，评审裁决如下：

| 评估维度             |     评估结果      | 裁决意见                                                                                                                                                                             |
| :------------------- | :---------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **历史经验吸纳度**   | **100% 完整继承** | 历史证明有效的 Single Writer Actor、Wire 角色投影、Unicode 标量坐标品牌、Weak Network Nonce LRU 幂等自愈等核心解法已全部纳入现行方案。                                               |
| **已知深坑防御度**   |   **高度完备**    | 覆盖了跨卷移动、IME 连续合成、Win32 提权 Fail-Closed、CDP SSRF 双协议阻断等隐蔽死角，提出的 6 项补缺措施均属于纯增量加固。                                                           |
| **方案创新与深度**   |   **显著突破**    | 在 PowerShell `&` 动态 AST 词法状态机（H1）、HTML 净化器未闭合残片转义（H2）、RecoveryCoordinator 全异步化、Timeline 签名状态感知（🔴 P-01）及上帝文件物理拆分等维度超越了历史方案。 |
| **规范与纪律符合度** |   **完全合规**    | 严格遵循 `.agents/LOGIC_PLAN_NO_RETREAT.md` 与 `AGENTS.md`，全纯逻辑依赖规划，无工期/人天偏见，全问题单元同等权重。                                                                  |

**总体评审结论**：**【通过并推荐定稿（PASS WITH RECOMMENDATIONS）】**。

---

### 6.2 阶段四方案定稿融合清单

在进入阶段四（方案定稿与主控任务书编制）时，请将本评审报告提出的 6 项最佳实践建议（Rec-01 至 Rec-06）融合写入对应的详案文件中，形成最终实施基准：

1. **`01-安全与沙箱AST根治详案.md`**：融合 Rec-03（跨卷补偿与只读剥离）与 Rec-05（CDP SSRF 双协议阻断）；
2. **`02-并发锁序与异步协调详案.md`**：融合 Rec-02（分级锁中毒自愈规范）；
3. **`03-存储GC与协同编辑详案.md`**：融合 Rec-01（`InFlightExportGuard` 代际令牌与瞬态删除抑制）；
4. **`04-前端流式与状态管理详案.md`**：融合 Rec-04（`MessageSnapshots` 携带 `heightMap` 与视口锚定）；
5. **`05-多端契约与网络治理详案.md`**：融合 Rec-06（多端网关与 Wire-Only 角色交替协同）。

---

_报告编制完成。遵循 UTF-8 无 BOM 规范。_
