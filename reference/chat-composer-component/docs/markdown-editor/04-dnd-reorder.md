# 04 — 块级拖拽重排（DnD Reorder）

> **范围**：Notion 式块把手拖拽上下重排、放置指示线、键盘移动、与缩进/列表的边界。  
> **不写**：扩展语法、slash 面板 UI、表格单元格算法（见 [02-block-catalog.md](./02-block-catalog.md) / [05-slash-commands.md](./05-slash-commands.md)）。  
> **关联**：[01-architecture.md](./01-architecture.md) 事务与文档模型、[03-line-renderer.md](./03-line-renderer.md) 块 DOM、[07-visual-system.md](./07-visual-system.md) 动效禁令。

---

## 0. 一句话目标

每个块都能像 Notion 一样 **自由上下拖拽重排**；桌面靠左侧 6 点把手，触控有长按路径；键盘有等价操作；所有移动走同一事务 `moveBlock`，可撤销。

---

## 1. 目标与非目标

### 1.1 目标（v1）

| # | 目标 | 验收信号 |
|---|------|----------|
| G1 | 任意顶层块可拖到文档中任意合法插入缝（两块之间） | 指示线出现，松手后顺序变更 |
| G2 | 仅通过左侧把手启动拖拽，不与文字选区冲突 | 在正文拖不动块；在把手可拖 |
| G3 | 放置反馈 = 水平细线（hairline），非大面积高亮 | 视觉安静，符合对话流禁令 |
| G4 | 表格整表为一拖拽单元；列表项可按项拖 | 见 §11 |
| G5 | 键盘 `Alt+↑/↓` 移动当前块 | 与拖拽同一 `moveBlock` |
| G6 | 拖拽中自动滚动视口 | 靠近上下边缘 48px 内连续滚 |
| G7 | 可撤销 / 可重做 | Undo 栈一条「移动块」 |
| G8 | 基础 a11y：`aria-grabbed`、live region 播报 | 读屏可感知开始/结束 |

### 1.2 非目标（v1 明确不做）

| 非目标 | 原因 / 延期 |
|--------|-------------|
| 多选拖拽（框选多块一起拖） | 复杂度高；v1 推荐 **不做**，见 §5 |
| 拖入列表/引用内部形成嵌套树（任意 drop-into） | v1 建议 **flatten-only** + Tab 改缩进，见 §4 |
| 跨文档 / 跨面板拖 | 宿主边界未定 |
| 协同冲突合并 | 协同非 v1 |
| HTML5 原生 `draggable` 作为主路径 | 见 §14 推荐自定义 pointer |
| 拖拽时块 hover 大阴影 / 浮起卡片 | 对话流 **禁止 hover box-shadow 洗版**；拖拽态仅轻位移 + 透明度 |

### 1.3 分期建议

| 阶段 | 交付 |
|------|------|
| **v1a** | 顶层块同级重排 + 指示线 + 把手 + `moveBlock` + undo + Alt+↑↓ |
| **v1b** | 列表项同级拖、表格整表、scroll-while-drag、ghost 预览 |
| **v1c** | 触控长按、a11y live region 完整文案、reduced-motion |
| **v2** | 可选 drop-into（嵌套）、多选拖、跨容器 |

---

## 2. UX 目标（产品语气）

用户心智模型：

1. **块是可移动的对象**，不是「只能剪贴」。  
2. **把手 = 块的把手**；文字区域 = 选字/编辑，二者物理分离。  
3. **放下的位置永远可见**：一条细线告诉你「会插在这里」。  
4. **失败安静**：非法目标（拖到自己内部、拖到冻结区）无指示线，松手回弹到原位，不 toast 轰炸。  
5. **与阅读态一致**：拖拽不破坏冷静表面；动画 200ms 级，不弹跳夸张。

类比 Notion，但 **不抄皮肤**：6-dot 在左簇（与工具流「信息在左」一致），不在右侧拽。

---

## 3.  Affordance（可发现性）

### 3.1 桌面（pointer: fine）

| 状态 | 把手可见性 | 说明 |
|------|------------|------|
| 默认 | `opacity: 0`，占位保留或宽度折叠到 0→24px | 避免常驻噪声 |
| 块 hover / 块 focus-within | `opacity: 1` | 仅当前块 + 可选相邻防抖 50ms |
| 拖拽中（任意块） | 源块把手保持可见；其他把手隐藏 | 减噪 |
| 编辑态（块内 caret） | 把手仍可 hover 显示 | 不必退出编辑才能拖（松手后焦点策略见 §6） |

**视觉**：6 点网格（2×3），尺寸约 14×20 点击热区 **至少 24×24**（可视觉更小、hit 更大）。

