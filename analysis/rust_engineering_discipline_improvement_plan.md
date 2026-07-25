# Rust 工程纪律改进方案

## 1. 设计原则

### 1.1 根本原则

本方案的制定遵循以下设计原则：

1. **可加性**：所有改进必须能够分阶段增量实施，不影响现有代码的正常运行。
2. **自动化优先**：凡是可以通过工具自动检测的纪律，不应依赖人工审查。
3. **就近配置**：规则配置应尽可能靠近代码，优先使用 `[lints]` 和 Cargo workspace 机制实现集中管理。
4. **渐进严格**：新规则从 `warn` 开始，经过一个验证期后升级为 `deny`。
5. **例外透明**：任何对全局规则的豁免必须有显式的 `#[allow]` + 注释说明理由。

### 1.2 逻辑依赖顺序

```
Phase 0 (基础设施)
  └── 创建工程配置目录和文件

Phase 1 (编译器/lint 配置)
  ├── 统一 workspace lints
  ├── 创建 clippy.toml
  └── 统一 edition/version 配置

Phase 2 (自动化检查)
  ├── 集成 cargo-deny (依赖审计)
  ├── 集成 rustfmt CI 检查
  └── 配置 CI lint 流水线

Phase 3 (代码改造)
  ├── 逐步替换 unwrap/expect 为 Result
  ├── 为 unsafe 添加 SAFETY 注释
  ├── 修复 String 错误类型
  └── 替换 eprintln! 为 tracing

Phase 4 (测试与文档)
  ├── 添加缺失 crate 的测试
  ├── 建立测试覆盖率门槛
  ├── 补全 rustdoc 文档
  └── 创建集成测试

Phase 5 (高级工具化)
  ├── 自定义 argument-comment-lint
  └── 创建本地 CI 检查脚本
```

---

## 2. 各维度改进任务

### 2.1 编译器配置标准化

#### 任务 ID: CFG-001

| 属性 | 值 |
|------|-----|
| **目标文件** | `Cargo.toml`（根 workspace）、
`crates/conex-stream/Cargo.toml`、
`crates/conex-sandbox/Cargo.toml`、
`crates/conex-net/Cargo.toml` |
| **当前问题** | 3 个 crate 硬编码 `edition = "2024"` 而非继承 workspace；3 个 crate 硬编码 `version = "0.1.0"` 而非使用 `version.workspace = true` |
| **改进策略** | 修改上述 3 个 crate 的 edition 和 version 配置为 workspace 继承，确保所有 crate 统一通过 `Cargo.toml` 中的 `[workspace.package]` 管理版本号和 edition |
| **前置依赖** | 无 |
| **并行性** | 可独立执行 |
| **验证标准** | `cargo metadata --format-version=1 | jq '.packages[] | {name, edition, version}'` 确认所有 crate edition = "2024" 且 version = "0.1.0" |

#### 任务 ID: CFG-002

| 属性 | 值 |
|------|-----|
| **目标文件** | `Cargo.toml`（根 workspace） |
| **当前问题** | workspace 无 `[workspace.lints]` 配置，每个 crate 无 `[lints]` 继承 |
| **改进策略** | 在 `Cargo.toml` 中添加 `[workspace.lints]` 和 `[workspace.lints.clippy]` 段，定义全项目统一的 lint 策略。然后在每个 crate 的 `Cargo.toml` 中添加 `[lints] workspace = true` 继承该配置 |
| **前置依赖** | 无 |
| **并行性** | 可独立执行，但建议在 CFG-001 之后 |
| **验证标准** | `cargo clippy --all-targets` 无错误（warn 级别的 lint 允许产生警告） |

#### 任务 ID: CFG-003

| 属性 | 值 |
|------|-----|
| **目标文件** | `Cargo.toml`（根 workspace） |
| **当前问题** | 缺少 `[profile.*]` 配置段，全部使用 cargo 默认值 |
| **改进策略** | 添加以下 profile 配置：
- `[profile.dev]`：`debug = "limited"` 减少本地构建体积
- `[profile.release]`：`lto = "thin"`，`codegen-units = 1`，`strip = "symbols"`
- `[profile.dev-small]`：继承 dev，`debug = "none"`，`strip = "symbols"`（快速 CI）
- `[profile.profiling]`：继承 release，`debug = "full"`，`lto = false` |
| **前置依赖** | 无 |
| **并行性** | 可独立执行 |
| **验证标准** | `cargo build --profile profiling` 成功，产物包含完整 debug 符号 |

### 2.2 Clippy 规则配置

#### 任务 ID: LINT-001

| 属性 | 值 |
|------|-----|
| **目标文件** | `Cargo.toml`（根 workspace）— `[workspace.lints.clippy]` 段 |
| **当前问题** | 无任何 clippy lint 级别配置 |
| **改进策略** | 配置三级 lint 策略。以下为具体规则列表。先设为 `warn`，经过 2 周验证期后逐步升级为 `deny` |

##### Phase 1 — 立即设为 `deny`（安全关键）

这些 lint 检测可能导致运行时 panic、UB 或严重性能问题的模式，应立即拒绝：

| lint 名称 | 原因 | 影响的代码位置 |
|-----------|------|---------------|
| `unwrap_used` | 防止 panic | `conex-stream/src/parser/openai_chat.rs:111` 等 |
| `expect_used` | 防止 panic | `conex-net/src/llm_provider.rs:45,55,58` 等 |
| `await_holding_lock` | 防止死锁 | `conex-ipc/src/router.rs` 中的 async RwLock |
| `await_holding_invalid_type` | 防止在非异步锁上 await | `conex-ipc/src/router.rs` |

##### Phase 1 — 立即设为 `deny`（正确性关键）

