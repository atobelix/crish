# 数理公式与学术论文示例集（高等数学、理论物理与学术科研）

**文档标识**：`SAMPLE-MATH-ACADEMIC-02`  
**适用系统**：Conex / Crish Markdown 混合渲染编辑器（Live Preview & Strict Grid-Line Invariance）  
**关联规范**：`docs/markdown-editor/00-通用混合渲染与几何守恒测量系统终极总方案.md`  
**核心目标**：构建真实、高价值、具有学术生产力与排版极限压力测试能力的数理学术论文范例库，彻底终结简陋玩具示例（如仅有 $x^2+y^2=r^2$），提供覆盖行内公式基线对齐、独立大块公式推导、矩阵群、多行方程对齐、上下标对比、多段学术脚注与复杂容器嵌套的全维度标准参照物。

---

## 目录

- [一、数理排版引擎设计原理与排版边界规范](#一数理排版引擎设计原理与排版边界规范)
  - [1.1 核心排版痛点与几何挑战](#11-核心排版痛点与几何挑战)
  - [1.2 数学排版技术规格与 AST 节点矩阵](#12-数学排版技术规格与-ast-节点矩阵)
  - [1.3 KaTeX 渲染机制与 LRU 缓存特征](#13-katex-渲染机制与-lru-缓存特征)
- [二、第一篇章：理论物理学术范例——《量子场论与弯曲时空引力几何学》](#二第一篇章理论物理学术范例量子场论与弯曲时空引力几何学)
  - [2.1 量子态空间、狄拉克符号与本征方程](#21-量子态空间狄拉克符号与本征方程)
  - [2.2 广义相对论爱因斯坦引力场方程严密推导](#22-广义相对论爱因斯坦引力场方程严密推导)
  - [2.3 密集行内公式、中文标点避头尾与基线贴合测试](#23-密集行内公式中文标点避头尾与基线贴合测试)
- [三、第二篇章：流体力学偏微分方程范例——《不可压缩纳维-斯托克斯方程与涡动力学》](#三第二篇章流体力学偏微分方程范例不可压缩纳维-斯托克斯方程与涡动力学)
  - [3.1 质量与动量守恒方程组](#31-质量与动量守恒方程组)
  - [3.2 涡量输运方程与耗散率多行对齐展开](#32-涡量输运方程与耗散率多行对齐展开)
  - [3.3 引用块（Blockquote）内部的大公式排版压测](#33-引用块blockquote内部的大公式排版压测)
- [四、第三篇章：应用数学与频域分析范例——《连续小波变换与多尺度时频频谱分析》](#四第三篇章应用数学与频域分析范例连续小波变换与多尺度时频频谱分析)
  - [4.1 傅里叶积分变换与帕塞瓦尔能量守恒定理](#41-傅里叶积分变换与帕塞瓦尔能量守恒定理)
  - [4.2 连续小波变换（CWT）与母小波容许性准则](#42-连续小波变换cwt与母小波容许性准则)
  - [4.3 有序列表与嵌套任务列表内的缩进大公式测试](#43-有序列表与嵌套任务列表内的缩进大公式测试)
- [五、第四篇章：深度学习与计算科学范例——《Transformer 多头注意力矩阵微积分与反向传播》](#五第四篇章深度学习与计算科学范例transformer-多头注意力矩阵微积分与反向传播)
  - [5.1 缩放点积注意力（Scaled Dot-Product Attention）张量表达](#51-缩放点积注意力scaled-dot-product-attention张量表达)
  - [5.2 雅可比矩阵求导与反向传播链式法则推导](#52-雅可比矩阵求导与反向传播链式法则推导)
  - [5.3 超大分块矩阵与分段函数排版压测](#53-超大分块矩阵与分段函数排版压测)
- [六、第五篇章：生化热力学与语法对照评测——《氧化还原动力学与语法对抗》](#六第五篇章生化热力学与语法对照评测氧化还原动力学与语法对抗)
  - [6.1 复杂生物化学反应方程式与自由能变计算](#61-复杂生物化学反应方程式与自由能变计算)
  - [6.2 Pandoc 扩展上下标 vs LaTeX 原生数学上下标实测对抗](#62-pandoc-扩展上下标-vs-latex-原生数学上下标实测对抗)
  - [6.3 渲染引擎视觉一致性对比分析表](#63-渲染引擎视觉一致性对比分析表)
- [七、第六篇章：学术规范体系——多段落学术脚注与 BibTeX 参考文献](#七第六篇章学术规范体系多段落学术脚注与-bibtex-参考文献)
  - [7.1 论文级引用标记与多段落扩展脚注测试](#71-论文级引用标记与多段落扩展脚注测试)
  - [7.2 经典学术文献库规范条目（含 DOI 与 arXiv 链接）](#72-经典学术文献库规范条目含-doi-与-arxiv-链接)
- [八、第七篇章：极端排版与多模态容器压测套件（Extreme Layout Suite）](#八第七篇章极端排版与多模态容器压测套件extreme-layout-suite)
  - [8.1 极端嵌套一：双层引用块内嵌任务列表与多行对齐矩阵](#81-极端嵌套一双层引用块内嵌任务列表与多行对齐矩阵)
  - [8.2 极端嵌套二：复杂数据表格内的行内公式与块级公式](#82-极端嵌套二复杂数据表格内的行内公式与块级公式)
  - [8.3 极端超长长公式与横向滚动容错规范](#83-极端超长长公式与横向滚动容错规范)
- [九、第八篇章：自动化工程验收断言与现场探针测试指南](#九第八篇章自动化工程验收断言与现场探针测试指南)
  - [9.1 AST 节点解析完整性断言（Parser Contract）](#91-ast-节点解析完整性断言parser-contract)
  - [9.2 DOM 树结构与 CSS 类名断言（DOM Tree Contract）](#92-dom-树结构与-css-类名断言dom-tree-contract)
  - [9.3 几何测量与行高稳定性断言（Geometric Invariance Assertion）](#93-几何测量与行高稳定性断言geometric-invariance-assertion)

---

## 一、数理排版引擎设计原理与排版边界规范

### 1.1 核心排版痛点与几何挑战

在以所见即所得（Live Preview）和混合渲染为核心特性的现代化编辑器中，数学公式（Math Formula）与学术论文排版处于最深水区。传统富文本或简易 Markdown 预览器在此场景下频频崩溃或发生视觉崩坏，主要根源包括以下四项硬性几何冲突：

1. **行内基线塌陷与错位（Baseline Misalignment）**：
   行内数学符号如分式 $\frac{a}{b}$、积分 $\int_0^1$ 或带上下标的希腊字母 $\psi_n^{(k)}$，其字体包围盒（Bounding Box）天然超出普通文本基线高度。若 CSS 仅简单设置 `vertical-align: middle`，将导致公式与前后中文、拉丁字符基线脱节，出现严重的“跳行”或垂直居中失衡；
2. **行盒包含块（IFC）垂直高度突变（Vertical Height Thrashing）**：
   当用户在正文某一行输入 `$E=mc^2$` 时，若公式节点撑高了当前行（例如从标准的 `28px` 撑开至 `36px`），会导致光标坐标测量错位、下行文字瞬间下坠、滚动条抖动。混合渲染引擎必须实现 IFC 隔离（Zero-Vertical-Overflow）；
3. **复杂多行与宽矩阵的横向溢出崩溃（Horizontal Overflow）**：
   高维张量矩阵（如 $4 \times 4$ 施瓦西度规矩阵）或多等号连推导公式，宽度极易超出容器视口。若缺乏自适应横向滚动（`overflow-x: auto`）与等宽基准保持，会导致整个编辑器容器被强行撑爆横向滚动条；
4. **流式渲染下的闭合态震荡（Streaming Unclosed Oscillation）**：
   在 AI 流式输出或用户实时键入公式过程中，未闭合的 `$$` 或 `$` 若直接交给 KaTeX 尝试编译，将引发大量异常（`throwOnError: true` 抛错崩溃，或 `throwOnError: false` 产生大面积高亮红色错误字串）。现代引擎必须在未闭合阶段维持软渲染（Soft Render），闭合后平滑激活 KaTeX。

### 1.2 数学排版技术规格与 AST 节点矩阵

本示例集完整覆盖编辑器支持的全部数学与学术 AST 节点规范：

| 语法形态 | Markdown 源码模式 | AST Node Type | DOM 渲染载体 / CSS 类名 | 几何边界与换行规则 |
| :--- | :--- | :--- | :--- | :--- |
| **行内公式** | `$formula$` | `math` (`raw.startsWith('$')`) | `<span class="token-math-wrapper"><span class="math-preview katex">...</span></span>` | 内联 IFC 盒模型，禁止自身换行，必须紧贴文本基线 |
| **行内展示公式** | `$$formula$$`（单行） | `math` (`raw.startsWith('$$')`) | `<span class="token-math-wrapper display-mode">...</span>` | 行内独立展示，`displayMode: true` |
| **块级围栏起始** | 独立行 `$$` | `math_fence_start` | `<div class="line-block line-code math-fence-start">...</div>` | 独立块行，高度严格受控 |
| **块级公式内容** | 围栏内部公式文本 | `math_block` | `<div class="line-math-block"><div class="math-block-rendered katex-display">...</div></div>` | 块级独立展示，居中对齐，支持横向平滑滚动 |
| **块级围栏闭合** | 独立行 `$$` | `math_fence_end` | `<div class="line-block line-code math-fence-end">...</div>` | 独立块行，标记公式闭合 |
| **下标（Pandoc）** | `H~2~O` | `sub` | `<span class="style-sub">...</span>` | 基线降低 `0.25em`，字号 `0.75em`，零高度溢出 |
| **上标（Pandoc）** | `2^10^` | `sup` | `<span class="style-sup">...</span>` | 基线抬升 `0.4em`，字号 `0.75em`，零高度溢出 |
| **学术脚注引用** | `[^cite]` | `footnote` | `<span class="style-footnote">...</span>` | 上标链接样式，支持双向平滑跳转 |
| **学术脚注定义** | `[^cite]: 多段正文` | `footnote_def` | `<div class="footnote-item">...</div>` | 4 空格支持多段落、代码与公式内嵌 |

### 1.3 KaTeX 渲染机制与 LRU 缓存特征

1. **防抖与缓存机制（LRU Cache Capacity: 500）**：
   所有经过 `renderMathToHtml(formula, displayMode)` 调用的公式，均以 `(displayMode ? 'block:' : 'inline:') + formula` 为键存入 LRU 缓存。相同的公式在重绘或光标经过时直接 $O(1)$ 命中返回 HTML，避免重复调用高开销的 `katex.renderToString`。
2. **容错兜底规范（Graceful Fallback）**：
   KaTeX 参数硬性锁定为 `{ throwOnError: false, displayMode }`。对于尚未键入完成的非法语法（如孤立的 `\frac{a}`），KaTeX 自动保留源码并以警告色提示，绝对禁止中断 UI 线程或抛出未捕获异常。

---

## 二、第一篇章：理论物理学术范例——《量子场论与弯曲时空引力几何学》

### 2.1 量子态空间、狄拉克符号与本征方程

在非相对论量子力学与量子场论公理化表述中，物理系统的微观量子态由复可分希尔伯特空间 $\mathcal{H}$ 中的单位态矢量 $|\psi\rangle$ 完全刻画。任意物理可观测量（Observable）均对应于希尔伯特空间上的自伴算符（Self-adjoint Operator）$\hat{A} = \hat{A}^\dagger$。

系统处于归一化纯态 $|\psi\rangle$ 时，观测量 $\hat{A}$ 的量子统计期望值定义为内积形式：

$$
\langle A \rangle = \langle \psi | \hat{A} | \psi \rangle = \int_{\Omega} \psi^*(\mathbf{x}) \left[ \hat{A} \psi(\mathbf{x}) \right] \mathrm{d}^3\mathbf{x}
$$

系统的态矢量时间演化由含时薛定谔方程（Time-dependent Schrödinger Equation）严格约束：

$$
i\hbar \frac{\partial}{\partial t} |\Psi(t)\rangle = \hat{\mathcal{H}} |\Psi(t)\rangle
$$

其中 $\hbar \approx 1.054571817 \times 10^{-34} \ \mathrm{J\cdot s}$ 表示约化普朗克常数，$\hat{\mathcal{H}}$ 为系统的哈密顿算符（Hamiltonian Operator）。若哈密顿算符不显含时间，通过变量分离法 $|\Psi(t)\rangle = |\psi\rangle e^{-iEt/\hbar}$，方程退化为能量定态本征方程：

$$
\hat{\mathcal{H}} |\psi_n\rangle = E_n |\psi_n\rangle, \quad n \in \mathbb{N}
$$

空间位置表象算符 $\hat{\mathbf{x}}$ 与动量算符 $\hat{\mathbf{p}} = -i\hbar\nabla$ 满足量子力学基本对易子关系（Canonical Commutation Relation）[^dirac1930]：

$$
\left[ \hat{x}_j, \hat{p}_k \right] = \hat{x}_j \hat{p}_k - \hat{p}_k \hat{x}_j = i\hbar \delta_{jk} \mathbb{I}_{d \times d}
$$

由上述代数对易关系可直接导出海森堡不确定性原理（Heisenberg Uncertainty Principle）：

$$
\sigma_{x_j} \sigma_{p_k} \ge \frac{1}{2} \left| \langle [ \hat{x}_j, \hat{p}_k ] \rangle \right| = \frac{\hbar}{2}\delta_{jk}
$$

为了证明量子力学全概率守恒，定义粒子在空间中的概率密度 $\rho(\mathbf{x}, t) = |\psi(\mathbf{x}, t)|^2$ 及对应的概率流密度矢量（Probability Current Density）$\mathbf{j}(\mathbf{x}, t)$：

$$
\mathbf{j}(\mathbf{x}, t) = \frac{\hbar}{2mi} \left( \psi^* \nabla\psi - \psi \nabla\psi^* \right) = \frac{\hbar}{m} \mathrm{Im} \left( \psi^* \nabla\psi \right)
$$

概率密度与概率流满足局域连续性方程：

$$
\frac{\partial \rho}{\partial t} + \nabla \cdot \mathbf{j} = 0
$$

对其在全空间 $\mathbb{R}^3$ 进行高斯散度定理积分，若波函数在无穷远处平方可积且衰减至零，则全空间总概率严格恒定守恒：

$$
\frac{\mathrm{d}}{\mathrm{d}t} \int_{\mathbb{R}^3} \rho(\mathbf{x}, t) \mathrm{d}^3\mathbf{x} = - \oint_{\partial \mathbb{R}^3} \mathbf{j} \cdot \mathrm{d}\mathbf{S} = 0 \implies \int_{\mathbb{R}^3} |\psi(\mathbf{x}, t)|^2 \mathrm{d}^3\mathbf{x} \equiv 1
$$

---

### 2.2 广义相对论爱因斯坦引力场方程严密推导

在黎曼微分几何流形 $(\mathcal{M}, g_{\mu\nu})$ 上，物质诱导的时空弯曲遵循著名的爱因斯坦引力场方程（Einstein Field Equations）[^einstein1915]：

$$
G_{\mu\nu} + \Lambda g_{\mu\nu} = \frac{8\pi G}{c^4} T_{\mu\nu}
$$

其中 $G_{\mu\nu} \equiv R_{\mu\nu} - \frac{1}{2}R g_{\mu\nu}$ 为无发散爱因斯坦张量，$\Lambda$ 为宇宙学常数，$G \approx 6.67430 \times 10^{-11} \ \mathrm{m^3\cdot kg^{-1}\cdot s^{-2}}$ 为引力常数，$c \approx 2.99792458 \times 10^8 \ \mathrm{m/s}$ 为真空中光速，$T_{\mu\nu}$ 为四维能量-动量张量。

无挠对称仿射联络（克里斯托费尔符号，Christoffel Symbols）由度规张量 $g_{\mu\nu}$ 及其一阶偏导数唯一确定：

$$
\Gamma^{\lambda}_{\mu\nu} = \frac{1}{2} g^{\lambda\sigma} \left( \frac{\partial g_{\nu\sigma}}{\partial x^\mu} + \frac{\partial g_{\mu\sigma}}{\partial x^\nu} - \frac{\partial g_{\mu\nu}}{\partial x^\sigma} \right)
$$

黎曼曲率张量（Riemann Curvature Tensor）定义为联络的非对易微分算符：

$$
R^{\rho}_{\ \sigma\mu\nu} = \partial_\mu \Gamma^\rho_{\nu\sigma} - \partial_\nu \Gamma^\rho_{\mu\sigma} + \Gamma^\rho_{\mu\lambda}\Gamma^\lambda_{\nu\sigma} - \Gamma^\rho_{\nu\lambda}\Gamma^\lambda_{\mu\sigma}
$$

对其指标进行张量收缩，得到里奇曲率张量（Ricci Tensor）与里奇曲率标量（Ricci Scalar）：

$$
R_{\mu\nu} = R^\lambda_{\ \mu\lambda\nu}, \qquad R = g^{\mu\nu} R_{\mu\nu}
$$

在静态球对称各向同性真空解（$\Lambda = 0, T_{\mu\nu} = 0$）背景下，史瓦西度规（Schwarzschild Metric）在球坐标系 $(t, r, \theta, \phi)$ 下写为独立线元 $ds^2$：

$$
\mathrm{d}s^2 = -\left(1 - \frac{2GM}{c^2 r}\right) c^2 \mathrm{d}t^2 + \left(1 - \frac{2GM}{c^2 r}\right)^{-1} \mathrm{d}r^2 + r^2 \mathrm{d}\theta^2 + r^2 \sin^2\theta \, \mathrm{d}\phi^2
$$

当引力场极强使得 $r = r_s \equiv \frac{2GM}{c^2}$ 时，度规张量出现坐标奇点，该半径即为史瓦西事件视界半径（Event Horizon）。将该线元写成标准四阶协变度规张量矩阵形式：

$$
g_{\mu\nu}(r, \theta) = \begin{pmatrix}
-\left(1 - \dfrac{r_s}{r}\right) & 0 & 0 & 0 \\
0 & \left(1 - \dfrac{r_s}{r}\right)^{-1} & 0 & 0 \\
0 & 0 & r^2 & 0 \\
0 & 0 & 0 & r^2 \sin^2\theta
\end{pmatrix}
$$

质点在弯曲时空中的测地线运动方程（Geodesic Equation）满足变分作用量极值条件 $\delta \int \mathrm{d}\tau = 0$：

$$
\frac{\mathrm{d}^2 x^\mu}{\mathrm{d}\tau^2} + \Gamma^\mu_{\alpha\beta} \frac{\mathrm{d}x^\alpha}{\mathrm{d}\tau} \frac{\mathrm{d}x^\beta}{\mathrm{d}\tau} = 0
$$

---

### 2.3 密集行内公式、中文标点避头尾与基线贴合测试

本小节专门用于测试高密度行内数学公式与中文学术长句在排版时的渲染稳定性：

设粒子初态位于高斯波包 $\psi(x, 0) = (\pi \sigma^2)^{-1/4} \exp\left( -\frac{x^2}{2\sigma^2} + i k_0 x \right)$，其中心位置期望值 $\langle \hat{x} \rangle = 0$、初速度 $v_0 = \hbar k_0 / m$；在自由粒子色散演化下，经过时间 $t$ 后的波包方差扩展为 $\sigma(t) = \sigma \sqrt{1 + \left( \frac{\hbar t}{m \sigma^2} \right)^2}$。由坐标不确定度 $\Delta x(t) = \sigma(t)/\sqrt{2}$ 与动量不确定度 $\Delta p = \hbar/(\sqrt{2}\sigma)$ 共同决定 Heisenberg 乘积 $\Delta x(t) \cdot \Delta p = \frac{\hbar}{2} \sqrt{1 + \frac{\hbar^2 t^2}{m^2 \sigma^4}} \ge \frac{\hbar}{2}$，其物理基线贴合表现必须保证：无论中文逗号“，”、中文句号“。”、全角分号“；”还是紧邻括号“（即 $t \to \infty$ 时渐近于光锥）”，均不产生断行错位；对于含有分式 $\frac{\mathrm{d}E}{\mathrm{d}k} = \hbar v_g$、偏导数 $\frac{\partial^2 \phi}{\partial x^2}$ 以及根号 $\sqrt{1 - v^2/c^2}$ 的行内数学标记，渲染盒子的上下外延不得将当前行的行高撑大至破坏网格基线。

---

## 三、第二篇章：流体力学偏微分方程范例——《不可压缩纳维-斯托克斯方程与涡动力学》

### 3.1 质量与动量守恒方程组

经典不可压缩牛顿流体（Incompressible Newtonian Fluid）的流动规律由著名的纳维-斯托克斯方程（Navier-Stokes Equations）描述[^navier1822]。设流体速度矢量场为 $\mathbf{u}(\mathbf{x}, t) = (u, v, w)^T$，流体静压强为 $p(\mathbf{x}, t)$，流体动力粘度为 $\mu$，运动学粘度为 $\nu = \mu / \rho$，单位体积外力场为 $\mathbf{f}$。

质量连续性方程（质量守恒）与动量守恒微分方程表述如下：

$$
\begin{aligned}
\nabla \cdot \mathbf{u} &= 0 \\
\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u} \cdot \nabla)\mathbf{u} &= -\frac{1}{\rho}\nabla p + \nu \nabla^2 \mathbf{u} + \frac{1}{\rho}\mathbf{f}
\end{aligned}
$$

其中非线性对流加速度项 $(\mathbf{u} \cdot \nabla)\mathbf{u}$ 可以通过张量恒等式重写为涡量场与动力压强的叠加：

$$
(\mathbf{u} \cdot \nabla)\mathbf{u} = \frac{1}{2} \nabla \left( |\mathbf{u}|^2 \right) - \mathbf{u} \times (\nabla \times \mathbf{u}) = \nabla\left( \frac{|\mathbf{u}|^2}{2} \right) - \mathbf{u} \times \boldsymbol{\omega}
$$

定义涡量矢量场 $\boldsymbol{\omega} \equiv \nabla \times \mathbf{u}$。在笛卡尔坐标系下，牛顿粘性流体的柯西应力张量（Cauchy Stress Tensor）$\boldsymbol{\sigma} = -p\mathbb{I} + \boldsymbol{\tau}$，其偏应力张量分量与应变率张量 $S_{ij}$ 满足本构线性关系：

$$
\tau_{ij} = 2\mu S_{ij} = \mu \left( \frac{\partial u_i}{\partial x_j} + \frac{\partial u_j}{\partial x_i} \right), \quad i, j \in \{1, 2, 3\}
$$

将其写为对称应变率张量矩阵形式：

$$
\mathbf{S} = \frac{1}{2} \left[ \nabla\mathbf{u} + (\nabla\mathbf{u})^T \right] = \begin{pmatrix}
\dfrac{\partial u}{\partial x} & \dfrac{1}{2}\left(\dfrac{\partial u}{\partial y} + \dfrac{\partial v}{\partial x}\right) & \dfrac{1}{2}\left(\dfrac{\partial u}{\partial z} + \dfrac{\partial w}{\partial x}\right) \\[1.2em]
\dfrac{1}{2}\left(\dfrac{\partial v}{\partial x} + \dfrac{\partial u}{\partial y}\right) & \dfrac{\partial v}{\partial y} & \dfrac{1}{2}\left(\dfrac{\partial v}{\partial z} + \dfrac{\partial w}{\partial y}\right) \\[1.2em]
\dfrac{1}{2}\left(\dfrac{\partial w}{\partial x} + \dfrac{\partial u}{\partial z}\right) & \dfrac{1}{2}\left(\dfrac{\partial w}{\partial y} + \dfrac{\partial v}{\partial z}\right) & \dfrac{\partial w}{\partial z}
\end{pmatrix}
$$

---

### 3.2 涡量输运方程与耗散率多行对齐展开

对动量方程两端取旋度 $\nabla \times$，利用矢量恒等式 $\nabla \times \nabla p \equiv \mathbf{0}$ 与 $\nabla \times \nabla^2 \mathbf{u} = \nabla^2 \boldsymbol{\omega}$，可严格推导出三维不可压缩流场的涡量输运方程（Vorticity Transport Equation）：

$$
\begin{aligned}
\frac{\mathrm{D}\boldsymbol{\omega}}{\mathrm{D}t} &= \frac{\partial \boldsymbol{\omega}}{\partial t} + (\mathbf{u} \cdot \nabla)\boldsymbol{\omega} \\
&= (\boldsymbol{\omega} \cdot \nabla)\mathbf{u} + \nu \nabla^2 \boldsymbol{\omega} + \frac{1}{\rho^2}(\nabla\rho \times \nabla p) + \frac{1}{\rho}(\nabla \times \mathbf{f})
\end{aligned}
$$

对于常密度均质流体且外力为保守场（如重力场 $\mathbf{f} = -\rho g \mathbf{e}_z \implies \nabla \times \mathbf{f} = \mathbf{0}$），正压斜压扭矩项 $\nabla\rho \times \nabla p$ 恒为零。若在二维平面流动中（$w = 0, \frac{\partial}{\partial z} = 0$），涡伸展拉伸项 $(\boldsymbol{\omega} \cdot \nabla)\mathbf{u} \equiv \mathbf{0}$ 自动消失，涡量完全退化为守恒标量对流扩散方程。

流场动能积分的总耗散率（Total Energy Dissipation Rate）$\varepsilon$ 满足多步对齐微分推导：

$$
\begin{aligned}
\varepsilon(t) &= 2\nu \int_{\Omega} S_{ij} S_{ij} \, \mathrm{d}^3\mathbf{x} \\
&= \nu \int_{\Omega} \left( \frac{\partial u_i}{\partial x_j} + \frac{\partial u_j}{\partial x_i} \right) \frac{\partial u_i}{\partial x_j} \, \mathrm{d}^3\mathbf{x} \\
&= \nu \int_{\Omega} \left( \frac{\partial u_i}{\partial x_j} \frac{\partial u_i}{\partial x_j} + \frac{\partial u_j}{\partial x_i}\frac{\partial u_i}{\partial x_j} \right) \, \mathrm{d}^3\mathbf{x} \\
&= \nu \int_{\Omega} |\boldsymbol{\omega}|^2 \, \mathrm{d}^3\mathbf{x} + \nu \oint_{\partial \Omega} \left[ \mathbf{n} \cdot \nabla \left( \frac{|\mathbf{u}|^2}{2} \right) - (\mathbf{u} \times \boldsymbol{\omega}) \cdot \mathbf{n} \right] \mathrm{d}S
\end{aligned}
$$

---

### 3.3 引用块（Blockquote）内部的大公式排版压测

在学术专著中，定理、引理和重点假定常采用引用块进行高亮。本节测试引用块内多级大公式的边界渲染与左边框间距守恒：

> #### 定理 3.1（开尔文环量守恒定理，Kelvin's Circulation Theorem）
> 在无粘（$\nu = 0$）、均质正压（$\rho = \rho(p)$）流体中，沿任何闭合流体微元周线 $C(t)$ 的速度环量 $\Gamma(t)$ 随时间保持恒定不变量：
> $$
> \Gamma(t) \equiv \oint_{C(t)} \mathbf{u} \cdot \mathrm{d}\mathbf{r} \implies \frac{\mathrm{d}\Gamma}{\mathrm{d}t} = 0
> $$
> 
> *证明概要*：对积分闭环求物质导数：
> $$
> \frac{\mathrm{d}\Gamma}{\mathrm{d}t} = \oint_{C(t)} \frac{\mathrm{D}\mathbf{u}}{\mathrm{D}t} \cdot \mathrm{d}\mathbf{r} + \oint_{C(t)} \mathbf{u} \cdot \mathrm{d}\left(\frac{\mathrm{D}\mathbf{r}}{\mathrm{D}t}\right)
> $$
> 由于 $\frac{\mathrm{D}\mathbf{r}}{\mathrm{D}t} = \mathbf{u}$，第二项积分为全微分梯度环量 $\oint \mathbf{u}\cdot \mathrm{d}\mathbf{u} = \oint \mathrm{d}\left(\frac{|\mathbf{u}|^2}{2}\right) = 0$。代入 Euler 动量方程：
> $$
> \oint_{C(t)} \frac{\mathrm{D}\mathbf{u}}{\mathrm{D}t} \cdot \mathrm{d}\mathbf{r} = -\oint_{C(t)} \frac{\nabla p}{\rho} \cdot \mathrm{d}\mathbf{r} = -\oint_{C(t)} \mathrm{d}h = 0 \quad \square
> $$
> 
> > 嵌套子引理 3.1.1（亥姆霍兹第二涡定理）：
> > 在相同假定下，涡管在运动过程中永不破碎，穿过涡管截面的总涡通量（涡强）在沿管长各处均保持恒定：
> > $$
> > \Phi_\omega = \iint_{\Sigma_1} \boldsymbol{\omega} \cdot \mathbf{n} \, \mathrm{d}S = \iint_{\Sigma_2} \boldsymbol{\omega} \cdot \mathbf{n} \, \mathrm{d}S = \text{const}
> > $$

---

## 四、第三篇章：应用数学与频域分析范例——《连续小波变换与多尺度时频频谱分析》

### 4.1 傅里叶积分变换与帕塞瓦尔能量守恒定理

设平方可积信号 $f(t) \in L^2(\mathbb{R})$。其连续傅里叶变换（Continuous Fourier Transform）$\mathcal{F}\{f\}(\xi) \equiv \hat{f}(\xi)$ 与傅里叶逆变换（Inverse Fourier Transform）定义如下：

$$
\begin{aligned}
\hat{f}(\xi) &= \int_{-\infty}^{+\infty} f(t) e^{-2\pi i \xi t} \, \mathrm{d}t \\
f(t) &= \int_{-\infty}^{+\infty} \hat{f}(\xi) e^{2\pi i \xi t} \, \mathrm{d}\xi
\end{aligned}
$$

两信号卷积 $h(t) = (f * g)(t) \equiv \int_{-\infty}^{+\infty} f(\tau)g(t-\tau)\,\mathrm{d}\tau$ 映射为频域乘积：$\widehat{(f * g)}(\xi) = \hat{f}(\xi) \cdot \hat{g}(\xi)$。帕塞瓦尔定理（Parseval-Plancherel Theorem）证明了时域与频域几何范数等距同构（Isometry）：

$$
\langle f, g \rangle_{L^2} = \int_{-\infty}^{+\infty} f(t)\overline{g(t)}\,\mathrm{d}t = \int_{-\infty}^{+\infty} \hat{f}(\xi)\overline{\hat{g}(\xi)}\,\mathrm{d}\xi = \langle \hat{f}, \hat{g} \rangle_{L^2}
$$

当 $f = g$ 时，全时域积分总能量与全频域能量守恒相等：

$$
\|f\|_{L^2}^2 = \int_{-\infty}^{+\infty} |f(t)|^2 \, \mathrm{d}t = \int_{-\infty}^{+\infty} |\hat{f}(\xi)|^2 \, \mathrm{d}\xi = \|\hat{f}\|_{L^2}^2
$$

---

### 4.2 连续小波变换（CWT）与母小波容许性准则

由于经典傅里叶变换的基函数 $e^{2\pi i \xi t}$ 遍布整个实数域，丧失了时域局域性分辨率。为了兼顾时频局域化分辨率，引入母小波函数 $\psi(t) \in L^2(\mathbb{R})$。定义双参数膨胀平移函数族：

$$
\psi_{a, b}(t) \equiv \frac{1}{\sqrt{|a|}} \psi\left( \frac{t - b}{a} \right), \quad a \in \mathbb{R} \setminus \{0\}, \ b \in \mathbb{R}
$$

其中 $a$ 为尺度缩放因子（Dilation/Scale），$b$ 为时间平移位置（Translation），前缀归一化系数 $\frac{1}{\sqrt{|a|}}$ 保证了族函数能量恒等 $\|\psi_{a, b}\|_{L^2} = \|\psi\|_{L^2}$。信号 $f(t)$ 的连续小波变换（Continuous Wavelet Transform）定义为信号与小波基的内积：

$$
W_\psi[f](a, b) = \langle f, \psi_{a, b} \rangle = \frac{1}{\sqrt{|a|}} \int_{-\infty}^{+\infty} f(t) \, \overline{\psi\left(\frac{t - b}{a}\right)} \, \mathrm{d}t
$$

为了使小波逆变换在全空间存在并实现无损重构，母小波必须满足容许性准则（Admissibility Condition）[^daubechies1992]：

$$
C_\psi \equiv \int_{-\infty}^{+\infty} \frac{|\hat{\psi}(\omega)|^2}{|\omega|} \, \mathrm{d}\omega < \infty
$$

该积分收敛要求母小波在零频处傅里叶谱为零，即 $\hat{\psi}(0) = 0$，等价于要求小波函数在全时域具有零均值积分为零（波状震荡条件）：

$$
\int_{-\infty}^{+\infty} \psi(t) \, \mathrm{d}t = 0
$$

在满足容许性条件下，信号 $f(t)$ 可以通过连续反演积分完全重构：

$$
f(t) = \frac{1}{C_\psi} \int_{-\infty}^{+\infty} \int_{-\infty}^{+\infty} W_\psi[f](a, b) \, \frac{1}{\sqrt{|a|}} \psi\left(\frac{t - b}{a}\right) \frac{\mathrm{d}a \, \mathrm{d}b}{a^2}
$$

---

### 4.3 有序列表与嵌套任务列表内的缩进大公式测试

在技术分析文档中，公式推导常常分解为步骤清单。此场景对缩进测量、列表标号对齐（`token-list-number`）与块级边界隔离构成极大考验：

1. **时频窗中心与带宽离散化**：
   设定分析小波在时域的中心为 $t^* = \frac{1}{\|\psi\|^2} \int_{-\infty}^\infty t |\psi(t)|^2 \mathrm{d}t$，时域有效半径定义为：
   $$
   \Delta_\psi = \left( \frac{1}{\|\psi\|^2} \int_{-\infty}^\infty (t - t^*)^2 |\psi(t)|^2 \mathrm{d}t \right)^{1/2}
   $$
2. **频域中心与海森堡时频测不准视窗**：
   频域中心 $\omega^*$ 与频域带宽 $\Delta_{\hat{\psi}}$ 形成时频网格包围面积：
   $$
   \Delta_t \cdot \Delta_\omega = \Delta_\psi \cdot \Delta_{\hat{\psi}} \ge \frac{1}{2}
   $$
   - [x] **高频小尺度解析（$a \ll 1$）**：
     时域分辨率极高，时间窗宽度窄缩为 $a \Delta_\psi$；频域窗展宽为 $\frac{\Delta_{\hat{\psi}}}{a}$，适用于瞬态尖峰识别；
   - [x] **低频大尺度解析（$a \gg 1$）**：
     时域窗变宽为 $a \Delta_\psi$，频域分辨率大幅提升，适用于捕捉宏观平稳基波：
     $$
     \text{Box}(a, b) = \left[ b - a\Delta_\psi, \, b + a\Delta_\psi \right] \times \left[ \frac{\omega^*}{a} - \frac{\Delta_{\hat{\psi}}}{a}, \, \frac{\omega^*}{a} + \frac{\Delta_{\hat{\psi}}}{a} \right]
     $$
   - [ ] **复解析小波瞬时相位与幅值剥离（待数值校核）**：
     通过解析小波 $\psi_{\text{analytic}}(t) = \psi(t) + i \mathcal{H}\{\psi\}(t)$ 提取瞬时包络 $A(a, b) = |W[f](a, b)|$。

---

## 五、第四篇章：深度学习与计算科学范例——《Transformer 多头注意力矩阵微积分与反向传播》

### 5.1 缩放点积注意力（Scaled Dot-Product Attention）张量表达

在 Transformer 架构中[^vaswani2017]，输入序列表示为嵌入矩阵 $\mathbf{X} \in \mathbb{R}^{n \times d_{\text{model}}}$，通过三个可学习投影权重矩阵 $\mathbf{W}^Q \in \mathbb{R}^{d_{\text{model}} \times d_k}$、$\mathbf{W}^K \in \mathbb{R}^{d_{\text{model}} \times d_k}$、$\mathbf{W}^V \in \mathbb{R}^{d_{\text{model}} \times d_v}$ 映射为查询（Query）、键（Key）和值（Value）矩阵：

$$
\mathbf{Q} = \mathbf{X}\mathbf{W}^Q, \quad \mathbf{K} = \mathbf{X}\mathbf{W}^K, \quad \mathbf{V} = \mathbf{X}\mathbf{W}^V
$$

缩放点积注意力机制（Scaled Dot-Product Attention）定义为矩阵运算：

$$
\operatorname{Attention}(\mathbf{Q}, \mathbf{K}, \mathbf{V}) = \operatorname{softmax}\left( \frac{\mathbf{Q}\mathbf{K}^T}{\sqrt{d_k}} \right) \mathbf{V}
$$

定义注意力得分矩阵（Attention Score Matrix）为 $\mathbf{S} \in \mathbb{R}^{n \times n}$，归一化概率权重矩阵为 $\mathbf{P} = \operatorname{softmax}(\mathbf{S}) \in \mathbb{R}^{n \times n}$：

$$
\mathbf{S} = \frac{\mathbf{Q}\mathbf{K}^T}{\sqrt{d_k}}, \qquad P_{ij} = \frac{\exp(S_{ij})}{\sum_{k=1}^n \exp(S_{ik})}
$$

输出特征矩阵表示为概率矩阵对值矩阵的加权线性组合：$\mathbf{O} = \mathbf{P}\mathbf{V} \in \mathbb{R}^{n \times d_v}$。

---

### 5.2 雅可比矩阵求导与反向传播链式法则推导

设反向传播阶段上层网络传回的损失梯度张量为 $\frac{\partial \mathcal{L}}{\partial \mathbf{O}} \equiv \mathbf{G}_O \in \mathbb{R}^{n \times d_v}$。由矩阵微分法则 $\mathrm{d}\mathcal{L} = \operatorname{Tr}\left( \mathbf{G}_O^T \, \mathrm{d}\mathbf{O} \right)$：

$$
\mathrm{d}\mathbf{O} = (\mathrm{d}\mathbf{P})\mathbf{V} + \mathbf{P}(\mathrm{d}\mathbf{V}) \implies \frac{\partial \mathcal{L}}{\partial \mathbf{V}} = \mathbf{P}^T \mathbf{G}_O
$$

损失对注意力权重矩阵 $\mathbf{P}$ 的梯度标为 $\mathbf{G}_P \equiv \frac{\partial \mathcal{L}}{\partial \mathbf{P}} = \mathbf{G}_O \mathbf{V}^T$。接下来推导 Softmax 的行雅可比矩阵求导。对于第 $i$ 行向量，若 $S_i \in \mathbb{R}^n, P_i = \operatorname{softmax}(S_i)$，其偏导关系为：

$$
\frac{\partial P_{ij}}{\partial S_{ik}} = P_{ij}(\delta_{jk} - P_{ik})
$$

损失对得分矩阵 $\mathbf{S}$ 的梯度展开为多行对齐等式：

$$
\begin{aligned}
\frac{\partial \mathcal{L}}{\partial S_{ij}} &= \sum_{k=1}^n \frac{\partial \mathcal{L}}{\partial P_{ik}} \frac{\partial P_{ik}}{\partial S_{ij}} \\
&= \sum_{k=1}^n G_{P, ik} \left[ P_{ik}(\delta_{jk} - P_{ij}) \right] \\
&= G_{P, ij} P_{ij} - P_{ij} \sum_{k=1}^n G_{P, ik} P_{ik} \\
&= P_{ij} \left( G_{P, ij} - \sum_{k=1}^n G_{P, ik} P_{ik} \right)
\end{aligned}
$$

将上述标量形式写为无循环向量化矩阵闭式解：

$$
\mathbf{G}_S \equiv \frac{\partial \mathcal{L}}{\partial \mathbf{S}} = \mathbf{P} \odot \left( \mathbf{G}_P - \left[ (\mathbf{G}_P \odot \mathbf{P})\mathbf{1}_{n \times 1} \right] \mathbf{1}_{1 \times n} \right)
$$

最后，将梯度反向传递至查询矩阵 $\mathbf{Q}$ 与键矩阵 $\mathbf{K}$：

$$
\begin{aligned}
\frac{\partial \mathcal{L}}{\partial \mathbf{Q}} &= \frac{1}{\sqrt{d_k}} \mathbf{G}_S \mathbf{K} \\
\frac{\partial \mathcal{L}}{\partial \mathbf{K}} &= \frac{1}{\sqrt{d_k}} \mathbf{G}_S^T \mathbf{Q}
\end{aligned}
$$

---

### 5.3 超大分块矩阵与分段函数排版压测

本节对包含大量行列的方括号大矩阵 $\begin{bmatrix}\end{bmatrix}$、圆括号矩阵 $\begin{pmatrix}\end{pmatrix}$ 及大括号分段函数 $\begin{cases}\end{cases}$ 进行排版压测：

多头注意力机制（Multi-Head Attention）各头矩阵拼接与分块投影矩阵定义如下：

$$
\mathbf{W}^O = \begin{bmatrix}
\mathbf{W}_1^O \\
\hline
\mathbf{W}_2^O \\
\hline
\vdots \\
\hline
\mathbf{W}_h^O
\end{bmatrix}, \qquad
\operatorname{MultiHead}(\mathbf{Q}, \mathbf{K}, \mathbf{V}) = \begin{bmatrix}
\operatorname{head}_1 & \operatorname{head}_2 & \cdots & \operatorname{head}_h
\end{bmatrix}
\begin{bmatrix}
\mathbf{W}_1^O \\
\mathbf{W}_2^O \\
\vdots \\
\mathbf{W}_h^O
\end{bmatrix}
$$

因果自注意力掩码矩阵（Causal Attention Mask Matrix）$\mathbf{M} \in \mathbb{R}^{n \times n}$ 具有严苛的下三角阶梯结构：

$$
M_{ij} = \begin{cases}
0, & \text{当 } i \ge j \text{（允许关注历史与自身 token）} \\
-\infty, & \text{当 } i < j \text{（因果遮蔽未来未来信息）}
\end{cases}
$$

展开至 $5 \times 5$ 的因果屏蔽掩码矩阵显式展示：

$$
\mathbf{M}_{5 \times 5} = \begin{pmatrix}
0 & -\infty & -\infty & -\infty & -\infty \\
0 & 0 & -\infty & -\infty & -\infty \\
0 & 0 & 0 & -\infty & -\infty \\
0 & 0 & 0 & 0 & -\infty \\
0 & 0 & 0 & 0 & 0
\end{pmatrix}
$$

激活函数 SwiGLU（Swish Gated Linear Unit）分段与非线性变换公式：

$$
\operatorname{SwiGLU}(\mathbf{x}) = \left( \mathbf{x}\mathbf{W}_{\text{gate}} \odot \sigma(\beta \mathbf{x}\mathbf{W}_{\text{gate}}) \right) \mathbf{W}_{\text{up}} = \begin{cases}
\dfrac{\mathbf{x}\mathbf{W}_{\text{gate}}}{1 + e^{-\beta \mathbf{x}\mathbf{W}_{\text{gate}}}} \mathbf{W}_{\text{up}}, & \text{当 } \beta > 0 \\[1.5em]
\dfrac{1}{2} \mathbf{x}\mathbf{W}_{\text{gate}} \mathbf{W}_{\text{up}}, & \text{当 } \beta \to 0
\end{cases}
$$

---

## 六、第五篇章：生化热力学与语法对照评测——《氧化还原动力学与语法对抗》

### 6.1 复杂生物化学反应方程式与自由能变计算

生物体内葡萄糖完全有氧氧化分步水解为二氧化碳与水，并释放大量的吉布斯自由能（Gibbs Free Energy）：

$$
\mathrm{C_6H_{12}O_6} + 6\,\mathrm{O_2} \xrightarrow{\text{酶催化级联反应}} 6\,\mathrm{CO_2} + 6\,\mathrm{H_2O} + \Delta G^\circ{}'
$$

标准生化状态（$T = 298.15 \ \mathrm{K}, P = 101.325 \ \mathrm{kPa}, \mathrm{pH} = 7.0$）下反应自由能变量：

$$
\Delta G^\circ{}' = -2870 \ \mathrm{kJ\cdot mol^{-1}}
$$

在线粒体内膜呼吸链复合体中，NADH 氧化还原半反应电极电势遵循能斯特方程（Nernst Equation）：

$$
E = E^\circ - \frac{RT}{zF} \ln \left( \frac{[\text{还原态}]}{[\text{氧化态}]} \right) = E^\circ - \frac{2.303 RT}{zF} \log_{10} Q
$$

其中 $R = 8.314462 \ \mathrm{J\cdot mol^{-1}\cdot K^{-1}}$ 为摩尔气体常数，$F = 96485.332 \ \mathrm{C\cdot mol^{-1}}$ 为法拉第常数，$z$ 为转移电子摩尔当量数。

---

### 6.2 Pandoc 扩展上下标 vs LaTeX 原生数学上下标实测对抗

本小节展示两种上下标语法在真实文档中的并排对比，测试混合渲染引擎在词法解析层、AST 映射与排版基准线上的表现：

1. **化学分子式**：
   - Pandoc 简写语法：水分子 H~2~O，葡萄糖分子 C~6~H~12~O~6~，硫酸铝铵十二水合物 AlNH~4~(SO~4~)~2~·12H~2~O；
   - LaTeX 原生语法：$\mathrm{H_2O}$，$\mathrm{C_6H_{12}O_6}$，$\mathrm{AlNH_4(SO_4)_2\cdot 12H_2O}$。
2. **多项式、幂级数与高阶张量**：
   - Pandoc 简写语法：二进制幂次 2^10^ = 1024，光速能质公式 E = mc^2^，极小量 10^-9^ 米；
   - LaTeX 原生语法：$2^{10} = 1024$，$E = mc^2$，$10^{-9} \ \mathrm{m}$。
3. **多重嵌套与复合指标对抗**：
   - Pandoc 语法：基底状态 a~i,j~^k+1^；
   - LaTeX 语法：$a_{i,j}^{k+1}$。

---

### 6.3 渲染引擎视觉一致性对比分析表

| 评测维度 | Pandoc 扩展语法（`~` 与 `^`） | LaTeX 语法（`$...$`） | 混合渲染编辑器处理机制与推荐准则 |
| :--- | :--- | :--- | :--- |
| **源码解析速度** | 极快（纯字符正则扫描 `sub_tilde` / `sup_caret`） | 需送入 KaTeX LRU 缓存管道解析 AST | 简短化学式推荐 Pandoc；复杂数理公式必须使用 LaTeX |
| **字体渲染族** | 继承正文字体（UI Font / Inter / PingFang） | 渲染为 Computer Modern / KaTeX Math 字体 | 正文叙述保持文字连贯性；严谨论文推荐 LaTeX |
| **基线与高度控制** | CSS `vertical-align: sub/super`（需严格限制零高度溢出） | KaTeX 内部 `mord` / `msupsub` 精确微米级对齐 | 两种模式均已锁定 28px 行盒网格，杜绝上下抖动 |
| **中文混排友好度** | 原生内联，与中文标点间距天然自然 | 需在 KaTeX 两侧注入微小边距（`margin: 0 0.15em`） | 引擎已默认处理内联数学符号两端空气间距 |

---

## 七、第六篇章：学术规范体系——多段落学术脚注与 BibTeX 参考文献

### 7.1 论文级引用标记与多段落扩展脚注测试

在正规学术专著中，脚注往往不仅包含简短的 URL，更包含补充理论论证、引理拓展及二阶参考文献：

现代相对论天体物理研究始于爱因斯坦的划时代论文[^einstein1905]，该论文确立了狭义相对论的时空观念。此后，狄拉克在量子电动力学中成功融合了相对论协变性与量子算符理论[^dirac1930]，并基于路径积分表象由费曼进一步推广[^feynman1965]。在流体力学领域，纳维-斯托克斯偏微分方程的解的存在性与光滑性问题，至今仍被列为克雷数学研究所千禧年七大数学难题之一[^clay2000]。在当代人工智能与大语言模型底层，Vaswani 等人提出的自注意力网络架构[^vaswani2017]与 LeCun 等人的深层卷积表征理论[^lecun2015]共同构成了深度学习的基石。此外，香农建立的信息论体系奠定了数字信息熵的数学度量[^shannon1948]。

---

### 7.2 经典学术文献库规范条目（含 DOI 与 arXiv 链接）

[^einstein1905]: Einstein, A. (1905). *Zur Elektrodynamik bewegter Körper*. Annalen der Physik, 322(10), 891–921.  
    **扩展说明（多段落缩进测试）**：本文系狭义相对论开山之作。爱因斯坦在文中摒弃了以太假说，提出两条基本公设：
    1. 相对性原理：物理定律在所有惯性参考系中形式相同；
    2. 光速不变原理：真空中光速与光源运动状态无关。由此直接推导洛伦兹变换 $x' = \gamma(x - vt)$。

[^dirac1930]: Dirac, P. A. M. (1930). *The Principles of Quantum Mechanics*. Oxford University Press.  
    **扩展说明**：狄拉克在此专著中系统引入了 Bra-Ket 狄拉克符号系统，建立了态矢量希尔伯特空间投影理论与相对论电子狄拉克方程 $(i\gamma^\mu \partial_\mu - m)\psi = 0$。

[^feynman1965]: Feynman, R. P., & Hibbs, A. R. (1965). *Quantum Mechanics and Path Integrals*. McGraw-Hill.  
    **核心思想**：通过泛函积分 $\int \mathcal{D}[x(t)] \exp\left( \frac{i}{\hbar} S[x(t)] \right)$ 取代传统哈密顿算符时间演化，为现代规范场论与费曼图计算提供了无坐标微扰展开框架。

[^navier1822]: Navier, C. L. (1822). *Mémoire sur les lois du mouvement des fluides*. Mémoires de l'Académie Royale des Sciences de l'Institut de France, 6, 389–440.

[^vaswani2017]: Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, Ł., & Polosukhin, I. (2017). *Attention Is All You Need*. Advances in Neural Information Processing Systems (NeurIPS 2017), 30, 5998–6008. [arXiv:1706.03762](https://arxiv.org/abs/1706.03762)

[^lecun2015]: LeCun, Y., Bengio, Y., & Hinton, G. (2015). *Deep learning*. Nature, 521(7553), 436–444. [DOI:10.1038/nature14539](https://doi.org/10.1038/nature14539)

[^shannon1948]: Shannon, C. E. (1948). *A Mathematical Theory of Communication*. Bell System Technical Journal, 27(3), 379–423. 信息熵定义：$H(X) = -\sum_{i=1}^n P(x_i) \log_2 P(x_i)$。

[^clay2000]: Fefferman, C. L. (2000). *Existence and Smoothness of the Navier-Stokes Equation*. Clay Mathematics Institute Millennium Prize Problems.

---

## 八、第七篇章：极端排版与多模态容器压测套件（Extreme Layout Suite）

### 8.1 极端嵌套一：双层引用块内嵌任务列表与多行对齐矩阵

本测试用例检验渲染器在多重引用标记（`> >`）、列表缩进与矩阵排版相互交织时的层级解析与 CSS 盒模型渲染能力：

> ### 外层审查报告（Review Layer 1）
> 理论审查委员对规范场理论协变性提出如下复核意见：
> 
> > #### 内层理论核心证据（Nested Layer 2）
> > 检验杨-米尔斯非阿贝尔规范场（Yang-Mills Gauge Field）场强张量：
> > $$
> > \mathbf{F}_{\mu\nu} = \partial_\mu \mathbf{A}_\nu - \partial_\nu \mathbf{A}_\mu + g [\mathbf{A}_\mu, \mathbf{A}_\nu]
> > $$
> > 
> > 必须在下周前完成以下验证清单：
> > - [x] **四维色动量生成元对易闭包验证**：
> >   $$
> >   [T^a, T^b] = i f^{abc} T^c, \quad \operatorname{Tr}(T^a T^b) = \frac{1}{2}\delta^{ab}
> >   $$
> > - [ ] **高维超空间旋量变换矩阵收敛性**：
> >   $$
> >   \mathbf{\Sigma}^{\mu\nu} = \frac{i}{4}[\gamma^\mu, \gamma^\nu] = \begin{pmatrix}
> >   \sigma^{\mu\nu}_{(11)} & 0 & \cdots & 0 \\
> >   0 & \sigma^{\mu\nu}_{(22)} & \cdots & 0 \\
> >   \vdots & \vdots & \ddots & \vdots \\
> >   0 & 0 & \cdots & \sigma^{\mu\nu}_{(dd)}
> >   \end{pmatrix}
> >   $$

---

### 8.2 极端嵌套二：复杂数据表格内的行内公式与块级公式

在 Markdown 标准表格中，管道符 `|` 是列分隔符。公式中若包含 `|`（例如模长 $|x|$ 或 Dirac 符号 $|\psi\rangle$），必须使用 `\vert` 或转义 `\|`，否则将破坏表格结构。以下展示包含丰富数学公式的专业学术对比表：

| 理论模型 | 控制方程组 / 作用量积分 | 关键守恒荷 / 不变量 | 对易关系 / 边界代数 | 物理适用区间 |
| :--- | :--- | :--- | :--- | :--- |
| **量子力学 (QM)** | $i\hbar \dfrac{\partial}{\partial t}\vert\psi\rangle = \hat{H}\vert\psi\rangle$ | 总概率 $\langle\psi\vert\psi\rangle \equiv 1$ | $[\hat{x}, \hat{p}] = i\hbar\mathbb{I}$ | 微观低速 ($v \ll c$) |
| **狭义相对论 (SR)** | $ds^2 = \eta_{\mu\nu} dx^\mu dx^\nu$ | 四维动量模长 $P^\mu P_\mu = -m^2 c^2$ | 洛伦兹群 $\mathrm{SO}(1, 3)$ | 宏观高速 ($v \approx c$) |
| **广义相对论 (GR)** | $R_{\mu\nu} - \frac{1}{2}R g_{\mu\nu} = \frac{8\pi G}{c^4} T_{\mu\nu}$ | 能量动量协变守恒 $\nabla_\mu T^{\mu\nu} = 0$ | 微分同胚群 $\mathrm{Diff}(\mathcal{M})$ | 宇观强引力场 |
| **电动力学 (Maxwell)** | $\partial_\mu F^{\mu\nu} = \mu_0 J^\nu$ | 电荷局域守恒 $\partial_\mu J^\mu = 0$ | 规范对称群 $\mathrm{U}(1)$ | 电磁相互作用 |
| **流体力学 (N-S)** | $\rho \dfrac{\mathrm{D}\mathbf{u}}{\mathrm{D}t} = -\nabla p + \mu \nabla^2\mathbf{u}$ | 涡量环量 $\oint \mathbf{u} \cdot \mathrm{d}\mathbf{r} = \text{const}$ | 无发散条件 $\nabla \cdot \mathbf{u} = 0$ | 宏观连续介质 |

---

### 8.3 极端超长长公式与横向滚动容错规范

学术论文中常常出现无法在一行内折行的超长代数展开式。编辑器在处理此类公式时，必须保证：
1. 外层容器绝不出现页面级横向滚动条；
2. 公式块自身激活平滑横向滚动机制（`overflow-x: auto`）；
3. 复制按钮固定于可视右上角，不随横向滚动而移出视线。

下面为电弱统一理论中 $S$ 矩阵非对角元色散微扰展开极限超长公式：

$$
\mathcal{M}_{fi}^{(2\text{-loop})}(s, t, u) = \frac{g^4}{16\pi^2} \int \frac{\mathrm{d}^4 k}{(2\pi)^4} \frac{\bar{u}(p_3) \gamma^\mu (\rlap{/}{k} + m_1) \gamma^\nu (\rlap{/}{k} - \rlap{/}{q} + m_2) \gamma_\mu u(p_1) \cdot \bar{v}(p_2) \gamma_\nu v(p_4)}{\left[ k^2 - m_1^2 + i\epsilon \right] \left[ (k - q)^2 - m_2^2 + i\epsilon \right] \left[ (k - p_1)^2 - M_W^2 + i\epsilon \right] \left[ (k + p_2)^2 - M_Z^2 + i\epsilon \right]} + \sum_{j=1}^{12} \frac{\Gamma_j(s, t)}{\sqrt{s(s - 4m^2)}} \ln\left( \frac{\sqrt{s} + \sqrt{s - 4m^2}}{\sqrt{s} - \sqrt{s - 4m^2}} \right) + \mathcal{O}(g^6)
$$

---

## 九、第八篇章：自动化工程验收断言与现场探针测试指南

为保证本示例集在自动化集成测试（Vitest / Playwright / Chrome DevTools MCP）与用户日常编辑中保持零退化，特制定如下三级验收断言规范：

### 9.1 AST 节点解析完整性断言（Parser Contract）

```typescript
// 伪代码：解析器完整性断言规范
import { MarkdownParser } from '../core/parser';

describe('AST Math & Academic Specification Contract', () => {
  it('应当准确将 $$ 独立行识别为 math_fence_start 与 math_fence_end', () => {
    const input = '$$\nE = mc^2\n$$';
    const lines = input.split('\n');
    const parser = new MarkdownParser();
    const { codeBlockState } = parser.preScanCodeBlocks(lines);
    
    expect(codeBlockState[0]).toBe('math_fence_start');
    expect(codeBlockState[1]).toBe('math_block');
    expect(codeBlockState[2]).toBe('math_fence_end');
  });

  it('应当准确将行内 $ 识别为 inline math token 并保留原始 LaTeX 源码', () => {
    const input = '波函数为 $\\psi(x)$。';
    const parser = new MarkdownParser();
    const tokens = parser.tokenizeInline(input);
    const mathToken = tokens.find(t => t.type === 'math');
    
    expect(mathToken).toBeDefined();
    expect(mathToken?.content).toBe('\\psi(x)');
    expect(mathToken?.raw).toBe('$\\psi(x)$');
  });
});
```

### 9.2 DOM 树结构与 CSS 类名断言（DOM Tree Contract）

在渲染树挂载后，探针脚本应当在 DOM 层面执行以下结构断言：

1. **行内公式结构**：
   - 必须包含容器节点 `<span class="token-math-wrapper">`；
   - 内部包含 `<span class="math-preview">`，其子树中必须包含 KaTeX 生成的 `.katex` 根节点；
   - 必须包含用于精确坐标回溯的光标映射槽位 `<span class="math-source syntax-hidden">`；
   - 当行或 Token 处于活跃编辑态（`.is-active-token`）时，`.math-preview` 必须平滑切至隐藏，`.math-source` 展开供用户无损编辑。
2. **块级公式结构**：
   - 块级公式包裹于 `<div class="line-block line-math-block">`；
   - 内部包含 `<div class="math-block-rendered">`，且挂载包含复制事件监听的 `<button data-copy-button="math">`；
   - 居中对齐且拥有独立类名 `.katex-display`。

### 9.3 几何测量与行高稳定性断言（Geometric Invariance Assertion）

1. **行高绝对守恒测试（Grid Line Invariance: $\Delta H \equiv 0$）**：
   - 在一个标准正文行输入复杂行内公式（如 $\int_0^1 \frac{\sqrt{x}}{1+x^2} \mathrm{d}x$）；
   - 通过 `getBoundingClientRect()` 测得包含行外盒高度，必须恒等于未插入公式时的基础行高（标准 `28px`，允许物理渲染误差 $\le 0.5\text{px}$）；
   - 严禁触发外层视口的滚动条重绘与抖动。
2. **测量管线无盲区投影（Cursor Projection Precision: $\Delta X \le 1\text{px}$）**：
   - 当光标位于公式右侧紧邻字符时，双层测量引擎 `measureTextWidth` 测得的水平坐标与真实物理光标像素位置偏差必须 $\le 1\text{px}$；
   - 严禁退化为行首（$X = 0$）回退通道。

---

*（本示例集已全面就绪，可直接作为大型学术文献模版导入编辑器，或作为回归压力测试用例套件纳入 CI 流水线）*
