# HS · 多端服务出壳

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. D3 已决：拆成 `conex-hub-server` 与 `conex-push` 两个 crate，仍在同一进程里运行。不做独立 OS 进程，不引入 sidecar，不新增第二层 IPC。
> 2. 新 crate 不依赖 tauri。`conex-push` 不依赖 `conex-hub-server`，只经 trait。不加 allow。不留 `pub use … as server` 这类旧路径。
> 3. 测试只在 HS-P6。测试只移动不删除。提交：`refactor(HS-P<n>): <摘要> [BATCH-HUB-SERVER-EXTRACT]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-hub-server`，分支 `refactor/hub-server`。不在主仓库改 src-tauri。
> 5. 进度写 `C:\Users\orange\conex-review\plans\多端服务出壳.progress.md`。HS-P0 的复核写 `plans\多端服务出壳.verify.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\hub-server`。src-tauri 包名 `crish-agent-workbench`。
> 7. 本区域正在大改。下面的目录和行数只说明方向。**HS-P0 必须在门控满足后按当时代码重列文件**。旧行号作废。

| 项 | 值 |
|---|---|
| 方案代号 | `HS` |
| 波次 | W5。顺序：W3（PL-P3～P5、SB-P6）→ HS → G4 其余（`tauri-shell.md`） |
| 已决 | **D3**：crate 化、进程内运行。中继 `conex-relay` 保持独立，本方案不改它，也不改 `device-protocol.json` |

依据：`plans\多端服务出壳.md`、ROADMAP §9.2 D3。g4 旧文把这组写成「B 组」是错的，这是 **A 组**。

## a. 范围

### a.1 编写时的现状（会过期）

| 编号 | 事实 |
|---|---|
| A1 | 多端服务住在壳里：`src/server/`（约 17.3k 行）、`src/push/`（约 12.5k 行）、`src/multi_device/`（约 1.1k 行）、`src/remote/`（约 0.5k 行），外加 `multi_device_service.rs`、`multi_device_commands.rs`、`multi_device_network.rs` |
| A2 | `lib.rs` 只有 `pub mod multi_device; pub mod push; pub mod server;`。`main.rs` 再用 `#[path]` 挂 `core_backend` |
| A3 | 推送厂商通道等整模块 `allow(dead_code)` |
| A5 | 同一职责的新旧文件并存 |
| A7 | 旧的分散启停，加上在写的 `MultiDeviceService` |

壳的 Cargo.toml 为它们引入 axum、rustls、tokio-rustls、rcgen、rustls-pemfile、tower。`server/` 里对壳的 `crate::` 引用（fs_commands、core_commands、core_query_commands、workspace、run_ipc、auth、host_paths、command_manifest）都应能收进 `ApiBackend`。

在写方向与本方案一致：`MultiDeviceService` 是唯一生命周期，持有 `ApiBackend`、与引擎共用的 `EventBridge`、与 push 共享的 ws 注册表。这些是进程内共享状态，所以不拆进程。

### a.2 可改

`apps/agent-workbench/src-tauri/` 的 Cargo.toml、lib.rs、main.rs、上表模块及其测试。新建 `crates/conex-hub-server/`、`crates/conex-push/`。根 Cargo.toml 的 workspace members。Cargo.lock 只因内部 path 依赖变化。

不改 `crates/conex-relay`。不改 `crates/conex-types/contracts/device-protocol.json`。不改 host_openers 的拒绝阈值（那是 `tauri-shell.md` 的 E 组；SB-P6 只统一入口，不改阈值）。

## b. 问题清单

- HS-1：约 31k 行网络和推送代码与 Tauri 壳同编译，无法脱离 Tauri 单测。
- HS-2：同一批模块被 lib 与 bin 各编一次，`#[path]` 隐藏结构。
- HS-3：未接线的厂商通道靠整模块 allow 活着。
- HS-4：新旧文件并存，两套生命周期。

## c. 目标架构

```
conex-hub-server    axum、路由、配对、TLS、ws 注册表、fanout、限流、鉴权中间件
                    定义 trait ApiBackend（以及 P0 核实后需要的少量端口，例如 HostPaths）
                    依赖 conex-types、conex-shared。不依赖 tauri
conex-push          推送决策（intent / 去重 / 合并 / 静默 / 节流）、pending、pusher、已接线的厂商通道
                    通过 trait PresenceSource 读在线状态
                    不依赖 tauri，也不依赖 conex-hub-server
src-tauri           MultiDeviceService：唯一的启停与装配点
                    hub_backend/：ApiBackend 的实现（原 core_backend，直接调用引擎 *_impl）
                    把 hub 的 ws 注册表适配成 PresenceSource 交给 conex-push
                    Tauri Emitter 与 tauri::command 入口留在壳里
```

