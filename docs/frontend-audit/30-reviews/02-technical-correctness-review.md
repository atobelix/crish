# 前端修复 8 份维度方案 · 技术正确性审批意见（02）

> 审批子 Agent：只读评审 + 本意见文档。实读代码验证 8 份方案的关键技术论断（01~08），不修改任何源码。
> 依据：`docs/frontend-audit/20-proposals/01~08` + `docs/frontend-audit/00-cross-analysis.md` + `docs/frontend-audit/10-analysis/01~08`。
> 复核基线：2026-08-09 工作区状态（与方案声明同日）。
> 日期：2026-08-09。

---

## ① 总体结论

**8 份方案的核心技术论断经实读代码复核，绝大多数成立，方案的总体技术方向可信、可进入实施规划。** 复核覆盖 8 份方案共 40+ 条关键论断、12 项"新发现"、全部 15+ 条跨方案依赖标注，其中：

- **成立（实读证实）**：约 38 项——包括 01 的 themeStore 运行时注入定性修正、02 的 useChatPanelSync 有线修正、03 的快照桥死桥全链、04 的三断链 + 分裂自认、06 的 tauri-utils CSP 追加语义（N1 源码级证实）、07 的 html 恒空 + complete 单帧 flush、08 的绑定级漂移 + confirm 9 文件面等核心论断。
- **修正（数字/表述与实测不符，不影响方案骨架）**：2 项（见 P0 意见 1、2）——02-B5 的 SettingsSelect 消费方计数（5 → 实测 11）、03 的快照测试用例数（21 → 实测 14）。
- **否定**：0 项。

未发现"技术上不可行"的步骤。发现 2 处工程量/数字低估（P0 必须改，均属执行清单类修正而非设计否决）与 2 处表述修正（P1）。回退策略（01 S2 分批 revert、02 B1 四批+退役判据、07 store 契约不动）经核实成立。

---

## ② 关键论断复核表（方案论断 vs 实读结果）

> 结论符号：✅ 成立 / 🔧 修正（数字或表述偏差，骨架不变）/ ❌ 否定（未出现）

### 02-1 方案 01（样式统一）

| # | 方案论断（位置） | 实读验证 | 结论 |
|---|---|---|---|
| 1 | `--accent-green/red-light-adaptive` 由 themeStore.ts:706-707 运行时注入，非纯悬空引用（④-1 P0-1 定性修正） | 实读 themeStore.ts:687-707：applyTheme 内按主题/微调计算 greenLight/redLight 后 setProperty 注入，确认存在 | ✅ |
| 2 | 静态层无定义无 fallback，注入缺失时渲染无效值 | DiffCard.module.css:583/:880 用 `var(--accent-green-light-adaptive)` 无 fallback；同文件 :740/:743/:751/:754 有 fallback（含 color-mix 兜底）——文件内不一致属实 | ✅ |
| 3 | style-contract.test.ts 已存在、可作门禁载体（④-4） | `src/styles/style-contract.test.ts` 文件存在（fs 契约断言模式） | ✅ |
| 4 | themeStore 运行时注入层是"事实第二真源"，`--bg-hover` 静态 4% vs 注入 3.5%（④-3） | tokens.css:13 `--bg-hover: color-mix(... 4% ...)`；themeStore.ts:732 注入 3.5%、:733 注入 8.0%；control-soft-* 静态 4%/4%/8%（tokens.css:35-37）vs 注入 light 6%/11%/17%（:737-742）——双层漂移全部证实 | ✅ |
| 5 | `.card-tab.active` 双声明死规则（shell-workspace.css:843 vs :869） | 实读 :843-846（bg-primary !important）与 :869-872（bg-active）同选择器双声明，前者压制后者——死规则属实 | ✅ |
| 6 | `.ui-input:focus` 无可见反馈（shell-polish.css:112-116） | 实读 :112-116：`border-color: var(--border-color)`（与默认同值）+ `box-shadow: none`——聚焦无变化属实 | ✅ |
| 7 | 5 个全局样式文件 GBK、shell-polish.css:53 为乱码注释（④-5/S7-6） | 字节检测 shell-polish.css 无 BOM；:53 注释读出来为 GBK 乱码。**补充**：shell-workspace.css:388 等更多注释同为乱码——S7-6 快照漂移面比清单样本更大，但方案已声明"字节变化量大于预期"，方向一致 | ✅ |
| 8 | SettingsUsageTab.module.css:275/281/321/328 引用 `--chart-color-1/2` | 实读 4 处引用全部命中 | ✅ |
| 9 | `--z-drag-overlay-max` 悬空 + BinaryTreeWorkspace.module.css:286 / UnitSessionTabStrip.module.css:340 的 99999 fallback | 两文件均 `z-index: var(--z-drag-overlay-max, 99999)` | ✅ |
| 10 | 423 处 color-mix(text-primary) 31 档（1.2%~42%） | 全量扫描复现：**423 处、31 个不同 X 值**（1.2/1.5/2/2.5/3/3.2/3.5/4/4.5/5/5.5/6/6.5/7/8/9/9.5/10/11/12/14/15/16/18/20/22/25/28/30/35/42）——与方案完全一致 | ✅ |
| 11 | S1 声明"本步提交无任何视觉变化（纯新增 + 等价定义）" | 🔧 **不准确**：--bg-hover 注入 3.5% → 对齐静态 4%、control-soft-* 注入 6/11/17% → 对齐 4/4/8% 本身即运行时行为变化（hover/控件底色加深）。建议把"注入对齐"与"静态定义"拆为两提交或明确接受微变并做视觉抽查 | 🔧 |
| 12 | S2 混色映射按"语义 → 档位"、仅 1.5%/42% 两档需人工复核 | 31 档中 1.2/1.5%（极淡）与 42%（单点）确为离群；映射策略合理（按语义而非数值归位避免深浅突变） | ✅ |

