# 04 · 下一阶段子 Agent 计划（主控可直接抄）

| 元数据       | 值                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **输入**     | 本目录 `00`–`03`；`post-sd22-26-wave/{04,PREP}`（**上轮十一包 + 本轮同开已过期**）；`19`；`22` §4 + **§4.1.1** |
| **纪律**     | `20` §3.2–3.3 窄读；LOGIC 不砍效果锁；禁止 --no-verify；禁止假关 EL；**结构债默认 ② 非 ③**                     |
| **三套计数** | ① 本审计 ①a 已完（同轮 ①c/美学已写 06/07）；② 下表写死（**行数=4**，**其中 SD/CONN =4 ≥2**）；③ **E=0**        |

> **调度钉死（`22` §4 · §4.1.1 · 2026-08-13）**
>
> - 整轮 `T = ① + ② + ③ + 美学 ∈ [6, 16]`
> - **② = 本表行数**（宜 4–10；本表 **4** ≥4）；**禁止**「本波只 3」当总帽
> - **§4.1.1**：未关 SD/CONN → 本表 **≥2 行必须是 SD/CONN**（本表 **4 SD**）
> - **③** 仅假关/回退/测红；**结构债不进 ③**
> - 无 E 时须派够 ②（+美学）使 **T≥6**；常态目标 **8–12**
> - **下一刀新 ID 从 SD-46 起**

---

## ① 审计：本文件已完成（对齐 `22` · ①∥② 同轮）

- 产出：`docs/block-workspace-architecture/audit/2026-08-13-post-sd27-35-wave/**`（00–04）
- 上轮本波：SD-27…35 · A-MD `list_nested_table` · CONN-DG2 · 美学 EmptyState CSS **主面绿**；综合 **绿偏黄**；**E=0**
- **轮次形态（钉死）**：下轮 **①∥② 同轮并行**——① 审**下轮 ② 实际合入**；② 读**本文件**表行派包
- **过期**：post-sd22-26 `04` 建议（SD-36…39）及 PREP 本轮同开（SD-36…45 · CONN-D×G2′）中 **已交面** 勿整表抄

---

## 0. 必须先修审计红项？

| 级别           | 项                                                                                                                                                   | 动作                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 🔴 阻塞        | **无**（未见假关/回退红）                                                                                                                            | 功能面可维持        |
| 🟨 前进中诚实  | `mdPrefixHost` **531**；`note_backend_tests` **500**；`BlockChromeDomHost` **383**；`store_backend_apply` **320**；`lib.rs:107` unused `safe_doc_id` | **并入 ②**（含 SD） |
| 环境黄（非 ③） | 无（本 ①a **已** shell 真跑：vitest 91 / cargo 716+50+1+24）                                                                                         | 不占 E              |
| 禁止           | 假关 EL；去 `-S`；fixture 伪装；**整包重做已消化 / 本轮同开**；04 零 SD/CONN；「只 3」当帽；宣称结构债清零                                           | 会计铁律            |

**结论：可与 ① 同轮直接派 ②；③ E=0。结构余量进 ②。**

---

## 本波已消化（禁再整包）

| 包           | 状态                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **SD-27**    | ✅ `lib.rs` 测旁挂 **141**；门面当时 **398&lt;400**；同开再抽 **269**；**≠ EL-03**                 |
| **SD-28**    | ✅ `note_memory.rs` **179** + query/apply/batch；**≠ EL-05**                                       |
| **SD-29**    | ✅ `store_backend.rs` **223** + apply **320**；**≠** 重做 SD-06                                    |
| **SD-30**    | ✅ `WorkspaceEmptyState.tsx` **276**；默认 `false` **未回退**                                      |
| **SD-31**    | ✅ `migrate.rs` **245** + 测旁挂；schema 未见改                                                    |
| **SD-32**    | ✅ `note_types.rs` **37** + ops/batch/error；API re-export                                         |
| **SD-33**    | ✅ `noteMirrorIpc.ts` **67** barrel；E2/E3 头纪律在                                                |
| **SD-34**    | ✅ `noteApplyOpsIpc.ts` **66** barrel；G2 notify 头+adapt 仍在                                     |
| **SD-35**    | ✅ w5b **235** + conn-b3/c2/d2/e2；断言测名仍可 rg                                                 |
| **A-MD**     | ✅ `list_nested_table` + `golden_gfm_core_list_nested_table_paragraph_child` 本会话绿；**≠ EL-06** |
| **CONN-DG2** | ✅ `conn_dg2_*` Memory kind；**≠ EL-01/08**；**≠** 重做 G2                                         |
| **美学 CSS** | ✅ EmptyState.module.css 软焦点 5%；**未**改 tsx 默认                                              |

