# 01 · CONN-00 硬门护栏 + CONN-05 D×G2′ 抽检（执行轮 1 单元）

| 元数据     | 值                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **角色**   | 2026-08-13-wave 修复战役 · 轮 1 · 单元 CONN-00 + CONN-05（只读 + 只写本文档；禁改业务代码 / 禁 git 操作 / 禁派生子 Agent）                  |
| **输入**   | `plans/D-07-维度详案-连通余量.md`（§1.1 CONN-00 任务卡 + §2 清单形态）· `plans/acceptance/EL-dashboard.md`（表 A 0/10 保持）· 源码/测试实测 |
| **执行序** | A（硬门清单落盘）→ B（D×G2′ 抽检）→ 本文档                                                                                                  |
| **口径**   | 本单元**只落盘护栏清单 + 只读核验**；EL-dashboard.md 的写入由 CONN-06 承担（同文件串行：CONN-00 先行）                                      |
| **未做**   | 未改业务代码；未写 EL-dashboard.md；未 git 写操作（git log 为只读）；未真跑任何 vitest/cargo/playwright；未关任何 EL                        |

---

## 0. not-claimed 锚点现状（任务 A 前置实测，写进清单头部）

**任务要求先真跑**：`rg -n "not-claimed" docs/block-workspace-architecture/plans/acceptance/`

**实测结果：0 命中**——acceptance 目录内**无** not-claimed 文本；锚点全部位于前端源码与测文件。因此机器可核验断言的目标路径是 `apps/crish-desktop/src`（含子包），**不是** acceptance 目录。锚点全量实测（`rg -n "not-claimed" apps/crish-desktop/src --glob "*.{tsx,ts}"`，共 35 行命中）：

| 类型   | 位置                                                                                                                                                                                                                                                                                               | 锚                                   | 值                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------ |
| 生产锚 | `apps/crish-desktop/src/components/workspace/workspaceEmptyStatePaperEntry.tsx:51-52`                                                                                                                                                                                                              | `data-el01` / `data-w3p-full`        | `'not-claimed'`    |
| 生产锚 | `apps/crish-desktop/src/components/workspace/workspaceEmptyStateMirrorSlot.ts:22-23`                                                                                                                                                                                                               | `data-el03` / `data-inotify-full`    | `'not-claimed'`    |
| 生产锚 | `apps/crish-desktop/src/components/note-paper/MirrorDriftStatusBar.tsx:145-146`                                                                                                                                                                                                                    | `data-el03` / `data-inotify-full`    | `'not-claimed'`    |
| 测断言 | `MirrorDriftStatusBar.test.tsx:31-32` / `Workspace.conn-e2-prime.test.tsx:47-48/:64-65/:109-110` / `WorkspaceEmptyState.conn-e2.test.tsx:36-37/:83-84/:199-200` / `WorkspaceEmptyState.conn-e3.test.tsx:37-38/:82-83/:106-107` / `WorkspaceEmptyState.conn-c2.test.tsx:33-34/:46-47/:66-67/:96-97` | el01/el03/w3p-full/inotify-full 断言 | 保持 `not-claimed` |

**结论**：6 处生产锚（3 文件）+ 29 处测断言行全部存在、值均为 `'not-claimed'`，无任何改写迹象。

---

## 1. 任务 A · R-EL 硬门机器可核验清单（7 条红硬门）

> 每门含：诱惑面 / 否决断言形态（可直接 grep 执行）/ 实测结果。实现轮验收口径：**任一条否决断言 FAIL → 该轮不可宣称对应硬门未被抬**；「绿 = 测名可点 + 锚存在」≠ CI 绿灯。

### 1.1 R-E2P-EL（E2′ 默装绿易抬 EL-03 / inotify 满关 / 默认可 detect 满关）

