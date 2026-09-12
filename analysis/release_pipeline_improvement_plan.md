# 版本管理与发布改进方案

## 1 设计原则

### 1.1 核心原则

**原则 PR-01：Lockstep 版本策略。** 所有 `@crish/*` 可发布包（`agent-runtime`、`agent-daemon`、`agent-orchestrator`、`shared-types`、`shared-utils`、`decision-engine`、`plugin-sdk`）使用同一版本号同步发布。Cargo workspace 版本与之对齐。唯一例外是 `@crish/crish-desktop`（作为 Tauri 的前端 UI，随 Tauri app 一起发布）和 `@crish/agent-workbench`（Tauri 壳，不应独立发布到 npm）。

**原则 PR-02：Workspace 协议统一。** 所有内部包依赖统一使用 `"workspace:^"` 协议声明，发布时由专用脚本将其转换为 `"^VERSION"` 格式的 semver range。彻底消除 `file:` 和 `"*"` 的混用。

**原则 PR-03：Changelog 自动化。** 使用 changeset 体系收集变更，发布时自动生成每个包的 CHANGELOG.md。开发者通过 `npx changeset` 记录变更，发布时由 CI 自动消费。

**原则 PR-04：发布流水线完全自动化。** 从版本递增、changelog 生成、构建验证、npm publish 到 GitHub Release，整个流程在 CI 中自动完成，不需要人工介入（除手动审批外）。

**原则 PR-05：分渠道发布。** 支持 nightly（每日自动构建）和 latest（稳定发布）两个渠道。Nightly 允许早期使用者和贡献者测试最新变更；Latest 提供给生产使用者。

**原则 PR-06：安全优先。** 发布过程中使用 npm provenance 验证包来源、对 Git tag 进行 GPG 签名、对桌面应用二进制进行代码签名。

**原则 PR-07：自洽使用项目自身的包名和术语。** 所有脚本、配置、文档使用 `@crish/*` 包名和 Conex/Crish 术语。

---

## 2 目标发布流水线架构

### 2.1 版本策略

#### 2.1.1 semver 遵从

项目采用语义化版本 2.0.0。对于当前处于 `0.x` 阶段的版本，遵循 semver 规范的 pre-1.0 规则：**minor 递增代表可能包含 breaking changes，patch 递增代表 bug 修复和向后兼容的新功能**。

版本格式：
```
X.Y.Z[-PRERELEASE[.N]]
```

其中：
- `X` (major)：不兼容的 API 变更。1.0.0 之前不使用 major 递增。
- `Y` (minor)：向后兼容的新功能；在 0.x 阶段代表任何级别的变更。
- `Z` (patch)：向后兼容的 bug 修复。
- `PRERELEASE`：预发布标识，可选值为 `nightly`。
- `N`：预发布版本号，对于 nightly 使用 Unix 时间戳。

**版本递增决策表：**

| 变更类型 | 当前阶段 (0.x) | 发布后 (>=1.0) |
|----------|---------------|----------------|
| Breaking API 变更 | minor | major |
| 新功能 (向后兼容) | minor | minor |
| Bug 修复 | patch | patch |
| 内部重构 (无 API 变化) | patch | patch |
| 依赖更新 | patch | patch |
| 文档/CI 变更 | 不变 | 不变 |

#### 2.1.2 Lockstep 版本管理

所有 `@crish/*` npm 包共享同一版本号。版本管理使用以下机制确保 lockstep：

- `@changesets/cli` 的 `fixed` 配置将所有核心包加入固定组
- 发布脚本（`scripts/release.mjs`）验证所有包版本一致后再执行后续步骤
- 版本同步脚本（`scripts/sync-versions.js`）在所有包之间同步版本

Lockstep 组定义：

```json
// .changeset/config.json
{
  "fixed": [
    ["@crish/agent-runtime", "@crish/agent-daemon", "@crish/agent-orchestrator",
     "@crish/shared-types", "@crish/shared-utils", "@crish/decision-engine",
     "@crish/plugin-sdk"]
  ]
}
```

`@crish/crish-desktop` 不在此组中——它作为 Tauri 应用的前端，版本由 Tauri 二进制管理。`@crish/agent-workbench` 是 Tauri 壳，不应发布。

#### 2.1.3 Cargo 版本同步

Cargo workspace 的 `[workspace.package] version`（`Cargo.toml:61`）在发布时自动与 npm 版本同步。发布脚本会：
1. 读取 npm 侧递增后的新版本
2. 更新 `Cargo.toml` 的 `[workspace.package] version`
3. 更新 `tauri.conf.json` 的 `version` 字段

### 2.2 包间依赖管理策略

#### 2.2.1 Workspace 协议统一声明

所有内部依赖统一使用 `"workspace:^"` 协议声明：

```json
// packages/agent-daemon/package.json
{
  "dependencies": {
    "@crish/agent-orchestrator": "workspace:^",
    "@crish/agent-runtime": "workspace:^",
    "@crish/decision-engine": "workspace:^",
    "@crish/shared-types": "workspace:^",
    "@crish/shared-utils": "workspace:^"
  }
}
```

`workspace:^` 协议是 npm 7+ 支持的工作区协议，语义为"使用工作区中的最新版本，但在转换为发布版本时使用 `^` range"。

#### 2.2.2 发布前的版本转换

发布脚本在 `npm publish` 之前，会自动将 `workspace:^` 协议替换为具体的 semver range（如 `^0.2.0`）。替换操作：
1. 读取 lockstep 版本 `VERSION`
2. 遍历所有发布包的 `dependencies`/`devDependencies`/`peerDependencies`
3. 将 `workspace:^` 替换为 `^VERSION`
4. 发布完成后通过 `npm install` 恢复 `workspace:^` 协议

#### 2.2.3 Peer Dependencies 策略

`@crish/plugin-sdk` 使用 `peerDependencies` 声明对核心包的依赖，避免消费者安装多个版本：

```json
// packages/plugin-sdk/package.json
{
  "peerDependencies": {
    "@crish/agent-runtime": "workspace:^"
  }
}
```

