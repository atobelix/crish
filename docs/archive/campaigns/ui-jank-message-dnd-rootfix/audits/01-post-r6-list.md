# 01 — Post-R6 消息列表 + 虚拟滚动 + 消息幂等审计

> Agent：R7-Audit-List（A-Review 只读）
> 日期：2026-07-22
> 工作区：`C:\Software\conex`
> 契约：`docs/ui-jank-message-dnd-rootfix/01-contract.md` §1 / §4 / §7
> 对照实现：R1（高度生命周期 / expand 锚点 / 流式 invalidate）· R5（addMessage upsert / id 熵）

## 0. 结论摘要

| 维度 | 总评 |
|------|------|
| 高度 clear / 会话切换 | **达标**：`clearHeights` 仅绑 `activeSessionId`；无 `startIndex→clear` |
| 窗口平移 / expand / 过滤 | **主路径达标**：仅 `syncOrder(ids)`；Manager 单测覆盖 pan 保高 |
| expand 锚点补偿 | **已实现**：`useLayoutEffect` 前移 scrollTop；新项常 fallback 高度 → 二次校正抖动残留 |
| 流式 invalidate | **基本达标**：按 id + rAF 合并；**未**整表 clear；仅订 `msg.text` |
| addMessage upsert 全路径 | **主路径达标**：权威 `sessionActions` + 调用方统一走 store；镜像/死路径有债 |
| id 熵 | **达标**：`generateMessageId`（ts + uuid 片段 + 计数）+ 专测 |
| 回归缺口 | **有**：缺 ChatMessageList / useVirtualScroll 组件级接线测；syncOrder 时序债 |

**是否阻塞宣称「消息假重复主因路径根治」：**
**不阻塞**主因路径宣称（错误 `startIndex→clearHeights` 已关 + 同 id 静默双插已关 + id 熵足够）。
**阻塞「100% 无列表跳动 / 无高度一帧错位」类更强宣称**——见 High/Medium 时序与补偿缺口。

---

## 1. Findings

### Critical

**（本轮无 Critical）**

对照契约 §1/§4 与 R0 Baseline「错误 clear / 静默 push」主因：

- 未发现 `messageWindow.startIndex` 变化时调用 `clearHeights` / `manager.clear`
- 未发现权威会话消息写入路径对同 id 静默 `push` 双行
- `daemonChatBridge` 无 `addMessage` / `messages.push`（助手占位仅 `useChatStream` 一侧）

---

### High

#### H1. `syncOrder` 落在 `useEffect`（paint 后），与 `itemCount` 同帧不同步

| 项 | 内容 |
|----|------|
| **现象** | expand older / 过滤窗变化时，渲染帧内 `itemCount` 已是新长度，但 `VirtualScrollManager.order` 仍为旧序，直到 effect 才 `syncOrder` + `heightTick` |
| **证据** | `apps/crish-desktop/src/hooks/useVirtualScroll.ts` L61–67（`useEffect` 内 `syncOrder`）；`computeVisibleRange` / `getTotalHeight` 用 `itemCount` + 当前 order（L107–116）。`ChatMessageList.tsx` L556–561 传入 `itemCount: visibleMessages.length` 与 `ids: visibleIds` |
| **影响** | 前移窗口首帧：`getHeightAt(i)` 对超出旧 order 的下标走 fallback；`startOffset` / spacer 可能短一帧错位，叠加 expand 锚点补偿观感为「跳一下」 |
| **契约** | §1 要求窗口变化**仅** `syncOrder`（API 选择正确），但接线时序未保证与 React 提交同相 |
| **建议修复** | 将 ids→`syncOrder` 升为 `useLayoutEffect`，或在 render 路径对 `ids` 引用变化同步 `manager.syncOrder`（注意严格模式双调用幂等）；组件测：expand 前后 order.length === ids.length 在 layout 后成立 |
| **阻塞根治宣称** | **不阻塞**「假重复主因」；**阻塞**「expand 无跳动根治」若产品以此为验收 |

#### H2. 缺 ChatMessageList / useVirtualScroll 接线级回归测

| 项 | 内容 |
|----|------|
| **现象** | R1 关键行为（会话 clear、禁 startIndex clear、prepend 补偿、ids→syncOrder）**无**组件/hook 测；仅有 `VirtualScrollManager` 单元 + fuzz |
| **证据** | grep `ChatMessageList` / `clearHeights` / `useVirtualScroll` 于 `*.test.ts(x)`：**无命中**。Manager 测：`VirtualScrollManager.test.ts` L26–86（pan/expand 保高）。R6 跑测清单亦无 List 接线测 |
| **影响** | 回归时可能重新引入 `useEffect([messageWindow.startIndex], clearHeights)` 而 Manager 单测仍绿 |
| **建议修复** | ① hook 测：mock manager，assert ids 变化调 `syncOrder` 不调 `clear`；sessionId 变调 `clear`。② 静态/eslint 或单测锁定 ChatMessageList 无 `startIndex`+`clearHeights` 同 Effect |
| **阻塞根治宣称** | **不阻塞**当前代码正确性宣称；**阻塞**「防回归门闩完备」 |

