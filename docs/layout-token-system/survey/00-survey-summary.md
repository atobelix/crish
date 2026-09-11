# 第一阶段全景调研汇总索引（00-survey-summary）

> **战役工作区**：`docs/layout-token-system/`
> **调研目录**：`docs/layout-token-system/survey/`
> **收口时间**：2026-09-11
> **主控状态**：第一阶段 8 位专项子 Agent 调研全量完成，产出文档 100% 落盘且深度穿透。

---

## 一、调研交付物清单

| 文件名 | 标题 | 大小 | 责任 Agent | 核心突破与事实发现 |
|---|---|---|---|---|
| [`01-tokens-and-scale-survey.md`](./01-tokens-and-scale-survey.md) | Token 刻度定义与数学几何现状调研 | 29.1 KB | Token Scale Researcher | 4px 乘法网格与 2px 半步刻度混杂；`small` 档位出现 3px/5px 奇数并丢失 `--space-8/10`；`large` 档位零放大反向致挤；8px vs 7px 圆角锁冲突；缺乏 L2 语义 Token。 |
| [`02-shell-and-viewport-layout-survey.md`](./02-shell-and-viewport-layout-survey.md) | Shell 外壳与视口包含块层级关系调研 | 29.2 KB | Shell Layout Researcher | `AppTopBar`（36px 高、absolute 浮动、流内高度 0）迫使全系统向下穿透感知并各自手写避让；展开态侧栏在 macOS 下与交通灯物理撞车；`--shell-gutter` 废弃使画布硬贴边。 |
| [`03-workspace-and-tree-layout-survey.md`](./03-workspace-and-tree-layout-survey.md) | 工作区与二叉树窗格容器链布局调研 | 33.3 KB | Workspace Tree Layout Researcher | 6 层嵌套拓扑与流式/百分比坐标系截断；`.leafChatColumn` 跨 2 层强拉后代弹性（`:not(:global(header)):not(:global(footer))`）；note-paper 绝缘补丁与单测死锁；TS 标签几何与 CSS 密度脱节。 |
| [`04-chat-flow-and-message-layout-survey.md`](./04-chat-flow-and-message-layout-survey.md) | 会话消息流与消息卡片内外边距调研 | 39.9 KB | Chat Stream Layout Researcher | 捕获 `chatScrollGeometry.ts` 与 CSS 硬编码双轨冲突（门禁红灯）；DEF-13 垂直节奏落实但充斥裸值；搜索行 `-6px` 负 margin 与 `+4px` 突增回流；`.userBubble` 的 `var(--radius-xl, 16px)` 永久失效（全局定为 12px）；116 行僵尸 `.pinnedBar` 样式。 |
| [`05-chat-composer-and-float-zone-survey.md`](./05-chat-composer-and-float-zone-survey.md) | 输入区四层垂直空间堆叠与卡片内布局调研 | 32.4 KB | Composer Float Zone Researcher | 逆向工程揭秘 `-10px` 抽屉舌头负边距与 `18px/36px` 避让圆角弧度的脆弱硬编码；单多行态尺寸全方位突变与权限胶囊跨槽位抖动；同心圆角破损（14px + 8px = 22px > 20px）；发现 184 行完全重复代码。 |
| [`06-tool-cards-and-nested-elements-survey.md`](./06-tool-cards-and-nested-elements-survey.md) | 工具调用卡片与内部嵌套元素布局调研 | 51.2 KB | Tool Cards Layout Researcher | 24 种离散裸 padding 泛滥；3~4 重发丝线嵌套形成 Border Stacking；外卡片 8px 内 Diff 卡片 10px 的逆向同心畸变；子代理头部高度 8 档离散；暗色模式裸写 `rgba(0,0,0,0.10)` 污染。 |
| [`07-sidebar-and-settings-layout-survey.md`](./07-sidebar-and-settings-layout-survey.md) | 全局侧栏与全屏/弹窗设置布局调研 | 40.0 KB | Sidebar and Settings Layout Researcher | 侧栏 18px 绝对对齐线与右侧 2px 窄留白几何逻辑；Models Tab（视口工作台）与常规 Tab（文档流）双倍速滚动冲突及运行时补丁；`--settings-content-max` 存在 720px 与 820px 严重撕裂；8 层边距传递链。 |
| [`08-ui-primitives-and-contracts-survey.md`](./08-ui-primitives-and-contracts-survey.md) | UI 原子组件库与样式门禁契约调研 | 57.9 KB | UI Primitives Contract Researcher | 原子控件 `lg` 档高度 40px/38px/36px 三轨分裂；全仓大量 `var(--space-2, 6px)` 错误 fallback；实测定位 5 项现有样式门禁红灯；规划 4 大刚性拦截守护机制与 5 阶段演进路线。 |

---

## 二、宏观问题全景矩阵与深层根因归纳

经过 8 个维度的独立穿透调研，Conex / Crish 桌面端在布局、内外边距与容器拓扑上的核心痛点高度收敛为 **五大系统性架构断层**：

### 1. Token 体系的「单层裸标量断层」
- **现状**：全局仅有最底层的 `--space-*` 与部分 `--radius-*` 标量，**完全缺失 Level 2 语义层（Semantic Tokens）与 Level 3 组件层（Component Tokens）**。
- **恶果**：各组件直接裸用 `--space-2` 或私设局部变量；当开发者想要修改卡片内衬或栅格列间距时，要么牵一发动全身，要么只能退化为硬编码裸像素（如 6px, 10px, 14px 泛滥，累计数千处）。
- **密度断崖**：`[data-ui-size='small']` 直接篡改了基础标量（`--space-1: 3px`），引入奇数像素并发生标量碰撞（2_5 与 3 同为 6px），破坏了下游所有依赖 4px 偶数倍的组件；`large` 档位则完全无放大，界面字大框小。