### 2.3 Changelog 生成策略

#### 2.3.1 Changeset 驱动的工作流

每个 PR 都应包含一个 changeset 文件（如果该 PR 的变更会影响发布版本）：

```
开发流程:
1. git checkout -b feature/xxx
2. ... 编写代码 ...
3. npx changeset          # 交互式选择变更类型和包
4. 生成 .changeset/*.md   # 记录变更描述
5. git add && git commit  # commit 包含 changeset 文件
6. git push && create PR

发布流程:
1. 收集所有 .changeset/*.md 文件
2. 生成每个包的 CHANGELOG.md
3. 递增版本号
4. 删除已消费的 changeset 文件
5. 添加新的 [Unreleased] 节
```

#### 2.3.2 每个包独立 CHANGELOG

每个可发布包维护独立的 CHANGELOG.md：

```
packages/agent-runtime/CHANGELOG.md
packages/agent-daemon/CHANGELOG.md
packages/agent-orchestrator/CHANGELOG.md
packages/shared-types/CHANGELOG.md
packages/shared-utils/CHANGELOG.md
packages/decision-engine/CHANGELOG.md
packages/plugin-sdk/CHANGELOG.md
```

根级 CHANGELOG.md 保留作为项目级的版本汇总（包含各个包的变更摘要），由发布脚本自动生成。

CHANGELOG 格式遵循 Keep a Changelog，包含以下节：

```
## [版本号] - 日期

### Breaking Changes
### Added
### Changed
### Fixed
### Removed
```

#### 2.3.3 [Unreleased] 节管理

每个 CHANGELOG.md 文件顶部始终保留 `## [Unreleased]` 节：

```markdown
# Changelog

## [Unreleased]

### Added
### Changed
### Fixed

## [0.1.0] - 2026-07-18
...
```

发布时，脚本将 `[Unreleased]` 替换为 `[新版本号] - 日期`，然后立即在文件头部插入新的空 `[Unreleased]` 节。

### 2.4 构建与发布流水线设计

#### 2.4.1 流水线阶段

完整的发布流水线包含以下阶段：

```
Phase 1: 准备阶段 (Pre-release)
  ├── 1.1 确认工作区干净 (无未提交修改)
  ├── 1.2 运行完整 CI 检查 (lint + typecheck + test + build)
  ├── 1.3 验证所有 internal deps 使用 workspace:^ 协议
  └── 1.4 验证 changeset 文件完整性

Phase 2: 版本递增
  ├── 2.1 消费 changeset → 生成 CHANGELOG + 递增版本
  ├── 2.2 运行 sync-versions 确保 lockstep 一致
  ├── 2.3 更新 Cargo.toml workspace version
  ├── 2.4 更新 tauri.conf.json version
  ├── 2.5 更新 package-lock.json
  └── 2.6 Commit "Release vX.Y.Z"

Phase 3: 构建与发布
  ├── 3.1 构建所有包 (npm run build:packages)
  ├── 3.2 运行 npm pack --dry-run 验证包内容
  ├── 3.3 将 workspace:^ 替换为 ^VERSION
  ├── 3.4 npm publish (带 --provenance)
  └── 3.5 恢复 workspace:^ 协议

Phase 4: Git 操作
  ├── 4.1 创建并签名 Git tag (git tag -s vX.Y.Z)
  ├── 4.2 Git push (main + tag)
  └── 4.3 添加新的 [Unreleased] 节并 commit

Phase 5: 二进制构建
  ├── 5.1 触发 Tauri 二进制构建 (release.yml)
  ├── 5.2 代码签名 (Windows + macOS)
  ├── 5.3 创建 GitHub Release
  └── 5.4 更新 Tauri updater 端点

Phase 6: 通知
  ├── 6.1 发布成功通知 (Slack/Webhook)
  └── 6.2 更新发布记录
```

#### 2.4.2 关键脚本

**脚本 1：`scripts/sync-versions.js`**

功能：
- 读取所有包的 `package.json` 构建版本映射
- 验证所有包版本一致（lockstep 检查）
- 将所有内部依赖的 `workspace:^` 协议替换为具体版本
- 如发现不一致或混用协议则报错退出

目标：根 `package.json` 引用的工作区包。

**脚本 2：`scripts/release.mjs`**

功能：
- 接收 bump 参数（patch/minor/major）或显式版本号
- 执行 Phase 1–6 的完整流程
- 每一步失败则中止（幂等设计）
- 支持 `--dry-run` 模式（不 push、不 publish）

目标：所有 `@crish/*` 可发布包 + Cargo workspace + Tauri 配置。

**脚本 3：`scripts/publish.mjs`**

功能：
- 顺序发布包（按依赖拓扑排序）
- 跳过已在 registry 中存在的版本（幂等）
- 支持 `--dry-run` 模式
- 验证 `dist/` 目录存在
- 运行 `npm pack --dry-run --json` 验证包内容

目标：`packages/shared-types` → `packages/shared-utils` → `packages/decision-engine` → `packages/agent-runtime` → `packages/agent-orchestrator` → `packages/agent-daemon` → `packages/plugin-sdk`。

#### 2.4.3 Turbo.json 扩展

在 `turbo.json` 中添加发布相关流水线任务：

```json
{
  "pipeline": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".tsbuildinfo"] },
    "test": { "dependsOn": ["build"], "outputs": [] },
    "lint": { "outputs": [] },
    "typecheck": { "dependsOn": ["build:types"], "outputs": [] },
    "clean": { "outputs": [] },
    "publish:dry-run": {
      "dependsOn": ["build", "test", "lint"],
      "outputs": [],
      "cache": false
    },
    "version": {
      "dependsOn": [],
      "outputs": [],
      "cache": false
    }
  }
}
```

### 2.5 发布渠道模型

#### 2.5.1 双渠道架构

| 渠道 | npm dist-tag | 版本格式 | 频率 | 消费者 |
|------|-------------|----------|------|--------|
| Nightly | `nightly` | `X.Y.Z-nightly.TIMESTAMP` | 每日 (cron) | 贡献者、早期使用者 |
| Latest | `latest` | `X.Y.Z` | 按需 (workflow_dispatch) | 生产使用者 |

