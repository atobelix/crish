# Conex / Crish — Agent 协作指令

## 测试资产保护铁律（2026-08-07 事故后生效）

- `reference/markdown-editor/` 的全部源码与测试**必须入库**（.gitignore 已白名单放行；node_modules/dist 除外）——2026-08-07 曾因 `reference/*` 忽略导致用户测试资产近乎丢失，且 f772eb99 提交顺手删除了 28 个根目录测试（已从 `f772eb99^` 恢复）。**任何会话禁止删除/清理该目录下的测试文件**；如确需删除，先确认已入库并提交删除。
- `reference/markdown-editor` 的门禁：`npm test`（vitest run tests/unit，含 grapheme/undo/parser-redos/chunk）。改动引擎代码后必须跑通该门禁。
- 主仓库 tests/e2e 下的 5 个 markdown-editor 专项 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）是用户针对性测试，**禁止删除**，回归时保留。
- 测试是资产不是杂物：新增调试/测试脚本后立即 `git add` 提交，不留在未跟踪状态。

## 输出风格与长度策略

- **长度自适应**：回复长度根据用户问题的复杂度、上下文需求与用户明确的期望决定，不强制精简。
  - 简单事实性问题（"这个文件在哪"）：给出直接答案即可，1-3 句。
  - 需要判断/评估/解释的问题（"效果如何""哪个更好""为什么"）：给出**清晰、结构化的完整说明**——结论先行，然后按维度展开，配代码/文件:行号证据，最后给建议。不要为了短而砍掉有信息量的部分。
  - 用户明确要求"详细/多说/展开"时，尽量给足内容。
- **结构优先**：长回答使用标题、列表、表格组织；结论/推荐放在显眼位置；证据（文件路径:行号、代码片段、命令输出）保持具体可复核。
- **诚实边界**：不确定的地方明确标注；不编造测试结果或代码行为。

## 项目背景（供回答与调度时参考）

- **架构**：Rust 内核（`crates/`：session-loop/orchestrator/agent-provider/agent-tools/conex-*）+ Tauri 壳（`apps/agent-workbench/src-tauri/`）+ React 前端（`apps/crish-desktop/`）+ 共享 TS 包（`packages/`）。
- **文档**：`docs/` 是文档总目录；`docs/rust-rewrite/` 是架构重构的活跃文档（00 主方案 / 23 总纲 / 30 执行方案 / 33 事件 changelog / 34 收尾清单）；`docs/organization/` 是治理与评审产物；`docs/archive/` 为归档（legacy/campaigns/redesign/prototypes/provider-m4）；`docs/guides/` 与 `docs/opensource/` 为指南与开源文档。
- **测试**：Rust `cargo test --workspace`（73 套件基线）；前端门禁 `npm run typecheck` + `npm run test:coverage -- --project=unit`（45/70/65/45，快层 ci.yml 强制执行）+ 中层两 job（`npm run test` vitest 全量 / `npx vitest run --config vitest.integration.config.ts` F3 四目录）——PS-02 落地后口径：快层全绿 + 中层两 job 修复（旧基线失败集 4 文件口径已清零，R3 实测 37/37 + 77/77 全绿）。
- **代码约定**：中文注释（UTF-8 无 BOM）；提交遵循仓库风格（feat/fix/test/docs/chore + 范围）；子 Agent 任务先读对应任务书（`docs/rust-rewrite/plans/PE-*.md`）与相关审查文档。

## 子 Agent 调度规则（多 Agent 协同）

- **嵌套禁止（用户裁决，REQ-D08）**：仅主 Agent 可派发子 Agent；子 Agent 深度 1，无派发能力——子 Agent 的工具注册表剔除 run_subagent（工具面防护），即便绕到守卫层也返回结构化错误（`subagent.nesting_denied`："你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。请通过消息/上报向主 Agent 请求派发。"）。
- 一轮最多 12 个子 Agent；任务包括：分析（只读+文档）、方案（只读+文档）、评审（只读+文档）、实现（写代码+测试）、提交（仅 git）。
- 派单前明确：输入文档、产出路径、验收标准、文件冲突注意事项（同文件串行）。
- 子 Agent 可读最终计划文档，但只执行分配给自己的任务；执行中发现任务书未覆盖的问题上报调度者裁决。

## 多 Agent 协作文档产出约定（REQ-G02 流程层）

多 Agent 协作文档产出的共享目录、文件名分配、汇总索引与格式约定。对齐 `docs/multi-agent-repair/` 的现实惯例（README.md:7-14），草案见 `docs/feature-gap-analysis/plans/04-EG编辑工具与文档工作区方案.md` §4.5（OutputConvention），主控与子代理均须遵守。

