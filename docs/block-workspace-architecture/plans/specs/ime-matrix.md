# M3 · IME 端×断言矩阵（流程钉死 · 可执行）

> **Round8 状态**：矩阵已成型（表 + 子集自动化）。本波关闭流程债「矩阵未成型」。
> **Round9 · W6-B 预备**：A-IME-03…05 语义自动化加深（pin / 切块策略 / commit 边界）。
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

| 断言 \\ 端                     | 要求·Win WebView2 | 状态·Win | 要求·macOS WK | 状态·mac | 要求·Linux WebKit | 状态·Linux | 自动化映射（本仓）                                        |
| ------------------------------ | ----------------- | -------- | ------------- | -------- | ----------------- | ---------- | --------------------------------------------------------- |
| A-IME-01 长句合成不丢字        | 必测              | 🟨自动化 | 必测          | 🟨自动化 | 必测              | 🟨自动化   | `ime-matrix.contract` · A-IME-01                          |
| A-IME-02 合成中无 slash/结构键 | 必测              | 🟨自动化 | 必测          | 🟨自动化 | 必测              | 🟨自动化   | `ime-matrix.contract` + block-paper slash/桥              |
| A-IME-03 合成中滚动 pin        | 必测              | 🟨自动化 | 必测          | 🟨自动化 | 抽样              | 🟨自动化   | `planScrollUnmount` + `ImeMachine.planScrollUnmount`      |
| A-IME-04 点另一块策略          | 必测              | 🟨自动化 | 必测          | 🟨自动化 | 抽样              | 🟨自动化   | 钉死 `end_then_switch` · `requestFocusSwitch`             |
| A-IME-05 合成=一步撤销         | 必测              | 🟨自动化 | 必测          | 🟨自动化 | 抽样              | 🟨自动化   | 仅 `endComposition` 写一条 `ImeCommitBoundary`（groupId） |
| A-IME-06 合成中远端/Agent      | 必测              | ☐        | 抽样          | ☐        | 抽样              | ☐          | —                                                         |
| A-IME-07 fullRemount=0         | 必测              | ☐        | 必测          | ☐        | 必测              | ☐          | Diff 计数有；输入会话路径未矩阵化                         |
| A-IME-08 合成后 `# ` 转标题    | 必测              | ☐        | 必测          | ☐        | 抽样              | ☐          | —                                                         |

> 三端共享同一 `ImeMachine` 语义时，**🟨自动化** 可同格并进；**✅e2e 必须分端**，不可因 Win 绿而勾 mac/Linux。
> **L2 仍后置**：上表 🟨 不等于 e2e；Win WebView2 **必测**格（含 01–08）在 L2 关闭前仍为「必测且未 e2e」。

## 2. 可自动化语义子集（Round8 + Round9）

| ID       | 可自动化语义（不依赖真实 IME 引擎）                                                                             | 实现位置                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A-IME-01 | 长串 `updateComposition` 后 `endComposition(final)` **committedText = final**（value 优先、不丢字）             | `packages/editor-kit/src/ime/ime-matrix.contract.test.ts` |
| A-IME-01 | `endComposition` 省略 final 时用 preview；提交后 **phase=idle**、blockId/groupId 清空                           | 同上                                                      |
| A-IME-02 | composing 时 `structure_key` / `op` / `request_slash` → `tryAcceptIntent` **reject**                            | 同上 + `ImeMachine.test.ts`                               |
| A-IME-02 | 合成 **end 后 idle**，结构键与 slash **放行**                                                                   | 同上                                                      |
| A-IME-02 | block-paper：`SlashMenuModel.open` composing 拒绝；`submitIntent` 结构 op 拒绝                                  | `packages/block-paper/src/chrome/chrome.asil.test.ts` 等  |
| A-IME-03 | composing 时 `buildPinned` 含合成块；`planScrollUnmount` 将 composing/焦点/pin **retained**，不进 allowed       | `ime-matrix.contract` + `viewport/pin.test.ts`            |
| A-IME-03 | end 后原合成块可被滚动卸载（离开 pin 守卫）                                                                     | 同上                                                      |
| A-IME-04 | **钉死策略 `end_then_switch`**（`IME_FOCUS_SWITCH_STRATEGY`）：合成中点另一块 → 先 `endComposition` 再 switched | `ImeMachine.requestFocusSwitch` + contract                |
| A-IME-04 | 同块点击不 end；禁止半切换（end 后 phase=idle、composing 不再挂旧块）                                           | 同上                                                      |
| A-IME-05 | 多次 `updateComposition` **不**写边界；`endComposition` **恰好一条** `ImeCommitBoundary`（同 groupId）          | `drainCommitBoundaries` / `peekCommitBoundaries`          |
| A-IME-05 | 两次合成 → 两条边界、不同 groupId；`requestFocusSwitch` 触发的 end 计入一步                                     | 同上                                                      |

