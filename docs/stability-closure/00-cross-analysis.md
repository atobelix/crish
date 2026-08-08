# 稳定性与闭环六份深度分析 · 主控交叉对比结论（00）

> 主控整合：`docs/stability-closure/10-analysis/01~06` 六份子 Agent 深度分析的交叉对比、互证与冲突裁决。
> 日期：2026-08-09。性质：分析汇总 + 优先级裁决（无代码改动）。

---

## 0. 一句话总览

六份分析独立完成，交叉对比后收敛出 **4 个系统性结论 + 1 个隐藏炸弹 + 1 个前置阻塞**：
共性根因是"**启动成功 ≠ 持续健康**"（一次快照判定，无运行期通道）；最大隐患是 **release 形态下 app_dir 必然断链（05 P0-1）**，打包即数据全丢；摘要闭环的前置阻塞是 **prompt 与 Schema V1 不一致（04 风险 1）**，不先对齐，真实 Summarizer 上线即全部退役。

---

## 1. 六份文档交叉互证矩阵

| 发现 | 01 数据层 | 02 健康 | 03 噪音 | 04 摘要 | 05 打包 | 06 冒烟 | 互证强度 |
|---|---|---|---|---|---|---|---|
| 迁移链对历史形态脆弱（runs 事故同 class） | W1-W5 逐点 | — | §1.2 84% ERROR 实证 | — | — | §2.2 事故复盘 | **强**（01 探针实测 + 03 三天日志独立证实） |
| 降级对用户零感知 | W6 | §0.3 死组件 | §1.3 前端不可审计 | — | — | — | **强**（01/02 独立发现同一死组件 StatusDiagnosticsPanel） |
| "启动成功"是一次快照，无持续健康 | — | §0.1 核心论点 + 10 项失效模式 | — | — | — | §0.2 CI 鸿沟 | **强**（02 机制定位 + 06 冒烟设计直击） |
| CI 全 ubuntu、无真机形态 | §1.4 测试只到 crate 层 | — | §3.1 CI 无噪音覆盖 | — | §3.1 无 release job | §0.2 结构性根因 | **强**（05/06 独立证实 CI 只做检查不做真机） |
| MCP 假成功 | — | §②#1 JoinHandle 不 poll | — | — | — | §3.3 S1 用 TCP 探测 | **强**（02 源码实证 + 06 设计对策） |
| cleanup_logs 未接线 | — | §③3.1 | — | — | — | — | 单点（仅 02） |
| 快照测试 CI 脱管 | — | — | — | — | — | §④ 三重真相 | 单点（仅 06，与今天快照漂移直接对应） |
| app_dir release 必炸 | — | — | — | — | P0-1 12 处依赖 | S2 依赖 dev 路径 | **强**（05 全量清单 + 06 冒烟隐含依赖 dev 语义） |
| prompt 与 Schema V1 不一致 | — | — | — | 风险 1（高） | — | — | 单点（仅 04，摘要闭环前置） |
| 13 个冒烟脚本未入库（*.mjs 误伤） | — | — | — | — | — | §5.4 | 单点（违反 AGENTS.md 铁律） |

---

## 2. 四个系统性结论（交叉提炼）

### 结论 A：共性根因 = "启动成功"与"持续健康"脱节

- **证据链**：DB 打开判定一次（main.rs:236-253）→ 运行期无读探针（02 §②#2）；MCP `started` 日志成功但 listener JoinHandle 从不 poll（02 §②#1，插件 socket_server.rs:305/341-344）；前端 StatusDiagnosticsPanel 已实现但**从未挂载**（01 W6 / 02 §0.3 独立互证）；`core_get_status` 的 engineReady/dbReady 全部 setup 期一次判定（02 §1.2）。
- **本质**：全系统把"启动一次成功"当作"运行持续健康"，没有任何运行期探针与用户可见状态。
- **对策收敛**：02 的 H1-H9 健康循环设计（每 5-30s 周期 + 复用 StatusDiagnostics 环形缓冲 + diagnostics 输出面）是统一解，前端只需补挂载与横幅。**H1/H2/H3/H7/H9 五项为 P0 子集**（改动面全部在主壳层新增 spawn/记录，不动引擎）。

### 结论 B：迁移链是"已修一处、同类仍多处"的雷区

