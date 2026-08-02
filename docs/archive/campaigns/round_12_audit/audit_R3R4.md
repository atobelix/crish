# Round 3 & Round 4 落地审计报告

> 核查日期：2026-07-24  
> 基准方案：`analysis/2026-07-24-综合协同修复方案.md` §7(流式渲染) + §8(拖拽交互)  
> 核查方法：grep/read 实际代码文件 + 结构推断  
> 审计结果：**R3: 6/6 通过 | R4: 3/4 通过, 1/4 有条件通过**

---

## Round 3：流式渲染性能簇

### R3-T01：流式热路径 — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| `bridge.push` 惰性化 | ✅ | `StreamRenderBuffer.ts:257-261` — `if (this.onFrame && !degraded)` 仅在消费者注册 html 回调时执行 bridge.push |
| subagent 接入 batcher | ✅ | `useChatStream.ts:710-741` — subagentAccum Map + `setTimeout(flushSubagentAccum, 48)` 定时批合并 |
| 心跳去重（本侧） | ✅ | `EventRouter.ts:136-141` — `streamRecovery.updateHeartbeat` 按 `lastAppliedSequence` 去重 |
| unmount 清理 | ✅ | `useChatStream.ts:561-568` — useEffect return 中调用 `streamingText.dispose()` + `toolBatcherRef.current?.dispose()` |
| StreamTextBatcher | ✅ | `streamTextBatcher.ts` — 完整通用批合并器，支持 interval/force flush/backpressure |

### R3-T02：自动滚动 delta 增量 — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| delta 增量推进 | ✅ | `useChatAutoScroll.ts:80-82` — `el.scrollTop = Math.min(el.scrollTop + dh, actualHeight)` |
| prepare 结果缓存 | ✅ | `useChatAutoScroll.ts:58-65` — `prepareCacheRef.current` 缓存 prepare 结果，200 条 LRU 淘汰 |
| 节流 | ✅ | `useChatAutoScroll.ts:43` — `if (now - lastRunRef.current < 100) return;` 100ms 节流 |

### R3-T03：渲染树优化 — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| 正则模块级复用 | ✅ | `markdownRenderLite.ts:18-30` — 全部 7 个正则提升为模块级常量 (`RE_HEADING_ZH`, `RE_BOLD_ZH` 等) |
| timeline useMemo | ✅ | `ChatMessageRow.tsx:140` — `useMemo(() => buildAssistantTimeline(msg), [msg])` |
| MessageRowById memo | ✅ | `ChatMessageList.tsx:295` — `const MessageRowById = React.memo(...)` |
| ChatUserMessageRow memo | ✅ | `ChatMessageRow.tsx:101` — `React.memo(ChatUserMessageRowInner, userRowPropsEqual)` |
| ChatAssistantMessageRow memo | ✅ | `ChatMessageRow.tsx:162` — `React.memo(ChatAssistantMessageRowInner, assistantRowPropsEqual)` |
| 消除二次 markdown | ✅ | `MessageContent.tsx` + `useChatStream.ts` — 流式热路径走 bridge push 增量解析，终态走 `scheduleFinalMarkdownHtml` Worker 异步 |

### R3-T04：协议解析优化 — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| message-delta/text-delta 快速路径 | ✅ | `EventRouter.ts:206-207` — `rawType === 'message-delta' || ... === 'text-delta'` 绕过 `resolveEventType` 直接类型断言，省略 zod safeParse |
| 心跳去重（桥接侧） | ✅ | `EventRouter.ts:136-141` — 按 `lastAppliedSequence` 跳过旧事件 |
| SSE 回退思考文本修复 | ✅ | `directFetchBridge.ts:259-270` — `onThought(assistantThought)` 全文累加语义（非 delta 覆盖拼写） |

### R3-T05：store 中间件 — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| sessionsById 增量维护 | ✅ | `autoIndexMiddleware.ts:24-29` — subscribe 回调仅 `s.length !== prevSessionCount` 时重建 Map，非每帧重建 |

### R3-T06：虚拟化修复 — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| cancelledRef → AbortController | ✅ | `usePretextHeights.ts:32,42,71` — `useRef<AbortController | null>` + `abortRef.current?.abort()` + effect cleanup `() => { ac.abort(); }` |
| 消息版本号去重 | ✅ | `usePretextHeights.ts:34-36` — `messagesVersion = visibleMessages.map(m => ${m.id}:${m.text}:${m.toolCalls?.length}).join('|')` 作为 useEffect 依赖 |

---

## Round 4：拖拽交互簇

