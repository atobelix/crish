# DeepSeek-Harness 视觉样式与 Design Tokens 深度解析

> **战役工作区**：`docs/linear-chat-stream-study/`  
> **归属专题**：A06 视觉样式与 Design Tokens 专项分析  
> **参考代码库**：`reference/deepseek-harness/`  
> **核心分析模块**：
> 1. `packages/client/ui-theme/src/styles/design-platform.css`
> 2. `packages/client/ui-theme/src/styles/gradient-shadow-text.css` & `corner-shape.css`
> 3. `packages/client/ui-chat/src/client/chat/MessageItem.module.css` & `MessageItem.tsx`
> 4. `packages/client/ui-chat/src/client/chat/AssistantMarkdown.module.css` & `AssistantMarkdown.tsx`
> 5. `packages/client/ui-conversation/src/client/input/editor/composer-editor.module.css` & `ReferenceChip.module.css`
> 6. `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` & `ConversationRoot.module.css`
> 7. `packages/client/ui-theme/tests/elevation-styles.client.spec.ts`

---

## 1. 核心综述：极简对话流界面的视觉哲学

在现代生成式 AI 桌面客户端界面中，常见的设计缺陷是**界面过度卡片化（Over-Cardification）**、**重阴影堆叠（Shadow Pollution）**与**生硬焦点边框（Aggressive Focus Rings）**。许多产品机械地为每轮 Assistant 回答套上带描边的卡片容器、厚重的阴影或强对比气泡，导致长篇阅读产生强烈的视觉拥挤与疲劳感。

`deepseek-harness` 展现出一种高度克制、精致而通透的界面视觉美学，其核心特征可凝练为四大支柱：
1. **三层解耦的 Design Token 架构**：从静态物理色板（Raw Static Colors）到语义别名（Semantic Aliases），再到组件特异性 Token（Component-specific Tokens），全站杜绝硬编码色值，实现明暗双主题的无缝热切换。
2. **用户气泡黄金比例（70.2% 宽比）**：基于中轴内容列宽公式自适应伸缩，搭配 22px 超椭圆（Superellipse）大胶囊圆角、42px 单行基准高度以及清透浅蓝底色，以 6px 紧凑垂直间隙衔接下方操作栏。
3. **Assistant 消息纯净画布投射（Flat Canvas Projection）**：完全剔除任何包裹气泡、背景色块与卡片外框，直接将 Markdown 文本以 14px 字号、24px 宽松行高平铺于底衬画纸上；次级信息（Think 思考过程、Tool 工具卡片摘要与表格）以 13px / 20px 形成清晰的第二梯度阶梯。
4. **发丝级投影内嵌边框（Hairline Stroke Drawn in Shadow）**：在高层级浮动表面坚决推行 `border: 0`，将 0.5px 发丝细线（Hairline）作为第一层阴影嵌入 `box-shadow`；平面边框统一收敛至 0.5px 透明灰阶（`rgba(0, 0, 0, 0.04 ~ 0.16)`），输入框焦点态克制优雅，仅由品牌蓝光标（`caret-color`）引导交互。

```
+-----------------------------------------------------------------------------------+
|  DeepSeek-Harness 视觉层级全景                                                    |
|                                                                                   |
|  [Canvas Background: --dsw-alias-bg-base (#ffffff / #151517)]                     |
|                                                                                   |
|  [User Bubble] (Right-aligned, max-width: min(748px * 0.702, 82%))                |
|  +-------------------------------------------------------------+                  |
|  | Background: --dsw-specific-bubble (#edf3fe / #2c2c2e)        |                  |
|  | Radius: 22px (superellipse 1.5), Padding: 10px 16px, H: 42px |                  |
|  | "请优化这段 Rust 异步调度代码..."                             |                  |
|  +-------------------------------------------------------------+                  |
|         gap: 6px                                                                  |
|  [Time: 13px] [Copy] [Edit] (MessageIconActions, 28px pills)                      |
|                                                                                   |
|  margin-top: 16px                                                                 |
|                                                                                   |
|  [Assistant Message] (Flat Canvas Projection, Full Column Width: 748px)           |
|  |-- Think Row: 24px height, font: 13px/20px, color: label-tertiary               |
|  |   > [Chevron] 思考过程 (2.4s) ...                                             |
|  |                                                                                |
|  |-- Tool Row: 33px height, border-bottom: 0.5px solid border-l2                  |
|  |   > Read tool: src/orchestrator.rs                                             |
|  |                                                                                |
|  |-- Markdown Body: No Cards, No Borders, font: 14px/24px (10px leading)          |
|  |   已为您完成调度器重构，关键改进如下：                                         |
|  |   1. 消除锁竞争...                                                             |
|  |                                                                                |
|  |-- Actions: margin-top: 16px; margin-left: -6px (Optical Text Edge Alignment)   |
|      [Copy] [Regenerate] [Feedback] [Tokens/Time Stats: 13px]                     |
|                                                                                   |
|  margin-bottom: 8px                                                               |
|                                                                                   |
|  [Composer Card] (Center docked, width: 748px + 32px = 780px)                     |
|  +-------------------------------------------------------------+                  |
|  | border: 0; box-shadow: var(--dsw-elevation-soft);            |                  |
|  | (0 0 0 0.5px border-l2, 0 4px 16px rgba(0,0,0,0.03), ...)   |                  |
|  | Radius: 22px; Fill: --dsw-specific-input-major               |                  |
|  | Textarea: 14px/24px, caret-color: business-primary, no ring  |                  |
|  | ReferenceChip: 22px pill inside 24px line, bg: hover (6%)    |                  |
|  +-------------------------------------------------------------+                  |
+-----------------------------------------------------------------------------------+
```

