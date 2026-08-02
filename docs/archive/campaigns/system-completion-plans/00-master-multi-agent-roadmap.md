# 系统补全 · 全局多 Agent 多轮编排总纲

**文档**: `docs/system-completion-plans/00-master-multi-agent-roadmap.md`  
**日期**: 2026-07  
**状态**: 总纲（可执行编排入口）  
**上游审计**: [`audits/00-master-findings.md`](./audits/00-master-findings.md)  
**下游方案**: [`plans/01`](./plans/) … [`plans/05`](./plans/)（分维度系统性方案，执行轮前/中补全）

---

## 1. 产品目标与测试哲学

### 1.1 产品目标（本目录范围）

Crish / Conex 是 **端侧 AI Agent 桌面工作台**（Tauri + WebView2 + agent-daemon）。本总纲只服务「系统补全与长程可信」三件事：

| 目标               | 含义                                                                                           | 成功外观                             |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| **诚实能力面**     | UI/文档宣称的能力与引擎真实能力一致；假安装、假 fork、空壳 Provider 要么接真要么下架/标注      | 用户不会「点了看似成功、实则未生效」 |
| **长程 Goal 可信** | 桌面 Goal 路径进入引擎 `driveGoalRun`；完成条件不可被纯文案 DONE 骗过；可采集轨迹与磁盘 oracle | 长任务可观测、可复现、可失败         |
| **软件内测闭环**   | 在真实 Tauri 软件内验证 MCP stdio、审批闸、工作区写、STREAM_PAUSE 背压等                       | 浏览器 dev 端口 **不算** 验收通过    |

不在本总纲主路径内的目标（见 §5 边界）：会话 Pending Draft 生命周期、纯性能 SLA / FPS / Rust 下沉、对外 testkit 插件产品化。

### 1.2 测试哲学（硬约束）

1. **软件内测优先**
   - 必须：WebView2 / Tauri 壳 + sidecar daemon +（假或真）provider。
   - 禁止把「仅 Vite 浏览器端口冒烟」当作系统能力验收。
   - 浏览器测可作组件/单元辅助，**不可**替代 MCP stdio、审批闸、工作区写、流控背压等端到端断言。

2. **AI 长程任务 + 数据采集**
   - 运行：假 provider（稳定 CI）与真 provider（可选夜间/手工）双轨。
   - 采集：轨迹事件（goal-round、toolCalls、审批 defer/deny、stop）、UI 诊断（`data-goal-*`、`__crishStreamDiag`）、**磁盘 oracle**（工作区文件是否按任务落地）。
   - computer-use / 桌面视觉探索（如 cua、OSWorld）**仅探索层**，不进主 CI 门禁。

3. **采集 → 迭代**
   - 每一轮 Phase 结束必须留下：失败用例清单、轨迹样例、缺口是否升级/降级 P0–P2。
   - 下一轮以「上轮 oracle 失败 + 审计证据路径」为输入，禁止只改文案装绿。

4. **反作弊（与既有 multi-agent 纪律对齐）**
   - 禁止：`as any` 遮罩、`.skip` 减测、空 catch、假 DONE、硬编码 SLA、Dummy 接口冒充接真。
   - 验收：测试数只增不减；关键路径有真实 IPC/daemon 断言。

### 1.3 本总纲「做 / 不做」

| 做                                      | 不做                                              |
| --------------------------------------- | ------------------------------------------------- |
| 补全 Mock/Stub/断点/Goal 双轨           | 全盘 UI redesign / 换设计语言                     |
| Provider / MCP / 审批 / 插件 **诚实化** | 未调研前大面积引入第二套 E2E 框架污染 CI          |
| 桌面接 `driveGoalRun` 或禁止假完成      | 用 computer-use 替代磁盘 oracle                   |
| 多轮多 Agent 编排与 plans 分维方案      | 把 perf R 系列 / Pending Draft 整包并入本轨强耦合 |
| `reference/` **方案级** 对照            | 在方案轮就 clone 巨型依赖并提交                   |

---

## 2. 八维 P0 / P1 / P2 汇总

> 完整硬证据见 [`audits/00-master-findings.md`](./audits/00-master-findings.md)。下表为编排用浓缩；改优先级须先更新审计汇总。

### 2.1 八维现状一览