```
┌─ mdx-block ─────────────────────────────────────┐
│ [⠿]  段落正文…                                   │
│  ↑                                               │
│  mdx-handle                                      │
└──────────────────────────────────────────────────┘
```

### 3.2 触控（pointer: coarse）— 计划

| 步骤 | 行为 |
|------|------|
| 1 | 在块 **左缘 32px** 或把手区 **长按 ≥ 400ms** |
| 2 | 触发 haptic（若平台支持）+ 进入 drag；同时 **取消** 后续 click/编辑 |
| 3 | 手指移动 → 指示线跟随；靠近边缘自动滚 |
| 4 | 松手 → drop 或 cancel |

**冲突**：

- 长按未满 400ms 抬起 → 视为 tap，进入编辑或选中块。  
- 长按过程中移动超过 8px → 取消长按计时，交给原生滚动（除非已进入 drag）。  
- **禁止** 在正文中部任意长按就拖块（会毁滚动与选字）。

### 3.3 光标

| 区域 | cursor |
|------|--------|
| 把手 idle | `grab` |
| 拖拽中 | `grabbing`（document 级） |
| 非法放置 | 保持 `grabbing`，指示线消失（不闪 `not-allowed` 噪点，可选极淡） |

---

## 4. 嵌套策略（列表 / 引用 / 容器）

### 4.1 v1 推荐：**同级 flatten 重排 + 缩进走键盘**

**原则**：DnD 只改变 **兄弟顺序**（同一 `parentId` 下 `index`），**不**用拖拽改变父子关系。

| 操作 | v1 |
|------|-----|
| 段落 A 拖到段落 B 上方 | ✅ |
| 列表项 li2 拖到同列表 li0 上方 | ✅ 同 parent |
| 列表项拖出列表变成顶层段落 | ❌ v1 不做（或仅在指示线在「列表块外缝」时整体移动整个 list block） |
| 段落拖「进」列表变成子项 | ❌ v1 不做 |
| 引用块内部段落重排 | ✅ 仅引用容器内兄弟 |
| 用拖拽改 indent | ❌ 用 Tab / Shift-Tab，见 §9 |

**理由**：

1. Drop-into 需要「容器高亮 + 子缝 + 深度映射」，实现与回归成本高。  
2. Markdown 嵌套语义（list indent）用 **indent/outdent** 比几何 drop 更稳。  
3. 用户仍可用：拖整个 `list` 块、或拖 `list_item` 同级重排 + Tab 缩进。

### 4.2 插入缝（slot）模型

文档在 UI 上暴露的是 **缝**，不是「块上」。

```
slot(0)  ── 第一块之前
 block[0]
slot(1)
 block[1]
slot(2)
 ...
slot(n)  ── 最后一块之后
```

对 **嵌套容器**（list、blockquote、toggle 若有）：

- 每个容器有自己的局部 `slot(0..m)`。  
- v1 拖拽时：若当前会话只允许 `dragScope = parentId`，则指示线只在同源兄弟缝上出现。  
- 跨 parent 的缝：不激活（或 v1b 仅允许「拖到顶层缝」把 **整容器** 当单元移动）。

### 4.3 类型草稿

```ts
/** 文档内块（与 01 对齐；此处仅 DnD 所需字段） */
interface BlockRef {
  id: string;
  type: string;           // 'paragraph' | 'heading' | 'list_item' | 'table' | ...
  parentId: string | null;
  /** 在 parent 下的顺序，0-based */
  index: number;
  /** 列表缩进深度；非 list 为 0 */
  indent?: number;
  /** 拖拽策略覆盖；默认由 type 注册表提供 */
  dnd?: BlockDndPolicy;
}

interface BlockDndPolicy {
  /** 是否可作为拖拽源 */
  draggable: boolean;
  /** 拖的是「自己」还是「包含子树的原子单元」 */
  unit: 'self' | 'subtree';
  /** 允许落入的 parent 类型；v1 仅同 parent 时忽略此字段 */
  acceptParents?: string[] | '*';
  /** 禁止作为独立源（例如 table_cell） */
  locked?: boolean;
}

/** 一次放置目标：插到某 parent 下某 index 之前 */
interface DropTarget {
  parentId: string | null;
  /** 插入后新 index；等价于「插在当前该 index 的块之前」 */
  index: number;
  /** 像素位置，用于画指示线 */
  lineY: number;          // 相对 scroll container 或 viewport
  lineX0: number;
  lineX1: number;
  valid: boolean;
}

type DragSessionState =
  | { phase: 'idle' }
  | {
      phase: 'pending';     // 按下尚未过阈值，防误触
      sourceId: string;
      originX: number;
      originY: number;
      pointerId: number;
    }
  | {
      phase: 'dragging';
      sourceId: string;
      sourceParentId: string | null;
      sourceIndex: number;
      pointerId: number;
      ghost: GhostModel;
      drop: DropTarget | null;
      autoScrollDir: -1 | 0 | 1;
    }
  | { phase: 'settling'; sourceId: string; to: DropTarget }; // 200ms 动画中
```

