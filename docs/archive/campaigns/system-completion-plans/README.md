# System Completion Plans（系统补全与长程测试）

本目录存放 **Mock/Stub 补全** 与 **软件内 AI 长程测试** 的审计与多轮多 Agent 方案。

## 阅读顺序

1. `audits/00-master-findings.md` — 8 路审计汇总
2. `00-master-multi-agent-roadmap.md` — 全局多轮编排
3. `plans/01` … `05` — 分维度系统性方案

## 测试哲学（硬约束）

- **在真实软件（Tauri + daemon）内测**，不是仅浏览器 dev 端口
- AI 长程任务：轨迹 + 工具防护 + 磁盘 oracle；computer-use 仅探索层
- 开源参考 clone 到仓库根 `reference/`（执行轮拉取，勿提交巨型依赖除非 submodule）

## 相关已有文档

- `docs/architecture/session-pending-draft-adr.md`
- `docs/testing/integrated-test-suite-plugin-roadmap.md`
- `multi_agent_session_lifecycle_*.md`