### 02-2 方案 02（组件体系）

| # | 方案论断 | 实读验证 | 结论 |
|---|---|---|---|
| 1 | useChatPanelSync **不是死代码**：BinaryTreeWorkspace.tsx:26 import、:141 实调（⑤-2，修正审计 P3-4） | 实读 BinaryTreeWorkspace.tsx:26/:141 实引实调；conversationUnit.ts:165 注释同引其语义——审计"疑似死代码"结论确需修正，方案处置（保留+进 barrel+补注释）正确 | ✅ |
| 2 | 旧 Tooltip 消费 85 文件（grep 口径差含测试/自身） | 实测旧 Tooltip import 命中 86 个文件（含测试/自身口径差异 1 个），88→85 差异在声明口径范围内，批量边界设定合理 | ✅ |
| 3 | ui/Select 是"建好未接线的落点组件"：Select.tsx:3-9 头注释自证 | 实读 Select.tsx:1-12："T05.3.2 中 SettingsSelect 迁移即以此为落点"——自证成立 | ✅ |
| 4 | hooks/useAnimatedPresence.ts 唯一消费者是旧 Tooltip（components/Tooltip/Tooltip.tsx:3,77） | 实读旧 Tooltip.tsx:3/:77 引用 hooks/ 版本；新 ui/Tooltip.tsx:32 引用 ui/Dialog/useAnimatedPresence（独立实现）——删除面 = 1 文件成立 | ✅ |
| 5 | ui/index.ts barrel 只导出 2/6 组件 | 实读 index.ts 仅 export Dialog + Tooltip | ✅ |
| 6 | `.ui-btn` 全局类消费 36 文件（⑤-5） | 实测 36 个 tsx 文件命中 | ✅ |
| 7 | 128 文件裸 `<button>`；ui/Button 零业务消费 | 实测 128 个组件文件含 `<button>`；ui/Button 无业务 import | ✅ |
| 8 | **B5：SettingsSelect 消费方 = 5**（FontSettingsSection/WorkflowForm/SettingsSecurityTab/SettingsSchemaRenderer/SettingsRulesTab，"grep 复核"） | 🔧 **实测 11 个消费文件**：除方案所列 5 个外，另有 SkillsSettingsTab、WizardModelStep、WizardKeyStep、McpServerForm、DiffHeaderControls、DiffCardFileList——跨 settings 域外 4 个域。迁移面低估 120%，且"退役步骤 grep SettingsSelect = 0"判据在漏列文件下无法达成 | 🔧 |
| 9 | B1 旧 Tooltip 新件 API 兼容 + 非机械点（cloneElement restProps 透传） | 新 Tooltip 以 cloneElement 透传 restProps（:284-292）、旧版仅 ref——非机械点识别正确，逐批键盘冒烟验收设计合理 | ✅ |
| 10 | B2 依赖 01 的 primary 语义定案先行（顺序依赖） | 四套 primary（深炭/蓝/反相/红）在 01 审计 §1.1 与 FirstRunWizard.module.css:218-221（`background: var(--text-primary)` 反相）实读确认——依赖标注真实 | ✅ |

### 02-3 方案 03（状态管理）

