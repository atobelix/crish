# 专项审计报告 07：终端输出与环形缓冲 (terminal-and-line-buffer)

> **审计基准**：`apps/crish-mobile`（Expo SDK 57 / RN 0.86 / React 19.2.3）  
> **调查员**：终端输出与环形缓冲调查员  
> **产出时间**：2026-09-04  
> **审计范围**：
> - `apps/crish-mobile/src/presentation/components/terminal/` (`TerminalView.tsx`, `terminalEvents.ts`, `terminalLineBuffer.ts`)
> - `apps/crish-mobile/src/presentation/screens/terminalScreen.tsx`
> - `apps/crish-mobile/src/domain/store/terminalStore.ts`, `terminalReducers.ts`
> - `apps/crish-mobile/src/domain/pure/terminalChunks.ts`, `ansi.ts`
> - `apps/crish-mobile/src/adapters/wiring/terminalWiring.ts`
> - `apps/crish-mobile/app/terminal/[runId].tsx`

---

## 模块架构全景

```
[WebSocket Inbound: events.push]
          │
          ▼
┌──────────────────────────────────────────────┐
│  terminalWiring.ts (mapTerminalFrame)        │
│  - 过滤 runId / tool-update / task-output   │
└──────┬───────────────────────────────────────┘
       │ dispatchTerminalActions
       ▼
┌──────────────────────────────────────────────┐
│  terminalStore.ts (Zustand + Immer)          │
│  - runs: Record<string, TerminalRunState>    │
│  - ingestLines(runId, text)                  │
└──────┬───────────────────────────────────────┘
       │ 架构层级倒置 (Domain 逆向引入 Presentation) ⚠️
       ▼
┌──────────────────────────────────────────────┐
│  terminalLineBuffer.ts                       │
│  - 5000 行限制 (TERMINAL_RING_MAX)           │
│  - 5000 字符行上限 (TERMINAL_MAX_LINE_CHARS) │
│  - ANSI 剥离 (domain/pure/ansi.ts)           │
│  - \n 提交 / \r 覆盖 / 空行压缩               │
└──────┬───────────────────────────────────────┘
       │ useSyncExternalStore (liveView)
       ▼
┌──────────────────────────────────────────────┐
│  terminalScreen.tsx                          │
│  - 双真理路径：liveView (镜像) vs fallback ⚠️ │
│  - entriesOfRun 遍历全量 windows ⚠️           │
└──────┬───────────────────────────────────────┘
       │ lines, startIndex, truncatedCount, follow
       ▼
┌──────────────────────────────────────────────┐
│  TerminalView.tsx                            │
│  - FlatList (getItemLayout: 24dp)            │
│  - auto-follow 吸底 (40dp 阈值)              │
│  - TerminalRow (memo, selectable ⚠️)         │
└──────────────────────────────────────────────┘
```

---

## 一、环形缓冲算法与内存安全

### 1. 缓冲数据结构与算法实质分析

