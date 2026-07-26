# 二叉树布局引擎重构笔记

> 防上下文压缩丢失的进度文档。每次会话结束前更新"待办"与"已完成"。
> 最新更新：2026-07-26（第四轮：跨域防护 + tab 重排 + mergeTabIntoLeaf 去重顺序 bug 修复）

---

## 模块结构

```
src/store/layout-tree/
├── types.ts              ← 二叉树类型 + 工厂函数 + 业务常量
├── operations.ts         ← 纯函数操作（split/merge/move/resize/tab/applyDrop）
├── dropDetection.ts      ← 自适应距离梯度 drop zone 检测
├── layoutTreeStore.ts    ← 独立 zustand store（持久化 + 历史栈 + 拖拽状态）
├── migration.ts          ← 旧 columns/groups → 二叉树迁移
├── index.ts              ← 公共 API barrel
├── operations.test.ts    ← 70 个测试（含 H4 直测）
├── dropDetection.test.ts ← 17 个测试
├── migration.test.ts     ← 19 个测试（含 H4 + skip-if-default 联合行为）
├── layoutTreeStore.test.ts ← 37 个测试
└── REFACTOR_NOTES.md     ← 本文档

src/components/binary-tree/
├── BinaryTreeWorkspace.tsx ← 主入口（canvas + 控制条 + ghost portal）
├── TreeLeafPanel.tsx       ← 叶子面板（tab 条 + 内容懒加载）
├── TreeResizeSash.tsx      ← 分割线（拖拽 + 键盘）
├── DropZoneOverlay.tsx     ← 落点预览 portal
└── BinaryTreeWorkspace.module.css
（注：index.ts barrel 已删除 — 外部消费者用直接文件路径，内部用相对路径，
 barrel 0 引用属于死代码）

src/hooks/
├── useTreeDrag.ts   ← 拖拽控制器（leaf/tab 拖拽生命周期）
└── useTreeResize.ts ← resize 控制器（branch 分割线拖拽）
```

---

## 接入方式

`App.tsx` 用 `useTreeWorkspace` flag 在新/旧工作区之间切换：

```tsx
{useTreeWorkspace ? (
  <BinaryTreeWorkspace onShowToast={handleShowToast} />
) : (
  workspaceIds.map((id) => <Workspace key={id} wsId={id} ... />)
)}
```

**双轨并存**：旧 `Workspace.tsx` → `CardPanel` → `useTabDrag` → `tab-drag/` 链是活跃 fallback，**不能清理**。

---

## 已完成（2026-07-26）

### 第四轮：跨域防护 + tab 重排 + mergeTabIntoLeaf 去重顺序 bug 修复

#### 1. 跨域防护（types.ts + operations.ts + useTreeDrag.ts）

**用户需求**：对话区域内的标签只能和对话区域排序；功能区只能和功能区的窗口相拖拽。

**实现**（系统性设计，3 层防御）：

1. **types.ts**：新增 `isChatDomain(panelId)` + `isSameDomain(p1, p2)` 纯函数
   - `chat` panelId 属于对话域，其余（`diff` / `terminal` / `files` / `agent` 等）属于功能区
   - 同域 = 两者同属对话域或同属功能区
2. **operations.ts > applyDrop**：跨域 leaf/tab 拖拽被拒绝，返回原 tree
   - 同 leaf 操作（`srcLeafId === targetLeafId`）始终放行（tab 重排场景）
   - 跨 leaf 操作校验 `isSameDomain(srcPanelId, targetNode.panelId)`
3. **useTreeDrag.ts > handlePointerMove**：拖拽中实时跨域检查
   - `findLeafAtPointer` 返回的 hit leaf 若与 source 跨域 → `updateZone(null)` 不显示 drop zone
   - 避免 pointerup 时 applyDrop 拒绝造成的"拖了一整下没反应"体验

**关键决策**：同 leaf 始终放行
- 该路径仅出现在 tab 拖拽到自身 leaf（merge-tab 同 leaf 重排）
- tab 已在该 leaf 中，无跨域问题可言
- 若强行校验 srcTabId 的域 vs leaf.panelId，会误伤 leaf 含混合域 tab 的边界场景

