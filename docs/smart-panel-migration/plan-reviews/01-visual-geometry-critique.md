# Conex / Crish — SmartExpandablePanel 视觉几何与色彩空间极度严苛审查报告

> **文档标识**：`docs/smart-panel-migration/plan-reviews/01-visual-geometry-critique.md`
> **审查对象**：
> - `docs/smart-panel-migration/00-total-migration-plan.md`
> - `docs/smart-panel-migration/independent-plans/01-foundation-adapters-plan.md`
> - `docs/smart-panel-migration/independent-plans/02-composer-chat-plan.md`
> - `docs/smart-panel-migration/independent-plans/03-headers-workspace-plan.md`
> - `docs/smart-panel-migration/independent-plans/04-settings-forms-plan.md`
> - `docs/smart-panel-migration/independent-plans/05-sidebar-files-diff-plan.md`
> **审查角色**：视觉对齐、几何同心与色彩空间审查专家（Visual & Curvature Devil Reviewer）
> **审查原则**：【零赞美、零肯定、100% 直击问题、缺陷、遗漏、模糊描述与潜在漏洞】

---

## 审查执行摘要

经过对总方案及 5 份独立实施方案的逐行穿透审查，现有方案虽然提出了组件下沉与样式统一的设想，但在**同心圆角几何公式、色彩空间与 Hover 污染防御、发丝边框与双层阴影重叠、窄屏布局弹性公差、滚动条与空态高度解算、以及跨方案 API 契约一致性**上存在大量自相矛盾、参数打架、自我违反铁律与工程实现漏洞。

以下所有条目均为**硬性缺陷（Blocking Defects）**与**潜在隐患（Potential Flaws）**，必须在正式编码实施前全量纠偏。

---

## 一、圆角同心数学漏洞（Concentric Curvature Mathematical Flaws）

### 1.1 嵌套同心公式跨方案矛盾（Clamp 下限不一致）
- **缺陷位置**：
  - `00-total-migration-plan.md:270` 声明公式：$R_{\text{inner}} = \max(R_{\text{outer}} - P, 4\text{px})$
  - `01-foundation-adapters-plan.md:131` 声明公式：$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 6\text{px})$
- **破坏性分析**：
  两份核心基座方案在同心圆角下限阈值上直接打架（4px vs 6px）。当二级子菜单或紧凑卡片采用 $R_{\text{outer}} = 8\text{px}, P = 4\text{px}$ 时：
  * 按 00 方案：$R_{\text{inner}} = 8 - 4 = 4\text{px}$（满足同心几何）；
  * 按 01 方案：$R_{\text{inner}} = \max(4\text{px}, 6\text{px}) = 6\text{px}$。
  一旦内层被错误强制放大至 6px，内层条目的弧度半径大于外层曲率边界（$6\text{px} > 4\text{px}$），导致内层圆角向外顶出，在四个角产生严重的视觉变形与边缘被截断现象。

### 1.2 权限模式面板（PermissionModeMenu）同心几何自相矛盾
- **缺陷位置**：
  - `00-total-migration-plan.md:803-804`
  - `02-composer-chat-plan.md:58, 76, 243, 374, 470`
- **破坏性分析**：
  方案在同一小节中一边宣称「外层容器锁定为 14px 外角 / 6px 内边距 / 8px 内层」，另一边却在代码实现（`.permMenuItem`）中强行硬编码 `border-radius: var(--radius-md, 6px);` 或在文案中写「条目锁定为 6px」。
  数学验算：外层 $14\text{px}$，内边距 $6\text{px}$，内层必须为 $14 - 6 = 8\text{px}$。若条目设置为 $6\text{px}$，内层条目与外壳之间会产生 $2\text{px}$ 的曲率离心空隙，导致面板四个角落的悬停高亮块与外框曲率断层脱节。

### 1.3 项目选择器二级子菜单（ProjectPickerMenu Submenu）离心透穿漏洞
- **缺陷位置**：
  - `03-headers-workspace-plan.md:145-147, 168-174`
- **破坏性分析**：
  方案为二级子菜单规划的参数为：外层圆角 $8\text{px}$（`--sep-submenu-radius: 8px`）、内边距 $4\text{px}$（`padding: 4px`）、内层条目圆角 $6\text{px}$（`--sep-item-radius: 6px`）。
  数学验算：$R_{\text{inner}} = R_{\text{outer}} - P = 8\text{px} - 4\text{px} = 4\text{px}$。方案硬编码内层条目为 $6\text{px}$，导致 $R_{\text{inner}} (6\text{px}) > 4\text{px}$，条目的圆角曲率直接顶穿了外层 8px/4px 几何边界，在子菜单四角产生丑陋的曲率反差。

