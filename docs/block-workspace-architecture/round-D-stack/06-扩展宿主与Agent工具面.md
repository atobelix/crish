# Round D · D6 · 扩展宿主与 Agent 工具面

| 元数据       | 值                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策单元** | D6 · TS 扩展宿主 + Agent/MCP 工具面                                                                                                                                                                                       |
| **输入**     | `13-RoundD-核心技术栈选型计划.md` · round-C `01-思源-产品交互与AI工具面.md` · round-A `02-优点-架构与扩展模型.md` · D2 `02-CRDT与合并引擎.md` · 本仓 `crates/agent-tools` · `crates/session-loop` · `packages/plugin-sdk` |
| **立场**     | 效果完整度 → 正确性/不变量 → 可验证性 → 与已锁契约一致 → 结构干净；**禁止**工期/流行度退避                                                                                                                                |
| **许可红线** | 学思源 MCP **纪律**，**不**整嵌 AGPL 实现；AFFiNE Store/View 分轨 **只学意图**                                                                                                                                            |
| **产出角色** | 只读选型论证；不改源码                                                                                                                                                                                                    |

---

## 0. 结论先行

| 项           | 裁决                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主路径**   | **双轨扩展宿主** + **单一 RS 工具面真相**：① **命令/工具扩展**（插件 `registerTool` / MCP 适配）→ 一律进入 `agent-tools::ToolRegistry`，经 `session-loop` 批执行与审批；② **块视图扩展**（TS contribute points：view / widget / keymap / slash）→ **只改投影与 chrome，不持文档权威**。笔记 mutate **唯一**经 RS 块/文档工具 → 结构化 op 事务（origin=agent/plugin）。 |
| **MCP**      | **进程内统一契约（JSON Schema + 同 registry）**；对外/插件侧保留 **stdio MCP 桥**（已有 `agent-tools::mcp`）；**禁止**「第二套笔记写路径」的 in-process MCP 旁路。                                                                                                                                                                                                     |
| **审批**     | 延续本仓三态（Allow / Deny / NeedsApproval）+ 思源形 **safeActions 白名单 × ActionEffects 四维 × Source**；红线不可豁免（对齐 `permission::decide_with_redline`）。                                                                                                                                                                                                    |
| **硬否决**   | **Agent/扩展直接改 DOM 当写路径**；扩展/插件 **直写磁盘笔记真相**；整嵌思源 `kernel/mcp` / Protyle petal；VS Code Extension Host 整进程模型作为笔记终局；全量 iframe 沙箱作**唯一**宿主（会撕裂与 session-loop 同进程工具面）。                                                                                                                                        |
| **必须自研** | 笔记域工具 schema + 事务入口、确认矩阵、origin 审计、扩展 API 权限面、块视图 contribute 注册表与「投影-only」守卫。                                                                                                                                                                                                                                                    |
| **可延续**   | `ToolRegistry` / `Tool` trait / MCP stdio 桥 / `ApprovalChannel` / plugin-sdk TrustGate / 权限模式 ask·full-access·plan。                                                                                                                                                                                                                                              |

**一句话**：

> 扩展可以丰富 **看与命令**；Agent 可以 **块级 mutate**；二者都 **不能** 绕过 Rust 心。工具面 = 思源 MCP 纪律（action 聚合 · safeActions · 领域 prompt）× 本仓 session-loop 批执行与审批矩阵。

---

## 1. 该层效果锁（不可降级）

### 1.1 用户可见

| ID      | 效果                     | 不变量                                                                               |
| ------- | ------------------------ | ------------------------------------------------------------------------------------ |
| E-D6-01 | **Agent 块级改笔记**     | 插入/更新/移动/删除块走工具；块 ID 稳定；引用不因 update 断裂                        |
| E-D6-02 | **写操作可确认**         | 危险/写 action 在 ask 模式弹审批；用户拒绝零写入；plan 模式拒绝写                    |
| E-D6-03 | **批量重构可控**         | 千次 patch 可一次会话级授权 + 预览 diff + 原子批；非「逐条点确认」疲劳，也非静默毁库 |
| E-D6-04 | **插件可扩展命令与视图** | 可注册 slash/命令/块 chrome；恶意插件不能静默改文档真相                              |
| E-D6-05 | **MCP 内外同源**         | 内置 Agent 与外部 MCP 客户端看到的笔记工具语义一致（读子集可、写同事务）             |
| E-D6-06 | **视口联动**             | Agent 可 focus_block / open_document（仅交互会话）；改完用户能看见                   |
| E-D6-07 | **失败可理解**           | 非法树/缺权限/中断未知态有错误码；中断后禁止盲目自动重试写                           |

### 1.2 架构不可见不变量

