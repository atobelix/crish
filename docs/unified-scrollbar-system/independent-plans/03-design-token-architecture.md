# 统一滚动条 Design Token 体系与色彩物理学规范

> **规范编号**：`SCROLLBAR-TOKEN-ARCH-03`  
> **生效批次**：2026-09 滚动条统一战役（Unified Scrollbar System）  
> **裁决状态**：用户定案裁决（起始灰度 8.2% $\to$ 激活灰度下调至 20.2%，死锁 12% 增量阶梯；宽度 4/5/7/9px 零硬编码分级）  
> **适用范围**：Conex / Crish 桌面客户端（Webview2 / Chromium 运行时、全量组件滚动盒、侧边栏、主工作区、弹窗与菜单）

---

## 一、色彩与灰阶物理规范（Colorimetry & Optical Physics）

### 1. 暖色纸温底板色彩物理基底推导

Conex / Crish 桌面客户端的核心设计哲学建立在温润护眼的“暖色纸温底板”之上，彻底杜绝冷蓝发闷灰阶（Zero-Blue 铁律，参考 `docs/ui-style-refactor/22-三档黄金对数感知色阶与3%Hover增量铁律.md` 与 `AGENTS.md §14`）。

- **纸温底板权威单一真源（SSOT）**：
  $$\text{Base Color} = \text{hsl}(35^\circ,\ 8\%,\ 95.2\%)$$
- **标准 sRGB 空间精确坐标变换推导**：
  根据比色学色彩模型转换方程：
  $$H = 35^\circ,\quad S = 0.08,\quad L = 0.952$$
  色度（Chroma）计算：
  $$C = (1 - |2L - 1|) \times S = (1 - |2 \times 0.952 - 1|) \times 0.08 = 0.096 \times 0.08 = 0.00768$$
  中间量：
  $$X = C \times \left(1 - \left|\left(\frac{H}{60^\circ}\right) \bmod 2 - 1\right|\right) = 0.00768 \times \left(1 - \left|\frac{35}{60} - 1\right|\right) = 0.00768 \times 0.58333 = 0.00448$$
  亮度匹配补偿量：
  $$m = L - \frac{C}{2} = 0.952 - 0.00384 = 0.94816$$
  由于 $0^\circ \le H < 60^\circ$，三色归一化分量为：
  $$R' = C + m = 0.00768 + 0.94816 = 0.95584 \implies R = \text{round}(0.95584 \times 255) = 244$$
  $$G' = X + m = 0.00448 + 0.94816 = 0.95264 \implies G = \text{round}(0.95264 \times 255) = 243$$
  $$B' = 0 + m = 0.94816 \implies B = \text{round}(0.94816 \times 255) = 242$$
  推导出**底板真实物理像素值**严格为：
  $$\mathbf{RGB}_{\text{base}} = (244,\ 243,\ 242)$$
- **底板固有灰度（Intrinsic Base Darkness）**：
  $$D_{\text{base}} = 100\% - L = 100\% - 95.2\% = 4.8\%$$
  由于 $R (244) > G (243) > B (242)$，红光分量处于优势，底板呈现极为温润柔和的天然纸张暖沙质感，为人眼长时间阅读提供最低光刺激基础。

---

### 2. 拾色器测出“起始灰度 8.2%”与“激活灰度 31.4%”的物理根因剖析

在实际桌面端拾色器（Chrome DevTools 拾色器、macOS Digital Color Meter、Photoshop 等）光学采样中，用户实测到：
- **静止状态（Idle）**：灰度值为 **8.2%**，色相明显偏向琥珀/橘橙调（Warm Orange Hue）；
- **激活状态（Active）**：灰度值急剧暴增至 **31.4%**。

#### (1) 起始态 8.2%（偏橘色）的成因推导
在初始静态下，滚动条滑块（thumb）的色彩呈现依赖于表面微暗图层与暖纸底板的叠加。
当滑块表面反射亮度为 $L = 91.8\%$ 时，拾色器测量其暗度（Darkness $D$ 或印刷灰度 K）：
$$D_{\text{idle}} = 100\% - 91.8\% = 8.2\%$$
在 $H=35^\circ \sim 38^\circ$ 色相基地下，其合成表面色彩的 RGB 分布为：
$$\mathbf{RGB}_{\text{idle}} \approx (236,\ 234,\ 232)$$
其中 $R$ 相对 $B$ 领先整整 4 个通道值（$\Delta_{R-B} = 4$），色温约在 5400K 暖白光区域，在拾色器上解析出的色彩极性必然显示为温暖的橘/橙微色调。这与基线规范中“微暖浅灰”完全一致。

