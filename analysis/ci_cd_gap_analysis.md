# CI/CD 流水线现状分析与差距识别

## 1 执行摘要

本文件对 conex 项目当前的 CI/CD 流水线进行系统性评估，识别从构建、测试、质量门禁到发布交付全链路的现状与理想状态之间的差距。分析基于对项目根目录 `package.json`、`turbo.json`、`tsconfig.base.json`、`vitest.config.ts`、`eslint.config.js`、`.lintstagedrc.json`、`.husky/pre-commit`、`.husky/pre-push`、全部 10 个工作空间子包 `package.json`、Rust 工作空间 `Cargo.toml`（含 12 个 crate）、以及 `.github/workflows/` 下现有 4 个 workflow 文件的深度代码审查。

**核心结论**：项目已有初步的 CI 基础设施（4 个 workflow），但存在 7 大类系统性缺陷——碎片化执行（仅覆盖 40% 的包）、无矩阵测试、无跨平台构建（TS 部分仅 linux）、无发布流水线（npm publish 完全缺失）、无质量门禁硬性阈值、无安全审计自动化调度、无监控与度量反馈。一个 `pre-push` hook 执行 `npm run typecheck && npm test`，但由于 TypeScript check 只覆盖 `crish-desktop` 的 tsconfig，而 `npm test` 运行全部 vitest 套件（含 e2e），开发者体验脆弱且不可靠。

## 2 当前 CI/CD 状态评估

### 2.1 构建流程现状

**评分：2/10**

当前构建完全依赖本地手动执行或 `pre-push` hook 的隐式触发。根 `package.json`（`package.json:17-67`）定义了分层构建脚本：

```
build:shared-types → build:packages → build:runtime → build:orchestrator → build:daemon → build:product
```

每个子包的构建由 `clean` → `build:types`（tsc --emitDeclarationOnly + tsc-alias） → `build:js`（esbuild）三步组成，见 `packages/agent-daemon/package.json:25-28`、`packages/shared-types/package.json:25-28` 等。

现有 `.github/workflows/ci.yml` 的 `ts-check` job 只对 `packages/agent-runtime` 执行了 `npx tsc --noEmit`（`ci.yml:79`），完全忽略了：
- `@crish/shared-types` — 类型定义的基础
- `@crish/shared-utils` — 工具函数库（含 browser/node 双入口）
- `@crish/decision-engine` — 决策引擎
- `@crish/agent-orchestrator` — 编排器
- `@crish/agent-daemon` — 守护进程
- `@crish/agent-workbench` — 工作台 CLI
- `@crish/crish-desktop` — 桌面应用

`turbo.json`（`turbo.json:3-30`）定义了 `pipeline` 包含 `build`、`build:types`、`build:js`、`test`、`lint`、`typecheck`、`clean` 七个任务，但 CI 中**完全没有使用 turbo**。`ci.yml` 中直接调用 `npx tsc --noEmit` 和 `npx vitest run`，绕过了 turbo 的依赖图缓存和增量构建能力。

Rust 部分状况较好：`ci.yml` 的 `rust-check` job（`ci.yml:13-42`）在 ubuntu/windows/macos 三平台执行 `cargo check`、`cargo clippy`、`cargo test`、`cargo fmt`，使用了 `Swatinem/rust-cache@v2`。但 `cargo test --workspace` 不包含 `crates/conex-stream` 的 `--all-features` 测试（该 crate 有独立的 `rust-stream-test` job）。

### 2.2 测试执行现状

**评分：4/10**

根 `package.json` 定义了多条测试命令（`package.json:57-61`）：
- `test:core` — 运行 runtime/orchestrator/daemon 测试
- `test:desktop-helpers` — 运行 desktop API/store 测试
- `test` — 运行全部 vitest 测试
- `test:coverage` — 带覆盖率运行
- `test:integration` — 使用独立集成测试配置

`vitest.config.ts`（`vitest.config.ts:1-18`）的 include 模式覆盖了 `packages/**` 和 `apps/**` 目录下的 `*.test.ts` 文件。

`apps/crish-desktop/vitest.config.ts`（`apps/crish-desktop/vitest.config.ts:1-28`）独立配置了 jsdom 环境、React 插件和覆盖率阈值。

现有 CI 测试覆盖：
- `ci.yml:81-82` — Provider 测试 `npx vitest run packages/agent-runtime/src/provider/__tests__/`
- `ci.yml:84-85` — Model catalog 测试（`2>/dev/null || true`，静默吞噬失败）
- `ci.yml:87-88` — Fallback chain 测试（`2>/dev/null || true`，静默吞噬失败）
- `ci.yml:161-162` — Provider 覆盖率测试
- `ci.yml:180-181` — E2E 测试（provider e2e）
- `ci.yml:209` — Provider lifecycle 基准测试

**严重问题**：
1. 测试覆盖严重碎片化——只执行 agent-runtime 的 provider 子目录测试
2. 两个 test suite 使用 `|| true` 模式静默吞噬失败（`ci.yml:85,88`）
3. 无 `test:core`、`test:desktop-helpers`、`test:integration` 的 CI 执行
4. 无任何 Rust crate 的基准测试结果断言
5. 无测试耗时基线监控
6. 桌面应用的 Playwright 视觉测试（`apps/crish-desktop/package.json:16-17`）在 CI 中完全未执行
7. `apps/crish-desktop/package.json:13` 定义的 `qa:check` 脚本包含 hook safety、chat invariants、stress fuzzing、full scenario flow 四项关键质量检查，但 CI 中完全没有触发

### 2.3 代码质量门禁现状

**评分：3/10**

当前质量门禁分布在三个层面：

**本地（git hooks）**：
- `.husky/pre-commit`：`npx lint-staged` — 对 staged 文件执行 eslint --fix + prettier --write
- `.husky/pre-push`：`npm run typecheck && npm test`

`.lintstagedrc.json`（`.lintstagedrc.json:1-5`）定义了：
- `*.{ts,tsx}` → eslint --fix + prettier --write
- `*.css` → stylelint --fix + prettier --write
- `*.{json,md}` → prettier --write

**CI 层面**：
- `ci.yml:136-148` — ESLint job，但只对 `packages/agent-runtime/src/provider/` 执行，且 `2>/dev/null || echo "ESLint check skipped"`——静默跳过错误
- `ci.yml:163-167` — Coverage job，但只有 `Write-Host "Coverage check completed"`，**未实际验证覆盖率阈值**
- `ci.yml:117-134` — Security audit job，使用 `continue-on-error: true`，npm audit 和 cargo audit 的失败**不会阻断流水线**
- `ci.yml:90-114` — provider-json-validate job，格式验证

**关键缺失**：
1. 覆盖率阈值**已定义**（`apps/crish-desktop/vitest.config.ts:13-18`：statements 70%, branches 60%, functions 65%, lines 70%），但 CI 从未验证
2. `npm run lint:all` 定义了 `--max-warnings 0` 严格模式（`package.json:62`），但 CI 只用宽松的 `eslint .`（`package.json:64`）
3. `npm run check:all`（`package.json:65`：typecheck + lint:all + test:coverage）是完整质量门禁，但 CI 从未调用
4. `npm run format`（prettier --check）在 CI 中完全未执行
5. 根 `eslint.config.js` 的 ignores 列表（`eslint.config.js:9-21`）排除了 11 种目录模式，但 CI 中 eslint 执行范围过窄且静默吞错

### 2.4 发布流程现状

**评分：1/10**

`.github/workflows/release.yml` 是唯一的发布流水线，触发条件为 `v*` 标签推送。它：
- 在三平台构建 Tauri 桌面应用（`release.yml:13-45`）
- 使用 `softprops/action-gh-release@v2` 创建 GitHub Release（草稿模式）（`release.yml:58-67`）
- 上传 `.msi`、`.dmg`、`.AppImage`、`.deb` 安装包

**完全缺失**：
1. **npm 发布**——没有任何用于 `@crish/*` 包（shared-types, shared-utils, agent-runtime, agent-orchestrator, agent-daemon, decision-engine）的 npm publish pipeline
2. **daemon 二进制分发**——根 `package.json:29` 定义了 `build:daemon-binary`（`node scripts/bundle-daemon.mjs`），但 release.yml 未将其纳入发布
3. **版本管理自动化**——无 `changeset`、无 `standard-version`、无线下版本 bump 脚本
4. **Changelog 生成**——无任何包有 CHANGELOG.md，也无自动生成机制
5. **发布前质量验证**——release.yml 的 build job 只执行 `build:packages` + Tauri build，未运行完整 `check:all`
6. **Docker 镜像**——项目支持 Tauri 桌面 + daemon 两种交付形态，但无 Docker 镜像构建/发布
7. **Nightly 发布通道**——无 nightly/next 预览发布能力

### 2.5 其他问题

**并发控制**：只有 `release.yml` 定义了 `concurrency` 组（`release.yml:8-10`），`ci.yml` 和 `perf-test.yml` 均无并发控制，可能导致同一 PR 的多次推送产生冗余执行。

**依赖更新**：`.github/dependabot.yml` 已配置 npm 和 cargo 的每周更新，npm 限制 10 个并发 PR、cargo 限制 5 个。但 cargo 配置 `ignore` 了 `conex-stream`（`dependabot.yml:25`），缺少原因说明。

**密钥扫描**：无任何 secrets 扫描工作流。

**Workflow 权限**：`ci.yml` 各 job 未显式声明 `permissions`，使用默认的 GITHUB_TOKEN 权限（读写全部），违反最小权限原则。

## 3 差距深度分析

### 3.1 构建差距

