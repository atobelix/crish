# AP · agent-provider 残余

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. 先等在写文件落盘，再删迁移层和厂商双真源。不留「读时兼容、写时新结构」的长期双轨。
> 2. 禁止作弊：不加 `allow`、不把 `test-util` 留在生产依赖里、不用 `#[path]` 拆上帝文件（目录化归 MP）。
> 3. 测试只在 AP-P5。提交：`refactor(AP-P<n>): <摘要> [BATCH-AGENT-PROVIDER]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-agent-provider`，分支 `refactor/agent-provider`。不在主仓库改代码。
> 5. 进度写同目录 `agent-provider.progress.md`。
> 6. Rust 1.99.1，clippy `-D warnings`。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\agent-provider`，`-j 3`。磁盘余量须 ≥ 25 GB。
> 7. 行号会过期。开工前用 `rg` 重定位。

| 项 | 值 |
|---|---|
| 方案代号 | `AP` |
| 波次 | W5，整 crate 门控。PL 还在改 `events` 与 `consume` 的删除。`model_store`、`config_validation`、`parse/tool_call.rs`、`messages_content` 编写时在写 |
| 不重做 | PL 的流事件、`consume/` 删除、`ReasoningEffort`；MP 的 `#[path]`；EC 的码生成；CP 的压缩引擎签名 |

依据：g1 AP-02/03/06/07/08。AP-01、AP-04、AP-05 分别归 PL 与 MP。2026-10-29 对照 `crates/agent-provider`。

## a. 范围与门控

**G-AP**（任何阶段改代码之前）：

```powershell
git -C C:\Software\conex status --porcelain -- crates/agent-provider
```

输出必须为空。非空则只允许重读，不允许改。PL 合入后再跑一次。P0 把当时仍存在的问题重新列表，已经被 PL/MP/EC 删掉的条目标成跳过，不要重做。

纳入：配置与凭据的边界、多套迁移、`CompatSpec` 与硬编码网关表、四套协议帧里重复的累积逻辑、`Result<_, String>` 与 `classify_provider_error`。

不纳入：
- `src/consume/`（PL 删除；生产聚合在 session-loop）
- `ReasoningEffort` / `ThinkingIntensity`（PL-P4，默认 Medium，D5）
- 生产 `#[path]`（MP）
- 把本 crate 拆成三个发布 crate 这件事如果会造成 `provider-wire` 再导出旧路径：禁止留再导出。见 §c，拆分是移动模块，不是加门面

## b. 问题清单（已对照当前代码）

| # | 核实 | 证据 |
|---|---|---|
| AP-01 | 归 PL | `src/consume/` 编写时仍可能在。不要在本方案删除或改测试指向，除非 P0 发现 PL 没删且 PL 已声明放弃。默认跳过 |
| AP-02 | 仍在，整 crate 在写 | 顶层同时有 config、credentials、migration、model_store、pricing、request、parse、sse、transport、retry。`Cargo.toml` 生产依赖 `tokio` 带 `features = ["test-util"]`，注释写「重试器测试用」。`serde_yaml = "0.9"`。依赖 conex-compaction 是为了线格式阶段调用 `clean_output` |
| AP-03 | 仍在 | 三套迁移：`migration.rs` 的 `ConfigMigrationManager`、`models/config_legacy.rs`、`model_store_import.rs` 的 `migrate_legacy_value`。`request/compat.rs` 的 `is_legacy_max_tokens_gateway` 用厂商名和 URL 子串判断，与 `models/catalog_types.rs` 的 `CompatSpec` 并列。同函数上方的 doc 注释写了两遍（约第 78 行与第 89 行）。`parse/tool_call.rs` 的嵌套 arguments 分支编写时在写，P0 再确认 |
| AP-04 | 归 PL | 不改 `ReasoningEffort` |
| AP-05 | 归 MP | 不新增、不保留 `#[path]`。MP 拆目录之后，本方案在新路径上改逻辑 |
| AP-06 | 仍在，P0 重测行数 | `parse` 下 anthropic/gemini/responses/chat 各自一份 `push_frame`。请求构建与消息转换同样按协议复制。g1 记录这些函数在 130–190 行 |
| AP-07 | **降级，不合并类型** | `request/tools.rs` 的 `ToolDefinition` 只有 name、description、input_schema。`agent-tools` 的同名结构多一个 `dangerous`，还带 serde camelCase。协议层不该依赖工具执行 crate（方向反了）。两份 5 行的 `default_input_schema` 可以留在各自 crate。不要为这个 JSON 形状新建共享 crate，也不要让 provider 依赖 agent-tools |
| AP-08 | 仍在 | `error.rs` 的 `classify_provider_error` 用状态码和字符串分类，函数很长。生产路径仍有 `Result<_, String>` |

