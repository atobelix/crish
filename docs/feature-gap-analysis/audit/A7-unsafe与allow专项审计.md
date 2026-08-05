# A-7 审计轮：unsafe / FFI / allow 豁免专项审计

> 产出：Agent A-7（只读审计，不 commit）
> 范围：crates/ 全部 + apps/agent-workbench/src-tauri/（Rust 侧）；前端 TS 不在本审计面。
> 基线：`docs/feature-gap-analysis/审计准备-已知缺点与技术债汇总.md`（已登记项不重复登记，仅在「已登记对照」节引用）。
> 方法：全仓 grep 收集 `unsafe` / `#[allow(` / windows-sys / kernel32 FFI 调用点，逐处人工核读 SAFETY 注释与豁免理由，对照 clippy.toml 禁令清单逐条核验。

---

## 1. 总览统计

| 维度 | 数量 | 分布 |
| :--- | :---: | :--- |
| unsafe 块（`unsafe { }` 表达式） | 36 | crates 7 处 + src-tauri 29 处 |
| unsafe impl（Send/Sync 标记） | 2 | process.rs（JobHandle） |
| 裸 extern "system" 声明 | 2 组 | output_dir.rs（GetLocalTime/GetSystemTime）、cron.rs（GetLocalTime） |
| `#[allow(unsafe_code)]` | 23 | 见 §3.2 |
| `#[allow(clippy::disallowed_methods)]` | 18 | 产品 13 + 测试 mod 4 + conex-test-utils crate 级 1 |
| `#[allow(dead_code)]` | 78 + cfg_attr 若干 | engine.rs 36 居首 |
| `#[allow(clippy::too_many_arguments)]` | 10 | 全部无理由注释 |
| `#[allow(unused_imports)]` | 4 | 平台条件导入（可接受） |
| 其他 allow（large_enum_variant / type_complexity / result_large_err / enum_variant_names / non_upper_case_globals） | 9 | 全部无理由注释 |
| **allow 合计** | **≈142** | |
| 高危发现 | 2 | §6 |
| 可直接消除 unsafe | 1 | perf/fs.rs mmap |
| 结构性可消除 unsafe | 1 | GetLocalTime 双实现合并（D-03 已登记） |

unsafe 覆盖文件（8 个）：agent-provider/credentials.rs、agent-tools/output_dir.rs、conex-types/cron.rs、src-tauri/config/credentials.rs、process.rs、resource.rs、power.rs、perf/fs.rs。

**已登记项对照**（本审计不再展开，引用备查）：
- D-03（FFI 本地时区两处独立实现）— 本审计确认两处 GetLocalTime FFI 各自声明，且 output_dir.rs 比 cron.rs 多一个 GetSystemTime（同刻差值口径不同：output_dir 差值 15 分钟取整、cron 直接 /60）。
- D-04（豁免机制蔓延、缺统一清单）— 本审计确认豁免面已扩展至 8 文件 23 处 unsafe_code + 18 处 disallowed_methods，无集中登记表。
- B-01（clamp_text dead_code）、A-10（TimerRegistry on_event）、A-11（feed/mark_wakeup 旁路点）— 对应 dead_code 豁免面，已在汇总表登记。

---

## 2. unsafe 清单表（36 块 + 2 impl）

### 2.1 crates 侧（7 块）