#### 2.5.2 Nightly 发布

触发方式：
- GitHub Actions 计划任务（cron: `"0 2 * * *"`）
- 手动触发（workflow_dispatch with `channel=nightly`）

版本生成：
```
BASE_VERSION=$(node -p "require('./package.json').version")
TIMESTAMP=$(date +%s)
VERSION="${BASE_VERSION%-nightly*}-nightly.${TIMESTAMP}"
```

Nightly 发布跳过：
- 无 commits 在最近 24 小时内 → 跳过
- 可通过 `force_publish` 参数强制发布

发布步骤：
1. 生成 nightly 版本号
2. 临时写入所有包的 `package.json`
3. 构建所有包
4. 发布到 npm 使用 `--tag nightly`
5. 不创建 Git tag 或 GitHub Release

#### 2.5.3 Latest 发布

触发方式：
- workflow_dispatch with `channel=latest` + `confirm_publish="publish"`

版本递增：
- 使用 changeset 消费 + `npm version patch|minor|major`

发布步骤：
1. 运行完整的 `release.mjs` 脚本
2. 发布到 npm 使用 `--tag latest`
3. 创建 Git tag（`vX.Y.Z`）
4. 触发 Tauri 二进制构建（`release.yml`）
5. 创建 GitHub Release

#### 2.5.4 发布通道的 npm dist-tag 管理

```bash
# 发布 nightly
npm publish --tag nightly

# 发布 latest
npm publish --tag latest

# 将 nightly 提升为 latest（将已有版本重新打标签）
npm dist-tag add @crish/agent-runtime@1.0.0-nightly.1234567890 latest
npm dist-tag rm @crish/agent-runtime@1.0.0-nightly.1234567890 nightly
```

### 2.6 二进制分发策略

#### 2.6.1 Tauri 桌面应用

- 通过 GitHub Release 分发二进制安装包（`.msi`、`.dmg`、`.AppImage`）
- 配置 Tauri updater 以支持自动更新
- Windows：Authenticode 代码签名
- macOS：Apple Developer ID notarization

**Tauri updater 配置：**

```json
// apps/agent-workbench/src-tauri/tauri.conf.json
{
  "plugins": {
    "updater": {
      "pubkey": "...",
      "endpoints": [
        "https://releases.conex.dev/{{target}}-{{arch}}/{{current_version}}"
      ]
    }
  }
}
```

#### 2.6.2 npm 包

