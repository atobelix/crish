# T-H 性能轨道 · 详细计划（流式增量渲染恢复 + complete 收口 + 搜索态 + perf 防线）

- 轨道：T-H（对应 07 方案步骤 0-5；00 总计划批次 8，2 Agent）
- 输入（全部实读）：
  - `docs/frontend-audit/40-final-plan/00-master-plan.md`（批次 8、T-H 依赖 T-C memo 面）
  - `docs/frontend-audit/20-proposals/07-performance-rendering-proposal.md`（步骤 0-5 方案）
  - `docs/frontend-audit/30-reviews/01~03`（P0-6 落点、07 贴合度、批 10 划分、StreamingTextBlock StrictMode 守卫 P1-3、ChatMessageList/MessageContent 同文件串行、步骤 0 压测脚本自建）
  - `docs/frontend-audit/10-analysis/07-performance-rendering-audit.md`（15 项风险 R-01~R-15 证据）
- 实读代码基线：2026-08-09 工作区（行号以实读为准，执行时语义定位优先——03 评审 ② 漂移清单约定）
- 性质：只读 + 本文档产出（详细计划，可派发执行）
- 编码：UTF-8 无 BOM，中文

---

## 0. 执行总览

| 项 | 内容 |
|---|---|
| 批次归属 | 00 总计划批次 8（8.1 流式增量 / 8.2 complete+搜索 / 8.3 perf 防线） |
| 依赖面 | T-C（02 C1 props 聚合）的 memo 面「已就绪」后执行；同文件串行：`MessageContent.tsx`/`ChatMessageList.tsx` 本轨道先行，02-C1 与 08-步7 排后 |
| 提交划分 | commit-1 = 步骤 0+1（性能基线 + 流式增量渲染恢复）；commit-2 = 步骤 2+3+4（complete 收口 + 搜索态 + 重渲染热点）；commit-3 = 步骤 5（perf 防线 + 小项收尾） |
| 任务数 | 27（T0.x 3 / T1.x 7 / T2.x 4 / T3.x 4 / T4.x 4 / T5.x 5） |
| 门禁 | `npm run typecheck` + 快层 vitest + 中层全量 + 5 个 markdown-editor e2e 专项（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）+ streaming-render/tool-streaming 专项 + 本轨道新增测试 |
| 红线 | streamingStore 契约不动（全文覆盖 + 同值拦截）；不复活 IncrementalMarkdownParser；禁止 `--no-verify`；一次性脚本随批入库 |

---

## ① 管线偏差确认（实读证据）

| # | 偏差 | 证据（实读） | 定性 |
|---|---|---|---|
| 1 | `RenderFrame.html` 恒 `''`、`chunkUpdates` 恒空数组——增量解析通道从未接线 | `StreamRenderBuffer.ts:197-198` 写死 `html: ''`、`chunkUpdates: []`；头注释 `:14-19` 自认「解析器尚未接入」；`AsyncMarkdownBlock.tsx:24` 自证「D0 residual」 | 与 07 方案 2.1、07 审计 R-03 一致 |
| 2 | `frame.delta` 字段**有值但被消费端丢弃**：`onFrame` 只写 `frame.full` 全量文本 | `useStreamCallbacks.ts:298` `setStreamText(sid, assistantMsgId, frame.full)`；`StreamRenderBuffer.ts:193-194` `delta = batch.join('')` 已正确产出 | 增量通道缺口在**消费端**，帧控制（8192B/6ms 预算，`flushFrame` 纯函数 :241-279）无需改动 |
| 3 | 消费端每帧全量重算：`applyStreamTextToMessage`（O(blocks)）→ `buildAssistantTimeline`（O(tools+blocks)）→ `stripThoughtPlaceholders`（8 个 `gm` 正则整文扫描，`markdownRenderLite.ts:35-73`） | `MessageContent.tsx:56-70`（displayMsg 全量重建 + timeline）、`:119`（strip 每帧） | 每帧同步成本随文本线性增长（R-10） |
| 4 | `isStreaming` 只覆盖最后一项 | `MessageContent.tsx:122` `const streaming = isThinkingMsg && item.key === lastTextKey`；`thinkingMsgId = processing 助手消息`（`ChatMessageList.tsx:264-270`）→ 流式消息最后 text 块走纯文本分支（`AsyncMarkdownBlock.tsx:51-61`） | 历史块每帧走组件树遍历（N1：无 memo），靠 `useAsyncMarkdownHtml` LRU 缓存同步返回兜住 IPC（`markdownRenderAsync.ts:95-100`） |
| 5 | React 文本节点更新 = 整节点 `textContent` 替换（O(全文)） | React 单文本子节点 diff 语义（N2，30-02 评审 ⑦ 已复核）；`AsyncMarkdownBlock.tsx:58` `{text}` 每帧全量重写 | **只改 store 增量不改 DOM 写入方式，收益为零**——必须 ref + appendText |
| 6 | 搜索激活后 `windowScanKey = messages` → 流式期间每帧 O(n) 全量扫描 | `ChatMessageList.tsx:160-161` 条件选择；`:163-186` `collectMustIncludeIndices` + `resolveExpandedForKeepAlive` 依赖 `windowScanKey`；`sessionSearch.ts:345-358` `messageMatchesSearch` 每消息内部重 tokenize（N4，`:347`） | R-02（P1）；N5 的 `messagesIdsKey` join 每帧重建（`:156-159`）量级小，登记接受 |
| 7 | complete 单帧全量 flush + 同帧 commit/normalize/Rust IPC 连发 | `useStreamCallbacks.ts:716-718` `push('', true)` + `flush(true)`（force 无视预算，`StreamRenderBuffer.ts:95-102`）；`finalizeStopGeneration` 同型（`:1017-1018`） | R-01（P1）；N6：complete 后 `stripThoughtPlaceholders` 至少 3 遍（onComplete `:799`、`helpers.ts:58`、渲染路径） |
| 8 | 会话 store 任何变更 → 全链重渲染 + setActual 无同值去重 | `MessageVirtualizer.tsx:436-438` messages 引用比较放行；`useChatCardState.ts:69-77` selector 订阅全 store；`VirtualScrollManager.ts:110-124` setActual 同高仍 markDirty；`useVirtualScroll.ts:145-160` 无同值跳过 | R-04/R-05/R-06（P2） |
| 9 | N3：流式期间同一文本三份并存（`streamedFullText` `useStreamCallbacks.ts:608` / `buffer.fullText` / streamingStore byKey） | 实读三处各自累积 | 登记为 P2 后续项（本次不改，`streamedFullText` 是 commit 兜底） |

