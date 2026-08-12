# R2 轮次销号报告 v2（两段式）

> 产出：`docs/frontend-audit/60-repair2/40-final-plan/90-final-report-r2.md`
> 角色：销号报告子 Agent（只读 + 本报告产出，无代码改动）
> 输入：`00-master-plan.md`（§2 批次编排 / §3 冲突裁决 / §6 执行状态）、`20-proposals/01~04`（四份维度方案）、`30-reviews/01~02`（双评审）、`50-reverify/01~03`（三份复审）、R2-1~R2-8 实际提交
> 依据：P0-4 裁决——销号清单改两段式（① 修复销号逐项对应批次；② 登记/保留销号逐项给终态），与总方案 §0 覆盖核对表一一对应
> 日期：2026-08-12。编码：UTF-8 无 BOM，中文。
> 实测口径：本报告「终态验证」列除引用批次记录外，均于 2026-08-12 工作区（HEAD d26b62ce，含并行域未提交改动）实跑/grep 复核。

---

## 0. 总览

### 0.1 批次 → 提交对照表（销号索引）

| 批次         | 内容                                                                                                                                                                                                       | 提交                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| R2-1         | check-css-encoding 门禁升级（PUA/GBK 逆变换/特征字 3 层）+ package.json/ci.yml 接线 + 白名单快照                                                                                                           | 15bd7b40 / f851c6cf |
| R2-2         | `.ui-btn` 死 CSS 删除（shell-polish 12 规则 + DiffCard applyActions + settings-* 死选择器）+ VirtualList(R20) 退役 + 基线原子化（999px 66→62 / !important 633→626）+ 白名单重快照                          | 3c878774            |
| R2-3         | mojibake 重写清零（4 文件，特征命中=0）+ 白名单清理（→229 行）+ P3 零星（DEAD 注释 / store README 同步 / R15/R16 登记）                                                                                    | 89e8b200            |
| R2-4         | P2-1 stop 终稿截断四步（F1a 删 stop()/F1b currentText 优先/F1c isFinal 停写/F1d 截断哨兵）+ N1 同值帧 seq + N2 isFinal 残留 + C1 chunk 环检测 + C2 preview 冒烟脚本 + P3-1 @vite-ignore（5 处 + 双面支撑） | 4e8143d4            |
| R2-5         | props 三链聚合（ChatComposer spread / ChatStatusRibbons ribbons 组 prop + 派生上移案甲 / ChatMessageList 聚合对象）                                                                                        | 69a7f118            |
| R2-6 波1     | settings 系 19 文件按钮转换，44 豁免登记                                                                                                                                                                   | c3512414            |
| R2-6 波2/3   | chat 域 40 + 壳/状态域 38 按钮转换，51 豁免登记                                                                                                                                                            | 56a36776            |
| R2-6 overlay | FirstRunWizard import 修复 + TelemetryDialog 3 按钮 + ToastStack/WithdrawConfirmDialog                                                                                                                     | cb97204d + 2c17188e |
| R2-6 波5     | sidebar/files/diff：SidebarNav 2 转换 + 40 豁免登记（menuitem×19/segment×8/disclosure-head×6/chip×2/option-listitem×2/breadcrumb-chip×1/accordion-file×1/list-row×1）+ FileActions:399 role=menuitem 补全  | 83f21f25            |
| R2-6 波6     | root/agent-card/binary-tree：14 转换 + 14 豁免登记                                                                                                                                                         | 08df8ba1            |
| R2-6 波6 尾  | InlineAgentPanel stop/side 转换（D8 段随带入库）                                                                                                                                                           | 211fb1fa            |
| R2-6 终扫    | 全仓业务层动作态清零：18 tsx 追加转换（mcpInlineCopy×4/chatScrollFab/tabAdd×3/trailBtn×5/itemBtn/secH 等 → ghost sm icon-only）                                                                            | eda7678c            |
| R2-7         | 滚动条契约化（SCROLLBAR_BASELINE 31→5、shell-scrollbar.css 唯一出口、9 个 module.css 变量化）+ useAgentStream handleStop→handleStopGeneration 命名对齐 + stop.test 同步                                    | 2c17188e + eda7678c |
| R2-8         | CapEditor checkbox-pill → ui/Switch（H3）+ ModelList 同步；全量门禁复跑 + 本销号报告                                                                                                                       | 2c17188e            |

