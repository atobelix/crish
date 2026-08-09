# D8 多端工程整合与发布设计方案（engineering-release）

> 子代理 D8 产出 · 多端互通工作流（multi-device）
>
> - 状态：草案（待主控评审与用户裁决）
> - 日期：2026-08-09
> - 作者：子代理 D8（工程整合与发布设计）
> - 前置输入：本任务的任务书（workspace 结构 / 共享代码 / 门禁 / 本地开发 / 构建发布 / Rust 整合 / 质量基线 / 风险 / 落地步骤 九项要求）
> - 产出一句话结论：**移动端以独立 Expo app 进入现有 npm workspaces（turbo 不缓存 expo 原生构建，用包内 turbo.json 收窄任务面）；跨端共享经新建协议包 `packages/protocol-*` + 扩展 generate-engine-bindings 生成器实现单一真源，禁止手写双份；门禁按"快层加移动端静态检查、中层加 jest 全量与协议对拍、发布走 EAS"三线扩展，移动端覆盖率基线对齐桌面 45/70/65/45 的严格度而非数值。**

---

## 文档导航（读者索引）

| 章节 | 内容 | 对应任务要求 |
| --- | --- | --- |
| 第 0 章 | 绪论：目标、范围、设计原则、结论摘要 | 总纲 |
| 第 1 章 | 现状盘点：仓库拓扑、门禁基线、可复用资产 | 输入盘点 |
| 第 2 章 | 目标架构与多端拓扑 | 总纲 |
| 第 3 章 | workspace 结构演进（Expo 进 npm workspaces、turbo 兼容、协议包决策、Cargo 边界） | 任务 1 |
| 第 4 章 | 共享代码策略（共享面、方式矩阵、生成器扩展） | 任务 2 |
| 第 5 章 | 门禁体系扩展（快/中/慢层、jest、协议一致性门禁） | 任务 3 |
| 第 6 章 | 本地开发流（联合调试、dev 脚本组织） | 任务 4 |
| 第 7 章 | 构建与发布（桌面/移动端独立与联动、版本策略、升级兼容） | 任务 5 |
| 第 8 章 | Rust 侧整合（Cargo workspace members、依赖策略、turbo×cargo 共存） | 任务 6 |
| 第 9 章 | 质量基线（对照桌面 5383/45/70/65/45/strict 的移动端基线） | 任务 7 |
| 第 10 章 | 风险清单与对策 | 任务 8 |
| 第 11 章 | 落地步骤（五阶段，每阶段含验收） | 任务 9 |
| 第 12 章 | 结论与待决事项 | 收口 |
| 附录 A | 查证记录（webfetch 来源与结论） | — |
| 附录 B | 术语表 | — |
| 附录 C | 参考文件行号索引（本方案引用的仓库现状证据） | — |

本文档引用仓库现状的代码位置统一使用 `文件路径:行号` 格式，路径为仓库内相对路径（与 AGENTS.md 引用规则一致）；对外交付路径一律使用 Windows 绝对路径（如 `C:\Software\conex\docs\multi-device\plans\D8-engineering-release.md`）。

---

## 第 0 章 绪论

### 0.1 任务目标

本方案为"crish 多端互通"（桌面端 + 移动端 + 可能出现的服务端）提供工程整合与发布设计，覆盖九项任务要求：

1. workspace 结构演进：Expo 移动端如何进入现有 npm workspaces；新增共享包（协议包 / 跨端类型包）从 `packages/shared-types` 派生还是新建；Cargo workspace 与移动端"无 Rust 关系"的边界。
2. 共享代码策略：跨端共享什么（事件类型 / 协议 schema / 审批状态机纯函数）、如何共享（npm 包 / 生成器 / 手写双份）；现有 `scripts/generate-engine-bindings.mjs` 如何扩展到移动端。
3. 门禁体系：现有快层 / 中层 CI 如何扩展移动端（lint / typecheck / test / build）；移动端测试门禁（jest 配置与覆盖率）；协议一致性门禁（schema 漂移检查）。
4. 本地开发流：桌面 + 移动端联合调试（服务端口 / 指向本机 / 真机局域网）、dev 脚本组织。
5. 构建与发布：桌面发布流程与移动端发布（EAS Build / 应用商店）的独立与联动；版本号策略（协议版本与应用版本的关系）；升级兼容（旧移动端连新桌面端）。
6. Rust 侧整合：新增 Rust crate（协议 / 服务端）时 Cargo workspace members 更新与依赖策略。
7. 质量基线：移动端测试覆盖率 / 类型严格度，对照桌面端 vitest 5383 用例、tsc strict 的水平。
8. 风险：turbo × expo 的坑（缓存 / 构建隔离）、node_modules 膨胀、CI 时长。
9. 落地步骤：分阶段（骨架整合 → 协议包 → 移动端基础 → 门禁 → 发布），每步验收。

### 0.2 设计原则

本方案遵循以下原则（与仓库既有治理基线对齐）：

- **单一真源（Single Source of Truth）**：跨端协议的定义只能有一个真源。方案选择"Rust 侧注册表 JSON + 生成器"为真源，移动端与桌面端都消费生成产物，禁止任何一端手写协议类型（AGENTS.md 的"严禁补丁、绕过与作弊"精神延伸：手写双份 = 必然漂移 = 潜伏的补丁）。
- **门禁先行的渐进式整合**：移动端进入仓库的第一天就有 lint / typecheck / 最小测试，CI 门禁与代码同时落地，不允许"先进仓库、门禁后补"（参考 AGENTS.md 中"测试是资产不是杂物"与"新增调试/测试脚本后立即 git add 提交"的纪律）。
- **平台边界清晰**：共享的是纯逻辑与协议（无 DOM、无 Tauri、无 React Native API），平台能力（文件系统、窗口、通知、原生模块）留在各端内部；共享包被依赖链强约束（depcruise 层面禁止 packages 依赖 apps）。
- **npm workspaces 生态内解决问题**：当前仓库是 npm@11 + turbo 2.10.8 的显式 workspaces 列表（`package.json:8-16`），方案不引入 pnpm / yarn 迁移（迁移属于另一量级的工程决策，不在本方案范围；若未来用户裁决迁移，本章的 Expo 兼容性结论仍适用，只需替换锁文件）。
- **移动端发布独立于桌面端**：EAS Build / 应用商店节奏与桌面端（Tauri 发布）互相不阻塞；联动点只有"协议版本兼容矩阵"与"共享包版本"，这两者用仓库内单一真源 + CI 对拍保证。

### 0.3 结论摘要（决策先行）

本方案的关键决策（详细论证见对应章节）：

| 决策点 | 结论 | 章节 |
| --- | --- | --- |
| 移动端 app 如何进 monorepo | `apps/crish-mobile` 作为独立 Expo app 加入 npm workspaces 显式列表；利用 Expo SDK 52+ 的自动 monorepo 检测，不写手改的 metro.config.js watchFolders | 3.1–3.3 |
| turbo 与 expo 的关系 | turbo 只调度 expo 的 JS 侧任务（`typecheck` / `test` / `lint`）；`expo start`、`expo export`、EAS 构建不进 turbo 缓存（原生产物不可哈希复用），用包内 `turbo.json` 收窄任务面 | 3.3 |
| 协议包 | 新建 `packages/protocol-core`（跨端协议 schema + 纯函数），**从 shared-types 派生**（先抽后建，不复制）；shared-types 保留桌面端专属类型与引擎事件面 | 3.4 |
| 共享方式 | npm 包 + 生成器双轨：注册表 JSON（Rust 侧）→ 生成器 → 各端消费；**不手写双份** | 4.2–4.3 |
| 生成器扩展 | 在 `scripts/generate-engine-bindings.mjs` 的机制上扩展出 `scripts/generate-protocol-bindings.mjs`（独立脚本、同风格、同幂等约定），输出 TS 类型 + zod schema + 纯校验函数 | 4.3 |
| 协议一致性门禁 | 移动端与 Rust 端对拍：生成器重跑后 `git diff --exit-code`（继承现有 engine-bindings-drift job 模式，ci.yml:99-110）+ 跨语言对拍测试（同一注册表 JSON 分别生成 TS 与 Rust 测试夹具，双端跑同一组样例） | 5.3 |
| 移动端测试框架 | jest-expo（Expo 官方推荐的 RN 测试栈），独立于 vitest；移动端测试不进根 vitest 门禁，进独立 job（避免 jsdom/RN 双环境互相污染） | 5.2 |
| 移动端质量基线 | 覆盖率阈值对齐"严格度"而非数值：新协议/共享代码路径覆盖 ≥ 桌面阈值（45/70/65/45 上浮至 60/75/70/60），UI 层首期豁免；类型 strict 全开（对齐 tsconfig.base.json），RN 特有放宽项走显式白名单 | 第 9 章 |
| Cargo workspace | 协议 crate（若需 Rust 侧实现）加入 `Cargo.toml` members 显式列表；移动端构建链不触 Rust 编译（无 React Native 原生模块，不建 Rust crate 桥） | 第 8 章 |
| 版本策略 | 三轨：应用版本（每端独立 semver）/ 协议版本（注册表 schemaVersion 派生，独立单调递增）/ 兼容窗口（移动端声明 `minProtocolVersion`，握手时协商） | 7.3–7.4 |
| 发布 | 桌面端保持现有流程；移动端 EAS Build 云构建 + GitHub Actions 触发，iOS/Android 各自独立 profile；协议版本变更触发"兼容矩阵"门禁而非连锁发布 | 7.2 |
| 落地阶段 | 五阶段：0 骨架整合 → 1 协议包 → 2 移动端基础 → 3 门禁收口 → 4 发布，每阶段独立验收与提交 | 第 11 章 |

### 0.4 阅读说明

- 本文档是**设计文档**而非任务书：包含决策论证、配置代码示例、命令示例与验收清单，不包含"谁在哪个时间段执行"的排期（排期属主控调度）。
- 配置示例（turbo.json / CI YAML / eas.json / jest 配置）均为**建议形态**，落地时以实际执行的实现任务书为准；但"真源选择、门禁结构、版本策略"三类结论为强约束，实现任务不得擅自改变。
- 标注"待用户裁决"的条目集中在第 12 章，是主控需要在派发后续任务前确认的开放问题。

---

## 第 1 章 现状盘点（工程基线）

本章盘点仓库当前工程形态，作为整合方案的输入。所有结论都有 `文件路径:行号` 证据。

### 1.1 仓库拓扑总览

当前 crish 仓库是"JS/TS monorepo + Rust workspace"双栈并存的结构：

```
C:\Software\conex\
├── package.json                     # npm workspaces 显式列表 + 根脚本 + lint-staged
├── turbo.json                       # 根任务图（build/test/lint/typecheck/clean）
├── tsconfig.base.json               # strict 全家桶基础配置
├── vitest.config.ts                 # 根 vitest：unit/integration/native-smoke 三项目
├── vitest.integration.config.ts     # F3 层四目录独立配置
├── vitest.setup.ts / vitest.globalSetup.ts
├── Cargo.toml                       # Rust workspace（resolver 2，16 个 crate）
├── .github/workflows/
│   ├── ci.yml                       # 快层（提交/PR，≤15 min）
│   ├── ci-mid.yml                   # 中层（合并前全量，≤20 min）
│   └── ci-slow.yml                  # 慢层（压力/e2e/基准，nightly）
├── apps/
│   ├── crish-desktop/               # React 桌面 UI（vite，port 5174）
│   └── agent-workbench/             # Tauri 壳（src-tauri = Rust 主程序）
├── packages/                        # 5 个共享包
│   ├── plugin-import-claude-codex/
│   ├── plugin-sdk/
│   ├── shared-types/                # 跨端类型真源（含 generated/engine）
│   ├── shared-utils/                # 纯工具函数（多入口：. /browser /node）
│   └── test-utils/
├── crates/                          # Rust 内核 14 个 crate（+壳 crate=16）
│   ├── conex-types/                 # 引擎事件注册表（contracts/engine-events.json）
│   ├── session-loop/ orchestrator/ agent-provider/ agent-tools/ ...
├── scripts/                         # 根级脚本（生成器/检查/基准）
└── tests/                           # 根级测试（e2e/stress/startup 等）
```

要点：

1. **npm workspaces 是显式列表而非通配符**（`package.json:8-16`）：`apps/crish-desktop`、`apps/agent-workbench`、5 个 `packages/*`。新增移动端 app 必须显式加入该列表（或未来改为通配符 `apps/*`、`packages/*`，见 3.1 的论证）。
2. **turbo 2.10.8 任务图**（`turbo.json:3-30`）：`build` 依赖 `^build`，`test` 依赖 `build`，`typecheck` 依赖 `build:types`；输出目录只声明了 `dist/**` 与 `.tsbuildinfo`。
3. **Rust workspace 独立存在**（`Cargo.toml:1-21`）：16 个成员（14 个 crates + 壳 `apps/agent-workbench/src-tauri`），resolver 2，统一 `workspace.dependencies` 与 `workspace.lints`（`Cargo.toml:38-49`：dbg_macro/unimplemented deny、unsafe warn）。
4. **版本基线**：根、各 app、各 package 均为 `0.1.0`（plugin-import-claude-codex 例外为 `1.0.0`，`packages/plugin-import-claude-codex/package.json:3`）。

### 1.2 六个关键文件现状（整合的锚点）

| 文件 | 现状要点 | 对整合的意义 |
| --- | --- | --- |
| `package.json`（根） | workspaces 显式列表；根脚本用 `npm --workspace` 直调；`typecheck` = 7 段 tsc 直跑（`package.json:40`）；lint-staged 覆盖 ts/tsx/json/md/yml | 移动端 app 加入 workspaces 后，根脚本面必然增长；lint-staged 无需改（只按 glob 匹配） |
| `turbo.json` | 任务全仓库级声明，无包级覆盖 | 移动端需要包级 turbo.json 收窄任务（见 3.3） |
| `Cargo.toml` | members 显式列表 + workspace.dependencies（serde/tauri/tokio/reqwest 等收敛单版本）+ workspace.lints | 新增协议 crate 走同一模式（见第 8 章） |
| `vitest.config.ts` | projects: unit / integration / native-smoke；覆盖率阈值在**根 coverage 块**（45/70/65/45，`vitest.config.ts:50-55`），项目级阈值被根覆盖（文件头注释有详细踩坑记录） | 移动端 jest 独立，不得并入该文件（见 5.2 论证） |
| `ci.yml`（快层） | 8 个 job：typecheck / lint / vitest-fast / audit / engine-bindings-drift / cargo-deny / secret-scan / rust-check / rust-unit-fast | 移动端静态检查在此层扩展；`paths-ignore` 含 `docs/**`、`*.md`、`assets/**`（`ci.yml:16-24`） |
| `ci-mid.yml`（中层） | 7 个 job：rust-test / clippy / test / test:integration / machete / e2e 冒烟 / knip / governance-baselines | 移动端全量测试与协议对拍在此层扩展 |

### 1.3 现有代码共享机制（整合的复用基础）

**1.3.1 shared-types 的双轨 exports（development 条件）**

`packages/shared-types/package.json:9-20` 的 exports 是"开发走源码、生产走 dist"的双轨结构：

```json
"exports": {
  ".": {
    "development": { "types": "./src/index.ts", "import": "./src/index.ts", "default": "./src/index.ts" },
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  }
}
```

- 消费方（apps / packages）通过 `tsconfig.base.json:5` 的 `customConditions: ["development"]` + bundler 解析走源码路径，dev 下无需预构建；生产构建前跑 `build:types` + `build:js`（tsc emitDeclarationOnly + tsc-alias + esbuild bundle，`packages/shared-types/package.json:25-29`）。
- **对移动端的意义**：Metro 的解析器（React Native 的打包器）对 `exports` 条件的支持与 Node/Vite 不完全一致，`development` 自定义条件需要 Metro 配置放行（`unstable_conditionNames`），或让移动端直接依赖 dist。这是 3.4 中协议包设计必须解决的第一个现实约束。

**1.3.2 generated/engine 生成器（engine-events.json → TS）**

`scripts/generate-engine-bindings.mjs` 的机制（本方案扩展的直接模板）：

- 真源：`crates/conex-types/contracts/engine-events.json`（由 `crates/conex-types/src/events.rs` 维护，`generate-engine-bindings.mjs:24-39`）。
- 输出：`packages/shared-types/src/generated/engine/{events,types,parser,index}.ts`（固定文件集、确定性内容、幂等：重复运行字节一致，`generate-engine-bindings.mjs:10-18`）。
- 校验：`validateRegistry` 强校验注册表（contract 名、schemaVersion、事件 id 顺序、number 字段必须声明 integer、背压级别枚举覆盖等，`generate-engine-bindings.mjs:87-167`）。
- 输出内容：EngineEvent 标签联合 + 载荷类型 + 枚举常量 + 手写风格生成 parser（ParseResult 机制 + 深度守卫 + 整数校验，`generate-engine-bindings.mjs:299-415`）。
- 门禁：CI job `engine-bindings-drift`（`ci.yml:99-110`）重跑生成器后 `git diff --exit-code`，锁定 JSON↔TS 漂移（注释明确说明该门禁只锁 JSON↔TS，不锁 JSON↔Rust——见 `ci.yml:95-98`，这是协议对拍要补的缺口）。

