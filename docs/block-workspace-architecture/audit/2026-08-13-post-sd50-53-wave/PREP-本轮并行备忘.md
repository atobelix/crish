# PREP · 2026-08-13 post-sd50-53-wave · 本轮并行备忘

| 元数据   | 值                                                                                    |
| -------- | ------------------------------------------------------------------------------------- |
| **轮次** | ①∥② 同轮 + **上线缺口方案** 并行 · **T=12** · E=0                                     |
| **计数** | ①×3 + ②×4 + 上线方案×5 = 12（上限 16）                                                |
| **提交** | **仅主控** `git commit --only`；子 Agent **禁止** commit / reset / checkout / restore |
| **上轮** | SD-50…53 · 美学 D1 · HEAD `0ae6e3c4`                                                  |
| **锚**   | `19` 下一闸；`audit/2026-08-13-post-sd46-49-wave/{00,04,05,06}`；`08` 第 2 轮         |

## 0. 调度钉死

- 用户本轮：**按规划来的同时**，多派检查「不满足上线标准」并出方案；主控整合文档后再派实施
- EL-01…10 **仍全开**；Skeleton 保 `-S`
- ② **4 SD**；E=0
- 禁止 `--no-verify`；UTF-8 无 BOM；pwsh7
- rustfmt / prettier **只**打本包锁文件
- **禁止**碰并行他人 WIP（agent-provider / session-loop / orchestrator / mobile / persist_plugin）
- 磁盘：若跑 cargo，优先 `$env:CARGO_TARGET_DIR='D:\cargo-target-conex'`；`$env:TMP=$env:TEMP='D:\tmp-conex'`

## 1. 上轮已消化（① 审 · ② 禁整包）

SD-50 sql 195+filters · SD-51 os_watch 272 · SD-52 projection 测拆 · SD-53 refs 测拆 · D1 行环。

累计禁派：SD-01…53 · E2′ · G2/G2-int/DG2/D×G2′ · C2 会计 · C2′ · Slash Overlay / 15/16 · W6-A-S 去 `-S`。

## 2. 本轮 12 人写死

| #    | 桶       | 包        | 锁 / 产出                                                        | 完成定义                                                         | ≠                        |
| ---- | -------- | --------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| 1    | ①a       | 目的性    | 本目录 `00`–`04`                                                 | 审 SD-50…53 / D1；04 标同开 SD-54…57；下一刀 **SD-58** 起        | 改业务代码               |
| 2    | ①b       | 结构      | `05`                                                             | 宽谱 Δ；生产面 >400 是否出带                                     | 只查一项                 |
| 3    | ①c       | 连通      | `06`                                                             | 七链；C2′/E2′/G2 不回退；A 仍 🟡                                 | 「均可维持」             |
| 4    | ②        | **SD-54** | `packages/block-paper/src/leaves/code/CodeLeafModel.ts` **478**  | 类型/快照外置；主文件 &lt;400；`code.w3e*` / `code.cm6*` 仍可 rg | EL-01；A-BLK-14；占 W3-E |
| 5    | ②        | **SD-55** | `packages/block-paper/src/chrome/SlashMenuModel.ts` **435**      | 类型+catalog 外置；主文件 &lt;400；禁默开 catalog                | EL-01；占 SD-13/48       |
| 6    | ②        | **SD-56** | `packages/block-paper/src/chrome/blockSelection.ts` **402**      | 类型/快照外置；主文件 &lt;400；禁像素测距                        | EL-01；占 SD-40          |
| 7    | ②        | **SD-57** | `packages/block-paper/src/chrome/chrome.w3f_dom.test.ts` **488** | 按 mount/handle/slash/collab 拆；断言不丢                        | EL-01；占 SD-48          |
| 8–12 | 上线方案 | 见下      | `audit/2026-08-13-launch-gap/01`…`05`                            | 缺口+可执行包+完成定义；**只写文档**                             | 改业务代码；假关 EL      |

## 3. 文件域互斥

- block-paper **code/**：仅 SD-54（`CodeLeafModel.ts` + 新兄弟；保持 `index.ts` 公开 re-export）
- block-paper **chrome/**：SD-55=`SlashMenuModel.ts` · SD-56=`blockSelection.ts` · SD-57=测文件（互不改对方）
- ①：新目录 `post-sd50-53-wave`；禁覆盖 `post-sd46-49-wave`
- 上线方案：只写 `launch-gap/01`…`05`；禁覆盖 ① 目录；**00 留给主控整合**

## 4. ① 目的清单

1. SD-50…53 + D1 完成定义可证伪
2. 假关 EL / 去 `-S` / fixture 伪装
3. X-05 / G2 / C2·E2 组件默认 / E2′ / C2′ Host 传参 / mdPrefix 单锥
4. 黄带 Δ：CodeLeaf 478 / Slash 435 / sel 402 / w3f_dom 488
5. 本轮同开 SD-54…57 若落盘 → 04 标消化；下一刀 **SD-58** 起

_2026-08-13 · 主控 PREP · T=12 · post-sd50-53-wave_
