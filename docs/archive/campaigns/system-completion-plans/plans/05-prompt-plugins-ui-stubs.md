# 05 · Prompt / 插件 / UI Stub 诚实化与接线方案

**日期**: 2026-07
**维度**: Prompt · Rules · Plugins · Extension Catalog · UI 审批 Stub
**上游**: [`audits/00-master-findings.md`](../audits/00-master-findings.md) §2.7–2.8、§3 P0/P1
**原则**: 证据级路径；先诚实、再接线、后沙箱；测试须在 **真实 Tauri 软件内**（非仅 Vite 端口）

---

## 0. 问题总览（用户现象 → 根因）

| 用户可见现象                                   | 代码根因（硬证据）                                                                                                                                              | 诚实等级       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 扩展中心点「安装」像成功，技能/MCP 实际不可用  | `SettingsExtensionsTab.handleInstallCatalog`：plugin 仅 `packages` 列表 + `markCatalogInstalled`；mcp/skill **只写 localStorage 已装 ID**，无下载/落盘/引擎注册 | 假安装         |
| 「已装插件」与引擎工具无关                     | **三套 registry 无总线**，discover 未接 daemon 启动路径                                                                                                         | 空壳           |
| 设置「回答风格」改了无感                       | `responseStyle` 仅 settings 持久化，**未进** `run-task` / system prompt                                                                                         | 死配置         |
| 规则有时生效、有时与仓库 AGENTS 冲突           | **双源**：`customRules` + `rule:desktop:*` scoped-context vs 磁盘 `AGENTS.md` 自动发现                                                                          | 双写未统一语义 |
| 点拒绝像成功，引擎仍可能卡审批                 | `handleApprovalDeny` **乐观标「已拒绝」**，`daemonDenyTool` 无 `.catch` / 无失败 toast / 无回滚                                                                 | 假成功         |
| 多工具待确认有「全部批准/拒绝」UI 却点不动有效 | `BatchApprovalBar` 依赖 `onBatchApprove/Deny`；`ChatMessageList` **未传入**                                                                                     | 未接线         |
| 货架展示官方/三方扩展                          | `EXTENSION_CATALOG` 静态策展 + `crish_extension_catalog_installed_v1`                                                                                           | 目录真、安装假 |

---

## 1. 证据清单（路径级）

### 1.1 插件假安装 / 扩展目录

| 路径                                                                                 | 事实                                                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `apps/crish-desktop/src/api/extensionCatalog.ts`                                     | `EXTENSION_CATALOG` 静态策展；`markCatalogInstalled` / `loadCatalogInstalledIds` 仅 localStorage              |
| `apps/crish-desktop/src/components/SettingsExtensionsTab.tsx` `handleInstallCatalog` | `kind==='plugin'` → `saveSettingsEx({ packages })` + mark；mcp/skill → **仅** mark + toast 路径无真实 install |
| `apps/crish-desktop/src/utils/storageKeys.ts`                                        | `EXTENSION_CATALOG_INSTALLED_KEY`                                                                             |

**结论**: 扩展目录是 UI 货架；安装态是浏览器/WebView 本地标记，**不是** daemon 侧能力开通。

### 1.2 三套 registry（无总线）

| #   | 符号                                  | 路径                                                     | 职责                                                                        | 生产接线                                                       |
| --- | ------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A   | `PluginRegistry`（贡献型）            | `packages/agent-runtime/src/plugin-registry.ts`          | 进程内 `registerPlugin`：tools/commands/events/renderers；实现 `ToolSource` | 单测有；**daemon 未统一装载**                                  |
| B   | `FsPluginRegistry` / `pluginRegistry` | `packages/agent-runtime/src/plugin-fs-registry.ts`       | 扫 `~/.crish/plugins`、`.crish/plugins`；`import(entry)` 动态加载 hooks     | `discover()` **未见** daemon/orchestrator 启动调用；**无沙箱** |
| C   | `ExtensionRegistry`                   | `packages/agent-runtime/src/hooks/extension-registry.ts` | hooks 管线、tools、UI/command 注册；session-loop 可注入                     | 默认可空实例；**与 A/B 不互通**                                |

