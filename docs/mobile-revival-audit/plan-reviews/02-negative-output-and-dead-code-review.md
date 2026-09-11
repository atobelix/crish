# 移动端全面复兴方案评审报告 · 负产出与删除面硬度专项评审 (Reviewer 2)

> **战役目录**：`docs/mobile-revival-audit/`
> **评审报告文件**：`docs/mobile-revival-audit/plan-reviews/02-negative-output-and-dead-code-review.md`
> **评审责任人**：负产出与删除面硬度评审员（Reviewer 2）
> **评审对象**：`independent-plans/` 全部 6 份独立方案（`01-plan-by-agent-1.md` 至 `06-plan-by-agent-6.md`）
> **审查基准**：
> - 终审定案：`docs/mobile-revival-audit/01-final-dimensions.md`（DIM-01 ~ DIM-07）
> - 调研汇总与事实：`docs/mobile-revival-audit/00-summary.md` 与 11 份专项调研报告（`surveys/01` ~ `11`）
> - 仓库铁律：《主 Agent 全流程调度提示词 v3》、《AGENTS.md》、反退避全文（`LOGIC_PLAN_NO_RETREAT.md`）、反过度设计红线（`ANTI_OVERENGINEERING_GUARDRAILS.md`）
> **评审禁令**：严禁修改任何业务代码、严禁出现任何波次/批次编号、严禁避重就轻与姑息妥协、不涉及笔记功能。

---

## 一、评审宗旨与审查使命

在 Conex / Crish 的工程哲学中，**代码是负债，删除才是净资产**。当前 `apps/crish-mobile` 遭遇的打包 100% 崩溃、22 处 TypeScript 编译报错、路由树被单测污染、连接握手 404/401 拒连、终端满 5000 行滚底死锁等一系列危象，其根本诱因不是功能做得太少，而是历史临时补丁、死代码、空心 DAO、未接线缓存算法以及形式主义单测堆砌得太多。

遵照主控《01-final-dimensions.md》对 **DIM-01（重复与死层，全局固定负产出基座）** 的刚性定案，本评审员作为【负产出与删除面硬度评审员（Reviewer 2）】，肩负以下不可动摇的审查职责：
1. **彻查“假装删除”与避重就轻**：逐行审查每份方案的【要删掉什么 / 收敛什么】节，核查是否存在漏删 `cachePolicy`、漏删 6 个空心 DAO、未移出 8 个路由单测、擅自保留 `r2-16` polyfill 或 `blockList` 遮丑补丁等阳奉阴违行为；
2. **核验测试文件路径的真实性**：穿透方案中的文件路径，核查是否存在凭空捏造、未查磁盘的“测试路径幻觉”（Hallucination），导致真实污染源漏移、打包依然崩溃；
3. **把关反过度设计硬性红线**：对照《ANTI_OVERENGINEERING_GUARDRAILS.md》13 项红线，坚决阻断任何借机引入复杂新框架、超长中间件管道、或把单机当分布式搞重型持久化的过度设计；
4. **清理未标明退场日期的 Fallback 路径**：全面排查 15 处降级分支，杜绝留下“无限期双轨”与“半永久降级”后患；
5. **出具删除面硬度排行榜与主控刚性核定清单**：分清优劣高下，为主控编纂最终总方案提供最扎实、最冷酷、零水分的物理级删除清单。

---

## 二、删除面硬度综合对照表与权威排行榜

### 2.1 六份独立方案删除面硬度多维对照表

