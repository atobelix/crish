# 工具卡片排版规范化、内边距对齐与描边分隔深度分析报告

> 战役工作区：`docs/tool-experience-and-sandbox-repair/`  
> 责任席位：子 Agent A3（Tool Card Layout Designer）  
> 调研目标：彻底排查工具调用展开卡片的排版布局、边框系统、内边距对齐及交互按钮降噪问题，提供精确到 CSS/DOM 级别的重构方案。

---

## 一、用户与视觉诉求穿透

用户在实际体验中直接指出了工具调用展开界面的核心视觉痛点：
> **“对于这个展开的内容，可以外层和分隔出加上一个描边，然后规范化一下排版，以及避免噪音吧。”**

结合现场代码与渲染形态，这一反馈直指当前展开卡片的三大严重体验断层：
1. **外层边界模糊，缺乏物理容器感**：展开卡片仅有底色 `var(--surface-raised)`，在浅色/深色主题的多层容器嵌套中缺乏细腻的微描边定义，边缘软化发虚，与上下消息缺乏明确的卡片式闭合感。
2. **内边距严重错位，形成“锯齿梯田”**：命令行输入行（`$ ...`）左右内边距为 0，紧贴卡片边缘；而紧接其后的输出面板左右内边距为 18px。输入端文字与输出端文字左右错位 18px，右侧操作按钮同样左右错位 18px。
3. **多余空 Header 与重复“复制”按钮造成视觉噪音与垂直留白**：
   - 命令行右侧有一个“复制”按钮（复制命令），紧接着输出区又渲染了一个高度占满的独立 `<header>`，左侧毫无文字内容（产生 30-40px 的大面积垂直留白），右侧又悬挂一个同样叫“复制”的按钮（复制输出）。
   - 用户同时看到两个一模一样叫“复制”的按钮，位置一外一内，左侧空荡，界面如同排版 Bug。

---

## 二、现行实现与样式冲突逐行深度审计

排查涉及源码：
- `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`
- `apps/crish-desktop/src/components/chat-tool-call/ToolCallInputPane.tsx`
- `apps/crish-desktop/src/components/chat-tool-call/ToolCallOutputPane.tsx`
- `apps/crish-desktop/src/components/chat-tool-call/ToolCallOutput.tsx`

### 1. 内边距破坏点：`.toolSectionShellSingleLine` 破坏水平基准线

在 `ChatToolCallBlock.module.css:578-589` 中，基础 section 的设计初衷原本是非常严谨的：
```css
/* Tool Sections */
.toolSection {
  display: flex;
  flex-direction: column;
  background: transparent;
  border: none;
  border-radius: 0;
  overflow: hidden;
  width: 100%;
  box-sizing: border-box;
  /* D7：横向 18px 与行头文本基线对齐（图标槽 12 + gap 6），上下维持 */
  padding: 4px 18px 6px;
}
```
**设计本意**：行头（`CompactToolRow`）的图标槽宽度是 12px，间距 gap 是 6px，因此 `12 + 6 = 18px`，18px 恰好是内容区文本与折叠行首字完美对齐的视觉基线。

然而，在 `ChatToolCallBlock.module.css:761-763` 中，却横空插入了一段破坏性覆盖：
```css
/* CLI Shell */
.toolSectionShellSingleLine {
  padding: 4px 0;
}
```
并且在 `ToolCallInputPane.tsx:96-100` 中挂载到了 Shell 输入区域：
```tsx
<section
  className={`${styles.toolSection} ${styles.toolSectionInput} ${styles.toolSectionShellSingleLine}`}
  aria-label="终端命令输入"
  data-tool-id={toolId}
>
```
**冲突后果**：
- 输入区（`$ echo "hello"`）：左右 padding 被覆写为 `0`，`$` 符号直接死死抵在容器左边缘，右侧复制按钮死死贴在右边缘。
- 输出区（`hello`）：未被此样式覆盖，保持 `padding: 4px 18px 6px`。
- **视觉断层**：上下两层在同一个圆角卡片内部，左边缘错位 18px，右边缘错位 18px，如同抽屉错位没合拢。

---