---

### Medium

#### M1. 容器宽度剧变未调用 `invalidateAllActual`

| 项 | 内容 |
|----|------|
| **现象** | 契约 §1：宽度剧变 → `invalidateAllActual`（或按 id）。实现中 **全库无业务调用** `invalidateAllActual`（仅 Manager 定义 + 无生产引用） |
| **证据** | `VirtualScrollManager.ts` L197–203 定义；grep `invalidateAllActual` 仅 Manager 自身。`ChatMessageList.tsx` L623–645 宽变只 `setContainerWidth`；Pretext 仅对 `!manager.hasHeight` 估高（L666–693），**已有 actual 的行不因宽变主动 stale** |
| **影响** | 依赖行级 ResizeObserver 回写（L721–728）。多数 reflow 可自愈；冻结期跳过宽更新（L631）结束后若 RO 不触发，可能短时沿用窄/宽期 actual |
| **建议修复** | 宽变超过阈值（如 ≥40px）调用 `manager.invalidateAllActual()` + bump `heightTick`；与 `isLayoutFrozen` 结束 catch-up 对齐 |

#### M2. 流式 `invalidateActual` 仅依赖 `msg.text`，且不 bump React `heightTick`

| 项 | 内容 |
|----|------|
| **现象** | User/Assistant 行：`useEffect` 对 `msg.text` rAF `invalidateActual`；thinking / toolCalls / 折叠态不在 deps。invalidate 本身不触发 `useVirtualScroll` 的 `heightTick` |
| **证据** | `ChatMessageRow.tsx` L328–335、L618–626。`useVirtualScroll` 仅 setEstimated/setActual/syncOrder/clear  bump tick（L145–186） |
| **影响** | 工具块/思考区长高主要靠 RO→`setActual`；末 token 后若 RO 延迟，一帧内 actual 已 null 但 UI 总高仍旧（直至下一次 tick 源）。thinking 流式未 invalidate 时更依赖 RO |
| **建议修复** | ① invalidate 后通过可选 `onHeightInvalidate`/`heightTick` 回调；② deps 扩 `msg.thinking` / `msg.toolCalls?.length` / 关键 status；③ 或文档声明「以 RO 为 actual 权威，invalidate 仅辅助」 |

#### M3. expand 锚点补偿用当前 `getHeight`，新 prepend 项常为 fallback

| 项 | 内容 |
|----|------|
| **现象** | 旧首条在新列表中下标前移时，按前置 id 高度和加 `scrollTop`；无测高的 id → fallback（默认 120） |
| **证据** | `ChatMessageList.tsx` L586–612；`MESSAGE_ESTIMATED_ROW_HEIGHT` / Manager fallback。Pretext 异步 chunk（L666–701）在补偿**之后** |
| **影响** | 展开更早后视口可能二次漂移（实测 actual ≠ fallback 时） |
| **建议修复** | 补偿改二次：Pretext/RO 稳定后再 fine-tune；或对将 prepend 的 id 先同步估高再补偿 |

#### M4. 会话切换 `clear` 与 in-flight `setActual` rAF 可能回填旧 id 高度

| 项 | 内容 |
|----|------|
| **现象** | `clearHeights` 同步清空；`setActual` 经 rAF 批量 flush，切会话后仍可能 `setActual(oldId, h)` 写入 heights Map |
| **证据** | `useVirtualScroll.ts` L157–171；`ChatMessageList.tsx` L575–577 clear。order 已是新会话时，孤儿 id 不参与 index 查询，但污染 Map；极端同 id 跨会话（水合 id 碰撞）有误高风险 |
| **建议修复** | clear 时丢弃/generation 作废 pending Maps；`setActual` flush 带 epoch |

#### M5. `createChatActions` 死镜像与 demo `saveMessageToDb` 无 dedupe

| 项 | 内容 |
|----|------|
| **现象** | `store/actions/chat.ts` 有 upsert 镜像，但 **layoutStore 只接 `createSessionActions`**，`createChatActions` 零引用。`chatApi.demo.ts` `saveMessageToDb` 无条件 `push`（且全库无 `saveMessageToDb(` 调用，近死代码） |
| **证据** | `layoutStore.ts` L820 `createSessionActions`；grep `createChatActions` 仅定义文件。`chatApi.demo.ts` L223–228；`chatApi.ts` L27–41 生产 DB 路径有 upsert |
| **影响** | 未来误接 `createChatActions` 或复活 demo DB 时易漂移；当前运行时主路径不受影响 |
| **建议修复** | 删除死镜像或单测强制与 sessionActions 行为一致；demo `saveMessageToDb` 对齐 upsert 或删除 |

