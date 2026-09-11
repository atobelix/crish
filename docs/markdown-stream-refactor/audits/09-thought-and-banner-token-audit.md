# 挑刺审查报告 09：思考链折叠与消息头尾 Token 体系严苛审查

> **审查范围**：
> - [`apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx)
> - [`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css)（行内思考链与时间线流式样式域）
> - [`apps/crish-desktop/src/components/chat-message/MessageContent.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx)（`ErrorMessageBanner` 及时间线降级渲染）
> - [`apps/crish-desktop/src/extensions/conversation-flow/narrative.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrative.module.css)
> - [`apps/crish-desktop/src/extensions/conversation-flow/ThinkingBlock.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/ThinkingBlock.tsx)
> - [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)
>
> **审查原则**：严禁中立叙述与夸奖套话，仅挑刺、仅列出硬编码反模式、Token 缺失断层、明暗主题对比度失效及架构双轨缺陷。

---

## 1. 缺陷总览与严重级别矩阵 (Defect Severity Matrix)

| 编号 | 缺陷分类 | 严重度 | 核心文件 / 符号 | 缺陷性质与定性 |
| :--- | :--- | :---: | :--- | :--- |
| **DEF-01** | 样式架构缺失 | 🔴 P0 | `TimelineThoughtSection.module.css` (缺失) | 独立组件未配备专属 CSS Module，寄生于 1086 行巨型 `ChatMessageRow.module.css` |
| **DEF-02** | 内联样式硬编码 | 🔴 P0 | [`MessageContent.tsx:51-68`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L51-L68) (`ErrorMessageBanner`) | 8 处内联样式属性硬编码，未抽离类名，每帧重新创建样式对象 |
| **DEF-03** | 幽灵 Token 与非法色值 | 🔴 P0 | [`MessageContent.tsx:54`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L54) | 引用未定义幽灵变量 `--bg-error-subtle`，回落至违规 Tailwind RGBA `rgba(239, 68, 68, 0.04)` |
| **DEF-04** | 暗色主题对比度崩塌 | 🔴 P0 | [`ChatMessageRow.module.css:638`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L638) | `#4a4a4a` 在 Dark 模式下对比度仅 **1.76:1**（严重违反 WCAG AA 4.5:1 门禁） |
| **DEF-05** | 幽灵 `--flow-*` 变量簇 | 🟠 P1 | `ChatMessageRow.module.css` / `InlineAgentPanel.module.css` | 10 余个 `--flow-*` 变量在 `tokens.css` 中**完全未定义**，全靠散落的硬编码 fallback 续命 |
| **DEF-06** | 双轨渲染视觉语言分裂 | 🟠 P1 | `TimelineThoughtSection` vs `ThinkingBlock` | 行内流与叙事插件双轨思考链在点状呼吸动画、文字、展开收起动画上完全割裂 |
| **DEF-07** | 暗色白雾与渐变插值缺陷 | 🟠 P1 | [`ChatMessageRow.module.css:794-807`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L794-L807) | 遮罩蒙版硬编码 `#ffffff` fallback，Dark 模式下存在白雾穿透与插值脏灰缺陷 |
| **DEF-08** | 排版数字与排版跳动 | 🟡 P2 | [`narrative.module.css:80-84`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrative.module.css#L80-L84) | `narrative` 耗时徽章缺失 `tabular-nums`，秒数递增引起宽度抖动；中英文单位混用 |
| **DEF-09** | Zero-Blue 与色彩过载 | 🟡 P2 | [`ChatMessageRow.module.css:550, 664`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L550) | 残留 `hsl(215 90% 52%)` 蓝光与过载霓虹绿 `#10b981`，违背克制沉浸规范 |

---

## 2. 思考链视觉 Token 体系严苛审查 (Thought Chain Token Defects)

### 2.1 样式文件物理缺失与巨型样式表耦合反模式 (Architecture Boundary Defect)
- **缺陷现状**：
  - 代码约定应存在 [`TimelineThoughtSection.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css)，但该文件**在文件系统中实际不存在**。
  - [`TimelineThoughtSection.tsx:12`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx#L12) 直接使用 `import styles from './ChatMessageRow.module.css'`。
- **架构毒点**：
  1. **职责污染**：`ChatMessageRow.module.css` 膨胀至 **1086 行**，混杂了消息行、头像、气泡、Pin、代码块骨架屏、思考链折叠、Plan 步骤脊柱、产物胶囊等所有样式，违反单组件单一样式表的高内聚原则。
  2. **类名泄露与测试脆化**：思考链内部类名（如 `.thoughtHeaderBtn`、`.thoughtScrollBody`）对外部完全可见，缺乏独立的封装边界。

### 2.2 幽灵 `--flow-*` Token 假体系 (Phantom Design Tokens)
- **审查事实**：在全仓库的核心设计系统文件 [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中全文检索 `--flow-`，**匹配结果为 0 处**！
- **缺陷清单**（全为未在 `:root` / `data-theme` 声明的幽灵变量）：
  1. `--flow-summary-indent`：在 [`ChatMessageRow.module.css:618`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L618) 中声明为 `var(--flow-summary-indent, 0.35em)`，基准 fallback 使用了非常规 `em` 单位。
  2. `--flow-font-meta`：在 [`ChatMessageRow.module.css:636`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L636) 中声明为 `var(--flow-font-meta, 13px)`，绕过了 `--font-size-sm` / `--font-size-chat` 等全局字体层级。
  3. `--flow-meta`：在 [`ChatMessageRow.module.css:638`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L638) 中声明为 `var(--flow-meta, var(--text-secondary, #4a4a4a))`，形成三层深嵌套回落。
  4. `--flow-meta-hover`：在 [`ChatMessageRow.module.css:649`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L649) 中声明为 `var(--flow-meta-hover, var(--text-primary, #2a2a2a))`。
  5. `--flow-meta-soft`：在 [`ChatMessageRow.module.css:1083`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L1083) 中声明为 `var(--flow-meta-soft, var(--text-tertiary, #5c5c5c))`。
  6. `--flow-chevron-color`：在 [`ChatMessageRow.module.css:737`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L737) 中声明为 `var(--flow-chevron-color, var(--text-tertiary, #a3a3a3))`。
  7. `--flow-chevron-hover`：在 [`ChatMessageRow.module.css:745`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L745) 中声明为 `var(--flow-chevron-hover, var(--text-secondary, #7a7a7a))`。
  8. `--flow-thinking-max-h`：在 [`ChatMessageRow.module.css:774, 811`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L774) 中声明为 `var(--flow-thinking-max-h, 168px)`，魔法数字 `168px` 无 Token 源头支持。

### 2.3 思考链展开内容区与滚动容器缺陷 (Scroll Body & Shimmer Defect)
- **内联样式穿透**：
  [`TimelineThoughtSection.tsx:128-132`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx#L128-L132)：
  ```tsx
  {isLive ? (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {content}
    </div>
  ) : ( ... )}
  ```
  在实时流式思考态下，直写内联 `style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}`，破坏 CSS Module 声明纯净性。
- **左侧微光条/边框指示条缺失**：
  `.thoughtTimelineSection` 设置了 `border: none; background: transparent;`，在多步交错推理（如第 1 阶段思考、第 2 阶段思考、工具调用嵌套）时，展开的思考正文完全缺乏左侧视觉对齐锚点（Shimmer Rail / Left Border），仅依赖 `padding-left: 0.35em`，导致用户在长文本流中极易发生视觉跳跃与上下文归属断层。

### 2.4 流式呼吸态（`isLive`）双轨割裂与视觉规范冲突 (Live Breathing Defect)
- **组件间严重分裂**：
  1. [`TimelineThoughtSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx)（核心原生）：使用 5px 翡翠绿脉冲高亮圆点（`.thoughtLiveDot`），伴随 `0 0 0 5px` 的 `thought-dot-pulse` 缩放光环扩散，标题文字变为高饱和翠绿 `var(--brand-deep, #059669)`。
  2. [`ThinkingBlock.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/ThinkingBlock.tsx)（叙事插件态）：使用 6px 纯灰淡入淡出圆点（`.pulse`），动画为 `flowPulse` 仅改变 `opacity: 0.7 -> 0.25`，标题保持普通文本色。
- **违规定性**：同一款产品中，开启与关闭叙事流模式时，核心状态「正在思考中」呈现出两套完全相反的设计语言（一套激进动效绿光，一套极简静态暗灰），严重破坏用户的心智模型一致性。

### 2.5 耗时徽章与排版数字规范缺陷 (Duration Badge & Typography Defects)
- **排版抖动缺陷**：
  - 在 [`narrative.module.css:80-84`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrative.module.css#L80-L84) 的 `.meta` 类中，**缺失 `font-variant-numeric: tabular-nums`**。
  - [`ThinkingBlock.tsx:43-48`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/ThinkingBlock.tsx#L43-L48) 在实时计时（1s、2s ... 10s）递增时，非等宽数字字形（如 `1` 与 `8` 宽度不一致）导致徽章宽度与整行文本发生周期性左右抖动（Layout Jitter）。
- **单位文案不统一反模式**：
  - [`TimelineThoughtSection.tsx:61-67`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx#L61-L67)：有 `turnIndex` 时输出 `2.4s`，无 `turnIndex` 时输出 `2.4秒`。
  - [`ThinkingTimer.tsx:35`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ThinkingTimer.tsx#L35)：输出 `${seconds}秒`。
  - [`ThinkingBlock.tsx:43-48`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/ThinkingBlock.tsx#L43-L48)：输出 `${liveSec}s`。
  - 存在随机的中英文混用（`s` vs `秒`），缺乏统一的格式化辅助函数。

---

## 3. 错误横幅与尾部状态硬编码反模式审查 (Error Message Banner Hardcoding)

### 3.1 `MessageContent.tsx` 中 `ErrorMessageBanner` 内联样式全量解剖
- **违规代码位置**：[`apps/crish-desktop/src/components/chat-message/MessageContent.tsx:43-70`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L43-L70)
```tsx
const ErrorMessageBanner: React.FC<{
  errorDetail?: SessionMessage['errorDetail'];
  className?: string;
}> = ({ errorDetail, className }) => (
  <div
    className={`${styles.timelineText} ${className || ''}`}
    style={{ width: '100%' }}                                    // ❌ [DEF-H01] 内联 width 100%
  >
    <div
      style={{
        padding: '10px 14px',                                    // ❌ [DEF-H02] 内联魔法数字 padding
        background: 'var(--bg-error-subtle, rgba(239, 68, 68, 0.04))', // ❌ [DEF-H03] 幽灵 Token + Tailwind RGBA
        border: '1px solid var(--border-color)',                 // ❌ [DEF-H04] 内联硬编码边框
        borderRadius: 6,                                         // ❌ [DEF-H05] 魔法数字 6 而非 var(--radius-md)
        fontSize: 13,                                            // ❌ [DEF-H06] 魔法数字 13 而非 var(--font-size-sm)
        color: 'var(--text-secondary)',                          // ❌ [DEF-H07] 错误描述文本误用次级文本色
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,                                                  // ❌ [DEF-H08] 魔法数字 8 而非 var(--space-2)
      }}
    >
      <AlertCircle size={13} style={{ color: 'var(--color-error)' }} /> // ❌ [DEF-H09] 魔法尺寸 13 + 内联 color
      <span>
        {errorDetail?.message || '服务暂时不可用，请检查网络或后端配置'}
      </span>
    </div>
  </div>
);
```

### 3.2 错误横幅硬编码清单与违规定性

1. **违背 React 性能最佳实践**：
   - 每一次 `MessageContent` 渲染时，内联对象字面量 `{ padding: '10px 14px', ... }` 都会在堆上重新分配内存，导致子元素浅比较永远失效。
2. **幽灵变量 `--bg-error-subtle`**：
   - 全仓库未定义 `--bg-error-subtle`，该变量形同虚设。
3. **Tailwind RGBA 渗漏**：
   - `rgba(239, 68, 68, 0.04)` 为硬编码的红-500 色阶，严重违反 **AGENTS.md §14**「优先 HSLA / 斜杠透明度」铁律（应使用 `hsl(0 84% 60% / 0.04)` 或 design token `--color-error-bg` / `--sep-danger-light`）。
4. **图标尺寸非标**：
   - `size={13}` 属于既非 `--icon-size` (16px) 也非 `--icon-size-sm` (14px) 的随意手写值。
5. **暗色背景对比度彻底失效**：
   - 在暗色模式（底色 `#0c0c0b`）下，4% 红色透明度生成的背景色为 `rgb(21, 14, 13)`，与 `#0c0c0b` 的亮度对比度仅 **1.05:1**，错误横幅背景完全不可见，只剩孤立的边框线与红色图标，观感极为破碎。

---

## 4. 明暗主题与 HSLA 现代色彩规范合规性审查 (Theme & HSLA Compliance)

### 4.1 暗色主题下 WCAG AA 对比度崩塌清单 (Contrast Failures in Dark Mode)

| 位置 / 选择器 | 实际使用的色值 / 回落 | 背景色 (Dark) | 实际对比度 | WCAG AA 门禁 (4.5:1) | 缺陷定性 |
| :--- | :--- | :--- | :---: | :---: | :--- |
| [`ChatMessageRow.module.css:638`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L638) (`.thoughtHeaderBtn`) | `#4a4a4a` | `#0c0c0b` | **1.76:1** | ❌ 严重不达标 | 思考链折叠头文字在暗色下近乎隐形 |
| [`ChatMessageRow.module.css:649`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L649) (`.thoughtHeaderBtn:hover`) | `#2a2a2a` | `#0c0c0b` | **1.28:1** | ❌ 严重不达标 | Hover 时本应变亮，反而回落到更黑的 `#2a2a2a` |
| [`ChatMessageRow.module.css:737`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L737) (`.thoughtChevron`) | `#a3a3a3` | `#0c0c0b` | **4.91:1** | ⚠️ 勉强及格 | 硬编码浅灰，在浅色模式对比度仅 2.45:1 (失效) |
| [`ChatMessageRow.module.css:745`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L745) (`.thoughtChevron:hover`) | `#7a7a7a` | `#0c0c0b` | **3.08:1** | ❌ 不达标 | Hover 反向变暗 |
| [`MessageContent.tsx:54`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L54) (`ErrorMessageBanner` 背景) | `rgba(239,68,68,0.04)` | `#0c0c0b` | **1.05:1** | ❌ 严重不达标 | 背景不可见 |

### 4.2 渐变遮罩白雾穿透与插值泥泞缺陷 (Gradient Alpha Interpolation Bug)

1. **白雾穿透**：
   [`ChatMessageRow.module.css:790-808`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L790-L808)：
   ```css
   .thinkingBodyContainer::before {
     top: 0;
     background: linear-gradient(
       to bottom,
       var(--bg-page, #ffffff) 0%,
       color-mix(in srgb, var(--bg-page, #ffffff) 88%, transparent) 40%,
       transparent 100%
     );
   }
   ```
   - **缺陷**：回落值写死为 `#ffffff`。当在暗色模式组件树局部未继承到 `--bg-page` 或层级处于 `--bg-card` / `--bg-elevated` 上时，回落为纯白渐变遮罩，导致暗色思考文本上方被白雾严重遮挡。
2. **渐变泥泞与灰带 (Premultiplied Alpha Bug)**：
   [`narrative.module.css:198-208`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrative.module.css#L198-L208)：
   ```css
   .previewFade {
     position: absolute;
     inset: 0 0 0 auto;
     width: 56px;
     background: linear-gradient(
       to right,
       hsl(0 0% 100% / 0),
       var(--bg-primary)
     );
     pointer-events: none;
   }
   ```
   - **缺陷**：起始色使用了 `hsl(0 0% 100% / 0)`（白色透明）。在暗色模式下，终点色为极黑底色（`#0c0c0b`，即 `hsl(60 4.3% 4.5%)`）。在默认 sRGB 空间进行线性插值时，中点会出现 `rgb(133, 133, 133, 0.5)` 的**脏灰色带**，导致预览文字末尾出现明显的脏污晕影。

### 4.3 Zero-Blue 铁律与高饱和色彩过载 (Zero-Blue & Brand Overload)

1. **Zero-Blue 违规**：
   [`ChatMessageRow.module.css:550, 552`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L550-L552)：
   ```css
   outline: 1px dashed var(--accent-color, hsl(215 90% 52%));
   background: color-mix(in srgb, var(--accent-color, hsl(215 90% 52%)) 4%, transparent);
   ```
   在表格流式单元格状态下，fallback 写死了高饱和电光蓝 `hsl(215 90% 52%)`，违反了仓库全局去蓝化（Zero-Blue）的纯中性墨阶要求。
2. **霓虹绿光刺眼过载**：
   `ChatMessageRow.module.css` 中的 `.thoughtLiveDot`（664行）、`.flowPlanStep.isRunning .flowPlanStepNum`（913行）、`.flowSyncDot`（1062行）全部使用高饱和翠绿 `#10b981` 与 `#059669`，在暗色背景下呈现出强烈的荧光噪点感，与全局 `--sep-accent-color: hsl(160 84% 45%)` 规范脱节。

---

## 5. 散落式硬编码与非法色彩全景清单 (Complete Hardcoded Values Inventory)

以下为在本次审查范围内排查出的全部硬编码色值、非标透明度与魔法数字清单：

| 序号 | 所在文件路径与行号 | 硬编码源码片段 | 违规类型 | 规范整改建议 |
| :---: | :--- | :--- | :--- | :--- |
| 1 | [`MessageContent.tsx:53`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L53) | `padding: '10px 14px'` | 内联魔法数字 | 移至 CSS Module `var(--space-2) var(--space-3)` |
| 2 | [`MessageContent.tsx:54`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L54) | `rgba(239, 68, 68, 0.04)` | Tailwind RGBA / 幽灵 Token | 使用 `var(--color-error-bg)` 或 `var(--sep-danger-light)` |
| 3 | [`MessageContent.tsx:56`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L56) | `borderRadius: 6` | 魔法数字 | 使用 `var(--radius-md)` |
| 4 | [`MessageContent.tsx:57`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L57) | `fontSize: 13` | 魔法数字 | 使用 `var(--font-size-sm)` |
| 5 | [`MessageContent.tsx:61`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L61) | `gap: 8` | 魔法数字 | 使用 `var(--space-2)` |
| 6 | [`MessageContent.tsx:64`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.tsx#L64) | `<AlertCircle size={13} />` | 非标图标尺寸 | 使用 `var(--icon-size-sm, 14)` |
| 7 | [`TimelineThoughtSection.tsx:129`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx#L129) | `style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}` | 内联样式 | 纳入 CSS Module `.thoughtLiveContent` 类 |
| 8 | [`ThinkingBlock.tsx:50-53`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/ThinkingBlock.tsx#L50-L53) | `['--flow-output-max' as string]: ...` | 内联 CSS 变量注入 | 下沉至 CSS 默认变量定义 |
| 9 | [`ChatMessageRow.module.css:638`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L638) | `#4a4a4a` | 硬编码 Hex (暗色失效) | 统一使用 `var(--text-secondary)` |
| 10 | [`ChatMessageRow.module.css:649`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L649) | `#2a2a2a` | 硬编码 Hex (暗色失效) | 统一使用 `var(--text-primary)` |
| 11 | [`ChatMessageRow.module.css:664`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L664) | `#10b981` | 硬编码 Hex 霓虹绿 | 统一使用 `var(--sep-accent-color)` |
| 12 | [`ChatMessageRow.module.css:686`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L686) | `#059669` | 硬编码 Hex | 统一使用 `var(--sep-accent-color)` |
| 13 | [`ChatMessageRow.module.css:737`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L737) | `#a3a3a3` | 硬编码 Hex | 统一使用 `var(--text-tertiary)` |
| 14 | [`ChatMessageRow.module.css:745`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L745) | `#7a7a7a` | 硬编码 Hex | 统一使用 `var(--text-secondary)` |
| 15 | [`ChatMessageRow.module.css:774`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L774) | `168px` | 魔法数字高度 | 定义为规范 Token `--thought-scroll-max-h` |
| 16 | [`ChatMessageRow.module.css:794`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L794) | `#ffffff` (渐变蒙版) | 暗色白雾缺陷 | 使用 `var(--bg-canvas)` 或 `var(--bg-card)` |
| 17 | [`ChatMessageRow.module.css:858`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L858) | `rgba(0, 0, 0, 0.15)` | 非 HSLA RGBA | 使用 `hsl(0 0% 0% / 0.15)` 或 `var(--border-color)` |
| 18 | [`ChatMessageRow.module.css:901`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L901) | `rgba(0, 0, 0, 0.15)` | 非 HSLA RGBA | 使用 `var(--border-color)` |
| 19 | [`ChatMessageRow.module.css:902`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L902) | `rgba(0, 0, 0, 0.03)` | 非 HSLA RGBA | 使用 `var(--shadow-sm)` |
| 20 | [`ChatMessageRow.module.css:909`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L909) | `rgba(0, 0, 0, 0.25)` | 非 HSLA RGBA | 使用 `var(--hairline-strong)` |
| 21 | [`ChatMessageRow.module.css:1030`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L1030) | `rgba(16, 185, 129, 0.35)` | 非 HSLA RGBA | 使用 `hsl(160 84% 39% / 0.35)` |
| 22 | [`narrative.module.css:204`](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrative.module.css#L204) | `hsl(0 0% 100% / 0)` | 暗色灰带插值缺陷 | 使用 `color-mix(in srgb, var(--bg-primary) 0%, transparent)` |

---

## 6. 整改收敛蓝图建议 (Actionable Architecture Recommendations)

1. **建立物理独立的 CSS Module**：
   - 创建 [`TimelineThoughtSection.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css)，将 `ChatMessageRow.module.css` 中的 612–825 行完全剥离并独立维护。
2. **在 `tokens.css` 中显式登记思考链与错误条命名空间**：
   - 彻底废除幽灵 `--flow-*` 前缀，统一定义标准的思考链 Token 体系：
     ```css
     /* tokens.css: Light / Dark 均需定义 */
     --thought-header-fg: var(--text-secondary);
     --thought-header-hover-fg: var(--text-primary);
     --thought-chevron-fg: var(--text-tertiary);
     --thought-live-dot: var(--sep-accent-color);
     --thought-scroll-max-h: 168px;
     --thought-body-fg: var(--text-secondary);
     --banner-error-bg: var(--color-error-bg);
     --banner-error-border: var(--color-error-border);
     --banner-error-fg: var(--text-primary);
     ```
3. **彻底根除 `ErrorMessageBanner` 的内联样式**：
   - 在 [`ChatMessageRow.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css) 或新建的 `ErrorMessageBanner.module.css` 中声明 `.errorBanner` 类，完全使用标准 CSS 变量（`var(--radius-md)`、`var(--font-size-sm)`、`var(--space-2)`、`var(--color-error-bg)`）。
4. **抹平双轨思考链视觉分叉**：
   - 将 `ThinkingBlock`（叙事插件）与 `TimelineThoughtSection`（核心原生）的脉冲动画、耗时徽章、`tabular-nums` 样式收敛为单一底层 DOM 结构或复用同一样式模块。
