# detail-D6D7D8 · 传输收敛 + 流式/卡片 + 终端/Diff/合成 · 分维详案

> **战役**：performance-fix  
> **主责案底**：D6 = `independent-05`（粒度）+ `independent-01`（交叉）；D7/D8 = `independent-03`  
> **上位定稿**：`92-修复总方案.md` §4/§5/§6/§7/§9；评审裁决 CFL-05 / CFL-10 / CFL-16  
> **输入（只读）**：92；independent-03/05；CFL-05/10/16；01/02/03/12/15 报告锚点；生产代码走读  
> **性质**：执行分维详案（非总案）；三维**文件域互斥表**强制  
> **创建**：2026-09-13  
> **禁止**：git commit；删空 `highlight.batch`/worker 冒充 12-D1；伪 memo；PE-02 未会签做 token 合并；真缓冲 flush 在本维重复实现（归 **D1**）；双发消除在本维实现（归 **D11**）

---

## 0. 三维边界总览（先读）

```text
D0 预算 SSOT
  → D2 ∥ D1 引擎减载（NoPersist / 真缓冲 flush / 审计有界）
      → D3 写单轨 → D4 persist 出口 → D5 驱逐
          → D6 传输收敛（单 parse / 轮询分票 / meta-only 旁路）
              → D7 流式增量化与卡片 memo
              → D8 终端 / Diff / 合成（可与 D7 并行：文件域不相交）
```

| 维 | 概念一句话 | 不做什么（边界外） |
| -- | ---------- | ------------------ |
| **D6** | 数据面事件 **parse 恰 1**；轮询 **单源分票**；旁路 **meta-only** | 真缓冲 flush 调度（D1）；双发回执/schema（D11）；PE-02 合并（D11 会签后）；可见性背压（D11 设计） |
| **D7** | 流式 **O(delta)** 派生 + **先收窄注入再 memo** + expandedTools per-message + timeline；**will-change 契约与流式 CSS 同票** | persist/驱逐（D4/D5）；终端 write 门闩（D8）；Diff worker 接线（D8）；布局属性 will-change 群与 table pulse（D8 合成） |
| **D8** | 隐藏终端 **write=0**；PTY **合批（无 PE-02）**；Diff **接线** `highlight.batch`；WebGL 恢复；剩余合成层 CSS | 流式 splitter/hash（D7）；卡片 memo 链（D7）；`engine_channels` 真缓冲（D1）；删空 worker 通道（禁，CFL-05） |

**与 D1 交叉点（强制移交）**

| 交叉 | 说明 | 处置 |
| ---- | ---- | ---- |
| 真缓冲 `push_live` 条件 flush | 01-L4-C / 03-R7 | **归 D1**；D6/D7/D8 **不得**改 `engine_channels` flush 时机；本详案只登记「D6 消费端兼容条件 flush 节奏」为回归场景 |
| NoPersist 事件不进 EventRouter parse | D1 跳取号后数据面事件集不变 | D6.1 仍以 `isDataPlaneEventType` 前移为准；与 D1 无文件冲突 |
| 工具输出事件载荷 | D1 出口截断 | D7 卡片链只读 store；不在本维改 `executing_tools` |

**与 D11 交叉点（强制移交）**

| 交叉 | 说明 | 处置 |
| ---- | ---- | ---- |
| 双发消除（03-R2 / CFL-16） | webview 降回执 + 旁路完整事件 | **归 D11 强契约票**；D6 只保证单 parse / meta-only 与回执信封**兼容**（回执类型若新增，D6.1 短路表可扩展，不提前实现） |
| message-start 瘦身 / tool-batch NoPersist / PE-02 | schema T2 | **归 D11**；D8 PTY 合批**无 PE-02 约束**（PTY 独立通道，见 §3 D8.2） |
| 顺序契约 PR-ORDER / ToolStart 实时 | 05-D1.8 | 不在 D6；与 EventRouter 无实现耦合 |

**并行铁律**

1. D6 ∥ D8：文件域不相交，可并行。  
2. D7 ∥ D8：流式 CSS（`streaming-animation.css` + 契约测试）归 D7；终端/Diff/其余合成 CSS 归 D8——**禁止**同文件双 Agent。  
3. D7 内部顺序：**先注入面收窄与 expandedTools 粒度，再 React.memo**（92 §5 禁反例 6）。  
4. D6 内部按 CFL-10：**V1 / V2 / V3 / V4 / meta-only 分票**，禁止 01-L4-A 大包单票。

---

## 1. D6 · 传输收敛（单 parse / 轮询分票 / meta-only）

### 1.1 做什么（映射 90 ID）

#### D6.1 · 数据面事件单 parse（03-V1 / 01-DEL-10 · CFL-10 第一票）

| 项 | 内容 |
| -- | ---- |
| 现状 | `EventRouter.ts:219` `resolveEventType` → `:225-227` `parseBridgeEvent(raw)`；`handleAgentEvent:152` 对 `isDataPlaneEventType` **先 parse 后丢弃**；`dataPlaneRouter` 另 parse 一次 → 数据面 ×2 |
| 目标 | 数据面事件在 EventRouter **0 次** `parseBridgeEvent`；dataPlane 侧 **恰 1 次** |
| 逻辑步骤 | ① `onMsg`：`resolveEventType` 得 `envelope.type` 后立即 `isDataPlaneEventType` → **直接 return**（或仅转发 `{type, raw}` 给 dataPlane 订阅），禁止进入 `parseBridgeEvent`；② `resolveEventType` 结果随已解析 envelope 复用（fanout 传 `{type, raw}`，下游禁止二次 resolve）；③ 单测：task-*/timer-*/cron-fired 的 `parseBridgeEvent` 调用计数 = 0；dataPlaneRouter 侧 = 1 |
| 契约 | T0 |
| 路径 N→M | 事件数据面 parse **2 → 1** |

