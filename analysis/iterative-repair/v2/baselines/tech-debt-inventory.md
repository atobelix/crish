# Crish 技术债清单（Round 1 基线）

> 采集时间：2026-07-30
> 数据来源：`01-OVERVIEW.md` §1.2/§2.1/§2.2、`03-ERROR-MIGRATION.md` §0.2/§1/§3.5、`tsc-errors-baseline.json`、`throw-inventory.json`、`dependency-graph-baseline.json`、vitest 测试运行结果

---

## 1. 错误处理债务

| 债项 ID | 描述                                                                                                                                     | 量化                                                                         | 来源                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| E-01    | `throw new Error` 使用裸 Error，无错误码、无 retryable 标记、无 category 分类                                                            | 250 处 / 96 文件（源码 177 处/61 文件 + 测试 73 处/35 文件）                 | 03-ERROR-MIGRATION.md §0.2                           |
| E-02    | `TOOL_ERROR` 是"垃圾箱"码，49 处 throw 中混合 transient/permanent、retryable/non-retryable、路径校验/执行失败/入参校验三种本质不同的故障 | 49 处 / 6 文件                                                               | 03-ERROR-MIGRATION.md §1.4                           |
| E-03    | `ProviderErrorKind` 12 个 kind 既是分类标签又是错误码，职责重叠                                                                          | 12 个 kind 值                                                                | 03-ERROR-MIGRATION.md §1.3                           |
| E-04    | Rust `CoreError` 6 variant 与 TS `CrishError` 序列化格式不统一，跨进程错误传播丢失结构化信息                                             | CoreError 6v / IpcError 4v / MarkdownError 2v / StreamError 1v / NetError 2v | 03-ERROR-MIGRATION.md §1.5、§3.6-3.10                |
| E-05    | 31 个自定义 Error 子类散落在 agent-runtime/agent-daemon/agent-orchestrator，无统一基类契约                                               | 31 类                                                                        | 03-ERROR-MIGRATION.md §3.5                           |
| E-06    | `CrishError.code` 为裸 string，无分域错误码（`domain.reason` 格式），无法在序列化层做域路由                                              | 全局                                                                         | 01-OVERVIEW.md §2.1 S-03                             |
| E-07    | 无 `CrishResult<T>` ADT，公共 API 边界用 throw 传播错误，调用方无法显式处理失败                                                          | 全局                                                                         | 01-OVERVIEW.md §2.2 F-08                             |
| E-08    | 无跨进程序列化标准（`CrishErrorPayload`），`IpcResponse.error` 为 `Option<String>` 裸字符串                                              | Rust crates/conex-types                                                      | 01-OVERVIEW.md §2.2 F-07、03-ERROR-MIGRATION.md §6.3 |
| E-09    | `throw new CrishError` 使用旧自由字符串码（`CHECKPOINT_ERROR`/`BOUNDARY_ERROR`/`ADAPTER_ERROR` 等），无域前缀                            | 82 处 / 11 文件                                                              | 03-ERROR-MIGRATION.md §0.2                           |
| E-10    | `throw new ProviderError` 使用 `CONFIG_ERROR`/`NETWORK_ERROR`/`DAEMON_DEAD` 及动态 `kind` 作为 code                                      | 25 处 / 4 文件                                                               | 03-ERROR-MIGRATION.md §0.2                           |
| E-11    | `throw new SessionError` 使用无域前缀的 `SessionErrorCode`（`not_found`/`invalid_session` 等）                                           | 31 处 / 5 文件                                                               | 03-ERROR-MIGRATION.md §0.2                           |
| E-12    | `session.storage` 旧码错误标记为 permanent+non-retryable，实际存储失败多为 IO/锁问题应可重试                                             | 语义错误                                                                     | 03-ERROR-MIGRATION.md §3.1                           |
| E-13    | `conex-fs` Rust crate 无结构化错误类型，全部使用 `anyhow::Result`                                                                        | 0 结构化错误                                                                 | 03-ERROR-MIGRATION.md §3.11                          |

## 2. 类型安全债务

