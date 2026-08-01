# AA-08 依赖与构建打包审查（Deps & Build Review）

- 日期：2026-08-01
- 范围：根 Cargo.toml、crates/*、packages/*、apps/crish-desktop、apps/agent-workbench（package.json + vite.config.ts + src-tauri）、turbo.json、根 package.json、scripts/
- 性质：只读审查，不修改代码；遗留文件仅列出
- 审查时点：Rust 重写（B 阶段）进行中，agent-workbench 的 daemon/sidecar 删除尚未提交（工作区有大量 D 条目），部分结论与"删除中"状态相关

---

## 一、总览

仓库处于 **Rust 侧重构进行中**（git 工作区存在大量未提交删除：sidecar/cli/daemon 相关），这直接影响依赖清单：

- **Cargo 侧整体健康，但有一个高危项**：`Cargo.lock` 被 `.gitignore` 忽略且内容**完全过期**（不含任何 workspace 自身 crate，也不含 `tauri-plugin-mcp` git 依赖）。对于含二进制（crish-agent-workbench）的 workspace，这是可复现性硬伤。
- **`reqwest` 双大版本共存**（0.12.28 + 0.13.4）：tauri 2.11.2 自身依赖 reqwest 0.13.4，workspace 钉在 0.12 → 最终二进制同时链接两套 HTTP 栈。
- **孤儿 crate 2 个**（conex-net、conex-stream）：编译但不链接，无人引用。
- **workspace.dependencies 1 项未使用**（derive_builder）。
- **npm 侧 4 个零 import 依赖**（dompurify、@types/dompurify、idb-keyval、use-sync-external-store），2 个依赖错位（ws、@types/dompurify）。
- **bundle 最大 chunk 1.06 MB**（App-*.js），vendor-lucide 553 KB 异常偏大（疑似 tree-shaking 未生效）。
- **target/ 已达 53.5 GB**，无任何 .cargo 配置管控。
- 构建链（turbo.json、vite manualChunks、tauri frontendDist）整体自洽，无 daemon 残留配置；残留集中在工具链杂物（pnpm 文件、sessions.db 入库、.turbo/ 未忽略）。

---

## 二、问题清单

| # | 位置 | 严重度 | 描述 | 建议 |
|---|------|--------|------|------|
| 1 | `.gitignore:134` + `Cargo.lock` | 高 | Cargo.lock 被忽略且已过期：不含 workspace 自身 7 个新 crate（agent-provider/agent-tools/orchestrator/session-loop/conex-telemetry/crish-agent-workbench）与 tauri-plugin-mcp git 依赖，reqwest 等条目停留在旧解析。二进制 workspace 每次全新克隆构建结果不可复现 | 取消 ignore，`cargo generate-lockfile` 后提交一份新鲜 Cargo.lock 并持续跟踪 |
| 2 | `Cargo.toml:42`（workspace reqwest 0.12）+ Cargo.lock reqwest 0.13.4 | 高 | tauri 2.11.2 依赖 reqwest 0.13.4，workspace 用 0.12.28 → 二进制同时链接两套 reqwest/hyper/tower 栈，体积与编译时间浪费 | 升级 workspace reqwest 至 0.13，消除双版本（Cargo.lock 第 5543 行可见 tauri→reqwest 0.13.4 引用） |
| 3 | `Cargo.toml:47` tokio features = ["full"] | 中 | workspace 级 full 令所有 crate 获得全部 feature（fs/process/signal/sync 等）；agent-provider 实际只需 rt/macros/time/sync/net/io-util；各 crate 的 feature 补充声明（agent-tools dev、orchestrator、session-loop）在 full 下均为空操作 | 改为最小集（如 ["rt", "macros", "time", "sync", "net", "io-util"]），各 crate 按需在依赖处补 feature |
| 4 | `Cargo.toml:56` derive_builder | 中 | workspace 声明但全仓库 0 引用（crates 无 derive_builder/`#[derive(Builder)]`） | 从 workspace.dependencies 删除 |
| 5 | crates/conex-net、crates/conex-stream | 中 | 孤儿 crate：无任何 crate 或二进制依赖它们，代码也无引用；workspace 构建会编译但不链接（连带 tokio/bytes/reqwest 在其中的 feature 需求形同虚设） | 确认无计划后移出 workspace members，或由 agent-provider/workbench 接入 |
| 6 | `apps/crish-desktop/package.json:30,34` dompurify + @types/dompurify | 中 | 全仓库（src/tests/scripts/packages）零 import；仅 vite.config.ts optimizeDeps 提及 | 两包删除；同步删 vite.config.ts:205 的 'dompurify' 条目 |
| 7 | `apps/crish-desktop/package.json:36` idb-keyval | 中 | 零 import（无任何引用） | 删除 |
| 8 | `apps/crish-desktop/package.json:42` use-sync-external-store | 中 | 零 import（zustand/react 自带）；reference/ 下是另一仓库 | 删除 |
| 9 | 构建产物 `apps/crish-desktop/dist/assets/App-*.js` 1.06 MB、vendor-lucide 553 KB | 中 | 总 assets 3.77 MB / 115 文件；App 主 chunk 1062033 B 且 `chunkSizeWarningLimit: 1100` 将其掩盖；lucide-react 105 处导入仍产出 553 KB，tree-shaking 疑似未生效（可能混入整体/动态导入） | 恢复默认 warning 阈值督促拆分；核查 lucide 导入方式；App 内大模块（xterm 终端、设置页）改 React.lazy 拆 chunk |
| 10 | `.gitignore`（全文）缺 `.turbo/` | 中 | 根 `.turbo/` 现为未跟踪目录（git status 显示 `?? .turbo/`），turborepo 缓存将反复出现在 status 中 | 增加 `.turbo/` 忽略项 |
| 11 | `apps/agent-workbench/sessions.db`（已跟踪，700 KB） | 中 | 运行时 SQLite 数据库被 git 跟踪且本次变更中（M 状态）；属运行时状态而非源码 | `git rm --cached` + 加 ignore 规则 |
| 12 | `Cargo.toml:47,51,59` + 各 crate | 低 | 内联重复声明：agent-workbench tokio = { version="1", features=["full"] } 与 workspace 重复；regex="1" 在 4 处内联（agent-tools/conex-markdown 含 deps+dev-deps 双份/conex-sandbox/agent-workbench）；conex-types once_cell="1" 内联；windows-sys 0.61 内联 | 一律走 workspace 引用；conex-markdown 的 dev-deps regex 删除（deps 已有） |
| 13 | `apps/agent-workbench/src-tauri/Cargo.toml:24` tauri-plugin-mcp（git，无 rev） | 低 | git 依赖未锁 rev，配合 Cargo.lock 丢失 → 每次解析都可能漂移 | 锁 rev 或改用 crates.io 发布版；与 npm 侧 tauri-plugin-mcp 0.3.1 对齐 |
| 14 | `crates/session-loop/Cargo.toml:16` futures = "0.3" | 低 | 引入完整 futures crate，workspace 已有 futures-util | 若仅用 StreamExt/FutureExt 改 futures-util |
| 15 | Cargo.lock 多版本 | 低 | windows-sys 5 版本（0.45/0.52/0.59/0.60/0.61）、thiserror 1.x+2.x、toml 3 版本、getrandom 3 版本、base64 2 版本 —— 多为传递依赖（tauri 生态） | 传递性为主，低优先；仅确保 workspace 自身声明与 tauri 对齐（windows-sys 0.61 已对齐 tauri 的 windows 0.61.3） |
| 16 | 根 `package.json:92` ws 在 dependencies | 低 | 仅 tests/e2e/tauri-native-smoke.spec.ts 与 scripts/*.mjs 使用（测试/脚本），应用代码零引用 | 移入 devDependencies |
| 17 | 根 `package.json:89-91` + crish-desktop `package.json:31-33` @xterm/* 重复 | 低 | 根与 app 各声明一份（同版本） | 保留 crish-desktop 一份，根删除 |
| 18 | `packages/telemetry/package.json` | 低 | 依赖用 `"*"` 而非 file: 路径（其余包均 file:）；且全仓库无消费者（孤儿 npm 包） | 统一 file: 声明；若确认无接入方移出 workspaces |
| 19 | `packages/test-utils/package.json:9` clean 脚本 | 低 | `rimraf dist` 但 rimraf 未在任何 package.json 声明且 node_modules 中不存在 → turbo clean 对该包必失败 | 改 `node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"` |
| 20 | `apps/crish-desktop/` pnpm-lock.yaml + pnpm-workspace.yaml（已跟踪） | 低 | 与根 npm + package-lock.json 混合工具链残留 | 删除 pnpm 两个文件；app 级 package-lock.json 与根 lock 并存，建议以根 lock 为准（npm workspaces） |
| 21 | `apps/agent-workbench/vitest.config.ts` | 低 | workbench src 已删空（include src/**/*.test.ts 匹配 0 个文件），vitest 配置纯残留 | 删除 |
| 22 | `tauri.conf.json:9-10` beforeBuildCommand/beforeDevCommand | 低 | `npm run build`/`npm run dev` 在 src-tauri 目录执行，无 package.json，依赖 npm 向上查找 workbench 包才生效 | 显式 `npm --prefix .. run build`（脆弱性消除） |
| 23 | `tauri.conf.json:33-38` updater 插件 | 低 | active: true 但 pubkey 为空字符串、endpoint 指向 releases.crish.me —— 运行时更新检查必然失败 | 未启用更新服务前设 active: false |
| 24 | `tauri.conf.json:42` bundle.targets = "all" | 低 | Windows 下 "all" 包含 MSI（需下载 WiX toolset），CI/离线环境易失败 | 显式 ["nsis"] 或按平台限定 |
| 25 | `tauri.conf.json:29` CSP connect-src 含 `ws://localhost:8765` | 低 | 8765 为已删除 daemon 的端口，daemon 移除后属残留放行 | 清理 CSP 中 8765 条目 |
| 26 | `.gitignore` 陈旧/重复条目 | 低 | target-tauri-dev/ 出现 3 次（11/85/143 行）；`**/target/` 与 `apps/agent-workbench/src-tauri/target/` 重复且该目录当前不存在；`reference/crish-desktop/` 等已无实际路径依赖 | 合并去重；按需保留 |
| 27 | `.dependency-cruiser.cjs`、`.mcp.json` 被 gitignore | 低 | 两者被 package.json 脚本（lint:depcruise）或工具引用，但均未跟踪 → 全新克隆后脚本/工具缺失配置 | 二选一：取消 ignore 跟踪，或删除对应脚本引用 |
| 28 | 根 `package.json` 无 engines | 低 | 未声明 Node 版本要求（packageManager npm@11.6.2 已有，但 engines 可防低版本误用） | 补 engines.node >= 20 |
| 29 | `target/` 53.5 GB 无管控 | 中 | 根 target 为唯一 Rust 构建目录（src-tauri/target 不存在）；无 .cargo/config.toml，无增量/条带化配置 | 建 `.cargo/config.toml`：`[profile.release] strip=true`、lto 按需；定期 `cargo clean` 或 `cargo sweep`；CI 用独立缓存目录 |

