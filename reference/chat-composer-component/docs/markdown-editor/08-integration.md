# 08 — 宿主集成（Integration）

> **读者**：接 Notebook / Flow / 未来 Desktop 的实现 agent  
> **依赖**：[07-visual-system.md](./07-visual-system.md)、`js/components/NotebookPanel.js`、`js/components/ArtifactChip.js`、`js/markdown-lite.js`  
> **不做**：块解析算法细节、slash 词条全集（见 01–06）

---

## 1. 目标 / 非目标

### 目标

- 首个宿主：**对话流 `NotebookPanel`** 的 body 换装为块编辑器，外壳（pin / 拖顶栏 / Esc / 定位）**行为保留**。
- 统一 **Markdown 字符串** 进出：`docStore` 兼容、autosave debounce、宿主回调可插。
- Flow **artifact chip 仍打开 notebook**；编辑结果写回同一 title 键。
- 预留第二宿主：桌面文档面板、Skill 说明查看器。
- 可灰度：feature flag 在 markdown-lite 与块编辑器之间切换。

### 非目标

- 不改坏对话流 Phase 0–2（Purpose / Permission / Subagent）。
- v1 不做多 tab 文档、协同 CRDT、服务端强一致。
- 代码文件 **不进** Notebook（仍走预览/编辑器其它路径）。

---

## 2. 架构位置

```
ArtifactChip.click
    → NotebookPanel.open(title, content, anchorEl, opts)
        → ensure() 外壳 DOM
        → EditorHost.mount(nb-body, EditorOptions)   // 新
            → MarkdownEditor (js/markdown-editor/*)
                ↔ serialize/parse ↔ Markdown 字符串
                → onChange / onAutosave → docStore[title]
```

| 层 | 职责 | 文件（规划） |
|----|------|----------------|
| 外壳 | pin、drag、header、open/close、Esc 关面板 | `NotebookPanel.js`（保留） |
| 宿主适配 | 挂载/销毁编辑器、桥接 docStore、flag | `NotebookPanel.js` + `js/markdown-editor/host-notebook.js` |
| 引擎 | Block 模型、输入、slash、DnD | `js/markdown-editor/*` |
| 皮肤 | `mdx-*` | `css/markdown-editor/*` |
| 旧预览 | fallback | `markdown-lite.js` |

---

## 3. NotebookPanel body 替换 API

### 3.1 当前 DOM（现状）

```html
<div class="nb-panel">
  <div class="nb-header" data-nb-drag>…</div>
  <div class="nb-body">
    <div class="nb-content is-reading md-preview" contenteditable>…</div>
  </div>
</div>
```

现状：`.nb-content` 整区 click → 整页 source 编辑 → blur 再 `MarkdownLite.render`。

### 3.2 目标 DOM

```html
<div class="nb-panel is-open">
  <div class="nb-header" data-nb-drag>…不变…</div>
  <div class="nb-body" data-nb-editor-host>
    <!-- 块编辑器根：由 mount 注入 -->
    <div class="mdx-root" data-editor-id="…"></div>
  </div>
</div>
```

- **删除** 对 `.nb-content` 的 contenteditable 整页逻辑（flag 开启时）。
- `.nb-body` 只做滚动容器（padding 保留自 `artifact-notebook.css`）；**内部滚动也可交给 `.mdx-root`**，二选一，推荐：

| 方案 | 选择 |
|------|------|
| A. body 滚 | `nb-body { overflow-y:auto }`，mdx-root 不滚 |
| B. root 滚 | body overflow hidden，mdx-root flex 1 滚 |

**决策：A**（少改现有 CSS）。虚拟列表（M6）时再评估 B。

### 3.3 TypeScript 契约（草稿）

