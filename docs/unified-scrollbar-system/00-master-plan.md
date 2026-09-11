# 统一滚动条体系与 ScrollArea 高频组件战役：最终维度定案与架构总纲

> **战役工作区**：`docs/unified-scrollbar-system/`
> **所属战役**：统一滚动条体系与 ScrollArea 高频组件战役（Unified Scrollbar System）
> **总调度主控**：Antigravity Main Agent
> **编制基准时间**：2026-09-02
> **调度准则遵循**：`docs/agent-roles/prompts/主控-全流程调度-v3.md`、`AGENTS.md`（反退避铁律、严禁打补丁、UI 原子层规范）、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`apps/crish-desktop/src/components/ui/README.md` 与 §7.1 立体验证纪律。

---

## 一、主控第一手代码审查事实（§0.4 事实锚点）

主控定夺前，亲自逐行通读了实现、调用点与测试的核心代码，确立了以下不容辩驳的第一手代码事实：

1. **实现入口事实（`apps/crish-desktop/src/styles/overlay-scrollbar.css:8-34`）**：
   - 现存全局唯一出口硬编码了 `width: var(--scrollbar-thumb-width, 7px);`；
   - 第 22-25 行虽然写了 `:hover` 与 `:active`，但统一引用 `--tint-overlay`（纯黑遮罩 30%），直接导致用户在暖纸底板上测出高达 31.4% 的深黑膏药；
   - 第 27-34 行对 `::-webkit-scrollbar-button` 粗暴执行了 `display: none; width: 0; height: 0;`，导致 Blink 内核的 `TrackRect` 端点护栏被连根拔起，使滑块滚到两端时被容器圆角截断（Corner Clipping）或越界溢出。
2. **调用违规事实（`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css:106-132`）**：
   - 用户截图标的组件公然声明了 `scrollbar-width: thin; scrollbar-color: var(--border-subtle) transparent;`；
   - 同时就地私写了 `width: 4px;`、`border-radius: 4px` 及全套私有伪元素，且粗暴滥用发丝边框色 `--border-subtle`，是全仓私有割据与排他互斥的典型缩影。
3. **门禁与死层保护事实（`apps/crish-desktop/src/styles/style-contract.test.ts:284-317`）**：
   - 测试中硬编码了 `SCROLLBAR_WHITELIST`，庇护了整整 11 个就地私写 `::-webkit-scrollbar` 的组件；
   - 284-295 行甚至反向断言要求 `Menu.module.css` 等保留私有按钮规则，使门禁本身变成了保护死层的技术债务壁垒。
4. **虚拟滚动脆弱性事实（`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx:80-120`）**：
   - 虚拟滚动强依赖 `containerRef.current.scrollTop` 原生捕获与 `useUndoWithScrollAnchor` 同步微任务测量；若外层套用 React DOM ScrollArea 包装，将诱发 Ref 劫持导致 `scrollTop` 恒为 0（长白屏）及 ResizeObserver 递归死锁。

---

## 二、用户最高定案裁决（三大约束铁律）

1. **二元灰度绝对死锁（绝无第三种 Hover 灰）**：
   - **用户原话**：“**滚动条就是两种灰度，别给我整成三种的，就是激活和未激活，没有激活分成hover和active两种的。**”
   - **未激活态（Inactive / Idle）**：屏幕实测物理灰度严格死锁在 **8.2% 左右**（通道 $\Delta_{R-B} = +4$，融入底板暖纸温与品牌暖橙底韵 `var(--accent-orange)`）；
   - **激活态（Active，光标悬停 Hover 与按压拖拽 Active 统统同色）**：屏幕实测物理灰度从历史 31.4% 彻底下调至 **20.2% 左右**；
   - **差值死锁**：激活态与未激活态之间保持严格的 **约 12.0% 增量阶梯**，全系统严禁为 `:hover` 和 `:active` 设置不同色阶！
2. **四级 Token 宽度体系（严禁硬编码像素）**：
   - 宽度支持场景自定义，但必须且只能在 Token 体系中选择：
     - `--scrollbar-width-xs: 4px`（超细：模型选择菜单、代码自动补全浮层）；
     - `--scrollbar-width-sm: 5px`（紧凑：侧边栏、二级下拉、抽屉面板）；
     - `--scrollbar-width-md: 7px`（标准系统默认 SSOT：正文聊天流、正文编辑器、设置页）；
     - `--scrollbar-width-lg: 9px`（宽屏大视口：宽屏双栏对比、超长 DiffCard、海量日志）；
   - 全仓 CSS 与 TSX 严禁直接裸写像素数字。
