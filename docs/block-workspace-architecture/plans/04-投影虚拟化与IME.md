# 04 · 投影、虚拟化与 IME（分维度任务书 · 再生加厚）

| 字段         | 内容                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| **效果**     | EL-03 呈现侧：10 万块可滚（窗口化）；输入不整树拆；选区逻辑坐标；IME 不误触结构                                  |
| **文件域**   | `packages/editor-kit/**`；块编辑器状态模块；**不**改行级引擎内部模型                                             |
| **依赖**     | 01 的 ProjectionDiff/事件形状（可 mock 先行；**真闭环依赖 01**）；05 挂载层消费 MountSpec                        |
| **锁定**     | D5 + D7：块窗口 + HeightMap + pin；IME 状态机；逻辑选区禁像素测距                                                |
| **规格**     | `specs/ime-matrix.md`（**强制引用**）；`specs/huge-block-policy.md` 呈现侧；`acceptance/perf-baseline.md` 结构门 |
| **上游分析** | `analysis/2026-08-11-realign/D4D5-投影呈现与IME.md`                                                              |
| **流程**     | `20`：Round 测绿 ≠ 效果锁；包完成报告必须写「mock / 真」与测层                                                   |
| **调度**     | **包 ID 以 `plans/09` 为唯一权威**；本文 04-S/04-P 为分层叙述                                                    |

> **硬句（调度纪律）**：调度包 ID **仅以 `plans/09` 为准**。本文 **04-S / 04-P** 为分层完成定义叙述，**非**独立调度立法：
> **04-S** ≈ **W3-A** + **W3-B-S**（及 W3-B L1 子集）；**04-P** = **W3-P**（WindowManager + 真 Diff + awareness）。
> 禁止在 PR/进度中使用未入库 09 的包号关闭任何验收。对照全文见 `09` §0.4。

---

## 0. 结论先行（会计纪律）

| #      | 判定                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| **C1** | 本维交付拆为 **04-S 骨架**（→ 09：**W3-A / W3-B-S**）与 **04-P 产品闭环**（→ 09：**W3-P**）；二者验收 **不可互换**。    |
| **C2** | IME：**L1 自动化**可挂 04-S / W3-B；**L2 WebView e2e 必测格**仅挂 **W6-B**；**L3 叶子核=PM** 依赖 L2（见 ime-matrix）。 |
| **C3** | **禁止**用 mock Diff / `fullRemountCount===0` 单测关闭 **A-IME-07 输入会话**路径。                                      |
| **C4** | 结构门（DOM 上界常量、pin、HeightMap 算法）**≠** A-PERF 数值门（W6-C）。                                                |
| **C5** | 库存算法/L1 状态机 **保留**；不得因「缝补感」推倒；产品挂载与 awareness 属 **W3-P**（原 04-P），**未做不得宣称完成**。  |

> **一句话**：04-S = 可测契约骨架（已有方向）；**W3-P**（04-P）= 真 WindowManager 挂载 + 真 ProjectionDiff 总线 + awareness + A-IME-07 输入会话 + A-SEL glyph 往返。
> **禁止**：「W3-A/B 绿 = 10 万块可滚 / IME 完成 / 叶子核锁定」。

---

## 1. 分层完成定义：04-S 骨架 vs 04-P 产品闭环

### 1.1 对照表（调度与实现强制用）

| 层       | 叙述 ID  | 09 包 ID（调度）                    | 交付物                                                                                                                                                                                        | 可关闭的验收                                                                      | **不得**关闭                                                                                                  |
| -------- | -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **骨架** | **04-S** | **W3-A** + **W3-B-S**（及 W3-B L1） | ViewportQuery / HeightMap / pin / bounds 常量；SelectionStore API；ImeMachine + structureKeyGuard；`IME_MATRIX_CELLS`；mock `applyProjectionDiff` + `fullRemountCount` 指标基建               | A-IME-01…05 **L1 语义子集**（🟨自动化）；结构门常量可测；A-SEL **store API 形状** | A-IME L2/L3；A-IME-07 输入会话；A-PERF **数值**；A-SEL glyph 点击 e2e；awareness 产品；「仅窗口 DOM」产品列表 |
| **产品** | **04-P** | **W3-P**                            | **WindowManager** 真挂载（消费 MountSpec）；DOM 实测回填 HeightMap；真 **ProjectionDiff 事件总线**（接 01）；输入会话路径 `fullRemountCount`；awareness overlay 视口裁剪；选区 glyph 映射往返 | A-IME-07（输入会话，非仅 mock Diff）；A-SEL 往返子集；结构门在真列表上仍成立      | EL-01（属 05/W6-A）；IME L2 端 e2e（属 **W6-B**）；A-PERF 数值（属 **W6-C**）                                 |