| ID      | 不变量                                                                                        |
| ------- | --------------------------------------------------------------------------------------------- |
| I-D6-01 | **扩展/Agent 不得持文档权威**；不得直改 RS 编码态、SQLite 笔记库、MD 真相文件（除经工具 API） |
| I-D6-02 | **禁止「Agent 改 DOM」** 作为 mutate 路径；DOM 仅投影；投影漂移靠 RS 事件重放收敛             |
| I-D6-03 | 所有笔记写工具最终调用 **同一事务/op apply 入口**（与 D2 工具面事务壳对齐；origin 必填）      |
| I-D6-04 | 工具定义经 **单一 `ToolRegistry`** 出站给模型；插件/MCP 并入运行集，命名防冲突                |
| I-D6-05 | 审批 **优先于** 中间件/钩子（对齐 `tool_exec.rs` 决策记录）；中间件不能吞拒绝                 |
| I-D6-06 | 写 action **禁止**与只读 action 同名（思源 safeActions 铁律）                                 |
| I-D6-07 | 文件工作区工具与 **笔记 CRUD 工具分轨**；file 不得当数据写入面（思源红线）                    |
| I-D6-08 | 许可：不嵌 AGPL；插件 API 自有契约                                                            |

### 1.3 裁判键（重申）

效果完整度 → 正确性/不变量 → 可验证性 → 与「RS 心 + TS 皮 + 已有 agent-tools/session-loop」一致 → 结构干净。
**不得**以「iframe 更安全感」「大家都 MCP 外挂」把笔记写路径拆出 RS 心。

---

## 2. 候选横评

### 2.1 候选清单

| 代号 | 候选                              | 定位一句话                                                                     |
| ---- | --------------------------------- | ------------------------------------------------------------------------------ |
| C1   | **同进程 TS 插件注册表**          | activate(api) 主线程注册 hook/tool/MCP；TrustGate 权限（本仓 plugin-sdk 现状） |
| C2   | **iframe / Worker 沙箱宿主**      | 扩展跑隔离上下文，经 postMessage/RPC 调宿主                                    |
| C3   | **VS Code 式 contribute points**  | package.json/manifest 声明 commands/views/menus；运行时激活贡献点              |
| C4   | **MCP server in-process**         | 笔记能力以 MCP Server 对象嵌在宿主进程，JSON-RPC 本地短路                      |
| C5   | **JSON-RPC tools（无 MCP 包装）** | 自研 RPC 面；工具 schema 自管；不强制 MCP 协议                                 |
| C6   | **审批 / safeActions 矩阵**       | 思源形：只读白名单 + Effect 四维 + Source 默认危险（机制，非完整宿主）         |
| C7   | **块视图扩展 vs 命令扩展分轨**    | AFFiNE Store/View 意图：数据扩展 vs 渲染/chrome 扩展双 Manager                 |

> 终局是 **组合**，不是单选：C1∩C3∩C6∩C7 + 对内 C5 契约 / 对外 C4 桥，并 **拒绝 C2 作唯一宿主**。

### 2.2 总表（上限 / 不变量 / 与 RS 真相 / 与本仓对齐 / 可验证）

图例：`◎` 强匹配 · `○` 可达有洞 · `△` 明显短板 · `×` 与硬锁互斥。

| 维度                    | C1 同进程注册表         | C2 iframe/Worker          | C3 contribute points             | C4 MCP in-process     | C5 JSON-RPC tools   | C6 safeActions 矩阵 | C7 视图/命令分轨     |
| ----------------------- | ----------------------- | ------------------------- | -------------------------------- | --------------------- | ------------------- | ------------------- | -------------------- |
| Agent 块级 mutate 上限  | ◎（注册即进 registry）  | △（多跳延迟/批难）        | ○（声明命令，执行仍靠 registry） | ◎（若绑同一事务）     | ◎                   | ◎（安全维）         | ○（视图轨无 mutate） |
| 不绕过 RS 真相          | ○（靠 API 纪律+守卫）   | ○（边界清晰但可误开直写） | ◎（贡献点无写盘）                | ○（易长出第二写路径） | ◎（单一入口易强制） | ◎                   | ◎（视图轨禁写）      |
| 与 session-loop 批/审批 | ◎ 已接线                | △ 需重做桥                | ○                                | ○ 需适配 Tool trait   | ◎                   | ◎                   | n/a                  |
| 恶意扩展面              | △ 同进程需强制权限      | ◎ 隔离强                  | ◎ 声明式减攻击面                 | △ 工具过宽=攻击面     | ○                   | ◎                   | ◎ 分轨降权           |
| 块 chrome / slash 扩展  | ○ 可加 API              | ○                         | ◎ 本职                           | × 非 UI 面            | ×                   | n/a                 | ◎                    |
| 生态 MCP 互通           | ○（stdio 桥）           | △                         | n/a                              | ◎                     | △ 需适配层          | n/a                 | n/a                  |
| 许可/AGPL 风险          | ◎ 自研                  | ◎                         | ◎ 学 VS Code 意图                | ◎ 协议非实现          | ◎                   | ◎ 学纪律            | ◎ 学意图             |
| 可验证钉法              | 单测 TrustGate+registry | e2e 沙箱逃逸              | 清单断言 contribute              | 契约测试 tools/list   | schema 黄金夹具     | 表驱动矩阵测试      | 双轨 API 类型锁      |