### 2. 跨层包含块的「几何隐式穿透与魔术数字耦合」
- **顶栏穿透**：`AppTopBar` 声明为 `position: absolute; top: 0; width: 100vw; pointer-events: none;`，在普通流中占位高度为 0。导致下游 Sidebar、二叉树工作区、PaneHeader、全屏 SettingsPanel 必须各自感知 `--header-height: 36px`，手写多层避让与绝对定位，造成 Windows 窗控与 macOS 交通灯在多状态下的逻辑冲突（如侧栏展开时撞车交通灯）。
- **浮动条舌头与负边距**：Composer 上方的计划进度条与权限审批条，为了视觉贴合主卡片，硬编码了 `width: calc(100% - 36px); margin-left: 18px; margin-bottom: -10px;`。18px 深度绑定卡片外圆角，-10px 深度绑定主卡片覆盖层级，下层 padding 变动立刻导致整体几何错位。

### 3. 祖父与孙级组件的「弹性强拉与越权破坏（Descendant Hacking）」
- **弹性穿透 hack**：二叉树叶子列 `.leafChatColumn > *:not(...):not(...) > * > *:not(...):not(...)` 为了让孙级 `ChatCard` 撑满高度，强行穿透两层打上 `flex: 1 1 0%; max-height: 100%`。由于基于 DOM 树选择器而非盒树，击中 `display: contents` 的包装层引发属性丢失与未知布局破坏。
- **绝缘补丁技术债务**：工作区外壳被迫越权为笔记扩展写私有选择器（`[data-note-leaf-host]`、`[data-testid='note-paper-strict-panel'] > header` 强行 `flex: 0 0 auto`），甚至将其作为测试硬性断言锁死，破坏了微内核与插槽的封装性。

### 4. 几何真理单一源（SSOT）的「TS 与 CSS 双轨撕裂」
- **会话流切片**：`chatScrollGeometry.ts` 剥离了内边距常量，但 `ChatMessageList.module.css` 仍硬编码 `padding: 48px 20px 16px;`，导致现场门禁测试 `VirtualScrollGeometryContract.test.ts` 直接红灯报警。
- **标签条几何**：`tabStripGeometry.ts` 锁定 28px 标签高度与 36px 非标签空间，与 CSS 的 3 档 `--header-height`（32/36/40px）彻底脱节，引发紧凑与大屏模式下的亚像素抖动与关闭光标偏离。
- **圆角标量预期撕裂**：CSS 声明 `border-radius: var(--radius-xl, 16px)`，但全局 `--radius-xl` 被赋值为 12px，导致 fallback 16px 永久失效，形成幽灵代码。

### 5. 滚动视口模型与容器内衬的「范式混乱」
- **视口模型冲突**：全屏 SettingsPanel 混合了文档长页面（常规 Tab，外层滚动）与多栏视口工作台（Models Tab，内层独立滚动），依靠宿主注入 `handleRootWheel` 运行时补丁拦截双倍速滚动；
- **呼吸感与画板留白退避**：工作区外壳 `.section` 中的 `--shell-gutter` 被注释为 `padding: 0`，致使叶子卡片在任何模式下均硬碰窗口边框与侧栏，灰底画板进深感丧失。

---

## 三、串行过渡到第二阶段（方案生成团队）的分工蓝图

基于第一阶段挖掘出的详尽证据与根因，第二阶段方案生成团队应当按照以下 **6 个正交维度** 进行系统性方案设计（方案团队同样遵守多 Agent 协同与串行生成纪律）：

1. **维度 01：三层 Token 体系与数学基准重塑方案**（输入：01、08 调研）
   - 确立统一的 4px/2px 物理网格标量（Primitive Tokens）；
   - 建立语义层（Semantic Tokens）：布局槽、内衬、堆叠间距、组件圆角、同心圆角推导；
   - 规范组件级 Token（Component Tokens）与齿轮换挡（Density System）的一致性联动。
2. **维度 02：Shell 外壳视口链与安全避让架构方案**（输入：02、07 调研）
   - 治理 `AppTopBar` 包含块模型，解决高度为 0 的穿透弊端；
   - 统一 `--shell-gutter` 与跨平台（macOS / Win）硬件安全区 Token 矩阵，根除撞车。
3. **维度 03：工作区容器链与插槽隔离解耦方案**（输入：03 调研）
   - 拔除 `.leafChatColumn` 穿透选择器强拉弹性的反模式，建立纯净的插槽高度契约；
   - 清退 `note-paper` 绝缘补丁与测试死锁，重构工作区画板与 Sash 绝对定位几何。
4. **维度 04：会话消息流与垂直节奏纯净化方案**（输入：04 调研）
   - 闭环 `chatScrollGeometry.ts` 与 CSS 的几何 SSOT，修复红灯测试；
   - 升格 DEF-13 垂直节奏，规范气泡内衬、元数据高度，彻底清理僵尸样式与搜索行负 margin。
5. **维度 05：Composer 四层空间堆叠与自适应网格方案**（输入：05 调研）
   - 重塑浮动条与主输入框的嵌套模型，废除 `-10px` 与 `18px/36px` 脆弱硬编码；
   - 统一单多行切换内边距阶梯与同心圆角法则，消除网格抖动。
6. **维度 06：复合卡片嵌套收敛与样式门禁防护方案**（输入：06、08 调研）
   - 制定工具卡片与子代理面板的内边距阶梯，清除 Border Stacking 与多重发丝线污染；
   - 落地 `scripts/check-layout-tokens.mjs` 门禁脚本与 `layout-contract.test.ts` 契约测试，建立防回潮长效防线。
