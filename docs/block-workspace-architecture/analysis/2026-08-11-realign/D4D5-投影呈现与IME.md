# D4/D5 · 投影 / 虚拟化 / IME + 块呈现 · 对齐分析

| 元数据       | 值                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **日期**     | 2026-08-11                                                                                                                                                  |
| **角色**     | 方案分析子 Agent（只读代码 + 写分析文档）                                                                                                                   |
| **范围**     | D4 投影/虚拟化/IME（`plans/04`）∥ D5 块呈现与交互（`plans/05`）                                                                                             |
| **强制输入** | `20` / `15` / `00` / `plans/04` / `plans/05` / `specs/ime-matrix` / `specs/huge-block-policy` / `acceptance/A-BLK-progress` / `audit/00`+`03` / `08` / `09` |
| **代码域**   | `packages/editor-kit/**`、`packages/block-paper/**`（只读）                                                                                                 |
| **效力**     | 供方案再生回写 04/05/09；**不**授权实现波；**不**关闭任何 EL/A-\*                                                                                           |

---

## 0. 结论先行（必须先读）

| #      | 诚实判定                      | 一句                                                                                                                                                                                     |
| ------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | **地基可用，效果锁全未关**    | editor-kit / block-paper 是**可测契约骨架**，不是块工作区产品完成。与 `audit/00`「地基可用，远未效果锁」同向。                                                                           |
| **C2** | **无真 PM 叶**                | `plans/05` / `09` W3-D 写「叶子 **ProseMirror**」；代码是 `TextLeafModel` plain 缓冲，**零** `prosemirror-*` 依赖。名实不符。                                                            |
| **C3** | **Intent 主路径 = mock sink** | `createMockIntentSink` 记录调用，**不**进 `DocSession::apply`。wire 形状（`structureIntentToOps`）≠ 真 apply。                                                                           |
| **C4** | **IME L1 可计；L2 零 e2e**    | `ime-matrix.md` 自身诚实：L0/L1/L1+ 自动化 ✅；L2 WebView e2e 后置 W6-B；**禁止**用 vitest 关叶子核=PM。                                                                                 |
| **C5** | **A-BLK 不可在 W3 关闭**      | `08`：EL-01 关闭不得早于 **W6-A**；`A-BLK-progress` 自证「抽样绿 ≠ 全表」；W3-C/D/F 任一包绿 **禁止** 抬 EL-01。                                                                         |
| **C6** | **保留资产，禁止推倒**        | 窗口/HeightMap/pin、ImeMachine、SelectionStore、lineWindow 阈值、CM6 host、结构 Intent+wire、surface isolation——方向对，应在方案再生中**升格为显式「骨架包」**，勿用「缝补感」整包丢弃。 |
| **C7** | **方案必须去缩水**            | 下一版 04/05/09 须把「mock / 假数据 / plain 叶 / L1 自动化」写成**显式包边界**，并恢复 W6-A/B 为**全表 e2e / 矩阵 e2e** 原义（或评审后改 09 并公告），禁止 Round 号贩卖冒充关闭。        |

**一句话**：

> **D4 交付了投影控制面算法 + IME L1 状态机；D5 交付了 chrome 模型 + Intent 形状 + 半挂 CM6。**  
> **没有** 真 PM 叶、没有 Intent→RS 闭环、没有块列表 DOM 窗口挂载、没有 A-BLK/A-IME 产品关闭。  
> 方案再生目标：把「骨架诚实分层」写进 04/05/09，消除「PM→Intent」「接 op」「W3 完成」话术漂移。

---

## 1. 文档要求摘要（锁与任务书）

### 1.1 效果锁（15 §2 / 00）

| ID       | 与本维关系                                                     |
| -------- | -------------------------------------------------------------- |
| EL-01    | A-BLK 全表 → **主责 05**；关闭 **W6-A only**（08）             |
| EL-02    | A-SIL 静默默认 → 05 chrome + 后置视觉                          |
| EL-03    | 大文档：窗口化 + RS 合并不在 UI 主线程 → **04 结构门 + 01/02** |
| EL-04…07 | 协同/Agent/MD/扩展：本维提供投影/选区/Intent 面，**不**单独关  |
| EL-08    | 行级 ∥ 块；editor-kit 禁共享 lines[] Doc                       |

### 1.2 `plans/04` 目标模块（投影/IME）

1. ViewportQuery / 窗口索引
2. BlockHeightMap（预估+实测回填）
3. pin：焦点、composing
4. SelectionStore：`blockId+offset` / 块多选
5. IME 状态机：Composing 禁结构键、禁 slash、禁 unmount 焦点
6. Diff 应用器 + `fullRemountCount`
7. 远端 awareness overlay（视口裁剪）