| # | 位置 | 用途 | SAFETY 质量 | 可消除性 |
| :--- | :--- | :--- | :--- | :--- |
| U-01 | agent-provider/src/credentials.rs:39 | `buf.as_mut_vec()` 覆写清零（SecretString::wipe） | 中。有 SAFETY（写入全零破坏 UTF-8 不变量，但仅在丢弃前/测试中调用）——逻辑成立。**缺陷**：非 volatile 写，理论上优化器可能消除清零循环；标准做法是 zeroize/volatile，注释已声明 zeroize 转正计划。 | 无安全替代（String 无清零面）；待 zeroize 转正后替换（已登记计划） |
| U-02 | agent-provider/src/credentials.rs:340 | CryptProtectData FFI | 好。三条 SAFETY 逐项覆盖（in_blob 缓冲区、out_blob 填充、UI_FORBIDDEN）；ok==0 错误检查；LocalFree 配对。 | 无（windows-sys 无 safe 包装） |
| U-03 | agent-provider/src/credentials.rs:357 | from_raw_parts 拷贝密文 | 好。SAFETY 说明成功时 pbData 有效、立即 to_vec；拷贝先于 LocalFree，顺序正确。 | 无 |
| U-04 | agent-provider/src/credentials.rs:359 | LocalFree 释放 | 好。SAFETY 说明指针原样返回。 | 无 |
| U-05 | agent-provider/src/credentials.rs:390/407/409 | CryptUnprotectData + from_raw_parts + LocalFree | 好，同 U-02~U-04 结构。 | 无 |
| U-06 | agent-tools/src/tools/output_dir.rs:185 | GetLocalTime/GetSystemTime 同刻采集 | **差（纪律缺口）**。模块头（:134-138）有豁免理由，但 **unsafe 块上方无 `// SAFETY:` 注释**——全仓唯一两处缺失之一（另一处见 U-07）。正确性本身成立：函数无失败返回、仅写栈上 POD、无指针逃逸、extern 块与 repr(C) 结构布局核对无误。 | 结构性：与 cron.rs 合并为共享封装后可消一处（D-03） |
| U-07 | conex-types/src/cron.rs:479 | GetLocalTime 取本地墙钟 | **差（纪律缺口）**。allow 有理由注释（:475-477，引用 DPAPI 评审先例）但 **无 SAFETY 注释**。正确性成立（同上）。 | 结构性：与 U-06 合并（D-03） |

### 2.2 src-tauri 侧（29 块 + 2 impl）