| 债项 ID | 描述                                                                                                                                         | 量化                 | 来源                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| T-01    | TSC 编译错误（当前实测去重后唯一错误）                                                                                                       | 20 个唯一错误        | tsc-errors-baseline.json                                                    |
| T-02    | TSC 编译错误（01-OVERVIEW.md §1.2 基线值，与当前实测存在差异）                                                                               | 315 个（基线文档值） | 01-OVERVIEW.md §1.2                                                         |
| T-03    | `exactOptionalPropertyTypes` 引发的错误：`readonly` 属性赋值（`metadata`/`cause`/`stack`）                                                   | 4 个 TS2540 错误     | tsc-errors-baseline.json（shared-types/src/errors/serialize.ts）            |
| T-04    | `verbatimModuleSyntax` 引发的错误：`import type` 导入的符号被用作值                                                                          | 2 个 TS1361 错误     | tsc-errors-baseline.json（shared-types/src/errors/result.ts）               |
| T-05    | 未使用的导入/变量声明                                                                                                                        | 9 个 TS6133 错误     | tsc-errors-baseline.json（shared-utils 测试文件 + shared-types/classes.ts） |
| T-06    | 模块导出缺失：`ConfigSource` 声明但未导出                                                                                                    | 1 个 TS2459 错误     | tsc-errors-baseline.json（decision-engine）                                 |
| T-07    | 属性不存在于类型：`SessionState.workspacePath`、`SessionFacade.deleteSession`                                                                | 2 个 TS2339 错误     | tsc-errors-baseline.json（crish-desktop）                                   |
| T-08    | 类型不兼容赋值：`string \| undefined` 不可赋值给 `string`                                                                                    | 2 个 TS2322 错误     | tsc-errors-baseline.json（crish-desktop/FileViewerCard.tsx）                |
| T-09    | 01-OVERVIEW.md §1.2 记录的错误类型分布与当前实测不符（历史基线含 TS2375/TS2379/TS2532/TS18048/TS2307/TS2305/TS1484/TS7006 等，当前均未出现） | 分布差异             | 01-OVERVIEW.md §1.2 vs tsc-errors-baseline.json                             |

## 3. 架构债务

| 债项 ID | 描述                                                                                            | 量化                 | 来源                                     |
| ------- | ----------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------- |
| A-01    | `agent-runtime` ~31K LOC 单体包，~220 文件混合 provider/tools/mcp/context/subagent 等无关关注点 | ~31K LOC / ~220 文件 | 01-OVERVIEW.md §1.1、§2.1 S-01           |
| A-02    | `plugin-sdk` 仅 17 行、4 个 `any` 钩子，无法支撑插件生态                                        | 17 行 / 1 文件       | 01-OVERVIEW.md §1.1、§2.1 S-02           |
| A-03    | 日志和追踪分散在 `shared-utils/logger` + `agent-runtime/trace` + `daemon/daemon-logger` 三处    | 3 处分散             | 01-OVERVIEW.md §2.1 S-04                 |
| A-04    | 子代理系统缺少 DeadlockDetector 和完整调度器                                                    | 缺失                 | 01-OVERVIEW.md §2.1 S-05、§2.2 F-05/F-06 |
| A-05    | Provider 系统散落在 `provider*/` + `openai-*.ts` + `anthropic-*.ts` + `gemini-*.ts` 等 57 文件  | 57 文件              | 01-OVERVIEW.md §2.1 S-07                 |
| A-06    | `decision-engine` 与 `agent-permissions` 的 `command-classification` 职责重叠                   | 职责重叠             | 01-OVERVIEW.md §2.1 S-09                 |
| A-07    | 无结构化文件日志（RotatingFileSink）+ Windows 文件锁处理                                        | 缺失                 | 01-OVERVIEW.md §2.2 F-01                 |
| A-08    | 无 Rust 端 telemetry crate                                                                      | 缺失                 | 01-OVERVIEW.md §2.2 F-02                 |
| A-09    | 插件无法注册自定义工具、无 MCP 服务器声明能力                                                   | 缺失                 | 01-OVERVIEW.md §2.2 F-03/F-04            |
| A-10    | 无统一的 Tauri command 错误传播格式                                                             | 缺失                 | 01-OVERVIEW.md §2.2 F-07                 |

## 4. 测试债务

| 债项 ID | 描述                                                                                                                                                                                                                               | 量化                | 来源                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Q-01    | 全仓库测试用例总数 6191，通过 6132，失败 54，跳过 5                                                                                                                                                                                | 54 失败 / 6191 总计 | vitest 运行结果（test-coverage-baseline.json）                     |
| Q-02    | crish-desktop 测试失败最多（29 失败 / 3669 总计）                                                                                                                                                                                  | 29 失败             | vitest 运行结果                                                    |
| Q-03    | agent-runtime 测试失败 11 处（1577 总计）                                                                                                                                                                                          | 11 失败             | vitest 运行结果                                                    |
| Q-04    | agent-daemon 测试失败 8 处（429 总计）                                                                                                                                                                                             | 8 失败              | vitest 运行结果                                                    |
| Q-05    | decision-engine 测试失败 3 处（106 总计）                                                                                                                                                                                          | 3 失败              | vitest 运行结果                                                    |
| Q-06    | Vitest 覆盖率基线：vitest.config.ts 中 coverage.enabled=false；vitest.workspace.ts 中 3 个 project 各有 coverage 配置但无 include/exclude；CLI --coverage 显示 'Coverage enabled' 但不生成报告（workspace 模式 coverage 报告 bug） | 配置缺陷 + 报告 bug | vitest.config.ts、vitest.workspace.ts、test-coverage-baseline.json |
| Q-07    | 覆盖率阈值：全局 statements 50%/branches 40%/functions 50%/lines 50%（package.json）；workspace 项目 statements 70%/branches 60%/functions 65%/lines 70%（vitest.workspace.ts）                                                    | 全局 + 项目阈值     | package.json、vitest.workspace.ts                                  |