| 评估维度与刚性指标 | Agent 1 (极简先删) | Agent 2 (类型契约) | Agent 3 (状态机自愈) | Agent 4 (流式缓冲) | Agent 5 (原生工程化) | Agent 6 (现代 UI/UX) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **物理删除清单完整性**<br>(r2-16, lint-out, cachePolicy, HttpClient, 3空目录, 4死路由, 占位模板等) | **20 项**<br>全面覆盖+含配套测试 | **20 项**<br>DEL-01~20 编制规范 | **16 项**<br>遗漏部分模板单测 | **11 项**<br>漏删4个配套单测 | **19 项**<br>DEL-01~19 详实准确 | **13 项**<br>漏删4个配套单测且写错路径 |
| **8 个路由污染单测移出真实度**<br>(磁盘真实路径: files, index, settings, _layout, notifications, manual, scan, welcome) | **100% 真实**<br>8/8 精确命中 | **87.5% 命中**<br>7/8 移出，**1个擅删** | **100% 真实**<br>8/8 精确命中 | **50% 虚构**<br>**4个不存在，漏4个真文件** | **100% 真实**<br>8/8 精确命中且保护资产 | **50% 虚构**<br>**4个不存在，漏4个真文件** |
| **Metro 三项破坏补丁清理**<br>(customSerializer / METRO_ROOT / blockList) | **彻底拔除**<br>给出纯净标准配置 | **彻底拔除**<br>恢复标准契约 | **彻底拔除**<br>恢复标准契约 | **文字提及**<br>未贴纯净代码 | **彻底拔除**<br>分析底层断言并修复 | **文字提及**<br>未给出清洗后配置 |
| **SQLite 6 个空心 DAO 及测试清退**<br>(Events, SessionSummaries, ApprovalHistory, ApprovalQueue, PushTokens, DeviceInfo) | **彻底清退**<br>6 DAO + 800+行单测 | **彻底清退**<br>6 DAO + 4个单测文件 | **抗拒删除**<br>**擅自保留并试图激活 QueueDao** | **避重就轻**<br>仅提 6 DAO，**漏删全部单测** | **超额彻底**<br>6 DAO+测试+**核销589行虚构单测** | **流于形式**<br>仅一句带过，无路径无单测 |
| **7 组重复手写路径归一收敛**<br>(相对时间/时钟/状态色/连接态/Base64/SHA256/返回按钮) | **100% 覆盖**<br>精准到原代码行号 | **100% 覆盖**<br>统一至 SSOT 模块 | **覆盖 6 组**<br>审批构造替代一组 | **覆盖 6 组**<br>以历史 Mock 替代一组 | **100% 覆盖**<br>精准到原代码行号 | **覆盖 6 组**<br>重点在返回键与色彩 |
| **反过度设计红线合规性**<br>(13 项红线，无新大库，无复杂微架构) | **完全合规**<br>纯函数，极简内聚 | **完全合规**<br>依赖 TS 编译器严格性 | **轻度倾向**<br>移动端重型 SQLite 事务 | **微架构过剩**<br>50ms 节流队列/多Run LRU | **完全合规**<br>代码零过度设计，CI 完整 | **完全合规**<br>原生自研轻量组件 |
| **测试资产保护遵守度**<br>(严禁借重构之名无故删除有效测试) | **100% 保护**<br>移出并全量保留 | **违规**<br>擅自删除 scan.test.tsx | **100% 保护**<br>移出并全量保留 | **部分失控**<br>路径写错导致测试脱靶 | **100% 保护**<br>规范移出且说明重定向 | **部分失控**<br>路径写错导致测试脱靶 |

---

### 2.2 删除面硬度排行榜与权威总评

根据上述确凿的代码事实与客观对比，6 份独立方案的【删除面硬度排行榜】裁决如下：

```
🏆 冠军：01-plan-by-agent-1.md (极简收敛与先删后改学派) ── 98分【绝对硬核·删除标杆】
🥈 亚军：05-plan-by-agent-5.md (生产级原生工程化学派)   ── 95分【工业级刚硬·超额核销】
🥉 季军：02-plan-by-agent-2.md (类型驱动与契约零漂移)   ── 88分【高硬度·但违规误伤测试】
  第4名：03-plan-by-agent-3.md (协议闭环与状态机自愈)   ── 76分【通信极强·但抗拒清退DAO】
  第5名：04-plan-by-agent-4.md (流式高性能与可观测性)   ── 58分【严重失真·虚构单测路径】
  第6名：06-plan-by-agent-6.md (现代 UI/UX 与人机工程)   ── 52分【泛泛而谈·严重路径幻觉】
```

