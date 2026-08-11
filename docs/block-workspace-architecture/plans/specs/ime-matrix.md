# M3 · IME 端×断言矩阵（流程钉死 · 可执行）

> **Round8 状态**：矩阵已成型（表 + 子集自动化）。本波关闭流程债「矩阵未成型」。  
> **WebView e2e 必测格仍后置 W6-B**——纯逻辑/契约层可先绿，**不得**用单测冒充端 e2e 关闭叶子核=PM。

## 0. 状态图例

| 符号       | 含义                                                               | 关闭贡献                     |
| ---------- | ------------------------------------------------------------------ | ---------------------------- |
| `☐`        | 未覆盖（无自动化、无端 e2e）                                       | 不计入                       |
| `🟨自动化` | 纯逻辑 / 契约单测已绿（`ImeMachine` / `structureKeyGuard` / 桥层） | **语义子集**；不替代 WebView |
| `✅e2e`    | 目标端 WebView（Win WebView2 / macOS WK / Linux WebKit）e2e 已绿   | **必测格关闭**的充分条件     |

**必测 vs 抽样**（来自 D7 / M3 原表）：

- **必测**：该端发布前必须 `✅e2e` 才可锁定「叶子核=PM」（D1 T1）。
- **抽样**：可先以其他端 e2e + 本端自动化/手工抽样；发布策略另定，仍建议补 e2e。

## 1. 端×断言状态表

| 断言 \\ 端                     | 要求·Win WebView2 | 状态·Win | 要求·macOS WK | 状态·mac | 要求·Linux WebKit | 状态·Linux | 自动化映射（本仓）                           |
| ------------------------------ | ----------------- | -------- | ------------- | -------- | ----------------- | ---------- | -------------------------------------------- |
| A-IME-01 长句合成不丢字        | 必测              | 🟨自动化 | 必测          | 🟨自动化 | 必测              | 🟨自动化   | `ime-matrix.contract` · A-IME-01             |
| A-IME-02 合成中无 slash/结构键 | 必测              | 🟨自动化 | 必测          | 🟨自动化 | 必测              | 🟨自动化   | `ime-matrix.contract` + block-paper slash/桥 |
| A-IME-03 合成中滚动 pin        | 必测              | ☐        | 必测          | ☐        | 抽样              | ☐          | pin 单测有子集，**未**标矩阵格自动化         |
| A-IME-04 点另一块策略          | 必测              | ☐        | 必测          | ☐        | 抽样              | ☐          | —                                            |
| A-IME-05 合成=一步撤销         | 必测              | ☐        | 必测          | ☐        | 抽样              | ☐          | groupId 字段有；撤销接线未矩阵化             |
| A-IME-06 合成中远端/Agent      | 必测              | ☐        | 抽样          | ☐        | 抽样              | ☐          | —                                            |
| A-IME-07 fullRemount=0         | 必测              | ☐        | 必测          | ☐        | 必测              | ☐          | Diff 计数有；输入会话路径未矩阵化            |
| A-IME-08 合成后 `# ` 转标题    | 必测              | ☐        | 必测          | ☐        | 抽样              | ☐          | —                                            |

> 三端共享同一 `ImeMachine` 语义时，**🟨自动化** 可同格并进；**✅e2e 必须分端**，不可因 Win 绿而勾 mac/Linux。

## 2. 可自动化语义子集（本波锁定）

| ID       | 可自动化语义（不依赖真实 IME 引擎）                                                                 | 实现位置                                                  |
| -------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A-IME-01 | 长串 `updateComposition` 后 `endComposition(final)` **committedText = final**（value 优先、不丢字） | `packages/editor-kit/src/ime/ime-matrix.contract.test.ts` |
| A-IME-01 | `endComposition` 省略 final 时用 preview；提交后 **phase=idle**、blockId/groupId 清空               | 同上                                                      |
| A-IME-02 | composing 时 `structure_key` / `op` / `request_slash` → `tryAcceptIntent` **reject**                | 同上 + `ImeMachine.test.ts`                               |
| A-IME-02 | 合成 **end 后 idle**，结构键与 slash **放行**                                                       | 同上                                                      |
| A-IME-02 | block-paper：`SlashMenuModel.open` composing 拒绝；`submitIntent` 结构 op 拒绝                      | `packages/block-paper/src/chrome/chrome.asil.test.ts` 等  |

**明确不在本波自动化、仍属 W6-B e2e 的部分**：

- 真实 OS IME（中/日/韩）候选窗、composition 事件时序
- WebView 滚动 pin 与 unmount 时序（A-IME-03）
- 点击另一块提交/取消策略（A-IME-04）
- 撤销栈 groupId 接线（A-IME-05）
- 远端/Agent 同块合并（A-IME-06）
- 输入会话 `fullRemountCount===0`（A-IME-07）
- 合成结束后 markdown 前缀转块（A-IME-08）

## 3. 关闭条件

| 层级            | 条件                                                                                          | 本波             |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| **L0 矩阵成型** | 本文件存在可勾选状态表 + 关闭条件 + 自动化 ID 映射 + `IME_MATRIX_CELLS` 常量                  | ✅ Round8 关闭   |
| **L1 语义子集** | A-IME-01 / A-IME-02 契约单测全绿（`npx vitest run … -t IME` 或全量 editor-kit + block-paper） | ✅ Round8 目标   |
| **L2 端 e2e**   | 目标发布端「**必测**」格全部 `✅e2e`                                                          | ❌ 后置 **W6-B** |
| **L3 叶子核锁** | L2 达成后才允许锁定「叶子核=PM」（D1 T1）；失败走 B1/B2，禁止用「业界 PM 成熟」关闭           | ❌ 依赖 L2       |

**禁止**：

- 用 `🟨自动化` 把必测格改成「已关闭」
- 用行级 `reference/markdown-editor` e2e 冒充块纸面 WebView 矩阵关闭（可参考纪律，ID 不互通关闭）
- 删除主仓 markdown-editor 专项 e2e（测试资产铁律）

## 4. 常量与测试入口

| 资产            | 路径                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| 矩阵单元格常量  | `packages/editor-kit/src/ime/imeMatrix.ts` → `IME_MATRIX_CELLS`              |
| 契约测试        | `packages/editor-kit/src/ime/ime-matrix.contract.test.ts`                    |
| 既有机测        | `packages/editor-kit/src/ime/ImeMachine.test.ts`                             |
| slash composing | `packages/block-paper/src/chrome/chrome.asil.test.ts` / `chrome.w3f.test.ts` |

门禁示例：

```bash
npx vitest run packages/editor-kit packages/block-paper -t IME
# 或
npx vitest run packages/editor-kit packages/block-paper
```

## 5. 修订记录

| 日期       | 变更                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-08-11 | Round8：可勾选状态表 + A-IME-01/02 自动化语义 + `IME_MATRIX_CELLS`；WebView e2e 明确后置 W6-B；关闭「矩阵未成型」流程债 |
| （初版）   | 端×断言「必测/抽样」骨架                                                                                                |
