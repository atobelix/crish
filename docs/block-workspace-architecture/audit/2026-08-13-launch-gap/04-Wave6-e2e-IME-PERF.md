# 04 · Wave6 e2e / IME / PERF 上线缺口（方案位 · 只写文档）

| 元数据     | 值                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------- |
| **维**     | Wave 6 Strict 相对可上线：A-BLK 全表 e2e、IME L2、PERF 数值、A-COL 满、千次批+恶意           |
| **轨声明** | 本文只立法 **可证伪切片（LR-\*)**；**官方关闭包仍是** `plans/09` 的 **W6-A / B / C / D / E** |
| **禁**     | 改业务代码；git commit；写 `00`；去 `-S` 冒充 Strict；TBD 当 PERF 通过；W6-A-S 抽样关 EL-01  |
| **日期**   | 2026-08-13                                                                                   |

权威（窄读）：`PREP-上线缺口方案位.md` · `plans/09` Wave 6 · `plans/08` §1.0 / 性能两阶段 · `acceptance/A-BLK-progress.md` · `acceptance/perf-baseline.md` · `specs/ime-matrix.md` · `acceptance/EL-dashboard.md` 表 A / D · D7 §5.1–5.9。

可上线对照（PREP，不可降级）：表 A EL 按 **Strict** 关闭 + 表 B 真绿 + G-HYD 产品句。
**现状**：表 A **0/10**；W6 仅 `-S`（`19` / 表 C）。**单切片完成 ≠ 关该 EL ≠ 改表 A**。

---

## 0. 会计铁律（本维专钉）

| #      | 铁律                                                                                           | 证伪点                                                 |
| ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **F1** | **单切片禁关表 A**。LR-\* 绿只改本切片行 / 表 B 该 ID 层；**不得**写「EL-01/03/04/05/07 关闭」 | 表 A 该行仍「未关闭」直至官方 Strict 包满              |
| **F2** | **禁止去 `-S`**。W6-A-S / B-S / C-S / D-S / E-S 完成 ≠ Strict                                  | `W6_A_S_PACKAGE_ID` 等必须仍带 `-S`                    |
| **F3** | **TBD 数值 ≠ PERF 通过 ≠ EL-03**。禁止脚本把 `TBD（未标定）` 改成假数字                        | `perf-baseline.md` §0 / §3；`perf_baseline_rev`        |
| **F4** | **W6-A-S 抽样禁止关 EL-01**。progress 黄/绿抽样不贡献关闭                                      | `A-BLK-progress.md:1-8`；`08:78`                       |
| **F5** | **行级 e2e ≠ 块纸面**。`tests/e2e/ime-composition.spec.ts` 走 textarea + 5173 + 行级 store     | `ime-matrix.md:85-86`；测试资产铁律：可留、不可关 W6-B |
| **F6** | **CONN-01 冒烟 ≠ A-BLK e2e**。`webview-smoke.spec.ts` 自钉 ≠ EL-01 / ≠ A-BLK                   | `tests/e2e/webview/webview-smoke.spec.ts:10-14`        |
| **F7** | **A-BLK-10…14 必须在表**。禁止再写成「06…14 全表 e2e」一锅（`05:185` 旧缩写法）                | 本文 §3.1 各占一行                                     |
| **F8** | 官方关闭包 **W6-A / W6-B / W6-C / W6-D / W6-E** 仅在对应 LR 全集 + 表 B 真绿后，由主控改表 A   | 实现 Agent 无权改表 A                                  |

官方关闭映射（只读 Strict，抄 `09:338-345` / 表 A）：

| EL               | 官方关闭包                         | 本文切片族    |
| ---------------- | ---------------------------------- | ------------- |
| **EL-01**        | **W6-A**（全表 e2e）               | LR-01…14      |
| **EL-02** 静默项 | W3-C + **W6-A 静默项**             | LR-10 + LR-15 |
| **EL-03** 数值   | 结构 W3-A；数值 **W6-C**（非 C-S） | LR-26…31      |
| IME 叶子核       | **W6-B** + 真 PM                   | LR-16…25      |
| **EL-04**        | W1-F + **W6-D** + G-HYD            | LR-32…37      |
| **EL-05 / 07**   | W4-B/C + **W6-E**                  | LR-38…41      |

---

## 1. 不满足上线的清单（问题同权）

每条可复核。无测路径标 **推断**。本维不处理打开完成 / 七链半通 / 设计纸面（见 01/02/03）。

### 1.1 W6-A · A-BLK 全表 e2e 未立（EL-01 开）

