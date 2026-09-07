export const part8 = `
---

## 8. 未来原子化多窗格系统重塑详案（Future Atomic Multi-Pane System Architecture）

### 8.1 架构设计哲学：从“臃肿复合组件”走向“Headless 视窗微内核 + 原子化原语”

基于前述实勘中发现的全部架构断层与物理样式缺陷，未来的工作区分屏系统必须推进**彻底的原子化重塑**。

#### 核心设计哲学：
1. **彻底解耦“空间拓扑”与“业务渲染”**：
   - 二叉树只管“切蛋糕”（二维矩形切分、手势捕获、比例维护）；
   - 视窗只管“自身业务”（浏览器导航、终端字节流、DAG 图排版）；
   - 彻底废除视窗内部私自实现分屏（如终端内嵌分屏）的违规做法。
2. **Headless 核心驱动（\`usePaneTree\`）**：
   - 将二叉树的展平计算、Sash 定位、Live Resize 直写手势管线完整下沉为一个 Headless 纯逻辑微内核 Hook；
   - 输出纯粹的数据模型、CSS 变量、以及无状态的事件绑定函数，支持任意 UI 壳层消费。
3. **原子组件原语化（Atomic Primitives）**：
   - 将庞大的 \`BinaryTreeWorkspace\`、\`TreeLeafPanel\`、\`PaneHeader\` 拆解为细粒度的 Compound Components（复合组件群），通过声明式 JSX 进行任意插槽组装。

---

### 8.2 原子化多窗格组件原语规划（代码级契约草案）

规划在 \`src/components/ui/pane-system/\` 目录下落地一套全新的原子化多窗格组件系统：

\`\`\`typescript
/**
 * 原子化多分屏视窗系统 — 组件契约草案
 */
import React from 'react';

// 1. 顶层分屏容器原语：提供尺寸测量上下文与 CSS 容器查询宿主
export interface PaneGroupProps {
  id?: string;
  direction?: 'horizontal' | 'vertical';
  className?: string;
  children: React.ReactNode;
}
export const PaneGroup: React.FC<PaneGroupProps>;

// 2. 独立窗格原子原语：对应树中的物理 Leaf，提供独立焦点与隔离盒
export interface PaneProps {
  id: string;
  className?: string;
  // 归一化百分比尺寸，由 PaneGroup 统一派发
  style?: React.CSSProperties;
  children: React.ReactNode;
}
export const Pane: React.FC<PaneProps>;

// 3. 窗格分割手柄原语：对应 Branch 分割线，集成高性能零重绘手势与无障碍
export interface PaneSplitterProps {
  branchId: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  className?: string;
  onResizeCommit?: (newRatio: number) => void;
}
export const PaneSplitter: React.FC<PaneSplitterProps>;

// 4. 窗格标题栏原子原语：统一会话标签栏与工具抽屉标签栏
export interface PaneHeaderProps {
  paneId: string;
  height?: number; // 统一为 36px，不再有 36px vs 38px 的撕裂
  className?: string;
  children: React.ReactNode;
}
export const PaneHeader: React.FC<PaneHeaderProps>;

// 5. 窗格标签列表原子原语：内建横向滚轮转换与智能固定加号
export interface PaneTabListProps {
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabAdd?: () => void;
  children: React.ReactNode;
}
export const PaneTabList: React.FC<PaneTabListProps>;

// 6. 窗格内容宿主原语：彻底消除通配符穿透，提供稳定的 100% 撑满容器
export interface PaneContentProps {
  className?: string;
  children: React.ReactNode;
}
export const PaneContent: React.FC<PaneContentProps>;
\`\`\`

#### 组装消费范式（极简且声明式）：
\`\`\`tsx
<PaneGroup id="main-workspace">
  {panes.map((pane) => (
    <Pane key={pane.id} id={pane.id}>
      <PaneHeader paneId={pane.id}>
        <PaneTabList
          activeTabId={pane.activeTabId}
          onTabSelect={(id) => activateTab(pane.id, id)}
        >
          {pane.tabs.map((t) => (
            <PaneTab key={t.id} id={t.id} title={t.title} />
          ))}
        </PaneTabList>
      </PaneHeader>
      <PaneContent>
        <SlotOutlet slotKey="workspace.pane.content" context={{ paneId: pane.id }} />
      </PaneContent>
    </Pane>
  ))}
  {branches.map((b) => (
    <PaneSplitter key={b.id} branchId={b.id} direction={b.direction} ratio={b.ratio} />
  ))}
</PaneGroup>
\`\`\`

---

### 8.3 统一分形视窗协议（Unified Pane Tree Protocol）消除终端双重分屏特化

彻底推翻 \`TerminalCard\` 中的内嵌分屏实现，实现全桌面大一统：

1. **终端分屏向上提升**：
   - 当用户在终端操作条中点击“向右拆分终端”按钮时；
   - 不再在 \`TerminalCard\` 内部修改私有的 \`splitMode\`；
   - 而是直接向全局 \`layoutTreeStore\` 派发原生的分裂指令：
     \`\`\`typescript
     splitLeaf(tree, currentLeafId, 'horizontal', 'after', 0.5);
     \`\`\`
   - 全局二叉树自动为用户创建一个新的分屏窗格，并在新窗格中直接挂载第二个终端！
2. **重构收益**：
   - 立即删除 \`TerminalCard.tsx\` 中 40% 的分屏样板代码；
   - 立即删除 \`TerminalToolbar.tsx\` 中复杂的 \`splitMode\` 状态管理；
   - 终端分屏瞬间获得外层原生 Sash 的所有高级能力（像素级防坍塌、无障碍键盘微调、双击恢复 0.5 均分、拖拽吸附高亮）。

---

### 8.4 CSS 现代化重构规范（CSS Subgrid / Container Queries 替代深层穿透）

1. **全面清剿所有 \`!important\`**：
   - 改造基础组件库 \`<Input>\`，提供无边框/透明底的语义变体（\`variant="ghost"\`），让 \`PreviewCard\` 地址栏通过属性原生渲染，彻底淘汰 7 个 \`!important\`；
   - 工具坞抽屉的最大化改造为标准的类名切换，在 CSS 规则中通过特异性对齐，彻底淘汰 4 连击 \`!important\`。
2. **彻底废除通配符 \`> *:not(...) > *\`**：
   - 将 \`.leafChatColumn\` 与视窗内容容器改造为标准的 CSS Grid 或 Flex 容器；
   - 直接给子元素显式标注原子样式类 \`.paneFillRoot { flex: 1 1 0%; width: 100%; height: 100%; min-height: 0; }\`；
   - 结构清晰可见，绝不在父容器上写任何穿透式猜测选择器。
3. **桌面端环境变量自适应避让**：
   - 彻底废除 \`padding-left: 52px / 106px\` 与 \`padding-right: 112px\` 的硬编码；
   - 改为通过 CSS 变量由最外层桌面环境统一注入：
     \`\`\`css
     .paneHeader {
       padding-left: var(--titlebar-left-reserved, 4px);
       padding-right: var(--titlebar-right-reserved, 4px);
       height: var(--pane-header-height, 36px);
     }
     \`\`\`
   - 顶层窗口在 macOS 下自动派生 \`--titlebar-left-reserved: 80px\`，Windows 下自动派生 \`--titlebar-right-reserved: 120px\`，叶子组件无需感知操作系统类型。

---

### 8.5 统一焦点管理状态机（Focus Scope Provider）

- 淘汰 \`closest('button, input, ...')\` 长达 20 项的选择器硬编码；
- 引入类似现代无障碍标准的 **Focus Scope** 机制：
  \`\`\`tsx
  <PaneFocusScope paneId={pane.id} onFocus={() => setGlobalActivePane(pane.id)}>
    {/* 窗格所有内容 */}
  </PaneFocusScope>
  \`\`\`
- 在容器上监听原生的 \`onFocusCapture\` 与 \`onBlurCapture\` 事件，通过 DOM 原生的事件流驱动焦点切换，精确、轻量且具备 100% 的组件普适性。
`;
