# PE-10 依赖与构建清理方案（Deps & Build Cleanup Plan）

- 日期：2026-08-01
- 类型：方案文档（只读研究 + 规划，不含任何代码修改）
- 依据：`docs/rust-rewrite/audits/AA-08-deps-build-review.md`（问题清单 29 项），以及本次核查对仓库当前状态的再确认
- 适用范围：根 `Cargo.toml`、`crates/*`、`apps/agent-workbench/src-tauri`、根/各 app 的 `package.json`、`vite.config.ts`、`.gitignore`、`tauri.conf.json`、CI 工作流
- 完成定义（DoD）：清理后全量 `cargo test --workspace` 与前端 `npm run build` 通过；`Cargo.lock` 被 git 跟踪并含唯一 reqwest 版本；无死依赖、无残留文件

---

## 修订记录

| 版本 | 日期 | 修订依据 | 要点 |
|---|---|---|---|
| v1 | 2026-08-01 | — | 初版 |
| v2 | 2026-08-01 | **AU-04 接口冻结裁决** | ① 无契约级修订，批次 A 与业务任务任意并行（PE-10 修订指令 1）；② 批次 B 项 15（tauri-plugin-mcp 锁 rev）与 **PE-07 批 5 会签（C21）**：`rev=c7d271a06469bdf4744bfdeadca7458a1f3d02e5` 锁定先行（无论后续是否移除插件均必须且无害）；若插件被移除，`dev-mcp` feature 化优化项随之激活；③ **Cargo.toml 依赖增量统一由本任务管理**：PE-04 tracing-appender 0.2、PE-09 criterion 0.5 只提需求、由本任务落依赖声明（修订指令 2）；④ transport/mod.rs 与 PE-09 T09.1.2 串行（本任务先行：reqwest 0.13 后 stream_frames 无 API 差异）；⑤ 前端 package.json / vite.config.ts 与 PE-05 新增 check 脚本不并行（批次 C 与 PE-05 错开） |

---

## 一、背景与目标

### 1.1 背景

仓库处于 Rust 侧重构（B 阶段）进行中：daemon/sidecar/CLI 已删除，工作区存在大量未提交删除。此背景下依赖清单与构建配置出现三类问题：

1. **可复现性**：`Cargo.lock` 被 `.gitignore:134` 忽略，任何全新克隆的构建结果无法复现；git 依赖（tauri-plugin-mcp）未锁 rev，锁文件一旦重新生成即可能漂移。
2. **依赖冗余**：Cargo 侧双 reqwest（0.12 + 0.13）、tokio `full` 全开、derive_builder 零引用、conex-net/conex-stream 孤儿 crate、regex/once_cell/windows-sys 多处内联；npm 侧 4 个零 import 包、ws 错放、@xterm 根级重复、pnpm 锁文件混用。
3. **残留清理**：bundle 主 chunk 1.06 MB（被 chunkSizeWarningLimit=1100 掩盖）、vendor-lucide 553 KB（namespace 导入导致 tree-shaking 失效）、`.turbo/` 未忽略、sessions.db 入库、根目录 6 类遗留文件。

### 1.2 目标

| 目标 | 说明 | 对应任务 |
|------|------|----------|
| G1 依赖最小化 | 无死依赖（Cargo + npm 两侧）、无重复大版本（reqwest）、feature 最小集（tokio）、内联声明收敛 | T10.2 / T10.3 / T10.4 / T10.5 / T10.6 |
| G2 构建可复现 | Cargo.lock 恢复跟踪并持续维护；git 依赖锁 rev；CI 使用 `--locked`；npm 锁文件唯一化 | T10.1 / T10.10 / T10.6 |
| G3 清理残留 | 构建体积可解释（chunk 拆分、lucide 修复）；运行时产物与调试文件出库（sessions.db）；.gitignore 完善；根目录遗留文件清零 | T10.7 / T10.8 / T10.9 |

### 1.3 非目标

- 不引入新的构建工具链（cargo-sweep 等仅作建议项，不强制）。
- 不重构业务代码（React.lazy 拆分除外，属体积任务的一部分且为纯声明式改动）。
- 不升级 Rust edition / toolchain。
- 传递依赖的多版本（windows-sys ×5、thiserror 1+2、toml ×3 等）以记录为主，仅处理 workspace 自身声明与 tauri 对齐（T10.10 附注）。

### 1.4 核查事实更新（相对 AA-08 的增量确认）

本次执行前对仓库现状做了再核查，以下结论与 AA-08 一致但补充了细节，任务执行时应以此为准：

