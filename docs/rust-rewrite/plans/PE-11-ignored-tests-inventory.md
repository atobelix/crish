# PE-11 · Rust `#[ignore]` 测试清单（慢层 rust-stress 选择口径）

> 适用范围：`.github/workflows/ci-slow.yml` 的 `rust-stress` job。
> 审计要求（`docs/fix-campaign-20261020/01-反作弊与反偷懒执行铁律.md` RUN-13、账本 T-DEBT-16）：
> 不进 CI 的 `#[ignore]` 必须写清所需环境与不能进 CI 的理由。
> 盘点口径：2026-10-21，`crates/` 与 `apps/` 下全部 `#[ignore]` 属性，共 32 个。

## 1. rust-stress 运行什么

```text
cargo test --workspace --release --locked --test 'stress_*' -- --ignored
cargo test -p crish-agent-workbench --release --locked --lib -- --ignored stress_
```

- 第一条只选 `tests/stress_*.rs` 集成测试目标，并只运行其中标了 `#[ignore]` 的压力用例。
  目标被误删或改名时 cargo 报 `no test target matches pattern`，直接判红。
- 第二条补跑事件桥吞吐场景（T11.6.3）。它实现在 crish-agent-workbench 的 lib 内
  （`src/buffer.rs` 的 `stress_tests` 模块），不是 `tests/stress_*.rs` 目标，第一条选不到。
- `stress_*` 目标里没有标 `#[ignore]` 的普通用例（orchestrator 的
  `stress_concurrent_runs`、`stress_empirical_concurrency` 共 7 个）不在本 job 跑，
  由中层 `cargo test --workspace --locked`（ci-mid.yml）覆盖。

## 2. 慢层会运行的 `#[ignore]`（9 个）

| crate | 位置 | 用例 |
|---|---|---|
| conex-db | `tests/stress_write.rs` | `stress_append_5000_events_timing_and_integrity`、`stress_wal_concurrent_appends_and_upserts`、`stress_write_amplification_report` |
| session-loop | `tests/stress_long_session.rs` | `stress_long_session_100_messages`、`stress_long_session_1000_messages`、`stress_long_session_5000_report_mode`、`stress_long_session_multi_run_continuation` |
| crish-agent-workbench | `src/buffer.rs`（lib，`buffer::stress_tests`） | `stress_high_watermark_flood_drops_only_delta_and_keeps_terminal`、`stress_delta_flood_across_flush_cycles_keeps_terminal` |

这 9 个都是纯进程内场景（临时 SQLite 库、faux provider、内存缓冲），不依赖外部环境。

## 3. 不进 CI 的 `#[ignore]`（23 个）

这些都是「真实环境探针」或「测量脚手架」，不是回归门禁。

