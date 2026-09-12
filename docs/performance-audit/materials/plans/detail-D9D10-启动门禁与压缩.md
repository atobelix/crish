# detail-D9D10 · 启动/资产/门禁 CI + Compaction/G8（分维详案）

> **战役**：performance-fix  
> **上游必读**：`92-修复总方案.md`（唯一执行总案）· `materials/plans/independent-04-启动资产与门禁.md` · `materials/plans/independent-02-阻塞与执行面.md` · `materials/plans/review-plans-01-冲突与重叠.md`（CFL-06/07/13）· `16-可观测性与perf资产审查报告.md` · `07-启动链路性能审查报告.md` · `11-资产与构建体积审查报告.md` · `13-Compaction与上下文压缩审查报告.md`  
> **地位**：D9 / D10 分维执行详案；执行轮只认本文件 + 92，independent-* 为交叉输入非执行稿。  
> **原则**：效果锁不缩水；删除是完成方式；问题同权；不谈工期/人天/人员。  
> **禁止**：`git commit`；05 抢 `ci.yml` 同 job 步骤；用 warn 永久化冒充门禁完成；用提示词防线冒充 G8 接线。

---

## 0. 主责与互斥边界（先钉死，再展开）

| 维 | 92 主责 | 唯一文件域摘要 | 明确排除 |
| -- | ------- | -------------- | -------- |
| **D9** | **04 唯一**（CFL-07 / OVL-21 / U-START-GATE） | `vite.config.ts` · App 入口静态边（`App` / `firstRunWizardLib` / `AppGlobalDialogs` / `readiness`）· `scripts/check-startup-budget.mjs` · `scripts/check-dist.mjs` · `.github/workflows/ci.yml` **frontend-build** · 根 `package.json` `check:desktop` · catalog 物质/字体/motion 卫生 | **禁止** 05 的 D1.10 / U-CI 与本维同轮改 `ci.yml` **frontend-build** 同一 job 步骤；05 只保留「压测进 ci-slow」等非启动项引用 |
| **D10** | **02**（92 D10 / OVL-05/06 / U-SUMMARY） | `crates/session-loop/src/loop/{compaction_dispatch,summary_dispatch}.rs` · `handlers/stream_error_recover.rs` · `crates/conex-compaction/src/{engine,ai_summary,tool_output,plan}.rs` · 工具完成记录收口点（`executing_tools` 等） | **G8 = U-G8 独立票**（CFL-06），**不并入** D1（NoPersist/减载）或 U-OUT-RS（执行器 `output_budget_bytes`）验收冒充完成 |

**CFL-07 落地铁律（汇报项·门禁）**：

1. startup-budget 接线与静态图语义 **仅 D9 主责**；05 D1.10 降为「引用 04 验收」或删除重复实现。  
2. **禁止** 05 U-CI 与 04/D9 U-START-GATE 同轮改 `ci.yml` 同一 `frontend-build` job 步骤（步骤顺序冲突必互踩）。  
3. 05 若改 CI，只允许动 **ci-slow / 压测** 等与 frontend-build 无关的 job。

**CFL-06 落地铁律（汇报项·G8）**：

| 票 | 主责 | 内容 | 不做 |
| -- | ---- | ---- | ---- |
| U-OUT-RS | 02-D5 | `run_launch` 默认 Some + 执行器截断 + ToolEnd 出口 Arc | 不接 G8 |
| U-OUT-FE | 03-D5 | store 写入 hardCap | 不接 G8 |
| **U-G8** | **02-D6 后半（本详案 D10-B）** | `truncate_tool_output` **正常工具路径**接线 + emergency 保留 | 不做执行器 budget；不做前端 hardCap |

两层互补、数值同源（D0 `perf_budget`）：执行器 `output_budget_bytes` = 事件载荷；G8 = conversation 工具结果行/字节双阈值 + 留痕。

---

## 1. D9 · 启动/资产/catalog/门禁 CI

### 1.1 做什么（映射 90 ID）

