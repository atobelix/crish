# EL 仪表盘（会计权威 · 最小骨架）

| 元数据        | 值                                             |
| ------------- | ---------------------------------------------- |
| **契约**      | `plans/08-验收与门禁.md` §5                    |
| **调度包 ID** | 仅 `plans/09` 官方号（Strict / `-S`）          |
| **状态**      | **全表未关闭**（改进落盘建空壳；实现波填证据） |
| **日期**      | 2026-08-11                                     |

> **纪律**：Skeleton（`Wn-X-S`）**不得**写入表 A「关闭包」列。  
> **关闭证据铁律**：宣称 EL 关闭 ⇔ 表 A 该行已关闭 + 表 B 真绿可点路径 + Strict 包 + `08` §1.0。  
> **产品完成叙事** ⇔ G-HYD ∧ G-INV ∧ 本仪表盘表 A/B（见 `00`/`09`）。  
> 最小可运行会计：表 **A + B + C + D + F**（本文件含 A/C/D/F 骨架；表 B 骨架占位；E/G/H/I 可后挂）。

---

## 表 A · EL 总览

| EL    | 断言族             | Strict 关闭包（不得早于）              | 状态       | 证据（测路径/报告） | 禁止冒充包 / 叙事                                                  |
| ----- | ------------------ | -------------------------------------- | ---------- | ------------------- | ------------------------------------------------------------------ |
| EL-01 | A-BLK-01…14        | **W6-A**                               | **未关闭** | —                   | W3-\* / W5-B / **W6-A-S** / mock sink / Round 测数 / 假数据 chrome |
| EL-02 | A-SIL-01…04        | W3-C + W6-A 静默项                     | **未关闭** | —                   | W3-C 假数据 = Notion chrome                                        |
| EL-03 | A-PERF 结构→数值   | 结构 **W3-A**；数值 **W6-C**           | **未关闭** | —                   | **W6-C-S** / TBD 数值 / 仅结构 checklist                           |
| EL-04 | A-COL-01…08        | W1-F + **W6-D** + **G-HYD**            | **未关闭** | —                   | W1-F-S / W6-D-S / JSON 重放 / 无 hydrate                           |
| EL-05 | A-AGT-01…08        | W4-B + **W6-E**（工具满表见 **W4-F**） | **未关闭** | —                   | Memory 全绿 / 仅 5 工具 / W4-\*-S                                  |
| EL-06 | A-MD               | W2-A/B                                 | **未关闭** | —                   | 仅 6 golden / 未接线 markdown-rs 冒充 RT 满                        |
| EL-07 | A-EXT + A-INV-01   | W4-C + W6-E                            | **未关闭** | —                   | 仅 contribute 拒写句柄                                             |
| EL-08 | A-INV-03           | W5-C                                   | **未关闭** | —                   | **W5-B-S** 挂载可点 / 预览壳                                       |
| EL-09 | 许可/整嵌禁令      | PR 审查                                | **未关闭** | —                   | —                                                                  |
| EL-10 | 禁偏科；维度不可删 | 评审门                                 | **未关闭** | —                   | 删维 / MVP 砍表                                                    |

---

## 表 B · 断言族覆盖（骨架 · 实现波填）

| 断言 ID                        | 测路径::测名                                                                                             | 层   | 语义状态           | 备注                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ---- | ------------------ | ------------------------------------------------------------------------------------------ |
| （按族展开 A-BLK / A-IME / …） | —                                                                                                        | —    | **缺测**           | 缺测 = 未交付（`08` §0.1）                                                                 |
| A-MEM-04                       | `crates/conex-doc-collab/src/session.rs` · `a_mem_04_undo_across_cold_restores_structure_and_plain_text` | unit | **语义绿**（W1-U） | 跨冷 undo + plain；≠ reheat；见 [`pseudo-assert-register.md`](./pseudo-assert-register.md) |
| A-COL-04                       | `crates/conex-doc-collab/src/session.rs` · `a_col_04_undo_origin_filter`                                 | unit | **语义绿**（W1-U） | `undo(filter)` OriginMismatch；Remote/System 不入栈                                        |

