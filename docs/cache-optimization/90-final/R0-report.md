# 轮次报告：R0（基线建立）

## 轮次元信息

- 轮次：R0
- 本轮 Agent 数：3 / 12（A-R0-1、A-R0-2、A-R0-3，全部只读审计，无代码改动）
- 任务包数：0（R0 为只读基线轮，不占任务单元编号）
- 门禁执行结果：通过（记录基线性质；无代码改动故无回归风险）
- 日期：2026-08-03
- 依据：`docs/cache-optimization/90-final-multi-agent-repair-plan.md` §4.1

## 一、已完成

| 任务包                       | 文件域（只读）                           | 改动摘要                                                                            | 自验证情况                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-R0-1 Rust 门禁基线         | crates/、apps/agent-workbench/src-tauri/ | `cargo test --workspace` 全量运行 + `cargo tree -i serde_json -e features` 特性核实 | 73 套件 / 1398 通过 / 0 失败 / 12 忽略，退出码 0；preserve_order 未开启（cargo tree 仅 default/raw_value/std/alloc/unbounded_depth，schemars 不转发）                                                                                                                                                                |
| A-R0-2 前端门禁基线          | apps/crish-desktop/、packages/           | `npm run typecheck` + `npx vitest run src`                                          | typecheck 全绿（0 错误）；vitest 4655 用例 4524 通过 / 131 失败，**131 失败 100% 为根目录配置性 mass failure（React is not defined，根无 tsconfig.json），应用侧配置下同批全绿**；AGENTS.md 记载的 4 处基线失败（oklchColorGuard/userFacingErrors/sessionRustDbWriteModel/DiffCard.perf）**已全部修复、本次 0 复现** |
| A-R0-3 问题证据复核 + 互斥表 | 全仓（只读）                             | P-01~P-26 逐条实读核实；互斥表三张表                                                | 一致 23 / 漂移 3（P-02/P-06/P-12 行号微偏，关键结论全部成立）/ 不属实 0；互斥表初版完成                                                                                                                                                                                                                              |

产出文档：

- `docs/cache-optimization/90-final/R0-baseline-rust.md`
- `docs/cache-optimization/90-final/R0-baseline-frontend.md`
- `docs/cache-optimization/90-final/R0-baseline-evidence.md`

## 二、门禁基线结论（R1 起各轮对照基准）

1. **Rust**：73 套件全绿是硬基线，R1-R7 各轮不允许新增失败。serde_json preserve_order **未开启**（A2 审计"app 构建经 schemars 开启"记载不成立——schemars-0.8.22 的 preserve_order 只影响其自身，不转发 serde_json），即当前 wire 序列化键序为 BTreeMap 确定性序，P1 的 schema 规范化可建立在"无序漂移风险已排除"的结论上。
2. **typecheck**：全绿硬基线。
3. **vitest**：**门禁命令形态修正**——根目录 `npx vitest run src` 存在配置性 mass failure（131 例 React is not defined），不作为有效基线；有效基线 = 应用侧配置下运行（`apps/crish-desktop` 工作目录内 `npx vitest run` 或显式 `--config`），该形态下基线失败集为 **0**（原 4 处已知失败已修复）。R1 起各轮 vitest 门禁统一采用该形态，另以"根目录运行不得新增非 mass failure"为辅助断言。
4. **问题清单**：P-01~P-26 确认有效（0 项不属实）；实测行号引用以 R0-baseline-evidence.md 为准（P-02 registry.rs:62-68、P-06 loop/mod.rs:311-321、P-12 pricingStore.ts:31-40）。

## 三、发现的问题与主 Agent 裁决

### 3.1 轮内同文件冲突遗漏（R0 互斥表表 2 发现 3 处，主 Agent 裁决如下）

| #   | 轮次 | 文件             | 冲突                                                                                           | 主 Agent 裁决                                                                                                                                                                                        |
| --- | ---- | ---------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | R1   | `request/mod.rs` | T-02（挂 schema 模块+re-export）× T-04（re-export build_system_prompt）同波并行                | **mod.rs 唯一写者 = A2（T-02）**；A4（T-04）只写 build.rs，re-export 需求在轮末汇总物声明，主 Agent 在波间合并                                                                                       |
| D2  | R1   | `loop/mod.rs`    | T-03（with_initial_conversation 附近不变量注释）× T-05（SessionLoopOptions 字段+Default+测试） | **mod.rs 唯一写者 = A5（T-05）**；T-03 对 loop/mod.rs 的注释需求经轮末汇总物声明，主 Agent 在波间合并（T-03 实际主文件为 handlers/mod.rs 与 streaming.rs，注释仅 1 处）                              |
| D3  | R4   | `loop/mod.rs`    | T-33（SessionLoopOptions 扩展）× T-34（compression_retries 归零）                              | **A7（T-33）第三波主写 + A8（T-34）第四波串行追加**（波次天然串行：A7 在第三波、A8 在第四波，主 Agent 在 A7 门禁通过后再放行 A8 的 loop/mod.rs 改动）；A8 第一优先写 stream_error.rs 与 orchestrator |

### 3.2 措辞与登记缺口

- R3 `models/mod.rs` 三写裁决措辞补 A2（T-19 也写 mod.rs）——处置逻辑（A1 独占+导出合并）不变，已在派单时明确。
- `crates/session-loop/src/stream.rs` 跨轮串行（T-16 R2 → T-33 R4）登记缺口——轮次天然串行，补登记，无动作。

### 3.3 其他基线事实（供后续轮次参考）

- 工作区存在历史遗留未提交改动（approval 相关：approvalHandlers.ts / middleware.rs / turn_complete.rs / tool_exec.rs 等），**不属于本方案**，各轮 Agent 禁止触碰；R0 已完成文档提交 `d30fcf30`，后续每轮产物随轮提交。
- 行号引用统一以 R0-baseline-evidence.md 实测值为准。

## 四、输出为下一轮输入（R1）

- 问题清单确认版：P-01~~P-26（含实测行号）→ R1 解决 P-02~~P-06（T-01~T-09）。
- 门禁基线：Rust 73 套件全绿 / typecheck 全绿 / vitest 应用侧配置 0 失败。
- 互斥表初版 + 裁决 D1/D2/D3 → R1 派单按裁决执行。
- R1 派单额外约束（主 Agent 注入任务书，不在 90-final 内）：D1/D2 的合并动作、vitest 门禁命令形态、行号以实测为准、禁止触碰 approval 遗留改动。
