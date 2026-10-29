# 桌面 IPC 与 api 重组（IPC）

> **给执行 AI 的硬性规则**
> 1. 一个 `ipc.call`。清单只从 Rust `command_manifest` 来。不留第二份手写名单，不留 invoke 包装。
> 2. 禁止作弊：不加 `eslint-disable` / `@ts-ignore` / `@ts-expect-error`；不调基线；不删断言；不用 `--no-verify`。
> 3. `npm run typecheck` / `lint` / `test` 只在 IPC-P5。Node 24。本模块不跑全仓 cargo（不改 Rust 行为）。
> 4. 每阶段一提交：`refactor(IPC-P<n>): <中文摘要> [BATCH-DESKTOP-IPC]`。
> 5. 只在 `C:\Users\orange\rf-ipc` 改。不 stash、不 push、不动主仓库。
> 6. `commandManifest.ts` 在写则生成阶段停。不改 SS 的取消链。不做迁移注册表。
> 7. 行号是 2026-10-29 快照（HEAD `bf3d60fa3`）。按符号 `rg` 重定位。

| 项 | 值 |
|---|---|
| 代号 | IPC |
| 分支 | `refactor/desktop-ipc` |
| worktree | `C:\Users\orange\rf-ipc` |
| 批次标签 | `[BATCH-DESKTOP-IPC]` |
| 进度 | 同目录 `desktop-ipc-api.progress.md`（写在 worktree，不写主仓库） |
| 基点 | SS 合入之后（store 直连 invoke 已离开 store）。ST 的包导出就绪之后再改 generated 的 import 路径 |

## a. 范围与门控

### a.1 纳入
- 通道：`api/tauriInvoke.ts`、`api/transport/**`、调用 `invokeResult` / `invokeTyped` 的生产文件。
- 清单：以 `apps/agent-workbench/src-tauri/src/command_manifest.rs` 为源，生成桌面快照。不手写第二份。
- `api/` 里纯转发与放错层的文件（A-02、A-03），以及同名双份里不属于 SS 的那对（`ptyWriteGate`）。
- `api/chat-bridge` 的 legacy 信封（E-01）。
- `workers/**` 里没有生产 `schedule` 的通道；`utils/error-translation.ts` 与 `api/error-translation.ts`；`api/themeStore.ts` 的 `setInterval`。

### a.2 不纳入
- **I-02 的「workbench_abort_run 不在前端清单」是误报。** `commandManifest.ts` 的 `entry('workbench_abort_run', 'workbench', 'gui')` 与 Rust `command_manifest.rs`、`command_registry.rs` 都有这条。store 里 `sessionCascadeCancellation.ts` 动态 `import('@tauri-apps/api/core')` 再 `invoke('workbench_abort_run')` 归 SS，本模块不改该文件。
- 不做 B-01 / L-01 迁移注册表（MIG）。
- 不做 shared-types 生成（ST）。不新写 specta / ts-rs 管线。
- 不改 `api/markdown/**`、`crates/conex-markdown`（MD）。
- 不改 `authApi.ts`、`authStore.ts`、`multiDevice.ts`，除非 porcelain 为空且只是机械改 import。
- 不删 SS 点名的 `storeAccess`、`sessionStreamManager`、`streamDirectDomEngine`、`streamRunCompletion`。
- `TOOL_OUTPUT_DOM_CHAR_CAP` 归 CF，不在 workers 阶段挪走。

### a.3 门控
| 阶段 | porcelain 必须为空 |
|---|---|
| IPC-P1 | `apps/crish-desktop/src/api/transport/commandManifest.ts` 与 `apps/agent-workbench/src-tauri/src/command_manifest.rs` |
| IPC-P2 | `apps/crish-desktop/src/api/chat-bridge` |
| IPC-P3 | 本阶段要移动的 `api/**` 路径。排除 markdown、auth、multiDevice、session-persistence（SS） |
| IPC-P4 | `apps/crish-desktop/src/workers` `api/themeStore.ts` `utils/ptyWriteGate.ts` `components/workspace/ptyWriteGate.ts` |

编写时：`commandManifest.ts` 与它的两个测试为脏；`command_manifest.rs` 在 src-tauri 大片在写之中，按文件门控，不要为了读它去改壳。`workers` 与迁移目录编写时为空，P4 仍要重跑。

## b. 核实表

