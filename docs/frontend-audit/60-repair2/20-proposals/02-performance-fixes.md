# 第二轮修复 · 性能修复维度方案（02-performance-fixes）

> 产出：`docs/frontend-audit/60-repair2/20-proposals/02-performance-fixes.md`
> 角色：方案设计子 Agent（只读 + 本方案文档）。输入：复审 03（`50-reverify/03-regression-check.md`）P2-1 与 P2 性能边缘、批次 8 实现文档（`40-final-plan/10-details/08-performance-detail.md`）、实读代码。
> 实读代码基线：2026-08-10 工作区（`StreamRenderBuffer.ts`、`useStreamCallbacks.ts`、`StreamingTextBlock.tsx`、`helpers.ts`、`vite.config.ts`、既有测试）。
> 性质：只读 + 写盘一份方案文档（本会话无代码改动）。编码：UTF-8 无 BOM，中文。

---

## ① P2-1：stop 大残余截断——根因定位与修复设计

### 1.1 根因链（实读证据，双重缺陷叠加）

`finalizeStopGeneration`（`useStreamCallbacks.ts:992-1080`）同步执行序列：

```
:1000-1001  streamManagerRef 删 entry + generationMapRef 删 entry
:1006       stopBuf?.flushFinal()
:1007       stopBuf?.stop()          ← 缺陷一：中途取消预算循环
:1015-1021  partialText = getStreamText(...) || stopBuf?.currentText() || ...
:1024-1025  commitStreamToSession({ text: stopText })   ← 落盘
```

**缺陷一：`stop()` 中断预算 drain**。`flushFinal()`（`StreamRenderBuffer.ts:117-127`）：
- 残余 ≤ 2×maxBytesPerFrame（默认 16KB，常态）→ `flushFrame(true)` 同步单帧全刷 → 帧 `isFinal=true` 同步到达 onFrame → 完整落盘（此路径正确）；
- 大残余（异常积压 >16KB）→ `flushFrame(false)` 预算循环：首帧只刷 ≤8192B，**isFinal=false**，剩余 pending 经 `scheduleFlush()`（rAF）排下一帧（`StreamRenderBuffer.ts:230-232`）——随后 `stopBuf?.stop()`（`:147-149`）`cancelScheduledFlush()` **取消调度，isFinal 帧永不到达**。

**缺陷二：残余帧被 `assertLive()` 守卫丢弃 + `partialText` 取陈旧值**。首帧（非 final）进 `onFrame`（`useStreamCallbacks.ts:313-319`）：
- `runClosed` 为 false（stop 路径从不置位）→ 第一守卫放行；
- `if (!assertLive() && !draining) return;`（`:316`）——`assertLive()` 经 `isLiveStreamRun`（`helpers.ts:296-302`）查 streamManager entry，而 entry 已在 `:1000` 删除 → `get(sid)` 为 undefined → **帧被丢弃，不写 streamingStore**；
- 随后 `partialText = getStreamText(...) || stopBuf?.currentText() || ...`（`:1015-1021`）——`getStreamText` 是「停止前最后一帧」写入的陈旧截断值，非空即短路，`stopBuf.currentText()`（此刻实为完整全文：`fullText + pending.join('')`，`StreamRenderBuffer.ts:161-163`）**永不参与** → commit 落盘截断终稿。

**触发条件**：stop 时 buffer 积压 >16KB（后台标签页 rAF 节流 / 主线程繁忙 / 大块输出突进期间积累）。**结果**：文本丢失（mock-engine 100KB 流式 + 中途 stop 必现）。旧实现（批次 8 前）`push('', true) + flush(true)` 为同步 force 全刷，无此问题——**回归由 08-detail T2.2 接线引入**：flushFinal 的大残余分支与残留的 `stop()` 调用、以及 partialText 优先级顺序未被同步调整。

### 1.2 修复设计（主推方案 B：最小面同步收口）