| # | 位置 | 用途 | SAFETY 质量 | 可消除性 |
| :--- | :--- | :--- | :--- | :--- |
| U-08 | config/credentials.rs:425/442/444 | CryptProtectData（壳侧副本） | 好，同 U-02~U-04。 | 无（与 agent-provider 双实现，为抽取迁移历史，非新债） |
| U-09 | config/credentials.rs:475/492/494 | CryptUnprotectData（壳侧副本） | 好。 | 无 |
| U-10 | process.rs:447 | `unsafe impl Send for JobHandle` | 好。SAFETY：仅含整数句柄；Create/Assign/Close 串行化到 OnceLock。 | 若 JobHandle 改包 `usize` 可免（不推荐，损失句柄类型信息） |
| U-11 | process.rs:454 | `unsafe impl Sync for JobHandle` | **中（注释不完整）**。SAFETY 仅一行「仅含整数句柄」，未明示「句柄一经 OnceLock 初始化后只读、进程生命周期内不被并发关闭」这一关键不变量（Send 侧注释提到串行化，Sync 侧没提）。语义上成立（OnceLock get() 只读借用 + 句柄表引用计数），但注释应补齐。 | 同上 |
| U-12 | process.rs:471-493 | CreateJobObjectW + SetInformationJobObject | 好。SAFETY（栈分配结构、失败 CloseHandle）；SetInformationJobObject 失败分支句柄清理正确；mem::zeroed() 在块内。 | 无 |
| U-13 | process.rs:506 | AssignProcessToJobObject | 中。SAFETY「hJob 与 processHandle 由调用方保证有效」——依赖调用方契约（pty/session.rs、background.rs adopt 传入 RawHandle），一次性调用不保留句柄，可接受；RawHandle 生命周期约定建议在注释中点名调用方。 | 无 |
| U-14 | process.rs:535 | 重复 init 时 CloseHandle(dup) | 好。SAFETY 明确（OnceLock 已持有一个）。 | 无 |
| U-15 | process.rs:558-569 | OpenProcess + assign + CloseHandle | 好。SAFETY 完整（句柄函数级生命周期、权限集按 MSDN、宿主 Job 拒绝降级语义）；CloseHandle 在 assign 返回后执行，顺序正确；last_os_error 使用正确。 | 无 |
| U-16 | process.rs:601 | 重复 init 时 CloseHandle（PTY） | 好，同 U-14。 | 无 |
| U-17 | process.rs:625 | setpgid | 中。SAFETY「POSIX 标准 API」简略，但无指针参数（pid_t 整数），可接受。 | 无（libc 无 safe 面） |
| U-18 | process.rs:642 | killpg | 中，同 U-17。 | 无 |
| U-19 | process.rs:707 | 测试 CloseHandle | 好。SAFETY 说明测试持有句柄所有权。 | 无（windows-sys 无 safe 包装） |
| U-20 | process.rs:859-866 | 测试 OpenProcess/IsProcessInJob/CloseHandle 配对 | 好。SAFETY 注释存在；句柄配对关闭。 | 无 |
| U-21 | process.rs:882 | 测试 CloseHandle(local_job) | 好。 | 无 |
| U-22 | resource.rs:170 | mem::zeroed()（Basic） | 中。无独立 SAFETY，语义并入 :171-172 函数级 SAFETY（栈分配 + 失败不写内存），可接受但注释位置与 unsafe 表达式分离。 | 无 |
| U-23 | resource.rs:173-181 | QueryInformationJobObject（BasicAccounting） | 好。SAFETY 完整（尺寸真实、失败不写、无句柄所有权转移）；ret==0 错误处理 + last_os_error。 | 无 |
| U-24 | resource.rs:189 | mem::zeroed()（Extended） | 中，同 U-22。 | 无 |
| U-25 | resource.rs:191-199 | QueryInformationJobObject（ExtendedLimit） | 好，同 U-23。 | 无 |
| U-26 | resource.rs:251 | sysconf(_SC_CLK_TCK) | 中。SAFETY 简略（纯查询 API）；**细节**：sysconf 失败返回 -1，`as u64` 得 2^64-1，下游 `clk_tck.max(1)` 兜底正确。 | 无 |
| U-27 | resource.rs:253 | sysconf(_SC_PAGESIZE) | 中，同 U-26（page_size.max(1) 兜底）。 | 无 |
| U-28 | resource.rs:261 | mem::zeroed()（rusage） | 中。SAFETY 注释在 :262-263 独立说明（libc 尺寸保证、失败不写）。 | 无 |
| U-29 | resource.rs:264 | getrusage(RUSAGE_CHILDREN) | 好。rc!=0 时 child_cpu_ms 归 0 分支正确。 | 无 |
| U-30 | power.rs:27 | SetThreadExecutionState | 好。模块级豁免注释（:14-17）覆盖：无指针、flags 常量、返回值 0 检查。 | 无 |
| U-31 | perf/fs.rs:79 | Mmap::map 只读映射 | 好。SAFETY 完整（无并发截断/改写、句柄有效、区间边界）；end 取 min 防越界。**可消除性最高**：本函数是测试专用辅助（`#[cfg_attr(not(test), allow(dead_code))]`），mmap 性能动机不成立，`seek + read_exact` 即可替换，消除整个 UB 面。 | **可直接消除**（改普通读） |

### 2.3 小结

- 36 块中 SAFETY 质量「好」26 处、「中」8 处（U-01/11/13/17/18/22/24/26/27 中注释完整度问题）、「差（缺失）」2 处（U-06/U-07，无 `// SAFETY:` 注释，仅豁免理由）。
- 正确性风险为 0：句柄全部配对、错误检查全部在位、指针生命周期均在函数边界内、结构体布局（SYSTEMTIME 8×u16 repr(C)、CRYPT_INTEGER_BLOB）核对无误。所有问题集中在**注释纪律**而非代码缺陷。

---

## 3. allow 清单表

### 3.1 `#[allow(clippy::disallowed_methods)]`（18 处）