1. **Cargo.lock 现状**：文件 188 KB（2026-08-01 0:10 生成，version = 4），当前内容**已包含** `crish-agent-workbench`（1052 行）与 `tauri-plugin-mcp` git 依赖（5685 行，锁在 `c7d271a`），并同时存在 `reqwest 0.12.28` 与 `reqwest 0.13.4`（5543 行，tauri→0.13.4）。即"过期"状态部分修复，但文件仍未跟踪、无 `--locked` 约束，双 reqwest 确认存在。
2. **tauri-plugin-mcp 接线**：`main.rs:126-134` 仅在 `#[cfg(debug_assertions)]` 下注册插件，但 Cargo.toml 中依赖声明**无条件**（release 也会编译链接该 git 依赖）。
3. **vendor-lucide 根因已定位**：`apps/crish-desktop/src` 下至少 5 处 `import * as Lucide from 'lucide-react'`（ApprovalAskCard.tsx / AgentTeamBoard.tsx / AgentCard.tsx / agent-card/AgentBrowsePad.tsx / ChatHeaderMore.tsx 等），namespace 导入会禁用 tree-shaking，与 553 KB chunk 直接相关。其余多为命名导入，属正常。
4. **App 主 chunk**：1062033 B（App-Dy3JNisM.js）；React.lazy 已有 41 处，但 1.06 MB 仍超标，说明仍有大模块在首屏静态链路（xterm 终端、设置页等）。
5. **tokio 实际使用面**（按 crate 枚举，见 T10.3 表）：agent-provider 需要 net/io/sync/time/select/spawn + 测试用 test-util；agent-tools 需要 process/io/sync/time；workbench 需要 process/sync/time/task；orchestrator 用到 `tokio::runtime`；conex-stream 的 src 无任何 `tokio::` 调用（tests 亦无）。
6. **ws**：仅 `tests/e2e/tauri-native-smoke.spec.ts:5` 有 `import WebSocket from 'ws'`；scripts/*.mjs 未检索到 ws 引用（AA-08 所述 scripts 使用未能复现，但仍属测试/脚本域，结论不变：移 devDependencies）。
7. **CI**：`.github/workflows/ci.yml` 中 `cargo check --workspace` / `cargo clippy --workspace -- -D warnings`（99-100 行）未加 `--locked`；另有 cargo-deny 任务（79 行起），与 Cargo.lock 恢复跟踪协同良好。
8. **锁文件混用现状**：`apps/crish-desktop/pnpm-lock.yaml`、`pnpm-workspace.yaml`、`package-lock.json` 均被跟踪；根 `package-lock.json` 被跟踪。packages/agent-model、packages/agent-runtime 已在磁盘删除但 git 中仍跟踪其 package-lock.json（随目录删除一并处理）。
9. **遗留文件目录**：`.turbo/cache` 存在且未跟踪；根 `dist/` 仅含 test-build.js（62 KB）；`apps/agent-workbench/scripts/` 含 mcp-probe.mjs、mcp-test.mjs（无脚本引用）；`.dependency-cruiser.cjs` 与 `.mcp.json` 均存在但被 ignore（lint:depcruise 脚本依赖前者）。

---

## 二、任务分解

### T10.1 Cargo.lock 恢复跟踪（G2 核心）

**现状**：`.gitignore:134` `Cargo.lock`；文件未跟踪；CI 无 `--locked`。

**执行步骤**：

1. `.gitignore` 删除第 134 行 `Cargo.lock`（注意该文件被全局 `*.txt/*.json` 兜底规则覆盖与否无关——Cargo.lock 无扩展名后缀规则，直接移除该行即可）。
2. 在干净状态下重新生成锁文件，保证与当前成员清单一致：
   ```powershell
   cargo generate-lockfile
   ```
   生成后核查：`rg -n 'name = "crish-agent-workbench"' Cargo.lock` 存在；`rg -n 'name = "reqwest"' Cargo.lock` 仅 1 处（收敛后，见 T10.2）；`rg -n 'name = "tauri-plugin-mcp"' Cargo.lock` 存在且 source 行带 rev。
3. `git add Cargo.lock` 提交跟踪；此后任何 `cargo` 操作导致的 lock 变更随功能提交一起 review。
4. **CI 影响评估**：
   - `ci.yml:99-100` 改为 `cargo check --locked --workspace`、`cargo clippy --locked --workspace -- -D warnings`，防止 lock 漂移被静默吞掉；若 lock 与 Cargo.toml 不一致 CI 立即失败，把"锁文件同步"变成提交时义务。
   - cargo-deny（ci.yml:79）建议补 `--bans multiple-versions` 检查（可先在 advisories 白名单排除传递依赖噪音，或仅作为警告），与 T10.2 的双版本收敛形成闭环。
   - 若后续有 taury release 构建（含 MSI），CI 缓存需以 lock 为键（actions/cache `key: ${{ runner.os }}-cargo-${{ hashFiles('Cargo.lock') }}`），锁文件跟踪后缓存命中率显著提高。
5. **回滚**：重新加回 ignore 行即可，无副作用。

**风险**：当前 lock 是 2026-08-01 0:10 生成的新版本，与 tauri 依赖图一致，重新 generate 与现状差异极小；唯一注意点是 `cargo generate-lockfile` 在 Windows 下以 CRLF 写行尾——提交前保持 cargo 默认格式即可（git 端 `core.autocrlf` 行为与现有文件一致，无需特殊处理）。

---

### T10.2 reqwest 双版本收敛（0.12 → 0.13）

> **串行声明（AU-04 PE-10 修订指令 3）**：transport/mod.rs 与 **PE-09 T09.1.2 串行**——本任务先行
> （reqwest 0.13 升级后 `stream_frames` 无 API 差异），PE-09 步骤 1 基于升级后的依赖实施。

**现状**：`Cargo.toml:42` workspace 钉 `reqwest = { version = "0.12", ... }`；tauri 2.11.2 依赖 reqwest 0.13.4；锁文件同时含 0.12.28 与 0.13.4，二进制链接两套 HTTP/hyper 栈。

**影响面评估（0.12 → 0.13 差异）**：

| 维度 | 0.12 | 0.13 | 迁移注意 |
|------|------|------|----------|
| MSRV | 1.63 | 1.75 | workspace 无显式 MSRV 声明，toolchain 为最新 stable，无影响 |
| rustls-tls 组合 feature | `rustls-tls` 仍存在 | 0.13 新增 `rustls` feature 组（`rustls-ring` 等），旧名 `rustls-tls` 保留但建议迁移 | 0.13 弃用 `rustls-tls` 命名（警告级），建议直接使用 `rustls` 组 |
| `stream` feature | 存在 | 存在 | 无变化 |
| `bytes_stream()` | 可用 | 可用 | 无变化 |
| header API | `reqwest::header` | 同 | 无变化 |
| Error 结构 | `reqwest::Error` | 同，新增 `is_builder_error` 等 | 无破坏性变化 |

**workspace 直接使用点**（经核查）：`agent-provider`（src/retry.rs、src/transport/mod.rs、src/sse/reader.rs —— ClientBuilder/Client、SSE 读取）、`apps/agent-workbench/src-tauri`（engine.rs:207/215/262/271、commands.rs:47 —— Client::builder、header::RETRY_AFTER）。conex-net 亦引用 reqwest（孤儿 crate 裁决见 T10.5，若删除则少一个使用点）。

**执行步骤**：

1. 根 `Cargo.toml:42` 改为：
   ```toml
   reqwest = { version = "0.13", default-features = false, features = ["json", "rustls", "stream"] }
   ```
   （`rustls` 组 feature 在 0.13 中开启 rustls-ring 传输层；若构建报 `rustls` 未识别则回退 `rustls-tls`——二者在 0.13 均存在，以本地 `cargo build` 验证为准。）
2. 对 4 个使用点逐一跑 `cargo check -p agent-provider -p crish-agent-workbench -p conex-net`，修正任何 API 差异（预期为 0 或极少，因 0.13 相对 0.12 无破坏性 API 变更）。
3. 更新锁文件后核查 `rg -n 'name = "reqwest"' Cargo.lock` 仅 1 处，`hyper`/`hyper-util` 同理收敛（tauri 与 workspace 共用一套）。
4. `cargo test -p agent-provider` 全量跑（retry/abort/classify 测试覆盖传输层），验证行为无回归。

**风险**：
- MSRV 提升（1.63→1.75）：CI/本地 toolchain 远高于此，无实际影响；若未来有 MSRV 诉求需记录。
- feature 命名变化导致编译失败：仅可能发生在 `rustls` 命名不支持的中途版本，用 `cargo build` 实测回退即可。
- 体积预期收益：消除一套 hyper/tower 副本，release 体积估计减少数 MB（不承诺精确值，验证时用 `cargo build --release` 前后对比）。
- **不做**：不升级 workspace 内其它 HTTP 相关依赖（本任务仅收敛 reqwest 版本）。

---

### T10.3 tokio feature 最小化

**现状**：`Cargo.toml:47` `tokio = { version = "1", features = ["full"] }`，令全部 workspace crate 获得 fs/process/signal/io-std/rt-multi-thread 等无用 feature；各 crate 的补充 feature 声明（agent-tools dev 的 macros/rt/process/time、orchestrator dev 的 macros/rt、session-loop dev 的 macros/rt/time、agent-provider 的 test-util）在 full 下多数为空操作；workbench `Cargo.toml:25` 内联重复声明 `tokio = { version = "1", features = ["full"] }`。

**逐 crate tokio 需求表**（基于 src + tests 的 `tokio::` 引用核查）：

| crate | 需要 feature | 说明 |
|-------|--------------|------|
| agent-provider | rt、macros、time、sync、net、io-util、（dev）test-util | retry.rs 用 select!/spawn/time；transport 用 net/io；tests 用 time::pause/advance |
| agent-tools | rt、macros、time、sync、process、io-util、（dev）macros/rt/process | mcp/bridge.rs 用 process/io/sync/time；shell.rs 用 process；tests 用 CARGO_BIN_EXE 起子进程 |
| orchestrator | rt、macros、time、sync、（dev）macros/rt | persist.rs 用到 `tokio::runtime`（验证是 Handle 还是 Runtime::new——后者需 `rt-multi-thread`，必要时在 orchestrator 局部补 feature） |
| session-loop | rt、macros、time、（dev）macros/rt/time | tool_exec.rs 用 time/join_all；tests 用 spawn/time |
| conex-net | rt、macros、time | lib.rs 仅 time（T10.5 裁决后可能整体删除） |
| conex-stream | — | src 无任何 tokio 使用（T10.5 裁决后可能整体删除） |
| agent-workbench | rt、macros、time、sync、process、task | process.rs 用 tokio::process；core_run_commands 用 sync/time；perf/fs.rs 用 sync/time/select；core_commands/markdown_commands 用 task::spawn_blocking |
| conex-* 其余（db/fs/diff/ipc/…） | — | 无 tokio 引用（无依赖） |

**执行步骤**：

1. 根 `Cargo.toml:47` 改为最小集：
   ```toml
   tokio = { version = "1", default-features = false, features = ["rt", "macros", "time", "sync", "net", "io-util", "process"] }
   ```
   - `default-features = false` 必须显式声明（tokio 默认含 rt），最小集已含 rt 故无功能损失。
   - `process` 由 agent-tools 与 workbench 需要，放 workspace 级统一提供；`rt-multi-thread` 仅在 orchestrator 确需 `Runtime::new` 时于该 crate 局部补充（验证步骤确定）。
2. agent-provider 保持 `features = ["test-util"]` 局部补充（retry.rs 测试用 time::pause/advance，AA-08 建议与本表一致）；其余 crate 的补充声明在确认无多余后保留最小项。
3. workbench `Cargo.toml:25` 删除内联重复，改 `tokio.workspace = true`（其 full 由 workspace 最小集取代）。
4. 验证：
   ```powershell
   cargo build --workspace
   cargo test --workspace
   ```
   任一 crate 报缺少 feature（如 `time` 未开）时，先核对实际使用点再决定补 workspace 级还是 crate 局部。
5. 验收：`rg -n '"full"' Cargo.toml crates apps/agent-workbench/src-tauri/Cargo.toml` 无命中；`cargo tree -e features -i tokio` 中不再出现 full。

**风险**：低。feature 缺省会以编译错误暴露，逐项补齐即可；二进制行为不受影响（无运行时差异）。附带收益：缩短增量编译时间、降低 test-util/process 等对不需要 crate 的编译开销。

---

### T10.4 死依赖删除与重复声明收敛

#### T10.4a derive_builder 删除

**核查**：全仓库 0 处 `derive_builder` 引用、0 处 `#[derive(Builder)]`（rg 全量确认）。`Cargo.toml:56` 直接删除，`cargo build` 验证锁文件无残留。

#### T10.4b 内联重复声明收敛

| 依赖 | 现状 | 动作 |
|------|------|------|
| regex | `Cargo.toml` workspace 无声明；内联 4 处：agent-tools:21、conex-markdown:20（deps）+26（dev-deps 重复）、conex-sandbox:15、workbench:39 | workspace 新增 `regex = "1"`，4 处改 `regex = { workspace = true }`；conex-markdown dev-deps 的重复 regex 删除（deps 已有同名） |
| once_cell | conex-types:17 内联 `once_cell = "1"`；workspace:62 已声明 | conex-types 改 `once_cell = { workspace = true }` |
| windows-sys | 内联 2 处：agent-provider:29（Win32_Foundation/Security_Cryptography）、workbench:61（+JobObjects/Power）；均位于 `[target.'cfg(windows)'.dependencies]` | workspace 新增 `windows-sys = { version = "0.61", features = [] }`，两处改为 `windows-sys = { workspace = true, features = [...] }`（target 段可正常引用 workspace 依赖，feature 各自保留） |
| tokio | workbench:25 内联 full（T10.3 已处理） | — |
| tauri | workbench:21 `tauri = { workspace = true, features = ["protocol-asset"] }` 与 workspace:40 声明重复 | 保留现状（局部补 feature 是合法模式），仅确认无冗余即可 |
| futures | session-loop:16 `futures = "0.3"`（完整 crate） | 核查 tool_exec.rs:162 `futures::future::join_all` 与 tests 用点；若仅 StreamExt/FutureExt/join_all，改 `futures-util = { workspace = true }` 并替换引用为 `futures_util::future::join_all`（`futures::future::join_all` 在 futures 0.3 下等价 `futures_util` 的 re-export，可 `use futures_util::future::join_all`） |

#### T10.4c 验证

```powershell
cargo build --workspace
cargo test --workspace
cargo tree -i regex; cargo tree -i once_cell; cargo tree -i futures   # 确认单版本
```

---

### T10.5 孤儿 crate 裁决（conex-net / conex-stream）

**现状**：
- `conex-net`：deps = reqwest + tokio；src/lib.rs 仅一处 `tokio::time` 使用；无任何 workspace 成员引用它（rg 全量确认，仅自身 Cargo.toml 出现）。
- `conex-stream`：deps = tokio + bytes + conex-types；src 与 tests **无任何 tokio/bytes 使用**（lib.rs 仅类型定义）；无任何引用方。

**裁决依据**：
1. 两者为 B 阶段重构前（daemon 时代）的网络/流基础设施的遗留；daemon 删除后失去唯一宿主。
2. 引用方全量检索（`rg "conex-net|conex-stream" crates apps`）仅命中各自 Cargo.toml，确认"编译但不链接"。
3. agent-provider 已内建 reqwest 传输层（transport/sse），无抽象复用必要；session-loop 的流式依赖由 futures-util 承担。
4. git 历史意图：若存在 A 阶段设计文档说明其用途（`docs/` 检索确认无活跃设计引用），无恢复必要。

**结论（建议）**：

| 选项 | 动作 | 代价 |
|------|------|------|
| A. 删除（推荐） | 从 `Cargo.toml` members 移除，`git rm crates/conex-net crates/conex-stream`（如已跟踪）或直接删除目录 | 若未来需要 HTTP 工具层需重建（成本极低，agent-provider 已有等价能力） |
| B. 接线 | 由 workbench/orchestrator 依赖 | 无真实需求点，强行接线制造死代码，不采纳 |

执行：若确认删除，`cargo generate-lockfile` 后核查锁文件无 `conex-net`/`conex-stream` 条目，`cargo test --workspace` 通过。

---

### T10.6 npm 依赖清理

#### T10.6a 零 import 包删除（AA-08 #6/#7/#8，均已复核零引用）

| 包 | 所在文件:行 | 动作 |
|----|------------|------|
| dompurify | apps/crish-desktop/package.json:34 | 删除 |
| @types/dompurify | apps/crish-desktop/package.json:30 | 删除（类型包本就应在 devDeps） |
| idb-keyval | apps/crish-desktop/package.json:36 | 删除 |
| use-sync-external-store | apps/crish-desktop/package.json:42 | 删除（react 19 / zustand 自带） |

同步动作：`vite.config.ts:205` optimizeDeps.include 删除 `'dompurify'` 条目（其余 react/react-dom/@radix-ui/lucide-react/zustand/immer/highlight.js 保留）。

#### T10.6b ws 错放修复（AA-08 #16）

根 `package.json:92` `ws` 从 dependencies 移入 devDependencies（使用者：tests/e2e/tauri-native-smoke.spec.ts）。执行后 `rg -n "from 'ws'" apps packages tests scripts` 确认无 src 引用。

#### T10.6c 根级 @xterm 重复声明删除（AA-08 #17）

根 `package.json:89-91` 删除 @xterm/xterm、@xterm/addon-fit、@xterm/addon-webgl；保留 crish-desktop 的声明（同版本，已确认无版本漂移）。

#### T10.6d packages/telemetry 处理（AA-08 #18）

- 依赖 `"*"` 改 `file:../shared-types`、`file:../shared-utils`（与其余包一致）。
- **孤儿裁决**：全仓库无消费者（rg 确认无 import '@crish/telemetry'）。选项：
  - A（推荐）：保留包但统一 file: 声明，标记为"预留遥测接入点"，由后续产品决策是否接入；
  - B：移出 workspaces + 删除目录。
  - 本方案建议先执行 A（改动最小、无删除风险），在 T10.11 验证后记录决策待产品确认。
- 若执行 A，注意 `"@crish/shared-types": "*"` 与 `shared-utils "*"` 会解析到 npm registry 上的同名包而非本地——这就是必须改 file: 的原因（当前 `*` 声明可能已被 npm 安装为外部包，需 `npm install` 刷新）。

#### T10.6e pnpm 混用清理（AA-08 #20）

- `git rm apps/crish-desktop/pnpm-lock.yaml apps/crish-desktop/pnpm-workspace.yaml`（已跟踪）。
- `apps/crish-desktop/package-lock.json` 删除（已跟踪），统一以根 `package-lock.json`（npm workspaces）为准。
- 重新 `npm install` 生成干净的根锁文件；核查 lock 中不再含 pnpm/仅含 npm 条目。
- packages/agent-model、packages/agent-runtime 目录已在磁盘删除，其跟踪的 package-lock.json 随目录删除清理。

#### T10.6f 残留配置文件删除（AA-08 #21 + 第五节）

- 删除 `apps/agent-workbench/vitest.config.ts`（src 已空，include 匹配 0 文件）。
- 删除 `apps/agent-workbench/scripts/`（mcp-probe.mjs、mcp-test.mjs，无脚本引用；若判定有调试价值，移入根 scripts/ 并保留，二选一，默认删除）。
- 修复 `packages/test-utils/package.json:9` clean 脚本：`rimraf dist` → `node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"`（与 logger/shared-types/shared-utils 一致，AA-08 #19）。

#### T10.6g 验证

```powershell
npm install          # 刷新锁文件
npm run build        # turbo 全量（含 crish-desktop build:desktop）
npm run typecheck:ci
npx depcruise --config .dependency-cruiser.cjs packages apps   # 见 T10.8 对 .dependency-cruiser.cjs 的裁决
```

---

### T10.7 bundle 体积

**现状**：dist/assets 共 3.77 MB / 115 文件；最大为 App-Dy3JNisM.js 1062033 B、vendor-lucide 552986 B；`vite.config.ts:216` `chunkSizeWarningLimit: 1100` 掩盖问题。

#### T10.7a vendor-lucide 553 KB 修复（根因已定位）

- 根因：`import * as Lucide from 'lucide-react'` namespace 导入（≥5 处）禁用 tree-shaking，整个图标库被打包。
- 动作：将 namespace 导入改写为命名导入。执行前先量化：
  ```powershell
  rg -n "Lucide\." apps/crish-desktop/src --glob "*.tsx" --glob "*.ts" | % { $_ -split ':' | select -Skip 1 } | % { $_ -match 'Lucide\.(\w+)' | Out-Null; $Matches[1] } | Sort-Object -Unique
  ```
  生成该文件实际使用的图标名集合，逐文件改写 `import * as Lucide` → 具名导入（如 `import { Search, X } from 'lucide-react'`）。
- 验收：改写后重新 build，vendor-lucide 目标降至 ~100-200 KB 量级（以实际为准）；`rg -n "import \* as Lucide" apps/crish-desktop/src` 无命中。
- 若某些文件通过 `Lucide[name]` 动态索引（此模式无法具名导入），对这类文件单独处理：动态 key 集合若为静态字面量则枚举具名导入；若为运行时任意 key（`icon: LucideIcon` 数据驱动），评估改为 `lucide-react` 按需映射表或接受该 chunk 体积。**执行顺序**：先全部静态改写，剩余动态场景单独报告。

#### T10.7b App 主 chunk 1.06 MB 分析

- 恢复默认阈值：`vite.config.ts:216` 删除 `chunkSizeWarningLimit: 1100`（回到默认 500），让超标 chunk 暴露在 build 输出。
- 拆分候选（React.lazy 已有 41 处，需补的剩余静态链路）：
  1. **xterm 终端**（TerminalCard.xterm.tsx 使用 @xterm/xterm + addon-fit + addon-webgl）：改 React.lazy + Suspense 按需加载——xterm 为编辑器外的低频功能（AA-08 #9 建议）。
  2. **设置页**（settings 相关）：按路由懒加载。
  3. **markdown 渲染 / highlight** 已在 vendor-highlight 独立 chunk，无需动。
- 验证方法：改动前记录 `dist/assets` 各文件大小；改动后对比 App-*.js 与新增 chunk；`npm run build` 后确认无 >500 KB 警告或残余超限项有明确理由。
- 若 App chunk 仍 >500 KB，保留警告并记录理由（首屏核心业务不可拆），不做无意义强制拆分。

---

### T10.8 .gitignore 完善与根目录遗留文件裁决

#### T10.8a .gitignore 结构修正

| 行 | 现状 | 动作 |
|----|------|------|
| 134 | `Cargo.lock` | 删除（T10.1） |
| 11/86/143 | `target-tauri-dev/` ×3 | 合并保留 1 处（放 "Tauri" 段） |
| 14/87 | `**/target/` ×2（且 15 行 `apps/agent-workbench/src-tauri/target/` 冗余） | 合并为 `**/target/` 1 处 |
| — | 缺 `.turbo/` | 新增 `.turbo/`（根 turbo cache） |
| — | 缺 sessions.db | 新增 `**/sessions.db`（或 `apps/agent-workbench/sessions.db`，见 T10.9） |
| 180 | `.dependency-cruiser.cjs` | 裁决见 T10.8b |
| 181 | `.mcp.json` | 裁决见 T10.8b |
| 157-168 | 全局 `*.txt/*.json/*.html/*.png/*.mjs` 兜底忽略 | **保留**（已生效防新增杂物），但需确认例外规则覆盖所有被跟踪的正当文件类型（`!package.json`/`!package-lock.json`/`!tsconfig.json`/`!docs/**/*.md` 等已在）；**注意**：`*.json` 兜底不会影响 Cargo.lock（无扩展名）；若根级存在合法待跟踪的 .html/.mjs 文件，在例外区补 `!` 规则 |
| — | `dist/`（5 行） | 保留（构建产物） |

#### T10.8b .dependency-cruiser.cjs / .mcp.json 裁决（AA-08 #27）

- `.dependency-cruiser.cjs`：`lint:depcruise`（根 package.json:59）依赖它，但文件被 ignore 且未跟踪 → 全新克隆后脚本必失败。**裁决：取消 ignore，纳入跟踪**（它是项目的依赖图配置，属源码资产）。
- `.mcp.json`：MCP 编辑器工具配置。**裁决：删除脚本引用路径或纳入跟踪二选一——建议纳入跟踪**（配置无敏感信息，利于团队共享）；若包含本地路径/密钥则删除文件本身并移除引用。

#### T10.8c 根目录遗留文件逐条裁决（AA-08 第六节 6 类）

以下裁决统一原则：**日志/调试产物 → 删除；演示/规划文档 → 有跟踪的按 git rm 移除或归档到 docs/archive/（已 ignore）；构建缓存 → 删除或 ignore；目录类 → 按目录清理**。

**类 1：日志 / 输出 / 报告（根目录，全部未跟踪）→ 删除**

| 文件 | 裁决 | 备注 |
|------|------|------|
| build-log.txt、cargo-clippy-allow-preexisting.log、cargo-clippy-allow2.log、cargo-clippy-stream-clean.log、cargo-clippy-stream-crates.log、cargo-clippy-stream-z.log、cargo-clippy-workbench.log、cargo-test-stream-z.log、cargo-test.txt、cov-out.txt、coverage-summary.txt、depcruise-output.txt、depcruise-r3-output.txt、depcruise-r3.txt、dev-workbench-restart.log、git_status_full.txt、pnpm-test-stream-z.log、tauri-dev.log、vitest-coverage.txt、vitest-unit-stream-z.log、ts-errors-cur.txt、ts-rem.txt、scratch_tsc_report.txt、.tmp-check.log、.tsc-errors-current.txt、.tsc-errors.txt、_commit_output.txt、_eslint_full.txt、_staged_ts.txt、.git-commit-msg.txt、commit-msg.txt | **删** | 一次性运行输出，无复现价值；.gitignore 已有 `*.log`、`*.txt`、`tsc-errors*` 等规则，删除后不会再产生跟踪噪音 |

**类 2：tmp_* / mcp-args / 调试 json（全部未跟踪）→ 删除**

| 文件 | 裁决 | 备注 |
|------|------|------|
| tmp_check_shell.js、tmp_check_state.js、tmp_click_overview.js、tmp_find_buttons.js、tmp_mcp_args.json、tmp_mcp_call_args.json、tmp_mcp_call.mjs、tmp_mcp_exec.mjs、tmp_mcp_query.mjs、mcp-args-appinfo.json、mcp-args-appstate.json、mcp-args-bridge.json、mcp-args-chat.json、mcp-args-click.json、mcp-args-daemon.json、mcp-args-daemon2.json、mcp-args-enter.json、mcp-args-inject.json、mcp-args-js.json、mcp-args-js2.json、mcp-args-js3.json、mcp-args-logs.json、mcp-args-logs2.json、mcp-args-map.json、mcp-args-mark.json、mcp-args-query.json、mcp-args-read.json、mcp-args-read2.json、mcp-args-send.json、mcp-args-state.json、mcp-args-sync.json、mcp-args-type.json、mcp-args-win.json、mcp-args.json、mcp-output.json、console-capture.json、render-setstate-diagnosis.json、topbar-inspect-report.json、.tmp-args.json、.tmp-shot.json、.tmp-type.json | **删** | MCP/调试一次性输入输出；`tmp_*` 已在 .gitignore:186 |

**类 3：演示 / 单页 HTML（未跟踪）→ 删除**

| 文件 | 裁决 | 备注 |
|------|------|------|
| chat_composer.html、icon - 副本.html、icon-splash.html、icon-static.html、icon.static.html、replicate_topbar_demo.html、smart_expandable_panel.html、revert_changes_modal_demo.html | **删** | 一次性设计演示；如需保留存档，移入 docs/archive/（已 ignore 跟踪规则） |

**类 4：规划 / 一次性 md、txt**

| 文件 | 裁决 | 备注 |
|------|------|------|
| new.md、suggestions.md、suggestions-v2.md、history.txt、compaction_summary_output.md、runtime_telemetry_report.md（未跟踪） | **删** | 一次性产物；.gitignore:116-125 已有规则 |
| 0613-0055-plan.md、0613-0553.md（已跟踪） | **移入 docs/archive/ 或 git rm** | 历史一次性规划；.gitignore:116 `0613-*.md` 阻止新增，存量需显式移除 |
| COMPREHENSIVE-REFACTOR-PLAN.md、FINAL-COMPREHENSIVE-REFACTOR-PLAN.md、FINAL-REFACTORING-ROADMAP.md、IMPROVEMENT-PLAN-MASTER.md、TOKEN-SYSTEM-REFACTOR-PLAN.md、TOKEN-SYSTEM-REFACTOR-PROMPT.md、CRISH_UI_SYSTEMIC_OVERHAUL_MASTER_PLAN.md、CRISH_UI_SYSTEMIC_OVERHAUL_PLAN.txt 等已跟踪规划 | **移入 docs/archive/** | 历史规划，保留于 archive（仓库可检索）而非根目录；执行前逐文件确认无当前引用 |

**类 5：目录类**

| 目录 | 现状 | 裁决 | 备注 |
|------|------|------|------|
| dist/ | 未跟踪，62 KB（仅 test-build.js） | **删** | 陈旧产物；vite 输出在 apps/crish-desktop/dist |
| target/ | 未跟踪，53.5 GB | **删 + 加 .cargo/config.toml 管控**（见 T10.10g）；后续 `cargo clean` 按需 | 唯一 Rust 构建目录 |
| .turbo/ | 未跟踪 | **ignore（不删）** | T10.8a 新增忽略，缓存继续使用 |
| temp_icons/、temp_jcode/、perf-report/、debug_investigation/、test-results/、scratch/ | 未跟踪 | **删** | 调试/临时目录（.gitignore:173-178 已有 ignore，删除磁盘目录） |
| mcps/、implementer/、.codex/、.codex-tool-scratch/、.firecrawl/、.agent-runtime/、.workbuddy/、.zcode/ | 未跟踪（已 ignore） | **保留（ignore 已生效）** | 工具缓存目录，无需处理 |
| NUL | 已 ignore（.gitignore:185） | **删除磁盘文件** | Windows 保留名，保持 ignore 规则 |

**类 6：已跟踪但可疑**

| 文件 | 裁决 | 备注 |
|------|------|------|
| apps/agent-workbench/sessions.db | **git rm --cached + ignore** | T10.9 专项 |
| restore_localstorage.js（根，已跟踪） | **git rm** | 调试脚本误入库；如需保留，移入 scripts/ 并评估是否合理 |
| scripts/ 下 batch-*.json ×6、tmp-args*.json、mcp-args.json、ui-selectors-manifest.json、parsed-events-summary.json、inspections-output.json、component-files-list.json、store-loop-audit-report.md、test-buttons-result.png 等（未跟踪，已 ignore） | **删除磁盘文件** | 已 ignore 防再入库，磁盘清理 |
| apps/crish-desktop/scripts/ 约 60 个 CDP/tauri 调试 mjs + png（目录已 ignore） | **删除磁盘目录** | 已 ignore；如需保留参考样例，单独评估 |
| apps/crish-desktop/ 根 tsc-*.log ×6、vitest-sessionTime.log（已 ignore） | **删除磁盘文件** | 日志清理 |

**执行方式**：本类任务用 PowerShell 批处理执行（先 `git ls-files` 复核每个"已跟踪"项的确认），删除前统一输出删除清单供 review。

---

### T10.9 sessions.db 从 git 跟踪移除

**现状**：`apps/agent-workbench/sessions.db`（700416 B）被跟踪且本次变更中（M）；该文件是运行时 SQLite 库（main.rs:145-148 将其打开在 `app_dir()/sessions.db`，工作区根的文件是开发期 CWD 残留）。

**执行步骤**：

1. `git rm --cached apps/agent-workbench/sessions.db`（保留磁盘文件，避免开发环境 DB 丢失；如需彻底删除再 `Remove-Item`）。
2. `.gitignore` 增加 `**/sessions.db`。
3. 确认 git status 不再显示该文件（`git status --porcelain` 无 sessions.db 条目）。
4. 同批处理：`git rm restore_localstorage.js`（T10.8 类 6）。

**风险**：无。运行时代码不依赖仓库内的该文件路径（app_dir 在用户数据目录），删除跟踪不影响运行。

---

### T10.10 配置残留与安全项

#### T10.10a CSP 残留清理（AA-08 #25）

`tauri.conf.json:29` connect-src 中删除 `http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765`（daemon 已删，端口不再被任何代码监听——`rg -n "8765"` 仅命中该配置）。保留 `'self' ipc: http://ipc.localhost`。

