# 产品信任与配置契约收敛计划（自上而下）

> 目标：让「UI 上可配的每一项」都有明确写入目标与生效边界；砍死轨、对齐契约、诚实降级。
> 排序原则：**逻辑依赖自上而下**（契约 → 引擎接线 → 桌面 API → 设置 UI → 聊天周边 → 卫生结构），**不是优先级排序**。
> 状态：**已实施（T0–T8）**，T9 结构拆分可另开专项。
> 实施提交见分支 `refactor/architecture` 近期 commits。

---

## 0. 背景与边界

### 0.1 已达成共识（交叉审查）

- 核心对话环路（`chatApi` → `daemonChatBridge` → daemon `run-task`）是真路径，不是演示壳。
- 模型/密钥主轨是 `providerProfiles` + `update-config`。
- 主要问题是 **表面完成度 > 功能完成度**：设置/技能/MCP/规则等半接线；双轨配置；少量引擎次要 API 未成形。
- 正式/演示双模式、UI 会话正文为真相源等是 **有意设计**，不是 bug；但必须写进契约，避免子 agent 误改。

### 0.2 本计划 **做**

1. 建立「设置项 → 写入目标」契约表，并落到代码/文案。
2. 对齐技能 ID 与 scoped-context 激活/禁用。
3. 让规则对模型真正生效（或诚实标注不可用——本计划默认 **接真**）。
4. 收敛 MCP 正式 UI 到与引擎能力一致的行为（诚实空态 / 可实现的 list；启停仅在 API 真实可用时）。
5. 删除或隔离 `clientApi` 死轨（providers / 假模型 / cron 混用）。
6. 聊天 slash / Goal 等演示面与正式面分离。
7. 仓库卫生与有限结构拆分（在契约稳定后）。

### 0.3 本计划 **不做**（禁止范围）

| 禁止 | 原因 |
|------|------|
| 全盘 redesign / 换设计语言 / 大改主题字体 | 与信任契约无关 |
| 统一会话真相为「仅 daemon」 | 产品策略明确：UI JSONL 为主，daemon 补元数据 |
| 实现完整 PTY 终端 / 真插件商店 / artifacts UI | 能力未就绪；只做诚实隐藏或文案 |
| 重写 agent-workbench 旧 Preact UI | 已弃用；最多文档标注 |
| 在未改引擎的情况下假装 MCP「添加服务」进正式产品 | 无配置注入通道 |
| 为通过 typecheck 大面积 `as any` | 禁止用逃逸掩盖契约 |
| 改动 monorepo 无关包（cli 无关路径、历史 plan md 堆） | 控制 blast radius |

### 0.4 成功标准（Definition of Done）

- [ ] 存在契约表（本文 §1），且 Settings 每个可编辑字段能映射到表中一行。
- [ ] 正式模式：规则对 **下一次 run** 生效（注入 scoped-context 或等价稳定上下文）。
- [ ] 技能启用/禁用控制 **同一 id** 的记录；禁用后自动发现技能不再进 prompt。
- [ ] 正式 MCP 页不出现「点了启停却永远失败且无解释」；未配置时诚实空态。
- [ ] 正式路径不再调用 `clientApi.getProviders` / `fetchLatestModels` / 用 localStorage cron 冒充调度。
- [ ] `npm run check:desktop` 通过；若动 daemon/runtime，对应 `check:daemon` / 相关 vitest 通过。
- [ ] 中文 UI 字符串与提交信息 UTF-8 无乱码。

---

## 1. 配置契约表（全局唯一真相）

> 任何改设置的 PR **必须** 对照本表。子 agent 不得发明新 localStorage key 而不更新本表。

### 1.1 写入目标类型

