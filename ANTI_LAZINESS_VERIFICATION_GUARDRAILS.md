# Conex / Crish — 反偷懒反作弊与强制验证铁律

# (Anti-Laziness, Anti-Cheating & Mandatory Verification Guardrails)

> **生效日期**：2026-08-14（红队审计与警告治理强化完整版）
> **适用对象**：所有在仓库中执行分析、设计、编码、重构与提交的主控与子 Agent。
> **核心原则**：**零伪完成、零空占位、零作弊逃逸、确凿日志证据、警告根治零压制、只增不减、测试资产神圣不可侵犯。**

---

## 一、 零容忍作弊与偷懒红线（Zero-Tolerance Cheating Redlines）

以下行为一经发现，直接判定任务失败并触发状态重置与回滚：

| 违规行为                                                 | 详细定义与定性（零容忍）                                                                                                                       | 防御与审计对策                                                                                  |
| :------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
| **空占位与伪实现 (Hollow Placeholders)**                 | 在流式、状态机或异步回调中写入 `() => {}`、`todo!()` 或留空占位，假装完成接口对接。                                                            | 必须接入真实业务流转与完整测试断言，严禁空函数占位。                                            |
| **类型逃逸与二次强转 (Double Cast Evasion)**             | 在生产代码中使用 `as unknown as T`、`as any`、`@ts-ignore` 强行抹平类型错误。                                                                  | 必须编写严格类型适配器或收敛契约，生产代码禁止二次强转。                                        |
| **警告压制与注水 (Warning Suppression)**                 | 通过大面积添加 `#[allow(unused)]`、`#[allow(dead_code)]`、`/* eslint-disable */` 或无意义假调用消除警告。                                      | 必须从根源清理无用代码或修复引用，禁止以压制掩盖隐患。                                          |
| **伪完成与假日志 (Pseudo-Completion & Log Faking)**      | 未运行命令即在汇报中捏造手写假日志；或仅改动少许代码即空口宣称「已全部修复/编译通过」。                                                        | 必须提供包含真实命令输入行、执行耗时与完整退出码（Exit Code 0）的终端日志证据。                 |
| **测试跳过与软性逃逸 (Test Skipping & Soft Evasion)**    | 使用 `#[ignore]`（Rust）、`it.skip` / `test.skip` / `xit` / `test.todo`（Vitest/Jest）绕过失败用例。                                           | 测试运行报告中 `ignored` / `skipped` 数量必须为 0（除非仓库既有已登记基线），严禁新增跳过标记。 |
| **测试篡改与弱断言注水 (Assertion Dilution & Sabotage)** | 注释断言、`assert!(true)`、仅调用函数无断言、或仅 `expect(x).toBeDefined()` 替代深层业务校验。                                                 | 强制要求**有效语义断言（Semantic Assertiveness）**，必须校验字段值、状态变更与内容相等性。      |
| **配置软降级作弊 (Config Soft-Tampering)**               | 擅自修改 `tsconfig*.json`、`Cargo.toml`（lints/profile）、`eslint*`、`vitest.config.*`、`scripts/check-line-counts.mjs` 等门禁规则以消除警告。 | 编译器与门禁配置文件纳入不可篡改红线；任何配置变动在审计时一票否决。                            |
| **门禁绕过 (Bypass via Flags)**                          | 使用 `--no-verify`、`git commit -n` 跳过 Git 钩子。                                                                                            | 仓库钩子全量拦截；发现 `--no-verify` 提交立即回滚并要求根除报错。                               |
| **测试资产删除 (Asset Deletion)**                        | 擅自删除 `tests/`、`reference/` 下的任何历史测试用例或 Spec 文件。                                                                             | 严格执行「测试资产保护铁律」，删除存量测试直接判定为系统破坏行为。                              |
| **Mock 沙箱伪装验收 (Mock Impersonation)**               | 在隔离的假数据/Mock 会话上截图或测试，伪装真机 WebView2 验收通过。                                                                             | UI 与 IPC 验收必须针对真实的 `http://127.0.0.1:9222` WebView2 与真实 SQLite DB。                |
| **任务缩水与偷工减料 (Scope Shrinking)**                 | 因超时或复杂，擅自将方案中的要求砍成「简化版/MVP 版/后续再做」。                                                                               | 严格执行《反退避全文》效果锁（Effect Lock），任务范围无权自行降级。                             |

---

## 二、 异步命令等待与计时器使用铁律（Reactive Execution & Timer Guardrails）