#### T10.10b updater 配置（AA-08 #23）

`tauri.conf.json:33-38`：pubkey 为空字符串、endpoint 指向 releases.crish.me，运行时更新检查必然失败。**裁决：active 改 false**，待发布服务就绪后再启用（启用时需配套生成密钥对并填 pubkey）。

#### T10.10c beforeBuildCommand / beforeDevCommand（AA-08 #22）

`tauri.conf.json:9-10` 当前 `npm run dev` / `npm run build` 依赖 npm 从 src-tauri 向上查找 package.json。改为显式：

```json
"beforeDevCommand": "npm --prefix .. run dev",
"beforeBuildCommand": "npm --prefix .. run build"
```

（`--prefix ..` 指向 apps/agent-workbench，其 dev/build 脚本已转发到 crish-desktop。）

#### T10.10d bundle.targets（AA-08 #24）

`tauri.conf.json:42` `"targets": "all"` 在 Windows 下含 MSI（需下载 WiX toolset，CI/离线易失败）。改为 `"targets": ["nsis"]`（或按平台限定 `["nsis"]` + `["app","dmg"]` 的 mac 分支，具体由发布需求决定，默认 nsis）。

#### T10.10e git 依赖 rev 锁定（AA-08 #13）

`apps/agent-workbench/src-tauri/Cargo.toml:24`：

