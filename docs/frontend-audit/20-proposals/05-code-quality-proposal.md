# 05 代码质量与规范修复方案

> 依据：`docs/frontend-audit/10-analysis/05-code-quality-audit.md`（主审计）+ `docs/frontend-audit/00-cross-analysis.md`（主控交叉结论 P1-7/P1-8）。
> 性质：方案设计（只读 + 本文档产出），无代码改动。范围：**纯代码质量与门禁治理**；功能性问题（快照桥/断链命令/样式退化等）归 03/04/01/02 方案，本文档只处理重复逻辑、规范与门禁体系。
> 日期：2026-08-09。

## 0. 问题全景（审计结论收口）

| # | 病灶 | 实测 | 门禁对照 | 处置去向 |
|---|---|---|---|---|
| 1 | 静默失败面 | 306 空 catch（289 无绑定 + 17 有绑定，覆盖 ~110 个生产文件）+ 33 处 `.catch(() => {})` + 10 处 `.catch((e) => {})` | `check-swallowed-errors.mjs` 仅覆盖 Rust `crates/`（scripts/check-swallowed-errors.mjs:41-49），**前端无等价门禁** | 步骤 1 + 3 |
| 2 | 行数门禁形同虚设 | `check-line-counts.mjs --all` 实测 44 违规 + 19 警告（665 文件），18 文件 >650 行 | 脚本未接入 package.json 与 CI；脚本自身只有 pass/fail 两态（check-line-counts.mjs:130-155），与 .agents/AGENTS.md 声明的"85% 预警 / >650 硬阻断"三级语义不符 | 步骤 2 |
| 3 | 上帝函数 | 18 个 >100 行函数（前五占四为 settings-* 系 hook，最长 useSkillsSettingsState 459 行） | 无函数级门禁 | 步骤 4 |
| 4 | 超长文件 | 42 个 >500 行、18 个 >650 行（pricingStore.ts 1571 行最大） | 无（步骤 2 建立后约束） | 步骤 4（协同） |
| 5 | C0 剥离逻辑重复 | 11 个文件内联重复且已漂移：`\p{Cf}`+ZWJ 修复只落到 sessionSearch/sessionTitle 2 处，其余仍是 `[\u0000-\u001f\u007f]` 旧形态 | 11 行 `eslint-disable-next-line no-control-regex` 各自为政 | 步骤 5a |
| 6 | Tooltip 双版本 | `components/Tooltip`（135 行，仅 1 处 import）vs `components/ui/Tooltip`（267 行）并存 | 两文件均在 react-refresh 豁免清单 | 步骤 5b |
| 7 | 纸面门禁 | RL-04（no-multi-comp + useState≤12）在 .agents/AGENTS.md 声明、全仓无实现 | 无实现无扫描 | 步骤 6a |
| 8 | 其他质量残项 | console.log 生产 2 处无 dev 守卫、chat-composer any 豁免区无边界说明、P3 散项 | 部分可转 eslint 规则 | 步骤 6b/6c/6d |

---

## 1. 目标态：门禁体系（一图总览）

```
┌──────────────────────────── 目标态门禁矩阵 ────────────────────────────┐
│ 门禁                    实现载体              接入点             状态   │
│ TS 吞错门禁（no-silent-catch）  eslint 本地规则   CI lint job + lint:all  │
│ 行数门禁（三级语义）          check-line-counts.mjs   check:line-counts    │
│                                           + CI lint job                  │
│ 函数/文件复杂度               行数基线文件（存量）→ 清零后行数门禁全量生效 │
│ 重复逻辑唯一真源              strip 工具下沉 utils/ + 行为测试              │
│ RL-04 状态爆炸                eslint 本地规则（实现）或显式退役声明          │
│ any 豁免边界                  disable 注释边界声明 + 扫描自证                │
│ console 残留                 eslint no-console（allow warn/error）          │
├──────────────────────────── 基线/白名单机制 ────────────────────────────┤
│ 所有"存量超标"类门禁遵循同一模式：                                       │
│   先 --update 登记现状为基线 → 门禁以基线为上限（ratchet）→               │
│   每轮清理后 --update 降基线 → 存量清零后基线条目移除 → 声明全量生效        │
│ 单个"合理静默"catch 用注释 marker（swallow-ok）豁免，新文件零容忍           │
└──────────────────────────────────────────────────────────────────────┘
```

