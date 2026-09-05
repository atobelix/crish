# Conex / Crish — Agent 协作指令

> **权威副本**：本文件（仓库根目录 `AGENTS.md` / `Agents.md` 同内容）。
> **`.agents/AGENTS.md`**：入口指针，细则以本文件为准（避免双源漂移）。
> **角色库与阶段提示词**：`docs/agent-roles/`（职责 / findings / general_task / prompts；**不是**战役运行期产出目录）。
> **反退避全文与自检清单**：`.agents/LOGIC_PLAN_NO_RETREAT.md`。
> **维护纪律（2026-08-21 修订，取代 2026-08-12「仅追加」口径）**：**默认对本文件只允许追加**（新裁决、新铁律、新速查），禁止删除既有条款；**仅当用户显式授权时**才可就地修订（消歧义、合并重复、按新裁决更新旧口径，如 2026-08-21 梳理即一次此类临时授权）。两条底线不变：① **有效纪律不得无声丢失**（删除/弱化任何一条须在附录 C 变更记录中留痕并说明理由）；② 条款编号保持稳定（外部引用以 §N 为锚，重排编号禁止）。

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
- **每轮派发数量（2026-08-13 用户裁决，取代旧 12/16 上限口径）**：每轮派发 **5–12 个**子 Agent；任意时刻同时存活（未终态）≤16、同父 ≤16、深度仅 1（引擎 DEFAULT_RECURSION_GUARD）。方案**最终收尾阶段可不保底**（收尾轮允许 <5，否则永远收不了尾），收尾之前最好不低于 5。任务类型包括：分析（只读+文档）、方案（只读+文档）、评审（只读+文档）、实现（写代码+测试）、提交（仅 git）。
- 派单前明确：输入文档、产出路径、验收标准、文件冲突注意事项（同文件串行）。
- 子 Agent 可读最终计划文档，但只执行分配给自己的任务；执行中发现任务书未覆盖的问题上报调度者裁决。
- **空返回处理纪律（2026-08-13 细化，取代「无限原样重派」；2026-08-21 并入正文）**：子 Agent 汇报为空返回（无最终消息/无产出）时，**默认是供应商网络问题而非任务失败**——先核查文件/代码是否已落盘（空返回时常已实际完成）并 `git status` 检查并行 Agent 是否已误伤/已提交。按空回累计次数分级处理：**1–3 次 → 优先用 `task_id` 接续原 Agent 会话**（先判最终状态：已实际落盘则核查收尾即可；Agent 复读机无产出 → 重新派发而非继续接续）；**4–6 次 → 可拆分或换新 Agent 重新分发**（单文档/单文件粒度成功率更高），但**总任务量不变**；主 Agent 有权根据当前情况动态调整。
- **子 Agent 优先与接管阈值（2026-08-11 用户裁决）**：优先派子 Agent 执行（主 Agent 每次分配子 Agent 更省事）；子 Agent 空回累计 **6 次以上**才由主 Agent 接管实现（与上一条 4–6 次的拆分/换新档位衔接）。
- **执行环境（2026-08-12 用户裁决）**：子 Agent 执行命令统一使用 **pwsh7（PowerShell 7+）**，避免 Windows PowerShell 5.1 的 GBK 默认编码与内联脚本插值问题；写文件 UTF-8 无 BOM。
- **定时器与命令等待纪律（2026-08-15 用户裁决）**：如果设置定时器，最短是 **100 秒**；如果命令过长，最好的方式是**等待命令完成后的系统推送通知（Reactive Wakeup）**，而不是一直轮询命令情况。
- **角色细则（追加）**：主控 / 子代理 / 执行期固定审计位 → `docs/agent-roles/general_task/`（`main-agent.md` / `sub-agent.md` / `execution-audit-slots.md`）。

## 3. 多 Agent Git 提交纪律（2026-08-13 用户裁决 · 2026-08-21 梳理并入正文）