---

## 2. DeepSeek 的三层 Design Token 体系架构

DeepSeek-Harness 的 Token 定义集中在 `packages/client/ui-theme/src/styles/design-platform.css`。整个色彩系统严格划分为三级金字塔架构：

```
+-------------------------------------------------------------------------+
| Tier 3: Component-Specific Tokens (--dsw-specific-*)                    |
| Specific contexts: bubble, input-major, menu, sidebar-nav, tip          |
+-------------------------------------------------------------------------+
                                    ^
                                    | maps to / aliases
+-------------------------------------------------------------------------+
| Tier 2: Semantic Alias Tokens (--dsw-alias-*)                           |
| Themes: bg-base, border-l1~l4, label-primary~tertiary, interactive-*    |
+-------------------------------------------------------------------------+
                                    ^
                                    | maps to / derives from
+-------------------------------------------------------------------------+
| Tier 1: Raw Static Colors (--dsw-static-*)                              |
| Palettes: neutral-bluish (00~1000), deepseek (50~900), amber, green, red|
+-------------------------------------------------------------------------+
```

### 2.1 Tier 1：静态原始色阶（Raw Static Colors）

- **源码位置**：`design-platform.css:5-78` (Light) 与 `design-platform.css:80-154` (Dark)
- **命名空间**：`--dsw-static-*`

#### 关键技术设计：中性蓝灰（Neutral-Bluish）作为界面基石
普通界面常采用绝对中性灰（RGB 三通道等值，如 `#808080`、`#f5f5f5`），在电子显示器上容易显得死板、晦暗。DeepSeek 引入了**带有微弱冷色相偏移的中性蓝灰（Neutral-Bluish）**系列：

| Token 名称 | Light 模式原始色值 | Dark 模式原始色值 | 视觉感知与设计角色 |
|---|---|---|---|
| `--dsw-static-neutral-bluish-00` | `rgb(255, 255, 255)` | `rgb(255, 255, 255)` | 极致纯白基准 |
| `--dsw-static-neutral-bluish-50` | `rgb(249, 250, 251)` | `rgb(249, 250, 251)` | 极浅画纸底衬 / 暗色主文字 |
| `--dsw-static-neutral-bluish-60` | `rgb(245, 246, 247)` | `rgb(249, 250, 251)` | 平台模块浅灰底 |
| `--dsw-static-neutral-bluish-75` | `rgb(241, 243, 245)` | `rgb(241, 243, 245)` | 悬停态实色浅底 |
| `--dsw-static-neutral-bluish-100`| `rgb(235, 238, 242)` | `rgb(235, 238, 242)` | 浅色引用/按键背景 |
| `--dsw-static-neutral-bluish-600`| `rgb(129, 133, 140)` | `rgb(129, 133, 140)` | 三级说明标签文字 |
| `--dsw-static-neutral-bluish-700`| `rgb(97, 102, 107)`  | `rgb(97, 102, 107)`  | 二级正文标签文字 |
| `--dsw-static-neutral-bluish-850`| `rgb(44, 44, 46)`    | `rgb(44, 44, 46)`    | 暗色输入框/气泡主要底色 |
| `--dsw-static-neutral-bluish-950`| `rgb(21, 21, 23)`    | `rgb(21, 21, 23)`    | 暗色画纸深邃主底 |
| `--dsw-static-neutral-bluish-1000`| `rgb(15, 17, 21)`   | `rgb(15, 17, 21)`    | 浅色主文字（Ink Inkjet） |

> **源码证据与色阶特性**：
> 观察 `neutral-bluish-1000` 为 `rgb(15, 17, 21)`，B 通道（21）显著高于 R 通道（15）。这赋予文字一种深邃的高级“墨黑（Ink）”质感，避免了 `rgb(0, 0, 0)` 纯黑在浅底上的刺眼光斑。

#### DeepSeek 品牌蓝阶（DeepSeek Blue）
- `--dsw-static-deepseek-50`: `rgb(237, 243, 254)`（浅色用户气泡专属底色，柔和的浅蓝冰川感）
- `--dsw-static-deepseek-100`: `rgb(228, 237, 253)`（浅色交互选中态）
- `--dsw-static-deepseek-200`: `rgb(211, 226, 255)`（气泡高亮边界）
- `--dsw-static-deepseek-400`: `rgb(103, 158, 254)`（暗色品牌链接与主操作态）
- `--dsw-static-deepseek-500`: `rgb(65, 118, 230)`（浅色主品牌色，标准 DeepSeek Blue）

