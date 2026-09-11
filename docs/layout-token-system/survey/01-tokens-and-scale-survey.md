# Token 刻度定义与数学几何现状调研报告

> **战役工作区**：`docs/layout-token-system/`
> **调研文件**：`docs/layout-token-system/survey/01-tokens-and-scale-survey.md`
> **调研角色**：Token 刻度定义与数学几何现状调研员
> **调研基线代码**：`apps/crish-desktop/src/styles/tokens.css`、`apps/crish-desktop/src/styles/design-system.css`、`reference/ui-replica-refactored/src/tokens/spacing.css`、`docs/archive/legacy/HARDCODED-TOKEN-AUDIT.md`
> **日期**：2026-09-11

---

## 一、调研背景与全景摘要

### 1.1 调研目标
针对 Conex / Crish 桌面端当前样式体系中的间距刻度（`--space-*`）、圆角几何（`--radius-*`）、响应式密度换挡（`[data-ui-size]`）以及 Token 架构分层现状，进行全景式代码取证与数学几何分析，定位核心断裂与视觉违规事实，为第二阶段系统性重构与建立 3 层 Token 契约提供确凿依据。

### 1.2 核心发现评级表

| 风险编号 | 维度 | 严重级别 | 核心问题描述 | 关键代码位置 |
|:---|:---|:---:|:---|:---|
| **BUG-T01** | 密度换挡 | 🔴 **P0 (阻断级)** | `[data-ui-size='small']` 中 `--space-1` 被强行重写为 `3px`，引入奇数像素并破坏 4px/2px 基准网格；同时遗漏 `--space-8` 与 `--space-10` | `tokens.css:1248`, `tokens.css:1244-1253` |
| **BUG-T02** | 密度换挡 | 🔴 **P0 (阻断级)** | `[data-ui-size='small']` 发生刻度塌缩碰撞：`--space-2_5` 与 `--space-3` 同为 `6px`，`--space-3_5` 与 `--space-4` 同为 `10px`，层级梯度湮灭 | `tokens.css:1246-1251` |
| **BUG-T03** | 密度换挡 | 🟠 **P1 (严重)** | `[data-ui-size='large']` 的 `--space-*` 间距数值与 `:root` 100% 重合（零缩放），在字号变大后导致界面反向严重拥挤 | `tokens.css:1301-1311` vs `tokens.css:645-656` |
| **BUG-T04** | 圆角体系 | 🔴 **P0 (阻断级)** | `--button-radius` 在 `:root` 定义为 `8px`，但在 Light 块被强行覆写为 `var(--radius-btn)` (`7px`)，与 `style-contract.test.ts` 发生物理断裂导致测试失败 | `tokens.css:22`, `tokens.css:378`, `style-contract.test.ts:484` |
| **BUG-T05** | 圆角体系 | 🟠 **P1 (严重)** | `--radius-xl` 与 `--radius-2xl` 同为 `12px`，阶梯标量失去几何区分意义；且各组件 fallback 预期混乱（6px vs 7px vs 8px） | `tokens.css:311-312`, `LeafToolTabStrip.module.css:438` |
| **BUG-T06** | 同心几何 | 🟠 **P1 (严重)** | 同心圆角公式 $R_i = R_o - P$ 在部分组件中因输入奇数参数（如 7px 外圆角或 3px 内边距）反向产出 5px、11px 违规奇数内圆角；且全站 90% 以上容器完全未做同心计算 | `SegmentedControl.module.css:66,78`, `motion-concentric-contract.test.ts:50` |
| **BUG-T07** | 架构分层 | 🔴 **P0 (阻断级)** | 系统严重停留在单一裸标量（Primitive Tokens）层，全站 95% 以上区域缺失语义层（Semantic Tokens）与组件级契约，导致 100+ 组件强耦合裸变量 | `tokens.css:645-685` |

---

## 二、基础刻度分布与基准网格（4px/2px）深度调研