仓库内常有多个 Agent + 自动化定时 git 专用 Agent 同时工作。以下纪律所有 Agent（主控与子 Agent）必须遵守：

1. **提交权仅归主 Agent（取代 2026-08-12「允许并行提交」）**：子 Agent 完成任务后把改动留在工作区，由主 Agent 验证无问题后统一提交（`git commit --only <paths>` 限定路径）；子 Agent 一律不许提交、不许回撤、不许 `reset --hard` / `checkout .` / `restore`。子 Agent 提交前须自查（自测/门禁），避免把烂摊子留给主 Agent 收拾。
2. **严禁回撤**：任何 Agent 不得 `reset --hard` / `checkout .` / `restore` 覆盖他人已提交或未提交的改动；不得 rebase 冲掉他人提交（rebase 仅由主控协调执行）。改错自己文件 → 用精确 edit 修复，不用全局回撤。
3. **共享 index 提交**：`git add` 写入仓库级共享 index（可能已含并行 Agent 的 staged 文件）——主控提交时用 **`git commit --only <paths...>` 限定本次收口文件路径**，避免误提交他人 staged/工作区文件；不要把他人文件 `git reset HEAD --` 出 index（仅索引操作也可能干扰并行 Agent）。
4. **被吞并处理（不回撤、不重做）**：若待收口改动已被其他 Agent / 定时 git Agent 提交（吞并），**只验证内容完整性**——`git show HEAD:<path>` 对比工作区/预期内容；**完整则不管归属，缺失则追加**（追加用 `git commit --only` 限定路径）。禁止因归属不纯而回退重做。
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
- 方案 / 审计 / 分维等**应入库**产物 → `docs/<战役工作区>/`。
- **禁止**把战役报告堆进 `docs/agent-roles/`（角色库只放职责与跨战役 findings）。

**战役工作区结构规范（2026-08-21 用户裁决）**：

1. **工作区命名**：每个战役在 `docs/` 下建独立工作区目录；名称由主控 Agent 根据当前项目内容与战役主题自行拟定（kebab-case 英文，如现有 `rust-rewrite` / `multi-agent-repair` 的风格），不与其他战役重名。
2. **根目录白名单**：工作区根目录**只存放三类文档**——① 纪律文档（实现波调度状态、续航锚点、索引等导航/纪律类）；② 方案实现总文档（`00-总方案` 类）；③ 方案分维度实现文档（分维详案）。其余任何内容不得散落在根目录。
3. **子文件夹仅一级**：其余内容（survey / analysis / independent-plans / plan-reviews / plan-improvements / audits / supplements / execution 等）一律建立子文件夹存放，**子文件夹只允许一级**（战役根 → 子文件夹 → 文件，禁止更深层嵌套）。
4. **归类充分原则**：能归类就归类——**禁止**建立只容纳两三个文档的碎片文件夹；同类内容合并进同一子文件夹，宁可文件多也不要文件夹碎。
5. 结构细则沿用 `docs/agent-roles/README.md` §3；与本规范冲突时以本规范为准。

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
- **强制履行验证责任**：修复代码后，不得凭猜测认为「应该没问题了」。必须在确凿的测试与现场证据下，才能宣称问题解决。
- **禁止偷懒与避重就轻**：应对疑难杂症与边界情况时，不得选择忽略或简化问题。穷举式的测试与深层的根因分析是一等公民。

### 7.1 立体验证纪律（禁止单一检查冒充验收）

任何任务在宣称交付或提交前，必须履行立体化验证，严禁流于表面形式：

