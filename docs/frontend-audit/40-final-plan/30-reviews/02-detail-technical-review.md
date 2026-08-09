# 8 份分维度详细计划 · 最终评审意见（技术复核 / 代码贴合度）

> 评审子 Agent：只读 + 本评审文档。实读复核 `40-final-plan/10-details/01~08` 的关键实现设计与代码贴合度。
> 依据：`40-final-plan/00-master-plan.md` + `10-details/01~08`（8 份）+ `30-reviews/02-technical-correctness-review.md`（阶段 3 评审）。
> 复核基线：2026-08-09 工作区实读（含 `git status` 脏状态、dist 产物、cargo registry 已有结论引用）。
> 日期：2026-08-09。

---

## ① 核心设计复核表（设计 vs 实读结果）

> 符号：✅ 实读成立 / 🔧 需修正 / ⚠️ 有风险或需主控裁决。抽查覆盖每份 detail 2~4 项核心设计。

### 01（T-A 功能修复）

| # | 设计（detail 01） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | 快照桥注入点：`bootstrapStores()` 内 `initStoreAccess`（:71-75）旁装配真实 MessageSnapshots，注入函数 `bindMessageSnapshotsOps` | `messageSnapshotsBridge.ts:31` 确为 `const _ops = null`、全文无 setter（"连缝隙都不存在"成立）；工作区 `git diff` 证实 `let→const` 未提交脏态（R-10 前置清理事实准确）；`bootstrapStores.ts:71-75` 实读确认；桥头注释 :3 自证"bootstrapStores 在模块图稳定后注入"原设计 | ✅ |
| 2 | 适配器形状：桥 ops `options?: SnapshotSaveOptions`（afterMessages 可选）vs `MessageSnapshots.save` 的 ctx（afterMessages 必填）→ 兜底 `?? []` | 类型实读一致；`sessionMessageActions.ts:113-125` 保存侧载荷完整（slice + pinned 深拷贝 + diffFilePaths + afterMessages）；`sessionCrudActions.ts:443` 删除成功后才 clear；读侧（peek/getStack/peekDelta）全仓生产零调用（仅 `api/MessageSnapshots.test.ts` 命中）——"接线纯增量、无 undo 行为变化"风险结论成立 | ✅ |
| 3 | 断链修复：rustCore.ts 两字面量 + 注释更新；mock 键面 4 文件同步 | `rustCore.ts:171` `'md_render'`、`:186` `'highlight_code'`、`:157` 过时注释清单全部实读命中；`markdown_commands.rs:22/:35/:51/:67/:81` 五条 `rename = "core_*"` 实读确认；mock 键面实测 `test-setup.ts` 5 处、`test-setup.test.ts` 4 处、`parity.test.ts` 3 处、`markdownRenderAsync.test.ts` **11 处**（详见②-8） | ✅（数字见修正 ②-8） |
| 4 | TelemetryMonitor 五项动作（含双硬编码清除、missing 可观测） | `:21` logFilePath 机器路径、`:103` `'perf_jsonl_append'`、`:107` `workspaceRoot` 硬编码全部实读命中；missing 分支（:109-116）仅 error 打印、missing 静默回灌成立；1000 上限/10 条触发/5s 定时（:72-76/:25）与改动不动这些行的声明一致；`:119` 非 test 环境守卫实存；`workspaceFsApi.ts:6-7` `getWorkspacePath` 再导出实存（B2 项 2 依赖成立） | ✅ |

### 02（T-B 样式基线）