| 差距项 | 现状 | 理想状态 | 影响 |
|--------|------|----------|------|
| **多平台构建** | Rust 三平台 OK；TS 包仅 linux | 所有 TS 包应在 linux/windows/macos 构建 | 跨平台兼容性不可见，Windows 用户可能遇到 esbuild/target 差异 |
| **构建缓存** | Rust 使用 Swatinem/rust-cache；TS 无缓存 | TS 应利用 turbo cache + actions/cache | 重复构建耗时，`build:packages` 约需 2-3 分钟 |
| **增量构建** | 未使用 turbo 的 `--filter` 和 `--since` | PR 级别增量构建 -> 仅构建变更包及其依赖 | 全量构建浪费 CI 时间 |
| **产物管理** | 仅 release.yml 上传 Tauri bundle | 每次 CI 应上传 dist/ 作为 artifact | 无法在非 CI 环境复现/审查构建产物 |
| **Rust 交叉编译** | 无 | 应为 aarch64-linux, aarch64-macos 等目标交叉编译 | 部分 crate（conex-db 含 sqlite native）需要多架构支持 |
| **esbuild 配置一致性** | 各包独立维护 build:js 命令 | 统一 esbuild 配置，通过 turbo 编排 | `packages/agent-daemon/package.json:27` 的 esbuild 命令与 `packages/shared-utils/package.json:47-49` 的配置不完全一致 |
| **TS 编译产物** | 每个包运行 tsc --emitDeclarationOnly | 单次 tsc -b 项目引用模式 | 7 个包各跑独立 tsc，重复解析 node_modules |

`turbo.json` 定义了 `outputs: ["dist/**", ".tsbuildinfo"]`（`turbo.json:6`），但 CI 中从未利用这个缓存声明。如果能通过 turbo remote caching（如 `turbo-cloud` 或 `turbo-server`）共享缓存，`build:packages` 的耗时可以从 ~150s 降至 ~10s（缓存命中时）。

### 3.2 测试差距

| 差距项 | 现状 | 理想状态 | 影响 |
|--------|------|----------|------|
| **矩阵测试** | 无 Node 版本矩阵 | Node 20/22/23, 每 OS | 不同 Node 版本的 ESM/TS 行为差异不可见 |
| **操作系统矩阵** | TS 仅 linux | linux/windows/macos | windows 上 vitest 的 jsdom 行为差异（`vitest.config.ts` 已配置 jsdom）不可见 |
| **Rust 测试覆盖** | `cargo test --workspace` + `cargo test --all-features` 分离 | 统一 `cargo test --workspace --all-features` | `ci.yml` 中 `rust-check` 和 `rust-stream-test` 分离，冗余 |
| **集成测试** | `test:integration` 存在但 CI 不执行 | CI 应运行完整的 `test:integration` | 跨包集成问题遗漏 |
| **E2E 测试** | 仅 provider e2e（`ci.yml:180-181`） | 应包含端到端 daemon→runtime→orchestrator 流程 | 架构层间契约断裂不可见 |
| **视觉测试** | Playwright 测试已配置（`apps/crish-desktop/package.json:16-17`） | CI 应执行 `test:visual` | UI 回归不可见 |
| **基准测试断言** | `ci.yml:191` 使用 `|| true` 静默吞结果 | 应有性能退化阈值断言 | 性能退化不被阻断 |
| **测试报告** | vitest 输出到 stdout | 应生成 JUnit XML + HTML 报告并归档 | 无法追溯历史测试结果 |
| **测试耗时监控** | 无 | 记录每次 CI 的测试耗时，建立基线 | 测试膨胀不被感知 |

`vitest.config.ts:8` 的 include 模式包含 `apps/**` 下的测试，且 `vitest.setup.ts`（`vitest.setup.ts:1-44`）为 Node 环境补充了 localStorage、dispatchEvent、CustomEvent 等 browser 全局变量，说明 vitest 可用于运行部分前端逻辑测试。但 CI 中 `npx vitest run packages/agent-runtime/src/provider/__tests__/` 只传入了一个子目录，忽略了其他所有测试。

### 3.3 质量门禁差距

