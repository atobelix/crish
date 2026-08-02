# A3 开源文档整理方案

> 状态：评估完成，待实施
> 日期：2026-08-02
> 范围：只读评估 + 整理规划（本文档不改动任何源文件）
> 对象：`C:\Software\conex`（Tauri + Rust + React 的桌面 AI Agent 工作台，即将开源）

---

## 1. 结论速览

| 项目 | 结论 |
| --- | --- |
| 现有 7 份开源文档 | 4 份可用但需更新（LICENSE/CODE_OF_CONDUCT/SECURITY/CHANGELOG），2 份需重写（README/CONTRIBUTING），1 份需核对路径有效性（CONTRIBUTING-PROVIDERS） |
| 最大风险 | 仓库正处于 **Rust 重写进行中**（`docs/rust-rewrite/`、分支 `refactor/architecture`），README/CHANGELOG/CONTRIBUTING 描述的结构与磁盘实际已不一致（部分 packages 目录已不存在） |
| 开源准备度 | 文档骨架齐全（含 LICENSE/CoC/SECURITY），但缺少用户视角的 README、安装说明、用户指南、FAQ |
| 合规待办 | Cargo.lock 未跟踪、git remote 未配置、provider 声明路径悬空、根目录 40+ 内部规划 md 需治理 |

---

## 2. 项目关键事实速查（README 重写素材）

### 2.1 身份与元数据

| 项 | 值 | 来源 |
| --- | --- | --- |
| 产品名 | **Crish**（`tauri.conf.json` productName） | `apps/agent-workbench/src-tauri/tauri.conf.json` |
| 版本 | 0.1.0（workspace/package/tauri 三处一致） | `Cargo.toml`、根 `package.json`、`tauri.conf.json` |
| 描述 | "Crish - Tauri Workbench and agent daemon runtime" | `Cargo.toml [workspace.package]`、`package.json` |
| 许可 | MIT（`Copyright (c) 2026 Conex Community`） | `LICENSE` |
| 仓库 URL | `https://github.com/conex-community/crish`（**本地无 remote 可验证**） | `Cargo.toml`、`package.json` |
| 社区邮箱 | `contact@conex-community.org`（CoC）；`security@conex-community.org`（SECURITY） | `CODE_OF_CONDUCT.md`、`SECURITY.md` |
| 更新通道 | `https://releases.crish.me/updates/...`（Tauri updater 已启用但 pubkey 为空） | `tauri.conf.json` |

### 2.2 技术栈

- **壳**：Tauri 2（Rust 进程），窗口 1320×880，装饰自定义（`decorations: false`），CSP 已配置（`apps/agent-workbench/src-tauri/tauri.conf.json`）
- **UI**：React 19 + zustand，`apps/crish-desktop`，Vite（dev 端口 5174）
- **引擎（目标形态，Rust）**：`crates/orchestrator`、`crates/session-loop`、`crates/agent-provider`、`crates/agent-tools` + `crates/conex-*`（db/ipc/types/telemetry/sandbox/search/fs/diff/markdown/compaction 等 17 个目录）
- **引擎契约面（三端共用）**：`core_*` 命令 + `config_*` + `session_*` + `workbench-run-event` 事件通道 + `CoreError` 统一错误协议（`docs/rust-rewrite/23` §2）
- **目标形态三端**：引擎契约面（后端 Rust 进程内）→ GUI（React 渲染适配层 `workbench_*`）/ TUI（规划中，仅依赖契约面）/ Web（HTTP/WS 适配，后续）
- **TS 侧**：当前 package.json 仍声明 19 个 workspace；磁盘实际仅存 10 个目录（详见 §2.3 风险）

### 2.3 结构与漂移风险（重要）