---

### 2.2 Tier 2：语义别名 Token（Semantic Alias Tokens）

- **源码位置**：`design-platform.css:156-235` (Light) 与 `design-platform.css:249-328` (Dark)
- **命名空间**：`--dsw-alias-*`
- **设计契约**：所有业务 UI 组件（聊天流、输入框、菜单、按钮、状态行）**严禁跨级读取 Tier 1 的 `--dsw-static-*`**，必须统一通过语义别名进行解耦。

#### 1. 背景层级（Surface Backgrounds）
```css
/* Light (design-platform.css:157-160) */
--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00);       /* #ffffff */
--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-00);

/* Dark (design-platform.css:250-253) */
--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950);     /* rgb(21, 21, 23) */
--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875); /* rgb(35, 35, 36) */
--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850); /* rgb(44, 44, 46) */
--dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-800); /* rgb(53, 54, 56) */
```
浅色模式下底层画纸与浮动层全部收敛为纯白，依靠投影和发丝分割；暗色模式下则通过阶梯明度（950 -> 875 -> 850 -> 800）表达自然空间深度。

#### 2. 四级半透明边框体系（Alpha Border Ladder）
DeepSeek 坚决弃用实心不透明边框，所有中性边框均基于带 Alpha 透明度的黑/白叠加，使其能天然适应任意底色：

```css
/* Light (design-platform.css:172-176) */
--dsw-alias-border-l1: rgba(0, 0, 0, 0.04);  /* 极微弱边缘，用于菜单面板与轻卡片 */
--dsw-alias-border-l2: rgba(0, 0, 0, 0.1);   /* 标准发丝描边，输入框与分割线 */
--dsw-alias-border-l3: rgba(0, 0, 0, 0.12);  /* 标题栏分割线、按钮边框 */
--dsw-alias-border-l4: rgba(0, 0, 0, 0.16);  /* 默认 Elevation 发丝轮廓 */

/* Dark (design-platform.css:265-269) */
--dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
--dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
--dsw-alias-border-l3: rgba(255, 255, 255, 0.16);
--dsw-alias-border-l4: rgba(255, 255, 255, 0.2);
```

#### 3. 标签排版色彩（Label Typography Hierarchy）
```css
/* Light (design-platform.css:207-209) */
--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000); /* 墨黑，主正文 */
--dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);/* 次要正文、图标 */
--dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600); /* Think摘要、次级元数据 */
--dsw-alias-label-caption: var(--dsw-static-neutral-bluish-400);  /* 占位符、微型分隔符 */

/* Dark (design-platform.css:300-302) */
--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
--dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-300);
--dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-400);
--dsw-alias-label-caption: var(--dsw-static-neutral-bluish-600);
```

#### 4. 微交互反馈底色（Subtle Interactive Tokens）
```css
/* Light (design-platform.css:196-200) */
--dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);  /* 6% 蓝灰半透悬停底色 */
--dsw-alias-interactive-bg-active: rgba(38, 49, 72, 0.1);  /* 10% 激活底色 */
--dsw-alias-interactive-bg-hover-solid: var(--dsw-static-neutral-bluish-75);

/* Dark (design-platform.css:289-293) */
--dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
--dsw-alias-interactive-bg-active: rgba(255, 255, 255, 0.14);
```
所有悬停与按压态均为透明度仅 6%~14% 的极淡轻纱，交互时绝无生硬黑块闪烁。

---

### 2.3 Tier 3：组件专用 Token（Component-Specific Tokens）

- **源码位置**：`design-platform.css:236-247` (Light) 与 `design-platform.css:329-340` (Dark)
- **命名空间**：`--dsw-specific-*`
- **目的**：为特定核心界面构件赋予独特的专有视觉身份，同时保持主题语义的统一映射。

```css
/* Light 模式组件特异性 Token (design-platform.css:236-246) */
--dsw-specific-bubble: var(--dsw-static-deepseek-50);         /* 用户气泡：极淡浅蓝 (237, 243, 254) */
--dsw-specific-bubble-highlight: var(--dsw-static-deepseek-200); /* 气泡高亮状态 */
--dsw-specific-input-major: var(--dsw-static-neutral-bluish-00);  /* 主输入框底衬：纯白 */
--dsw-specific-login-input: var(--dsw-static-neutral-bluish-50);
--dsw-specific-menu: var(--dsw-alias-bg-layer-3);
--dsw-specific-selector: var(--dsw-static-neutral-bluish-60);     /* 工具栏胶囊选择器 */
--dsw-specific-tip: var(--dsw-static-neutral-bluish-60);

/* Dark 模式组件特异性 Token (design-platform.css:329-339) */
--dsw-specific-bubble: var(--dsw-static-neutral-bluish-850); /* 用户气泡：深蓝灰 (44, 44, 46) */
--dsw-specific-bubble-highlight: var(--dsw-static-neutral-bluish-750);
--dsw-specific-input-major: var(--dsw-static-neutral-bluish-850); /* 输入框底衬：深蓝灰 */
--dsw-specific-selector: var(--dsw-static-neutral-bluish-800);
```

