# Conex / Crish — 系统性代码修改与反补丁铁律

# (Code Modification Systemic Discipline & Anti-Patchwork Standard)

> **生效日期**：2026-08-14（红队审计加固版）
> **适用对象**：所有执行代码修改、缺陷修复、架构重构的主控与子 Agent。
> **核心原则**：**穿透表象、根除断层、严禁打补丁、系统性根治、零漏洞逃逸。**

---

## 一、 严禁「打补丁式」改进（Zero-Patchwork Mandate）

任何 Agent 在修复缺陷或新增功能时，**严禁**使用表面掩盖、坐标微调、临时容错或绕过机制的「打补丁」手段。必须穿透现象，找到架构层面的断层并用原生、精确、结构干净的方式解决。

### 1. 绝对禁止的「打补丁」反模式清单（红队封堵扩展）

| 反模式名称                                                | 典型违规表现（零容忍）                                                                                                                                         | 架构级正确解法                                                                               |
| :-------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| **魔术数字补偿 (Magic Offsets)**                          | 在坐标、像素、行高计算中直接 `+2px`、`-4px` 消除偏差（如 FWXGA 缩放偏差）。                                                                                    | 建立严格等比（如 1280x720）物理/逻辑 DPI 与 ScaleSpec 矩阵转换。                             |
| **定时器与变相异步假锁 (Timing & Delay Faking)**          | 用 `setTimeout(..., 480)`、`sleep(200)`、双层嵌套 `rAF(() => rAF(...))` 或微秒级 `tokio::time::sleep` 碰运气掩盖时序竞争。                                     | 使用状态机确定的 Promise、事件驱动锁（Event-driven Lock）、显式条件变量或微任务队列。        |
| **类型逃逸与非空级联 (Type Evasion & Non-Null Chaining)** | 用 `as any`、`as unknown as T`、`@ts-ignore`、生产代码中滥用 `@ts-expect-error`、定义伪别名 `type SafeAny = any`、或使用 `a!.b!.c!` 连环非空断言强行抹平风险。 | 补齐强类型定义（如 Branded Types 标量品牌类型）、重构联合类型与严格类型守卫（Type Guards）。 |
| **生产代码植入 Mock 后门 (Sneaky Mock in Prod)**          | 在生产代码中植入 `if (!window.__TAURI_INTERNALS__) return MOCK_DATA;` 等静默 Fallback 逻辑以在脱壳环境假装正常。                                               | 生产代码严禁静默回退假数据；必须通过架构分层解耦与真实 IPC 门禁处理。                        |
| **暴力全局覆盖 (Snapshot Overwrite)**                     | 撤销（Undo）或恢复时直接用历史全量快照暴力覆盖内存与数据库。                                                                                                   | 使用 CRDT 局部因果逆元（如 Yrs UndoManager / InverseOp）按 Origin 精确回退。                 |
| **静默吞错与兜底掩盖 (Error Swallowing)**                 | 捕获异常后只打印 `console.error` 或返回默认空值，不向上抛出结构化错误。                                                                                        | 建立明确的错误类型（`thiserror` / `CrishError`），阻断脏数据向下游扩散。                     |
| **前台提示词劝阻 (Prompt Compromise)**                    | 安全防御依赖给 LLM 发送「请不要删除系统文件」的 Prompt。                                                                                                       | 在内核层硬编码 AST 语法词法分析器与 Fail-Closed 系统级系统调用拦截。                         |
| **假性解耦与单行注水 (Pseudo-Decomposition & Cramming)**  | 机械切分 `CompPart1.tsx`/`CompPart2.tsx` 透传 40 个 props；或将复杂逻辑压缩为 >140 字符的超长单行三元表达式以逃避行数门禁。                                    | 遵循高内聚领域语义拆分为独立自定义 Hook、子领域原子组件或状态切片，单行字符 $\le 140$。      |
| **假性接口兼容 (Ghost Compatibility)**                    | 声明接口支持某些参数但内部写 `let _ = arg;` 或直接忽略。                                                                                                       | 严格实现接口契约，废弃无用参数或在类型面显式重构。                                           |

---

## 二、 系统性根因设计四大铁律（Systemic Root-Cause Engineering）

### 1. 领域模型与单向数据流纯净（Single Source of Truth）

