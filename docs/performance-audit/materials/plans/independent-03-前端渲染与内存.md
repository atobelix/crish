# independent-03 · 前端渲染与内存 · 独立完整修复总计划

> **战役**：performance-audit → performance-fix  
> **性质**：独立总案（不与其他并行总案对齐，不抄主控 91 草稿；可推翻 91 取舍）  
> **主视角**：前端渲染与内存——流式增量化、卡片 memo、虚拟化 Hooks、persist 物理切除、消息驱逐、终端隐藏存活、Diff worker、合成层  
> **创建**：2026-09-13  
> **输入（只读）**：90-发现清单索引、01/02/08/12 报告、useStreamingBlocks / 卡片链 / MessageVirtualizer / sessionStore persist / 终端生命周期代码  
> **对照**：`91-系统性修复总方案.md`——本方案独立成文，§8 列出与 91 的分歧与推翻点  
> **原则**：纯逻辑依赖序；不谈工期、人员、业务优先级；问题同权  
> **禁止**：git commit；「加 memo 但 props 仍新对象」的伪收敛；保留 LS 兼容读

---

## 0. 全局效果与目标态

### 0.1 问题域一句话

前端「热缓冲已建、持久域已迁 SQLite」的架构骨架是健康的；系统性病灶在于 **增量设施被当一次性 API、装配层引用稳定性失守、双持久化出口未拆、消息/工具输出跨层无界驻留、隐藏终端与 Diff/合成层走旁路重路径**——修复方向是 **路径收敛 + 物理切除 + 预算对齐**，不是再加缓存层。

### 0.2 渲染路径收敛（现状 → 目标）

| 概念 | 现状路径数 | 收敛后 | 说明 |
| ---- | ---------- | ------ | ---- |
| 流式块切分 | 2（实例 API + 静态全量 `split()` 当热路径） | **1**（实例增量 `appendChunk` 唯一热路径；全量仅冷启动/回放） | 01-H1 |
| 封口块哈希 | 每帧全文 FNV + 缓存命中判定 | **封口瞬间一次**，跨帧引用/哈希稳定 | 01-H2 |
| 流式正文 DOM 写 | 尾块 textContent（正）+ 多组件重复 strip/派生 | **单入口 strip**（同帧共享），尾块直写保留 | 01-M3/M5 |
| 会话正文持久化出口 | **2**（zustand persist 全量 LS + initStorePersistence→SQLite） | **1**（SQLite）；LS 只留索引壳且正文永不再写 | 08-H1 |
| 工具输出拷贝 | store 全文 + 展示层截断拷贝 + 可选 snapshot 副本 | **store hardCap 截断后单份 + 展示引用** | 08-H3/M1 |
| 卡片展开状态 | 列表级 `expandedTools` 单对象 → 全卡 reconcile | **per-message 粒度** + 稳定 props | 02-T1 |
| 卡片 memo 边界 | 8 核心组件无 memo / props 新对象 | **链上每级 memo + 比较器 + 稳定化 props** | 02-T2 |
| 流式文本注入 | `streamingTextContent` 注入**每张**卡 | **仅活跃尾消息**注入；非活跃卡 0 流式 prop | 02-T3 |
| Diff 高亮 | 主线程同步 `highlightCode` ×N 行 | **worker batch 一次预计算**（已有通道） | 12-D1 |
| 终端隐藏写 | display:none 仍 `term.write` | **暂停 write + history 降采样 + 显现重放** | 02-X1 |
| 合成层 will-change | 逐词常驻 + 布局属性滥用 | **瞬态/删除**；布局属性零 will-change | 12-W1/W2/W3 |

### 0.3 目标不变量（本方案验收锚）

| ID | 不变量 |
| -- | ------ |
| FE-INV-1 | 流式期每帧派生：仅活跃尾块 O(delta)；封口块与历史消息 **0 重渲染 / 0 全文哈希** |
| FE-INV-2 | 对废弃 persist 全量 `sessions` **0 读 0 写**；LS 键 `crish_session_store` 中正文字段 **不存在** |
| FE-INV-3 | 已水合且非活跃、非流式的消息数组：常驻会话数 ≤ K（预算常量），其余 `messages: []` + 可懒水合 |
| FE-INV-4 | 工具输出 store 侧长度 ≤ `TOOL_OUTPUT_STORE_HARD_CAP`（与展示 cap 同源常量） |
| FE-INV-5 | 单卡展开 / 单卡收起：其余消息行 **渲染计数 = 0** |
| FE-INV-6 | 流式帧：非活跃消息行渲染计数 = 0；user 行流式期渲染计数 = 0 |
| FE-INV-7 | 隐藏终端标签：`term.write` 调用 = 0；活跃 tab write 正常 |
| FE-INV-8 | Diff 展开：主线程无同步 `highlightCode` 调用栈（走 worker / 一次异步预计算） |
| FE-INV-9 | 预算数字只出现在 `perfBudgets.ts`（及 re-export）；业务代码零散落魔数 |
| FE-INV-10 | 与 Rust 工具输出预算同常量语义（前端 hardCap = 壳/引擎 output_budget 同源） |

---

## 1. 维度划分（逻辑域）

> 维度是领域概念切分，不是执行批次。每维内仍含「删什么」。

