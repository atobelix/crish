# _attic — 已退役的代码

这里存放被新架构取代、但暂时保留以备查阅的文件。
不在 `src/` 下，因此不参与编译、打包与可达性门禁。

## superseded/

| 文件 | 被谁取代 | 原因 |
|:-----|:---------|:-----|
| `InlineDecorationPlugin.ts` | `core/live-preview/` | 旧版用 `Decoration.widget` 伪造 `**` 给人看，文档里并不存在这些字符，因此退格键删到的是正文、语法无法用键盘编辑。新引擎把语法字符真正放进文档。 |
| `useLivePreviewEditing.ts` | `hooks/useBlockEditing.ts` | 在组件顶层缓存 `getPos()`，文档一变位置即失效。新 Hook 每次从 Plugin State 实时读取。 |

## 第二批（表格 / 块手柄阶段）

| 文件 | 被谁取代 | 原因 |
|:-----|:---------|:-----|
| `LivePreviewPlugin.ts` + `core/plugins/index.ts` | `hooks/useBlockEditing.ts` | 为了回答「光标在不在这个块里」而遍历全文档，且遍历遇到第一个块就停止下钻，嵌套块永远查不到。改为直接用 pos + nodeSize 比区间，O(1) 且无死角。 |
| `BlockMenu.old.tsx` | `menus/BlockMenu.tsx` | 旧版未接线，且多数命令是占位实现。 |
| `ui/ContextMenu.tsx`、`ui/Popover.tsx`、`ui/DropdownMenu.tsx` | `menus/BlockMenu`、`views/table/TableTrackMenu`、`CodeBlockView` 内的定制实现 | 这三个通用组件都停留在「能弹出来」的层次，缺少键盘导航、边缘翻转、打开即关闭的防抖。各处按自己的场景实现后，通用版本反而成了噪音。 |
| `views/_shared/BlockToolbar.tsx`、`EmptyState.tsx` | `views/_shared/BlockShell.tsx` | BlockShell 把工具条、徽标、拖拽手柄、空状态统一到一处，保证所有区块的 chrome 完全一致。 |
