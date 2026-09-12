# 版本管理与发布流水线现状分析与差距识别

## 1 执行摘要

本文档对 Conex 项目（Crish）的版本管理、变更记录、构建产物分发和发布流水线进行系统性现状评估与差距分析。当前项目处于早期开发阶段（版本号全部锁定为 `0.1.0`），尚未建立正式的版本管理纪律和自动化的发布流水线。

虽然 `.changeset/config.json` 配置已就位，但从未生成过任何 changeset 文件；虽然 `.github/workflows/release.yml` 工作流已存在，但仅处理 Tauri 桌面应用的二进制构建，不覆盖 npm 包发布、版本号递增、changelog 自动化生成等核心发布职能。

本分析识别出 **9 大类、28 项具体差距**，覆盖版本同步策略、包间依赖声明一致性、changelog 管理、发布前检查、签名与认证、二进制分发、版本策略准则、CI/CD 集成和文档完整性。每项差距均附带代码层面的具体证据和文件引用。

**关键发现**：
- 所有 10 个 npm 包和 13 个 Rust crates 全部锁定在 `0.1.0`，从未递增
- 内部包依赖使用了三种互不兼容的声明方式（`"*"`、`"file:../"`、硬编码 `"0.1.0"`），其中 `file:` 和 `"*"` 在发布后会直接导致消费者安装失败
- Changeset 框架引入后从未投入使用，`.changeset/` 目录仅有 `config.json`
- 唯一发布工作流 `release.yml` 仅构建 Tauri 二进制，不处理 npm 包发布
- 所有包（除 `@crish/plugin-sdk` 外）均为 `private: true`，从未执行过 `npm publish`
- 不存在版本同步脚本、发布脚本、publish 脚本等自动化工具

---

## 2 当前版本与发布管理深度评估

### 2.1 版本管理现状

#### 2.1.1 版本号分布全貌

根包 `package.json`（`C:\Software\conex\package.json:3`）声明版本为 `0.1.0`。所有 npm workspace 子包的版本号亦为 `0.1.0`：

**TypeScript / npm 包一览表：**

| 包名 | 文件路径 | 版本 | 行号 | `private` | 备注 |
|------|----------|------|------|-----------|------|
| `crish` (root) | `package.json` | `0.1.0` | 3 | `true` | 根 monorepo 包 |
| `@crish/agent-runtime` | `packages/agent-runtime/package.json` | `0.1.0` | 3 | `true` | 核心运行时引擎 |
| `@crish/agent-daemon` | `packages/agent-daemon/package.json` | `0.1.0` | 3 | `true` | 长驻 WebSocket daemon |
| `@crish/agent-orchestrator` | `packages/agent-orchestrator/package.json` | `0.1.0` | 3 | `true` | 会话编排器 |
| `@crish/shared-types` | `packages/shared-types/package.json` | `0.1.0` | 3 | `true` | 共享类型定义 |
| `@crish/shared-utils` | `packages/shared-utils/package.json` | `0.1.0` | 3 | `true` | 共享工具函数 |
| `@crish/decision-engine` | `packages/decision-engine/package.json` | `0.1.0` | 3 | `true` | 决策引擎 |
| `@crish/plugin-sdk` | `packages/plugin-sdk/package.json` | `0.1.0` | 3 | 未设置 | 插件 SDK（唯一非 private） |
| `@crish/crish-desktop` | `apps/crish-desktop/package.json` | `0.1.0` | 5 | `true` | 桌面 UI |
| `@crish/agent-workbench` | `apps/agent-workbench/package.json` | `0.1.0` | 3 | `true` | Tauri workbench shell |

**Rust crates 一览表：**

| Crate 名 | 文件路径 | 版本声明方式 | 解析版本 |
|----------|----------|-------------|----------|
| `conex-root` | `Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-types` | `crates/conex-types/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-ipc` | `crates/conex-ipc/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-stream` | `crates/conex-stream/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-search` | `crates/conex-search/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-compaction` | `crates/conex-compaction/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-sandbox` | `crates/conex-sandbox/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-diff` | `crates/conex-diff/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-db` | `crates/conex-db/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-fs` | `crates/conex-fs/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `conex-net` | `crates/conex-net/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `agent-provider-http` | `packages/agent-provider-http/Cargo.toml` | `version.workspace = true` | `0.1.0` |
| `crish-agent-workbench` | `apps/agent-workbench/src-tauri/Cargo.toml` | `version.workspace = true` | `0.1.0` |

Tauri 应用配置中的版本位于 `apps/agent-workbench/src-tauri/tauri.conf.json:4`，值为 `"0.1.0"`。`productName` 为 `"Crish"`，`identifier` 为 `"io.github.conex-community.crish"`。

**Cargo 工作区版本来源**：根 `Cargo.toml:60-66` 定义 `[workspace.package]` 块：

```toml
[workspace.package]
version = "0.1.0"
edition = "2024"
license = "MIT"
```

所有 Rust crate 通过 `version.workspace = true` 继承此版本。这意味着 Rust 侧的版本管理是**单点控制**的，但 npm 侧是**多点控制**的（每个包各自维护 `package.json#version`）。

#### 2.1.2 semver 遵循现状

根 `CHANGELOG.md:5-6` 声明：

> The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

然而在代码层面，semver 仅仅是一个书面声明：

- **零递增历史**：自 `CHANGELOG.md:8` 记录的 `[0.1.0] - 2026-07-18` 以来，版本号从未发生过任何递增。项目累积的数百次 commit 均未触发版本变化。
- **无 major/minor/patch 决策准则**：没有任何文档定义什么级别的变更触发 major、什么触发 minor、什么触发 patch。对于处于 `0.x` 阶段的版本，semver 允许任意 breaking change，但未设置 pre-1.0 的版本策略。
- **无预发布标识**：`0.1.0` 没有使用任何预发布标签（如 `0.1.0-alpha.1`、`0.1.0-nightly.20260718`），无法区分不同质量的发布渠道。
- **无版本对比工具**：没有在 CI 中集成 semver-diff 或类似工具来自动检测 API 变更的兼容性。

#### 2.1.3 版本同步机制分析

项目中没有版本同步脚本。从根本上说，当版本需要递增时，开发者需要：

1. 手动修改根 `package.json` 的 `version` 字段
2. 手动修改所有 9 个子包的 `package.json#version` 字段
3. 手动修改 `Cargo.toml` 的 `[workspace.package] version`
4. 手动修改 `tauri.conf.json` 的 `version` 字段
5. 手动更新 `package-lock.json`（通过 `npm install --package-lock-only`）

这一过程在 10+ 个位置重复操作，极容易漏更新某个位置。

**不存在以下参考实现具有的能力**：
- 不存在 `scripts/sync-versions.js` 或类似脚本
- 不存在 `npm run version:patch`、`version:minor`、`version:major` 脚本
- 不存在 `npm version` 的 workspace 级别自动化命令
- `turbo.json`（`turbo.json`）的 pipeline 中空版本管理任务

**根 `package.json:17-68` 定义的 50+ npm scripts** 覆盖了 dev、build、check、test、bench、lint、format 等维度，但**完全没有任何版本管理或发布相关的脚本**。

---

