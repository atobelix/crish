# 重构方案索引

执行 AI 按本目录的单份方案改代码。本索引只规定顺序、冲突和已经定下来的事。`00-核实结论与系统化整改方案.md` 里的架构、阶段和待决表作废，只能把里面的计数当线索。

编写本索引时，`desktop-auth-ui-into-settings.md` 不在本目录。若后来出现，那是另一条方案，不要覆盖。

## 给执行 AI 的硬性规则

1. 在单独的 git worktree 里做。主仓库 `C:\Software\conex` 有别人未提交的改动。不要在主仓库改方案以外的文件，不要在那里 checkout、stash、reset、commit。本目录的方案文本由规划任务维护，执行任务不要改方案来迁就做不完的步骤。
2. 每个模块的 worktree 与分支以该方案文首的表为准，不要和下面「正在执行」的三条分支共用目录。
3. Rust `1.99.1`。`clippy` 使用 `-D warnings`。Node 24。`CARGO_TARGET_DIR=C:\Users\orange\conex-tgt\<模块>`，`-j 3`。同一时刻只跑一个 cargo。磁盘余量不足 25 GB 就不要开始编译。
4. 测试只在该方案写明的最后一个验证阶段跑。改动阶段不跑全量测试。
5. 提交信息：`refactor(<代号>-P<n>): <摘要> [批次标签]`。不 amend 已经被别的说明引用的提交。不 `git push`。不用 `--no-verify`。
6. 文件 UTF-8 无 BOM。进度写在该 worktree 里、方案规定的 `*.progress.md`，不要写进主仓库。
7. 非必要不兼容：不留别名、垫片、双轨、deprecated 转发。该删就删。
8. 绝对禁止：`git stash`、`reset --hard`、新增 `eslint-disable` / `ts-ignore` / `ts-expect-error` / `#[allow]` / `ignore` / `skip` / `only` / `continue-on-error`。基线只能因删除而下降，而且只能用对应检查脚本自带的 `--update` 生成。不许删断言或测试来让检查通过。不许改守卫脚本或 CI 来放行。
9. 门控是 `git -C C:\Software\conex status --porcelain -- <路径>` 为空。非空就停，不要挑看起来干净的几行硬改。
10. 行号会过期。方案里的函数名和 `rg` 探针为准。开工先重跑该方案的 P0。

## 正在执行，不要重做

这三块不在本目录开新方案。它们占用的文件，其他方案在对应批次合入且 porcelain 为空之前不准改。

| 代号 | 分支 / worktree | 占用 |
|---|---|---|
| SS | `refactor/session-stream`，`rf-session-stream` | 桌面 store 的会话文件、`hooks/chat-stream`、`api/sessionStreamManager`、`runControlClient`、取消链、两份都还活着的 `DeltaWriteBarrier`。不改 Rust crate。`sessionShellKeyMigration` 改到 `bootstrapStores` 是 SS-P6b（D4），MIG 不要做 |
| PL | `refactor/provider-loop`，`rf-provider-loop` | `conex-types` 的 `provider_stream/`、agent-provider 的 events 与 `consume/` 删除、`ReasoningEffort`（默认 Medium，D5）、session-loop 的 stream / aggregate / provider / `testing`、telemetry 的 `cache/` 复刻（TE-01）、agent-tools 里 AbortToken 的父级链接、conex-run 里 engine_provider 的流与协议最小改动。P3–P5 还要等 conex-run 与 src-tauri 干净 |
| SB | `refactor/sandbox-classifier`，`rf-sandbox`；D6 在 `refactor/sandbox-d6` | `conex-sandbox`、session-loop 的 `exec_verdict.rs`、agent-tools 的 `shell.rs`、`shell_redirect.rs`、`revert.rs`、`readonly.rs`。`patterns()` 冻到 SB-P6。W1 不要提前加 `check_launch`。`scripts/check-blocked-executable-ssot.mjs` 编写时在写 |

`I-02`（清单漏了 `workbench_abort_run`）是误报。`commandManifest.ts` 里已有这条。store 绕过 `runControlClient` 直连 `invoke` 仍归 SS。

## 已决事项

以 `C:\Users\orange\conex-review\ROADMAP.md` §9 的 D1–D12 为准（2026-10-29）。这里只列执行时最容易做反的几条：

| 编号 | 结论 |
|---|---|
| D1 | 删除 conversation-flow。CF 方案。MD 不要再删一遍 |
| D2 | 删除 `apps/avatar-studio`。不要在主仓库里手删 gitignore 的 `node_modules` |
| D3 | 出壳为 `conex-hub-server` + `conex-push`，同一进程，不是独立 OS 进程。不改 `conex-relay`，不改 `device-protocol.json` |
| D4 | `sessionShellKeyMigration` 改由 `bootstrapStores` 调用，归 SS |
| D5 | `ReasoningEffort` 默认 Medium，归 PL-P4 |
| D6 | 统一 `check_launch` 并删除 `patterns()`。SB-P6 保持各调用点原有拒绝阈值。TS-P2 再收成「非 Allowed 即拒绝」，不许放宽 |
| D8 | 每个模块自己的 `CARGO_TARGET_DIR`，`-j 3`，测试只在验证阶段 |
| D9 | 测试替身用 feature `test-support` 与模块 `test_support`。生产依赖树不得带上这个 feature |
| D10 | 错误码真源是 `contracts/error-codes.json`，不是 Rust 宏。不要为了生成去改根 `package.json`（在写） |
| D11 | 时间真源是 `conex_shared::time`，API 为 `u64`。不引入 chrono，不做全局 `Clock` trait。`GateClock` 是 `Instant`，不要换掉 |
| D12 | 更新主仓库只在审计之后、与脏文件无交集、并且得到同意时做。只允许快进。本任务本身不提交 |