| 声明源 | 声明内容 | 磁盘实际 | 漂移结论 |
| --- | --- | --- | --- |
| `package.json` workspaces | 19 项（含 agent-runtime/core/model/daemon/orchestrator/mcp/subagent/permissions/tools/context） | 仅 8 个 packages 目录：agent-provider-http、decision-engine、logger、plugin-sdk、shared-types、shared-utils、telemetry、test-utils | **10 个被声明目录不存在**；`npm run daemon`（指向 `packages/agent-daemon/src/index.ts`）必然失败。与 `00-master-plan.md` §0.3"删除 TS 端 daemon/runtime/orchestrator"吻合——重写进行中，清单未同步 |
| README「产品路径（唯一真相）」 | 引擎 = packages/agent-daemon + orchestrator + runtime | 目录已不存在 | README 所述"唯一真相"已过时 |
| CHANGELOG 0.1.0 | 列出 packages/agent-runtime、agent-orchestrator、agent-daemon 等 | 目录不存在 | 同上 |
| `CONTRIBUTING-PROVIDERS.md` | `templates/provider.openai-compatible.json`、`providers/<id>.json`、`npx crish add-provider` | `templates/`、`providers/` 均不存在；根目录无 `crish` 可执行 CLI | 路径悬空 |
| `Cargo.toml` members | 16 项 | 磁盘 17 个 crate 目录（含 conex-net、conex-stream） | conex-net / conex-stream **未列入 members**，需确认是否废弃或漏登记 |
| CI | `.github/workflows/` 4 个：ci.yml（快层）、ci-mid.yml（中层）、ci-slow.yml（慢层）、perf-test.yml | — | 三层 CI 结构清晰，README/CONTRIBUTING 未提及 |
| git | 分支 `refactor/architecture`，无 remote | — | 开源前必须确认最终仓库地址 |

> **对整理方案的影响**：README/CONTRIBUTING 的所有结构描述必须以"目标架构（Rust 引擎契约面 + GUI/TUI）"为纲，并标注重写过渡状态，避免把过时目录写进面向公众的文档。

---

## 3. 现有开源文档评估表

| 文档 | 现状 | 质量评价 | 主要缺口 |
| --- | --- | --- | --- |
| **README.md**（2.5KB，60 行） | 中文内部"产品路径唯一真相"：分层表 + 开发命令 + 文档链接 + 原则 + MIT | 内容准确、有唯一真相意识，**但不是开源落地页**；零截图、零功能清单、零安装/使用说明、零社区链接、零 badges；标题「Crish」但全文只说路径不说"这是什么/能做什么"；断言"已移除/勿再查找"是内部工作记忆，不适宜公开 | 全部：项目介绍/功能/截图/安装/快速开始/架构图/文档索引/许可链接/社区入口 |
| **CONTRIBUTING.md**（2KB，64 行） | 标准结构：欢迎语/工作流/前置条件/快速开始/代码风格/PR 流程/社区 | 基本可用；`npm run test`、`npm run check:core` 均真实存在 | 结构列表过时（引用已删除的 packages）；无 Rust 侧说明（cargo build/test/clippy、`cargo test` 是否必需）；未提 husky/lint-staged 钩子；未提分支命名/PR 标题规范/DCO 或贡献者许可；未链接 CONTRIBUTING-PROVIDERS.md；未提 CI（3 层）与 commit 规范 |
| **CHANGELOG.md**（1KB，22 行） | Keep a Changelog 声明 + SemVer 声明 + 一条 0.1.0（2026-07-18） | **基本规范**：格式声明齐全，版本条目有 Added 分组；内容以工程结构变更为主（符合 0.1.0 立项性质） | 无 `[Unreleased]` 节；无版本链接引用块（`[0.1.0]: url`）；条目内粗体小节名（**Monorepo Structure**）不符合 Keep a Changelog 惯用「大写加粗为 Added/Changed/Fixed 类型」惯例；无"已移除"历史条目 |
| **CODE_OF_CONDUCT.md**（3KB，64 行） | Contributor Covenant 2.x 前 5 节（Pledge/Standards/Enforcement Responsibilities/Scope/Enforcement） | 内容合格、含举报邮箱与 GitHub issues 兜底 | 缺 Covenant 2.1 标准附件的「Enforcement Guidelines」（4 级违规处理分级表）与「Attribution」节；年份版本未标注 |
| **SECURITY.md**（1KB，23 行） | 支持版本表（0.1.x ✓）+ 漏洞报告流程（48h 确认） | 简洁合格 | 建议补充：GitHub Security Advisory 作为私有报告通道（邮箱外并行）、自动扫描（Dependabot/rust audit）状态声明、报告范围（Tauri 壳/引擎/crates） |
| **CONTRIBUTING-PROVIDERS.md**（14KB，558 行） | 中文，质量**最高**：Schema 表/8 种认证/3 引擎示例/测试指南/PR checklist/决策树/常见问题 | 内容专业完整，几乎可直接发布 | **路径与命令悬空**（见 §2.3）：`providers/`、`templates/` 目录不存在，`npx crish add-provider` 无发布物；`transport: "rust-reqwest"` 对应的 `agent-provider-http` 是半成品 crate；Rust 重写后 provider 声明的最终落位（现为 agent-model 内 38 个 JSON，该目录待删）未定——文档去向需与重写计划对齐 |
| **LICENSE**（21 行） | MIT 全文，`Copyright (c) 2026 Conex Community` | **标准完整**，无需修改 | 无；补充建议：根目录声明 `SPDX-License-Identifier: MIT`（Rust/Cargo 已带），npm 包 `license: "MIT"` 已齐 |

