# 第二轮修复四份维度方案 · 技术正确性复核（02-technical-correctness）

> 产出：方案评审子 Agent（只读 + 本文档，无代码改动）。
> 输入：`60-repair2/20-proposals/01~04` 四份维度方案 + `40-final-plan/00-master-plan.md` + `50-reverify/03-regression-check.md`。
> 方法：关键设计逐条实读代码复核（grep / 读文件 / Python 三层扫描），全部行号与计数基于 2026-08-10 工作区。
> 日期：2026-08-10。编码：UTF-8 无 BOM，中文。

---

## 0. 结论速览

| # | 方案 | 复核结论 | 就绪度 |
|---|---|---|---|
| 01 | 收敛补刀（A 死 CSS / B props 聚合 / C 裸 button / D CapEditor） | 判据基本成立；B 块构造点缺口 + A 块清单 2 处漏登 | **需修订后派发** |
| 02 | 性能修复（P2-1 stop 截断 / N1 同值帧 / P2-4 / P3） | 根因链完全实读验证成立，四步修复设计正确 | **直接可派**（P3-6 归口需主控确认） |
| 03 | 卫生门禁升级（三层检测 / 26 行清零 / 基线联动） | 26 行分类与基线推导全部实测验证；白名单时序缺口 1 处 | **需修订后派发** |
| 04 | P2 挂账裁决（R20 退役 / R5 滚动条 / R9 命名） | 三项本轮动作判据全部成立；R5 基线数字弹性需写清 | **直接可派** |

**P0 冲突：0。** P1 冲突 3、P2 冲突 4（见 §2）。核心设计（P2-1 四步修复、三层门禁、mojibake 26 行清单、style-contract 基线 62/628 推导）经实读全部成立——四份方案**无方向性错误**。

---

## 1. 关键设计复核表（方案设计 vs 实读）

### 1.1 方案 01（收敛补刀）