| lint 名称 | 原因 |
|-----------|------|
| `identity_op` | 防止无意义运算符 |
| `manual_clamp` | 语义化 clamp |
| `manual_filter` | 简化 filter + next 模式 |
| `manual_find` | 简化显式循环查找 |
| `manual_flatten` | 简化嵌套 Option/Result 展开 |
| `manual_map` | 简化 if-let 映射 |
| `manual_ok_or` | 简化 Ok/Err 转换 |
| `manual_retain` | 简化条件保留 |
| `manual_strip` | 简化 strip 前缀/后缀 |
| `manual_unwrap_or` | 简化 unwrap_or 模式 |
| `needless_borrow` | 消除无效借用 |
| `needless_borrowed_reference` | 消除无效引用 |
| `needless_collect` | 消除中间集合 |
| `needless_late_init` | 简化延迟初始化 |
| `redundant_clone` | 消除不必要的克隆 |
| `redundant_closure` | 简化闭包 |
| `trivially_copy_pass_by_ref` | 小类型传引用低效 |
| `unnecessary_to_owned` | 消除不必要的 to_owned 调用 |

##### Phase 1 — 立即设为 `deny`（可维护性关键）

| lint 名称 | 原因 |
|-----------|------|
| `uninlined_format_args` | format! 参数内联，提升可读性 |
| `unnecessary_filter_map` | 简化 filter+map 组合 |
| `unnecessary_lazy_evaluations` | 简化惰性求值 |
| `unnecessary_sort_by` | 简化排序 |
| `needless_option_as_deref` | 简化 Option 解引用 |
| `needless_question_mark` | 消除不必要的 ? 运算符 |
| `needless_update` | 简化结构体更新 |

##### Phase 2 — 设为 `warn`（到期后评估是否升级为 deny）

| lint 名称 | 原因 |
|-----------|------|
| `print_stdout` | 生产代码应使用 tracing，而非 println! |
| `print_stderr` | 同 print_stdout，当前 `sse.rs:66` 使用 eprintln! |
| `wildcard_imports` | 避免命名空间污染 |
| `enum_glob_use` | 同 wildcard_imports |
| `module_name_repetitions` | 类型名不应重复模块名 |
| `redundant_closure_for_method_calls` | 简化方法引用 |

##### deny 到 warn 的过渡策略

1. 第 1-2 周：所有 Phase 1 lint 设为 `warn`，配合 CI 日志采集警告频率
2. 第 3 周：评审警告列表，评估工作量
3. 第 4 周：Phase 1 lint 升级为 `deny`
4. 第 5-8 周：Phase 2 lint 保持 `warn`
5. 第 9 周：评估 Phase 2 是否升级

| **前置依赖** | CFG-002（workspace lints 基础配置） |
| **并行性** | 与其他 LINT-* 任务可并行 |
| **验证标准** | `cargo clippy --all-targets -- -D clippy::unwrap_used -D clippy::expect_used` 等返回零错误 |

#### 任务 ID: LINT-002

| 属性 | 值 |
|------|-----|
| **目标文件** | `clippy.toml`（根目录新建） |
| **当前问题** | 不存在 clippy.toml |
| **改进策略** | 创建 `clippy.toml`，配置以下规则： |

```toml
# 允许测试代码中使用 unwrap 和 expect（不影响生产代码检查）
allow-expect-in-tests = true
allow-unwrap-in-tests = true

# 检测 await 期间持有非 async 锁的类型
await-holding-invalid-types = [
    "tokio::sync::MutexGuard",
    "tokio::sync::RwLockReadGuard",
    "tokio::sync::RwLockWriteGuard",
]

# 禁止的方法（按需添加）
disallowed-methods = [
    { path = "std::mem::uninitialized", reason = "Use MaybeUninit instead" },
]

# 错误类型大小阈值（防止 Result 类型大于 256 字节）
large-error-threshold = 256
```

| **前置依赖** | 无 |
| **并行性** | 可独立执行 |
| **验证标准** | `cargo clippy` 输出中包含自定义配置的效果（如测试中允许 unwrap） |

#### 任务 ID: LINT-003

| 属性 | 值 |
|------|-----|
| **目标文件** | `rustfmt.toml`（根目录） |
| **当前问题** | 仅有 3 项配置，缺少 imports_granularity |
| **改进策略** | 添加 `imports_granularity = "Item"` 配置。该配置将导入语句拆分为每个项目一行，减少合并冲突，提高可读性 |
| **前置依赖** | 无 |
| **并行性** | 可独立执行 |
| **验证标准** | `cargo fmt -- --check` 输出格式差异（初次执行后需要运行 `cargo fmt` 格式所有文件） |

### 2.3 依赖审计

#### 任务 ID: DEP-001

| 属性 | 值 |
|------|-----|
| **目标文件** | `deny.toml`（根目录新建） |
| **当前问题** | 无任何依赖审计配置 |
| **改进策略** | 创建 `deny.toml`，包含三个核心检查： |

##### 许可证明细

```
[licenses]
allow = [
    "Apache-2.0",
    "MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "CC0-1.0",
    "Unicode-3.0",
    "Unlicense",
    "MPL-2.0",
]
confidence-threshold = 0.8
```

配置说明：根据当前 workspace 依赖的开源许可证分布，Apache-2.0 和 MIT 是最主要的许可证（serde、tokio、anyhow、thiserror 等核心库），BSD 和 ISC 是常见宽松许可证，CC0 和 Unlicense 适用于公共领域代码（如 `ignore`、`walkdir`），MPL-2.0 适用于 `nucleo-matcher` 等。

##### Advisory 审计

```
[advisories]
ignore = []
```

初始为空列表，随着 CI 运行逐步添加已验证忽略的 advisory。每个忽略必须附带 `reason` 说明：

```toml
# 示例（实际内容根据 CI 首次运行结果填充）：
# [[advisories.ignore]]
# id = "RUSTSEC-2024-XXXX"
# reason = "dependency path; mitigation description; removal condition"
```

##### 版本冲突检测

```
[bans]
multiple-versions = "warn"
wildcards = "allow"
skip = []
skip-tree = []
```

##### 源控制

```
[sources]
unknown-registry = "deny"
unknown-git = "deny"
required-git-spec = "rev"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
allow-git = []
```