**1.3.3 shared-utils 的多入口结构**

`packages/shared-utils` 提供 `.` / `.browser` / `.node` / `.test/mockFactories` 四入口（`packages/shared-utils/package.json:9-50`），是"平台面分离"的现成范例：同一包内用入口分平台，避免平台代码互相拉入。移动端协议包可以继承这一模式（`.native` 入口）。

**1.3.4 plugin-sdk / plugin-import-claude-codex 的 src 直出**

这两个包直接 `main/types: src/index.ts`（无构建步骤，`packages/plugin-sdk/package.json:5-6`），说明仓库已有"纯 TS 包不做构建"的先例。协议包若只产 TS 类型 + 纯函数，可考虑 src 直出 + 生成产物直出，省掉 esbuild 步骤（见 3.4.4 论证）。

### 1.4 门禁基线现状

**1.4.1 快层（ci.yml，每次提交/PR）**

| job | 内容 | 预算 |
| --- | --- | --- |
| typecheck | 根脚本 7 段 tsc 直跑（`package.json:40`） | 20 min |
| lint | eslint + depcruise | 20 min |
| vitest-fast | `npm run test:coverage -- --project=unit`（覆盖率门禁 45/70/65/45 强制） | 20 min |
| audit | npm audit --audit-level=moderate | 20 min |
| engine-bindings-drift | 生成器重跑 + git diff | 10 min |
| cargo-deny / secret-scan / rust-check / rust-unit-fast | Rust 面 | 20 min |

**1.4.2 中层（ci-mid.yml，合并前）**

| job | 内容 |
| --- | --- |
| rust-test | `cargo test --workspace --locked`（L1–L4 全量） |
| clippy | `cargo clippy --workspace --all-targets` + 基线 ratchet 脚本 |
| test | vitest 全量（unit + integration + native-smoke 项目，不带覆盖率） |
| test:integration | F3 四目录（vitest.integration.config.ts） |
| machete | `cargo machete`（无用依赖检查） |
| e2e | Playwright 冒烟子集（5 个保护名单 spec） |
| knip / governance-baselines | 死代码 + unwrap/吞错/行数三基线 |

**1.4.3 慢层（ci-slow.yml，nightly）**：压力测试 / 全量 e2e / 基准。

**1.4.4 对整合的约束**：

1. 快层预算 ≤15 min、中层 ≤20 min（文件头注释，`ci.yml:1-10`、`ci-mid.yml:1-12`）。移动端新增 job 必须在此预算内——这是 5.4 CI 时长策略的前提。
2. 覆盖率的唯一门禁口径是根 vitest.config.ts（`vitest.config.ts:9-14` 的踩坑注释 + ci.yml vitest-fast 的注释），移动端 jest 若并入会带来"双阈值"混乱，必须独立（见 5.2）。
3. `paths-ignore` 机制存在（`ci.yml:16-24`），移动端目录移动幅度大时（初建阶段）可用路径过滤避免全量 CI 噪音，但**协议包与共享代码的变更不得被忽略**（它们是跨端契约，任何变更必须跑对拍门禁）。

### 1.5 可复用资产与整合缺口清单

**可直接复用**：

- 生成器模式（幂等 + 确定性 + CI 漂移门禁）——扩展而非重写。
- `development` 双轨 exports + `customConditions`——协议包沿用。
- multi-entry 平台分离模式（shared-utils 的 .browser/.node）——协议包沿用。
- lint-staged / husky / prettier / eslint 基础设施——对移动端 TS 代码直接生效（需补 RN 特定规则）。
- turbo 根任务图骨架——新增任务即可。
- workspace.lints / workspace.dependencies 模式——协议 crate 沿用。
- 基线 ratchet 脚本模式（check-*.mjs 系列）——协议对拍与移动端覆盖率可仿写。

**缺口（本方案要解决的）**：

1. workspaces 列表无移动端 app；turbo 任务图无 expo 任务定义。
2. shared-types 的 exports 条件（development）对 Metro 解析器不友好，且 shared-types 内含大量桌面端专属类型（事件面、session-workspace、插件契约），不适合整体拖给移动端。
3. 无跨端协议真源（engine-events.json 是"引擎→前端"单向契约，不含"客户端→引擎"请求协议与移动端消息协议）。
4. 无移动端测试框架接线（jest-expo / RN Testing Library 均未引入）。
5. 无协议一致性对拍（现状只锁 JSON↔TS，不锁 JSON↔Rust、不锁"两套生成器输出之间"）。
6. `.gitignore` 全局忽略 `*.json` / `*.mjs` / `*.txt`（`C:\Software\conex\.gitignore:357-361`），Expo 项目的 `app.json` / `eas.json` / `app.config.js` / `babel.config.js` 默认会被忽略——**必须加白名单**（见 10.5，这是一个会静默丢文件的高危坑）。
7. 根 `typecheck` 脚本是 7 段硬编码 tsc 直跑（`package.json:40`），移动端 tsconfig 加入后需要扩展为 8+ 段或重构为脚本驱动。

---

## 第 2 章 目标架构与多端拓扑

### 2.1 演进后的仓库树（目标形态）

```
C:\Software\conex\
├── package.json                     # workspaces 追加 apps/crish-mobile、packages/protocol-core
├── turbo.json                       # 追加移动端静态任务 + 包级 turbo.json 收窄
├── apps/
│   ├── crish-desktop/               # 不变（桌面 UI 消费方）
│   ├── agent-workbench/             # 不变（Tauri 壳）
│   └── crish-mobile/                # 新增：Expo app（React Native）
│       ├── app.json / app.config.ts # 需 .gitignore 白名单
│       ├── eas.json                 # EAS Build 配置（需白名单）
│       ├── jest.config.js / jest.setup.ts
│       ├── tsconfig.json            # extends 根 base，RN 放宽白名单
│       └── src/                     # 移动端 UI + 连接层 + 协议适配
├── packages/
│   ├── protocol-core/               # 新增：跨端协议包（真源产物 + 纯函数）
│   ├── shared-types/                # 现有（桌面端事件面保留，协议面迁至 protocol-core）
│   └── ...（其余不变）
├── crates/
│   ├── conex-types/                 # 现有（引擎事件注册表）
│   ├── protocol-core/               # 新增（可选：协议注册表 Rust 侧消费/校验）
│   └── ...
├── scripts/
│   ├── generate-engine-bindings.mjs # 现有
│   └── generate-protocol-bindings.mjs # 新增（协议注册表 → TS + zod）
└── .github/workflows/
    ├── ci.yml                       # 快层 + 移动端静态检查
    ├── ci-mid.yml                   # 中层 + 移动端 jest + 协议对拍
    ├── ci-slow.yml                  # 不变
    └── release-mobile.yml           # 新增：移动端发布（EAS 触发）
```

### 2.2 分层原则（内核共享层 / 平台适配层 / 应用层）

多端互通成功与否取决于依赖方向是否干净。本方案定义三层：

```
┌─────────────────────────────────────────────────────────┐
│ 应用层（各端独立）                                        │
│   apps/crish-desktop（React + vite + Tauri API）         │
│   apps/agent-workbench（Tauri 壳 + Rust 引擎宿主）        │
│   apps/crish-mobile（React Native + Expo API）           │
├─────────────────────────────────────────────────────────┤
│ 平台适配层（每端一个薄壳，只做协议↔平台 API 转换）          │
│   桌面：invoke/event 适配（现有 tauri-command-registry）  │
│   移动：WebSocket/HTTP 连接适配 + 本地缓存适配            │
│   服务端（未来）：WS/HTTP 服务适配                        │
├─────────────────────────────────────────────────────────┤
│ 内核共享层（跨端真源，禁止平台 API）                       │
│   packages/protocol-core：协议 schema + 纯函数 + 校验     │
│   packages/shared-types：引擎事件面 + 通用类型             │
│   packages/shared-utils：纯工具（按需，需审查无平台耦合）   │
│   crates/conex-types（+ 可选 protocol-core crate）：Rust 侧 │
└─────────────────────────────────────────────────────────┘
```

强制约束（由 depcruise / knip / 代码评审三层保证）：

1. **内核共享层不得 import 任何应用层与平台 API**：protocol-core 禁止出现 `@tauri-apps/*`、`react-native`、`expo-*`、`electron` 等依赖；其依赖只允许 `zod`（schema 用）与 `@crish/shared-types`（基础类型用，且只能是纯类型）。
2. **平台适配层禁止包含业务逻辑**：只做"协议对象 ↔ 平台调用"的机械转换；协议版本协商等有状态逻辑进 protocol-core 的纯函数。
3. **应用层可以依赖全部下层**，禁止反向。
4. depcruise 配置（根 `.dependency-cruiser.cjs`）需要补充规则：`packages/protocol-core` 不许依赖 `apps/**`；`apps/crish-mobile` 允许依赖 protocol-core / shared-utils（受限子集）但不允许依赖 `apps/crish-desktop`、`apps/agent-workbench`。

### 2.3 边界：Cargo workspace 与移动端的"无 Rust 关系"

**核心结论：移动端构建链与 Rust workspace 完全无交集。** 理由与边界如下：

1. **无 React Native 原生模块**：移动端通信走 WebSocket / HTTP 连到"桌面端引擎（或未来服务端）"，协议载荷是 JSON，在 JS 侧完成校验与解析。不引入 react-native 的 Rust bridge（如 uniFFI / jni 绑定），理由：桌面端引擎的职责是运行 Agent 循环，移动端定位为"遥控/伴生客户端"，把引擎进程部署进移动端是另一量级的架构决策，超出本方案范围。
2. **Cargo workspace 的成员边界**：Rust 侧协议校验（若实现）以 `crates/protocol-core`（或复用 conex-types）形式存在，只服务于 agent-workbench 壳与未来服务端，mobile 目录内**不会出现任何 Cargo.toml**。
3. **turbo 的任务图边界**：turbo 不感知 Cargo（`Cargo.toml` 不在 turbo 任务图内；cargo 任务由 .github/workflows 的 setup-rust-toolchain job 直跑，`ci.yml:127-135`）。移动端 app 的 turbo 任务（typecheck/test/lint）是纯 npm 脚本，不会意外触发 Rust 编译。
4. **共享真源边界**：协议注册表 JSON 位于 `crates/conex-types/contracts/`（Rust 仓库域）还是 `packages/protocol-core/contracts/`（JS 仓库域）——本方案推荐**注册表物理放在 crates 域、生成器输出进 packages 域**（与 engine-events.json 现状一致，`generate-engine-bindings.mjs:24-39`），这样 Rust 侧实现可以天然消费同一 JSON；移动端只消费 packages 域生成产物。若未来引入服务端 crate，同样消费同一注册表，不需要第三个真源。

### 2.4 多端拓扑（运行时视角）

```
桌面端（含引擎）
  apps/agent-workbench（Tauri 壳 + Rust 引擎）
    └── 引擎 WebSocket/HTTP 服务端口（dev: 127.0.0.1:PORT，见第 6 章）
         ├── 桌面 UI（同机浏览器，vite dev 5174）
         └── 移动端 app（真机/模拟器）── LAN 或隧道 ──┘
服务端（未来，可选）
  crates/crish-server + apps/crish-server（或独立部署）
    └── 同一协议（协议版本协商见 7.4）
```

通信协议在两端都经过 protocol-core 的解析器：桌面端发送前序列化、接收后校验；移动端同样。**协议校验不在适配层做"私房逻辑"，两端共用同一套生成器产物语义**（TS 侧两端共用同一 npm 包，是字面上的同一份代码；Rust 侧用同一注册表 JSON 生成/手写对拍测试，见 5.3）。

---

## 第 3 章 Workspace 结构演进（任务 1）

### 3.1 Expo 进入 npm workspaces：官方最佳实践查证结论

本章先给出查证结论（webfetch 来源与完整引用见附录 A），再落成具体配置。

**查证结论 A1（Expo 官方 monorepo 指南，2026-06 修订版）**：

1. Expo 对 monorepo 是**一等公民支持**，官方支持 npm workspaces（与 Bun/pnpm/Yarn 并列，来源：Expo docs /guides/monorepos）。
2. **SDK 52+ 起自动检测 monorepo**：只要仓库根有 workspace 配置，Expo 自动配置 Metro；官方明确要求**删除**手写的 `metro.config.js` 中的 `watchFolders` / `resolver.nodeModulesPath` / `resolver.extraNodeModules` / `resolver.disableHierarchicalLookup`（迁移后首次 `npx expo start --clear` 清一次 Metro 缓存）。结论：**我们不需要写传统 monorepo Metro 配置**，只需 `npx expo start --clear` 一次。
3. 官方推荐的目录形态就是 `apps/*` + `packages/*` + 根 package.json（与 crish 现状完全一致）。
4. 工作区依赖建议用 `"cool-package": "*"`（npm 支持 `workspace:*` 但官方示例用 `*`；npm 的 `workspace:*` 仅在 npm 9+ 支持）。仓库现状用的是 `file:` 相对路径（`apps/crish-desktop/package.json:20`），见 3.5 的统一论证。
5. **重复依赖红线**：monorepo 内不允许重复 React Native 版本；重复 React 版本在单 app 内必炸；重复 Turbo/Expo modules 版本可能运行期报错。检查命令 `npm why react-native`。
6. **SDK 54+ 支持 isolated 依赖安装**（pnpm 默认）；npm 的 hoisted 布局是 Expo 的传统兼容面，我们**保持 npm hoisted 不迁移**（SDK 53 之前还推荐关闭 isolated；我们 npm 无此问题）。
7. **SDK 55+ 在 monorepo 中自动启用 `experiments.autolinkingModuleResolution`**，保证 Metro 解析的 JS 依赖与原生 autolinking 一致。
8. 本机（Windows）限制：iOS 构建需要 macOS（EAS 云构建可绕开，见第 7 章）。

**查证结论 A2（Turborepo 官方文档）**：

1. Turbo 文档没有 React Native / Expo 的专用指南页（llms.txt 全量索引核对：无 RN/Expo 页面；只有通用框架页与工具页），说明"turbo 调度 expo"没有官方一等公民模式，按通用任务声明处理即可。
2. "多语言支持"指南（Multi-language）给出通用范式：非 JS 生态（示例是 Go，Rust 同理）通过"workspace 内加一个 package.json 包边界 + turbo 只调度脚本、工具链自行解析"整合。**Cargo workspace 与 turbo 的关系照此范式**（第 8 章展开）。
3. "处理平台差异"指南：turbo 缓存哈希默认不含 OS/arch；跨平台 CI 复用缓存需要显式把平台键写入 inputs。**对 expo 的意义**：expo 相关任务的输出若进 turbo 缓存，会在 Windows 本机与 Linux CI 之间串台——方案选择"expo 原生产物不进 turbo 缓存"（3.3）就是依据此条。
4. 包级 `turbo.json`（`extends: ["//"]` + 本包任务覆盖）是官方推荐的收窄手段（Multi-language 指南的 Go 示例即用包级 turbo.json 声明包专属 outputs）。

**落地结论**：

- Expo SDK 建议锁定 LTS 线（任务书写到时点的最新稳定 SDK，例如文档示例中的 SDK 57 线），移动端 app 的 react/react-native 版本必须与 expo 模板绑定（expo 安装器决定），**不得手工浮动版本**（duplicate 红线）。
- 不写传统 monorepo metro.config.js；只保留一个极简 metro.config.js（显式使用 `expo/metro-config` 的 getDefaultConfig 且不加 watchFolders），或干脆不建该文件（SDK 52+ 自动行为）。落地时以 `npx expo install --fix` 的自检为准。
- 仓库保持 npm hoisted；根 `overrides`（现有 `esbuild` override，`package.json:85-87`）可扩展用于强制单版本 react/react-native（若出现重复）。

### 3.2 移动端 app 的放置与 package.json 设计

**3.2.1 目录与命名**

- 位置：`apps/crish-mobile`（与 `apps/crish-desktop`、`apps/agent-workbench` 并列）。
- 包名：`@crish/crish-mobile`（与 `@crish/crish-desktop` 命名规则一致，`apps/crish-desktop/package.json:2`）。
- 创建方式：官方推荐 `npx create-expo-app@latest --template default apps/crish-mobile`（在仓库根执行后它会自动感知 monorepo）。**注意**：模板自带的 `.gitignore`、`node_modules`、锁文件行为要按仓库规则清理（仓库锁文件是根级 `package-lock.json`；模板生成的子锁文件应删除）。
- `.gitignore`：模板生成的 app 内 `.gitignore` 与仓库根 `.gitignore` 合并维护；新增 `.expo/`（Expo dev 缓存）、`ios/`、`android/`（若用 CNG 工作流，原生目录不进库，见 7.2）。

**3.2.2 package.json 目标形态**

