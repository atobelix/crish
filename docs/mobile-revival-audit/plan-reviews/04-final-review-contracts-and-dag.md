# 移动端全面复兴与打包打通 · 契约分界、文件域互斥与 DAG 拓扑终审报告 (04-final-review-contracts-and-dag.md)
## —— 详案终审 Agent 1：契约分界、文件域互斥与 DAG 拓扑终审专员

> **战役工作区**：`docs/mobile-revival-audit/`  
> **报告位置**：`docs/mobile-revival-audit/plan-reviews/04-final-review-contracts-and-dag.md`  
> **审查角色**：【详案终审 Agent 1（契约分界、文件域互斥与 DAG 拓扑）】  
> **审查输入资产**：  
> - 实施总纲框架：[`docs/mobile-revival-audit/02-master-revival-plan.md`](file:///c:/Software/conex/docs/mobile-revival-audit/02-master-revival-plan.md)  
> - 7 份可执行详案：[`docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md) 至 [`07-plan-dim-07-packaging.md`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/07-plan-dim-07-packaging.md)  
> - 前序对撞评审：`docs/mobile-revival-audit/plan-reviews/`（01 契约重叠审、02 负产出硬审、03 可行性对撞）  
> - 跨端核心源码：桌面端 [`apps/agent-workbench/src-tauri/src/server/ws.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs)、`core_backend.rs` 与移动端 `EndpointResolver.ts`、`ReconnectingWsClient.ts`、`WsGateway.ts`、`approvalWiring.ts`、`feedBridge.ts`、`authStore.ts`、`eventStore.ts`  
> **遵循准则**：《主 Agent 全流程调度提示词 v3》第二阶段第 5 步规范、根目录《AGENTS.md》、反退避全文（`LOGIC_PLAN_NO_RETREAT.md`）与反过度设计红线（`ANTI_OVERENGINEERING_GUARDRAILS.md`）  
> **终审纪律铁律**：  
> 1. **绝对不修改任何业务代码**（只对计划文档进行高强度剖析与仲裁）；  
> 2. **绝对禁止出现任何波次/批次编号**（一律以阶段概念与 DIM 编号锚定）；  
> 3. **杜绝空壳“整体良好”与套话**，必须具体到文件、行号、接口名与断言；  
> 4. **完全不涉及笔记功能**；  
> 5. 坚持单一真理源（SSOT）与架构净收敛。

---

## 目录

1. [终审定位与核心审计三要素](#一终审定位与核心审计三要素)
2. [【全流程逻辑与因果 DAG】深度穿透审计](#二全流程逻辑与因果-dag深度穿透审计)
   - 2.1 全局 DAG 依赖拓扑全景图检验
   - 2.2 逻辑断环排查一：DIM-01 提前删除 `themeProjection.ts` 引发 DIM-02 编译雪崩（Blocker 1）
   - 2.3 逻辑矛盾排查二：DIM-01、DIM-02 与 DIM-05 在 `terminalLineBuffer.ts` 归属上的断层（Blocker 2）
   - 2.4 依赖倒置排查三：Master Plan DAG 缺少 `D2 --> D6` 边导致 UI 抢跑（Blocker 3）
   - 2.5 隐式前提排查四：DIM-04 与 DIM-05 对 DIM-03 网络通道的强依赖完备性
3. [【文件域互斥性与防冲突】深度交叉核验](#三文件域互斥性与防冲突深度交叉核验)
   - 3.1 7 大维度唯一文件域横向交叉核验矩阵
   - 3.2 致命重叠冲突一：`terminalScreen.tsx` 三维写写死锁（DIM-01 vs DIM-05 vs DIM-06）（Blocker 4）
   - 3.3 并行重叠冲突二：`pairManualScreen.tsx` 双维并发冲突（DIM-03 vs DIM-06）（Blocker 5）
   - 3.4 权责交叠冲突三：`secureStore.ts` & 测试双维重复认领（DIM-01 vs DIM-03）（Blocker 6）
   - 3.5 物理删除竞争四：`pairScanScreen.tsx` 双维重复删除（DIM-01 vs DIM-06）（Suggestion 1）
   - 3.6 串行文件域收敛时序核查（`feedBridge.ts`、`EventRow.tsx`、`fileMeta.ts`）
4. [【跨端协议契约闭环】双端源码逐行对拍](#四跨端协议契约闭环双端源码逐行对拍)
   - 4.1 协议致命 Bug：`EndpointResolver` 提取 `authStore.getState().token` 的类型幻觉（Blocker 7）
   - 4.2 幂等性黑洞：Outbox 重试丢失 `item.msgId` 引发 409 虚假冲突（Blocker 8）
   - 4.3 契约越界隐患：DIM-04 规划修改 `device-protocol.json` 却未声明文件域（Suggestion 2）
   - 4.4 远程命令与三态信封闭环：`ws.rs` `MessageKind::Remote` 与 `CommandResult` 严密性
   - 4.5 会话订阅与对账重放闭环：`events.subscribe` / `events.subscribe.ok` / `fullReplay` 窗口重置
   - 4.6 传输层握手与安全基线：TLS / Cleartext 流量策略与 HTTP 101 Upgrade 升级鉴权
5. [【文末终审判定给主控】（裁决汇总与整改清单）](#五文末终审判定给主控裁决汇总与整改清单)
   - 5.1 必须改项（Blocker，共 8 项）
   - 5.2 建议改项（Suggestion，共 4 项）
   - 5.3 可接受风险（Risk，共 3 项）
   - 5.4 终审放行结论

---

## 一、终审定位与核心审计三要素

作为全战役的【详案终审 Agent 1（契约分界、文件域互斥与 DAG 拓扑）】，本终审专员不承担编写业务代码的职责，而是站在**“系统全局因果闭环、多 Agent 并发写安全、跨端通信 100% 严密零黑洞”**的最高审判位，对主控编写的《02-master-revival-plan.md》总纲与 7 位维度设计 Agent 提交的可执行详案（DIM-01 至 DIM-07）进行针尖对麦芒的严厉审查。

### 审查核心三要素
1. **因果 DAG 拓扑刚性**：各维度的前后推进顺序是否构成严格的单向无环图？是否存在“后置维度的改动是前置维度编译或运行的前提”这类致命依赖倒置或隐性逻辑断环？
2. **唯一文件域绝对互斥**：各维度声明的 Writable File Scope 是否真正正交？在计划并行的维度之间（特别是 DIM-03 与 DIM-06，以及 DIM-04、DIM-05 与 DIM-06 之间），是否存在两个或多个维度同时拥有写权限的冲突炸弹？
3. **跨端协议契约零死角**：桌面端 Axum WebSocket 网关（[`ws.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs)）与移动端传输底座（`EndpointResolver` / `ReconnectingWsClient` / `WsGateway` / `ApprovalBridge` / `FeedBridge`）在 URL 路由、鉴权参数、入站/出站信封序列化、三态错误码映射及游标对账协议上，是否严丝合缝、完全对称、零黑洞？

---

## 二、【全流程逻辑与因果 DAG】深度穿透审计

### 2.1 全局 DAG 依赖拓扑全景图检验

主控在《02-master-revival-plan.md》第四节确立了 5 个阶段推进拓扑：
- **阶段 0**：DIM-01（重复与死层，负产出基座先行）
- **阶段 1**：DIM-02（类型系统与跨包契约，`shared-types` 导出补齐）
- **阶段 2**：DIM-03（安全配对与连接对账网关）与 DIM-06（UI 规范、主题与触控交互）
- **阶段 3**：DIM-04（跨端审批闭环与 Outbox 队列）与 DIM-05（会话流式事件与终端缓冲引擎）
- **阶段 4**：DIM-07（工程化基建与独立原生打包收口）

经过对 7 份详案内部声明的推进逻辑进行跨文档拓扑提取，本终审专员核验出 **3 处阻断级逻辑断环与依赖矛盾**：

---

### 2.2 逻辑断环排查一：DIM-01 提前删除 `themeProjection.ts` 引发 DIM-02 编译雪崩（Blocker 1）

#### 现场证据与断环剖析
1. **DIM-01 计划在阶段 0 物理删除该文件**：
   - 文件：[`docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md:383`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md#L383)
   - 内容：`rm apps/crish-mobile/src/adapters/settings/themeProjection.ts # 21 行，双轨薄兼容别名文件`
2. **磁盘现状真实调用**：
   - 经全局代码排查，全仓当前仍有 **8 个组件与页面** 正在直接引用该文件导出的 `useAppTheme`：
     - `apps/crish-mobile/src/presentation/pair/pairWelcomeScreen.tsx:16`
     - `apps/crish-mobile/src/presentation/pair/pairManualScreen.tsx:21`
     - `apps/crish-mobile/src/presentation/components/settings/SettingsAboutCard.tsx:11`
     - `apps/crish-mobile/src/presentation/components/settings/SettingsGroup.tsx:11`
     - `apps/crish-mobile/src/presentation/components/settings/SettingsRemoveLocalZone.tsx:11`
     - `apps/crish-mobile/src/presentation/components/settings/SettingsScreenView.tsx:16`
     - `apps/crish-mobile/src/presentation/components/settings/SettingsSwitchRow.tsx:11`
     - `apps/crish-mobile/src/presentation/components/settings/SettingsThemeSelector.tsx:12`
3. **调用清理的责任分配**：
   - 在 [`docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md:690-694`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md#L690-L694)，DIM-06 将“收拢 7 个页面/组件对 `useAppTheme` 的别名引用为 `useTheme`”分配在 **阶段 2B（DIM-06）** 执行。
4. **因果雪崩连锁反应**：
   - 按照 DAG，DIM-01 在【阶段 0】执行物理删除，此时 8 个调用方仍未被修改；
   - 紧接着进入【阶段 1】DIM-02，DIM-02 的硬性门禁是：
     `npm run typecheck -w @crish/crish-mobile`（[`02-plan-dim-02-type-contract.md:330`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/02-plan-dim-02-type-contract.md#L330) 断言 22 错误归零）；
   - **灾难发生**：由于 `themeProjection.ts` 已被 DIM-01 物理抹除，TypeScript 编译器在阶段 1 将直接报出 **8 处 `TS2307: Cannot find module '@/adapters/settings/themeProjection'` 致命错误**！
   - DIM-02 的准出门禁当场暴毙，整个战役流水线在阶段 1 彻底瘫痪。

#### 判定与仲裁（必须改 · Blocker 1）
- **根因**：负产出与依赖清理时序倒置。死文件物理清退必须与调用点修改保持原子性，绝不允许“先删被引用文件，两个阶段后再改调用方”。
- **修复决断**：
  - **路径 A（推荐）**：在阶段 0，DIM-01 暂不物理删除 `themeProjection.ts`，仅将其标记为废弃（或保留 3 行薄转发）；直至阶段 2B DIM-06 将 8 处引用全部收敛至 `@/adapters/platform/theme` 后，由 DIM-06 统一执行 `git rm themeProjection.ts`；
  - **路径 B**：DIM-01 在阶段 0 删除 `themeProjection.ts` 的同时，原子性地将这 8 个文件的 import 语句同步替换为 `import { useTheme } from '@/adapters/platform/theme'`，并将这 8 个文件纳入 DIM-01 的合法修改域。

---

### 2.3 逻辑矛盾排查二：DIM-01、DIM-02 与 DIM-05 在 `terminalLineBuffer.ts` 归属上的断层（Blocker 2）

#### 现场证据与矛盾暴露
1. **DIM-02 的虚假前置假定**：
   - 文件：[`docs/mobile-revival-audit/plans/02-plan-dim-02-type-contract.md:303`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/02-plan-dim-02-type-contract.md#L303)
   - 拓扑描述：`D1["DIM-01: 重复与死层清理 (垃圾文件核销 / 还原 Metro / 移出 8 路由单测 / 下沉 terminalLineBuffer)"]`
   - DIM-02 明确假定 DIM-01 在阶段 0 已经完成了 `terminalLineBuffer.ts` 向 Domain 层的下沉。
2. **DIM-01 的实际实施范围**：
   - 查阅 [`docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md:435-439, 522`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md#L435-L439)：
   - DIM-01 仅在 `apps/crish-mobile/src/presentation/components/terminal/terminalLineBuffer.ts` 中删除了未引用的 `replaceAllTerminalText` 函数（16 行），**压根没有执行物理下沉**！文件依然滞留在 `src/presentation/`。
3. **DIM-05 的真正实施认领**：
   - 查阅 [`docs/mobile-revival-audit/plans/05-plan-dim-05-session-terminal.md:255-281, 551`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/05-plan-dim-05-session-terminal.md#L255-L281)：
   - DIM-05 在【阶段 3B】才正式执行将 `terminalLineBuffer.ts` 从 `presentation/` 物理下沉至 `src/domain/pure/terminalLineBuffer.ts`，并重写 `terminalReducers.ts` 的导入路径以消除逆向依赖。

#### 判定与仲裁（必须改 · Blocker 2）
- **严重性**：跨详案叙事严重断层。DIM-02 误以为阶段 0 已经完成下沉，若 DIM-02 的检查器基于下沉后的路径校验，将直接报找不到模块。
- **修复决断**：
  - 明确单一真理源：`terminalLineBuffer.ts` 的纯算法物理下沉与测试迁移**归属且仅归属于 DIM-05（阶段 3B）**；
  - 必须就地修正 DIM-02 详案第 303 行与第 318 行的文字描述，删除“DIM-01 下沉 terminalLineBuffer”的错误断言，恢复 DIM-01 纯粹的局部死代码清理定位。

---

### 2.4 依赖倒置排查三：Master Plan DAG 缺少 `D2 --> D6` 边导致 UI 抢跑（Blocker 3）

#### 现场证据与依赖倒置暴露
1. **Master Plan 图谱疏漏**：
   - 查阅 [`docs/mobile-revival-audit/02-master-revival-plan.md:79-84`](file:///c:/Software/conex/docs/mobile-revival-audit/02-master-revival-plan.md#L79-L84)：
     ```mermaid
     D1 --> D2
     D1 --> D6
     D2 --> D3
     ```
   - 总纲在 Mermaid 拓扑中仅画了 `D1 --> D6`，意味着从调度器视角，DIM-06 可以在阶段 0 完成后与 DIM-02 同时并发拉起！
2. **DIM-06 自身的真实前置要求**：
   - 查阅 [`docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md:720-721, 729`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md#L720-L721)：
   - DIM-06 内部拓扑严正声明：`D1 --> S1` 且 `D2 --> S1`！
   - 文字明确强调：“依赖 DIM-02：必须保证全局 TypeScript 类型 100% 编译通过”。
3. **并发灾难推演**：
   - 移动端目前因 `shared-types` 漏导出 57 类事件和 108 个解析器，存在 22 处全局 TS 报错；
   - 若调度器按 Master Plan 的 `D1 --> D6` 抢先调度 DIM-06，DIM-06 在编写完 `<Input>` 和 `<Tooltip>` 后执行准出门禁 `npm run typecheck -w @crish/crish-mobile`（[`06-plan-dim-06-ui-ux.md:783`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md#L783)），将立刻被未修复的 22 处无关类型错误拦截，导致其永远无法通过自检准出。

#### 判定与仲裁（必须改 · Blocker 3）
- **修复决断**：
  - 必须就地修改 Master Plan《02-master-revival-plan.md》第 80 行及 DIM-07 第 453 行的 Mermaid 拓扑，**强行追加 `D2 --> D6` 依赖边**；
  - 确立刚性因果纪律：DIM-06 必须在 DIM-02 完成跨包契约补齐且全仓 TS 编译 0 报错后，方可正式启动。

---

### 2.5 隐式前提排查四：DIM-04 与 DIM-05 对 DIM-03 网络通道的强依赖完备性

#### 依赖因果核查
- **DIM-04（审批）对 DIM-03 的依赖**：
  - 审批 Outbox 的单飞重放机制由 `events.subscribe.ok` 回执触发的 `onSyncReady()` 唤醒（[`04-plan-dim-04-approval-outbox.md:304`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/04-plan-dim-04-approval-outbox.md#L304)）；
  - 远程审批 RPC 发送依赖 WebSocket `/v1/events?token=` 物理连接建立；
  - 因果关系：`DIM-03 (网络网关) --> DIM-04 (审批业务)` 严密闭环，无断裂。
- **DIM-05（流式终端）对 DIM-03 的依赖**：
  - 终端流式数据和会话事件依赖首帧 `events.subscribe` 建立桌面端 FanOut 过滤器；
  - 断线续传与全量重放依赖 DIM-03 修复后的游标清空机制；
  - 因果关系：`DIM-03 (网络网关) --> DIM-05 (流式终端)` 严密闭环，无断裂。
- **结论**：业务服务层（DIM-04 / DIM-05）对传输底座层（DIM-03）的依赖因果完全成立。

---

## 三、【文件域互斥性与防冲突】深度交叉核验

### 3.1 7 大维度唯一文件域横向交叉核验矩阵

为排查多 Agent 并发执行中的“同文件写冲突”，对 7 份详案声明的修改文件列表进行全景交叉投影：

| 关键文件相对路径 | DIM-01 (死层) | DIM-02 (类型) | DIM-03 (网关) | DIM-04 (审批) | DIM-05 (终端) | DIM-06 (UI) | DIM-07 (打包) | 冲突定性与风险级别 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `src/presentation/screens/terminalScreen.tsx` | **写** (颜色) | - | - | - | **写** (单真理) | **写** (返回/热区) | - | 🔴 **严重三维冲突 (Blocker 4)** |
| `src/presentation/pair/pairManualScreen.tsx` | - | - | **写** (纯函数) | - | - | **写** (Input/返回) | - | 🔴 **并行写冲突 (Blocker 5)** |
| `src/db/secureStore.ts` 及 `.test.ts` | **写** (删Nonce) | - | **写** (删Nonce) | 读 (驱动) | - | - | - | 🔴 **重复认领冲突 (Blocker 6)** |
| `src/presentation/pair/pairScanScreen.tsx` | **删** (死代码) | - | - | - | - | **删** (死路由) | - | 🟡 **重复删除竞争 (Suggestion 1)** |
| `src/adapters/wiring/feedBridge.ts` | - | - | **写** (首帧订阅) | - | **写** (前台锁) | - | - | 🟢 **串行依赖无冲突** (D3->D5) |
| `src/presentation/components/blocks/EventRow.tsx`| **写** (删时钟) | - | - | - | **写** (人话摘要) | - | - | 🟢 **串行依赖无冲突** (D1->D5) |
| `src/presentation/components/files/fileMeta.ts` | **写** (删相对时间) | - | - | - | - | **写** (HSLA颜色) | - | 🟢 **串行依赖无冲突** (D1->D6) |
| `src/adapters/settings/themeProjection.ts` | **删** (死代码) | - | - | - | - | **引** (收口别名) | - | 🔴 **时序依赖断裂 (见 2.2)** |
| `packages/shared-types/src/index.ts` | - | **独占写** | - | - | - | - | - | 🟢 绝对正交 |
| `apps/agent-workbench/src-tauri/src/server/ws.rs`| - | - | - | **独占写** | - | - | - | 🟢 绝对正交 |
| `packages/shared-utils/src/event-ring-window.ts`| - | - | - | - | **独占写** | - | - | 🟢 绝对正交 |
| `apps/crish-mobile/app.json` | - | - | - | - | - | - | **独占写** | 🟢 绝对正交 |

---

### 3.2 致命重叠冲突一：`terminalScreen.tsx` 三维写写死锁（DIM-01 vs DIM-05 vs DIM-06）（Blocker 4）

#### 现场证据与冲突机理
1. **DIM-01 的写声明**（[`plans/01-plan-dim-01-dead-code.md:517`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md#L517)）：
   - 修改 `terminalScreen.tsx`，将 `running` 状态指示灯与文案由绿色修正为蓝色（`colorInfo`），消除与 `completed` 的视觉混淆，并清理私有手写函数。
2. **DIM-05 的写声明**（[`plans/05-plan-dim-05-session-terminal.md:575`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/05-plan-dim-05-session-terminal.md#L575)）：
   - 修改 `terminalScreen.tsx`，彻底删除 fallback 双真理分支（`terminalText || bufferedLines`），消除 $O(N)$ 遍历，接入单真理 Store。
3. **DIM-06 的写声明**（[`plans/06-plan-dim-06-ui-ux.md:758`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md#L758)）：
   - 修改 `terminalScreen.tsx`，删除第 91-99 行的手写返回按钮 JSX，替换为统一的 `<HeaderBackButton>`，并使用 `dualHitSlop(36)` 扩展底部悬浮按钮的触控热区。
4. **并发冲突风险推演**：
   - 尽管 DIM-01 在阶段 0 率先完成，但在后续推进中，**DIM-05（阶段 3B）与 DIM-06（阶段 2B/阶段 3）极可能同时处于活跃实现状态**；
   - 两个 Agent 同时检出 `terminalScreen.tsx` 并对不同行数进行编辑，主控在执行 Git 收口时必将遭遇激烈的代码冲突，或因引擎的写路径互斥锁（I4-M3）导致后写入者直接报错崩溃。

#### 判定与仲裁（必须改 · Blocker 4）
- **修复决断**：
  - **收拢文件所有权**：将 `terminalScreen.tsx` 的所有权**独占划归 DIM-05**；
  - **责任交接**：
    - DIM-06 只负责在 `src/presentation/components/ui/` 中实现好原子 `<HeaderBackButton>` 并通过单测；
    - DIM-06 **严禁修改 `terminalScreen.tsx`**，将其移出 DIM-06 的 Writable Scope；
    - 由 DIM-05 在阶段 3B 重构 `terminalScreen.tsx` 时，一次性吸收 DIM-06 的 `<HeaderBackButton>` 替换与热区修复，彻底实现单点写入。

---

### 3.3 并行重叠冲突二：`pairManualScreen.tsx` 双维并发冲突（DIM-03 vs DIM-06）（Blocker 5）

#### 现场证据与冲突机理
1. **DIM-03 的写声明**（[`plans/03-plan-dim-03-pairing-gateway.md:413`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/03-plan-dim-03-pairing-gateway.md#L413)）：
   - 修改 `src/presentation/pair/pairManualScreen.tsx`，删除表现层手写的 `formatPairCodeDraft`，改为从领域层 `src/pairing/cxnCode.ts` 引入单一真理纯函数，实现双向可逆对拍。
2. **DIM-06 的写声明**（[`plans/06-plan-dim-06-ui-ux.md:759`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md#L759)）：
   - 修改 `src/presentation/pair/pairManualScreen.tsx`，将原生 TextInput 替换为原子 `<Input>`（落地 ~5.8% 柔边与 0 重阴影），删除第 253-261 行的手写返回按钮并替换为 `<HeaderBackButton>`。
3. **并发冲突风险推演**：
   - 依据 Master Plan DAG，DIM-03 处于【阶段 2A】，DIM-06 处于【阶段 2B】；
   - 两个子 Agent 被主控同时派发并行开发，同时向 `pairManualScreen.tsx` 写入不同的 JSX 与 Import，必然发生严重的写覆盖事故。

#### 判定与仲裁（必须改 · Blocker 5）
- **修复决断**：
  - **收拢文件所有权**：将 `pairManualScreen.tsx` 的表现层所有权**独占划归 DIM-06**；
  - **职责解耦**：
    - DIM-03 专心在 `src/pairing/cxnCode.ts` 中下沉并导出 `formatPairCodeDraft`，并完成纯算法单测；DIM-03 **严禁触碰 `pairManualScreen.tsx`**；
    - DIM-06 在阶段 2B 改造 `pairManualScreen.tsx` 时，同时引入 `<Input>`、`<HeaderBackButton>` 以及从 `cxnCode.ts` 导入 `formatPairCodeDraft`，一枪收口。

---

### 3.4 权责交叠冲突三：`secureStore.ts` & 测试双维重复认领（DIM-01 vs DIM-03）（Blocker 6）

#### 现场证据与重复认领暴露
1. **DIM-01 的写声明**（[`plans/01-plan-dim-01-dead-code.md:440-444, 523-524`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md#L440-L444)）：
   - 任务：核销 SecureStore 未引用的 Nonce 读写接口（`saveExchangeNonce`、`loadExchangeNonce`、`clearExchangeNonce`）；
   - 文件：修改 `apps/crish-mobile/src/db/secureStore.ts`（删除 20 行）并清理 `secureStore.test.ts:131-138` 的测试用例。
2. **DIM-03 的写声明**（[`plans/03-plan-dim-03-pairing-gateway.md:329, 411, 420`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/03-plan-dim-03-pairing-gateway.md#L329)）：
   - 任务项 DEL-03：清理未引用的 Nonce 读写接口与键（`KEYS.EXCHANGE_NONCE`、`saveExchangeNonce`、`loadExchangeNonce`、`clearExchangeNonce`）；
   - 文件：修改 `apps/crish-mobile/src/db/secureStore.ts` 并修改 `secureStore.test.ts`。

#### 判定与仲裁（必须改 · Blocker 6）
- **根因**：同一项死代码清理工作被 DIM-01（基座死层）与 DIM-03（网关安全）双重认领，两份详案不仅对修改内容高度重叠，甚至单测行号定位都发生细微打架（131-138 vs 124-137）。
- **修复决断**：
  - 依据“负产出绝对先行”铁律，所有死接口与死单测的物理清理**全权归属 DIM-01（阶段 0）一次性核销完毕**；
  - DIM-03 必须从其可写文件清单（Section 4.1）中**完全剔除 `src/db/secureStore.ts` 与 `secureStore.test.ts`**，DIM-03 仅对该模块保留只读权限（直接调用现存合法的 `loadPairingCredential` 等凭据接口）。

---

### 3.5 物理删除竞争四：`pairScanScreen.tsx` 双维重复删除（DIM-01 vs DIM-06）（Suggestion 1）

#### 现场证据与重复删除
- **DIM-01**（[`plans/01-plan-dim-01-dead-code.md:377`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md#L377)）：物理删除 `src/presentation/pair/pairScanScreen.tsx` 与 `pairScanScreen.test.tsx`。
- **DIM-06**（[`plans/06-plan-dim-06-ui-ux.md:764-765`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md#L764-L765)）：刚性物理删除清单再次列出 `pairScanScreen.tsx` 与 `pairScanScreen.test.tsx`。
- **裁决**：删除动作归属 DIM-01 执行；DIM-06 删除清单中核销此项，仅保留对 `pairWelcomeScreen.tsx` 中扫码入口按钮的移除。

---

### 3.6 串行文件域收敛时序核查

针对在不同阶段被串行修改的文件进行版本基线继承性核对：
1. **`apps/crish-mobile/src/adapters/wiring/feedBridge.ts`**：
   - DIM-03 在阶段 2A 修改其首帧订阅、订阅回执与 `fullReplay` 游标清空；
   - DIM-05 在阶段 3B 修改其 `unloadExcessWindows`，注入前台正视锁（Foreground Guard）；
   - **核验结论**：时序为 Stage 2A $\to$ Stage 3B，因果严格单调。DIM-05 必须在详案中显式注明“以 DIM-03 交付后的 `feedBridge.ts` 为基准代码进行增量增强”，严禁回滚 DIM-03 的网络逻辑。
2. **`apps/crish-mobile/src/presentation/components/blocks/EventRow.tsx`**：
   - DIM-01 在阶段 0 移除私有时钟函数并收敛至 `time.ts`，清理 `tool-update`；
   - DIM-05 在阶段 3B 补齐 27 类事件人话摘要、短标签与错误级别标红；
   - **核验结论**：时序为 Stage 0 $\to$ Stage 3B，严格单调，无写冲突隐患。
3. **`apps/crish-mobile/src/presentation/components/files/fileMeta.ts`**：
   - DIM-01 在阶段 0 移除重复手写相对时间算法并收敛至 `time.ts`；
   - DIM-06 在阶段 2B 将 5 处硬编码 Hex 图标色现代化重构为 HSLA Token；
   - **核验结论**：时序为 Stage 0 $\to$ Stage 2B，严格单调，修改代码块正交，无冲突。

---

## 四、【跨端协议契约闭环】双端源码逐行对拍

本节深入桌面端 Rust 内核（[`ws.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs)）与移动端各网络网关与桥接器的真实源码，逐字段、逐状态机核对协议闭环。

---

### 4.1 协议致命 Bug：`EndpointResolver` 提取 `authStore.getState().token` 的类型幻觉（Blocker 7）

#### 源码穿透证据与致命缺陷揭露
1. **DIM-03 详案的实施指令**：
   - 文件：[`docs/mobile-revival-audit/plans/03-plan-dim-03-pairing-gateway.md:122`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/03-plan-dim-03-pairing-gateway.md#L122)
   - 描述：“同步更新 `observationWiring.ts:85-89` 中提取 `authStore.getState().token` 传入 `resolveWsUrl`”。
2. **移动端 `authStore.ts` 真实类型源码**：
   - 文件：[`apps/crish-mobile/src/domain/store/authStore.ts:35-43, 82`](file:///c:/Software/conex/apps/crish-mobile/src/domain/store/authStore.ts#L82)
   ```typescript
   export interface TokenMeta {
     /** 是否持有令牌材料（token_key/refresh_key） */
     hasToken: boolean;
     /** 令牌签发时刻 ms（pair.ok ttl 语义；null = 未知） */
     issuedAt: number | null;
     /** 令牌有效时长 ms（null = 未知/长期） */
     ttlMs: number | null;
   }
   
   export interface AuthState {
     // ...
     /** 令牌元数据（hasToken/issuedAt/ttl；密钥明文在 secure-store） */
     token: TokenMeta;
     // ...
   }
   ```
   - **源码铁证**：`authStore.getState().token` **是一个包含 3 个元属性的 `TokenMeta` 对象，绝对不是令牌字符串！**
   - 项目在架构设计之初就确立了铁律（`authStore.ts:4-7`）：“密钥材料明文不落本 store，仅 secure-store 持有”。
3. **调用后果推演**：
   - 若实施工程师严格按照 DIM-03 详案编写：
     `resolveWsUrl(host, DEFAULT_GATEWAY_PORT, engineTlsEnabled(), authStore.getState().token)`
   - 首先触发 TypeScript 编译报错：`TS2345: Argument of type 'TokenMeta' is not assignable to parameter of type 'string'`;
   - 即使通过类型强转（如 `String(...)`），产出的 URL 将变成：
     `wss://192.168.1.5:8765/v1/events?token=%5Bobject%20Object%5D`；
   - 桌面端 Axum WebSocket 升级鉴权器（[`ws.rs:600-625`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs#L600-L625)）调用 `tokens.verify(token, now_ms())`，判定签名 100% 失败，直接返回 **HTTP 401 Unauthorized 拒连**！
   - 移动端会话长连接彻底瘫痪。

#### 判定与闭环仲裁（必须改 · Blocker 7）
- **真理源追溯**：
  在冷启动水合（`PairingWiring.hydrate`）与配对成功（`PairingWiring.finalizePairing`）链路中，真正的会话访问令牌字符串来自于：
  1. 从安全存储加载的凭据：`cred = await loadPairingCredential(this.driver)` $\to$ `cred.tokenKey`（[`PairingWiring.ts:273`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts#L273)）；
  2. 配对成功响应：`ok.token`（[`PairingWiring.ts:687`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/pairing/PairingWiring.ts#L687)）；
  3. `PairingWiring` 经 `connectSessionOnce` 调用 `defaultConnectSession(ctx)`，将字符串明文传入了 `ensureObservationWiring({ token: ctx.token })`（[`sessionSigning.ts:94`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/pairing/sessionSigning.ts#L94)）。
- **修复决断**：
  必须彻底废除从 `authStore.getState().token` 读取字符串的虚构逻辑，改为：
  1. 在 `PairingWiring.ts:269`：
     `url: resolveWsUrl(host, DEFAULT_GATEWAY_PORT, engineTlsEnabled(), cred.tokenKey)`；
  2. 在 `PairingWiring.ts:679`：
     `url: this.urlOverride ?? resolveWsUrl(this.pairingHost, DEFAULT_GATEWAY_PORT, engineTlsEnabled(), ok.token)`；
  3. 在 `observationWiring.ts:87` 中：
     `const url = envUrl ?? (host ? resolveWsUrl(host, DEFAULT_GATEWAY_PORT, engineTlsEnabled(), opts.token) : null)`；
  通过参数链路将真正的明文凭据注入 `resolveWsUrl`，实现 100% 鉴权握手闭环。

---

### 4.2 幂等性黑洞：Outbox 重试丢失 `item.msgId` 引发 409 虚假冲突（Blocker 8）

#### 现场证据与幂等性破缺
1. **Outbox 数据模型的设计初衷**：
   - 文件：[`apps/crish-mobile/src/domain/data/outbox.ts:24-34`](file:///c:/Software/conex/apps/crish-mobile/src/domain/data/outbox.ts#L24-L34)
   - `OutboxItem` 显式维护了 `msgId: string` 字段，并在入队时通过固定算法赋值（[`approvalWiring.ts:516`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L516)）；
   - 注释明确声明：“重发幂等时保持 msgId 不变（D3 §5.4 / M6 §9.2，由 outbox 层保证）”。
2. **`WsGateway.invoke` 的现实破缺**：
   - 查阅 [`apps/crish-mobile/src/network/WsGateway.ts:362-370`](file:///c:/Software/conex/apps/crish-mobile/src/network/WsGateway.ts#L362-L370)：
   ```typescript
   invoke<T>(kind: string, body: unknown, timeoutMs?: number): Promise<T> {
     return new Promise<T>((resolve, reject) => {
       // ...
       const msgId = nextMsgId(this.msgIdPrefix); // ！！！无条件生成全新随机 msgId
   ```
   - `WsGateway.invoke` 根本不接受外部传入 `msgId`，每次调用都强制重新生成 `m-mob-xxxx-random`；
   - 在 `ApprovalBridge.sendOne(item)`（[`approvalWiring.ts:368`](file:///c:/Software/conex/apps/crish-mobile/src/adapters/wiring/approvalWiring.ts#L368)）中，直接调用了 `this.gateway.invoke(req.kind, req.body)`，`item.msgId` 完全被架空遗弃！
3. **网络抖动下的虚假冲突灾难**：
   - 移动端向桌面端发送 `remote.approve`；
   - 桌面端收到并成功执行内核工具批准，正准备回包时，局域网瞬断或客户端触发 10 秒超时；
   - 移动端 Outbox 将该条目标记为 `failed`，并排期退避重试（`scheduleBackoffRetry`）；
   - 1 秒后重试触发，`sendOne(item)` 再次发送，但此时被赋予了**全新的 `msgId`**；
   - 桌面端内核（[`core_backend.rs:701-703`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/core_backend.rs#L701-L703)）检查该 `toolCallId`，发现该审批已被上一轮处理完毕（不在 pending 集合中），依据规范返回 **409 Conflict (`cmd.approval_mismatch`)**；
   - 移动端 `approvalWiring.ts:377-381` 收到 `cmd.approval_mismatch`，判定命中终局冲突错误码，直接执行：
     `approvalStore.getState().markDecisionConflict(item.toolCallId)`；
   - **用户界面瞬间弹出醒目的红字报错：“该请求已被其他设备处理”**！
   - 用户陷入困惑：明明是我自己点的通过，为何系统提示被他人处理？系统幂等性与一致性彻底破裂。

#### 判定与仲裁（必须改 · Blocker 8）
- **修复决断**：
  - 改造 `WsGateway.invoke` 方法签名，允许可选传入出站 `msgIdOverride?: string`；
  - 在 `ApprovalBridge.sendOne(item)` 中，将 `item.msgId` 显式透传给 `gateway.invoke`；
  - 保证 Outbox 条目无论经历多少次网络重试与退避，其跨端物理帧的 `msgId` 恒定不变，严格兑现 D3 §5.4 跨端幂等契约。

---

### 4.3 契约越界隐患：DIM-04 规划修改 `device-protocol.json` 却未声明文件域（Suggestion 2）

#### 现场证据
- 在 [`plans/04-plan-dim-04-approval-outbox.md:105-107`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/04-plan-dim-04-approval-outbox.md#L105-L107)，DIM-04 声明要修改 `crates/conex-types/contracts/device-protocol.json`，将 `listPendingApprovals` 的 `registered` 由 `false` 改为 `true`；
- 但在其第 375-390 行的“唯一文件域”中，却未将该文件纳入 Writable Scope；同时第 398 行还设定了“严禁修改公共类型包源代码”的红线；
- 实际上，桌面端 [`core_backend.rs:736`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/core_backend.rs#L736) 已经完整实现了 `list_pending_approvals` 逻辑，且 WebSocket 路由直接挂载在 Axum 内核。
- **裁决建议**：DIM-04 无需触碰 `device-protocol.json`（避免触发重新生成 bindings 影响全局），直接在 `ws.rs` 内部路由对接 `backend.list_pending_approvals` 即可，保持跨包干净。

---

### 4.4 远程命令与三态信封闭环：`ws.rs` `MessageKind::Remote` 与 `CommandResult` 严密性

经对桌面端信封系统 [`crates/conex-types/src/device/envelope.rs`](file:///c:/Software/conex/crates/conex-types/src/device/envelope.rs) 与命令系统 [`commands.rs`](file:///c:/Software/conex/crates/conex-types/src/device/commands.rs) 穿透核对：
1. **出站信封序列化**：
   - 桌面端调用 `send_envelope(ctx, MessageKind::Result(cmd), command_result)`；
   - `MessageKind::Result("approve")` 在网络线路上精准序列化为 `"result.approve"`（[`envelope.rs:204, 213`](file:///c:/Software/conex/crates/conex-types/src/device/envelope.rs#L204)）；
   - `CommandResult` 包含 `{ reqMsgId, ok, result, error }`（[`commands.rs:67-83`](file:///c:/Software/conex/crates/conex-types/src/device/commands.rs#L67)）；
2. **入站信封解析**：
   - 移动端 `decodeFrame` 解析该帧，`DEVICE_KINDS` 包含全部 37 个 `result.*`（[`kinds.ts:9`](file:///c:/Software/conex/packages/shared-types/src/generated/device/kinds.ts#L9)）；
   - `WsGateway.routeResponse`（[`WsGateway.ts:468-477`](file:///c:/Software/conex/apps/crish-mobile/src/network/WsGateway.ts#L468-L477)）精准提取 `body['ok'] === true` $\to$ `resolve(body['result'])`，提取 `body['ok'] === false` $\to$ `reject(gatewayErrorFromBody(body['error']))`；
3. **核验结论**：协议帧两端在序列化结构、字段命名（camelCase）和成功/失败状态分发上 **100% 严丝合缝**。

---

### 4.5 会话订阅与对账重放闭环：`events.subscribe` / `events.subscribe.ok` / `fullReplay` 窗口重置

1. **推流与对账断裂根治**：
   - DIM-03 补齐移动端建连后立即发送 `events.subscribe`（携带关注的会话与本地最大游标）；
   - 桌面端 [`ws.rs:1227-1304`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs#L1227-L1304) 激活 `FanOutEmitter` 过滤器，并返回 `events.subscribe.ok`（携带各会话最新游标与 `stale` 判定）；
2. **重放丢弃致命 Bug 根治**：
   - 移动端 `FeedBridge.handleProjection` 在处理 `fullReplay` 时，原代码直接从 0 重放但未清空窗口，导致本地 `window.lastSeq` 保持高位，重放数据因 `seq <= window.lastSeq`（[`event-ring-window.ts:75`](file:///c:/Software/conex/packages/shared-utils/src/event-ring-window.ts#L75)）全部被当成 duplicate 丢弃；
   - DIM-03 方案强制注入 `eventStore.getState().unloadWindow(sessionId)`，将窗口游标物理清零，彻底治愈重放白屏缺陷；
3. **核验结论**：长连接推流、断线重连对账与游标生命周期 **100% 形成闭环**。

---

### 4.6 传输层握手与安全基线：TLS / Cleartext 流量策略与 HTTP 101 Upgrade 升级鉴权

1. **路由与端点**：
   - 桌面端路由仅在 `/v1/events`（[`ws.rs:77`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/server/ws.rs#L77)）挂载 WS 升级通道；DIM-03 将 `resolveWsUrl` 统一修正为拼接 `/v1/events`，彻底消灭根路径 404；
2. **局域网明文流量许可**：
   - Android 9+ 默认封锁未加密 HTTP/WS 流量；DIM-07 在 `app.json` 中配置 `"usesCleartextTraffic": true`（[`07-plan-dim-07-packaging.md:115`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/07-plan-dim-07-packaging.md#L115)），iOS 配置 `NSAllowsLocalNetworking: true`；
   - 彻底避免在局域网调试与私有部署时被操作系统底层 OkHttp / WebKit 静默拦截。

---

## 五、【文末终审判定给主控】（裁决汇总与整改清单）

基于前述对总纲及 7 份详案的立体化穷举审查，本终审专员出具最终审计裁决清单。主控 Agent 在正式拉起编码实施前，**必须对以下 8 项阻断级缺陷进行就地修订**：

### 5.1 必须改项（Blocker，共 8 项）

| 编号 | 归属维度 / 模块 | 缺陷定性与定位 | 阻断根因与危害 | 强制整改行动指令 |
| :---: | :--- | :--- | :--- | :--- |
| **BLK-01** | **DIM-01 / DIM-06** | `themeProjection.ts` 提前删除断环<br>([`01-plan:383`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/01-plan-dim-01-dead-code.md#L383)) | DIM-01 阶段 0 删除了仍被 8 个组件引用的文件，导致阶段 1 DIM-02 报 8 个 TS 找不到模块错误，流水线中断。 | **整改**：DIM-01 阶段 0 暂不删除该文件；保留至阶段 2B DIM-06 完成 8 处引用替换后再由 DIM-06 物理 `git rm`。 |
| **BLK-02** | **DIM-01 / DIM-02 / DIM-05** | `terminalLineBuffer.ts` 归属矛盾<br>([`02-plan:303`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/02-plan-dim-02-type-contract.md#L303)) | DIM-02 误断言 DIM-01 已下沉该文件；而 DIM-01 仅删了 16 行，真正下沉是在 DIM-05 阶段 3B。 | **整改**：修改 DIM-02 详案图谱与文字，删除“DIM-01 下沉”的假定；锁定下沉归属且仅归属于 DIM-05。 |
| **BLK-03** | **02-Master-Plan / DIM-06** | Master Plan 缺少 `D2 --> D6` 边<br>([`02-master:80`](file:///c:/Software/conex/docs/mobile-revival-audit/02-master-revival-plan.md#L80)) | Master Plan 允许 DIM-06 与 DIM-02 并发，DIM-06 会被现存 22 处 TS 报错卡死门禁。 | **整改**：在 Master Plan 与 DIM-07 的 Mermaid 拓扑中强行补入 `D2 --> D6` 依赖边，约束 DIM-06 必须在 DIM-02 后启动。 |
| **BLK-04** | **DIM-01 / DIM-05 / DIM-06** | `terminalScreen.tsx` 三维写冲突<br>([`06-plan:758`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/06-plan-dim-06-ui-ux.md#L758)) | DIM-01 改颜色、DIM-05 改单真理流、DIM-06 改返回按钮与热区，并发修改必然代码冲突。 | **整改**：将 `terminalScreen.tsx` 独占写权限划归 DIM-05。DIM-06 移出该文件，由 DIM-05 一并收口返回按钮与热区。 |
| **BLK-05** | **DIM-03 / DIM-06** | `pairManualScreen.tsx` 并发写冲突<br>([`03-plan:413`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/03-plan-dim-03-pairing-gateway.md#L413)) | 阶段 2A DIM-03 与阶段 2B DIM-06 同时对该屏幕写代码，触发写锁互斥或 Git 冲突。 | **整改**：将表现层 `pairManualScreen.tsx` 独占划归 DIM-06。DIM-03 仅负责在 `cxnCode.ts` 导出纯函数，移出该页面。 |
| **BLK-06** | **DIM-01 / DIM-03** | `secureStore.ts` 及单测重复认领<br>([`03-plan:411`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/03-plan-dim-03-pairing-gateway.md#L411)) | DIM-01 与 DIM-03 同时认领删除 Nonce 接口，修改同一文件与测试。 | **整改**：删除权限全权归属 DIM-01（阶段 0）。DIM-03 彻底剔除这两个文件的写权限，改为只读。 |
| **BLK-07** | **DIM-03** | `authStore.getState().token` 类型幻觉<br>([`03-plan:122`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/03-plan-dim-03-pairing-gateway.md#L122)) | `authStore.getState().token` 是 `TokenMeta` 对象而非字符串，直接传入 `resolveWsUrl` 报 TS 错且产生 401 拒连。 | **整改**：废除读 store 逻辑；会话 token 必须经 `PairingWiring`（`cred.tokenKey` / `ok.token`）传参注入 `resolveWsUrl`。 |
| **BLK-08** | **DIM-04** | Outbox 重试丢 `msgId` 引发 409 虚假冲突<br>([`04-plan:40`](file:///c:/Software/conex/docs/mobile-revival-audit/plans/04-plan-dim-04-approval-outbox.md#L40)) | `WsGateway.invoke` 无条件新建 `msgId`，重试被桌面当新请求报 409，移动端误报“被其他设备处理”。 | **整改**：`WsGateway.invoke` 支持透传 `msgIdOverride`；`ApprovalBridge.sendOne` 必须传入 `item.msgId` 保证重发幂等。 |

---

### 5.2 建议改项（Suggestion，共 4 项）

1. **SUG-01（清退重复删除认领）**：`pairScanScreen.tsx` 的物理删除由 DIM-01 统一执行，DIM-06 详案删除该文件的物理删除条目，仅保留入口移除；
2. **SUG-02（保持契约包只读）**：DIM-04 无需修改 `crates/conex-types/contracts/device-protocol.json`，直接在 `ws.rs` 内核对接 `backend.list_pending_approvals`，避免扰动公共 bindings 生成；
3. **SUG-03（未知命令错误信封统一）**：在 `ws.rs` 的 `handle_remote_command_frame` 中，对不支持的命令统一回送 `send_envelope(ctx, MessageKind::Result(cmd.to_string()), CommandResult::failure(msg_id, ...))`，确保移动端 `WsGateway.routeResponse` 能正确匹配并消费 Pending 请求；
4. **SUG-04（规范测试移出相对路径）**：DIM-01 将 8 个单测移入 `src/presentation/__tests__/routes/` 时，建议统一使用 `@/../app/(tabs)/files` 别名导入，避免由于 `../../../../` 过多造成的层级视觉疲劳。

---

### 5.3 可接受风险（Risk，共 3 项）

1. **RSK-01（自签名证书握手弹窗）**：局域网启用 `wss://` 时，移动端（特别是 iOS）可能因根证书不受信拒绝连接。**对策**：开发期与本地局域网环境下建议采用明文 `ws://`（`usesCleartextTraffic: true` 已放行），生产级分发再绑定合法域名证书；
2. **RSK-02（Expo SDK 57 与 React Compiler 兼容性）**：`app.json` 中配置了 `"reactCompiler": true`。若个别复杂 Hook 出现编译警告，属于 Expo 实验性特性容错范围，不阻断原生打包；
3. **RSK-03（Android 备份还原密钥失效）**：尽管已配置 `"allowBackup": false`，若用户通过第三方 Root 工具强行迁移私有数据，仍可能导致 KeyStore 解密失败。**对策**：`secureStore.ts` 中已有 `try-catch` 降级自愈清空机制，风险可控。

---

### 5.4 终审放行结论

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      详案终审 Agent 1 · 综合裁决判定书                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 判定状态：【有条件通过 · 必须就地修订 8 项 Blocker 后方可启动实施】          │
│                                                                             │
│ 综合评估：                                                                  │
│ 1. 战略方向正确：7 份详案全面贯彻了“轻量观测与审批终端”的战略定位，坚决清退  │
│    SQLite 空心 DAO，彻底核销 3,200+ 行负产出债务，架构设计优雅；              │
│ 2. 局部存在断层：本终审精准揪出了“提取 TokenMeta 对象引发 401”、“Outbox 重试 │
│    丢失 msgId 引发 409 虚假冲突”、“提前删除别名引发阶段 1 TS 雪崩”等 8 项    │
│    极其隐蔽但致命的代码与协议断层；                                         │
│ 3. 行动指令：请主控 Agent 立即根据本报告第五节整改清单，就地更新对应详案的  │
│    文字描述、文件白名单与代码契约，闭合上述 8 项 Blocker 后，立即放行实施！  │
└─────────────────────────────────────────────────────────────────────────────┘
```

终审报告出具完毕，已全量落盘至：  
`c:/Software/conex/docs/mobile-revival-audit/plan-reviews/04-final-review-contracts-and-dag.md`！