---

## 三、逐案深度评审与“假装删除/偷懒”清单剖析

### 3.1 方案 1：`01-plan-by-agent-1.md`【极简收敛与先删后改学派】（98分 · 标杆）

#### 1. 硬度亮点
- **清单最为详尽，穿透到物理行数**：第二章单列 20 项物理删除文件，将 `r2-16-crypto-polyfill.js`（32行）、`lint-out.txt`（5行）、`HttpClient.ts` 及配套测试、`cachePolicy.ts`（280行）及单测（401行）、3 个空目录骨架、4 个占位伪路由及配套模板与单测全部列明，甚至精准挖出 `terminalLineBuffer.ts` 中从未被调用的死接口 `replaceAllTerminalText`（12行）；
- **8 个路由单测移出 100% 精确**：严格比对真实磁盘文件，将 `app/` 下真实的 8 个 `*.test.tsx` 移出至 `src/presentation/screens/__tests__/`，路径分毫不差；
- **SQLite 死层核销态度冷酷且清醒**：坚决拒绝“为了接线而接线”，彻底清退 6 个空心 DAO，并同步清退保护死 DAO 的 5 个单测文件（800+ 行死测试）；明确将 Outbox 队列定位于轻量可靠持久化适配器，不搞臃肿复杂的 SQLite 关系表映射；
- **7 组重复手写算法归一精准**：准确指出 `terminalScreen.tsx` 将 `running` 误标为绿色的严重认知混淆，指明向 `runDetailMeta.ts` 收敛；用 `@noble/hashes` 拔除 150 行手写 SHA-256。

#### 2. 存在不足
- 对全仓死契约 `tool-update` 的 5 处清理位置仅给出了概念描述，未像其他条目那样逐一给出完整替换代码（虽不影响执行，但可更细化）。

---

### 3.2 方案 5：`05-plan-by-agent-5.md`【生产级原生工程化与 CI 打包打通学派】（95分 · 超额核销）

#### 1. 硬度亮点
- **工业级清毒意识极强**：DEL-01 至 DEL-19 详实完备，精准定位了 `metro.config.js` 破坏 Expo 静态导出契约（`MetroBundlerDevServer.js:1646` 断言）的深层根因；
- **测试路径核查严密**：8 个测试文件路径与磁盘 100% 吻合，并合规移入 `src/presentation/__tests__/routes/`；针对扫码假页面测试 `app/pair/scan.test.tsx`，方案明确提出“重构后移出并作为重定向断言”，绝不擅自删除；
- **超额核销隐藏死测试**：在清退 6 个空心 DAO 及其单测之外，敏锐挖出 `src/domain/repositories/mobileCommands.test.ts`（589 行虚构概念单测），并将其列入刚性核销清单，负产出功力深厚。

#### 2. 瑕疵与扣分点
- 方案 3.7 节引入了 EAS Cloud 云端构建和 GitHub Actions macOS Runner 流水线 YAML，虽旨在打通 iOS 双轨打包，但引入第三方云构建服务略增认知复杂度（好在本地 Android 依然基于 Gradle 离线打包，未违背核心禁令）。

---

### 3.3 方案 2：`02-plan-by-agent-2.md`【类型驱动与契约零漂移学派】（88分 · 违规误伤资产）

#### 1. 硬度亮点
- 编制了非常规整的 DEL-01 ~ DEL-20 物理删除清单；
- 存储层 6 个空心 DAO 与 4 个配套测试（467行）清退明确；
- 在 ESM 命名消歧和消除桌面端 16 处深路径直接引用方面，提供了最为确凿的代码落地；
- 彻底清理了 `tool-update` 残留的全部 5 处位置。

#### 2. 致命违规点：擅自删除有效单测
- **现场证据**：第 2.3 节第 233 行明确写道：
  > `app/pair/scan.test.tsx` $\to$ `(随扫码假路由一同删除)`