### 1.2 04-S 完成定义（可执行）

**全部满足才可写「04-S / W3-A+B 骨架完成」：**

1. 存在可测模块：`ViewportQuery`、`HeightMap`、`pin`/`planScrollUnmount`、`MAX_MOUNTED_DOM_BLOCKS`（或等价上界）、`SelectionStore`、`ImeMachine`。
2. `ime-matrix.md` L0 成型 + L1（A-IME-01/02）契约单测绿；L1+（03…05）可标 🟨，**正文必须写「≠ L2」**。
3. mock Diff 可证明指标纪律：`fullRemountCount` 可观测；**报告写明 mock**。
4. surface isolation 方向：editor-kit **不**绑行级 Doc store / lines[]（与 07 交叉，本维保持）。

**04-S 完成报告强制字段**：关闭的 A-\* ID + 测层（unit）+ 明文「mock Diff / 无产品 WindowManager」。

### 1.3 04-P 完成定义（可执行）

**全部满足才可写「04-P / W3-P 产品闭环完成」：**

1. **WindowManager / PaperList 挂载层**存在：仅窗口内块挂 DOM；消费 04 MountSpec；**禁止** CSS `hidden` 假虚拟化顶替。
2. HeightMap：**预估 + 实测 DOM 回填**闭环（非仅纯函数单测）。
3. 真 **ProjectionDiff** 源（01 事件或等价 IPC）驱动增量 patch；报告写「真 Diff」。
4. **A-IME-07**：在**输入会话**路径（真列表挂载下键入/合成相关会话）验证 `fullRemountCount===0`（或规格允许上界），**禁止**仅 `applyProjectionDiff` 内存 mock 计为关闭。
5. **awareness overlay**：远端选区/光标按视口裁剪；不毁静默纸面（与 A-COL-02 / A-SIL 交叉）。
6. A-SEL：逻辑坐标权威；至少一条 **glyph/DOM → LogicPos → DOM** 往返测（可集成，完整多端可后置）。

**04-P 仍不得**：关闭 EL-01；关闭 ime-matrix **L2 必测格**；关闭 A-PERF 数值门。

---

## 2. 目标模块（全量，问题同权）

| #   | 模块                         | 归属                        | 说明                                                              |
| --- | ---------------------------- | --------------------------- | ----------------------------------------------------------------- |
| 1   | **ViewportQuery** / 窗口索引 | 04-S→P                      | overscan；折叠展开序列由数据源提供                                |
| 2   | **BlockHeightMap**           | 04-S 算法 / 04-P 回填环     | 预估+实测+prefix；`sliceHeights` → MountSpec                      |
| 3   | **pin**                      | 04-S 契约 / 04-P 真 unmount | 焦点块、composing 块；`planScrollUnmount` retained                |
| 4   | **SelectionStore**           | 04-S API / 04-P 映射        | `blockId+offset` / 块多选；**禁**像素测距选块                     |
| 5   | **IME 状态机**               | 04-S L1 / W6-B L2           | Composing：禁结构键、禁 slash、禁 unmount 焦点；`end_then_switch` |
| 6   | **Diff 应用器**              | 04-S mock / 04-P 真总线     | 增量 patch；`fullRemountCount` 指标                               |
| 7   | **远端 awareness overlay**   | **04-P 强制**               | 视口裁剪；**禁止**标「可选后挂」蒸发                              |
| 8   | **WindowManager 挂载层**     | **04-P**                    | 产品「仅窗口 DOM」；供 05 PaperList 消费                          |

---

## 3. IME：L0 / L1 / L1+ / L2 / L3（关闭条件抄自 ime-matrix）

权威全文：`plans/specs/ime-matrix.md`。本维 **强制摘要**如下——实现 Agent prompt 必须挂规格全文。

### 3.1 层级与关闭贡献

| 层      | 条件                             | 关闭贡献                         | 挂包                          |
| ------- | -------------------------------- | -------------------------------- | ----------------------------- |
| **L0**  | 矩阵成型 + 常量 + 自动化 ID 映射 | 流程债关闭                       | 已可计                        |
| **L1**  | A-IME-01 / 02 契约单测全绿       | **语义子集**；**不**替代 WebView | 04-S / W3-B                   |
| **L1+** | A-IME-03…05 契约/pin 单测        | 仍为 🟨；**不**计 L2             | 04-S / W3-B                   |
| **L2**  | 发布端 **必测**格全部 `✅e2e`    | 必测格关闭的充分条件             | **仅 W6-B**                   |
| **L3**  | L2 后才允许锁「叶子核=PM」       | 叶子核锁定资格                   | 依赖 L2；失败走换核触发（08） |