| ID              | 现状（progress 2026-08-12 口径） | 缺口（可证伪）                                                                        | 证据                                                                                 |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **载体**        | 无块纸面 Playwright 用例         | `playwright.config.ts` `testMatch` **仅** `webview-smoke`；零 `a_blk_*` e2e           | `tests/e2e/webview/playwright.config.ts:30-35`；`tests/e2e` grep 块纸面仅 smoke 自否 |
| **A-BLK-01**    | 库侧绿（含 undo 还原 id）        | 产品 undo/redo/快捷键 / UI 引用可解析 **无 e2e**                                      | `A-BLK-progress.md:22`                                                               |
| **A-BLK-02**    | 黄 · Intent 形状半               | slash 浮层 → 真插入；**IME 不误触** 产品路径未 e2e                                    | `progress:23`；`chrome.a_blk.test.ts:69`；`slashSelectAndSubmit.test.ts` 头 ≠ e2e    |
| **A-BLK-03**    | 黄 · jsdom 半                    | 悬停把手可见 / L0 静默 **视觉 e2e** 无                                                | `progress:24`；`chrome.w3f_dom.test.ts` 头                                           |
| **A-BLK-04**    | 黄 · Op + 落点半                 | Pointer 拖拽 + 落点线 **产品 e2e** 无                                                 | `progress:25`；`chrome.w3f_drag.test.ts` 头                                          |
| **A-BLK-05**    | 黄 · 删除 Intent + 多选框半      | 框选 e2e / 批量转类型 e2e 无                                                          | `progress:26`                                                                        |
| **A-BLK-06**    | 黄 · Move nest 半                | 列表 schema / MD 缩进级 / BulletItem 语义未关                                         | `progress:27`                                                                        |
| **A-BLK-07**    | 黄 · 重生 id 策略半              | 拖放预览 UI / 跨文档拖入产品 e2e 无                                                   | `progress:28`                                                                        |
| **A-BLK-08**    | 黄 · 心+Intent 半                | 产品菜单 / **保逻辑选区投影 e2e** 无                                                  | `progress:29`；`turnInto.line-budget.test.ts` 禁假关                                 |
| **A-BLK-09**    | 黄 · 本波未抽样产品键入          | `# ` / `- ` / 任务；**composing 禁止** 产品键入链未 e2e；桌面 PM/HiddenInput 可能未接 | `progress:30`；`mdPrefixHost.ts:19-25`                                               |
| **A-BLK-10**    | **红** · 未触及                  | 块引用 / 反向链接 **跳转** 无测；packages 无 backlink UI（W2-F 仅库内物化）           | `progress:40`；`refs_tests_w2f.rs` ≠ 跳转                                            |
| **A-BLK-11**    | 绿心+wire / 黄 View              | 占位块 **可恢复 UI e2e** 无                                                           | `progress:41`；`w3h.direction.test.ts:374+`                                          |
| **A-BLK-12**    | 黄 · 无专名                      | **无** `a_blk_12_*`；A-SURF 旁证 ≠ 本 ID；代码叶默认仍 `textarea`                     | `progress:42`；`CodeLeafHost.ts:34,208-214`                                          |
| **A-BLK-13**    | 黄 · Intent 形状半               | HeightMap 折叠/展开 + 选区钳制 **e2e** 无                                             | `progress:43`                                                                        |
| **A-BLK-14**    | 黄 · CM6 骨架半                  | 产品 focus e2e 无；只读呈现 ≠ 可编辑                                                  | `progress:44`；`Cm6CodeLeafHost.ts` 头                                               |
| **A-SIL-03/04** | 模型/假数据向                    | IME 候选窗不被 chrome 遮挡；滚动 gutter 无幽灵 —— **视觉 e2e 无**（EL-02 静默项）     | D7 §5.2；`08:79`                                                                     |

`05:185` 把 **06…14** 收成一行「全表 e2e」——正是本维要拆开的缩水写法。

### 1.2 W6-B · IME L2 零格（叶子核未锁）

| 项                | 缺口                                                                 | 证据                                                               |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 24 格全无 `✅e2e` | `imeMatrixAnyE2e() === false`；L2 / L3 未关                          | `ime-matrix.md:21-34,79-80`；`ime-matrix.contract.test.ts:117-151` |
| A-IME-01…06       | 仅 🟨自动化；**Win 必测**仍开                                        | `ime-matrix.md:24-29`；`imeMatrix.ts:116-168`                      |
| A-IME-07 / 08     | 矩阵 **open（☐）**；Diff 单测 ≠ 输入会话                             | `ime-matrix.md:30-31,59-60`；`applyProjectionDiff.test.ts:2,33`    |
| 叶子核=PM         | `imeMatrixLeafCoreLockEligible` Skeleton 下应 false                  | `imeMatrix.ts:10-11,330`；`ime-matrix.md:80`                       |
| 行级 IME spec     | `page.goto(localhost:5173)` + `textarea` + `__CRISH_SESSION_STORE__` | `tests/e2e/ime-composition.spec.ts:1-18` —— **禁关 W6-B**          |
| 文档漂移          | 代码已把 A-IME-06 标 automated；`ime-matrix.md:29` 仍 ☐              | 见 §6 额外发现                                                     |

Win WebView2 **必测** = A-IME-01…08 共 8 格（`imeMatrix.ts:119-187`）。mac 必测 7 格（06 抽样）；Linux 必测 01/02/07。L2 关闭 ⇔ 目标发布端必测格全部 `✅e2e`（`ime-matrix.md:79`）。

### 1.3 W6-C · 数值门未标定（EL-03 开）

| 项          | 缺口                                                                   | 证据                                                |
| ----------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| 轨          | 当前交付 **W6-C-S**；`perf_baseline_rev = 0`                           | `perf-baseline.md:11-23`                            |
| 指纹        | OS/CPU/RAM/WebView/标定人/日/SHA 全「待本机标定」                      | `perf-baseline.md:29-40`                            |
| §3.1–3.4    | 打开 1k/10k/100k、键入/IME、滚动、A-PERF-04…11 **全部 TBD（未标定）**  | `perf-baseline.md:95-130`                           |
| 结构余量    | S-SNAP（每键 snapshot）/ S-MERGE（merge 非 UI 线程）checklist **未勾** | `perf-baseline.md:78-79`                            |
| 脚手架      | `perf:block-workspace` / `#[ignore]` **只打印**；禁止自动改 TBD        | `perf-baseline.md:188-191`；`perf-governance.md:10` |
| 代理 ≠ 终值 | `open_nk_blocks` = 无 UI 数据层；`heightmap_query` **不是** 滚动 jank  | `perf-baseline.md:243-245`                          |
| 表 D        | 结构门 / 数值门 **均未关闭**                                           | `EL-dashboard.md:81-87`                             |