---

## 3. 用户气泡（User Bubble）的黄金比例与几何学

用户消息气泡在视觉上构成了对话界面的“锚点”。DeepSeek 在用户气泡的设计上有着严格的数学比例与几何规范。

### 3.1 70.2% 宽比的数学原理与自适应轴

- **源码位置**：`packages/client/ui-chat/src/client/chat/MessageItem.module.css:11-22`

```css
.userStack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  /* The figma 525px cap held as a share of the width axis (525/748 ≈ 0.702):
     resolves to the original 525px on the default column and widens with a
     dragged or adaptive column. The 748px fallback covers mounts outside the
     conversation column, where the axis variable is absent. */
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
}
```

#### 设计原理解析：
1. **Figma 设计稿黄金比例（525 / 748 ≈ 0.702）**：
   在基准宽度为 748px（`--dsh-chat-content-width`）的聊天中轴列中，Figma 原型设定用户气泡最大宽度为 525px。
   $$\frac{525\text{px}}{748\text{px}} = 0.70187... \approx 0.702\ (70.2\%)$$
2. **为什么不是 100% 也不是 50%？**
   - 若设为 100%，用户长文本会横贯屏幕，与后续全宽展开的 Assistant 消息无法在轮廓上迅速区分；
   - 若设为 50%，用户粘贴的多行代码或稍长问题会频繁换行，导致气泡在纵向过度拉长；
   - **70.2% 黄金比例**：在视觉右侧留出近 30% 的通透负空间（Negative Space），形成清晰的右对齐梯级，使用户快速扫视时一眼就能定位“我的提问”。
3. **自适应与窄屏保护**：
   - 随中轴列宽拉伸（如用户拖动中轴线或在大屏下自适应到 920px）动态扩大气泡容量；
   - 表达式中的 `min(..., 82%)` 提供了小视口兜底——当在极窄窗口（如 500px 移动端或分屏模式）下，气泡不至于被生硬限制在绝对像素上，而是放宽至 82% 宽度，防止气泡内容挤压变形。

---

### 3.2 气泡几何尺寸、圆角与色彩系统

- **源码位置**：`MessageItem.module.css:23-41`

```css
.bubble {
  max-width: 100%;
  background: var(--dsw-specific-bubble);
  border-radius: 22px;
  /* 42px single-line bubble at the default size: 22 line + 10 vertical
     padding each side; the Settings font-size preference moves size and line
     height together through the body-published axis. */
  padding: 10px 16px;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
  /* The projected user text is inline runs; the bubble owns wrapping so a
     decorated single-line message stays one line. */
  white-space: pre-wrap;
  word-break: break-word;
}
```

#### 关键几何指标：
1. **单行 42px 胶囊高度公式**：
   $$\text{高度} = \text{Top Padding}(10\text{px}) + \text{Line Height}(22\text{px}) + \text{Bottom Padding}(10\text{px}) = 42\text{px}$$
   保证单行短文本消息呈现饱满轻盈的药丸胶囊态，绝无压抑局促。
2. **22px 超椭圆平滑圆角**：
   结合 `packages/client/ui-theme/src/styles/corner-shape.css:16-26`：
   ```css
   @supports (corner-shape: superellipse(1.5)) {
     :root {
       --dsw-corner-shape: superellipse(1.5);
     }
     *, *::before, *::after {
       corner-shape: var(--dsw-corner-shape);
     }
   }
   ```
   在支持现代 CSS Corner Shape 的浏览器引擎中，所有 22px 圆角自动享受超椭圆（Squircle，曲率指数 1.5）平滑，消除传统圆形贝塞尔圆角向直线过渡时的曲率突变（G2 连续）。
3. **极淡浅蓝/灰色彩心理**：
   - 亮色下底色采用 `--dsw-static-deepseek-50`（`rgb(237, 243, 254)`），这是一种极浅的冰川浅蓝，亮度极高（约 96%），不给用户眼球带来任何沉重卡片感；
   - 暗色下底色为 `--dsw-static-neutral-bluish-850`（`rgb(44, 44, 46)`），与底衬 `rgb(21, 21, 23)` 形成约 10% 的轻度明度反差。

---

### 3.3 右对齐布局与 6px 间隙操作栏

- **源码位置**：`MessageItem.module.css:1-9` & `MessageItem.tsx:188-234`

```css
/* User bubble: right-aligned column (bubble + IconActions). Figma
   User_Bubble/message_container 659:38813 — r22 fill, actions gap 6 below. */

.userRow {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
```