```json
{
  "name": "@crish/crish-mobile",
  "version": "0.1.0",
  "private": true,
  "main": "expo/AppEntry.js",
  "scripts": {
    "start": "expo start",
    "dev": "expo start",
    "dev:android": "expo start --android",
    "dev:ios": "expo start --ios",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "jest",
    "test:coverage": "jest --coverage",
    "lint": "eslint src --max-warnings 0",
    "prebuild": "expo prebuild"
  },
  "dependencies": {
    "@crish/protocol-core": "file:../../packages/protocol-core",
    "expo": "~57.0.0",
    "expo-status-bar": "~*",
    "react": "19.2.3",
    "react-native": "0.86",
    "react-native-safe-area-context": "~*",
    "react-native-screens": "~*",
    "@react-native-async-storage/async-storage": "*",
    "zustand": "^5.0.14"
  },
  "devDependencies": {
    "@types/jest": "^29.*",
    "jest": "^29.*",
    "jest-expo": "~*",
    "@testing-library/react-native": "^12.*",
    "typescript": "^5.9.2",
    "eslint": "^9.*",
    "eslint-config-expo": "~*"
  }
}
```

要点：

1. 版本号以 `npx create-expo-app` 模板实际生成的为准（示例数字仅示意，落地时用模板值，见附录 A 的 sdk-57 示例）。
2. `main: "expo/AppEntry.js"` 是 Expo 默认入口，保留模板原样。
3. `react` / `react-native` 版本由 expo 决定，**不得使用仓库根已有的 react 19 直接复制**——桌面端是 web React 19，移动端是 RN 绑定的 React 版本，两者版本可不同但**必须各自单实例**（duplicate 红线：`npm why react` 校验根 hoisted 区只有一个 RN 版本）。
4. `zustand` 复用桌面端状态管理库（`apps/crish-desktop/package.json:49`），减少心智负担；但移动端 store 只放连接/会话等轻状态，协议逻辑仍在 protocol-core 纯函数。
5. `expo-status-bar`、`react-native-safe-area-context`、`react-native-screens` 等模板标配，按 `npx expo install` 自动对齐版本。
6. **不引入** `@tauri-apps/*`（移动端没有 Tauri）；**不引入** 桌面端 tiptap/xterm 等桌面专属依赖。

**3.2.3 移动端 app 不依赖 agent-workbench / crish-desktop**

依赖图上移动端只允许依赖：`@crish/protocol-core`、`@crish/shared-utils`（经审查的子集，如 bounds/retry/backpressure 纯函数）、`@crish/shared-types`（仅纯类型面，如 ISO8601Timestamp、错误码）。depcruise 规则落地见 2.2 的约束 4。

### 3.3 turbo 与 Expo 的兼容：任务图设计

**3.3.1 原则：turbo 只管 JS 侧可哈希任务，expo 原生产物不进缓存**

turbo 的缓存价值在于"输入 → 输出"确定性。Expo 的任务分成三类：

| 任务 | 是否进 turbo | 理由 |
| --- | --- | --- |
| `typecheck`（tsc） | 进 | 确定性，可哈希 |
| `lint`（eslint） | 进 | 确定性 |
| `test`（jest） | 进 | 确定性 |
| `expo start`（dev） | **不进**（turbo 不调度 dev 任务，见下） | 长驻进程，turbo 无意义 |
| `expo export`（JS bundle 产物） | **不进**（可选进，默认不进） | 产物随 SDK/平台面变化，且主要消费方是 EAS 云构建，本机缓存价值低；若进缓存必须把 SDK 版本与平台键写入 inputs（依据查证 A2-3 的平台哈希问题） |
| `expo prebuild` / `expo run:*`（原生） | **不进** | 生成 ios/android 原生目录，平台相关、改动大、且 CNG 工作流下原生目录不入库 |
| EAS Build | **不进**（在 EAS 侧执行） | 云构建，与 turbo 无关 |

**3.3.2 根 turbo.json 的演进**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".tsbuildinfo"] },
    "build:types": { "dependsOn": ["^build:types"], "outputs": ["dist/**/*.d.ts"] },
    "build:js": { "dependsOn": ["^build:js"], "outputs": ["dist/**/*.js"] },
    "test": { "dependsOn": ["build"], "outputs": [] },
    "lint": { "outputs": [] },
    "typecheck": { "dependsOn": ["build:types"], "outputs": [] },
    "clean": { "outputs": [] }
  }
}
```

根任务图**只新增语义上无歧义的任务**，Expo 的专属任务在包级 turbo.json 声明：

- 根任务：不新增 `mobile:*` 之类的跨包任务（turbo 的任务是"同名任务在图内传播"，移动端 test/lint/typecheck 与桌面端同名任务天然并行；**不建议**在根加 `dev` 任务，turbo 官方建议 dev 长驻进程不进任务图，见 6.3 用 npm 脚本编排）。
- `test` 任务对 apps/crish-mobile 的语义：jest 直跑。**注意**：根 `test` 任务 `dependsOn: ["build"]`（`turbo.json:16-19`）——移动端没有 build 产物，`dependsOn` 会尝试跑 `^build`（即依赖包的 build）。protocol-core 若声明了 build 脚本则正常；移动端自身的 `build` 若未声明，`turbo run test --filter=@crish/crish-mobile` 会因任务缺失报错（turbo 2.x 的 missing-root-task 语义）。处理：**在移动端 package.json 显式声明空 build 脚本或包级覆盖 test 的 dependsOn**。

**3.3.3 包级 turbo.json（移动端与协议包）**

```json
{
  "extends": ["//"],
  "tasks": {
    "test": { "dependsOn": [], "outputs": [] },
    "typecheck": { "dependsOn": [], "outputs": [] },
    "lint": { "outputs": [] }
  }
}
```

- `dependsOn: []`：显式切断"test 依赖 build"的传播（移动端无 build 任务；protocol-core 的测试要等它自己的 build:types？——不，protocol-core 用 development 条件 src 直出后，测试直接跑 src，不需要 build，见 3.4.4）。
- 依据查证 A2-4：包级 turbo.json 是官方推荐的收窄手段。

**3.3.4 构建隔离与缓存串台防护**

1. `.turbo` 缓存目录已在根 `.gitignore`（`C:\Software\conex\.gitignore:408`）。
2. 移动端 typecheck 的 tsbuildinfo 输出到 `apps/crish-mobile/node_modules/.cache/`（对齐 crish-desktop 模式，`apps/crish-desktop/tsconfig.app.json:4`），避免污染根缓存。
3. 若未来决定让 `expo export` 进 turbo 缓存，必须在任务 inputs 里加入平台键（依据查证 A2-3 的 `turbo-cache-key.json` 模式），且 CI 与本机 OS 不同（Windows 本机 / Linux CI）会导致缓存失效率上升——本方案默认不进。

### 3.4 新增共享包：协议包从 shared-types 派生还是新建

**3.4.1 决策结论：新建 `packages/protocol-core`，从 shared-types 派生（抽）而非复制**

| 维度 | 方案 A：新建 protocol-core（推荐） | 方案 B：shared-types 扩容 | 方案 C：手写双份（不采用） |
| --- | --- | --- | --- |
| 真源 | 单一（注册表 + 生成器 → protocol-core） | shared-types 膨胀为"桌面事件面 + 移动协议面"混合 | 桌面/移动各自维护 |
| 依赖面 | 移动端只依赖轻量协议包，不触碰桌面事件面 | 移动端被迫依赖整个 shared-types（含 session-workspace 等桌面布局类型） | 无共享 |
| 构建/解析 | 与 Metro 的兼容面小（exports 结构按 Metro 兼容设计） | 现有 exports 的 development 条件与 Metro 冲突要逐个处理 | — |
| 演进 | 协议版本独立演进，桌面事件面稳定不动 | 协议变更与桌面类型变更混在一起提交 | 漂移必然 |
| 维护成本 | 多一个包（生成器产出，几乎零手写） | 零新增包但 import 面失控 | 双份维护 |
| 与现有架构的契合 | 契合"生成器 → 包"模式（engine → shared-types/generated 同构） | 契合"大而全 shared-types"现状 | 违反单一真源原则（AGENTS.md 严禁补丁精神） |

派生方式（避免复制）：

1. **盘点 shared-types 中属于"跨端协议面"的类型**：候选 = `message.ts` 的 AgentMessage 系、`errors/codes.ts` 的错误码、`session-identity.ts`、`run-control.ts`、`orchestration.ts` 的会话/运行状态、`stored-event.ts` 的协议版本常量、`primitive-types.ts` 的基础 JSON 类型。
2. **迁移路径**：先把这些类型在 shared-types 内标记（或直接抽出到 protocol-core），shared-types 从 protocol-core re-export 以保持桌面端现有 import 面不变（兼容垫层，一次性迁移后删除垫层）。具体拆分配置（哪些类型归协议面）由实现任务书按共享面清单（4.1）决定，本方案给出**判定准则**：类型只要被移动端消费即为协议面；只被桌面/引擎消费则留 shared-types。
3. **不搞双份**：同一类型不出现两份定义（哪怕一个 re-export 一个自持）。

**3.4.2 protocol-core 的包结构设计**

```
packages/protocol-core/
├── package.json
├── tsconfig.json / tsconfig.build.json
├── contracts/
│   └── mobile-protocol.json        # 协议注册表（真源；生成器输入）
├── src/
│   ├── index.ts                    # barrel（development 条件 src 直出）
│   ├── generated/                  # 生成器输出（入库，CI 漂移门禁锁）
│   │   ├── types.ts                # 协议载荷类型
│   │   ├── schema.ts               # zod schema（运行时校验）
│   │   ├── parser.ts               # 纯校验函数（或由 schema 派生）
│   │   ├── versions.ts             # 协议版本常量（由注册表 schemaVersion 派生）
│   │   └── index.ts
│   ├── state-machine/              # 审批状态机纯函数（手写，带测试）
│   │   ├── approval.ts
│   │   └── approval.test.ts
│   └── wire/                       # 序列化/解析组合层（薄）
└── tests/
    └── fixtures/                   # 协议样例（对拍测试输入，见 5.3）
```

**3.4.3 package.json 目标形态（protocol-core）**

```json
{
  "name": "@crish/protocol-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "files": ["src"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\""
  },
  "dependencies": {
    "zod": "^3.25.76"
  }
}
```

**3.4.4 构建策略：src 直出（无 build 步骤）**

关键决策与论证：

- protocol-core **不做 dist 构建**，走 `main/types: src/index.ts` 直出（对齐 plugin-sdk / plugin-import-claude-codex 先例，`packages/plugin-sdk/package.json:5-6`）。理由：
  1. 消费方都是 monorepo 内 app，bundler（vite / Metro）都能解析 src TS。
  2. 生成产物本身是确定性文本，入库即可，无需再构建。
  3. 桌面端 vite 的 `customConditions: ["development"]` 与 Metro 的解析差异（1.3.1 提到的坑）在"无 exports 条件、直接 src 直出"下不存在——**Metro 对无条件 exports 包按 main 字段解析，src/index.ts 直出对两端都最稳**。
- zod 依赖：桌面端已在用 zod（`apps/crish-desktop/package.json:49`、`packages/shared-types/package.json:32`），移动端 Hermes/RN 的 zod 兼容性成熟，复用零成本。
- 若未来要发布 protocol-core 到 npm 或供服务端（Node 直跑），再补 build:js（esbuild，复用 shared-types 模式，`packages/shared-types/package.json:28`）——按需引入，不在首期。

**3.4.5 协议注册表（contracts/mobile-protocol.json）**

协议注册表是跨端协议的真源，形态对齐 engine-events.json（`crates/conex-types/contracts/engine-events.json` 的模式：contract 名 + schemaVersion + 类型/枚举/消息注册）。首期内容：

1. **消息面**：`client→engine` 请求（session list/switch、approve/reject、pause/resume、message send、health check、config get/set 等）与 `engine→client` 推送（session-updated、approval-requested、message-appended、run-status-changed 等）。字段校验规则沿用 engine-events.json 的强校验风格（number 必须 integer 标记、枚举值全覆盖等，`generate-engine-bindings.mjs:87-167`）。
2. **类型面**：移动端需要的最小载荷类型（会话摘要、审批请求、消息片段、运行状态），不含桌面端渲染细节（split layout 等）。
3. **版本面**：`schemaVersion`（注册表内部 schema）+ `protocolVersion`（对外兼容版本，单调递增，变更规则见 7.3）。
4. **生成器**：`scripts/generate-protocol-bindings.mjs`（4.3 详述）。

### 3.5 workspaces 列表更新与 npm 链接语义

**3.5.1 workspaces 声明演进**

```json
"workspaces": [
  "apps/crish-desktop",
  "apps/agent-workbench",
  "apps/crish-mobile",
  "packages/plugin-import-claude-codex",
  "packages/plugin-sdk",
  "packages/protocol-core",
  "packages/shared-types",
  "packages/shared-utils",
  "packages/test-utils"
]
```

两个可选演进（首期不采用，登记为后续增强）：
- 通配符化 `apps/*` + `packages/*`：新包免改根文件，但会**意外纳入非 workspace 目录**（如参考类目录）；仓库既有显式列表文化（含 Cargo members 也是显式的），保持显式。
- 移出 `apps/crish-mobile` 的 `node_modules` 独立安装（nohoist）：npm 的 hoisted 布局天然支持，不建议首期特调（增加依赖管理复杂度，且 Expo SDK 52+ 已不需要）。

**3.5.2 file: 依赖 vs workspace:\***

现状：包间依赖用 `file:../../packages/...`（`apps/crish-desktop/package.json:20`、`packages/plugin-import-claude-codex/package.json:10`）。npm 11 支持 `workspace:*` 协议。论证：

| 方式 | 优点 | 缺点 |
| --- | --- | --- |
| `file:`（现状） | 已生效；对 Metro/vite 无解析歧义 | 版本字段无联动语义；npm install 时文件复制语义（npm 对 file: 的 workspace 内链接有优化，但不保证 symlink） |
| `workspace:*` | 语义清晰；npm 9+ 支持；与 workspace 结构绑定 | 与仓库现状不一致，需全仓迁移 |

决策：**首期沿用 `file:` 一致性**（移动端依赖 protocol-core 用 `file:../../packages/protocol-core`），不引入混合风格；全仓统一迁移 `workspace:*` 登记为后续增强（单独任务，风险低收益中）。

**3.5.3 根脚本演进**

- 现有 `typecheck`（7 段 tsc 直跑，`package.json:40`）扩展为 9 段（+ mobile tsconfig + protocol-core tsconfig）。**维护性风险**：段数继续增长时重构为脚本驱动（`scripts/typecheck.mjs` 读固定清单）或改用 `turbo run typecheck`（但现有注释说明 G7 统一口径是"根脚本直跑"与 turbo 等价——`ci.yml:44-46`）。本方案建议：**保持根脚本直跑风格**，追加移动端段；当段数超过 12 段时再重构。
- 新增根脚本（见 6.3 完整清单）：`dev:mobile`、`typecheck:mobile`、`test:mobile`、`check:protocol`（协议对拍，5.3）。
- lint-staged 无需改（glob 匹配已覆盖 apps/**/src/**/*.ts）。

### 3.6 Cargo workspace 边界与 members 更新（首期）

**3.6.1 首期边界结论**

- **首期 Cargo workspace 零改动**：移动端通信协议先在 JS 侧落地（protocol-core + 生成器），Rust 侧协议校验/序列化由 agent-workbench 壳的既有路径承载（Tauri IPC 已把事件 JSON 化，`conex-types` 的事件面已与 TS 对拍——engine-bindings-drift 门禁锁 JSON↔TS，`ci.yml:99-110`）。
- 新增 Rust crate 的触发条件（第 8 章详述）：① 出现独立于 agent-workbench 的服务端/守护进程；② 需要在 Rust 侧做协议版本协商与拒绝服务（对恶意客户端防御）。两个条件都不满足时**不新建 crate**（YAGNI + workspace 膨胀控制，现状 16 个成员已不少，`Cargo.toml:2-20`）。
- 移动端目录内保证无 Cargo.toml（2.3 边界）。

**3.6.2 若未来新增 crate 的 members 形态（预告）**

```toml
members = [
    # ... 现有 16 项 ...
    "crates/conex-protocol",   # 新增：协议注册表 Rust 侧（可选）
]
```

依赖策略：走 `workspace.dependencies` 新增 `conex-protocol` 路径依赖 + 在 agent-workbench 壳或服务端 crate 引用；lint 继承 workspace.lints（`Cargo.toml:11-13` 的 `[lints] workspace = true` 模式）。完整论证见第 8 章。

---

## 第 4 章 共享代码策略（任务 2）

### 4.1 跨端共享面清单

先定义"跨端共享什么"，再定"如何共享"。共享面按稳定度与移动端消费需求分三层：

**第一层：协议与契约（必须共享，单一真源）**

| 共享项 | 形态 | 真源 | 移动端消费方式 |
| --- | --- | --- | --- |
| 引擎事件类型（EngineEvent 系） | TS 标签联合 + parser | engine-events.json（现有） | **只消费只读面**（事件展示/通知）；**不消费**事件 parser 的完整背压语义面（那是桌面 EventRouter 的面，`packages/shared-types/src/generated/engine/`）。若移动端需要事件解析，直接复用 shared-types 现有 generated parser（同一 npm 包，字面同码） |
| 移动端协议消息（请求/推送） | TS 类型 + zod schema + parser | mobile-protocol.json（新增） | 全部（连接层校验/序列化） |
| 错误码与错误载荷 | TS 枚举 + 序列化函数 | shared-types errors 面（现有，`packages/shared-types/src/errors/`） | 直接复用；移动端展示错误与重试策略依赖同一套 code→语义映射 |
| 协议版本常量 | TS 常量（protocolVersion/minProtocolVersion） | mobile-protocol.json schemaVersion 派生 | 握手与协商（7.4） |