## c. 目标架构

1. 磁盘上的模型配置只有一个当前 schema。打开文件时若发现旧形状，**一次**升级并写回，然后旧结构体从代码里删除。不保留读旧形状的第二套类型。升级函数只有 `ConfigMigrationManager` 这一处；`config_legacy` 与 `migrate_legacy_value` 的逻辑并入它，文件删除。
2. 厂商差异只表达在 `CompatSpec`。遗留 max_tokens 行为变成 CompatSpec 上的一个布尔字段（若已有同义字段就复用，不要新增近义字段）。`is_legacy_max_tokens_gateway` 删除。目录数据里为今天硬编码名单上的厂商写上这个字段。运行时不再扫描 URL 子串。
3. 代理把同一片段镜像到两个字段的怪癖，放进对应协议的方言解析，不放在通用 tool_call 收集器。P0 若发现该分支已被在写批次删除，跳过。
4. 帧累积只有一份。新建 `parse` 里的一个模块（名字用 `accum`，若 MP 已有等价模块就用那个），负责工具调用缓冲、usage、stop。四个协议文件只把本协议 JSON 译成这个模块已经接受的输入，不再各自维护一份缓冲。不要做 `ProtocolDialect` trait object，也不要四套仍各自累积的「小 trait」。
5. crate 边界：凭据、迁移、model_store、目录放进 `crates/provider-config`。`agent-provider` 依赖它。它不依赖 `agent-provider`，不依赖 conex-compaction。`clean_output` 从请求构建路径移走：在 session-loop 组装给模型的消息时调用一次。请求构建函数不再调用它。若这次移动会改 PL 尚未合入的流文件，就停在门控上。
6. `tokio` 的 `test-util` 只出现在 `[dev-dependencies]`。生产代码不准调用 `tokio::time::pause`。
7. YAML 仍是磁盘格式（现有文件就是 YAML）。解析库只留一个。`serde_yaml` 0.9 若替换为维护中的后继，必须是全 crate 机械替换且 `from_yaml_str` 的现有测试仍读得出现有夹具。替换失败就保持 0.9，在进度文件记「库未替换及编译错误」，不要同时依赖两个 YAML 库。
8. `classify_provider_error` 返回类型化的 provider 错误，对外码来自中心表。不要把分类函数继续返回自由字符串再在调用点解析回来。

## d. 删除清单

- `models/config_legacy.rs` 与 `migrate_legacy_value`（逻辑并入唯一迁移入口之后）
- `is_legacy_max_tokens_gateway` 及重复的那一段 doc 注释
- 生产 `Cargo.toml` 里 tokio 的 `test-util`
- 通用收集器里的嵌套 arguments 特例（移到方言或确认已删）
- 请求构建里对 `clean_output` 的调用（改到组装点之后）
- 四个 `push_frame` 里重复的 usage/stop/工具调用缓冲（留下一份）

不删除：两份 `ToolDefinition`。不删除 `consume/`（归 PL，除非 P0 确认 PL 放弃且目录仍在——若放弃，按 PL 方案删除，不在这里重写一套）。

## e. 分阶段步骤

**AP-P0 · 只读复核**

跑 G-AP。读 PL 进度，列出 `consume/`、`ReasoningEffort`、`#[path]` 是否还在。还在且属 PL/MP 的，本方案跳过。把结果写进进度文件。门控非空则到此为止。

**AP-P1 · 依赖面**（G-AP 为空）

1. 把 `test-util` 移到 dev-dependencies。生产源码 `rg "tokio::time::pause|tokio::time::advance"` 必须为 0；测试里可以留。
2. 按 §c.7 决定是否替换 YAML 库。两个库不准同时出现在 `Cargo.toml`。

**AP-P2 · 一次迁移**（G-AP 为空；`migration.rs`、`config_legacy.rs`、`model_store_import.rs` 干净）

1. 把旧形状的升级收进 `ConfigMigrationManager` 的一个函数：读入、升级、写出当前 schema。
2. 删除旧结构体与另外两个入口。调用方只留一个。
3. 已是当前 schema 的文件，升级函数必须是空操作（不改写内容、不改 mtime 的语义若现有测试依赖，就保持「内容相等则不写」）。不要为了「每次打开都重写」而制造 git 噪声。这一条是在避免无意义写盘，不是保留旧格式。

