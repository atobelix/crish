# Conex 全量检查命令清单（FULL_CHECK_COMMANDS）

> **核心指令**：重大重构 / 迭代轮次收口前，必须跑通本清单中的全部门禁。本文件只收录仓库**现行真实存在的命令**，新增门禁时同步追加，命令退役时同步移除——不收录臆造命令。

---

## 快层（CI 强制 · 每次改动必跑）

| 命令 | 内容 |
| :-- | :-- |
| `npm run typecheck` | 全仓 TS 静态类型检查（desktop / workbench / shared-types / shared-utils） |
| `npm run test:coverage -- --project=unit` | vitest unit 项目全量（coverage） |
| `npm run check:line-counts` | 行数门禁（UI ≤500 / 业务 ≤400 / 类型 ≤800 / 硬阻断 650） |
| `npm run check:store-types` | Zustand store 专属类型防线（禁 `as any` 逃逸） |
| `npm run lint:depcruise` | 依赖解耦与零循环依赖检测 |

## 中层（vitest 全量 + 集成）

| 命令 | 内容 |
| :-- | :-- |
| `npm run test` | vitest 全量（desktop + workbench） |
| `npx vitest run --config vitest.integration.config.ts` | 集成项目（F3 四目录） |

## Rust 全量

| 命令 | 内容 |
| :-- | :-- |
| `cargo test --workspace -j 1` | 全部 Rust crate + workbench 二进制测试（**-j 1 必带**：Windows 页面文件余量有限，默认并行编译曾 OOM 中断并留下「产物损坏」假象） |
| `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml -j 1` | workbench 壳静态检查 |

## 结构性检查（契约门禁）

| 命令 | 内容 |
| :-- | :-- |
| `npm run check:conflict-markers` | 冲突标记残留扫描 |
| `npm run check:css-encoding` | CSS 编码契约 |
| `npm run check:convergence` | 前端收敛检查 |
| `npm run check:input-guard` | 输入框四态防倒退 + binary-tree 条带动效单轨守卫（幽灵 token / 布局属性 keyframes 拦截） |
| `npm run check:ui-layer` | 前端分层解耦检查 |
| `npm run check:swallowed-errors-frontend` | 前端吞错审计 |
| `npm run check:async-commands` | U-BLOCK：壳 fs 命令 async + 工具 spawn_blocking 纪律 |
| `npm run check:gatekeeper-shared` | U-GATE：生产路径禁 per-call `CommandGatekeeper::new` |
| `npm run check:session-upsert` | 探针 A：session_messages / session_agents 全量清空刚性拦截（详案 06 §5.1） |
| `npm run check:tool-pairing` | 探针 B：工具成对 / converge 孤儿守卫 / restore 消极对账绝迹（详案 06 §5.2） |
| `node scripts/check-provider-single-track.mjs` | 单轨收敛防御网 **D1–D9 + D11 + D12**：① D1 连通（生产代码零引用已退役符号 7 个，注释与 `#[cfg(test)]` 不计）；② D2 构建（全量 cargo 必须钉 `-j 1`、主二进制检查不可移除、CI 不得 `continue-on-error`/`\|\| true`）；③ D3 契约（read 回执守卫强制 revision/credentialStates/hasKey + 4 类负向断言）；④ D7 协议（规范集合外写出即红，旧名 `google/interactions` 仅限 `modelsLsImport` 升级边界）；⑤ D8 孤岛（旧 LS 写口岛外**新增**即红；`localStorage.setItem` 写文件须登记，当前 32 个）；⑥ D9 思考（未声明档位 → 引导态不降级不出站；词表外键 → 显式诊断）；⑦ D11 注册（四方命令集合对齐：`command_manifest.rs` ↔ `main.rs command_registry!` ↔ 前端注册表 ↔ 前端内置快照，当前各 142 条；任一侧缺失/多出/重名即红）；⑧ D12 资产（门禁脚本引用必须存在；被 `.gitignore` 永久排除的幽灵脚本即红）；⑨ D4/D5/D6 见下。**注入自检已验证 D1–D9 全部能红**（D2 曾因「扫整行被注释里的 `-j 1` 骗过」而假阴性，已修为只取反引号内命令本体）；**D11/D12 亦已注入自检能红**（D11 两处注入：前端注册表改名 / manifest registered 置 false，均 exit=1；D12 首扫即抓到 `scripts/block-workspace-perf.mjs` 幽灵脚本）。**D10（样式）尚未建** |
| `node scripts/check-provider-single-track.mjs --guide <D1\|D2\|D3\|D7\|D8\|D9\|D11\|D12\|D4\|D5\|D6>` | 打印对应防线的**正确做法指引**（违反项 / 文件:行号 / 当前值与阈值 / 修复步骤） |
| `node scripts/check-db-write-bypass.mjs` | 探针 C：conex-db 写旁路扫描 + 业务豁免清零（详案 06 §5.3；尚无独立 npm 别名） |

## E2E 与专项

| 命令 | 内容 |
| :-- | :-- |
| `npm run test:e2e` | Playwright E2E（tests/e2e） |
| `npm run test:e2e:native` | Tauri 原生冒烟 |
| `npm run test:e2e:webview` | WebView 专项（playwright config） |

## 已知失败基线登记（整改完成后应趋零）

| 命令 | 失败项 | 状态 |
| :-- | :-- | :-- |
| `cargo test --workspace -j 1` | 全部 | ✅ 已清零（161 套件 / 6322 测试全绿） |
| `npm run test:coverage -- --project=unit` | chat-bridge / approval / conversation-flow / workspace / store / styles 等 33 文件 | ⏳ 存量失败（与模型能力战役无关，属其它并行批次；S1-S9 影响面已全绿） |
