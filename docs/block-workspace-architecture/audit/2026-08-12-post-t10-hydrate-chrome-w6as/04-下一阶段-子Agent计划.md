# 04 · 下一阶段子 Agent 计划（主控可直接抄）

| 元数据       | 值                                                                             |
| ------------ | ------------------------------------------------------------------------------ |
| **输入**     | 本目录 `00`–`03`；`09` Wave 2–6；`19` 下一闸；`22` §4（**T∈[6,16]** · ② 宜多） |
| **纪律**     | `20` §3.2–3.3 窄读；LOGIC 不砍效果锁；禁止 --no-verify；禁止假关 EL            |
| **三套计数** | ① 本审计已完；② 下表写死（**行数=派包数 · 8**）；③ 独立 E≤6（本轮建议 **0**）  |

> **调度钉死（`22` §4 · 2026-08-12）**
>
> - 整轮 `T = ① + ② + ③ + 美学 ∈ [6, 16]`
> - **② = 本表行数**（宜 4–10，**可远大于 3**）；**禁止**把「本波 3 行」读成整轮只能 3 人或 ② 单桶帽
> - **③** = 修复清单（本轮 E=0 不占）
> - 无 E 时须派够 ②（+美学）使 **T≥6**；常态目标 **8–12**

---

## ① 审计：本文件已完成（对齐 `22` · ①∥② 同轮）

- 产出：`docs/block-workspace-architecture/audit/2026-08-12-post-t10-hydrate-chrome-w6as/**`
- 上轮 `fd1bc140`：hydrate IPC / DomMount / W6-A-S / CAS-S / SURF 加深 / gfm 加深 / send_to_note / visual 06·07 **可维持**；目的清单 7 条全绿；并行域 **无误伤**
- **轮次形态（钉死）**：下轮 **①∥②∥美学 同轮并行**——① 审**本轮 ② 已合入成果**；② 读**本文件**表行派包
- 预备备忘：同目录 [`PREP-下轮并行备忘.md`](./PREP-下轮并行备忘.md)

---

## 0. 必须先修审计红项？

| 级别           | 项                                                                                                          | 动作                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| 🔴 阻塞        | **无**                                                                                                      | 上轮多包均可维持         |
| 🟨 前进中诚实  | OS watcher/UI；W6-E；slash 真浮层；W3-G/H；W6-C-S；W4-C；hydrate 默认深化（WIP）；W6-B-S                    | **并入 ②**，不单开修账   |
| 🟨 文档债      | `19` 审计指针 / 下一闸仍写旧轮（产品默认审）                                                                | 主控回写指针；**不**占 E |
| 环境黄（非 ③） | agent-tools `kill_subagent` dead_code 等                                                                    | **不**占 E               |
| 禁止           | 假关 EL；去 `-S`；fixture 伪装 ipc；query 派生抬 DocSession；DOM 关 EL-01；重复派 T=10 已交面；「只 3」当帽 | 会计铁律                 |

**结论：可与 ① 同轮直接派 ②；③ E=0（无补洞红项）。**

---

## ② 计划方案 Agent（数量=表行数，写死）

> **数量 = 8**（表有 **8** 行）。  
> **不是「本波只 3」**；不与 ③ 合计成「只能 3」。  
> 建议同轮至少派 **6** 行（T 下限）；其余可顺延至下一拍，但 **表必须保留 ≥6 行规划**。
>
> **禁止**再派已交付（`fd1bc140` 及更早）：
>
> - **真 hydrate IPC 首批**（`note_document_hydrate` + `NoteHydrateIpc` + adapt；合入时默认 fixture）
> - **桌面 React chrome DomMount 首批**（`BlockChromeDomMount` + Strict/Skeleton 挂载）
> - **W6-A-S 首批**（`a_blk_contract` + `chrome.a_blk` + `A-BLK-progress` 抽样）
> - **W2-D-S CAS 首批**（put/get/link 骨架）
> - **A-SURF-04/05 加深首批**（产品 hook 写计数探针）
> - **send_to_note 气泡首批**（completed 入口 + intentId 形状）
> - **visual 06/07 皮**（slash React 清单 + DomHost slash catalog 皮）
> - 更早：产品默认空态 / poll watcher / block_move / 拖拽 ghost / chrome 皮一期二期 / W4-F 余量 / gfm-core 首批 / W2-F refs / W5-C 隔离子集首批
>
> **本表只顺延：OS watcher·UI / W6-E / slash 真浮层 / PaperList / PERF-S / turn-into / contribute / hydrate 深化或 IME-S 等。**