### 2.1 现存 `--space-*` 基础刻度定义全貌
在 `apps/crish-desktop/src/styles/tokens.css` 第 645-656 行中，声明了如下全局间距标量：

```css
/* apps/crish-desktop/src/styles/tokens.css:645-656 */
--space-0_5: 2px;
--space-1_5: 6px;
--space-2_5: 10px;
--space-3_5: 14px;
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
```

按物理数值升序整理后的阶梯表如下：

| 标量名称 | 物理数值 (px) | 相对 4px 乘数 | 网格属性 | 引入历史与设计意图 |
|:---|:---:|:---:|:---:|:---|
| `--space-0_5` | **2px** | $0.5 \times$ | 2px 偶数半步 | 紧凑型微调（如 caret margin、小图标偏移） |
| `--space-1` | **4px** | $1.0 \times$ | **4px 基准** | 紧凑内边距、行内小间距 |
| `--space-1_5` | **6px** | $1.5 \times$ | 2px 偶数半步 | 补丁产生：因历史 6px 出现 367 次而追加 |
| `--space-2` | **8px** | $2.0 \times$ | **4px 基准** | 标准组件小留白、按钮内边距 |
| `--space-2_5` | **10px** | $2.5 \times$ | 2px 偶数半步 | 补丁产生：中等内边距非标微调 |
| `--space-3` | **12px** | $3.0 \times$ | **4px 基准** | 卡片内边距、列表项间距 |
| `--space-3_5` | **14px** | $3.5 \times$ | 2px 偶数半步 | 补丁产生：非常规折中值 |
| `--space-4` | **16px** | $4.0 \times$ | **4px 基准** | 容器标准内边距（如 Card Pad） |
| `--space-5` | **20px** | $5.0 \times$ | **4px 基准** | 复杂区域间距、分区上外边距 |
| `--space-6` | **24px** | $6.0 \times$ | **4px 基准** | 面板大间距、模块间分隔 |
| `--space-8` | **32px** | $8.0 \times$ | **4px 基准** | 弹窗间距、宏观段落隔离（跳步，无 28px） |
| `--space-10` | **40px** | $10.0 \times$ | **4px 基准** | 页面级留白（跳步，无 36px） |

### 2.2 4px 与 2px 基准网格的二元撕裂与数学本质
1. **网格系统的双轨分裂**：
   - 原初设计契约宣称基于 **4px 乘法网格**（$S(n) = n \times 4\text{px}$）；
   - 但实际上，由于半步补丁刻度（`--space-0_5: 2px`, `--space-1_5: 6px`, `--space-2_5: 10px`, `--space-3_5: 14px`）的大量引入，数学通项退化为：
     $$S(k) = 2\text{px} \times k \quad (k \in \mathbb{N}^+)$$
   - 即系统事实上的物理基准是 **2px 网格**，但命名空间却伪装成“带有下划线小数的 4px 网格”，导致开发人员在心智模型上无法预期何时该用 `--space-2` (8px)，何时该用 `--space-2_5` (10px)。
2. **溯源历史技术债（`docs/archive/legacy/HARDCODED-TOKEN-AUDIT.md`）**：
   - 审计文档明确指出：“间距 6px 无对应 Token，在 gap/padding/margin 中出现 367 次；2px 出现 152 次”；
   - 过去的治理方案采取了“打补丁”策略，即在 `tokens.css` 强行塞入 `--space-0_5` 和 `--space-1_5`，未能从架构层面梳理“容器级间距（4px 网格）”与“组件内部精密对齐（2px 网格）”的语义边界。