### 4.4 注册表默认策略（建议）

| type | unit | draggable | 备注 |
|------|------|-----------|------|
| paragraph, heading, code, divider, callout | self | true | |
| image, embed | self | true | |
| table | **subtree** | true | 整表；单元格不可拖 |
| table_row / table_cell | — | **false** | locked |
| list | subtree | true | 拖整表列表 |
| list_item | self | true | 仅同级；子树跟随策略见 §11 |
| blockquote | subtree | true | 内部子块可另有局部 dnd |
| blockquote 子段落 | self | true | scope=quote.id |

---

## 5. 多选拖拽

**v1 推荐：不做。**

| 方案 | 决策 |
|------|------|
| Shift/Ctrl 多选 + 拖 | v2 |
| 框选 | 非目标 |
| 拖一个带动「选中集」 | v2 |

**v1 行为**：

- 若未来已有块选中集但未实现多选拖：开始拖时 **仅移动 source**，并清空多选或保留但不跟随（实现选一：推荐 **取消多选**，避免错觉）。  
- 键盘移动同理，只动 **焦点块**。

---

## 6. 指针事件、命中、Ghost、滚动

### 6.1 为何不用「整块 draggable」

整块 `pointerdown` 启动拖会：

- 破坏文本选择与双击选词；  
- 与 contenteditable / 输入法抢事件；  
- 移动端无法滚动。

**契约**：**只有** `.mdx-handle`（及触控左缘热区）能 `setPointerCapture` 进入 drag 会话。

### 6.2 状态机

```
idle
  │ pointerdown on .mdx-handle
  ▼
pending ── pointerup / cancel / 移出 handle 且未超阈值 ──► idle
  │ pointermove 距离 ≥ 4px（桌面）或 长按 ≥ 400ms（触控）
  ▼
dragging ── Escape / pointercancel / 失焦宿主 ──► idle（还原）
  │ pointerup 且 drop.valid
  ▼
settling ── transitionend / 200ms ──► idle（commit 已完成）
  │ pointerup 且 !valid
  ▼
idle（回弹，无 commit）
```

### 6.3 Hit testing（放置缝）

**输入**：指针在滚动容器内的坐标 `(clientX, clientY)`。  
**输出**：`DropTarget | null`。

算法（v1，同 parent 范围）：

```ts
function hitTestDrop(
  y: number,
  siblings: DOMRect[], // 可见兄弟块的 getBoundingClientRect，已按 index 排序
  sourceIndex: number,
  parentId: string | null,
): DropTarget {
  // 1. 对每个兄弟，中线 midY = top + height/2
  // 2. 找 y 落入的「前半 → 该块前缝」「后半 → 该块后缝」
  // 3. 将「源块移除后」的 index 归一化，避免 off-by-one
  // 4. 禁止 no-op：目标 index 与 source 相同或 source+1（移除后）则 valid=false
}
```

**归一化**（源块从列表摘除后重算插入下标）：

```
from = sourceIndex
toRaw = 命中缝的「视觉 index」（摘除前）
to = toRaw > from ? toRaw - 1 : toRaw
if (to === from) valid = false
```

**性能**：

- `dragging` 期间 **不要** 每帧 `querySelectorAll`；在 `dragstart` 缓存 sibling rects。  
- scroll / resize / 自动滚 后 **失效缓存** 并重测（rAF 节流）。  
- 文档 >200 块：只缓存视口 ±  overlapping 缓冲区（上下各 2 屏）的 rect，缝 hit 出界时依赖 auto-scroll 带入。

### 6.4 放置指示线（Drop indicator）

- **形态**：水平 2px（或 1px + 0.5 对齐）hairline，宽度 = 块内容栏宽度（不含左侧 gutter 可选对齐内容左缘）。  
- **颜色**：主题 token，如 `--mdx-drop-line`（建议 accent 60% 不透明度，非霓虹）。  
- **位置**：缝的几何 y；可带左右小圆端（Notion 风）— **可选**，v1 直线即可。  
- **DOM**：单个全局节点复用，不每块一条。

```html
<div class="mdx-drop-indicator" hidden style="transform: translate3d(x, y, 0); width: w;"></div>
```

**禁止**：整块蓝色半透明遮罩作为 v1 主反馈（嵌套 drop-into 才需要容器 outline，v2）。

### 6.5 Drag ghost 预览