```ts
/** 挂载到 Notebook（或其它宿主）的编辑器句柄 */
export interface MarkdownEditorHandle {
  /** 当前文档 Markdown（规范化后） */
  getMarkdown(): string;
  /** 用 Markdown 重置文档；保留 undo 与否由 opts 决定 */
  setMarkdown(md: string, opts?: { emit?: boolean; keepHistory?: boolean }): void;
  focus(opts?: { blockId?: string; end?: boolean }): void;
  blur(): void;
  destroy(): void;
  /** 是否有未落盘/未回调的本地 dirty（相对 lastSynced） */
  isDirty(): boolean;
  getBlockCount(): number;
  /** 只读模式：隐藏 handle/slash，仍可选中复制 */
  setReadOnly(ro: boolean): void;
}

export interface MarkdownEditorCallbacks {
  /** 每次文档变更（块内容或结构）；高频，勿直接写盘 */
  onChange?: (md: string, meta: ChangeMeta) => void;
  /** debounce 后的保存点；宿主应写入 docStore / 远端 */
  onAutosave?: (md: string, meta: AutosaveMeta) => void;
  /** 用户点击 wiki/file 路径或「在工作区打开」 */
  onOpenPath?: (path: string, meta: OpenPathMeta) => void;
  /** 可选：通知外壳 dirty 点亮等 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 可选：slash/错误遥测 */
  onTelemetry?: (event: string, payload?: Record<string, unknown>) => void;
}

export interface ChangeMeta {
  reason: 'input' | 'paste' | 'slash' | 'dnd' | 'api' | 'undo' | 'redo';
  blockIds?: string[];
}

export interface AutosaveMeta {
  title?: string;
  revision: number;
  at: number; // Date.now()
}

export interface OpenPathMeta {
  kind: 'file-chip' | 'wiki-link' | 'md-link';
  sourceBlockId?: string;
}

export interface MarkdownEditorMountOptions {
  initialMarkdown?: string;
  title?: string;           // 文档键，与 docStore 对齐
  readOnly?: boolean;
  autosaveMs?: number;      // 默认 400，对齐现 Notebook AUTOSAVE_MS
  placeholder?: string;
  features?: EditorFeatureFlags;
  callbacks?: MarkdownEditorCallbacks;
  /** 宿主根：.nb-body */
  hostEl: HTMLElement;
}

export function mountMarkdownEditor(
  opts: MarkdownEditorMountOptions
): MarkdownEditorHandle;
```

### 3.4 适配层伪代码（NotebookPanel）

```js
// host-notebook.js 概念
function mountIntoNotebook(panelState, title, md) {
  var host = panelState.el.querySelector('[data-nb-editor-host]')
    || panelState.el.querySelector('.nb-body');
  if (panelState.editor) {
    panelState.editor.destroy();
    panelState.editor = null;
  }
  panelState.editor = MarkdownEditor.mount({
    hostEl: host,
    title: title,
    initialMarkdown: md,
    autosaveMs: 400,
    features: getEditorFlags(),
    callbacks: {
      onChange: function (next) {
        // 可选：仅标 dirty，不写 store
      },
      onAutosave: function (next) {
        docStore[title] = next;
      },
      onOpenPath: function (path, meta) {
        if (typeof FC.onNotebookOpenPath === 'function') {
          FC.onNotebookOpenPath(path, meta);
        }
      },
    },
  });
}
```

### 3.5 外壳 API 扩展（保持向后兼容）

现有：

```js
FC.NotebookPanel = {
  ensure, open, close, flush, setPinned, isPinned, isOpen,
  scheduleHide, clearHideTimer, docStore, ensureDoc,
};
```

**增量（推荐）**：

```ts
// 新增，均可选
getEditor(): MarkdownEditorHandle | null;
/** 强制把编辑器内容写入 docStore */
flush(): void; // 已有：实现改为 editor.getMarkdown() → docStore
/** 外部替换当前打开文档正文 */
setContent(md: string): void;
/** 注册全局路径打开 */
// 或通过 FC.onNotebookOpenPath
```

`open(title, content, anchorEl, opts)` 签名 **不破坏**；内部改为 `mount` / `setMarkdown`。