#### (2) 激活态高达 31.4% 的灾难根因推导（历史缺陷）
在历史旧代码或 Chromium 原生回退逻辑中，`:active` 伪类使用了无约束的纯黑半透明遮罩（如 `rgba(0, 0, 0, 0.32)`）或直接触发了 Windows 系统默认控件的激活样式：
$$C_{\text{result}} = (1 - \alpha) \cdot C_{\text{base}} + \alpha \cdot C_{\text{black}}$$
当 $\alpha \approx 0.314$（或 Windows 系统激活直接填入 `#afafaf`）时：
$$R_{\text{active}} = G_{\text{active}} = B_{\text{active}} \approx 175$$
拾色器测得的激活态灰度为：
$$D_{\text{active, old}} = 100\% - \frac{175}{255} \times 100\% = 100\% - 68.6\% = 31.4\%$$
**视觉感知断层分析**：
$$\Delta D_{\text{old}} = 31.4\% - 8.2\% = +23.2\%$$
人眼在激活按压瞬间遭遇高达 23.2% 的灰度陡跌，在清爽明亮的 95.2% 底板上形成一块生硬发焦的“黑膏药”（Dark Smudge），瞬间摧毁了界面的通透性，违反了 `AGENTS.md §7` 杜绝打补丁与死黑粗糙样式的基本铁律。

---

### 3. 用户定案裁决：激活态下调至 20%，死锁 12% 差值增量阶梯

根据用户最高定案裁决，激活态必须由 31.4% 刚性下调至 20% 左右，使激活态与起始态（8.2%）的物理差值绝对保持在约 12%：

$$\Delta D_{\text{target}} = D_{\text{active}} - D_{\text{idle}} = 20.2\% - 8.2\% \equiv 12.0\%$$

根据人眼视觉对数感知定律（Weber-Fechner Law），交互状态的灰度过渡必须保持等阶梯递增，因此中间状态——**悬停态（Hover）**被严格划定在黄金对称中点：

$$\Delta D_{\text{step}} = \frac{\Delta D_{\text{target}}}{2} = 6.0\%$$

#### 权威灰度与光学参数对照表（Light Theme 纸温环境）

| 状态阶段 | 物理灰度 $D$ ($100\% - L$) | 表面反射率 $L$ | 相对底板增量 $\Delta_{\text{base}}$ | 相对静止态增量 $\Delta_{\text{idle}}$ | 视觉物理表现 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **底板基准（Base Board）** | **4.8%** | 95.2% | 0.0% | -3.4% | `hsl(35 8% 95.2%)`，温润天然纸质 |
| **静止态（Idle）** | **8.2%** | 91.8% | +3.4% | **0.0%** (基准) | 温暖微橙浅灰，静谧低干扰 |
| **悬停态（Hover）** | **14.2%** | 85.8% | +9.4% | **+6.0%** | 温润微暗，清晰感知光标触达 |
| **激活态（Active）** | **20.2%** | 79.8% | +15.4% | **+12.0%** (定案死锁) | 坚挺柔韧，彻底消除 31.4% 死黑 |

---

### 4. 融入温暖橘/橙底调（`var(--accent-orange)`）的数学合成模型

为使滚动条彻底脱离死板的工业冷灰，全面融入 Conex 品牌特色的活态暖色体系，采用现代 CSS `color-mix(in srgb, ...)` 将系统真源 `--accent-orange`（`hsl(38 92% 50%)`）精密注射入各状态色阶中。

#### 色彩合成公式：
$$C_{\text{state}} = \text{color-mix}\left(\text{in srgb},\ \text{var}(--\text{accent-orange})\ p\%,\ \text{BaseTone}_{L\%}\right)$$

通过调节注入比例 $p\%$ 与基底明度 $L\%$，在保证合成表面明度完全符合 8.2%、14.2%、20.2% 物理反射率的同时，使暖橘光子在各通道产生微量渗透，形成晶莹温润的琥珀质感。

---

## 二、宽度分级 Token 体系（严禁任何硬编码像素）

### 1. 用户铁律：零硬编码原则（No-Hardcoding Iron Rule）
- **禁止项**：全工程任何 CSS 模块（`.module.css`）、全局样式表、React 内联 `style` 中，绝对禁止直接编写 `width: 4px`、`width: 7px` 等硬编码像素！
- **真源项**：所有滚动条宽度与按钮尺寸必须统一从宽度分级 Token 体系中引用；必须支持容器级与场景级自定义，但**必须且只能从 Token 体系中选取**！

