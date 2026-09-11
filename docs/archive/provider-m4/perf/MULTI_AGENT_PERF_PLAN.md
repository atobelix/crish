# Crish Desktop 性能整改 — 多轮多 Agent 执行方案

> 源诊断：`implementation_plan.md`（17 病灶 / 5 域）
> 增补：UX 止血（机器人头像、气泡 shrink、输入卡顿、流式 MD）
> 原则：**每轮 ≤8 agent；文件所有权不重叠；先止血后架构；可验证交付**

---

## 0. 目标与验收

| 场景 | 指标 |
|------|------|
| 200 tok/s 流式 | Long Task >50ms &lt; 2/10s；流式期 `highlightCode`=0；历史行 render≈0 |
| 拖拽/resize | 中位 FPS ≥55；`resizeBranch` 仅 pointerup 1 次；无 Forced Reflow 风暴 |
| 输入 | 连续中文输入不丢字；composer 路径无 pretext prepare |
| 功能 | 虚拟滚动展开/搜索不漂移；终端批量写入；流式可见 MD（非 plain→MD 闪） |

**技术栈决策（固定）**

- 不换 React / 不上新量字库
- 删 pretext 热路径 → CSS + `scrollHeight` / `ResizeObserver`
- 流式：先停掉丢弃的 hljs；再接增量 MD（不高亮）；final 可高亮

---

## 1. 病灶 → 轮次映射（优化后）

### 相对原 plan 的优化点

1. **#7 不只「惰性跳过」**：默认不 `bridge.push`；另开任务让 DOM 走增量 MD（流式跳过 hljs）。
2. **#12 bubble 级 RO**：不改成「容器 context 测宽」，**直接删除 `useBubbleShrinkWidth`**（CSS 足够）。
3. **#10 拆两步**：R1 不急做完整 streaming store；R3 再做旁路（依赖 R1 止血 + R2 memo）。
4. **补 UX Wave0**：头像物理删除、composer 去 pretext、draft 防抖 — 原 plan 遗漏但用户强痛点。
5. **#5 Workspace resize** 与 **#1 tree resize** 同轮不同文件，可并行。
6. **#15+#16+#17** 绑同一 agent（VirtualScroll 同一所有权），避免三家改同一文件冲突。

### 依赖图

```text
R1 止血（无依赖，并行）
  ├─ A StreamBuffer #7
  ├─ B 终端 batch #12
  ├─ C Tree resize #1
  ├─ D Tab drag #4
  ├─ E Terminal RO #3 + Sidebar #6
  ├─ F withLogger #14
  ├─ G UX 头像/气泡/composer
  └─ H MessageContent 流式 MD（配合 #7，不重新打开 buffer hljs）

R2 结构（依赖 R1 合入）
  ├─ I CardPanel #9 + autoIndex #13
  ├─ J AutoScroll #8
  ├─ K TreeLeafPanel #2
  ├─ L Workspace resize #5
  ├─ M VirtualScroll #15+#16+#17 + MessageVirtualizer memo #11
  └─ N（可选）thinkingSeconds 隔离

R3 架构（依赖 R2）
  ├─ O Streaming text 旁路 #10（轻量 store / ref + 结束写回）
  ├─ P 联调：流式 MD + 旁路 + 虚拟列表
  └─ Q 验收脚本 / 手工 checklist
```

---

## 2. Round 1 — 止血（8 agents，文件不重叠）

| Agent | ID | 病灶 | 独占文件 | 交付 |
|:---:|:---:|------|----------|------|
| A | `r1-stream-buffer` | #7 | `apps/crish-desktop/src/api/StreamRenderBuffer.ts`（+ 极小导出若需） | 默认不 `bridge.push`；可选 `onHtmlNeeded` |
| B | `r1-terminal-batch` | #12 | `useStreamCallbacks.ts` + `layout-core-actions.ts`（仅加 `addTerminalLines` batch API） | 80 行 1 次 set |
| C | `r1-tree-resize` | #1 | `useTreeResize.ts` + 相关 CSS（binary-tree） | 拖中只改 CSS 变量；up 时 `resizeBranch` 1 次；rAF + pointer capture + iframe 屏蔽若项目已有工具则复用 |
| D | `r1-tab-drag` | #4 | `hooks/tab-drag/*` | rAF、`translate3d`、rect 快照；减少每帧 insertBefore |
| E | `r1-ro-sidebar` | #3+#6 | `TerminalCard.xterm.tsx` + `useSessionListDrag.ts` | RO rAF；ghost `pointer-events:none` |
| F | `r1-logger` | #14 | `store/middleware/withLogger.ts` | clearMarks；不 dump 全 state；流式可短路 |
| G | `r1-ux-composer` | UX | `MessageAvatar.tsx`（删）、`ChatAssistantMessageRow`、`ChatUserMessageRow`、`ChatMessageRow.tsx` 导出、`useAutoGrowTextarea.ts`、`useChatComposerProps.ts`（draft 防抖）、去掉 `useBubbleShrinkWidth` 调用 | 无 Bot 节点；气泡 CSS；输入无 pretext |
| H | `r1-stream-md` | 产品 MD | `MessageContent.tsx` + `AsyncMarkdownBlock.tsx` | 流式也走 MD；sync IncrementalMarkdownBridge；代码块流式期不高亮（parser 侧或 flag） |