| 属性 | 建议 |
|------|------|
| 内容 | 源块的 **克隆快照**（`cloneNode` 后剥离 script、固定宽度） |
| 尺寸 | 宽 = 原块宽；高 max 120px + 底部 fade，避免超长代码块遮屏 |
| 透明度 | `opacity: 0.85` |
| 跟随 | `transform: translate3d(pointer - offset)`，`position: fixed`，`pointer-events: none` |
| 偏移 | 指针相对把手点击点的 offset，避免跳变 |
| 阴影 | **禁止重阴影**；最多 `opacity` + 1px 极淡边，遵守对话流「无 hover 阴影洗版」 |

源块在文档流中的处理（二选一，推荐 A）：

- **A. 占位**：源块加 `mdx-block--dragging`（透明度 0.35 + 不响应），仍占位，缝计算含其 box → 实现简单。  
- **B. 塌陷**：源块 `height: 0` 或移出流，缝更「Notion」但布局抖动大，需 FLIP。

v1 推荐 **A**；v1b 可用 FLIP 做 200ms 兄弟让位动画。

### 6.6 Scroll-while-dragging

```
const EDGE = 48; // px
const MAX_SPEED = 18; // px / frame @60Hz

on pointermove / rAF:
  rect = scrollParent.getBoundingClientRect()
  if (clientY < rect.top + EDGE) autoScrollDir = -1
  else if (clientY > rect.bottom - EDGE) autoScrollDir = 1
  else autoScrollDir = 0

rAF loop while dragging:
  if autoScrollDir ≠ 0:
    intensity = 1 - distToEdge / EDGE
    scrollParent.scrollTop += autoScrollDir * MAX_SPEED * ease(intensity)
    invalidateRectCache()
    recomputeDropTarget()
```

- 滚动容器 = 编辑器 scroller（Notebook body），**不是** `window`（除非无内层 scroller）。  
- 与 Notebook 顶栏拖拽 **解耦**：块 DnD 不触发面板拖动。

### 6.7 与文本选择冲突

| 规则 | 说明 |
|------|------|
| 仅 handle 启动 | 正文 `pointerdown` 永不 `preventDefault` 为了拖块 |
| pending 阶段 | 未进入 dragging 前不 `preventDefault`，允许误点后仍聚焦 |
| 进入 dragging | `preventDefault` + `setPointerCapture`；`user-select: none` 加在 `document.body` 或 root |
| 结束 | 恢复 `user-select`；若 drop 成功，焦点移到移动后的块（caret 放块首或保持块选中） |
| 选区 | 开始 drag 时 `getSelection()?.removeAllRanges()` |

### 6.8 伪代码：核心会话

```ts
function onHandlePointerDown(e: PointerEvent, blockId: string) {
  if (e.button !== 0) return;
  session = {
    phase: 'pending',
    sourceId: blockId,
    originX: e.clientX,
    originY: e.clientY,
    pointerId: e.pointerId,
  };
  handleEl.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!session || session.pointerId !== e.pointerId) return;
  if (session.phase === 'pending') {
    const d = hypot(e.clientX - session.originX, e.clientY - session.originY);
    if (d < 4) return;
    beginDrag(session, e); // → dragging, ghost, aria, live region
  }
  if (session.phase === 'dragging') {
    moveGhost(e);
    session.drop = hitTestDrop(e.clientY, ...);
    paintIndicator(session.drop);
    updateAutoScroll(e.clientY);
  }
}

function onPointerUp(e: PointerEvent) {
  if (session?.phase === 'dragging' && session.drop?.valid) {
    const { sourceId, drop } = session;
    editor.transaction.moveBlock({
      blockId: sourceId,
      toParentId: drop.parentId,
      toIndex: drop.index,
    });
    // undo 已由 transaction 记录
  }
  teardownDrag(); // indicator hide, ghost remove, class clean, aria
}
```

---

## 7. 键盘替代

### 7.1 快捷键

| 快捷键 | 动作 |
|--------|------|
| `Alt+ArrowUp` | 当前块与上一个 **同 parent 兄弟** 交换（实质 `moveBlock` to index-1） |
| `Alt+ArrowDown` | 与下一个兄弟交换 |
| `Escape` | 拖拽中取消 |

**焦点前提**：焦点在编辑器内；优先 **焦点块**（`aria-activedescendant` 或 caret 所在块）。若 caret 在 list_item 内，移动的是该 list_item（或其 dnd unit）。

**不做（v1）**：`Alt+Shift+↑` 跨层级抬升 — 与 outdent 混淆，留给 §9。

### 7.2 与系统快捷键

- Windows：部分环境 `Alt` 聚焦菜单 — 需在编辑器 keydown `preventDefault`（仅当 caret 在编辑器且快捷键命中时）。  
- macOS：Option+↑ 常可绑定；若冲突记入宿主 keymap 表（见 08）。

### 7.3 动画

键盘移动同样走 **200ms** 兄弟位移（FLIP），无 ghost。

---

## 8. 事务：`moveBlock` + Undo