| 维度 | 领域概念 | 核心发现（90 前缀） |
| ---- | -------- | ------------------- |
| D1 | 流式切分与派生热路径 | 01-H1/H2/M3/M4/M5/M8、01-L1 |
| D2 | 虚拟化 Hooks 与装配层稳定 | 01-H3/H4/M1/M2/M6、02-C1/C2 |
| D3 | 卡片链 memo 与展开粒度 | 02-T1/T2/T3/T4/T5/T6/T7、01-M10 |
| D4 | 持久化物理切除（LS 孤岛） | 08-H1/H4、01-M9、08-M5 |
| D5 | 消息/快照/工具输出驱逐与预算 | 08-H2/H3/H5/H6/M1/M8/M10、08-M6 |
| D6 | 终端隐藏存活与 PTY 内存账 | 02-X1/X2/X3/X4/X5/X8、08-M2/M7 |
| D7 | Diff worker 接线 | 12-D1、12-S2、02-T8 |
| D8 | 合成层与流式 CSS | 12-W1/W2/W3/T1/B1/A1/A2 |
| D9 | 编辑器实例与虚拟窗边界 | 02-E1/E2/E4 |
| D10 | 预算 SSOT 与 Rust 对齐接口 | 08-H3、03-R6、10-T4 交叉；FE-INV-9/10 |
| D11 | 防御脚本与守护测试 | 全维负向；01 reRenderMonitoring、08 persist 测试 |

---

## 2. 依赖与逻辑顺序

```text
D10 预算 SSOT（前端 perfBudgets + 与 Rust 同语义）
    │
    ├─► D4 persist 物理切除（LS 孤岛删除，不依赖渲染）
    │       │
    │       └─► D5 驱逐与 hardCap（写入路径接预算）
    │
    ├─► D1 流式增量化（独立，不依赖传输契约）
    │       │
    │       └─► D3 卡片链（依赖流式注入面收窄，避免假 memo）
    │               │
    │               └─► D2 虚拟化 Hooks 顺序与比较器收口
    │
    ├─► D6 终端隐藏（独立文件域）
    ├─► D7 Diff worker（独立文件域；依赖 D10 无新增魔数）
    ├─► D8 合成层 CSS（独立文件域；与 D1 流式动画合同）
    └─► D9 编辑器边界（独立文件域）
            │
            ▼
        D11 防御脚本随各维落地，收口负向全绿
```

**并行规则**：D10 → D4/D5 串行于 sessionStore 写路径；D1→D3→D2 链内顺序敏感（先收敛注入面再 memo，否则伪收敛）；D6/D7/D8/D9 文件域不相交可并行。

**禁止顺序反例**：

- 未做 props 稳定化就给卡片加 `React.memo`（无比较器或比较器形同虚设）→ 视为未完成，不算收敛。  
- 未删 `partialize.sessions` 就声称「持久化已优化」。  
- 未收窄 `streamingTextContent` 注入面就 memo 全卡片链 → 流式期仍每帧全部 reconcile。  
- 保留「读旧 LS 键回灌」兼容读 → 物理切除失败（本方案零兼容读）。

---

## 3. 分维度详案

### D10 · 预算 SSOT 与 Rust 对齐接口（前置）

#### 做什么

1. 新建 `apps/crish-desktop/src/api/perfBudgets.ts`（前端唯一预算源）：
   - `TOOL_OUTPUT_STORE_HARD_CAP`（store 写入截断，默认与展示一致 256KB）
   - `TOOL_OUTPUT_LINE_CAP` / 展示 cap：从 `ToolCallOutput.tsx` **迁入 budget** 并 re-export（展示层只 re-export，不本地定义）
   - `SESSION_HYDRATE_KEEP_K`（常驻已水合会话数，默认 3）
   - `STREAM_BLOCK_HASH_SEAL` 相关：无新魔数（hash 算法常驻实现内）
   - `PTY_HISTORY_MAX_BYTES`：从 `ptySessionApi.ts` 迁入并 re-export
   - `PTY_HIDDEN_WRITE_PAUSE = true` 语义开关：布尔放 budget，避免散落
   - `DIFF_HIGHLIGHT_LINE_CHUNK`：worker batch 行数
   - `WILL_CHANGE_STREAM_WORDS_MAX`：流式 animate span 生命周期上限（若保留）
2. Rust 侧约定：工具输出预算语义与前端同一语义层——**接口对齐文件**（本方案只定契约，不改 Rust 实现细节）：
   - 引擎/壳工具输出默认 cap 与 `perfBudgets.TOOL_OUTPUT_STORE_HARD_CAP` 同数值来源登记
   - 前端消费 `truncated` 标记时与 Rust `G8`/`output_budget` 字段同名透传（若字段尚未到前端，D10 登记接口缺口，由 IPC 维接线，不在本方案前端侧伪造）
3. `scripts/check-perf-budgets.mjs`（可先 warn 后 fail）：扫描 `src/` 业务代码中 `256 * 1024`、`2000` 行 cap 等字面量，未从 `perfBudgets` 引用则报错。

#### 删什么

| 删除项 | 位置 | 替代 |
| ------ | ---- | ---- |
| `TOOL_OUTPUT_LINE_CAP` / `TOOL_OUTPUT_BYTE_CAP` 本地定义 | `ToolCallOutput.tsx:9-10` | `perfBudgets` re-export |
| `PTY_HISTORY_MAX_BYTES` 本地定义 | `ptySessionApi.ts:52` | `perfBudgets` re-export |
| 各组件内重复的 256KB/2000 行魔数（`MarkdownDocumentView` 大文件阈值、`ActionRow` DOM cap 若与 store cap 语义相同则并；语义不同则 budget 内分列名） | 扫描清单见实现时 | budget 分列常量 |

#### 文件域

- 主：`apps/crish-desktop/src/api/perfBudgets.ts`（新建）
- 改：`ToolCallOutput.tsx`、`ptySessionApi.ts`、`workers/index.ts`（TOOL_OUTPUT_DOM/Pixel 若需归口）、`MarkdownDocumentView.tsx` 阈值引用
- 脚本：`scripts/check-perf-budgets.mjs`（新建）

#### 验收