#### 2. tab 重排（operations.ts > reorderTabInLeaf + mergeTabIntoLeaf）

**用户需求**：如果一个窗口内有多个标签，支持在当前窗口内分配区域（tab 排序）。

**实现**：

1. **reorderTabInLeaf**：纯函数，将 leaf 内的 `fromTabId` 移到 `targetTabId` 之前
   - 若 `targetTabId` 未指定或已不存在，`fromTabId` 追加到末尾
   - `activeTab` 切换为 `fromTabId`（用户拖的 tab 即为激活）
2. **mergeTabIntoLeaf 同 leaf 短路**：
   - `srcLeafId === targetLeafId` + 有 `targetTabId` → 委托 `reorderTabInLeaf`
   - `srcLeafId === targetLeafId` + 无 `targetTabId` → 委托 `setLeafActiveTab`（仅切换激活）
   - 避免 removeTab 导致 leaf 被删的旧 bug
3. **DropZone.targetTabId 字段**：dropDetection.ts 的 `DropZone` 接口已含 `targetTabId?` 字段
   - useTreeDrag 中 `detectTabAtPointer` 待实现（见待办）

#### 3. mergeTabIntoLeaf 去重顺序 bug 修复（operations.ts）

**真实 bug**：tab 合并到已有该 tab 的 target 时，旧实现 `filter+push` 改变了 tabs 顺序。

**复现**：
- target.tabs = `['diff', 'files']`
- srcTabId = `'diff'`（已在 target 中）
- 旧实现：`newTabs = target.tabs.filter(t => t !== srcTabId)` → `['files']`，然后 `push(srcTabId)` → `['files', 'diff']`
- 期望：tabs 顺序不变 `['diff', 'files']`，仅切换 activeTab

**根因**：去重 ≠ 重排。tab 已存在时应保持原顺序，仅切换 activeTab。

**修复**：
```typescript
if (targetLeaf.tabs.includes(srcTabId)) {
  newTabs = targetLeaf.tabs;  // 保持原顺序
} else {
  newTabs = [...targetLeaf.tabs];
  // 按 targetTabId 插入或追加末尾
}
```

#### 4. 测试同步修正（operations.test.ts + layoutTreeStore.test.ts + useTreeDrag.test.ts）

**问题**：跨域防护生效后，原测试用 `branch(chat, diff)` 跨域树验证 split / merge-tab 正常路径，全部被拒绝。

**系统性修复**：
- **operations.test.ts**：`applyDrop — leaf → merge-tab` 4 个测试改用同域 tool panels（`diff` / `terminal` / `files` / `agent`）
- **operations.test.ts**：`applyDrop — tab → merge-tab > tab 是源 leaf 的最后一个` 改用 `terminal` + `files` 同域
- **operations.test.ts**：新增 `跨域拖拽被拒绝：chat leaf → diff leaf（split-left）返回原 tree` 验证域隔离
- **layoutTreeStore.test.ts**：`commitDrop 4 条路径` 路径 1/2 改用 `makeSameDomainTwoLeafTree()`（branch(diff, terminal)）
- **useTreeDrag.test.ts**：`makeTwoLeafTree` 改为 `branch(diff, terminal)` 同域树
- **useTreeDrag.test.ts**：`makeLeafDOM` 新增 `panelId` 参数，所有调用点传入对应 panelId（否则 collectLeafRects 默认 'chat'，与 store 真实 panelId 不一致）

**变量重命名**（语义清晰）：
- `chatId` → `diffId`（左侧 leaf，panelId='diff'）
- `diffId` → `terminalId`（右侧 leaf，panelId='terminal'）

---

### 第三轮：useTreeDrag 测试 + layoutTreeStore 测试修正 + 孤儿函数清理

#### 1. useTreeDrag.test.ts 创建（14 个测试，覆盖 8 大维度）

新建 `src/hooks/useTreeDrag.test.ts`，集成测试覆盖拖拽生命周期所有关键路径：

