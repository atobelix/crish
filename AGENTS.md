# Conex / Crish — Agent 协作指令

> **权威副本**：本文件（仓库根目录 `AGENTS.md` / `Agents.md` 同内容）。
> **`.agents/AGENTS.md`**：入口指针，细则以本文件为准（避免双源漂移）。
> **角色库与阶段提示词**：`docs/agent-roles/`（职责 / findings / general_task / prompts；**不是**战役运行期产出目录）。
> **反退避全文与自检清单**：`.agents/LOGIC_PLAN_NO_RETREAT.md`。
> **维护纪律（2026-08-12）**：自本版起，**对本文件只允许追加**（新裁决、新铁律、新速查）；**禁止删除**既有条款。仅当确认**字面重复**时可合并表述，冲突时保留**更完整**的一条并在追加段注明「取代旧口径：…」。

---

# 一、通用协作纪律

## 1. 逻辑规划与反退避（强制）

> 全文与自检清单：`.agents/LOGIC_PLAN_NO_RETREAT.md`。规划 / 方案 / 评审 / 实现 / 调度均适用。

- **效果锁**：用户给定的效果与范围不得自行降级为「简化版 / MVP 砍功能」；冲突只能标出并请示，Agent 无权改目标。
- **纯逻辑规划**：方案只谈逻辑依赖、任务单元、文件域、验收断言；**不谈**工期、人天、人员安排；用户未要求排序时 **问题同权**（禁止用 P0/P1 业务优先级砍项）。
- **禁止退避裁判**：不得以时间、重要性、方案成熟度、生态流行度、「做不到 / 太难 / 业界都用 X」否决路径或劝退自研。不确定 → 设计验证（测试 / 视觉对齐 / 魔鬼用例），禁止把不确定写成不可能。
- **路径合法排序键**：效果完整度 → 正确性/不变量 → 可验证性 → 与已锁定契约一致 → 结构干净。流行栈安全感不是主裁判。
- **验证资产**：视觉强制对齐 + 防回归测试是一等公民；测试不可丢（见本仓「测试资产保护铁律」）。门禁与安全红线仍零容忍，本条不授权骗 CI。

## 2. 子 Agent 调度规则（多 Agent 协同）

- **嵌套禁止（用户裁决，REQ-D08）**：仅主 Agent 可派发子 Agent；子 Agent 深度 1，无派发能力——子 Agent 的工具注册表剔除 `run_subagent`（工具面防护），即便绕到守卫层也返回结构化错误（`subagent.nesting_denied`：「你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。请通过消息/上报向主 Agent 请求派发。」）。
- 一轮最多 **16** 个子 Agent（同时运行未终态 ≤16、同父 ≤16、深度仅 1，见 DEFAULT_RECURSION_GUARD；2026-08-11 用户裁决 12→16）；任务包括：分析（只读+文档）、方案（只读+文档）、评审（只读+文档）、实现（写代码+测试）、提交（仅 git）。
- 派单前明确：输入文档、产出路径、验收标准、文件冲突注意事项（同文件串行）。
- 子 Agent 可读最终计划文档，但只执行分配给自己的任务；执行中发现任务书未覆盖的问题上报调度者裁决。
- **空返回无限重派纪律（2026-08-11 修订，供应商网络问题）**：子 Agent 汇报为空返回（无最终消息/无产出）时，**默认是供应商网络问题而非任务失败**——先核查文件/代码是否已落盘（空返回时常已实际完成）并 `git status` 检查并行 Agent 是否已误伤/已提交；未落盘则**按原提示词（保持完整长度，不缩短）重新派发**；**不设重试上限，无限重派直到有一次成功**（网络问题是瞬时的，原样重派最终会撞上好窗口）；任务过大时可拆小重派（单文档/单文件粒度成功率更高），但**优先原提示词原样重派**，不得因空返回擅自缩短提示词或砍任务范围。
- **子 Agent 优先与接管阈值（2026-08-11 用户裁决）**：优先派子 Agent 执行（主 Agent 每次分配子 Agent 更省事）；子 Agent 空回累计 **6 次以上**才由主 Agent 接管实现；5–6 次仍空回时，可考虑将任务**拆分**后重试（单文档/单文件粒度成功率更高），而不是直接接管或砍范围。
- **执行环境（2026-08-12 用户裁决）**：子 Agent 执行命令统一使用 **pwsh7（PowerShell 7+）**，避免 Windows PowerShell 5.1 的 GBK 默认编码与内联脚本插值问题；写文件 UTF-8 无 BOM。
- **角色细则（追加）**：主控 / 子代理 / 执行期固定审计位 → `docs/agent-roles/general_task/`（`main-agent.md` / `sub-agent.md` / `execution-audit-slots.md`）。

