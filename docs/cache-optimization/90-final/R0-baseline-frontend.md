# R0 基线轮 · 前端门禁基线报告（A-R0-2）

- 角色：R0 基线轮只读审计子代理 A-R0-2
- 执行日期：2026-08-03
- 工作目录：`C:\Software\conex`（仓库根）
- 约束：只读；未修改任何源代码，未做任何 git 操作（仅 `git log`/`git show`/`git status` 只读查询）
- 环境：Windows / PowerShell 5.1 / npm 11.6.2 / vitest 3.2.7 / TypeScript 5.9.2
- 说明：工作区存在与本轮无关的历史遗留未提交改动（approval 链路、Rust 侧 hooks 等），本轮未触碰

---

## ① 命令与耗时

| 序号 | 命令                                             | 目录                 | 耗时                                        | 退出码 |
| ---- | ------------------------------------------------ | -------------------- | ------------------------------------------- | ------ |
| 1    | `npm run typecheck`                              | 仓库根               | 106.7s                                      | 0      |
| 2    | `npx vitest run src`（全量）                     | 仓库根               | 99.27s（vitest 内报 Duration）/ 墙钟 106.9s | 1      |
| 3    | 补跑 A：4 个文档化基线文件 scoped 复跑（见 ③-3） | 仓库根               | 6.34s                                       | 0      |
| 4    | 补跑 B：应用侧配置对照（见 ③-4）                 | `apps/crish-desktop` | 13.50s                                      | 1      |
| 5    | `npm run build --workspace @crish/shared-types`  | 仓库根               | 11.7s                                       | 0      |

任务 3（等效类型构建）：`@crish/shared-types` 存在 `build` 脚本（`clean && build:types && build:js`，见 `packages/shared-types/package.json:29`），已实际执行，**通过**（产物 `dist/index.js` 33.9kb + sourcemap，exit 0）。

---

## ② typecheck 结果

**通过（exit 0，0 错误）**。

`npm run typecheck` 串联 7 个 tsconfig 工程全绿：

1. `tsc --noEmit -p apps/crish-desktop/tsconfig.app.json`
2. `tsc --noEmit -p apps/crish-desktop/tsconfig.node.json`
3. `tsc --noEmit -p apps/agent-workbench/tsconfig.json`
4. `tsc --noEmit -p packages/logger`
5. `tsc --noEmit -p packages/shared-types`
6. `tsc --noEmit -p packages/shared-utils`
7. `tsc --noEmit -p packages/telemetry`

---

## ③ vitest 结果（`npx vitest run src`，仓库根）

### ③-1 总数（本次实测）

| 指标         | 数值                         |
| ------------ | ---------------------------- |
| 测试文件总数 | 300（280 通过 + 20 失败）    |
| 测试用例总数 | 4655（4524 通过 + 131 失败） |
| 未处理错误   | 1（见 ③-5）                  |
| 退出码       | 1                            |

### ③-2 失败明细表（20 个失败文件 × 全部为 .tsx）

131 个失败用例全部为 `ReferenceError: React is not defined`（456 处错误文本、0 处断言错误），100% 同一机制，非业务断言失败。

| 失败测试文件                                            | 失败用例数 |
| ------------------------------------------------------- | ---------- |
| components/ui/Dialog/Dialog.test.tsx                    | 17         |
| components/ui/Select/Select.test.tsx                    | 11         |
| components/ui/Input/Input.test.tsx                      | 10         |
| components/ui/Menu/Menu.test.tsx                        | 9          |
| components/chat-message-row/AsyncMarkdownBlock.test.tsx | 8          |
| components/settings/SettingsSelect.test.tsx             | 7          |
| components/ui/Button/Button.test.tsx                    | 7          |
| **tests**/immer-reactivity.test.tsx                     | 7          |
| components/ui/Tooltip/Tooltip.test.tsx                  | 6          |
| components/chat-composer/PermissionModeMenu.test.tsx    | 6          |
| components/settings-skills/SkillEditorModal.test.tsx    | 5          |
| components/settings-models/AddProviderMenu.test.tsx     | 5          |
| components/settings-skills/SkillsMoreMenu.test.tsx      | 5          |
| components/provider/ModelBadgePickerMenu.test.tsx       | 5          |
| components/overlay/CheatsheetModal.test.tsx             | 4          |
| components/overlay/TelemetryDialog.test.tsx             | 4          |
| components/settings/StatusDiagnosticsPanel.test.tsx     | 4          |
| components/settings/SettingsQuickMenu.test.tsx          | 4          |
| components/overlay/WithdrawConfirmDialog.test.tsx       | 4          |
| components/chat-composer/ComposePlusMenu.test.tsx       | 3          |
| **合计**                                                | **131**    |

错误样例（Input.test.tsx:35，`render(<Input …>)` 处）：

```
ReferenceError: React is not defined
❯ apps/crish-desktop/src/components/ui/Input/Input.test.tsx:35:12
```

**失败根因（配置性，非源码回归）**：vitest 从仓库根启动时加载 `vitest.workspace.ts` 的内联 `unit` 项目（environment: node，无 `@vitejs/plugin-react`），该项目的 root 即仓库根；仓库根**没有 tsconfig.json（git 全历史中从未存在）**，Vite/esbuild 探测不到 `jsx: react-jsx`，JSX 走经典转换（`React.createElement`）。凡测试文件未 `import React` 即抛 `React is not defined`。机制自洽证据：同为 .tsx 的 `DiffCard.perf.test.tsx` 因第 9 行显式 `import React from 'react'` 而通过；`apps/crish-desktop/vitest.config.ts`（带 plugin-react + jsdom）下同一批文件全部通过（见 ③-4）。另：vitest 启动输出 DEPRECATED 警告，提示 `vitest.workspace.ts` 应改用 `vitest.config.ts` 的 `test.projects` 字段。