**验收 ID 族**：A-IME-01…08，A-SEL-01…06，A-PERF 滚动/输入，A-COL-02（远端选区相关）  
**禁止**：CSS hidden 假虚拟化；composition 中整树 remount；像素测距选块

### 1.3 `plans/05` 目标模块（块呈现）

1. 块列表渲染（**仅窗口 DOM**）
2. chrome：把手、多选框、落点线、slash 宿主
3. 静默状态机 L0 默认
4. 叶子 **ProseMirror** 适配：仅 inline schema；`dispatchTransaction`→Intent→RS
5. 代码叶 **CM6**
6. MD 前缀快路径（非 composing）
7. turn-into / 缩进 / 拖拽（op 语义归 01）
8. 未知 flavour 占位块

**不变量（05 正文已写，必须保留）**：

- 禁止 `serialize(pmDoc)` 持久化
- 文档 undo 不靠 PM history 当局
- **PM 合格 ≠ 工作区合格（A-BLK 独立门禁）**

**验收 ID 族**：A-BLK-01…14，A-SIL-01…04，A-IME 相关 e2e

### 1.4 `plans/09` W3 包口径（调度权威）

| 包       | 计划验收                                         | 关键纪律句       |
| -------- | ------------------------------------------------ | ---------------- |
| W3-A     | Viewport+HeightMap+pin；A-PERF **结构** DOM 上界 | ≠ 数值门         |
| W3-B     | SelectionStore+IME；A-IME-01…04、A-SEL-01        | 未写「L2 关闭」  |
| W3-C     | chrome+静默**假数据**；A-SIL-01…02；**≠EL-01**   | 假数据合法并行   |
| W3-D     | 叶子 **PM**→Intent；通路绿；**≠A-BLK 全表**      | 「PM」字面过重   |
| W3-E     | CM6 代码叶；可聚焦                               | 未写 RS/全语言   |
| W3-F     | slash/拖拽/多选接 op；A-BLK-02/04/05 **子集**    | 子集 ≠ 关闭      |
| **W6-A** | **A-BLK 全表 e2e**                               | EL-01 唯一关闭闸 |
| **W6-B** | **A-IME WebView 矩阵**                           | 叶子核锁定门禁   |

### 1.5 IME 矩阵分层（`specs/ime-matrix.md` — 已诚实）

| 层     | 条件                     | 状态（规格自证）       |
| ------ | ------------------------ | ---------------------- |
| L0     | 矩阵成型 + 常量          | ✅ Round8              |
| L1     | A-IME-01/02 契约单测     | ✅                     |
| L1+    | A-IME-03…05 契约/pin     | ✅ Round9 目标/表标 🟨 |
| **L2** | 发布端**必测**格 `✅e2e` | ❌ **W6-B**            |
| **L3** | L2 后才锁「叶子核=PM」   | ❌ 依赖 L2             |

**混谈红线（规格 + 审计重申）**：`🟨自动化` ≠ 必测格关闭；行级 markdown-editor e2e **不得**冒充块纸面矩阵。

### 1.6 超长块（`huge-block-policy`）

- 数据层分段：W1-B；**呈现侧 V6 行窗口：W3-D**
- 硬禁：无窗口 MB 单 text node；合成中 split；unmount 焦点超长块
- A-HUGE-03/06/08 主责呈现

### 1.7 流程重启纪律（`20`）

- Round 测绿 ≠ 效果锁关闭
- 包 ID 不得偷换 09 定义（W6-A ≠ 抽样）
- 分析须给「保留 / 废弃 / 方案必须改什么」
- 方案动作要能回写 `plans/0N`

---

## 2. 库存代码实态（只读取证）

### 2.1 包与依赖

| 包                   | 路径                   | 依赖要点                                                                                    |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `@crish/editor-kit`  | `packages/editor-kit`  | 仅 `@crish/block-paper-contract`；**无** PM/CM/React                                        |
| `@crish/block-paper` | `packages/block-paper` | contract + editor-kit + **真** `@codemirror/*`；**无** `prosemirror-*`；**无** React 组件树 |

源码自证（纪律句，应保留）：

- `TextLeafModel.ts`：「本模块 **不** 接真实 ProseMirror」
- `intentBridge.ts`：「默认 mock sink 记录调用，**不接真实后端**」；「**W3-F ≠ EL-01 关闭**」
- `structureIntents.ts`：「**mock apply ≠ 真实 RS**」
- `applyProjectionDiff.ts`：「**不** 接真实 DocSession；仅内存态」
- package description / README：多处写明 mock / ≠ 全表 / L2 后置

### 2.2 editor-kit 模块清单（D4 主域）

