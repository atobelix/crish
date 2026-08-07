# 代码严苛审计 —— 修复计划（2026-08）

> 审计方式：Round 1 十个分区审计（F1-F10，行号级证据）+ Round 2 三组独立复核（R1 安全 / R2 数据 / R3 CI，实跑与推演验证）。
> 统计：P0×4（全部复核确认）、P1×28（抽查全部确认）、P2×90+；1 项 F10 误判已纠正（bench 空转为假，5 个 criterion 基准真实存在）。
> 各分区报告：docs/organization/audit/F1~~F10.md、R1~~R3.md。

---

## 一、P0 —— 必须立即修（4 项）

### P0-1 命令红线绕过链（安全，最严重）

- **发现**：F9-01 / F3-01，R1 实测 8/8 形态可绕过（`echo "$(rm -rf -- /)"`、反引号、`printf x\n/bin/rm -rf -- /`、PowerShell `iex`/`-EncodedCommand`/`Write-Output x\nri C:\ -Recurse -Force` 全部 Allowed）
- **根因**：① 语句切分不认 `\n`（只拆 `;&&|||`，semantics.rs:147-198）；② 命令替换 `$()`/反引号不展开递归，只看首 token 命令名；③ 静态正则被 `--` 阻断；④ PowerShell 子解析缺失
- **影响**：任意权限模式（含 full-access）无审批执行破坏性命令（Unix 删非 `/` 目标、Windows 删盘）
- **修复**：① 切分补 `\n` 与管道链展开；② `$()`/反引号/`iex`/`-EncodedCommand` 识别并 Blocked（或递归解析内层）；③ 正则补 `--` 后参数语义；④ PowerShell 增加 token 级子解析
- **验证**：R1 的 8/8 测试形态全 Blocked + 回归 40 个既有门禁用例

### P0-2 ci-mid test job 必红（CI 失效）

- **发现**：F10-01，R3 实跑 `--project e2e` 21/21 失败（Playwright spec 被 vitest e2e 项目收集，`test.describe` 冲突）
- **修复**：vitest.workspace.ts 的 e2e 项目排除 `tests/e2e/**`（Playwright 归 Playwright 跑）；或 ci-mid 拆开 vitest 与 playwright
- **验证**：ci-mid test job EXIT=0

### P0-3 test:integration 启动即崩（CI 失效）

- **发现**：F10-02，R3 实跑 Startup Error（vitest.workspace.ts:11 stub `export {}` 非 default array）
- **修复**：workspace 配置改为正确 default export（数组 of project config），或删除 stub 项目
- **验证**：test:integration job EXIT=0

### P0-4 tests/stress 零生产代码（形同虚设）

- **发现**：F10-03，R3 确认三个场景仅 Node 内置 + 自引用，任何回归都无法变红
- **修复**：重写三个场景为真实调用生产模块（对应 crates/前端核心路径）；或删除并声明"由 crates 压力测试接管"
- **验证**：注入一个故意 bug 能变红

---

## 二、P1 —— 高优修复（28 项，按域分组）

### 安全组（6 项，P0-1 之后）

| #     | 问题                                                              | 位置                                                       | 复核            |
| ----- | ----------------------------------------------------------------- | ---------------------------------------------------------- | --------------- |
| P1-S1 | safe_canonicalize 写路径 symlink 父目录逃逸                       | conex-fs lib.rs:53-69 + agent-tools resolve_workspace_path | R1 确认（推演） |
| P1-S2 | fs_commands resolve_for_write dangling symlink 跟随               | fs_commands/types.rs:164-212、write.rs:38-48               | R1 确认         |
| P1-S3 | conex-search Unicode 折叠回查越界 panic（`İ` 实测 panic）         | conex-search lib.rs:68                                     | R1 实测         |
| P1-S4 | git push refspec 零约束（`+refspec` 强制/`:refs/heads/x` 删远端） | git.rs:121-123,381-389                                     | R1 确认         |
| P1-S5 | host_openers `cmd /C start "" <target>` `&` 注入                  | host_openers/execute.rs:267-268                            | R1 确认         |
| P1-S6 | 会话产出目录相对路径无工作区校验（删会话可 trash 工作区外）       | outputs_config.rs:340-342                                  | R1 确认         |

### 数据一致性组（8 项）

| #     | 问题                                                                     | 位置                                    | 复核                       |
| ----- | ------------------------------------------------------------------------ | --------------------------------------- | -------------------------- |
| P1-D1 | 迁移 v3→v4 ADD COLUMN 非幂等，崩溃重跑库不可打开                         | conex-db migrate.rs:188-191/350         | R2 确认（最高优先）        |
| P1-D2 | 懒水合单页 800 截断 + hasMore 无消费 + 截断态固化回写 SQLite（不可逆）   | sessionEventHydrate.ts:411-442          | R2 确认                    |
| P1-D3 | 孤儿清理不查 in-flight（touch_session 生产零调用，运行中会话可被级联删） | conex-db sessions.rs:204-231            | R2 确认（比原报告更弱）    |
| P1-D4 | flow_graph spawn 后持久化后置，崩溃重启孤儿双跑                          | flow_graph.rs:1020-1130                 | R2 确认                    |
| P1-D5 | 快照三触发无互斥，同 tmp 文件交叉写损坏                                  | core_run_commands.rs:1782-1829          | R2 确认                    |
| P1-D6 | 前端写竞态被测试固化为契约（旧批次覆盖新批次）                           | sessionRustDb.ts:890-955 + test:278-308 | R2 确认                    |
| P1-D7 | 生成 parser 递归无深度上限，深层载荷栈溢出                               | generated parser.ts:56-80               | R2 确认（V8 上限内仍可溢） |
| P1-D8 | StreamingFileReader 跨块 UTF-8 半字符损坏（U+FFFD）                      | streaming-file-reader.ts:95/122         | R2 确认                    |

