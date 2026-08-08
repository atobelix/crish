# 代码严苛审计 —— 系统性修复总结（2026-08）

> 流程：方案设计（6 任务书）→ 方案审计（3 组）→ 裁决修订 → E0 批 → P1 批 → P1 收尾批 → D2+P2 六批 → 独立验收（3 组）→ 全量回归收口。
> 纪律：`plan/00-EXECUTION-CODE-OF-CONDUCT.md`（红绿纪律/两段提交/禁止清单/实跑报告义务）；`plan/00-REMEDIATION-DECISIONS.md`（裁决）。

## 一、修复总量

- **P0 ×4** 全部修复并独立验收：命令红线绕过（22 攻击变体零漏拦）、CI 中层两 job 复活、stress 真实化
- **P1 ×29** 全部修复：安全 6 / 数据 9 / 会话 2 / 壳 3 / 前端 5 / CI 4
- **P2 ×90+** 完成约 70 项（死代码/边界/类型/UI/性能/盲区六批），其余登记 99-EXECUTION-FINDINGS.md（C7 阶梯、deadlock 检测器依赖缺失基础设施，如实标注"待接"）

## 二、关键修复（代表性，全部带红→绿证据）

| 域 | 修复 | 证据 |
|---|---|---|
| 安全 P0 | 命令门禁：切分补 `\n`、`$()`/反引号递归下沉、iex/-EncodedCommand 拦截、`--` 变体、PS 别名归一 | r1_redline_chain 12 测试 + 验收 22 攻击变体 Blocked |
| 安全 P1 | symlink 写逃逸（三层：逐级祖先 canonicalize + 双保险 + dangling）、Unicode 折叠越界（fold 映射）、git push refspec、cmd /C→ShellExecuteW、产出目录路径校验 | 各两段提交 + R1 复核 |
| 数据 | 迁移崩溃重跑自愈（v3→v4 幂等 + session_sequence 列名缺陷）、孤儿清理 in-flight 保护（6 非终态+未决 pending 豁免）、flow 双跑（持久化前置+load 反向校验）、快照互斥（tokio Mutex+generation tmp）、写竞态（串行队列+版本戳 CAS，契约翻转）、懒水合分页拉全+persist 熔断、parser 深度守卫、UTF-8 增量解码 | crash_consistency 12/12、orphan_grace 16/16、82 测试 |
| 会话 | RecoveryDecision::Fatal 缺省 error 收场、审批挂起超时/abort 竞速（120s） | 311 测试全绿 |
| 壳 | provider 凭据热重载（wire 层捕获证明）、search root 沙箱化、5 命令 CoreError 收敛 | 469 测试全绿 |
| 前端 | 降级打戳+hydrate 回灌、取消竞态双守卫、quota 截断标志、菜单真实锚点、拖拽指针捕获 | 各红→绿 + AC-03 验收 7/7 |
| 性能 | SSE 分帧单遍 O(n)（24.8s→0.05s）、batcher 失败重试不静默、tokenUsage 并发串行链、StreamRenderBuffer 单块拆帧 | 计时断言红→绿 |
| 类型 | 漏码 tool.write_path_conflict 双向注册+漂移测试、AgentEndReason/approval-resolved/phase/errorKind 对齐生成类型 | 63/63 + typecheck 0 |

## 三、最终门禁（2026-08-08 实跑）

| 门禁 | 结果 |
|---|---|
| `cargo test --workspace` | 87 套件全绿，0 失败 |
| `npm run typecheck`（5 tsconfig） | EXIT=0 |
| `npm run test:coverage -- --project=unit` | 356 文件 / 5342 测试 EXIT=0（coverage 54.97/77.46/72.54/54.97 ≥ 45/70/65/45） |
| `npx vitest run --config vitest.integration.config.ts` | 40/40 EXIT=0 |
| `npm run stress` | 3/3 EXIT=0 |
| `cargo check --workspace --locked` / `clippy` / `knip` / `test:e2e:smoke` | EXIT=0（PS-02 实跑） |

## 四、遗留与诚实边界

1. **未接线**：C7 阶梯、deadlock 检测器、touch_session 生产接线、plugin-sdk 路径逃逸校验（依赖缺失基础设施，登记 F-017/F-018）
2. **flaky 观察**：crish-agent-workbench 定时器类 3 用例有负载型 flaky（P2 批6 已根因修复 4 处，残留 2 项登记）
3. **CI 三层实跑**：需 push 触发（本地等价命令全绿）
4. **过拦截项**（记录不修）：`echo '$(rm -rf /etc)'` 静态正则层超覆盖（Blocked 但属安全侧）
5. 并行会话 WIP（markdown-editor 引擎、.agents/）未触碰未提交

## 五、结论

- 审计发现的 4 个 P0 与 29 个 P1 **全部根因修复**，复核确认率 100%，无虚报；P2 完成约 70 项
- 防作弊机制生效：红绿两段提交可经 git log 核对；独立验收 3 组（AC-01/02/03）自行实跑未发现虚报；期间登记 30+ 执行发现（F-001~F-032）
- 快层/中层/Rust 全量门禁全绿，修复轮闭环