| 模块                      | 路径                               | 实态                                                         | 对照 04 目标                    |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------ | ------------------------------- |
| ViewportQuery             | `viewport/ViewportQuery.ts`        | 索引算术 + overscan；**无 DOM**                              | ✅ 算法骨架                     |
| HeightMap                 | `viewport/HeightMap.ts`            | 预估+回填+prefix；`sliceHeights` 供 MountSpec                | ✅ 算法骨架                     |
| pin                       | `viewport/pin.ts`                  | 焦点/composing 不变量；`planScrollUnmount`                   | ✅ 与 A-IME-03 契约             |
| bounds                    | `viewport/bounds.ts`               | `MAX_MOUNTED_DOM_BLOCKS=256`、overscan 默认 12               | ✅ **结构门常量**（≠ 数值门）   |
| applyProjectionDiff       | `diff/applyProjectionDiff.ts`      | 内存 `MemoryBlock` 增量 patch；`fullRemountCount`            | ✅ mock Diff；**无**产品挂载    |
| SelectionStore            | `selection/SelectionStore.ts`      | `LogicPos` / range / blockMulti；禁像素测距                  | ✅ 逻辑选区 store               |
| ImeMachine                | `ime/ImeMachine.ts`                | Idle/Composing；结构守卫；end_then_switch；ImeCommitBoundary | ✅ L1 状态机                    |
| structureKeyGuard         | `ime/structureKeyGuard.ts`         | composing 拒 op/slash/structure_key                          | ✅ A-IME-02                     |
| imeMatrix                 | `ime/imeMatrix.ts` + contract test | `IME_MATRIX_CELLS` 与规格映射                                | ✅ L0/L1 资产                   |
| awareness overlay         | —                                  | **不存在**                                                   | ❌ 04 §1.7 未做                 |
| 产品 WindowManager 挂载层 | —                                  | **不存在**（无 React/DOM 列表）                              | ❌ 仅算法，无「仅窗口 DOM」呈现 |

### 2.3 block-paper 模块清单（D5 主域）

| 模块                          | 路径                         | 实态                                        | 对照 05 目标                    |
| ----------------------------- | ---------------------------- | ------------------------------------------- | ------------------------------- |
| BlockChromeModel              | `chrome/BlockChrome.ts`      | 把手可见性 / 多选 / 折叠 **纯 TS**          | 半：模型有，**无 DOM chrome**   |
| SlashMenuModel                | `chrome/SlashMenuModel.ts`   | open/filter/close；composing 拒             | 半：模型有，**无浮层 DOM**      |
| silentFixture                 | `chrome/silentFixture.ts`    | N 块假投影；自证非权威                      | ✅ 假数据包（W3-C 合法）        |
| structureIntents + opsWire    | `chrome/structureIntents.ts` | StructureIntent → collab snake_case wire    | 半：形状/wire 有；**mock sink** |
| TextLeafModel                 | `leaves/TextLeafModel.ts`    | plain 缓冲 + text_edit；composing flush     | **降级**：非 PM                 |
| intentBridge                  | `leaves/intentBridge.ts`     | submitIntent + **createMockIntentSink**     | 通路 mock 级                    |
| lineWindow                    | `leaves/lineWindow.ts`       | T_PM_NODE_SOFT / 行窗口纯函数               | ✅ A-HUGE-03 **呈现计算**骨架   |
| CodeLeaf / Cm6CodeLeafHost    | `leaves/code/*`              | **真** EditorView；默认仍 textarea；不接 RS | 半挂真 host                     |
| 块列表窗口渲染                | —                            | **不存在**                                  | ❌ 05 §1.1                      |
| 落点线 / 拖拽 UI              | —                            | **不存在**                                  | ❌ 05 / W3-F UI                 |
| MD 前缀快路径                 | —                            | **不存在**                                  | ❌ 05 §1.6 / A-BLK-09           |
| turn-into / 未知 flavour 占位 | —                            | **不存在**（turn-into 测未抽样）            | ❌                              |
| 真 PM 适配器                  | —                            | **不存在**                                  | ❌ 05 §1.4 核心字面             |

### 2.4 写路径现状（mock sink vs 真 apply）

```text
用户/测试动作
    │
    ▼
TextLeafModel / CodeLeafModel / SlashMenuModel / BlockChromeModel
    │  产出 TextEditIntent | StructureIntent
    ▼
submitIntent(…, sink, { ime })
    │  composing → 结构拒绝（真语义）
    ▼
IntentSink
    ├── 默认：createMockIntentSink → 仅 calls[]  （✅ 可测）
    └── 真实：DocSession.apply / IPC  （❌ 未接）
         │
         ▼
    ProjectionDiff → 产品 DOM patch  （❌ 未接；仅有内存 applyProjectionDiff）
```

**允许宣称**：Intent 形状 + IME 守卫 + wire 映射可测。  
**禁止宣称**：「已接 RS / 已 apply / slash 已进 Op 树 / 键入已持久化」。

