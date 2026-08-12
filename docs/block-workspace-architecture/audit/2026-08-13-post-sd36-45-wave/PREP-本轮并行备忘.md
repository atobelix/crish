# PREP · 2026-08-13 post-sd36-45-wave · 本轮并行备忘

| 元数据       | 值                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------- |
| **轮次**     | ①∥②∥美学 同轮 · **T=8** · E=0                                                                 |
| **计数**     | ①×3 + ②×4 + 美学×1 = 8（上限 16，本轮不打满）                                                 |
| **提交**     | **仅主控** `git commit --only`；子 Agent **禁止** commit / reset / checkout / restore         |
| **上轮必审** | SD-36…45 · CONN-D×G2′ · 纸面 CSS                                                              |
| **锚**       | `19` 下一闸；`audit/2026-08-13-post-sd27-35-wave/{00,04,05,06}`；HEAD `0aa117cf` / `bd4064fe` |

## 0. 调度钉死

- 用户本轮：**合理规划，不必打满 16**
- EL-01…10 **仍全开**；Skeleton 保 `-S`
- ② **4 SD**（≥2）；E=0
- 禁止 `--no-verify`；UTF-8 无 BOM；pwsh7
- rustfmt **只**打本包锁文件；禁止整 crate rustfmt

## 1. 上轮已消化（① 审 · ② 禁整包）

SD-36 os_watch 361 · SD-37 import 300 · SD-38 lib 269 · SD-39 store 测拆 · SD-40 BlockChrome 299 · SD-41 types_ops 170 · SD-42 e2/e3 · SD-43/44 行数门 · SD-45 poll 245 · CONN-D×G2′ · 纸面 CSS。

累计禁派：SD-01…45 · E2′ · G2/G2-int/DG2/D×G2′ · C2 会计 · Slash/15/16 · W6-A-S · T=12/13 · 还债整包。

## 2. 本轮 8 人写死

| #   | 桶       | 包        | 锁                                 | 完成定义                                                  | ≠                     |
| --- | -------- | --------- | ---------------------------------- | --------------------------------------------------------- | --------------------- |
| 1   | ①a       | 目的性    | 本目录 `00`–`04`                   | 审上轮 SD-36…45 / D×G2′；04 标本轮同开                    | 改业务代码            |
| 2   | ①b       | 结构      | `05`                               | 宽谱黄带 Δ                                                | 只查一项              |
| 3   | ①c       | 连通      | `06`                               | 七链；C2/E2/E2′/D×G2′ 不回退                              | 「均可维持」          |
| 4   | ②        | **SD-46** | `mdPrefixHost.ts` **531**          | 抽 simulate/audit/mock；主文件 &lt;400；只走 TurnIntoSink | EL-01；占 SD-22       |
| 5   | ②        | **SD-47** | `note_backend_tests.rs` **500**    | 按 memory vs w4f/w4r 拆；断言不丢                         | EL-05；占 SD-23/28    |
| 6   | ②        | **SD-48** | `BlockChromeDomHost.ts` **383**    | 抽 slash/drag 装配；`w3f_dom_*` 绿；catalog 默认 false    | EL-01；占 SD-03/08/40 |
| 7   | ②        | **SD-49** | `store_backend_apply.rs` **320**   | 抽 query 或 batch 辅助；`w4f_store_*` 绿                  | EL-05；占 SD-06/29/39 |
| 8   | 美学设计 | CSS       | **只** `NotePaperPanel.module.css` | 消化上轮 07 的 D4/D5（去 accent-blue / 裸 hex）           | 改 tsx / tokens       |

## 3. 文件域互斥

- block-paper：**46**=`leaves/mdPrefixHost.ts` + 新兄弟模 · **48**=`chrome/BlockChromeDomHost.ts`（**勿**碰 `BlockChrome.ts`）
- agent-tools：**47**=`note_backend_tests.rs` + 新拆测（勿碰 note_memory / note_backend 实现）
- note-runtime：**49**=`store_backend_apply.rs` + 新兄弟模（勿碰 store_backend 门面 / 测文件）
- 美学：只 CSS
- 审计：①a=`00`–`04` · ①b=`05` · ①c=`06`（**新目录**；禁覆盖 `post-sd27-35-wave`）

## 4. ① 目的清单

1. 上轮十一包完成定义可证伪
2. 假关 EL / 去 `-S` / fixture 伪装
3. X-05 / G2 notify / C2·E2 默认关 / E2′ / D×G2′ Memory ≠ 真 apply
4. 黄带 Δ：mdPrefixHost 531 / backend 测 500 / DomHost 383 / apply 320
5. 本轮同开 SD-46…49 落盘后标已消化

_2026-08-13 · 主控 PREP · T=8 · post-sd36-45-wave_
