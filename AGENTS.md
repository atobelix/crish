# Conex / Crish — Agent 协作指令

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
- **测试**：Rust `cargo test --workspace`（73 套件基线）；前端 `npm run typecheck` + `npx vitest run src`（基线失败集中在 oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf）。
- **代码约定**：中文注释（UTF-8 无 BOM）；提交遵循仓库风格（feat/fix/test/docs/chore + 范围）；子 Agent 任务先读对应任务书（`docs/rust-rewrite/plans/PE-*.md`）与相关审查文档。

## 子 Agent 调度规则（多 Agent 协同）

- **嵌套禁止（用户裁决，REQ-D08）**：仅主 Agent 可派发子 Agent；子 Agent 深度 1，无派发能力——子 Agent 的工具注册表剔除 run_subagent（工具面防护），即便绕到守卫层也返回结构化错误（`subagent.nesting_denied`："你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。请通过消息/上报向主 Agent 请求派发。"）。
- 一轮最多 12 个子 Agent；任务包括：分析（只读+文档）、方案（只读+文档）、评审（只读+文档）、实现（写代码+测试）、提交（仅 git）。
- 派单前明确：输入文档、产出路径、验收标准、文件冲突注意事项（同文件串行）。
- 子 Agent 可读最终计划文档，但只执行分配给自己的任务；执行中发现任务书未覆盖的问题上报调度者裁决。

## 引用规则

- 引用代码位置统一用 `文件路径:行号`。
- 需要时引用：`.agents/AGENTS.md`（旧版项目规则，仍有效部分继续遵守）、`docs/rust-rewrite/31-security-baseline.md`（安全基线）。