### 1.4 W6-D · A-COL 满语义未立（EL-04 开）

| 项          | 缺口                                                      | 证据                                            |
| ----------- | --------------------------------------------------------- | ----------------------------------------------- |
| 轨          | 仅 **W6-D-S** in-process A-COL-01 **子集**                | `w6_d_s.rs:1-27`；`w6_d_s_a_col_subset.rs:1-13` |
| A-COL-01    | 无状态哈希终局；JSON 重放不得作终局                       | `08:234`；`w6_d_s.rs:20`                        |
| A-COL-02    | merge 不在 UI 主线程 —— 与 S-MERGE / A-PERF-06 同缺接线测 | D7 §5.5；`perf-baseline.md:79`                  |
| A-COL-03    | 禁 forceReload / 整树全量 —— Diff 计数有；产品会话未矩阵  | `applyProjectionDiff.ts:6`                      |
| A-COL-04    | W1-U 语义绿（表 B）；**单 ID ≠ EL-04**                    | `EL-dashboard.md:41,52`                         |
| A-COL-05    | 杀进程+outbox 上线收敛仍红方向                            | `02-存储索引与落盘.md:191`                      |
| A-COL-06    | 属性测骨架有；双端规则+永不持久化环未当满关               | `prop_concurrent.rs` 头                         |
| A-COL-07/08 | 可选 Yjs 互通 / 销毁仅 RS hydrate —— **缺测=未交付**      | D7 §5.5                                         |
| 脚手架退出  | A-INV-08：单写者不得替代多人 RS；退出=A-COL-01 绿灯       | D7 §5.8                                         |

### 1.5 W6-E · 千次批+恶意未闭环（EL-05/07 开）

| 项          | 缺口                                                              | 证据                                |
| ----------- | ----------------------------------------------------------------- | ----------------------------------- |
| 轨          | **W6-E-S**：Memory 千次 dryRun + 禁写键扫描                       | `note_w6e_skeleton.rs:1-24,36-39`   |
| Memory 禁令 | Memory 绿 **禁关**生产 A-AGT / EL-05                              | `note_w6e_skeleton.rs:19`；`06:123` |
| A-AGT-01…03 | 真 persist 千次全有或全无 / 第 500 回滚 / 击键并发 —— 夹具 ≠ 生产 | D7 §5.6                             |
| A-AGT-04    | 工具改 DOM 版本不变 —— 无 WebView 集成                            | D7 §5.6                             |
| A-AGT-05…08 | W4-F 形状子集已交；**≠ W6-E** 千次+恶意闭环                       | `19` W4-F / W6-E-S 行               |
| 恶意扩展    | 骨架扫描深度 2；≠ TrustGate / 零持久化生产门                      | `note_w6e_skeleton.rs:70-73`        |

---

## 2. 已交且诚实的边界（禁止整包重做）

下列 **已可点名**。切片只补 **e2e / 数值 / 满语义**，不得推倒重写。

| 资产                                                                           | 轨              | 已交                                                            | **明确 ≠**          |
| ------------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------- | ------------------- |
| `w6_a_s.rs` + `a_blk_contract.rs` + `chrome.a_blk.test.ts`                     | **W6-A-S**      | 01/04/06/07/08/11 心侧；02/03/05/13/14 Intent/CM6 形状          | EL-01；全表 e2e     |
| W3-D / W3-F / W3-G / W3-H / W3-E                                               | Strict **子集** | 真 PM+apply；slash/delete sink；窗口 DOM；MD 前缀方向；CM6 host | A-BLK 产品 e2e      |
| W2-F `materialize_block_refs`                                                  | Strict 结构     | `((id))`/`[[wiki]]` 抽边                                        | A-BLK-10 **跳转**   |
| W2-C FTS 结构门                                                                | Strict 结构     | A-PERF-10 非默认 LIKE                                           | A-PERF-10 **数值**  |
| `imeMatrix.ts` + `ime-matrix.contract.test.ts`                                 | **W6-B-S**      | L0 24 格；L1/L1+；06 语义加深                                   | L2 e2e；叶子核      |
| `perf-baseline.md` + `perf-baseline.contract.test.ts` + `perf:block-workspace` | **W6-C-S**      | 结构常量 512/12/256；TBD 骨架；打印脚手架                       | 数值门；EL-03       |
| `w6_d_s.rs` + `a_col_dual_peer.rs`                                             | **W6-D-S**      | in-process 双 peer 子集                                         | A-COL 满；EL-04     |
| W1-U                                                                           | Strict          | A-COL-04 / A-MEM-04 语义绿                                      | EL-04               |
| `note_w6e_skeleton.rs`                                                         | **W6-E-S**      | 1000 insert 夹具 + 禁写键                                       | EL-05/07；W6-E      |
| W4-B / W4-F / W4-C                                                             | Strict 子集     | 审批/batch；block_batch+dryRun；contribute 拒写                 | 千次+恶意；EL-05/07 |
| CONN-01 `cdp.ts` + `webview-smoke`                                             | 载体            | 9222 `connectOverCDP`；真 store / `__TAURI_INTERNALS__`         | A-BLK / IME / PERF  |

