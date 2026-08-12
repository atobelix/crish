# PREP · 2026-08-13 post-sd27-35-wave · 本轮并行备忘

| 元数据       | 值                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **轮次**     | ①∥②∥美学 同轮 · **T=16** · E=0                                                                                                                               |
| **计数**     | ①×3 + ②×11 + 美学×2 = 16（同时存活 ≤16）                                                                                                                     |
| **提交**     | **仅主控** `git commit --only`；子 Agent **禁止** commit / reset / checkout / restore                                                                        |
| **上轮必审** | SD-27 lib · SD-28 memory · SD-29 store · SD-30 EmptyState · SD-31 migrate · SD-32 types · SD-33/34 IPC · SD-35 测拆 · A-MD list_nested · CONN-DG2 · 美学 CSS |
| **锚**       | `19` 下一闸；`audit/2026-08-13-post-sd22-26-wave/{00,04,05,06}`；功能簇 `d0822a56`；docs `f8d6dd03`                                                          |

## 0. 调度钉死

- 用户本轮：**可以多跑、上限 16**
- EL-01…10 **仍全开**；Skeleton 保 `-S`
- ② **≥2 SD/CONN**（本轮 11 个结构/连通包）
- 禁止 `--no-verify`；UTF-8 无 BOM；pwsh7
- 审计默认只针对 `review.md`（内部模式）
- rustfmt **只**格式化本包锁文件：`rustfmt <本文件>`；禁止整 crate rustfmt 误伤并行域

## 1. 上轮已消化（① 审 · ② 禁整包）

| 包           | 主面                                     | 禁                                      |
| ------------ | ---------------------------------------- | --------------------------------------- |
| **SD-27**    | lib **398** + `lib_tests` 141            | 再旁挂测；再抽实现须新 ID（本轮 SD-38） |
| **SD-28**    | memory **179** + query/apply/batch       | 整包重切；抬 EL-05                      |
| **SD-29**    | store_backend **223** + apply **320**    | 重做 SD-06                              |
| **SD-30**    | EmptyState **276** + 三分模；默认 false  | 改 C2/E2 默认；去 `-S`；重做 E2′        |
| **SD-31**    | migrate **245** + tests 91               | 静默改 schema                           |
| **SD-32**    | types barrel **33** + ops/batch/error    | 整包重切类型                            |
| **SD-33**    | noteMirrorIpc barrel **67**              | 重做 E2′；抬 EL-03                      |
| **SD-34**    | noteApplyOpsIpc barrel **66**；G2 notify | 回退 G2 notify                          |
| **SD-35**    | w5b **235** + conn-b3/c2/d2/e2           | 改产品默认；丢断言                      |
| **A-MD**     | `list_nested_table` + flatten 诚实       | 重做旧 golden；抬 EL-06                 |
| **CONN-DG2** | `conn_dg2_*` Memory kind                 | 重做 G2/G2-int；抬 EL-08                |
| **美学 CSS** | EmptyState.module.css 软焦点             | 改 tsx 默认                             |

累计禁派：SD-01…35 · Slash/15/16 · C2 会计 · W6-A-S · G2 总线 · E3 · E2′ · G2-int · DG2 整包 · W4-R · T=12/13 · 还债整包 · SD-18…26。

## 2. 本轮 16 人写死

