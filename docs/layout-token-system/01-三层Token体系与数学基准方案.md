> **【v2 废止声明】** 施工以 `00-总方案.md`（2026-09-11 v2）为唯一 SSOT。本文与 v2 冲突的矩阵/圆角/BATCH/修复手段一律作废，仅保留诊断取证价值。

# 三层 Token 体系与数学基准重塑方案

> **战役工作区**：`docs/layout-token-system/`
> **方案文档**：`docs/layout-token-system/01-三层Token体系与数学基准方案.md`
> **方案角色**：三层 Token 体系与数学基准重塑方案设计专家
> **输入依据**：
> - `docs/layout-token-system/survey/01-tokens-and-scale-survey.md`（442 行刻度与数学几何现状调研）
> - `docs/layout-token-system/survey/08-ui-primitives-and-contracts-survey.md`（724 行原子组件库与样式门禁契约调研）
> - `apps/crish-desktop/src/styles/tokens.css`（全局设计令牌定义）
> - `apps/crish-desktop/src/styles/design-system.css`（设计系统基座与工具层）
> - `apps/crish-desktop/src/styles/style-contract.test.ts`、`motion-concentric-contract.test.ts`（既有样式契约测试）
> **日期**：2026-09-11

---

## 一、方案背景与架构演进目标

### 1.1 现状病理综述与重塑迫切性
在 Conex / Crish 桌面端第一阶段的全景调研中，样式与排版系统暴露出了深度结构性技术债务。现存系统属于典型的**“单层扁平裸标量（Primitive-Only）架构”**，并在数学几何与跨层消费上产生了一系列系统性断层：

1. **基准网格双轨撕裂与别扭命名**：
   - 官方宣称为 4px 乘数网格，但由于历史 6px（出现 367 次）、2px（出现 152 次）技术债，强行以补丁形式引入了 `--space-0_5: 2px`、`--space-1_5: 6px`、`--space-2_5: 10px`、`--space-3_5: 14px`；
   - 实际物理网格已退化为 2px 标尺，但在命名空间上伪装成“带小数下划线的 4px 网格”，导致开发心智混乱；且缺少 `--space-0: 0px` 及 28px、36px、48px、64px 等宏观版面间距。
2. **响应式密度换挡（Density Gears）数学崩溃**：
   - **`[data-ui-size='small']` 紧凑档**：强行引入 `--space-1: 3px` 与 `--space-2: 5px` 奇数像素，破坏偶数网格，在 Windows 125%/150% 缩放下诱发亚像素渲染模糊；发生严重的刻度塌缩碰撞（`--space-2_5` 与 `--space-3` 同为 6px，`--space-3_5` 与 `--space-4` 同为 10px）；且致命遗漏 `--space-8` 与 `--space-10`，导致微观挤压 -50% 而宏观留白 0% 缩减的视觉畸变。
   - **`[data-ui-size='large']` 宽大档**：间距定义与 `:root` 100% 相同（零缩放），但在字体（16px）、按钮（34px）、标题栏（40px）显著放大后，外围留白原地不动，呈现出严重的“大字挤框”反向窒息感。
3. **圆角几何三方撕裂与同心断裂**：
   - `--button-radius` 在 `:root` 顶层定义为 8px，但在 Light 块被强行覆写为 `var(--radius-btn)` (7px)，与 `style-contract.test.ts` 发生物理断裂；
   - `--radius-xl` 与 `--radius-2xl` 同为 12px，阶梯标量失去几何区分意义；
   - 同心圆角公式 $R_{inner} = \max(0, R_{outer} - Padding)$ 在 90% 以上容器中缺席；局部落地中因奇数参数（7px 外圆角或 3px 内边距）反向算出 5px、11px 等违规奇数内圆角。
4. **全仓 Fallback 漂移与代偿性负外边距**：
   - 针对同一 `--space-2`，全仓存在 `var(--space-2, 8px)`、`var(--space-2, 6px)`、`var(--space-2, 5px)` 与裸引用的严重分裂；
   - 开发者误以为写 `var(--space-2, 6px)` 能得到 6px，但在运行时被 `:root` 的 8px 强制覆盖，屏幕呈现过大间距后，诱发了在子元素上加 `margin-top: -2px` 或 `-46px` / `-38px` 极端负 margin 的恶性循环。
5. **既有样式契约回潮**：
   - 实测 `style-contract.test.ts` 存在 5 项断言失败（dark 块漏 `--ui-text-danger`、裸混色翻倍至 53 处、themeStore 动态注入 4 个幽灵 Token、按钮圆角 8px 契约撕裂）。

### 1.2 重塑核心工程原则
本方案严格遵循仓库铁律与工业级工程设计标准（Jakub Krehel 7 大工程级设计标准 + Apple 物理流体几何体系）：
- **效果锁与纯逻辑**：禁止以降级、砍功能解决对齐问题；所有尺度均需满足严格数学公理与立体化断言；
- **2px/4px 偶数绝对防线**：全体系消除 3px、5px、7px 等奇数像素与亚像素，确保高分屏缩放无模糊；
- **单一真理来源（SSOT）**：物理度量归物理层，语义角色归语义层，组件契约归组件层，禁止跨层裸引用；
- **防御性几何与同心闭环**：所有嵌套几何必须保证外内圆角与内衬的同心自洽，杜绝负值溢出；
- **渐进式棘轮基线（Ratchet Baseline）**：平滑迁移，存量锁定，增量拦截，实现架构净收敛。

---

## 二、三层 Token 架构模型（3-Tier Architecture）详案

为彻底终结 100+ 组件强耦合裸标量的混乱现状，建立清晰的 3 层 Token 架构模型：

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 1: Primitive Tokens (基础物理标尺层 - 纯静态离散网格字典)            │
│  --space-100: 4px;   --space-200: 8px;   --radius-200: 8px;            │
│  (权威数学常数，不随主题换挡改写物理值；仅供 Tier 2 消费，严禁组件直引)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 声明式语义绑定 (Semantic Binding)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 2: Semantic Layout Tokens (布局语义令牌层 - 界面排版意图核心)      │
│  --space-inset-card: var(--space-400);   --space-stack-tight: ...;     │
│  (分型划分 Inset / Stack / Inline / Gap；响应式密度齿轮换挡的主承载面)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 组件级抽象注入 (Component Injection)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 3: Component Surface Tokens (组件专有局部契约层 - 封闭黑盒契约)    │
│  --btn-px: var(--space-inset-button-x);   --dialog-pad: ...;           │
│  (组件内部私有变量，通过 CSS Props 或 Slots 暴露，彻底杜绝 :global 穿透) │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Tier 1: Primitive Tokens（基础物理标尺）