| # | 改动 | 文件:行 | 说明 |
|---|---|---|---|
| F1a | **删除 `stopBuf?.stop()`** | `useStreamCallbacks.ts:1007` | flushFinal 后不再取消 rAF。buffer 已 `finalMarked`（`StreamRenderBuffer.ts:79`），后续 onChunk 的 `push` 被拒绝，预算循环至多 N 帧自然收口于 isFinal 帧，无副作用 |
| F1b | **partialText 优先级换序**：`stopBuf?.currentText()` 优先 | `useStreamCallbacks.ts:1015-1021` | `currentText()` = fullText + pending.join('') 恒为完整全文（大残余首帧同步刷入 ≤8KB 后剩余仍在 pending 中）；`getStreamText` 降为兜底 |
| F1c | **isFinal 帧 stop 路径不写 streamingStore** | `useStreamCallbacks.ts:305-312` | stop 路径收口由同步段完成（commit 已含全量文本 + `clearStream`），isFinal 帧（commit 之后 rAF 异步到达）仅为预算循环终止信号——跳过 `setStreamText`，避免 commit 后残留写入（残留键不再被消费，但避免 byKey 累积）。complete 路径（`draining`）分支保持原逻辑不变 |
| F1d | **截断告警（防御断言）** | `useStreamCallbacks.ts:1024-1025` 附近 | commit 后断言 `committedText.length >= streamedFullText.length`（onChunk 累积全程 = buffer 输入总量，`streamedFullText` `:265`）；不满足 → `console.warn` + `recordStreamDiag`（kind: 'stop-truncation'）。正常路径恒等，此断言为将来任何 drain 回归的哨兵 |

**收口语义（修复后）**：
- ≤16KB 常态：flushFinal 同步 force 单帧，isFinal 帧同步到达（不写 store），同步段 commit 完整文本——**行为与批次 8 前一致**；
- >16KB 大残余：flushFinal 同步刷首帧（被守卫丢弃，无 UI 影响），同步段以 `currentText()` **立即 commit 完整终稿**——UI 在 stop 点击同帧内切完成态并全量渲染，预算循环仅作后台无害收尾（isFinal 到达即终止）——「立即出完整 partial」语义保持，无长任务；
- 新 run 接管：stop 后新 run 建新 buffer/新 entry，旧 buffer 循环独立跑完（isFinal 分支 return，零写入），零冲突；
- force cancel（L3）与 L2 走同一 `finalizeStopGeneration`，同修复生效。

**备选方案 A（登记不主推）**：stop 收口完全由 isFinal 帧驱动（`finishStop`，与 `finishComplete` 对称）——大残余时 UI「自然流完」而非立即跳终稿。需跨闭包共享收口函数（`finalizeStopGeneration` 与 `onFrame` 为平级函数体，需 ref 桥接），复杂度与回归面显著更大；对 stop 语义（用户已主动中断）收益低。**若评审否决 B 的「立即出终稿」体验再启用 A**。

### 1.3 验证设计（重点：>16KB 积压断言终稿完整）