**依赖（本维不重做，但切片会红）**：真纸面可打开（01 / CONN / G-HYD 产品句）；W3-P 真 Diff 输入会话（A-IME-07）；outbox/杀进程（A-COL-05，02 维）。切片完成定义须写清：前置未绿 → **本切片未交付**，不得降断言。

---

## 3. 可执行包表（新号 LR-01 起）

**读表**：

- **文件域** 只允许两类主标签：**Playwright · WebView2 :9222**（`tests/e2e/webview/`，复用 `cdp.ts`，`npm run dev:workbench`，禁 5174 独立浏览器、禁 mock-engine）或 **库内**（cargo / vitest / 打印脚手架）。可并列，但关闭证据以「断言要求的层」为准（D7：02/03/04/05/07/08/09/13/14 = e2e）。
- **完成定义** = 可点名测路径或「无测=未完成」。
- **≠** = 本切片即使绿也 **不得** 关的官方包 / EL。

扩展载体（所有 9222 切片共用，**本身不是关闭包**）：

| 动作             | 路径                                     | 完成                                                                |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| 放宽 `testMatch` | `tests/e2e/webview/playwright.config.ts` | 除 smoke 外匹配 `w6a-*.spec.ts` / `w6b-*.spec.ts` / `w6c-*.spec.ts` |
| 新 spec 命名     | 同上目录                                 | `w6a-a-blk-02.spec.ts` 等；describe 含断言 ID                       |
| 诚实头           | 每个 spec 文件头                         | 复制 F1/F6：≠ 关表 A；≠ CONN-01 冒充本 ID                           |

### 3.1 W6-A 强制拆分 · A-BLK-02 / 08 / 09 再 10–14（各占一行）

> 09 Strict：`W6-A` = A-BLK-01…14 **全表 e2e**；**10–14 必须在表**（`09:326`）。
> 本小节 8 行是派单不可合并的最小拆分。01 / 03–07 见 §3.2（同权，不因「先做 02」删维）。

| 切片 ID   | 断言                                    | 文件域                            | 完成定义（可测）                                                                                                                                                                                                                                        | **≠**                                          |
| --------- | --------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **LR-01** | **A-BLK-02** Slash 插入 + IME 不误触    | **9222** 主；库内形状已交勿重写   | 1) 真纸面 `/` 打开 slash → 选 heading/list → 树增块且 `block_id` 稳；sink 为 `createCollabApplySink` 非 mock。2) composing 中 `/` **不**开菜单（交叉 A-IME-02 / A-SIL）。测名建议 `w6a_a_blk_02_slash_insert_*` / `w6a_a_blk_02_ime_no_false_slash`。   | **≠ EL-01**；≠ W6-A 全表；≠ 关 A-IME-02 矩阵格 |
| **LR-02** | **A-BLK-08** turn into **保逻辑选区**   | **9222** 主                       | 产品菜单 paragraph↔heading/list/quote：`block_id`+文本+parent/order 不变；投影选区 offset = `clampLogicalSelection` 后逻辑坐标（禁像素测距）。测名 `w6a_a_blk_08_turn_into_keeps_logical_sel`。                                                         | **≠ EL-01**；≠ 关 A-BLK-09 / A-IME-08          |
| **LR-03** | **A-BLK-09** MD 前缀；composing 禁止    | **9222** 主                       | 空段键入 `# ` / `- ` / 任务前缀 → 转 kind；composing 期间同一按键 **不**转。须走产品键入链（PM/HiddenInput），`simulateMdPrefixSubmit` **不得**作本切片关闭证据。测名 `w6a_a_blk_09_md_prefix_*` / `w6a_a_blk_09_composing_forbids`。                   | **≠ EL-01**；≠ 关 A-IME-08（L2 另片）          |
| **LR-04** | **A-BLK-10** 块引用 / 反向链接跳转      | **9222** 跳转 + **库内** 稳 id    | 1) 库内专名 `a_blk_10_*`：引用边指向稳定 `block_id`（可复用 W2-F 物化，**禁止**手工 seed 当终局）。2) 9222：点击引用/反向链接 → 窗口滚到目标块且 id 不变。缺 UI = **本 ID 未交付**（不得用「先不做跳转」删维）。                                        | **≠ EL-01**；≠ 关 A-QRY / EL-03                |
| **LR-05** | **A-BLK-11** 未知 flavour 占位可恢复    | **9222** View + 库内心已交        | 未知 flavour 占位可见、文本/id 不丢；turn-into / 注册后恢复仍同 id。测名 `w6a_a_blk_11_placeholder_recover_e2e`。库内 `a_blk_11_*` 已绿 **≠** 本切片。                                                                                                  | **≠ EL-01**；≠ A-EXT 全表                      |
| **LR-06** | **A-BLK-12** 禁 textarea / 行级冒充     | **库内** 专名门禁 + **9222** 负例 | 1) **必须**出现 `a_blk_12_*`（A-SURF **不得**顶替）。2) 默认产品纸面根 **不是** 单 `textarea` / 不是 `reference/markdown-editor` 行级。3) 9222：Strict 纸面存在块列表/叶，而非单一 textarea 编辑器。`DomCodeLeafHost` textarea **不得**当块工作区默认。 | **≠ EL-01**；≠ 关 A-SURF / EL-08               |
| **LR-07** | **A-BLK-13** 折叠↔HeightMap；选区钳制   | **9222** 主                       | 折叠/展开后窗口高度图一致（index 误差 ≤ 1–2 块高）；删/折焦点块后选区钳制策略可断言（与 A-SEL-04 交叉但不关 A-SEL 全族）。测名 `w6a_a_blk_13_collapse_heightmap_*`。                                                                                    | **≠ EL-01**；≠ A-PERF 数值                     |
| **LR-08** | **A-BLK-14** 代码叶 CM6（或等价）可聚焦 | **9222** 主                       | 点击代码块 → **CM6（或已锁定等价）** 获焦可键入；只读 `ReadonlyCodePresentation` **不得**冒充。默认 `textarea` host 仍在 = 未交付。测名 `w6a_a_blk_14_cm6_focus_type`。                                                                                 | **≠ EL-01**；≠ 关 A-IME 矩阵                   |

