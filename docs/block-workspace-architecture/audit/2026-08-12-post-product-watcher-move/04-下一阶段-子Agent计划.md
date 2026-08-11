# 04 · 下一阶段子 Agent 计划（主控可直接抄）

| 元数据       | 值                                                                             |
| ------------ | ------------------------------------------------------------------------------ |
| **输入**     | 本目录 `00`–`03`；`09` Wave 2–6；`19` 下一闸；`22` §4（**T∈[6,16]** · ② 宜多） |
| **纪律**     | `20` §3.2–3.3 窄读；LOGIC 不砍效果锁；禁止 --no-verify；禁止假关 EL            |
| **三套计数** | ① 本审计已完；② 下表写死（**行数=派包数 · ≥6**）；③ 独立 E≤6（本轮建议 **0**） |

> **调度钉死（`22` §4 · 2026-08-12）**
>
> - 整轮 `T = ① + ② + ③ + 美学 ∈ [6, 16]`
> - **② = 本表行数**（宜 4–10，**可远大于 3**）；**禁止**把「本波 3 行」读成整轮只能 3 人或 ② 单桶帽
> - **③** = 修复清单（本轮 E=0 不占）
> - 无 E 时须派够 ②（+美学）使 **T≥6**；常态目标 **8–12**

---

## ① 审计：本文件已完成（对齐 `22` · ①∥② 同轮）

- 产出：`docs/block-workspace-architecture/audit/2026-08-12-post-product-watcher-move/**`
- 上轮 `2c17188e`：产品默认 / poll watcher / `block_move` / 拖拽+chrome **可维持**；目的清单 7 条全绿；历史并行域 **无误伤**
- **轮次形态（钉死）**：下轮 **①∥②∥美学 同轮并行**——① 审**本轮 ② 已合入成果**；② 读**本文件**表行派包
- 预备备忘：同目录 [`PREP-下轮并行备忘.md`](./PREP-下轮并行备忘.md)

---

## 0. 必须先修审计红项？

| 级别           | 项                                                                                                            | 动作                   |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 🔴 阻塞        | **无**                                                                                                        | 上轮四包均可维持       |
| 🟨 前进中诚实  | 真 hydrate IPC；W6-A-S；桌面 React chrome；OS inotify/A-INV-02 UI；W6-E；slash 真浮层；A-SURF 产品链；A-MD 深 | **并入 ②**，不单开修账 |
| 环境黄（非 ③） | agent-tools `kill_subagent` dead_code 警告等杂项                                                              | **不**占 E；非假关     |
| 禁止           | 假关 EL；去 `-S`；fixture 抬打开完成；poll 抬 inotify；move 抬 EL-05；重复派已交四包                          | 会计铁律               |

**结论：可与 ① 同轮直接派 ②；③ E=0（无补洞红项）。**

---

## ② 计划方案 Agent（数量=表行数，写死）

> **数量 = 8**（表有 **8** 行）。  
> **不是「本波只 3」**；不与 ③ 合计成「只能 3」。  
> 建议同轮至少派 **6** 行（T 下限）；其余可顺延至下一拍，但 **表必须保留 ≥6 行规划**。
>
> **禁止**再派已交付：
>
> - **W5-B 产品默认**（`2c17188e`：空态 Strict 主 CTA + Skeleton 次入口 + fixture）
> - **W2-E poll watcher 子集**（`MirrorWatchHandle` / `MirrorWatcher`）
> - **block_move 独立工具**（registry + 矩阵 + Store 真路径）
> - **W3-F 拖拽 ghost 预览**（`chrome.w3f_drag`）
> - **chrome 视觉皮一期+二期首批**（`blockChrome.css` / visual-align G1–G3 + 04/05）
> - **W4-F 余量** Store+update/delete（`b48247f1`）
> - **W2-A gfm-core 首批** / **W2-F refs 首批** / **W5-C 隔离子集首批**（`17acf09d`）
>
> **本表只顺延：真 IPC / W6 / 桌面 chrome / inotify / 工具满关门槛 / slash 产品浮层 等。**