#### 2.1.1 偶数离散标尺数学公理
Tier 1 确立以 **4px 为主步长、2px 为微调半步** 的严格偶数离散数学标尺：
$$\mathcal{S}_{\text{primitive}} = \{ 0 \} \cup \{ 2n \mid n \in \mathbb{N}^+, 2n \le 64 \}$$
- **绝对偶数防线**：$\forall x \in \mathcal{S}_{\text{primitive}}, x \pmod 2 = 0$。严禁 1px（除 border 发丝白名单外）、3px、5px、7px 等奇数像素进入基础字典。
- **高分屏渲染无损性**：在 Windows 125%（$\times 1.25$）、150%（$\times 1.5$）与 200%（$\times 2.0$）标准缩放下，偶数像素经线性缩放后的物理设备像素为整数或半整数，有效杜绝文字与边框的模糊抗锯齿。

#### 2.1.2 标尺字典与命名规范
为兼顾现代化设计系统标准与既有代码平滑过渡，采用**“数值点数命名为主、历史别名安全映射为辅”**的双轨策略：
- **新规标准名**：采用行业标准的三位数字权重系统 `--space-50` 到 `--space-1600`，同时规范化 `--space-0` 到 `--space-16` 整数标尺；
- **废除小数命名**：禁止新增 `--space-0_5`、`--space-1_5` 等小数变量；对存量别名在 `:root` 提供兼容别名映射，引导向语义层迁移。

| 物理标量 (px) | 标准 Token 标识符 | 乘数逻辑 | 历史别名兼容映射 (Deprecating) | 典型应用场景与意图 |
|:---:|:---|:---:|:---|:---|
| **0px** | `--space-0` | $0 \times$ | (新增) | 显式重置间距、归零内边距 |
| **2px** | `--space-50` / `--space-0-5` | $0.5 \times 4\text{px}$ | `--space-0_5` | 边框发丝微距、caret 偏移、同心紧密内衬 |
| **4px** | `--space-100` / `--space-1` | $1.0 \times 4\text{px}$ | `--space-1` | 紧凑型内边距、图标与文字间距 |
| **6px** | `--space-150` / `--space-1-5` | $1.5 \times 4\text{px}$ | `--space-1_5` | 紧凑按钮横向留白、小标签内衬 |
| **8px** | `--space-200` / `--space-2` | $2.0 \times 4\text{px}$ | `--space-2` | 标准组件间隙、列表条目纵向 padding |
| **10px** | `--space-250` / `--space-2-5` | $2.5 \times 4\text{px}$ | `--space-2_5` | 中等内衬微调、输入框与按钮横向内缩 |
| **12px** | `--space-300` / `--space-3` | $3.0 \times 4\text{px}$ | `--space-3` | 紧凑卡片内衬、操作条间距、抽屉小留白 |
| **14px** | `--space-350` / `--space-3-5` | $3.5 \times 4\text{px}$ | `--space-3_5` | 折中过渡留白、展开面板外圆角配额 |
| **16px** | `--space-400` / `--space-4` | $4.0 \times 4\text{px}$ | `--space-4` | 标准容器/卡片核心 Padding（Card Inset） |
| **20px** | `--space-500` / `--space-5` | $5.0 \times 4\text{px}$ | `--space-5` | 复杂板块间距、分区顶部外边距 |
| **24px** | `--space-600` / `--space-6` | $6.0 \times 4\text{px}$ | `--space-6` | 面板大间距、对话消息流段落隔离 |
| **28px** | `--space-700` / `--space-7` | $7.0 \times 4\text{px}$ | (补齐中段断崖) | 侧栏模块间距、工作区工具条间隔 |
| **32px** | `--space-800` / `--space-8` | $8.0 \times 4\text{px}$ | `--space-8` | 弹窗视口边距、模态面板外边距 |
| **36px** | `--space-900` / `--space-9` | $9.0 \times 4\text{px}$ | (补齐中段断崖) | 宽屏次级模块隔离 |
| **40px** | `--space-1000` / `--space-10`| $10.0 \times 4\text{px}$| `--space-10` | 页面级留白、全局主容器内衬 |
| **48px** | `--space-1200` / `--space-12`| $12.0 \times 4\text{px}$| (补齐宏观留白) | 宽屏欢迎页留白、空态容器间距 |
| **64px** | `--space-1600` / `--space-16`| $16.0 \times 4\text{px}$| (补齐宏观留白) | 桌面端主视口极大留白、分栏大隔离 |

---

### 2.2 Tier 2: Semantic Layout Tokens（布局语义令牌层）

布局语义层是**架构解耦与密度换挡的核心承载面**。禁止组件直接依赖 Tier 1 裸标量，必须通过具有排版意图的语义 Token 消费。我们将布局语义体系分型建立四大正交家族：

```
                              Tier 2 布局语义分类体系
         ┌───────────────────┬───────────────────┬───────────────────┐
         ▼                   ▼                   ▼                   ▼
  1. Inset 容器内衬    2. Stack 垂直堆叠    3. Inline 水平流    4. Gap 网格间距
   (内边距 Padding)    (纵向排版 Flow Y)   (横向排列 Flow X)   (Grid/Flex 间隙)
```

