# 输入区与对话卡片同心圆角与边距现状统一调查报告

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **调查维度**：维度 03 — 对话输入区（ChatComposer）与主消息流卡片体系（ChatStream / Messages）  
> **勘察责任人**：架构自检团队 · Agent-03（输入区与对话卡片勘察员）  
> **报告基准日期**：2026-10-25  
> **基线对齐真理源**：`SetupHintBanner.module.css`（`_chatSoftHint` 18px = 8px + 10px 同心标尺）  

---

## 一、 勘察背景与核心结论

### 1.1 调查背景
在 Conex / Crish 桌面客户端的设计语言演进中，父子容器嵌套时内外圆角的协调性直接决定了界面的精细感与高级感。用户明确指出：
> “类似于 `class="_chatSoftHint_ocu4o_2"` 里面的去配置和外面的这个元素的背景圆角吧。由于需要考虑边距，所以也需要看一下对应元素以及父子容器的边距等等。”

本报告以 `SetupHintBanner` 中成熟的同心圆角几何（$R_{outer} = R_{inner} + Padding$）为基线范例，对对话输入区（ChatComposer 四层空间堆叠架构）与主消息流（ChatStream / Messages 气泡、思考行、代码块、工具卡片）进行全盘立体勘察。

### 1.2 核心调查发现
经过对 15+ 核心 CSS 模块、Token 链路及 DOM 嵌套结构的严格测量与推导，得出以下关键结论：

1. **基线范例的优雅同心与局限**：
   `SetupHintBanner`（`.chatSoftHint`）采用严格的 CSS 计算公式 `--soft-hint-radius: calc(var(--soft-hint-btn-radius) + var(--soft-hint-py))`。在右端垂直和水平等距 10px 内衬下，实现了 $18px = 8px + 10px$（$\Delta = 0$）的完美同心；然而在左端因文本内衬为 16px，左侧外圆角未能与内容形成等距法向扩展，属于“单侧对齐同心”。
2. **主输入框（ComposerCard）的单多行断裂与 Token 覆写病灶**：
   - **单行态**：外框垂直内衬 6px，内圆形按钮（＋号/发送）半径 14px（28x28px 正圆）。垂直方向 $14px + 6px = 20px = R_{outer}$，达成**垂直方向 100% 完美同心**（$\Delta_y = 0$）；但水平内衬为 10px，导致水平同心差值 $\Delta_x = 20 - (14 + 10) = -4px$，角部水平方向出现轻微挤压。
   - **多行态致命病灶**：`ChatComposer.module.css:1292` 声明 `border-radius: var(--composer-radius-multi, 24px)`，且垂直内衬增至 8px；若按 24px 计算，$R_i + P_y = 14px + 8px = 22px \implies \Delta_y = +2px$。然而在 `tokens.css:512` 中，`--composer-radius-multi: var(--radius-input);`（而 `--radius-input` 为 20px）！**运行时 Token 强行将多行外圆角压回 20px**，导致 $\Delta_y = 20 - 22 = -2px$！**出现了外圆角小于“内圆角 + 边距”的几何倒挂现象（Anti-Concentric Pinching）**。
3. **隐藏的完美同心范式（Positive Discoveries）**：
   - 附件卡片删除叉号（`ChatComposer.module.css:947-957`）：卡片外圆角 12px，右上角叉号半径 9px（18x18px 正圆），定位 `top: 3px; right: 3px`。$R_i + P = 9px + 3px = 12px \implies \Delta = 0$！
   - 选区批注卡片（`ChatComposer.module.css:1035-1039`）：代码显式声明同心数学标尺：`--ann-pad: 12px; --ann-radius-inner: 6px; --ann-radius-outer: calc(var(--ann-radius-inner) + var(--ann-pad));`（$18px = 6px + 12px \implies \Delta = 0$）。
   - 终端卡片复制按钮（`ModernToolCall.module.css:260-271`）：外卡圆角 12px，按钮圆角 4px，垂直边距 8px。$R_i + P_y = 4px + 8px = 12px \implies \Delta_y = 0$！
4. **严重同心失调与几何倒挂病灶（Critical Anti-Patterns）**：
   - **用户消息气泡（UserBubble）附件模式**：气泡外圆角 20px，内边距 10px 14px；内部渲染 58x58 附件卡片（圆角 12px）。垂直方向 $12 + 10 = 22px > 20px$（$\Delta_y = -2px$），水平方向 $12 + 14 = 26px >> 20px$（$\Delta_x = -6px$），气泡四角严重顶撞挤压。
   - **目标/计划进度条（PlanProgressBar）**：外框圆角被 token 锁定为 8px（`--radius-lg: var(--radius-m)`），但折叠态高度 44px 居中 24px Badge（圆角 8px），垂直边距 10px。$R_i + P_y = 8 + 10 = 18px >> 8px$（$\Delta = -10px$ 极其严重的倒挂）。
   - **下拉弹出菜单（Dropdown Menus）**：`ComposePlusMenu`、`PermissionModeMenu` 等外壳被 token 锁在 12px（`--sep-radius-outer`），内衬 6px，内部项目圆角 8px。$8 + 6 = 14px > 12px$（$\Delta = -2px$），未能实现原设计的 14px 同心闭合。

---

## 二、 同心几何数学标尺与判定模型