| #   | 维度                        | 真实状态（浓缩）                                                                      | 最高优缺口                                          |
| --- | --------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | **Multi-Provider**          | OpenAI-compatible 生产级；Anthropic/Gemini **空壳**；Desktop `getProviders` 正式 `[]` | 原生实现 **或** UI/文档诚实「仅 OpenAI-compatible」 |
| 2   | **MCP**                     | Run 内工具链可用；启停 API 名不匹配；list 常空；UI `canStartStop=false`               | `startServer` 对齐 + 配置注入 daemon                |
| 3   | **Tools & Permissions**     | TrustZone + 审批主链真；PermissionMiddleware 未挂载；超时 deny throw 整 run           | 审批超时不 abort；denial 结构化                     |
| 4   | **Agent Loop**              | 单 run 真；工具 error 回灌真；反思薄；fatalOnError 未生效；synthesis 用 user 角色     | 反思预算；fatalOnError；synthesis 角色修正          |
| 5   | **Goal 长程**               | 双轨：UI 文本轮 vs 引擎 12 轮；桌面不传 `mode/goal`；DONE 正则可假完成                | 桌面接引擎 **或** 禁纯文本 DONE；磁盘 oracle        |
| 6   | **Session Fork/Checkpoint** | Rewind 后端可用；fork/restore product unsupported；Desktop `branchSession` 冒充 fork  | 本地 fork 诚实化/禁用；Rewind 入口                  |
| 7   | **Prompt/Rules/Plugins**    | 规则/skills/MCP 真；插件假安装；无 role 模板总线                                      | 插件诚实；安装/下架假货架                           |
| 8   | **UI Stub/Demo**            | 主对话真；扩展假安装；deny 无失败 toast；批量审批未接线                               | deny 失败反馈；安装诚实                             |

### 2.2 跨维优先级（编排顺序依据）

#### P0 — 诚实 + 安全 + 长程可信（本总纲前两 Phase 必收敛）

1. **Provider**：原生 Anthropic/Gemini **或** UI/文档/profile 诚实「仅 OpenAI-compatible」
2. **MCP**：API 名对齐（`start`/`teardown` vs `startServer`/`stopServer`）+ 配置注入 daemon
3. **Goal**：桌面接引擎 goal（`mode` / `visibleGoal` / `maxRounds` → `driveGoalRun`）**或** 禁止纯文本 DONE 完成；磁盘 oracle
4. **审批**：超时不 abort 整 run；deny 失败 UI 回滚 / toast
5. **Fork**：Desktop 本地 fork 诚实标注或禁用（禁止冒充 product fork）

#### P1 — 质量与可测性

6. 工具 denial **结构化**回灌 + reflection 预算可配置
7. 插件安装诚实 / 删除假货架
8. `fatalOnError` 生效；synthesis **不用** user 角色污染 transcript
9. Rewind UI 入口；checkpoint restore 实现或下架
10. **In-app AI 测试采集层**（事件 + 磁盘 oracle）

#### P2 — 增强与纵深

11. 流式 tool 预并发；Permission middleware 真挂载
12. Prompt 模板 / 规则双写统一
13. 插件沙箱；MCP Sampling / Elicitation

### 2.3 维度 → 下游 plans 映射

| plans 文档（待写/执行）                    | 覆盖维度                                     | 主优先级 |
| ------------------------------------------ | -------------------------------------------- | -------- |
| `plans/01-provider-and-mcp.md`             | Multi-Provider + MCP                         | P0       |
| `plans/02-tools-permissions-loop.md`       | Tools & Permissions + Agent Loop             | P0/P1    |
| `plans/03-goal-long-run-and-oracle.md`     | Goal 长程 + 采集/oracle                      | P0/P1    |
| `plans/04-session-fork-checkpoint-ui.md`   | Fork/Checkpoint + UI Stub 诚实               | P0/P1    |
| `plans/05-prompt-plugins-and-reference.md` | Prompt/Rules/Plugins + `reference/` 对照落地 | P1/P2    |

> Phase 内多轮实现时，以对应 plan 为「契约 + 文件边界 + DoD」；本总纲只定 **全局顺序与并行度**，不重复贴完整实现清单。

---

## 3. 全局多轮编排（Phase 顺序）

### 3.1 编排原则