---

## 4. README.md 重写大纲（章节级）

> 定位：**面向外部用户与贡献者的落地页**，中文（与现社区语言一致，可后续加英文版）；内部"唯一真相"内容迁移至 `ARCHITECTURE.md`（已存在）维护，README 只保留面向公众的架构简述。

```text
README.md（重写，目标 ~150-200 行）
├─ # Crish —— 桌面 AI Agent 工作台
│   徽章行：License(MIT) / CI(3 层) / Node/Rust 版本 / 平台(Windows·macOS·Linux)
│   一句话定位：本地 Tauri 壳 + React UI + Rust 引擎的 AI Agent 桌面工作台
├─ ✨ 功能特性（bullet，基于事实可验证项）
│   · 多模型 Provider 引擎：OpenAI-compatible / Anthropic / Gemini / Ollama（含 8 种认证方式）
│   · 会话 / 审批 / 工具（fs·shell·search）/ 沙箱 / markdown 流式渲染
│   · 终端（xterm）、会话持久化（conex-db）、全文搜索与 diff
│   · 目标架构三端：GUI（React）/ TUI（规划）/ Web 适配（同一引擎契约面）
├─ 📸 截图（预留空节，发布时补）
├─ 🚀 快速开始（下载安装 → 配置 API Key → 新建会话）
│   发布前确认：安装包分发渠道（Releases? 官网?）；配置项入口（设置页）
├─ 🖥️ 安装说明（指向 docs/INSTALL.md；含系统要求、各平台构建产物、签名状态）
├─ 🛠️ 从源码构建（开发命令：npm install → npm run dev:workbench；Rust: cargo build/test/clippy）
├─ 🏗️ 架构（简版 ASCII 图，取自 23 号方案 §2 三端图：
│   引擎契约面 core_*/config_*/session_*/workbench-run-event/CoreError → GUI / TUI / Web；
│   详细见 ARCHITECTURE.md 与 docs/rust-rewrite/）
├─ 📚 文档（README / ARCHITECTURE / CONTRIBUTING / CONTRIBUTING-PROVIDERS / docs/ 索引）
├─ 🤝 社区（GitHub Issues / Discussions / 邮箱；指向 CoC）
└─ 📄 License（MIT，链接 LICENSE；版权 Conex Community）
```

### 4.1 迁移建议（"唯一真相"内容的去留）

