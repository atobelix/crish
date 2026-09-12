# 补充审查：01–03 报告交叉缺口与薄弱面（supplement）

> **战役**：全面性能审查（performance-audit）
> **性质**：对 01（前端渲染）/ 02（长列表与重型组件）/ 03（IPC）已完成报告的**挑刺式交叉补扫**，不重写、不重复已立编号高危项
> **日期**：2026-09-12
> **方法**：以已知清单（01 H1–H4/M1–M11/L1–L7；02 X1–X9/E1–E7/C1–C9/T1–T12；03 R1–R9/I1–I6/V1–V5/C1–C6）为排除集，沿跨报告缝合处与覆盖薄弱面做静态走读
> **行号基准**：2026-09-12 工作区快照；后续代码变动按符号名重定位
> **格式**：每条 = 位置 / 现象 / 代码 / 调用链 / 根因 / 影响 / 修复建议 / 严重度；显式标注「新发现」或「01/02/03 已有项的增量证据」

---

## 0. 阅读指南与排除集

**排除集（本文件不重复展开）**：01 H1/H2（全文切分与哈希）、H3/H4（virtualizer memo/Hook 早退）、M1–M11；02 X1/X2（终端存活与合批）、E1/E2（tiptap）、T1–T3（卡片 memo）；03 R1–R4、I1、V1、C1。

**严重度**：高（规模化可感/正确性）；中（可测量开销或架构浪费）；低（记录防回潮）。

**新增编号**：本文件用 **S-xx**（Supplement），避免与 01/02/03 正式编号冲突。主 Agent 若并入正式报告，应改写为对应域编号（如 01-M12、02-T13 等）。

---

## 1. 执行摘要

**一句话结论：01–03 对聊天热路径与 IPC 主链覆盖扎实；漏网集中在三类——① conversation-flow 扩展激活后的全量重投影（packages 非默认路径却可在开启后侵入每帧账单）；② 定时器/轮询增殖面（RuntimePanel 1s、主题 solar 60s、审批倒计时 100ms、设备/诊断页轮询）未被正式计数；③ 会话搜索对全量 tool output 的内容级扫描在侧栏搜索路径上无虚拟化保护。**

- **新发现**：12 项（高 2 / 中 5 / 低 5）
- **增量证据**：3 项（补强 02-X7、03-V2/V5、01-L4/L5 同族）
- **TOP3 建议并入**：S-01（conversation-flow 全量重投影 → 并入 01/02 卡片域）、S-05（主题 solar tick 与终端 MutationObserver 级联 → 并入 02-X7 增量）、S-02（会话搜索全语料扫描 → 新列 02 或 01 覆盖面表）

---

## 2. 跨报告缝合处（流式 + 扩展 + 虚拟化复合路径）

### S-01【高 · 新发现】conversation-flow 激活后：每次 messages 引用变化对全部助手消息重跑 projectMessage，含仅用于 data 属性的节点计数

- **位置**：
  - 计数：`src/extensions/conversation-flow/host.tsx:32-40`（`countAssistantFlowNodes`）、`:46`（useMemo 依赖 `list`）
  - 渲染器重建：`host.tsx:47-50`（`createNarrativeRenderers(list)`）
  - tools 路径二次投影：`narrativeRenderers.tsx:42-46`（`purposesOf` → `projectMessage`）、`:63-73`（`renderNarrativeTools` 每次调用）
  - 激活开关：`activate.ts:35-37`（默认关）、`entry-core.tsx:79-80`（条件激活）
- **现象**：官方 conversation-flow 扩展激活后（`shouldActivateOfficialConversationFlow()`），`ConversationFlowHost` 在**每次 `props.messages.messages` 引用变化**时：
  1. 对**全部** assistant 消息逐条 `projectMessage` 求节点数，仅用于 `data-flow-node-count` 属性；
  2. 重建 `renderTools`/`renderThought` 闭包（捕获整个 `messages` 数组）；
  3. `renderNarrativeTools` 每次被调又对**该条消息**再 `projectMessage` 一次（`purposesOf`），无缓存。
- **代码现场**：

