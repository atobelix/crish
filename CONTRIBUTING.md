# Contributing to Crish

感谢你关注 Crish！欢迎一切形式的贡献：bug 报告、功能建议、文档改进与代码提交。

在动手之前，请先阅读 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) 与
[`docs/opensource/CONTRIBUTING-PROVIDERS.md`](docs/opensource/CONTRIBUTING-PROVIDERS.md)
（Provider 接入指南）。

## 仓库结构

Crish 是 Rust + TypeScript 的 npm/Cargo 混合 monorepo：

- `apps/crish-desktop`：React 19 + zustand 桌面 UI（Vite；聊天、设置、终端、流式渲染）
- `apps/agent-workbench/src-tauri`：Tauri 2 壳（窗口、IPC 命令注册、CSP、updater）
- `crates/`：Rust 引擎（orchestrator / session-loop / agent-provider / agent-tools / conex-* 基础设施），
  全部经 Cargo workspace 统一管理（`Cargo.lock` 已提交，构建可复现）
- `packages/`：TS 侧共享包（decision-engine / logger / plugin-sdk / shared-types / shared-utils /
  telemetry / test-utils）

> **重写过渡期提醒**：旧 TS 后端包（`agent-daemon` / `agent-orchestrator` / `agent-runtime` 等）已删除，
> 引擎为 Rust 进程内实现。`apps/agent-workbench/src` 内少量遗留 CLI/注册表文件仍引用旧包，属于
> 待清理路径，**不要在旧路径上开发新功能**；新功能一律落在 Rust 引擎契约面（`core_*`/`workbench_*` 命令）。

## 前置条件

| 工具                          | 版本                   | 说明                                                                                                                                   |
| ----------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                       | ≥ 20（CI 使用 20）     | 前端构建与测试；包管理器 npm（`packageManager: npm@11.6.2`）                                                                           |
| Rust                          | stable（edition 2021） | 引擎与 Tauri 壳；需含 `cargo` / `rustc` / `clippy` / `rustfmt`                                                                         |
| Tauri 2 平台依赖              | —                      | Windows：WebView2；Linux：webkit2gtk 等（见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)）；macOS：Xcode Command Line Tools |
| （可选）cargo-deny / gitleaks | —                      | 本地复现 CI 安全门禁                                                                                                                   |

## 快速开始

```bash
git clone https://github.com/conex-community/crish.git
cd conex
npm install          # 安装依赖；prepare 钩子自动配置 husky
```

### 开发

```bash
npm run dev:desktop      # 仅 React UI（Vite，端口 5174）
npm run dev:workbench    # Tauri 壳 + 桌面联调（引擎为 Rust 进程内）
```

### 构建与测试

```bash
# Rust 引擎
cargo build --workspace
cargo test --workspace        # CI 中层全量门禁
cargo clippy --workspace -- -D warnings   # CI 中层 lint 门禁
cargo check --workspace --locked          # CI 快层门禁（锁定 Cargo.lock）

# 前端
npm run check:desktop     # crish-desktop typecheck + UI 分层检查
npm run build:desktop     # crish-desktop 生产构建
npm run test:desktop-helpers   # 桌面端 api / store 单测
npx vitest run --project=unit   # CI 快层 vitest 快集
```

> 过渡期说明：部分 TS 存量测试仍引用已删除的旧包路径，`npm run test` 全量执行时可能报错；
> 本地以 `cargo test --workspace` 与 `npm run check:desktop` 为绿线，CI 快层为合并门禁。

## 代码规范

- **TypeScript**：严格模式（`tsconfig.base.json`，含 `noUncheckedIndexedAccess` /
  `exactOptionalPropertyTypes` 等）。提交前保证 `npm run check:desktop` 通过；
  ESLint（`eslint .`）与 Prettier（`prettier --check .`）无告警。
- **Rust**：`cargo fmt` 格式化；`cargo clippy` 无新增告警；关键语义必须有单测（faux provider 模式）。
- **安全基线（强制）**：所有 Rust crate、Tauri 壳与前端改动必须满足
  [`docs/rust-rewrite/31-security-baseline.md`](docs/rust-rewrite/31-security-baseline.md) 十条基线
  （B1 命令门禁 / B2 路径 / B3 凭据 / B4 日志脱敏 / B5 IPC 暴露面 / B6 MCP / B7 SQL / B8 panic 面 /
  B9 依赖 / B10 webview 注入）。触达安全面（见该文档 §1 判定表）的 PR 需附带对应测试并在 PR
  描述中勾选检查表；未触达的显式声明「未触达安全面」。
- **提交规范**：Conventional Commits，如 `feat(desktop): …`、`fix(session-loop): …`、
  `docs(rust-rewrite): …`、`test(workbench): …`。仓库已配置 husky + lint-staged
  （pre-commit 自动 eslint/prettier；pre-push 跑 typecheck 与测试）。
- **依赖**：新增依赖需说明理由；Rust 依赖统一收口到根 `Cargo.toml [workspace.dependencies]`，
  npm 依赖尽量收敛单一版本（避免双 HTTP 栈等重复依赖）。

## CI

三层 CI（`.github/workflows/`）：

- **快层 `ci.yml`**（每次 push / PR）：`cargo check --workspace --locked`、vitest 快集、eslint、
  depcruise、npm audit、cargo-deny、gitleaks 密钥扫描；
- **中层 `ci-mid.yml`**（合并前）：`cargo test --workspace` 全量、`cargo clippy -D warnings`；
- **慢层 `ci-slow.yml`**：压力测试（`cargo test --release -- --ignored`、`npm run stress`）、Criterion 基准。

PR 标题使用 Conventional Commits 前缀，便于 changelog 生成与门禁识别。

## 提交流程（Pull Request）

1. Fork 仓库，从 `main`（或最新发布分支）切出功能分支，命名如 `feat/…`、`fix/…`、`refactor/…`；
2. 为新行为添加测试（Rust 单测 / vitest / 脚本验证，按安全基线要求）；
3. 本地通过：`cargo test --workspace` + `npm run check:desktop`（如触达安全面，另附对应测试）；
4. 提交时写明改动与理由（Conventional Commits）；
5. 提交 PR，描述中说明：改动内容、测试结果、安全面声明（勾选 `31-security-baseline.md` §4 检查表或声明未触达）；
6. 等待快层 CI 通过与维护者 review；需求变更在 discussion 中讨论。

Provider（模型服务商）接入请走 [`docs/opensource/CONTRIBUTING-PROVIDERS.md`](docs/opensource/CONTRIBUTING-PROVIDERS.md)
的独立流程。

## 安全漏洞

请勿在 Issue 中公开漏洞细节；按 [`SECURITY.md`](SECURITY.md) 流程私密报告
（`security@conex-community.org`）。

## 社区

- GitHub Issues / Discussions：功能讨论、设计变更建议
- 社区邮箱：`contact@conex-community.org`
