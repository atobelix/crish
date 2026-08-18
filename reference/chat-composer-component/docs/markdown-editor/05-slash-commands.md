# 05 — Slash / 顿号命令面板

> **状态**：设计稿 v1  
> **路径**：`docs/markdown-editor/05-slash-commands.md`  
> **关联 UX 文案与空态**：[ux/slash-palette.md](./ux/slash-palette.md)  
> **依赖（占位）**：[01-architecture.md](./01-architecture.md) 块模型与编辑会话；[02-block-catalog.md](./02-block-catalog.md) 块类型与序列化；[03-line-renderer.md](./03-line-renderer.md) 块编辑态光标；[06-extensions.md](./06-extensions.md) 扩展注册；[07-visual-system.md](./07-visual-system.md) 浮层 token  
> **实现规划路径**：`js/markdown-editor/slash/`、`css/markdown-editor/slash-palette.css`

---

## 1. 目标

提供与 Notion 同构的 **块插入 / 块类型转换** 命令面板：

| 触发字符 | 说明 |
|----------|------|
| `/` | 国际通用 slash menu |
| `、` | 中文顿号；中文 IME 与产品习惯（见 §3） |

两者打开 **同一套** 面板、同一套命令注册表、同一套键盘与 a11y 行为。

用户价值：

1. 空段落或不想记 Markdown 前缀时，用菜单选「标题 / 表格 / 任务…」。
2. 中文输入法下不必切回英文再敲 `/`（顿号在多数中文键盘布局可直接出）。
3. 扩展与宿主可 `registerSlashCommand` / 块注册表 `slash` 字段挂命令，不改核心 if-else。

---

## 2. 非目标

| 非目标 | 说明 |
|--------|------|
| 行内提及菜单 | `@` mention 另规格（见 extensions）；不与 slash 共用触发 |
| AI 生成式补全 | 面板 v1 不做「继续写」「改写」类生成入口（可 P3 扩展 section） |
| 全量命令搜索引擎 | 不做 fuzzy 权重调优后端；v1 子串 + 可选拼音 |
| 表格单元格内算法 | 建表默认尺寸与插入块即可；合并单元格见 catalog |
| 协同光标下的多用户面板 | 非 v1 |
| 替换全局应用启动器 | 仅文档块编辑上下文 |

---

## 3. 为何支持 `、`（顿号）

### 3.1 产品与 IME 现实

- 中文用户长时间处于中文 IME；敲 `/` 常需先切英文或依赖 IME 的半角标点模式。
- 顿号 `、`（U+3001）在中文标点布局中易得，且在「空行起手」语境下 **几乎不会** 被当作正文语义使用。
- 对标中文协作产品习惯：部分产品用 `、` / `／` 打开块菜单；Conex 选 **`/` + `、`** 双触发，降低学习成本。

### 3.2 与枚举写法 `1、` 的消歧

中文常见有序列举：

```text
1、第一点
2、第二点
```

**消歧规则（硬）**：

| 条件 | 是否打开面板 |
|------|----------------|
| 块文本在触发前为 **空**，或光标前仅有 **空白**（space / tab / 全角空格），再输入 `/` 或 `、` | **打开** |
| 光标前已有非空白字符（含数字 `1`、字母、汉字、`*` 等）后输入 `、` | **不打开**，当作普通字符插入 |
| 已是有序列表块且输入 `、` | 默认当正文；不打开（列表块有独立续行逻辑，见 catalog） |
| 触发后查询串中继续输入 | 保持打开；过滤列表 |

推荐实现判定（伪代码）：

```ts
function canOpenSlashPalette(blockText: string, caretOffset: number, trigger: '/' | '、'): boolean {
  // 只看「触发字符之前」的文本
  const before = blockText.slice(0, caretOffset);
  // 空块，或 before 全是空白
  if (before.length === 0) return true;
  return /^\s*$/.test(before);
}
```

> **产品句**：`、` 只在「行首 / 仅空白之后」生效；`1、` 永远不会误开面板。

---

## 4. 触发与取消规则

### 4.1 打开条件（全部满足）

1. 当前块处于 **编辑态**（paragraph / 可转换的纯文本块优先；见 §8）。
2. 用户输入触发字符 `trigger ∈ {'/', '、'}`。
3. `canOpenSlashPalette(text, offsetBeforeTrigger, trigger) === true`  
   （offset 指插入触发字 **之前** 的位置）。