- **唯一真源**：strip 逻辑（C0/不可见字符/ANSI）→ `utils/` 共享工具；Tooltip → 单一组件版本；门禁声明 → `.agents/AGENTS.md` 与实现一一对应，消除"纸面门禁"。
- **静默失败可观测**：所有空 catch 要么 `logInternalError` 出日志、要么 `swallow-ok` 注释显式声明意图；新增静默被门禁拦截。
- **CI 全程执行**：吞错规则随 eslint 零新增 job 生效；行数门禁秒级接入 lint job；本地 `npm run check:desktop` 与 CI 同口径。

---

## 2. 分步方案（仅逻辑顺序，每步输出为下一步输入）

### 步骤 1：吞错基线建立（先建门禁，再清零）

**任务**：
1. 实现 eslint 本地规则 `no-silent-catch`（AST 级，规则设计详见 §3），随 `npx eslint .` / `npm run lint:all` 自动生效，**不新增 CI job**。
2. 实现 `scripts/check-swallowed-errors-frontend.mjs`（`--update` / `--report` 两模式，镜像 Rust 侧脚本语义）。
3. `--update` 首次运行：扫描全仓，把**每个文件当前未注解空 catch 数**写入基线标记区（新文件 = 无条目 = 零容忍）。
4. **规则形态校准**：以审计数字为参照（306 空 catch / 33 `.catch(() => {})`），`--report` 输出与审计口径对齐核对；差异（如严格模式 `rg` 实测生产 `.catch(() => {})` 为 10 处，审计 33 含更宽形态/测试目录）在基线文件头部注明口径说明，差异即基线的一部分，后续收紧以规则自身口径为准。

**涉及文件面**：
- 新增：`scripts/check-swallowed-errors-frontend.mjs`、`docs/multi-agent-repair/基线记录/frontend-swallowed-errors-baseline.md`（marker 区，同 Rust 基线风格）
- 修改：`eslint.config.js`（本地规则定义，仿 deprecatedRequiresReference 的现有本地规则先例，eslint.config.js:7-38）

**验证方式**：
- `npm run lint:all`（`--max-warnings 0`）全绿——基线内存量不报错。
- 负向用例：新建临时文件含 1 个空 catch（无基线条目）→ lint 必 fail；删除后恢复。
- 正向用例：基线内文件加 1 个新空 catch → fail（ratchet 生效）；注释化 1 个 → pass（计数下降）。
- `node scripts/check-swallowed-errors-frontend.mjs --report` 输出与审计 306/33 数量级一致。

**完成判据**：基线文件入库（git diff 可复核标记区）；门禁负向用例通过；CI lint job 在下一轮提交自动覆盖此规则。

**产出 → 步骤 3 输入**：基线文件即治理清单（按文件排序的未注解空 catch 计数，高发文件一目了然）。

---

### 步骤 2：行数门禁接线（先登记，再清零）

**任务**：
1. 重构 `scripts/check-line-counts.mjs`，实现 .agents/AGENTS.md 声明的**三级语义**：
   - ≥85% 上限 → 警告（仅报告）；
   - ≥100% 上限 → 违规（fail）；
   - **>650 行（任意类别）→ 硬阻断**（对类型契约类 800 行上限的补充）；
   - 叠加 **per-file 基线机制**：有基线条目的文件以"基线值"为上限（存量冻结、增长必 fail、下降放行）；无条目的文件按声明上限严格执行。
2. `--update` 生成基线：当前 44 违规 + 19 警告文件全部登记（含实测行数），基线态 `--all` 退出 0。
3. 接入：package.json 新增 `check:line-counts`（`node scripts/check-line-counts.mjs --all`），并入 `check:desktop`；`.github/workflows/ci.yml` lint job 追加 `npm run check:line-counts`（秒级，不影响 15min 预算）。
4. `.agents/AGENTS.md` 规则 1/3 补充一句声明："存量超标文件登记于行数基线（docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md），豁免期间以基线为上限；基线清空后声明全量生效"——声明与实现永久同步。

**涉及文件面**：
- 修改：`scripts/check-line-counts.mjs`、`package.json`（root）、`.github/workflows/ci.yml`、`.agents/AGENTS.md`
- 新增：`docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md`

