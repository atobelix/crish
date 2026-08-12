# 前端第二轮修复 · 总计划方案（R2 Master Plan v1.0）

> 主控产出：`docs/frontend-audit/60-repair2/40-final-plan/00-master-plan.md`
> 输入：50-reverify 三份复审 + 60-repair2 四份维度方案（01/03 已按技术评审修订）+ 30-reviews 双评审
> 版本：**v1.0**（吸收评审 01 的 4 P0 + 5 P1 + 9 P2 + F-1~~F-5 与评审 02 的 3 条 P1 冲突，主控裁决全部落地）
> 修订日志：v0.1→v1.0——P0-1 C1/C2 并入 R2-4；P0-2 P3-1 本轮修复并入 R2-4；P0-3 R2-2 计数实读+基线原子化；P0-4 销号两段式；新增 C-5 与 F-1~~F-5 登记；P1/P2 全量吸收
> 性质：逻辑执行顺序方案；不含时间/人员/优先级；每轮 ≤12 Agent；闭环迭代

---

## 0. 本轮任务范围（复审确认的遗留 + 新发现）

| 来源                       | 内容                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 复审 01/02：声明与代码不符 | P1-1 .ui-btn 死 CSS 未删；P1-12 props 三链未聚合；裸 button 101 文件未清零；R-11 mojibake 残留 26 行                                                                                                    |
| 复审 03：新发现问题        | P2-1 stop 终稿截断（>16KB 积压）；N1 同值帧丢字；N2 stop 后 isFinal 残留写入；P2-2 complete 节流（登记）；P2-3 加载态 opacity（登记下轮）；P2-4 运行期冒烟（C1/C2）；P3-1 Function→@vite-ignore（本轮） |
| 复审 03：卫生              | check-css-encoding 门禁盲区（mojibake 固化）；P3-2~P3-6 零星                                                                                                                                            |
| 复审 02：P2 挂账           | 10 类裁决：本轮 3 动作（R20 退役/R5 契约化/R9 命名对齐）+ 下轮 4 + 保留 4                                                                                                                               |

---

## 1. 执行轨道

| 轨道         | 来源方案                            | 核心任务                                                                                                                                  |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| T-A 收敛补刀 | 01-convergence-completion（已修订） | .ui-btn 死 CSS 删除（A 块含 A13/A14 漏登）、props 三链聚合（B 块含 ribbons 构造点两案）、裸 button 6 波（C 块）、CapEditor Switch（D 块） |
| T-B 性能修复 | 02-performance-fixes（7 步）        | P2-1 四步修复、N1/N2、**C1/C2 构建面收口（并入本轨道）**、**P3-1（并入）**、chunk 环检测                                                  |
| T-C 卫生门禁 | 03-hygiene-gate-upgrade（已修订）   | mojibake 三层门禁（先建→重写→白名单清理）、基线联动（原子化于 R2-2）、P3 零星                                                             |
| T-D 挂账裁决 | 04-p2-adjudication                  | R20 退役、R5 滚动条契约化（31→1）、R9 命名对齐                                                                                            |

---

## 2. 批次编排（逻辑顺序）

### 批次 R2-1（卫生门禁先行，1 Agent）

- T-C 步骤 B-1：check-css-encoding.mjs 三层升级（PUA/GBK 逆变换/特征字）+ package.json/ci.yml 接线（03 新发现 N2：原未接线）
- 验证：门禁检出 4 文件 26 行残留（特征命中清单）；typecheck
- 注意：`--whitelist-dirty-check` CI 启用后置到 R2-2 落地后（03 修订口径，避免删除前误红）

### 批次 R2-2（死代码删除 + 基线原子化，2 Agent 并行，文件面错开）

- T-A A 块：.ui-btn 死 CSS 删除（shell-polish.css:17-86 + DiffCard.module.css:368 + settings-base/plugins/advanced 死选择器 + settings-switch 死规则 + **A13/A14 settings-plugins:1016/1038 + :1186-1192 漏登项** + A7 按 03 N4 修正）
- T-D R20：VirtualList 孤儿退役（**删前 `git ls-files` 确认已入库**，随 git rm 提交）
- **基线原子化（P0-3 裁决）**：style-contract 基线 999px 66→62 / !important 633→628 与删除**同一提交内收口**（03 修订口径）；删除面与挂账白名单重叠行 → **删除 + 白名单清理 + 基线调整同一提交原子化**（03 §2.3 修订）
- 验证：**计数实读复核**（`rg -o "border-radius:\s*999(?!\d)"` = 62、`rg -o "!important"` = 628）+ style-contract 绿 + grep 零消费 + typecheck
- 冲突注：shell-polish.css 与 R2-3 串行（已消解）；settings-plugins.css:253 乱码顺带处理（01 N4）