| 现有 README 内容 | 建议 |
| --- | --- |
| 产品路径分层表 / 已移除路径清单 | 迁入 `ARCHITECTURE.md`（补"重写过渡状态"节，注明 TS 引擎删除计划） |
| 开发命令 | 精简为 README 快速开始 + CONTRIBUTING 详述 |
| 原则摘要 | 迁入 `ARCHITECTURE.md` |
| 文档链接 | 保留并更新（补 ARCHITECTURE.md 之外的 docs/ 索引） |

---

## 5. 缺失文档清单（含优先级）

| # | 文档 | 优先级 | 说明 |
| --- | --- | --- | --- |
| D1 | `docs/INSTALL.md`（安装说明） | **P0** | 各平台（Win/macOS/Linux）安装方式、系统要求、API Key 配置、更新通道（updater）、常见安装问题；发布前还需敲定分发渠道 |
| D2 | `docs/USER-GUIDE.md`（用户指南） | **P0** | 功能走查：会话、模型/Provider 配置、审批流、工具权限、设置项；配截图 |
| D3 | `docs/FAQ.md` | P1 | 常见问题：模型接入（本地 Ollama vs 云端）、API Key 安全（环境变量、DPAPI）、数据存储位置、卸载残留 |
| D4 | `docs/DEVELOPER-GUIDE.md`（开发者指南） | **P1** | 架构详解（引擎契约面/命令/事件协议）、crate 地图、调试（devUrl 5174、日志、telemetry）、Rust 测试规范；与 CONTRIBUTING 分工 |
| D5 | 根目录治理 | **P1** | 40+ 内部规划 md（`*REFACTOR-PLAN*`、`*OVERHAUL*`、`multi_agent_*`、`suggestions*`、`0613-*` 等）开源前需分类：移入 `docs/archive/`、`docs/plans/`、或删除；保留 `ARCHITECTURE.md`、`ROADMAP.md`（需核查内容时效性）。`NUL`、`history.txt`、`*.log`、`restore_localstorage.js`、`bring-window.ps1` 等杂项应清理 |
| D6 | `docs/` 索引页（README 文档节链接目标） | P2 | 现有 30+ 子目录为内部工作区，公开索引仅收录用户/开发者两类入口 |
| D7 | GitHub 元数据 | P2 | Issue 模板（bug/feature/provider 申请）、PR 模板、Labels 约定、`CONTRIBUTING-PROVIDERS.md` 链接入口 |
| D8 | 英文版 README（`README.en.md` 或翻译流程） | P2 | 若目标社区为国际，建议英文主版本 + 中文版；可先只出中文版降低发布门槛 |

---

## 6. 开源合规检查项

### 6.1 许可证与版权

- [x] `LICENSE`：MIT 全文完整，版权行 `2026 Conex Community`，与 Cargo.toml/package.json 的 `license = "MIT"` 一致
- [x] 各 npm 包与 crate 声明 MIT（需抽查子包 `license` 字段一致性）
- [ ] **SPDX 头**：Rust crate 建议在 `Cargo.toml` 补 `SPDX-License-Identifier` 或在源文件头声明（可选，非强制）
- [ ] **第三方依赖许可**：开源前扫描 TS 侧（`npm ls` / `license-checker` 或 `licencee`）与 Rust 侧（`cargo deny` / `cargo-about`）依赖清单，确认无不兼容许可（AGPL 等）与版权声明缺失；重点核查：tauri 生态（MIT/Apache-2.0）、syntect（MIT）、ammonia（Apache-2.0）、windows-sys（MIT/Apache-2.0）
- [ ] **NOTICE 文件**：如引入需署名依赖，需在根目录提供 `NOTICE`（待扫描后确认是否需要）

### 6.2 构建可复现性