#### 2.2.1 Inset 容器内衬语义族（`--space-inset-*`）
专门服务于容器元素的 `padding` 属性，表达由外向内的空间包围感：
- `--space-inset-none: var(--space-0);`（0px）
- `--space-inset-2xs: var(--space-50);`（2px，用于分段控制器/Tab 滑块外壳内衬）
- `--space-inset-xs: var(--space-100);`（4px，用于浮动菜单内部边距、小徽标内衬）
- `--space-inset-sm: var(--space-150);`（6px，用于 SmartExpandablePanel 外壳、紧凑卡片）
- `--space-inset-md: var(--space-200);`（8px，用于列表条目、状态面板内边距）
- `--space-inset-card: var(--space-300);`（12px，用于通用对话气泡、消息卡片、信息区块）
- `--space-inset-lg: var(--space-400);`（16px，用于独立弹窗 Dialog、主工作区卡片）
- `--space-inset-xl: var(--space-600);`（24px，用于设置面板外层容器、模态框主内衬）
- `--space-inset-page: var(--space-1000);`（40px，用于全屏空态页、关于页面级主留白）
- **非对称内衬组合宏**：
  - `--space-inset-control-sm: 0 var(--space-250);`（0 10px，sm 级输入框/按钮内衬）
  - `--space-inset-control-md: 0 var(--space-300);`（0 12px，标准输入框/按钮内衬）
  - `--space-inset-control-lg: 0 var(--space-400);`（0 16px，大型操作按钮内衬）
  - `--space-inset-dialog-header: var(--space-400) var(--space-400) var(--space-200);`（16px 16px 8px）
  - `--space-inset-dialog-footer: var(--space-300) var(--space-400);`（12px 16px）

#### 2.2.2 Stack 垂直堆叠语义族（`--space-stack-*`）
专门服务于垂直流布局中的元素纵向间隔（`margin-bottom` 或 `flex-direction: column; gap: ...`）：
- `--space-stack-hairline: var(--space-50);`（2px，菜单条目之间的极窄微距）
- `--space-stack-tight: var(--space-100);`（4px，标题与描述文案之间、小列表项间距）
- `--space-stack-compact: var(--space-150);`（6px，卡片头部与内容区、表单 Label 与 Input 间距）
- `--space-stack-md: var(--space-200);`（8px，标准段落间距、设置项条目纵向堆叠）
- `--space-stack-loose: var(--space-300);`（12px，卡片与卡片之间、列表分块）
- `--space-stack-section: var(--space-400);`（16px，消息流单次回合之间的间隔）
- `--space-stack-group: var(--space-600);`（24px，大型设置表单区块分割）

#### 2.2.3 Inline 水平流语义族（`--space-inline-*`）
专门服务于水平流布局中的元素横向间隔（`margin-right` 或 `flex-direction: row; gap: ...`）：
- `--space-inline-hairline: var(--space-50);`（2px，状态圆点与文字微距）
- `--space-inline-tight: var(--space-100);`（4px，图标与前缀文字、快捷键徽标排列）
- `--space-inline-compact: var(--space-150);`（6px，按钮内部图标与标签的标准间隙）
- `--space-inline-md: var(--space-200);`（8px，水平操作按钮组、Tab 标签页横向间距）
- `--space-inline-loose: var(--space-300);`（12px，分栏工具条之间的区域间距）
- `--space-inline-group: var(--space-400);`（16px，左右固定操作栏与搜索框的横向隔离）

#### 2.2.4 Gap 网格间距语义族（`--space-gap-*`）
专门服务于 Flexbox 与 CSS Grid 的通用双向间隙，对齐现代 CSS 排版规范：
- `--space-gap-2xs: var(--space-50);`（2px）
- `--space-gap-xs: var(--space-100);`（4px）
- `--space-gap-sm: var(--space-150);`（6px）
- `--space-gap-md: var(--space-200);`（8px）
- `--space-gap-lg: var(--space-300);`（12px）
- `--space-gap-xl: var(--space-400);`（16px）
- `--space-gap-2xl: var(--space-600);`（24px）

---

### 2.3 Tier 3: Component Surface Tokens（组件专有局部契约）

#### 2.3.1 组件契约封装三铁律
1. **内部黑盒化**：每个 UI 组件（如 `Button`, `Dialog`, `Menu`）在自身的 `:root` 或根类选择器上声明内部私有变量（如 `--btn-h`, `--btn-px`, `--dialog-pad`），其真值直接绑定 Tier 2 语义 Token；
2. **禁止裸标量下探**：组件私有变量**严禁直接引用 Tier 1 裸标量**（如禁止 `--btn-px: var(--space-3)`，必须书写 `--btn-px: var(--space-inset-control-md)`）；
3. **彻底切除 `:global` 穿透**：外部父组件需定制子组件排版时，仅允许通过覆盖组件暴露的 CSS Props 或通过 React API 传入属性，严禁在 `.module.css` 中书写 `:global(button)`、`:global(.input-container)`。

#### 2.3.2 核心原子组件契约示范
```css
/* ==========================================================================
   Button 组件契约 (apps/crish-desktop/src/components/ui/Button/Button.module.css)
   ========================================================================== */
.button {
  /* 绑定 Tier 2 语义 Token */
  --btn-h-xs: var(--control-height-xs, 24px);
  --btn-h-sm: var(--control-height-sm, 28px);
  --btn-h-md: var(--control-height, 32px);
  --btn-h-lg: var(--control-height-lg, 40px);

  --btn-px-xs: var(--space-inline-compact, 6px);
  --btn-px-sm: var(--space-inset-sm, 10px);
  --btn-px-md: var(--space-inset-card, 12px);
  --btn-px-lg: var(--space-inset-lg, 16px);

  --btn-gap: var(--space-inline-compact, 6px);
  --btn-radius: var(--button-radius, 8px); /* 锁定 8px，与契约测试对齐 */

  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--btn-h, var(--btn-h-md));
  padding: 0 var(--btn-px, var(--btn-px-md));
  gap: var(--btn-gap);
  border-radius: var(--btn-radius);
}

/* ==========================================================================
   Dialog 组件契约 (apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css)
   ========================================================================== */
.dialogContent {
  --dialog-pad-header: var(--space-inset-dialog-header);
  --dialog-pad-body: var(--space-100) var(--space-400);
  --dialog-pad-footer: var(--space-inset-dialog-footer);
  --dialog-gap-actions: var(--space-inline-md);
  --dialog-radius: var(--radius-xl, 16px);
}
```

---

## 三、密度齿轮矩阵（Density Gears Matrix）数学重构