---

## 三、Cargo 依赖冗余表

workspace.dependencies 全量核对（声明处 = 根 Cargo.toml；使用处 = 引用该依赖的 crate）：

| 依赖 | 声明处 | 使用处 | 判定 |
|------|--------|--------|------|
| serde (derive) | workspace:38 | conex-types/db/diff/ipc/compaction/search/telemetry/markdown/sandbox、agent-provider、agent-tools、orchestrator、session-loop、workbench | 使用，正常 |
| serde_json | workspace:39 | 同上（多数 crate） | 使用，正常 |
| tauri (protocol-asset) | workspace:40 | agent-workbench（重复声明同 feature） | 使用；app 侧重复 feature 声明可简化 |
| tauri-build | workspace:41 | agent-workbench build-deps | 使用，正常 |
| reqwest (json/rustls-tls/stream) | workspace:42 | agent-provider（bytes_stream）、conex-net、agent-workbench | 使用；但 0.12 vs tauri 的 0.13 双版本（问题 2） |
| tracing (attributes) | workspace:43 | agent-provider、conex-telemetry、conex-test-utils、agent-workbench | 使用，正常 |
| tracing-subscriber | workspace:44 | conex-telemetry（补 env-filter）、conex-test-utils | 使用，正常 |
| anyhow | workspace:45 | conex-fs、agent-workbench | 使用，正常 |
| thiserror | workspace:46 | agent-provider、conex-types、conex-markdown、agent-workbench | 使用，正常 |
| tokio (full) | workspace:47 | 全部异步 crate + workbench | 使用；feature 过宽（问题 3） |
| async-trait | workspace:48 | agent-provider、agent-tools、orchestrator、session-loop、agent-workbench | 使用，正常 |
| rusqlite (bundled) | workspace:49 | conex-db | 使用，正常 |
| notify | workspace:50 | agent-workbench（perf/fs.rs） | 使用，正常 |
| ignore | workspace:51 | agent-tools、conex-search | 使用，正常 |
| sha2 | workspace:52 | conex-fs、agent-workbench | 使用，正常 |
| hex | workspace:53 | conex-fs | 使用，正常 |
| bytes | workspace:54 | agent-tools（output/fs/search/shell） | 使用，正常 |
| futures-util | workspace:55 | agent-provider、agent-workbench | 使用，正常 |
| derive_builder | workspace:56 | —（全仓库 0 引用） | **未使用，删除** |
| similar | workspace:57 | conex-diff | 使用，正常 |
| pulldown-cmark (simd) | workspace:58 | conex-markdown | 使用，正常 |
| syntect | workspace:59 | conex-markdown | 使用，正常 |
| ammonia | workspace:60 | conex-markdown | 使用，正常 |
| moka (sync) | workspace:61 | conex-markdown | 使用，正常 |
| once_cell | workspace:62 | conex-markdown、conex-types（但后者内联 `once_cell = "1"`） | 使用；conex-types 声明方式不一致（问题 12） |
| url | workspace:63 | conex-markdown、agent-workbench | 使用，正常 |
| uuid | workspace:64 | agent-provider | 使用，正常 |

