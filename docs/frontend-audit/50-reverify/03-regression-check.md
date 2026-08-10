# 批次 1-9 修复回归排查 · 复审文档（50-03）

> 产出：`docs/frontend-audit/50-reverify/03-regression-check.md`
> 复审角色：只读复审子 Agent（实读代码 + 实跑测试，排查批次 1-9 引入的新问题/回归）
> 日期：2026-08-10。输入：`40-final-plan/90-final-report.md`（改造范围）、批次 1-9 提交（e782abe7 / 9b5b2cfe / 9e35f495 / d64a41b8 / add998ed / 33fa13e6 / d14ef9e2 / 1d5b36a4 / 0ab2d2b9）
> 性质：回归排查（非销号复核——销号面见本目录 01/02 文档）；性能正确性为专项重点

---

## 0. 结论速览

| 维度 | 结果 |
|---|---|
| 排查面 | 10 项全查（Tooltip / Button / store 迁移 / 状态治理 / 性能 / 对比度 / CSP / chunk / 测试 / typecheck） |
| 新增问题 | P0 = 0 · P1 = 0 · P2 = 4 · P3 = 6（清单见 §4） |
| 性能正确性 | **complete 收口正确收敛**；stop 大残余路径存在截断风险（P2）；搜索 identity 缓存安全 |
| 测试 | 核心面 305 项全绿（StreamRenderBuffer 44 / 流式组件+hooks 25 / store 79 / ui 原子 52 / 消息行 38 / 样式契约 67）；typecheck ✅；check:store-writes ✅；build ✅ + check-dist ✅ |

**总判定：批次 1-9 未引入结构性回归。** 正常使用路径（流式 complete 收口、搜索缓存、store 迁移、CSP 分层、chunk 拆分）经实读与测试双验证均正确；发现 4 项 P2 均为边缘/观感面，无 P0/P1。

---

## 1. 各面排查结果