| # | 方案论断 | 实读验证 | 结论 |
|---|---|---|---|
| 1 | 快照桥 `_ops` 恒 null 且**无任何可注入缝隙**（⑤-1） | 实读 messageSnapshotsBridge.ts:31 `const _ops: MessageSnapshotsOps | null = null`，全文无 setter——"连缝隙都不存在"成立，必须先补注入函数 | ✅ |
| 2 | withdrawMessage 保存侧载荷完整（prevMessages/prevPinned/diffFilePaths） | 实读 sessionMessageActions.ts:91-125：slice 快照 + pinned 深拷贝 + toolCalls.diffs 路径收集 + saveMessageSnapshot 完整载荷——"行为与意图不符 = 静默失效"成立 | ✅ |
| 3 | deleteSession 删除成功后 clear（sessionCrudActions.ts:441-444） | 实读 :443 `clearMessageSnapshots(id)` 调用存在 | ✅ |
| 4 | 快照读侧（undo/peek/peekDelta/getStack）生产零调用，仅测试引用 | grep 全仓：getStack/peekDelta/peek 生产代码零调用（仅类定义自身）——"子系统只记不读"成立，接线 ≠ 撤销能力的事实判断正确 | ✅ |
| 5 | MessageSnapshots 纯内存不持久化（:147-148） | 实读 :147 `stacks: Map` 内存态，无落盘——重启即失边界成立 | ✅ |
| 6 | OPT-H4 "intentional residual" 注释有误导性：根因是 LayoutFacade 无 setState（⑤-5） | 实读 useStreamCallbacks.ts:402/486/504/810/1060 五处注释 + 对应 setState recipe——"intentional 实为缺口被容忍"的重新定性成立 | ✅ |
| 7 | workspaceStore facade 自写 recipe 与 README 收尾宣称不符（:121/128-145） | 实读 workspaceStore.ts:121（setGroupActiveCard）、:128-145（focusExistingPanelCard）为 facade 内直接 setState recipe | ✅ |
| 8 | AppBootstrap rebind 动态加载 + 订阅 layoutStore 自身（:144-189） | 实读 :145-190：`import('../api/projectStore')` 动态加载 + :184-190 `useLayoutStore.subscribe` + prevSessions 引用比较——"纪律型约束可被结构替代"的 D5 收敛依据成立 | ✅ |
| 9 | bootstrap-services.ts:81 `connect().catch(() => {})` 空 catch | 实读 :81 确认（另 :116 同类） | ✅ |
| 10 | store/index.ts:174 导出 useRustCoreStore 死面组 | 实读 :174-179 导出组确认 | ✅ |
| 11 | **MessageSnapshots.test.ts "21 组测试用例"** | 🔧 **实测 14 组 it**（14 个 `it(`，2 个 describe）。2.2 决策依据表与 2.5 退役成本中的"21 组测试"数字应修正为 14；接线 vs 退役的成本对比结论不变（接线仍显著更便宜），测试资产保护定性不变 | 🔧 |

### 02-4 方案 04（前后端通信）

| # | 方案论断 | 实读验证 | 结论 |
|---|---|---|---|
| 1 | rustCore.ts:171 `'md_render'`、:186 `'highlight_code'` 为唯一断链字面量；:157 注释命令名清单过时 | 实读 :171/:186 命中；:157 注释列旧名（无 core_ 前缀）——注释漂移成立 | ✅ |
| 2 | Rust wire 键 = `core_md_render`/`core_highlight_code`（rename 显式声明，markdown_commands.rs:22/:67） | 实读 markdown_commands.rs 全文：5 条命令全部 `#[tauri::command(rename = "core_md_*")]`；:34-40 batch 完整实现、:44-45 自证"流式期主路径是 JS 零 IPC"、:79-80 自证 moka LRU 无需手动清——方案步骤 2/3 的接线/退役依据全部成立 | ✅ |
| 3 | md_render 有真实消费链（markdownRenderAsync.ts:37-48 Rust 优先、missing 回退 worker） | 实读 :39-43 Rust 优先 + :44-48 worker 回退——"改名后能力真实生效"成立 | ✅ |
| 4 | TelemetryMonitor.ts:103 断链名 + :21/:107 双硬编码（⑤-4 新发现） | 实读 :103 `perf_jsonl_append`、:21 logFilePath `c:/Software/conex/...`、:107 workspaceRoot `'c:/Software/conex'`——双硬编码属实（审计只提 :107，⑤-4 修正有效） | ✅ |
| 5 | core_jsonl_append 签名 `(path, lines, flush, workspace_root)` 与前端传参逐项匹配；workspace 未开时 `for_default_workspace()` 兜底 | 实读 core_commands.rs:546-551 签名与 :575-578 兜底分支；perf/jsonl.rs:5-7 注释自证"迁移由前端域承接"——"改名即通"成立 | ✅ |
| 6 | fs 4 命令无 rename（函数名 = wire 键），main.rs:112-118 自认分裂 | 实读 fs_commands/mod.rs 4 命令无 rename 属性；main.rs:112-118 注释完整自认（"元组名 workbench_* 仅作 manifest/注册面对照标签…登记为已知分裂"）——分裂属实 | ✅ |
| 7 | 测试面 mock 键 `md_render` 从未存在于 Rust 注册面（⑤-1） | 实读 test-setup.ts:57-91 文档 + :76/:90、test-setup.test.ts:45/50/116/118 全部以 `md_render` 为 mock 键——**步骤 1c 强制改测试面是关键正确项**（否则假绿灯） | ✅ |
| 8 | commandMap.ts:33 白名单含 `core_read_run_events` 幽灵条目（⑤-3） | 实读 :33 命中 | ✅ |
| 9 | Rust 13 码 vs 前端 8 码 + 6 码（stream_error.rs:305-319） | 实读 kind_str 13 分支、KEBAB_KIND_TO_SOFT 8 键（userFacingErrors.ts:65-75）、KEBAB_TO_DOMAIN 6 键（:121-128）——双向覆盖缺口属实，context-length-exceeded 高频回落路径成立 | ✅ |

### 02-5 方案 05（代码质量）