| 差距项 | 现状 | 理想状态 | 影响 |
|--------|------|----------|------|
| **覆盖率阈值强制** | 定义（`apps/crish-desktop/vitest.config.ts:13-18`）但不验证 | CI 硬性阻断低于阈值的提交 | 代码覆盖率持续下降不可控 |
| **lint 严格模式** | `package.json:64` 的 `lint` 无 `--max-warnings` | 使用 `lint:all`（`--max-warnings 0` + stylelint） | 新 warning 持续引入不被注意 |
| **TypeScript 严格模式** | `tsconfig.base.json:8-23` 已启用 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` | CI 应对所有包运行 `tsc --noEmit` | 类型安全门禁仅覆盖 crish-desktop |
| **格式化校验** | `npm run format`（prettier --check）存在但不执行 | CI 应运行 prettier --check | 代码风格不一致持续引入 |
| **依赖合规** | `dependency-cruiser` 在 devDependencies（`package.json:73`）但未在 CI 中使用 | 运行 depcruise 检查循环依赖和层级违规 | 架构耦合（现有 105 个架构耦合问题）持续恶化 |
| **Store 类型安全** | `check:store-types` 脚本（`package.json:56`）存在 | CI 执行 store 类型安全检查 | store 中的 `as any` 模式不被发现 |
| **API 契约验证** | 无 | OpenAPI/Swagger 或 tRPC 级别的 API schema 验证 | IPC 边界脆弱性（现有 15 个 IPC 问题）持续存在 |
| **死代码检测** | 无 | tsc 的 `noUnusedLocals` 和 `noUnusedParameters`（`tsconfig.base.json:18-19`）当前被关闭 | 死代码积累 |
| **CSS 质量** | `lint:css` 使用 stylelint（`package.json:63`） | CI 应执行 CSS lint | CSS 质量问题不被发现 |

### 3.4 安全差距

| 差距项 | 现状 | 理想状态 | 影响 |
|--------|------|----------|------|
| **依赖审计（npm）** | `ci.yml:132-134` 使用 `continue-on-error: true` | 严重/高危漏洞应阻断流水线 | 已知漏洞可以流入生产 |
| **依赖审计（cargo）** | `ci.yml:122-123` 使用 `continue-on-error: true` | cargo audit 失败应阻断流水线 | Rust crate 漏洞可流入 |
| **密钥扫描** | 无 | CI 应扫描提交历史中的硬编码密钥 | 密钥泄露风险 |
| **CSP 验证** | 无 | 运行时 Content-Security-Policy 验证 | XSS 攻击面不可控 |
| **SBOM 生成** | 无 | 每次发布生成 CycloneDX/Syft SBOM | 供应链安全合规缺失 |
| **npm 签名验证** | `npm audit signatures` 未执行 | 验证 registry 签名完整性 | 证书劫持风险 |
| **Docker 镜像扫描** | 无 | 容器镜像层漏洞扫描 | 运行时安全风险 |

`eslint.config.js:9-21` 的 ignores 列表排除了 `.agent-runtime/`、`.agents/`、`.claude/`、`.codex/`、`.firecrawl/`、`.trae/` 等目录，这些是 AI Agent 的工作目录，可能包含 API 密钥和用户数据。CI 不应扫描这些目录，但生成物管理需要确保这些目录不被意外打包。

### 3.5 发布差距

| 差距项 | 现状 | 理想状态 | 影响 |
|--------|------|----------|------|
| **npm 包发布** | 无 | `@crish/shared-types`, `@crish/shared-utils`, `@crish/agent-runtime`, `@crish/agent-orchestrator`, `@crish/agent-daemon`, `@crish/decision-engine` 应发布到 npm | 无法被外部项目作为依赖使用 |
| **版本管理** | 所有包硬编码 `0.1.0`（各 `package.json` 的 version 字段） | 统一版本管理（changesets 或 workspace version） | 手动修改版本号容易出错 |
| **Changelog** | 无任何 CHANGELOG.md | 每个包应有自动生成的 CHANGELOG | 无法追踪版本间变更 |
| **GitHub Release 信息** | `release.yml:61` 使用 `generate_release_notes: true`（自动生成） | 应使用结构化的 CHANGELOG 内容 + 从 git log 生成的 release notes | Release notes 信息量不足 |
| **daemon 二进制** | `scripts/bundle-daemon.mjs` 存在 | release.yml 应构建并上传 daemon binary | daemon 不能独立于 Tauri 桌面分發 |
| **Docker 镜像** | 无 Dockerfile | 构建并发布 daemon + Tauri 的 Docker 镜像 | 无法在服务器环境部署 |
| **发布前干运行** | 无 | CI 应支持发布前全部件构建验证 | 发布流程不可预测 |
| **回滚机制** | 无 | 支持 npm dist-tag 回滚、GitHub Release 撤销 | 错误发布不可恢复 |

### 3.6 监控差距

| 差距项 | 现状 | 理想状态 | 影响 |
|--------|------|----------|------|
| **构建时间趋势** | 无 | 记录每次 CI 构建总耗时、各阶段耗时 | 构建膨胀不可见 |
| **测试失败率** | 无 | 记录测试历史成功率、失败分布 | 测试健康度不可度量 |
| **覆盖率趋势** | 无 | 记录覆盖率历史曲线 | 覆盖率下降不被感知 |
| **性能基线** | `perf-test.yml` 执行基准测试但未持久化基线 | 基准测试结果持久化到存储，PR 间自动对比 | 性能退化直到发布才被发现 |
| **构建失败告警** | 无（默认 GitHub 通知） | 失败告警到即时通讯工具 | 构建失败响应延迟 |
| **依赖过期追踪** | Dependabot 只开 PR，无升级优先级标记 | 依赖过期年龄、安全严重度的仪表盘 | 技术债务管理缺失 |
| **二进制大小追踪** | 无 | 记录每次构建的 dist/ 大小 | 包体积膨胀不可见 |

## 4 根因分析

### 4.1 为什么 CI/CD 一直缺失

1. **项目演进阶段**: `package.json:2` 定义版本为 `0.1.0`，项目处于早期开发阶段。优先建立了 Rust CI（成熟的 cargo 工具链 + GitHub Actions 生态），但 TS/JS 部分采用"手动可用即可"的轻量策略。

2. **依赖复杂度过高**: 项目采用 npm workspaces（10 个工作空间包）+ Rust workspace（12 个 crate）+ Tauri（Rust+JS 混合架构）+ esbuild（JS bundle）+ tsc（类型生成）+ turbo（构建编排）的多层构建体系。相比单一构建工具的项目，CI 集成的认知负荷显著更高。团队可能因为"构建系统过于复杂以至于不知道如何在 CI 中正确配置"而推迟集成。

3. **构建碎片化**: 每个子包独立维护 `build` / `build:types` / `build:js` 命令（如 `packages/agent-daemon/package.json:25-28`、`packages/shared-types/package.json:25-28`）。虽然构建模式高度一致（clean → tsc declaration → esbuild），但无脚本层面的统一抽象，导致 CI 配置难以简洁表达"构建全部包"。

4. **测试基础设施不统一**：
   - vitest 用于单元测试（Node 环境 + jsdom 环境）
   - Playwright 用于视觉测试（`apps/crish-desktop/package.json:17`）
   - cargo test 用于 Rust 测试
   - `tests/stress/` 下的自定义测试框架（`package.json:42-45`）
   - 多种测试框架增加了 CI 配置复杂度

5. **本地验证替代 CI**：`.husky/pre-push` 执行 `npm run typecheck && npm test`，可能使团队认为"提交前本地运行通过了就是好的"，从而推迟 CI 建设。但 `npm run typecheck` 只 cover `apps/crish-desktop/tsconfig.json`（`package.json:54`），`npm test` 运行所有 vitest 测试（含 e2e），本地运行时可能因缺少 provider API key 跳过或超时。

6. **发布流程未定义**: 项目尚未进行过正式发布（所有包版本为 `0.1.0`），因此发布流水线未被强制要求。`release.yml` 的创建可能来自 Tauri 模板的默认配置，而非主动设计。

### 4.2 当前架构中让 CI 难以接入的设计

1. **development exports condition 依赖**: 所有包的 `package.json` 使用 `exports` 字段（详见 `packages/agent-daemon/package.json:9-20`、`packages/shared-utils/package.json:9-40`），通过 `development` custom condition 在开发时直接使用 `.ts` 源文件。这需要 CI 任务正确设置 `--conditions development` 标志，或确保所有 `dist/` 产物为最新。当前 CI 的 `npx tsc --noEmit` 命令未设置此条件，可能导致类型检查偏差。

2. **tsc-alias 后处理**: 每个包的 `build:types` 命令（如 `packages/agent-daemon/package.json:26`）使用 `tsc-alias` 解析 path alias。如果在 CI 中只做 `tsc --noEmit` 而不运行 `tsc-alias`，类型检查可能通过但实际产物中路径无效。

3. **tsbuildinfo 缓存手动清理**: 各包的 `build:types` 命令（如 `packages/shared-types/package.json:26`）会 `rmSync` 清空 `.tsbuildinfo` 缓存，这与 turbo 的增量构建意图矛盾。如果 CI 用 turbo 编排，需要处理这个冲突。

4. **esbuild 配置重复**: 各包的 `build:js` 命令参数不统一：
   - `packages/agent-daemon/package.json:27`: `esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap`
   - `packages/shared-utils/package.json:47-49`: 同样的参数 + 额外的 browser/node 入口
   - `packages/decision-engine/package.json:25`: 同样的参数
   虽然参数一致，但分散在 7 个文件中，CI 配置难以统一引用和管理。

5. **Tauri 构建的前置条件**: `apps/agent-workbench/package.json:9` 的 build 命令重定向到 `../crish-desktop`，而 `apps/crish-desktop/package.json:10` 的 build 是 `tsc -b && vite build`。CI 中运行 Tauri build 需要安装系统级依赖（`release.yml:33-35` 列出的 libgtk-3, libwebkit2gtk-4.1 等），增加了跨平台 CI 的维护成本。

6. **stress/bench 测试的外部依赖**: `package.json:42-47` 定义的 stress 测试和 bench 测试可能依赖外部 Provider API，使 CI 运行这些测试需要 API key 管理。

## 5 影响评估

### 5.1 安全性风险

- **高**: 依赖审计使用 `continue-on-error: true`（`ci.yml:122,134`），已知高/严重漏洞不会阻断流水线。例如，如果 `ws`（`package.json:93`，daemon 和 runtime 使用）或 `@modelcontextprotocol/sdk`（`packages/agent-daemon/package.json:39`）出现安全漏洞，CI 不会拒绝其进入 main 分支。
- **高**: 无密钥扫描，历史记录中的密钥泄露不可追溯。部分 crates（如 `conex-net`、`conex-db`）可能在测试中写入临时凭证。
- **中**: 无 SBOM 生成，无法满足供应链安全审计需求。
- **中**: `npm audit signatures` 未执行，注册表签名完整性无法验证。

### 5.2 质量风险

- **高**: 覆盖率阈值已定义但不强制（`apps/crish-desktop/vitest.config.ts:13-18`），代码覆盖率持续下降。当前 8 个分析维度报告了 215 个问题，覆盖 130+ 源文件，无 CI 门禁意味着这些问题将持续存在甚至恶化。
- **高**: TypeScript 严格模式（`tsconfig.base.json` 的 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）仅在 `npm run typecheck` 中对 crish-desktop 执行，其他 9 个工作空间包的类型安全不验证。
- **中**: `eslint.config.js` 的 `react-refresh/only-export-components` 规则和 `no-restricted-syntax` 规则仅在本地 pre-commit 触发，CI 不执行。
- **中**: `command-registry:check`（`apps/agent-workbench/package.json:12`）验证 Tauri command 注册完整性，CI 不执行。
- **低**: `check:store-types`（`package.json:56`）验证 store 中无 `as any` 模式，CI 不执行。

### 5.3 协作效率风险

- **高**: CI 碎片化（只测试 1/7 个 TS 包）导致 PR 合并后其他包的代码损坏不会被及时发现。例如，修改 `@crish/shared-types` 后，`@crish/agent-runtime` 和 `@crish/agent-orchestrator` 的测试均不执行。
- **高**: 无矩阵测试导致不同 OS/Node 版本的兼容性问题直到用户报告才被发现。
- **中**: 构建不使用 turbo 缓存，每次 CI 全量构建 `build:packages`，浪费约 2-3 分钟。
- **中**: 无集成测试执行，跨包契约变更的风险不可见。特别是 `@crish/agent-orchestrator` 依赖 `@crish/agent-runtime`（`packages/agent-orchestrator/package.json:31`），`@crish/agent-daemon` 依赖 `@crish/agent-orchestrator`（`packages/agent-daemon/package.json:33`），这条依赖链的断裂不会被早期发现。
- **低**: visual testing 在 CI 中缺失，UI 回归问题进入生产。
- **低**: 基准测试结果不持久化，性能退化趋势不可追溯。

## 6 具体代码证据索引

以下按文件路径和行号列出本文引用的所有关键证据点：

| 文件 | 行号 | 内容 |
|------|------|------|
| `package.json` | 2 | 版本 `0.1.0` 表明早期阶段 |
| `package.json` | 7-16 | npm workspaces 10 个包 |
| `package.json` | 17-67 | 全部 50 条 script 定义 |
| `package.json` | 24-30 | 分层构建链：build:shared-types → build:product |
| `package.json` | 49 | `perf:all` 聚合性能命令 |
| `package.json` | 50 | `check:core` 聚合 check 命令 |
| `package.json` | 54 | `typecheck` 只 cover crish-desktop |
| `package.json` | 56 | `check:store-types` 存在但不 CI |
| `package.json` | 57-61 | 测试命令定义 |
| `package.json` | 62-65 | lint/check 严格模式与宽松模式并存 |
| `package.json` | 69-86 | devDependencies 含 dependency-cruiser, esbuild, vitest 等 |
| `turbo.json` | 3-30 | pipeline 定义含 7 个任务 |
| `turbo.json` | 6 | `outputs: ["dist/**", ".tsbuildinfo"]` 缓存声明在 CI 中未用 |
| `tsconfig.base.json` | 8-23 | strict 模式开启但 CI 未全部验证 |
| `tsconfig.base.json` | 18-19 | noUnusedLocals/noUnusedParameters 关闭，死代码不可检测 |
| `vitest.config.ts` | 7-16 | include 覆盖 packages + apps，但 CI 只传子路径 |
| `vitest.config.ts` | 13-16 | coverage 配置 v8, text/json/html 报告 |
| `apps/crish-desktop/vitest.config.ts` | 13-18 | 覆盖率阈值已定义但不强制 |
| `eslint.config.js` | 9-21 | ignores 列表含 11 种 AI Agent 工作目录 |
| `eslint.config.js` | 55-57 | Frontend rules 覆盖 crish-desktop + agent-workbench |
| `.lintstagedrc.json` | 1-5 | lint-staged 配置（ts, css, json） |
| `.husky/pre-commit` | 1 | `npx lint-staged` |
| `.husky/pre-push` | 1 | `npm run typecheck && npm test` |
| `packages/agent-daemon/package.json` | 25-28 | build 三元组：clean → build:types(tsc) → build:js(esbuild) |
| `packages/agent-daemon/package.json` | 26 | tsc-alias 后处理 |
| `packages/shared-types/package.json` | 25-28 | 同样 build 模式 |
| `packages/shared-utils/package.json` | 47-49 | 多入口 esbuild（browser + node） |
| `packages/agent-orchestrator/package.json` | 31 | 依赖 chain: orchestrator → runtime |
| `packages/agent-daemon/package.json` | 33 | 依赖 chain: daemon → orchestrator |
| `apps/agent-workbench/package.json` | 12 | cli:check 含 command-registry:check |
| `apps/crish-desktop/package.json` | 10 | build = tsc -b && vite build |
| `apps/crish-desktop/package.json` | 13 | qa:check 含 4 项关键质量测试 |
| `apps/crish-desktop/package.json` | 16-17 | Playwright visual test 配置 |
| `Cargo.toml` | 2-15 | Rust workspace 含 12 个 crate members |
| `Cargo.toml` | 60-66 | workspace.package 元数据 |
| `.github/dependabot.yml` | 1-25 | dependabot 配置 npm + cargo |
| `.github/dependabot.yml` | 25 | `ignore: conex-stream` 缺少原因 |
| `.github/workflows/ci.yml` | 79 | TS check 只 cover agent-runtime |
| `.github/workflows/ci.yml` | 85,88 | test suites 用 `|| true` 静默吞失败 |
| `.github/workflows/ci.yml` | 117-134 | security-audit 用 continue-on-error |
| `.github/workflows/ci.yml` | 136-148 | ESLint 只 cover provider 子目录 |
| `.github/workflows/ci.yml` | 163-167 | coverage check 无实际阈值验证 |
| `.github/workflows/ci.yml` | 169-181 | e2e 只 cover provider e2e |
| `.github/workflows/ci.yml` | 209 | bench 用 `|| true` 静默 |
| `.github/workflows/perf-test.yml` | 1-137 | 性能测试无 Node 版本矩阵、无跨平台 |
| `.github/workflows/provider-validation.yml` | 1-83 | 独立的 provider JSON 校验 |
| `.github/workflows/release.yml` | 61 | 使用 `generate_release_notes: true`（自动）而非结构化 |
| `.github/workflows/release.yml` | 23 | Node 20（落后当前版本） |
| `vitest.setup.ts` | 1-44 | browser 全局补齐，vite 跨环境测试准备 |

## 数据支撑

- 项目总包数：npm workspaces 10 + Rust workspace 12 = 22 个可构建单元
- CI 中实际执行的 TS 子包数：1（agent-runtime 的 provider 子目录）
- CI 中实际执行的 Rust crate 覆盖率：通过 `cargo test --workspace` 覆盖 12 个 crate + 独立 conex-stream
- TypeScript 测试文件：`vitest.config.ts:8-11` 定义的 include 模式覆盖约数百个测试文件，CI 中仅执行 <5%
- 构建命令数：根 package.json 50 条 script + 各子包约 30 条 script = 约 80 条可执行命令
- CI 中实际触发的构建命令数：约 12 条（仅针对 agent-runtime 和 Rust crate）
- 发布制品类型：npm 包（6 个）、Tauri 桌面安装包（3 平台）、daemon 二进制（未纳入 CI）

### 3.7 CI 基础设施差距

| 差距项 | 当前状态 | 理想状态 | 涉及 |
|--------|----------|----------|------|
| 并发控制 | 仅 release.yml 有 | 所有 workflow 统一并发策略 | ci.yml, perf-test.yml |
| 权限最小化 | 未声明 permissions | 每个 job 显式最小权限 | 所有 workflow |
| 路径过滤 | 无 | 只触发变更相关 job | ci.yml |
| 超时设置 | e2e 有 5min（ci.yml:171），其余默认 | 合理超时 + 通知 | 所有 workflow |
| 重试策略 | 无 | 测试或步骤失败自动重试 | ci.yml |
| Runner 选择 | 全部 GitHub-hosted | 关键 job 可切换自托管 | 无 |
| 环境变量管理 | 无组织 | 环境变量分组/命名规范 | 所有 workflow |
| workflow 间复用 | 无 | 可复用的 composite action | 无 |
| 自动取消冗余 | 无 | 同 PR 旧推送自动取消 | ci.yml, perf-test.yml |

## 4 根因分析

### 4.1 Ϊʲô CI/CD һֱȱʧ

**根因 1：项目演进阶段与优先级错位**

项目版本为 0.1.0（package.json:2），处于早期开发阶段。团队优先建立了 Rust CI（ci.yml:13-42 的 rust-check job），因为 Rust 的 cargo 工具链在 CI 中配置简单且有成熟的 action。TS/JS 部分的构建体系复杂（npm workspaces + turbo + esbuild + tsc + Vite + tsc-alias + Tauri），团队可能认为手动构建已足够或先让功能跑起来再考虑 CI。

Rust CI 复杂度: cargo check/test/clippy/fmt -> 4 条命令，所有 crate 统一
TS CI 复杂度: tsc --noEmit x 7 个包 + esbuild x 7 个包 + vite build + tsc-alias x 7 + 依赖顺序管理 + development exports -> 约 30 条命令

**根因 2：依赖复杂度过高导致认知负荷超载**

项目采用 npm workspaces（10 个包）+ Rust workspace（12 个 crate）+ Tauri + esbuild + tsc + turbo + tsc-alias 的多层构建体系。每个包有独立的 tsconfig、esbuild 配置和 build 脚本。这种拓扑结构使得在 CI 中正确配置构建顺序的认知成本远高于单包项目。团队可能陷入分析瘫痪——因为构建系统过于复杂以至于不知道如何在 CI 中正确配置，所以选择不配置。

**根因 3：构建碎片化与脚本重复**

7 个 TS 包各自维护重复的 build / build:types / build:js 命令。虽然模式高度一致（clean -> tsc declaration -> esbuild），但无抽象层：

- packages/agent-daemon/package.json:25-28: clean -> build:types -> build:js
- packages/shared-types/package.json:25-28: clean -> build:types -> build:js
- packages/shared-utils/package.json:44-50: clean -> build:types -> build:js -> build:js:browser -> build:js:node
- packages/decision-engine/package.json:22-26: clean -> build:types -> build:js
- packages/agent-runtime/package.json:34-38: clean -> build:types -> build:js
- packages/agent-orchestrator/package.json:24-28: clean -> build:types -> build:js

这个模式的 6 次重复意味着对构建的任何修改都需要修改 6 个文件。如果要在 CI 中构建全部，目前的做法是 npm run build:packages，这是个 npm 脚本而非工具层的单点配置。

**根因 4：本地验证的虚假安全感**

.husky/pre-push 执行 npm run typecheck && npm test。表面上这提供了提交前的质量门禁，但实际上：
- npm run typecheck 只检查 apps/crish-desktop/tsconfig.json（package.json:54），其他 6 个 TS 包的类型完全不检查
- npm test 运行全部 vitest 测试（包括 e2e），本地因缺少 Provider API key 会跳过或失败
- 开发者可以使用 git push --no-verify 完全绕过这些检查

本地验证体系的不完善可能使团队产生我们已经有了检查的错觉，从而推迟 CI 建设。

**根因 5：测试基础设施不统一**

项目使用多种测试框架和测试类型：
- vitest（单元测试，Node + jsdom 双环境）
- Playwright（视觉测试，apps/crish-desktop/package.json:17）
- cargo test（Rust 测试）
- 自定义 stress 测试框架（package.json:42-45）
- 自定义 benchmark 框架（package.json:36-38）
- 自定义 startup 测试（package.json:46-47）

测试框架的多样性增加了 CI 配置的复杂度。每种测试框架都需要不同的安装步骤、不同的 runner 配置和不同的报告格式。

**根因 6：发布流程尚未触发**

项目尚未进行过正式发布。所有包版本为 0.1.0，无任何 CHANGELOG 文件。release.yml 的存在可能来自 create-tauri-app 模板的默认配置，而非主动设计。因为没有实际的发布需求，发布流水线未被强制要求，npm publish 等能力的缺失也就没有被注意到。

### 4.2 架构设计对 CI 接入的阻碍

**阻碍 1：development exports condition 依赖**

所有包的 package.json 使用 exports 字段的 development condition。以 packages/agent-daemon/package.json:9-20 为例，development 条件让 tsc 在开发时解析到 src/index.ts，否则解析到 dist/index.js。这需要 CI 任务正确设置 --conditions development 标志，否则 tsc 会尝试解析到 dist/ 产物而不是 src/ 源文件。当前 CI 的 npx tsc --noEmit 命令未显式设置此条件。

**阻碍 2：tsc-alias 后处理**

每个包的 build:types 命令（如 packages/agent-daemon/package.json:26）使用 tsc-alias 解析 path alias。如果在 CI 中只做 tsc --noEmit 而不运行 tsc-alias，类型检查可能通过但实际产物中路径无效。tsc-alias 将 tsconfig.json 中的 paths 映射解析为相对路径，这是生成可用类型声明文件的关键步骤。

**阻碍 3：tsbuildinfo 缓存手动清理**

各包的 build:types 命令执行 rmSync 清空 .tsbuildinfo 缓存。例如 packages/shared-types/package.json:26 的 node -e require('node:fs').rmSync('../../node_modules/.cache/shared-types.tsbuildinfo', { force: true })。这与 turbo 的增量构建意图矛盾——turbo 依赖 .tsbuildinfo 文件检测源代码变更。如果 CI 用 turbo 编排，需要处理这个冲突：要么移除手动清理步骤，要么在 turbo 的 pipeline 定义中标记 clean 任务为类型检查的先决条件。

**阻碍 4：esbuild 配置重复**

各包的 build:js 命令参数分散在 7 个文件中：
- packages/agent-daemon/package.json:27: esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap
- packages/shared-utils/package.json:47: 同上，但有额外的 browser 入口
- packages/shared-utils/package.json:48: esbuild with --platform=browser
- packages/shared-utils/package.json:49: esbuild with --platform=node
- packages/decision-engine/package.json:25: 同上

虽然参数一致（esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap），但分散在多个文件意味着 esbuild 升级（如从 0.27 到 0.28）需要在 7 个地方同步更新配置。

**阻碍 5：Tauri 构建的前置条件**

apps/agent-workbench/package.json:9 的 build 命令重定向到 ../crish-desktop，而 apps/crish-desktop/package.json:10 的 build 是 tsc -b && vite build。CI 中运行 Tauri build 需要系统级依赖（release.yml:33-35 列出的 libgtk-3, libwebkit2gtk-4.1 等），增加了跨平台 CI 的维护成本。这些依赖在 ubuntu:latest 上需要 apt-get install，在 macOS 上需要 brew install，在 Windows 上需要 WebView2 运行时（已预装）。

**阻碍 6：stress/bench 测试的外部依赖**

package.json:42-47 定义的 stress 测试和 bench 测试可能依赖外部 Provider API。如果 CI 在不提供 API key 的情况下运行这些测试，它们会超时或失败。当前 ci.yml 使用 || true 静默模式正是为了解决这个问题。正确的方式应该是：将这些测试从 PR CI 中排除，仅在定时任务（如每日）中运行，并在运行时注入可选的 API key 环境变量。

## 5 影响评估

### 5.1 安全性风险

**高风险**：
- 依赖审计使用 continue-on-error: true（ci.yml:122,134），已知高/严重漏洞不会阻断流水线。如果 ws（package.json:93，daemon 和 runtime 使用 WebSocket 通信）或 @modelcontextprotocol/sdk（packages/agent-daemon/package.json:39，MCP 协议实现）出现安全漏洞，CI 不会拒绝其进入 main 分支。在 CVE-2024-XXXX 类型的漏洞披露后，团队可能在不安全的依赖下运行数天直到下一次手动审计。
- 无密钥扫描，历史记录中的密钥泄露不可追溯。部分 crates（如 conex-net 处理网络通信、conex-db 管理本地数据库）可能在测试配置中写入临时凭证。

**中风险**：
- npm audit signatures 未执行，无法验证注册表签名完整性。如果一个 npm 包的 dist-tag 被劫持，CI 会无感知地安装被篡改的包。
- 无 SBOM 生成，无法满足供应链安全审计需求。对于企业部署场景，SBOM（Software Bill of Materials）是合规性要求。

**低风险**：
- dependabot.yml:25 忽略 conex-stream crate 但缺少原因说明。如果忽略是因为内部审计过的安全，需要明确注释以告知未来的维护者。

### 5.2 质量风险

**高风险**：
- 覆盖率阈值已定义但不强制（apps/crish-desktop/vitest.config.ts:13-18），代码覆盖率持续下降但无人感知。当前 8 个分析维度报告了 215 个问题，覆盖 130+ 源文件，无 CI 门禁意味着这些问题将持续存在甚至恶化。
- TypeScript 严格模式（tsconfig.base.json:8-23 的 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes）仅在 npm run typecheck 中对 crish-desktop 执行，其他 9 个工作空间包的类型安全不验证。如果一个开发者修改了 @crish/shared-types 中的核心类型定义并引入了类型错误，这个错误只有在 crish-desktop 的 tsc 步骤中才可能被发现——但前提是 crish-desktop 使用了该类型。

**中风险**：
- eslint.config.js 的 react-refresh/only-export-components 规则（eslint.config.js:65-68）和 no-restricted-syntax 规则（eslint.config.js:69-76）仅在本地 pre-commit 触发，CI 不执行。如果某开发者跳过了 pre-commit hook，这些规则完全不会被验证。
- command-registry:check（apps/agent-workbench/package.json:12）验证 Tauri command 注册与实现的一致性。如果新增的 Tauri command 忘记注册，CI 不会发现。
- check:store-types（package.json:56）验证 store 中无 as any 模式，但 CI 不执行。store 是应用状态的核心，store 中的类型不安全会扩散到所有使用该状态的组件。

**低风险**：
- 无 Visual Testing 门禁，UI 回归问题可能进入生产。但由于当前项目仍处于 0.1.0 阶段且 UI 快速迭代，视觉测试的 ROI 可能不高。

### 5.3 协作效率风险

**高风险**：
- CI 碎片化（只测试 1/7 个 TS 包）导致 PR 合并后其他包的代码损坏不会被及时发现。例如，修改 @crish/shared-types 后，@crish/agent-runtime 和 @crish/agent-orchestrator 的测试均不执行。这个问题的危险在于——错误在 merge 到 main 之后才可能被其他开发者发现（当他们 git pull 后运行本地测试时），此时错误的提交已经在 main 分支上，修复需要额外的 revert commit。
- 无矩阵测试导致不同 OS/Node 版本的兼容性问题直到用户报告才被发现。例如，Node 20 的 ESM 解析行为与 Node 22 不同，Windows 上的路径分隔符可能导致 esbuild 的 --outfile 路径错误。

**中风险**：
- 构建不使用 turbo 缓存，每次 CI 全量构建 build:packages，浪费约 2-3 分钟。对于一天 20 次 PR 推送的项目，这相当于每天浪费 40-60 分钟的 CI 时间。
- 无集成测试执行，跨包契约变更的风险不可见。依赖链 @crish/agent-orchestrator -> @crish/agent-runtime（packages/agent-orchestrator/package.json:31）和 @crish/agent-daemon -> @crish/agent-orchestrator（packages/agent-daemon/package.json:33）的断裂不会被早期发现。

**低风险**：
- Visual testing 和 benchmark 结果的缺失主要影响发布前的信心度，对日常开发效率影响有限。

## 6 具体代码证据索引

以下按文件路径和行号列出本文引用的所有关键证据点：

| 文件 | 行号 | 内容概要 |
|------|------|----------|
| package.json | 2 | 版本 0.1.0 表明早期阶段 |
| package.json | 7-16 | npm workspaces 10 个包定义 |
| package.json | 17-67 | 全部 50 条 script 定义 |
| package.json | 24 | build:shared-types 入口 |
| package.json | 25 | build:runtime 入口 |
| package.json | 26 | build:orchestrator 入口 |
| package.json | 27 | build:packages 聚合命令 |
| package.json | 28 | build:daemon 入口 |
| package.json | 29 | build:daemon-binary 入口 |
| package.json | 30 | build:product 最终产物命令 |
| package.json | 49 | perf:all 聚合性能命令 |
| package.json | 50 | check:core 聚合 check 命令 |
| package.json | 54 | typecheck ֻ cover crish-desktop |
| package.json | 56 | check:store-types 存在但不 CI 执行 |
| package.json | 57 | test:core 定义 |
| package.json | 58 | test:desktop-helpers 定义 |
| package.json | 59 | test 全部测试 |
| package.json | 60 | test:coverage 带覆盖率 |
| package.json | 61 | test:integration 集成测试配置 |
| package.json | 62 | lint:all 严格模式 |
| package.json | 64 | lint 宽松模式 |
| package.json | 65 | check:all 完整质量门禁 |
| package.json | 66-67 | format / format:write |
| package.json | 69-86 | devDependencies 含 18 个工具链包 |
| package.json | 73 | dependency-cruiser 未在 CI 使用 |
| package.json | 88-93 | 生产依赖 6 个包 |
| turbo.json | 3-30 | pipeline 7 个任务定义 |
| turbo.json | 6 | outputs: dist/** + .tsbuildinfo 缓存声明 |
| tsconfig.base.json | 8-23 | strict 模式已开启 |
| tsconfig.base.json | 18-19 | noUnusedLocals/noUnusedParameters 关闭 |
| tsconfig.base.json | 22 | noUncheckedIndexedAccess 开启 |
| tsconfig.base.json | 23 | exactOptionalPropertyTypes 开启 |
| vitest.config.ts | 7-16 | include 覆盖 packages + apps |
| vitest.config.ts | 13-16 | coverage 配置 v8, text/json/html 报告 |
| apps/crish-desktop/vitest.config.ts | 13-18 | 覆盖率阈值 70/60/65/70 |
| eslint.config.js | 9-21 | ignores 列表含 11 种目录 |
| eslint.config.js | 55-57 | Frontend rules crish-desktop + agent-workbench |
| eslint.config.js | 65-68 | react-refresh/only-export-components |
| eslint.config.js | 69-76 | no-restricted-syntax Object.assign 禁止 |
| .lintstagedrc.json | 1-5 | lint-staged ts/css/json 配置 |
| .husky/pre-commit | 1 | npx lint-staged |
| .husky/pre-push | 1 | npm run typecheck && npm test |
| packages/agent-daemon/package.json | 25-28 | build 三元组 clean - types - js |
| packages/agent-daemon/package.json | 26 | tsc-alias 后处理 |
| packages/agent-daemon/package.json | 33 | 依赖 daemon -> orchestrator |
| packages/shared-types/package.json | 25-28 | 标准 build 模式 |
| packages/shared-utils/package.json | 46-49 | 多入口 esbuild（browser + node + 默认） |
| packages/agent-orchestrator/package.json | 31 | 依赖 orchestrator -> runtime |
| packages/agent-daemon/package.json | 39 | @modelcontextprotocol/sdk 依赖 |
| apps/agent-workbench/package.json | 9 | build 重定向到 crish-desktop |
| apps/agent-workbench/package.json | 12 | cli:check + command-registry:check |
| apps/crish-desktop/package.json | 10 | build = tsc -b && vite build |
| apps/crish-desktop/package.json | 13 | qa:check 4 项质量检查 |
| apps/crish-desktop/package.json | 16-17 | Playwright visual test |
| Cargo.toml | 2-15 | Rust workspace 12 个 crate |
| Cargo.toml | 60-66 | workspace.package 元数据 |
| Cargo.toml | 68-82 | workspace.dependencies 公共依赖 |
| crates/conex-stream/Cargo.toml | 1-21 | 示例 crate 配置 |
| crates/conex-stream/Cargo.toml | 13-18 | criterion benchmark 配置 |
| .github/dependabot.yml | 1-25 | dependabot npm + cargo |
| .github/dependabot.yml | 25 | ignore: conex-stream 缺少原因 |
| .github/workflows/ci.yml | 13-42 | rust-check 三平台 |
| .github/workflows/ci.yml | 30 | Swatinem/rust-cache |
| .github/workflows/ci.yml | 39 | cargo test --workspace |
| .github/workflows/ci.yml | 44-65 | rust-stream-test 独立 |
| .github/workflows/ci.yml | 66-88 | ts-check ֻ cover agent-runtime |
| .github/workflows/ci.yml | 79 | npx tsc --noEmit agent-runtime |
| .github/workflows/ci.yml | 81-82 | Provider tests |
| .github/workflows/ci.yml | 84-85 | Model catalog tests || true |
| .github/workflows/ci.yml | 87-88 | Fallback chain tests || true |
| .github/workflows/ci.yml | 90-114 | provider-json-validate |
| .github/workflows/ci.yml | 117-134 | security-audit continue-on-error |
| .github/workflows/ci.yml | 136-148 | ESLint 仅 provider 子目录 |
| .github/workflows/ci.yml | 150-167 | coverage 无阈值验证 |
| .github/workflows/ci.yml | 169-181 | e2e 仅 provider |
| .github/workflows/ci.yml | 184-197 | bench-rust || true |
| .github/workflows/ci.yml | 199-209 | bench-ts || true |
| .github/workflows/perf-test.yml | 1-137 | 性能测试无 Node 矩阵 |
| .github/workflows/release.yml | 1-67 | 发布流水线 |
| .github/workflows/release.yml | 23 | Node 20 落后 |
| .github/workflows/release.yml | 37 | build:packages 非 build:product |
| .github/workflows/release.yml | 61 | generate_release_notes: true |
| vitest.setup.ts | 1-44 | browser 全局补齐 |

## 数据总览

- 项目总包数：npm workspaces 10 + Rust workspace 12 = 22 个可构建单元
- CI 中实际执行的 TS 子包数：1（agent-runtime 的 provider 子目录）
- TypeScript 测试文件：vitest.config.ts:8-11 定义的 include 模式覆盖约数百个测试文件，CI 中仅执行约 3-5%
- 构建命令数：根 package.json 50 条 + 各子包约 30 条 = 约 80 条可执行命令
- CI 中实际触发的构建命令数：约 12 条（仅针对 agent-runtime 和 Rust crate）
- 发布制品类型：npm 包（6 个）、Tauri 桌面安装包（3 平台）、daemon 二进制（未纳入 CI）
- 现有 workflow 数：4（ci.yml 209 行, perf-test.yml 137 行, provider-validation.yml 83 行, release.yml 67 行）

## 7 逐文件 CI 覆盖度审计

本节对项目每个可构建单元在 CI 中的覆盖度进行逐文件审计。

### 7.1 根 package.json 脚本覆盖度

根 package.json 定义了 50 条 script（package.json:17-67），现逐条审计 CI 覆盖情况：

| Script | 行号 | 功能 | CI 执行? | 执行位置 |
|--------|------|------|----------|----------|
| prepare | 18 | husky install | 否 | N/A（CI 中 npm ci 自动处理） |
| dev:desktop | 19 | 开发服务器 | N/A | 不需要 CI |
| dev:workbench | 20 | Tauri dev | N/A | 不需要 CI |
| dev:cli | 21 | CLI dev | N/A | 不需要 CI |
| build:desktop | 22 | desktop 构建 | 否 | N/A |
| build:workbench | 23 | workbench 构建 | 否 | N/A |
| build:shared-types | 24 | shared-types 构建 | 否 | N/A |
| build:runtime | 25 | runtime 构建 | 否 | N/A |
| build:orchestrator | 26 | orchestrator 构建 | 否 | N/A |
| build:packages | 27 | 聚合构建 | 部分 | release.yml:37 |
| build:daemon | 28 | daemon 构建 | 否 | N/A |
| build:daemon-binary | 29 | daemon 二进制 | 否 | N/A |
| build:product | 30 | 最终产物 | 否 | N/A |
| cli | 31 | CLI 别名 | N/A | 不需要 CI |
| daemon | 32 | daemon 开发 | N/A | 不需要 CI |
| daemon:dist | 33 | daemon 二进制运行 | N/A | 不需要 CI |
| bench:daemon | 34 | daemon 基准 | 否 | N/A |
| bench | 35 | TS 基准 | 部分 | perf-test.yml:28 |
| bench:mem | 36 | 内存基准 | 部分 | perf-test.yml:31 |
| bench:ci | 37 | CI 基准聚合 | 否 | N/A |
| bench:acceptance | 38 | 接受度基准 | 部分 | perf-test.yml:37 |
| bench:native-sla | 39 | 原生基准 | 否 | N/A |
| bench:native | 40 | 原生基准别名 | 否 | N/A |
| bench:report | 41 | 基准报告 | 部分 | perf-test.yml:40 |
| stress | 42 | 压力测试 | 部分 | perf-test.yml:60 |
| stress:ai | 43 | AI 流压力 | 否 | N/A |
| stress:diff | 44 | diff 压力 | 否 | N/A |
| stress:session | 45 | session 切换压力 | 否 | N/A |
| startup:cold | 46 | 冷启动测量 | 否 | N/A |
| startup:warm | 47 | 热启动测量 | 否 | N/A |
| perf:all | 48 | 性能全量 | 否 | N/A |
| check:core | 50 | 核心类型检查 | 否 | N/A |
| check:runtime | 51 | runtime 类型检查 | 部分 | ci.yml:79 |
| check:orchestrator | 52 | orchestrator 类型检查 | 否 | N/A |
| check:daemon | 53 | daemon 类型检查 | 否 | N/A |
| check:workbench | 54 | workbench 检查 | 否 | N/A |
| typecheck | 55 | desktop 类型检查 | 否 | N/A |
| check:desktop | 56 | desktop 检查 | 否 | N/A |
| check:store-types | 57 | store 类型安全 | 否 | N/A |
| test:core | 58 | 核心测试 | 否 | N/A |
| test:desktop-helpers | 59 | desktop 测试 | 否 | N/A |
| test | 60 | 全部测试 | 部分 | ci.yml:81-88 |
| test:coverage | 61 | 带覆盖率测试 | 部分 | ci.yml:162 |
| test:integration | 62 | 集成测试 | 否 | N/A |
| lint:all | 63 | 严格 lint | 否 | N/A |
| lint:css | 64 | CSS lint | 否 | N/A |
| lint | 65 | 宽松 lint | 部分 | ci.yml:148 |
| check:all | 66 | 完整质量门禁 | 否 | N/A |
| format | 67 | prettier --check | 否 | N/A |
| format:write | 68 | prettier --write | N/A | 不需要 CI |

总计：50 条 script 中，CI 覆盖约 12 条（24%），其中 5 条使用 || true 静默模式。核心构建构建链 build:product（6 个子命令）完全未在 CI 中执行。

### 7.2 子包 package.json 脚本覆盖度

| 包 | 脚本数 | CI 覆盖 | 覆盖度 |
|----|--------|---------|--------|
| packages/agent-runtime | 4 | 类型检查 + 测试 | 50% |
| packages/agent-daemon | 7 | 无 | 0% |
| packages/shared-types | 4 | 无 | 0% |
| packages/shared-utils | 7 | 无 | 0% |
| packages/decision-engine | 4 | 无 | 0% |
| packages/agent-orchestrator | 4 | 无 | 0% |
| apps/crish-desktop | 8 | 无 | 0% |
| apps/agent-workbench | 6 | 无 | 0% |

### 7.3 TypeScript 文件类型检查覆盖度

项目 TS 文件分布与 CI 类型检查覆盖：

| 目录 | tsconfig | tsc 在 CI? | 行数（估） |
|------|----------|-----------|-----------|
| apps/crish-desktop/ | apps/crish-desktop/tsconfig.json | 否 | ~20000 |
| apps/agent-workbench/ | apps/agent-workbench/tsconfig.json | 否 | ~5000 |
| packages/shared-types/ | packages/shared-types/tsconfig.build.json | 否 | ~3000 |
| packages/shared-utils/ | packages/shared-utils/tsconfig.build.json | 否 | ~4000 |
| packages/decision-engine/ | packages/decision-engine/tsconfig.build.json | 否 | ~2000 |
| packages/agent-runtime/ | packages/agent-runtime/tsconfig.json | 部分（--noEmit） | ~15000 |
| packages/agent-orchestrator/ | packages/agent-orchestrator/tsconfig.build.json | 否 | ~5000 |
| packages/agent-daemon/ | packages/agent-daemon/tsconfig.build.json | 否 | ~3000 |

只有约 15% 的 TS 代码在 CI 中接受了类型检查。

### 7.4 Rust crate 测试覆盖度

Cargo.toml:2-15 定义的 12 个 crate 在 CI 中的覆盖：

| Crate | cargo test | cargo clippy | cargo fmt | 独立测试 |
|-------|-----------|-------------|-----------|----------|
| conex-stream | workspace 级 | workspace 级 | workspace 级 | all-features |
| conex-ipc | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-types | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-net | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-db | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-search | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-compaction | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-sandbox | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-diff | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-fs | workspace 级 | workspace 级 | workspace 级 | 否 |
| conex-http | workspace 级 | workspace 级 | workspace 级 | 否 |
| tauri-app | workspace 级 | workspace 级 | workspace 级 | 否 |

Rust 覆盖度明显更好：通过 workspace 级命令覆盖全部 12 个 crate。主要问题是 cargo test --workspace 不包含 --all-features，且 benchmark 静默。

## 8 Cargo 依赖拓扑

Cargo.toml:68-82 定义了 workspace 级公共依赖：
- serde + serde_json（序列化）
- anyhow（错误处理）
- thiserror（错误 derive）
- tokio（异步运行时，features = [full]）
- reqwest（HTTP 客户端，rustls-tls）
- tauri + tauri-build（桌面框架）
- rusqlite + r2d2 + r2d2_sqlite（数据库）
- notify（文件系统监控）
- similar（diff 引擎）
- derive_builder（Builder 模式）

这些依赖中有 4 个（reqwest, notify, rusqlite, tauri）编译链接到系统库，CI 中的 Rust 工作流需要确保这些系统依赖在 Windows/macOS/Linux 三平台都可用。当前 rust-check job 在 windows-latest 上运行 cargo check 时，rusqlite 的 bundled feature 确保 SQLite 被静态编译，但 tauri 在非 Linux 平台可能缺少某些系统库。这些潜在问题当前未被 CI 检测。

## 9 构建时间与成本估算

基于当前代码规模和 CI 配置，估算各 CI 场景的时间：

**当前 PR CI 时间**（ci.yml 现有 job 的并行执行）：
- rust-check（3 平台并行）: ~5 min
- ts-check: ~3 min（只有 agent-runtime 的 tsc + provider 测试）
- lint: ~1 min（只有 provider 的 eslint）
- coverage: ~2 min（只有 provider 的测试）
- e2e: ~2 min（只有 provider e2e）
- security-audit: ~2 min
- 总计（串行化后最长路径）: ~8 min

**改进后 PR CI 时间**（增量模式）：
- detect-changes: ~30s
- turbo restore cache: ~30s
- 增量 build: ~30s-2min（取决于变更范围）
- 增量 typecheck: ~1-3min
- 增量 lint: ~30s-1min
- 增量 test + coverage: ~2-5min
- Rust check: ~5min（与 TS 并行）
- 总计（最长路径）: ~5-8min（与当前相近，但覆盖度高 5 倍）

**改进后 main CI 时间**（全量模式）：
- turbo run build: ~3min
- typecheck all: ~5min
- lint:all: ~2min
- test:coverage: ~5min
- test:integration: ~5min（含 e2e）
- Rust full: ~6min
- security-audit + secret-scan: ~3min
- 总计（受限于最长串行路径）: ~15-20min

## 10 参考工程实践对比

以下对比基于成熟项目的 CI/CD 最佳实践：

| 实践 | 行业最佳 | conex 现状 | 差距 |
|------|----------|-----------|------|
| PR 自动化测试 | 所有 PR 自动运行相关测试 | 只运行 agent-runtime 子集测试 | 严重 |
| 测试矩阵 | Node 当前 + 上一个 LTS | 单 Node 版本 | 中等 |
| OS 兼容性 | Linux + Windows + macOS | 仅 Linux（TS）/ 三平台（Rust） | 中等 |
| 构建缓存 | 远程缓存 + 增量构建 | 无 TS 缓存 | 严重 |
| Lint 门禁 | zero-warning 阻断 | 子目录 lint 静默 | 严重 |
| 覆盖率门禁 | 阈值硬性阻断 | 有定义不执行 | 严重 |
| 安全扫描 | 定时 + PR 阻断 | continue-on-error | 严重 |
| 密钥扫描 | 提交前 + CI 中 | 无 | 严重 |
| 依赖升级 | 自动化 + 自动合并 | Dependabot 配置 | 良好 |
| 版本管理 | changesets / release-please | 手动 | 严重 |
| 发布流水线 | npm publish + GH Release + Docker | 仅 GH Release（Tauri） | 严重 |
| 发布前验证 | dry-run + check list | 无 | 严重 |
| 性能趋势 | 基线 + 退化阻断 | 无持久化 | 中等 |
| 构建失败告警 | 即时通讯通知 | 默认邮件 | 低 |
| SBOM | 每次发布生成 | 无 | 中等 |

## 11 子项分类汇总与严重度矩阵

### 11.1 按严重度分类

| 严重度 | 数量 | 描述 |
|--------|------|------|
| P0 - 严重阻断 | 12 | 静默吞失败、无 npm publish、无人密钥扫描、覆盖率不验证等 |
| P1 - 高风险 | 18 | 无矩阵测试、无集成测试、eslint 范围过窄、发布无干运行等 |
| P2 - 中风险 | 15 | 无视觉测试、基准无断言、无 Docker 镜像、无 SBOM 等 |
| P3 - 低风险 | 8 | 无构建时间监控、无测试耗时基线、node 版本配置过时等 |

### 11.2 P0 严重阻断项清单

1. ci.yml:85 || true 静默吞噬 model catalog 测试失败
2. ci.yml:88 || true 静默吞噬 fallback chain 测试失败
3. ci.yml:134 continue-on-error: true 使 npm audit 不阻断
4. ci.yml:123 continue-on-error: true 使 cargo audit 不阻断
5. ci.yml:148 || echo "ESLint check skipped" 使 lint 不阻断
6. ci.yml:166 覆盖率步骤不做阈值比较（Write-Host 无实际验证）
7. 发布流水线缺失 npm publish（6 个 @crish/* 包无法发布）
8. 无密钥扫描（AI Agent 工作目录 API key 泄露不可感知）
9. 无 daemon 二进制构建发布（build:daemon-binary 从未在 CI 执行）
10. 无全量类型检查（6/7 个 TS 包零类型安全验证）
11. pre-push hook 执行 e2e 测试导致本地频繁跳过
12. release.yml:23 使用 Node 20（与项目 @types/node ^25.6.0 不匹配）

### 11.3 P1 高风险项清单

1. 测试碎片化：只执行 1/7 TS 包的 provider 子目录测试
2. 无 OS 矩阵（TS 部分仅 linux）
3. 无 Node 版本矩阵
4. 无集成测试执行
5. 无 E2E 测试覆盖跨包集成
6. lint 范围过窄：只 cover agent-runtime/provider
7. ci.yml:79 tsc --noEmit ֻ cover agent-runtime
8. 构建不使用 turbo 缓存
9. 增量构建能力完全未利用
10. 无 build:daemon-binary 的 CI 构建
11. 无 Vite build 的 CI 构建（apps/crish-desktop）
12. 无 qa:check 的 CI 执行（对话不变量、stress fuzzing、全场景流程）
13. 覆盖率阈值 70/60/65/70 完全未在 CI 验证
14. 版本管理完全手动（全部硬编码 0.1.0）
15. 无发布前干运行
16. 无 Changelog 生成
17. 依赖合规（depcruise）未使用
18. 并发控制缺失（ci.yml, perf-test.yml）

### 11.4 热力图（按文件）

集中了最多问题的文件：
- .github/workflows/ci.yml: 15 个独立问题（碎片化测试、静默模式、无缓存、无矩阵等）
- package.json: 8 个问题（脚本未在 CI 使用、构建链不完整等）
- .github/workflows/release.yml: 5 个问题（npm publish 缺失、daemon 缺失等）
- .husky/pre-push: 2 个问题（覆盖范围窄、e2e 超时）
- packages/agent-daemon/package.json: 3 个问题（build:types 不清 cache、依赖链未验证等）

## 12 附录：术语对照

| 术语 | 含义 |
|------|------|
| CI/CD | Continuous Integration / Continuous Delivery |
| turbo | npm workspace 构建编排工具，支持缓存和增量构建 |
| esbuild | JavaScript/TypeScript 打包工具（Go 编写） |
| tsc-alias | TypeScript 路径别名解析工具 |
| ESLint | 代码质量检查工具 |
| Vitest | 单元测试框架（Vite 生态） |
| Playwright | 浏览器端到端测试框架 |
| dependency-cruiser | 依赖关系验证工具 |
| Stylelint | CSS 代码质量检查工具 |
| Prettier | 代码格式化工具 |
| Husky | Git hooks 管理工具 |
| lint-staged | 只对 staged 文件运行 lint |
| Prettier | 代码格式化工具 |
| OIDC | OpenID Connect，GitHub Actions 用于无密钥发布 |
| SBOM | Software Bill of Materials，软件物料清单 |
| Rust Crate | Rust 包 |
| npm workspace | npm 多包管理模式 |
| Tauri | 跨平台桌面应用框架（Rust + Web 前端） |
| OIDC trusted publishing | GitHub Actions 无密钥 npm 发布 |
| Cargo.toml | Rust 包描述文件 |
| .github/workflows/ | GitHub Actions 工作流目录 |

## 13 典型失败场景分析

鏈妭鎻忚堪鍦ㄥ綋鍓?CI/CD 缂哄け鎯呭喌涓嬪彲鑳藉彂鐢熺殑鍏稿瀷澶辫触鍦烘櫙锛屼互璇存槑姣忎釜宸窛鐨勫疄闄呭奖鍝嶃€?
### 鍦烘櫙 1锛氬叡浜被鍨嬩慨鏀瑰鑷翠笅娓告柇瑁?
**瑙﹀彂鏉′欢**锛氬紑鍙戣€呬慨鏀?`packages/shared-types/src/index.ts`锛屾柊澧炰簡涓€涓繀濉瓧娈靛埌鏍稿績绫诲瀷瀹氫箟銆?
**浜嬩欢閾?*锛?1. 寮€鍙戣€呭湪鏈湴杩愯 `pre-push`锛宍npm run typecheck` 鍙鏌?`crish-desktop`锛屼笖 `crish-desktop` 鏈娇鐢ㄨ绫诲瀷锛岄€氳繃
2. `npm test` 杩愯鍏ㄩ儴 vitest 娴嬭瘯锛屼絾 `ci.yml` 涓殑 model catalog 娴嬭瘯浣跨敤 `|| true` 闈欓粯妯″紡锛屽嵆浣垮け璐ヤ篃涓嶆姤閿?3. PR 琚悎骞跺埌 main
4. `@crish/agent-runtime` 涓娇鐢ㄤ簡璇ョ被鍨嬬殑鍦版柟鍥犱负缂哄皯鏂板瓧娈佃€岀紪璇戝け璐ワ紝浣?`ci.yml` 鐨?ts-check 鍙繍琛?`tsc --noEmit` 妫€鏌?`agent-runtime`鈥斺€斿鏋?developer mode 鏉′欢鏈纭缃紝缂栬瘧鍙兘閫氳繃
5. 鐩村埌 CI 涓皾璇曡繍琛?`@crish/agent-daemon` 鏃讹紙涓嬫父鍖咃紝`packages/agent-daemon/package.json:33` 渚濊禆 orchestrator锛夛紝绫诲瀷涓嶅尮閰嶅鑷磋繍琛屾椂閿欒
6. 浣?CI 涓嶈繍琛?daemon 娴嬭瘯锛岄敊璇洿鍒扮敤鎴锋姤鍛婃墠琚彂鐜?
**瀹為檯鍚庢灉**锛氳繍琛屾椂 TypeError锛宎gent-daemon 宕╂簝锛岀敤鎴锋棤娉曚娇鐢ㄣ€備粠鍚堝苟鍒板彂鐜板彲鑳介棿闅旀暟灏忔椂鍒版暟澶┿€?
**娑夊強宸窛**锛?- `ci.yml:79` 鍙鏌?single package
- `ci.yml:85,88` 鐨?`|| true` 妯″紡
- `package.json:54` 鐨?typecheck 鍙?cover desktop
- `.husky/pre-push` 鍙?cover desktop
- 缺少 `turbo run typecheck --filter` 的依赖链传播