- `@crish/agent-runtime`、`@crish/agent-daemon`、`@crish/agent-orchestrator`、`@crish/shared-types`、`@crish/shared-utils`、`@crish/decision-engine` 发布到 npm registry（public access）
- `@crish/plugin-sdk` 作为面向外部插件的 SDK，发布到 npm registry
- 所有包配置 `publishConfig`：

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org",
    "provenance": true
  }
}
```

#### 2.6.3 Rust crates

- 10 个 crates + `agent-provider-http` 发布到 crates.io
- 在发布 nmp 包后，通过 `cargo publish` 顺序发布
- 按依赖拓扑排序发布：`conex-types` → `conex-ipc` → `conex-stream` → `conex-search` → `conex-compaction` → `conex-diff` → `conex-sandbox` → `conex-db` → `conex-fs` → `conex-net` → `agent-provider-http`

---

## 3 详细任务分解

### 3.1 任务清单总览

| 任务 ID | 目标文件 | 当前问题 | 改进策略 | 优先级 |
|---------|----------|----------|----------|--------|
| T-001 | 所有 `packages/*/package.json` | `file:` 和 `"*"` 协议混用 | 统一改为 `workspace:^` | P0 |
| T-002 | `packages/decision-engine/package.json:29` | 硬编码 `"0.1.0"` | 改为 `workspace:^` | P0 |
| T-003 | `packages/plugin-sdk/package.json` | 缺少发布必要配置 | 添加 files/publishConfig/build 等 | P0 |
| T-004 | `scripts/sync-versions.js` | 不存在 | 创建版本同步脚本 | P0 |
| T-005 | `scripts/release.mjs` | 不存在 | 创建完整发布脚本 | P0 |
| T-006 | `scripts/publish.mjs` | 不存在 | 创建 npm publish 脚本 | P0 |
| T-007 | `package.json` scripts | 无版本/发布命令 | 添加 version:patch/minor/major、release、publish 等 | P1 |
| T-008 | `.changeset/config.json` | fixed/linked 为空，commit: false | 配置 lockstep fixed 组，集成到工作流 | P1 |
| T-009 | `.changeset/` (所有 changeset 文件) | 无 changeset 文件 | 开发者工作流集成 | P1 |
| T-010 | `packages/*/CHANGELOG.md` (7 个新文件) | 不存在 | 创建各包独立 CHANGELOG | P1 |
| T-011 | `.github/workflows/release.yml` | 仅 Tauri 构建 | 扩展为完整发布流水线 | P1 |
| T-012 | `.github/workflows/nightly-publish.yml` | 不存在 | 创建 nightly 发布工作流 | P1 |
| T-013 | `.github/workflows` | 缺少 npm publish | 添加 npm publish 步骤 | P1 |
| T-014 | `turbo.json` | 无发布相关 pipeline | 添加 publish:dry-run 等任务 | P1 |
| T-015 | `Cargo.toml:61` | workspace version 未联动 | 发布脚本中自动同步 | P2 |
| T-016 | `tauri.conf.json:4` | version 未联动 | 发布脚本中自动同步 | P2 |
| T-017 | `tauri.conf.json` | 无 updater 配置 | 添加 Tauri updater 插件配置 | P2 |
| T-018 | 所有 `package.json` | 无 publishConfig | 添加 publishConfig 块 | P2 |
| T-019 | `.npmrc` | 不存在 | 创建 .npmrc 配置 registry 和 provenance | P2 |
| T-020 | `scripts/cargo-publish.sh` | 不存在 | 创建 Rust crate 发布脚本 | P3 |
| T-021 | `RELEASING.md` | 不存在 | 创建发布操作文档 | P2 |
| T-022 | 所有 `package.json` | engines 未设置 | 添加 engines.node >=22 | P2 |

### 3.2 详细任务描述

#### T-001：统一依赖声明协议

**目标文件（共 5 个）：**
- `packages/agent-daemon/package.json:33-37`
- `packages/agent-orchestrator/package.json:31-32`
- `packages/agent-runtime/package.json:41,44`
- `apps/crish-desktop/package.json:26`
- `apps/agent-workbench/package.json:16-19`

**当前状态：**

`packages/agent-daemon/package.json:33-37`:
```json
"dependencies": {
  "@crish/agent-orchestrator": "file:../agent-orchestrator",
  "@crish/agent-runtime": "file:../agent-runtime",
  "@crish/decision-engine": "file:../decision-engine",
  "@crish/shared-types": "file:../shared-types",
  "@crish/shared-utils": "file:../shared-utils"
}
```

`packages/agent-runtime/package.json:41`:
```json
"dependencies": {
  "@crish/decision-engine": "*"
}
```

**改进策略：**

统一为 `workspace:^` 协议：

```json
// packages/agent-daemon/package.json
"dependencies": {
  "@crish/agent-orchestrator": "workspace:^",
  "@crish/agent-runtime": "workspace:^",
  "@crish/decision-engine": "workspace:^",
  "@crish/shared-types": "workspace:^",
  "@crish/shared-utils": "workspace:^"
}
```

`workspace:^` 在开发时通过 npm link 解析到本地。发布时由 `publish.mjs` 脚本替换为 `^VERSION`。

#### T-002：修复硬编码版本号

**目标文件：** `packages/decision-engine/package.json:29`

**当前状态：**
```json
"dependencies": {
  "@crish/shared-types": "0.1.0"
}
```

**改进策略：**
```json
"dependencies": {
  "@crish/shared-types": "workspace:^"
}
```

#### T-003：完善 plugin-sdk 发布配置

**目标文件：** `packages/plugin-sdk/package.json`

**当前状态（共 7 行）：**
```json
{
  "name": "@crish/plugin-sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

**改进策略：**

```json
{
  "name": "@crish/plugin-sdk",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\""
  },
  "peerDependencies": {
    "@crish/agent-runtime": "workspace:^"
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org",
    "provenance": true
  }
}
```

#### T-004：创建版本同步脚本

**目标文件：** `scripts/sync-versions.js`（新建）

**功能需求：**

```
输入：遍历所有 packages/*/package.json
流程：
1. 读取每个包的 name 和 version，构建 @crish/* 版本映射
2. 验证所有包版本一致（lockstep）
3. 遍历所有包的所有依赖声明
4. 如果依赖是 @crish/* 包，验证其声明的 workspace:^ 或具体版本与目标版本一致
5. 输出版本摘要
6. 如发现不一致或混合协议，报错并退出

输出：版本一致性报告 + 退出码（0=一致，1=不一致）
```

**调用方式：**
```bash
node scripts/sync-versions.js
```

**集成点：**
- 发布脚本 `release.mjs` 中在版本递增后调用
- CI 中作为发布前检查步骤
- 预提交 hook（可选）

#### T-005：创建完整发布脚本

**目标文件：** `scripts/release.mjs`（新建）

**功能需求：**

```
用法：node scripts/release.mjs <patch|minor|major> [--dry-run]

流程：
1. 验证工作目录干净（无未提交修改）
2. 运行 npm run check:all（lint + typecheck + test + build）
3. 验证所有包使用 workspace:^ 协议
4. npx changeset version（消费 changeset → 更新版本 + CHANGELOG）
5. 运行 sync-versions.js 验证 lockstep
6. 更新 Cargo.toml 的 [workspace.package] version
7. 更新 tauri.conf.json 的 version
8. npm install --package-lock-only（更新 lockfile）
9. Commit "Release vX.Y.Z"
10. Git tag -s vX.Y.Z（GPG 签名）
11. Git push origin main --follow-tags（触发 CI 发布）
12. 在每个 CHANGELOG.md 中添加新的 [Unreleased] 节
13. Commit "Add [Unreleased] section for next cycle"
14. Git push
```

**幂等设计：**
- 如果已存在同名的 Git tag，跳过 tag 创建
- 如果已发布同版本的 npm 包，跳过 publish
- `--dry-run` 模式不执行任何写入操作

#### T-006：创建 npm publish 脚本

**目标文件：** `scripts/publish.mjs`（新建）

**功能需求：**

```
用法：node scripts/publish.mjs [--dry-run]

执行流程（按依赖拓扑排序）：
1. shared-types → 2. shared-utils → 3. decision-engine → 4. agent-runtime →
5. agent-orchestrator → 6. agent-daemon → 7. plugin-sdk

每个包：
1. 验证 dist/ 目录存在
2. npm pack --dry-run 验证包内容
3. 检查 registry 中是否已存在该版本（跳过已发布的）
4. 将 workspace:^ 协议替换为 ^VERSION
5. npm publish --access public --provenance --tag <channel>
6. 恢复 workspace:^ 协议
```

#### T-007：添加 package.json scripts

**目标文件：** `package.json:17-68`（扩展 scripts 段落）

**新增 scripts：**

```json
{
  "scripts": {
    // ... 现有 scripts ...

    "version:patch": "node scripts/release.mjs patch --dry-run",
    "version:minor": "node scripts/release.mjs minor --dry-run",
    "version:major": "node scripts/release.mjs major --dry-run",
    "release:patch": "node scripts/release.mjs patch",
    "release:minor": "node scripts/release.mjs minor",
    "release:major": "node scripts/release.mjs major",
    "release:dry-run": "node scripts/release.mjs patch --dry-run",
    "publish": "node scripts/publish.mjs",
    "publish:dry-run": "node scripts/publish.mjs --dry-run",
    "prepublishOnly": "npm run check:all && npm run build:packages",
    "preversion": "npm run check:all",
    "postversion": "node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts"
  }
}
```

#### T-008：配置 Changeset 为 Lockstep 模式

**目标文件：** `.changeset/config.json`

**当前状态：**
```json
{
  "fixed": [],
  "linked": [],
  "commit": false,
  "access": "public",
  "updateInternalDependencies": "patch"
}
```

**改进策略：**
```json
{
  "fixed": [
    ["@crish/agent-runtime", "@crish/agent-daemon", "@crish/agent-orchestrator",
     "@crish/shared-types", "@crish/shared-utils", "@crish/decision-engine",
     "@crish/plugin-sdk"]
  ],
  "linked": [],
  "commit": true,
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

关键变化：
- `fixed` 现在包含 7 个核心包，保证 lockstep 版本
- `commit: true` — changeset 版本更新自动创建 git commit
- `access: "public"` — 适用于非 private 的发布包

#### T-009：集成 Changeset 到开发工作流

**目标：** 确保每个 PR 的特征变更都伴随 changeset 描述

**实现方式：**
1. 确保 `@changesets/cli` 在根 `devDependencies` 中
2. 在 `.husky/` 中添加 `pre-push` hook 检查 changeset 文件（可选）
3. 在 CI 中添加"missing changeset"检查（如果是非文档 PR）
4. 创建 `CONTRIBUTING.md` 中关于 changeset 的说明章节

#### T-010：创建各包独立 CHANGELOG

**目标文件（7 个新文件）：**
- `packages/agent-runtime/CHANGELOG.md`
- `packages/agent-daemon/CHANGELOG.md`
- `packages/agent-orchestrator/CHANGELOG.md`
- `packages/shared-types/CHANGELOG.md`
- `packages/shared-utils/CHANGELOG.md`
- `packages/decision-engine/CHANGELOG.md`
- `packages/plugin-sdk/CHANGELOG.md`

**每个文件的初始内容：**

```markdown
# @crish/agent-runtime

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.0] - 2026-07-18