| 原则                       | 说明                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **Phase 串行、轮次内并行** | Phase 之间有依赖（诚实面 → 长程接线 → 采集闭环）；同一 Phase 内拆 ≥4 个 agent 并行 |
| **每轮 agent 数 ≥ 4**      | 建议 4–6：实现 ×2–3 + 契约/文档 ×1 + 反作弊巡视 ×1                                 |
| **一轮一可合并切片**       | 每轮结束：可测、可回滚、有轨迹/测试增量；禁止「半截 stub 合并」                    |
| **先方案后 clone**         | `reference/` 在 **执行轮** 拉取；方案轮只写对照矩阵                                |
| **反作弊固定席**           | 每轮至少 1 个 Inspector：diff 扫 `as any`/skip/假 DONE/空 catch                    |

### 3.2 推荐 Agent 角色模板（每轮复用）

| 角色                          | 职责                                      | 典型产出             |
| ----------------------------- | ----------------------------------------- | -------------------- |
| **A · Engine**                | daemon / runtime / provider / goal 引擎   | 接线、协议、单测     |
| **B · Desktop Bridge**        | 桌面 API、store、slash、设置契约          | 参数下发、诚实 UI 态 |
| **C · Surface / UX**          | 审批 toast、扩展页、Goal ribbon、失败回滚 | 可见失败、禁用假成功 |
| **D · QA / Oracle**           | 软件内测路径、磁盘 oracle、采集事件       | 集成测、样例轨迹     |
| **E · Inspector（建议常驻）** | 反作弊、契约对照、P0 清单勾选             | 巡检报告、否决假绿   |

文件边界在各 `plans/0x` 中写死；跨 Phase 冲突时 **P0 诚实与 Goal 接线优先于 P2 增强**。

### 3.3 Phase 总览

```text
Phase 0  方案固化 + reference 对照表（不改生产默认行为）
   │
Phase 1  诚实面收敛（Provider / MCP / Fork / 假安装 / deny 反馈）     ← P0 主体
   │
Phase 2  Goal 引擎单轨 + 完成条件硬化 + 最小磁盘 oracle               ← P0 长程
   │
Phase 3  工具回灌 / 反思 / fatalOnError / 审批超时软化               ← P0 收尾 + P1
   │
Phase 4  采集层产品化 + Rewind/Checkpoint 诚实 + 插件诚实            ← P1
   │
Phase 5  P2 增强（预并发、Permission 挂载、沙箱、Sampling）可选
```

---

### Phase 0 — 方案固化与参考对照（约 2–3 天）

**目标**：把审计变成可执行契约；**不**合并改变默认用户行为的半截实现。

| 轮次     | 建议 agent ≥4 | 任务                                                                                 | 指向                |
| -------- | ------------- | ------------------------------------------------------------------------------------ | ------------------- |
| **R0.1** | 4–5           | 补全 `plans/01`–`05` 骨架：证据路径、DoD、禁止范围、文件边界                         | plans/01–05         |
| **R0.2** | 4             | 写 `reference/` 对照矩阵（litellm / new-api / Cline·OpenCode）；**仅文档**，不 clone | 本文件 §4；plans/05 |
| **R0.3** | 4             | 与 pending-draft / perf / testkit 边界确认表；CI 门禁清单（哪些测进主门）            | 本文件 §5           |

**退出标准**：

- [ ] `plans/01`–`05` 存在且含 P0 DoD
- [ ] `reference/` 策略获准（见 §4）
- [ ] 边界表无争议项阻塞 Phase 1

---

### Phase 1 — 诚实能力面（P0 非 Goal 主体）

**目标**：用户可见路径不再「假成功 / 空壳冒充」。

| 轮次     | 建议 agent ≥4 | 并行切片                                                                         | 指向                |
| -------- | ------------- | -------------------------------------------------------------------------------- | ------------------- |
| **R1.1** | ≥4            | Provider 诚实：空壳 Anthropic/Gemini **实现或下架**；profile base 路径与文案一致 | plans/01            |
| **R1.2** | ≥4            | MCP：API 名对齐；配置注入；UI 启停仅在真能力时开放                               | plans/01            |
| **R1.3** | ≥4            | Fork 诚实：禁用或标注 Desktop `branchSession`；Rewind 入口或明确「仅引擎」       | plans/04            |
| **R1.4** | ≥4            | UI 假安装/deny：扩展安装诚实；主对话 deny 失败 toast；批量审批接线或隐藏         | plans/04 + plans/05 |

