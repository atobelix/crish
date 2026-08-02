# 全量审计汇总：Mock / Stub / 断点 / 长程 Goal

**日期**: 2026-07  
**方式**: 8 路并行 explore agent + 既有 multi-agent 审计  
**原则**: 证据级路径；测试须在 **真实 Tauri 软件内**（非仅 Vite 浏览器端口）

---

## 0. 与测试方向的关系（先定调）

| 你要的                     | 结论                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| 软件内测（系统能力）       | 必须 WebView2/Tauri + daemon；浏览器端口测不了 MCP stdio、审批闸、工作区写、STREAM_PAUSE 真背压 |
| AI 跑长程任务并采集数据    | 需 **假/真 provider + 轨迹事件 + 磁盘 oracle**；computer-use 仅作探索层                         |
| 工具防护 / 格式修复 / 自愈 | 见 Tools & Loop 维度；当前「工具 error 会回灌」但 **无结构化 reflection 状态机**                |
| Goal 乐观完成              | **P0**：桌面 DONE 文案即可完成，且未接引擎 `driveGoalRun`                                       |

---

## 1. 八维 + 引擎补充：总表

| 维度                    | 真实状态                                               | 最高优缺口                                               |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Multi-Provider          | OpenAI-compatible 生产级；Anthropic/Gemini **空壳**    | P0 原生实现或诚实下架                                    |
| MCP                     | Run 内工具链设计可用；**启停 API 名不匹配**；list 常空 | P0 startServer 对齐 + 配置注入                           |
| Tools & Permissions     | TrustZone+审批主链可用                                 | P0 审批超时 throw；P1 denial 结构化；无 tool-output 消毒 |
| Agent Loop              | 单 run 真实现                                          | 反思薄；fatalOnError 未生效                              |
| Goal 长程               | **双轨**：UI 5 轮文本 vs 引擎 12 轮                    | P0 桌面未下发 mode:goal；DONE 假完成                     |
| Session Fork/Checkpoint | Rewind 后端可用；fork/restore product **unsupported**  | P0 本地 branch 冒充 fork                                 |
| Prompt/Rules/Plugins    | 规则/skills/MCP 真；插件 **假安装**                    | P0 插件诚实化；无 role 模板                              |
| UI Stub/Demo            | 主对话真；扩展假装、拒绝假成功                         | P0 deny 失败反馈；安装诚实                               |

---

## 2. 分维度硬证据（浓缩）

### 2.1 Multi-Provider

- `provider-anthropic.ts` / `provider-gemini.ts`：`stream → yield* []`，`complete → {}`
- Daemon 只 `createOpenAICompatibleProviderFromPlan`
- Desktop `getProviders` 正式 `[]`；profile「Anthropic」base 却走 OpenAI 兼容路径 → 易误配

### 2.2 MCP

- `McpLifecycleManager`：有 `start`/`teardown`/`reconnectServer`，**无** `startServer`/`stopServer`
- Factory `(manager as any).startServer` → 永 `DaemonUnsupportedCapabilityError`
- UI 故意 `canStartStop=false`；Sampling/Elicitation 不存在

### 2.3 Tools & Permissions

- 主链：TrustZone + SessionLoop + ApprovalQueue **真**
- `PermissionMiddleware` / `PermissionStore` **未挂载**
- 超时 deny **throw 整 run** vs softDeny 文案冲突
- Denial 回 LLM 常为 `user-denied` 弱文案
- `exclusive` 与 `sequential` 调度不区分；无 tool-output injection 防护

### 2.4 Agent Loop

- 工具 error → tool-result 回灌 ✅
- `maxSteeringMessages` 默认 1 → 易过早 intervention
- Synthesis 用 **user** 角色注入污染 transcript
- `GoalAuditStrategy` stub 且未注册；`isNoProgressAssistant` 死 import
- Orchestrator：provider retry 仍扣 `completedRounds`（与注释矛盾）

### 2.5 Goal 长程（测试核心）

- 桌面 `/goal`：**不传** `mode/visibleGoal/maxRounds` → 不进 `driveGoalRun`
- 完成 = `DONE` 正则或 checklist 全勾；`markAllGoalTasksDone` 可假对齐
- 无 stalled 签名；Stop 清 goal；审批 defer 后可能仍续写
- 可采集：ribbon `data-goal-*`、`user-msg-goal-*`、`__crishStreamDiag`、toolCalls；引擎 `goal-round-*` **桌面路径无**

### 2.6 Session Fork / Checkpoint

- Conversation **rewind** daemon 可用；Workbench/desktop **入口缺失或本地假**
- `fork` → 明确 unsupported 文案
- Desktop `branchSession` 本地深拷贝 **冒充 fork**
- Product checkpoint **restore** unsupported

### 2.7 Prompt / Plugins

- AGENTS.md + scoped-context + skill slash **真**
- 插件三套 registry **无总线**；`import(entry)` 无沙箱且 discover 未接
- `responseStyle` 未进 prompt

### 2.8 UI

- 主对话 daemon 真；Demo mock 清晰
- 扩展目录 mcp/skill **假安装**；主对话 deny **无失败 toast**；批量审批 **未接线**

---

## 3. 建议总优先级（跨维）

### P0（诚实 + 安全 + 长程可信）

1. Provider：原生 Anthropic/Gemini **或** UI/文档诚实「仅 OpenAI-compatible」
2. MCP：API 名对齐 + 配置注入 daemon
3. Goal：桌面接引擎 goal **或** 禁止纯文本 DONE；磁盘 oracle
4. 审批超时不 abort run；deny 失败 UI 回滚
5. Desktop 本地 fork 诚实化 / 禁用

### P1

6. 工具 denial 结构化回灌 + reflection 预算可配置
7. 插件安装诚实 / 删除假货架
8. fatalOnError 生效；synthesis 不用 user 角色
9. Rewind UI 入口；checkpoint restore 实现或下架
10. In-app AI 测试采集层（事件+磁盘）

### P2

11. 流式 tool 预并发；Permission middleware 真挂载
12. Prompt 模板 / 规则双写统一
13. 插件沙箱；Sampling/Elicitation

---

## 4. 开源参考（方案阶段拉取 `reference/`）

| 目标                | 候选仓库                                              | 说明                       |
| ------------------- | ----------------------------------------------------- | -------------------------- |
| Provider 统一       | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 多厂商协议适配             |
| API 网关            | NewAPI / OneAPI 类                                    | 密钥/模型路由（按需）      |
| Agent 循环/工具     | OpenCode / Cline / Aider 等活跃仓                     | 反思、审批反馈、checkpoint |
| Computer-use 探索测 | [trycua/cua](https://github.com/trycua/cua)、OSWorld  | **非**主 CI                |
| Tauri E2E           | tauri-plugin-playwright / WebView2 CDP                | **软件内** UI 自动化       |

---

## 5. 下游文档

见同目录：

- `00-master-multi-agent-roadmap.md` — 总多轮编排
- `plans/*.md` — 分维度系统性方案