| 维度 | 测试数 | 覆盖点 |
| ---- | ------ | ------ |
| 拖拽启动 | 4 | startDragLeaf/Tab pending 阶段、非左键拒绝、多指拒绝 |
| 阈值过渡 | 2 | < 5px 不进入 active、≥ 5px 进入 active |
| zone 去重 | 2 | 同 zone 多次 pointermove 仅 1 次 store 更新、zone 切换触发更新 |
| 多指隔离 | 2 | 第二指 pointermove 被忽略、第二指 pointerup 不结束拖拽 |
| resize 重收集 | 1 | 拖拽中 window resize → cachedLeafRects 更新 |
| 拖拽取消 | 3 | escape key、pointercancel、cancelDrag() |
| 同 leaf 防自拖 | 1 | leaf 拖拽到自身 leaf → zone=null |
| 拖拽提交 | 2 | pointerup 提交 + 推历史、pending 阶段 pointerup 不提交 |

**测试策略（系统性设计）**：

- 真实 store（不 mock）：用 `useLayoutTreeStore.setState` 直写绕过持久化
- 真实 DOM（jsdom）：创建 `data-tree-canvas` + `data-leaf-id` 元素，mock `getBoundingClientRect`
- 真实事件：`window.dispatchEvent(new PointerEvent(...))` 模拟原生事件
- 订阅计数：`useLayoutTreeStore.subscribe` 监听 `activeDropZone` 引用变化次数（= setActiveDropZone 调用次数）
- 时间控制：`vi.spyOn(performance, 'now')` + `advanceTime(ms)` 控制 16ms 节流

**关键修复（测试过程中发现的真实 bug）**：

1. **performance.now() 节流跳过**：jsdom 中 `act()` 同步执行，多次 act 间真实时间差为 0 → drop zone 检测被节流短路。修复：mock `performance.now()` + `advanceTime(20)` 推进到下一帧。
2. **首帧 drop zone 延迟**：`enterActive` 后 `return` 导致首帧（~16ms）无反馈。修复：移除 `return`，让 active 分支立即检测，并重置 `lastDropDetectRef.current = 0`。
3. **多指干扰**：第二指 pointermove 被误处理为第一指延续，导致 ghost 跳跃。修复：pending/active 阶段都校验 `e.pointerId !== pending/active.pointerId`。
4. **冗余 store 更新**：`handlePointerUp/Cancel` 调用 `setDraggedSource(null)` 与 `commitDrop`/`cancelDragStore` 重复。修复：移除冗余调用（store 已清理）。

#### 2. layoutTreeStore.test.ts 修正：onRehydrateStorage 真实触发

**问题**：原测试通过 `setState` 写入持久化数据后立即读 `getState()`，但 `onRehydrateStorage` 仅在 `persist.rehydrate()` 异步触发时执行，原测试从未验证该回调。

**修复**：用 `useLayoutTreeStore.persist.rehydrate()` 显式触发 hydration，验证：
- 临时状态（`past`/`future`/`draggedSource`/`activeDropZone`）被清空
- `activeLeafId` 被修正到树中仍存在的 leaf

#### 3. 孤儿函数清理（operations.ts + layoutTreeStore.ts + index.ts）

**系统性识别方法**：grep 全仓库符号引用，区分"内部互引"vs"外部消费者引用"vs"测试引用"。仅外部消费者引用计入有效引用，测试引用单独保留。

**operations.ts 删除（5 个孤儿函数）**：

| 函数 | 行数 | 删除理由 |
| --- | --- | --- |
| `collectBranches` | ~15 | 0 引用（被 `flattenTree` 的 branches 输出取代） |
| `treeDepth` | ~10 | 0 引用（无渲染/逻辑消费 depth） |
| `flattenToRenderList` | ~30 | 0 引用（被 `flattenTree` 取代，仅自身定义） |
| `flattenBranches` | ~20 | 0 引用（同上，flattenTree 已合并 leaves + branches） |
| `serializeTree` / `deserializeTree` | ~40 | 0 引用（持久化由 zustand persist middleware 处理） |

**layoutTreeStore.ts 删除（4 个 selector 工厂）**：

| Selector | 删除理由 |
| --- | --- |
| `selectTree` | 0 外部引用（消费者统一用 `useLayoutTreeStore(s => s.tree)`） |
| `selectDraggedSource` | 同上 |
| `selectActiveDropZone` | 同上 |
| `selectActiveLeafId` | 同上 |

**index.ts barrel 收紧**：