### 批次 R2-3（mojibake 重写清零 + 卫生 P3，1 Agent）

- T-C A-2：4 文件 26 行 mojibake 重写（shell-workspace 14/shell-dragdrop 6/panels 3/shell-polish 2 + :356 新发现；**验收判据用特征命中=0 而非固定行号**——03 修订口径）
- **修复后删除白名单对应 26 行**（--whitelist-dirty-check 零脏行）
- T-C C-1/C-2：P3 零星（R15 settings-models 混色变量登记、R16 菜单圆角收 1 处登记 3 处、P3-2~P3-5 登记）
- **style-contract.test.ts 单 Agent 串行**（本批的②③基线确认 + R15 登记例外同文件——P1-2）
- 验证：check-css-encoding 全仓通过 + whitelist-dirty-check 零脏行 + typecheck

### 批次 R2-4（性能修复 + 构建面收口，1-2 Agent 串行）

- **P2-1 四步**（F1a 删 stop 取消 + partialText 换序 currentText() 优先 + isFinal 帧 stop 面停写 + 截断告警）；**N1**（StreamingTextBlock 同值帧 props 短路——修改组件守卫）；**N2**（useStreamCallbacks F1c isFinal 残留写入）
- **C1/C2（P0-1 裁决）**：chunk 环检测（check-chunk-cycles.mjs 入库）+ preview 冒烟（preview-smoke 挂 e2e-l2）
- **P3-1（P0-2 裁决）**：Function→@vite-ignore + try/catch（skillsApi.ts ×4 + importFsHost.ts ×1，失败形态 EvalError→普通拒绝）
- 验证：V2 判据（64B 阈值 buffer 断言 commit 全文无损）+ V3/V4 单测（L2/L3 取消路径）+ **V6 e2e（tests/e2e/stop-truncation.spec.ts + Stop 控件 data-testid 确认）** + 流式测试全绿 + check-chunk-cycles + typecheck
- 注意：useStreamCallbacks.ts/StreamingTextBlock.tsx 本批单 Agent 独占（C-4）

### 批次 R2-5（props 三链聚合，1 Agent，依赖 R2-4 完成后动 ChatCard 面）

- B 块 B-1~B-3：ChatCard→ChatComposer（25 props → 聚合 spread）、ChatCard→ChatMessageList（25 props → 聚合）、ChatComposerWrapper→ChatStatusRibbons（27 props → **ribbons 聚合对象按 01 修订两案裁决：案甲 ChatCard 层构造 + useMemo 稳定引用，派生上移**；含 2 个死 props 清理）
- 验证：typecheck + 相关组件测试 + **memo 回归点名（MessageVirtualizer.memo.test.tsx）** + B 块风险清单（01 修订：B1/B2 spread 不破 memo、B3 ribbons 单 prop 为敏感面）
- 与 R2-6 串行（同 ChatCard 文件，R2-5 先）

### 批次 R2-6（裸 button 6 波清零，2-3 Agent 分域并行）

- C 块 6 波（settings 收尾/chat-card/chat-composer/壳状态区/sidebar-files-diff/收尾波），每波 ≤20 文件
- 每波验证：typecheck + **视觉抽样=人工走查（3~5 按钮视觉 + Tab/Enter 键盘走查，01 §3.6 口径）** + T8 语义判定表逐按钮签字
- 波间独立提交；豁免面登记（segment/chip 自定义形态族）
- 注意：与 R2-5 文件面重叠（chat-card 域）——R2-5 先提交后本批开始

### 批次 R2-7（滚动条契约化 + 流式命名对齐，可并行 2 Agent）