### 2.2 包间依赖管理现状

#### 2.2.1 依赖声明方式的四分五裂

当前项目中对内部包（`@crish/*`）的依赖声明使用了**三种互不兼容的方式**，这是一个严重的不一致问题。

**方式 A：workspace 协议 `"*"` 通配符**

这种声明方式表明"使用 workspace 中最新版本"。在 `npm install` 后，npm workspace 会将此解析到本地包的路径。但它**完全不适合发布后的消费者使用**。

| 源包 | 声明位置 | 目标包 | 声明值 | 文件路径 |
|------|----------|--------|--------|----------|
| `@crish/agent-runtime` | dependencies | `@crish/decision-engine` | `"*"` | `packages/agent-runtime/package.json:41` |
| `@crish/agent-runtime` | devDependencies | `@crish/shared-utils` | `"*"` | `packages/agent-runtime/package.json:44` |
| `@crish/crish-desktop` | dependencies | `@crish/agent-runtime` | `"*"` | `apps/crish-desktop/package.json:26` |

**方式 B：`"file:../"` 本地路径协议**

这种声明方式使用了 npm 的本地文件协议。在开发环境中通过 npm link 机制工作，但是在 `npm publish` 时，npm 会原样保留 `file:` 协议的字符串，导致发布的包中的依赖指向消费者的本地文件系统——完全不可用。

| 源包 | 声明位置 | 目标包 | 声明值 | 文件路径 |
|------|----------|--------|--------|----------|
| `@crish/agent-daemon` | dependencies | `@crish/agent-orchestrator` | `"file:../agent-orchestrator"` | `packages/agent-daemon/package.json:33` |
| `@crish/agent-daemon` | dependencies | `@crish/agent-runtime` | `"file:../agent-runtime"` | `packages/agent-daemon/package.json:34` |
| `@crish/agent-daemon` | dependencies | `@crish/decision-engine` | `"file:../decision-engine"` | `packages/agent-daemon/package.json:35` |
| `@crish/agent-daemon` | dependencies | `@crish/shared-types` | `"file:../shared-types"` | `packages/agent-daemon/package.json:36` |
| `@crish/agent-daemon` | dependencies | `@crish/shared-utils` | `"file:../shared-utils"` | `packages/agent-daemon/package.json:37` |
| `@crish/agent-orchestrator` | dependencies | `@crish/agent-runtime` | `"file:../agent-runtime"` | `packages/agent-orchestrator/package.json:31` |
| `@crish/agent-orchestrator` | dependencies | `@crish/shared-utils` | `"file:../shared-utils"` | `packages/agent-orchestrator/package.json:32` |
| `@crish/agent-workbench` | dependencies | `@crish/agent-runtime` | `"file:../../packages/agent-runtime"` | `apps/agent-workbench/package.json:16` |
| `@crish/agent-workbench` | dependencies | `@crish/shared-types` | `"file:../../packages/shared-types"` | `apps/agent-workbench/package.json:17` |
| `@crish/agent-workbench` | dependencies | `@crish/shared-utils` | `"file:../../packages/shared-utils"` | `apps/agent-workbench/package.json:18` |
| `@crish/agent-workbench` | dependencies | `@crish/crish-desktop` | `"file:../crish-desktop"` | `apps/agent-workbench/package.json:19` |

**方式 C：硬编码版本号**

| 源包 | 声明位置 | 目标包 | 声明值 | 文件路径 |
|------|----------|--------|--------|----------|
| `@crish/decision-engine` | dependencies | `@crish/shared-types` | `"0.1.0"` | `packages/decision-engine/package.json:29` |

这是唯一一种在发布后可用的声明方式，但在版本递增时需要手动同步更新。

**方式散布统计**：在 10 个包中搜索内部依赖引用：

- `"*"` 出现 **3 次**（`agent-runtime` d1+d1dev, `crish-desktop` d1）
- `"file:../"` 出现 **11 次**（`agent-daemon` 5 处、`agent-orchestrator` 2 处、`agent-workbench` 4 处）
- 硬编码版本出现 **1 次**（`decision-engine` 1 处）

这三种方式的混用导致在发布准备阶段需要逐个定位并重写，且没有一个统一的转换脚本。

#### 2.2.2 peerDependencies 与 optionalDependencies

当前所有包均未使用 `peerDependencies` 或 `optionalDependencies`。`@crish/plugin-sdk` 本应将 `@crish/agent-runtime` 或核心类型声明为 peer dependency，以避免消费者安装多个版本的冲突，但目前完全没有此类声明。

#### 2.2.3 @crish/plugin-sdk 的特殊问题

`packages/plugin-sdk/package.json`（共 7 行）是项目中最简化的包：

```json
{
  "name": "@crish/plugin-sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

此包：
- 没有 `files` 字段指定发布内容
- 没有 `publishConfig` 设置 registry 或 access
- 没有构建脚本（`main`/`types` 直接指向 TypeScript 源文件）
- `main: "src/index.ts"` 意味着消费者需要 TypeScript 运行时支持
- 没有 `private: true`，但也不具备发布条件
- 没有声明任何依赖或 peerDependencies

作为计划中供外部插件开发者使用的 SDK，此包的发布准备度为零。

---

### 2.3 Changelog 管理现状

#### 2.3.1 单一根级 CHANGELOG

项目只有一个根级 `CHANGELOG.md`（`C:\Software\conex\CHANGELOG.md`），共 22 行，记录了从无到有的首次发布：

```
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-18

### Added
- **Monorepo Structure**: Organized the project into a workspace-based monorepo...
- **MIT Licensing**: ...
- **Documentation**: ...
```

关键问题：
- 仅一个版本入口 `[0.1.0]`，之后没有任何变更记录
- 手动编写，无法自动追踪每次 PR/commit 的变更
- 无 `[Unreleased]` 节，生命周期内无法累积待发布条目
- 无版本比较引用链接（`[Unreleased]: https://...` 不存在）
- 缺少包级粒度的变更视图，`packages/shared-types` 的 API 变更和 `apps/crish-desktop` 的 UI 变更混在同一文件中

#### 2.3.2 缺少包级 CHANGELOG

每个 npm 包没有独立的 changelog 文件。多包仓库中，根级 CHANGELOG 无法体现单个包的版本历史和 API 兼容性变化。当消费者只依赖 `@crish/agent-runtime` 时，TA 需要看到 `@crish/agent-runtime` 的独立 changelog，而不是包含整个 Crish 产品变化的混合日志。

#### 2.3.3 Changeset 配置处于休眠状态

`.changeset/config.json`（`C:\Software\conex\.changeset\config.json`）配置内容：

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

逐字段分析：

| 字段 | 值 | 现状问题 |
|------|----|----------|
| `$schema` | 指向 unpkg 的 changesets/config@3 | 正常，版本配置 |
| `changelog` | `"@changesets/cli/changelog"` | 使用内置 changelog 生成器，但从未触发 |
| `commit` | `false` | 不自动 commit changeset 文件，需手动管理 |
| `fixed` | `[]` | 无固定包组。意味着默认是 independent 版本模式 |
| `linked` | `[]` | 无链接组。fixed 和 linked 都为空，彻底无版本协同 |
| `access` | `"public"` | 声明 public access，但 9/10 包为 `private: true` |
| `baseBranch` | `"main"` | 正常，使用主分支 |
| `updateInternalDependencies` | `"patch"` | 内部依赖更新为 patch 级别 |
| `ignore` | `[]` | 不忽略任何包 |