- [ ] **Cargo.lock 未跟踪**（`.gitignore` 中 `Cargo.lock`，注释为"managed by Cargo"）：作为**应用仓库**（含二进制 crate），Rust 官方惯例应**提交 Cargo.lock** 以保证可复现构建与安全审计；建议从 `.gitignore` 移除，并将 `Cargo.lock` 纳入 git
- [x] `package-lock.json` 已跟踪（`.gitignore` 有 `!package-lock.json` 白名单）
- [ ] 仓库地址确认：本地无 remote，README/CONTRIBUTING/Code of Conduct 引用的 `conex-community/crish` 需与最终公开仓库核对；README 与项目名（Crish）vs 组织名（Conex）vs 仓库目录名（conex）的关系需在 README 一句话讲清

### 6.3 敏感信息与历史清理

- [ ] 根目录与 docs/ 扫描 API key / token / 私钥 / `.env` 样例残留（建议 `gitleaks` 或 `trufflehog` 全仓扫描；历史 commit 若含敏感信息需 `git filter-repo` 处理）
- [ ] `.mcp.json`、`.AGENT-IMPLEMENTATION-RULES.md`、`dev-workbench-restart2.log` 等内部文件去留判定
- [ ] `tauri.conf.json` updater `pubkey` 为空：发布签名公钥前 updater 端点实际不可用，README/INSTALL 不得宣称自动更新已生效（发布状态事实性声明）

### 6.4 CI 与安全基线（现状记录，供文档引用）

- [x] `.github/workflows/`：ci.yml（快层：提交/PR）、ci-mid.yml（中层：合并前全量）、ci-slow.yml（慢层：nightly/发布前）、perf-test.yml（性能）——README/CONTRIBUTING 宜提及，badge 可在发布后配置
- [ ] 依赖漏洞扫描（Dependabot / `cargo audit`）未见专属 workflow，建议补充并在 SECURITY.md 说明

---

## 7. 实施顺序建议

1. **前置确认（阻塞项）**：最终 GitHub 仓库地址与 org；Rust 重写对 packages/ 清单的收敛节奏（决定 README/CONTRIBUTING 措辞是"现役"还是"过渡态"）；provider 声明最终落位（决定 CONTRIBUTING-PROVIDERS 改版）
2. **P0（发布前必须）**：README 重写（§4 大纲）；D1 INSTALL、D2 USER-GUIDE；根目录治理（D5）；Cargo.lock 提交；git remote 确认
3. **P1**：CONTRIBUTING.md 更新（新结构 + Rust 指引 + CI/钩子说明 + 链接 PROVIDERS）；CONTRIBUTING-PROVIDERS.md 路径修复或加"过渡说明"；DEVELOPER-GUIDE（D4）；密钥扫描与依赖许可扫描（§6）
4. **P2**：FAQ（D3）、GitHub 元数据（D7）、docs/ 索引（D6）、英文版（D8）、CHANGELOG 补 Unreleased/链接块、CoC 补全 2.1 附录、SECURITY 补 advisory 通道

---

## 附录 A：评估依据文件清单

- 开源文档：`README.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`CONTRIBUTING-PROVIDERS.md`、`LICENSE`（20 行）
- 项目信息：根 `Cargo.toml`、根 `package.json`、`apps/agent-workbench/package.json`、`apps/agent-workbench/src-tauri/tauri.conf.json`、`apps/crish-desktop/package.json`
- 架构素材：`docs/rust-rewrite/23-architecture-hardening-plan.md` §2 目标架构（三端适配图，L49-71）、`docs/rust-rewrite/00-master-plan.md` §0.2 目标形态（L28-52）
- 环境事实：`crates/`、`packages/`、`apps/` 目录清单；`.github/workflows/` 4 个 workflow；`git ls-files Cargo.lock package-lock.json`、`git remote -v`（无 remote）、当前分支 `refactor/architecture`
- 漂移验证：`providers/`、`templates/` 不存在；`packages/` 仅 8 个目录 vs workspaces 声明 19 项；`crates/conex-net`、`crates/conex-stream` 未列入 Cargo.toml members