| **前置依赖** | 无（可立即创建配置，CI 集成可在 CI 任务中完成） |
| **并行性** | 可独立执行 |
| **验证标准** | `cargo deny check` 成功运行并报告检测结果 |

#### 任务 ID: DEP-002

| 属性 | 值 |
|------|-----|
| **目标文件** | 所有 crate 的 `Cargo.toml` |
| **当前问题** | 部分 crate 未使用 workspace 依赖（硬编码 `serde`、`regex-lite`、`windows-sys` 等版本） |
| **改进策略** | 将所有 crate 中独立声明的依赖迁移到 `[workspace.dependencies]`，各 crate 通过 `serde.workspace = true` 引用。特别关注： |
| | - `conex-stream`: `regex-lite = "0.1"` → 加入 workspace 依赖 |
| | - `conex-net`: `serde = { version = "1", features = ["derive"] }` → `serde.workspace = true` |
| | - `conex-sandbox`: `serde = { version = "1", features = ["derive"] }` → 同上 |
| | - `conex-search`: `rayon = "1.7"`、`memmap2 = "0.7"`、`arc-swap = "1.6"` → 加入 workspace 依赖 |
| | - `conex-compaction`: `tiktoken-rs = "0.5"`、`lazy_static = "1.4"` 等 → 加入 workspace |
| | - `conex-diff`: `rayon = "1.7"` → 加入 workspace |
| **前置依赖** | 无 |
| **并行性** | 可分解为每个 crate 的独立子任务并行执行 |
| **验证标准** | `cargo check` 成功，且 `cargo deny check bans` 无新增重复版本警告 |

### 2.4 错误处理规范

#### 任务 ID: ERR-001

| 属性 | 值 |
|------|-----|
| **目标文件** | `crates/conex-stream/src/state/tool_accumulator.rs` |
| **当前问题** | `pub fn start()`、`append()`、`finish()` 等方法使用 `Result<(), String>` 作为返回类型。String 错误无法被模式匹配，不利于错误处理 |
| **改进策略** | 定义 `ToolAccumulatorError` 枚举，替换 `String` 错误类型： |

```rust
#[derive(Debug, thiserror::Error)]
pub enum ToolAccumulatorError {
    #[error("Too many tool calls: max {0}")]
    TooManyToolCalls(usize),
    #[error("Unknown tool key: {0}")]
    UnknownToolKey(String),
    #[error("Tool arguments too large")]
    TooLargeArguments,
    #[error("JSON parse error after repair: {0}")]
    JsonParseError(String),
}
```

然后修改所有方法签名：
- `pub fn start(&mut self, key: &str, id: &str, name: &str) -> Result<(), ToolAccumulatorError>`
- `pub fn append(&mut self, key: &str, text: &str) -> Result<(), ToolAccumulatorError>`
- `pub fn finish(&mut self, key: &str) -> Result<Option<ToolCallResult>, ToolAccumulatorError>`

| **前置依赖** | LINT-001（unwrap_used deny 可防止新 unwrap 引入） |
| **并行性** | 可独立于其他任务执行 |
| **验证标准** | `cargo build -p conex-stream` 成功，测试全部通过 |

#### 任务 ID: ERR-002

| 属性 | 值 |
|------|-----|
| **目标文件** | 全项目的 `unwrap()` 和 `expect()` 调用点 |
| **当前问题** | 生产代码中存在 100+ 处 unwrap/expect，其中 3 处高风险 |
| **改进策略** | 分三阶段替换： |

**Phase 1（高风险，需要立即处理）**：

| 位置 | 当前代码 | 替换方案 |
|------|----------|----------|
| `conex-stream/src/parser/openai_chat.rs:111` | `pending.last_mut().unwrap()` | 改为 `pending.last_mut().ok_or_else(|| StreamError::Protocol("no pending tool call".into()))?` |
| `conex-db/src/handlers/query_handler.rs:38` | `stmt.column_name(i).unwrap()` | 改为 `stmt.column_name(i).context("failed to get column name")?` |
| `conex-net/src/connection_pool.rs:51` | `self.connections.last_mut().unwrap()` | 改为返回 `Result<&mut PooledConnection>`，使用 `?` 传播 |

**Phase 2（中风险，使用 `.expect()` 的初始化代码）**：

| 位置 | 替换方案 |
|------|----------|
| `conex-net/src/llm_provider.rs:45,55,58` | 将 `expect()` 改为返回 `Result<Self>` 的构造函数，使用 `?` 传播错误 |
| `conex-compaction/src/tokenizer.rs:21` | 将 `lazy_static!` 初始化改为返回 `Result` 的 fallible 初始化 |
| `conex-compaction/src/tokenizer.rs:41` | 同上 |
| `conex-sandbox/src/gatekeeper.rs:48` | 保留，但添加注释说明这是编译时静态初始化 |

**Phase 3（低风险，使用 `unwrap_or(default)` 的代码）**：
- 保留 `unwrap_or()`、`unwrap_or_default()`、`unwrap_or_else()` 系列调用
- 只要求对高风险 unwrap 和 expect 进行替换

| **前置依赖** | LINT-001（unwrap_used deny 配置） |
| **并行性** | 可分解为子任务并行 |
| **验证标准** | `cargo clippy --all-targets -- -D clippy::unwrap_used -D clippy::expect_used` 通过 |

#### 任务 ID: ERR-003

| 属性 | 值 |
|------|-----|
| **目标文件** | `crates/conex-ipc/src/router.rs` |
| **当前问题** | 第 133 行使用 `serde_json::to_value(request.payload).unwrap_or_default()`，错误的序列化会被静默吞没 |
| **改进策略** | 改为显式错误处理，返回 `IpcResponse` 的错误变体： |
```rust
let payload = match serde_json::to_value(request.payload) {
    Ok(v) => v,
    Err(e) => return IpcResponse {
        success: false,
        data: None,
        error: Some(IpcError::new(205_000, format!("Payload serialization error: {}", e))),
        cost_ms: start.elapsed().as_millis() as u32,
    },
};
```
| **前置依赖** | 无 |
| **并行性** | 可独立执行 |
| **验证标准** | `cargo test -p conex-ipc` 全部通过 |

