# 04 · 下一阶段子 Agent 计划（主控可直接抄）

| 元数据       | 值                                                                                   |
| ------------ | ------------------------------------------------------------------------------------ |
| **输入**     | 本目录 `00`–`03`；`09` Wave 2–6；`19` 下一闸；`22` §4（**T∈[6,16]** · ② 宜多）       |
| **纪律**     | `20` §3.2–3.3 窄读；LOGIC 不砍效果锁；禁止 --no-verify；禁止假关 EL                  |
| **三套计数** | ① 本审计已完（本轮 ① 实际 **3** 人 a/b/c）；② 下表写死（**行数=8**）；③ 独立 **E=0** |

> **调度钉死（`22` §4 · 2026-08-12）**
>
> - 整轮 `T = ① + ② + ③ + 美学 ∈ [6, 16]`
> - **② = 本表行数**（宜 4–10，**可远大于 3**）；**禁止**把「本波只 3 行 / 本轮 ①=3」读成整轮只能 3 人或 ② 单桶帽
> - **③** = 修复清单（本轮 E=0 不占）
> - 无 E 时须派够 ②（+美学）使 **T≥6**；常态目标 **8–12**
> - **下轮 ① 建议仍 2–3**（目的性 + 规范/交叉可并行）；**② 行数独立**

---

## ① 审计：本文件已完成（对齐 `22` · ①∥② 同轮）

- 产出：`docs/block-workspace-architecture/audit/2026-08-12-post-t11-os-w6e-slash-paperlist/**`
- 上轮 `b9ffe73c`：OS watcher / W6-E-S / slash React / PaperList / W6-C-S / W3-H / A-MD / hydrate 默认 / visual 08·09 **可维持**；目的清单 10 条全绿；并行域 **无误伤**；**E=0**
- **轮次形态（钉死）**：下轮 **①∥②∥美学 同轮并行**——① 审**本轮 ② 已合入成果**；② 读**本文件**表行派包
- 预备备忘：同目录 [`PREP-下轮并行备忘.md`](./PREP-下轮并行备忘.md)
- 同目录 `05`/`06` 由 ①b/①c 写（预留；①a **不覆盖**）

---

## 0. 必须先修审计红项？

| 级别           | 项                                                                                                                              | 动作                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 🔴 阻塞        | **无**                                                                                                                          | 上轮九面均可维持       |
| 🟨 前进中诚实  | A-INV-02 UI；DocSession 全链；PaperList 产品挂载；W4-C；W6-B-S；W3-E；W4-D；W5-D-S/W6-D-S                                       | **并入 ②**，不单开修账 |
| 环境黄（非 ③） | agent-tools `kill_subagent` dead_code 等                                                                                        | **不**占 E             |
| 禁止           | 假关 EL；去 `-S`；fixture 伪装 ipc；query 派生抬 DocSession；DOM/PaperList 关 EL-01；TBD 当绿；重复派 T=11 已交面；「只 3」当帽 | 会计铁律               |

**结论：可与 ① 同轮直接派 ②；③ E=0（无补洞红项）。**

---

## ② 计划方案 Agent（数量=表行数，写死）