按 04 SG0→SG6 逻辑序展开为三个可验收任务单元；92 效果锁 E1–E7 不得降级。

#### D9-A · startup-budget fail + CI（U-START-GATE，SG0，可最先落地）

| 项 | 内容 |
| -- | ---- |
| **映射** | 16-P1、16-P2、07-A2、11-B2、11-B10、92 INV-7 |
| **升级 `scripts/check-startup-budget.mjs`** | ① 保留 entry 单文件预算（`BUDGET_KB` / `--budget-kb`，缺省 520）；② **新增静态图 JS 合计预算** `STATIC_GRAPH_BUDGET_KB` / `--static-graph-kb`；③ `totalBytes`（现仅信息行，:220–246）进入 `warnings`；`--strict`（及 CI）下进 `errors` → **exit 1**；④ 静态图内 **deny 名单** `STATIC_GRAPH_DENY`：断边验收后含 `chat-provider-catalog`；⑤ 阈值数字迁入预算命名空间（D0 `startup-graph-budget` / 同语义单一源，**禁止**第三真源长期分叉——CFL-01）。 |
| **扩展 `scripts/check-dist.mjs`** | modulepreload href 集合 ⊆ 允许清单；entry css 合计预算（建议 280 KiB 起步）；entry/`index-*.js` 500 KiB 硬线保留，与 startup-budget **数值同源或职责表交叉引用**（DEL-4 双真源收敛）。 |
| **接线** | `ci.yml` `frontend-build`：`build:desktop` → `check-dist` → **`node scripts/check-startup-budget.mjs --strict`** → 既有 `check:chunk-cycles`；根 `package.json` `check:desktop` 链追加 `check:startup-budget`。 |
| **夹具** | 假 manifest 单测：entry 小 + 大静态 import → 非 strict 可 warn、strict/CI fail；deny 命中 exit 1。 |

#### D9-B · 首屏静态图断边 + catalog 物质 + modulepreload（SG1+SG2，同单元串行）

| 项 | 内容 |
| -- | ---- |
| **映射** | 07-A1、11-B1、11-B3、11-B5；合并根因「catalog 静态边 + modulepreload 钉死」 |
| **断三处上游静态边** | ① `firstRunWizardLib`：轻量探测模块（`providerProfilesLight` 等价，只读 LS 键）+ 重逻辑 `await import`；② `AppGlobalDialogs`：去模块顶层 `getActiveModelId/getActiveProfileId` 静态 import；③ `readiness.ts`：断 **transport↔catalog 互边**——注入 getter 或轻量旁路，禁止 `chat-bridge-transport` 静态 import catalog 成员。 |
| **modulepreload** | 断边后 entry `imports` 与 `index.html` modulepreload **双断言**不含 `chat-provider-catalog`；preload 白名单收缩并冻结（D9-A allowlist）。 |
| **catalog 物质重组** | zod 归 `vendor-zod`；autofill baseline JSON 改独立懒资产；surfaceRouter/迁移边从 catalog 组剥离；门面轻重拆。指纹：catalog chunk **无** `ZodError` / `import_from_localstorage` / `navigateToSurface`；体积期望 &lt;150 KiB（基线冻结后写入预算源）。 |
| **负产出** | 三处旧静态 import **物理删除**（DEL-5），禁止双路径兼容。 |

#### D9-C · 负产出切除：motion（PR-MOTION 前置）+ woff + 可选大件后移（SG3–SG4）

