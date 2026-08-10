# 前端修复批次 1-9 销号声明 · 独立复审验证（50）

> 产出：`docs/frontend-audit/50-reverify/01-signoff-verification.md`
> 复审角色：只读复审子 Agent（实读代码，逐项验证，不轻信声明）
> 日期：2026-08-10。输入：`00-cross-analysis.md`（P0×6/P1×14 清单）、`40-final-plan/90-final-report.md`（批次 9 销号声明）、批次 1-9 提交（e782abe7 / 9b5b2cfe / 9e35f495 / d64a41b8 / add998ed / 33fa13e6 / d14ef9e2 / 1d5b36a4 / 0ab2d2b9）

---

## 0. 结论速览

| 结论 | 计数 |
|---|---|
| P0 六项实读 | ✅ 6 / ⚠️ 0 / ❌ 0 |
| P1 抽查九项（任务要求 ≥8） | ✅ 8 / ⚠️ 1 / ❌ 0 |
| 额外检查（契约门禁快层覆盖） | ✅ 确认 |
| 报告真实性偏差 | 2 处（P1-1 退役声明不实；R-11「全量重写」声明不实） |

**总判定：全销号声明部分成立。** P0 六项全部真实落地（核心功能面与声明一致）；P1 抽查中 P1-1（.ui-btn 退役）未完成——全局类定义与 CSS 消费面残留，报告「退役删段后收尾 ✅」与实读不符；批次 9 的 R-11 编码统一声称「全量重写」的 4 个 css 文件仍残留约 25 行 mojibake 注释。其余 P1 抽查项（tint 档位 / TabStrip / Switch / 吞错门禁 / 行数门禁 / build 进 CI / 幽灵命令）均实读确认。

---

## 1. P0 × 6 复核表（声明 vs 实读）

| # | 项 | 报告声明 | 实读证据 | 判定 |
|---|---|---|---|---|
| P0-1 | 快照桥 `_ops` 恒 null | 接线（01-detail A1-A6；bootstrapStores 装配，e782abe7） | ① `bindMessageSnapshotsOps` 实现于 `store/messageSnapshotsBridge.ts:38-44`（幂等 + 替换告警）；② `store/bootstrapStores.ts:143-158` 真实 `new MessageSnapshots()` 并注入（try/catch 兜底不炸启动）；③ 调用点 `app/AppBootstrap.ts:139`（useEffect 内 `bootstrapStores()`）；④ 消费面：`store/sessionMessageActions.ts:121`（撤回保存）、`store/sessionCrudActions.ts:442`（删除会话清栈）；⑤ 防误删测试 `app/__tests__/AppBootstrap.test.ts:115-116`（T-A-1 断言源码含 bind 调用）+ `store/messageSnapshotsBridge.test.ts`（幂等/替换/清空/幽灵会话） | ✅ 已解决 |
| P0-2 | 3 条断链命令 | rustCore 真实键 + TelemetryMonitor 接线（B1-B7 证明链） | ① `api/rustCore.ts:202` `renderMarkdown → core_md_render`、`:217` `renderMarkdownBatch → core_md_render_batch`；② `services/TelemetryMonitor.ts:110-115` flush 走 `core_jsonl_append`，`:123-129` missing 分支 `logInternalError`（不再静默，非 test 环境）；③ 旧键 `perf_jsonl_append` 全仓零命中（仅 TelemetryMonitor.test.ts:6 注释提及「非旧键」）；④ Rust 注册面 `src-tauri/src/main.rs:178/179/191`（command_registry! 宏，注册面真源）三键在册；⑤ `core_highlight_code` 注册在册（main.rs:180）但前端 wrapper 已删（`transport/command-contract-drift.test.ts:196-198` 豁免注释：T-F 06 C-6 裁决「命令注册保留供路径 A 恢复」）——非断链，属登记保留 | ✅ 已解决（附注：highlight 为「注册保留零消费」，与 P1-14 幽灵同口径） |
| P0-3 | 悬空 token 引用 | 补定义/fallback（style-contract ⑧ 全绿） | ① `--accent-green/red-light-adaptive`：`styles/tokens.css:82-83`（light）+ `:506-507`（dark）双定义，`api/themeStore.ts:706-707` 运行时注入，`components/diff/DiffCard.module.css:583/740/743/751/754/891` 全部带 fallback；② `--tooltip-translate`：`components/ui/Tooltip/Tooltip.module.css:21/25/32/36` 全部 `var(--tooltip-translate, translate(0))` 静态 fallback + `Tooltip.tsx:302` 运行时注入；③ `--chart-color-1/2`：使用点已迁移为 `--accent-chart-in/out`（tokens.css:95-96 light + 516-517 dark 定义，消费于 `components/settings/SettingsUsageTab.module.css:275/281`），旧引用清零（style-contract.test.ts:330-338 全仓正则断言） | ✅ 已解决 |
| P0-4 | `.card-tab.active` 双声明死规则 | 双声明删至 1 条（⑧-④ 断言） | `styles/shell/shell-workspace.css:834` 仅存一条 `.card-tab.active { background-color: var(--bg-primary) !important; … }`；style-contract.test.ts:370-377 断言「基础声明仅 1 条」且豁免皮肤复合选择器（theme-dark.css:143 等）；实读无第二条裸 `.card-tab.active` 声明 | ✅ 已解决 |
| P0-5 | 旧 Tooltip 双轨（88 消费无 a11y） | 迁移 + 旧件退役（批次 3） | ① `components/Tooltip/` 旧目录不存在（glob 零结果）；② 全仓消费仅 `ui/Tooltip`（`ui/index.ts:11-12` barrel + `ui/Select/Select.tsx:15`）；旧路径仅存于 `ui/Tooltip` 文件头部历史注释；③ a11y 面由批次 4（aria-label/键盘）承接，`ui/Tooltip/Tooltip.test.tsx` 覆盖 | ✅ 已解决 |
| P0-6 | 流式渲染退化（48ms 全量重渲染） | 批次 8：StreamingTextBlock O(Δ) append + complete 收口 + perf 防线 | ① `chat-message-row/StreamingTextBlock.tsx:33-40`：children 恒空 + `useLayoutEffect` `appendChild(createTextNode(delta))` 增量写 DOM，`lastDeltaRef` StrictMode 幂等守卫；② `chat-message/MessageContent.tsx:204-208` delta 由 `stripper.next(streamText).appended` 提取，`:318-321` 传入 StreamingTextBlock（key 含 streamKey 防收缩重挂载）；③ complete 收口 `hooks/chat-stream/useStreamCallbacks.ts:305-311`（isFinal 帧落盘 + draining）；④ perf 防线实存：`api/StreamRenderBuffer.framing.test.ts` + `api/searchPerf.test.ts` + `tests/e2e/perf-streaming.spec.ts`（1d5b36a4 提交内） | ✅ 已解决（附注：`:309/319` 每帧仍 `setStreamText(sid, …, frame.full)` 全量写轻量 streaming store——store 面 O(全文) 内存写保留，DOM 面 O(Δ)；因轻量 store 隔离 + 预算帧 + memo 渲染，重渲染面已收窄；「每帧全量 set」未完全消除，属设计取舍） |