### Added
- Initial release of agent-runtime package
```

#### T-011：扩展 release.yml 为完整流水线

**目标文件：** `.github/workflows/release.yml`

**当前状态：** 只构建 Tauri 二进制 + 创建 GitHub Release（draft）

**改进策略：**

扩展为包含以下 job：

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  # Job 1: 验证发布 tag
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Validate version tag
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          PACKAGE_VERSION=$(node -p "require('./package.json').version")
          if [ "$TAG_VERSION" != "$PACKAGE_VERSION" ]; then
            echo "Tag version $TAG_VERSION does not match package version $PACKAGE_VERSION"
            exit 1
          fi

  # Job 2: 发布 npm 包
  publish-npm:
    needs: validate
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: "https://registry.npmjs.org"
      - run: npm ci
      - run: npm run build:packages
      - name: Verify npm publishability
        run: node scripts/publish.mjs --dry-run
      - name: Publish to npm
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
        run: node scripts/publish.mjs

  # Job 3: Tauri 二进制构建（保持现有）
  build:
    needs: publish-npm
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    steps:
      # ... 现有 Tauri 构建步骤 ...

  # Job 4: GitHub Release
  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      # ... 现有 GitHub Release 步骤（从 draft 改为 published）...
```

#### T-012：创建 nightly 发布工作流

**目标文件：** `.github/workflows/nightly-publish.yml`（新建）

```yaml
name: Nightly Publish

on:
  schedule:
    - cron: "0 2 * * *"
  workflow_dispatch:
    inputs:
      force_publish:
        description: "Force publish even if no commits in last 24 hours"
        required: false
        type: boolean
        default: false

permissions:
  contents: read
  id-token: write

jobs:
  publish-nightly:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check for recent commits
        id: check_commits
        env:
          FORCE: ${{ inputs.force_publish || false }}
        run: |
          if [ "$FORCE" = "true" ]; then
            echo "skip=false" >> $GITHUB_OUTPUT
            exit 0
          fi
          if [ "$(git rev-list --count HEAD --since='24 hours ago')" -eq 0 ]; then
            echo "skip=true" >> $GITHUB_OUTPUT
          else
            echo "skip=false" >> $GITHUB_OUTPUT
          fi

      - uses: actions/setup-node@v4
        if: steps.check_commits.outputs.skip != 'true'
        with:
          node-version: 22
          registry-url: "https://registry.npmjs.org"

      - run: npm ci
        if: steps.check_commits.outputs.skip != 'true'

      - run: npm run build:packages
        if: steps.check_commits.outputs.skip != 'true'

      - name: Generate nightly version
        if: steps.check_commits.outputs.skip != 'true'
        id: version
        run: |
          BASE_VERSION=$(node -p "require('./package.json').version")
          TIMESTAMP=$(date +%s)
          VERSION="${BASE_VERSION%-nightly*}-nightly.${TIMESTAMP}"
          echo "version=$VERSION" >> $GITHUB_OUTPUT

      - name: Update package versions for nightly
        if: steps.check_commits.outputs.skip != 'true'
        env:
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          node -e "
            const fs = require('fs');
            const pkgs = JSON.parse(fs.readFileSync('package.json','utf8')).workspaces;
            [...pkgs, '.'].forEach(dir => {
              const path = dir === '.' ? 'package.json' : dir + '/package.json';
              const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
              pkg.version = process.env.VERSION;
              fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
            });
          "

      - name: Publish to npm (nightly tag)
        if: steps.check_commits.outputs.skip != 'true'
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
        run: node scripts/publish.mjs

      - name: Summary
        if: steps.check_commits.outputs.skip != 'true'
        run: |
          echo "Published nightly ${{ steps.version.outputs.version }}"
```

#### T-013：添加 npm publish 到工作流

**目标文件：** `.github/workflows/release.yml`（扩展）

在 `release.yml` 中增加 `publish-npm` job，在 `build` job 之前或并行执行。

#### T-014：扩展 turbo.json 流水线

**目标文件：** `turbo.json`

在现有 pipeline 中添加：

```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".tsbuildinfo"]
    },
    "publish:dry-run": {
      "dependsOn": ["build", "test", "lint"],
      "outputs": [],
      "cache": false
    },
    "version": {
      "dependsOn": [],
      "outputs": [],
      "cache": false
    }
  }
}
```