---

## 本轮同开已消化（①∥② · **下轮禁整包重做**）

> ① 写 04 时 ② 已并行落盘且接线。**下轮禁再整包派下表。**

| 包             | 状态 | 证据一带                                                                                                          |
| -------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| **SD-36**      | ✅   | `mirror_os_watch.rs` **448→361** + `mirror_os_watch_path.rs` **98**；`fake_os_source_*` / `os_watcher_emits_*` 绿 |
| **SD-37**      | ✅   | `mirror_import.rs` **415→300** + `mirror_import_propose.rs` **130**；X-05 三钉仍绿                                |
| **SD-38**      | ✅   | `lib.rs` **398→269** + `mirror_export.rs` **178**；export/lag 测绿；余 unused `safe_doc_id`                       |
| **SD-39**      | ✅   | `store_backend_tests.rs` **829→38** + apply_md/batch/hydrate；runtime `--lib` 24 绿                               |
| **SD-40**      | ✅   | `BlockChrome.ts` **383→299** + types **76** / snapshot **144**；写锥仍 structureIntents                           |
| **SD-41**      | ✅   | `note_types_ops.rs` **377→170** + `note_types_block.rs` **217**；barrel re-export                                 |
| **SD-42**      | ✅   | `conn-e2` **381→232** + `conn-e3.test.tsx` **168**；`conn_e2_*`/`conn_e3_*` 本会话绿                              |
| **SD-43**      | ✅   | 新 `hydrateProjection.line-budget.test.ts` **115**；fixture 字面不伪装；本会话绿                                  |
| **SD-44**      | ✅   | 新 `noteMirrorIpc.line-budget.test.ts` **104**；E2/E3 头纪律；本会话绿                                            |
| **SD-45**      | ✅   | `mirror_poll.rs` **393→245** + `mirror_poll_tests.rs` **158**；≠ 默认双开                                         |
| **CONN-D×G2′** | ✅   | 新 `conn-dxg2.leaf-mdprefix-kind-refresh.test.tsx`；`conn_dxg2_*` 本会话绿；Memory ≠ 真 apply                     |

---

## ② 计划方案 Agent（数量=表行数，写死）

> **数量 = 4**（表有 **4** 行，**≥4**）。
> **其中 ≥2 为 SD/CONN 还债**——满足 §4.1.1（本表 **4 SD**）。
> **吸收未切黄带**：`mdPrefixHost` **531** · `note_backend_tests` **500** · `BlockChromeDomHost` **383** · `store_backend_apply` **320**。
> **SD-27…45 / A-MD / CONN-DG2 / CONN-D×G2′ 已落 → 本表不再保留。**
> **新 ID 从 SD-46 起。**

### 禁派 · 本波已消化（整包重做）

- **SD-27** lib.rs 测旁挂整包（**≠** unused import 小修可并进 SD-46 域外文件时另议；**勿**占 SD-27）
- **SD-28** note_memory 整包（**禁**抬 EL-05）
- **SD-29** store_backend 整包（**≠** 可派 apply 再抽新行 SD-49）
- **SD-30** WorkspaceEmptyState 整包（**≠** 回退默认关）
- **SD-31** migrate 测旁挂整包
- **SD-32** note_types 整包（**≠** 已切 block 的 SD-41）
- **SD-33** noteMirrorIpc 从零再切
- **SD-34** noteApplyOpsIpc 从零再切（**≠** 回退 G2 notify）
- **SD-35** w5b 测拆整包
- **A-MD** `list_nested_table` 整包（**≠** 重做 `task_nested_table` / `blockquote_nested_table`）
- **CONN-DG2** 整包（**≠** 重做 G2 总线 / G2-int / D×G2′）
- **美学** EmptyState.module.css 整包重做（**≠** 改 tsx 默认）