**交叉断裂**:

- `packages/agent-orchestrator/src/orchestrator.ts`：`notifySessionStart` 调 `pluginRegistry.list()` / `.get()`（**FS 形态 API**），import 路径写为 `@crish/agent-runtime/plugin-registry`（与 index 双导出易混淆）。
- 贡献型 `PluginRegistry` 与 FS `pluginRegistry` **同名不同类**，无 `PluginHost` 总线。
- FS `load`：`await import(entryPath)` — 与 Node 主进程同权限，**无** worker/vm/权限声明执行。

### 1.3 responseStyle 未进 prompt

| 路径                                                           | 事实                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/crish-desktop/src/api/clientApi.ts`                      | `responseStyle?: ResponseStyle`；normalize / DEFAULT `medium`   |
| `apps/crish-desktop/src/components/SettingsPersonalizeTab.tsx` | UI select：minimal / low / medium / high                        |
| `packages/agent-daemon` / `useChatStream` run 路径             | **无** `responseStyle` 字段下发；prompt assembly **不读**该设置 |

**结论**: 设置可存可读，对模型输出 **零影响**。

### 1.4 规则双源

| 源                                                    | 路径                                                     | 注入方式                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 桌面设置 `customRules` + `rulesApi.syncRulesToDaemon` | `apps/crish-desktop/src/api/rulesApi.ts`                 | `upsert-scoped-context` id=`rule:desktop:global` / `rule:desktop:project`           |
| 磁盘项目规则                                          | `packages/agent-runtime/src/scoped-context-resources.ts` | 自动发现 `AGENTS.md`、`.agents/AGENTS.md`、`.opencode/AGENTS.md` 等为 enabled rules |
| 稳定 prompt 前缀                                      | `prompt-context` / `buildDaemonScopedPromptContext`      | enabled scoped resources 进 stable blocks                                           |

**张力**:

1. 用户改 Settings 规则 → scoped-context；**默认不写**工作区 `AGENTS.md`（产品信任方案已承认）。
2. 仓库已有 `AGENTS.md` → 引擎自动发现，与 desktop 规则 **并列注入**，顺序/覆盖语义未产品化说明。
3. Skills 另轨：`skillsApi` localStorage 激活 + 尽力 sync scoped-context（真链路存在，与假目录 skill 安装不同）。

### 1.5 UI deny 假成功

| 路径                                  | 行为                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ChatCard.handleApprovalDeny`         | 先 `status:'error', output:'已拒绝'`，再 `daemonDenyTool`；**无** `.catch`、**无** 失败 toast、**无** 回滚 pending |
| `ChatCard.handleApprovalAllow`        | 失败有 `.catch` → 标 error + `onShowToast('批准失败…')` — **不对称**                                               |
| `useAgentToolApproval.onApprovalDeny` | 同样乐观 patch + `finally` 清 busy，无失败回滚                                                                     |
| `daemonChatBridge.daemonDenyTool`     | `client.send({ type:'deny-tool' })` fire-and-forget 语义                                                           |

### 1.6 批量审批未接线

| 路径                                 | 行为                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `ChatToolCallBlock.BatchApprovalBar` | UI「全部批准 / 全部拒绝」；`onApprove/onDeny` 可选                                                          |
| `renderToolsWithBatchBars`           | `pending_approval` ≥2 时渲染 bar，props 透传                                                                |
| `ChatMessageList` `toolStackProps`   | 组装 `onApprovalAllow/Deny` 等，**未设** `onBatchApprove` / `onBatchDeny`                                   |
| 结果                                 | 按钮因 `onApprove?` 为 falsy **不渲染**，或若强制渲染也无 handler — 当前为 **有批量 UI 骨架、主对话未接线** |

---

## 2. 目标态（产品契约）