- 移除上述孤儿函数的 re-export
- 新增 `isZoneSame` 导出（外部消费者：useTreeDrag）
- 文档化维护规则："新增内部 API 不自动加入 barrel；仅当外部消费者实际需要时才导出"

**operations.test.ts 同步清理**：

- 移除 `flattenToRenderList`、`flattenBranches`、`serializeTree`、`deserializeTree` 的测试（被测函数已删除）
- 保留 `flattenTree` 测试（render 层核心，单次遍历计算 leaf + branch rect）

#### 4. dropDetection.ts 新增 isZoneSame + 测试

新增 `isZoneSame(a, b)` 纯函数：DropZone 浅相等比较（仅比较 `type + targetLeafId`，`confidence` 不参与）。

**系统性约束**：拖拽期间 tree 不可变（`commitDrop` 仅 pointerUp 触发），故 `targetLeafId` 在单次拖拽内是稳定标识符，可作为相等判据。

`dropDetection.test.ts` 新增 7 个测试覆盖：null 安全、引用相等短路、语义相等（confidence 浮动）、type 变化、targetLeafId 变化、5 种 zone 类型全覆盖。

#### 5. 测试统计

- **tsc -b**：通过（exit 0）
- **layout-tree + useTreeDrag 专项**：157/157 通过
  - operations.test.ts: 70
  - migration.test.ts: 19
  - layoutTreeStore.test.ts: 37
  - dropDetection.test.ts: 17（+7 isZoneSame）
  - useTreeDrag.test.ts: 14（新建）
- **vitest 全量**：2981 passed / 13 failed（13 个均为预存问题，见下）

---

### 第二轮：H4 测试修正 + 孤儿文件清理

#### 1. H4 测试期望修正（migration.test.ts）

**问题**：原 H4 测试 `空 cards + 空 activeCardId → 迁移后 leaf tabs=["chat"]` 期望 `migrateLayoutIfNeeded()` 返回 `true`，但实际返回 `false`。

**根因分析（系统性）**：

- H4 修复在 `createLeaf` 工厂函数层归一化 `tabs=[]` → `['chat']`
- 这让 `migrateFromColumns(legacyEmptyCardsGroup)` 产生的迁移结果 = 默认树（单 chat leaf + tabs=['chat']）
- `migrateLayoutIfNeeded` 中的 `isTreeInDefaultState(migratedTree)` 检测到迁移结果与默认树等价 → 触发 **skip-if-default** 短路 → 返回 `false`（避免无意义历史）

这是两条独立设计决策的联合行为：

1. H4：空 cards 归一化为 chat 默认（防不变量违反）
2. skip-if-default：迁移结果等价于默认树时跳过写入（防历史污染）

两者都正确，但联合导致测试期望与实际行为不符。

**修复**：

- migration.test.ts：测试名改为 `H4: 空 cards + 空 activeCardId → 归一化为默认树 → skip-if-default 跳过写入`，期望 `result === false`，仍验证 store 中的默认树满足不变量
- operations.test.ts：新增直测 `H4: 空 cards + 空 activeCardId → 归一化为 chat 默认 leaf（满足不变量）`，直接调用 `migrateFromColumns` 绕过编排层，验证 H4 修复在操作层正确

#### 2. 孤儿文件清理

| 文件                                   | 行数 | 删除理由                                                                                  |
| -------------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| `src/hooks/tab-drag/useTreeTabDrag.ts` | 306  | 旧版拖拽引擎，被 `useTreeDrag.ts` 取代，全仓库 0 引用（仅自身定义）                       |
| `src/components/binary-tree/index.ts`  | 11   | 公共 API barrel，但外部消费者（App.tsx）用直接文件路径，内部组件用相对路径，barrel 0 引用 |

删除前验证：

- `grep -r "useTreeTabDrag" src/` → 仅匹配自身定义
- `grep -r "from '.*binary-tree['\"]" src/` → 0 匹配（所有 import 都指定到具体文件）

#### 3. 测试统计更新

- **tsc -b**：通过（exit 0）
- **layout-tree 专项**：143/143 通过（was 142，+1 新 H4 直测）
  - operations.test.ts: 70（was 69，+1）
  - migration.test.ts: 19（不变，仅修正期望）
  - layoutTreeStore.test.ts: 37
  - dropDetection.test.ts: 17