### 2.3 分项要点

#### C1 同进程 TS 插件注册表

- **现状**：`packages/plugin-sdk` 已有 `PluginAPI.registerTool` / `registerMcpServer` / hooks + TrustGate（restricted/full）；RS 侧 `ToolRegistry::register_runtime`、`mcp::register_plugin_server`。
- **上限**：与 Agent 心同进程，工具批、幂等、审批零拷贝对齐。
- **洞**：主线程恶意代码可扫内存/调未暴露 invoke——**必须**把「笔记写」收敛到 **唯一 invoke 面** 且前端无第二写入口；full 信任仅 user-dir（已有防 project-dir 投毒）。

#### C2 iframe / Worker 沙箱

- **优点**：恶意扩展默认隔离；适合不可信第三方 UI gadget。
- **结构洞**：笔记 Agent 工具需要与 `session-loop` 批、abort、审批门、写路径互斥 **同事务语义**；跨沙箱批处理会复制一套 RPC 状态机，易出现「审批已过但沙箱侧重放」「中断未知态双份」。
- **裁决**：**可选**用于「不可信块视图 iframe 挂件」；**不得**作为 Agent 工具宿主主路径。

#### C3 VS Code 式 contribute points

- **学什么**：manifest 声明 `commands` / `menus` / `views` / `slashItems` / `blockViews`；激活时只注册贡献，**执行**走统一 command 总线。
- **不学什么**：整套 Extension Host 多进程、VS Code API 海洋、webviews 当文档编辑器。
- **与 C7**：contribute points 是 **声明层**；Store/View 分轨是 **能力层**。

#### C4 MCP server in-process

- **思源**：原生工具注册表 + MCP HTTP 暴露 + Agent 共用 `GetAllTools()`。
- **本仓已有**：stdio **客户端**桥（外挂 MCP → 本地 Tool）；缺的是 **笔记域原生工具** 与可选 **对外 MCP server**。
- **风险**：再开一条 `tools/call` 直接写库，绕过 session-loop 中间件/配额/写路径互斥。
- **裁决**：MCP 是 **协议外壳**；执行内核必须是 `ToolRegistry` + 同一 executor。

#### C5 JSON-RPC tools

- Tauri invoke / 内部事件已是类 RPC；工具入参出参用 JSON Schema（`ToolDefinition.input_schema`）。
- **对内**：不必强制完整 MCP 帧；**对外**：MCP 适配器翻译 `tools/list|call`。
- 与 provider 工具定义（camelCase `inputSchema`）已对齐——延续。

#### C6 审批 / safeActions 矩阵

- **思源**：`safeActions` 白名单；`ActionEffects`：LocalRead / LocalWrite / DataEgress / ExternalCost；外部 Source 默认确认；写前快照；取消 → executionUnknown 禁重试。
- **本仓**：`PermissionMode`（ask / full-access / plan）× `dangerous` / `requires_approval` × 红线 Deny；`ApprovalChannel` → `approval-requested` 事件。
- **合并方向**：在 **action 级** 补 safeActions + effects（工具多 verb 时 dangerous 布尔不够细）；会话级「批量写授权」补思源短板。

#### C7 块视图 vs 命令扩展分轨（AFFiNE 意图）

| 轨                  | 可做                                                      | 禁止                                          |
| ------------------- | --------------------------------------------------------- | --------------------------------------------- |
| **View 轨**         | block view 组件、widget、keymap、slash UI、outline chrome | 直接 mutate 块树；持 Y.Doc/RS Doc；写文件真相 |
| **Command/Tool 轨** | 注册 Tool / Command → RS invoke / ToolRegistry            | 在 handler 里 `element.innerHTML=…` 冒充保存  |

Store 侧「schema 扩展」若未来开放自定义块类型，仍须 **RS schema 注册 + 校验**，TS 只声明镜像。

---

## 3. 调包边界（可依赖的公开 API 面）