**验证方式**：
- 基线态：`node scripts/check-line-counts.mjs --all` 退出 0，输出 44 违规 + 19 警告为"基线登记"而非失败。
- 负向用例：基线内文件手动 +1 行 → exit 1；新违规文件（>650 或超类别上限且无条目）→ exit 1。
- `npm run check:desktop` 与 CI lint job 均含此步。

**完成判据**：44/19 全部登记入库；ratchet 与硬阻断负向用例通过；CI 接线落地。

**产出 → 步骤 4 输入**：>650 文件清单即"拆分优先队列"（pricingStore/sessionRustDb/useStreamCallbacks/modelCatalog 等 18 个）。

---

### 步骤 3：空 catch 分级治理（按基线分批清零）

**任务**（每批 = 基线中 10~15 个文件，重复执行直至清零）：
1. **分级判定**（逐文件人工确认语义，禁止机械替换）：
   - **真静默**（无注释、无日志、无意图证据）→ 补 `logInternalError('<scope>', e)`（api/userFacingErrors.ts:244 已有现成函数，scope 用 `api/sessionRustDb` 风格）；若属"不应发生的错误"，用 `errorStore.classifyError`（services/ErrorStore.ts:263）走分级/去重后再上报。
   - **合理静默**（localStorage 尽力写、JSON.parse 兜底、Worker 失败降级、日志后端自保护等半正当形态）→ 统一升级为 `/* swallow-ok: <中文原因> */` 注释 marker（把"无意义的旧注释"（如孤零 `// ignore`）一并升级）。
   - **可消除**（catch 包住整段本可前置判断的逻辑）→ 收紧作用域或删除 catch。
2. 每批完成后 `--update` 刷新基线（计数下降 → 门禁收紧到新水平）。
3. **优先序**：基线计数最高的前 10 文件先行（TerminalCard.xterm.tsx 15、sessionRustDb.ts 13、sessionLocalStorage.ts 9、useStreamCallbacks.ts 9、profileStore.ts 8 等——审计 §2.1 高发榜），再加 33 处 `.catch(() => {})`（bootstrap-full.ts:8、bootstrap-services.ts:81/116、useChatApprovalHandlers.ts 4 处等）与 10 处 `.catch((e) => {})`。

**涉及文件面**：~110 个生产文件（分批清单以步骤 1 基线文件为准）。

**验证方式**：
- 每批：`npm run lint:all` 绿 + 该批文件相关单测（store/hook 域）全绿 + `--report` 计数较上批下降。
- 行为回归：涉及存储/持久化文件（sessionRustDb/sessionLocalStorage/beforeunloadFlush）重点跑对应单测，确认日志补点未改变控制流。
- 抽查：DevTools 触发一次真实失败路径，确认 `[crish-desktop][scope]` 日志可见。

**完成判据**：未注解空 catch = 0；门禁切换 marker-required 严格模式（§3 阶段 B）后仍全绿——"每个空 catch 都有出处"。

**产出 → 步骤 6 输入**：无（此处为质量闭环终点之一），但治理中发现的"本可消除"catch 清单可转 04/03 方案登记。

---

### 步骤 4：超长函数拆分（18 个 >100 行函数 + 超长文件协同）

**任务**：
1. 按"职责拆分、公开面稳定"原则拆函数，以 settings-* 上帝 hook 为第一优先（前五占四）：
   - `useSkillsSettingsState.ts:224-683`（459 行）、`useExtensionMarket.tsx:188-624`（436 行）、`useModelProfilesState.ts:188-546`（358 行）、`useMcpSettings.ts:97-365`（268 行）→ 拆"列表加载 / 变更提交 / 弹窗编排"三个子 hook（组合而非继承，公共返回类型面不变）。
   - `useChatComposerProps.ts:126-519`（393 行）→ 按会话卡片能力域拆 handlers 组。
   - 其余 13 个 >100 行函数按同类模式处理（hooks/useAgentStream.ts:125-454 329 行等）。
2. 拆分与步骤 2 的行数基线协同：每个拆分落地的文件，`--all` 实测行数下降 → 从行数基线移除条目或降值（基线清空进度 = 治理进度）。
3. 与 02 方案的 P1-13（巨型组件拆分）**文件面错开**：本步骤只拆"函数逻辑"，不碰 02 负责的"组件结构"；重叠文件（ModelConfigEditor.tsx 等）由调度者按文件串行分配。

