# CI/CD 流水线系统性改进方案

## 1 设计原则

### P1 — 原生融入现有构建体系

所有 CI/CD 任务必须与现有构建工具链自洽：npm workspaces（`package.json:7-16`）用于依赖解析，turbo（`turbo.json:3-30`）用于构建编排和缓存，esbuild + tsc 用于编译，cargo 用于 Rust crate。不引入新的构建元框架或包管理器。每一层增量必须通过 turbo 的 `dependsOn` 语义表达，而非在 workflow 中手写 shell 命令序列。

### P2 — 等价验证

CI 中执行的命令必须是开发者本地可复现的相同命令。不得出现 CI 独享的"通过就绿色"但本地不可达的验证路径。`package.json` 中已定义的 `check:all`（`package.json:65`）、`test:core`（`package.json:57`）、`build:product`（`package.json:30`）应作为 CI 任务的主干，而非在 workflow 中另起一套步骤。

### P3 — 增量为主，全量为辅

PR 级别流水线应利用 turbo 的 `--filter` 和 `--since` 实现增量构建/测试，仅处理变更包及其依赖链上的上游/下游包。main 分支的合并提交执行全量验证。这需要 CI 正确设置 `turbo.json` 的 cache 配置并持久化缓存产物。

### P4 — 门禁硬性化

`eslint.config.js` 的 `--max-warnings 0`（`package.json:62`）、`apps/crish-desktop/vitest.config.ts` 的覆盖率阈值（`apps/crish-desktop/vitest.config.ts:13-18`）、`tsconfig.base.json` 的严格模式（`tsconfig.base.json:8-23`）、`cargo clippy -- -D warnings`（`ci.yml:36`）必须全部在 CI 中硬性阻断。`|| true` 和 `continue-on-error: true` 模式（`ci.yml:85,88,122,134`）必须消除。

### P5 — 单一事实来源

版本号、依赖版本、配置常量必须从 `package.json`、`Cargo.toml` 和 `turbo.json` 中读取，CI workflow 中不硬编码任何版本字符串。发布流水线的版本信息必须源自 git tag + package.json 的交叉验证（如 `release.yml` 中 `github.ref_name` 的模式），而非手动输入。

### P6 — 最小权限与安全默认

每个 workflow job 必须显式声明 `permissions`，遵循最小权限原则。所有 npm publish 操作必须使用 GitHub OIDC trusted publishing（`id-token: write`），不使用 `NPM_TOKEN` 密钥。依赖审计失败默认阻断（覆盖 `ci.yml:122,134` 的 `continue-on-error`）。密钥扫描、SBOM 生成纳入标准流水线。

### P7 — 可观测性优先

每次 CI 运行必须输出可消费的度量数据：构建各阶段耗时、测试结果（JUnit XML）、覆盖率报告（lcov + HTML）、基准测试对比、包体积增量。这些数据长期留存，用于趋势分析和回归检测。

## 2 整体架构

CI/CD 流水线分为 5 个层级（Layer），每层依赖下层基础设施：

```
Layer 1 — 基础触发与并发控制
  ├── PR opened/synchronized → cancel-in-progress
  ├── Push to main/develop
  └── Scheduled (nightly, weekly)

Layer 2 — 增量验证层（PR）
  ├── 变更检测 (dorny/paths-filter)
  ├── 影响域分析 (turbo --filter --since)
  ├── 构建：仅受影响包及其依赖的上游/下游
  ├── 类型检查：tsc --noEmit 按包增量
  ├── Lint：eslint + prettier --check 按变更文件
  ├── 单元测试：vitest 按变更包
  ├── 覆盖率：仅受影响包的增量阈值验证
  └── Rust：cargo check/clippy 按变更 crate

Layer 3 — 全量验证层（main merge + nightly）
  ├── 全量构建 (turbo run build)
  ├── 全量类型检查 (npm run typecheck 覆盖所有包)
  ├── 全量 lint (npm run lint:all)
  ├── 全量测试 (npm run test:coverage + npm run test:integration)
  ├── 全量 Rust 验证 (cargo test --workspace --all-features)
  ├── 安全审计 (npm audit + cargo audit + trivy)
  ├── 密钥扫描 (trufflehog/gitleaks)
  └── SBOM 生成 (syft/cyclonedx)

Layer 4 — 发布前验证层（tag push / workflow_dispatch）
  ├── 发布干运行 (npm pack --dry-run)
  ├── 跨平台构建矩阵 (linux/windows/macos)
  ├── daemon 二进制构建 (scripts/bundle-daemon.mjs)
  ├── Tauri 桌面构建
  ├── Docker 镜像构建与推送
  └── 发布检查清单验证

Layer 5 — 发布交付层
  ├── npm publish (trusted publishing, OIDC)
  ├── GitHub Release (CHANGELOG 驱动)
  ├── Docker Hub 发布 (multi-arch)
  ├── 二进制上传 (daemon, Tauri installer)
  └── 通知与度量报告
```

## 3 各层详细任务

### 3.1 Layer 1 — 基础触发与并发控制

#### T1.1 统一并发策略

- **目标文件**: `.github/workflows/ci.yml`, `.github/workflows/perf-test.yml`, `.github/workflows/release.yml`
- **问题描述**: `ci.yml` 和 `perf-test.yml` 缺少 `concurrency` 定义。同一 PR 的多次推送会导致多个 CI 运行并行执行，浪费 runner 资源。`release.yml` 已定义 `concurrency` 组（`release.yml:8-10`）但缺少 `cancel-in-progress: true`（当前为 `cancel-in-progress: true`，需要确认）。
- **修复策略**: 所有基于 `pull_request` 事件的 workflow 增加 `concurrency` 组，key 为 `${{ github.workflow }}-${{ github.ref }}`，`cancel-in-progress: true`。基于 `push` 到 main 的事件不做取消（避免打断关键合并）。

#### T1.2 workflow 权限最小化

- **目标文件**: `.github/workflows/ci.yml`, `.github/workflows/perf-test.yml`, `.github/workflows/provider-validation.yml`
- **问题描述**: 当前所有 workflow 未显式声明 `permissions`，使用默认 GITHUB_TOKEN 权限（对仓库内容的读写权限）。例如 `ci.yml` 的 `lint` job 只需要内容读取，但默认有写入权限。
- **修复策略**: 每个 workflow 顶层声明 `permissions: contents: read`（最小默认），需要写入的 job 单独覆盖（如 `coverage` job 的 `checks: write`、`e2e` job 的 `pull-requests: write`）。

#### T1.3 路径过滤优化

- **目标文件**: `.github/workflows/ci.yml`, `.github/workflows/perf-test.yml`
- **问题描述**: `ci.yml` 的 `push` 触发分支包含 `[main, develop]`，但未定义 `paths-ignore`。对文档、配置文件、markdown 的修改也会触发全量 CI。
- **修复策略**: 增加 `paths-ignore` 排除不触发构建的路径：`docs/**`, `*.md`, `.github/**`（非 workflow 文件自身）。`perf-test.yml` 同理，增加 `paths` 过滤只对影响性能的代码变更触发。

### 3.2 Layer 2 — 增量验证层

#### T2.1 变更检测（影响域分析）

- **目标文件**: `.github/workflows/ci.yml`（新增 `detect-changes` job）
- **问题描述**: 当前 CI 对所有 PR 执行相同的测试集（只 cover agent-runtime provider），既不按变更范围缩减，也不按依赖拓扑扩展。修改 `@crish/shared-types` 不会触发 `@crish/agent-runtime` 的测试。
- **修复策略**: 引入 `dorny/paths-filter@v3` 检测变更路径，结合 turbo 的依赖图计算影响域。定义 filter 映射：

```yaml
filters:
  shared-types:
    - 'packages/shared-types/**'
  shared-utils:
    - 'packages/shared-utils/**'
  decision-engine:
    - 'packages/decision-engine/**'
  agent-runtime:
    - 'packages/agent-runtime/**'
  agent-orchestrator:
    - 'packages/agent-orchestrator/**'
  agent-daemon:
    - 'packages/agent-daemon/**'
  crish-desktop:
    - 'apps/crish-desktop/**'
  agent-workbench:
    - 'apps/agent-workbench/**'
  rust-crates:
    - 'crates/**'
    - 'Cargo.toml'
    - 'Cargo.lock'
  workflows:
    - '.github/workflows/**'
```

每个包的影响域向上游和下游各扩展一层（基于 `packages/agent-orchestrator/package.json:31` 的 `@crish/agent-runtime` 依赖和 `packages/agent-daemon/package.json:33` 的 `@crish/agent-orchestrator` 依赖）。下游包（如 crish-desktop 依赖 agent-runtime）也必须纳入。

#### T2.2 CI 中启用 turbo 构建缓存