#### T-015：发布脚本中自动同步 Cargo.toml

**目标文件：** `Cargo.toml:61`（由 `release.mjs` 自动更新）

```javascript
// 在 release.mjs 中
function updateCargoVersion(version) {
  const cargoPath = 'Cargo.toml';
  let content = readFileSync(cargoPath, 'utf8');
  content = content.replace(
    /(version\s*=\s*")[\d.]+("[^"]*)/,
    `$1${version}$2`
  );
  writeFileSync(cargoPath, content);
}
```

#### T-016：发布脚本中自动同步 tauri.conf.json

**目标文件：** `apps/agent-workbench/src-tauri/tauri.conf.json:4`（由 `release.mjs` 自动更新）

```javascript
// 在 release.mjs 中
function updateTauriConfigVersion(version) {
  const config = JSON.parse(readFileSync('apps/agent-workbench/src-tauri/tauri.conf.json', 'utf8'));
  config.version = version;
  writeFileSync('apps/agent-workbench/src-tauri/tauri.conf.json', JSON.stringify(config, null, 2) + '\n');
}
```

#### T-017：配置 Tauri updater

**目标文件：** `apps/agent-workbench/src-tauri/tauri.conf.json`（添加 `plugins.updater`）

```json
{
  "plugins": {
    "updater": {
      "active": true,
      "dialog": true,
      "endpoints": [
        "https://releases.crish.dev/updater/{{target}}-{{arch}}/{{current_version}}"
      ],
      "pubkey": "..."  // 生成签名密钥对后填写
    }
  }
}
```

需要在 `Cargo.toml` 中添加 tauri-plugin-updater 依赖，在 npm 侧的 `package.json` 中添加 `@tauri-apps/plugin-updater`。

#### T-018：添加 publishConfig

**目标文件（7 个包）：**

- `packages/agent-runtime/package.json`
- `packages/agent-daemon/package.json`
- `packages/agent-orchestrator/package.json`
- `packages/shared-types/package.json`
- `packages/shared-utils/package.json`
- `packages/decision-engine/package.json`
- `packages/plugin-sdk/package.json`

**添加内容：**

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org",
    "provenance": true
  }
}
```

#### T-019：创建 .npmrc

**目标文件：** `.npmrc`（新建）

```
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

#### T-020：创建 Rust crate 发布脚本

**目标文件：** `scripts/cargo-publish.sh`（新建）

```bash
#!/bin/bash
# 按依赖拓扑顺序发布 crates
set -euo pipefail

CRATES=(
  "crates/conex-types"
  "crates/conex-ipc"
  "crates/conex-stream"
  "crates/conex-search"
  "crates/conex-compaction"
  "crates/conex-diff"
  "crates/conex-sandbox"
  "crates/conex-db"
  "crates/conex-fs"
  "crates/conex-net"
  "packages/agent-provider-http"
)

for CRATE in "${CRATES[@]}"; do
  echo "Publishing $CRATE..."
  cargo publish -p "$(basename $CRATE)"
  echo "Waiting for crates.io index update..."
  sleep 10
done
```

#### T-021：创建 RELEASING.md

**目标文件：** `RELEASING.md`（新建）

文档内容包括：
- 版本策略说明（lockstep、semver）
- 发布流程概览
- 创建 changeset 的步骤
- 触发 nightly 和 latest 发布的方法
- 回滚步骤
- 常见问题

#### T-022：添加 engines 声明

**目标文件：** 根 `package.json` 和所有发布包的 `package.json`

```json
{
  "engines": {
    "node": ">=22"
  }
}
```

---

## 4 任务间逻辑依赖关系

### 4.1 依赖关系图

```
T-001 (统一 workspace 协议) ──→ T-002 (修复硬编码)
    │
    ├──→ T-003 (plugin-sdk 配置)
    │
    └──→ T-004 (创建 sync-versions.js)
              │
              ├──→ T-005 (创建 release.mjs)
              │       │
              │       ├──→ T-015 (Cargo 同步) ──→ T-016 (Tauri 同步)
              │       │
              │       └──→ T-006 (创建 publish.mjs)
              │               │
              │               └──→ T-018 (publishConfig) ──→ T-019 (.npmrc)
              │
              └──→ T-007 (scripts 集成)
                      │
                      ├──→ T-008 (changeset lockstep 配置)
                      │       │
                      │       └──→ T-009 (工作流集成)
                      │               │
                      │               ├──→ T-010 (各包 CHANGELOG)
                      │               │
                      │               └──→ T-014 (turbo.json)
                      │
                      ├──→ T-011 (release.yml 扩展)
                      │       │
                      │       └──→ T-013 (npm publish 集成)
                      │
                      └──→ T-012 (nightly-publish.yml)
                              │
                              └──→ T-017 (Tauri updater)

T-020 (cargo publish) ──→ 依赖 T-015

T-021 (RELEASING.md) ──→ 依赖 T-007, T-011, T-012

T-022 (engines) ──→ 无其他依赖
```

### 4.2 依赖分组

**批次 1（P0，无外部依赖）：**
- T-001：统一 workspace 协议
- T-002：修复硬编码版本号
- T-003：完善 plugin-sdk 配置
- T-022：添加 engines 声明

**批次 2（P0，依赖批次 1）：**
- T-004：创建 sync-versions.js

**批次 3（P1，依赖批次 2）：**
- T-005：创建 release.mjs
- T-007：添加 package.json scripts
- T-008：配置 changeset lockstep
- T-009：集成 changeset 工作流
- T-010：创建各包 CHANGELOG
- T-014：扩展 turbo.json

**批次 4（P1，依赖批次 3）：**
- T-006：创建 publish.mjs
- T-018：添加 publishConfig
- T-019：创建 .npmrc
- T-011：扩展 release.yml
- T-012：创建 nightly 工作流

**批次 5（P1-P2，依赖批次 4）：**
- T-013：集成 npm publish 到工作流
- T-015：Cargo 版本同步
- T-016：Tauri 版本同步