### 3.1 现存密度换挡数学缺陷根治
第一阶段调研揭示的 `[data-ui-size]` 缺陷是本次重塑的核心靶标：
- **消灭 BUG-T01（奇数像素污染）**：彻底拔除 `small` 档位中的 3px、5px，所有紧凑尺寸强制对齐 2px/4px/6px 等偶数标尺；
- **消灭 BUG-T02（刻度塌缩湮灭）**：恢复小齿轮下的严格偏序单调性，确保 $\forall a < b \implies \text{Scale}_{\text{compact}}(a) < \text{Scale}_{\text{compact}}(b)$；
- **消灭 BUG-T03（宽大档零缩放与反向窒息）**：为 `large` 档位引入正向等比间距放大，使留白随字体与控件同步伸展；
- **补全级联击穿遗漏**：全面补齐 `small` 与 `large` 块中缺失的 `--space-8`、`--space-10`、`--space-12`，彻底解决宏观布局比例畸变。

### 3.2 齿轮缩放数学通项公式与网格整数约束
为了使换挡具备高度的数理自洽性，定义界面密度映射函数 $\mathcal{M}(S, D)$，其中 $S \in \mathcal{S}_{\text{primitive}}$ 为默认物理像素，$D \in \{ \text{Compact}, \text{Default}, \text{Comfortable} \}$ 为密度档位：

#### 1. 紧凑档（Compact / `[data-ui-size='small']`）数学模型
采用**“高密收紧、偶数向下量化”**法则：
$$S_{\text{compact}} = \max\left(2\text{px},\; 2 \times \left\lfloor \frac{S_{\text{default}} \times 0.75 + 0.5}{2} \right\rfloor \text{px}\right)$$
- 微观间距（2px ~ 8px）采用阶梯收敛，保持 2px 整数倍；
- 宏观间距保持 75% 比例收缩，并强制向最近偶数舍入；
- 阶梯严格保序：$0 < 2 \le 4 < 6 < 8 < 10 < 12 < 16 < 20 < 24 < 30 \text{px}$，彻底消除原 6px/6px 与 10px/10px 的碰撞！

#### 2. 宽大档（Comfortable / `[data-ui-size='large']`）数学模型
采用**“空间舒展、偶数向上量化”**法则：
$$S_{\text{comfortable}} = 2 \times \left\lceil \frac{S_{\text{default}} \times 1.25 - 0.5}{2} \right\rceil \text{px}$$
- 配合大字号（Base: 16px, LG: 19px）与大按钮（Height: 40px），整体间距放大 1.25 倍；
- 所有计算值严格保证 $\pmod 2 = 0$，杜绝模糊，释放舒适的呼吸感。

---

### 3.3 Default / Compact / Comfortable 三档密度矩阵全景对照表

