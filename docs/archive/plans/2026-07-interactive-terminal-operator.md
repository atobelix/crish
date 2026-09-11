# 交互式终端（PTY）操作说明

| 字段 | 值 |
|------|-----|
| 日期 | 2026-07-27 |
| 范围 | Crish Desktop 右坞「终端」面板 + Tauri PTY |
| 对应计划 | `docs/plans/2026-07-conversation-unit-shell.md` Round 3 |
| 状态 | R3 基建已就绪；完整 xterm 键入通路收尾中 |

---

## 1. 产品行为（操作者预期）

1. **打开终端**：在对话 unit 打开右坞 → 选「终端」。会为**当前会话** `ensure` 一个交互式 PTY（Windows：PowerShell/pwsh + ConPTY；Unix：bash）。
2. **工作目录**：默认使用当前工作区路径（`getWorkspacePath` / create 时 `cwd`）。
3. **多会话隔离**：每个 `sessionId` 最多绑定一个 PTY。并排两个 Conversation Unit 时，各自终端互不影响。
4. **折叠坞 ≠ 杀进程**：关掉右坞或卸下 `TerminalCard` **不** kill PTY，便于再打开续上会话。
5. **关会话才释放**：关闭顶栏会话 tab / 摘掉 unit 时调用 `killPtyForSession`，子进程退出。
6. **助手命令镜像**：Agent shell 工具输出仍可通过 `crish-terminal-append` 写入行缓冲；**不**抢占交互式 PTY 的 stdin（避免和用户键入打架）。

---

## 2. 命令与事件（桌面壳）

| 方向 | 名称 | 说明 |
|------|------|------|
| invoke | `workbench_pty_create` | `{ sessionKey, cols, rows, cwd? }` → `{ ptyId }` |
| invoke | `workbench_pty_write` | `{ ptyId, data }`（单次 ≤ 64 KiB） |
| invoke | `workbench_pty_resize` | `{ ptyId, cols, rows }` |
| invoke | `workbench_pty_kill` | `{ ptyId }` |
| event | `workbench://pty-output` | `{ ptyId, data }` |
| event | `workbench://pty-exit` | `{ ptyId, code? }` |

前端封装：`apps/crish-desktop/src/api/ptySessionApi.ts`
生命周期：`apps/crish-desktop/src/api/ptyRegistry.ts`（`ensurePtyForSession` / `killPtyForSession`）

旧路径 `workbench_run_shell`（`terminalShellApi`）仍是**一行一命令**的非交互执行，与 PTY 并行存在，供过渡/回退。

---

## 3. 手动验收清单（C8 前）

在 **Tauri 桌面壳**（非纯浏览器）下：

- [ ] 打开会话 A 的终端，看到可交互提示符（或至少 create 成功、有输出流）
- [ ] 键入 `echo hi` / `Get-Location`，输出即时出现
- [ ] Ctrl+C 能打断长跑命令（ConPTY 行为）
- [ ] 打开会话 B 并排 unit，两个终端各自独立
- [ ] 折叠 A 的右坞再打开：PTY 仍存活（不强制新 spawn）
- [ ] 关闭会话 A 的 tab：A 的 PTY 被 kill；B 不受影响
- [ ] 浏览器 / 无 Tauri：`invoke` 返回 `missing`，UI 不崩

---

## 4. 测试

```bash
cd apps/crish-desktop
npx vitest run src/api/ptySessionApi.test.ts src/api/ptyRegistry.test.ts --coverage.enabled=false
```

预期：**35** 条通过（session API 16 + registry 19）。
Rust 侧：`apps/agent-workbench/src-tauri/src/pty/mod.rs` 内 `pty_id_uniqueness` / write cap 单测。

---

## 5. 已知缺口（R3 收尾）

- `TerminalCard.xterm.tsx` 仍 `disableStdin: true`：完整「打字即 write」需接 xterm `onData` → `ptyWrite`，并订阅 `subscribePtyOutput` 写回 term。
- 纯浏览器开发模式无 PTY：应显示桌面壳提示，勿假装成功。
- e2e/CDP smoke 尚未自动化。

---

## 6. 故障排查

| 现象 | 可能原因 |
|------|----------|
| create → `missing` | 非 Tauri 运行，或 `main.rs` 未注册 `workbench_pty_*` |
| create → error | shell 路径/cwd 无效；ConPTY 权限/策略 |
| 无输出 | 未 `listen('workbench://pty-output')` 或 ptyId 不匹配 |
| 关 tab 后僵尸进程 | `closeTab` 未走 `killPtyForSessionBackground` |
| 两 unit 串台 | 使用了全局单缓冲而非 per-session registry |
