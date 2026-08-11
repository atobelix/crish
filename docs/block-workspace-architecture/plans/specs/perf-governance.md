# H3 · 性能标定治理

| 项         | 规则                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| 基准文件   | `docs/block-workspace-architecture/plans/acceptance/perf-baseline.md`（初值待 W6-C）     |
| 机器指纹   | OS + CPU + RAM + WebView 版本 → `perf_baseline_rev`                                      |
| 结构门     | 热集上界、DOM 上界、merge 非 UI 主线程、fullRemount=0                                    |
| 退化       | p95≥2× 或 p50≥1.5× 连续 3 次 → A-PERF-DEG-01 → A-SWAP 评估                               |
| 测量脚手架 | `npm run perf:block-workspace`；Rust `#[ignore]` `perf_open_nk_blocks`（见 baseline §7） |
| **禁止**   | 脚本自动把 TBD 改成假「达标」；数值门仅人工回填后生效                                    |

A-PERF-DEG-01 入库于 `acceptance/A-assert-index.md`。