- **编译与类型检查仅为底线**：静态检查通过仅代表语法无断裂，无法证明业务逻辑与状态机正确，严禁作为交付的唯一依据。
- **核心逻辑穷举验证**：算法与状态转移必须解耦为独立纯逻辑，通过自动化测试覆盖正逆向对称、极限边界与退化态。
- **规范与契约自动守门**：通过自动化门禁刚性拦截跨层通信漂移、设计规范回潮与过度设计。
- **真实环境现场验收**：必须在真实宿主与执行上下文中检验端到端物理表现，确保运行时零未捕获异常与非预期告警，禁止仅在脱水 Mock 中自欺欺人。
- **穿透根因与净收敛**：严禁延时盲猜、坐标测距补偿与临时兼容补丁；同一概念保持单一真理路径（SSOT），清退死代码与历史债务，实现架构净收敛。

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
- **文档**：`docs/` 是文档总目录；`docs/rust-rewrite/` 是架构重构的活跃文档（00 主方案 / 23 总纲 / 30 执行方案 / 33 事件 changelog / 34 收尾清单）；`docs/organization/` 是治理与评审产物；`docs/archive/` 为归档（legacy/campaigns/redesign/prototypes/provider-m4）；`docs/guides/` 与 `docs/opensource/` 为指南与开源文档；**角色库** `docs/agent-roles/`；各实现波战役工作区按 §4「战役工作区结构规范」组织。
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

## 15. 桌面调试通道总则（2026-08-21 用户裁决重写）

### 15.1 启动

在仓库根目录运行 `npm run dev:workbench`，启动完整 Tauri 桌面应用，包括：

- Rust 引擎（`crates/*`，与 Tauri 壳同进程）
- WebView2 中的 React 前端（Vite HMR）

### 15.2 调试通道唯一合法口径：Tauri MCP（4000）

- **唯一合法 UI 调试通道 = Tauri MCP Socket（`127.0.0.1:4000`）**，见 §16。
- **9222 / CDP 列为禁止项（2026-08-21 用户裁决）**：调试本软件时**禁止**通过 WebView2 的 `--remote-debugging-port=9222`（Chrome DevTools Protocol）做任何 UI 调试、DOM 检查、截图或状态读取；一律改走 4000 Tauri MCP。（历史背景：旧版曾以 9222 CDP 为指定调试口，且该端口易被本机 Chrome 进程抢占造成 404 假故障——2026-08-21 实际发生一次，遂裁决废弃。）
- 测试基建例外：`tests/e2e/webview/` 既有 CDP 辅助脚本作为**存量测试资产**保留，但新调试/验收流程不得新增 CDP 依赖。

### 15.3 禁止用浏览器端 DevTools 冒充真应用验收

- **禁止**用浏览器插件、独立 Chrome 窗口、或仅打开前端 dev server 的方式做「真产品」UI 验收。
- 所有 UI 调试、状态检查、DOM 检查、截图 **必须**经 **4000 Tauri MCP**（对真 Tauri 宿主内的 WebView 执行）完成。
- **不要**打开 `http://localhost:5174` 独立浏览器当验收环境：无 Tauri 宿主能力（无文件对话框、无 shell、无引擎 IPC）；IPC 会静默失败；易出现「UI 渲染了但功能全挂」的假阴性，浪费调试时间。

### 15.4 禁止在 Mock / 沙箱种子环境中做 UI 验收

- 默认 `npm run dev:workbench` 初次加载或新开窗可能注入内存 mock 会话（如「测试会话 A/B/C」）。
- **禁止**在任何隔离 mock 沙箱状态或临时 seed 数据上测试、检查、截图或宣称功能通过。
- 准确视觉与诊断须基于真实窗口 store 门面（如 `window.__CRISH_SESSION_STORE__`、`window.__CRISH_LAYOUT_STORE__`、`window.__CRISH_TREE_STORE__`）或真实 LocalStorage 键（如 `crish_session_index_v1`、`crish-layout-tree-v1`）所反映的用户布局与会话历史。
- 新开窗或子 Agent 截图/宣称通过前，**必须**确认工作区/会话已用水合真实数据，而非回落 mock 会话。

### 15.5 本地服务端口速查