| 项         | 内容                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 否决断言 1 | `rg -n "data-el03.*not-claimed                                                                                                                                                | data-inotify-full.*not-claimed" apps/crish-desktop/src/components/workspace/workspaceEmptyStateMirrorSlot.ts` → 必须命中 :22-23（**实测 ✅**）                                     |
| 否决断言 2 | `rg -n "data-el03.*not-claimed                                                                                                                                                | data-inotify-full.*not-claimed" apps/crish-desktop/src/components/note-paper/MirrorDriftStatusBar.tsx` → 必须命中 :145-146（**实测 ✅**）                                          |
| 否决断言 3 | `rg -n "≠ EL-03                                                                                                                                                               | ≠ inotify" apps/crish-desktop/src/components/workspace/Workspace.conn-e2-prime.test.tsx` → 命中测头 :9「≠ EL-03 · ≠ inotify 满关 · ≠ 重做 E3 · ≠ 默认双开 poll+OS」（**实测 ✅**） |
| 禁抬       | `conn_e2p_*`（:35/:58/:69）**禁止**被当作 EL-03 关 / inotify 满关 / 默认可 detect 满关的证据；`data-mirror-detect-policy=1`（测断言 :46/:87/:101）只是宿主默装探针 ≠ EL-03 关 |
| 诚实句     | ≠ EL-03 · ≠ inotify 满关 · ≠ 默认可 detect 满关（E2′ 只改产品宿主，EmptyState 默认仍关）                                                                                      |

### 1.2 R-B3-EL（B3 IPC+默装 + Overlay 绿易抬 EL-01 / 产品 e2e 满关）

| 项         | 内容                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 否决断言 1 | `rg -n "≠ EL-01" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-b3.test.tsx` → 命中测头 :9「无 Tauri 仍默认 readonly（禁止 mock 生产默认）；**≠ EL-01**」（**实测 ✅**） |
| 否决断言 2 | `rg -n "禁止 mock 生产默认" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-b3.test.tsx` → 命中（**实测 ✅** :9）                                                         |
| 否决断言 3 | `rg -n "conn_b3_product_empty_default_no_tauri_readonly_via_resolve" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-b3.test.tsx` → 命中（**实测 ✅** :152）              |
| 禁抬       | `conn_b3_*`（:152/:165）**禁止**被当作 EL-01 关 / 产品 slash e2e 满关的证据；mock IPC 绿 ≠ 生产默认可写叙事                                                                                    |
| 诚实句     | ≠ EL-01 · ≠ 打开完成 · ≠ A-BLK e2e（B3 写锥链路既有完成不因 e2e 新增而回退）                                                                                                                   |

### 1.3 R-D3-EL（D3 叶键入 + W6-A-S `a_blk_08` 易抬 A-BLK-08/09 e2e / EL-01）

| 项         | 内容                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 否决断言 1 | `rg -n "W6_A_S_NOT_CLOSING" crates/conex-doc-collab/src/w6_a_s.rs` → 命中 :48（**实测 ✅**）；`rg -n "W6_A_S_PACKAGE_ID" crates/conex-doc-collab/src/w6_a_s.rs` → `pub const W6_A_S_PACKAGE_ID: &str = "W6-A-S"` :29（**实测 ✅**）；`tests/a_blk_contract.rs:36-38` 断言 `== "W6-A-S"` 且 `ends_with("-S")`（**实测 ✅**） |
| 否决断言 2 | `rg -n "≠ EL-01                                                                                                                                                                                                                                                                                                             | ≠ A-BLK" packages/block-paper/src/chrome/chrome.a_blk.test.ts` → 测头 :4「**≠ 关闭 EL-01 / A-BLK 全表 / 块工作区完成**」+ :15「禁止用本文件关 **W6-A** / **EL-01**」（**实测 ✅**）；`packages/block-paper/src/leaves/w3h.direction.test.ts:10-12`「≠ A-BLK 全表 e2e / ≠ EL-01 / ≠ 桌面 PM/HiddenInput 键入全链」（**实测 ✅**） |
| 否决断言 3 | `rg -n "pending" apps/crish-desktop/src/components/note-paper/StrictContentRowLeaf.test.tsx` → 测头 :5-11「可宣称/禁止宣称」表（「pending = 真 kind UI」列入**禁止宣称** :8）（**实测 ✅**）；`noteMdPrefixBridge.test.ts:397`「UI 不得把 pending 当 kind（本测不关 EL-01）」（**实测 ✅**）                                |
| 禁抬       | `a_blk_08_*`（`chrome.a_blk.test.ts:230-253` 2 测 + `w3h.direction.test.ts:168` `w3h_a_blk_08_selection_clamp`）**禁止**被当作 A-BLK-08/09 e2e 关 / EL-01 的证据；去 `-S` 冒充 Strict（W6-A-S 包 ID 断言不删）                                                                                                              |
| 诚实句     | ≠ A-BLK e2e（A-BLK-08/09 仍黄）· ≠ EL-01 · ≠ 打开完成（叶键入单测 ≠ 真 PM View HiddenInput 全链）                                                                                                                                                                                                                           |