其他说明：
- **孤儿 crate**：conex-net、conex-stream 未出现在任何 `dependencies` 引用中（问题 5）。
- **内联未提升**：regex="1"（4 处）、windows-sys 0.61（2 处）、tauri-plugin-dialog="2"、base64/chardetng/encoding_rs/memmap2/itertools/portable-pty/libc（仅 workbench 使用，可接受）。
- **feature 冗余**：workspace tokio=full 使 agent-provider/agent-tools/orchestrator/session-loop 各 crate 的补充 feature 声明（macros/rt/time/test-util 等）全部空操作；workbench 的 tokio full 与 workspace 重复。

---

## 四、npm 依赖冗余表

### apps/crish-desktop/package.json

| 依赖 | 声明处 | 使用处 | 判定 |
|------|--------|--------|------|
| @crish/shared-types | deps | 多文件 | 使用，正常 |
| @chenglou/pretext | deps | pretextCache.ts、sidebarMeasure.ts、useTextMeasure.ts、ToolCallOutput.tsx | 使用，正常 |
| @fontsource/*（4 包） | deps | fontStore.ts（动态 import 8 处） | 使用，正常 |
| @modelcontextprotocol/sdk | deps | mcpClient.ts | 使用，正常（vite 有 stub 支撑） |
| @radix-ui/react-popover | deps | 3 文件 | 使用，正常 |
| @tauri-apps/api | deps | 15+ 文件 | 使用，正常 |
| @tauri-apps/plugin-dialog | deps | openDirectoryDialog.ts | 使用，正常 |
| @types/dompurify | deps | 零引用 | **未使用，删除**（且类型包应在 devDeps） |
| @xterm/xterm + addon-fit + addon-webgl | deps | TerminalCard.xterm.tsx | 使用，正常（建议懒加载，见问题 9） |
| dompurify | deps | 零引用 | **未使用，删除** |
| highlight.js | deps | codeHighlight.ts 等 8 文件 | 使用，正常 |
| idb-keyval | deps | 零引用 | **未使用，删除** |
| immer | deps | store 层 31 文件 | 使用，正常 |
| lucide-react | deps | 105 文件 | 使用，正常（体积异常，问题 9） |
| react / react-dom | deps | 全应用 | 使用，正常 |
| tauri-plugin-mcp | deps | main.tsx（动态 import）、dev/mcpBridge.ts | 使用，正常 |
| use-sync-external-store | deps | 零引用 | **未使用，删除** |
| zod | deps | toolUtils.ts、ConfigService.ts、config-schema.ts | 使用，正常 |
| zustand | deps | store 层 25 文件 | 使用，正常 |

### 根 package.json

| 依赖 | 声明处 | 使用处 | 判定 |
|------|--------|--------|------|
| @xterm/*（3 包） | dependencies | 与 crish-desktop 重复声明 | **冗余，删除根侧** |
| ws | dependencies | 仅 tests/e2e/tauri-native-smoke.spec.ts + scripts/*.mjs | 错位，移 devDependencies |

### packages/*（工作区包）

| 包 | 说明 | 判定 |
|----|------|------|
| @crish/logger | deps: shared-types/shared-utils（file:） | 正常 |
| @crish/shared-types / shared-utils | 无第三方依赖 | 正常 |
| @crish/telemetry | deps 用 `"*"` 非 file:；**无消费者（孤儿包）** | 问题 18 |
| @crish/test-utils | clean 脚本 rimraf 未安装 | 问题 19 |
| @crish/plugin-sdk | 无依赖无脚本（骨架） | 正常 |
| apps/agent-workbench | deps: crish-desktop/shared-types/shared-utils（file:） | 正常 |

---

## 五、构建配置残留清单

| 文件 | 残留 | 建议 |
|------|------|------|
| apps/crish-desktop/vite.config.ts | **无 daemon 残留**：manualChunks 的 daemon-bridge/chat-stream-core/vendor-workers 均指向现存文件（daemonChatBridge.ts、StreamRenderBuffer.ts、workers/）；nodeBuiltinStubPlugin + optimizeDeps exclude MCP SDK 为 MCP stdio 必需，保留 | optimizeDeps include 中删 'dompurify'（随包删除）；chunkSizeWarningLimit 1100 恢复默认以暴露 1.06 MB 主 chunk |
| turbo.json | 任务与各包 scripts 匹配良好（build/build:types/build:js/typecheck/clean 均有定义）；无死任务 | 可选：补 `inputs` 声明细化缓存；无必须修改项 |
| 根 package.json scripts | 全部 44 个脚本目标文件存在（tests/fuzz 不存在但有 `\|\| echo` 兜底） | 无死脚本；`check:deps` 依赖被忽略的 .dependency-cruiser.cjs（问题 27） |
| apps/agent-workbench/vitest.config.ts | workbench src 已空，include 匹配 0 文件 | 删除 |
| tauri.conf.json | frontendDist ../../crish-desktop/dist 与构建产物一致（dist 3.77 MB 存在）；icons 5 个引用全部存在；无 resources 键，已删的 crish-agent-daemon.bundle.js 无残留引用；但 beforeBuildCommand 依赖 npm 向上查找、updater pubkey 空、CSP 8765 端口残留（问题 22/23/25） | 见问题清单 |
| apps/crish-desktop/package-lock.json + pnpm-lock.yaml + pnpm-workspace.yaml | 三重锁文件混用 | 保留根 lock，删 app 级 lock 与 pnpm 文件（问题 20） |
| .gitignore | 缺 `.turbo/`、缺 sessions.db；target-tauri-dev 重复 3 次；`**/target/`+`src-tauri/target/` 重复（目录已不存在）；Cargo.lock 被忽略（问题 1） | 见问题清单 |
| apps/agent-workbench/scripts/ 目录 | workbench 无脚本引用该目录（残留目录） | 检查后删除 |

---

## 六、根目录遗留文件清单（仅列出，未删除）

### 1. 日志 / 输出 / 报告类（根目录）
build-log.txt、cargo-clippy-allow-preexisting.log、cargo-clippy-allow2.log、cargo-clippy-stream-clean.log、cargo-clippy-stream-crates.log、cargo-clippy-stream-z.log、cargo-clippy-workbench.log、cargo-test-stream-z.log、cargo-test.txt、cov-out.txt、coverage-summary.txt、depcruise-output.txt、depcruise-r3-output.txt、depcruise-r3.txt、dev-workbench-restart.log、git_status_full.txt、pnpm-test-stream-z.log、tauri-dev.log、vitest-coverage.txt、vitest-unit-stream-z.log、ts-errors-cur.txt、ts-rem.txt、scratch_tsc_report.txt、.tmp-check.log、.tsc-errors-current.txt、.tsc-errors.txt、.tsc-errors.txt 同族、_commit_output.txt、_eslint_full.txt、_staged_ts.txt、.git-commit-msg.txt、commit-msg.txt

### 2. tmp_* / mcp-args / 调试 json
tmp_check_shell.js、tmp_check_state.js、tmp_click_overview.js、tmp_find_buttons.js、tmp_mcp_args.json、tmp_mcp_call_args.json、tmp_mcp_call.mjs、tmp_mcp_exec.mjs、tmp_mcp_query.mjs、mcp-args-appinfo.json、mcp-args-appstate.json、mcp-args-bridge.json、mcp-args-chat.json、mcp-args-click.json、mcp-args-daemon.json、mcp-args-daemon2.json、mcp-args-enter.json、mcp-args-inject.json、mcp-args-js.json、mcp-args-js2.json、mcp-args-js3.json、mcp-args-logs.json、mcp-args-logs2.json、mcp-args-map.json、mcp-args-mark.json、mcp-args-query.json、mcp-args-read.json、mcp-args-read2.json、mcp-args-send.json、mcp-args-state.json、mcp-args-sync.json、mcp-args-type.json、mcp-args-win.json、mcp-args.json、mcp-output.json、console-capture.json、render-setstate-diagnosis.json、topbar-inspect-report.json、.tmp-args.json、.tmp-shot.json、.tmp-type.json

### 3. 演示 / 单页 HTML
chat_composer.html、icon - 副本.html、icon-splash.html、icon-static.html、icon.static.html、replicate_topbar_demo.html、smart_expandable_panel.html、revert_changes_modal_demo.html

### 4. 规划 / 一次性 md、txt
new.md、suggestions.md、suggestions-v2.md、history.txt、compaction_summary_output.md、runtime_telemetry_report.md、0613-0055-plan.md、0613-0553.md（后两者已跟踪）、COMPREHENSIVE-REFACTOR-PLAN.md、FINAL-COMPREHENSIVE-REFACTOR-PLAN.md、FINAL-REFACTORING-ROADMAP.md、IMPROVEMENT-PLAN-MASTER.md、TOKEN-SYSTEM-REFACTOR-PLAN.md、TOKEN-SYSTEM-REFACTOR-PROMPT.md、CRISH_UI_SYSTEMIC_OVERHAUL_MASTER_PLAN.md、CRISH_UI_SYSTEMIC_OVERHAUL_PLAN.txt 等一批已跟踪的历史规划文档（经 .gitignore 新规则已停止新增，存量跟踪需另行决议）

### 5. 目录类
dist/（仅 62 KB test-build.js，陈旧产物）、target/（53.5 GB，Rust 构建产物）、.turbo/（未忽略，见问题 10）、temp_icons/、temp_jcode/、perf-report/、debug_investigation/、test-results/、scratch/、mcps/、implementer/、.codex/、.codex-tool-scratch/、.firecrawl/、.agent-runtime/、.workbuddy/、.zcode/、NUL（已忽略）

### 6. 已跟踪但可疑
- apps/agent-workbench/sessions.db（700 KB 运行时库，见问题 11）
- restore_localstorage.js（根，调试脚本误入库）
- scripts/ 下批量调试产物（均已忽略未跟踪）：batch-*.json x6、tmp-args*.json、mcp-args.json、ui-selectors-manifest.json、parsed-events-summary.json、inspections-output.json、component-files-list.json、store-loop-audit-report.md、test-buttons-result.png 等
- apps/crish-desktop/scripts/ 约 60 个 CDP/tauri 调试 mjs + png（目录整体已忽略）
- apps/crish-desktop/ 根 tsc-*.log x6、vitest-sessionTime.log（已忽略）

---

## 附：核查过无问题的项

- turbo.json pipeline：build/build:types/build:js 依赖图（^dependsOn）正确，outputs 与实际产物一致（dist/**、.tsbuildinfo、*.d.ts、*.js）
- vite manualChunks：daemon-bridge（326 KB）/ chat-stream-core / vendor-workers 均对应现存源文件，非残留
- tauri 打包：frontendDist 与实际 dist 一致；5 个 icon 引用全部存在；已删资源（crish-agent-daemon.bundle.js）在 tauri.conf.json 与代码中均无引用
- 根 package.json 44 个脚本无死脚本（目标文件全部存在）
- 依赖版本一致性：react/react-dom/zustand/immer/typescript/vite 等在各处版本一致
