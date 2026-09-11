# BATCH-02 基线记录

- **日期**：2026-09-11
- **方案 SSOT**：`docs/layout-token-system/00-总方案.md` v2
- **前置**：BATCH-01 已落地

## 落地内容

1. **AppTopBar 流内化**：从 `app-container` 下 absolute/100vw 浮层，迁入 `.workspaces-column` 第一子；CSS 改 `position: relative; width: 100%; flex-shrink: 0`；删除 `headerClearance`；`.trail` 未加 96px inset。
2. **安全区 Token**：`--shell-safe-inset-left/right`、`--shell-canvas-gutter(-compact)`；macOS left=70px；`[data-fullscreen=true]` 归零。
3. **data-fullscreen 接线**：AppBootstrap 独立 effect；Tauri 无 `onFullscreenChanged`，用 `onResized` 重读 + 浏览器 `fullscreenchange` 降级。
4. **外槽**：`BinaryTreeWorkspace .section` 恢复对称 `padding: var(--shell-canvas-gutter, 8px)`；`.canvas` 仍 padding:0。
5. **AppBootstrap 结构测**：effect 计数 15→16、combined 17→18。

## 未做（有意留给后续/真机）

- PaneHeader `edge-reserve-*` 顶行避让清理（窗控已不在树上方重叠，但 isTopRow 拖拽职责仍绑；需真机后单独波）
- SidebarToggle 折叠挂载点优化
- 侧栏上沿拖窗职责（顶栏现只盖 workspaces 列宽）
- Tauri MCP 真机：拖拽 / 折叠 / 全屏

## 验收

```
npx vitest run \
  src/app/__tests__/AppBootstrap.test.ts \
  src/components/top-bar/AppTopBar.test.tsx \
  src/styles/shell/shell-layout.height-chain.test.ts \
  src/styles/style-contract.test.ts
# 4 files, 53 tests, all passed
```

## 改动文件

- `apps/crish-desktop/src/App.tsx`
- `apps/crish-desktop/src/components/top-bar/AppTopBar.tsx`
- `apps/crish-desktop/src/components/top-bar/AppTopBar.module.css`
- `apps/crish-desktop/src/styles/tokens.css`
- `apps/crish-desktop/src/app/AppBootstrap.ts`
- `apps/crish-desktop/src/app/__tests__/AppBootstrap.test.ts`
- `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`