```toml
tauri-plugin-mcp = { git = "https://github.com/P3GLEG/tauri-plugin-mcp", rev = "c7d271a06469bdf4744bfdeadca7458a1f3d02e5" }
```

- rev 取当前 Cargo.lock 中锁定的 commit（已确认存在），与 npm 侧 tauri-plugin-mcp 0.3.1 对齐为后续可选优化（若 crates.io 已有同功能发布版，评估替换以消除 git 依赖；无发布版则保持 git + rev）。
- **与 PE-07 批 5 会签（AU-04 C21）**：rev 锁定**先行**（无论后续是否移除插件，rev 锁定均必须且无害）；PE-07 T07.5 决策树唯一化后（默认目标 = 仓内最小实现 dev_mcp/），若插件被移除，本任务的 `dev-mcp` feature 化优化项**随之激活**（见下）。两书批 5 / 批次 B 同步执行并会签。
- **可选增强（不强制）**：插件仅 debug 使用（main.rs:126 `#[cfg(debug_assertions)]`），可将其改为 cargo feature `dev-mcp`（`[features] dev-mcp = ["dep:tauri-plugin-mcp"]`，代码侧 `#[cfg(feature = "dev-mcp")]`），release 构建用 `--no-default-features` 剔除该依赖链，同时消除 git 依赖进入 release 产物的风险。本方案将此项列为**后续优化项**，T10.11 不做硬性要求；**若 PE-07 T07.5 确认移除插件，此优化项由「移除依赖 + 仓内实现」直接取代**。