**涉及文件面**：18 个函数所在文件（settings-skills/settings-extensions/settings-models/settings-mcp/chat-card/workspace/hooks 等，清单见审计 §5.1 表）。

**验证方式**：`npm run typecheck` 全绿（公开返回面稳定性的强锚）；相关 hook/store 单测全绿；`node scripts/check-line-counts.mjs --all` 确认对应文件行数下降；`git diff` 人工评审确认无行为变更。

**完成判据**：>100 行函数清零（或残余登记并注明拆分障碍）；被拆文件的行数基线条目下降 ≥1 个/轮。

**产出 → 步骤 5/2 输入**：行数基线条目下降清单（供 `--update` 收紧）；拆分后暴露的重复逻辑块（如多处相同的状态派生）转入步骤 5 收敛。

---

### 步骤 5：重复逻辑收敛（strip 工具下沉 + Tooltip 唯一版本）

#### 5a C0/不可见字符/ANSI 剥离逻辑唯一真源

**任务**：
1. 新增 `apps/crish-desktop/src/utils/stripText.ts`（utils/ 已有 parseAnsi.ts/redact.ts 等小型工具，目录惯例成熟），导出三个语义明确的函数：
   - `stripC0Controls(s)`：`[\u0000-\u001f\u007f]` 剥离（applyFileDiff.ts:54、markdownSanitizer.ts:12-13、FontSettingsSection.tsx:32-33、sessionExport.ts:140-146、previewBrowserStore.ts:59-60、firstRunWizardLib.ts:91-92 迁移）；
   - `stripInvisibleAndFormatting(s)`：**升级版**（`(?![\u200D])[\p{Cf}...` + no-misleading-character-class，ZWJ 保护）——以 sessionSearch.ts:64 / sessionTitle.ts:120-125 的已修复形态为基准形态，**迁移旧形态站点等于顺带修复漂移**；
   - `hasControlChars(s)` / `stripAnsiEscape(s)`：供谓词型站点（resolveSlashCommand.ts:115 按 ASCII 校验、firstRunWizardLib.ts:91-92 校验 C0 存在性）与 ANSI 站点（parseAnsi.ts:54、toolFeedback.ts:379，新发现见 §5）使用。
2. 逐个迁移 11+1 个调用点，**不统一吞并语义**（校验 ≠ 剥离，ANSI ≠ C0——这是此前漂移的教训），每点迁移即删除对应的 `eslint-disable-next-line no-control-regex` 行。
3. 为 strip 工具补行为测试：ZWJ 保护回归（`\u200D` 保留）、组合类字符、边界（空串/纯控制串）、谓词语义。

**涉及文件面**：新增 `utils/stripText.ts` + 测试；修改 12 个调用点文件（applyFileDiff/markdownSanitizer/resolveSlashCommand/FontSettingsSection/sessionSearch/sessionTitle/sessionExport/previewBrowserStore/toolFeedback/firstRunWizardLib/parseAnsi）。

**验证方式**：strip 单测全绿；迁移点既有测试全绿（sessionSearch/sessionTitle 有专属行为断言）；`rg "no-control-regex" apps/crish-desktop/src` 归零（除 utils 内集中豁免 1 行）；全量 typecheck/lint 绿。

**完成判据**：no-control-regex 豁免仅存于唯一真源 1 处；11 个文件不再内联重复。

#### 5b Tooltip 双版本收敛

**任务**：
1. **依赖 02 方案 P0-5 完成**（88 处消费迁移到 ui/Tooltip）——本步骤不重复 02 的迁移工作。
2. 02 迁移完成后：删除 `components/Tooltip/`（135 行旧版），消费方归零后以 `knip`（root package.json:56 已有）验证无残留引用；两文件 react-refresh 豁免清单条目（eslint.config.js:174/190）同步删除。
3. 若 02 方案延期：本步骤先登记 `components/Tooltip` 为"仅 1 消费方死代码候选"，禁止新消费方再 import 旧版（用 `check-ui-layer.mjs` 或 knip 配置拦截），防止分裂扩大。

**涉及文件面**：`components/Tooltip/Tooltip.tsx`、`eslint.config.js`、唯一消费方文件。