1. **共享产出目录**（resolve_output_dir 返回值语义）：
   - 默认返回 `<workspace_root>/.agent-outputs/<YYYY-MM-DD>-<session_id>/`（本地时区、日期零填充）；用户显式指定 folder 时优先直接使用（不创建目录）；
   - 同会话重复调用返回同一路径（幂等，写入 session_meta `"{session_id}:output_dir"` 持久化）；目录**惰性创建**——首次写入时自动创建，解析本身不落盘；
   - 产出根必须在 workspace_root 内（path_within_root 校验），不污染源码目录（REQ-G03）；**只读子代理不允许自选输出目录**（忽略/拒绝 folder，仅按主 Agent 规划返回）。

2. **文件名分配**：主控在派发时于 prompt 中为每个子代理分配唯一产出文件名 `NN-<模块标题>.md`（NN 从 01 递增，00 留给汇总索引）；标题为简短模块名，禁止含路径分隔符。引擎强制面（I4-M3 写路径互斥）保证：不同文件并行写放行、同一文件并发写被拒绝（write_paths.rs:459-469、561-582）。

3. **汇总索引生成流程**（主控职责）：wait_subagents(await-all) 收齐全部终态（终态载荷携带 outputFiles：path/summary/bytes）→ 调用 list_dir 列出共享产出目录 → 调用 write_file(00-summary.md, overwrite=true) 生成汇总索引（清单表：文件名 / 标题 / 行数 / 摘要）；最小方案不新增专用汇总工具（list_outputs 类工具列为后续增强）。

4. **文档格式**：UTF-8 无 BOM、中文内容（REQ-G02 验收）。

5. **探索类子代理配额红线**（对齐 docs/multi-agent-repair/05-协同操作约束与安全.md:195-200）：探索类（调研/分析/勘察）子代理**最多写一份文档**，且**必须由主 Agent 分配写作任务**才允许写；未获分配不得主动写第二份文档（含补充文档、分析报告），探索结果默认以汇报/汇总物形式返回。该红线已由引擎强制面接线落地（explore_docs_quota 装配于主执行器 ToolContext），超限写入会被引擎拒绝，不再仅靠提示词纪律约束。

6. **输出目录清理约定**（会话删除）：删除会话 → 读取 session_meta 产出目录 → `.agent-outputs/<session_id>` 走 conex-fs trash 删除接管（trash.rs:26-29 铁律，不直接 remove）→ **通知用户**（清理结果 + 回收站位置）；完整链路由 T-EG-12 扩展落地。

7. **产出目录与 git 隔离**：产出根 `.agent-outputs/` 为运行期目录，已在 `.gitignore` 忽略（与 `.crish-trash` 等并列）；子代理产出文档一律不提交。若产出目录内存在历史已跟踪文件，需先执行 `git rm --cached -r .agent-outputs/` 从索引移除（保留工作区文件）并提交，此后新增产出不再入库；可用 `git check-ignore -v .agent-outputs/test` 验证命中。

## 引用规则

- 引用代码位置统一用 `文件路径:行号`。
- 需要时引用：`.agents/AGENTS.md`（旧版项目规则，仍有效部分继续遵守）、`docs/rust-rewrite/31-security-baseline.md`（安全基线）。

## 严禁补丁、绕过与作弊（零容忍）

- **追求架构优雅，杜绝“打补丁”**：在修复边缘问题（如 UI 对齐、坐标偏移、事件映射等）时，严禁使用盲目猜测的遍历循环、基于坐标测距的魔术数字补偿、或临时性的兼容代码。必须穿透表象找到架构断层，用原生、精确、O(1) 复杂度的方式解决问题（例如通过原生注入 `data-*` 属性实现精确的 DOM 节点与源码 Token 的无损映射）。
- **绝对禁止绕过流水线门禁**：无论是格式化约束、类型检查还是单元测试，当 Git 钩子或 CI 环境报错拦截时，**任何 Agent 严禁使用 `--no-verify` 或类似指令强制跳过校验**。报错代表隐患，必须正面阅读错误日志并根除问题，直到正常跑通拦截门禁。
- **强制履行验证责任**：修复代码后，不得凭猜测认为“应该没问题了”。在提交前，必须运行全量类型检查（如 `npm run typecheck`）以及相关的自动化脚本（如 `npx playwright test` 或 `vitest`），并在必要时调用 DevTools / Fuzz 模糊测试验证是否有运行时报错。必须在确凿的日志与测试绿灯证据下，才能宣称问题解决。
- **禁止偷懒与避重就轻**：应对疑难杂症与边界情况时，不得选择忽略或简化问题。穷举式的测试与深层的根因分析是一等公民。