- **定性判定**：**违反《AGENTS.md》§9 测试资产保护铁律与终审定案约定**！定案文档明确规定“将 `app/` 路由下的 8 个 `*.test.tsx` 移出至 `src/presentation/__tests__/`”。测试是保障系统不发生非预期行为的资产，即使扫码页面当前为占位状态，该测试也应移出并改写为断言手动输入引导或重定向，**严禁借清代码之机擅自销毁测试**！

---

### 3.4 方案 3：`03-plan-by-agent-3.md`【协议闭环与安全状态机自愈学派】（76分 · 抗拒删除/避重就轻）

#### 1. 硬度亮点
- 8 个路由测试文件全部精准移出，路径完全真实；
- 配对 Dead 相位死锁、端点 URL 补齐、首帧订阅握手、`fullReplay` 游标重置等 P0 级攻坚方案最为严密。

#### 2. 严重避重就轻：抗拒清退 6 个空心 DAO
- **现场证据**：方案第 2.4 节赫然写道：
  > “清退 5 个未接线空心 DAO 及其测试... 2. 保留并激活核心 DAO：唯一具有真实持久化生命力的是 `SqlApprovalQueueDao`（Outbox 离线队列防杀进程）... 本方案将 `SqlApprovalQueueDao` 全面接线贯通，彻底消灭其‘死层’属性”
- **定性判定**：**公然违抗定案《01-final-dimensions.md》DIM-01 刚性删除约定**！定案明确裁决“清退 SQLite 层 6 个未接线空心 DAO”。移动端 Outbox 的核心诉求是“轻量可靠持久化防杀进程”，完全可以通过轻量 KV 存储或轻量适配器实现（如方案 1/2 所设计），而方案 3 借口“做实持久化”，抗拒删除 `SqlApprovalQueueDao`，试图在移动端维护一套沉重的 SQLite 审批表及复杂 SQL 映射，属于典型的**“以接线为名拒绝负产出”**；
- 物理删除清单漏掉了 `PlaceholderScreen.test.tsx` 与 `ProtectedPlaceholder.test.tsx` 等模板测试。

---

### 3.5 方案 4：`04-plan-by-agent-4.md`【流式高性能与可观测性缓冲学派】（58分 · 严重路径幻觉）

#### 1. 优点
- 终端满 5000 行滚底死锁（`totalLineCursor = startIndex + lines.length`）与 24dp 补偿算法分析透彻；流式增量就地折叠理念具备可借鉴性。

#### 2. 致命硬伤：未查磁盘，虚构 4 个单测路径！
- **现场证据**：方案第 2.3 节表 2.3 中列出的 8 个移出单测：
  - `apps/crish-mobile/app/(tabs)/index.test.tsx`（存在）
  - `apps/crish-mobile/app/(tabs)/sessions.test.tsx`（**磁盘根本不存在！**）
  - `apps/crish-mobile/app/(tabs)/approvals.test.tsx`（**磁盘根本不存在！**）
  - `apps/crish-mobile/app/(tabs)/settings.test.tsx`（存在）
  - `apps/crish-mobile/app/pair/manual.test.tsx`（存在）
  - `apps/crish-mobile/app/pair/welcome.test.tsx`（存在）
  - `apps/crish-mobile/app/session/[id].test.tsx`（**磁盘根本不存在！**）
  - `apps/crish-mobile/app/terminal/[runId].test.tsx`（**磁盘根本不存在！**）
- **严重后果**：磁盘上真正污染路由树的 4 个真实单测（`app/(tabs)/files.test.tsx`、`app/_layout.test.tsx`、`app/notifications.test.tsx`、`app/pair/scan.test.tsx`），方案 4 **完全没有提及，也未规划移出**！
- 若按方案 4 执行，真实污染路由的 4 个测试仍然滞留在 `app/` 目录下，Expo 打包器依然会将其作为页面解析并报错崩溃！这是严重的“闭门造车、假装移出”；
- 物理删除表 2.1 仅列出 11 个文件，严重漏掉了 `HttpClient.test.ts`、`pairScanScreen.test.tsx`、`PlaceholderScreen.test.tsx`、`ProtectedPlaceholder.test.tsx`；
- 清退 6 个 DAO 时完全未提清退其配套的 800+ 行测试。