### 鍦烘櫙 2锛氬畨鍏ㄦ紡娲炶繘鍏?main

**瑙﹀彂鏉′欢**锛歯pm 鐢熸€佹姭闇蹭簡涓€涓?`ws` 鍖呯殑楂樺嵄 CVE锛坄package.json:93` 渚濊禆 `ws`锛夛紝绀惧尯宸蹭慨澶嶅苟鍙戝竷琛ヤ竵銆?
**浜嬩欢閾?*锛?1. Dependabot 鑷姩鍒涘缓浜嗗崌绾?`ws` 鐨?PR锛坄dependabot.yml:6-14` 閰嶇疆浜嗘瘡鍛ㄦ鏌ワ級
2. CI 杩愯浣嗕笉楠岃瘉 npm audit鈥斺€擿ci.yml:133-134` 鐨?`continue-on-error: true` 浣?audit 澶辫触涓嶉樆鏂?3. PR 琚悎骞跺埌 main
4. 鐢熶骇鐜杩愯鐨?daemon 浣跨敤鏈夋紡娲炵殑 `ws` 鐗堟湰
5. 鏀诲嚮鑰呭彲浠ュ埄鐢?WebSocket 婕忔礊

**瀹為檯鍚庢灉**锛氬畨鍏ㄦ€у彈鎹熴€傜敱浜?CVE 鎶湶鍒颁慨澶嶇殑鏃堕棿绐楀彛锛堥€氬父 7-14 澶╋級锛岄」鐩湪姝ゆ湡闂翠笉璁鹃槻銆?
**娑夊強宸窛**锛?- `ci.yml:133-134` 鐨?`continue-on-error: true`
- 缺少 `npm audit signatures` 验证
- 缂哄皯 `npm run check:all` 鐨勫畨鍏ㄥ璁?
### 鍦烘櫙 3锛氬彂甯冨け璐?
**瑙﹀彂鏉′欢**锛氬洟闃熷噯澶囧彂甯?v0.2.0锛屾墜鍔ㄦ洿鏂颁簡鎵€鏈?package.json 鐨?version 瀛楁銆?
**浜嬩欢閾?*锛?1. 閮ㄥ垎瀛愬寘鐨?version 瀛楁琚仐婕忥紙濡?`packages/decision-engine/package.json` 浠嶄负 0.1.0锛?2. 鎺ㄩ€?`v0.2.0` tag锛岃Е鍙?`release.yml`
3. Tauri 妗岄潰鏋勫缓鍦?Windows 涓婂け璐ワ紙CI 鏈湪 Windows 涓婇鍏堥獙璇佹闈㈡瀯寤猴級
4. GitHub Release 鍒涘缓浣嗙己灏戦儴鍒?artifact
5. 鍙戠幇 version 涓嶄竴鑷村悗闇€瑕佹墜鍔ㄤ慨澶嶅苟閲嶆柊鎺ㄩ€?tag

**瀹為檯鍚庢灉**锛氬彂甯冩祦绋嬮渶瑕?2-3 娆″皾璇曪紝姣忔 30 鍒嗛挓銆俙release.yml:61` 鐨?`generate_release_notes: true` 鐢熸垚鏃犲垎绫荤殑 release notes锛岀敤鎴风湅鍒扮殑鍙湁 commit 鏍囬鍒楄〃銆?
**娑夊強宸窛**锛?- 鏃犵粺涓€鐗堟湰绠＄悊锛圱5.2锛?- release.yml 鏃犲彂甯冨墠楠岃瘉锛圱4.3锛?- `release.yml:23` 浣跨敤 Node 20 涓庨」鐩?@types/node 涓嶅尮閰?- 鏃?npm publish锛圱5.1锛?- 鏃?daemon 浜岃繘鍒舵瀯寤猴紙T4.2锛?
### 鍦烘櫙 4锛氫唬鐮侀鏍奸€€鍖?
**瑙﹀彂鏉′欢**锛氭柊寮€鍙戣€呭姞鍏ュ洟闃燂紝鏈厤缃湰鍦?prettier/eslint hook锛坄pre-commit` hook 闇€瑕?`husky install` 鍚庣敓鏁堬級銆?
**浜嬩欢閾?*锛?1. 鏂板紑鍙戣€呯殑浠ｇ爜涓嶇鍚?prettier 鏍煎紡瑙勮寖
2. 浠ｇ爜閫氳繃 `git push --no-verify`锛堝洜 pre-push 鐨?e2e 娴嬭瘯瓒呮椂锛?3. CI 涓嶈繍琛?`prettier --check`锛坄package.json:66`锛?4. CI 鐨?eslint 鍙鏌?provider 瀛愮洰褰曚笖闈欓粯
5. 不符合规范的代码进入 main
6. 逐渐积累，最终需要大规模 reformat

