# 06 — Markdown 异步批次锁存、失败回退与 Render 期 Ref 污染修复报告

> **执行任务**：Task-6 Markdown 异步渲染批次锁存、失败回退与 Render 期 Ref 污染修复专员  
> **所属战役**：`docs/message-disappearance-audit/`（历史消息消失灾难级缺陷全链路根因修复）  
> **依据文档**：
>
> - `docs/message-disappearance-audit/00-总方案.md`（RC-06）
> - `docs/message-disappearance-audit/audits/07-消息行与Markdown渲染组件审计.md`（§4.1, §4.2, §4.3）
> - `docs/message-disappearance-audit/audits/04-虚拟滚动与列表渲染管线审计.md`（VS-03）  
>   **遵循准则**：`AGENTS.md`（§1 逻辑规划与反退避、§2 子 Agent 调度、§3 Git 提交纪律、§7 严禁补丁与立体验证纪律、§11 CI 治理与解耦断言）  
>   **报告产出时间**：2026-10-12  
>   **严格限定的负责文件域**：
> - `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`
> - `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.test.tsx`
> - `apps/crish-desktop/src/api/markdownRenderAsync.ts`
> - `apps/crish-desktop/src/api/markdownRenderAsync.test.ts`

---

## 一、修复背景与根因回顾（RC-06 专项）

根据专项审计报告 `audits/07-消息行与Markdown渲染组件审计.md` 与 `audits/04-虚拟滚动与列表渲染管线审计.md`（VS-03），Markdown 渲染管线存在 3 处导致流式正文丢字、封口锁存空壳 `<p class="md-p"></p>`、历史静态消息变空白 DOM 以及 React 18 StrictMode 下跨块残留旧 DOM 的严重缺陷：

1. **RC-06-A / VS-03（中危 · 封口失败忽略 `failed` 标志致空白 DOM）**：
   - 在 `MarkdownBlockItem.tsx:147` 中，调用 `useAsyncMarkdownHtml` 时仅解构了 `sealedHtml`，完全丢弃了 `failed` 错误标志。
   - 当 Rust IPC `core_md_render` 缺失或抛错且 Worker Pool 降级路径也异常（或对非空原文解析返回空串）时，`useAsyncMarkdownHtml` 置 `failed = true, html = ''`；但 `MarkdownBlockItem` 因未捕获 `failed`，且没有像 `MarkdownDocumentView.tsx:341` 那样提供纯文本降级回退，导致历史静态消息在无缓存命中的异常情况下永久停留为 `renderedHtml = ''`，消息气泡内正文呈现为完全空白的 DOM 节点！
2. **RC-06-B（高危 · `advanceBatchIdRef` 误丢弃在途增量分片致丢正文与空壳锁存）**：
   - 在 `markdownRenderAsync.ts:173, 194-243` 的 `useStreamingMarkdownHtml` 中，引入了 `advanceBatchIdRef` 并于每次 `useEffect` 无条件前置递增。
   - `IncrementalMarkdownSession` 属于**有状态增量消费器**，每次 `advance(markdown)` 只消费当拍新增的 delta，且只返回当拍的新增 `textParts`。新段落会先同步向 units 推入空壳 `<p class="md-p"></p>`，等待异步 `Promise.all(partPromises)` 完成后调用 `session.resolveTextPart` 填补真实正文。
   - 当后续高频 token 属于不产生 `textParts` 的字符（如独立换行符 `\n`、代码块围栏、行尾潜在 Markdown 标记 `!*_[~`）或短片段命中缓存先一步返回时，下一拍会立即自增 `advanceBatchIdRef.current`；导致上一拍在途异步 IPC 刚返回时，在 `advanceBatchIdRef.current !== currentBatchId` 守卫处被**静默丢弃**！`session.getUnitSnapshots()` 与 `setRenderVersion` 不被执行，若随后进入封口过渡（`SEALING_PENDING`），`lockedUnitsRef` 将直接锁存尚未填充文本的空壳 `<p class="md-p"></p>`，正文内容永久消失。