| 服务             | 端口 | 类型 | 状态 |
| ---------------- | ---- | ---- | ---- |
| Vite dev server  | 5174 | HTTP（前端源） | 仅构建服务，**不得作验收环境** |
| ~~CDP（WebView2）~~ | ~~9222~~ | CDP | **禁止项**（2026-08-21 裁决，勿再连接） |
| Tauri MCP Socket | 4000 | TCP | **默认开启**（debug 构建），唯一合法调试通道 |

## 16. 桌面调试：Model Context Protocol（MCP，唯一合法调试通道）

Tauri 应用经 `tauri-plugin-mcp` 在 `127.0.0.1:4000` 起 MCP 调试套接字。

- **默认开启（2026-08-21 用户裁决，取代 PE-07 T07.5 / I-01「默认关闭」旧口径）**：debug 构建启动即监听，无需再设 `CRISH_MCP_SOCKET=1`；如需临时关闭，设 `CRISH_MCP_SOCKET=0`（仅精确值 `"0"` 生效，其它取值一律开启）。**发布构建维持双保险兜底不变**（注册点 `#[cfg(debug_assertions)]` 隔离 + 插件自身 `allow_release_builds=false` 拒绝），发布产物不暴露 4000。

```powershell
npm run dev:workbench          # debug 构建：4000 默认监听
$env:CRISH_MCP_SOCKET = "0"    # 如需临时关闭（仅精确值 "0" 生效）
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
- **前提**：应用以 debug 构建运行（release 构建插件拒绝注册，4000 不监听——这是预期安全行为，不是故障）。

## 17. 实现波 / 审计波 / 方案波速查（本仓习惯 · 追加）

- **实现波调度**：实现波工作区（`docs/` 下由主控按战役内容拟名的独立目录，结构规范见 §4「战役工作区结构规范」）。
- **审计检查意图**：`docs/agent-roles/review/review.md`；跨战役稳定毒点追加：`docs/agent-roles/review/findings/`（只追加，不当事战役工作区）。
- **执行轮固定审计位**：`docs/agent-roles/general_task/execution-audit-slots.md`——每实现轮 ≥1 审计位；小问题可积 1–2 轮再写 `supplements/`，且须先读总方案+分维。
- **同轮计数**：`T = 审计 + 实现 + 补洞 ∈ [5, 12]`（收尾轮可不保底，见 §2）；方案评审 + 评审后改进建议合计 ≤4。
- **收束轮**：多 Agent 写独立总案（`independent-plans/`）→ **主控**合并战役根 `00-总方案.md`。
- **阶段 prompt 模板**：`docs/agent-roles/prompts/`（正文即提示词；文件名即阶段）。
- 与 §1 反退避、§2 调度、§3 Git、§4 文档产出**同时生效**；冲突时以**更完整且日期更新**的用户裁决为准——默认以「文末追加 + 注明取代旧口径」方式落盘；仅当用户显式授权调整时才就地修订对应条款（并在附录 C 留痕）。

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

## 附录 A · 维护与冲突处理（2026-08-12 梳理落盘 · 2026-08-21 修订）

1. **维护模式（2026-08-21 修订）**：**默认只允许追加**；仅当用户显式授权时才可就地修订（消歧义/合并重复/按新裁决更新旧口径）。底线：① 有效纪律不得无声丢失（删除/弱化须在附录 C 留痕并说明理由）；② 条款编号保持稳定。
2. **双源合并说明**：原 `.agents/AGENTS.md` 中的英文 UI/CDP/MCP/CI/反过度设计细则已**中文并入**本文件 §8、§11–§16；`.agents/AGENTS.md` 改为指针，避免再维护两份全文。
3. **冲突取舍（现行口径）**：每轮派发 **5–12 个**（同时存活 ≤16）为准（取代旧 12 / 16 上限）；Git 以 **仅主控提交 + `commit --only` + 禁回撤** 为准（取代「并行提交」）；空返回以 **接续模式分级处理** 为准（取代「无限原样重派」）；调试通道以 **4000 Tauri MCP 唯一合法** 为准（9222/CDP 禁止）。详见正文 §2/§3/§15/§16 与附录 B/C。
4. **未迁入本文件的长文**：`LOGIC_PLAN_NO_RETREAT.md`、`review.md` 各节检查项、战役审计报告——保持外链，不在此重复全文，以免双份漂移；需要时追加「指针行」即可。

_梳理完成：通用纪律 §1–§8；本仓专用 §9–§18；附录 A 维护纪律（2026-08-21 修订）。_

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

_2026-08-13 主调度订正 · 附录 B 取代附录 A §3 的旧口径（16 上限 / 并行提交 / 无限原样重派）。2026-08-21 梳理时上述口径已并入正文 §2/§3/§17 及附录 A #3，本附录保留作为裁决原始记录。_

---

## 附录 C · 变更记录（2026-08-21 起）

> 本附录记录对既有条款的删除/弱化/重大口径翻转，落实「有效纪律不得无声丢失」底线。新增裁决若与旧口径冲突，同样在此留痕。

### 2026-08-21 · 调试通道与维护模式裁决（用户）

1. **9222 / CDP 列为调试禁止项（翻转 §15 旧口径）**：调试本软件禁止经 WebView2 `--remote-debugging-port=9222` 做 UI 调试/DOM 检查/截图/状态读取；唯一合法 UI 调试通道 = **4000 Tauri MCP**。被取代内容：原 §15.2 的 9222 连接端点指引（`/json/list`、`ws://` 会话）与原 §15.3「必须针对 9222」句——删除理由：通道本身被裁决废弃，且该端口易被本机 Chrome 抢占造成 404 假故障（当日实际发生）。§15.4 mock 禁令、§15.3 浏览器冒充禁令**保留有效**，仅通道指向改为 Tauri MCP。测试基建例外：`tests/e2e/webview/` 存量 CDP 脚本保留。
2. **Tauri MCP 改为 debug 构建默认开启（翻转 §16 旧口径）**：取代 PE-07 T07.5 / I-01「默认关闭、仅 `CRISH_MCP_SOCKET=1` 开启」；新口径：debug 启动即监听 4000，`CRISH_MCP_SOCKET=0`（精确值）显式关闭；发布构建双保险兜底不变。代码接线状态：**文档先行，Rust 侧改造待落地**（`dev_mcp.rs` / `main.rs` 注释与内联测试随接口改造同步）。
3. **维护模式变更（翻转附录 A #1 与文首引言）**：解除 2026-08-12「只允许追加」限制，允许直接修订（消歧义/合并重复/就地更新旧口径）；底线为「有效纪律不得无声丢失（附录 C 留痕）」+「条款编号稳定」。**授权性质：一次性临时授权**——仅覆盖 2026-08-21 本次梳理；此后默认回归「只允许追加」，后续就地修订须逐次取得用户显式授权。
4. **本次梳理就地修订清单**（无纪律丢失，均为口径统一或消歧义）：§2（每轮数量并入附录 B 口径；空返回接续模式并入正文）；§3（整节按附录 B #1 重写，「允许并行提交」废止）；§7（「调用 DevTools」→「经运行时调试通道（Tauri MCP）」，消除与 9222 禁令的歧义）；§15（整节重写，见本附录第 1 条）；§16（默认开启，见第 2 条）；§17（同轮计数 [6,16] → [5,12] 对齐附录 B；冲突处理改为「就地修订 + 附录 C 留痕」）；附录 A（#1 维护模式、#3 冲突取舍更新）；`.agents/AGENTS.md` 入口指针同步更新维护模式表述。
5. **战役工作区结构规范（用户裁决，2026-08-21 二次补充）**：§17「实现波调度」条目去掉具体战役目录名（原指向 `docs/block-workspace-architecture/`，含其下两个具体文件名一并移除），改为通用工作区约定；§4 新增「战役工作区结构规范」五条（主控拟名 / 根目录三类白名单 / 子文件夹仅一级 / 归类充分禁碎片文件夹 / README §3 降为细则引用）；§10 项目背景同步去除该目录的过细内容标注。被移除的旧指针内容（`19-实现波调度状态.md`、`22-续航锚点-压缩后必读.md`、`block-workspace-architecture` 目录名）属「过细路径示例」而非纪律本体，实际文档仍在原位未动。