**瀹為檯鍚庢灉**锛氫唬鐮侀鏍间竴鑷存€ц鐮村潖锛宑ode review 鏃跺櫔闊冲鍔狅紙鏍煎紡鍖栧彉鏇翠笌閫昏緫鍙樻洿娣峰湪涓€璧凤級銆傛牴鎹?.lintstagedrc.json 鐨勯厤缃紙eslint --fix + prettier --write锛夛紝lint-staged 鍙兘淇 staged 鏂囦欢锛屼絾杩滅 CI 涓嶉獙璇併€?
**娑夊強宸窛**锛?- `ci.yml:148` 鐨?eslint 鑼冨洿杩囩獎
- 缂哄皯 `npm run format`锛坧rettier --check锛?- 缂哄皯 `npm run lint:all` 鐨勪弗鏍兼ā寮?- `.husky/pre-push` 鎵ц e2e 瀵艰嚧寮€鍙戣€呰烦杩?
## 14 鏀硅繘浼樺厛绾х煩闃?
鍩轰簬褰卞搷鑼冨洿 脳 涓ラ噸搴︾殑浜岀淮璇勪及锛屽缓璁互涓嬩紭鍏堢骇锛?
```
涓ラ噸搴? 楂? | P0: npm publish, secret scan,     | P0: 鍏ㄩ噺 typecheck,
     | coverage threshold, 静默模式     | 增量测试, build cache
 涓? | P0: daemon binary, audit 纭€?  | P1: OS 鐭╅樀, 闆嗘垚娴嬭瘯
     |                                  |
 浣? | P2: Docker, Playwright, SBOM    | P3: metrics, 鑰楁椂鐩戞帶
     |__________________________________|_____________________
        绐勶紙single package锛?             瀹斤紙workspace-wide锛?                            褰卞搷鑼冨洿
```

