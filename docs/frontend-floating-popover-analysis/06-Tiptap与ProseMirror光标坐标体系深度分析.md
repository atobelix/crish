# 06 - Tiptap 与 ProseMirror 光标选区坐标体系深度分析报告

**分析师角色**：【Agent 06: Tiptap / ProseMirror 光标选区坐标分析师】  
**审计基准**：前端代码一律视为不可信任源，实施史无前例的严格几何与时序穿透分析。  
**涉及核心文件域**：

- `apps/crish-desktop/src/components/chat-composer/SlashExtension.ts`
- `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx`
- `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`
- `apps/crish-desktop/src/components/chat-composer/TiptapComposerField.tsx`
- `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css`
- `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css`

---

## 一、执行摘要与核心结论 (Executive Summary)

本报告对 Conex / Crish 桌面端输入域（Tiptap / ProseMirror）的光标选区坐标计算与浮层定位系统进行了全链路几何与时序解构。发现当前系统的三大核心架构断层与隐患：

1. **几何降维与锚点坍缩缺陷（`SlashExtension.ts:276-277`）**：
   `SlashExtension` 在构造 `clientRect` 时，调用 `view.coordsAtPos(props.range.from)` 后返回了 `new DOMRect(coords.left, coords.bottom, 0, 0)`。此举将原本具有物理行高（LineBox Height = `coords.bottom - coords.top`）的光标矩形粗暴坍缩为 `(x, y, 0, 0)` 的零维点矩形，并将 `top` 强行绑定至文字底线（`coords.bottom`）。导致 Radix Popover 在执行 `side="top"` 向上展开布局时，以字底为基准计算上偏移，使得浮层底部直接切入并遮挡当前输入文本行约 12~18px。
2. **哨兵条件逻辑漏洞与错误回退（`TiptapSlashMenu.tsx:146`）**：
   `TiptapSlashMenu` 采用 `rawRect.top !== 0 || rawRect.left !== 0 || rawRect.width !== 0 || rawRect.height !== 0` 作为坐标有效性守卫。由于 `SlashExtension` 返回的 `width` 与 `height` 恒为 0，当光标位于视口左上角 `(0, 0)` 或在尚未发生布局位移的首帧渲染时，该条件逻辑计算为 `false`，从而触发非预期的回退逻辑，强行回退到 `editorDom.getBoundingClientRect()`。这导致浮层瞬间从光标处瞬移跳跃至整个编辑器容器的左上角。
3. **IME 输入法与 ProseMirror 状态时序脱节**：
   在 CJK（中文/日文）输入法组合态（`compositionstart` ~ `compositionend`）中，浏览器底层 DOM 频繁发生未提交的拼音字符变更，而 ProseMirror 的 Document State 为防止 IME 组合打断而维持冻结。此时若触发 Suggestion 坐标查询，`range.from` 与实际 DOM 中不断前进的输入法光标产生相对几何撕裂。

---

## 二、ProseMirror `view.coordsAtPos(pos, side)` 计算原理与边界穿透

### 2.1 DOM 映射与 Range 测量算法

ProseMirror 的坐标定位核心是由 `prosemirror-view` 中的 `coordsAtPos(pos: number, side = 1)` 实现，其底层执行管线如下：

```
doc.resolve(pos)
  ──> docView.domFromPos(pos, side)
  ──> 解析出 DOM 节点与其子偏移 { node: Node, offset: number }
  ──> document.createRange() 并在 [offset, offset] 处折叠 (collapse)
  ──> Range.getClientRects()
  ──> 提取视口绝对包围盒: { top, bottom, left, right }
```

- **视口坐标系（Viewport Space）**：`coordsAtPos` 返回的所有坐标均为相对于浏览器可视窗口（Viewport）的 Client 坐标（等价于 `clientX/clientY`），其原生包含视口滚动分量，但不包含相对于父容器的局部偏移。

### 2.2 参数 `side`（`1` vs `-1`）的排版几何分歧

`side` 参数控制当 `pos` 处于两段排版实体交界处时的**亲和性（Affinity）**：

