# Wave 2 - Task W2-C：底层协调零坍塌护盾与单元 Diff 加固执行报告

> **任务编号**：Wave 2 - Task W2-C
> **责任域**：`ReconciledMarkdownHtml.tsx`、`unitReconciler.ts`、`ReconciledMarkdownHtml.test.tsx`
> **对齐规范**：`docs/stream-jitter-and-order-repair/01-规范-执行波通用.md`、`docs/stream-jitter-and-order-repair/plan-reviews/00-主控最终决断书.md`（裁决 3）、`docs/stream-jitter-and-order-repair/independent-plans/02-Markdown封口过渡与零塌陷方案.md`

---

## 一、完成度总结

- **已完成**：
  1. 在 `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx` 中建立底层**零坍塌硬防御盾（Zero-Collapse Guard）**：当组件从增量单元模式（`incrementalModeRef.current === true`）或容器已有已渲染子节点（`container.childNodes.length > 0`）切换到 `incrementalUnits` 未激活（`undefined` / `null` / `[]`）且传入 `html === ""`（或纯空白）时，除非显式指定 `allowEmptyClear={true}`（默认 `false`），否则直接短路 `return`，严禁调用 `reconcileUnits(container, [])` 删光容器内已有 DOM 节点，保持 DOM 子树与盒模型高度不变（$N_{\text{void}} \equiv 0$）。
  2. 优化 `ReconciledMarkdownHtml.tsx` 增量单元协调游标：将原有的无条件 `appendChild` 循环改为 `cursor` 游标对齐（已就位节点 0 DOM 移动操作），并在首次切入增量模式时复用容器内已有的同标签根元素，物理切除入口处的破坏性清空循环。
  3. 检查并加固 `apps/crish-desktop/src/api/markdown/unitReconciler.ts`（注：任务书写作 `components/markdown/unitReconciler.ts`，仓库真实物理路径为 `apps/crish-desktop/src/api/markdown/unitReconciler.ts`）：升级 `reconcileUnits` 为游标前瞻原地协调算法，兼容流式单元快照切换到权威 `splitHtmlIntoUnits(html)` 时新引入的块间换行文本节点（`\n`）与代码块头部节点（如 `.md-code-block` 内前置插入 `.md-code-header`），确保全部 `<p>`、`<div class="md-code-block">`、`<pre>`、`<code>`、`<ul>` 等块级与容器元素原地复用更新而非卸载重建。
  4. 扩展 `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.test.tsx`，覆盖零坍塌断言（$N_{\text{void}} \equiv 0$）、权威 HTML 抵达原地平滑置换（含块间换行与代码头部插入时的 DOM 节点引用恒定断言）以及 `allowEmptyClear={true}` 显式清空断言。
  5. 通过 Vitest 单元测试、TypeScript 类型检查与 `check-line-counts.mjs` 行数门禁验证。
- **未完成**：无。

---

## 二、代码修改清单