| # | 位置 | 豁免对象 | 理由充分性 |
| :--- | :--- | :--- | :--- |
| A-01 | agent-provider/src/credentials.rs:194 | clear() 的 remove_file | 充分（凭据物理删除不留可恢复副本，clippy.toml 豁免面字面命中） |
| A-02 | agent-provider/src/credentials.rs:454（测试 mod） | 测试临时目录清理 | 充分（有理由注释，豁免面字面命中） |
| A-03 | src-tauri/config/credentials.rs:392 | remove_os_secret | 充分 |
| A-04 | agent-tools/src/tools/shell.rs:737 | run_command_maybe_background spawn | 充分（命令门禁执行面本身，注释点明门禁前置） |
| A-05 | agent-tools/src/tools/shell.rs:2228（测试） | kill_on_drop 语义探测 spawn | 充分（测试探测，注释在） |
| A-06 | agent-tools/src/tools/replace.rs:501 | atomic_write 的 remove_file | 充分（原子写盘交换语义，注释引用 04-EG 定稿；与豁免面「自管文件轮转」同性质） |
| A-07 | agent-tools/src/mcp/bridge.rs:206 | MCP server spawn | 充分（注册面唯一拉起点，注释在） |
| A-08 | conex-db/src/migrate.rs:22 | 迁移备份轮转 remove_file | 充分（自产最旧备份，含敏感数据不留副本） |
| A-09 | conex-telemetry/src/file.rs:238 | 日志保留策略轮转 | 充分（自管日志） |
| A-10 | orchestrator/src/restore.rs:431 | 快照轮转 | 充分（自管备份快照） |
| A-11 | src-tauri/background.rs:548 | .log.rot 轮转清理 | 充分（任务日志内部索引） |
| A-12 | src-tauri/background.rs:926 | 归档清 .meta.json | 充分 |
| A-13 | src-tauri/background.rs:986 | 淘汰清 .meta.json | 充分 |
| A-14 | src-tauri/git.rs:174 | git 白名单执行面 spawn | 充分（固定二进制 + 参数 schema 白名单 + cwd 校验，注释完整） |
| A-15 | src-tauri/process.rs:56 | workbench_run_shell spawn | 充分（门禁双防线前置，注释在 :52-55） |
| A-16 | src-tauri/process.rs:655（测试 mod `#![allow]`） | 测试全模块 | **不足**：模块级裸 allow，**无理由注释**（clippy.toml 豁免面要求「测试 mod 内 allow + 理由」——理由缺失；同域 agent-provider:454、output_dir.rs:534 均有理由） |
| A-17 | src-tauri/host_openers/execute.rs:16（模块级 `#![allow]`） | host opener 执行面 spawn | **中（形式偏离）**：有理由注释（:11-15）但**模块级而非函数级**——clippy.toml 豁免面明文「函数级 allow + 理由」，模块级豁免会连带覆盖未来新增代码（豁免面蔓延，D-04 同向新案例） |
| A-18 | crates/conex-test-utils/Cargo.toml:31 | crate 级 disallowed_methods=allow | 充分（纯测试基建，豁免面字面命中） |

结论：18 处中 15 处充分、1 处理由缺失（A-16）、1 处形式偏离（A-17）、1 处按豁免面明文允许（A-18）。

### 3.2 `#[allow(unsafe_code)]`（23 处）

| 位置 | 覆盖对象 | 理由 |
| :--- | :--- | :--- |
| agent-provider/credentials.rs:34 | wipe | 充分（受控内存擦除） |
| agent-provider/credentials.rs:319 / :368 | dpapi_protect / dpapi_unprotect | 充分（DPAPI FFI，每处 SAFETY） |
| src-tauri/config/credentials.rs:404 / :453 | dpapi_protect / dpapi_unprotect | 充分 |
| src-tauri/process.rs:445 / :452 / :462 / :498 / :528 / :546 / :594 / :622 / :639 / :702 / :823 | Send、Sync、Job FFI ×4、CloseHandle ×2、libc ×2、测试 ×2 | 全部带豁免理由注释（11/11） |
| src-tauri/resource.rs:160 / :223 | Job 查询 ×2 / libc 采样 | 充分 |
| src-tauri/power.rs:18 | SetThreadExecutionState | 充分 |
| src-tauri/perf/fs.rs:73 | Mmap::map | 充分（memmap2 0.9 无 safe API） |
| agent-tools/output_dir.rs:136（模块头注）/ :181 | GetLocalTime/GetSystemTime | 理由充分但 **SAFETY 注释缺失**（见 U-06） |
| conex-types/cron.rs:478 | GetLocalTime | 理由充分但 **SAFETY 注释缺失**（见 U-07） |

### 3.3 `#[allow(dead_code)]`（78 处，按理由覆盖分组）

