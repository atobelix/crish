# 限高滚动容器上下边缘渐隐（ScrollFade）覆盖与层级深度分析报告

> 战役工作区：`docs/tool-experience-and-sandbox-repair/`  
> 责任席位：子 Agent A7（Scroll Fade Inspector）  
> 调研目标：深入排查并强化所有带有高度限制（`max-height`）的滚动容器的“上下区域透明度渐隐”（ScrollFade）覆盖、视觉清晰度与层级归属，彻底根除“分不出来谁属于谁”的排版与边界模糊问题。

---

## 一、用户诉求与体验问题本质剖析

### 1. 用户核心原话与痛点反馈

用户在实际交互体验中明确指出：
> **“还有就是只要是这种带有高度限制的容器，上下区域都是要加上透明度渐变的，不然的话分不出来谁属于谁。”**

这一反馈极其精准地指出了当前界面在内容流滚动排版上的深层体验断层。用户之所以会产生**“分不出来谁属于谁”**的强烈困惑，并非单纯觉得“渐变好不好看”，而是因为在当前的 DOM 渲染和样式机制中，多个相邻的限高容器、工具行与输入/输出面板在发生滚动裁切时，由于**缺少上下双向的平滑渐变过度**，内容呈现出冰冷生硬的“刀切感”，文字与代码行在边界处发生硬性贴边甚至上下串联，使得用户的视觉动线无法辨识一段文字究竟属于上一个工具的输出、当前工具的输入、还是后续步骤的附属信息。

---

### 2. “分不出来谁属于谁”的五大根因穿透

通过对前端视口渲染、滚动状态机以及 CSS 规则的逐行勘察，我们定位出导致该问题的五大核心根因：

```
                    ┌────────────────────────────────────────────────────────┐
                    │  用户痛点：“分不出来谁属于谁” (Boundary Ambiguity)     │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
        ┌──────────────────────┬───────────────┴──────────────┬──────────────────────┐
        ▼                      ▼                              ▼                      ▼
【根因 1：组内降格陷阱】  【根因 2：Mask 曲线断崖】   【根因 3：端态单向硬切】  【根因 4：零内边距削头】
.tool-group-scroll-host   --tool-fade-size 仅 28px   scrollTop=0 顶端 0 遮罩   .toolSectionContent
强制下级 overflow:visible 10px 内 45% 坠跌急刹车     触底时底端 0 遮罩        padding: 0 紧贴边缘
状态机被逼返回 'none'     如刀砍裁切毫无烟雾感       内容与相邻外壳硬性撞车    文字字符半腰横断
```

#### 根因 1：组内多工具的“滚动层级降格陷阱”（最大盲区）
在日常多 Agent 与复杂任务中，一轮对话往往包含 2 个以上的连续工具调用，此时容器会以 `FoldableToolGroup`（工具组）呈现。
而在 `ChatToolCallBlock.module.css:736-750` 中，存在一条硬性规则：
```css
:global(.tool-group-scroll-host) .toolSectionContent {
  max-height: none;
  overflow-y: visible;
}
:global(.tool-group-scroll-host) .toolShellCmdViewport {
  max-height: none;
  overflow-y: visible;
}
```
**致命连锁反应**：当工具进入工具组后，为了避免双层嵌套滚动，单个工具的视口被重设为 `overflow-y: visible` 且 `max-height: none`。
在 `useScrollFade.ts:65-69` 的状态机中：
```ts
const overflowY = window.getComputedStyle(host).overflowY;
const next: ScrollFadeState =
  overflowY === 'auto' || overflowY === 'scroll'
    ? computeScrollFadeState(host)
    : 'none';
```
由于 `overflowY` 被覆盖为 `visible`，状态机**恒定判定为 `'none'`**！
这导致在工具组内部：
- 工具 1 的 200 行输出直接无限纵向展开；
- 工具 1 的末尾与工具 2 的头部之间**没有任何局部渐隐**；
- 工具 1 的输出、工具 2 的输入、工具 2 的输出全部平铺在同一个 560px 的大组滚筒内。
用户滚动大组时，多工具的等宽字符在屏幕内连成一片，**完全分不出来哪几行属于 Tool 1，哪几行属于 Tool 2**！