**每轮固定**：1× Inspector 扫假成功路径；Desktop 相关 `check:desktop` / daemon 相关 vitest。

**退出标准**：

- [ ] 无「点安装成功但未安装」的正式路径
- [ ] MCP 启停与 daemon API 一致或 UI 永久诚实禁用并有说明
- [ ] Provider 无静默空 shell
- [ ] 本地 fork 不冒充 product fork

---

### Phase 2 — Goal 长程单轨与 Oracle（P0 核心）

**目标**：桌面 Goal 进入引擎长程驱动；完成条件可信；最小可采集。

| 轮次     | 建议 agent ≥4 | 并行切片                                                                               | 指向          |
| -------- | ------------- | -------------------------------------------------------------------------------------- | ------------- |
| **R2.1** | ≥4            | 桌面 `/goal`（及正式入口）下发 `mode` / `visibleGoal` / `maxRounds`；接 `driveGoalRun` | plans/03      |
| **R2.2** | ≥4            | 完成条件：去掉「仅 DONE 正则 / markAllGoalTasksDone 假对齐」；stalled / stop 语义对齐  | plans/03      |
| **R2.3** | ≥4            | 最小磁盘 oracle + 轨迹事件（goal-round、toolCalls）；假 provider 可重复跑              | plans/03      |
| **R2.4** | ≥4            | **软件内** 冒烟：Tauri 内跑 1 条多轮 goal 样例；采集 ribbon / diag 字段核对            | plans/03 + QA |

**退出标准**：

- [ ] 桌面 Goal 路径进入引擎（有事件/日志可证），非纯 UI 文本轮
- [ ] 纯助手输出 `DONE` **不能**单独完成 goal（除非显式策略且可测）
- [ ] 至少 1 条假 provider 长程用例：期望文件落盘 + 轨迹落盘

---

### Phase 3 — 工具、审批、循环硬化（P0 收尾 + P1）

**目标**：审批与工具失败不拖垮整 run；回灌对模型有用。

| 轮次     | 建议 agent ≥4 | 并行切片                                                              | 指向                |
| -------- | ------------- | --------------------------------------------------------------------- | ------------------- |
| **R3.1** | ≥4            | 审批超时：soft deny / 可恢复，**禁止**默认 throw 整 run               | plans/02            |
| **R3.2** | ≥4            | denial 结构化 tool-result；弱文案 `user-denied` 升级                  | plans/02            |
| **R3.3** | ≥4            | `fatalOnError` 生效；synthesis 改非 user 角色；reflection 预算可配置  | plans/02            |
| **R3.4** | ≥4            | 回归：审批 defer 后续写、Stop 清 goal 与引擎一致；软件内 1 条审批流测 | plans/02 + plans/03 |

**退出标准**：

- [ ] 超时 deny 不默认 abort 整 run
- [ ] denial 内容可被后续轮次消费（结构化字段或约定 schema）
- [ ] fatalOnError / synthesis 有单测或集成测覆盖

---

### Phase 4 — 采集层、会话恢复诚实、插件（P1）

**目标**：长程测试可重复采集；会话能力诚实；插件无假货架。

| 轮次     | 建议 agent ≥4 | 并行切片                                                                        | 指向           |
| -------- | ------------- | ------------------------------------------------------------------------------- | -------------- |
| **R4.1** | ≥4            | In-app 采集层：事件总线 + 磁盘导出约定；与 testkit **接口预留但不实现插件市场** | plans/03；§5.3 |
| **R4.2** | ≥4            | Rewind UI 入口接线；checkpoint restore 实现或产品下架                           | plans/04       |
| **R4.3** | ≥4            | 插件 registry 收敛 / 假安装删除；discover 与安装态一致                          | plans/05       |
| **R4.4** | ≥4            | 全量 P0 回归 + 软件内 goal+审批+MCP 最小矩阵                                    | QA + Inspector |

**退出标准**：

- [ ] 一次长程 run 可导出轨迹与 oracle 结果
- [ ] fork/checkpoint/插件无「unsupported 却显示成功」
- [ ] P0 清单全部勾选或有书面豁免