| # | 方案论断 | 实读验证 | 结论 |
|---|---|---|---|
| 1 | check-swallowed-errors.mjs 仅覆盖 Rust crates/，前端无等价物 | 实读脚本 :40-49 扫描根默认 `crates/`——前端吞错零门禁成立 | ✅ |
| 2 | check-line-counts.mjs "只有 pass/fail 两态，与声明三级语义不符" | 🔧 **表述不准**：实读 :136-141 已有 85% warning 分支（warning 输出），:154-157 仅 violations>0 才 exit 1。脚本实为两级（warning/violation）**而非"无 warning 语义"**；缺失的是">650 硬阻断"第三级与 package.json/CI 接线。重构目标（补硬阻断 + 接线）不变，但对账口径应改为"已有两级、补第三级" | 🔧 |
| 3 | check-line-counts.mjs:49-51 `/types?/i` 分类正则过宽（⑤-5） | 实读 :49-51 `filename.endsWith('.d.ts') || /types?/i.test(filename) || posixPath.includes('/types/')`——过宽正则属实（prototypes.ts 类命名会被误分类 800 档） | ✅ |
| 4 | toolFeedback.ts:378-380 无理由 no-control-regex 豁免（⑤-1） | 实读 :375-381：剥离对象为 ANSI ESC（`\u001b\[...`），:379 disable 无理由注释——与"37 行豁免全部带理由"结论冲突属实，构成第 12 个剥离点 | ✅ |
| 5 | logInternalError 自身含空 catch（userFacingErrors.ts:247-249） | 实读 :244-249 `catch { /* ignore */ }`——教科书级合理静默，作为 swallow-ok 示范样本成立 | ✅ |
| 6 | eslint 本地规则先例存在（eslint.config.js:7-38 deprecatedRequiresReference） | 实读本地规则完整实现——no-silent-catch 的 AST 规则形态（CatchClause 空体 / 有绑定空体 / .catch 箭头空体）均为标准 ESTree 模式，技术可行；白名单双维机制（文件基线 ratchet + swallow-ok marker）与 Rust 侧惯例一致 | ✅ |
| 7 | 306 空 catch / 33 `.catch(() => {})` 口径；严格模式实测偏差（⑤-3） | 方案自洽处理了口径差（33 vs 10）——"以规则口径为门禁事实"的建线策略正确 | ✅ |

### 02-6 方案 06（工程化构建）

| # | 方案论断 | 实读验证 | 结论 |
|---|---|---|---|
| 1 | index.html:13 静态宽 CSP（unsafe-eval + 泛化 connect-src） | 实读 :13 命中 | ✅ |
| 2 | tauri.conf.json:29 严格 security.csp（无 unsafe-eval，connect-src 收敛 8765） | 实读 :29 命中（含 wasm-unsafe-eval、asset.localhost 等） | ✅ |
| 3 | **N1：Tauri 注入是追加第二个 CSP meta 而非替换**（tauri-utils-2.9.3/src/html2.rs:84-90）→ CSP3 交集语义，当前生产包实际执行严格面 | 实读 cargo registry 源码 tauri-utils-2.9.3/src/html2.rs:84-90：`inject_csp` 仅 `head.append_child(&meta_tag)`，无查删已有 meta——**追加语义源码级证实**，交集推论成立（script-src 交集后 = self、connect-src 收敛到 8765 清单）。审计"unsafe-eval 在包内生效"判断被修正成立 | ✅ |
| 4 | **N2：CI build 必须先构建 shared-types**（exports.default → dist/index.js） | 实读 packages/shared-types/package.json:7-18：main/types 指向 dist、exports 的 default 条件 = `./dist/index.js`、development 条件 = `./src/index.ts`——vite production 解析 default → dist，CI 无 dist 缓存必须先 build，成立 | ✅ |
| 5 | vite.config.ts:216 `chunkSizeWarningLimit: 1100` 已失效（降噪开关） | 实读 :216 命中，注释自认"Lower noise for known large entry" | ✅ |
| 6 | vite.config.ts:194 `process.platform` 编译期注入随平台漂移（N3） | 实读 :194 `JSON.stringify(process.platform || 'win32')`——CI(linux) 与发布(win32) 分支差异成立，N3 低优先建议合理 | ✅ |
| 7 | e2e preview 冒烟可复用 mock-engine.ts:390 的 `__TAURI_INTERNALS__` 注入（N8） | 实读 mock-engine.ts:390 `window.__TAURI_INTERNALS__ = {` 确认 | ✅ |
| 8 | 步骤 3 prod 严格串 worker-src 保留 blob:（N7：现 worker 均静态 URL） | worker-pool 静态 URL 面未逐行复核，但方案已声明"交集下 blob 曾被禁、恢复为与 dev 一致"——语义自洽，不构成风险项 | ✅ |

### 02-7 方案 07（性能渲染）