#### 根因 2：现存 Mask 遮罩带高过窄（28px）与 Alpha 曲线断崖
在 `styles/scroll-fade.css:18-71` 中，现有的渐变实现为：
```css
[data-fade='bottom'] > .scroll-fade-inner {
  mask-image: linear-gradient(
    to bottom,
    #000 0,
    #000 calc(100% - var(--tool-fade-size, 28px)),
    rgba(0, 0, 0, 0.45) calc(100% - var(--tool-fade-size, 28px) * 0.36),
    transparent 100%
  );
}
```
- **带高过窄**：`--tool-fade-size` 仅设为 `28px`。在 12px~13px 字号、1.5~1.65 行高（单行高度约 18px~21.5px）的文本环境中，28px 仅仅覆盖了不到 1.5 行文本！
- **断崖陡坡**：渐变在距离边缘 `28px * 0.36 = 10.08px` 处，透明度依然高达 `45%`（`rgba(0, 0, 0, 0.45)`）。这意味着从 100% 跌落到 45% 花费了 18px，而从 45% 彻底变透明仅给了 **10px**！
- **视觉物理表现**：普通字符的 x-height 约为 7-9px。在仅 10px 的区间内骤降至透明，人眼感官根本感受不到柔和过渡，而是感觉**字符被从腰部齐刷刷地切成两半**，呈现为刺眼的锯齿状残缺。

#### 根因 3：四态状态机的“端态单向硬切”设计缺陷
`useScrollFade.ts:35-40` 的纯函数判定为：
```ts
export function computeScrollFadeState(m: ScrollMetrics): ScrollFadeState {
  if (m.scrollHeight - m.clientHeight <= 1) return 'none';
  if (m.scrollTop <= 1) return 'bottom';
  if (m.scrollTop + m.clientHeight >= m.scrollHeight - 1) return 'top';
  return 'both';
}
```
- **初始打开视口（`scrollTop = 0`）**：状态为 `'bottom'`。此时**顶部遮罩为 0**（`#000 0`）。第一行代码或文本紧紧贴在视口最上方，没有丝毫顶部渐隐！若上方紧邻输入面板，输入文字与输出首行直接发生硬碰撞。
- **用户滚动触底（`scrollTop + clientHeight >= scrollHeight - 1`）**：状态切为 `'top'`。此时**底部遮罩为 0**。最后一行输出直接撞击容器下边缘硬线。
- **状态切换离散无过渡**：状态机直接通过 `host.dataset.fade = next` 切换，CSS 中没有任何过渡插值。滚动到顶部或底部的瞬间，边缘遮罩突然“瞬时闪烁消失”，造成生硬的跳跃感。

#### 根因 4：内部内容零内边距（`padding: 0`）造成“贴边削头”
在 `ChatToolCallBlock.module.css:708-717` 中：
```css
.toolSectionContent {
  padding: 0;
  overflow-x: auto;
  overflow-y: auto;
  ...
}
```
容器内容内边距直接定为 0。当发生滚动且顶部或底部遮罩生效时，渐变是从物理像素坐标 0 开始衰减的。文字本身没有任何缓冲呼吸空间，一进入视口边缘就直接被渐变啃噬，加剧了界面失衡与排版窒息感。

#### 根因 5：部分限高容器为“漏网之鱼”，未接入 `ScrollFadeRegion`
在整个桌面应用中，存在多个带有明确 `max-height` 限制的纵向滚动容器，却因历史原因被写成了原生 `<div>` 或 `<pre>`，完全没有任何渐隐遮罩机制（见下文审计清单）。

---

## 二、限高滚动容器全景清单与渐隐挂载现状审计

通过对 `apps/crish-desktop/src` 展开的全局扫描与 AST/CSS 审查，梳理出会话消息流及工具调用链路中所有**带高度限制（`max-height`）且具备纵向滚动**的容器现状：

### 1. 限高滚动容器全景矩阵表