### 2.1 诚实优先（P0）

1. **安装**: 未实现真实安装的 kind → 按钮文案改为「标记关注 / 即将支持」或 disabled + 原因；禁止「安装成功」暗示能力已开通。
2. **deny**: 引擎拒绝失败 → 工具行回滚 `pending_approval` + toast；与 approve 对称。
3. **批量审批**: 要么接线真实逐条/协议级 batch，要么隐藏 BatchApprovalBar。
4. **responseStyle**: 要么注入 prompt，要么设置项标注「暂不影响模型」或下架。
5. **规则双源**: Settings 与 AGENTS 的优先级写进 UI/文档；禁止静默双写冲突。

### 2.2 能力接通（P1）

1. **PluginHost 总线**: 统一 discover → validate manifest → 注册贡献 → 生命周期通知。
2. **Skill 目录安装**: 可写 **Cursor/Cline 兼容** `SKILL.md` 到工作区/用户 skills 目录，再走现有 `loadSkillsFromDirectory` / scoped-context。
3. **MCP 目录安装**: 写入真实 MCP 配置通道（与 MCP 维度方案对齐），禁止只 mark localStorage。
4. **插件包**: `packages[]` 与 FS plugin 目录/registry 打通或诚实降级。

### 2.3 安全方向（P2，可与沙箱 ADR 并行）

1. **禁止** 默认 `import(entry)` 同进程无边界执行。
2. 插件沙箱方向（见 §6）：声明式权限 + worker/子进程 + 工具白名单；与 `conex-sandbox` gatekeeper 对齐思路。
3. Skill 默认 **数据面**（markdown 注入），不执行任意 JS。

---

## 3. 目标架构

```
┌─────────────────────────────────────────────────────────────┐
│ Desktop: 扩展中心 / 设置规则 / 个性化 / 审批 UI               │
└───────────────┬─────────────────────────┬───────────────────┘
                │ install / upsert        │ approve|deny|batch
                ▼                         ▼
┌───────────────────────────┐   ┌─────────────────────────────┐
│ ExtensionInstallService   │   │ ApprovalUiBridge            │
│ - skill → 写 SKILL 目录   │   │ - 乐观更新 + 失败回滚       │
│ - mcp → 配置通道          │   │ - batch → N× daemon 或协议  │
│ - plugin → PluginHost     │   │ - toast 对称                │
│ - 禁止纯 mark 当成功      │   └──────────────┬──────────────┘
└───────────────┬───────────┘                  │
                ▼                              ▼
┌───────────────────────────┐         daemon deny/approve-tool
│ PluginHost（新总线）       │
│  discover | load | unload │
│  contribute → ToolSource  │
└───────┬─────────┬─────────┘
        │         │
        ▼         ▼
  Fs discover   Contribution PluginRegistry
  (可选沙箱)    + ExtensionRegistry hooks
        │
        ▼
  SessionLoop / Orchestrator 单一入口 list/get/notify
```

**Prompt 侧**:

```
Settings.responseStyle ──► run-task 元数据或 stable prompt 片段
Settings.customRules   ──► rule:desktop:* (scoped-context)  [权威：UI 规则]
磁盘 AGENTS.md         ──► scoped-context-resources         [权威：仓库规则]
合并策略（产品二选一，见 Agent-2）
```

---

## 4. 分项方案

### 4.1 扩展目录：从假安装到可验证安装

#### 4.1.1 阶段 A — 诚实化（必须先做）

| kind   | 当前                   | 诚实 UI                                                                     |
| ------ | ---------------------- | --------------------------------------------------------------------------- |
| plugin | packages 字符串 + mark | 若无 PluginHost：`添加包名引用（未加载代码）`；禁用「安装」或拆「记录引用」 |
| mcp    | 仅 mark                | 「需在 MCP 配置中添加服务」+ 深链；或打开真实添加表单（依赖 MCP 方案）      |
| skill  | 仅 mark                | 「从目录导入 / 写入 skills 路径」；无写盘则不可点安装                       |