### 1.4 主输入卡片（ChatComposer Card）22px 随意魔术数字
- **缺陷位置**：
  - `02-composer-chat-plan.md:47`
- **破坏性分析**：
  方案在架构图与文字中写道：`Layer 4: 主输入网格 (Card with 1px Hairline Border, R=22px)`。全局 Token 体系中仅定义了 14px、8px、6px、4px 以及 9999px（Pill），22px 属于未经任何同心推导的随意硬编码魔术数字，与外层容器内边距完全脱节。

---

## 二、色彩空间与 Hover 污染漏洞（Color Space & Theme Pollution Flaws）

### 2.1 自我推翻与公然违反「严禁消费 `--sidebar-hover`」铁律
- **缺陷位置**：
  - `00-total-migration-plan.md:280-285`（立下铁律）vs `803, 863, 878`（公然违规）
  - `02-composer-chat-plan.md:75, 246, 296, 302, 346, 352`
- **破坏性分析**：
  总方案在 §4.3 极其严肃地确立了「【强制红线铁律】：严禁在白底浮层中直接消费 `--sidebar-hover` / `--sidebar-active`」，并明确指出在「冰川薄荷」「抹茶拿铁」皮肤下这会导致 20%~30% 的深青灰泥色块污染。
  然而在后续章节以及 02 独立方案中，多处代码依然堂而皇之地写出：
  ```css
  /* 02-composer-chat-plan.md:296, 346 */
  .plusBtn:hover { background: var(--sidebar-hover); }
  .permPill.iconOnly:hover { background: var(--sidebar-hover); }
  ```
  输入卡片底色为纯白 `#ffffff`，用户悬停在加号或盾牌按钮上时，立刻触发大块青绿杂色背景，与白底形成刺眼的脏色斑块，彻底击穿了设计系统的纯净度防线。

### 2.2 翡翠绿品牌对勾（Accent Color）Token 严重混杂与硬编码
- **缺陷位置**：
  - `00-total-migration-plan.md:206, 287, 803, 1045`
  - `01-foundation-adapters-plan.md:194, 231`
  - `02-composer-chat-plan.md:502, 530`
  - `04-settings-forms-plan.md:72, 78, 366, 370`
- **破坏性分析**：
  方案在各个文档中肆意混用至少 5 种不同的绿色表达：
  1. `00-total:206` 定义 `--sep-accent-color: #10b981;`（Emerald 500）；
  2. `00-total:287` 写死 `#059669`（Emerald 600）；
  3. `01-foundation:194` 写 `hsl(160 84% 39%)`（浅色）与 `hsl(160 84% 45%)`（深色）；
  4. `02-composer:502` 写 `color: var(--brand-deep, #059669);`；
  5. `04-settings:366` 在 CSS 中直接写死 `color: #059669;`。
  全局没有收敛为单一的 Design Token 变量（如 `--sep-accent-check`），多处散落硬编码 Hex。一旦开启高对比度模式或无障碍主题，这些硬编码的颜色无法响应式切换。

### 2.3 CSS Modules 中滥用透明通道硬编码值（Token 逃逸）
- **缺陷位置**：
  - `04-settings-forms-plan.md:139, 213, 316, 347, 414, 449, 544`
- **破坏性分析**：
  04 方案在各个组件的 CSS Modules 文件中，到处散落硬编码的 `rgba(29, 28, 26, 0.045)`、`rgba(29, 28, 26, 0.065)`、`rgba(245, 244, 240, 0.06)`、`rgba(245, 244, 240, 0.09)`，而没有引用 `--sep-bg-item-hover` / `--sep-bg-item-selected` CSS 变量。
  这是严重的**样式硬编码逃逸**，如果未来微调悬停透明度（如从 4.5% 调至 5%），必须手动修改十几个 CSS 文件，极易产生视觉不一致。

### 2.4 违反 `AGENTS.md` §14 现代色彩语法（散落旧式 RGBA）
- **缺陷位置**：
  - 全仓所有 6 份方案中的 Token 定义与 CSS 规则。
- **破坏性分析**：
  `AGENTS.md` §14 明确要求：「UI 与 Design Token 优先 `hsl(h s l / a)` 或 `hsla(...)`，用斜杠 `/` 分隔不透明度，避免散落旧式 `rgba(r,g,b,a)`」。
  但方案通篇大面积使用 `rgba(29, 28, 26, 0.045)` 与 `rgba(255, 254, 252, 0.96)`，完全未落实斜杠透明度与 OKLCH 回退标准。