### 2. 容器描边与分隔线缺失审计

#### (1) 外层容器缺少 Border
查看 `ChatToolCallBlock.module.css:558-570`：
```css
/* Tool Result Body (Unified Rounded Rectangle Container) */
.toolResultBody {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  background: var(--surface-raised);
  border-radius: var(--radius-lg);
  margin: 2px 0 4px 0;
  box-sizing: border-box;
  overflow: hidden;
  position: relative;
  box-shadow: none;
}
```
- 外层 `.toolResultBody` 仅有 `background: var(--surface-raised)`，**完全没有设置任何 `border`**。
- 在很多背景色与 `--surface-raised` 接近的主题（如暗色浅灰或纯黑主题模式）下，卡片轮廓几乎不可见，无法给用户明确的“这是一个结构化独立卡片”的视觉边界心理模型。

#### (2) 输入与输出之间缺少结构化 Divider
查看 `ChatToolCallBlock.module.css:591-598`：
```css
/*
 * 【用户裁决 · 2026-09-11】工具调用区块下方不得携带发丝分割线（影响排版）。
 * 输入面板与输出面板之间改由各自的内边距与面板标题承担视觉分隔，
 * 原 `border-bottom: 1px solid var(--border-subtle)` 已物理切除，禁止回潮。
 */
.toolSectionInput {
  border-bottom: none;
}
```
- 历史记录中，2026-09-11 曾经切除过 `border-bottom`，是因为旧版发丝线在旧排版中显得突兀。
- 但在彻底切除后，输入面板与输出面板直接使用完全相同的纯色背景拼接在一起，没有任何分隔媒介，导致命令和输出混成一团。
- 用户此次明确提出：**“可以外层和分隔出加上一个描边”**。外层卡片加柔和微描边、两段式内容之间加上精致的微描边分隔线（Divider），完全吻合当下的重构目标。

---

### 3. 空 Header 占位与双“复制”按钮冲突审计

#### (1) 空 Header 产生的根源
在 `ToolCallOutputPane.tsx:138-142`：
```tsx
// 仅在非单卡模式（有“输出”标签）或存在明确状态标记（执行失败/执行中）时才渲染独立 header 行
const showHeader = useMemo(() => {
  if (isError || isRunning) return true;
  if (!isSingleCard) return true;
  return false;
}, [isError, isRunning, isSingleCard]);
```
- 对于常见的命令执行类工具（如 `run_command`），`omitInput` 为 `false`，所以 `isSingleCard` 为 `false`。
- 这导致只要命令执行完成且成功（`!isError && !isRunning`），`showHeader` 依然**强制判定为 `true`**！
- 紧接着在 `ToolCallOutputPane.tsx:173-185` 渲染了：
```tsx
<header className={styles.toolSectionHeader}>
  <div className={styles.toolSectionTitleGroup}>
    <span className={styles.toolSectionMeta}>
      {isRunning ? (
        <span className={styles.runningTag}>执行中</span>
      ) : isError ? (
        <span className={styles.errorTag}>执行失败</span>
      ) : null}
      {!isSingleCard && metaExtra ? ` · ${metaExtra}` : ''}
      {!isSingleCard && durationStr ? ` · ${durationStr}` : ''}
    </span>
  </div>
  <div className={styles.toolSectionActions}>
    ...
    <Button ...>复制</Button>
  </div>
</header>
```
**严重缺陷剖析**：
- 当命令成功完成时：`isRunning` 为 null，`isError` 为 null；
- 对于普通的终端输出，`metaExtra` 为 `''`（无文件行数等结构化元数据）；
- 若执行极快（<0.1s），`durationStr` 也为 null；即时有耗时（如 `0.2s`），左侧也仅仅孤零零挂着一个小点 `· 0.2s`，根本没有任何标题。
- 这使得 `toolSectionTitleGroup` **几乎是一个彻底的空 DOM 容器**！
- 而 `.toolSectionHeader` 占据了 `min-height: 20px; margin-bottom: 2px;` 加上 section padding，在输入行下方硬生生制造了 30-40px 的大片空白空间。