| 块 | 方案设计 | 实读复核 | 结论 |
|---|---|---|---|
| A1 `.ui-btn` 全局体系删除 | shell-polish.css:17-85 整段删（11 条规则 + 段注释） | tsx 零消费成立（全仓仅 Button.tsx:4,25 注释命中）；**行号边界瑕疵**：实际块为 :18-86（.ui-btn-block 规则体 :84-86，:86 为闭合 `}`），按方案「删至 :85」会遗留悬空 `}` | 成立，删段边界改 :18-86（03 方案口径正确） |
| A2 DiffCard.module.css:368-378 | applyActions/applyBtn 双死选择器整块删 | `rg "applyActions\|applyBtn"` tsx 零命中；块内无 999px/!important（0/0 与 03 基线表一致）；.applyLabel 邻块不受影响 | 成立 |
| A3/A4/A9 `.ui-btn` 散点 | 3 处规则删 | sched-settings-row 仅 -name/-schedule 子类消费（WorkflowList.tsx:71,76）、settings-security-icon-btn tsx 零命中、settings-pane--rules 活但 .ui-btn 零消费（settings-advanced.css:472-474 单规则块）——判据全成立 | 成立 |
| A5 settings-base.css:1194-1210 死块 | 整块死（不只 .ui-btn 行） | settings-preset-chips/settings-list-stack-actions tsx 零命中，:1194-1210 整块死成立；**漏登 1**：:1186-1192 独立 `.settings-list-stack-actions` 块同样死（同选择器）未列清单 | 成立，补 :1186-1192 |
| A6 settings-base.css:367-368 注释 | 历史说明失效默认删 | 实读确认 :367-368 为 .ui-btn 体系历史说明；**注意 :365-366 Design System v3 头注释含 mojibake**（在 03 挂账白名单内，删除 :367-368 后仍残留） | 成立 |
| A7 settings-plugins.css:986-991 混合块 | 拆行删两选择器，保留 models-btn/settings-btn-rect | settings-btn-rect 3 文件 14 处消费成立；**03 方案 N4 修正成立**：models-btn 全仓 tsx 零消费——「14 处」全为 settings-btn-rect，应删 3 个选择器行（ui-btn/ui-btn-sm/models-btn） | 成立（按 03 口径修正） |
| A8/A10-A12 settings-switch 族 | 4 段死规则删 | settings-switch tsx 零消费（仅 Switch.tsx:4 注释）；settings-base.css:552/723/2362-2416、settings-plugins.css:715、theme-dark.css:126-134 实读全部命中 | 成立 |
| **漏登 2**（01 方案未覆盖） | — | settings-plugins.css:1016 六选择器混合块（:1011-1025，含活成员 settings-chip-btn/ settings-rule-preset/sched-preset-chip）内 `.settings-preset-chip` 死成员、:1038 hover 混合块（:1034-1040）内 `.settings-preset-chip:hover` 死成员——均需拆行删 | 补入 A-2 步 |
| B1 ChatCard→ChatComposer | 30 字段拆包 → spread | ChatCard.tsx:41-92 实读 30 字段拆包成立；ChatComposer **非 React.memo**（全仓 rg 确认）→ B1 面无 memo 风险 | 成立 |
| B2 ChatCard→ChatMessageList | 25 props → 聚合 spread | 调用点 :172-197 实读 24 字段（方案记 25，计数口径差异无实质影响）；ChatMessageList=React.memo(:368) 成立 | 成立 |
| B3 ChatComposerWrapper→ChatStatusRibbons | 29 字段中加 ribbons 分组 | 接口 29 字段成立（ChatComposerWrapper.tsx:11-41）；ChatStatusRibbonsProps 31 字段成立（:50-114 实读）；**死 props 新发现 N1 成立**（emptyKind:13 / handleGlobalTabClick:40 声明未解构，解构列表 :44-70 无二者） | 成立 |
| B 风险 1（memo 失效） | 「聚合对象内联新建 → memo 全失效」 | **机制描述不准确**：B1/B2 用 spread 展开后 React 按字段浅比较，与现状平铺语义等价，「内联新建聚合对象」本身不破 memo；真正敏感面是 B3 的 `ribbons` 作为**单 prop 字段**传入 memo 的 ChatComposerWrapper。且现状 composerElement（ChatCard:41-93 内联新建 ReactElement）已破 ChatComposerWrapper memo——B3 不引入额外成本 | 修正描述，缓解措施（稳定引用）保留无害 |
| B 块构造点缺口 | 未说明 ribbons 对象构造位置 | ChatStatusRibbons 传参含 3 类 ChatComposerWrapper **内部派生**：① `localHasKey={anyProfileHasKey()}`（:90，模块级函数）② `onOpenTerminal/onOpenDiff` 闭包包装 openSidePanel（:83-84）③ goalText/goalIteration/goalTasksDone/goalTasksTotal 从 goalMode 派生（:97-100，方案已列）。若 ribbons 在 ChatCard 层构造，①②③ 全部必须上移；若在 ChatComposerWrapper 内 useMemo 构造则与「聚合对象由调用方传」目标矛盾 | **P1 缺口**：执行时须裁决构造点 |
| C 裸 button 6 波 | 实测 101 文件、6 波 ≤20/波、复用 T16 | 101 计数实测一致；域分布小出入：sidebar 9→5、workspace 8→7、session-list 4 文件未列、browser-panel 1 未列（总数恒 101，疑似目录归类差异）；T16 六子波 ≤20 文件/波 + 豁免面（role=tab / 编辑器域 / ui/）口径与 03-detail:675 一致 | 成立（波次派单前 rg 重扫兜底已声明） |
| D CapEditor → ui/Switch | checkbox-pill → Switch | CapEditor.tsx:28-34 实读 checkbox + :12 注释自认「T11 合入后重写为 <Switch>」；消费 2 处（ModelConfigPanel/ManualAddForm）；ui/Switch 无 pill 形态，视觉变化登记为预期——设计成立 | 成立 |

### 1.2 方案 02（性能修复）