3. **RC-06-C（中危 · Render 阶段直接写 Ref 破坏 React 18 StrictMode 与纯渲染契约）**：
   - 在 `MarkdownBlockItem.tsx:94-112` 中，组件在渲染函数体（Render Phase）内直接执行 `streamingTextRef.current = text`。
   - 在 React 18 `StrictMode` 双调用或并发渲染中断重跑下，第 1 次调用使 `streamingTextRef.current` 提前变为了新 `text`；第 2 次真正采纳的调用计算 `isSameBlockContinuation(streamingTextRef.current, text)` 恒返回 `true`，导致 `allowEmptyClear` 被错误算为 `false`，Zero-Collapse Guard 拒绝清空旧块 DOM，导致跨块复用时旧内容错误残留。

---

## 二、核心修复方案与实现细节

### 1. 修复 VS-03：解构 `failed` 标志并提供安全纯文本回退（零空白 DOM 保证）

在 `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx` 中：

- **解构 `sealedFailed`**：
  ```tsx
  const { html: sealedHtml, failed: sealedFailed } = useAsyncMarkdownHtml(
    isEffectivelySealed && !isPriorTable ? text : '',
    priority
  );
  ```
- **判定降级态 `isFailedFallback`**：
  当块处于有效封口态（`isEffectivelySealed`）、`sealedFailed === true` 且同步 LRU 缓存未命中（`!cachedHtml`）时，激活纯文本兜底分支：
  ```tsx
  const isFailedFallback =
    isEffectivelySealed && Boolean(sealedFailed) && !cachedHtml;
  ```
- **纯文本安全回退节点**：
  通过 React 原生子节点将 `text` 渲染为转义纯文本节点（零 innerHTML 注入，零 XSS 隐患），配以 `markdown-fallback-text` 与 `styles.mdTextFallback` 样式，设置 `data-failed="true"`：
  ```tsx
  if (isFailedFallback) {
    return (
      <div {...dataAttributes} data-has-html="false" data-failed="true">
        <div
          className={`markdown-fallback-text ${styles.mdTextFallback || ''}`.trim()}
        >
          {text}
        </div>
      </div>
    );
  }
  ```
  **彻底消除历史消息因底层编译异常而变成空白 DOM 的隐患**。

---

### 2. 修复 RC-06-B：以会话级代次与单元追踪取代粗暴批次拦截

在 `apps/crish-desktop/src/api/markdownRenderAsync.ts` 中：

- **移除错误的 `advanceBatchIdRef`**：废除每次 `useEffect` 强制递增批次导致丢弃在途分片的逻辑。
- **引入会话级代次守卫 `sessionEpochRef`**：
  会话代次仅在以下合法生命周期节点递增：
  1. `!enabled || !markdown.trim()`：流式关闭或内容清空；
  2. 组件卸载（cleanup 回调）；
  3. `advance.reset === true`：输入源文本非延续性突变，增量状态机内部触发 reset。
  ```ts
  const sessionEpochRef = useRef(0);
  const unitRevisionMapRef = useRef<Map<number, number>>(new Map());
  const tickRef = useRef(0);
  ```
- **微任务回执平滑收口**：
  在 `Promise.all(partPromises).then((results) => ...)` 中：
  - 若 `sessionEpochRef.current !== sessionEpoch`，说明会话已重置或销毁，立即丢弃过时回调；
  - 若处于同一会话代次，则依次调用 `session.resolveTextPart(res.id, res.fragment)`；
  - 只要有分片成功决议（`anyResolved === true`），立即同步更新快照：
    ```ts
    if (unitsRef) {
      unitsRef.current = session.getUnitSnapshots();
      setRenderVersion((version) => version + 1);
    } else {
      setHtml(session.toHtml());
    }
    ```
  - 即使后续高频 tick 产生 0 个 `textParts` 或先行完成，在途的段落分片也绝不被丢弃，决议完成后自动无缝并入 units，**彻底根治 RC-06 空壳 `<p class="md-p"></p>` 锁存缺陷**。

---

### 3. 修复 RC-06-C：消除 Render 阶段 Ref 写入，遵循 React 18 纯渲染契约

在 `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx` 中：