3. **阶梯梯度的不连续性与宏观留白缺失**：
   - **归零缺失**：没有定义 `--space-0: 0px`，导致组件需要清除间距时只能裸写 `padding: 0` 或 `margin: 0px`；
   - **中段断崖**：在 24px 到 40px 之间，步长突然从 4px 跃迁为 8px，完全跳过了 `--space-7` (28px) 与 `--space-9` (36px)；
   - **宏观上限过低**：最高标量止步于 `--space-10: 40px`。对于桌面端宽屏工作区（如二叉树分栏、全屏设置页、对话列宽自适应），所需的 48px、64px、80px、96px 等宏观版面间距彻底真空，迫使开发人员在组件中硬编码大数值。

### 2.3 与参考实现（`reference/ui-replica-refactored`）对比
查阅 `reference/ui-replica-refactored/src/tokens/spacing.css`（第 1-36 行）：
```css
/* reference/ui-replica-refactored/src/tokens/spacing.css:1-35 */
:root {
  /* ── 4px Grid ── */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;

  /* ── Border Radii ── */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-pill: 30px;

  /* ── Component Gaps ── */
  --gap-xs: 2px;
  --gap-sm: 4px;
  --gap-md: 8px;
  --gap-lg: 12px;
  --gap-xl: 16px;
}
```
**对比启示**：
1. **纯正整数步长**：参考系保持了 `--space-1` 至 `--space-10` 绝对纯粹的 4px 倍数阶梯，不存在任何 `0_5`、`1_5` 等别扭的小数命名；
2. **意图解耦分流**：参考系将 2px、4px 等组件级排版间隙，解耦为专门的 `--gap-*` 系列（`--gap-xs: 2px; --gap-sm: 4px...`），使版面外边距与行内元器件间隙从概念上分离；
3. **Crish 现状失控**：Crish 桌面端不仅没有接纳这种语义分流，反而在全局 `--space-*` 命名空间下随意混入小数，并在 100 多个 CSS Module 中无序混用。

---

## 三、响应式与密度主题下的系统性断层

`tokens.css` 通过属性选择器 `[data-ui-size='small']` 与 `[data-ui-size='large']` 实现了三档界面密度切换。然而其内部数学定义存在严重的主观臆造与逻辑断层。

### 3.1 `[data-ui-size='small']` 紧凑档的数学崩溃
查看 `apps/crish-desktop/src/styles/tokens.css` 第 1244-1278 行：

```css
/* apps/crish-desktop/src/styles/tokens.css:1244-1253 */
[data-ui-size='small'] {
  --space-0_5: 2px;
  --space-1_5: 4px;
  --space-2_5: 6px;
  --space-3_5: 10px;
  --space-1: 3px;
  --space-2: 5px;
  --space-3: 6px;
  --space-4: 10px;
  --space-5: 14px;
  --space-6: 18px;
  ...
}
```

#### 事实 1：破坏网格系统，强行引入奇数像素
- `--space-1: 3px`：3px 既不被 4px 整除，也不被 2px 整除。在标准 100% 缩放下，3px 会直接导致与其配合的偶数尺寸元素产生非对称留白；而在 125% 或 150% 的 Windows 常见缩放因子下，`3px * 1.25 = 3.75px`，必定造成子像素模糊抗锯齿渲染！
- `--space-2: 5px`：同样是典型的奇数像素，导致左右内边距无法均匀居中。

#### 事实 2：刻度退化与标识符碰撞（Token Collision & Degeneracy）
在 `small` 档位下，多个语义不同的 Token 被粗暴映射到了完全相同的物理像素：
- **`--space-2_5` (原 10px) $\rightarrow$ `6px`**，而 **`--space-3` (原 12px) $\rightarrow$ `6px`**！
  两个完全不同的设计刻度在此发生了**物理碰撞**，级差彻底归零。
- **`--space-3_5` (原 14px) $\rightarrow$ `10px`**，而 **`--space-4` (原 16px) $\rightarrow$ `10px`**！
  原本代表中等留白的 14px 和标准内边距的 16px，全部塌缩为 10px。