### 8.1 API（与架构对齐的契约）

```ts
interface MoveBlockArgs {
  blockId: string;
  toParentId: string | null;
  toIndex: number;
  /** v1 应恒为 false 或省略；v2 drop-into */
  allowReparent?: boolean;
}

interface Transaction {
  moveBlock(args: MoveBlockArgs): void;
  // 其他 insert/delete/update…
}

interface MoveBlockInverse {
  type: 'moveBlock';
  blockId: string;
  fromParentId: string | null;
  fromIndex: number;
  toParentId: string | null;
  toIndex: number;
}
```

### 8.2 语义

1. 从 `fromParent` 的 children 数组 `splice(fromIndex, 1)`。  
2. 若 `toParent === fromParent` 且 `toIndex > fromIndex`，先减一（标准列表移动）。  
3. `splice(toIndex, 0, block)`。  
4. 更新块上 `parentId/index`（或仅父数组为真源，index 派生）。  
5. **v1**：若 `toParentId !== fromParentId` 且 `!allowReparent` → throw / no-op。  
6. 序列化：Markdown 输出顺序跟随父 children；列表 indent 字段不变（除非单独 indent 事务）。

### 8.3 Undo / Redo

- 一次拖放或一次 Alt+↑ = **一条** undo 记录（inverse = 再 move 回 from）。  
- 合并：连续快速 Alt+↑ 是否合并为一条 — 建议 **250ms 内同 blockId 合并**（可选，v1 可不合并，更直观）。  
- 拖拽 `settling` 期间再入键：排队或忽略直至 settle 结束。

### 8.4 与自动保存

- `moveBlock` commit 后触发与普通编辑相同的 `docStore` dirty + debounce save。  
- **不要** 在 `pending` 或未 valid 的 pointerup 写存储。

### 8.5 Markdown 往返

- 仅顺序变化：往返稳定。  
- 若未来 reparent list_item → 顶层，serialize 必须去列表标记；**v1 不做 reparent** 则无此风险。

---

## 9. 嵌套列表：Tab / Shift-Tab vs DnD

| 能力 | 输入 | 事务 | 说明 |
|------|------|------|------|
| 同级重排 | DnD / Alt+↑↓ | `moveBlock` | 不改 indent |
| 增加缩进 | `Tab`（列表项首或整项选中） | `indentBlock` | indent+1，受 max 限制（如 5） |
| 减少缩进 | `Shift+Tab` | `outdentBlock` | indent-1；0 时或变段落（产品定） |
| 拖拽改缩进 | — | v1 **禁止** | 避免与缝模型纠缠 |

**列表项拖拽时子树**：

- 若数据模型是「扁平 list_item + indent」：移动一项时，**连续 indent 更深的后继项**应作为子树一并移动（Notion 行为）。  
- 若数据模型是真树 children：`unit: 'subtree'` 移动节点即含子节点。

```ts
/** 扁平 indent 模型下收集拖拽单元 */
function collectFlatListDragUnit(items: BlockRef[], start: number): string[] {
  const base = items[start].indent ?? 0;
  const ids = [items[start].id];
  for (let i = start + 1; i < items.length; i++) {
    const ind = items[i].indent ?? 0;
    if (ind <= base) break;
    ids.push(items[i].id);
  }
  return ids;
}
```

`moveBlock` 对单元应支持 **批量保序移动**（内部仍一条 undo）：

```ts
moveBlocks({ blockIds: string[], toParentId, toIndex })
```

v1a 可只做单块；**列表正确性在 v1b 必须** `moveBlocks` 单元。

---

## 10. 无障碍（a11y）

### 10.1 把手

```html
<button type="button"
  class="mdx-handle"
  aria-label="拖动以重排块"
  aria-grabbed="false"
  tabindex="-1"
  data-block-id="…">
  <!-- 6-dot 纯 CSS 或 svg，aria-hidden -->
</button>
```

- `tabindex="-1"`：不进入全局 Tab 序（避免文档 N 个把手灾难）；键盘用户用 **Alt+↑↓**。  
- 若产品坚持把手可 Tab：仅 **焦点块** 的把手 `tabindex="0"`，其余 -1。

### 10.2 拖拽中

| 属性 | 值 |
|------|-----|
| 源把手 `aria-grabbed` | `true` |
| 根容器 | `aria-busy="true"` 可选 |
| live region | 见下 |

### 10.3 Live region

```html
<div class="mdx-dnd-live sr-only" aria-live="assertive" aria-atomic="true"></div>
```

| 时机 | 文案示例 |
|------|----------|
| 开始拖 | 「正在移动：标题 2」 |
| 悬停合法缝 | 「可放到第 3 块之前」（节流 300ms） |
| 成功放下 | 「已移动到第 3 位」 |
| 取消 | 「已取消移动」 |