#### (2) 两个一模一样的“复制”按钮混乱
- **输入端**（`ToolCallInputPane.tsx:142`）：
  ```tsx
  <Button ...>{copied ? '已复制' : '复制'}</Button>
  ```
- **输出端**（`ToolCallOutputPane.tsx:223`）：
  ```tsx
  <Button ...>{copied ? '已复制' : '复制'}</Button>
  ```
- **现场表现**：
  在同一个展开区块中，垂直相距不到 30px 的距离内，出现了两个外观、图标、文案完全一模一样的“复制”按钮！
  而且输入端的复制贴在最右（right: 0），输出端的复制缩进 18px（right: 18px）。
  用户无法直观理解：为什么有两个复制？哪个是复制命令？哪个是复制结果？为什么右边距不整齐？

---

## 三、卡片排版系统规范化重构设计

针对上述排查结果，我们设计了一套符合 Apple 人机工学与现代化 IDE 质感的排版、边框与内边距系统。

### 1. 统一内边距系统（Unified Horizontal Padding System）

```
+-------------------------------------------------------------+
| 折叠行首: [icon] (12px) + gap (6px) = 18px 基线             |
+-------------------------------------------------------------+
| 卡片外框 (border: 1px solid var(--border-subtle); R: 10px)  |
|                                                             |
|   |<- 18px ->|                                |<- 18px ->|  |
|   $ npm run test ----------------------------- [复制命令]   |
|                                                             |
|=================== 贯穿分隔线 (border-top) ===================|
|                                                             |
|   |<- 18px ->|                                |<- 18px ->|  |
|   [状态/耗时 0.4s] --------------------------- [复制输出]   |
|   PASS tests/unit/parser.test.ts                            |
|   Tests: 12 passed, 12 total                                |
|                                                             |
+-------------------------------------------------------------+
```

#### 规则规范：
1. **统一水平内边距**：
   - 彻底废除 `.toolSectionShellSingleLine` 中的 `padding: 4px 0`。
   - 所有 section（包括 Shell 单行输入区、常规参数输入区、输出内容区）的横向 padding **严格锁定为 18px**，与上方折叠行的首字基线绝对对齐。
2. **垂直内边距与呼吸节奏微调**：
   - 输入面板（Shell 命令）：`padding: 6px 18px;`（适度拉伸 2px 上下空间，给单行命令带来足够的点击与阅读呼吸感）。
   - 输出面板：`padding: 6px 18px 8px;`（底部留 8px 微间距，收紧与卡片底部的视觉关系）。
   - 单卡输出（如 `grep_search`、`read_file`）：`padding: 8px 18px 8px;`。

---

### 2. 边框与微描边规范（Border & Divider System）

利用项目中已有的统一 Design Token：`--border-subtle`（浅色 `#f2f2f2`，深色 `#2e2e2e`）与 `--radius-lg`（10px）：

#### (1) 外层卡片边框规范
- 选择器：`.toolResultBody`
- 属性：
  ```css
  .toolResultBody {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-sizing: border-box;
    overflow: hidden;
    margin: 2px 0 4px 0;
  }
  ```
- **视觉收益**：给展开区域加上清晰、内敛、极其柔和的 1px 微描边，强化卡片独立性与层次感，无论在亮色还是暗色主题下均清晰可辨且不抢眼。

#### (2) 中间分隔线（Divider）规范
- 选择器：`.toolSectionOutput`（在多段式卡片中作为下半段）
- 属性：
  ```css
  /* 多段卡片输出面板：顶部贯穿发丝分割线 */
  .toolSectionOutput {
    border-top: 1px solid var(--border-subtle);
  }

  /* 单卡模式（DEC-GREP-OMIT: grep/read_file 等）无输入区，切除分隔线 */
  .toolResultBodySingle .toolSectionOutput {
    border-top: none;
  }
  ```
- **贯穿设计（Full Bleed）**：因为 `.toolResultBody` 左右 padding 为 0，而分割线直接作用在 `.toolSectionOutput` 的 `border-top` 上，因此分割线将优雅地贯穿卡片整个宽度（从左侧圆角一直延伸到右侧圆角），而内容则在 18px 内部对齐，呈现最高标准的工业级排版细节。