**偏差结论**：管线退化为「rAF 节流的全量重渲染」。修复方向按 07 方案 2.2 四条路径（A 增量通道 / B ref 桥接 / C 窗口化 + 签名缓存 / D 收口分帧），且**不复活 IncrementalMarkdownParser**（完成态 SoT 已是 Rust `md_render`，双实现 JS/Rust 渲染双轨漂移成本高；纯文本增量覆盖 95% 收益）。

---

## ② 流式增量实现设计（07-步骤1，P0-6 主体）

### 2.1 设计决策

| # | 决策 | 理由 | 落点 |
|---|---|---|---|
| D1 | **store 契约不动**：streamingStore 保持全文覆盖 + 同值拦截（`streamingStore.ts:132-147`）；`onFrame` 仍写 `frame.full` | copy/commit/stop 既有消费者读全文（`ChatAssistantMessageRow.tsx:177-199`、`helpers.ts:184-217`）；增量只在渲染组件内派生 | 不改 `StreamRenderBuffer.ts` / `streamingStore.ts`（步骤 1） |
| D2 | **delta 由消费端派生**：MessageContent 自持 stripper 状态（raw 长度游标），从 `streamText.slice(lastRawLen)` 求每帧新增量 | `frame.delta` 未穿透到组件层（delta 属 buffer 内部帧语义，组件层以 store 文本为 SoT 更稳）；O(1) 常量时间切片 | MessageContent 内部 |
| D3 | **增量剥离用「完成行窗口」而非「尾部 1KB 窗口」**：stripper 只对**已换行完结的行**做 strip，未完结尾行原样展示（详见 2.2） | 尾部窗口方案存在「展示文本收缩」问题（如 `## 本` → `## 本轮总结` 跨帧完成时已 append 文本无法撤销），完成行窗口保证 append 严格单调、无残留 | `markdownRenderLite.ts` 新增 |
| D4 | **文本节点写入用 ref 桥接**：新增 `StreamingTextBlock`，props 仅 `{ delta }`，render 返回空壳 div（无 children），`useLayoutEffect` 中 `appendChild(createTextNode(delta))` | N2：React 对 `{text}` 子节点更新是整节点 `textContent` 替换 O(全文)；ref 直写绕开 React 文本协调（桌面 SPA 无 SSR/hydration，30-02 评审确认可行） | 新增组件 |
| D5 | **timeline 签名缓存粒度 = 「非最后 text 块结构 + toolCalls 值」**：最后 text 块内容（流式增长）**不进签名** | 签名含最后块内容则每帧失效，缓存无意义；工具区（`buildToolRenderItems` 的 dedupe/分组，`timelineNormalizer.ts:119-162`）才是昂贵面，纯文本流式期间工具区不变 | `timelineNormalizer.ts` |
| D6 | **主体拆分**：timeline 主体（工具卡 + 稳定文本块）memo 化子组件 + 流式区独立渲染 StreamingTextBlock | 每帧剩余成本收敛为：O(blocks) 结构签名扫描（微秒级）+ O(增量) strip + O(增量) DOM append | `MessageContent.tsx` |
| D7 | **历史块 `AsyncMarkdownBlock` 补 React.memo**（比较器：text/isStreaming/priority） | N1：无 memo 时整棵块树每帧重渲染 | `AsyncMarkdownBlock.tsx` |

### 2.2 IncrementalThoughtStripper 设计（markdownRenderLite.ts 新增）

```ts
// 状态（组件 ref 持有，按 (sessionId, msgId) 复位）
class IncrementalThoughtStripper {
  // 已完结行区域的原始游标（raw 长度）
  private rawLen = 0;
  // 已完结行区域累积追加给 DOM 的显示文本
  private displayLen = 0;
  // 未换行尾行缓冲（原样）
  private partialLine = '';

  /** 输入全文，返回本帧应 append 给 DOM 的增量；next(full) 需满足 full 单调增长 */
  next(full: string): { appended: string; display: string; resynced: boolean };
  /** 复位（msg.id 变更 / 流重启 / 文本收缩时） */
  reset(): void;
  /** 终态一次性输出 = stripThoughtPlaceholders(full)（与全量版共用实现，见 2.3） */
  finalFlush(): string;
}
```

- 每帧逻辑：
  1. `newPart = full.slice(rawLen)`；`rawLen = full.length`；若 `full.length < rawLen`（流重启/换消息）→ `reset()` 并返回 `{ resynced: true, appended: '' }`（上游负责重挂载 StreamingTextBlock）。
  2. 在 `newPart` 的**最后一个 `\n` 处**切开：`completedRegion = newPart.slice(0, lastNl + 1)`（含换行），`partialLine = newPart.slice(lastNl + 1)`（未换行尾行，原样展示）。
  3. `strippedRegion = stripCompletedLines(completedRegion)`——复用 `stripThoughtPlaceholders` 的**同一套正则**（`markdownRenderLite.ts:43-71`），仅在「行锚定正则」上保证语义等价（见 2.3 对拍）；其中对 `\n{3,}→\n\n` 折叠做区域化处理。
  4. `displayPart = strippedRegion + partialLine`；`appended = displayPart`（因仅追加、无重算，`displayLen` 仅用于测试断言与 resync 检查）。
- **严格单调性保证**：完结行一旦 strip 即被「永久固定」进 DOM 历史，跨帧不会重算（占位标题在**完成当帧**即被剥离，无「先显示后消失」残留）；未完结尾行最多 1 帧延迟展示原文。
- **已接受偏差清单**（流式期仅此两类，complete 后自动收敛）：
  - D1：未换行尾行原样展示（未 strip）——complete 时由全量 strip 收敛；
  - D2：区域边界 `\n` 折叠偏差（≤2 空行，`\n{3,}→\n\n` 折叠可能跨区域边界漏折）——complete 收敛。