| 分组 | 处数 | 理由状况 |
| :--- | :---: | :--- |
| engine.rs 接线预留（R-CF3 / E5 / A9 / M11 / T-40 等） | 36 | 多数带接线点注释（「接线后移除」）；**6 处无注释**（:611 / :835 / :1013 / :1045 / :1358 / :1453） |
| background.rs（构造注入 / 采样任务 / 通知通道 / 生产接线点） | 9 | 全部带注释 |
| watchdog.rs / sched.rs / timers.rs（R-CF3 接线预留） | 10 | 全部带注释 |
| dev_mcp.rs / workspace.rs | 8 | **全部无注释**（dev_mcp ×4、workspace :31/375/390/405） |
| resource.rs / core_query_commands.rs / process.rs | 6 | 带注释（T-AB-11 消费、T-40 合并等） |
| 其他（buffer.rs:194、config/resolution.rs:43、perf/diff.rs:46、perf/encoding.rs:120、pty/session.rs、conex-fs/watch.rs:109/112、测试文件 ×2） | 9 | watch.rs 有字段语义注释但无 allow 理由；其余无注释 |

结论：78 处中约 55 处带理由、约 23 处无理由。无理由者多为「测试专用构造/平台条件」类，风险低，但违反「任何 allow 带原因注释」的字面原则。

### 3.4 其他 allow（19 处，全部无理由注释）

- `too_many_arguments` ×10：shell.rs:332/737/1074/1114、tool_exec.rs:528、executing_tools.rs:38、background.rs:1719/2034、core_query_commands.rs:185、engine.rs:1675。
- `large_enum_variant` ×4：session-loop/stream.rs:121、conex-types/events.rs:303、agent-provider/events.rs:207、agent-provider/sse/reader.rs:276。
- `type_complexity` ×3：conex-db/runs.rs:228、stream_error.rs:668、handlers/mod.rs:909。
- `result_large_err` ×1（conex-telemetry/crash.rs:54）、`enum_variant_names` ×1（agent-provider/request/build.rs:29）、`non_upper_case_globals` ×1（conex-types/error.rs:53）。

这些不在 clippy.toml 禁令面内，但 04 方案原则 3 字面要求「任何 allow 必须带原因注释」——**全组 19 处零理由**，是主要纪律缺口。

---

## 4. FFI 调用正确性核查

| 核查项 | 结论 | 证据 |
| :--- | :--- | :--- |
| windows-sys 版本一致性 | 好。壳 0.61 直接依赖、agent-provider workspace=true 同源；feature 集互补无冲突 | 壳 Cargo.toml:62、agent-provider Cargo.toml:41 |
| 错误处理 | 好。全部 FFI 返回值检查在位：DPAPI ok==0、CreateJobObjectW is_null、SetInformationJobObject==0、AssignProcessToJobObject==0、QueryInformationJobObject==0、OpenProcess is_null、SetThreadExecutionState==0、setpgid/killpg !=0 | §2 各条目 |
| 句柄关闭 | 好。OpenProcess/CloseHandle 全部配对（含失败路径与测试）；重复 init 的 dup 句柄关闭正确；LocalFree 原样返回 | process.rs:558-569/707/859-866/882、credentials.rs 四处 |
| 编码 | 好。DPAPI 密文 hex 编解码为 ASCII 子集；GetLocalTime 无字符串参数；无任何宽/窄字符混用 | credentials.rs encode_hex/decode_hex |
| 结构体布局 | 好。SYSTEMTIME 两处独立定义均为 repr(C) 8×u16 且与 Win32 文档一致；CRYPT_INTEGER_BLOB 直接使用 windows-sys 类型 | output_dir.rs:141-155、cron.rs:455-466 |
| 指针生命周期 | 好。全部 out 缓冲区（out_blob、rusage、Job 信息结构）为栈分配 + 立即拷贝；无指针逃逸 | 逐处核读 |
| u32 截断 | 理论面。`input.len() as u32`（cbData 为 DWORD）对 >4GiB 输入截断——实际凭据/密文不可达 | credentials.rs:328/379 |
| 进程注册 | **缺口**。std::process 侧 spawn 的拉起点在门禁内，但 `Command::output()/status()` 等价拉起面不在禁令也不在豁免清单（见 §6 H1） | cli_bridge.rs:110、process.rs:348/362/390 等 |

---

## 5. 可消除性评估