> **数量 = 8**（表有 **8** 行）。
> **不是「本波只 3」**；不与 ③ 合计成「只能 3」；**不**因本轮 ①=3 而砍 ②。
> 建议同轮至少派 **6** 行（T 下限）；其余可顺延至下一拍，但 **表必须保留 ≥6 行规划**。
>
> **禁止**再派本轮已交付（`b9ffe73c` 首批及更早同名首批）：
>
> - **OS watcher 首批**（`mirror_os_watch` + notify；**≠** 禁止「A-INV-02 **产品 UI**」另包）
> - **W6-E-S 首批**（`note_w6e_skeleton` 千次批+恶意扩展骨架）
> - **slash React 首批**（`SlashMenuOverlay` + `slashSelectAndSubmit`）
> - **W3-G PaperList 首批**（窗口 DOM + overscan/pin + 1 万块结构）
> - **W6-C-S 首批**（perf-baseline 骨架 + contract 测）
> - **W3-H 首批**（turn-into / mdPrefix / unknownFlavour + composing 禁）
> - **A-MD 本批**（`golden_w2a_deepen`）
> - **hydrate 默认首批**（`createProductStrictHydrateTransport` + EmptyState 接线）
> - **visual 08/09**（对照+设计落地）
> - 更早 T=10 及以前：hydrate IPC 命令首批 / DomMount 首批 / W6-A-S / CAS-S / SURF 加深 / send_to_note / visual 06·07 / poll watcher / block_move / 拖拽 / W4-F 余量 / gfm-core 首批 / W2-F / W5-C 子集 等
>
> **本表只顺延：W4-C · W6-B-S · A-INV-02 UI · DocSession 全链 hydrate · PaperList 产品挂载深化 · W3-E · W4-D · W5-D-S/W6-D-S 等。**

| #   | 包ID                                    | 轨                                 | 文件域锁                                                                                                         | 完成定义                                                                                                                                                                | 强制阅读                                                 | 禁止                                                             |
| --- | --------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **W4-C contribute / 扩展宿主方向**      | Strict 方向；**≠ EL-07 满关**      | **锁** agent-tools / 扩展宿主 contribute 拒写或注册面（**不**回退 W4-B 审批 / W4-F / W6-E-S）                    | ① contribute 拒写句柄 **或** 扩展注册可测 ② 显式 **≠ EL-07** ③ 审批/batch/W6-E-S 边界不回退                                                                             | `plans/06`；`09` W4-C；`08` EL-07；本审计 `03` R9        | 仅句柄关 EL-07；回退权限矩阵；假关 EL-05；--no-verify            |
| 2   | **W6-B-S IME 矩阵 Skeleton**            | Skeleton；**必须带 `-S`**          | **锁** `editor-kit` / IME 矩阵骨架（**不**回退 TextLeaf composing / W3-H composing 禁）                          | ① 包 ID **W6-B-S** ② IME L0–L1 **可测**抽样 ③ 显式 **≠ W6-B Strict / ≠ EL** ④ composing 结构禁不回退                                                                    | `specs/ime-matrix`；`09` W6-B-S；本审计 R12              | 去 `-S` 冒充 W6-B；IME-S 关叶子核；--no-verify                   |
| 3   | **A-INV-02 产品 UI / 三路对话框**       | Strict 方向；**≠ OS watcher 重复** | **锁** 桌面订阅/三路 UI（**不**回退 `mirror_os_watch` / detect / poll / X-05）                                   | ① 产品可点 **三路**（import/keep/export 等）**或** 桌面 OS 事件订阅装配 **可点名其一** ② 显式 **≠**「OS 模块=UI 满关」③ **≠ EL-03** ④ detect/X-05/poll/OS 测不回退      | `plans/02`；`09` W2-E；`mirror_os_watch` 头；本审计 R11+ | poll/OS 叙事重复；假关 EL-03；静默盖 unpushed；--no-verify       |
| 4   | **DocSession 全链 hydrate**             | Strict 方向；**≠ 打开完成假关**    | **锁** note-runtime / collab hydrate 权威路径 ± 桌面 IPC 深化（**串行** hydrateProjection；**不**删 fixture 轨） | ① 真 **DocSession::hydrate**（或权威对等）路径可测 ② 与 query 派生 **分轨诚实** ③ 显式 **≠ 打开完成 / ≠ EL-01/08** 若产品链未满 ④ 双轨 Skeleton 保留；source 纪律不伪装 | 本审计 `01` §1.8 + `03` R16/R17；`09` G-HYD/W5-B         | query 派生抬全链完成；fixture 伪装 ipc；删 Skeleton；--no-verify |
| 5   | **PaperList 产品挂载深化**              | Strict 方向；**≠ W3-G 首批重复**   | **锁** note-paper 挂载 PaperList 到 Strict/产品面板（**不**回退 `PaperList` 窗口 DOM / DomMount / slash）        | ① 产品/Strict 面板 **可点** PaperList 挂载 ② 滚动窗口仍结构有界 ③ **≠ EL-01 / ≠ 数值门** ④ 禁 CSS hidden 假虚拟化不回退                                                 | `plans/05`；`PaperList.ts`；本审计 R22；visual 08/09     | PaperList 关 EL；回退 w3g 结构测；--no-verify                    |
| 6   | **W3-E 选区 / 多选 / 焦点方向**         | Strict 方向；**≠ EL-01 全 e2e**    | **锁** block-paper 选区/多选模型 ± note-paper 呈现（**不**回退 chrome 多选框 / StructureIntent）                 | ① 选区或跨块多选 **可点名可测** ② composing/焦点 pin 不回退 ③ **≠ EL-01**；A-BLK 相关可更新抽样不关 EL                                                                  | `plans/05`；`09` W3-E；`08` EL-01                        | 抽样关 EL-01；回退 w3f_dom；--no-verify                          |
| 7   | **W4-D MCP / 工具外延方向**             | Strict 方向；**≠ EL-05 满关**      | **锁** agent-tools MCP 桥或外延工具子集（**不**回退 note 工具 / 审批 / W6-E-S）                                  | ① MCP 或外延 **可测**方向子集 ② 显式 **≠ EL-05 / ≠ A-AGT 满表** ③ plan Deny / batch 不回退                                                                              | `plans/06`；`09` W4-D；本审计 R9                         | Memory 关生产；假关 EL-05；--no-verify                           |
| 8   | **W5-D-S 或 W6-D-S 协作/呈现 Skeleton** | Skeleton；**必须带 `-S`**          | **锁** 协作子集或呈现 Skeleton（按 `09` 选一；**不**回退 W5-B 双轨 / W1-U）                                      | ① 包 ID 带 **`-S`** ② 骨架可测 ③ 显式 **≠** 对应 Strict / **≠ EL-04/08 满关** ④ 既有 collab/hydrate 边界不回退                                                          | `09` W5-D-S / W6-D-S；`08` EL-04/08                      | 去 `-S`；Skeleton 关 EL；--no-verify                             |