| 代号 | 含义 |
|------|------|
| `UI-ONLY` | 仅影响壳层展示，不进 agent |
| `LS` | localStorage / 磁盘镜像，仅客户端 |
| `ENGINE-CONFIG` | daemon `update-config`（provider/model/baseUrl/key 等） |
| `ENGINE-SCOPED` | daemon scoped-context store（规则/技能等） |
| `ENGINE-RUN` | 单次 `run-task` 字段（permissionMode、cwd、prompt） |
| `ENGINE-WORKFLOW` | daemon workflows API |
| `ENGINE-MCP` | daemon MCP list/start/stop（能力受限时见 §4） |
| `DEAD` | 应删除的死轨 |
| `HONEST-HIDE` | 能力未就绪：隐藏或只读说明，禁止可编辑假控件 |

### 1.2 字段映射（目标态）

| UI 表面 | 字段 / 行为 | 目标写入 | 生效时机 | 备注 |
|---------|-------------|---------|----------|------|
| 模型页 | profile / key / model / baseUrl | `ENGINE-CONFIG` + `LS` profiles | 保存/激活立即 | **唯一**供应商轨 |
| 模型页 | 价格/上下文展示 | `LS` meta | 仅展示 | |
| 对话 | permissionMode | `ENGINE-RUN` + `LS` | 下次 run | 已接线，勿拆 |
| 对话 | cwd / workspace | `ENGINE-RUN` | 下次 run | projectStore |
| 技能页 | activation | `ENGINE-SCOPED` + `LS` 覆盖表 | 下次 run | ID 必须与 runtime 一致 |
| 技能页 | extra dirs / 发现 | `LS` | 扫描 | |
| 技能页 | `/skill:name` | `ENGINE-RUN`（改写 prompt） | 当次 | 与 activation 互补，不替代 |
| 规则页 | global/project rules | `ENGINE-SCOPED`（kind=rule） | 下次 run | 本计划接真 |
| 扩展服务 | list/status | `ENGINE-MCP` | 刷新 | 空态诚实 |
| 扩展服务 | start/stop | `ENGINE-MCP` 或 `HONEST-HIDE` | 仅 API 真可用时 | 见 §4 |
| 定时任务 | CRUD/trigger | `ENGINE-WORKFLOW` | 立即 | 唯一调度轨 |
| 账户/会话目录 | sessionDir | `HONEST-HIDE` 或接 mirror | 未接前只读展示 appData | 禁止静默无效输入 |
| 账户 | httpProxy | `HONEST-HIDE` 或 ENGINE | 未接前禁用 | |
| 安全 | commandPermissions | `LS` 持久化 + 明确是否影响审批 | 见 §5 | 勿假装引擎白名单除非真接 |
| 个性化 | responseStyle | `UI-ONLY` 或删 | | 去掉 `as any` 或正经入 Settings 类型 |
| 主题/字体 | theme/fonts | `UI-ONLY`/`LS` | 立即 | 保持 |
| 旧 providers | clientApi providers | `DEAD` | | 删除调用 |
| 假模型列表 | fetchLatestModels | `DEAD` | | 删除 |
| localStorage cron | getScheduledTasks | `DEAD`（正式） | | Runtime 只读 workflow |
| 插件 tab | packages | demo only | | 正式不出现 |
| Goal 抽屉 | 进度/暂停 | demo only 或 `HONEST-HIDE` | | 正式默认关 |

### 1.3 本层交付物

- 更新本文或拆出 `docs/CONFIG-CONTRACT.md`（保持单表）。
- 代码内关键 API 文件头注释指向契约代号（简短，勿长篇）。

### 1.4 子 agent 约束（§1）

```
ALLOWED: 新增/更新契约文档；在 skillsApi/providerProfiles/workflowApi/mcpApi 文件头加 3～10 行注释
FORBIDDEN: 改 UI 视觉；改 run-task 协议字段名（除非同步改 daemon 类型与测试）；新增 crish_* key 不更新契约表
VERIFY: 文档与 §1.2 表一致；无新增 orphan key
```

---

## 2. 引擎侧：scoped-context 与技能 ID 契约

> 桌面与 runtime **共用同一 id 算法**，否则启用/禁用无效。

### 2.1 目标 ID 算法