```ts
// host.tsx:32-50
function countAssistantFlowNodes(messages: SessionMessage[]): number {
  let n = 0;
  for (const msg of messages) {
    if (msg.sender !== 'assistant') continue;
    const projected = projectMessage(msg);   // ← 全量投影，仅计数
    n += projected.nodes.length;
  }
  return n;
}
// ...
const nodeCount = useMemo(() => countAssistantFlowNodes(list), [list]);
const { renderTools, renderThought } = useMemo(
  () => createNarrativeRenderers(list),      // ← list 引用变 → 新渲染器闭包
  [list]
);
```

```ts
// narrativeRenderers.tsx:42-46, 63-73
function purposesOf(msg: SessionMessage): PurposeNode[] {
  const { nodes } = projectMessage(msg, { humanize: DESKTOP_HUMANIZE }); // ← 再投影
  return nodes.filter((n) => n.kind === 'purpose');
}
export function renderNarrativeTools(args) {
  const msg = messages.find((m) => m.id === msgId);
  const visible = msg ? purposesForSlice(purposesOf(msg), sliceIds) : []; // ← 每次 render 再投影
  ...
}
```

- **调用链与触发时机**：激活扩展 → ChatMessageList 经 slot 换为 ConversationFlowHost → 工具终态 commit / snapshot / 会话切换等使 `sessions` 域引用变化时，`list` 新引用 → 计数 + 渲染器重建；工具段每次渲染再投影单消息。工具密集 run 中每工具事件一轮（与 02-T1 同频，但投影成本 O(消息 blocks+toolCalls 全量)）。
- **根因**：投影是纯函数但按「无状态全量 API」调用（与 01-H1「增量切分器被当一次性 API」同构）；节点计数为调试/测试属性付出了全量投影代价；`purposesOf` 未按消息引用缓存。
- **影响量化**：默认关，激活前无实害。激活后：50 条助手消息 × 平均 5KB 正文+工具 → 每工具事件全量投影 50 次 + 当前消息再投影 1 次 ≈ 毫秒级；长会话 + 工具风暴时与 01 批次 A 未修的 H1/H2 叠加构成「扩展路径最差场景」。`projectMessage` 位于 `@crish/conversation-flow`（无 React、纯函数），单次成本可控，但调用次数无界。
- **修复建议**：
  1. `countAssistantFlowNodes`：删除或改为增量计数（仅在 message-end 时更新），禁止每 list 变化全量投影；
  2. `purposesOf`：`WeakMap<SessionMessage, PurposeNode[]>` 按消息引用缓存；
  3. `createNarrativeRenderers`：闭包只捕获需要的稳定 action 引用，messages 经 `getState()` 或 per-args 传入，避免 list 引用变化重建渲染器；
  4. 补断言：「conversation-flow 激活 + 工具事件 ×20 → projectMessage 调用次数 ≤ 活跃消息数」。
- **严重度**：**高**（激活条件下的架构性浪费；默认关故正式报告宜标注「feature-on 路径」）
- **标注**：**新发现**（01 附录 A 将 conversation-flow 标为「终态投影、非 per-token」——对默认路径成立，**未覆盖激活后 host 层的全量重投影与 data 属性计数**）

---

### S-02【中 · 新发现】侧栏会话搜索：全语料内容扫描（含 tool output 800 字符窗口），无结果缓存、无增量

- **位置**：
  - 匹配：`src/api/sessionSearch.ts:216-278`（`matchSessionSearch`：title/folder + 全部 messages + 全部 agents.messages）
  - 工具字段：`sessionSearch.ts:97-121`（`matchToolCalls` 对每卡 `arguments`/`output` 截断后 includes）
  - 截断阈值：`sessionSearchText.ts:16`（`TOOL_TEXT_MAX = 800`）、`:126-128`（`trunc`）
  - hook：`src/components/sidebar/session-list/useSessionSearch.ts:25-46`（每次 `visibleSessions`/`searchQuery` 变化全表扫描 + 全表 sort）
  - 防抖：`App.tsx:94-103`（220ms debounce——防抖存在，但防抖后仍是全量）
- **现象**：搜索激活时，对**每个可见会话**扫 title、folder、每条消息的 text/thinking/blocks[].content/toolCalls（arguments+output 各截 800 字）、以及每个 agent 的全部子消息。多会话 + 长历史 + 大工具输出场景下，单次防抖后的匹配为 O(会话数 × 消息数 × 平均字段长度)。
- **代码现场**：