- **目标文件**: `.github/workflows/ci.yml`, `turbo.json`
- **问题描述**: `turbo.json:3-30` 定义了完整的 pipeline（build, build:types, build:js, test, lint, typecheck），但 CI 完全不使用 turbo。`ci.yml:79` 直接调用 `npx tsc --noEmit` 而非 `npx turbo run typecheck`。@crish/* 包构建顺序和缓存完全由 CI 步骤的手写顺序决定。
- **修复策略**: CI 中安装 turbo 作为 devDependency（`package.json` 的 devDependencies 列表当前不包含 turbo，需确认是否从 npm workspaces 继承）。使用 `npx turbo run build --filter=[target]` 替代手写构建链。设置 `turbo.json` 的 `remoteCache` 配置（使用 `actions/cache` 或 Turbo Server）。在 CI 步骤中前置恢复 turbo cache：

```yaml
- name: Restore turbo cache
  uses: actions/cache@v4
  with:
    path: |
      .turbo
      **/.tsbuildinfo
    key: turbo-${{ runner.os }}-${{ github.sha }}
    restore-keys: |
      turbo-${{ runner.os }}-
```

#### T2.3 增量 TypeScript 类型检查

- **目标文件**: `.github/workflows/ci.yml`, `package.json`
- **问题描述**: `package.json:54` 的 `typecheck` 只 cover `apps/crish-desktop/tsconfig.json`，`package.json:50-53` 的 `check:core` 逐个运行各包的 `tsc --noEmit`。CI 中 `ci.yml:79` 只执行 `packages/agent-runtime` 的 tsc。其他 6 个 TS 包和 Rust→TS 边界的类型安全完全不验证。
- **修复策略**: 在 `package.json` 中新增 `typecheck:ci` 脚本：`"typecheck:ci": "turbo run typecheck --filter=[changed packages] --continue"`。`turbo.json` 的 `typecheck` 任务定义为 `dependsOn: ["build:types"]`（`turbo.json:24`），确保类型检查前类型声明已构建。增加对 `packages/agent-daemon/tsconfig.json`、`packages/shared-types/tsconfig.json`、`packages/shared-utils/tsconfig.json`、`packages/decision-engine/tsconfig.json`、`packages/agent-orchestrator/tsconfig.json`、`packages/agent-runtime/tsconfig.json`、`apps/agent-workbench/tsconfig.json` 的全覆盖。

#### T2.4 增量 lint

- **目标文件**: `.github/workflows/ci.yml`
- **问题描述**: `ci.yml:148` 的 ESLint 只对 `packages/agent-runtime/src/provider/` 执行，且使用 `2>/dev/null || echo "ESLint check skipped"`。`package.json:62` 的 `lint:all`（`eslint . --ext .ts,.tsx --max-warnings 0 && stylelint`）和 `package.json:64` 的 `lint` 宽松模式不一致。`eslint.config.js` 定义的 `react-refresh` 规则仅对前端包生效，但 CI 从未验证。
- **修复策略**: CI lint job 使用 `npm run lint:all`（`package.json:62`）替代宽松的 `npm run lint`。新增 `npm run lint:ci` 脚本：基于 turbo 的 `lint` 任务（`turbo.json:20-22`）分包执行，通过 `--max-warnings 0` 确保零警告硬性阻断。新增 `npm run format:ci`：`prettier --check .`（`package.json:66`）在 CI 中执行。`eslint.config.js` 的 `ignores` 列表保持对 AI Agent 工作目录的豁免。

#### T2.5 增量单元测试

- **目标文件**: `.github/workflows/ci.yml`, `vitest.config.ts`
- **问题描述**: 当前 CI 测试覆盖率碎片化——只执行 `packages/agent-runtime/src/provider/__tests__/` 下的一部分测试。`ci.yml:85,88` 的两个 test suite 使用 `|| true` 静默吞噬失败。`vitest.config.ts:8-11` 定义的 include 模式覆盖了全部包，但 CI 传入的子路径限制了测试范围。
- **修复策略**: 在 `package.json` 新增 `test:ci` 脚本：`"test:ci": "turbo run test --filter=[changed packages] --continue"`。`turbo.json:16-19` 已定义 `test` 任务依赖 `build`。为每个包在 `turbo.json` 中保持独立的 test pipeline 定义。CI 中 vitest 调用改为：`npx vitest run --reporter=verbose --reporter=junit --outputFile.junit=test-results.xml`，生成 JUnit 报告供 GitHub Actions 解析。消除所有 `|| true` 静默模式。

#### T2.6 增量覆盖率验证

- **目标文件**: `.github/workflows/ci.yml`, `apps/crish-desktop/vitest.config.ts`
- **问题描述**: `apps/crish-desktop/vitest.config.ts:13-18` 定义了覆盖率阈值（statements 70%, branches 60%, functions 65%, lines 70%），但 `ci.yml:163-167` 的 coverage job 不做任何阈值验证，只有一句 `Write-Host "Coverage check completed"`。
- **修复策略**: CI 中执行 `npm run test:coverage` 并传递 `--coverage.thresholds` 参数。对于 crish-desktop，vitest 配置已内嵌阈值，直接运行 `vitest run --coverage apps/crish-desktop/src/`。对于其他包，在各自的 vitest 配置中定义 thresholds，或者在根 `package.json` 中定义统一的最小覆盖率基线。新增 coverage 报告上传步骤，使用 `actions/upload-artifact@v4` 保存 HTML 覆盖率报告和 lcov 文件。

### 3.3 Layer 3 — 全量验证层

#### T3.1 全量构建与类型检查

- **目标文件**: `.github/workflows/ci.yml`, `package.json`
- **问题描述**: main 分支的合并提交触发与 PR 相同的增量验证，但增量验证不保证全量构建的正确性。`turbo.json` 的缓存可能掩盖构建脚本中的非确定性错误。
- **修复策略**: 在 `ci.yml` 中区分 PR 触发和 main push 触发。main push 触发时运行全量命令：
  - `turbo run build`（全量构建 10 个 npm workspaces 包）
  - `cargo build --workspace`（全量 Rust 构建）
  - `npm run typecheck`（所有包的 tsc --noEmit）
  - 使用 GitHub `push` 事件的分支过滤区分

#### T3.2 全量测试套件

- **目标文件**: `.github/workflows/ci.yml`, `package.json`
- **问题描述**: 当前 CI 不执行 `test:integration`（`package.json:61`）、`test:core`（`package.json:57`）、`test:desktop-helpers`（`package.json:58`）。`apps/crish-desktop/package.json:13` 的 `qa:check`（含 hook safety、chat invariants、stress fuzzing、full scenario flow）在 CI 中完全未触发。
- **修复策略**: main push 事件增加全量测试流水线：
  - `npm run test:core` — runtime/orchestrator/daemon 核心测试
  - `npm run test:desktop-helpers` — 桌面应用 API/Store 测试
  - `npm run test:integration` — 跨包集成测试（使用 `vitest.integration.config.ts`）
  - `npm run test:coverage` — 全量覆盖率测试
  - 对 `apps/crish-desktop` 执行 `npm --workspace @crish/crish-desktop run qa:check`

#### T3.3 全量 Rust 验证

- **目标文件**: `.github/workflows/ci.yml`
- **问题描述**: `ci.yml:13-42` 的 `rust-check` 和 `ci.yml:44-65` 的 `rust-stream-test` 分离执行，`rust-check` 运行 `cargo test --workspace` 但不包含 `--all-features`，`rust-stream-test` 运行 `cargo test --all-features` 但仅限 conex-stream crate。
- **修复策略**: 合并为统一 job：
  - `cargo check --workspace`
  - `cargo clippy --workspace -- -D warnings`
  - `cargo test --workspace --all-features`
  - `cargo fmt --check`
  - 保持三平台矩阵（rust-check 当前已有），但测试阶段只在 linux 运行（避免 windows/macos 上的 Rust test 环境差异增加调试成本）

#### T3.4 安全审计硬性化

- **目标文件**: `.github/workflows/ci.yml`
- **问题描述**: `ci.yml:122-123` 的 cargo audit 和 `ci.yml:132-133` 的 npm audit 均使用 `continue-on-error: true`，安全漏洞不会阻断流水线。没有 npm audit signatures 验证。
- **修复策略**:
  - npm audit: 移除 `continue-on-error: true`，对 `--audit-level=high`（当前 `ci.yml:133`）的失败阻断流水线
  - cargo audit: 升级 `actions-rust-lang/audit@v1` 到最新版本，设置 `deny-warnings: true`
  - 新增 `- run: npm audit signatures` 验证注册表签名完整性
  - 新增定时任务（cron: `0 6 * * *`）的安全审计专用 workflow，独立于 CI 流水线运行

#### T3.5 密钥扫描集成

- **目标文件**: `.github/workflows/ci.yml`（新增 job）
- **问题描述**: 项目完全不检查密钥泄露。AI Agent 工作目录（`eslint.config.js:14-20` 列出的 `.agent-runtime/`, `.agents/`, `.claude/`, `.codex/` 等）可能包含 API key 和用户数据。
- **修复策略**: 在 `ci.yml` 新增 `secret-scan` job：
  - 使用 `trufflehog/github-action@v3` 或 `gitleaks/gitleaks-action@v2`
  - 设置 `scan-push: true`（扫描整个提交历史中的密钥）
  - 在 `eslint.config.js` 的 ignores 列表基础上增加排除路径（`**/.agent-runtime/**`, `**/.agents/**` 等），避免误报
  - 此 job 仅在 main push 和定时任务中全量运行，PR 级别只扫描新增的 diff

#### T3.6 依赖合规与架构约束

- **目标文件**: `.github/workflows/ci.yml`（新增 job）, `package.json`
- **问题描述**: `package.json:73` 将 `dependency-cruiser` 列为 devDependency，但 CI 中从未使用。当前架构存在 105 个架构耦合问题（D1 维度），depcruise 可以帮助阻断新的违规引入。
- **修复策略**: 新增 `.dependency-cruiser.js` 配置文件，定义：
  - 禁止的跨层依赖（如 UI 包直接引用 runtime 内部模块）
  - 循环依赖检测
  - 包边界违反检测
  CI 中执行 `npx depcruise packages apps --ts-config tsconfig.base.json`，失败阻断流水线。

#### T3.7 操作系统矩阵扩展

- **目标文件**: `.github/workflows/ci.yml`
- **问题描述**: `ci.yml` 的 `ts-check`、`lint`、`coverage`、`e2e` 等 TS job 全部运行在 `ubuntu-latest`，不检测 Windows 和 macOS 上的行为差异。`vitest.setup.ts` 为 Node 环境补齐了 browser 全局变量（localStorage, dispatchEvent, CustomEvent），这些 polyfill 的行为在不同 OS/Node 版本上可能不同。
- **修复策略**: 对关键验证 job（ts-check, test:core）扩展到 windows-latest 和 macos-latest。建议策略矩阵：
  ```yaml
  ts-check-core:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [20, 22]
      fail-fast: false
  ```
  避免过度矩阵化——lint 和 coverage 只需 linux 运行。

#### T3.8 Playwright 视觉测试集成

- **目标文件**: `.github/workflows/ci.yml`（新增 job）
- **问题描述**: `apps/crish-desktop/package.json:16-17` 定义了 Playwright 测试（`test:visual` 和 `test:visual:update`），但 CI 中完全未触发。
- **修复策略**: 新增 `visual-test` job：
  - 安装 Playwright 浏览器：`npx playwright install --with-deps chromium`
  - 启动 Vite 开发服务器：`npm --workspace @crish/crish-desktop run dev &`
  - 运行 `npm --workspace @crish/crish-desktop run test:visual`
  - 上传视觉测试差异报告：`actions/upload-artifact@v4`
  - 此 job 只在变更前端代码（`apps/crish-desktop/**`, `apps/agent-workbench/**`）时触发

#### T3.9 基准测试持久化

- **目标文件**: `.github/workflows/perf-test.yml`, `package.json`
- **问题描述**: `perf-test.yml` 运行基准测试并生成报告，但报告只在 PR comment 中展示，不持久化。`ci.yml:192-197` 的 Rust bench 上传到 artifact 但未关联到历史基线。`package.json` 定义的 `bench:ci`（`package.json:37`）和 `perf:all`（`package.json:48`）在 CI 中未完整执行。
- **修复策略**:
  - 持久化基准测试结果到 GitHub Pages 或 S3：每次 main 分支的 perf 测试结果追加到历史数据集
  - 在 `perf-test.yml` 中增加 `benchmark` job 上传 JSON 结果到可查询存储
  - 在 `package.json` 中新增 `perf:ci` 脚本聚合 `bench:ci`、`bench:native-sla`、`bench:acceptance`、`bench:report`
  - 使用 `benchmark-action/github-action-benchmark@v1` 自动追踪性能趋势
  - PR 级别的 perf 测试关联历史基线，标记统计学显著的性能退化

### 3.4 Layer 4 — 发布前验证层

#### T4.1 发布干运行 pipeline

- **目标文件**: `.github/workflows/release.yml`, `package.json`
- **问题描述**: 当前 `release.yml` 在 tag 推送时直接构建和发布，没有预发布验证阶段。`npm run build:product`（`package.json:30`）是发布前的完整构建命令，但 release.yml 只执行了 `build:packages` + Tauri build（`release.yml:37,39`），未执行 `build:daemon-binary`（`package.json:29`）。
- **修复策略**: 新增 `workflow_dispatch` 触发模式的发布干运行：
  - 执行 `npm run build:product`（完整构建链）
  - 执行 `npm run check:all`（`package.json:65`：typecheck + lint:all + test:coverage）
  - 执行 `npm pack --dry-run` 验证所有需要发布的包可打包
  - 执行 `node -e "check package.json versions match tag"`
  - 构建产物作为 artifact 上传，不下发到任何发布渠道

#### T4.2 多架构 daemon 二进制构建

- **目标文件**: `.github/workflows/release.yml`, `scripts/bundle-daemon.mjs`
- **问题描述**: `package.json:29` 的 `build:daemon-binary` 使用 `node scripts/bundle-daemon.mjs` 构建 daemon 二进制，但 `release.yml` 未将其纳入发布流程。daemon 是独立于 Tauri 桌面的可分发制品。
- **修复策略**: 在 `release.yml` 的 `build` job 中增加 daemon 二进制构建步骤：
  - 跨平台：`ubuntu-latest`（linux x86_64）、`windows-latest`（win32 x64）、`macos-latest`（darwin arm64 + x64）
  - 使用 `pkg`、`esbuild` 或 `nexe` 打包 Node.js daemon 为单文件二进制
  - 产物重命名：`crish-daemon-linux-x64`, `crish-daemon-win32-x64.exe`, `crish-daemon-darwin-arm64`
  - 产物完整性：生成 SHA256SUMS 文件
  - 上传到 GitHub Release 的 assets 列表

#### T4.3 发布清单检查

- **目标文件**: `.github/workflows/release.yml`（新增 `verify-release` job）
- **问题描述**: release.yml 没有任何发布前检查清单。例如：未验证 `package.json` 版本号与 git tag 一致、未验证 CHANGELOG 条目是否存在、未验证所有子包版本号是否统一。
- **修复策略**: 新增 `verify-release` job，在 `build` 之前运行：
  - 验证 git tag 格式 `v*` 符合 semver
  - 验证 tag 指向的 commit 包含所有子包的统一版本号
  - 验证每个工作空间包的 `version` 字段与 tag 一致
  - 验证至少 `packages/agent-daemon/CHANGELOG.md` 和 `apps/crish-desktop/CHANGELOG.md` 包含当前版本的条目
  - 验证 `Cargo.toml:60` 的 `workspace.package.version` 与 tag 一致
  - 使用 `actions/github-script@v7` 在发布前在 issue 或 PR 上创建发布检查清单

### 3.5 Layer 5 — 发布交付层

#### T5.1 npm 包发布流水线

- **目标文件**: `.github/workflows/release.yml`（新增 `publish-npm` job）
- **问题描述**: 项目完全缺失 npm 发布能力。6 个私有包（`@crish/shared-types`, `@crish/shared-utils`, `@crish/agent-runtime`, `@crish/agent-orchestrator`, `@crish/agent-daemon`, `@crish/decision-engine`）无法被外部使用。`package.json:2-4` 的 `"private": true` 阻止了根包发布，但工作空间包各自有 `"private": true`（如 `packages/agent-daemon/package.json:4`），需改为 `"private": false` 再选择性发布。
- **修复策略**:
  1. 在各子包的 `package.json` 中移除 `"private": true`（或保留部分包的私有属性，仅发布需要公开的包）
  2. 确保每个包的 `files` 字段（如 `packages/agent-daemon/package.json:21-23`）只包含 `dist/`
  3. 在 release.yml 中新增 `publish-npm` job，使用 GitHub OIDC trusted publishing（`id-token: write`）
  4. 发布顺序必须遵循依赖拓扑：shared-types → shared-utils → decision-engine → agent-runtime → agent-orchestrator → agent-daemon
  5. 每个包发布前执行 `npm pack` 验证 tarball 内容
  6. 设置 dist-tag：`latest`（稳定发布）和 `next`（预发布）

#### T5.2 版本管理与发布编排

- **目标文件**: `package.json`, `scripts/`（新增 `scripts/version-bump.mjs`）
- **问题描述**: 所有包硬编码 `"version": "0.1.0"`（各 `package.json` 的 version 字段），手动更新容易遗漏或导致版本不一致。`Cargo.toml:60` 的 workspace version 也是 `0.1.0`，但 crate 各自独立版本。
- **修复策略**:
  - 引入 `@changesets/cli` 或 `multi-semver-release` 做统一版本管理
  - 或在 `package.json` 中新增 `version:bump` 脚本：读取根 `package.json` 的 version，写入所有工作空间包的 `package.json`
  - 新增 `scripts/version-bump.mjs`：解析所有工作空间包的 package.json，统一设置 version 字段，并更新 `packages/agent-workbench/src-tauri/Cargo.toml` 的 tauri version
  - 版本 bump 作为发布流水线的一部分自动执行

#### T5.3 CHANGELOG 自动化

- **目标文件**: `scripts/`（新增 `scripts/generate-changelog.mjs`）
- **问题描述**: 项目完全没有 CHANGELOG.md 文件。`release.yml:61` 使用 `generate_release_notes: true`（自动生成），生成的 release notes 信息量不足（只有 commit 标题列表）。
- **修复策略**:
  - 为每个工作空间包创建初始 CHANGELOG.md
  - 新增 `scripts/generate-changelog.mjs`：基于 Conventional Commits 的 git log 生成 changelog 条目
  - 在 release pipeline 中，此脚本对比当前 tag 和前一个 tag 的 commit 范围，分类为 Features/Fixes/Breaking Changes
  - 每个包独立的 CHANGELOG.md 放在各自目录下（如 `packages/agent-daemon/CHANGELOG.md`）
  - GitHub Release 的 body 使用 CHANGELOG 的内容而非自动生成

#### T5.4 Docker 镜像构建与发布

- **目标文件**: `Dockerfile`（新增）, `.github/workflows/release.yml`（新增 job）
- **问题描述**: 项目无 Dockerfile，daemon 和桌面应用无法以容器方式部署。`Cargo.toml:3-15` 的 Rust workspace 包含 `conex-db`（sqlite）、`conex-net`（网络）、`conex-sandbox`（沙箱）等 crate，适合在服务器环境以容器运行。
- **修复策略**:
  - 新增 `Dockerfile`（根据实际部署需求决定形态：daemon 容器 vs 全量应用容器）
  - 多阶段构建：第一阶段 `node:22` 构建 JS 产物 → 第二阶段最小 Node 运行时
  - 在 release workflow 中新增 `docker-build-push` job
  - 使用 `docker/setup-buildx-action@v3` 启用 BuildKit
  - 同步构建 `linux/amd64` 和 `linux/arm64` 多架构镜像
  - 推送到 GitHub Container Registry（ghcr.io）

#### T5.5 GitHub Release 结构化发布

- **目标文件**: `.github/workflows/release.yml`
- **问题描述**: 当前 release 创建为 `draft: true`（`release.yml:62`），要求人工审核后发布。但 draft release 缺少结构化信息（文件列表、安装说明、升级指引）。
- **修复策略**:
  - 保持 draft 模式（人工审核是安全实践），但增加 draft 的内容丰富度
  - Release body 包含：CHANGELOG 摘要、安装命令（`npm install -g @crish/agent-daemon`）、二进制下载链接、Docker pull 命令、升级注意事项
  - 对每个上传的 artifact 在 release body 中生成描述（如 `crish-daemon-linux-x64`、`Crish Desktop Setup 0.1.0.msi`）
  - 使用 `actions/github-script@v7` 替代 `softprops/action-gh-release` 以获得对 release body 的完全控制

#### T5.6 NPM 发布前包验证

- **目标文件**: `scripts/`（新增 `scripts/verify-publish.mjs`）
- **问题描述**: 缺少发布前包内容验证机制。`packages/agent-daemon/package.json:21-23` 的 `files` 字段只包含 `dist/`，但无脚本验证 dist/ 内容完整性。
- **修复策略**: 新增 `scripts/verify-publish.mjs`，在每个包发布前执行：
  - 验证 `dist/index.js` 和 `dist/index.d.ts` 存在（`types` 字段引用）
  - 验证 `dist/index.js` 的 exports 符号与 `src/index.ts` 一致
  - 验证 `package.json` 的 `exports` 字段（如 `packages/agent-daemon/package.json:9-20`）的所有目标路径都存在
  - 验证 development exports 的 `.ts` 源文件存在
  - 验证 tarball 大小不超过阈值（例如 5MB）
  - 将 `verify-publish.mjs` 在 release pipeline 的干运行阶段执行

### 3.6 跨层支撑任务

#### T6.1 `.husky/` 优化

- **目标文件**: `.husky/pre-commit`, `.husky/pre-push`, `.lintstagedrc.json`
- **问题描述**: `.husky/pre-push` 执行 `npm run typecheck && npm test`。`npm run typecheck`（`package.json:54`）只 cover crish-desktop 的 tsconfig，不是全量。`npm test`（`package.json:59`）运行全部 vitest 测试（含 e2e），本地环境因缺少 provider API key 会超时或失败。
- **修复策略**:
  - `pre-commit`: 保持 `npx lint-staged` 不变（当前正确且高效）
  - `pre-push`: 改为执行增量验证——`npm run typecheck` 保持对 crish-desktop 的验证，增加 `npx turbo run typecheck --filter=[$(git diff --name-only origin/main...HEAD | xargs dirname | sort -u)]` 的增量类型检查
  - 将 `npm test` 替换为 `npm run test:core`（只运行纯单元测试，不触发 e2e）
  - 在 `.lintstagedrc.json` 中增加对 `*.json` 的 eslint（当前只有 prettier，`lintstagedrc.json:4`）

#### T6.2 依赖更新自动化增强

- **目标文件**: `.github/dependabot.yml`, `.github/workflows/ci.yml`
- **问题描述**: `.github/dependabot.yml:25` 忽略 `conex-stream` 但不说明原因。npm 更新限制 10 个并发 PR（`dependabot.yml:13`），cargo 限制 5 个（`dependabot.yml:23`）。无自动合并机制（即使已配置 `automerge` 标签）。
- **修复策略**:
  - 为 `dependabot.yml:25` 的 ignore 规则添加注释说明原因
  - 增加 `typescript` 和 `eslint` 到 npm 的 ignore 列表（这些应手动升级以避免 breaking changes）
  - 新增 `.github/workflows/auto-merge-deps.yml`：当 CI 通过时自动合并带有 `automerge` 标签的 dependabot PR（补丁版本自动合并，次要版本需要人工审核）
  - 对 npm updates 设置 `open-pull-requests-limit: 15`（当前 10，适当放宽）

#### T6.3 度量与仪表盘

- **目标文件**: `.github/workflows/ci.yml`（新增 metrics job）
- **问题描述**: 当前无任何 CI 运行度量。构建时间、测试失败率、覆盖率趋势、包体积变化完全不可见。
- **修复策略**: 在 `ci.yml` 中新增 `metrics` job（作为最终聚合 job）：
  - 收集各 job 的完成时间、状态、输出日志中的测试计数
  - 汇总为 JSON 报告
  - 上传到固定的 artifact 名称（如 `ci-metrics-$(date +%Y-%m-%d).json`）
  - 使用 GitHub Actions 的 `summary` 特性在 workflow run 页面展示仪表盘
  - 长期方案：将度量数据写入 GitHub Pages 的静态站点，使用 Chart.js 渲染趋势图

#### T6.4 缓存策略统一

- **目标文件**: `.github/workflows/ci.yml`, `turbo.json`
- **问题描述**: Rust 部分使用 `Swatinem/rust-cache@v2`（`ci.yml:30,58`），TS 部分无缓存（`ci.yml:74` 的 `actions/setup-node` 只缓存了 npm 依赖）。turbo 的 cache 完全未被使用。
- **修复策略**: 引入分层缓存策略：
  1. **npm 依赖缓存**: `actions/setup-node` 的 `cache: npm`（已存在）
  2. **turbo 本地缓存**: `actions/cache@v4` 缓存 `.turbo/` 和 `.tsbuildinfo`（key：`turbo-${{ runner.os }}-${{ hashFiles('turbo.json', 'package-lock.json') }}`）
  3. **Rust 缓存**: `Swatinem/rust-cache@v2`（已存在，保持）
  4. **cargo 注册表缓存**: 独立缓存 `~/.cargo/registry/`（对于 rust-check matrix，缓存跨 OS 共享）
  5. **node_modules 缓存**: 独立缓存 `node_modules/`（key：`node-modules-${{ hashFiles('package-lock.json') }}`），减少 `npm ci` 时间

#### T6.5 错误报告与失败分类

- **目标文件**: `.github/workflows/ci.yml`（新增 failure analysis step）
- **问题描述**: CI 失败只显示红色标记，无结构化失败分类。开发人员需要阅读完整日志才能理解失败原因。
- **修复策略**: 在每个验证 job 后增加 post-step：
  - 使用 `actions/github-script@v7` 解析 vitest 输出，提取失败测试的名称和错误类型
  - 将失败分类为：编译错误 / 测试断言失败 / 类型错误 / 超时
  - 在 PR 的 check run 中写结构化的 annotation
  - 失败时自动创建 GitHub Issue（仅对 main 分支的失败，避免 PR 噪音）

## 4 与现有系统的集成点

### 4.1 与 `.husky/` hooks 的配合

改进后的 CI 流水线与本地 hooks 的关系是互补而非替代：

| 门禁层级 | 触发时机 | 范围 | 命令 |
|----------|----------|------|------|
| L0 — pre-commit | 提交前 | 变更文件 | `lint-staged`（eslint --fix + prettier --write） |
| L1 — pre-push | 推送前 | 变更包 | `typecheck:ci` + `test:core` |
| L2 — PR CI | PR 推送 | 增量依赖链包 | `turbo run build test typecheck lint --filter=...` |
| L3 — Merge CI | main 合并 | 全量 | `turbo run build test typecheck lint:all` |
| L4 — Release CI | tag 推送 | 全量 + 发布 | `build:product` + `check:all` + publish |

所有层级共享相同的 `package.json` 脚本定义，避免命令重复。`.husky/pre-push` 中的 `npm run typecheck && npm test` 将改为 `npm run typecheck:ci && npm run test:core` 以解决当前 hook 执行 e2e 和只 check crish-desktop 的问题。

### 4.2 与 `turbo.json` 缓存的配合

`turbo.json:3-30` 定义了缓存策略，CI 需要：
1. **缓存 key 设计**: `turbo-${{ runner.os }}-${{ hashFiles('turbo.json') }}-${{ hashFiles('package-lock.json') }}` + restore-keys 回退到上次成功的缓存
2. **缓存内容**: turbo 在 `.turbo/` 目录存储每个任务的 hash 与 output。`turbo.json:6` 的 `outputs: ["dist/**", ".tsbuildinfo"]` 是 turbo cache 的包含模式
3. **remote cache**: 对于跨 runner 的缓存共享（同一 PR 的多次推送），启用 `turbo` 的 remote caching（通过 `turpo run --team=... --token=...` 或自建 Turbo Server）
4. **增量 filter**: PR 级 CI 使用 `turbo run build --filter=[origin/main...HEAD]`，仅在 turbo 检测到有变更时重建

### 4.3 与 npm workspaces + turbo 的配合

当前 `package.json:7-16` 定义了 10 个工作空间包，构建依赖链为：

```
@crish/shared-types
    → @crish/shared-utils
    → @crish/decision-engine
    → @crish/agent-runtime
        → @crish/agent-orchestrator
            → @crish/agent-daemon
        → @crish/crish-desktop
    → @crish/agent-workbench
```

CI 流水线利用 turbo 的依赖图自动解析此链：
- `turbo.json:5` 的 `"dependsOn": ["^build"]` 表示每个包的 build 等待其依赖包的 build 完成
- 当 `@crish/agent-runtime` 变更时，turbo 自动重建 `@crish/agent-orchestrator` 和 `@crish/agent-daemon`（下游）
- 这种机制消除了 CI 中手动定义构建顺序的需要

### 4.4 与 Rust 工作空间的配合

`Cargo.toml:2-15` 定义了 12 个 crate members。当前 `ci.yml` 的 `rust-check` job 已有较好的覆盖，改进主要在于：
- 合并 `rust-check` 和 `rust-stream-test` 为统一的全 features 测试
- 在 TS CI 的 `detect-changes` 阶段检测 `crates/**` 和 `Cargo.toml` 变更
- 对涉及 Rust→TS 边界的 crate（如 `conex-ipc` 用于 Tauri IPC）增加跨语言集成测试

## 5 验证标准

### 5.1 Layer 1 验证标准

| 验收项 | 标准 |
|--------|------|
| 并发控制 | 同一 PR 的第二次推送自动取消前一个进行中的 CI 运行 |
| 权限最小化 | 每个 workflow 声明了 `permissions`，且不是 `write-all` |
| 路径过滤 | 修改 markdown 文档不触发构建 |

### 5.2 Layer 2 验证标准

| 验收项 | 标准 |
|--------|------|
| 增量构建 | 修改 `shared-types` 只触发 shared-types + 其下游包的构建 |
| 类型安全 | 所有工作空间包通过 `tsc --noEmit` |
| Lint 零警告 | `npm run lint:all` 返回退出码 0（`--max-warnings 0`） |
| 格式化 check | `prettier --check .` 返回退出码 0 |
| 覆盖率门禁 | `apps/crish-desktop/vitest.config.ts` 的阈值（70/60/65/70）硬性阻断 |
| 测试失败阻断 | vitest 套件全部通过，无 `|| true` 静默模式 |
| Rust 验证 | `cargo clippy -- -D warnings` 无任何警告 |

### 5.3 Layer 3 验证标准

| 验收项 | 标准 |
|--------|------|
| 全量构建 | `turbo run build` 对所有 10 个 npm workspaces 包成功 |
| 全量 Rust | `cargo test --workspace --all-features` 全部通过 |
| 集成测试 | `npm run test:integration` 全部通过 |
| 安全审计 | `npm audit --audit-level=high` 无高严重度漏洞；`cargo audit` 无任何 deny |
| 密钥扫描 | 无密钥泄露检测结果 |
| 依赖合规 | `dependency-cruiser` 无违规 |
| Playwright | 视觉测试通过（或基线更新后通过） |

### 5.4 Layer 4 验证标准

| 验收项 | 标准 |
|--------|------|
| 构建产物完整 | `npm pack --dry-run` 列表包含所有期望文件 |
| 版本一致性 | 所有工作空间包的 `version` 字段与 git tag 一致 |
| daemon 二进制 | `scripts/bundle-daemon.mjs` 在 3 平台生成可执行文件 |
| Tauri 构建 | `npm --workspace @crish/agent-workbench run tauri build` 在 3 平台成功 |
| Docker 构建 | `docker build` 成功，产物层数 ≤ 10 |

### 5.5 Layer 5 验证标准

| 验收项 | 标准 |
|--------|------|
| npm publish | 使用 OIDC trusted publishing 发布 6 个包成功 |
| GitHub Release | Release 包含 CHANGELOG 正文 + 二进制文件 + SHA256SUMS |
| Docker push | 镜像推送到 ghcr.io，linux/amd64 + linux/arm64 |
| 包内容验证 | 每个 tarball 包含 `dist/index.js` 和 `dist/index.d.ts` |

## 6 风险评估与缓解策略

### R1 — turbo 缓存污染

**风险**: turbo 的本地缓存可能在 CI runner 之间不一致。同一 PR 的不同推送可能使用不同缓存状态，导致"在我机器上能通过"但 CI 失败。

**缓解**:
- 缓存 key 包含 `package-lock.json` 的 hash，依赖变更时自动失效
- 对 main 分支的合并提交不使用缓存（`--no-cache`），确保全量验证
- 设置 `turbo.json` 的 `outputMode: new-only` 避免缓存输出被截断

### R2 — npm OIDC trusted publishing 配置

**风险**: GitHub OIDC trusted publishing 需要 npm 包注册表配置。如果配置错误，发布阶段失败且无回退方案。

**缓解**:
- 在包正式发布前在测试 npm registry（如 `npm publish --registry http://localhost`）验证 trusted publishing 流程
- 在 release workflow 中增加发布前验证 step：`node scripts/verify-oidc.mjs` 检查 `ACTIONS_ID_TOKEN_REQUEST_URL` 环境变量
- 发布步骤使用 `npm publish --provenance-access=public` 确保 provenance 生成

### R3 — 构建时间增长

**风险**: 随着项目代码增长，全量 CI 运行时间增长。预计算当前 `build:packages` 约 2-3 分钟，扩展后可能到 5-10 分钟（含全量测试和 lint）。

**缓解**:
- 增量策略（Layer 2）确保 90% 的 PR 只需 2-3 分钟
- 全量运行（Layer 3）只在 main merge 触发（每日 < 10 次）
- 缓存命中率高时测试任务可缩短到 30 秒以下
- 缓存未命中时的全量运行接受 5-10 分钟的合理范围

### R4 — 多平台维护成本

**风险**: 扩展 CI 到 windows-latest 和 macos-latest 后，跨平台测试的维护成本增加。尤其是 `vitest.setup.ts` 的 browser polyfill 和 esbuild 的 platform 差异。

**缓解**:
- 只对核心 job（类型检查、核心测试、构建）启用矩阵，lint 和 coverage 保持单一平台
- windows-latest 和 macos-latest 设置为 `continue-on-error: true`（信息性而非阻断性），允许 OS 兼容性问题可见但不阻断合并
- 当跨平台失败稳定出现时再逐步提升为阻断性

### R5 — 密钥管理风险

**风险**: CI 中新增的 npm publish、Docker push 等需要更多密钥配置。密钥泄露可能导致供应链攻击。

**缓解**:
- 所有 npm publish 使用 OIDC trusted publishing，不存储 `NPM_TOKEN`
- Docker 凭证使用 GitHub secrets 存储，仅在 release workflow 中使用
- 在 CI 中使用 `secrets` 配置的最小权限原则——每个 job 只获取需要的 secrets
- 定期（每月）轮换所有存储在 GitHub secrets 中的令牌

### R6 — 升级依赖的兼容性风险

**风险**: `package.json:69-86` 的 devDependencies 包含 18 个工具链包（typescript, eslint, vitest, turbo 等），自动升级可能引入 breaking changes。

**缓解**:
- 在 `.github/dependabot.yml` 中将 typescript 和 eslint 相关包标记为忽略（手动升级）
- 对自动合并的依赖设置 `labels: ["automerge", "dependencies"]`
- 在 `check:all` 中包含升级兼容性测试

### R7 — 流程噪音风险

**风险**: 新增的 CI 步骤（密钥扫描、依赖审计、depcruise）可能产生大量噪音（误报），导致团队忽略真正的失败。

**缓解**:
- 密钥扫描初始阶段使用 `continue-on-error: true`，在一周内收集和修复误报后切换为阻断模式
- dependency-cruise 的配置文件初期宽松，逐步收紧约束
- 失败分类（T6.5）帮助团队快速定位真正的构建问题，避免扫描结果的噪音污染

## 附录：文件变更清单

| 任务 ID | 新增/修改文件 | 操作类型 |
|---------|-------------|----------|
| T1.1 | `.github/workflows/ci.yml` | 修改 |
| T1.1 | `.github/workflows/perf-test.yml` | 修改 |
| T1.2 | `.github/workflows/ci.yml` | 修改 |
| T1.3 | `.github/workflows/ci.yml` | 修改 |
| T2.1 | `.github/workflows/ci.yml` | 修改（新增 detect-changes job） |
| T2.2 | `.github/workflows/ci.yml` | 修改（新增 turbo cache step） |
| T2.3 | `package.json` | 修改（新增 typecheck:ci） |
| T2.4 | `.github/workflows/ci.yml` | 修改 |
| T2.5 | `package.json` | 修改（新增 test:ci） |
| T2.6 | `.github/workflows/ci.yml` | 修改 |
| T3.1 | `.github/workflows/ci.yml` | 修改（main branch 全量构建） |
| T3.2 | `.github/workflows/ci.yml` | 修改（新增全量测试 job） |
| T3.3 | `.github/workflows/ci.yml` | 修改（合并 rust 测试） |
| T3.4 | `.github/workflows/ci.yml` | 修改（安全审计硬性化） |
| T3.5 | `.github/workflows/ci.yml` | 修改（新增 secret-scan） |
| T3.6 | `.dependency-cruiser.js` | 新增 |
| T3.7 | `.github/workflows/ci.yml` | 修改（新增 OS/Node 矩阵） |
| T3.8 | `.github/workflows/ci.yml` | 修改（新增 visual-test） |
| T3.9 | `.github/workflows/perf-test.yml` | 修改（结果持久化） |
| T4.1 | `.github/workflows/release.yml` | 修改 |
| T4.2 | `.github/workflows/release.yml` | 修改（新增 daemon 二进制） |
| T4.3 | `.github/workflows/release.yml` | 修改（新增 verify-release） |
| T5.1 | `.github/workflows/release.yml` | 修改（新增 publish-npm） |
| T5.2 | `package.json` / `scripts/version-bump.mjs` | 新增 |
| T5.3 | `scripts/generate-changelog.mjs` | 新增 |
| T5.4 | `Dockerfile` | 新增 |
| T5.5 | `.github/workflows/release.yml` | 修改 |
| T5.6 | `scripts/verify-publish.mjs` | 新增 |
| T6.1 | `.husky/pre-push` / `.lintstagedrc.json` | 修改 |
| T6.2 | `.github/dependabot.yml` | 修改 |
| T6.3 | `.github/workflows/ci.yml` | 修改（新增 metrics job） |
| T6.4 | `.github/workflows/ci.yml` | 修改（缓存策略） |
| T6.5 | `.github/workflows/ci.yml` | 修改（新增 failure analysis） |
## 7 增量 roll-out 路径

鏈妭鎻忚堪浠庡綋鍓嶇姸鎬侀€愭杩佺Щ鍒扮洰鏍?CI/CD 鏋舵瀯鐨勮繃娓¤矾寰勩€?
### 7.1 闃舵 0锛氫慨澶嶅凡鏈?CI 涓渶涓ラ噸鐨勯棶棰?
鍦ㄤ笉澧炲姞鏂?workflow 鐨勫墠鎻愪笅锛屼慨澶嶇幇鏈?ci.yml 涓殑 P0 闂锛?
1. 绉婚櫎 ci.yml:85,88 鐨?|| true 闈欓粯妯″紡锛屾敼涓烘甯搁€€鍑虹爜妫€鏌?2. 绉婚櫎 ci.yml:122-123,133-134 鐨?continue-on-error锛堝厛鍦ㄦ湰鍦伴獙璇?cargo audit 鍜?npm audit 閫氳繃锛?3. 鍦?coverage job 涓鍔犲疄闄呴槇鍊奸獙璇侀€昏緫
4. 淇 ci.yml:148 鐨?eslint 鍛戒护锛屾墿澶ф壂鎻忚寖鍥村埌鍏ㄩ儴 TS 鍖?5. 绉婚櫎 ci.yml:79 鐨?npx tsc --noEmit锛屾浛鎹负 npm run check:core

**前置条件**：无（直接在 ci.yml 上修改）
**褰卞搷鏂囦欢**锛?github/workflows/ci.yml

### 7.2 阶段 1：基础 CI 基础设施

1. 鍦?ci.yml 澧炲姞 concurrency 閰嶇疆
2. 涓烘墍鏈?workflow 澹版槑鏈€灏?permissions
3. 增加 paths-ignore 优化
4. 引入 detect-changes job
5. 鎭㈠ turbo cache 鍒?CI 姝ラ

**鍓嶇疆鏉′欢**锛氶樁娈?0
**褰卞搷鏂囦欢**锛?github/workflows/ci.yml, .github/workflows/perf-test.yml, .github/workflows/provider-validation.yml

### 7.3 闃舵 2锛氬閲忛獙璇?
1. 引入 dorny/paths-filter
2. 增量 typecheck
3. 增量 lint
4. 增量 unit test + coverage
5. 鎵╁睍 OS 鐭╅樀鍒?windows-latest

**鍓嶇疆鏉′欢**锛氶樁娈?1
**褰卞搷鏂囦欢**锛?github/workflows/ci.yml

### 7.4 闃舵 3锛氬叏閲忛獙璇?
1. main 分支全量构建
2. 全量测试套件
3. Rust 鍏ㄩ噺楠岃瘉缁熶竴鍖?4. 瀹夊叏瀹¤纭€у寲
5. 依赖合规 depcruise

**鍓嶇疆鏉′欢**锛氶樁娈?2
**褰卞搷鏂囦欢**锛?github/workflows/ci.yml, .dependency-cruiser.js

### 7.5 闃舵 4锛氬畨鍏ㄥ寮?
1. 密钥扫描集成
2. 定时安全审计专用 workflow
3. Playwright 视觉测试集成
4. 鍩哄噯娴嬭瘯鎸佷箙鍖?
**鍓嶇疆鏉′欢**锛氶樁娈?3
**褰卞搷鏂囦欢**锛?github/workflows/ci.yml, .github/workflows/perf-test.yml

### 7.6 阶段 5：发布流水线

1. 鍙戝竷骞茶繍琛?2. daemon 浜岃繘鍒舵瀯寤?3. 鍙戝竷鍓嶆竻鍗曟鏌?4. npm 鍖呭彂甯?5. 鐗堟湰绠＄悊
6. CHANGELOG 生成
7. Docker 镜像
8. GitHub Release 缁撴瀯鍖?9. 鍙戝竷鍓嶅寘楠岃瘉

**鍓嶇疆鏉′欢**锛氶樁娈?0-4
**褰卞搷鏂囦欢**锛?github/workflows/release.yml, package.json, Dockerfile, scripts/

### 7.7 闃舵 6锛氭寔缁紭鍖?
1. Husky hooks 优化
2. Dependabot 配置增强
3. Metrics 与仪表盘
4. 统一缓存策略
5. 閿欒鎶ュ憡涓庡け璐ュ垎绫?
**鍓嶇疆鏉′欢**锛氶樁娈?5
**褰卞搷鏂囦欢**锛?husky/pre-push, .lintstagedrc.json, .github/dependabot.yml

## 8 关键配置示例

### 8.1 寤鸿鐨?ci.yml 楠ㄦ灦锛堝閲忔ā寮忥級

```yaml
name: CI
on:
  push:
    branches: [main, develop]
    paths-ignore:
      - 'docs/**'
      - '*.md'
  pull_request:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '*.md'

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      packages: ${{ steps.filter.outputs.changes }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            shared-types:
              - 'packages/shared-types/**'
            shared-utils:
              - 'packages/shared-utils/**'
            decision-engine:
              - 'packages/decision-engine/**'
            agent-runtime:
              - 'packages/agent-runtime/**'
            agent-orchestrator:
              - 'packages/agent-orchestrator/**'
            agent-daemon:
              - 'packages/agent-daemon/**'
            crish-desktop:
              - 'apps/crish-desktop/**'
            agent-workbench:
              - 'apps/agent-workbench/**'
            rust-crates:
              - 'crates/**'
              - 'Cargo.toml'
              - 'Cargo.lock'

  ts-check:
    needs: detect-changes
    if: needs.detect-changes.outputs.packages != ''
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [20, 22]
      fail-fast: false
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - name: Restore turbo cache
        uses: actions/cache@v4
        with:
          path: .turbo
          key: turbo-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
      - run: npm ci
      - name: Type check changed packages
        run: npx turbo run typecheck --filter=${{ needs.detect-changes.outputs.packages }} --continue
      - name: Test changed packages
        run: npx turbo run test --filter=${{ needs.detect-changes.outputs.packages }} --continue

  lint:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Strict lint
        run: npm run lint:all
      - name: Format check
        run: npm run format
```

### 8.2 寤鸿鐨?dependabot.yml 澧炲己

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "Asia/Shanghai"
    labels:
      - "dependencies"
      - "automerge"
    open-pull-requests-limit: 15
    versioning-strategy: increase
    ignore:
      - dependency-name: "typescript"
        versions: [">=6.0.0"]
    groups:
      eslint:
        patterns:
          - "eslint*"
          - "@eslint/*"
          - "typescript-eslint"
      vitest:
        patterns:
          - "vitest*"
          - "@vitest/*"

  - package-ecosystem: "cargo"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "Asia/Shanghai"
    labels:
      - "dependencies"
      - "automerge"
    open-pull-requests-limit: 5
    ignore:
      - dependency-name: "conex-stream"
        versions: [">=0.2.0"]
```

### 8.3 寤鸿鐨?.husky/pre-push 淇敼

鍙樻洿鍓? `npm run typecheck && npm test`
鍙樻洿鍚? `npm run typecheck:ci && npm run test:core`

### 8.4 寤鸿鐨?package.json 鏂板鑴氭湰

```json
{
  "scripts": {
    "typecheck:ci": "turbo run typecheck --continue",
    "test:ci": "turbo run test --continue -- --reporter=junit --outputFile.junit=test-results.xml",
    "lint:ci": "turbo run lint --continue",
    "build:ci": "turbo run build",
    "perf:ci": "npm run bench:ci && npm run bench:native-sla && npm run bench:acceptance && npm run bench:report",
    "release:dry-run": "npm run build:product && npm run check:all && node scripts/verify-publish.mjs",
    "version:check": "node scripts/version-bump.mjs --check",
    "version:bump": "node scripts/version-bump.mjs"
  }
}
```

### 8.5 Dockerfile 建议骨架

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ packages/
COPY scripts/ scripts/
COPY tsconfig.base.json turbo.json ./
RUN npm ci --ignore-scripts
RUN npm run build:packages

FROM node:22-alpine AS daemon
WORKDIR /app
COPY --from=builder /app/packages/agent-daemon/dist/ ./packages/agent-daemon/dist/
COPY --from=builder /app/packages/agent-daemon/package.json ./packages/agent-daemon/
COPY --from=builder /app/packages/agent-daemon/node_modules/ ./packages/agent-daemon/node_modules/
EXPOSE 31507
CMD ["node", "packages/agent-daemon/dist/index.js"]
```

## 9 楠屾敹妫€鏌ユ竻鍗?
### 9.1 基础 CI 验收

- 鎵€鏈?workflow 澹版槑浜嗘渶灏?permissions
- ci.yml 鍜?perf-test.yml 鏈?concurrency 閰嶇疆
- docs/** 鍜?*.md 鐨勪慨鏀逛笉瑙﹀彂 CI
- turbo cache 鍦?CI 涓彲鐢ㄤ笖鍛戒腑鐜?> 50%

### 9.2 增量验证验收

- PR CI 只构建、类型检查和测试受影响的包及其依赖链
- 淇敼 shared-types 鑷姩瑙﹀彂 agent-runtime 鍜?agent-orchestrator 鐨勬祴璇?- npm run lint:all 杩斿洖閫€鍑虹爜 0
- prettier --check . 返回退出码 0
- 覆盖率低于阈值时 CI 失败（红色）
- 鎵€鏈?TS 鍖呴€氳繃浜?tsc --noEmit
- Rust crate 鐨?cargo clippy -- -D warnings 闆惰鍛?
### 9.3 全量验证验收

- main 鍒嗘敮鍚堝苟鏃舵墽琛屽叏閲忔瀯寤猴紙turbo run build锛?- main 鍒嗘敮鍚堝苟鏃舵墽琛屽叏閲忔祴璇曪紙test:core + test:desktop-helpers + test:coverage锛?- main 鍒嗘敮鍚堝苟鏃舵墽琛?test:integration
- 集成测试通过 vitest.integration.config.ts
- npm audit 澶辫触鏃?CI 涓虹孩鑹?- cargo audit 澶辫触鏃?CI 涓虹孩鑹?- dependency-cruiser 鏃犲惊鐜緷璧栬繚瑙?- Playwright 瑙嗚娴嬭瘯鑷冲皯鍦?ubuntu-latest 涓婇€氳繃

### 9.4 安全扫描验收

- 瀵嗛挜鎵弿鍦?main 鍒嗘敮姣忔鎺ㄩ€佹椂鎵ц
- 密钥扫描在定时任务中扫描全量历史
- SBOM 鍦ㄦ瘡娆?release 鏃剁敓鎴?
### 9.5 鍙戝竷娴佹按绾块獙鏀?
- npm publish 使用 OIDC trusted publishing
- 鍙戝竷骞茶繍琛岄€氳繃锛坉ry-run锛?- 鎵€鏈?@crish/* 鍖呮寜渚濊禆椤哄簭鍙戝竷
- GitHub Release 包含 CHANGELOG 内容
- daemon 浜岃繘鍒跺湪 3 骞冲彴鑷姩鏋勫缓骞朵笂浼?- Docker 闀滃儚 push 鍒?ghcr.io
- 鍙戝竷鍓嶉獙璇佺増鏈彿涓€鑷存€?
### 9.6 持续优化验收

- pre-push 涓嶆墽琛?e2e 娴嬭瘯
- dependabot 鏈夊悎鐞嗙殑鍒嗙粍鍜?ignore 绛栫暐
- CI 运行摘要显示各阶段耗时
- 失败 CI 自动分类错误类型

## 10 文件变更总结

### 新增文件

| 鏂囦欢 | 鐢ㄩ€?| 浼拌琛屾暟 |
|------|------|----------|
| .dependency-cruiser.js | 寰幆渚濊禆妫€娴嬮厤缃?| 40 |
| Dockerfile | 澶氶樁娈?daemon 瀹瑰櫒闀滃儚 | 30 |
| scripts/version-bump.mjs | 统一版本管理 | 80 |
| scripts/generate-changelog.mjs | CHANGELOG 自动生成 | 100 |
| scripts/verify-publish.mjs | 发布前包内容验证 | 60 |
| .github/workflows/auto-merge-deps.yml | Dependabot PR 自动合并 | 20 |

### 修改文件

| 鏂囦欢 | 涓昏鍙樻洿 | 浼拌淇敼閲?|
|------|----------|-----------|
| .github/workflows/ci.yml | detect-changes, 鐭╅樀, 鏂?job | +400 琛?|
| .github/workflows/perf-test.yml | 骞跺彂鎺у埗, 鎸佷箙鍖?| +50 琛?|
| .github/workflows/provider-validation.yml | 骞跺彂鎺у埗, 鏉冮檺 | +10 琛?|
| .github/workflows/release.yml | npm publish, daemon, Docker | +300 琛?|
| .husky/pre-push | replace with typecheck:ci + test:core | 1 琛?|
| .lintstagedrc.json | add json eslint | 2 琛?|
| package.json | add 7 new scripts | +7 琛?|
| .github/dependabot.yml | groups, ignore comments, timezone | +15 琛?|

### 总工作量估计

- 鏂板浠ｇ爜锛氱害 330 琛岋紙script + config + workflow锛?- 淇敼浠ｇ爜锛氱害 +780 琛岋紙鐜版湁鏂囦欢鐨勪慨鏀规墿澧烇級
- 閰嶇疆鏀瑰姩娑夊強锛氱害 12 涓枃浠?- **鎬婚噺锛氱害 1100 琛屾柊澧?淇敼**

## 11 风险缓解矩阵

| 椋庨櫓 | 姒傜巼 | 褰卞搷 | 缂撹В鎺柦 | 瑙﹀彂鍚庡搷搴?|
|------|------|------|----------|-----------|
| turbo 缂撳瓨涓嶄竴鑷?| 浣?| 涓?| cache key 鍚?package-lock hash | 娓呯┖缂撳瓨閲嶆柊 build |
| OIDC 閰嶇疆澶辫触 | 浣?| 楂?| 鍏堝湪娴嬭瘯 registry 楠岃瘉 | 鍥為€€鍒?NPM_TOKEN |
| 鍏ㄩ噺 CI 瓒呮椂 | 涓?| 涓?| 璁剧疆 30 min timeout | 鎷嗗垎涓茶 job |
| OS 鐭╅樀娴嬭瘯涓嶇ǔ瀹?| 涓?| 浣?| windows/macos 璁句负 continue-on-error | 淇鍚庡崌涓?blocking |
| dependabot breaking change | 楂?| 涓?| 鍒嗙粍 + 浜哄伐 review | revert PR |
| secret scan 璇姤 | 楂?| 浣?| 鍒濆 continue-on-error + 鎺掗櫎 | 鍔犳帓闄よ鍒?|
| npm publish 椤哄簭閿欒 | 浣?| 楂?| 鎸変緷璧栨嫇鎵戜弗鏍兼帓搴?| unpublish 閲嶆柊鍙戝竷 |
| 瀵嗛挜娉勯湶 | 浣?| 楂?| OIDC + 鏈€灏忔潈闄?+ 瀹氭湡杞崲 | 绔嬪嵆 revoke + 杞崲 |
| Docker 鏋勫缓澶辫触 | 涓?| 涓?| multi-stage 鍒嗙鏋勫缓鍜岃繍琛屾椂 | 鍥為€€鍒?npm 鍙戝竷 |

## 12 与现有修复方案的集成

鏈?CI/CD 鏀硅繘鏂规涓?docs/crish_desktop_architectural_remediation_plan 鐨?Layer A-G 淇璁″垝浜掕ˉ锛?
- **Layer A锛堝叡浜熀纭€璁炬柦锛?*锛欳I/CD 涓殑 dependency-cruiser 楠岃瘉鍙珐鍥?Layer A 鐨勬ā鍧楄竟鐣屼慨澶?- **Layer B锛圧ust 鏍稿績锛?*锛歊ust crate 鐨?cargo test --workspace --all-features 楠岃瘉 B 灞傞噸鏋?- **Layer C-D锛圧untime + Orchestrator锛?*锛氬閲忔祴璇?+ 闆嗘垚娴嬭瘯楠岃瘉 C/D 灞傜殑妯″潡鍒嗚В
- **Layer E锛堢姸鎬佺鐞嗭級**锛歝heck:store-types 鐨?CI 楠岃瘉纭繚 E 灞傜殑 Store 瀹夊叏閲嶆瀯涓嶈鍚庣画 PR 鐮村潖
- **Layer F锛圲I 缁勪欢锛?*锛歅laywright 瑙嗚娴嬭瘯纭繚 F 灞?UI 閲嶆瀯涓嶄骇鐢熷洖褰?- **Layer G锛堟€ц兘锛?*锛氬熀鍑嗘祴璇曟寔涔呭寲纭繚 G 灞備紭鍖栧悗鎬ц兘涓嶉€€鍖?
姣忎釜 Layer 瀹屾垚閲嶆瀯鍚庯紝搴旀洿鏂?CI 涓殑娴嬭瘯閰嶇疆锛屽皢鏂伴噸鏋勭殑妯″潡绾冲叆澧為噺娴嬭瘯鑼冨洿銆?
## 13 璁捐鍘熷垯鎵ц妫€鏌?
鏈妭閫愭潯妫€鏌ユ敼杩涙柟妗堟槸鍚﹂伒寰簡绗?1 绔犲畾涔夌殑璁捐鍘熷垯锛?
**P1 鈥?鍘熺敓铻嶅叆鐜版湁鏋勫缓浣撶郴**
妫€鏌ョ粨鏋滐細閫氳繃銆傛墍鏈?CI 浠诲姟浣跨敤鐜版湁 npm scripts锛坧ackage.json锛夈€乼urbo pipeline锛坱urbo.json锛夈€乧argo 鍛戒护锛圕argo.toml锛夈€傛湭寮曞叆鏂扮殑鏋勫缓鍏冩鏋躲€俥sbuild 鍜?tsc 鐨勮皟鐢ㄩ€氳繃鍚勫寘宸叉湁 script 闂存帴璋冪敤銆?
**P2 鈥?绛変环楠岃瘉**
妫€鏌ョ粨鏋滐細閫氳繃銆侰I 涓墽琛岀殑鍛戒护涓庢湰鍦?npm scripts 瀹屽叏涓€鑷达紙turbo run build, npm run lint:all, prettier --check 绛夛級銆備笉鍑虹幇 CI 鐙韩鐨勯獙璇佸懡浠ゃ€?
**P3 鈥?澧為噺涓轰富锛屽叏閲忎负杈?*
妫€鏌ョ粨鏋滐細閫氳繃銆俆2.1-T2.6 鍦?PR 绾у埆瀹炵幇澧為噺锛坱urbo --filter锛夛紱T3.1-T3.9 鍦?main 鍚堝苟鏃跺疄鐜板叏閲忋€傚閲忔ā寮忛€氳繃 dorny/paths-filter + turbo --filter 鑱斿悎瀹炵幇銆?
**P4 鈥?闂ㄧ纭€у寲**
妫€鏌ョ粨鏋滐細閫氳繃銆傛秷闄ゆ墍鏈?|| true 鍜?continue-on-error 妯″紡銆傝鐩栫巼闃堝€笺€乴int --max-warnings 0銆乼sc --noEmit 涓ユ牸妯″紡鍏ㄩ儴纭€ч樆鏂€?
**P5 鈥?鍗曚竴浜嬪疄鏉ユ簮**
妫€鏌ョ粨鏋滐細閫氳繃銆傜増鏈俊鎭粠 package.json 鍜?Cargo.toml 璇诲彇銆侰I workflow 涓笉纭紪鐮?Node 鐗堟湰瀛楃涓诧紙浠?matrix 璇诲彇锛夈€傚彂甯冩椂鏍囩涓?package.json 鐗堟湰浜ゅ弶楠岃瘉銆?
**P6 鈥?鏈€灏忔潈闄愪笌瀹夊叏榛樿**
妫€鏌ョ粨鏋滐細閫氳繃銆傛墍鏈?workflow 澹版槑鏈€灏?permissions銆俷pm publish 浣跨敤 OIDC trusted publishing銆傚瘑閽ユ壂鎻忓拰 SBOM 绾冲叆鏍囧噯娴佺▼銆?
**P7 鈥?鍙娴嬫€т紭鍏?*
妫€鏌ョ粨鏋滐細閫氳繃銆侸Unit 娴嬭瘯鎶ュ憡銆乴cov 瑕嗙洊鐜囨姤鍛娿€佹瀯寤鸿€楁椂 metrics銆佸熀鍑嗘祴璇曟寔涔呭寲鍏ㄨ鐩栥€?
## 14 完整引用索引

浠ヤ笅鍒楀嚭鏀硅繘鏂规涓紩鐢ㄧ殑鎵€鏈夐」鐩枃浠惰矾寰勫拰琛屽彿锛?
| 寮曠敤璺緞 | 琛屽彿 | 鐢ㄩ€?|
|----------|------|------|
| package.json | 7-16 | npm workspaces 定义 |
| package.json | 17-67 | scripts 定义 |
| package.json | 24-30 | 鏋勫缓閾惧畾涔?|
| package.json | 50 | check:core |
| package.json | 54 | typecheck |
| package.json | 56 | check:store-types |
| package.json | 57-61 | 测试命令 |
| package.json | 62-65 | lint 严格 vs 宽松 |
| package.json | 66-67 | format |
| package.json | 69-86 | devDependencies |
| package.json | 73 | dependency-cruiser |
| turbo.json | 3-30 | pipeline 定义 |
| turbo.json | 6 | outputs 声明 |
| tsconfig.base.json | 8-23 | strict 模式 |
| tsconfig.base.json | 18-19 | noUnusedLocals |
| tsconfig.base.json | 22 | noUncheckedIndexedAccess |
| tsconfig.base.json | 23 | exactOptionalPropertyTypes |
| vitest.config.ts | 7-16 | include 模式 |
| vitest.config.ts | 13-16 | coverage 报告 |
| apps/crish-desktop/vitest.config.ts | 13-18 | 瑕嗙洊鐜囬槇鍊?|
| eslint.config.js | 9-21 | ignores 列表 |
| eslint.config.js | 55-57 | 前端规则范围 |
| .lintstagedrc.json | 1-5 | lint-staged 配置 |
| .husky/pre-commit | 1 | npx lint-staged |
| .husky/pre-push | 1 | typecheck + test |
| packages/agent-daemon/package.json | 25-28 | build 涓夊厓缁?|
| packages/agent-daemon/package.json | 26 | tsc-alias |
| packages/agent-daemon/package.json | 33 | 渚濊禆閾?|
| packages/agent-daemon/package.json | 39 | MCP SDK |
| packages/shared-types/package.json | 25-28 | build 模式 |
| packages/shared-utils/package.json | 46-49 | 澶氬叆鍙?|
| packages/agent-orchestrator/package.json | 31 | 渚濊禆閾?|
| apps/agent-workbench/package.json | 9 | build 閲嶅畾鍚?|
| apps/agent-workbench/package.json | 12 | cli:check |
| apps/crish-desktop/package.json | 10 | tsc -b + vite |
| apps/crish-desktop/package.json | 13 | qa:check |
| apps/crish-desktop/package.json | 16-17 | Playwright |
| Cargo.toml | 2-15 | workspace members |
| Cargo.toml | 60-66 | workspace.package |
| Cargo.toml | 68-82 | dependencies |
| crates/conex-stream/Cargo.toml | 1-21 | 示例 crate |
| .github/dependabot.yml | 1-25 | dependabot |
| .github/workflows/ci.yml | 13-42 | rust-check |
| .github/workflows/ci.yml | 66-88 | ts-check |
| .github/workflows/ci.yml | 79 | tsc --noEmit |
| .github/workflows/ci.yml | 85,88 | || true 问题 |
| .github/workflows/ci.yml | 122-134 | security-audit |
| .github/workflows/ci.yml | 136-148 | ESLint |
| .github/workflows/ci.yml | 150-167 | coverage |
| .github/workflows/ci.yml | 169-181 | e2e |
| .github/workflows/ci.yml | 184-197 | bench-rust |
| .github/workflows/ci.yml | 199-209 | bench-ts |
| .github/workflows/perf-test.yml | 1-137 | 性能测试 |
| .github/workflows/release.yml | 1-67 | 鍙戝竷娴佹按绾?|
| .github/workflows/release.yml | 23 | Node 20 |
| .github/workflows/release.yml | 37 | build:packages |
| .github/workflows/release.yml | 61 | generate_release_notes |
| vitest.setup.ts | 1-44 | browser polyfill |