**R1 禁止**：改 VirtualScrollManager、layoutTreeStore 结构、streaming 旁路大重构。

**R1 完成门禁**：相关文件 typecheck；不引入新 lint error；每个 agent 在 PR 说明写「改了什么 / 如何手测」。

---

## 3. Round 2 — 结构（≤6 agents）

| Agent | ID | 病灶 | 独占范围 |
|:---:|:---:|------|----------|
| I | `r2-store-shell` | #9+#13 | CardPanel、autoIndexMiddleware |
| J | `r2-autoscroll` | #8 | useChatAutoScroll.ts — 去 pretext，DOM 增量 scroll |
| K | `r2-leaf-memo` | #2 | BinaryTreeWorkspace leaf props 稳定化 |
| L | `r2-ws-resize` | #5 | Workspace.tsx 改接 useColumnResize |
| M | `r2-vscroll` | #11+#15+#16+#17 | VirtualScrollManager + MessageVirtualizer |
| N | `r2-thinking-timer` | （补） | ThinkingTimer 微组件隔离 thinkingSeconds |

---

## 4. Round 3 — 架构 + 验收（≤4 agents）

| Agent | ID | 任务 |
|:---:|:---:|------|
| O | `r3-stream-store` | #10：流式 text 进轻量 store/ref；结束写回 session；历史行不再因 text 每帧重渲 |
| P | `r3-integrate` | 串起 buffer / MD / 旁路 / vscroll；修冲突 |
| Q | `r3-verify` | 按验证方案跑 checklist + 能自动化的单测 |
| R | `r3-cleanup` | 死代码、pretext 残留热路径扫描、文档更新 |

---

## 5. 文件所有权矩阵（冲突防护）