- 全仓 grep：业务路径无未登记预算魔数。  
- 前端 cap 与 Rust 侧登记表数值一致（联调记录或单测断言同源 import）。  

---

### D4 · 持久化物理切除（LS 孤岛删除）

> 现状双出口：`sessionStore` `withPersist` partialize 含全量 `sessions`（`sessionStore.ts:63-69`）→ 每次 set 同步 `JSON.stringify` 全量正文进 `localStorage['crish_session_store']`；设计内正文落盘已是 `initStorePersistence` → `persistAllSessionsRust`（350ms debounce）。Stream D 迁 SQLite 后 LS 侧未拆。

#### 做什么

1. **一次迁移（启动路径，非兼容读）**：
   - 若存在 `crish_session_store` 且含 `sessions[].messages`：读入 → 交给既有 SQLite 持久化/水合路径 → **`localStorage.removeItem('crish_session_store')`** 或改写为 **仅索引壳**（见下）→ **删除迁移读代码**（迁移窗口结束后生产路径不再读该键正文）。  
   - 本方案取 **物理删除大键**：迁移完成后 LS 不再持有会话消息数组；侧栏元数据以 SQLite / 既有 `persistAllSessionsRust` 写的索引键为准（实现时对齐现有索引键名，不发明第二索引）。
2. **`partialize` 收窄为**：`activeSessionId`、`folderOrder`、`composerDrafts`（及必要 hydration 标志）。**`sessions`、`sessionsById` 一律不进 partialize。**
3. **composerDrafts**：继续可 persist（体量小）；`deleteSession` 成功路径必须 `delete composerDrafts[id]`（08-M5）。
4. **禁止**：`onRehydrateStorage` 从旧 sessions 大键重建消息；禁止「双写一段时间」。

#### 删什么

| 删除项 | 位置 | 说明 |
| ------ | ---- | ---- |
| `partialize` 中的 `sessions` | `sessionStore.ts:65` | **物理删除字段**，非 `skipHydration` 技巧 |
| 旧键正文兼容读 / 启动全量 rehydrate sessions | 迁移相关启动分支（实现时定位） | 迁移脚本一次后删除 |
| 对已删键的任何 `setItem` 全量 sessions | 全仓 | 门禁 grep |

> 注：`persistAllSessionsSyncViaLocalStorage`（beforeunload 同步镜像）若仍写**含 messages 的大 JSON**，与本维冲突——须改为索引壳或删除该镜像路径（与 08/07 交叉：beforeunload 同步 LS 的低危项在物理切除下重审）。

#### 文件域

- `store/sessionStore.ts`
- `store/middleware/withPersist.ts`（若需默认 options，不承载 sessions 逻辑）
- `store/layout-helpers/store-persistence.ts`
- `api/session-persistence/sessionRustDbHydrate.ts`（beforeunload 镜像）
- `api/sessionPersistence.ts` / `api/localStorageApi.ts`（键名注册表）
- `store/sessionCrudActions.ts`（draft 清理）
- 测试：`sessionRustDbHydrate*.test`、`sessionRustDbWriteModel.test`、boot 水合测试

#### 验收

- 运行时：`JSON.parse(localStorage.getItem('crish_session_store') ?? '{}')` **无** `sessions` 或 `sessions[].messages` 非空数组。  
- 构造 2MB 级工具输出收口：无 >1MB 级 `JSON.stringify` 热点（Performance / 4000 MCP）。  
- 冷启动仍能恢复会话列表与活跃会话正文（SQLite 路径）。  
- 负向单测：grep `crish_session_store` 写入路径不含 `sessions`。  

---

### D5 · 消息驱逐、快照记账、工具输出 hardCap

#### 做什么

1. **消息软驱逐（H2）**：
   - `setActiveSessionId` 切换时：对 previousActive（及 LRU 尾）执行 `messages = []` + `messagesHydrated = false`（或等价懒壳标记），保留 `messageCount` / `engineCursor` / pin 列表。  
   - 常驻预算：`SESSION_HYDRATE_KEEP_K`（D10）；流式中会话跳过驱逐（streamingStore 活跃 key 守卫）。  
   - 切回走既有 `triggerSessionMessageHydrateIfNeeded` / `needsEngineMessageHydrate`。  
2. **工具输出 store hardCap（H3）**：  
   - 写入点：`streamCallbacksEvents.ts` tool-end → `updateMessageToolCall` 前对 `output` 截断至 `TOOL_OUTPUT_STORE_HARD_CAP`，并设 `truncated: true`。  
   - 展示层保留行/字节门限，但 **store 已截断后展示不应再持第二全文**（M1：展示层三份拷贝收敛——引用 store 字符串 + 仅渲染窗口切片）。  
3. **MessageSnapshots（H5）**：  
   - `estimateBytes` 计入 `messages` 全量副本；或评估取消全量副本只保留 delta（验证 undo 消费方后二选一）。  
   - 预算计入 D10。  
4. **内存压力钩子（H6）**：`entry-core.tsx` pressure level3 在清 idle queue 之外，调用驱逐非活跃会话 messages（依赖 W2 已存在）。  
5. **分支 clone 峰值（M6）**：cloneMessages 路径评估结构共享 / 分页深拷贝（记录设计，不扩 scope 成全新 undo 架构）。

#### 删什么

| 删除项 | 说明 |
| ------ | ---- |
| 「只增不减」的激活合并策略 | `sessionActivateHydrate` 仅 merge 无 evict → 补 evict 对称分支，删除「永不驱逐」路径语义 |
| store 无 cap 的全量 `output` 赋值 | 截断后写入；禁止「先全量进 store 再 UI 裁」 |
| Snapshots 只按 delta 记账 | 修正后删除错误 estimate 路径 |

#### 文件域