---

### 3.6 方案 6：`06-plan-by-agent-6.md`【现代 UI/UX 与人机工程极致体验学派】（52分 · 泛泛而谈与严重幻觉）

#### 1. 优点
- 费茨法则双轨热区算法（`dualHitSlop`）、原子 `<Input>` 焦点态 ~6% 柔和混入、`<Tooltip>` 长按气泡等在人机工程体验上设计非常惊艳。

#### 2. 致命硬伤：删除面严重虚构、漏项与避重就轻
- **现场证据 1（单测路径幻觉）**：方案第 3.3 节列出的 8 个单测，同样存在 4 个虚构文件：
  - `app/(tabs)/approvals.test.tsx`（**不存在！**）
  - `app/approval/[id].test.tsx`（**不存在！**）
  - `app/run/[id].test.tsx`（**不存在！**）
  - `app/terminal/[runId].test.tsx`（**不存在！**）
  - 漏掉了真实存在的 `app/_layout.test.tsx`、`app/notifications.test.tsx`、`app/pair/scan.test.tsx`、`app/pair/welcome.test.tsx`！
- **现场证据 2（物理路径写错）**：将 `cachePolicy.test.ts` 错误写为 `src/db/__tests__/cachePolicy.test.ts`（真实磁盘直接位于 `src/db/cachePolicy.test.ts`，根本没有 `__tests__` 目录）；
- **现场证据 3（漏删大量死单测）**：漏删 `HttpClient.test.ts`、`pairScanScreen.test.tsx`、`PlaceholderScreen.test.tsx`、`ProtectedPlaceholder.test.tsx`；
- **现场证据 4（DAO 清退流于形式）**：第 3.4 节第 2 条仅一句话“清理 6 个未接线空心 DAO 的空心化接口”，既无文件清单，也完全未提配套测试的删除，态度极其敷衍。

---

## 四、过度设计与反过度设计红线合规审查