```ts
// useSessionSearch.ts:25-34
const searchHits = useMemo(() => {
  const map = new Map<string, SessionSearchMatch>();
  const q = searchQuery.trim();
  if (!q) return map;
  for (const s of visibleSessions) {
    const hit = matchSessionSearch(s, q);   // ← 每会话全语料
    if (hit.match) map.set(s.id, hit);
  }
  return map;
}, [visibleSessions, searchQuery]);
```

```ts
// sessionSearch.ts:97-111（工具字段仍进匹配）
const fields = [
  tc.name || '',
  trunc(tc.arguments),   // ← 最多 800 字
  trunc(tc.output),      // ← 最多 800 字
  tc.explanation || '',
];
```

- **调用链与触发时机**：侧栏搜索框输入 → 220ms debounce → `setSessionSearch` → `visibleSessions` 引用不变但 `searchQuery` 变 → 全表 `matchSessionSearch` + `sortedSessions` 全表 sort。**另**：`visibleSessions` 若因工具 commit（session 对象 fork）而数组引用变化，非搜索态也会重跑 `sortedSessions` 的 sort（有 early-out：空 query 时 `list = visibleSessions` 仍 copy+sort——`useSessionSearch.ts:36-46` 每次都 `[...list].sort`）。
- **根因**：搜索是「同步、全量、内容级」设计；`TOOL_TEXT_MAX` 限制了单卡扫描长度但未限制会话/消息数量级；排序结果未缓存（`visibleSessions` 引用每次 sessions 域变化都可能变）。
- **影响量化**：100 会话 × 平均 50 消息 × 每消息 2KB 正文 + 工具截断 ≈ 单次搜索匹配扫描数百 KB～数 MB 字符 includes；CJK NFKC 规范化（`normalizeSearchHaystack` 每字段一次）叠加。输入防抖 220ms 后仍可能出现 10–50ms 主线程卡顿。非搜索态：`sortedSessions` 在每 session 域写入时 copy+sort（100 条 localeCompare，亚毫秒级，可接受）。
- **修复建议**：
  1. 非搜索态跳过 `[...list].sort`——直接返回 `visibleSessions`（或缓存 sort 结果至 `visibleSessions`/`sortType` 变）；
  2. 搜索匹配：title/folder 优先短路（命中标题可跳过消息扫描）；消息级匹配仅对「可能命中」的会话做（先 title 前缀/模糊层，再正文层）；
  3. 长期：预建搜索索引（项目已有 `core_rebuild_search_index`/`StatusDiagnosticsPanel` 重建入口——`StatusDiagnosticsPanel.tsx:176-193`——说明 Rust 侧存在搜索索引基建，侧栏搜索未消费）。
- **严重度**：**中**（搜索态可感；非搜索态 sort 开销低）
- **标注**：**新发现**（01/02 覆盖面表未列侧栏内容级搜索）

---

### S-03【中 · 新发现】ConversationFlowHost 开启时与 MessageVirtualizer 的「双投影」缝合：timeline 投影（01-M4）与 conversation-flow 投影并行且互不复用

- **位置**：01-M4 `timelineCache.ts` 投影 vs `@crish/conversation-flow` `projectMessage`；装配点 `ChatMessageList.tsx:271`（NarrativeRenderSlotsContext）与 `host.tsx` 双层 host
- **现象**：同一 assistant 消息在激活 conversation-flow 时会被两条独立投影管线处理——`buildAssistantTimelineCached`（消息卡片/折叠树）与 `projectMessage`（Purpose/Thinking/Action 叙事节点）。两者结果不共享；S-01 的全量重投影与 01-M4 的每帧 stringify 叠加。
- **调用链**：MessageContent（timeline）与 ProcessItemRenderer/renderTools（conversation-flow slots）同帧执行。
- **根因**：扩展架构允许替换 render 槽，但投影层未统一为「一次投影、多视图消费」。
- **影响量化**：激活时每消息投影成本约 ×2；与 01-M4 修复正交——修 M4 不会自动修 conversation-flow 侧。
- **修复建议**：短期接受（默认关）；激活路径优先做 S-01 的缓存；中期评估 `projectMessage` 与 timeline 投影合并为单一中间表示（IR）再分视图。
- **严重度**：**中**（缝合面记录；依赖 feature-on）
- **标注**：**新发现**