### 3.2 W6-A 其余 ID（01、03–07）+ 静默视觉（同权）

| 切片 ID   | 断言                                      | 文件域                          | 完成定义                                                                                                         | **≠**                                     |
| --------- | ----------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **LR-09** | **A-BLK-01** 产品 undo/redo/UI            | **9222** + 库内已绿勿重写       | 创建/移/删后引用可解析；**产品** undo（快捷键）还原同 `block_id`；redo 可点名。库内 `a_blk_01_undo_*` ≠ 本切片。 | **≠ EL-01**；≠ 关 EL-04 / A-COL-04        |
| **LR-10** | **A-BLK-03** 把手悬停（L0 按需）          | **9222** 视觉/DOM               | L0 无常驻把手；hover/focus 出现 `data-handle-visibility`；离悬停消失。交叉 A-SIL-01/02，**不单独关 EL-02**。     | **≠ EL-01 / EL-02**                       |
| **LR-11** | **A-BLK-04** 单块拖拽 + 落点线            | **9222**                        | Pointer 拖到落点 → 单次 `move_block`；落点线显隐正确。jsdom `w3f_dom_drop_line` ≠ 本切片。                       | **≠ EL-01**                               |
| **LR-12** | **A-BLK-05** 框选 + 批量转/删             | **9222**                        | 框选多块 → 批量删或批量 turn-into；树与选区一致。多选框 jsdom ≠ 框选 e2e。                                       | **≠ EL-01**                               |
| **LR-13** | **A-BLK-06** 缩进 / 嵌套列表 = schema     | **9222** + **库内** 列表 schema | Tab/缩进后 kind/parent 与 MD 缩进级 / BulletItem 一致；仅 `Op::Move` nest 测 ≠ 本切片。                          | **≠ EL-01**；≠ EL-06                      |
| **LR-14** | **A-BLK-07** 跨块预览；跨文档 **重生 id** | **9222** + 库内策略已交         | 跨块拖放有预览；跨文档落入目标后 **新 id ≠ 源 id**，源 id 不进目标树。                                           | **≠ EL-01**                               |
| **LR-15** | **A-SIL-03 / 04**（W6-A 静默项）          | **9222** 视觉                   | 合成 ≥ 可感路径时 chrome 不挡 IME 候选；滚动后 gutter/把手无幽灵。                                               | **≠ EL-02**（须 W3-C+本片+表 A）；≠ EL-01 |

**W6-A 收口（非切片 · 主控会计）**：LR-01…14 **全部** 表 B 真绿且 `A-BLK-progress` e2e 列可点 → 才允许把调度态标 **W6-A Strict**，并按 `08` §0.4 改表 A EL-01。**缺任一 10–14 = W6-A 未关。**

### 3.3 W6-B · IME L2（Win 必测 8 格分片）

文件域：**Playwright · WebView2 :9222**（真实 OS IME 或 CDP 合成事件；禁行级 `ime-composition.spec.ts` 改 ID 冒充）。库内契约已交，**禁止**把 `ime-matrix.contract` 绿灯写成 e2e。

| 切片 ID   | 断言（Win 必测）                             | 完成定义                                                                                                 | **≠**                                     |
| --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **LR-16** | **A-IME-01** 长句不丢字                      | 中/日/韩长句 compositionend **value 优先**；提交后纸面文本 = final；phase idle。矩阵该格 → `✅e2e`。     | ≠ W6-B 满；≠ 叶子核；≠ 关 mac/Linux 同 ID |
| **LR-17** | **A-IME-02** 合成中无 slash/结构键           | composing 中 `/` Enter Tab 不拆块/不开 slash；end 后放行。                                               | ≠ 关 A-BLK-02（LR-01 另证产品插入）       |
| **LR-18** | **A-IME-03** 合成中滚动 pin                  | 合成中滚动不卸焦点块；end 后文本+光标正确。                                                              | ≠ A-PERF-08 数值                          |
| **LR-19** | **A-IME-04** 点另一块                        | 策略 **`end_then_switch`**：先提交原块再切；无半角垃圾。                                                 | ≠ 关 A-SEL 全族                           |
| **LR-20** | **A-IME-05** 合成=一步撤销                   | 多次 update 仅 end 一条边界；产品 undo **一次**撤整句。                                                  | ≠ 关 A-BLK-01 / EL-04                     |
| **LR-21** | **A-IME-06** 远端/Agent 同块                 | 合成中暂缓或 end 后合并；**禁止**默认整页 remount。交叉 X-03，**不关**表 G 全族。                        | ≠ EL-05；≠ W5-D                           |
| **LR-22** | **A-IME-07** 输入会话 `fullRemountCount===0` | **产品键入会话**计数为 0（禁 mock Diff 关闭）。**前置 W3-P** 真 ProjectionDiff；W3-P 未绿 = 本片未交付。 | ≠ W6-C 数值；≠ 关 A-COL-03 满             |
| **LR-23** | **A-IME-08** 合成后 `# ` 转标题              | 合成刚结束再 `# ` → 标题正确。可与 LR-03 共用夹具，**不得**互相关 ID。                                   | ≠ A-BLK-09 单独关 W6-A                    |