- **doc-start 前缀不变式**：`^(正在思考中…|正在处理…){1,50}` 前缀类正则锚定文档开头——第一个完成行区域天然包含文档头，前缀恒在首区域被处理；后续区域不重复匹配（该正则随区域锚点漂移面在对拍中验证，见 2.3）。

### 2.3 增量 strip 与全量 strip 的等价性保障（对拍测试）

- **单实现原则**：不复制正则。`stripThoughtPlaceholders(text)` 全量版保留（complete/fallback 路径），`IncrementalThoughtStripper` 的 `finalFlush()` 内部**直接调用全量版**（增量版是「区域化分批应用同一正则」的调度层）。→ 双实现漂移面收敛为「区域切分边界」一处。
- **对拍测试**（T1.6）：
  - fixture 集：中文占位行（`正在思考中…`/`正在处理…`）、`## 本轮总结`/`**本轮小结：**`/`【本回合回顾】`/裸行/英文 Round summary、CJK、空行边界（2/3/4 连换行）、BOM 头、尾行有/无换行、占位行恰好跨区域边界、doc-start 前缀长变体。
  - property 式：随机串接 fixture 片段（seed 固定），断言 `concat(逐帧 appended) === stripThoughtPlaceholders(全文)` **或** 落在 D1/D2 偏差清单内（断言偏差类型化：D1 仅出现在「末帧未换行尾行」、D2 仅出现在「区域边界 ≤2 空行」）。
  - 终态收敛：`stripper.finalFlush()` === `stripThoughtPlaceholders(全文)`（恒等断言，无偏差）。
  - StrictMode 守卫测试（30-02 评审 P1-3）：挂载 → append(delta1) → 模拟 React 19 StrictMode effect 双执行 → 断言节点文本 = delta1 而非 delta1+delta1；重挂载（换 msg.id）→ 断言节点复位。

### 2.4 StreamingTextBlock 设计（chat-message-row/ 下新建）

```tsx
export interface StreamingTextBlockProps {
  /** 本帧新增文本（可为 ''） */
  delta: string;
}
export const StreamingTextBlock: React.FC<StreamingTextBlockProps> = React.memo(
  ({ delta }) => {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      if (!mountedRef.current) { el.textContent = ''; mountedRef.current = true; } // StrictMode/重挂载守卫
      if (delta) el.appendChild(document.createTextNode(delta));
    }, [delta]);
    return <div ref={ref} className={`${styles.assistantText} md-rendered ${styles.isStreaming}`} data-streaming="true" />;
  }
);
```

- **React 约束落点**（N 发现）：
  - children 恒为空 → React 从不协调文本子节点；DOM 文本由 `useLayoutEffect` 在提交后、paint 前直写（O(增量)）；
  - 挂载守卫 `mountedRef`：React 19 StrictMode effect 双执行防重复 append；重挂载（key=msg.id 变更）→ 新节点天然空；
  - 卸载：React 整体删除 div 节点，内部 text node 一并回收，无泄漏面；
  - **契约红线**：任何路径不得向本组件传 children / text prop（fallback 渲染走 AsyncMarkdownBlock，见 MessageContent 重构）。
- 复制路径不变：`getStreamText` 读 store 全文（`ChatAssistantMessageRow.tsx:179-184`）。
- caret/滚动跟随：沿用现有 CSS（`.isStreaming` 已含 caret 样式）。

### 2.5 文件级任务（步骤 1，7 个）

| # | 任务 | 文件面 | 验证 | 完成判据 |
|---|---|---|---|---|
| T1.1 | 新增 `IncrementalThoughtStripper`（完成行窗口 + 尾行缓冲 + 区域化 strip 调度 + `finalFlush` 复用全量版）；全量 `stripThoughtPlaceholders` 保留 | `markdownRenderLite.ts`（新增类与导出） | 对拍 fixture 集 + property 测试（T1.6 承载） | D1/D2 偏差类型化断言成立；finalFlush === 全量版 |
| T1.2 | 新增 `timelineSignature(msg)`（非最后 text 块结构 + toolCalls 值签名）+ `buildAssistantTimelineCached(msg, prevSig, prevTimeline)`；经 `toolPresentation.ts` 门面导出 | `tool-presentation/timelineNormalizer.ts`、`api/toolPresentation.ts` | 签名缓存命中/失效单测（工具事件→失效；纯文本增长→命中） | 命中时返回上次 timeline 引用；失效语义与 `buildAssistantTimeline` 输出逐项相等 |
| T1.3 | 新建 `StreamingTextBlock`（delta-only + ref appendText + StrictMode 守卫 + memo） | `chat-message-row/StreamingTextBlock.tsx`（新建） | append 累积 / 重挂载复位 / 双执行守卫单测 | 节点文本 = 各 delta 拼接；复位场景归零 |
| T1.4 | `AsyncMarkdownBlock` 包 `React.memo`（比较器：text/isStreaming/priority） | `chat-message-row/AsyncMarkdownBlock.tsx` | reRenderMonitoring 断言（T1.7） | 稳定 props 块渲染 0 次 |
| T1.5 | `MessageContent` 重构：①持有 stripper ref（按 sessionId+msgId 复位，文本收缩/`live=false` 时 reset）；②从 `streamText` 派生 delta 交给 StreamingTextBlock；③timeline 主体拆 memo 化子组件（`TimelineBody`，props：timelineRef/toolStackProps/msgId/status），流式区独立；④挂签名缓存；⑤fallback/error/empty 路径**不**复用流式节点（走 AsyncMarkdownBlock 全量） | `components/chat-message/MessageContent.tsx`（含行内新增 TimelineBody） | 单测：delta 派生正确性（多帧拼接 = stripped 全文）；复位路径（换消息/重启/complete）| 每帧 DOM 写入量 = delta 长度（O(增量)）；非流式块零渲染；完整路径不回归（streaming-render e2e） |
| T1.6 | 单测组：StreamingTextBlock 语义 + stripper 对拍（fixture+property）+ 签名缓存命中/失效 + 复位 | `markdownRenderLite.test.ts`（或并入现有文件）、`StreamingTextBlock.test.tsx`（新建） | vitest 快层 | 全绿 |
| T1.7 | `reRenderMonitoring` 扩展：流式帧期间非流式 `AsyncMarkdownBlock` 渲染次数 = 0；性能采样对照步骤 0 基线 | `src/__tests__/reRenderMonitoring.test.tsx`、压测脚本 | 断言 + 基线对比 | 流式期无 >50ms 长任务；平均帧间隔不劣化 |