**明确不在自动化、仍属 W6-B e2e 的部分**：

- 真实 OS IME（中/日/韩）候选窗、composition 事件时序
- WebView 滚动 pin 与 unmount **时序**（A-IME-03 语义子集已自动化；端 e2e 仍 ☐）
- 真实点击命中另一块的 DOM/焦点环（A-IME-04 策略契约已自动化；端 e2e 仍 ☐）
- 真实撤销栈 / history 接线（A-IME-05 model 边界已自动化；undo UI e2e 仍 ☐）
- 远端/Agent 同块合并（A-IME-06）
- 输入会话 `fullRemountCount===0`（A-IME-07）
- 合成结束后 markdown 前缀转块（A-IME-08）

### 2.1 A-IME-04 策略钉死说明

| 策略 ID               | 行为                                             | 本波     |
| --------------------- | ------------------------------------------------ | -------- |
| **`end_then_switch`** | 先 end（value 优先提交原块）再允许焦点切到目标块 | **钉死** |
| （未采用）拒绝切换    | composing 期间忽略/拒绝点另一块                  | 否       |
| （未采用）cancel 再切 | 丢弃 preview 不提交                              | 否       |

依据：D7 A-IME-04「提交原块或取消」须显式；行级纪律「切块强制 end」——已上屏字经 value 提交，半成品拼音可丢。

## 3. 关闭条件

| 层级            | 条件                                                                                          | 本波             |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| **L0 矩阵成型** | 本文件存在可勾选状态表 + 关闭条件 + 自动化 ID 映射 + `IME_MATRIX_CELLS` 常量                  | ✅ Round8 关闭   |
| **L1 语义子集** | A-IME-01 / A-IME-02 契约单测全绿（`npx vitest run … -t IME` 或全量 editor-kit + block-paper） | ✅ Round8 关闭   |
| **L1+ 加深**    | A-IME-03…05 契约/ pin 单测全绿（仍为 🟨，**不**计 L2）                                        | ✅ Round9 目标   |
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
| pin / 滚动卸载  | `packages/editor-kit/src/viewport/pin.ts` → `planScrollUnmount`              |
| slash composing | `packages/block-paper/src/chrome/chrome.asil.test.ts` / `chrome.w3f.test.ts` |

门禁示例：

```bash
npx vitest run packages/editor-kit
# 或子集
npx vitest run packages/editor-kit packages/block-paper -t IME
```

## 5. 修订记录

| 日期       | 变更                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| 2026-08-11 | Round9：A-IME-03…05 三端标 🟨自动化；`planScrollUnmount` / `end_then_switch` / `ImeCommitBoundary`；L2 e2e 仍后置 W6-B  |
| 2026-08-11 | Round8：可勾选状态表 + A-IME-01/02 自动化语义 + `IME_MATRIX_CELLS`；WebView e2e 明确后置 W6-B；关闭「矩阵未成型」流程债 |
| （初版）   | 端×断言「必测/抽样」骨架                                                                                                |
