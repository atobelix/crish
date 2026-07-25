# 子计划 09：Layer I — CI/CD 与发布流水线

> **层级编号**：Layer I（Round 0 启动 I-1~I-7 基础配置，Round 2~6 逐步完善）
> **建议 Agent 数量**：6–8 个（配置型文件由基础设施 Agent 统一修改）
> **涉及维度**：D9（CI/CD）、D13（版本管理与发布）
> **包路径**：`.github/workflows/`、`scripts/`、根 `package.json`

---

## 一、层级目标

Layer I 的核心使命是建立完整的 CI/CD 流水线和可重复的自动化发布流程：

**CI/CD 部分**：
1. **基础配置**（Round 0）：并发控制、workflow 权限最小化、路径过滤、turbo 缓存、Dependabot 增强。这部分不修改任何业务代码，可与所有代码层并行。
2. **增量验证**（Round 2）：变更检测（dorny/paths-filter 影响域分析）、增量 typecheck/lint/test/coverage。消除 `|| true` 和 `continue-on-error: true` 模式。turbo 增量构建替代全量构建。
3. **全量验证**（Round 4）：全量构建 + 测试、安全审计硬性化、密钥扫描、依赖合规（depcruise）、OS 矩阵扩展（windows-latest）、Playwright 视觉测试、基准测试持久化。
4. **质量门禁最终定型**（Round 6）：覆盖率阈值硬性阻断、lint 零 warning 强制、husky hooks 优化。

**发布部分**：
5. **发布前验证**（Round 6）：发布干运行、daemon 二进制多架构构建、发布清单验证（版本一致性、CHANGELOG 完整性）。
6. **发布交付**（Round 6）：npm publish（OIDC trusted publishing）、Docker 多架构镜像（linux/amd64 + linux/arm64）、GitHub Release 结构化（CHANGELOG 驱动）、版本管理自动化（changeset + sync-versions）。

---

## 二、问题现状

### 2.1 当前 CI 状态（评分 2/10）

当前 CI 存在 7 大类系统性缺陷：

**碎片化执行**（仅覆盖 40% 的包）：`ci.yml:79` 的 `ts-check` job 只对 `packages/agent-runtime` 执行了 `npx tsc --noEmit`，完全忽略了 shared-types、shared-utils、agent-daemon、agent-orchestrator、decision-engine 等 6 个包。

**无矩阵测试**：TS 部分仅 linux 平台运行。`vitest.setup.ts` 为 Node 环境补齐了 browser 全局变量（localStorage、dispatchEvent），但在 windows-latest 上的行为差异不可见。

**安全审计静默吞错**：`ci.yml:122-123` 的 cargo audit 和 `ci.yml:132-133` 的 npm audit 均使用 `continue-on-error: true`。已知漏洞不会阻断流水线。

**测试覆盖率门禁失效**：`apps/crish-desktop/vitest.config.ts:13-18` 定义了覆盖率阈值（statements 70%, branches 60%, functions 65%, lines 70%），但 `ci.yml:163-167` 的 coverage job 不做任何阈值验证，只有一句 `Write-Host "Coverage check completed"`。

**缺失发布流水线**：没有任何 `@crish/*` 包的 npm publish pipeline。所有包版本锁在 `0.1.0`。无 CHANGELOG.md 文件。

**缺失密钥扫描**：AI Agent 工作目录（`.agent-runtime/`、`.agents/`、`.codex/` 等）可能包含 API key。

### 2.2 与现有工具的集成现状

当前 `turbo.json:3-30` 定义了 7 个 pipeline 任务，但 CI 中**完全没有使用 turbo**。`ci.yml` 直接调用 `npx tsc --noEmit` 和 `npx vitest run`，绕过了 turbo 的依赖图缓存能力。`Swatinem/rust-cache@v2` 在 Rust 侧已使用，但 TS 侧无任何缓存。

---

## 三、设计原则

**P1 — 原生融入现有构建体系**：不引入新构建元框架。增量通过 turbo 的 `dependsOn` 表达，而非 workflow 中手写 shell 序列。

**P2 — 等价验证**：CI 中执行的命令必须是开发者本地可复现的相同命令。`package.json` 已定义的 `check:all`、`test:core`、`build:product` 作为 CI 主干。