**最关键的问题**：

1. **`.changeset/` 目录中仅有 `config.json`**，没有任何 `.md` changeset 文件。`@changesets/cli` 的设计是开发者在每次 PR 中创建 changeset 文件（通过 `npx changeset`），然后发布时由 `changeset version` 命令消费这些文件来自动递增版本和生成 changelog。当前这些文件从未被创建。

2. **`commit: false`** 意味着 `npx changeset version` 不会自动 commit，增加了额外步骤。

3. **`fixed: []` 和 `linked: []` 均为空** — 对于一个需要 lockstep 版本策略的项目（所有包当前版本相同），至少应该将核心包组设为 `fixed`。

4. **`@changesets/cli` 可能未安装**。根 `package.json:69-87` 的 devDependencies 中不包含 `@changesets/cli` 或 `@changesets/config`。changeset 功能不可直接使用。

---

### 2.4 发布流程现状

#### 2.4.1 版本号递增方式

当前完全不存在版本号递增的机制。根 `package.json:17-68` 的 50+ npm scripts 中，没有任何与版本管理或发布相关的定义。具体缺失：

- 不存在 `"version:patch": "npm version patch -ws --no-git-tag-version && node scripts/sync-versions.js"`
- 不存在 `"version:minor": "..."`
- 不存在 `"version:major": "..."`
- 不存在 `"release": "node scripts/release.mjs"`
- 不存在 `"publish": "node scripts/publish.mjs"`
- 不存在 `"prepublishOnly": "npm run check:all && npm run build:packages"`
- 不存在 `"preversion": "npm run check:all"`

`scripts/` 目录（`C:\Software\conex\scripts\`）内容：

```
acceptance-criteria.ts
bundle-daemon.mjs
check-no-as-any-store.mjs
compare-benchmarks.ts
generate-compatibility-matrix.ts
generate-perf-report.ts
generate-perf-summary.ts
generate-provider-index.ts
inapp-goal-smoke.mjs
qa/
run-native-benches.mjs
```

以上 10 个脚本 + 1 个 qa 目录涵盖了性能、兼容性、包验证等维度，但没有一个脚本涉及版本管理或发布。

#### 2.4.2 发布前检查

根 `package.json:49-67` 定义了几个质量检查命令：

```json
"check:core": "npm run check:runtime && npm run check:orchestrator && npm run check:daemon && npm run check:workbench && npm run check:desktop",
"check:runtime": "tsc -p packages/agent-runtime/tsconfig.json --noEmit",
"check:orchestrator": "tsc -p packages/agent-orchestrator/tsconfig.json --noEmit",
"check:daemon": "tsc -p packages/agent-daemon/tsconfig.json --noEmit",
"check:workbench": "npm --workspace @crish/agent-workbench run cli:check",
"typecheck": "tsc --noEmit --project apps/crish-desktop/tsconfig.json",
"check:desktop": "npm --workspace @crish/crish-desktop run typecheck",
"check:store-types": "node scripts/check-no-as-any-store.mjs",
"test:core": "vitest run packages/agent-runtime/src packages/agent-orchestrator/src packages/agent-daemon/src",
"test": "vitest run",
"test:coverage": "vitest run --coverage",
"lint:all": "eslint . --ext .ts,.tsx --max-warnings 0 && stylelint 'apps/crish-desktop/src/**/*.css'",
"lint": "eslint .",
"check:all": "npm run typecheck && npm run lint:all && npm run test:coverage"
```

这些命令的问题：

1. **`check:all` 不完整** — 它不包括 `check:core`（TypeScript 检查所有核心包）、不包括 `build:packages`（构建验证）、不包括 `lint`（只调用了 `lint:all` 但 `lint` 和 `lint:all` 有区别）。
2. **缺少构建产物验证** — 没有命令检查各个包的 `dist/` 目录是否存在、产物与 `files` 字段是否匹配。
3. **缺少 `npm pack --dry-run`** — 没有预检查包内容是否完整。
4. **缺少内务验证** — 没有确认无未提交修改、无 untracked 敏感文件。
5. **缺少依赖完整性检查** — 没有检查 `file:` 协议依赖是否已转换、`"*"` 通配符是否已替换为具体版本。

#### 2.4.3 发布执行方式

当前发布只能通过完全手动操作完成：

**场景：发布新版本 v0.2.0**

1. 开发者手动修改根 `package.json:3` 的 `version` 为 `"0.2.0"`
2. 开发者手动修改 `packages/agent-runtime/package.json:3` 的 `version`
3. 开发者手动修改 `packages/agent-daemon/package.json:3` 的 `version`
4. 开发者手动修改 `packages/agent-orchestrator/package.json:3` 的 `version`
5. 开发者手动修改 `packages/shared-types/package.json:3` 的 `version`
6. 开发者手动修改 `packages/shared-utils/package.json:3` 的 `version`
7. 开发者手动修改 `packages/decision-engine/package.json:3` 的 `version`
8. 开发者手动修改 `packages/plugin-sdk/package.json:3` 的 `version`
9. 开发者手动修改 `apps/crish-desktop/package.json:5` 的 `version`
10. 开发者手动修改 `apps/agent-workbench/package.json:3` 的 `version`
11. 开发者手动修改 `packages/decision-engine/package.json:29` 中的硬编码依赖版本 `"0.1.0"` → `"0.2.0"`
12. 开发者手动修改 `Cargo.toml:61` 的 workspace version
13. 开发者手动修改 `tauri.conf.json:4` 的 version
14. 开发者运行 `npm install --package-lock-only` 更新 lockfile
15. 开发者手动创建 changelog 条目
16. 开发者运行 `git tag v0.2.0`
17. 开发者推送 tag，触发 `release.yml`

这个过程至少涉及 **16 个手动步骤**，跨越 13+ 个文件，极易出错。

---

### 2.5 构建产物管理现状

#### 2.5.1 npm 包发布准备度

逐包评估 npm 发布准备度：

| 包名 | `private` | `files` | `publishConfig` | 构建产物 | 发布就绪 |
|------|-----------|---------|-----------------|----------|----------|
| `@crish/agent-runtime` | `true` | `["dist"]` | 无 | dist/ | **否** (private) |
| `@crish/agent-daemon` | `true` | `["dist"]` | 无 | dist/ | **否** (private) |
| `@crish/agent-orchestrator` | `true` | `["dist"]` | 无 | dist/ | **否** (private) |
| `@crish/shared-types` | `true` | `["dist"]` | 无 | dist/ | **否** (private) |
| `@crish/shared-utils` | `true` | `["dist"]` | 无 | dist/ | **否** (private) |
| `@crish/decision-engine` | `true` | `["dist"]` | 无 | dist/ | **否** (private) |
| `@crish/plugin-sdk` | 未设置 | 无 | 无 | 无（指向 src） | **否** |
| `@crish/crish-desktop` | `true` | 无 | 无 | dist/ (vite) | **否** (private) |
| `@crish/agent-workbench` | `true` | 无 | 无 | 无（Tauri shell） | **否** (private, 不应发布) |

`@crish/agent-workbench` 作为 Tauri 应用壳，不应发布到 npm（它使用 `@tauri-apps/cli` 构建桌面应用），但其余核心包（`agent-runtime`, `agent-daemon`, `agent-orchestrator`, `shared-types`, `shared-utils`, `decision-engine`）以及 `plugin-sdk` 应该是可发布的。

#### 2.5.2 Tauri 二进制构建与分发

`.github/workflows/release.yml`（`C:\Software\conex\.github\workflows\release.yml`）是唯一的官方发布工作流。其完整内容分析：

```yaml
on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2
      - run: npm ci
      - run: npm run build:packages
      - run: npm --workspace @crish/agent-workbench run tauri build
      - uses: actions/upload-artifact@v4
        with:
          name: release-${{ matrix.os }}
          path: apps/agent-workbench/src-tauri/target/release/bundle/

  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          draft: true
          files: |
            **/*.msi
            **/*.dmg
            **/*.AppImage
            **/*.deb