### 行选用说明（主控）

| 选项                      | 何时优先                         | 诚实边界                           |
| ------------------------- | -------------------------------- | ---------------------------------- |
| **#3 A-INV-02 UI**        | OS 事件已有、缺产品面            | **≠** 重复做 notify 封装           |
| **#4 DocSession 全链**    | 欲消 R17「query 派生」诚实债     | 真路径前 **禁止** 改叙事为全链已关 |
| **#5 PaperList 产品挂载** | W3-G 结构已有、缺面板接线        | **≠** 重写 PaperList 首批          |
| **#2 W6-B-S**             | 呈现/IME 轮；可与 §4.2 美学并行  | 必须 `-S`                          |
| **#8 W5-D-S / W6-D-S**    | 协作或呈现骨架；二选一文件域不撞 | 必须 `-S`                          |

### 并行组合

```
已过：… · T=10 七面 · **T=11 九面**
        （OS watcher · W6-E-S · slash React · PaperList · W6-C-S
         · W3-H · A-MD deepen · hydrate 默认 · visual 08/09）
        │
        ├─► 【1】W4-C contribute              （扩展宿主）
        ├─► 【2】W6-B-S IME                   （editor-kit · -S）
        ├─► 【3】A-INV-02 产品 UI             （桌面 UI；≠ 重做 OS）
        ├─► 【4】DocSession 全链 hydrate      （runtime/collab）
        ├─► 【5】PaperList 产品挂载深化       （note-paper 挂载）
        ├─► 【6】W3-E 选区/多选               （chrome/选区）
        ├─► 【7】W4-D MCP/外延                （agent-tools）
        └─► 【8】W5-D-S 或 W6-D-S             （Skeleton · -S）
```