| 可依赖                                                                                                         | 用途                        | 不可依赖成「真相」                   |
| -------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------ |
| **JSON Schema** 描述工具入参                                                                                   | LLM function calling / 校验 | 业务语义                             |
| **MCP 协议形状**（tools/list、tools/call、stdio/HTTP 传输）                                                    | 生态互通                    | 思源/他仓 **实现代码**               |
| 本仓 **`agent-tools`**：`Tool` / `ToolDefinition` / `ToolRegistry` / `execute_with_output_policy` / MCP bridge | 执行与注册                  | —                                    |
| 本仓 **`session-loop`**：tool batch、`ApprovalChannel`、权限三态                                               | Agent 运行时                | —                                    |
| 本仓 **`plugin-sdk`**：manifest、TrustGate、PluginAPI                                                          | 扩展激活                    | —                                    |
| 本仓 **事件契约** `conex-types` / `engine-events.json`                                                         | approval-requested 等       | 私自加旁路事件当写完成               |
| Tauri **invoke** 作为 TS→RS 命令总线                                                                           | 人机 UI 与投影请求          | 插件动态拼任意 invoke 名（须白名单） |
| （可选）轻量 **iframe** 仅挂件 UI                                                                              | 不可信视图                  | Agent 工具执行                       |

**禁止依赖**：思源 `kernel/mcp`、`kernel/agent` 源码；BlockSuite 整包当宿主；VS Code extension API 运行时。

---

## 4. 必须自研（禁止用包顶替）

1. **笔记域工具集**（block / document / notebook / search / outline / ref / attr / …）及 **action 语义**（update ≠ append；pin 块 ID）。
2. **统一 mutate 入口**：工具 → RS 事务/op apply（D2 壳）；`origin`、`batch_id`、幂等键。
3. **确认矩阵**：safeActions × ActionEffects × Source × PermissionMode × 会话级批量授权。
4. **扩展 API 最小面** + 权限枚举扩展（见 §5）+ contribute 注册表。
5. **投影-only 守卫**：视图扩展无 `applyOp`；测试锁定「DOM 写不触发持久化」。
6. **领域 system prompt 片段**：容器/叶子、标题 sibling 或本产品树模型、禁止捏造 ID、file 红线（学思源契约，自写文案）。
7. **审计与快照策略**：写前 checkpoint（可与 session checkpoint 合流）；中断 → 明确 `execution_unknown`，写路径不自动重试。
8. **对外 MCP server**（若产品需要）：薄适配，内部仍调同一 Tool 执行器 + Admin/只读中间件语义。

---

## 5. 扩展 API 面最小集

### 5.1 设计原则

- **小**：能注册与订阅，不能拿到「内核句柄」。
- **声明优先**：manifest 列出 tools/hooks/contributes；运行时超声明 → 拒绝。
- **双轨**：View API 与 Tool API 类型分家，避免一个 `api` 上帝对象误导插件作者写 DOM 存档。

### 5.2 Manifest / Contribute points（草案）

```jsonc
{
  "id": "@vendor/note-helpers",
  "trustLevel": "restricted", // restricted | full(仅 user-dir)
  "permissions": [
    "tool:register",
    "hook:observe",
    "ui:contribute",
    "note:read", // 新增：只读笔记投影/查询
    // "note:write"    // 新增：允许注册「会写笔记」的工具（仍走审批）
  ],
  "declaredTools": ["vendor.summarize_selection"],
  "declaredHooks": ["tool.pre"],
  "contributes": {
    "slashItems": [{ "id": "vendor.cite", "title": "插入引用" }],
    "blockViews": [
      { "flavour": "vendor.callout", "tag": "vendor-callout-view" },
    ],
    "commands": [{ "id": "vendor.toggle-callout", "title": "切换 Callout" }],
    "widgets": [{ "id": "vendor.gutter-badge", "anchor": "block-gutter" }],
  },
}
```

### 5.3 运行时 API 最小集

| API                                                           | 轨      | 权限                              | 行为                                                                                                                                      |
| ------------------------------------------------------------- | ------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `registerTool(def, handler)`                                  | Command | `tool:register` + 声明名          | handler 仅收 JSON；写笔记须再调 **宿主笔记工具** 或标记 `effects: localWrite` 并由宿主执行 RS 路径——**插件 handler 内禁止 fs 写笔记路径** |
| `registerMcpServer(decl)`                                     | Command | `mcp:connect`                     | 现状：stdio 外挂；工具名 `mcp_<server>__<tool>`                                                                                           |
| `observe` / `on` hooks                                        | Command | `hook:observe` / `hook:intercept` | 对齐现网；intercept 不可绕过审批                                                                                                          |
| `getSessionContext()`                                         | —       | `session:read`                    | 只读快照                                                                                                                                  |
| `commands.register(id, run)`                                  | Command | `ui:contribute`                   | run 只发 **意图**（invoke 白名单 command）                                                                                                |
| `slash.register` / `widgets.register` / `blockViews.register` | View    | `ui:contribute`                   | 注册 UI；数据经 props/投影 store **只读**                                                                                                 |
| `workspace.openDocument` / `focusBlock`                       | View/UX | `ui:navigate`                     | 视口；不写内容                                                                                                                            |
| `note.query` / `note.getBlock`（可选薄封装）                  | 只读    | `note:read`                       | 背后 RS 读工具；结果只读                                                                                                                  |
| **不提供**                                                    | —       | —                                 | `document.execCommand` 包装、`getRootElement().innerHTML`、直接 `invoke('db_write')`、任意 SQL 写                                         |

