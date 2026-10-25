# Conex / Crish Token 体系与工业几何同心数学分析报告

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **报告编号**：05-tokens-radius-ssot-and-concentric-math-analysis  
> **责任专家**：Token 体系与几何数学分析员（Agent-05）  
> **产出日期**：2026-10-25  
> **目标路径**：`docs/concentric-radius-unification/analysis/05-tokens-radius-ssot-and-concentric-math-analysis.md`  
> **审查基准**：`apps/crish-desktop/src/styles/tokens.css`、全仓组件样式规范与工业几何同心数学公理

---

## 目录

1. [执行摘要与核心论断](#一-执行摘要与核心论断)
2. [全仓圆角与间距 Token 全链路现状穿透](#二-全仓圆角与间距-token-全链路现状穿透)
   - 2.1 [基础 5 档 SSOT 与极值规范](#21-基础-5-档-ssot-与极值规范)
   - 2.2 [用户锁例外与按钮圆角契约](#22-用户锁例外与按钮圆角契约)
   - 2.3 [传统别名映射的坍塌与消费频次统计](#23-传统别名映射的坍塌与消费频次统计)
   - 2.4 [场景契约 Token 谱系与幽灵计算剖析](#24-场景契约-token-谱系与幽灵计算剖析)
3. [间距与内衬 Token 体系的数学解构](#三-间距与内衬-token-体系的数学解构)
   - 3.1 [基础间距阶梯与离散网格](#31-基础间距阶梯与离散网格)
   - 3.2 [UI Size 密度档位对同心几何的破坏性脱节](#32-ui-size-密度档位对同心几何的破坏性脱节)
4. [工业几何学：严格同心圆角数学模型](#四-工业几何学严格同心圆角数学模型)
   - 4.1 [同心圆弧基础几何公理与控制方程](#41-同心圆弧基础几何公理与控制方程)
   - 4.2 [退化边界、超距平直区与有效嵌套域](#42-退化边界超距平直区与有效嵌套域)
   - 4.3 [四大几何病态与视觉畸变机理](#43-四大几何病态与视觉畸变机理)
   - 4.4 [核心定理一：奇偶校验破缺定理 (Parity Invariance Theorem)](#44-核心定理一奇偶校验破缺定理-parity-invariance-theorem)
   - 4.5 [核心定理二：阶梯跨度完备性定理 (Scale Completeness Theorem)](#45-核心定理二阶梯跨度完备性定理-scale-completeness-theorem)
5. [全仓典型场景同心数学代数审查](#五-全仓典型场景同心数学代数审查)
   - 5.1 [场景 1：Card / LeafBody 容器与内嵌元素的几何撕裂](#51-场景-1card--leafbody-容器与内嵌元素的几何撕裂)
   - 5.2 [场景 2：Modal / Dialog 大弹窗坍塌至 12px 的历史溯源与视觉钝化](#52-场景-2modal--dialog-大弹窗坍塌至-12px-的历史溯源与视觉钝化)
   - 5.3 [场景 3：避难式 calc() 的现场自证（Select / SetupHint / Popover）](#53-场景-3避难式-calc-的现场自证select--setuphint--popover)
   - 5.4 [场景 4：SegmentedControl 与 Tabs 的滑块与 5px 亚像素危机](#54-场景-4segmentedcontrol-与-tabs-的滑块与-5px-亚像素危机)
6. [标准化同心圆角阶梯矩阵表](#六-标准化同心圆角阶梯矩阵表)
   - 6.1 [全域容器 × 内边距 × 子元素标准阶梯矩阵](#61-全域容器--内边距--子元素标准阶梯矩阵)
   - 6.2 [各级组件装配同心几何速查表](#62-各级组件装配同心几何速查表)
7. [未来演进建议与设计系统修复路线](#七-未来演进建议与设计系统修复路线)

---

## 一、 执行摘要与核心论断

本报告针对 Conex / Crish 桌面端应用（`apps/crish-desktop`）的 Design Token 体系与几何嵌套现状，从**工业产品几何学**与**微分代数**的严格视角进行了全链路审查。

```
                               【同心几何失效拓扑】
                               
   Tokens.css 5 档 SSOT              传统 7 档别名映射               真实组件消费
   ┌─────────────────┐             ┌─────────────────┐             ┌─────────────────┐
   │ --radius-s:  4px│ ──────────► │ --radius-xs: 4px│ ──────────► │ Badge, Tag (60) │
   │                 │ ──────────► │ --radius-sm: 4px│ ──────────► │ Item, Btn (191) │
   ├─────────────────┤             ├─────────────────┤             ├─────────────────┤
   │ --radius-m:  8px│ ──────────► │ --radius-md: 8px│ ──────────► │ Tab, Item (128) │
   │                 │ ──────────► │ --radius-lg: 8px│ ──────────► │ Card, Box  (92) │
   ├─────────────────┤             ├─────────────────┤             ├─────────────────┤
   │ --radius-l: 12px│ ──────────► │ --radius-xl:12px│ ──────────► │ Card, Pane (55) │
   │                 │ ──────────► │ --radius-2xl:12px ──────────► │ Modal, Pop  (5) │
   ├─────────────────┤             └─────────────────┘             └─────────────────┘
   │ --radius-input:20px ────────► --radius-3xl: 20px ───────────► Composer, Bubble
   ├─────────────────┤
   │ --radius-pill:9999px ───────► --radius-full: 9999px
   └─────────────────┘
           ▲
           │ (严重缺失 6px, 10px, 14px, 16px, 24px)
           │ 导致 R_inner = R_outer - Padding 无法在 Token 域内自洽闭包！
```

### 核心论断

1. **圆角阶梯的严重代数不完备（Algebraic Incompleteness）**：  
   2026-10-10 实施的“5 档 SSOT 收拢”（`--radius-s: 4px`, `--radius-m: 8px`, `--radius-l: 12px`, `--radius-input: 20px`, `--radius-pill: 9999px`）虽然抑制了历史无序的裸写像素，但**阶梯颗粒度过粗**。现代复杂 UI 界面中容器与内嵌元素的间距多为 $4\text{px}, 6\text{px}, 8\text{px}, 10\text{px}, 12\text{px}, 16\text{px}$，在同心方程 $R_{inner} = R_{outer} - P$ 下，所求得的理论圆角集合涵盖 $\{2, 4, 6, 8, 10, 12, 14, 16, 18, 24\}\text{px}$。由于缺少关键的 **6px、14px、16px、24px**，全仓组件为了追求视觉同心，被迫在 CSS 中裸写各种逃逸式 `calc()` 计算，或者直接妥协摆烂，导致几何撕裂。

2. **`--radius-2xl` 的强制坍塌与全站弹窗视觉钝化**：  
   `--radius-2xl` 在 `tokens.css:508` 中被直接等同于 `--radius-l`（12px）。这导致尺寸高达 $640\text{px} \sim 1040\text{px}$ 的 `Dialog`、`Modal` 以及各类上下文浮层，全部被约束在卡片级别的 12px 小圆角内，丧失了现代桌面操作系统（如 macOS Sequoia / Windows 11 Fluent 2）大浮层应有的 20px~24px 柔和高级感；且因内边距多为 16px~24px，其内部元素几何完全跌入“超距退化直角区”。

3. **奇偶校验破缺定理（Parity Invariance Theorem）**：  
   用户锁（U1）将按钮圆角锁死在 **7px**（`--radius-btn: 7px`），而系统的间距 Token（`--space-*`）以及 DIM-02 门禁（`ODD_RADIUS_BASELINE`）严格执行**全偶数原则**。数学上，奇数（7px）加上任何偶数间距（$2k$）恒为奇数（$7 + 2k \equiv 1 \pmod 2$）。因此，**一个 7px 的内嵌按钮，在全偶数间距体系下，永远无法与任何偶数外容器达成完美同心**，必然存在至少 $\pm 1\text{px}$ 的几何漂移。

4. **密度档位（UI Size Gear）的动力学脱节**：  
   在 `html[data-ui-size='large']` 模式下，间距 Token 全线放大（`--space-1` 由 4px 变为 6px，`--space-2` 由 8px 变为 10px，`--space-4` 由 16px 变为 20px 等），但圆角 Token 却被硬编码为“圆角不再按密度档缩放，统一引用 :root 的 5 档”。当内边距 $P$ 动态膨胀 $+2\text{px} \sim +4\text{px}$ 而外圆角 $R_o$ 恒定时，原本在默认模式下对齐的同心系统在 Large 模式下**全线发生角部挤压与反向畸变**。

---

## 二、 全仓圆角与间距 Token 全链路现状穿透

### 2.1 基础 5 档 SSOT 与极值规范

权威单一真源位于 [tokens.css](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L486-L500)：

```css
/* apps/crish-desktop/src/styles/tokens.css:486-500 */
/* ── 圆角 SSOT（2026-10-10 统一）：只允许下列 5 档 + 正圆 50% + 0 ──
   s     小   4px    标签/徽标/行内代码/复选框/Kbd/骨架线/细条
   m     中   8px    图标按钮/小输入框/下拉触发器/菜单项/列表行/会话行/Tooltip/标签页/代码块/表格
         （文字按钮 + 分段控件 = --radius-btn 7px，用户锁 U1，唯一例外）
   l     大   12px   卡片/面板/弹层/下拉面板/对话框/工具调用块/附件卡片/artifact
   input 输入 20px   底部输入框（单行/多行）与用户消息气泡
   pill  胶囊 9999px 胶囊按钮/开关/滚动条滑块/计数胶囊
   旧 token（xs…3xl、btn、seg-*、sep-*、md-*、composer-*、chat-bubble）全部是这 5 档的别名。 */
--radius-s: 4px;
--radius-m: 8px;
--radius-l: 12px;
--radius-input: 20px;
--radius-pill: 9999px;
--radius-circle: 50%;
```

#### 极值与微型定义
- **正圆 Avatar / 状态指示灯**：`--radius-circle: 50%`；
- **打字机光标**：`--stream-caret-radius: 1px`；
- **全屏/直角退化**：`border-radius: 0`。

### 2.2 用户锁例外与按钮圆角契约

在 5 档标准梯队之外，系统存在唯一受保护的硬性用户锁：
```css
/* apps/crish-desktop/src/styles/tokens.css:500-502 */
--radius-btn: 7px; /* 用户锁 U1（survey 04）：按钮圆角钉死 7px，是 5 档之外唯一的例外；禁止改成 8px */
/* :root 唯一权威定义（U1）；密度档/主题块禁止覆写 */
--button-radius: var(--radius-btn);
```
- **业务背景**：源于早期用户交互调研，用户对主视觉操作按钮 7px 的精致边缘有极强直觉记忆，禁止机械合并为 8px；
- **派生消费**：`ui/Button` 默认档位、`ui/SegmentedControl`（`size="sm"` 与 `size="panel"`）。

### 2.3 传统别名映射的坍塌与消费频次统计

在 `tokens.css:503-509` 中，历史上的 7 阶 T-Shirt 尺寸（`xs` 到 `3xl`）被机械式归约映射到了上述 5 档中：

```css
--radius-xs: var(--radius-s);       /*  4px (原 2px 坍塌) */
--radius-sm: var(--radius-s);       /*  4px */
--radius-md: var(--radius-m);       /*  8px (原 6px 坍塌) */
--radius-lg: var(--radius-m);       /*  8px */
--radius-xl: var(--radius-l);       /* 12px (原 10px/14px 坍塌) */
--radius-2xl: var(--radius-l);      /* 12px (原 16px/24px 坍塌) */
--radius-3xl: var(--radius-input);  /* 20px (原 24px/26px 坍塌) */
```

#### 全仓组件真实消费频次统计（基于 `apps/crish-desktop/src` 全域静态扫描）

| Token 变量名称 | 解析像素值 | 全仓引用次数 | 典型消费场景 | 状态评估 |
| :--- | :---: | :---: | :--- | :--- |
| `var(--radius-sm)` | **4px** | **191 次** | 徽章、小型操作按钮、列表行、行内代码、输入框内衬 | **存量绝对主力**，但与 `xs` 语义完全重合 |
| `var(--radius-md)` | **8px** | **128 次** | 菜单项、Tab 选项、工具调用卡、表单触发器、代码块 | **次主力**，原本多预期为 6px，被拉伸至 8px |
| `var(--radius-lg)` | **8px** | **92 次** | 子卡片、弹层内卡、Ribbon 功能带、分段面板 | 与 `md` 完全同值（8px），产生严重的阶梯假象 |
| `var(--radius-xs)` | **4px** | **60 次** | 极小标签、Kbd 按键、微型角标、滑块轨道 | 与 `sm` 完全同值（4px），丧失 2px 微刻度 |
| `var(--radius-xl)` | **12px** | **55 次** | 卡片、面板、附件抽屉、弹窗内部容器 | 与 `2xl` 完全同值（12px） |
| `var(--radius-m)` | **8px** | **45 次** | SSOT 直接引用：Select 下拉项、Markdown 表格 | 正典消费 |
| `var(--radius-l)` | **12px** | **27 次** | SSOT 直接引用：`.leafBody` 内容矩形、大面板 | 正典消费 |
| `var(--radius-s)` | **4px** | **23 次** | SSOT 直接引用：小徽标、SEP 面板子项 | 正典消费 |
| `var(--radius-btn)` | **7px** | **17 次** | 文字按钮、图标动作钮、分段控件外壳 | 用户锁受控消费 |
| `var(--radius-input)`| **20px** | **7 次** | Composer 外框、用户气泡 | 专属场景正典 |
| `var(--radius-2xl)` | **12px** | **5 次** | Dialog 根容器、ProjectManageModal、ContextMenu | **严重受害者**，开发者写了 2xl 却只得 12px |
| `var(--radius-full)`| **9999px**| **5 次** | 滚动条滑块、胶囊指示条 | 别名桥接 |
| `var(--radius-pill)`| **9999px**| **5 次** | 胶囊按钮、Switch 轨道 | SSOT 直接引用 |
| `var(--radius-circle)`| **50%** | **2 次** | 头像圆形容器 | 几何正圆 |

> **关键证据发现**：  
> 开发者普遍偏好使用 `--radius-sm` (191) 和 `--radius-md` (128) 等语义梯度，但底层 `--radius-xs` 与 `--radius-sm` 均解析为 4px；`--radius-md` 与 `--radius-lg` 均解析为 8px；`--radius-xl` 与 `--radius-2xl` 均解析为 12px。  
> 开发者误以为自己在调用 4 档逐级递增的圆角阶梯，**但实际上系统只在 4px、8px、12px 三个点上反复横跳，阶梯分辨率被强行压缩了 50%**。

### 2.4 场景契约 Token 谱系与幽灵计算剖析

在 `tokens.css` 中，还声明了第二层面向场景的契约 Token：
- `--composer-radius-single`: `var(--radius-input)` (20px)
- `--composer-radius-multi`: `var(--radius-input)` (20px)
- `--chat-bubble-radius`: `var(--radius-input)` (20px)
- `--composer-attach-card-radius`: `var(--radius-l)` (12px)
- `--sep-radius-outer`: `var(--radius-l)` (12px)
- `--sep-item-radius`: `var(--radius-m)` (8px)
- `--sep-badge-radius`: `var(--radius-s)` (4px)
- `--md-code-block-radius`: `var(--radius-m)` (8px)
- `--artifact-card-radius`: `var(--radius-l)` (12px)

#### 幽灵计算：Usage Capsule 的 9996px 荒诞闭环
在 `tokens.css:1733-1737` 及 `1921-1926` 中，存在一处极具代表性的代数漂移证据：
```css
/* apps/crish-desktop/src/styles/tokens.css:1921-1926 */
/* 胶囊进度行：outer(9px) = inner(6px) + pad(3px) */
--usage-capsule-outer-radius: var(--radius-pill);
--usage-capsule-pad: 3px;
--usage-capsule-inner-radius: calc(
  var(--usage-capsule-outer-radius) - var(--usage-capsule-pad)
); /* 6px */
```
- **代码注释意图**：作者希望外层胶囊高 18px，外圆角为 9px，内衬 3px，内部进度条圆角为 $9\text{px} - 3\text{px} = 6\text{px}$；
- **代码实际实现**：由于 9px 是奇数，且不在 5 档 SSOT 中，被机械替换为 `var(--radius-pill)`（9999px）；
- **计算结果**：内圆角被求值为 `calc(9999px - 3px) = 9996px`！虽然浏览器因高度截断表现为两端半圆，但其几何语义完全荒诞，注释中声明的 `/* 6px */` 沦为绝对的虚妄伪证。

---

## 三、 间距与内衬 Token 体系的数学解构

### 3.1 基础间距阶梯与离散网格

权威间距单一真源位于 [tokens.css:967-979](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L967-L979)：

```css
--space-0_5: 2px;
--space-1:   4px;
--space-1_5: 6px;
--space-2:   8px;
--space-2_5: 10px;
--space-3:   12px;
--space-3_5: 14px;
--space-4:   16px;
--space-5:   20px;
--space-6:   24px;
--space-7:   28px;
--space-8:   32px;
--space-10:  40px;
```

该间距体系具备极高的工业严密性：以 2px 和 4px 为离散原子单位，构建了严格单调且全偶数的空间网格。

### 3.2 UI Size 密度档位对同心几何的破坏性脱节

系统在 `tokens.css:1783-1917` 实现了三档 UI 密度控制（Small / Normal / Large）。

#### 间距 vs 圆角在不同密度档位下的行为对比：

| Token | Normal（默认） | Small（紧凑） | Large（宽松） | Large 相对变化量 |
| :--- | :---: | :---: | :---: | :---: |
| `--space-1` | 4px | 4px | **6px** | **+2px (+50%)** |
| `--space-1_5` | 6px | 6px | **8px** | **+2px (+33%)** |
| `--space-2` | 8px | 8px | **10px** | **+2px (+25%)** |
| `--space-2_5` | 10px | 10px | **12px** | **+2px (+20%)** |
| `--space-3` | 12px | 12px | **14px** | **+2px (+17%)** |
| `--space-4` | 16px | 16px | **20px** | **+4px (+25%)** |
| `--space-5` | 20px | 20px | **24px** | **+4px (+20%)** |
| **`--radius-s`** | **4px** | **4px** | **4px** | **0px (冷冻)** |
| **`--radius-m`** | **8px** | **8px** | **8px** | **0px (冷冻)** |
| **`--radius-l`** | **12px** | **12px** | **12px** | **0px (冷冻)** |
| **`--radius-input`** | **20px** | **20px** | **20px** | **0px (冷冻)** |

#### 动力学失衡机理
在 `tokens.css:1827` 与 `1895` 中写有硬性门禁注释：
> `/* large 密度档：圆角不再按密度档缩放，统一引用 :root 的 5 档 */`

这一设计初衷是为了避免按钮和控件出现过于夸张的大圆角，但其副作用极其严重：
- **同心几何方程**：$R_{inner} = R_{outer} - P$；
- **在 Normal 档**：若某 Card 外圆角为 $R_o = 12\text{px}$，内边距 $P = 4\text{px}$（`--space-1`），则内元素为 $R_i = 12 - 4 = 8\text{px}$（`--radius-m`），两者保持同心；
- **在 Large 档**：外圆角 $R_o$ 被死锁在 12px，但内边距 `--space-1` 膨胀到了 **6px**。此时同心要求 $R_i = 12 - 6 = 6\text{px}$。然而内元素依然引用死锁的 `--radius-m`（8px）！
- **几何偏差**：$\Delta = 12 - (8 + 6) = -2\text{px}$。在 Large 模式下，**所有容器内嵌子元素均发生了 2px~4px 的角部挤压（Pinching）**。

---

## 四、 工业几何学：严格同心圆角数学模型

为了根除凭感觉打补丁的魔术数字，本章建立基于平面欧氏几何与微分曲线的标准化同心数学模型。

### 4.1 同心圆弧基础几何公理与控制方程

在 2D 矩形嵌套系统中，考虑外层容器 $\Omega_{out}$ 包裹内层元素 $\Omega_{in}$：

```
                      (0,0) ┌───────────────────────────────┐
                            │    P                          │
                            │ ┌──┴────────────────────────┐ │
                            │ │                           │ │
                            │ │   Inner Element           │ │
                            │ │   Radius = Ri             │ │
                            │ │                           │ │
                            │ └───────────────────────────┘ │
                            │              Outer Container  │
                            │              Radius = Ro      │
                            └───────────────────────────────┘
```

设：
- 外矩形边界曲率半径为 $R_o$；
- 外边框宽度为 $B_o$（在 CSS `box-sizing: border-box` 下，曲率位于边框最外缘）；
- 容器在角部区域的内衬边距为 $P$；
- 内矩形边界曲率半径为 $R_i$。

#### 同心公理（Axiom of Concentricity）
外圆弧与内圆弧在角部**处处等距平行**的充要条件是：**两圆弧在同一个四分之一象限内共享唯一的曲率中心（Center of Curvature Identity）**。

以左上角为例，设外圆弧中心为 $C_o = (x_0, y_0) = (R_o, R_o)$。  
内元素左上角顶点位于 $(P + B_o, P + B_o)$。  
内圆弧中心位于 $C_i = (P + B_o + R_i, P + B_o + R_i)$。  

令 $C_o \equiv C_i$，即：
$$R_o = P + B_o + R_i$$

由此导出工业同心圆角第一主方程：
$$\boxed{R_{inner} = \max(0, R_{outer} - P - B_o)}$$
$$\boxed{R_{outer} = R_{inner} + P + B_o}$$

> **工程简化**：Conex 样式体系中，边框基本由 1px 发丝线（`--hairline-width: 1px`）承担，在无抗锯齿亚像素干扰的视觉设计中，通常将 $B_o \approx 0$ 处理（或计入 $P$ 净间距）：
> $$R_i = \max(0, R_o - P)$$

### 4.2 退化边界、超距平直区与有效嵌套域

根据主方程，参数空间可严格划分为三个拓扑相区：

```
    R_inner
       ▲
       │                  /  同心平衡线 (Ri = Ro - P)
  Ro   │                 /
       │                / 
       │               /   【有效同心嵌套区】 (0 < P < Ro)
       │              /    内外圆弧共存，优雅平行
       │             /
       │            /
     0 ┼───────────*────────────────────────► P (Padding)
       │          Ro   【超距平直区】 (P >= Ro)
       │               外弧早已走完，内角彻底退化为直角 (Ri = 0)
```

1. **有效同心嵌套区（$0 < P < R_o$）**：  
   内圆角取值在 $(0, R_o)$ 之间，内外圆弧形成平滑的双轨过渡。
2. **临界退化点（$P = R_o$）**：  
   外圆弧跨度恰好等于内衬厚度。内圆弧收缩为一个点，$R_i = 0\text{px}$（尖锐直角）。
3. **超距平直区（$P > R_o$）**：  
   外圆角的弧线在距离外缘 $R_o$ 处已经完全过渡为直线。此时内元素的所有边界**完全坐落在外容器的水平/垂直直壁上**。从几何严谨性上讲，此时内元素**本应与外圆角完全解耦**。若强行赋予内元素圆角，其曲率中心将被推移到外侧，产生“内圆外平”的不协调感。

### 4.3 四大几何病态与视觉畸变机理

当 $\Delta = R_o - (R_i + P) \neq 0$ 时，系统会产生显著的视觉撕裂。

#### 1. 角部挤压 / 假同心膨胀（Corner Pinching, $\Delta < 0$, 即 $R_i > R_o - P$）
- **现象**：内圆角设置过大（例如外框 12px，内边距 8px，内元素本应为 4px，却强行用了 8px）。
- **几何表征**：在轴线方向，两层间距为 $P$；在 45° 倒角对角线方向，两圆弧顶点之间的最短距离收缩为：
  $$d_{45^\circ} = \sqrt{2} R_o - \sqrt{2} R_i - \sqrt{2} P \dots < P$$
- **视觉感受**：内元素在角部向外凸起膨胀，角部空间被压榨变薄，视觉上产生严重的压迫感与窒息感。

#### 2. 曲率倒挂 / 外平内圆（Curvature Inversion, $R_o \le R_i$ 且 $P > 0$）
- **现象**：外容器圆角居然小于或等于内元素圆角（例如外层 Card 12px，内衬 12px，内嵌按钮 12px 或 8px）。
- **几何表征**：外层已经是一个接近直角的钝拐弯，而内部元素却是一个硕大圆润的圆弧。
- **视觉感受**：内部元素仿佛要冲破外框刺穿出来，整体框架缺乏收敛与稳定锚定。

#### 3. 角部空洞 / 钝化断层（Corner Cavity, $\Delta > 0$, 即 $R_i < R_o - P$）
- **现象**：外容器圆角极大（如 20px），内衬极薄（4px），内元素圆角过小（4px，理论应为 16px）。
- **几何表征**：在 45° 对角线上，角部间距急剧扩大，形成一个不自然的空白气囊区。
- **视觉感受**：内元素仿佛一块硬铁生硬地嵌入在一个柔和的气垫中，角部显得空旷而脱节。

#### 4. 各向异性内衬椭圆撕裂（Anisotropic Padding Tearing, $P_x \neq P_y$）
- **现象**：常见于底部输入框 Composer（如 $P_y = 6\text{px}, P_x = 10\text{px}$）。
- **几何表征**：CSS 单一半经 `border-radius: R` 绘制的是正圆弧。若 $P_x \neq P_y$，内圆弧中心偏移量为 $(P_x + R_i, P_y + R_i)$，曲率中心偏离 45° 角平分线，外正圆弧与内正圆弧在不同角度上的法向间距不再恒定。
- **解法**：必须使角部局部内衬对称（$P_x = P_y$），或采用 CSS 椭圆圆角语法：
  `border-radius: (R_ix + P_x) / (R_iy + P_y)`。

---

### 4.4 核心定理一：奇偶校验破缺定理 (Parity Invariance Theorem)

这是 Conex 整个样式架构中最深层的数学死结。

#### 定理表述
> 在任意采用欧氏度量的嵌套矩形系统中，若所有间距 Token 均严格遵循偶数原则（$P \equiv 0 \pmod 2$），则**外圆角 $R_o$ 与内圆角 $R_i$ 必定拥有完全相同的奇偶性**：
> $$\text{parity}(R_o) \equiv \text{parity}(R_i) \pmod 2$$

#### 数学证明
由同心几何主方程：
$$R_o = R_i + P$$
取模 2 同余变换：
$$R_o \pmod 2 \equiv (R_i + P) \pmod 2$$
因为 Conex 间距体系 `--space-*` 均为偶数（2, 4, 6, 8, 10, 12, 16...）：
$$P \pmod 2 = 0$$
代入得：
$$R_o \pmod 2 \equiv R_i \pmod 2 \quad \blacksquare$$

#### 结论与冲突暴露
1. **7px 按钮的用户锁（U1）**：令 $R_i = 7\text{px}$，则 $R_i \pmod 2 = 1$（奇数）；
2. **推论**：任何包裹该 7px 按钮且内边距为偶数的外容器，其理论同心外圆角 $R_o$ **必然是奇数**：
   - 若 $P = 2\text{px}$，则 $R_o = 7 + 2 = \mathbf{9px}$（奇数！）；
   - 若 $P = 4\text{px}$，则 $R_o = 7 + 4 = \mathbf{11px}$（奇数！）；
   - 若 $P = 6\text{px}$，则 $R_o = 7 + 6 = \mathbf{13px}$（奇数！）；
   - 若 $P = 8\text{px}$，则 $R_o = 7 + 8 = \mathbf{15px}$（奇数！）；
3. **CI 门禁的死锁**：  
   `apps/crish-desktop/src/styles/motion-concentric-contract.test.ts:60-70` 明确声明了 `ODD_RADIUS_BASELINE = 0`，全站静态扫描拦截所有 `3px, 5px, 7px, 9px, 11px, 13px, 15px` 奇数圆角！
4. **残酷的现实**：  
   外容器为了通过门禁，只能写偶数（如 8px、12px、14px），从而必然产生 **1px 的几何奇偶撕裂（Parity Mismatch）**。

---

### 4.5 核心定理二：阶梯跨度完备性定理 (Scale Completeness Theorem)

#### 定理表述
> 设设计系统的基础圆角集合为 $\mathcal{R}$，基础间距集合为 $\mathcal{P}$。若要使系统中任意由 $(R_o \in \mathcal{R}, P \in \mathcal{P})$ 构成的嵌套容器在不借助外部 `calc()` 或裸写像素的前提下达成严格同心，则集合 $\mathcal{R}$ 必须对差值减法运算保持**代数闭包（Algebraic Closure）**：
> $$\forall R_o \in \mathcal{R}, \forall P \in \mathcal{P} \text{ 且 } P < R_o \implies (R_o - P) \in \mathcal{R}$$

#### 现存体系的断裂证明
- 当前 $\mathcal{R}_{SSOT} = \{4, 7, 8, 12, 20\}$；
- 当前 $\mathcal{P} = \{2, 4, 6, 8, 10, 12, 14, 16, 20\}$；
- 检验实例：
  - $R_o = 12\text{px} \in \mathcal{R}, P = 2\text{px} \in \mathcal{P} \implies R_i = 10\text{px} \notin \mathcal{R}$（缺失 10px！）；
  - $R_o = 12\text{px} \in \mathcal{R}, P = 6\text{px} \in \mathcal{P} \implies R_i = 6\text{px} \notin \mathcal{R}$（缺失 6px！）；
  - $R_o = 20\text{px} \in \mathcal{R}, P = 4\text{px} \in \mathcal{P} \implies R_i = 16\text{px} \notin \mathcal{R}$（缺失 16px！）；
  - $R_o = 20\text{px} \in \mathcal{R}, P = 6\text{px} \in \mathcal{P} \implies R_i = 14\text{px} \notin \mathcal{R}$（缺失 14px！）；
  - 若 Modal 诉求 $R_o = 24\text{px} \notin \mathcal{R}$，若内嵌卡片 $R_i = 12\text{px}$ 且 $P = 12\text{px}$，外部无处落脚！
- **结论**：**当前 5 档 SSOT 在代数上是极其不完备的**，系统必须扩充具备闭包能力的中间态阶梯。

---

## 五、 全仓典型场景同心数学代数审查

### 5.1 场景 1：Card / LeafBody 容器与内嵌元素的几何撕裂

在主界面分栏中，`.leafBody` 承担主要内容卡片矩形：
```css
/* apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:346 */
.leafBody {
  border-radius: var(--radius-l); /* 12px */
}
```
其内部承载了聊天流、工具卡片、以及拖拽浮层：

#### 案例 A：`ChatCard.module.css:300-313` 拖拽覆盖层
```css
.dropOverlay {
  inset: var(--space-3, 12px);
  border-radius: var(--radius-xl); /* 解析为 12px */
}
```
- **参数**：外层 LeafBody $R_o = 12\text{px}$；内缩边距 $P = 12\text{px}$；内嵌浮层 $R_i = 12\text{px}$；
- **同心计算**：
  $$R_{ideal} = \max(0, R_o - P) = 12 - 12 = \mathbf{0px}$$
- **现状误差**：
  $$\Delta = R_o - (R_i + P) = 12 - (12 + 12) = \mathbf{-12px}$$
- **视觉畸变**：极其严重的**曲率倒挂与外平内圆**！在距离边界 12px 的内部，浮层划出了一个 12px 的大圆角，而外层容器在该位置早就是完全笔直的直线！角部产生巨大的空隙与不协调感。

#### 案例 B：通用卡片内嵌按钮
- 外层 Card：$R_o = 12\text{px}$；
- 内边距：$P = 12\text{px}$（`--space-3`）；
- 内部按钮：引用 `--radius-btn`（7px）或 `--radius-md`（8px）；
- 同样完全跌入 $P \ge R_o$ 的超距平直区。

---

### 5.2 场景 2：Modal / Dialog 大弹窗坍塌至 12px 的历史溯源与视觉钝化

#### 历史溯源（Git Archeology）
通过 Git Blame 穿透 `apps/crish-desktop/src/styles/tokens.css`：
1. **Commit `35b301c7` (2026-09-11)**：  
   在重构聊天流时，首次出现了：
   ```css
   --radius-xl: 12px;
   --radius-2xl: 12px;
   --radius-3xl: 24px;
   ```
   历史提交者在此处随手将 `2xl` 与 `xl` 绑定到了同一字面量 `12px`，埋下了第一颗祸根。
2. **Commit `88d72ec9` (2026-10-11)**：  
   在推行“三档底色与 5 档 SSOT 定稿”战役时，为了消灭裸写像素，大刀阔斧推行统一引用：
   ```css
   --radius-xl: var(--radius-l);   /* 12px */
   --radius-2xl: var(--radius-l);  /* 12px */
   ```
   这一提交彻底焊死了 `--radius-2xl`，使全仓再无合法的 16px/24px 弹层圆角。

#### 现存破坏性影响
在 [Dialog.module.css:47](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L47)：
```css
.dialog {
  border-radius: var(--radius-2xl); /* 12px! */
}
.dialog2xl {
  --dialog-width: 1040px; /* 宽度高达 1040px 的巨型模态窗口！ */
}
.dialogHeader {
  padding: var(--space-4) var(--space-4) var(--space-2); /* P = 16px */
}
.dialogClose {
  border-radius: var(--radius-sm); /* 4px */
}
```
在 [ProjectManageModal.module.css:4](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L4)：
```css
.modal {
  border-radius: var(--radius-2xl, 24px); /* 开发者显式声明了 24px 兜底！ */
}
```
- **开发者意图**：开发者写下 `var(--radius-2xl, 24px)`，明确证明其**视觉心理预期是 24px 大圆角**；
- **真实渲染**：因为 `--radius-2xl` 在 `tokens.css` 中已被定义为 12px，fallback `24px` 根本不会触发！一个 1040px 的宏大窗口，被套上了一个局促僵硬的 12px 卡片圆角，极其小气；
- **几何计算**：$R_o = 12\text{px}$，Header 内边距 $P = 16\text{px}$。由于 $P > R_o$，右上角关闭按钮完全位于平直区，其与弹窗外框圆角毫无几何联动。

---

### 5.3 场景 3：避难式 calc() 的现场自证（Select / SetupHint / Popover）

正是因为当前 Token 阶梯无法自洽，全仓最有追求的组件纷纷采用 `calc()` 进行“游击式避难”：

#### 证据 1：`ui/Select/SelectContent.module.css:40-59`
```css
/* 尺寸档位（同心曲率：外圆角 = 内圆角 + 内边距） */
.contentSm {
  border-radius: calc(var(--radius-m) + 4px); /* 8 + 4 = 12px */
  padding: 4px;
}
.contentMd {
  border-radius: calc(var(--radius-m) + 6px); /* 8 + 6 = 14px! */
  padding: 6px;
}
.contentLg {
  border-radius: calc(var(--radius-m) + 8px); /* 8 + 8 = 16px! */
  padding: 8px;
}
.item {
  border-radius: var(--radius-m); /* 8px */
}
```
> **现场分析**：  
> 组件作者为了满足同心公理，计算出了 **14px** 与 **16px** 两个外圆角。但因为 `tokens.css` 根本没有 14px 和 16px，只能写 `calc(var(--radius-m) + 6px)`！这是设计系统缺乏中间 Token 的最强铁证。

#### 证据 2：`SetupHintBanner.module.css:6-8`
```css
--soft-hint-py: 10px;
--soft-hint-btn-radius: var(--radius-md, 8px);
/* 同心几何标尺：外圆角 = 内圆角 (8px) + 等距内边距 (10px) = 18px，内外圆弧处处平行同心 */
--soft-hint-radius: calc(var(--soft-hint-btn-radius) + var(--soft-hint-py));
```
> **现场分析**：  
> 此处外圆角算出了 **18px**。为了达到内外圆弧处处平行的完美工业质感，作者只能自己派生变量。

#### 证据 3：`ChatComposer.module.css:1035-1038`
```css
/* 同心几何标尺：外圆角 = 内圆角 + 内边距 (Ro = Ri + P = 6 + 12 = 18px) */
--ann-pad: 12px;
--ann-radius-inner: 6px;
--ann-radius-outer: calc(var(--ann-radius-inner) + var(--ann-pad)); /* 18px */
```
> **现场分析**：  
> 选区批注卡片同样需要 **18px** 外圆角与 **6px** 内圆角，双双脱离了 5 档 SSOT。

---

### 5.4 场景 4：SegmentedControl 与 Tabs 的滑块与 5px 亚像素危机

查看 [SegmentedControl.module.css:59-69](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L59-L69) 与 [Tabs.module.css:79-88](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L79-L88)：

```css
/* SegmentedControl sm 默认档 */
.containerSm {
  --seg-h: 28px;
  --seg-pad: 2px;
  --seg-outer-radius: var(--button-radius); /* 7px */
  --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 5px! */
}
```

```css
/* Tabs sizeSm 档位 */
.sizeSm {
  --tab-height: 28px;
  --tab-pad: 2px;
  --tab-outer-radius: var(--button-radius); /* 7px */
  --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad)); /* 5px! (注释误写为 6px) */
}
```

#### 危机剖析
1. 外壳绑定了 7px（`--button-radius`）；
2. 内衬边距为 2px（`--seg-pad`）；
3. 滑块圆角求值结果为 **5px**；
4. **致命隐患**：  
   - 5px 是奇数圆角；在 Windows 100%、125%、150% 等非整数缩放屏幕下，5px 圆角在抗锯齿光栅化时会导致左右对称轴发生亚像素偏移（Subpixel Blurring），产生发虚的模糊边缘；
   - 这也是为什么代码注释中自欺欺人地写着 `/* 6px 完美同心 */`，而实际运行时却是 5px 的根本原因。

---

## 六、 标准化同心圆角阶梯矩阵表

为了结束无序派生，现从工业同心几何公理出发，建立全系统标准化的**同心圆角阶梯矩阵表**。

### 6.1 全域容器 × 内边距 × 子元素标准阶梯矩阵

本表为 Conex 系统的**同心代数闭包矩阵**。横轴为内衬边距（Padding），纵轴为外容器圆角（$R_o$），交叉单元格为内部元素必须采用的标准同心圆角（$R_i = R_o - P$）：

| 容器语义分类 | 推荐外圆角 $R_o$ | $P=2\text{px}$ (`0_5`) | $P=4\text{px}$ (`1`) | $P=6\text{px}$ (`1_5`) | $P=8\text{px}$ (`2`) | $P=10\text{px}$ (`2_5`) | $P=12\text{px}$ (`3`) | $P=16\text{px}$ (`4`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Modal / Dialog (大)** | **24px** | 22px | 20px | 18px | 16px | 14px | **12px** (`--radius-l`) | **8px** (`--radius-m`) |
| **Drawer / Sheet (中)** | **20px** | 18px | 16px | 14px | **12px** (`--radius-l`) | 10px | **8px** (`--radius-m`) | **4px** (`--radius-s`) |
| **Floating Banner / Hint** | **18px** | 16px | 14px | 12px | 10px | **8px** (`--radius-m`) | 6px | 2px |
| **Card / Panel (标准)** | **16px** | 14px | **12px** (`--radius-l`) | 10px | **8px** (`--radius-m`) | 6px | **4px** (`--radius-s`) | 0 (直角退化) |
| **Popover / Select (展开)**| **14px** | **12px** (`--radius-l`) | 10px | **8px** (`--radius-m`) | 6px | 4px | 2px | 0 (直角退化) |
| **Subcard / Leaf (小卡)** | **12px** | 10px | **8px** (`--radius-m`) | 6px | **4px** (`--radius-s`) | 2px | 0 (直角退化) | 0 (直角退化) |
| **Control Shell / Bar** | **10px** | **8px** (`--radius-m`) | 6px | 4px | 2px | 0 (直角退化) | 0 (直角退化) | 0 (直角退化) |
| **Segmented / Tabs (外壳)**| **8px** | 6px | **4px** (`--radius-s`) | 2px | 0 (直角退化) | 0 (直角退化) | 0 (直角退化) | 0 (直角退化) |
| **Badge / Button (子元素)**| **4px** | 2px | 0 (直角退化) | 0 (直角退化) | 0 (直角退化) | 0 (直角退化) | 0 (直角退化) | 0 (直角退化) |

> **关键规律注记**：  
> 观察加粗的合法 Token 项可见：  
> 1. 当外层为 **24px** 时，在 12px padding 下完美嵌套 **12px** 卡片，在 16px padding 下完美嵌套 **8px** 卡片！  
> 2. 当外层为 **16px** 时，在 4px padding 下完美嵌套 **12px** 卡片，在 8px padding 下完美嵌套 **8px** 元素！  
> 3. **24px 与 16px 是打通全仓同心圆角的大一统枢纽键（Pivot Keys）**，但恰恰是当前 `tokens.css` 中被抹除的两档！

---

### 6.2 各级组件装配同心几何速查表

根据上述模型，为系统常见组件确立推荐装配契约：

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 大模态弹窗 (Modal / Dialog / FirstRunWizard)                        │
│    - 推荐外框圆角: 24px (原 --radius-2xl 真值)                         │
│    - 内部 Header/Body Padding: 16px (--space-4)                        │
│    - 头部关闭按钮 / 子卡片推荐圆角: 8px (--radius-m)                   │
│    - 同心验证: 24px - 16px = 8px (完全同心，Δ = 0)                     │
├────────────────────────────────────────────────────────────────────────┤
│ 2. 下拉菜单与浮层 (SelectContent / Popover / Cascader)                 │
│    - 推荐外框圆角: 14px (md档) / 12px (sm档)                           │
│    - 内部 Padding: 6px (--space-1_5) / 4px (--space-1)                 │
│    - 内部选项 Item 圆角: 8px (--radius-m)                              │
│    - 同心验证: 14px - 6px = 8px; 12px - 4px = 8px (完全同心，Δ = 0)    │
├────────────────────────────────────────────────────────────────────────┤
│ 3. 主界面内容矩形 (LeafBody & Content Cards)                           │
│    - 推荐外框圆角: 16px (升级自 12px)                                  │
│    - 内部留白 Padding: 8px (--space-2)                                 │
│    - 内部工具卡片 / 消息组圆角: 8px (--radius-m)                       │
│    - 同心验证: 16px - 8px = 8px (完全同心，Δ = 0)                      │
├────────────────────────────────────────────────────────────────────────┤
│ 4. 底部输入框 (ChatComposer)                                           │
│    - 外框圆角: 单行 20px / 多行 24px                                   │
│    - 附件卡片 (AttachCard): 12px (--radius-l)                          │
│    - 内衬 Padding: 垂直 8px (--space-2)                                │
│    - 同心验证: 20px - 8px = 12px (垂直同心，Δ = 0)                     │
├────────────────────────────────────────────────────────────────────────┤
│ 5. 分段控件与滑块 (SegmentedControl / Tabs)                            │
│    - 外框圆角: 8px (建议解绑 7px，归位 8px)                            │
│    - 内部 Padding: 2px (--space-0_5)                                   │
│    - 内部滑块 Indicator 圆角: 6px (完美偶数同心)                       │
│    - 同心验证: 8px - 2px = 6px (告别 5px 模糊，Δ = 0)                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 七、 未来演进建议与设计系统修复路线

基于上述分析，本报告提出分阶段的架构演进方案，供后续战役决策参考：

### 第一阶段：解冻 `--radius-2xl`，补齐关键枢纽 Token（零破坏渐进修复）
1. **解冻 24px 与 16px**：  
   在 `tokens.css` 中将 `--radius-2xl` 恢复为真正的 **24px**（支持大弹窗）；新增 `--radius-xl: 16px`（支持大卡片与抽屉），将原本的 12px 保留在 `--radius-l`。
2. **规范别名梯队**：
   ```css
   --radius-xs:  var(--radius-s);       /* 4px */
   --radius-sm:  var(--radius-s);       /* 4px */
   --radius-md:  var(--radius-m);       /* 8px */
   --radius-lg:  var(--radius-l);       /* 12px */
   --radius-xl:  16px;                  /* 16px (全新恢复) */
   --radius-2xl: 24px;                  /* 24px (解冻回归) */
   --radius-3xl: var(--radius-input);  /* 20px / 28px */
   ```
3. **收益**：全站引用 `var(--radius-2xl)` 的 Dialog、ProjectManageModal 立刻恢复现代桌面应用应有的 24px 柔和大圆角，Header 内边距 16px 时内部 8px 按钮实现完美同心。

### 第二阶段：引入 6px 与 14px 作为中间派生 SSOT
在正典中补充中间同心过渡层：
```css
--radius-xs:    2px;   /* 恢复微刻度 */
--radius-s:     4px;   /* 基础小 */
--radius-s_alt: 6px;   /* 专供 8px 外框 + 2px 内衬滑块 */
--radius-m:     8px;   /* 基础中 */
--radius-l_alt: 10px;  /* 专供 12px 外框 + 2px 内衬 */
--radius-l:     12px;  /* 基础大 */
--radius-xl_alt:14px;  /* 专供 SelectContent 展开态 */
--radius-xl:    16px;  /* 基础特大 */
--radius-2xl:   24px;  /* 基础超大/弹窗 */
```
全面清退 `SelectContent`、`SetupHintBanner` 中的临时 `calc()`，收拢至正规 Token。

### 第三阶段：7px 按钮（用户锁 U1）与分段控件的几何解耦
- **分段控件（SegmentedControl / Tabs）脱离按钮锁**：  
  分段控件外壳属于容器性质，不应被强制绑定 `--radius-btn`（7px）。应显式使用 `8px` 外壳搭配 `2px` 内衬与 `6px` 滑块，彻底消除 5px 奇数圆角与亚像素模糊；
- **按钮独立性**：  
  独立文字/图标按钮继续保持 7px 用户锁。当按钮置于卡片角部时，外框尽量保证 $P \ge 12\text{px}$，使 7px 按钮完全处于超距平直区，避免与外圆角产生 $\pm 1\text{px}$ 的肉眼可见撕裂。

### 第四阶段：建立自动化同心几何与奇偶校验门禁
在 `motion-concentric-contract.test.ts` 中升级自动化校验规则：
- **同心差值容差断言**：容器内直接子元素的圆角声明，其实际求值偏差不得超过 $1\text{px}$：$|\Delta| = |R_o - (R_i + P)| \le 1\text{px}$；
- **禁止外平内圆**：严禁在具有非零 padding 的容器内出现 $R_i \ge R_o$ 的倒挂结构；
- **Large 密度档位补偿**：在 Large 模式下允许圆角按比例动态响应或保持内边距同步阶跃，消除密度放大时的角部挤压。

---
*报告完毕。本报告为纯理论推导、数据统计与现状审查文档，未对仓库现有代码执行任何写入或提交。*