### 禁派 · 本轮同开（整包重做）

- **SD-36** os_watch 再抽整包（**≠** 占 SD-19）
- **SD-37** import 再抽整包（**禁**抹 X-05；**≠** 占 SD-26）
- **SD-38** lib.rs 实现再抽整包（**≠** 占 SD-27）
- **SD-39** store_backend_tests 测拆整包（**≠** 重做 SD-06/29）
- **SD-40** BlockChrome 整包（**≠** 可派 DomHost 新行 SD-48；**≠** 占 SD-03/08）
- **SD-41** note_types_ops 整包（**≠** 占 SD-32）
- **SD-42** conn-e2/e3 测拆整包（**≠** 占 SD-35；**禁**改产品默认）
- **SD-43** hydrate line-budget 整包（**≠** 占 SD-24）
- **SD-44** noteMirrorIpc line-budget 整包（**≠** 占 SD-33）
- **SD-45** poll 测旁挂整包（**≠** 默认双开）
- **CONN-D×G2′** 整包（**≠** 重做 DG2 / G2-int）

### 禁派 · post-sd22-26 / post-e2p / post-t8-sd17 / post-sd13c2 / post-g2e3 / T=13 / T=12 / 还债（整包）

- **SD-22** mdPrefixBridge · **SD-23** backend · **SD-24** hydrate · **SD-25** Panel · **SD-26** import
- **SD-18** refs · **SD-19** os_watch 从零再切 · **SD-20** PaperList · **SD-21** persist
- **CONN-E2′** 产品默装整包
- **SD-17** projection · **SD-13-R** turnInto · **W4-R** set_attr · **CONN-G2-int** · **A-MD** `blockquote_nested_table`
- **SD-13** SlashMenu Overlay 整包重切 · **SD-15** Strict 从零再外置 · **SD-16** fts 从零再切
- **CONN-C2** 会计默认关+opt-in 整包（默改 true 须 **新 ID**）
- **W6-A-S** 整包（去 `-S` 或抽样关 EL-01 禁）
- **CONN-G2** 总线整包 · **CONN-E3** 整包
- **SD-12** query 从零再切 · **SD-14** Memory plan 整包
- **A-MD** `task_nested_table` 整包
- SD-04-R-G · SD-11 · W6-D-S 首批 · W6-B 方向 A-IME-06 · B3′/E2 复验
- SD-08/09/10 · CONN-D3 · CONN-B3（含 B3′）· CONN-E2 opt-in · W3-E-desk
- SD-06/07/04-R · CONN-B2/D2/A1/G1 · W3-E′
- 还债 d1116610：SD-01…05 · CONN-B1/E1/D-RS
- T=12 / T=13 / 还债 **整包**

### 禁派 · 更早功能首批（勿挤）

- W4-C / W6-B-S / watcher(OS) 库首批 / PaperList 库首批 / slash React 首批 / W6-E-S / W6-C-S / W3-H / hydrate 默认 / 等…