| 序号 | 容器名称与业务角色 | 对应源文件与行号 | 限高规则 / Token | 渐隐挂载现状 | 核心缺陷与表现 |
| :---: | :---|---|---|:---:|---|
| **01** | **终端命令单行视口**<br>`.toolShellCmdViewport` | `ToolCallInputPane.tsx:107`<br>`ChatToolCallBlock.module.css:821` | `var(--tool-viewport-input)`<br>(180px) | ✅ **已挂载**<br>(形态 A: `innerAs="pre"`) | 组内被覆盖为 `visible` 导致 `fade` 失效；28px 遮罩过窄；顶端无渐隐。 |
| **02** | **通用工具入参视口**<br>`.toolSectionInput .toolSectionContent` | `ToolCallInputPane.tsx:210`<br>`ChatToolCallBlock.module.css:719` | `var(--tool-viewport-input)`<br>(180px) | ✅ **已挂载**<br>(形态 A: `<ScrollFadeRegion>`) | 结构化表格长内容时，组内同样被降级失效；上端贴边。 |
| **03** | **工具多卡输出视口**<br>`.toolSectionOutput .toolSectionContent` | `ToolCallOutputPane.tsx:274`<br>`ChatToolCallBlock.module.css:723` | `var(--tool-viewport-output)`<br>(380px) | ✅ **已挂载**<br>(形态 A: `<ScrollFadeRegion>`) | 组内降级陷阱导致大段日志与下一工具首尾相连；28px 坡度过陡。 |
| **04** | **工具单卡输出视口**<br>`.toolResultBodySingle ... .toolSectionContent` | `ToolCallOutputPane.tsx:274`<br>`ChatToolCallBlock.module.css:727` | `var(--tool-viewport-output-single)`<br>(min(480px, 50vh)) | ✅ **已挂载**<br>(形态 A: `<ScrollFadeRegion>`) | 虽不受组降级影响，但顶端/底端单向硬切导致边界模糊。 |
| **05** | **多工具组体滚动宿主**<br>`.groupBodyInner` | `FoldableToolGroup.tsx:385`<br>`FoldableToolGroup.module.css:143` | `var(--tool-aggregate-max-h)`<br>(min(560px, 60vh)) | ✅ **已挂载**<br>(形态 A: `<ScrollFadeRegion>`) | 虽外层有渐隐，但其内部包含多个子工具，内部子工具无边界，组内混沌。 |
| **06** | **过程折叠段体滚动宿主**<br>`.sectionBodyInner` | `FoldableProcessSection.tsx:373`<br>`FoldableProcessSection.module.css:145` | `var(--tool-aggregate-max-h)`<br>(min(560px, 60vh)) | ✅ **已挂载**<br>(形态 A: `<ScrollFadeRegion>`) | 单工具模式下与内部子工具出现双层滚动与双层渐隐重叠。 |
| **07** | **思考过程折叠视口**<br>`.reasoningBody` | `ReasoningRow.tsx:520`<br>`ReasoningRow.module.css:290` | `var(--reasoning-max-h)`<br>(min(360px, 40vh)) | ✅ **已挂载**<br>(形态 A: `<ScrollFadeRegion>`) | 流式输出阶段文本频繁跳动，28px 遮罩在暗色模式下几乎不可辨。 |
| **08** | **Markdown 正文代码块**<br>`.md-code-pre` | `markdown-typography.css:783`<br>`MarkdownSurface.tsx:bindScrollFadesIn` | `var(--code-block-max-h)`<br>(min(480px, 50vh)) | ✅ **已挂载**<br>(形态 C: 命令式注入) | 仅针对 `> code`，折叠态（`md-code-collapsed`）混用 `::after` 产生双轨冲突。 |
| **09** | **独立态 Diff 差异比对卡片**<br>`.diffLinesContainer` | `ToolCallDiffPreview.tsx:169`<br>`ToolCallDiffPreview.module.css:199` | `var(--tool-viewport-output-single)`<br>(min(480px, 50vh)) | ❌ **未挂载**<br>(原生 `<div>`) | **高频盲区**！非 embedded 变体有 480px 封顶，但无任何渐隐，首尾硬切严重。 |
| **10** | **高危操作审批命令视口**<br>`.approvalCardCmd` | `ApprovalAskCard.tsx:561`<br>`ApprovalAskCard.module.css:149` | `max-height: 4.5em`<br>(约 72px) | ❌ **未挂载**<br>(原生 `<code>`) | 超过 3 行的长命令出现原生内部滚动，无上下渐隐，上下文字被斩断。 |
| **11** | **目标/计划抽屉步骤列表**<br>`.planStepListInner` | `ComposerPlanProgressBar.tsx:116`<br>`ComposerPlanProgressBar.module.css:46` | `var(--expand-max-h-viewport)`<br>(380px) | ❌ **未挂载**<br>(原生 `<div>`) | 计划步骤超过 6 项时滚动，顶部与底部步骤直接贴边消失。 |
| **12** | **叙事流思考与详情视口**<br>`.detail`, `.thinkingFull`, `.subagentBody` | `extensions/conversation-flow/`<br>`narrative.module.css:211` | `var(--expand-max-h-content)`<br>(min(480px, 50vh)) | ❌ **未挂载**<br>(原生容器) | 扩展流中的大段内容缺乏渐隐，与主对话流边界混淆。 |