---

## 三、描边、阴影与边框残留（Borders, Shadows & Stroke Residuals）

### 3.1 1px 实体发丝边框与 `inset` 内发光在 WebView2 下的双层重影 Bug
- **缺陷位置**：
  - `01-foundation-adapters-plan.md:200-203, 234-237`
- **破坏性分析**：
  方案在 `--sep-shadow` 中定义了：
  ```css
  --sep-shadow: 0 20px 48px -10px rgba(29, 28, 26, 0.09), ...,
                inset 0 1px 0 rgba(255, 255, 255, 0.95);
  ```
  在 Windows WebView2（Chromium 内核）的高 DPI 缩放（125%、150%）渲染环境下，面板容器本身已经带有 `border: 1px solid var(--sep-border-color)`。当 `border` 与 `inset 0 1px 0 white` 叠加时，由于亚像素取整（Subpixel Rounding），面板顶部边缘会出现 **2px 的重叠发虚白边或白色锯齿光晕**，在深色模式下（`inset 0 1px 0 rgba(255, 255, 255, 0.08)`）尤其明显。必须彻底移除内部 `inset` 伪描边，保持单一实体 1px 发丝边框。

### 3.2 搜索栏底部分割线与组件内部 Divider 折叠导致的 2px 粗黑线
- **缺陷位置**：
  - `01-foundation-adapters-plan.md:1243-1250`
  - `03-headers-workspace-plan.md:96`
  - `04-settings-forms-plan.md:274`
- **破坏性分析**：
  03 与 04 方案在搜索框底部声明了 `border-bottom: 1px solid var(--sep-divider-color)`，而 01 方案在主面板内部紧接着渲染 `<div className={styles.divider} />`（带 `border-top: 1px solid var(--sep-divider-color)`）。
  当搜索框下方紧跟带分割线的选项组时，两者在 DOM 中相邻，上下两条 1px 发丝边框直接粘合在一起，渲染成一条刺眼的 **2px 粗分割线**！方案中缺少任何 CSS 兄弟选择器（如 `.searchWrapper + .divider { display: none; }`）或结构层面的去重保护。

---

## 四、文字挤压截断与布局公差（Text Truncation & Layout Tolerance Flaws）

### 4.1 权限模式面板（PermissionModeMenu）英文与高缩放下的截断灾难
- **缺陷位置**：
  - `02-composer-chat-plan.md:458, 521-526`