---

## 3. 设置 / 偏好 / 工作区 / 文件树

### S-04【中 · 新发现】RuntimePanel 常驻 1s setInterval + tickColdCheck，且面板作为 tool tab 可 display:none 全存活

- **位置**：`src/components/workspace/RuntimePanel.tsx:58-65`；挂载策略见 02-C9（`TreeLeafPanel.tsx:490-514` 非活跃 tab 完全存活）
- **现象**：RuntimePanel 打开后 `setInterval(1000)` 驱动 `setNow` + `useCacheEventsStore.getState().tickColdCheck(now)`，**无可见性/激活 tab 判断**。tabMode 下切走后组件仍挂载（display:none），interval 继续。
- **代码现场**：

```ts
// RuntimePanel.tsx:58-65
const [now, setNow] = useState(() => Date.now());
useEffect(() => {
  const t = setInterval(() => setNow(Date.now()), 1000);
  return () => clearInterval(t);
}, []);
useEffect(() => {
  useCacheEventsStore.getState().tickColdCheck(now);
}, [now]);
```

- **调用链**：打开运行状态面板 → 每秒 setState(now) → 面板重渲染（含子 section）+ tickColdCheck。切换到其他 tab 后（display:none）仍每秒执行。
- **根因**：把「冷缓存提示文案的相对时间」做成了面板级秒针，未降级为叶子 memo 消费（对照 01-P7 NowTick 隔离到 memo 叶子的正面模式）。
- **影响量化**：单面板每秒 1 次 setState + 轻量渲染；与 X1/C9 叠加：用户打开过 Runtime tab 后永久多一路 1Hz 心跳。当前渲染轻（status 文本），规模化后若 section 变重则放大。`tickColdCheck` 本身应在 store 内有去重（T-48 注释），写路径成本低。
- **修复建议**：① `now` 驱动收敛到需要相对时间的叶子组件；② tab 不活跃时不 tick（复用 TreeLeafPanel 的 isActive 上下文或 `document.visibilityState` + `aria-hidden` 父级检测）；③ 对齐 NowTick 的自适应粒度（15s 足够冷缓存提示）。
- **严重度**：**中**（低频但常驻；与 02-C9 存活策略耦合）
- **标注**：**新发现**（02-T7 计数了卡片域定时器，未计 RuntimePanel）

---

### S-05【中 · 新发现】主题时光过渡 60s 全量 applyTokens + documentElement style 写入，级联触发 02-X7 终端 MutationObserver 全屏 refresh

- **位置**：
  - 定时器：`src/api/themeStore.ts:392-403`（`setInterval(60000)` → `applyTokens`）
  - Token 注入：`src/services/TokenRuntimeController.ts:461-510`（data-theme 属性 + 约 18 个 `style.setProperty` + class toggle）
  - 终端观察者：02-X7 `useXtermTerminal.ts:227-263`（observe `documentElement` 的 `style` 属性）
- **现象**：`themeAutoTimeTransition` 开启时，后台每 60s 无条件 `applyTokens`（即使参数未变）。每次注入写 `documentElement` style 多属性 → 终端侧 MutationObserver 回调 → 每实例 `getXtermTheme`（~20 次 getComputedStyle）+ `term.refresh` 全屏重绘 × N 实例。
- **代码现场**：

```ts
// themeStore.ts:392-403
if (typeof window !== 'undefined' && !solarIntervalMounted) {
  solarIntervalMounted = true;
  setInterval(() => {
    if (currentPersonalization.themeAutoTimeTransition) {
      TokenRuntimeController.getInstance().applyTokens(
        currentPersonalization,
        currentTheme,
      );
    }
  }, 60000);
}
```