### 1.4 R-E2-EL（E2/E3/E2′ opt-in + 默装绿易抬 EL-03 / inotify 满关）

| 项         | 内容                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| 否决断言 1 | `rg -n "data-el03.*not-claimed                                                                               | data-inotify-full.*not-claimed" apps/crish-desktop/src/components/note-paper/MirrorDriftStatusBar.tsx` → 命中 :145-146（**实测 ✅**）                                                                                                               |
| 否决断言 2 | `rg -n "≠ EL-03                                                                                              | ≠ inotify" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-e2.test.tsx apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-e3.test.tsx` → 命中两测头（**实测 ✅**：e3 :9「**≠ EL-03**；**≠ inotify 满关**」） |
| 禁抬       | `conn_e2_*` / `conn_e3_*` / `conn_e2p_*` **禁止**被当作 EL-03 关 / inotify 满关 / 默认自动 detect 满关的证据 |
| 诚实句     | ≠ EL-03 · ≠ inotify 满关（E2 会计已完成 ≠ EL 关；opt-in + 默装 ≠ 默认自动 detect）                           |

### 1.5 R-G2-EL（G2 总线 + G2-int 一体绿易抬 EL-01/08 / 打开完成）

| 项         | 内容                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 否决断言 1 | `rg -n "≠ EL-08                                                                                                                                                          | ≠ EL-01                                                                                                                                                                                                                                           | ≠ 打开完成" apps/crish-desktop/src/components/note-paper/conn-g2.product-apply-strict-refresh.test.tsx` → 命中测头 :12「**≠ EL-08**；**≠ EL-01**；**≠ 打开完成**」（**实测 ✅**） |
| 否决断言 2 | `rg -n "conn_dg2_same_doc_product_apply_refreshes_strict_kind                                                                                                            | conn_dg2_other_doc_does_not_refresh_kind" apps/crish-desktop/src/components/note-paper/conn-dg2.product-apply-kind-refresh.test.tsx` → 命中 :160/:217（**实测 ✅**）；测头 :12「**≠ EL-08**；**≠ EL-01**；**≠ A-BLK-08/09 e2e**；**≠ 打开完成**」 |
| 禁抬       | `conn_g2_same_doc_*` / `conn_dg2_*` / `conn_g2_*`（bridges 7 测 :48-193）**禁止**被当作 EL-01/08 关 / 打开完成 / inotify 满关的证据；G2-int Memory 物质化夹具 ≠ 真 apply |
| 诚实句     | ≠ EL-08 · ≠ EL-01 · ≠ 打开完成 · ≠ inotify 满关（物质化 = 测夹具，**不是** DocSession::apply / 真打开）                                                                  |

### 1.6 R-E3-EL（E3 opt-in 调度绿易抬 EL-03 / 默认自动 detect / inotify）

| 项         | 内容                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 否决断言 1 | `rg -n "enableMirrorDetectSchedule = false" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.tsx` → 命中默认关钉 :195（**实测 ✅**；:177 头注释「默认关钉死」）            |
| 否决断言 2 | `rg -n "conn_e3_product_empty_default_no_detect_schedule" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-e3.test.tsx` → 命中 :27（**实测 ✅**；:59/:120/:130 组在） |
| 否决断言 3 | `rg -n "≠ EL-03                                                                                                                                                                           | ≠ inotify" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-e3.test.tsx` → 命中测头 :9（**实测 ✅**） |
| 禁抬       | `conn_e3_*` **禁止**被当作 EL-03 关 / 默认自动 detect / inotify 满关的证据                                                                                                                |
| 诚实句     | ≠ EL-03 · ≠ inotify 满关 · ≠ 默认自动 detect（调度默认关，E2′ 只改产品宿主）                                                                                                              |