在 DOM 树中（`MessageItem.tsx:188-234`）：
```tsx
<div className={css.userRow}>
  <div className={css.userStack}>
    {attachments.length > 0 && <div className={css.attachmentRow}>...</div>}
    {showBubble && <div className={css.bubble}>...</div>}
    {referenceLabels.length > 0 && <div className={css.referenceSummary}>...</div>}
  </div>
  {actions?.(text)}
</div>
```
- `.userRow` 直接作为垂直 flexbox，右对齐；
- 紧随气泡下方的操作栏（`MessageIconActions`，含时间戳、复制、重试等按钮）与气泡外边缘之间严格保持 **6px** 的微距（`gap: 6px`）；
- 附件卡片（`attachmentRow` 与 `fileCard`，`MessageItem.module.css:304-316`）同样呈右对齐并设 `border: 0.5px solid var(--dsw-alias-border-l2)`，圆角 16px，与主气泡整齐成组。

---

## 4. Assistant 消息的扁平化排版（Flat Canvas Projection）

与用户气泡的包裹感截然不同，DeepSeek 对 Assistant 的回答采用了**极致纯净的平面画纸投射（Flat Paper Projection）**。

### 4.1 彻底去除包裹气泡与卡片外框

- **源码位置**：`packages/client/ui-chat/src/client/chat/AssistantMarkdown.module.css:1-21` & `AssistantMarkdown.tsx:110-118`

```css
/* Assistant flow body: full-width narration (figma 16/28 scaled 0.875 → 14/24
   with the markdown token ladder), block gap 16. */

.root {
  display: flex;
  flex-direction: column;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
```

```tsx
// AssistantMarkdown.tsx:110-118
return (
  <div className={css.root} data-streaming={streaming || undefined}>
    <div className={css.body}>
      {rendered}
      {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
    </div>
  </div>
)
```

#### 设计理念深度分析：
1. **完全无边框、无独立底色、无投影**：
   `.root` 与 `.body` 没有任何 `border`、`background` 或 `box-shadow`。Assistant 的输出不再被困在“一个回答盒子”里，而是直接书写在整页的“纸面（Canvas）”上。
2. **正文字号 14px 与 24px 行高的黄金呼吸间距**：
   - 基础字号 14px，行高 24px。
   - 这意味着字号与行高之间有足足 **10px 的行间行距（Leading = 24 - 14 = 10px）**！在多段落的深度分析、代码讲解阅读中，充足的行距极大地降低了跳行与视线追踪疲劳。
3. **块级 16px 垂直节奏（Block Rhythm）**：
   段落、列表、代码块、引用块之间的垂直间隙统一为 `gap: 16px`。

---

### 4.2 动态字体阶梯与双轨 Delta 机制（Typography Ladder）

- **源码位置**：`packages/client/ui-theme/src/styles/gradient-shadow-text.css:42-128`

DeepSeek 实现了一套根据用户偏好全局无级调节、且严密保持层级比例的字体阶梯：

```css
/* gradient-shadow-text.css:54-57 */
body {
  --dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px);
  --dsh-content-font-size-secondary: min(
    calc(var(--dsh-content-font-size, 14px) - 1px),
    max(13px, calc(var(--dsh-content-font-size, 14px) - 2px))
  );
  --dsh-content-font-delta-secondary: calc(var(--dsh-content-font-size-secondary) - 13px);
}
```

#### 完整字体梯度对照表：

| 语义层级 | 默认字号 / 行高 | 随动计算公式 | 对应组件与应用场景 |
|---|---|---|---|
| **Markdown H1** | 21px / 30px | `calc(21px + delta) / calc(30px + delta)` | Markdown 一级大标题 |
| **Markdown H2** | 19px / 28px | `calc(19px + delta) / calc(28px + delta)` | Markdown 二级标题 |
| **Markdown H3** | 18px / 26px | `calc(18px + delta) / calc(26px + delta)` | Markdown 三级标题 |
| **Markdown H4** | 14px / 24px (600) | `var(--dsh-content-font-size) / calc(24px + delta)` | 四级加粗小标题 |
| **Base 正文** | **14px / 24px** | `var(--dsh-content-font-size) / calc(24px + delta)` | Assistant 正文、用户气泡内容、Composer 草稿 |
| **Secondary 次级**| **13px / 20px~24px**| `var(--dsh-content-font-size-secondary)` | **Think 思考行、Tool 卡片摘要、Markdown 表格** |
| **Small 说明** | 12px / 20px (固定)| 固定字号不随动 | 密集元数据、次级微标 |
| **Code Block** | 11px / 19px (固定)| 固定等宽字号 | 代码块正文、JSON payload |
| **Tool Code** | 11px / 16px (固定)| 固定等宽字号 | Tool Row 展开输出终端 |

---

### 4.3 次级信息系统：Think 思考流与 Tool 工具卡片