**依赖与串行**：本步与 02-C1 同文件（`MessageContent.tsx`）——02-C1 排本步之后（00 批次依赖链已声明）；`StreamRenderBuffer.ts`/`streamingStore.ts`/`useStreamCallbacks.ts` 本步不动。

---

## ③ complete 收口（07-步骤2，R-01）

### 3.1 flushFinal 预算语义（StreamRenderBuffer.ts 新增）

现状：`push('', true)` + `flush(true)` → force 无视预算单帧输出全部（`useStreamCallbacks.ts:716-718`、`:1017-1018`；`StreamRenderBuffer.ts:95-102`）。

新增 `flushFinal()`（`flush(force)` 保留给既有语义，`force=true` 仍可用但**不再被 complete 路径调用**）：

| 残余量 | 路径 | 单帧成本 |
|---|---|---|
| `bufferedLength() ≤ 2 × maxBytesPerFrame`（≈16KB，常态） | 同步 `flush(true)`（有界：≤16KB 一次 setStreamText + 渲染，数毫秒级） | 无长任务（有界） |
| 大残余（异常积压，如 100KB） | `markFinal()` + 普通 `flushFrame(false)` 预算循环（rAF 分帧，每帧 8192B/6ms） | 每帧 ≈ 帧预算 |

- `flushFrame` 已产出正确 `isFinal`（`finalMarked && pending.length === 0`，`StreamRenderBuffer.ts:195`）——无需改纯函数，只加编排层。
- 单测扩展（`StreamRenderBuffer.framing.test.ts`）：final 标记 + 大残余（如 64KB）下断言「force=false 预算恒成立」——任一帧 batch 字节 ≤ maxBytesPerFrame；≤2 帧残余时单帧刷完且 isFinal=true。

### 3.2 onComplete / finalizeStopGeneration 接线（useStreamCallbacks.ts）

- **drain 帧守卫放宽**：现 `onFrame` 第 294 行 `if (runClosed && !frame.isFinal) return;` 会丢弃 complete 后全部中间帧——分帧 drain 下中间帧是「最终文本增量」，应放行：
  - 新增 `draining` 标志；onComplete 置 `draining = true`（不置 `runClosed`），调 `flushFinal()`；
  - 守卫改为：`if (runClosed && !draining && !frame.isFinal) return;`（draining 期间中间帧照常 `setStreamText`，UI 文本以预算节奏自然流完，无「停一下再出最终版」的跳跃感）；
  - **isFinal 帧到达 → `finishComplete()`**：即现 onComplete 的 flush 之后全部逻辑（commitStreamToSession → normalize → status → scheduleRunFinalHtml → diag → usage），执行后 `runClosed = true`、`draining = false`。
- **新 run 不被阻塞**：`onComplete` 同步段立即删 `streamManagerRef` entry（原在 isFinal 帧后删，`useStreamCallbacks.ts:857-861`）——L1 follow_up 拒绝窗口以 streamManager 为门（`:235-254`），drain 期间新发送可入队不误拒；`generationMapRef.delete` 同步执行。
- **commit 文本来源不受影响**：`commitStreamToSession` 的 text 优先级 = `getStreamText`（isFinal 帧已写入全量）→ `buffer.currentText()`（含 pending 兜底，`helpers.ts:201-203`、`StreamRenderBuffer.ts:136-138`）。
- **stop 路径**：`finalizeStopGeneration`（`:1005-1110`）同步 `push('', true)` + `flush(true)` 改走 `flushFinal()`；stop 语义保持「立即出 partial」（≤2 帧常态直接同步刷完，行为不变）。

### 3.3 主块瘦身 + N6 单次化

| 项 | 改动 | 落点 |
|---|---|---|
| 主块瘦身（D 路径） | `recordStreamDiag`（`:736`）、`checkAndAlertSilentComplete`（`:849`）移出同步主块 → `queueMicrotask`；usage 估算已异步（`:862-978`）不动；**关键路径保留**：commit + status 转换 + normalize + `scheduleRunFinalHtml` | `useStreamCallbacks.ts` |
| N6：strip 三遍收敛 | ① onComplete 计算 `cleaned` 后：`scheduleRunFinalHtml` 改收**预清理文本**（新增 `scheduleFinalMarkdownHtmlCleaned(cleaned)` 或参数化，`helpers.ts:53-74` 不再二次 strip）；② `stripThoughtPlaceholders` 加**结果缓存**（`WeakMap<string, string>`，同输入免重跑）——渲染路径（MessageContent）与 complete 路径共享 | `helpers.ts`、`markdownRenderLite.ts` |

### 3.4 文件级任务（步骤 2，4 个）

| # | 任务 | 文件面 | 验证 | 完成判据 |
|---|---|---|---|---|
| T2.1 | `StreamRenderBuffer.flushFinal()`：≤2 帧同步 + 大残余预算分帧编排 | `StreamRenderBuffer.ts` | `StreamRenderBuffer.framing.test.ts` 扩展（大残余无超限帧；≤2 帧单帧收口） | 64KB 残余：任一帧 batch ≤ maxBytesPerFrame；isFinal 仅最后一帧 |
| T2.2 | onComplete/finalizeStopGeneration 接线：`draining` 标志 + 守卫放宽 + `finishComplete` 拆分 + streamManager 立即释放 | `useStreamCallbacks.ts` | 单测（可注入 buffer 的 callbacks 路径——按现有 `useStreamCallbacks` 测试基建）；e2e tool-streaming/streaming-render | complete 后 2 帧内流式态切完成态；drain 期间新发送不被误拒 |
| T2.3 | 主块瘦身（diag/alert → 微任务）+ N6 strip 单次化（预清理文本入 HTML 调度 + WeakMap 缓存） | `useStreamCallbacks.ts`、`helpers.ts`、`markdownRenderLite.ts` | 单测：`scheduleFinalMarkdownHtmlCleaned` 不再二次 strip（spy）；缓存命中计数 | complete 同步主块仅剩关键路径 |
| T2.4 | 验证：100KB 场景 complete 帧无 >50ms 长任务（压测/Playwright 断言雏形）+ 收口体感验证 | 压测脚本、e2e | 基线对照 + 人工验证 | complete 最大任务 <50ms（对照步骤 0 基线）；5 个 markdown-editor 专项 e2e 全绿 |