- **调用链**：60s tick → applyTokens（全量 setProperty）→ MutationObserver(style) → X7 的 updateTerminalStyles × N 终端 → 全屏 refresh。与 X7 已记录的「token 注入三轮 refresh」同族，但**源头是无人审计的 solar 定时器**（X7 只记了手动 token 注入与 window 事件）。
- **根因**：applyTokens 无「参数未变则跳过」守卫（`TokenRuntimeController` 有 `lastAppliedResult` 但未用于短路）；solar 粒度 60s 远粗于亮度实际变化需求（时段边界跳变为主）。
- **影响量化**：开启时光过渡 + 多终端时，每分钟一轮「全局 CSS 重写 + N 终端全屏重绘」；未开时光过渡为 0。与 02-X7 修复（debounce+去重）正交——修 X7 可缓解级联，修本条可消除源头空转。
- **修复建议**：① applyTokens 前比较 `computeDynamicSolarAdjustments` 输出与上次，全等则 return；② solar 定时器仅在跨时段边界时触发（或 5min）；③ 与 X7 批次 G 合并：终端 observer 对「仅 style 无 data-theme 变化」的 mutation 去重。
- **严重度**：**中**（依赖主题开关；与 X7 叠乘）
- **标注**：**新发现 + 对 02-X7 的增量证据**（补齐 solar 定时器这一未登记触发源）

---

### S-06【低 · 新发现】SettingsDevicesTab 3s 轮询与 StatusDiagnosticsPanel 5s 轮询：设置弹层打开期间常驻，无隐藏跳过

- **位置**：`SettingsDevicesTab.tsx:51`（`POLL_INTERVAL_MS = 3000`）、`:167-177`；`StatusDiagnosticsPanel.tsx:115`（`pollIntervalMs = 5_000`）、`:139-149`
- **现象**：设备 tab 3s 拉 `pairStatus+listDevices(+networkEnvInfo)`；诊断 tab 5s 拉引擎状态。设置弹层有 `backdrop-filter: blur(16-20px)`（`Dialog.module.css:18-26`），打开期间背景已在合成压力下，叠加轮询 IPC + setState。
- **增量说明**：03-V5 已标「SettingsDevicesTab 依赖 `[load]` 待确认」——本轮确认 `load` 为 `useCallback([])` 稳定引用（`SettingsDevicesTab.tsx:120-122`），**interval 不会因 load 重建**；轮询本身仍在。属对 03-V5 的闭环 + 轮询成本记账。
- **影响量化**：绝对量低（进程内 IPC）；打开设置 10 分钟 ≈ 设备 200 次 + 诊断 120 次状态拉取。`load` 有 `inFlightRef` 防重入，合理。
- **修复建议**：设置弹层关闭时确保卸载（现状 `showSettingsOverlay &&` 条件挂载，已正确）；诊断轮询可改「仅诊断 tab 激活时」；设备轮询可放宽到 5–10s。
- **严重度**：**低**
- **标注**：**新发现 + 03-V5 增量闭环**

---

### S-07【低 · 新发现】会话切换：`setActiveSessionFolder` 路径上动态 import + workspace 激活，与消息懒水合并行但无统一时序锚

- **位置**：`sessionCrudActions.ts:171-181`（`activateWorkspaceForSessionFolder` 动态 import）、`:179-181`（`triggerSessionMessageHydrateIfNeeded`）；水合实现 `sessionActivateHydrate.ts:19-83`
- **现象**：切换会话时并行触发：① workspace 文件夹激活（动态 import projectStore）；② 消息懒水合（动态 import sessionEventHydrate → 串行分页 IPC，03-V4 已记录上限）。两者无共享 AbortSignal/优先级——快速连续切换时，前一次水合循环会跑完（03-V4 已指出），workspace 激用也无取消。
- **与已有项关系**：03-V4 记录了水合不可取消；本条补充 workspace 激活并行无协调 + 动态 import 首次延迟。
- **影响量化**：快速切换 3 个会话 = 最多 3 路水合 + 3 次 workspace 激活竞态（后到覆盖前到，依赖 folder 语义）。当前正确性由「最后写入生效」保证，性能上浪费已完成的前序 IPC。
- **修复建议**：会话切换 token（activeSessionId 变更序号）贯穿水合与 workspace 激活，过期则 abort/丢弃；与 03-V4 批次 N 一并做。
- **严重度**：**低**（正确性无忧；浪费性）
- **标注**：**03-V4 的增量证据**

---

## 4. 搜索 UI / 斜杠命令 / 错误边界 / 骨架屏

### S-08【低 · 新发现】ComposerPermissionBar 倒计时 interval 依赖 timeLeft，每秒拆建一次

- **位置**：`src/components/chat-composer/ComposerPermissionBar.tsx:53-59`
- **代码现场**：