块类型中文名从 catalog 取（见 02）。`assertive` 仅用于开始/结束；缝更新用 `polite` 或降频，避免刷屏。

### 10.4 焦点

- 拖完：焦点回到块容器 `tabindex=-1` 的 block 可聚焦外壳，或恢复 caret。  
- 取消：恢复拖前焦点。  
- `prefers-reduced-motion: reduce`：跳过 200ms 位移动画，瞬间换位。

---

## 11. 边界情况

### 11.1 表格

- **拖源**：仅表格块外壳把手；`unit: 'subtree'`。  
- **禁止**：从单元格内手柄、列边界拖出「行重排」当作块 DnD（行重排若需要是表格内部 UI，非本篇）。  
- **指示线**：落在其他顶层块之间；不可落到「表内」。

### 11.2 列表项

- 同列表内重排 + 子树跟随（§9）。  
- 跨两个 `list` 块：v1 **不允许** reparent；用户需 outdent 再拖或剪贴（v2 再做）。  
- 空列表项可拖。  
- 任务列表（checkbox）与普通 li 同一 dnd 策略。

### 11.3 代码块 / 超长块

- Ghost 高度封顶 + 底部渐隐。  
- hitTest 用完整 offsetHeight，不因 ghost 截断而改缝。

### 11.4 分割线、空段落

- 可拖；空段落过密时缝仍按块 box，避免「缝粘连」可设 min 缝间距视觉 2px。

### 11.5 只读 / 锁定块

- `dnd.locked` 或文档 `readOnly`：无把手或把手 `disabled`，不进入 pending。

### 11.6 虚拟列表

- 未上虚拟列表前：全量 DOM。  
- 若 >500 块虚拟化：拖拽期间 **放大 overscan** 或临时对 source 附近解虚拟化；rect 缓存与 scroll 同步必须测。  
- API：`getSiblingLayoutRange(parentId) -> {id, top, height}[]` 由布局层提供，DnD 不直读全 DOM。

### 11.7 嵌套滚动 / iframe

- 一般无 iframe；若 embed 预览，把手仍在外壳。

### 11.8 失败与空态

| 情况 | 行为 |
|------|------|
| 文档仅 1 块 | 可拖但所有缝 no-op，无指示线 |
| 合法缝为 0 | 松手回弹 |
| 事务失败 | live region「无法移动」；还原 UI |
| 拖出窗口 | 保持 last valid drop；up 时用 last valid |

---

## 12. 与文本选择 / 仅把手

**硬规则总结**：

1. **启动域**：仅 `.mdx-handle`（+ 触控左缘长按热区）。  
2. **选择域**：`.mdx-block__content` 内默认浏览器选择，编辑器不抢。  
3. **阈值**：桌面 4px；触控长按 400ms。  
4. **capture**：仅 dragging 后 capture，避免 pending 吞掉 click。  
5. **click 合成**：若 pending→dragging，抑制随后 click（`preventClickUntil` 时间戳）。  
6. **IMe**：dragging 时不插入字符；一般 pointer capture 已足够。

---

## 13. CSS 类契约

| 类名 | 挂载点 | 职责 |
|------|--------|------|
| `mdx-handle` | 块左 gutter 按钮 | 拖拽启动命中；grab 光标 |
| `mdx-drop-indicator` | 编辑器层全局一条 | 放置水平发丝线 |
| `mdx-block--dragging` | 源 `.mdx-block` | 源块占位半透明 / 降交互 |
| `mdx-block--drag-over` | **v1 不用**（留 v2 容器） | — |
| `mdx-drag-ghost` | `body` 或 editor portal | 跟随指针的克隆 |
| `mdx-dnd-live` | 全局 sr-only | aria-live |
| `mdx-editor--dragging` | 编辑器根 | 全局 cursor、user-select、隐藏其他把手 |

### 13.1 DOM 草图

```html
<div class="mdx-editor" data-dnd="pointer">
  <div class="mdx-dnd-live sr-only" aria-live="assertive"></div>
  <div class="mdx-drop-indicator" hidden></div>

  <div class="mdx-scroller">
    <div class="mdx-block" data-block-id="b1" data-type="paragraph">
      <div class="mdx-block__gutter">
        <button type="button" class="mdx-handle" aria-label="拖动以重排块" aria-grabbed="false">
          <span class="mdx-handle__dots" aria-hidden="true"></span>
        </button>
      </div>
      <div class="mdx-block__content">…</div>
    </div>
    <!-- … -->
  </div>
</div>

<!-- dragging 时 -->
<div class="mdx-drag-ghost" aria-hidden="true">…clone…</div>
```

### 13.2 样式要点（非完整 visual token）