---

## ④ 搜索态优化（07-步骤3，R-02）

### 4.1 设计

| # | 项 | 设计 | 落点 |
|---|---|---|---|
| S1 | **query 预折叠** | `searchMatch` useMemo（`ChatMessageList.tsx:147-151`）内一次完成 `tokenizeSearchQuery` + `normalizeSearchQuery`；新增 `messageMatchesSearchTokens(msg, tokens, normQuery)` 纯函数（内部不再 tokenize，`sessionSearch.ts:347` N4 修复）；原 `messageMatchesSearch(msg, query)` 保留为包装（其他消费方：`MessageVirtualizer.tsx:326` 行级高亮等不受影响） | `sessionSearch.ts` |
| S2 | **命中缓存（immer 对象身份）** | 新增 `collectMustIncludeIndicesCached(messages, options, cache)`（`messageWindow.ts` 或新 helper）：cache = `{ queryKey, Map<msgId, { msgRef, hit }> }`；重求值时逐消息 `cache.get(id)?.msgRef === msg` 命中直接复用（immer 结构共享保证未变消息**引用不变**，30-02 评审确认）——纯文本流式期只有最后一条消息换引用 → O(1)/帧；工具状态变更 → 仅该消息重求值 | `messageWindow.ts`（编排） |
| S3 | **keep-alive 重扫节流** | `resolveExpandedForKeepAlive`（`ChatMessageList.tsx:173-186`）在 processing 期：`windowScanKey` 降为 `messagesIdsKey`（id 签名，`searchMatch` 激活时不再用 messages 引用）——流式消息恒在尾部窗口内，keep-alive 结果不可能变；`mustIncludeIndices` 用 S2 缓存 → 每帧 O(1)。非流式期（无 processing）恢复 messages 引用扫描（搜索编辑/审批时命中需即时响应） | `ChatMessageList.tsx` |
| S4 | N5（`messagesIdsKey` 每帧 join O(n)） | 保持现状（窗口 ≤80 条 join 为微秒级），登记接受；不做增量签名 | — |

**节流窗口语义**：以「processing 是否激活」为开关（`msg.status === 'processing'` 判定已有 `thinkingMsgId` 现成来源 `ChatMessageList.tsx:264-270`），不做 500ms 时间窗合并（避免命中响应延迟）；时间窗合并仅在命中结果**确实可能变化**时才需要，而流式期已由 S3 证明不会变——开关式节流更简单且零延迟。

### 4.2 文件级任务（步骤 3，4 个）

| # | 任务 | 文件面 | 验证 | 完成判据 |
|---|---|---|---|---|
| T3.1 | `messageMatchesSearchTokens` 预折叠匹配 + 原 API 包装；对拍既有用例集 | `sessionSearch.ts` | `sessionSearch.test.ts` 扩展：`tokens 版 === 原版`（既有 messageMatchesSearch 用例集全量对拍） | 对拍全绿；行级高亮行为无回归 |
| T3.2 | `collectMustIncludeIndicesCached`（queryKey + msgId→{msgRef,hit} 身份缓存） | `messageWindow.ts` | 单测：命中/失效三路径（query 变更 / 消息增删 / 工具状态终态）+ 引用未变不复算（spy 计数） | 缓存键失效断言全覆盖 |
| T3.3 | ChatMessageList 接线：tokens memo、S2 缓存注入、S3 processing 期 windowScanKey 降级 | `ChatMessageList.tsx` | 既有 `ChatMessageList.windowScan.test.tsx` 扩展（processing 期扫描次数断言） | 流式期间每帧扫描成本 ≤1ms（100 消息）；搜索高亮/跳转无回归 |
| T3.4 | 压测：100 消息会话 + 搜索激活 + 流式 60s 每帧扫描耗时采样（步骤 0 对照） | 压测脚本 | 基线对比 | 每帧 ≤1ms；keyboard-navigation/wysiwyg-interaction 专项 e2e 全绿 |

**串行**：`ChatMessageList.tsx` 与 08-步7（role="log"）、02-C1 同文件——本轨道先行（00 批次依赖链已声明）。

---

## ⑤ 重渲染热点（07-步骤4，R-04/R-05/R-06，结合 02 的 props/memo 面）

| # | 任务 | 文件面 | 验证 | 完成判据 |
|---|---|---|---|---|
| T4.1 | R-04：`VirtualScrollManager` 新增 `getActualHeight(id)` + `setActual` 内部同值跳过（`entry.actual === height && entry.estimated === height` 才 return，`entry.actual == null` 即 invalidate 态仍照常写入）；`useVirtualScroll.setActual` 入 pending 前同值跳过；rAF flush 同值不调 `setActualTick` | `VirtualScrollManager.ts`、`useVirtualScroll.ts` | `VirtualScrollManager.test.ts`/`useVirtualScroll` 测试扩展：同高写入不 markDirty、不 tick（spy） | 完成态稳定行零重算；既有 `MessageVirtualizer.perf.test`（1500 条）全绿 |
| T4.2 | R-05：① `useChatCardState` messages/agents/goalMode 等 9 selector 增加**会话级订阅短路**：自定义 `useScopedSessionField(sid, selector)`（vanilla `subscribe((state, prev) => ...)`，`prev.sessionsById[sid] === next.sessionsById[sid] && prev.activeSessionId === next.activeSessionId` 时直接短路，不重求值）；② `snapshotStreamTextToSession`（`helpers.ts:224-237`）同值短路：`text === 现有 msg.text` 时跳过 `updateMessageText` | `useChatCardState.ts`、`helpers.ts` | 单测：非活跃会话 patch 不触发本会话 selector 重求值（subscribe spy）；同值 snapshot 不写 store | 工具密集会话全链重渲染频率与工具事件数解耦；**实现前确认**：activeSessionId 来源与多 Tab 语义（30-02 评审 P2-4 / 07 方案风险 7——现多会话多 Tab 已判为浪费面，短路后视觉无变化） |
| T4.3 | R-06：① MessageVirtualizer 比较器重构为**声明式字段清单** `MEMO_COMPARE_FIELDS: (keyof MessageVirtualizerProps)[]`；② 类型级穷尽检查 `type Exhausted = Exclude<keyof MessageVirtualizerProps, typeof MEMO_COMPARE_FIELDS[number]> extends never ? true : false`（加 prop 忘比较器 → **tsc 红**）；③ `MessageVirtualizer.memo.test.tsx` 扩展：清单完整性命中断言 + 新增字段未收录时编译失败的对照用例；ChatAssistantMessageRow 比较器（`ChatAssistantMessageRow.tsx:53-91`）同法 | `MessageVirtualizer.tsx`、`ChatAssistantMessageRow.tsx`、`MessageVirtualizer.memo.test.tsx` | 清单测试 + typecheck | 加 prop 忘比较器 → 红（编译期）；比较器面在 02-C1 props 聚合落地后收窄（登记依赖） |
| T4.4 | reRenderMonitoring 扩展：工具密集会话（20 工具）流式期全链重渲染次数 = 工具事件数（而非帧数）；压测对照 | `reRenderMonitoring.test.tsx`、压测脚本 | 断言 + 基线对比 | 全链重渲染与帧数解耦 |

