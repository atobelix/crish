# 04 · 下一阶段子 Agent 计划（主控可直接抄）

| 元数据       | 值                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **输入**     | 本目录 `00`–`03`；上轮 `post-t11/{05,06}`（SD/CONN 权威）；`09`；`19`；`22` §4 + **§4.1.1**           |
| **纪律**     | `20` §3.2–3.3 窄读；LOGIC 不砍效果锁；禁止 --no-verify；禁止假关 EL；**结构债默认 ② 非 ③**            |
| **三套计数** | ① 本审计 ①a 已完（建议同轮 ①b/①c 补 05/06）；② 下表写死（**行数=8**，**其中 SD/CONN ≥2**）；③ **E=0** |

> **调度钉死（`22` §4 · §4.1.1 · 2026-08-12）**
>
> - 整轮 `T = ① + ② + ③ + 美学 ∈ [6, 16]`
> - **② = 本表行数**（宜 4–10）；**禁止**「本波只 3」当总帽
> - **§4.1.1**：上轮 05/06 未关 SD/CONN → 本表 **≥2 行必须是 SD/CONN 还债**；**禁止**只抄新 Wave 零还债
> - **③** 仅假关/回退/测红；**结构债不进 ③ 伪装可拖登记**
> - 无 E 时须派够 ②（+美学）使 **T≥6**；常态目标 **8–12**

---

## ① 审计：本文件已完成（对齐 `22` · ①∥② 同轮）

- 产出：`docs/block-workspace-architecture/audit/2026-08-12-post-t14-debt-connectivity/**`
- 上轮 `db93c82e`：W4-C / W6-B-S / A-INV-02 UI / DocSession hydrate / PaperListDomMount / W3-E code / W4-D / W5-D-S / mdPrefixHost / visual 10·11 **可维持**；目的清单 **9 绿 + 1 黄**（SD/CONN 未还）；**E=0**
- **轮次形态（钉死）**：下轮 **①∥②∥美学 同轮并行**——① 审**本轮 ② 已合入成果**；② 读**本文件**表行派包
- 预备备忘：同目录 [`PREP-下轮并行备忘.md`](./PREP-下轮并行备忘.md)
- 同目录 `05`/`06` 由 ①b/①c 写（预留；①a **不覆盖**）；**开派前必读上轮** `post-t11/05` 与 `post-t11/06`

---

## 0. 必须先修审计红项？

| 级别           | 项                                                                                                                             | 动作                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 🔴 阻塞        | **无**（T=14 合入无假关/无回退红）                                                                                             | 功能面可维持                                 |
| 🟧 工作区 WIP  | SD-01 半拆分（`note_plan_ops` 等未提交；曾见缺 `Debug` 红编）· presentationMode / productSlashSink 未入库                      | **主控收齐**：修绿或还原后再派；**≠** ③ 假关 |
| 🟨 前进中诚实  | 空态 slash 无 sink；PaperList 默认关；mirror 无 IPC；RS turn_into 无；三宿主；巨石 note_backend/store；W3-E 选区未交           | **并入 ②**（含 SD/CONN）                     |
| 环境黄（非 ③） | workbench 测 0xc0000139；kill_subagent dead_code                                                                               | **不**占 E                                   |
| 禁止           | 假关 EL；去 `-S`；fixture 伪装；hydrate 撒谎；Memory/contribute/MCP 关生产；重复派 T=14/T=11 首批；04 零 SD/CONN；「只 3」当帽 | 会计铁律                                     |

**结论：可与 ① 同轮直接派 ②；③ E=0。结构债与连通补洞进 ②。**

---

## ② 计划方案 Agent（数量=表行数，写死）

> **数量 = 8**（表有 **8** 行）。
> **其中 #1–#2（及建议 #3）为 SD/CONN 还债**——满足 §4.1.1「≥2 行 SD/CONN」。
> **禁止**再派下列已交首批：
>
> ### 禁派 · T=14 首批（`db93c82e`）
>
> - **W4-C contribute** 首批（`note_w4c_contribute` 拒写+注册）
> - **W6-B-S IME** 首批（矩阵契约 + `-S` 包轨）
> - **A-INV-02 MirrorDriftStatusBar** 首批（三路 UI 骨架）
> - **DocSession hydrate_path=doc-session** 首批（真 hydrate 分轨）
> - **PaperListDomMount** 首批（桌面挂载 + Strict 分槽）
> - **W3-E code** 首批（flavour/fence/只读/CM6 方向）
> - **W4-D McpRegistryShell** 首批（同 registry list/call）
> - **W5-D-S X-01** 首批（表 G + x01 骨架）
> - **W3-H mdPrefixHost** 首批（产品形状 sink 注入路径）
> - **visual 10/11** 首批
>
> ### 禁派 · T=11 九面首批（及更早）
>
> - OS watcher / W6-E-S / slash React / PaperList 库 W3-G / W6-C-S / W3-H 方向 / A-MD deepen / hydrate 默认选型 / visual 08·09
> - T=10：hydrate IPC 命令 / DomMount / W6-A-S / CAS-S / SURF / send_to_note / visual 06·07
> - 更早：poll watcher / block_move / 拖拽 / W4-F 余量 / gfm-core / W2-F / W5-C 子集 等首批