`markCatalogInstalled` 仅表示 **用户关注/占位**，展示「已关注」而非「已安装」。

#### 4.1.2 阶段 B — Skill 真安装（推荐优先，格式可兼容）

**可写 Cursor / Cline skill 格式**（与现有 runtime 兼容）：

```text
{skillsRoot}/{skill-name}/SKILL.md
---
name: git-pr
description: 整理提交说明与 PR 描述
---
# 正文（markdown 指令）
```

实现要点：

1. 安装源：内置模板包 / 用户选择目录 / 后续 URL（P2）。
2. 落盘根：项目 `.conex/skills` 或用户 global skills（与 `workbench_discover_skills` / `scoped-context-resources` 扫描路径对齐，**先读现有 discover 列表再定唯一根**）。
3. 安装成功条件：`SKILL.md` 可被 `loadSkillsFromDirectory` 解析 +（可选）`skillsApi` 激活 sync。
4. 卸载：删目录或移入 trash + unmark + 清 scoped-context。

#### 4.1.3 阶段 C — MCP / Plugin

- MCP：复用 MCP 配置注入 daemon 的 P0 工作；目录「安装」= 写入 `mcpServers` 配置项。
- Plugin：PluginHost 就绪后，npm/path 解包到 `~/.crish/plugins/<id>/plugin.json`，再 `discover+load`（沙箱未就绪前仅 **trusted local path**）。

#### 4.1.4 验收

- 假安装路径 **零**「安装成功」文案（正式模式）。
- Skill 安装后新会话 slash/列表可见同名 skill。
- 卸载后不可见且 localStorage 与磁盘一致。

---

### 4.2 三套 registry → PluginHost 总线

#### 4.2.1 命名与职责收敛

| 现名                                  | 目标名（建议）               | 职责                                                                                      |
| ------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `plugin-registry.ts` `PluginRegistry` | `ContributionPluginRegistry` | 纯内存贡献表，ToolSource                                                                  |
| `plugin-fs-registry.ts`               | `FsPluginLoader`             | 扫盘 + 加载模块（未来沙箱边界）                                                           |
| `hooks/extension-registry.ts`         | 保留 `ExtensionRegistry`     | session hooks 合成                                                                        |
| 新建                                  | `PluginHost`                 | 唯一对外：`discover/load/unload/enable`；内部编排 Loader → Contribution → Extension hooks |

#### 4.2.2 接线顺序

1. 修正 orchestrator import：明确使用 `pluginRegistry`（FS）或改调 `PluginHost`。
2. daemon 启动 / workspace open：可选 `PluginHost.discover()`（feature flag）。
3. `notifySessionStart/End` 只经 Host。
4. Contribution tools 进入现有 tool discovery 合并点（与 MCP tools 并列）。
5. **未沙箱前**: 默认关闭远程/社区包执行；仅 `settings.trustedPluginPaths`。

#### 4.2.3 不做

- 三套继续并行增长 API。
- UI 扩展组件远程加载（安全面过大，P2+）。

---

### 4.3 responseStyle → prompt

#### 4.3.1 映射表（注入 stable 短指令）

| 值        | 注入要点（中英可择一，建议中英双语短句） |
| --------- | ---------------------------------------- |
| `minimal` | 极简：直接结论，少列表，默认不展开步骤   |
| `low`     | 简洁：要点清楚，避免冗长背景             |
| `medium`  | 默认：适度分步，关键依据                 |
| `high`    | 深入：分析假设、权衡、边界与验证建议     |

#### 4.3.2 接线

1. Desktop `run-task`（或现有 metadata/settings 通道）携带 `responseStyle`。
2. Daemon/runtime 在 `prompt-context` 增加 **非缓存破坏可控** 的 style block（若 prompt cache 敏感：放入 volatile 或与 user 规则同级且版本稳定）。
3. 单测：四档 style → assembly 快照含对应关键词。
4. 若短期无法改协议：Personalize UI 显示「将在下版生效」并 **禁用选择** — 禁止假装已生效。