1. **响应式等待（Reactive Wakeup）**：
   - 运行长耗时命令（`cargo check`、`cargo test`、`npm run typecheck`）时，命令进入后台后**严禁主动发起轮询循环**；
   - 必须停止调用工具（Stop calling tools），等待系统在后台任务结束时自动发送完成通知并注入日志。
2. **计时器门槛（Timer Duration $\ge 100\text{s}$）**：
   - 严禁设置 $< 100$ 秒的短周期计时器；如果确实需要设置定时器，最短时长必须 $\ge 100$ 秒（`DurationSeconds >= 100`）；
   - 严禁通过计时器代替命令的正常等待。

---

## 三、 强制六级验证矩阵（Mandatory Six-Tier Verification Pipeline）

任何代码修改在声称完成或提交前，**必须自底向上完整跑通以下验证流水线**，必须见确凿绿灯输出：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Level 0: 代码生成与契约一致性验证                                                     │
│ 命令：npm run gen:engine-bindings                                                     │
│ 要求：生成的 TS 绑定与 Rust 结构体 100% 同步，0 处类型漂移。                           │
├────────────────────────────────────────┬───────────────────────────────────────────────┤
│ Level 1: 前端与共享包全量类型检查                                                     │
│ 命令：npm run typecheck                                                                │
│ 要求：apps/crish-desktop、packages/* 所有 tsconfig 项目 0 报错、0 警告。              │
├────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Level 2: Rust 核心内核与宿主编译检查                                                   │
│ 命令：cargo check --workspace --all-targets                                            │
│ 要求：23 个 Crates + src-tauri 全部编译通过，0 Errors，警告最小化。                  │
├────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Level 3: 静态代码规范与行数门禁                                                       │
│ 命令：npm run lint && npm run check:desktop                                            │
│ 要求：ESLint 0 错误；check-line-counts 0 处超标（UI≤500, 逻辑≤400, 契约≤800）。         │
├────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Level 4: 专项与模块级单元/集成测试                                                    │
│ 命令：npm run test / cargo test -p <crate_name>                                        │
│ 要求：必须针对整个 crate 或 spec 文件运行（严禁通过用例 filter 冒充全量），100% 通过。 │
├────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Level 5: 全量破坏性与端到端测试                                                       │
│ 命令：npm run test:e2e:smoke / npm run stress / cargo test --workspace                │
│ 要求：全量集成测试无回归，关键链路（编排、CRDT、沙箱、多端）通过。                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 四、 审计痕迹与汇报证据规范（Verifiable Proof Standards）

### 1. 代码修改定位证据

必须给出精确的 GitHub 风格 Markdown 链接与行号范围：

- `[session.rs:120-145](file:///c:/Software/conex/crates/orchestrator/src/session.rs#L120-L145)`
- 说明修改前缺陷机制与修改后修复逻辑。

### 2. 真实命令执行日志与指纹核验

必须附带真实的终端执行完整片段，包含输入命令、耗时、通过断言数与结果汇总行：

```bash
$ cargo test -p conex-doc-collab
running 14 tests
test tests::a_col_01_dual_peer_eventual_consistency ... ok
...
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### 3. 空返回重试分流与熔断纪律

若子 Agent 在执行过程中发生空返回（无最终汇报文本）：

1. **瞬态网络空返回**：保持原提示词完整长度，原样重新派发；
2. **确定性错误空返回**（Panic、语法崩溃或 OOM）：**立即熔断**，由主控分析崩溃特征进行任务拆分或直接接管；
3. 重派累计超过 **6 次**必须由主控介入接管。

---

## 五、 多 Agent 并行 Git 提交铁律（Concurrent Git Protocol）

1. **新建文件与限定路径提交**：对于 Untracked 新建文件，必须先 `git add <path>` 加入索引，随后使用 `git commit --only <paths...>` 精确限定提交范围；提交后执行 `git status --porcelain` 确认无多余脏文件。
2. **绝对严禁回撤破坏**：严禁执行 `git reset --hard`、`git checkout .`、`git restore` 等全局回撤指令。
3. **被吞并处理（测试真验证）**：若改动已被并行提交收拢，必须在本地追加运行对应的测试/编译检查，确认功能实际绿灯后方可标记完成。
4. **门禁阻断自愈**：若提交时因他人 whitespace 触发钩子拦截，执行最小 whitespace 修复解除阻断，绝不使用 `--no-verify`。