### 2.5 不安全代码管理

#### 任务 ID: UNSAFE-001

| 属性 | 值 |
|------|-----|
| **目标文件** | `crates/conex-search/src/index.rs` |
| **当前问题** | `unsafe { MmapOptions::new().map(&file)? }` 和 `unsafe { std::str::from_utf8_unchecked(bytes) }` 均缺少 `// SAFETY:` 注释 |
| **改进策略** | 为每个 unsafe 块添加规范化的 SAFETY 注释。模板： |

```rust
// SAFETY:
// - `MmapOptions::new().map()` 返回 `io::Result<Mmap>`，文件句柄 `file` 在此前已打开成功，
//   因此 `file` 是有效的已打开文件描述符。
// - `mmap` 的 lifetime 受 `MmapIndex` 结构体的生命周期约束，不会在释放后被引用。
// - 文件大小在 mmap 前未显式检查，但调用者负责确保文件非空且可读。
// TODO: 添加文件大小验证（https://github.com/conex/issues/NNN）
```

```rust
// SAFETY:
// - 调用者保证 `self.mmap` 包含的数据是有效 UTF-8 编码的文本。
// - `offset` 和 `len` 参数确保在 mmap 的有效范围内（由 `read_bytes` 的边界检查保障）。
// - 这里的性能关键路径（搜索索引读取）需要零拷贝访问，因此使用 `from_utf8_unchecked`
//   避免重复 UTF-8 验证的开销。
// TODO: 在 `MmapIndex::new()` 中预验证整个 mmap 的 UTF-8 有效性，然后移除 unsafe。
```

| **前置依赖** | 无 |
| **并行性** | 可与 UNSAFE-002 并行 |
| **验证标准** | 代码审查确认 SAFETY 注释包含所有必要的前提条件说明 |

#### 任务 ID: UNSAFE-002

| 属性 | 值 |
|------|-----|
| **目标文件** | `crates/conex-sandbox/src/process_tree.rs` |
| **当前问题** | `unsafe { ... }` 块包含 Windows Job Object API 调用和 `libc::setpgid(0, 0)` 调用，均无 SAFETY 注释 |
| **改进策略** | 添加 SAFETY 注释。Windows 部分的模板： |

```rust
// SAFETY:
// - `CreateJobObjectW`：传入 `null` 表示创建无名 Job Object，不需要访问现有对象。
//   返回 `null` 时函数会提前返回，不会继续使用无效 handle。
// - `SetInformationJobObject`：`info` 在栈上分配，其指针在该调用期间保持有效。
//   `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 的 `StructureType` 字段设置为 9（正确类型）。
// - `AssignProcessToJobObject`：`process_handle` 是调用者传入的有效进程句柄，
//   来自于 `std::process::Child::into_raw_handle()`。
// - 所有 Windows API 调用后立即检查返回值，失败时释放资源并 bail。
```

Unix 部分的模板：

```rust
// SAFETY:
// - `libc::setpgid(0, 0)` 将当前进程的进程组 ID 设置为当前进程的 PID。
//   根据 POSIX 规范，参数 `0` 表示当前进程，此调用总是安全的。
// - 多线程上下文中的使用：`setpgid` 在 setsid 之后调用，此时进程还不是
//   进程组 leader，此调用创建新的进程组。
```

| **前置依赖** | 无 |
| **并行性** | 可与 UNSAFE-001 并行 |
| **验证标准** | 代码审查确认 SAFETY 注释完整性 |

#### 任务 ID: UNSAFE-003

| 属性 | 值 |
|------|-----|
| **目标文件** | `CONVENTIONS.md`（根目录新建）或 `AGENTS.md` |
| **当前问题** | 项目缺少 unsafe 使用的书面规范和审计流程 |
| **改进策略** | 在工程规范文档中定义 unsafe 管理规范： |

1. **unsafe 使用门槛**：新增 unsafe 代码必须获得至少一位核心维护者的 approve
2. **SAFETY 注释格式**：必须包含（a）不安全的前提条件，（b）调用者需要满足的约束，（c）unsafe 的替代方案（如果有）
3. **unsafe 审计频率**：每个发布周期前对所有 unsafe 块进行一次审计
4. **unsafe 计数器**：维护 unsafe 块的数量和位置清单，目标是逐步减少而非增加 |

| **前置依赖** | UNSAFE-001、UNSAFE-002 |
| **并行性** | 需要在 SAFETY 注释完成后 |
| **验证标准** | 文档已创建并经团队评审同意 |

### 2.6 测试规范

#### 任务 ID: TEST-001

| 属性 | 值 |
|------|-----|
| **目标文件** | `crates/conex-fs/src/`、`crates/conex-net/src/`、`crates/conex-types/src/` |
| **当前问题** | conex-fs、conex-net、conex-types 这三个 crate 完全没有测试 |
| **改进策略** | 为每个 crate 添加核心测试，遵循现有测试风格： |

**conex-types**（最小覆盖率要求）：
- `IpcError::new()` 构造与序列化测试
- `Message` 序列化/反序列化测试
- `DiffResult`/`DiffHunk`/`DiffLine` 结构验证测试
- `SearchType` 枚举测试
- `SandboxLevel` 序列化测试

**conex-fs**（最小覆盖率要求）：
- `path_utils.rs`: `resolve_under_root` 路径解析测试（正常路径、../越界、root 本身）
- `path_utils.rs`: `normalize_path` 规范化测试
- `path_utils.rs`: `relative_path` 相对路径计算测试
- `ignore_rules.rs`: `.gitignore` 模式解析和匹配测试

**conex-net**（最小覆盖率要求）：
- `http_client.rs`: `HttpClient` 构造测试
- `llm_provider.rs`: URL 格式化和 header 构造测试（mock HTTP）
- `connection_pool.rs`: 连接池基本操作测试

| **前置依赖** | 无 |
| **并行性** | 三个 crate 的测试可并行编写 |
| **验证标准** | 三个 crate 各有至少 5 个测试函数，`cargo test -p <crate>` 全部通过 |

#### 任务 ID: TEST-002

| 属性 | 值 |
|------|-----|
| **目标文件** | 所有 crate 的 `tests/` 目录 |
| **当前问题** | 全项目无集成测试目录 |
| **改进策略** | 在关键 crate 下创建 `tests/` 目录，编写集成测试： |

**优先创建集成测试的 crate**：
- `conex-ipc/tests/` — IpcRouter 的端到端路由测试（mock handler 注册、dispatch、fallback）
- `conex-db/tests/` — SQLite 连接池的完整 WAL PRAGMA 验证和并发测试
- `conex-sandbox/tests/` — CommandGatekeeper 的完整模式匹配集成测试

集成测试命名规范：`tests/<test_name>.rs`，每个文件一个测试场景。

| **前置依赖** | TEST-001（单元测试基础设施） |
| **并行性** | 可并行编写 |
| **验证标准** | `cargo test --tests` 运行集成测试全部通过 |

#### 任务 ID: TEST-003

| 属性 | 值 |
|------|-----|
| **目标文件** | `Cargo.toml`（添加 `[workspace.metadata.tarpaulin]` 或 `[package.metadata]`） |
| **当前问题** | 无代码覆盖率门槛 |
| **改进策略** | 设置最小覆盖率目标，使用 cargo-tarpaulin 或 cargo-llvm-cov 测量： |

```
覆盖率目标（6 个月内达成）：
- conex-types: ≥ 60% 行覆盖率
- conex-stream: ≥ 70% 行覆盖率
- conex-ipc: ≥ 65% 行覆盖率
- conex-db: ≥ 50% 行覆盖率
- conex-search: ≥ 60% 行覆盖率
- conex-compaction: ≥ 65% 行覆盖率
- conex-diff: ≥ 60% 行覆盖率
- conex-sandbox: ≥ 70% 行覆盖率
- conex-fs: ≥ 40% 行覆盖率（新添加测试）
- conex-net: ≥ 30% 行覆盖率（新添加测试）
全项目平均: ≥ 60%
```

| **前置依赖** | TEST-001、TEST-002 |
| **并行性** | 代码覆盖测量可在测试编写后进行 |
| **验证标准** | `cargo llvm-cov --all-targets` 报告覆盖率达到上述门槛 |

#### 任务 ID: TEST-004

| 属性 | 值 |
|------|-----|
| **目标文件** | `CONVENTIONS.md` 或 `AGENTS.md` |
| **当前问题** | 无测试命名和组织规范 |
| **改进策略** | 定义测试规范： |

1. **测试文件组织**：模块级测试放在 `tests/` 目录下，测试文件命名为 `<module>_tests.rs`，使用 `#[path = "..._tests.rs"] #[cfg(test)] mod tests;` 引入
2. **函数命名**：`fn test_<行为>_<条件>()`，如 `test_compact_system_message_preserved()`
3. **断言风格**：优先使用 `pretty_assertions::assert_eq!` 进行深度相等比较
4. **测试隔离**：避免测试间共享可变状态；file/DB 相关测试使用 tempfile/temp dir |
| **前置依赖** | 无 |
| **并行性** | 可独立执行 |
| **验证标准** | 测试命名和结构符合上述规范 |