```

此工作流的差距：

1. **npm 发布缺失** — 完全不处理 npm 包发布
2. **无版本验证** — 不验证 tag 版本与 `package.json` 版本是否一致
3. **draft release** — 自动创建 draft release，需要人工发布
4. **无 changelog 集成** — 使用 `.github` 的 `generate_release_notes: true`（GitHub 自动生成），与项目自身的 changelog 脱节
5. **无代码签名** — Windows 二进制无 Authenticode 签名，macOS 无 notarization
6. **无 Tauri updater 端点** — 未配置 `tauri.conf.json` 的 `updater` 节

#### 2.5.3 Daemon 二进制打包

`scripts/bundle-daemon.mjs`（`C:\Software\conex\scripts\bundle-daemon.mjs`）将 daemon 的 JS bundle 嵌入 Tauri 资源目录：

```javascript
const daemonBundle = resolve(root, 'packages/agent-daemon/dist/index.js');
copyFileSync(daemonBundle, resolve(resourcesDir, 'crish-agent-daemon.bundle.js'));
```

此脚本：
- 仅复制 dist bundle，不生成独立可执行文件
- 不在 CI 中自动执行（不在 `release.yml` 中引用）
- 没有与 `npm run build:packages` 流水线集成
- 没有为不同平台（Windows/Linux/macOS）打对应二进制
- `package.json:29` 中的 `build:daemon-binary` 脚本使用此 bundle 操作，但 `release.yml` 中没有主动调用

#### 2.5.4 Rust Crate 发布状态

Cargo 工作区的 10 个 crates 和 `agent-provider-http` 从未发布到 crates.io。`cargo publish` 从未在 CI 或本地执行过。由于所有 crate 使用 `version.workspace = true`，发布时需要特殊处理（逐个 crate 发布且保持依赖正确）。

---

### 2.6 版本标签与 Git 管理现状

- **无版本标签**：当前仓库没有 `v*` 格式的版本标签。执行 `git tag` 返回空。
- **标签触发流程存在但未使用**：`release.yml:5-7` 声明了 `v*` tag 的触发条件，但由于没有 tag，该流程从未执行过。
- **无标签签名策略**：未使用 `git tag -s` 进行 GPG 签名。
- **无标签命名规范**：`v*` 通配符过于宽松，当存在多个发布渠道（npm v1.0.0、Tauri 二进制 v1.0.0、Rust crate v0.1.0）时无法区分。

---

### 2.7 发布渠道管理现状

- **无 nightly 渠道**：没有计划任务驱动的每日构建发布。
- **无 latest/stable 渠道**：没有 `latest` dist-tag 管理。
- **无 next/beta/rc 渠道**：没有预发布版的分发标签。
- **所有构建均为手动触发**：`release.yml` 需要手动推送 tag 触发。
- **npm dist-tag 管理完全缺失**：无 npm `--tag` 参数的使用经验。

---

### 2.8 CI/CD 集成现状

`.github/workflows/` 目录包含 4 个 workflow：

| Workflow 文件 | 触发条件 | 职责 | 覆盖发布流水线？ |
|--------------|----------|------|-----------------|
| `ci.yml` | push/PR 到 main/develop | Rust 检查、TS 检查、lint、测试、覆盖率、安全审计 | **否** |
| `release.yml` | push tag `v*` | Tauri 二进制构建 + GitHub Release | **部分**（仅二进制） |
| `perf-test.yml` | 未读取 | 性能测试 | **否** |
| `provider-validation.yml` | 未读取 | Provider 配置验证 | **否** |

`ci.yml` 虽然执行了测试和 lint，但它：
- 不包含所有包的构建验证
- 不执行 `build:packages` 完整链路
- 不检查 `npm pack --dry-run`
- 不验证 lockfile 完整性
- 不检查 `file:` 协议的遗留

---

### 2.9 文档与配置完整性

- **无发布检查清单**：无 `RELEASING.md` 或 `CONTRIBUTING.md` 中的发布章节。
- **无版本策略文档**：无文档定义 major/minor/patch 的边界条件。
- **无 `.npmrc` 文件**：没有 npm registry、认证、provenance 等默认配置。
- **无 `engines` 声明**：根 `package.json` 未设置 `engines.node` 最小版本要求（参考实现中声明 `>=22.19.0`）。
- **ROADMAP.md 和 ARCHITECTURE.md** 不包含发布相关的里程碑或架构描述。

---

## 3 差距深度分析

### 3.1 版本同步：跨包版本一致性

**现状**：虽然巧合所有包处于同一个版本 `0.1.0`，但没有任何机制保证版本同步。如果有某个包被独立递增而其他包未更新，这种一致性将立即丧失。

**差距 G-VER-01**：缺少版本同步脚本。
- 当前没有类似 `sync-versions.js` 的自动化工具来读取所有包的 package.json、验证版本一致性、并在包间依赖中同步版本号。
- 具体而言，缺少的能力包括：读取 workspace 内所有包的版本、构建版本映射、验证 lockstep 一致性、更新交叉依赖中的版本声明。
- 影响：版本漂移——某个包被递增后，依赖该包的其他包中的版本声明会过时，导致发布后的消费者安装到不兼容的版本组合。

**差距 G-VER-02**：缺少 `npm version` 的 workspace 级别封装。
- `npm version patch -ws --no-git-tag-version` 可以批量递增所有 npm workspace 包的版本，但当前没有任何 npm script 封装此操作。
- 缺少的脚本应包括：`version:patch`、`version:minor`、`version:major`，且每个脚本在执行后应运行版本同步和 lockfile 刷新。
- 影响：递增版本需要手动编辑 9+ 个 `package.json` 文件，难以保证一致性。

**差距 G-VER-03**：Cargo 工作区和 npm 工作区的版本解耦。
- Cargo 工作区通过 `[workspace.package] version = "0.1.0"`（`Cargo.toml:61`）管理统一版本，所有 Rust crate 通过 `version.workspace = true` 继承此版本。
- npm 侧是分散管理（每个包各自维护版本）。
- 发布时需要同时更新两个系统，但两个系统的位置不同、更新方式不同（Cargo 只需改一处，npm 需改 9+ 处）。
- 影响：容易发生 npm 版本和 Cargo 版本不一致的情况，且没有 Cross-Version 验证。

**差距 G-VER-04**：Tauri 配置中版本与 npm/Cargo 版本分离。
- `apps/agent-workbench/src-tauri/tauri.conf.json:4` 中的 `version` 字段是独立的字符串。
- 没有预提交 hook 或构建脚本来自动同步此版本与 Cargo workspace version 一致。
- 影响：桌面应用的版本号可能滞后于代码版本。

**差距 G-VER-05**：`package-lock.json` 中的版本同步。
- 根 `package-lock.json:3` 记录了根包的版本。当版本递增时，需要通过 `npm install --package-lock-only` 更新 lockfile，但当前流程中未包含此步骤。

### 3.2 依赖声明：workspace 协议 vs 硬编码

**差距 G-DEP-01**：`file:` 协议的依赖在发布时完全失效。
- 当 `@crish/agent-daemon` 声明 `"@crish/agent-runtime": "file:../agent-runtime"`（`packages/agent-daemon/package.json:34`），在执行 `npm publish` 时，npm 会将 `file:` 协议原样打包到发布的 tarball 中。
- 消费者安装 `@crish/agent-daemon` 时，npm 会尝试解析 `file:../agent-runtime` 为消费者机器上的路径，这个路径不存在，安装失败。
- 受影响的包：`agent-daemon`（5 个 `file:` 依赖）、`agent-orchestrator`（2 个）、`agent-workbench`（4 个）。
- 严重性：P0 —— **直接阻塞发布**。

**差距 G-DEP-02**：`"*"` 通配符在发布后无法确定版本。
- `@crish/agent-runtime: "*"`（`apps/crish-desktop/package.json:26`）和 `@crish/decision-engine: "*"`（`packages/agent-runtime/package.json:41`）在 workspace 内会被 npm link 到本地包，但发布后的消费者执行 `npm install` 时，`"*"` 会被解析为 registry 上满足 `*` 范围的最新版本。
- 如果类似 `@crish/agent-runtime` 的包也发布了，消费者会安装到不兼容的版本。
- 如果类似的包从未发布（仅内部使用），消费者安装会直接失败（package not found）。
- 严重性：P0 —— **直接阻塞发布**。

**差距 G-DEP-03**：硬编码版本号 `"0.1.0"`（`packages/decision-engine/package.json:29`）在版本升级时不会自动更新。
- 当前 `@crish/decision-engine` 依赖 `@crish/shared-types: "0.1.0"`，当 `shared-types` 升级到 `0.2.0` 时，此依赖声明不会自动更新。
- 需要手动同步脚本或发布前检查来确保所有内部依赖版本匹配。

**差距 G-DEP-04**：`@crish/plugin-sdk`（`packages/plugin-sdk/package.json`）缺少发布必要配置。
- 无 `files` 字段 → 默认发布所有非 `.gitignore` 文件，包含源文件、测试、node_modules 等。
- 无 `publishConfig` → 无法指定 registry、access 级别。
- 无 `main`/`types` 指向构建后产物（当前指向 `src/index.ts`）。
- 无构建脚本 → 消费者需要自行编译 TypeScript。
- 严重影响 SDK 的分发，使插件开发者无法通过 `npm install @crish/plugin-sdk` 使用。

### 3.3 Changelog：自动化 vs 手动

**差距 G-CHG-01**：没有自动化 changelog 收集机制。
- Changeset 未集成进开发工作流，不存在以下流程：`git checkout -b feature-x` → 创建 changeset → 提交 PR → 合并 → 发布时自动消费 changeset。
- 开发者没有通道记录变更，导致发布时需要手动回溯所有 PR 和 commit。
- 示例：一个更改了 `@crish/agent-runtime` 的工具调用接口和 `@crish/shared-types` 的类型的 PR，应该创建包含两个 bump 声明的 changeset 文件。当前无此流程。

**差距 G-CHG-02**：每个包缺少独立 CHANGELOG。
- `packages/agent-runtime/CHANGELOG.md`、`packages/agent-daemon/CHANGELOG.md` 等文件均不存在。
- 根 CHANGELOG 混合同步变更，对只关心特定包的开发者不友好。
- 每个包的版本变化和 API 历史应记录在各自的 changelog 中，便于消费者追踪。

**差距 G-CHG-03**：缺少 `[Unreleased]` 节管理。
- 当前 CHANGELOG 没有 `[Unreleased]` 节，无法在开发周期内累积待发布的变更条目。
- 标准的 Keep a Changelog 模式要求在文件顶部始终有一个 `## [Unreleased]` 节，当发布时将其替换为版本号和日期。