- `store/sessionActivateHydrate.ts`、`store/sessionCrudActions.ts`
- `hooks/chat-stream/streamCallbacksEvents.ts`、`helpers.ts`
- `api/MessageSnapshots.ts`、`store/messageSnapshotsBridge.ts`
- `entry-core.tsx`
- `components/chat-tool-call/ToolCallOutput*.tsx`（展示去重拷贝）
- 与 D4 共享 sessionStore——**D4 与 D5 串行**（先切除再驱逐，避免迁移窗口驱逐干扰）

#### 验收

- 单测：A→B→C 后 `sessions.filter(s => s.messages?.length).length ≤ K`；切回 A 自动水合完整。  
- 流式中切换会话不丢流、不驱逐。  
- `tc.output.length ≤ HARD_CAP`；truncated 透传 UI。  
- Snapshots：`getTotalMemoryBytes() ≥ messages 估算 + delta 估算`。  

---

### D1 · 流式切分与派生热路径真增量化

#### 现状（代码锚）

- `useStreamingBlocks.ts:62-67`：`IncrementalBlockSplitter.split(fullText)`——每帧新建实例全量喂入。  
- 类本身增量：`IncrementalBlockSplitter.appendChunk` / `pendingStartLine`。  
- `hash16` 在缓存判定**之前**对每个封口块全文计算（`:83-92`）。  
- `stripThoughtPlaceholders` 全文正则 ×2 调用点，缓存 key=完整文本（01-M3）。  
- `timelineSignature` 全量 stringify（01-M4）。  
- 增量 thought 剥离器 / 增量高亮：死代码或未接线（01-M3/L1）。

#### 做什么

1. **Hook 持有 splitter 实例**（`useRef`，`messageId` 变更时重建）：热路径只 `appendChunk(delta)`；冷路径（首帧全文、编辑回放、isStreaming=false 重建）允许一次全量。  
   - 需要向 Hook 传入 **delta 或「相对上次前缀增长」**，或 Hook 内 diff 前缀增长长度（实现选一，禁止再次每帧全量 split）。  
2. **封口块一次哈希**：封口时算 hash 存入 descriptor；后续帧引用相等短路，禁止先 hash 后比对。  
3. **strip 单入口**：MessageContent / ProcessItemRenderer 共享一次 strip 结果（提升 memo 或 context/props 一次计算）；流式路径接线 `IncrementalThoughtStripper` 或 LRU 替代整体 clear。  
4. **timeline 签名子块缓存**：历史 text 块签名不因尾块变更重算全文（01-M4）。  
5. **活跃尾块投机补全与表格探针**（M8）：尾块长度阈值进 budget；超长尾块降级纯文本。  
6. **L1 死增量高亮器**：删除或真实接线二选一（见删什么）。

#### 删什么

| 删除项 | 位置 | 动作 |
| ------ | ---- | ---- |
| 静态 `split()` 作为**流式热路径** | `IncrementalBlockSplitter.split` 的生产调用 | 冷启动保留或内联到冷路径专用函数；禁止热路径调用 |
| 每帧全文 `hash16` | `useStreamingBlocks` | 改为封口一次 |
| `stripCache` 整体 clear + 双调用点重复 | `markdownRenderLite.ts` + 调用点 | 合并单路径 |
| 死代码增量高亮器（若确认零引用） | 01-L1 登记处 | **物理删除**；禁止 `@ts-expect-error` 留尸 |
| 闲置 `IncrementalThoughtStripper` 若仍不接线 | `markdownRenderLite.ts` | 接线或删除（二选一，禁止第三态） |

#### 文件域

- `components/chat-message-row/useStreamingBlocks.ts`
- `api/markdown/IncrementalBlockSplitter.ts`
- `components/chat-message/MessageContent.tsx`、`ProcessItemRenderer.tsx`
- `api/markdownRenderLite.ts`
- `api/tool-presentation/timelineCache.ts`
- 测试：`StreamingMarkdownView.test.tsx`、`reRenderMonitoring.test.tsx`（路径订正见 D11）

#### 验收

- 等价性：同一文本流增量 vs 全量 split 输出逐块相等。  
- reRenderMonitoring：流式纯文本帧历史块渲染 0。  
- 100KB 帧派生预算（帧内 scripting）显著低于全量切分基线；FE-INV-1。  

---

### D2 · 虚拟化 Hooks 与装配层稳定

#### 现状

- `ChatMessageList.tsx:194`：`if (messages.length === 0) return null` **在 5 个 useMemo 之前**——Hook 条件早退（01-H4，正确性+性能）。  
- `MessageVirtualizer.tsx:236-248`：无依赖数组 `useLayoutEffect` 全窗口重测（01-M1）。  
- `MessageVirtualizer.tsx:460` 一带内联闭包击穿 user 行 memo（01-H3）。  
- FlowScrubber 滚动 O(N) 无节流（01-M2）。  
- SessionRow 内联 props（02-C1）；RO 侧通道拖拽未冻结（02-C2）。

#### 做什么

1. **H4**：早退移到全部 Hooks 之后。  
2. **H3**：稳定回调——装配层 `useCallback` 传 `messageId`，行内自取 `msg`；比较器对 `onStartEdit` 等可比较存在性（防御）。  
3. **M1**：`useLayoutEffect` 加 `expandedSignature + searchHighlightSig + messages.length` 触发签名；与 RO 去重。  
4. **M2**：FlowScrubber 用 `findIndexAtOffset` + rAF；`getOrder()` 缓存。  
5. **C2/C3**：拖拽期间 RO → 写入冻结（对齐既有 `beginLayoutInteraction` 模式）；LeafDockResizer / Sidebar 侧 rAF 合帧。  
6. **MessageVirtualizer props 默认值**：`?? (() => {})` 每次渲染新函数——收束到模块级稳定 noop 或 useMemo，避免下游 memo 假活。