---

## 三、渐隐遮罩 CSS Mask 实现缺陷技术诊断

### 1. 渐变数学模型分析：线性陡坡与人眼感知落差

当前 `scroll-fade.css` 所采用的三阶渐变公式：
$$\text{Alpha}(y) = 
\begin{cases} 
1.0 & 0 \le y \le L - 28\text{px} \\
1.0 \to 0.45 & L - 28\text{px} < y \le L - 10.08\text{px} \quad (\Delta y = 17.92\text{px}, \text{斜率 } \approx -0.0307/\text{px}) \\
0.45 \to 0.0 & L - 10.08\text{px} < y \le L \quad (\Delta y = 10.08\text{px}, \text{斜率 } \approx -0.0446/\text{px})
\end{cases}$$

#### 缺陷可视化比对：
```
当前 28px 三阶折线模型：
100% |────────────────────────────\
     |                             \  (0.45)
 50% |                              \
     |                               \
  0% |────────────────────────────────\─────
     0px                      17.9px  28px (终点)
     ▲ 漫长的 100% 区域        ▲ 10px 内急剧跌落至 0（断崖式切断）

理想 40px 平滑 Ease-Out 五阶流线模型：
100% |─────────────────────\
     |                      \
 50% |                       \
     |                        \
  0% |                         `───────.....
     0px                15px    25px    40px (柔和羽化消融)
```
- **问题实质**：人眼对光强和透明度的感知是非线性的（接近对数感知）。当前在最后 10px 内从 0.45 砸到 0，在视觉感受上就是一个带有抗锯齿微晕的“硬斩刀”，完全起不到“内容正缓缓隐入背景”的心理提示。

---

### 2. 状态机切换跳变与 DOM 重排冲突

在 `useScrollFade.ts` 中：
```ts
const update = () => {
  raf = 0;
  if (disposed) return;
  if (!host.isConnected) {
    detach();
    return;
  }
  const overflowY = window.getComputedStyle(host).overflowY;
  const next: ScrollFadeState =
    overflowY === 'auto' || overflowY === 'scroll'
      ? computeScrollFadeState(host)
      : 'none';
  if (host.dataset.fade !== next) {
    host.dataset.fade = next;
  }
};
```
1. **未分离滚动监听与几何测高**：每次滚动都会触发 `computeScrollFadeState`，当 `scrollTop` 从 0 变为 1 时，`dataset.fade` 从 `'bottom'` 跳到 `'both'`。
2. **缺乏 CSS 变量插值过渡**：由于直接替换 `data-fade` 属性，浏览器必须在下一帧重新解析整条 `mask-image` 规则，导致边缘遮罩在用户刚刚滑动滚轮的瞬间“啪”地一下凭空出现，伴随肉眼可见的帧闪。

---

### 3. 组内滚动降级对单工具渐隐的“误杀”

在 `ChatToolCallBlock.module.css:736-750` 中，为了防止出现“大滚筒套小滚筒”的糟糕手势体验，HC1 引入了滚动层级唯一化：
```css
:global(.tool-group-scroll-host) .toolSectionContent {
  max-height: none;
  overflow-y: visible;
}
```
**设计本意**：不让用户在一个只有 560px 的窗口内，鼠标悬停在某个 180px 的小盒子里滚不动外层。
**未预料的副作用**：`overflow-y: visible` 直接摧毁了 `useScrollFade` 的工作前提。结果就是：**双层滚动被消除了，但单工具的视觉边界也彻底消失了**！工具 1 和工具 2 变成了同一张白纸上的两段连续文本，没有任何分界。

---

## 四、上下双向平滑渐隐系统级增强方案

为了彻底解决“分不出来谁属于谁”的排版困境，同时严格遵守反退避与架构优雅原则，提出以下系统性增强方案：

```
                    ┌────────────────────────────────────────────────────────┐
                    │      上下双向平滑渐隐系统级增强方案架构                │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
        ┌──────────────────────┬───────────────┴──────────────┬──────────────────────┐
        ▼                      ▼                              ▼                      ▼
