# PREP · 2026-08-13 post-sd22-26-wave · 本轮并行备忘

| 元数据       | 值                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------- |
| **轮次**     | ①∥②∥美学 同轮 · **T=16** · E=0                                                                  |
| **计数**     | ①×3 + ②×11 + 美学×2 = 16（同时存活 ≤16）                                                        |
| **提交**     | **仅主控** `git commit --only`；子 Agent **禁止** commit / reset / checkout                     |
| **上轮必审** | SD-22 mdPrefix · SD-23 backend · SD-24 hydrate · SD-25 Panel · SD-26 import                     |
| **锚**       | `19` 下一闸；`audit/2026-08-13-post-e2p-wave/{00,04,05,06}`；功能簇 `bf65b38f`；docs `7eb9efe2` |

## 0. 调度钉死

- 用户本轮：**可以多跑、上限 16**
- EL-01…10 **仍全开**；Skeleton 保 `-S`
- ② **≥2 SD/CONN**（本轮 11 个结构/连通包）
- 禁止 `--no-verify`；UTF-8 无 BOM；pwsh7
- 审计默认只针对 `review.md`（内部模式）

## 1. 上轮已消化（① 审 · ② 禁整包）

| 包        | 主面                      | 禁                              |
| --------- | ------------------------- | ------------------------------- |
| **SD-22** | mdPrefix 73               | 再切桥                          |
| **SD-23** | note_backend 312 + 测 500 | 再旁挂测                        |
| **SD-24** | hydrate 70                | 再切 hydrate；fixture 撒谎      |
| **SD-25** | Panel 198 · 仍 `W5-B-S`   | 去 `-S`                         |
| **SD-26** | import 415 + 测 160       | 再切 import 整包（再抽须新 ID） |

累计禁派：SD-17…21 · E2′ · Slash/15/16 · C2 会计 · W6-A-S · G2 总线 · E3 · G2-int · W4-R · T=12/13 · 还债整包。

## 2. 本轮 16 人写死

| #   | 桶       | 包           | 锁                                                    | 完成定义                            | ≠                    |
| --- | -------- | ------------ | ----------------------------------------------------- | ----------------------------------- | -------------------- |
| 1   | ①a       | 目的性       | 本目录 `00`–`04`                                      | 审上轮五包；04 标本轮同开           | 改业务代码           |
| 2   | ①b       | 结构         | `05`                                                  | 宽谱黄带 Δ                          | 只查一项             |
| 3   | ①c       | 连通         | `06`                                                  | 七链；C2/E2/E2′ 不回退              | 「均可维持」         |
| 4   | ②        | **SD-27**    | `conex-workspace-store/src/lib.rs` **567**（测 :428） | 测旁挂；门面&lt;400                 | EL-03；重切 refs/os  |
| 5   | ②        | **SD-28**    | `note_memory.rs` **538**                              | 主文件&lt;400；w4f/w4r 绿           | EL-05；重做 SD-23    |
| 6   | ②        | **SD-29**    | `store_backend.rs` **528**（测已旁挂）                | 再切 apply 实现；门面&lt;400        | EL-05；重做 SD-06    |
| 7   | ②        | **SD-30**    | `WorkspaceEmptyState.tsx` **534**                     | 主文件&lt;400；C2/E2 默认 false     | 重做 E2′；改默认     |
| 8   | ②        | **SD-31**    | `migrate.rs` **317**（测 :230）                       | 测旁挂；schema 语义不变             | EL-03                |
| 9   | ②        | **SD-32**    | `note_types.rs` **547**                               | 类型/错误/token 分模；API re-export | EL-05                |
| 10  | ②        | **SD-33**    | `noteMirrorIpc.ts` **636**                            | 主文件&lt;400；E2/E3 头纪律在       | EL-03；重做 E2′      |
| 11  | ②        | **SD-34**    | `noteApplyOpsIpc.ts` **442**                          | 主文件&lt;400；G2 notify 不回退     | EL-01/08             |
| 12  | ②        | **SD-35**    | `WorkspaceEmptyState.w5b.test.tsx` **995**            | 按 CONN 域拆测文件；断言不丢        | 改产品默认           |
| 13  | ②        | **A-MD**     | 新 golden `gfm-core/list_nested_table.md`             | 新测名；诚实 flatten                | EL-06；重做旧 golden |
| 14  | ②        | **CONN-DG2** | 新测：product_apply 后 Strict **kind**                | 同 doc flavour 前进；异 doc 不误刷  | EL-01；重做 G2 总线  |
| 15  | 美学参考 | 对照         | 本目录 `07-美学对照.md`                               | EmptyState/纸面 vs `tokens.css`     | 改业务代码           |
| 16  | 美学设计 | CSS          | **只** `WorkspaceEmptyState.module.css`               | 焦点/边框贴 §13（≤10% 混入）        | 改 tsx 逻辑/默认     |

## 3. 文件域互斥

- store crate：27=`lib.rs` · 31=`migrate.rs`（勿碰 refs/os/persist/import）
- agent-tools：28=`note_memory` · 32=`note_types`（勿碰 note_backend / set_attr）
- note-runtime：29=`store_backend` + 新建 apply 分模
- EmptyState：**30=tsx** · **35=测** · **16=css** · 15=文档
- IPC：33 与 34 分文件
- DG2 / A-MD 独立

## 4. ① 目的清单

1. 上轮五包完成定义可证伪
2. 假关 EL / 去 `-S` / fixture 伪装
3. Panel 仍 `W5-B-S`；hydrate fixture 仍 `source:'fixture'`
4. import X-05 不回退
5. mdPrefix 无第二写锥
6. 黄带 Δ：lib 567 / memory 538 / EmptyState 534 / store_backend 528 / note_types 547 / noteMirrorIpc 636
7. C2/E2 默认关、E2′ 宿主不回退

_2026-08-13 · 主控 PREP · T=16 · post-sd22-26-wave_