4. 块类型在 `slashEligible` 白名单内（v1：`paragraph`、空的 heading 可转换；代码块 **内部** 默认不触发，除非配置 `allowSlashInCode: false` 固定关闭）。
5. 文档只读 / 禁用编辑时不打开。

### 4.2 触发后状态

打开时记录：

```ts
interface SlashSession {
  blockId: string;
  trigger: '/' | '、';
  /** 触发字符在块文本中的起始 offset（删除时用） */
  triggerStart: number;
  /** 查询串 = 触发字符之后到光标的文本，不含 trigger 本身 */
  query: string;
  activeIndex: number; // 当前高亮项，默认 0
  openAt: number;      // performance.now()，埋点可选
}
```

- 触发字符 **保留在文档中** 直到命令执行或会话取消（Notion 同款：用户看得见 `/` 或 `、`）。
- 查询串：用户在触发后继续输入的过滤文本；**不**把 trigger 算进 query。

### 4.3 关闭 / 取消

| 动作 | 结果 |
|------|------|
| `Esc` | 关闭面板；**删除触发字符 + query**（恢复打开前文本）；焦点回编辑块 |
| `Backspace` 且 query 已空且光标紧贴 trigger 右侧 | 删除 trigger；关闭面板 |
| `Backspace` 删到 query 变空但仍保留 trigger | 面板保持打开，显示全量命令 |
| 点击面板外（mousedown outside） | 同 Esc：**撤销** trigger+query |
| 执行某条命令（Enter / 点击） | 关闭；**删除** trigger+query；再 `run(ctx)` |
| 光标移出当前块 / 失焦到非面板 | 关闭并撤销 trigger+query（与 outside 一致） |
| 输入空格且 query 为空？（可选） | **v1 不关**；空格进入 query（过滤「 」通常无结果）。若产品要「空格确认」则 P2 |
| 与 Markdown 自动格式冲突 | 见 §11 |

**原则**：取消路径 **不留下** 半截 `/xxx` 或 `、xxx` 污染正文（除非用户明确用某种「保留为字面量」快捷——v1 不做；用户若要字面 `/`，在非行首位置输入即可）。

### 4.4 状态机

```text
                    输入 / 或 、 且 canOpen
  [Idle] ─────────────────────────────────► [Open]
    ▲                                        │
    │  Esc / outside / 失焦 / 成功 run        │ 输入字符 → 更新 query、过滤
    │  Backspace 删掉 trigger                 │ ↑↓ 改 activeIndex
    │                                        │ Enter / 点击 → run → Idle
    └────────────────────────────────────────┘
```

非法转移：只读文档、非 eligible 块 → 保持 Idle，字符正常插入。

---

## 5. 命令注册表 Schema

### 5.1 类型草稿

```ts
/** 面板分组；顺序即 UI 默认 section 顺序 */
type SlashSectionId =
  | 'basic'      // 基础
  | 'list'       // 列表
  | 'media'      // 媒体
  | 'advanced'   // 高级
  | string;      // 扩展可注册自定义 section

interface SlashSectionMeta {
  id: SlashSectionId;
  /** 展示标题，中文 */
  title: string;
  /** 排序权重，小在前；内置：basic=10, list=20, media=30, advanced=40 */
  order: number;
}

interface SlashRunContext {
  editor: MarkdownEditorHandle; // 见 architecture
  blockId: string;
  /** 打开时的块快照（类型、文本、props） */
  sourceBlock: BlockSnapshot;
  /** 触发字符 */
  trigger: '/' | '、';
  /** 过滤用查询串（不含 trigger） */
  query: string;
  /** 删除 trigger+query 后的文本残留（通常为空段） */
  remainingText: string;
  /** 事务：应包在单一 undo step */
  tr: Transaction;
}

interface SlashCommand {
  /** 稳定 id，扩展勿撞车：建议 `core.heading1` / `ext.foo.bar` */
  id: string;
  /** 主标题（中文优先展示） */
  title: string;
  /** 同义显示名；参与过滤，不单独占行 */
  aliases: string[];
  /** 额外检索词（英文、拼音碎片、内部代号） */
  keywords: string[];
  /** 图标名或组件 key；映射到 visual system icon set */
  icon: string;
  section: SlashSectionId;
  /**
   * 是否在当前上下文显示；默认 true。
   * 例：仅空文档显示「从模板」；代码块内隐藏表格等。
   */
  when?: (ctx: Pick<SlashRunContext, 'editor' | 'sourceBlock'>) => boolean;
  /** 执行；必须幂等友好；抛错由面板 toast/console */
  run: (ctx: SlashRunContext) => void | Promise<void>;
  /** 可选：列表右侧快捷说明，如「⌘⌥1」 */
  shortcutHint?: string;
  /** 可选：排序 boost，越大越靠前（同分按 title） */
  priority?: number;
  /** 扩展来源；core 为空 */
  source?: string;
}

interface SlashRegistry {
  sections: Map<SlashSectionId, SlashSectionMeta>;
  commands: Map<string, SlashCommand>;
  registerSection(meta: SlashSectionMeta): void;
  registerCommand(cmd: SlashCommand): void;
  unregisterCommand(id: string): void;
  listVisible(ctx: Pick<SlashRunContext, 'editor' | 'sourceBlock'>): SlashCommand[];
}
```

