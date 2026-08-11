# H3 · 性能标定治理

| 项       | 规则                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| 基准文件 | `docs/block-workspace-architecture/plans/acceptance/perf-baseline.md`（初值待 W6-C） |
| 机器指纹 | OS + CPU + RAM + WebView 版本 → `perf_baseline_rev`                                  |
| 结构门   | 热集上界、DOM 上界、merge 非 UI 主线程、fullRemount=0                                |
| 退化     | p95≥2× 或 p50≥1.5× 连续 3 次 → A-PERF-DEG-01 → A-SWAP 评估                           |

A-PERF-DEG-01 入库于 `acceptance/A-assert-index.md`。