#### T10.10f engines 声明（AA-08 #28）

根 `package.json` 补 `"engines": { "node": ">=20" }`。

#### T10.10g target 管控（AA-08 #29）

新增 `.cargo/config.toml`（根目录，跟踪）：

```toml
[profile.release]
strip = true
lto = "thin"
codegen-units = 1
```

- `strip=true` 去除调试符号（体积收益明显）；`lto=thin` + `codegen-units=1` 为可选项，若增量构建时间不可接受可回退（用构建时长对比决定）。
- `cargo clean` 前先执行：`Remove-Item -Recurse -Force target` 释放 53.5 GB（保留后序按需重建）。
- CI 用独立缓存目录（`.cargo` 环境变量）避免与本机 target 混用——CI 侧改动属于 ci.yml 工作流调整，归入 T10.11 验证时一并处理。
- **不做**：不配置 sccache/增量远端缓存（超出本方案范围）。

#### T10.10h 传递多版本记录（AA-08 #15，低优先）

windows-sys ×5（0.45/0.52/0.59/0.60/0.61）、thiserror 1.x+2.x、toml ×3、getrandom ×3、base64 ×2 —— 全部为 tauri 生态传递依赖，**不处理**，仅确认 workspace 自身声明已对齐（windows-sys 0.61 与 tauri windows 0.61.3 一致）。在 Cargo.toml 加注释记录此决策，防止未来误"统一"引发 tauri 兼容问题。