Runtime 现状（权威）：

```ts
// packages/agent-runtime/src/scoped-context.ts
id = wrapped.id ?? stableId("skill", `${skill.name}:${skill.filePath}`)
// => skill_<sha256(...).slice(0,12)>
```

桌面现状（错误）：

```ts
// apps/crish-desktop/src/api/skillsApi.ts
id = `skill-file:${filePath.normalized}`
```

**目标态（二选一，推荐 A）：**

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A（推荐）** | 桌面生成 id 时与 runtime 一致：若 daemon/store 接受显式 `id`，upsert 时 **使用** `stableId("skill", name:filePath)`；共享算法抽到 `@crish/shared-utils` 或 desktop 复制 **同一** hash 实现并加单测对照 | 与文件发现记录可对齐 | 需抽/复制 hash |
| **B** | 文件发现记录在 merge 时用 path 做二次键；store overwrite by path | 少改 desktop | 改 runtime 合并策略，风险大 |

**本计划锁定方案 A。**

规则 id 建议：

```ts
stableId("rule", `${scope}:${title}:${content}`)
// 或固定 id：`rule:global:custom` / `rule:project:${projectId}`
```

固定 id 更利于覆盖更新（推荐规则用固定 id）：

- `rule:desktop:global`
- `rule:desktop:project`（内容变化时 upsert 同 id）

### 2.2 激活语义

| activation | 进 stable prompt？ | store 行为 |
|------------|-------------------|------------|
| `enabled` | 是 | upsert activation=enabled |
| `recommended` | 否（仅候选） | upsert recommended **或** 不写 store，仅本地标记 |
| `disabled` | 否 | 若存在 store 记录则 delete；并对 **同 path 发现项** 写入 userDisabledIds（若 resolver 支持） |

必须阅读 `resolveScopedContext` 的 `userEnabledIds` / `userDisabledIds`：

- 若 daemon resolve 已支持 disabled 列表：桌面应调用对应 API 或把 disabled 编码进 store。
- 若仅靠 store 覆盖：禁用 = delete store + 确保文件发现 recommended 不因 store 残留 enabled。

**验收：** 对同一 `SKILL.md` 点禁用 → 下一次 run 的 prompt 中不再出现该 skill 正文（可用 daemon 测试或日志断言）。

### 2.3 实现切片

1. **共享 id 工具**（小 PR）
   - 位置优先：`packages/shared-utils` 或 runtime 已导出函数供 desktop 依赖。
   - 若 desktop 不便依赖 runtime：在 desktop 实现 **字节级一致** 的 sha256 截断，并加 golden test 向量（固定 name+path → 固定 id）。

2. **skillsApi 改 id**
   - `skillIdFromPath` → `skillIdFromNameAndPath(name, filePath)` 与 runtime 一致。
   - 迁移：旧 localStorage `crish_skill_activation_v1` 键 remap 一次（读旧键，按 path 找 skill，写新 id）。

3. **setSkillActivation**
   - enabled/recommended/disabled 行为按 §2.2。
   - daemon 失败必须 **throw 或返回 ok:false**，UI toast「仅已保存在本机，引擎未同步」。

4. **规则 upsert**（可与 §3 合并 PR）
   - `upsert-scoped-context` kind=rule，固定 id。

### 2.4 子 agent 约束（§2）

```
ALLOWED:
  - packages/agent-runtime scoped-context 仅当需要 export stableId/skillToScopedContextRecord（尽量不改语义）
  - packages/shared-utils 新增 skillStableId（若采用）
  - apps/crish-desktop/src/api/skillsApi.ts
  - 对应 *.test.ts
FORBIDDEN:
  - 改 ChatCard UI 布局
  - 改 MCP / provider / theme
  - 改变 activation 三态含义为其它枚举
  - 删除 /skill: 注入路径（本阶段保留）
VERIFY:
  - golden id 单测：name+path → 与 runtime skillToScopedContextRecord 一致
  - 禁用后 resolve 结果不含该 skill（daemon 或 runtime 单测）
  - desktop typecheck
```

