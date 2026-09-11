# RECHECK-02: 富文本光标与输入法时序独立复审报告

> **审计角色**：Agent R2: 富文本光标与输入法时序独立复审师
> **审计性质**：背对背独立盲审（源码零信任，不依赖既有总结，直接深入源码进行几何与时序推导）
> **审计代码域**：
>
> - `apps/crish-desktop/src/components/chat-composer/SlashExtension.ts`
> - `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx`
> - `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`
> - `apps/crish-desktop/src/components/chat-composer/TiptapComposerField.tsx`
> - `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx`
> - `apps/crish-desktop/src/hooks/useAutoGrowTextarea.ts`
> - 核心依赖底层：`@tiptap/suggestion` (dist/index.js), `@tiptap/core`, `@tiptap/pm`, `@radix-ui/react-popover`

---

## 目录

1. [复审概述与独立盲审方法论](#一复审概述与独立盲审方法论)
2. [专题一：SlashExtension 到 clientRect 几何模型与点矩形坍缩缺陷](#二专题一slashextension-到-clientrect-几何模型与点矩形坍缩缺陷)
3. [专题二：TiptapSlashMenu 坐标守卫漏洞与虚拟锚点脱节](#三专题二tiptapslashmenu-坐标守卫漏洞与虚拟锚点脱节)
4. [专题三：CJK 中文输入法组合态时序竞争与按键劫持全解析](#四专题三cjk-中文输入法组合态时序竞争与按键劫持全解析)
5. [专题四：输入框高度膨胀（48px~290px）与内部滚动视口映射拓扑](#五专题四输入框高度膨胀48px290px与内部滚动视口映射拓扑)
6. [量化缺陷拓扑与严重性裁决表](#六量化缺陷拓扑与严重性裁决表)
7. [架构级严谨根治方案](#七架构级严谨根治方案)

---

## 一、复审概述与独立盲审方法论

本复审报告作为独立盲审产物，基于代码行级反向工程、浏览器渲染引擎 DOM 几何计算标准、ProseMirror 事务状态机模型以及 W3C IME 组合态生命周期标准进行全链路推演。

经审查，当前富文本聊天输入框（Chat Composer）中基于 Tiptap / ProseMirror 的斜杠命令（`/`）与提及（`@`）建议浮层存在 **4 类高危级架构与几何缺陷**，直接导致：

1. 斜杠浮层在特定时机**遮挡当前输入文本行**；
2. 弹层在首帧渲染与 DOM 节点重新解析时**跨视口瞬时跳跃（Jitter / Flash）**；
3. CJK（中文/日文/韩文）输入法在拼音/注音选词阶段被浮层键盘处理程序**硬性拦截与劫持**，直接吞噬回车与上下键选词，导致输入法崩溃或非法插入首个命令；
4. 当输入框从 1 行膨胀至 10 行并触发内部滚动时，浮层锚点与实际光标**物理脱节**，在滚出视口后脱缰漂浮于外部聊天消息区域之上。

---

## 二、专题一：SlashExtension 到 clientRect 几何模型与点矩形坍缩缺陷

### 1. 代码位置与实现审查

在 `apps/crish-desktop/src/components/chat-composer/SlashExtension.ts` 第 271-278 行：

```typescript
// SlashExtension.ts:271-278
clientRect:
  props.clientRect ||
  (() => {
    const view = props.editor?.view;
    if (!view || !props.range) return null;
    const coords = view.coordsAtPos(props.range.from);
    return new DOMRect(coords.left, coords.bottom, 0, 0);
  }),
```

### 2. ProseMirror `coordsAtPos` 几何模型解析

在 ProseMirror `EditorView.coordsAtPos(pos: number, side = 1)` 中，返回的坐标结构为：
$$\text{coords} = \{ \text{left}: x_1, \text{right}: x_2, \text{top}: y_{\text{top}}, \text{bottom}: y_{\text{bottom}} \}$$

- $y_{\text{top}}$：光标所在文本行 LineBox 的顶边缘视口坐标（Client Top）。
- $y_{\text{bottom}}$：光标所在文本行 LineBox 的底边缘视口坐标（Client Bottom）。
- 行高 $\Delta y = y_{\text{bottom}} - y_{\text{top}}$，在当前字体与行高体系下约为 $20.3\text{px}$ 至 $24\text{px}$。
- 光标 X 坐标：当未选择文本时（Caret 状态），$\text{left} = \text{right} = x_{\text{caret}}$。

### 3. 点矩形坍缩（Point Collapse）几何推导

`SlashExtension.ts` 在兜底构造 `DOMRect` 时，传入参数为：
$$\text{DOMRect}(x = \text{coords.left}, y = \text{coords.bottom}, \text{width} = 0, \text{height} = 0)$$

这导致生成的虚拟包围盒几何参数产生严重扭曲：

- $\text{Rect.top} = \text{coords.bottom}$
- $\text{Rect.bottom} = \text{coords.bottom}$
- $\text{Rect.height} = 0$

### 4. 浮层 `side="top"` 时的遮挡碰撞（Occlusion）数学证明

在 `TiptapSlashMenu.tsx` 第 168-173 行中，Radix Popover Content 配置如下：

```tsx
<Popover.Content
  className={styles.popoverContent}
  side="top"
  align="start"
  sideOffset={8}
  avoidCollisions={true}
  collisionPadding={12}
>
```

Radix Popover（底层基于 Floating UI）在计算 `side="top"` 的定位坐标时，其 Y 轴方程为：
$$Y_{\text{popover\_bottom}} = Y_{\text{anchor\_top}} - \text{sideOffset}$$

分别代入标准行包围盒与当前代码实现的点矩形包围盒：

#### (1) 正确包围盒推导（期望行为）：

- 锚点包围盒：$\text{Anchor.top} = y_{\text{top}}$, $\text{Anchor.bottom} = y_{\text{bottom}}$
- 浮层底坐标：$Y_{\text{popover\_bottom}} = y_{\text{top}} - 8\text{px}$
- 浮层底部与文字行顶部的物理间距：
  $$\text{Clearance} = y_{\text{top}} - Y_{\text{popover\_bottom}} = +8\text{px} \quad (\text{完全无遮挡，安全距离 } 8\text{px})$$

#### (2) 当前点坍缩包围盒推导（实际运行）：

- 锚点包围盒：$\text{Anchor.top} = y_{\text{bottom}}$, $\text{Anchor.bottom} = y_{\text{bottom}}$
- 浮层底坐标：$Y_{\text{popover\_bottom}} = y_{\text{bottom}} - 8\text{px}$
- 文本行覆盖度分析：
  文本行占用区间为 $[y_{\text{top}}, y_{\text{bottom}}]$，高度为 $H_{\text{line}} \approx 20.3\text{px}$。
  浮层底部位置处于：
  $$Y_{\text{popover\_bottom}} = y_{\text{top}} + (H_{\text{line}} - 8\text{px}) = y_{\text{top}} + 12.3\text{px}$$
- **遮挡推论**：
  浮层底部直接侵入当前文字行内部，覆盖了从 $y_{\text{top}}$ 到 $y_{\text{top}} + 12.3\text{px}$ 的文本区域，**遮挡率达 $60.6\%$**！用户在输入 `/` 及后续过滤词时，正在输入的文字上半部分被浮层底部直接遮蔽。

---

## 三、专题二：TiptapSlashMenu 坐标守卫漏洞与虚拟锚点脱节

### 1. 坐标有效性守卫与全零误杀

在 `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx` 第 142-149 行：

```typescript
// TiptapSlashMenu.tsx:142-149
const editorDom = (props.editor as any)?.view?.dom as HTMLElement | undefined;
const fallbackRect =
  editorDom?.getBoundingClientRect?.() || new DOMRect(0, 0, 0, 0);
const rawRect = typeof clientRect === 'function' ? clientRect() : clientRect;
const rect =
  rawRect &&
  (rawRect.top !== 0 ||
    rawRect.left !== 0 ||
    rawRect.width !== 0 ||
    rawRect.height !== 0)
    ? rawRect
    : fallbackRect;
```

#### 缺陷机制深入剖析：

1. **合法零点被判定为非法**：
   当应用全屏、在模态对话框左上角、或在嵌入式视图中光标刚好位于视口左上角 $(0, 0)$ 时，点矩形 $(0, 0, 0, 0)$ 满足 `rawRect.top === 0 && rawRect.left === 0 && rawRect.width === 0 && rawRect.height === 0`。守卫条件判定为 `false`，强行回退至 `fallbackRect`。
2. **回退至 `editorDom` 引起的视口瞬跳（Teleportation / Layout Jitter）**：
   - 当 `@tiptap/suggestion` 刚触发时，其内部生成的 Inline Decoration（`<span class="suggestion">`）尚未在真实 DOM 中完成 paint；
   - `clientRectFor` 执行 `view.dom.querySelector('[data-decoration-id="..."]')` 返回 `null` 或 detached 节点；
   - detached 节点的 `getBoundingClientRect()` 返回 `DOMRect(0, 0, 0, 0)`；
   - **第 0 帧**：`TiptapSlashMenu` 误以为坐标无效，将锚点设为 `fallbackRect`（整框 `editorDom`，左坐标 e.g. 120px，顶坐标 e.g. 480px）；
   - **第 1 帧**：ProseMirror 完成 DOM 渲染，Decoration 挂载，`clientRect` 变成真实光标坐标（e.g. 350px, 510px）；
   - **结果**：用户每按下一个触发键（`/` 或 `@`），浮层会在第 0 帧出现在输入框最左侧，并在第 1 帧猛烈横跳到光标位置，造成严重的视觉闪烁与跳跃。

### 2. 虚拟固定锚点与滚动上下文脱节（Scroll Decoupling）

在 `TiptapSlashMenu.tsx` 第 151-166 行：

```tsx
const triggerStyle: React.CSSProperties = {
  position: 'fixed',
  top: rect.top,
  left: rect.left,
  width: rect.width || 1,
  height: rect.height || 1,
  pointerEvents: 'none',
  visibility: 'hidden',
  zIndex: 'var(--z-popover)',
};

return (
  <Popover.Root open={isOpen}>
    <Popover.Anchor asChild>
      <div style={triggerStyle} />
    </Popover.Anchor>
...
```

#### 运行期断层分析：

1. `ReactRenderer` 将组件渲染在 `document.body` 根层级。
2. `triggerStyle` 包含静态的 `position: fixed; top: ${rect.top}px; left: ${rect.left}px;`。
3. Radix Popover 内部的 Floating UI `autoUpdate` 只会监听该虚拟 `<div />` 的滚动祖先（即 `window`）。
4. 然而，实际承载文本滚动的容器是 `.proseMirrorField`（`overflow-y: auto`）。
5. 当用户在多行输入框内滚动鼠标滚轮时：
   - 滚动事件局限在 `.proseMirrorField` 内部；
   - ProseMirror 没有分发 Document Transaction，ReactRenderer 不会调用 `component.updateProps`；
   - 虚拟 `<div />` 的 `style.top` 保持旧值不动；
   - **结果**：浮层死锁在视口固定物理位置，而输入框内的文字和光标随着滚动条上下移动，两者彻底撕裂脱节！

---

## 四、专题三：CJK 中文输入法组合态时序竞争与按键劫持全解析

### 1. W3C DOM 与 ProseMirror IME 生命周期图谱

```
[用户键入拼音字母 'g']
         │
         ▼
[1] 浏览器原生事件流:
    ├── (1) compositionstart (isComposing = true)
    ├── (2) beforeinput (inputType: 'insertCompositionText')
    ├── (3) DOM TextNode 发生临时非提交变更 (带有下划线)
    ├── (4) compositionupdate (data: 'g')
    └── (5) keydown (key: 'Process' 或 'g', isComposing: true, keyCode: 229)
         │
         ▼
[2] ProseMirror 内核行为:
    ├── view.composing 标记置为 true
    └── 为保护浏览器 IME composition 树，ProseMirror 暂停 DOM-to-State 事务同步
         │
         ▼
[3] @tiptap/suggestion 插件 handleKeyDown 拦截 (重大缺陷点!):
    ├── Plugin.props.handleKeyDown(view, event) 执行
    ├── ❌ 未检查 view.composing / event.isComposing / keyCode === 229
    └── 直接调用 renderer.onKeyDown({ event }) ──► TiptapSlashMenu.onKeyDown
         │
         ▼
[4] TiptapSlashMenu 劫持 (重大缺陷点!):
    ├── 收到 Enter / ArrowDown / ArrowUp
    ├── ❌ 执行 event.preventDefault()
    ├── ❌ 执行 selectItem(selectedIndex) / setSelectedIndex(...)
    └── 💥 灾难: 浏览器选词窗口被强行打断，直接执行并插入第一个斜杠命令!
```

### 2. 时序竞争核心根因（Root Cause）

#### (1) 插件级按键拦截先于 `editorProps.handleKeyDown` 门禁

在 `TiptapEditorField.tsx` 第 218-223 行，虽然编写了 IME 保护门禁：

```typescript
handleKeyDown: (view: any, event: KeyboardEvent | any) => {
  if (view.composing || event.isComposing || isComposingRef.current) {
    callbacksRef.current.onCompositionChange?.(true);
    return false; // Pass through to browser native CJK IME
  }
  ...
}
```

**然而在 ProseMirror 架构中**：
所有 `plugins` 的 `handleKeyDown` 按注册顺序优先执行。只有当**所有插件均返回 `false`** 时，才会流转到 `editorProps.handleKeyDown`。

- `@tiptap/suggestion` 是一个 ProseMirror 插件；
- 在 `@tiptap/suggestion/dist/index.js` 第 139-152 行中：
  ```javascript
  handleKeyDown(view, event) {
    const state = pluginKey.getState(view.state);
    if (!state.active) return false;
    if (event.key === "Escape" || event.key === "Esc") { ... }
    const handled = renderer?.onKeyDown?.({ view, event, range: state.range }) || false;
    return handled;
  }
  ```
- 源码完全缺失了 `if (view.composing || event.isComposing || event.keyCode === 229) return false;` 判断！
- 紧接着在 `TiptapSlashMenu.tsx` 第 107-135 行的 `onKeyDown` 实现中，对 `Enter` / `ArrowDown` / `ArrowUp` 毫无防备地直接调用了 `event.preventDefault()` 并返回 `true`。

#### (2) 真实破坏场景重演（Failure Scenario）：

1. 用户在聊天框输入 `/`，弹出斜杠命令菜单（高亮第 0 项 `Heading 1`）。
2. 用户切换至中文输入法（微软拼音/搜狗/Rime），想要输入 `/gaoliang`（搜索「高亮」命令）。
3. 用户输入拼音字母 `g`，输入法弹出候选词浮窗。
4. 用户按下 `Enter` 键想要将英文字母 `g` 提交上屏：
   - 按键事件触发；
   - `TiptapSlashMenu.onKeyDown` 截获 `Enter`；
   - 立即执行 `event.preventDefault()`；
   - 立即触发 `selectItem(0)`（执行 `Heading 1` 命令）；
   - 输入法组合态被强行撕碎，光标所在行变成一级标题，用户输入的拼音被吞掉。
5. 若用户按下 `ArrowDown` 想要挑选输入法第 2 个候选词：
   - 按键被 `TiptapSlashMenu` 截获并 `preventDefault`；
   - 斜杠菜单高亮项下移至 `Heading 2`；
   - 输入法候选词完全无法通过键盘选择。

#### (3) DOM 临时字符与 Document State 的空间坐标竞争

在组合态期间，DOM 中的字符长度 $L_{\text{dom}}$ 大于 ProseMirror 文档树中的字符长度 $L_{\text{state}}$。

- `range.from` 指向未提交前的文档偏移量；
- `view.coordsAtPos(range.from)` 在组合态中解析时，由于 DOM 文本节点被浏览器插入了临时 Composition Node，导致 `Range.getBoundingClientRect()` 返回的坐标可能漂移至组合文本的起点或无效位置，致使浮层位置在输入拼音过程中剧烈抖动。

---

## 五、专题四：输入框高度膨胀（48px~290px）与内部滚动视口映射拓扑

### 1. 物理尺寸与布局层级推导

```
┌──────────────────────────────────────────────────────────────┐
│ .container (ChatComposer.module.css)                         │
│ padding: 10px 14px; min-height: 40.6px + 20px + 2px = 62.6px │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ .fieldWrapper (TiptapEditorField.module.css)             │ │
│ │ ┌──────────────────────────────────────────────────────┐ │ │
│ │ │ .proseMirrorField (overflow-y: auto)                 │ │ │
│ │ │ min-height: 2 lines (~40.6px)                        │ │ │
│ │ │ max-height: 10 lines (~203px)                        │ │ │
│ │ │ line-height: 1.45 (14px * 1.45 = 20.3px)             │ │ │
│ │ └──────────────────────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────────────┘ │
│ .footerActions (min-height: 28px) + .attachStrip             │
└──────────────────────────────────────────────────────────────┘
```

- **初始态（单行/空态）**：容器总高度约 $48\text{px} \sim 62.6\text{px}$。
- **膨胀态（1~10 行）**：`.proseMirrorField` 随内容自增高至 $203\text{px}$，加上附件栏与底部栏，总高度达到约 $250\text{px} \sim 290\text{px}$。
- **滚动态（>10 行）**：`.proseMirrorField` 触发 `overflow-y: auto`，产生内部 `scrollTop`。

### 2. 向上增高时视口顶边界翻折震颤（Boundary Flip Jitter）

在现代桌面聊天客户端中，Composer 通常采用底部对齐（Fixed/Flex Bottom Align）。
当用户输入从 1 行增加到 10 行时：

- 输入框的视口底部坐标 $Y_{\text{bottom}}$ 保持不变；
- 输入框的视口顶部坐标 $Y_{\text{top}}$ 持续**向上移动**（$Y_{\text{top}}$ 减少约 $180\text{px}$）；
- 斜杠菜单默认高度为 `max-height: min(320px, 40vh)`（约 $320\text{px}$）；
- 浮层定位采用 `side="top"`，碰撞安全距离 `collisionPadding={12}`。

#### 临界翻折状态分析：

设视口总高度为 $H_{\text{viewport}} = 800\text{px}$，Composer 位于底部：

1. 当 1 行时：Composer 顶部在 $Y = 738\text{px}$，上方剩余空间 $738 - 12 = 726\text{px} > 320\text{px}$，浮层稳定显示在上方；
2. 当 10 行时：Composer 顶部上升至 $Y = 510\text{px}$；若在小窗口或分屏模式下（如窗口高度 $550\text{px}$）：
   - 上方可用空间仅剩 $510 - 12 = 498\text{px}$；
   - 若用户在输入框中间或靠上行输入 `/`，光标位置 $Y_{\text{cursor}} \approx 530\text{px}$；
   - 若上方空间不足，Radix 的 `avoidCollisions` 触发翻折，强制转为 `side="bottom"`；
   - 转为 `side="bottom"` 后，浮层底坐标变为 $530 + 320 + 8 = 858\text{px} > 800\text{px}$，下方同样发生碰撞！
   - **结果**：Floating UI 在上下两侧均无法满足空间约束时，会在 `side="top"` 和 `side="bottom"` 之间高频震颤，或将浮层强行压扁产生变形。

### 3. 内部滚动时的坐标映射失真与脱缰漂浮

当文本超过 10 行时，`.proseMirrorField` 具有独立的 `scrollTop`。
设光标在文档第 15 行，光标在文档内的绝对 Y 偏移量为 $Y_{\text{doc}} = 15 \times 20.3 = 304.5\text{px}$。
光标在视口中的 Client Y 坐标为：
$$Y_{\text{client}} = Y_{\text{container\_top}} + Y_{\text{doc}} - \text{scrollTop}$$

#### (1) 滚动出界盲区（Out-of-Bounds Floating）：

- 当用户向上滚动查看历史输入时，`scrollTop` 变小，光标位置被滚出 `.proseMirrorField` 的底部可见区域；
- 或用户向下滚动，光标被滚出顶部（$Y_{\text{client}} < Y_{\text{container\_top}}$）；
- **当前缺陷**：`TiptapSlashMenu` 缺乏针对 `.proseMirrorField` 包围盒的裁剪判断（Boundary Clipping），只要 suggestion active 状态未被重置，浮层仍然强行渲染在 $Y_{\text{client}}$ 对应的屏幕绝对位置上。
- **表现**：浮层直接脱离输入框，悬浮在聊天历史气泡甚至标题栏上方，极度反直觉。

---

## 六、量化缺陷拓扑与严重性裁决表

| 缺陷编号   | 缺陷定位 (文件:精确行号)                                      | 触发条件                                                | 故障现象                                                                                        | 严重级别     |
| :--------- | :------------------------------------------------------------ | :------------------------------------------------------ | :---------------------------------------------------------------------------------------------- | :----------- |
| **BUG-01** | `SlashExtension.ts:276-278`                                   | 触发 suggestion 时使用 fallback clientRect              | 构造点矩形 `(left, bottom, 0, 0)`，`side="top"` 时浮层底边遮挡输入文本上半部 12px (60.6% 覆盖)  | **High**     |
| **BUG-02** | `TiptapSlashMenu.tsx:145-148`                                 | `rawRect` 为 `(0,0,0,0)` 或 Decoration 节点首帧未 mount | 守卫误杀合法零点，回退至 `fallbackRect` (整框)，导致浮层在第 0/1 帧从左侧猛烈瞬跳至光标处       | **High**     |
| **BUG-03** | `TiptapSlashMenu.tsx:151-160`                                 | 输入框滚动或页面滚动                                    | 虚拟锚点使用静态 `position: fixed`，与 `.proseMirrorField` 滚动上下文脱节，滚动时浮层不同步位移 | **Medium**   |
| **BUG-04** | `@tiptap/suggestion:139-152`<br>`TiptapSlashMenu.tsx:107-135` | 中文/CJK 输入法组合态下按 `Enter`/`ArrowDown`/`ArrowUp` | 未检查 `isComposing`/`keyCode 229`，直接 `preventDefault` 并触发命令，彻底破坏并劫持中文输入法  | **Critical** |
| **BUG-05** | `TiptapEditorField.tsx:473-490`                               | 中文组合态中按 `Escape`                                 | `onEscapeCapture` 强行 dispatch exit transaction，导致浏览器未提交的组合 DOM 节点异常撕裂       | **Medium**   |
| **BUG-06** | `TiptapSlashMenu.tsx:168-176`                                 | 输入框超过 10 行并发生内部滚动                          | 光标滚出输入框可见区域时，浮层未做视口边界隐藏，脱离输入框悬浮在聊天消息上方                    | **Medium**   |

---

## 七、架构级严谨根治方案

### 1. 修复 BUG-01：精确构造 LineBox 包围盒

在 `SlashExtension.ts` 中，彻底纠正 `coordsAtPos` 转换为 `DOMRect` 的几何算法，保证其包含完整的行高与宽度：

```typescript
// 推荐修复方案：SlashExtension.ts
clientRect:
  props.clientRect ||
  (() => {
    const view = props.editor?.view;
    if (!view || !props.range) return null;
    const coords = view.coordsAtPos(props.range.from);
    // 严禁坍缩为 bottom 点矩形！必须传递真实的 top, left, width, height
    const width = Math.max(1, coords.right - coords.left);
    const height = Math.max(1, coords.bottom - coords.top);
    return new DOMRect(coords.left, coords.top, width, height);
  }),
```

### 2. 修复 BUG-02 与 BUG-03：虚拟锚点动态跟踪与优雅防抖

在 `TiptapSlashMenu.tsx` 中，改写坐标提取与守卫机制，引入对真实元素引用的动态计算或直接使用 Floating UI 的虚拟元素（Virtual Element）接口，而非固化的 fixed DOM：

```typescript
// 推荐修复方案：TiptapSlashMenu.tsx
// 1. 移除脆弱的 (top !== 0 || left !== 0) 误杀判断
// 2. 提供精确的 isValidRect 校验
const isValidRect = (r: DOMRect | null | undefined): r is DOMRect => {
  if (!r) return false;
  return (
    Number.isFinite(r.top) &&
    Number.isFinite(r.left) &&
    (r.width > 0 || r.height > 0)
  );
};

// 3. 监听 proseMirrorField 的 scroll 事件同步触发位置重算
```

### 3. 修复 BUG-04：在 Suggestion 渲染层全链路注入 CJK IME 保护盾

在 `TiptapSlashMenu.tsx` 的 `onKeyDown` 句柄以及 `SlashExtension.ts` 的 `onKeyDown` 阶段，建立最高优先级的三重 IME 阻断：

```typescript
// 推荐修复方案：TiptapSlashMenu.tsx:107
useImperativeHandle(ref, () => ({
  onKeyDown: ({ event }: { event: KeyboardEvent }) => {
    // 【核心铁律】CJK 组合态保护：组合态中放行一切键盘事件给浏览器原生输入法！
    if (
      event.isComposing ||
      (event as any).nativeEvent?.isComposing ||
      event.keyCode === 229
    ) {
      return false;
    }

    if (!items || items.length === 0) return false;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % items.length);
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
      return true;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      selectItem(selectedIndex);
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (onClose) onClose();
      return true;
    }

    return false;
  },
}));
```

### 4. 修复 BUG-06：滚出视口检测与自动隐藏（Boundary Clipping）

在计算浮层展示时，对比光标 `rect` 与 `.proseMirrorField` 的 `getBoundingClientRect()`。若光标 `rect.bottom < editorRect.top` 或 `rect.top > editorRect.bottom`，则自动赋予浮层 `display: none` 或设置 `open={false}`，彻底杜绝脱缰漂浮。

---

## 八、复审结论与主控交接

本次背对背独立复审确认：

1. 前端输入框在富文本光标几何计算、浮层遮挡间距、DOM/ProseMirror 组合态时序、滚动视口映射四个维度存在确凿的架构断层与时序竞争漏洞。
2. 尤其是 **BUG-04（IME 键盘劫持）** 与 **BUG-01（行高点坍缩遮挡）**，是直接影响 CJK 用户日常打字体验与视觉体验的核心阻塞问题。
3. 报告已完成全方位推导与量化，并落盘至指定路径：`docs/frontend-floating-popover-analysis/audits/RECHECK-02-富文本光标与输入法时序独立复审.md`。
4. 全程纯分析审计，未对生产业务代码做任何修改。