### 3.2 A-IME 分项（本维主责）

| ID           | 断言摘要                   | L1 自动化（04-S 可计）           | L2 e2e（W6-B）            | 伪完成禁令                 |
| ------------ | -------------------------- | -------------------------------- | ------------------------- | -------------------------- |
| **A-IME-01** | 长句合成不丢字             | long update → end committedText  | 真 OS IME 候选窗时序      | 禁用 vitest 关必测格       |
| **A-IME-02** | 合成中无 slash/结构键      | structure/slash reject           | WebView 键入不误触        | 同上                       |
| **A-IME-03** | 合成中滚动 pin             | pin + planScrollUnmount retained | 滚动 unmount **时序** e2e | 契约绿 ≠ 端 e2e            |
| **A-IME-04** | 点另一块 `end_then_switch` | 策略契约                         | 真点击焦点环              | 同上                       |
| **A-IME-05** | 合成=一步撤销边界          | 一条 ImeCommitBoundary           | 真 undo 栈接线 e2e        | 边界≠ undo UI              |
| **A-IME-06** | 合成中远端/Agent 同块      | —                                | 必测/抽样按矩阵           | 无测=未交付                |
| **A-IME-07** | 输入会话 fullRemount=0     | mock Diff **仅基建**             | 真列表输入会话矩阵        | **禁 mock Diff 关闭本 ID** |
| **A-IME-08** | 合成后 `# ` 转标题         | —                                | e2e（与 05 MD 前缀交叉）  | 无测=未交付                |

### 3.3 IME 混谈红线（抄规格 + 审计）

1. `🟨自动化` **≠** 必测格关闭。
2. 行级 `reference/markdown-editor` IME e2e **不得**冒充块纸面矩阵关闭（纪律可参考，ID **不互通**）。
3. **禁止**因 editor-kit vitest 全绿写「IME 完成 / 叶子核=PM」。
4. 三端 e2e **分端勾选**；Win 绿不得勾 mac/Linux。

---

## 4. 验收 ID 全表（本维）

| 族   | ID                        | 主责层                       | 测层期望                       | 关闭闸                    |
| ---- | ------------------------- | ---------------------------- | ------------------------------ | ------------------------- |
| IME  | A-IME-01…05               | 04-S = L1；W6-B = L2         | unit → e2e                     | L2 见 ime-matrix          |
| IME  | A-IME-06…08               | 04-P 形状 + W6-B e2e         | 集成/e2e                       | 缺测=未交付               |
| IME  | **A-IME-07**              | **04-P 输入会话**；L2 矩阵化 | 真挂载会话；**非**仅 mock Diff | 见 §5 专条                |
| SEL  | A-SEL-01…06               | 04-S store；04-P 往返        | unit → 集成/e2e                | 无 glyph 往返不得关产品项 |
| PERF | A-PERF 滚动/输入 **结构** | 04-S/P 常量+真列表上界       | 结构门                         | **≠** W6-C 数值           |
| PERF | A-PERF **数值**           | W6-C                         | 标定机                         | 04 不得提前关             |
| COL  | A-COL-02（远端选区相关）  | 04-P awareness               | 集成                           | 无 overlay 不得关         |
| INV  | 与 07 surface isolation   | 04-S 保持 editor-kit 边界    | 快                             | 交叉 07                   |

**主责交叉**：A-BLK / EL-01 **不在本维关闭**（05 / **W6-A Strict**）。本维只提供窗口、选区、IME、Diff 面。

---

## 5. 伪完成禁止（本维专表 · 强制）

| ID         | 禁止话术 / 做法                                          | 正确会计                                                        |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| **P-04-1** | 「W3-A 完成 = 10 万块可滚」                              | 仅结构 DOM 上界**常量+单测**；无产品列表则 **04-P 未完成**      |
| **P-04-2** | 「IME 全绿 = IME 完成 / 叶子核=PM」                      | L1 自动化；L2/L3 未开则 **禁止**锁核                            |
| **P-04-3** | 「`fullRemountCount===0` 在 Diff 单测 = **A-IME-07**」   | **仅 mock Diff 基建**；**输入会话路径未矩阵化 = A-IME-07 未关** |
| **P-04-4** | 用 CSS `visibility/display/hidden` 挂全量 DOM 冒充虚拟化 | **架构红灯**；结构门失败                                        |
| **P-04-5** | composition 中整树 remount / unmount 焦点合成块          | A-IME-03 失败                                                   |
| **P-04-6** | 像素测距选块代替 `blockId+offset`                        | A-SEL 失败                                                      |
| **P-04-7** | Round 门禁绿 / 包号绿代替 A-\*                           | `20` L3；从会计删除 Round 叙事                                  |
| **P-04-8** | awareness「以后再说」从 04-P 蒸发                        | **04-P 强制项**；无则 04-P 未完成                               |