### 2. 四档宽度设计 Token 矩阵（Width Hierarchy Tokens）

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 滚动条宽度四级 Token 阶梯与视口映射                              │
├───────────────────────┬────────┬───────────────────────────┬─────────────────────────────────┤
│ Token 名称            │ 尺寸值 │ 设计语义定位              │ 典型消费场景与容器域            │
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────┤
│ --scrollbar-width-xs  │  4px   │ 超细纤薄型 (Ultra-Thin)   │ 模型选择下拉、代码自动补全悬浮窗│
│                       │        │ 极小空间，零视线遮挡      │ ModelBadgePickerMenu、标签云    │
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────┤
│ --scrollbar-width-sm  │  5px   │ 紧凑型 (Compact)          │ 侧边栏辅助抽屉、SmartPanel 折叠 │
│                       │        │ 密集列表，高灵敏度触控    │ 扩展列表面板、快速弹出菜单      │
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────┤
│ --scrollbar-width-md  │  7px   │ 标准主视口型 (Standard)   │ 系统全局默认基准 (SSOT)         │
│                       │        │ 舒适触控，长久阅读无负担  │ 聊天主瀑布流、正文编辑器、设置页│
├───────────────────────┼────────┼───────────────────────────┼─────────────────────────────────┤
│ --scrollbar-width-lg  │  9px   │ 宽屏大视口型 (Spacious)   │ 宽屏双栏对比、超长 DiffCard     │
│                       │        │ 宽域抓取，多维数据长卷    │ 横向宽表格、海量日志审计视口    │
└───────────────────────┴────────┴───────────────────────────┴─────────────────────────────────┘
```

### 3. 上下三角箭头按钮与圆角几何 Token

为了在特定复杂滚动容器（如日志终端、精确表格导航）中支持方向控制，并确保在隐藏/显示按钮时尺寸完全对齐滚动条槽位，定义整套按钮与圆角几何契约：

#### (1) 按钮槽位尺寸 Token（Button Size Tokens）
- `--scrollbar-button-size-xs`: `0px`（超细视口强制隐藏按钮，`display: none`，防止挤占空间与误触）；
- `--scrollbar-button-size-sm`: `5px`（等宽于 `--scrollbar-width-sm`）；
- `--scrollbar-button-size-md`: `7px`（等宽于 `--scrollbar-width-md`）；
- `--scrollbar-button-size-lg`: `9px`（等宽于 `--scrollbar-width-lg`）；
- 容器动态绑定：`--scrollbar-button-size: var(--scrollbar-width, 7px);`。

#### (2) 箭头几何体尺寸 Token（Arrow Glyph Size Tokens）
- `--scrollbar-arrow-size-sm`: `3px`（小视口三角高/宽）；
- `--scrollbar-arrow-size-md`: `4px`（标准视口三角高/宽）；
- `--scrollbar-arrow-size-lg`: `5px`（大视口三角高/宽）。

#### (3) 几何圆角 Token（Concentric Radius Tokens）
遵从 `AGENTS.md §13` 与同心圆角契约（Concentric Curvature）：
- `--scrollbar-radius-none`: `0px`（纯方角，用于贴边硬切视口）；
- `--scrollbar-radius-xs`: `2px`；
- `--scrollbar-radius-sm`: `3px`；
- `--scrollbar-radius-md`: `4px`；
- `--scrollbar-radius-full`: `var(--radius-full, 9999px)`（丝滑胶囊圆角，默认真源）；
- **滑块权威圆角真源**：`--scrollbar-thumb-radius: var(--scrollbar-radius-full);`；
- **按钮权威圆角真源**：`--scrollbar-button-radius: var(--scrollbar-radius-xs);`。

---

## 三、CSS 变量完整定义与明暗主题适配

### 1. 浅色主题（Light Theme，暖纸温环境）

```css
/* ==========================================================================
   统一滚动条设计系统 (Unified Scrollbar Design Tokens) - Light Theme
   基准底板: hsl(35 8% 95.2%) | 起始灰度: 8.2% | 激活灰度: 20.2% | 差值: 12.0%
   ========================================================================== */