### 2.1 同心圆角数学定义
在平面二维空间中，设外容器轮廓在拐角处的正圆圆弧半径为 $R_{outer}$，其圆心位于 $C_{outer} = (x_{co}, y_{co})$：
$$(x - x_{co})^2 + (y - y_{co})^2 = R_{outer}^2$$

当外容器内部嵌套内层子元素，其外边框拐角具有正圆圆弧半径 $R_{inner}$，圆心位于 $C_{inner} = (x_{ci}, y_{ci})$。  
设内层元素外轮廓距离外容器内轮廓在两个几何轴线上的内衬间距分别为 $P_x$（水平间距）与 $P_y$（垂直间距）。

#### 1. 等距同心条件（Isotropic Concentricity, $P_x = P_y = P$）
要使内外两道圆弧处处同心且法向平行距离恒为 $P$，必须且仅须两圆弧的圆心完全重合（$C_{outer} \equiv C_{inner}$）。此时几何关系为：
$$R_{outer} = R_{inner} + P \iff R_{inner} = \max(0, R_{outer} - P)$$

定义**同心度差值 $\Delta$**：
$$\Delta = R_{outer} - (R_{inner} + P)$$
- **$\Delta = 0$（完美同心，Concentric Balance）**：内外弧线法向间距各处严格等宽，视觉顺滑流线；
- **$\Delta > 0$（内角锐化 / 过度内缩，Visual Pinching of Inner Corner）**：外圆内尖，角部空白过度膨胀；
- **$\Delta < 0$（外角挤压 / 几何倒挂，Boundary Cramping / Inverse Nesting）**：外圆角不足以包裹内角加边距，角部法向间隙小于平边间隙，甚至出现“外方内圆”或角部撞击感。

#### 2. 各向异性同心（Anisotropic Concentricity, $P_x \ne P_y$）
在主流 Web 布局中，容器往往设置垂直较窄、水平较宽的内边距（如 $P_y = 6px, P_x = 10px$）。  
若内外均为正圆圆角，圆心不可能在 X/Y 双向同时重合。此时同心度分解为两个正交轴的分量：
$$\Delta_x = R_{outer} - (R_{inner} + P_x)$$
$$\Delta_y = R_{outer} - (R_{inner} + P_y)$$
此时需权衡“视觉主导轴向对齐”（如单行输入框优先保证垂直视平线同心 $\Delta_y = 0$）或使用 CSS 椭圆圆角（`border-radius: R_x / R_y`）。

---

## 三、 基线范例解剖（SetupHintBanner）