| 文件区域 | R1 | R2 | R3 |
|----------|----|----|-----|
| StreamRenderBuffer | A | — | P 可读可补 |
| useStreamCallbacks | B | — | O 可写 |
| useTreeResize / binary-tree CSS | C | K 仅 props | — |
| tab-drag/* | D | — | — |
| TerminalCard / session list drag | E | — | — |
| withLogger | F | — | — |
| Avatar / rows / autoGrow / composer draft | G | N thinking | — |
| MessageContent / AsyncMarkdownBlock | H | — | P |
| CardPanel / autoIndex | — | I | — |
| useChatAutoScroll | — | J | — |
| Workspace resize | — | L | — |
| VirtualScroll* / MessageVirtualizer | — | M | P |
| streaming store 新文件 | — | — | O |

---

## 6. Agent 通用约束（写入每个 prompt）

1. 工作区：`C:\Software\conex`，主改 `apps/crish-desktop`。
2. 只改本 agent 独占文件；发现必须越界 → 停手并在结果里写 BLOCKED + 原因。
3. 中文注释保持 UTF-8；不写无关文档；不 commit（除非用户要求）。
4. 改完：`npx tsc -p apps/crish-desktop --noEmit` 或包内已有 typecheck 命令（能跑则跑）。
5. 交付摘要：`files changed` / `behavior` / `how to verify` / `risks`。
6. **不要**为估高再引入新量字库；**不要**在流式路径重新打开每帧 hljs。

---

## 7. 调度状态

| Round | 状态 | 备注 |
|-------|------|------|
| R1 | **已完成** | 8/8 agents 合入；MessageAvatar 已物理删除 |
| R2 | **已完成** | I–N 结构改动已落地（CardPanel / autoIndex / autoScroll / leaf / column resize / vscroll / thinking timer） |
| R3 | **基本完成（有残留）** | streamingStore + 单测已落地；热路径旁路未 100% 接通（见 backlog） |

### R1 结果摘要

| Agent | 状态 | 要点 |
|-------|------|------|
| A | ✅ | `htmlNeeded` 默认 false，不再每帧 bridge/hljs |
| B | ✅ | `addTerminalLines` 单次 set |
| C | ✅ | tree resize：rAF + 拖中 DOM/CSS，松手一次 store |
| D | ✅ | tab drag：rAF + translate3d + rect 快照 |
| E | ✅ | terminal fit rAF；ghost 去掉 display toggle |
| F | ✅ | withLogger clearMarks + 不 dump 全 state |
| G | ✅ | 删头像/气泡 shrink；composer scrollHeight + draft 防抖 |
| H | ✅ | 流式直出 Incremental MD；流式 skipHighlight |

### R2 结果摘要

| Agent | 状态 | 要点（代码核验） |
|-------|------|------|
| I | ✅ | `CardPanel` memo + 不订整 session；`autoIndexMiddleware` id 集合变化才重建 |
| J | ✅ | `useChatAutoScroll`：DOM scrollHeight 增量 + rAF 合并，无 pretext |
| K | ✅ | `TreeLeafPanel` / leaf 路径稳定化（懒加载 + 选择器） |
| L | ✅ | `Workspace` / canvas 接 `useColumnResize`（rAF + pointerup 提交） |
| M | ✅ | `VirtualScrollManager` messageId 高度；`MessageVirtualizer` 自定义 memo |
| N | ✅ | `ThinkingTimer` 自持 interval，父行不因秒数重渲 |

### R3 结果摘要

| Agent | 状态 | 要点 |
|-------|------|------|
| O | ✅（局部） | `streamingStore`（无 immer）+ `setStreamText` / thinking；`streamingStore.test.ts` |
| P | ⚠️ 部分 | batcher 默认写 streamingStore；**renderBuffer `onFrame` 仍 `updateMessageText` 写 session**；UI 未统一 `applyStreamTextToMessage` 订阅旁路 |
| Q | ✅ | 验收单测清单 + 手工 checklist（本文件 §9 + `PERF_VERIFY_CHECKLIST.md`） |
| R | ✅ | 文档更新；pretext 热路径扫描：composer / autoScroll / virtualizer 已去；sidebar 量字仍用 pretext（非流式热路径） |

### R1 agent IDs

| Agent | subagent_id | label |
|-------|-------------|-------|
| A | `019fa3e8-6209-7bc2-b191-53b10787ffd8` | r1-stream-buffer |
| B | `019fa3e8-620a-7b62-96d4-251d4dbd6e92` | r1-terminal-batch |
| C | `019fa3e8-620b-7021-a0ad-62b503e9b8ed` | r1-tree-resize |
| D | `019fa3e8-620d-7c33-b4c1-c7548cbf9e94` | r1-tab-drag |
| E | `019fa3e8-620e-7d50-bbe6-d4ae0ba26cdc` | r1-ro-sidebar |
| F | `019fa3e8-620f-75c1-b170-24d794dda540` | r1-logger |
| G | `019fa3e8-6210-7760-80c3-9cd4ce23f95b` | r1-ux-composer |
| H | `019fa3e8-6211-79e3-9c2c-afe88d9df155` | r1-stream-md |

---

## 8. 原 plan 优先级对照（执行序）

| 原 P | 编号 | 轮次 |
|------|------|------|
| P0 | #7 #1 #12 | R1 |
| P0 | #10 | R3（依赖 memo 链） |
| P1 | #8 #4 #2 #3 #15 | R1/R2 |
| P2 | #5 #9 #13 #11 #16 | R2 |
| P3 | #6 #14 #17 | R1/R2 |
| 增补 | 头像/气泡/composer/流式 MD | R1 G+H |

---

## 9. 自动化验证命令（R3-Q）

```powershell
# Typecheck desktop workspace
npm --workspace @crish/crish-desktop run typecheck

# Core perf unit tests
npx vitest run `
  apps/crish-desktop/src/api/StreamRenderBuffer.test.ts `
  apps/crish-desktop/src/api/VirtualScrollManager.test.ts `
  apps/crish-desktop/src/store/autoIndexMiddleware.test.ts `
  apps/crish-desktop/src/store/streamingStore.test.ts `
  apps/crish-desktop/src/api/streamTextBatcher.test.ts `
  packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts `
  apps/crish-desktop/tests/fuzz/stream-buffer.test.ts `
  apps/crish-desktop/tests/fuzz/virtual-scroll.test.ts

# Optional one-shot script (writes docs/perf/_verify_out.txt)
powershell -File docs/perf/_run_verify.ps1
```

**关联修复（R3-Q）**

- `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts`：`degraded` 语义对齐为「本帧后 *remaining* backlog > maxBacklogBytes」；用例改为压出剩余 pending 并 `htmlNeeded: true` 验证跳过 HTML。

---

## 10. 诚实 backlog（未做完 / 需手测）

| 项 | 严重度 | 说明 |
|----|--------|------|
| #10 正文热路径旁路未闭环 | **P0 残留** | 助手 **text** 路径：`useStreamCallbacks` 主路径 `buffer.onFrame → updateMessageText` 仍可能每帧写 session；`commitStreamToSession` / `snapshotStreamTextToSession` 与行级 `useStreamingStore` 订阅是否全链路强制，以代码为准复查。**工具 intermediate 已旁路**（见 §12 / W5-1），勿与正文债混谈 |
| 桌面 typecheck 存量错误 | 中 | `tsc-final.log` 等存在与 perf 无关的 EOPT / 缺模块错误；勿与 R1–R3 回归混淆 |
| 流式 MD 终态高亮 | 低 | 流式 `skipHighlight`；complete 后 bridge 重建可高亮 — 需手测无 plain→MD 闪 |
| 侧栏 pretext | 低 | session list 量字仍用 pretext，非 composer/stream 热路径 |
| live resize DOM map | 中 | Wave 6 / shell S4.3 **partial**：未做到「仅 paint 受影响子树」全量 |
| FPS / Long Task 量化 | 手测 | 无 CI 自动化；见 `PERF_VERIFY_CHECKLIST.md` |

---

## 11. 手工验证要点（流式 / 拖拽 / 输入）

完整勾选表见：[`docs/perf/PERF_VERIFY_CHECKLIST.md`](./PERF_VERIFY_CHECKLIST.md)

**流式**

1. 高速流式（长 markdown + 代码块）：应持续有 MD 结构（粗体/列表/代码壳），不应先 plain 再闪成 MD。
2. DevTools Performance：流式 10s 内 Long Task >50ms 尽量 <2；不应每 token 跑 `highlightCode`。
3. 历史消息在流式过程中尽量不因 token 重渲（React Profiler / why-did-you-render 可选）。
4. 流结束后代码块应有最终高亮（若产品开启）。

**拖拽 / resize**

1. 二叉树 sash：拖中 UI 跟手，松手才进历史；中途 Escape 可取消。
2. 列/组 resize（`useColumnResize`）：拖中 rAF，pointerup 一次 commit。
3. Tab drag：跟手 translate，无明显每帧布局抖动。
4. 侧栏 session 拖拽 ghost 不挡指针。

**输入**

1. 中文 IME 连续输入不丢字。
2. Composer 增高用 scrollHeight，keystroke 路径无 pretext prepare。
3. Draft 防抖：快速输入不卡，切换会话 draft 不串。

---

## 12. Wave 4–6 / D0-8 增补（2026-07-29）

> 中控波次合入后的 **perf-report 短纪要**。细节与验收面：
> [`docs/plans/progress/wave4-6-perf-notes.md`](../plans/progress/wave4-6-perf-notes.md)
> 进度：[`system-control-ledger.md`](../plans/progress/system-control-ledger.md)

| 主题 | 事实 | 波次 |
|------|------|------|
| Tool 写路径 | **intermediate → `streamingStore`（无 immer）**；**terminal → session**（durable；merge 不得被 lite 覆盖） | W5-1 |
| Unit strip | `UnitSessionTabStrip` **窄订阅**（本 unit 投影，不订整 openTabs/root） | W4-3 |
| Sash | **memo**，拖中减无关 leaf 重渲 | W4-3 / D0-7 |
| Live resize | DOM map **partial**（全量子树限定仍 residual） | W6-7 / S4.3 |
| 可观测 | **health overlay**（dev）+ control / empty-shell **metrics** | W5-6 / W4-8 / W5-5 |
| PTY | **Job Object**（Windows）+ exit **`kill_all`** | W6-2 / W4-4 |
| 控制队列 | **force / steer / followUp** 三环（pi 对齐）；L3>L2>L1 | W6-1 |

R1–R3 正文 #10 残留仍在 §10；本表不关闭 md SoT / fixture / stream crate。