**P0 结论：6/6 实读通过（两项带附注）。**

---

## 2. P1 抽查复核表（9 项，任务要求 ≥8）

| # | 项 | 报告声明 | 实读证据 | 判定 |
|---|---|---|---|---|
| P1-1 | 按钮三轨收敛（.ui-btn 退役） | `.ui-btn 36 文件迁移 + 退役删段后收尾` ✅ | **ui/Button 接管真实**（barrel 导出、tsx 无裸 `ui-btn` 类消费——全仓 tsx 中 `ui-btn` 仅存于 Button.tsx 注释）。**但 `.ui-btn` 全局体系未退役**：`styles/shell/shell-polish.css:18-84` 仍定义 12 条（.ui-btn/-sm/-md/-primary/-secondary/-ghost/-ghost.danger/-block）；CSS 面仍有生产选择器：`components/diff/DiffCard.module.css:368`（`.applyActions :global(.ui-btn)`，而 DiffCard 及全仓 JSX 均无 applyActions/ui-btn 类 → 死规则）、`styles/settings/settings-base.css:555/816/1198-1200`、`settings-plugins.css:986-1002`、`settings-advanced.css:472`（同为零消费选择器）。「退役删段」声明与实读不符 | ⚠️ 部分（接管完成，退役未完成，残留 6 文件 13+ 处死规则/死定义） |
| P1-2 | 混色收敛 tint 档位 | 426 处 → 8 档（C-1/C-2/C-3），剩余 3 处例外登记 | `styles/tokens.css:31-38`（light）+ `:454-461`（dark）8 档：hover 4% / active 8% / strong 12% / focus-ring 10% / divider 12% / scrollbar-thumb 18% / overlay 25% / highlight 28%，注释「全部消费点禁裸 color-mix」；例外复审 4 处已在报告 §2.8 逐条登记（settings-models:387 入档、shell-polish:885 保留、UnitSessionTabStrip:333 保留、settings-base:2370 保留）；style-contract ② 断言基线 3 在册 | ✅ 抽查通过 |
| P1-3 | Tab 条收敛 ui/TabStrip | 批次 5.2（T12） | `components/ui/TabStrip/TabStrip.tsx` + `.test.tsx` 存在；barrel `ui/index.ts:33-34` 导出；7 个 tsx 文件消费 | ✅ 抽查通过 |
| P1-4 | 开关收敛 ui/Switch | 批次 5.2（T11） | `components/ui/Switch/` 存在（tsx + module.css + test）；barrel `ui/index.ts:30-31` 导出 | ✅ 抽查通过 |
| P1-7 | 空 catch 治理门禁 | local/no-silent-catch + 基线 ratchet（§1.3 修测试基准） | `eslint.config.js:233/239` `local/no-silent-catch: 'error'`（:278-291 测试文件豁免段）；CI 快层 lint job `ci.yml:58` `npx eslint .`（规则自动生效）+ `:78` `check:swallowed-errors-frontend` 报告面；基线 ratchet 由 `__tests__/eslint-no-silent-catch.test.ts` 承载（§1.3 修的是测试路径口径，规则本体实读正确） | ✅ 抽查通过 |
| P1-8 | 行数门禁接 CI | 7.3 check-line-counts 进 CI | `ci.yml:75` `npm run check:line-counts`（lint job 内；注释载明三级语义 85% 警告/100% 违规/>650 硬阻断 + per-file 基线收紧） | ✅ 抽查通过 |
| P1-9 | 生产 build 进 CI | 7.1 frontend-build job + check-dist（d14ef9e2） | `ci.yml:107-119` frontend-build job：`npm run build:shared-types`（N2 依赖序）→ `npm run build:desktop` → `node scripts/check-dist.mjs --max-app-kb 500 --csp-enforce`（App <500KB + tiptap/xterm 拆分 + CSP 四断言）；脚本实存 | ✅ 抽查通过 |
| P1-14 | 幽灵命令清理 | 11 条裁决（5 退役 + 接线）+ 9.2 补清 registry 面 + 契约门禁固化 | **注册面实读**：`src-tauri/src/main.rs` command_registry! 宏（:90-99 注册面真源），5 条退役命令（core_read_run_events/delete_session/touch_session/core_md_render_stream/core_md_clear_cache）在注册表**零命中**；Rust 侧退役函数保留但带 `#[allow(dead_code)]` + 「保留待恢复」注释（`core_query_commands.rs:549-551`、`markdown_commands.rs:56/91`、`session_commands.rs:200/346`）——不构成幽灵 wire 键；豁免集 9 条全部在 `transport/command-contract-drift.test.ts:188-215` 逐条注释理由（动态拼接面/登记先行面）；哨兵断言「注册数 ≥80 且 == manifest」+ 断言一零断链 | ✅ 抽查通过（附注：退役函数体未删，属登记保留，建议后续物理清理） |
| P1-5/6/10/11/12/13 | primary 语义 / ui barrel / 状态色 / 菜单族 / props drilling / 巨型拆分 | 各批次声明 ✅ | 抽查：barrel 实读 9 组件全导出（`ui/index.ts`）；状态色收编证据 `tokens.css:95-96/516-517`（chart）、`:25-26`（text-tertiary #696969 = 批次 6.1 对比度值）与 `a11y-contrast.test.ts` 在册；批次 5 提交 add998ed 声明 ModelConfigEditor 889→180、18 raw setState→0；批次 8 提交 1d5b36a4 声明 ChatMessageList 聚合（MessageContent 实读 props 面已聚合化）——本批抽查级确认，未逐条深挖 | ✅（抽查级） |