### 3.1 代码证据与样式声明
- **文件路径**：[`apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css:2-17, 56-66`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css#L2-L17)

```css
/* apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css */
.chatSoftHint {
  --soft-hint-py: 10px;
  --soft-hint-px-start: 16px;
  --soft-hint-px-end: 10px;
  --soft-hint-btn-radius: var(--radius-md, 8px);
  /* 同心几何标尺：外圆角 = 内圆角 (8px) + 等距内边距 (10px) = 18px，内外圆弧处处平行同心 */
  --soft-hint-radius: calc(var(--soft-hint-btn-radius) + var(--soft-hint-py));

  display: flex;
  align-items: center;
  gap: var(--space-2_5, 10px);
  margin: 0 auto 8px;
  padding: var(--soft-hint-py) var(--soft-hint-px-end) var(--soft-hint-py)
    var(--soft-hint-px-start);
  min-height: 48px;
  border-radius: var(--soft-hint-radius);
  /* ... */
}

.chatSoftHintAction {
  height: 28px;
  padding: 0 13px;
  border-radius: var(--soft-hint-btn-radius);
  /* ... */
}
```

### 3.2 数学推导与同心几何分析
```
+----------------------------------------------------------------------------------+
| .chatSoftHint (Ro = 18px)                                                        |
|  Py = 10px                                                                       |
|  +---------------------------------------------------------+   +---------------+ |
|  | 图标 + 提示文本                                          |   | Action Button | |
|  |                                                         |   | Ri = 8px      | |
|  |                                                         |   | H = 28px      | |
|  +---------------------------------------------------------+   +---------------+ |
|  Py = 10px                                                      Px-end = 10px    |
+----------------------------------------------------------------------------------+
```

1. **右侧同心测量（Right / Trailing Edge）**：
   - 内按钮 `.chatSoftHintAction` 高度 28px，垂直居中于 `min-height: 48px` 的容器中；
   - 容器垂直内衬 `--soft-hint-py: 10px`，上下边距各为 10px（$(48 - 28)/2 = 10px$）；
   - 容器右侧内衬 `--soft-hint-px-end: 10px`；
   - 于是，在右上角与右下角：
     $$P_x = 10px, \quad P_y = 10px \implies P = 10px$$
     $$R_{inner} = 8px$$
     $$R_{outer} = \text{calc}(8px + 10px) = 18px$$
     $$\Delta = R_{outer} - (R_{inner} + P) = 18 - (8 + 10) = 0px$$
   - **结论**：内外圆弧圆心在右上角、右下角完全重合，法向间隙处处严格等于 10px，达到了教科书级别的完美同心。

2. **左侧几何测量（Left / Leading Edge）**：
   - 容器左侧内衬 `--soft-hint-px-start: 16px`；
   - 左侧为 20x20px 的图标 `.chatSoftHintIcon`，上下边距为 $(48 - 20)/2 = 14px$；
   - 此时左侧并无对应 8px 圆角的按钮控件，外圆角仍为 18px。由于左侧主要承载文本流，外圆角的左右对称性保证了外轮廓的美感，但左侧几何并非嵌套同心，而是“外壳对称”。

---

## 四、 主对话输入框体系（ChatComposer）全盘勘察

输入框采用四层空间垂直堆叠架构（Four-Layer Vertical Spatial Stacking Architecture），从上至下依次为：
- **Layer 1**：浮动权限审批条（`.flowPermissionBar`）/ 通知条（`.noticeBar`）
- **Layer 2**：目标/计划进度条（`.planProgressBar`）
- **Layer 3**：上下文与文件引用卡片区（`.fileZone` / `.fileCard` / `.attachChip`）
- **Layer 4**：主输入卡片（`.composerCard` / `.inputMainLayout`）

### 4.1 Layer 4: 主输入区（ComposerCard）

#### 4.1.1 单行态（Single-Line State）
- **代码位置**：[`ChatComposer.module.css:1262-1288, 1445-1487, 1535-1579`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1262-L1288)
- **Token 映射**：
  - `tokens.css:511`: `--composer-radius-single: var(--radius-input);`（`--radius-input` 为 20px）
  - `tokens.css:515`: `--composer-pad-x: 10px;`
  - `tokens.css:519`: `--composer-pad-x-start: 10px;`
- **外容器参数**：
  - `border-radius: var(--composer-radius-single, 20px);`（实际生效值：20px）
  - `padding: 6px var(--composer-pad-x, 10px) 6px var(--composer-pad-x-start, 10px);`（即 $P_y = 6px, P_x = 10px$）
  - 单行内容高度：内部所有主控件高度均为 28px（加号按钮、输入槽、发送按钮）。
  - 外框盒模型总高度：$28px + 6px \times 2 + 1px \times 2 (\text{border}) = 42px$。
  - 外圆角 20px 几乎等于总高度的一半（42px / 2 = 21px），呈现精致的胶囊端头。

```
+--------------------------------------------------------------------------------------+
| .composerCard 单行态 (Ro = 20px, H = 42px)                                            |
|  Py = 6px                                                                            |
|  +---------+ Px-s=10px +------------------------------+ Px=10px +---------+---------+|
|  | .plusBtn|           | .fieldSlot (Text Input)      |         | .fused  | .send   ||
|  | 28x28   |           | H = 28px                     |         | Trigger | Circle  ||
|  | r = 14px|           |                              |         | r = 12px| r = 14px||
|  +---------+           +------------------------------+         +---------+---------+|
|  Py = 6px                                                                            |
+--------------------------------------------------------------------------------------+
```

- **内部嵌套控件测量与同心推导**：
  1. **左侧加号按钮 `.plusBtn`**：
     - 尺寸：28x28px 正圆按钮（`border-radius: 50%`，半径 $R_i = 14px$）；
     - 垂直距离：$P_y = 6px$；
     - 垂直同心推导：
       $$R_i + P_y = 14px + 6px = 20px = R_{outer} \implies \Delta_y = 0px$$
       **垂直方向内外圆心完美重合**！
     - 水平距离：$P_{x-start} = 10px$；
     - 水平同心推导：
       $$R_i + P_x = 14px + 10px = 24px \ne 20px \implies \Delta_x = -4px$$
       **水平方向内角加间距略大于外圆角，角部水平间隙比垂直间隙稍紧**。
  2. **右侧发送按钮 `.sendCircle`**：
     - 尺寸：激活态 28x28px 正圆按钮（`border-radius: 50%`，半径 $R_i = 14px$）；
     - 垂直距离：$P_y = 6px \implies R_i + P_y = 14 + 6 = 20px \implies \Delta_y = 0px$（垂直完美同心）；
     - 水平距离：$P_x = 10px \implies R_i + P_x = 14 + 10 = 24px \implies \Delta_x = -4px$。
  3. **融合模式触发胶囊 `.capsule`（`ComposerFusedTrigger.module.css:6-50`）**：
     - 高度 28px，两端采用 `border-radius: var(--sep-radius-outer) 0 0 var(--sep-radius-outer);`；
     - `--sep-radius-outer` 在 `tokens.css:507` 中解析为 `var(--radius-l)` = 12px；
     - 若作为独立控件：垂直边距 6px，$R_i + P_y = 12 + 6 = 18px$ vs $R_{outer} = 20px \implies \Delta_y = +2px$。

#### 4.1.2 多行态（Multi-Line State）与 Token 覆写病灶
- **代码位置**：[`ChatComposer.module.css:1290-1293`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1290-L1293)
- **CSS 声明**：
  ```css
  .composerCard.isMultiline {
    padding: 8px var(--composer-pad-x, 10px) 8px var(--composer-pad-x-start, 10px);
    border-radius: var(--composer-radius-multi, 24px);
  }
  ```
- **Token 链路分析**：
  - 在 `tokens.css:512` 中：`--composer-radius-multi: var(--radius-input);`；
  - 而 `--radius-input` 唯一定义为 `20px`（`tokens.css:497`）；
  - **严重缺陷**：虽然 CSS 源码编写者设计了 24px 作为多行外圆角（以适应增大的垂直 padding 8px），但由于 CSS 变量 `--composer-radius-multi` 已在全局定义为 20px，fallback 值 `24px` 永远不会生效！
- **同心几何推导对比**：
  - **实际生效态（$R_{outer} = 20px$）**：
    - 多行态底部控件（加号按钮、发送按钮）仍为 28x28px 正圆（$R_i = 14px$）；
    - 垂直内衬增大为 $P_y = 8px$；
    - 计算：
      $$R_i + P_y = 14px + 8px = 22px$$
      $$\Delta_y = R_{outer} - (R_i + P_y) = 20px - 22px = \mathbf{-2px}$$
    - **病灶呈现**：在多行态下，底部的正圆按钮拐角向外挤压，内外弧线法向间距在角部比平边缩小了 2px，产生明显的“卡角挤压”视觉瑕疵。
  - **设计意图态（若 $R_{outer} = 24px$ 生效）**：
    - $$\Delta_y = 24px - (14px + 8px) = 24 - 22 = +2px$$
    - 此时外圆角舒展，能够完全容纳 14px 内圆角与 8px 间距，消除挤压。

#### 4.1.3 空态输入框与全页落地布局（Session-Empty Landing Mode）
- **代码位置**：[`ChatComposer.module.css:1328-1334, 1918-1941`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1328-L1334)
- **几何特征**：
  - `.composerCard[data-empty-kind='session-empty'].isMultiline .fieldSlot`: `padding: 8px 7px 0 7px;`；
  - 默认多行高度：`min-height: calc(1em * var(--composer-line-height, 1.5) * 3);`；
  - 发送按钮常驻（Disabled 态占位保持 28x28px）；
  - 边框与阴影遵循克制规范（零跳变，`border-color: var(--border-subtle)`）；
  - 圆角与常规多行态一致，同样受制于多行 20px 覆写病灶。

#### 4.1.4 选区批注卡片浮层（AnnPopoverCard）—— 规范标杆
- **代码位置**：[`ChatComposer.module.css:1034-1056`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1034-L1056)
- **代码声明**：
  ```css
  .annPopoverCard {
    /* 同心几何标尺：外圆角 = 内圆角 + 内边距 (Ro = Ri + P = 6 + 12 = 18px) */
    --ann-pad: 12px;
    --ann-radius-inner: 6px;
    --ann-radius-outer: calc(var(--ann-radius-inner) + var(--ann-pad));

    border-radius: var(--ann-radius-outer);
    padding: var(--ann-pad);
  }
  .annInputContainer {
    border-radius: var(--ann-radius-inner); /* 6px */
  }
  .annCancelBtn, .annSaveBtn {
    border-radius: var(--ann-radius-inner); /* 6px */
  }
  ```
- **分析**：
  开发者在批注卡片中显式遵循了同心几何数学法则：
  $$R_{outer} = 6px + 12px = 18px \implies \Delta = 0px$$
  内部输入框、按钮组与外容器四角间距完美平行，是 ChatComposer 体系内部最规范的局部范例。

---

### 4.2 Layer 3: 附件与文件引用区（Attachment Bar）

- **代码位置**：[`ChatComposer.module.css:691-737, 945-981`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L691-L737) 与 [`AttachmentCard.module.css:7-58, 257-284`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-attachment/AttachmentCard.module.css#L7-L58)

#### 4.2.1 58x58 原子卡片与叉号按钮同心对齐
- **外卡片**（`.attachChip` / `.fileCard`）：
  - 尺寸：58x58px；
  - `border-radius: var(--composer-attach-card-radius, var(--radius-xl));`
  - Token 解析：`tokens.css:527`: `--composer-attach-card-radius: var(--radius-l);`（12px）；
  - `padding: 6px;`。
- **右上角删除按钮**（`.attachRemove` / `.fileRemove`）：
  - 尺寸：18x18px 正圆（`border-radius: 50%`，半径 $R_i = 9px$）；
  - 定位：`top: 3px; right: 3px;`；
- **同心几何推导**：
  - 删除按钮距离卡片外边缘顶端和右端距离均为 3px（$P_x = 3px, P_y = 3px$）；
  - 按钮中心位于 $(58 - 3 - 9, 3 + 9) = (46, 12)$；
  - 外卡片右上圆弧半径为 12px，其圆心位于 $(58 - 12, 12) = (46, 12)$！
  - **圆心完全重合**！
    $$R_i + P = 9px + 3px = 12px = R_{outer} \implies \Delta = 0px$$
  - **结论**：附件卡片的删除叉号与卡片外圆角构成了隐蔽但极其严谨的同心圆弧结构。

#### 4.2.2 横向文件微卡片（`.fileCardHorizontal`）
- **外卡片**：
  - 尺寸：高度 50~52px，宽度 160~220px；
  - `border-radius: 12px;`；
  - `padding: 6px 10px;`（垂直 6px，水平 10px）。
- **内部图标框**（`.fileIconBox`）：
  - 尺寸：28x28px；
  - `border-radius: var(--radius-md);`（8px）；
  - 垂直居中于 50px 卡片中，垂直间距为 $(50 - 28)/2 = 11px$；
  - 水平左边距由容器 padding 提供，为 10px。
- **同心推导**：
  - 垂直方向：$R_i + P_y = 8px + 11px = 19px$ vs $R_o = 12px \implies \Delta_y = \mathbf{-7px}$；
  - 水平方向：$R_i + P_x = 8px + 10px = 18px$ vs $R_o = 12px \implies \Delta_x = \mathbf{-6px}$；
  - **病灶呈现**：严重反同心倒挂！内部图标框圆角（8px）加上边距（10~11px）远大于卡片外圆角（12px），导致左侧视觉重心过满，外角显得过于局促。

---

### 4.3 Layer 2: 目标/计划进度条（PlanProgressBar）

- **代码位置**：[`ChatComposer.module.css:351-480`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L351-L480)
- **外容器**（`.planProgressBar`）：
  - `border-radius: var(--radius-lg);`；
  - 在 `tokens.css:506` 中：`--radius-lg: var(--radius-m);`（8px！）；
- **内部折叠栏**（`.planCollapsed`）：
  - 高度 44px，`padding: 6px 12px;`；
  - **内部模式徽标**（`.planModeBadge`）：
    - 高度 24px，`border-radius: var(--radius-md);`（8px）；
    - 垂直居中于 44px 栏内，垂直边距 $(44 - 24)/2 = 10px$；
    - 水平左边距 12px；
    - 推导：$R_i + P_y = 8 + 10 = 18px$ vs $R_o = 8px \implies \Delta_y = \mathbf{-10px}$！
  - **右侧操作按钮**（`.planActionBtn`）：
    - 24x24px，`border-radius: var(--radius-sm);`（4px）；
    - 垂直边距 10px，右边距 12px；
    - 推导：$R_i + P_y = 4 + 10 = 14px$ vs $R_o = 8px \implies \Delta_y = \mathbf{-6px}$！
- **结论**：
  计划进度条外卡片使用 8px 圆角极为拘谨，而内部 Badge 也是 8px，形成了“外框与内块同圆角、但边距高达 10px”的严重倒挂几何，外框四角在视觉上显得像直角。

---

### 4.4 Layer 1: 浮动权限审批条（FlowPermissionBar）与灵动配重通知条（ComposerNoticeBar）

#### 4.4.1 浮动权限审批条（`.flowPermissionBar`）
- **代码位置**：[`ChatComposer.module.css:80-101, 280-305`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L80-L101)
- **外容器**：
  - `border-radius: var(--radius-xl);`（12px）；
  - `padding: 6px 12px;`；
- **内部按钮**（`.flowPermissionBtn`）：
  - 高度 22px，`border-radius: var(--radius-sm);`（4px）；
  - 垂直边距 6px；
  - 推导：
    $$R_i + P_y = 4px + 6px = 10px \implies \Delta_y = 12px - 10px = \mathbf{+2px}$$
  - **评价**：差值仅 +2px，基本处于肉眼舒适的同心容差范围内。

#### 4.4.2 灵动配重通知条（`.noticeBar`）
- **代码位置**：[`ComposerNoticeBar.module.css:7-22, 147-181`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposerNoticeBar.module.css#L7-L22)
- **外容器**：
  - 高度 48px，`border-radius: var(--composer-radius-single, 20px);`（20px）；
  - `padding: 0 10px 0 14px;`；
- **内部快捷微胶囊**（`.actionPill`）：
  - 高度 26px，`border-radius: var(--radius-md);`（8px）；
  - 垂直居中于 48px 栏内，垂直边距 $(48 - 26)/2 = 11px$；
  - 右侧外边距由容器 padding 提供为 10px；
  - 同心推导：
    $$\Delta_y = 20px - (8px + 11px) = \mathbf{+1px}$$
    $$\Delta_x = 20px - (8px + 10px) = \mathbf{+2px}$$
  - **评价**：垂直与水平差值均为 +1~+2px，与外圆角 20px 形成了极佳的同心顺滑感。

---

### 4.5 输入区弹出菜单体系（ComposePlusMenu / PermissionModeMenu / FusedMenu）

- **代码位置**：
  - `ComposePlusMenu.module.css:6-45`
  - `PermissionModeMenu.module.css:141-189`
  - `ComposerFusedTrigger.module.css:259-302`
- **外容器与内项目参数**：
  - 菜单外壳：`border-radius: var(--sep-radius-outer, 12px);`（在 `tokens.css` 中解析为 12px，虽然部分 fallback 写了 14px）；
  - 菜单内衬：`padding: 6px;`；
  - 菜单项：`border-radius: var(--sep-item-radius, 8px);`（8px）；
- **同心推导**：
  $$R_{inner} + P = 8px + 6px = 14px$$
  $$\Delta = R_{outer} - (R_{inner} + P) = 12px - 14px = \mathbf{-2px}$$
- **关键发现**：
  CSS 代码中的注释写着：`/* min-width: 188px, 14px outer / 8px inner item radius */`。原始设计意图是外圆角 14px、内圆角 8px、内衬 6px（$14 = 8 + 6$，完美同心）。但由于全局将 `--sep-radius-outer` 强行收拢为 `--radius-l` (12px)，导致所有这类下拉菜单外壳均产生了 -2px 的倒挂挤压！

---

## 五、 消息流与卡片体系（ChatStream / Messages）全盘勘察

### 5.1 用户消息气泡（UserBubble）

- **代码位置**：[`ChatMessageRow.module.css:137-164, 213-252`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L137-L164)
- **外气泡容器**（`.userBubble`）：
  - `border-radius: var(--chat-bubble-radius, var(--radius-xl));`
  - Token 解析：`tokens.css:526`: `--chat-bubble-radius: var(--radius-input);`（20px）；
  - `padding: 10px 14px;`（垂直 10px，水平 14px）。
- **内部嵌套元素同心分析**：
  1. **纯文本正文**：`.userBubbleText` 纯文字排印，无独立外框；
  2. **结构化上下文外壳 `.userBubbleContextEnvelope`**：
     - `border-radius: var(--radius-md, 6px);`（在 `tokens.css:505` 中为 8px）；
     - `padding: 6px 10px;`；
     - 内部徽标 `.userBubbleContextBadge`：`border-radius: var(--radius-xs, 4px);`（4px）；
     - 徽标与 Envelope 同心度：$R_i + P_y = 4 + 6 = 10px$ vs Envelope $R_o = 8px \implies \Delta_y = -2px$；
     - Envelope 与 UserBubble 同心度：Envelope $R_o = 8px$，边距 10px/14px。外气泡 20px 包裹 8px 卡片，差值 $\Delta_y = 20 - (8 + 10) = +2px$，表现良好。
  3. **附件条 `.userAttachmentStrip` 嵌套 58x58 附件卡片**：
     - 附件卡片圆角：12px；
     - 气泡内边距：$P_y = 10px, P_x = 14px$；
     - 计算：
       $$\Delta_y = 20px - (12px + 10px) = 20 - 22 = \mathbf{-2px}$$
       $$\Delta_x = 20px - (12px + 14px) = 20 - 26 = \mathbf{-6px}$$
     - **病灶呈现**：当用户发送带附件的消息时，附件卡片由于外圆角偏小，在气泡右上/左上角呈现明显的顶撞与狭窄感。

---

### 5.2 助手消息流与思考行（Assistant Message & ReasoningRow）

- **代码位置**：[`ReasoningRow.module.css:86-144, 327-348`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css#L86-L144) 与 [`FoldableProcessSection.module.css:24-69`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/FoldableProcessSection.module.css#L24-L69)
- **几何分析**：
  - 思考折叠行采用极简 24px 单行设计（`.reasoningRow`），无实体卡片背景与外框，仅在 `:focus-visible` 时出现 `border-radius: var(--radius-sm)` (4px)；
  - 展开态内容区 `.reasoningBody` 采用左侧发丝指示线 `border-left: 2px solid var(--border-subtle)`，无圆角嵌套冲突；
  - 过程折叠分段 `.section`（`FoldableProcessSection`）同样为纯文本流与 33px 极简控制栏，零卡片外壳，避免了多重边框与圆角堆叠。

---

### 5.3 代码块（CodeBlock）体系

- **代码位置**：[`ChatMessageRow.module.css:679-701, 770-826`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L679-L701)
- **外容器**（`.assistantText :global(.md-code-block)`）：
  - `border-radius: var(--md-code-block-radius, var(--radius-lg));`
  - Token 解析：`tokens.css:530`: `--md-code-block-radius: var(--radius-m);`（8px）；
- **实体顶栏**（`.md-code-header`）：
  - 高度 32px，`padding: 0 var(--space-2, 8px) 0 var(--space-3, 12px);`；
  - **右侧复制按钮**（`.md-code-copy`）：
    - 高度 22px，`padding: 0 8px;`，`border-radius: var(--radius-sm);`（4px）；
    - 垂直居中于 32px 头部中，垂直边距 $(32 - 22)/2 = 5px$；
    - 右侧边距由 header padding 提供为 8px；
    - 推导：
      $$\Delta_y = 8px - (4px + 5px) = 8 - 9 = \mathbf{-1px}$$
      $$\Delta_x = 8px - (4px + 8px) = 8 - 12 = \mathbf{-4px}$$
  - **左侧语言标签**（`.md-code-lang`）：
    - `padding: 1px 6px;`，`border-radius: var(--radius-sm);`（4px）；
- **评价**：代码块外框 8px 搭配内部 4px 按钮，垂直差值仅 -1px，整体贴合度尚可，但水平侧边略显紧凑。

---

### 5.4 工具调用卡片（ToolCallCard / ModernToolCall）

- **代码位置**：[`ModernToolCall.module.css:138-201, 206-308, 436-591, 686-819`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L138-L201)

#### 5.4.1 结构化 JSON 工具卡片（`.jsonToolCard`）
- `border-radius: var(--radius-xl);`（12px）；
- 内部分区 `.cardSection`：`padding: 10px 14px;`；
- 无嵌套复杂角标，主要承载代码与纯文本。

#### 5.4.2 终端命令行工具卡片（`.terminalCard`）
- 外容器：`border-radius: var(--radius-xl);`（12px）；
- **顶栏复制按钮**（`.terminalCopyBtn`）：
  - 尺寸：22x22px，`border-radius: var(--radius-sm);`（4px）；
  - 顶栏 `padding: 8px 12px;`，垂直总高 38px；
  - 垂直边距 8px，右侧边距 12px；
  - 同心推导：
    $$\Delta_y = 12px - (4px + 8px) = 12 - 12 = \mathbf{0px} \quad \text{（完美垂直同心！）}$$
    $$\Delta_x = 12px - (4px + 12px) = 12 - 16 = \mathbf{-4px}$$
- **中部折叠条**（`.terminalMidFoldBar`）：
  - `padding: 6px 12px;`，`border-radius: var(--radius-sm);`（4px）。

#### 5.4.3 权限询问卡片（`.approvalCard`）与嵌套代码盒
- 外容器：`border-radius: var(--radius-xl);`（12px）；
- 顶部盾牌 `.approvalShield`：22x22px，`border-radius: var(--radius-md);`（8px）；
- **主体嵌套目标代码盒**（`.approvalTargetBox`）：
  - `border-radius: var(--radius-lg);`（8px）；
  - 嵌套在 `.approvalBody`（`padding: 14px 16px;`）内部；
  - 同心推导：
    $$\Delta_y = 12px - (8px + 14px) = 12 - 22 = \mathbf{-10px}$$
    $$\Delta_x = 12px - (8px + 16px) = 12 - 24 = \mathbf{-12px}$$
  - **严重病灶**：在 14~16px 边距下，外容器 12px 圆角内塞进一个 8px 圆角的子盒子，产生极其突兀的“外框过紧、内盒过大”的压迫感。

#### 5.4.4 Diff 差异比对卡片（`.diffCard`）
- 外容器：`border-radius: var(--radius-xl);`（12px）；
- 顶栏 `.diffCardHeader`：min-height 36px，`padding: 8px 12px;`；
- 内部按钮 `.diffActionBtn`：24x24px，`border-radius: var(--radius-xs);`（4px）；
  - 垂直边距 $(36 - 24)/2 = 6px$；
  - 推导：$\Delta_y = 12px - (4px + 6px) = \mathbf{+2px}$（同心良好）。

---

### 5.5 产物与悬浮预览卡片（Artifact / PreviewCard）

- **流内产物行**（`FlowArtifactChip.module.css:22-53`）：
  - 采用下划线纯文本交互，`border-radius: 0;`，不引入多余圆角层级。
- **悬浮预览卡**（`ui/PreviewCard/PreviewCard.module.css:12-26`）：
  - `border-radius: var(--radius-xl);`（12px）；
  - `padding: var(--space-3, 12px) var(--space-4, 16px);`；
  - 内部标题与正文纯文本排印，无子卡片嵌套冲突。

---

## 六、 全量测量数据与同心度判定总表

下表汇集对话输入区与主消息流卡片体系中，所有存在“父容器 - 子元素”嵌套关系的实测数据（单位：px）：

| 序号 | 容器 / 模块名称 | 外容器选择器 | 外圆角 $R_o$ | 内边距 Padding ($P_y \times P_x$) | 内部嵌套控件/卡片 | 内圆角 $R_i$ | 同心差值 $\Delta_y$ | 同心差值 $\Delta_x$ | 几何状态判定 | 精确代码位置 |
| :---: | :--- | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :---: | :--- |
| **01** | **基线范例** | `.chatSoftHint` | **18** | $10 \times 10$ (end) | `.chatSoftHintAction` | 8 | **0** | **0** | **完美同心 (基线标杆)** | [`SetupHintBanner.module.css:2-17`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css#L2-L17) |
| **02** | 主输入框 (单行态) | `.composerCard` | **20** | $6 \times 10$ | 左侧 `+` 按钮 `.plusBtn` | 14 (50%) | **0** | -4 | 垂直完美同心 / 水平轻微挤压 | [`ChatComposer.module.css:1276, 1445`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1276) |
| **03** | 主输入框 (单行态) | `.composerCard` | **20** | $6 \times 10$ | 发送按钮 `.sendCircle` | 14 (50%) | **0** | -4 | 垂直完美同心 / 水平轻微挤压 | [`ChatComposer.module.css:1276, 1535`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1276) |
| **04** | 主输入框 (多行态) | `.composerCard.isMultiline` | **20** (Token覆写) | $8 \times 10$ | 底部 `+` / 发送按钮 | 14 (50%) | **-2** | **-4** | **倒挂挤压 (Token覆写病灶)** | [`ChatComposer.module.css:1290-1293`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1290-L1293) |
| **05** | 选区批注卡片 | `.annPopoverCard` | **18** | $12 \times 12$ | 输入区 / 按钮组 | 6 | **0** | **0** | **完美同心 (公式范式)** | [`ChatComposer.module.css:1034-1056`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1034-L1056) |
| **06** | 附件卡片删除叉号 | `.attachChip` | **12** | $3 \times 3$ (top/right) | 删除按钮 `.attachRemove` | 9 (50%) | **0** | **0** | **完美同心 (几何重合)** | [`ChatComposer.module.css:947-957`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L947-L957) |
| **07** | 横向文件微卡片 | `.fileCardHorizontal` | **12** | $6 \times 10$ ($P_y$实为11) | 图标框 `.fileIconBox` | 8 | **-7** | **-6** | **严重倒挂** | [`ChatComposer.module.css:806-836`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L806-L836) |
| **08** | 目标计划进度条 | `.planProgressBar` | **8** | $10 \times 12$ (Collapsed) | 模式徽标 `.planModeBadge` | 8 | **-10** | -12 | **极度倒挂** | [`ChatComposer.module.css:351-480`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L351-L480) |
| **09** | 浮动权限审批条 | `.flowPermissionBar` | **12** | $6 \times 12$ | 审批按钮 `.flowPermissionBtn` | 4 | **+2** | -4 | 良好同心 | [`ChatComposer.module.css:80-101`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L80-L101) |
| **10** | 灵动配重通知条 | `.noticeBar` | **20** | $11 \times 10$ (Right) | 行动药丸 `.actionPill` | 8 | **+1** | **+2** | **极佳同心** | [`ComposerNoticeBar.module.css:7-22`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposerNoticeBar.module.css#L7-L22) |
| **11** | 输入区弹出菜单 | `.plusMenu` / `.permMenu` | **12** | $6 \times 6$ | 菜单项 `.item` / `.permMenuItem` | 8 | **-2** | **-2** | **轻微倒挂 (Token收拢后遗症)** | [`ComposePlusMenu.module.css:6-45`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css#L6-L45) |
| **12** | 用户消息气泡(附件) | `.userBubble` | **20** | $10 \times 14$ | 附件卡片 (58x58) | 12 | **-2** | **-6** | **显著挤压** | [`ChatMessageRow.module.css:137-164`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L137-L164) |
| **13** | 用户气泡上下文外壳 | `.userBubbleContextEnvelope` | **8** | $6 \times 10$ | 徽标 `.userBubbleContextBadge` | 4 | **-2** | -6 | 轻微倒挂 | [`ChatMessageRow.module.css:213-246`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L213-L246) |
| **14** | 代码块顶栏 | `.md-code-block` | **8** | $5 \times 8$ | 复制按钮 `.md-code-copy` | 4 | **-1** | -4 | 基本顺滑 | [`ChatMessageRow.module.css:679-826`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L679-L826) |
| **15** | 终端工具卡片 | `.terminalCard` | **12** | $8 \times 12$ | 复制按钮 `.terminalCopyBtn` | 4 | **0** | -4 | **垂直完美同心** | [`ModernToolCall.module.css:206-271`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L206-L271) |
| **16** | 权限询问卡片内盒 | `.approvalCard` | **12** | $14 \times 16$ | 目标代码盒 `.approvalTargetBox` | 8 | **-10** | -12 | **极度倒挂** | [`ModernToolCall.module.css:436-520`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L436-L520) |
| **17** | Diff 比对卡片 | `.diffCard` | **12** | $6 \times 12$ | 操作按钮 `.diffActionBtn` | 4 | **+2** | -4 | 良好同心 | [`ModernToolCall.module.css:686-800`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L686-L800) |

---

## 七、 根因归纳与治理建议

### 7.1 核心根因归纳

1. **Token 层次一刀切破坏了微观几何同心（Token Over-Coarsening）**：
   - 当前 `tokens.css` 将圆角绝对收敛在 5 档（s: 4px, m: 8px, l: 12px, input: 20px, pill: 9999px）。
   - 这种强力归一化在宏观组件上整齐划一，但在微观嵌套场景下失效：
     - 例如下拉菜单需要 $R_o = 14px$ 才能容纳 $P = 6px$ 和 $R_i = 8px$；强行改为 12px 必然引发 -2px 倒挂；
     - 多行输入框需要 $R_o = 24px$ 才能容纳 $P = 8px$ 和 $R_i = 14px$；强行绑定 `--radius-input`（20px）直接破坏了几何流线。
2. **各向异性内衬（$P_x \ne P_y$）带来的必然差值撕裂**：
   - 输入框与大多数卡片采用较小的垂直内衬与较大的水平内衬（如 6px vs 10px、10px vs 14px）。
   - 正圆圆角不可能同时满足双向同心。目前代码均优先保证垂直视平线同心（$\Delta_y \approx 0$），而任由水平方向产生 -4px ~ -6px 的挤压。
3. **复合嵌套卡片（Box-in-Card）未遵循递减法则**：
   - 诸如 `approvalTargetBox`、`planModeBadge` 等元素，自身圆角设为 8px，但边距却高达 10~14px，外容器圆角却仅为 8~12px。
   - 彻底违反了 $R_{inner} = \max(0, R_{outer} - P)$ 的物理直觉，导致外框看起来比内盒还要“方”。

### 7.2 后续统一治理实施建议（无退避方案）

1. **确立公式化 CSS 计算变量（Formulaic Radius Tokens）**：
   全面推广 `SetupHintBanner` 与 `annPopoverCard` 的成功范例：
   ```css
   /* 推荐范式：外圆角由内控件与内衬动态合成 */
   --container-pad: 8px;
   --item-radius: var(--radius-m, 8px);
   --container-radius: calc(var(--item-radius) + var(--container-pad));
   ```
2. **释放语义契约 Token 独立性（Uncouple Semantic Radius Tokens）**：
   解除 `tokens.css:512` 中 `--composer-radius-multi: var(--radius-input);` 的硬编码绑定，将其恢复为独立的 `24px`（或公式 `calc(14px + 8px + 2px)`），彻底根除多行态下的 -2px 挤压病灶。
3. **嵌套子盒子圆角自动衰减原则**：
   对于任何嵌套在内衬 $P \ge 10px$ 内部的子盒子，其圆角 $R_{inner}$ 必须遵循：
   $$R_{inner} \le \max(4px, R_{outer} - P)$$
   例如在 12px 外圆角卡片中，嵌套盒子的圆角应收敛为 4px 或直角，严禁再使用 8px 甚至更大的圆角。
4. **水平内衬光学微补偿（Optical Margin Tuning）**：
   对于单行与多行输入框两端的正圆按钮，可适当通过微调端头内衬（如 $P_{x-start} = 8px$），使 $\Delta_x$ 从 -4px 收敛至 -2px 以内，达成更均衡的双向同心视觉感受。