- R5：滚动条 31 块 → 契约化（shell-scrollbar.css 唯一出口，SCROLLBAR_BASELINE 31→1；**允许按域保留尺寸档位（2px/3px 菜单条例外），档位来源唯一**；人工抽查清单：菜单/任务卡/设置 tab）
- R9：useAgentStream 命名对齐（handleStop 纯改名 + **useAgentStream.stop.test.ts 同步改 + 中层流式测试绿**）
- **style-contract.test.ts ④ SCROLLBAR 基线由本批收口**（C-5：与 R2-3 串行，本批为最后触碰批 → 统一 23/23 并提交）
- 验证：style-contract 23/23 + typecheck + 中层流式测试

### 批次 R2-8（CapEditor Switch + 全量验收，1 Agent）

- D 块：CapEditor checkbox-pill → ui/Switch（H3）
- 全量门禁复跑：typecheck / vitest 全量 / integration / cargo 我方（cargo test --workspace 口径）/ lint / build / check-dist / 5 个 markdown-editor 专项 e2e（AGENTS.md 铁律保留）
- **销号报告 v2（两段式，P0-4 裁决）**：
  - ① 修复销号：P1-1/P1-12/裸 button/mojibake/P2-1/N1/N2/C1/C2/P3-1/R20/R5/R9/H3 逐项对应批次
  - ② 登记/保留销号：P2-2（complete 节流登记）、P2-3（加载态 opacity 下轮视觉轮次）、P3-2~P3-5（登记视觉轮次）、P3-6（并入 R2-2）、R14/R18/R8/R9 本体（保留条件触发）、R15/R16（登记）、H5/R13（ui/Input 下轮候选）、R17（renderTab 契约允许保留）、退役命令函数体（登记保留）
  - 输出 `docs/frontend-audit/60-repair2/40-final-plan/90-final-report-r2.md`

---

## 3. 冲突裁决（含 F-1~F-5 共享文件登记）

| #       | 冲突                                                                         | 裁决                                                                                                |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| C-1     | R2-5 props vs R2-6 裸 button（ChatCard 域）                                  | 串行：R2-5 先提交、R2-6 后                                                                          |
| C-2     | R2-2 .ui-btn 删除 vs R2-7 滚动条（styles 面）                                | 执行时 git status 复核（批次已串行）；R2-7 避开已删文件                                             |
| C-3     | 基线调整 vs 删除面                                                           | **R2-2 提交内原子化**（03 修订口径；不设窗口期）                                                    |
| C-4     | 02 方案 N1/N2 与批次 8 文件                                                  | useStreamCallbacks.ts/StreamingTextBlock.tsx 由 R2-4 单 Agent 独占（修正表述）                      |
| **C-5** | **style-contract.test.ts 跨批**（R2-3 ②③基线 + R15 登记 vs R2-7 ④SCROLLBAR） | 两批独占该文件；**最后触碰批（R2-7）统一 23/23 并提交**；中间态禁止声称绿                           |
| F-1     | style-contract.test.ts                                                       | R2-3 + R2-7 触碰 → C-5 覆盖                                                                         |
| F-2     | shell-workspace.css                                                          | R2-3（mojibake 15 行）+ R2-7（滚动条）→ 批次串行消解；执行时语义定位                                |
| F-3     | shell-polish.css                                                             | R2-2（删 :17-86）+ R2-3（重写 :626/811）→ 串行消解；补登记                                          |
| F-4     | DiffCard.module.css                                                          | R2-2（删 :368）+ R2-6（diff 域波）+ R2-7（滚动条块）→ 三批同文件，批次串行 + 执行时 git status 复核 |
| F-5     | settings-plugins.css                                                         | R2-2（A7/A8/A13/A14 删行 + N4 :253 乱码顺带）→ 批内合并同一提交                                     |

---

## 4. Agent 分配原则（防竞争）

1. 批次内多 Agent 文件面错开（R2-2 styles/ vs VirtualList；R2-6 分域）
2. 共享文件（useStreamCallbacks/StreamingTextBlock/ChatCard/style-contract.test.ts）单轮单 Agent 或按 C-5 串行
3. 每波/每步独立提交；机械替换 ≤20 文件/批
4. 并行域规避：实施前 git status 检查目标文件；与并行域共享文件先读最新
5. 测试资产铁律：删除测试前 git ls-files 确认已入库（R20 VirtualList 例）

---

## 5. 闭环机制