`close`：先 `flush()`（editor → docStore），再 `editor.blur()`，隐藏面板；**默认不 destroy**（单例复用），仅 `setMarkdown('')` 或保留上次。  
**决策：单例编辑器**，`open` 切换 title 时 `setMarkdown(ensureDoc(...))`；`destroy` 仅在 host teardown。

---

## 4. 宿主回调详表

| 回调 | 触发 | 宿主动作 | 默认（Notebook） |
|------|------|----------|------------------|
| `onChange` | 每次事务提交 | 可更新「未保存」UI | 可空；或只 `dirty=true` |
| `onAutosave` | debounce `autosaveMs`（默认 400） | **写 `docStore[title]`** | 必须接 |
| `onOpenPath` | file-chip / wiki / 修饰键点链接 | 打开工作区文件、侧栏预览 | 无则 `window.open` 仅 http(s) |
| `onDirtyChange` | dirty 边沿 | 标题旁小点（可选） | 可空 |
| pin | **外壳**按钮，非编辑器 | `setPinned` | 现有逻辑 |
| Esc | 分层 | 见下 | 见下 |

### 4.1 Esc 优先级（状态机）

```
Esc
 ├─ slash 菜单打开？ → 关菜单，编辑器保持焦点
 ├─ 块内「子编辑」（如表格单元格选区扩展）？ → 退到块级
 ├─ 有多选块？ → 清多选
 └─ 否则 → 编辑器 blur（块退出编辑态）
      └─ 若面板未 pin：与现网一致，用户再 Esc → close(true)
```

**注意**：现网 `onEsc`：editing → `exitEditMode`；否则 `close(true)`。  
块编辑器下「无全局 editing 布尔」：用 `editor.hasFocus()` / `editor.hasOverlay()` 替代。

### 4.2 pin / autosave 关系

- pin **不**改变 autosave 策略；只阻止 mouseleave 自动 hide。
- 关闭面板（含 force）必须 `flush` 一次，避免丢最后一次按键。

### 4.3 onOpenPath 安全

- 仅允许相对路径、workspace 协议、http(s)。
- `javascript:` / 数据 HTML 拒绝。
- Markdown 链接 `rel="noopener noreferrer"`（阅读态渲染已约束，见 briefing）。

---

## 5. Flow Artifact Chip 契约

现有：`ArtifactChip` → `NotebookPanel.open(...)`。

**保持**：

- 文案「已生成」+ 文档标题 chip。
- click / hover 打开策略不变（见 `CONVERSATION_FLOW_SPEC` §7.6）。
- 打开时传入的 `content` 若 docStore 已有非空则 **不覆盖**（`ensureDoc` 现逻辑）。

**增量**：

- chip **不**直接依赖 `MarkdownLite`。
- 若 flag 关：行为与现网完全一致。
- 若文档在编辑器中打开且 dirty：chip 再 click 同一 title → 聚焦已有面板，不重置内容。

```js
// open 幂等
if (isOpen() && state.title === title) {
  clearHideTimer();
  positionNear(anchorEl); // 未 pin 拖走时
  editor && editor.focus();
  return state.el;
}
```

---

## 6. 未来宿主

### 6.1 桌面面板（crish-desktop）

| 点 | 说明 |
|----|------|
| 包形态 | 将 `js/markdown-editor` 抽 `packages/markdown-editor` 或拷入 `apps/crish-desktop/src/editor`（M6 预备） |
| 挂载 | React：`useEffect` → `mountMarkdownEditor`；`destroy` on unmount |
| 存盘 | `onAutosave` → Tauri/fs 或 daemon doc API |
| 主题 | 接入 desktop design tokens；class 仍 `mdx-` |
| 非目标 v1 | 与会话流强绑的 pin/hover dismiss |

### 6.2 Skill 查看器

- 默认 `readOnly: true`。
- 允许复制、wiki 跳转；隐藏 DnD handle 与 slash。
- 内容来自 skill markdown 文件，不写 docStore。