---

## 3. 规则进入引擎（Settings → scoped-context）

### 3.1 现状

- `SettingsPanel` 保存 `customRules` → `crish_settings` only。
- `run-task` 仅：`prompt, sessionId, permissionMode, cwd`。
- 文案已承认未写 AGENTS.md。

### 3.2 目标行为

1. 用户保存全局/项目规则 →
   - 仍可写 `customRules` 到 settings（本地备份）
   - **同时** `upsert-scoped-context`：
     - id: `rule:desktop:global` / `rule:desktop:project`
     - kind: `rule`
     - activation: `enabled`
     - content: 规则正文
     - scope: global | project
2. 清空规则 → `delete-scoped-context` 对应 id。
3. Toast：成功「已同步到引擎」/ 失败「已保存在本机，引擎未连接」。
4. 可选后续（本计划不强制）：写工作区 `AGENTS.md`——若做，必须用 UTF-8 安全写入，且与 scoped-context **双写说明白**。

### 3.3 文件范围

- 新建或扩展：`apps/crish-desktop/src/api/rulesApi.ts`（推荐，薄封装）
- `SettingsPanel.tsx` 规则保存路径改为调 `rulesApi`
- 不改 `run-task` 协议（依赖已有 scoped-context 注入路径：`buildDaemonScopedPromptContext`）

### 3.4 子 agent 约束（§3）

```
ALLOWED: rulesApi.ts；SettingsPanel 规则 tab 保存/加载逻辑；clientApi Settings.customRules 类型保持
FORBIDDEN: 改 Models/Skills/MCP tab 组件；写 AGENTS.md 除非任务单明确要求；改 daemon 注入策略
VERIFY: 断连时本地仍保存；连上时 store 可 get-scoped-context 读到 rule:desktop:*
```

---

## 4. MCP：能力对齐与诚实 UI

### 4.1 引擎事实

- `list-mcp-servers`：依赖 `lastMcpStatus.servers`；未配置时常空。
- `start-mcp-server` / `stop-mcp-server`：factory 调 `startServer`/`stopServer`，库存 `McpLifecycleManager` **无此方法**。
- 真 MCP：有 `mcpServers` 配置时在 **run 路径** 拉起，非 UI 生命周期。
- 默认 `startDaemon` **不**注入 `mcpServers`。

### 4.2 目标态（分两步，顺序固定）

#### 4.2.1 诚实层（先做，不扩协议）

正式 `McpSettingsTab`：

1. 调用 `list-capabilities` 或 list 失败信息，展示：
   - 未配置 / 不支持启停 / 列表为空 的原因说明。
2. **启停按钮**：若 start/stop 探测失败（或 capability 非 implemented），隐藏或 disabled + tooltip「当前引擎不支持从界面启停；MCP 随任务运行时连接」。
3. Demo 模式保持 localStorage mock（已隔离），不污染正式。
4. 禁止再暗示「添加服务会进引擎」于正式模式。

#### 4.2.2 可选增强（仅当产品明确要求「可配置 MCP」）

单独后续 PR，**不在同一子 agent 任务混做**：

- daemon 支持从配置文件/选项加载 `mcpServers`
- factory 实现真正的 start/stop 或改协议对接 `addServer`/`reconnectServer`
- desktop 配置通道（文件路径或 WS 消息）

未完成 4.2.2 前，正式 UI **不得** 出现可提交的「注册 MCP」表单。

### 4.3 子 agent 约束（§4）

```
ALLOWED:
  - mcpApi.ts（list + 能力探测 + 错误码）
  - McpSettingsTab.tsx 正式分支 UI 文案与按钮显隐
  - 可选：daemon 仅当任务单写明 4.2.2
FORBIDDEN:
  - 正式模式接 clientApi.saveMcpServer
  - 假 start 成功 toast
  - 改 skills / rules / providers
VERIFY:
  - 无 mcp 配置时页面可理解
  - demo 模式添加仍可用
  - typecheck
```