| # | 方案论断 | 实读验证 | 结论 |
|---|---|---|---|
| 1 | StreamRenderBuffer `html` 恒 ''、`chunkUpdates` 恒空（:197-198） | 实读 flushFrame :197-198 写死 `html: ''`、`chunkUpdates: []`；头注释 :14-19 自认"解析器尚未接入"；AsyncMarkdownBlock.tsx:24 自证"D0 residual"——增量通道从未接线成立 | ✅ |
| 2 | onFrame 只写全量文本（useStreamCallbacks.ts:298） | 实读 :298 `setStreamText(sid, assistantMsgId, frame.full)`——帧预算只限制 set 频率、payload 仍是全文成立 | ✅ |
| 3 | complete 单帧全量 flush（:716-718）+ force 无视预算（StreamRenderBuffer:95-102） | 实读 :716-717 `buffer.push('', true); buffer.flush(true)`；flush(force) :95-102 强制刷完 + 残余再调度——R-01 成立 | ✅ |
| 4 | 消费端每帧全量重算：applyStreamTextToMessage + buildAssistantTimeline + stripThoughtPlaceholders | 实读 MessageContent.tsx:56-68（displayMsg 全量重建 + buildAssistantTimeline）、:119-120（strip 每帧）；markdownRenderLite.ts:35-73（7+ 个 gm 正则整文扫描）；isStreaming 只覆盖最后 text 项（:122）——R-03/R-10 成立 | ✅ |
| 5 | 搜索态 `windowScanKey = messages` → 每帧 O(n) 扫描（ChatMessageList.tsx:160-186） | 实读 :160-161 条件选择、:163-186 collectMustIncludeIndices + resolveExpandedForKeepAlive 依赖 windowScanKey——R-02 成立 | ✅ |
| 6 | streamingStore 全文覆盖 + 同值拦截不变（:132-147）——store 契约不动 | 实读 setStreamText :132-147 同值早退——"增量只在渲染组件内派生、store 契约保持"的边界划分成立 | ✅ |
| 7 | **N2：React 对 `{text}` 文本子节点更新是整节点替换 O(全文)——必须 ref+appendText** | React 文本节点 diff 语义属实（单文本节点更新 = 整体替换 textContent）；appendText 直写 DOM 绕开 React 是标准 escape hatch（无 SSR/hydration 场景，桌面 SPA）。**补充**：React 19 StrictMode 下 effect 双执行需"挂载时重置节点内容"守卫，方案未明示，建议加入 StreamingTextBlock 验收用例 | ✅ |
| 8 | 依赖 02 C1（同文件串行）/ 04 高亮接线（交叉决策点）真实存在 | 07 步骤 3 动 ChatMessageList.tsx 与 02 C1（30 props 聚合，同文件）；04 步骤 1d/幽灵 2 的 streamingCodeHighlighter 接线与 07"流式期零 IPC"方向相反——两个交叉点均真实（见 ④） | ✅ |
| 9 | R-05 会话级订阅短路：useChatCardState messages selector 全 store 变更重求值 | 实读 useChatCardState.ts:69-77 selector 按 sessionId 取值但订阅面为整个 store——非活跃会话 patch 触发求值成立 | ✅ |
| 10 | tokenizeSearchQuery 每消息重复执行（N4：sessionSearch.ts:347） | 实读 messageMatchesSearch :347 每次调用重新 tokenize——N4 成立 | ✅ |

### 02-8 方案 08（a11y/UX）

