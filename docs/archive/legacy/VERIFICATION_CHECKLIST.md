# Conex 仓库全量运行时与静态检查指南 (Verification Checklist)

> [!IMPORTANT]
> 为避免出现“生产打包通过但开发模式崩溃”、“TypeScript 类型被误当 JavaScript 值导入导致 Vite Dev 模式模块解析报错”以及“Rust Core 命令未注册导致 Tauri IPC 404”等隐患，修改代码后必须严格按照本清单执行 5 层递进检查。

---

## 避坑警示：Dev 模式 vs Prod 打包的二元反差防线

> [!CAUTION]
> **切记**：`npm run build:desktop` (Vite 生产环境打包) 会使用 `esbuild` / `rollup` 将所有 TypeScript 强行压缩合并为一个 bundle，并在打包时静默擦除未使用的 import。
> 这会导致 **“Production 打包能成功，但 Dev 开发模式 (`npm run dev:workbench`) 启动后在 Webview 控制台报 `SyntaxError: The requested module ... does not provide an export named 'FilterType'` 崩溃”** 的隐秘问题。
>
> **防范措施**：必须使用无缓存的 `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json` 检查，严格拦截所有 **TS1484** (`verbatimModuleSyntax`) 错误！

---

## 检查命令全景速查表

| 层级 | 检查领域 | 完整执行命令 | 检查防线与拦截能力 |
| :--- | :--- | :--- | :--- |
| **L1** | **TS 纯净类型检查 (无缓存)** | `npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json && npm run check:daemon && npm run check:runtime && npm run check:orchestrator` | 拦截 **TS1484** 纯类型误当 JS 值导入、`exactOptionalPropertyTypes` 不匹配、Facade 重导出遗漏 |
| **L2** | **Rust Native 编译与 IPC 注册核验** | `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml` | 检查 11 个 Rust Crate ABI 契约，并审查是否有 `#[warn(dead_code)]` 暴露未注册到 `main.rs` 的 Tauri Handler |
| **L3** | **Vite ESM 模块图打包** | `npx vite build` (在 `apps/crish-desktop` 目录下) | 拦截 `idb-keyval` / `compactObj` 等第三方及本地工具模块解析失败报错 |
| **L4** | **桌面端 (Tauri Workbench) 实时开发运行** | `npm run dev:workbench` (查看终端/任务进程输出) | 1. 验证 Vite Dev Server 原生 ESM 加载无 `SyntaxError`; <br>2. 验证 Sidecar Daemon (PID) 在 `ws://127.0.0.1:8765/` 上成功握手; <br>3. 验证 Tauri WebView 无白屏与未注册 IPC 报错 |
| **L5** | **单元与组件回归测试** | `npx vitest run` | 拦截 React 组件渲染崩溃（如 `isShellToolName is not a function`）、Zustand Store 状态逻辑异常 |

---

## 标准五步复核流程

### Step 1: 全量 TypeScript 严格类型检查 (含 verbatimModuleSyntax)
```bash
npx tsc --noEmit -p apps/crish-desktop/tsconfig.app.json
npm run check:daemon
npm run check:runtime
npm run check:orchestrator
```
- **预期**: 所有 App / Package 输出 0 Errors，绝无 TS1484 错误。

### Step 2: Rust Workspace 原生检查与 Tauri IPC Handler 挂载审核
```bash
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml
```
- **预期**:
  1. 输出 `Finished dev profile target(s)` 且 0 编译错误；
  2. 审核 `apps/agent-workbench/src-tauri/src/main.rs` 中的 `register_handlers!` 宏，确保所有在 `core_commands.rs` 等模块中定义的 `#[tauri::command]` 均已注册；
  3. 确保所有全局状态单例（如 `SharedSearchState`）均已通过 `.manage(...)` 挂载。

### Step 3: Vite 打包与 ESM 模块解析检查
```bash
npx vite build
```
- **预期**: Vite 顺利完成 `dist/` 打包，无 `vite:import-analysis` 或 Rollup Could not resolve 依赖缺失报错。

### Step 4: 桌面客户端 (Tauri Workbench) 实时运行核验
```bash
npm run dev:workbench
```
- **预期**:
  1. Vite 启动端口 5174 且无 pre-transform 500 错；
  2. Cargo 调起 Native `crish-agent-workbench.exe` 桌面窗口；
  3. Sidecar 输出 `[Sidecar][daemon.stdout] Ready on port 8765` 且 `[Sidecar][daemon.websocket] Connected` 无离线重启死循环。

### Step 5: Vitest 单元与组件回归测试
```bash
npx vitest run
```
- **预期**: 所有测试套件与组件快照测试全绿通过。