### 2.5 PM 叶现状 vs `plans/05` 文档

| 05 / 09 字面                                    | 代码                                                     | 差距类型                              |
| ----------------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| 「叶子 **ProseMirror** 适配：仅 inline schema」 | 无 prosemirror 依赖；无 schema；无 `dispatchTransaction` | **名实不符**                          |
| 「`dispatchTransaction`→Intent→RS」             | Intent→**mock** sink                                     | 后半 **未接线**                       |
| 「PM 合格 ≠ 工作区合格」                        | 正确纪律；但 **PM 本身未合格**，连「PM 合格」都谈不上    | 前置条件空                            |
| W3-D 完成 = 通路绿                              | mock 通路 unit 绿                                        | 与 09「≠A-BLK」一致；与「PM」字面冲突 |

**裁定（对齐 audit/03 §2.2）**：W3-D 应在方案中**改称**「TextLeaf Intent 骨架（PM 待挂）」；在真 PM 适配器入库前，**禁止**锁定叶子核=PM（且 L3 依赖 L2，双重未满足）。

### 2.6 IME L1 vs L2（代码 × 规格）

| ID       | L1 自动化（代码有）                     | L2 e2e（代码无）                  |
| -------- | --------------------------------------- | --------------------------------- |
| A-IME-01 | long update → end committedText         | 真 OS IME 候选窗时序              |
| A-IME-02 | structure/slash reject + block-paper 桥 | WebView 键入不误触                |
| A-IME-03 | pin + planScrollUnmount retained        | 滚动 unmount **时序** e2e         |
| A-IME-04 | `end_then_switch` 契约                  | 真点击焦点环                      |
| A-IME-05 | 一条 ImeCommitBoundary                  | 真 undo 栈接线 e2e                |
| A-IME-06 | —                                       | 远端/Agent 同块                   |
| A-IME-07 | mock Diff 计数器基建                    | **输入会话** fullRemount=0 矩阵化 |
| A-IME-08 | —                                       | 合成后 `# ` 转标题                |

**诚实句**：IME 矩阵文档与 audit/03 **一致**——L1 可计；**L2 必测格全部 ☐**；不得因 editor-kit vitest 全绿写「IME 完成」。

### 2.7 A-BLK 进度（不可 W3 关闭）

`acceptance/A-BLK-progress.md` 自证：

- 标题即 **「Round9 · W6-A 抽样」**，**不是** 09 原文 W6-A「全表 e2e」
- 01–09 多为 **黄**；仅 01 部分绿（撤销仍黄）
- 明确不宣称 EL-01 / 全表 / 块工作区完成

| 呈现域相关 ID                   | 本域实态                    | W3 可关？                  |
| ------------------------------- | --------------------------- | -------------------------- |
| A-BLK-02 slash                  | Intent+mock                 | **否**                     |
| A-BLK-03 把手                   | 模型 hidden/hover           | **否**（无视觉 DOM）       |
| A-BLK-04 拖拽                   | 心侧 Move 另域；无落点线 UI | **否**                     |
| A-BLK-05 多选删除               | Intent+mock                 | **否**                     |
| A-BLK-08…09 turn-into / MD 前缀 | 未实现                      | **否**                     |
| A-BLK-14 代码叶 e2e             | CM6 unit 半挂               | **否**                     |
| **EL-01**                       | —                           | **仅 W6-A 全表 e2e（08）** |

**调度毒点（20 L3 / audit/05）**：若把 `A-BLK-progress` 抽样标成「W6-A 完成」，即 **定义性缩水**——方案再生必须把「W6-A 抽样」改名（如 **W6-A0 契约抽样**），**恢复 W6-A = 全表 e2e**。

---

## 3. 分维差距矩阵（文档 ↔ 代码）

### 3.1 第一章 · D4 投影 / 虚拟化 / IME

| 文档要求                   | 库存                   | 差距                                        | 保留/改造/废弃                                        |
| -------------------------- | ---------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Viewport + overscan        | 有算法                 | 无产品挂载、无折叠展开序列真数据源          | **保留**算法；**补** WindowManager 挂载层（方案新包） |
| HeightMap                  | 有                     | 无实测 DOM 回填环                           | **保留**；接挂载层后闭环                              |
| pin + planScrollUnmount    | 有 + 测                | 无真实 unmount 宿主                         | **保留**；L2 e2e 后验                                 |
| SelectionStore             | 有                     | 无 glyph 点击往返；A-SEL-01 未关            | **保留** store；e2e/映射后置                          |
| IME 状态机                 | L1 扎实                | L2 矩阵 ☐；无 composition DOM 绑定          | **保留**机；**禁止**宣称 L2                           |
| Diff + fullRemountCount    | mock 内存              | 无真实投影事件总线；A-IME-07 输入会话未矩阵 | **保留**指标纪律；接真 Diff                           |
| awareness overlay          | 无                     | 04 目标项整段空                             | **方案保留目标**；实现新包，勿用 mock 冒充            |
| 禁 CSS hidden 假虚拟化     | 未违反                 | —                                           | **保留**纪律测                                        |
| 与行级共享纪律不共享 store | surface isolation 测有 | 产品双挂载另域（07）                        | **保留** isolation                                    |