> 关闭 EL 时本表对应族须有 **真绿** 行；半绿 / mock / Skeleton 支撑 **不得** 标关闭。

---

## 表 C · 包轨台账（关键包 · 完成≠可关 EL）

| 包 ID             | 轨         | 完成定义（摘要）                      | 轨进度（非 EL）                                                       | 完成 ≠ 可关的 EL              |
| ----------------- | ---------- | ------------------------------------- | --------------------------------------------------------------------- | ----------------------------- |
| W0-\*             | Strict/S   | 契约与类型                            | 历史库存                                                              | 全部 EL                       |
| W1-H              | Strict     | 可逆 encode + hydrate                 | **心侧 G-HYD-1/2 测绿**（2026-08-11）                                 | 解锁叙事；≠ 单独关 EL-04 满表 |
| W1-U              | Strict     | Undo v1                               | **包完成**（A-MEM-04/A-COL-04/09c 后半测绿）                          | **≠ 关 EL-04**（单 ID 绿）    |
| W3-A              | Strict     | 视口/HeightMap/pin 结构门             | ≠ EL-03 数值；≠ EL-01                                                 |
| W3-B / W3-B-S     | Strict/S   | Selection + IME L1                    | ≠ W6-B L2                                                             |
| W3-C              | Strict     | chrome 模型/假数据                    | ≠ EL-01                                                               |
| W3-D-S            | Skeleton   | plain + mock sink                     | ≠ PM；≠ 真 apply；≠ EL-01                                             |
| W3-D-PM           | Strict     | 真 PM；sink 可 mock                   | ≠ W3-D；≠ EL-01                                                       |
| W3-D              | Strict     | 真 PM + Intent→真 apply               | ≠ A-BLK 全表；≠ EL-01                                                 |
| W3-F-S            | Skeleton   | StructureIntent + mock                | ≠ 真 apply                                                            |
| W3-F              | Strict     | slash/拖拽/chrome DOM + 真 apply 子集 | ≠ EL-01                                                               |
| W3-G              | Strict     | PaperList 仅窗口 DOM                  | ≠ EL-01                                                               |
| W3-H              | Strict     | MD 前缀 / turn-into UI                | ≠ 全表 e2e                                                            |
| W3-P              | Strict     | WindowManager + 真 Diff + awareness   | ≠ W6-B；≠ A-PERF 数值                                                 |
| W4-A/B/C/D        | Strict     | 工具/审批/扩展/MCP                    | ≠ EL-05/07 满关（须 W6-E 等）                                         |
| W4-F              | Strict     | 工具满表补齐                          | ≠ W6-E 千次+恶意                                                      |
| W5-B              | Strict     | 真挂载路径（依赖 W1-H）               | **可演示 ≠ 任何 EL**                                                  |
| W5-B-S            | Skeleton   | 预览壳/假数据                         | **挂载冒充交付 = S5**                                                 |
| W5-C              | Strict     | 架构隔离                              | EL-08 主门槛（仍须测真绿）                                            |
| W5-D / **W5-D-S** | Strict/S   | X-01…06；S=单场景骨架                 | **W5-D-S**：X-01 骨架已落（2026-08-12）；**S 轨 ≠ 全族**；表 G 分状态 |
| **W6-A**          | **Strict** | A-BLK 全表 e2e                        | **EL-01**                                                             |
| **W6-A-S**        | Skeleton   | A-BLK 抽样                            | **禁止 EL-01**                                                        |
| W6-B / W6-B-S     | Strict/S   | IME L2 / L0–L1                        | S ≠ 叶子核锁定                                                        |
| W6-C / W6-C-S     | Strict/S   | PERF 数值 / 结构骨架                  | S ≠ 数值门                                                            |
| W6-D / W6-D-S     | Strict/S   | A-COL 满 / 子集                       | S ≠ EL-04 满                                                          |
| W6-E / W6-E-S     | Strict/S   | 千次批+恶意 / 骨架                    | S ≠ EL-05/07 满                                                       |