| #   | 包ID                                | 轨                                     | 文件域锁                                                                                                                              | 完成定义                                                                                                                                                                               | 强制阅读                                                               | 禁止                                                                |
| --- | ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | **真 hydrate / DocSession IPC**     | Strict 方向；**≠ 打开完成假关**        | **锁** `apps/crish-desktop` note transport/IPC 适配 ± `conex-note-runtime`/collab 接线（**不**删 fixture 演示轨；**不**回退双轨入口） | ① 可点名产品路径 `source` 可达 `tauri-ipc` 或等价真 hydrate（测绿）② fixture 演示轨**保留** ③ 显式 **≠ EL** / ≠「块工作区完成」 ④ 失败/空/成功三态 ⑤ 边界句仍钉 fixture≠默认若未切全量 | `plans/00`；`plans/07`；`09` W5-B/W1-H；`08` EL-01/08；本审计 `03` R10 | 假关 EL；fixture 伪装 ipc；删 Skeleton；--no-verify                 |
| 2   | **W6-A-S** A-BLK 抽样 e2e           | **必须带 `-S`**；**禁止 EL-01**        | e2e / playwright 抽样 ± note-paper 只读夹具（**不**改 EL-dashboard 关项）                                                             | ① 包 ID 含 `-S` ② A-BLK **抽样**（非 01…14 全表）可点测 ③ 页脚/报告 **禁止** EL-01 ④ 与 W6-A Strict 分轨文档                                                                           | `09` W6-A-S；`08` EL-01；`A-BLK-progress`；本审计 `03` R12             | 去 `-S`；抽样关 EL-01；mock 冒充 W6-A；--no-verify                  |
| 3   | **桌面 React chrome 挂载**          | Strict 方向；**≠ EL-01**               | **锁** `apps/crish-desktop` note-paper 挂载 `BlockChromeDomHost`/React 壳 ± `packages/block-paper` 导出（**不**回退 jsdom 契约测）    | ① 桌面路径可点名挂载 chrome 宿主 ② 把手/落点/slash 宿主至少一路径可见可测 ③ **≠** A-BLK 产品 e2e 满关 ④ 与 collab sink 不回退                                                          | `plans/05`；`09` W3-F；chrome 测文件；本审计 `01` §2.4                 | 挂载关 EL-01；回退 drag 测；--no-verify                             |
| 4   | **OS watcher / A-INV-02 UI 方向**   | Strict 方向；**≠ poll 重复当新包**     | **锁** `conex-workspace-store` mirror 产品事件 **或** 桌面订阅层（**不**回退 detect/poll/X-05）                                       | ① inotify/FSEvents **或** 桌面 timer 产品接线 **可点名其一** ② 显式 **≠**「poll API 已等于 inotify 满关」若只做 UI ③ **≠ EL-03** ④ 既有 poll 测不回退                                  | `plans/02`；`09` W2-E；`mirror.rs` 头；本审计 `03` R11                 | detect/poll 叙事重复；假关 EL-03；静默盖 unpushed 回退；--no-verify |
| 5   | **W6-E-S 或 W6-E 骨架**             | 工具恶意/千次批门槛；**≠ EL-05 满关**  | **锁** `crates/agent-tools` ± note-runtime 压测夹具（**不**回退 batch/move/lossy/审批）                                               | ① 千次批 **或** 恶意扩展 **骨架可测**（S 轨须带 `-S` 叙事）② 显式 **≠ EL-05 / ≠ A-AGT 满表** ③ plan Deny / execution_unknown 不回退                                                    | `09` W6-E；`08` EL-05；本审计 `03` R9                                  | Memory 关生产；假关 EL-05；回退 move；--no-verify                   |
| 6   | **slash 真 React 浮层 / catalog**   | 呈现；**可与 §4.2 美学并行**；**≠ EL** | **锁** note-paper / block-paper slash 浮层 React（**不**回退 `SlashMenuModel` collab 子集）                                           | ① 产品可点 slash 浮层（catalog 至少最小集）② 选项 → Intent → sink 路径不回退 ③ **≠** A-BLK-02 产品 e2e 满关 / EL-01                                                                    | `plans/05`；visual-align `04`；`SlashMenuModel`                        | 浮层关 EL；回退 w3f_apply；--no-verify                              |
| 7   | **A-SURF 产品链 / W5-C 续**         | Strict 方向；**≠ EL-08 假关**          | **锁** isolation / dual-engine surface / 产品挂载探测（**不**回退 A-SURF-02/03 真扫子集）                                             | ① 产品路径可点名 SURF 断言扩展或挂载链 ② 显式 **≠ EL-08** 直至仪表盘条件 ③ 既有 isolation 测绿                                                                                         | `09` W5-C；`08` EL-08；`dual-engine-surface` 测                        | W5-B-S 挂载冒充 EL-08；回退 SURF；--no-verify                       |
| 8   | **A-MD 加深 或 W6-C 结构/数值方向** | MD 或 PERF；**≠ EL-06/03 假关**        | md-ast golden/kind **或** perf baseline 结构门（**不**回退 ApplyReport lossy / gfm-core 首批）                                        | ① 可点名新 golden/kind **或** 结构 checklist 可证伪 ② 显式 **≠ EL-06 / ≠ EL-03 数值满关** ③ gfm/refs 不回退                                                                            | `09` W2-A/W6-C；`08` EL-06/03；`perf-baseline`                         | 6 golden 关 EL-06；结构绿关数值；--no-verify                        |