---

### 3. 操作区降噪与 Header 重构方案

#### (1) 根除空 Header 占位与垂直大空白
重构 `ToolCallOutputPane.tsx` 的 `showHeader` 逻辑：
**原则：绝不允许渲染左侧空无一物的整行 Header！**

现有逻辑问题在于：`!isSingleCard` 时不管有没有内容都强制 `showHeader = true`。
**改进判定逻辑**：
```tsx
const hasMeta = Boolean(metaExtra || durationStr);
const hasStatus = Boolean(isError || isRunning);

// 仅当确实有状态、有元数据、或者存在截断下载需要展示时，才展示独立的 Header 行
const showHeader = useMemo(() => {
  if (hasStatus) return true; // 执行中 / 失败 必须有状态头
  if (hasMeta && !isSingleCard) return true; // 有耗时、统计信息等
  if (isTruncated) return true; // 有日志下载按钮
  return false;
}, [hasStatus, hasMeta, isSingleCard, isTruncated]);
```
- **收益**：当 Shell 命令成功执行完毕且没有额外元数据（极快命令，或纯文本输出）时，不会多占出一整行 30px 空白，输出文本紧随分隔线下方自然展开！

#### (2) 双“复制”按钮语义化与视觉差异化消除混淆
对输入区与输出区的复制操作进行职责明晰化与文案差异化：

| 位置 | 复制对象 | 推荐文案 | 推荐 Tooltip | 推荐交互形态 |
|---|---|---|---|---|
| **输入区（Shell 命令行）** | 命令行字符串 | **复制命令**（或仅图标按钮） | 复制完整命令行 | 紧凑图标/文字按钮，在命令行右侧 18px 内边距处对齐 |
| **输入区（常规参数表）** | 参数 JSON | **复制入参** | 复制入参 JSON | 位于入参 Header 右侧 |
| **输出区（有 Header 时）** | 完整输出日志 | **复制输出** | 复制完整输出内容 | 位于输出 Header 右侧，与左侧状态/耗时形成平衡 |
| **输出区（无 Header 纯文本时）** | 完整输出日志 | **复制输出** | 复制完整输出内容 | 悬浮于输出区右上角（内嵌于视口，且设置合理的 `right: 18px`），或当文本 hover 时显现 |

- **关键差异**：将原本两个含糊不清的“复制”彻底区分成“复制命令”与“复制输出”（或在紧凑空间下以 Tooltip 严格区分），用户一目了然，再无混淆。

---

## 四、代码级具体修改蓝图

### 1. `ChatToolCallBlock.module.css` 改造清单

```css
/* 1. 外层容器：增加优雅微描边 */
.toolResultBody {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle); /* [新规] 增加 1px 微描边 */
  border-radius: var(--radius-lg);
  margin: 2px 0 4px 0;
  box-sizing: border-box;
  overflow: hidden;
  position: relative;
  box-shadow: none;
}

/* 2. 输入输出分界线：在输出面板顶部加上贯穿描边 */
.toolSectionOutput {
  border-top: 1px solid var(--border-subtle); /* [新规] 多段卡片分隔描边 */
}

.toolResultBodySingle .toolSectionOutput {
  border-top: none; /* [新规] 单卡模式切除顶部边框 */
}

/* 3. 根除破坏性内边距：重构 .toolSectionShellSingleLine */
.toolSectionShellSingleLine {
  /* [废除] padding: 4px 0; */
  padding: 6px 18px; /* [新规] 统一左右 18px 对齐，上下 6px 呼吸感 */
}

/* 4. 优化单行命令行布局 */
.terminalSingleLineRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 24px;
}

/* 5. Header 紧凑化与对齐 */
.toolSectionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0;
  background: transparent;
  border-bottom: none;
  min-height: 20px;
  margin-bottom: 4px;
  box-sizing: border-box;
}

/* 6. 单卡浮动操作区右边距规范化（与 18px 内边距对齐） */
.toolFloatingActions {
  position: absolute;
  top: 6px;
  right: 18px; /* [调整] 由 12px 调整至 18px，与内容基线保持垂直对齐 */
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
}
```