### 2.7 文档规范

#### 任务 ID: DOC-001

| 属性 | 值 |
|------|-----|
| **目标文件** | 所有 crate 的 `lib.rs` |
| **当前问题** | 7 个 crate 的 lib.rs 只有模块声明，无 crate 级文档 |
| **改进策略** | 为每个 crate 添加 crate 级文档注释（`//!`），至少包含： |
| | - crate 目的和职责范围 |
| | - 主要公共类型和 trait 的链接 |
| | - 使用示例（至少一个简短代码示例） |

具体计划：

| crate | 当前 lib.rs 行数 | 需要添加 |
|-------|-----------------|----------|
| `conex-ipc/src/lib.rs:1-5` | 5 | crate 文档 + 导出类型说明 |
| `conex-stream/src/lib.rs:1-3` | 3 | crate 文档 + 子模块说明 |
| `conex-db/src/lib.rs:1-6` | 6 | crate 文档 + 连接池用法 |
| `conex-fs/src/lib.rs:1-5` | 5 | crate 文档 + watch/read 用法 |
| `conex-net/src/lib.rs:1-5` | 5 | crate 文档 + 网络层职责 |
| `conex-search/src/lib.rs:1-8` | 8 | crate 文档 + 搜索 API 说明 |
| `conex-types/src/lib.rs:1-201` | 201 | **无**（已够长） |
| `conex-sandbox/src/lib.rs:1-4` | 4 | crate 文档 + gatekeeper 说明 |
| `conex-compaction/src/lib.rs:1-9` | 9 | crate 文档 + compaction 策略 |
| `conex-diff/src/lib.rs:1-8` | 8 | crate 文档 + diff 引擎用途 |

| **前置依赖** | 无 |
| **并行性** | 每个 crate 可独立添加 |
| **验证标准** | `cargo doc --no-deps --document-private-items` 构建无警告 |

#### 任务 ID: DOC-002

| 属性 | 值 |
|------|-----|
| **目标文件** | `crates/conex-types/src/lib.rs` |
| **当前问题** | 22 个公共结构体/枚举，99% 的字段无文档注释 |
| **改进策略** | 为所有公共字段添加 rustdoc 注释。需要添加的字段示例： |

```rust
/// 文件系统事件的通知负载。
///
/// 由 `conex-fs` 的 `FileWatcher` 发出，通过 IPC 传给前端 UI。
pub struct FileEvent {
    /// 受影响的文件路径（相对于项目根目录或绝对路径）。
    pub path: String,
    /// 事件类型（创建/修改/删除等）。
    pub kind: FileEventKind,
}

/// IPC 命令请求。
///
/// `command` 字段标识目标 handler，`payload` 包含该命令的具体参数。
pub struct IpcRequest<T> {
    /// 目标命令名称，如 "db_query"、"compute_diff"。
    pub command: String,
    /// 命令参数，具体的结构取决于 command 的值。
    pub payload: T,
}
```