### 5.4 权限模型（合并本仓 + 笔记域）

#### 插件信任

| 级别         | 来源约束               | 行为                                                   |
| ------------ | ---------------------- | ------------------------------------------------------ |
| `restricted` | user-dir / project-dir | TrustGate 强制 permissions                             |
| `full`       | **仅 user-dir**        | 跳过细权限（已有）；**仍不能**绕过 RS 笔记写入口与红线 |

#### 权限字面量（在现有 11 项上增量）

| 权限                     | 含义                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 既有                     | `file:access` `tool:execute` `tool:register` `mcp:connect` `network:connect` `session:read` `session:write` `env:read` `hook:observe` `hook:intercept` `plugin:manage` |
| **新增** `ui:contribute` | slash/widget/blockView/command 贡献                                                                                                                                    |
| **新增** `ui:navigate`   | 打开文档/聚焦块                                                                                                                                                        |
| **新增** `note:read`     | 读块/文档/搜索（只读工具）                                                                                                                                             |
| **新增** `note:write`    | 注册或调用笔记写工具（仍进审批矩阵）                                                                                                                                   |

#### Agent / 工具执行权限模式（会话级，已有）

| 模式          | 只读 action | 写 action / dangerous             | 红线                 |
| ------------- | ----------- | --------------------------------- | -------------------- |
| `plan`        | Allow       | **Deny**                          | Deny                 |
| `ask`         | Allow       | **NeedsApproval**                 | Deny                 |
| `full-access` | Allow       | Allow（**会话级批量授权可收窄**） | **Deny**（不可豁免） |

#### Action 级矩阵（学思源，落本仓）

| 输入                                           | 输出                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| action ∈ `safeActions` 且 effects 仅 LocalRead | 任意模式 Allow（plan 亦然）                                   |
| LocalWrite / 未列 safe                         | ask→NeedsApproval；plan→Deny；full→Allow 或需「批量写 token」 |
| DataEgress / ExternalCost                      | 默认 NeedsApproval；标注计费/出站                             |
| Source = 外部 MCP / 插件且 effects 未知        | 默认 NeedsApproval                                            |
| 写 action 名与只读 action 撞名                 | **注册期拒绝**                                                |

#### 会话级批量写授权（相对思源的增强）

- 用户确认「本 run 允许笔记写」或「允许本批 N 个 block.* 写」→ 签发 **scoped token**（run_id + 工具前缀 + 过期 + 最大写次数）。
- full-access 可默认带 token；ask 模式首次写申请 token，避免千次弹窗。
- token **不**豁免红线、path escape、schema 非法。

---

## 6. 工具 schema 列表草案

> 形状：单工具多 `action`（思源友好）或 verb 拆工具（等价）；下表按 **逻辑工具** 列。
> 实现落点：RS `agent-tools` 原生 Tool + `input_schema`；出站 camelCase。

### 6.1 内容核心

| 工具名                 | 主要 actions                                                                                                                               | dangerous / effects                  | 说明                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------- |
| **notebook**           | list, create, rename, delete, set_meta                                                                                                     | create/rename/delete → LocalWrite    | 工作区笔记本                                                          |
| **document**           | get, create, list, delete, rename, move, duplicate, search_docs, info                                                                      | 写类 LocalWrite                      | 人类路径 hPath；与块 ID 分离                                          |
| **block**              | get, get_md, get_children, tree_stat, insert, append, prepend, **update**, delete, move, fold, unfold, breadcrumb, batch_get, batch_get_md | 写类 LocalWrite；读类 safe           | **update = 单块替换不追加**；写默认单资源；读可 batch                 |
| **block_batch**        | apply_ops                                                                                                                                  | LocalWrite + 需 batch token          | **一等**批量：ops[] + 可选 dry_run/diff；原子；补思源 MCP 无 batch 写 |
| **outline**            | get                                                                                                                                        | safe                                 | 标题树                                                                |
| **attr**               | get, set, batch_get                                                                                                                        | set → LocalWrite                     | 块属性                                                                |
| **ref**                | backlinks, mentions, refresh                                                                                                               | refresh 可写索引副作用（标 effects） | 反链/提及                                                             |
| **dailynote**          | ensure, append, prepend                                                                                                                    | LocalWrite                           | 避免误用 document.create                                              |
| **tag** / **bookmark** | list, set…                                                                                                                                 | 视 action                            | 元数据                                                                |

### 6.2 搜索与历史