**P1 抽查结论：8/9 ✅，1/9 ⚠️（P1-1 退役未完成）。**

---

## 3. 新悬空引用 / 死代码 / 残留清单

### 3.1 与报告声明直接冲突的残留（优先级高）

| # | 位置 | 性质 | 与声明的冲突 |
|---|---|---|---|
| 1 | `styles/shell/shell-workspace.css` **14 行** mojibake 注释（:90/191/317/379/442/622/668/1131/1144/1145/1146/1160/1161/1182） | GBK→UTF-8 乱码固化 | 报告 §2.9 声称该文件「全量乱码注释人工重写（87 处）」——实读仍有 14 处（如 :379「閳ユ柡鈧妞ょ數顒烽敍姘session tab…」）。check-css-encoding.mjs 只查 FFFD/BOM，检测不到乱码固化，门禁盲区被坐实 |
| 2 | `styles/panels.css` **3 行**（:1/217/231）、`styles/shell/shell-polish.css` **2 行**（:626/811）、`styles/shell/shell-dragdrop.css` **6 行**（:38/40/58/69/88/96） | 同上 | 同为报告 §2.9 声称「已重写/已转码」文件（shell-dragdrop 为 A 类「GBK 解码无损重写」） |
| 3 | `components/diff/DiffCard.module.css:368` `.applyActions :global(.ui-btn)` | 死规则（全仓 JSX 无 applyActions/ui-btn 类） | P1-1 退役声明不实的直接物证之一 |
| 4 | `styles/settings/settings-base.css:555/816/1198-1200`、`settings-plugins.css:986-1002`、`settings-advanced.css:472` `.ui-btn*` 选择器 | 死规则（无消费类名） | 同上 |
| 5 | `styles/shell/shell-polish.css:18-84` `.ui-btn` 全局体系 12 条 | 死定义（消费面已迁移 ui/Button） | 同上——「退役删段」未发生 |