| 切片 ID   | 范围                                | 文件域                                                                           | 完成定义                                | **≠**                        |
| --------- | ----------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------- |
| **LR-24** | macOS WK **必测**格                 | 该端 WebView e2e（本仓若无 mac runner：测未绿=未交付，**禁止**用 Win 绿勾 mac）  | `ime-matrix.md:33`：不可因 Win 绿勾 mac | ≠ W6-B 在 Win 未满时提前锁核 |
| **LR-25** | Linux 必测 01/02/07 + **L3 叶子核** | Linux e2e 或诚实「发布端不含 Linux」评审记录；L3 仅当 **目标发布端必测格全 e2e** | `ime-matrix.md:79-80`                   | ≠ 用「业界 PM 成熟」锁核     |

**W6-B 收口**：目标发布端必测格全 `✅e2e` + 真 PM（W3-D-PM 已交）→ 才可锁「叶子核=PM」。**≠ 关 EL-01。**

### 3.4 W6-C · 数值门（TBD≠通过）

文件域：指纹/回填 = **人工 + 库内打印**（`npm run perf:block-workspace`、`perf_open_nk_blocks` `#[ignore]`）；**TTI / 键入 / 滚动终值 = 9222 产品路径**。禁止 vitest 计数填表（`08:102`）。禁止脚本改 TBD。

| 切片 ID   | 维度                                       | 文件域                                   | 完成定义                                                                                                       | **≠**                                  |
| --------- | ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **LR-26** | 机器指纹 + `perf_baseline_rev`             | 文档 + 本机                              | §1 指纹填齐；数值写入时登记 SHA；指纹/阈值变则 **bump rev**。未填齐 → 数值门不生效。                           | ≠ 关 EL-03；≠ 把 TBD 改假数            |
| **LR-27** | **A-PERF-01** 打开 1k / 10k / **100k** TTI | **9222** 主；`open_nk_blocks` 仅代理备忘 | 三档 p50/p95 **手写**入 §3.1；DOM ≤ 窗口上界；热 YText ≤ 512。缺 100k = 维度未交（EL-10 禁删维）。             | ≠ EL-03（须结构 W3-A + 本族满 + 表 A） |
| **LR-28** | **A-PERF-03** 键入 / IME 延迟              | **9222**                                 | 稳态拉丁 + IME 抽样 p50/p95 手写入 §3.2；伴随 `fullRemountCount===0`。                                         | ≠ 关 W6-B                              |
| **LR-29** | **A-PERF-02 / 08** 滚动 jank               | **9222**                                 | longtask 或 rAF p95；注明采集脚本；合成中滚动 pin 不丢。`heightmap_query` ≠ 本行终值。                         | ≠ 关 A-IME-03                          |
| **LR-30** | **A-PERF-04…07,09…11**                     | 9222 或已声明层                          | 大纲跳转 / N 远端选 / Agent 千次 UI / 内存 / 写放大字节 / 搜索数值 / 附件。W2-C/W2-D **结构**已交 ≠ 本行数值。 | ≠ 删维；≠ 关 EL-03 单行                |
| **LR-31** | S-SNAP / S-MERGE 接线测                    | **库内**（可加 9222 旁证）               | `perf-baseline.md:78-79` 两项有可红测再勾；每键非全量 snapshot；merge 不在 UI 主线程。                         | ≠ 单独关 EL-03                         |

**W6-C 收口**：指纹 + §3 初值手写 + 结构门（含 LR-31）+ CI 可对比。**TBD 残留 = 未通过。** DEG-01 仅标定后生效。

### 3.5 W6-D · A-COL 满语义

文件域：**库内**为主（双 `DocSession` / harness）；A-COL-02/03 产品会话可加 **9222**。JSON 重放 ≠ 终局。

| 切片 ID   | 断言                                         | 文件域                   | 完成定义                                                                                                                                   | **≠**                                |
| --------- | -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| **LR-32** | **A-COL-01** 双 peer 满 + 状态哈希           | **库内**                 | 并发击键/改 prop/移动 → 最终一致；哈希可复算；**退出 JSON 重放终局**。W6-D-S 子集 ≠ 本片。                                                 | **≠ EL-04**（须 +G-HYD +W1-F +表 A） |
| **LR-33** | **A-COL-02** merge 非 UI 主线程              | 库内线程归属 + 可选 9222 | 可观测边界：完整权威合并不在 UI 线程。与 LR-31 可共享测，**不得**一轮勾两个关闭叙事。                                                      | ≠ EL-03                              |
| **LR-34** | **A-COL-03** 禁默认 forceReload              | 库内 + 产品会话          | 默认路径无整树全量 remount；灾难 `fullRebuild` 可数。                                                                                      | ≠ 关 A-IME-07                        |
| **LR-35** | **A-COL-05** 杀进程 + 上线收敛               | **库内** 集成            | 断网 commit → 杀进程 → hydrate ≡；outbox 或已评审改 08 映射。前置 G-HYD / 02 维。                                                          | ≠ 单独关 EL-04                       |
| **LR-36** | **A-COL-06** 并发 move/删祖先                | **库内**                 | 规则文档 + 双端一致 + **永不**持久化环。属性测加深至「满语义」清单，非仅 50 seed 烟雾。                                                    | ≠ W6-D-S                             |
| **LR-37** | **A-COL-07**（可选）+ **08** + A-INV-08 退出 | **库内**                 | 07：若做 Yjs 互通则文本收敛、块树仍 RS；不做须文档声明「未启用」**不得删 ID**。08：销毁重开仅 RS hydrate。脚手架退出条件 = A-COL-01 绿灯。 | ≠ EL-04 单片                         |