不做独立进程的原因：backend 直接调用进程内引擎状态；EventBridge 与 ws 注册表是共享实例。拆进程要把引擎命令和事件流再暴露成第二层协议，还要处理状态同步、休眠唤醒重绑、sidecar 打包和签名。用户得不到新能力。crate 边界已经给出编译隔离、独立测试和依赖瘦身。将来真要拆进程，只换 `hub_backend` 这一层。

壳只留一个编译单元。P0 若确认 lib 目标没有外部消费者，删除 `src/lib.rs`。否则 `main.rs` 只调用 lib 的入口，不再用 `#[path]` 重复挂模块。

生命周期只留 `MultiDeviceService`。

## d. 删除清单

迁走之后，`src-tauri/src/{server,push,multi_device,remote}` 不复存在。`lib.rs` 的三个 `pub mod`（或整个 lib.rs）。`main.rs` 里 core_backend 的 `#[path]`。整模块 `allow(dead_code)`。P0 判定未接线的厂商通道（git 历史可恢复）。A5 的旧文件。A7 的旧启停。壳 Cargo.toml 里只为这些模块存在的依赖。

## e. 分阶段步骤

**HS-P0 · 复核，不改代码**
- 记录 `git -C C:\Software\conex log -5 --format="%h %ci %an %s" -- apps/agent-workbench/src-tauri`。
- 重列 a.1 各目录的文件与行数。
- 把 `server/`、`push/`、`multi_device/`、`remote/` 里的每个 `crate::` 引用分成「模块内部」和「壳依赖」。
- 列出每个推送厂商通道有没有生产调用方。没有的，列入删除清单。
- 确认 lib 目标的消费者：`rg -n "crish_agent_workbench::" apps crates`，以及 Cargo.toml 的 `[lib]`。
- 确认旧生命周期的符号名。
- 写 `多端服务出壳.verify.md`。若在写批次已经改成独立进程，或 `MultiDeviceService` 不再是唯一生命周期，停工。

**HS-P1 · 在壳内立接缝**
- `server/` 里除 core_backend 以外的壳依赖改走 `ApiBackend`（或 P0 确认的端口）。
- `push/` 改走 `PresenceSource`。
- 判据：§i 的 HS-1。

**HS-P2 · 抽出 conex-hub-server**
- 迁移 server（除 core_backend）、multi_device、remote 里属于服务侧的代码。
- core_backend 成为壳的 `hub_backend/`，真实模块路径，不用 `#[path]`。
- 判据：HS-2。

**HS-P3 · 抽出 conex-push**
- 迁移 push。未接线的厂商通道删除。不留 allow。
- 判据：HS-3。

**HS-P4 · 壳瘦身**
- 处理 lib/bin 双编译。删除 A5 旧文件和 A7 旧生命周期。清理壳的依赖。
- 判据：HS-4、HS-5。

**HS-P5 · 测试归位**
- `server/tests` 等随代码迁入新 crate。依赖引擎状态的集成测试留在壳里，改用 `hub_backend`。
- 判据：迁移前后 `#[test]` 与 `#[tokio::test]` 的总数相等。两次计数贴进 progress。

**HS-P6 · 验证**（§h）。

## f. 禁止事项

不做独立进程，不加 sidecar，不加新 IPC。新 crate 不依赖 tauri。`conex-push` 不依赖 `conex-hub-server`。不加 allow / expect。不留旧路径 re-export。

移动即拆分：超出行数上限的文件按职责拆开。对新 crate 只用全局上限，不登记豁免基线。

不碰 conex-relay。不改 `device-protocol.json` 的线上格式。

## g. 项目规范

crate 名用 `conex-*`。每个 crate 顶部用中文写职责。clippy `-D warnings`。`cargo deny` 不新增外部依赖，只是把依赖从壳挪到新 crate。crate-size：lib ≤800，mod ≤600。

## h. 集中测试