### 第一轮：拖拽逻辑系统性优化（useTreeDrag.ts）

1. **DropZone 去重**：新增 `lastZoneRef` + `isZoneSame` 纯函数 + `updateZone` helper。
   - 旧实现：`pointermove` 每 16ms 调用 `setActiveDropZone(zone)`，`detectDropZone` 每次返回新对象引用 → 即使 zone 语义不变也触发 store set → `DropZoneOverlay` re-render + `getBoundingClientRect`。
   - 新实现：仅当 `type + targetLeafId` 变化时才推 store。`confidence` 浮动不再触发无效更新。

2. **viewport resize 重收集 leaf rects**：
   - 旧实现：`cachedLeafRectsRef` 在 `enterActive` 时一次性收集，假设拖拽期间 DOM rect 稳定。窗口 resize 时缓存失效，drop zone 检测用过时坐标。
   - 新实现：新增 effect 在拖拽期间监听 `window resize`，触发 `collectLeafRects()` 重收集。

3. **effect 关注点拆分**：
   - 旧实现：单一 effect 依赖 `[isDragging, ...handlers]`，混合"事件订阅"与"body class"。`isDragging` 每次手势起止各切换一次 → 触发 cleanup + 重新订阅事件，但 handlers 稳定，重新订阅是无效开销。
   - 新实现：拆为三 — 事件订阅（依赖 handlers，理论从不重挂载）/ body class（依赖 isDragging）/ resize 重收集（依赖 isDragging）。

### 孤儿代码清理（2026-07-26）

删除 6 个确认无外部引用的孤儿文件：

| 文件                                               | 删除理由                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `components/workspace-tree/LayoutTreeRenderer.tsx` | 旧渲染器，被 BinaryTreeWorkspace 取代，无 import 引用                              |
| `components/workspace-tree/DropIndicator.tsx`      | 旧 drop 指示器，被 DropZoneOverlay 取代，无 import 引用                            |
| `components/DropIndicatorLayer.tsx`                | 旧 drop 层，无 import 引用                                                         |
| `components/drag/GlobalDragOverlay.tsx`            | 旧 ghost 浮层，ghost 已内联到 BinaryTreeWorkspace，无 import 引用                  |
| `utils/collisionDetection.ts`                      | 旧 `fiveZoneDetection`/`nestedCollisionDetection`，被 dropDetection 取代，仅自引用 |
| `utils/collisionDetection.test.ts`                 | 上述文件的测试                                                                     |

同步更新 `BinaryTreeWorkspace.tsx` 与 `useTreeDrag.ts` 中 2 处指向 `GlobalDragOverlay` 的过时注释为"内联 ghost"描述。

### 此前已完成（摘要）

- `migrateFromColumns` group ratio 修复：`g.heightRatio / sum(g[i..N-1].heightRatio)` 运行累加，O(N) 替代 O(N²)
- `mergeTabIntoLeaf` 同 leaf 短路：`srcLeafId === targetLeafId` 时委托 `setLeafActiveTab`，避免 removeTab 导致 leaf 被删
- `FlatPanel.path` 死字段移除
- ghost 渲染性能：ref + 直接 DOM 更新替代 React state，60 次/秒 re-render → 2 次/手势
- `flattenTree` 单次遍历计算 leaf + branch rect，修复嵌套 branch sash 定位
- `layoutTreeStore.ts` 创建（持久化 + 历史栈 + 拖拽状态集中化）

---

## 待办

### 高优先级

- [x] **H4 修复**：`migrateFromColumns` 空 cards 产生违反不变量的 leaf（`tabs=[]` + `activeTab='chat'`）
  - 触发条件：旧 group 的 `cards` 为空数组，`activeCardId` 为空
  - 影响：`createLeaf(g.activeCardId || g.cards[0]?.id || 'chat', g.cards.map(c => c.id), ...)` 产生 `tabs=[]`，但 `activeTab` 回退到 `'chat'` 不在 tabs 中
  - 修复方向：tabs 为空时强制 `['chat']` + `activeTab='chat'`
  - 状态：**已完成** — `createLeaf` 工厂函数层归一化（types.ts），operations.test.ts 直测覆盖，migration.test.ts 联合行为覆盖