| 项 | 内容 |
| -- | ---- |
| **映射** | 11-B6（motion）、11-B9（woff）、07-A3（highlight）、CFL-13 / PR-MOTION |
| **PR-MOTION 依赖（必须先复核后删）** | ① 复核（原 06-P12 票，主控并入本维前置）：`knip` + `rg motion/react` + lock 节点；② **复核通过 → 删除** `apps/crish-desktop/package.json:53` `motion` + animated-icons 四组件处置（迁 `reference/` 测试 fixture 或整目录删 + 陪葬测试登记）；③ **复核失败 → 改为「CSS 替换后删」或主控书面豁免**——效果锁不降（最终无 motion），仅插入前置验证。 |
| **woff** | dist 去 `.woff` 仅保留 woff2；`fontStoreCatalog` / 构建过滤；四族字体 FOUT 无回归。 |
| **可选后移** | vendor-highlight 长尾懒注册；`optimizeDeps` 改 `highlight.js/lib/core` 子路径；空会话无 modelVendorCatalog 静态边。 |
| **PR-MOTION 依赖汇报** | motion 删除**阻塞于** knip/import 复核结论；与 package.json 其它依赖变更串行；禁止复核未出就合 lock 删除。 |

### 1.2 删什么（删除/合并清单 + 负向断言）

| # | 对象 | 证据锚点 | 负向断言 |
| - | ---- | -------- | -------- |
| DEL-8 | 静态图「仅信息、永不进 errors」分支 | `check-startup-budget.mjs:220–246,260–266` | totalBytes 超限在 strict 下 exit 1；夹具覆盖 |
| DEL-5 | wizard/dialog/readiness 旧静态 import | `firstRunWizardLib` / `AppGlobalDialogs.tsx:6` / `readiness.ts:12` | 源码无 `from …providerProfiles` 于上述路径；manifest entry.imports 无 catalog |
| DEL-6 | catalog 组内错误聚合物质 | 指纹：ZodError / migrate / surface / baseline JSON | catalog chunk 0 指纹命中 |
| DEL-1/2 | `motion` 依赖 + animated-icons 死依赖面 | `package.json:53` + `ui/animated-icons/*`（**复核后**） | lock 无 motion；生产 0 `motion/react`；测试处置表完整 |
| DEL-3 | `.woff` 产物路径 | dist 16 文件双格式 | dist `*.woff` 计数 = 0 |
| DEL-4 | check-startup-budget ∩ check-dist 体积双真源模糊地带 | entry 520 vs 500 双锚 | 职责表 + 数字同源；CI 只跑接线后主链 |
| （不删） | check-dist CSP/vendor 存在性；xterm/tiptap 真 lazy；chunkSizeGate 600 单块硬线 | 04 §3.3 | 正面防回潮 |

### 1.3 依赖与逻辑序

```text
D9-A 骨架 fail+CI（阈值先宽后紧，禁止长期软）
  │  （回归可见性是并行修复期防体积漂移的前置）
  ▼
D9-B 断边 + 物质 + preload 双断言（同执行单元串行）
  │  （物质未拆则动态触达仍付 ~550 KiB）
  ▼
D9-C PR-MOTION 复核→删 motion；woff2-only；highlight/icon 后移
  │  （与 B 共享 package.json/vite 时串行）
  ▼
门禁收紧至目标基线（~900 KiB 静态图）+ 快照固化
```

**禁止顺序反例**：

1. 未断 catalog 静态边 → 不得把静态图阈值直接砍到 900 并宣称完成。  
2. 未做 catalog 物质拆分 → 不得只 manualChunks 再拆一刀宣称「惰性完成」。  
3. CI 接线不带超限 exit 1（或仅 soft 永不 strict）→ 不得计入 D9-A 完成。  
4. **PR-MOTION 复核未通过** → 不得物理删除 motion / animated-icons。  
5. 不得为过门禁而 **上调** 阈值；阈值只允许断边/重组后 **下调** 并记基线。  
6. **禁止** 与 05 在同一 `frontend-build` 步骤列表并发编辑（CFL-07）。

### 1.4 唯一文件域（与并行维互斥）