**第二层：审批状态机纯函数（共享）**

| 共享项 | 形态 | 真源 | 移动端消费方式 |
| --- | --- | --- | --- |
| 审批状态机（approval 请求 → 用户决策 → 结果回执 的有限状态机） | 纯函数 reducer + 守卫函数（无 IO） | protocol-core/src/state-machine/approval.ts（手写 + 单测） | 移动端"审批面板"的 UI 状态与桌面端 UI 状态用同一 reducer 推演，保证两端对"当前可操作项"的判断一致（例如同一审批请求在两端看到的按钮可用性一致） |
| 会话/运行状态机（idle/running/paused/awaiting-approval 等） | 纯函数（或由 shared-types 的 RunStatus/SessionStatus 联合收窄） | protocol-core（新）或 shared-types 既有 | 移动端会话列表/详情状态渲染 |
| 背压/重试纯函数 | shared-utils 既有（retryWithBackoff、TokenBucket 等，`packages/shared-utils/src/index.ts:25,104`） | shared-utils（现状） | 移动端连接重连策略直接复用（无平台耦合审查后） |

**第三层：跨端 UI 样式与组件（首期不共享，登记后续）**

- 桌面端 tiptap/xterm/DOM 渲染链与 RN 完全异构；首期不共享 UI。若后续要"移动端查看桌面端渲染结果"，走协议层传结构化数据（消息块，`packages/shared-types/src/message.ts` 的 AgentMessageBlock 系），移动端自行渲染。

**明确不共享（边界）**：桌面端 store（zustand store 含 Tauri invoke 依赖）、事件路由（EventRouter）、Tauri IPC schema（`packages/shared-types/src/validators/ipc-schemas.ts` 是 Tauri 专用面，移动端无 invoke）。

### 4.2 共享方式选择矩阵

| 方式 | 适用场景 | 仓库现状 | 本方案态度 |
| --- | --- | --- | --- |
| **npm 包（workspace 内）** | 跨 app 复用的类型/函数 | shared-types / shared-utils / plugin-sdk 已如此 | **主力**：protocol-core 即新 npm 包 |
| **生成器（注册表 → 代码）** | 跨语言契约（Rust ↔ TS）、需要强一致性保证的协议 | engine-events.json → generated/engine | **协议面的唯一手段**：移动协议消息、版本常量、跨语言对拍 |
| **手写双份** | 任何场景都不应该 | 无（现有都是单份） | **禁止**：违背单一真源；双份必然漂移，漂移在移动端表现是"解析失败/静默丢字段"这类最恶劣的线上缺陷 |
| **共享后端 API（HTTP/WS 服务）** | 未来服务端面 | 无 | 登记后续：若服务端出现，协议包自动升级为"客户端-服务端"共享契约，机制不变 |

组合决策：

1. **类型面走 npm 包**（development 条件直出或 src 直出）：mobile 依赖 protocol-core 如 3.4.4。
2. **协议消息面走生成器**：mobile-protocol.json → TS 类型 + zod schema + parser（4.3）；Rust 侧对拍（5.3）。
3. **纯函数走 npm 包**：审批状态机在 protocol-core 内手写（有单测、无平台依赖），因为状态机语义是"产品决策"而非"机器可读契约"，手写 + 强单测比注册表表达更可维护。**这里"手写"特指 protocol-core 内写一份 + 单测锁定，不是"桌面一份移动一份"**。
4. **版本常量走生成器派生**：`protocolVersion` 由注册表生成，禁止手写（防"代码改了注册表没改"的漂移）。

### 4.3 generate-engine-bindings 的扩展方案

**4.3.1 现状机制提炼（扩展模板）**

`scripts/generate-engine-bindings.mjs` 的关键设计（扩展时必须继承）：

1. 真源固定路径 + 输出固定文件集（`generate-engine-bindings.mjs:24-39`）。
2. 确定性输出：无时间戳/随机数，重复运行字节一致（`generate-engine-bindings.mjs:16-17`）。
3. 强校验：生成前 validateRegistry 全面校验（`generate-engine-bindings.mjs:87-167`），漏标 integer 等直接失败。
4. 文件头注明 GENERATED + 真源 + 生成器 + 再生成命令（`generate-engine-bindings.mjs:41-49`）。
5. CI 漂移门禁：重跑 + `git diff --exit-code`（`ci.yml:109-110`）。

**4.3.2 新增 `scripts/generate-protocol-bindings.mjs`（独立脚本，非改造原脚本）**

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 改造原脚本 or 新脚本 | **新脚本**（同风格复制骨架） | 原脚本契约面是 engine-events（背压、kindBackpressure 等引擎专属语义），塞入协议面会污染两个域的校验；两脚本共用 `scripts/lib/registry-utils.mjs`（抽取公共的 fail/校验辅助） |
| 输出目录 | `packages/protocol-core/src/generated/` | 与 shared-types/generated 同构（真源在 crates，产物在 packages） |
| 输出文件集 | `types.ts`（载荷类型）/ `schema.ts`（zod）/ `versions.ts`（协议版本）/ `index.ts`（barrel） | 对齐原四文件模式（events/types/parser/index），parser 由 zod 派生故不单出 parser.ts |
| parser 策略 | **zod schema 派生校验**（不再手写生成 parser） | 移动端与桌面端都消费 zod（桌面端已在用，`apps/crish-desktop/package.json:49`）；zod 的错误信息带字段路径（审批/错误展示需要）；原生成器的 ParseResult 手写风格是为零依赖设计的（`generate-engine-bindings.mjs:299-415`），协议面没有这个约束 |
| zod schema 生成 | 注册表类型 → zod 字面量链（z.string()/z.number().int()/z.discriminatedUnion） | integer 标记沿用注册表校验（number 必须声明 integer，继承原校验规则） |
| 幂等性 | 同原脚本（确定性、可重跑） | 继承 |

**4.3.3 生成器扩展的输入输出（伪代码形态）**

```text
输入：packages/protocol-core/contracts/mobile-protocol.json
  {
    "contract": "mobile-protocol",
    "schemaVersion": 1,
    "protocolVersion": "1.2.0",          // 对外协议版本（变更规则见 7.3）
    "minSupportedProtocolVersion": "1.0.0", // 本端能兼容的最低对端版本
    "messages": [                         // 消息注册（对齐 engine-events 的事件注册）
      { "id": 1, "type": "session-list-request", "role": "client→engine",
        "fields": [ { "name": "sessionId", "type": "string" } ] },
      { "id": 2, "type": "approval-decision", "role": "client→engine",
        "fields": [
          { "name": "approvalId", "type": "string" },
          { "name": "decision", "type": "enum:ApprovalDecision" },
          { "name": "note", "type": "string", "required": false }
        ] },
      { "id": 101, "type": "approval-requested", "role": "engine→client",
        "fields": [
          { "name": "approvalId", "type": "string" },
          { "name": "toolName", "type": "string" },
          { "name": "arguments", "type": "JsonValue" }
        ] }
    ],
    "types": { /* 载荷类型（struct/tagged/enum 三态，对齐原注册表） */ },
    "enums": { "ApprovalDecision": { "values": ["approve","reject","defer"] } }
  }

输出：packages/protocol-core/src/generated/
  types.ts    —— 消息接口 + 载荷类型 + 枚举常量（对齐原 types/events 风格）
  schema.ts   —— zod 对象链 + parseMobileMessage(v) 入口（discriminatedUnion by type）
  versions.ts —— PROTOCOL_VERSION / MIN_SUPPORTED_PROTOCOL_VERSION 常量
  index.ts    —— barrel
```

**4.3.4 生成器与现有 engine-bindings 的关系（无重复生成）**

- engine 事件面继续由 generate-engine-bindings.mjs 生成到 shared-types（桌面端消费），移动端需要时**直接 import 同一 generated 产物**（字面同码，无第二份）。这是"生成器单真源"的延伸：同一注册表、同一生成器、所有端消费同一产物。
- mobile-protocol 是**新增注册表**，与 engine-events.json 无重叠（引擎事件是"引擎→前端"遥测/结果流；mobile-protocol 是"客户端↔引擎"请求/审批面）。两个注册表之间通过共享基础类型（primitive-types 的 JsonValue、ISO8601Timestamp）保持类型一致，由 depcruise/knip 与类型测试共同锁定。

**4.3.5 审批状态机纯函数（protocol-core 手写 + 强单测）**

审批状态机示例形态（示意，最终由实现任务书定稿）：

```ts
// packages/protocol-core/src/state-machine/approval.ts（示意）
export type ApprovalPhase =
  | 'requested'      // 引擎发起审批请求（approval-requested）
  | 'awaiting-user'  // 已投递到至少一个端（桌面/移动），等待用户决策
  | 'decided'        // 用户已决策（approve/reject/defer），等待回执确认
  | 'confirmed';     // 引擎确认收到决策

export interface ApprovalState {
  approvalId: string;
  phase: ApprovalPhase;
  decidedBy: 'desktop' | 'mobile' | null;
  decision: 'approve' | 'reject' | 'defer' | null;
  decidedAtIso: string | null;
}

export type ApprovalAction =
  | { type: 'request-received'; atIso: string }
  | { type: 'delivered'; to: 'desktop' | 'mobile' }
  | { type: 'decision-made'; by: 'desktop' | 'mobile'; decision: 'approve' | 'reject' | 'defer'; atIso: string }
  | { type: 'decision-confirmed'; atIso: string };

export function reduceApproval(state: ApprovalState, action: ApprovalAction): ApprovalState { /* 纯 reducer */ }
```

**跨端一致性保证**：两端（桌面审批面板 / 移动端审批面板）共用 `reduceApproval` 推演 UI 状态，同一时刻同一 approvalId 的 phase/可操作项完全一致。配套单测（phase 迁移矩阵 + 非法迁移拒绝）跑在 protocol-core 的 vitest（桌面域）与移动端 jest（复测同一份源码，见 5.2 的"同源复测"机制）。

### 4.4 共享代码的发布与消费路径总结

```
Rust 侧（crates/conex-types 等）
  └── engine-events.json（真源 1，现有）
       └── [generate-engine-bindings.mjs] ──→ shared-types/src/generated/engine（桌面消费，字面同码给移动端复用）
packages/protocol-core/contracts/mobile-protocol.json（真源 2，新增）
       └── [generate-protocol-bindings.mjs] ──→ protocol-core/src/generated（桌面+移动端消费）
protocol-core/src/state-machine/*（手写纯函数，单测锁定）
  ├── 桌面端：import @crish/protocol-core
  └── 移动端：import @crish/protocol-core（同一 npm 包）
Rust 侧对拍：crates/conex-types 或协议 crate 读同一注册表 JSON 跑对拍测试（5.3）
```

---

## 第 5 章 门禁体系扩展（任务 3）

### 5.1 门禁分层模型（移动端加入后）

延续仓库"快层 ≤15 min / 中层 ≤20 min / 慢层 nightly"的分层（`ci.yml:1-10`、`ci-mid.yml:1-12`），移动端门禁按"风险暴露速度"插入：

| 层 | 移动端新增内容 | 预算 |
| --- | --- | --- |
| 快层（ci.yml） | mobile-lint（eslint + expo 规则）、mobile-typecheck（tsc strict）、mobile-test-fast（jest 关键套件，如协议/状态机/连接层单测，无覆盖率）、protocol-drift（生成器重跑 diff） | 快层总量预算放宽到 ≤20 min |
| 中层（ci-mid.yml） | mobile-test（jest 全量 + 覆盖率门禁）、protocol-parity（跨语言对拍，5.3.3） | 中层总量预算放宽到 ≤30 min |
| 慢层（nightly） | mobile-e2e（EAS/Detox 或 Maestro 冒烟，见 5.4）、移动端真机冒烟（可选） | 无硬预算 |

**重要决策：移动端测试不进根 vitest 门禁。** 理由：

1. vitest.config.ts 的 coverage 阈值对全部项目生效（根 coverage 块覆盖项目级，`vitest.config.ts:9-14` 踩坑记录），jest 的覆盖率口径（jest-expo + v8 provider）与 vitest 的 v8 口径在 include 面不同，混算无意义。
2. jsdom（vitest）与 RN 测试环境（jest-expo 的 react-native preset）不能在同一 runner 里干净共存；强行并入会让"改了移动端导致桌面 unit 红"的耦合发生。
3. 移动端与桌面端共用 protocol-core 的测试是"同源复测"：**代码一份，测试两跑**（协议包测试在 vitest（桌面域 CI job）与 jest（移动域 CI job）各跑一次）。这保证协议包既被桌面工具链覆盖也被 RN 工具链覆盖，但两者是独立 job、独立报告。

### 5.2 移动端测试门禁设计（jest-expo）

**5.2.1 技术选型：jest-expo + @testing-library/react-native**

- `jest-expo` 是 Expo 官方 jest preset（处理 RN 转译、mock native 模块、Hermes 相关配置），`@testing-library/react-native` 是 RN 组件测试标准库。
- 与桌面端 vitest 双轨并存，根 package.json 的 `test` 脚本语义不变（vitest 全量）；移动端测试入口为 `npm run test:mobile`（根脚本）与 app 内 `jest`。
- jest 版本选型：jest 29（jest-expo 对应版本以 expo SDK 模板锁定为准，落地时用 `npx expo install jest jest-expo` 对齐）。

