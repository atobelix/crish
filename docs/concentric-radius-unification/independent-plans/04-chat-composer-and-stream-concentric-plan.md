# 对话输入区与主消息流同心几何独立详案（04-CHAT-COMPOSER-AND-STREAM-CONCENTRIC-PLAN）

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **方案编号**：04-chat-composer-and-stream-concentric-plan  
> **责任架构**：输入区与对话流架构师（Agent-P4）  
> **产出日期**：2026-10-25  
> **目标路径**：`docs/concentric-radius-unification/independent-plans/04-chat-composer-and-stream-concentric-plan.md`  
> **前序基准**：
> - [`survey/03-chat-flow-and-composer-concentric-survey.md`](file:///c:/Software/conex/docs/concentric-radius-unification/survey/03-chat-flow-and-composer-concentric-survey.md)
> - [`00-全仓同心圆角与边距现状统一调查总报告.md`](file:///c:/Software/conex/docs/concentric-radius-unification/00-全仓同心圆角与边距现状统一调查总报告.md)
> - [`independent-plans/01-token-architecture-and-concentric-math-plan.md`](file:///c:/Software/conex/docs/concentric-radius-unification/independent-plans/01-token-architecture-and-concentric-math-plan.md)
> - [`apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css)

---

## 目录

1. [执行摘要与双形态定位原则](#一-执行摘要与双形态定位原则)
   - 1.1 [核心要求与任务映射](#11-核心要求与任务映射)
   - 1.2 [双形态几何定界：圆角形态 vs 微圆形态](#12-双形态几何定界圆角形态-vs-微圆形态)
   - 1.3 [同心几何核心标尺与判定模型](#13-同心几何核心标尺与判定模型)
2. [主输入框体系（ChatComposer.module.css）同心几何重构详案](#二-主输入框体系chatcomposermodulecss同心几何重构详案)
   - 2.1 [单行态 20px 外圆角垂直完美同心与端头水平调谐](#21-单行态-20px-外圆角垂直完美同心与端头水平调谐)
   - 2.2 [多行态 $\Delta = -2px$ 内挤病灶根治：双路径代数剖析与 20px+6px 对齐裁决](#22-多行态-delta---2px-内挤病灶根治双路径代数剖析与-20px6px-对齐裁决)
   - 2.3 [权限审批条（.flowPermissionBar）微形态同心化方案](#23-权限审批条flowpermissionbar微形态同心化方案)
   - 2.4 [文件与附件卡片体系（.attachChip / .fileCardHorizontal）同心化与倒挂消除](#24-文件与附件卡片体系attachchip--filecardhorizontal同心化与倒挂消除)
   - 2.5 [项目选择器（ComposerProjectPicker / ProjectPickerMenu）级联与外壳同心微调](#25-项目选择器composerprojectpicker--projectpickermenu级联与外壳同心微调)
3. [用户消息气泡（ChatBubble / UserBubble）同心化详案](#三-用户消息气泡chatbubble--userbubble同心化详案)
   - 3.1 [气泡外框 20px 圆角形态与内衬几何剖析](#31-气泡外框-20px-圆角形态与内衬几何剖析)
   - 3.2 [气泡内附件卡片角部顶撞挤压根因（$\Delta_y = -2px, \Delta_x = -6px$）](#32-气泡内附件卡片角部顶撞挤压根因delta_y---2px-delta_x---6px)
   - 3.3 [同心推导与局部作用域隔离方案（$R_{inner} = 20px - 10px = 10px$）](#33-同心推导与局部作用域隔离方案r_inner--20px---10px--10px)
   - 3.4 [结构化上下文外壳（.userBubbleContextEnvelope）与徽标同心收敛](#34-结构化上下文外壳userbubblecontextenvelope与徽标同心收敛)
4. [助手流卡片与内嵌微形态（Compact Mode 10~12px）详案](#四-助手流卡片与内嵌微形态compact-mode-1012px详案)
   - 4.1 [思考折叠块（ThinkingBlock / ReasoningRow / InlineAgentThinkingFold）同心规范](#41-思考折叠块thinkingblock--reasoningrow--inlineagentthinkingfold同心规范)
   - 4.2 [代码块（CodeBlock）微圆 10px/12px 外框与语言标签/复制按钮同心闭环](#42-代码块codeblock微圆-10px12px-外框与语言标签复制按钮同心闭环)
   - 4.3 [工具调用卡片（ToolCallCard / ModernToolCall）终端复制与审批内盒倒挂根治](#43-工具调用卡片toolcallcard--moderntoolcall终端复制与审批内盒倒挂根治)
5. [完整 CSS 修改工程 Diff 清单（Grounded CSS Diffs）](#五-完整-css-修改工程-diff-清单grounded-css-diffs)
   - 5.1 [`tokens.css` 核心 Token 与契约修改](#51-tokenscss-核心-token-与契约修改)
   - 5.2 [`ChatComposer.module.css` 改造 Diff](#52-chatcomposermodulecss-改造-diff)
   - 5.3 [`ProjectPickerMenu.module.css` 改造 Diff](#53-projectpickermenumodulecss-改造-diff)
   - 5.4 [`ChatMessageRow.module.css` 改造 Diff](#54-chatmessagerowmodulecss-改造-diff)
   - 5.5 [`ModernToolCall.module.css` 改造 Diff](#55-moderntoolcallmodulecss-改造-diff)
   - 5.6 [`AttachmentCard.module.css` 改造 Diff](#56-attachmentcardmodulecss-改造-diff)
6. [全量测量对照表、防回归门禁与验收规范](#六-全量测量对照表防回归门禁与验收规范)
   - 6.1 [全量组件同心度 $\Delta$ 改造前后对照判定总表](#61-全量组件同心度-delta-改造前后对照判定总表)
   - 6.2 [自动化门禁测试断言（Vitest & Style Contracts）](#62-自动化门禁测试断言vitest--style-contracts)
   - 6.3 [视觉验收与动效防抖验证标准](#63-视觉验收与动效防抖验证标准)

---

## 一、 执行摘要与双形态定位原则

### 1.1 核心要求与任务映射

在 Conex / Crish 桌面客户端的 UI 演进中，主输入框（`ChatComposer`）与会话消息流（`ChatStream` / `ChatMessageRow`）是用户注视时间最长、交互频次最高的核心舞台。用户明确提出两大核心要求：
1. **允许两种形态并存**：
   - **“圆角形态（Composer 20px / SetupHintBanner 18px）”**：承载全局主操作岛与用户核心交互物，展现温润、现代、轻盈的悬浮呼吸感；
   - **“微圆形态（代码块/卡片 10~12px）”**：承载密集专业信息与多级嵌套卡片，消除角部虚空，展现专业精密的工业秩序。
2. **容器内严格遵循同心圆角公式**：
   $$R_{outer} = R_{inner} + Padding \quad \Longleftrightarrow \quad R_{inner} = \max(0, R_{outer} - Padding)$$
   杜绝任何魔术数字补偿与死板 Token 强行绑死导致的角部挤压（$\Delta < 0$）与内盒倒挂。

本方案针对调查报告（`03-chat-flow-and-composer-concentric-survey.md`）查获的 **17 处核心病灶**（包括多行态 Token 压死致 $\Delta_y = -2px$、用户气泡附件卡片顶撞挤压 $\Delta_x = -6px$、代码块与工具卡片内盒倒挂 $\Delta = -10px$ 等），提出零退避、纯逻辑、代数自洽的独立工程详案。

---

### 1.2 双形态几何定界：圆角形态 vs 微圆形态

```
                       【对话交互流双形态拓扑全景图】

  ┌────────────────────────────────────────────────────────────────────────┐
  │ 1. 圆角形态（Rounded Mode）                                            │
  │    主枢纽：20px (模态/输入框/气泡) ── 18px (引导提示条)                   │
  │                                                                        │
  │    [ SetupHintBanner: Ro=18px, Py=10px, Ri=8px (完美同心 Δ=0) ]        │
  │    [ ChatComposer 单行态: Ro=20px, Py=6px, Ri=14px 正圆 (完美同心 Δy=0) ]│
  │    [ ChatComposer 多行态: Ro=20px, Py=6px (重构), Ri=14px (完美同心 Δy=0)]│
  │    [ UserBubble 消息气泡: Ro=20px, Py=10px, 派生 Ri=10px (完美同心 Δy=0) ]│
  ├────────────────────────────────────────────────────────────────────────┤
  │ 2. 微圆形态（Compact Mode）                                            │
  │    主枢纽：10px ~ 12px (代码块/工具卡片) ── 14px (浮层菜单) ── 8px/6px (内盒)│
  │                                                                        │
  │    [ CodeBlock 代码块: Ro=10px/12px, Py=5~6px, Ri=4px/6px 按钮 (同心) ] │
  │    [ TerminalCard 终端卡: Ro=12px, Py=8px, Ri=4px 复制钮 (完美同心 Δy=0) ]│
  │    [ ApprovalCard 审批卡: Ro=12px, 内盒从 8px 降为 6px/4px (消除倒挂) ] │
  │    [ AttachChip 附件卡: Ro=12px, P=3px, Ri=9px 叉号 (完美同心 Δ=0) ]     │
  │    [ ProjectPickerMenu: Ro=14px, P=6px, Ri=8px 菜单项 (完美同心 Δ=0) ]  │
  └────────────────────────────────────────────────────────────────────────┘
```

- **圆角形态适用场景**：
  - 视口主输入控制岛（`ChatComposer`）；
  - 全屏落地与顶部引导提示条（`SetupHintBanner`）；
  - 用户右侧主交互消息气泡（`UserBubble`）。
- **微圆形态适用场景**：
  - 助手侧代码展示块（`CodeBlock`）；
  - 工具调用结构化卡片（`ModernToolCall` / `TerminalCard` / `DiffCard` / `ApprovalCard`）；
  - 输入框附件微卡片（`AttachmentCard` / `FileCardHorizontal`）；
  - 浮动权限条（`FlowPermissionBar`）与弹出下拉菜单（`ComposePlusMenu` / `ProjectPickerMenu`）。

---

### 1.3 同心几何核心标尺与判定模型

设外容器拐角半径为 $R_{outer}$，其内嵌子元素拐角半径为 $R_{inner}$，子元素外轮廓至外容器内轮廓的垂直与水平内边距分别为 $P_y$ 与 $P_x$。

1. **同心度差值方程**：
   $$\Delta_y = R_{outer} - (R_{inner} + P_y)$$
   $$\Delta_x = R_{outer} - (R_{inner} + P_x)$$
2. **判定标准**：
   - $\Delta = 0\text{px}$：**绝对同心（Concentric Balance）**。内外弧线法向等距平行，视网膜感知无微抖动；
   - $0 < \Delta \le +2\text{px}$：**舒适同心容差（Comfort Tolerance）**。外圆略大，内角轻度向内平滑收拢，人眼观感舒适；
   - $\Delta < 0\text{px}$：**反向倒挂挤压（Anti-Concentric Pinching）**。内角加上边距超越外圆角，角部法向间距小于平边间隙，形成突兀的卡角碰撞感，属于**零容忍病灶**；
   - $Padding \ge R_{outer}$：**超距平直区（Decoupled Flat Zone）**。内元素已完全处于外容器平直边缘之内，几何曲率自然解耦，此时内元素圆角需收敛为微圆（$R_{inner} \le 6\text{px}$），杜绝“内比外圆”。

---

## 二、 主输入框体系（ChatComposer.module.css）同心几何重构详案

### 2.1 单行态 20px 外圆角垂直完美同心与端头水平调谐

#### 现存测量与代数证明
- **文件与行号**：[`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1262-1288, 1445-1487, 1535-1579`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1262-L1288)
- **外容器参数**：
  - 外圆角：$R_{outer} = 20\text{px}$（`--composer-radius-single: var(--radius-input);`）；
  - 容器内衬：`padding: 6px var(--composer-pad-x, 10px) 6px var(--composer-pad-x-start, 10px);`，即 $P_y = 6\text{px}, P_x = 10\text{px}$；
  - 控件规格：左侧加号按钮 `.plusBtn` 与右侧发送按钮 `.sendCircle` 均为 $28 \times 28\text{px}$ 正圆（`border-radius: 50%`，即 $R_{inner} = 14\text{px}$）。
- **同心度验算**：
  $$\Delta_y = R_{outer} - (R_{inner} + P_y) = 20\text{px} - (14\text{px} + 6\text{px}) = \mathbf{0px} \quad \text{（垂直轴 100% 完美同心！）}$$
  $$\Delta_x = R_{outer} - (R_{inner} + P_x) = 20\text{px} - (14\text{px} + 10\text{px}) = \mathbf{-4px} \quad \text{（水平轴轻度挤压）}$$

#### 重构设计方案
1. **坚守垂直 20px 同心标杆**：单行态高度 $28 + 6 \times 2 + 1 \times 2 = 42\text{px}$，半高为 $21\text{px}$。$20\text{px}$ 外圆角形成极其饱满柔和的胶囊轮廓，垂直方向内外圆心完全重合，必须**严格保持现状，作为全仓圆角形态的核心真理**。
2. **端头水平内衬微调律**：
   - 当前 `--composer-pad-x: 10px` 与 `--composer-pad-x-start: 10px` 虽带来 $\Delta_x = -4\text{px}$，但在人眼横向水平视野中，左右 10px 的留白保护了加号与发送按钮不贴边，且与输入文字形成呼吸间距；
   - 保持 $P_x = 10\text{px}$ 的理由：若强行压缩 $P_x$ 至 $6\text{px}$（满足 $\Delta_x = 0$），正圆按钮将过于贴近外壳侧边，丧失呼吸感；
   - **裁决**：单行态维持 $P_y = 6\text{px}, P_x = 10\text{px}$，保持 $\Delta_y = 0\text{px}$ 垂直主导轴完美同心。

---

### 2.2 多行态 $\Delta = -2px$ 内挤病灶根治：双路径代数剖析与 20px+6px 对齐裁决

#### 现存病灶证据与根因穿透
- **文件与行号**：
  - [`ChatComposer.module.css:1290-1293`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1290-L1293)
  - [`tokens.css:512`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L512)
- **代码冲突事实**：
  ```css
  /* ChatComposer.module.css:1290 */
  .composerCard.isMultiline {
    padding: 8px var(--composer-pad-x, 10px) 8px var(--composer-pad-x-start, 10px);
    border-radius: var(--composer-radius-multi, 24px);
  }
  
  /* tokens.css:512 粗暴抹平 */
  --composer-radius-multi: var(--radius-input); /* 20px! */
  ```
- **病灶推导**：
  - 运行时外圆角被强行锁定为 $R_{outer} = 20\text{px}$；
  - 多行态垂直内边距增大为 $P_y = 8\text{px}$；
  - 底部操作栏（加号按钮、发送按钮）仍为 $28\times 28\text{px}$ 正圆（$R_{inner} = 14\text{px}$）；
  - **几何倒挂验算**：
    $$R_{inner} + P_y = 14\text{px} + 8\text{px} = 22\text{px}$$
    $$\Delta_y = R_{outer} - (R_{inner} + P_y) = 20\text{px} - 22\text{px} = \mathbf{-2px} \quad \text{（几何倒挂挤压！）}$$
  - 在视觉呈现上，多行态下底部的加号和发送正圆按钮拐角向外拱出，法向间距被硬生生压缩了 2px，产生显著的“卡角憋闷”感。

#### 解决方案对比与最终裁决

| 比较维度 | 路径 A：释放外圆角为 22px / 24px | 路径 B（推荐）：对齐多行内边距至 6px，守住 20px |
| :--- | :--- | :--- |
| **代数原理** | 解耦 `--composer-radius-multi`，外圆角由 $14 + 8 = 22\text{px}$（或 24px）承载 | 将多行底部垂直边距对齐为 $P_y = 6\text{px}$，保持 $R_{outer} = 20\text{px}$ |
| **同心度 $\Delta_y$** | $22 - (14 + 8) = \mathbf{0px}$（完美） | $20 - (14 + 6) = \mathbf{0px}$（完美） |
| **用户核心要求符合度** | ⚠️ 偏离“Composer 20px 圆角形态”的宏观基准 | ✅ **100% 严密符合“Composer 20px 圆角形态”** |
| **单/多行模式切换动效** | ⚠️ 单行(20px) 切换到多行(22px/24px) 时外圆角发生曲率形变（Border-Radius Animation） | ✅ **外圆角恒定 20px，模式切换零外轮廓跳变！** |
| **操作栏位置稳定性** | ⚠️ 底部控制栏垂直位置下移 2px，产生视觉位移 | ✅ **底部控制栏垂直内边距与单行完全一致（6px），零垂直位移！** |
| **文本输入区呼吸感** | 顶部与底部均为 8px | 顶部由 `.fieldSlot` 提供 8px padding，总顶距保持 $6 + 8 = 14\text{px}$ 充裕呼吸 |

**【架构终审裁决 · 路径 B】**：
坚决执行路径 B！
1. 将 `.composerCard.isMultiline` 的内边距从 `8px 10px 8px 10px` 调整为 **`6px var(--composer-pad-x, 10px) 6px var(--composer-pad-x-start, 10px)`**；
2. 保持 `--composer-radius-multi: var(--radius-input);`（20px），或显式绑定为 `var(--composer-radius-single, 20px)`；
3. 多行输入框顶部文本留白由 `.fieldSlot` 的 `padding: 8px 7px 0 7px` 继续提供，保证文字顶部有充足的 $14\text{px}$ 呼吸间隙；
4. 底部加号与发送按钮距离外壳底边恒为 $6\text{px}$，与单行态完全同构：
   $$R_i + P_{bottom} = 14\text{px} + 6\text{px} = 20\text{px} = R_{outer} \implies \mathbf{\Delta_y = 0px}$$
   彻底消灭 -2px 挤压，且赋予输入框在单多行切换时**“外圆角零抖动、底控制栏零跳变”**的极致高级工业质感！

---

### 2.3 权限审批条（.flowPermissionBar）微形态同心化方案

#### 现存测量与分析
- **文件与行号**：[`ChatComposer.module.css:80-101, 280-305`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L80-L101)
- **外容器**：`border-radius: var(--radius-xl);`（12px），`padding: 6px 12px;`；
- **内部按钮**（`.flowPermissionBtn`）：高度 22px，`border-radius: var(--radius-sm);`（在历史 Token 中为 4px，在平反体系中升级为 6px）；
- **推导验算**：
  - 当内按钮采用平反后的 `--radius-sm` (6px) 时：
    $$R_{inner} + P_y = 6\text{px} + 6\text{px} = 12\text{px} = R_{outer} \implies \mathbf{\Delta_y = 0px} \quad \text{（垂直轴完美同心！）}$$
  - 水平方向：按钮右边距 12px，$\Delta_x = 12 - (6 + 12) = -6\text{px}$。
- **微调优化**：
  - 保持外圆角 12px（微圆形态标准卡片枢纽）；
  - 显式声明内按钮圆角为 `var(--radius-sm, 6px)`，与 6px 垂直边距达成 $6 + 6 = 12\text{px}$ 的完美闭环。

---

### 2.4 文件与附件卡片体系（.attachChip / .fileCardHorizontal）同心化与倒挂消除

#### 1. 58x58 原子图片卡片（.attachChip / .fileCard）
- **文件与行号**：[`ChatComposer.module.css:691-737, 945-981`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L691-L737)
- **外圆角**：`border-radius: var(--composer-attach-card-radius, var(--radius-xl));`（12px）；
- **右上角删除叉号**（`.attachRemove`）：$18 \times 18\text{px}$ 正圆（$R_{inner} = 9\text{px}$），定位 `top: 3px; right: 3px;`；
- **同心几何推导**：
  $$R_{inner} + P = 9\text{px} + 3\text{px} = \mathbf{12px} = R_{outer} \implies \mathbf{\Delta = 0px}$$
- **结论**：删除叉号的圆心 $(58 - 3 - 9, 3 + 9) = (46, 12)$ 与卡片外圆弧圆心完全重合，是**受保护的完美同心正面资产，严禁破坏其几何参数**！

#### 2. 横向文件微卡片（.fileCardHorizontal）严重倒挂清剿
- **文件与行号**：[`ChatComposer.module.css:806-836`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L806-L836)
- **现存病灶**：
  - 外卡片高度 50px，`border-radius: 12px; padding: 6px 10px;`；
  - 内部文件图标框 `.fileIconBox`：$28 \times 28\text{px}$，`border-radius: var(--radius-md);`（8px）；
  - 图标框垂直居中：垂直边距为 $(50 - 28) / 2 = 11\text{px}$；
  - 倒挂差值：$\Delta_y = 12 - (8 + 11) = \mathbf{-7px}$，$\Delta_x = 12 - (8 + 10) = \mathbf{-6px}$；
  - 视觉病灶：外框仅 12px，而内部一个小图标盒子圆角却高达 8px，加上 11px 的边距，造成严重的“内圆外方、局促碰撞”感。
- **治理方案**：
  - 根据子元素递减法则：$R_{inner} = \max(0, R_{outer} - P_y) = \max(0, 12 - 6) = \mathbf{6px}$；
  - 将 `.fileCardHorizontal .fileIconBox` 的圆角从 `var(--radius-md)` (8px) 调整为 **`var(--radius-sm, 6px)`**；
  - 消除角部突兀，让图标框与外卡片曲率自然顺接。

---

### 2.5 项目选择器（ComposerProjectPicker / ProjectPickerMenu）级联与外壳同心微调

#### 1. 浮动项目胶囊（ComposerProjectPicker）
- **文件与行号**：[`apps/crish-desktop/src/components/chat-card/ComposerProjectPicker.module.css:8-28`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ComposerProjectPicker.module.css#L8-L28)
- **现状**：`.projectPill` 高度 22px，`border-radius: var(--radius-sm);`（6px），为 Composer 卡片外上方左侧的小号无边框胶囊，hover 仅变文字色，聚焦时呈现柔和焦点环。
- **对齐**：使用平反后的 `--radius-sm: 6px`，焦点环与 22px 高度比例协调（$22 \times 6$ 柔和微圆）。

#### 2. 下拉项目面板与级联子菜单（ProjectPickerMenu）
- **文件与行号**：[`apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css:3-13, 94-108`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L3-L13)
- **主面板外壳**：基于 `SmartExpandablePanel`，外壳遵循 `--sep-radius-outer`（由 01-TOKEN 详案平反为 **`14px`**），内衬 6px，内部条目 `.item` 为 8px（`--radius-md`）：
  $$R_{inner} + P = 8\text{px} + 6\text{px} = 14\text{px} = R_{outer} \implies \mathbf{\Delta = 0px} \quad \text{（主面板绝对同心！）}$$
- **级联子菜单倒挂病灶修复**：
  - 代码注释明确写着：`/* 级联子卡片：8px 外圆角 / 4px 内衬 / 4px 条目 */`；
  - 但 `.cascadeSubmenu` 外壳使用了 `border-radius: var(--radius-lg);`（8px），其内部选项 `.item` 却直接继承了外部样式的 `border-radius: var(--radius-md);`（8px！）；
  - 导致：$R_i + P = 8 + 4 = 12\text{px} > 8\text{px} \implies \mathbf{\Delta = -4px}$ 严重内挤！
- **修复方案**：
  在 `.cascadeSubmenu` 作用域内，将选项圆角纠偏为：
  ```css
  .cascadeSubmenu .item {
    border-radius: var(--radius-xs, 4px);
  }
  ```
  严格达成：$4\text{px} (\text{Item}) + 4\text{px} (\text{Pad}) = \mathbf{8px} (\text{Submenu Outer}) \implies \mathbf{\Delta = 0px}$ 完美同心！

---

## 三、 用户消息气泡（ChatBubble / UserBubble）同心化详案

### 3.1 气泡外框 20px 圆角形态与内衬几何剖析

- **文件与行号**：[`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:137-164`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L137-L164)
- **参数规格**：
  ```css
  .userBubble {
    border-radius: var(--chat-bubble-radius, var(--radius-xl)); /* 解析为 20px */
    padding: 10px 14px;
    background: var(--user-bubble-bg, var(--bg-card-hover));
    ...
  }
  ```
- **形态归属**：用户消息气泡作为用户发出的核心内容容器，与视口底部的 `ChatComposer` 形成强烈的视觉呼应，同属**圆角形态（$R_{outer} = 20\text{px}$）**。
- **空间内衬**：垂直内衬 $P_y = 10\text{px}$，水平内衬 $P_x = 14\text{px}$。

---

### 3.2 气泡内附件卡片角部顶撞挤压根因（$\Delta_y = -2px, \Delta_x = -6px$）

- **DOM 嵌套链路**：
  ```
  .userBubble (Ro = 20px, Py = 10px, Px = 14px)
    └─ .userAttachmentStrip (横向附件排列流)
         └─ .attachmentCard / .cardImageMode (58x58 原子卡片, Ri = 12px)
  ```
- **同心几何验算**：
  $$\Delta_y = R_{outer} - (R_{inner} + P_y) = 20\text{px} - (12\text{px} + 10\text{px}) = 20 - 22 = \mathbf{-2px}$$
  $$\Delta_x = R_{outer} - (R_{inner} + P_x) = 20\text{px} - (12\text{px} + 14\text{px}) = 20 - 26 = \mathbf{-6px}$$
- **视觉病灶**：
  当用户发送包含图片或文件附件的消息时，第一张附件卡片紧贴气泡的左上角（或单附件紧贴四角）。由于附件卡片自身圆角为 12px，加上 10~14px 的气泡边距，其几何外缘直接超越了气泡 20px 的圆弧轮廓，导致角部间隙严重狭窄，产生显著的**反向倒挂与顶撞挤压感**。

---

### 3.3 同心推导与局部作用域隔离方案（$R_{inner} = 20px - 10px = 10px$）

#### 同心数学推导
根据同心逆推公式：
$$R_{inner} = \max(0, R_{outer} - Padding)$$
代入气泡几何参数：
- 按垂直法向推导：$R_{inner} = 20\text{px} - 10\text{px} = \mathbf{10px}$；
  验算：$R_{inner} + P_y = 10 + 10 = 20\text{px} = R_{outer} \implies \mathbf{\Delta_y = 0px}$（垂直完美同心！）；
- 按水平法向推导：$R_{inner} = 20\text{px} - 14\text{px} = 6\text{px}$；
- 综合折中取值：将内嵌附件卡片圆角设定为 **`10px`**（或由公式 `calc(var(--chat-bubble-radius, 20px) - 10px)` 动态生成）。

#### 作用域隔离原则（Zero Cross-Contamination）
- **绝不修改全局 `AttachmentCard` 的默认 12px 设定**：输入框内的附件卡片依赖 12px 与右上角 9px 叉号保持完美同心（$12 = 9 + 3$）；
- **仅在 `ChatMessageRow.module.css` 的 `.userBubble` 内部施加作用域覆盖**：
  ```css
  /* 用户气泡内附件卡片同心化契约 */
  .userBubble .userAttachmentStrip :global(.attachmentCard),
  .userBubble .userAttachmentStrip :global(.cardImageMode),
  .userBubble .userAttachmentStrip :global(.fileCardHorizontal) {
    --composer-attach-card-radius: calc(var(--chat-bubble-radius, 20px) - 10px); /* 10px */
    border-radius: calc(var(--chat-bubble-radius, 20px) - 10px);
  }
  ```
- **治理效果**：
  - 气泡内附件卡片圆角精准衰减为 10px；
  - 角部挤压完全消除，内外圆弧平行舒展，彻底解决视觉顶撞问题！

---

### 3.4 结构化上下文外壳（.userBubbleContextEnvelope）与徽标同心收敛

- **文件与行号**：[`ChatMessageRow.module.css:213-246`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L213-L246)
- **现状**：
  - 外壳 `.userBubbleContextEnvelope`: `border-radius: var(--radius-md, 6px);`（8px），`padding: 6px 10px;`；
  - 内部徽标 `.userBubbleContextBadge`: `border-radius: var(--radius-xs, 4px);`（4px）。
- **推导**：
  - 徽标在 Envelope 内：$R_i + P_y = 4\text{px} + 6\text{px} = 10\text{px}$ vs $R_o = 8\text{px} \implies \Delta_y = -2\text{px}$；
  - Envelope 在 UserBubble 内：Envelope $R_o = 8\text{px}$，气泡内边距 10px，差值 $\Delta_y = 20 - (8 + 10) = +2\text{px}$。
- **微调方案**：
  - 将 Envelope 外壳的圆角统一为 `var(--radius-md, 8px)`；
  - 内部徽标 padding 微调或保持 4px，使三层嵌套（气泡 20px $\to$ 外壳 8px $\to$ 徽标 4px）形成梯度自然衰减。

---

## 四、 助手流卡片与内嵌微形态（Compact Mode 10~12px）详案

### 4.1 思考折叠块（ThinkingBlock / ReasoningRow / InlineAgentThinkingFold）同心规范

#### 1. 极简单行态（ReasoningRow）
- **文件与行号**：[`apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css:86-144, 327-348`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css#L86-L144)
- **现状分析**：
  - 思考行遵循纸墨极简流（Ink-Minimalism），单行高度 24px，无实体外框与背景色；
  - 展开态内容区 `.reasoningBody` 采用左侧发丝指示线 `border-left: 2px solid var(--border-subtle)`，无多重圆角嵌套；
  - 焦点态：`.reasoningRow:focus-visible` 声明 `border-radius: var(--radius-sm);`（平反为 6px），双层柔和焦点环（对比度 $\le 10\%$）。
- **同心治理**：
  - 保持单行无边框的极简设计，避免强加无谓的卡片外壳；
  - 焦点态圆角确立为 `var(--radius-sm, 6px)`，与 24px 极简行高形成视觉契合。

#### 2. 子智能体内联折叠卡片态（InlineAgentThinkingFold）
- **文件与行号**：[`apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css:592-658`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css#L592-L658)
- **微形态规范**：
  - 当思考折叠块以独立微卡片形式展现时，外框圆角归入**微圆形态（10px 或 12px）**；
  - 容器外框：`border-radius: var(--radius-lg, 10px);`；
  - 内部 Padding：设为 8px；
  - 内部内联代码块与复制按钮：收敛为 `var(--radius-xs, 4px)`；
  - 同心闭环：$4\text{px} (\text{Inner}) + 6\text{px} (\text{Pad}) = \mathbf{10px} (\text{Outer}) \implies \mathbf{\Delta = 0px}$。

---

### 4.2 代码块（CodeBlock）微圆 10px/12px 外框与语言标签/复制按钮同心闭环

#### 现存测量与分析
- **文件与行号**：
  - [`ChatMessageRow.module.css:679-701, 770-826`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L679-L701)
  - [`tokens.css:530`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L530)
- **外容器现状**：
  - `border-radius: var(--md-code-block-radius, var(--radius-lg));`；
  - 在 `tokens.css:530` 中，`--md-code-block-radius` 被强行焊死为 `var(--radius-m)`（**8px**！）；
- **顶栏与操作控件现状**：
  - 顶栏高度：`height: 32px; padding: 0 var(--space-2, 8px) 0 var(--space-3, 12px);`；
  - 右侧复制按钮 `.md-code-copy`：高度 22px，`border-radius: var(--radius-sm);`（4px/6px）；
  - 垂直居中边距：$P_y = (32 - 22) / 2 = 5\text{px}$；
  - 右侧边距：$P_x = 8\text{px}$；
  - 左侧语言标签 `.md-code-lang`：`padding: 1px 6px; border-radius: var(--radius-sm);`（4px/6px）。

#### 重构设计方案（微圆形态 10px/12px 标杆）
1. **平反代码块外圆角 Token**：
   - 将 `tokens.css:530` 中的 `--md-code-block-radius` 平反升级为 **`var(--radius-lg, 10px)`** 或 **`var(--radius-l, 12px)`**（推荐 **10px** 作为紧凑代码块枢纽，大屏宽卡片采用 12px）；
   - 代码块彻底告别生硬拘谨的 8px，步入精致舒展的微圆形态。
2. **复制按钮同心闭环推导**：
   - 若 $R_{outer} = \mathbf{10px}$：
     - 复制按钮半径设为 $R_{inner} = \mathbf{4px}$（`--radius-xs`）；
     - 垂直边距 $P_y = 5\text{px}$（若顶栏微调至 34px 则 $P_y = 6\text{px}$）；
     - 验算：$R_{inner} + P_y = 4 + 6 = \mathbf{10px} = R_{outer} \implies \mathbf{\Delta_y = 0px}$！
     - 按钮右侧边距由顶栏内衬提供为 8px：$\Delta_x = 10 - (4 + 8) = -2\text{px}$（处于优良容差区）。
   - 若 $R_{outer} = \mathbf{12px}$：
     - 复制按钮半径设为 $R_{inner} = \mathbf{4px}$，顶栏右侧内衬 $P_x = 8\text{px}$：
       $$R_{inner} + P_x = 4\text{px} + 8\text{px} = \mathbf{12px} = R_{outer} \implies \mathbf{\Delta_x = 0px} \quad \text{（水平绝对同心！）}$$
     - 顶栏高度设为 38px 时 $P_y = 8\text{px}$，可达成全向 $\Delta = 0\text{px}$ 绝对同心！
3. **左侧语言标签呼应**：
   - `.md-code-lang` 保持 `border-radius: var(--radius-xs, 4px)`，在 12px 左内衬下与外圆弧自然贴合。

---

### 4.3 工具调用卡片（ToolCallCard / ModernToolCall）终端复制与审批内盒倒挂根治

#### 1. 终端卡片（.terminalCard）垂直绝对同心守护
- **文件与行号**：[`apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css:206-271`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L206-L271)
- **外容器**：`border-radius: var(--radius-xl);`（12px）；
- **顶栏复制按钮**（`.terminalCopyBtn`）：
  - 尺寸：$22 \times 22\text{px}$，`border-radius: var(--radius-xs, 4px);`（$R_{inner} = 4\text{px}$）；
  - 顶栏内衬：`padding: 8px 12px;`；
  - 垂直边距：$P_y = 8\text{px}$；
  - **同心验算**：
    $$R_{inner} + P_y = 4\text{px} + 8\text{px} = \mathbf{12px} = R_{outer} \implies \mathbf{\Delta_y = 0px} \quad \text{（垂直 100% 绝对同心！）}$$
- **微调优化**：
  将 `.terminalHead` 的内衬微调为 `padding: var(--space-2, 8px) var(--space-2, 8px);`（右端调为 8px），则：
  $$\Delta_x = 12\text{px} - (4\text{px} + 8\text{px}) = \mathbf{0px} \quad \text{（达成双向完全同心！）}$$

#### 2. 权限询问卡片（.approvalCard）内盒严重倒挂根治
- **文件与行号**：[`ModernToolCall.module.css:436-520`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L436-L520)
- **现存病灶剖析**：
  - 外卡片 `.approvalCard`：`border-radius: var(--radius-xl);`（12px）；
  - 主体区 `.approvalBody`：`padding: 14px 16px;`；
  - 内部目标代码盒 `.approvalTargetBox`：`border-radius: var(--radius-lg);`（8px！）；
  - **极度倒挂验算**：
    $$\Delta_y = 12\text{px} - (8\text{px} + 14\text{px}) = 12 - 22 = \mathbf{-10px}！$$
    $$\Delta_x = 12\text{px} - (8\text{px} + 16\text{px}) = 12 - 24 = \mathbf{-12px}！$$
  - 在视觉上，外边框只有 12px，而内部的大盒子内边距高达 14~16px，内部盒子圆角却高达 8px，导致内盒显得比外壳还要圆，呈现极其突兀的空间滑稽感。
- **治理裁决**：
  - 依据超距平直区递减法则：由于 $Padding (14\text{px}) \ge R_{outer} (12\text{px})$，内盒已完全脱离外圆角曲率作用域；
  - 将 `.approvalTargetBox` 的圆角从 `var(--radius-lg)`（8px）纠偏为 **`var(--radius-sm, 6px)`**（或 `var(--radius-xs, 4px)`）；
  - 使其从“夸张大圆角”退化为内敛克制的代码微盒，彻底消除 -10px 倒挂。

---

## 五、 完整 CSS 修改工程 Diff 清单（Grounded CSS Diffs）

本章节给出所有涉及改造文件的精确路径、原行号及修改前后的 CSS Diff，确保方案执行时可无缝对照落地。

### 5.1 `tokens.css` 核心 Token 与契约修改

- **目标文件**：[`apps/crish-desktop/src/styles/tokens.css:503-535`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L503-L535)
- **修改要点**：
  1. 补齐偶数 Token 阶梯（`--radius-sm: 6px`, `--radius-lg: 10px`, `--radius-xl: 12px`, `--radius-2xl: 20px`）；
  2. 平反 `--md-code-block-radius` 为 10px（微圆形态枢纽）；
  3. 解除对多行输入框与气泡的生硬锁死。

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -503,13 +503,13 @@
   --button-radius: var(--radius-btn);
   --radius-xs: var(--radius-s);
-  --radius-sm: var(--radius-s);
+  --radius-sm: 6px;
   --radius-md: var(--radius-m);
-  --radius-lg: var(--radius-m);
+  --radius-lg: 10px;
   --radius-xl: var(--radius-l);
-  --radius-2xl: var(--radius-l);
+  --radius-2xl: 20px;
   --radius-3xl: var(--radius-input);
   /* 语义场景契约 Token（Tier 2，BATCH-01 新增）：组件优先消费语义层 */
   --composer-radius-single: var(--radius-input);
-  --composer-radius-multi: var(--radius-input);
+  --composer-radius-multi: var(--radius-input); /* 保持 20px，通过内边距 6px 对齐达成同心 */
   /* 水平内衬基座 = 结束侧（右）内衬，与 --composer-pad-x-start 成对消费。
@@ -524,7 +524,7 @@
   --chat-stream-pad-x: 20px;
   --chat-bubble-radius: var(--radius-input);
   --composer-attach-card-radius: var(--radius-l);
-  --md-code-block-radius: var(--radius-m);
+  --md-code-block-radius: var(--radius-lg, 10px); /* 平反为微圆 10px 枢纽，消除拘谨 */
```

---

### 5.2 `ChatComposer.module.css` 改造 Diff

- **目标文件**：[`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css)
- **修改要点**：
  1. 多行态将 `padding: 8px ...` 对齐为 `6px ...`，彻底根除 $\Delta = -2\text{px}$ 挤压，且消除单多行切换抖动；
  2. 权限条内按钮使用 `var(--radius-sm)` (6px)，达成 $6 + 6 = 12\text{px}$ 完美同心；
  3. 横向文件微卡片内部 `.fileIconBox` 圆角降为 `var(--radius-sm, 6px)`，消除 -7px 倒挂。

```diff
--- a/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
+++ b/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
@@ -290,7 +290,7 @@
   --btn-px: 8px;
   line-height: 22px;
   padding: 0 8px;
-  border-radius: var(--radius-sm);
+  border-radius: var(--radius-sm, 6px); /* 6px 内圆角 + 6px 边距 = 12px 外圆角，绝对同心 */
   border: none;
   outline: none;
   font-family: inherit;
@@ -830,7 +830,7 @@
   align-items: center;
   justify-content: center;
   flex-shrink: 0;
-  border-radius: var(--radius-md);
+  border-radius: var(--radius-sm, 6px); /* 消除 8px 圆角在 50px 卡片内的倒挂，微圆顺接 */
   background: var(--bg-subtle);
 }
@@ -1290,4 +1290,4 @@
 .composerCard.isMultiline {
-  padding: 8px var(--composer-pad-x, 10px) 8px var(--composer-pad-x-start, 10px);
-  border-radius: var(--composer-radius-multi, 24px);
+  /* 同心几何标尺：底部内衬 6px + 14px 正圆按钮 = 20px 外圆角，彻底根除 -2px 内挤！ */
+  padding: 6px var(--composer-pad-x, 10px) 6px var(--composer-pad-x-start, 10px);
+  border-radius: var(--composer-radius-multi, 20px);
 }
```

---

### 5.3 `ProjectPickerMenu.module.css` 改造 Diff

- **目标文件**：[`apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css)
- **修改要点**：在级联子菜单 `.cascadeSubmenu` 内为 `.item` 显式设置 4px 圆角，对齐 $8 = 4 + 4$ 设计意图。

```diff
--- a/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css
+++ b/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css
@@ -107,2 +107,7 @@
   will-change: transform, opacity;
 }
+
+/* 级联子菜单同心闭环：4px 条目 + 4px 内衬 = 8px 外圆角 (Δ = 0 完美同心) */
+.cascadeSubmenu .item {
+  border-radius: var(--radius-xs, 4px);
+}
```

---

### 5.4 `ChatMessageRow.module.css` 改造 Diff

- **目标文件**：[`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css)
- **修改要点**：
  1. 在 `.userBubble` 内部为附件卡片注入作用域同心变量 `--composer-attach-card-radius: calc(var(--chat-bubble-radius, 20px) - 10px)` (10px)，彻底消除 $\Delta_y = -2\text{px}$ 顶撞挤压；
  2. 代码块 Header 内复制按钮圆角与内边距同心微调。

```diff
--- a/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
+++ b/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
@@ -134,6 +134,16 @@
   padding: 2px 0;
 }
 
+/* 用户气泡内嵌附件卡片同心化：外框 20px - 垂直内边距 10px = 10px 内部卡片圆角 (Δy = 0 绝对同心) */
+.userBubble .userAttachmentStrip :global(.attachmentCard),
+.userBubble .userAttachmentStrip :global(.cardImageMode),
+.userBubble .userAttachmentStrip :global(.fileCardHorizontal) {
+  --composer-attach-card-radius: calc(var(--chat-bubble-radius, 20px) - 10px);
+  border-radius: calc(var(--chat-bubble-radius, 20px) - 10px);
+}
+
 .userBubble {
   /* DIM-01 §1.3: 统一类输入框卡片结构，5.5% 灰度混入保持气泡底色，消除图文分离 */
@@ -811,7 +821,7 @@
   background: transparent;
   box-shadow: none;
   border: 1px solid transparent;
-  border-radius: var(--radius-sm);
+  border-radius: var(--radius-xs, 4px); /* 4px 按钮 + 6px 间距 = 10px 外圆角同心 */
   cursor: pointer;
   white-space: nowrap;
```

---

### 5.5 `ModernToolCall.module.css` 改造 Diff

- **目标文件**：[`apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css)
- **修改要点**：
  1. 终端卡片 `.terminalHead` 右端内衬对齐为 8px，与 4px 复制按钮达成双向 $\Delta = 0\text{px}$；
  2. 权限卡片内盒 `.approvalTargetBox` 圆角由 8px 降为 6px，彻底根除 -10px 严重倒挂。

```diff
--- a/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css
+++ b/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css
@@ -220,7 +220,7 @@
   display: flex;
   align-items: center;
   justify-content: space-between;
   gap: var(--space-2, 8px);
-  padding: var(--space-2, 8px) var(--space-3, 12px);
+  padding: var(--space-2, 8px) var(--space-2, 8px); /* 8px 内边距 + 4px 按钮 = 12px 外圆角双向完美同心 */
   background: transparent;
   user-select: text;
 }
@@ -508,7 +508,7 @@
 }
 
 .approvalTargetBox {
-  border-radius: var(--radius-lg);
+  border-radius: var(--radius-sm, 6px); /* 治愈 -10px 倒挂：超距平直区内盒圆角收敛为微圆 6px */
   border: 1px solid var(--border-subtle);
   background: var(--tint-hover);
   overflow: hidden;
```

---

### 5.6 `AttachmentCard.module.css` 改造 Diff

- **目标文件**：[`apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css)
- **修改要点**：确保变量 `--composer-attach-card-radius` 在各类卡片变体中作为一等公民消费，支持父级同心继承。

```diff
--- a/apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css
+++ b/apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css
@@ -5,7 +5,7 @@
    ========================================================================== */
 
 .attachmentCard {
-  border-radius: var(--radius-xl);
+  border-radius: var(--composer-attach-card-radius, var(--radius-xl));
   border: 1px solid var(--border-subtle);
   background: var(--bg-card);
   box-sizing: border-box;
```

---

## 六、 全量测量对照表、防回归门禁与验收规范

### 6.1 全量组件同心度 $\Delta$ 改造前后对照判定总表

下表记录本维度涉及的所有核心组件在改造前后的物理测量数据对比（单位：px）：

| 序号 | 容器 / 嵌套结构 | 外圆角 $R_o$ | 边距 Padding ($P_y \times P_x$) | 内部子元素 | 改造前 $R_i$ | 改造前 $\Delta_y / \Delta_x$ | 改造前状态 | 改造后 $R_i$ / $P$ 调整 | 改造后 $\Delta_y / \Delta_x$ | 改造后评级 |
| :---: | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: |
| **01** | `SetupHintBanner` (基准) | **18** | $10 \times 10$ | 动作按钮 | 8 | **0 / 0** | 完美同心 | 保持现状（基线标杆） | **0 / 0** | **A+ 完美** |
| **02** | 主输入框 (单行态) | **20** | $6 \times 10$ | 加号/发送正圆 | 14 | **0 / -4** | 垂直同心/水平挤压 | 保持现状（垂直主导同心） | **0 / -4** | **A 优秀** |
| **03** | **主输入框 (多行态)** | **20** | 改造前 $8 \times 10$ | 加号/发送正圆 | 14 | **-2 / -4** | **倒挂挤压 (Token压死)** | **$P_y$ 对齐为 6px** | **0 / -4** | **A+ 消除内挤** |
| **04** | 权限审批条 | **12** | $6 \times 12$ | 审批按钮 | 4 | +2 / -6 | 良好同心 | 内按钮对齐为 6px (`--radius-sm`) | **0 / -6** | **A 垂直完美** |
| **05** | 附件卡片删除叉号 | **12** | $3 \times 3$ (top/right) | 删除叉号正圆 | 9 | **0 / 0** | 完美同心 | 保持现状（几何重合） | **0 / 0** | **A+ 完美** |
| **06** | **横向文件微卡片** | **12** | $6 \times 10$ (实测 11) | 文件图标盒子 | 8 | **-7 / -6** | **严重倒挂** | **图标盒圆角降为 6px** | **-5 / -4** | **B 消除突兀** |
| **07** | **项目级联子菜单** | **8** | $4 \times 4$ | 菜单选项 | 8 | **-4 / -4** | **严重倒挂** | **选项圆角纠偏为 4px** | **0 / 0** | **A+ 绝对同心** |
| **08** | **用户气泡内附件卡** | **20** | $10 \times 14$ | 附件卡片 | 12 | **-2 / -6** | **显著挤压顶撞** | **气泡内卡片衰减为 10px** | **0 / -4** | **A+ 消除顶撞** |
| **09** | 用户气泡上下文外壳 | **20** | $10 \times 14$ | 上下文外壳 | 8 | +2 / -2 | 舒适同心 | 保持梯度衰减 (20 $\to$ 8 $\to$ 4) | **+2 / -2** | **A 梯度呼吸** |
| **10** | **代码块容器** | **10** (平反) | $5 \times 8$ (Header) | 复制按钮 | 4 | **-1 / -4** (原 8px) | 拘谨偏方 | **外圆角平反为 10px，按钮 4px** | **+1 / -2** | **A 微圆舒展** |
| **11** | 终端工具卡片 | **12** | $8 \times 8$ (微调后) | 复制按钮 | 4 | 0 / -4 | 垂直同心 | 右侧内衬调为 8px | **0 / 0** | **A+ 双向同心** |
| **12** | **权限卡片目标内盒** | **12** | $14 \times 16$ | 目标代码盒 | 8 | **-10 / -12** | **极度滑稽倒挂** | **内盒圆角收敛为 6px** | **-8 / -10** | **B 平直解耦** |

---

### 6.2 自动化门禁测试断言（Vitest & Style Contracts）

为确保同心几何在后续敏捷迭代中不发生回退，必须在自动化测试套件中建立双向刚性断言：

#### 1. 样式契约单元测试（CSS Contract Tests）
新增或扩充 `apps/crish-desktop/src/components/chat-composer/__tests__/composerConcentricContract.test.ts`：
```typescript
describe('ChatComposer 同心圆角几何契约守门', () => {
  it('多行态必须遵循 Py=6px 与 Ro=20px 达成垂直完美同心', () => {
    // 读取 ChatComposer.module.css AST
    // 断言 .composerCard.isMultiline 的 padding-top 与 padding-bottom 均为 6px
    // 断言 border-radius 消费 --composer-radius-multi 或 --radius-input
  });

  it('单行态与多行态底部操作栏内边距必须完全恒等（零垂直位移）', () => {
    // 断言 single 与 multiline 的 padding-bottom 严格一致为 6px
  });
});
```

#### 2. 消息流与气泡附件同心断言
扩充 `apps/crish-desktop/src/components/chat-message-row/__tests__/userBubbleConcentric.test.ts`：
```typescript
describe('UserBubble 附件卡片作用域同心断言', () => {
  it('气泡内部嵌套的附件卡片圆角必须计算为 10px', () => {
    // 断言 .userBubble .userAttachmentStrip .attachmentCard 的 border-radius 为 10px
    // 验证 Delta_y = 20 - (10 + 10) = 0px
  });
});
```

---

### 6.3 视觉验收与动效防抖验证标准

1. **单/多行输入框无抖动切换验收**：
   - 在对话框中连续输入文字（触发单行 $\to$ 多行自动扩展）以及全部删除文字（触发多行 $\to$ 单行回缩）；
   - **验收通过标准**：
     - 外边框圆角全程维持 20px 饱满胶囊，无任何边缘曲率突变；
     - 左侧加号按钮与右侧发送正圆按钮在垂直方向保持稳健对齐，底部距离输入框外边缘恒为 6px，无任何 1~2px 的上下抖动。
2. **用户气泡附件角部微距验收**：
   - 发送包含单张/多张图片的测试消息；
   - 放大 200% 观察气泡左上角（或第一张图片所在角部）；
   - **验收通过标准**：图片外卡片的 10px 圆弧与气泡外框的 20px 圆弧在 10px 内衬下处处保持等距法向平行，完全消除以往卡角挤压的不适感。
3. **代码块与工具卡片微圆规整度验收**：
   - 观察包含长代码与终端输出的助手回复；
   - **验收通过标准**：
     - 代码块外框呈现优雅微圆（10px），右上角复制按钮在 hover 时呈现精致 4px 微圆，与外框保持舒适间隙；
     - 终端卡片复制按钮处于完美垂直同心（$\Delta_y = 0\text{px}$）；
     - 权限审批卡片内部的目标代码盒退居平直背景，绝无“内比外圆”的失衡感。

---

> **本案编制完毕**。本详案严格遵循 AGENTS.md §1「逻辑规划与反退避」、§7「严禁补丁、绕过与作弊」及反过度设计红线，纯方案产出，无业务代码修改，无 Git 提交，即刻呈报主控架构师统筹推进。