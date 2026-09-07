export const part7 = `
---

## 7. 现有样式体系坏味道与缺陷全面审计（CSS Code Smells & Architectural Defects）

### 7.1 滥用 \`!important\` 强制覆写排查

在现代原子化 CSS 架构中，\`!important\` 是最高级别的视觉反模式（Anti-Pattern），它彻底摧毁了 CSS 的自然层叠规则（Cascading Rules），通常是组件封装过度、缺少样式插槽、以及强行打补丁的直接产物。

在本次实勘中，发现了多处极其恶劣的 \`!important\` 扎堆滥用：

#### 违规点 1：\`PreviewCard.module.css:52-82\`（连续 7 处 \`!important\`）
\`\`\`css
.urlInput {
  height: 24px !important;
  min-height: 24px !important;
  font-size: var(--font-size-xs, 12px) !important;
  background: transparent !important;
  border: 1px solid transparent !important;
  border-radius: var(--radius-md, 6px) !important;
  box-shadow: none !important;
}

.urlInput::placeholder {
  color: var(--text-tertiary) !important;
}

.urlForm:hover .urlInput:not(:disabled),
.urlInput:focus,
.urlInput:focus-visible {
  outline: none !important;
  background: var(--sidebar-hover, ...) !important;
  border: 1px solid transparent !important;
  box-shadow: none !important;
}
\`\`\`
- **致命根因**：业务层引入了底层的通用 \`<Input>\` 组件，由于通用组件内部写死了较高的特异性（Specificity）并带有默认的灰色边框与聚焦蓝色光环，\`PreviewCard\` 的地址栏为了伪装成极简无框文本框，只能通过连续 7 次连击 \`!important\` 暴力覆盖！

#### 违规点 2：\`BinaryTreeWorkspace.module.css:412-416\`（连续 4 处 \`!important\`）
\`\`\`css
.leafDockDrawer.maximized,
.leafDockDrawer[data-maximized='true'] {
  position: absolute;
  top: 0; bottom: 0; right: 0;
  left: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
  flex: 1 1 100% !important;
  min-width: 0;
  height: 100%;
  border-left: none;
  z-index: 150;
}
\`\`\`
- **致命根因**：为了实现工具坞抽屉全屏最大化，不得不使用 4 个 \`!important\` 来强行覆写常规状态下的 \`flex: 0 0 var(--leaf-dock-width)\` 与 \`width: var(--leaf-dock-width)\`。这暴露出状态切换逻辑与基础布局样式的严重脱节。

---

### 7.2 脆弱的选择器深度穿透与通配符依赖

在 \`BinaryTreeWorkspace.module.css:442-450\` 中，发现了整座仓库中最脆弱、最具破坏性的样式坏味道：

\`\`\`css
/*
 * ErrorBoundary / SlotOutlet 现为 display:contents：> / > * > * 打在包装上，
 * 不改盒树。纸面根若再 contents，header/footer 会升成叶子弹性子项。
 * :not 让二级 fill 打不中 chrome；不要改成 .leafBody *。
 * 坞展开后行布局：fill 只打在对话列内部，不打在 resizer / 抽屉上。
 */
.leafChatColumn > *:not(:global(header)):not(:global(footer)),
.leafChatColumn > * > *:not(:global(header)):not(:global(footer)) {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
  max-height: 100%;
  width: 100%;
}
\`\`\`

#### 架构穿透洞察：
1. **通配符 \`*\` 穿透至二级深层**：开发者试图通过 CSS 子代通配符，强制将对话列内的第一个组件以及其子组件拉伸撑满视口；
2. **负向伪类黑名单排除**：为了防止将标题栏和页脚也拉大，又追加了 \`:not(:global(header)):not(:global(footer))\`；
3. **脆弱的雪崩隐患**：
   - 一旦开发者在 \`.leafChatColumn\` 内部加入一个无害的辅助包装节点（例如一个用于性能监控的 \`<ProfilingWrapper>\`、一个用于主题注入的 \`<ThemeProvider>\`、或一个用于动画过渡的 \`<TransitionGroup>\`）；
   - 该规则会立即打在包装组件上，而真正的对话列表反而因为被推到了三级节点（\`> * > * > *\`）而失去 \`flex: 1 1 0%\`，导致对话流瞬间坍缩为 0 高度！
   - 这是典型的“用脆弱选择器填补架构断层”的下策，严重违反 \`AGENTS.md §7\`（杜绝打补丁铁律）。

---

### 7.3 硬编码尺寸与魔术数字排查

在样式表与组件中，充斥着未经 Token 化的物理魔术数字（Magic Numbers）：

| 文件路径与位置 | 现存代码与魔术数字 | 产生背景与缺陷说明 |
| :--- | :--- | :--- |
| \`PaneHeader.module.css:7-9\` | \`height: 36px; min-height: 36px; max-height: 36px;\` | 窗格头高度硬编码 36px，三次重复锁定，未提取 Token |
| \`LeafToolTabStrip.module.css:11-13\` | \`height: 38px; min-height: 38px; max-height: 38px;\` | 工具栏高度硬编码 38px，与左侧窗格头（36px）竟然存在 2px 的不对称落差！ |
| \`BinaryTreeWorkspace.module.css:92\` | \`.topSidePanelBtn { top: 41px; right: 10px; }\` | 悬浮切换按钮依靠肉眼测距硬编码 41px，一旦顶栏高度微调，立刻错位 |
| \`PaneHeader.module.css:33\` | \`padding-left: 52px;\` | Windows 下侧栏收起时的悬浮避让距离，缺乏上下文协商 |
| \`PaneHeader.module.css:36\` | \`padding-left: 106px;\` | macOS 下侧栏收起时避让左上角红绿灯的硬编码距离 |
| \`PaneHeader.module.css:41\` | \`padding-right: 112px;\` | Windows 下顶行最右叶子避让右上角窗口三键（最小化/最大化/关闭）的硬编码宽度 |
| \`PaneHeader.module.css:44\` | \`padding-right: 38px;\` | macOS 下顶行最右叶子的硬编码内边距 |

---

### 7.4 颜色 Token 割裂与未遵守 \`AGENTS.md §13~14\`

依据全局设计铁律 \`AGENTS.md §13~14\`：
> UI 与 Design Token 优先 \`hsl(h s l / a)\`，避免散落旧式 \`rgba(r,g,b,a)\`；任何情况下焦点/激活态不得使用硬实线，灰色加深混入文本色不超过 10%（常规元素优先 3%~6%）。

#### 实勘违规记录：
1. **旧式 \`rgba(...)\` 残留**：
   - \`BinaryTreeWorkspace.module.css:392\`：\`background: var(--border-color, rgba(128, 128, 128, 0.4));\`
   - \`TerminalCard.module.css:120\`：\`background: var(--bg-active, rgba(0, 0, 0, 0.06));\`
2. **硬编码裸 Hex 色值**：
   - \`BinaryTreeWorkspace.module.css:327\`：\`background: var(--bg-card, #ffffff);\`
   - \`PreviewCard.module.css:110\`：\`background: var(--bg-card, #ffffff);\`
3. **高饱和度彩色高亮**：
   - \`TreeResizeSash\` 在 Hover 时直接亮起高饱和绿 \`#10b981\`，缺乏对深色模式与黑白灰中性主题的平滑过渡。

---

### 7.5 双重分屏体系割裂（外层二叉树分屏 vs 终端内嵌分屏）

这是整个多视窗架构中**最典型的冗余过度设计与架构割裂**：

1. **外层已具备全能二叉树**：\`BinaryTreeWorkspace\` 能够将任意视窗以任意比例、任意方向进行水平或垂直切分；
2. **终端卡片内部重复造轮子**：
   - \`TerminalCard.tsx\` 内部自行维护了一个独立的 \`splitMode: 'none' | 'horizontal' | 'vertical'\`；
   - 在其内部又手写了一套 \`.splitContainer\` 与 \`.splitDivider\`；
   - 导致终端分屏无法享受外层分屏手柄的“像素级防坍塌保护（120px）”、“WAI-ARIA 键盘微调”、“零重绘手势加速”、以及“双击恢复 0.5 均分”等一切高级能力；
3. **严重违背 SSOT**：同样的“分屏”概念在桌面存在两套完全不兼容的实现，必须在原子化重构中彻底予以收敛！
`;