- **Wire 协议层与领域模型绝对物理隔离**：为适配特定模型提供商（如 Anthropic 角色严格交替）所做的消息注入/转换，**必须且仅能在 Wire 序列化层（`to_chat_messages`）完成**，绝对禁止向核心领域模型（`state.conversation`、SQLite `sessions`/`events` 表）注入虚假消息（如合成 User Ack）。
- **状态单向流转与不可变性**：前端必须严格区分瞬态流式缓冲（`streamingStore`）与持久化会话（`sessionStore`），状态收口必须在单次事务（Immer/Atomic Action）中原子落地，并采用降级渲染保证 0 帧空白闪烁。

### 2. 严格单向锁序图谱与无阻塞并发（Lock Ordering & Deadlock Freedom）

所有多线程/异步代码必须严格遵守仓库确立的五级单向偏序锁序定理，严禁逆向申请锁（反向死锁）：

$$\mathcal{L}_0 \prec \mathcal{L}_1 \prec \mathcal{L}_2 \prec \mathcal{L}_3 \prec \mathcal{L}_4$$

- **$L_0$（纳秒级内存守卫）**：`WritePathRegistry.inner`、`InFlightExportGuard`、`IdempotencyStore`（持锁 $< 5\mu\text{s}$，不可跨层）；
- **$L_1$（微秒级领域状态锁）**：`StoreNoteBackend.sessions`、`DocSession.tree`、`FlowGraph`（持锁 $< 500\mu\text{s}$）；
- **$L_2$（异步互斥业务锁）**：`RecoveryCoordinator`（全异步 `tokio::sync::Mutex`，严禁同步锁）；
- **$L_3$（毫秒级数据库独占写锁）**：`DbWriteActor` 专用异步写通道（5ms/50条 Group Commit 组提交）；
- **$L_4$（无锁只读连接池）**：`ReaderPool`（自适应 `try_lock` 探测，WAL 并发无阻塞）。
- **红线禁令**：**绝对禁止在 `spawn_blocking` 中持有同步锁跨 `block_on` 异步调度！**

### 3. CRDT 块协同与富文本编辑器状态对称（Symmetric Consistency）

- **坐标系严格双向投影**：ProseMirror 的 JS UTF-16 偏移与 Rust Yrs Unicode Code Point 标量必须经过代理项感知（Surrogate-Aware）算子双向单射转换，严禁直接混用数值。
- **输入法合成态生命周期保护**：IME 拼音输入期间必须建立微任务防重锁与 `CompositionPatchBuffer` 增量缓冲区，呈现层建立 `DomPinningRegistry` 拦截当前块卸载，严禁粗暴 `EditorState.create` 重建状态。

### 4. 存储与文件系统的全生命周期闭环（Lifecycle Completeness）

- **Windows 文件原子写入三阶段**：必须遵循「写入临时文件 $\to$ `sync_all` $\to$ 备份重命名 target.bak $\to$ 重命名提交 $\to$ 失败原子回滚」，严禁直接覆盖或先删原文件。
- **OS Watcher 防抖与自发事件自然抑制**：`InFlightExportGuard` 必须使用 1000ms 自然 TTL 与代际令牌覆盖 OS 通知延迟，严禁即时 `unregister`。
- **CAS 垃圾回收活数据保护**：GC 扫描必须联合快照历史与 Undo 栈，落地 `BlobLeaseGuard` 30 分钟上传租约与 7 天软隔离，杜绝误杀附件。

---

## 三、 破坏性副作用自检清单（Blast Radius Audit）

Agent 在完成任何代码改动前，必须自问并核对以下 5 项副作用：

1. **跨语言契约检查**：Rust 数据结构（`serde`）修改是否同步更新了 TypeScript 强类型定义及 `generate-engine-bindings.mjs`？
2. **多端协议兼容检查**：修改是否破坏了 `DeviceEnvelope` 规范（v=1，103 种 `MessageKind`）与 HMAC-SHA256 签名中间件？
3. **内存与 GC 压力检查**：是否引入了长生命周期闭包强引用？是否在循环中全量重新构建 Map/Array？
4. **异常回滚完整性检查**：当发生网络超时、用户 Abort、磁盘写满或权限不足时，状态机是否能 100% 收敛至合法终态并清理临时资源？
5. **门禁指标检查**：修改后的单文件行数是否超出门禁（UI $\le 500$ 行、逻辑 $\le 400$ 行、契约 $\le 800$ 行）？