**D4 效果锁贡献**：结构门常量与算法 **方向正确**；**零** EL-03/A-PERF 数值关闭；**零** A-IME L2/L3。

### 3.2 第二章 · D5 块呈现与交互

| 文档要求                             | 库存              | 差距                                | 保留/改造/废弃                                         |
| ------------------------------------ | ----------------- | ----------------------------------- | ------------------------------------------------------ |
| 仅窗口 DOM 块列表                    | 无                | 最大呈现空洞                        | **必须** 方案包「PaperList 挂载」依赖 04 WindowManager |
| chrome DOM（把手/落点线/slash 宿主） | 仅 Model          | 假数据态合格；产品 UI 空            | **保留** Model；UI 单独立项，**禁止**计 EL-01          |
| 静默 L0                              | 模型测            | A-SIL-03/04 视觉未触                | **保留** L0 语义；视觉后置 W6                          |
| **PM 叶**                            | **无**            | 与 05/09 字面冲突                   | **方案改名 + 真 PM 包**；旧 plain 叶作过渡适配器可留   |
| Intent→RS                            | mock              | 写锥未闭合                          | **下一硬门槛**（与 01 集成）                           |
| CM6                                  | 真 host 半挂      | 默认 textarea；无 RS；语言 plain+js | **保留** Cm6CodeLeafHost；补默认策略与 RS              |
| MD 前缀 / turn-into / 未知 flavour   | 无                | A-BLK-08/09 等红                    | **方案显式包**，禁止「以后再说」蒸发                   |
| 拖拽多选 UI                          | 无                | W3-F 仅 Intent                      | **勿**用 wire 绿关 A-BLK-04/05                         |
| A-HUGE V6                            | lineWindow 纯函数 | 未接真编辑宿主 / A-HUGE-03 DOM 探针 | **保留**函数；接 PM/CM 宿主后测                        |

**D5 效果锁贡献**：**零** EL-01；A-SIL 最多模型子集；A-BLK 抽样黄表与代码一致。

---

## 4. 伪完成 / 缩水风险（本维专表）

| 风险 ID | 话术陷阱                                       | 正确会计                                   |
| ------- | ---------------------------------------------- | ------------------------------------------ |
| P-D4-1  | 「W3-A 完成 = 10 万块可滚」                    | 仅结构 DOM 上界**常量+单测**；无产品列表   |
| P-D4-2  | 「IME 全绿 = IME 完成 / 叶子核=PM」            | L1 自动化；L2/L3 未开                      |
| P-D4-3  | 「fullRemountCount=0 在 Diff 单测 = A-IME-07」 | 仅 mock Diff；输入会话路径未矩阵化         |
| P-D5-1  | 「W3-D 完成 = PM 叶子」                        | 仅 plain Intent 骨架                       |
| P-D5-2  | 「Intent 通路绿 = 真键入进 RS」                | mock sink                                  |
| P-D5-3  | 「W3-F 接 op = A-BLK-02/04/05 关闭」           | 子集形状+wire；mock apply                  |
| P-D5-4  | 「W3-C 假数据 = Notion chrome / EL-01」        | 09 明文 ≠EL-01                             |
| P-D5-5  | 「W6-A 抽样绿 = W6-A 关闭」                    | **定义性缩水**；progress 文件名/波次须改正 |
| P-D5-6  | 「CM6 host 有 = A-BLK-14 关闭」                | unit 可聚焦 ≠ e2e                          |

---

## 5. 方案必须改什么（可回写 04 / 05 / 09）

> 下列是**方案再生动作**，不是实现 TODO 冒充方案。目标：**去缩水、名实一致、包边界可验收**。

### 5.1 回写 `plans/04-投影虚拟化与IME.md`

| 动作               | 内容                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **分层完成定义**   | 拆 **04-S 骨架** vs **04-P 产品闭环**：S = 现有算法+L1 IME（可测、可入库）；P = WindowManager 真挂载 + 真 ProjectionDiff 总线 + awareness + A-IME-07 输入会话 + A-SEL glyph 往返 |
| **验收分层**       | L1 自动化 ID 可挂 04-S；**L2 e2e 明确挂 W6-B**（与 ime-matrix 同文，04 正文抄关闭条件）                                                                                          |
| **补全缺失目标项** | awareness overlay 保留为 04-P 强制项，禁止「可选后挂」蒸发                                                                                                                       |
| **禁止项强化**     | 已有禁止保留；新增：**禁止用 mock Diff 关闭 A-IME-07 输入会话**                                                                                                                  |
| **依赖**           | 真 Diff 事件形状继续绑 01/W0-E；mock 先行合法，但包完成报告必须写「mock / 真」                                                                                                   |