| # | 设计（detail 02） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | tint 档位 token 定义位置（tokens.css :root + dark 双块）与 **text-primary 基底修正**（对 S1 原文 control-mix 基底的修正） | 426 处消费点混色基底全部 `var(--text-primary)`（全仓扫描实读，见②-2）——基底修正的"零基底变化"理由成立；dark 块 `--control-mix-color` 静态缺失未逐行核验（themeStore 恒注入 mixColor，静态缺失推断合理，执行时以视觉抽查为准）；S2 映射"8 与 8.0 归一"与分布表实测值完全一致 | ✅（基底决策标注需主控确认，计划已声明） |
| 2 | themeStore 运行时覆盖 9 token 不一致清单 | 23 处 `setProperty` 实读计数一致（:455 + :706-769 22 处）；清单 9 行逐行命中：tokens.css:13/:14/:22/:27/:35-37 vs 注入 :732/:733/:736-742/:718-721；dark :396/:397/:403/:408/:414-416 全部命中；第三处不一致（dark bg-active 静态 6.5% vs 注入 8.0%，02 评审 P1-1）实读成立；else 分支 removeProperty :788-789 实存 | ✅ |
| 3 | S0 六任务（悬空引用兜底/死规则） | DiffCard.module.css:583/:880 裸引用 + :740/:743/:751/:754 带 fallback（文件内不一致成立）；9 处 `--hover-bg/--active-bg` 黑系 fallback（:457/:462/:988/:1032/:1061/:1125/:1160/:1184/:1237）全部命中；Tooltip 双份 module.css 各 4 处 `var(--tooltip-translate)` 裸引用（共 8 处）命中；chart-color 4 处（:275/:281/:321/:328）命中且 in/out 语义清晰；`z-index.css` 无 `--z-drag-overlay-max` 定义（仅 :33 `--z-drag-overlay: 10010`）+ 两文件 99999 fallback 命中；`.card-tab.active` :843/:869 双声明命中；**R-11 定性修正（ChatComposer.module.css:105 为 autofill hack 非 z fallback）实读确认** | ✅ |
| 4 | style-contract.test.ts 扩展点（8 条断言） | 文件存在（fs 契约断言模式实读）；F7-F14/F7-F27 结构兼容扩展；断言⑥（注入名 ∈ 静态名）以 23 个 setProperty 名为数据源——计数与实读一致 | ✅ |

### 03（T-C 组件体系）

| # | 设计（detail 03） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | Tooltip 新旧 props 全兼容映射表（8 维度） | 旧件 150 行（:24-130 props 面逐项命中：content 必填/children 必填/side/disabled/delayHide/useMergeRefs/:100 早退/:106-130 restProps 透传）；新件实际 **294 行**（计划称 314 行）；新件 focus/blur 触发 :262、aria-describedby :175/:275-287、cloneElement :284、role="tooltip" 全部实存；映射表"旧版亦透传 restProps"的修正（非机械点缩小）实读确认 | ✅（行数漂移见 ③-P2-1） |
| 2 | `.ui-btn`→variant 1:1 映射表 | `shell-polish.css:18-86` `.ui-btn` 体系实存（:18 基类/:32 sm/:39 md/:45 primary/:54 secondary/:65 ghost）；业务消费 **36 个 tsx 文件**（+Button.tsx 自身注释 = 37，与计划口径一致）；ui/Button 95 行、variant 联合 4 值/size 2 值、零业务消费（实读 import 面）；"裸 ui-btn ui-btn-sm 需核对语义"的待确认点已登记 | ✅ |
| 3 | SettingsSelect→ui/Select 的 `value→id` 决策点 | **11 个生产消费方实读全部命中**（FontSettingsSection/WorkflowForm/SettingsSecurityTab/SettingsSchemaRenderer/SettingsRulesTab/SkillsSettingsTab/McpServerForm/DiffHeaderControls/DiffCardFileList/WizardModelStep/WizardKeyStep——跨 4 域，R-09 落地准确）；两件回调均名 `onChange`（方案所称 onSelect 命名差异"实读不存在"成立）；onOpen 无消费方（11 文件 grep）、footer/trailing/previewFamily 仅 FontSettingsSection、group 待 grep 决策——执行前决策点设计完整 | ✅ |
| 4 | 巨型拆分行数基线 + Menu 直引 10 文件 | ModelConfigEditor 866 / useExtensionMarket 623 / ApprovalAskCard 777 / SidebarContextMenus 722 / ExternalSessionImport 580 / SettingsUsageTab 536 / useSidebarSessionList 588 / UnitSessionTabStrip 505 **全部精确命中**；Menu 直引生产文件 10 个（+4 文件类型直引 `ui/Menu/types`）与计划清单逐行一致；`ui/index.ts` 12 行仅导出 Dialog+Tooltip、ui/ 目录 6 组件实存 | ✅ |

### 04（T-D UX/a11y）