【维度 1：Token 与 Mask】 【维度 2：双端柔和羽化】   【维度 3：微内边距隔离】  【维度 4：组件挂载补齐】
--tool-fade-size 扩至 40px   顶底端保留 4-6px 微羽化   .toolSectionContent    全面补齐 DiffCard、
5 阶 cubic 平滑曲线遮罩      彻底消除首尾硬切撞车      引入 6px 垂直呼吸内边距   ApprovalAsk、Plan 等
```

---

### 1. 维度一：视觉规范与 CSS Mask 数学模型重构

#### (1) 带高 Token 升级与分档扩展
在 `apps/crish-desktop/src/styles/tokens-base.css` 中，将渐隐带高基准值从 28px 升级至 **40px**，并确立规范分档：
```css
/* ── 滚动区边缘渐隐带高（ScrollFade 升级定案） ── */
--tool-fade-size-sm: 24px;   /* 微型视口（命令单行、审批卡片等 ≤100px 容器） */
--tool-fade-size: 40px;      /* 标准视口（工具入参/出参、思考区、代码块 180~480px 容器） */
--tool-fade-size-lg: 52px;   /* 巨型聚合视口（工具大组、过程段体 ≥560px 容器） */
```

#### (2) 5 阶非线性平滑 Ease 渐隐曲线设计
全面废弃现有的 3 阶折线，采用符合人眼对数感知的 5 阶平滑 Ease 渐隐曲线（类似 iOS 滚动边缘与 Figma 现代遮罩方案）：
- `0%` 位置：`transparent` (完全透明)
- `25%` 位置：`rgba(0, 0, 0, 0.08)` (极轻微微光，打破硬切界限)
- `50%` 位置：`rgba(0, 0, 0, 0.35)` (柔和过渡中间态)
- `75%` 位置：`rgba(0, 0, 0, 0.75)` (加速显现主体)
- `90%` 位置：`rgba(0, 0, 0, 0.95)` (平滑接入实色)
- `100%` 位置：`#000` (完全实色不透明)