---

### 4.4 规则双源统一

#### 4.4.1 产品策略（选一并写死）

**推荐 S1「分层叠加 + 明示」**:

1. 磁盘 `AGENTS.md` 等 = **项目事实源**（团队共享）。
2. `rule:desktop:global/project` = **用户覆盖层**（本机/本工作区偏好）。
3. Prompt 顺序：`AGENTS（项目）→ desktop project → desktop global`（后写可声明更高优先级，需在块标题标明）。
4. Settings 文案：「不会自动改写 AGENTS.md；与仓库规则同时生效」。

**备选 S2「单一权威」**: Settings 保存时可选「同步写入 AGENTS.md」（UTF-8）；开启后 desktop rule id 与文件内容一致，冲突检测 toast。

#### 4.4.2 工程

1. `rulesApi` 保持 upsert；增加 `getEffectiveRulesPreview()`（可选）合并预览。
2. 禁止第三条隐式源（例如再拼 `customRules` 进 run prompt 而不经 scoped-context）。
3. 单测：双源并存时 stable prompt 含两块且顺序固定。

---

### 4.5 UI deny 假成功 → 对称可靠

#### 4.5.1 状态机

```
pending_approval
  ├─ user deny click → ui:denying（可选）→ send deny-tool
  │     ├─ ok / approval-resolved denied → error + 「已拒绝」
  │     └─ send 失败 / 超时无 resolved → 回滚 pending_approval + toast
  └─ user allow …（已有 catch，保持）
```

#### 4.5.2 改动点

| 文件                                       | 改动                                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| `ChatCard.tsx` `handleApprovalDeny`        | `.catch` 回滚 + toast；可与 allow 抽 `applyApprovalDecision` |
| `useAgentToolApproval.ts`                  | 同上                                                         |
| `OverviewCard` / `RuntimePanel` 若同类乐观 | 审计对齐                                                     |
| 可选                                       | 以 `approval-resolved` 事件为最终态，乐观仅 pending→deciding |

#### 4.5.3 验收

- 断连引擎点拒绝 → UI 仍为待确认 + 失败提示。
- 连通拒绝 → 引擎继续/结束与 tool-result denial 一致（与 Tools 维度 denial 文案方案协同）。

---

### 4.6 批量审批接线

#### 4.6.1 最小实现（无新协议）

```ts
onBatchApprove = async (msgIds) => {
  const tools = collectPendingInOrder(msgIds);
  for (const t of tools) await handleApprovalAllow(t.id, t.msgId);
};
onBatchDeny = similarly;
```

注意：busy 锁、部分失败（第 k 个失败则停或继续）、toast 汇总。

#### 4.6.2 接线位置

- `ChatMessageList` 的 `toolStackProps` 增加 handler；handlers 由 `ChatCard` 下发（与单条同一闭包，保证 sessionId/乐观更新一致）。
- 子 agent 栈：`useAgentToolApproval` 扩展 batch 或隐藏 batch bar（`onBatch*` 不传则 bar 按钮不显示 — 保持现状组件语义）。

#### 4.6.3 验收

- ≥2 pending 出现 bar；一点全部批准后均离开 pending。
- 中途 daemon 失败：已成功的保持，失败项回滚或标错，有汇总 toast。

---

## 5. 多轮多 Agent 执行编排（≥4 Agent，≥4 轮）

> 约束模板与仓库 `multi_agent_execution_guide` / 产品信任计划一致：
> **ALLOWED / FORBIDDEN / VERIFY**；每轮只做一刀；禁止跨维顺手改 MCP 启停实现细节（仅契约引用）。

### 5.0 Agent 角色