### 0.2 终态速览（实测）

- 业务层裸 `<button>`（components/ 生产代码，排除 ui/ 原子层与测试）：动作态 = 0；残留 128 个全部为豁免面（menuitem/segment/chip/pill/tabClose/tab 本体/折叠头/文本链接/option/listitem/select-trigger）——`rg -o "<button"`（排除 ui/** 与 _.test._）= 128，实读复核一致。
- `.ui-btn` / `settings-switch` 生产选择器零命中（仅 Button.tsx / Button.module.css / Switch.tsx 注释残留，登记放行）。
- mojibake 4 目标文件（shell-workspace / shell-dragdrop / panels / shell-polish）特征命中 = 0（三层扫描复跑）。
- 基线：RADIUS_999 = 62、IMPORTANT = 626、SCROLLBAR = 5（style-contract.test.ts:198/233/252 实读）。
- typecheck：实测绿（根 `npm run typecheck` 与 `tsc -b --force` 双跑 exit 0，含并行域未提交工作区；master plan §6 记录的 eventParser.ts 红已随并行域类型对齐自然恢复）。

---

## ① 修复销号（逐项对应批次）

### 1. P1-1 `.ui-btn` 死 CSS 物理删除（含 R11/R12 settings-switch 族、P3-6 并入面）

- **问题描述**（复审 01 §3.1 / 复审 02 R11/R12）：批次 1-9 销号声称「.ui-btn 退役删段后收尾 ✅」与实读不符——shell-polish.css:18-86 仍存 12 条全局规则，DiffCard.module.css:368 与 settings-* 4 文件残留死选择器；settings-switch 死规则 4 段（settings-base :552/:723/:2362-2416、settings-plugins :715、theme-dark :126-134）同死。
- **对应批次**：R2-2（01 方案 A 块 A1-A14，含评审漏登补登 :1186-1192 与 :1016/:1038 混合块拆行）。
- **提交**：3c878774。
- **终态验证**：`rg -n "ui-btn"` 生产面（css/tsx）仅注释命中（Button.tsx:4,25 / Button.module.css:31,45,84 放行）；`rg "settings-switch"` 仅 tokens.css/Switch 注释命中；`rg "settings-preset-chip|settings-list-stack-actions"` styles 面零命中；活规则 settings-btn-rect（3 文件 14 处消费）保留完好。基线同提交原子化：999px 66→62、!important 633→626（P0-3 裁决，防回填窗口不成立）。

### 2. P1-12 props 三链聚合（H1）

- **问题描述**（复审 02 H1）：三条 props drilling 链「聚合」声称不实——①ChatCard→ChatComposer 25+ 平铺 prop（ChatCard.tsx:41-92）；②ChatCard→ChatMessageList 25 平铺 prop（:172-197）；③ChatComposerWrapper→ChatStatusRibbons 27 平铺 prop（:82-113），聚合对象拆包回传模式逐字仍在。
- **对应批次**：R2-5（01 方案 B 块 B-1~B-3，ribbons 构造点按案甲：派生上移 ChatCard 层 + useMemo 稳定引用）。
- **提交**：69a7f118。
- **终态验证**：ChatComposer 消费面 spread `{...state.composerProps}`（30 字段摊平）；ChatStatusRibbons 改为 ribbons 组 prop（anyProfileHasKey / onOpenTerminal / onOpenDiff / goalMode 四派生上移，useMemo 稳定引用）；ChatMessageList 调用点聚合对象 spread；2 个死 props（emptyKind / handleGlobalTabClick）随清理（01 方案 N1）。行为变更登记 = 0；接口字段总数不增不减。域内 typecheck 0 错误。

### 3. 裸 `<button>` 业务层清零（H2，6 波 + 终扫）

- **问题描述**（复审 02 H2）：批次 1-9 声称「业务层裸 button 清零」不实——components/（非 ui/ 非测试）实测 101 文件仍裸写（02 复审口径 102、03 计划 116，差异为 T7/T8 合入时点差）。
- **对应批次**：R2-6 六波 + overlay 修复 + 终扫（01 方案 C 块，按 101 实测重排域分布）。
- **提交**：c3512414（W1 settings 19 文件/44 豁免）→ 56a36776（W2/W3 chat 40 + 壳状态 38/51 豁免）→ cb97204d+2c17188e（overlay）→ 83f21f25（W5 sidebar/files/diff 2 转换/40 豁免 + FileActions a11y 补全）→ 08df8ba1+211fb1fa（W6 root/agent-card/binary-tree 14 转换/14 豁免）→ eda7678c（终扫 18 tsx 追加转换）。
- **终态验证**：`rg -o "<button"`（components/，排除 `**/ui/**` 与 `**/*.test.*`）= **128**，全部为豁免面（menuitem×/segment/chip/pill/tabClose/tab 本体/折叠头/文本链接/option/listitem/select-trigger），动作态 = 0；清零判据成立。每波按 T8 语义判定表签字 + 3~5 按钮视觉抽样 + Tab/Enter 键盘走查（01 方案 §3.6 口径）；替换红线（aria-label/aria-pressed/type/data-*/role 保留）执行无回退。

### 4. mojibake 重写清零（R-11 + 03 方案 A 块）

- **问题描述**（复审 01 §3.1 / 03 方案 N1）：四文件（shell-workspace 15 行 / shell-dragdrop 6 / panels 3 / shell-polish 2，共 26 行，含 :356 漏登）GBK→UTF-8 乱码固化；原 check-css-encoding.mjs 只查 FFFD/BOM，对「合法 UTF-8 的 mojibake 固化」完全无效，且**从未接线**（package.json/ci.yml 零命中，03 方案 N2）。
- **对应批次**：R2-1（三层门禁先建 + 接线）+ R2-3（26 行人工重写 + 白名单清理 + 语义签字表）。
- **提交**：15bd7b40 / f851c6cf（门禁与快照）+ 89e8b200（重写与清理）。
- **终态验证**：升级后门禁先检出 4 文件 26 行（层 1 PUA 18 / 层 2 GBK 可逆 1 / 层 3 特征字 7，逐行分类命中）→ 修复后四文件**特征命中 = 0**（2026-08-12 三层扫描复跑一致）；白名单由 R2-1 快照（33 文件 254 行）清理至当前 29 文件 229 行；`npm run check:css-encoding` 已入 package.json:50 与 ci.yml:79 快层 lint job。

### 5. P2-1 stop 大残余终稿截断（四步修复）

- **问题描述**（复审 03 P2-1，02 方案 ①）：`finalizeStopGeneration` 中 `flushFinal()` 后紧跟 `stop()` 取消预算 drain，>16KB 积压时 isFinal 帧永不到达；partialText 被 getStreamText 陈旧值短路 `stopBuf.currentText()` → commit 落盘截断终稿（mock-engine 100KB 流式 + 中途 stop 必现）。
- **对应批次**：R2-4（02 方案 F1a-F1d 四步，最小面同步收口）。
- **提交**：4e8143d4。
- **终态验证**：F1a 删 `stopBuf?.stop()`（useStreamCallbacks.ts:1007）；F1b partialText 换序 currentText() 优先（:1015-1021）；F1c stop 路径 isFinal 帧跳过 setStreamText（:305-312）；F1d 截断哨兵 `committed < streamedFullText` → console.warn + recordStreamDiag(kind:'stop-truncation')（:1039-1042 实读确认）。V2 关键判据（>16KB 积压 stop 终稿完整）域内单测绿；L2/L3 取消路径 V3/V4 回归。

### 6. N1 同值帧丢字（StreamingTextBlock 显示面）

- **问题描述**（02 方案 ⑤ N1）：`lastDeltaRef` 以 delta 字符串相等判幂等 + React.memo props 短路——连续同值帧（逐字「哈」「哈」）第二帧被跳过 append，流式期 UI 缺字（终稿不受影响）。
- **对应批次**：R2-4（seq 单调帧序号 prop + `[delta, seq]` 依赖，StrictMode 双执行仍被拦截）。
- **提交**：4e8143d4。
- **终态验证**：StreamingTextBlock.tsx 增 seq prop + 测试同步（StreamingTextBlock.test.tsx +51 行改）；单测覆盖连续同值帧拼接完整 + StrictMode 不重复；契约红线（children 恒空）不变。

### 7. N2 stop 路径 isFinal 残留写入（随 F1c 消除）

- **问题描述**（02 方案 ⑤ N2）：commit 后 rAF 异步到达的 isFinal 帧仍 setStreamText 旧键 → byKey 累积无消费残留键。
- **对应批次**：R2-4（F1c 内修：stop 面 isFinal 分支跳过写入；complete/draining 分支保持原逻辑）。
- **提交**：4e8143d4。
- **终态验证**：与 F1c 同面同提交；V2 断言「streamingStore 无残留」绿。

### 8. C1 chunk 依赖环静态检测（P2-4 构建面）

- **问题描述**（复审 03 P2-4 / 02 方案 C1）：manualChunks 手写函数风险——源码无环但分 chunk 后可能产生 chunk 级循环引用，构建器未必告警，缺「chunk 级依赖环」检测。
- **对应批次**：R2-4（P0-1 裁决并入）。
- **提交**：4e8143d4。
- **终态验证**：`scripts/check-chunk-cycles.mjs` 入库（静态边仅计 `from "./x.js"`，动态 import 天然延迟不构成环）；构建产物实测 **79 chunks 无环**（提交信息记录）；脚本本体 2026-08-12 实读确认。⚠️ 未接线 package.json/CI（见附 B-2）。

### 9. C2 生产构建运行期冒烟（P2-4 运行期面）

- **问题描述**（复审 03 P2-4）：build 门禁覆盖不到运行期 import 解析 + 严格 CSP 双层，lazy 点缺运行期冒烟。
- **对应批次**：R2-4（P0-1 裁决并入）。
- **提交**：4e8143d4。
- **终态验证**：`scripts/preview-smoke.mjs` 入库——vite preview + chromium 打开主页面 + 设置面板（触发 SettingsPanel lazy chunk），断言根节点渲染 + 零 console error/pageerror。⚠️ 交付形态与计划（tests/e2e/preview-smoke.spec.ts 挂 e2e-l2）有偏差且未接线 CI（见附 B-2）。

### 10. P3-1 `Function('return import(...)')` → @vite-ignore 动态 import

- **问题描述**（复审 03 P3-1 / 02 方案 §3.1）：生产代码 5 处 Function 构造（skillsApi.ts:214/226/598/616 + api/import/importFsHost.ts:53），prod CSP（无 unsafe-eval）下失败形态为 EvalError，与「生产构建禁 eval」基线冲突、诊断信号误导。
- **对应批次**：R2-4（P0-2 裁决本轮低风险修复，@vite-ignore + try/catch，失败形态 EvalError→普通 import 拒绝，净行为不变）。
- **提交**：4e8143d4。
- **终态验证**：5 处全部替换；配套入库 tauri-plugins.d.ts 类型声明 + vitest alias stub（test-setup-tauri-plugins-stub.ts）+ vite.config rollup external——Tauri/浏览器构建双面支撑；skillsApi 既有测试回归绿。

### 11. R20 VirtualList 孤儿退役

- **问题描述**（04 方案 §2.10）：`components/shell/VirtualList.tsx` 业务消费 0（仅自身测试），窗口计算与 useVirtualScroll 重复，02 审计已判孤儿。
- **对应批次**：R2-2（04 方案 W1）。
- **提交**：3c878774。
- **终态验证**：删前 `rg "VirtualList"` 复核零消费（01 方案 §3.2 判据）；`VirtualList.tsx` + `VirtualList.test.ts` 随 git rm 提交删除（文件已从工作区消失，Test-Path=False 实测）；测试资产铁律（先确认入库再删）满足。

### 12. R5 滚动条契约化（H4 残余面）

- **问题描述**（复审 02 H4 / 04 方案 §2.2）：12 文件 31 块 `::-webkit-scrollbar*`，thumb 2/3/4px 与轨道 10%/18% 混用，同界面粗细不一；SCROLLBAR_BASELINE 31 锁定。
- **对应批次**：R2-7（04 方案 W2；style-contract.test.ts ④ 基线按 C-5 由最后触碰批收口）。
- **提交**：2c17188e + eda7678c。
- **终态验证**：`::-webkit-scrollbar` 生产 css 命中文件 = 1（shell-scrollbar.css 唯一出口）；SCROLLBAR_BASELINE = 5（style-contract.test.ts:233 实读，shell-scrollbar.css 自身 5 处伪元素选择器，评审 02 §1.4「基线按 5 执行」口径）；9 个 module.css 变量化收口；允许按域保留尺寸档位（档位来源唯一）；人工抽查清单（菜单/任务卡/设置 tab）按 04 方案 R-1 执行。

### 13. R9 流式命名对齐（handleStop → handleStopGeneration）

- **问题描述**（04 方案 §2.6）：useAgentStream 与 useChatStream 停止生成命名双轨（handleStop/handleForceStop vs handleStopGeneration/handleForceCancelGeneration），注释自认不同步。
- **对应批次**：R2-7（04 方案 W3；纯改名零行为变更；评审 02 补 InlineAgentPanel.markdown.test.tsx 同步面）。
- **提交**：2c17188e + eda7678c。
- **终态验证**：`handleStopGeneration`（useAgentStream.ts:62/386/433 实读）+ `handleForceCancelGeneration` 全量替换；`\bhandleStop\b` 零残留（rg 实测）；useAgentStream.stop.test.ts 同步改；域内 typecheck + 中层流式测试绿。

### 14. H3 CapEditor checkbox-pill → ui/Switch（R2-8）

- **问题描述**（复审 02 H3）：CapEditor.tsx:28-34 自留 `<input type="checkbox" style={{display:'none'}}>` + 私有 mrdCapPill pill 样式，注释自认「T11 合入后重写为 <Switch>」未执行；`role="switch"` 唯一来源承诺未达成。
- **对应批次**：R2-8（01 方案 D 块 D-1）。
- **提交**：2c17188e。
- **终态验证**：CapEditor.tsx:6 导入 ui/Switch、:24 消费 `<Switch size="sm" checked onCheckedChange aria-label>`（实读）；caps/onCapChange 回调签名不变（ModelConfigPanel/ManualAddForm 消费方零改动）；`rg "mrdCapPill"` 与 settings-models 域 `type="checkbox"` 零命中（实测）；`role="switch"` 全仓唯一来源 = ui/Switch；视觉变化（pill→开关轨道）登记为预期（01 方案 §4.3）。

---

## ② 登记 / 保留销号（逐项终态）

| #   | 项                                                | 来源               | 终态                            | 理由                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------- | ------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2-2 complete 大残余 drain 后台标签页节流         | 复审 03            | **登记**（不修）                | 自愈闭环（buffer 持全文，回前台 rAF 恢复自然收口）、无数据丢失；O1 兜底（visibilitychange 再 flushFinal）为体感优化，02 方案「不落地亦可」，排最低优先级                                                                                                 |
| 2   | P2-3 加载态按钮 50% opacity                       | 复审 03            | **登记下轮视觉轮次**            | 观感面非性能/收敛维度（02 方案 §2.3 移交 UI 维度）；迁移 loading prop 或对 loading 态豁免 opacity，待视觉轮次统一裁决                                                                                                                                    |
| 3   | P3-2 --text-tertiary 加深观感扁平                 | 复审 03            | **登记视觉轮次**                | a11y 正确性优先（对比度 2.6:1→4.9:1），层次扁平化属观感确认面，无代码动作（R2-3 C-1 登记）                                                                                                                                                               |
| 4   | P3-3 store/README.md 过期                         | 复审 03            | **已修复**（R2-3 C-2）          | sessionActions 拆分 5 文件 + D2 连接态真源已载明，日期同步（89e8b200）                                                                                                                                                                                   |
| 5   | P3-4 StatusDiagnosticsPanel DEAD 注释             | 复审 03            | **已修复**（R2-3 C-2）          | 「DEAD: rustCoreStore」过时注释已清理（89e8b200）                                                                                                                                                                                                        |
| 6   | P3-5 Tooltip focus 触发常驻                       | 复审 03            | **登记视觉轮次**                | a11y 标准行为（点击后 focus 保持至 blur），消费点目视确认无粘滞即闭环（R2-3 C-1 登记）                                                                                                                                                                   |
| 7   | P3-6 `.ui-btn` 死 CSS                             | 复审 03            | **已修复**（并入 R2-2）         | 与 P1-1 完全同文件同删除面（02 方案 §3.2 归口 01 A 块，防双 Agent 重复执行）；3c878774 内销除                                                                                                                                                            |
| 8   | R14 theme-dark 补丁（265 行，活补丁）             | 复审 02 / 04 方案  | **保留（条件触发）**            | 非死代码 + 迁移依赖视觉基线环境（90-report §7.2 明示）；视觉基线就绪后逐条迁 tokens.css dark 分支，迁移后解除 ratchet 豁免；禁止无视觉验收迁移                                                                                                           |
| 9   | R18 `!important` 633（终态 626）                  | 复审 02 / 04 方案  | **保留（条件触发）**            | 剩余为活特异性覆盖链（SettingsQuickMenu/InlineAgentPanel 等），无视觉环境不可凭特异性推算盲删（批次 9 已证明需实测）；ratchet 只拦新增；视觉验证就绪后与 R14 同批治理并逐批下调基线                                                                      |
| 10  | R8 滚动锚定双套                                   | 复审 02 / 04 方案  | **保留（条件触发）**            | 两套锚定容器语义独立（合成滚动区 vs 虚拟消息列表）、各消费 ≤2；登记维护性债务，远期以 useVirtualScroll 为底座统一（优先级最低）                                                                                                                          |
| 11  | R9 流式双轨合并本体                               | 复审 02 / 04 方案  | **保留（条件触发）**            | 本轮已摘命名对齐低垂果实（见①-13）；内核合并动刚修复的流式管线（stop 截断），触发条件 = 02 方案修复稳定 + 并行域收敛后另行立项                                                                                                                           |
| 12  | R15 settings-models 域内混色变量（15 个）         | 复审 02 / 03 方案  | **登记**（R2-3 C-1）            | 域内自洽 token 定义行（DEF_LINE，style-contract ② 不计数），非裸混色消费点；非标准档位收敛会造成视觉漂移，P3 粒度不值得动；style-contract.test.ts 例外注释已登记                                                                                         |
| 13  | R16 菜单硬编码圆角（4 处）                        | 复审 02 / 03 方案  | **收 1 登记 3**（R2-3 C-1/C-2） | ComposePlusMenu:111 7px → var(--radius-sm) token 化（已修复）；其余 3 处保留：SettingsQuickMenu 999px（pill 语义正确值，属 RADIUS_999 基线内）/ TiptapSlashMenu 2px（scrollbar 拇指，计入 SCROLLBAR 契约）/ PermissionModeMenu 50%（圆形语义非圆角档位） |
| 14  | H5 ui/Input 0 消费 + settings-field-input 12 文件 | 复审 02            | **登记下轮候选**                | ui/Input 建成未上岗、未声称故不构成虚报；终态 = 「下轮候选：Input 上岗或 settings-field-input 退役」，二选一待下轮裁决                                                                                                                                   |
| 15  | R13 ui/Input 建成未上岗                           | 复审 02            | **登记下轮候选**                | 与 H5 同面（barrel 已导出、业务 0 消费）；并入下轮 Input 治理批次                                                                                                                                                                                        |
| 16  | R17 TabStrip 消费点呈现差异                       | 复审 02            | **保留（契约允许）**            | 结构已收敛 ui/TabStrip（5 消费点），各点 renderTab 自绘 tabMain/tabClose + 私有 tabClassName 属 renderTab 契约允许面，非违规；观感差异登记，不强制统一                                                                                                   |
| 17  | 退役 5 命令函数体物理清理                         | 复审 01 §5（可选） | **登记保留**                    | rustCore 侧退役函数带 #[allow(dead_code)] + 「保留待恢复」注释，不构成幽灵 wire 键；物理清理可选面，登记保留已可接受（评审 01 覆盖核对表 #3 口径）                                                                                                       |

> 登记口径注：豁免登记汇总 44（W1）+ 51（W2/W3）+ 40（W5）+ 14（W6）+ 终扫复核 ≈ 149 项（跨波有重叠口径，终态业务层裸 button 128 个全部为豁免面，以实测 128 为准）。

---

## 附 A：全量门禁复跑状态（2026-08-12 实测）

| 门禁                                                                                                                             | 状态                | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck（根 `npm run typecheck` + `tsc -b --force`）                                                                           | ✅ 绿               | 双跑 exit 0。master plan §6 记录的「红」为并行域 `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.ts`（未提交 +107 行，事件类型失配）所致，与 R2 轮次无关；截至本报告实测，并行域类型已对齐、工作区整体通过（该文件仍未提交，属并行域收口责任）                                                                                                                                                                                                                           |
| 快层 unit（`npm run test:coverage -- --project=unit`）                                                                           | ⏳ 待复跑           | R2 各波次域内单测均绿；全量快层按计划在并行域提交后统一复跑（避免并行域未提交状态混入结果）                                                                                                                                                                                                                                                                                                                                                                                           |
| 中层两 job（vitest 全量 / integration F3 四目录）                                                                                | ⏳ 待复跑           | 同上；R2-7 的中层流式测试（useAgentStream 命名对齐回归面）域内已绿                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 集成门禁（lint / build / check-dist / check:ui-layer / check:line-counts / check:swallowed-errors / style-contract 23 项）       | ⏳ 待复跑           | style-contract 基线 62/626/5 与计数实读吻合（2026-08-12 实测），复跑预期绿                                                                                                                                                                                                                                                                                                                                                                                                            |
| **check-css-encoding**                                                                                                           | ⚠️ 红（非新增乱码） | 根因 = **白名单行号漂移**：R2-6 W6 尾（211fb1fa 改 InlineAgentPanel.module.css）与 R2-8/并行域（2c17188e 改 ModelsSettingsTab.module.css / WorkspaceChromeBars.module.css）触碰白名单文件后行号位移，白名单行号失配（如 InlineAgentPanel 白名单 14/276/284/301 → 现命中 13/344/352/369，同内容平移）。**4 目标文件零命中保持**、白名单 229 行计数不变，无新增乱码。处置：复跑前对触碰文件重对齐白名单行号（或 `--init-whitelist` 重快照后人工核对），属门禁维护面，与 R2 修复成果无关 |
| 5 个 markdown-editor 专项 e2e（ast-block-tables / format-checker / ime-composition / keyboard-navigation / wysiwyg-interaction） | ⏳ 保留待复跑       | AGENTS.md 铁律保护名单，spec 文件均在（tests/e2e/ 实读）；随全量复跑执行                                                                                                                                                                                                                                                                                                                                                                                                              |
| 视觉抽样                                                                                                                         | ✅ 已执行           | 各波按 01 方案 §3.6 契约执行（每波 3~5 按钮视觉 + Tab/Enter 键盘走查 + T8 判定表逐按钮签字）；终扫确认无形态回退；波 1-3 实证被 Button 变体覆盖破坏的观感面已回退登记                                                                                                                                                                                                                                                                                                                 |

## 附 B：悬空 / 待办清单（如实登记，供主控调度）

| #   | 项                                                                                                                                                                                                     | 状态       | 建议                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | typecheck 全量复跑依赖并行域 eventParser.ts 提交                                                                                                                                                       | 并行域责任 | 并行域收口后执行附 A 全量复跑清单                                                                                                                          |
| B-2 | C1/C2 脚本未接线：check-chunk-cycles.mjs 与 preview-smoke.mjs 已入库（4e8143d4）但无 package.json script、无 CI step；C2 交付形态为独立脚本而非计划中的 tests/e2e/preview-smoke.spec.ts（未挂 e2e-l2） | 部分交付   | 复跑批补接线（package.json script + CI frontend-build 链），或按计划形态补 spec 挂 e2e-l2；C1 已在提交内本地跑通（79 chunks 无环）                         |
| B-3 | V6 e2e（tests/e2e/stop-truncation.spec.ts，02 方案 V6 / 评审 P2-3）未入库                                                                                                                              | 未交付     | P2-1 的 e2e 层验证缺口：V2 单测（>16KB 积压终稿完整）已绿，但 mock-engine 100KB + Stop 控件 e2e 未落地；建议下轮补 V6（含 Stop 控件 data-testid 锚点确认） |
| B-4 | check-css-encoding 白名单行号漂移（附 A）                                                                                                                                                              | 维护面     | 全量复跑前重对齐触碰文件白名单行号；后续纪律：触碰白名单文件须同步白名单（补入执行纪律或门禁侧容差）                                                       |
| B-5 | 下轮视觉轮次承接项                                                                                                                                                                                     | 已登记     | P2-3 加载态 opacity、P3-2 --text-tertiary、P3-5 Tooltip focus、H5/R13 Input 上岗或退役（附 ② 表）                                                          |

---

（本报告完——两段式销号：① 修复销号 14 项全部对应批次/提交/终态验证；② 登记/保留销号 17 项逐项终态落位；附全量门禁复跑状态与悬空清单 5 项，均如实登记）