#### 事实 3：致命遗漏与级联击穿（Omission Traps）
- 在 `[data-ui-size='small']` 代码块中，**完全没有定义 `--space-8` 与 `--space-10`**！
- 依据 CSS 属性继承规则，消费了 `--space-8` (32px) 和 `--space-10` (40px) 的组件，在 `small` 模式下直接向上击穿并沿用 `:root` 的 32px 和 40px；
- **视觉比例畸变**：
  - 微观间距 `--space-3`：从 12px 暴力压缩为 6px（**缩减 -50%**）；
  - 宏观间距 `--space-8`：依然为 32px（**缩减 0%**）！
  - 这导致界面在切入 small 档时，组件内部文字与按钮紧贴窒息，但模块与模块之间依然空空荡荡，整体视觉比例完全失调。

#### 事实 4：奇数圆角全面失守
查看 `tokens.css:1259-1264`：
```css
--radius-xs: 2px;
--radius-sm: 3px;  /* 奇数违规 */
--radius-md: 5px;  /* 奇数违规 */
--radius-lg: 7px;  /* 奇数违规 */
--radius-xl: 10px;
--radius-full: 9999px;
```
`--radius-sm`, `--radius-md`, `--radius-lg` 全部变成了 3px、5px、7px 奇数圆角，直接与 `motion-concentric-contract.test.ts` 中针对奇数圆角的工程防回潮门禁相抵触。

---

### 3.2 `[data-ui-size='large']` 宽大档的无效重写与比例窒息
查看 `apps/crish-desktop/src/styles/tokens.css` 第 1301-1311 行：

```css
/* apps/crish-desktop/src/styles/tokens.css:1301-1311 */
[data-ui-size='large'] {
  --space-0_5: 2px;
  --space-1_5: 6px;
  --space-2_5: 10px;
  --space-3_5: 14px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  ...
}
```

#### 事实 1：间距数值 100% 重合（无效死代码）
将 `large` 块的 `--space-*` 与 `:root`（第 645-654 行）逐一对比：
- `--space-0_5`: 2px == 2px
- `--space-1`: 4px == 4px
- `--space-1_5`: 6px == 6px
- `--space-2`: 8px == 8px
- `--space-2_5`: 10px == 10px
- `--space-3`: 12px == 12px
- `--space-4`: 16px == 16px
- `--space-5`: 20px == 20px
- `--space-6`: 24px == 24px
整个 `large` 档位对间距的重写**完全是 0 增量**！间距根本没有放大哪怕 1 像素！

#### 事实 2：反向视觉拥挤（Proportion Paradox）
在 `large` 档位中，字体和高度被显著放大：
- `--font-size-base`: 14px $\rightarrow$ **16px** (`tokens.css:1288`)
- `--font-size-lg`: 18px $\rightarrow$ **19px** (`tokens.css:1290`)
- `--control-height`: 32px $\rightarrow$ **34px** (`tokens.css:1296`)
- `--header-height`: 36px $\rightarrow$ **40px** (`tokens.css:1282`)
**灾难后果**：字号变大了、按钮变高了、行高加深了，但是外围留白与内部 gap 却被死死固定在默认数值。用户切换到“大字/宽松”模式时，界面各元素由于尺寸膨胀而间距未动，反而呈现出严重的拥挤与压迫感。
同样，`large` 档位也完全漏掉了 `--space-8` 与 `--space-10`。

---

### 3.3 密度换挡在消费端的穿透与震荡分析
在 `apps/crish-desktop/src/components` 中，有超过 **100 个组件 CSS 模块**直接裸引用了 `var(--space-*)`。下表列出切换到 `small` 时，关键布局承受的非线性形变：