| #   | 包ID                                 | 轨                    | 文件域锁                                                                                                                                                         | 完成定义（可测）                                                                                                                                                 | 强制阅读             | 禁止                                                 |
| --- | ------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------- |
| 1   | **SD-46 · mdPrefixHost 再抽**        | 结构债 ②；**≠ EL-01** | **锁** `packages/block-paper/src/leaves/mdPrefixHost.ts`（现 **531**）；抽模拟宿主/审计辅助到兄弟模；**不**整包重做 SD-22 桌面桥；**不**改 TurnIntoSink 写锥     | ① 主文件 &lt;400 或显著下降+分模 ② `mdPrefixHost` / D3 / D×G2′ 测名仍可 rg ③ 无孤儿 ④ **≠ EL-01 / ≠ A-BLK-08/09 e2e**；provisional ≠ kind；**只走 TurnIntoSink** | 本 `01` §5；`03` R76 | 占 SD-22；第二写锥；假关 e2e；改 EmptyState 默认     |
| 2   | **SD-47 · note_backend_tests 测拆**  | 结构债 ②；**≠ EL-05** | **锁** `crates/agent-tools/src/note_backend_tests.rs`（现 **500**）；按 memory query/apply vs w4f/w4r 域拆；**不**重做 SD-23/28                                  | ① 单测文件 &lt;400 或按域拆且断言不丢 ② `memory_*` / `w4f_memory_*` / `w4r_memory_*` 仍可 rg ③ `#[path]` 无孤儿 ④ **≠ EL-05 / ≠ A-AGT 满表 / ≠ W6-E**            | 本 `01` §1.2         | 整包重做 SD-23/28；丢断言；Memory 绿写进 EL-05       |
| 3   | **SD-48 · BlockChromeDomHost 再抽**  | 结构债 ②；**≠ EL-01** | **锁** `packages/block-paper/src/chrome/BlockChromeDomHost.ts`（现 **383**）；抽 slash/drag DOM 辅助；**不**改 `BlockChrome.ts`（SD-40 已切）；**不**占 SD-03/08 | ① 主文件 &lt;400 或显著下降+分模 ② `chrome.w3f_dom_*` / `w3f_dom_collab_path_intact` 形状绿 ③ `projectSlashCatalog` 默认仍 false ④ **≠ EL-01**；**≠** 占 SD-40   | 本 `01` §5；`03` R79 | 占 SD-03/08/40；默开 catalog；假关 DOM=EL-01         |
| 4   | **SD-49 · store_backend_apply 再抽** | 结构债 ②；**≠ EL-05** | **锁** `crates/conex-note-runtime/src/store_backend_apply.rs`（现 **320**）；抽 query/export 或 batch 提交辅助；**不**重做 SD-06/29 门面                         | ① 主文件显著下降（建议 &lt;280）或分模 ② `w4f_store_*` / `w4a_store_*` / `hydrate_document_*` 形状绿 ③ 无孤儿 ④ **≠ EL-05 / ≠ A-AGT / ≠ W6-E**；**≠** 打开完成   | 本 `01` §1.3         | 整包重做 SD-06/29/39；丢 dry_run / execution_unknown |

### 行选用说明（主控）

| 选项         | 何时优先                        | 诚实边界                    |
| ------------ | ------------------------------- | --------------------------- |
| **#1 SD-46** | **必派**（531&gt;400 · §4.1.1） | 新 ID；≠ e2e；≠ SD-22       |
| **#2 SD-47** | **必派**（测堆 500 · §4.1.1）   | 只拆测；Memory 禁抬 EL-05   |
| **#3 SD-48** | **宜派**（DomHost 383 贴线）    | 不重做 BlockChrome / SD-40  |
| **#4 SD-49** | **宜派**（apply 320 残留）      | 只抽 apply 实现；不重做门面 |

### 并行组合

```
已过：… · SD-22…26
        · **SD-27…35 / A-MD list_nested / CONN-DG2 / 美学 EmptyState CSS**
        · 本轮同开 **SD-36…45 / CONN-D×G2′**
        │
        ├─► 【1】SD-46 mdPrefixHost.ts 再抽           （结构 · 必派 · 新 ID）
        ├─► 【2】SD-47 note_backend_tests.rs 测拆     （结构 · 必派 · 新 ID）
        ├─► 【3】SD-48 BlockChromeDomHost.ts 再抽     （结构 · ≠ SD-40）
        └─► 【4】SD-49 store_backend_apply.rs 再抽    （结构 · ≠ SD-06/29）
```