**差距 G-CHG-04**：Changeset 配置 `access: "public"` 与所有包 `private: true` 矛盾。
- `.changeset/config.json:7` 设置 `"access": "public"`，但 9/10 个包设置了 `"private": true`。
- Changeset 在尝试更新 `private: true` 的包时可能不会写入 changelog 或递增版本，导致配置与实际不一致。

**差距 G-CHG-05**：`@changesets/cli` 未声明为依赖。
- 根 `package.json:69-87` 的 devDependencies 中不包含 `@changesets/cli` 或其相关包（`@changesets/config` 的 runtime 依赖）。
- 即使 `.changeset/config.json` 存在，也无法直接使用 `npx changeset`。

### 3.4 发布检查：构建验证、测试运行、lint 检查

**差距 G-CHK-01**：缺少 `prepublishOnly`/`preversion` 脚本。
- `package.json` 中未定义 `prepublishOnly` 或 `preversion` npm lifecycle hooks。
- 标准化做法是在版本递增前执行完整的检查流水线：lint → test → build → pack --dry-run。
- 当前即便手动递增版本，也缺乏强制执行的检查关卡。

**差距 G-CHK-02**：构建产物验证缺失。
- 发布前应检查各包 `dist/` 目录是否存在、内容物是否与 `package.json#files` 字段匹配。
- 应运行 `npm pack --dry-run` 验证即将发布的 tarball 内容，确保不包含敏感文件（`.env`、`node_modules`、源文件等）。
- 应验证 `main`/`types`/`exports` 字段指向的路径在 dist 中确实存在。

**差距 G-CHK-03**：缺少包间依赖完整性检查。
- 发布前应验证所有 `@crish/*` 内部依赖的版本在 registry 中已存在或将被同一批发布。
- 应检查 `file:` 和 `"*"` 声明是否已被替换为合法的 semver range。
- 应检查 `private: true` 与发布目标的兼容性。

**差距 G-CHK-04**：缺少 workspace 间的构建顺序验证。
- 当前 `build:packages` 命令（`package.json:27`）硬编码了构建顺序：`shared-types` → `shared-utils` → `decision-engine` → `agent-runtime` → `agent-orchestrator`。
- 未验证此顺序是否准确反映实际的依赖图（DAG）。
- 未在 CI 中验证构建顺序的完整性——如果新增一个包但未更新构建顺序，可能导致 CI 通过但构建产物不完全。

### 3.5 签名与认证