---

## 19. UI：输入框四态体系与全生命周期防倒退铁律（2026-09-05 用户裁决）

全系统输入框严格且仅允许四种合法形态（SSOT），永久固定，禁止出现第五种或样式倒退：

1. **形态 ①【侧边栏导航搜索框（纯透明无边框型）】**（图 1 标号 ①）：
   - 适用：主侧栏会话搜索（`SidebarNav`）、设置侧栏分类搜索（`SettingsSidebar`）等功能栏；
   - 视觉规则：常态无底色、无边框、无阴影（`background: transparent; border: none; box-shadow: none;`），直接平铺在侧栏；悬停/激活仅外层容器柔和泛起 `var(--sidebar-hover)`，内部 input 绝无边框阴影。主侧栏与设置侧栏 100% 共享。
2. **形态 ②【主对话底栏胶囊型（ChatComposer）】**（图 1 标号 ②）：
   - 适用：主对话区消息发送底栏（`ChatComposer` / `TiptapEditorField`）；
   - 视觉规则：大胶囊微圆角、自适应高度、工具集成。
3. **形态 ③【标准卡片表单原子型（Standard Input）】**（图 2 标号 ③）：
   - 适用：模型管理（Base URL、API Key）、价格配置表、常规表单配置项等；
   - 视觉规则：必须强制使用原子 `<Input>` 组件（来自 `@/components/ui`）。四档标准尺寸（xs/sm/md/lg），微浅底色（`color-mix(in srgb, var(--bg-primary) 40%, var(--bg-card))`），细边框（`var(--border-subtle)`），聚焦态严格控制在 3%~10% 克制软灰，绝无重阴影与粗黑边框。