| # | 层 | 用例 | 断言 |
|---|---|---|---|
| V1 | buffer 层（`StreamRenderBuffer.framing.test.ts` 扩展） | 对照锁定缺陷语义：64KB 残余 `flushFinal()` 后调用 `stop()` → 手动循环 flush → 断言残余滞留（修复前行为契约，防 `stop()` 被重新引入）；对照：不调 `stop()` → 循环刷至 isFinal 且拼接 = 全文 | `stop()` 中断预算循环为明确行为契约；收口路径不再调用它 |
| V2 | hooks 层（`useStreamCallbacks.test.ts` 扩展，**关键判据**） | 注入 `new StreamRenderBuffer({ maxBytesPerFrame: 64 })`（阈值 128B，模拟 >16KB 积压）→ 走 runStreamingAssistant（mock `streamAssistantResponseApi` 推 160B 文本）→ `handleStopGeneration()` → 手动 flush 循环跑完 rAF（测试基建 rAF 为 stub） | **session 消息 `text` === 160B 全文（无截断）**；`streamingStore` 无残留；`bufferedLength()` 归零 |
| V3 | hooks 层 | ≤2 帧常态：小残余（100B）stop → 同步收口 | commit 文本完整；收口同步（无 rAF 依赖） |
| V4 | hooks 层 | force cancel（L3）同场景 | 与 V2 同判据 |
| V5 | hooks 层 | 截断告警：构造 `committedText < streamedFullText`（注入截断 buffer 模拟回归） | `console.warn` / diag 被调用 |
| V6 | e2e（新 `tests/e2e/stop-truncation.spec.ts`，挂 e2e-l2） | `installMockEngine` + `bigRunEvents()`（100KB）→ 流式中途点击 Stop（data-testid 待实现时确认）→ 完成态断言 | 完成态文本含 `marker-0` 至 `marker-119` 全量；无 `## 本轮总结` 残留 |
| V7 | 门禁 | `npm run typecheck` + 快层 vitest + streaming-render / tool-streaming e2e | 全绿（回归面锁定） |

---

## ② P2 性能边缘

### 2.1 P2-2：complete 大残余 drain 后台标签页节流（登记 + 可选兜底）

- 现状：`onComplete` → `draining=true` → `flushFinal()` → 大残余预算 drain 依赖 rAF（`StreamRenderBuffer.ts:171-176`）；Chromium 后台标签页 rAF 被节流（~1Hz 或暂停）→ `finishComplete`（commit/status/HTML）推迟至回前台。**自愈、无数据丢失**（buffer 持全文，回前台 rAF 恢复后自然收口）——03 复审判定可接受，本方案维持。
- 可选增强（O1，低风险小步）：`document.visibilitychange` 回前台时若 `draining && buffer.bufferedLength() > 0` → 再次 `buffer.flushFinal()`。`flushFinal` 重复调用幂等安全（`cancelScheduledFlush` → `markFinal` 幂等 → 预算分支仅处理剩余 pending），回前台即刻恢复收口节奏。判据：visibilitychange 场景单测（stub 事件 + 断言再次 flushFinal 后残余递减）。
- **不落地亦可**（自愈面已闭环）；O1 仅为体感优化，排最低优先级。

### 2.2 P2-4：chunk 拆分运行期冒烟缺口（本轮可落地部分 + Tauri 面登记）

任务书点名的「懒加载循环依赖风险（chunk 拆分后）」与此项同面。03 复审已证：构建面 77 chunks 无告警、vendor 循环已修复（/react/ 收窄，`vite.config.ts:330-367`）、lazy 点 chunk 均在 dist；**缺的是「运行期 import 解析」与「chunk 级依赖环」两层**——manualChunks 手写函数特有的风险：源码模块级无环（depcruise 门禁），但模块被分入不同手动 chunk 后可能产生 **chunk 级循环引用**（运行期模块初始化顺序依赖错误），构建器未必告警，只有运行期冒烟可暴露。

| # | 任务 | 文件面 | 判据 |
|---|---|---|---|
| C1 | **chunk 依赖环静态检测**：构建后解析 `dist/assets/*.js` 的 `import` / `import("...")` 语句（es2022 输出保留静态 import 语法）建 chunk 有向图，检测环并输出环路径；无环通过 | `scripts/check-chunk-cycles.mjs`（新，入库） | 挂 ci frontend-build job 或 check-dist 同链；77 chunks 断言零环（先本地跑通再接线） |
| C2 | **生产构建运行期冒烟（preview）**：`vite build` + `vite preview`（严格 CSP 串生效）→ 逐一打开 lazy 点（BinaryTreeWorkspace / SettingsPanel 各 tab / PreviewCard / ToastStack / CheatsheetModal / FirstRunWizard 等 40 处抽样 10+ 处）断言渲染 + 无 console error | `tests/e2e/preview-smoke.spec.ts`（新，挂 e2e-l2） | 所有抽样 lazy 点渲染成功；懒加载 import 解析 + CSP 双重运行期覆盖 |
| C3 | Tauri 原生面（asset 协议 / IPC + 懒加载） | `tauri-native-smoke.spec.ts` / `perf-streaming.spec.ts`（既有） | 环境具备时执行（CI Tauri job 或本地）；本轮环境不可用则登记挂账 |