### 1.7 R-C2-EL（C2 `conn_c2_*` 绿 + opt-in 可挂 list 易抬 EL-01 / W3-P 满窗）

| 项         | 内容                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 否决断言 1 | `rg -n "data-el01.*not-claimed                                                                                                  | data-w3p-full.*not-claimed" apps/crish-desktop/src/components/workspace/workspaceEmptyStatePaperEntry.tsx` → 命中 :51-52（**实测 ✅**）                                 |
| 否决断言 2 | `rg -n "≠ EL-01                                                                                                                 | ≠ W3-P" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-c2.test.tsx` → 命中测头 :11「**≠ EL-01**；**≠ W3-P 满窗**；禁默认真双内容」（**实测 ✅**） |
| 否决断言 3 | `rg -n "conn_c2_default_no_paper_list                                                                                           | conn_c2_opt_in_paper_list_mutex" apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.conn-c2.test.tsx` → 命中 :28/:61（**实测 ✅**）                        |
| 禁抬       | `conn_c2_*` **禁止**被当作 EL-01 关 / W3-P 满窗的证据；C2 会计已完成 ≠ 关 EL；产品默开须新 ID（CONN-02），不得以「默开」补完 C2 |
| 诚实句     | ≠ EL-01 · ≠ W3-P（满窗/真 Diff/awareness）· 默开 ≠ PaperList 完成（组件默认 `enableProductPaperList=false` 保持，:197 实测 ✅） |

---

## 2. 禁抬测名清单（机器可 grep 白名单=禁止证据链）

| 测名族                                                                       | 所在文件（实测）                                                                                                                | 可证明的**仅**                      | 禁止抬成                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `conn_e2p_*`                                                                 | `Workspace.conn-e2-prime.test.tsx:35/:58/:69`                                                                                   | E2′ 产品宿主默装形态                | **EL-03 关 / inotify 满关 / 默认可 detect 满关** |
| `conn_g2_*`                                                                  | `conn-g2.product-apply-strict-refresh.test.tsx:132/:170/:206` + `bridges/conn-g2.product-apply-note-doc-written.test.ts:48-193` | G2 总线 notify 形状 / 写后读回投影  | **EL-01/08 关 / 打开完成 / inotify 满关**        |
| `conn_c2_*`                                                                  | `WorkspaceEmptyState.conn-c2.test.tsx:28/:61`                                                                                   | C2 会计（组件默认关 + opt-in 互斥） | **EL-01 关 / W3-P 满窗 / PaperList 完成**        |
| `a_blk_08_*`                                                                 | `chrome.a_blk.test.ts:230-253` + `w3h.direction.test.ts:168`                                                                    | A-BLK-08「方向/形状」抽样（W6-A-S） | **A-BLK-08/09 e2e 关 / EL-01 关 / W6-A Strict**  |
| （附属）`conn_dg2_*` / `conn_b3_*` / `conn_d3_*` / `conn_e2_*` / `conn_e3_*` | 见 §1 各门                                                                                                                      | 各自分轨形状                        | 对应门列出的 EL 关 / e2e 满关                    |

实现轮验收否决：**任一验收报告以「测数 / 测名绿 / 可演示」充当上述 EL 关闭证据 → 该轮 FAIL**。

---

## 3. 全局禁词断言（全仓前端测）