> 实现波更新本表「是否完成」时须附轨声明；**完成包 ID 不得偷换 Strict 定义**。

---

## 表 D · 性能两阶段

| 阶段       | 包映射                      | checklist / 数值                                                                | 指纹         | 状态                   |
| ---------- | --------------------------- | ------------------------------------------------------------------------------- | ------------ | ---------------------- |
| **结构门** | W3-A（文档骨架可记 W6-C-S） | DOM 上界、无每键全量 snapshot、merge 不在 UI 主线程、fullRemountCount、热集上界 | —            | **未关闭**             |
| **数值门** | **仅 W6-C Strict**          | 初值写入 `perf-baseline.md`                                                     | 机器指纹 TBD | **未关闭**（TBD≠通过） |
| **DEG-01** | A-PERF-DEG-01               | p95≥2× 或 p50≥1.5× 连续 3 次 → A-SWAP 评估                                      | —            | 未触发                 |

权威细则：`acceptance/perf-baseline.md` + `08` 性能两阶段。

---

## 表 F · A-BLK 进度（指针）

| 项               | 值                                             |
| ---------------- | ---------------------------------------------- |
| **权威进度文件** | [`A-BLK-progress.md`](./A-BLK-progress.md)     |
| **轨**           | **W6-A-S**（Skeleton 抽样）                    |
| **EL-01**        | **未关闭**（仅 **W6-A** Strict 全表 e2e 可关） |
| **01…14**        | 见 progress 表；e2e 列独立；页脚不得宣称 EL-01 |

---

## 表 E / G / H / I（后挂 + G 已挂）

| 表    | 名称          | 落点 / 状态                                                                                                                                  |
| ----- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| E     | IME 矩阵      | `specs/ime-matrix.md`；W6-B-S vs W6-B                                                                                                        |
| **G** | **X-01…X-06** | **权威分状态** [`X-cross-layer-G.md`](./X-cross-layer-G.md)（**W5-D-S** 钉 X-01 骨架；X-02…06 缺/子集；**≠ W5-D 全绿**；**≠ 关 EL**）        |
| H     | 挂载入口      | 可演示 vs **可关 EL=否**（除非表 A 已关）                                                                                                    |
| I     | 伪完成事故    | S1–S7；**权威登记** [`pseudo-assert-register.md`](./pseudo-assert-register.md)（A-MEM-04 / A-COL-04 曾撤伪锚；**W1-U 已真交付**；EL 仍未关） |

---

## 表 I · 伪完成事故（指针）

| 项           | 值                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **权威文件** | [`pseudo-assert-register.md`](./pseudo-assert-register.md)                                                    |
| **A-MEM-04** | **W1-U 语义绿**：`a_mem_04_undo_across_cold_restores_structure_and_plain_text`；常量 `a_mem::A_MEM_04` 已恢复 |
| **A-COL-04** | **W1-U 语义绿**：`a_col_04_undo_origin_filter`；常量 `a_col::A_COL_04`                                        |
| **EL 关闭**  | **表 A 仍全部未关闭**；单 ID 绿 ≠ EL-04 关；禁止宣称 EL 关闭                                                  |

---

_2026-08-11 改进落盘：空表骨架（A+B+C+D+F）；全「未关闭」。_  
_2026-08-11 伪完成清理：A-MEM-04 / A-COL-04 撤伪锚并登记未交付（W1-U）。_  
_2026-08-11 W1-U Strict：A-MEM-04 / A-COL-04 表 B 语义绿；**EL 表 A 仍全未关**。_
_2026-08-12 **W5-D-S**：表 G 挂 [`X-cross-layer-G.md`](./X-cross-layer-G.md)；X-01 骨架钉 `x01_cross_layer.rs`；**≠ W5-D 全绿**；**表 A 仍全未关**。_