所有需要添加文档的字段清单：
- `IpcRequest.command`、`IpcRequest.payload`
- `IpcResponse.success`、`IpcResponse.data`、`IpcResponse.error`、`IpcResponse.cost_ms`
- `IpcError.code`、`IpcError.message`
- `Message.role`、`Message.content`、`Message.images`、`Message.is_custom_ui_msg`
- `FuzzyMatchResult.score`、`FuzzyMatchResult.matched_indices`
- `FileHit.path`、`FileHit.score`、`FileHit.match_indices`
- `TextSearchHit.file_path`、`TextSearchHit.line_number`、`TextSearchHit.content_preview`
- `SearchRequest.query`、`SearchRequest.limit`、`SearchRequest.search_type`、`SearchRequest.case_sensitive`
- `IndexingStatus.total_files_scanned`、`IndexingStatus.is_indexing`、`IndexingStatus.memory_usage_mb`
- `CompactionResult.messages`、`CompactionResult.tokens_consumed`、`CompactionResult.cache_hit_rate_optimized`
- `TerminalSize.rows`、`TerminalSize.cols`、`TerminalSize.pixel_width`、`TerminalSize.pixel_height`
- `ExecutionContext.cwd`、`ExecutionContext.env_vars`、`ExecutionContext.sandbox_level`
- `DiffResult.hunks`
- `DiffHunk.old_start`、`DiffHunk.old_lines`、`DiffHunk.new_start`、`DiffHunk.new_lines`、`DiffHunk.lines`
- `DiffLine.kind`、`DiffLine.old_line_num`、`DiffLine.new_line_num`、`DiffLine.text`
- `SwarmMetrics.active_agents`、`SwarmMetrics.total_tasks`、`SwarmMetrics.avg_latency_ms`、`SwarmMetrics.uptime_secs`

| **前置依赖** | 无 |
| **并行性** | 可独立执行 |
| **验证标准** | `cargo doc -p conex-types --no-deps` 构建成功，所有类型字段均有文档 |

#### 任务 ID: DOC-003

| 属性 | 值 |
|------|-----|
| **目标文件** | `Cargo.toml` 中所有 crate 的 `[lints]` 配置 |
| **当前问题** | 无 crate 配置 `rustdoc::missing_crate_level_docs` 或 `rustdoc::all` lint |
| **改进策略** | 在所有 crate 的 `lib.rs` 中添加：`#![warn(missing_docs)]`。配置 workspace lints 中的 rustdoc lint： |

```toml
[workspace.lints.rustdoc]
missing_crate_level_docs = "warn"
missing_doc_code_examples = "allow"  # 非强制，但鼓励
```

同时建议但不要求：`private_doc_tests`、`invalid_html_tags`、`broken_intra_doc_links` 设为 `deny`。

| **前置依赖** | DOC-001、DOC-002（先补全文档再开启 warn） |
| **并行性** | 必须在基本文档覆盖完成后 |
| **验证标准** | `cargo doc --no-deps 2>&1 | grep "warning:"` 中 rustdoc 相关警告数量可控 |

### 2.8 自定义 Linter / 辅助工具

#### 任务 ID: TOOL-001

| 属性 | 值 |
|------|-----|
| **目标文件** | `tools/argument-comment-lint/`（新建目录） |
| **当前问题** | 代码中 `fuzzy.rs:14` 使用了 `new(false)` 和 `new(true)` 这样的布尔字面量调用，位置参数不直观 |
| **改进策略** | 创建一个简单的 lint 脚本，检查函数调用中的裸布尔/数字字面量位置参数，要求带注释 `/*param_name*/`。这与参考项目中的 argument-comment-lint 理念一致 |

实现方案：用 Rust 编译或 Python 脚本实现一个源码扫描器，检测满足以下条件的调用：
1. 函数参数是布尔字面量 `true`/`false`、数字字面量（不含类型后缀）
2. 参数前没有 `/*param_name*/` 注释
3. 排除测试代码（`#[cfg(test)]`）

影响代码：
- `crates/conex-search/src/fuzzy.rs:14` — `FuzzyMatcher::new(false)` → `FuzzyMatcher::new(/*case_sensitive*/ false)`
- `crates/conex-search/src/fuzzy.rs:271` — `prefilter_contains(..., case_sensitive)` 需要检查

| **前置依赖** | LINT-001（基本 lint 设施） |
| **并行性** | 可独立开发 |
| **验证标准** | 工具对当前代码库运行输出可管理的告警列表 |

#### 任务 ID: TOOL-002

| 属性 | 值 |
|------|-----|
| **目标文件** | `scripts/ci-check.sh` 或 `justfile` |
| **当前问题** | 缺少本地运行的全套纪律检查工作流 |
| **改进策略** | 创建 CI 检查脚本，按顺序运行以下命令： |

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== 1. Format check ==="
cargo fmt -- --check

echo "=== 2. Clippy check ==="
cargo clippy --all-targets -- -D warnings

echo "=== 3. Dependency audit ==="
cargo deny check advisories

echo "=== 4. License check ==="
cargo deny check licenses

echo "=== 5. Ban check ==="
cargo deny check bans

echo "=== 6. Documentation check ==="
cargo doc --no-deps --all-features 2>&1 | grep -E "warning|error" && exit 1 || true

echo "=== 7. Test run ==="
cargo test --all-targets
```

| **前置依赖** | CFG-002（workspace lints）、LINT-002（clippy.toml）、DEP-001（deny.toml） |
| **并行性** | 需上述配置就绪 |
| **验证标准** | 脚本在本地成功运行且无报错 |

---

## 3. 任务间逻辑依赖关系

### 3.1 依赖图（DAG）

```
Phase 0:              [无依赖]  TOOL-003 (创建 analysis/ 目录)
                           │
Phase 1:              CFG-001  CFG-003  LINT-002  LINT-003  DEP-001
                       │   │                              │
                       │   └── CFG-002 (需要 edition 统一后再配置 lints)
                       │              │
                       v              v