**差距 G-SIG-01**：缺少 npm provenance。
- 无 `--provenance` 标志的使用（参考实现的 `publish.mjs:113` 使用 `--provenance`）。
- `.github/workflows/release.yml:50-51` 的 `publish` job 仅有 `contents: write` 权限，未设置 `id-token: write`。
- `publishConfig` 中未设置 `provenance: true`。
- 影响：消费者无法验证 npm 包的构建来源，不符合供应链安全最佳实践。

**差距 G-SIG-02**：Git tag 未签名。
- 未使用 `git tag -s`（GPG 签名）创建版本标签。
- 无 GPG 密钥配置文档。
- 影响：版本标签的完整性和作者身份无法验证。

**差距 G-SIG-03**：Tauri 二进制未签名。
- `release.yml` 无 Windows Authenticode 代码签名步骤。
- 无 macOS notarization 步骤。
- 影响：用户可能在安装时遇到操作系统安全警告（Windows SmartScreen、macOS Gatekeeper）。

**差距 G-SIG-04**：缺少 npm registry 认证配置。
- 无 `.npmrc` 文件。
- 未配置默认 registry 或发布目标 registry。
- 未配置 `publishConfig.registry` 在任何包的 `package.json` 中。

### 3.6 二进制分发

**差距 G-BIN-01**：缺少自动更新机制。
- Tauri 的自动更新功能需要配置 `tauri.conf.json` 的 `updater` 节，但当前 `tauri.conf.json`（`C:\Software\conex\apps\agent-workbench\src-tauri\tauri.conf.json`）完全没有 `updater` 字段。
- 缺少后端更新服务器端点（或 GitHub Release 作为更新源）。
- 影响：已安装的桌面应用无法自动更新到新版本。

**差距 G-BIN-02**：Daemon 未独立分发。
- `scripts/bundle-daemon.mjs` 仅将 daemon JS bundle 嵌入 Tauri 资源目录，没有通过 npm 包或独立二进制分发。
- daemon 作为 standalone 进程的情况下（在 Tauri 之外运行），没有独立的安装渠道。
- `npm run build:daemon-binary`（`package.json:29`）引用 bundle-daemon.mjs，但执行完仅得到嵌入资源的拷贝，不产出独立可安装的产物。

**差距 G-BIN-03**：Rust crate 发布空白。
- 10 个核心 crates（`conex-types`、`conex-ipc`、`conex-stream`、`conex-search` 等）+ `agent-provider-http` 从未发布到 crates.io。
- Rust 生态中，库 crate 通常是独立发布的，便于其他 Rust 项目使用。
- `cargo publish` 流程未建立，且由于 `version.workspace = true` 的使用，发布时需要特殊处理。

**差距 G-BIN-04**：缺少跨平台构建矩阵的覆盖面评估。
- `release.yml:14-15` 的 build job 覆盖 ubuntu/windows/macos latest，但没有明确记录每个平台支持的架构（x64/arm64）。
- 缺少 `.rpm`、`.snap` 等 Linux 打包格式的支持。

### 3.7 版本策略

**差距 G-STR-01**：未定义 semver 边界。
- 没有文档定义什么变更属于 major（breaking change）、minor（新功能）、patch（bug 修复）。
- 对于处于 `0.x` 阶段的包（pre-1.0），semver 规范允许任意 breaking change 以 minor 递增，但项目未记录是否遵循此惯例。
- 没有约定 API 兼容性保证——哪些部分是公开 API，哪些是内部实现细节。

**差距 G-STR-02**：未定义预发布版本策略。
- 没有 nightly、alpha、beta、rc 等预发布阶段的命名规范和时间窗口。
- 没有预热期（stabilization period）的概念。

**差距 G-STR-03**：未定义 lockstep vs independent 版本策略。
- 当前所有包同版本暗示 lockstep 策略，但无强制执行机制。
- `fixed` 组未在 changeset 配置中设置。
- 有些包（`plugin-sdk`）可能需要独立于 core 包的版本节奏，但文档未记录。

**差距 G-STR-04**：未定义版本发布的最小间隔。
- 没有冷却期策略——两次 major 版本之间应间隔多久？minor 和 patch 是否有频率限制？

### 3.8 标签管理

**差距 G-TAG-01**：缺少统一标签命名规范。
- `release.yml` 使用 `v*` 通配符触发，但没有明确 `v` 前缀代表什么——是 npm 包版本？Tauri 应用版本？还是整体项目版本？
- 当需要为不同组件打不同标签时（如 `npm/v1.0.0` vs `tauri/v2.0.0` vs `crates/v0.1.0`），当前单一 `v*` 模式无法处理。

**差距 G-TAG-02**：标签未在发布流程中自动创建。
- `release.yml` 由外部 tag push 触发，但不参与 tag 的创建。
- 没有脚本来自动创建和推送标签，需要手动执行。

### 3.9 发布流水线整体

**差距 G-PLN-01**：构建、测试、发布、通知等环节未编排成完整的流水线。
- 当前工作流是碎片化的：`ci.yml` 负责 CI、`release.yml` 负责 Tauri 构建——两者之间没有协调。
- 没有端到端的发布流水线：从"决定发布"到"版本递增 → changelog 生成 → 构建 → 测试 → npm publish → 二进制构建 → GitHub Release → 通知"全部串联。

**差距 G-PLN-02**：缺少回滚方案。
- 如果发布后发现严重问题，没有 `npm dist-tag` 回滚策略（将 `latest` 指回上一个版本）。
- 没有 npm deprecate 策略（`npm deprecate @crish/agent-runtime@"<0.2.0" "..."`）。

**差距 G-PLN-03**：缺少通知机制。
- 发布成功或失败没有自动通知（Slack/邮件/Webhook）。
- `release.yml` 中无通知步骤，错误发生时不易感知。

**差距 G-PLN-04**：缺少发布候选人（Release Candidate）流程。
- 没有 RC 版本 → 测试 → 推广到 stable 的分阶段流程。
- 变更直接从 main 分支发布到生产，缺乏隔离验证。

---

## 4 具体代码证据

以下列出 30 个具体文件路径，涵盖上述所有差距点的证据来源：