| #   | 包ID                                                  | 轨                              | 文件域锁                                                                                                                                                  | 完成定义                                                                                                                                                                                                   | 强制阅读                                                            | 禁止                                                 |
| --- | ----------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | **CONN-B · 产品空态 slash 写锥**                      | Strict 方向；**≠ EL-01**        | **锁** `WorkspaceEmptyState` / note-paper slash 绑定（`productSlashSink` 若入库则串行）；**不**回退 collab apply 测 / DomHost `projectSlashCatalog=false` | ① 空态 Strict **显式**可写或只读 catalog（无 sink **禁**静默可点无写）② 有 `applyOps` 时点 slash → wireCalls≥1 可测 ③ 无后端时 disabled/readonly 可测 ④ 显式 **≠ EL-01 / ≠ A-BLK-02 e2e** ⑤ 双浮层门不回退 | 上轮 `06` 链 B · ②-1/②-2/③-1；`SlashMenuOverlay`；本审计 `01` §1.10 | mock 默认生产；假关 EL-01；--no-verify               |
| 2   | **SD-01 · note_backend 纵向切开**                     | 结构债 ②；**≠ EL-05**           | **锁** `crates/agent-tools/src/note_*.rs`（**不**动 subagent/shell 巨石；**不**回退 w4f/w6e/w4c）                                                         | ① 无单业务文件 >900 行（tests 可旁挂）② `plan_block_ops` 分支可单测 ③ **w4f__/w6e__/w4c_*** 全绿 ④ 公开 re-export 不 break ⑤ 半拆分须一次交齐可编译                                                        | 上轮 `05` SD-01；本审计 `02` §4 WIP                                 | 假关 EL-05；半拆分红编强推；--no-verify              |
| 3   | **SD-04 · 呈现策略互斥（反三宿主）**                  | 结构债 ②；**≠ EL-01**           | **锁** note-paper Strict/Skeleton + PaperListDomMount（可抽 `presentationMode`/`useNoteHydrate`）                                                         | ① 产品默认 **不会** 同时全量 `data-content-row` + paper-list 内容块（除非 `debug-dual`）② PaperList 结构门仍过 ③ hydrate 三态不变 ④ Strict 主文件压负或拆 hook ⑤ **≠ EL-01**                               | 上轮 `05` SD-04；`06` 链 C；本审计 `01` §1.5                        | 用 CSS hidden 假互斥；关 EL-01；--no-verify          |
| 4   | **CONN-E · mirror UI→import IPC 骨架**                | Strict 方向；**≠ EL-03**        | **锁** workbench note_commands ± desktop StatusBar 回调；**不**回退 detect/X-05/poll/OS/StatusBar 首批                                                    | ① 一条 mock/真 IPC：accept → import 形状可测 ② unpushed>0 X-05 端到端（UI+门）③ 显式 **≠ inotify 满关 / ≠ EL-03 / ≠ A-INV-02 全关** ④ OS/poll 测不回退                                                     | 上轮 `06` 链 E · ②-7；`mirrorDriftUi`；`import_mirror_proposal`     | 静默盖 unpushed；重复 OS watcher 首批；--no-verify   |
| 5   | **CONN-D · turn_into RS 消费 或 硬门禁**              | Strict 方向；**≠ EL-01**        | **锁** collab Op **或** CI/测硬门（二选一写死）；**不**回退 mdPrefixHost / composing 禁                                                                   | ① **要么** RS 读 `pending_turn_into_flavour`/独立 Op 改 kind 可测 ② **要么** 结构门禁止 w3h 单测算 A-BLK-08 关 + UI 禁读 attrs 当 flavour ③ composing 双守卫不回退 ④ **≠ EL-01**                           | 上轮 `06` 链 D · ③-2；`mdPrefixHost`；`turnInto.ts`                 | provisional 抬真转块；假关 EL-01；--no-verify        |
| 6   | **W3-E′ 选区/多选/焦点方向**                          | Strict 方向；**≠ EL-01**        | **锁** block-paper 选区模型 ± chrome（**不**重复 code 叶首批）                                                                                            | ① 跨块多选或焦点模型 **可点名可测** ② 不回退 w3f_dom / code 叶测 ③ **≠ EL-01**；**≠** 用 code 包冒充本包                                                                                                   | `plans/05`；`09` W3-E；本审计 R27                                   | 抽样关 EL；范围再漂不写清；--no-verify               |
| 7   | **SD-03 · DomHost 拆 slash/drag 投影**                | 结构债 ②；**≠ EL-01**           | **锁** `packages/block-paper/src/chrome/*` + DomMount                                                                                                     | ① DomHost 主文件显著下降（建议 <450）② 契约测仍覆盖 catalog/drag ③ 产品 Strict：Overlay 开时 DomHost **无** catalog items ④ collab apply 不回退                                                            | 上轮 `05` SD-03                                                     | 双浮层复发；关 EL-01；--no-verify                    |
| 8   | **CONN-A′ / G · 打开完成诚实门 或 send_to_note 读回** | Strict 方向；**≠ 打开完成假关** | **锁** hydrate 会计扫描 **或** bridge+Strict refresh（选一主交付）                                                                                        | ① **要么** 注释/测门：禁「DocSession 全链=打开完成」矛盾句 ② **要么** 同 doc send_to_note 后 Strict refresh 见新块 ③ Skeleton 双轨保留 ④ **≠ EL-01/08**                                                    | 上轮 `06` 链 A/G；R16/R17′                                          | fixture 伪装；删 Skeleton；假关打开完成；--no-verify |