4. **形态 ④【内联浮层/下拉菜单搜索框（纯光标极简型）】**（图 3 标号 ④）：
   - 适用：下拉菜单、模型选择器（`ModelBadgePickerMenu`）、字体选择（`FontSelectField`）、展开面板等浮层内部的搜索输入框；
   - 视觉规则：**全态只有光标闪烁，其他什么变化也没有**！强制 `border: none !important; outline: none !important; box-shadow: none !important; background: transparent !important;`。浮层内绝不产生任何边框、高亮或阴影。
5. **刚性防倒退门禁守护**：
   - 运行 `node scripts/check-input-guardrails.mjs`（`npm run check:input-guard`，已并入 `check:desktop`）；
   - 守护单测 `src/components/ui/Input/input-three-patterns-guard.test.ts`；
   - 任何 Agent 修改代码，若违背上述四态规范或引起全局焦点穿透黑框，CI / 本地门禁一律刚性阻断。

## 20. UI：邻近圆角一致性与去极端化铁律（2026-09-05 用户裁决）

1. **邻近一致原则（Contextual Proximity）**：控件圆角没有一刀切绝对死值，**核心在于必须与相邻/同层容器元素的圆角保持视觉一致**：
   - 侧边栏搜索框与相邻侧栏条目统一保持 `var(--radius-lg, 8px)`；
   - 工具栏与卡片内嵌套操作按钮统一保持 8px 或 6px（`--button-radius`）；
   - 小尺寸内嵌控件与相邻小元素统一保持 4px（`--radius-sm`）；
2. **严禁离谱极端圆角（No Bizarre Corners）**：
   - 禁止在普通输入框、卡片、工具栏按钮随意声明 9999px 药丸胶囊（除系统级浮动 Badge、全局主底栏或特定开关外）；
   - 严禁出现生硬刺眼的 0px/1px 方角；
   - 严禁出现 17px、23px 等脱离 Design Tokens 阶梯的奇葩自由数字。遵循系统标尺（4px / 6px / 8px / 12px / 16px）。