## 3. 多 Agent Git 提交纪律（2026-08-12 用户裁决，强制）

仓库内常有多个 Agent + 自动化定时 git 专用 Agent 同时工作（定时 Agent 会扫描并提交未提交代码）。以下纪律所有 Agent（主控与子 Agent）必须遵守：

1. **允许并行提交**：子 Agent 完成任务后**可直接提交自己的文件域**（无需等主控收口）；主控不再独占提交权。提交前先 `git status` 检查目标文件未被并行 Agent 正在修改。
2. **严禁回撤**：任何 Agent 不得 `reset --hard` / `checkout .` / `restore` 覆盖他人已提交或未提交的改动；不得 rebase 冲掉他人提交（rebase 仅由主控协调执行）。改错自己文件 → 用精确 edit 修复，不用全局回撤。
3. **共享 index 提交**：`git add` 写入仓库级共享 index（可能已含并行 Agent 的 staged 文件）——提交时用 **`git commit --only <paths...>` 限定自己的文件路径**，避免误提交他人 staged/工作区文件；不要把他人文件 `git reset HEAD --` 出 index（仅索引操作也可能干扰并行 Agent）。
4. **被吞并处理（不回撤、不重做）**：若自己的改动已被其他 Agent / 定时 git Agent 提交（吞并），**只验证内容完整性**——`git show HEAD:<path>` 对比工作区/预期内容；**完整则不管归属，缺失则追加**（追加用 `git commit --only` 限定路径）。禁止因归属不纯而回退重做。
5. **hook 阻塞**：`.husky/pre-commit` 的 `git diff --check` 检查**整个工作区**（含并行 Agent 未提交文件）——他人文件的 trailing whitespace 会阻塞所有提交；发现时对该行做**最小 whitespace 修复**解除阻塞（不碰内容），或上报主控协调。
6. **提交纪律不变**：禁止 `--no-verify` 绕过门禁；lint-staged 报错必须修复后重提；提交信息遵循仓库风格（feat/fix/refactor/test/docs/chore + 范围 + BATCH-* 批次标记）。

## 4. 多 Agent 协作文档产出约定（REQ-G02 流程层）

多 Agent 协作文档产出的共享目录、文件名分配、汇总索引与格式约定。对齐 `docs/multi-agent-repair/` 的现实惯例（README.md:7-14），草案见 `docs/feature-gap-analysis/plans/04-EG编辑工具与文档工作区方案.md` §4.5（OutputConvention），主控与子代理均须遵守。

1. **共享产出目录**（resolve_output_dir 返回值语义）：
   - 默认返回 `<workspace_root>/.agent-outputs/<YYYY-MM-DD>-<session_id>/`（本地时区、日期零填充）；用户显式指定 folder 时优先直接使用（不创建目录）；
   - 同会话重复调用返回同一路径（幂等，写入 session_meta `"{session_id}:output_dir"` 持久化）；目录**惰性创建**——首次写入时自动创建，解析本身不落盘；
   - 产出根必须在 workspace_root 内（path_within_root 校验），不污染源码目录（REQ-G03）；**只读子代理不允许自选输出目录**（忽略/拒绝 folder，仅按主 Agent 规划返回）。