在 `apps/crish-desktop/src/styles/scroll-fade.css` 中重塑：
```css
/* 顶端单向渐隐（向上滚动到末尾查看顶部内容时） */
[data-fade='top'] > .scroll-fade-inner {
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    rgba(0, 0, 0, 0.08) calc(var(--tool-fade-size, 40px) * 0.25),
    rgba(0, 0, 0, 0.35) calc(var(--tool-fade-size, 40px) * 0.5),
    rgba(0, 0, 0, 0.75) calc(var(--tool-fade-size, 40px) * 0.75),
    rgba(0, 0, 0, 0.95) calc(var(--tool-fade-size, 40px) * 0.9),
    #000 var(--tool-fade-size, 40px),
    #000 100%
  );
}

/* 底端单向渐隐（初始在顶部查看下方内容时） */
[data-fade='bottom'] > .scroll-fade-inner {
  mask-image: linear-gradient(
    to bottom,
    #000 0,
    #000 calc(100% - var(--tool-fade-size, 40px)),
    rgba(0, 0, 0, 0.95) calc(100% - var(--tool-fade-size, 40px) * 0.9),
    rgba(0, 0, 0, 0.75) calc(100% - var(--tool-fade-size, 40px) * 0.75),
    rgba(0, 0, 0, 0.35) calc(100% - var(--tool-fade-size, 40px) * 0.5),
    rgba(0, 0, 0, 0.08) calc(100% - var(--tool-fade-size, 40px) * 0.25),
    transparent 100%
  );
}

/* 双端全向渐隐（居中滚动时，上下双向平滑裁剪） */
[data-fade='both'] > .scroll-fade-inner {
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    rgba(0, 0, 0, 0.08) calc(var(--tool-fade-size, 40px) * 0.25),
    rgba(0, 0, 0, 0.35) calc(var(--tool-fade-size, 40px) * 0.5),
    rgba(0, 0, 0, 0.75) calc(var(--tool-fade-size, 40px) * 0.75),
    rgba(0, 0, 0, 0.95) calc(var(--tool-fade-size, 40px) * 0.9),
    #000 var(--tool-fade-size, 40px),
    #000 calc(100% - var(--tool-fade-size, 40px)),
    rgba(0, 0, 0, 0.95) calc(100% - var(--tool-fade-size, 40px) * 0.9),
    rgba(0, 0, 0, 0.75) calc(100% - var(--tool-fade-size, 40px) * 0.75),
    rgba(0, 0, 0, 0.35) calc(100% - var(--tool-fade-size, 40px) * 0.5),
    rgba(0, 0, 0, 0.08) calc(100% - var(--tool-fade-size, 40px) * 0.25),
    transparent 100%
  );
}
```

---

### 2. 维度二：终结首尾硬切——“端态微羽化”（Micro-Feathering）机制

用户原话提到：“只要是这种带有高度限制的容器，上下区域都是要加上透明度渐变的”。
如果严格执行物理绝对判定（在顶端完全不渐隐、在底端完全不渐隐），那么只要用户处于顶部或底部，界面就会立刻退化为“硬切”。

为此，我们设计**端态微羽化（Micro-Feathering）**：
- 当容器处于 `bottom`（在顶端）时，顶部并非生硬的 `#000 0`，而是施加一个极浅的微羽化（例如 6px 内从 `rgba(0,0,0,0.85)` 到 `#000`），让首行文字不会直接撞死在容器内壁上。
- 当容器处于 `top`（在底端）时，底端同样保留 6px 的微羽化。
- 当容器处于可滚动状态时，始终维持明确的“受限视口”立体感知，无论停留在哪一帧，都不会出现锯齿状刀砍切口。

---

### 3. 维度三：内边距协同与边界防粘连（与 A3 席位联动）

在 `ChatToolCallBlock.module.css` 中：
1. **给 `.toolSectionContent` 恢复上下安全内边距**：
   将目前的 `padding: 0;` 调整为：
   ```css
   .toolSectionContent {
     padding: 6px 0 8px 0; /* 垂直 6px/8px 呼吸槽，使 mask 渐隐不直接蚕食首行文字核心高度 */
     ...
   }
   ```
2. **多工具组内边界重构（解决根因 1）**：
   在 `FoldableToolGroup` 内部，单工具视口降格为 `overflow-y: visible` 之后，必须由外层卡片提供**结构化的物理边界**：
   - 每个子工具卡片（`CompactToolRow`）必须具备独立的细腻外描边与微底色；
   - 工具 1 与 工具 2 之间必须具有明确的间距（`margin-bottom: 8px`）或分隔带；
   - 禁止在工具组内将多个工具的输出无缝焊接在一起。

---

### 4. 维度四：未接入限高容器改造与组件挂载清单

为确保“全域所有限高容器统一加上上下透明度渐隐”，必须对第 II 节排查出的 4 类遗漏容器进行规范化挂载：

#### 改造清单 1：独立态 Diff 差异比对卡片 (`ToolCallDiffPreview.tsx`)
- **文件**：`apps/crish-desktop/src/components/chat-tool-call/ToolCallDiffPreview.tsx`
- **改造**：将 `<div className={styles.diffLinesContainer}>` 升级为 `<ScrollFadeRegion className={styles.diffLinesContainer}>`。
- **CSS**：在 `ToolCallDiffPreview.module.css:199` 中支持 `.scroll-fade-inner` 承接原有的行布局。