下表为重塑后的权威三档密度全景对照表，此表作为 `tokens.css` 声明的唯一真理来源：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Conex / Crish 权威三档密度齿轮矩阵 (SSOT)                        │
├────────────────────┬──────────────┬──────────────┬──────────────┬──────────────────────┤
│ 标量/语义 Token     │ Default (默认)│ Compact (紧凑)│Comfortable(大)│ 缩放性质与抗塌缩断言   │
├────────────────────┼──────────────┼──────────────┼──────────────┼──────────────────────┤
│ 基础字号 (Base)     │ 14px         │ 13px         │ 16px         │ 字体层次递进         │
│ 控件高度 (Control)  │ 32px         │ 28px         │ 36px         │ 保证标准操作热区     │
│ 控件高度-SM        │ 28px         │ 24px         │ 32px         │ 紧凑组件对齐         │
│ 控件高度-XS        │ 24px         │ 20px         │ 28px         │ 极小图符按钮         │
│ 控件高度-LG        │ 40px         │ 36px         │ 44px         │ 统一全站大控件       │
├────────────────────┼──────────────┼──────────────┼──────────────┼──────────────────────┤
│ --space-0          │ 0px          │ 0px          │ 0px          │ 恒零保持             │
│ --space-50 (0_5)   │ 2px          │ 2px          │ 2px          │ 最小微距基线         │
│ --space-100 (1)    │ 4px          │ 2px (非3px!) │ 6px (非4px!) │ 偶数防线！消除奇数3px │
│ --space-150 (1_5)  │ 6px          │ 4px          │ 8px          │ 平滑递进             │
│ --space-200 (2)    │ 8px          │ 6px (非5px!) │ 10px         │ 偶数防线！消除奇数5px │
│ --space-250 (2_5)  │ 10px         │ 8px          │ 12px         │ 独占8px，消除6px碰撞 │
│ --space-300 (3)    │ 12px         │ 10px         │ 16px         │ 独占10px，消除6px碰撞│
│ --space-350 (3_5)  │ 14px         │ 12px         │ 18px         │ 独占12px，消10px碰撞 │
│ --space-400 (4)    │ 16px         │ 12px         │ 20px         │ 标准容器内衬         │
│ --space-500 (5)    │ 20px         │ 16px         │ 24px         │ 模块中留白           │
│ --space-600 (6)    │ 24px         │ 18px         │ 30px         │ 面板级隔离           │
│ --space-700 (7)    │ 28px         │ 22px         │ 36px         │ 补齐中段留白         │
│ --space-800 (8)    │ 32px         │ 24px (补齐!) │ 40px (补齐!) │ 解决原版遗漏与击穿！ │
│ --space-1000 (10)  │ 40px         │ 30px (补齐!) │ 50px (补齐!) │ 解决原版遗漏与击穿！ │
│ --space-1200 (12)  │ 48px         │ 36px (补齐!) │ 60px (补齐!) │ 宽屏留白             │
│ --space-1600 (16)  │ 64px         │ 48px (补齐!) │ 80px (补齐!) │ 视口留白             │
├────────────────────┼──────────────┼──────────────┼──────────────┼──────────────────────┤
│ --radius-xs        │ 2px          │ 2px          │ 2px          │ 微圆角               │
│ --radius-sm        │ 4px          │ 4px (非3px!) │ 6px (非5px!) │ 偶数防线！消除奇数3/5│
│ --radius-md        │ 6px          │ 6px (非5px!) │ 8px (非7px!) │ 偶数防线！消除奇数5/7│
│ --radius-lg        │ 8px          │ 8px (非7px!) │ 10px         │ 偶数防线！消除奇数7px│
│ --radius-xl        │ 12px         │ 10px         │ 14px         │ 恢复 XL 阶梯         │
│ --radius-2xl       │ 16px (非12px)│ 12px         │ 20px         │ 彻底消灭 12px 塌缩！ │
│ --button-radius    │ 8px          │ 8px (不变!)  │ 8px (不变!)  │ 契约锁定！不随档改写 │
└────────────────────┴──────────────┴──────────────┴──────────────┴──────────────────────┘
```

---

## 四、圆角几何体系与同心圆角法则（Concentric Radii Formula）

### 4.1 按钮圆角基准决断与全仓统一

#### 4.1.1 决断证据与契约裁决
针对当前仓库中 `--button-radius: 8px`、`--radius-btn: 7px`、`--radius-md: 6px` 的三方撕裂，本方案作出**终局裁决**：
1. **全站按钮圆角法定基准锁定为 `8px`**：
   - `apps/crish-desktop/src/styles/style-contract.test.ts` 第 480-495 行明确建立了刚性门禁，要求 `:root` 与 Light 块必须声明 `--button-radius: 8px;`，严禁改写为 7px 或变量引用；
   - 7px 为奇数像素，违反 Jakub Krehel 工程级设计标准及偶数像素防线；且在 125% 缩放下产生 $7 \times 1.25 = 8.75\text{px}$ 亚像素虚边；
   - 统一 8px 完美契合 4px 网格倍数，与 `--radius-lg: 8px` 形成统一的高频物理常量。
2. **彻底废除 `tokens.css:378` 的覆写**：
   - 物理删除 `tokens.css:378` 中的 `--button-radius: var(--radius-btn);`；
   - 将 `--radius-btn` 标记为废弃别名并指向 8px（`--radius-btn: 8px;`）；
   - 修复 `Button.module.css` 中的 fallback，统一对齐为 `var(--button-radius, 8px)`。

---

### 4.2 全局圆角阶梯重构与阶梯塌缩消除

#### 4.2.1 修复 `--radius-xl` 与 `--radius-2xl` 的 12px 塌缩
原版中 `--radius-xl: 12px; --radius-2xl: 12px;` 导致两个层级失去了几何区分能力。现建立单调递增偶数圆角链：
$$\mathcal{R} = \{ 2\text{px}, 4\text{px}, 6\text{px}, 8\text{px}, 12\text{px}, 16\text{px}, 9999\text{px} \}$$
- `--radius-xs: 2px;`（微型标签、极小按键）
- `--radius-sm: 4px;`（Kbd 徽标、小工具提示）
- `--radius-md: 6px;`（输入框、次级卡片）
- `--radius-lg: 8px;`（标准按钮、独立操作卡片、通用面板）
- `--radius-xl: 12px;`（大型下拉面板、侧栏卡片、复合工具浮层）
- **`--radius-2xl: 16px;`**（**彻底纠正为 16px**，用于主模态窗口 Modal、核心主弹窗 Dialog）
- `--radius-full: 9999px;`（胶囊按钮、头像圆形遮罩）

---

### 4.3 嵌套同心圆角刚性数学公式与 Token 计算宏

#### 4.3.1 几何模型与偶数封闭性定理
同心几何要求内圆角与外圆角具有相同的几何曲率中心，法向等距。其刚性约束方程为：
$$R_{\text{inner}} = \max\Big(0\text{px},\; R_{\text{outer}} - P_{\text{inset}}\Big)$$

```
  ┌────────────────────────────────────────────────────────┐  ▲
  │   外层容器: R_outer                                     │  │
  │   ╭────────────────────────────────────────────────╮   │  │
  │   │  内衬留白: Padding = P                          │   │  │
  │   │  ╭──────────────────────────────────────────╮  │   │  │
  │   │  │ 内层子元素:                               │  │   │  │
  │   │  │ R_inner = max(0px, R_outer - P)          │  │   │  │
  │   │  │                                          │  │   │  │
```

**偶数封闭性定理（Even-Parity Closure Theorem）**：
为了保证计算出的 $R_{\text{inner}}$ 始终为偶数且不产生亚像素畸变，**输入的外圆角 $R_{\text{outer}}$ 与内边距 $P_{\text{inset}}$ 必须全部属于偶数整数集合**：
$$\text{若 } R_{\text{outer}} \equiv 0 \pmod 2 \ \text{ 且 } \ P_{\text{inset}} \equiv 0 \pmod 2 \implies R_{\text{inner}} \equiv 0 \pmod 2$$
过去在 `SegmentedControl` 中出现 5px 违规内圆角，正是因为输入了奇数 $7\text{px} - 2\text{px} = 5\text{px}$ 或 $8\text{px} - 3\text{px} = 5\text{px}$。本方案通过全仓清洗输入源，保证计算结果天然封闭在偶数空间。

#### 4.3.2 CSS 原生动态防御性同心宏
在样式层提供标准化 CSS `calc()` 模板与安全截断保护：
```css
/* 标准同心推导宏（防御负值溢出与直角反向凸起） */
--concentric-inner-radius: max(0px, calc(var(--concentric-outer-radius) - var(--concentric-pad)));
```

---

### 4.4 核心容器同心圆角工程落地示范

#### 1. SegmentedControl（分段控制器）
- **外框外圆角**：`--seg-outer-radius: var(--button-radius, 8px);`（8px）
- **轨道内衬**：`--seg-pad: var(--space-50, 2px);`（**彻底纠正 md/lg 档的 3px 奇数为 2px！**）
- **滑块内圆角**：
  $$R_{\text{slider}} = \max(0\text{px}, 8\text{px} - 2\text{px}) = 6\text{px} \quad (\text{完美偶数同心！})$$
- 彻底消灭原代码中 $7-2=5\text{px}$ 与 $8-3=5\text{px}$ 的违规产物。

#### 2. Dialog / Modal（弹窗模态基座）
- **模态外壳**：`border-radius: var(--radius-2xl, 16px);`
- **外围内衬**：`padding: var(--space-400, 16px);`
- **内部直贴边缘子区域**（如吸底动作条或高亮代码块）：
  $$R_{\text{inner}} = \max(0\text{px}, 16\text{px} - 16\text{px}) = 0\text{px} \quad (\text{完美直角贴合，杜绝转角视觉缝隙})$$
- **内部浮动卡片**（若内衬为 12px）：
  $$R_{\text{card}} = \max(0\text{px}, 16\text{px} - 12\text{px}) = 4\text{px} \quad (\text{对应 --radius-sm})$$

#### 3. Menu 浮层（右键菜单与下拉）
- **浮层外壳**：`border-radius: var(--radius-xl, 12px);`
- **浮层内衬**：`padding: var(--space-100, 4px);`（替代原死代码裸 6px）
- **条目内圆角**：
  $$R_{\text{item}} = \max(0\text{px}, 12\text{px} - 4\text{px}) = 8\text{px} \quad (\text{对应 --radius-lg，完美同心！})$$

#### 4. SmartExpandablePanel（智能展开面板）
- **面板外壳**：`--sep-radius-outer: var(--radius-2xl, 16px);`（由原 14px 规范化为 16px）
- **面板内衬**：`--sep-padding: var(--space-200, 8px);`
- **内部容器**：
  $$R_{\text{inner}} = \max(0\text{px}, 16\text{px} - 8\text{px}) = 8\text{px} \quad (\text{完美同心！})$$

---

## 五、与原子组件库及主题系统的桥接规范

### 5.1 `tokens.css` 核心声明块重构草案

以下为 `apps/crish-desktop/src/styles/tokens.css` 对应区域的就地重构工程草案：

```css
/* ==========================================================================
   1. :root 全局基础物理标尺与默认布局语义 (Tier 1 & Tier 2 Default)
   ========================================================================== */