2. **文件名分配**：主控在派发时于 prompt 中为每个子代理分配唯一产出文件名 `NN-<模块标题>.md`（NN 从 01 递增，00 留给汇总索引）；标题为简短模块名，禁止含路径分隔符。引擎强制面（I4-M3 写路径互斥）保证：不同文件并行写放行、同一文件并发写被拒绝（write_paths.rs:459-469、561-582）。
3. **汇总索引生成流程**（主控职责）：wait_subagents(await-all) 收齐全部终态（终态载荷携带 outputFiles：path/summary/bytes）→ 调用 list_dir 列出共享产出目录 → 调用 write_file(00-summary.md, overwrite=true) 生成汇总索引（清单表：文件名 / 标题 / 行数 / 摘要）；最小方案不新增专用汇总工具（list_outputs 类工具列为后续增强）。
4. **文档格式**：UTF-8 无 BOM、中文内容（REQ-G02 验收）。
5. **探索类子代理配额红线**（对齐 docs/multi-agent-repair/05-协同操作约束与安全.md:195-200）：探索类（调研/分析/勘察）子代理**最多写一份文档**，且**必须由主 Agent 分配写作任务**才允许写；未获分配不得主动写第二份文档（含补充文档、分析报告），探索结果默认以汇报/汇总物形式返回。该红线已由引擎强制面接线落地（explore_docs_quota 装配于主执行器 ToolContext），超限写入会被引擎拒绝，不再仅靠提示词纪律约束。
6. **输出目录清理约定**（会话删除）：删除会话 → 读取 session_meta 产出目录 → `.agent-outputs/<session_id>` 走 conex-fs trash 删除接管（trash.rs:26-29 铁律，不直接 remove）→ **通知用户**（清理结果 + 回收站位置）；完整链路由 T-EG-12 扩展落地。
7. **产出目录与 git 隔离**：产出根 `.agent-outputs/` 为运行期目录，已在 `.gitignore` 忽略（与 `.crish-trash` 等并列）；子代理产出文档一律不提交。若产出目录内存在历史已跟踪文件，需先执行 `git rm --cached -r .agent-outputs/` 从索引移除（保留工作区文件）并提交，此后新增产出不再入库；可用 `git check-ignore -v .agent-outputs/test` 验证命中。

**入库战役文档 vs 运行期产出（追加澄清）**：

- 引擎会话临时文档 → `.agent-outputs/`（不入库）。
- 方案 / 审计 / 分维等**应入库**产物 → `docs/<战役工作区>/`，结构见 `docs/agent-roles/README.md` §3：根目录放 `00-总方案`、分维方案、索引；`survey/` `analysis/` `independent-plans/` `plan-reviews/` `plan-improvements/` `audits/` `supplements/` `execution/` 等子目录**仅允许战役根下再嵌一层**。
- **禁止**把战役报告堆进 `docs/agent-roles/`（角色库只放职责与跨战役 findings）。

## 5. 输出风格与长度策略

- **长度自适应**：回复长度根据用户问题的复杂度、上下文需求与用户明确的期望决定，不强制精简。
  - 简单事实性问题（「这个文件在哪」）：给出直接答案即可，1–3 句。
  - 需要判断/评估/解释的问题（「效果如何」「哪个更好」「为什么」）：给出**清晰、结构化的完整说明**——结论先行，然后按维度展开，配代码/文件:行号证据，最后给建议。不要为了短而砍掉有信息量的部分。
  - 用户明确要求「详细/多说/展开」时，尽量给足内容。
- **结构优先**：长回答使用标题、列表、表格组织；结论/推荐放在显眼位置；证据（文件路径:行号、代码片段、命令输出）保持具体可复核。
- **诚实边界**：不确定的地方明确标注；不编造测试结果或代码行为。

## 6. 引用规则

- 引用代码位置统一用 `文件路径:行号`。
- 需要时引用：本文件（权威协作指令）、`.agents/LOGIC_PLAN_NO_RETREAT.md`（反退避）、`docs/agent-roles/`（角色库）、`docs/rust-rewrite/31-security-baseline.md`（安全基线）。
- 历史路径 `.agents/AGENTS.md` 现为入口指针，**有效细则以本文件为准**。

## 7. 严禁补丁、绕过与作弊（零容忍）