### 5.1 A-IME-07 专条（硬锁）

```
A-IME-07 关闭条件（最小）：
  1. 存在产品或集成夹具下的「输入会话」路径（真/准真块列表挂载，非纯 MemoryBlock 单测沙盘冒充产品）
  2. 会话中键入 / composition 相关更新走 Diff 应用
  3. 断言 fullRemountCount === 0（或规格写明的上界），且与 mock 单测分 trace 记录
  4. 测名或报告显式标注「input-session」——仅 applyProjectionDiff unit 不得写入 A-IME-07 ✅

禁止：
  - 把 applyProjectionDiff.test 的 fullRemountCount===0 勾成 A-IME-07 关闭
  - 无挂载层时宣称「输入不整树拆」产品完成
```

---

## 6. 不变量与禁止

### 6.1 不变量

- 投影 **可丢**（杀进程可重建）；**权威在 RS**（01），本维不持久化投影为真相。
- 选区权威 = **逻辑坐标**（`blockId+offset` / 块多选），不与 chat 行选区共实例（07）。
- composing 期间：结构 Intent / slash / 危险 unmount **拒绝**（L1 已可测；L2 端验）。
- Diff 增量优先；`fullRemountCount` 为**可观测纪律指标**，非装饰字段。

### 6.2 禁止

| #   | 禁止项                                          |
| --- | ----------------------------------------------- |
| 1   | CSS hidden / 全量挂载假虚拟化                   |
| 2   | composition 中整树 remount                      |
| 3   | 像素测距选块                                    |
| 4   | 与行级共享 Doc store / `lines[]`                |
| 5   | **mock Diff 关闭 A-IME-07**                     |
| 6   | L1 自动化关闭 L2 必测格 / L3 叶子核             |
| 7   | 删除 ime-matrix 资产或行级 IME e2e 专项（铁律） |

---

## 7. 依赖（逻辑边，非工期）

```
01 ProjectionDiff 真事件形状 ──► 04-P 真 Diff 总线
01 DocSession / 树 rev        ──► 05 写锥（本维只消费 Diff）
04-S MountSpec 形状           ──► 05 PaperList / W3-G 窗口 DOM
04-P WindowManager            ──► A-IME-07 输入会话；A-PERF 真列表结构门
04 IME L1                     ──► 05 Intent 桥 composing 守卫（已交叉）
W6-B L2 e2e                   ──► L3 叶子核锁定资格（05 PM 包不得抢先锁核）
```

| 依赖              | 本维态度                                                         |
| ----------------- | ---------------------------------------------------------------- |
| 01 未出真 Diff    | **允许** 04-S mock 先行；**禁止**写 04-P 完成                    |
| 05 未挂 PaperList | 04-P WindowManager 可先出 API；**A-IME-07 仍未关**直至真列表会话 |
| 07 双引擎         | editor-kit isolation 保持；产品双挂载不在本文件关 EL-08          |

---

## 8. 文件域

| 路径                                                  | 角色                                         | 层                                              |
| ----------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `packages/editor-kit/src/viewport/**`                 | ViewportQuery / HeightMap / pin / bounds     | 04-S；回填环属 04-P                             |
| `packages/editor-kit/src/diff/**`                     | applyProjectionDiff；fullRemount 指标        | 04-S mock → 04-P 真源                           |
| `packages/editor-kit/src/selection/**`                | SelectionStore                               | 04-S → 04-P 映射                                |
| `packages/editor-kit/src/ime/**`                      | ImeMachine / guard / matrix / contract tests | 04-S L1；L2 测在 e2e 域                         |
| `packages/editor-kit` 挂载扩展或 `block-paper` 消费层 | WindowManager / MountSpec 消费               | **04-P**（可与 05 PaperList 同 PR 但验收分 ID） |
| `plans/specs/ime-matrix.md`                           | L0–L3 权威                                   | 文档锁                                          |
| **禁止改**                                            | `reference/markdown-editor` 内部模型当块投影 | —                                               |

---

## 9. 库存代码态度（审计对齐 · 默认改造）