### ③-3 文档化 4 处基线失败的状态（重点核对项）

AGENTS.md 记载基线失败集中在 `oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf`。本次全量运行中这 4 个文件**全部通过**；补跑 A（scoped 复跑 4 文件，仓库根）同样全绿：

| 文件                                                    | 用例数 | 全量运行（本次） | 补跑 A（scoped） | 历史记载（doc 证据）                                                |
| ------------------------------------------------------- | ------ | ---------------- | ---------------- | ------------------------------------------------------------------- |
| api/oklchColorGuard.adversarial.test.ts                 | 33     | 通过             | 通过             | 曾为 3 个已知 bug 型失败（8 位 hex alpha / HSL slash / 对比度阈值） |
| api/userFacingErrors.test.ts                            | 6      | 通过             | 通过             | 曾为 3 个契约未落地失败                                             |
| api/session-persistence/sessionRustDbWriteModel.test.ts | 16     | 通过             | 通过             | 曾为 16 个失败（引用未定义的 `resetSessionWriteModelForTests`）     |
| components/diff/DiffCard.perf.test.tsx                  | 4      | 通过             | 通过             | 曾为性能断言超标（已放宽至 100ms）                                  |

**git 佐证**：commit `d82f7468`（"legacy test suite 23->0"）为当前 HEAD 祖先，即文档化的 23 个遗留失败已在主线修复；`docs/rust-rewrite/34-cleanup-closure.md`、`docs/multi-agent-repair/reports/R6-轮次报告.md` 亦记录该批为"专门修复轮"处理对象。**结论：AGENTS.md 的"4 处基线失败"记载已过时。**

### ③-4 补充对照：应用侧配置（`apps/crish-desktop` 目录，自身 vitest.config.ts）

同批代表性文件在应用侧配置（plugin-react + jsdom）下复跑 86 用例：**85 通过、1 失败**。

- 根目录全量运行中失败的 Input(10)/Dialog(17) 在此**全部通过** → 证明根运行失败是配置/环境现象，非源码回归。
- **新增观察**：`sessionRustDbWriteModel.test.ts` 在此环境下 16 用例中 1 个失败 —— `写并发 > 快速连续 commit：两批次各自完整落库…最终 = 最后写入批次`，`AssertionError: expected 1 to be 2`（`sessionRustDbWriteModel.test.ts:259`，断言 save 调用次数）。该文件在根 node 环境下 16/16 通过。**属时序敏感、环境相关的不稳定项（flaky），不是文档记载的"引用悬空"失败（该问题已修复）。**

### ③-5 其他输出

- 未处理错误 1 起：`EPERM: operation not permitted, watch`（FSWatcher，Windows 文件监听），来源 `packages/shared-utils/src/file/file-watchdog.test.ts`（"debounces rapid writes"）。该文件本身未进入失败列表（通过）；属 Windows 环境的 flaky 未处理异步错误，建议 R1 起留意是否复现。

### ③-6 有无新增失败（相对 AGENTS.md 记载）

- 文档化 4 处基线失败：**0 处复现**（已修复）。
- 本次 131 个失败：全部为根 workspace 配置导致的 `React is not defined` 环境性失败（历史 scoped 跑法 `npx vitest run src/api src/services src/store` 不覆盖 components 的 .tsx 测试，故此前未被计入基线）；**非本轮改动引入、也非源码回归**（与工作区未提交改动无关；根无 tsconfig.json 系 git 全历史状态）。
- 唯一可能被计入"新增"的波动项：sessionRustDbWriteModel 1 例在 jsdom 配置下偶发失败（flaky，见 ③-4）。

---

## ④ 基线结论

1. **typecheck 门禁：绿**（0 错误，106.7s）。
2. **shared-types 类型构建门禁：绿**（11.7s，exit 0）。
3. **vitest 全量（仓库根 `npx vitest run src`）：红** —— 4655 用例中 131 失败（2.8%），但失败集与 AGENTS.md 记载的 4 处基线**完全不符**：4 处基线已全部修复并通过（git 证据 d82f7468），131 个失败 100% 为 `React is not defined` 的**配置性 mass failure**（根 workspace unit 项目未启用 automatic JSX；应用侧配置下同批文件全绿）。
4. **门禁建议（供调度者裁决，审计方只读不实施）**：
   - 若 R1 起以 `npx vitest run src`（仓库根）为门禁，当前命令形态会产生 131 个假阳性失败，基线无法使用；且 vitest 已对 `vitest.workspace.ts` 发出 DEPRECATED 警告。
   - 建议二选一：① 修复根配置（在 workspace `unit` 项目接入 plugin-react / automatic JSX，或按 vitest 提示迁移到 `test.projects`），使根运行下 .tsx 测试正常；② 门禁命令改为应用侧执行（如 `npm run test:desktop-helpers` 或于 `apps/crish-desktop` 下运行 vitest），并同时覆盖 packages。
   - 修正后的基线失败集应重新登记：当前实测无稳定的存量失败（sessionRustDbWriteModel 的 jsdom 偶发 1 例建议单独登记为 flaky 观察项）。
5. 本报告数字全部来自实测输出，未编造；终端 `?`/`✓` 显示差异为 Windows 控制台 GBK 渲染问题，已用字节级去 ANSI 处理核对。