| 工具名          | actions                              | effects 要点                         |
| --------------- | ------------------------------------ | ------------------------------------ |
| **search**      | fulltext, (optional) semantic, asset | semantic → DataEgress + ExternalCost |
| **history**     | list, get, rollback                  | rollback → LocalWrite + 强确认       |
| **sql**（可选） | query                                | **只读**；默认关闭或 plan 禁用；限流 |

### 6.3 Agent 元工具与 UX

| 工具名         | 作用                                    | 备注                                   |
| -------------- | --------------------------------------- | -------------------------------------- |
| **question**   | 结构化提问用户                          | 对齐本仓 ask / 前端表单                |
| **todo_write** | 会话任务清单                            | 会话态，非笔记对象（可另建任务块产品） |
| **frontend**   | open_document, focus_block, open_search | **仅交互 Agent**；无头调用报错         |
| **skill**      | 技能/提示扩展                           | 已有 skill→Tool 路径可挂               |

### 6.4 工作区文件（分轨红线）

| 工具名                  | 说明                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| **file** / 既有 fs 工具 | 工作区源码/日志；Description **禁止**当笔记数据面；笔记 CRUD 只用 block/document |

### 6.5 `block` 入参骨架（示意）

```json
{
  "type": "object",
  "required": ["action"],
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "get",
        "get_md",
        "get_children",
        "tree_stat",
        "breadcrumb",
        "batch_get",
        "batch_get_md",
        "insert",
        "append",
        "prepend",
        "update",
        "delete",
        "move",
        "fold",
        "unfold"
      ]
    },
    "id": {
      "type": "string",
      "description": "块 ID；禁止模型捏造未检索到的 ID"
    },
    "parentId": { "type": "string" },
    "previousId": { "type": "string", "description": "插入锚点：前序兄弟" },
    "content": {
      "type": "string",
      "description": "MD/契约子集；update 为整块替换"
    },
    "ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "仅 batch 读"
    }
  }
}
```

### 6.6 `block_batch.apply_ops` 骨架（示意）

```json
{
  "type": "object",
  "required": ["ops"],
  "properties": {
    "ops": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["op"],
        "properties": {
          "op": { "enum": ["insert", "update", "delete", "move", "set_attr"] },
          "id": { "type": "string" },
          "parentId": { "type": "string" },
          "previousId": { "type": "string" },
          "content": { "type": "string" },
          "attrs": { "type": "object" }
        }
      }
    },
    "dryRun": { "type": "boolean", "default": false },
    "batchId": { "type": "string", "description": "幂等键" }
  }
}
```

---

## 7. 与 invoke / 事件的接线

### 7.1 数据流（单一写锥）

```
LLM / 插件 Tool handler / 外部 MCP tools/call
        │
        ▼
 ToolRegistry.get(name)          ← 插件 register_runtime / MCP adapter / 原生笔记工具
        │
        ▼
 session-loop ToolExecutor 批
   1) permission decide (+ safeActions/effects/redline)
   2) ApprovalChannel → 事件 approval-requested → UI 裁决
   3) middleware before（不可绕过审批）
   4) tool.execute
        │
        ▼  笔记写工具内部唯一出口
 RS note mutate API（事务/op apply，origin=agent|plugin|user）
        │
        ▼
 编码态 + 索引侧车 + 事件：blocks-changed / doc-updated / tool-end
        │
        ▼
 TS 投影层 apply 投影事件（D1/D5）；DOM 只跟随
```

### 7.2 invoke 分层

| 层                  | 谁调用            | 例子                                   | 是否写真相       |
| ------------------- | ----------------- | -------------------------------------- | ---------------- |
| **UI 命令**         | 编辑器快捷键/菜单 | `note.apply_local_edit`（用户击键 op） | 是，origin=user  |
| **Agent 工具**      | session-loop      | `block` / `block_batch`                | 是，origin=agent |
| **投影只读**        | 前端/视图扩展     | `note.get_window` / `search.fulltext`  | 否               |
| **插件 contribute** | 插件 command      | 只允许映射到 **白名单 command id**     | 间接，经上表     |

插件 **不得** 动态 `invoke(arbitrary)`；Loader 注入的 `host.invoke` 为 **allowlist proxy**。

### 7.3 关键事件（与现网对齐）

| 事件                                                 | 用途                           |
| ---------------------------------------------------- | ------------------------------ |
| `tool-start` / `tool-end` / progress                 | 工具生命周期                   |
| `approval-requested` / 裁决                          | 写确认；先发后等防死锁（既有） |
| `blocks-changed` / `doc-updated`（笔记域新增或映射） | 投影刷新；**非**插件写入口     |
| runtime-error                                        | 插件违规、schema 失败          |

### 7.4 否决：「Agent 改 DOM」

