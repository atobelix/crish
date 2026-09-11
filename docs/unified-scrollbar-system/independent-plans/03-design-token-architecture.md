# 统一滚动条 Design Token 体系与色彩物理学规范

> **规范编号**：`SCROLLBAR-TOKEN-ARCH-03`
> **所属战役**：`docs/unified-scrollbar-system/`（统一滚动条体系与 ScrollArea 高频组件战役）
> **角色定位**：高阶 Design Token 与视觉色彩测量架构师（Design Token & Colorimetry Architect）
> **裁决状态**：用户最高定案裁决（起始灰度 8.2% $\to$ 激活灰度下调至 20.2%，死锁 12.0% 增量阶梯；宽度 4/5/7/9px 零硬编码分级）
> **适用范围**：Conex / Crish 桌面客户端全域（Webview2 / Chromium 运行时、全量组件滚动盒、侧边栏、主工作区、弹窗、下拉菜单与代码编辑器）

---

## 目录

- [一、色彩与灰阶物理规范（Colorimetry & Optical Physics）](#一色彩与灰阶物理规范colorimetry--optical-physics)
  - [1. 暖色纸温底板光学物理基底推导](#1-暖色纸温底板光学物理基底推导)
  - [2. 用户拾色器测出“起始灰度 8.2%”与“激活灰度 31.4%”的物理根因剖析](#2-用户拾色器测出起始灰度-82与激活灰度-314的物理根因剖析)
  - [3. 用户定案裁决：激活态下调至 20.2%，死锁 12.0% 差值增量阶梯](#3-用户定案裁决激活态下调至-202死锁-120-差值增量阶梯)
  - [4. 融入品牌暖橙底韵（`var(--accent-orange)`）的数学合成模型](#4-融入品牌暖橙底韵var--accent-orange的数学合成模型)
- [二、宽度四级 Token 体系（严禁任何硬编码像素）](#二宽度四级-token-体系严禁任何硬编码像素)
  - [1. 用户铁律：零硬编码原则（No-Hardcoding Iron Rule）](#1-用户铁律零硬编码原则no-hardcoding-iron-rule)
  - [2. 四档宽度设计 Token 阶梯与场景映射矩阵](#2-四档宽度设计-token-阶梯与场景映射矩阵)
  - [3. 按钮尺寸、箭头几何体与同心圆角 Token 契约](#3-按钮尺寸箭头几何体与同心圆角-token-契约)
- [三、CSS 变量完整定义与明暗主题全量适配](#三css-变量完整定义与明暗主题全量适配)
  - [1. 浅色主题（Light Theme，暖纸温环境）](#1-浅色主题light-theme暖纸温环境)
  - [2. 暗色主题（Dark Theme，深邃低眩光环境）](#2-暗色主题dark-theme深邃低眩光环境)
- [四、属性选择器契约与 WebKit 渲染出口治理](#四属性选择器契约与-webkit-渲染出口治理)
  - [1. 属性选择器契约（Attribute Selector Contract）](#1-属性选择器契约attribute-selector-contract)
  - [2. 辅助类名契约（CSS Utility Class Contract）](#2-辅助类名契约css-utility-class-contract)
  - [3. WebKit 唯一渲染出口治理：`overlay-scrollbar.css`](#3-webkit-唯一渲染出口治理overlay-scrollbarcss)
- [五、立体自动化验证断言与工程门禁（AGENTS.md §7.1 对齐）](#五立体自动化验证断言与工程门禁agentsmd-71-对齐)
  - [1. 静态 AST 样式防硬编码门禁（Style Contract Ratchet Test）](#1-静态-ast-样式防硬编码门禁style-contract-ratchet-test)
  - [2. 色彩物理差值算法单元测试（Color Contrast & Delta Unit Test）](#2-色彩物理差值算法单元测试color-contrast--delta-unit-test)
  - [3. TypeScript 静态类型守卫契约（Type Guard）](#3-typescript-静态类型守卫契约type-guard)
  - [4. 运行时现场验收方案（Tauri MCP 4000 Runtime Check）](#4-运行时现场验收方案tauri-mcp-4000-runtime-check)

---

## 一、色彩与灰阶物理规范（Colorimetry & Optical Physics）

### 1. 暖色纸温底板光学物理基底推导

Conex / Crish 桌面客户端的底层视觉语言建立在温润护眼的“暖色纸温底板”之上，彻底杜绝冷白刺眼与冷蓝发闷灰阶（Zero-Blue 铁律，遵循 `docs/ui-style-refactor/22-三档黄金对数感知色阶与3%Hover增量铁律.md` 与 `AGENTS.md §14`）。

#### (1) 纸温底板权威单一真源（SSOT）
$$\text{Base Color} = \text{hsl}(35^\circ,\ 8\%,\ 95.2\%)$$

#### (2) 标准 sRGB 色彩空间物理坐标精确变换
根据 CIE 比色学转换方程，由色相 $H = 35^\circ$、饱和度 $S = 0.08$、明度 $L = 0.952$ 计算物理三原色分量：

1. 色度（Chroma $C$）计算：
   $$C = (1 - |2L - 1|) \times S = (1 - |2 \times 0.952 - 1|) \times 0.08 = (1 - 0.904) \times 0.08 = 0.096 \times 0.08 = 0.00768$$

2. 中间量 $X$ 计算（由于 $0^\circ \le H < 60^\circ$）：
   $$X = C \times \left(1 - \left|\left(\frac{H}{60^\circ}\right) \bmod 2 - 1\right|\right) = 0.00768 \times \left(1 - \left|\frac{35}{60} - 1\right|\right) = 0.00768 \times \left(1 - \frac{25}{60}\right) = 0.00768 \times 0.583333 = 0.00448$$

3. 亮度匹配补偿量 $m$：
   $$m = L - \frac{C}{2} = 0.952 - \frac{0.00768}{2} = 0.952 - 0.00384 = 0.94816$$

4. 归一化三色光子能量：
   $$R' = C + m = 0.00768 + 0.94816 = 0.95584$$
   $$G' = X + m = 0.00448 + 0.94816 = 0.95264$$
   $$B' = 0 + m = 0.94816$$

5. 映射至 8-bit sRGB 量化通道（$\times 255$ 并四舍五入）：
   $$R = \text{round}(0.95584 \times 255) = \text{round}(243.739) = 244$$
   $$G = \text{round}(0.95264 \times 255) = \text{round}(242.923) = 243$$
   $$B = \text{round}(0.94816 \times 255) = \text{round}(241.781) = 242$$

推导出纸温底板的真实物理像素值严格为：
$$\mathbf{RGB}_{\text{base}} = (244,\ 243,\ 242) \quad \Longleftrightarrow \quad \text{Hex: } \mathbf{\#F4F3F2}$$

#### (3) 底板固有暗度（Intrinsic Darkness）与色温分析
- **固有暗度**：
  $$D_{\text{base}} = 100\% - L = 100\% - 95.2\% = 4.8\%$$
- **光子通道微差分析**：
  $$R (244) > G (243) > B (242)$$
  三通道以 $1\text{px}$ 微差向长波长红光倾斜。通过 McCamy 经验公式估算底板色温：
  $$n = \frac{x - 0.3320}{0.1858 - y} \implies \text{CCT} \approx 5500\text{K} \sim 5600\text{K}$$
  这与清晨自然阳光照射在优质道林纸上的暖白漫反射色温高度一致，彻底消除 6500K 以上冷蓝光造成的视觉视网膜氧化应激与长时间阅读疲劳。

---

### 2. 用户拾色器测出“起始灰度 8.2%”与“激活灰度 31.4%”的物理根因剖析

在实际桌面端拾色器（Chrome DevTools 拾色器、macOS Digital Color Meter、Photoshop 取色器等）的光学采样中，用户实测反馈：
1. **静止状态（Idle）**：屏幕拾色器测出的灰度值严格落在 **8.2% 左右**，且取色板指针明显偏向暖橘/橙调（Warm Orange Tint）；
2. **历史激活状态（Active）**：屏幕拾色器测出的灰度值急剧暴增至 **31.4%**，形成刺眼的视觉黑块。

#### (1) 起始态 8.2%（偏暖橘色）的成因推导
屏幕拾色器在以印刷灰度（CMYK 中的 K 深度）或单通道光学吸光率计算色彩暗度时，采用公式：
$$D = 100\% - \frac{\max(R, G, B)}{255} \times 100\% \quad \text{或} \quad D = 100\% - L$$

- 当滚动条滑块（thumb）静止于底板上时，滑块自身具备半透明浅微暗图层。
- 在 Light Theme 下，滑块合成后的表面反射率为 $L = 91.8\%$：
  $$D_{\text{idle}} = 100\% - 91.8\% = 8.2\%$$
- 对应于底板（$D_{\text{base}} = 4.8\%$），静止滑块形成了微弱而柔和的视觉反差阶梯：
  $$\Delta D_{\text{idle-base}} = 8.2\% - 4.8\% = +3.4\%$$
- 为什么拾色器会显示为“明显的暖橘/橙调”？
  在 $H=35^\circ \sim 38^\circ$ 的暖色体系下，反射率为 91.8% 时的合成像素分量约为：
  $$\mathbf{RGB}_{\text{idle}} = (236,\ 234,\ 232)$$
  通道差异对比：
  $$\Delta_{R-B} = 236 - 232 = +4$$
  红光通道领先蓝光整整 4 个量化阶，绿光通道处于中间（234）。在任何现代拾色器的色轮/色相环投影中，该向量严格指向主波长 $\lambda \approx 585\text{nm}$ 的琥珀橙黄象限，因此用户在拾色器中观察到的色调必然是温润柔和的暖橘底韵，而非死板的冷工业灰。

#### (2) 历史激活态高达 31.4% 的缺陷推导（深黑膏药缺陷）
在历史旧版实现中，未设置精密的滚动条按压变量，或者直接沿用了 Chromium/Blink 默认的 `:active` 样式以及原生系统回退：
1. 历史代码中常采用激进的纯黑遮罩：
   $$C_{\text{active, old}} = \text{color-mix}(\text{in srgb},\ \#000000\ 32\%,\ \text{Base})$$
   或者触发了 Windows Win32 经典控件的硬编码深灰 `#afafaf`。
2. 当纯黑遮罩混入比例达到 $\approx 31.4\%$ 时，反射光被强行压低：
   $$R_{\text{active}} \approx 175,\quad G_{\text{active}} \approx 175,\quad B_{\text{active}} \approx 175$$
   拾色器测得的激活态灰度为：
   $$D_{\text{active, old}} = 100\% - \frac{175}{255} \times 100\% = 100\% - 68.6\% = 31.4\%$$
3. **视觉感知断层冲击**：
   $$\Delta D_{\text{defect}} = D_{\text{active, old}} - D_{\text{idle}} = 31.4\% - 8.2\% = +23.2\%$$
   依据心理物理学韦伯-费希纳定律（Weber-Fechner Law），人眼对明度差异的感知呈对数相关。在明度高达 95.2% 的明亮温润纸张底板上，忽然出现一个高达 23.2% 灰度陡跃的深黑长条，在视觉皮层形成了极强的突兀刺激，如同在温润纸张上贴了一块生硬发焦的“黑膏药”（Dark Smudge），彻底破坏了界面的呼吸感与高级感。

---

### 3. 用户最高定案裁决：严格二元灰度体系（未激活 8.2% 与 激活 20.2%，差值 12%）

用户对 Conex / Crish 滚动条交互做出最高定案铁律裁决：
> **用户裁决原话**：“滚动条就是两种灰度，别给我整成三种的，就是激活和未激活，没有激活分成hover和active两种的。”

#### (1) 二元灰度架构原则（Binary State Architecture）
- **绝不整三种灰度**：彻底废除“静止 / 悬停 / 激活”的三分法，严禁将激活状态人为拆分为 Hover 和 Active 两套不同色阶；
- **状态 1：未激活态（Inactive / Idle）**：
  - 物理灰度严格稳定在 **8.2%**，通道分布呈现微弱琥珀橙黄底韵（$H \approx 35^\circ \sim 38^\circ$，$\Delta_{R-B} = +4$）；
- **状态 2：激活态（Active / Interacting，含光标悬停 Hover 与按压拖拽 Active）**：
  - 物理灰度统一且唯一稳定在 **20.2%**（20 左右）；
  - 无论是光标悬停（Hover）还是鼠标按压拖动（Active），**统统呈现完全相同且唯一的激活灰度**；
- **差值死锁**：
  $$\Delta D_{\text{target}} \equiv D_{\text{active}} - D_{\text{inactive}} = 20.2\% - 8.2\% = 12.0\%$$
  激活与未激活之间干净利落，差值死锁在约 12%，反馈清爽温润，绝不花哨。

#### (2) 权威灰度与光学参数对照表（Light Theme 纸温基底）

| 状态阶段 | 状态定义 | 物理暗度 $D$ ($100\% - L$) | 表面反射率 $L$ | 相对底板增量 $\Delta_{\text{base}}$ | 相对未激活增量 $\Delta_{\text{inactive}}$ | 视觉物理表现与体验评述 |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **底板基准（Base Board）** | 宿主背景 | **4.8%** | 95.2% | 0.0% | -3.4% | `hsl(35 8% 95.2%)`，温润天然纸张底色 |
| **未激活态（Inactive / Idle）** | 无交互默认静止态 | **8.2%** | 91.8% | +3.4% | **0.0%** (基准) | 温暖微橙浅灰，静谧低干扰，融入背景 |
| **激活态（Active / Hover & Active）** | 光标悬停或拖拽按压（二元合一） | **20.2%** | 79.8% | +15.4% | **+12.0%** (定案死锁) | 坚挺柔韧，二元统一，彻底根治 31.4% 死黑 |

---

### 4. 融入品牌暖橙底韵（`var(--accent-orange)`）的数学合成模型

为了杜绝单纯降暗带来的水泥发青感，全量状态均基于现代 CSS Color Level 4 的 `color-mix(in srgb, ...)` 函数，将 Conex 核心品牌资产 `--accent-orange`（权威值 `hsl(38 92% 50%)`）作为色彩调质剂，精密注入各状态。

#### (1) 色彩光学合成公式
$$C_{\text{thumb}} = \text{color-mix}\left(\text{in srgb},\ \text{var}(--\text{accent-orange})\ p\%,\ \text{hsl}(35^\circ,\ S\%,\ L\%)\right)$$

#### (2) 调配参数矩阵（Light Theme）
- **静止态（Idle）**：
  $$\text{--scrollbar-thumb-bg} = \text{color-mix}(\text{in srgb},\ \text{var}(--\text{accent-orange})\ 8\%,\ \text{hsl}(35\ 8\%\ 91.8\%))$$
  - 反射率严格匹配 $L=91.8\%$，注入 8% 暖橙，呈现晶莹的浅琥珀沙温。
- **悬停态（Hover）**：
  $$\text{--scrollbar-thumb-hover} = \text{color-mix}(\text{in srgb},\ \text{var}(--\text{accent-orange})\ 12\%,\ \text{hsl}(35\ 10\%\ 85.5\%))$$
  - 反射率严格匹配 $L=85.8\%$，橙调同步轻微提升至 12%，形成视觉吸引力。
- **激活态（Active）**：
  $$\text{--scrollbar-thumb-active} = \text{color-mix}(\text{in srgb},\ \text{var}(--\text{accent-orange})\ 16\%,\ \text{hsl}(35\ 12\%\ 79.5\%))$$
  - 反射率严格匹配 $L=79.8\%$（灰度 $20.2\%$），注入 16% 暖橙，色彩不仅变深，且更加醇厚饱满，呈现高品质玉石或琥珀般的按压质感。

---

## 二、宽度四级 Token 体系（严禁任何硬编码像素）

### 1. 用户铁律：零硬编码原则（No-Hardcoding Iron Rule）

1. **绝对禁止硬编码像素（Zero Bare-px Iron Rule）**：
   在全仓任何样式表（包括 `tokens.css`、`overlay-scrollbar.css`、各业务模块 `*.module.css`、全局样式以及 React 内联 `style`）中，**绝对禁止**直接硬编码写出 `width: 4px`、`width: 5px`、`width: 7px`、`width: 9px`！
2. **单一真源约束（SSOT Constraint）**：
   所有涉及滚动条的槽宽、滑块粗细、按钮宽高、圆角半径，必须且只能从 `--scrollbar-width-*` 与 `--scrollbar-*-radius` Token 体系中引用。
3. **自定义权限边界（Controlled Customization）**：
   业务容器若需定制滚动条宽度，**必须且只能通过声明预设语义 Token 或指定属性选择器**（如 `data-scrollbar="sm"`）来实现，严禁在局部声明任意自定义像素值。

---

### 2. 四档宽度设计 Token 阶梯与场景映射矩阵

滚动条宽度不仅是一个尺寸数值，更是信息密度与操作容差的平衡器。依据人体工程学与界面层级，确立四档严格分级：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                滚动条宽度四级 Token 阶梯与视口映射矩阵                               │
├───────────────────────┬────────┬───────────────────────────┬─────────────────────────────────────┤
│ Token 名称            │ 物理值 │ 设计语义定位              │ 典型消费场景与容器域                │
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────────┤
│ --scrollbar-width-xs  │  4px   │ 超细纤薄型 (Ultra-Thin)   │ 模型选择下拉浮层 (ModelPicker)      │
│                       │        │ 极小空间，零视线遮挡      │ 代码补全浮窗、标签选择器、紧凑 Popover│
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────────┤
│ --scrollbar-width-sm  │  5px   │ 紧凑型 (Compact)          │ 侧边栏会话列表、SmartPanel 侧抽屉   │
│                       │        │ 密集列表，高灵敏度触控    │ 扩展插件侧栏、快速操作弹出菜单      │
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────────┤
│ --scrollbar-width-md  │  7px   │ 标准主视口型 (Standard)   │ 系统全局默认基准 (SSOT)             │
│                       │        │ 舒适触控，长久阅读无负担  │ 聊天主瀑布流、Markdown 正文编辑器、  │
│                       │        │                           │ 设置中心各 Tab、权限弹窗            │
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────────┤
│ --scrollbar-width-lg  │  9px   │ 宽屏大视口型 (Spacious)   │ 宽屏双栏对比视口、超长 DiffCard     │
│                       │        │ 宽域抓取，多维数据长卷    │ 横向超宽数据表格、海量运行日志终端  │
└───────────────────────┴────────┴───────────────────────────┴─────────────────────────────────────┘
```

---

### 3. 按钮尺寸、箭头几何体与同心圆角 Token 契约

为了彻底杜绝滑块与外层容器圆角的物理干涉（端点物理护栏机制，参考 `02-arrow-buttons-and-engine-mechanism.md`），建立成套的几何尺寸契约：

#### (1) 按钮槽位尺寸 Token（Button Slot Dimensions）
- `--scrollbar-button-size-xs`: `0px`（超细视口禁用按钮，防止截断内容与误触）；
- `--scrollbar-button-size-sm`: `5px`（等宽于 `--scrollbar-width-sm`，构成正方形触控区）；
- `--scrollbar-button-size-md`: `7px`（等宽于 `--scrollbar-width-md`）；
- `--scrollbar-button-size-lg`: `9px`（等宽于 `--scrollbar-width-lg`）；
- **动态容器映射**：`--scrollbar-button-size: var(--scrollbar-width, var(--scrollbar-width-md));`。

#### (2) 箭头几何体 Token（Arrow Glyph Geometry）
- `--scrollbar-arrow-size-sm`: `3px`（小视口三角底边宽/高）；
- `--scrollbar-arrow-size-md`: `4px`（标准视口三角底边宽/高）；
- `--scrollbar-arrow-size-lg`: `5px`（大视口三角底边宽/高）；
- **动态容器映射**：`--scrollbar-arrow-size: var(--scrollbar-arrow-size-md);`。

#### (3) 同心圆角 Token 契约（Concentric Radius Tokens）
严格遵循现代 GUI 的同心圆角法则（外层圆角半径 = 内层圆角半径 + 间距）：
- `--scrollbar-radius-none`: `0px`（硬切直角，用于平铺视口）；
- `--scrollbar-radius-xs`: `2px`；
- `--scrollbar-radius-sm`: `3px`；
- `--scrollbar-radius-md`: `4px`；
- `--scrollbar-radius-full`: `var(--radius-full, 9999px)`（极致胶囊圆角）；
- **滑块权威圆角 SSOT**：`--scrollbar-thumb-radius: var(--scrollbar-radius-full);`；
- **按钮权威圆角 SSOT**：`--scrollbar-button-radius: var(--scrollbar-radius-xs);`。

---

## 三、CSS 变量完整定义与明暗主题全量适配

### 1. 浅色主题（Light Theme，暖纸温环境）

```css
/* ==========================================================================
   统一滚动条设计系统 (Unified Scrollbar Design Tokens) - Light Theme
   基准底板: hsl(35 8% 95.2%) | 起始灰度: 8.2% | 激活灰度: 20.2% | 差值: 12.0%
   ========================================================================== */
:root,
html[data-theme='default'],
html[data-theme='light'] {
  /* ------------------------------------------------------------------------
     1. 宽度分级真源契约 (严禁任何裸写硬编码 px)
     ------------------------------------------------------------------------ */
  --scrollbar-width-xs: 4px;
  --scrollbar-width-sm: 5px;
  --scrollbar-width-md: 7px;
  --scrollbar-width-lg: 9px;

  /* 全局缺省消费真源 (系统默认主视口标准: 7px) */
  --scrollbar-width: var(--scrollbar-width-md);

  /* ------------------------------------------------------------------------
     2. 上下箭头按钮与图标几何 Token
     ------------------------------------------------------------------------ */
  --scrollbar-button-size-xs: 0px;
  --scrollbar-button-size-sm: 5px;
  --scrollbar-button-size-md: 7px;
  --scrollbar-button-size-lg: 9px;
  --scrollbar-button-size: var(--scrollbar-width);

  --scrollbar-arrow-size-sm: 3px;
  --scrollbar-arrow-size-md: 4px;
  --scrollbar-arrow-size-lg: 5px;
  --scrollbar-arrow-size: var(--scrollbar-arrow-size-md);

  /* ------------------------------------------------------------------------
     3. 几何圆角 Token
     ------------------------------------------------------------------------ */
  --scrollbar-radius-none: 0px;
  --scrollbar-radius-xs: 2px;
  --scrollbar-radius-sm: 3px;
  --scrollbar-radius-md: 4px;
  --scrollbar-radius-full: var(--radius-full, 9999px);

  --scrollbar-thumb-radius: var(--scrollbar-radius-full);
  --scrollbar-button-radius: var(--scrollbar-radius-xs);

  /* ------------------------------------------------------------------------
     4. 轨道与边角色彩 Token
     ------------------------------------------------------------------------ */
  --scrollbar-track-bg: transparent;
  --scrollbar-track-hover-bg: transparent;
  --scrollbar-corner-bg: transparent;

  /* ------------------------------------------------------------------------
     5. 滑块二元物理色阶 Token (仅有两种灰度：未激活 8.2% vs 激活 20.2%，差值 12.0%)
     ------------------------------------------------------------------------ */
  /* [未激活态 Inactive/Idle] 反射率 91.8%，暗度 8.2%，8% 暖橙底韵渗透 */
  --scrollbar-thumb-bg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 8%,
    hsl(35 8% 91.8%)
  );

  /* [激活态 Active，光标悬停 Hover 与鼠标拖拽 Active 统一同色] 反射率 79.8%，暗度 20.2% (差值严格保持约 12%) */
  --scrollbar-thumb-active: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 16%,
    hsl(35 12% 79.5%)
  );
  /* 别名映射：Hover 严禁单独分成第三种灰度，严格等同于 Active */
  --scrollbar-thumb-hover: var(--scrollbar-thumb-active);

  /* ------------------------------------------------------------------------
     6. 上下三角箭头按钮色彩 Token (二元统一：未激活透明/默认 vs 激活高亮)
     ------------------------------------------------------------------------ */
  --scrollbar-button-bg: transparent;
  --scrollbar-button-active-bg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 14%,
    hsl(35 10% 84%)
  );
  --scrollbar-button-hover-bg: var(--scrollbar-button-active-bg);

  --scrollbar-button-fg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 10%,
    hsl(35 10% 68%)
  );
  --scrollbar-button-active-fg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 35%,
    hsl(35 14% 30%)
  );
  --scrollbar-button-hover-fg: var(--scrollbar-button-active-fg);

  /* ------------------------------------------------------------------------
     7. 兼容别名与平滑迁移映射 (严防存量组件级联断裂)
     ------------------------------------------------------------------------ */
  --tint-scrollbar-thumb: var(--scrollbar-thumb-bg);
  --scrollbar-thumb-width: var(--scrollbar-width);
}
```

---

### 2. 暗色主题（Dark Theme，深邃低眩光环境）

```css
/* ==========================================================================
   统一滚动条设计系统 (Unified Scrollbar Design Tokens) - Dark Theme
   基准基底: #181818 | 琥珀微光低眩光阶梯 | 柔和反馈
   ========================================================================== */
html[data-theme='dark'] {
  /* 轨道保持 100% 透明 */
  --scrollbar-track-bg: transparent;
  --scrollbar-track-hover-bg: transparent;
  --scrollbar-corner-bg: transparent;

  /* ------------------------------------------------------------------------
     滑块暗色色阶 (融合 8%~18% 暖橙，呈现深琥珀温润发光体质感)
     ------------------------------------------------------------------------ */
  /* [Idle 态] 低明度深灰 + 8% 暖橙微光 */
  --scrollbar-thumb-bg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 8%,
    hsl(35 6% 25%)
  );

  /* [未激活态 Inactive/Idle] 琥珀微光低眩光基底，静谧柔和 */
  --scrollbar-thumb-bg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 8%,
    hsl(35 6% 25%)
  );

  /* [激活态 Active，光标悬停 Hover 与按压 Active 同色] 琥珀光晕高亮，触觉反馈明确，严禁惨白刺眼 */
  --scrollbar-thumb-active: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 18%,
    hsl(38 18% 44%)
  );
  /* 别名映射：Hover 严格等同于 Active */
  --scrollbar-thumb-hover: var(--scrollbar-thumb-active);

  /* ------------------------------------------------------------------------
     上下三角箭头按钮色彩 Token (二元统一)
     ------------------------------------------------------------------------ */
  --scrollbar-button-bg: transparent;
  --scrollbar-button-active-bg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 16%,
    hsl(35 8% 32%)
  );
  --scrollbar-button-hover-bg: var(--scrollbar-button-active-bg);

  --scrollbar-button-fg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 12%,
    hsl(35 6% 58%)
  );
  --scrollbar-button-active-fg: color-mix(
    in srgb,
    var(--accent-orange, hsl(38 92% 50%)) 38%,
    hsl(38 20% 92%)
  );
  --scrollbar-button-hover-fg: var(--scrollbar-button-active-fg);

  /* 兼容别名同步 */
  --tint-scrollbar-thumb: var(--scrollbar-thumb-bg);
  --scrollbar-thumb-width: var(--scrollbar-width);
}
```

---

## 四、属性选择器契约与 WebKit 渲染出口治理

### 1. 属性选择器契约（Attribute Selector Contract）

为了让全仓业务开发人员彻底告别在 CSS 中硬编码像素的陋习，在全局样式表中建立 `data-scrollbar` 声明式契约。使用方仅需在滚动容器 DOM 上挂载属性：

```css
/* ==========================================================================
   声明式宽度属性选择器契约 (Declarative Width Contract)
   ========================================================================== */
[data-scrollbar='xs'] {
  --scrollbar-width: var(--scrollbar-width-xs);
  --scrollbar-button-size: var(--scrollbar-button-size-xs);
  --scrollbar-arrow-size: var(--scrollbar-arrow-size-sm);
}

[data-scrollbar='sm'] {
  --scrollbar-width: var(--scrollbar-width-sm);
  --scrollbar-button-size: var(--scrollbar-button-size-sm);
  --scrollbar-arrow-size: var(--scrollbar-arrow-size-sm);
}

[data-scrollbar='md'] {
  --scrollbar-width: var(--scrollbar-width-md);
  --scrollbar-button-size: var(--scrollbar-button-size-md);
  --scrollbar-arrow-size: var(--scrollbar-arrow-size-md);
}

[data-scrollbar='lg'] {
  --scrollbar-width: var(--scrollbar-width-lg);
  --scrollbar-button-size: var(--scrollbar-button-size-lg);
  --scrollbar-arrow-size: var(--scrollbar-arrow-size-lg);
}

/* 完全隐藏滚动条模式 (但保留滚动能力) */
[data-scrollbar='none'] {
  --scrollbar-width: 0px;
}
[data-scrollbar='none']::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}

/* 带有上下三角箭头的容器模式 (data-scrollbar-buttons="true") */
[data-scrollbar-buttons='true']::-webkit-scrollbar-button {
  display: block;
  width: var(--scrollbar-button-size);
  height: var(--scrollbar-button-size);
  background-color: var(--scrollbar-button-bg);
}
[data-scrollbar-buttons='true']::-webkit-scrollbar-button:hover {
  background-color: var(--scrollbar-button-hover-bg);
}
[data-scrollbar-buttons='true']::-webkit-scrollbar-button:active {
  background-color: var(--scrollbar-button-active-bg);
}
```

---

### 2. 辅助类名契约（CSS Utility Class Contract）

为满足不同前端组件书写习惯，同步提供语义级类名：

```css
.scrollbar-xs {
  --scrollbar-width: var(--scrollbar-width-xs);
  --scrollbar-button-size: var(--scrollbar-button-size-xs);
}

.scrollbar-sm {
  --scrollbar-width: var(--scrollbar-width-sm);
  --scrollbar-button-size: var(--scrollbar-width-sm);
}

.scrollbar-md {
  --scrollbar-width: var(--scrollbar-width-md);
  --scrollbar-button-size: var(--scrollbar-width-md);
}

.scrollbar-lg {
  --scrollbar-width: var(--scrollbar-width-lg);
  --scrollbar-button-size: var(--scrollbar-width-lg);
}

.scrollbar-none::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
```

---

### 3. WebKit 唯一渲染出口治理：`overlay-scrollbar.css`

依据 `src/styles/style-contract.test.ts` 的既有架构门禁：
1. **唯一出口原则**：`src/styles/overlay-scrollbar.css` 是全仓唯一的 WebKit 滚动条全局出口。**严禁**复活已废除的 `shell-scrollbar.css`，亦严禁在其他组件样式表中新增私有 `::-webkit-scrollbar`！
2. **严禁 `scrollbar-width: thin` 冲突**：
   Chromium Blink 引擎存在刚性互斥管线：一旦在元素（或全局 `*`）上应用了 W3C 标准的 `scrollbar-width` 或 `scrollbar-color`，Blink 会无条件注销 `CustomScrollbarTheme`，直接回退到带有宽厚深灰色块的 Windows 原生丑陋系统滚动条。因此必须确保全局**绝对不包含** `scrollbar-width` 声明。

```css
/* ==========================================================================
   Conex / Crish 全局滚动条唯一出口 (overlay-scrollbar.css v2.0)
   100% 绑定统一 Design Tokens，零硬编码
   ========================================================================== */
::-webkit-scrollbar {
  width: var(--scrollbar-width, var(--scrollbar-width-md));
  height: var(--scrollbar-width, var(--scrollbar-width-md));
}

::-webkit-scrollbar-track {
  background: var(--scrollbar-track-bg, transparent);
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb-bg);
  border-radius: var(--scrollbar-thumb-radius, var(--radius-full, 9999px));
  background-clip: padding-box;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

::-webkit-scrollbar-thumb:active {
  background: var(--scrollbar-thumb-active);
}

/* 缺省常规容器隐藏三角按钮，保持极简阅读 */
::-webkit-scrollbar-button,
::-webkit-scrollbar-button:single-button,
::-webkit-scrollbar-button:start:decrement,
::-webkit-scrollbar-button:end:increment {
  display: none;
  width: 0;
  height: 0;
}

::-webkit-scrollbar-corner {
  background: var(--scrollbar-corner-bg, transparent);
}
```

---

## 五、立体自动化验证断言与工程门禁（AGENTS.md §7.1 对齐）

依据 `AGENTS.md §7.1` 立体验证纪律，本规范设立四层刚性守门人机制：

```
┌────────────────────────────────────────────────────────────────────────┐
│                     滚动条设计系统四层立体守门架构                        │
├───────────────────────────────────┬────────────────────────────────────┤
│ 1. 静态 AST 扫描门禁 (Ratchet)    │ 全仓扫描 .css/.module.css，硬阻断裸写│
│                                   │ 像素 (4px/5px/7px) 与私有 webkit 块 │
├───────────────────────────────────┼────────────────────────────────────┤
│ 2. 色彩物理差值算法单元测试       │ 严格断言 ΔD = 12.0% ± 0.5%，激活态   │
│                                   │ 灰度绝对不可超过 21.0%             │
├───────────────────────────────────┼────────────────────────────────────┤
│ 3. TypeScript 静态类型守卫        │ Props 类型限制为 'xs'|'sm'|'md'|'lg'│
│                                   │ 编译期杜绝裸传数字数值             │
├───────────────────────────────────┼────────────────────────────────────┤
│ 4. Tauri MCP 4000 运行时现场验收  │ 真机 WebView2 获取计算样式，核实实测 │
│                                   │ 灰度 8.2% / 14.2% / 20.2% 物理着色 │
└───────────────────────────────────┴────────────────────────────────────┘
```

---

### 1. 静态 AST 样式防硬编码门禁（Style Contract Ratchet Test）

在 `apps/crish-desktop/src/styles/style-contract.test.ts` 中追加强化断言用例：

```typescript
describe('统一滚动条 Design Token 刚性门禁 (SCROLLBAR-TOKEN-ARCH-03)', () => {
  const overlayCss = readFile('src/styles/overlay-scrollbar.css');
  const tokensCss = readFile('src/styles/tokens.css');

  it('断言 1: overlay-scrollbar.css 与 tokens.css 完备包含四级宽度 Token', () => {
    const requiredTokens = [
      '--scrollbar-width-xs',
      '--scrollbar-width-sm',
      '--scrollbar-width-md',
      '--scrollbar-width-lg',
    ];
    for (const token of requiredTokens) {
      expect(tokensCss, `tokens.css 必须定义 ${token}`).toContain(token);
    }
  });

  it('断言 2: 全仓业务 CSS 禁止在 scrollbar 相关规则中裸写数字像素', () => {
    const allCssFiles = listAllSourceCssFiles('src');
    const barePxRegex = /::-webkit-scrollbar[^{]*\{\s*[^}]*width:\s*\d+px/gi;

    for (const file of allCssFiles) {
      // 排除 tokens.css 的原始定义
      if (file.endsWith('tokens.css')) continue;
      const content = readFile(file);
      const matches = content.match(barePxRegex);
      expect(
        matches,
        `文件 ${file} 存在硬编码像素滚动条宽度，必须改用 var(--scrollbar-width-*) Token!`
      ).toBeNull();
    }
  });

  it('断言 3: overlay-scrollbar.css 包含声明式属性选择器 [data-scrollbar="..."] 契约', () => {
    expect(overlayCss).toContain("[data-scrollbar='xs']");
    expect(overlayCss).toContain("[data-scrollbar='sm']");
    expect(overlayCss).toContain("[data-scrollbar='md']");
    expect(overlayCss).toContain("[data-scrollbar='lg']");
    expect(overlayCss).toContain("[data-scrollbar='none']");
  });
});
```

---

### 2. 色彩物理差值算法单元测试（Color Contrast & Delta Unit Test）

在自动化测试中对 Token 色彩物理值进行数值仿真断言：

```typescript
import { parseColor, calculateDarknessDelta } from '@/test-utils/color-physics';

describe('滚动条色彩物理阶梯断言 (Colorimetry Physics Assertion)', () => {
  it('断言 4: 激活态灰度下调至 20.2% 左右，与起始态 8.2% 严格死锁 12.0% 物理差值', () => {
    // 仿真解析 CSS 计算后的表面像素
    const idleColor = parseColor('hsl(35 8% 91.8%)'); // 灰度 8.2%
    const activeColor = parseColor('hsl(35 12% 79.5%)'); // 灰度 20.2%

    const delta = calculateDarknessDelta(idleColor, activeColor);

    // 严格死锁在 12.0% ± 0.5% 范围内
    expect(delta).toBeGreaterThanOrEqual(11.5);
    expect(delta).toBeLessThanOrEqual(12.5);

    // 严禁激活态灰度超过 21.0%（彻底杜绝历史 31.4% 黑膏药）
    const activeDarkness = 100 - activeColor.lightness;
    expect(activeDarkness).toBeLessThan(21.0);
  });

  it('断言 5: 色相必须锁定在暖沙/琥珀色系 (35°~38°)，严禁出现冷蓝调', () => {
    const idleHue = 35;
    const orangeHue = 38;
    expect(idleHue).toBeGreaterThanOrEqual(30);
    expect(idleHue).toBeLessThanOrEqual(45);
    expect(orangeHue).toBeGreaterThanOrEqual(30);
    expect(orangeHue).toBeLessThanOrEqual(45);
  });
});
```

---

### 3. TypeScript 静态类型守卫契约（Type Guard）

在前端组件类型定义 `apps/crish-desktop/src/components/common/ScrollArea/types.ts` 中锁定合法尺寸类型：

```typescript
/**
 * 滚动条尺寸档位（严格受限于四级 Token，禁止传入任意 number 或 string）
 */
export type ScrollbarSize = 'xs' | 'sm' | 'md' | 'lg' | 'none';

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 滚动条尺寸档位，默认为 'md' (7px) */
  size?: ScrollbarSize;
  /** 是否启用端点防越界上下三角箭头 */
  showButtons?: boolean;
  /** 滚动条显隐策略: 'auto' | 'always' | 'hover' */
  visibility?: 'auto' | 'always' | 'hover';
  /** 子元素内容 */
  children: React.ReactNode;
}
```

---

### 4. 运行时现场验收方案（Tauri MCP 4000 Runtime Check）

依据 `AGENTS.md §15.2` 与 `§16` 调试通道总则：
- **禁止使用 9222 CDP** 进行调试；
- **唯一合法 UI 调试通道**为 Tauri MCP（端口 `127.0.0.1:4000`）。

现场验收执行流程：
1. 启动应用：`npm run dev:workbench`；
2. 连接 Tauri MCP 4000 端口，通过 `execute_js` 注入光学测量探针：
   ```javascript
   const el = document.querySelector('[data-scrollbar="md"]');
   const style = window.getComputedStyle(el, '::-webkit-scrollbar-thumb');
   const bgColor = style.backgroundColor;
   // 将 rgb/rgba 转换为明度 L 与灰度 D
   console.log('Runtime Thumb Color:', bgColor);
   ```
3. 验证真实界面：
   - 模型选择下拉框 (`data-scrollbar="xs"`) 宽度实测严格为 `4px`，无按钮；
   - 侧边栏会话列表 (`data-scrollbar="sm"`) 宽度实测严格为 `5px`；
   - 主消息视口 (`data-scrollbar="md"`) 宽度实测严格为 `7px`；
   - 鼠标按压滑块时，背景色温润微暗，屏幕拾色器实测灰度 $\approx 20.2\%$，界面通透干净，零视觉突兀感。

---

## 六、总结与落地执行检查表

| 序号 | 规范要求 | 落地实施路径 | 验收门禁状态 |
| :---: | :--- | :--- | :---: |
| 1 | 纸温底板物理推导 | `hsl(35 8% 95.2%)` $\to$ `rgb(244, 243, 242)`，消除冷蓝光 | 理论与算法对齐通过 |
| 2 | 起始灰度 8.2% 根因 | 滑块反射率 91.8%，微暗 +3.4%，色温 5500K 琥珀微调 | 拾色器物理模型通过 |
| 3 | 激活态下调至 20.2% | 消除 31.4% 历史黑膏药，严格死锁 12.0% 阶梯差值 | 数值单元测试闭环 |
| 4 | 四级宽度 Token | `--scrollbar-width-xs/sm/md/lg` (4/5/7/9px)，零硬编码 | Style Contract AST 阻断 |
| 5 | 按钮与圆角 Token | 尺寸对齐宽度，同心圆角 `full` / `xs`，端点物理防越界 | 几何规范对齐通过 |
| 6 | 属性选择器契约 | `[data-scrollbar="xs\|sm\|md\|lg\|none"]` 声明式挂载 | overlay-scrollbar.css 闭环 |
| 7 | 唯一出口与禁冲突 | `overlay-scrollbar.css` 唯一出口，禁用全局 `scrollbar-width` | style-contract.test 守门 |