:root {
  /* --- 响应式断点与基础控件尺寸矩阵 (4 档标准高度 SSOT) --- */
  --control-height-xs: 24px;
  --control-height-sm: 28px;
  --control-height: 32px;
  --control-height-lg: 40px; /* 彻底纠偏 36px/38px 离散值，锁定 40px */

  /* --- Tier 1: Primitive Spacing Tokens (纯静态离散物理字典，禁止组件直引) --- */
  --space-0: 0px;
  --space-50: 2px;
  --space-100: 4px;
  --space-150: 6px;
  --space-200: 8px;
  --space-250: 10px;
  --space-300: 12px;
  --space-350: 14px;
  --space-400: 16px;
  --space-500: 20px;
  --space-600: 24px;
  --space-700: 28px;
  --space-800: 32px;
  --space-900: 36px;
  --space-1000: 40px;
  --space-1200: 48px;
  --space-1600: 64px;

  /* 存量旧变量别名兼容网 (向后兼容 100+ 组件，逐步引导收敛) */
  --space-0_5: var(--space-50);
  --space-1: var(--space-100);
  --space-1_5: var(--space-150);
  --space-2: var(--space-200);
  --space-2_5: var(--space-250);
  --space-3: var(--space-300);
  --space-3_5: var(--space-350);
  --space-4: var(--space-400);
  --space-5: var(--space-500);
  --space-6: var(--space-600);
  --space-8: var(--space-800);
  --space-10: var(--space-1000);

  /* --- Tier 2: Semantic Layout Tokens (组件消费单一真源) --- */
  /* Inset 容器内衬 */
  --space-inset-none: var(--space-0);
  --space-inset-2xs: var(--space-50);
  --space-inset-xs: var(--space-100);
  --space-inset-sm: var(--space-150);
  --space-inset-md: var(--space-200);
  --space-inset-card: var(--space-300);
  --space-inset-lg: var(--space-400);
  --space-inset-xl: var(--space-600);
  --space-inset-page: var(--space-1000);

  /* Inset 非对称常用组合 */
  --space-inset-control-xs: 0 var(--space-150);
  --space-inset-control-sm: 0 var(--space-250);
  --space-inset-control-md: 0 var(--space-300);
  --space-inset-control-lg: 0 var(--space-400);
  --space-inset-dialog-header: var(--space-400) var(--space-400) var(--space-200);
  --space-inset-dialog-footer: var(--space-300) var(--space-400);

  /* Stack 垂直堆叠 */
  --space-stack-hairline: var(--space-50);
  --space-stack-tight: var(--space-100);
  --space-stack-compact: var(--space-150);
  --space-stack-md: var(--space-200);
  --space-stack-loose: var(--space-300);
  --space-stack-section: var(--space-400);
  --space-stack-group: var(--space-600);

  /* Inline 水平流 */
  --space-inline-hairline: var(--space-50);
  --space-inline-tight: var(--space-100);
  --space-inline-compact: var(--space-150);
  --space-inline-md: var(--space-200);
  --space-inline-loose: var(--space-300);
  --space-inline-group: var(--space-400);

  /* Gap 网格间距 */
  --space-gap-2xs: var(--space-50);
  --space-gap-xs: var(--space-100);
  --space-gap-sm: var(--space-150);
  --space-gap-md: var(--space-200);
  --space-gap-lg: var(--space-300);
  --space-gap-xl: var(--space-400);
  --space-gap-2xl: var(--space-600);

  /* --- 几何圆角系统 (偶数递进链与 8px 按钮契约锁) --- */
  --button-radius: 8px; /* 权威单一真源，全站法定 8px，严禁改写！ */
  --radius-btn: var(--button-radius); /* 纠正旧 7px 历史债务 */
  --radius-xs: 2px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-2xl: 16px; /* 彻底修复 12px 塌缩问题 */
  --radius-full: 9999px;

  /* 同心圆角基准变量 */
  --seg-outer-radius: var(--button-radius, 8px);
  --seg-pad: var(--space-50, 2px);
  --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 严格 6px 偶数同心 */

  /* 补齐 themeStore 动态注入所需的 4 个静态幽灵 Token，根治契约失败 */
  --accent-green-light-adaptive: #10b981;
  --accent-red-light-adaptive: #ef4444;
  --bg-paper: var(--surface-paper, #fdfdfc);
  --shell-inset-bg: var(--surface-chrome, #f5f5f4);
}

/* ==========================================================================
   2. 主题色彩层与暗色契约修复 (Dark Mode Block)
   ========================================================================== */
html[data-theme='dark'] {
  /* 补齐暗色模式缺失的 --ui-text-danger，修复 style-contract.test.ts 失败 */
  --ui-text-danger: #f87171;
  --ui-text-danger-hover: #fca5a5;
  --ui-text-danger-subtle: rgba(248, 113, 113, 0.15);

  --accent-green-light-adaptive: #34d399;
  --accent-red-light-adaptive: #f87171;
  --bg-paper: var(--surface-paper);
  --shell-inset-bg: var(--surface-chrome);
}

/* ==========================================================================
   3. [data-ui-size='small'] Compact 紧凑密度齿轮 (纯偶数、单调无碰撞)
   ========================================================================== */
[data-ui-size='small'] {
  --control-height-xs: 20px;
  --control-height-sm: 24px;
  --control-height: 28px;
  --control-height-lg: 36px;

  /* Tier 1 物理刻度紧凑量化（彻底拔除 3px/5px 奇数与塌缩） */
  --space-0: 0px;
  --space-50: 2px;
  --space-100: 2px; /* 4px -> 2px (偶数防线) */
  --space-150: 4px; /* 6px -> 4px */
  --space-200: 6px; /* 8px -> 6px (非5px!) */
  --space-250: 8px; /* 10px -> 8px (独占8px，杜绝与3档塌缩) */
  --space-300: 10px; /* 12px -> 10px */
  --space-350: 12px; /* 14px -> 12px */
  --space-400: 12px; /* 16px -> 12px */
  --space-500: 16px; /* 20px -> 16px */
  --space-600: 18px; /* 24px -> 18px */
  --space-700: 22px; /* 28px -> 22px */
  --space-800: 24px; /* 补齐原版遗漏！32px -> 24px */
  --space-1000: 30px; /* 补齐原版遗漏！40px -> 30px */
  --space-1200: 36px; /* 48px -> 36px */
  --space-1600: 48px; /* 64px -> 48px */

  /* 紧凑圆角阶梯（保持偶数） */
  --radius-xs: 2px;
  --radius-sm: 4px; /* 纠正原 3px 奇数违规 */
  --radius-md: 6px; /* 纠正原 5px 奇数违规 */
  --radius-lg: 8px; /* 纠正原 7px 奇数违规 */
  --radius-xl: 10px;
  --radius-2xl: 12px;
}

/* ==========================================================================
   4. [data-ui-size='large'] Comfortable 宽大舒展密度齿轮 (正向等比伸展)
   ========================================================================== */
[data-ui-size='large'] {
  --control-height-xs: 28px;
  --control-height-sm: 32px;
  --control-height: 36px;
  --control-height-lg: 44px;

  /* Tier 1 物理刻度舒适放大 1.25x（偶数量化，消灭反向拥挤） */
  --space-0: 0px;
  --space-50: 2px;
  --space-100: 6px;  /* 4px -> 6px */
  --space-150: 8px;  /* 6px -> 8px */
  --space-200: 10px; /* 8px -> 10px */
  --space-250: 12px; /* 10px -> 12px */
  --space-300: 16px; /* 12px -> 16px */
  --space-350: 18px; /* 14px -> 18px */
  --space-400: 20px; /* 16px -> 20px */
  --space-500: 24px; /* 20px -> 24px */
  --space-600: 30px; /* 24px -> 30px */
  --space-700: 36px; /* 28px -> 36px */
  --space-800: 40px; /* 补齐原版遗漏！32px -> 40px */
  --space-1000: 50px; /* 补齐原版遗漏！40px -> 50px */
  --space-1200: 60px; /* 48px -> 60px */
  --space-1600: 80px; /* 64px -> 80px */

  /* 宽大圆角阶梯（偶数保序） */
  --radius-xs: 2px;
  --radius-sm: 6px;  /* 纠正原 5px 奇数违规 */
  --radius-md: 8px;  /* 纠正原 7px 奇数违规 */
  --radius-lg: 10px; /* 纠正原 9px 奇数违规 */
  --radius-xl: 14px;
  --radius-2xl: 20px;
}
```

---

### 5.2 全仓 Fallback 单源（SSOT）对齐与纯净化策略

#### 5.2.1 Fallback 混乱的破坏机理与治理决断
调研查明，全仓大面积的 `var(--space-2, 6px)` 与 `var(--space-2, 5px)` 属于**“虚假的安全感、真实的恶性循环”**：
- 浏览器在 `:root` 存在时**绝不执行 fallback**，组件实际按照 8px 渲染；
- 开发者误以为已设置为 6px，屏幕视觉多出 2px，诱发了代偿性负外边距（如 `margin-top: -2px`）；
- 本方案制定两阶段去 Fallback 与单源对齐策略：

```
【第一阶段：静态 SSOT 强制对齐 (Transitional SSOT Align)】
  - 所有仍带 fallback 的 var(--space-N, val)，val 必须 100% 严格等于 :root 定义！
  - 例：var(--space-2, 8px) 合法；var(--space-2, 6px) 与 var(--space-2, 5px) 视作致命语法错误刚性拦截！
        │
        ▼
【第二阶段：全仓 AST 自动化去 Fallback 纯净化 (Zero-Fallback Pure State)】
  - Conex 桌面端为本地独立打包应用，tokens.css 全局静态内联打包，不存在网络分包丢样式的 Web 缺陷；
  - 运行 AST 自动重写脚本，全局收敛为无 fallback 的纯净语义引用：
    var(--space-2, 8px)  ──▶  var(--space-stack-md) 或 var(--space-2)
  - 彻底减轻打包体积、消除认知负荷。
```

---

## 六、迁移实施步骤与风险自愈机制

### 6.1 四阶段渐进式落地路径（BATCH-01 ~ BATCH-04）

遵循仓库《多 Agent 协作指令》与反退避原则，重塑工作拆解为 4 个清晰批次，串行演进：

```
┌────────────────────────────────────────────────────────────────────────┐
│ BATCH-01: 核心基座重塑与契约红转绿 (Foundational Tokens & Test Fixes)   │
│  1. 重构 tokens.css：注入 Tier 1/2/3 字典、三档密度矩阵、统一 8px 圆角 │
│  2. 修复 style-contract.test.ts 既有 5 项失败，门禁全绿通过            │
│  3. 补齐 themeStore 幽灵 Token 静态注册，消除控制台未定义警告          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ BATCH-02: UI 原子组件库率先同心化与尺寸收敛 (UI Primitives Pure Tier)   │
│  1. 统一 Button/Input/Select/Tabs/SegmentedControl 的 lg 高度为 40px   │
│  2. 重构 SegmentedControl 轨道 padding 为 2px，滑块严格 6px 同心       │
│  3. 清理 Menu.module.css 与 Dialog.module.css 中的裸像素与奇数内衬      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ BATCH-03: 负 Margin 拔除与穿透选择器解耦 (Layout Hygiene & Anti-Chum)   │
│  1. 彻底拔除 ChatScrollFloorSlot(-46px) 与 UnitChromeActions(-38px)    │
│  2. 将负 margin 改写为 position: absolute + height: 0 原生几何模型     │
│  3. 切除 ComposerFusedTrigger 与 Settings 的 24 处 :global 穿透选择器  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ BATCH-04: 全仓 Fallback 清洗与守门门禁上线 (SSOT Sweep & Gate Locks)    │
│  1. 运行自动化 AST 脚本，将全仓错位 fallback 纠正或彻底去 fallback 化  │
│  2. 上线 scripts/check-layout-tokens.mjs 拦截裸像素与非法负外边距     │
│  3. 契约测试接入 CI 快层与 pre-commit，实现永久防回潮                   │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 6.2 自动化守门体系规划（双层防护网）

为确保新方案落地后不再被日常迭代蚕食回潮，建立「CI 快层静态脚本 + Vitest 契约测试」双层防护网：

```
┌────────────────────────────────────────────────────────────────────────┐
│                   双层自动化守门流水线 (Two-Tier Guard)                 │
├────────────────────────────────────────────────────────────────────────┤
│ 快层：scripts/check-layout-tokens.mjs (< 500ms，Git Pre-commit 强制阻断)│
│  ├─ 规则 1 [裸像素拦截]：禁止 margin/padding/gap 中出现裸像素 (除0/1/2px)│
│  ├─ 规则 2 [非法负边距]：禁止绝对值 > 2px 的负外边距 (如 -38px 强行阻断)│
│  ├─ 规则 3 [跨层穿透拦截]：禁止 module.css 中使用 :global(button) 穿透 │
│  └─ 规则 4 [Fallback 校验]：所有 var(--space-N, val) 的 val 必须与 SSOT一致│
├────────────────────────────────────────────────────────────────────────┤
│ 中层：apps/crish-desktop/src/styles/layout-contract.test.ts (Vitest 门禁)│
│  ├─ 断言 1：tokens.css 三档密度齿轮保序性与偶数封闭性验证              │
│  ├─ 断言 2：全原子组件高度矩阵 [24, 28, 32, 40] 物理恒等验证          │
│  └─ 断言 3：同心圆角容器 R_inner == R_outer - P 物理断言               │
└────────────────────────────────────────────────────────────────────────┘
```

#### 6.2.1 裸像素与负 Margin 检查脚本核心逻辑伪代码
```javascript
// scripts/check-layout-tokens.mjs 核心检测规则
const SPACING_PROPS = /^(margin|padding|gap|row-gap|column-gap)(-(top|bottom|left|right|inline|block))?$/;
const BARE_PIXEL_RE = /(?<!var\([^)]*)\b([3-9]|\d{2,})px\b/;
const ILLEGAL_NEGATIVE_MARGIN = /margin(-(top|bottom|left|right))?\s*:\s*-(?:[3-9]|\d{2,})px/;
const GLOBAL_PENETRATION = /:global\s*\(\s*(button|input|\.[\w-]+)\s*\)/;

export function auditStyleLine(file, line, lineNum) {
  // 1. 拦截非法大尺寸负 Margin
  if (ILLEGAL_NEGATIVE_MARGIN.test(line)) {
    throw new Error(`[Negative Margin Guard] ${file}:${lineNum} 存在非法负外边距！禁止使用负边距代偿，必须改用原生布局或定位。`);
  }
  // 2. 拦截跨层穿透
  if (file.endsWith('.module.css') && GLOBAL_PENETRATION.test(line)) {
    throw new Error(`[Anti-Penetration Guard] ${file}:${lineNum} 存在 :global 穿透选择器！禁止穿透子组件内部，改用 CSS Props 或 API 插槽。`);
  }
}
```

---

### 6.3 风险自愈与回滚预案

| 潜在风险点 | 影响面 | 根因预判 | 自愈与兜底机制 |
|:---|:---|:---|:---|
| **小组件排版错位** | 局部 UI 按钮偏位 | 纠偏 38px 为 40px 或修改 3px 为 2px 时微调丢失 | 原子层提供 `--control-height-adjust: 0px` 微调插槽，仅在特定复杂场景下局部微调，不破坏全局契约。 |
| **存量样式构建中断** | CI 或样式编译报错 | 废除旧 Token 变量引发 `undefined variable` 警告 | 保留 Tier 1 别名层（`--space-1`, `--space-1_5` 等）至少 2 个版本周期，确保零语法破损。 |
| **第三方库样式冲突** | Markdown 渲染或图表 | 全局 `:root` 变量渗透入内嵌渲染引擎 | 建立 `.md-content-scope` 独立隔离命名空间，避免全局 Token 意外重写第三方插件内部样式。 |

---

## 七、方案总结与实施验收断言

本方案彻底厘清并解决了 Conex / Crish 桌面端长期积累的 Token 刻度分裂、密度换挡塌缩与同心几何断裂顽疾：
1. **数学基准严密闭环**：确立 4px/2px 纯偶数网格公理，根除所有 3px/5px 奇数与亚像素，高分屏缩放绝对清晰；
2. **三层体系权威确立**：Tier 1 纯静态物理常数、Tier 2 四大排版语义族、Tier 3 组件私有契约，实现工程级彻底解耦；
3. **响应式密度齿轮修复**：Compact 档消除刻度塌缩与奇数污染，Comfortable 档实现正向 1.25x 等比舒展，全档补齐宏观间距；
4. **同心几何刚性守门**：按钮基准锁定 8px，消除 12px 标量塌缩，同心公式原生包裹 `max(0px, ...)` 防溢出，输入输出严格偶数封闭；
5. **门禁与测试协同**：提供了就地可执行的 `tokens.css` 重构草案，并给出了既有契约测试的修复方案与双层自动化守护流水线，为后续批次的代码落地构筑了坚不可摧的工程基石。