### 5.2 与块注册表的关系

块类型可声明默认 slash 元数据，引擎启动时折叠进 `SlashRegistry`：

```ts
registerBlockType({
  type: 'heading',
  // ...
  slash: [
    {
      id: 'core.heading1',
      title: '标题 1',
      aliases: ['h1', '一级标题'],
      keywords: ['heading', 'title'],
      icon: 'heading-1',
      section: 'basic',
      run: (ctx) => convertOrReplace(ctx, { type: 'heading', level: 1 }),
    },
    // ...
  ],
});
```

也支持 **无对应块** 的命令（如「分割线」一次插入后光标落到下一段；或打开文件选择器）。

### 5.3 扩展 API

```ts
// 宿主 / 插件
editor.slash.registerSection({
  id: 'conex',
  title: 'Conex',
  order: 50,
});

editor.slash.registerCommand({
  id: 'conex.insert-skill-ref',
  title: '插入 Skill 引用',
  aliases: ['skill'],
  keywords: ['技能', 'skill'],
  icon: 'puzzle',
  section: 'conex',
  when: (ctx) => ctx.editor.features.skills === true,
  run: async (ctx) => { /* 打开选择器或插入 embed 块 */ },
});

// 卸载
editor.slash.unregisterCommand('conex.insert-skill-ref');
```

约束：

- `id` 冲突：后注册 **覆盖** 并 `console.warn`（dev）；生产可配置 `strict: true` 抛错。
- `run` 内必须使用 `ctx.tr` 合并 undo；禁止绕过事务直接改 DOM。
- 异步 `run`：面板先关并清 trigger；显示块级 loading 由命令自己处理（v1 表格/本地命令皆同步）。

---

## 6. v1 完整命令列表

展示 **中文 title**；`id` 为实现键。默认全部 `when: always`（除非注明）。

### 6.1 基础 `basic`

| id | title | aliases（节选） | keywords（节选） | icon | 行为摘要 |
|----|-------|-----------------|------------------|------|----------|
| `core.paragraph` | 正文 | 段落, text, p | paragraph, body | `text` | 转为 paragraph |
| `core.heading1` | 标题 1 | h1, 一级标题 | heading, title | `heading-1` | heading level=1 |
| `core.heading2` | 标题 2 | h2, 二级标题 | heading | `heading-2` | heading level=2 |
| `core.heading3` | 标题 3 | h3, 三级标题 | heading | `heading-3` | heading level=3 |
| `core.quote` | 引用 | 引用块, quote | blockquote | `quote` | blockquote |
| `core.code-block` | 代码块 | code, 代码 | fence, pre | `code` | code_block；语言 plain |
| `core.divider` | 分割线 | 分隔线, hr | thematic, line | `minus` | 插入 hr，下方新建空段并聚焦 |
| `core.callout` | 高亮 | callout, 提示, 标注 | highlight, admonition | `callout` | callout 默认 info（见 extensions） |

### 6.2 列表 `list`

| id | title | aliases | keywords | icon | 行为摘要 |
|----|-------|---------|----------|------|----------|
| `core.bullet-list` | 无序列表 | 项目符号, ul, bullet | unordered | `list` | bullet_list_item |
| `core.numbered-list` | 有序列表 | 数字列表, ol, numbered | ordered | `list-ordered` | ordered_list_item |
| `core.todo-list` | 任务列表 | 待办, todo, task, checkbox | checklist | `check-square` | task_item unchecked |