---

### T10.11 构建验证流程

按以下顺序在**同一台干净检出**（或清理后本地）执行，作为 T10.1-T10.10 的最终验收：

```powershell
# 1. Cargo 全量
cargo build --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings

# 2. 锁文件一致性（模拟 CI --locked 行为）
cargo check --locked --workspace

# 3. 前端全量
npm install
npm run build            # turbo 全量（含 build:types/build:js 依赖链）
npm run typecheck:ci
npm run lint:all

# 4. 依赖图守卫
npx depcruise --config .dependency-cruiser.cjs packages apps   # T10.8b 后文件已跟踪，克隆可用

# 5. 体积复核
Get-ChildItem apps/crish-desktop/dist/assets | Sort-Object Length -Descending | Select-Object -First 10 Name, Length
# 期望：App-*.js < 1 MB（目标尽量拆低）；vendor-lucide 显著缩小；无 >500KB 未解释警告
```

**验收清单（DoD）**：

- [ ] `git ls-files | rg "Cargo.lock"` 命中（已跟踪）；`rg -n 'name = "reqwest"' Cargo.lock` 仅 1 处
- [ ] `.gitignore` 无 `Cargo.lock`、含 `.turbo/`、含 `**/sessions.db`、无重复 target-tauri-dev/`**/target/`
- [ ] `git status --porcelain` 无 sessions.db、无 `.turbo/`、无遗留杂物新增
- [ ] 根 Cargo.toml 无 derive_builder、tokio 无 full、含 regex/windows-sys workspace 声明
- [ ] `cargo tree -i regex -i once_cell -i futures` 单版本；`cargo tree -i tokio` 无 full
- [ ] crates/conex-net、crates/conex-stream 不在 workspace members（裁决删除）
- [ ] crish-desktop package.json 无 dompurify/@types/dompurify/idb-keyval/use-sync-external-store；根 package.json 无 @xterm/ws（dependencies）
- [ ] 根目录 6 类遗留文件按裁决全部处理（删除/归档/ignore）
- [ ] `tauri.conf.json`：CSP 无 8765、updater active=false、targets=["nsis"]、before*Command 带 --prefix
- [ ] `cargo test --workspace` + `npm run build` 全绿
- [ ] 构建体积：lucide chunk 显著下降（<300 KB），App chunk 拆分结果记录在案