### 行选用说明（主控）

| 选项             | 何时优先                            | 诚实边界                     |
| ---------------- | ----------------------------------- | ---------------------------- |
| **#1 CONN-B**    | **必派**（06 Top1 断点）            | 无 sink 须只读态，禁可点无写 |
| **#2 SD-01**     | **必派**（05 最红巨石；WIP 须收口） | ≠ EL-05；一次交齐可编译      |
| **#3 SD-04**     | 与 PaperList/视觉并行时优先         | 互斥默认；debug-dual 仅测    |
| **#4 CONN-E**    | UI 已有 StatusBar 后补 IPC          | ≠ 重做 OS watcher            |
| **#5 CONN-D**    | mdPrefixHost 已有后补权威           | RS 前禁假转块                |
| **#6 W3-E′**     | 补 T=14 相对 04 的选区缺口          | 不重复 code 首批             |
| **#7 SD-03**     | DomHost 体积/双 slash               | 产品关 catalog               |
| **#8 CONN-A′/G** | 防打开完成叙事 / 读回闭环           | 字段诚实 ≠ 完成              |

### 并行组合

```
已过：… · T=11 九面 · **T=14 十面**
        （W4-C · W6-B-S · Mirror UI · doc-session hydrate · PaperListDomMount
         · W3-E code · W4-D · W5-D-S · mdPrefixHost · visual 10/11）
        │
        ├─► 【1】CONN-B 空态 slash 写锥     （连通 · 必派）
        ├─► 【2】SD-01 note_backend 切开   （结构 · 必派）
        ├─► 【3】SD-04 呈现互斥            （结构）
        ├─► 【4】CONN-E mirror import IPC  （连通）
        ├─► 【5】CONN-D turn_into RS/门    （连通）
        ├─► 【6】W3-E′ 选区/多选           （功能余量）
        ├─► 【7】SD-03 DomHost 拆分        （结构）
        └─► 【8】CONN-A′/G 诚实门或读回    （连通/会计）
```

| 组合             | 说明                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| **推荐默认 T≥9** | ①×2–3 + ② 派 **#1–#6**（P=6，含 **2+ SD/CONN**）+ 美学×0–2 + E=0 → T∈[8,11]                                   |
| **吞吐高 T~12**  | ② 八行全派 + 美学×2 + ①×2（E=0）                                                                              |
| **文件冲突**     | #1 与 EmptyState/slash 串行；#2 独占 note_backend 树；#3/#7 与 note-paper/chrome 注意锁；#4 与 workbench 串行 |
| **本波不做**     | 重复 T=14/T=11 首批；关 EL；去 `-S`；04 零 SD/CONN；WIP 红编强推                                              |