| 面 | 发现 | 证据（文件:行号） | 严重度 |
|---|---|---|---|
| Tooltip 迁移（85 文件→ui/Tooltip） | props 兼容：新旧 API 均为 {content, side, disabled, delayHide}；全仓无 placement/theme 旧 props 残留（grep 零命中）；restProps/ref 透传保持 | `ui/Tooltip/Tooltip.tsx:55-61`（props 定义）；旧版 `9e35f495^:components/Tooltip/Tooltip.tsx` 同构；`ui/index.ts:11` | 无 |
| Tooltip 行为差异 | 批次 3 后追加的 F7-F8（01ef652b）新增 focus/blur 触发 + aria-describedby + 视口钳位 + 滚动跟随——点击后保持 focus 的按钮 tooltip 常驻至 blur，属 a11y 标准行为，非回归；消费点抽样（AppTopBar/ChatHeaderMore/OverviewHeader/CardPanelHeader/DiffHeaderControls/TabStrip 等 8 处）均只传 content/side/disabled | `ui/Tooltip/Tooltip.tsx:262-273`（focus 触发） | P3（行为变化登记，需确认无消费点不适） |
| Button 替换（35 文件/120 按钮） | variant 映射完整（primary/secondary/ghost/danger ↔ .ui-btn-*），size sm/md 对齐（--control-height-sm/full 药丸）；aria-pressed/aria-label 经 restProps 透传保留 | `ui/Button/Button.tsx:31-41`（映射表）、`:74-91`；`Button.module.css:32-99` | 无 |
| Button disabled 新行为 | 批次 3 新增 `.button:disabled { opacity: var(--opacity-disabled) }`（0.5）——旧 .ui-btn 无 disabled 规则（满不透明度）。加载态消费点用 `disabled` + 文案切换（如 DiffCardGitActions「提交中…」），现呈半透明，观感像失效 | `Button.module.css:26-29`；`tokens.css:325`；`diff/DiffCardGitActions.tsx:87/99` | P2（加载态观感） |
| store 迁移（type-only/注释改道） | batch 7 的 11 个文件改动全部为注释级（/* ignore */→/* swallow-ok */）+ 零行为变化；6 个抽查文件逐一对 diff 确认 | `git show d14ef9e2`：appMode/sessionQuota/sessionStreamManager/updateStore/hydrateWorkspaceShell/skillsApi/workspaceFsApi/agentProfiles/commandPermissions/sessionSearch | 无 |
| store/README 过期描述 | README 未反映 batch 5 的 sessionActions 拆分（sessionCrud/Folder/Message/Agent/Ordering 5 文件）与 D2 连接态真源（errorStore.connectionStatus），日期仍标「2026-07」 | `store/README.md:44-61`（未列拆分文件）、`:10-17` | P3（文档） |
| D2 连接态全切换 | useConnectionStatus 消费 4 组件全覆盖（RuntimePanel/BgTasksSection/PlansSection/LiveTasksSection）；engineOnline 全仓零残留（仅注释提及）；SettingsProfileTab 的 getTransport().isReady() 为独立既有面 | `components/workspace/{RuntimePanel,BgTasksSection,PlansSection,LiveTasksSection}.tsx`；`hooks/useEngineState.ts:12` | 无 |
| D8 rustCoreStore 删除 | 全仓零残留引用（仅 StatusDiagnosticsPanel.tsx:163 一条过时注释）；store/index.ts 导出已删 | `rg rustCoreStore`；`git show add998ed -- store/rustCoreStore.ts` | P3（残留注释） |
| raw setState→action 语义等价 | 抽样 S1-S3（subagentHandlers）+ U1-U5（useStreamCallbacks）逐条对 diff：终态工具卡守卫、scope 收窄（sessionId）、纯函数复用均内建，语义等价；门禁 `check:store-writes` 扫描 997 生产文件 raw setState = 0 | `git show add998ed -- subagentHandlers.ts`（S1/S2）；`useStreamCallbacks.ts:457-460/677/757/766/1048`；`check-no-raw-setstate.mjs` ✅ | 无 |
| 对比度副作用（--text-tertiary） | light #696969（原 color-mix 70% 次级 ≈#8a8a8a，对比 ~2.6:1→4.9:1）/ dark #8f8f8f；542 处消费含 syntax-comment——加深后三级层次扁平化（接近次级），观感更「重」，但 a11y 正确 | `tokens.css:25/450`；`git show 33fa13e6 -- tokens.css` | P3（观感） |
| --text-warning-strong 消费面 | #c2410c（4.55:1）；覆盖：StatusDiagnosticsPanel.module.css:200、--ui-text-warning 别名（tokens.css:136）、dark 分支（:524）；无悬空定义/引用 | `tokens.css:125/136/524`；`a11y-contrast.test.ts` 44 断言全绿 | 无 |
| CSP 分层（dev/prod） | dev = DEV_CSP（'unsafe-inline' 'unsafe-eval' + connect-src ws: http: https: → HMR/代理面全通）；prod = 严格串 + 内联 script sha256 构建期自动算（dist/index.html:183 实测含 sha256-…）；dist 全量扫描 **无 eval/Function 残留** | `vite.config.ts:16-27/66-106`；dist 实测 | 无 |
| CSP 与 Function() 模式 | 生产代码 5 处 `Function('return import("@tauri-apps/…")')`（skillsApi.ts:214/226/598/616、importFsHost.ts:53）——prod CSP 下抛 EvalError（被 catch → 回退）。但批次 7 前**本无任何 CSP**（index.html/tauri.conf.json 双无），且裸标识符动态 import 在浏览器构建本就不可解析 → 失败形态从 import 解析错转为 EvalError，**净行为 ≈ 无变化**；revealSkillPath 在浏览器构建中本就不可用（既有缺口） | `git show d14ef9e2^`（无 CSP 证据）；`dist/assets/skillsApi-D6cbBz6H.js`（Function 保留） | P3（建议静态 import 真修复） |
| chunk 拆分 | build ✅ 77 chunks 无告警；App 501421 B = 489.7 KiB < 500 KiB 门禁（check-dist 用 1024 进制）✅；lazy 点（BinaryTreeWorkspace/SettingsPanel/PreviewCard/ToastStack 等）chunk 文件均在 dist 实测存在；manualChunks 循环修复（/react/ 收窄）方向正确（vendor-zustand/tiptap → vendor-react 单向） | `vite.config.ts:330-367`；`node scripts/check-dist.mjs` ✅ | 无 |
| chunk 运行期冒烟缺口 | build 门禁覆盖不到运行期 import 解析；perf-streaming/tauri-native-smoke 需 Tauri 运行时，本次无法执行 → 拆分后运行期未冒烟（登记） | `tests/e2e/perf-streaming.spec.ts`（需 Tauri）；报告 §4 同口径 | P2（验证缺口，非代码缺陷） |

---

## 2. 性能正确性专项结论（batch 8 关键面）

### 2.1 StreamingTextBlock appendText：终稿收敛 ✅

- **增量面**：`StreamingTextBlock.tsx:33-40` children 恒空 + useLayoutEffect appendChild（O(Δ)）；lastDeltaRef 幂等守卫（StrictMode 双执行/同值帧双保险）；单调性由 IncrementalThoughtStripper 保证（`markdownRenderLite.ts:141-239` 完成行窗口 + 尾行缓冲，`next()` 同值幂等/收缩 resync）。
- **resync 面**：文本收缩 → resynced=true + streamKey+1 重挂载（`MessageContent.tsx:206-215`），重挂载节点从零累积，reset() 后 lastFull='' 保证下一帧全量重放一次，无重复（lastDeltaRef 再拦截）。
- **终稿收敛面**：complete → isFinal 帧 → finishComplete → `commitStreamToSession(text = buffer.currentText())`（`helpers.ts:192-225`：updateMessageText 全量终稿 + clearStream）→ MessageContent live=false → AsyncMarkdownBlock 全量渲染。**buffer.fullText 在 flushFrame 内部累积，不依赖 onFrame 是否被守卫丢弃**（`StreamRenderBuffer.ts:210`）——drain 中间帧即使被 gen 守卫丢弃，isFinal 帧提交的仍是完整全文。✅ 最终一致性成立。