| Agent | 代号                                  | 职责                                            |
| ----- | ------------------------------------- | ----------------------------------------------- |
| A1    | `HOST-HONEST`                         | 扩展目录诚实化 + 安装态语义                     |
| A2    | `PROMPT-STYLE-RULES`                  | responseStyle 注入 + 规则双源策略落地           |
| A3    | `APPROVAL-UI`                         | deny 回滚 + 批量审批接线                        |
| A4    | `PLUGIN-BUS`                          | PluginHost 总线 + registry 收敛 + discover 接线 |
| A5    | `SKILL-INSTALL`（可选并入 A1 第二轮） | SKILL.md 真安装/卸载                            |
| A6    | `SANDBOX-ADR`（文档向）               | 插件沙箱方向 ADR，不写执行器也可先合文档        |

编排：**串行轮次**；同轮内 A1∥A3 可并行（文件冲突面低），A2 与 A4 错开。

---

### Round 1 — 止血诚实（并行：A1 + A3）

**目标**: 用户不再被假成功欺骗。

#### A1 `HOST-HONEST`

```
ALLOWED:
  - apps/crish-desktop/src/api/extensionCatalog.ts（文案/状态类型，如 installed vs pinned）
  - apps/crish-desktop/src/components/SettingsExtensionsTab.tsx（安装按钮语义、toast）
  - 相关测试
FORBIDDEN:
  - 实现完整 PluginHost / 真 MCP 拉起
  - 删除 EXTENSION_CATALOG 策展数据（可改展示标签）
VERIFY:
  - 正式模式 skill/mcp 点击不出现「已安装可用」类文案
  - plugin 仅 packages 时 UI 标明「仅记录引用」
  - desktop typecheck + 扩展 tab 单测
```

#### A3 `APPROVAL-UI`（本轮只做 deny 对称）

```
ALLOWED:
  - ChatCard handleApprovalDeny
  - useAgentToolApproval
  - 必要 toast 调用点
FORBIDDEN:
  - 改 daemon 审批协议
  - 批量审批（Round 2）
VERIFY:
  - 模拟 send 失败：状态回滚 pending_approval + toast
  - 与 approve 失败路径对称
```

**出口**: 假安装文案消失；deny 不再假成功。

---

### Round 2 — 批量审批 + responseStyle 协议位（并行：A3 续 + A2 半）

#### A3 续 `BATCH-WIRE`

```
ALLOWED:
  - ChatCard / ChatMessageList / ChatToolCallBlock props 接线
  - batch 辅助函数（同文件或 approvalHelpers）
FORBIDDEN:
  - 新 daemon 消息类型（除非已有 batch API）
VERIFY:
  - 2+ pending 出现可用「全部批准/拒绝」
  - 单测或组件测：handler 调用 N 次 deny/approve
```

#### A2 上半 `STYLE-WIRE`

```
ALLOWED:
  - clientApi / run 路径携带 responseStyle
  - daemon 或 runtime prompt-context 增加 style block
  - SettingsPersonalizeTab 文案（若未接通则诚实标注）
FORBIDDEN:
  - 大改 prompt cache 架构
  - 改 provider 协议无关字段
VERIFY:
  - 单元：四档 style 出现在 assembled system/stable 文本
  - 设置保存后新 run 生效（软件内或 daemon 单测）
```

**出口**: 批量可用；style 真进 prompt **或** UI 诚实禁用。

---

### Round 3 — 规则双源 + Skill 真安装（并行：A2 下半 + A5/A1）

#### A2 下半 `RULES-DUAL`

```
ALLOWED:
  - rulesApi / SettingsRulesTab 文案与预览
  - 文档化顺序；可选 getEffectiveRulesPreview
  - scoped-context 合并顺序单测（若需极小 runtime 注释放开）
FORBIDDEN:
  - 默认静默写 AGENTS.md（除非任务显式 S2）
  - 破坏现有 upsert id 契约 rule:desktop:*
VERIFY:
  - 双源并存顺序稳定
  - Settings 说明可见
```

#### A5 `SKILL-INSTALL`