**依赖**：T4.3 的「收窄」部分依赖 02-C1（props 聚合）——本批先落地清单测试与类型级穷尽检查（自成闭环），02-C1 后收窄字段面；`useVirtualScroll`/`VirtualScrollManager` 与 02-E1（虚拟列表定案）同文件串行（30-01 评审 C13：本批先行）。

---

## ⑥ perf 回归防线（07-步骤5）

### 6.1 三层防线（L1/L2/L3）

| 层 | 工具 | 覆盖 | 时机 |
|---|---|---|---|
| L1 单测 | vitest（reRenderMonitoring / strip 对拍 / 比较器清单 / setActual 同值 / 命中缓存失效） | 增量渲染语义、memo 面、同值 no-op | 快层（提交） |
| L2 bench | `apps/crish-desktop/perf/` + compare-benchmarks（threshold 0.2） | 前端渲染管线模块（buffer/batcher/virtual/stripper/timeline 签名缓存） | perf-test.yml（PR/夜间） |
| L3 浏览器 | Playwright perf spec（rAF FPS + longtask observer + complete 帧计时 + 搜索态扫描） | 真实渲染链路端到端 | ci-mid e2e job（PR）→ perf-test.yml 夜间全量 |

### 6.2 L2 bench 设计（T5.1）

- 新建 `apps/crish-desktop/perf/`：输出与 shared-utils bench 同格式 JSON（`{name, avgMs, ops, p95Ms}`，对齐 `bench-definitions.ts:78` 的 `PerfBenchmark` 形态 + `scripts/compare-benchmarks.ts:5-13` 的 BaselineEntry）；
- 场景：`StreamRenderBuffer.flushFrame`（8192B 预算，100KB 输入）、`StreamTextBatcher` 合并、`VirtualScrollManager` offset 重建（1500 行，rebuildOffsets）、`IncrementalThoughtStripper.next`（单帧 vs 全量 strip 对比）、`buildAssistantTimelineCached`（签名命中 vs 未命中）；
- 接线：compare-benchmarks 扩展读取前端 bench 输出（合并进 baseline.json 或独立 baseline-frontend.json）；`.github/workflows/perf-test.yml` 增 job。

### 6.3 L3 Playwright perf spec 设计（T5.2）

- 位置：`tests/e2e/perf-streaming.spec.ts`（挂根 playwright.config.ts `e2e-l2` project；`tests/perf/` 目录若建则需独立 config——**决策：放 tests/e2e/ 复用现有 mock-engine 基建**，mock SSE 走 `installMockEngine` + 新增 `bigRunEvents()` fixture（100KB 文本 + 20 工具事件，delayMs=0~1 压榨管线））；
- 断言设计（不测绝对值测回归，`page.clock`/固定 rAF 采样窗口防噪）：
  - 流式期 rAF 采样（page.evaluate 收集 60s 内 rAF 间隔）：平均 fps ≥ 基线 ×0.8、无长停顿；
  - `PerformanceObserver('longtask')`：流式期 + complete 过渡长任务数 ≤ 基线 ×1.5（dev server 留余量，06 P1-1 落地后切 preview 重采）；
  - complete 帧耗时：`performance.mark` 锚点（最后 onComplete 事件 → `msg-row-assistant` 完成态出现）≤ 基线 ×1.5；
  - 搜索态扫描：激活搜索（**注入面需实现时确认**：`subscribeSearchQuery`/`getSearchQuerySnapshot` 为模块级导出 `sessionSearch.ts:572-581`，spec 经 `page.evaluate` 走 UI 搜索框或 window 注入面二选一——见风险 ⑦-8）后流式期间每帧长任务计数；
- 基线 JSON：`tests/perf/baselines/desktop-{tier}.json`（tier 语义对齐 performanceEngine）；CI 并发降级标注 `[perf-flaky]` + rerun 策略；
- 接线：`.github/workflows/ci-mid.yml` e2e job 增 spec（或 perf-test.yml 联动——**决策：PR 中层挂 ci-mid，夜间全量走 perf-test.yml**，与 07 方案 4.1 一致）。

### 6.4 小项收尾（R-09/11/12/13/08/15）