各方案 §k 里还有本模块的决定（例如未知工具按 Execute、产出目录必须持久化、全树 undo 删除）。那些与 §9 冲突时以 §9 为准，并在 progress 里写偏离。

## 方案清单

| 文件 | 代号 | 一句话 |
|---|---|---|
| `x03-time-utils.md` | TM | 时间只留 `conex_shared::time` 的 `u64` API |
| `x04-error-codes.md` | EC | JSON 生成错误码，分类 match 不放宽 |
| `x05-path-attr-cleanup.md` | MP | 去掉 `#[path]`，移动就按职责拆开 |
| `x06-test-code-in-prod.md` | TD | 测试替身进 `test_support`，不进生产 API |
| `shared-types-contract.md` | ST | 删掉手写的重复契约，事件类型只留一份 |
| `conversation-flow-removal.md` | CF | 按 D1 删除扩展、包和两个零注册槽 |
| `avatar-studio-removal.md` | AV | 按 D2 从 git 删除 `apps/avatar-studio` |
| `hub-server-extract.md` | HS | 按 D3 把多端服务抽成同进程的两个 crate |
| `conex-types.md` | TY | 收拢 `AgentEvent` 与设备协议边界；日历不引入 chrono |
| `conex-compaction.md` | CP | 删旧压缩面和死阈值；摘要字段用字符串数组 |
| `conex-agents.md` | AG | 删零实现端口；能力看声明；未知工具按 Execute |
| `conex-shared-telemetry.md` | SHT | 删 PE02 预留和手写 waker；帧 trait 迁出 shared |
| `agent-provider.md` | AP | 一次迁移、CompatSpec 单一厂商差异；等整 crate 干净 |
| `session-loop-residual.md` | SL | 不合并三种队列；错误码常量替换裸字符串；分类保持 6 臂 |
| `orchestrator.md` | OR | 删空 trait 和 `as_local_db`；解析失败返回错误 |
| `agent-tools.md` | AT | 产出目录持久化；删除未接线的回退计数；删死注入文件 |
| `conex-run.md` | RN | 等整 crate 干净后删占位、拆运行状态；不重做 PL/TD/TM |
| `conex-db.md` | DB | 单写单读；缺表即打开失败；配额 trait 下沉 |
| `conex-workspace-store.md` | WS | 镜像改走 `conex-fs` 原子写；删别名模块 |
| `conex-doc-collab.md` | DC | 只留 `text_undo` 和真实 CRDT 更新 |
| `conex-fs.md` | FS | 只留一处 `strip_verbatim`；窗口读不留旧计数 |
| `conex-note-runtime.md` | NR | 删除本地 kind 表；锁不跨 await |
| `conex-relay.md` | REL | 补 workspace lint；保持盲转发，不与 HS 合并 |
| `tauri-shell.md` | TS | 壳的 B–L。E1 只追加危险后缀。A 组归 HS |
| `markdown-pipeline.md` | MD | 聊天 HTML 改吃 md-ast，删除 pulldown；去掉 33ms 轮询 |
| `desktop-messages-ui.md` | MSG | 消息不再读全局 `activeSessionId`；展开键与订阅键对齐 |
| `desktop-ui-components.md` | UI | 删垫片。新原语待采用，不因为 0 业务引用而删 |
| `desktop-i18n.md` | I18N | 去掉 `t` 的中文回退。P4 之前不得合并 |
| `desktop-ipc-api.md` | IPC | 只留 `ipc.call`。清单从 Rust 生成。I-02 是误报 |
| `desktop-startup-migrations.md` | MIG | 启动迁移进一张注册表。shell key 归 SS |
| `build-scripts-ci.md` | BLD | 包边界与基线机器可读。不改 CF/AV 的删除范围 |
| `crish-mobile.md` | MB | 配对与连接各留一条。整目录在写，现在不要改 |

没有单独方案、也不要另开文件的：`conex-search`（审查分低，无 P0）、`conex-test-utils`（本来就是测试 crate）、`mcps/`。`conex-diff` 不单开方案；壳里重复的纯函数由 TS 并入它，不要并行再写一份 diff 方案。

## 推荐顺序

不要从门控未满足的模块开工。下面是门控打开之后的次序。

