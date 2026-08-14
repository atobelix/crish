# Conex / Crish — 系统性代码修改与反补丁铁律

# (Code Modification Systemic Discipline & Anti-Patchwork Standard)

> **生效日期**：2026-08-14（红队审计与警告治理强化完整版）
> **适用对象**：所有执行代码修改、缺陷修复、架构重构的主控与子 Agent。
> **核心原则**：**穿透表象、根除断层、严禁打补丁、系统性根治、警告根除零压制、只增不减、零漏洞逃逸。**

---

## 一、 严禁「打补丁式」改进（Zero-Patchwork Mandate）

任何 Agent 在修复缺陷或新增功能时，**严禁**使用表面掩盖、坐标微调、临时容错或绕过机制的「打补丁」手段。必须穿透现象，找到架构层面的断层并用原生、精确、结构干净的方式解决。

### 1. 绝对禁止的「打补丁」反模式清单（红队封堵扩展）

| 反模式名称                                            | 典型违规表现（零容忍）                                                                                                                      | 架构级正确解法                                                                                                            |
| :---------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------ |
| **空占位与伪实现 (Hollow Placeholders)**              | 在核心流式、状态机或异步回调中写入 `() => {}`、`todo!()` 或留空占位，假装完成接口对接。                                                     | 完整接线真实状态机（如 `streamCallbacksEvents.ts`），实现端到端闭环派发与事件消费。                                       |
| **类型逃逸与二次强转 (Double Cast & Type Evasion)**   | 用 `as unknown as T`、`as any`、`@ts-ignore`、在生产代码滥用 `@ts-expect-error` 或 `!` 连环非空断言强行抹平类型错误。                       | 补齐强类型定义（如 Branded Types 标量品牌类型）、重构联合类型并编写严格的类型适配器（Type Adapters）。                    |
| **编译器警告胡乱压制 (Reckless Warning Suppression)** | 通过大面积添加 `#[allow(unused)]`、`#[allow(dead_code)]`、`/* eslint-disable */` 或伪造假调用消除警告。                                     | 从根源清理无用代码或将其重构为合法引用的公共/测试 API，杜绝警告淹没真实日志。                                             |
| **魔术数字补偿 (Magic Offsets)**                      | 在坐标、像素、行高计算中直接 `+2px`、`-4px` 消除偏差（如 FWXGA 缩放偏差）。                                                                 | 建立严格等比（如 1280x720）物理/逻辑 DPI 与 ScaleSpec 矩阵转换。                                                          |
| **定时器与变相异步假锁 (Timing & Delay Faking)**      | 用 `setTimeout(..., 480)`、`sleep(200)`、双层嵌套 `rAF(() => rAF(...))` 或微秒级 `tokio::time::sleep` 碰运气掩盖时序竞争。                  | 使用状态机确定的 Promise、事件驱动锁（Event-driven Lock）、显式条件变量或微任务队列。                                     |
| **IPC 契约命令名漂移 (Ghost IPC Commands)**           | 前端调用的 Tauri 命令名与 Rust 后端 `command_manifest.rs` / `main.rs` 注册名不一致（如 `workbench_resume_subagent` vs `resume_subagent`）。 | 严格对照 Rust 宏 `tauri::generate_handler!` 注册的真源命令名，保持 100% 字面一致。                                        |
| **跨层表面隔离违规 (Surface Isolation Breach)**       | 业务组件直接深路径跨层引入私有 API（如 chat 组件直接 import `../../api/noteApi`，违反 A-SURF-03）。                                         | 严格经由 IPC transport / commandMap / storeAccess / Contract 共享包进行分层解耦。                                         |
| **生产代码植入 Mock 后门 (Sneaky Mock in Prod)**      | 在生产代码中植入 `if (!window.__TAURI_INTERNALS__) return MOCK_DATA;` 等静默 Fallback 逻辑以在脱壳环境假装正常。                            | 生产代码严禁静默回退假数据；必须通过架构分层解耦与真实 IPC 门禁处理。                                                     |
| **假性解耦与行数注水 (Decomposition Evasion)**        | 机械切分 `CompPart1.tsx`/`CompPart2.tsx` 透传 40 个 props；或将千行解析器堆在一个文件（>400 行）；或压缩为 >140 字符的超长单行三元表达式。  | 遵循高内聚领域语义拆分为独立模块（如 `eventParserTask.ts`, `eventParserContinuity.ts`），单文件有效代码行严格 $\le 400$。 |
| **暴力全局覆盖 (Snapshot Overwrite)**                 | 撤销（Undo）或恢复时直接用历史全量快照暴力覆盖内存与数据库。                                                                                | 使用 CRDT 局部因果逆元（如 Yrs UndoManager / InverseOp）按 Origin 精确回退。                                              |
| **静默吞错与兜底掩盖 (Error Swallowing)**             | 捕获异常后只打印 `console.error` 或返回默认空值，不向上抛出结构化错误。                                                                     | 建立明确的错误类型（`thiserror` / `CrishError`），阻断脏数据向下游扩散。                                                  |
| **前台提示词劝阻 (Prompt Compromise)**                | 因后端能力缺失或未适配，在提示词中追加「请不要调用某工具」劝阻大模型。                                                                      | 在 Provider / Tools 契约层与内核沙箱层做物理校验与能力声明，前台保持纯净。                                                |