- **Think 思考折叠行**（`ReasoningRow.module.css:58-99`）：
  ```css
  /* Think text reads the secondary tier — one step under the body size */
  .summary {
    color: var(--dsw-alias-label-tertiary);
    font-size: var(--dsh-content-font-size-secondary, 13px);
    line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  }
  .thinkBody {
    padding: 4px 0 4px calc(22px + var(--dsh-content-font-delta, 0px));
    color: var(--dsw-alias-label-tertiary);
    font-size: var(--dsh-content-font-size-secondary, 13px);
    line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  }
  ```
  - 默认字号 13px、行高 20px，文字颜色为三级弱化灰（`--dsw-alias-label-tertiary`）。
  - 在未展开状态下，整行高度限制为紧凑的 **24px**（`ReasoningRow.module.css:8`），并附带 2.6s 周期性的浅蓝微光流光扫动（Sweep Animation）。

- **Tool 工具调用行**（`TurnProcessNodeView.module.css:1-15` & `GenericCommandCard.module.css:58-80`）：
  ```css
  /* TurnProcessNodeView.module.css:7-12 */
  .root {
    height: 33px;
    padding: 0 0 8px;
    border: none;
    border-bottom: 0.5px solid var(--dsw-alias-border-l2);
    color: var(--dsw-alias-label-secondary);
  }
  ```
  ```css
  /* GenericCommandCard.module.css:58-76 */
  .summary {
    font-size: var(--dsh-content-font-size-secondary, 13px);
    line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  }
  .body {
    border: 0.5px solid var(--dsw-alias-border-l1);
    border-radius: 12px;
    background: var(--dsw-alias-markdown-code-block);
  }
  ```
  - 工具行仅依靠 `0.5px solid var(--dsw-alias-border-l2)` 底部分割线，绝无多余外框；
  - 展开的代码输出框仅使用 `0.5px solid var(--dsw-alias-border-l1)`（4% 超弱透明度边框），实现安静内敛的信息折叠。

---

### 4.4 光学校准：底部操作栏对齐艺术

- **源码位置**：`AssistantMarkdown.module.css:66-70`

```css
/* Finalized footer offset (figma 43:32997); chrome lives in MessageIconActions. */
.actions {
  margin-top: 16px;
  /* Optical align with 28px icon hit targets that pad 6px past the glyph. */
  margin-left: -6px;
}
```

#### 光学校准原理：
- 操作栏中的图标按钮尺寸为 28px（`MessageIconActions.module.css:61-66`），内部图标为 15px，按钮四周自带 6px 的点击热区内边距（`padding: 6px`）；
- 若直接左对齐，图标图形距离左侧正文边界会有 6px 的凹陷缩进，产生肉眼可见的不齐整感；
- DeepSeek 专门声明 `margin-left: -6px`，**将 6px 的按钮 hit target 负边距回拉，使 15px 的图形左边缘与上方 14px Markdown 正文的第一个文字像素达到绝对物理垂直对齐**！这是专业级 UI 排版才具备的光学对齐细节。

---

## 5. 边框与焦点态哲学（Hairline Elevation & Subdued Focus）

在边框、投影与焦点态的设计上，DeepSeek 践行了一套完整的工程规范。这套规范不仅写在 CSS 中，更通过 Vitest 自动化单元测试在 CI 流程中强制拦截违规代码。

### 5.1 "Hairline Stroke Drawn in Shadow" 架构创新

- **参考文档**：`reference/deepseek-harness/.agents/notes/implemented/feature/2026-09-01-web-elevation-stroke-shadows.zh.md`
- **样式文件**：`gradient-shadow-text.css:10-35`
- **CI 门禁**：`packages/client/ui-theme/tests/elevation-styles.client.spec.ts`

#### 传统方案的弊病：
传统 Web UI 常常同时声明：
```css
/* 反面教材：常见于普通客户端 */
.card {
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
```
这会导致三大问题：
1. **盒模型尺寸挤压**：`border: 1px solid` 会向内或向外占用真实布局空间（每侧 1px），在小按钮或动态卡片中导致布局尺寸跳动；
2. **边缘重影与脏污感**：1px 的深色 border 与模糊扩散的 box-shadow 叠加，边缘浑浊粗糙，显得非常“脏”；
3. **暗色主题失效**：在暗色模式下，暗色柔光阴影完全不可见，原本依赖阴影分离界面的元素失去立体感。

#### DeepSeek 的颠覆性重构：
高层级表面（浮层、菜单、对话框、输入框、悬浮面板）一律声明 `border: 0`，**将 0.5px 发丝描边作为第一层投影内嵌至 `box-shadow`**：