| 反模式                                         | 为何否决                                       | 正确替代                            |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------- |
| Agent 输出 HTML，前端 `innerHTML` 插入当保存   | 绕过块 ID/schema/索引/协同；IME/选区与权威分裂 | `block.insert/update` + MD/契约子集 |
| 扩展监听 input 直接改 contenteditable 并当真相 | 与 D1「呈现不持权威」、D2「RS merge」冲突      | 发 local op 意图 → RS               |
| 用 browser eval 改 WebView DOM「修数据」       | 不可回放、不可审计、不可协同                   | 工具面 + 事务                       |
| 前端 AI 写（思源遗留 slash AI）与内核双轨      | 心智分裂；一轨易漏确认                         | **单轨**内核工具；前端只触发 run    |

**验收钉**：任何「仅 DOM 突变」路径在集成测试中 **不得** 增加持久化版本号 / op 日志。

---

## 8. 否决路径（结构洞，非工期）

| 路径                                         | 否决原因                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent/插件 **直写** `.md` / DB / CRDT 编码态 | 撕裂索引、块 ID、权限、origin                                                                       |
| **Agent 改 DOM** 当 mutate                   | 见 §7.4；与效果锁 E-D6-01/I-D6-02 互斥                                                              |
| 整嵌思源 MCP/Agent **源码**                  | AGPL                                                                                                |
| 以 **iframe 为唯一** 扩展+工具宿主           | 批执行/审批/abort 与 session-loop 双状态机                                                          |
| **第二套** in-process MCP 写库               | 旁路 middleware、配额、写路径互斥                                                                   |
| 插件 `full` + project-dir                    | 已否；仓库投毒                                                                                      |
| 写 action 与只读 **同名**                    | 确认矩阵可被骗过                                                                                    |
| file 工具写笔记数据                          | 索引与引用不变量崩溃                                                                                |
| 只做 HTTP 全量 batch、MCP 无写               | 可；但 **内置 Agent 必须有** 可控 batch 写（block_batch）——不可用「思源也没有」砍掉 AI 工作栈差异化 |

---

## 9. 推荐主路径 + 备选 + 迁移触发

### 9.1 主路径（锁定组合）

```
[扩展宿主]
  View 轨：contribute points（slash/widget/blockView/keymap）— 投影 only
  Command 轨：同进程 plugin-sdk 注册表 + TrustGate
  可选：不可信挂件 iframe（仅 View，无 Tool 执行）

[工具面]
  原生笔记工具（RS）∈ ToolRegistry
  插件 tool / 外挂 MCP → 适配为 Tool trait 并入同一 registry
  执行：session-loop 批 + 权限三态 + safeActions/effects + 批量写 token
  对外 MCP server（可选）= 薄壳 → 同一执行器

[真相]
  仅 RS 事务/op；origin 审计；事件驱动投影
```

### 9.2 强备选

| 备选                                   | 何时启用                                            |
| -------------------------------------- | --------------------------------------------------- |
| 插件 Tool handler 迁到 **Worker**      | 不可信插件需 CPU 隔离且已证明 RPC 批/审批不变量可测 |
| 笔记读工具 **HTTP/MCP 对外** 默认只读  | 多客户端；写仍 Admin + 确认                         |
| 自定义块 flavour 的 **RS schema 插件** | 产品要第三方块类型；仍非 JS 权威                    |

### 9.3 迁移触发（仅不变量被破坏时）

- 同进程插件出现 **无法用 allowlist invoke + 权限** 堵住的系统性逃逸 → 评估 Worker 分轨（**工具执行仍可在宿主**）。
- 批工具调用无法满足 E-D6-03 → 强化 `block_batch` + token，**不是**改回 DOM 写。
- 与外部生态必须双栈 → 加 MCP server 壳，**不**复制写逻辑。

---

## 10. 与竞品机制对照