#### 改造清单 2：高危操作审批命令视口 (`ApprovalAskCard.tsx`)
- **文件**：`apps/crish-desktop/src/components/agent-card/ApprovalAskCard.tsx`
- **改造**：将长命令包裹区 `<code className={styles.approvalCardCmd}>` 接入 `<ScrollFadeRegion innerAs="pre" fadeSize="sm">`，在 4.5em 封顶下赋予柔和的上下双向微渐隐。

#### 改造清单 3：目标与计划步骤列表抽屉 (`ComposerPlanProgressBar.tsx`)
- **文件**：`apps/crish-desktop/src/components/chat-composer/ComposerPlanProgressBar.tsx`
- **改造**：将 `.planStepListInner` 接入 `<ScrollFadeRegion className={styles.planStepListInner}>`，当步骤超过视口高度发生滚动时，步骤列表上下端平滑消隐，避免黑圈与绿点被斩断。

#### 改造清单 4：扩展流叙事视口 (`narrative.module.css` 族)
- **文件**：`apps/crish-desktop/src/extensions/conversation-flow/`
- **改造**：在 `ThinkingBlock.tsx`、`SubagentBlock.tsx` 中，对 `.detail` 与 `.thinkingFull` 接入 `ScrollFadeRegion`，统一全桌面会话流的边缘渐隐体验。

---

## 五、验收标准与自动化回归断言设计

### 1. 视觉验收指标（DoD）
1. **无文字腰斩**：任何限高滚动容器在任意滚动位置（顶、中、底），首行与末行文字均呈现平滑柔和的透明度消融，肉眼严禁看到任何断崖式字符横切痕迹。
2. **归属分明**：当连续执行多个工具并展开时，各工具卡片有独立外沿与清晰的渐变遮罩闭合，任何人眼一眼即能区分“这段输出属于当前工具，下面是下一个工具”。
3. **滚动条零遮挡**：滚动条全程绘制在宿主本体边缘，绝对不被内层 mask 遮罩淡化或切除。

### 2. 自动化测试回归矩阵

必须在以下测试文件中建立刚性契约拦截：

1. **`scroll-fade.contract.test.ts` (样式契约)**：
   - 断言 `--tool-fade-size` 为 40px；
   - 断言 mask-image 中包含 5 阶平滑插值节点（`0.08`, `0.35`, `0.75`, `0.95`）；
   - 断言禁止出现裸硬切 `0.45` 陡坡。
2. **`ScrollFadeRegion.test.tsx` (组件契约)**：
   - 验证新增宿主（DiffCard、ApprovalAskCard、PlanProgress）在渲染树中包含 `data-slot="scroll-fade-region"` 与 `.scroll-fade-inner`；
   - 验证 `active=true` 下状态机的合帧更新。
3. **`scroll-zones.contract.test.ts` (DIM-02 契约)**：
   - 保持受限滚动区白名单同步更新，防止未经授权的滚动容器回潮。

---

## 六、总结与主控汇报摘要

本报告对用户提出的**“限高容器上下区域加上透明度渐变，区分归属”**进行了根因层面的技术穿透：
1. **找准了真因**：不仅是渐变好看与否，而是因为在多工具组中子工具**被降级破坏了渐隐**，加之既有 28px 遮罩**坡度过陡（10px 砸断字符）**，且**初始顶端 0 遮罩**与**零内边距贴边**，造成了文字串联、首尾相撞的排版灾难。
2. **摸清了底账**：梳理了全桌面 12 个限高容器，锁定了 DiffCard、ApprovalCard 等 4 处漏挂载点。
3. **拿出了硬方案**：40px 带高 + 5 阶非线性平滑 Ease 曲线 + 端态微羽化 + 安全呼吸内边距，配套完善的组件挂载清单与自动化测试断言，彻底让内容边界清晰分明、视觉质感达到工业级优雅水准。
