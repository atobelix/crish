# PREP · 2026-08-13 post-t8-sd17-wave · 本轮并行备忘

| 元数据                                 | 值                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **轮次**                               | ①∥② 同轮 · T=8 · E=0                                                                               |
| **审计产出**                           | 本目录 `00`–`06`（①a=00–04 · ①b=05 · ①c=06）                                                       |
| **上轮已合入（① 必审 · 禁整包重做）**  | SD-17 · SD-13-R · W4-R · CONN-G2-int · A-MD blockquote                                             |
| **本轮 ② 写死（① 04 记「本轮同开」）** | SD-18 refs · SD-19 os_watch · SD-20 PaperList · CONN-E2′ · SD-21 persist_plugin                    |
| **锚**                                 | `19` 下一闸；`audit/2026-08-12-post-sd13c2-wave/{00,04,05,06}`；功能簇 `4b05502c`；docs `38c594f7` |

## 0. 调度钉死

- `T = ①3 + ②5 + ③0 = 8` ∈ [6,16]
- ② 含 **≥2 SD/CONN**（本轮 5）
- ③ **E=0**
- EL-01…10 **仍全开**；Skeleton 保 `-S`
- 禁止 `--no-verify`；禁止 `reset --hard`；`git commit --only`；UTF-8 无 BOM

## 1. 上轮已消化（① 审这些 · ② 禁整包）

| 包              | 主面                                              | 禁                                        |
| --------------- | ------------------------------------------------- | ----------------------------------------- |
| **SD-17**       | projection 门面 277 + `projection_tests` 521      | 从零再切 projection                       |
| **SD-13-R**     | turnInto 60 + types/intent/mdPrefix + line-budget | 再切 turnInto / Overlay                   |
| **W4-R**        | `block_set_attr` 独立工具                         | 重做 set_attr / insert/update/delete/move |
| **CONN-G2-int** | `conn_g2_same_doc_*` / other / fail_or_zero       | 一体测整包；真 WebView 另名               |
| **A-MD**        | `blockquote_nested_table`                         | 同 fixture 重做                           |

**累计禁派**：Slash Overlay / SD-15 / SD-16 / C2 会计 / W6-A-S / G2 总线 / E3 / SD-12 query / SD-14 / task_nested_table / T=12/13 / 还债整包。

## 2. 本轮 ② 写死

| #   | 包 ID        | 锁                                                               | 完成定义                                                                                                                               | ≠                                           |
| --- | ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | **SD-18**    | `crates/conex-workspace-store/src/refs.rs`（**741**，测约 :303） | 门面 &lt;500 或实现+测旁挂且单文件&lt;700；refs/W2-F 测绿；无孤儿                                                                      | EL-03；勿切 os_watch/persist/fts/projection |
| 2   | **SD-19**    | `mirror_os_watch.rs`（**706**，测约 :441）                       | 单文件&lt;700 或测旁挂；OS watcher 测绿；无孤儿                                                                                        | EL-03；inotify 满关；默认双开 poll+OS       |
| 3   | **SD-20**    | `packages/block-paper/src/list/PaperList.ts`（**488**）          | 主文件显著下降（建议&lt;400）；w3g/DomMount/C2 测绿                                                                                    | EL-01；W3-P；改 C2 默认；Overlay/turnInto   |
| 4   | **CONN-E2′** | `Workspace.tsx` + 产品策略小文件 + 新测                          | 产品宿主**写死**默传 `enableMirrorDetectSchedule` + 产品 `mirrorIpc`；EmptyState **默认仍 false**；无 Tauri 不造假 report；X-05 不回退 | EL-03；inotify；重做 E3；C2 默开            |
| 5   | **SD-21**    | **写死** `persist_plugin.rs`（**457**，测约 :251）               | 主文件&lt;400 或测旁挂显著下降；persist 测绿；无孤儿                                                                                   | EL-04；勿切 refs/os_watch；勿改 mdPrefix    |

## 3. ① 目的清单

1. 上轮五包完成定义可证伪
2. 假关 EL / 去 `-S` / fixture 伪装
3. G2-int 一体测是否真绿形状；blockquote flatten 诚实句是否在
4. W4-R 是否抬 EL-05；note_backend 行数回涨是否诚实
5. turnInto / projection 切开无孤儿、无语义回退
6. 黄带 Δ：refs / os_watch / PaperList / persist / mdPrefix / note_backend
7. 交叉：Workspace 仍不默装（本轮 ② 在补）；C2/E2 EmptyState 默认关不回退

## 4. 落盘

- ①a：只写 `00`–`04`（可勾选本 PREP）
- ①b：只写 `05-结构规范-上帝文件-长逻辑.md`
- ①c：只写 `06-交叉连通性审计.md`
- 禁止改业务代码；UTF-8 无 BOM；中文
- 04 必须吸收未还 SD/CONN；本轮同开五包标已消化

_2026-08-13 · 主控 PREP · post-t8-sd17-wave_

---

## 5. ①a 勾选（追加 · 未删上文）

| ☑   | PREP §3 目的项                                                          | ①a 结论                                          |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| ☑   | 上轮五包完成定义可证伪                                                  | **绿**（`01`）                                   |
| ☑   | 假关 EL / 去 `-S` / fixture 伪装                                        | **未踩**（`02`）                                 |
| ☑   | G2-int 一体测是否真绿形状；blockquote flatten 诚实句                    | **不只 notify**；**flatten 诚实**                |
| ☑   | W4-R 是否抬 EL-05；note_backend 行数回涨                                | **未抬**；**802** 测堆                           |
| ☑   | turnInto / projection 无孤儿、无语义回退                                | **无孤儿 / API 稳定**                            |
| ☑   | 黄带 Δ：refs / os_watch / PaperList / persist / mdPrefix / note_backend | 前四项本轮同开已切；后两项仍黄（`01` §5）        |
| ☑   | Workspace 仍不默装（本轮 ② 在补）；C2/E2 默认关                         | **组件默认关未回退**；Workspace **E2′ 已见落盘** |

- 产出：本目录 `00`–`04` 已写；**未**覆盖 05/06；**未**改业务代码
- 04：②=5（SD-22…26）；本轮同开五包标已消化；E2′ **已落**故不保留；**E=0**
- 测跑：无 Shell → **未**真跑（`02`）

_2026-08-13 · ①a 追加勾选_