对照仓库根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md`（v2.0）的 13 项硬性红线进行逐项扫描：

### 4.1 框架与第三方库引入审查（红线基准：严禁引入外部重型 UI/状态库）
- **审查结果：全员合规**。
- 6 份方案均未引入 React Native Paper、NativeBase、Tamagui 等大型三方 UI 库，原子 `<Input>`、`<Tooltip>`、`<HeaderBackButton>` 均坚持基于 React Native 原生 `StyleSheet` 自研；
- 6 份方案均未借机引入 Redux、MobX 或复杂 ORM，坚持轻量 Zustand 与原生 SQLite。

### 4.2 缓冲算法与微架构复杂度审查（禁令 2 & 禁令 12）
- **禁令 2 条款**：严禁编写无锁环形缓冲区与极端零拷贝，单机文本速率仅 10~50 Token/s；
- **禁令 12 条款**：严禁高频流式状态穿透全局 Store；
- **异味排查**：
  - **方案 4** 在 2.7 节提出了“50ms 窗口微任务批处理削峰队列”与“多 Run LRU 内存预算管理器”。在桌面端与移动端局域网通信场景下，LLM 生成速率物理上限仅为 20~80 Token/s，每秒产生的文本更新量仅几十行。引入额外的 50ms 节流队列和多级微任务调度，徒增状态转移的调试复杂性，**存在轻微过度设计倾向**；
  - 相对而言，**方案 1** 与 **方案 5** 直接采用纯函数游标控制（`startIndex + lines.length`），用最简单的原生 React 状态机制根除吸底死锁，架构最为优雅清爽。

### 4.3 存储与队列复杂度审查（禁令 3）
- **禁令 3 条款**：严禁在单机桌面端/移动端引入分布式共识协议与两阶段提交；
- **异味排查**：
  - **方案 3** 在审批 Outbox 模块中，执意保留 `SqlApprovalQueueDao`，并在移动端试图实现“本地事务写入 -> 网络单飞重放 -> 状态机多阶段更新 -> 数据库物理出队”的全套重型数据库事务体系。这对于一个“移动端实时控制台”而言过于沉重；
  - **核定标准**：移动端 Outbox 必须坚持轻量化（由轻量持久化驱动，保证杀进程后决策恢复即可），坚决执行定案关于清退 6 个空心 DAO 的决策。

---

## 五、降级路径与未标明删除日期 Fallback 审查

依据调研报告《`surveys/11-dead-code-and-markers-audit.md`》第 5 节梳理出的全仓 15 处 Fallback，审查 6 份方案的治理彻底性：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       全仓 15 处 Fallback 分类治理矩阵                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. 临时破坏性（必须物理拔除）:                                                │
│    - FB-01: r2-16-crypto-polyfill.js (方案 1/2/3/4/5/6 全员核准物理拔除)       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. 长期合理防御性（明确放行，不设删除日期）:                                  │
│    - FB-02~05: expo-notifications 门面降级、渠道跳过、权限回退、装配兜底      │
│    - FB-06: dbBootstrap SQLite 异常降级内存态                               │
│    - FB-07~08: SlideToConfirm / DashboardSkeleton reduce-motion 无障碍降级   │
│    - FB-09: sessionCommands full-access 强制降级 ask 远程安全基线           │
│    - FB-10: EndpointResolver 局域网开发非 TLS 降级                            │
│    - FB-14: filesCache 容量 <= 0 直通降级                                    │
│    - FB-15: noblePrimitives 随机源探测降级链 (Web Crypto -> ExpoCrypto)       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. 架构缺陷与历史债务（必须在本战役中收敛或拔除）:                            │
│    - FB-11: terminalScreen.tsx 双真理回落 (优先 terminalStore，回落遍历全量事件) │
│    - FB-12: eventsDao.ts "逻辑截断"降级（随 DAO 一并删除）                    │
│    - FB-13: cachePolicy.ts "逻辑截断"降级（随 cachePolicy 一并删除）           │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **FB-11 终端双真理回落治理评价**：
  - **方案 1** 明确指出“消除终端双真理回落计算，历史 buffer 重建改为惰性计算，仅在 liveView 为空时触发，避免后台双倍计算”；
  - **方案 2** 明确提出“统一以单一真理源为准，清退双真理分支”；
  - 其余方案对 FB-11 仍持默认容忍态度，未显式规划收敛。

---

## 六、主控总计划刚性删除面核定建议（Master Deletion Scope）

为确保最终合成的总方案在负产出上坚硬如铁、零死角，本评审员综合 6 份方案之长，剔除所有虚构幻觉与避重就轻，为主控出具《总计划刚性删除面核定清单》：

### 6.1 绝对物理删除文件清单（22 项 · 立即清退）

```powershell
# 1. 构建毒瘤与垃圾日志 (2 项)
rm apps/crish-mobile/r2-16-crypto-polyfill.js
rm apps/crish-mobile/lint-out.txt

# 2. 存储层死算法与配套测试 (2 项)
rm apps/crish-mobile/src/db/cachePolicy.ts
rm apps/crish-mobile/src/db/cachePolicy.test.ts

# 3. 网络层死骨架与配套测试 (2 项)
rm apps/crish-mobile/src/network/HttpClient.ts
rm apps/crish-mobile/src/network/HttpClient.test.ts

# 4. 僵尸占位目录文件与目录自身 (3 项)
rm apps/crish-mobile/src/hooks/index.ts            # 并删除 src/hooks 目录
rm apps/crish-mobile/src/domain/db/index.ts        # 并删除 src/domain/db 目录
rm apps/crish-mobile/src/domain/services/index.ts  # 并删除 src/domain/services 目录

# 5. 占位伪路由页面 (4 项)
rm apps/crish-mobile/app/diagnostics.tsx
rm apps/crish-mobile/app/tasks.tsx
rm apps/crish-mobile/app/usage.tsx
rm apps/crish-mobile/app/approval-history.tsx