- **追求架构优雅，杜绝「打补丁」**：在修复边缘问题（如 UI 对齐、坐标偏移、事件映射等）时，严禁使用盲目猜测的遍历循环、基于坐标测距的魔术数字补偿、或临时性的兼容代码。必须穿透表象找到架构断层，用原生、精确、O(1) 复杂度的方式解决问题（例如通过原生注入 `data-*` 属性实现精确的 DOM 节点与源码 Token 的无损映射）。
- **绝对禁止绕过流水线门禁**：无论是格式化约束、类型检查还是单元测试，当 Git 钩子或 CI 环境报错拦截时，**任何 Agent 严禁使用 `--no-verify` 或类似指令强制跳过校验**。报错代表隐患，必须正面阅读错误日志并根除问题，直到正常跑通拦截门禁。
- **强制履行验证责任**：修复代码后，不得凭猜测认为「应该没问题了」。在提交前，必须运行全量类型检查（如 `npm run typecheck`）以及相关的自动化脚本（如 `npx playwright test` 或 `vitest`），并在必要时调用 DevTools / Fuzz 模糊测试验证是否有运行时报错。必须在确凿的日志与测试绿灯证据下，才能宣称问题解决。
- **禁止偷懒与避重就轻**：应对疑难杂症与边界情况时，不得选择忽略或简化问题。穷举式的测试与深层的根因分析是一等公民。

## 8. 反过度设计硬性红线