#### D6.2 · 轮询双源收敛（03-V2 + 03-I5 · CFL-10 第二票）

| 项 | 内容 |
| -- | ---- |
| 现状 | `useBackgroundTaskPolling` 独立 `list_background_tasks` invoke（链 B）；链 A 已经 `engineStore.bgTasks` 拉取；`FlowDagView` `get_flow_snapshot` 无超时；`getSubagentStatus` 恒 null 死定时器 |
| 目标 | 后台任务列表 **单源**（engineStore / 链 A）；稳态 IPC 计数可测下降；死定时器物理删除 |
| 逻辑步骤 | ① 链 B 改为订阅 `engineStore.bgTasks`，或整函数删除并改调用点消费链 A；② `FlowDagView` 的 `get_flow_snapshot` 补超时；③ `getSubagentStatus` 死代码删除；④ 命令响应形状若需统一（03-V2 备注），**不**在本票改 manifest——形状变更挂 D11 登记，本票只收敛调用路径 |
| 契约 | T0（不改命令响应形状） |
| 路径 N→M | bg 轮询源 **2 → 1** |

#### D6.3 · invoke 悬挂治理（03-V3 · CFL-10 第三票）

| 项 | 内容 |
| -- | ---- |
| 现状 | `tauriTransport` / `tauriInvoke` 轮询 tick 与重试无 in-flight 互斥；错误 kind 不分类重试 |
| 目标 | 引擎卡死模拟下悬挂 invoke ≤ 1；`InvalidInput`/`NotFound` 不重试 |
| 逻辑步骤 | ① `kind` 分类接入重试判定；② 轮询 tick in-flight 互斥；③ 重试微退避（常量进 D0 `perfBudgets` / `perf_budget`，禁散落魔数） |
| 契约 | T0 |

#### D6.4 · 水合可取消 + 增量投影（03-V4 · CFL-10 第四票）

| 项 | 内容 |
| -- | ---- |
| 现状 | `sessionEventHydrate.ts` 切会话后旧页 fetch 继续写；每页保留原始事件 |
| 目标 | AbortSignal 贯穿；每页投影后丢弃原始事件；可选预取下一页 |
| 逻辑步骤 | ① `fetchSessionEvents` 接受并传播 `AbortSignal`；② 投影闭包内 `events = []` 释放；③ 并发预取（可选）不阻塞主路径 |
| 契约 | T0 |

#### D6.5 · 旁路 meta-only / Arc 共享（03-R5、15-FAN01、15-PSHP03、15-XOV01 部分）

| 项 | 内容 |
| -- | ---- |
| 现状 | `fanout.rs` `parse_event_meta` / `from_value(value.clone())` 全量 Value；push `on_event` 全量 `AgentEvent` 反解析 |
| 目标 | emit 侧同步产出轻量 `EventMeta { type, sessionId, sequence, backpressure, … }`；fanout/push **零全量** AgentEvent parse |
| 逻辑步骤 | ① 信封构造点（`core_event_bridge` / emit 路径）一次构造 EventMeta；② fanout `parse_event_meta` 改消费 EventMeta 或扁平前缀单次扫描；③ `PushAwareEmitter::on_event` 同构；④ 多端 XOV：fanout+push **共用** meta，禁止各全量 parse；⑤ 单测：热路径 `AgentEvent` 反解析计数 |
| 契约 | T0（元字段语义不变） |
| 路径 N→M | 旁路全量 parse **≥1 → 0**（每事件 meta 构造 **1** 次） |

> **装配开关**：fanout/push 槽 None 时零开销——验收须显式打开装配再测（01 已登记待核）。

### 1.2 删什么（删除/合并 + 负向断言）

| # | 删除/收敛项 | 位置 | 负向断言 |
| - | ----------- | ---- | -------- |
| 1 | EventRouter「先 parse 后丢弃数据面」路径 | `EventRouter.ts:152` 前移短路 | 数据面事件 `parseBridgeEvent` 计数 = 0 |
| 2 | `useBackgroundTaskPolling` 独立 invoke 轮询 | hooks 调用链 | `useBackgroundTaskPolling` 内 `list_background_tasks` invoke 0 命中（或文件删除） |
| 3 | `getSubagentStatus` 恒 null 死定时器 | 调用点 | grep 0 命中 |
| 4 | 无 kind 全量重试 + 无互斥 tick | `tauriTransport`/`tauriInvoke` | 卡死模拟悬挂数 ≤ 1；InvalidInput 不重试 |
| 5 | 水合无 Abort + 页内原始事件驻留 | `sessionEventHydrate.ts` | 切会话后 0 新增 IPC（探针） |
| 6 | fanout `value.clone()` + 全量 meta 反解析 | `fanout.rs` | 热路径无 `from_value(value.clone())`；无全量 AgentEvent parse |
| 7 | push 侧全量 AgentEvent 反解析 | `push/pusher.rs` | 仅 EventMeta 消费 |

**删除面总表登记（92 §6 对应）**：「双 parse 数据面」主责维 = **D6**。

### 1.3 依赖与逻辑序