| # | 设计（detail 04） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | window.confirm Promise 桥模式（useConfirmGate + ui/ConfirmDialog 契约）与 3 个异步化点 | **9 文件/10 调用实读确认**（SettingsUsageTab:523-524 双行条件命中，总调用数 = 10）；三个异步化点逐一命中：`useFileNavigation.ts:119-121` 签名已异步（5 个 await 消费面）、`useFilePreview.ts:135` async 内条件、`ComposerField.tsx:136`/`TiptapComposerField.tsx:253` 同步布尔 + long-press 吞 click（:171/:288 语义）；其余 5 点同步早退行号全部命中；"9 点 9 写法"治理依据成立 | ✅ |
| 2 | 快捷键双源对照表（7 行） | 注册表 BUILTIN_SHORTCUTS（:24 `Escape Escape`、:29 open_security `Ctrl+Shift+S`、:33 export_logs `Ctrl+Shift+L`、:34 toggle_runtime `Ctrl+Shift+R`）与设置页 DEFAULT_SHORTCUTS（:23 open_security `Ctrl+Shift+E`、:24 open_extensions `Ctrl+Shift+X`/open_schedule `Ctrl+Shift+J`、:25 toggle_runtime `` Ctrl+` ``、:26 close_tab MiddleClick）**逐键实读一致**；AppShortcuts:149 forkTitle「双击ESC分叉」、:193-199 DEV 门（detectConflicts 仅 DEV）命中；open_models 双源一致（"缺默认绑定"提案修正过时成立） | ✅ |
| 3 | 16 无名称按钮清单 + 触屏尺寸 + R-07 串行 | ModelBadgePickerMenu.tsx:84 `aria-expanded={isHovered}`（hover 驱动 ARIA）命中；DiffCard.module.css:834-847 `.hoverActions{display:none}` + :847 `:hover` 揭示 + :851-852 fileStat + :863-864 22×22 全部命中；16 按钮文案清单与 5 文件面一致；03/04 双向 R-07 交接（02 保留 aria-label 红线 + 08 重扫判据）互见声明 | ✅ |

### 05（T-E 状态治理）

| # | 设计（detail 05） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | D2 连接态单真源化（engineOnline 去留） | **18 处 raw setState 清单逐项精确命中**（useStreamCallbacks 404/487/505/811/1061、useAgentStream 134/280、messageHandlers 36、subagentHandlers 118/146/165、AppBootstrap 155、useOverviewState 154、workspaceChromeHooks 319、Workspace 69、ApprovalSection 68、workspaceStore 121/130；store-persistence.ts 泛型内部 setState 不属白名单外残留，剔除合理）；`useEngineState.ts:33/:100/:147/:170/:172` engineOnline 写点命中；ErrorStore 四态 + `:191-193` setConnectionStatus + `:212` 投影命中；`bootstrap-services.ts:81/:116` 双空 catch 命中（文件实位于 `src/` 根，非 `app/` 子目录——路径无关紧要）；AppBootstrap :147 动态 import/:154-156 recipe/:178-182 双 rAF/:185-190 自订阅/:192 事件全部命中；rustCoreStore DEAD 自证 :39-42 + index.ts:174-179 导出组命中 | 🔧 **消费方清单不完整**：RuntimePanel 将 `engineOnline` 以 props 下传 LiveTasksSection（:155-157）/BgTasksSection（:159-161）/PlansSection（:182-184），三组件各自声明该 prop（:25/:27/:18）并用于空态文案。05 的 D2 迁移清单仅列 RuntimePanel/OverviewCard，"grep engineOnline 零命中"验收判据缺 3 文件面无法达成（见 ③-P0-1） |
| 2 | 新 action 13 个命名与归属（③ 表 18 处 → 13 action 闭合） | U1-U5/A1-A2/M1/S1-S3（11 事件面）+ B1/C1/C2/C3/C4（5 组件面）+ W1/W2（2 store 内部）映射闭环自洽；事件面 11 处与 18 处清单逐行一致（"03 方案自算 10 处"的修正成立）；W1/W2 facade recipe（workspaceStore:121/:130）与 check-no-as-any-store FACADE_REQUIRED 联动（:218-219）已登记 | ✅ |
| 3 | 快照桥防线 3 后置接线（check-no-raw-setstate 顺带断言） | 与 01 的防线 2（AppBootstrap.test.ts readFileSync 结构断言）衔接成立（该测试 :12/:27 readFileSync 模式实存）；R-03 门禁归属（脚本+CI 归 T-E、02-A2 仅迁移）与触发条件（脚本先入库 → 迁移 → 清零接线）自洽 | ✅ |

### 06（T-F 通信契约）

| # | 设计（detail 06） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | Rust rename 双端同步公式（92/88/4 → 87/83/4） | `command_manifest.rs:201-214` `manifest_count_matches_registered_surface` 断言 `total=92/registered=88/pending=4` 实存；`commandManifest.test.ts:44-45`（88/92）与 :263（92）命中；:7 过时注释（84/89）实存；退役 5 条 → 87/83/4、6 条 → 86/82/4 算术推导正确；退役快照条目行号（commandManifest.ts:107/:118/:129/:134/:136）**逐条精确命中** | ✅ |
| 2 | 幽灵 11 条裁决（接线 6/退役 5，含 highlight 待用户裁决） | 接线证据链：markdownRenderAsync.ts:37-48（Rust 优先 + worker 回退）✓、core_md_render_batch 完整实现（mddocs :34-40）✓、core_md_render_stream 退役依据（:44-45 自证 JS 零 IPC）✓、core_md_clear_cache 退役依据（:78-80 moka 自动 LRU）✓、M7 修正（QuickOpen 不存在、入口落 StatusDiagnosticsPanel.tsx:209）✓、commandMap.ts:33 `core_read_run_events` 幽灵白名单条目命中 ✓ | ✅ |
| 3 | 分裂 rename 7 任务 | `fs_commands/mod.rs` 6 条命令全部无 rename（分裂实证）；main.rs :115-118 自认注释 + :119-122 元组名（计划引 :112-118，行号微偏 3 行，语义定位即可）；前端 5 调用点（workspaceFsApi:104/:156/:190 + importFsHost:117/:142）+ 测试 4 处（desktopNativeFeatures.test.ts:245/:258/:334/:341）全部命中 | ✅（行号微偏 P2） |
| 4 | 错误码双向（13 vs 8+6 缺口）+ 归一器锁定 | `stream_error.rs` kind_str 13 分支（含 aborted/payload-too-large/context-length-exceeded/invalid-request/unknown）；`userFacingErrors.ts:65-75` KEBAB_KIND_TO_SOFT 8 键、:121-128 KEBAB_TO_DOMAIN 6 键——缺口与 06 表逐行一致；ENGINE_NORMALIZERS :399-859 结构确认（42 键计数与 41 键事件类型清单核对成立，差集 7 = 4 别名 + 3 subagent 推导自洽）；invokeCmd **13 处生产清单逐项命中**（backgroundTasksApi 4 + hostOpenersApi 2 + rustCore 4 + workflowRunner 2 + skillsApi:417 tryInvokeTauri 别名） | ✅ |

### 07（T-G 工程化）

| # | 设计（detail 07） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | CSP 内联主题 script sha256 放行方案 | index.html:143-177 内联主题/字体预载 script **实存**（计划对 06 方案"无内联 script"事实错误的修正成立）；dist/index.html 实测保留内联 script + 宽 CSP 串（含 unsafe-eval）——"交集下主题预载已被静默拦截"推论成立（N1 追加语义已在阶段 3 源码级证实）；tauri.conf.json:29 严格串（含 ipc.localhost/asset:/frame-src/worker blob:）实读，prod 串逐指令对齐表补全合理；`ctx.server` dev/build 判定设计成立（dev 由 dev server 直服） | ✅ |
| 2 | chunk 拆分"先拆分后定阈值"策略 | vite.config.ts:216 `chunkSizeWarningLimit: 1100`（降噪开关注释）命中；:221-241 manualChunks 函数式 + Windows 归一命中；App-*.js 实测 **1137.5KB**（与计划一致）；tiptap 唯一入口 TiptapEditorField.tsx:15-28 全图 8 包命中；xterm 双入口（TreeLeafPanel.tsx:37-38 已 lazy / CardPanelLayout.tsx:5 **eager**——实际路径 `components/card-panel/CardPanelLayout.tsx`，计划未写全路径但语义准确）；`n.includes('@tiptap')` 覆盖 pm 的推断合理；vendor-tiptap 400-600KB 估算标注"以实测为准" | ✅ |
| 3 | CI build job + 锁文件 + lint 口径 | ci.yml 实测 9 job（typecheck/lint/vitest-fast/audit/engine-bindings-drift/cargo-deny/secret-scan/rust-check/rust-unit-fast）无任何 build——"产物从未被机器验证"成立；根 package.json 已有 `build:shared-types`/`build:desktop` 转发（G7 口径复用合理）；N2（shared-types exports.default → dist）为阶段 3 已证实结论；三份过期锁文件 git 跟踪面 + stylelint 未锁定（16.26.1）声明与实测一致 | ✅ |

### 08（T-H 性能）

| # | 设计（detail 08） | 实读结果 | 结论 |
|---|---|---|---|
| 1 | 完成行窗口 + 尾行缓冲的 append 单调性 | `StreamRenderBuffer.ts:191-200` 帧构造（delta 正确产出 :184、`html: ''` :197、`chunkUpdates: []` :198、isFinal :195）命中；flushFrame 纯函数 :241-279 与"帧控制无需改动"声明一致；Stripper 三游标设计（rawLen/displayLen/partialLine）的单调性推导自洽（完结行永久固定 + 尾行 1 帧延迟 + complete 全量收敛）；"单实现原则"（finalFlush 直接调全量版）把漂移面收敛为区域切分边界——设计成立 | ✅ |
| 2 | draining 标志放宽 + finishComplete 拆分 | useStreamCallbacks:294 `runClosed && !frame.isFinal` 守卫命中；:716-717 `push('', true)` + `flush(true)` 命中；streamManagerRef 删除点 :860（计划引 :857-861 区间内）与 finalizeStopGeneration :1014 命中；finishComplete 幂等（draining=false）与 streamManager 同步释放（防新 run 误拒）设计自洽；commit 文本来源（getStreamText → currentText 兜底）与 store 契约不动（streamingStore.ts:132-147 同值早退实测命中）一致 | ✅ |
| 3 | 消费端每帧全量重算 + 搜索态 | MessageContent.tsx:56-68（displayMsg 全量重建）、:68 buildAssistantTimeline、:119 每 text 项 strip、:122 `isThinkingMsg && item.key === lastTextKey` 全部命中；ChatMessageList:156-161（messagesIdsKey/windowScanKey 条件）、:163-171 collectMustIncludeIndices、:173-186 resolveExpandedForKeepAlive 命中；sessionSearch:345-347 每消息重 tokenize 命中、:572/:581 subscribeSearchQuery/getSearchQuerySnapshot 命中（L3 注入面二选一决策点已登记）；useChatCardState 实际位于 `components/chat-card/`（计划未写路径但 selector 结构 :69-77 命中） | ✅ |

---

## ② 数字一致性抽查（10 项）

| # | 数字（出处） | 实读 | 结论 |
|---|---|---|---|
| 1 | 18 处 raw setState（05 ③ 表） | 18 处文件:行号逐项命中，与 detail 列表完全一致（store-persistence 泛型内部 setState 属 store 基建，剔除合理） | ✅ |
| 2 | 42 键归一器 / 41 键事件类型（06 M1） | ENGINE_NORMALIZERS 定义面 :399-859 结构确认；ENGINE_EVENT_TYPES 清单 41 键逐项可数；差集 7 = 4 历史别名 + 3 subagent 推导成立 | ✅ |
| 3 | 13 处 invokeCmd（06 M2） | 12 处直接命中 + skillsApi.ts:13（`import { invokeCmd as tryInvokeTauri }`）/:417 别名命中 = 13 | ✅ |
| 4 | 9 文件/10 调用 window.confirm（04） | 9 文件 grep 命中，SettingsUsageTab 双行条件（:523-524）→ 总调用 10 | ✅ |
| 5 | 85/88/87 Tooltip 消费文件（03 附 1） | 实测 83 直引（80 `../Tooltip` + 3 `../../Tooltip`）+ 4 barrel = 87；口径差异声明（含自身/测试）成立 | ✅ |
| 6 | 14 组快照测试（01，R-09） | MessageSnapshots.test.ts 实测 14 个 `it(`、2 个 describe（文件实际位于 `src/api/`） | ✅ |
| 7 | 11 个 SettingsSelect 消费方（03 T13，R-09） | 11 个生产文件 grep 命中，与计划清单逐行一致 | ✅ |
| 8 | 13 处 mock 键（01-B6） | **实测 11 处**（markdownRenderAsync.test.ts 的 `'md_render'` 字面量 11 个）；detail 01 B6 与附证据表均写"13 处"（列出的行号也仅 11 个）；detail 06 M3 已正确修正为 11 处——**01 与 06 口径冲突**（见 ③-P1-1） | 🔧 |
| 9 | 423/426 处 color-mix + 31 档（02 S2） | 全仓扫描 426 处命中（审计 423 差 3 为 tsx 注入段差异）；分布表 32 个档位的每档处数**全部精确匹配**（含 10→64、8→59、8.0→1 等众数）；但"31 档"标签 off-by-one——**实为 32 个不同 X 值**（阶段 3 评审同样列出 32 项却标 31） | 🔧 |
| 10 | 92/88/4 → 87/83/4（06 T2.12） | command_manifest.rs:212-214 断言与 commandManifest.test.ts:44-45 双端锁定；退役 5/6 条算术正确 | ✅ |

**结论：10 项抽查 8 项精确、2 项需修正（均不影响执行骨架：①01 mock 键数按 grep 实测 11 处执行即可；②"31 档"实为 32 档，分布表本身精确，执行脚本不受影响）。**

---

## ③ 跨 detail 冲突清单

### P0 必须改（不改则验收判据无法达成）

| # | 冲突/缺口 | 涉及 | 修正要求 |
|---|---|---|---|
| P0-1 | **05-D2 消费方清单不完整**：engineOnline 除 RuntimePanel/OverviewCard 外，经 RuntimePanel props 下传 LiveTasksSection（:155-157）、BgTasksSection（:159-161）、PlansSection（:182-184），三组件各自声明 prop（:25/:27/:18）并用于空态文案（emptyPlansHint/emptyLiveTasksHint 等） | 05 ①-1-2 + ⑥-6.1 | 迁移清单补齐 3 文件；三处空态文案按 connectionStatus 投影迁移（与 runtimePanelLib 的 formatEngineStatus* 同款语义）；验收判据"`useEngineState.ts` 无 engineOnline（grep 零命中）"才可达成；同时补充"RuntimePanel 不再向下传 engineOnline prop"断言 |

### P1 建议修正（数字/表述，不改骨架）

| # | 冲突/缺口 | 涉及 | 说明 |
|---|---|---|---|
| P1-1 | **01-B6 mock 键数 "13 处" 与实测 11 处冲突**（06-M3 已修） | 01（B6 + 附证据索引）vs 06（M3） | 01 两处同步修正为 11 处（行号列表本身即 11 项，属笔误）；不影响执行（grep 门禁兜底），但验收对账时按 11 |
| P1-2 | **02-C1（ChatMessageList 30 props 聚合）未出现在任何 detail 的任务表与 master plan 批次**：master plan 批次 3/5 覆盖 02-A/B/D，03 detail 任务表 T1-T13 无 C1；而 08（T4.3 收窄）、04（T6-1 同文件）、30-02 依赖链均引用 02-C1 为前置 | 00 master plan + 03 detail | 与 03 detail 风险 5（裸 button 剩余波次）同类执行缝隙：需主控裁决 C1 批次归属（建议并入批次 5 T-C-B 或独立小批），否则 08 T4.3 的"收窄"部分与 04 T6-1（role="log" 同文件）长期依赖一个未排批的任务 |
| P1-3 | **02 与 05 对 themeStore.ts 的串行登记仅单侧声明**：02 §0 登记 C11（本批只动 applyTheme 注入段 :706-742/:773-795，不碰 persist 写端）；05 ①-3（D3 persistTheme :49-65/setTheme :823-829）未反向声明 | 02 §0 vs 05 ①-3 | 调度提示：05 侧补一行同文件串行声明（05 提交 C 与 02 S1-注入 不在同批次，实际批次错开成立，仅文档对称性） |
| P1-4 | **04 T6-1 与 08 T3.3 对 ChatMessageList.tsx 的改动方向**：04 补 role="log"（容器层）、08 改 windowScanKey 降级 + 命中缓存注入——同文件双任务 | 04 T6-1 vs 08 T3.3 | 08 已声明"本轨道先行、08-步7 排后"（08 §4 串行），04 §2.6.1 亦声明"07 先行、08 后置"——双向声明一致，无需改；仅提示派单时按 08(批次8) → 04 T6(批次6?) 时序——**注意**：04 T6-1 属批次 6，08 属批次 8，实际批次顺序已是 04 先于 08，两处声明的"07 先行"均指 07 方案（性能轨道）而非批次 6——语义一致无冲突，登记确认即可 |

### P2 观察项（不阻断）

| # | 观察 | 说明 |
|---|---|---|
| P2-1 | 03 称新 Tooltip 314 行，实测 294 行（旧件 150 行精确） | 行数漂移 20 行，props 映射表以语义定位为优先（已声明"行号语义定位优先"纪律），不构成执行阻断 |
| P2-2 | 02 "混色 31 档"实为 32 个不同值（分布表 32 项全部精确） | 标签 off-by-one；阶段 3 评审同误差，统一在 detail 02 §3.1 修正文字即可 |
| P2-3 | 全仓裸 `<button>` 组件文件实测 129（03/审计口径 128） | 可能含审计后新增 1 文件；执行以 `rg -l "<button"` 实测为准（计划已声明） |
| P2-4 | 06 T1.2 引 main.rs:112-118，自认注释实际位于 :115-118 | 行号微偏 3 行，语义定位即可 |
| P2-5 | 05 D3 行号（persistTheme :49/applyTheme :71/setTheme :823）与 02 注入段行号（:706-742）分属同一文件不同函数段 | 已由 02 侧 C11 串行声明覆盖；05 侧补声明见 P1-3 |

---

## ④ 高风险任务表（"看似小改实则大风险"）

| # | 任务 | 风险面 | 实读证据与缓解评估 |
|---|---|---|---|
| 1 | 01 快照桥接线（A1/A2） | 接线后 undo 行为面：读侧（undo/peek/peekDelta/getStack）生产零调用已实读确认——接线不新增 UI 行为；唯一真实变化 = withdrawMessage 每帧 O(n) 倒向 diff + 内存快照 + deleteSession 真实清栈 | 风险等级低→中；上限 5MB/栈深 20 内置（MessageSnapshots.ts:139-140）；回退 = 移除装配块 15 行；防线 1 单测锁 + 防线 2 结构断言（AppBootstrap.test.ts readFileSync 模式实存）——三重防线成立 |
| 2 | 01/06 断链修复后 markdown 主路径切换 | Rust 渲染首次真实进入主路径（pulldown-cmark+syntect+ammonia），个别 case 与 JS 渲染差异 → 用户可见 | parity byte 兼容断言（真实键 mock 下）先行红；INTENTIONAL_DIFFERENCES 表登记；worker fallback 完整保留——风险可控 |
| 3 | 02 S1 注入对齐（2.2-3） | 运行时微变（bg-hover 3.5→4%、control-soft 6/11/17→4/4/8 等）——"无视觉变化"声明不成立 | 02 评审 P1-1 已裁决：独立提交 + 视觉抽查（light/dark 各 3 组件）；dark bg-active 第三处不一致纳入同批——已闭环 |
| 4 | 03 T2-T6 Tooltip 迁移（87 文件） | 新件行为收益（键盘 focus 触发 + aria-describedby + 视口钳位）在 90% 机械替换面之外引入潜在"聚焦残留/贴边微移" | 每批键盘冒烟验收 + 行为收益登记为预期变化 + 非机械点（cloneElement restProps）逐文件核对——已闭环 |
| 5 | **04 T1 window.confirm 异步化** | 同步布尔 → Promise 桥：取消路径漏改 → "取消后仍执行"；ComposerField 长按吞 click 语义最敏感（确认→吞、取消→不吞仍走 L2） | 行为变更清单逐点签字 + 两路径测试 + 每点独立提交（回退粒度=单点）；useConfirmGate ≥3 消费点判据成立——风险等级高但缓解完备 |
| 6 | **05 步骤 3 事件收敛（11 处写路径）** | 幂等语义与时序重组：流式 token/thinking/tool/终态、per-run + 全局兜底双写入方、cacheMetrics、stop 批量 | 新增 action 与原 recipe 逐行等价对照 + EventRouter 去重/`_liveParentRuns` 判活零改动 + 既有测试不破（useStreamCallbacks.streamStore.test.ts 等）——风险等级高，是批次 5 最重任务 |
| 7 | 05 D2 连接态合并（提交 B） | 行为变化：recovering 从"离线"变"重连中"文案 + EventBus 多一跳延迟（两 UI 短暂不一致）+ **消费方清单缺口（P0-1）** | 投影语义映射表先定 + 验收断言"两处 UI 一致"；P0-1 修正后清单闭合 |
| 8 | 06 退役条数公式连锁（T2.12） | 92/88/4 被双端测试锁定，退役 5-6 条必须同轮双端同步，否则 cargo/vitest 双红 | T2.12 强制同提交（6.3-a 单提交）——已闭环 |
| 9 | 07 CSP 收窄（T3） | 表面"收窄"实为相对现状交集的**放宽**（内联 script 经 hash 放行恢复执行、worker blob 恢复）；最大风险 = hash 计算与 vite 产物不一致 → 主题预载静默失效 + violation 噪音（现状交集已禁，失效即现状） | check-dist `--csp-enforce` 强制断言（恰 1 个 CSP meta、script-src 含 sha256-）+ e2e-prod 用例 2 零 violation + 本地 tauri build 产物抽查——三重守护成立；切 isolation pattern 的反向迁移已登记 |
| 10 | 08 appendText 与 React 协调冲突（T1.3/T1.5） | 流式节点被传入 children/text 或 React 重协调 → 文本重复 | StrictMode/重挂载守卫（30-02 P1-3 已吸收）+ children 恒空契约红线 + 单测三路径（append 累积/双执行/重挂载复位）——已闭环 |
| 11 | 08 complete 分帧 draining 守卫放宽（T2.2） | 中间帧放行 + runClosed 后置：重复 commit / 新 run 误拒 | finishComplete 幂等（draining=false）+ streamManager 同步释放（:860）+ commit 兜底 currentText——设计自洽；e2e tool-streaming/streaming-render 强制回归 |
| 12 | 08 搜索态 S3 降级（T3.3） | "processing 期 windowScanKey 降级为 messagesIdsKey"依赖"流式消息恒在尾部窗口"假设；keep-alive 重扫节流若失效 → 搜索命中残留 | 开关式节流（processing 激活即降级、非流式恢复引用扫描）+ 命中缓存 queryKey/msgRef 身份失效三路径单测；P2-4 已登记实现前确认——可控 |

---

## ⑤ 派发就绪度表

| detail | 就绪度 | 依据 | 前置条件 |
|---|---|---|---|
| 01（T-A） | **直接可派**（附 1 项文字修正） | 4 项核心设计全部实读成立；R-10 脏状态前置（git restore）事实准确；文件面与并行域（R3/04 轨道）错开声明完整 | 修正 B6 "13 处"→"11 处"（不影响执行）；批次 0 清理先行 |
| 02（T-B） | **直接可派**（附 2 项待主控确认） | S0/S1/S2 全部实读成立；"31 档"标签 off-by-one 不影响脚本执行 | ① tint 基底（text-primary vs control-mix）主控确认（计划已标注）；② 28% 档 5 处 settings 语义（--tint-selected 或保留）主控裁决 |
| 03（T-C） | **直接可派**（附 3 项主控裁决项） | 任务表自洽、批次内串行链（T1→T8）与批次 5 并行面（T9/T10 vs T11-T13）声明完整、R-07 交接清单完整 | ① 裸 button 剩余波次承接批次（风险 5，主控裁决）；② 02-C1 未排批（P1-2，主控裁决）；③ group 能力 grep 决策（执行时） |
| 04（T-D） | **直接可派** | 9+1 confirm 面、快捷键双源、16 按钮清单全部实读一致；02-E3 基座依赖已登记 R5 降级路径（契约先行、验收后置） | 02-B1/B2 先行（R-07 串行，批次 3 后派发）；02-E3 ConfirmDialog 基座就绪确认 |
| 05（T-E） | **需修订后派**（1 项 P0） | 18 处清单、action 表、门禁设计全部实读成立；风险 3（11 处写路径）缓解完备 | **P0-1：迁移清单补齐 LiveTasksSection/BgTasksSection/PlansSection**；02-A2 触发条件（check:store-facade 基线先行）按 4.3 时序 |
| 06（T-F） | **直接可派**（附 2 项用户裁决） | 双端公式、11 条幽灵裁决、13 处 invokeCmd、错误码缺口全部实读成立；M1-M8 修正记录准确（M6 无 CI 改动的结论有据） | ① highlight 接线/退役用户裁决（双路径已备）；② context-length-exceeded 文案用户裁决；T-A 批次 1 断链清零前置 |
| 07（T-G） | **直接可派** | CSP 事实修正（内联 script）、chunk 现状、锁文件、lint 口径全部实读成立；不确定处（dev 注入面）已声明"行为不变"兜底 | 步骤 0 基线先行（T7-1）；T5-4 format 基线在任何功能批前 |
| 08（T-H） | **直接可派**（附 1 项前置） | Stripper 单调性、draining 拆分、三层防线设计全部实读成立；commit-1/commit-2 文件面零重叠声明可核（A 不动 useStreamCallbacks/StreamRenderBuffer/sessionSearch 等） | T-C memo 面（02-C1）就绪后执行——**该前置受 P1-2（02-C1 未排批）影响，需主控同步裁决** |

**总体结论**：8 份详细计划的核心设计经实读复核**全部成立或小幅修正**，无技术否决项；抽查数字 8/10 精确、2 项为文字级修正；跨 detail 冲突 P0 仅 1 项（05 消费方清单，属执行清单类修正而非设计否决）、P1 4 项、P2 5 项。**派发就绪度：6 份直接可派（01/02/03/04/06/07）、1 份需修订后派（05，P0-1 补齐清单即可）、0 份需阻塞**。执行前需主控裁决的悬置项合计 6 条（tint 基底、28% 档、裸 button 波次、02-C1 排批、highlight 去留、confirm 文案），均已在各 detail 内登记。

---

（本评审完——实读复核 2026-08-09 工作区；未逐行核验项已标注：ENGINE_NORMALIZERS 42 键为结构+差集推导确认而非逐条枚举、dark 块 --control-mix-color 静态缺失为推断、Tauri dev 模式 CSP 注入行为未深究——均已在对应 detail 中登记或属"行为不变"面。）