C1+C2 覆盖「运行期 import 解析」的最大风险面（浏览器侧）；Tauri asset 协议面保留登记。`check-chunk-cycles.mjs` 属一次性脚本，按 AGENTS.md 测试资产铁律随批入库。

### 2.3 边界登记（03 复审 P2 面中非本维度项）

- P2-3（加载态按钮 50% opacity）：观感面非性能维度，交由 UI 修复维度（迁移 `loading` prop 或对 loading 态豁免 opacity），本方案不承接，仅登记防漏。

---

## ③ P3 零星（03 复审 P3 清单中性能相关项）

### 3.1 P3-1：生产代码 5 处 `Function('return import(...)')` 撞 CSP

- 位置：`skillsApi.ts:214/226/598/616`、`importFsHost.ts:53`。prod CSP（无 unsafe-eval）下失败形态为 EvalError（被 catch → 回退），03 复审判定净行为 ≈ 无变化，但**这是懒加载可靠性的技术债**：EvalError 形态在错误上报/诊断里是误导性信号，且与「生产构建禁 eval」基线（03 复审：dist 全量扫描无 eval/Function 残留——5 处 Function 在 dist 中实测保留，属特例面）冲突。
- **低风险修复（本轮）**：`Function('return import("@tauri-apps/...")')` → `import(/* @vite-ignore */ '@tauri-apps/...')` + try/catch。浏览器构建下 @vite-ignore 使 rollup 不做静态解析、URL 运行期解析失败 → reject → catch 回退——**失败形态从 EvalError 转为普通 import 拒绝，净行为不变但消除 eval 面**；Tauri 构建下行为不变。
- **真修复（登记后续）**：静态 import（插件模块打包期解析）——需确认 @tauri-apps 模块在浏览器构建的可解析性（体积/打包风险未评估），留待独立评估。
- 验证：typecheck + build（dist 扫描断言 eval/Function 面清零）+ 现有 skillsApi 相关测试回归。

### 3.2 P3-6：`.ui-btn` 全局体系死 CSS（性能/整洁边缘）

- 位置（01 文档 P1-1 登记收尾 + 03 复审 P3-6 确认零运行时影响）：`styles/shell/shell-polish.css:18-84`（12 条 .ui-btn 定义）、`components/diff/DiffCard.module.css:368`（`.applyActions :global(.ui-btn)` 死规则）、`styles/settings/settings-base.css:555/816/1198-1200`、`settings-plugins.css:986-1002`、`settings-advanced.css:472`（零消费选择器）。
- 任务：物理删除上述死定义/死规则（TS/JSX 面零消费已双证：03 复审 + 01 文档）；文件共 6 个。
- 验证：删除后 `rg "ui-btn"` 生产面仅剩 `ui/Button/Button.tsx` 注释引用（预期）；build + style-contract 测试全绿；视觉抽查（Button 主消费点 5 处）。
- 与 02 域 H2 收尾口径合并（02 文档同样登记），本维度执行后 01/03 的 P1-1/P3-6 挂账同步销除。

### 3.3 非性能 P3（P3-2 观感 / P3-3 README / P3-4 注释 / P3-5 Tooltip 行为）

非本维度承接，登记防漏（交 UI/文档维度）。

---

## ④ 执行顺序（仅逻辑顺序，非强制提交划分）