```text
D0 预算（微退避/水位常量可先登记）
  → D6.1 ∥ D6.5   （前端 transport ∥ Rust fanout/push，文件域不相交）
      → D6.2 ∥ D6.3 ∥ D6.4  （可与 6.1 并行若文件不碰同一测试；建议 6.1 绿后合入，避免探针双改）
```

**禁止**

- 把 D6.1–D6.4 绑成单 PR（CFL-10：以 05 D1 粒度分票）。  
- 在 D6 改 `engine_channels.rs` 真缓冲 flush（D1）。  
- 在 D6 实现 webview 回执/双发消除（D11）。  
- 06 的「账本删除」与 parse 短路同 PR 强耦合（CFL-10 裁决：账本独立串行票）。

### 1.4 唯一文件域（与并行维互斥）

| 路径 | D6 角色 |
| ---- | ------- |
| `apps/crish-desktop/src/api/chat-bridge/EventRouter.ts` | 主 · D6.1 |
| `apps/crish-desktop/src/api/chat-bridge/dataPlaneRouter.ts` | 主 · 短路配合 / 类型集 |
| `apps/crish-desktop/src/api/transport/tauriTransport.ts` | 主 · D6.3 |
| `apps/crish-desktop/src/api/transport/tauriInvoke.ts`（或等价 invoke 封装） | 主 · D6.3 |
| `apps/crish-desktop/src/hooks/useBackgroundTaskPolling.ts`（及调用点） | 主 · D6.2 |
| `apps/crish-desktop/src/hooks/useEngineState.ts` / `FlowDagView.tsx`（仅轮询消费侧） | 主 · D6.2 |
| `apps/crish-desktop/src/api/sessionEventHydrate.ts` | 主 · D6.4 |
| `apps/agent-workbench/src-tauri/src/server/fanout.rs` | 主 · D6.5 |
| `apps/agent-workbench/src-tauri/src/server/push/pusher.rs` | 主 · D6.5 |
| meta 产出点：`core_event_bridge.rs` 或 emit 信封构造（实现定位） | 主 · D6.5 |

**互斥声明**

- **D7 不写**上述 transport/EventRouter/fanout。  
- **D8 不写** transport；PTY 的 Rust 在 `pty/session.rs`（D8 独占，与 fanout 不同文件）。  
- **D1** 独占 `engine_channels.rs` / buffer flush；D6 只读回归。  
- **D11** 独占 `engine-events.json` / `events.rs` / 生成 parser；D6.1 若回执类型将来进 dataPlane 短路表，只扩 `isDataPlaneEventType` 集合，不改 schema。

### 1.5 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | task/timer/cron 仍由 dataPlane 消费；活跃 run 事件不丢；水合切会话无脏写 |
| 负产出 | §1.2 七项勾选 + 负向单测全绿；新增 TODO = 0 |
| 五端物证 | 触发=后台任务输出+run；传输=parse 计数探针；介质=n/a（不改 DB）；消费=task store / hydrate；负出=EventRouter/dataPlane 单测 ID |
| 运行时 V | 03-V1 双发确认基线（只读观测，消除归 D11）；03-V4 数据面双解析 → ×1；03-V7 旁路大 payload parse 时长（meta-only 后）——经 **4000 Tauri MCP** |
| 逻辑路径 | 数据面 parse **2→1**；轮询源 **2→1**；旁路全量 parse **→0** |

### 1.6 防御脚本 / 守护测试增量

| 资产 | 断言 |
| ---- | ---- |
| EventRouter 单测扩展 | 数据面 `parseBridgeEvent` 计数 0；非数据面仍 =1 |
| dataPlane 单测 | 自有 parse =1 |
| 探针/单测 | 稳态 `list_background_tasks` IPC 比（相对修复前减半） |
| Rust 单测 | fanout/push 热路径无全量 AgentEvent parse（计数或 code-path 断言） |
| hydrate 单测 | abort 后 fetch 回调不写 store |

---

## 2. D7 · 流式增量化与卡片 memo（含流式 will-change 同票）

### 2.1 做什么（映射 90 ID）

> **强制序**：D7.1 流式热路径 → D7.2 注入面收窄 → D7.3 expandedTools 粒度 → D7.4 props 稳定 → D7.5 memo 链 → D7.6 timeline → D7.7 will-change CSS+契约同票。  
> **D7.2–D7.5 完成前禁止宣称卡片 memo 完成**（禁伪收敛）。

#### D7.1 · 流式切分与派生真增量化（01-H1/H2/M3 · 03-D1）

| 项 | 内容 |
| -- | ---- |
| 现状 | `useStreamingBlocks.ts:67` 静态 `IncrementalBlockSplitter.split(fullText)` 每帧全量；实例 API `appendChunk` 未作热路径；`hash16` 封口前每帧全文；strip 双调用点 + 整 clear |
| 目标 | 热路径唯一 `appendChunk`；冷路径（首帧/回放/`isStreaming=false` 重建）允许一次全量；封口块哈希恰一次 |
| 逻辑步骤 | ① Hook `useRef` 持有 splitter，`messageId` 变更重建；② 传入 delta 或 Hook 内算前缀增长长度，**禁止每帧全量 split**；③ 封口时算 hash 存 descriptor，后续帧引用相等短路；④ strip 单入口：MessageContent / ProcessItemRenderer 共享一次 strip 结果；流式接线 `IncrementalThoughtStripper` 或 LRU（二选一，禁第三态）；⑤ 等价性测试：增量 vs 全量 split 逐块相等 |
| 契约 | T0 · INV-6 / FE-INV-1 |
| 路径 N→M | 流式块切分 **2→1**；全文哈希路径 **N→1（仅封口）** |