#### 删什么

| 删除项 | 说明 |
| ------ | ---- |
| 无签名的每渲染全窗重测路径 | 收敛为签名守卫 + RO |
| FlowScrubber 线性全扫可见性 | 删除线性循环，保留二分+可见窗口 |
| 行级内联箭头 props 作为唯一传参机制 | 改为 id 稳定回调；删除「捕获 msg 的闭包 props」模式 |

#### 文件域

- `components/chat-message-list/ChatMessageList.tsx`
- `components/chat-message-list/MessageVirtualizer.tsx`
- `components/chat-message-list/FlowScrubber.tsx`
- `components/chat-message-row/ChatUserMessageRow.tsx`、`chatMessageRowUtils.ts`
- `components/sidebar/SessionRow.tsx`、`useTreeResize.ts` / `LeafDockResizer.tsx` / `PaneHeader.tsx`（RO 冻结）
- `messageVirtualizerMemo.ts`

#### 验收

- StrictMode：0 消息 → 追加消息不抛 Hook 顺序错误。  
- 流式期 user 行渲染计数 = 0。  
- 滚动：1000 条消息 scrubber 每帧访问次数 O(log²N+可见)。  

---

### D3 · 卡片链 memo 与展开粒度（禁伪收敛）

#### 现状

- `expandedToolsBySession`：会话级单对象，任一 toggle → 整列表卡片 props 变化（02-T1）。  
- 无 memo：`CompactToolRow`、`ChatToolStack`、`MessageToolCallsSection`、`ToolCallHeader/InputPane/OutputPane/DiffPreview` 等（02-T2）。  
- `streamingTextContent` 注入每张卡（02-T3、`MessageContent.tsx:400/540`）。  
- `hostProps` / `onInvalidate` 内联重建（02-T2）。  
- 卡内每渲染重复派生 / 展开动画 max-height / 定时器增殖（T4–T7）。

#### 做什么（顺序强制）

1. **先稳定 props，再 memo**（伪收敛禁止）：  
   - `expandedTools`：**per-message**（或 per-toolId 订阅面）——toggle 只变更目标消息的展开 map 引用；禁止整会话 map 每次新对象且全列表共享。  
   - `toolStackProps` / `hostProps`：useMemo + 固定依赖；回调 `useCallback`。  
   - `onInvalidate`：模块级或 store 动作引用。  
2. **再 `React.memo` + 显式比较器**：8 组件链每级 memo；比较器字段与 `toolStackSharedPropsEqual` 同法（已有正面对照）。  
3. **流式注入面收窄**：`streamingTextContent` 仅当 `msg.id === streamingMessageId` 且 `isStreaming` 时传入；历史卡 **undefined 且引用稳定**。  
4. **T4**：昂贵派生移出渲染体 → useMemo / 移到封口时。  
5. **T5**：展开挂载帧解析器分级（先便宜路径）；与 Diff worker（D7）衔接。  
6. **T6**：展开动画不用 0→2000 max-height；改 `grid-template-rows` 或瞬时展开 + opacity。  
7. **T7**：定时器：running 卡 / live 段合并为单例 tick 或 visibility 感知；删除 per-card 500ms/100ms 增殖。

#### 删什么

| 删除项 | 说明 |
| ------ | ---- |
| 会话级共享 `expandedTools` 单例作为列表 prop | 替换为 per-message 派生 |
| 无 memo 的 8 组件导出形态 | 改为 memo 导出；删除「无比较器裸函数组件」导出 |
| 内联 hostProps 对象字面量 | 删除字面量传参路径 |
| 无界 per-card interval | 删除或合并单例 |

#### 文件域

- `components/chat-message/MessageContent.tsx`
- `components/chat-message-row/useChatMessageState.ts`、`ChatAssistantMessageRow.tsx`
- `components/chat-tool-call/*`（CompactToolRow、ChatToolCallBlock、MessageToolCallsSection 在 chat-message-row、ToolCall*、FoldableToolGroup）
- `toolExpansionState.ts`

#### 验收

- 单卡展开：其它消息渲染计数 = 0（FE-INV-5）。  
- 流式 tools：工具区渲染 = 工具事件数而非帧数（既有锁定）。  
- 审计式抽查：每个 `React.memo` 组件的 props 在无业务变更时 Object.is 稳定（测试或运行时探针）。  

---

### D6 · 终端隐藏存活与 PTY 内存账

#### 现状

- `TreeLeafPanel` 非活跃 tab `display:none` 全量挂载；`ptyLifecycle` 无可见性判断仍 `term.write`（02-X1）。  
- 后端每 ≤8KB 一次 emit + 前端一次 write（02-X2，PTY 侧无 PE-02 约束）。  
- WebGL 丢失永久 DOM（02-X3）。  
- fan-out 全 handler 再过滤（02-X4）；history UTF-8 计量（02-X5）；重放开销（02-X8）。

#### 做什么

1. **隐藏暂停写**：终端可见性（tab active / 面板非 display:none）驱动 `write` 门闩；隐藏期 chunk 只进 history（降采样策略），不 `term.write`。  
2. **显现重放**：可见时从 history 重放（合并单次大 write 或 writeSync 分块）；与 X8 修复合并（cwd 依赖、restartToken 死参数）。  
3. **PTY 后端合批**：Rust read 侧 64KB/时间窗合批 emit（无 PE-02 约束，独立合同）。  
4. **WebGL**：onContextLoss 事件化 + 限次恢复 + 遥测。  
5. **分发索引**：`Map<ptyId, Set<handler>>`。  
6. **history 计量**：byte length 随 chunk 携带或 Blob.size。