| 编号 | 结论 | 证据 |
|---|---|---|
| I-01 | 仍存在 | `invokeResult`、`invokeTyped` 都在 `tauriInvoke.ts`。`TauriTransport.call` 注释写「唯一 invoke 通道」，内部仍调 `invokeTyped`。生产 `invokeResult(` 约 10 个文件、`invokeTyped(` 约 11 个、`getTransport(` 约 26 个。直连 `@tauri-apps/api/core`：`daemonClient.ts`、`localFileReader.ts`（`convertFileSrc`）、`attachmentCardUtils.ts`（`convertFileSrc`）。store 那次直连归 SS |
| I-02 | **误报** | 三处都有 `workbench_abort_run`（见 a.2）。手写名单仍然多份：Rust 源、`BUILTIN_COMMAND_MANIFEST`、`commandMap.ts` 的 `COMMAND_NAME_ALLOWLIST`。编写时两边 `entry(` 行数都是 172，旧「166 且缺 abort」已过时。条数相同不等于可以留两份手写 |
| I-03 | 仍存在，做法归 ST | 深层相对路径 `packages/shared-types/src/generated` 仍有十余个文件。本模块只在 ST 已经提供包导出时改 import。不生成类型 |
| I-04 | 仍存在 | `isMissingCommandMessage` 把 `not allowed`、`Cannot find module`、`Failed to fetch dynamically` 当成命令缺失。`formatInvokeError` 硬编码 `'未知错误'`（中文归 I18N，分类逻辑归本模块）。`WORKSPACE_ACCESS_COMMANDS` 是又一份手写集合 |
| I-05 | 缩小，顺手收 | 仍直连 `listen`：`nativeBrowserApi.ts`、`ptySessionApi.ts`、`nativeBrowserInspectorApi.ts`，以及 `useIpcListener.ts`。报告里其余文件本轮 `rg` 未再命中 |
| A-01 | 仍存在 | `api/` 根上仍有 store、渲染、IPC、工具函数混放。不在这里统计 256 这个旧数字 |
| A-02 | 仍存在 | `fontStoreScan.ts`、`error-translation.ts`、`modelsAutofillBaseline.ts` 都是 `export * from` 到 components / utils / services |
| A-03 | 仍存在 | 根上多个 `export *` 只为路径不变。SS 的 storeAccess 不在本模块删 |
| A-04 | 部分 | `ptyWriteGate` 两份都是完整实现：`components/workspace/ptyWriteGate.ts` 被 `useXtermTerminal.ts` 使用；`utils/ptyWriteGate.ts` 含 `createSotaPtyWriteGate` 别名，主要被自己的测试引用。其余同名对（sessionStreamManager、streamDirectDom、streamRunCompletion）归 SS |
| E-01 | 仍存在 | `EventRouter.ts` 写明 `parseEngineEvent` 失败后再走归一器。`dispatch.ts` 有 `legacyDispatchTable` 与 `LegacyEnvelope` |
| W-01 | 部分仍存在 | 生产 `schedule` 只看到 `codeHighlightBatch.ts` 的 `highlight.batch`。`render-worker.ts` 仍有 `highlight.code.stream` 与 `.stream.reset`。`initMinimalPool`、`scaleUpPool` 仍导出；`bootstrap-full.ts` 注释写明已不调用 `scaleUpPool`。`io-worker.ts` 注释写 json.parse 与 compute-worker 重复但保留兼容。`computeWorkers` / `ioWorkers` 默认 0 |
| U-02 | 仍存在 | `api/error-translation.ts` 纯转发。`utils/error-translation.ts` 非空行约 498，超过业务逻辑 400。不在这里做 EC 的错误码生成 |
| U-03 | 仍存在 | `themeStore.ts` 在初始化路径 `setInterval(..., 60000)`，无 `clearInterval` |
| U-04 | 未复现 | `TokenRuntimeController.ts` 内 `rg deprecated|弃用|legacy` 为 0。不删这个类 |
| daemonClient | 仍像死模块 | 生产 value import 未看到；测试与 `transport/types.ts` 提到名字。P0 复证后删 |

## c. 目标架构

页面与 api 只调用 `ipc.call(cmd, payload)`。它做三件事：生成清单里的 registered 校验、workspace access（标记来自同一份生成清单，不另维护 `WORKSPACE_ACCESS_COMMANDS`）、错误变成 `{ code, message }`。`code` 用 Rust 已经返回的 `code` / `kind`，不用英文句子正则。