| 路径 | 操作 | 并行伙伴 | 互斥说明 |
| ---- | ---- | -------- | -------- |
| `scripts/check-startup-budget.mjs` | 扩展 fail 模型 | 与 D10 完全不交 | **仅 D9** |
| `scripts/check-dist.mjs` | 扩 preload/css | 同上 | 与 startup-budget 同 D9 内串行职责表 |
| 预算数字源（D0 命名空间 / `startup-graph-budget`） | 迁移数字 | D0 U-BUDGET | D9 只消费+迁移，不新建第三真源 |
| `.github/workflows/ci.yml` **frontend-build** | 追加 `--strict` 步骤 | **禁止 05 U-CI 同轮同 job** | CFL-07 |
| 根 `package.json` `check:desktop` | 追加 startup-budget | — | 与 D9-A 同票 |
| `apps/crish-desktop/vite.config.ts` | manualChunks / optimizeDeps | 与 D10 无交 | catalog 组 + vendor-zod |
| App 入口四件 + providerProfilesLight | 断边 | 与 D10 无交 | D9-B |
| `apps/crish-desktop/package.json` deps | 删 motion | 与 D-AS 共享时串行 | **前置 PR-MOTION** |
| `src/components/ui/animated-icons/**` | 删/迁 | — | 测试处置表 |
| 字体入口 / `fontStoreCatalog` | woff2-only | — | D9-C |

**与其它 92 维**：不碰 `sessionStore` 持久化切除（D4）；不碰 `src-tauri` setup 分级（04 D-SU 若落地归独立 U-SETUP，**不塞进本 D9 前端票**——92 已将 setup 从 D9 文件域剥离叙事时以 04 文件域表为准；本详案 **不实现** U-SETUP，仅登记交叉）。92 §4 D9 行文件域为「vite、App 入口、check-startup-budget、ci.yml」——setup 分级若另票，不抢本文件域。

### 1.5 验收（功能 + 负产出 + 五端物证）

| 类 | 断言 |
| -- | ---- |
| **功能** | 冷启动静态图 ≤ 冻结预算；catalog 不在 entry 静态图/preload；打开模型选择/设置才加载 catalog；autofill 懒；向导/readiness/高亮/字体行为不变 |
| **门禁功能** | 有 dist：`--strict` 超静态图预算 exit 1；deny 命中 exit 1；preload 超白名单 exit 1 |
| **CI** | 人为塞回 catalog 或抬体积 → `frontend-build` 红；步骤序列含 `check-startup-budget --strict` |
| **check:desktop** | 字符串包含 startup-budget；无 dist 本地可 warn+0；CI 在 build 后必有 dist 且 strict |
| **负产出** | 旧静态 import ≥3 处删除；lock 无 motion（复核通过后）；dist 无 `.woff`；静态图仅信息路径删除；catalog 非域物质 0 指纹 |
| **防回潮** | manifest/preload 快照测试；deny 名单夹具；红灯演练一次写入 PR 描述 |
| **五端** | 触发=启动/向导/设置/首开 · 传输=manifest imports/preload diff · 介质=dist 字节+lock+budget 数字 · 消费=CI 实际执行日志 · 负向=catalog 不在 entry + strict 红灯 |

**关键运行时 V（实现后经 4000 Tauri MCP 回填）**：V1 catalog 不在首屏瀑布；V3 woff2-only 无 FOUT 回归；V2 静态图 parse 段缩短。

### 1.6 路径 N→M

| 概念 | 现路径 | 目标 | 主责 |
| ---- | ------ | ---- | ---- |
| startup 门禁 | warn 孤岛 + 不进 CI | **fail+CI 唯一主责 D9** | D9 |
| 首屏体积断言 | 3（startup-budget 软 / check-dist 500 / chunkGate 600） | 图谱级主路径 = startup-budget(fail)；check-dist = CSP+vendor+preload；chunkGate = 单块硬线 | D9 |
| providerProfiles 访问 | App 静态门面 + 全域混用 | 运行时重路径留 catalog；首屏 = 轻路径 | D9-B |
| modulepreload 合法性 | 隐式=全部静态 import | 显式白名单 + 断言 | D9-A/B |
| motion 依赖 | 声明存在 + 测试引用 + dist 无指纹 | **复核后删除**（PR-MOTION） | D9-C |
| 字体 | woff+woff2 双格式 | 仅 woff2 | D9-C |