Phase 1.5:           LINT-001 (需要 workspace lints 基础)
                       │
                       v
Phase 2:             TOOL-002 (需要 CFG-002 + LINT-002 + DEP-001)
                       │
                       v
Phase 3 (改造):     ERR-001  ERR-002  ERR-003  UNSAFE-001  UNSAFE-002
                      │         │                           │
                      v         v                           v
Phase 3.5:          [无依赖]                              UNSAFE-003
                       │
                       v
Phase 4 (测试):     TEST-001  TEST-004
                       │
                       v
                    TEST-002  TEST-003
                       │
                       v
                    DOC-001  DOC-002
                       │
                       v
                    DOC-003（需要 DOC-001 + DOC-002）
                       │
                       v
Phase 5 (工具):     TOOL-001  TOOL-002
```

### 3.2 可并行执行的任务批次

| 批次 | 任务 ID | 说明 |
|------|---------|------|
| Batch A | CFG-001, CFG-003, LINT-002, LINT-003, DEP-001 | 基础配置，完全独立 |
| Batch B | CFG-002 | 依赖 Batch A 中的 CFG-001（edition 统一） |
| Batch C | LINT-001 | 依赖 CFG-002 |
| Batch D | ERR-001, ERR-002, ERR-003, UNSAFE-001, UNSAFE-002 | 代码改造，相互独立 |
| Batch E | UNSAFE-003, TEST-001, TEST-004 | 依赖 Batch D 但相互独立 |
| Batch F | TEST-002, TEST-003 | 依赖 Batch E 中的 TEST-001 |
| Batch G | DOC-001, DOC-002 | 相互独立 |
| Batch H | DOC-003 | 依赖 Batch G |
| Batch I | TOOL-001, TOOL-002 | 依赖前面所有配置就绪 |

### 3.3 关键路径

```
CFG-001 → CFG-002 → LINT-001 → ERR-001..003 (代码改造)
                                 → TEST-001 → TEST-002 → DOC-001/2 → DOC-003 → TOOL-001/2
```

关键路径长度约 7 步，每步估算 1-3 天，总计约 2-3 周完成所有改进。

---

## 4. 与现有系统的集成点

### 4.1 Cargo.toml 集成

所有与 Cargo 相关的配置集成在以下位置：

| 配置项 | 集成位置 | 机制 |
|--------|----------|------|
| workspace lints | `Cargo.toml` 新增 `[workspace.lints]` | 全部 crate 继承 |
| crate 级 lints | 每个 crate 的 `Cargo.toml` 新增 `[lints] workspace = true` | workspace 继承 |
| profile | `Cargo.toml` 新增 `[profile.*]` | 全局生效 |
| 依赖管理 | `deny.toml` 根目录 | cargo-deny 工具读取 |
| clippy 规则 | `clippy.toml` 根目录 | cargo clippy 自动读取 |

### 4.2 CI 集成

所有自动化检查集成到 CI pipeline 中：

| 检查项 | CI 阶段 | 失败策略 |
|--------|---------|----------|
| rustfmt 检查 | lint | ❌ 拒绝合并 |
| clippy deny 规则 | lint | ❌ 拒绝合并 |
| cargo-deny (advisory) | security | ❌ 紧急修复 |
| cargo-deny (license) | compliance | ⚠️ 警告不阻塞 |
| cargo-deny (bans) | lint | ❌ 拒绝合并 |
| cargo doc | docs | ❌ 拒绝合并（有 errors） |
| cargo test | test | ❌ 拒绝合并 |
| 代码覆盖率 | test | ⚠️ 注释趋势 |

### 4.3 CI 检查脚本模式

推荐以下任一方式：

**选项 A：shell 脚本**（简单）
- 在项目根目录创建 `scripts/ci.sh`
- CI 调用 `bash scripts/ci.sh`

**选项 B：justfile**（推荐，如果有 just）
- 定义 `ci-full` 命令运行全套检查
- 定义 `ci-quick` 命令运行 lint 和 test（无 doc 和 deny）
- 定义 `fix` 命令运行 `cargo fmt` + `cargo clippy --fix`

**选项 C：Makefile**（跨平台兼容）
- `make check`、`make test`、`make lint`

### 4.4 开发者工作流集成

建议修改 `AGENTS.md`（或创建 `CONVENTIONS.md`），加入以下内容：

```
## 工程纪律检查

在提交代码前，运行以下命令：

# 格式化代码
cargo fmt

# clippy 检查（拒绝所有 lint 错误）
cargo clippy --all-targets -- -D warnings

# 运行测试
cargo test --all-targets

# 构建文档
cargo doc --no-deps --document-private-items