| 组合             | 说明                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **推荐默认 T≥8** | ①×2–3 + ② 派 **#1–#4**（P=4，含 **≥2 SD**）+ 美学×0–2 + E=0 → T∈[6,12]                                                           |
| **资源紧 T≥6**   | ①×1 + ② **#1+#2+#3+#4**（P=4，**≥2 SD**）+ E=0                                                                                   |
| **文件冲突**     | #1 锁 block-paper leaves；#3 锁 chrome DomHost（勿碰 BlockChrome.ts）；#2 锁 agent-tools 测；#4 锁 note-runtime apply            |
| **本波不做**     | 重复本波十一包 / 本轮同开十一包 / T=13/12/还债/G2 总线/E3/C2 会计/E2′ / D×G2′ / DG2；关 EL；去 `-S`；04 零 SD/CONN；「只 3」当帽 |

> **若主控资源紧**：优先 **#1 SD-46**、**#2 SD-47**、**#3 SD-48**、**#4 SD-49**（保证 **≥4 包且 ≥2 SD/CONN**）；**禁止**只派新功能 2–3 且零还债。
> **禁止**因本轮同开已切而少派——顺延不等于砍表。

### 再下一轮仍可能未还（本表未派完时保留）

| 债                                | 说明                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| **`lib.rs:107` unused**           | SD-38 余；小卫生，可并进触及 `lib.rs` 的包；勿单开空包     |
| **NotePaperPanel.module.css 748** | 本轮美学域；若 07 已收口则下轮再议 CSS 结构切（新 ID）     |
| **W6-E Strict**                   | 千次批+恶意生产门（远后；≠ S 去轨）                        |
| **A-BLK e2e / EL-01**             | 仅 W6-A；G2/B3/D3/08/DG2/D×G2′ 抽样禁抬                    |
| **EL-03 数值 / inotify**          | 仅 W6-C + 真 OS 产品满关（远后）                           |
| **CONN-G2-wv**                    | 真 WebView 一体测（**另名**；≠ 重做 G2-int / DG2 / D×G2′） |
| **CONN-C2′ / C-prod**             | 产品要默开 PaperList 才新 ID；**≠** 再派 C2                |
| **①b 05**                         | 结构专报 Δ；非 ② 功能包                                    |

---

## ③ 审计后执行（E≤6，可 0）

| #   | 补洞项 | 文件域 | 完成定义                                     |
| --- | ------ | ------ | -------------------------------------------- |
| —   | **无** | —      | **E=0**：无阻塞假关/回退红；SD/CONN **进 ②** |

> 结构债 **默认 ②**。若**本轮 ②** 引入回归/假关，**下轮** ① 深审后写入 ③（E&gt;0，≤6）。

### 下轮 ③ 触发示例（非穷尽）

- SD-46：占 SD-22；第二写锥；叙事改 A-BLK e2e / EL-01；改 EmptyState 默认
- SD-47：占 SD-23/28；丢断言；Memory 绿写进 EL-05
- SD-48：占 SD-03/08/40；默开 `projectSlashCatalog`；DOM 绿关 EL-01
- SD-49：整包重做 SD-06/29/39；丢 dry_run / execution_unknown；假关 EL-05
- 任意：假关 EL；去 `-S`；fixture 伪装 tauri-ipc；回退 C2/E2 默认关；回退 E2′；回退 G2 notify；抹 X-05；`--no-verify`；整包重做本波/同开/T=13/T=12 已消化包

---

## 1. 建议本波 / 下轮执行序（主控 · ①∥②）

| 步  | 动作                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ |
| 0   | `git status`；本目录 `02` §2 本会话已跑绿，下轮 ① 审合入后再补跑                                 |
| 1   | 确认本目录 ①a 已落盘；读 `00` 总判 **绿偏黄** + 上轮十一包 / 本轮同开 **过期**；收齐 ①b/①c 05/06 |
| 2   | **下轮同开**：② 按本表派 **≥4**（**含 #1+#2**）；③ E=0 可空；呈现轮可加美学×0–2                  |
| 3   | 收齐后 ① 审**实际合入**包；刷新再下一轮 04                                                       |
| 4   | 回写 `19`：HEAD / 审计指针 → 本目录；下一闸对齐本表                                              |