---

## 二、 异步调度、命令执行与计时器纪律（Command Execution & Timer Rules）

为了保证开发环境的响应性与资源利用率，所有 Agent 在执行长耗时任务或等待时必须遵守以下铁律：

### 1. 响应式事件唤醒优先（Reactive Wakeup Mandate）

- **长耗时命令严禁主动轮询**：当运行 `cargo check`、`cargo test`、`npm run typecheck` 等可能耗时数十秒的命令时，命令转入后台后**绝对禁止通过死循环或频繁调用 `status` 轮询检查**；
- 必须依赖系统原生的 **Reactive Wakeup 机制**——直接结束当前轮次动作（Stop calling tools），系统在后台任务结束时会自动向 Agent 注入带完整日志的通知消息唤醒执行。

### 2. 计时器使用门槛与最短时长（Timer Minimum 100s）

- **计时器最短时长 $\ge 100$ 秒**：严禁设置 5s、10s、30s 等高频短周期计时器；如果确实需要设置定时器，单次时长不得低于 **100 秒**（`DurationSeconds >= 100`）；
- 严禁通过计时器代替命令的正常等待。

---

## 三、 编译器警告治理铁律（Compiler Warning Governance）

警告是潜在缺陷的先兆，也是日志污染的主要源头。警告治理必须满足以下 3 项铁律：

1. **根因修复，零粗暴压制**：严禁通过在文件头增加 `#![allow(unused)]`、`#[allow(dead_code)]` 或 `/* eslint-disable */` 来快速消除警告；必须清理未引用变量、未使用的 import、或者修正函数签名的调用关系。
2. **死代码真清理**：重构或拆分遗留的未用函数（如已弃用的旧端点辅助函数），若无未来契约价值应直接物理删除，避免形成无用垃圾代码。
3. **保持编译输出干净**：目标是使 `cargo check` 与 `npm run lint` 的输出保持干净，确保关键错误不被海量警告信息淹没。

---

## 四、 系统性根因设计四大铁律（Systemic Root-Cause Engineering）

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
- **硬禁令**：**绝对禁止在 `spawn_blocking` 中持有同步锁跨 `block_on` 异步调度！**

### 3. CRDT 块协同与富文本编辑器状态对称（Symmetric Consistency）

- **坐标系严格双向投影**：ProseMirror 的 JS UTF-16 偏移与 Rust Yrs Unicode Code Point 标量必须经过代理项感知（Surrogate-Aware）算子双向单射转换，严禁直接混用数值。
- **输入法合成态生命周期保护**：IME 拼音输入期间必须建立微任务防重锁与 `CompositionPatchBuffer` 增量缓冲区，呈现层建立 `DomPinningRegistry` 拦截当前块卸载，严禁粗暴 `EditorState.create` 重建状态。

### 4. 存储与文件系统的全生命周期闭环（Lifecycle Completeness）

- **Windows 文件原子写入三阶段**：必须遵循「写入临时文件 $\to$ `sync_all` $\to$ 备份重命名 target.bak $\to$ 重命名提交 $\to$ 失败原子回滚」，严禁直接覆盖或先删原文件。
- **OS Watcher 防抖与自发事件自然抑制**：`InFlightExportGuard` 必须使用 1000ms 自然 TTL 与代际令牌覆盖 OS 通知延迟，严禁即时 `unregister`。
- **CAS 垃圾回收活数据保护**：GC 扫描必须联合快照历史与 Undo 栈，落地 `BlobLeaseGuard` 30 分钟上传租约与 7 天软隔离，杜绝误杀附件。

---

## 五、 破坏性副作用自检清单（Blast Radius Audit）

Agent 在完成任何代码改动前，必须自问并核对以下 6 项副作用：

1. **跨语言契约检查**：Rust 数据结构（`serde`）修改是否同步更新了 TypeScript 强类型定义及 `generate-engine-bindings.mjs`？
2. **多端协议兼容检查**：修改是否破坏了 `DeviceEnvelope` 规范（v=1，103 种 `MessageKind`）与 HMAC-SHA256 签名中间件？
3. **IPC 名字与类型一致性检查**：前端调用方法名是否在后端 `tauri::generate_handler!` 中完全匹配？
4. **内存与 GC 压力检查**：是否引入了长生命周期闭包强引用？是否在循环中全量重新构建 Map/Array？
5. **异常回滚完整性检查**：当发生网络超时、用户 Abort、磁盘写满或权限不足时，状态机是否能 100% 收敛至合法终态并清理临时资源？
6. **门禁指标检查**：修改后的单文件行数是否超出门禁（UI $\le 500$ 行、逻辑 $\le 400$ 行、契约 $\le 800$ 行）？