---

### Phase 5 — P2 增强（可选，不阻塞发布诚实面）

| 轮次     | 建议 agent ≥4 | 内容                                                                                     | 指向         |
| -------- | ------------- | ---------------------------------------------------------------------------------------- | ------------ |
| **R5.x** | ≥4            | 流式 tool 预并发；PermissionMiddleware 挂载；prompt 模板；插件沙箱；Sampling/Elicitation | plans/02、05 |

**原则**：仅在 Phase 1–4 退出标准满足后启动；可拆多个小轮，仍保持每轮 ≥4 agent。

---

### 3.4 每轮工作流（强制）

```text
1. 拆任务卡（文件边界 + DoD + 禁止范围）← 来自对应 plans/0x
2. 并行实现（A/B/C/D）+ Inspector 同步扫
3. 本地门禁：相关 vitest / check:* ；涉及 UI 能力则软件内冒烟
4. 采集：失败列表 + 轨迹样例路径写入轮次笔记（可放 plans 附录或 PR 描述）
5. 合并条件：Inspector 无 P0 作弊项；DoD 全勾
```

---

## 4. `reference/` 拉取策略（仅方案；clone 在执行轮）

### 4.1 原则

| 项     | 约定                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 路径   | 仓库根 `reference/`（与 monorepo 包隔离）                                                             |
| 方案轮 | **只写对照表与拟 clone 清单**，不执行 clone                                                           |
| 执行轮 | 需要对照源码时再 shallow clone；**默认不提交** 巨型树（`.gitignore` 或 submodule 二选一，执行前决策） |
| 用途   | 协议适配、工具循环、审批反馈、checkpoint 模式的 **设计对照**；禁止整仓 copy-paste 进生产路径          |
| 许可   | 对照前核对 LICENSE；衍生代码遵循原许可与本仓 LICENSE                                                  |

### 4.2 候选与用途

| 目标                         | 候选                                                  | 本项目用法                                                                | 拉取时机                     |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Provider 统一 / 多厂商协议   | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 对照 Anthropic/Gemini 消息与工具格式；**非**默认把 Python 网关嵌进 daemon | Phase 1 执行轮（R1.1）按需   |
| API 网关 / 密钥路由          | NewAPI / OneAPI 类                                    | **可选**：本地多密钥路由、模型别名；评估是否仅文档推荐、不进主依赖        | 仅当产品明确要「网关模式」时 |
| Agent 循环 / 工具 / 审批反馈 | **Cline**、**OpenCode**（及同类活跃仓）               | 对照：reflection、tool-result 结构、checkpoint、拒绝后续写                | Phase 2–3 执行轮按需         |
| Computer-use 探索            | trycua/cua、OSWorld                                   | **非主 CI**；探索长程桌面操作可行性                                       | 不进 Phase 1–4 门禁          |
| Tauri E2E                    | tauri-plugin-playwright / WebView2 CDP                | 软件内 UI 自动化参考                                                      | 与 testkit 预研交叉，见 §5.3 |

### 4.3 推荐 clone 命令（执行轮模板，勿在方案轮执行）

```bash
# 示例：shallow、指定目录；执行前确认 .gitignore 含 reference/*
mkdir -p reference
git clone --depth 1 https://github.com/BerriAI/litellm.git reference/litellm
# 可选：
# git clone --depth 1 <new-api-repo> reference/new-api
# git clone --depth 1 <cline-or-opencode-repo> reference/cline
```

### 4.4 对照产出物（强制）

每个被 clone 的参考仓，在 `plans/05` 或 PR 中保留一页：

- 可借鉴点（≤10 条）
- **不可**直接移植点（运行时/语言/安全模型差异）
- 映射到本仓文件路径的「拟采纳」清单

---

## 5. 与已有 Roadmap 的边界

本总纲 **不吞并** 下列轨道；交叉时只约定接口与禁止抢活。

### 5.1 Pending Draft 会话生命周期