### 2. `ToolCallInputPane.tsx` 改造清单

- **文案与 Tooltip 明确化**：
  - 将 Shell 命令行的复制按钮：
    - `Tooltip content={copied ? '已复制！' : '复制完整命令'}`
    - 按钮文案调整为明确的 `'复制命令'`（或在紧凑宽度下维持图标，但有明确 aria-label）。
  - 常规参数区按钮：
    - `Tooltip content={copied ? '已复制！' : '复制入参 JSON'}`
    - 按钮文案明确为 `'复制入参'`。

### 3. `ToolCallOutputPane.tsx` 改造清单

- **重构 `showHeader` 判定**：
  ```tsx
  const hasMeta = Boolean(metaExtra || durationStr);
  const hasStatus = Boolean(isError || isRunning);
  
  const showHeader = useMemo(() => {
    if (hasStatus) return true;
    if (hasMeta && !isSingleCard) return true;
    if (isTruncated) return true;
    return false;
  }, [hasStatus, hasMeta, isSingleCard, isTruncated]);
  ```
- **输出端复制按钮文案明确化**：
  - 按钮文案由 `'复制'` 调整为 `'复制输出'`；
  - 复制成功反馈由 `'已复制'` 调整为 `'已复制'`；
  - 当 `!showHeader && !isSingleCard` 时，利用类似单卡浮动操作区（但位于分隔线下方并对齐 18px）或者将其收拢在右侧，避免无谓占用一整行垂直空白。

---

## 五、前后视觉排版对比（ASCII 对比图）

### 改造前（现有缺陷态）：
```
[>_ run_command] 耗时 0.2s
+-------------------------------------------------------------+
|$ npm test                            [复制] (贴边 0px 极挤)  | <-- padding: 4px 0
|                                                             |
|                                     [复制] (缩进 18px 错位) | <-- 空 header 白白占一行
|                                                             |
|  > conex@0.1.0 test                                         | <-- padding: 18px
|  > vitest run                                               |
+-------------------------------------------------------------+
缺陷：
1. 外层无描边，边界发虚；
2. 输入区与输出区无分割线，混在一起；
3. 上下文字错位 18px，上下两个“复制”按钮错位 18px；
4. 中间空出了 30px 空白行只为放一个重复的“复制”。
```

### 改造后（设计规范态）：
```
[>_ run_command] 耗时 0.2s
+-------------------------------------------------------------+  <-- 1px solid var(--border-subtle)
|  $ npm test                                      [复制命令]  |  <-- 左右 18px 严密对齐
|-------------------------------------------------------------|  <-- 1px solid var(--border-subtle) 贯穿分割线
|  · 0.2s                                          [复制输出]  |  <-- 有元数据时左右对称展示
|  > conex@0.1.0 test                                         |  <-- 左右 18px 基线对齐
|  > vitest run                                               |
+-------------------------------------------------------------+
优雅特征：
1. 外层 1px 柔和微描边，圆角卡片质感清晰；
2. 中间精致贯穿分隔线，输入/输出职能分离；
3. 上下左边距、右边距严格锁定 18px，排版端正，毫无锯齿；
4. 消除空白占位，按钮语义清晰（“复制命令” vs “复制输出”），极度降噪。
```

---

## 六、交付总结与后续联动建议

1. **本席位产出状态**：
   - 现行冲突代码全面定位完毕（`ChatToolCallBlock.module.css:761`、`558`、`596` 以及 `ToolCallOutputPane.tsx:138`）。
   - 内边距统一 18px、外层 1px 描边、中间贯穿分隔线以及 Header 降噪逻辑全部设计完成，具备直接落盘实施条件。
2. **与其他席位协同点**：
   - 与 **A5（字号 14px 统一）**：卡片内部的等宽代码区域（pre/code）维持紧凑 12px，而外层折叠行和状态徽标统一遵循 14px/12px 分级规范。
   - 与 **A7（ScrollFade 边缘渐隐）**：在统一 18px 宽度与描边后，ScrollFade 的遮罩蒙层能更自然地在内容区上下收敛，不会发生边缘裁切错位。