**验证方式**：删除后 `npx knip` 与 `npm run typecheck` 绿（无悬空 import）；`rg "components/Tooltip" apps/crish-desktop/src` 零命中；lint 绿（豁免清单条目删除后无 react-refresh 报错）。

**完成判据**：Tooltip 唯一版本存在（ui/Tooltip），旧版目录已删，豁免清单无残留。

---

### 步骤 6：纸面门禁清零与规范收尾

#### 6a RL-04（no-multi-comp / useState≤12）——实现或显式退役

**任务**（二选一，建议实现）：
- **实现路径**：eslint 本地规则 `no-multi-comp`（统计单文件 React 组件声明数，允许 barrel/类型文件白名单 + 逐处 disable-with-reason）+ `use-state-cap`（按组件统计 useState 调用数 >12 报错）；先 `--report` 摸底现有命中，超限存量登记基线（复用步骤 1 的基线模式）或先 warning 后 error。
- **退役路径**：从 `.agents/AGENTS.md` 规则 4 删除该声明，并在本文档 §6d 决策记录登记"为何不实现"（若实测命中面极小、收益低）。

**验证方式**：实现路径——负向用例（含 2 个组件的临时文件必报）；退役路径——文档 diff 复核声明与实现无残留脱节。

**完成判据**：.agents/AGENTS.md 每条规则有实现或显式退役记录，无第三态。

#### 6b console 残留清零

**任务**：`performanceEngine.ts:68`、`migrateFromLocalStorage.ts:169` 两处无守卫 console.log 改 `import.meta.env.DEV` 守卫或改走 LoggerService；eslint 加 `no-console: ['error', { allow: ['warn', 'error'] }]`（LoggerService.ts:135 用 warn 属正当后端；bootstrap-* 性能 debug 标记按需加 DEV 守卫）。

**验证方式**：lint 绿；`rg "console\.(log|debug)" apps/crish-desktop/src` 仅剩有守卫/后端正当点；生产构建产物 grep 无 console.log 字样。

**完成判据**：无守卫 console.log/debug 归零。

#### 6c chat-composer any 豁免区边界成文

**任务**：4 个文件（composerTypes.ts:1、SlashExtension.ts:1、TiptapEditorField.tsx:1、markdownSerializer.ts:1）的文件级 `eslint-disable @typescript-eslint/no-explicit-any` 头注释统一补充边界声明："仅限 Tiptap 插件 API 对接层（editor/command/range 互操作），禁止业务逻辑使用 any"；在 check-no-as-any-store.mjs 或新扫描中自证：豁免区外生产 `: any` 0 处、豁免区内业务逻辑文件 0 处。

**验证方式**：扫描脚本输出豁免区内 any 全部命中"对接层签名"形态（人工抽检 5 处）；lint 绿。

**完成判据**：边界声明入库，豁免区外零 any 有扫描自证。

#### 6d 规范成文（P3 散项一页决策记录）

**任务**：在 `docs/frontend-audit/` 下补一页简短决策记录（≤50 行）固化三项：
- 目录命名惯例（组件 Pascal / hooks·utils camelCase / 目录 kebab 为主体，`components/ui/*` 的 Pascal 保留并注明）；
- 非空断言约定（数组索引访问必须附 bounds 判断或 `swallow` 注释，禁止裸用）；
- zod 与手写 schema 边界（配置域 zod / IPC 事件域手写轻量校验器，新代码按域选择不摇摆）。

**验证方式**：文档评审 + 与现有代码惯例抽检一致（审计 §3/§4 已证明代码自洽度高）。

**完成判据**：三项决策有唯一成文出处；无"无成文声明"的第三轨出现。

---

## 3. TS 吞错门禁设计（no-silent-catch）

对标 Rust `check-swallowed-errors.mjs`（scripts/check-swallowed-errors.mjs:1-22 语义），前端等价物采用 **eslint 本地规则（AST 精度）+ 独立基线脚本（统计/刷新）** 双件架构：

### 3.1 规则与匹配形态

本地规则 `no-silent-catch`（error 级），匹配形态：