- **禁止 Render 期改写 `streamingTextRef.current`**：
  在渲染函数体内保持 `streamingTextRef.current` 仅读；将其写入后移到 `useLayoutEffect` 中：
  ```tsx
  useLayoutEffect(() => {
    if (!text || !isContinuation) {
      streamingUnitsRef.current = null;
      lockedUnitsRef.current = null;
      if (!text) {
        lastSafeHtmlRef.current = null;
        wasStreamingGfmTableRef.current = false;
      }
    }
    streamingTextRef.current = text;
  }, [text, isContinuation]);
  ```
- **纯函数求值 `isContinuation`**：
  在 React 18 `StrictMode` 双调用期间，两次 Render 看到的 `streamingTextRef.current` 完全一致，计算得到的 `isContinuation` 与 `allowEmptyClear = !isContinuation` 保持幂等稳定。
- **跨块安全隔离**：
  若 `!isContinuation`，当前帧计算 `effectiveLockedUnits` 为 `null`，且活跃尾块 `effectiveIncrementalUnits` 强制置为 `null`，确保旧块的单元快照不会被新块误用，同时 `allowEmptyClear = true` 驱动 `ReconciledMarkdownHtml` 原生清空旧 DOM。

---

## 三、修改文件全景与代码 Diff

### 1. `apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.tsx`

```diff
-  if (!text || !isContinuation) {
-    streamingTextRef.current = text;
-    streamingUnitsRef.current = null;
-    lockedUnitsRef.current = null;
-    if (!text) {
-      lastSafeHtmlRef.current = null;
-      wasStreamingGfmTableRef.current = false;
-    }
-  } else if (streamingTextRef.current !== text) {
-    streamingTextRef.current = text;
-  }
+  const effectiveLockedUnits = isContinuation ? lockedUnitsRef.current : null;

...

-  const { html: sealedHtml } = useAsyncMarkdownHtml(
+  const { html: sealedHtml, failed: sealedFailed } = useAsyncMarkdownHtml(
     isEffectivelySealed && !isPriorTable ? text : '',
     priority
   );

+  useLayoutEffect(() => {
+    if (!text || !isContinuation) {
+      streamingUnitsRef.current = null;
+      lockedUnitsRef.current = null;
+      if (!text) {
+        lastSafeHtmlRef.current = null;
+        wasStreamingGfmTableRef.current = false;
+      }
+    }
+    streamingTextRef.current = text;
+  }, [text, isContinuation]);

...

-  const isSealingPending =
-    !isActiveTail && !renderedHtml && Boolean(lockedUnitsRef.current?.units.length);
-  const effectiveIncrementalUnits = isActiveTail
-    ? (streamingUnitsRef.current ?? lockedUnitsRef.current?.units ?? null)
-    : isSealingPending
-      ? lockedUnitsRef.current?.units
-      : undefined;
+  const isSealingPending =
+    !isActiveTail && !renderedHtml && Boolean(effectiveLockedUnits?.units.length);
+  const effectiveIncrementalUnits = isActiveTail
+    ? (isContinuation ? (streamingUnitsRef.current ?? effectiveLockedUnits?.units ?? null) : null)
+    : isSealingPending
+      ? effectiveLockedUnits?.units
+      : undefined;

...

+  const isFailedFallback =
+    isEffectivelySealed &&
+    Boolean(sealedFailed) &&
+    !cachedHtml;
+
+  if (isFailedFallback) {
+    return (
+      <div {...dataAttributes} data-has-html="false" data-failed="true">
+        <div className={`markdown-fallback-text ${styles.mdTextFallback || ''}`.trim()}>
+          {text}
+        </div>
+      </div>
+    );
+  }
```

### 2. `apps/crish-desktop/src/api/markdownRenderAsync.ts`