### 6.3 媒体 `media`

| id | title | aliases | keywords | icon | 行为摘要 |
|----|-------|---------|----------|------|----------|
| `core.table` | 表格 | table, 表 | grid | `table` | 插入默认表（§9） |
| `core.image` | 图片 | image, img, 图像 | picture | `image` | 打开本地/URL 插入流（宿主能力）；无能力时降级为占位图块 |
| `core.file` | 附件 | file, 文件 | attachment | `paperclip` | 附件块占位（Notebook 能力门控） |
| `core.embed` | 嵌入 | embed, 链接卡片 | bookmark | `link-2` | 链接嵌入块；可先插空再填 URL |

> 媒体类 `when`：宿主 `features.media === false` 时隐藏 `image` / `file`。

### 6.4 高级 `advanced`

| id | title | aliases | keywords | icon | 行为摘要 |
|----|-------|---------|----------|------|----------|
| `core.toggle` | 折叠块 | toggle, 折叠, 详情 | details, disclosure | `chevron-right` | details/summary 块（若 catalog 收录） |
| `core.math-block` | 公式块 | math, latex, 公式 | equation | `function` | 块级公式（扩展门控） |
| `core.mermaid` | 图表 | mermaid, 流程图 | diagram | `git-branch` | mermaid 代码块变体或专用块 |
| `core.template-empty` | 清空为空白页 | 空白 | clear | `trash` | **危险**；`when` 仅调试/可选，v1 可 **不进默认列表** |

v1 **必交付**（DoD）：基础全部 + 列表全部 + `表格` + `分割线` + `高亮` + `代码块`。  
媒体其余与高级：按宿主能力与 catalog 分期（见 roadmap）。

### 6.5 可扩展约定

- 新块在 catalog 落地时 **必须** 附带至少一条 slash（或显式 `slash: []` 说明不进面板）。
- 自定义 section 标题保持 2–6 字中文；order ≥ 50 以免插入内置组中间造成跳动。

---

## 7. 过滤逻辑

### 7.1 v1（P0）

```ts
function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function matchesCommand(cmd: SlashCommand, query: string): boolean {
  if (!query) return true;
  const q = normalize(query);
  const pool = [cmd.title, ...cmd.aliases, ...cmd.keywords, cmd.id];
  return pool.some((p) => normalize(p).includes(q));
}
```

规则：

1. `query === ''` → 显示全部 `when` 通过的命令，按 section.order → priority → title 排序。
2. 非空 → 过滤；**空 section 不渲染标题**。
3. 过滤后 `activeIndex` 钳制到 `[0, filtered.length)`；若长度为 0 → 无结果态（见 UX 文）。
4. **子串** 即可；不要求前缀匹配（「题」可命中「标题 1」）。

### 7.2 拼音（P2，可选）

- 对 `title` + `aliases` 建懒缓存：全拼与首字母（`bt` → 标题可考虑扩展词表）。
- 库选型参考：`pinyin-pro` 等；**勿**打进热路径全量重算——注册时或首次打开预热。
- 开关：`editor.options.slashPinyin === true`（中文产品默认可开）。

### 7.3 排序

```text
1. section.order 升序
2. 同 section 内：priority 降序
3. title localeCompare('zh-CN')
```

过滤命中时 **不** 把 section 打散成纯相关度列表（v1 保分组，降低迷失）；P3 可加「最佳匹配」置顶条。

---

## 8. 插入 / 转换行为

### 8.1 统一流程

```text
1. 校验 session 仍有效（block 仍在、仍编辑态）
2. 在同一 Transaction 内：
   a. 删除 [triggerStart, triggerStart + 1 + query.length)
   b. remainingText = 删除后的块纯文本（通常 ""）
   c. 调用 cmd.run(ctx)
3. 关闭面板；焦点由 run 决定（默认新块/转换块可编辑起点）
4. 记一条 undo（整次 = 一次撤销回到「打开 slash 前」）
```

### 8.2 空块 → 替换类型

当源块为 **空 paragraph**（或仅曾含 trigger+query）：

