# REL · conex-relay

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 中继保持独立的盲转发。不把 hub 逻辑搬进来，也不依赖 `conex-hub-server`。
> 2. 禁止作弊：不加 `allow`、不调基线、不删断言。
> 3. 测试只在 REL-P3。提交：`refactor(REL-P<n>): <摘要> [BATCH-CONEX-RELAY]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-conex-relay`，分支 `refactor/conex-relay`。不在主仓库改代码。
> 5. 进度写同目录 `conex-relay.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\conex-relay`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `REL` |
| 波次 | W5。与 HS 无代码交叉（D3）。可以在 HS 之前做，只要本 crate 干净 |
| 不重做 | HS 的出壳；`device-protocol.json`；桌面多设备 UI |

依据：g3 REL-01..03。2026-10-29 对照 `crates/conex-relay/Cargo.toml` 与根 `Cargo.toml`。

## a. 范围与门控

```powershell
git -C C:\Software\conex status --porcelain -- crates/conex-relay
```

必须为空。

纳入：workspace 依赖与 lint、async 路径上的 `std::sync::Mutex`、`server.rs` 超长。

不纳入：改成独立 OS 服务的部署方式、与 `conex-hub-server` 合并、修改设备协议 JSON。源码目录里没有 `protocol.rs` 和 `session.rs`。不要把它们加回来。

## b. 问题清单

| # | 核实 | 证据 |
|---|---|---|
| REL-01 | **部分误报，剩余仍在** | 根 `Cargo.toml` 的 `members` 已包含 `crates/conex-relay`。不是「未加入 workspace」。crate 自己的 `Cargo.toml` 仍手写 `anyhow = "1"`、`axum = { version = "0.8" ...}`、`tokio = { version = "1" ...}` 等，没有 `[lints] workspace = true`。要收的是依赖与 lint，不是再加一次 members |
| REL-02 | P0 再确认持锁区间 | g3 指向 `hub.rs`、`account.rs`、`server.rs` 用 `std::sync::Mutex` 保护房间、预算、缓存。开工 `rg "std::sync::Mutex" crates/conex-relay/src`。若临界区内有 `.await`，必须改。若没有 await，仍改成 `tokio::sync::Mutex` 或 `RwLock`，避免下次在锁内 await。不要两套锁 |
| REL-03 | 仍在，行数开工重测 | `server.rs` 超过 600。拆成 router、websocket、ticket。不改转发语义 |

## c. 目标架构

1. `[lints] workspace = true`。依赖版本能对上 workspace 里已有条目的，改成 `workspace = true`。workspace 没有的条目保持字面量，不要为了「全部 workspace 化」在根 `Cargo.toml` 新增一套只给中继用的依赖，除非根上已经有同一 crate。改根 `Cargo.toml` 前该文件必须 `git status --porcelain` 为空；脏则只改本 crate 里已经存在的 workspace 键，不动根文件。
2. 房间表、预算、缓存各用一把异步锁。临界区里没有 `.await` 以外的阻塞 IO。发送在锁外，保持现在「发送不在锁内」的做法。
3. `server.rs` 只留启动与路由装配。票据校验、帧转发、连接循环分文件。行为不变：不存储业务、不解析业务 payload。

## d. 删除清单

- 手写的、与 workspace 重复的依赖版本（改成 workspace 键之后）
- 锁内的 `.await`（若 P0 找到）
- 不删除 members 条目，不删除盲转发本身

## e. 分阶段步骤

**REL-P0** 门控为空。列出 Mutex 与是否跨 await。列出哪些依赖在根 workspace 已有键。

**REL-P1 · lint 与依赖**

按 §c.1。

```powershell
rg -n "\[lints\]" crates/conex-relay/Cargo.toml
# 必须有 workspace = true
```

**REL-P2 · 锁与拆文件**

按 §c.2、§c.3。

```powershell
rg -n "\.lock\(\)[\s\S]{0,200}\.await" crates/conex-relay/src -U
# 无匹配。若 rg 不支持该写法，就人工核对 P0 清单里的每一处
```

**REL-P3 · 验证**

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\conex-relay"
cargo test -j 3 -p conex-relay
cargo clippy -j 3 -p conex-relay --all-targets -- -D warnings
```

## f. 禁止的捷径

- 不把中继并进 hub crate，不引用 `device-protocol.json`。
- 不从 workspace `members` 里删掉它来「独立发布」。
- 不在根 `package.json` 或根 `Cargo.toml` 脏的时候改它们。
- 不加 `allow` 来压拆文件后的 lint。
- 不改变「不落业务存储」这一条。

## g. 规范

clippy `-D warnings`，与 workspace lint 一致。`server.rs` 拆完 ≤ 600。函数 ≤ 150。

## h. 测试集中点

只有 REL-P3。票据与转发的现有测试不删。若没有「锁内不 await」的测试，P3 可以加一条不跨 await 的单测，不把旧测试标 ignore。

## i. 审计

`Cargo.toml` 使用 workspace lints。`cargo tree -p conex-relay` 不出现 `conex-hub-server`、`conex-push`、tauri。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| HS | 无共享文件。不要互相依赖 |
| BLD | 根 `Cargo.toml` 若由别的批次占用，REL-P1 不改根文件 |
| D3 | 中继保持云端盲转发 |

## k. 已决事项

| 项 | 结论 |
|---|---|
| workspace | 已是 member。补 lints 与能对上的依赖键。不退出 members |
| 锁 | 异步锁。发送保持在锁外 |
| 与 HS | 不合并、不共享协议文件 |