```
ALLOWED:
  - 安装写 SKILL.md（Cursor/Cline frontmatter 兼容）
  - 对接现有 skills 发现路径与 skillsApi
  - extensionCatalog 安装成功条件绑定「文件存在」
FORBIDDEN:
  - 执行 skill 内任意脚本
  - 假 mark 当成功
VERIFY:
  - 安装 → discover 列表含 name
  - 卸载 → 列表无 + unmark
```

**出口**: 规则语义清楚；至少 skill 目录可真安装。

---

### Round 4 — PluginHost 总线（A4）

```
ALLOWED:
  - packages/agent-runtime: PluginHost 新文件；Fs loader / Contribution registry 适配
  - orchestrator notifySessionStart 改经 Host
  - index 导出整理（消除 pluginRegistry 双义）
  - feature flag 默认 off 或仅 trusted path
FORBIDDEN:
  - 默认开启社区包 remote import
  - 无权限模型的任意代码执行扩大面
VERIFY:
  - 单测：register contribution → listTools
  - 单测：FS loader mock → Host.list
  - orchestrator 不再错误 import 混用 API
```

**出口**: 单一总线可测；生产默认安全关闭或 trusted-only。

---

### Round 5（可选）— 沙箱方向 ADR + MCP 目录真装

#### A6 `SANDBOX-ADR`

产出：`docs/architecture/` 或本目录附录 — 插件沙箱方向（§6 展开），**代码可后续**。

#### A1/MCP 协作

目录 MCP 安装 → 真实配置写入（依赖 MCP P0 API 名对齐完成后）。

---

## 6. 插件沙箱方向（参考，非本文件强制实现）

### 6.1 威胁模型

| 威胁                             | 现况                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| 恶意 `import(entry)` 读密钥/改盘 | FS registry 同进程全权                                             |
| 供应链（社区主题包等）           | 货架 installRef 可诱导用户信任                                     |
| Skill 提示注入                   | markdown 进 prompt — 需 tool-output/skill 内容消毒协同（Tools 维） |

### 6.2 分层建议

1. **L0 数据扩展（默认）**: Skill / 规则 / 提示模板 — 仅文本，无代码执行。
2. **L1 声明式工具**: JSON schema + 宿主实现的 tool 适配器（类似 MCP tool 包装）。
3. **L2 隔离执行**: `worker_threads` / 子进程；无默认 FS；IPC 白名单 API（log、限权 read）。
4. **L3 OS 沙箱**: 复用 `crates/conex-sandbox` gatekeeper 思路跑侧车命令，不直接 `import`。

### 6.3 Manifest 方向（示意）

```json
{
  "name": "audit-helper",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "permissions": ["tools.register", "hooks.onSessionStart"],
  "sandbox": "worker",
  "contributes": { "tools": [], "commands": [] }
}
```

加载策略：`permissions` 超出会话 trust → 拒绝 load；`sandbox:"none"` 仅 dev/trusted。

### 6.4 与 Skill 格式关系

- **Skill（Cursor/Cline）**: 优先 L0，继续 `SKILL.md` frontmatter。
- **Plugin**: L1+；不与 skill 目录混装执行入口。

---

## 7. 文件级改动地图（按轮次）

| 轮次 | 主要文件                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `extensionCatalog.ts`, `SettingsExtensionsTab.tsx`, `ChatCard.tsx`, `useAgentToolApproval.ts`                                    |
| R2   | `ChatMessageList.tsx`, `ChatCard.tsx`, `ChatToolCallBlock.tsx`（若需）, `clientApi`/run 路径, `prompt-context`/`prompt-assembly` |
| R3   | `rulesApi.ts`, `SettingsRulesTab.tsx`, skill 安装服务, discover 路径对齐                                                         |
| R4   | `plugin-host.ts`（新）, `plugin-fs-registry.ts`, `plugin-registry.ts`, `orchestrator.ts`, `index.ts`                             |
| R5   | ADR 文档；MCP 配置写入（跨维）                                                                                                   |

---