- `convertBlock(blockId, nextType, props)`：原地改 type，保留 blockId（利于协作预留与 DOM 稳定）。
- 分割线例外：插入 `divider` **之后** 再 `insertBlockAfter` 一个空 paragraph 并聚焦（Notion 同款）。

### 8.3 非空段落 → 转换或拆分

| 场景 | v1 行为 |
|------|---------|
| 块仅有 trigger+query，无其它字 | 等同空块替换 |
| 块在 trigger **之前** 仅有空白 | 去掉空白后替换类型 |
| 块在 trigger 前有正文（本不应打开；防御） | 关闭并撤销 trigger+query，不转换 |
| 列表项内触发 | 转换 **当前 list item** 类型（如变 todo），不拆 list 容器算法（容器由 model 规范化） |

### 8.4 `run` 辅助（引擎提供）

```ts
function convertOrReplace(ctx: SlashRunContext, next: { type: string; props?: object }) {
  ctx.tr.convertBlock(ctx.blockId, next);
  ctx.tr.setCaret(ctx.blockId, 'start');
}

function insertDivider(ctx: SlashRunContext) {
  ctx.tr.convertBlock(ctx.blockId, { type: 'divider' });
  const id = ctx.tr.insertBlockAfter(ctx.blockId, { type: 'paragraph', text: '' });
  ctx.tr.setCaret(id, 'start');
}
```

---

## 9. 表格插入默认

**v1 默认：3 列 × 3 行，首行为表头。**

语义化：

| 维度 | 值 |
|------|-----|
| columns | 3 |
| body rows | 2（加表头共 3 行视觉行） |
| header row | 是 |
| 单元格初始 | 空字符串 |
| 序列化 GFM | 标准 `\| --- \|` 分隔 |

```ts
function insertTable(ctx: SlashRunContext) {
  ctx.tr.convertBlock(ctx.blockId, {
    type: 'table',
    props: {
      cols: 3,
      rows: 3,          // 含 header
      hasHeader: true,
      cells: emptyMatrix(3, 3),
    },
  });
  // 焦点：表头第一格
  ctx.tr.setCaretTable(ctx.blockId, { r: 0, c: 0 });
}
```

- 用户改尺寸：表格块内 UI / 右键（catalog）；slash **不**做「5x5」二级菜单（P2 可加子面板）。
- 不在本文展开单元格编辑算法 → 见 [02-block-catalog.md](./02-block-catalog.md) / `blocks/table.md`。

---

## 10. 定位锚定（相对光标）

### 10.1 目标

浮层贴着 **触发字符处 caret**，优先下方；空间不足翻转到上方；水平不溢出视口。

### 10.2 算法

```text
1. rect = getCaretClientRect()  // 编辑器提供；fallback 当前块 content box 左下
2. palette 测量 width W, height H（先 visibility 测量或上次缓存）
3. left = clamp(rect.left, pad, viewportW - W - pad)
4. preferBelow = rect.bottom + gap + H <= viewportH - pad
5. top = preferBelow ? rect.bottom + gap : rect.top - gap - H
6. 若仍溢出，top 再 clamp；max-height 收缩以保在视口内
```

常量建议：

| token | 值 |
|-------|-----|
| `gap` | 6px |
| `pad` | 8px |
| `max-height` | min(320px, 50vh) |
| `min-width` | 220px |
| `width` | 280px（可随内容 240–320） |

滚动：

- 监听 **捕获阶段** `scroll`（含编辑器内部 scroller）→ `reposition()`。
- `visualViewport` resize（移动端键盘）→ `reposition()`。

### 10.3 DOM 挂载

- **默认** portal 到 `document.body`（避免 `overflow: hidden` 裁剪）。
- 标记 `data-conex-slash-palette="1"`，outside-click 忽略面板内部。

---

## 11. 与 Markdown 自动格式的冲突

常见自动格式：

| 输入 | 自动结果 |
|------|----------|
| `# ` / `## ` / `### ` 后空格 | 转 heading |
| `- ` / `* ` / `1. ` | 转列表 |
| ` ``` ` | 代码块 |
| `---` 独占行 | 分割线 |
| `[] ` / `[ ] ` | 任务 |

### 11.1 冲突点

用户可能在空行输入 `/` 打开面板，再输入 `##` 想搜标题——query 为 `##`，**不应**在 query 编辑过程中触发「`## ` 转标题」自动格式。