**P3 — 增量为主，全量为辅**：PR 级别利用 turbo `--filter`、main 分支全量验证。

**P4 — 门禁硬性化**：`eslint --max-warnings 0`、覆盖率阈值、`cargo clippy -- -D warnings` 全部硬性阻断。消除所有 `|| true` 模式。

**P5 — Lockstep 版本**：所有 `@crish/*` 包同步版本。Cargo workspace 版本与之对齐。

**P6 — 安全优先**：npm publish 使用 GitHub OIDC trusted publishing。依赖审计失败默认阻断。

---

## 四、目标架构

```
Layer 1 — 基础触发与并发控制（Round 0）
  ├── PR → cancel-in-progress
  ├── Push main/develop
  └── Scheduled (nightly, weekly)

Layer 2 — 增量验证层 / PR（Round 2）
  ├── 变更检测 (dorny/paths-filter)
  ├── 影响域分析 (turbo --filter --since)
  ├── 构建/类型检查/Lint/测试——仅受影响包
  └── 覆盖率增量阈值验证

Layer 3 — 全量验证层 / main merge（Round 4）
  ├── 全量构建 (turbo run build)
  ├── 全量测试 (npm run test:coverage + test:integration)
  ├── 全量 Rust (cargo test --workspace --all-features)
  ├── 安全审计 + 密钥扫描 + 依赖合规
  └── Playwright 视觉测试 + 基准测试持久化

Layer 4 — 发布前验证 / tag push（Round 6）
  ├── 发布干运行 (npm pack --dry-run + scripts/verify-publish.mjs)
  ├── daemon 二进制跨平台构建
  ├── Docker 镜像构建验证
  └── 发布清单验证

Layer 5 — 发布交付（Round 6）
  ├── npm publish (OIDC trusted publishing, 按依赖拓扑)
  ├── Docker Hub 发布 (linux/amd64 + linux/arm64)
  ├── GitHub Release (CHANGELOG 驱动)
  └── 版本管理 (changeset + sync-versions)
```

---

## 五、任务总表

| 编号 | 任务 | 目标文件 | 核心问题 | 修复策略 |
|------|------|---------|---------|---------|
| I-1 | 统一并发控制 | `ci.yml`, `perf-test.yml` | 无 `concurrency` | 添加 `cancel-in-progress: true` |
| I-2 | workflow 权限最小化 | `ci.yml`, `perf-test.yml` | 默认 GITHUB_TOKEN 读写 | 声明 `permissions: contents: read` |
| I-3 | 路径过滤优化 | `ci.yml` | docs/.*md 修改触发全量 CI | 添加 `paths-ignore` |
| I-4 | CI 中启用 turbo 缓存 | `ci.yml`, `turbo.json` | 绕过 turbo，直接 npx | `turbo run build --filter=...` |
| I-5 | 增量 TypeScript 类型检查 | `ci.yml`, `package.json` | 仅 crish-desktop 覆盖 | 新增 `typecheck:ci` 覆盖所有包 |
| I-6 | 增量 lint（零 warning 强制） | `ci.yml` | ESLint 只 cover provider 子目录 | `npm run lint:all` + `--max-warnings 0` |
| I-7 | 增量测试 + 覆盖率硬性化 | `ci.yml`, `vitest.config.ts` | coverage job 无实际验证 | 恢复 vitest coverage thresholds |
| I-8 | 消除 `|| true` 静默模式 | `ci.yml` | 测试 suite 用 `|| true` 吞错 | 所有失败阻断流水线 |
| I-9 | 全量构建 + Rust 统一验证 | `ci.yml` | rust-check 和 rust-stream-test 分离 | `cargo test --workspace --all-features` |
| I-10 | 安全审计硬性化 | `ci.yml` | npm/cargo audit 用 `continue-on-error` | 移除，高严重度阻断 |
| I-11 | 密钥扫描集成 | `ci.yml`（新增 job） | 完全不检查密钥泄露 | trufflehog/gitleaks |
| I-12 | 依赖合规（depcruise） | `.dependency-cruiser.js`（新建） | 架构耦合持续恶化 | 禁止跨层依赖 + 循环依赖检测 |
| I-13 | OS 矩阵扩展 | `ci.yml` | 仅 ubuntu-latest | + windows-latest |
| I-14 | Playwright 视觉测试 | `ci.yml`（新增 job） | 视觉测试存在但不执行 | 前端代码变更时触发 |
| I-15 | 基准测试持久化 | `perf-test.yml` | 结果不持久化 | 上传 JSON + 趋势追踪 |
| I-16 | husky hooks 优化 | `.husky/pre-push` | `pre-push` 含 e2e 测试 | `typecheck:ci && test:core` |
| I-17 | Dependabot 增强 | `.github/dependabot.yml` | ignore 缺原因 | group 配置 + 自动合并 |
| I-18 | 发布干运行 | `release.yml` | 无预发布验证 | `workflow_dispatch` 模式 |
| I-19 | daemon 二进制多架构 | `scripts/bundle-daemon.mjs` | 未纳入发布 | 跨平台构建 + SHA256SUMS |
| I-20 | 发布清单验证 | `release.yml`（新增 job） | 无发布前检查 | 版本/Cargo/CHANGELOG 一致性 |
| I-21 | npm publish 流水线 | `release.yml`（新增 job） | 完全缺失 | OIDC trusted publishing |
| I-22 | 版本管理自动化 | `scripts/version-bump.mjs`（新建） | 全包锁 0.1.0 | changeset + sync-versions |
| I-23 | CHANGELOG 自动化 | `scripts/generate-changelog.mjs`（新建） | 无 CHANGELOG | Conventional Commits 自动化 |
| I-24 | Docker 镜像多架构 | `Dockerfile`（新建） | 无容器化 | 多阶段构建 + multi-arch |
| I-25 | GitHub Release 结构化 | `release.yml` | draft 信息量不足 | CHANGELOG 驱动 |
| I-26 | npm 发布前包验证 | `scripts/verify-publish.mjs`（新建） | 不检查 dist 完整性 | 验证导出+大小+files 字段 |
| I-27 | CI 度量与仪表盘 | `ci.yml`（新增 metrics job） | 无构建时间趋势 | 各 job 耗时+状态→JSON→GitHub Pages |