| #   | 桶       | 包             | 锁                                                                              | 完成定义                                                                  | ≠                         |
| --- | -------- | -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| 1   | ①a       | 目的性         | 本目录 `00`–`04`                                                                | 审上轮十一包；04 标本轮同开                                               | 改业务代码                |
| 2   | ①b       | 结构           | `05`                                                                            | 宽谱黄带 Δ                                                                | 只查一项；覆盖 00–04      |
| 3   | ①c       | 连通           | `06`                                                                            | 七链；C2/E2/E2′/DG2 不回退                                                | 「均可维持」              |
| 4   | ②        | **SD-36**      | `mirror_os_watch.rs` **448**                                                    | 抽路径/事件规范化；主文件 &lt;400；测形状绿                               | EL-03；占 SD-19；默认双开 |
| 5   | ②        | **SD-37**      | `mirror_import.rs` **415**                                                      | 抽 `propose_block_level_ops`；X-05 三钉                                   | EL-03；占 SD-26；抹 X-05  |
| 6   | ②        | **SD-38**      | `lib.rs` **398**（测已旁挂）                                                    | 抽 export/lag 实现；门面显著下降（建议 &lt;350）                          | EL-03；占 SD-27；并回已切 |
| 7   | ②        | **SD-39**      | `store_backend_tests.rs` **829**                                                | 按 hydrate / apply_md / batch 拆；单测文件 &lt;700；断言不丢              | EL-05；重做 SD-06/29      |
| 8   | ②        | **SD-40**      | `BlockChrome.ts` **383**                                                        | 抽类型/快照或结构 Intent 辅助；主文件下降；`chrome.w3f*` 形状绿           | EL-01；占 SD-03/08        |
| 9   | ②        | **SD-41**      | `note_types_ops.rs` **377**                                                     | 抽 block op 类型到兄弟模；barrel re-export；API 不破                      | EL-05；占 SD-32           |
| 10  | ②        | **SD-42**      | `WorkspaceEmptyState.conn-e2.test.tsx` **381**                                  | 按 E2 vs E3 拆测；`conn_e2_*`/`conn_e3_*` 仍可 rg                         | 改产品默认；占 SD-35      |
| 11  | ②        | **SD-43**      | **新** `hydrateProjection.line-budget.test.ts`                                  | 钉 barrel ≤399 + 四分模存在；fixture 字面不伪装                           | 打开完成；占 SD-24        |
| 12  | ②        | **SD-44**      | **新** `noteMirrorIpc.line-budget.test.ts`                                      | 钉 barrel ≤399 + 五分模存在；E2/E3 头纪律                                 | EL-03；占 SD-33           |
| 13  | ②        | **SD-45**      | `mirror_poll.rs` **393**                                                        | 测旁挂 `mirror_poll_tests.rs`；主文件 &lt;350；≠ 默认双开                 | EL-03；inotify 满关       |
| 14  | ②        | **CONN-D×G2′** | **新** `conn-dxg2.leaf-mdprefix-kind-refresh.test.tsx`                          | 叶 `# ` → product apply → notify → 同 doc `data-flavour` 前进（诚实夹具） | EL-01/08；重做 DG2/G2-int |
| 15  | 美学参考 | 对照           | 本目录 `07-美学对照.md`                                                         | 纸面 `NotePaperPanel.module.css` vs tokens/§13                            | 改业务代码                |
| 16  | 美学设计 | CSS            | **只** `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css` | 焦点/边框贴 §13（常规 ≤10%；禁粗黑边）                                    | 改 tsx / 去 `-S` / tokens |

## 3. 文件域互斥

- workspace-store：**36**=`mirror_os_watch.rs` + 新兄弟模 · **37**=`mirror_import.rs` + 新兄弟模 · **38**=`lib.rs` + 新 `mirror_export.rs`（勿碰 refs/os/persist/import） · **45**=`mirror_poll.rs` + 新测
- note-runtime：**39**=`store_backend_tests.rs` + 新拆测（工作区已有 rustfmt 空白改动，**保留并纳入拆分**）
- agent-tools：**41**=`note_types_ops.rs` + 新兄弟模（勿碰 note_memory / note_backend / set_attr）
- EmptyState 测：**42**=`conn-e2.test.tsx` + 新拆测（勿改 tsx / 默认）
- block-paper：**40**=`BlockChrome.ts`（**勿**改 `BlockChromeDomHost.ts` / structureIntents）
- note-paper：**43**=新 line-budget · **14**=新 D×G2′ 测 · **16**=`NotePaperPanel.module.css`
- api：**44**=新 `noteMirrorIpc.line-budget.test.ts`（勿改 barrel 逻辑）
- 审计：①a=`00`–`04` · ①b=`05` · ①c=`06` · 美学参考=`07`（**新目录**；禁覆盖 `post-sd22-26-wave`）

## 4. ① 目的清单

1. 上轮十一包完成定义可证伪（path:line / 测名）
2. 假关 EL / 去 `-S` / fixture 伪装 tauri-ipc
3. Panel 仍 `W5-B-S`；hydrate fixture 仍 `source:'fixture'`
4. import X-05 / G2 notify / C2·E2 默认关 / E2′ 宿主不回退
5. CONN-DG2 Memory ≠ 真 apply / ≠ EL-08
6. 黄带 Δ：os_watch 448 / import 415 / lib 398 贴线 / store 测 829 / poll 393 / types_ops 377 / conn-e2 381 / BlockChrome 383
7. 本轮同开 SD-36…45 · CONN-D×G2′ 落盘后标已消化，禁再整包

_2026-08-13 · 主控 PREP · T=16 · post-sd27-35-wave_