#### 删什么

| 删除项 | 说明 |
| ------ | ---- |
| 隐藏终端持续 `term.write` | 门闩后删除无可见性 write 路径 |
| 每 chunk TextEncoder 计量 | 改更快计量后删除编码路径 |
| 恒 0 `restartToken` 死参数 | 删除 |
| cwd 每渲染重算进 effect 依赖 | 删除「依赖监听 cwd」模式 |

#### 文件域

- `components/binary-tree/TreeLeafPanel.tsx`
- `components/workspace/ptyLifecycle.ts`
- `hooks/useXtermTerminal.ts` / 终端 hook 路径
- `api/ptySessionApi.ts`
- Rust：`src-tauri/src/pty/session.rs`（合批）

#### 验收

- 隐藏 tab：write 计数 0（FE-INV-7）；显现内容完整。  
- 8+ 标签：WebGL 上下文不耗尽或可控降级可恢复。  
- RSS：多终端隐藏期不随输出速率线性涨 scrollback。  

---

### D7 · Diff worker 接线

#### 现状

- `DiffCardUnifiedView` / `SplitView` / `WidgetDiff` / `ToolCallDiffPreview` 主线程 `highlightCode`。  
- `render-worker` 已有 `highlight.batch`（`render-worker.ts:27`）**生产零消费**。  
- 正面：`highlightCodeSafe` ReDoS 盾保留。

#### 做什么

1. Diff 路径改为：行收集 → `highlight.batch` 一次调度 → 回填 HTML（或展开前预计算 + 懒首屏）。  
2. 短文件可保留同步路径但 cap 内；超过阈值强制 worker。  
3. 与 T5 展开成本合并验收。

#### 删什么

| 删除项 | 说明 |
| ------ | ---- |
| Diff 主路径同步 `highlightCode` 循环 | 改为 batch 消费 |
| 空转「仅测试用」的 batch 通道旁路感 | 生产真实接线；删除主线程重复实现调用 |

#### 文件域

- `components/diff/DiffCardUnifiedView.tsx`、`DiffCardSplitView.tsx`
- `components/custom-tags/WidgetDiff.tsx`
- `components/chat-tool-call/ToolCallDiffPreview.tsx`
- `api/codeHighlight.ts`（入口分工：sync 安全路径 vs async batch）
- `workers/render-worker.ts`（若需扩展协议——仅前端 worker 协议，非 engine-events）

#### 验收

- 大 diff 展开：主线程无同步 hljs 长任务；首屏 scripting 目标与 12-V 对齐。  
- ReDoS 盾与 short-path 行为回归。  

---

### D8 · 合成层与流式 CSS

#### 现状

- 流式单词 `will-change: opacity, transform` 常驻（`streaming-animation.css:31`）；契约测试锁定该声明（`streamingAnimationContract.test.ts:80`）。  
- 表格流式脉冲 outline/box-shadow（`StreamingTableContainer.module.css` + 12-T1）。  
- 侧栏会话行常驻 will-change transform；Tabs/Toast/Switch/PaneHeader/BinaryTree 布局属性 will-change（12-W2/W3）。  
- ChatComposer 常驻 backdrop-filter（12-B1）。

#### 做什么

1. **W1**：animate span 的 will-change **仅在动画存活期**（animationend / 封口时移除）；或改为仅 transform/opacity 的瞬态 promotion，禁止长命 span 常驻。  
2. **契约测试改写**：删除「必须常驻 will-change」断言，改为「不得在非 animate 元素常驻 will-change」+「animate 期存在」。  
3. **T1**：表格脉冲改 paint-safe 或数据驱动（只对活跃格 class），去掉无限 outline/box-shadow 动画。  
4. **W2/W3**：删除布局属性 will-change；侧栏行仅在滚动/拖拽瞬态加。  
5. **B1**：composer backdrop-filter 在消息滚动高频期降级（滚动结束再启用或降低 blur）。

#### 删什么

| 删除项 | 说明 |
| ------ | ---- |
| 流式 span 常驻 will-change | 改为动画生命周期 |
| Tabs/Toast/Switch/PaneHeader/BinaryTree 布局 will-change | 整段删除 |
| 无意义 table pulse infinite | 删除或替换 |

#### 文件域

- `components/chat-message-row/streaming-animation.css`
- `components/chat-message-row/StreamingTableContainer.module.css`
- `components/ui/Tabs|SegmentedControl|Switch|ToastStackModern|ScrollArea` 等 module.css
- `components/sidebar/SidebarSessionList.module.css`
- `components/binary-tree/BinaryTreeWorkspace.module.css`、`PaneHeader.module.css`
- `components/chat-composer/*` backdrop
- 测试：`streamingAnimationContract.test.ts`

#### 验收

- 长输出流式：合成层峰值收敛（Layers / 12-V1）。  
- 表格流式：无无限 paint 脉冲。  
- 门禁：新增 `check-will-change`（布局属性列表 fail）。  

---

### D9 · 编辑器实例与虚拟窗边界

#### 现状

- tiptap 编辑实例挂虚拟化窗口内：滚动/流式窗口位移 → 销毁重建（02-E1）。  
- 水合 setContent 无 IME 守卫（02-E2）；150ms 防抖末帧整卡重渲染（E4）。

#### 做什么

1. 编辑中消息 **锚定出虚拟窗外**（稳定挂载点，不随 overscan 卸载）。  
2. content 水合：IME composition 期间挂起 setContent，compositionend 补齐。  
3. 防抖末帧 setState 粒度收窄到编辑草稿域，避免 ChatCard 全子树。

#### 删什么

| 删除项 | 说明 |
| ------ | ---- |
| 「编辑实例随虚拟窗销毁重建」路径 | 锚定后删除重建路径 |
| 无守卫的 setContent 直写 | 删除无守卫路径 |