- [x] **为 useTreeDrag 修复添加测试**：
  - `isZoneSame` 纯函数测试（dropDetection.test.ts，7 个测试）
  - zone 去重：连续 pointermove 同一 zone，store 只更新一次（useTreeDrag.test.ts）
  - resize 重收集：拖拽中 window resize，验证 cachedLeafRectsRef 更新（useTreeDrag.test.ts）
  - 多指隔离：第二指 pointermove/pointerup 被忽略（useTreeDrag.test.ts）
  - 拖拽取消：escape / pointercancel / cancelDrag()（useTreeDrag.test.ts）
  - 状态：**已完成** — useTreeDrag.test.ts 14 个测试 + dropDetection.test.ts +7 个 isZoneSame 测试

- [x] **跨域防护**：对话域只能与对话域拖拽，功能区只能与功能区拖拽
  - 状态：**已完成** — types.ts > isSameDomain + operations.ts > applyDrop 域检查 + useTreeDrag.ts > handlePointerMove 实时域检查

- [x] **tab 重排（同 leaf 内）**：支持 tab 拖拽到自身 leaf 内的指定位置
  - 状态：**已完成** — operations.ts > reorderTabInLeaf + mergeTabIntoLeaf 同 leaf 短路 + DropZone.targetTabId 字段
  - 注：useTreeDrag 中 `detectTabAtPointer`（设置 targetTabId）待实现

- [x] **mergeTabIntoLeaf 去重顺序 bug**：tab 已在 target 中时 filter+push 改变了顺序
  - 状态：**已完成** — tab 已存在时保持原顺序，仅切换 activeTab

### 中优先级

- [x] **layoutTreeStore.test.ts 未覆盖维度**：
  - `commitDrop` 4 条路径完整覆盖（split/merge-tab/同 leaf 短路/无操作）— 已覆盖
  - `resizeBranch` commit 模式：键盘推历史 vs 拖拽手势不推历史 — 已覆盖
  - `onRehydrateStorage` 清临时状态 — 已用 `persist.rehydrate()` 真实触发覆盖

- [ ] **R4-B 旧代码清理**（待新系统 UI 验证通过后）：
  - 移除 `WorkspaceState.columns` / `ColumnState` / `CardGroupState`
  - 移除 `hooks/tab-drag/` 整个目录（需先确认 CardPanel 链退役）
  - 移除 `hooks/useTabDrag.ts` + 测试
  - 将 `layoutSerializer` 升级为仅 v2 格式
  - 移除 `layoutStore.ts`（被 100+ 文件引用，需先迁移所有消费者到 layoutTreeStore）
  - 注：`hooks/tab-drag/useTreeTabDrag.ts` 已在第二轮清理中删除（孤儿）

### 低优先级

- [ ] useTreeDrag 的 `pending → active` 过渡可用 `isInteracting` state 优化（当前常驻挂载 + phaseRef 守卫已足够）

- [ ] **detectTabAtPointer 实现**：拖拽 tab 时检测指针位于哪个 tab DOM 上方，设置 `DropZone.targetTabId`
  - 当前 tab 拖拽到同 leaf 仅切换 activeTab（无 targetTabId）
  - 实现后可在同 leaf 内精确插入到指定 tab 之前
  - 依赖：tab DOM 元素需带 `data-tab-id` 属性

- [ ] **样式调整**：移除 VSCode 风格直角边框，改为柔和圆角 tab
  - 用户反馈：顶部功能区及标签样式变了，不要 vscode 那种带有直角的边框
  - 待修改：`BinaryTreeWorkspace.module.css` 的 `.tab` / `.tabBar` / `.leaf` 边框与圆角

---

## 预存问题（非本次责任，需单独处理）

以下测试失败在本次修改前已存在，与二叉树重构无关（全量 vitest 13 failed / 2981 passed）：

1. **`src/api/providerProfiles.test.ts`**（2 个失败）：
   - `getDefaultProviderProfiles()` 返回的 profile 含 `deepseek-v4-flash` 模型，测试期望 `models=[]`
   - 根因：provider profiles 默认种子被更新但测试未同步