3. **结构收敛与负产出优先（先删后改）**：
   - 推进单位是「领域概念」；同一概念在代码中必须收敛为唯一主路径，全战役预估代码净删除 $\ge 300$ 行。

---

## 三、最终拍板的 6 大收敛维度与删除面清单（Deletions Surface）

经过对 3 位维度架构师（A 收敛主审、B 组件主审、C 渲染主审）独立提案的严格交叉比对，主控正式拍板本战役最终执行的 **6 大核心收敛维度**：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               统一滚动条体系与 ScrollArea 战役 6 大核心收敛维度与执行依赖                │
├───────────────────────┬───────────────────────────────┬────────────────────────────────┤
│ 维度编号与领域词      │ 核心建设与职责                │ 核心删除面（Deletions Surface）│
├───────────────────────┼───────────────────────────────┼────────────────────────────────┤
│ 维度 1: token-system  │ 二元灰度与四级宽度 Token 落地 │ 删 3 级灰阶伪类、删杂乱裸色、  │
│ 【Token体系与二元灰度】│ 建立 tokens.css 单一真理源    │ 删硬编码像素、删 Token 挪用    │
├───────────────────────┼───────────────────────────────┼────────────────────────────────┤
│ 维度 2: purge-debts   │ 全仓 18 处 thin 物理清除与    │ 物理删除 18 处 thin 地雷、     │
│ 【历史死层清剿】       │ 11 处私有 WebKit 伪元素拔除   │ 物理删除 11 处私有伪元素块     │
├───────────────────────┼───────────────────────────────┼────────────────────────────────┤
│ 维度 3: engine-core   │ overlay-scrollbar 出口重构与  │ 删除 5 处脆弱子串模糊匹配类名、│
│ 【核心引擎与类名矩阵】 │ 零 DOM 工具类矩阵发布         │ 删除 shell-scrollbar 遗留注释  │
├───────────────────────┼───────────────────────────────┼────────────────────────────────┤
│ 维度 4: scroll-area   │ UI 原子层 <ScrollArea> 组件落地│ 删除各弹窗自定义防越界补丁、   │
│ 【ScrollArea原子组件】│ 端点安全护栏 + 20Hz 脉冲微调  │ 删除临时模拟滚动的胶水代码     │
├───────────────────────┼───────────────────────────────┼────────────────────────────────┤
│ 维度 5: migrate-views │ 全仓 18+ 视口分级改造接入与   │ 彻底删除 5 处 TSX 内联样式、   │
│ 【业务视口分级迁移】   │ 虚拟滚动 Mode 2 零 DOM 隔离   │ 彻底删除 DiffCard 单行千层饼   │
├───────────────────────┼───────────────────────────────┼────────────────────────────────┤
│ 维度 6: gate-ratchet  │ style-contract 门禁重塑与     │ 彻底删除 SCROLLBAR_WHITELIST、 │
│ 【刚性门禁去白名单】   │ 负向刚性门禁（全仓禁 thin）   │ 彻底删除 284-295 行反向死断言  │
└───────────────────────┴───────────────────────────────┴────────────────────────────────┘
```

---

### 3.1 维度 1（token-system）：二元灰度与四级宽度 Token 体系落地
- **概念主路径**：`apps/crish-desktop/src/styles/tokens.css` 作为全局唯一的滚动条 Token 生产真源。
- **做什么**：
  - 注入未激活态（8.2% 灰度，`hsl(35 8% 91.8%)` 混入 8% `--accent-orange`）；
  - 注入激活态（20.2% 灰度，`hsl(35 12% 79.5%)` 混入 16% `--accent-orange`，差值严格死锁 12.0%）；
  - 注入四级宽度：`--scrollbar-width-xs: 4px`、`sm: 5px`、`md: 7px`、`lg: 9px`；
  - 注入端点按键尺寸与同心圆角 Token（`--scrollbar-thumb-radius: var(--radius-full)`）。
- **删除面（Deletions Surface）**：
  - 彻底删除将激活状态拆分为 hover 与 active 的多级色阶伪类；
  - 彻底删除全仓对发丝边框色 `--border-subtle` 的滚动条挪用；
  - 彻底删除 `StreamingTableContainer.module.css:35` 的硬编码 `rgba(0,0,0,0.2)` 脏色；
  - 彻底删除 `ScheduledTasksPanel.module.css` 对滚动条变量的不规范挪用。
- **验收断言**：
  - 计算样式测得未激活灰度为 $8.2\% \pm 0.3\%$，激活灰度为 $20.2\% \pm 0.3\%$，差值绝对锁定在 $12.0\% \pm 0.5\%$；
  - 全仓检索禁止出现第三种 Hover 灰阶变量。

---

### 3.2 维度 2（purge-debts）：全仓 18 处 thin 物理清除与 11 处私有 WebKit 拔除
- **概念主路径**：纯净走全局出口，彻底切断所有私有分支。
- **做什么**：
  - 彻底拔除全仓 18 处声明 `scrollbar-width: thin` 的毒点（16 处 desktop + 2 处 block-paper），解除 Chromium Blink 引擎杀死 WebKit 样式的系统性风险；
  - 连根拔除 11 个业务组件中私自写就的 `::-webkit-scrollbar` 代码块。
- **删除面（Deletions Surface）**：
  - **物理删除 18 处 `scrollbar-width: thin` 声明**：
    1. `Sidebar.module.css:129`
    2. `ChatComposer.module.css:1115`
    3. `PermissionModeMenu.module.css:141`
    4. `ModelBadgePickerMenu.module.css:106`
    5. `Select.module.css:165`
    6. `SelectContent.module.css:20`
    7. `ChatQueuePanel.module.css:12`
    8. `TiptapEditorField.module.css:42`
    9. `TiptapSlashMenu.module.css:34`
    10. `StreamingTableContainer.module.css:34`
    11. `ChatToolCallBlock.module.css:880`
    12. `DiffCard.module.css:185`
    13. `NotePaperPanel.module.css:172`
    14. `ModelsSettingsTab.module.css:1110`
    15. `FontSelectField.module.css:210`
    16. `Textarea.module.css:30`
    17. `packages/block-paper/src/chrome/blockChrome.css:26`
    18. `packages/block-paper/src/list/paperList.css:58`
  - **物理删除 11 处私有 `::-webkit-scrollbar*` 冗余代码块**（累计删除近 200 行重复代码）：
    `ModelBadgePickerMenu` (110-132 行)、`Menu` (48-66 行)、`Select` (173-187 行)、`SelectContent` (39-53 行)、`PermissionModeMenu` (148-165 行)、`SmartPanel` (107-116 行)、`SmartExpandablePanel` (130-148 行)、`ModelsSettingsTab` (1126-1135 行)、`FontSelectField` (214-222 行)、`LeafToolTabStrip` (63-66 行)、`ChatComposer` (612-617 行)。
  - 删除 `packages/block-paper/src/list/paperList.css:51` 遗留的“禁 webkit 注释”死注释。
- **验收断言**：
  - 全仓扫描正则 `scrollbar-width\s*:\s*thin` 匹配结果严格为 0；
  - 除 `overlay-scrollbar.css` 外，全仓扫描正则 `::-webkit-scrollbar` 匹配结果严格为 0。

---

### 3.3 维度 3（engine-core）：`overlay-scrollbar.css` 核心引擎重构与零 DOM 工具类矩阵
- **概念主路径**：`apps/crish-desktop/src/styles/overlay-scrollbar.css` 升级为 Conex 全局唯一滚动引擎。
- **做什么**：
  - 将 `::-webkit-scrollbar-button` 从全局 `display: none` 释放，恢复其在垂直方向的 `height: 8px`，激活 Blink 内核级 `CustomScrollbarTheme::TrackRect` 护栏，物理杜绝滑块顶死与圆角截断；
  - 注入微型内联圆角等腰三角 SVG（顶角 $R \approx 1.0\text{px}$，两底角 $R \approx 0.8\text{px}$），无毛刺锐角；
  - 伪元素样式合二为一：`:hover` 与 `:active` 统一消费 `--scrollbar-thumb-active`；
  - 建立 Mode 2 零 DOM 实用类矩阵：`.scrollArea`, `.scrollAreaXs`, `.scrollAreaSm`, `.scrollAreaMd`, `.scrollAreaLg`, `.hideScrollbar`, `.scrollAreaWithButtons`。
- **删除面（Deletions Surface）**：
  - 彻底删除第 42-46 行基于子串模糊匹配的脆弱选择器（`[class*='sidebarScroll']`, `[class*='menuContent']`, `[class*='coverContent']`, `[class*='navScroll']`, `[class*='dialogBody']`）；
  - 彻底删除第 1 行历史废弃文件名 `shell-scrollbar.css` 的注释；
  - 彻底删除全仓零散组件用于隐藏滚动条的就地 `display: none` hack，统一收敛为 `.hideScrollbar`。
- **验收断言**：
  - 任何容器挂载 `.scrollArea .scrollAreaSm` 即可无感获得 5px 细条与二元灰度；
  - 挂载 `.scrollAreaWithButtons` 时自动呈现 8px 矢量三角按钮且具备内核端点护栏。

---

### 3.4 维度 4（scroll-area）：UI 原子层 `<ScrollArea>` 高频组件封装与端点物理护栏
- **概念主路径**：`apps/crish-desktop/src/components/ui/ScrollArea/`（原子层组件）。
- **做什么**：
  - 依据 `apps/crish-desktop/src/components/ui/README.md` 规范，封装开箱即用的 React 原子组件 `<ScrollArea>`；
  - 属性契约：`size?: 'xs'|'sm'|'md'|'lg'`、`showButtons?: boolean`、`stepSize?: number|'auto'`、`orientation`、`scrollbarGutter`、`as`、`viewportRef`；
  - 命令式 Handle API：`scrollToTop()`, `scrollToBottom()`, `scrollStep()`, `getViewport()`, `getMetrics()`；
  - 三段式物理隔离轨道布局：`[Top Button] + [Safe Gap] + [Isolated Track] + [Safe Gap] + [Bottom Button]`，代数不变量证明滑块行程在极限位置恒有 2px 净空，绝对不侵入按钮；
  - 20Hz 脉冲微调引擎：单击平滑步进 40px，长按 250ms 防抖延时 + 50ms 高频动力学连发，指针移出（pointerup/pointerleave/blur）即刻刚性制动；
  - 无障碍守卫：检测 `prefers-reduced-motion: reduce` 降级为瞬时位移，按钮配置 `tabIndex={-1}`。
- **删除面（Deletions Surface）**：
  - 纯新增原子层资产（主控核准豁免）；
  - 严禁引入任何外部重型滚动库（如 react-custom-scrollbars、perfect-scrollbar）；
  - 删除各业务弹窗、浮层中用于模拟滚动的临时 JS 定时器与内边距补偿补丁。
- **验收断言**：
  - 运行 `npm run check:ui-layer`：零上层 store/hooks 依赖，100% 架构合规；
  - `ScrollArea.test.tsx`：单元测试覆盖键盘导航、单击步进、长按连发脉冲与代数极限位置验证，全绿通过。

---

### 3.5 维度 5（migrate-views）：全仓 18+ 业务视口分级迁移与虚拟滚动边界隔离
- **概念主路径**：双轨分级消费落地（Tier A 走 `<ScrollArea>`，Tier B 走 Mode 2 原生 CSS，Tier C 走隐藏）。
- **做什么**：
  - **第一梯队（Tier A - 弹出层/独立面板，全面迁移至 `<ScrollArea>`）**：
    - `ModelBadgePickerMenu`（模型选择菜单，配置 `size="xs" showButtons={true}`，实现真机截图 100% 还原与圆角免裁切）；
    - `PermissionModeMenu`（权限模式弹窗，配置 `size="xs" showButtons={true}`）；
    - `Menu`（全局弹出菜单组件，配置 `size="sm"`）；
    - `Select` / `SelectContent`（下拉菜单，配置 `size="sm"`）；
    - `SmartPanel` / `SmartExpandablePanel`（配置 `size="sm"`）；
    - `Dialog` / `ConfirmDialog` / `FirstRunWizard`（配置 `size="md"`）；
    - `SettingsPanel` 各配置 Tab 局部视口（配置 `size="md"`）；
  - **第二梯队（Tier B - 虚拟长列表/重型容器，接入 Mode 2 纯类名）**：
    - `MessageVirtualizer`（主会话瀑布流，挂载 `.scrollArea .scrollAreaMd`，**绝对不套 DOM 包装，DOM 深度增量严格为 0**）；
    - `WindowedSessionUl`（侧栏虚拟会话列表，挂载 `.scrollArea .scrollAreaSm`）；
    - `Sidebar`（主侧栏轨，挂载 `.scrollArea .scrollAreaSm`）；
    - `TerminalCard` / `DiffCard` 对比视口（挂载 `.scrollArea .scrollAreaMd`）；
  - **第三梯队（Tier C - 纯净无痕通道与千层饼消除）**：
    - `LeafToolTabStrip`、`PaneHeader` 挂载 `.hideScrollbar`；
    - 清洗 5 处 TSX 内联样式死层（`DiffCardUnifiedView.tsx`, `DiffCardSplitView.tsx`, `VirtualPlainCodeViewer.tsx`, `FileTreeView.tsx`, `FlowDagView.tsx`）；
    - 消除 `DiffCard.module.css:546` 的单行横向 overflow。
- **删除面（Deletions Surface）**：
  - 彻底物理删除 5 处 TSX 中的内联 `style={{ overflow... }}`；
  - 彻底删除 `DiffCard.module.css:546` 的 `.lineText { overflow-x: auto; }`；
  - 彻底删除已迁移组件中原有的私有滚动样式类与兼容胶水代码（预估净删除 180+ 行）。
- **验收断言**：
  - 模型选择器展开时，上下圆角三角箭头清晰精致，滑块两端与容器圆角保持安全间距，零裁切；
  - 虚拟列表滚动帧率稳定在 60fps/120fps，`scrollTop` 捕获精准，撤销锚定零跳跃。

---

### 3.6 维度 6（gate-ratchet）：测试契约与 CI 刚性门禁重塑（去白名单化）
- **概念主路径**：`apps/crish-desktop/src/styles/style-contract.test.ts` 与静态门禁。
- **做什么**：
  - 将现存的“白名单豁免制”升级为“**零白名单负向刚性门禁（Zero-Tolerance Negative Gate）**”；
  - 新增全仓禁 thin 门禁：遍历全仓 `.css`，扫描到 `scrollbar-width: thin` 即刻爆红阻断；
  - 新增全仓禁私有 WebKit 门禁：遍历全仓 `.css`（除 `overlay-scrollbar.css` 外），扫描到 `::-webkit-scrollbar` 即刻爆红阻断；
  - 新增二元灰度差值断言：断言 `--scrollbar-thumb-bg` (8.2%) 与 `--scrollbar-thumb-active` (20.2%)，差值绝对在 $12.0\% \pm 0.5\%$ 内；
  - 新增零硬编码裸像素断言：扫描 CSS 中滚动条相关属性禁止裸写数字 px。
- **删除面（Deletions Surface）**：
  - **彻底物理删除 `style-contract.test.ts:304-317` 的 `SCROLLBAR_WHITELIST` 白名单集合**；
  - **彻底物理删除 `style-contract.test.ts:284-295` 的反向测试**（原测试要求 Menu 保留私有按钮伪元素）；
  - 删除所有临时测试跳过与豁免逻辑。
- **验收断言**：
  - 运行 `npx vitest run src/styles/style-contract.test.ts` 100% 绿灯通过；
  - 运行 `npm run check:desktop` 与 CI 快层全套门禁 100% 绿灯通过。

---

## 四、执行原则与逻辑依赖次序（先删后改）

依据《主 Agent 全流程调度提示词 v3》§0.2 铁律，收敛先于增强，先删后改：

```
                    ┌──────────────────────────────────────────────────────────┐
                    │ 步骤 1: 维度 1 (token-system) 基础设施                     │
                    │ 注入二元灰度 (8.2%/20.2%) 与四级宽度 Token (4/5/7/9px)    │
                    └────────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │ 步骤 2: 维度 2 (purge-debts) 历史死层大清剿               │
                    │ 拔除 18 处 thin 地雷与 11 处私有 WebKit 块 (解除 Chromium 互斥) │
                    └────────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │ 步骤 3: 维度 3 (engine-core) 全局出口重塑                  │
                    │ 重构 overlay-scrollbar.css，恢复 8px 按钮护栏，发布 Mode 2 │
                    └────────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │ 步骤 4: 维度 4 (scroll-area) 原子组件落地                │
                    │ 构建 UI 原子层 <ScrollArea> 组件，三段式护栏与 20Hz 微调引擎│
                    └────────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │ 步骤 5: 维度 5 (migrate-views) 全量业务视口分级改造        │
                    │ Tier A 接 ScrollArea / Tier B 接 Mode 2 / 清洗 TSX 内联  │
                    └────────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │ 步骤 6: 维度 6 (gate-ratchet) 门禁锁死与去白名单化        │
                    │ 彻底删除 SCROLLBAR_WHITELIST，确立零容忍负向门禁           │
                    └──────────────────────────────────────────────────────────┘
```

---

## 五、主控定案签发与下一步行动

本总纲已严格内化：
1. 用户关于“**滚动条只有两种灰度（未激活 8.2% vs 激活 20.2%，差值 12%），绝不搞三种灰度**”的最高裁决；
2. 用户关于“**宽度只能在 Token 体系选择，严禁硬编码**”的铁律；
3. 用户关于“**上下圆角三角箭头充当端点安全护栏、物理防滑块越界截断**”的形态要求；
4. 《主 Agent 全流程调度提示词 v3》关于“**概念主路径、删除面必须明确、先删后改、收敛优先**”的全部组织纪律。

定案已正式生效，下一步立即进入**方案生成阶段（各维度详案生成与多 Agent 交叉评审）**！
