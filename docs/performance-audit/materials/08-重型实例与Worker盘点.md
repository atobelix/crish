# 08 · 扫描素材：重型实例 / Worker / 工具输出双份 / 悬挂引用

> 日期：2026-09-13

## 1. 重型实例持有

### 1.1 xterm / WebGL

`components/workspace/useXtermTerminal.ts`：dispose 对称（observer/listener/RAF/addon/term）。隐藏 tab 全存活 → 02 X1，内存视角：每终端 WebGL 纹理 + scrollback + 256KB history。

### 1.2 tiptap

`TiptapEditorField.tsx:209-366`：destroy/监听/rAF/弹层 ReactRenderer 全清理。E1 编辑实例挂虚拟窗口内 —— 02 已覆盖。

### 1.3 MarkdownBlockItem

`chat-message-row/MarkdownBlockItem.tsx`：React.memo 锁定封口块。渲染结果缓存走 `api/markdownCache.ts` LRU（500 条 / 16MiB）+ memoryManager.register。非 WeakMap 持 DOM —— 正确。

### 1.4 codeHighlight LRU

`api/codeHighlight.ts:123-155`：200 条 / 8MiB；raw≤500 才写缓存；safe 路径 4000 字符熔断。memoryManager 收缩接线。

### 1.5 PreviewCard / LayerStack

`ui/PreviewCard.tsx` register/unregister 对称；LayerStackManager 有 unregister。

## 2. 工具输出 DOM 与字符串双份

- store 层：`MessageToolCall.output` 全文（streamCallbacksEvents.ts:209 `output: displayOut || output || '完成'`）
- 展示层：`fullToolOutput` 仅清洗不截断（toolOutputSanitizer.ts:54-59）；折叠预览用 truncateToolOutput（16 行/1600 字符）
- ToolCallOutput.tsx:68-70：`full = fullToolOutput(raw)` 再生成一份字符串；DOM 再持一份 HTML
- 展开卡片时峰值 ≈ store 原文 + sanitize 结果 + DOM HTML 三份

02 T 域已记渲染面；本方向补：**store 侧无输出字节上限**（依赖 Rust 侧 T4 默认预算，10 方向报告）。

## 3. Worker 与 transferable

`workers/worker-pool.ts`：
- Stream E 后默认 renderWorkers=2，compute/io/network=0（worker-pool-options.ts:40-47）
- schedule 支持 transferables（:286-289）；生产调用面 `markdownRenderAsync.ts:45` 未传 transferables → 结构化克隆
- idle 60s 回收，保留 ≥1（:364-379）
- AbortController per task（:261）
- dispose 全 terminate（:424-436）
- **缺口**：taskQueue 无上限；极端积压时 Task 对象（含 payload 引用）驻留。中低危。
- postMessage 无 transferable 的 markdown HTML 字符串每任务一份克隆 —— 与 01 渲染热路径交叉。

## 4. 会话切换 / 关闭 run / 卸载面板后的悬挂引用

| 场景 | 清理 | 缺口 |
| ---- | ---- | ---- |
| 删会话 | SessionCoordinator 级联 5 步 | composerDrafts 不清理 |
| 停 run | finalizeAgentMessages + clearStreams microtask | 正常 |
| 切会话 | 无 messages 驻留驱逐 | 非活跃全文常驻 |
| 卸 VSM | MessageVirtualizer unregisterActiveVsm | 对称 |
| 卸面板 | TreeLeafPanel killPty + dispose | 对称（02） |
| MessageSnapshots._activeVsmBySession | unregister on unmount | 对称 |

## 5. 深拷贝峰值

`sessionSharedHelpers.messageMerge.ts:180-188` cloneMessages：structuredClone 或 JSON 双份。分支 `sessionOrderingActions.ts:115` 调用 —— 分支瞬间消息树 ×2。

## 6. 内存压力响应

`entry-core.tsx:117-128`：level 3 仅 clear 空闲队列。markdown/highlight LRU 由 memoryManager 包内自动 shrink；**streaming 残留、非活跃会话 messages、PTY history 不在压力响应面**。