| 形态 | AST 判据 | 示例 |
|---|---|---|
| 无绑定空 catch | CatchClause 且 body 无语句（或仅 EmptyStatement） | `catch { }` |
| 有绑定空 catch | 同上，有 param | `catch (e) { }` |
| Promise 链静默 | CallExpression.callee 为 `.catch`，实参为箭头函数且 body 为空 | `.catch(() => {})` / `.catch((e) => {})` |

注释豁免：body 存在注释（阶段 A）或注释命中 marker `swallow-ok`（阶段 B 严格模式，`markerRequired: true`）→ 不计为静默。

### 3.2 双维白名单机制

- **文件级（存量）**：基线标记区记录 `<相对路径> <未注解计数>`（markdown marker 区，与 Rust 基线同风格，git diff 可复核）。有条目的文件以基线为上限（ratchet）；**无条目的文件零容忍**——新文件含空 catch 即 fail。
- **单点级（合理静默）**：`/* swallow-ok: 原因 */` 注释 marker。既保留"有意图的静默"，又强制显式化——延续仓库"每条 eslint-disable 都有理由"的既有纪律（审计 §1.3 已证 37 行豁免全部有注释）。

### 3.3 基线建立方式（先登记，再收紧，避免一次性全红）

1. `--report` 摸底：扫描统计各文件未注解空 catch，与审计 306/33 数字对账（口径差异记入基线头注释）；
2. `--update` 首次建线：全量写回标记区 → lint 全绿（存量被基线吸收，CI 立即变绿）；
3. 治理中每批 `--update`：计数下降 → 基线收紧到当前值；某文件清零后条目移除 → 该文件进入零容忍；
4. 阶段 B：未注解 = 0 后切换 `markerRequired: true`，所有空 catch 必须带 `swallow-ok` marker——门禁语义最终形态；
5. `--update` 提升基线必须显式执行（git diff 复核），杜绝"悄悄放宽"。

### 3.4 CI 接入点

- **零新增 job**：规则定义于 eslint.config.js，`npx eslint .`（ci.yml lint job:58）与 `npm run lint:all -- --max-warnings 0`（本地）自动覆盖；
- `check:desktop`（package.json:41）显式追加 `node scripts/check-swallowed-errors-frontend.mjs --report`（报告模式，便于 diff 观察趋势，非门禁本体）；
- 门禁本体 = eslint 规则本身，双跑路径同口径，不产生"本地过 CI 挂"。

### 3.5 与 Rust 侧关系

保持同一语义族（ratchet/显式登记/只读统计），但前端按"文件"而非"crate"计数（粒度更细，治理清单即基线）；Rust 脚本不动。

---

## 4. 基线策略（本方案的总闸门哲学）

1. **先建线后清零**：所有存量超标类问题（306 空 catch、44+19 行数违规、RL-04 命中面）一律"先登记现状为基线、门禁立即生效、存量逐步消化"，**任何一步都不允许一次性全红**。
2. **ratchet 单向收紧**：计数 > 基线 fail、≤ 基线 pass、下降放行；`--update` 是唯一提基线通道且必须显式执行 + git diff 复核（对齐 Rust 基线惯例，docs/multi-agent-repair/基线记录/swallowed-errors-baseline.md:68-85）。
3. **基线清空 = 治理完成**：治理进度以"基线条目移除数"为单一进度指标，而非笼统的"XX 个 catch 已处理"。
4. **零容忍区先行**：新文件、chat-composer 豁免区外、任何"无基线条目"的文件从门禁上线第一天起零容忍——基线只保护历史存量，不保护新债。

---

## 5. 新发现补充（读代码/复核时发现，审计未覆盖）