### 5.2 回写 `plans/05-块呈现与交互.md`

| 动作                | 内容                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W3-D 字面纠偏**   | 「叶子 PM → Intent」改为两阶段：**(1) Intent 契约骨架（已交付 plain 叶）**；**(2) 裸 PM 适配器（inline schema + dispatchTransaction→Intent）**——**(2) 未完成不得写 PM 合格** |
| **写锥硬门槛**      | 增加验收句：结构/文本 Intent 至少一条路径 **真实 `DocSession::apply` 集成测**（可无 UI），否则 A-BLK-02/05 **永久停 mock**                                                   |
| **DOM chrome 单列** | 把手/落点线/slash 宿主 = React/DOM 包；与 Model 假数据**分验收 ID**（模型 A-SIL 子集 ≠ 视觉 A-SIL）                                                                          |
| **块列表**          | 「仅窗口 DOM」升格为 **显式强制模块** + 依赖 04 WindowManager；禁止 chrome 假数据代替列表                                                                                    |
| **A-BLK 关闭闸**    | 正文抄 08：EL-01 **仅 W6-A 全表 e2e**；任何 W3 包 PR **禁止** 写「块工作区已完成」                                                                                           |
| **PM≠工作区**       | 保留并加粗：即便 PM 适配器绿，A-BLK 全表仍独立                                                                                                                               |

### 5.3 回写 `plans/09-执行任务包索引.md`（包定义去缩水）

建议 **拆包 / 重命名**（问题同权，下列仅依赖边）：

| 建议包 ID         | 文件域                                        | 验收（去缩水）                                                  | 与现状关系             |
| ----------------- | --------------------------------------------- | --------------------------------------------------------------- | ---------------------- |
| **W3-A**          | `editor-kit/viewport/**` + `diff/**`          | 结构门：DOM 上界常量、HeightMap、pin、mock Diff `fullRemount=0` | 现状可对标「骨架完成」 |
| **W3-B**          | `editor-kit/selection/**` + `ime/**`          | A-IME-01…05 **L1**；A-SEL store API；**明确 ≠ L2**              | 现状可对标 L1          |
| **W3-C**          | `block-paper/chrome/**` Model + fixture       | A-SIL **模型** 01–02；**≠** DOM 视觉 / EL-01                    | 现状合格假数据         |
| **W3-D0**（新名） | `block-paper/leaves/TextLeaf*` + intentBridge | Intent **mock** 通路；composing 缓冲                            | **= 现状 W3-D 实态**   |
| **W3-D1**（新）   | `block-paper/leaves/pm/**`                    | **真 PM** adapter + dispatch→Intent；仍可 mock sink             | **未做**               |
| **W3-D2**（新）   | leaves + runtime/IPC                          | Intent→**真 apply** 集成测                                      | **未做**；依赖 01      |
| **W3-E**          | `leaves/code/**`                              | CM6 默认可聚焦；语言表可扩；**≠** A-BLK-14 e2e                  | 半挂→补默认 host 策略  |
| **W3-F0**         | structureIntents + wire                       | 形状+wire 单测；mock sink                                       | **= 现状 W3-F**        |
| **W3-F1**（新）   | chrome UI + 拖拽/落点线                       | DOM 交互；仍可 mock                                             | **未做**               |
| **W3-G**（新）    | PaperList 挂载                                | 仅窗口 DOM + MountSpec 消费 04                                  | **未做**               |
| **W3-H**（新）    | MD 前缀 / turn-into / 未知 flavour            | A-BLK-08/09 子集契约                                            | **未做**               |
| **W6-A0**         | progress 契约抽样                             | **改名**：不得叫 W6-A                                           | 现状 `A-BLK-progress`  |
| **W6-A**          | e2e                                           | **恢复 09 原文**：A-BLK-01…14 **全表 e2e**                      | 未做；**EL-01 唯一闸** |
| **W6-B**          | WebView 三端                                  | ime-matrix **L2 必测格**                                        | 未做；**叶子核锁门禁** |
| **W6-C**          | perf                                          | 数值门标定（结构门已在 W3-A）                                   | 勿用结构门冒充         |

**成功定义铁律（写入 09 文首）**：

1. 包完成报告必须列 **关闭的 A-\* ID + 测层（unit / 集成 / e2e）**。
2. 无 e2e 不得关 A-BLK / A-IME 必测格。
3. **W3-\* 完成 ≠ EL 关闭**；EL-01 仅 W6-A；IME L3 仅 W6-B 后。
4. 禁止 Round 序号代替包 ID 验收。