| 机制       | 思源                      | AFFiNE/BlockSuite   | 本仓主路径                            |
| ---------- | ------------------------- | ------------------- | ------------------------------------- |
| 工具注册   | MCP Registry + Agent 共用 | 非 PKM-Agent 主战场 | `ToolRegistry` 一统                   |
| 写路径     | `PerformTransactions`     | Store/Y 真相当写    | **RS op/事务**（D2）                  |
| 确认       | safeActions + UI + 快照   | n/a                 | 三态权限 + effects + 批量 token       |
| 扩展       | petal 插件（AGPL 生态）   | Store/View DI 扩展  | plugin-sdk + contribute；学意图不嵌包 |
| 块级 Agent | 一等 MCP `block`          | 弱                  | **一等** + **block_batch` 增强**      |
| file 隔离  | prompt 纪律               | n/a                 | 工具分轨 + 描述 + 测试                |
| 许可       | AGPL                      | 多包                | 自研契约，无 AGPL                     |

---

## 11. 验收（魔鬼用例）

### 11.1 恶意扩展

| #   | 场景                                               | 期望                                    |
| --- | -------------------------------------------------- | --------------------------------------- |
| M1  | 插件未声明 `note:write` 调用写块                   | 注册或执行拒绝；零持久化                |
| M2  | 插件 `innerHTML` 改编辑器                          | 重启/重载投影后内容恢复权威；版本号不变 |
| M3  | 插件 `invoke('raw_sql_write')`                     | allowlist 拒绝                          |
| M4  | project-dir 声明 `trustLevel: full`                | manifest 校验失败                       |
| M5  | 插件注册未在 `declaredTools` 的工具名              | 前置校验抛错                            |
| M6  | restricted 缺 `mcp:connect` 调 `registerMcpServer` | 拒绝（既有 trust-gate 测可对齐）        |
| M7  | 视图扩展尝试 `applyOp`                             | API 不存在或类型/运行时拒绝             |

### 11.2 批量工具调用

| #   | 场景                                                | 期望                                                           |
| --- | --------------------------------------------------- | -------------------------------------------------------------- |
| B1  | 1000× `block.update` 无 token（ask）                | 首次 NeedsApproval；拒绝后全部不写或仅已授权部分策略显式       |
| B2  | 签发 batch token 后 `block_batch.apply_ops` 1000 op | 单事务成功；中断 → 全有或全无（原子）；幂等 batchId 重放不双写 |
| B3  | dryRun=true                                         | 返回 diff；零写入                                              |
| B4  | 非法父/列表嵌套                                     | schema 失败；批失败；无半树                                    |
| B5  | 并行批 + 写路径互斥                                 | 同文档冲突串行或明确 `write_path_conflict`                     |
| B6  | abort 于执行中                                      | 已完成结果可查；未执行 cancelled；**禁止**自动重试写           |
| B7  | 模型把 update 当 append                             | 契约测：update 后子块/后续兄弟不被错误吞并；Description 锁     |

### 11.3 确认矩阵

| #   | 模式 × action                          | 期望 verdict                                 |
| --- | -------------------------------------- | -------------------------------------------- |
| A1  | plan × `block.get`                     | Allow                                        |
| A2  | plan × `block.update`                  | Deny，无弹窗                                 |
| A3  | ask × `block.update`                   | NeedsApproval；拒 → 零写                     |
| A4  | ask × `search.fulltext`                | Allow（safe）                                |
| A5  | ask × `search.semantic`（Egress）      | NeedsApproval                                |
| A6  | full-access × `block.delete`           | Allow（或要 token 视策略）；红线仍 Deny      |
| A7  | 外部 MCP 未知工具                      | 默认 NeedsApproval                           |
| A8  | 中间件 before 想「放行」已 Deny 的调用 | 不可达（审批优先）                           |
| A9  | 写 action 注册为名 `get`               | 注册失败                                     |
| A10 | 子代理申请写                           | 裁决者链路对齐 T-D-14；主 agent/用户策略显式 |

### 11.4 回归钉（与本仓模块）

- `agent-tools`：笔记工具 dual 注册不与 `mcp_*` 撞名；definition 含 effects 元数据可测。
- `session-loop`：批事件序 `tool-start → approval-requested → tool-end`。
- `plugin-sdk`：权限枚举扩展后 validateManifest / trust-gate 测试更新。
- 契约：`engine-events` 若增笔记事件，registry_drift 测锁。

---

## 12. 与 D2/D1/D3 接口契约（依赖边）

| 依赖         | 契约                                                       |
| ------------ | ---------------------------------------------------------- |
| → D2         | 工具 mutate = 结构化 op 批；`origin`；原子；可回放         |
| → D3         | `get_md` / `update` content = MD/AST 契约子集，非任意 HTML |
| → D1/D5      | 工具成功 → 投影事件；选区/IME 不由工具直接操作 DOM         |
| ← 本仓 Agent | 工具列表进 provider；dangerous/effects 进审批              |

---

## 13. 实施切片（逻辑单元，非排期）

1. **RS 笔记读工具**（block/document/search/outline）+ schema 黄金夹具。
2. **RS 笔记写工具** + 事务入口 + origin + 单测非法树。
3. **safeActions/effects** 接入 permission 判定（action 级）。
4. **block_batch + dryRun + batch token**。
5. **plugin contribute points**（View）+ invoke allowlist。
6. **frontend 视口工具** + 领域 system prompt 片段。
7. （可选）对外 MCP server 薄壳 + Admin 鉴权语义。

每片验收引用 §11 对应行，禁止「先 DOM 后迁」。

---

## 14. 一句话收束

> **同进程插件注册表 + contribute 分轨视图** 做扩展宿主；**统一 ToolRegistry + session-loop 审批 + 思源形 safeActions/effects** 做 Agent/MCP 工具面；**块级 mutate 一等且可批**；**真相只在 Rust**；**Agent 改 DOM 永不进终局**。

---

_文档结束。Round D · D6 选型论证；UTF-8；未改业务源码。_
