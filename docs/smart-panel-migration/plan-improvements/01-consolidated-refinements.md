# Conex / Crish — SmartExpandablePanel 评审改进与终极落地总纲

> **文档标识**：`docs/smart-panel-migration/plan-improvements/01-consolidated-refinements.md`  
> **制定背景**：吸收 3 位魔鬼审查专家（`01-visual-geometry-critique.md`、`02-interaction-state-critique.md`、`03-architecture-anti-overengineering-critique.md`）指出的全部致命漏洞，进行无死角闭环纠偏。  
> **权威红线**：`AGENTS.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`reference/smart-expandable-panel/`。

---

## 一、十大致命漏洞纠偏与统一架构规范

### 1. 同心圆角数学公式统一定义
- **统一几何公式**：$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 0\text{px})$
  - **L1 主宿主面板**：$R_{\text{outer}} = 14\text{px}, \text{Padding} = 6\text{px} \Longrightarrow R_{\text{inner}} = 8\text{px}$（条目圆角严格为 **8px**，彻底消除硬编码 6px 产生的 2px 离心空隙）；
  - **L2 紧凑/二级子菜单卡片**：$R_{\text{outer}} = 8\text{px}, \text{Padding} = 4\text{px} \Longrightarrow R_{\text{inner}} = 4\text{px}$（条目圆角严格为 **4px**，杜绝 6px 顶穿外壳）；
  - **L3 操作按钮**：$R = 6\text{px}$（`--sep-btn-radius: 6px`）；
  - **L4 状态徽标**：$R = 4\text{px}$（`--sep-badge-radius: 4px`）。

### 2. 彻底绝迹 `--sidebar-hover` 与收敛品牌对勾 Token
- **严禁杂色底**：全仓所有浮层、输入区加号 `[ ＋ ]`、盾牌 `[ 🛡️ ]` 与设置按钮，一律使用专属悬停 Token：
  - 浅色悬停：`--sep-bg-item-hover: rgba(29, 28, 26, 0.045);`（仅 4.5% 柔和暖灰，绝不消费带有青底的 `--sidebar-hover`）；
  - 浅色选中：`--sep-bg-item-selected: rgba(29, 28, 26, 0.065);`（仅 6.5% 微灰）；
  - 深色悬停：`--sep-bg-item-hover: rgba(245, 244, 240, 0.06);`（6% 柔和冷白）；
  - 深色选中：`--sep-bg-item-selected: rgba(245, 244, 240, 0.09);`（9%）。
- **统一对勾 Token**：全局唯一收敛为 `--sep-accent-check: hsl(160 84% 39%);`（深色模式：`hsl(160 84% 45%)`），严禁散落硬编码 Hex。
- **消除双层白边**：移除 `--sep-shadow` 中的 `inset 0 1px 0` 白边，保留 1px 纯单层发丝边框（`#e2dfd9` / `#2b2926`），消灭高 DPI 下的 2px 发虚边缘。

### 3. 根除 1 项条目 120px 死白空间与真·自适应高度
- **紧凑贴合算法**：当条目数 $\le 2$ 时，禁止注入 `min-height: 120px` 兜底，强制采用 `allowedListHeight = naturalHeight`，1 项时紧凑贴合（高度精确为 28px + padding），绝不出滚动条，绝不留 92px 死白空洞。
- **发丝滚动条无障碍合规**：长列表（>6 项）启用 6px（Hover 时 8px）发丝滚动条，保留透明轨道与标准 `scrollbar-width: thin; scrollbar-color: var(--sep-border-hover) transparent;`。

### 4. Safe-Aim 算法升级：速度矢量、300ms 超时与多级保护栈
- **速度矢量导数判定**：仅当鼠标移动方向向着目标子菜单（$\vec{v} \cdot \vec{d} > 0$）时启用安全三角区判定；若鼠标反向回划（$\vec{v} \cdot \vec{d} \le 0$），立即释放保护区，主菜单项 120Hz 极速响应切换；
- **300ms 安全超时熔断（Safety Timeout）**：当光标在三角区内停顿思考超过 300ms 时，自动熔断安全区并激活当前悬停项，彻底根除悬停死锁；
- **多级级联栈（`submenuStack`）**：支持 3 级以上级联，下级子菜单的展开不覆写父级保护区；
- **局部化受控生命周期**：移除全局单例 `#sepSafeAimOverlay`，由菜单根容器独立管理 SVG 与事件监听，跟随组件生命周期精准销毁。

### 5. PositionEngine 几何解算轻量化与强制回流阻断
- **杜绝 Layout Thrashing**：禁止在热路径上读写 `style.maxHeight` 与 `scrollHeight`；采用预估高度数学公式与 `ResizeObserver` 批处理防抖计算；
- **视口翻转边界防护**：在小屏幕空间不足时，自动约束浮层最大高度，禁止向上翻转时覆盖触发器（Trigger）本身；
- **自适应宽度对齐**：面板设置 `min-width: var(--sep-trigger-width, 100%)`，彻底消灭下拉面板比触发器窄导致的阶梯错层。