`invokeResult` 与对外的 `invokeTyped` 删除。`@tauri-apps/api/core` 的 `invoke` 只允许出现在 `api/transport` 一个文件。`convertFileSrc` 若不是 invoke，留在那个文件里包一层，调用方不直接 import core。`listen` 只经 `api/transport` 的订阅函数，返回 unlisten。

清单：提交进仓库的 TS 是生成物，源是 `command_manifest.rs`。生成脚本放 `scripts/`，不改 check-i18n。漂移时 CI 式的 `git diff --exit-code` 用现有测试位置（`commandManifest.test.ts` 已会锁条数）改成「生成物与源一致」，不另起第二份允许列表。`COMMAND_NAME_ALLOWLIST` 删除。`core_run_task` 的 payload 形状只在 `ipc.call` 路径整形一次。

`api/` 按领域放 IPC 客户端。状态不放 api：`themeStore` 一类挪到 `store/` 里非会话文件（SS 合入后）。组件实现不放 api：删掉指向 components 的转发，调用方改真路径。

事件：只接受 `parseEngineEvent`。失败就上报并丢弃。不保留别名表。生成联合里没有的 `subagent-*` / `error` 若生产仍在发，停，交给 ST/引擎，不在前端再写一套 Legacy 类型。

Worker 池只保留 render 的 `highlight.batch`。没有生产调用的 stream 分支、compute-worker、io-worker、`scaleUpPool`、`initMinimalPool` 删除。`codeHighlightBatch` 留下。

`ptyWriteGate` 只留一份，放 `utils/ptyWriteGate.ts`，无 `createSotaPtyWriteGate`。workspace 文件删除，不是再导出。

## d. 删除清单

- 公开的 `invokeResult`、`invokeTyped`（transport 内部也不保留第二套语义，只留一次 `invoke`）。
- `COMMAND_NAME_ALLOWLIST`、手写 `BUILTIN_COMMAND_MANIFEST` 字面量（改为生成文件，禁止再手改）。
- `isMissingCommandMessage` 正则。
- `WORKSPACE_ACCESS_COMMANDS` 独立集合。
- `legacyDispatchTable`、`LegacyEnvelope`、手写别名归一器（E-01 停机条件不满足时不删）。
- `daemonClient.ts` 及其专测（P0 确认 0 生产 import）。
- workers：`compute-worker.ts`、`io-worker.ts`、render-worker 的 stream 分支、`streamingCodeHighlighter.ts` 若只被该分支使用、`scaleUpPool`、`initMinimalPool`。
- `api/error-translation.ts`、`api/fontStoreScan.ts`、`api/modelsAutofillBaseline.ts` 以及 P0 列出的纯 `export *` 且 SS/MD 不拥有的文件。
- `utils/ptyWriteGate.ts` 的 `createSotaPtyWriteGate`。workspace 那份整文件在逻辑迁入 utils 后删除。
- `themeStore` 里无法清除的模块级 `setInterval`。改成可 `dispose` 的 id。

## e. 分阶段与探针

**IPC-P0** 不改代码。复跑 §b 的 `rg`。列出 `export * from` 且文件体没有其它声明的 api 文件。确认 `package.json` 是否已导出 generated 子路径：没有则 I-03 的 codemod 不做。确认 `daemonClient` 无生产 import。

**IPC-P1** 门控 a.3。生成清单，调用点改 `ipc.call`。eslint `no-restricted-imports` 禁止 `@tauri-apps/api/core` 与 `@tauri-apps/api/event`，例外仅 `api/transport`。不把例外写成文件名白名单的长列表。探针：

```
rg -n "invokeResult\(|invokeTyped\(|COMMAND_NAME_ALLOWLIST|from '@tauri-apps/api/core'" apps/crish-desktop/src -g "!**/api/transport/**" -g "!**/*test*"
rg -n "workbench_abort_run" apps/crish-desktop/src/api/transport
```

第一行生产 0。第二行在生成物里仍有（误报不能修成「删掉这条命令」）。

**IPC-P2** 事件只留 `parseEngineEvent`。探针：`rg -n "legacyDispatchTable|LegacyEnvelope" apps/crish-desktop/src` → 0。若生成类型没有这些事件而运行时仍依赖它们，停。