| 组合             | 说明                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| **推荐默认 T≥8** | ①×2–3 + ② 派 **#1–#6**（P=6）+ 美学×0–2 + E=0 → T∈[8,11]；#7/#8 可同轮或顺延                        |
| **吞吐高 T~12**  | ② 八行全派 + 美学×2 + ①×2（E=0）                                                                    |
| **文件冲突**     | #4 与 hydrate 热文件串行；#5 与 note-paper/DomMount/slash 串行或拆文件；#1/#7 同 agent-tools 注意锁 |
| **本波不做**     | 重复 T=11 九面首批；关 EL；TBD 当绿；去 `-S`；假 DocSession 完成                                    |

> **若主控资源紧**：优先 **#1 W4-C**、**#2 W6-B-S**、**#3 A-INV-02 UI**、**#4 DocSession 全链**、**#5 PaperList 挂载**、**#6 W3-E**（保证 **≥6 包规划已派或明确顺延标注**）；**禁止**只派 2–3 且把 6 当成上限。

---

## ③ 审计后执行（E≤6，可 0）

| #   | 补洞项 | 文件域 | 完成定义                                 |
| --- | ------ | ------ | ---------------------------------------- |
| —   | **无** | —      | **E=0**：无阻塞红项；R\* 并入 ② 完成定义 |

> 无红则 E=0。若**本轮 ②** 引入回归/假关，**下轮** ① 深审后把补洞写入下轮 ③（E>0，≤6，独立于 ②）。

### 下轮 ③ 触发示例（非穷尽）

- A-INV-02 UI：假关 EL-03；抹 OS/poll/X-05 诚实边界；静默盖 unpushed
- DocSession 全链：query 派生抬完成；fixture 伪装 ipc；删 Skeleton；挂载关 EL-01/08
- W6-B-S / W5-D-S / W6-D-S：去 `-S` 冒充 Strict
- W4-C：句柄关 EL-07；回退审批
- W4-D / 工具：Memory 关 EL-05；回退 move/lossy/W6-E-S
- PaperList 挂载 / W3-E：DOM 关 EL-01；hidden 假虚拟化复发
- W6-C-S 被顺手「数值填假」/ 去 `-S`
- 任意：假关 EL；`--no-verify`；互抹；**重复派 T=11 已交面**；违反 T∈[6,16] 空壳充数

---

## 1. 建议本波 / 下轮执行序（主控 · ①∥②）

| 步  | 动作                                                                                               |
| --- | -------------------------------------------------------------------------------------------------- |
| 1   | 确认本目录 ①a 已落盘；读 `00` 总判 黄 + PREP；收齐 ①b/①c 的 05/06（若有）                          |
| 2   | **本轮同开**：② 按本表派 **≥6**（建议 6–8）；③ E=0 可空；呈现轮可加 §4.2 美学×0–2（PaperList/IME） |
| 3   | 收齐后 ① 审**实际合入**包（勿只抽历史）；刷新再下一轮 04                                           |
| 4   | 回写 `19`：HEAD / 审计指针 → 本目录；下一闸对齐本表                                                |

---

## 2. 完成定义总禁（所有 ② 共用）

- 禁止假关 EL-01…10
- 禁止去 `-S` 冒充 Strict
- 禁止 fixture 伪装 tauri-ipc
- 禁止 query 派生 hydrate 抬 `DocSession::hydrate` 全链完成
- 禁止 DOM / PaperList / slash / 视觉关 EL-01
- 禁止 Memory 关生产工具 / EL-05
- 禁止 TBD 数值当 PERF 通过 / 关 EL-03
- 禁止 poll/OS 叙事 inotify 满关 / 抹 X-05
- 禁止 `--no-verify`
- 禁止互抹并行域已绿测与诚实未做句
- 禁止重复派 T=11 已交九面首批

---

_2026-08-12 审计 · 04 · 下一阶段子 Agent 计划 · post-t11 · ①a_