### 5.4 回写 `08` / acceptance（交叉）

| 动作             | 内容                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `A-BLK-progress` | 标题去掉「W6-A」冒充；改为 **W6-A0 抽样进度**；表头写清「不贡献 EL-01」  |
| `ime-matrix`     | 已诚实 → **保留**；04/09 强制引用，实现 prompt 必挂                      |
| `08`             | 已写 EL-01→W6-A → **保留**；增一行：W3-D0/D1 均 **不得** 触发 EL-01 会计 |

### 5.5 与 01 / 07 的边界（本维上报，不扩写）

| 依赖                     | 说明                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| 01 真 apply / hydrate    | D5 写锥 D2 依赖心；mock 永不为终局                                  |
| 01 ProjectionDiff 真事件 | D4 Diff 应用器需真实 rev/upserts 源                                 |
| 07 双引擎                | editor-kit surface isolation 已有方向；产品双挂载不在本文件关 EL-08 |

---

## 6. 实现包建议（逻辑依赖，非工期）

```text
[已有·可保留]
  W3-A 算法 ──► W3-B L1 IME/选区
  W3-C Model ──► W3-F0 Intent+wire
  W3-D0 plain 叶 + mock sink
  W3-E CM6 host（半挂）

[方案再生后应排入的真缺口 · 同权列出]
  W3-D1 真 PM 适配器 ─────────┐
  W3-D2 Intent→真 apply ───────┼──► 写锥闭合（文本+结构）
  W3-G PaperList 窗口 DOM ◄── W3-A 扩展 WindowManager + 真 Diff
  W3-F1 chrome DOM / 拖拽 ─────┤
  W3-H MD 前缀 / turn-into ────┤
  W3-E' CM6 默认 host + RS ────┤
                               ▼
  W6-A0 契约抽样（现 progress，改名）
  W6-A  A-BLK 全表 e2e          ──► EL-01
  W6-B  IME L2 矩阵 e2e         ──► 叶子核锁定资格（L3）
  W6-C  A-PERF 数值门
```

**高代价正当（15/04/05 已认，方案不得砍）**：

- 文档级虚拟化完整 HeightMap+pin 矩阵
- WebView IME 全矩阵
- A-BLK 全表 e2e
- 真 PM 叶 + 非 serialize(pmDoc) 写锥

**过度工程否决（保持）**：默认全量挂载、CSS hidden 假虚拟化、像素测距选块、用行级 Doc 冒充块、假数据当权威。

---

## 7. 与审计报告对齐确认

| audit/03 裁定      | 本分析                                                              |
| ------------------ | ------------------------------------------------------------------- |
| 骨架密、效果关得少 | **同意**                                                            |
| 无真 PM 叶         | **同意**（代码再确认）                                              |
| Intent→mock sink   | **同意**                                                            |
| IME L2 零 e2e      | **同意**                                                            |
| EL-01 绝不可关     | **同意**；且 **不可 W3 关**                                         |
| W3-E 真 CM6 半挂   | **同意**                                                            |
| 自我标注整体诚实   | **同意**（README/progress/ime-matrix）；毒在**调度误读包绿=效果绿** |
| 不建议推倒重来     | **同意** → 方案再生拆包去缩水                                       |

| audit/00 交叉                   | 本分析                   |
| ------------------------------- | ------------------------ |
| Intent 主路径 mock；文本叶无 PM | 本维核心                 |
| IME L0/L1 分层文档诚实          | 保留并升格为 04 强制引用 |

---

## 8. 保留 / 废弃 / 改造 总表（代码资产）

| 资产                                             | 态度                                   | 理由                             |
| ------------------------------------------------ | -------------------------------------- | -------------------------------- |
| editor-kit viewport/HeightMap/pin/bounds         | **保留**                               | 结构门与虚拟化算法正确方向       |
| applyProjectionDiff + fullRemount 纪律           | **保留并改造**                         | 接真 Diff 后仍用同一指标         |
| SelectionStore                                   | **保留**                               | 逻辑坐标权威正确                 |
| ImeMachine + structureKeyGuard + matrix contract | **保留**                               | L1 合格；L2 另包                 |
| block-paper chrome Model + silentFixture         | **保留**                               | 假数据并行合法                   |
| structureIntents + opsWire                       | **保留**                               | wire 形状资产；接真 apply 时复用 |
| TextLeafModel                                    | **保留为过渡**；**不得**顶替 PM 包完成 | 契约形状有价值                   |
| createMockIntentSink                             | **保留测试桩**；**禁止**生产默认终局   | 文档已写明                       |
| lineWindow                                       | **保留**                               | huge-block 呈现侧                |
| Cm6CodeLeafHost                                  | **保留并改造**（默认路径/RS）          | 真依赖已接线                     |
| 任何「Round 完成=EL 关闭」叙事                   | **废弃**                               | 20 / audit/05                    |
| 用 W6-A 称呼抽样 progress                        | **废弃命名**                           | 去缩水                           |