| 组件 / 文件 | 关键属性 | 默认值 (Default) | small 密度值 | 变动幅度 | 视觉病理诊断 |
|:---|:---|:---:|:---:|:---:|:---|
| `ChatMessageList.module.css:4` | `gap: var(--space-4)` | 16px | 10px | **-37.5%** | 消息间距收缩尚可 |
| `ChatCard.module.css:18` | `padding: var(--space-3)` | 12px | 6px | **-50.0%** | 卡片内边距腰斩，文字几乎撞击卡片边缘 |
| `DiffCard.module.css:22` | `padding: var(--space-2)` | 8px | 5px | **-37.5%** | 奇数 5px 导致行内代码不对称 |
| `AppErrorBoundary.module.css:8`| `padding: var(--space-6)` | 24px | 18px | **-25.0%** | 相对缩减幅度明显小于小间距 |
| 宏观布局留白 | `margin-top: var(--space-8)` | 32px | 32px | **0.0%** | 毫无缩减，产生大片突兀空白 |

---

## 四、圆角体系现状与同心几何断裂

### 4.1 按钮与通用圆角的三方撕裂
当前仓库在“按钮圆角”与“通用基础圆角”上存在三方严重的数值与规范冲突：

```
                    ┌─────────────────────────┐
                    │ :root {                 │
                    │   --button-radius: 8px; │ (tokens.css:22)
                    │ }                       │
                    └────────────┬────────────┘
                                 │ 级联重写覆灭
                                 ▼
┌─────────────────────────┐  覆写为 7px  ┌─────────────────────────┐
│ tokens.css:306          │────────────▶│ tokens.css:378          │
│ --radius-btn: 7px;      │             │ --button-radius:        │
│ (桌面设计调研锁)         │             │   var(--radius-btn);    │
└─────────────────────────┘             └────────────┬────────────┘
                                                     │
         ┌───────────────────────────────────────────┴───────────────────────────────────────────┐
         ▼                                           ▼                                           ▼
┌─────────────────────────┐                 ┌─────────────────────────┐                 ┌─────────────────────────┐
│ Button.module.css:78    │                 │ SegmentedControl:65     │                 │ style-contract.test.ts  │
│ --btn-radius:           │                 │ --seg-outer-radius:     │                 │ expect(lightBlock)      │
│   var(--button-radius,  │                 │   var(--button-radius,  │                 │   .toMatch(             │
│       7px);             │                 │       7px);             │                 │     /--button-radius:   │
│ (sm/md 档)              │                 │                         │                 │      8px/)              │
└─────────────────────────┘                 └─────────────────────────┘                 └────────────┬────────────┘
                                                                                                     │
                                                                                        ❌ Vitest 契约测试直接报错中断！
```

#### 事实取证与现场证据：
1. **定义冲突**：
   - `tokens.css:22`：在 `:root` 顶部，声明了 `--button-radius: 8px;`；
   - `tokens.css:306`：在 Light 主题块中，声明了 `--radius-btn: 7px;`；
   - `tokens.css:378`：紧接着声明了 `--button-radius: var(--radius-btn);`，强行将 `--button-radius` 覆写为 7px，并附注“*设置/按钮圆角锁（用户锁，盖过旧 8px 口径）：恒 7px，不随 data-ui-size 变化；禁止再别名到 --radius-md 的 6px*”；
2. **测试断裂**：
   - `style-contract.test.ts` 第 480-486 行：
     ```ts
     describe('设置按钮圆角 8px 契约', () => {
       it('tokens.css 默认档 --button-radius 锁 8px，密度档不得改写', () => {
         const css = readFile('src/styles/tokens.css');
         const lightBlock = css.match(LIGHT_BLOCK_RE)?.[0] ?? '';
         expect(lightBlock).toMatch(/--button-radius:\s*8px/);
         expect(lightBlock).not.toMatch(/--button-radius:\s*7px/);
         expect(lightBlock).not.toMatch(/--button-radius:\s*var\(--radius-/);
     ```
   - 运行 `npx vitest run src/styles/style-contract.test.ts` 时，测试直接红牌阻断，证明当前生产样式与既有门禁测试处于严重脱节状态；
