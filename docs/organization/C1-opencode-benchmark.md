# C1 opencode 基准调研（reference/opencode）

> 调研员产出 · 只读调研 · 2026-08-03
> 对象：`reference/opencode`（github.com/anomalyco/opencode，dev 分支，v1.18.4，本地克隆约 371 条 commit 深度）
> 目的：为 conex/crish 与 opencode 的水平对比提供事实依据

---

## 0. 结论速览

| 维度 | 评级 | 一句话理由 |
| --- | --- | --- |
| 功能完成度 | **A+** | 20+ CLI 子命令，TUI/Web/桌面/终端多端，10+ provider、MCP/LSP/ACP/Skills/子代理/权限/快照/worktree 全覆盖 |
| 架构成熟度 | **A+** | schema→core→server 单向依赖；事件溯源（Durable Event）持久化会话；Effect 4 代数化运行时；OpenAPI 生成 SDK 防漂移 |
| 工程质量 | **A+** | 699 个测试文件 + Playwright e2e + 双平台 CI + tsgo 类型检查 + type-aware oxlint + 生成代码一致性 gate |
| 开源运营 | **A+** | MIT、21 语言 README、issue 模板强制 + vouch 信任体系、威胁模型 SECURITY、全自动发布流水线、自家产品 dogfooding |

**总评：A+（成熟商业级开源项目，conex 可对标学习的完整样本。）**

核心差距（对 conex 而言）：conex 在**会话持久化的事件溯源化、模型层协议化、端到端测试与 CI 自动化、开源运营治理**四个方向均有 1~2 代差距；在**多端形态（TUI/Web/桌面）与 SDK 生成**方面同样有明确缺口。

---

## 1. 规模与结构

### 1.1 仓库总览

