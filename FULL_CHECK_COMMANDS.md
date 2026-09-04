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
| `cargo test --workspace` | 全部 Rust crate + workbench 二进制测试 |
| `cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml` | workbench 壳静态检查 |

## 结构性检查（契约门禁）

| 命令 | 内容 |
| :-- | :-- |
| `npm run check:conflict-markers` | 冲突标记残留扫描 |
| `npm run check:css-encoding` | CSS 编码契约 |
| `npm run check:convergence` | 前端收敛检查 |
| `npm run check:swallowed-errors-frontend` | 前端吞错审计 |

## E2E 与专项

| 命令 | 内容 |
| :-- | :-- |
| `npm run test:e2e` | Playwright E2E（tests/e2e） |
| `npm run test:e2e:native` | Tauri 原生冒烟 |
| `npm run test:e2e:webview` | WebView 专项（playwright config） |

## 已知失败基线登记（整改完成后应趋零）

| 命令 | 失败项 | 状态 |
| :-- | :-- | :-- |
| `cargo test --workspace` | 全部 | ✅ 已清零（161 套件 / 6322 测试全绿） |
| `npm run test:coverage -- --project=unit` | chat-bridge / approval / conversation-flow / workspace / store / styles 等 33 文件 | ⏳ 存量失败（与模型能力战役无关，属其它并行批次；S1-S9 影响面已全绿） |