#### 文件域

- `TiptapEditorField.tsx` 等编辑器路径
- `MessageVirtualizer.tsx` / 消息行挂载（编辑锚定槽）
- `ChatCard` composer 分支

#### 验收

- 流式中编辑：实例不销毁；IME 中文输入不被水合打断。  

---

### D11 · 防御脚本与守护测试（随维收口）

| 脚本/测试 | 断言 |
| --------- | ---- |
| `check-perf-budgets.mjs` | 预算魔数仅 budget 源 |
| `check-store-islands`（新） | 禁止写已删 LS sessions 岛；partialize 无 sessions |
| `check-will-change`（新） | 布局属性 will-change = 0 |
| `check-memo-props`（可先 warn） | 热点组件清单 props 稳定性模式 |
| `reRenderMonitoring` | 路径订正 `src/__tests__/`；user 行 0 渲染；单卡展开 0 扩散 |
| persist/驱逐单测 | FE-INV-2/3 |
| streamingAnimationContract | 改为「非常驻 will-change」 |
| 终端 write 计数 | 隐藏 0 / 显示正常 |
| Diff 无同步 hljs | 路径断言 |

---

## 4. 删除面总表（负产出）

> 本方案删除/收敛清单（主控可据此做负产出验收）。

| # | 删除/收敛项 | 证据锚 | 类型 |
| - | ----------- | ------ | ---- |
| 1 | zustand persist `partialize.sessions` | sessionStore.ts:65 | 物理切除 |
| 2 | LS 大键正文 + 兼容读/双写 | crish_session_store | 物理切除 |
| 3 | beforeunload 含 messages 的 LS 镜像（若存在） | sessionRustDbHydrate | 收敛→壳或删 |
| 4 | 流式热路径静态 `split()` | useStreamingBlocks | 路径收敛 2→1 |
| 5 | 每帧全文 hash16 | useStreamingBlocks | 删除无效计算 |
| 6 | strip 双调用点 + 整 clear 缓存 | markdownRenderLite | 合并 2→1 |
| 7 | 死增量高亮器 / 死 thought stripper | 01-L1/M3 | 删除或接线二选一 |
| 8 | ChatMessageList 早退前 Hooks | ChatMessageList.tsx:194 | 结构修正 |
| 9 | 无签名全窗重测 layoutEffect | MessageVirtualizer | 删除无守卫路径 |
| 10 | 会话级 expandedTools 列表 prop | useChatMessageState | 收敛 per-message |
| 11 | 8 卡片组件无 memo + 内联 props | chat-tool-call | 收敛（先 props 后 memo） |
| 12 | 非活跃卡 streamingTextContent | MessageContent | 收敛注入面 |
| 13 | 隐藏终端 term.write | ptyLifecycle | 删除路径 |
| 14 | Diff 主线程同步 hljs 主路径 | DiffCard* | 收敛→worker |
| 15 | 常驻/布局 will-change 群 | 多处 CSS | 物理删除 |
| 16 | TOOL_OUTPUT/PTY 魔数本地定义 | ToolCallOutput 等 | 收敛 budget |
| 17 | 恒 0 restartToken、cwd 依赖监听 | TerminalCard | 删除死参数 |
| 18 | Snapshots 错误单侧记账 | MessageSnapshots | 修正后删错路径 |

---

## 5. 文件域与并行边界