| 项             | 说明                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 权威文档       | [`docs/architecture/session-pending-draft-adr.md`](../architecture/session-pending-draft-adr.md) + `multi_agent_session_lifecycle_*.md` |
| 本轨 **不** 做 | `PENDING_DRAFT_SESSION_ID`、空壳复用删除、侧栏 `shouldList`、commit 时 mint 等生命周期改造                                              |
| 交叉点         | Goal/审批测例 **依赖**「真实 session 已存在」：测前先 commit draft 或使用非草稿 sid；禁止在 goal 接线里重写 draft 状态机                |
| 冲突裁决       | 生命周期 ADR 优先；本轨只消费「已 mint 的 session」                                                                                     |

### 5.2 性能 / FPS / Rust 下沉（perf）

| 项             | 说明                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| 权威文档       | `docs/refactor-guides/*`、`docs/system-enhancement-plans/*`、`PERFORMANCE-*.md`、workbench `perf-migration-plan` 等 |
| 本轨 **不** 做 | Pretext/FPS SLA、fuzzy/tokenizer bench、大面积 store 拆分、Rust 索引下沉                                            |
| 交叉点         | 长程采集避免在热路径打巨型同步 log；若加诊断，默认 debug / 采样，不破坏 perf 门禁                                   |
| 冲突裁决       | 性能 SLA 回归由 perf 轨修复；本轨引入的测例不得依赖「关掉虚拟列表」等降质作弊                                       |

### 5.3 集成测试套件 / testkit 插件

| 项             | 说明                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| 权威文档       | [`docs/testing/integrated-test-suite-plugin-roadmap.md`](../testing/integrated-test-suite-plugin-roadmap.md)         |
| 本轨 **做**    | **In-app** 长程采集、假 provider 契约、软件内冒烟矩阵（产品可信所需的最小集）                                        |
| 本轨 **不** 做 | 对外 `crish-testkit` 插件市场、第三方用例包 API 定稿、reusable workflow 产品化                                       |
| 交叉点         | Phase 4 采集层导出格式 **尽量** 与未来 testkit reporter 兼容（事件名、artifact 目录约定），但不阻塞 testkit 预研结论 |
| 冲突裁决       | testkit 仍为「R 系列性能收尾后的质量下一阶段」；本轨 P0 不因 testkit 未就绪而停                                      |

### 5.4 边界速查表

| 主题                         | 主责轨道           | 本总纲               |
| ---------------------------- | ------------------ | -------------------- |
| 空壳会话 / Pending Draft     | session-lifecycle  | 只消费真 session     |
| FPS / Pretext / Rust SLA     | perf / enhancement | 不改 SLA 目标        |
| 对外测试插件                 | testkit roadmap    | 预留导出，不实现市场 |
| Provider/MCP/Goal 诚实与接线 | **本总纲**         | 主责                 |
| 审批/工具回灌/反思           | **本总纲**         | 主责                 |
| 假安装 / deny toast          | **本总纲**         | 主责                 |

---

## 6. 首个可执行 2 周计划

> 假设：Phase 0 方案文档可与 Week 1 前半并行；人力按 **每轮 ≥4 agent**（可同一人分时段扮演，但产出物按角色分离）。

### 6.1 日历总览

| 工作日  | Phase / 轮                    | 焦点                                                   | 退出检查                           |
| ------- | ----------------------------- | ------------------------------------------------------ | ---------------------------------- |
| D1–D2   | Phase 0 · R0.1–R0.2           | `plans/01`–`05` 骨架 + `reference/` 对照表（不 clone） | 五份 plan 有 P0 DoD；对照表合并    |
| D3      | Phase 0 · R0.3 + Phase 1 开工 | 边界表冻结；启动 Provider/MCP 诚实切片                 | 边界无阻塞                         |
| D4–D5   | Phase 1 · R1.1–R1.2           | Provider 诚实；MCP API 对齐与配置注入                  | 无空壳静默；MCP 启停一致或诚实禁用 |
| D6–D7   | Phase 1 · R1.3–R1.4           | Fork 诚实；假安装/deny toast                           | 正式路径无假成功                   |
| D8–D10  | Phase 2 · R2.1–R2.2           | 桌面接 `driveGoalRun`；完成条件硬化                    | 桌面进入引擎；纯 DONE 不可假完成   |
| D11–D12 | Phase 2 · R2.3–R2.4           | 磁盘 oracle + 假 provider 长程；**Tauri 软件内** 冒烟  | 轨迹+文件双证据                    |
| D13–D14 | 缓冲 / 回归                   | P0 清单复扫；修 flaky；准备 Phase 3 任务卡             | 书面「2 周 P0 完成度」报告         |