### 3.2 与报告登记一致、属既有面（非新增）

- `chat-markdown.css` 18 行 mojibake——报告 §7.2 挂账清单内（chat-markdown/approval 面），声明与实读一致；
- `settings-*` 族 mojibake（settings-base 58 行 / settings-models 44 行 / settings-plugins 21 行 / settings-advanced 10 行等）——§7.2「清单外 ~100 处」挂账范围，声明与实读一致；
- 退役 5 条命令的 `#[tauri::command]` 函数体保留（带 allow(dead_code) + 登记注释）——报告明示「函数保留待恢复」，一致；
- 豁免集 9 条（command-contract-drift.test.ts:188-215）——逐条注释理由，一致。

### 3.3 门禁盲区确认

- `scripts/check-css-encoding.mjs`（存在，全仓通过）只检测「严格 UTF-8 解码 + BOM + U+FFFD」——对「合法 UTF-8 的 mojibake 固化」**无效**（报告 §2.9 自认此盲区，但把已重写文件标为清零属误报）。
- 建议：门禁升级为罕见字形/片假名组合扫描（如「閳ユ柡鈧」类 GBK 乱码特征字表），否则 R-11 的「清零」无法机器验证。

---

## 4. 额外检查

| 项 | 结果 |
|---|---|
| 契约门禁 command-contract-drift.test.ts 是否在快层 CI | ✅ **确认**：根 `vitest.config.ts:73-78` unit project include `apps/crish-desktop/src/**/*.test.{ts,tsx}` 覆盖该测试；CI `ci.yml:97` `npm run test:coverage -- --project=unit` 强制执行 |
| 批次 1-9 引入新悬空引用（旧 import/退役后引用） | 未发现「断链引用」（前端 invoke 字面量全 ∈ 注册面，断言一守护）；发现的是**死规则/死定义残留**（§3.1）与**乱码注释残留**（§3.1-3.2） |
| P0-2 旧键零命中 | `perf_jsonl_append` 生产面零命中；`md_render`（无 core_ 前缀）生产面零命中 |

---

## 5. 总结论

**全销号声明：部分成立。**

1. **P0 6/6 全部真实落地**：快照桥三层接线（桥定义 → bootstrap 装配 → AppBootstrap 调用）+ 防删测试；三条断链命令全部改真实键 + missing 可观测；三类悬空 token 全部有定义/fallback；死规则删除有断言守护；旧 Tooltip 物理删除；流式渲染 O(Δ) DOM 增量 + 预算收口 + perf 回归 spec 实存（store 面每帧全量 set 为设计取舍，附注）。
2. **P1 抽查 8/9 ✅**，唯一 ⚠️ 为 **P1-1**：ui/Button 接管面真实，但 `.ui-btn` 全局体系「退役」未发生——shell-polish.css 定义仍在、6 文件 CSS 选择器残留（其中 DiffCard/settings-* 已无 JSX 消费，为死规则）。报告销号表 P1-1 标注 ✅ 与实读不符。
3. **报告真实性偏差 2 处**（均为「声称完成、实际未完成」，非「声称完成、实际未做」）：P1-1 退役；R-11 四文件「全量重写」后仍残留 ~25 行 mojibake（shell-workspace 14 + shell-dragdrop 6 + panels 3 + shell-polish 2）。
4. **挂账如实**：并行域中间态、theme-dark 选择器补丁、清单外 mojibake、!important 保留面、T6-1/T6-3——§7 登记与实读一致，未见隐瞒。

**遗留动作清单（建议主控排期）**：
- P1-1 收尾：删 shell-polish.css:18-84 `.ui-btn` 体系 + DiffCard.module.css:368 + settings-* 4 文件的死选择器（TS 面已无消费，纯 CSS 物理删除）；
- R-11 补扫：shell-workspace/panels/shell-polish/shell-dragdrop 4 文件 25 行 mojibake 注释重写 + check-css-encoding.mjs 升级特征字检测；
- 退役 5 命令函数体物理清理（可选，登记保留已可接受）。

（本文档完——复审结论：P0 ✅6/6 + P1 抽查 ✅8/⚠️1；全销号「部分成立」，无 ❌ 项）