| # | 项 | 任务 | 完成判据 |
|---|---|---|---|
| T5.3 | R-09 | `main.tsx` 补 `reactInteractiveReady` perf 标记（`root.render` 后首个 rAF 打点进 `window.__crish_perf`）；AppErrorBoundary 与 App chunk 并行预取（`Promise.all` 替代串行 await，`main.tsx:72-80`） | `__crish_perf.reactInteractiveReady` 可查；首屏 render 不再被 boundary chunk 阻塞一拍 |
| T5.4 | R-11 | `onRunError` 收口补 `generationMapRef.current.delete(sid)`（`useStreamCallbacks.ts:627-703` 区间；条件：`streamManagerRef.current.get(sid)?.assistantMsgId === assistantMsgId`，对齐 complete `:857-861` 语义） | 多次 run error 后 Map 无残留（单测：注入 error 路径断言 delete 调用） |
| T5.4 | R-12 | `memoryLeak.test.tsx` 扩展：EventBus 监听器 >10 触发 warn（`EventBus.ts:85-87` MAX_LISTENERS_WARN）+ 订阅/退订循环后监听器数不增长；`sessionSearch.ts:560-575` listeners Set 退订清理断言 | 泄漏单测全绿 |
| T5.4 | R-13 | StoreFreq 增强（`bootstrapStores.ts:26-44`）：dev overlay 补订阅者计数 + 重渲染范围统计（采样 subscribe 回调执行次数） | dev overlay 可查订阅者数/重渲染范围 |
| T5.5 | R-08 | `TiptapEditorField`：粘贴/输入超阈值（**建议 50KB，实现时按压测校准**）先发警告 toast；防抖窗口末帧全量序列化记录预算提示（保留既有权衡，不拆 worker——成本收益见 07 方案） | 阈值触发验证（playwright 注入大文本粘贴事件断言 toast 出现）；30-01 评审 5.2 补全的完成判据 |
| T5.5 | R-15 | `tests/startup/` 增 Playwright 真实环境档位：`startup-e2e.spec.ts` 测首屏（skeleton 可见 → `#root` 交互），阈值宽松（真实环境与 Node spawn 解耦） | 档位可跑通、阈值登记 |

---

## ⑦ 验证与提交（批次 8 收口）

### 7.1 验证链（每提交）

1. **步骤 0 基线先行**（commit-1 前置）：`tests/perf/` capture 脚本落盘三锚点基线 JSON——流式期平均帧间隔 / 最长任务 / complete 帧耗时 / 搜索态每帧扫描耗时（100KB + 20 工具 mock SSE 场景；脚本入库，AGENTS.md 测试资产铁律）。预期基线（修复前）：长任务随文本线性增长、complete 帧 >50ms、搜索态每帧扫描随消息数线性。
2. **每提交门禁**：`npm run typecheck` + 快层 vitest（含本轨道新增）+ 相关单测；commit-2/3 加中层 vitest 全量 + 5 个 markdown-editor e2e 专项 + streaming-render/tool-streaming。
3. **性能采样对比**：每提交后跑步骤 0 脚本，修复后数字对照基线（目标态：每 token 更新 O(增量)、complete 无 >50ms 长任务、搜索态每帧 ≤1ms、工具密集会话全链重渲染 = 工具事件数）。
4. **人工验证**：100KB 压测会话实播——流式顺滑、complete 无「停一下再出最终版」体感。

### 7.2 批次 8 提交清单（2 Agent，串行 + 并行窗口）

| 提交 | 内容 | Agent 分工 | 文件面 |
|---|---|---|---|
| commit-1 | 步骤 0+1（基线 + 流式增量渲染恢复） | Agent-A | `markdownRenderLite.ts`、`timelineNormalizer.ts`、`toolPresentation.ts`、`StreamingTextBlock.tsx`（新）、`AsyncMarkdownBlock.tsx`、`MessageContent.tsx`、`reRenderMonitoring.test.tsx`、`tests/perf/`（新） |
| commit-2 | 步骤 2+3+4（complete 收口 + 搜索态 + 重渲染热点） | Agent-B（与 Agent-A **并行**，文件面零重叠：A 不动 `useStreamCallbacks.ts`/`StreamRenderBuffer.ts`/`sessionSearch.ts`/`messageWindow.ts`/`ChatMessageList.tsx`） | `StreamRenderBuffer.ts`、`useStreamCallbacks.ts`、`helpers.ts`、`sessionSearch.ts`、`messageWindow.ts`、`ChatMessageList.tsx`、`useVirtualScroll.ts`、`VirtualScrollManager.ts`、`useChatCardState.ts`、`MessageVirtualizer.tsx`、相关测试 |
| commit-3 | 步骤 5（perf 防线 + 小项） | Agent-A/B 合流 | `apps/crish-desktop/perf/`（新）、`tests/e2e/perf-streaming.spec.ts`（新）、`main.tsx`、`bootstrapStores.ts`、`useStreamCallbacks.ts`（R-11）、`TiptapEditorField.tsx`（R-08）、`memoryLeak.test.tsx`、`tests/startup/`、`.github/workflows/ci-mid.yml`、`perf-test.yml` |

**纪律**：每提交精确 add 本域文件（AGENTS.md 提交纪律）；`git status` 先行检查并行域（conex-browser 域 / markdown-editor R3）M 标记；一次性脚本随批入库；禁止 `--no-verify`。

### 7.3 与总计划/02/06 的对接

| 对接点 | 结论 |
|---|---|
| 00 批次 8 三行 | 8.1=commit-1、8.2=commit-2、8.3=commit-3（步骤 0/4 归并进对应提交） |
| T-H 依赖 T-C memo 面 | T4.3 收窄部分等 02-C1；`MessageContent.tsx`/`ChatMessageList.tsx` 同文件串行（本轨道先行） |
| 06 P1-1（生产 build 进 CI） | L3 判据精度依赖其落地；未落地前 perf spec 跑 dev server 留余量（30-03 评审 ⑥-8） |
| 04 高亮接线交叉点 | `streamingCodeHighlighter` 走 Rust 与「流式期零 IPC」方向相反——04 接线评估放 commit-1 定稿后（07 方案附注） |
| 03 状态方案 | 本轨道不改 store 结构，仅改订阅表达式/selector——无冲突 |

---