- 所有 Agent **必须**遵守仓库根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md` 中的反过度设计红线。
- **禁止回潮**（非穷尽）：内核级沙箱（macOS Seatbelt / Linux Seccomp）、SharedArrayBuffer 环形缓冲（`sab_ring_buffer`）、请求前自动换模（`DynamicModelRouter`）、预请求 DNS A/AAAA 解析器、滑动窗口式 `CircuitBreaker` 滥加、六段式工具中间件流水线、`IpcRouter` 嵌套序列化、以 95% `React.memo` 覆盖率作 CI 硬门槛等。
- **例外鼓励**：Web Worker 与 WorkerPool 本身**强烈鼓励**用于多窗口文本解析卸载。

---

# 二、本仓库项目专用（Conex / Crish）

## 9. 测试资产保护铁律（2026-08-07 事故后生效）

- `reference/markdown-editor/` 的全部源码与测试**必须入库**（.gitignore 已白名单放行；node_modules/dist 除外）——2026-08-07 曾因 `reference/*` 忽略导致用户测试资产近乎丢失，且 f772eb99 提交顺手删除了 28 个根目录测试（已从 `f772eb99^` 恢复）。**任何会话禁止删除/清理该目录下的测试文件**；如确需删除，先确认已入库并提交删除。
- `reference/markdown-editor` 的门禁：`npm test`（vitest run tests/unit，含 grapheme/undo/parser-redos/chunk）。改动引擎代码后必须跑通该门禁。
- 主仓库 tests/e2e 下的 5 个 markdown-editor 专项 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）是用户针对性测试，**禁止删除**，回归时保留。
- 测试是资产不是杂物：新增调试/测试脚本后应尽快 `git add` 并提交，不长期留在未跟踪状态（并行提交时用 `git commit --only` 限定路径，见 §3）。

## 10. 项目背景（供回答与调度时参考）

- **架构**：Rust 内核（`crates/`：session-loop/orchestrator/agent-provider/agent-tools/conex-*）+ Tauri 壳（`apps/agent-workbench/src-tauri/`）+ React 前端（`apps/crish-desktop/`）+ 共享 TS 包（`packages/`）。
- **文档**：`docs/` 是文档总目录；`docs/rust-rewrite/` 是架构重构的活跃文档（00 主方案 / 23 总纲 / 30 执行方案 / 33 事件 changelog / 34 收尾清单）；`docs/organization/` 是治理与评审产物；`docs/archive/` 为归档（legacy/campaigns/redesign/prototypes/provider-m4）；`docs/guides/` 与 `docs/opensource/` 为指南与开源文档；**角色库** `docs/agent-roles/`；块工作区实现波 `docs/block-workspace-architecture/`（含 `19` / `22` / `audit/**`）。
- **测试**：Rust `cargo test --workspace`（73 套件基线口径以当前仓库为准）；前端门禁 `npm run typecheck` + `npm run test:coverage -- --project=unit`（45/70/65/45，快层 ci.yml 强制执行）+ 中层两 job（`npm run test` vitest 全量 / `npx vitest run --config vitest.integration.config.ts` F3 四目录）——PS-02 落地后口径：快层全绿 + 中层两 job 修复（旧基线失败集 4 文件口径已清零，R3 实测 37/37 + 77/77 全绿；后续以 CI 现状为准）。
- **代码约定**：中文注释（UTF-8 无 BOM）；提交遵循仓库风格（feat/fix/test/docs/chore + 范围）；子 Agent 任务先读对应任务书（如 `docs/rust-rewrite/plans/PE-*.md`）与相关审查文档。

## 11. CI 治理与解耦断言（前端）

1. **按类型分级行数门禁**：UI 组件限约 500 行、业务逻辑限约 400 行、类型契约放宽至约 800 行，避免一刀切。存量超标文件登记于行数基线（`docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md`），豁免期间以基线为上限；基线清空后声明全量生效。
2. **注释与空行免惩罚**：仅计算有效代码行，过滤空行与文档注释，鼓励完善文档。
3. **渐进预警与分级阻断**：接近上限时 CI 警告提醒重构，严重超标（如 >650 行）硬性阻断。实现载体：`scripts/check-line-counts.mjs`（`npm run check:line-counts`，已接入 `check:desktop` 与 CI lint job）。
4. **状态爆炸与单一职责**：限制单文件多组件（`no-multi-comp`）与单组件 `useState` 数量（如 >12），拦截「包罗万象」上帝组件。
5. **分层硬性解耦与禁逆向依赖**：底层工具包不得反向引入上层业务包；前端禁止深路径直接调用引擎内部私有模块（一律经 IPC transport / commandMap / storeAccess 分层）。
6. **零循环依赖与快速扫描**：全局硬阻断循环依赖（`no-circular`），排除 `dist/` 与 `node_modules`。

**重大改动后强制验证套件**：须执行并维护 `FULL_CHECK_COMMANDS.md` 中的完整检查命令清单；重大重构/迭代轮次结束后不得跳过。

## 12. UI：Tooltip / 悬停提示

- **使用自定义 Tooltip**：始终使用项目自定义 `<Tooltip>` 组件（例如从 `@/components/settings/SettingsUI` 或等价路径导入），**不要**用原生 HTML `title` 作为主悬停提示。
- **避免浏览器默认气泡**：原生 `title` 观感不一致且陈旧；用 `<Tooltip content={...}>` 包裹可交互元素，以获得圆角胶囊、柔和阴影与主题色一致的提示。

## 13. UI：输入框与焦点态

- **默认不要重阴影**：输入框、搜索框、composer 等默认不要加厚重 `box-shadow`，保持干净、扁平、轻量。
- **克制的激活边框**：输入或按钮处于 active / focused / recording（如 `.shortcut-key-btn.recording`、`.input-container`）时，**禁止**粗、深、实心黑边（例如直接用 `var(--text-primary)` 或厚重 `0 0 0 1px` 黑环）。
- **可控对比度**：边框应只比组件背景略深/略灰，足以勾勒激活区（例如 `var(--border-color)` 与 `var(--text-primary)` 的 60/40 混合量级，以设计 token 为准），优先克制、保护长时间阅读。
- **焦点变化须可见但柔软**：激活态变化肉眼可辨，但须保持浅灰柔和（例如约 75/25 的 border/text 混合），不得到深黑。
  - **例外——全页空态落地布局**：全页 empty state composer 或同类落地输入（如 `data-empty-kind="session-empty"`），焦点边框对 `var(--text-primary)` 的混入应极低（至多约 5%，甚至接近 0）；光标位置与占位符变化已足以提示焦点；不要加生硬的 border-color 过渡动画。
- **焦点对比度上限约 10%**：任何情况下焦点/激活态不得使用硬实线；相对基线，灰色加深混入文本色不超过约 **10%**（例如 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)` 为上限量级）；常规元素优先约 **3%–6%** 混入以保持柔软。

## 14. 色彩空间与现代 CSS 语法

- **优先 HSLA / 斜杠透明度**：避免散落旧式 `rgba(r,g,b,a)`；UI 与 Design Token 优先 `hsl(h s l / a)` 或 `hsla(...)`，用斜杠 `/` 分隔不透明度（如 `hsl(210 20% 98% / 0.8)`）。
- **感知均匀渐变（OKLCH/LCH）**：丰富渐变动画可用 `oklch()` / `lch()`，并始终提供 sRGB/HSL 的 `@supports` 回退。
- **明暗微调（HWB）**：可用 `hwb()` 做白度/黑度微调与轻遮罩/阴影。
- **画布色彩适配**：Canvas 2D / WebGL 需要 RGBA 时，经入口级 Color Adaptor 做像素数组转换，避免组件层硬编码分叉。

## 15. 桌面调试：Chrome DevTools Protocol（CDP）

### 15.1 启动

在仓库根目录运行 `npm run dev:workbench`，启动完整 Tauri 桌面应用，包括：

- Rust 引擎（`crates/*`，与 Tauri 壳同进程）
- WebView2 中的 React 前端（Vite HMR）

### 15.2 CDP 调试端口

WebView2 进程（`msedgewebview2.exe`）自动带 `--remote-debugging-port=9222`。

**连接：**

```
http://127.0.0.1:9222/json/list       → 列出可用 target
ws://127.0.0.1:9222/devtools/page/... → 完整 CDP 会话
```

**CDP 可用能力：** 检查 DOM、读 console、执行 JS、截屏、监视网络（Tauri IPC / 引擎事件）、读应用状态（React / Zustand store 等）。

### 15.3 禁止用浏览器端 DevTools 冒充真应用验收

- **禁止**用浏览器插件、独立 Chrome 窗口、或仅打开前端 dev server 的方式做「真产品」UI 验收。
- 所有 UI 调试、状态检查、DOM 检查、截图 **必须**直接针对 Tauri WebView2 的 **9222**（`http://127.0.0.1:9222`）。
- **不要**打开 `http://localhost:5174` 独立浏览器当验收环境：无 Tauri 宿主能力（无文件对话框、无 shell、无引擎 IPC）；IPC 会静默失败；易出现「UI 渲染了但功能全挂」的假阴性，浪费调试时间。
- **只使用** `ws://127.0.0.1:9222` 端点做准确调试与截图。

### 15.4 禁止在 Mock / 沙箱种子环境中做 UI 验收

- 默认 `npm run dev:workbench` 初次加载或新开窗可能注入内存 mock 会话（如「测试会话 A/B/C」）。
- **禁止**在任何隔离 mock 沙箱状态或临时 seed 数据上测试、检查、截图或宣称功能通过。
- 准确视觉与诊断须基于真实窗口 store 门面（如 `window.__CRISH_SESSION_STORE__`、`window.__CRISH_LAYOUT_STORE__`、`window.__CRISH_TREE_STORE__`）或真实 LocalStorage 键（如 `crish_session_index_v1`、`crish-layout-tree-v1`）所反映的用户布局与会话历史。
- 新开窗或子 Agent 截图/宣称通过前，**必须**确认工作区/会话已用水合真实数据，而非回落 mock 会话。

### 15.5 其它本地服务端口

| 服务             | 端口 | 类型                    |
| ---------------- | ---- | ----------------------- |
| Vite dev server  | 5174 | HTTP（前端源）          |
| CDP（WebView2）  | 9222 | CDP（调试）             |
| Tauri MCP Socket | 4000 | TCP（可选开启，见下节） |

## 16. 桌面调试：Model Context Protocol（MCP，可选）

Tauri 应用可通过 `tauri-plugin-mcp` 在 `127.0.0.1:4000` 起 MCP 调试套接字。

- **默认关闭**（安全加固 PE-07 T07.5 / I-01）：仅当启动时设置 `CRISH_MCP_SOCKET=1` 才监听；**发布构建不得默认开启**。

```powershell
$env:CRISH_MCP_SOCKET = "1"   # 仅精确值 "1" 生效；其它取值一律关闭
npm run dev:workbench
```

- **鉴权 token（强制）**：插件启动时生成随机 token，写入 `%TEMP%\tauri-mcp-4000.token`；请求须携带 `authToken`（常量时间比较）。固定 token 可在启动前设 `TAURI_MCP_AUTH_TOKEN`。
- 套接字**仅绑定 loopback**（`127.0.0.1`）。

桥接示例（如 Cursor / 其它助手经 `tauri-plugin-mcp-server`）：

```json
"tauri-mcp": {
  "command": "npx",
  "args": ["-y", "tauri-plugin-mcp-server"],
  "env": {
    "TAURI_MCP_CONNECTION_TYPE": "tcp",
    "TAURI_MCP_TCP_PORT": "4000"
  }
}
```

- 使用 TCP 4000，而非 Windows 默认 Named Pipe。桥接每次连接会自动从 `%TEMP%\tauri-mcp-4000.token` 加载 token。
- **前提**：应用须以 `CRISH_MCP_SOCKET=1` 运行，否则 4000 未监听。

## 17. 实现波 / 审计波 / 方案波速查（本仓习惯 · 追加）

- **实现波调度**：`docs/block-workspace-architecture/19-实现波调度状态.md`、`22-续航锚点-压缩后必读.md`。
- **审计检查意图**：`docs/agent-roles/review/review.md`；跨战役稳定毒点追加：`docs/agent-roles/review/findings/`（只追加，不当事战役工作区）。
- **执行轮固定审计位**：`docs/agent-roles/general_task/execution-audit-slots.md`——每实现轮 ≥1 审计位；小问题可积 1–2 轮再写 `supplements/`，且须先读总方案+分维。
- **同轮计数**：`T = 审计 + 实现 + 补洞 + 美学 ∈ [6, 16]`；方案评审 + 评审后改进建议合计 ≤4。
- **收束轮**：多 Agent 写独立总案（`independent-plans/`）→ **主控**合并战役根 `00-总方案.md`。
- **阶段 prompt 模板**：`docs/agent-roles/prompts/`（正文即提示词；文件名即阶段）。
- 与 §1 反退避、§2 调度、§3 Git、§4 文档产出**同时生效**；冲突时以**更完整且日期更新**的用户裁决为准，并在本文件末尾追加说明，不删旧条。

## 18. 文档与角色库对照（追加）

| 用途               | 路径                                        |
| ------------------ | ------------------------------------------- |
| 协作总则（本文件） | `AGENTS.md`                                 |
| 入口指针           | `.agents/AGENTS.md`                         |
| 反退避全文         | `.agents/LOGIC_PLAN_NO_RETREAT.md`          |
| 角色库索引         | `docs/agent-roles/README.md`                |
| 审计维度清单       | `docs/agent-roles/review/review.md`         |
| 审计毒点沉淀       | `docs/agent-roles/review/findings/`         |
| 主控/子代理细则    | `docs/agent-roles/general_task/`            |
| 通用阶段提示词     | `docs/agent-roles/prompts/`                 |
| 安全基线           | `docs/rust-rewrite/31-security-baseline.md` |
| 反过度设计         | `ANTI_OVERENGINEERING_GUARDRAILS.md`        |
| 全量检查命令       | `FULL_CHECK_COMMANDS.md`                    |

---

## 附录 A · 维护与冲突处理（2026-08-12 梳理落盘）

1. **自本版起只允许追加**本文件条款；禁止删除既有有效纪律（重复字面合并除外）。
2. **双源合并说明**：原 `.agents/AGENTS.md` 中的英文 UI/CDP/MCP/CI/反过度设计细则已**中文并入**本文件 §8、§11–§16；`.agents/AGENTS.md` 改为指针，避免再维护两份全文。
3. **冲突取舍**：子 Agent 上限以 **16** 为准（取代旧文 12）；Git 以 **并行提交 + `commit --only` + 禁回撤** 为准（取代「仅主控收口提交」旧习惯若存在）；空返回以 **无限原样重派** 为准。
4. **未迁入本文件的长文**：`LOGIC_PLAN_NO_RETREAT.md`、`review.md` 各节检查项、战役审计报告——保持外链，不在此重复全文，以免双份漂移；需要时追加「指针行」即可。

_梳理完成：通用纪律 §1–§8；本仓专用 §9–§18；附录 A 维护纪律。_

---

## 附录 B · 2026-08-13 主调度订正（用户裁决 · 取代旧口径）

> 生效：2026-08-13。下列裁决**取代**正文及附录 A 中的旧口径（旧条保留仅作历史，不适用）。后续主调度 Agent 一律按本附录执行。

1. **Git 提交权（取代 §3「允许并行提交」）**：**只有主 Agent 可以提交 git**。子 Agent 完成任务后把改动留在工作区，由主 Agent 验证无问题后统一提交（`git commit --only <paths>` 限定路径）；子 Agent 一律不许提交、不许回撤、不许 `reset --hard` / `checkout .` / `restore`。子 Agent 提交前须自查（自测/门禁），避免把烂摊子留给主 Agent 收拾。
2. **每轮 Agent 数量（取代 16 / 12 旧上限）**：每轮 **5–12 个** Agent（同时存活 ≤16）。方案**最终收尾阶段可不保底**（收尾轮允许 <5，否则永远收不了尾）；收尾之前最好不低于 5。
3. **审计模式二选一（按用户需求定夺）**：
   - **参考外部模式**：用户给了对比方向（如「缓存怎么做」「IPC 序列化优化」）→ 可参考 `reference/` 及外部软件做对比分析；
   - **只针对自己模式**：用户未明确说明 / 明确是内部审计 → **只针对 `docs/agent-roles/review/review.md` 内容**审计，不参考外部软件；
   - **默认**：用户没有明确说明时，默认只分析内部（review.md）。
4. **空返回重派（取代「无限原样重派」细化 · 2026-08-13 增补接续模式）**：1–3 次空返回 → 优先用 `task_id` **接续**原 Agent 会话（先判最终状态：已实际落盘 → 核查收尾即可；Agent 复读无产出 → 重新派发而非继续接续）；4–6 次 → 可**拆分**或**换新 Agent 重新分发**，但**总任务量不变**；主 Agent 有权根据当前情况动态调整。
5. **维度详案语义澄清**：维度详案**不是**前面维度的简单展开/复制，而是将前面所有维度**按逻辑递进关系拆解**，变成逻辑递进且连贯的**计划方案**（用词可相应调整）。
6. **工作量均衡**：派单时保证每个子 Agent 工作量**均衡**——避免单个 Agent 任务太少或太长，合理分配粒度。
7. **review.md 改进建议（主 Agent 权利）**：主 Agent 有权在 review 相关文件（如 `docs/agent-roles/review/` 下新建的改进建议文档，署名主 Agent）追加改进建议；**只有 review.md 覆盖不到或描述不够精确时才追加**；整个任务过程可随时编辑/更改，但**不能动 review.md 源文件**。
8. **审计维度动态扩展**：审计任务中维度不限于初定几个；若审计过程中发现维度之外的**重要问题**，主 Agent 可**动态加派子 Agent** 分析。审计内容按需要合理分配给对应数量的子 Agent（维度数 ≠ Agent 数）。
9. **行数门禁评估（2026-08-13 定论）**：前端行数门禁阈值（UI ≤500 / 业务 ≤400 / 类型 ≤800 / 硬阻断 650 + per-file 基线冻结）**合理，不放宽**。已修复 `scripts/check-line-counts.mjs` 漏排 `.test.tsx`/`.spec.tsx` 的缺口（此前测试文件被误伤为 HARD BLOCK）。生产文件超限应走**拆分**（或 `--update` 登记基线），不以放宽阈值掩盖。

_2026-08-13 主调度订正 · 附录 B 取代附录 A §3 的旧口径（16 上限 / 并行提交 / 无限原样重派）_