---

## 三、风险

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| R1 | reqwest 0.13 feature 命名（rustls）在部分版本不识别，升级编译失败 | 中 | 先本地 `cargo check -p agent-provider` 验证；失败回退 `rustls-tls` 名；不改代码逻辑，风险面小 |
| R2 | reqwest 0.13 MSRV 1.75 高于 0.12 的 1.63，若有低版本 toolchain 环境不可构建 | 低 | 当前环境/CI 均为新 stable；在 README/engines 记录 MSRV 要求 |
| R3 | tokio 最小集后个别 crate 缺 feature 编译失败 | 低 | 编译错误明确指向缺失 feature；T10.3 已按实际使用面给出最小集（含 process/runtime 兜底方案） |
| R4 | lucide 改写为具名导入时出现"文件内存在运行时不固定 key 的动态索引"无法静态改写 | 中 | 已规划应对：该文件保留 namespace 或建立显式图标映射表；改写后必须 `npm run build` 验证无缺失图标 |
| R5 | React.lazy 拆分 xterm/设置页引入加载时序回归（首帧闪烁/异步失败） | 中 | 拆分仅针对低频模块；Suspense fallback 已存在；typecheck + 现有 snapshot/e2e（test:snapshots、test:e2e）兜底 |
| R6 | 删除根 package.json @xterm 后若某脚本仍依赖根解析导致运行时缺包 | 低 | 先 `rg` 确认引用方均在 crish-desktop；`npm run build` 全量验证 |
| R7 | packages/telemetry `"*"` 依赖当前解析到 npm registry 同名包（可能已安装外部 telemetry 包） | 中 | T10.6d 改 file: 后 `npm install` 刷新；核查 node_modules/@crish/telemetry 依赖树 |
| R8 | Cargo.lock 提交后与 CI 缓存/旧 lock 差异引发首次 CI 失败 | 低 | 本地 generate 后与现有 lock diff 预览（应为极小 diff）；CI `--locked` 从提交当刻起生效 |
| R9 | 大量文件删除（遗留清理）误删仍被引用文件 | 中 | 每类删除前 `rg` 复核引用（脚本/文档）；删除清单先输出 review；git 可回滚 |
| R10 | 53.5 GB target 删除后需要完整重编译（数十分钟级） | 低 | 安排在验证流程前一次性删除；顺序上先完成 T10.1-T10.10 再删 target + 全量验证 |
| R11 | tauri-plugin-mcp git 依赖在 release 构建中仍被编译（现为无条件依赖） | 低 | T10.10e 锁 rev 消除漂移；feature 化剥离列为后续优化项 |
| R12 | `cargo generate-lockfile` 与 tauri 模板生成的 lock 版本（v4 vs 旧 v3）差异 | 低 | 当前 lock 已是 version 4，与工具链一致，无迁移成本 |

---

## 四、执行顺序

按"低风险清理 → 中风险收敛 → 验证"分 3 个批次，每批完成后保持 `cargo build` / `npm run build` 可用（批次内可拆提交，每步可独立回滚）：