## 5. 依赖管理债务

| 债项 ID | 描述                                                                                                                   | 量化                | 来源                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------ |
| D-01    | 循环依赖当前为 0（depcruise 确认），拆分过程中必须保持                                                                 | 0 violations        | dependency-graph-baseline.json |
| D-02    | `agent-daemon` 依赖 5 个内部包（agent-orchestrator/agent-runtime/decision-engine/shared-types/shared-utils），耦合度高 | 5 条依赖边          | dependency-graph-baseline.json |
| D-03    | `agent-workbench` 依赖 `@crish/crish-desktop`（app 间依赖），增加构建耦合                                              | 1 条 app→app 依赖   | dependency-graph-baseline.json |
| D-04    | `agent-runtime` devDependency 依赖 `shared-utils`，但生产依赖仅 decision-engine + shared-types                         | devDep/prodDep 混用 | dependency-graph-baseline.json |
| D-05    | `test-utils` devDependency 依赖 `agent-runtime`，测试工具包耦合运行时包                                                | 1 条 devDep 边      | dependency-graph-baseline.json |

## 6. 迁移追踪债务

| 债项 ID | 描述                                                                                                                      | 量化               | 来源                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------- |
| M-01    | throw 迁移总量：250 处 `throw new Error` + 141 处 `throw Crish*` 子类 = 391 处                                            | 391 处             | throw-inventory.json            |
| M-02    | 迁移按包分布：agent-runtime 245 处（最大工作量）、agent-daemon 39 处、agent-orchestrator 28 处                            | 318 处源码 throw   | throw-inventory.json            |
| M-03    | P0 高优先级迁移（throw >= 10）：fs-edit-tools 3 文件 + lsp-tools + rich-read + local-tools/shared = 6 文件                | 6 文件 / ~76 throw | throw-inventory.json            |
| M-04    | `TOOL_ERROR` 49 处需按故障性质拆分为 4 个新码（tool.execution_failed/tool.path_escape/tool.invalid_input/tool.not_found） | 49 处 → 4 码       | 03-ERROR-MIGRATION.md §3.4      |
| M-05    | 31 个自定义 Error 子类需在 Round 3-11 逐包迁移到 `CrishError(code=新码)`                                                  | 31 类              | 03-ERROR-MIGRATION.md §3.5      |
| M-06    | Rust 端 5 个错误枚举需在 Round 10 对齐为 `CrishErrorPayload`                                                              | 5 枚举             | 03-ERROR-MIGRATION.md §3.6-3.10 |

## 7. 基线差异说明

| 项                | 文档基线值                                                      | 当前实测值                                                           | 差异原因                                                                                                                               |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| TSC 错误数        | 315（01-OVERVIEW.md §1.2）                                      | 20（tsc-errors-baseline.json）                                       | 315 基线为早期测量值；当前采集采用逐包 tsc + (file,line,col,code) 四元组去重，消除 project references 跨包重复计数；部分历史错误已修复 |
| throw 总数        | 250 处/96 文件（01-OVERVIEW.md §1.2）                           | 250 处/96 文件（throw-inventory.json）                               | 一致，无差异                                                                                                                           |
| Crish* 子类 throw | 141 处/22 文件（01-OVERVIEW.md §1.2）                           | 141 处/22 文件（throw-inventory.json）                               | 一致，无差异                                                                                                                           |
| 循环依赖          | 0（01-OVERVIEW.md §1.2）                                        | 0（dependency-graph-baseline.json）                                  | 一致，无差异                                                                                                                           |
| 测试覆盖率阈值    | orchestrator 70% stmt / runtime 50% stmt（01-OVERVIEW.md §1.2） | 全局 50% stmt / 40% branches / 50% funcs / 50% lines（package.json） | 文档描述的 per-package 阈值在当前配置中未找到，实际为全局阈值                                                                          |

---

## 清理计划对应关系

| 债项分类           | 对应 Round                              | 清理动作                                                             |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------- |
| 错误处理 E-01~E-13 | R1（共存）→ R3-R11（迁移）→ R12（删除） | 三阶段策略：R1 建立新类型体系，R3-R11 逐包迁移 throw，R12 删除旧类型 |
| 类型安全 T-01~T-09 | R3-R11                                  | 随拆分过程逐步修复，R11 降至 < 50                                    |
| 架构 A-01~A-10     | R2-R9                                   | 九包拆分 + 新建包 + 重建 plugin-sdk                                  |
| 测试 Q-01~Q-07     | R3-R11                                  | 随各包迁移修复失败测试，覆盖率不下降门禁                             |
| 依赖 D-01~D-05     | R3-R5                                   | 拆分后验证拓扑正确性，消除 app→app 依赖                              |
| 迁移 M-01~M-06     | R1-R12                                  | 见 throw-inventory.json 的 migrationRoundByPackage                   |