| #   | 命令（机器可执行）                                                                                                                                 | 期望                                      | 实测                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `rg -n "closes? EL-" apps/crish-desktop/src packages --glob "*.test.*"`                                                                            | 零命中                                    | ✅ 零命中（exit 1）                                                                                                           |
| 2   | `rg -n "closes? EL-" . -g "!node_modules" -g "!target" -g "!dist" -g "!.git" -g "!.agent-outputs"`                                                 | 源码/测试零命中                           | ✅ 仅 3 命中，全部在 `docs/review-md-audit/2026-08-13-wave/plans/`（D-07:43/:131、06:77，即本纪律文本自身）；代码与测试零命中 |
| 3   | `rg -P -n '^(?![\s\S]*?(≠\|不\|禁\|未\|才\|非\|不得\|声明\|仅\|绿))[\s\S]*?关(闭)?? ?EL-0[0-9]' apps/crish-desktop/src packages --glob "*.test.*"` | 零命中（**正向自称关 EL 否决**）          | ✅ 零命中（exit 1）                                                                                                           |
| 4   | 原始宽模式 `rg -n "关(闭)?? ?EL-0[0-9]" apps/crish-desktop/src packages --glob "*.test.*"`                                                         | 命中允许存在，但**每条必须含否定/诚实词** | 9 命中，逐条核验**全部**为诚实/否定句（详见 §3.1 基线清单）；新命中行不含否定词 → FAIL                                        |
| 5   | `rg -c "未关闭" docs/block-workspace-architecture/plans/acceptance/EL-dashboard.md`                                                                | ≥ 10                                      | ✅ 16（表 A 10 行全「未关闭」+ 元数据/页脚提及；本单元只读未改）                                                              |

### 3.1 宽模式 9 命中基线清单（全部为诚实句，2026-08-13 实测逐条核验）

| 文件:行                                | 原文（否定词高亮）                                               | 性质         |
| -------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `dual-engine-stream.surf.test.ts:14`   | 非端到端 daemon SSE、**非关** EL-08 **声明**                     | 诚实句       |
| `dual-engine-stream.surf.test.ts:628`  | 最低集 1–8 全绿**才可关** EL-08；本文件**仅**交付 04/05 计数探针 | 条件句（仅） |
| `chrome.a_blk.test.ts:4`               | **≠ 关闭** EL-01 / A-BLK 全表 / 块工作区完成                     | 诚实句       |
| `chrome.a_blk.test.ts:61`              | 本文件**不得**被解释为关闭 EL-01 / W6-A Strict                   | 诚实句       |
| `hydrateProjection.test.ts:192`        | **禁止**用本测宣称关 EL-01/04/08 或打开完成                      | 诚实句       |
| `NotePaperStrictPanel.test.tsx:310`    | 本测绿 **≠ 关** EL-01/04/08                                      | 诚实句       |
| `noteMdPrefixBridge.test.ts:397`       | 本测**不关** EL-01                                               | 诚实句       |
| `WorkspaceEmptyState.w5bs.test.tsx:60` | **禁止假关** EL-01                                               | 诚实句       |
| `WorkspaceEmptyState.w5b.test.tsx:171` | 本测绿 **≠ 关** EL-01/04/08                                      | 诚实句       |

---

## 4. 诚实边界句模板（所有实现轮验收报告落点必须保留）

```
**≠ EL-01…10**（表 A 全未关闭，保持 0/10）
**≠ 打开完成**（G-HYD 全条件未合）
**≠ inotify 满关**
**≠ A-BLK e2e**（A-BLK-08/09 仍黄；a_blk_08_* / w3h 仅「方向/形状」抽样，W6-A-S 带 -S）
可演示 ≠ EL；测数/测名绿 ≠ 关闭证据；清单状态「已验·绿」≠ 该行关闭
```

---

## 5. 任务 B · CONN-05 D×G2′ 回退抽检结论

### 5.1 核验（已完成部分，仅只读）

| 项                         | 结果（实测）                                                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试文件存在               | ✅ `apps/crish-desktop/src/components/note-paper/conn-dg2.product-apply-kind-refresh.test.tsx`（267 行）                                                                                                                                                 |
| 文件 git 日志              | `d0822a56 test(block-workspace): A-MD list_nested_table + CONN-DG2 kind refresh`（最近 3 条内唯一相关）                                                                                                                                                  |
| **提交号差异（如实记录）** | D-07 §1.6 转引 `c323c839`（"SD-42/43/44 split plus CONN-DxG2 leaf flavour"）；本单元实测文件最新提交为 **`d0822a56`**。两者可能同链（`c323c839` 为祖先提交），但本单元**仅记录实测值，不假设**；若收口轮需精确追溯请以 `git log --follow -- <file>` 为准 |
| 19 状态                    | ✅ `19-实现波调度状态.md:62`「T=16 post-sd27-35 · … · CONN-D×G2′ · 纸面 CSS；① 00–07；**≠ 关 EL**」；:237 禁整包列表含 **D×G2′**                                                                                                                         |
| 19 文档日志                | `6c0daf9d`（最新）→ `14c6ec01` → `2d25b16d`（refresh/fill/audit 链，均为 docs-only）                                                                                                                                                                     |