### 并行组合

```
已过：… · gfm · W2-F · W5-C 子集 · W4-F 余量 · 视觉 G1–G3
      · **产品默认** · **poll watcher** · **block_move** · **拖拽 ghost** · **chrome 皮**
        │
        ├─► 【1】真 hydrate IPC              （crish-desktop + runtime）
        ├─► 【2】W6-A-S 抽样 e2e             （e2e-S）
        ├─► 【3】桌面 React chrome           （desktop 挂载）
        ├─► 【4】OS watcher / A-INV-02 UI    （store 或桌面订阅）
        ├─► 【5】W6-E(-S) 工具门槛           （agent-tools）
        ├─► 【6】slash 真浮层                （呈现；可+美学）
        ├─► 【7】A-SURF 产品链               （isolation）
        └─► 【8】A-MD 深 / W6-C 方向         （md-ast 或 perf）
```

| 组合             | 说明                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| **推荐默认 T≥8** | ①×1 + ② 派 **#1–#6**（P=6）+ 美学×0–2 → T∈[7,9]；#7/#8 可同轮或顺延  |
| **吞吐高 T~12**  | ② 八行全派 + 美学×2 + ①（E=0）                                       |
| **文件冲突**     | #1 与 #3 同改 note-paper 须串行或拆文件；#4 与既有 mirror 追加不互抹 |
| **本波不做**     | 重复产品默认/poll/move/拖拽/chrome 皮/W4-F 余量/gfm/W2-F；关 EL      |

> **若主控资源紧**：优先 **#1 真 IPC**、**#2 W6-A-S**、**#3 React chrome**、**#4 watcher 产品向**、**#5 W6-E 骨架**、**#6 slash 浮层**（保证 **≥6 包规划已派或明确顺延标注**）；**禁止**只派 2–3 且把 6 当成上限。

---

## ③ 审计后执行（E≤6，可 0）

| #   | 补洞项 | 文件域 | 完成定义                                    |
| --- | ------ | ------ | ------------------------------------------- |
| —   | **无** | —      | **E=0**：无阻塞红项；R9–R15 并入 ② 完成定义 |

> 无红则 E=0。若**本轮 ②** 引入回归/假关，**下轮** ① 深审后把补洞写入下轮 ③（E>0，≤6，独立于 ②）。

### 下轮 ③ 触发示例（非穷尽）

- 真 IPC：fixture 伪装 `tauri-ipc`；挂载关 EL-01/08；删 Skeleton
- W6-A-S：去 `-S`；抽样关 EL-01
- React chrome / 拖拽：DOM 关 EL-01
- watcher：假关 EL-03；抹 poll 诚实边界 / X-05
- W6-E：Memory/工具绿关 EL-05；回退 move/lossy
- 任意：假关 EL；`--no-verify`；互抹；**重复派已交四包**；违反 T∈[6,16] 空壳充数