```ts
useEffect(() => {
  if (resolved || timeLeft <= 0) return;
  const timer = setInterval(() => {
    setTimeLeft((prev) => Math.max(0, prev - 1));
  }, 1000);
  return () => clearInterval(timer);
}, [resolved, timeLeft]);   // ← timeLeft 每秒变 → interval 每秒销毁重建
```

- **现象**：经典 interval 依赖陷阱——`timeLeft` 在 deps 中，每次 tick 后 effect 重跑，clearInterval + 新建 setInterval。
- **影响量化**：审批条存活期每秒多一次 effect 调度；绝对成本低，但模式与 02-T7 定时器治理同主题。
- **修复建议**：deps 改为 `[resolved, countdownSeconds]`，内部用函数式 setState；或改 `setTimeout` 链 / 共享时钟（T7 方案）。
- **严重度**：**低**
- **标注**：**新发现**（02-T7 未列此文件）

---

### S-09【低 · 新发现】useApprovalCountdown 100ms interval；InlineAgentPanel 每 running 子代理 1s interval——agent-card 域定时器未入 02-T7 清单

- **位置**：
  - `src/components/agent-card/useApprovalCountdown.ts:57-75`（`setInterval(..., 100)` → `setTimeoutPercent`）
  - `src/components/agent-card/InlineAgentPanel.tsx:73-85`（running 时 `setInterval(tick, 1000)`）
- **现象**：审批卡进度条 10Hz setState；每个 running 的行内子代理徽章 1Hz setState。多审批 + 多子代理并行时 interval 数线性增。
- **与 02-T7 关系**：T7 统计了 CompactToolRow（500ms）与 FoldableProcessSection（100ms）；agent-card 是**另一个组件域**的同类问题，审查边界外漏记。
- **影响量化**：3 审批 + 5 子代理 ≈ 8 个 interval，~30–50 次/秒 setState（各自局部，有 memo 可 bailout）。审批进度条 100ms 粒度视觉上过细，250–500ms 足够。
- **修复建议**：并入 T7 的「全局时钟 context」方案；审批进度条降为 250ms。
- **严重度**：**低**
- **标注**：**新发现**

---

### S-10【低 · 新发现】AppErrorBoundary 每消息行实例化（class 组件），虚拟窗口滚动时边界实例随行卸载重建

- **位置**：`MessageVirtualizer.tsx:447,478`（`<AppErrorBoundary key={msg.id} variant="minimal">`）；实现 `AppErrorBoundary.tsx:86+`（class，componentDidCatch + sessionStorage 熔断状态读写）
- **现象**：每条可见消息包一层 class ErrorBoundary。窗口滚动时行卸载 → 边界实例销毁；滚回 → 新实例。正常路径 `render` 仅透传 children，成本低；但 `getDerivedStateFromError` 路径有 sessionStorage 读写（错误时才走，正常无）。
- **影响量化**：正常滚动：每行多一个 class fiber，可忽略。错误风暴时：每边界写 sessionStorage + logger + errorStore，需熔断（已有 circuit）。**非性能热点，属结构记录**——若未来把 boundary 提到列表级（单边界包整窗）会损失故障隔离粒度，现状取舍合理。
- **修复建议**：不动；在 02 附录 A 补一行「消息行 ErrorBoundary 隔离成本已评估、可忽略」。
- **严重度**：**低（信息）**
- **标注**：**新发现（低价值，防误改）**

---

### S-11【中 · 新发现】Dialog 设置弹层 backdrop-filter: blur(16–20px) saturate(180–190%)：大模糊半径常驻于设置打开期间

- **位置**：`src/components/ui/Dialog/Dialog.module.css:18-26`（overlay `blur(16px) saturate(180%)` / panel `blur(20px) saturate(190%)`）
- **现象**：设置弹层打开时对背景做 16–20px 双层模糊 + 饱和。01 附录 A 写「全部 backdrop-filter 在局部浮层」——技术上成立，但设置弹层是**全屏级**浮层且打开期间用户常停留数分钟（模型配置等），模糊区域覆盖主工作区（含可能仍在流式的聊天背景）。
- **影响量化**：GPU 合成层每帧模糊背景；在流式 + 设置并开的场景（少见）与低端 GPU 上可感。saturate(180–190%) 额外增加滤镜成本。
- **修复建议**：降半径（8–12px）或对全屏弹层改「背景静态截图/纯遮罩」策略；至少去掉 saturate 或降为 100%；`@media (prefers-reduced-transparency)` 降级。
- **严重度**：**中**（GPU 侧；流式+设置叠加时）
- **标注**：**新发现**（01 记录了「局部浮层」定性，未量化全屏 Dialog 的模糊半径）