- **代码位置**：[`terminalLineBuffer.ts:18-43`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts#L18-L43)
- **数据结构定义**：
  ```typescript
  export interface TerminalLineBufferState {
    lines: string[];
    pending: string;
    overwrite: boolean;
    maxLines: number;
    maxLineChars: number;
    truncatedCount: number;
  }
  ```
- **算法实质判定**：
  文件自称“有界环形”（`TERMINAL_RING_MAX = 5000`），但**底层并未实现真正的固定长度环形指针数组（Ring Array with Head/Tail Pointer）**，而是一个普通的 JavaScript 动态变长数组 `string[]`。
- **淘汰机制分析**：
  - 在 [`commitRow`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts#L123-L138) 中：
    ```typescript
    state.lines.push(text);
    const excess = state.lines.length - state.maxLines;
    if (excess > 0) {
      state.lines.splice(0, excess);
      state.truncatedCount += excess;
    }
    ```
  - **$O(N)$ 数组平移开销**：当缓冲达到 5000 行饱和态后，后续每新增一行提交，均执行 `state.lines.splice(0, 1)`。在 V8 / JSC / Hermes 引擎中，`splice(0, 1)` 需要将 5000 个数组元素整体向前复制一位。在大吞吐流式输出下（如几万行编译日志），会导致数万次 5000 级内存块搬移，产生持续的垃圾回收（GC）与 CPU 尖峰。

### 2. 首行偏移与行键稳定性机制 (`startIndex`)

- **代码位置**：[`terminalLineBuffer.ts:104-111`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts#L104-L111) 与 [`TerminalView.tsx:80-86`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L80-L86)
- **机制设计**：
  - 快照输出：`startIndex = state.truncatedCount`。
  - 行键提取器：`keyExtractor={(_line, index) => String(startIndex + index)}`。
  - 行测试 ID：`testID={`terminal-row-${startIndex + index}`}`。
- **有效性评估**：
  - 该单调递增的绝对索引设计能够在行淘汰时保持未被淘汰行的 Key 不变（例如第 100 行在被淘汰 10 行后，数组下标从 100 变为 90，但其计算 Key 为 `10 + 90 = 100`），避免了 FlatList 因 Key 漂移导致的全量 Cell 重绘。
- **潜在时序缺陷：跨 Chunk 分片的未终结行提前裁剪**：
  - 在 [`appendTerminalChunk:74-80`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts#L74-L80)：
    ```typescript
    const overflow = state.pending !== '' ? state.lines.length + 1 - state.maxLines : 0;
    if (overflow > 0) {
      state.lines.splice(0, overflow);
      state.truncatedCount += overflow;
    }
    ```
  - **严重缺陷**：如果当前 chunk 尾部带有未完成段 `pending`，此时为了满足“已提交 + pending ≤ maxLines”，提前执行了 `state.lines.splice(0, 1)` 并递增了 `truncatedCount`。
  - 如果紧随其后的下一个 chunk 开头接收到 `\r`（进度条重置光标覆盖 pending），或者接收到空行触发了连续空行折叠（`text === '' && last === ''` 返回 early return 未执行 push），**被提前裁掉的最旧有效行已被永久丢弃，无法恢复**，导致总行数跌落至 `maxLines - 1`，破坏了淘汰幂等性与数据完整性。

### 3. 截断提示与虚拟化布局错位重大漏洞

- **代码位置**：[`TerminalView.tsx:87-107`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L87-L107)
- **漏洞发现**：
  - 当 `truncatedCount > 0` 时，`TerminalView` 渲染 `ListHeaderComponent`：
    ```tsx
    ListHeaderComponent={
      truncatedCount > 0 ? (
        <View testID="terminal-truncated" style={styles.truncatedNotice}>
          <Text style={[styles.truncatedText, { color: theme.textSecondary }]}>
            已截断 {truncatedCount} 行早期输出（环形缓冲上限）
          </Text>
        </View>
      ) : null
    }
    ```
  - 但组件的 `getItemLayout` 却为：
    ```tsx
    getItemLayout={(_data, index) => ({
      length: TERMINAL_LINE_HEIGHT,
      offset: TERMINAL_LINE_HEIGHT * index,
      index,
    })}
    ```
  - **破坏性后果**：
    1. React Native 的 FlatList 规范明确规定：**当存在 `ListHeaderComponent` 时，`getItemLayout` 的 `offset` 必须加上 Header 的实际测量高度**！
    2. `styles.truncatedNotice` 包含 `paddingVertical: 6` 以及字体高度，实际高度约为 24~30dp。
    3. `getItemLayout` 硬编码 `offset = 24 * index`，导致所有行的高度坐标与 FlatList 内部虚拟化引擎产生 **24~30dp 的永久位移错位**！
    4. 用户滑动到顶部或执行 `scrollToIndex` 时，会出现可视区域撕裂、白屏闪烁、滚动位置弹跳甚至无法滚动到首行的问题。

### 4. 内存安全边界与泄漏隐患

- **理论极限内存占用**：
  - `TERMINAL_RING_MAX = 5000` 行；
  - `TERMINAL_MAX_LINE_CHARS = 5000` 字符；
  - 单个 Run 理论极端内存：$5000 \times 5000 = 2.5 \times 10^7$ 字符。在 Hermes 引擎（UTF-16 编码）中，仅原始字符缓冲区就高达 **50 MB**。
- **多 Run 内存常驻无淘汰（Leaking Multi-Run State）**：
  - [`terminalStore.ts:25`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/terminalStore.ts#L25)：`runs: Record<string, TerminalRunState>`。
  - 虽然接线层在收到 `run-terminal` 事件时会调用 `resetRun(runId)` 释放缓冲，但**如果桌面端未正常推送 `run-terminal`**（如用户杀掉后台进程、网络瞬断未重连、桌面崩溃、或长时间运行的任务），这些历史 Run 的 5000 行缓冲将**永久驻留于移动端内存**中。
  - 缺乏基于全局 Run 数量（如 LRU 最多保留最近 3 个活动 Run）的全局保护预算。在低内存移动设备上，多个长时间未收口的 Run 累积将直接诱发 OOM 闪退。

---

## 二、渲染性能与掉帧风险

### 1. 全链路同步透传与无节流风暴 (Throttling Absence)

- **代码链路**：
  1. [`terminalWiring.ts:88-92`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/terminalWiring.ts#L88-L92)：
     `WsGateway.on('events.push', (frame) => dispatchTerminalActions(mapTerminalFrame(...)))`
  2. [`terminalWiring.ts:58`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/terminalWiring.ts#L58)：
     `store.ingestLines(action.runId, action.text)`
  3. [`terminalStore.ts:43-45`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/terminalStore.ts#L43-L45)：
     调用 Zustand `set(...)`
  4. [`terminalScreen.tsx:61-65`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/screens/terminalScreen.tsx#L61-L65)：
     `useSyncExternalStore` 立即响应更新触发组件重渲染
  5. [`TerminalView.tsx:60-64`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L60-L64)：
     `useEffect` 触发 `targetRef.current?.scrollToEnd({ animated: false })`
- **掉帧分析**：
  - **零缓冲、零节流、零微任务合并**：当底层执行高并发流式输出（如 `npm install`、`cargo build` 吐出进度块，或短时间输出几百行日志）时，每秒可到达 50~200 个 WebSocket 帧。
  - 每一帧都在主 JS 线程触发：
    - Zustand 的 Immer 状态 Proxy 复制与 Finalize；
    - React 组件级 Diff；
    - 新数组分配（`terminalLinesOf` 中的 `[...state.lines, state.pending]`）；
    - FlatList 原生桥接层调用 `scrollToEnd`。
  - 在移动端真机上，单核 JS 线程占用率瞬间达到 100%，UI 交互彻底冻结，手势无响应，出现秒级卡顿（Jank / Freeze）。

### 2. 满缓冲下自动滚底 (Auto-Follow) 死锁冻结 Bug

- **代码位置**：[`TerminalView.tsx:60-64`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L60-L64)
  ```tsx
  useEffect(() => {
    if (follow && lines.length > 0) {
      targetRef.current?.scrollToEnd({ animated: false });
    }
  }, [follow, lines.length, targetRef]);
  ```
- **致命缺陷剖析**：
  - `useEffect` 的依赖项数组是 `[follow, lines.length, targetRef]`。
  - 当终端行数达到 `TERMINAL_RING_MAX = 5000` 行之后，新行进入会触发淘汰，`lines.length` 始终恒定保持为 5000！
  - **因为 `lines.length` 不再变化，`useEffect` 彻底停止触发！**
  - **后果**：**一旦终端输出满 5000 行，自动吸底跟随功能完全死锁失效**。用户在屏幕上看到的内容定格在第 5000 行，后续源源不断的新输出完全无法自动展示，必须手动反复滑动才能看到最新内容。

### 3. FlatList 与行渲染 Memo 效率分析

- **内联匿名函数导致 Memo 穿透**：
  - [`TerminalView.tsx:81-86`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L81-L86)：
    ```tsx
    renderItem={({ item, index }) => (
      <TerminalRow
        text={item}
        testID={`terminal-row-${startIndex + index}`}
      />
    )}
    ```
  - `renderItem` 在每次 `TerminalView` 渲染时都会重新创建闭包函数。
- **`selectable` 属性在虚拟化长列表中的性能灾难**：
  - [`TerminalView.tsx:136`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L136)：
    ```tsx
    <Text numberOfLines={1} selectable style={[styles.rowText, { color: theme.textPrimary }]}>
      {text}
    </Text>
    ```
  - 在 React Native（尤其是 Android 平台的原生 `ReactTextView`）中，为每个列表项开启 `selectable` 会为每个视口内元素创建原生文本选区管理器（Selection Modifier / ActionMode）。这不仅会大幅拖慢列表滚动时的原生测量与绘制速度，而且跨越多个 FlatList Cell 时根本无法进行多行连续划选。

---

## 三、ANSI 过滤有效性

### 1. 扫描器设计意图

- **代码位置**：[`apps/crish-mobile/src/domain/pure/ansi.ts:1-137`](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/ansi.ts#L1-L137)
- **优点**：采用逐字符编码扫描（Scanner）而非正则表达式，有效免疫了长文本或异常畸形输入下的灾难性正则回溯（ReDoS），单测中万字符长行能在数毫秒内完成。
- **白名单分类**：
  - SGR (`m`)：颜色与文字样式；
  - 光标移动 (`A`-`H`, `f`)；
  - 清屏清行 (`J`, `K`)；
  - 其余 CSI（私有模式 `?25l`、滚动 `r`、未知字符）以及 OSC（`ESC ] ... BEL` 或 `ESC \`）与独立 `ESC` 均执行剥离。

### 2. 致命漏洞：跨分片 (Cross-Chunk) 截断导致转义字符泄漏为乱码

- **代码位置**：[`terminalLineBuffer.ts:50`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts#L50)
  ```typescript
  export function appendTerminalChunk(state: TerminalLineBufferState, chunk: string): void {
    const clean = stripAnsi(chunk);
    ...
  ```
- **漏洞根因**：
  - `stripAnsi` 是一个**完全无状态**的函数。
  - 在 TCP/WebSocket 流式传输中，数据块是按字节流切片的。一个完整的转义序列极易被切在两个独立的 Chunk 中：
    - **Chunk 1**：`"Processing \x1b[3"`
    - **Chunk 2**：`"2mSuccess\x1b[0m\n"`
  - **执行跟踪**：
    1. Chunk 1 送入 `stripAnsi`：扫描到 `\x1b[`，后接 `'3'`，由于到达 chunk 尾部未找到 final byte（`0x40-0x7E`），命中第 98-101 行截断分支，剥除了 `\x1b[3`，Chunk 1 返回 `"Processing "`。
    2. Chunk 2 送入 `stripAnsi`：输入为 `"2mSuccess\x1b[0m\n"`。首字符为 `'2'`（ASCII `0x32`，不是 `ESC`）！
    3. `stripAnsi` 将 `'2'` 和 `'m'` 视为普通可见字符原样透传！
    4. **最终输出**：`"Processing 2mSuccess"`！
  - **结论**：**当前 ANSI 清洗逻辑在网络分片场景下无法做到无损防御，会稳定泄漏诸如 `2m`、`0m`、`1;31m` 等碎片乱码到移动端终端视图中！**

### 3. 控制字符清洗盲区与恶意注入风险

- **代码位置**：[`ansi.ts:70-75`](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/ansi.ts#L70-L75)
  ```typescript
  while (i < input.length) {
    if (input.charCodeAt(i) !== ESC_CODE) {
      text += input[i];
      i += 1;
      continue;
    }
    ...
  ```
- **安全与显示隐患**：
  除 `0x1b` 外的所有字符均被无条件原样保留！导致以下控制字符全部泄漏至原生 Text 组件：
  1. **`0x00` (NUL)**：在 React Native 的 Android/iOS 原生通信层，嵌入 `\0` 会导致底层 C++ / JNI / Objective-C 字符串发生不可预期的提前截断。
  2. **`0x08` (BS / Backspace)**：既未执行前向字符删除，也未剥除，原生渲染为未知方块字符（tofu）。
  3. **`0x07` (BEL), `0x0B` (VT), `0x0C` (FF), `0x7F` (DEL)**：全部直接穿透。
  4. **Unicode 双向覆盖（Bidi Trojans）注入**：
     - 如 `\u202E`（RLO）、`\u202B` 等双向控制符。
     - 若恶意输出包含此类字符，会导致整行文本甚至移动端 UI 的文字渲染方向反转（例如将 `rm -rf /safe/dir` 视觉欺骗呈现为其他内容），构成视觉伪造风险。
  5. **双字节 ESC 序列残留**：
     - 如 `\x1b(B`（VT100 字符集指定）、`\x1b=`（键盘模式）。由于不是 CSI (`[`) 或 OSC (`]`)，代码走第 126 行仅剔除 `\x1b`，导致 `(B` 或 `=` 残留为可见字符。

---

## 四、重复与死层

### 1. 架构层级倒置：Domain 层逆向依赖 Presentation 层

- **代码证据**：
  [`apps/crish-mobile/src/domain/store/terminalReducers.ts:11-16`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/terminalReducers.ts#L11-L16)
  ```typescript
  import {
    appendTerminalChunk,
    createTerminalLineBuffer,
    terminalLinesOf,
    type TerminalLineBufferState,
  } from '@/presentation/components/terminal/terminalLineBuffer';
  ```
- **违规定性**：
  - `terminalLineBuffer.ts` 物理存放在 `src/presentation/components/terminal/`，注释注明“纯函数、零 UI 依赖”。
  - 属于领域核心层/纯逻辑层的 `terminalReducers.ts` 反向引入了表现层的模块。
  - **严重违背整洁架构（Clean Architecture）依赖倒置原则**（Presentation 依赖 Domain，但 Domain 绝对禁止依赖 Presentation），亦触犯了根目录《AGENTS.md》§11 第 5 条“分层硬性解耦与禁逆向依赖”。
  - **整改方案**：将 `terminalLineBuffer.ts` 及其单元测试迁移下沉至 `src/domain/pure/terminalLineBuffer.ts`。

### 2. 双重真理路径（Dual Pipeline Drift）与无谓 CPU 消耗

- **双路径并存事实**：
  - **路径 A（实时镜像流）**：`WsGateway` $\rightarrow$ `TerminalWiring` $\rightarrow$ `terminalStore` $\rightarrow$ `terminalReducers` $\rightarrow$ `TerminalView`
  - **路径 B（全量历史流）**：`WsGateway` $\rightarrow$ `FeedBridge` $\rightarrow$ `eventStore` $\rightarrow$ `entriesOfRun` $\rightarrow$ `collectRunTerminalChunks` $\rightarrow$ `TerminalLineBuffer` $\rightarrow$ `TerminalView`
- **并发重复计算问题**：
  - 在 [`terminalScreen.tsx:68-79`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/screens/terminalScreen.tsx#L68-L79)：
    ```typescript
    const entries = useMemo(() => entriesOfRun(windows, runId), [windows, runId]);
    const buffer = useMemo(() => {
      const state = createTerminalLineBuffer();
      for (const chunk of collectRunTerminalChunks(entries)) {
        appendTerminalChunk(state, chunk);
      }
      return state;
    }, [entries]);
    ```
  - 即使当前 `liveView` 正常工作（正在显示 `terminalStore` 的镜像数据），只要全局 `windows` 发生任何微小变动（例如其他会话收到了消息），`entriesOfRun` 和 `buffer` 依然在后台**无条件全量重放计算**！
  - 相当于移动端在同时消耗双倍算力维护两份完全相同的行缓冲区。
- **生命周期断层与界面跳动**：
  - 在 [`terminalWiring.ts:43-45`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/terminalWiring.ts#L43-L45)：一旦收到 `run-terminal`，接线层立即派发 `terminal-run-end`，从而调用 `resetRun(runId)` 彻底抹除 `terminalStore` 中该 Run 的状态。
  - 此时 `liveView` 瞬间变成 `null`，组件被强制切换至 `fallbackLines`。如果 `eventStore` 的窗口由于本地配额限制被截断或存在时序差，用户将肉眼可见终端输出发生突变或闪烁。

### 3. 死代码与无用接口清单

| 符号 / 模块 | 声明位置 | 现状与定性 |
| :--- | :--- | :--- |
| `replaceAllTerminalText` | `terminalLineBuffer.ts:83-94` | **死代码**。声称支持 F3 §4.2 `tool-end` 权威终值覆盖，但在 `terminalWiring.ts`、`terminalReducers.ts` 及生产页面中从未被任何事件驱动调用，仅在测试中存在。 |
| `stripAnsiDetailed` | `ansi.ts:61-131` | **生产死接口**。返回详尽的分类统计对象，除 `ansi.test.ts` 自身测试外，没有任何业务代码调用该详细接口。 |
| `linesOf` | `terminalStore.ts:60-62` | **冗余选择器**。`terminalScreen.tsx` 采用的是直连 `terminalViewOf(runs, runId)`，未走 `linesOf`。 |
| `app/terminal/[runId].tsx` 守卫冗余 | `app/terminal/[runId].tsx:9-13` | 页面外层包裹了 Redirect 守卫，但如果在使用中途掉线，内层 `TerminalScreen` 并没有配对感知，而是呈现“未知”状态。 |

---

## 五、问题收敛清单与修复建议矩阵

| 编号 | 严重级别 | 问题类别 | 涉及文件与行号 | 根因与表现 | 推荐修复方案 |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **BUG-07-01** | **P0 (严重)** | 渲染死锁 | [`TerminalView.tsx:60-64`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L60-L64) | 满 5000 行后 `lines.length` 恒定，`useEffect` 停止触发，自动滚底彻底冻结。 | 将依赖项改为行增量游标 `cursor` 或首行绝对下标 `startIndex + lines.length`。 |
| **BUG-07-02** | **P0 (严重)** | 布局错位 | [`TerminalView.tsx:87-107`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L87-L107) | `getItemLayout` 硬编码 offset，未计入 `ListHeaderComponent` 截断提示高度（~24dp）。 | 截断提示改为绝对浮层或将 Header 高度动态计入 `getItemLayout.offset`。 |
| **BUG-07-03** | **P1 (高危)** | 性能风暴 | [`terminalWiring.ts:88`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/terminalWiring.ts#L88) $\rightarrow$ [`terminalStore.ts:43`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/terminalStore.ts#L43) | 流式输入零节流、零缓冲，大并发下一秒触发上百次 Zustand/React 渲染。 | 引入 RAF / 50ms 窗口批处理队列，聚合文本后再批量写入 store。 |
| **BUG-07-04** | **P1 (高危)** | 字符泄漏 | [`terminalLineBuffer.ts:50`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts#L50) + [`ansi.ts:61`](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/ansi.ts#L61) | 无状态 ANSI 清洗无法处理跨 Chunk 切片的转义序列，碎片被当作正文渲染。 | 在 buffer 状态中维护跨 chunk 的未完结转义序列状态缓冲区。 |
| **BUG-07-05** | **P1 (高危)** | 恶意/非法字符 | [`ansi.ts:70-75`](file:///c:/Software/conex/apps/crish-mobile/src/domain/pure/ansi.ts#L70-L75) | 未过滤 `0x00`、`0x08` 及 Unicode Bidi 方向反转控制符，导致 JNI 截断或显示欺骗。 | 扩充清洗逻辑，剥离 ASCII 0x00-0x1F（保留 `\n` 与 `\r`）及 Bidi 覆盖字符。 |
| **ARCH-07-01**| **P2 (架构)** | 层级倒置 | [`terminalReducers.ts:11-16`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/terminalReducers.ts#L11-L16) | Domain 层反向依赖 Presentation 层的 `terminalLineBuffer.ts`。 | 将 `terminalLineBuffer.ts` 物理下沉至 `src/domain/pure/terminalLineBuffer.ts`。 |
| **ARCH-07-02**| **P2 (架构)** | 算力浪费 | [`terminalScreen.tsx:68-79`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/screens/terminalScreen.tsx#L68-L79) | `liveView` 命中时仍无条件执行 `entriesOfRun` 与历史 buffer 重构。 | 将 fallback 重构改为惰性计算，仅在 `!liveView` 时触发。 |
| **PERF-07-01**| **P2 (性能)** | 渲染开销 | [`TerminalView.tsx:136`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/TerminalView.tsx#L136) | 每行启用 `selectable` 带来极端原生性能拖累且无法跨行选中。 | 移除单行 `selectable`，改为提供全选/复制当前终端全文的悬浮功能。 |
| **DEAD-07-01**| **P3 (清理)** | 废弃代码 | [`terminalLineBuffer.ts:83`](file:///c:/Software/conex/apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts#L83) | `replaceAllTerminalText` 从未接入生产，`tool-end` 事件未消费。 | 确认是否需接线 `tool-end`，若无需求则予以清理。 |