**IPC-P3** SS 已合入后，按领域移动 IPC 文件并 codemod import。删除 §d 的转发文件。不移动 markdown、auth、session-persistence。探针：`rg -n "export \* from '\.\./components|export \* from '\.\./utils/error-translation|export \* from '\.\./services/modelsAutofillBaseline'" apps/crish-desktop/src/api` → 0。

**IPC-P4** workers 与 pty、theme 定时器、error-translation 拆文件到 ≤ 400。探针：`rg -n "scaleUpPool|initMinimalPool|highlight\.code\.stream|createSotaPtyWriteGate" apps/crish-desktop/src -g "!**/*test*"` → 0；`rg -n "setInterval" apps/crish-desktop/src/api/themeStore.ts apps/crish-desktop/src/store -g "*theme*"` 若命中，必须有配对的 `clearInterval`。

**IPC-P5** §h。

## f. 禁止捷径

- 不保留 `invokeResult` 当 deprecated 别名。
- 不把 `BUILTIN_COMMAND_MANIFEST` 改成从允许列表再抄一遍就算「生成」。生成输入只能是 Rust 源。
- 不把 `workbench_abort_run` 删掉来「对齐误报」。
- 不在 store 里补 invoke。那是 SS。
- 不建迁移注册表，即使看到 `migrateLegacy*`。
- 不手写与 ST 平行的 payload 类型。
- 不新增 eslint-disable。限制 import 用正规则，不用文件级关闭。
- 不调行数基线。超长文件拆开。

## g. 规范

`no-restricted-imports` 写在现有 `eslint.config`，不放宽其它规则。`check:line-counts` 业务 ts ≤ 400，硬阻断 > 650，基线只降。`npx knip` 无新未使用导出。生成脚本若加入 `package.json`，先看根 `package.json` porcelain；编写时根 package 可能在写（ROADMAP 记过）。脏则不改 `package.json`，脚本用 `node scripts/...` 直接跑，测试里用同样命令。

## h. 测试

只在 IPC-P5，worktree，Node 24：

```
npm run typecheck
npm run lint
npm run test
npm run check:line-counts
npx knip
node scripts/generate-command-manifest.mjs
git diff --exit-code -- apps/crish-desktop/src/api/transport/commandManifest.generated.ts
```

生成文件名以 P1 实际落地为准，探针写进 progress。回归：R1 未注册命令得到 missing 而不是「模块加载失败」；R2 `not allowed` 不当成 command_not_found；R3 `highlight.batch` 测试仍在；R4 隐藏终端 write gate 测试仍在。

## i. 审计

- [ ] A1 I-02 命令在生成清单中
- [ ] A2 生产代码无 `invokeResult` / `COMMAND_NAME_ALLOWLIST` / core 直连
- [ ] A3 diff 不含 `sessionCascadeCancellation.ts`、不含迁移注册表、不含 `packages/shared-types`
- [ ] A4 无新的 eslint-disable / ts-expect-error
- [ ] A5 生成物与 Rust 源一致，不是手改后的生成物

## j. 与 SS/CF/ST 的文件冲突

- SS 改 store 取消链、`runControlClient`、`sessionStreamManager`、`storeAccess`、`api/session-persistence/sessionDeltaWriteBarrier.ts`。本模块不改这些。IPC-P1 之后 SS 若还在用 `invokeResult`，应已合入；否则 P1 的 codemod 会和 SS 冲突，停。
- CF 改 `workers/index.ts` 的两个 UI 常量与 `entry-core`。IPC-P4 不改这两个常量，不改 `entry-core`。
- ST 独占生成类型与包导出。I-03 只消费导出。E-01 缺事件时交给 ST，不在桌面声明平行联合类型。
- MD 独占 `api/markdown/**`。重组 api 时跳过该目录。
- MIG 独占迁移调用点。本模块不「顺便」集中 migrate*。
- I18N 会改 `'未知错误'`。P1 若移动该字符串，留中文原句给 I18N，不要删掉。

## k. 已决

- I-02 写成误报。直连 invoke 归 SS。
- 顺序：Rust 清单为源 → 只留 `ipc.call` → `api/` 按领域重组。中间不做迁移注册表。
- D10 错误码生成归 EC。本模块只停止用正则误判，不新做错误码真源。
- D1 的 worker 常量归 CF。
- U-04 未复现，不纳入删除。