### 3.6 W6-E · 千次批 + 恶意扩展

文件域：**库内** persist 真后端（StoreNoteBackend / 真 apply）；A-AGT-04 **9222**。Memory 仅回归夹具。

| 切片 ID   | 断言                            | 文件域                       | 完成定义                                                                                                                                                    | **≠**                            |
| --------- | ------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **LR-38** | **A-AGT-01 / 02** 千次批原子    | **库内** 真 persist          | 1000 insert/update/move 全有或全无可回放；第 500 非法 → 整批回滚、编码态不变。W6-E-S Memory dryRun ≠ 本片。                                                 | **≠ EL-05**                      |
| **LR-39** | **A-AGT-03** 击键并发           | 库内 + 可选 9222             | origin=agent 可审计；与用户击键不撕裂。交叉 X-02，不关表 G。                                                                                                | ≠ EL-05                          |
| **LR-40** | 恶意扩展零持久化 + **A-AGT-04** | **库内** 拒写 + **9222** DOM | 夹带写句柄 / `innerHTML` → 拒；版本/op 日志不增；后端零写。骨架 2 层扫描 ≠ 生产门。                                                                         | **≠ EL-07**（须 W4-C+本片+表 A） |
| **LR-41** | **A-AGT-05…08** 相对 W4-F 余量  | **库内**                     | dryRun 零写 + batchId 幂等（真 persist）；表驱动 Deny；`execution_unknown` 禁自动重试写；update≠append 诊断。W4-F 已交项列清单 **免重做**，只补生产闭环测。 | ≠ W4-F 重开；≠ EL-05 单片        |

---

## 4. 建议实施序（逻辑依赖 · 不谈工期）

问题同权：下表「轮」= **依赖层 / 派单批次**，不是 P0 砍项。未列入的 LR 不得删除。

```
CONN-01 载体:9222     W3-D/F/G/H/E 库侧已交      G-HYD / 真打开（01 维）
        │                      │                         │
        └──────────┬───────────┴────────────┬────────────┘
                   ▼                        ▼
        R1  LR-01/02/03  (02/08/09)    W3-P 真 Diff ──► R7 LR-22 (A-IME-07)
                   │
                   ▼
        R2  LR-04/05     (10 / 11)     W2-F 物化已交，只补跳转/占位 UI
                   │
                   ▼
        R3  LR-06/07/08  (12 / 13 / 14)
                   │
                   ▼
        R4  LR-09…14     (01, 03–07)   与 R1 chrome 同 9222 夹具
                   │
                   ▼
        R5  LR-15        (A-SIL-03/04)
                   │
                   ├──────────────────► R6–R8  W6-B L2 → L3
                   │
W6-C-S 结构骨架 ──► R9 指纹/S-SNAP ──► R10–R11 数值（要窗口化产品路径）
W1-F + G-HYD    ──► R12–R13 W6-D
W4-B/F + persist ─► R14 W6-E
```

### 建议轮次切片表（10–14 轮 · 派单用）

| 轮      | 切片                    | 断言焦点               | 文件域                | 本轮 **禁止**                         |
| ------- | ----------------------- | ---------------------- | --------------------- | ------------------------------------- |
| **R1**  | LR-01, LR-02, LR-03     | **A-BLK-02 / 08 / 09** | 9222                  | 关 EL-01；用 simulate/mock sink 关 09 |
| **R2**  | **LR-04, LR-05**        | **A-BLK-10 / 11**      | 9222 + 库内 10 专名   | 用 W2-F 物化冒充跳转；省略 10         |
| **R3**  | **LR-06, LR-07, LR-08** | **A-BLK-12 / 13 / 14** | 库内 12 专名 + 9222   | A-SURF 顶替 12；textarea 当 14        |
| **R4**  | LR-09…14                | A-BLK-01, 03–07        | 9222                  | 把 03–07 再收成「视觉以后」           |
| **R5**  | LR-15                   | A-SIL-03/04            | 9222 视觉             | 关 EL-02（缺 W3-C+表 A）              |
| **R6**  | LR-16…20                | A-IME-01…05 Win 必测   | 9222 真 IME           | 行级 spec 改名冒充；勾 mac            |
| **R7**  | LR-21…23                | A-IME-06…08 Win        | 9222；07 依赖 W3-P    | mock Diff 关 07；09 与 08 互关        |
| **R8**  | LR-24, LR-25            | 他端必测 + L3          | 分端 e2e              | Win 绿勾全矩阵；业界 PM 锁核          |
| **R9**  | LR-26, LR-31            | 指纹 + S-SNAP/S-MERGE  | 文档 + 库内           | 自动改 TBD                            |
| **R10** | LR-27…29                | TTI / 键入 / 滚动      | **9222** 终值         | HeightMap 代理当 TTI/jank             |
| **R11** | LR-30                   | A-PERF-04…11 数值      | 9222 / 声明层         | 删维；结构门当数值                    |
| **R12** | LR-32…34                | A-COL-01…03            | 库内                  | JSON 重放当 01 满；关 EL-04           |
| **R13** | LR-35…37                | A-COL-05/06/07/08      | 库内                  | 无 outbox 假关 05                     |
| **R14** | LR-38…41                | 千次 + 恶意 + A-AGT 余 | 真 persist + 9222 DOM | Memory 关 EL-05/07                    |