### R4-T01：Tab 拖拽核心 (D1/D2/D5/D6/D8/D9) — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| D1: getBoundingClientRect 缓存 | ✅ | `useTabDrag.ts:96-115` — `cardSnapshots` 在 dragstart/`resize` 时刷新快照，move 中查找缓存而非实时 query |
| D2: move rAF 节流 | ✅ | `useTabDrag.ts:291-303` — `requestAnimationFrame` 包裹 `handlePointerMove` |
| D5: overlay translate3d | ✅ | `useTabDrag.ts:175` — `dragOverlay.style.transform = translate3d(...)` |
| D6: cloneNode iframe 后备 | ✅ | `useTabDrag.ts:161-167` — iframe → `<div class="iframe-placeholder">` |
| D8: DOM 插入指示线 | ✅ | `useTabDrag.ts:248` + `pointer-state.ts:62-90` — `showTabInsertLine` 在 tabsBar 中计算插入位置 |
| D9: 统一拖拽系统 | ✅ | tab-drag 模块化成 `hooks/tab-drag/` 下 5 个文件：`types.ts`, `collision.ts`, `pointer-state.ts`, `drop-handlers.ts`, `index.ts` |

### R4-T02：工作区 resize (D7/D12) — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| D7: useColumnResize Hook | ✅ | `useColumnResize.ts` — 独立 Hook，pointer events + rAF 节流 + getBoundingClientRect 快照 |
| D7: WorkspaceCanvas 集成 | ✅ | `WorkspaceCanvas.tsx:33-35` — `useColumnResize(ws.id)` 挂载到 `WorkspaceResizer` 的 `onPointerDown` |
| D12: clamp 收敛 | ⚠️ 等价 | `workspaceActions.ts:144,167` — 使用 `if (newLeft > 0.12 && newRight > 0.12)` 替代 `Math.max(MIN, Math.min(MAX, val))`，语义等价但写法不同 |
| 冗余实现 | ⚠️ 注意 | `useWorkspaceResize.ts` 用旧式 onPointerDown 链做了与 `useColumnResize.ts` 几乎相同的事，两端并存。`useColumnResize.ts` 用于 WorkspaceCanvas，`useWorkspaceResize.ts` 在 WorkspaceCanvas 内同时挂载 |

### R4-T03：侧边栏拖拽 (D3/D4/D11/D13) — ✅ 有条件通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| D3: 实时重排 | ✅ | `SidebarSessionList.tsx:637-667` — FLIP 动画（translate + transition）实时反映重排 |
| D4: 统一拖拽系统 | ⚠️ 未完全 | 计划要求统一为 `useSortable` 并移除旧 `useDragAndDrop`。实际实现：`DragReorderSection` 组件封装重排逻辑 + `startSessionDrag` 内联 pointer 事件；未找到 `useSortable` 或 `useDragAndDrop` 文件 |
| D11: classList 替代 setState | ✅ | `useColumnResize.ts:31,42,83` — `splitterEl.classList.add/remove('active')` 控制样式（sideBar 拖拽中 `setDragOverPinned` 仍用 setState 但有针对性优化） |
| D13: pointercancel 兜底 | ✅ | `SidebarSessionList.tsx:1204,1221` — `pointercancel` → `cancel` cleanup |

### R4-T04：Tauri 拖拽区域 (D14) — ✅ 通过

| 子任务 | 状态 | 证据 |
|--------|------|------|
| data-tauri-drag-region | ✅ | `AppHeader.tsx:43-45,71-73` — 多处 header/titlebar 使用 `data-tauri-drag-region`；`WorkspaceChromeBars.tsx:360`；`SettingsPanel.tsx:444-445` |
| stopPropagation 防护 | ⚠️ 有限 | `useTabDrag.ts:37-47` 仅在 button===1（中键关闭）时 `stopPropagation()`，其他可拖拽元素未统一添加 pointerdown 阻止传播 |

---

## 汇总

| 轮次 | 任务总数 | ✅ 通过 | ⚠️ 有条件 | ❌ 未通过 |
|------|---------|--------|----------|---------|
| R3 | 6 | 6 | 0 | 0 |
| R4 | 4 | 3 | 1 | 0 |

## 改进建议

1. **R4-T02 冗余 Hook**：`useColumnResize.ts` 和 `useWorkspaceResize.ts` 功能高度重叠。应移除其中一个或明确职责分离，避免后续维护者混淆。
2. **R4-T03 统一拖拽**：方案要求统一为 `useSortable` 并移除旧 `useDragAndDrop`。当前代码自行实现了 `DragReorderSection` 和内联 `startSessionDrag`，建议评估是否统一到社区或内建 hook。
3. **R4-T04 防护加固**：`data-tauri-drag-region` 中可能触发的 pointer 事件建议统一 `stopPropagation()`，避免意外穿透到 Tauri 底层窗口拖动。
