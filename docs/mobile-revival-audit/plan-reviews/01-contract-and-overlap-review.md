# 移动端全面复兴与打包打通 · 架构契约与路径冲突评审报告 (01-contract-and-overlap-review.md)
## —— 评审员 1 (Reviewer 1)：架构契约与路径冲突评审专员

> **评审角色**：架构契约与路径冲突评审员（Reviewer 1）
> **归属战役**：移动端全面复兴与打包打通审计战役 (`docs/mobile-revival-audit/`)
> **报告路径**：`docs/mobile-revival-audit/plan-reviews/01-contract-and-overlap-review.md`
> **评审依据**：
> - 终审定案文档：[`docs/mobile-revival-audit/01-final-dimensions.md`](file:///c:/Software/conex/docs/mobile-revival-audit/01-final-dimensions.md) (DIM-01 ~ DIM-07)
> - 调研汇总索引：[`docs/mobile-revival-audit/00-summary.md`](file:///c:/Software/conex/docs/mobile-revival-audit/00-summary.md)
> - 11 份专项调研：`docs/mobile-revival-audit/surveys/01` ~ `11`
> - 6 份独立方案：`docs/mobile-revival-audit/independent-plans/01-plan-by-agent-1.md` 至 `06-plan-by-agent-6.md`
> - 协作纪律规范：《主 Agent 全流程调度提示词 v3》、《AGENTS.md》通用协作与反退避纪律、反过度设计红线 (`ANTI_OVERENGINEERING_GUARDRAILS.md`)
> **评审纪律禁令**：本轮为纯方案评审阶段，严禁修改任何业务代码；**严禁出现任何波次/批次编号**；完全不涉及笔记功能；严格以单一真理源 (SSOT) 与架构契约为准绳。

---

## 目录

1. [评审定位、核心资产与审查基准](#一评审定位核心资产与审查基准)
2. [6 份独立方案全景横向交叉对比表](#二6-份独立方案全景横向交叉对比表)
3. [路径重叠与多轨漂移深度排查详单（SSOT 贯彻性审查）](#三路径重叠与多轨漂移深度排查详单ssot-贯彻性审查)
   - 3.1 时间格式化收敛路径冲突（`time.ts` vs `encoding.ts` vs 零散工具）
   - 3.2 密码学哈希与签名造轮子收敛（`noblePrimitives` vs `@noble/hashes` vs 手写实现）
   - 3.3 返回按钮统一收敛（`HeaderBackButton` 组件路径与双轨热区规范）
   - 3.4 WebSocket URL 构造与鉴权路径（`resolveWsUrl` 纯函数 vs 环境变量注入）
   - 3.5 Outbox 队列持久化实现路线根本冲突（SQLite `SqlApprovalQueueDao` 复活 vs 轻量持久化适配器）
   - 3.6 终端 5000 行吸底滚底游标依赖冲突（标量游标 vs 数组长度 vs 内容哈希）
   - 3.7 FlatList 24dp 坐标错位修复方案的隐蔽逻辑 Bug（条件补偿 vs 无条件硬编码）
   - 3.8 测试文件移出目标目录路径分歧（`routes/` vs `app/` vs 扁平化）
4. [跨端协议契约与类型漂移风险深度审计](#四跨端协议契约与类型漂移风险深度审计)
   - 4.1 `@crish/shared-types` 导出消歧方案对决（ESM 原生命名导出 vs 重命名导致外部破坏）
   - 4.2 桌面端 Axum WebSocket Upgrade 与远程命令挂载契约（`ws.rs` 命令黑洞消除）
   - 4.3 WebSocket 信封与帧协议对账（`events.subscribe` / `fullReplay` / `events.resume`）
   - 4.4 `app.json` 独立原生配置与包名契约漂移（`com.crish.mobile` vs `com.conex.crish.mobile`）
   - 4.5 `expo-crypto` 依赖版本与 SDK 57 生态契约断层（`~57.0.x` vs `~14.0.x`）
5. [6 份独立方案逐份深度优劣剖析（致命盲区与独特亮点）](#五6-份独立方案逐份深度优劣剖析致命盲区与独特亮点)
   - 5.1 Plan 01（极简收敛与先删后改学派）：亮点与盲区
   - 5.2 Plan 02（类型驱动与契约零漂移学派）：亮点与盲区
   - 5.3 Plan 03（协议闭环与安全状态机自愈学派）：亮点与盲区
   - 5.4 Plan 04（流式高性能与可观测性缓冲学派）：亮点与盲区
   - 5.5 Plan 05（生产级原生工程化与 CI 打包打通学派）：亮点与盲区
   - 5.6 Plan 06（现代 UI/UX 与人机工程极致体验学派）：亮点与盲区
6. [为主控出具《总计划吸收与裁决建议》](#六为主控出具总计划吸收与裁决建议)
   - 6.1 关键架构分歧裁决建议矩阵（8 大技术冲突决断）
   - 6.2 黄金整合路径（总计划各维度最佳组合吸收建议）
   - 6.3 刚性避坑与红线预警（分维详案设计时的底线守则）
7. [评审员自检核对表](#七评审员自检核对表)

---

## 一、评审定位、核心资产与审查基准

### 1.1 评审员定位与审查职责
作为本次方案评审大战的【架构契约与路径冲突评审员（Reviewer 1）】，本评审专员不偏袒任何特定学派，直接站在**“系统全局架构一致性、跨端协议契约刚性与单一真理源 (SSOT) 净收敛”**的制高点，对 6 位方案设计 Agent 独立产出的实施方案进行无死角、穿透源码级的严密审计。

### 1.2 核心审查三要素
1. **路径重叠（Path Overlap）**：是否存在方案 A 与方案 B 各自引入了不同的函数、文件或抽象层来解决同一个问题？是否有人以“解耦”为名制造了新的双轨代码？
2. **单一真理源（SSOT）**：对状态、模型、协议、样式 Token 是否做到了全仓仅保留一条权威主路径？负产出是否真正核销了历史死层？
3. **跨端协议契约（Contract Drift）**：`@crish/shared-types` 的导出与消歧是否破坏既有代码？Axum 后端路由与移动端前端调用是否完全对齐？WebSocket 信封与帧协议是否产生理解分叉？原生打包标识与依赖版本是否偏离真实环境？

---

## 二、6 份独立方案全景横向交叉对比表

| 评估维度 | Plan 01 (极简先删后改) | Plan 02 (类型契约驱动) | Plan 03 (协议闭环自愈) | Plan 04 (流式缓冲性能) | Plan 05 (生产级工程化) | Plan 06 (现代 UI/UX) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **设计学派** | 极简收敛与先删后改 | 类型驱动与契约零漂移 | 协议闭环与安全状态机自愈 | 流式高性能与可观测性缓冲 | 生产级原生工程化与 CI 打包 | 现代 UI/UX 与人机工程极致体验 |
| **代码篇幅** | 437 行 (精炼) | 709 行 (严谨) | 822 行 (详实) | 688 行 (深度) | 821 行 (工程化) | 954 行 (细腻) |
| **删除面力度** | **极强** (核销 1500+ 行，6 个 DAO 与死算法全删) | **强** (详尽 20 项删除，清退 6 个 DAO) | **中偏弱** (⚠️ 试图保留并接线 SqlApprovalQueueDao) | **强** (清退 6 个 DAO，轻量持久化) | **强** (聚焦构建垃圾与 6 个 DAO 核销) | **强** (详尽清退死页面、中转壳与死 DAO) |
| **类型消歧策略** | ESM 原生命名导出优先 | ESM 原生命名导出优先 | ESM 原生命名导出优先 | ESM 原生命名导出优先 | ⚠️ 建议对 `parseApprovalDecision` 重命名 | ⚠️ 建议对全部 6 个符号重命名为 `Engine*`/`Device*` |
| **端点 URL 契约** | `resolveWsUrl` 补齐 `/v1/events?token=` | 补齐 `/v1/events?token=` | 补齐 `/v1/events?token=` | 补齐 `/v1/events?token=` | 补齐 `/v1/events?token=` + 支持 `useTls` 开关 | 补齐 `/v1/events?token=` |
| **长连接与订阅** | 补发 `events.subscribe`，重放清游标 | 补发 `events.subscribe`，重放清游标 | **最严密** (详述 FanOut 建立与对账全景时序) | 补发订阅，全量重放清游标 | 补发订阅，全量重放清游标 | 补发订阅，全量重放清游标 |
| **Outbox 持久化** | 轻量存储适配器 (轻量 KV) | 轻量存储 (SecureStore/KV) | ⚠️ **重型 SQLite 表** (`SqlApprovalQueueDao`) | 轻量持久化适配器 (AsyncKV) | 可靠轻量持久化 (SecureStore/文件) | 轻量安全存储 (SecureStore) |
| **终端滚底依赖** | `startIndex + lines.length` (标量游标) | `[lines.length, truncatedCount]` | `startIndex + lines.length` (标量游标) | `startIndex + lines.length` (标量游标) | ⚠️ `[lines.length, lastLineId]` (需维护行 ID) | ⚠️ `[lines.length, startIndex]` (双字段) |
| **24dp 坐标补偿** | 补偿 Header 或改浮层 | `truncatedCount > 0 ? 24 : 0` (条件补偿) | 浮层 Toast 或条件补偿 | `truncatedCount > 0 ? 24 : 0` (条件补偿) | ⚠️ **无条件硬编码 +24** (存在未截断时错位 Bug) | ⚠️ **无条件硬编码 +24** (存在未截断时错位 Bug) |
| **原生包名标识** | `com.crish.mobile` | ⚠️ `com.conex.crish.mobile` | ⚠️ `com.conex.crish.mobile` | `com.crish.mobile` | `com.crish.mobile` | `com.crish.mobile` |
| **`expo-crypto` 版本** | `~57.0.1` (匹配 SDK 57) | `~57.0.1` (匹配 SDK 57) | `~57.0.1` (匹配 SDK 57) | ⚠️ `~14.0.1` (旧 SDK 51/52 遗留) | ⚠️ `~14.0.2` (旧 SDK 51/52 遗留) | ⚠️ `~14.0.x` (旧 SDK 51/52 遗留) |
| **UI 与触控规范** | 原子 Input/Tooltip，16 处热区 | 约 6% 焦点态，48dp 双轨热区 | 约 6% 边框，双轨热区补足 | 约 6% 柔边，dualHitSlop(36) | 约 6% 混入，16 处热区补足 | **最顶尖** (Fitts's Law、~5.8% 精确混入、手势冒泡隔离) |
| **测试移出路径** | `screens/__tests__/` 等 | `presentation/__tests__/app/` | `presentation/__tests__/app/` | `presentation/__tests__/` (扁平) | `presentation/__tests__/routes/` (规范) | `presentation/__tests__/` (扁平 kebab) |
| **DAG 拓扑严密性** | 单向无环，负产出先行 | 严格类型为核，单向流转 | 状态机因果拓扑严密 | 数据管道流向拓扑清晰 | 生产交付倒逼闭环拓扑 | 双轨推进拓扑清晰 |

---

## 三、路径重叠与多轨漂移深度排查详单（SSOT 贯彻性审查）

在多 Agent 并发方案设计中，最易产生的架构灾难是“各自造轮子”——为解决同一个痛点，不同的 Agent 各自设计了一套全新的模块或路径，导致系统不仅没有收敛，反而增加了新的复杂度。

本节逐项排查 6 份方案在关键领域的路径设计，指出其中的重叠与冲突，确立单一真理源。

---

### 3.1 时间格式化收敛路径冲突

- **现状痛点**：全仓存在 3 处时间格式化实现：
  1. `src/domain/pure/time.ts:formatRelativeTime`（纯函数，基础相对时间）；
  2. `src/presentation/components/files/fileMeta.ts:144-158`（手写相对时间，含昨天与天数回落）；
  3. `EventRow.tsx:196-200`（`formatFeedTime`，手写时钟 `HH:mm:ss`）与 `approvalListScreen.tsx:32-36`（`formatHistoryTime`，逐字克隆）。
- **方案比对**：
  - **Plan 01、Plan 02、Plan 03、Plan 04、Plan 06**：高度一致，统一裁定收敛至 `apps/crish-mobile/src/domain/pure/time.ts`。扩充该文件导出 `formatRelativeTime(ts, nowMs?, options?)` 与 `formatClockTime(ms: number): string`，并彻底删除其他 3 处的私有手写代码。
  - **Plan 04 的轻微漂移**：Plan 04 在收敛时间工具的同时，额外提出了建立 `src/domain/pure/encoding.ts` 来存放 Base64/Hex。
- **SSOT 裁决**：
  - **单一真理源路径**：`apps/crish-mobile/src/domain/pure/time.ts`；
  - 严禁在表现层（`presentation/`）或组件内部再次出现任何私有时间格式化逻辑；
  - 彻底物理删除 `fileMeta.ts:144-158`，清理 `EventRow.tsx` 与 `approvalListScreen.tsx` 的手写函数，直接 import 纯函数。

---

### 3.2 密码学哈希与签名造轮子收敛

- **现状痛点**：
  1. `src/network/signer.ts:41-186` 早期遗留了 145 行手写的 SHA-256 压缩算法（`SHA256_K` 等常量）及 RFC 2104 HMAC 字节异或；
  2. `src/pairing/crypto/keyAgreement.ts:81-95` 与 `signer.ts:189-202` 各自手写了 Base64 编码循环；
  3. `keyAgreement.test.ts:34-50` 手写了 Hex 编解码。
- **方案比对**：
  - **Plan 01、Plan 02、Plan 03**：主张彻底删除 `signer.ts` 中的 145 行手写代码，直接引入全仓已在使用的 `@noble/hashes/sha2.js` 的 `sha256` 与 `@noble/hashes/hmac.js` 的 `hmac`；Base64 与 Hex 直接复用 `@noble/hashes/utils.js` 的 `bytesToHex`、`hexToBytes` 等标准方法。
  - **Plan 04 与 Plan 05**：主张新建 `src/domain/pure/encoding.ts` 集中收敛 Base64 与 Hex。
- **路径重叠与风险剖析**：
  - 若新建 `src/domain/pure/encoding.ts`，实际上是在 `@noble/hashes/utils.js` 之外又包了一层薄封装；若封装不慎，反而形成了第三条路径。
  - 项目依赖中已显式安装并验证了 `@noble/hashes`，其内部提供的工具函数纯度极高且经过严格密码学测试。
- **SSOT 裁决**：
  - **SHA-256 / HMAC**：单一真源为 `@noble/hashes/sha2.js` 与 `@noble/hashes/hmac.js`，物理删除 `signer.ts` 中的 145 行手写轮子；
  - **Hex / 字节操作**：单一真源为 `@noble/hashes/utils.js`；
  - **Base64**：若需处理标准 Base64 编解码，可在 `src/domain/pure/encoding.ts` 仅导出一个轻量安全的 `base64Encode` / `base64Decode`（供全仓统一引用），严禁各业务模块私自手写位移循环。

---

### 3.3 返回按钮统一收敛

- **现状痛点**：全仓 7 个二级页面（`FileBreadcrumb`, `FilePreview`, `WorkspaceSwitcher`, `pairManualScreen`, `approvalDetailScreen`, `notificationCenter`, `session/run/terminalScreen`）各自手写返回按钮，样式、热区、文案严重分裂，部分页面甚至在 Android 平台不足 36dp 且漏设 `hitSlop`。
- **方案比对**：
  - 6 份方案均一致主张封装统一的原子组件 `<HeaderBackButton>`。
  - **实现深度差异**：
    - Plan 01、Plan 02、Plan 04、Plan 05 仅给出了组件设想与 44x44 尺寸定义；
    - **Plan 06 贡献了最高工业标准的完整实现**：内置 `dualHitSlop(44, 44)`、无障碍标签（`accessibilityRole="button"`, `accessibilityLabel="返回"`）、按压物理反馈（`pressed && { opacity: 0.7 }`）、主题色彩响应以及 `router.back()` 兜底。
- **SSOT 裁决**：
  - **单一真理源路径**：`apps/crish-mobile/src/presentation/components/ui/HeaderBackButton.tsx`；
  - 完整吸收 Plan 06 的高保真实现，严禁其他页面保留任何私有手写的返回箭头 JSX。

---

### 3.4 WebSocket URL 构造与鉴权路径

- **现状痛点**：`src/network/EndpointResolver.ts:resolveWsUrl` 原输出为 `wss://${host}:${port}`，遗漏了 Axum 服务端严格要求的 `/v1/events` 路由，且在已配对状态下遗漏携带 `?token=` 查询参数，导致握手直接被 404/401 拦截。
- **方案比对**：
  - 6 份方案均准确锁定了此 P0 缺陷并给出了修正方案；
  - **Plan 05 提供了更具生产鲁棒性的签名**：
    `resolveWsUrl(host: string, port: number, token?: string, useTls: boolean = true): string`
    增加了 `useTls` 参数支持（在局域网明文调试时可降级为 `ws://`，生产默认 `wss://`），更贴合局域网调试实际情况。
- **SSOT 裁决**：
  - **单一真理源路径**：`apps/crish-mobile/src/network/EndpointResolver.ts:resolveWsUrl`；
  - 规范拼接 `/v1/events` 并在 `token` 存在时自动追加 `?token=${encodeURIComponent(token)}`；
  - 吸收 Plan 05 的 `useTls` 参数扩展，兼顾 TLS 与明文局域网环境。

---

### 3.5 Outbox 队列持久化实现路线根本冲突（⚠️ 重大架构分歧）

这是 6 份方案中**最尖锐、最具冲突性的架构路线分水岭**，必须由评审员重点挑明并给出裁决：

- **冲突阵营**：
  - **阵营 A（Plan 03 协议自愈学派）**：主张**保留并接通 SQLite 的 `SqlApprovalQueueDao`**。理由是该 DAO 已经存在且包含测试，应该把它做实，用于 Outbox 队列持久化，抗杀进程。
  - **阵营 B（Plan 01、02、04、05、06 绝大多数学派）**：主张**彻底清退 `SqlApprovalQueueDao`（作为 6 个空心 DAO 之一），改用轻量持久化适配器（SecureStore 或轻量原子存储）**。
- **深度剖析与违约检查**：
  1. **对照终审定案文档《01-final-dimensions.md》**：
     - DIM-01 刚性删除面明确写道：`5. 清退 SQLite 层 6 个未接线空心 DAO；`（`00-summary.md` 明确定性包含 `SqlApprovalQueueDao`）；
     - DIM-04 核心解决问题写道：`移动端 Outbox 接入可靠持久化（防杀进程丢决策）`。
  2. **架构复杂度与过度设计红线审查**：
     - 移动端审批 Outbox 的业务体量是什么？通常在途的待批决策仅有 1~5 条，生命周期最多 120 秒，完成即出队。
     - 为了持久化这几条瞬态决策，去维护一套庞大的 SQLite 表结构、复杂的 DAO 增删改查、事务锁以及 800 行单测，属于典型的**过度设计与重型形式主义**！
     - 移动端定位是“轻量实时观测与审批终端”，不是离线双主数据库；使用 `SecureStore` 或轻量异步 KV 持久化层（在 `enqueue`、`markSent`、`confirmResolved` 时保存一个 JSON 队列数组），代码量不足 50 行，即可 100% 达成“抗杀进程、冷启动自动水合重放”的效果，同时彻底消灭一个 160 行的死 DAO 及 185 行的死单测！
- **SSOT 裁决**：
  - **坚决驳回 Plan 03 复活 `SqlApprovalQueueDao` 的提议**；
  - **坚决执行 DIM-01 的刚性删除面**：物理删除 `SqlApprovalQueueDao.ts` 及其测试 `approvalQueueDao.test.ts`；
  - **Outbox 持久化方案**：在 `src/domain/data/outbox.ts` 或轻量持久化适配器中，基于已有的轻量可靠存储机制（如 `SecureStore` 或原子文件存储）实现队列状态的存取，保持纯粹单一路径。

---

### 3.6 终端 5000 行吸底滚底游标依赖冲突

- **现状痛点**：`TerminalView.tsx:60-64` 的 `useEffect` 依赖项原为 `[follow, lines.length, targetRef]`。当达到 5000 行饱和态后，新行进入顶出旧行，`lines.length` 恒定为 5000，`useEffect` 永久停止触发，自动滚底死锁！
- **方案比对**：
  - **Plan 01、Plan 03、Plan 04**：定义标量游标 `lineCursor = startIndex + lines.length`（或 `totalLineCursor`）。每次新行推入且发生淘汰时，`startIndex` 必然递增，该标量严格单调递增，驱动 `useEffect` 持续平滑滚底。
  - **Plan 02**：依赖 `[follow, lines.length, truncatedCount, targetRef]`（`truncatedCount` 即 `startIndex`，双字段监听）。
  - **Plan 05**：依赖 `[lines.length, lastLineId, autoScrollEnabled]`。引入了 `lastLineId`，但这需要为每一行维护全局唯一 ID 或哈希，增加了运行时开销。
  - **Plan 06**：依赖 `[lines.length, startIndex]`。
- **数学与逻辑严密性裁决**：
  - **最优真理路径**：**标量绝对游标 `const lineCursor = startIndex + lines.length`**（Plan 01/03/04 方案）。
  - **理由**：一个单调递增的 Number 标量是最简单、零内存分配、最符合 React 依赖比较（`Object.is`）的原生逻辑。无需引入 `lastLineId` 等多余状态，优雅根除死锁。

---

### 3.7 FlatList 24dp 坐标错位修复方案的隐蔽逻辑 Bug（⚠️ 抓出隐性缺陷）

在评审各方案对 `TerminalView.tsx` 的 24dp 坐标错位修复时，本评审员抓出了一处**严重的隐性逻辑 Bug**：

- **现场背景**：`TerminalView.tsx` 在有截断发生时，渲染高度为 24dp 的 `ListHeaderComponent`（“已截断 N 行早期输出”）。原 `getItemLayout` 硬编码 `offset: 24 * index`，导致计算错位 24dp。
- **方案比对**：
  - **Plan 02 与 Plan 04**：
    ```typescript
    const headerOffset = truncatedCount > 0 ? 24 : 0;
    getItemLayout={(_data, index) => ({
      length: TERMINAL_LINE_HEIGHT,
      offset: headerOffset + TERMINAL_LINE_HEIGHT * index,
      index,
    })}
    ```
    👉 **完全正确**：严密判断了 `truncatedCount > 0`。在未满 5000 行、没有渲染 Header 时，`headerOffset = 0`；只有出现 Header 时才补偿 24dp！
  - **Plan 05 与 Plan 06 的严重疏漏**：
    Plan 05 写道：`offset: 24 + index * LINE_HEIGHT`；
    Plan 06 写道：`offset: 24 + 24 * index`。
    ⚠️ **隐性 Bug**：它们**无条件硬编码了 +24**！这意味着在终端刚刚启动、只有几行输出（`truncatedCount === 0`，没有 Header）时，它们强行给首行添加了 24dp 偏移，直接导致未截断时的首行空白悬空与滚动计算撕裂！
- **SSOT 裁决**：
  - 严厉警告 Plan 05 与 Plan 06 的硬编码逻辑；
  - **单一真理源实现**：必须采纳 Plan 02 / Plan 04 的**条件化 Header 偏移补偿**（`truncatedCount > 0 ? 24 : 0`）。

---

### 3.8 测试文件移出目标目录路径分歧

- **现状痛点**：`app/` 路由目录下混入了 8 个 `*.test.tsx` 页面单测，导致 Expo Router 静态导出崩溃。必须全部移出。
- **方案比对**（目标目录出现了 5 种不同提议）：
  - Plan 01：分散移至 `src/presentation/screens/__tests__/` 与 `src/presentation/pair/__tests__/`；
  - Plan 02 & Plan 03：移至 `src/presentation/__tests__/app/`；
  - Plan 04：移至 `src/presentation/__tests__/`（拍平成 `tabsIndex.test.tsx` 等）；
  - Plan 05：移至 `src/presentation/__tests__/routes/`（重命名为 `filesRoute.test.tsx` 等）；
  - Plan 06：移至 `src/presentation/__tests__/`（拍平成 `tabs-index.test.tsx` 等）。
- **SSOT 裁决**：
  - **单一真理源路径**：统一收敛为 **`apps/crish-mobile/src/presentation/__tests__/routes/`**（Plan 05 命名最清晰规范）；
  - 理由：这些测试专门针对 Expo Router 的路由包装页面，与组件单元测试（`components/__tests__/`）明确区分开，建立专用 `routes/` 目录，层级清晰，不污染组件测试域。

---

## 四、跨端协议契约与类型漂移风险深度审计

---

### 4.1 `@crish/shared-types` 导出消歧方案对决（⚠️ 致命契约破坏预警）

在处理 `generated/engine/parser.ts` 与 `generated/device/parser.ts` 之间重叠的 6 个工具符号时，各方案产生了严重的分歧：

- **6 个重叠符号**：`ParseResult<T>`、`parseOk`、`parseErr`、`isParseOk`、`isParseErr`、`parseApprovalDecision`。
- **方案比对**：
  - **正规军方案（Plan 01、Plan 02、Plan 03）**：
    利用 ECMAScript / TypeScript 标准规范：**显式命名导出（Named Export）优先级绝对高于通配导出（`export *`）**。
    在 `packages/shared-types/src/index.ts` 中直接显式导出这 6 个符号：
    ```typescript
    export {
      type ParseResult,
      parseOk,
      parseErr,
      isParseOk,
      isParseErr,
      parseApprovalDecision,
    } from './generated/engine/parser';
    ```
    外部消费方继续按 `import { ParseResult, parseApprovalDecision } from '@crish/shared-types'` 导入，**零破坏、零契约修改**。
  - **危险重命名方案（Plan 05 与 Plan 06）**：
    - Plan 05 建议：将 `parseApprovalDecision` 导出为 `parseEngineApprovalDecision`；
    - Plan 06 建议：将全部 6 个符号重命名为 `EngineParseResult`、`DeviceParseResult` 等。
- **契约破坏性审计（Contract Drift Risk）**：
  - 经全仓检索，现有移动端代码（如 `approvalWiring.ts`、`approvalMappers.ts`、`timelineEventParsing.contract.test.ts`）以及桌面端代码，已经大量按标准名称 `ParseResult` 与 `parseApprovalDecision` 进行导入；
  - 若采纳 Plan 05 或 Plan 06 的重命名方案，将**直接打碎全仓消费方的既有类型契约**，导致本已治愈的 TS 报错再次扩散，甚至引发跨包编译连锁雪崩！
- **SSOT 裁决**：
  - **坚决否决 Plan 05 与 Plan 06 的重命名方案**；
  - **唯一采纳 Plan 01/02/03 的 ESM 原生 Named Export 消歧法**，确保对外契约名称 100% 保持稳定，零破坏。

---

### 4.2 桌面端 Axum WebSocket Upgrade 与远程命令挂载契约

- **现状缺陷**：桌面端 `apps/agent-workbench/src-tauri/src/server/ws.rs:1133-1163` 内部，当收到入站信封时：
  ```rust
  _ => {
      tracing::debug!(target: "ws", conn_id = ctx.conn_id, kind = %envelope.kind_str(), "R1-05 范围外 kind，忽略");
      Action::Continue
  }
  ```
  移动端发出的 `remote.approve` 与 `remote.deny` 被统统当做范围外消息静默忽略，造成长达 10 秒的命令黑洞与超时挂起。
- **契约对齐审计**：
  - 移动端 `approvalWiring.ts:92-125` 发出的信封格式：
    - `kind: "remote.approve"`，参数包含 `toolCallId` 与可选 `runId`；
    - `kind: "remote.deny"`，参数包含 `toolCallId`、可选 `runId` 与 `reason`；
    - `kind: "remote.listPendingApprovals"`，用于重连对账。
  - 桌面端对应接口为 `api_backend.approve(...)` 与 `api_backend.deny(...)`。
- **协议回执契约刚性要求**：
  - 桌面端执行成功后，**必须回发对应的确认信封**（携带客户端原 `msgId`）：
    - `result.approve`，载荷 `{ ok: true, body: ... }`；
    - `result.deny`，载荷 `{ ok: true, body: ... }`；
    - `result.listPendingApprovals`，载荷 `{ ok: true, body: { pending: [...] } }`；
  - 随后底层引擎再广播 `approval-resolved` 事件帧。
- **评审结论**：6 份方案均对这一双阶段确认（RPC 回执 + 引擎事件广播）达成了高度共识，契约定义无漂移。

---

### 4.3 WebSocket 信封与帧协议对账

- **订阅帧契约**：
  - 必须由移动端在建连首帧主动发送 `events.subscribe` 信封：
    `{ "kind": "events.subscribe", "filter": { "types": ["*"] } }`
  - 服务端回包 `events.subscribe.ok`，激活移动端推流与对账状态机。
- **全量重放游标契约（`fullReplay`）**：
  - 当对账判定为需要全量重放（如游标落后超过窗口上限）时，移动端必须在调用 `resumeSession(sessionId, 0)` 之前，**显式调用 `eventStore.getState().unloadWindow(sessionId)` 或重置 `window.lastSeq = 0`**；
  - 彻底规避重放事件被 `seq <= window.lastSeq` 判定为重复项而全量静默丢弃的灾难性 Bug。

---

### 4.4 `app.json` 独立原生配置与包名契约漂移

- **契约源头**：定案文档《01-final-dimensions.md》DIM-07 明文裁决：
  `补齐 app.json 原生包名 com.crish.mobile 与 BundleId`
- **方案比对与合规性审查**：
  - **Plan 01、Plan 04、Plan 05、Plan 06**：严格遵守定案，使用 `"package": "com.crish.mobile"` 与 `"bundleIdentifier": "com.crish.mobile"`；
  - **Plan 02 与 Plan 03**：擅自将包名拓宽为 `"com.conex.crish.mobile"`！
- **漂移警告与裁决**：
  - Plan 02 与 Plan 03 的包名变更属于**未经授权的契约漂移**！
  - 若包名漂移为 `com.conex.crish.mobile`，会导致原生工程目录变为 `android/app/src/main/java/com/conex/crish/mobile/`，与定案契约及后续 CI 脚本不符；
  - **强制裁决**：统一采纳定案文档锁定的 **`com.crish.mobile`**。

---

### 4.5 `expo-crypto` 依赖版本与 SDK 57 生态契约断层

这是本评审员深入查阅 `apps/crish-mobile/package.json` 源码后挖出的**极度隐蔽的生态版本断层**：

- **真实代码事实**：
  查阅 `apps/crish-mobile/package.json`：
  ```json
  "dependencies": {
    "expo": "~57.0.12",
    "expo-secure-store": "~57.0.1",
    "expo-sqlite": "~57.0.1",
    "react": "19.2.3",
    "react-native": "0.86.2"
  }
  ```
  当前移动端运行在 **Expo SDK 57** 体系下！其官方全套配套组件的版本号均为 `~57.0.x`！
- **方案版本比对**：
  - **Plan 01、Plan 02、Plan 03**：写明引入 `"expo-crypto": "~57.0.1"`（**与现有 SDK 57 生态完美兼容匹配**）；
  - **Plan 04、Plan 05、Plan 06**：写明引入 `"expo-crypto": "~14.0.1"` 或 `~14.0.2`！
- **断层风险定性**：
  - `~14.0.x` 是两年前 Expo SDK 51/52 时代的远古版本；若在 SDK 57 + RN 0.86 + React 19 环境下安装 `expo-crypto: ~14.0.1`，会触发 npm 依赖版本冲突（peerDependencies 报错）或 JSI C++ 编译断裂！
- **SSOT 裁决**：
  - **必须采纳 Plan 01/02/03 的版本声明：`"expo-crypto": "~57.0.1"`**；
  - 驳回 Plan 04/05/06 的旧版本配置。

---

## 五、6 份独立方案逐份深度优劣剖析（致命盲区与独特亮点）

---

### 5.1 Plan 01（极简收敛与先删后改学派）

- **独特亮点**：
  1. **负产出意志最为坚决**：对 DIM-01 的 1500+ 行死代码（`cachePolicy.ts`、6 个空心 DAO、4 个占位路由）做到了“零犹豫彻底物理核销”，没有一丝为了保留而打补丁的拖泥带水；
  2. **终端吸底游标模型数学优美**：首创单调递增标量游标 `lineCursor = startIndex + lines.length`，以 O(1) 纯标量驱动 `scrollToEnd`，逻辑最干净；
  3. **生态版本准确**：精准识别出 SDK 57 环境下的 `"expo-crypto": "~57.0.1"`。
- **致命盲区**：
  1. **UI 与表现层颗粒度偏粗**：缺乏对《AGENTS.md》§12 Tooltip、§13 焦点态、Fitts's Law 热区补足的细致设计与代码实现，属于“骨架极其干净但肌肉略显单薄”；
  2. **未深入展开流式 Delta 增量折叠**：面对高频 300 token 流式推流时，缺乏就地折叠策略，容易被冲刷爆仓。

---

### 5.2 Plan 02（类型驱动与契约零漂移学派）

- **独特亮点**：
  1. **类型契约拓扑图最为规范**：以 Rust `conex-types` -> `@crish/shared-types` 为轴心，梳理出了极其清晰的跨包单向依赖图；
  2. **ESM Named Export 消歧逻辑严密**：精确指出了 ECMA-262 规范下通配导出碰撞的机理，并给出了零破坏的 Named Export 解决方案；
  3. **精准规避了 FlatList 条件偏移 Bug**：给出了 `truncatedCount > 0 ? 24 : 0` 的精准计算；
  4. **跨 Chunk ANSI 状态机清洗设计精准**：提出了 `ansiResidual` 缓存未完结 CSI 序列的方案。
- **致命盲区**：
  1. **包名契约发生无声漂移**：擅自将定案文档锁定的 `com.crish.mobile` 改写为了 `com.conex.crish.mobile`，违背了定案契约。

---

### 5.3 Plan 03（协议闭环与安全状态机自愈学派）

- **独特亮点**：
  1. **状态机闭环与网络自愈推演极其深厚**：绘制了详尽的长连接自愈时序图，覆盖了心跳假死（90s）、断线指数退避与 NetInfo 在线自愈；
  2. **对五大致命 P0 的根治推演最为透彻**：特别是配对 `dead` 相位漏发 `onPairError`、`handleOpen` 先绑通道后开相位、全量重放清游标等要害节点，分析入木三分；
  3. **对 Outbox 调度器的防串行雪崩与防定时器饥饿**分析非常深入。
- **致命盲区**：
  1. **严重违背 DIM-01 删除面铁律（试图复活 `SqlApprovalQueueDao`）**：在其余 5 份方案及定案文档均明确清退 6 个空心 DAO 的大背景下，坚持要在 SQLite 中维持重型 `SqlApprovalQueueDao`，背离了轻量收敛宗旨；
  2. **同样出现了包名漂移**：将包名写为 `com.conex.crish.mobile`。

---

### 5.4 Plan 04（流式高性能与可观测性缓冲学派）

- **独特亮点**：
  1. **流式增量智能折叠（Streaming Delta Folding）**：在 6 份方案中唯一深入洞察到“300 token 的普通回复会产生数百条小 sequence 记录挤爆 500条环形缓冲”，给出了同轮次 delta 就地合并的绝妙方案；
  2. **前台正视会话加锁（Foreground Window Guard）**：精准抓出了“用户在前台正视会话 A 时，被后台 B/C/D/E 事件挤压清空”的恶性体验 Bug，注入了前台豁免锁；
  3. **微任务削峰批处理**：提出了 50ms 窗口聚合写入 Store，降低 80% 的 React Diff 开销。
- **致命盲区**：
  1. **版本声明落入旧时代**：在 package.json 中写了 `expo-crypto: ~14.0.1`，脱离了 SDK 57 生态；
  2. **测试迁移目录过于扁平**：将 8 个单测直接堆在 `src/presentation/__tests__/` 根下，不如设立 `routes/` 子目录规范。

---

### 5.5 Plan 05（生产级原生工程化与 CI 打包打通学派）

- **独特亮点**：
  1. **工程化与 CI/CD 编译全景最为完备**：给出了完整的 `npx expo prebuild`、Android 本地 Gradle 编译命令（`assembleDebug` / `bundleRelease`）、以及 iOS 双轨构建流水线（Windows 导出 + GitHub Actions macOS Runner / EAS Cloud）；
  2. **`app.json` 安全防线健全**：严密配置了 `allowBackup: false`（防硬件 Keystore 解密崩溃）与 `usesCleartextTraffic`；
  3. **`resolveWsUrl` 提供了 `useTls` 参数**，提升了局域网网络适配灵活性。
- **致命盲区**：
  1. **FlatList 24dp 坐标错位代码存在硬编码 Bug**：写出了 `offset: 24 + index * LINE_HEIGHT`，未判断 `truncatedCount > 0`，在未截断时会导致布局永久偏移；
  2. **消歧提议存在破坏性重命名风险**：建议将 `parseApprovalDecision` 重命名为 `parseEngineApprovalDecision`，破坏外部契约；
  3. **`expo-crypto` 版本误写为 `~14.0.2`**。

---

### 5.6 Plan 06（现代 UI/UX 与人机工程极致体验学派）

- **独特亮点**：
  1. **人机工程学手感设计登峰造极**：基于 Fitts's Law 深度优化了双轨热区算法 `dualHitSlop`（iOS 44pt / Android 48dp），彻底普查并补齐了全仓 16 处触控违规；
  2. **严格落实《AGENTS.md》§12、§13、§14**：给出了原子 `<Input>`（~5.8% 柔边、0 重阴影）、原子 `<Tooltip>`（长按气泡、自动定位、防遮挡）、统一 `<HeaderBackButton>` 的完整工业级代码；
  3. **冷启动防闪烁与四态完备矩阵**：系统性设计了全屏幕在 `!hydrated` 下的占位护航，坚决消灭“暂无数据”一闪而过；
  4. **按压物理动效与手势冒泡隔离**：为审批卡加入按压态，在 `SessionRow` 内部为 `ApprovalBadge` 注入 `e.stopPropagation()`，彻底解决手势穿透双入栈。
- **致命盲区**：
  1. **FlatList 24dp 补偿同样犯了硬编码错位错误**：无条件 `offset: 24 + 24 * index`，存在隐性 Bug；
  2. **消歧提议过度重命名**：提议将 6 个符号全部重命名为 `Engine*` / `Device*`，打碎现有调用链；
  3. **版本声明误写为 `~14.0.x`**。

---

## 六、为主控出具《总计划吸收与裁决建议》

基于上述详尽的横向交叉对比与深度病理剖析，本评审专员为主控出具明确的**《总计划吸收与裁决建议》**。主控在编纂《总方案》与拆解《分维详案》时，应严格采纳以下决断：

### 6.1 关键架构分歧裁决建议矩阵

| 分歧争议点 | 冲突各方 | 评审专员终审裁决建议 | 决断依据与技术底线 |
| :--- | :--- | :--- | :--- |
| **1. Outbox 持久化路线** | Plan 03 (复活 SQLite) vs Plan 01/02/04/05/06 (轻量存储) | **裁决：坚决清退 `SqlApprovalQueueDao`，采纳轻量持久化适配器** | 遵照定案文档 DIM-01 刚性删除面；防范重型 SQLite 形式主义与过度设计；Outbox 几条在途数据用轻量持久化即可完美抗杀进程。 |
| **2. shared-types 消歧** | 原生命名导出 (01/02/03) vs 重命名 (05/06) | **裁决：采纳 ESM 原生命名导出消歧，严禁重命名符号** | 保护全仓跨包既有类型契约，命名导出优先级绝对高于通配导出，零破坏解决 ESM 歧义。 |
| **3. FlatList 24dp 补偿** | 条件补偿 (02/04) vs 无条件硬编码 (05/06) | **裁决：严格采纳条件补偿 `truncatedCount > 0 ? 24 : 0`** | 严禁无条件加 24dp！防止在行数不足 5000 行、未出现 Header 时引发列表整体坐标系统性下移与撕裂。 |
| **4. 终端滚底游标依赖** | 标量绝对游标 (01/03/04) vs 双字段 (02/06) vs 行 ID (05) | **裁决：采纳标量绝对游标 `startIndex + lines.length`** | 数学上最严密，单调递增，零额外对象分配，O(1) 复杂度平滑触发吸底滚轮。 |
| **5. 原生应用包名** | `com.crish.mobile` (01/04/05/06) vs `com.conex.crish.mobile` (02/03) | **裁决：严格锁定 `com.crish.mobile`** | 契约单一真理源：定案文档《01-final-dimensions.md》明文锁定的唯一原生标识符，严禁漂移。 |
| **6. `expo-crypto` 版本** | `~57.0.1` (01/02/03) vs `~14.0.x` (04/05/06) | **裁决：严格锁定 `~57.0.1`** | 与项目当前已锁定的 Expo SDK 57、RN 0.86、React 19 保持严格生态一致，防止安装 peer 报错。 |
| **7. 测试搬迁目标路径** | `routes/` (05) vs `app/` (02/03) vs 拍平 (04/06) | **裁决：采纳 `src/presentation/__tests__/routes/`** | 概念高内聚：与组件单测明确分流，消除与页面组件的命名重叠。 |
| **8. 时间与编码收敛** | 统一 `time.ts` 与标准 noble 库 | **裁决：时间统一 `time.ts`，密码学统一 `@noble/hashes`** | 单一真理源：彻底删除表现层与网络层手写轮子，纯函数下沉至 Domain。 |

---

### 6.2 黄金整合路径（总计划各维度最佳组合吸收建议）

主控在统筹总计划时，应将 6 份方案的最强优势模块化编织进 7 大实施维度，实现“取其精华、去其糟粕”的黄金组合：

1. **DIM-01（重复与死层，负产出基座）**：
   - **以 Plan 01 为主骨架**：全面采纳其最强负产出力度，彻底物理删除 `r2-16`、`cachePolicy`、6 个死 DAO、3 个空目录与 4 个占位路由；
   - **吸收 Plan 05 的测试隔离路径**：统一将 8 个单测迁至 `src/presentation/__tests__/routes/`；
   - **还原标准的 `metro.config.js`**：拔除 `customSerializer` 与硬编码绝对路径。
2. **DIM-02（类型系统与跨包契约）**：
   - **以 Plan 02 为主骨架**：采纳其严格 ESM Named Export 导出 57 类事件与 108 个解析器，坚决保留原名，严禁 Plan 05/06 的重命名；
   - 逐一修复移动端 22 处 TS 报错，清退桌面端 16 处深路径。
3. **DIM-03（安全配对与连接对账网关）**：
   - **以 Plan 03 为主骨架**：吸收其状态机自愈全景时序，根除配对 Dead 相位漏发 `onPairError` 导致的按钮 Loading 永久死锁；
   - 修复端点 URL 携带 `/v1/events?token=`（吸收 Plan 05 的 `useTls` 支持）；
   - 补发 `events.subscribe` 首帧订阅，全量重放重置本地游标。
4. **DIM-04（跨端审批闭环与 Outbox 队列）**：
   - **吸收 Plan 03 的桌面端 `ws.rs` 路由挂载**：消除远程命令黑洞；
   - **采纳 Plan 01/02 的轻量持久化路线**：拒绝 SQLite 重型表，采用轻量持久化适配器保证抗杀进程；
   - **吸收 Plan 06 的防双点与物理按压反馈**：融入 120s 倒计时状态机。
5. **DIM-05（会话流式事件与终端缓冲引擎）**：
   - **以 Plan 04 为主骨架**：吸收其**流式增量折叠（Streaming Delta Folding）**（防 500 条环形缓冲爆仓）与**前台正视会话加锁（Foreground Window Guard）**；
   - **吸收 Plan 01/04 的标量绝对游标 `startIndex + lines.length`**，根治终端 5000 行滚底死锁；
   - **采纳 Plan 02/04 的条件化 24dp 偏移补偿**（修正 Plan 05/06 的硬编码 Bug）；
   - 接线 `applyLatestSeq` 恢复会话列表未读红点。
6. **DIM-06（UI 规范、主题与触控交互）**：
   - **以 Plan 06 为绝对主导**：全盘吸收其原子 `<Input>`（~5.8% 柔边、0 重阴影）、原子 `<Tooltip>`（长按定位气泡）、统一 `<HeaderBackButton>`；
   - 落实 Fitts's Law 双轨热区规范（`dualHitSlop`），治理全仓 16 处触控违规；
   - 落实全屏幕四态与冷启动防闪烁（`hydrated` 守卫）；落实通知偏好门禁拦截穿透。
7. **DIM-07（工程化基建与独立原生打包）**：
   - **以 Plan 05 为主骨架**：吸收其完整的离线导出、Android Gradle 本地编译规程与 iOS 双轨构建流水线；
   - **严格锁定 Plan 01/05 的包名契约**：`com.crish.mobile`；
   - **严格锁定 Plan 01/02/03 的原生依赖版本**：`"expo-crypto": "~57.0.1"`。

---

### 6.3 刚性避坑与红线预警（分维详案设计时的底线守则）

1. **红线 1：禁止在分维详案中出现任何形式的波次/批次命名**；
2. **红线 2：严禁试图复活已定案删除的死层**（如 `SqlApprovalQueueDao` 或 `cachePolicy`）；
3. **红线 3：严禁私自变更 `@crish/shared-types` 导出函数名称**；
4. **红线 4：严禁无条件硬编码 FlatList 24dp 偏移**；
5. **红线 5：严禁为移动端引入外部重型 UI 库或复杂内核沙箱**（遵守反过度设计红线）。

---

## 七、评审员自检核对表

- [x] **6 份独立方案全景通读**：深入精读 01 至 06 全部方案源码与文档，提取了确凿的技术事实与代码证据；
- [x] **横向交叉对比表齐备**：涵盖学派定位、删除面、消歧、URL、Outbox、终端滚底、24dp、包名、crypto 版本等 10+ 个核心维度；
- [x] **路径重叠详单深入透彻**：深度排查了时间、密码学、返回键、URL、Outbox、滚底依赖、24dp 补偿、测试目录 8 大冲突点；
- [x] **单一真理源 (SSOT) 刚性裁决**：指明了唯一主路径，断然否决了重型 DAO 复活与分散工具包；
- [x] **跨端协议契约严密守门**：抓出了 Plan 05/06 的消歧重命名破坏风险、Plan 02/03 的包名漂移风险、Plan 04/05/06 的 crypto 远古版本断层；
- [x] **逐份优劣与盲区剖析客观公允**：指出了每份方案的致命盲区与不可替代的独特亮点；
- [x] **出具明确的主控吸收与裁决建议**：提供了黄金组合方案与刚性避坑红线；
- [x] **纪律红线 100% 遵守**：全文无任何波次/批次编号，无业务代码修改，不涉及笔记功能；
- [x] **落盘指定路径**：`docs/mobile-revival-audit/plan-reviews/01-contract-and-overlap-review.md`。

---
*报告编制完毕。评审专员 1 履职完成，请主控审阅并作为总计划定案与分维详案的权威裁决依据！*