| # | crate | 位置 | 用例 | 需要的环境 | 为什么不能进 CI |
|---|---|---|---|---|---|
| 1 | conex-browser | `tests/e2e_browser.rs` | 14 个：`e2e_launch_and_connect`、`e2e_navigate_and_snapshot`、`e2e_click_and_type`、`e2e_version_advance_on_action`、`e2e_clean_stop`、`e2e_frame_stream_end_to_end`、`e2e_input_injection_frame_change`、`e2e_ime_insert_text_chinese`、`e2e_snapshot_action_frame_linkage`、`e2e_evaluate_whitelist_and_lexical_reject`、`e2e_evaluate_isolation_and_budget`、`e2e_evaluate_snapshot_action_linkage`、`e2e_ascii_no_double_write`、`e2e_large_table_payload_budget` | 本机真实 Chrome 或 Edge（CfT 缓存 → 系统 Chrome → 系统 Edge 回退链）、图形会话；必须 `--test-threads=1` 串行 | 探测不到浏览器时，每个用例打印 `[SKIP]` 后按通过结束。放进无浏览器、无 DISPLAY 的 ubuntu runner 只会得到「静默绿」，没有任何信号。要真正进 CI，需要专门的 job 提供 xvfb-run 和锁定版本的 chromium（32 评审 §四），目前没有这个 job |
| 2 | conex-browser | `src/cdp/sender.rs`（lib 单测） | `cdp::sender::tests::real_chrome_attach_proxy_intercepts_like_mcp` | 真实 Chrome（`CONEX_TEST_CHROME` 或系统安装路径），测试会拉起受管实例并直连本地 CDP 端口 | 39-E3 的真实验证探针。依赖宿主上的浏览器安装和版本，没有 SKIP 守卫，环境缺失就红，红了也不代表代码回归 |
| 3 | conex-browser-tools | `tests/mcp_attach.rs` | `probe_windows_npx_spawn_behavior` | PATH 上有 npx | 环境探针。它断言的是宿主事实（Windows 上直接 spawn `npx` 会失败，必须 `cmd /c`），用来给接线点留证据，不是产品行为。结果取决于宿主 Node 的安装方式 |
| 4 | conex-browser-tools | `tests/mcp_attach.rs` | `mcp_attach_readonly_flow` | Chrome + npx + 外网（`npx -y chrome-devtools-mcp` 现场拉取第三方包） | 不密闭：依赖网络，也依赖 npm 上未锁版本的外部包。外部包一升级就可能变红，和本仓库代码无关，结果不可复现 |
| 5 | conex-computer | `tests/smoke.rs`（`#[cfg(windows)]`） | `smoke_capture_once`、`smoke_coord_roundtrip`、`smoke_session_probe` | Windows 交互式桌面会话（真实截屏、坐标换算、会话门面初始化） | 读的是真实屏幕和显示器状态，结果取决于宿主。Linux 上这些用例被 cfg 掉、不参与编译；GitHub 的 Windows runner 不保证有可用的交互式桌面 |
| 6 | conex-computer | `tests/perception_source.rs`（`#[cfg(windows)]`） | `live_notepad_uia_snapshot` | Windows 交互式桌面 + 记事本 + UIA | 要启动真实记事本并读取它的 UIA 树，原因同上。该文件里其余基于 fixture 的用例没有标 ignore，已在常规 CI 中运行 |
| 7 | conex-computer-tools | `tests/real_desktop.rs`（`#[cfg(windows)]`） | `real_desktop_full_chain` | Windows 交互式桌面 + `notepad.exe`；运行期间不能动鼠标和键盘 | 会真实注入输入（移动光标、键入）。在共享或无人值守的 runner 上不可控，既会干扰别人，也会被别人干扰 |
| 8 | conex-doc-collab | `tests/perf_open_nk_blocks.rs` | `perf_open_nk_blocks` | 无特殊依赖；需要 release 构建，可用 `PERF_N` / `PERF_ITERS` / `PERF_WARMUP` 调参 | 这是测量脚手架，不是门禁：只做结构正确性断言并输出 JSON，不与基线比较、不判 pass/fail。H3 / A-PERF-DEG-01 已裁定「CI 默认不跑」，结果要人工回填 `docs/block-workspace-architecture/plans/acceptance/perf-baseline.md`。要进 CI，得先标定数值门（需用户或架构裁决） |

本地运行命令：

```text
cargo test -p conex-browser --test e2e_browser -- --ignored --test-threads=1
cargo test -p conex-browser --lib cdp::sender::tests::real_chrome_attach_proxy_intercepts_like_mcp -- --ignored --nocapture
cargo test -p conex-browser-tools --test mcp_attach -- --ignored --nocapture
cargo test -p conex-computer --test smoke -- --ignored --nocapture
cargo test -p conex-computer --test perception_source -- --ignored --nocapture
cargo test -p conex-computer-tools --test real_desktop -- --ignored --nocapture
cargo test -p conex-doc-collab --test perf_open_nk_blocks --release -- --ignored --nocapture
```

## 4. 复核与维护

- 复核：`rg -c '^\s*#\[ignore' -g '*.rs' crates apps`，各文件计数之和应为 32，
  并且等于本文 §2 + §3（9 + 23）。数字对不上，说明有新增或删除的 `#[ignore]` 没登记。
- 新增 `#[ignore]` 压力场景：放进 `tests/stress_*.rs`，会被慢层自动选中；
  如果放在 lib 内，要同步 rust-stress 的第二条命令，或者迁到 `stress_*` 目标里。
- 新增真实环境探针：在 §3 登记所需环境和不能进 CI 的原因。
- 负责人和期限（RUN-13 要求）：待用户指定。
- 已知残余风险：libtest 在 `--ignored` 加名称过滤后如果一个用例都没匹配到，仍然以 0 退出。
  `stress_*` 目标整体丢失会被 cargo 拦下，但单个用例被删除或去掉 `#[ignore]` 时不会判红，
  只能靠上面的计数复核发现。