| 项 | 方案设计 | 实读复核 | 结论 |
|---|---|---|---|
| P2-1 缺陷一：stop() 中断预算 drain | finalizeStopGeneration :1007 `stopBuf?.stop()` 取消 rAF | useStreamCallbacks.ts:1006-1007 实读 `flushFinal()` 后紧跟 `stop()`；StreamRenderBuffer.flushFinal(:117-127) 大残余分支 `flushFrame(false)` + scheduleFlush(:230-232)；stop()(:147-149) cancelScheduledFlush——isFinal 帧永不到达确认 | 成立 |
| P2-1 缺陷二：assertLive 丢弃 + partialText 陈旧值 | 首帧被守卫丢弃；getStreamText 短路 currentText() | onFrame :315-316 守卫实读（runClosed/assertLive），entry 已删（:1000）→ 帧丢弃；partialText :1015-1021 实读 getStreamText 优先、`stopBuf?.currentText()` 兜底——陈旧值短路确认 | 成立 |
| F1a-F1d 四步修复 | 删 stop() / currentText() 优先 / isFinal 停写 / 截断告警 | 每一步的改动点行号全部实读命中；currentText()（StreamRenderBuffer:161-163）= fullText+pending.join('') 恒为完整全文；flushFrame isFinal 条件（:220）finalMarked && pending 空——删 stop() 后循环自然收口成立；streamedFullText 累积点 :837 存在（F1d 断言可用）；F1c 对应 :305-311 现状 stop 路径也写 setStreamText（N2 残留键确认） | **四步设计完全成立** |
| N1 同值帧丢字 | StreamingTextBlock lastDeltaRef 字符串相等判幂等 + memo 短路 | StreamingTextBlock.tsx:27-40 实读：React.memo + `lastDeltaRef.current === delta` 跳过 append——连续同值帧（逐字「哈」「哈」）丢第二帧确认；修复设计（seq prop + [delta, seq] 依赖）合理，StrictMode 双执行仍被拦截 | 成立 |
| V1/V2 判据可测试性 | buffer 层 + hooks 层 >16KB 断言 | StreamRenderBuffer.framing.test.ts 已有 rAF stub（:29-30 vi.stubGlobal）+ flushFinal 用例（:175-250）+ 大残余手动 flush 循环模式（:211-212）；useStreamCallbacks.test.ts 有 renderHook + mock refs 基建——V2 需在 hooks 层补 rAF stub（framing 模式可照搬），其余可测 | **可测试性成立** |
| P3-1 Function import | 5 处 → @vite-ignore 动态 import | skillsApi.ts:214/226/598/616 + api/import/importFsHost.ts:53 五处 Function 实读全部命中（注：importFsHost 实际位于 api/import/ 子目录，方案路径少一层） | 成立 |
| P3-6 死 CSS | 本维度序 6 物理删除 | 与 01 方案 A 块完全同文件同内容——**重复登记**（01 方案先行，02 序 6 应标注移交，防双 Agent 重复执行） | 归口确认 |
| P2-2 O1 / P2-4 C1/C2 | visibilitychange 兜底 / chunk 环检测 + preview 冒烟 | 03 复审 P2-2 自愈面确认；flushFinal 幂等性实读成立（cancelScheduledFlush→markFinal 幂等→预算分支仅处理剩余 pending） | 成立 |

### 1.3 方案 03（卫生门禁升级）