> **若主控资源紧**：优先 **#1 CONN-B**、**#2 SD-01**、**#3 SD-04**、**#4 CONN-E**、**#5 CONN-D**、**#6 W3-E′**（保证 **≥6 包且 ≥2 SD/CONN**）；**禁止**只派新功能 2–3 且零还债。

### 再下一轮仍未还的债（本表未派完时保留）

| 债              | 说明                                                        |
| --------------- | ----------------------------------------------------------- |
| **SD-02**       | WorkspaceStore `lib.rs` 门面减负（migrate/FTS/plugin 分模） |
| **SD-05**       | intentId 层序 + 过期「桌面 React chrome 未交付」诚实句清扫  |
| **CONN ②-5**    | chrome focus → PaperList pin 半桥                           |
| **CONN ②-4 余** | 空态 `data-paper-list=0` 快照门（若 #3 未覆盖）             |
| **W6-E Strict** | 千次批+恶意生产门（远后；≠ S 去轨）                         |

---

## ③ 审计后执行（E≤6，可 0）

| #   | 补洞项 | 文件域 | 完成定义                                     |
| --- | ------ | ------ | -------------------------------------------- |
| —   | **无** | —      | **E=0**：无阻塞假关/回退红；SD/CONN **进 ②** |

> 结构债 **默认 ②**。若**本轮 ②** 引入回归/假关，**下轮** ① 深审后把补洞写入下轮 ③（E>0，≤6，独立于 ②）。

### 下轮 ③ 触发示例（非穷尽）

- CONN-B：无 sink 仍可点提交；mock 默认生产；假关 EL-01
- SD-01：半拆分红编合入；回退 w4f/w6e/w4c
- SD-04：CSS hidden 假互斥；默认真双内容宿主抬完成
- CONN-E：静默盖 unpushed；抬 EL-03/inotify
- CONN-D：provisional 抬 RS turn_into 完成
- 任意：假关 EL；去 `-S`；`--no-verify`；重复派 T=14/T=11 首批；04 零 SD/CONN

---

## 1. 建议本波 / 下轮执行序（主控 · ①∥②）

| 步  | 动作                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- |
| 0   | `git status`：WIP SD/CONN 修绿或 stash；**禁止**脏树红编当交付                                             |
| 1   | 确认本目录 ①a 已落盘；读 `00` 总判 黄 + PREP；收齐 ①b/①c 的 05/06（若有）；**必读**上轮 post-t11 `05`/`06` |
| 2   | **本轮同开**：② 按本表派 **≥6**（**含 #1+#2**）；③ E=0 可空；呈现轮可加美学×0–2                            |
| 3   | 收齐后 ① 审**实际合入**包（含 SD/CONN 是否真还）；刷新再下一轮 04                                          |
| 4   | 回写 `19`：HEAD / 审计指针 → 本目录；下一闸对齐本表                                                        |

---

## 2. 完成定义总禁（所有 ② 共用）

- 禁止假关 EL-01…10
- 禁止去 `-S` 冒充 Strict
- 禁止 fixture 伪装 tauri-ipc
- 禁止 hydrate_path 撒谎 / 打开完成假关
- 禁止 DOM / PaperList / slash / 视觉 / code 关 EL-01
- 禁止 Memory / contribute / MCP 关 EL-05/07 生产满表
- 禁止 TBD 数值当 PERF 通过 / 关 EL-03
- 禁止 poll/OS/StatusBar 叙事 inotify 满关 / 抹 X-05
- 禁止 `--no-verify`
- 禁止互抹并行域已绿测与诚实未做句
- 禁止重复派 **T=14 十面首批** 与 **T=11 九面首批**
- 禁止本轮 ② **零 SD/CONN**（§4.1.1）
- 禁止把结构债只写入「技术债 backlog」逃避 ②

---

## 3. 预留链接（①b / ①c）

| 文件                                                         | 状态                                     |
| ------------------------------------------------------------ | ---------------------------------------- |
| [`05-规范-上帝文件-长逻辑.md`](./05-规范-上帝文件-长逻辑.md) | ①b 预留；对照上轮 post-t11 `05` 刷新体积 |
| [`06-交叉连通性审计.md`](./06-交叉连通性审计.md)             | ①c 预留；复验链 A–G 在 T=14 后色变       |

---

_2026-08-12 审计 · 04 · 下一阶段子 Agent 计划 · post-t14 · ①a_