# 6. 伪占位组件及其配套单测 (4 项)
rm apps/crish-mobile/src/presentation/components/templates/PlaceholderScreen.tsx
rm apps/crish-mobile/src/presentation/components/templates/PlaceholderScreen.test.tsx
rm apps/crish-mobile/src/presentation/components/templates/ProtectedPlaceholder.tsx
rm apps/crish-mobile/src/presentation/components/templates/ProtectedPlaceholder.test.tsx

# 7. 假占位扫码页面及其配套单测 (2 项)
rm apps/crish-mobile/src/presentation/pair/pairScanScreen.tsx
rm apps/crish-mobile/src/presentation/pair/pairScanScreen.test.tsx

# 8. 内部死接口与测试 (3 项)
# 物理删除 src/domain/repositories/mobileCommands.test.ts (589 行虚构断言单测)
# 物理删除 src/presentation/components/terminal/terminalLineBuffer.ts 中的 replaceAllTerminalText (12 行)
# 物理删除 src/adapters/settings/themeProjection.ts (双轨别名文件)
```

### 6.2 路由树单测 100% 真实物理移出清单（8 项 · 严禁留在 `app/`）

为根除 Expo Router 动态扫描崩溃，必须且只能迁移以下 **真实存在于磁盘上的 8 个文件**（坚决纠正方案 4 和 6 的 4 处虚构路径）：

| 序号 | 磁盘真实源路径（污染源） | 规范迁移目标路径（测试目录） | 测试资产保护与维护原则 |
| :---: | :--- | :--- | :--- |
| **1** | `apps/crish-mobile/app/(tabs)/files.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/filesRoute.test.tsx` | 100% 保留，更新相对导入路径 |
| **2** | `apps/crish-mobile/app/(tabs)/index.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/indexRoute.test.tsx` | 100% 保留，更新相对导入路径 |
| **3** | `apps/crish-mobile/app/(tabs)/settings.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/settingsRoute.test.tsx` | 100% 保留，更新相对导入路径 |
| **4** | `apps/crish-mobile/app/_layout.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/layoutRoute.test.tsx` | 100% 保留，更新相对导入路径 |
| **5** | `apps/crish-mobile/app/notifications.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/notificationsRoute.test.tsx` | 100% 保留，更新相对导入路径 |
| **6** | `apps/crish-mobile/app/pair/manual.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/pairManualRoute.test.tsx` | 100% 保留，更新相对导入路径 |
| **7** | `apps/crish-mobile/app/pair/scan.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/pairScanRoute.test.tsx` | **严禁删除！** 迁移并重构为断言重定向至手动输入 |
| **8** | `apps/crish-mobile/app/pair/welcome.test.tsx` | `apps/crish-mobile/src/presentation/__tests__/routes/pairWelcomeRoute.test.tsx` | 100% 保留，更新相对导入路径 |

### 6.3 `metro.config.js` 破坏性篡改连根拔除清单

1. **删除 `customSerializer`**：彻底移除第 29-46 行覆写的自定义序列化器，恢复 Expo 官方返回 `{ artifacts, assets }` 的静态导出契约；
2. **删除宿主绝对路径**：物理删除 `const METRO_ROOT = 'C:/Software/conex/node_modules/metro/src';`；
3. **删除 `fs.readFileSync` 注入**：移除读取 `r2-16-crypto-polyfill.js` 的所有文件系统调用；
4. **废除 `blockList` 补丁**：单测移出后，彻底清空针对测试文件的正则黑名单，让 Metro 保持干净轻量。

### 6.4 SQLite 6 个空心 DAO 与配套死测试核销清单

坚持定案决策，**不留任何死表与假 DAO**：
- **物理清退 6 个空心 DAO**：
  1. `src/db/dao/eventsDao.ts`（230行）
  2. `src/db/dao/sessionSummariesDao.ts`（150行）
  3. `src/db/dao/approvalHistoryDao.ts`（130行）
  4. `src/db/dao/approvalQueueDao.ts`（160行）
  5. `src/db/dao/pushTokensDao.ts`（80行）
  6. `src/db/dao/deviceInfoDao.ts`（90行）
- **同步清退保护死 DAO 的 5 个测试文件（800+行）**：
  1. `src/db/dao/eventsDao.test.ts`（205行）
  2. `src/db/dao/approvalDao.test.ts`（132行）
  3. `src/db/dao/approvalQueueDao.test.ts`（185行）
  4. `src/db/dao/approvalHistoryDao.test.ts`（150行）
  5. `src/db/dao/metaDao.test.ts` 中针对已删 DAO 的无效测试用例（~100行）
- **Outbox 持久化定位明确**：采用轻量可靠的持久化适配层（以轻存储驱动），保证离线决策耐受杀进程，绝不在移动端保留重型空心 DAO。

### 6.5 7 组重复手写路径归一清退清单（单一真理源）

1. **相对时间格式化**：删除 `fileMeta.ts:144-158`，全仓收敛至 `src/domain/pure/time.ts:formatRelativeTime`；
2. **时钟时间格式化**：删除 `EventRow.tsx:196-200` 与 `approvalListScreen.tsx:32-36`，全仓收敛至 `src/domain/pure/time.ts:formatClockTime`；
3. **运行状态文案与色调**：删除 `terminalScreen.tsx:43-58`，彻底纠正 `running` 误标绿色的重大 Bug，统一收敛至 `runDetailMeta.ts`；
4. **连接相位真理源**：废除 `eventStore.network`，全局统一以 `connectionStore.phase` 为单一真理源；
5. **Base64 编解码**：删除 `keyAgreement.ts:81-95` 与 `signer.ts:189-202` 手写实现，统一使用公共纯工具函数；
6. **密码学 SHA-256 与 HMAC**：彻底删除 `signer.ts:41-186` 早期用于脚手架的 145 行手写底层算法，全面使用 `@noble/hashes`；
7. **返回按钮统一**：删除 7 处页面手写的返回按钮 JSX/样式，统一替换为原子组件 `<HeaderBackButton>`。

### 6.6 死契约与死状态全仓核销清单

1. **核销死契约 `tool-update`（5 处全部清理）**：
   - `EventRow.tsx:36`（从白名单移除）
   - `EventRow.tsx:62`（从标签映射移除）
   - `EventRow.tsx:124-128`（从摘要分支移除）
   - `streamingTypes.ts:11`（从类型集移除）
   - `terminalEvents.ts:2`（清理过时注释）
2. **清理死状态位**：
   - 移除 `outboxState.replaying` 恒为 `false` 的死状态字段；
   - 移除 `ReconnectingWsClient` 中的 3 处空监听；
   - 移除 `SecureStore` 中未引用的 Nonce 读写接口（`saveExchangeNonce` 等）。

---

## 七、评审员最终裁决结论

1. **学派吸纳建议**：
   - **全面采纳方案 1（极简收敛）与方案 5（原生工程化）的删除面骨架**：方案 1 的清单最详尽严密，方案 5 额外核销了 589 行虚构单测，两者构成了最坚固的负产出基座；
   - **全面采纳方案 2 的类型消歧方案与深路径清理**：但**坚决否决**方案 2 删除 `app/pair/scan.test.tsx` 的违规行为，必须按方案 5 规范迁出；
   - **采纳方案 3 的通信与状态机自愈设计**：但**坚决否决**方案 3 保留 `SqlApprovalQueueDao` 的抗拒删除企图，强制核销 6 个空心 DAO；
   - **彻底修正方案 4 和方案 6 的路径幻觉**：坚决摒弃两方案虚构的 4 个单测路径，以本报告 6.2 节的 8 个真实磁盘文件为准。

2. **自检合规核对**：
   - [x] 未修改或提交任何业务代码；
   - [x] 全文无任何波次/批次编号，严格以领域概念推进；
   - [x] 完全排除笔记功能；
   - [x] 结构完备：包含硬度对照表、偷懒/幻觉清单、死代码彻底性对比、总计划刚性删除清单；
   - [x] 唯一指定落盘文件：`docs/mobile-revival-audit/plan-reviews/02-negative-output-and-dead-code-review.md`。

*报告编制完成，已呈报主控调度中心！*