#### D7.2 · 流式注入面收窄（02-T3 · memo 前置）

| 项 | 内容 |
| -- | ---- |
| 现状 | `MessageContent.tsx:400/540` 向 ProcessItem/工具链传 `streamingTextContent`；非活跃卡仍可能收到全文/共享 streamText |
| 目标 | **仅** `msg.id === streamingMessageId && isStreaming` 时注入；历史卡 **undefined 且引用稳定** |
| 逻辑步骤 | ① 装配层按活跃 messageId 计算注入；② 历史消息 props 对象 `Object.is` 稳定（无新建 `streamingTextContent` 字符串）；③ 用户行流式期渲染计数 = 0（01-H3 交叉，在装配层一并断言） |
| 契约 | T0 · FE-INV-6 |

#### D7.3 · expandedTools per-message（02-T1 · memo 前置）

| 项 | 内容 |
| -- | ---- |
| 现状 | `useChatMessageState.ts:108-121` `expandedToolsBySession[sessionKey]` 会话级单对象 → toggle 击穿全列表 |
| 目标 | 展开状态 **per-message**（或 per-toolId 订阅面）；toggle 只变更目标消息 map 引用 |
| 逻辑步骤 | ① 状态键改为 messageId（或 session+message 复合且值不可变更新目标槽）；② 行组件只订阅本 message 的 expanded 引用；③ 其余消息 `expandedTools` 引用不变；④ 单测：单卡 toggle 后其它行 props shallow 相等 |
| 契约 | T0 · FE-INV-5 |
| 路径 N→M | 展开状态粒度 **会话级 → per-message** |

#### D7.4 · props 稳定 + 卡片链 memo（02-T2/T4/T5/T6/T7 · 01-M10）

| 项 | 内容 |
| -- | ---- |
| 现状 | CompactToolRow / ChatToolStack / MessageToolCallsSection / ToolCallHeader/InputPane/OutputPane/DiffPreview 等无 memo；`hostProps`/`onInvalidate` 内联；展开 max-height 动画；per-card 定时器增殖 |
| 目标 | 每级 `React.memo` + 显式比较器；内联对象/回调清零；定时器单例/visibility 感知 |
| 逻辑步骤 | ① 依赖 D7.2/D7.3 后，再 memo；② 比较器字段与既有 `toolStackSharedPropsEqual` / `chatMessageRowUtils` 同法；③ `toolStackProps`/`hostProps` useMemo；④ T4 昂贵派生移出渲染体或封口时；⑤ T5 展开挂载先便宜路径（Diff 高亮异步衔接 **D8.3**，本维只保证不挡挂载）；⑥ T6 禁 0→2000 max-height；⑦ T7 running/live 定时器合并 |
| 契约 | T0 |

#### D7.5 · timeline 签名增量（01-M4 · 02-T11 同簇）

| 项 | 内容 |
| -- | ---- |
| 现状 | timelineSignature 全量 stringify；尾块变更导致历史签名重算 |
| 目标 | 历史 text 块签名不因尾块变更重算；子块缓存 |
| 逻辑步骤 | ① 签名按已封口块摘要累积 + 尾块瞬时哈希；② `timelineCache.ts` 接入；③ 流式帧历史块渲染计数 = 0 |

#### D7.6 · will-change 契约测试反转 + 流式 CSS 同票（12-W1 · 评审 03 M3）

| 项 | 内容 |
| -- | ---- |
| 现状 | `streaming-animation.css:31` `will-change: opacity, transform` 常驻；`streamingAnimationContract.test.ts:80-81` **断言必须声明**——锁定错误行为 |
| 目标 | animate span 的 will-change **仅动画存活期**（animationend / 封口移除）；契约改为「非常驻」负向断言；**CSS 与测试同一 PR** |
| 逻辑步骤 | ① CSS：常驻 will-change 删除或仅 animation 存在期（`:where(.streaming-word.is-animating)` 类钩子）；② 契约测试改写：① 元素不得在非 animate 状态常驻 will-change；② animate 期存在（或改为完全删除 will-change 并断言文件无该声明——实现二选一，与 03-W1 收敛一致，禁止第三态）；③ 长输出流式合成层峰值回填 12-V1 |
| 契约 | T0 |
| **同票铁律** | 只删 CSS 不改测试 → 门禁红；只改测试不删 CSS → 效果缩水。二者必须同 PR |

### 2.2 删什么