#### M6. 子 agent 时间线 `agent-asst-${Date.now().toString(36)}` 熵偏低

| 项 | 内容 |
|----|------|
| **现象** | 主会话消息已用 `generateMessageId`；`applySubagentEventToMessages` 新建助手仍纯时间 36 进制 |
| **证据** | `subagentTimeline.ts` L114–126；主路径 `useChatStream` / `useAgentStream` 用 `generateMessageId` |
| **影响** | 同 ms 双 ensure 风险低（单 asst 复用）；非主列表假重复主因 |
| **建议修复** | 改为 `generateMessageId('assistant')` |

#### M7. `MAX_MESSAGES_PER_SESSION` shift / 撤回不 `manager.delete`

| 项 | 内容 |
|----|------|
| **现象** | 消息从数组移除后高度 Map 残留至会话 clear |
| **证据** | `sessionActions.ts` L416–418 shift；`VirtualScrollManager.delete` L276–288 存在但 List 未接 |
| **影响** | 长会话内存缓涨；一般不致假重复 |
| **建议修复** | 撤回/shift 后按 id `manager.delete`；或依赖会话 clear |

---

### Low

#### L1. `Object.assign` upsert 浅合并语义

| 项 | 内容 |
|----|------|
| **证据** | `sessionActions.ts` L411–414：同 id `Object.assign(existing, prepared)`；`prepared.blocks` 总是新数组 |
| **影响** | 调用方若 omit 字段，旧字段可能残留；若传空 `blocks`/`toolCalls` 可能覆盖掉运行中工具态——依赖调用纪律 |
| **建议** | 关键字段白名单 merge，或文档约定 addMessage 必须带全量快照 |

#### L2. Baseline 文档与 R5 测描述滞后

| 项 | 内容 |
|----|------|
| **证据** | `EXECUTION-PROGRESS.md` Baseline 表仍写「未见同 id 双 add 专测」；实际 `sessionActions.test.ts` L800–855 已有。R6 已标 pass |
| **建议** | Orchestrator 刷新 Baseline「当下状态」列 |

#### L3. 根 vitest `node` vs desktop `jsdom`

| 项 | 内容 |
|----|------|
| **证据** | R6 记录：根配置跑 DOM 相关测假红；List 相关测目前不依赖，但接线测若加 RTL 必须 desktop cwd |
| **建议** | 文档强制 cwd 或根 exclude |

#### L4. 过滤视图 `showAllMessages` / `displayMessages` 仅靠 syncOrder

| 项 | 内容 |
|----|------|
| **证据** | `ChatCard.tsx` 过滤后 `messages={displayMessages}`；List 无额外 clear——**符合契约** |
| **残留** | 过滤切换时 ids 大换血，旧 id 高度保留有益；无补偿逻辑（非 prepend 对齐则 early return L592） |

#### L5. 会话切换重置 `expandedOlder`

| 项 | 内容 |
|----|------|
| **证据** | `ChatMessageList.tsx` L186–190：`activeSessionId` → `setExpandedOlder(0)`，与高度 clear 一致 |
| **评价** | 正向；无需修 |

---

## 2. 分项审计明细

### 2.1 高度生命周期（契约 §1）

| 场景 | 契约 | 实现 | 结论 |
|------|------|------|------|
| 会话切换 | `clear` / `clearHeights` | `ChatMessageList` L575–579 `clearHeights()`；deps 含 `activeSessionId` | **pass** |
| 窗口平移 / expand older | 仅 `syncOrder` | `useVirtualScroll` L61–67；List **无** startIndex clear | **pass**（时序见 H1） |
| 过滤窗口 | 仅 `syncOrder` | ids 随 `visibleMessages` 变 | **pass** |
| 宽度剧变 | `invalidateAllActual` | **未接线** | **gap → M1** |
| 流式文本 | 节流/rAF `invalidateActual(id)` | Row L328–335 / L618–626 | **pass**（范围见 M2） |
| expand 锚点 | （实现增强，非硬禁） | List L586–612 对齐前缀 + scrollTop | **pass + M3** |

权威注释：`VirtualScrollManager.ts` L53–56「窗口平移应调用本方法，禁止 clear 全量高度」。

### 2.2 addMessage upsert 全路径（契约 §4）