### 1.7 防御脚本/守护测试增量

| 增量 | 作用 |
| ---- | ---- |
| `check-startup-budget --strict` 进 `ci.yml` + `check:desktop` | 消除 16-P2 孤岛 |
| 静态图合计 fail + deny | 消除 16-P1 / 07-A2 |
| preload allowlist ⊆ 断言 | 消除「假 lazy」（11-B1） |
| 假 manifest strict 夹具 | 防「接线了但永不红」 |
| manifest/preload 快照 | 冻结断边结果 |
| entry manifest imports ⊄ catalog 单测 | 防回潮 |
| knip/grep motion | PR-MOTION 复核门 |
| dist `*.woff` 计数脚本或构建断言 | 防字体双格式回潮 |
| 职责表写入脚本头 + FULL_CHECK | DEL-4 双真源不再漂移 |

### 1.8 门禁阈值策略（必报）

| 阶段 | 静态图合计 | entry | strict | 说明 |
| ---- | ---------- | ----- | ------ | ---- |
| **接线过渡（SG0 合入时）** | **1800 KiB fail**（现状 ~1709 仅留窄余量） | 520 warning→strict fail | **CI 必须 `--strict`** | 禁止「先 warn 14 天」式软接线——评审 F9；1800 即可 fail，保证「再涨必红」 |
| **断边+物质完成后（SG1+SG2 验收数字之后）** | **下调至 900** 并冻结进预算源 | 保持 / 可与 check-dist 500 同源收紧 | 保持 | 只允许下调；上调需主控书面 |
| **entry css** | 起步 ~280 KiB（D9-A 可选阶段） | — | strict | 与 check-dist 合并实现时注意职责表 |
| **deny 名单** | 断边验收合入后启用 `chat-provider-catalog` | — | strict | 在断边 PR 内启用，防止断边未合就 deny 误红主干 |

**策略铁律**：阈值数字唯一来源 = 预算 SSOT 命名空间（92 CFL-01）；`BUDGET_KB`/`STATIC_GRAPH_BUDGET_KB` env 仅作 CI/本地覆盖面，**禁止**业务源再写第二套启动预算魔数。05 侧任何「超预算 CI 红」文案必须指向本表，不得另写过渡值。

---

## 2. D10 · Compaction 同步摘要 + G8

### 2.1 做什么（映射 90 ID）

拆为 **D10-A（summary spawn_blocking 对齐 + 消二次 compact）** 与 **D10-B（U-G8 正常路径）** 两票，同维串行、文件域可部分重叠但验收分开勾选。

#### D10-A · summary spawn_blocking 对齐（U-SUMMARY / helper 抽取）

| 项 | 内容 |
| -- | ---- |
| **映射** | 13-C13-H1；正面对照 `summary_dispatch.rs:780-793` |
| **共享 helper** | 抽取与 `summarize_once` **同源**的 `summarize_via_blocking(summarizer, dropped, existing, wall_ms)`——`spawn_blocking` + `tokio::time::timeout`；**禁止** compaction 侧再写第二份阻塞纪律 |
| **引擎 API** | `compact_agent_messages_with_stub_policy` 增加接受「已算摘要」入口（`summarize_precomputed: Option<Result<String,String>>`），或 dispatch 层先 helper 再调纯计划引擎 |
| **接线点** | `compaction_dispatch.rs` 预检/边界路径；`stream_error_recover.rs` 溢出阶梯；**删除** run loop 内对同步 `summarizer.summarize` 的直接调用（引擎 :370-371 仅经 precomputed/helper 结果，或引擎内不再裸调） |
| **R-F 语义** | 同步单次尝试 = 「阻塞池内单次尝试 + 墙钟」；**不改** StubPolicy / LlmRequired 决策树；禁止静默降级为纯丢弃 |
| **溢出二次 compact（13-M4，与 H1 同票）** | shape 失败时 **禁止**第二次完整 summarize：只重算 cut + **复用已生成 summary**，或放弃/fatal；禁止 2× LLM |