| # | 文件路径 | 关键行/段 | 关联差距 |
|---|----------|-----------|----------|
| 1 | `package.json:3` | `"version": "0.1.0"` | G-VER-01, G-VER-02 |
| 2 | `package.json:7-16` | workspaces 声明 8 个子目录 | G-DEP-01, G-DEP-02 |
| 3 | `package.json:17-68` | scripts 无版本/发布命令 | G-VER-02, G-PLN-01 |
| 4 | `package.json:69-87` | devDependencies 无 `@changesets/cli` | G-CHG-05 |
| 5 | `packages/agent-daemon/package.json:33-37` | 5 个 `file:` 协议依赖 | G-DEP-01 |
| 6 | `packages/agent-daemon/package.json:3` | `"private": true` | G-PLN-01, G-CHG-04 |
| 7 | `packages/agent-runtime/package.json:41` | `"*"` 通配符依赖 | G-DEP-02 |
| 8 | `packages/agent-runtime/package.json:44` | devDependencies `"*"` | G-DEP-02 |
| 9 | `packages/decision-engine/package.json:29` | 硬编码 `"0.1.0"` | G-DEP-03 |
| 10 | `apps/crish-desktop/package.json:26` | `"*"` 通配符依赖 | G-DEP-02 |
| 11 | `apps/agent-workbench/package.json:16-19` | 4 个 `file:` 路径依赖 | G-DEP-01 |
| 12 | `packages/plugin-sdk/package.json` | 整文件（无 files/publishConfig/build） | G-DEP-04 |
| 13 | `CHANGELOG.md:8` | 唯一的 `[0.1.0]` 入口 | G-CHG-01, G-CHG-03 |
| 14 | `.changeset/config.json:5` | `commit: false` | G-CHG-01 |
| 15 | `.changeset/config.json:6-7` | `fixed: []`, `linked: []` 全空 | G-VER-01, G-STR-03 |
| 16 | `.changeset/` | 目录内容仅有 `config.json` | G-CHG-01 |
| 17 | `Cargo.toml:61` | workspace version `"0.1.0"` | G-VER-03 |
| 18 | `apps/agent-workbench/src-tauri/tauri.conf.json:4` | `"version": "0.1.0"` | G-VER-04 |
| 19 | `.github/workflows/release.yml:5-7` | `on: push: tags: ['v*']` | G-PLN-01 |
| 20 | `.github/workflows/release.yml:50` | `permissions: { contents: write }` 缺 id-token | G-SIG-01 |
| 21 | `.github/workflows/release.yml:39-44` | 仅 Tauri build，无 npm publish | G-PLN-01 |
| 22 | `.github/workflows/ci.yml` | 整文件不含发布检查 | G-CHK-01 |
| 23 | `turbo.json:3-30` | pipeline 不含版本/发布任务 | G-PLN-01 |
| 24 | `scripts/` | 目录内容无发布脚本 | G-VER-02, G-PLN-01 |
| 25 | `scripts/bundle-daemon.mjs:13-20` | 仅文件复制，无独立打包 | G-BIN-02 |
| 26 | `Cargo.toml:60-66` | `[workspace.package]` 定义 | G-VER-03 |
| 27 | `apps/agent-workbench/src-tauri/tauri.conf.json` | 无 `updater` 节 | G-BIN-01 |
| 28 | `package-lock.json:3` | lockfile version `"0.1.0"` | G-VER-05 |
| 29 | `packages/agent-orchestrator/package.json:31-32` | 2 个 `file:` 协议依赖 | G-DEP-01 |
| 30 | `packages/agent-orchestrator/package.json:3` | `"private": true` | G-PLN-01 |

---

## 5 根因分析与影响评估

### 5.1 根因分析

**根因 R1：项目处于 pre-release 阶段，版本管理未被纳入工程纪律。**

当前项目自初始化以来累计了数百次 commit、数十个分支和 PR，但版本号从未递增。这一事实表明版本管理没有被视为开发流程的一部分。所有包锁定在 `0.1.0` 意味着没有"发布"这个心智模型——代码变更从不被视为"需要通知消费者的 API 变化"。

**影响**：缺少版本管理的纪律惯性意味着即使引入了自动化工具，也需要文化转变来维持版本管理习惯（如创建 changeset）。

**根因 R2：对 npm workspace 协议的理解不完整导致依赖声明混乱。**

`file:` 协议和 `"*"` 通配符的混用反映出团队不清楚 workspace 协议的语义：
- `file:` 适用于本地开发链接，但在发布时必须转换为规范的 semver range
- `"*"` 在工作区内表示"使用本地版本"，但在发布包中表示"使用 registry 上的任意版本"
- 硬编码版本解决了前两个问题，但带来了手动同步负担

三种方式的混用暴露了团队在 workspace 包版本管理方面的经验不足。

**根因 R3：构建系统隔离导致版本管理复杂度翻倍。**

项目同时使用 npm workspace (`turbo.json`) 和 Cargo workspace (`Cargo.toml`)，两个系统独立管理版本：
- npm 侧：9 个包各维护自己的 `package.json#version`
- Cargo 侧：`[workspace.package] version` 单一控制点

版本发布需要同时协调两个系统，且两个系统之间没有数据流动——没有一个发布脚本能同时更新 npm 版本和 Cargo 版本。

**根因 R4：Changeset 引入后未投入使用。**

`.changeset/config.json` 的存在说明团队曾评估或开始引入 changeset 体系。但：
- `@changesets/cli` 可能未安装在 devDependencies 中
- 没有将 `npx changeset` 集成到 PR 流程
- `commit: false` 使其在 CI 中不能自动 commit 生成的版本文件
- `fixed: []` 和 `linked: []` 空置说明没有配置 lockstep 策略

changeset 处于"半配置、零使用"的状态。

**根因 R5：发布流程被认为与 CI 无关。**

当前的 `release.yml` 设计为仅服务 Tauri 二进制构建，npm 包发布完全不在 CI 的考量范围内。这种设计选择暗示团队认为 npm 发布要么不需要、要么应该手动执行。

**根因 R6：缺乏对 npm 现代发布能力的了解。**

没有使用 `--provenance`、没有 OIDC 配置、没有 `publishConfig`、没有 dist-tag 管理策略——说明团队未接触过 npm 的现代发布范式。npm 在 2023+ 引入了可信发布（provenance）和更严格的包签名要求，本项目在这方面是空白的。

**根因 R7：版本策略未形成书面共识。**

没有文档讨论版本管理的核心决策问题：lockstep vs independent？pre-1.0 的版本策略？nightly 发布的频率？版本策略的缺失使得任何版本管理实现都缺乏指导原则。

### 5.2 影响评估

| 影响域 | 严重程度 | 具体影响 |
|--------|----------|----------|
| **发布能力** | **阻断性 (P0)** | 当前无法执行任何 npm 发布。所有核心包（`agent-runtime`、`agent-daemon`、`agent-orchestrator`、`shared-types`、`shared-utils`、`decision-engine`）均为 `private: true`，且依赖声明方式（`file:` 和 `"*"`）不兼容发布格式。唯一非 private 的 `plugin-sdk` 缺少构建和发布配置。 |
| **消费者体验** | **高 (P0)** | 即使成功发布，发布的包中包含 `file:` 协议依赖（如 `agent-daemon` 依赖链）会导致消费者 `npm install` 时崩溃。 |
| **团队协作** | **中 (P1)** | 无 automated changelog 收集机制，每次 PR 的变更不会被自动追踪。发布时需要人工回溯 commits，容易遗漏变更记录。 |
| **软件供应链安全** | **中 (P1)** | 无 npm provenance/ODIC，包的来源无法被消费者验证。无代码签名，桌面应用在 Windows 和 macOS 上会触发安全警告。 |
| **发布可维护性** | **高 (P1)** | 手动版本管理在大版本迭代时极易出错。v0.1.0 → v0.2.0 需要编辑 13+ 个文件，漏更新任何一个都会导致不一致。 |
| **自动化程度** | **高 (P1)** | 零自动化。每次发布预计需要 30-60 分钟的重复性手动操作，包括编辑、提交、打 tag、推送、监控 CI。 |
| **版本兼容性** | **中 (P2)** | 无 semver 策略文档，无法向消费者传达变更的兼容性级别。消费者无法确定升级是否安全。 |
| **社区贡献** | **中 (P2)** | 无发布流水线意味着无发布频率保证，外部贡献者无法预期下一版本的发布时间。无 nightly 渠道，贡献者无法尽早测试其变更。 |
| **桌面分发** | **中 (P2)** | Tauri 应用无 updater 配置，已安装用户无法自动更新。无代码签名会降低用户信任。 |
| **Rust 生态集成** | **低 (P3)** | 10 个 crates 未发布到 crates.io，其他 Rust 项目无法依赖 conex 的数据结构和工具。 |