- 每批输出 = 代码 + 测试 + 提交；验证 = 该域门禁（按本计划各批验证列）
- 下批输入 = 上批提交基线
- 最终验收 = R2-8 全量门禁 + 销号报告 v2（两段式，覆盖核对表逐项终态）

---

（v1.0 完——评审意见全部吸收，可进入执行）

---

## 6. 执行状态（2026-08-11 更新，供子 Agent 对齐）

| 批次                                   | 状态                                                                                                                                                                                                                                                                                                | 提交                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| R2-1 门禁升级                          | ✅                                                                                                                                                                                                                                                                                                  | 15bd7b40/f851c6cf        |
| R2-2 死 CSS 删除                       | ✅                                                                                                                                                                                                                                                                                                  | 3c878774                 |
| R2-3 mojibake 清理                     | ✅                                                                                                                                                                                                                                                                                                  | 89e8b200                 |
| R2-4 性能修复                          | ✅                                                                                                                                                                                                                                                                                                  | 4e8143d4                 |
| R2-5 props 聚合                        | ✅                                                                                                                                                                                                                                                                                                  | 69a7f118                 |
| R2-6 波1 settings                      | ✅（44 豁免登记）                                                                                                                                                                                                                                                                                   | c3512414                 |
| R2-6 波2/3 chat+壳                     | ✅（78 按钮替换，51 豁免登记）                                                                                                                                                                                                                                                                      | 56a36776                 |
| R2-6 overlay                           | ✅ 半成品修复入库：FirstRunWizard Button import 补全、TelemetryDialog 3 按钮（danger/secondary/primary）、ToastStack/WithdrawConfirmDialog 随早期提交                                                                                                                                               | cb97204d + HEAD 2c17188e |
| R2-6 波5 sidebar/files/diff            | ✅ 2 转换（SidebarNav 新对话/定时任务 ghost sm）+ 40 豁免登记（menuitem x19/segment x8/disclosure-head x6/chip x2/option-listitem x2/breadcrumb-chip x1/accordion-file x1/list-row x1）；FileActions:399 role=menuitem 补全 a11y                                                                    | 83f21f25                 |
| R2-6 波6 剩余域                        | ✅ root 5 文件（AppTopBar 5/SettingsWindowControls 3/SettingsTablist 2/WizardProjectStep 1/AppErrorBoundary 1 豁免）+ agent-card（ApprovalActions 4/InlineAgentPanel 2/AgentBrowsePad 1/AgentTeamBoard 1 豁免）+ binary-tree（UnitSessionTabStrip tabAdd/LeafToolTabStrip 收起）——14 转换 + 14 豁免 | 08df8ba1 + 211fb1fa      |
| R2-6 终扫复核                          | ✅ 全仓业务层动作态清零：18 tsx 追加转换（mcpInlineCopy x4/chatScrollFab/tabAdd x3/trailBtn x5/itemBtn/secH 等 → ghost sm icon-only）；终态业务层裸 button 128 个全部为豁免面（menuitem/segment/chip/tabClose/tab 本体/折叠头/文本链接/option/listitem/select-trigger）                             | eda7678c                 |
| R2-7 滚动条契约化+命名对齐             | ✅ SCROLLBAR_BASELINE 31→5、shell-scrollbar.css 唯一出口、9 个 module.css 变量化收口（eda7678c）；useAgentStream handleStop→handleStopGeneration 纯改名 + stop.test 同步                                                                                                                            | 2c17188e + eda7678c      |
| R2-8 CapEditor Switch+全量门禁+销号 v2 | ⚠️ CapEditor/ModelList → ui/Switch 已完成入库（2c17188e）；**全量门禁复跑 + 销号报告 v2 待做**（typecheck 当前红为并行域 eventParser.ts 未提交所致，与 R2 无关）                                                                                                                                    | 2c17188e                 |

**执行纪律**：子 Agent 先读本计划对应章节 + 01-convergence-completion §3（T8 判定表/替换红线/豁免口径）→ 重扫目标域定稿 → 只替换动作态（danger/ghost/primary/secondary），豁免类（menuitem/segment/chip/pill/select-trigger/tabClose/折叠头/结构契约）登记不动 → 观感被 Button 变体覆盖破坏则回退登记（波 1-3 实证）。lint-staged 钩子自动跑 eslint/prettier。不提交 git（主控统一）。