### 2.2 complete 分帧 drain：丢帧风险 ✅（附 P2 边缘）

- **complete 路径**（onComplete，`useStreamCallbacks.ts:941-969`）：draining=true → flushFinal() → 残余 ≤16KB 同步 force 单帧（isFinal 同步到 → finishComplete 同步执行）；大残余走 rAF 预算循环，drain 期间中间帧放行（`if (runClosed && !draining) return` 不拦截），isFinal 帧无守卫恒落盘。**无 stop() 调用，循环不中断** ✅。
- **新 run 接管**：drain 中间帧被 myGen 守卫丢弃（generationMap 已换代），isFinal 帧不受守卫影响但写旧 msgId 键（与新房不同键，无跨写）；commit 文本 = buffer.currentText()（完整）。✅ 设计闭环。
- **P2-1 stop 路径截断**：`finalizeStopGeneration`（`useStreamCallbacks.ts:1003-1007`）= `flushFinal()` 后紧跟 `stop()`。残余 >16KB 时 flushFinal 走预算分支只刷 ≤8192 字符（该帧还被 `!assertLive()` 守卫丢弃——streamManager entry 已删），随后 scheduleFlush 的 rAF 被 stop() 取消 → **isFinal 帧永不到达，pending 残余滞留**。`partialText = getStreamText(...) || stopBuf?.currentText()`（`:1015-1021`）——getStreamText 为「停止前最后一帧」的陈旧值（非空）→ 短路取陈旧截断文本 → commitStreamToSession 落盘**截断终稿**。旧实现 `push('',true); flush(true)` 同步 force 全刷，无此问题。触发条件：stop 时 pending 积压 >16KB（后台标签页 rAF 节流/主线程繁忙期间积累）。
- **P2-2 complete 大残余收口延迟**：预算 drain 依赖 rAF；后台标签页 rAF 被 Chromium 节流 → finishComplete（commit/status/HTML）推迟至标签页回前台。自愈、无数据丢失（buffer 持全文）。

### 2.3 搜索 identity 缓存：immer 下安全 ✅

`MustIncludeHitCache`（`messageWindow.ts:357-435`）键 = msgId + **引用等值**（`cached.msgRef === m`）。immer 结构共享保证「内容变 ⇒ 引用变」——任何经 setState(immer) 的消息更新都产生新引用 → 必重算；引用不变 ⇒ 内容未变 ⇒ 命中复用正确。queryKey（规范化 query）变更整体失效；msgId 跨会话复用需引用不同 → 重算；byId 膨胀 >2× 列表长度时清空。流式期只写 streamingStore（layout messages 引用稳定）→ 命中 O(1)/帧；processingNow 期 windowScanKey 降级为 id 签名（尾部窗口不变），complete 后恢复引用扫描。**结论：无陈旧命中路径，安全。**

---

## 3. 测试运行结果（全部实跑）

| 测试面 | 命令/文件 | 结果 |
|---|---|---|
| StreamRenderBuffer 分帧 | `StreamRenderBuffer.framing.test.ts` (18) + `StreamRenderBuffer.test.ts` (17) | ✅ 35/35 |
| 搜索性能/缓存 | `searchPerf.test.ts` (9) | ✅ 9/9 |
| 流式组件 | `StreamingTextBlock.test.tsx` (8) + `ChatMessageList.windowScan.test.tsx` (4) | ✅ 12/12 |
| 流式 hooks | `useStreamCallbacks.test.ts` (5) + `useStreamCallbacks.streamStore.test.ts` (8) | ✅ 13/13 |
| store 面 | `streamingStore.test.ts` (20) + `sessionActions.newWrites.test.ts` (21) + `storeFacades.test.ts` (7) + `storeAccess.test.ts` (31) | ✅ 79/79 |
| ui 原子组件 | Tooltip (10) + Button (7) + TabStrip (12) + Switch (9) + Select (14) | ✅ 52/52 |
| 消息行/连接态 | `ChatMessageRow.test.ts` (16) + `AsyncMarkdownBlock.test.tsx` (8) + `useConnectionStatus.test.ts` (5) + `BgTasksSection.test.tsx` (9) | ✅ 38/38 |
| 样式契约 | `a11y-contrast.test.ts` (44) + `style-contract.test.ts` (23) | ✅ 67/67 |
| 门禁 | `tsc -b` typecheck（含全部本次改动面）| ✅ 无错误 |
| 门禁 | `npm run check:store-writes`（997 生产文件） | ✅ raw setState = 0 |
| 构建 | `npm run build`（10.5s 无告警）+ `node scripts/check-dist.mjs`（App 489.7 KiB < 500 KiB、tiptap/xterm/App 拆分断言） | ✅ 全过 |

