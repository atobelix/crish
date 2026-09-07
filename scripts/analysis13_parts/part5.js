export const part5 = `
---

## 5. 多视窗聚焦状态同步与生命周期调度（Multi-Pane Focus Sync & Lifecycle Management）

### 5.1 双层焦点解耦模型：树级 \`activeLeafId\` 与叶内 \`activeTabId\` / \`activePanelId\`

在单视窗应用中，当前激活项由一个全局的会话 ID 决定；但在多分屏分形树架构中，如果依然沿用单层全局 ID，将导致多分屏状态彻底混乱（例如用户点击左边，右边的工具栏被迫跟随联动）。

系统通过**双层焦点解耦模型**成功实现了窗格自治与全局协同：

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│ 全局焦点层: useLayoutTreeStore((s) => s.activeLeafId)                  │
│ - 标识当前哪一个分屏叶子处于物理输入和键盘快捷键的受控态                    │
│ - 仅负责：加深活动卡片的发丝边框色 (border-color: var(--border-color))   │
│ - 绝不干涉各叶子内部的显示内容                                        │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ 派发到物理窗格
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 窗格自治层: TreeLeafPanel (leaf.id === activeLeafId)                   │
│ ├── 1. 主对话列焦点: readActiveTabId(leaf)                              │
│ │   - 决定主对话区渲染哪一个会话（SessionTab）                          │
│ │   - 若为空字符串 ""，则进入独立的草稿态（Draft Composer）            │
│ └── 2. 右侧工具坞焦点: leaf.dock.activePanelId                         │
│     - 决定当前叶内抽屉展示的是 'preview'、'terminal' 还是 'runtime'   │
│     - 决定抽屉是展开还是折叠 (dock.collapsed)                         │
└────────────────────────────────────────────────────────────────────────┘
\`\`\`

#### 架构收益：
- **多任务真并发**：左窗格可以停留在一个长文本阅读会话，右窗格可以停留在终端跑编译命令，两个窗格互不干扰各自的活动状态；
- **焦点切换零重绘**：切换全局 \`activeLeafId\` 仅仅改变两个 \`<div>\` 的边框颜色属性，不会触发任何会话内容的卸载或重建。

---

### 5.2 跨窗格事件委托与交互穿透拦截

在 \`TreeLeafPanel.tsx:195-218\` 中，为了实现“点击卡片任何非交互区域即可切换激活该窗格”，外层容器监听了 \`onPointerDown={handleActivate}\`。
然而，如果用户正在卡片内部点击输入框打字、点击按钮提交、或者在终端选中文本，这一事件冒泡如果被粗暴捕获，就会瞬间抢夺原生控件的焦点。

为此，系统构建了一道极为严格的**交互穿透拦截白名单防线**：

\`\`\`typescript
const handleActivate = useCallback(
  (e?: React.PointerEvent) => {
    if (e && e.target && 'closest' in (e.target as HTMLElement)) {
      const target = e.target as HTMLElement;
      // 拦截 20 余种表单元素、富文本、无障碍角色与专用终端画布
      if (
        target.closest(
          'button, input, textarea, select, a, summary, [role="button"], ' +
          '[role="menuitem"], [role="menu"], [role="combobox"], [role="listbox"], ' +
          '[role="option"], [role="tab"], [role="switch"], [role="dialog"], ' +
          '[role="toolbar"], [contenteditable="true"], [data-interactive], ' +
          '[data-radix-popper-content-wrapper], [data-interactive="true"], ' +
          '[data-pty-host], [class*="xtermHost"], .xterm, canvas, .xterm-screen'
        )
      ) {
        return; // 处于交互控件内部，终止聚焦拦截，放行原生行为
      }
    }
    if (chatMainSurface !== 'chat') return;

    const tabId = readActiveTabId(leaf);
    if (tabId) {
      sessionShell().activateTab(leaf.id, tabId);
    } else {
      getCompositionRoot().shell.focusLeaf(leaf.id);
    }
  },
  [leaf, chatMainSurface]
);
\`\`\`

#### 评价与隐患：
虽然该白名单成功解决了绝大多数表单和 xterm 终端的点击穿透问题，但使用长达数百字符的选择器字符串 \`closest(...)\` 进行 DOM 树向上递归回溯，在性能上存在开销；且未来若引入新的富文本原语，若未登记在此字符串中，将再次引发焦点抢夺 Bug。

---

### 5.3 会话身份漫游与草稿哨兵机制

在多分屏系统中，用户经常点击“新建对话（+）”。
传统架构往往会立即在底层数据库创建一条空的会话记录，并生成标签页。这会导致数据库产生大量无用的“幽灵空会话”，且标签栏被空白标签占满。

#### Conex 的草稿哨兵机制（Draft Sentinel）：
1. **未提交新对话绝对不占标签栏**：点击新建对话时，\`leaf.activeTabId\` 被重置为空字符串 \`""\`；
2. **草稿哨兵隔离**：通过 \`mintDraftSessionId(leaf.id)\`（如 \`draft-leaf-123\`）为当前窗格分配专属的临时内存 ID；
3. **真实会话物化**：用户在 Composer 中输入第一条指令并敲击回车成功发送后，系统才调用后端 IPC 正式创建会话 UUID，随后将该真会话物化为 \`SessionTab\`，并以优雅动画插入当前叶子的 \`tabs\` 数组中。

---

### 5.4 视窗内容卸载与保活权衡

在右侧工具坞抽屉（\`leafDockDrawer\`）中，用户常常需要频繁在“浏览器预览”和“终端”之间来回切换。
如果每次切换都卸载（Unmount）旧组件：
- 浏览器 iframe 将重新加载页面，丢失滚动条位置和用户填写的表单；
- xterm.js 终端将重置，断开与 PTY 的数据流，丢失清屏历史。

在 \`TreeLeafPanel.tsx:502-536\` 中，系统通过 \`tabModeEnabled\` 策略实现了**基于 CSS \`display\` 的 DOM 级完全保活**：
\`\`\`tsx
{dock.openPanelIds.map((pid) => {
  const isActive = pid === toolPanelId;
  return (
    <div
      key={pid}
      className={styles.dockPanelPane}
      style={{
        display: isActive ? 'flex' : 'none',
        flex: '1 1 auto',
        width: '100%',
        height: '100%',
      }}
      data-panel-id={pid}
      data-active-panel={isActive ? 'true' : 'false'}
      aria-hidden={!isActive}
    >
      {renderToolOutlet(pid)}
    </div>
  );
})}
\`\`\`
- **收益**：所有已打开的工具保持完整的内存和 DOM 状态，切回时即时展现（0 延迟）；
- **代价**：后台未激活的视窗依然驻留在 DOM 中，若同时打开数十个终端和重型浏览器页面，内存占用会线性上升。

---

### 5.5 外部系统与底层资源联动

多视窗系统绝不仅是前端 UI，它深度粘合了操作系统的底层系统资源：

1. **终端 PTY 进程硬绑定与回收**：
   在 \`TreeLeafPanel.tsx:270-284\` 中执行了严格的进程生命周期纪律：
   \`\`\`typescript
   if (panelId === 'terminal' || panelId.startsWith('terminal:')) {
     void import('../../api/ptyRegistry').then((m) => {
       const sKey = sessionForPanel || '_global';
       const targetKey = panelId === 'terminal' ? sKey : \`\${sKey}:\${panelId}\`;
       void m.killPtyForSession(targetKey);
       void m.killPtyForSession(panelId);
       void m.killPtyForSession(\`\${targetKey}:split-2\`);
     });
   }
   \`\`\`
   只要标签页被关闭，对应的底层操作系统子进程（pwsh.exe / bash）必被立即销毁，杜绝任何后台僵尸进程。
2. **预览浏览器透明代理与 Favicon 动态嗅探**：
   通过本地透明代理剥离外部站点的 XFO 限制，并在宿主与 iframe 之间建立高频的双向事件广播（\`crish-preview-url\`、\`crish-preview-favicon\`）。
`;