```diff
-  const advanceBatchIdRef = useRef(0);
+  const sessionEpochRef = useRef(0);
+  const unitRevisionMapRef = useRef<Map<number, number>>(new Map());
+  const tickRef = useRef(0);

   useEffect(() => {
     mountedRef.current = true;
     const session = sessionRef.current;
     if (!session) return;

     if (!enabled || !markdown.trim()) {
-      advanceBatchIdRef.current += 1;
+      sessionEpochRef.current += 1;
+      unitRevisionMapRef.current.clear();
       session.reset();
...
     }

-    const currentBatchId = ++advanceBatchIdRef.current;
     const advance = session.advance(markdown, !unitsRef);
+    if (advance.reset) {
+      sessionEpochRef.current += 1;
+      unitRevisionMapRef.current.clear();
+    }
+    const sessionEpoch = sessionEpochRef.current;
+    const currentTick = ++tickRef.current;
+
+    const currentSnapshots = session.getUnitSnapshots();
+    for (const u of currentSnapshots) {
+      unitRevisionMapRef.current.set(u.id, currentTick);
+    }
...
     void Promise.all(partPromises).then((results) => {
       if (!mountedRef.current) return;
+      if (sessionEpochRef.current !== sessionEpoch) return;

       let anyResolved = false;
       for (const res of results) {
         if (session.resolveTextPart(res.id, res.fragment)) {
           anyResolved = true;
         }
       }
-      if (!anyResolved || advanceBatchIdRef.current !== currentBatchId) return;
+      if (!anyResolved) return;

       if (unitsRef) {
         unitsRef.current = session.getUnitSnapshots();
...
   useEffect(() => () => {
     mountedRef.current = false;
-    advanceBatchIdRef.current += 1;
+    sessionEpochRef.current += 1;
+    unitRevisionMapRef.current.clear();
     sessionRef.current?.reset();
   }, []);
```

---

## 四、自动化测试与验收结果

### 1. 单元测试全量通过（40/40）

运行测试指令：

```bash
npx vitest run apps/crish-desktop/src/api/markdownRenderAsync.test.ts apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.test.tsx
```

测试执行结果：

```
 RUN  v3.2.7 C:/Software/conex

 ✓  unit  apps/crish-desktop/src/api/markdownRenderAsync.test.ts (24 tests) 1746ms
 ✓  unit  apps/crish-desktop/src/components/chat-message-row/MarkdownBlockItem.test.tsx (16 tests) 402ms

 Test Files  2 passed (2)
      Tests  40 passed (40)
   Duration  20.16s
```

覆盖的核心回归场景：

1. **VS-03 零空白 DOM 验收**：封口块 Rust/Worker 编译失败（`failed: true`）时，渲染包含安全转义文本的 `.markdown-fallback-text` 兜底容器，`data-failed="true"`，杜绝空 DOM；
2. **React StrictMode 幂等验收**：在 `<React.StrictMode>` 双调用模式下切换不同 Markdown 块，Ref 无污染，`isContinuation` 正确计算，旧 DOM 彻底清除；
3. **在途分片平稳收口验收**：先序滞后的异步分片在后续批次之后到达时，成功收口并入单元，正文完整保留不丢字；
4. **后续空分片 tick 穿透验收**：后续 tick 传入纯换行符（产生 0 个 `textParts`）时，上一拍在途异步段落不被丢弃并正常锁存为包含正文的单元。

### 2. 代码行数预算校验（RL-03 Line Budget）

运行检查指令：

```bash
node scripts/check-line-counts.mjs
```

检查结果：

```
[check-line-counts] Starting RL-03 Line Budget Verification...
[check-line-counts] Summary:
  Scanned: 33 files
  Warnings: 0
  Violations: 0
  Hard blocks: 0
  Baselined (存量登记): 1
[check-line-counts] ✅ All scanned files passed RL-03 line budget checks!
```

各修改文件代码行数均在严格阈值之内：

- `MarkdownBlockItem.tsx`：253 行（UI Component 上限 500 行，完全合规）；
- `markdownRenderAsync.ts`：304 行（Business Logic 上限 400 行，完全合规）。

### 3. TypeScript 静态类型检查

执行命令：

```bash
npx tsc -p apps/crish-desktop/tsconfig.app.json --noEmit
```

本任务负责的 4 个目标文件（`MarkdownBlockItem.tsx`、`MarkdownBlockItem.test.tsx`、`markdownRenderAsync.ts`、`markdownRenderAsync.test.ts`）**零类型报错、零警告**。

---

## 五、Git 纪律与交付说明

- 本 Agent 严格遵循 `AGENTS.md` §3 Git 提交纪律：**未执行 `git commit`**，所有代码修改干净保留于工作区；
- 严格限制在指定的 4 个责任文件内，未触碰任何其他文件；
- 产出报告落盘于 `docs/message-disappearance-audit/execution/06-Markdown异步批次与失败回退修复报告.md`，交由主 Agent 统一核查与收口提交。