---

## 2. 完成定义总禁（所有 ② 共用）

- 禁止假关 EL-01…10
- 禁止去 `-S` 冒充 Strict
- 禁止 fixture 伪装 tauri-ipc
- 禁止 hydrate_path 抬打开完成
- 禁止 D3/B2/B3/G1/G2/08/DG2/D×G2′ 抽样 / Overlay 单测关 A-BLK e2e / EL-01
- 禁止 E2/E3/E2′ 单测关 EL-03 / inotify 满关
- 禁止 Memory / contribute / MCP 关 EL-05/07 生产满表
- 禁止 TBD 数值当 PERF 通过 / 关 EL-03
- 禁止 poll/OS/import 叙事 inotify 满关 / 抹 X-05
- 禁止回退 C2/E2 组件默认关（无新 ID/测钉）
- 禁止回退 E2′ 产品宿主 / 无 Tauri 造假 report
- 禁止回退 G2 notify
- 禁止 mdPrefix 第二写锥
- 禁止 `--no-verify`
- 禁止互抹并行域已绿测与诚实未做句
- 禁止重复派 **本波十一包 / 本轮同开十一包 / G2 总线 / E3 / E2′ / DG2 / D×G2′ / SD-12 query / SD-14 / 旧 golden / Slash / SD-15 / SD-16 / T=13 七包 / T=12 八包 / 还债轮已消化整包 / note_memory**
- 禁止本轮 ② **零 SD/CONN**（§4.1.1）
- 禁止把结构债只写入「技术债 backlog」逃避 ②
- 禁止声称「块工作区完成 / 结构债清零」

---

## 3. 预留链接（①b / ①c / 美学）

| 文件                             | 状态                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `05-结构规范-上帝文件-长逻辑.md` | ①b 预留（本会话读盘时 **尚未**见）；对照 post-sd22-26 `05` 更新 **SD-27…35 已消化 + 本轮同开 SD-36…45** 黄带表 Δ（mdPrefixHost 531 / backend 测 500 / DomHost 383 / apply 320） |
| `06-交叉连通性审计.md`           | ①c **已见落盘**；①a **禁止覆盖**                                                                                                                                                |
| `07-美学对照.md`                 | 美学 **已见落盘**；①a **禁止覆盖**                                                                                                                                              |

> **①a 禁止覆盖** 05/06/07。

---

## 4. 建议 ② 包 ID 速查（给主控总判）

| 优先级 | 包 ID                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| 必派   | `SD-46`（mdPrefixHost 再抽）· `SD-47`（note_backend_tests 测拆）                                                         |
| 宜派   | `SD-48`（BlockChromeDomHost 再抽）· `SD-49`（store_backend_apply 再抽）                                                  |
| 顺延   | unused `safe_doc_id`；Panel CSS 748（美学域）                                                                            |
| 勿派   | 本波十一包 / 本轮同开十一包 / G2 总线 / E3 / E2′ / DG2 / D×G2′ / C2 会计 / query / 14 / 旧 golden / Slash / Strict / fts |

**本波消化判定（钉死）**：`SD-27` / `SD-28` / `SD-29` / `SD-30` / `SD-31` / `SD-32` / `SD-33` / `SD-34` / `SD-35` / `A-MD list_nested_table` / `CONN-DG2` / 美学 EmptyState CSS = **已消化**。
**本轮同开判定（钉死）**：`SD-36` / `SD-37` / `SD-38` / `SD-39` / `SD-40` / `SD-41` / `SD-42` / `SD-43` / `SD-44` / `SD-45` / `CONN-D×G2′` = **已消化**。
**勿**写回 04 当未做。

---

_2026-08-13 审计 · 04 · 下一阶段子 Agent 计划 · post-sd27-35-wave · ①a_