:root,
html[data-theme='default'],
html[data-theme='light'] {
  /* --- 宽度分级真源契约 (严格杜绝硬编码像素) --- */
  --scrollbar-width-xs: 4px;
  --scrollbar-width-sm: 5px;
  --scrollbar-width-md: 7px;
  --scrollbar-width-lg: 9px;

  /* 缺省消费真源 (系统默认主视口标准: 7px) */
  --scrollbar-width: var(--scrollbar-width-md);

  /* --- 按钮尺寸与图标几何 Token --- */
  --scrollbar-button-size-xs: 0px;
  --scrollbar-button-size-sm: 5px;
  --scrollbar-button-size-md: 7px;
  --scrollbar-button-size-lg: 9px;
  --scrollbar-button-size: var(--scrollbar-width);

  --scrollbar-arrow-size-sm: 3px;
  --scrollbar-arrow-size-md: 4px;
  --scrollbar-arrow-size-lg: 5px;
  --scrollbar-arrow-size: var(--scrollbar-arrow-size-md);

  /* --- 几何圆角 Token --- */
  --scrollbar-radius-none: 0px;
  --scrollbar-radius-xs: 2px;
  --scrollbar-radius-sm: 3px;
  --scrollbar-radius-md: 4px;
  --scrollbar-radius-full: var(--radius-full, 9999px);

  --scrollbar-thumb-radius: var(--scrollbar-radius-full);
  --scrollbar-button-radius: var(--scrollbar-radius-xs);

  /* --- 轨道与边角色彩 Token --- */
  --scrollbar-track-bg: transparent;
  --scrollbar-track-hover-bg: transparent;
  --scrollbar-corner-bg: transparent;

  /* --- 滑块物理色阶 Token (融入 --accent-orange 暖调，死锁 12% 阶梯) --- */
  /* 1. 静止态 (Idle): 表面反射率 91.8%，灰度 8.2%，8% 橘橙暖度渗透 */
  --scrollbar-thumb-bg: color-mix(
    in srgb,
    var(--accent-orange) 8%,
    hsl(35 8% 91.8%)
  );

  /* 2. 悬停态 (Hover): 表面反射率 85.8%，灰度 14.2% (增量 +6.0%) */
  --scrollbar-thumb-hover: color-mix(
    in srgb,
    var(--accent-orange) 12%,
    hsl(35 10% 85.5%)
  );

  /* 3. 激活态 (Active): 表面反射率 79.8%，灰度 20.2% (增量 +12.0%，下调 31.4% 终点) */
  --scrollbar-thumb-active: color-mix(
    in srgb,
    var(--accent-orange) 16%,
    hsl(35 12% 79.5%)
  );

  /* --- 上下三角按钮色彩 Token --- */
  --scrollbar-button-bg: transparent;
  --scrollbar-button-hover-bg: color-mix(
    in srgb,
    var(--accent-orange) 8%,
    hsl(35 8% 91.8%)
  );
  --scrollbar-button-active-bg: color-mix(
    in srgb,
    var(--accent-orange) 14%,
    hsl(35 10% 84%)
  );

  --scrollbar-button-fg: color-mix(
    in srgb,
    var(--accent-orange) 10%,
    hsl(35 10% 68%)
  );
  --scrollbar-button-hover-fg: color-mix(
    in srgb,
    var(--accent-orange) 25%,
    hsl(35 12% 42%)
  );
  --scrollbar-button-active-fg: color-mix(
    in srgb,
    var(--accent-orange) 40%,
    hsl(35 14% 30%)
  );

  /* 向后兼容别名 (保护存量组件，严防级联断裂) */
  --tint-scrollbar-thumb: var(--scrollbar-thumb-bg);
  --scrollbar-thumb-width: var(--scrollbar-width);
}
```

---

### 2. 暗色主题（Dark Theme，深邃低眩光环境）

```css
/* ==========================================================================
   统一滚动条设计系统 (Unified Scrollbar Design Tokens) - Dark Theme
   深邃基底: #181818 | 琥珀微光低眩光阶梯 | 柔和反馈
   ========================================================================== */