- 包管理器：Bun（`bun@1.3.14`），workspaces + catalog（统一版本目录）+ 16 个 patchedDependencies（对依赖打补丁）
- Monorepo 编排：Turborepo（`turbo.json`），任务按包细化（opencode#test / core#test / app#test / ui#test / session-ui#test），依赖 `^build`
- 规模：packages 下 **31 个包**（另含 console/*、stats/*、sdk/js、slack 子包），TS/TSX 约 **53.9 万行**
- 许可证 MIT，仓库声明为 `anomalyco/opencode`（sst 系公司产品，社区版开源 + enterprise 目录）

### 1.2 包清单与职责（packages/）

| 包 | 职责 |
| --- | --- |
| `opencode` | CLI 壳 + V1 会话循环 + 命令分发（yargs 20+ 子命令）+ TUI 入口 + V1 工具实现 |
| `core` | **新一代核心**：Effect 4 + Drizzle SQLite，Session V2 事件溯源、SessionRunner、SystemContext、事件持久化、权限、Location 作用域 |
| `tui` | 终端 UI（SolidJS + opentui），45 个测试，dialog 组件家族 |
| `server` | HTTP 服务（V2 门面），依赖 core + protocol |
| `client` | 从 server 的 OpenAPI 生成的类型化客户端（`src/generated` 不许手改，`check:generated` 防漂移） |
| `protocol` | 跨端协议类型（依赖 schema） |
| `schema` | 全部 Schema（Effect Schema 编解码）：模型/会话/事件清单/权限/插件/PTY/问题/引用…… |
| `llm` | **独立模型层**：10+ provider 实现、8 种协议（anthropic-messages / openai-chat / openai-responses / openai-compatible / gemini / bedrock-converse / bedrock-event-stream）+ 路由/认证/传输（http/websocket） |
| `plugin` | `@opencode-ai/plugin` 公开插件 API（client + tool + workspace adapter + provider hook） |
| `sdk` | JS SDK（含 `sdk/openapi.json`，生成 `sdk/js`；另有 `sdk-next` 组合 client+core+server） |
| `app` | Web 共享 UI（SolidJS + SolidStart），176 个测试 + Playwright e2e |
| `web` | 官网/landing 资源 |
| `desktop` | Electron 桌面壳（包装 app） |
| `console` | 云控制台（SST 部署） |
| `enterprise` | 企业分享/存储路由 |
| `session-ui` | 会话界面组件 |
| `ui` | 基础 UI 组件库 |
| `codemode` | Effect 原生受限代码执行（schema 描述工具） |
| `slack` | Slack 集成（基于 SDK 客户端） |
| `stats` | 数据统计应用 |
| 辅助包 | `effect-drizzle-sqlite` / `effect-sqlite-node`（Effect 适配 SQLite）、`http-recorder`、`httpapi-codegen`、`identity`、`function`、`containers`（含 tauri-linux 容器！）、`storybook`、`docs`、`cli`、`script` |

### 1.3 依赖方向（AGENTS.md 明令）

```
schema ← (core, protocol)
core/protocol ← server
client 运行时只依赖 schema/protocol，绝不依赖 core/server
sdk-next 组合 client + core + server
```

opencode 包聚合：codemode / llm / plugin / protocol / schema / script / sdk / server / tui。

---

## 2. 架构

### 2.1 双代会话核心（V1 与 V2 并行演进）

- **V1（packages/opencode/src/session/）**：`prompt.ts` 单体循环 + `processor/llm/compaction/retry/revert/status/summary/todo` 等 20 个模块，面向 TUI 客户端，通过 server 暴露。
- **V2（packages/core/）**：Effect 4 原生重写，核心是 **Session 事件溯源**：
  - `session_input` 为持久化受理队列；`PromptAdmitted`（受理）→ `Prompted`（提升为可见用户消息）两阶段事务，投影器在同一个事件事务里原子写入可见消息。
  - `SessionExecution.resume(sessionID)` 只凭 Session ID 路由：`SessionStore.get → LocationServiceMap.get → SessionRunner.run`；SessionRunner/模型解析/工具注册表/权限/文件系统全部 Location 作用域。
  - 每个 provider 回合**恰好一次** `llm.stream(request)`；本地工具先持久化记录再执行、fiber 并发启动、全部结算后才续轮；运行中的工具跨进程遗留（`running` 状态）在下一轮开始前以 `Tool execution interrupted` 失败，绝不静默重放副作用。
  - Context Epoch：精确持久化给模型的 System Context 基线 + 变更以时序 System 消息追加 + 模型隐藏快照比对（`specs/v2/session.md` 有完整规范与 ASCII 时序图）。
- **过渡策略**：`event-v2-bridge.ts` 把 V1 事件桥接到 EventV2 并附加 Location 上下文；同一事件由 TUI/Web/桌面共同消费。这是"重写不推翻"的教科书做法。

### 2.2 事件系统（Durable Event 溯源）

- `schema/src/event-manifest.ts` 集中登记全部事件定义（foundation / feature / server 分层 `Event.inventory`），按 `aggregateID + seq + version` 持久化到 SQLite（drizzle-orm），解码走 `Schema.decodeUnknownSync`。
- `core/src/event.ts` 提供发布/订阅（PubSub/Queue/Stream）、durable 定义校验、`latestSequence`、错误路径 `Schema.TaggedErrorClass`。
- 事件按业务域拆文件（session-event / session-status-event / session-todo / vcs-event / workspace-event / worktree-event / lsp-event / mcp-event / pty-event……），V1 legacy 事件独立成 `v1/` 目录，schema 层还维护 `legacy-event.ts` 兼容清单。

### 2.3 模型层（packages/llm）

- `route/`：协议选型（protocol.ts）、endpoint 解析、auth-options、framing、executor，transport 分 http / websocket 两种。
- `providers/`：anthropic、openai、google、azure、openrouter、xai、amazon-bedrock、cloudflare、github-copilot、openai-compatible（profile）。
- 协议独立于 provider（同一 provider 可选 openai-chat / openai-responses），utils 覆盖 tool-schema / tool-stream / cache / lifecycle / gemini-tool-schema / bedrock-auth 等横向切面。
- 模型目录数据独立于代码（`models.dev` 仓库，CONTRIBUTING 声明"加 provider 基本不用改代码"）。

### 2.4 工具系统（双轨）

- **V2（core/src/tool/）**：`Definition<Input, Output>` 不透明类型 + Schema 编解码 + `execute: Effect<Output, ToolFailure>` + `toModelOutput` 投影钩子；注册表（registry）统一权威执行；内置 bash/edit/write/read/glob/grep/webfetch/websearch/question/skill/todowrite/apply-patch；工具输出有大小上限与溢出文件（tool-output-store）。
- **V1（opencode/src/tool/）**：20+ 工具每个配 `.txt` 人类可读说明（plan/task/apply_patch/truncate 等），含 shell 子目录（git/gh 等）与 LSP 工具。
- `codemode` 包把代码执行做成 schema 描述工具（受限执行）。

### 2.5 插件系统与 SDK

- `@opencode-ai/plugin`：ProviderContext / WorkspaceAdapter（create/remove/target）/ PluginInput（client+project+directory）/ tool 定义导出；TUI 运行时探测插件（`plugin-route-missing` 组件）。
- 插件以 `opencode.jsonc` 配置（.opencode/ 目录自带自身配置、主题、glossary、skills）。
- SDK 从 `openapi.json` 生成（`bun run generate`），生成产物进 git，`check:generated` 在 CI 强制"生成结果一致"。

### 2.6 多端形态

- TUI（SolidJS + opentui，keymap 可配置）、Web（app，SolidStart SSR）、桌面（Electron 包装 app）、Server（headless，`opencode serve`，端口 4096）、Slack、ACP（Agent Client Protocol，`opencode acp`）。

---

## 3. 功能全景（README + CLI + specs 提炼）

### 3.1 CLI 子命令（20+）

`run / generate / serve / web / attach / tui / session / db / mcp / plugins / github / pr / export / import / account(auth) / providers / models / agent / acp / stats / upgrade / uninstall / debug`，含 shell completion、`--pure`（禁用外部插件）、日志分级。

### 3.2 交互与 Agent 能力

- TUI：会话列表/重命名/删除、模型/提供方切换、主题、命令面板、终端（PTY）、音视频输入、编辑器集成（VS Code/Zed）、剪贴板。
- Agent 体系：agents + 子代理（subagent-permissions）、agent 生成模板、skills（skill 注册表）、todo/plan 工具、共享会话（share + enterprise 路由）、快照（snapshot）、worktree、项目目录隔离（project-directories）。
- 权限系统：bash/write 等动作的确认策略（V1 permission + V2 PermissionV2），明确**非沙箱**立场（见 SECURITY 威胁模型）。
- MCP：客户端接入 + 配置对话框；LSP：语言服务集成（lsp.ts + lsp-event）。
- 自托管：headless server + HTTP API（OpenAPI 文档 + 生成 SDK）+ Web UI；`opencode attach` 连接远程 server。

### 3.3 模型与 Provider

- 第一方：anthropic、openai、google、azure、openrouter、xai、amazon-bedrock、cloudflare、github-copilot、mistral、gitlab、opencode（自家模型目录）。
- 兼容层：openai-compatible profile（自定义 URL/鉴权），覆盖本地模型与网关。
- 模型目录外置 models.dev，支持自定义模型名解析与 variants。

---

## 4. 工程质量

### 4.1 测试体系

- **699 个测试文件**分布：opencode 245、app 176、core 141、tui 45、llm 30、session-ui 14、desktop 13、codemode 7、其余各包 <7。
- 框架分层：
  - 单元/集成：`bun test`（core/opencode/llm 直接用 bun test，UI 配 happydom preload）
  - 浏览器层测试：`bun test --conditions=browser`
  - e2e：Playwright（`packages/app/e2e`，双平台跑 Chromium，产物归档 7 天）
  - 性能/稳定性：`test:bench`、`test:stability`（视觉稳定性 + 时间轴稳定性基准）
- **CI（26 个 workflow，双平台矩阵 Linux+Windows）**：
  - `test.yml`：unit（Linux+Windows）+ e2e（Linux+Windows）+ 生成客户端一致性检查 + HttpApi 练习器 gate（`test:httpapi`，三种模式 coverage/auth/effect，缺覆盖即失败）
  - `typecheck.yml`：`bun typecheck`（turbo 全包，tsgo）
  - `opencode.yml`：issue/PR 评论 ` /oc` 触发自家产品执行任务（dogfooding）
  - `review.yml`：`/review` 评论触发维护者审查流水线
  - `pr-standards.yml`：自动校验 PR 标题/描述规范（非团队成员强制执行）
  - 运营类：triage / duplicate-issues / close-issues / close-prs / pr-management / beta / publish / docs-locale-sync / docs-update / containers / deploy / nix-eval / nix-hashes / notify-discord / publish-vscode / release-github-action / publish-github-action / generate / stats / storybook / compliance-close
- Turbo 缓存进 CI cache；`GITHUB_ACTIONS=false` 规避测试环境变量污染；Windows 上禁用 filewatcher 的实验性开关。

### 4.2 类型与静态检查

- 类型检查：`tsgo`（TypeScript 原生预览编译器，`--noEmit`），全仓 turbo 并行。
- Lint：oxlint（`typeAware: true`）——类型感知的未处理 Promise / 错误 spread 检查；对 Effect（require-yield）、SolidJS（no-unused-expressions）等做针对性豁免，规则理由全部注释在 `.oxlintrc.json` 里（每条豁免可审计）。
- 风格：prettier（semi:false, printWidth:120）；AGENTS.md 有成文的风格指南（免 else、免 try/catch、避免 any、Bun API 优先、单一函数职责、Effect 生成器绑定命名变量等）。
- 生成代码纪律：`src/generated` 禁止手改，`check:generated` 强制无漂移。

### 4.3 文档体系（三件套 + specs）

- `AGENTS.md`（8.9KB）：仓库约定（分支名 ≤3 词、conventional commit、生成代码流程、依赖方向）+ 完整风格指南 + **V2 Session 核心的设计约束清单**（可勾选的实现进度表，驱动增量开发）。
- `CONTEXT.md`（32KB）：会话运行时的**术语总表**（System Context / Session History / Context Epoch / Safe Provider-Turn Boundary / Session Drain……每个术语带 "Avoid" 反例），是跨团队沟通的契约文件。
- `specs/`：`v2/` 全量设计规范（session / tools / provider-model / provider-policy / config / catalog-config-plugin-lifecycle / instructions / todo / schema-changelog / api.html）+ `storage/` 存储演进 + `project.md` + `tui-package.md`。规范用代码块写 API 契约、用 ASCII 时序图画状态机，是"先规范后实现"的活文档。
- 代码内注释：核心模块顶部写"意图 + 未完成项清单"（如 runner/llm.ts 的 slice 进度），中文社区不适用但模式可学。

### 4.4 国际化

- README **21 种语言**（含简体/繁体中文、阿拉伯语 RTL、孟加拉语等），且 `docs-locale-sync.yml` 自动同步各语言版本文档（有翻译管理脚本 `translate-app.ts`）。

### 4.5 其他工程细节

- husky pre-push 钩子；`.gitleaksignore`（密钥扫描豁免表）；`.editorconfig`、`.vscode` 与 `.zed` 编辑器配置、`.opencode/` 自用配置（dogfooding）。
- 依赖治理：catalog 统一版本 + overrides + 16 个 patch（含 effect、solid-js、MCP SDK 补丁），Windows 下 node-pty 修复脚本（postinstall）。

---

## 5. 开源成熟度

| 项目 | 内容 |
| --- | --- |
| 许可证 | MIT |
| CONTRIBUTING.md | issue-first 政策（PR 必须挂 issue，否则可能直接关闭）、PR 标题规范、UI 改动需截图、逻辑改动需自证验证、**拒绝 AI 堆砌长文**、vouch/denounce 信任体系（`.github/VOUCHED.td`，维护者评论 `vouch`/`denounce` 自动执行）、issue 模板强制（不满足 2 小时后自动关闭） |
| SECURITY.md | **威胁模型文档**：明确无沙箱立场（权限系统是 UX 不是隔离）、server 模式责任边界、Out of Scope 清单、**不接受 AI 生成的漏洞报告（自动拉黑）**、私密披露流程 |
| Issue 模板 | bug / feature / question 三类，自动校验（模板合规检查 workflow） |
| 发布流程 | `publish.yml`：version 脚本（bump major/minor/patch + override）→ build-cli 单二进制 → 多平台产物（npm / scoop / choco / brew / pacman / mise / nix / GitHub Action / VS Code 插件 / 桌面安装包 / containers 镜像）；beta 分支发布到独立仓库；changelog 自动生成（script/changelog.ts） |
| 安装 | 手写 `install` 脚本（14KB，多平台下载 + 路径策略 + 版本参数） |
| 社区 | Discord（README 徽章）、stats 包做数据运营、issue 自动分诊/去重/关闭的完整 bot 矩阵 |
| 自举 | 用自家产品跑 PR review、issue 评论 `/oc` 执行任务、`.opencode/` 自家配置开源——**产品即工作流** |

---

## 6. 四维评级与理由

### 6.1 功能完成度：A+

理由：单仓库同时交付 CLI（20+ 子命令）、TUI、Web、桌面、Server、Slack、ACP 七种形态；模型生态覆盖 10+ provider 与 OpenAI 兼容层；Agent 子代理、Skills、MCP、LSP、权限、快照、worktree、共享会话、控制台/企业版均有实现与 UI；插件 + SDK 让第三方可扩展。功能不是"demo 级"，而是从安装脚本到 CI 自举都有产品闭环。

### 6.2 架构成熟度：A+

理由：依赖方向单向且有 AGENTS.md 强制；会话层做事件溯源（受理/提升两阶段、Context Epoch、Location 作用域、跨进程工具遗留处理），并允许 V1/V2 并行 + bridge 过渡；模型层协议与 provider 解耦；契约优先（schema 包 + OpenAPI 生成 + check:generated）；Effect 4 提供结构化并发与类型级错误路径。属"系统性设计过"的架构，不是自然生长的堆积。

### 6.3 工程质量：A+

理由：699 测试 + 双平台 CI + Playwright e2e + tsgo + type-aware oxlint + 生成代码一致性 gate + HttpApi 覆盖 gate + 性能/稳定性基准；CI 矩阵细分 26 个 workflow；对每一条 lint 豁免有书面理由。唯一减分点：V1 与 V2 并存带来概念双重性（同义词表 CONTEXT.md 用大量 "Avoid" 处理），属演进期正常状态，不构成评级下调。

### 6.4 开源运营：A+

理由：MIT + 21 语言 README + 自动本地化同步 + 完整贡献治理（issue-first、vouch 体系、模板强制、拒绝 AI 长文）+ 威胁模型文档 + 多平台发布自动化 + 自家产品自举。属于"把开源当产品经营"的顶级水平。

---

## 7. 可借鉴点清单（对 conex/crish）

### 7.1 架构层

1. **会话持久化事件溯源化**：conex 的 session-loop 目前是进程内循环 + 存储写模型；可参照"受理（input）与可见（message）两阶段 + 事件序列 + 投影器原子提交"设计，先落 SQLite 事件表再接跨进程恢复。
2. **单轮一次 LLM 请求**：conex 的 orchestrator 应保证"一个 provider 回合恰好一次 llm 调用"，避免循环内多次重试/重入；工具结算后显式续轮。
3. **Location 作用域**：把模型解析、工具注册表、权限、文件系统按项目目录（location）分组缓存，而不是进程全局——多项目并发时会话天然隔离。
4. **契约优先 + 生成防漂移**：把 Rust 内核的 API 定义成契约文件（类比 openapi.json），生成 TS 客户端，CI 校验"生成结果一致"。conex 前端 ts 包与 Rust 的 session-* 命名已对齐，缺的是生成链。
5. **V1→V2 桥接**：conex 正处在 Rust 重写的过渡期，可学 opencode 的 bridge 事件模式（新老事件共存，同一消费端），而非一次性大切换。

### 7.2 工程层

6. **测试三明治**：core 用 bun/原生 test、UI 用 happydom、端到端 Playwright；conex 目前前端 vitest 基线还有 4 个失败文件（oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf），可先清零再补 e2e。
7. **双平台 CI + 产物缓存**：opencode 测试矩阵 Linux+Windows，turbo 缓存进 actions/cache；conex 若只跑 Linux CI，Windows 特有问题（路径/PTY）会漏。
8. **lint 豁免必须书面化**：每一条禁用的 lint 规则配理由注释（可审计、可复议）；conex 的 ruff/oxlint 配置可对齐此纪律。
9. **HttpApi 覆盖 gate**：对对外 API 做"每条路由都被测试练习"的覆盖检查（test:httpapi），防止接口无人测试。
10. **工具输出有界 + 溢出文件**：大输出落盘 + 投影回模型，防止上下文爆炸。

### 7.3 文档与协作层

11. **CONTEXT.md 术语总表**：conex 的 docs/rust-rewrite 已有一致术语（session-loop/orchestrator），可产出一份带 "Avoid" 反例的术语契约，约束多 Agent 协作表述。
12. **AGENTS.md 里放"核心设计约束 + 实现进度勾选表"**：把 V2 session 的设计不变量写成可勾选项，让子 Agent 与后续开发增量对齐（conex 的 AGENTS.md 已有此雏形，可强化不变量清单）。
13. **specs/v2 模式**：先写契约文档（API 代码块 + ASCII 时序图）再实现；conex 的 plans/PE-*.md 是任务书粒度，可升级为"规范粒度"。

### 7.4 开源运营层

14. **威胁模型 SECURITY**：即使不开源，也应有"权限系统非沙箱"的责任边界声明（对安全评审/客户沟通都有价值）。
15. **Issue 模板强制 + 自动关闭**：模板校验 bot 显著降低维护成本。
16. **多语言 README + 同步流水线**：如果开源，语言列表应配自动同步（文档翻译脚本 + locale-sync workflow）。
17. **自举**：用 conex 自己跑仓库的 issue 分诊/review 任务，产品即工作流（opencode 的 `/oc` 模式）。
18. **发布流水线自动化**：version 脚本 + changelog 生成 + 多平台产物矩阵一次发布（conex 目前发布过程若还是手工，是最大差距项之一）。

---

## 8. 附录：调研证据索引（抽查文件）

| 证据 | 位置 |
| --- | --- |
| 包清单与依赖 | `packages/*/package.json`、根 `package.json`（workspaces/catalog/patches） |
| monorepo 任务 | `turbo.json` |
| CLI 入口与命令 | `packages/opencode/src/index.ts`、`src/cli/cmd/` |
| V2 会话运行器 | `packages/core/src/session/runner/llm.ts`（顶部含 slice 进度注释） |
| 事件溯源 | `packages/core/src/event.ts`、`packages/schema/src/event-manifest.ts`、`src/durable-event-manifest.ts` |
| V1→V2 桥 | `packages/opencode/src/event-v2-bridge.ts` |
| 模型层 | `packages/llm/src/route/`、`src/providers/`、`src/protocols/` |
| 工具双轨 | `packages/core/src/tool/`（V2）、`packages/opencode/src/tool/`（V1，含 .txt 说明） |
| 插件 API | `packages/plugin/src/index.ts` |
| 规范 | `specs/v2/session.md`、`tools.md`、`provider-model.md` |
| 文档体系 | 根 `AGENTS.md`、`CONTEXT.md`、`CONTRIBUTING.md`、`SECURITY.md` |
| CI | `.github/workflows/`（26 个：test/typecheck/publish/beta/pr-standards/review/opencode/...） |
| 测试规模 | 全仓 `*.test.ts / *.spec.ts / *.test.e2e.ts` 统计 699 个 |
| 国际化 | `README.*.md` 21 种 + `docs-locale-sync.yml` |
| 发布与安装 | `script/version.ts`、`script/changelog.ts`、`install`（14KB 安装脚本） |

> 备注：本地克隆为浅历史（371 条 commit），commit 数不代表上游真实规模；评级基于代码与配置的静态质量，不受此影响。