## 8. 测试矩阵（软件内优先）

| ID  | 场景                           | 期望                                     |
| --- | ------------------------------ | ---------------------------------------- |
| T1  | 扩展中心安装 skill（诚实阶段） | 无能力暗示；或（R3 后）磁盘出现 SKILL.md |
| T2  | 断连 deny                      | 回滚 pending + toast                     |
| T3  | 双 pending batch deny          | 均拒绝且引擎无挂起审批                   |
| T4  | responseStyle=high 新会话      | 轨迹/请求体含深入风格指令                |
| T5  | AGENTS.md + desktop 规则       | 两块均在 stable prompt，顺序符合 S1      |
| T6  | PluginHost 单测                | discover+contribute 列表稳定             |
| T7  | 卸载 catalog skill             | 列表与磁盘与 mark 一致                   |

**禁止**: 仅用 Vite 浏览器端口冒充扩展安装/审批通过标准（MCP stdio、审批闸需 WebView2+daemon）。

---

## 9. 优先级与依赖

```
P0  R1 假安装诚实 + deny 回滚
P0  R2 批量审批接线（或隐藏 UI）
P1  R2 responseStyle 真注入
P1  R3 规则双源产品化 + Skill 真安装
P1  R4 PluginHost（trusted-only）
P2  R5 沙箱 ADR + 社区包执行 + MCP 货架真装
```

**跨维依赖**:

- MCP 真安装 → `00-master-findings` MCP startServer 对齐。
- Denial 回灌文案质量 → Tools & Permissions 维。
- Goal/长程测 → 不阻塞本维，但审批 batch/deny 影响长程稳定性。

---

## 10. 明确不在范围

- Anthropic/Gemini provider 空壳（Multi-Provider 维）。
- Goal DONE 假完成（Goal 维）。
- fork/checkpoint product API。
- 完整远程插件市场后端。
- 在未沙箱前启用任意 URL 插件执行。

---

## 11. 子 Agent 总约束（全局）

```
原则:
  1. 先诚实，再接线，后增强
  2. 证据路径写进 PR/提交说明
  3. 不扩大 import(entry) 攻击面
  4. Skill 格式兼容 Cursor/Cline SKILL.md frontmatter
  5. 测试：能单测的单测；安装/审批以 Tauri 软件内为准
  6. 与 docs/plans/2026-07-product-trust-topdown.md 规则/技能契约不冲突
```

---

## 12. 完成定义（本维 Done）

- [ ] 扩展目录无「假安装成功」用户路径
- [ ] 至少 skill 可真安装到 discover 路径（或货架 skill 入口移除）
- [ ] 三套 registry 有 Host 或文档化废弃时间表 + orchestrator API 不混用
- [ ] responseStyle 影响 prompt **或** UI 诚实下架
- [ ] 规则双源顺序/文案产品化
- [ ] deny 失败可感知可回滚
- [ ] 批量审批真接线或 UI 移除
- [ ] 沙箱方向有书面 ADR（实现可后置）

---

## 13. 参考

| 主题            | 参考                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| 审计证据        | `docs/system-completion-plans/audits/00-master-findings.md`                              |
| 规则/技能信任   | `docs/plans/2026-07-product-trust-topdown.md`                                            |
| 现有 skill 加载 | `packages/agent-runtime/src/skills.ts`（SKILL.md + frontmatter）                         |
| 贡献 registry   | `packages/agent-runtime/src/plugin-registry.ts`                                          |
| FS 动态加载     | `packages/agent-runtime/src/plugin-fs-registry.ts`                                       |
| Extension hooks | `packages/agent-runtime/src/hooks/extension-registry.ts`                                 |
| OS 沙箱思路     | `crates/conex-sandbox`、`docs/rust-architecture-redesign/01-RUST-PTY-RUNTIME-SANDBOX.md` |
| Skill 格式      | Cursor / Cline 社区 `SKILL.md` 约定（name/description frontmatter + markdown body）      |