### 5.2 抽检断言（形状核验；**未真跑测试**）

| #   | 断言                                                                                                           | 实测                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 测名可点：`conn_dg2_same_doc_product_apply_refreshes_strict_kind` / `conn_dg2_other_doc_does_not_refresh_kind` | ✅ :160 / :217                                                                                                                                                                                                                                                                                          |
| 2   | pending≠kind 纪律钉：`bullet` ≠ `heading` **显式断言**                                                         | ✅ :45-46（`NEW_KIND='heading'` / `PENDING_AS_KIND='bullet'`）、:192 `expect(NEW_KIND).not.toBe(PENDING_AS_KIND)`、:200-203（`data-flavour`/`data-from-flavour` 断言 `NEW_KIND` 且 `not` `PENDING_AS_KIND`）、:8 头注释「**不是** `pending_turn_into_flavour` 当 kind」、:23「物质化 **不读** pending」 |
| 3   | 测头诚实句                                                                                                     | ✅ :12「**≠ EL-08**；**≠ EL-01**；**≠ A-BLK-08/09 e2e**；**≠ 打开完成**」                                                                                                                                                                                                                               |
| 4   | flavour 权威 = 投影数据                                                                                        | ✅ :200-203 断言行 + :175/:210 `flavourInPanel(...).toBeNull()` 对照                                                                                                                                                                                                                                    |
| 5   | 异 doc 不误刷                                                                                                  | ✅ :217 测名 + :260 `flavourInPanel(NEW_KIND).toBeNull()`                                                                                                                                                                                                                                               |

### 5.3 未覆盖缺口（如实登记，按 00 裁决 15 不补做）

- 入口为 applyOps 直调而非「叶 `# ` 键入」；叶键入→sink 前半链由 `conn_d3_*`（`StrictContentRowLeaf.test.tsx:47-289` 共 9 测 + `WorkspaceEmptyState.conn-d2.test.tsx:88-89`）覆盖；
- 「`#`→IPC→flavour」全链真 WebView e2e 仍缺（记为可选远后余量，属 CONN-03/04/01 载体域）。

### 5.4 未真跑声明（抽检 = 形状核验）

本单元**未执行** `npx vitest run conn-dg2.product-apply-kind-refresh.test.tsx`；上述「绿」均为「测名可点 + 源码形状」，**≠ CI 绿灯**。真跑留给 CONN-06 或收口轮（按 00 裁决 15 降级口径：先核验后降级，不重做整包）。

---

## 6. 诚实边界声明（本单元）

- **≠ EL-01…10**：表 A 全未关闭，保持 0/10；本单元未写 EL-dashboard.md，未产生任何 EL 关闭行。
- **≠ 打开完成**：G-HYD 全条件未合；本单元只交纪律落账，不交功能。
- **≠ inotify 满关**；**≠ A-BLK e2e**（A-BLK-08/09 仍黄）。
- **实测 vs 转引**：§0/§1/§2/§3 全部为本次会话直跑命令或直读文件（read/rg）；唯一转引未复核 = D-07 提及的 `c323c839` 提交号（本单元实测为 `d0822a56`，见 §5.1）。
- **未做**：未改业务代码；未 git 写操作（仅只读 git log / rg）；未派生子 Agent；未真跑测试/门禁脚本；未删改 EL-dashboard.md 现有内容。

---

_2026-08-13 · 2026-08-13-wave 轮 1 执行单元 CONN-00+CONN-05 · 只写本文件 · 未改业务代码 · 无 git 写操作 · 未派生子 Agent · 未关任何 EL-01…10_