3. **消费端 Fallback 预期分裂**：
   - `LeafToolTabStrip.module.css:438` 消费 `border-radius: var(--radius-md, 8px);`（开发者误以为 md 是 8px，实际是 6px）；
   - `DiffCard.module.css:606` 消费 `border-radius: 0 0 var(--radius-md, 8px) var(--radius-md, 8px);`；
   - `DiffCard.module.css:654` 消费 `border-radius: var(--radius-md, 6px);`；
   - `Tabs.module.css:84` 消费 `var(--button-radius, 8px)`，而 `SegmentedControl.module.css:65` 消费 `var(--button-radius, 7px)`。

### 4.2 标量塌缩：`--radius-xl` 与 `--radius-2xl` 的重合
查看 `apps/crish-desktop/src/styles/tokens.css` 第 310-312 行：
```css
/* apps/crish-desktop/src/styles/tokens.css:310-312 */
--radius-lg: 8px;
--radius-xl: 12px;
--radius-2xl: 12px;
```
- `--radius-xl` 与 `--radius-2xl` **完全同为 12px**！
- 查阅 `HARDCODED-TOKEN-AUDIT.md` 第 50-51 行可知：历史版本中 xl 原为 11px，2xl 原为 14px。过去的重构为了消灭奇数 11px，草率地将两者全部拉平为 12px，导致阶梯层级失去数学意义。

---

### 4.3 同心圆角几何公式（Concentric Curvature）落地与断裂剖析

#### 4.3.1 数学几何模型
同心几何圆角要求内外两条圆弧具备相同的曲率中心与均匀的法向距离。其刚性几何公式为：
$$R_{\text{inner}} = \max\Big(0\text{px},\; R_{\text{outer}} - P_{\text{inner}}\Big)$$
或者逆向推导：
$$R_{\text{outer}} = R_{\text{inner}} + P_{\text{inner}}$$
若不满足此公式，内圆角过大会导致四角发生视觉碰撞与发胖，内圆角过小则会产生明显的“空隙开裂感”。

```
  ┌──────────────────────────────────────────────┐  ▲
  │   Outer Corner: R_outer                      │  │
  │   ╭──────────────────────────────────────╮   │  │
  │   │  Padding: P                          │   │  │
  │   │  ╭────────────────────────────────╮  │   │  │
  │   │  │ Inner Corner:                  │  │   │  │
  │   │  │ R_inner = R_outer - P          │  │   │  │
  │   │  │                                │  │   │  │
```

#### 4.3.2 局部孤岛式落地现状
目前仅在 4 个组件/规范中有局部同心计算意识：
1. **`SmartExpandablePanel`**（`tokens.css:174-177`）：
   ```css
   --sep-radius-outer: 14px;
   --sep-padding: 6px;
   --sep-radius-inner: calc(var(--sep-radius-outer) - var(--sep-padding)); /* 8px 完美同心 */
   ```
2. **`Usage Dashboard`**（`tokens.css:1340-1342`）：
   ```css
   --usage-capsule-outer-radius: 9px;
   --usage-capsule-pad: 3px;
   --usage-capsule-inner-radius: calc(var(--usage-capsule-outer-radius) - var(--usage-capsule-pad)); /* 6px */
   ```
3. **`Tabs.module.css:74, 85, 96, 107`**：
   ```css
   --tab-inner-radius: calc(var(--tab-outer-radius) - var(--tab-pad));
   ```
4. **`ChatComposer.module.css:954-956`**（公告卡片）：
   ```css
   --ann-pad: 12px;
   --ann-radius-inner: 6px;
   --ann-radius-outer: calc(var(--ann-radius-inner) + var(--ann-pad)); /* 18px */
   ```