**5.2.2 jest.config.js 目标形态（apps/crish-mobile）**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'node',            // RN preset 内部自选环境，不强制 jsdom
  moduleNameMapper: {
    '^@crish/protocol-core$': '<rootDir>/../../packages/protocol-core/src/index.ts',
    '^@crish/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts'
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)/)'
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/**/types.ts',
    '!**/generated/**'               // 生成物不参与覆盖率（有协议对拍门禁覆盖）
  ],
  coverageThreshold: {
    global: {
      statements: 60,
      branches: 75,
      functions: 70,
      lines: 60
    }
  }
};
```

要点：

1. `moduleNameMapper` 把 workspace 包映射到 src 直出（对齐 3.4.4 的 src 直出策略；**不映射到 dist**，避免"改了源码 CI 用旧 dist"的假绿）。
2. `transformIgnorePatterns` 是 RN 测试的经典配置（ESM 原生包白名单），以 jest-expo 模板默认值为准微调。
3. 覆盖率阈值 60/75/70/60 的论证在第 9 章；首期可对 UI 层豁免（`!src/ui/**` 暂不入 collect 面，协议/连接层全覆盖），随阶段推进收口。
4. **generated 目录排除覆盖率**：生成物由协议漂移门禁保证正确性，测覆盖率会把阈值稀释（生成物行数大、无常测用例）。协议包的解析/校验正确性由 protocol-parity 对拍（5.3.3）+ 抽样单测兜底。

**5.2.3 移动端测试层次（对齐仓库 L1–L4 分层文化）**

| 层 | 内容 | 工具 | 门禁归属 |
| --- | --- | --- | --- |
| M1 纯函数/协议 | protocol-core 状态机、连接层纯逻辑、注册表解析 | jest（同源复测 protocol-core 单测） | 快层 mobile-test-fast |
| M2 组件 | 审批面板、会话列表、设置项 | jest + @testing-library/react-native | 中层 mobile-test |
| M3 集成 | store + 连接层 + 组件渲染（mock WebSocket） | jest（mock 网络层） | 中层 mobile-test |
| M4 e2e | 真机/模拟器冒烟（启动→连桌面→看到会话→审批往返） | Maestro 或 Detox（slow 层） | 慢层 mobile-e2e |

### 5.3 协议一致性门禁（schema 漂移检查）

**5.3.1 目标与威胁模型**

要防的漂移有四类：

1. 注册表改了、TS 生成物没重跑（现有 engine-bindings-drift 已防，`ci.yml:99-110`——扩展到 protocol 面）。
2. TS 与 Rust 语义不一致（现状缺口：`ci.yml:95-98` 明确说"registry_drift 只锁 JSON↔TS，不锁 JSON↔Rust"）。
3. 桌面端与移动端消费不同版本的协议（同一 npm 包，理论上不可能，但锁文件/缓存异常下要防）。
4. 真源 JSON 与实现（events.rs）漂移（Rust 侧维护者改了 events.rs 忘更 JSON——engine-events.json 的维护纪律已建立，协议面继承）。

**5.3.2 门禁 1：生成物漂移（快层，protocol-drift job）**

复制 engine-bindings-drift 模式（`ci.yml:99-110`）：

```yaml
protocol-drift:
  runs-on: ubuntu-latest
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
    - run: npm ci
    - run: node scripts/generate-protocol-bindings.mjs
    - run: git diff --exit-code -- packages/protocol-core/src/generated
```

**5.3.3 门禁 2：跨语言对拍（中层，protocol-parity job）**

设计：同一注册表 JSON 为输入，TS 侧（zod parser）与 Rust 侧（serde 反序列化 + 手动契约测试）各跑同一组样例，两端对同一样例的接受/拒绝结论必须一致。

```yaml
protocol-parity:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: npm
    - uses: actions-rust-lang/setup-rust-toolchain@v1
    - run: npm ci
    - run: node scripts/generate-protocol-bindings.mjs   # 保证生成物为当前注册表状态
    - run: npx vitest run packages/protocol-core/tests/parity/*.test.ts   # TS 侧样例结论
    - run: cargo test -p conex-protocol-parity --locked   # Rust 侧样例结论（对拍 crate）
    # 对拍断言：两端对"有效/无效样例"结论表 diff（由测试输出 JSON 结论并比较）
    - run: node scripts/compare-parity-results.mjs dist/parity-ts.json target/parity-rust.json
```

- 样例集：`packages/protocol-core/tests/fixtures/`（有效样例 + 边界无效样例：缺字段、类型错、枚举超界、深嵌套、超大整数等），**样例集本身是入库资产**（对齐"测试是资产不是杂物"纪律）。
- Rust 侧实现：首期可以不做完整 serde 校验实现，只写"对拍夹具测试"（用 serde_json::Value 做形状断言），成本低收益高；等服务端出现再做完整校验库。**注意**：该对拍测试需要把样例跑在 Rust 侧，若首期不建协议 crate，可以把对拍放 conex-types 的测试模块（引用注册表路径）——具体由实现任务书定夺，门禁结构不变。

**5.3.4 门禁 3：移动端与桌面端共享包版本一致（中层，并入 mobile-test 的 sanity 断言）**

在 mobile-test job 里加一个断言：mobile 与 desktop 的 lockfile 解析出同一 protocol-core 版本（npm workspaces 单实例下天然成立，防的是 file: 依赖被意外发布版本替换）。实现：`npm ls @crish/protocol-core` 在根与 app 内输出一致（写成一个 `scripts/check-workspace-single-instance.mjs`，也顺带检查 react/react-native 单实例——直接响应查证 A1-5 的 duplicate 红线）。

**5.3.5 门禁 4：Rust 真源↔注册表（并入现有维护纪律 + 对拍样例）**

engine-events.json 由 events.rs 维护的纪律（文件头注释，`generate-engine-bindings.mjs:44`）扩展到 mobile-protocol.json：协议变更的 PR 必须同 PR 内包含注册表变更 + 生成物变更 + 对拍样例变更（CI 的 protocol-drift + protocol-parity 强制）。

### 5.4 CI 时长与移动端构建门禁

1. **快层不做移动端真机构建**：移动端"构建"（expo export / EAS）不进快层。快层只做 tsc + eslint + jest 快集（均 ≤5 min/步），保证"改一个 TS 错误 5 分钟内反馈"。
2. **中层也不做完整原生构建**（Android assemble / iOS xcodebuild 太贵）：中层做 `expo export --platform android/ios`（JS bundle 打包，验证 Metro 解析与 babel 配置，约 3-5 min）作为"构建冒烟"。原生编译验证留给慢层 nightly 或发布流水线（EAS 云构建天然是真实构建）。
3. **慢层（nightly）**：mobile-e2e（Maestro 冒烟）与可选的原生构建验证；新增 job 不挤占现有压力/e2e/基准资源（ci-slow.yml 现状不动，追加移动端 job）。
4. **路径过滤**：快层现有 `paths-ignore: docs/**|*.md|assets/**`（`ci.yml:16-24`）。移动端初建期可对纯 UI 改动加 `paths-ignore: apps/crish-mobile/src/ui/**` 之类的过滤？——**不建议**：协议/连接层与 UI 同仓，过滤规则容易漏掉跨层改动；移动端测试量小，全量跑快层成本可接受。保持无过滤。
5. **npm ci 时长**：node_modules 膨胀（10.2）会让每个 job 的 npm ci 变慢（当前 npm@11 冷缓存约 1-2 min/层）；对策见 10.2（workspace 依赖裁剪、cache 保留、必要时 job 拆分）。

### 5.5 门禁矩阵总表（移动端加入后）

| 门禁 | 层 | 触发 | 失败含义 | 预算 |
| --- | --- | --- | --- | --- |
| mobile-lint（eslint + expo config + prettier） | 快 | 全量路径 | 移动端代码风格/规则违规 | 3 min |
| mobile-typecheck（tsc strict） | 快 | 全量路径 | 类型错误 | 3 min |
| mobile-test-fast（jest 关键套件） | 快 | 全量路径 | 协议/状态机/连接层回归 | 5 min |
| protocol-drift（生成器重跑 diff） | 快 | 全量路径（注册表或生成器变更必触发） | 生成物未同步 | 2 min |
| mobile-test（jest 全量 + 覆盖率 60/75/70/60） | 中 | 合并前 | 回归/覆盖率不达标 | 10 min |
| protocol-parity（TS↔Rust 对拍） | 中 | 合并前 | 两端语义不一致 | 8 min |
| workspace-single-instance | 中 | 合并前 | 重复 react/react-native/协议包 | 1 min |
| mobile-build-smoke（expo export） | 中 | 合并前 | Metro 打包失败 | 5 min |
| mobile-e2e（Maestro 冒烟） | 慢 | nightly | 端到端流程坏 | 15 min |

---

## 第 6 章 本地开发流（任务 4）

### 6.1 桌面端开发现状

- 桌面 UI：`npm run dev:desktop` → vite dev server，端口 5174 且 strictPort（`apps/crish-desktop/vite.config.ts:207-210`），`envPrefix: ['VITE_', 'TAURI_']`（`apps/crish-desktop/vite.config.ts:246`）。
- Tauri 壳：`npm run dev:workbench` → `tauri dev`（壳内 `dev` 脚本先起 crish-desktop dev，`apps/agent-workbench/package.json:9`）。
- 引擎事件流：Rust 引擎 → Tauri event → 前端 EventRouter（桌面域现有机制）。

**移动端要连的是"引擎"而不是"桌面 UI"**。因此联合调试的第一个前提是：引擎的对外通信面（WS/HTTP 服务端口）存在且可配置监听地址。这是多端互通的设计前提（不在本方案实现范围，但 dev 流依赖它）。端口/协议约定由多端互通的整体设计（其他 D 系列方案）给出；本方案只定"如何连、如何配、如何组织脚本"。

### 6.2 联合调试拓扑

**拓扑一：模拟器（Android/iOS 模拟器，本机回环）**

```
引擎（agent-workbench dev，监听 127.0.0.1:8787，示例端口）
  └── WS ws://127.0.0.1:8787
        └── crish-mobile（模拟器）── Android 模拟器用 10.0.2.2 映射宿主机回环
        └── crish-desktop（同机浏览器）── 直接 127.0.0.1
```

- Android 模拟器访问宿主机必须用 `10.0.2.2` 而非 `127.0.0.1`（模拟器网络栈约定）；iOS 模拟器可直接 `127.0.0.1`。
- 引擎监听地址约束：dev 下监听回环即可被模拟器访问（`10.0.2.2` 是宿主机回环的映射）；真机场景需要监听局域网地址（拓扑二）。

**拓扑二：真机（局域网）**

```
引擎（监听 0.0.0.0:8787 或指定 LAN IP）
  └── WS ws://192.168.x.x:8787（移动端指向宿主机局域网 IP）
        └── crish-mobile（真机，同一 Wi-Fi）
```

- 引擎 dev 模式需要支持 `--listen 0.0.0.0:8787` 类参数（多端互通设计负责），并且 Windows 防火墙需放行该端口（Tauri dev 的默认行为只监听回环）。
- 备选：隧道方案（ngrok/cloudflared 或 Tailscale）用于跨网段调试，登记为进阶选项，不作为默认 dev 流。

**连接地址解析优先级（移动端）**：

1. 显式 env：`EXPO_PUBLIC_ENGINE_URL`（Expo 的 `EXPO_PUBLIC_*` env 会在 bundle 时内联，`npx expo start` 时读取 `.env`；注意 `.env` 已被根 `.gitignore` 忽略（`C:\Software\conex\.gitignore:21-24`），移动端 app 目录内的 `.env` 也按此处理——**dev 配置文件不入库，仓库内只放 `.env.example`**）。
2. 平台默认：Android 模拟器 `ws://10.0.2.2:8787`、iOS 模拟器 `ws://127.0.0.1:8787`。
3. 可编辑的设置页（运行时覆盖，存入 AsyncStorage）——真机场景免改 env 重打包。

### 6.3 dev 脚本组织（根 package.json 演进）

**原则**：根脚本做"编排"，app 内脚本做"实现"；联合调试一键起，单端调试独立起。

```json
{
  "scripts": {
    "dev:desktop": "npm --workspace @crish/crish-desktop run dev",
    "dev:workbench": "npm --workspace @crish/agent-workbench run tauri -- dev",
    "dev:mobile": "npm --workspace @crish/crish-mobile run start",
    "dev:mobile:android": "npm --workspace @crish/crish-mobile run dev:android",
    "dev:mobile:ios": "npm --workspace @crish/crish-mobile run dev:ios",
    "dev:joint": "node scripts/dev-joint.mjs",
    "dev:joint:mobile": "node scripts/dev-joint.mjs --mobile",
    "typecheck:mobile": "npm --workspace @crish/crish-mobile run typecheck",
    "test:mobile": "npm --workspace @crish/crish-mobile run test",
    "test:mobile:coverage": "npm --workspace @crish/crish-mobile run test:coverage",
    "check:protocol": "node scripts/generate-protocol-bindings.mjs && node scripts/check-workspace-single-instance.mjs"
  }
}
```

**dev-joint.mjs（联合调试编排脚本，新增）**：

- 职责：并行拉起引擎（`dev:workbench` 或引擎独立进程）+ 桌面 UI（可选）+ 移动端（可选），打印各端 URL 与连接提示，Ctrl+C 统一回收子进程。
- 实现要点：Node 子进程 spawn + kill tree（Windows 上需 taskkill /T）；不引第三方进程管理器（concurrently 类）保持零新增依赖（仓库倾向零依赖脚本，`scripts/` 现有脚本都是手写 Node，`scripts/dev-joint.mjs` 同风格）。
- **turbo 不参与 dev 编排**：dev 是长驻进程，turbo 任务图不适配（3.3.1 已论证）；turbo 的 `turbo watch` 虽可做增量编译，但协议包的 src 直出策略下无需 watch（移动端 Metro 直接解析 src，改动即时生效）。

**联合调试日常流（目标体验）**：

```bash
# 终端 A：引擎 + 桌面（或仅引擎）
npm run dev:workbench        # Tauri 壳：引擎 + 桌面 UI
# 终端 B：移动端
npm run dev:mobile           # expo start，扫码/选模拟器
# 或一键：
npm run dev:joint --mobile   # 引擎 + 移动端
```

**env 文件布局（dev 配置不入库）**：

```
apps/crish-mobile/.env.example    # 入库：EXPO_PUBLIC_ENGINE_URL 示例 + 注释
apps/crish-mobile/.env            # 不入库：本机覆盖（gitignore 已覆盖 *.env）
```

### 6.4 坑与对策（本地开发流）

| 坑 | 现象 | 对策 |
| --- | --- | --- |
| Metro 缓存滞后 | 改了 protocol-core src 不生效 | 首次接入后 `npx expo start --clear`；依赖变更时重启 Metro（Expo 官方推荐，查证 A1-2） |
| 引擎只监听回环 | 真机连不上 | 引擎 dev 参数支持 `--listen`（多端互通设计）；Windows 防火墙放行 |
| cleartext 限制 | Android 9+ 默认禁明文 HTTP/WS | dev 用 `usesCleartextTraffic`（expo 开发构建默认允许）或一律 `ws://` 仍属明文——expo 开发模式自带豁免，生产必须 `wss://`（7.2 发布时检查） |
| Expo Go 与开发构建差异 | Expo Go 不支持自定义原生模块 | 首期只用 Expo Go 可覆盖的能力（纯 JS）；引入原生模块时切 development build（`expo run:android`） |
| 引擎连接串写死 | 换了网络环境又要改代码 | 连接地址全部走 env/运行时设置（6.2），代码里零硬编码 |
| protocol-core 改了但某端没重启 | 两端行为不一致 | dev 脚本输出中提示"协议变更 → 两端重启"；CI 的 drift 门禁兜底（5.3.2） |
| Windows 上 expo start 端口占用 | 8081 被占用 | expo 自动 +1 端口；脚本里显式 `--port` 固定（如 8081），并在 dev-joint.mjs 输出提示 |

---

## 第 7 章 构建与发布（任务 5）

### 7.1 桌面端发布流程现状与槽位

- 桌面端现状：Tauri 壳（`apps/agent-workbench`）+ `tauri build` 产安装包（仓库无 release workflow 文件在快/中层内，发布流程走 Tauri 标准路径；本方案不改变桌面端发布机制）。
- 槽位：桌面端发布（tauri build + 平台签名 + 商店/自更新分发）与移动端发布在**工具链、节奏、审查**上完全不同，本方案将二者设计为**完全独立的流水线**，唯一共享输入是"协议版本兼容矩阵"（7.4）与共享包内容（同库同 commit）。

### 7.2 移动端发布流水线：EAS Build

**7.2.1 工作流形态（CNG，Continuous Native Generation）**

- 采用 Expo 的 CNG 工作流：`ios/`、`android/` 原生目录不入库（由 `expo prebuild` 生成），EAS Build 云构建按需生成原生工程。好处：CI 无原生环境依赖、签名/证书管理由 EAS 托管、Windows 本机也能发布 iOS（云构建在 macOS 上跑）。
- **Windows 上本地无法 `expo run:ios` / 无法 `eas build --platform ios` 本地运行**（需要 macOS）；但 `eas build --platform all --non-interactive` 可以触发云构建。团队内指定一台 macOS 为 iOS 本地调试机（或全部走云构建）。

**7.2.2 eas.json 目标形态**

```json
{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "ios": { "simulator": true }
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "ios": { "simulator": false }
    },
    "production": {
      "autoIncrement": true,
      "android": { "buildType": "app-bundle" },
      "ios": { "resourceClass": "m-medium" }
    }
  },
  "submit": {
    "production": {
      "android": { "serviceAccountKeyPath": "./secrets/google-service-account.json" },
      "ios": { "appleId": "…", "ascAppId": "…", "appleTeamId": "…" }
    }
  }
}
```

要点：

1. `appVersionSource: "remote"`：应用版本号从 EAS 侧维护（`eas init` 后的 app config 服务），避免 app.json 版本号与 CI 本地计算打架。
2. 三个 profile：development（内部联调，APK/simulator 构建）/ preview（内测分发，TestFlight/内部 track）/ production（商店提交，aab + 自动递增版本号）。
3. 证书与密钥：**一律不入库**（EAS 凭据服务 + GitHub Secrets），`secrets/` 目录必须进 `.gitignore`（根 .gitignore 已有 `.env` 系；补 `apps/crish-mobile/secrets/` 与 `.eas/`）。
4. `eas.json` 是 `*.json` 文件——**会被根 .gitignore 的 `*.json` 全局忽略规则吃掉**（`C:\Software\conex\.gitignore:357-359`），必须在 .gitignore 加白名单（10.5 重点项）。

**7.2.3 发布流水线（GitHub Actions：release-mobile.yml）**

```yaml
# .github/workflows/release-mobile.yml（示意）
name: Release · Mobile（EAS）
on:
  workflow_dispatch:
    inputs:
      profile: { type: choice, options: [development, preview, production], default: preview }
  push:
    tags: ['mobile-v*']          # 或 release branch 事件，见 7.5
jobs:
  build-and-submit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - uses: expo/expo-github-action@v8
        with: { eas-version: latest, token: ${{ secrets.EXPO_TOKEN }} }
      - run: npm ci
      - run: node scripts/generate-protocol-bindings.mjs   # 发布前确保生成物为当前注册表
      - run: npx eas-cli build --platform all --profile ${{ inputs.profile }} --non-interactive
      - run: npx eas-cli submit --platform all --profile ${{ inputs.profile }} --non-interactive
```

- 发布前自检（插入 build 之前）：`git diff --exit-code -- packages/protocol-core/src/generated`（生成物同步）+ `npm run typecheck:mobile` + `npm run test:mobile`（全量）。**发布流水线自带门禁，不依赖 PR 门禁的状态**（release 可以直接从 main tag 出发，跳过 PR 流程）。
- `EXPO_TOKEN` / `APPLE_APP_SPECIFIC_PASSWORD` / Android service account 等全部走 GitHub Secrets。

**7.2.4 桌面端与移动端发布的独立/联动总结**

| 维度 | 桌面端（现状不动） | 移动端（新增） |
| --- | --- | --- |
| 工具 | tauri build（本机/CI） | EAS Build（云） |
| 触发器 | 手动/release 流程（现状） | workflow_dispatch + tag |
| 审查 | 平台签名、自更新 | App Store / Play Console 审核 |
| 版本 | app 版本 0.1.x（现状） | app 版本独立 semver（EAS remote 维护） |
| 联动点 | 无硬联动；协议版本变更时，两端各自的发布都受 7.4 的兼容窗口约束 | 同上 |

**联动只在三个地方发生**：① 仓库内同一 commit 的共享包内容（同源）；② 协议版本兼容矩阵（7.4，发布检查清单）；③ 发布候选的"协议 smoke 测试"（发布流水线里对最新桌面版与最新移动版做一次对拍冒烟——实现上可用 protocol-parity 的样例集 + 两端真实构建产物）。

### 7.3 版本号策略

**7.3.1 三轨版本体系**

| 轨 | 载体 | 递增规则 | 归属 |
| --- | --- | --- | --- |
| 应用版本 | 桌面 0.1.x（package.json / tauri.conf.json）；移动 iOS CFBundleShortVersion / Android versionName | 各端独立 semver；移动端由 EAS remote 维护（autoIncrement） | 各端 |
| 协议版本 | `PROTOCOL_VERSION`（mobile-protocol.json 生成，`packages/protocol-core/src/generated/versions.ts`） | 独立单调递增；**仅协议语义变更时递增**，应用发版不强制递增 | 协议包（生成器） |
| 兼容窗口 | `MIN_SUPPORTED_PROTOCOL_VERSION`（同 generated/versions.ts） | 随支持策略调整 | 协议包（生成器） |

**7.3.2 协议版本变更规则（semver 语义，作用于协议而非应用）**

| 变更类型 | 版本段 | 示例 | 影响 |
| --- | --- | --- | --- |
| 向后兼容新增（新消息/新可选字段/新枚举值） | minor | 1.2.0 → 1.3.0 | 旧端无需升级；新字段 optional |
| 破坏性变更（删字段/改类型/改枚举语义） | major | 1.2.0 → 2.0.0 | 进入兼容窗口策略（7.4） |
| 修复（语义澄清，wire 不变） | patch | 1.2.0 → 1.2.1 | 无 wire 影响 |

**实施约束**（由生成器校验 + 评审双重保证）：

1. 注册表 `protocolVersion` 变更必须伴随 `schemaVersion` 的注册表结构变更？——不。`schemaVersion` 是注册表 JSON 文件格式的版本（`generate-engine-bindings.mjs` 的 `schemaVersion !== 1` 即拒绝，`generate-engine-bindings.mjs:91-93`），`protocolVersion` 是 wire 协议对外版本，两者解耦：注册表格式变不动 wire 时只升 schemaVersion；wire 语义变只升 protocolVersion。**在注册表校验里加一条：protocolVersion 每次变更必须在变更记录字段（changelog 数组或注释）里登记理由**（生成器 validate 阶段强制）。
2. 生成器输出 `versions.ts`，禁止任何端手写协议版本常量（4.2 组合决策 4）。

**7.3.3 应用版本与协议版本的关系**

- **不绑版本号**：不采用"应用版本号里嵌入协议版本"（如 1.2.0+proto1 之类），避免混淆且无收益。
- **绑发布产物**：每个发布构建把其 `PROTOCOL_VERSION` 写入应用设置页/诊断信息（移动端可在设置页显示"协议版本 1.3.0，最低兼容 1.0.0"），运营与排障可读。
- **CI 断言**：发布流水线在 build 前断言当前 commit 的 generated/versions.ts 与注册表一致（protocol-drift 门禁已在快层，发布流水线自带复跑）。

### 7.4 升级兼容：旧移动端连新桌面端（协议协商）

**7.4.1 握手流程（连接建立时）**

```
移动端(M)                                  桌面端引擎(E)
   │  connect                                    │
   │────────────────────────────────────────────▶│
   │  { protocolVersion: M.v,                    │
   │    minSupported: M.min,                     │
   │    capabilities: [...] }                    │
   │◀────────────────────────────────────────────│
   │  { protocolVersion: E.v,                    │
   │    minSupported: E.min,                     │
   │    agreed: M.v }                            │
   │  若 E.min > M.v → 拒绝 + 提示升级；          │
   │  若 E.v < M.min → 拒绝 + 提示降级引擎/升级指引│
```

**7.4.2 兼容矩阵与决策**

| 场景 | 判定 | 动作 |
| --- | --- | --- |
| M.v ≥ E.min 且 E.v ≥ M.min | 兼容 | 按 `min(M.v, E.v)` 的行为子集运行（feature negotiation：低版本一方的能力为上限） |
| E.v > M.v 且 E.min ≤ M.v | 新引擎 + 旧移动端 | 移动端只发旧版消息；引擎对旧客户端**仅推送旧版兼容消息**（server 侧做 downgrade 映射，或至少不推送新消息——**消息级防御**：对端不认识的消息必须可忽略，schema 校验用"未知字段容忍 + 未知消息类型丢弃"策略） |
| M.v > E.v 且 M.min ≤ E.v | 新移动端 + 旧引擎 | 移动端 feature-detect（capabilities 声明 + 对端应答中声明的支持面）；不依赖新消息 |
| M.v < E.min 或 E.v < M.min | 不兼容 | 连接失败 + 面向用户的升级/降级指引（错误码复用 shared-types errors 面的 ProtocolError，`packages/shared-types/src/errors/`） |

**7.4.3 设计约束（必须写进协议包与门禁）**

1. **未知消息容忍**：接收端解析器对"已注册类型之外的 type"返回"忽略"而非"连接失败"（zod parser 的 discriminatedUnion 对未知 tag 默认失败——需要在生成器里对 `engine→client` 方向加"未知消息忽略"包装，这是移动端解析器与桌面端解析器的一个**方向性差异**，生成器必须按 role 参数化）。**这一点若不做，旧移动端连新桌面端必炸**，是本方案 7.4 的核心实现约束。
2. **字段向后兼容纪律**：新字段必须 optional（注册表 required 标记默认 false，校验里强制"协议版本递增时不允许新增 required 字段"——生成器 validate 阶段可自动检查前后版本？跨版本 diff 需要基线快照，首期用评审纪律 + 样例集覆盖，登记后续增强为"版本 diff 校验"）。
3. **capabilities 声明**：注册表支持 `capabilities` 维度（如 `notifications`、`terminal`、`rich-message`），握手时交换，实现 feature negotiation 而不依赖版本号三元组——降低版本号膨胀压力。

**7.4.4 回归保障（把兼容矩阵变成测试）**

- protocol-parity 的样例集加入"跨版本样例"：`fixtures/v1/`、`fixtures/v2/` 两组，测试断言"v1 客户端解析 v2 消息（未知字段容忍）"与"v2 客户端解析 v1 消息（缺 optional 字段容忍）"。这组测试跑在协议包（vitest + jest 同源复测）与 Rust 对拍（5.3.3）两侧。
- 发布检查清单（release-mobile.yml 的注释文档）：发布前手动/CI 跑一次"最新桌面构建 ↔ 上一发布移动构建"的兼容冒烟（可做成 nightly 慢层 job：`compat-nightly`）。

---

## 第 8 章 Rust 侧整合（任务 6）

### 8.1 触发条件与成员更新

**8.1.1 什么情况下需要新增 Rust crate**

| 条件 | 触发示例 | 是否首期 |
| --- | --- | --- |
| 独立服务端/守护进程出现 | crish-server（让移动端不依赖桌面端在线的架构升级） | 否（登记） |
| Rust 侧需要协议解析/校验 | 服务端需要拒绝畸形消息（DoS 防御） | 否（首期用对拍夹具测试，5.3.3） |
| 移动端需要 Rust 计算（不可 JS 化的重计算） | 无（移动端定位遥控/伴生） | 否 |
| 协议注册表需要 Rust 侧 schema 生成 | 生成器扩展出 Rust 输出（serde 代码生成） | 可选增强（8.4） |

**8.1.2 members 更新形态（触发时）**

```toml
[workspace]
members = [
    "apps/agent-workbench/src-tauri",
    # ……现有 14 个 crates 原样保留……
    "crates/conex-protocol",          # 新增：协议注册表 Rust 侧（校验/协商）
    "crates/crish-server",            # 新增：服务端（若触发）
]
resolver = "2"
```

- 维持显式列表文化（现状即显式，`Cargo.toml:2-20`），不加 `crates/*` 通配符（与 npm workspaces 决策一致，3.5.1）。
- 新 crate 继承 `workspace.package`（version/edition/license 等，`Cargo.toml:23-30`）与 `[lints] workspace = true`（`Cargo.toml:11-13` 的壳 crate 模式）。

### 8.2 依赖策略

1. **新 crate 的依赖一律走 `workspace.dependencies`**（`Cargo.toml:51-88` 现有模式：serde/serde_json/tokio 最小 feature 集/thiserror/anyhow 等），不直接写版本号；新依赖（如 axum，若服务端出现）在 workspace.dependencies 追加并注明用途与收敛策略（仓库有"收敛单版本、消除双栈"的传统，见 `Cargo.toml:56-58` 的 reqwest/rustls 注释）。
2. **依赖裁剪纪律**：tokio 用最小 feature 集（`Cargo.toml:66` 注释：按各 crate 实际使用面收敛）；新 crate 引入时同样按使用面裁剪 feature。
3. **feature 开关**：协议 crate 若同时被壳与未来服务端消费，将"解析校验"（核心）与"网络服务"（服务端专属）用 feature 隔离，避免壳被拉入不必要的依赖（参考 agent-workbench 壳的按需依赖注释风格，`apps/agent-workbench/src-tauri/Cargo.toml:20-27`）。
4. **machete 门禁**：新 crate 纳入 `cargo machete` 检查面（`ci-mid.yml:101-110` 现有 job 自动覆盖 workspace 全量）；壳 crate 的 `[package.metadata.cargo-machete] ignored` 机制（`apps/agent-workbench/src-tauri/Cargo.toml:70-71`）同样适用于新 crate 的过渡期登记。

### 8.3 协议 crate 与 TS 的单一真源（跨语言对拍的关系）

- 真源仍是 `packages/protocol-core/contracts/mobile-protocol.json`（物理位于 JS 包域，区别于 engine-events.json 位于 crates 域——8.4 会讨论是否统一）。
- Rust 侧消费方式：`include_str!` 或 build.rs 读取注册表 JSON → 生成 serde 结构/校验函数 → 对拍测试（5.3.3）。Rust 侧生成器（若做）输出到 `crates/conex-protocol/src/generated/`，同样入库 + 漂移门禁（`git diff --exit-code`，模式同 TS 侧）。
- **不引入第三种描述语言**：TS 与 Rust 都从 JSON 注册表生成/消费，JSON 是唯一中间表示。

### 8.4 turbo 与 Cargo workspace 的共存（多语言范式）

依据查证 A2-2（turbo 多语言指南）：turbo 通过"包边界 + package.json 脚本"调度任意工具链，它不解析 Cargo 依赖图，只按脚本与文件哈希调度。落地：

1. 根 turbo.json **不声明 cargo 任务**；Rust 门禁继续由 .github/workflows 的 cargo job 直跑（现状，`ci.yml:127-145`）。
2. 若需要 turbo 级联（如"改注册表 → 触发 Rust 对拍"），在对应包（如未来的 `crates/conex-protocol` 的 package.json 壳——monorepo 里给 crate 放一个轻量 package.json，对齐多语言指南的 Go 示例）里声明 `test` 脚本 = `cargo test -p conex-protocol`，让 turbo 把该任务纳入图；**首期不做**（Rust 门禁独立跑已足够，加壳会增加维护面）。
3. 协议注册表变更的跨链通知：TS 侧由 protocol-drift（快层）+ protocol-parity（中层）覆盖；Rust 侧由 protocol-parity 的 cargo 步覆盖。两个门禁各自独立存在，不需要 turbo 串联。

---

## 第 9 章 质量基线（任务 7）

### 9.1 桌面端质量基线（对照基准）

桌面端现状基线（本方案对照的锚点）：

| 维度 | 桌面端现状 | 依据 |
| --- | --- | --- |
| 测试规模 | vitest unit 全量 5383 用例（主仓当前口径，多轮扩增后的基线）；根配置注释的早期实测为 4461 用例（`vitest.config.ts:9` 附近的历史校准记录） | 任务书口径 + 配置文件注释 |
| 覆盖率阈值 | 45 / 70 / 65 / 45（statements / branches / functions / lines），根 coverage 块强制，CI 带 `--coverage`（`vitest.config.ts:50-55`、`ci.yml:81`） | vitest.config.ts |
| 类型严格度 | tsconfig.base.json strict 全家桶：`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `noImplicitReturns` / `noFallthroughCasesInSwitch` / `noUnusedLocals`（`tsconfig.base.json:8-23`）；app 层有两项放宽（crish-desktop：`noUnusedLocals:false`、`exactOptionalPropertyTypes:false`，`apps/crish-desktop/tsconfig.app.json:18-19`） | tsconfig.base.json + app tsconfig |
| 门禁执行 | 快层 typecheck + vitest-fast(带覆盖率)；中层全量；慢层压力/基准 | ci.yml / ci-mid.yml |
| 附加静态门禁 | knip（死代码）、depcruise（依赖方向）、lint-staged、prettier | package.json / ci-mid.yml |

### 9.2 移动端质量基线的三条原则

**原则 1：覆盖率对齐"严格度"而非"数值"**。桌面 45/70/65/45 之所以低，是因为 vitest include 面把大量组件/UI 文件计入（`vitest.config.ts:33-36` 的 include 是 src/** 全量），分母大。移动端若首期把 UI 层全纳入 collect 面，阈值必然难看；正确做法：

- 首期 collect 面 = `src/protocol/`、`src/connection/`、`src/store/`（协议、连接、状态层），阈值设为 **60 / 75 / 70 / 60**（高于桌面，因为面小且关键）。
- UI 层（`src/ui/`）首期排除，登记二期收口（进入"移动端 UI 稳定期"后纳入并按实际基线校准）。
- **共享代码（protocol-core）的覆盖率由桌面域 vitest 与移动域 jest 双跑**：protocol-core 自身测试是桌面 vitest 门禁的一部分（`packages/*/src/**/*.test.{ts,tsx}` 已在 unit 项目 include 面，`vitest.config.ts:74`）；移动端 jest 对同一 src 复测（moduleNameMapper 指向 src，5.2.2）。**双跑是冗余不是浪费**：防"某端工具链吞了某语法但另一端没测到"。

**原则 2：类型严格度 strict 全开，放宽走显式白名单**。

- 移动端 tsconfig 继承 `tsconfig.base.json`（strict 全家桶），**不允许整体关闭任何 base 项**。
- RN 生态特有的放宽项（若确实需要）走 tsconfig 的显式 override 并**在文件内注释理由 + 登记基线**（仓库文化：放宽必须注释理由，参考 crish-desktop 的 `tsconfig.app.json:18-19` 模式）。
- 预期放宽清单（首期候选，逐项论证后落地）：
  - `exactOptionalPropertyTypes`：RN 组件 props 与 Expo API 的 optional 处理历史上常与 exactOptional 冲突；**首期先保持开**，遇阻再逐项评估（桌面端是关掉的，`apps/crish-desktop/tsconfig.app.json:19`，移动端可以对齐桌面端——两者任一选择都必须注释理由）。
  - `noUnusedLocals`：桌面端关了（`apps/crish-desktop/tsconfig.app.json:18`），移动端**建议保持开**（新代码，无历史债，开了更容易发现死代码；若 jest 测试代码触发可对测试 tsconfig 单独处理）。
  - `noUncheckedIndexedAccess`：保持开（新代码，成本低收益高）。
- **移动端 typecheck 必须进快层 CI**（mobile-typecheck job，5.1），保证 strict 漂移即时暴露。

**原则 3：测试资产与代码同 PR 提交**（AGENTS.md"测试是资产不是杂物"纪律延伸）：新增协议消息/状态机逻辑必须同 PR 带对拍样例与单测；CI 的 mobile-test-fast + protocol-drift 强制该纪律（只改代码不加测试 → 覆盖率门禁红或样例集缺口被 protocol-parity 发现）。

### 9.3 移动端质量基线的量化目标（阶段化）

| 阶段 | 测试规模（目标） | 覆盖率（关键面） | 类型 | 门禁 |
| --- | --- | --- | --- | --- |
| 阶段 0-1（骨架/协议包） | 协议包单测 ≥ 40 用例（vitest 域） | 协议面 60/75/70/60 | strict 全开 | 快层 typecheck + protocol-drift |
| 阶段 2（移动端基础） | + 连接层单测 ≥ 30 用例；jest 全量 ≥ 100 用例（含同源复测） | 连接/协议面 60/75/70/60（UI 豁免） | strict 全开（白名单内） | 中层 mobile-test（覆盖率强制） |
| 阶段 3（门禁收口） | jest 全量 ≥ 250 用例（含组件测试） | 协议/连接/状态面 60/75/70/60；UI 层纳入收口评估 | strict 全开 | 全部快/中层门禁 + protocol-parity |
| 阶段 4（发布） | 全量基线 + e2e 冒烟 ≥ 10 场景 | 同阶段 3 + 发布自检 | strict 全开 | 发布流水线自检门禁 |

对照说明：桌面 5383 用例对应的粒度（每个 reducer/parser/组件都有测试）在移动端以"关键面全覆盖 + 用例数阶段化"的方式对齐，不追求数字相同（移动端功能面远小于桌面端，用例数合理规模约桌面 1/10-1/5，但**关键路径覆盖率必须高于桌面**，因为移动端没有桌面那样的回归保护网）。

### 9.4 移动端新增的静态门禁补充

1. **eslint**：`eslint-config-expo`（Expo 官方规则集，含 RN 特定规则）+ 仓库现有 eslint 9 flat config 融合；`--max-warnings 0` 对齐根 lint（`package.json:54`）。
2. **prettier**：复用根配置（lint-staged 已覆盖 `apps/**`，`package.json:88-99`）。
3. **knip**：移动端 app 与 protocol-core 纳入 knip 检查面（现有 knip 配置自动覆盖 workspace 全部；`ci-mid.yml:140-150`）。注意 Expo 的入口文件/动态 import 需要 knip 配置声明（`entry` 与 `project` 白名单），实现时登记。
4. **depcruise**：2.2 的依赖方向规则（protocol-core 不依赖 apps；移动端不依赖桌面 app）进 `.dependency-cruiser.cjs`；depcruise 现有 exclude 含 node_modules|dist|build|target（`ci.yml:59-61` 注释），移动端无特殊需求。
5. **协议对拍与单实例检查**：5.3 的四个门禁。

---

## 第 10 章 风险清单（任务 8）

### 10.1 turbo × expo 的坑（缓存/构建隔离）

| 风险 | 说明 | 等级 | 对策 |
| --- | --- | --- | --- |
| expo 任务被 turbo 缓存串台 | expo 产物依赖 OS/arch（Hermes 字节码、原生工程生成），Windows 本机缓存被 Linux CI 命中会产生错误产物 | 高 | 3.3 决策：expo 原生产物不进 turbo 缓存；只缓存 typecheck/lint/jest 确定性任务 |
| turbo 根 `test` 任务 dependsOn build | 移动端无 build 任务会触发 missing task 报错或意外跑 `^build` | 中 | 包级 turbo.json 覆盖 `test.dependsOn: []`（3.3.3） |
| `expo export` 进缓存后被 SDK 升级打穿 | 输入没变输出变（SDK 内部行为变化） | 低 | 不进缓存（同第一条）；若未来进，SDK 版本加入 inputs |
| turbo 远程缓存（未来启用时）与移动端 | 远程缓存共享后同样有平台串台 | 低（当前无远程缓存） | 平台键进 inputs（查证 A2-3 的 turbo-cache-key 模式） |
| Metro 缓存与 turbo 无关但互相混淆 | 开发中"改了协议包不生效"常被误判为 turbo 缓存问题 | 中 | 文档化：`npx expo start --clear` 是 Metro 缓存清理手段（查证 A1-2）；turbo 只影响 CI 任务 |

### 10.2 node_modules 膨胀

| 风险 | 说明 | 等级 | 对策 |
| --- | --- | --- | --- |
| RN/Expo 依赖树庞大 | expo + react-native 及其 native 依赖通常 300-500 MB node_modules | 高 | 接受（RN 生态现实）；用 `npm ci` 冷缓存 + CI 缓存持久化控制时长（npm 缓存命中后 npm ci 约 1-2 min）；knip 监控未用依赖 |
| hoisted 布局下桌面端误 import RN 包 | npm hoisted 使任何包能 import 到 RN 依赖（非显式声明） | 中 | depcruise 规则：apps/crish-desktop 禁止 import `react-native`/`expo-*`（显式依赖方向）；移动端禁止 import 桌面专属依赖（tauri/tiptap/xterm）；`npm why` 定期检查 |
| duplicate react/react-native | 若共享包声明了不同 react 版本，monorepo 出现双 react（运行时必炸） | 高 | 单实例门禁（5.3.4 check-workspace-single-instance.mjs）；根 overrides 兜底（现有 overrides 机制，`package.json:85-87`）；protocol-core 不声明 react peer 依赖 |
| overrides 误伤 | 根 overrides 强制 esbuild 版本（`package.json:86`），扩展时可能误伤 expo 依赖链 | 低 | overrides 只加 react/react-native/expo 三键，逐条注释理由 |

### 10.3 CI 时长

| 风险 | 说明 | 等级 | 对策 |
| --- | --- | --- | --- |
| npm ci 变慢 | node_modules 增大 → 每个 job 的安装时间上涨 | 中 | actions/setup-node 的 npm cache 已有（`ci.yml:42`）；必要时 npm ci 前 `npm cache` 预热；预算从 ≤15 放宽到 ≤20（5.1） |
| jest 全量进中层慢 | 移动端全量测试含组件测试可能 3-8 min | 中 | 快层只跑关键套件（mobile-test-fast）；中层全量；`--silent` + worker 数调优；watchman 不用（CI 无 watch） |
| protocol-parity 串行 | cargo 编译 + vitest 双跑 | 中 | 只编译对拍 crate（`cargo test -p` 单包，不 `--workspace`）；Rust 编译缓存（setup-rust-toolchain 自带 cargo cache） |
| 发布流水线偶发长 | EAS 云构建排队长（首建拉原生依赖） | 低 | 发布是异步任务（构建完通知），不等 CI；流水线只做触发与自检 |
| 慢层膨胀 | mobile-e2e 与现有压力/基准抢资源 | 低 | 移动端 e2e 用 Maestro（轻量、跨平台）；nightly 错峰（schedule 与现有慢层分开时段） |

### 10.4 Expo/RN 生态风险

| 风险 | 说明 | 等级 | 对策 |
| --- | --- | --- | --- |
| SDK 升级节奏快 | Expo 一年多个 SDK，RN 版本绑定 | 中 | 锁定 LTS 线；升级作为独立任务（含协议/门禁回归）；`expo install --fix` 对齐依赖 |
| 第三方 RN 库的 monorepo 兼容 | 少数库硬编码 node_modules 路径 | 低 | 查证 A1 的"Script does not exist"对策（require.resolve 动态引用是 Expo 官方标准，多数库已适配）；patch-package 兜底（登记） |
| Expo Go 能力边界 | Expo Go 不支持自定义原生模块/部分 API | 中 | 首期纯 JS 功能用 Expo Go；引入原生模块时切 development build（`expo run:android`），流程在 6.4 已登记 |
| Hermes 与 zod 兼容 | zod 在 Hermes 上的表现（错误路径信息、性能） | 低 | 协议解析量大面小（消息频率有限），zod 在 Hermes 可用；若性能/包体有压力，生成器可切换为手写 parser（原生成器已有手写 parser 模板可复用，`generate-engine-bindings.mjs:299-415`） |
| iOS 构建与审查 | 需要 macOS/付费账号/审核周期 | 中 | EAS 云构建绕开本机 OS 限制（7.2.1）；审核周期进发布排期 |

### 10.5 .gitignore 白名单陷阱（本方案特有的高危坑）

根 `.gitignore` 的 `*.json` / `*.mjs` / `*.txt` / `*.html` / `*.png` 是**全局忽略**（`C:\Software\conex\.gitignore:357-361`），现有白名单只放行了 package.json、package-lock.json、tsconfig.json、docs 等少量文件（`C:\Software\conex\.gitignore:362-375`）。

**Expo 项目必备文件会被这个规则静默吃掉**（提交后仓库里没有，clone 后项目跑不起来，且 CI 上 `npm ci` 后 app.json 缺失）：

| 文件 | 被忽略的后果 |
| --- | --- |
| `apps/crish-mobile/app.json` | Expo 项目无法识别（启动即崩） |
| `apps/crish-mobile/eas.json` | EAS 构建 profile 缺失，发布流水线崩 |
| `apps/crish-mobile/app.config.ts`（若用） | 配置缺失 |
| `apps/crish-mobile/babel.config.js` | JS 扩展名——`.js` 未被忽略，安全；但若团队习惯用 `.mjs` 配置会中招 |
| `apps/crish-mobile/jest.config.js` | `.js` 安全；`.ts`/`.mjs` 变体中招 |
| `apps/crish-mobile/package.json` | 已白名单（`!package.json` 是全局放行？——注意现有白名单 `!package.json` 只匹配根；workspace 内的 package.json 需要确认。npm workspaces 下如果子 package.json 被忽略，npm ci 会静默不装该 workspace 的依赖！**必须验证并放行 `!**/package.json`**） |
| `apps/crish-mobile/tsconfig.json` | 现有 `!tsconfig.json` 同样只匹配根；**必须放行 `!**/tsconfig.json`** |
| `packages/protocol-core/contracts/mobile-protocol.json` | 真源被忽略 = 生成器在 CI 上无输入，protocol-drift 门禁假红或产物缺失 |
| `scripts/generate-protocol-bindings.mjs` | 现有 `*.mjs` 忽略会把新生成器脚本吞掉（现有 generate-engine-bindings.mjs 是怎么入库的？——需要核实；若现有 `.mjs` 被忽略而文件已在库内，说明它曾被强制 add；新脚本必须走白名单） |

**对策（落地第一优先级）**：在根 `.gitignore` 追加：

```gitignore
# 多端互通：Expo/EAS/协议注册表 文件白名单（全局 *.json/*.mjs 忽略的例外）
!apps/crish-mobile/app.json
!apps/crish-mobile/eas.json
!apps/crish-mobile/**/tsconfig*.json
!**/package.json
!**/tsconfig*.json
!packages/protocol-core/contracts/*.json
!scripts/generate-protocol-bindings.mjs
!apps/crish-mobile/jest.config.*
!apps/crish-mobile/babel.config.*
```

**验证方法**：阶段 0 验收时执行 `git check-ignore -v` 逐个文件确认（仓库已有该验证传统：AGENTS.md 中 `.agent-outputs` 的 check-ignore 验证），并用一次真实的"clone 后 npm ci + expo start"冒烟确认入库完整性。**此坑不解决，阶段 0 就是假绿**。

### 10.6 平台与工具链风险

| 风险 | 说明 | 等级 | 对策 |
| --- | --- | --- | --- |
| Windows 本机无 iOS 开发 | 无法本地 iOS 模拟器/签名 | 中 | EAS 云构建（7.2.1）；Android 本机模拟器做主力本地调试；iOS 验证走 preview profile |
| Node 版本 | 根 CI 用 Node 20（`ci.yml:41`）；Expo 要求 Node 20+ | 低 | 保持 Node 20（README 声明）；根 `packageManager` 字段已锁 npm@11.6.2（`package.json:5`） |
| 桌面端 vitest 配置的 include 面 | unit 项目 include `packages/*/src/**/*.test.{ts,tsx}`（`vitest.config.ts:74`）——protocol-core 的测试自动进桌面门禁，双跑机制的第一个耦合点：**若 protocol-core 测试引了 RN 语法会炸桌面门禁** | 中 | 纪律：protocol-core 测试只写纯 TS（无 RN import）；移动端专属逻辑测试放 app 内 jest |
| 中文编码 | 仓库约定 UTF-8 无 BOM 中文注释（AGENTS.md）；移动端/协议包的新文件同约定 | 低 | 编辑器配置 + lint-staged 已有；生成器输出由模板控制（生成器本身保持 ASCII，中文只进注册表/注释） |

---

## 第 11 章 落地步骤（任务 9）

> 【裁决修正 9】阶段映射（统一 R0-R5）：阶段 0 骨架 → **R2 移动端基础**（与 R0
> 并行，见 AU3 §1.3 依赖链）；阶段 1 协议包 → **R0 协议冻结**；阶段 2 移动端
> 基础 → R2；阶段 3 门禁收口 → R2/R3；阶段 4 发布 → R3 收尾。任务书引用一律
> 使用 R 阶段号。

### 阶段 0：骨架整合（目标：移动端 app 在仓库里"活着"且门禁绿）

**目标**：`apps/crish-mobile` 空 Expo app 加入 workspaces；协议包骨架创建；门禁接线；白名单修正；全链路（clone → npm ci → expo start）可跑。

**动作清单**：

1. 根 `.gitignore` 白名单修正（10.5 的清单），并用 `git check-ignore -v` 逐文件验证。
2. `npx create-expo-app` 生成 `apps/crish-mobile`（SDK LTS 线），清理模板的锁文件/嵌套 .gitignore，合并仓库约定。
3. 根 `package.json`：workspaces 追加两项（apps/crish-mobile、packages/protocol-core）；`typecheck` 追加 2 段 tsc；新增 `dev:mobile` 等根脚本（6.3）。
4. `packages/protocol-core` 骨架：package.json（src 直出）、tsconfig、空 index、contracts/mobile-protocol.json 最小注册表（1-2 条消息，验证链路）。
5. 生成器骨架：`scripts/generate-protocol-bindings.mjs`（先复制 generate-engine-bindings.mjs 的骨架：validate + 确定性输出 + 文件头），生成 types/schema/versions/index。
6. 根 `turbo.json` 不动（首期无需改）；协议包与移动端的包级 turbo.json 可后置。
7. CI：快层追加 protocol-drift job；mobile-lint/mobile-typecheck/mobile-test-fast 三个 job 接线（此时 app 内 jest 先装后配，最小配置跑通 1 个冒烟测试）。
8. 移动端 app 内：App.tsx 显示"协议版本 + 连接状态"占位（连不上不崩，超时提示），验证 Metro 解析 protocol-core。

**验收标准**：

- [ ] `git check-ignore -v` 确认 app.json/eas.json/package.json(移动端)/mobile-protocol.json/生成器脚本 全部入库。
- [ ] 全新 clone → `npm ci` → `npm run typecheck`（9 段全绿）→ `npm run dev:mobile`（Metro 起，App 渲染）。
- [ ] 快层 5 个移动端/协议 job 全绿（含 protocol-drift）。
- [ ] 空跑基线记录：新增 job 的时长（为 5.4 预算提供实测数）。
- [ ] 提交纪律：全部变更（含生成器与注册表）一次性 git add 提交。

**风险闸**：若 Metro 解析 protocol-core 的 src 直出失败（exports 解析差异），回退方案 = 给 protocol-core 补 dist 构建 + 移动端映射 dist（5.2.2 的 moduleNameMapper 已留口）——但优先修 Metro 侧（`unstable_conditionNames` 或去掉 exports 只用 main 字段）。

### 阶段 1：协议包落地（目标：协议真源 + 生成器 + 对拍闭环）

**目标**：mobile-protocol.json 达到首期完整注册表（审批/会话/消息推送面）；生成器输出 types/schema/versions 齐备；TS↔Rust 对拍门禁绿；状态机纯函数落地。

**动作清单**：

1. 注册表定稿：消息面（6.3 示例的请求/推送消息）、类型面、枚举面；protocolVersion 与 minSupportedProtocolVersion 定值；变更记录字段（7.3.2 的登记约束）。
2. 生成器补齐：zod schema 生成（含 unknown-tag 容忍的 role 参数化，7.4.3 约束 1）、versions.ts、整数校验继承（register 的 integer 标记规则，4.3.2）。
3. 对拍闭环：`packages/protocol-core/tests/fixtures/` 样例集（有效 + 边界无效 + 跨版本 v1/v2）；vitest 域测试（parser 接受/拒绝矩阵）；Rust 侧对拍 crate（或 conex-types 测试模块）读同一 JSON 跑断言；`scripts/compare-parity-results.mjs` 结论比较；ci-mid.yml 的 protocol-parity job。
4. 审批状态机纯函数 + 单测（4.3.5）。
5. shared-types 派生拆分：协议面类型迁移到 protocol-core，shared-types 保留 re-export 兼容垫层（3.4.1 步骤 2），桌面端 import 面零破坏。
6. 单实例检查脚本（5.3.4）接线。

**验收标准**：

- [ ] `node scripts/generate-protocol-bindings.mjs` 两次运行字节一致（幂等）。
- [ ] 快层 protocol-drift：故意改注册表不重跑生成器 → job 红；重跑后绿。
- [ ] 中层 protocol-parity：两端样例结论表一致；故意在 TS parser 里引入"未知消息拒绝"→ 对拍红（证明门禁有效）。
- [ ] 桌面端全部既有测试绿（shared-types 垫层未破坏 import 面）。
- [ ] 协议包 vitest 用例 ≥ 40（9.3 阶段 0-1 目标）。

### 阶段 2：移动端基础（目标：移动端能完成真实业务往返）

**目标**：连接层（WS 重连/握手/心跳）、会话列表、审批面板（复用状态机）、错误呈现；真机/模拟器连引擎跑通一次完整审批流。

**动作清单**：

1. 连接层：WebSocket 客户端封装（重连用 shared-utils retryWithBackoff 同源复用）、握手（7.4.1）、心跳、断线重连。
2. store：移动端轻量 zustand store（连接状态/会话/审批队列），协议状态全走 protocol-core reducer。
3. UI：会话列表页、审批面板（桌面端同一 reducer 推演，两端按钮可用性一致）、设置页（引擎地址运行时配置，6.2）。
4. 测试：jest 接线完成（M1 纯函数 + M2 组件 + M3 集成 mock WS），覆盖率门禁 60/75/70/60（关键面）。
5. dev 脚本收口：`dev-joint.mjs`（引擎+移动端一键起）；真机局域网调试流程文档化（6.2 拓扑二）。
6. 桌面端引擎侧配合点：引擎的 `--listen`/端口配置 + CORS/Origin 策略（多端互通整体设计职责，本阶段联调验收）。

**验收标准**：

- [ ] 模拟器 + 桌面端联调：移动端看到引擎会话列表；发起审批 → 移动端决策 → 引擎回执 → 移动端 phase 流转正确（与桌面端面板一致）。
- [ ] 真机（局域网）联调：同一 Wi-Fi 下完整流程可跑。
- [ ] 断网/重启场景：重连与握手自动恢复，无死锁。
- [ ] 中层 mobile-test（覆盖率强制）绿；jest 全量 ≥ 100（9.3 阶段 2 目标）。
- [ ] 快层 mobile-lint/typecheck/test-fast 绿。

### 阶段 3：门禁收口（目标：移动端享有与桌面端同等级的门禁密度）

**目标**：全部快/中/慢层移动端门禁就位并实测时长达标；慢层 mobile-e2e 接线；跨版本兼容测试入样例集。

**动作清单**：

1. 快层：mobile 三 job 时长实测校准（5.1 预算）；确认无路径过滤泄漏。
2. 中层：mobile-build-smoke（expo export）、workspace-single-instance、protocol-parity 全绿；总时长实测 ≤30 min。
3. 慢层：Maestro 冒烟（启动→连引擎→会话→审批往返）nightly 接线；`compat-nightly`（最新桌面 × 上一移动发布 兼容冒烟，7.4.4）。
4. 跨版本样例（v1/v2 兼容矩阵测试）进 protocol-parity。
5. knip/depcruise 移动端规则复核（Expo 入口白名单等）。
6. 基线记录文档化（对齐仓库"基线记录"文化：移动端覆盖率基线、job 时长基线）。

**验收标准**：

- [ ] 全部门禁矩阵（5.5 表）逐项在 CI 实测通过，时长在预算内。
- [ ] 人为破坏实验：改生成物 / 改注册表不动生成器 / 双 react 引入 → 各有对应 job 红（门禁有效性证明）。
- [ ] 慢层 nightly 连续跑通 3 次无 flaky。

### 阶段 4：发布（目标：移动端可发布、版本体系生效、兼容策略落地）

**目标**：EAS 配置与 release-mobile.yml 就位；三轨版本体系运行；商店渠道首版发布或内测分发（preview）可用。

**动作清单**：

1. eas.json 三 profile（development/preview/production）+ EAS 凭据初始化（团队账号、Apple/Google 凭据入库 Secrets）。
2. release-mobile.yml 上线（7.2.3）：workflow_dispatch + tag 触发；发布自检（生成物 diff + typecheck + test）接线。
3. 版本策略落地：注册表 protocolVersion/minSupported 基线 + 变更登记纪律；移动端设置页显示协议版本。
4. 升级兼容实测：发布 preview 版（新协议）→ 旧版 App 连接 → 未知消息容忍与降级行为验证（7.4 矩阵的 M 场景逐项跑）。
5. 桌面端发布流程文档化补充："协议变更时两端发布检查清单"（7.4.4 的发布检查清单）接入现有发布入口。
6. 运营面：诊断信息（协议版本/引擎地址/连接状态）可在设置页导出，便于线上排障。

**验收标准**：

- [ ] preview 构建在真机安装并连真实引擎跑通全流程（含一次协议版本升级的兼容切换）。
- [ ] production 构建 dry-run（不实际提交商店）产出 aab/ipa 包体与版本号正确。
- [ ] 版本变更演练：注册表 minor 递增 → 生成物更新 → 旧客户端兼容（样例集证明）。
- [ ] 发布自检门禁在任何 tag 发布前强制绿。

---

## 第 12 章 结论与待决事项

### 12.1 关键决策摘要（实现任务的强约束）

1. **workspace 结构**：`apps/crish-mobile`（Expo app）+ `packages/protocol-core`（协议包）显式加入 npm workspaces；保持 npm hoisted；Expo SDK 52+ 自动 monorepo 检测，不写传统 Metro 配置；turbo 只调度移动端 typecheck/lint/test，expo 原生产物不进缓存。
2. **共享策略**：跨端协议单一真源 = `mobile-protocol.json` 注册表 + 新生成器 `scripts/generate-protocol-bindings.mjs`（继承 generate-engine-bindings 的幂等/确定性/强校验/漂移门禁四特性）；protocol-core src 直出、zod schema、审批状态机纯函数手写 + 双域测试；**禁止任何端手写协议类型**。
3. **门禁**：移动端测试独立 jest-expo 轨（不进根 vitest）；快层 4 个新 job（lint/typecheck/test-fast/drift），中层 4 个（全量 test/parity/single-instance/build-smoke），慢层 2 个（e2e 冒烟/compat-nightly）；协议一致性 = 生成物 diff + TS↔Rust 对拍 + 跨版本样例。
4. **本地开发**：引擎对外 WS 端口为连接锚点；Android 模拟器 10.0.2.2 映射、真机局域网 IP；连接地址零硬编码（env + 运行时设置）；`dev-joint.mjs` 编排。
5. **发布**：桌面端流程不动；移动端 EAS CNG 云构建三 profile；应用版本（各端独立）/ 协议版本（注册表派生）/ 兼容窗口（minSupported）三轨；握手协商 + 未知消息容忍（生成器按 role 参数化）+ capabilities feature negotiation。
6. **Rust**：首期零 Cargo 改动；触发条件（服务端出现 / Rust 侧协议校验需求）出现时按显式 members + workspace.dependencies + workspace.lints 模式新增。
7. **质量基线**：覆盖率对齐严格度（关键面 60/75/70/60 高于桌面 45/70/65/45，UI 首期豁免）、strict 全开 + 显式白名单、测试资产同 PR。
8. **风险最高优先级项**：`.gitignore` 的 `*.json` 全局忽略会吞掉 app.json/eas.json/注册表（10.5）——阶段 0 必须先修。

### 12.2 待主控/用户裁决的开放问题

| # | 问题 | 选项 | 本方案倾向 | 影响 |
| --- | --- | --- | --- | --- |
| O-1 | Expo SDK 线选择 | 最新稳定 / 上一 LTS | 任务书写点时最新稳定（官方 sdk-57 示例线），升级独立任务 | 3.1/3.2 |
| O-2 | 协议包命名 | `@crish/protocol-core` / `@crish/protocol` / `@crish/mobile-protocol` | `protocol-core`（未来服务端也消费，不含 mobile 限定） | 3.4 |
| O-3 | 移动端定位 | 遥控/伴生客户端（本方案前提） vs 嵌入完整引擎 | 遥控/伴生（本方案前提） | 2.3 边界 |
| O-4 | 引擎对外服务端口与协议 | 多端互通整体设计（其他 D 方案）定义；本方案假定 WS + JSON | 待整体设计 | 6.2/7.4 |
| O-5 | zod 是否可接受为协议包唯一运行时依赖 | 接受 / 保持零依赖（改手写 parser） | 接受（桌面已用） | 3.4.4/4.3.2 |
| O-6 | 移动端 UI 层覆盖率豁免的收口时机 | 阶段 3 收口 / 阶段 4 | 阶段 3 评估、阶段 4 前定案 | 9.2 |
| O-7 | 移动端内测分发渠道 | EAS internal distribution / TestFlight + 内部 track | EAS internal（首期 preview） | 7.2 |
| O-8 | 移动端版本号来源 | EAS remote（appVersionSource） / 仓库内 app.json | EAS remote | 7.2.2 |
| O-9 | 是否引入 Detox vs Maestro | Detox（RN 专用，重）/ Maestro（轻，跨平台） | Maestro | 5.2.3 M4 |
| O-10 | 全仓统一迁移 `workspace:*` 协议 | 本方案首期沿用 file: | 登记后续增强 | 3.5.2 |

### 12.3 交付边界声明

- 本方案是**工程整合设计**：不包含移动端功能需求（会话列表样式、审批面板交互细节）、不包含引擎服务端通信协议的 wire 细节（多端互通整体设计）、不包含商店上架流程的运营内容（账号、审核材料）。
- 本方案的配置示例（turbo.json / eas.json / jest / CI YAML）是建议形态，实现时以任务书写到时的工具版本为准做等价替换；**决策结论（12.1）不得被实现任务擅自改变**。

---

## 附录 A 查证记录（webfetch 来源与结论）

### A.1 Expo 官方 Monorepo 指南（docs.expo.dev/guides/monorepos，2026-06-30 修订版）

| 条目 | 原文要点 | 本方案落点 |
| --- | --- | --- |
| A1-1 | Expo 对 npm/Bun/pnpm/Yarn workspaces 的 monorepo 是一等公民支持 | 3.1 前提 |
| A1-2 | SDK 52+ 自动检测 monorepo；手动 Metro 配置（watchFolders/nodeModulesPaths 等）应删除；迁移后 `npx expo start --clear` 一次 | 3.1/6.4 |
| A1-3 | 推荐目录形态 apps/* + packages/* + 根 package.json | 2.1 目标树 |
| A1-4 | 工作区依赖建议 `"*"`；npm 支持 `workspace:*` | 3.5.2 |
| A1-5 | duplicate 红线：单仓库只允许一个 react-native；重复 react 必炸；重复 Turbo/Expo modules 可能炸；`npm why` 排查；npm 用 `overrides` 处理 peer 冲突 | 3.1/5.3.4/10.2 |
| A1-6 | SDK 54+ 支持 isolated 依赖；SDK 53 及之前推荐 hoisted；npm 默认 hoisted 无此问题 | 3.1（保持 hoisted） |
| A1-7 | SDK 55+ 在 monorepo 自动启用 `experiments.autolinkingModuleResolution` | 3.1 |
| A1-8 | 原生目录路径硬编码问题：Expo 模板用 `require.resolve` 动态引用，兼容 monorepo；个别第三方库需 patch-package | 10.4 |

### A.2 Turborepo 官方文档（turborepo.com）

| 条目 | 原文要点 | 本方案落点 |
| --- | --- | --- |
| A2-1 | llms.txt 全量核对：无 React Native/Expo 专用指南页；按通用任务声明处理 | 3.3 |
| A2-2 | Multi-language 指南：非 JS 生态经"包边界 package.json + 脚本"整合；turbo 不解析外部工具链依赖图；包级 turbo.json（extends //）可收窄任务与 outputs | 3.3.3/8.4 |
| A2-3 | Handling platforms：turbo 缓存哈希不含 OS/arch；需用 inputs/globalDependencies 显式加入平台键；跨平台 CI 复用缓存可能串台 | 3.3.1/3.3.4/10.1 |
| A2-4 | 包级 turbo.json + `dependsOn` 覆盖是官方推荐的收窄手段 | 3.3.3 |

### A.3 查证限制声明

- Expo SDK 具体版本号（57.0.0/RN 0.86/react 19.2.3）取自官方文档示例（2026-06 快照），落地以 `npx create-expo-app --template default` 实际生成版本为准（3.2.2 已声明）。
- Turborepo 对 expo 的"原生产物不进缓存"是本方案的工程判断（基于 A2-3 的平台哈希问题 + expo 产物不可复现性），非官方禁令；未来 turbo 若提供 expo 官方集成再评估。

---

## 附录 B 术语表

| 术语 | 含义 |
| --- | --- |
| 多端互通 | 桌面端（引擎/UI）、移动端 app、未来服务端共享同一业务协议的形态 |
| 协议包（protocol-core） | 跨端协议真源产物的 npm 包：注册表生成物 + 状态机纯函数 |
| 协议注册表（mobile-protocol.json） | 跨端协议的真源 JSON：消息/类型/枚举/版本登记 |
| 生成器（generate-protocol-bindings.mjs） | 注册表 → TS 类型 + zod schema + 版本常量的确定性生成脚本 |
| 对拍（parity） | TS 侧与 Rust 侧对同一组样例的解析结论一致性测试 |
| 漂移（drift） | 真源与生成物不一致（生成物未重跑/未提交） |
| 快层/中层/慢层 | CI 分层：提交即时（≤15-20 min）/ 合并前全量（≤20-30 min）/ nightly |
| CNG | Expo Continuous Native Generation：原生目录由 prebuild 生成、不入库 |
| EAS | Expo Application Services：云构建（Build）/ 提交（Submit）/ 凭据管理 |
| profile | EAS Build 的构建配置档（development/preview/production） |
| minSupportedProtocolVersion | 本端能兼容的最低对端协议版本（兼容窗口下限） |
| capability negotiation | 握手时交换能力声明、按能力子集运行（不依赖版本号硬判） |
| Metro | React Native 的 JS 打包器（等价于桌面端的 vite/rollup） |
| Hermes | RN 默认 JS 引擎（Android，iOS 可选） |
| Expo Go | 免构建的 Expo 开发客户端（无自定义原生模块） |
| development build | 含自定义原生模块的 expo 开发构建（`expo run:*`） |
| jest-expo | Expo 官方 jest preset（RN 转译 + 原生 mock） |
| 同源复测 | 同一份共享源码（protocol-core）在 vitest（桌面域）与 jest（移动域）各跑一次测试 |

---

## 附录 C 参考文件行号索引（现状证据）

| 文件 | 行号 | 内容 | 在方案中的引用点 |
| --- | --- | --- | --- |
| `package.json`（根） | 8-16 | npm workspaces 显式列表 | 3.5.1 |
| `package.json`（根） | 40 | typecheck 7 段 tsc 直跑 | 3.5.3 |
| `package.json`（根） | 54 | eslint --max-warnings 0 | 9.4.1 |
| `package.json`（根） | 85-87 | overrides（esbuild） | 3.1/10.2 |
| `package.json`（根） | 88-99 | lint-staged 配置 | 3.5.3/9.4 |
| `turbo.json` | 3-30 | 根任务图 | 3.3.2 |
| `Cargo.toml` | 1-21 | Cargo workspace members 显式列表 | 3.6/8.1 |
| `Cargo.toml` | 23-30 | workspace.package | 8.1.2 |
| `Cargo.toml` | 38-49 | workspace.lints（dbg_macro/unimplemented deny） | 3.6/8.2 |
| `Cargo.toml` | 51-88 | workspace.dependencies | 8.2 |
| `tsconfig.base.json` | 3-23 | strict 全家桶 | 9.1 |
| `vitest.config.ts` | 9-14 | 根 coverage 块覆盖项目级阈值的踩坑记录 | 5.1 |
| `vitest.config.ts` | 29-55 | coverage include/exclude/thresholds（45/70/65/45） | 9.1 |
| `vitest.config.ts` | 57-121 | projects: unit/integration/native-smoke | 5.1 |
| `vitest.config.ts` | 74 | unit 项目 include packages/* 测试 | 9.2/10.6 |
| `ci.yml` | 1-10 | 快层预算声明 | 5.1 |
| `ci.yml` | 16-24 | paths-ignore | 5.4 |
| `ci.yml` | 44-46 | G7 统一：typecheck 走根脚本 | 3.5.3 |
| `ci.yml` | 81 | vitest-fast 带 --coverage | 9.1 |
| `ci.yml` | 95-98 | drift 只锁 JSON↔TS 的缺口注释 | 5.3.1 |
| `ci.yml` | 99-110 | engine-bindings-drift job | 5.3.2 |
| `ci-mid.yml` | 1-12 | 中层预算声明 | 5.1 |
| `ci-mid.yml` | 101-110 | machete job | 8.2 |
| `ci-mid.yml` | 140-150 | knip job | 9.4.3 |
| `apps/crish-desktop/package.json` | 20 | file: 依赖模式 | 3.5.2 |
| `apps/crish-desktop/package.json` | 49 | zustand / zod 依赖 | 3.2.2/3.4.4 |
| `apps/crish-desktop/tsconfig.app.json` | 18-19 | app 层放宽（noUnusedLocals/exactOptional） | 9.1/9.2 |
| `apps/crish-desktop/vite.config.ts` | 207-210 | port 5174 strictPort | 6.1 |
| `apps/crish-desktop/vite.config.ts` | 246 | envPrefix VITE_/TAURI_ | 6.1 |
| `apps/agent-workbench/package.json` | 9 | dev 脚本（先起 crish-desktop dev） | 6.1 |
| `apps/agent-workbench/src-tauri/Cargo.toml` | 70-71 | cargo-machete ignored 登记 | 8.2 |
| `packages/shared-types/package.json` | 9-20 | development 双轨 exports | 1.3.1 |
| `packages/shared-types/package.json` | 25-29 | build 脚本（tsc+tsc-alias+esbuild） | 1.3.1/3.4.4 |
| `packages/shared-utils/package.json` | 9-50 | 多入口 exports（.browser/.node） | 1.3.3 |
| `packages/plugin-sdk/package.json` | 5-6 | src 直出先例 | 3.4.4 |
| `scripts/generate-engine-bindings.mjs` | 10-18 | 幂等/确定性/固定文件集 | 4.3.1 |
| `scripts/generate-engine-bindings.mjs` | 24-39 | 真源与输出路径 | 4.3.1 |
| `scripts/generate-engine-bindings.mjs` | 41-49 | GENERATED 文件头 | 4.3.1 |
| `scripts/generate-engine-bindings.mjs` | 87-167 | validateRegistry 强校验 | 4.3.1/4.3.2 |
| `scripts/generate-engine-bindings.mjs` | 299-415 | 手写 parser 模板（ParseResult/深度守卫） | 4.3.2/10.4 |
| `.gitignore` | 357-361 | 全局忽略 *.json/*.mjs/*.txt 等 | 10.5 |
| `.gitignore` | 362-375 | 白名单（仅根 package.json/tsconfig.json 等） | 10.5 |
| `.gitignore` | 408 | .turbo 缓存忽略 | 3.3.4 |

---

## 附录 D 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 0.1 | 2026-08-09 | 初稿（子代理 D8 产出） |