---

## 5. 安全与账户页：假控件收敛

### 5.1 commandPermissions

现状：Zustand 内存，刷新丢失；与引擎审批策略关系不清。

**目标（选一，任务单必须写死）：**

| 选项 | 行为 |
|------|------|
| **S1 持久化-only** | 写入 `localStorage crish_command_permissions_v1`；UI 标明「仅影响本机审批快捷放行（若未接引擎则以 UI 为准）」 |
| **S2 移除** | 安全页删除白名单编辑，仅保留 permissionMode 说明 |
| **S3 真接引擎** | 需 daemon 协议字段；**超出本计划默认范围** |

默认推荐 **S1**，并在 layoutStore hydrate 时恢复。

### 5.2 sessionDir / httpProxy

- **短期**：改为只读展示「当前会话数据位置（appData/…）」+ 文案「自定义目录尚未接入」；输入框 disabled。
- **禁止**：可编辑却只写 settings blob。

### 5.3 responseStyle

- 纳入 `Settings` 类型正式字段，或删除 UI。禁止 `as any`。

### 5.4 子 agent 约束（§5）

```
ALLOWED: SettingsPanel profile/security/personalize 相关块；layoutStore commandPermissions 持久化；clientApi Settings 类型
FORBIDDEN: 改 daemon 协议（除非 S3）；改聊天发送逻辑
VERIFY: 刷新后白名单仍在（S1）；sessionDir 不可静默无效写入
```

---

## 6. 砍死轨：clientApi providers / 假模型 / cron

### 6.1 目标

| 死轨 | 处理 |
|------|------|
| `clientApi.getProviders` / `updateProviderKey` / DEFAULT_PROVIDERS | 正式路径零调用；可留 demo 或删除 |
| `fetchLatestModels` | 删除或 demo-only；模型发现走 `modelCatalog.scanProviderModels` |
| `getScheduledTasks` / CRON localStorage | 正式 Runtime/Settings **只** `workflowApi` |
| SettingsPanel 内旧 provider 表单 state/handler | 删除死代码（void 压制的一坨） |
| App.tsx 启动 `getProviders` | 删除；保留 `syncActiveProfileToEngine` |

### 6.2 保留

- `clientApi.getSettingsEx` / `saveSettingsEx`（主题、customRules 备份等）
- demo 下 MCP/plugins 若仍依赖 clientApi，用 `isDemoMode()` 门闩包住

### 6.3 子 agent 约束（§6）

```
ALLOWED: App.tsx, SettingsPanel.tsx, RuntimePanel.tsx, clientApi.ts（收缩）, 删除未用 import
FORBIDDEN: 改 providerProfiles 核心逻辑；改 workflowApi；大改 CSS
VERIFY:
  - rg "fetchLatestModels|getProviders|getScheduledTasks" 在正式路径无命中（或仅 isDemoMode 分支）
  - 设置模型页与 ModelPicker 仍可用
  - typecheck
```

---

## 7. 聊天周边：slash / Goal / 演示命令

### 7.1 Slash 菜单策略

| 命令 | 正式 | 演示 |
|------|------|------|
| `/browser` | 保留（已实现） | 保留 |
| `/skill:*` | 保留（技能注入） | 保留 |
| `/goal` `/schedule` `/learn` | **移除菜单项** 或点选后说明「请用设置/对应面板」 | 可保留文案 |
| `/simulate` 等 | 仅 demo | demo |

实现：菜单数据源按 `isDemoMode()` 过滤；**不要**让未实现命令出现在正式菜单。

### 7.2 Goal 抽屉

- 正式：`goalActive` 默认 false；不展示假 45% 进度条。
- 演示：可保留 playground。
- 禁止正式模式 toast-only 的「暂停目标」伪装引擎能力。

### 7.3 `/skill:` 与 activation 关系（文档化即可）