| #   | 包ID                                    | 轨                                     | 文件域锁                                                                                                                                 | 完成定义                                                                                                                                                                                                         | 强制阅读                                                                | 禁止                                                               |
| --- | --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | **OS watcher / inotify 或 A-INV-02 UI** | Strict 方向；**≠ poll 重复当新包**     | **锁** `conex-workspace-store` mirror 产品事件 **或** 桌面订阅/三路 UI（**不**回退 detect/poll/X-05）                                    | ① inotify/FSEvents **或** 桌面产品三路 UI **可点名其一** ② 显式 **≠**「poll= inotify 满关」若只做 UI ③ **≠ EL-03** ④ poll/detect/X-05 测不回退                                                                   | `plans/02`；`09` W2-E；`mirror.rs` 头；本审计 `03` R11                  | poll 叙事重复；假关 EL-03；静默盖 unpushed；--no-verify            |
| 2   | **W6-E-S 或 W6-E 骨架**                 | 工具恶意/千次批门槛；**≠ EL-05 满关**  | **锁** `crates/agent-tools` ± note-runtime 压测夹具（**不**回退 batch/move/lossy/审批）                                                  | ① 千次批 **或** 恶意扩展 **骨架可测**（S 轨须带 `-S`）② 显式 **≠ EL-05 / ≠ A-AGT 满表** ③ plan Deny / execution_unknown / move 不回退                                                                            | `09` W6-E；`08` EL-05；本审计 `03` R9                                   | Memory 关生产；假关 EL-05；回退 move/lossy；--no-verify            |
| 3   | **slash 真 React 浮层 / catalog**       | 呈现；**可与 §4.2 美学并行**；**≠ EL** | **锁** note-paper / block-paper slash **React 浮层**（**不**回退 `SlashMenuModel` collab / DomHost 皮）                                  | ① 产品可点 **React** slash 浮层（catalog 最小集）② 选项 → Intent → sink 不回退 ③ **≠** A-BLK-02 产品 e2e / EL-01 ④ 与 visual 06/07 **衔接但不重复**只做皮                                                        | `plans/05`；visual-align `06`/`07`；`SlashMenuModel`；本审计 R12        | 浮层关 EL；回退 w3f_apply；只重做 06/07 皮；--no-verify            |
| 4   | **W3-G PaperList**                      | Strict 方向；**≠ EL-01**               | **锁** block-paper / note-paper PaperList 窗口 DOM（**不**回退 HeightMap 既有结构若触）                                                  | ① 仅窗口 DOM 列表可测 ② 滚动/窗口边界可点名 ③ **≠** 虚拟化数值门 / EL-01 / EL-03                                                                                                                                 | `plans/05`；`09` W3-G；`08` EL-01/03                                    | PaperList 关 EL；回退 DomMount；--no-verify                        |
| 5   | **W6-C-S PERF 结构骨架**                | Skeleton；**≠ EL-03 数值满关**         | **锁** perf baseline / 结构 checklist（**不**回退 W2-C FTS 结构门）                                                                      | ① 结构 checklist 可证伪 **或** 骨架测可点名 ② 包 ID 带 **`-S`** 若 Skeleton ③ 显式 **≠** A-PERF 数值门 / **≠ EL-03** ④ W2-C 既有测不回退                                                                         | `09` W6-C-S；`perf-baseline`；`08` EL-03                                | 结构绿关数值；去 `-S` 冒充 W6-C；--no-verify                       |
| 6   | **W3-H turn-into / MD 前缀 UI**         | Strict 方向；**≠ A-BLK-08/09 全 e2e**  | **锁** block-paper chrome / intent ± note-paper 呈现（**不**回退 StructureIntent collab）                                                | ① turn-into **或** MD 前缀快路径 **可点名其一** ② composing 禁结构不回退 ③ **≠ EL-01**；进度表 A-BLK-08/09 可更新抽样态但不关 EL                                                                                 | `plans/05`；`A-BLK-progress` 08/09；`09` W3-H                           | 抽样关 EL-01；回退 w3f；--no-verify                                |
| 7   | **W4-C contribute / 扩展宿主方向**      | Strict 方向；**≠ EL-07 满关**          | **锁** agent-tools / 扩展宿主 contribute 拒写或注册面（**不**回退 W4-B 审批 / W4-F 工具）                                                | ① contribute 拒写句柄 **或** 扩展注册可测 ② 显式 **≠ EL-07** ③ 审批/ batch 不回退                                                                                                                                | `plans/06`；`09` W4-C；`08` EL-07                                       | 仅句柄关 EL-07；回退权限矩阵；--no-verify                          |
| 8   | **hydrate 默认深化 或 W6-B-S IME**      | 见下行分轨；**均 ≠ 对应 EL**           | **hydrate 深化**：desktop `hydrateProjection` / `WorkspaceEmptyState`（**串行** WIP）；**或** **W6-B-S**：`editor-kit` IME 矩阵 Skeleton | **若合入 WIP hydrate**：① 测绿 product source 选择 ② **≠ 打开完成** ③ **≠ DocSession 全链** 若仍 query 派生 ④ 同步 `19` 未做句 ⑤ 双轨 Skeleton 保留；**若 W6-B-S**：① 包带 `-S` ② IME L0–L1 可测 ③ ≠ W6-B / ≠ EL | 本审计 `01` WIP 表 + `03` R16/R17；`specs/ime-matrix`；`09` W5-B/W6-B-S | WIP 抬 DocSession 完成；IME-S 关叶子核；删 fixture 轨；--no-verify |

### 行 #8 选用说明（主控二选一或拆两拍）