---

## 5. packages / Worker / 测试可闻性 / Rust 壳非事件路径

### S-12【低 · 新发现】Worker 池：仅 2 个 render worker 作 Rust 降级，compute/io=0——conversation-flow 投影与会话搜索均无 worker 卸载预案

- **位置**：`src/workers/worker-pool-options.ts:40-47`（默认 render=2、compute=0、io=0）；调用候选 `conversation-flow/host.tsx`、`sessionSearch.ts`
- **现象**：Stream E 改造后 compute/io worker 默认不建（注释说明任务已下沉 Rust）。S-01/S-02 的投影与搜索跑在主线程。当前量级可接受；若 conversation-flow 默认开启或搜索索引走前端，将成为 worker 需求点。
- **与 01-M7 关系**：M7 建议大 payload 事件转 compute worker——但 compute worker 默认 0，需显式启用。本条补记「扩展路径的 CPU 任务也未设计 worker 卸载」。
- **修复建议**：记录为决策点——conversation-flow 若产品化默认开，投影应上 compute worker 或 Rust 侧投影；会话搜索优先走已有 Rust 索引而非前端 worker。
- **严重度**：**低**（规划项）
- **标注**：**新发现**

---

### S-13【低 · 增量证据】重渲染监控套件覆盖流式/工具/DiffCard，未覆盖 conversation-flow host、侧栏搜索、RuntimePanel 秒针

- **位置**：`src/__tests__/reRenderMonitoring.test.tsx`（流式 0 渲染、工具区=事件数、DiffCard 无关 store 隔离——覆盖良好）；缺口：`extensions/conversation-flow/host.tsx`、`useSessionSearch.ts`、`RuntimePanel.tsx`
- **说明**：现有监控是 01-P6 的正面资产。本轮 S-01/S-02/S-04 若修复，应补：
  1. conversation-flow 激活下「工具事件 ×20 → projectMessage 调用计数」；
  2. 侧栏搜索「非搜索态 sessions 引用变 → sort 执行次数 ≤1 且命中缓存」；
  3. RuntimePanel「tab 不可见时 setNow 调用 = 0」。
- **严重度**：**低**（测试资产缺口说明）
- **标注**：**对 01 测试锚点的增量建议**

---

### S-14【低 · 信息】Rust 壳非事件路径速记（auth / browser / multi_device）

| 路径 | 证据 | 结论 |
| ---- | ---- | ---- |
| multi_device 命令 | `multi_device_commands.rs:42-45`（pair_status 同步读内存状态机）、`:58-61`（list_devices 内存 Vec） | 低成本；前端 3s 轮询见 S-06 |
| multi_device 网络探测 | `multi_device_commands.rs:97`（`network_info` async） | 仅配对引导时调用，非热路径 |
| auth 命令面 | `auth_commands.rs:14-81`（login/logout/refresh/list_devices 均 async） | 低频云 API，无热路径问题 |
| browser 命令面 | `browser_commands.rs:129+`（start/stop/frames/input 等 async） | 浏览器工具执行期才有；output 经 tool-end 走 03-R6/C2 既有约束 |
| **结论** | — | **非事件路径无与 03 重复的高危项**；auth/browser 不在 01–03 需展开范围 |

---

## 6. 汇总表