# 依赖审计（如果安装了 cargo-deny）
cargo deny check advisories
```

---

## 5. 验证标准

### 5.1 短期验证（第 1-4 周）

| 检查项 | 验证方法 | 接受标准 |
|--------|----------|----------|
| workspace lints 激活 | `cargo clippy --all-targets` | 无 `unknown_lints` 错误 |
| rustfmt 合规 | `cargo fmt -- --check` | 零 diff |
| 依赖审计启动 | `cargo deny check advisories` | 可检测到已知漏洞 |
| unwrap 替换 | `rg '\.unwrap\(\)' crates/*/src/` | 生产代码 zero 高风险 unwrap |
| unsafe 注释 | 人工审查 | 每个 unsafe 块有 SAFETY 注释 |

### 5.2 中期验证（第 5-12 周）

| 检查项 | 验证方法 | 接受标准 |
|--------|----------|----------|
| 测试覆盖 | `cargo llvm-cov` | 全项目平均 ≥ 50% |
| 集成测试 | `cargo test --tests` | ≥ 5 个集成测试用例 |
| rustdoc 完整 | `cargo doc --no-deps` | 无 missing_docs 警告 |
| CI 通过率 | CI dashboard | ≥ 95% |

### 5.3 长期验证（第 13-24 周）

| 检查项 | 验证方法 | 接受标准 |
|--------|----------|----------|
| unwrap 数量趋势 | 每周脚本统计 | 持续下降至零 |
| unsafe 数量趋势 | 每周脚本统计 | 不再增加 |
| 自定义 linter 使用 | CI 集成 | 每次 PR 自动运行 |
| 社区贡献者调查 | 季度反馈 | 工程纪律满意度 ≥ 4/5 |

---

## 6. 风险评估

### 6.1 实施风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 开发者抵触新增的 lint deny 规则 | 中 | 高 | 先 warn 再 deny，留过渡期；通过团队讨论确定规则列表 |
| unwrap 替换引入新 bug | 中 | 高 | 每次替换确保有测试覆盖；替换后运行全量测试 |
| CI 流水线配置复杂 | 低 | 中 | 使用成熟的 CI 模板，分步添加检查 |
| 文档编写耗时影响功能开发 | 高 | 中 | 分解为小任务，每人每天贡献 30 分钟 |
| cargo-deny 初次运行发现大量问题 | 高 | 中 | 先记录所有问题，分类为 blocker 和 non-blocker |
| clippy deny 导致现有代码无法编译 | 高 | 高 | Phase 1 设为 warn，修复所有警告后再升级为 deny |

### 6.2 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| `unwrap_used` deny 在测试代码中误报 | 中 | 低 | 使用 clippy.toml 的 `allow-unwrap-in-tests = true` |
| `cargo deny` 不支持所有依赖 | 低 | 中 | 使用 `.cargo/config.toml` 补充配置 |
| rustdoc lint 开启后大量历史警告 | 高 | 中 | 先补全核心类型文档再开启 `missing_docs` |
| CI 运行时间增加 | 中 | 中 | 使用 `--workspace` 缓存优化；分阶段运行 lint 和 test |

### 6.3 风险缓解优先级矩阵

```
高影响 + 高概率：[[ clippy deny 导致现有代码无法编译 ]]
  → 缓解：所有 lint 先 warn，4 周过渡期

高影响 + 低概率：[[ unwrap 替换引入 bug ]]
  → 缓解：每次替换有测试覆盖、code review

低影响 + 高概率：[[ cargo-deny 初次发现大量问题 ]]
  → 缓解：issue 追踪，分 sprint 解决
```

---

## 7. 时间线建议

| 周次 | 里程碑 | 交付物 |
|------|--------|--------|
| 第 1 周 | 基础设施 | CFG-001、CFG-003、LINT-003、DEP-001 |
| 第 2 周 | Lint 配置 | CFG-002、LINT-001、LINT-002、TOOL-002 |
| 第 3 周 | 代码改造（Phase 1） | ERR-002（高风险 unwrap）、ERR-003 |
| 第 4 周 | 代码改造（Phase 2） | ERR-001、UNSAFE-001、UNSAFE-002 |
| 第 5 周 | 测试 | TEST-001、TEST-004、UNSAFE-003 |
| 第 6 周 | 测试 + 集成 | TEST-002、TEST-003 |
| 第 7 周 | 文档 | DOC-001、DOC-002 |
| 第 8 周 | 文档 + 工具 | DOC-003、TOOL-001 |
| 第 9-10 周 | 过渡期 | 评估 warn→deny 升级、修复遗留问题 |
| 第 11-12 周 | 收尾 | 全量纪律检查通过、文档完善 |

---

## 8. 附录：配置模板参考

### 8.1 workspace lints 完整配置

```toml
[workspace.lints.rust]
unsafe_code = "deny"

[workspace.lints.clippy]
# === 安全关键：防止 panic/UB/死锁 ===
unwrap_used = "deny"
expect_used = "deny"
await_holding_lock = "deny"
await_holding_invalid_type = "deny"

# === 正确性关键 ===
identity_op = "deny"
manual_clamp = "deny"
manual_filter = "deny"
manual_find = "deny"
manual_flatten = "deny"
manual_map = "deny"
manual_memcpy = "deny"
manual_ok_or = "deny"
manual_range_contains = "deny"
manual_retain = "deny"
manual_strip = "deny"
manual_try_fold = "deny"
manual_unwrap_or = "deny"
needless_borrow = "deny"
needless_borrowed_reference = "deny"
needless_collect = "deny"
needless_late_init = "deny"
needless_option_as_deref = "deny"
needless_question_mark = "deny"
needless_update = "deny"
redundant_clone = "deny"
redundant_closure = "deny"
redundant_closure_for_method_calls = "deny"
redundant_static_lifetimes = "deny"
trivially_copy_pass_by_ref = "deny"
uninlined_format_args = "deny"
unnecessary_filter_map = "deny"
unnecessary_lazy_evaluations = "deny"
unnecessary_sort_by = "deny"
unnecessary_to_owned = "deny"

# === 可读性/可维护性（先 warn） ===
print_stdout = "warn"
print_stderr = "warn"
wildcard_imports = "warn"
enum_glob_use = "warn"
module_name_repetitions = "warn"
```

### 8.2 deny.toml 完整最小配置

```tomm
[graph]
targets = []
all-features = false
no-default-features = false

[advisories]
ignore = []

[licenses]
allow = [
    "Apache-2.0",
    "MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "CC0-1.0",
    "Unicode-3.0",
    "Unlicense",
    "MPL-2.0",
]
confidence-threshold = 0.8

[licenses.private]
ignore = false

[bans]
multiple-versions = "warn"
wildcards = "allow"
highlight = "all"

[sources]
unknown-registry = "deny"
unknown-git = "deny"
required-git-spec = "rev"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
allow-git = []
```

### 8.3 profile 最小配置

```toml
[profile.dev]
debug = "limited"

[profile.release]
lto = "thin"
codegen-units = 1
strip = "symbols"

[profile.dev-small]
inherits = "dev"
debug = "none"
strip = "symbols"

[profile.profiling]
inherits = "release"
debug = "full"
lto = false
strip = false
```

### 8.4 rusfmt.toml 最终配置

```toml
max_width = 120
tab_spaces = 4
edition = "2024"
imports_granularity = "Item"
```