### 11.2 规则（硬）

1. **`SlashSession` 活跃期间**：当前块 **关闭** Markdown input rule / 空格触发的 block 转换。
2. 会话结束后（取消或执行）再恢复 input rules。
3. 若用户 **未** 打开面板，在空段输入 `## ` → 仍走自动格式（与 slash 无关）。
4. 自动格式与 slash **目标重叠**（都是建标题）：保留两者；熟练用户用 MD，探索型用户用面板。
5. 输入 `/` 本身 **不是** Markdown 语法 → 无 input rule 吞掉。

伪代码：

```ts
inputRules.enabled = () => !editor.slash.isOpen();
```

---

## 12. 面板 UI 规格

### 12.1 结构

```
┌─ .conex-slash-palette  role="listbox" ─────────────┐
│  [可选] .conex-slash-palette__query-echo          │
│  .conex-slash-palette__scroll                     │
│    .conex-slash-palette__section                  │
│      .conex-slash-palette__section-title          │
│      .conex-slash-palette__item  role="option"    │
│        .conex-slash-palette__icon                 │
│        .conex-slash-palette__label                │
│        .conex-slash-palette__hint                 │
│    …                                              │
│  .conex-slash-palette__empty   (条件)             │
└───────────────────────────────────────────────────┘
```

### 12.2 交互

| 输入 | 行为 |
|------|------|
| `ArrowDown` / `ArrowUp` | 移动 `activeIndex`，循环可选（v1：**不**循环，到顶/底停止） |
| `Enter` | 激活当前项 |
| `Tab` | v1：等同 ArrowDown（或关闭并不抢焦点——**推荐** Tab 关闭并撤销，避免陷阱；见 a11y） |
| 鼠标 hover | 更新 activeIndex（不抢焦点出编辑器） |
| 鼠标 click | 执行该项 |
| 滚轮 | 仅滚动列表区域 |

焦点模型：

- **焦点保留在编辑器**（contenteditable / textarea 块）。
- 面板用 `aria-activedescendant` 指向 option id，**不**把 DOM focus 移进 listbox（减少 IME 打断）。
- 编辑器根：`aria-controls={paletteId}` + `aria-expanded="true"`。

### 12.3 视觉契约（class）

| class | 职责 |
|-------|------|
| `conex-slash-palette` | 浮层容器；surface 背景、边框、阴影（克制，对齐 Composer） |
| `conex-slash-palette--placement-above` | 翻转到上方时修饰 |
| `conex-slash-palette__scroll` | `max-height` + `overflow-y: auto` |
| `conex-slash-palette__section-title` | 分组标签；小字号、次级色 |
| `conex-slash-palette__item` | 行高 ~32–36px；hover/active 同一浅底 |
| `conex-slash-palette__item--active` | 键盘/hover 高亮 |
| `conex-slash-palette__empty` | 无结果 |

动效：仅 `opacity` 80–120ms；**禁止**大位移弹跳（对话流禁令一致）。

### 12.4 Section 中文标题

| id | 展示 |
|----|------|
| `basic` | 基础 |
| `list` | 列表 |
| `media` | 媒体 |
| `advanced` | 高级 |

---

## 13. 无障碍（listbox 模式）

遵循 WAI-ARIA **Combobox / Listbox** 精简版（焦点在文本输入、列表只读示意）：

```html
<!-- 编辑中的块控制件 -->
<div
  role="combobox"
  aria-haspopup="listbox"
  aria-expanded="true"
  aria-controls="conex-slash-listbox"
  aria-activedescendant="conex-slash-opt-3"
  …>
  …块编辑器…
</div>

<ul id="conex-slash-listbox" role="listbox" aria-label="插入块">
  <li role="presentation" class="…section-title">基础</li>
  <li role="option" id="conex-slash-opt-0" aria-selected="false">…</li>
  <li role="option" id="conex-slash-opt-3" aria-selected="true">…</li>
</ul>
```

要求：

1. 每个 option 有稳定 `id`（index 或 command.id slug）。
2. `aria-selected` 与 `--active` 同步。
3. 无结果时 `listbox` 仍在，内嵌 `role="status"` 提示文案（见 UX）。
4. 屏幕阅读器：打开时 `aria-live="polite"` 播报「N 个命令」可选（勿刷屏：仅 open / query debounce 300ms）。
5. 高对比：active 态不单靠颜色（左侧 2px 指示条或加粗 title）。
6. 减少动效：遵循 `prefers-reduced-motion`。