```css
.mdx-handle {
  opacity: 0;
  cursor: grab;
  /* 热区 ≥ 24×24；视觉可更窄 */
  border: none;
  background: transparent;
  /* 禁止 box-shadow 作为 hover 主反馈 */
}
.mdx-block:hover .mdx-handle,
.mdx-block:focus-within .mdx-handle,
.mdx-handle:focus-visible {
  opacity: 1;
}
.mdx-editor--dragging .mdx-handle {
  opacity: 0;
}
.mdx-editor--dragging .mdx-block--dragging .mdx-handle {
  opacity: 1;
  cursor: grabbing;
}
.mdx-block--dragging {
  opacity: 0.35;
}
.mdx-drop-indicator {
  position: fixed; /* 或 absolute within editor */
  height: 2px;
  pointer-events: none;
  background: var(--mdx-drop-line, color-mix(in oklab, var(--accent) 70%, transparent));
  z-index: 50;
  border-radius: 1px;
  /* 禁止重阴影 */
}
.mdx-drag-ghost {
  position: fixed;
  pointer-events: none;
  z-index: 60;
  opacity: 0.85;
  max-height: 120px;
  overflow: hidden;
  /* 可选极淡 outline，禁止大阴影 */
}
@media (prefers-reduced-motion: reduce) {
  .mdx-block {
    transition: none !important;
  }
}
```

**动效禁令回声**（与对话流一致）：

- 不在 hover 块上加 box-shadow「浮起」。  
- 拖拽反馈靠指示线 + ghost 透明度 + 轻位移，不靠阴影扩散。

---

## 14. 实现选型：HTML5 DnD vs Pointer 自定义

| 维度 | HTML5 Drag and Drop API | Pointer Events 自定义 |
|------|-------------------------|------------------------|
| 把手限制 | 需 `draggable=true` 与 `dragstart`，易误绑整块 | 天然只绑 handle |
| 自定义 ghost | `setDragImage` 简陋、浏览器不一致 | 完全可控 |
| 触控 | 移动端支持差 / 不一致 | 长按逻辑自管 |
| 自动滚 | 部分浏览器可用但不稳 | 自管 rAF |
| 指示线 | `dragover` 坐标可用但事件怪 | `pointermove` 清晰 |
| 与 contenteditable | 经常打架 | 边界清晰 |
| 无障碍 | 原生有限 | 需自管，但本就可控 |
| 工作量 | 看似少，坑多 | 中等，行为确定 |

### 推荐：**Pointer Events 自定义（主路径）**

- reference / vanilla 阶段直接实现 §6 状态机。  
- 若未来嵌入 TipTap/ProseMirror：仍建议 **外挂 handle + 事务 move**，不要依赖 HTML5 DnD 扩展。  
- **禁止** 双轨并行（HTML5 + pointer）除非 polyfill 旧浏览器；Conex 桌面目标环境足够新。

---

## 15. 动画

| 场景 | 参数 |
|------|------|
| 兄弟让位 / 落位 | **200ms**，easing `cubic-bezier(0.2, 0.8, 0.2, 1)`（轻 spring 感，非弹性多次震荡） |
| Ghost 淡出 | 120–160ms opacity |
| 指示线出现 | 即时或 80ms opacity，避免拖后滞后 |
| 键盘 move | 同 200ms FLIP |
| reduced-motion | 0ms 换位 |

**FLIP 草图**：

```
First:  记录各兄弟 getBoundingClientRect
Commit: 应用 moveBlock，DOM 重排
Last:   再测 rect
Invert: transform 差值
Play:   transition transform 200ms → none
```

拖拽过程中（A 方案占位）可不做持续让位；**松手 settling** 再 FLIP。若选 B 塌陷，dragging 中也需节流 FLIP（成本高，v1 不取）。

---

## 16. 验收测试清单

### 16.1 功能

- [ ] 悬停块时左侧出现 6-dot 把手；离开后隐藏（动画不闪烁）  
- [ ] 按住把手拖动，源块进入 `mdx-block--dragging`  
- [ ] 移动时出现且仅一条 `mdx-drop-indicator` 水平发丝线  
- [ ] 松手后块顺序正确；Markdown serialize 顺序一致  
- [ ] 拖到原位 / 非法缝：顺序不变，无多余 undo  
- [ ] `Alt+↑` / `Alt+↓` 与拖拽结果一致，可 undo/redo  
- [ ] 连续移动多块后 undo 栈顺序正确  
- [ ] 表格只能整表拖；单元格内无法启动块拖  
- [ ] 列表项拖动携带更深 indent 的子项（扁平模型）  
- [ ] Tab / Shift-Tab 改缩进 **不** 被 DnD 破坏；DnD **不** 改 indent  
- [ ] 只读文档无拖拽  

### 16.2 指针与冲突