---

## 9. 魔鬼用例清单（方案验收应用，非实现）

再生方案评审时，下列用例必须有**归属包 ID**（不可无主）：

1. 10 万块：首屏可滚；DOM ≤ 上界；滚动 pin 焦点/composing
2. 中文 IME 长句：不丢字、不 slash、end 后光标对（**L2**）
3. composing 中滚动：合成块不 unmount；end 后可卸
4. composing 中点另一块：end_then_switch；无半切换
5. 键入会话 fullRemountCount=0（真列表，非仅 mock Diff）
6. slash 插入 → **真 apply** → 树与投影一致（非 mock.calls）
7. 拖拽重排 + 落点线；多选批量删/转类型
8. MD 前缀 `# ` 转标题；composing 禁止
9. ≥64KiB 叶：行窗口；禁止单 node 全文；超长 pin+IME
10. 代码叶 CM6 产品路径可聚焦 + Intent 进 RS
11. 杀进程 / 未 ACK：呈现脏不得盖 RS（跨 X-04，呈现侧配合）
12. 远端 awareness 视口裁剪，不毁静默纸面

---

## 10. 方案再生检查清单（给主控）

- [ ] 04 正文区分 04-S / 04-P；L2 挂 W6-B
- [ ] 05 正文 W3-D 拆 D0/D1/D2；PM 字面与代码可对上
- [ ] 09 包表去缩水：W6-A=全表 e2e；抽样改 W6-A0
- [ ] 09 成功定义：包完成 ≠ EL；强制 A-\*+测层
- [ ] A-BLK-progress 改名/改波次标签
- [ ] ime-matrix 保持 L0–L3 分表；实现 prompt 强制挂
- [ ] 写锥：mock sink → 真 apply 有独立包与验收
- [ ] PaperList 窗口 DOM 有独立包（勿埋进 chrome 假数据）
- [ ] 双评审：效果完整度 + 可执行性（假并行：W3-G 依赖 04-P 形状）
- [ ] 实现波启动前：每包强制文档集（20 §3.3）

---

## 11. 最终裁定（本分析交付句）

```
D4  投影/IME：算法 + L1 状态机 绿骨架 / 产品窗口挂载·awareness·L2 e2e 未关
D5  块呈现：  chrome 模型 + Intent mock + CM6 半挂 / 无 PM / 无真 apply / 无 A-BLK

PM 叶：     文档要求有 · 代码无 · 名实不符
mock sink： 主路径 · 非终局
IME：       L1 可计 · L2 零 · 禁止叶子核锁定
A-BLK：     不可 W3 关闭 · 仅 W6-A 全表 e2e · 抽样≠W6-A

方案动作：  回写 04/05/09 拆骨架/真闭环包 · 去 W6 号缩水 · 保留可测资产
```

**禁止**在本分析基础上跳过方案再生直接「P0 焊 PM」——用户流程锁（`20`）要求分析 → 方案生成 → 双评审 → 改进落盘 → **显式口令**后实现。

---

## 12. 证据索引（绝对路径）

| 类      | 路径                                                                                  |
| ------- | ------------------------------------------------------------------------------------- |
| 流程/锁 | `C:\Software\conex\docs\block-workspace-architecture\20-流程重启-教训与章程.md`       |
| 锁      | `...\15-评审后锁定修订.md`、`...\00-调研边界与效果锁.md`                              |
| 任务书  | `...\plans\04-投影虚拟化与IME.md`、`...\plans\05-块呈现与交互.md`                     |
| 调度    | `...\plans\09-执行任务包索引.md`、`...\plans\08-验收与门禁.md`                        |
| 规格    | `...\plans\specs\ime-matrix.md`、`...\plans\specs\huge-block-policy.md`               |
| 验收    | `...\plans\acceptance\A-BLK-progress.md`、`...\plans\acceptance\A-assert-index.md`    |
| 审计    | `...\audit\2026-08-11-round-quality\00-总判-主控认账.md`、`...\03-W3W4-呈现与工具.md` |
| 选型    | `...\round-D-stack\05-投影虚拟化与IME.md`                                             |
| 代码    | `C:\Software\conex\packages\editor-kit\src\**`、`...\packages\block-paper\src\**`     |

---

**分析员角色**：方案分析子 Agent · 未改业务代码 · 未 git commit · 未嵌套派发。  
**产出路径**：`docs/block-workspace-architecture/analysis/2026-08-11-realign/D4D5-投影呈现与IME.md`