| 项 | 评估 | 结论 |
| :--- | :--- | :--- |
| perf/fs.rs:79 mmap | 测试专用函数（非 test 构建为死代码），mmap 性能动机不成立；`seek + read_exact`（函数内已有 <64KiB 分支同款实现）可直接替换 | **可直接消除 1 个 unsafe** |
| GetLocalTime 双实现 | output_dir.rs 与 cron.rs 各自声明 extern + repr(C)（D-03 已登记）；合并为共享封装后消除 1 处声明 + 1 个 unsafe 块。注意口径差异：output_dir 双时钟差值 15 分钟取整，cron 单时钟减 SystemTime 后直接 /60——合并须保留各自取整语义或统一 | **结构性可消除 1 处**（跨 crate，需主 Agent 排期） |
| wipe as_mut_vec | 无安全替代；zeroize 转正后替换（注释已声明） | 待依赖决策 |
| unsafe impl Send/Sync | 若 JobHandle 包 isize 可免——不推荐（损失类型信息，且 windows-sys HANDLE 即 *mut c_void，包装变化扩散面大） | 保留 |
| 测试 CloseHandle（process.rs:707/882） | windows-sys 无 safe 包装，无替代 | 保留 |
| dead_code 接线预留（约 20+ 处 R-CF3/E5/A9/M11/T-40） | 接线后即消除（engine.rs 15+、sched 4、watchdog 4、timers 2、background 2、resource 2、core_query 1、process 2） | 消除依赖接线轮（对应 A-10/A-11 等已登记项） |
| too_many_arguments 10 处 | 不可消除（参数确实多），但应补理由注释 | 补注释非消除 |

**可消除 unsafe 数：2（1 直接 + 1 结构性）**；allow 侧无可直接删除项，全部为「接线后消除」或「补注释」。

---

## 6. 高危发现

### H1（高）clippy.toml spawn 禁令可被 `Command::output()/status()` 等价绕过

clippy.toml 只禁 `std::process::Command::spawn` 与 `tokio::process::Command::spawn`（:34-35），注释明确「防等价变形（tokio Command）绕过」。但 **`Command::output()` / `Command::status()` 内部同样拉起子进程，未被禁**——正是注释想堵的「坑 1」同型缺口（这次的变形是 output/status 而非 tokio）。

实锤调用点（全部走 output()/status()，零 allow、零豁免登记）：
- cli_bridge.rs:110（`npm` CLI 拉起——**非门禁后执行面**：无进程注册、无白名单 schema，仅 gatekeeper 正则检查）
- process.rs:348/362/390（taskkill/kill——进程管理原语）
- background.rs:2656/2665、core_run_commands.rs:4342/4351、shell.rs:1339/1354（tasklist/kill/taskkill）
- host_openers/execute.rs:170/246/277/308（powershell/cmd/open/xdg-open——模块级 allow 覆盖 spawn 面，但 status() 调用点即使无 allow 也不报）

影响：禁令意图是「子进程必须经门禁/注册面」，当前 taskkill/kill/tasklist 类内部原语属「灰区」——不在禁令、不在豁免清单、不经门禁。npm CLI 面仅靠正则检查，无注册面。**建议**：将 `Command::output`、`Command::status`、`CommandExt::exec` 一并列入 disallowed-methods，并为内部进程管理原语显式登记豁免（或引入 `process_registry` 包装）。

### H2（中）execute.rs 模块级 `#![allow(clippy::disallowed_methods)]` 偏离「函数级 + 理由」要求

host_openers/execute.rs:16 模块级豁免（有理由注释但粒度太粗）——clippy.toml:34 豁免面明文「函数级 allow + 理由」。模块级豁免将覆盖该模块**未来任何新增代码**（新函数若不过门禁也不报警），是 D-04「豁免面蔓延」的直接新案例。同型：process.rs:655 测试 mod 裸 allow 无理由（A-16）。

### M 级发现（纪律缺口，非正确性风险）

- M1：U-06/U-07 两处 unsafe 块无 `// SAFETY:` 注释（全仓其余 unsafe 均有）——GetLocalTime 正确性靠模块头注支撑，应补行内 SAFETY。
- M2：U-11 Sync SAFETY 注释未明示「句柄只读不并发关闭」不变量。
- M3：19 处非禁令面 allow（too_many_arguments ×10 等）全部无理由注释，违反 04 方案原则 3 字面要求。
- M4：dead_code 约 23 处无理由（engine.rs 6 处 + dev_mcp 4 + workspace 4 + 其他 9）。
- M5：perf/fs.rs read_chunk 用 mmap 却为测试专用函数（见 §5 可消除）。