| # | 删除/收敛项 | 位置 | 负向断言 |
| - | ----------- | ---- | -------- |
| 1 | 热路径静态 `split(fullText)` | `useStreamingBlocks.ts:67` | 生产热路径 grep 无静态 split 调用（冷路径专用函数可留） |
| 2 | 每帧全文 hash16 | useStreamingBlocks | 流式帧 hash 调用次数 = 封口次数 |
| 3 | strip 双调用点 + 缓存整 clear | markdownRenderLite + 调用点 | 单路径；无整 clear 热路径 |
| 4 | 死增量高亮器 / 未接线 stripper（01-L1/M3 二选一终态） | 01-L1 登记处 | 物理删除 **或** 真接线；禁 `@ts-expect-error` 留尸 |
| 5 | 会话级 expandedTools 列表 prop | useChatMessageState | 无 session 级共享 map 作为列表 prop |
| 6 | 非活跃卡 streamingTextContent 注入 | MessageContent | 历史卡该 prop undefined |
| 7 | 无 memo 裸导出 + 内联 hostProps | chat-tool-call/* | memo 导出；无对象字面量热路径 |
| 8 | 无界 per-card interval | 卡片链 | 单例或 visibility 感知 |
| 9 | 流式 span 常驻 will-change | streaming-animation.css | 契约测试新负向全绿 |

### 2.3 依赖与逻辑序

```text
D0（perfBudgets：尾块阈值等）
  → D7.1 流式增量化
      → D7.2 注入面收窄
          → D7.3 expandedTools per-message
              → D7.4 props + memo
                  → D7.5 timeline（可与 7.4 并行若 timelineCache 独立）
  D7.6 CSS+契约（可与 D7.1–7.5 并行：文件域仅 CSS+测试）
D7 ∥ D8（除 MessageContent 边界协调外）
```

**禁止**

- 无比较器 memo 或 props 仍每帧新对象却宣称收敛。  
- 未收窄注入就 memo 全卡片链。  
- 将 will-change 删除与契约反转拆 PR。  
- 本维改 Diff 主路径同步 hljs → **移交 D8.3**。

### 2.4 唯一文件域

| 路径 | D7 角色 |
| ---- | ------- |
| `components/chat-message-row/useStreamingBlocks.ts` | 主 · D7.1 |
| `api/markdown/IncrementalBlockSplitter.ts` | 主 · D7.1 |
| `api/markdownRenderLite.ts` / thought stripper | 主 · D7.1 |
| `components/chat-message/MessageContent.tsx` | 主 · D7.2（注入面） |
| `components/chat-message/ProcessItemRenderer.tsx` | 主 · D7.2 |
| `components/chat-message-list/useChatMessageState.ts` | 主 · D7.3 |
| `components/chat-tool-call/*`（含 CompactToolRow、ChatToolCallBlock、ToolCall*、FoldableToolGroup） | 主 · D7.3–7.4 |
| `api/tool-presentation/toolExpansionState.ts` / `toolCardPresenter.ts` | 主 · D7.3 |
| `api/tool-presentation/timelineCache.ts` | 主 · D7.5 |
| `components/chat-message-row/streaming-animation.css` | 主 · D7.6 |
| `components/chat-message-row/__tests__/streamingAnimationContract.test.ts` | 主 · D7.6 |
| `components/chat-message-row/ChatAssistantMessageRow.tsx`、`chatMessageRowUtils.ts` | 主 · D7.3–7.4 边界 |

**互斥**

- D8 独占：`ptyLifecycle` / `useXtermTerminal` / `ptySessionApi` / `pty/session.rs` / `DiffCard*` / `WidgetDiff` / `ToolCallDiffPreview` / `workers/render-worker.ts` / `codeHighlight.ts` 入口分工 / 非流式合成 CSS。  
- D4/D5 独占 sessionStore persist 与驱逐；D7 只读消息数组。  
- 若 D8.3 需要 ToolCallOutput 挂载点协调：**只读** MessageContent，写权在 DiffCard 子树。

### 2.5 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 流式、卡片展开、折叠、工具 diff 预览交互与修复前一致 |
| 不变量 | FE-INV-1 / FE-INV-5 / FE-INV-6；INV-6 |
| 负产出 | §2.2 九项；无第二条流式全量 split 热路径 |
| 五端物证 | 触发=流式+单卡展开；传输=delta 事件（只读）；介质=n/a；消费=blocks/卡片 DOM 计数；负出=reRenderMonitoring + 契约测试 |
| 等价性 | 增量 split vs 全量 split 输出逐块相等 |

### 2.6 防御脚本 / 守护测试增量

| 资产 | 断言 |
| ---- | ---- |
| `reRenderMonitoring` | 流式帧历史块渲染 0；单卡展开其它消息 0；user 行 0 |
| streamingAnimationContract | **反转后**：非常驻 will-change；（或文件无 will-change） |
| IncrementalBlockSplitter 单测 | 增量等价（已有基线保留） |
| 可选 `check-memo-props` | 热点组件 props 稳定性模式（可先 warn，D0/D13 接线） |
| `check-will-change`（布局属性群） | **主责 D8**；D7.6 合并前若脚本未上，契约测试仍须绿 |

---

## 3. D8 · 终端 / Diff / 合成（Webview 重路径）

### 3.1 做什么（映射 90 ID）

#### D8.1 · 隐藏终端 write=0（02-X1 · 08-M2/M7 · FE-INV-7）

| 项 | 内容 |
| -- | ---- |
| 现状 | `TreeLeafPanel` 非活跃 tab `display:none` 仍全量挂载；`ptyLifecycle.ts:311-314` `subscribePtyOutput` → 无条件 `term.write`；history 重放 `:171-174` |
| 目标 | 隐藏期 `term.write` 调用 = 0；chunk 只进 history（降采样策略）；显现时重放 |
| 逻辑步骤 | ① 可见性门闩：tab active / 面板非 `display:none`（与 TreeLeafPanel 激活态同源）；② 隐藏：写入 history，**不** `term.write`；降采样进 `perfBudgets.PTY_*`；③ 显现：合并单次大 write 或 writeSync 分块重放；④ 与 X8 重放防抖合并（cwd 依赖、`restartToken` 死参数清理）；⑤ history 计量：byte length 随 chunk 携带或 Blob.size，删除每 chunk TextEncoder |
| 契约 | T0 |
| 路径 N→M | 隐藏终端 write 路径 **1（无条件）→ 0（门闩）** |

#### D8.2 · PTY 后端合批（02-X2 · **无 PE-02**）

| 项 | 内容 |
| -- | ---- |
| 现状 | `pty/session.rs` reader 线程每读块 `app_reader.emit` 一次（≤8KB 级零合批）；与 PE-02（LLM delta）**无关**——PTY 独立通道 |
| 目标 | read 侧 **64KB / 时间窗** 合批 emit（常量进 D0 budget） |
| 逻辑步骤 | ① reader 循环聚合 buffer 至字节水位或时间窗；② exit/EOF 时 flush 残余；③ 不修改 LLM streaming 合并语义；④ **禁止**借本票提前做 PE-02 token N 合 1 |
| 契约 | T0（PTY 内部）；**明确无 PE-02 约束** |
| 路径 N→M | PTY emit 次数/字节 → 窗口内 O(1)/窗口 |

#### D8.3 · Diff **接线** `highlight.batch`（12-D1 · CFL-05 强制）

| 项 | 内容 |
| -- | ---- |
| 现状 | `DiffCardUnifiedView` / `DiffCardSplitView` / `WidgetDiff` / `ToolCallDiffPreview` 主线程 `highlightCode`/`highlightCodeSafe`；`render-worker.ts:27` `highlight.batch` **生产零消费** |
| 目标 | Diff 主路径：行收集 → `highlight.batch` 一次调度 → 回填 HTML；主线程无同步长 hljs 任务 |
| 逻辑步骤 | ① Diff 展开挂载：收集可见行 `{id, code, language}` → worker batch；② 回填按 id map；③ 短文件可保留 sync 短路径但 **超阈值强制 worker**（阈值进 budget `DIFF_HIGHLIGHT_LINE_CHUNK` 等）；④ `codeHighlight.ts` 入口分工：sync 安全路径 vs async batch API（新增生产调用封装，**禁止**测试-only 旁路）；⑤ 保留 `highlightCodeSafe` ReDoS 盾；⑥ 与 D7.4-T5 衔接：展开先便宜布局，高亮异步不阻塞首帧结构 |
| 契约 | T0（前端 worker 协议，非 engine-events） |
| **CFL-05 铁律** | **默认接线**；**禁止**物理删除空通道/worker 冒充 12-D1 完成；否决接线须书面降级效果锁（附录 C 式留痕），且不得用「死层清理」冒充运行时收益 |
| 路径 N→M | Diff 主线程同步 hljs 热路径 **N → 0**（短路径 cap 内例外须登记行数阈值） |

#### D8.4 · WebGL 上下文恢复（02-X3）

| 项 | 内容 |
| -- | ---- |
| 现状 | WebGL 丢失无 `webglcontextlost` 处理；多终端上下文耗尽后永久 DOM |
| 目标 | onContextLoss 事件化 + 限次恢复 + 遥测 |
| 逻辑步骤 | ① xterm canvas 监听 `webglcontextlost` / `restored`；② 限次重建 renderer（次数进 budget）；③ 超限降级 DOM renderer 并可观测；④ 与 D8.1 隐藏门闩正交：恢复逻辑在**再现**路径 |
| 契约 | T0 |

#### D8.5 · 剩余合成层 CSS（12-W2/W3 · 12-T1 · 12-B1 · 03-D8 残留）

| 项 | 内容 |
| -- | ---- |
| 现状 | Tabs/SegmentedControl/Switch/Toast/ScrollArea/PaneHeader/BinaryTree 布局属性 will-change；侧栏会话行常驻 transform；StreamingTableContainer 流式无限 outline/box-shadow 脉冲；ChatComposer 常驻 backdrop-filter |
| 目标 | 布局属性 will-change = 0；表格流式无无限 paint 脉冲；composer backdrop 在滚动高频期降级 |
| 逻辑步骤 | ① 删除 Tabs 等布局 will-change 整段；② 侧栏行仅滚动/拖拽瞬态 class；③ table pulse 改数据驱动活跃格 class，删 infinite outline/box-shadow 动画；④ composer backdrop 滚动期降级；⑤ 接入/扩展 `check-will-change`（布局属性 fail） |
| 契约 | T0 |
| 边界 | **流式单词 will-change + streamingAnimationContract 不在本票**（D7.6） |

### 3.2 删什么

| # | 删除/收敛项 | 位置 | 负向断言 |
| - | ----------- | ---- | -------- |
| 1 | 隐藏终端无条件 `term.write` | ptyLifecycle:314 | 隐藏 tab write 计数 = 0（FE-INV-7） |
| 2 | 每 chunk TextEncoder history 计量 | pty history API | 编码计量路径 0 |
| 3 | 恒 0 `restartToken`、cwd 每渲染进 effect 依赖 | TerminalCard 等 | grep 死参数 0 |
| 4 | PTY 每 chunk 一次 emit | pty/session.rs | 合批后窗口内 emit 次数单测 |
| 5 | Diff 主路径同步 hljs 循环 | DiffCard* / WidgetDiff / ToolCallDiffPreview | 大 diff 展开主线程无同步长任务；batch 生产调用计数 ≥1 |
| 6 | 「仅测试用」batch 空转感 / 旁路实现 | worker + Diff 调用链 | 生产真实接线；删除主线程重复主路径 |
| 7 | 无恢复的 WebGL 永久死亡路径 | xterm hook | contextlost 有限次恢复或可观测降级 |
| 8 | 布局属性 will-change 群 + table 无限脉冲 + composer 常驻 backdrop | 多处 module.css | `check-will-change` 绿；表格流式无 pulse 动画 |

### 3.3 依赖与逻辑序

```text
D0（PTY_HISTORY / HIDDEN_WRITE / DIFF_LINE_CHUNK / WEBGL_RESTORE_MAX / WC 阈值）
  → D8.1 ∥ D8.2 ∥ D8.3 ∥ D8.4 ∥ D8.5   （文件域内部可再拆票并行）
D8.1 显现重放可与 D8.2 合批联测；D8.3 与 D7.4-T5 接口只读协调
```

**禁止**

- 删除空 worker / 删除 `highlight.batch` case 冒充 12-D1。  
- PTY 合批夹带 PE-02 / LLM delta 合并。  
- 改 `engine_channels` 真缓冲冒充 PTY 合批完成。  
- 隐藏门闩绑 D11 可见性背压（03 分歧 #4：终端写门闩属 DOM 可见性，不属 IPC 契约）。

### 3.4 唯一文件域

| 路径 | D8 角色 |
| ---- | ------- |
| `components/workspace/ptyLifecycle.ts` | 主 · D8.1 |
| `hooks/useXtermTerminal.ts` / 终端 hook | 主 · D8.1/D8.4 |
| `api/ptySessionApi.ts` | 主 · D8.1（history API / budget re-export） |
| `components/binary-tree/TreeLeafPanel.tsx` | 主 · D8.1 可见性源 |
| `components/workspace/TerminalCard*.tsx` | 主 · D8.1 死参数 |
| `apps/agent-workbench/src-tauri/src/pty/session.rs` | 主 · D8.2 |
| `components/diff/DiffCardUnifiedView.tsx`、`DiffCardSplitView.tsx` | 主 · D8.3 |
| `components/custom-tags/WidgetDiff.tsx` | 主 · D8.3 |
| `components/chat-tool-call/ToolCallDiffPreview.tsx` | 主 · D8.3 |
| `api/codeHighlight.ts` | 主 · D8.3 入口分工 |
| `workers/render-worker.ts` / worker 协议 types（前端） | 主 · D8.3（扩展 batch 消费，非删通道） |
| `components/ui/Tabs|SegmentedControl|Switch|ToastStackModern|ScrollArea` module.css | 主 · D8.5 |
| `components/sidebar/SidebarSessionList.module.css` | 主 · D8.5 |
| `components/binary-tree/BinaryTreeWorkspace.module.css`、`PaneHeader.module.css` | 主 · D8.5 |
| `components/chat-message-row/StreamingTableContainer.module.css` | 主 · D8.5 |
| `components/chat-composer/*` backdrop 相关 | 主 · D8.5 |
| `scripts/check-will-change.mjs`（新建/扩展） | 主 · D8.5（D7.6 共用断言入口，脚本主责在 D8） |

**互斥**

- D7 独占 `streaming-animation.css` + streamingAnimationContract。  
- D6 独占 transport/fanout；D8 不碰 EventRouter。  
- `MessageContent` / DiffPreview 父级 props：D7 写权；D8 只写 Diff 子树内部。

### 3.5 验收

| 类 | 断言 |
| -- | ---- |
| 功能 | 隐藏再显现内容完整；多终端；Diff 展开/折叠；WebGL 丢失后可用或降级可见 |
| 不变量 | FE-INV-7；FE-INV-8（主线程无同步 hljs 长栈）；02-X2 emit 合批 |
| 负产出 | §3.2 八项；**无**「删除 batch 通道」伪完成 |
| 五端物证 | 触发=多 tab 终端+大 diff+流式表格；传输=pty-output 次数；介质=n/a；消费=xterm/Diff DOM；负出=write 计数、batch 调用计数、will-change 门禁 |
| 运行时 | 8+ 标签 WebGL 不耗尽或可控恢复；RSS 多终端隐藏期不随输出线性涨 scrollback |

### 3.6 防御脚本 / 守护测试增量

| 资产 | 断言 |
| ---- | ---- |
| 终端 write 计数单测/探针 | 隐藏 0 / 显示正常 |
| PTY 合批单测 | 水位/时间窗触发；EOF flush |
| Diff 路径断言 | 生产调用 `highlight.batch`；大 diff 无主线程同步长任务（路径或 trace） |
| `check-will-change` | 布局属性列表 fail（D8.5） |
| WebGL 限次恢复单测 | mock contextlost 次数行为 |
| ReDoS 盾回归 | highlightCodeSafe 行为不变 |

---

## 4. 三维文件域互斥矩阵（派发用）

| 文件 / 目录 | D6 | D7 | D8 | 他维 |
| ----------- | -- | -- | -- | ---- |
| EventRouter / dataPlaneRouter / tauriTransport / invoke | **W** | — | — | D11 schema 只读 |
| useBackgroundTaskPolling / sessionEventHydrate | **W** | — | — | — |
| fanout.rs / pusher.rs / meta emit 点 | **W** | — | — | — |
| engine_channels.rs / buffer flush | — | — | — | **D1 独占** |
| useStreamingBlocks / IncrementalBlockSplitter / markdownRenderLite | — | **W** | — | — |
| MessageContent 注入面 / ProcessItem | — | **W** | R | D5 只读 store |
| useChatMessageState / chat-tool-call 卡片链 | — | **W** | R（DiffPreview 子树 W 属 D8） | — |
| timelineCache | — | **W** | — | — |
| streaming-animation.css + streamingAnimationContract | — | **W** | — | — |
| ptyLifecycle / useXtermTerminal / ptySessionApi / TreeLeafPanel / pty/session.rs | — | — | **W** | — |
| DiffCard* / WidgetDiff / ToolCallDiffPreview / codeHighlight / render-worker batch | — | R | **W** | — |
| 布局 will-change / table pulse / composer backdrop CSS | — | — | **W** | — |
| check-will-change 脚本 | — | R（断言消费） | **W** | D13 接 CI |
| engine-events.json / events.rs / parser.ts | — | — | — | **D11 独占** |

图例：W=写；R=只读。

---

## 5. 与审计发现 ID 映射

| 详案节 | 90 / 报告 ID |
| ------ | ------------ |
| D6.1 | 03-V1、01-DEL-10 |
| D6.2 | 03-V2、03-I5 |
| D6.3 | 03-V3 |
| D6.4 | 03-V4、01-CNV-7 |
| D6.5 | 03-R5、15-FAN01、15-PSHP03、15-XOV01（部分）、01-DEL-11 |
| D7.1 | 01-H1、01-H2、01-M3、01-M5、01-L1、01-M8 |
| D7.2 | 02-T3 |
| D7.3 | 02-T1 |
| D7.4 | 02-T2、T4–T7、01-M10 |
| D7.5 | 01-M4、02-T11 |
| D7.6 | 12-W1（流式单词）、评审 03 M3 |
| D8.1 | 02-X1、02-X5、02-X8、08-M2、08-M7 |
| D8.2 | 02-X2（无 PE-02） |
| D8.3 | 12-D1、12-S2、CFL-05、02-T5 交叉 |
| D8.4 | 02-X3 |
| D8.5 | 12-W2、12-W3、12-T1、12-B1、12-A1/A2（合成友好动画残余） |

---

## 6. 里程碑（逻辑完成定义，非工期）

| 里程碑 | 内容 | 完成定义 |
| ------ | ---- | -------- |
| m-D6a | D6.1 | parse 计数探针绿 |
| m-D6b | D6.2–D6.4 | 轮询减半 + 悬挂 ≤1 + abort 水合 |
| m-D6c | D6.5 | fanout/push meta-only；XOV 解析次数下降 |
| m-D7a | D7.1 | 增量等价 + 热路径无静态 split |
| m-D7b | D7.2+D7.3 | 注入面 + per-message 展开；FE-INV-5/6 |
| m-D7c | D7.4+D7.5 | memo 链 + timeline；reRender 绿 |
| m-D7d | D7.6 | will-change 反转同票绿 |
| m-D8a | D8.1+D8.2 | 隐藏 write=0 + PTY 合批 |
| m-D8b | D8.3 | highlight.batch 生产接线；无删通道 |
| m-D8c | D8.4+D8.5 | WebGL 恢复 + 布局 will-change 门禁 |

---

## 7. 执行纪律（本三维）

1. 子 Agent 四段任务书：做什么 / 不做什么 / 旧路径清单 / 完成自检。  
2. **主 Agent 唯一提交权**；本文件与实现改动均 **不** `git commit`（子 Agent）。  
3. 每票负产出至少一项删除或路径收敛；禁止 TODO 堆实现。  
4. CFL-05 / CFL-10 / CFL-16 为合并约束：D6 分票粒度、Diff 接线默认、双发不在本维。  
5. 真缓冲 flush、NoPersist、审计有界 → **D1**；双发回执、PE-02、message-start、Progress → **D11**；负向断言 CI 总装与 V 项总表回填流程 → **D13/05-D6 持续轨**（本维只交付探针与单测资产）。

---

## 8. 汇报要点（给主控）

### 8.1 三维边界

- **D6**：仅传输消费面与旁路 meta（parse×1、轮询分票、invoke/hydrate、meta-only）；**不**碰真缓冲与双发。  
- **D7**：流式 O(delta) + 卡片链（先注入收窄与 per-message 再 memo）+ timeline + **流式 will-change CSS 与契约测试同票**。  
- **D8**：终端隐藏 write=0、PTY 合批（无 PE-02）、Diff **接线** batch、WebGL 恢复、布局/表格/composer 合成 CSS；**禁止删空 worker**。

### 8.2 与 D1 / D11 交叉

| 对象 | 交叉 | 移交 |
| ---- | ---- | ---- |
| D1 | `push_live` 真缓冲 flush；NoPersist 事件形状 | 真缓冲归 D1；D6 只保证消费兼容回归 |
| D11 | 双发回执、schema、PE-02、Progress、可见性背压 | 全部 D11；CFL-16 默认「webview 降回执 + 旁路完整」不在此实现 |
| D0 | 微退避/降采样/合批窗/行 chunk/恢复次数 | 常量只进 SSOT，本三维 re-export |
| D13 | check-will-change 接 CI、V 项总表 | 本维交付断言资产；CI 总装 D13 |

### 8.3 效果锁提醒

- 12-D1 效果 = **主线程无同步 hljs 热路径**；删通道 ≠ 完成（CFL-05）。  
- FE-INV-7 = 隐藏终端 write 0；FE-INV-5 = 单卡展开 0 扩散。  
- will-change：契约测试若不反转，删除会被门禁回潮（评审 03 M3）。

---

*UTF-8 无 BOM。未执行 git commit。未修改生产代码。*