```powershell
$env:RUSTUP_TOOLCHAIN="1.99.1"
$env:CARGO_TARGET_DIR="C:\Users\orange\conex-tgt\hub-server"
cargo fmt --all -- --check
cargo clippy -j 3 -p conex-hub-server -p conex-push -p crish-agent-workbench --all-targets -- -D warnings
cargo test -j 3 -p conex-hub-server -p conex-push -p crish-agent-workbench
cargo tree -p conex-hub-server -e normal | rg -n "tauri"
# 期望：0
cargo tree -p conex-push -e normal | rg -n "tauri|conex-hub-server"
# 期望：0
node scripts/check-crate-size.mjs
npm run check:line-counts
npm run test:e2e:smoke
```

开跑前剩余磁盘 ≥ 25 GB，且没有其他 cargo。回归点：R1 手机扫码配对；R2 配对后会话事件推到手机；R3 TLS 证书首次生成与重启复用；R4 休眠唤醒后服务恢复；R5 推送去重、静默、节流的既有用例通过；R6 退出时端口释放。

## i. 审计清单

`$B = refactor/hub-server`。目录名若在 P0 之后有变化，以 verify.md 为准。

```powershell
git -C C:\Software\conex grep -nE "crate::(fs_commands|core_commands|core_query_commands|workspace|run_ipc|auth|host_paths|command_manifest)::" $B -- apps/agent-workbench/src-tauri/src/server ":!apps/agent-workbench/src-tauri/src/server/core_backend"
# HS-1：0。P2 之后 server 目录本身也不应存在，这条在 P1 结束时用
git -C C:\Software\conex cat-file -e "${B}:crates/conex-hub-server/Cargo.toml"
git -C C:\Software\conex ls-tree -d $B apps/agent-workbench/src-tauri/src/server
# 无输出
git -C C:\Software\conex grep -n "tauri" $B -- crates/conex-hub-server/Cargo.toml crates/conex-push/Cargo.toml
# 0
git -C C:\Software\conex cat-file -e "${B}:crates/conex-push/Cargo.toml"
git -C C:\Software\conex ls-tree -d $B apps/agent-workbench/src-tauri/src/push
# 无输出
git -C C:\Software\conex grep -nE "allow\(dead_code\)" $B -- crates/conex-hub-server crates/conex-push
# 0
git -C C:\Software\conex grep -nE "^pub mod (multi_device|push|server);" $B -- apps/agent-workbench/src-tauri/src
# 0
git -C C:\Software\conex grep -nE "#\[path.*core_backend" $B -- apps/agent-workbench/src-tauri/src
# 0
git -C C:\Software\conex grep -nE "struct MultiDeviceService\b" $B -- apps crates
# 1
```

- [ ] A1 探针达到预期
- [ ] A2 作弊清单无未授权项
- [ ] A3 测试文件在 `git diff -M --name-status` 里是 R，不是 D。用例计数相等
- [ ] A4 两个新 crate 的依赖方向符合 c
- [ ] A5 `device-protocol.json` 与 `conex-relay` 无改动
- [ ] A6 R1–R6 有用例与输出

## j. 门控

**G-HS**（全部满足才开始，包括 HS-P0）：

```powershell
git -C C:\Software\conex status --porcelain -- apps/agent-workbench/src-tauri
# 为空
git -C C:\Software\conex log --since="72 hours ago" --format="%h %ci %an %s" -- apps/agent-workbench/src-tauri
# 没有他人提交。只有本路线图的 refactor(...) 可以出现
git -C C:\Software\conex status --porcelain -- "docs/multi-agent-repair"
# 为空。新 crate 若需要登记 crate-size，只能用全局上限，且该基线文件不得处于在写
```

并且 W3 的 PL-P3～P5 与 SB-P6 已合入集成分支。HS 基于那个集成结果开分支。

编写时 src-tauri 有一百多项未提交，**门控未满足**。不要提前在脏工作区里搬文件。

之后：`tauri-shell.md` 基于 HS 的集成结果。EC-P5、TM-P4、MP-P4 在壳里的剩余部分也排在 HS 之后。MP-P4 不再处理已经被本方案删掉的 core_backend `#[path]`。

cargo 与其他 Rust 模块串行。

## k. 已决事项

D3 = 两个 crate、同一进程。不拆 OS 进程。不改 relay，不改设备协议 JSON。未接线厂商通道在 P0 用 rg 证明无生产调用方之后删除。没有剩余的「待用户决策」。方向若被在写批次改掉，P0 停工，不自行另选架构。