- **破坏性分析**：
  `.permMenu` 宽度被限制在 `max-width: 280px; min-width: 230px;`，而次级描述文案设置了 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`。
  公差计算：
  - 条目左侧图标（22px）+ 间距（8px）+ 右侧对勾（14px）+ 左右内边距（16px）= **60px 固定占用**；
  - 在 230px 容器下，文本列仅剩 $230 - 60 = 170\text{px}$；
  - 文案如 `改文件、执行前需手动批准`（13 字，约 143px），在系统字体字偶距略宽、Windows 125% 缩放或英文本地化字符串（如 "Ask before executing commands"）下，宽度立刻超过 170px，次级描述被瞬间截断为 `改文件、执行前需手…`，彻底丧失了辅助说明的意义！方案未提供弹性自适应宽度计算或允许次级文案平滑换行的机制。

### 4.2 状态诊断页（StatusDiagnosticsPanel）CSS Grid 窄屏崩塌 Bug
- **缺陷位置**：
  - `00-total-migration-plan.md:904`（声明为 `140px 160px 1fr`）
  - `04-settings-forms-plan.md:685`（声明为 `72px 150px 1fr`）
- **破坏性分析**：
  1. **跨方案参数严重脱节**：00 方案要求级别列 140px、时间列 160px；04 方案要求级别列 72px、时间列 150px。
  2. **窄屏致命崩塌**：按 04 方案的 `72px 150px 1fr` 计算，固定列宽 + `gap: 12px` (24px) + `padding: 10px` (20px) = **266px 最小硬性宽度**。当设置窗口在分屏或小窗口模式下（宽度约 300px~320px）时，第 3 列 `1fr` 的实际可用宽度仅剩 $320 - 266 = 54\text{px}$！日志详情内容被挤成 54px 的小缝隙，文字被省略号吃得只剩 2-3 个字母，根本无法阅读；若按 00 方案的 140px 宽度，在 320px 下甚至直接触发横向溢出破框！

### 4.3 规则设置页（SettingsRulesTab）头部同行排布的溢出断层
- **缺陷位置**：
  - `04-settings-forms-plan.md:586, 597`
- **破坏性分析**：
  方案将右上角的 `[ 全局 ▾ ]` Select 与 `[ 编辑全文 ]` Button 强行绑定在 `display: flex; flex-direction: row; gap: 8px; align-items: center;` 中，且未设置 `flex-wrap`。
  `Select` 控件最小宽度为 160px，`编辑全文` 按钮宽度约 80px，右侧操作区共计占用约 250px。卡片左侧标题「短规则列表」占用约 90px。在窄屏卡片（宽 < 350px）时，左右两块在同一行直接发生物理碰撞挤压，导致选择框被压扁或按钮被顶出卡片外，方案缺少基于 Container Query 的断点换行防御。

---

## 五、滚动条与空态高度漏洞（Scrollbars & Empty State Height Bugs）

### 5.1 1 项条目时的 120px 死白空洞（与宣称的「自适应贴合」直接矛盾）
- **缺陷位置**：
  - `00-total-migration-plan.md:414`
  - `01-foundation-adapters-plan.md:536`
  - `04-settings-forms-plan.md:385`
- **破坏性分析**：
  00 与 04 方案反复强调「根除 1 项条目时的死白空间，自适应高度自然贴合」。
  但在 00 与 01 方案的核心定位引擎 `PositionEngine.ts` 中，代码写着：
  ```typescript
  if (naturalHeight > availableVerticalSpace) {
    allowedListHeight = Math.max(120, availableVerticalSpace - headerHeight - 16);
  }
  ```
  以及如果调用方没有处理好自然高度，在只有 1 个条目（高度 28px）且外部容器被赋予了默认高度时，列表容器将被错误撑开至 120px，下方留出长达 **92px 的死白空洞**！`PositionEngine` 内部没有针对条目数量（$\le 2$ 项）的硬性紧凑贴合约束。

### 5.2 WebView2 下 `handleWheel` 滚轮隔离使用 `stopPropagation` 的无效假实现
- **缺陷位置**：
  - `00-total-migration-plan.md:549`（使用 `e.preventDefault()`）
  - `01-foundation-adapters-plan.md:1588-1600`（使用 `e.stopPropagation()`）
- **破坏性分析**：
  两份方案在核心交互上再次出现严重代码分歧：
  * 00 方案采用 `e.preventDefault()`；
  * 01 方案的 `SmartExpandablePanel.tsx` 实际代码中却写成了 `e.stopPropagation()`。
  **严重缺陷**：在浏览器与 Windows WebView2 事件模型中，React 的合成事件 `e.stopPropagation()` 仅阻止 React 树内部冒泡，**根本无法阻止原生视口滚轮滚动**！当用户在内嵌模型列表中滚到尽头时，外部宿主页面依然会发生剧烈抖动与跳动。必须在原生 DOM 节点上使用 `{ passive: false }` 监听器并调用 `e.preventDefault()` 才能实现真正的滚轮穿透隔离！01 方案的代码完全是无效的伪隔离。

### 5.3 动态测量高度触发强制同步重排（Layout Thrashing）
- **缺陷位置**：
  - `01-foundation-adapters-plan.md:458-477`（`measureNaturalHeight`）
- **破坏性分析**：
  `PositionEngine.ts` 在解算位置时，执行了以下操作：
  ```typescript
  listEl.style.maxHeight = 'none';
  listEl.style.overflow = 'visible';
  const listScrollHeight = listEl.scrollHeight; // 触发 Force Reflow!
  listEl.style.maxHeight = prevMaxHeight;
  listEl.style.overflow = prevOverflow;
  ```
  在 120Hz 实时跟随（窗口缩放或滚动）过程中，每次触发定位都会修改 DOM 样式并立即读取 `scrollHeight`，造成严重的**布局抖动（Layout Thrashing）与丢帧**。应当使用纯数学高度预估（`itemCount * 28px + padding + gap`）或 `ResizeObserver` 异步批处理缓存，严禁在渲染热路径上同步读写 DOM 样式。

### 5.4 Windows 11 Overlay 滚动条与 3px 发丝滚动条不可点击
- **缺陷位置**：
  - `01-foundation-adapters-plan.md:1160-1175`
  - `04-settings-forms-plan.md:508-518`
- **破坏性分析**：
  方案通过 `::-webkit-scrollbar { width: 3px; }` 定义发丝滚动条。在 Windows 桌面端 WebView2 中：
  1. 3px 的滑块物理宽度过窄，用户鼠标极难精准命中与拖拽（Hit Target 严重不合格，违反无障碍可用性准则）；
  2. 方案未声明现代标准 CSS 属性 `scrollbar-width: thin; scrollbar-color: ...`；
  3. 未对 Windows 11 系统的「流线型自动隐藏滚动条」做覆盖适配，极易在不同 Windows 版本下出现样式被系统覆盖或滑块闪烁消失的问题。

---

## 六、跨方案数据契约与 Props 接口脱节硬伤（Cross-Plan Contract Discrepancies）

各独立方案与基座方案之间存在严重的 **API 接口与类型定义漂移**，如果直接进入开发，TypeScript 编译阶段就会全面报错：

| 冲突项 | `01-foundation` 核心基座定义 | 业务独立方案中的错误消费方式 | 严重级别与后果 |
| :--- | :--- | :--- | :--- |
| **`MenuItem.trailingAction`** | `types.ts` 中**未定义**此字段 | `03-headers:318, 731` 直接传入 `trailingAction: <Tooltip>...` | **阻断**：TS 报类型不存在，自定义删除按钮无法渲染 |
| **`MenuItem.badgeClassName`** | `types.ts` 中**未定义**此字段 | `03-headers:726` 传入 `badgeClassName: styles.badgeRunning` | **阻断**：TS 报错，子代理运行状态脉冲高亮类名丢失 |
| **`MenuItem` 与 `MenuGroup` 混乱嵌套** | `MenuGroup` 包含 `items: MenuItem[]`，`MenuItem` 不应内嵌 `items` | `03-headers:342` 将 `{ type: 'group', items: [...] }` 塞入 `MenuItem[]` | **阻断**：数据树扁平化与渲染器遍历逻辑崩溃 |
| **`SmartPanelProps.trigger`** | 仅定义 `triggerRef?: RefObject<HTMLElement>` | `03-headers:399, 584, 752` 直接传入 `trigger={children}` (JSX) | **阻断**：组件无法接收 JSX 形式的 trigger，锚点定位失效 |
| **`SmartPanelProps.position`** | 仅由内部 `PositionEngine` 自动解算 | `03-headers:403, 586, 754` 传入 `position={{ side: 'bottom', align: 'center' }}` | **阻断**：Props 无法透传，弹出方向约束失效 |
| **`SmartPanelProps.headerSlot`** | 仅定义 `header?: ReactNode` | `05-sidebar:637` 传入 `headerSlot={headerSlot}` | **阻断**：属性名打架，快捷设置外观分段器丢失 |
| **`SmartPanelProps.panelRef`** | `types.ts` 中**未定义**此字段 | `05-sidebar:236, 445` 传入 `panelRef={activeMenuRef}` | **阻断**：LayerStack 互斥层注册无法获取真实 DOM 引用 |

---

## 七、问题汇总与强制整改矩阵

为确保 SmartExpandablePanel 移植达到工业级架构水准，必须在实施前执行以下整改断言：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        视觉与几何整改核验红线（Mandatory Checklist）                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [ ] 1. 统一同心公式：全仓严格锁定 R_inner = max(R_outer - Padding, 0px) 与 14-6=8px 契约  │
│ [ ] 2. 根除离心硬编码：彻底消灭 14px 容器内部写死 6px 条目圆角的错误代码（统一为 8px）      │
│ [ ] 3. 彻底绝迹青底：输入区加号、盾牌、设置页按钮严禁引用 --sidebar-hover/active 杂色变量   │
│ [ ] 4. 收敛品牌对勾：统一抽象为 --sep-accent-check: hsl(160 84% 39%)，禁止散落 Hex 色值    │
│ [ ] 5. 消除双层描边：移除 --sep-shadow 中与 border 重叠的 inset 1px 白边，保留纯单层发丝    │
│ [ ] 6. 修复分割线粘连：增加 CSS 兄弟合并规则，防止搜索栏下边框与分隔线形成 2px 粗黑边        │
│ [ ] 7. 重构 Grid 栅格：状态诊断页统一采用自适应栅格与断点，杜绝 54px 挤压吃字与重叠碰撞     │
│ [ ] 8. 修复滚轮穿透：SmartExpandablePanel 必须使用原生非 passive 监听器与 e.preventDefault()│
│ [ ] 9. 对齐全局契约：在 types.ts 补齐 trailingAction、badgeClassName、header/trigger 双模 Props│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**审查结论**：
方案当前版本存在多处严重的几何断层、Token 违规与 TypeScript 类型脱节。**在上述 9 项硬性缺陷全量修复并更新文档前，严禁盲目启动代码编写。**