#### D10-B · G8 正常路径（U-G8 独立票，**不并入 D1**）

| 项 | 内容 |
| -- | ---- |
| **映射** | 13-C13-H3；算法已存在 `tool_output.rs:178`；生产唯一调用现为 emergency `engine.rs:579` |
| **接线** | session-loop **工具结果写入 conversation 前**调用 `truncate_tool_output`（限额来自 D0 `G8_TOOL_OUTPUT_MAX_LINES/BYTES`，现 2000 行 / 50KiB）；留痕事件按 `tool_output.rs` 设计落库 |
| **emergency** | **保留** emergency preflight 调用；正常 + emergency = **同一算法两处调用**（CON-6），非双实现 |
| **提示词第二道** | `build_summarize_prompt`：单消息渲染 + 总长预算（与 `max_summary_tokens×4` 同源），超限 head+tail+标记——**第二道防线，不得单独冒充 H3 完成** |
| **dropped 克隆** | 优先 `Vec<Arc<AgentMessage>>` / 借引用渲染，避免为 LLM 入参先付全文值克隆（`engine.rs:363`） |
| **与执行器预算边界** | 不实现 `output_budget_bytes`（归 U-OUT-RS）；不实现前端 hardCap（U-OUT-FE）；两层数值同源、语义分列（CFL-06） |

### 2.2 删什么 + 负向断言

| # | 对象 | 锚点 | 负向断言 |
| - | ---- | ---- | -------- |
| DEL-9 | run loop 内同步 summarize 调用路径 | `compaction_dispatch` → `engine.rs:370-371` | 非测试路径 `summarizer.summarize` 直调 = 0（经 helper/precomputed） |
| DEL-10 | G8「仅 emergency」唯一生产形态 | emergency 保留 | `truncate_tool_output` 生产调用点 **≥ 2**（正常工具记录 + emergency） |
| （消） | 溢出 shape **二次完整 compact** | `stream_error_recover.rs:178-205` 二次 `compact_…` | 二次路径不再二次 LLM；复用 summary 或放弃有测试 |
| （不删） | 提示词防线；emergency 函数本体 | — | 保留为第二道/兜底 |

### 2.3 依赖与逻辑序

```text
D0 预算 SSOT（G8 双阈值、摘要墙钟常量）
  │
  ├─(概念) D5 U-OUT-RS 执行器 budget 语义清晰 —— 不阻塞 G8 接线，但任务书须写清两层
  │
  ▼
D10-A  summarize_via_blocking 抽取 + 引擎 precomputed 入参
  │     → 改 dispatch / stream_error_recover 调用点
  │     → 删同步路径（DEL-9）+ 消二次 compact（M4）
  ▼
D10-B  U-G8：正常工具记录路径 truncate_tool_output + 留痕
        → 提示词第二道 + Arc 借引用
```

**禁止顺序反例**：

1. 未删同步 summarize 前，不得只加 estimate 缓存宣称「压缩已优化」。  
2. **未接 G8 到正常工具路径前**，不得只在 `build_summarize_prompt` 加防线宣称 H3 完成。  
3. **不得把 U-G8 并进 D1 或 U-OUT-RS 验收**（CFL-06 F4）。  
4. shape 修复不得以「再跑一遍完整 compact」冒充修复（M4）。  
5. helper **只允许一份**（与 summary_dispatch 同源）；禁止双 helper。

### 2.4 唯一文件域（与并行维互斥）