```css
/* gradient-shadow-text.css:17-35 */
body {
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l4);
}

/* 派生 elevation 必须在 body, body * 上逐元素声明 */
body,
body * {
  --dsw-elevation-stroke: 0 0 0 0.5px var(--dsw-elevation-stroke-color);
  
  --dsw-elevation-panel:
    var(--dsw-elevation-stroke),
    0 3px 8px 0 rgba(0, 0, 0, 0.03),
    0 0 16px 0 rgba(0, 0, 0, 0.02);

  --dsw-elevation-prominent:
    var(--dsw-elevation-stroke),
    0 3px 8px 0 rgba(0, 0, 0, 0.04),
    0 0 20px 0 rgba(0, 0, 0, 0.05);

  --dsw-elevation-soft:
    var(--dsw-elevation-stroke),
    0 4px 16px 0 rgba(0, 0, 0, 0.03),
    0 0 24px 0 rgba(0, 0, 0, 0.03);
}
```

```
+-------------------------------------------------------------------------+
| DeepSeek Elevation 三层投影解析 (以 --dsw-elevation-soft 为例)          |
|                                                                         |
| Layer 1: 0 0 0 0.5px var(--dsw-elevation-stroke-color)                  |
|          -> 0.5px 发丝描边，不占布局空间，提供精准锐利的几何轮廓          |
|                                                                         |
| Layer 2: 0 4px 16px 0 rgba(0, 0, 0, 0.03)                              |
|          -> 3% 极浅透明度的方向光阴影，产生微妙的轻微浮起感             |
|                                                                         |
| Layer 3: 0 0 24px 0 rgba(0, 0, 0, 0.03)                                 |
|          -> 3% 极浅透明度的大面积无方向弥散柔光，消除硬边缘阴影          |
+-------------------------------------------------------------------------+
```

#### 重绑穿透机制（Rebinding Contract）：
注意为什么派生值要在 `body, body *` 上声明，而默认色值只在 `body` 声明？
- 自定义属性（CSS Custom Properties）计算时，`var()` 会被就地替换；
- 若派生属性只声明在 `body`，子组件即使重绑 `--dsw-elevation-stroke-color: var(--dsw-alias-border-l2)`，也无法穿透已替换计算值的 `--dsw-elevation-soft`；
- 在 `body, body *` 逐元素重声明后，任何子元素或组件重绑 `--dsw-elevation-stroke-color`，其内部的 `var(--dsw-elevation-stroke)` 都会立即重新求值！
  - 菜单面板：重绑为最浅的 `--dsw-alias-border-l1`；
  - 输入框：重绑为 `--dsw-alias-border-l2`；
  - 工作区引导态（Workspace Trigger）：设为 `transparent`，直接隐去发丝线，仅保留柔光。

#### 刚性 CI 门禁检查（`elevation-styles.client.spec.ts`）：
- **禁止配对规则**：任何规则如果同时包含 `box-shadow: var(--dsw-elevation-*)` 和 `--dsw-alias-border-*`，Vitest 静态扫描直接报错中断；
- **发丝线宽度铁律**：所有消费中性 border token 的平面实线边框（`border: solid`），宽度必须是 `0.5px`！写成 `1px solid` 会被 CI 直接拒绝；
- **发丝线分隔物**：用 `div` 填充画线（如菜单分割线、标题栏底线、`hr`）的高度或宽度必须是 `0.5px`，严禁 1px。

---

### 5.2 输入框（InputBar Composer）的克制焦点态

- **源码位置**：`packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:32-71, 158-171`

```css
/* InputBar.module.css:32-50 */
.card {
  box-sizing: border-box;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: var(--dsh-composer-card-max-width);
  padding-top: 10px;
  
  /* Input stroke: the light neutral (l2), drawn as the elevation hairline
     so it costs no layout; the shadow is the soft elevation tier. */
  border: 0;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  border-radius: 22px;
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-elevation-soft);
  
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}

/* InputBar.module.css:158-171 */
.input {
  box-sizing: border-box;
  padding: 4px 8px 0 16px;
  font-family: var(--dsw-font-family);
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  outline: none;
  color: var(--dsw-alias-label-primary);
  /* Business blue, not brand-primary: that token resolves to ink in this sheet. */
  caret-color: var(--dsw-alias-state-business-primary);
}
```

#### 焦点态哲学（No Heavy Rings）：
1. **彻底摒弃 outline 与 focus 粗黑/深蓝边框**：
   `.input` 设置了 `outline: none;`，并且整个 `.card` 在聚焦时**不添加任何加粗边框或高对比度光环**。
2. **克制的光标引导**：
   光标颜色设为品牌蓝 `caret-color: var(--dsw-alias-state-business-primary)`。用户聚焦时，只有优雅闪烁的微蓝光标提示输入状态，输入框外壳保持平和稳定，不喧宾夺主。
3. **圆角与宽度轴契合**：
   输入框外框圆角为标准的 22px 胶囊角，宽度刚好为内容中轴加上 32px（`--dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px)`），使得输入框两侧各有 16px 突出的视觉包裹感。

---

### 5.3 Lexical 编辑器与 ReferenceChip 胶囊集成

- **源码位置**：
  - `packages/client/ui-conversation/src/client/input/editor/ReferenceChip.module.css:6-20`
  - `packages/client/ui-conversation/src/client/input/editor/composer-editor.module.css:9-13`