**批次 6（P2-P3，依赖批次 4-5）：**
- T-017：Tauri updater 配置
- T-020：Rust crate 发布脚本
- T-021：RELEASING.md

---

## 5 与现有系统的集成点

### 5.1 与 turbo.json 的集成

现有 `turbo.json` 定义了 `build`、`test`、`lint`、`typecheck`、`clean` 五个 pipeline。

**集成方式：**

新增 `publish:dry-run` 和 `version` 两个 pipeline 任务：

```json
{
  "pipeline": {
    "publish:dry-run": {
      "dependsOn": ["build", "test", "lint"],
      "outputs": [],
      "cache": false
    }
  }
}
```

- `publish:dry-run` 不是标准 turbo 任务（不通过 turbo 执行 publish），而是作为一个编排节点，确保在发布前构建、测试、lint 都已通过。
- `version` pipeline 独立于 build 缓存之外，因为它修改了 `package.json` 和 `CHANGELOG.md` 文件，应避免缓存。

### 5.2 与现有的 package.json scripts 的集成

现有 scripts 中与发布相关的包括：

```json
"check:packages": "npm run build:shared-types && npm --workspace @crish/shared-utils run build && npm --workspace @crish/decision-engine run build && npm run build:runtime && npm run build:orchestrator",
"build:packages": "npm run build:shared-types && npm --workspace @crish/shared-utils run build && npm --workspace @crish/decision-engine run build && npm run build:runtime && npm run build:orchestrator",
"build:daemon": "npm run build:packages && npm --workspace @crish/agent-daemon run build",
"check:all": "npm run typecheck && npm run lint:all && npm run test:coverage",
"test": "vitest run",
"lint": "eslint ."
```

**集成方式：**

发布脚本 `release.mjs` 将调用这些现有脚本：

```javascript
// Phase 2 检查
run('npm run check:all');
run('npm run build:packages');
run('npm run build:daemon');

// 新脚本集成
run('node scripts/sync-versions.js');
run('npx changeset version');  // 如果有 changeset
```

新添加的 `prepublishOnly` 脚本将自动触发质量检查：

```json
"prepublishOnly": "npm run check:all && npm run build:packages"
```

### 5.3 与 Tauri 构建系统的集成

**当前 Tauri 构建流程：**
- `npm run build:packages` 构建所有 TS 包
- `npm --workspace @crish/agent-workbench run tauri build` 构建 Tauri 应用
- `npm run build:daemon-binary` 将 daemon bundle 复制到 Tauri 资源目录

**集成方式：**

发布流水线中 Tauri 构建保持现有步骤不变，但添加：

1. **版本同步**：发布脚本在 Tauri 构建前更新 `tauri.conf.json:4` 的 version
2. **代码签名**：在 Tauri 构建完成后，添加 Windows 和 macOS 的签名步骤
3. **Updater 集成**：构建发布版时同时生成 updater 签名和端点配置
4. **二进制发布**：GitHub Release 从 draft 改为 automatic publish，并附加 changelog

```yaml
# 在 release.yml 中，Tauri 构建后添加
- name: Sign Windows binary
  if: matrix.os == 'windows-latest'
  run: |
    # 使用 Authenticode 证书签名 .msi
    & "C:\Program Files (x86)\Windows Kits\10\bin\10.0.0\signtool.exe" sign /fd SHA256 /a "apps/agent-workbench/src-tauri/target/release/bundle/msi/*.msi"

- name: Notarize macOS app
  if: matrix.os == 'macos-latest'
  run: |
    # 使用 Apple Developer ID 签名 .dmg
    codesign --sign "Developer ID Application: ..." --timestamp --deep "apps/agent-workbench/src-tauri/target/release/bundle/dmg/*.dmg"
    xcrun notarytool submit "apps/agent-workbench/src-tauri/target/release/bundle/dmg/*.dmg" --apple-id ... --password ... --team-id ...
```

### 5.4 与 Changeset 系统的集成

**当前状态：** 配置存在但未使用。

**集成方式：**

1. **安装依赖**：将 `@changesets/cli` 添加到根 `devDependencies`
2. **配置 fixed 组**：如上 T-008 描述
3. **开发工作流**：通过 `npx changeset` 创建变更文件
4. **CI 集成**：在 CI 中运行 `npx changeset status --since=main` 检查是否缺少 changeset（跳过文档 PR）
5. **发布集成**：`release.mjs` 执行 `npx changeset version` 消费 changeset

```javascript
// release.mjs 中的 changeset 集成
function consumeChangesets() {
  run('npx changeset version');
  // changeset version 会：
  // 1. 读取 .changeset/*.md
  // 2. 更新各包版本号
  // 3. 更新各包 CHANGELOG.md
  // 4. 删除已消费的 .changeset/*.md
  // 5. 如果 commit:true，自动创建 git commit
}
```

---

## 6 验证标准

### 6.1 功能性验证

| 验证点 | 验证方法 | 预期结果 |
|--------|----------|----------|
| V-001：workspace 协议统一 | 搜索所有 `package.json` 中 `@crish/*` 依赖 | 全部使用 `workspace:^`，无 `file:` 或 `"*"` |
| V-002：版本同步 | 运行 `node scripts/sync-versions.js` | 退出码 0，输出"所有包版本一致" |
| V-003：版本递增 | 运行 `npm run version:patch --dry-run` | 所有包版本从 `0.1.0` 递增到 `0.1.1` |
| V-004：Changelog 生成 | 运行 `npx changeset version` | 各包 CHANGELOG.md 更新，`[Unreleased]` 内容移至版本节 |
| V-005：npm pack 验证 | 运行 `npm pack --dry-run --json` 在每个包 | 输出包含预期文件和大小 |
| V-006：发布拓扑排序 | 运行 `node scripts/publish.mjs --dry-run` | 按 shared-types → shared-utils → ... → plugin-sdk 顺序输出 |
| V-007：nightly 版本 | 查看 npm registry 的 nightly 版本 | 格式为 `X.Y.Z-nightly.TIMESTAMP` |
| V-008：latest 版本 | 查看 npm registry 的 latest 版本 | 格式为标准 semver `X.Y.Z` |
| V-009：Cargo/Tauri 同步 | 发布后检查 `Cargo.toml` 和 `tauri.conf.json` | 版本与 npm 包一致 |
| V-010：Git tag | 运行 `git tag -l 'v*'` | 存在 `vX.Y.Z` 格式的已签名 tag |