---

## 1. 建议本波 / 下轮执行序（主控 · ①∥②）

| 步  | 动作                                                                            |
| --- | ------------------------------------------------------------------------------- |
| 1   | 确认本目录 ① 已落盘；读 `00` 总判 黄 + PREP                                     |
| 2   | **本轮同开**：② 按本表派 **≥6**（建议 6–8）；③ E=0 可空；呈现轮可加 §4.2 美学×2 |
| 3   | wait 收齐 ② → 更新 `19`/`22`（**不写 EL 关闭**）                                |
| 4   | **下轮 ①∥②**：① 目的性审新包 + 抽检 EL/双轨/lossy 是否互伤；② 读新 04           |
| 5   | 再下一闸：W6-A Strict 全表 / W6-C 数值 / 未派行（由下轮 04 写死）               |

---

## 2. 主控 prompt 强制块（公共尾）

每个 **②** 实现 Agent prompt **必须**含：

```markdown
## 轨

- 包 ID：…
- 文件域：…
- 禁止改：冲突锁外目录；禁止 --no-verify

## 强制阅读（先 read_file 再改代码）

1. plans/00-总方案.md
2. plans/0N-（本维）.md
3. 15-评审后锁定修订.md
4. 20 §1 + §3.2
5. 08 中本包相关 EL 行
6. 09 本包行
7. 本包 interfaces/specs（列路径）
8. 验收 ID 列表全文
9. audit/2026-08-12-post-product-watcher-move/01（边界）与 03（伪完成）
10. 22 §4（T∈[6,16]；② 宜多；禁「只 3」当总帽）

## 完成定义

- 每条验收：测名路径 或 无测=未完成
- 禁止写 EL / 块工作区完成

## 禁止

- 偷换 09 包定义；伪 A-*；mock 冒充 Strict 关闭
- 把本包完成抬成 EL-01 / EL-03 / EL-05 / EL-06 / EL-08
- 重复实现已交：产品默认 / poll watcher / block_move / 拖拽 ghost / chrome 皮 / W4-F 余量 / gfm / W2-F
- 回退 Store apply_block_ops / update/delete/move / W4-A lossy / W4-B 审批 / W2-C / W2-E detect+poll / W2-F / W5 双轨
- Skeleton 去 `-S`；Memory 关生产 A-AGT；fixture 伪装 ipc；poll 抬 inotify 满关
```

---

## 3. 一句话给主控

> **无红项；① 本审计已完可抄；本轮 ② 表 **8 行**（建议同轮派 ≥6：真 IPC ∥ W6-A-S ∥ React chrome ∥ watcher 产品向 ∥ W6-E 骨架 ∥ slash 浮层 ∥ …）；③ E=0；T∈[6,16]；**勿**「本波只 3」当总帽；全部 ≠ 关 EL；已交四包勿重复。**

---

### ② 表摘要（≥6 行 · 主控速览）

| #   | 包ID                        | 一句话完成定义                               |
| --- | --------------------------- | -------------------------------------------- |
| 1   | 真 hydrate / DocSession IPC | 产品 `source` 真路径可测；fixture 保留；≠ EL |
| 2   | W6-A-S                      | A-BLK 抽样 e2e；**带 `-S`**；禁 EL-01        |
| 3   | 桌面 React chrome           | 产品壳挂载 DomHost；≠ e2e 满关               |
| 4   | OS watcher / A-INV-02 UI    | inotify 或产品订阅；≠ poll 假满关；≠ EL-03   |
| 5   | W6-E(-S)                    | 千次/恶意骨架；≠ EL-05 满表                  |
| 6   | slash 真 React 浮层         | catalog 可点；collab 不回退；≠ EL-01         |
| 7   | A-SURF 产品链               | 产品 SURF 扩展；≠ EL-08 假关                 |
| 8   | A-MD 深 / W6-C 方向         | golden 或结构门；≠ EL-06/03 满关             |

---

_2026-08-12 审计 · 04 · 主控可抄 · ② 行数=8（≥6）· T∈[6,16] · E=0 · 已交四包勿重复_