| 项 | 方案设计 | 实读复核 | 结论 |
|---|---|---|---|
| 26 行 mojibake 清单（含 :356 修正） | 4 文件 26 行，分类 18 PUA + 1 GBK 可逆 + 7 特征字 | Python 三层扫描复跑：PUA 18 行（workspace 12/panels 2/polish 2/dragdrop 2）逐行命中；workspace:356 GBK 逆变换实测恢复「滚动区：tabs-bar ws-chrome-scroll」与方案逐字一致；非 PUA 7 行（317/622/panels:1/dragdrop 38/40/58/69）实测含「鈹€ / 鈥? / 閿?」等特征（panels:1 含 ? 替换痕迹，1 特征字+佐证条件可命中） | **清单与分类完全成立** |
| 层 1 PUA 全仓强制零豁免 | 白名单仅层 3 | 全仓 css PUA 实测 163 行（settings-base 54 / settings-models 35 / settings-plugins 19 / chat-markdown 15 / shell-workspace 12 等）+ terminalStore.ts 10 行 PUA——层 1 零豁免必然全仓红，白名单机制必要；挂账规模与 N6（~244 行三层口径）量级吻合 | 成立 |
| 层 2 GBK 逆变换 | 恢复串 CJK≥2 判违规 | 合法中文行逆变换必抛错（UnicodeEncodeError 实测）；「恢复串 ≥2 CJK」条件可防误报 | 成立 |
| 层 3 特征字表 | 弱特征 + 行级白名单 | 特征字表为实跑归纳（表内含鈥/鈹/閿 等实测字），1 字+佐证条件兜底 panels:1 类行 | 成立 |
| N2 门禁未接线 | package.json / ci.yml 零命中 | `rg "css-encoding" package.json ci.yml` 实测零命中——**从未生效坐实** | 成立 |
| D 块基线 66→62 / 633→628 | 999px -4 / !important -5 | 逐行验证：shell-polish:36/58/73 三处 999px ✓、settings-base:2369 一处 ✓（合计 -4 → 62）；settings-plugins:995/996/999/1003/1004 五处 !important ✓（合计 -5 → 628）；BARE_MIX 3 不变 ✓（删除面无裸混色）；shell-polish 行号 18-86 口径比 01 的 17-85 正确 | **推导完全成立** |
| N4 models-btn 零消费 | 01 方案 A7 声称 14 处消费与实读不符 | models-btn tsx 零命中、settings-btn-rect 3 文件 14 处——N4 成立，01 A7 已按此口径执行 | 成立 |
| N7 terminalStore.ts | 唯一中招 .ts，15 行（10 PUA） | 实测 10 行 PUA（:2-39 头注释与 JSDoc）——PUA 层吻合 | 成立 |

### 1.4 方案 04（P2 挂账裁决）

| 项 | 方案设计 | 实读复核 | 结论 |
|---|---|---|---|
| R20 VirtualList 退役 | 业务消费 0（仅自测） | `rg VirtualList` 仅 VirtualList.tsx 自身 + VirtualList.test.ts——零消费成立；test 资产铁律（先确认入库再 git rm）处置正确 | 成立 |
| R5 滚动条契约化 | 12 文件 31 块 → shell-scrollbar 单契约，基线 31→1 | 12 文件实测一致（10 module.css + shell-scrollbar.css + shell-workspace.css）；`::-webkit-scrollbar` 全仓 31 次与 SCROLLBAR_BASELINE 31 吻合；**数字弹性**：shell-scrollbar.css 自身含 5 处选择器（:32/36/39/44/45，scrollbar/track/thumb/hover/active 伪元素不可合并为 1 块）——其他 11 文件清零后实际基线应落 5 而非 1，方案「或按实现计数下调」兜底但建议执行前写清 | 成立（基线按 5 执行） |
| R9 命名对齐 | handleStop/handleForceStop → handleStopGeneration/handleForceCancelGeneration | useAgentStream.ts:378/386 实读命中；消费 AgentCard.tsx:83-84 + InlineAgentPanel.tsx:104-105（2 点 ✓）；**测试同步面漏 1 处**：InlineAgentPanel.markdown.test.tsx:41-42 也传 handleStop（typecheck 会暴露，纯同步遗漏）；useAgentStream.stop.test.ts 存在 | 成立（补测试同步清单） |
| 裁决判据 | 消费点 × 观感 × 死活 | R4/R5/R6/R7/R10 收敛、R8/R14/R18 保留、R20 退役的判据落位与实读消费点计数一致；R9 双轨合并排 02 方案 stop 修复后——时序正确 | 成立 |

---

## 2. 方案间冲突清单

### P0：0 条

### P1：3 条