鍙充笂璞￠檺锛堥珮涓ラ噸搴?+ 瀹藉奖鍝嶈寖鍥达級鐨勯棶棰樺簲浼樺厛澶勭悊锛氬叏閲?typecheck銆佸閲忔祴璇曘€佹瀯寤虹紦瀛樸€傝繖浜涙敼杩涜鐩栨渶澶氬寘锛岄槻姝?P0 闂璺ㄥ寘鎵╂暎銆?
## 15 结论

本分析系统识别了 conex 项目 CI/CD 流水线在 7 个维度上的系统性差距，涉及 12 个 P0 严重阻断项和 18 个 P1 高风险项。核心问题可以归纳为三句话：**构建未自动化**（turbo 在 CI 中完全未使用，7 个 TS 包零构建验证）、**测试碎片化**（95% 的测试代码在 CI 中不执行，2 个核心测试套件被静默吞噬）、**发布无流水线**（6 个 npm 包无法发布，daemon 二进制从不自动构建）。这些差距共同构成了项目从\"开发原型\"走向\"可交付产品\"的最大阻碍。ci_cd_improvement_plan.md 提供了覆盖 5 层架构（触发控制 - 增量验证 - 全量验证 - 发布前验证 - 交付）的系统性改进方案，总计涉及 12 个文件的修改扩增和约 1100 行代码变更。
改进方案与架构修复方案（docs/crish_desktop_architectural_remediation_plan/00_master_overview.md:3-50）遵循相同的设计哲学——逻辑依赖驱动、所有问题平等优先级、无时间与人员绑定。本分析中识别的 53 个具体差距点与架构修复方案的 215 个问题点互补：架构修复解决代码内部的腐化，CI/CD 改进防止腐化在合并后继续恶化。
当前 4 个 workflow 文件合计 496 行 YAML 配置，改进后预计扩展至约 1200 行。这个增长是必要的——每个新增的 job 代表一个被自动化的质量保障步骤。关键在于通过 composite action 和 workflow 复用机制控制复杂度膨胀，避免 CI 本身成为新的维护负担。
---
文档版本：1.0.0
对应改进方案：analysis/ci_cd_improvement_plan.md