- [ ] 在正文拖动是选字，不是拖块  
- [ ] 双击选词、三击选段正常  
- [ ] 拖拽中 `user-select` 禁用，结束后恢复  
- [ ] 拖拽后不会误触发 click 进入异常编辑态  
- [ ] Escape 取消拖拽，位置还原  

### 16.3 滚动与性能

- [ ] 拖至容器上下边缘 48px 内自动滚动  
- [ ] 滚动中指示线目标更新正确  
- [ ] 200+ 块文档拖拽 pointermove 无长任务（>16ms）明显卡顿（抽样 performance）  
- [ ] 无每帧全量 innerHTML  

### 16.4 Ghost 与视觉

- [ ] Ghost 跟随指针，无大跳变  
- [ ] 长代码块 Ghost 限高  
- [ ] **无** 块 hover box-shadow 洗版；拖拽无重阴影  
- [ ] 落位约 200ms 过渡；`prefers-reduced-motion` 下无过渡  

### 16.5 触控（v1c）

- [ ] 左缘/把手长按 400ms 进入拖  
- [ ] 短按仍能编辑  
- [ ] 长按前滑动仍可页面滚动  

### 16.6 a11y

- [ ] `aria-grabbed` 在拖中为 true、结束后 false  
- [ ] live region 播报开始/结束  
- [ ] 键盘可完成重排（Alt+↑↓）无需把手焦点  
- [ ] 焦点在结束后可预期  

### 16.7 回归 / 宿主

- [ ] Notebook 顶栏拖动面板 ≠ 块拖拽  
- [ ] 不破坏 Phase 0–2 对话流  
- [ ] pin / Esc 关闭面板仍可用；拖块时 Esc 优先取消拖  

### 16.8 往返

- [ ] move 后保存 → 重载顺序保持  
- [ ] parse → 拖 → serialize → parse 块 id 策略符合 01（id 稳定或映射表）  

---

## 17. 事件与模块边界（实现落点）

```
js/markdown-editor/
  dnd/
    DragSession.ts      # 状态机
    hitTest.ts          # 缝命中与 index 归一化
    autoScroll.ts
    ghost.ts
    indicator.ts
    keyboardMove.ts     # Alt+↑↓
    a11y.ts             # live region / aria-grabbed
  model/
    transactions/moveBlock.ts
    transactions/moveBlocks.ts  # 列表单元
    transactions/indent.ts      # Tab 路径，非 DnD
```

编辑器根：

```ts
// 伪注册
editor.dnd = createDragController({
  getBlock, getSiblingsLayout, moveBlock, moveBlocks, isReadOnly,
  scrollParent, liveRegion,
});
```

**与 line-renderer**：块挂载时渲染 gutter+handle；不在 renderer 内写 hitTest。  
**与 slash**：拖拽 `phase !== idle` 时关闭 slash 面板、忽略 `/`。  
**与 visual-system**：token `--mdx-drop-line`、动效时长 200ms 收录于 07。

---

## 18. 风险与开放问题

| 风险 | 缓解 |
|------|------|
| 扁平 list 子树移动 off-by-one | 单测 `collectFlatListDragUnit` + `moveBlocks` |
| 虚拟列表后 rect 失真 | 布局层 API；拖时加大 overscan |
| Alt 与菜单键冲突 | 宿主 keymap；可配置为 `Mod+Alt+↑` |
| 触控长按与系统选词菜单 | 进入 drag 后 `preventDefault`；调整 400ms |
| reparent 用户预期（「拖进列表」） | v1 文档/空态不暗示可放入；v2 再做容器高亮 |

**开放（不阻塞 v1）**：

1. 把手旁 `+` 插入是否与 gutter 抢位 — 见 05/07。  
2. 是否允许拖到文档 **外部** 导出为附件 — 非目标。  
3. 真树 vs 扁平 list 以 01 终稿为准；本篇两种都给出钩子。

---

## 19. 完成定义（本篇）

- [x] UX 目标与 Notion 对齐的可感知行为  
- [x] 把手 / 触控长按 affordance  
- [x] Hit test、指示线、ghost、auto-scroll  
- [x] 嵌套 v1 = flatten 同级；indent 走 Tab  
- [x] 多选拖 v1 不做  
- [x] `moveBlock` 事务与 undo  
- [x] 键盘 Alt+↑↓  
- [x] a11y aria-grabbed + live region  
- [x] 表格整表、列表项边界  
- [x] 与选区冲突规则  
- [x] CSS 类：`mdx-handle`、`mdx-drop-indicator`、`mdx-block--dragging`  
- [x] 推荐 Pointer 自定义而非 HTML5 DnD  
- [x] 200ms 动效与阴影禁令  
- [x] 验收清单可交给实现 / QA  

---

## 20. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 首稿：DnD 全链路规格（设计轮） |