| # | 冲突 | 证据 | 裁决建议 |
|---|---|---|---|
| C-P1-1 | **style-contract.test.ts 三方争夺**：01 A 块（基线 62/628 联动）+ 03 D 块（同基线）+ 04 W2（SCROLLBAR 31→5）改同一测试文件 | style-contract.test.ts:188/217/233；master plan C-3 只覆盖 01×03，未覆盖 04 W2 的 SCROLLBAR | 三方严格串行（01+03 同提交原子化 → 04 W2 紧随），最后一笔统一跑 23/23；master plan 需把 R2-7 的基线落点明确排在 R2-2/R2-3 之后 |
| C-P1-2 | **03 白名单 dirty-check 时序缺口**：R2-1 门禁先建生成白名单快照（含 settings-base 等挂账行号）→ R2-2 01 A 块物理删除 settings-base.css:1193-1210 等 → 白名单出现「已不命中行号」→ `--whitelist-dirty-check` 立即红 | 01 A5 删 :1194-1210（含 :1193 mojibake 注释行）；03 §2.3 dirty-check 规则 | 01 A 块提交与白名单清理联动（同一提交或紧接提交）；master plan R2-2 批需补「白名单联动清理」步骤 |
| C-P1-3 | **02 方案 P3-6 与 01 方案 A 块重复登记**：同 6 文件同删除面 | 02 §3.2 vs 01 §1.1 | 归口 T-A（master plan R2-2 已定），02 方案序 6 标注「移交 01 A 块」；两方案内部均声明「执行后销除」但未声明**执行归口唯一**——防双 Agent 同时派发 |

### P2：4 条

| # | 冲突 | 证据 | 裁决建议 |
|---|---|---|---|
| C-P2-1 | shell-polish.css 多面操作：01 A-1（删 :18-86）+ 03 A-2（重写 :626/:811 两行乱码） | 同文件不同段 | 同批次同 Agent 串行执行（两任务都小）；03 方案风险 5 已声明 D 块原子化，此处补充 A-2 与 01 A-1 串行即可 |
| C-P2-2 | ChatCard.tsx 三面：01 B-2（聚合）+ 01 C-W2（裸 button）+ 02 序 2（StreamingTextBlock 同值帧——不涉 ChatCard） | master plan C-1 已排 B→C 串行 | 维持串行；02 序 2 文件面独立（StreamingTextBlock.tsx 由 02 独占声明成立） |
| C-P2-3 | 01 A 块删除 vs 03 白名单生成范围重叠（settings-base/theme-dark 等挂账文件行被删） | settings-base:1193（mojibake 注释）在删除段内 | 删除后白名单清理（见 C-P1-2）；03 方案「白名单快照即挂账清单」口径保持 |
| C-P2-4 | 04 W2（R5）触及 11 个 module.css，其中 DiffCard.module.css / shell-workspace.css 同时是 01 A 块删除面（DiffCard:368-378、shell-workspace 无删除面） | DiffCard.module.css 双面 | 同文件串行：01 A-2 先行，04 W2 后行（master plan R2-7 已声明 R5 延后机制，需将 DiffCard.module.css 明确列入） |

---

## 3. 高风险任务