| ID | 严重度 | 类型 | 一句话 | 建议并入 |
| -- | ------ | ---- | ------ | -------- |
| S-01 | 高 | 新发现 | conversation-flow 激活后全量 projectMessage 重投影 + data 属性计数 | 01 批次 C 旁注 / 02 T 域 |
| S-02 | 中 | 新发现 | 侧栏搜索全语料内容扫描，非搜索态仍 copy+sort | 02 覆盖面 / 01 L 域升级 |
| S-03 | 中 | 新发现 | flow 与 timeline 双投影缝合，互不复用 | 01-M4 关联注 |
| S-04 | 中 | 新发现 | RuntimePanel 1s 秒针 + display:none 存活 | 02-T7 / C9 扩展 |
| S-05 | 中 | 新发现+增量 | solar 60s applyTokens 空转 + 级联 X7 终端 refresh | **02-X7 批次 G** |
| S-06 | 低 | 新发现+增量 | 设置页轮询记账；03-V5 load 稳定性闭环 | 03-V5 尾注 |
| S-07 | 低 | 增量 | 会话切换 workspace 激活与水合无取消协调 | 03-V4 批次 N |
| S-08 | 低 | 新发现 | ComposerPermissionBar interval 每秒拆建 | 02-T7 |
| S-09 | 低 | 新发现 | agent-card 域 100ms/1s 定时器未入 T7 | 02-T7 |
| S-10 | 低 | 新发现 | 消息行 ErrorBoundary 成本可忽略（防误改） | 02 附录 A |
| S-11 | 中 | 新发现 | 设置 Dialog 16–20px backdrop-filter 全屏模糊 | 01 附录 A 修正 |
| S-12 | 低 | 新发现 | worker compute=0，扩展路径无卸载预案 | 03 / 规划 |
| S-13 | 低 | 增量 | 监控套件未盖 flow host/搜索/RuntimePanel | 01 测试锚点 |
| S-14 | 低 | 信息 | auth/browser/multi_device 非事件路径无新高危 | 03 备忘 |

**计数**：新发现 11 + 增量闭环/证据 3（S-05/S-06/S-07/S-13 兼具）；按严重度 **高 1 · 中 5 · 低 8**（S-01 高；S-02/03/04/05/11 中；其余低）。

> 若将 S-01 的「激活后」视为产品未来默认路径，可升格为「高（条件）」；默认关闭现状下正式报告建议标注 **feature-on 高危**。

---

## 7. 建议并入正式报告的 TOP3

1. **S-01 → 并入 01（或 02 卡片/投影域）**：conversation-flow host 全量重投影与 data 属性计数是与 H1/M4 同构的「增量设计被当一次性 API」问题；若产品路线图计划默认开启扩展，应进修复路线图批次。
2. **S-05 → 并入 02-X7（批次 G）**：solar 定时器是 X7 未登记的第三触发源；修 X7 时必须把 `themeStore.ts:392-403` 一并纳入去重/短路，否则终端 observer 仍会被 60s 心跳打中。
3. **S-02 → 新列覆盖面（02 或 01 L 域）**：侧栏会话搜索是 01-Q3 虚拟化终图与 02 检查范围都未覆盖的内容级扫描路径；`TOOL_TEXT_MAX` 只是单字段护栏，不是会话语料级护栏。优先做「非搜索态跳过 sort + 标题短路」两行级修复。

**次优并入**：S-04（RuntimePanel 秒针，与 C9/T7 合并）、S-11（Dialog 模糊半径，修正 01 附录 A「全部 backdrop-filter 在局部浮层」的定性）、S-08/S-09（并入 T7 时钟治理）。

---

## 8. 附录：本文件检查过且未立项的区域

| 区域 | 结论 |
| ---- | ---- |
| FontSelectField / SettingsSidebar 搜索 | 短列表过滤，无内容级扫描，OK |
| ModelsSettingsTab / YamlConfigEditor | 懒加载 Suspense（`SettingsPanel.tsx:31`）；YAML 搜索为编辑器内字符串 includes，低频 OK |
| CheatsheetModal 搜索 | 快捷键表短列表，OK |
| note-paper / block-paper | 未在聊天路径；与 conversation-flow 分离（import-boundary 测试锁定） |
| ScrollArea 50ms 脉冲 | 仅按住滚动条按钮时，交互态，可接受 |
| Tooltip portal | 按需挂载 + 单 portal + 孤儿 rAF 清理测试完备（02-T12 同族），OK |
| multi_device / auth Rust 命令 | 内存读或低频 async，见 S-14 |
| ComposerPlanProgressBar 1s elapsed | 仅 plan 模式运行中，单实例，低 |

---

*本文件为静态补充审查；S-01/S-02/S-05 建议在对应正式批次修复时回填验证结论。禁止直接改 01–03 正文——由主 Agent 按 §7 摘取并入。*
