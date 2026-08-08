# tests/ 门禁体系索引

> 门禁全设计见 `docs/analysis/03-测试门禁体系.md`；测试修正见
> `docs/analysis/09-方案修订终版.md` §3；断言点覆盖追踪见 `tests/coverage-tracker.md`。
> 本索引维护 G1-G10 各类别的目录映射与执行命令，状态列随各轮落地更新。

## 分层架构速览

九类门禁 + 交叉矩阵（X1，即 G10），按"验证深度 × 执行成本"分层。
断言强度：B = 黑箱（公开 API/DOM/指标），G = 灰箱（data-* 映射契约），W = 白箱（内部结构，仅限不变量核心）。

## G1-G10 分类表

| 门禁类 | 代码 | 内容 | 断言强度 | 执行时机 | 目录 |
|---|---|---|---|---|---|
| G1 core 不变量 unit | U1 | 现有 126 例加固 + 不变量工具集 | W/G | pre-commit + CI fast | `tests/unit/` |
| G2 属性测试（fuzz） | U2 | 随机文档 × 随机操作 × 不变量 | G | CI fast（固定种子）+ nightly | `tests/property/` |
| G3 渲染层 RTL | R1 | 4 组件 DOM/class/data-* 契约 | G | CI mid | `tests/render/` |
| G4 行为契约 | R2 | store/parser 公开行为语义 | B | CI mid | `tests/contract/` |
| G5 CommonMark 符合度 | C1 | 652 例 AST 语义级 + 基线门槛 | G/B | CI mid + nightly | `tests/commonmark/` |
| G6 CSS 契约 | C2 | 选择器存在性 + 关键样式契约 | G | CI mid | `tests/css/` |
| G7 运行时 Playwright | E1 | 滚动/光标/IME/表格/金样/随机交互 | B/G | CI slow + nightly | `tests/e2e/` |
| G8 性能门禁 | P1 | 帧率/长任务/layoutThrash/解析耗时 | B | CI slow（降档）+ nightly | `tests/e2e/perf/` |
| G9 内存门禁 | M1 | 缓存有界/无泄漏/大文档 | B | nightly（heap-growth 除外均 CI） | `tests/e2e/perf/` |
| G10 交叉矩阵 | X1 | 文档类型 × 操作 × 模式组合 | B | nightly | `tests/e2e/cross-matrix.spec.ts` |

## 目录映射

```
tests/
  gate/                    # 门禁骨架占位（G1-G10 各 1 例，本轮落地产物）
  unit/                    # 现有 25 文件保留不动（G1）
  property/                # U2 属性测试（generators.ts / invariants.ts 共享）
  render/                  # R1 渲染层 RTL（jsdom）
  contract/                # R2 行为契约
  commonmark/              # C1（spec.json / astToHtml.ts / baseline.json）
  css/                     # C2（class-inventory / style-contract）
  e2e/                     # E1 —— 现有 18 spec 保留
  e2e/perf/                # P1 / M1（独立目录，不进默认 testDir 扫描）
  README.md                # 本索引
  coverage-tracker.md      # 断言点覆盖追踪表
```

## 执行命令

| 命令 | 内容 | 状态 |
|---|---|---|
| `npm run test:gate` | 快层门禁：`tests/gate`（骨架占位 10 例）+ `tests/unit`（现有 126 例） | ✅ 已接线，全绿 |
| `npm run test` | 现有语义保留：`vitest run tests/unit` | ✅ 既有命令，未改动 |
| `npm run test:color` | 颜色字面量门禁（既有） | ✅ 既有命令，未改动 |
| `npm run test:commonmark` | CommonMark 跑分：`node tests/commonmark/run-compliance.mjs` | ⏳ 待接线（R0-B 产物未就绪，落地后自动生效） |
| `npm run test:perf` | 性能基线采集：`node tests/perf/baseline-collect.mjs` | ⏳ 待接线（R0-C 产物未就绪，落地后自动生效） |

> 依赖说明：G3 渲染层 RTL 需要 `@testing-library/react` + `@testing-library/jest-dom` + `jsdom`，
> **本轮不安装**（R3 才需要）；届时由实现轮次追加 devDependencies，本索引同步更新。

## 分层 CI 映射（03 §12.7）

pre-commit（U1+U2 固定种子）→ CI fast（U1+U2+lint）→ CI mid（R1+R2+C1+C2）→
CI slow（E1 全量）→ nightly（P1 全档 + M1 + X1 + 像素金样 + 多种子属性测试）。
门禁任何一层失败即阻塞合并，严禁 `--no-verify` 绕行。