**Tab 策略（v1 决议）**：`Tab` / `Shift+Tab` → 取消会话（删 trigger+query）并让浏览器默认焦点移动，**避免**焦点陷阱。方向键只在面板打开时拦截。

---

## 14. 移动端考虑

| 议题 | v1 策略 |
|------|---------|
| 触控无 hover | 依赖 tap 高亮+执行；可 tap 行即执行（不必先选中再点） |
| 软键盘挤压视口 | 用 `visualViewport` 定位；优先放在 caret **上方** 以免被键盘挡住 |
| 面板高度 | `max-height: min(280px, 40vh)` 更保守 |
| 触发字符 | 移动端中文 IME 仍支持 `、`；`/` 在部分键盘需符号页 |
| 误触 outside | 首次打开忽略 300ms 内的合成 click（iOS 焦点怪癖） |
| 拖拽滚动 | 面板内 touchmove stopPropagation，避免背后文档滚走 |
| 只读预览手机 | 不进编辑态则无 slash |

P2：底部 sheet 式命令列表（超小屏 `<360px` 宽）替代浮动。

---

## 15. ASCII 线框

### 15.1 默认打开（空 query）

```text
  空段落中的光标
  、|
  ┌──────────────────────────────┐
  │ 基础                         │
  │  ┌────────────────────────┐  │
  │  │ Ｔ  正文               │  │  ← active
  │  │ Ｈ  标题 1             │  │
  │  │ Ｈ  标题 2             │  │
  │  │ Ｈ  标题 3             │  │
  │  │ “  引用                │  │
  │  │ </> 代码块             │  │
  │  │ ─  分割线              │  │
  │  │ 💡 高亮                │  │
  │  └────────────────────────┘  │
  │ 列表                         │
  │    •  无序列表               │
  │    1. 有序列表               │
  │    ☑  任务列表               │
  │ 媒体                         │
  │    ▦  表格                   │
  │    …                         │
  │ 高级                         │
  │    …                         │
  └──────────────────────────────┘
         ▲ max-height 内滚动
```

### 15.2 过滤「标」

```text
  /标|
  ┌──────────────────────────────┐
  │ 基础                         │
  │    Ｈ  标题 1                │
  │    Ｈ  标题 2   ← active     │
  │    Ｈ  标题 3                │
  └──────────────────────────────┘
```

### 15.3 无结果

```text
  /xyznotfound|
  ┌──────────────────────────────┐
  │  未找到相关命令               │
  │  试试「标题」「表格」「任务」  │
  └──────────────────────────────┘
```

文案定稿见 [ux/slash-palette.md](./ux/slash-palette.md)。

---

## 16. 边界情况

| 场景 | 处理 |
|------|------|
| 极速连按 `/` | 仅第一字符可开；query 含第二个 `/` 当过滤字 |
| 组成中 IME（isComposing） | **组成结束** 后再判定触发；组成中的 `、` 候选不提前开面板 |
| 撤销 Undo | 一次撤销恢复到 slash 打开前（含关闭面板） |
| 块在打开时被协作删除 | 关面板；无崩溃 |
| 命令 `run` 抛错 | 面板已关；`console.error` + 可选 toast；尽量 rollback tr |
| 超长命令表（100+） | 虚拟列表可选；v1 section 少，DOM 全量可接受 |
| 只读块 / 锁 | 不打开 |
| `when` 全 false | 不打开或打开即 empty——**不打开** 并插入字面触发符 |

---

## 17. 模块划分（实现草图）

```text
js/markdown-editor/slash/
  registry.ts       # SlashRegistry
  session.ts        # 状态机 open/update/close
  filter.ts         # matches + sort
  positioning.ts    # caret rect + clamp
  palette-view.ts   # DOM 渲染 / 事件
  commands/core.ts  # v1 内置命令 run 实现
  input-bridge.ts   # 与编辑器 beforeInput / keydown 对接
```

公开句柄：

```ts
interface SlashController {
  isOpen(): boolean;
  getSession(): SlashSession | null;
  registerCommand(cmd: SlashCommand): void;
  unregisterCommand(id: string): void;
  registerSection(meta: SlashSectionMeta): void;
  /** 测试/调试 */
  openForTest(blockId: string, trigger: '/' | '、'): void;
}
```