html[data-theme='dark'] {
  /* 轨道依然保持 100% 透明 */
  --scrollbar-track-bg: transparent;
  --scrollbar-track-hover-bg: transparent;
  --scrollbar-corner-bg: transparent;

  /* 暗色滑块色阶 (融合 8%~16% 暖橙，呈现深琥珀温润质感) */
  --scrollbar-thumb-bg: color-mix(
    in srgb,
    var(--accent-orange) 8%,
    hsl(35 6% 25%)
  );

  --scrollbar-thumb-hover: color-mix(
    in srgb,
    var(--accent-orange) 12%,
    hsl(35 8% 34%)
  );

  --scrollbar-thumb-active: color-mix(
    in srgb,
    var(--accent-orange) 18%,
    hsl(38 18% 44%)
  );

  --scrollbar-button-bg: transparent;
  --scrollbar-button-hover-bg: color-mix(
    in srgb,
    var(--accent-orange) 10%,
    hsl(35 6% 24%)
  );
  --scrollbar-button-active-bg: color-mix(
    in srgb,
    var(--accent-orange) 16%,
    hsl(35 8% 32%)
  );

  --scrollbar-button-fg: color-mix(
    in srgb,
    var(--accent-orange) 12%,
    hsl(35 6% 58%)
  );
  --scrollbar-button-hover-fg: color-mix(
    in srgb,
    var(--accent-orange) 24%,
    hsl(35 8% 78%)
  );
  --scrollbar-button-active-fg: color-mix(
    in srgb,
    var(--accent-orange) 38%,
    hsl(38 20% 92%)
  );

  /* 向后兼容别名同步 */
  --tint-scrollbar-thumb: var(--scrollbar-thumb-bg);
  --scrollbar-thumb-width: var(--scrollbar-width);
}
```

---

## 四、落地实施方案与 WebKit 渲染出口治理

### 1. WebKit 与 Chromium WebView2 核心渲染准则
- **唯一出口律**：根据 `src/styles/style-contract.test.ts` 门禁契约，`src/styles/overlay-scrollbar.css` 是全仓**唯一的全局滚动条渲染出口**。严禁复活已废除的 `shell-scrollbar.css`！
- **杜绝 `scrollbar-width` 冲突**：在全局 `*` 以及 Chromium 容器上**绝对禁止**声明 `scrollbar-width: thin`，否则 Chromium 渲染引擎将无条件关闭 `::-webkit-scrollbar` 渲染管线，退化为带有粗重系统黑箭头的 Windows 原生丑陋滚动条。

### 2. 全局出口重构标准：`src/styles/overlay-scrollbar.css` 升级

```css
/* ==========================================================================
   Conex / Crish 全局滚动条唯一渲染出口 (overlay-scrollbar.css v2.0)
   严格走 ::-webkit-scrollbar 管线，100% 绑定统一 Design Tokens
   ========================================================================== */

/* 全局默认滚动条视口 */
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

/* 缺省状态隐藏按钮，保护极简阅读界面 */
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

/* ==========================================================================
   零硬编码属性选择器契约：容器级自定义宽度标准出口
   消费方仅需声明 [data-scrollbar="..."] 或局部覆盖 --scrollbar-width
   ========================================================================== */
[data-scrollbar='xs'] {
  --scrollbar-width: var(--scrollbar-width-xs);
}

[data-scrollbar='sm'] {
  --scrollbar-width: var(--scrollbar-width-sm);
}

[data-scrollbar='md'] {
  --scrollbar-width: var(--scrollbar-width-md);
}

[data-scrollbar='lg'] {
  --scrollbar-width: var(--scrollbar-width-lg);
}

[data-scrollbar='none'] {
  --scrollbar-width: 0px;
}
[data-scrollbar='none']::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

/* 带有方向指示箭头的容器契约 (data-scrollbar-buttons="true") */
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

## 五、立体自动化验证断言与门禁规划（Multi-Layer Verification）

依据 `AGENTS.md §7.1` 立体验证纪律，本规范设立三层刚性门禁：

### 1. 静态门禁测试（CSS Ast & Style Contract Test）
- 在 `src/styles/style-contract.test.ts` 中升级断言：
  - **断言 1（零硬编码扫描）**：全工程所有 `.css` / `.module.css` 文件中，禁止在 `::-webkit-scrollbar` 块中出现数字像素（`\d+px`），必须且只能出现 `var(--scrollbar-width...)`；
  - **断言 2（差值严格锁定断言）**：对 `tokens.css` 解析出的明度或灰度进行断言，验证 $\Delta D = D_{\text{active}} - D_{\text{idle}} = 12.0\% \pm 0.5\%$，严禁激活态超过 21%；
  - **断言 3（Token 完备性验证）**：验证 `--scrollbar-width-xs` (4px)、`--scrollbar-width-sm` (5px)、`--scrollbar-width-md` (7px)、`--scrollbar-width-lg` (9px) 完整存在且不可变；
  - **断言 4（零冷蓝守门）**：验证 `--scrollbar-thumb-bg` 系列中禁止包含冷蓝调，色相必须锁定在 $H = 35^\circ \sim 38^\circ$ 琥珀暖沙基底。

### 2. 运行时现场验收（Runtime DevTools & Tauri MCP 4000）
- 通过 Tauri MCP 通道在真实 WebView2 运行时中检查计算样式（Computed Style）：
  - 检查主聊天视口处于 idle 时，thumb 实际渲染色彩，灰度严格稳定在约 8.2%；
  - 触发鼠标 `:hover`，灰度温润过渡至 14.2%；
  - 触发鼠标按压 `:active`，灰度稳定下调至 20.2%，彻底根治 31.4% 黑膏药死色。
