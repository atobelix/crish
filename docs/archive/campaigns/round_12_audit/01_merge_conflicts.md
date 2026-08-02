# 合并冲突残留扫描报告

| 项目 | 内容 |
|------|------|
| 扫描 Agent | Agent 1 – 全仓库合并冲突残留扫描 |
| 扫描时间 | 2026-07-24 |
| 扫描范围 | `.ts` / `.tsx` / `.rs` / `.mjs` / `.json` / `.toml` / `.yml` / `.css` |

---

## 扫描结果总览

- **实际 Git 合并冲突残留（`<<<<<<<` / `=======` / `>>>>>>>`）**: 1 处
- **UU（Unmerged）文件数**: 37 个
- **TS1185 编译错误**: ❌ **否**（无 TS1185 错误）

---

## 发现的冲突详情

### 文件 1：`apps/crish-desktop/src/components/CardPanel.tsx`

| 字段 | 值 |
|------|-----|
| 行号 | 866 |
| 标记 | `=======` |
| 冲突内容摘要 | 文件在 JSX `return` 部分存在残留的 `=======` 分隔符。上方为旧代码分支（`{activeCardId === 'chat' ? (`），下方为新代码分支（`return (...`），缺少 `<<<<<<<` / `>>>>>>>` 包裹，属于**部分解析残留**。 |
| 严重程度 | **致命** — 未闭合的 `=======` 会导致 JSX 语法错误，阻断整个文件的编译 |
| 编译是否报错 | `npx tsc --noEmit` 未输出 TS1185 错误（当前 tsc 主要以 exactOptionalPropertyTypes 类错误为主），但该文件在构建时会因语法问题导致渲染异常 |

---

## UU（Unmerged）文件列表

以下 37 个文件处于 `both modified` 状态（未合并）：

| # | 文件路径 |
|---|----------|
| 1 | `apps/crish-desktop/src/App.tsx` |
| 2 | `apps/crish-desktop/src/api/performanceEngine.ts` |
| 3 | `apps/crish-desktop/src/components/CardPanel.tsx` |
| 4 | `apps/crish-desktop/src/components/ChatCard.tsx` |
| 5 | `apps/crish-desktop/src/components/ChatEmptyState.tsx` |
| 6 | `apps/crish-desktop/src/components/ChatHeaderMore.tsx` |
| 7 | `apps/crish-desktop/src/components/ChatMessageList.tsx` |
| 8 | `apps/crish-desktop/src/components/ChatMessageRow.tsx` |
| 9 | `apps/crish-desktop/src/components/ChatToolCallBlock.tsx` |
| 10 | `apps/crish-desktop/src/components/ProjectPickerMenu.tsx` |
| 11 | `apps/crish-desktop/src/components/SettingsExtensionsTab.tsx` |
| 12 | `apps/crish-desktop/src/components/Sidebar.tsx` |
| 13 | `apps/crish-desktop/src/components/Workspace.tsx` |
| 14 | `apps/crish-desktop/src/components/WorkspaceChromeBars.tsx` |
| 15 | `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.tsx` |
| 16 | `apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx` |
| 17 | `apps/crish-desktop/vite.config.ts` |
| 18 | `packages/agent-daemon/src/capabilities.ts` |
| 19 | `packages/agent-daemon/src/daemon-provider-gateway.test.ts` |
| 20 | `packages/agent-daemon/src/daemon-provider-gateway.ts` |
| 21 | `packages/agent-daemon/src/handlers/run-handlers.ts` |
| 22 | `packages/agent-daemon/src/protocol/protocol.ts` |
| 23 | `packages/agent-daemon/src/protocol/registry.test.ts` |
| 24 | `packages/agent-daemon/src/protocol/validators/common.ts` |
| 25 | `packages/agent-daemon/src/protocol/validators/run.ts` |
| 26 | `packages/agent-daemon/src/server-handlers.ts` |
| 27 | `packages/agent-daemon/src/server-runtime-factory.test.ts` |
| 28 | `packages/agent-daemon/src/server-runtime-factory.ts` |
| 29 | `packages/agent-daemon/src/server.ts` |
| 30 | `packages/agent-daemon/src/types.ts` |
| 31 | `packages/agent-orchestrator/src/orchestrator.ts` |
| 32 | `packages/agent-runtime/src/agent-session-loop.ts` |
| 33 | `packages/agent-runtime/src/context-projection.ts` |
| 34 | `packages/agent-runtime/src/plugin-fs-registry.ts` |
| 35 | `packages/agent-runtime/src/provider-anthropic.ts` |
| 36 | `packages/agent-runtime/src/provider-gemini.ts` |
| 37 | `packages/agent-runtime/src/runtime-helpers.ts` |

> 注意：以上 UU 文件经逐行检查，**仅 `CardPanel.tsx` 包含实际冲突标记**，其余 36 个 UU 文件不存在 `<<<<<<<` / `=======` / `>>>>>>>` 标记。

---

## 编译状态

| 检查项 | 结果 |
|--------|------|
| `npx tsc --noEmit` TS1185 错误 | 无 |
| 总 TS 编译错误数 | 大量（~数百，均为 `exactOptionalPropertyTypes` / 未使用变量 / 类型不兼容等非冲突类错误） |

---

## 结论与建议

1. **`CardPanel.tsx:866` 的 `=======`** 属于**致命级别**残留，必须在启动前修复。
2. **37 个 UU 文件**需通过 `git add` 完成合并标记；当前仅 `CardPanel.tsx` 有实际冲突标记残留。
3. 其余匹配到的 `=======` 均为合法的装饰性注释或字符串常量，非冲突残留。
4. 当前不存在 TS1185 错误。