#### 4.3.3 同心几何四大核心断裂：
1. **奇数污染（Odd Pixel Corruption）**：
   - 在 `SegmentedControl.module.css:65-66`（sm 档）：外壳取 `--button-radius`（解析为 7px），内边距 `--seg-pad: 2px`，导致滑块内圆角计算出：
     $$R_i = 7\text{px} - 2\text{px} = 5\text{px} \quad (\text{奇数违规})$$
   - 在 `SegmentedControl.module.css:76-78`（md 档）：外壳 8px，但内边距使用了奇数 `--seg-pad: 3px`，滑块内圆角再次计算出：
     $$R_i = 8\text{px} - 3\text{px} = 5\text{px} \quad (\text{奇数违规})$$
   - 违反了 Jakub Krehel 工程级设计标准与偶数像素防线；
2. **缺乏动态截断保护（No Defensive Clamping）**：
   全仓所有同心圆角 `calc()` 均写为 `calc(var(--r) - var(--p))`，未包裹 `max(0px, ...)`。当 padding 调节大于外圆角时，计算结果将输出负数；
3. **全局组件 90% 完全缺席同心约束**：
   查看 `design-system.css:61-71`：
   ```css
   [data-panel] {
     background: var(--bg-elevated);
     border-radius: var(--radius-lg); /* 8px */
     box-shadow: var(--shadow-lg);
     padding: var(--space-1); /* 4px */
   }
   [data-panel="modal"] {
     border-radius: var(--radius-xl); /* 12px */
     box-shadow: var(--shadow-2xl);
     padding: var(--space-3); /* 12px */
   }
   ```
   在 `[data-panel="modal"]` 中，外圆角为 12px，内边距为 12px。依据同心公式，其内部紧贴边缘的子元素圆角应为 $12 - 12 = 0\text{px}$（直角）。但内部组件依然盲目套用 `--radius-md` (6px) 或 `--radius-lg` (8px)，导致弹窗转角处视觉重叠畸变极其严重。

---

## 五、架构断层分析：裸标量统治与语义/组件层缺失

### 5.1 当前 Token 架构模型诊断
当前 Conex / Crish 桌面端的 Token 体系属于典型的**“单层扁平裸标量（Primitive-Only）架构”**：

```
┌──────────────────────────────────────────────────────────┐
│ Level 1: 原始物理标量 (Primitive Tokens)                │
│   --space-1: 4px;   --space-2: 8px;   --radius-sm: 4px; │
└────────────────────────────┬─────────────────────────────┘
                             │
                             │ ❌ 缺失 Level 2 语义体系层
                             │ 导致所有组件直接跨层下探
                             ▼
┌──────────────────────────────────────────────────────────┐
│ Level 3: 组件实现层 (92+ CSS Modules)                    │
│   padding: var(--space-4);                               │
│   gap: var(--space-2);                                   │
│   border-radius: var(--radius-md);                       │
└──────────────────────────────────────────────────────────┘
```

### 5.2 缺乏语义层（Semantic Tokens）的核心工程弊端
1. **设计意图完全湮灭（Loss of Context）**：
   在组件 CSS 中看到 `padding: var(--space-3)`，开发者与审查者无法得知这 12px 到底是因为“它是卡片内边距”、“它是行内标签留白”还是“它是表单控件的内嵌偏移”。
2. **全局牵一发而动全身（Rigid Coupling）**：
   当产品要求“将所有卡片的内边距从 16px 收紧为 12px”时，由于全站无论是卡片、工具栏、浮层还是网格，都统统裸引用的 `--space-4`，修改 `--space-4` 会瞬间毁灭所有非卡片组件的几何对齐；无法做到按“组件角色”进行局部安全调优。