无法执行面：`tests/e2e/perf-streaming.spec.ts` / `tauri-native-smoke.spec.ts`（需 Tauri 运行时，环境不支持）——已登记 §4-P2-4。

---

## 4. 新问题清单

| # | 级别 | 问题 | 位置 | 建议 |
|---|---|---|---|---|
| P2-1 | P2 | **stop 大残余截断**：>16KB 积压时 `flushFinal()+stop()` 序列中断预算 drain，isFinal 不到达，getStreamText 陈旧值短路 currentText() → commit 截断终稿 | `useStreamCallbacks.ts:1003-1007` + `StreamRenderBuffer.ts:117-127` | stop 路径：flushFinal 后不调用 stop()（让 rAF 循环自然收口）或改用 force 语义；partialText 优先 `stopBuf.currentText()` 而非 getStreamText |
| P2-2 | P2 | complete 大残余 drain 依赖 rAF，后台标签页节流时收口推迟（自愈、无丢失） | `StreamRenderBuffer.ts:171-176` | 可接受；如需强收口可在 `document.visibilitychange` 回前台时触发 flushFinal |
| P2-3 | P2 | 加载态按钮 50% opacity：disabled+文案切换的消费点（DiffCardGitActions 等）加载中呈半透明 | `Button.module.css:26-29`；`DiffCardGitActions.tsx:87/99` | 迁移消费点改用 `loading` prop（spinner + 不透明度语义化）或对 loading 态豁免 opacity |
| P2-4 | P2 | 生产构建运行期无冒烟：chunk 拆分/CSP 严格串仅在 build 门禁层验证，Tauri 运行时面（懒加载 import、asset 协议、IPC）未覆盖 | `vite.config.ts:330-367`；ci.yml frontend-build job | 有 Tauri 环境时补一次 `tauri-native-smoke`/perf-streaming 运行 |
| P3-1 | P3 | 生产代码 5 处 `Function('return import(...)')`：prod CSP（无 unsafe-eval）下失败形态变为 EvalError；revealSkillPath 等在浏览器构建本就不可用（既有缺口，非本批引入） | `skillsApi.ts:214/226/598/616`、`importFsHost.ts:53` | 改静态 import（插件模块本就应打包期解析），顺带真修复 reveal 功能 |
| P3-2 | P3 | --text-tertiary 加深（#696969/#8f8f8f）后三级文字层次扁平化观感（a11y 正确性优先，登记视觉确认） | `tokens.css:25/450` | 视觉验证轮次确认 |
| P3-3 | P3 | store/README 过期：sessionActions 拆分文件、D2 连接态真源未载明，日期 2026-07 | `store/README.md:44-61` | 文档同步 |
| P3-4 | P3 | StatusDiagnosticsPanel.tsx:163 残留「DEAD: rustCoreStore」过时注释 | `components/settings/StatusDiagnosticsPanel.tsx:163` | 清理注释 |
| P3-5 | P3 | Tooltip focus 触发行为登记：点击后保持 focus 的按钮 tooltip 常驻至 blur（a11y 标准，消费点需目视确认无「粘滞」不适） | `ui/Tooltip/Tooltip.tsx:262-273` | 视觉验证轮次确认 |
| P3-6 | P3 | `.ui-btn` 全局体系死 CSS 残留（shell-polish.css:18-84 等 6 文件）——01 文档已登记 P1-1「退役未完成」，此处确认无运行时影响（ui/Button 与全局类名互不冲突） | `shell-polish.css:18-84` | 随 01 文档挂账物理清理 |

---

## 5. 总结论

批次 1-9 修复经实读 + 305 项核心测试 + typecheck + 构建门禁四重验证：**无 P0/P1 级新回归**。性能改造（批次 8）的核心正确性成立——流式增量与终稿收敛一致、complete 分帧无丢帧、搜索 identity 缓存与 immer 语义兼容；唯一实质风险为 **stop 路径大残余截断（P2-1，边缘但会造成文本丢失）**，建议下轮优先修复。CSP 分层与 chunk 拆分在构建面验证充分，运行期冒烟留待有 Tauri 环境时补验。共登记新问题 10 项（P2×4 / P3×6），无结构性阻断项。

（本文档完——批次 1-9 回归排查闭环）