### 6. WAI-ARIA 全键盘漫游闭环与 IME 拼音拦截
- **闭环漫游**：首项按 `ArrowUp` 焦点优雅返回顶部搜索框；搜索框按 `ArrowDown` 聚焦首项；
- **焦点陷阱**：`Tab` / `Shift+Tab` 键闭环在浮层内部，禁止焦点意外逃逸出 Portal；
- **手风琴折叠隔离**：折叠子项在 `expanded=false` 时设置 `display: none` 或 `inert`，禁止键盘光标穿透进入高度为 0 的假死区；
- **IME 拼音拦截**：在 `onKeyDown` 中拦截 `e.nativeEvent.isComposing || e.keyCode === 229`，杜绝输入法选词时按 Enter 误触发菜单选项。

### 7. 真·原生非 passive 滚轮穿透隔离（Wheel Isolation）
- **原生监听器**：在滚动列表容器挂载 `{ passive: false }` 原生 `wheel` 监听；
- **浮点比对与精准阻断**：采用 `Math.ceil(scrollTop)` 与 `Math.floor(scrollTop + clientHeight) >= scrollHeight - 1` 容差比对，滚到边界且继续向外滚动时调用原生 `e.preventDefault()`，彻底阻止外部宿主窗口与 WebView2 页面晃动。

### 8. 800+ 单元测试无损兼容与双轨适配器加固
- **`MenuAdapter` 契约保持**：
  - 支持 `trigger` JSX 元素的 `React.cloneElement` 与真实 DOM `ref` 合并挂载时序，杜绝首次渲染坐标归零 `(0, 0)`；
  - `children` 模式下为容器严格注入 `role="menu"`，确保 `findByRole('menu')` 100% 绿灯；
  - 继承存量 CSS Modules 类名（`menuItemDisabled` / `menuItemDanger`）；
  - `onSelect` 回调无损支持 `(id: string, option: SelectOptionItem)` 双参数签名。
- **`SelectAdapter` 树形拓扑**：保留 `combobox -> listbox -> option` 的 WAI-ARIA 标准树形拓扑与 `aria-selected` 契约；
- **`DialogOverlayContext` 模态穿透**：当检测到处于 Dialog 模态框内部时，自动将 Portal 挂载到对话框专属 Overlay 容器，杜绝事件被父级模态框误杀。

### 9. 物理拆分解耦（严格守住单文件行数门禁）
将 `SmartExpandablePanel` 物理拆分为 6 个高内聚单文件：
1. `SmartExpandablePanel.tsx`（主调度与 Portal 挂载，~180 行）
2. `SmartPanelHeader.tsx`（一体化搜索栏与标题/分段器，~90 行）
3. `SmartPanelList.tsx`（列表与分组渲染器，~140 行）
4. `SmartPanelItem.tsx`（条目、图标、次文本、翡翠绿对勾、手风琴，~160 行）
5. `useSmartKeyboardNav.ts`（WAI-ARIA 漫游 Hook，~150 行）
6. `useWheelIsolation.ts`（原生滚轮隔离 Hook，~70 行）

所有文件代码行数稳控在 **200 行以内**，100% 满足 RL-03 前端单文件行数门禁！

### 10. 业务模块针对性实机缺陷治理清单
- **输入区与模型胶囊**：`ComposerFusedTrigger` 28px 单层透明底 + 1px 中性发丝边框，分段提供独立的 4px/6px 微圆角与 4.5% 微灰悬停，彻底消灭右侧直角硬切与青底叠色；统一加号与盾牌为 24×24px 极简微圆角图标按钮；
- **权限模式面板**：补齐语义图标与 11px 次级描述，条目 8px 同心圆角，4.5% 微灰悬停，6.5% 微灰选中 + `#059669` 翡翠绿品牌对勾；
- **项目选择器**：28px 顶栏一体化内嵌透明搜索框（`.sep-search-wrapper`）+ 8px/4px 同心发丝二级子菜单，接入 Safe-Aim 保护；
- **字体选择器**：搜索栏顶置一体化，输入框 Flex 自适应展开消灭文字截断，扫描/重置按钮规范为 22×22px 微圆角容器，触发器去药丸化（28px 高度、6px 圆角、白底发丝边框）；
- **模型设置页**：「+ 添加服务商」去实心青绿底与去胶囊化，「默认模型」去深青绿粗描边，自适应高度彻底根除原生带箭头粗滚动条（`▲`/`▼`）；
- **规则与安全设置页**：右上角作用域与编辑全文同行排列，添加规则/命令封装标准 Input Group，预设胶囊规范为 6px 微圆角；
- **状态诊断页**：当前日志级别重构为带 Chevron `▾` 的标准选择器；**采用 CSS Grid（`72px 150px 1fr`）彻底根除 `NOTE_RUNTIME` 与 `2026/8/20` 时间戳文字重叠碰撞的致命排版 Bug**！