### 6.2 Week 1 任务卡（可直接派 agent）

| ID   | 角色      | 任务                                                              | 完成定义                                     |
| ---- | --------- | ----------------------------------------------------------------- | -------------------------------------------- |
| W1-A | Engine    | 审计并列出 Provider 空壳与 daemon 创建路径；PR：实现或下架 + 测试 | 无 `stream → []` 静默生产路径                |
| W1-B | Engine    | MCP manager 方法名与 factory 对齐；配置注入通道设计落地           | UI 启停不再永 `Unsupported` 或永久禁用有文案 |
| W1-C | Desktop   | profile/设置文案与真实路由一致；Fork 入口诚实                     | 用户可见说明与行为一致                       |
| W1-D | Surface   | 扩展安装/deny 失败反馈                                            | 无假 toast 成功                              |
| W1-E | Inspector | 每日 diff 扫 + 更新 P0 勾选                                       | 阻断假绿合并                                 |

### 6.3 Week 2 任务卡

| ID   | 角色      | 任务                                                    | 完成定义                     |
| ---- | --------- | ------------------------------------------------------- | ---------------------------- |
| W2-A | Engine    | `driveGoalRun` 与桌面参数契约                           | 日志/事件证明 goal 模式      |
| W2-B | Desktop   | `/goal` 与正式 Goal 入口传 `mode/visibleGoal/maxRounds` | 与引擎字段一致               |
| W2-C | Engine+QA | 完成条件去假；oracle 目录约定                           | 单测 + 假 provider 用例      |
| W2-D | QA        | Tauri 内 1 条多轮 goal 冒烟脚本/手册步骤                | 可复述步骤与期望产物         |
| W2-E | Inspector | Phase 1–2 退出标准审计                                  | 未达标项进 D13–14 或明示延期 |

### 6.4 2 周末必须交付物

1. **代码**：Phase 1 诚实面 + Phase 2 Goal 接线的可合并 PR 集（或明确剩余缺口与风险）。
2. **测试**：≥1 假 provider 长程用例 + 软件内冒烟记录（路径、命令、截图或轨迹文件）。
3. **文档**：`plans/01`–`05` 达到可执行粒度；P0 清单勾选状态。
4. **不做超范围**：不 clone 进主仓依赖树；不改 Pending Draft 状态机；不启动 testkit 插件市场；不碰 perf SLA 大改。

### 6.5 风险与缓冲

| 风险                        | 缓解                                             |
| --------------------------- | ------------------------------------------------ |
| Anthropic/Gemini 原生成本高 | 2 周内允许「诚实下架」代替完整原生，记入 P1 回补 |
| MCP 配置注入牵涉安全        | 先本机 config 注入 + 单测，密钥不进日志          |
| Goal 双轨历史兼容           | 特性开关或版本字段；默认新路径进引擎             |
| 软件内测环境不稳            | D11 前固定一份「启动 daemon + 假 provider」手册  |
| Agent 互相踩文件            | 严格按 plans 文件边界；冲突文件串行              |

---

## 7. 文档与目录约定

```text
docs/system-completion-plans/
  README.md                          # 阅读顺序与硬约束
  00-master-multi-agent-roadmap.md   # 本总纲
  audits/
    00-master-findings.md            # 八维证据与 P0/P1/P2
  plans/
    01-provider-and-mcp.md
    02-tools-permissions-loop.md
    03-goal-long-run-and-oracle.md
    04-session-fork-checkpoint-ui.md
    05-prompt-plugins-and-reference.md
```

**阅读顺序**：审计 → 本总纲 → 对应 plan → 开执行轮。  
**更新规则**：改 P0 定义先改 `audits/00-master-findings.md`，再同步本总纲 §2；改 Phase 顺序只改本文件并在 PR 说明原因。

---

## 8. 一句话执行口令

> **先诚实、再长程、可采集、软件内验收；每轮 ≥4 agent；reference 只对照后 clone；不抢 draft / perf / testkit 的活。**

---

_文档版本：2026-07 · 与 `audits/00-master-findings.md` 同步起草 · 仅总纲不替代分维 plan 的实现清单。_