---

## 六、执行批次

| 轮次 | 任务 | Agent 数 | 与其他层的并行关系 |
|------|------|---------|-----------------|
| Round 0 | I-1~I-7（基础配置） | 3 | 与 Layer A 完全并行（零文件重叠） |
| Round 2 | I-8~I-15（增量验证） | 3 | 与 Layer B/C1 并行 |
| Round 3 | I-9~I-15（全量验证门禁） | 3 | 与 Layer B/C1 并行 |
| Round 4 | I-16~I-17（门禁优化） | 2 | 与 Layer E 并行 |
| Round 6 | I-18~I-27（发布前验证 + 发布交付） | 4 | 与 Layer G/J 并行 |

---

## 七、验证标准

| 编号 | 检查项 | 验证方法 | 通过条件 |
|------|--------|---------|---------|
| V-I1 | 并发控制 | PR 二次推送自动取消前一次 | 30s 内生效 |
| V-I2 | 类型安全全覆盖 | 所有包 `tsc --noEmit` | 0 error |
| V-I3 | Lint 零 warning | `npm run lint:all` | 0 warning |
| V-I4 | 覆盖率门禁 | 低于阈值报错 | 70/60/65/70 通过 |
| V-I5 | 测试零静默 | 无 `|| true` | 所有失败阻断 |
| V-I6 | 安全审计阻断 | 高严重度漏洞报错 | 阻断 |
| V-I7 | npm publish | OIDC trusted publishing | 6 个包发布成功 |
| V-I8 | 版本一致 | 所有 `@crish/*` 版本号相同 | 无偏差 |

---

## 八、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| CI/CD 依赖代码层完成 ↔ 代码层依赖 CI 验证（鸡生蛋） | 高 | 高 | Round 0 CI 基础配置不依赖代码层；最终 CI 优化在所有层完成后执行 |
| turbo 缓存污染 | 低 | 中 | main 分支合并时不使用缓存（`--no-cache`） |
| npm OIDC 配置失败 | 低 | 高 | 发布前在测试 registry 验证流程 |
| 多平台维护成本 | 中 | 中 | windows-latest 初始为 `continue-on-error` |