| 路径 | 操作 | 并行 | 互斥 |
| ---- | ---- | ---- | ---- |
| `crates/session-loop/src/loop/summary_dispatch.rs` | 抽公共 helper（或 re-export） | — | 唯一 helper 源 |
| `crates/session-loop/src/loop/compaction_dispatch.rs` | 改调用点 | 与 D9 无交 | D10-A |
| `crates/session-loop/src/loop/handlers/stream_error_recover.rs` | 消二次 summarize | — | D10-A |
| `crates/conex-compaction/src/engine.rs` | precomputed / 删直调 | — | D10-A |
| `crates/conex-compaction/src/{ai_summary,tool_output,plan}.rs` | 提示词预算；G8 常量 re-export | — | A/B 分票碰不同函数优先 |
| 工具完成收口（`executing_tools` / tool end 写 conversation 点） | **G8 接线** | **禁止**与 U-OUT-RS 同轮双改同一 Arc/预算装配行 | **仅 U-G8 票**；与 D1（NoPersist）文件域隔离 |

**与 92 其它维**：U-SUMMARY / U-G8 **不**并入 U-NOPE（D1）；执行器 `run_launch` 默认预算归 U-OUT-RS，本详案不改 `run_launch.rs` 装配（除非仅透传 G8 常量 re-export，仍以 U-G8 任务书为准）。

### 2.5 验收（功能 + 负产出 + 五端物证）

| 类 | 断言 |
| -- | ---- |
| **功能** | 预检/边界/溢出既有集成测试全绿；慢 Summarizer（sleep 5s）注入时同 task 内 abort ≤1s 生效；emergency 截断不回归；G8 正常路径截断单测 + 留痕字段 |
| **M4** | shape 不满足时 **summarize 调用次数 = 1**（或 0 若放弃）；无第二次 LLM |
| **负产出** | 非测试 `summarizer.summarize` 直调 = 0；`truncate_tool_output` 生产调用点 ≥2；无第二份 spawn_blocking 摘要实现 |
| **五端** | 触发=长对话 85% 预检 + 含大工具输出的会话 · 传输=工具结果写入 conversation 前已截断标记 · 介质=spill/留痕事件落库 · 消费=摘要 HTTP body 含截断标记而非全文 · 负向=慢摘要 abort 探针 + G8 调用点计数 |
| **运行时 V** | 13-V1 / BV6：发送→首 token **不含**完整摘要 RTT；慢摘要下 abort 延迟 |

### 2.6 路径 N→M

| 概念 | 现路径 | 目标 | 主责 |
| ---- | ------ | ---- | ---- |
| 摘要阻塞承接 | 2（summary_dispatch 已 spawn_blocking + compaction 同步错误） | **1** helper `summarize_via_blocking` | D10-A |
| G8 截断注入点 | 1（emergency） | **2**（正常工具记录 + emergency），同一算法 | D10-B U-G8 |
| 溢出 shape 修复 | 二次完整 compact（二次 LLM） | 复用 summary / 放弃 | D10-A |
| 工具输出约束 | 执行器 budget（U-OUT-RS）∪ G8（U-G8）∪ 前端 hardCap（U-OUT-FE） | **三票分治、常量同源** | CFL-06 |

### 2.7 防御脚本/守护测试增量

| 增量 | 断言 |
| ---- | ---- |
| G8 调用点存在性（单测或 check 脚本） | 正常工具路径存在 `truncate_tool_output`；emergency 仍在 |
| 同步 summarize 禁直调 | 业务 `.rs` 非测试禁 `summarizer.summarize(` 裸调（白名单 helper 内） |
| M4 单测 | 二次 shape 修复 summarize 次数断言 |
| 慢 Summarizer abort 探针 | H1 回归锚点 |
| 提示词预算单测 | 100KB ToolResult dropped 段 → prompt 长度 ≤ 预算 |
| （贯穿，D8） | 预算字面量仅允许 `perf_budget` re-export |

---

## 3. D9 / D10 与 92 / 评审对照摘要