1. [`apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx#L24-L137)
   - **L24-L28, L40**：新增可选属性 `allowEmptyClear?: boolean`（默认 `false`），控制是否允许在 `html` 为空且无 `incrementalUnits` 时显式清空容器。
   - **L52-L65, L91-L110**：切入增量单元模式时保留并按序匹配容器已有元素；使用 `cursor` 游标定位替代逐节点无条件 `appendChild`，当节点已位于正确 DOM 槽位时零移动推进 `cursor = cursor.nextSibling`。
   - **L118-L127**：落地零坍塌硬防御盾（Zero-Collapse Guard）——当 `!allowEmptyClear && !html.trim() && (incrementalModeRef.current || container.childNodes.length > 0)` 时直接短路返回，冻结当前 DOM 子树与 `unitNodesRef` 映射，等待权威非空 `html` 到达后再执行 `reconcileUnits(container, splitHtmlIntoUnits(html))` 原地替换。
2. [`apps/crish-desktop/src/api/markdown/unitReconciler.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/unitReconciler.ts#L50-L172)
   - **L50-L75, L83-L89**：提取 `createUnitNode(unit)` 纯节点构造器，`reconcileUnitNode` 在不兼容时直接调用 `createUnitNode(unit)`，不再创建临时 `<div>` 容器。
   - **L97-L172**：重构 `reconcileUnits(container, units)`，引入 `cursor` 游标及单步前瞻对齐：
     - 识别块间空白换行文本节点（`\n`）的插入/移除，在 `ELEMENT_NODE` 之前原地 `insertBefore` 而不打断后续同标签块级元素的复用；
     - 识别子容器内前置新元素插入（如 `.md-code-block` 在封口后于 `<pre>` 前插入 `<div class="md-code-header">`），原地 `insertBefore` 头部并继续复用原有 `<pre>` 与 `<code>` 节点；
     - 对同位置标签变更执行 `replaceChild` 原地替换，保留其后方兼容兄弟节点。
3. [`apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.test.tsx#L87-L219)
   - **L87-L128**：新增零坍塌硬防御盾测试（`incrementalUnits` -> `undefined` + `html=""` 保持 `childNodes.length > 0` 且 `<p>` 引用不变 -> 权威 `html="<p class=\"md-p\">Final</p>"` 原地复用同一 `<p>` 更新文本）。
   - **L130-L188**：新增多单元流式快照（段落 + 代码块 + 段落）经真空期切换至含块间 `\n` 与 `.md-code-header` 的权威 HTML 测试，断言前后 `<p>`、`.md-code-block`、`<pre>`、`<code>` 节点引用 100% 恒定。
   - **L190-L218**：新增 `allowEmptyClear={true}` 显式清空控制测试。

---

## 三、物理删除清单（负产出红线）

1. **`apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx`**：
   - 物理删除切入增量模式时的暴力清空循环 `while (container.firstChild) container.removeChild(container.firstChild);`（原 L48）。
   - 物理删除冗余且每帧触发全量节点重排的分支 `if (node.parentNode !== container) container.appendChild(node); else container.appendChild(node);`（原 L78-L79）。
2. **`apps/crish-desktop/src/api/markdown/unitReconciler.ts`**：
   - 物理删除 `reconcileUnitNode` 中分配临时 DOM 容器的冗余代码 `const holder = document.createElement('div'); appendUnit(holder, unit);`（原 L73-L75）。
   - 物理删除 `reconcileUnits` 中一遇不兼容节点（如块间 `\n` 或 `.md-code-header`）即把后续全部已渲染兄弟节点连根拔除的粗暴尾部删除循环 `while (container.childNodes.length > index) { container.removeChild(container.childNodes[index]!); }`（原 L101-L105）。

---

## 四、测试验证结果

1. **Vitest 单元测试**：
   - 命令：`npx vitest run apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.test.tsx apps/crish-desktop/src/api/markdown/unitReconciler.test.ts`
   - 结果：
     ```text
     ✓ unit apps/crish-desktop/src/api/markdown/unitReconciler.test.ts (7 tests) 70ms
     ✓ unit apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.test.tsx (6 tests) 60ms
     Test Files  2 passed (2)
          Tests  13 passed (13)
     ```
2. **TypeScript 类型检查**：
   - 命令：`npx tsc --noEmit -p apps/crish-desktop/tsconfig.json`
   - 结果：Exit Code 0（零错误）。

---

## 五、行数预算自检

运行命令：
`node scripts/check-line-counts.mjs apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx apps/crish-desktop/src/api/markdown/unitReconciler.ts`

| 文件路径                                                                | 分类档位       | 修改前有效行 | 修改后有效行 | 门禁上限 |               状态                |
| :---------------------------------------------------------------------- | :------------- | :----------: | :----------: | :------: | :-------------------------------: |
| `apps/crish-desktop/src/components/markdown/ReconciledMarkdownHtml.tsx` | UI Component   |      81      |     113      |   500    | ✅ PASS (0 Warning / 0 Violation) |
| `apps/crish-desktop/src/api/markdown/unitReconciler.ts`                 | Business Logic |      88      |     137      |   400    | ✅ PASS (0 Warning / 0 Violation) |