2. **`src/components/FirstRunWizard.test.ts`**（2 个失败）：
   - 同上，`shouldShowFirstRunWizard()` 逻辑与 provider profiles 耦合
   - `getDefaultProviderProfiles()` 的 `models` 字段非空

3. **`src/app/__tests__/AppBootstrap.test.ts`**（2 个失败）：
   - `AppBootstrap.ts` 实际有 17 个 effect，测试期望 16 个
   - `combined` 实际 19 个，测试期望 18 个
   - 根因：AppBootstrap.ts 被加了 1 个 effect 但测试未更新

4. **`src/api/oklchColorGuard.adversarial.test.ts`**（3 个失败）：
   - 8 位 hex (#RRGGBBAA) 静默丢弃 alpha
   - HSL 现代 slash alpha 语法不匹配
   - 阈值附近的颜色对比度选择敏感
   - 根因：对抗性测试暴露真实 bug，需源码修复

5. **`src/api/sessionTitle.property.test.ts`**（1 个失败）：
   - `sanitizeSessionTitleText` 幂等性 property test 失败

6. **`src/__tests__/chaosAndResilience.test.ts`**（1 个失败）：
   - WebSocket 突然掉线重连测试失败

7. **`tests/e2e/ui-store-invariants.spec.ts`** + **`tests/visual/app.spec.ts`**（2 个失败）：
   - Playwright e2e / 视觉测试，需浏览器环境，本地 vitest run 跳过

---

## 架构决策记录

### 为何不用 immer（layoutTreeStore.ts）

- `operations.ts` 的纯函数已返回新树（不可变），store 仅需赋值
- `LayoutNode` 是 `LayoutLeaf | LayoutBranch` 联合类型，immer 的 `WritableDraft` 在 `declaration: true` 下无法被 TypeScript 命名（TS4023）
- 移除 immer 后类型更简洁，且无运行时开销

### 为何不缓存 flatPanels 在 store

- 仅有 `BinaryTreeWorkspace` 消费，且其已用 `useMemo + flattenTree` 计算
- 缓存意味着每次 tree 变更要同步重算，增加 store 复杂度与出错面
- 真正的消费者少时，按需计算更简单

### 为何 useTreeDrag 常驻挂载事件（而非按需挂载）

- `startDragLeaf` 设置 `phaseRef='pending'`，但不触发重渲染
- 若 effect 依赖 `isDragging`，pending 阶段 `isDragging` 仍为 false，effect 不重新挂载，无法检测 pointermove 进入 active
- 解决方案：常驻挂载 + handler 内 `phaseRef` 守卫，彻底消除时序依赖
- 性能影响：idle 时 pointermove 立即返回，微乎其微

### 为何 ghost 位置用 ref + 直接 DOM 更新

- 旧实现用 React state（`ghostPosition`），每帧 `setGhostPosition` 触发 re-render — 60fps 拖拽下每秒 60 次 React reconciliation
- 新实现：`ghostPosRef` 存逻辑位置，`ghostRef` 指向 DOM 元素，`applyGhostPos` 直接写 `el.style.transform`，跳过 React
- `isDragging` 仍为 state（仅拖拽起止时切换，2 次 re-render/手势）

### 为何 leaf rect 缓存 + resize 重收集

- 拖拽期间 tree 不可变（`commitDrop` 仅 pointerUp 触发），故 DOM rect 稳定
- 唯一例外：窗口 resize 改变 canvas 像素尺寸 → leaf 屏幕坐标漂移
- 方案：`enterActive` 时一次性收集 + 拖拽期间监听 resize 重收集，避免每帧 DOM 查询

---

## 测试统计（2026-07-26 第三轮）

- **tsc -b**：通过（exit 0）
- **layout-tree + useTreeDrag 专项**：157/157 通过
  - operations.test.ts: 70
  - migration.test.ts: 19
  - layoutTreeStore.test.ts: 37
  - dropDetection.test.ts: 17（含 7 个 isZoneSame）
  - useTreeDrag.test.ts: 14（新建）
- **vitest 全量**：2981 passed / 13 failed（13 个均为预存问题，见上）

---

## 文件修改清单

### 第四轮（2026-07-26 跨域防护 + tab 重排 + 去重顺序 bug 修复）

#### 修改

- `src/store/layout-tree/types.ts`：新增 `isChatDomain` + `isSameDomain` 纯函数
- `src/store/layout-tree/operations.ts`：
  - `applyDrop` 新增跨域防护（同 leaf 放行，跨 leaf 校验 isSameDomain）
  - 新增 `reorderTabInLeaf` 纯函数（同 leaf tab 重排）
  - `mergeTabIntoLeaf` 同 leaf 短路委托 `reorderTabInLeaf` / `setLeafActiveTab`
  - `mergeTabIntoLeaf` 去重顺序 bug 修复（tab 已存在时保持原顺序）
- `src/store/layout-tree/index.ts`：新增 `isChatDomain` / `isSameDomain` 导出
- `src/hooks/useTreeDrag.ts`：`handlePointerMove` 新增跨域检查（hit leaf 与 source 跨域 → zone=null）
- `src/store/layout-tree/operations.test.ts`：
  - `applyDrop — leaf → merge-tab` 4 个测试改用同域 tool panels
  - `applyDrop — tab → merge-tab > tab 是源 leaf 的最后一个` 改用同域
  - 新增跨域拖拽被拒绝测试
- `src/store/layout-tree/layoutTreeStore.test.ts`：
  - 新增 `makeSameDomainTwoLeafTree()` 辅助函数（branch(diff, terminal)）
  - `commitDrop 4 条路径` 路径 1/2 改用同域树
- `src/hooks/useTreeDrag.test.ts`：
  - `makeTwoLeafTree` 改为 `branch(diff, terminal)` 同域树
  - `makeLeafDOM` 新增 `panelId` 参数，所有调用点传入对应 panelId
  - 变量重命名：`chatId` → `diffId`，`diffId` → `terminalId`
- `src/store/layout-tree/REFACTOR_NOTES.md`：本文档更新

---

### 第三轮（2026-07-26 useTreeDrag 测试 + 孤儿函数清理）

#### 新建

- `src/hooks/useTreeDrag.test.ts`（14 个集成测试，覆盖 8 大维度）

#### 修改

- `src/hooks/useTreeDrag.ts`：
  - 多指隔离：pending/active 阶段都校验 `e.pointerId`
  - 首帧 drop zone 延迟修复：移除 `enterActive` 后 `return`
  - 冗余 store 调用清理：移除 `handlePointerUp/Cancel` 中的 `setDraggedSource(null)`
- `src/store/layout-tree/dropDetection.ts`：新增 `isZoneSame` 纯函数
- `src/store/layout-tree/dropDetection.test.ts`：+7 个 `isZoneSame` 测试
- `src/store/layout-tree/layoutTreeStore.ts`：移除 4 个孤儿 selector 工厂
- `src/store/layout-tree/layoutTreeStore.test.ts`：`onRehydrateStorage` 测试用 `persist.rehydrate()` 真实触发
- `src/store/layout-tree/operations.ts`：移除 5 个孤儿函数（`collectBranches` / `treeDepth` / `flattenToRenderList` / `flattenBranches` / `serializeTree` / `deserializeTree`）
- `src/store/layout-tree/operations.test.ts`：移除已删函数的测试
- `src/store/layout-tree/index.ts`：收紧 barrel，仅导出外部消费者实际使用的符号 + 新增 `isZoneSame`
- `src/store/layout-tree/REFACTOR_NOTES.md`：本文档更新

#### 删除

无（本轮无文件删除，仅函数级清理）

### 第一轮（2026-07-26 拖拽优化 + 孤儿清理）

#### 修改

- `src/hooks/useTreeDrag.ts`：zone 去重 + resize 重收集 + effect 拆分
- `src/components/binary-tree/BinaryTreeWorkspace.tsx`：注释更新
- `src/store/layout-tree/REFACTOR_NOTES.md`：新建（本文档）

#### 删除

- `src/components/workspace-tree/LayoutTreeRenderer.tsx`
- `src/components/workspace-tree/DropIndicator.tsx`
- `src/components/DropIndicatorLayer.tsx`
- `src/components/drag/GlobalDragOverlay.tsx`
- `src/utils/collisionDetection.ts`
- `src/utils/collisionDetection.test.ts`