| 路径 | 行为 | 结论 |
|------|------|------|
| `sessionActions.addMessage`（权威，layoutStore） | 同 id `Object.assign`，否则 push | **pass** L385–419 |
| `store/actions/chat.ts` `createChatActions` | 同逻辑镜像，**无引用** | 死代码 **M5** |
| `useChatStream` 用户/goal/learn/doctor/助手占位 | 均 `store.addMessage` / `generateMessageId` | **pass** |
| `ChatCard` 撤回再发 | `generateMessageId` + `addMessage` | **pass** |
| `appendSessionAgentMessage` | 同 id assign（sessionActions L814–819） | **pass** |
| `SessionSyncService` add-message | 同 id 覆盖 merge L501–519 | **pass** |
| `saveMessageToDb` 生产 | upsert L33–41 | **pass** |
| `saveMessageToDb` demo | 无条件 push | **M5**（无调用） |
| `daemonChatBridge` | 无二次 push | **pass** |
| `sessionEventHydrate` 投影 | 构建新数组，整表替换空会话 | **pass**（非双插） |
| `subagentTimeline` ensureAsst | 复用 asst；新建 id 低熵 | **M6** |

专测：`sessionActions.test.ts` L800–855「addMessage same id is upsert」。
id 熵：`generateMessageId.ts` + `generateMessageId.test.ts`（同 ms 32 唯一）。

### 2.3 契约 §7（消息列表相关）

| 清单项 | 状态 |
|--------|------|
| 未在 `messageWindow.startIndex` 变化时 `clearHeights` | **是** |
| 会话切换有 clear 或等价重置 | **是** |
| 相关单测绿 | Manager / sessionActions / generateMessageId **是**；List 接线 **否（H2）** |

---

## 3. 残留风险与回归缺口（汇总）

| ID | 级别 | 一句话 | 阻塞「假重复根治」？ |
|----|------|--------|---------------------|
| — | Critical | 无 | — |
| H1 | High | syncOrder 在 useEffect，expand/窗变首帧 order 落后 itemCount | 否（跳动类） |
| H2 | High | 无 List/hook 接线回归测 | 否（防回归） |
| M1 | Medium | 宽变无 invalidateAllActual | 否 |
| M2 | Medium | invalidate 仅 text、无 heightTick | 否 |
| M3 | Medium | expand 补偿 fallback → 二次漂移 | 否 |
| M4 | Medium | clear 后 rAF setActual 回填 | 极低概率 |
| M5 | Medium | 死镜像 / demo push | 否（当前运行时） |
| M6 | Medium | 子 agent id 低熵 | 否（非主列表） |
| M7 | Medium | 移除消息不 delete 高度 | 否 |
| L1–L5 | Low | 浅合并、文档、vitest cwd、过滤、expandedOlder 重置 | 否 |

**已知边界（不记缺陷）**：契约 §6 标题栏移动 / 跨窗口 DnD。

---

## 4. 建议 R8 派发切片（供 R7-Plan）

1. **R8-List-SyncOrderPhase（High）**：`useVirtualScroll` ids→syncOrder 改 layout 相；补 hook 测
2. **R8-List-RegressionTests（High）**：ChatMessageList 静态/浅渲染锁「无 startIndex clear」+ 会话 clear
3. **R8-List-WidthInvalidate（Medium）**：宽变阈值 → `invalidateAllActual` + tick
4. **R8-List-StreamInvalidate（Medium）**：thinking/tools deps 或 RO 权威文档化 + tick 桥
5. **R8-List-ExpandAnchor（Medium）**：估高后再补偿 / 二次校正
6. **R8-Data-DeadPaths（Low/Medium）**：删或测锁 `createChatActions`；demo save upsert；subagent `generateMessageId`

---

## 5. 相关绝对路径速查

- `C:\Software\conex\docs\ui-jank-message-dnd-rootfix\01-contract.md`
- `C:\Software\conex\apps\crish-desktop\src\api\VirtualScrollManager.ts`
- `C:\Software\conex\apps\crish-desktop\src\api\VirtualScrollManager.test.ts`
- `C:\Software\conex\apps\crish-desktop\src\hooks\useVirtualScroll.ts`
- `C:\Software\conex\apps\crish-desktop\src\components\ChatMessageList.tsx`
- `C:\Software\conex\apps\crish-desktop\src\components\ChatMessageRow.tsx`
- `C:\Software\conex\apps\crish-desktop\src\store\sessionActions.ts`
- `C:\Software\conex\apps\crish-desktop\src\store\sessionActions.test.ts`
- `C:\Software\conex\apps\crish-desktop\src\store\actions\chat.ts`
- `C:\Software\conex\apps\crish-desktop\src\store\layoutStore.ts`
- `C:\Software\conex\apps\crish-desktop\src\hooks\useChatStream.ts`
- `C:\Software\conex\apps\crish-desktop\src\utils\generateMessageId.ts`
- `C:\Software\conex\apps\crish-desktop\src\services\SessionSyncService.ts`
- `C:\Software\conex\apps\crish-desktop\src\api\subagentTimeline.ts`
- `C:\Software\conex\apps\crish-desktop\src\api\chatApi.ts` / `chatApi.demo.ts`