| 选项                    | 何时选                                                                | 诚实边界                                                                                                               |
| ----------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **8a hydrate 默认深化** | 工作区已有 `createProductStrictHydrateTransport` 半成品、欲合入并测稳 | **≠ 打开完成**；query 派生须保留 R17 诚实句；**不算** hydrate IPC「首批」重复（首批=命令+契约；本行=**产品默认接线**） |
| **8b W6-B-S IME**       | hydrate WIP 暂不合入 / 另拍合入                                       | 必须 **`-S`**；**≠** W6-B Strict；**≠** EL                                                                             |

> 若两轨同轮都要做：拆成两名 ② Agent 且 **文件域不撞**（desktop note-paper vs editor-kit）；此时可将表扩到 9 行或用 8a+另拍 8b——**禁止**为凑数空包。

### 并行组合

```
已过：… · 产品默认 · poll · move · 拖拽 · chrome 皮
      · **hydrate IPC 首批** · **DomMount 首批** · **W6-A-S 首批**
      · **CAS-S** · **SURF-04/05 加深** · **send_to_note** · **visual 06/07**
        │
        ├─► 【1】OS watcher / A-INV-02 UI     （store 或桌面）
        ├─► 【2】W6-E(-S) 工具门槛            （agent-tools）
        ├─► 【3】slash 真 React 浮层          （呈现；可+美学）
        ├─► 【4】W3-G PaperList               （窗口 DOM）
        ├─► 【5】W6-C-S PERF 骨架             （perf-S）
        ├─► 【6】W3-H turn-into / MD 前缀     （chrome/intent）
        ├─► 【7】W4-C contribute              （扩展宿主）
        └─► 【8】hydrate 默认深化 或 W6-B-S   （desktop 或 ime-S）
```

| 组合             | 说明                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| **推荐默认 T≥8** | ①×1 + ② 派 **#1–#6**（P=6）+ 美学×0–2 → T∈[7,9]；#7/#8 可同轮或顺延                   |
| **吞吐高 T~12**  | ② 八行全派 + 美学×2 + ①（E=0）                                                        |
| **文件冲突**     | #3 与 #4/#6/#8a 同 note-paper/block-paper 须串行或拆文件；#1 与既有 mirror 追加不互抹 |
| **本波不做**     | 重复 T=10 七面；关 EL；假 DocSession 全链                                             |

> **若主控资源紧**：优先 **#1 watcher/UI**、**#2 W6-E-S**、**#3 slash 真浮层**、**#4 W3-G**、**#5 W6-C-S**、**#6 W3-H**（保证 **≥6 包规划已派或明确顺延标注**）；**禁止**只派 2–3 且把 6 当成上限。

---

## ③ 审计后执行（E≤6，可 0）

| #   | 补洞项 | 文件域 | 完成定义                                    |
| --- | ------ | ------ | ------------------------------------------- |
| —   | **无** | —      | **E=0**：无阻塞红项；R9–R20 并入 ② 完成定义 |

> 无红则 E=0。若**本轮 ②** 引入回归/假关，**下轮** ① 深审后把补洞写入下轮 ③（E>0，≤6，独立于 ②）。

### 下轮 ③ 触发示例（非穷尽）

- hydrate 深化：fixture 伪装 `tauri-ipc`；query 派生抬 DocSession 完成；挂载关 EL-01/08；删 Skeleton
- W6-E：Memory/工具绿关 EL-05；回退 move/lossy
- slash / PaperList / turn-into：DOM/UI 关 EL-01
- watcher：假关 EL-03；抹 poll 诚实边界 / X-05
- W6-C-S：结构绿关数值 / EL-03
- W4-C：句柄关 EL-07
- W6-B-S：去 `-S` 冒充 W6-B
- 任意：假关 EL；`--no-verify`；互抹；**重复派 T=10 已交面**；违反 T∈[6,16] 空壳充数

---

## 1. 建议本波 / 下轮执行序（主控 · ①∥②）

| 步  | 动作                                                                                          |
| --- | --------------------------------------------------------------------------------------------- |
| 1   | 确认本目录 ① 已落盘；读 `00` 总判 黄 + PREP                                                   |
| 2   | **本轮同开**：② 按本表派 **≥6**（建议 6–8）；③ E=0 可空；呈现轮可加 §4.2 美学×2（slash 浮层） |
| 3   | 收齐后 ① 审**实际合入**包（勿只抽历史）；刷新再下一轮 04                                      |
| 4   | 回写 `19`：HEAD / 审计指针 → 本目录；下一闸对齐本表                                           |

---

## 2. 完成定义总禁（所有 ② 共用）

- 禁止假关 EL-01…10
- 禁止去 `-S` 冒充 Strict
- 禁止 fixture 伪装 tauri-ipc
- 禁止 query 派生 hydrate 抬 `DocSession::hydrate` 全链
- 禁止 DOM/挂载/视觉关 EL-01
- 禁止 Memory 关生产工具/EL-05
- 禁止 `--no-verify`
- 禁止互抹并行域已绿测与诚实未做句

---

_2026-08-12 审计 · 04 · 下一阶段子 Agent 计划 · post-t10_