---

## 7. 豁免面误用检查

| 检查项 | 结论 |
| :--- | :--- |
| 测试代码用删除豁免 | process.rs:655 测试 mod 裸 `#![allow]` 无理由（A-16，理由缺失但用途合规）；其余测试 mod（agent-provider:454、output_dir.rs:534）合规 |
| 非豁免域用 disallowed API | 未发现：产品面 remove_* 调用点全部在 trash.rs / 已豁免函数内；spawn 调用点全部在豁免清单内（模块级/函数级） |
| 豁免理由与真实用途一致 | 核读 16 处产品面 allow 注释与函数体，一致（轮转类确为自产文件、门禁类确有 gatekeeper 前置、凭据清除确为物理删除） |
| 豁免面蔓延 | 新案例：execute.rs 模块级 allow（H2）；已登记 D-04 未闭环 |

---

## 8. clippy.toml 禁令覆盖完整性

| 面 | 现状 | 缺口 |
| :--- | :--- | :--- |
| fs::remove_file/remove_dir/remove_dir_all | 已禁 | 无（覆盖 std 全部裸删除入口） |
| std/tokio Command::spawn | 已禁 | **output()/status()/exec 未禁**（H1） |
| 危险内存 API（transmute/ptr::read/write/from_raw_parts） | 未禁 | 仓库当前零使用（仅 FFI 内 from_raw_parts，已随 unsafe_code 豁免登记）；不建议禁（属 unsafe_code 面管理） |
| std::process::exit / abort | 未禁 | 零使用；低风险 |
| 网络发布/命令副作用 | 不在 clippy 范畴 | C-23 已登记（门禁兜底） |
| `dbg_macro` / `unimplemented` | workspace 级 deny（Cargo.toml:46-47） | 无 |

核心结论：唯一实质缺口是 spawn 等价变形 output()/status()；其余危险面当前零存量，不建议扩大禁令（保持最小禁令面，与 clippy.toml 文件头职责边界一致）。

---

## 9. 总评

**整体状况：良好，无正确性级缺陷。**

- unsafe 面（36 块 + 2 impl）全部为「Windows/Unix 平台能力 FFI + 内存擦除 + mmap」三类，无不必要 unsafe；句柄管理、错误处理、指针生命周期、结构体布局逐处核读无缺陷；SAFETY 注释覆盖率达 94%（34/36），缺失的 2 处（GetLocalTime 双实现）正确性不构成风险，属注释纪律问题。
- 豁免面（23 unsafe_code + 18 disallowed_methods）与 clippy.toml 豁免面高度吻合，16 处产品面 allow 理由全部充分且与用途一致；测试面与模块级豁免存在 2 处形式/理由瑕疵（A-16/A-17）。
- 真正值得行动的三件事：**① 堵住 output()/status() 等价拉起缺口（H1，禁令扩展 + 灰区原语显式登记）；② 消除 perf/fs.rs mmap 与 GetLocalTime 双实现（可消除 unsafe 2 处）；③ 补注释纪律（M1~M4，约 42 处 allow/unsafe 缺理由或 SAFETY）**。
- 本审计全部发现未改动任何代码，不 commit。

---

## 10. 回报摘要

- **unsafe 总数**：36 块 + 2 unsafe impl（8 文件；SAFETY 缺失 2、注释不完整 2）
- **allow 总数**：≈142（unsafe_code 23 / disallowed_methods 18 / dead_code 78 / too_many_arguments 10 / unused_imports 4 / 其他 9）
- **高危发现**：2（H1 spawn 禁令 output()/status() 绕过面；H2 execute.rs 模块级豁免偏离函数级要求）
- **可消除项**：2（perf/fs.rs mmap 直接消除；GetLocalTime 双实现合并结构性消除）——另有约 20+ 处 dead_code 随接线轮自动消除（已登记项）
- **文档路径**：docs/feature-gap-analysis/audit/A7-unsafe与allow专项审计.md