| 资产                                                 | 态度                 | 理由                                                  |
| ---------------------------------------------------- | -------------------- | ----------------------------------------------------- |
| ViewportQuery / HeightMap / pin / bounds             | **保留**             | 结构门与虚拟化算法方向正确                            |
| applyProjectionDiff + fullRemount 纪律               | **保留并改造**       | 接真 Diff 后仍用同一指标；**不得**用现单测关 A-IME-07 |
| SelectionStore                                       | **保留**             | 逻辑坐标权威正确                                      |
| ImeMachine + structureKeyGuard + ime-matrix contract | **保留**             | L1 合格；L2 另包 W6-B                                 |
| surface isolation 测                                 | **保留**             | 与 07 同向                                            |
| awareness overlay                                    | **缺失 → 04-P 新建** | 目标项不得蒸发                                        |
| WindowManager 产品挂载                               | **缺失 → 04-P 新建** | 算法≠产品列表                                         |
| 「Round 完成 = IME/大文档完成」叙事                  | **废弃**             | `20` / audit                                          |

**未按文档半成品 / 伪 A-\***：可丢不入库（`20` §4）；已 commit 骨架 **改造为主，不推倒**。

---

## 10. 与 09 包映射（去缩水指针）

> 对照权威：`plans/09` §0.4。叙述 **04-S/04-P** 不得作 PR 关闭号。

| 09 包                 | 本维关系                                         | 验收要点                                 |
| --------------------- | ------------------------------------------------ | ---------------------------------------- |
| **W3-A**              | 04-S 视口/HeightMap/pin/mock Diff                | 结构门；≠ 数值门                         |
| **W3-B** / **W3-B-S** | 04-S Selection + IME **L1**                      | **明确 ≠ L2**                            |
| **W3-P**              | 原 **04-P**：WindowManager + 真 Diff + awareness | A-IME-07 输入会话；A-SEL 往返；≠ W6-B L2 |
| **W6-B**              | ime-matrix **L2 必测格**                         | 叶子核锁定门禁                           |
| **W6-C**              | A-PERF 数值                                      | 勿用结构门冒充                           |

包完成报告必须列：**关闭的 A-\* + 测层（unit/集成/e2e）+ mock|真**。无 e2e 不得关 A-IME 必测格。

---

## 11. 魔鬼用例归属（不可无主）

| #   | 用例                                      | 归属                   |
| --- | ----------------------------------------- | ---------------------- |
| 1   | 10 万块首屏可滚；DOM ≤ 上界               | 04-P + W6-C 数值       |
| 2   | 滚动 pin 焦点/composing                   | 04-S 契约 + W6-B e2e   |
| 3   | 中文 IME 长句不丢字、不 slash             | L1 子集 + **W6-B**     |
| 4   | composing 中滚动不 unmount 合成块         | A-IME-03               |
| 5   | composing 点另一块 end_then_switch        | A-IME-04               |
| 6   | **键入会话 fullRemountCount=0（真列表）** | **A-IME-07 · 04-P**    |
| 7   | 远端 awareness 视口裁剪                   | 04-P                   |
| 8   | ≥64KiB 叶：pin+IME 与 huge-block 呈现     | 04 pin + 05 lineWindow |

---

## 12. 实现波强制文档集（摘自 20 §3.3）

```
1. plans/00-总方案.md
2. plans/04-投影虚拟化与IME.md（本文）
3. 15-评审后锁定修订.md（EL-03 等相关）
4. plans/specs/ime-matrix.md
5. plans/specs/huge-block-policy.md（触及超长块时）
6. plans/08 中 A-IME / A-SEL / A-PERF 相关段
7. 20 §1 教训 + 本包验收 ID 自检表
```

**完成定义自检**：每条 A-\* 有测名或「无测=未完成」；禁止宣称 EL / Wave 关闭除非 08 条件满足。

---

## 13. 参考指针

| 文档                                                | 用途                   |
| --------------------------------------------------- | ---------------------- |
| `analysis/2026-08-11-realign/D4D5-投影呈现与IME.md` | 库存实态与方案动作源   |
| `plans/specs/ime-matrix.md`                         | L0–L3 / A-IME 矩阵     |
| `plans/05-块呈现与交互.md`                          | PaperList / PM / A-BLK |
| `plans/07-双引擎与本仓衔接.md`                      | surface 共享纪律       |
| `plans/08-验收与门禁.md`                            | EL→断言；缺测=未交付   |
| `plans/09-执行任务包索引.md`                        | W3-A/B、W6-B/C         |
| `20-流程重启-教训与章程.md`                         | 伪完成 / 窄读实现      |

---

_再生加厚 · 只改方案文档 · 对齐 D4D5 · 禁业务代码 · 禁 commit_
