# 侧栏拖拽演进：全景焦点同步、视觉同构、空态作用域隔离与零抖动动力学方案 (Main Agent Stage 4 Plan)

> **文档位置**：`docs/sidebar-session-drag-refactor/06-main-agent-stage4-plan.md`
> **战役阶段**：Stage 4 (Deep Interaction & Visual Homomorphism)
> **设计基准**：严格遵守 `AGENTS.md` §1（反退避）、§7（严禁补丁）、§7.1（立体验证纪律）、§8（反过度设计红线）。

---

# 目录索引

- [一、 四大交互与视觉痛点定义](#一-四大交互与视觉痛点定义)
- [二、 深层根因穿透与架构设计](#二-深层根因穿透与架构设计)
  - [2.1 痛点 1：分屏后焦点同步与视图激活丢失（Leaf Focus & Session Activation）](#21-痛点-1分屏后焦点同步与视图激活丢失leaf-focus--session-activation)
  - [2.2 痛点 2：空状态欢迎页（ChatEmptyState）文字跨窗口联动乱跳](#22-痛点-2空状态欢迎页chatemptystate文字跨窗口联动乱跳)
  - [2.3 痛点 3：侧栏拖拽排序时列表“整体微抖动”（Subpixel Reflow & Containment）](#23-痛点-3侧栏拖拽排序时列表整体微抖动subpixel-reflow--containment)
  - [2.4 痛点 4：侧栏会话与顶栏标签的视觉同构（高度 28px、圆润 8px 圆角、跨域行内自由插排）](#24-痛点-4侧栏会话与顶栏标签的视觉同构高度-28px圆润-8px-圆角跨域行内自由插排)
- [三、 详细代码级改造清单](#三-详细代码级改造清单)
- [四、 五层立体验证模型](#四-五层立体验证模型)

---

## 一、 四大交互与视觉痛点定义

根据用户实机测试与现场截图，当前存在 4 个高优先级痛点：

1. **分屏后焦点未同步且界面未实时加载**：从侧栏拖拽会话到右侧完成二叉树分屏后，新窗格未自动设为当前激活 Leaf，且会话内容未自动挂载激活，需要用户手动在对应窗口点击一下才能显示界面；
2. **空状态欢迎页文字跨窗口乱跳**：多窗口分屏下，一个窗口切换标签，其他窗口的欢迎面标题文字（如“我们该在 conex 中处理什么？”与“我们该在 选择项目 中处理什么？”）全跟着变；
3. **拖拽排序时列表整体微抖动**：拖拽在列表内移动时，整个列表容器发生肉眼可见的微小抖动；
4. **侧栏与顶栏视觉不统一 & 缺少跨域顶栏行内自由插排**：侧栏会话高度为 28px、圆角 8px，而顶栏 Tab 高度为 26px、圆角 4px；且从侧栏拖入顶栏时未能像原生 Tab 一样在标签行内自由产生 `translateX` 避让并指定下标插入。

---

## 二、 深层根因穿透与架构设计

### 2.1 痛点 1：分屏后焦点同步与视图激活丢失

#### 根因剖析
- 在 `layoutTreeStore.ts` 的 `splitSessionFromSidebar` 中，虽然通过 `collectLeaves` 找到了新建的叶节点 `freshLeaf` 并更新了 `tree.activeLeafId`，但**未通知 `sessionStore` 和全局 `CompositionRoot` 执行 `openOrFocusSession(sessionId, ...)`**；
- 导致 React 树重新渲染时，新叶节点虽然挂载了，但其对应的会话状态未完成加载，处于脱水等待状态，直到用户点击窗口触发 `onClick` 里的 `setActiveLeaf` + `openOrFocusSession`。

#### 根治架构
在 `commitSidebarSessionDrop` 中：
```typescript
if (target.kind === 'pane') {
  const root = getCompositionRoot();
  // 1. 执行二叉树分屏算子
  tree.splitSessionFromSidebar(sessionId, target.targetLeafId, target.region);

  // 2. 获取新建/切分出的目标叶节点
  const latestTree = tree.getState().tree;
  const leaves = collectLeaves(latestTree.root);
  const targetLeaf = leaves.find((l) => l.tabs.some((t) => t.sessionId === sessionId));

  // 3. 立即原子转移焦点并激活该会话实体
  if (targetLeaf) {
    tree.setActiveLeaf(targetLeaf.id);
    const s = root.session.getState().sessionsById[sessionId];
    root.session.openOrFocusSession(sessionId, {
      title: s?.title,
      workspaceKey: s?.folder || currentWorkspaceFolderKey(getActiveProjectId()),
    });
  }
}
```

---

### 2.2 痛点 2：空状态欢迎页（ChatEmptyState）文字跨窗口联动乱跳

#### 根因剖析
- `ChatEmptyState.tsx` 内部直接调用了全局单例 `getActiveProject()`；
- 当窗口 A（属于未绑项目的草稿）获得焦点时，全局 `activeProjectId` 变为了 `null`；窗口 B（属于项目 `conex`）在重绘时读取了全局 `getActiveProject()`，导致其标题立刻从 `conex` 跳成了 `选择项目`！

#### 根治架构
- `ChatEmptyState` 增加 `workspaceKey?: string` 可选属性（由父级 `ChatCard` / `LeafNode` 从当前渲染的 `tab.workspaceKey` 传入）；
- 解析项目名时：
  ```typescript
  const activeProject = workspaceKey ? getProjectById(workspaceKey) : getActiveProject();
  ```
- 实现真正的**分屏窗口项目上下文隔离（Pane-Scoped Workspace Isolation）**。

---

### 2.3 痛点 3：侧栏拖拽排序时列表“整体微抖动”

#### 根因剖析
1. **容器无约束重排（Subpixel Reflow）**：在对 `li` 施加 `translateY` 时，如果父级 `ul.pinnedList` / `div.accordionInner` 没有声明 `contain: layout style`，浏览器的合成器（Compositor）会将内联位移冒泡计算到父容器的高度与滚动条包围盒上，产生 0.5px 的亚像素重排抖动；
2. **外边距折叠与行高浮动**：列表项如果存在微小的垂直 margin，在 `translateY` 介入时会引起父容器尺寸微变；
3. **滚动条抖动**：长列表虚拟化如果触发了 `spacer` 重新计算，会引起视口滚动条高度跳变。

#### 根治架构
1. 为侧栏会话容器注入严格的 CSS 隔离与硬件加速：
   ```css
   .listScroll,
   .accordionInner,
   .folderSessions,
   .pinnedList {
     contain: layout paint;
     transform: translateZ(0);
   }

   .sessionItemWrap {
     contain: strict;
     will-change: transform;
   }
   ```
2. 规范所有行高为绝对定高 `28px`，`margin: 0`，`box-sizing: border-box`，彻底消除回流。

---

### 2.4 痛点 4：侧栏会话与顶栏标签的视觉同构

#### 视觉规范统一
1. **圆角统一（Pill Radius）**：
   - 侧栏会话项与顶栏 Tab 项一律采用精致圆润的 `border-radius: var(--radius-md, 8px)`；
2. **高度统一（Row Height）**：
   - 顶栏 Tab 项高度由 `26px` 统一调整为 `28px`（`.tabsTrack` 与 `.header` 调整为 `38px`，内部 Tab 项居中排列，高 `28px`），与侧栏会话完全一致；
3. **跨域行内自由插排（Cross-Domain Tab Strip Reorder）**：
   - 当侧栏会话拖入某个窗格的 TabStrip 顶栏时：
     - 调用 `sessionTabDragFeel.ts` 中的 1D 水平位移计算，为该窗格的 Tab 项应用 `translateX` 让位；
     - 松手时直接调用 `tree.moveTab` 或 `tree.openSession` 插入到指定的 `insertIdx` 并自动激活！

---

## 三、 详细代码级改造清单

| 改造模块 | 改造内容 |
| :--- | :--- |
| `apps/crish-desktop/src/components/chat-card/ChatEmptyState.tsx` | 接收 `workspaceKey`，实现窗口级独立项目解析，杜绝全局乱跳 |
| `apps/crish-desktop/src/components/chat-card/ChatCard.tsx` | 向 `ChatEmptyState` 传递当前 Tab 的 `workspaceKey` |
| `apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts` | 分屏与 Tab 插入后同步执行 `setActiveLeaf` 与 `openOrFocusSession` |
| `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css` | 标签高度调整为 `28px`，圆角调整为 `8px`（圆润风格） |
| `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css` | 会话列表容器注入 `contain: layout paint`，根除整体抖动 |
| `apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts` | 接入顶栏 TabStrip 悬停时的水平让位动力学与精准下标提交 |

---

## 四、 五层立体验证模型

- **第 1 层**：`npm run typecheck` 100% 零编译错误；
- **第 2 层**：108 个单元测试全部通过，补充分屏焦点转移与 Tab 尺寸测试；
- **第 3 层**：设计规范与 CSS Token 合规验证；
- **第 4 层**：真实桌面环境中验证：
  - 分屏后新窗口立即高亮并自动呈现对应对话内容；
  - 切换标签时，各分屏窗口空状态文字各自独立、稳定；
  - 侧栏拖拽移动平滑如丝、零整体抖动；
  - 标签与侧栏会话外观完全圆润同构。