- 斜杠：当次强制注入正文。
- activation：影响自动 scoped-context。
- 两者并存；子 agent 不得删除斜杠「为了简化」。

### 7.4 子 agent 约束（§7）

```
ALLOWED: ChatCard.tsx slash 列表与 Goal 块显隐；少量文案
FORBIDDEN: 重构整个 ChatCard 流式逻辑；改 daemonChatBridge 事件处理
VERIFY: 正式模式 slash 无 /simulate；Goal 不默认展开
```

---

## 8. 能力门闩（可选但推荐，接在 §4～7 后）

### 8.1 目标

启动或设置打开时 `list-capabilities` 一次，缓存到轻量 store：

- MCP / workflow / scoped-context / artifacts 等
- UI 根据 state 显示「不支持 / 实验中 / 可用」

### 8.2 约束

```
FORBIDDEN: 因 capability unsupported 就隐藏核心聊天
ALLOWED: 隐藏 artifacts、fork、checkpoint restore 入口（若有）
```

---

## 9. 仓库卫生

### 9.1 删除（确认未引用后）

- `CardPanel.tsx.orig`, `CardPanel.tsx.orig_utf8`
- `diff.txt`, `diff_ansi.txt`, `diff_css.txt`
- `scripts/_patch_*.py`, `_neutralize_*.py`, `_unify_*.py`, `_rename_pi.py`（一次性脚本）
- `packages/agent-daemon/debug-output.txt`, `test-output.txt`
- 根目录噪音日志（若存在且未跟踪策略允许）

### 9.2 废弃别名

- `piClientApi.ts`：删除或保留一行 re-export 并 rg 清调用方
- `PiRuntimePanel.tsx`：改名或标注 deprecated（低优先级）

### 9.3 子 agent 约束（§9）

```
ALLOWED: 删除 junk；更新 .gitignore 忽略 debug-output
FORBIDDEN: 删除仍被 import 的源文件；git rm 用户未跟踪的重要本地配置
VERIFY: 构建/typecheck；rg 无引用已删文件
```

---

## 10. 结构拆分（契约稳定后，最后做）

> 仅在 §1～7 合并后进行，避免与行为改动同一 PR 打架。

### 10.1 建议顺序

1. SettingsPanel → 拆 `ProfileSettingsTab` / `RulesSettingsTab` / `SecuritySettingsTab` / `ScheduleSettingsTab`（已有 Models/Skills/MCP/Font）
2. ChatCard → 抽 `useSlashCommands` / `useChatSend` / Goal 子组件（行为不变）
3. clientApi 缩成 `settingsStorage.ts` + demoMocks
4. index.css 按域拆文件（theme / settings / chat / skills）——可另开专项

### 10.2 约束

```
RULE: 结构 PR 禁止改变用户可见行为（纯移动代码）
VERIFY: 行为前后截图或手工清单；typecheck；尽量无逻辑 diff
```

---

## 11. 执行顺序总表（自上而下 = 依赖序）

| 序号 | 阶段 | 主要路径 | 依赖 |
|------|------|----------|------|
| **T0** | 契约表文档落地 | `docs/…` | 无 |
| **T1** | 技能 ID + activation 对齐 | runtime export / skillsApi / tests | T0 |
| **T2** | 规则 → scoped-context | rulesApi + Settings 规则 tab | T1 的 store 惯例 |
| **T3** | MCP 诚实 UI | mcpApi + McpSettingsTab | T0 |
| **T4** | 账户/安全假控件 | SettingsPanel + layoutStore | T0 |
| **T5** | 砍 providers/cron 死轨 | App, Settings, Runtime, clientApi | T0 |
| **T6** | Slash / Goal 正式收敛 | ChatCard | T0 |
| **T7** | list-capabilities 门闩 | 小 store + 设置/面板 | T3 |
| **T8** | 仓库卫生 | junk 删除 | 任意，建议 T5 后 |
| **T9** | 结构拆分 | Settings/ChatCard | T1–T6 已合并 |

并行许可：