| 序 | 任务 | 依赖 | 完成判据 |
|---|---|---|---|
| 1 | P2-1 修复（F1a-F1d）+ V1-V5 单测 + V6 e2e | 无（核心缺陷优先） | V2 关键判据绿：>16KB 积压 stop 终稿完整；V7 门禁全绿 |
| 2 | 新发现 N1：StreamingTextBlock 同值帧丢失（见⑤）+ 单测 | 独立于 1（不同文件面，可并行窗口） | append 累积 = 逐帧 delta 拼接（含同值帧） |
| 3 | P2-2 O1 可选兜底（visibilitychange） | 1 之后（同 useStreamCallbacks 文件，串行） | 兜底单测绿；不落地则登记关闭 |
| 4 | P2-4：C1 check-chunk-cycles + C2 preview-smoke | 无（独立面） | 77 chunks 零环；抽样 lazy 点全部渲染 |
| 5 | P3-1 Function → @vite-ignore 动态 import | 无 | dist 扫描 eval/Function 面清零；回归全绿 |
| 6 | P3-6 死 CSS 物理删除 | 无 | rg 消费面确认 + build + 样式契约测试 |
| 7 | 全量收口：typecheck + 快层 vitest + 中层全量 + 5 个 markdown-editor 专项 e2e | 1-6 全部 | 全绿 |

同文件串行纪律：`useStreamCallbacks.ts` 由序 1 与 3 独占（2/4/5/6 不碰）；`StreamingTextBlock.tsx` 由序 2 独占；其余文件面无交叉。闭环：序 7 发现回归 → 回到对应序修复 → 重跑门禁（可多轮迭代）。

---

## ⑤ 新发现（实读代码发现的新性能/正确性项）

| # | 级别 | 问题 | 证据 | 处置 |
|---|---|---|---|---|
| N1 | **P2** | **StreamingTextBlock 同值帧丢字（显示面）**：`lastDeltaRef` 以「delta 字符串相等」判幂等（`StreamingTextBlock.tsx:31-40`），叠加 `React.memo` 的 props 相等短路（`:27`）——连续两帧 delta 字符串相同（如模型逐字输出「哈」「哈」，或短重复 token）时第二帧被判定「已写」跳过 append → **流式期 UI 显示缺字**。终稿不受影响（commit 走 store 全量，03 复审 2.1 已证），故 03 复审 25 项流式测试未暴露（均只断言终稿） | `StreamingTextBlock.tsx:27-40`；delta 派生端 `MessageContent.tsx`（stripper 逐帧切片） | 修复：新增单调 `seq` prop（帧序号），memo 比较与 effect 依赖改为 `[delta, seq]`，`lastDeltaRef` 记录「已写 seq」——StrictMode 双执行（同 seq）仍被拦截，同值新帧（seq+1）照常 append。契约红线（children 恒空）不变。单测：连续同值帧拼接完整 + StrictMode 双执行不重复（适配 08-detail 2.4 既有守卫测试） |
| N2 | P3 | **stop 路径 isFinal 帧残留 streamingStore 写入**：commit 后 rAF 异步到达的 isFinal 帧仍 `setStreamText` 旧键（`:305-309`）——byKey 累积一个无消费残留键。随 F1c 一并消除 | `useStreamCallbacks.ts:305-312` | F1c 内修（stop 路径 isFinal 分支跳过写入） |
| N3 | P3 | **onRunError 路径 `flush(false)` 预算刷残余帧**（`:935`）：error 后消息被 withdraw 或置 error，残余帧写入 streamingStore 无消费（无害）；但 >16KB 大残余同样走多帧 rAF——若 error 后立刻新 run，旧 buffer 循环与 complete drain 同语义（写旧键） | `useStreamCallbacks.ts:935` | 登记说明，不修（无害面；error 收口无需完整文本） |
| N4 | 信息 | **`flushFinal()` 重复调用幂等安全**（cancelScheduledFlush → markFinal 幂等 → 预算分支仅处理剩余 pending）——P2-2 O1 兜底与「回前台再收口」的可行性依据 | `StreamRenderBuffer.ts:117-127` | 支撑 O1 设计 |
| N5 | P3 | **stop 路径 `runClosed` 从不置位**：stop 后旧 run 的 onFrame 守卫依赖 `assertLive()`（entry 已删）拦截中间帧——语义依赖 entry 删除时机，属隐式耦合；F1c 落地后 onFrame 的 stop 面仅剩 isFinal 终止信号，中间帧守卫保持现状（丢弃无害） | `useStreamCallbacks.ts:313-319`、`:1000` | 登记说明，不修（现状行为正确） |