### 会话循环组（2 项）

| #     | 问题                                                                       | 位置                      |
| ----- | -------------------------------------------------------------------------- | ------------------------- |
| P1-L1 | 无 recovery_hook 时 Skip 静默降级（streaming 态错误吞成 stop，与注释相反） | loop/mod.rs:722,773-777   |
| P1-L2 | 批级审批 `request_approval` 裸挂起无超时/无 abort（run 悬挂）              | tool_exec.rs:598/357/1140 |

### 壳/引擎组（3 项）

| #     | 问题                                                             | 位置                     |
| ----- | ---------------------------------------------------------------- | ------------------------ |
| P1-W1 | config_profile_apply 后 provider 不重载（换 key/模型仍用旧凭据） | engine.rs:927-945        |
| P1-W2 | core_rebuild_search_index 任意 root 绕沙箱                       | core_commands.rs:161-187 |
| P1-W3 | 5 个已注册命令非 CoreError 错误协议                              | 壳命令面                 |

### 前端组（5 项）

| #     | 问题                                                               | 位置                           |
| ----- | ------------------------------------------------------------------ | ------------------------------ |
| P1-F1 | invoke 失败静默降级 LS 无日志（分叉后 hydrate 旧数据）             | sessionRustDb.ts:619-640       |
| P1-F2 | 取消竞态（waitUntilConnected 挂起期间 stop，run 仍启动且 L3 失效） | ConnectionLifecycle.ts:307-325 |
| P1-F3 | quota 超限静默截断最后 100 条                                      | sessionLocalStorage.ts:94-104  |
| P1-F4 | ComposePlusMenu display:none 锚点 → 菜单定位视口 (0,0)             | ComposePlusMenu                |
| P1-F5 | usePointerDragBase 无 pointer capture 兜底（移出释放拖拽悬挂）     | usePointerDragBase             |

### CI/门禁组（4 项）

| #     | 问题                                                                    |
| ----- | ----------------------------------------------------------------------- |
| P1-C1 | e2e 仅 nightly（合并前零 e2e 断言）——提升到 PR 门禁                     |
| P1-C2 | coverage 双口径（root 45-70 档 vs app-dir 70 档 enabled）不可调和——统一 |
| P1-C3 | --locked 仅 1/7 的 cargo 命令使用——全量补                               |
| P1-C4 | knip/check:ui-layer 未接线 CI；knip 实跑 EXIT=1（594 warn 需先清）      |

---

## 三、P2 —— 常规修复（90+ 项，按域归档）

- **数值/边界**（~15）：u32 溢出（turn_index/max_tokens×2）、max_turns=0、RingBuffer 容量、Retry-After 溢出、SSE 无界内存
- **死代码/未接线**（~20）：StreamRenderBuffer 拆帧死代码、C7 阶梯未接线、deadlock 检测器未接线、knip 594 导出、tool-calls.css 等死 CSS
- **交互/UI**（~15）：嵌套 Dialog Esc 双关、a11y 缺失、Tooltip 键盘不可达、z-index 残留、暗色缺失
- **协议/类型**（~10）：ProviderErrorKind 名集陈旧、AgentEndReason 缺 stopped、approval-resolved 语义错位、tool.write_path_conflict 漏码
- **性能**（~10）：streaming 每 token O(n) 扫描、JsonlAppendBatcher 静默吞数据、tokenUsage 并发丢增量
- **测试**（~15）：flaky 断言、跳过项、盲区用例补全（对应 P0/P1 每项补红绿用例）

---

## 四、修复顺序与验证

1. **P0 四连**（安全红线 → CI 中层复活 ×2 → stress 重写）——每项独立提交，红绿测试
2. **P1 安全组 S1-S6**（含 R1 的 8/8 形态回归）
3. **P1 数据组 D1-D8**（D1 库不可开 → D6 写竞态 → D3 静默删数据 → D4/D5 并发 → D2/D7/D8）
4. **P1 其余组**（L/W/F/C）
5. **P2 分批**（先死代码/未接线，再边界，再 UI/类型）
6. 每批完成：`cargo test --workspace` + 前端 `tsc` + 相关 vitest + 门禁脚本；CI 三层实跑绿

## 五、结论

- 内核工程质量高：状态机/错误体系/契约治理未发现 P0
- **真问题集中在"边角"**：命令门禁的命令替换/换行绕过（唯一安全 P0）、数据持久化的崩溃窗口与写竞态、CI 中层的两处必红、测试的假阳性保护（stress 空转）

---

## 六、R3 纠偏注记（2026-08-07，PS-02 任务书登记）

- **F10-07（bench 空转）为误判**：`crates/*/benches` 存在 5 个已入库的 criterion 基准（sse_parse / db_write / event_chain / request_build / tool_batch，2026-08-02~08-05 提交，早于 F10 审计日 08-07），4 个 crate 声明 `criterion = { workspace = true }`；`cargo bench --workspace --no-run` 实跑编译成功 EXIT=0。F10"0 目录 / criterion 无消费者 / 恒 echo"与仓库事实不符。
- **perf-test.yml 存在**（F10 漏扫）：PR + main/refactor push 触发 TS benchmark（run-benchmarks / mem / compare / acceptance）+ stress-test（run-all-stress.ts）全链，"TS bench 未入任何 CI"不成立。
- **PS-02 不改动 bench/perf-test 轨道**（任务书边界；R3 第六节）。
- 复核确认率 100%（21/21 真 + 1 纠偏），无虚报——审计可信