### 6.2 集成验证

| 验证点 | 验证方法 | 预期结果 |
|--------|----------|----------|
| V-011：CI 通过 | 运行 `npm run check:all` | 无错误、无 warning |
| V-012：构建完整 | 运行 `npm run build:packages && npm run build:daemon` | 所有 dist/ 目录存在且包含正确文件 |
| V-013：Tauri 构建 | 运行 `npm --workspace @crish/agent-workbench run tauri build` | 生成 `.msi`/`.dmg`/`.AppImage` |
| V-014：release.yml 触发 | 推送 `v*` tag | 触发完整发布流水线，npm publish + Tauri build |
| V-015：nightly.yml 触发 | 等待 cron 触发或手动触发 | 生成 nightly 版本并发布 |

### 6.3 安全验证

| 验证点 | 验证方法 | 预期结果 |
|--------|----------|----------|
| V-016：npm provenance | 检查已发布包 | `npm view @crish/agent-runtime@X.Y.Z --json` 包含 `attestations` |
| V-017：Git tag 签名 | 运行 `git tag -v vX.Y.Z` | GPG 签名有效 |
| V-018：npm 无敏感文件 | 运行 `npm pack --dry-run` 检查文件列表 | 不包含 `.env`、`node_modules`、`*.ts` (除了 `d.ts`) |
| V-019：依赖声明合法 | 检查发布后 tarball 中的 `package.json` | 所有内部依赖使用 `^X.Y.Z`，无 `file:` 或 `workspace:` |

### 6.4 发布渠道验证

| 验证点 | 验证方法 | 预期结果 |
|--------|----------|----------|
| V-020：nightly dist-tag | `npm view @crish/agent-runtime dist-tags` | 包含 `nightly` 标签 |
| V-021：latest dist-tag | `npm view @crish/agent-runtime dist-tags` | 包含 `latest` 标签 |
| V-022：dist-tag 分离 | `npm install @crish/agent-runtime@nightly` vs `@latest` | 安装到不同版本 |

---

## 7 风险评估

### 7.1 风险分类

| 风险 ID | 风险描述 | 概率 | 影响 | 缓解措施 |
|---------|----------|------|------|----------|
| RISK-01 | 统一 workspace 协议时遗漏某个依赖声明 | 中 | 高 | 使用全局搜索 + 自动化脚本检测所有 `@crish/*` 依赖，发布前 CI 检查 |
| RISK-02 | npm publish 后 workspace:^ 协议未恢复 | 低 | 中 | publish.mjs 使用 try/finally 确保恢复；发布后 CI 验证 |
| RISK-03 | Changeset 配置导致错误的版本递增 | 低 | 高 | `release.mjs` 的 `--dry-run` 模式先验证；`sync-versions.js` 发布前检查一致性 |
| RISK-04 | npm OIDC 配置失败导致 publish 无法认证 | 低 | 高 | 先在 CI 外手动测试 publish；工作流中配置 `id-token: write`；保留 `.npmrc` 的 token 认证作为 fallback |
| RISK-05 | Tauri 构建在 CI 中失败 | 中 | 中 | 保留 draft release 模式，CI 失败不阻塞 npm publish；构建失败可重新触发 |
| RISK-06 | Nightly 发布频率过高触及 npm 发布限制 | 低 | 低 | npm 的发布限制通常为每 24h 1000 个版本，daily nightly 远低于此 |
| RISK-07 | Cargo crate 发布时依赖尚未更新到 crates.io | 中 | 中 | 按拓扑顺序发布，每个 crate 发布后等待 crates.io 索引更新（sleep 10-30s） |
| RISK-08 | `@changesets/cli` 与现有 lockstep 策略不兼容 | 低 | 高 | 先在 `--dry-run` 模式中测试 changeset behavior；备选方案：不使用 changeset，直接使用 `npm version` + 自定义 CHANGELOG 生成 |
| RISK-09 | 开发者忘记创建 changeset | 中 | 低 | CI 中可选检查；发布时脚本可自动从 git log 生成基础 changelog 条目 |
| RISK-10 | 包 `private: true` 与 `publishConfig.access: "public"` 冲突 | 低 | 中 | 可发布包设为 `private: false`（或删除 private 字段）；`publishConfig.access` 控制 npm 的 access 级别 |

### 7.2 回滚方案

**npm 包回滚：**

```bash
# 将 latest dist-tag 指回上一个版本
npm dist-tag add @crish/agent-runtime@PREVIOUS_VERSION latest

# Deprecate 问题版本
npm deprecate @crish/agent-runtime@BAD_VERSION "Reason: ..."
```

**Git tag 回滚：**

```bash
# 删除远程 tag（慎用）
git push --delete origin vBAD_VERSION

# 本地删除
git tag -d vBAD_VERSION
```

**GitHub Release 回滚：**
- 手动编辑 release 将其标记为 "Pre-release" 或删除
- 重新推送修复后的 tag

### 7.3 采用建议

建议按以下顺序逐步采用本方案：

1. **第一阶段（基础建设）**：完成 T-001 到 T-004，统一依赖声明、创建同步脚本。这些任务风险低、影响大，完成后即可实现基本的版本管理自动化。

2. **第二阶段（手动发布）**：完成 T-005 到 T-010，创建发布脚本和 changeset 配置。团队开始使用 `npm run release:patch` 手动执行发布。

3. **第三阶段（CI 自动化）**：完成 T-011 到 T-014，将发布流程集成到 GitHub Actions，实现 tag 触发自动发布。

4. **第四阶段（全渠道）**：完成 T-015 到 T-022，添加 nightly 发布、Cargo 同步、Tauri updater 和文档完善。

每个阶段完成后应有 1-2 周的稳定期，确保流程正确后再进入下一阶段。