---

## ⑥ 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | stop 收口改动（F1a/F1c）回归 L2/L3 取消路径 | 取消后文本缺失/状态错乱 | V3/V4 单测 + streaming-render / tool-streaming e2e 全绿；改动面收敛在 2 处小改 + 1 处分支，可精确 diff |
| 2 | 删除 `stop()` 后旧 buffer 预算循环生命周期延长（后台标签页 rAF 节流时 isFinal 延迟） | 无功能影响（commit 已同步完成），仅后台空转几帧 | 循环至多 pending/maxBytes 帧数；`finalMarked` 拒绝后续 push；buffer 随下个 run 的 reset/GC 回收；登记为预期行为 |
| 3 | N1 修复引入 seq prop：memo 命中率变化 | 每帧重渲染一次（流式帧 seq 恒变）——与现状 delta 变化必重渲染一致，无额外成本 | 比较器仅加 seq 字段；reRenderMonitoring 断言流式期非流式块零渲染（既有 T1.7 面）不回归 |
| 4 | C1 chunk 环检测脚本对 minified 输出解析脆弱 | 误报/漏报 | 先本地跑通 77 chunks 实测再接线；正则限定 es2022 输出格式；环检测为纯图算法（模块名归一化） |
| 5 | C2 preview-smoke 增加 CI 时间（build ~10s + preview 启动） | 中层 job 时长 | 抽样 10+ 处非全量；复用既有 playwright e2e-l2 project；必要时降为夜间 perf-test.yml |
| 6 | P3-6 死 CSS 删除存在未覆盖的运行时类名消费 | 观感回归 | 03 复审 + 01 文档已双证零消费（TS/JSX grep 零命中）；动态内容面（md-rendered 产物由 Rust 渲染，不产 ui-btn）确认无引用；build + 样式契约测试 + 5 处视觉抽查 |
| 7 | P3-1 @vite-ignore 后 Tauri 构建下动态 import 解析面变化 | 插件功能回归 | Tauri 下相对路径解析语义与 Function 版一致（运行期 import）；skillsApi 相关测试回归 + 构建双面验证；真修复（静态 import）另行评估 |
| 8 | 多维度同文件冲突：`useStreamCallbacks.ts` 亦属其他修复维度面 | 合并冲突 | 序 1/3 独占声明；AGENTS.md 子 Agent 同文件串行纪律；提交精确 add 本域文件 |
| 9 | V6 e2e 的 Stop 按钮定位不稳（data-testid 缺失） | 测试脆弱 | 实现时确认既有 stop 控件测试锚点（`streamStop`/`handleStopGeneration` 消费面），无则补 data-testid（测试资产随批入库） |

---

**一句话摘要**：P2-1 以「删除 stop() 取消 + partialText 换序 currentText() 优先 + isFinal 帧 stop 面停写 + 截断告警」四步最小面修复 stop 大残余截断（关键判据：>16KB 积压 stop 后终稿完整），另修新发现的两帧同值 delta 丢字缺陷，以 chunk 环检测 + preview 冒烟补懒加载运行期缺口，P3 收 Function-eval 与死 CSS 两个零星项，共 7 步按逻辑顺序落地。