- **`side = 1`（默认值 / 向后亲和）**：将坐标锚定在 `pos` 紧随其后的字形左边缘（Left edge of next glyph）。
- **`side = -1`（向前亲和）**：将坐标锚定在 `pos` 前一个字形的右边缘（Right edge of previous glyph）。

在软换行（Soft Wrap）临界点上，行末最后一个字符与下一行首个字符在 ProseMirror Document 中具有连续的 `pos` 索引：

- 若取 `side = -1`，返回值为上一行末尾坐标 $(X_{\text{max}}, Y_{\text{line1}})$；
- 若取 `side = 1`，返回值为下一行行首坐标 $(X_{\text{padding\_left}}, Y_{\text{line2}})$。
- **当前缺陷代码**（`SlashExtension.ts:276`）：直接调用 `view.coordsAtPos(props.range.from)`，缺省 `side` 为 `1`。由于触发字符（`/` 或 `@`）紧随其后通常处于输入起点，在软换行首字处表现为下行行首，但未对换行边界提供显式断言。

### 2.3 四大核心边界场景几何返回值实测与推导

#### ① 空行首字 (Empty Line Start)

- **DOM 结构**：`<p><br class="ProseMirror-trailingBreak"></p>` 或纯 `<p></p>`。
- **几何特征**：
  在段落内无文本节点（TextNode）时，`domFromPos(pos)` 指向 `<p>` 元素与 offset 0。Blink / WebView2 对包含 `<br>` 的折叠 Range 调用 `getClientRects()` 时，返回高度等于行高（`line-height`，在当前 CSS 中约为 $13\text{px} \times 1.45 \approx 18.85\text{px}$ 或 $14\text{px} \times 1.45 \approx 20.3\text{px}$），但 **`width` 为 0**。
- **坐标值**：
  $$\text{coords} = \{ \text{left}: X_{\text{editor\_left}} + P_{\text{left}}, \text{right}: X_{\text{editor\_left}} + P_{\text{left}}, \text{top}: Y_{\text{line}}, \text{bottom}: Y_{\text{line}} + H_{\text{line}} \}$$

#### ② 多行文本软换行 (Soft Wrap Boundary)

- **几何特征**：
  当文本到达编辑器右边界自动换行时，换行点两端的视觉坐标在 Y 轴上产生跃迁（$\Delta Y = H_{\text{line}}$），在 X 轴上从右边界边缘（$X_{\text{right}}$）突变回左缩进位置（$X_{\text{left}}$）。
- **推导**：
  在输入 `/` 或 `@` 时，`props.range.from` 是触发字符自身的起始索引。如果触发字符恰好被挤压到新一行的行首，`coordsAtPos(range.from, 1)` 精准指向新一行的起点 $(X_{\text{left}}, Y_{\text{new\_line}})$。

#### ③ 滚动容器内部 (Scrollable Textarea / `overflow-y: auto`)

- **CSS 约束**（`TiptapEditorField.module.css:25-31`）：
  ```css
  .proseMirrorField {
    min-height: calc(
      1em * var(--composer-line-height, 1.45) * var(--composer-min-lines, 2)
    );
    max-height: calc(
      1em * var(--composer-line-height, 1.45) * var(--composer-max-lines, 10)
    );
    overflow-y: auto;
  }
  ```
- **几何推导**：
  - `coordsAtPos` 基于视口 Client 坐标计算。当编辑器内容超过 10 行产生内部滚动（`scrollTop > 0`）时，当前光标所在的 DOM 节点在视口中的物理位置会随滚动向上平移：
    $$Y_{\text{client}} = Y_{\text{document}} - \text{scrollTop}_{\text{editor}} - \text{scrollY}_{\text{window}}$$
  - `coordsAtPos()` 能够准确反映出由于 `scrollTop` 导致的视口 Y 坐标上移。

---

## 三、`TiptapSlashMenu` 定位机制解构与缺陷穿透

### 3.1 致命缺陷 1：`SlashExtension.ts:277` 构造的点矩形导致 Y 轴遮挡穿透

#### 源码定位与几何推导