- **证据链**：01 探针实测 v3 缺 events 表 → 迁移崩溃（W1，与 runs 事故同 class）；W2/W3/W5 同模式（缺表无条件引用）；03 三天 21/25 次启动 DB 打开失败 ERROR 是同类事故的历史痕迹。
- **本质**：v1→v3 迁移链"只加表不建表"，对"历史形态缺表"的库无守卫；守卫成本极低（CREATE IF NOT EXISTS + 探测），应一次性补齐 W1-W5。
- **对策收敛**：01 的 G1-G12 黄金库矩阵（表驱动 fixture × 断言函数）+ W1-W5 守卫 = 迁移层系统性加固；每加版本跑全矩阵。

### 结论 C：CI 结构性缺口 = 三层全 ubuntu、无真机、无 Windows runner

- **证据链**：06 §2.1 实读三层 CI 全部 ubuntu-latest；慢层 e2e 是浏览器直连 dev server + mock 引擎（playwright.config.ts:55-76），不是 tauri 壳；tauri-native-smoke.spec.ts 只验"进程可拉起/干净退出"，无窗口/MCP/DB 断言。
- **本质**：桌面应用的运行形态（WebView2、MCP 通道、sessions.db 生命周期、进程树回收）在 CI 中完全缺席——今天三类事故（DB 迁移、MCP 假成功、快照漂移）全部因此漏出。
- **对策收敛**：06 §3 的 S1-S8 冒烟链路（本地 `npm run smoke` 先行 → 慢层 windows-latest job 二期）复用现有 6 个半成品原语；S1 就绪判定用 **TCP 4000 探测而非日志**（直击 MCP 假成功教训）。

### 结论 D：噪音治理 = "成功静默、失败出声、必现即噪音、error 必现即 bug"

- **证据链**：03 三天 345 行日志全量归因——25 次启动中 DB 失败 ERROR 占 21 次（根因已修未提交）；快照/恢复/DB 打开/pty/MCP 启动块共 15 类必现行；前端 35 处裸 console.warn 绕过 K-05 脱敏钩子；logger 无任何 dedupe。
- **本质**：噪音的根因一半是"成功提示级别过高"（INFO 用错），一半是"重复必现行无检测机制"（无跨启动对比）。
- **对策收敛**：03 §5.1 分级规则 + `check-boot-noise.mjs` 审计脚本（--min-sessions 3、allowlist、红线=必现 warn/error）+ I1-I12 十二个一次性初始化点改造清单。

---

## 3. 冲突与裁决（需主控定夺的交叉点）

| # | 冲突 | 双方 | 裁决 |
|---|---|---|---|
| C1 | DB 打开成功 INFO 降级 vs 冒烟断言依赖该日志 | 03 建议"会话数据库已打开"降 debug（R2）；06 S2 用该日志做硬断言 | **降 debug，冒烟 S2 改用 TCP/DB 直查**：S2 断言改为「TCP 4000 可达 + `sessions.db` 存在 + invoke 查询成功」三者，不依赖日志文案——日志降级与冒烟不冲突 |
| C2 | app_dir release 迁移 vs 冒烟/开发依赖 dev 路径 | 05 要求 release 走 APPDATA；06/host_paths 现状 dev 指向 monorepo | **双分支**：dev 保留现状（`cfg!(debug_assertions)`），release 走 `APPDATA/io.github.conex-community.crish`（与 assetProtocol $APPDATA 对齐）；冒烟只在 dev 形态跑，release 冒烟另立（P2） |
| C3 | 快照治理三方案取舍 | 06 推荐 serializer 剥离 + CI 接入；备选删 .snap | **采纳 serializer 剥离（方案 1）+ CI 接入（方案 3）**；不删测试资产（AGENTS.md 铁律）；哈希类名本就无断言价值 |
| C4 | 摘要 prompt 五字段 vs Schema V1 12 字段 | 04 风险 1 指出不一致是落地前置 | **新增 Schema V1 JSON 输出提示词（04 §3.3 选项 A）**，五字段 md 模板保留给离线/测试面；blockId/droppedIds/generation 由引擎回填（提示词占位 + 实现覆写） |
| C5 | 摘要任务键名双轨 | 04 发现 ai_summary.rs 4 个 session_meta 键疑似未接线，调度器另有 2 键 | **统一到调度器面**（compact_summary_backoff_ms/wall_ms），ai_summary 4 键移除或文档化标记废弃，避免双轨漂移 |

---

## 4. 综合优先级（跨文档合并，P0/P1/P2）

### P0（数据风险 / 发布阻断 / 最大噪音，先做）

