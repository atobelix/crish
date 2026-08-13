# PREP · 2026-08-13 post-sd46-49-wave · 本轮并行备忘

| 元数据       | 值                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| **轮次**     | ①∥②∥美学 同轮 · **T=8** · E=0                                                                           |
| **计数**     | ①×3 + ②×4 + 美学×1 = 8（上限 16，本轮不打满）                                                           |
| **提交**     | **仅主控** `git commit --only`；子 Agent **禁止** commit / reset / checkout / restore                   |
| **上轮必审** | SD-46…49 · 美学 D4/D5                                                                                   |
| **锚**       | `19` 下一闸；`audit/2026-08-13-post-sd36-45-wave/{00,04,05,06,08}`；HEAD 功能簇 `14c6ec01` / `6c0daf9d` |

## 0. 调度钉死

- 用户本轮：看完规划后指挥执行；合理规划，不必打满 16
- EL-01…10 **仍全开**；Skeleton 保 `-S`
- ② **4 SD**（≥2）；E=0
- 禁止 `--no-verify`；UTF-8 无 BOM；pwsh7
- rustfmt **只**打本包锁文件；禁止整 crate rustfmt
- **禁止**碰并行他人 WIP（agent-provider / session-loop / orchestrator / mobile / persist_plugin / store_backend 门面）

## 1. 上轮已消化（① 审 · ② 禁整包）

SD-46 mdPrefixHost barrel 59 · SD-47 backend 测拆 · SD-48 DomHost 296 · SD-49 apply 143 · 美学 D4/D5。

累计禁派：SD-01…49 · E2′ · G2/G2-int/DG2/D×G2′ · C2 会计 · Slash/15/16 · W6-A-S · T=12/13 · 还债整包。

## 2. 本轮 8 人写死

| #   | 桶       | 包        | 锁                                                                              | 完成定义                                                                                          | ≠                                   |
| --- | -------- | --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | ①a       | 目的性    | 本目录 `00`–`04`                                                                | 审上轮 SD-46…49 / D4/D5；04 标本轮同开 SD-50…53；新 ID 从 **SD-54** 起                            | 改业务代码                          |
| 2   | ①b       | 结构      | `05`                                                                            | 宽谱黄带 Δ；吸收 CodeLeaf 478 / SlashMenu 435 / sel 402                                           | 只查一项                            |
| 3   | ①c       | 连通      | `06`                                                                            | 七链；C2/E2/E2′/G2/D×G2′ 不回退；A 仍 🟡                                                          | 「均可维持」                        |
| 4   | ②        | **SD-50** | `query_blocks_sql.rs` **369**                                                   | 三路或滤器分模；主文件显著下降（建议 &lt;300）；`query_blocks::*` 测名仍可 rg                     | EL-03；占 SD-12/16；改 schema       |
| 5   | ②        | **SD-51** | `mirror_os_watch.rs` **361**                                                    | 抽 Fake + detect/poll 胶水；主文件建议 &lt;280；`fake_os_source_*` / `os_watcher_emits_*` 仍可 rg | EL-03；占 SD-19/36；默认双开        |
| 6   | ②        | **SD-52** | `projection_tests.rs` **521**                                                   | 按 hydrate/commit 拆；`g_hyd_02_*` / `a_inv_04_*` / `commit_ops_*` 不丢                           | 打开完成；EL-04；改 projection 实现 |
| 7   | ②        | **SD-53** | `refs_tests.rs` **441**                                                         | 按 extract / w2f / a_qry 拆；`a_qry_01_*` 无手工 seed 不丢                                        | EL-03；占 SD-18                     |
| 8   | 美学设计 | CSS D1    | **只** `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css` | 抄死上轮 07 D1：`[tabindex]:not` 特异性打赢全局；1px inset；叶不叠第二环                          | 改 tsx / tokens；关 EL              |

## 3. 文件域互斥

- workspace-store：**50**=`query_blocks_sql.rs` + 新兄弟模（**勿**改 `query_blocks.rs` 门面 / schema / `query_blocks_tests.rs`，除非只补 `#[path]` 头注释）
- workspace-store：**51**=`mirror_os_watch.rs` + 新兄弟模（**勿**碰 `mirror_os_watch_path.rs` / `mirror_os_watch_tests.rs` 整包重写；可只加 `use`）
- workspace-store：**52**=`projection_tests.rs` + 新拆测（**勿**改 `projection.rs` 实现）
- workspace-store：**53**=`refs_tests.rs` + 新拆测（**勿**改 `refs.rs` 实现）
- 美学：只 CSS
- 审计：①a=`00`–`04` · ①b=`05` · ①c=`06`（**新目录**；禁覆盖 `post-sd36-45-wave`）
- **禁碰**：`persist_plugin.rs` / `persist_plugin_tests.rs` / `lib.rs`（除非绝对必要的 `mod`；本轮四包应靠 `#[path]` 挂在已有父模上）

## 4. ① 目的清单

1. 上轮四包 + D4/D5 完成定义可证伪（path:line / 测名）
2. 假关 EL / 去 `-S` / fixture 伪装 tauri-ipc
3. X-05 / G2 notify / C2·E2 默认关 / E2′ / D×G2′ Memory ≠ 真 apply / mdPrefix 只走 TurnIntoSink
4. 黄带 Δ：query_sql 369 / os_watch 361 / projection_tests 521 / refs_tests 441
5. 本轮同开 SD-50…53 若落盘 → 04 标已消化；下一刀从 **SD-54** 起

## 5. 切开面（源码已读）

| 包    | 切开面                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------- |
| SD-50 | `query_with_fts` :15 / `query_with_cjk_instr` :69 / `query_sql_only` :149；滤器 :219–361            |
| SD-51 | Fake :272–308 + `detect_if_os_event_hits_mirror` / `poll_on_os_hint` :310–357；**勿**碰 path        |
| SD-52 | 6 测：`apply_projection_diff_*` / `g_hyd_02_*` / `a_inv_04_*` / `commit_ops_*` ×2 / `index_after_*` |
| SD-53 | 7 测：extract / schema_v5 / upsert / query ref / `w2f_*` ×2 / `a_qry_01_*`                          |

_2026-08-13 · 主控 PREP · T=8 · post-sd46-49-wave_