### 6.3 宿主接口最小集

任何宿主只需：

```ts
mountMarkdownEditor({ hostEl, initialMarkdown, callbacks, features, readOnly? })
```

外壳 chrome（header/pin）**不是**编辑器责任。

---

## 7. 从 markdown-lite 迁移

### 7.1 现状能力

`markdown-lite.js`：heading、p、ul/ol、table、fence code、bold/italic/code/link。无任务列表、callout、wiki、拖拽、块编辑。

### 7.2 策略

| 阶段 | 策略 |
|------|------|
| M0–M1 | flag 开：块编辑器；关：完整保留 lite 路径 |
| M2–M4 | 默认开（demo）；lite 仅 fallback 与只读对比测试 |
| M5+ | lite 降级为「无编辑器包时的只读 render」或删除调用点 |

### 7.3 往返兼容

- 打开：`parse(md) → Block[]`；无法识别的构造 → `paragraph` raw 或 `code` 保底（见 01）。
- 保存：`serialize(blocks) → md`；**用户未碰的语义尽量 round-trip**。
- 旧 docStore 纯字符串 **无需迁移格式**；首次 parse 即可。

### 7.4 DOM/CSS 迁移

| 旧 | 新 |
|----|-----|
| `.md-preview` 全局 prose | `.mdx-root` 内皮肤 |
| `.nb-content.is-editing` | 删除；块级 `is-editing` |
| `content.title = 点击编辑` | placeholder / 空段提示 |
| 整页 `innerHTML = render(all)` | **禁止**；按块 patch |

双写期：可在 root 同时带 `md-preview` 做样式兜底，M4 后移除。

### 7.5 行为 diff（产品说明）

| 行为 | lite 时代 | 块编辑器 |
|------|-----------|----------|
| 点击正文 | 整页变 source | 该块进入编辑 |
| blur | 全文 re-render | 块提交 + 局部渲染 |
| 插入标题 | 手打 `#` | slash / `、` 或 Markdown 语法 |
| 重排 | 剪贴 | 拖把手 |

---

## 8. Feature flags

```ts
export interface EditorFeatureFlags {
  blockEditor?: boolean;      // master；false = markdown-lite 路径
  slashCommands?: boolean;    // M2
  slashChineseDun?: boolean;  // `、` 触发，默认 true
  dndReorder?: boolean;       // M3
  tables?: boolean;           // M4
  codeBlock?: boolean;        // M4
  callouts?: boolean;         // M4
  fileChip?: boolean;         // M5
  wikiLink?: boolean;         // M5
  virtualize?: boolean;       // M6；或 auto 当 blocks > 500
}
```

### 8.1 解析来源（优先级高→低）

1. `mount` options `features`
2. `window.__CONEX_MDX_FLAGS__`（demo/debug）
3. `localStorage['conex.mdx.flags']` JSON
4. 构建期默认：`{ blockEditor: true, slashChineseDun: true, …按里程碑 }`

### 8.2 Notebook 开关示例

```js
function getEditorFlags() {
  var g = window.__CONEX_MDX_FLAGS__ || {};
  if (g.blockEditor === false) return { blockEditor: false };
  return Object.assign({
    blockEditor: true,
    slashCommands: true,
    slashChineseDun: true,
    dndReorder: true,
    tables: true,
    codeBlock: true,
    callouts: true,
    fileChip: false,
    wikiLink: false,
    virtualize: false,
  }, g);
}
```

Master flag 关时：`open` 恢复 `.nb-content` + lite，**零回归**旧 demo。

---

## 9. 数据：docStore 兼容

### 9.1 形状（现状保留）

```js
// title → markdown string
var docStore = Object.create(null);
// 例：docStore['调研报告.md'] === '# 标题\n\n…'
```

### 9.2 兼容规则