---

## 18. 测试用例

### 18.1 触发

| # | 步骤 | 期望 |
|---|------|------|
| T1 | 空 paragraph 输入 `/` | 面板开；session.trigger=`/` |
| T2 | 空 paragraph 输入 `、` | 面板开；trigger=`、` |
| T3 | 文本 `hello` 后输入 `、` | 面板 **不开**；正文为 `hello、` |
| T4 | 仅空格后输入 `/` | 面板开 |
| T5 | `1` 后输入 `、` | 不开（枚举消歧） |
| T6 | IME composing 中 | 组成提交后再判定 |

### 18.2 取消

| # | 步骤 | 期望 |
|---|------|------|
| C1 | 打开后 Esc | 面板关；块空；无 `/` |
| C2 | 打开后输入 `ab` 再 Esc | 无 `/ab` 残留 |
| C3 | 打开后 Backspace | 删 `/`，关闭 |
| C4 | outside mousedown | 同 Esc |
| C5 | 打开后输入 query 再 Backspace 清空 query | 面板仍开 |

### 18.3 过滤与键盘

| # | 步骤 | 期望 |
|---|------|------|
| F1 | query=`标题` | 仅标题 1–3（及 alias 命中） |
| F2 | query=`h1` | 命中 标题 1 |
| F3 | query=`表格` | 命中表格 |
| F4 | ↓↓ Enter | 执行第 3 项 |
| F5 | 无结果时 Enter | 无操作或 no-op；不关？**v1：不执行，保持开** |

### 18.4 插入

| # | 步骤 | 期望 |
|---|------|------|
| I1 | 选「标题 1」 | 块 type=heading level=1；无 trigger 残留；caret 在标题内 |
| I2 | 选「表格」 | 3×3 含表头；焦点 (0,0) |
| I3 | 选「分割线」 | divider + 下方空段聚焦 |
| I4 | 选「任务列表」 | task item unchecked |
| I5 | Undo 一次 | 回到打开 slash 前空段 |

### 18.5 冲突与扩展

| # | 步骤 | 期望 |
|---|------|------|
| X1 | 面板打开时输入 `## ` | **不**自动转标题 |
| X2 | 无面板时 `## ` | 转标题 |
| X3 | `registerCommand` 后打开 | 列表可见新命令 |
| X4 | `when` 返回 false | 不可见 |
| X5 | 代码块内输入 `/` | 不开（默认） |

### 18.6 a11y / 移动

| # | 步骤 | 期望 |
|---|------|------|
| A1 | 打开后 | `aria-expanded=true`，activedescendant 有值 |
| A2 | ↓ | activedescendant 更新 |
| A3 | Tab | 取消会话，焦点可移出 |
| M1 | visualViewport 变化 | 面板仍在视口内 |

---

## 19. 分期

| 阶段 | 内容 |
|------|------|
| **P0** | 双触发、状态机、核心过滤、基础+列表+表格+分割线+代码+引用+高亮、定位、Esc/Backspace、input rules 互斥、listbox a11y 基础、单测 T/C/F/I/X 主路径 |
| **P1** | 媒体命令与宿主门控、扩展 API 稳定、outside-click 完善、滚动跟随、移动端 viewport |
| **P2** | 拼音、表格尺寸子菜单、小屏 bottom sheet、live region 防抖播报 |
| **P3** | 相关度置顶、AI section、命令使用频率排序 |

---

## 20. 验收 DoD（本专题）

- [ ] `/` 与 `、` 打开同一面板  
- [ ] `1、` 不误触  
- [ ] Esc / outside 不残留触发串  
- [ ] 空块转换与表格 3×3 表头正确  
- [ ] 打开期间 `## ` 不触发 MD 自动格式  
- [ ] 键盘 ↑↓ Enter + 鼠标可用  
- [ ] `registerCommand` 扩展路径可演示  
- [ ] a11y：expanded / activedescendant / option  
- [ ] 中文文案与 [ux/slash-palette.md](./ux/slash-palette.md) 一致  
- [ ] UTF-8 无乱码  

---

## 21. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 首稿：双触发、注册表、v1 命令、过滤、表格默认、a11y、测试与分期 |