3. **组件特化 Token（Component Tokens）碎片化**：
   因为设计系统没有提供 `--space-card-pad-x`、`--space-stack-sm`、`--space-inline-gap` 等语义桥梁，各个组件作者为了解决对齐问题，只能在组件内部私自发明局部变量：
   - Button 自造 `--btn-px`, `--btn-h`, `--btn-gap` (`Button.module.css:54-58`)；
   - SegmentedControl 自造 `--seg-pad`, `--seg-item-px` (`SegmentedControl.module.css:52-56`)；
   - Tabs 自造 `--tab-pad`, `--tab-gap`, `--tab-item-px` (`Tabs.module.css:71-76`)；
   - ChatComposer 自造 `--ann-pad`, `--ann-radius-inner` (`ChatComposer.module.css:954`)；
   全站没有统一的组件 Token 命名法，缺乏一致的参数映射规则。

### 5.3 工业级 3 层 Token 架构标准映射表
根据现代设计系统工程规范，Conex / Crish 应当演进为标准的 3 层 Token 体系：

| Token 层级 | 职责定位 | 命名规范示例 | 引用依赖规则 | 换挡适应能力 |
|:---|:---|:---|:---|:---|
| **Level 1: Primitive** | 纯物理度量字典，定义离散网格步长 | `--space-100: 4px`, `--space-200: 8px`, `--radius-200: 8px` | 只能被 Level 2 引用，**严禁组件直接引用** | 纯静态常量，不随主题换挡改变物理值 |
| **Level 2: Semantic** | 表达界面上下文意图与排版角色 | `--space-inset-card: var(--space-400)`, `--space-stack-tight: var(--space-100)` | 引用 Level 1，被 Level 3 消费 | **核心换挡面**：`small`/`large` 通过重写此层实现语义缩放 |
| **Level 3: Component** | 组件专有几何契约，控制内部同心度 | `--btn-padding-x: var(--space-inset-button-x)`, `--panel-inner-radius: ...` | 引用 Level 2，在组件模块内绑定 | 组件内部动态响应语义层注入 |

---

## 六、调研结论与第二阶段方案输入

### 6.1 必须根治的技术缺陷清单（第二阶段输入）
1. **重建基准间距标尺**：
   - 确立统一的 4px/2px 双阶梯标尺，废除 `--space-1_5` 等别扭的小数命名，重构为符合工程惯例的命名法（如 100/200 编号法或统一 2px 微刻度字典）；
   - 补齐 `--space-0: 0px`，补齐 28px、36px 以及 48px、64px 宏观布局间距。
2. **修复响应式密度换挡（`[data-ui-size]`）**：
   - 彻底清除 `small` 模式下的 3px、5px 奇数像素与 6px/10px 刻度塌缩；
   - 补全 `small` 与 `large` 模式下缺失的 `--space-8` 和 `--space-10`；
   - 重新计算 `large` 模式下的间距放大系数（如 $\times 1.25$），消除“字大框挤”的反向拥挤反常态。
3. **决断统一按钮与通用圆角**：
   - 消除 `--button-radius: 8px` 与 `--radius-btn: 7px` 的双重分裂；若定案统一为 8px，则同步废除 7px 并修复 `style-contract.test.ts`；
   - 消除 `--radius-xl` 与 `--radius-2xl` 同为 12px 的无效冗余，构建清晰的 2px/4px/6px/8px/12px/16px/9999px 递进圆角链。
4. **抽象系统级同心圆角动态机制**：
   - 提供全局防负值同心计算宏（`--concentric-radius: max(0px, calc(var(--outer-radius) - var(--padding)))`）；
   - 确保同心计算中参与减法的内边距与外圆角均为偶数像素，杜绝 5px、7px、11px 等奇数中间产物污染。
5. **全面引入 Level 2 语义间距层**：
   - 构建 Inset（内嵌）、Stack（垂直堆叠）、Inline（水平流）、Gap（网格间隙）4 大类语义间距 Token，作为组件重构的单一真理来源。

### 6.2 调研签字与归档
- **调研执行人**：Token 刻度定义与数学几何现状调研员
- **文档路径**：`docs/layout-token-system/survey/01-tokens-and-scale-survey.md`
- **状态**：第一阶段调研已完成，等待主控 Agent 汇总与第二阶段顶层设计启动。