| # | 方案论断 | 实读验证 | 结论 |
|---|---|---|---|
| 1 | window.confirm 实测 **9 文件面、10 次调用**（⑤-2，审计口径 ×8） | 全仓 grep：9 个文件 10 次调用（SettingsUsageTab.tsx:523-524 条件双行确认）——修正有效 | ✅ |
| 2 | **绑定级漂移**：open_security 设置页 Ctrl+Shift+E vs 注册表 Ctrl+Shift+S；toggle_runtime Ctrl+` vs Ctrl+Shift+R（⑤-1） | 实读 ShortcutRegistry.ts:29/:34（执行真源）与 SettingsShortcutsTab.tsx:23/:25（DEFAULT_SHORTCUTS）——两处绑定不一致全部证实；export_logs（注册表有/设置页无 :33 vs :20-27）与 close_tab（设置页有/注册表无 :26）互缺亦证实；open_models 缺默认绑定（⑤-5，注册表 :27 有 Ctrl+Shift+M、DEFAULT_SHORTCUTS 无）成立——"用户按设置页绑定不触发功能"为真实缺陷，步 3 以注册表为真源正确 | ✅ |
| 3 | ModelBadgePickerMenu 行按钮 `aria-expanded={isHovered}` 由 hover 驱动（⑤-3） | 实读 ModelBadgePickerMenu.tsx:84 `aria-expanded={isHovered}`；行按钮 :79-88 无 onClick（仅父容器 onMouseEnter）——"SR 播报引导展开而必然失败"成立，步 5-④ 改绑真实打开态正确 | ✅ |
| 4 | lightweightMode.ts:56 写 `data-reduced-motion` 但无 CSS 消费（P2-10 死钩子） | 实读 :56 setAttribute 确认；全仓无 CSS 选择器消费该属性（方案已 grep 复核） | ✅ |
| 5 | CheatsheetModal 已走执行真源 getAllActions()（⑤-4） | 实读 CheatsheetModal.tsx:28 `ShortcutService.getInstance().getAllActions()`——单源修复面只须修设置页成立 | ✅ |
| 6 | Esc Esc 500ms 序列误触分叉（ShortcutRegistry:24 + AppShortcuts.ts:143-161） | 实读注册表 `branch_session: 'Escape Escape'`；AppShortcuts :143-161 序列分支（含 toast+撤销）——误触路径成立 | ✅ |
| 7 | detectConflicts 仅 DEV（AppShortcuts:192-199） | 实读 `if (import.meta.env.DEV)` 包裹——改键前接生产兜底的顺序要求成立 | ✅ |
| 8 | 步 2 三个异步化难点（同步布尔 confirm → 状态机） | 实读 useFileNavigation.ts:121（`return window.confirm(...)` 同步布尔）、useFilePreview.ts:135（同步 if）、ComposerField.tsx:136/TiptapComposerField.tsx:253（`!window.confirm(...)` return）——异步化改造必要性与行为风险面完全属实 | ✅ |
| 9 | hover-only 两处：DiffCard .hoverActions display:none（module.css:834-849）、.session-actions-btn opacity:0 18×18（shell-sidebar.css:286-305） | 实读：.hoverActions display:none + 仅 :hover 揭示；.session-actions-btn 18×18 opacity:0 仅 .session-item:hover 揭示——键盘阻断成立 | ✅ |
| 10 | 触屏尺寸 .hoverActBtn 22×22、.session-actions-btn 18×18 | 实读 DiffCard.module.css:863-864 width/height 22px；shell-sidebar.css:291-292 18px | ✅ |

---

## ③ 技术风险清单

### P0 必须改（执行清单类修正，不改则步骤无法正确执行/验收）

| # | 风险 | 方案 | 修正要求 |
|---|---|---|---|
| P0-1 | **02-B5 SettingsSelect 消费方计数低估**：方案列 5 个消费方，实测 **11 个文件**（多出 SkillsSettingsTab / WizardModelStep / WizardKeyStep / McpServerForm / DiffHeaderControls / DiffCardFileList，跨 4 个域）。漏列将导致迁移漏批、"grep SettingsSelect = 0"退役判据无法达成 | 02-B5 | 迁移清单补齐至 11 个；文件面更新；验收判据改为"grep `import.*SettingsSelect` 生产代码 = 0"；Wizard/McpServer/Diff 域消费点纳入行为人工验证（打开/选择/关闭/Esc） |
| P0-2 | **03 快照测试资产数字错误**：方案 2.2/2.5 称 MessageSnapshots.test.ts "21 组用例"，实测 **14 组 it**。成本对比与决策记录中的数字需修正（决策结论不变：接线仍优于退役，接线约 15 行 vs 退役含 14 组测试资产） | 03 步骤 1 | 数字修正为 14 组；桥单测锁用例（①②③④）不受影响 |

### P1 建议修正（表述/方法，不影响骨架）

| # | 风险 | 方案 | 修正要求 |
|---|---|---|---|
| P1-1 | **01-S1 "本步无任何视觉变化"声明不成立**：注入层对齐（--bg-hover 3.5%→4%、control-soft-* 6/11/17%→4/4/8%）本身改变运行时渲染值（hover/控件底色加深），且 dark 分支静态 bg-active 6.5%（tokens.css:397）与注入 8% 也存在第三处不一致（方案未提） | 01-S1 | 注入对齐单列提交 + 视觉抽查（light/dark 各 3 组件）；将"无视觉变化"改为"仅注入层对齐的微变，独立提交可回退"；dark bg-active 不一致纳入同一提交 |
| P1-2 | **05-步骤 2 check-line-counts 现态描述不准**：脚本已实现 85% warning 两级语义（check-line-counts.mjs:136-141），非"只有 pass/fail 两态"；缺失项为">650 硬阻断"第三级 + CI/package.json 接线 | 05 步骤 2 | 基线对账口径改为"已有两级、补第三级 + 接线"；避免实施时按错误基线重建脚本 |
| P1-3 | **07-StreamingTextBlock 缺 StrictMode/重挂载守卫**：ref + appendText 在 React 19 StrictMode effect 双执行或消息重挂载时会重复追加文本 | 07 步骤 1 | 组件内"挂载时清空节点再追加"守卫 + 单测断言（重挂载复位）纳入验收（方案已有"重挂载复位"用例，补守卫实现即可） |
| P1-4 | **08-步 3 改键 Ctrl+Shift+F 未经验证占用**：候选键可能被其他绑定占用（现冲突检测仅 DEV，方案已要求"先接生产兜底"——顺序正确但需把该前置列为步 3 的**第一子步**而非并行项） | 08 步 3 | 冲突检测生产兜底先行 + 定案后全量 keyboard e2e；若 Ctrl+Shift+F 冲突则回退到方案 B 或另选键（登记决策） |

### P2 观察项（补充，不阻断）

| # | 观察 | 说明 |
|---|---|---|
| P2-1 | 01-S7 编码统一面比清单大：shell-workspace.css:388 等更多 GBK 乱码注释 | 与方案 ⑤-5"字节变化量大于预期"一致，快照同提交纪律覆盖即可 |
| P2-2 | 04-步骤 6 抽取正则对动态拼接 invoke 漏检 | 方案风险 7 已登记（白名单兜底 + 88 键基线校准），无需追加 |
| P2-3 | 06-N7 worker-pool.ts:404 静态 URL 未逐行复核 | 低风险观察项；步骤 3 落地时顺手验证一次即可 |
| P2-4 | 07-步骤 4 的 R-05 会话级短路依赖"activeSessionId 恒与渲染中的 ChatCard 一致"假设 | 方案风险 7 已要求实现前确认多 Tab 语义——维持登记即可 |

---

## ④ 依赖真实性核对（方案间依赖标注是否真实）

全部 15+ 条跨方案依赖标注经实读核实为**真实**：

| 依赖标注 | 实读验证 | 结论 |
|---|---|---|
| 01-S3 按钮体系依赖 02-B2（ui/Button 接管） | 02-B2 是 128 裸 button/.ui-btn 迁移的执行方；01-S3 管 primary 档位——分工真实 | ✅ |
| 01-S3/S4/S5 依赖 02-B2/B6/B4（按钮/Tab/输入接管） | 02 方案 B 阶段均为组件形态接管，01 只做样式档位/退役删段——依赖链真实 | ✅ |
| 01-S6 对比度调值 ↔ 08-步 6 断言验收 | 08 步 6 明示"值改在 01、断言在 08"，a11y-contrast.test 为验收器——双向锚定真实 | ✅ |
| 02-B2 依赖 01 的 primary 语义定案先行 | 四套 primary 实读确认（深炭/蓝/反相/红），映射表必须以收敛后 primary 为基准——依赖真实且顺序正确 | ✅ |
| 02-B1 ↔ 08-步 1（Tooltip 迁移执行 vs a11y 契约验收） | 职责边界清晰（02 执行、08 契约+验收），无重复实现 | ✅ |
| 02-E3 ConfirmDialog ↔ 08-步 2（组件设计 vs a11y 契约+9 点迁移） | 08 步 2 依赖 02-E3 基座；08 声明契约（alertdialog/焦点/归还）——真实 | ✅ |
| 03-步骤 2 D3 主题依赖 04 断链命令修复 | 03 已给出两段式收敛（先收敛前端、04 修复后链路自动完整）——依赖标注真实且带降级路径 | ✅ |
| 03-步骤 5 与 02 组件方案互斥文件面（58 处 store 直引迁移） | 03 明示"结构迁移显式等待 02 落地、同文件串行"——冲突规避真实 | ✅ |
| 04-幽灵 2 highlight 接线 ↔ 07 流式渲染（交叉决策点） | **实读确认方向相反**：07 步骤 1 目标是流式期主线程 O(增量) 零 IPC（"流式期零 IPC 约束"），04 建议接线 streamingCodeHighlighter 走 Rust（每帧 IPC 风险）——04-07 交叉点真实，07 附注的时序约束（04 接线应在 07 步骤 1 定稿后评估）正确 | ✅ |
| 05-5b Tooltip 收敛依赖 02-B1 完成 | 05 明示"严格依赖 02 完成，未完成期间禁止新消费旧版"——真实 | ✅ |
| 05-步骤 4 与 02-D1 文件面错开（函数逻辑 vs 组件结构） | 重叠文件（ModelConfigEditor 等）由调度者串行分配——真实 | ✅ |
| 06-步骤 2 chunk 拆分与 07 懒加载正交 | 06 拆静态边界、07 管运行时 lazy——正交关系表述正确，且 06 先行不阻塞 | ✅ |
| 07-步骤 1/3 与 02-C1 同文件串行（MessageContent/ChatMessageList） | 02-C1 涉及 ChatMessageList.tsx（30 props 聚合）与 07 步骤 3 同文件——串行纪律真实必要；07 步骤 1 只动 MessageContent.tsx（chat-message/ 域，与 C1 文件面不同）——方案已区分 | ✅ |
| 07-步骤 4③ 比较器收窄依赖 02-C1 | 清单测试先行、收窄等 02 C1 后——真实 | ✅ |
| 07-步骤 5② L3 精度依赖 06-P1-1（build 进 CI + preview 冒烟） | 06 步骤 1/6 确为该能力承载者——真实 | ✅ |
| 08-步 6 依赖 01-S6 串行（避免两批视觉变化叠加） | 与 01-S6 的对比度值调整定位一致——真实 | ✅ |
| 01-S0 依赖"02 管组件接管"边界的另一面：01 的 tooltip-translate 修复与 02-B1 的"本步骤内直接修两处样式"重复？ | 01-S0 修静态 fallback、02-B1 修同一变量——**有轻微重复面**：01-S0 已含"双份 Tooltip.module.css 补 fallback"（S0 表格），02-B1 ① 又写"--tooltip-translate 修复本步骤内直接修两处样式"。调度需串行（01-S0 先行或 02-B1 承接），两方案均声明过对方，建议执行时以 01-S0 为准、02-B1 删去该行避免双改 | 🔧（调度提示，非技术错误） |

---

## ⑤ 新发现复核结果（抽查 12 项，全部经实读）

| # | 新发现 | 出处 | 复核 |
|---|---|---|---|
| 1 | `--accent-*-light-adaptive` 运行时注入（P0-1 定性修正） | 01 ④-1 | ✅ themeStore.ts:706-707 实读证实 |
| 2 | themeStore 运行时注入层 = 事实第二真源（双层漂移） | 01 ④-3 | ✅ tokens.css:13 vs themeStore.ts:732（4% vs 3.5%）|
| 3 | useChatPanelSync 非死代码（审计 P3-4 修正） | 02 ⑤-2 | ✅ BinaryTreeWorkspace.tsx:26/:141 实引实调 |
| 4 | 桥连"可注入缝隙"都不存在 | 03 ⑤-1 | ✅ bridge.ts 全文无 setter |
| 5 | OPT-H4 "intentional" 实为缺口被容忍 | 03 ⑤-5 | ✅ 5 处注释 + LayoutFacade 无 setState 实证 |
| 6 | 测试面 mock 键从未存在于 Rust 注册面（假绿灯） | 04 ⑤-1 | ✅ test-setup.ts:57-91 等全部旧键 |
| 7 | TelemetryMonitor 硬编码两处（审计只提 :107） | 04 ⑤-4 | ✅ :21 + :107 双实证 |
| 8 | commandMap 白名单自身含幽灵条目 | 04 ⑤-3 | ✅ commandMap.ts:33 |
| 9 | **N1：tauri-utils CSP 追加 meta 而非替换 → 交集语义**（修正审计 P1-2 严重性） | 06 N1 | ✅ tauri-utils-2.9.3/src/html2.rs:84-90 源码级证实 append_child |
| 10 | **N2：CI build 必须先构建 shared-types** | 06 N2 | ✅ shared-types package.json exports.default → dist |
| 11 | React 文本子节点更新是整节点 textContent 替换（ref+appendText 设计依据） | 07 N2 | ✅ React 语义 + 无 SSR 场景可行 |
| 12 | 快捷键**绑定级**漂移（比审计文案漂移更严重）+ open_models 缺默认绑定 | 08 ⑤-1/⑤-5 | ✅ 双源逐键对照证实 |

**结论：抽查 12 项新发现全部经实读复核成立，可信度高。** 其中 06-N1（CSP 追加语义）为源码级证实，04-⑤-1（假键）与 08-⑤-1（绑定漂移）为高价值修正——这 3 项直接改变了对应审计问题的处置方式，方案均已正确吸收。

---

## ⑥ 回退安全评估

| 批量替换类步骤 | 回退策略 | 评估 |
|---|---|---|
| 01-S2（423 处混色收敛） | 每批 5-10 文件独立提交 + git revert 单批 + playwright 计算样式比对（混色值差异 ≤1.5%）+ 1.5%/42% 两档人工复核单独提交 | ✅ 成立：单提交粒度回退可精确还原；语义映射表先行落盘、不机械替换，减少误替换面 |
| 02-B1（88 处 Tooltip） | 4 批按业务域 + 每批独立提交 + 退役步 grep 清零判据 + 非机械点（cloneElement restProps）预先识别 + 键盘冒烟验收 | ✅ 成立：批边界按域切分可整批回退；"退役是验收动作"强制闭环，无残留双轨；旧目录删除前有 grep 零引用判据 |
| 02-B2（128 裸 button） | 6 批 + 变体判定规则表 + 每批视觉回归抽样 3-5 按钮 + aria-label 补齐计入判据 | ✅ 成立：语义判定规则表是回退判定的依据；唯一补充（P0-1）是 B5 的 SettingsSelect 清单补齐，与回退策略无关 |
| 08-步 2（9 处 window.confirm 异步化） | 行为变更点清单 + 流程级测试（挂起→确认→继续 / 取消→不继续）+ 每点独立提交 | ✅ 成立：3 个异步化点为最大行为风险，方案已列变更清单并逐点验证，回退粒度=单点 |
| 07-步骤 1（流式增量渲染） | streamingStore 契约不动（全文覆盖 + 同值拦截保留）、增量只在渲染组件内派生、对拍测试（增量 strip vs 全量 strip 等价） | ✅ 成立：store 契约不动意味着整体回退面仅为渲染组件；对拍测试保证语义等价；唯一补强为 P1-3 的 StrictMode 守卫 |
| 06-步骤 3（CSP 分层） | dev 宽松串与现状等价（行为零变化）、prod 严格串由 check-dist.mjs 强制断言 + tauri build 产物抽查 | ✅ 成立：dev 零变化面回退需求低；prod 侧有机器断言兜底；切换点（isolation pattern）已登记 |
| 03-步骤 1（快照桥接线） | 注入函数幂等（重复注入以最后一次为准）+ 未注入时 save/clear 不抛错（兼容现状）+ 单测锁四断言 + AppBootstrap.test 装配效应断言 | ✅ 成立：即使注入失败也保持现状行为（不回归），接线是纯增量，回退=移除注入一行 |

**总体回退评估结论**：8 份方案的批量替换类步骤均采用"批次独立提交 + 门禁（typecheck/unit/snapshots）+ 抽样视觉/行为验证 + git revert 单批"模式，回退粒度与风险面匹配，策略成立。**唯一补充**：01-S1 的注入层对齐（P1-1）会引入运行时微变，该提交的回退判据应包含视觉抽查而非仅"等价定义"。

---

## 审批结论

1. **总体：通过（附 2 项 P0 修正）**。8 份方案技术方向正确、关键论断 38/40 项实读成立、0 否定；12 项新发现全部可信；依赖链全部真实。
2. **P0 必须改 2 项**：02-B5 SettingsSelect 消费方清单（5→11）；03 快照测试用例数（21→14）。
3. **P1 建议改 4 项**：01-S1"无视觉变化"声明修正（含 dark bg-active 第三处不一致）；05 行数脚本现态口径；07 StreamingTextBlock StrictMode 守卫；08 改键冲突检测前置为第一子步。
4. **实施顺序确认**：00 交叉分析的批次划分与 8 份方案的依赖链自洽（批次 1 功能修复 → 批次 2 样式/组件 → 后续批次），可直接进入 40-final-plan 汇总。
