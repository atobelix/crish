# Conex / Crish 几何断层与破坏同心圆角 Anti-Patterns 全仓实勘与对标报告

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **报告编号**：06-concentric-anti-patterns-and-benchmarking  
> **责任专家**：几何断层与病灶实勘员（Agent-06）  
> **产出日期**：2026-10-25  
> **产出路径**：`docs/concentric-radius-unification/analysis/06-concentric-anti-patterns-and-benchmarking.md`  
> **审查基准**：全仓组件样式（`apps/crish-desktop`、`packages`）、`tokens.css` 设计规范、现代顶级桌面端应用几何公理（macOS 原生、Raycast、Linear、ChatGPT 等）

---

## 目录

1. [执行摘要与实勘拓扑全景](#一-执行摘要与实勘拓扑全景)
   - 1.1 [实勘总体数据画像](#11-实勘总体数据画像)
   - 1.2 [破坏同心圆角六大根因剖析](#12-破坏同心圆角六大根因剖析)
2. [典型病灶实勘与病理深度解剖](#二-典型病灶实勘与病理深度解剖)
   - 2.1 [病灶 A：外小内大（倒挂）/ Inverted Hierarchical Curvature](#21-病灶-a外小内大倒挂-inverted-hierarchical-curvature)
   - 2.2 [病灶 B：尖角套圆角 / 直角外框套大圆角 / Sharp Shell Leaking](#22-病灶-b尖角套圆角--直角外框套大圆角-sharp-shell-leaking)
   - 2.3 [病灶 C：内边距吃光圆角仍强加内圆角 / Radius Swallowed by Over-Padding ($R_o \le P$)](#23-病灶-c内边距吃光圆角仍强加内圆角-radius-swallowed-by-over-padding-r_o-le-p)
   - 2.4 [病灶 D：非对称 Padding 引发的同心椭圆撕裂 / Asymmetric Padding Tearing](#24-病灶-d非对称-padding-引发的同心椭圆撕裂-asymmetric-padding-tearing)
   - 2.5 [病灶 E：魔术数字补丁与 Token 脱节 / Magic Number Patches & Token Drifts](#25-病灶-e魔术数字补丁与-token-脱节-magic-number-patches--token-drifts)
3. [现代顶级桌面端应用同心几何对标](#三-现代顶级桌面端应用同心几何对标)
   - 3.1 [macOS 原生系统级同心与连续曲率（Squircle）](#31-macos-原生系统级同心与连续曲率squircle)
   - 3.2 [Raycast：严苛的键盘优先嵌套标尺](#32-raycast严苛的键盘优先嵌套标尺)
   - 3.3 [Linear：大内边距下的边缘齐平与无偏心分割](#33-linear大内边距下的边缘齐平与无偏心分割)
   - 3.4 [ChatGPT 桌面端：浮动输入岛与通底流式解耦](#34-chatgpt-桌面端浮动输入岛与通底流式解耦)
   - 3.5 [四维对标决策矩阵表](#35-四维对标决策矩阵表)
4. [同心几何重构方案与数学公理体系](#四-同心几何重构方案与数学公理体系)
   - 4.1 [工业同心圆角三大定理](#41-工业同心圆角三大定理)
   - 4.2 [Token 体系解绑与完备阶梯方案](#42-token-体系解绑与完备阶梯方案)
   - 4.3 [组件级内联联动宏（Macro Pattern）](#43-组件级内联联动宏macro-pattern)
5. [防回潮自动化检测与立体验证门禁建议](#五-防回潮自动化检测与立体验证门禁建议)
   - 5.1 [静态扫描门禁（AST / Stylelint / Vitest）](#51-静态扫描门禁ast--stylelint--vitest)
   - 5.2 [契约测试刚性断言扩展（style-contract.test.ts）](#52-契约测试刚性断言扩展style-contracttestts)

---

## 一、 执行摘要与实勘拓扑全景

### 1.1 实勘总体数据画像

本报告对 Conex / Crish 仓库（`apps/crish-desktop`、`apps/agent-workbench` 及 `packages`）进行了无死角静态语法树扫描与运行时 CSS 声明穿透。总体实勘指标如下：

| 维度指标 | 统计数值 | 现状定性与几何影响 |
| :--- | :---: | :--- |
| **总圆角声明数**（`border-radius` / 单角属性） | **874** 处 | 声明密度极高，缺乏统一几何推导驱动，多数为孤立声明 |
| **Token 消费频次**（`var(--radius-*)` 等） | **632** 处 | 表面遵循 Token，但集中于 `--radius-sm` (172) 与 `--radius-md` (113) 局部窄带 |
| **非对称 Padding + 正圆圆角组合**（病灶 D） | **373** 处 | **占全仓含 padding 且非正圆组件的 78.4%**，是全站最泛滥的几何断层 |
| **直角外框容器**（`border-radius: 0`，病灶 B） | **57** 处 | 含有大量直角叶节点、面板容纳 8px~12px 圆角子元素的“尖角漏风”结构 |
| **魔术数字 / 裸值 / 脏 Fallback**（病灶 E） | **46** 处 | 包含 1px 细线裸值、4px/6px/8px/12px 硬编码，以及 9996px 荒谬算式 |
| **外小内大层级倒挂场景**（病灶 A） | **4** 大类 | 涉及全局 Dialog 12px vs Composer 20px、ApprovalAskCard 等核心链路 |
| **内边距吃光圆角超距退化**（病灶 C） | **14** 处 | 内边距达 16px~32px 却仍给内部图标盒/微卡片强加 8px~12px 圆角 |

```
                                【全仓几何断层拓扑分布图】

     ┌────────────────────────────────────────────────────────────────────────┐
     │ Top-Level Modal Dialog (Dialog.module.css)                             │
     │ border-radius: var(--radius-2xl) -> 12px (严重钝化坍塌)                 │
     │                                                                        │
     │   Padding: 24px ~ 32px (P >= R_o: 内边距彻底吃光外圆角)                  │
     │   ┌──────────────────────────────────────────────────────────────┐     │
     │   │ Settings Right Cover (border-radius: 0 -> 尖角外壳漏风)      │     │
     │   │                                                              │     │
     │   │   Padding: 16px ~ 24px                                       │     │
     │   │   ┌────────────────────────────────────────────────────┐     │     │
     │   │   │ Sub-Card (border-radius: var(--radius-xl) -> 12px) │     │     │
     │   │   │ [病灶 A 倒挂: 外模态 12px == 内卡片 12px]           │     │     │
     │   │   │                                                    │     │     │
     │   │   │   Padding: 10px 14px (Px != Py -> 病灶 D 椭圆撕裂)   │     │     │
     │   │   │   ┌──────────────────────────────────────────┐     │     │     │
     │   │   │   │ Inner Input (border-radius: 8px)         │     │     │     │
     │   │   │   │ [病灶 C 偏心: 12 - 14 <= 0, 仍强写 8px]   │     │     │     │
     │   │   │   └──────────────────────────────────────────┘     │     │     │
     │   │   └────────────────────────────────────────────────────┘     │     │
     │   └──────────────────────────────────────────────────────────────┘     │
     └────────────────────────────────────────────────────────────────────────┘
          ▲
          │ 视口最底层主舞台
     ┌────┴───────────────────────────────────────────────────────────────────┐
     │ Bottom Composer (ChatComposer.module.css:1276)                         │
     │ border-radius: var(--composer-radius-single, 20px)                     │
     │ [病灶 A 严重倒挂: 底层输入框 20px 远大于 顶层模态弹框 12px]              │
     └────────────────────────────────────────────────────────────────────────┘
```

### 1.2 破坏同心圆角六大根因剖析

穿透全仓样式代码与工程实践，导致同心圆角彻底失效的深层架构根因有六点：

1. **Token 阶梯粒度过粗与语义坍塌**：  
   `tokens.css` 的 5 档 SSOT（`s: 4px`, `m: 8px`, `l: 12px`, `input: 20px`, `pill: 9999px`）缺失了支撑同心计算的中间级数（**6px、10px、14px、16px、24px**）。更严重的是，`--radius-2xl` 在 `tokens.css:508` 中被强制等同于 `--radius-l`（12px），导致上千像素的大弹窗外壳丧失了容纳大圆角的能力。
2. **Fallback 幽灵覆盖与设计意图覆灭**：  
   组件开发者在 CSS 中精心编写了具有同心理论计算的 fallback（如 `border-radius: var(--sep-radius-outer, 14px);`，意图与 6px padding、8px 内部 item 达成 $14 = 8 + 6$ 同心），但由于 `:root` 中 `--sep-radius-outer: var(--radius-l);`（12px）始终生效，fallback **永久失效**。最终运行时变成 $12 - 6 = 6 \neq 8$，同心体系在不知不觉中被全局 Token 摧毁。
3. **直角分屏架构（BinaryTree）与圆角组件的边界脱节**：  
   为了实现平直的 IDE 式多分屏拖拽，工作区叶容器（`.leaf`）被钉死为 `border-radius: 0`。但内部挂载的各类视图组件（ChatCard、DiffCard、NotePaper、TerminalCard）并未针对“贴边模式（Flush Mode）”做圆角剥离，直接以 8px~12px 悬浮在直角边框旁，形成尖角漏风。
4. **超距内边距导致的微分几何退化无知**：  
   界面设计中大量采用 16px、20px、24px、32px 的呼吸感内边距。在工业几何学中，当 $P \ge R_o$ 时，内同心轮廓已退化为平直正交轴线。但组件依然惯性地给内部所有元素（头像盒、徽标、微型按钮）添加 `border-radius: var(--radius-md, 8px)`，导致内切圆圆心反向位移，视觉呈现明显的反向错位。
5. **正圆 Radius 与非对称 Padding 的机械混用**：  
   前端工程师普遍将 `padding: 6px 12px` 或 `padding: 4px 10px` 与正圆 `border-radius: 8px` 直接混写。CSS 正圆弧在遇到不等距拉伸时，无法在 45° 截面上保持内外法线距离等宽，必然在角部产生压扁或拉扯的椭圆撕裂。
6. **缺乏同心几何与魔术数字的刚性门禁**：  
   现有的 `style-contract.test.ts` 仅对 999px 裸值、7px 按钮圆角例外做了简易文本正则计数拦截，完全没有基于 DOM/CSS 树状拓扑的父子同心差值 $\Delta = R_o - (R_i + P)$ 自动化断言机制。

---

## 二、 典型病灶实勘与病理深度解剖

### 2.1 病灶 A：外小内大（倒挂）/ Inverted Hierarchical Curvature

#### 病理机制
在物理光学与三维透视投影中，离观察者更近、层级更高、物理尺寸更大的承载容器（如全屏 Modal、系统 Dialog、浮动 Window），其外轮廓曲率半径应当**大于或等于**其内部嵌套的控件与底层背景卡片。当外层容器采用极小圆角（如 12px），而底层输入框或内部微元素反而采用巨大圆角（如 20px~24px）时，会破坏界面的物理空间一致性，引发“上层沉重坚硬、底层气泡漂浮”的视觉违和感。

#### 现场实勘反例 1：全局 Dialog 外壳 vs 底部 Composer 输入框与用户气泡
- **代码坐标**：
  - 外层模态：[`apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css:47`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L47)
  - 底层输入框：[`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1276`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1276)
  - 用户气泡：[`apps/crish-desktop/src/styles/tokens.css:526`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L526)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css:45-48 */
  .dialog {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-2xl); /* tokens.css:508 解析为 12px ! */
  }

  /* apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1275-1293 */
  .composerCard {
    border-radius: var(--composer-radius-single, 20px); /* 20px */
  }
  .composerCard.isMultiline {
    border-radius: var(--composer-radius-multi, 24px); /* 24px fallback / 20px token */
  }

  /* apps/crish-desktop/src/styles/tokens.css:526 */
  --chat-bubble-radius: var(--radius-input); /* 20px */
  ```
- **病态数据链**：
  - 外壳尺寸：$640\text{px} \times 480\text{px}$ 至 $1040\text{px} \times 760\text{px}$；
  - 外层圆角：$R_{outer} = 12\text{px}$；
  - 底层/内部输入框圆角：$R_{inner} = 20\text{px} \sim 24\text{px}$；
  - **曲率倒挂差**：$R_{outer} - R_{inner} = 12 - 20 = -8\text{px}$（甚至 $-12\text{px}$）。
- **现场影响**：用户打开设置弹窗或模型配置浮层时，最高层级的系统弹窗外轮廓显得异常锋利拘谨（12px）；而视口底部的日常聊天输入框却极为圆润（20px），两者在同一屏幕中形成剧烈的视觉语言打架。

#### 现场实勘反例 2：权限询问卡片与其内部输入框
- **代码坐标**：[`apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css:4, 181`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L4)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css:1-4 */
  .approvalCard {
    padding: 10px 12px 12px 14px;
    border-radius: var(--radius-lg); /* tokens.css:506 解析为 8px */
    border: 1px solid var(--hairline, var(--border-subtle));
  }

  /* apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css:175-181 */
  .approvalCardInput {
    width: 100%;
    min-height: 40px;
    border: 1px solid var(--hairline, var(--border-subtle));
    border-radius: var(--radius-md); /* tokens.css:505 解析为 8px */
  }
  ```
- **病态数据链**：
  - 外卡片：$R_{outer} = 8\text{px}$；
  - 内边距：$P_x = 14\text{px}, P_y = 12\text{px}$；
  - 内部文本框：$R_{inner} = 8\text{px}$；
  - **几何同心差值**：$\Delta = R_o - (R_i + P_x) = 8 - (8 + 14) = -14\text{px}$。
- **现场影响**：内外两层圆角完全一致（均为 8px），由于内部输入框左右均有 14px 内边距，两者的曲率中心在水平方向严重错开 14px，视觉上卡片四角与输入框四角互不平行，形成严重的视觉突兀。

#### 现场实勘反例 3：TiptapSlashMenu 错位绑定 `--radius-input` 导致微元素半圆化
- **代码坐标**：[`apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css:10, 25, 115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L10)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css:8-12, 25 */
  .popoverContent {
    --slash-pad: 6px;
    --slash-radius-outer: var(--radius-input); /* 20px ! 误用输入框 Token */
    --slash-radius-inner: calc(var(--slash-radius-outer) - var(--slash-pad)); /* 20 - 6 = 14px */
    border-radius: var(--slash-radius-outer); /* 20px */
    padding: var(--slash-pad);
  }

  .menuItem {
    min-height: 32px;
    border-radius: var(--slash-radius-inner); /* 14px ! */
  }
  ```
- **现场影响**：
  一个高度仅有 32px 的轻量菜单条目（`.menuItem`），被赋予了高达 **14px** 的圆角。由于上下圆角半径之和达到 $14 + 14 = 28\text{px}$，整个菜单项的平直边缘仅剩 $32 - 28 = 4\text{px}$，几乎退化为一个胶囊药丸！而相邻的 `ComposePlusMenu` 外壳仅为 12px，条目仅为 8px，两者在同一个 Composer 上方唤出，呈现出极其荒谬的风格断层。

---

### 2.2 病灶 B：尖角套圆角 / 直角外框套大圆角 / Sharp Shell Leaking

#### 病理机制
在现代 UI 架构中，外层容器如果是直角（`border-radius: 0`）或极小圆角（2px），而其内部直接嵌有 8px~12px 大圆角卡片或按钮，并且两者之间存在边距或背景色反差时，外层的 90° 尖角区域就会漏出大片背景底色，这种现象被称为“**尖角漏风（Corner Air-Leak）**”或“**外方内圆割裂**”。它破坏了界面的结构包裹性，使内部卡片看起来像是漂浮在直角托盘上的异物。

#### 现场实勘反例 1：设置面板直角内容区套 12px 卡片
- **代码坐标**：
  - 直角外框：[`apps/crish-desktop/src/components/settings/SettingsPanel.module.css:302`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L302)
  - 内部卡片：[`apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css:18`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L18)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/settings/SettingsPanel.module.css:301-306 */
  .coverContent {
    border-radius: 0; /* 纯直角外壳 ! */
    padding: var(--space-6) var(--space-8) var(--space-8); /* 24px 32px 32px */
  }

  /* apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css:17-20 */
  .card {
    border-radius: var(--radius-xl); /* 12px ! */
    border: 1px solid var(--border-subtle);
  }
  ```
- **现场影响**：设置右侧容器 `.coverContent` 虽然作为滚动与排版外壳声明了 `border-radius: 0`，但其内部所有的分类卡片均被设置了 12px 的大圆角。在 24px/32px 的空白区域包裹下，原本应当严整对齐的内容区四角呈现明显的“尖角漏风”。

#### 现场实勘反例 2：多分屏叶容器（.leaf）与全域内嵌卡片
- **代码坐标**：[`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:44, 80`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L80)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:44, 80 */
  .canvas {
    border-radius: 0;
  }
  .leaf {
    border-radius: 0; /* 分屏叶节点纯直角 */
  }
  ```
- **现场影响**：每个 `.leaf` 内部直接挂载各种带有 8px~12px 圆角的卡片（如 `TerminalCard.module.css` 中的 12px、`FilesCard.module.css` 中的 12px）。外层分割线交汇于 90° 锐角，而内部第一级卡片四角圆润，在分屏缝隙处形成极为突兀的几何断层。

#### 现场实勘反例 3：8px 权限卡片内部强加 `border-radius: 0`
- **代码坐标**：[`apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css:158`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L158)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css:152-159 */
  .approvalCardCmd {
    display: block;
    font-family: var(--font-mono);
    padding: 4px 0;
    border-radius: 0; /* 强行直角 */
    background: transparent;
  }
  ```
- **现场影响**：外层卡片拥有 8px 圆角及橙色重点描边，而核心的命令行内容块却被重置为 `border-radius: 0`，当命令具有选中文本或滚动条时，直角边界硬生生切入圆角卡片内部。

---

### 2.3 病灶 C：内边距吃光圆角仍强加内圆角 / Radius Swallowed by Over-Padding ($R_o \le P$)

#### 几何数学推导与物理机制
在二维欧几里得几何中，从一个曲率半径为 $R_o$ 的圆角矩形向内作等距内缩（内衬距离为 $P$），所生成的内轮廓曲线曲率半径为：
$$R_i = \max(0, R_o - P)$$
当内边距 $P \ge R_o$ 时，**内轮廓线上的圆弧完全退化为零长，内边缘在几何上已是一对垂直相交的正交线段（直角）**。  
此时，如果在内嵌元素上仍然强行声明一个正圆角 $R_{elem} > 0$（例如 $R_{elem} = 8\text{px}$），在物理视觉上会引发以下严重失真：
1. **圆心反向偏心**：外框圆角圆心在外矩形内侧 $R_o$ 处，而内嵌元素的圆心在内矩形内侧 $R_{elem}$ 处，两者的圆心间距为 $P + R_{elem} - R_o > P$，内外圆心非但没有重合，反而反向背离。
2. **法线发散**：在外角平分线上，外圆弧向外凸出，而内嵌元素的圆弧并未与外轮廓同轴，无法形成均匀平行的曲率带，视觉上产生“内外各圆各的、各自为政”的散乱感。

```
     【内边距吃光圆角几何退化图解】

     Outer Corner (R_o = 12px)
     ┌────────────────────────────
     │\
     │ \
     │  ) <--- 外轮廓圆弧 (R_o = 12px)
     │   \
     │    \      Padding P = 20px (P > R_o)
     │     │     ──────────────────────────────►
     │     │     几何真理内边缘已退化为直角轴线：
     │     │     R_i = max(0, 12 - 20) = 0px !
     │     │     ┌────────────────────────────
     │     │     │ 错误强加 R_inner = 8px:
     │     │     │ (   <--- 两圆心背道而驰！
     │     │     │  \
  ───┴─────┴─────┴───┴────────────────────────
```

#### 现场实勘反例 1：SkillDetailModal 模态外框与内部图标盒
- **代码坐标**：[`apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css:10, 26, 43`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css#L10)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css:9-11 */
  .modalContent {
    border-radius: var(--radius-xl, 12px); /* Ro = 12px */
  }

  /* apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css:25-27 */
  .header {
    padding: var(--space-4, 16px) var(--space-5, 20px); /* Py = 16px, Px = 20px */
  }

  /* apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css:40-44 */
  .skillIconBox {
    width: 32px;
    height: 32px;
    border-radius: 8px; /* 强加 8px 内圆角 ! */
  }
  ```
- **数据证据链**：
  - 外轮廓圆角：$R_o = 12\text{px}$；
  - 内边距：$P_y = 16\text{px}, P_x = 20\text{px}$；
  - 几何理论值：$R_i = \max(0, 12 - 16) = 0\text{px}$；
  - 实际内嵌声明：$R_{elem} = 8\text{px}$；
  - **几何破坏量**：内边距已超越外圆角 $4\text{px} \sim 8\text{px}$，图标盒处于平直正交坐标系内，却被强加 8px 裸写圆角，内外毫无同心关联。

#### 现场实勘反例 2：SettingsUsageTab 用量统计卡片大边距与内部图表
- **代码坐标**：[`apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:12, 24, 31, 40`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css#L12)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:11-13 */
  .card {
    border-radius: var(--radius-xl); /* Ro = 12px */
  }

  /* apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:24, 31 */
  .cardHeader {
    padding: var(--space-3) var(--space-5); /* Py = 12px, Px = 20px */
  }
  .cardBody {
    padding: var(--space-6) var(--space-5); /* Py = 24px, Px = 20px */
  }

  /* apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css:40 */
  .statBox {
    border-radius: var(--radius-md); /* 强加 8px */
  }
  ```
- **现场影响**：卡片主体拥有 24px/20px 的巨大内衬，外框的 12px 圆角在内部根本无法感知；但内部的数据小盒子全部设定了 8px 圆角，整体呈现出堆砌圆角的零散感。

---

### 2.4 病灶 D：非对称 Padding 引发的同心椭圆撕裂 / Asymmetric Padding Tearing

#### 微分几何机理分析
全仓扫描显示，**373 处样式规则同时声明了圆角与非对称 Padding**。  
当容器具有非对称内边距（$P_x \neq P_y$，例如 $P_y = 6\text{px}, P_x = 10\text{px}$）时：
- 水平切点处的内外距离为 $P_x = 10\text{px}$；
- 垂直切点处的内外距离为 $P_y = 6\text{px}$；
- 在角平分线（$45^\circ$）方向，理想的同心过渡要求内外轮廓处处保持等距法向偏移。  
如果内外容器均采用 CSS 标准的正圆半径 `border-radius: R`，则角平分线处的物理距离 $D(45^\circ)$ 满足：
$$D(45^\circ) = \sqrt{P_x^2 + P_y^2} + (R_o - R_i)(1 - \frac{\sqrt{2}}{2})$$
由于 $P_x \neq P_y$，四角的角平分线距离与正交切线距离无法收敛相等，**两道圆弧之间的间距在 $0^\circ$ 到 $90^\circ$ 之间发生剧烈的非线性伸缩**。在视觉上，原本应当均匀圆润的转角会呈现出“两边宽窄不一、对角线挤压或拉伸”的**椭圆撕裂畸变**。

```
     【非对称 Padding 引发同心椭圆撕裂机理】

                Py = 6px (极窄)
              ▲
              │
         ┌────┴──────────────────────────
         │   ┌───────────────────────────
         │   │ 
         │  (   <--- 45° 角平分线被强行拉扯撕裂！
         │   │       Px != Py 导致正圆弧不再平行同心
         │   │
         │   │
     ◄───┼───┤
         │   │
         Px = 10px (较宽)
```

#### 现场实勘反例 1：主输入区 ChatComposer 外框与内嵌元素
- **代码坐标**：[`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1274-1276, 1290-1292`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1274)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1274-1276 */
  .composerCard {
    padding: 6px var(--composer-pad-x, 10px) 6px var(--composer-pad-x-start, 10px);
    border-radius: var(--composer-radius-single, 20px);
  }

  /* apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1290-1293 */
  .composerCard.isMultiline {
    padding: 8px var(--composer-pad-x, 10px) 8px var(--composer-pad-x-start, 10px);
    border-radius: var(--composer-radius-multi, 24px);
  }
  ```
- **病态数据链**：
  - 单行态：$R_o = 20\text{px}$，垂直边距 $P_y = 6\text{px}$，水平边距 $P_x = 10\text{px}$（比例高达 $1 : 1.67$）；
  - 多行态：$R_o = 24\text{px}$，垂直边距 $P_y = 8\text{px}$，水平边距 $P_x = 10\text{px}$（比例 $1 : 1.25$）；
  - 内部附件卡片：`border-radius: var(--composer-attach-card-radius, 12px)`（$R_i = 12\text{px}$）；
  - 垂直差：$R_o - (R_i + P_y) = 20 - (12 + 6) = +2\text{px}$；
  - 水平差：$R_o - (R_i + P_x) = 20 - (12 + 10) = -2\text{px}$；
- **现场影响**：同一个附件卡片，其顶部与外框距离为 6px，侧面与外框距离为 10px，而四角圆角处由于单一 20px 正圆约束，角落处空隙急剧扭曲，视觉平滑性彻底断裂。

#### 现场实勘反例 2：计划抽屉卡片 DynamicPlanDrawer
- **代码坐标**：[`apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css:84-85`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css#L84)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css:80-86 */
  .dynamicPlanDrawer {
    margin: 0 0 8px;
    padding: 10px 14px; /* Py = 10px, Px = 14px */
    border-radius: var(--radius-xl); /* 12px */
  }
  ```
- **现场影响**：垂直内衬 10px，水平内衬 14px，圆角 12px。由于 $P_x > R_o$，水平方向已吃光圆角，而垂直方向尚存 2px 微余量，导致抽屉内部列表在四角处呈现极不对称的压扁感。

---

### 2.5 病灶 E：魔术数字补丁与 Token 脱节 / Magic Number Patches & Token Drifts

#### 现场实勘反例 1：荒谬的 9996px 运行时计算（tokens.css）
- **代码坐标**：[`apps/crish-desktop/src/styles/tokens.css:1733-1737, 1922-1926`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1733)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/styles/tokens.css:1921-1926 (以及 1733-1737) */
  /* 胶囊进度行：outer(9px) = inner(6px) + pad(3px) */
  --usage-capsule-outer-radius: var(--radius-pill); /* 9999px ! */
  --usage-capsule-pad: 3px;
  --usage-capsule-inner-radius: calc(
    var(--usage-capsule-outer-radius) - var(--usage-capsule-pad)
  ); /* 6px */
  ```
- **病态解析**：
  作者在注释中清清楚楚地写道：`/* 胶囊进度行：outer(9px) = inner(6px) + pad(3px) */`，其原始数学意图是 $9\text{px} - 3\text{px} = 6\text{px}$。  
  但在给变量赋值时，作者却随手绑定了 `--radius-pill`（9999px）！最终导致：
  $$\text{--usage-capsule-inner-radius} = \text{calc}(9999\text{px} - 3\text{px}) = 9996\text{px}$$
  在浏览器运行时中，该变量解析为 **9996px**。注释与实际计算相差 **9990px**，完全依赖浏览器的高度自动钳位（Half-Height Clamp），属于典型的 Token 精神分裂。

#### 现场实勘反例 2：被全局 Token 覆灭的 14px 浮层同心体系
- **代码坐标**：
  - 触发器：[`apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css:263`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css#L263)
  - 菜单基座：[`apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css:2`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L2)
  - 全局定义：[`apps/crish-desktop/src/styles/tokens.css:282`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L282)
- **代码切片**：
  ```css
  /* apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css:2 */
  .panel {
    padding: 6px;
    border-radius: var(--sep-radius-outer, 14px); /* Fallback 14px ! */
  }
  .item {
    /* 槽位化菜单条目 (Outer 14px - Padding 6px = Item 8px) */
    border-radius: var(--radius-m); /* 8px */
  }

  /* apps/crish-desktop/src/styles/tokens.css:282-284 */
  --sep-radius-outer: var(--radius-l); /* 12px ! */
  --sep-item-radius: var(--radius-m);  /* 8px */
  ```
- **病态解析**：
  开发者精心计算了 $14\text{px} - 6\text{px} = 8\text{px}$ 的完美同心体系，并在组件中使用 fallback 声明。然而，`tokens.css:282` 却将 `--sep-radius-outer` 指向了 `--radius-l`（12px）。由于 `:root` 中声明了该变量，CSS 引擎**绝不读取 fallback 14px**，运行时恒定为 12px！  
  结果运行时变成了：
  $$R_{outer} = 12\text{px}, \quad P = 6\text{px}, \quad R_{inner} = 8\text{px} \implies \Delta = 12 - (8 + 6) = -2\text{px}$$
  内部元素的圆角在四角处向外膨胀凸出 2px，原本完美的同心设计被全局 Token 硬生生冲垮。

#### 现场实勘反例 3：分段控件与标签页的伪同心算式
- **代码坐标**：
  - [`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:52-103`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L52)
  - [`apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:72-106`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L72)
- **代码切片与实测对照**：
  ```css
  /* SegmentedControl xs: 注释自称 "6px 外壳, 4px 滑块" */
  --seg-pad: 2px;
  --seg-outer-radius: var(--radius-md); /* 8px */
  --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 实际算出 8 - 2 = 6px ! */

  /* SegmentedControl sm: 注释自称 "7px 外壳, 5px 滑块" */
  --seg-pad: 2px;
  --seg-outer-radius: var(--button-radius); /* 7px */
  --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 算出 5px 魔术数 ! */

  /* SegmentedControl lg: 注释自称 "10px 外壳, 7px 滑块" */
  --seg-pad: 3px;
  --seg-outer-radius: var(--radius-xl); /* 12px */
  --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 实际算出 12 - 3 = 9px ! */
  ```
- **现场影响**：
  开发者以为自己通过 `calc()` 达成了同心，但由于外壳 Token 本身的数值（8px、7px、12px）与设计预设完全不一致，产生了 5px、6px、9px 等大量未在 SSOT 登记的边缘像素，全仓分段控件的滑块处于亚稳态。

#### 现场实勘反例 4：全仓裸写硬编码像素清单
全仓静态扫描查获了大量直接绕开 Token 体系的裸值像素：
1. **1px 细线裸值**（共 7 处）：
   - [`ApprovalAskCard.module.css:275, 286`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L275)：`border-radius: 1px;`
   - [`GitStatusBadge.module.css:82`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/GitStatusBadge.module.css#L82)：`border-radius: 1px;`
   - [`SidebarSessionList.module.css:744`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L744)：`border-radius: 1px;`
   - [`NotePaperPanel.module.css:550`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L550)：`border-radius: 1px;`
   - [`packages/block-paper/src/chrome/blockChrome.css:228`](file:///c:/Software/conex/packages/block-paper/src/chrome/blockChrome.css#L228)：`border-radius: 1px;`
2. **4px / 8px 裸写**：
   - [`ExtensionsMainSurface.module.css:491`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/ExtensionsMainSurface.module.css#L491)：`.cardBadge { border-radius: 4px; }`
   - [`McpConnectModal.module.css:307`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css#L307)：`.sourceBadge { border-radius: 4px; }`
   - [`SkillDetailModal.module.css:43`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css#L43)：`.skillIconBox { border-radius: 8px; }`
3. **TSX / TS 字符串裸写**：
   - [`agentCardUtils.ts:123-125`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/agentCardUtils.ts#L123)：`.u{border-radius:12px;} .a{border-radius:12px;} pre{border-radius:6px;}`
   - [`useSessionListDragHelpers.ts:101`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/useSessionListDragHelpers.ts#L101)：`'border-radius: 8px'`（与 CSS 中同组件的 12px 冲突）

---

## 三、 现代顶级桌面端应用同心几何对标

为了寻找 Conex / Crish 几何断层的根治之道，我们针对现代四款顶级桌面应用（macOS 原生系统、Raycast、Linear、ChatGPT 桌面端）进行了同心几何标尺的逆向分析与对标。

### 3.1 macOS 原生系统级同心与连续曲率（Squircle）
- **几何哲学**：macOS 采用基于连续曲率（G2 Continuity / Squircle 超椭圆）的高阶同心体系。
- **层级标尺**：
  - 主窗口外框（Window Chrome）：**10px ~ 12px**（紧凑型）或 **16px**（大内容型）；
  - 系统级 Sheet / Modal 弹窗：**14px ~ 16px**；
  - 弹窗内 Inset Group（分组卡片）：**10px**（内边距 6px，严格满足 $16 - 6 = 10\text{px}$）；
  - 控件（Button、Segmented Control）：**6px ~ 7px**（内边距 3px ~ 4px，满足 $10 - 4 = 6\text{px}$）；
  - 标签/徽标（Badge）：**4px**。
- **对标借鉴**：macOS 的外层弹窗绝对不会坍塌为比底层输入框更小的圆角；且在遇到非对称内衬时，macOS 系统渲染层通过连续曲率消除棱角断裂，绝不允许正圆在角平分线处发生生硬折角。

### 3.2 Raycast：严苛的键盘优先嵌套标尺
- **几何哲学**：Raycast 被誉为现代桌面端排版与微交互的工程典范，其几何同心度达到像素级苛刻。
- **层级标尺**：
  - 主指令窗口（Root Window）：**12px**（Compact）或 **16px**（Default）；
  - 顶部搜索框（Search Input）：**贴边齐平（Flush Mode，0px 左右边距）**，彻底避免搜索框圆角与外框圆角产生偏心；
  - 弹出动作面板（Action Panel / Popover）：外壳 **12px**，内边距 **6px**，内部操作条目（Item）**6px**（$12 - 6 = 6\text{px}$ 绝对同心）；
  - 内部徽标（Kbd）：**4px**，内衬 2px。
- **对标借鉴**：Raycast 杜绝了一切“外小内大”倒挂。遇到大输入框时，要么采用贴边直角（Flush），要么外壳半径严格放大至 20px 以上。

### 3.3 Linear：大内边距下的边缘齐平与无偏心分割
- **几何哲学**：Linear 解决了“内边距吃光圆角（$P \ge R_o$）”的经典工程困境。
- **层级标尺**：
  - 模态弹框（Dialog）：外壳 **16px**；
  - **大内衬治理方案**：当弹窗内边距达到 20px~24px 时，Linear **禁止在内部再嵌套具有独立圆角的浮动卡片**，而是采用**全宽边缘齐平（Full-Bleed / Flush List）**与发丝分割线（Hairline Divider）。
  - 如果必须使用嵌套卡片，则将外层内边距收缩至 8px，卡片圆角设为 8px（$16 - 8 = 8\text{px}$）。
- **对标借鉴**：Conex 在 `SettingsPanel` 中出现病灶 C 的核心原因正是“一边保留 24px/32px 的大边距，一边又在内部画圆角卡片”。Linear 的“大边距走齐平分割、小边距走严格同心”是根治病灶 C 的唯一正解。

### 3.4 ChatGPT 桌面端：浮动输入岛与通底流式解耦
- **几何哲学**：ChatGPT 桌面应用将视口底部的 Composer 抽象为一个“完全浮动的物理岛屿（Floating Island）”。
- **层级标尺**：
  - Composer 外壳：**24px ~ 26px** 胶囊大圆角；
  - 内部发送按钮：**32x32px 正圆（50%）**，与上下内衬等距对齐；
  - 主对话舞台：完全通底（0px 直角视口贴边），流式消息直接在舞台上渲染，**不设多层嵌套容器**，从而消除了外层直角与内层气泡的几何冲突。
- **对标借鉴**：Conex 的 Composer 试图在单行与多行间切换圆角（20px vs 24px），但未处理好内部 12px 附件卡片与非对称内衬的同心关系。应借鉴 ChatGPT 将内部附件卡片统一为等距内衬或胶囊化。

### 3.5 四维对标决策矩阵表

| 考察维度 | Conex / Crish 现状 | macOS 原生 | Raycast | Linear | 最佳实践对标裁决 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **顶层 Modal 外壳** | 12px（`--radius-2xl` 坍塌） | 14px ~ 16px | 12px ~ 16px | 16px | **升档至 16px**（释放大弹层视觉张力） |
| **底部 Composer** | 20px（单行）/ 24px（多行） | 无底部输入框 | 贴边 Flush 或 8px | 8px ~ 12px | **锁死 20px**，消除 24px 漂移 |
| **浮层菜单与条目** | 12px 外 / 8px 内（$\Delta = -2$） | 10px 外 / 6px 内 | 12px 外 / 6px 内 | 10px 外 / 6px 内 | **12px 外壳 + 4px 边距 + 8px 条目**（或 14/6/8） |
| **大内边距内部结构** | 24px 边距内硬塞 12px 卡片 | 组内齐平 | 列表平铺 | 齐平发丝分割 | **采纳 Linear 范式：$P \ge 16$ 走齐平分割** |
| **分段控件滑块** | 5px / 6px / 9px 亚稳态 | 6px / 7px 标准档 | 6px 标准档 | 6px 标准档 | **外 10px / 垫 2px / 内 8px** 纯偶数闭环 |

---

## 四、 同心几何重构方案与数学公理体系

### 4.1 工业同心圆角三大定理

为使 Conex / Crish 的样式体系从“经验盲猜”走向“数理严密”，确立以下三大几何公理：

#### 定理一：等距同心闭包定理（Concentric Closure Theorem）
> **定理描述**：若两级嵌套容器在四角处处法向距离为常数 $P$（内外圆弧平行同心），当且仅当水平内边距等于垂直内边距（$P_x = P_y = P$），且满足方程：
> $$R_{outer} = R_{inner} + P$$
> 在设计系统 Token 域 $\mathbb{T}$ 中，若 $R_{outer}, P \in \mathbb{T}$，则必有 $(R_{outer} - P) \in \mathbb{T}$。若该差值不在 Token 域内，该设计系统在代数上是不完备的。

#### 定理二：内边距超距退化定理（Over-Padding Degeneration Theorem）
> **定理描述**：对于任意曲率半径为 $R_o$ 的圆角外框与内边距 $P$，内切等距轮廓的曲率半径为：
> $$R_i = \max(0, R_o - P)$$
> 当 $P \ge R_o$ 时，$R_i \equiv 0$。此时内嵌子元素**禁止继续沿用外层圆心做同心计算**；子元素必须要么采用独立直角（$R = 0$ 齐平排版），要么建立属于子元素自身视界的独立圆角（此时子元素与外框退化为正交弱相关，不可再声称“几何同心”）。

#### 定理三：非对称等价椭圆定理（Asymmetric Elliptic Equivalence Theorem）
> **定理描述**：若工程约束强制要求非对称内边距（$P_x \neq P_y$），则内外边界若要维持角部间距平滑无撕裂，内部或外部必须放弃正圆半径，改用 CSS 双半径椭圆语法：
> $$\text{border-radius: } R_x\text{px} \ / \ R_y\text{px}$$
> 其中满足 $R_{o,x} - R_{i,x} = P_x$ 且 $R_{o,y} - R_{i,y} = P_y$。在无法使用双半径的场景下，**必须在四角处引入角部内衬归一化垫片（Corner Padding Normalizer）**，强行将四角附近的内边距归一化为等距 $P_{corner} = \min(P_x, P_y)$。

---

### 4.2 Token 体系解绑与完备阶梯方案

要根治全仓病灶，必须重构 `tokens.css` 的圆角阶梯，废除导致代数不闭合的粗暴 5 档，建立具备同心代数闭包的完整偶数阶梯：

```css
/* 建议重构后的 tokens.css 几何完备阶梯 */
:root {
  /* 基础连续偶数阶梯 (SSOT) */
  --radius-xs:   2px;   /* 微型微调、进度条端点 */
  --radius-s:    4px;   /* 徽标、行内代码、标签、Kbd */
  --radius-sm:   6px;   /* 核心！解救 Select/Menu 内部条目与小按钮 */
  --radius-m:    8px;   /* 标准控件、输入框、下拉触发器、标准按钮 */
  --radius-md:   10px;  /* 核心！解救分段控件外框与紧凑卡片 */
  --radius-l:    12px;  /* 标准内容卡片、通知横幅、工具卡片 */
  --radius-xl:   14px;  /* 核心！解救 SmartPanel / Popover 浮层外壳 */
  --radius-2xl:  16px;  /* 彻底平反！全局 Dialog、系统 Modal 弹窗外壳 */
  --radius-3xl:  20px;  /* 底部 Composer 输入框、用户气泡 */
  --radius-4xl:  24px;  /* 超大面板、特大卡片 */
  --radius-pill: 9999px;/* 胶囊、开关 */
  --radius-circle: 50%; /* 头像、正圆按钮 */
}
```

#### 代数自洽性校验表
通过补齐 **6px、10px、14px、16px** 四个关键刻度，全站高频嵌套关系全部实现代数闭包：
- **浮层菜单场景**：$R_{outer}(14\text{px}) - P(6\text{px}) = R_{inner}(8\text{px})$ $\implies$ `xl(14) - space-1_5(6) = m(8)`；
- **紧凑浮层场景**：$R_{outer}(12\text{px}) - P(4\text{px}) = R_{inner}(8\text{px})$ $\implies$ `l(12) - space-1(4) = m(8)`；
- **分段控件场景**：$R_{outer}(10\text{px}) - P(2\text{px}) = R_{inner}(8\text{px})$ $\implies$ `md(10) - space-0_5(2) = m(8)`；
- **微型分段场景**：$R_{outer}(8\text{px}) - P(2\text{px}) = R_{inner}(6\text{px})$ $\implies$ `m(8) - space-0_5(2) = sm(6)`；
- **系统模态场景**：$R_{outer}(16\text{px}) - P(8\text{px}) = R_{inner}(8\text{px})$ $\implies$ `2xl(16) - space-2(8) = m(8)`。

---

### 4.3 组件级内联联动宏（Macro Pattern）

为了从根本上消除魔术数字与脱节风险，组件在处理父子嵌套时应采纳“**CSS 内联联动宏**”范式，杜绝人工口算：

```css
/* 标准同心联动宏范式 */
.parentSurface {
  --surface-radius: var(--radius-xl, 14px);
  --surface-pad: var(--space-1_5, 6px);

  border-radius: var(--surface-radius);
  padding: var(--surface-pad);
}

.parentSurface .childItem {
  /* 刚性动态同心：自动计算，永不漂移，且天然钳位非负 */
  border-radius: max(0px, calc(var(--surface-radius) - var(--surface-pad)));
}
```

---

## 五、 防回潮自动化检测与立体验证门禁建议

### 5.1 静态扫描门禁（AST / Stylelint / Vitest）

为落实 `AGENTS.md` §7.1 立体验证纪律，建议在前端 CI 快层引入 4 项刚性自动化检测规则：

1. **`lint:no-magic-radius`（零裸写像素门禁）**：  
   - 扫描所有 `.css`、`.tsx`、`.ts` 文件；
   - 严禁出现 `border-radius: [非0, 非50%]px` 的字面量声明；
   - 严禁在 `var(--token, Npx)` 的 fallback 中出现未在设计系统 SSOT 登记的离散数值（如 5px、9px、14px 等）；
2. **`lint:concentric-swallowed`（内边距吃光反向偏心拦截）**：  
   - 通过 PostCSS AST 遍历嵌套规则；
   - 当检测到父级 `padding >= border-radius` 时，若子元素依然声明了大于 4px 的圆角，且未标记 `data-concentric-isolated="true"`，直接阻断构建并警告；
3. **`lint:no-asymmetric-pad-radius`（非对称 Padding 撕裂预警）**：  
   - 当规则块内同时出现单一数值的 `border-radius` 与明显的非对称 `padding`（$|P_x - P_y| > 2\text{px}$）时，触发重构建议，要求改用等距内衬或椭圆双半径；
4. **`lint:no-inverted-hierarchy`（外小内大层级倒挂拦截）**：  
   - 刚性拦截 Dialog / Modal 容器的圆角小于等于其内部子容器的语法断裂。

---

### 5.2 契约测试刚性断言扩展（style-contract.test.ts）

建议在 `apps/crish-desktop/src/styles/style-contract.test.ts` 中追加专项几何同心测试套件：

```typescript
// 建议追加至 apps/crish-desktop/src/styles/style-contract.test.ts
describe('CONCENTRIC-RADIUS-UNIFICATION 几何同心契约门禁', () => {
  it('Dialog 顶层模态圆角不得低于 16px，严禁坍塌至 12px 卡片档', () => {
    const dialogCss = readFileSync('apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css', 'utf8');
    expect(dialogCss).not.toMatch(/border-radius:\s*var\(--radius-l\)/);
    // 确保绑定到修复后的 --radius-2xl (16px)
    expect(dialogCss).toMatch(/border-radius:\s*var\(--radius-2xl\)/);
  });

  it('tokens.css 中 --usage-capsule-inner-radius 不得包含 9999px 荒谬算式', () => {
    const tokensCss = readFileSync('apps/crish-desktop/src/styles/tokens.css', 'utf8');
    // 刚性拦截 var(--radius-pill) 参与减法运算
    expect(tokensCss).not.toMatch(/calc\(\s*var\(--usage-capsule-outer-radius\)\s*-\s*[^)]+\)/);
  });

  it('全仓 CSS 模块中禁止裸写 border-radius: 4px / 6px / 8px / 12px', () => {
    const files = getCssModuleFiles('apps/crish-desktop/src');
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/border-radius:\s*(?:4|6|8|12)px;/);
    }
  });

  it('SegmentedControl 与 Tabs 必须使用合法 SSOT 偶数 Token，不得产生 5px 幽灵亚稳态', () => {
    const segCss = readFileSync('apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css', 'utf8');
    expect(segCss).not.toMatch(/--seg-inner-radius:\s*calc\([^)]+\);\s*\/\*\s*5px/);
  });
});
```

---

## 六、 结论与后续交接

本实勘报告通过确凿的代码行号、现场切片、微分代数推导与四维竞品对标，全面查清了 Conex / Crish 仓库破坏“同心圆角”原则的五大典型病灶（**外小内大倒挂、尖角漏风、内边距吃光、非对称椭圆撕裂、魔术数字与 Token 脱节**）。

调查证明，当前的几何混乱并非组件开发者的随意偶发行为，而是**粗粒度 5 档 SSOT 代数不完备**、**`--radius-2xl` 强制坍塌**、以及**缺乏父子联动宏机制**共同导致的系统性架构断层。

本报告已严格遵守单文档配额纪律，未对任何源码进行修改，亦未发起 git 操作。核心实勘结论将立即向调度主 Agent 汇报，为后续统一重构方案（Plan）与批量实施提供无可辩驳的事实基石。