| 裁决 ID | 本详案落地 |
| ------- | ---------- |
| **CFL-07** | startup 门禁仅 D9；05 禁抢 frontend-build |
| **CFL-13 / PR-MOTION** | motion 删除前置 knip 复核；通过才删 |
| **CFL-06 / OVL-05** | U-G8 独立票；不并 D1/U-OUT-RS |
| **OVL-21** | startup-budget fail+CI = D9-A |
| **OVL-06** | 同步摘要 helper = D10-A 单源 |
| **F4** | G8 正常路径调用点 ≥1 + 测试 |
| **F9** | CI `--strict` + 红灯演练；禁 warn 永久化 |
| **92 §10 U-START-GATE** | = D9-A |
| **92 §10 U-SUMMARY** | = D10-A（G8 后半独立为 U-G8，仍挂 D10） |
| **92 禁反例 7** | motion 复核后删 |

---

## 4. 执行单元切片建议（逻辑，非排期）

| 单元 | 维 | 内容 | 前置 |
| ---- | -- | ---- | ---- |
| **U-START-GATE** | D9-A | fail+CI+check:desktop+夹具+阈值策略表 | 可与 D0 预算命名空间并行（数字路径写死即可） |
| **U-BUNDLE-SG** | D9-B | 三处断边+轻模块+manifest/preload 断言 | 强依赖 U-START-GATE 的 deny 可同轮或紧随 |
| **U-BUNDLE-MAT** | D9-B 后半 | zod/baseline/surface/门面 | 串行于 U-BUNDLE-SG |
| **U-ASSET-HYGIENE** | D9-C | PR-MOTION 复核→motion 删；woff2；highlight | 复核绿；与 package.json 共享串行 |
| **U-SUMMARY** | D10-A | helper+precomputed+删同步+M4 | D0 常量；可与 D9 文件域并行 |
| **U-G8** | D10-B | 正常路径 truncate+留痕+提示词二道 | D10-A 可并行开工但验收独立；**禁并 D1** |

首轮若需文件域互斥并行：`U-START-GATE` ∥ `U-SUMMARY` ∥（前端断边若未碰 ci.yml 则也可并，但 deny 与严格阈值同 D9-A 协调）。

---

## 5. 诚实边界

1. 静态图 1709.3 / catalog 550.5 / entry 497.4 来自 07/11/materials/11 实测口径；实现轮以当前 dist 复测为准。  
2. stream_error_recover 路径为 `crates/session-loop/src/loop/handlers/stream_error_recover.rs`（非 loop 根下）；引用行号以当前读码为准（二次 compact :192-198 附近）。  
3. PR-MOTION 复核结论**尚未在本详案执行**——删除票状态 = 「待复核」。  
4. U-SETUP（壳 setup 分级）**不在本 D9 实现范围**。  
5. estimate 缓存（13-H2）**不在** D10——归压缩 CPU 维，禁止混票。  
6. 本详案未跑全量测试；实现单元必须功能+负产出双验收。  
7. **未 git commit**；改动留工作区由主 Agent 收口。

---

## 6. 附录 · 证据锚点速查

| 事实 | 锚点 |
| ---- | ---- |
| 静态图仅信息行、不进 errors | `check-startup-budget.mjs` totalBytes ~:220-246；strict 仅护 entry |
| CI 无 startup-budget | `ci.yml` frontend-build :120-135（check-dist → chunk-cycles） |
| check:desktop 无 startup-budget | 根 package.json `check:desktop` 链（`check:startup-budget` 脚本存在但未链入） |
| 静态图 1709.3 / catalog 550.5 | 07 / 11 / materials/11 |
| motion 死依赖 | `apps/crish-desktop/package.json:53` + animated-icons import |
| 同步 summarize | `engine.rs:370-371` |
| spawn_blocking 正面对照 | `summary_dispatch.rs:780-793` |
| G8 仅 emergency | `engine.rs:579`；算法 `tool_output.rs:178` |
| 溢出二次 compact | `handlers/stream_error_recover.rs:178-205` |
| CFL-07 / CFL-13 / CFL-06 | review-plans-01 |
| PR-MOTION | 92 §8 会签票 #5 |

---

*D9D10 分维详案完。主控合并/派发时以 92 效果锁与本文件删除面为准；05 不得抢 frontend-build；U-G8 独立验收。*