## ⑧ 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **appendText DOM 写入与 React 协调冲突**：若流式节点被传入 children/text prop 或 React 版本升级重协调文本子节点 → 文本重复 | 显示错乱 | StreamingTextBlock 契约红线（children 恒空）+ 单测锁定（append 累积/双执行守卫）+ 代码注释声明；fallback/error 路径不共用该节点 |
| 2 | **增量 strip 与全量 strip 语义漂移**：占位行/总结标题跨区域边界、空行折叠边界 | 流式期显示不一致 | 单实现原则（finalFlush 直接调全量版）+ 对拍 fixture 集（含边界用例）+ 偏差类型化（D1 尾行 / D2 ≤2 空行）+ complete 自动收敛 |
| 3 | **增量 vs 全文最终一致性**：append 累积文本 ≠ 最终渲染文本 | 复制/对比差异 | 复制走 store 全文（不读 DOM）；complete 时流式块卸载、最终文本由 `stripThoughtPlaceholders` 全量重算 + Rust 渲染——最终态恒等 |
| 4 | **stripper 状态复位遗漏**（换消息/流重启/文本收缩未 reset） | delta 错位、文本重复或丢失 | 复位守卫（msg.id 变更 / `full.length < rawLen` / `live=false`）+ 单测三路径 |
| 5 | **complete 分帧后 isFinal 延迟**：大残余时完成态切帧晚 1-N 帧 | commit 不受影响（`getStreamText`/`currentText` 含全量）；仅视觉延迟 | ≤2 帧常态同步刷完（延迟 0）；大残余预算 drain（接受延迟，换取无长任务）；commit 兜底 `buffer.currentText()`（既有） |
| 6 | **drain 期间守卫放宽的副作用**：`draining` 期间中间帧放行、runClosed 后置 | 新 run 误判 / 重复 commit | streamManager entry 同步释放（新发送可入队）；finishComplete 单次执行（`draining=false` 幂等）；`assertLive`/generation 守卫保持 |
| 7 | **命中缓存失效时机**（query/messages/工具状态三路径漏失效） | 搜索命中残留/漏检 | 缓存键 = queryKey + msgId→{msgRef,hit}（immer 引用身份）；失效三路径单测强制覆盖（07 方案风险 5） |
| 8 | **L3 搜索态注入面不确定**：`subscribeSearchQuery` 为模块级导出，spec 注入方式未定（UI 搜索框 vs window 注入） | perf spec 搜索态断言实现受阻 | 实现时二选一裁决：优先走 UI 搜索框（行为真实）；window 注入面若需暴露，先确认 a11y/工程面无冲突（标注为**实现时确认项**） |
| 9 | **L3 判据跑 dev server 偏差**（06 P1-1 未落地前） | 测不出生产态真实性能 | 阈值留余量 + 基线同环境同机器采集；06 落地后切 preview 重采基线（显式登记依赖，07 方案风险 3） |
| 10 | **R-05 会话级订阅短路改变跨会话行为** | 依赖「activeSessionId 恒与渲染中的 ChatCard 一致」假设 | 实现前确认 activeSessionId 来源与多 Tab 语义（30-02 评审 P2-4）；短路仅省求值、不改变渲染结果 |
| 11 | **同文件串行纪律破坏**：`MessageContent.tsx`/`ChatMessageList.tsx`/`useVirtualScroll.ts` 与 02-C1/08-步7/02-E1 并行 | 合并冲突 | 批次调度显式串行（本轨道先行）；commit-2 内 Agent-B 独占其文件面 |
| 12 | **04 高亮接线反向目标**：若 04 在 commit-1 前把高亮改走 Rust，流式期每帧 IPC 回归 | 流式渲染性能回退 | 04-07 交叉决策点登记：04 接线评估放流式纯文本路径定稿后（07 方案附注） |
| 13 | **大 HTML innerHTML 写入布局重排**（完成态 `AsyncMarkdownBlock.tsx:45`） | 既有残余面，非本轨道引入 | 登记接受（Rust 渲染已主线程零解析；布局重排属完成态一次性成本，长消息可见——07 审计 3.4 已列） |

---

## 附：任务清单总表（28）

| 组 | 任务 | 文件面（新增/改动） | 提交 |
|---|---|---|---|
| 步骤 0 | T0.1 压测场景与 capture 脚本；T0.2 三锚点基线采样落盘；T0.3 基线入库 | `tests/perf/`（新） | commit-1 |
| 步骤 1 | T1.1 stripper；T1.2 签名缓存；T1.3 StreamingTextBlock；T1.4 AsyncMarkdownBlock memo；T1.5 MessageContent 重构；T1.6 单测组；T1.7 reRenderMonitoring + 对照 | `markdownRenderLite.ts`、`timelineNormalizer.ts`、`toolPresentation.ts`、`StreamingTextBlock.tsx`（新）、`AsyncMarkdownBlock.tsx`、`MessageContent.tsx` | commit-1 |
| 步骤 2 | T2.1 flushFinal；T2.2 onComplete/finalizeStopGeneration 接线；T2.3 主块瘦身 + N6；T2.4 验证 | `StreamRenderBuffer.ts`、`useStreamCallbacks.ts`、`helpers.ts`、`markdownRenderLite.ts` | commit-2 |
| 步骤 3 | T3.1 预折叠匹配；T3.2 命中缓存；T3.3 ChatMessageList 接线；T3.4 压测 | `sessionSearch.ts`、`messageWindow.ts`、`ChatMessageList.tsx` | commit-2 |
| 步骤 4 | T4.1 setActual 同值；T4.2 sessionId 短路 + snapshot 同值；T4.3 比较器清单 + 类型穷尽；T4.4 reRenderMonitoring 工具密集 | `VirtualScrollManager.ts`、`useVirtualScroll.ts`、`useChatCardState.ts`、`helpers.ts`、`MessageVirtualizer.tsx`、`ChatAssistantMessageRow.tsx` | commit-2 |
| 步骤 5 | T5.1 L2 bench；T5.2 L3 Playwright spec；T5.3 R-09；T5.4 R-11/12/13；T5.5 R-08/R-15 | `apps/crish-desktop/perf/`（新）、`tests/e2e/perf-streaming.spec.ts`（新）、`main.tsx`、`bootstrapStores.ts`、`TiptapEditorField.tsx`、`memoryLeak.test.tsx`、`tests/startup/`、CI yml | commit-3 |

**一句话摘要**：T-H 轨道以「store 契约不动、增量只在渲染组件内派生」为边界，用完成行窗口 stripper + StreamingTextBlock ref 桥接把每帧成本压到 O(增量)，complete 预算式收口消除 >50ms 长任务，搜索态以 immer 对象身份缓存实现流式期 O(1)/帧扫描，最后以 L1 单测 / L2 bench / L3 Playwright 三层防线闭环，27 个任务分 3 个提交落地。