在 `SlashExtension.ts` 第 271~278 行：

```ts
271: clientRect:
272:   props.clientRect ||
273:   (() => {
274:     const view = props.editor?.view;
275:     if (!view || !props.range) return null;
276:     const coords = view.coordsAtPos(props.range.from);
277:     return new DOMRect(coords.left, coords.bottom, 0, 0);
278:   }),
```

- **数学模型推导**：
  设光标所在文字行的排版盒子为：
  - 顶部：$Y_{\text{top}}$
  - 底部：$Y_{\text{bottom}}$
  - 行高：$H = Y_{\text{bottom}} - Y_{\text{top}} \approx 20\text{px}$

  `SlashExtension` 返回的矩形为：
  $$R_{\text{actual}} = (x = \text{coords.left}, y = \text{coords.bottom}, w = 0, h = 0)$$

  当 `TiptapSlashMenu` 渲染该锚点时：
  $$\text{Anchor.top} = \text{coords.bottom}, \quad \text{Anchor.height} = 1$$

  Radix Popover 在 `side="top"`, `sideOffset=8` 模式下，计算浮层在 Viewport 中的 Y 坐标：
  $$Y_{\text{popover}} = \text{Anchor.top} - H_{\text{popover}} - \text{sideOffset} = \text{coords.bottom} - H_{\text{popover}} - 8$$

  浮层的底部边界位置（Popover Bottom）为：
  $$Y_{\text{popover\_bottom}} = Y_{\text{popover}} + H_{\text{popover}} = \text{coords.bottom} - 8$$

  然而，输入行字形的顶部位于 $\text{coords.top} = \text{coords.bottom} - 20$。
  由此得出浮层底部与文本行顶部的相对关系：
  $$Y_{\text{popover\_bottom}} - \text{coords.top} = (\text{coords.bottom} - 8) - (\text{coords.bottom} - 20) = +12\text{px}$$

- **结论**：**浮层底部深入到了文本行内部 12px，直接把正在输入的文字（如 `/` 或 `@`）以及上方半截字形完全遮挡！**

#### 正确的 LineBox 几何模型

真实的 Anchor 应当完整覆盖文字行高：
$$R_{\text{correct}} = (x = \text{coords.left}, y = \text{coords.top}, w = \max(1, \text{coords.right} - \text{coords.left}), h = \text{coords.bottom} - \text{coords.top})$$
在此模型下：
$$\text{Anchor.top} = \text{coords.top}$$
$$Y_{\text{popover}} = \text{coords.top} - H_{\text{popover}} - 8$$
$$Y_{\text{popover\_bottom}} = \text{coords.top} - 8$$
**浮层底部恰好悬浮在文字行顶部上方 8px，呈现完美的无损悬浮！**

---

### 3.2 致命缺陷 2：`TiptapSlashMenu.tsx:146` 哨兵逻辑误杀与坐标瞬跳

#### 源码定位与逻辑断层

在 `TiptapSlashMenu.tsx` 第 142~149 行：

```tsx
142: const editorDom = (props.editor as any)?.view?.dom as HTMLElement | undefined;
143: const fallbackRect = editorDom?.getBoundingClientRect?.() || new DOMRect(0, 0, 0, 0);
144: const rawRect = typeof clientRect === 'function' ? clientRect() : clientRect;
145: const rect =
146:   rawRect && (rawRect.top !== 0 || rawRect.left !== 0 || rawRect.width !== 0 || rawRect.height !== 0)
147:     ? rawRect
148:     : fallbackRect;
```

#### 误杀机理剖析

1. **点矩形尺寸全零**：
   由前述可知，`SlashExtension.ts:277` 产生的 `rawRect` 其 `width === 0` 且 `height === 0`。因此在判定式中 `rawRect.width !== 0` 与 `rawRect.height !== 0` 恒为 `false`。
2. **临界误杀场景**：
   当光标处于视口左上角，或首帧尚未完成 Reflow 测量时，条件为假，立即回退到 `fallbackRect = editorDom.getBoundingClientRect()`，菜单瞬间跳跃到整个输入框的最顶端或最左侧！