| 工作单元 | 主文件域 | 可并行伙伴 | 冲突注意 |
| -------- | ---------- | ---------- | -------- |
| U-BUDGET-FE | perfBudgets.ts、魔数迁出点、check-perf-budgets | 其他单元只读 budget | 先于引用方 |
| U-PERSIST-FE | sessionStore、withPersist、store-persistence、sessionRustDbHydrate、sessionCrud | 与 U-EVICT 串行 | 与 D5 串行 |
| U-EVICT | sessionActivateHydrate、MessageSnapshots、entry-core、streamCallbacks 截断 | 等 persist 切除后 | 同上 |
| U-STREAM | useStreamingBlocks、IncrementalBlockSplitter、MessageContent strip、timelineCache | U-CARD 前置 | MessageContent 与 U-CARD 共享→串行或单人 |
| U-CARD | chat-tool-call/*、useChatMessageState、MessageContent 注入面 | U-STREAM 后 | |
| U-VIRT | MessageVirtualizer、ChatMessageList、FlowScrubber、SessionRow、RO 冻结 | 可与 U-CARD 并行（文件不交叠时） | ChatUserMessageRow 边界 |
| U-TERM | ptyLifecycle、useXtermTerminal、ptySessionApi、pty/session.rs | 独立 | |
| U-DIFF | DiffCard*、WidgetDiff、ToolCallDiffPreview、worker 协议 | 独立 | |
| U-CSS | streaming-animation、各 module.css、will-change 门禁 | 独立 | |
| U-EDIT | tiptap 字段、编辑锚定槽 | U-VIRT 挂载点协调 | |
| U-GUARD | 各 check-*、reRenderMonitoring、契约测试 | 收口 | |

同一单元单 Agent 主责；跨单元只读依赖或主控串行合并。**U-PERSIST-FE 与 U-EVICT 禁止并行写 sessionStore**。

---

## 6. 验收标准（功能 + 负产出 + 五端物证）

### 6.1 功能

- 流式、卡片展开、会话切换、终端 tab、Diff 打开、编辑 IME 行为与修复前一致（正确性回归）。  
- 冷启动恢复：正文来自 SQLite；侧栏列表完整。  
- 运行时 V 项经 **4000 Tauri MCP**（禁止 9222 / 5174 冒充）：FE-INV-1…10 对应场景回填。

### 6.2 负产出

- 至少完成 §4 总表中：LS 孤岛切除 + 流式路径 2→1 + expandedTools/卡片 props 稳定化 + Diff worker 接线 + will-change 删除组。  
- 新增 TODO/FIXME = 0。  
- 无第二条 persist 路径、无第二条流式全量切分路径。

### 6.3 五端物证

| 端 | 本方案映射 |
| -- | ---------- |
| 触发端 | UI 切会话 / 流式 / 展开卡 / 开 Diff / 隐藏终端 |
| 传输端 | 工具输出 truncated 字段、（若接）预算与 Rust 同源；不改 engine-events 契约本方案则登记「仅前端」边界 |
| 介质端 | 正文仅 SQLite；LS 无 messages；旧键已删 |
| 消费端 | 驱逐/hardCap/memo/worker 真实进入渲染与 store 写路径 |
| 负向断言 | store-islands、budgets、will-change、reRender、persist 单测全绿 |

---

## 7. 与审计发现 ID 映射（摘要）

| 本方案 | 90 ID |
| ------ | ----- |
| D1 | 01-H1, H2, M3, M4, M5, M8, L1 |
| D2 | 01-H3, H4, M1, M2, M6; 02-C1, C2, C3 |
| D3 | 02-T1–T8; 01-M10 |
| D4 | 08-H1, H4, M5; 01-M9 |
| D5 | 08-H2, H3, H5, H6, M1, M6, M8, M10 |
| D6 | 02-X1–X5, X8; 08-M2, M7 |
| D7 | 12-D1; 12-S2 |
| D8 | 12-W1–W3, T1, B1, A1, A2 |
| D9 | 02-E1, E2, E4 |
| D10 | 08-H3 接口; 交叉 03-R6 / 10-T4 仅预算对齐声明 |
| D11 | 全维 |

交叉声明：03 IPC 双发、05 DB、04 引擎克隆 **不在本方案实施范围**；仅约定：前端不依赖 PE-02 解锁即可完成本方案全部项；工具输出 hardCap 与 Rust 对齐在 D10 开接口，实现可分 PR。

---

## 8. 与 91 系统性修复总方案的分歧

| # | 91 取舍 | 本方案 | 理由 |
| - | ------- | ------ | ---- |
| 1 | 持久化单轨放在 Layer 3，且表述为「partialize 收窄 + 一次 migration 删读代码」 | **同等物理切除，但作为本域第一优先**，并明确 beforeunload LS 镜像必须重审删除 | 正文 LS 大键是当前最大可删税；不依赖 DB 组提交完成即可先切前端出口 |
| 2 | 91 L5 把增量化与卡片 memo 放同一层并列 | **强制顺序：先收窄 streamingTextContent 注入面与 expandedTools 粒度，再 memo** | 否则伪收敛（用户禁令） |
| 3 | 91 对终端隐藏仅「暂停 write + history 降采样」 | 同意暂停，**并补：隐藏期禁止解析路径、显现重放合并写、PTY 后端合批独立合同、WebGL 恢复** | 02-X1/X3/X8 完整闭环 |
| 4 | 91 Layer 8 才处理可见性背压 03-R8 | 本方案 **不依赖** 03-R8；隐藏终端写门闩属前端 DOM 可见性，不属 IPC 契约 | 避免把终端修复错误绑到强契约层 |
| 5 | 91 U-PERSIST-FE 与 U-RENDER 可同轮并行 | **sessionStore 内 persist 与驱逐必须串行**；渲染链可与 persist 并行 | 同文件域写冲突 |
| 6 | 91 未强调 will-change 契约测试反转 | **必须改 `streamingAnimationContract`**，否则门禁保护回潮 | 已有用例锁定错误行为 |
| 7 | 91 预算模块含大量 Rust 项 | 本方案 **前端 budget 先落地 + Rust 对齐接口登记**；Rust 大改不阻塞前端负产出 | 独立可交付 |
| 8 | 91 将 01/02 多项中危分散在 L5/L6 | 本方案收束为 D1–D9 可并行工作单元，并给出删除面总表 | 独立总案完整性 |
| 9 | 关于 LS「索引壳可选」 | 本方案：**取消 sessions 大键**；索引以 SQLite/Rust 路径为准；不保留「LS 正文回退」 | 禁止兼容读 |

---

## 9. 立即可并行的首轮工作单元（文件域不相交）

1. **U-BUDGET-FE** — perfBudgets + 魔数迁出 + check 脚本骨架  
2. **U-PERSIST-FE** — partialize 切除 + 旧键物理删除 + draft 清理  
3. **U-STREAM** — splitter 实例增量 + 哈希封口一次 + strip 单入口  
4. **U-TERM** — 隐藏 write 门闩 + 分发索引 + history 计量  
5. **U-DIFF** — worker batch 接线  
6. **U-CSS** — will-change 收敛 + 契约测试反转 + table pulse  
7. （其后）**U-EVICT** — 驱逐 + hardCap + Snapshots 记账  
8. （其后）**U-CARD / U-VIRT / U-EDIT**

---

## 10. 汇报要点（给主控）

- **路径**：`docs/performance-audit/materials/plans/independent-03-前端渲染与内存.md`  
- **删除面**：§4 共 18 项（LS 孤岛、全量 split、死高亮器、无 memo 内联链、隐藏 write、同步 Diff hljs、布局 will-change、魔数本地化等）  
- **与 91 分歧**：§8 九条（persist 优先与 beforeunload、memo 前序、终端闭环、IPC 背压解绑、sessionStore 串行、契约测试反转、Rust 非阻塞、工作单元收束、禁 LS 正文回退）  

---

_本文件为独立总案，UTF-8 无 BOM；未执行 git commit；未修改生产代码。_