```css
/* ReferenceChip.module.css:6-20 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 240px;
  padding: 0 6px;
  border-radius: 6px;
  vertical-align: bottom;
  line-height: 22px;
  height: 22px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-state-business-primary);
  user-select: none;
  cursor: default;
}

/* composer-editor.module.css:9-13 */
.textRef {
  color: var(--dsw-alias-state-business-primary);
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
```

#### 关键技术亮点：
1. **零行高抖动（Zero Line-Height Jitter）**：
   在富文本编辑器中插入 `@file` 或 `#issue` 等引用 Chip 时，最常见的 bug 是 Chip 的高度超出普通文本行，导致编辑过程中光标所在行上下跳动。
   - DeepSeek 的 Composer 文本基准行高为 24px；
   - `ReferenceChip` 严格将 `height` 与 `line-height` 锁死为 **22px**（略小于 24px 行高），配合 `vertical-align: bottom;`，使得 Chip 完美潜入行框内部，无论插入多少个 Chip，输入框的垂直节奏纹丝不动。
2. **透明度底色与品牌色文字**：
   底色采用 6% 蓝灰半透明的 `--dsw-alias-interactive-bg-hover`，文字采用 `--dsw-alias-state-business-primary`，清晰识别但绝不过分刺眼。
3. **软换行保护**：
   `composer-editor.module.css` 声明了 `box-decoration-break: clone;`，确保文本引用的圆角高亮在遇到跨行软折行（Soft-wrap）时，每一行末端和首端均能正确绘制圆弧边缘。

---

## 6. 与 Conex / Crish 的架构对比与落地重构清单

对照当前 Conex / Crish 桌面端界面的设计现状与 `reference/deepseek-harness` 的高标准，存在显著的架构差距与优化空间：

| 视觉维度 | DeepSeek-Harness 实现标杆 | Conex / Crish 现状与痛点 | 重构与落地建议 (Action Items) |
|---|---|---|---|
| **Token 体系** | 严格三层（Static -> Alias -> Specific），无一处 CSS 包含硬编码颜色 | 部分样式表存在旧式 `rgba(...)` 或直接硬编码 hex 色值，暗色主题存在色差 | 建立完整的 Token 映射表，功能组件一律只读取语义 Token |
| **边框与分隔线** | 0.5px 发丝描边内嵌于 `box-shadow`，平面 solid 边框一律 0.5px | 多数卡片使用 1px 实线边框，在 Retina 屏上显厚重视觉阻断 | 引入 `0.5px` 发丝边框与 `--dsw-elevation-*` 阴影内置发丝规范 |
| **用户气泡** | 70.2% 宽比，22px 超椭圆，42px 单行高度，下方 6px 间隙操作栏 | 用户气泡宽度常为 85%~90%，底色偏重，操作栏常贴边或挤在气泡内部 | 采用 `max-width: min(calc(W * 0.702), 82%)`，分离气泡与下方 6px 操作栏 |
| **Assistant 排版** | 完全无卡片、无外框，14px/24px 投射于 Canvas 画纸，块间距 16px | 常将 Assistant 整体用带边框的 Card 框起来，造成套娃感与视觉逼仄 | 彻底移除 Assistant 包裹外框，实现纯粹的 Markdown 画纸投射 |
| **次级信息阶梯** | Think、Tool、Table 统一读取 Secondary 阶梯（13px/20px），三级标签灰 | 思考过程与工具调用字号混乱，有时与正文同大（14px），层次不分明 | 统一收敛次级信息为 13px 字号、20px 行高与 tertiary 弱灰 |
| **输入框与焦点** | `border: 0`，soft 发丝阴影，无粗黑焦点框，仅品牌蓝光标引导 | 聚焦时偶见高对比度实心黑边或重阴影（违反 AGENTS.md §13） | 落实 AGENTS.md §13，焦点态仅保留柔软变化，对比度混入不超过 10% |
| **富文本 Chip** | 22px 药丸胶囊内嵌于 24px 行内，零撑开高度，无跳动 | 标签或 Chip 往往上下溢出行高，导致输入文字时光标与行间距晃动 | 将 ReferenceChip 高度锁死在 22px，并配置 `vertical-align: bottom` |

---

## 7. 结论

DeepSeek-Harness 的视觉设计并非简单的“追求极简”，而是一套经过严密数学度量、人机工程学思考与 CI 自动化工程守护的工业级视觉体系：
- 通过 **70.2% 用户气泡** 与 **纯净扁平 Assistant 画纸**，构筑了对话流中最高效的信息浏览动线；
- 通过 **发丝投影内嵌（Hairline Elevation）** 与 **0.5px 透明灰阶边框**，根除了传统客户端的笨重感；
- 通过 **14px/24px 正文与 13px/20px 次级阶梯**，保证了长文本技术阅读的极致舒适性。

该体系为 Conex / Crish 桌面端正文对话流界面的现代化重构提供了坚实的技术参考与落地蓝图。