1. 让 SS、PL、SB 先合入它们已经写明的阶段。W3 才做 PL-P3–P5 与 SB-P6。
2. W4，能并行的见下一节：TM、EC、MP、TD、ST、AV、CF。CF 还要等 G-CF（`package.json`、lock、桌面 `package.json`、`vite.config`、i18n 干净）并且 SS 已合入。AV 只在 `apps/avatar-studio` 的 porcelain 为空时做。
3. HS 在 W3 集成之后、src-tauri 为空、并且满足方案里的 72 小时条件时做。TS 在 HS 与 SB-P6 之后。
4. 工具与运行时：AT-P1（不碰 SB 的五个文件）可以早做。AT-P2 等 SB 与 EC。AT-P3 等 PL，并且 `conex-run` 与 `loop_runner.rs` 干净。AT-P4 等 MP-P2，再做 NR。RN 等 G-RN，并且排在 TD-P4、TM-P4、MP-P4、AT-P3、CP 之后。OR-P2/P3 等 TD 与 RN-P2。SL 等 PL；改 `exec_verdict.rs` 还要等 SB。AP 等整 crate 干净（PL 合入）。
5. 数据：FS 稳定 `atomic_write` 之后 WS。DC 的撤销可以在 MP-P1 之后。DB 等 `conex-db` 干净。REL 只要本 crate 干净，不挡 HS。
6. 桌面：CF 之后 MD，再 MSG（MSG-P1 改 `MessageContent`）。UI 等 SS 合入且 `components/ui` 为空。I18N 先做不与 MSG/MD/UI 重叠的文件，重叠文件等它们合入；分支在 I18N-P4 之前不要合并。IPC 等 SS。MIG 等 CF（`entry-core.tsx`）和 SS（`session-persistence`）。TS-P4 与 IPC 共用一个命令清单生成脚本，谁先合入谁建脚本，后做的只扩展它。
7. BLD 等根 `package.json`、lock、桌面 `package.json`、`vite.config`、相关脚本干净。它不删除 conversation-flow，也不收编 avatar-studio。MB 等 `apps/crish-mobile` 为空，并且不要和 BLD 同时改根 `package.json`。

## 可并行，以及会改同一批文件的冲突

可以并行（文件不相交，且各自门控为空）：

- AV 与 REL 与 FS（FS 不改 relay，REL 不改 fs）
- AG-P1 与 SHT-P1，只要 AG 还没改中心码表、SHT 不改 `time.rs`
- TM 的非 orchestrator 文件与 EC 的非 shared-types 导出，在下面的串行点之外

必须串行：

| 冲突 | 先做 | 原因 |
|---|---|---|
| EC 与 ST | EC 先动 `errors/` 与生成物 | ST 不准编辑生成文件和错误码文件 |
| EC 与 AG-P1 | 同一时期只有一方改码表 | AG 只补字符串，不写第二套生成器 |
| TD 与 MP 在 `tool_exec.rs` | TD 先拿掉 dead_code allow | MP 再拆文件，不要把 allow 搬走 |
| TM、TD、MP、OR 在 orchestrator | 按 TM 时间函数、TD 测试钩子、MP 布局、OR 行为的顺序合入 | 不同文件也要串行合并，避免互相回滚 |
| CF 与 ST | 谁先就绪谁先合，另一条基于结果 | 都改桌面 |
| CF 与 MD、MSG | CF | 都碰 `MessageContent` 或 thinking |
| SS 与 MD、IPC、UI、MIG | SS | store、markdown API、取消链、`components/ui` 的在写约定 |
| SB 与 AT-P2、AG-P2、SL 的 `exec_verdict.rs`、TS-P2 | SB，然后 SB-P6 | shell 与打开文件的门禁 |
| PL 与 AP、SL、RN、AT-P3 | PL | 流、consume、conex-run |
| MP-P1 与 DC、NR | MP | `session.rs`、`store_plan_ops.rs` |
| MP-P4 与 WS、RN | MP | workspace-store 与 `protocol.rs` 的布局 |
| AT-P4 与 NR | AT | 笔记类型迁入 note-runtime |
| FS 与 WS | FS 先稳定原子写签名 | WS 删手写拷贝 |
| DC 与 NR、WS | DC 定 flavour | 另外两份删本地表 |
| HS 与 TS、以及 EC/TM/MP 在壳里的尾巴 | HS | A 组目录会搬走 |
| IPC 与 TS-P4 | 一个生成脚本 | 不要两套 manifest 生成器 |
| BLD 与 CF、SHT、MB | CF 不归 BLD；PE02 脚本归 SHT；根 package.json 只许一个批次改 | |
| RN-P2 与 OR-P3 | RN 先拆状态 | OR 只改 `as_local_db` 调用点 |
| I18N 与 MSG、MD、UI | 后改被拆过的组件 | I18N-P4 删签名之前不要合并 |

## 开工前再看一眼

- 门控命令的输出贴进 progress，为空才改。
- 方案 §b 里标成「归别人」的条目不要重做。
- 发现方案与代码不符：停，在 progress 写证据。不要一边改方案一边改出第三种行为。
- 用户能看见的行为如果方案没写死，停，记 D13，不要猜。