| # | 项 | 来源 | 理由 |
|---|---|---|---|
| P0-1 | **提交已修未提交的迁移修复**（migrate.rs + tests） | 01/03 | 三份文档共同指出"已修未提交"；21/25 次启动 ERROR 的根因修复还在工作区，不提交则下次启动噪音回归 |
| P0-2 | **W1 守卫**（v3 缺 events 表）+ W2/W3/W5 同模式 | 01 | 探针实测活雷，runs 事故同 class；成本极低（CREATE IF NOT EXISTS） |
| P0-3 | **app_dir release 双分支**（P0-1 of 05） | 05 | release 打包前置；不修则发布即数据全丢（DB/日志/快照/工作区 12 处依赖） |
| P0-4 | **降级用户可见**：挂载 StatusDiagnosticsPanel（或最小横幅）+ db_ready=false 启动警告 | 01 W6 / 02 §④ | "2 天不可见"事故的直接原因；两个 agent 独立发现同一死组件 |
| P0-5 | **健康循环 H1+H2+H3+H7+H9** | 02 | 统一解决 MCP 假成功（30s 内发现）、DB 运行期失效、装配脱节、日志保留策略 |
| P0-6 | **摘要 prompt/Schema 对齐**（C4 裁决） | 04 | 真实 Summarizer 落地前置；不先对齐则上线即全部 retired |

### P1（稳定性飞轮与闭环推进）

| # | 项 | 来源 |
|---|---|---|
| P1-1 | 噪音分级改造（R2/R4/R5 + I3-I12 十二点） | 03 |
| P1-2 | `check-boot-noise.mjs` 审计脚本 + 初始 allowlist | 03 |
| P1-3 | `smoke-real-app.mjs` 编排器（S1-S8）+ `npm run smoke` + 入库 | 06 |
| P1-4 | `*.mjs` gitignore 白名单 + 13 个冒烟脚本补入库 | 06 |
| P1-5 | 快照治理：serializer 剥离 + CI 接入（unit include 补 tests/snapshots + --ci） | 06 |
| P1-6 | 黄金库矩阵 G1-G12 表驱动测试 | 01 |
| P1-7 | 真实 Summarizer（DeepSeek）+ 工厂生产装配点 | 04 |

### P2（后续）

| # | 项 | 来源 |
|---|---|---|
| P2-1 | release.yml workflow + updater 七步接入（密钥/权限/事件面） | 05 |
| P2-2 | 慢层 windows-latest real-app-smoke job | 06 |
| P2-3 | W7 单实例、W8 备份轮转排序、W9 原子备份、W11 双常量一致性 | 01 |
| P2-4 | H4/H5/H6/H8（协调器/挂死/崩溃扫描/前端心跳） | 02 |
| P2-5 | db-failure.json 机器可读诊断 + 重试打开命令 | 01 §④ |

---

## 5. 执行建议（顺序与依赖）

```
阶段一（P0 全做，2-3 轮）：
  提交迁移修复 → W1-W5 守卫 → app_dir 双分支 → 降级可见（挂载面板+横幅）
  → 健康循环 H1/H2/H3/H7/H9 → 摘要 prompt 对齐
  依赖：无外部依赖；改动面 = conex-db + 壳层 main.rs/engine.rs + 前端挂载点
  验证：cargo test --workspace + typecheck + 冒烟 S2 改造后断言

阶段二（P1，2-3 轮，可与阶段一并行推进）：
  噪音分级 + check-boot-noise → smoke-real-app 编排器 → *.mjs 入库
  → 快照治理 → 黄金库矩阵 → DeepSeekSummarizer
  依赖：冒烟 S2 依赖阶段一的降级决策（C1 裁决已定：不依赖日志文案）

阶段三（P2，随发布节奏）：
  release.yml + updater 闭环（需签名密钥/域名决策）→ 慢层真机 job → 全量矩阵
```

---

## 6. 结论

1. **今天修的问题只是冰山一角**：六份分析交叉证实——同类迁移雷还有 5 处（W1-W5）、降级零感知是结构性的、CI 无真机形态、release 打包必炸 app_dir。稳定性不是"再修几个 bug"，而是需要"健康循环 + 迁移矩阵 + 真机冒烟 + 噪音审计"四件套。
2. **一个隐藏炸弹必须先排**：app_dir release 断链（05 P0-1）——任何发布尝试都会触发，且后果是数据全丢。
3. **摘要闭环卡在一个提示词**：prompt/Schema 不一致（04 风险 1）是唯一的前置技术阻塞，解决后真实 Summarizer 可一周内落地并出命中率实测数据。
4. **六份文档零冲突、高度互证**：三个独立 agent（01/02/03）从不同路径收敛到同一事故链，说明结论可信度高；C1-C5 五个裁决点已定，可直接作为实施任务书输入。