| 风险 | 任务 | 要点 | 缓解 |
|---|---|---|---|
| R-1 核心正确性回归 | 02 P2-1（F1a-F1d） | stop 收口改动同时覆盖 L2/L3 双取消路径；改后「删 stop() 的预算循环自然收口」依赖 buffer 状态机正确性 | V2 关键判据（>16KB 积压 commit 全文无损）+ V3/V4（常态/force）+ streaming-render/tool-streaming e2e 回归；改动面收敛在 2 处小改 + 1 处分支 |
| R-2 混合块拆行误伤 | 01 A-2（settings-plugins.css:986-1005/1011-1019/1034-1040） | 三处混合块均含活选择器成员（settings-btn-rect 14 消费 / settings-chip-btn 3 消费 / settings-rule-preset / sched-preset-chip），拆行错即误删活规则 | 逐块读上下文 + 前置类 rg 复核 + settings 页视觉回归；单提交可 revert |
| R-3 ribbons 构造点未决 | 01 B 块 | ChatStatusRibbons 传参 3 类内部派生（localHasKey/闭包包装/goalMode 派生）上移决策影响接口面 | 派单前裁决：ChatCard 层构造（派生上移）或 ChatComposerWrapper 内 useMemo（需拆 props）；ChatStatusRibbons 非 memo 提供缓冲 |
| R-4 白名单时序 | 03 B-1 ↔ 01 A-2 | 门禁先建后立即被删除面致 dirty-check 红 | 白名单清理与 01 A 块删除同提交；CI 接线 step 落点选择 |
| R-5 滚动条观感 | 04 W2（R5） | 2px/3px 菜单条统一后粗细变化（TiptapSlashMenu:38 等） | 按域保留尺寸档位（方案已允许）；人工抽查菜单/任务卡/设置 tab |
| R-6 门禁误报 | 03 层 2/层 3 | 层 2 合法中文行偶然逆变换成功 / 层 3 片假名 | 「恢复串 CJK≥2」条件 + 行级白名单（仅层 3）；实测零命中支撑已给出 |

---

## 4. 派发就绪度表

| 方案 | 就绪度 | 修订项（派发前必须完成） | 可派面 |
|---|---|---|---|
| 01 | **需修订** | ① A 块补漏登：settings-base:1186-1192、settings-plugins:1016/1038 拆行项；② shell-polish 删段边界改 :18-86；③ B 块 ribbons 构造点裁决 + memo 风险描述修正（spread 面不敏感，敏感面是单 prop 字段）；④ C 块域分布按实测重扫定稿（sidebar/session-list 归类） | A2/A3/A4/A9-A12/D 块可先行 |
| 02 | **直接可派** | 无阻断项；P3-6 标注「移交 01 A 块」（主控确认归口）；importFsHost 路径补全；R9 属 04 不属本方案（无冲突） | 全部 7 步可派；建议序 1（P2-1）+ 序 2（N1）优先 |
| 03 | **需修订** | ① 白名单 dirty-check 与 01 A 块删除的联动步骤写入任务书（同提交或紧接提交）；② 明确「01 A 块 → 03 D 块基线联动」同提交原子化的批次落点（master plan R2-2/R2-3 收口） | 层检测设计、26 行清单、基线推导无需改动 |
| 04 | **直接可派** | R5 基线数字写清「其他 11 文件清零后 shell-scrollbar.css 自身 5 处 → 基线 5」；R9 测试同步补 InlineAgentPanel.markdown.test.tsx | W1（R20）/W3（R9）立即；W2（R5）排在 01 A-2 后（DiffCard.module.css 同文件） |

---

## 附：复核口径与不确定处

- 所有行号基于 2026-08-10 工作区；方案内行号与实读一致率 ~100%（两处漂移：shell-polish 删段边界 17-85 vs 实际 18-86；importFsHost 目录 api/import/）。
- 计数口径：`rg -l "<button" --glob "*.tsx" --glob "!**/ui/**" --glob "!**/*.test.*"` = 101（与 01 方案一致）；`::-webkit-scrollbar` 全仓 31 次（与 04 方案一致）；PUA 层全仓 163 行 css（量级支撑 03 方案 N6）。
- 未实读面：e2e 测试资产（V6 的 data-testid 锚点）、ci.yml 具体 job 结构（接线点细节）、R4/R6/R7/R10 下轮项（本轮不派发，未深挖）。
- 不确定处：B 块「聚合对象稳定引用」建议在 spread 语义下为「无害的保守要求」而非「必需」——若执行 Agent 采用内联 spread，需人工确认 ChatMessageList 字段引用稳定性；01 方案 C 块域分布差异（sidebar 9→5 等）疑似目录归类口径，波次派单前实测重扫即可消解。

（本文档完——四份方案复核：0 P0 / 3 P1 / 4 P2；02/04 直接可派，01/03 修订 2 处清单缺口与 2 处调度缺口后派发）