1. **toolFeedback.ts:379 的 `eslint-disable-next-line no-control-regex` 无理由注释**——与审计 §1.3"37 行 eslint-disable 全部带理由"的结论冲突，是仓库内唯一一例无理由豁免（读文件实测，见 C:\Software\conex\apps\crish-desktop\src\api\toolFeedback.ts:378-380）。且其剥离对象是 ANSI ESC（`\u001b\[...`），与 parseAnsi.ts:54 同族——构成**第 12 个剥离重复点**，应并入 5a 的 stripAnsiEscape 迁移（步骤 5a 已包含）。
2. **`logInternalError` 自身含空 catch**（userFacingErrors.ts:247-249 `catch { /* ignore */ }`）——"日志后端自保护"的**教科书级合理静默**，应作为步骤 3 分级治理的示范条目与 `swallow-ok` 注释规范样例（含在基线中，无需改动）。
3. **严格模式实测偏差**：`rg -c "\.catch\(\(\) => \{\}\)"` 生产 src（排除测试）仅 10 处，审计报 33——差异源于审计的宽口径（含 tests/ 与多行/变体形态）。步骤 1 建线时必须先统一规则自身口径再对账，**以规则口径为门禁事实**，避免"审计数字 vs 门禁数字"永久对不上。
4. **utils/ 目录已成事实惯例**（parseAnsi.ts、redact.ts、storageKeys.ts 等 20+ 小型工具）——步骤 5a 的 stripText.ts 落位与既有惯例自洽，无需新建目录；但 utils/ 无 barrel，新工具按"直接路径 import"惯例即可（与 3.4 的 barrel 克制原则一致）。
5. **`check-line-counts.mjs` 分类正则过宽**：`/types?/i.test(filename)`（check-line-counts.mjs:49-51）会命中任何文件名含 "types" 子串的文件（如未来出现 prototypes.ts 类命名会被误分类为类型契约 800 行档）。步骤 2 重构时收敛为后缀匹配（`*.types.ts` / `*-types.ts` / `types/` 目录），避免门禁接 CI 后出现误分类豁免漏洞。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 一次性全红（门禁接了 CI 全挂） | 阻塞所有提交 | 基线先建后接线（步骤 1/2 的顺序即为此），建线后 lint 全绿才提交 CI 接线 |
| 规则误报/漏报（AST 形态覆盖不全） | 门禁失真 | 建线前负向/正向用例双测（步骤 1 验证项）；`--report` 与审计对账；形态表 §3.1 在实施时按真实 AST 再校准 |
| 空 catch 治理误伤（把有用兜底删了/日志补点改变控制流） | 行为回归 | 分级判定必须人工逐文件确认语义（步骤 3 铁律：禁止机械替换）；存储/持久化文件重点跑单测；补日志不改控制流 |
| 拆分 hook 改变公开返回面 | 消费方连锁破坏 | typecheck 为强锚（返回类型不变即编译期自证）；拆分子 hook 组合保持外层签名逐字段一致 |
| 与 02/07 方案文件冲突（ModelConfigEditor 等重叠文件） | 合入冲突/重复劳动 | 调度者按文件串行分配；本方案只拆函数逻辑，02 拆组件结构，重叠文件登记冲突清单 |
| Tooltip 删除与 02 P0-5 迁移竞态 | 删除时仍有消费方 | 严格依赖 02 完成（步骤 5b 前置条件）；未完成期间禁止新消费方 import 旧版 |
| 基线文件被手工误改放宽 | 门禁形同虚设（重蹈覆辙） | marker 区由脚本维护 + git diff 复核；AGENTS.md 声明"提升基线必须 `--update` 显式登记" |
| 基线文件路径漂移（前端基线该放哪） | 发现性差 | 统一放 `docs/multi-agent-repair/基线记录/`（与 Rust 基线同目录，未来扫描该目录即见全部门禁），本方案所有基线路径写死于此 |
| 行数门禁语义与声明再次脱节 | 纸面门禁复发 | 步骤 2 把 .agents/AGENTS.md 声明文本一并修改为与实现逐条对应；后续任何门禁改动必须同步声明 |

---

## 7. 闭环关系图（每步输出 → 下一步输入）

```
步骤 1 吞错基线（先建线） ──基线文件──→ 步骤 3 空 catch 分级治理（每批 --update 收紧）
         │                                    │ 清零后
         │                                    ▼
         │                            marker-required 严格模式（门禁终态）
步骤 2 行数基线 ──18 个 >650 清单──→ 步骤 4 超长函数拆分 ──行数下降──→ 步骤 2 基线条目移除
         ▲                                                    │
         └─────────────── 每批拆分后 --update 收紧 ←───────────┘
步骤 5 重复收敛（strip 下沉 / Tooltip 唯一）  ← 步骤 4 暴露的重复块 + 步骤 5a 新发现 12 点
步骤 6 纸面门禁清零 / 规范成文              ← 步骤 3 完成后的严格模式 + 全程声明同步
多轮迭代：每轮 = 治理一批 + --update 收紧一批，门禁渐进至零基线
```