| 规则 | 说明 |
|------|------|
| 键 | 仍用 **title 字符串**（与 chip 文案一致） |
| 值 | **始终 Markdown 文本**；不在 v1 存 Block JSON 到 docStore |
| ensureDoc | 逻辑保留：空才用传入 content 填充 |
| flush | `docStore[title] = editor.getMarkdown()` |
| 外部读 | `NotebookPanel.docStore[title]` 仍可用 |
| 并发 | 单例面板；无多实例写同一 title |

### 9.3 可选演进（非 v1 必做）

```ts
// 未来
type DocRecord = {
  markdown: string;
  rev: number;
  updatedAt: number;
};
// docStore[title] = string | DocRecord
// getMarkdown() 归一化
```

### 9.4 与 autosave revision

编辑器内部 `revision++` 每次事务；`onAutosave` 带 `revision`，宿主可丢弃乱序（通常单线程无此问题）。

---

## 10. 生命周期时序

```
ensure()
  → 建 nb-panel DOM（一次）

open(title, md, anchor)
  → ensureDoc
  → 若无 editor: mount(host)
  → 若有 editor: setMarkdown(md)（title 变则切换）
  → show panel + positionNear
  → 不自动 focus 编辑（保持阅读态；与「点击再编」一致）

user edits
  → onChange*
  → debounce → onAutosave → docStore

close(force)
  → flush
  → hide panel
  → 保留 editor 实例与 last title（除非 destroy）

page unload
  → flush（beforeunload 可听）
```

---

## 11. a11y 集成

- 面板 `role="dialog"` + `aria-label` 保留。
- 编辑器根 `role="document"`；勿再套一层 dialog。
- 焦点：从 chip 打开后焦点可留在 panel 容器；首次 Tab 进第一块。
- 菜单关闭后焦点回到触发块。

---

## 12. 边界情况

| 场景 | 处理 |
|------|------|
| 极长 MD（&gt;500 块） | M6 虚拟化；此前可降级只读 lite 或警告 |
| parse 失败 | 整篇单 code/paragraph 保底；toast 可选 |
| 空 title | 禁止 open；chip 侧保证非空 |
| 快速连续 open 不同 title | 先 flush 旧 title，再 setMarkdown 新 |
| destroy 后误用 handle | 方法 no-op 或 throw 一次 dev warn |
| flag 热切换 | 需 flush + remount；demo 可刷新页 |

---

## 13. 测试点

- [ ] `open` → 编辑 → `flush` → `docStore[title]` 等于序列化 MD  
- [ ] 再 `open` 同 title 不丢字  
- [ ] chip 二次点击聚焦，不重置  
- [ ] `blockEditor:false` 完整走 lite  
- [ ] Esc 分层（菜单 / 块 / 关面板）  
- [ ] pin 时 mouseleave 不关；force close 仍 flush  
- [ ] `onOpenPath` 非法协议被拒  
- [ ] 往返：lite 能渲染的 MD，块编辑器 serialize 后 lite 仍能渲染（抽样）

---

## 14. 分期依赖

| 里程碑 | 集成交付 |
|--------|----------|
| M0 | `mount` 空编辑器进 `nb-body`；flag；docStore 读写空串 |
| M1 | 替换 lite 编辑路径；autosave 接通 |
| M2 | slash 与面板 z-index / 焦点 |
| M3 | DnD 与 panel 拖拽 header **事件不冲突**（handle 不冒泡到 header） |
| M4 | 皮肤与 nb padding 联调 |
| M5 | onOpenPath 接 chip 同源路径体验 |
| M6 | desktop 挂载文档 + 虚拟列表 host 滚动约定 |

细节排期见 [09-implementation-roadmap.md](./09-implementation-roadmap.md)。

---

## 15. 相关文档

- 视觉 class：[07-visual-system.md](./07-visual-system.md)
- 键盘：[ux/keyboard-map.md](./ux/keyboard-map.md)
- 规格：`CONVERSATION_FLOW_SPEC.md` §7.6