### 批次 A：纯清理（无行为变化，风险极低）

1. **T10.8a/10.8b**：.gitignore 结构修正（删 Cargo.lock 行、合并重复、加 `.turbo/`、加 `**/sessions.db`、.dependency-cruiser.cjs 与 .mcp.json 取消 ignore）
2. **T10.9**：`git rm --cached apps/agent-workbench/sessions.db` + `git rm restore_localstorage.js`
3. **T10.6e**：git rm pnpm 两文件 + app 级 package-lock.json；`npm install` 刷新根锁
4. **T10.6a/6b/6c**：npm 死包删除（dompurify 4 包 + ws 移位 + 根 @xterm 删除）+ vite.config.ts optimizeDeps 清理
5. **T10.6f**：vitest.config.ts / scripts 目录删除、test-utils clean 脚本修复
6. **T10.10a/10.10b/10.10c/10.10d**：tauri.conf.json 四处修正（CSP 8765、updater、--prefix、nsis）
7. **T10.10f**：engines 声明
8. **T10.8c 类 1/2/3/5/6**：根目录遗留文件批量删除（先输出清单）
9. 提交点：**提交 A**——仅清理，任何构建失败均与业务无关，直接修

### 批次 B：Cargo 侧收敛（需编译验证）

> 会签与依赖增量（AU-04 PE-10 修订指令 2/3）：
> - **Cargo.toml 依赖增量统一由本任务管理**——PE-04 `tracing-appender 0.2`、PE-09 `criterion 0.5`
>   只提需求，由本批次统一落声明（随 lock 文件一并收敛，避免多书并行改 Cargo.toml）。
> - 本批次（尤其项 15）与 **PE-07 批 5 会签**（C21：tauri-plugin-mcp rev 锁定先行）。

10. **T10.4a**：derive_builder 删除
11. **T10.4b**：regex/once_cell/windows-sys workspace 化 + session-loop futures→futures-util
12. **T10.3**：tokio 最小集 + workbench 内联删除
13. **T10.5**：孤儿 crate 移出 members（删除目录）
14. **T10.2**：reqwest 0.13 升级（transport/mod.rs 与 PE-09 T09.1.2 串行：本任务先行）
15. **T10.10e**：tauri-plugin-mcp 锁 rev（**与 PE-07 批 5 会签**，rev=c7d271a 先行；插件移除则 dev-mcp feature 化随之激活）
16. **T10.1**：`cargo generate-lockfile` + 提交 Cargo.lock
17. **T10.10g**：.cargo/config.toml（strip/lto）+ 删除 target 目录（53.5 GB）
18. 提交点：**提交 B**——Cargo 侧全部收敛，跑 `cargo test --workspace` 全量

### 批次 C：前端体积与收尾验证

> **与 PE-05 错开（AU-04 PE-10 修订指令 4）**：前端 package.json / vite.config.ts 与 PE-05 新增
> check 脚本**不并行**（本批次与 PE-05 相关批错开执行，避免同文件冲突）。

19. **T10.7a**：lucide namespace → 具名导入（先量化图标集合）
20. **T10.7b**：chunkSizeWarningLimit 恢复默认 + xterm/设置页 React.lazy
21. **T10.6d**：telemetry file: 化（孤儿裁决记录）
22. **T10.11**：全量验证（cargo test + clippy --locked + npm build + typecheck + depcruise）+ 体积复核
23. **T10.10h**：Cargo.toml 记录多版本决策注释
24. 提交点：**提交 C**——完成 DoD 验收清单

**依赖关系**：批次 A 必须先于 B（.gitignore/Cargo.lock 行删除是 T10.1 前提）；T10.2 与 T10.3 无相互依赖但建议先 T10.3（tokio 最小集先暴露 feature 缺口，避免与 reqwest 错误混淆）；T10.1 放批次 B 末尾（待 reqwest/tokio 收敛后一次性生成最终锁文件，避免锁文件两次大 diff）；T10.7 独立可并行于批次 B。**跨书串行**：批次 B 项 15 与 PE-07 批 5 会签（C21）；T10.2 与 PE-09 T09.1.2 串行（本任务先行）；批次 C 与 PE-05 新增 check 脚本错开（前端 package.json / vite.config.ts 不并行）。

---

## 五、附录

### 5.1 AA-08 问题清单 → 任务映射

| AA-08 # | 问题 | 任务 |
|---------|------|------|
| 1 | Cargo.lock 忽略且过期 | T10.1 |
| 2 | reqwest 双版本 | T10.2 |
| 3 | tokio full | T10.3 |
| 4 | derive_builder 零引用 | T10.4a |
| 5 | conex-net/conex-stream 孤儿 | T10.5 |
| 6/7/8 | dompurify / idb-keyval / use-sync-external-store | T10.6a |
| 9 | bundle 体积（App 1.06MB / lucide 553KB） | T10.7 |
| 10 | .turbo/ 未忽略 | T10.8a |
| 11 | sessions.db 被跟踪 | T10.9 |
| 12 | 内联重复声明（regex/once_cell/windows-sys） | T10.4b |
| 13 | tauri-plugin-mcp 无 rev | T10.10e |
| 14 | session-loop futures 完整 crate | T10.4b |
| 15 | 传递多版本 | T10.10h（记录） |
| 16 | ws 错位 | T10.6b |
| 17 | @xterm 根级重复 | T10.6c |
| 18 | telemetry 孤儿包 + `"*"` | T10.6d |
| 19 | test-utils clean 脚本 rimraf | T10.6f |
| 20 | pnpm 锁文件混用 | T10.6e |
| 21 | workbench vitest.config.ts 残留 | T10.6f |
| 22 | before*Command 脆弱性 | T10.10c |
| 23 | updater 空 pubkey | T10.10b |
| 24 | bundle.targets=all | T10.10d |
| 25 | CSP 8765 残留 | T10.10a |
| 26 | .gitignore 陈旧重复 | T10.8a |
| 27 | .dependency-cruiser.cjs/.mcp.json 被 ignore | T10.8b |
| 28 | 无 engines | T10.10f |
| 29 | target 53.5GB 无管控 | T10.10g |

### 5.2 关键命令速查

```powershell
# 锁文件一致性
cargo check --locked --workspace
# 双版本核查
rg -n 'name = "reqwest"' Cargo.lock
# full 残留核查
rg -n '"full"' Cargo.toml crates apps/agent-workbench/src-tauri/Cargo.toml
# lucide namespace 核查
rg -n "import \* as Lucide" apps/crish-desktop/src
# 孤儿引用核查
rg -n "conex-net|conex-stream" crates apps
# 体积复核
Get-ChildItem apps/crish-desktop/dist/assets | Sort-Object Length -Descending | Select-Object -First 10 Name, Length
```