**并行边（同轮不同文件域可并行，同文件串行）**：

| 可并行        | 条件                                                          |
| ------------- | ------------------------------------------------------------- |
| R1–R3 内各 LR | spec 文件不重叠；`playwright.config.ts` 串行改                |
| R6 与 R4      | 均 9222，须分 spec、分工人数 1（现 config `workers: 1`）      |
| R9 与 R12     | 文档/collab vs perf 文档；`perf-baseline.md` 仅 R9/R10/R11 写 |
| R14 与 R10    | agent-tools vs editor-kit；X-02 交叉只记账不互关              |

**不可并行**：改同一 `imeMatrix.ts` 状态格（R6–R8 串行或按 ID 分段）；`perf-baseline.md` 数值回填（R9→R11 单写者）；表 A（仅主控收口）。

---

## 5. 夹具与门禁（实现时）

```text
# 载体（所有 9222 切片前置）
npm run dev:workbench          # WebView2 --remote-debugging-port=9222
# 禁止：只开 http://localhost:5174 当验收

# 跑 WebView 矩阵（config 放宽后）
npx playwright test --config tests/e2e/webview/playwright.config.ts

# 库内抽样（已交，回归勿红）
cargo test -p conex-doc-collab a_blk
cargo test -p conex-doc-collab w6_a_s
cargo test -p conex-doc-collab --test w6_d_s_a_col_subset
npx vitest run packages/editor-kit packages/block-paper -t IME
npx vitest run packages/editor-kit/src/viewport/perf-baseline.contract.test.ts

# 数值打印（禁止写回 TBD）
npm run perf:block-workspace
```

行级 `tests/e2e/ime-composition.spec.ts` / `markdown-editor` 专项 **禁止删除**（测试资产铁律）；**禁止**改断言 ID 去关 W6-B。

---

## 6. 给主控

### 6.1 覆盖

- W6-A…E 相对可上线的 **可证伪切片** LR-01…41。
- **A-BLK-02 / 08 / 09** 与 **10 / 11 / 12 / 13 / 14** 各独立行（§3.1）；01、03–07、SIL 同权（§3.2）。
- W6-B Win 必测 8 格分片 + 他端/L3。
- W6-C 指纹 / TTI / 键入 / 滚动 / 余维 / 结构接线；钉死 TBD≠通过。
- W6-D / W6-E 满语义与生产闭环；钉死 `-S` / Memory 禁关。
- 14 轮派单表；单切片禁关表 A。

### 6.2 未覆盖（他维 / 前置）

| 项                                        | 应交谁                                                   |
| ----------------------------------------- | -------------------------------------------------------- |
| G-HYD 产品句 / 真打开 / 链 A hydrate      | **01**                                                   |
| 视觉设计 / 空态 / 焦点美学                | **02**                                                   |
| 七链半通 / IPC / 真 hydrate 默认          | **03**                                                   |
| 工具审批持久化 / X-05 / 沙箱 TrustGate 满 | **05**（与 LR-40 交界：本维只要零持久化测，不要重做 F3） |
| W3-P WindowManager 满窗                   | 官方 **W3-P**（LR-22 前置，本文不盗号关闭）              |
| outbox 表                                 | **02**（LR-35 前置）                                     |
| A-SEL / A-MD / A-EXT 全表                 | 非本维关闭包                                             |

### 6.3 额外发现

1. **`ime-matrix.md` §1 与代码漂移**：`imeMatrix.ts` / contract 已将 **A-IME-06** 标 🟨automated；文档表仍 ☐。L2 动矩阵前应回写文档，**仍不得**标 e2e。
2. **A-BLK-12 vs 默认 textarea**：`CodeLeafHost.ts:34` 默认 `DomCodeLeafHost`（textarea）。12/14 若不先改产品默认，9222 必红——这是实现债，不是删维理由。
3. **05:185 缩写「06…14」** 是历史漏表根；实现波进度必须按 14 行 e2e 列更新 `A-BLK-progress`，禁止再合并 10–14。
4. **9222 config 过窄**：不改 `testMatch` 则所有 W6 e2e 无法进独立 project；改 config ≠ 关 EL。
5. **A-IME-07 实堵在 W3-P**（`19` PaperList ≠ W3-P）。派 LR-22 前须有 W3-P 或诚实挡「输入会话未矩阵」。
6. **100k TTI** 依赖窗口化产品路径（W3-G 结构已交）；用 `open_nk_blocks` 填 §3.1 是会计事故。
7. EL-02 关闭不得早于 W3-C **且** LR-10/15；本维切片不能单独改表 A EL-02。

---

_2026-08-13 · 方案位 04 · Wave6 e2e/IME/PERF · 切片 LR-01…41 · 官方关闭包仍为 W6-A/B/C/D/E · 表 A 全未关_