### 5.3 差距优先级矩阵

| 差距 ID | 差距描述 | 优先级 | 解决难度 | 依赖关系 |
|---------|----------|--------|----------|----------|
| G-DEP-01 | `file:` 协议依赖阻塞发布 | **P0** | 低 | 依赖 G-VER-01 |
| G-DEP-02 | `"*"` 通配符在发布后失效 | **P0** | 低 | 依赖 G-VER-01 |
| G-VER-01 | 缺少版本同步脚本 | **P0** | 中 | 无 |
| G-VER-02 | 缺少版本递增命令 | **P0** | 低 | 依赖 G-VER-01 |
| G-CHG-01 | 无 automated changelog | **P1** | 中 | 依赖 G-VER-01, G-VER-02 |
| G-DEP-04 | plugin-sdk 发布配置缺失 | **P1** | 低 | 无 |
| G-SIG-01 | 无 npm provenance | **P1** | 低 | 依赖 G-PLN-01 |
| G-PLN-01 | 无完整发布流水线 | **P1** | 高 | 依赖 G-VER-01..G-VER-04, G-DEP-01..G-DEP-03 |
| G-CHK-01 | 无发布前检查 | **P2** | 低 | 无 |
| G-VER-03 | Cargo/npm 版本解耦 | **P2** | 中 | 依赖 G-VER-01 |
| G-VER-04 | Tauri 版本无同步 | **P2** | 低 | 依赖 G-VER-03 |
| G-BIN-01 | 无 Tauri updater | **P2** | 中 | 依赖 G-PLN-01 |
| G-STR-01 | 无版本策略文档 | **P2** | 低 | 无 |
| G-SIG-03 | 二进制无代码签名 | **P3** | 高 | 依赖 G-PLN-01 |
| G-TAG-01 | 标签规范缺失 | **P3** | 低 | 无 |
| G-PLN-02 | 无回滚方案 | **P3** | 低 | 依赖 G-PLN-01 |
| G-PLN-03 | 无发布通知 | **P3** | 低 | 依赖 G-PLN-01 |
| G-BIN-03 | Rust crate 未发布 | **P3** | 中 | 依赖 G-VER-03 |

---

## 6 与现有工作流的冲突分析

### 6.1 与 husky / lint-staged 的冲突

根 `package.json:18` 声明了 `"prepare": "husky"`，`.husky/` 目录存在预提交检查。当前 `check:core`、`check:all` 等命令会依序执行多个检查步骤。发布流水线引入后：

- **可能的冲突**：`lint-staged` 中的步骤如果包含不兼容发布的检查（如禁止修改 `package.json`），会阻止发布脚本自动更新版本。
- **解决方案**：发布脚本使用 `--no-verify` 标志绕过 pre-commit hook，或者将版本修改列入 lint-staged 的允许列表。

### 6.2 与 `dependency-cruiser` 的冲突

根 `package.json:73` 声明了 `dependency-cruiser` 作为 devDependency。该工具用于验证模块依赖关系，但如果其配置禁止了某些跨包引用模式，可能与发布构建产生冲突。

### 6.3 与 esbuild bundle 配置的冲突

`packages/agent-runtime/package.json:37` 使用 esbuild 将包打包为单一 bundle 文件。打包后的 bundle 丢失了源文件结构，导致：
- TypeScript 类型声明（`dist/*.d.ts`）与 bundle JS 的位置对应关系需要确认
- `exports` 字段中的子路径导出（如 `./plugin-registry`）在 bundle 模式下可能不工作
- 发布时 `files: ["dist"]` 需要确保 bundle 路径与 `main`/`exports` 声明一致

### 6.4 与 Tauri 构建的集成冲突

`release.yml:38-39` 调用 `npm --workspace @crish/agent-workbench run tauri build`，此命令内部会：
- 执行 `beforeBuildCommand: "npm run build"`（`tauri.conf.json:10`）
- 构建 frontend（vite）
- 编译 Rust 后端

这些步骤在发布流水线中可能与本地的 `build:packages` 产生不一致的构建产物。

### 6.5 与 ts-rs 代码生成的版本关联

项目中使用 `ts-rs`（`crates/conex-types/Cargo.toml:15`）从 Rust 结构体生成 TypeScript 类型。如果 Rust crate 的 API 发生变化但发布的 npm 包中的类型没有重新生成，会导致 TS 类型与 Rust 运行时行为不一致。发布流水线应确保在 Rust crate 变更时重新运行 `ts-rs` 代码生成。

---

## 7 术语对照

| 术语 | 在本项目中的含义 |
|------|-----------------|
| lockstep 版本 | 所有 `@crish/*` 包使用同一版本号同步发布 |
| independent 版本 | 每个 `@crish/*` 包独立管理版本号 |
| workspace 协议 | npm workspace 内使用的 `"*"` 或 `"file:../"` 依赖声明方式 |
| npm dist-tag | npm 包的分发标签（如 `latest`、`next`、`nightly`） |
| npm provenance | npm 包来源证明机制，通过 GitHub OIDC 实现 |
| Tauri updater | Tauri 内置的应用自动更新机制，需要配置 `tauri.conf.json` |
| changeset | `@changesets/cli` 管理的变更文件（`.md`），用于生成 changelog |
| nightly | 每日构建的预发布版本，使用 `-nightly.TIMESTAMP` 格式 |
| sidecar | Tauri 应用中捆绑的辅助可执行文件 |
| OIDC | OpenID Connect，GitHub Actions 用于向 npm 提供身份证明的协议 |
| dist-tag | npm 包的安装标签，`npm install pkg@latest` 中的 `latest` |
| prepublishOnly | npm lifecycle hook，在 `npm publish` 前执行的脚本 |

---

## 7 结论

Conex 项目的版本管理与发布流水线目前处于**完全空白**的状态。虽然有 `.changeset/config.json` 的配置文件痕迹和 `.github/workflows/release.yml` 的二进制构建流程，但两者都不足以支撑一个完整的发布体系。

最紧迫的差距（P0）集中在依赖声明的一致性和版本管理的自动化基础——这些是任何发布活动的前提条件。在它们被解决之前，项目无法执行任何有意义的 npm 发布。

P1 差距涵盖了 changelog 自动化、发布流水线构建和基本的安全能力（provenance），是项目从"手动发布"过渡到"自动化发布"的关键。

P2 和 P3 差距聚焦于生态集成（Cargo、Tauri updater、Rust crate）和工程体验（文档、标签规范、回滚方案），在 P0/P1 解决后可以逐步完善。

本文档的对应方案请参见 `analysis/release_pipeline_improvement_plan.md`。