**AP-P3 · CompatSpec 单一厂商差异**（`request/compat.rs`、目录类型、`parse/tool_call.rs` 干净）

1. 用 CompatSpec 字段替换 `is_legacy_max_tokens_gateway`。删函数。删重复 doc。
2. 嵌套 arguments：找到唯一需要它的协议，把分支移进去。通用路径不保留该分支，也不留「先通用、再方言补一遍」。
3. 删掉 `compat.rs` 里没有实际作用的 `allow(clippy::string_lit_as_bytes)`。用改代码的方式满足 lint，不要换一条 allow。

**AP-P4 · 一份帧累积**（parse 目录干净，且 MP 若要拆这些文件则排在 MP 之后）

按 §c.4 收拢。四个协议的对外解析结果类型保持现有生产调用方能编译的那些类型；若必须改名，全仓一次改完，不留旧名再导出。

**AP-P5 · 错误类型与验证**

1. `classify_provider_error` 返回类型化错误。本阶段碰到的 `Result<_, String>` 改成该错误。不要为了扫完 17 处而去改 G-AP 之外的脏文件；脏文件记入进度，等干净再补一笔 `fixup`。
2. 验证：

```powershell
$env:CARGO_TARGET_DIR = "C:\Users\orange\conex-tgt\agent-provider"
cargo test -j 3 -p agent-provider
cargo clippy -j 3 -p agent-provider --all-targets -- -D warnings
```

完成判据：

```powershell
rg -n "is_legacy_max_tokens_gateway|migrate_legacy_value|mod config_legacy" crates/agent-provider
# 无匹配
rg -n "test-util" crates/agent-provider/Cargo.toml
# 只出现在 dev-dependencies
rg -n "clean_output" crates/agent-provider/src
# 无匹配
```

## f. 禁止的捷径

- 不在迁移后保留旧结构体「只读不写」。
- 不同时依赖 `serde_yaml` 和后继库。
- 不把 URL 子串判断移到另一个函数里换个名字。
- 不引入 `ProtocolDialect` trait object 来包装四份仍重复的累积。
- 不合并两份 `ToolDefinition`，不让 provider 依赖 agent-tools。
- 不改 `consume/`、不改 `ReasoningEffort`、不加 `#[path]`。
- 不手改 EC 的生成文件。
- 门控非空时不「只改看起来干净的几行」。P0 可以读，不能写。

## g. 规范

clippy `-D warnings`。拆出的 `provider-config` 同样受 lib ≤ 800、mod ≤ 600、函数 ≤ 150 约束。`provider-config` 不得依赖 tauri、conex-db、agent-tools、conex-compaction。

## h. 测试集中点

AP-P1 到 AP-P4 不跑 cargo test。AP-P5 跑本 crate。迁移夹具测试必须还在，并且断言旧夹具升级后等于当前 schema 的期望文档，而不是断言「能读就行」。

## i. 审计

核对 §e 的 rg、`Cargo.toml` 只有一个 YAML 库、`clean_output` 不在 provider 源码、CompatSpec 是唯一的遗留 max_tokens 开关。

## j. 冲突与门控

| 对方 | 关系 |
|---|---|
| PL | 占用 events、consume 删除、ReasoningEffort、以及 session-loop 的流聚合。AP 等 PL 合入且 G-AP 为空 |
| MP | `#[path]` 归 MP。AP-P4 在 MP 拆完 parse 之后，避免两边同时搬文件 |
| CP | `clean_output` 的函数本体归压缩 crate。AP 只停止在请求构建里调用它。调用点改到 session-loop 时，该文件须干净且不在 PL 的占用列表里 |
| EC | 分类结果使用中心码。不新建 provider 专用码表文件 |
| RN | provider 的上游适配在 conex-run 的 engine_provider。改公共解析类型时，若必须改 conex-run，先满足 `git status --porcelain -- crates/conex-run` 为空，且只改适配调用，不重做 RN 的状态机拆分 |

## k. 已决事项

| 项 | 结论 |
|---|---|
| 迁移 | 只留一个升级入口。旧结构体删除。已是当前 schema 的文件内容不变则不重写 |
| 厂商差异 | 只留 CompatSpec。删除网关函数 |
| 帧累积 | 一份累积模块，四个协议只做字段翻译。不做 trait object |
| ToolDefinition | 两份都留。不抽公共类型 |
| YAML | 磁盘格式不变。解析库最多一个 |
| test-util | 只在 dev-dependencies |
| consume / ReasoningEffort / #[path] | 不在本方案 |