- T3 ∥ T4 ∥ T5 在 **不同文件集** 且不碰 skillsApi 时可并行。
- T1 与 T3 **不要** 并行改同一 Settings 导航。
- T2 依赖 upsert 惯例，建议紧随 T1。

---

## 12. 子 agent 派工模板（批准后使用）

每个子任务必须包含：

1. **阶段编号**（T1…）
2. **ALLOWED / FORBIDDEN 文件列表**（复制本文对应节）
3. **验收命令**
4. **禁止范围**（§0.3）
5. **中文写入**：使用工具写 UTF-8；提交用 `git commit -F` + UTF-8 msg 文件

### 12.1 推荐 agent 切分

| Agent | 阶段 | 隔离 |
|-------|------|------|
| A | T0 文档 | 无代码 |
| B | T1 技能 ID | worktree 可选 |
| C | T2 规则 | 在 B 合并后 |
| D | T3 MCP 诚实 | 可与 C 并行 |
| E | T4+T5 死轨与假控件 | 注意 SettingsPanel 冲突 → 与 D 串行更安全 |
| F | T6 Chat slash/goal | 可并行 |
| G | T8 卫生 | 任意时刻，避免与大 PR 同文件 |
| H | T9 拆分 | 全部行为 PR 合并后 |

### 12.2 冲突热点文件（串行）

- `SettingsPanel.tsx` — **最高冲突**；规则/假控件/死轨尽量同一 agent 或严格分块
- `clientApi.ts`
- `ChatCard.tsx`
- `skillsApi.ts`
- `index.css`（尽量少动，诚实 UI 复用现有 class）

### 12.3 回归清单（人工 / smoke）

1. 正式模式发一条消息，daemon 连通时正常流式。
2. 改模型 key → 仍能聊。
3. 设置规则 → 新会话提问是否遵守（或至少 get-scoped-context 可见）。
4. 技能启用/禁用 → 刷新列表状态保持；禁用后行为变化。
5. MCP 页空态可读。
6. 定时任务仍只显示 workflow。
7. 演示模式 mock 仍可玩（若 dev）。

---

## 13. 测试与质量门

| 层级 | 命令 |
|------|------|
| Desktop | `npm run check:desktop` |
| Daemon（若改） | `npm run check:daemon` + 相关 vitest |
| 技能 id | 新增 golden test |
| 规则 | 可选：mock daemon client 单测 rulesApi |
| 提交 | 中文 msg UTF-8；`git cat-file -p HEAD` 校验 |

---

## 14. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 技能 id 迁移丢 activation | 启动时 remap 旧 key；保留一版备份 key |
| 规则过长撑爆 context | 上限截断 + UI 提示（如 8k 字符） |
| MCP 按钮隐藏被误认为退步 | 文案解释引擎侧配置 |
| SettingsPanel 大冲突 | E 串行；或先拆 tab 再改（会打乱 T9 序，需协调） |
| 子 agent 过度重构 | FORBIDDEN 列表 + 「行为 PR 禁止纯移动」 |

回滚：各阶段独立 commit；T1/T2 以 commit 为单位 revert。

---

## 15. 非目标回顾（再次强调给子 agent）

- 不做视觉大改、密度、绿色 token、字体栈调整。
- 不把 demo mock 从 chatApi 删除（只关正式入口）。
- 不强制会话改为 daemon-only。
- 不实现真 PTY / 插件市场 / artifacts。

---

## 16. 批准检查清单（用户）

请确认后再派工：

- [ ] 规则默认 **接真**（scoped-context），不是仅文案诚实
- [ ] 技能 ID **方案 A**（与 runtime stableId 对齐）
- [ ] MCP 本阶段只做 **诚实 UI**，不做完整配置注入（4.2.2 另议）
- [ ] commandPermissions 采用 **S1 持久化**（或改为 S2）
- [ ] 执行顺序按 T0→T9，允许注明的并行

---

*文档版本：2026-07-15 · 对应审查结论：产品信任债收敛，非 redesign。*
