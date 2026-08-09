# M4 移动端 UI/UX 体系与前后端分离架构方案

> 文档编号：M4-mobile-ui-architecture
> 系列：crish 多端互通（multi-device）
> 版本：v1.0（草案评审稿）
> 日期：2026-08-09
> 状态：待主控评审
> 目标读者：主控调度者、D 系列/F 系列其他子方案、实现阶段（PE 系列）任务书作者
> 输入文档：`docs/multi-device/plans/D4-mobile-tech.md`（技术选型）、`F1-monitor-panels.md`（监控域）、`F2-approval-center.md`（审批域）、`F3-event-stream-terminal.md`（事件流/终端域）、`F4-files-assets.md`（文件域）、`F5-session-messages.md`（会话域）、`F6-settings-account.md`（设置域）、`R2B-legacy-mobile-tech.md`（旧原型教训）
> 桌面参照代码：`apps/crish-desktop/src/styles/tokens.css`、`src/styles/design-system.css`、`src/components/ui/`（原子层）、`src/components/overview/`、`src/components/settings/` 等（文中逐处标注）

---

## 0. 文档信息与决策摘要

### 0.1 一句话结论

移动端 UI 采用「**表现层（纯组件）— 中间件适配层（view-model + 订阅绑定）— 领域层（vanilla zustand store + 仓库 + 服务）**」三层解耦架构：表现层只换组件（未来可整体替换为 Tamagui / 鸿蒙 ArkUI），领域层以 `createStore`（vanilla zustand）为核心、不依赖任何 UI 框架，换 UI 框架时 100% 保留；设计系统为**自研轻量 token 体系**（对齐桌面 `tokens.css` 语义名，浅色暖灰 / 深色炭灰双色板，中文 14px 基准），组件库**自研约 20 个原子组件**（不引 gluestack/tamagui），图标走 **lucide-react-native + react-native-svg 配套安装**（吸取旧原型漏装 peer 依赖的教训，统一经自研 Icon 组件隔离替换面）；导航为 **5 Tab（首页 / 会话 / 审批 / 文件 / 设置）+ Stack 深链页**的信息架构，事件流并入会话详情、用量/诊断入设置，审批中心占 Tab 位并承载角标与推送深链。

### 0.2 关键决策清单（结论先行）

| 决策点 | 结论 | 一句话理由 |
| --- | --- | --- |
| 分层架构 | 表现层 / 适配层 / 领域层三层（领域层内再含 store-仓库-服务） | 换 UI 框架只重写表现层，领域层零改动（任务核心诉求） |
| 领域层状态 | zustand v5 **vanilla `createStore`** + immer；React 绑定（`useStore`）收敛到适配层 | 与桌面同构（zustand+immer 范式）但剥离 React 依赖，换框架不换 store |
| 适配层 | view-model（`useXxxScreenModel`）+ 订阅绑定 + 手势/图标/字体封装 | 纯组件与 store 之间唯一桥梁，props in / events out 契约在此定义 |
| 导航 | expo-router v6：5 Tab + Stack + 深链（D4 已定技术，M4 定结构） | 深链即路由，推送点击直达审批卡/run 详情 |
| Tab 结构 | 首页 / 会话 / 审批 / 文件 / 设置（5 Tab，含角标） | 整合 F1（4 Tab 建议）与 D4（5 Tab 含审批）的分歧，审批是移动端第一功能必须占 Tab 位 |
| 事件流归属 | F3 feed 并入会话详情（分段控件「消息 / 事件流」），run 详情与终端走 Stack | 避免 feed 与消息流双份视图重复；run 级时间线保留独立页 |
| 设计 token | 自研 TS token 对象，语义名**逐项对齐**桌面 `tokens.css` | 品牌一致性：浅色暖灰（hsl(35,12%,94%) 系）、深色炭灰（hsl(0,0%,5%) 系）、语义色同源 |
| 组件库 | 自研轻量（约 20 个原子组件），不引 gluestack / tamagui | 功能面窄 + 鸿蒙 ArkUI 不可移植 + 包体与可控性（§3.6 评估） |
| 图标 | lucide-react-native + **`npx expo install react-native-svg` 配套安装**；统一经自研 `Icon` 组件使用 | R2B 教训：旧原型漏装 peer 依赖直接启动崩溃；自研 Icon 封装隔离图标库替换面 |
| 字体 | 系统字体（iOS SF / Android Roboto + 系统中文），不内嵌字体文件 | 中文内嵌字体体积大且动态字体（系统缩放）支持差 |
| 深链 | `crish://` 前缀 + 路由白名单（D4 §8.6 已定安全面） | 推送点击与页面导航统一入口 |
| 动效 | reanimated 克制四类：页面转场 / 按压反馈 / 滑动确认 / 列表增删 | 远程伴侣场景低动效密度；`reduce-motion` 尊重系统设置 |
| 测试 | jest-expo + @testing-library/react-native（组件）+ 快照（视觉）+ maestro（E2E）+ 分层 import 门禁 | 与桌面测试心智同构；分层门禁防越层 import 回归 |

### 0.3 与既有文档的关系

- **技术选型以 D4 为准**：Expo SDK 57 / RN 0.86 / zustand / expo-router / expo-sqlite / expo-secure-store / RN 内建 WebSocket / expo-notifications——M4 不重新选型，只在其上细化 UI 架构与交互。
- **功能面以 F1-F6 为准**：各功能域的面板与交互是 M4 的输入，M4 负责「整合为最终屏幕清单 + 统一导航 + 统一交互语言」。F1-F6 之间对 Tab 结构、导航形态存在分歧（F1 §4.1 四 Tab 无审批、D4 §5.0 五 Tab 含审批、F6 §12.1 三 Tab），**由 M4 裁决**（§4.1）。
- **旧原型教训以 R2B 为准**：lucide 缺 react-native-svg、firebase 双包缺配置、react-navigation 系被弃、依赖面无人管理——M4 在 §3.5 与 §11 给出对应防线。
- **桌面设计语言以 `tokens.css` / `design-system.css` 为准**：移动端 token 语义名逐项对齐，不发明第二套命名（§7）。

### 0.4 术语表

| 术语 | 含义 |
| --- | --- |
| 表现层（presentation） | 纯组件与页面编排：props in / events out，不直接触碰 store 与网络 |
| 适配层（adapters） | view-model（页面级状态组合与命令映射）、store 订阅绑定、平台封装（图标/字体/手势/剪贴板） |
| 领域层（domain） | 与 UI 无关的业务核心：vanilla zustand store、仓库（数据访问）、服务（WS/推送/配对）、纯函数与类型 |
| view-model | 页面级「状态 × 命令」投影：把多个 store 切片 + 派生数据组装为页面所需的单一视图状态 |
| 深链 | `crish://` 应用内路由：推送点击与页面导航的统一入口（D4 §5.0 定义） |
| 原子组件 | 表现层最底层 UI 部件（Button/Input/Card 等），不感知业务 |
| 页面组件 | 表现层的屏幕级组件（由原子/区块组件组装），持有 view-model |
| 五色分组 | run 十态在移动端的展示分组：灰/蓝/黄/红/绿（F1 §5.1 定义，M4 固化到 token 层） |

---

## 1. 背景与设计定位

### 1.1 产品定位：远程伴侣（承接 D4 §1.1）

移动端不是桌面的缩小版，而是「远程伴侣」：桌面持续运转（长任务、cron、子代理、审批等待），用户在碎片时间用手机完成五类事——**审批、事件/终端流查看、文件浏览、状态监控、推送通知**（D4 §1.1 表）。这一定位决定了 UI 的三个基调：

1. **只读优先、轻量动作**：浏览 > 编辑；唯一高频写动作是审批决策（F2），其余写能力（文件编辑、发起会话）均默认关闭或 P2。
2. **一屏一任务**：每屏只承载一个主任务（看状态 / 找会话 / 处理审批 / 看文件 / 调设置），不做桌面式聚合大杂烩（F1 §7.1）。
3. **诚实化状态**：无数据不显示 0% 误导、断线灰化旧数据不伪造新数据、未知状态透传保真（F1 §4.7 / F2 §2.6 延续）。

### 1.2 M4 的职责边界

| 层 | 归属 | 本方案内容 |
| --- | --- | --- |
| UI/UX 体系 | M4 | 分层架构、设计系统、导航结构、屏幕清单、交互规范、主题、性能、可替换性、测试 |
| 技术选型 | D4 | Expo/RN/zustand/expo-router 等版本与理由 |
| 功能面板 | F1-F6 | 各域面板内容、数据源、交互细节 |
| 协议与安全 | D1/D3/D5/D6/D7 | WS 帧、配对、推送、同步、安全基线 |

M4 与 F1-F6 的关系是「**整合与统一**」：F 文档各自定义「这个功能长什么样、怎么交互」，M4 定义「所有功能如何共存在一个 App 里、共用一套视觉与交互语言、未来如何整体换皮」。冲突裁决权：导航结构（§4）、交互规范（§6）、设计 token（§3）以 M4 为准；功能面板数据细节以 F 文档为准。

### 1.3 设计原则（贯穿全篇）

1. **可替换性优先**（任务核心）：UI 框架是可替换的消费品，领域逻辑是资产。一切组件不直接 import store/网络；一切 UI 框架 API（View/Text/Animated/Platform）只出现在表现层与适配层。
2. **与桌面同构的心智**：状态范式（zustand+immer）、错误码（`CrishErrorCode`）、run 五色分组、语义色 token 名全部与桌面对齐，双端零心智差（D4 §2.1-5）。
3. **触控优先设计**：可点击区域 ≥44dp、拇指热区布局（决策按钮固定底部）、危险操作双保险（滑动/二次确认）。
4. **低功耗美学**：动效克制、后台零轮询、流式渲染节流合并（F3 §3.4 复用）、无重型依赖。
5. **平台原生优先**：手势返回/下拉刷新/长按菜单/系统分享/生物识别用平台原生能力，不自造轮子（F1 §4.6 诊断复制即用长按）。
6. **安全默认**：敏感文件不缓存、审批决策防误触、配对码/令牌安全展示（承接 D5）。

---

## 2. 前后端分离架构（核心）

### 2.0 章节目标与术语

本章回答任务书核心问题：**移动端内部分层——表现层（UI）与领域层（数据/状态/网络）解耦**。目标是「换 UI 框架只换表现层」，为此需要三层边界清晰、依赖单向、且 store 不依赖 React。

D4 §4.1 已有五层（UI → 状态 → 数据 → 网络 → 存储）的粗分层；M4 在 D4 之上**细化为七层三域**，把「状态层」进一步拆为「领域 store（不依赖 UI）」与「适配绑定（依赖 React）」，这是换 UI 框架的关键一刀：

```
┌────────────────────────────────────────────────────────────────┐
│  表现层（presentation，可整体替换）                                │
│  app/ 路由骨架 + src/presentation/screens 页面组件               │
│  src/presentation/components/ 原子组件 + 区块组件 + 模板组件      │
├────────────────────────────────────────────────────────────────┤
│  适配层（adapters，随 UI 框架半替换）                              │
│  src/adapters/viewmodels/ 页面 view-model（状态×命令投影）        │
│  src/adapters/hooks/ useStore 订阅绑定（zustand React 绑定）      │
│  src/adapters/platform/ 图标/字体/手势/剪贴板/平台能力封装        │
├────────────────────────────────────────────────────────────────┤
│  领域层（domain，100% 保留，零 UI 依赖）                           │
│  src/domain/store/ vanilla zustand（createStore，7 个域）        │
│  src/domain/repositories/ 仓库（网络优先+缓存回退+离线入队）      │
│  src/domain/services/ WS 网关/重连/配对/推送注册/事件解析        │
│  src/domain/pure/ 纯函数与选择器（时间/ANSI/去重/合并/投影）       │
│  ─── 下方为领域层依赖的外部资源（网络/存储），不经 UI ───          │
│  src/domain/network/  ReconnectingWsClient / WsEnvelope / Http  │
│  src/domain/db/        SQLite DAO / secure-store 封装           │
└────────────────────────────────────────────────────────────────┘
```

### 2.1 七层三域：分层图（文件级）

```
┌──────────────────────────────────────────────────────────────────┐
│ L1 路由骨架        app/_layout.tsx（根 Stack+守卫）                 │
│                   app/(tabs)/_layout.tsx（TabBar 装配）            │
│                   app/**/*.tsx（每屏一个路由文件=深链命名空间）      │
├──────────────────────────────────────────────────────────────────┤
│ L2 页面组件        src/presentation/screens/*.tsx                  │
│                   （Screen 级：只组合 view-model 与区块组件）       │
├──────────────────────────────────────────────────────────────────┤
│ L3 区块/模板组件   src/presentation/components/blocks/*.tsx        │
│                   （ApprovalCard/EventRow/SessionRow/…）          │
│ L4 原子组件        src/presentation/components/ui/*.tsx            │
│                   （Button/Input/Card/Badge/ListRow/Switch/…）    │
├──────────────────────────────────────────────────────────────────┤
│ L5 适配层          src/adapters/viewmodels/*.ts（useApprovalListVm）│
│                   src/adapters/hooks/useAppStore.ts（订阅绑定）    │
│                   src/adapters/platform/{Icon,Font,Toast,Haptics} │
├──────────────────────────────────────────────────────────────────┤
│ L6 领域层-状态     src/domain/store/*.ts（vanilla createStore）    │
│                   src/domain/pure/selectors.ts（纯函数选择器）     │
├──────────────────────────────────────────────────────────────────┤
│ L7 领域层-数据     src/domain/repositories/*.ts                   │
│                   src/domain/services/*.ts（WsGateway/配对/推送）  │
│                   src/domain/pure/*.ts（去重/合并/ANSI/时间）      │
│                   src/domain/network/ src/domain/db/（被 L7 依赖） │
└──────────────────────────────────────────────────────────────────┘
   全部层只依赖 @crish/shared-types（类型/解析器/错误码），不发明业务协议
```

**依赖规则（单向，禁止跨跳）**：

```
L1/L2/L3/L4（表现层） ──► L5（适配层） ──► L6（领域 store） ──► L7（仓库/服务） ──► network/db
```

- 表现层只能依赖适配层（view-model / platform 封装），**禁止直接 import 领域层**（lint 门禁，§2.6）。
- 适配层只能依赖领域层与 React/RN 平台 API，**禁止 import 其他表现层组件**（view-model 不得感知组件）。
- 领域层**零 React/RN 依赖**（除类型层面），不 import 任何 `react-*` / `expo-*`（网络/存储库除外，见 §2.4 边界说明）。
- 领域层内部：store 只依赖 repositories 暴露的命令接口与 pure 纯函数，不依赖 services 实现细节（依赖倒置，测试可注入 fake）。

### 2.2 每层职责边界（文件级定义）

#### 2.2.1 表现层（L1-L4）：纯组件，props in / events out

| 子层 | 职责 | 允许 | 禁止 |
| --- | --- | --- | --- |
| L1 路由骨架 | 路由注册、守卫（AuthGuard）、TabBar 装配、深链落地 | expo-router API、适配层 store 绑定 | 业务逻辑、直接查 store 组装数据 |
| L2 页面组件 | 每屏的布局编排：`useXxxVm()` 取视图状态 → 渲染区块 → 事件回调转发给 vm 命令 | view-model（唯一数据入口）、区块组件 | import 领域 store / 仓库 / 服务；写业务判断 |
| L3 区块组件 | 业务卡片（审批卡/事件行/任务卡/文件行）与模板（列表容器/空态/骨架） | 原子组件、**props 数据**（领域类型在 `@crish/shared-types` 定义） | store/仓库/服务/view-model；区块之间互不 import |
| L4 原子组件 | 通用 UI 部件（Button/Input/Dialog/Menu/…），可复用、无业务语义 | 主题 token（`src/adapters/platform/theme.ts`）、React/RN 平台 API | 业务类型（除少量通用类型）、store、业务组件 |

**表现层铁律（任务书原话落地）**：

```tsx
// 正确姿势：页面组件只通过 view-model 拿数据、发命令
function ApprovalListScreen() {
  const vm = useApprovalListVm();                       // 适配层
  return (
    <ListContainer
      items={vm.items}                                  // props in
      onPress={vm.openDetail}                           // events out（vm 内部转命令）
      onRefresh={vm.refresh}
      empty={<EmptyState ... />}
    />
  );
}
```

- 页面组件**不出现** `useApprovalStore`、`wsGateway.send`、`eventsDao` 等任何领域层符号；验收口径：`grep` 页面组件目录不得命中 `domain/` 路径（§2.6 门禁）。
- 区块组件的 props 一律是「领域类型（shared-types）+ 派生标记」，如 `ApprovalCardProps = { item: ApprovalItem; remainingMs: number }`——组件不知道数据从哪来，只负责渲染与转发事件。

#### 2.2.2 适配层（L5）：状态映射与平台封装

| 文件 | 职责 | 说明 |
| --- | --- | --- |
| `viewmodels/useApprovalListVm.ts` | 审批列表页状态投影 | 组合 approvalStore.pending + 倒计时 tick + 导航参数，输出 `{ items, badge, refresh, openDetail, decide }` |
| `viewmodels/useDashboardVm.ts` | 首页状态投影 | connectionStore.phase + sessionStore.activeRuns + approvalStore 计数 + 轮询调度 |
| `viewmodels/useSessionDetailVm.ts` | 会话详情投影 | eventStore 流 + messageStore 投影 + 订阅生命周期（挂载订阅/卸载退订） |
| `hooks/useAppStore.ts` | store 订阅绑定 | `useShallow` re-export + 类型化 `useXxx()` hooks（内部 `useStore(domainStore)`） |
| `platform/Icon.tsx` | 图标封装 | 统一 `Icon` 组件（props: name/size/color），内部代理 lucide；换库只改此文件 |
| `platform/theme.ts` | 主题 token 对象 | 浅/深两套 token（§3.2），`useTheme()` 暴露；组件只消费 token 不消费裸值 |
| `platform/Fonts.ts` | 字体栈 | 系统字体栈 + 字号阶梯常量 + 动态字体开关 |
| `platform/Toast.tsx` | 全局 toast 宿主 | 表现层事件经此弹出（领域层不感知 toast） |
| `platform/Haptics.ts` | 触感反馈开关 | 轻触/成功/警告三类；全局可关（省电，F3 §5.3） |
| `platform/Clipboard.ts` | 剪贴板封装 | 复制/分享（长按菜单用） |

**view-model 范式**（页面的唯一数据契约）：

```ts
// src/adapters/viewmodels/useApprovalListVm.ts（示意）
export function useApprovalListVm() {
  const pending = useAppStore(useApprovalStore, (s) => s.pending);   // 适配层订阅
  const phase = useAppStore(useConnectionStore, (s) => s.phase);
  const now = useCountdownTick(1_000);                                // 每秒 tick（仅页面级）
  const items = useMemo(
    () => selectApprovalList(pending, now),                          // 领域纯函数（可单测）
    [pending, now]
  );
  const openDetail = useCallback((toolCallId: string) => {
    router.push(`/approval/${toolCallId}`);                          // 导航也是表现行为
  }, []);
  const decide = useCallback((toolCallId: string, outcome: 'allow' | 'deny', note?: string) => {
    approvalRepository.decide(toolCallId, outcome, note);            // 直接调领域命令
  }, []);
  return { items, phase, decide, openDetail };
}
```

要点：
1. **读**：领域 store 经订阅绑定读入，派生计算用领域纯函数（`selectApprovalList` 放 `domain/pure/`，可 Node 侧单测）。
2. **写**：页面事件 → vm 回调 → **直接调用领域命令函数**（仓库方法），不经过「再 setState 一层」——领域层命令内部完成状态迁移（F2 §3.3 状态机）。
3. vm 的返回结构是页面组件的**稳定契约**；换 UI 框架时 vm 原样保留（它不依赖任何 RN API，除 `useMemo/useCallback/useEffect` 这类 React 基础 hooks——若目标框架非 React，vm 用框架等价 hooks 重写，逻辑体不动）。

#### 2.2.3 领域层（L6-L7）：与 UI 无关

| 域 | 文件 | 关键状态/职责 |
| --- | --- | --- |
| store/authStore.ts | 配对状态机投影、令牌生命周期 | `pairState`、`deviceId`、host；secure-store 持久化 |
| store/connectionStore.ts | WS 相位投影 | `phase: disconnected/connecting/ready/recovering/offline`（D4 §6.2.5） |
| store/approvalStore.ts | 待批队列 + 决策 busy + outbox 状态 | pending 数组、`decisionBusy`；SQLite 桥（D4 §4.4.1） |
| store/sessionStore.ts | 会话摘要 + 活跃 run | sessions/activeRuns/selectedSessionId（F1 §5.2 派生口径） |
| store/eventStore.ts | 事件流窗口（按 session 分组，有界环形） | 5000 条/会话窗口，超限落 SQLite（F3 §3.4.2） |
| store/terminalStore.ts | 终端行缓冲（只读） | 200 行环形 + 单行 5000 字符（F3 §4.0） |
| store/settingsStore.ts | 本机偏好 + 桌面镜像 | persist 到 kv-store（F6 §4.2 分片） |
| repositories/approvalRepository.ts | 审批数据访问 | ingest 事件落库、decide 命令（outbox 编排）、对账 |
| repositories/sessionRepository.ts | 会话/run 数据访问 | 快照拉取、事件聚合刷新、缓存读写 |
| repositories/eventRepository.ts | 事件分页 + 增量落库 | 游标追平、回放（D4 §5.5） |
| repositories/fileRepository.ts | 文件浏览数据访问 | 目录缓存 LRU 128 层、分块续读（F4 §5.2/§5.3） |
| repositories/outbox.ts | 离线决策队列 | FIFO 重放、幂等键、5 次重试（D4 §6.5.2） |
| services/WsGateway.ts | 命令/事件分发 | invoke 超时、事件广播（D4 §6.1.3） |
| services/ReconnectingWsClient.ts | 心跳/重连/退避 | 30s 心跳、指数退避封顶 30s（D4 §6.2） |
| services/pairProtocol.ts | 配对握手 | HTTP 校验 + 令牌交换（D4 §5.1） |
| services/pushRegistration.ts | 推送令牌注册 | 令牌获取/上报/轮换监听（D4 §8.2） |
| pure/selectors.ts | 派生选择器 | 待批角标、run 五色分组映射、会话活跃标记（F1 §5） |
| pure/eventMerge.ts | 事件合并纯函数 | mergeAssistantTextPiece / buildEventDedupeKey（F3 §6.3 移植） |
| pure/ansi.ts | ANSI 剥离 | SGR/光标/清屏三类，30 行内（F3 §4.0） |
| pure/time.ts | 相对时间/倒计时 | 对齐桌面 sessionTime 口径 |
| network/… | WS 传输/信封/HTTP | 见 D4 §6（领域层最底层，仅被 services/repositories 依赖） |
| db/… | SQLite DAO / secure-store | 见 D4 §7（schema 8 表 + 迁移） |

**领域层铁律**：
1. **零 UI 框架 import**：领域层文件 `import` 面只允许 `zustand`（vanilla 入口）、`@crish/shared-types`、`expo-sqlite`、`expo-secure-store`、`expo-notifications`（服务类）与 `@react-native-community/netinfo`（连接探测）——不允许 `react`、`react-native`、`expo-router`、`react-native-reanimated` 等渲染面依赖。校验方式：lint 门禁白名单（§2.6）。
2. **store 用 vanilla `createStore` 而非 `create`**：这是与桌面 `permissionStore.ts` 的唯一范式差异，也是换 UI 框架的关键设计（§2.5）。
3. **事件进 store 前必须过仓库**：WS 事件 → WsGateway → 解析器 → repository 落库 → store 更新（D4 §4.4.4）。组件永远不消费原始信封。
4. **store 只持有领域模型**（shared-types 类型 + 本地附加字段），不持有 wire 原始对象（D4 §4.1 依赖规则）。
5. 仓库层实现「网络优先 + 缓存回退 + 离线入队」（D4 §4.1），store 不感知网络细节。

### 2.3 目录结构（完整 tree，与 D4 §4.3 的关系）

D4 §4.3 已有 `app/` + `src/{components,store,network,data,db,notifications,pairing,utils,types}` 结构；M4 按三层重构命名与归属（**实施时以本表为准覆盖 D4 §4.3**）：

```
apps/crish-mobile/
├── app/                                  # L1 路由骨架（expo-router 文件路由 = 深链命名空间）
│   ├── _layout.tsx                       # 根 Stack：SQLiteProvider/SecureStore/AuthGuard/ToastHost
│   ├── index.tsx                         # 路由守卫：按 auth 状态重定向
│   ├── pair/{_layout,scan,manual}.tsx    # 配对（扫码 P2 / 手动输入）
│   ├── (tabs)/
│   │   ├── _layout.tsx                   # 5 Tab 装配（TabBar + 角标）
│   │   ├── index.tsx                     # 首页仪表盘
│   │   ├── sessions.tsx                  # 会话列表
│   │   ├── approvals.tsx                 # 审批中心
│   │   ├── files.tsx                     # 文件浏览
│   │   └── settings.tsx                  # 设置
│   ├── session/[sessionId].tsx           # 会话详情（消息流/事件流双视图）
│   ├── run/[runId].tsx                   # run 详情（状态条+时间线+用量）
│   ├── terminal/[runId].tsx              # 终端流回放（只读，深链目标）
│   ├── approval/[toolCallId].tsx         # 审批详情（深链目标）
│   ├── approval-history.tsx              # 审批历史
│   ├── file/[...path].tsx                # 文件预览（编码路径）
│   ├── file-edit/[...path].tsx           # 文件编辑（P1）
│   ├── files-search.tsx                  # 文件搜索（P1）
│   ├── usage.tsx                         # 用量与缓存
│   ├── tasks.tsx                         # 后台任务
│   ├── diagnostics.tsx                   # 诊断
│   ├── sessions-search.tsx               # 会话搜索（P1）
│   ├── devices.tsx                       # 设备列表（F6 §6.2）
│   ├── device/[deviceId].tsx             # 设备详情（F6 §6.5）
│   ├── settings/…                        # 设置二级页（连接/通知/外观/数据隐私/通用）
│   └── login.tsx                         # 登录（F6 §5.5，访客可跳过）
├── src/
│   ├── presentation/                     # L2-L4 表现层
│   │   ├── screens/                      # 页面组件（与 app/ 路由一一对应）
│   │   ├── components/
│   │   │   ├── ui/                       # 原子组件（§3.7 清单）
│   │   │   ├── blocks/                   # 业务区块（ApprovalCard/EventRow/SessionRow/…）
│   │   │   └── templates/                # 页面模板（ListContainer/EmptyState/SkeletonPage/…）
│   │   └── types.ts                      # 表现层通用类型（props 契约）
│   ├── adapters/                         # L5 适配层
│   │   ├── viewmodels/                   # 每屏一个 useXxxVm
│   │   ├── hooks/                        # useAppStore 订阅绑定、useCountdownTick 等
│   │   └── platform/                     # theme/Icon/Fonts/Toast/Haptics/Clipboard
│   ├── domain/                           # L6-L7 领域层（零 UI 依赖）
│   │   ├── store/                        # vanilla zustand（7 个域）
│   │   ├── repositories/                 # 仓库（approval/session/event/file/outbox）
│   │   ├── services/                     # WsGateway/ReconnectingWsClient/pairProtocol/push
│   │   ├── pure/                         # 纯函数与选择器（selectors/eventMerge/ansi/time/id）
│   │   ├── network/                      # ReconnectingWsClient/WsEnvelope/HttpClient/EndpointResolver
│   │   ├── db/                           # schema/migrations/dao/secureStore
│   │   └── types/                        # 领域本地类型（env 等）
│   ├── notifications/                    # 推送接线（跨层：注册+处理+深链翻译）
│   └── pairing/                          # 配对协议（qrPayload/pairProtocol 纯逻辑）
├── assets/  __tests__/  scripts/         # 同 D4
```

说明：
- **`src/notifications/` 与 `src/pairing/` 为跨层接线**：推送深链翻译（D4 §8.6）需同时触碰表现层（路由）与领域层（令牌），归为「领域为主、入口在根布局」的接线目录；其中纯协议逻辑（qrPayload/pairProtocol）在领域层。
- **组件命名纪律**：`ui/` 原子组件与桌面 `components/ui/` 同名同语义（Button/Input/Dialog/Menu/Select/Tooltip），移动端新增 ListRow/Card/Badge/Chip/Switch/Slider/EmptyState/Skeleton/Sheet/Toast/AppBar/TabBar/ConnectionBanner/CountdownBar 等移动特有部件（§3.7 全清单）。

### 2.4 数据流示例：审批流程的完整分层调用链

以「推送深链打开审批详情 → 用户滑动允许 → 离线 → 重连送达」为主线，标注每一跳的层归属：

```
① 推送点击（深链）crish://approval/tool_call_abc123
   L1 app/approval/[toolCallId].tsx 路由落地（expo-router）
   → AuthGuard 判定已配对 → 页面挂载
② 页面数据装配
   L2 ApprovalDetailScreen 调 useApprovalDetailVm(toolCallId)
   L5 vm 经 useAppStore 订阅 approvalStore.pending 找到条目
      （若冷启动无内存数据：vm 触发 approvalRepository.reconcile() 对账拉取）
③ 对账（引擎真值 → 本地）
   L5 vm.decide 未触发；页面首次渲染调 vm.reconcile
   L7 approvalRepository.reconcile(toolCallId)
     → services/WsGateway.invoke('mobile_list_pending_approvals')  [F2 §12.2]
     → 返回 { request, runId, expiresAt, runStatus }
     → db/approvalsDao.upsert(...)（落库）
     → approvalStore.setPending(...)（状态更新）→ 订阅面驱动 vm.items 重算 → 页面重渲染
④ 用户滑动允许（L2 布局 → 事件冒泡）
   ApprovalDetailScreen onSwipeConfirm(70% 阈值) → vm.decide('allow', note?)
   L5 vm.decide → L7 approvalRepository.decide(toolCallId, 'allow', note)
     a. 领域状态机：approvalStore.markDecision('submitting')（F2 §3.3：pending→deciding）
        → 乐观 UI：按钮置忙 + 菊花（vm 读 decisionBusy）
     b. outbox 入队（无论网络状态，先落 SQLite outbox 表；D4 §6.5.2 规则 1）
     c. 尝试发送：connectionStore.phase === 'ready' 才走 WsGateway.send('core_approve_tool')
        ── 若断线：phase !== 'ready' → 直接返回 queued 态（D4 §5.4 trySendDecision）
   （本场景：断线）→ outbox 状态 = queued，审批卡显示「待发送」徽标 + Toast「网络恢复后自动发送」
⑤ 重连与重放
   services/ReconnectingWsClient 指数退避重连成功
   → connectionStore.phase → ready（投影）
   → 连接成功回调触发 outbox.flush()
   L7 repositories/outbox.flush()：FIFO 单飞重放
     → WsGateway.send('core_approve_tool', { toolCallId, scope:'project' })
     → 引擎回执 ok → outbox 置 sent → approvalStore.removePending → 卡片消失
     → 收 approval-resolved 事件（经 WsGateway → 解析器 → repository → store）→ 入历史表
⑥ 冲突兜底（桌面先处理/过期）
   命令回执 NotFound → outbox 置 superseded + approvalStore 标记 conflict
   → vm 呈现冲突态文案（F2 §11.2 映射表）→ 触发一次静默对账收敛
```

**调用链层级结论**（评审可复核）：
- 页面组件只做了两件事：调 vm、渲染 vm 返回值（L2 无任何领域符号）。
- vm 是「导航 + 命令 + 订阅」的薄组合层（L5 全部代码 < 200 行/屏）。
- 状态迁移全部发生在领域 store（L6），网络与落库全部发生在仓库（L7），仓库不 import 组件、store 不 import 仓库实现（依赖注入：`approvalRepository` 由 app 启动时装配进 store 动作或直接由 vm 调用）。

### 2.5 关键设计：vanilla zustand 与 React 绑定的分离

桌面端 `permissionStore.ts` 用 `create<T>()(...)`（zustand 的 React 绑定入口）；移动端换 UI 框架需求下，M4 规定：

```ts
// src/domain/store/approvalStore.ts —— 领域层，零 React 依赖
import { createStore } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';

export const approvalStore = createStore<ApprovalState>()(
  immer((set) => ({ /* 状态与动作，同 D4 §4.4.2 形状 */ }))
);
export type ApprovalStore = typeof approvalStore;
```

```ts
// src/adapters/hooks/useAppStore.ts —— 适配层，唯一允许的 React 绑定
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { approvalStore } from '../domain/store/approvalStore';

export const useApprovalStore = <T>(selector: (s: ApprovalState) => T) =>
  useStore(approvalStore, useShallow(selector));
```

| 维度 | 桌面（现状） | 移动端（M4） | 理由 |
| --- | --- | --- | --- |
| store 创建 | `create()`（含 React 绑定） | `createStore()`（vanilla） | 领域层可脱离 React 独立测试与复用 |
| 订阅 | 组件直接 `useXxxStore(s => …)` | 组件经适配层 `useAppStore(store, selector)` | 换框架只重写适配层 5 行绑定 |
| 跨层通信 | 组件→store 动作 | 组件→vm→领域命令（仓库/服务） | 命令是领域层唯一写入口，可审计可测试 |
| selector 规范 | `useShallow` | 同左（re-export 于适配层） | 心智一致（D4 §3.3.1） |

**测试收益**：领域 store 可脱离 RN 测试环境直接跑（Node 侧 jest），审批状态机/outbox/追平的测试不再依赖 jest-expo 的 RN mock 面——这是分层最直接的验收红利。

### 2.6 分层门禁（lint 强制，实施必做）

| 门禁 | 规则 | 脚本/工具 |
| --- | --- | --- |
| G1 表现层不碰领域 | 扫描 `src/presentation/**` 与 `app/**` 的 import，命中 `domain/`、`repositories/`、`services/`、`network/`、`db/` 即失败 | 自研 `scripts/check-layer-imports.mjs`（仿桌面 `check-ui-layer.mjs` 思路，`components/ui/README.md`） |
| G2 领域层零 UI 依赖 | 扫描 `src/domain/**` 的 import，命中 `react`、`react-native`、`expo-router`、`react-native-reanimated`、`presentation/`、`adapters/` 即失败 | 同脚本（白名单模式：只允许 zustand/shared-types/expo-sqlite/expo-secure-store/expo-notifications/netinfo） |
| G3 适配层隔离 | `src/adapters/viewmodels/**` 不得 import `presentation/**`、`app/**` | 同脚本 |
| G4 区块层禁 import 业务 | `src/presentation/components/blocks/**` 不得 import 其他 blocks 与 screens | 同脚本 |
| G5 事件类型穷尽 | 事件渲染 switch 必须带 `never` 穷尽分支（F2 §9.3 纪律） | tsc（`noImplicitReturns` + 手写断言） |
| G6 深链白名单 | `crish://` 路由白名单单测（D4 §8.6 安全面） | jest 单测 |

门禁纳入 CI：`typecheck + lint + check-layer-imports` 快层三件套，与 D4 §9.4 的 mobile-ci 合并执行。

## 3. 设计系统

### 3.1 设计语言总则：简洁、诚实、低噪音

1. **信息层级 3 档**：内容（正文/主标题）→ 元信息（时间/大小/状态）→ 装饰（图标/底色）。元信息默认灰色小字，装饰不抢内容（F1 §7.1「每屏一个主任务」落地到视觉）。
2. **圆角语言**：卡片 12-16、按钮胶囊、弹层 20；不做多层阴影堆叠（移动端阴影廉价感来源）。
3. **留白优先**：列表行高 44dp 起步、卡片内边距 16、区块间距 8-12；空态不装饰过度。
4. **颜色即语义**：语义色只表达状态（绿=就绪/成功、黄=等待、红=错误/危险、蓝=信息/进行中、灰=未知/离线）；禁止「好看但无义」的彩色装饰（F1 §4.7 状态圆点+文字双通道延续）。
5. **与桌面同源不同载体**：token 语义名逐项对齐桌面 `tokens.css`，但载体是 TS 对象（RN 无 CSS 变量）；双端视觉可「逐 token 对照」而非「逐像素一致」（屏幕形态不同）。

### 3.2 色板（浅/深双主题，语义名对齐桌面 tokens.css）

移动端 `adapters/platform/theme.ts` 暴露 `light` / `dark` 两套 token 对象，**语义名与桌面 CSS 变量同名同义**（对照表以桌面 `tokens.css` 为准）：

| 移动端 token | 浅色值 | 深色值 | 桌面对应（tokens.css） | 用途 |
| --- | --- | --- | --- | --- |
| `bgPrimary` | `hsl(35,12%,94%)` 暖灰 | `hsl(0,0%,5%)` 炭灰 | `--bg-primary` | 页面底色 |
| `bgSecondary` | `hsl(35,12%,91.5%)` | `hsl(0,0%,8%)` | `--bg-secondary` | 顶栏/输入底 |
| `bgTertiary` | `hsl(35,12%,88.5%)` | `hsl(0,0%,11%)` | `--bg-tertiary` | 下凹/按压底 |
| `bgCard` | `hsl(35,10%,98%)` 暖白 | `hsl(0,0%,11%)` | `--bg-card` | 卡片底 |
| `bgElevated` | `hsl(35,8%,100%)` 乳白 | `hsl(0,0%,15%)` | `--bg-elevated` | 弹层/Sheet 底 |
| `textPrimary` | `#111111` | `#f0f0f0` | `--text-primary` | 正文 |
| `textSecondary` | `#555555` | `#a3a3a3` | `--text-secondary` | 元信息 |
| `textTertiary` | secondary×70% 透明 | secondary×62% 透明 | `--text-tertiary` | 角标/占位 |
| `hairline` | `hsl(35,8%,91%)` | `hsl(0,0%,14%)` | `--hairline` | 结构分隔线（1px） |
| `hairlineStrong` | `hsl(35,10%,86%)` | `hsl(0,0%,18%)` | `--hairline-strong` | 输入壳/描边 |
| `colorSuccess` | `hsl(142,35%,42%)` 森林绿 | 同左 | `--color-success` | 成功/就绪/允许主按钮 |
| `colorWarning` | `hsl(38,92%,50%)` 橙 | 同左 | `--color-warning` | 等待审批/预警 |
| `colorError` | `hsl(0,55%,55%)` 砖红 | 同左 | `--color-error` | 失败/危险/拒绝 |
| `colorInfo` | `hsl(217,91%,60%)` 蓝 | 同左 | `--color-info` | 进行中/信息 |
| `colorSuccessBg` | `hsl(142,35%,96.5%)` | `hsl(142,35%,16%)` | `--color-success-bg` | 状态底 |
| `colorErrorBg` | `hsl(0,55%,97.5%)` | `hsl(0,55%,16%)` | `--color-error-bg` | 错误横幅底 |
| `colorWarningBg` | `hsl(38,100%,96%)` | `hsl(21,92%,14%)` | `--color-warning-bg` | 等待横幅底 |
| `textOnAccent` | `#ffffff` | `bgPrimary` | `--text-on-accent` | 强调底文字 |
| `textOnDanger` | `#ffffff` | `#ffffff` | `--text-on-danger` | 危险按钮文字 |
| `colorActive` | `#16a34a` | 同左 | `--color-active` | 在线圆点 |

**run 五色分组**（F1 §5.1 固化到 token 层，供 RunStatusChip 消费）：

| run 状态组 | token | 移动端展示 | 桌面映射 |
| --- | --- | --- | --- |
| 排队/未知 | `textTertiary` + 灰点 | 「排队中」「状态未知」 | queued / unknown |
| 进行中 | `colorInfo` + 蓝点 | 「运行中」「初始化中」「收尾中」 | running / initializing / completing |
| 等待审批 | `colorWarning` + 黄点（可闪烁） | 「等待审批」+ 倒计时条 | awaiting-approval |
| 失败/取消中 | `colorError`（取消用 60% 透明底） | 「失败」「取消中」「已取消」 | failed / cancelling / cancelled |
| 完成 | `colorSuccess` | 「已完成」 | completed |

**深色模式约定**：跟随系统 + 手动三选（F6 §9）；「深色不是浅色反色」——深色 bgCard 与 bgTertiary 同值（`hsl(0,0%,11%)`），靠 hairline 区分卡片边界（对齐桌面深色分支 `--bg-card: hsl(0,0%,11%)` 的处理）。

### 3.3 字体与字号层级

| 移动端 token | 值（px） | 桌面对应 | 用途 |
| --- | --- | --- | --- |
| `fontSizeNano` | 11 | `--font-size-xxs` | 角标数字 |
| `fontSizeXs` | 12 | `--font-size-xs` | 徽标/时间 |
| `fontSizeSm` | 13 | `--font-size-sm` | 元信息/辅助 |
| `fontSizeBase` | 14 | `--font-size-base` | **正文基准**（中文可读性） |
| `fontSizeMd` | 15 | `--font-size-md` | 列表标题 |
| `fontSizeLg` | 17 | `--font-size-lg` | 卡片主标题 |
| `fontSizeXl` | 19 | `--font-size-xl` | 页面标题 |
| `fontSize2xl` | 22 | `--font-size-2xl` | 空态主文案/大数字 |

- **字体栈**：系统字体（iOS SF Pro / Android Roboto）+ 系统中文字体（PingFang SC / MiSans 等系统自动匹配），**不内嵌字体文件**（中文内嵌字体 5-10MB，且与系统动态字体缩放冲突）。
- **行高**：正文 1.5-1.55（`--line-height-body` 同值），标题 1.25，代码 1.4。
- **字重**：normal 400 / medium 500 / semibold 600（导航标题）三档，与桌面 `--font-weight-*` 对齐。
- **等宽字体**：终端流/代码块用系统等宽（iOS Menlo / Android Droid Sans Mono），行高 1.4，字号 13。
- **动态字体**：所有 Text 组件 `allowFontScaling` 默认开启（iOS 动态类型 / Android 字体大小缩放），字号 token 是「基准值」而非硬顶；布局以 flex 为主防缩放破版（§6.5）。

### 3.4 间距 / 圆角 / 阴影

**间距（4pt 网格，对齐桌面 `--space-*`）**：

| token | 值 | 桌面对应 | 用途 |
| --- | --- | --- | --- |
| `space1` | 4 | `--space-1` | 图标与文字间隙 |
| `space2` | 8 | `--space-2` | 行内元素间隙/分隔线距 |
| `space3` | 12 | `--space-3` | 区块间/卡片内边距 |
| `space4` | 16 | `--space-4` | **标准卡片内边距** |
| `space5` | 20 | `--space-5` | 区块与区块间距 |
| `space6` | 24 | `--space-6` | 大区块/页面顶部距 |
| `space8` | 32 | `--space-8` | 空态区/分组标题距 |

**圆角**：

| token | 值 | 桌面对应 | 用途 |
| --- | --- | --- | --- |
| `radiusSm` | 8 | `--radius-lg`（8px） | 小按钮/徽标 |
| `radiusMd` | 12 | `--radius-2xl`（12px） | 卡片/输入框 |
| `radiusLg` | 16 | 无桌面直接对应（移动端放大） | 大卡片/顶部 Sheet |
| `radiusFull` | 9999 | `--radius-full` | 胶囊按钮/圆点/倒计时条 |

**阴影（RN 用 elevation + shadow* 双写，token 化）**：

| token | 桌面对应 | 用途 | RN 实现 |
| --- | --- | --- | --- |
| `shadowSm` | `--shadow-sm` | 卡片浮起 | `elevation:1; shadowOpacity:0.05` |
| `shadowMd` | `--shadow-md` | 浮层/Sheet | `elevation:3; shadowOpacity:0.08` |
| `shadowLg` | `--shadow-lg` | 全屏弹层/决策条 | `elevation:6; shadowOpacity:0.12` |

**触控尺寸**（全局常量）：最小可点 44×44dp；列表行高 44/56/72 三档（紧凑/标准/大——对应 F6 §9 列表密度三档）；TabBar 高 56dp（含安全区）；决策按钮区高 72dp。

### 3.5 图标方案（M4 定案，承接 R2B 教训）

**背景（R2B 教训）**：旧原型 `lucide-react-native@^1.30.0` 缺 peer 依赖 `react-native-svg`，导致启动崩溃（R2B §3.1：MOBILE-03 实测）；且 6 项 react-navigation 系依赖被 D4 弃用，依赖面无人管理。

**M4 定案三件事**：

1. **图标库选型：lucide-react-native**（D4 §12.1 未列图标库，M4 补充定案）：
   - 线性图标、视觉轻盈、与「简洁」语言匹配；桌面端已用 lucide 系（`SidebarToggleIcons.tsx` 等消费 lucide-react），双端图标心智一致。
   - 备选对比：react-native-vector-icons（字体图标，需字体文件注册、无 tree-shaking）与 Iconify 聚合（体积优势但生态杂）——lucide 的 TS 类型与 tree-shaking 更适合 monorepo 严格类型纪律。
2. **依赖纪律（防 R2B 重演）**：安装命令**必须**为 `npx expo install lucide-react-native react-native-svg`（expo 自动对齐 SDK 57 兼容版本）；`package.json` 以 `expo-doctor` 校验（D4 §9.4 CI 已有）；新增任何带 peer 依赖的库必须过「peer 依赖检查」步骤（R2B 依赖审查清单纳入 D8 工程收尾）。
3. **自研 `Icon` 组件隔离替换面（关键设计）**：表现层**禁止直接 import lucide 组件**，统一经 `adapters/platform/Icon.tsx`：

```tsx
// src/adapters/platform/Icon.tsx（示意）
import { Search, ShieldCheck, ChevronRight, ... } from 'lucide-react-native';
const registry = { search: Search, shield: ShieldCheck, chevronRight: ChevronRight, /* 白名单 60+ */ };

export function Icon({ name, size = 20, color, strokeWidth = 2 }: IconProps) {
  const C = registry[name];
  return <C size={size} color={color} strokeWidth={strokeWidth} />;
}
export type IconName = keyof typeof registry;   // 类型化图标名
```

- 图标名用**语义名白名单**（`search`/`shield`/`file`/`folder`/`check`/`x`/`alert`/`clock`/`arrowLeft`/`more`/`refresh`/`download`…约 60 个，按 F1-F6 屏幕盘点清单一一列出，§13 附录）。
- 换图标库/换 UI 框架时只重写 `Icon.tsx` 内部实现，全 App 消费点零改动；`Icon` 属适配层（被表现层消费），不属领域层。
- 尺寸三档：20（行内）、24（列表图标）、32（空态大图标）；颜色一律由调用方从主题 token 取，`Icon` 不内置默认色（防「颜色即语义」被破坏）。

### 3.6 组件库策略：自研轻量 vs 引入（评估与结论）

**结论：自研轻量（约 20 个原子组件 + 约 15 个业务区块/模板）**，不引入 gluestack-ui / tamagui。评估矩阵：

| 维度 | 自研轻量（M4 定案） | gluestack-ui | tamagui |
| --- | --- | --- | --- |
| 鸿蒙 ArkUI 可移植性 | 表现层整体重写，组件只是待替换清单 | 不可移植（RN 组件，ArkUI 无 RN 运行时） | 不可移植（同上） |
| 包体 | ≈0（仅 RN 自带） | 依赖 gluestack 组件树 + 主题系统 | 编译器 + 运行时 ≈ 300-500KB |
| 功能匹配度 | 精确覆盖 20 个部件，无冗余 | 覆盖广但含大量移动端用不到的 web 风格组件 | 强在跨平台 web/原生，本项目无 web 需求 |
| 主题一致性 | token 直接对齐桌面 tokens.css | 需自建主题桥接 | 需自建 token 桥接 |
| 升级风险 | 无三方升级面 | 跟随其版本节奏 | 编译器版本绑定 RN 版本（RN 0.86 新架构下的兼容面需验证） |
| 新架构（Fabric/Nitro）兼容 | RN 自带视图零风险 | 需验证 | R2 风险（D4 §10.1 R2：三方库未适配新架构） |
| 可访问性 | 按需实现（对齐桌面 ui/ 层的 a11y 纪律） | 有内置 | 有内置 |

**理由**（简版）：
1. 移动端功能面窄且只读为主——需要的是列表/卡片/按钮/表单/弹层/底部操作区，不是完整设计系统套件；20 个部件自研可控。
2. 换 UI 框架（任务核心诉求）时，无论引入哪个库，**表现层都要重写**——引入库只是「重写时少写几行」，却要承担版本绑定与新架构风险。
3. 桌面端已有 `components/ui/` 原子层先例（`components/ui/README.md`：ui 层只允许 tokens.css 依赖），移动端照搬「ui 原子层」纪律即可，双端组件规范同源。
4. tamagui 的编译优化在「远程伴侣」的列表/卡片场景收益无感（不是像素级交互密集型应用）。

**自研组件全清单**（§3.7）与桌面 `components/ui/` 的映射关系在 §13 附录给出。

### 3.7 移动端原子组件清单（`presentation/components/ui/`）

| # | 组件 | 与桌面 ui/ 对应 | 移动端特化说明 |
| --- | --- | --- | --- |
| 1 | `Button` | Button（variant: primary/secondary/ghost/danger + loading + block） | 高度 44/48 两档；primary 用 `colorSuccess` 或主题强调色（审批允许=绿）；danger 红底白字 |
| 2 | `Input` | Input（text/search/password + label/error/hint） | 聚焦放大键盘适配；自动大写关闭 |
| 3 | `Switch` | 无（桌面用 checkbox） | 移动端标准开关（iOS/Android 原生样式包装） |
| 4 | `Slider` | 无 | 字体大小三档滑块（F6 §9） |
| 5 | `Card` | 无（桌面是面板） | 卡片容器：padding 16、radius 12、hairline 描边 |
| 6 | `ListRow` | 无（桌面是列表行样式） | 44/56/72 行高；左 icon + 标题 + 副标题 + 右侧 meta/箭头 |
| 7 | `Badge` | 徽标样式 | 数字角标（99+ 上限）、状态徽标（L2 高风险红、待发送灰） |
| 8 | `Chip` | 无 | 状态胶囊（就绪/异常/未知三态，F1 §4.2 核心状态卡用）；风险事实 chips（F2 §12.6） |
| 9 | `AppBar` | 无（桌面是窗口 chrome） | 返回 + 标题 + 右侧动作插槽；恒在状态栏下方；连接状态条可钉在其下（F1 §7.6） |
| 10 | `TabBar` | 无 | 5 Tab + 角标（审批红点）；56dp；图标 24 + 标签 11 |
| 11 | `ConnectionBanner` | 无 | 断线横幅（recovering/offline 两态 + 重连按钮）；全局唯一实例 |
| 12 | `CountdownBar` | 无 | 审批剩余时间进度条（120s 倒计时，最后 15s 变红，F2 §4.2） |
| 13 | `EmptyState` | 空态样式 | 图标 + 主文案 + 副文案 + 可选动作；无数据不显 0（F1 §4.7） |
| 14 | `Skeleton` | skeletonSection 思路 | 骨架屏原子（首页/列表/详情三种模板见 §8.1） |
| 15 | `Toast` | useToastQueue 思路 | 成功/错误/信息三态；顶部或底部浮出；领域层不感知 |
| 16 | `Dialog` | Dialog（FocusTrap 三件套思路） | 危险操作二次确认容器（§6.3） |
| 17 | `Sheet`（ActionSheet） | Menu/弹层思路 | 底部半屏弹层：长按菜单（F4 §6.4）/拒绝理由面板（F2 §5.2）/排序选择 |
| 18 | `Select` | Select | 表单下拉（设置页用） |
| 19 | `ProgressBar` | 进度条样式 | 审批倒计时/文件加载/用量条形 |
| 20 | `SegmentedControl` | 分段样式 | 会话详情「消息/事件流」切换（§5.5）、设置密度三档 |

**区块/模板组件清单**（`presentation/components/blocks/` 与 `templates/`）：

| 组件 | 功能对应 | 说明 |
| --- | --- | --- |
| `ApprovalCard` | F2 §4.2 | 审批卡：工具名+风险徽标+摘要+会话上下文+倒计时+「查看」 |
| `ApprovalActionBar` | F2 §5.2 | 决策区：拒绝（左）/允许（右，L2 滑动）；固定底部 |
| `EventRow` | F3 §3.3 | 事件行：类型图标 + 中文摘要（六类模板 + 兜底） |
| `RunStatusChip` | F1 §5.1 | run 五色分组 chip |
| `SessionRow` | F5 §4.1 | 会话行：标题 + 最后消息预览 + 相对时间 + 运行徽标 + 未读角标 |
| `MessageBubble` | F5 §4.2 | 消息气泡（user 右侧/assistant 左侧）+ 思考折叠 + 操作条 |
| `ToolCallCard` | F5 §4.5 / F3 §3.3.2 | 工具卡：折叠/展开、状态机、diff 统计 |
| `TerminalCard` | F3 §4.2 | 终端行缓冲视图（复用行缓冲组件） |
| `FileTreeRow` | F4 §6.2 | 文件行：类型图标 + 名称 + meta + Git 徽标 |
| `BreadcrumbBar` | F4 §6.2 | 面包屑 + 层级弹层 |
| `DeviceRow` | F6 §6.2 | 设备行：类型图标 + 名称 + 通道标签 + 在线点 |
| `SettingsRow` | F6 §12.1 | 设置行：图标 + 标题 + 当前值摘要 + 箭头/开关 |
| `ListContainer` | 通用 | 虚拟列表容器（FlashList 包装 + 加载中/空态/底部刷新态编排） |
| `SkeletonPage` | 通用 | 页面骨架模板（首页/列表/详情三形态，§8.1） |
| `ErrorBanner` | F1 §4.7 / F3 §3.3.3 | 错误横幅（run 失败/断线/干预提示） |

### 3.8 主题切换与 token 消费纪律

- `theme.ts` 暴露 `useTheme()`（适配层，订阅 settingsStore.appearance.theme：`system/light/dark`），返回当前主题 token 对象。
- **组件禁止硬编码色值/间距**：任何 `#`、`hsl(`、裸数字间距一律以 token 引用（lint 规则：表现层组件文件内禁止 `#` 颜色字面量——对齐桌面「禁裸 hex」纪律，`components/ui/README.md` 二.1）。
- 深色切换即时生效：token 对象切换 → 订阅组件重渲染（React 自动）；动画元素（reanimated 共享值）不依赖主题色，避免切换闪变（§8.4）。
- 空态插画/图标按主题取色（F1 §7.3：图表、插画随主题切换，无明暗残留）。

---

## 4. 导航与信息架构

### 4.1 底部 Tab 结构（M4 裁决：5 Tab）

**裁决过程**：F1 §4.1 建议 4 Tab（首页/会话/用量/诊断，审批不做 Tab）；D4 §5.0 技术骨架是 5 Tab（仪表盘/审批/事件流/文件/设置）；F6 §12.1 是设置域视角的 3 Tab（聊天/会话/设置）。三者冲突，M4 按「用户价值 + 频率 + 屏幕承载」裁决：

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| 审批放 Tab | **放（占 Tab 位）** | 审批是移动端第一功能（D4 §2.1「审批可达性」、F2 §1.1）；Tab 角标 + 推送深链双入口是「去处理」最短路径；F1「不做 Tab」的顾虑（避免与 F2 重复设计导航）由 M4 统一导航定义消解 |
| 事件流放 Tab | 不放（并入会话详情） | F3 feed 与会话消息流同源（都是事件流投影，F5 §2.3 结论「同一协议」）；双 Tab 双视图重复且增加导航深度 |
| 用量/诊断放 Tab | 不放（入设置/首页摘要） | 低频排障（F1 P1 定位）；首页用量摘要行 + 设置内用量/诊断入口足够 |
| 文件放 Tab | 放 | F4 是独立高频能力域（看代码/文档），且与审批、会话并列的操作对象不同 |
| Tab 数量 | **5 个** | 移动端惯例上限 5（Material/Apple HIG 均认可 3-5）；5 个 Tab 语义互斥、无聚合杂烩 |

**最终 Tab 结构**：

```
┌──────────┬──────────┬──────────┬──────────┬──────────┐
│  首页     │  会话     │  审批     │  文件     │  设置     │
│ (index)  │ (sessions)│(approvals)│ (files)  │(settings)│
└──────────┴──────────┴──────────┴──────────┴──────────┘
  状态/活动   找会话    处理审批   看代码/文档  调偏好
  +用量摘要   +搜索     +角标(红)  +工作区切换  +账户/设备
  +待批入口            +历史入口  +搜索        +诊断/用量
```

- **审批 Tab 角标**：数值 = 待批数（`core_get_status.pendingApprovals` 长度 + 事件增量，F1 §5.3 口径）；上限 99+；查询失败显示「未知」不显示 0（诚实化）。
- **首页 Tab 角标**：断线时首页图标下加灰点（连接异常提示，D4 §4.4.3 selectApprovalBadge 思路）。
- **Tab 切换不丢状态**：Tab 内页面保持滚动位置与输入态（expo-router Tabs 默认保活）；切换 Tab 不触发数据重拉，仅按需刷新（首页轮询逻辑见 §5.2）。

### 4.2 页面树（完整导航图）

```
根 _layout（SQLiteProvider / SecureStore / AuthGuard / ToastHost / NotificationObserver）
│
├── 未配对/令牌失效 → /pair/manual（或 /pair/scan，P2）
│
├── (tabs) 已配对主界面
│   ├── index 首页仪表盘
│   │     ├──（点活动任务）→ run/[runId] run 详情
│   │     ├──（点待批卡）→ approval/[toolCallId] 审批详情
│   │     ├──（点用量摘要行）→ usage 用量页
│   │     ├──（点后台任务行）→ tasks 任务页
│   │     └──（点会话摘要）→ session/[sessionId] 会话详情
│   ├── sessions 会话列表
│   │     ├──（点会话）→ session/[sessionId] 会话详情
│   │     └──（搜索）→ sessions-search（P1）
│   ├── approvals 审批中心（待办 + 历史入口）
│   │     ├──（点卡片）→ approval/[toolCallId] 审批详情
│   │     ├──（点已处理）→ approval-history 审批历史
│   │     └──（批量模式）→ 页内多选态
│   ├── files 文件浏览
│   │     ├──（点目录）→ 页内 push 子目录（面包屑栈）
│   │     ├──（点文件）→ file/[...path] 文件预览
│   │     │        └──（编辑，P1）→ file-edit/[...path]
│   │     └──（搜索）→ files-search（P1）
│   └── settings 设置
│         ├── 账户与设备 → login / devices / device/[deviceId] / 配对向导
│         ├── 连接 → 连接设置页
│         ├── 通知 → 通知设置页
│         ├── 外观 → 外观设置页
│         ├── 数据与隐私 → 隐私页（缓存/同步范围/应用锁）
│         ├── 用量 → usage（复用首页入口同页）
│         ├── 诊断 → diagnostics
│         └── 通用 → 关于/回答风格
├── session/[sessionId] 会话详情（Stack push）
│     └──（分段「消息/事件流」）
│           ├── 消息视图：消息流渲染（F5 §4.2）
│           └── 事件流视图：feed（F3 §3.1）
│     └──（消息内工具卡）→ run/[runId] 或 terminal/[runId]
├── run/[runId] run 详情（状态条+时间线+用量卡）
│     └──（「查看终端」）→ terminal/[runId]
├── terminal/[runId] 终端回放（只读 + L2/L3 控制）
├── approval/[toolCallId] 审批详情（深链目标）
├── pair/* 配对（scan/manual）
├── devices / device/[deviceId] 设备管理
└── login 登录（F6 §5.5）
```

**导航规则**（对齐 F1 §7.6 + D4 §5.0）：
1. Stack push 页返回键回上一页；推送深链冷启动 → 目标页入栈，返回回首页（不堆叠中间页）。
2. 跨 Tab 跳转（首页待批卡 → 审批详情）返回后回到发起 Tab 并触发一次静默刷新（角标收敛）。
3. 深链目标数据不存在（run 归档/会话已删/审批已过期）→ 展示对应空态 + 可返回，不崩溃（F1 §7.6 / F2 §6.2）。
4. 顶部 AppBar 恒显示「← 返回」与必要动作；连接横幅恒在状态栏下方（F1 §7.6）。

### 4.3 深链映射表（推送点击 / 跨域跳转统一 schema）

对齐 D4 §8.6 安全面（`data.url` 白名单 + 参数二次校验）与 F1 §7.6 / F2 §6.2 / F3 §5.2 的深链约定，M4 汇总为唯一路由表（实施时同步到 `notifications/deepLink.ts` 白名单）：

| 深链 | 目标页 | 触发来源 | 参数（落地页二次校验） |
| --- | --- | --- | --- |
| `crish://dashboard` | 首页 | 默认/通用 | — |
| `crish://session/{sessionId}` | 会话详情 | 新消息推送（P2）/F3 会话级深链 | sessionId |
| `crish://session/{sessionId}?entry={entryId}` | 会话详情（定位 feed 条目） | F3 §5.2 事件详情深链 | entryId |
| `crish://run/{runId}` | run 详情 | run-terminal(failed) 推送（F1 §7.6） | runId |
| `crish://terminal/{runId}` | 终端回放 | 终端相关通知（P2） | runId |
| `crish://approval/{toolCallId}` | 审批详情 | **approval-requested 推送（最高频）** | toolCallId（+runId/sessionId 冗余） |
| `crish://approvals` | 审批中心 Tab | 审批汇总通知 | — |
| `crish://usage` | 用量页 | cache-waste-alert 推送 | — |
| `crish://tasks` | 任务页 | task-failed/task-killed/task-suspicious 推送 | — |
| `crish://diagnostics` | 诊断页 | lastError 引导 | — |
| `crish://files` | 文件浏览 | 文件相关通知（P2） | — |
| `crish://settings/security` | 设置→数据与隐私（安全段） | 桌面引导二维码（F6 §8.2） | — |
| `crish://devices` | 设备列表 | 配对状态通知 | — |

**接线要点**：`notifications/deepLink.ts` 的 `isAllowedRoute` 白名单必须与上述表一致并有单测（G6）；落地页对参数（sessionId/toolCallId）做存在性校验，不存在时渲染空态而非崩溃（F1 §7.6 规则 3）。

### 4.4 路由守卫（对齐 D4 §5.0）

```
启动 → 根 _layout
  ├─ SQLiteProvider(migrateIfNeeded) + SecureStore 就绪
  └─ AuthGuard 判定：
       pairState === 'paired'   → (tabs)
       pairState === 'unpaired' → /pair/manual
       token 过期（校验失败）    → /pair/manual（保留 SQLite 数据）
  ├─ 未 hydrate 前 → SplashGate（令牌未读出前不跳转，防闪烁）
  └─ NotificationObserver：冷启动 lastResponse → 已配对则深链跳转，未配对先配对后补跳（D4 §8.6）
```

守卫实现细节（防闪烁）：`hydrated` 标志来自 secure-store 异步读取完成；深链 pending 路由存在内存，配对成功后 `router.replace(pendingRoute)`（F2 §6.2 冷启动语义）。

## 5. 核心屏幕细化

### 5.0 最终屏幕清单（F1-F6 整合）

| # | 屏幕 | 路由 | 功能域来源 | 优先级 | 备注 |
| --- | --- | --- | --- | --- | --- |
| S01 | 首页仪表盘 | `(tabs)/index` | F1 F01-F03/F10/F07/F09 摘要 | P0 | 连接条+核心卡+活动任务+用量/任务摘要 |
| S02 | 会话列表 | `(tabs)/sessions` | F5 §2.1 + F1 F05 | P0 | 运行徽标+未读角标+置顶分段 |
| S03 | 审批中心 | `(tabs)/approvals` | F2 §4 | P0 | 待办+批量+历史入口 |
| S04 | 审批详情 | `approval/[toolCallId]` | F2 §5 | P0 | 深链目标；决策区固定底部 |
| S05 | 审批历史 | `approval-history` | F2 §7 | P0 | 筛选/会话分组 |
| S06 | 文件浏览 | `(tabs)/files` | F4 §6.2 | P0 | 面包屑栈 + 虚拟列表 |
| S07 | 文件预览 | `file/[...path]` | F4 §6.3 | P0 | 类型分派渲染（text/md/image/pdf） |
| S08 | 文件编辑 | `file-edit/[...path]` | F4 §6.5 | P1 | 覆盖二次确认 |
| S09 | 会话详情 | `session/[sessionId]` | F5 §4.2 + F3 §3 | P0 | 分段「消息/事件流」 |
| S10 | run 详情 | `run/[runId]` | F1 F04 + F3 | P0 | 状态条+时间线+用量卡 |
| S11 | 终端回放 | `terminal/[runId]` | F3 §4 | P0 | 只读行缓冲 + L2/L3 控制 |
| S12 | 用量与缓存 | `usage` | F1 F07/F08 | P1 | 摘要卡+趋势图+模型分布 |
| S13 | 后台任务 | `tasks` | F1 F09 | P1 | 五态 + tail 摘要 |
| S14 | 诊断 | `diagnostics` | F1 F11 | P1 | 四区只读 + 长按复制 |
| S15 | 设置首页 | `(tabs)/settings` | F6 §12.6 | P0 | 搜索置顶 + 账户卡 + 分组 |
| S16 | 设置二级页×N | `settings/*` | F6 §4 | P0 | 连接/通知/外观/数据隐私/通用 |
| S17 | 配对向导 | `pair/manual`、`pair/scan` | D4 §5.1 + F6 §12.2 | P0 | 手动先行，扫码 P2 |
| S18 | 设备列表/详情 | `devices`、`device/[id]` | F6 §6.2/§6.5 | P0 | 在线点+撤销二次确认 |
| S19 | 登录 | `login` | F6 §5.5 | P1 | 访客可跳过 |
| S20 | 会话搜索 | `sessions-search` | F5 §2.6 | P1 | 标题搜索 + 会话内搜索 |
| S21 | 文件搜索 | `files-search` | F4 §6.6 | P1 | 远程 fuzzy_find 薄壳 |
| S22 | 首次启动欢迎 | `index`（未配对分支） | F6 §12.2 | P0 | 配对/访客二选一 |

### 5.1 通用屏幕骨架（三态规范，F06 全局化）

```
┌──────────────────────────────┐
│ 状态栏（系统）                 │
│ 连接横幅（可选，36dp）         │  ← 断线/重连中/恢复中（F1 §5.4）
│ AppBar：← 标题      [动作]    │  ← 44dp
├──────────────────────────────┤
│ 内容区（三态之一）：            │
│  加载态 → Skeleton（§8.1）    │
│  空态   → EmptyState（§5.10） │
│  数据态 → 页面内容            │
│           （stale 时灰化+横幅） │
├──────────────────────────────┤
│ 底部操作区（决策类屏幕）72dp   │
│ TabBar（Tab 根屏）56dp        │
└──────────────────────────────┘
```

**三态全局规则**（对齐 F1 §4.7，M4 固化）：
- **加载态**：骨架屏只出现于首次加载；翻页加载用列表底部「加载中…」行；刷新用顶部转圈（不遮内容）。
- **空态**：图标 + 主文案 + 副文案 + 可选动作按钮；**绝不显示 0% / 0 tokens / 0 条误导性数字**（F1 §1.3-2 诚实化）。
- **错误/离线态**：保留上次成功快照（灰化 + 顶栏横幅「数据可能过期 HH:mm」）；重连成功自动全量刷新；查询超时显示「连接异常」+ 重试按钮，页面其余部分保持旧快照（F1 §8.1 T04）。
- **stale 标记**：页面级数据带 `lastSyncedAt`，超 60s 未刷新显示过期标记（F1 §5.4）。

### 5.2 首页仪表盘（重点屏幕：像素级布局建议）

数据源：`core_get_status`（4s 轮询，前台可见时）+ WS 事件增量 + `list_sessions`（下拉刷新）+ `workbench_list_background_tasks` 摘要（F1 §3.5 矩阵）。

```
┌───────────────────────────────────────────┐
│ 09:41                            电池 100% │ ← 系统状态栏
│ [● 已连接 · 办公台式机]            [刷新]   │ ← L0 连接条 36dp（绿/黄/红）
├───────────────────────────────────────────┤
│ 引擎 ●就绪   数据库 ●就绪   搜索 ●就绪     │ ← L1 核心状态卡 56dp（横向胶囊行）
│ 模型 deepseek-v4 · 后台任务 1 项           │
├───────────────────────────────────────────┤
│ 活动任务                              (3)  │ ← L1 活动区标题行（含总数）
│ ┌─────────────────────────────────────┐  │
│ │ ⚠ 待审批 · 删除 3 个文件    剩余 1:12 │  │ ← 待批条目置顶（点击→审批详情）
│ │ 会话「后端重构」· 审批中心 →          │  │
│ ├─────────────────────────────────────┤  │
│ │ ◐ 运行中 12s · 检查 package.json      │  │ ← 活动 run 条目（1s 步进时长）
│ │ 会话「依赖升级」→                     │  │
│ ├─────────────────────────────────────┤  │
│ │ ◐ 运行中 3m42s · 生成测试            │  │
│ │ 会话「CI 修复」→                     │  │
│ └─────────────────────────────────────┘  │
│ （>5 条折叠为「展开全部 N 项」）           │
├───────────────────────────────────────────┤
│ 用量 $0.12 · 输入 12.3k · 输出 8.1k   →  │ ← 用量摘要行 44dp（点击→usage）
│ 缓存 命中 78% · 浪费 $0.03           →  │ ← 缓存摘要行 44dp（点击→usage 缓存区）
│ 会话 12 · 最近「修复登录页 bug」      →  │ ← 会话摘要行 44dp（点击→sessions Tab）
├───────────────────────────────────────────┤
│ [首页●] [会话] [审批 2] [文件] [设置]     │ ← TabBar 56dp（审批角标=2）
└───────────────────────────────────────────┘
```

**像素级建议**（375×812 基准屏）：
- 连接条：36dp 高，绿底 `colorSuccessBg`/黄底 `colorWarningBg`/红底 `colorErrorBg`；文字 12；右侧常驻「刷新」文字按钮（44dp 热区）。
- 核心状态卡：56dp 高单行，四胶囊横向排列（引擎/数据库/搜索索引/模型）；胶囊 = 8dp 圆点 + 11dp 标签；异常胶囊红点 + 子系统名（F1 §4.2 三态）。
- 活动区：卡片整卡可点（F1 §7.2：不做小图钉按钮）；待批条目左缘 4dp 黄色竖条高亮；运行中条目左缘 4dp 蓝色竖条；时长 12px 灰。
- 摘要行：44dp 行高，左 icon 20 + 主文案 13 + 金额/数字 medium 加粗；行尾 chevron 16。
- 间距：卡片区 margin 16、卡片内 padding 16、行间 hairline 1px。
- **首屏（不打滚）必须呈现**：连接条 + 核心卡 + ≥2 条活动任务（F1 §7.1）；超过 5 条折叠。

**交互**：
- 下拉刷新 = 并行重拉 `core_get_status` + `list_sessions` + 任务摘要（F1 §4.2）；4s 轮询只拉 Q1 活动面。
- 轮询与手动刷新并发用 seq 守卫（后发覆盖先发，F1 §8.8 T41）。
- 后台/熄屏零轮询（F1 §1.3-3：对齐 `useEngineState.ts:135-140` visibility 判据）。
- 弱网降级：4s 轮询自动降 15s（F1 §8.8 T43）。

### 5.3 审批中心（重点屏幕）

数据源：实时事件（approval-requested/resolved）+ 启动对账（`mobile_list_pending_approvals`）+ 本地倒计时（F2 §4.1/§8.3）。

```
┌───────────────────────────────────────────┐
│ ◀ 审批中心               [批量] [已处理 12] │ ← AppBar 44dp
├───────────────────────────────────────────┤
│ 🔔 3 项待处理 · 桌面端 2 项 Agent 自动裁决  │ ← 概览条 36dp（main-agent 只读计数）
├───────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐  │
│ │ [高风险] 删除文件           剩余 1:42 │  │ ← L2 卡：红徽标 + 倒计时（进度条）
│ │ delete_file /src/deprecated/*.ts     │  │    命令行等宽 13px
│ │ 会话「后端重构」· run #42   [查看 →]  │  │
│ └─────────────────────────────────────┘  │
│ ┌─────────────────────────────────────┐  │
│ │ 需确认 git push --force     剩余 0:58 │  │ ← L1 卡
│ │ 会话「发布准备」· run #40  [查看 →]   │  │
│ └─────────────────────────────────────┘  │
│ ┌─────────────────────────────────────┐  │
│ │ ⏳ 等待 Agent 裁决（子任务）          │  │ ← main-agent 只读卡（F2 §4.4）
│ │ 写入文件 src/x.md · 子 Agent sub-3   │  │    无决策按钮
│ └─────────────────────────────────────┘  │
│                    （空态：无待处理审批…） │
├───────────────────────────────────────────┤
│ [☑ 批量处理]                 [长按多选]   │ ← 底部操作区 56dp（无卡片时隐藏）
└───────────────────────────────────────────┘
```

**像素级建议**：
- 卡片：88dp 最小高度（两行文本 + 底部倒计时条）；L2 卡左侧 4dp 红竖条 + 顶部红色「高风险」徽标（11dp 高、`colorErrorBg` 底红字）；L1 卡灰徽标「需确认」或不出徽标。
- 倒计时条：卡片底部 2dp 高满宽进度条（剩余/120s）；最后 15s 变红 + 徽标「即将过期」（F2 §4.2）。
- 排序：剩余时间升序（最紧急在顶部）；可切换会话分组视图（F2 §4.2）。
- 批量模式：长按或点「批量处理」进入多选；顶部显示已选计数；底部操作区切换为「允许 L1(N) / 拒绝全部(M)」（F2 §5.4 安全约束：批量允许仅 L1 且剩余 >30s）。

**审批详情页**（S04，深链直达页）：

```
┌───────────────────────────────────────────┐
│ ◀ 审批详情                        [刷新]   │
├───────────────────────────────────────────┤
│ ⚠ 高风险                                   │ ← L2 风险横幅（红底白字）
│  · 删除 3 个文件（约 48 KB）                │    列出具体风险点（F2 §5.1）
│  · 目标路径含 src/deprecated/              │
├───────────────────────────────────────────┤
│ 删除文件  delete_file                       │ ← 工具名 17 medium + 类型图标
│ 参数（命令）                                │
│ ┌─────────────────────────────────────┐  │
│ │ delete_file(path="/src/deprecated/  │  │ ← 等宽 13 + 危险参数高亮（--force 红）
│ │   a.ts", recursive=true)            │  │
│ └─────────────────────────────────────┘  │
│ 工作目录  C:\Software\conex\src           │ ← cwd 小字（shortPath 截断）
│ 所属会话 后端重构 · Run #42               │
│ 剩余时间  ⏳ 0:58（倒计时条）              │
├───────────────────────────────────────────┤
│ [记住此命令，下次自动允许]        ☐        │ ← remember（极危命令门禁说明）
│ ┌─────────────────────────────────────┐  │
│ │          拒绝（附理由）               │  │ ← 次按钮（灰描边）44dp
│ ├─────────────────────────────────────┤  │
│ │  ⟶ 滑动以允许（L2）／ 允许（L1）      │  │ ← 主按钮（绿）44dp；L2 滑轨
│ └─────────────────────────────────────┘  │ ← 决策区固定底部 72dp（拇指区）
└───────────────────────────────────────────┘
```

**关键交互**（F2 §9.1「3 秒决策路径」落地）：
- 首屏即见决策区（不滚动）；点按次数 ≤3（点通知 → 点/滑决策 → 反馈）。
- 推送 data 载荷已含摘要 → 详情页本地即时渲染，对账异步补齐参数（F2 §9.1-2）。
- L2 滑动确认：滑过 70% 阈值才可抬起触发；半途松开回弹（F2 §5.3；测试 E2E-3）。
- 拒绝：弹出底部 Sheet（快捷理由 chips + 自定义 ≤200 字可留空）。
- 防重复提交：发送期间按钮置忙 + 300ms 防抖（F2 §9.3-3）。
- 超时/冲突：状态页「已过期，决策未生效」/「该请求已在其他设备处理」+ 对账展示真实结果（F2 §8.3/§11.2）。

### 5.4 会话列表（S02）

```
┌───────────────────────────────────────────┐
│ 会话                          [🔍][＋]    │ ← ＋=新建（P2，P1 置灰）
├───────────────────────────────────────────┤
│ 运行中（1）                                │ ← 运行状态分段（有活动 run 才显示）
│ ┌─────────────────────────────────────┐  │
│ │ ● 修复登录页 bug        3 分钟前      │  │ ← 绿点=运行中/黄点=待审批
│ │ 助手：已定位问题…            [2]     │  │    最后消息预览（1 行截断）
│ └─────────────────────────────────────┘  │    [2]=未读角标
│ 全部（11）                                │
│ ┌─────────────────────────────────────┐  │
│ │ 📌 调研多端互通方案      昨天 14:30   │  │ ← 置顶段（isPinned）
│ │ 助手：参考文档已整理…                 │  │
│ └─────────────────────────────────────┘  │
│ ┌─────────────────────────────────────┐  │
│ │ 新会话                    周一 09:12 │  │
│ │ （空）                               │  │
│ └─────────────────────────────────────┘  │
│  ▲ 上滑加载更早（分页索引）                │
├───────────────────────────────────────────┤
│ [首页] [会话●] [审批] [文件] [设置]        │
└───────────────────────────────────────────┘
```

- 行高 72dp（三行信息：标题/预览/时间行）；标题 15 medium 截断 28 码点（F5 §2.1）；相对时间 12 灰。
- 排序：活动会话（有 run/待审批）置顶 → 置顶段 → updatedAt 降序（F1 §4.4）。
- 运行徽标：8dp 圆点（绿=运行中、黄=待审批、灰=完成）+ 旋转动效（P1 订阅驱动）。
- 未读角标：本地 `lastReadSequence` 派生（F5 §6.3）；红底白字 16dp 高胶囊。
- 长按会话 → 操作菜单（固定/归档/删除——P2 写操作，P1 只展示固定）。
- 下拉刷新全量重拉索引；搜索入口 → sessions-search。

### 5.5 会话详情（S09，重点屏幕：消息流 + 事件流双视图）

数据源：分页事件流拉取（`core_read_session_events` 游标）+ 实时订阅（WS 增量，200ms 节流合并）+ 本地 SQLite 缓存（F5 §2.4/§2.3）。

```
┌───────────────────────────────────────────┐
│ ‹ 修复登录页 bug          [🔍][⋯]         │
│ [ 消息 | 事件流 ]                         │ ← 分段控件 40dp（M4 整合 F3/F5）
├───────────────────────────────────────────┤
│ —— 消息视图 ——                            │
│ 你  14:32                                 │
│ ┌─────────────────────────────────────┐  │
│ │ 帮我修一下登录页的 bug                │  │ ← 右侧气泡（用户）
│ └─────────────────────────────────────┘  │
│ 助手  14:32                              │
│ ┌─ ▸ 思考 (12 秒) ────────────────────┐  │ ← 思考折叠条（默认收起）
│ │ ▸ 工具 · grep_search     ✔ 1.2s     │  │ ← 工具卡摘要（折叠）
│ │ ▸ 工具 · edit_file      ✖ 0.4s      │  │
│ ├─────────────────────────────────────┤  │
│ │ 已定位问题：…                        │  │ ← 正文（轻量 markdown 渲染）
│ │ ```typescript                       │  │
│ │ const x = 1;                        │  │ ← 代码块（等宽+底色+复制）
│ │ ```                                 │  │
│ └─────────────────────────────────────┘  │
│ [复制] [重新生成]                         │ ← 助手消息操作条（终态）
│ ● 运行中  助手正在处理…                   │ ← 会话级状态条（流式期间）
├───────────────────────────────────────────┤
│ —— 事件流视图 ——                          │
│ run 状态卡：◐ 运行中 12s  会话「后端重构」  │ ← run-header（可折叠）
│ 第 1 轮 · 3 次工具调用                    │ ← turn 分隔线
│ message-end  已定位问题：…                │ ← 条目按类型模板渲染
│ tool-end  读取文件 ✔ 0.8s                │
│ approval-requested  等待确认 → 审批中心   │ ← 点击跳 F2
│ （过滤条：只看错误 / 只看工具 / 只看当前run）│ ← feed 过滤（F3 §5.1）
├───────────────────────────────────────────┤
│ [ + ] 输入消息…（P2 启用，P1 只读置灰）    │ ← 56dp
└───────────────────────────────────────────┘
```

**双视图设计说明**（M4 整合裁决）：
- **消息视图** = F5 §4.2 的消息流（用户/助手气泡、思考折叠、工具卡、代码块）——日常阅读路径。
- **事件流视图** = F3 §3.1 的 feed（run 分组 + turn 分隔 + 原始事件条目 + 过滤条）——排查与实时盯输出路径。
- 两视图共享同一数据源（事件流投影，F5 §2.4 结论「同一协议」），只是投影与渲染粒度不同；切换不重新拉取（内存缓存已有）。
- 终端流输出（shell 工具流式输出）在**消息视图的工具卡展开体**与**事件流视图的终端卡片**双处呈现（F3 §4.2：终端流卡片是 tool-card 的特化）。
- 滚动：吸底跟随（阈值 40dp）；上滑后底部浮出「▼ N 条新消息」；时间分组线（跨 5 分钟）。
- 消息行 memo 化（仅 id/status/text/thinking/toolCalls 变化才重渲染，F5 §6.1）；流式期间 200ms 批渲染。

### 5.6 run 详情（S10）与终端回放（S11）

**run 详情**（数据：`core_get_run_snapshot` + `core_read_run_events` 游标分页 200/页 + 事件订阅）：

```
┌───────────────────────────────────────────┐
│ ‹ 会话A · 检查 package.json      [刷新]   │
│ ┌─────────────────────────────────────┐  │
│ │ ● 运行中 · 12s       模型 deepseek-v4 │  │ ← 状态条（五色分组）
│ │ 第 3 轮 · 2 次工具调用                │  │
│ └─────────────────────────────────────┘  │
│ ┌─────────────────────────────────────┐  │
│ │ 用量  输入 2.1k · 输出 1.4k          │  │ ← usage 卡（无样本整体隐藏）
│ │ 缓存  命中 82% · 读 1.8k · 浪费 ~0  │  │ ← 缓存子卡（None 隐藏）
│ └─────────────────────────────────────┘  │
│ 事件时间线（最新在上）                     │
│ 14:02:11  tool-end  读取文件 ✔          │
│ 14:02:09  message-end  输出…            │
│ 14:02:05  tool-start  检查文件          │
│ …上拉加载更早（游标分页）                 │
│ （终态 run 显示：✓ 已完成 2m12s / ✖ 失败：error 全文）│
└───────────────────────────────────────────┘
```

- 时间线事件行六类模板（agent-start/message/tool/compression/approval/run-terminal）覆盖 95%，未知 type 走兜底「事件 <type>」（F1 §4.3）。
- 打开已终态 run：终态条 + endReason + error 全文；hasMore=false 显示「已全部加载」。
- 顶部错误横幅（runtime-error / intervention-required，F1 F12）。

**终端回放**（数据：tool-update 流 + tool-end 终值；行缓冲 200 行环形）：

```
┌───────────────────────────────────────────┐
│ ‹ 终端 · run #42          [跟随][⏹ 停止]  │
│ ┌─────────────────────────────────────┐  │
│ │ $ npm test                          │  │ ← 等宽 13、深色底（主题统一色）
│ │ > crish@1.0.0 test                  │  │
│ │ > vitest run tests/unit             │  │
│ │  ✓ grapheme (12 tests)  12ms        │  │
│ │  ✓ undo (8 tests)  8ms              │  │
│ │  …（行号可选显示）                   │  │
│ │  [已截断 N 行 · 查看全部]            │  │
│ └─────────────────────────────────────┘  │
│ [搜索] [复制全部] [分享]                 │ ← 工具条 44dp
└───────────────────────────────────────────┘
```

- 自动跟随底部；上滚暂停 → 浮出「回到底部」；`\r` 行覆盖（shell 进度条语义，F3 §4.0）；ANSI 剥离（30 行内手写，F3 §4.0）。
- L2 停止（cooperative_stop）单点确认；L3 强制取消（force_cancel）长按二次确认（D4 §5.6）。
- 行内搜索（≤200 行线性匹配 + 高亮 + 命中计数）。

### 5.7 文件浏览（S06/S07）

```
┌───────────────────────────────────────────┐
│ ‹ conex / src / components      [🔍][⋯]  │ ← 面包屑（点击段弹层跳级）
├───────────────────────────────────────────┤
│ 📁 hooks                      [12 项]    │ ← 目录行 44dp（点击 push 进入）
│ 📄 FileTree.tsx               3.2K       │
│ 📄 FileTreeView.tsx            12K       │
│ 🖼  logo.png                  8.1K       │
│ 📄 FilesCard.tsx               15K  [M]  │ ← Git 徽标（P1）
│ …（虚拟滚动窗口，固定行高 44dp）          │
│                                          │
│ （下拉刷新当前层 + 空态「该目录为空」）    │
├───────────────────────────────────────────┤
│ 工作区：conex（点击切换）   [首页][会话][审批][文件●][设置] │
└───────────────────────────────────────────┘
```

- 目录行点击 = push 进入子目录（导航栈，系统返回/左滑 pop，F4 §6.2）；文件行点击 = 预览页。
- 长按任意行 → Sheet 菜单（复制相对/绝对路径、在桌面端打开 P1、分享 P1、编辑 P1、详情 P1；敏感文件缺编辑项，F4 §6.4）。
- 预览页（S07）：按 `detectFileKind` 分派——text：行号 + 轻量高亮 + 滚动续读（400 行阶梯）+ 截断提示；md：渲染/源码切换 + >500KB 降级纯文本；image：全图 + pinch-zoom；pdf：元数据卡 + 系统打开；binary：友好提示（F4 §4.2/§6.3）。
- 敏感文件（.env 等）：顶部红色横幅 + 内容不缓存 + 编辑置灰（F4 §7.1）。
- 目录缓存 30s TTL + LRU 128 层；断线显示缓存 + stale 标记（F4 §5.2）。

### 5.8 设置（S15/S16）

```
┌───────────────────────────────────────────┐
│ [🔍 搜索设置…                    ]        │ ← 搜索栏置顶常驻（一级交互）
├───────────────────────────────────────────┤
│ ◐ 未登录 · 访客模式              [登录]   │ ← 账户卡（三态：访客/登录/过期）
├───────────────────────────────────────────┤
│ [📱 配对新设备]  [⛁ 当前连接：在线]       │ ← 快捷卡片（F6 §12.6）
├───────────────────────────────────────────┤
│ 账户与设备                                │
│   设备列表        已配对 2 台     >        │ ← 行内当前值摘要（减少进二级页）
│   通知            3 个场景开     >        │
├───────────────────────────────────────────┤
│ 连接与外观                                │
│   连接方式        自动           >        │
│   主题            跟随系统       >        │
│   字体大小        标准           >        │
├───────────────────────────────────────────┤
│ 数据与隐私                                │
│   缓存            24.6 MB       >        │
│   同步范围        3 项开启       >        │
│   应用锁          已开启         >        │
├───────────────────────────────────────────┤
│ 通用                                      │
│   回答风格        详细           >        │
│   关于            v1.4.2        >        │
└───────────────────────────────────────────┘
```

- 设置行 = 图标 + 标题 + 当前值摘要 + 箭头/开关（F6 §12.1）；单页滚动 ≤2 屏，超出收「更多」。
- 搜索匹配：中文标签 / 拼音首字母 / 英文别名 / 数字（F6 §12.5）；150ms 防抖。
- 配对向导（S17）：三步（环境检测 → 扫码/输码 → 命名），进度条常驻，任一步可返回（F6 §12.2 线框）。
- 设备列表（S18）：本机恒顶置；在线优先；撤销配对二次确认（F6 §6.2）。
- 「移除本机」：二次确认 → `POST /v1/pair/revoke` → 清令牌 → 回配对页 → **保留** SQLite 缓存（D4 §5.8）。

### 5.9 空态 / 加载态 / 错误态（三态文案总表，全局统一）

| 场景 | 空态主文案 | 副文案 | 动作 |
| --- | --- | --- | --- |
| 首页无活动任务 | 当前无活动任务 | 桌面端 run 结束时这里会更新 | 下拉刷新 |
| 审批无待办 | 无待处理审批 | 当桌面端 Agent 需要确认时，会第一时间推送到这里 | 查看已处理 |
| 会话列表空 | 还没有会话 | 去桌面端开始第一个对话 | — |
| 会话无 run | 该会话暂无 run | — | 返回 |
| run 无事件 | 该 run 暂无事件 | — | 刷新 |
| 用量无样本 | 暂无用量数据 | 有数据后再来看看 | 刷新 |
| 缓存无数据 | 暂无缓存统计数据 | — | — |
| 诊断无错误 | 无错误记录 | 系统运行良好 | — |
| 目录为空 | 该目录为空 | — | 刷新 |
| 文件二进制 | 二进制文件，无法预览 | 可在桌面端打开 | 在桌面端打开 |
| 文件过大 | 文件过大，无法预览 | 上限 1MB | — |
| 深链目标不存在 | 该请求已过期 / 该 run 已归档 / 会话已删除 | 原因说明 | 返回首页 |
| 未配对 | 还没有连接桌面端 | 配对后即可远程查看与审批 | 开始配对 |

### 5.10 屏幕验收口径（每屏必测三态）

每屏交付时对照 §5.1 三态规范验收：加载骨架 → 数据态 → 空/错/离线态闭环；stale 标记；深色无残留；动态字体缩放不破版（§6.5）；TalkBack/VoiceOver 标签齐全。具体场景断言见第 10 章测试。

---

## 6. 交互规范

### 6.1 手势体系

| 手势 | 作用域 | 行为 | 实现 |
| --- | --- | --- | --- |
| 返回 | 全部 Stack 页 | 系统返回键 / iOS 边缘左滑 pop | expo-router Stack 原生行为 |
| 下拉刷新 | 列表类页（首页/会话/审批/文件/诊断） | 全量重拉当前页数据源 | `RefreshControl`（原生） |
| 长按 | 列表行/消息气泡/终端输出 | 弹出上下文 Sheet（复制/分享/菜单） | 原生 long-press + Sheet |
| 滑动确认 | 审批详情 L2 允许 | 滑过 70% 阈值触发；半途回弹 | reanimated 手势（§8.4 唯一重手势） |
| 上滑加载 | 会话详情/事件流/run 时间线 | 游标分页加载更早 | 虚拟列表 onEndReached |
| 点击吸底 | 会话详情上滑后 | 「▼ N 条新消息」悬浮条点击吸底 | 原生按钮 |
| 双指缩放 | 图片预览 | pinch-zoom | 系统图片查看器（或轻量手势封装） |
| 摇一摇/三指 | 无 | **不设计**（无桌面端调试入口需求） | — |

**手势冲突规则**：滑动确认（横向）与列表滚动（纵向）方向正交不冲突；滑动确认仅存在于审批详情页的决策滑轨内，不扩展到列表；流式期间工具卡/任务卡可展开但**禁止导航**（F3 §5.3 防误触）。

### 6.2 按钮层级（主/次/危险）

| 层级 | 视觉 | 用途 | 示例 |
| --- | --- | --- | --- |
| 主按钮 primary | 实底（绿 `colorSuccess` 或主题强调）白字，44dp 胶囊 | 每屏唯一正向主动作 | 允许（审批）、保存、登录、重连 |
| 次按钮 secondary | 白底描边（hairlineStrong）主字，44dp 胶囊 | 非主动作/可逆操作 | 拒绝（审批）、取消、刷新 |
| 危险按钮 danger | 红底（`colorError`）白字 | 不可逆或高风险动作 | 强制取消（L3）、移除本机、撤销配对 |
| 文字按钮 ghost | 无底主色文字 | 页内轻动作 | 「查看全部」「重试」「展开」 |
| 图标按钮 | 44dp 热区 + 24 图标 | AppBar 动作 | 搜索、更多、刷新 |

**规则**：
1. 每屏主按钮 ≤1 个；决策区（审批）主按钮恒右（拇指热区），次按钮恒左——「拒绝永远比允许容易」防误触（F2 §9.3-1）。
2. 危险按钮**不置于首屏默认焦点**；L3 强制取消必须长按 + 二次确认（§6.3）。
3. 按钮 loading 态：菊花 + 禁用，防重复提交（审批 300ms 防抖，F2 §9.3-3）。
4. 不可用态：`opacity 0.5` + 禁用（对齐桌面 `--opacity-disabled`），且附原因文案（如「需桌面端在场」时滑动置灰 + 说明，F2 §9.2）。

### 6.3 确认模式（危险操作二次确认）

| 危险度 | 交互 | 场景 |
| --- | --- | --- |
| 低（可逆，低成本） | 单点 + toast 反馈 | 拒绝审批、取消批量选择、切换主题 |
| 中（可逆，有成本） | Dialog 确认（说明后果 + 主按钮危险色） | 覆盖保存文件（F4 §4.3）、撤销配对（F6 §6.2）、移除本机（D4 §5.8）、清空缓存 |
| 高（不可逆/高风险） | 双保险：滑动确认（L2 审批）+ 或 长按 + Dialog | L2 允许（滑动 70%）、L3 强制取消（长按）、批量允许（确认层，F2 §5.4） |

**Dialog 规范**：标题（动作名）+ 后果说明（1-2 句）+ 主按钮（危险红/确认绿）+ 取消；Esc/遮罩点击/返回键取消；主按钮默认不聚焦（防误触回车）。对齐桌面 Dialog（FocusTrap 三件套思路，`components/ui/README.md` 三）。

**确认文案模板**：`操作名 + 对象 + 后果 + 可操作动作`（F6 §13.3 文案规范全局化）：
- 覆盖保存：「覆盖文件？`src/a.tsx` 覆盖将替换当前内容，无法撤销。[取消] [覆盖并保存]」
- 撤销配对：「撤销配对？撤销后该设备将无法连接您的桌面端，需重新配对。[取消] [撤销]」
- L2 滑动前提示：「允许后将立即执行，不可撤销」（F2 §9.3-5）。

### 6.4 反馈机制（toast / 加载指示 / 横幅）

| 反馈类型 | 表现 | 时长/位置 | 场景 |
| --- | --- | --- | --- |
| 成功 toast | 绿底白字（或对勾图标） | 2s，顶部滑入 | 「已允许，Agent 将继续」「已复制」 |
| 错误 toast | 红底白字 | 3s，顶部滑入 | 决策未送达、网络错误 |
| 信息 toast | 中性底 | 2s | 「网络恢复后自动发送」（离线决策） |
| 页面级错误横幅 | 红底横条（页内常驻） | 手动关闭/状态恢复 | run 失败、断线、干预提示（F1 F12） |
| 加载指示 | 列表内菊花/骨架屏 | 随状态消失 | 首次加载/翻页（§5.1） |
| 触感反馈 | 轻触/成功/警告三档 | 瞬时 | 按钮按压、滑动确认通过、危险动作（可关，F3 §5.3 省电） |

**Toast 纪律**：一次只弹一条（队列，对齐桌面 `useToastQueue` 思路）；toast 不承载操作（不带按钮）；关键失败必须「可重试」，toast 下方跟进重试入口或页面错误态。

### 6.5 无障碍（可访问性）

| 项 | 规范 | 验证 |
| --- | --- | --- |
| 触控目标 | 所有可交互元素 ≥44×44dp；行内小按钮间距 ≥8dp | 自动化扫描 |
| 对比度 | 正文与背景 ≥4.5:1（WCAG AA）；元信息 ≥3:1；状态点+文字双通道（不单靠颜色） | 主题 token 单测（§7.2） |
| 动态字体 | 系统字体缩放 1.0-2.0× 不破版（flex 布局 + 文本不截断关键信息）；列表行允许随缩放增高 | 真机缩放测试 |
| 读屏 | 所有可交互元素有 a11y label（类型+摘要，如「审批卡：删除文件，剩余 1 分钟」）；空态/横幅 announce；状态变化（run 收口/错误）播报 | TalkBack/VoiceOver 走查 |
| 键盘（P2） | 配对码输入为系统数字键盘；编辑页光标/选择支持 | 真机 |
| 动效偏好 | 尊重系统「减弱动态效果」：关闭页面转场动画与闪烁（§8.4） | 设置下走查 |
| 通知无障碍 | 通知正文为纯文本+语义前缀（「需要确认：」）；审批通知高优先级+声音（D7） | 系统通知走查 |

### 6.6 交互状态机一致性（数据驱动，UI 被动）

对齐 F5 §4.8 与 F2 §3.3 的纪律：**UI 不自行维护业务状态，一切状态迁移由领域 store 驱动**。表现层只消费三种东西：视图状态（vm 输出）、忙碌标志（decisionBusy/loading）、错误对象（errorDetail）。任何「看起来像状态机」的页面逻辑（审批 deciding/queued、消息 queued/processing/completed、连接相位五态）在领域层实现，表现层只做「状态 → 视觉」的映射表（§3.2 run 五色分组就是该映射的 token 化产物）。

## 7. 主题与品牌：与桌面端设计语言的一致性

### 7.1 一致性原则：同 token 语义，异渲染载体

桌面端是 CSS 变量（`tokens.css`），移动端是 TS 对象（`theme.ts`）。一致性不追求「逐像素相同」，而是**三层对齐**：

1. **语义名对齐**：`bgPrimary/textPrimary/colorSuccess/hairline` 等 token 名与桌面 CSS 变量一一对应（§3.2 对照表是唯一真源），双端评审时可逐 token 对照。
2. **数值对齐**：主色值（浅色暖灰系 / 深色炭灰系 / 语义色）与桌面**同值**（§3.2 表已逐项列出，均为 `tokens.css` 的直接取值）；差异仅允许出现在「移动端触控/可读性必要调整」处（如圆角放大、行高微调），且必须在 token 表注释中标注理由。
3. **行为对齐**：深色跟随系统、语义色「颜色即语义」、未知状态灰化诚实化（F1 §4.7）——行为规则双端一致。

### 7.2 品牌资产清单

| 资产 | 桌面现状 | 移动端处置 | 备注 |
| --- | --- | --- | --- |
| 主色 | 暖灰底 + 深炭强调（`--accent-color: hsl(35,16%,15%)`）| 同值：强调色 `hsl(35,16%,15%)`（浅）/ 亮炭（深） | 品牌「暖调深炭」语言延续；审批允许用绿、拒绝用红属语义色不属品牌色 |
| 应用图标 | 桌面窗口图标 | 96×96 白透明 PNG（expo-notifications config，D4 §8.2-5）| 同源设计稿 |
| 启动屏 | 桌面窗口 | Expo splash（品牌图标 + 暖灰底）| 无动画、无广告位（冷启动性能预算 §8.1） |
| 通知图标 | 无（系统通知中心不涉及）| 同应用图标 + `color` 字段 | 品牌色圆底 |
| 字体 | 雅黑/苹方 + 等宽族 | 系统字体栈（§3.3）| 不内嵌字体文件 |
| 语气文案 | 中文正式、简短 | 同：中文文案、原因+后果+动作（§6.3 模板）| 错误文案规范双端共用（F6 §13.3） |
| 空态插画 | 无插画（简洁优先）| 无插画：图标 + 文案（不引插画资源，省包体）| 对齐桌面「简洁」语言 |

### 7.3 移动端与桌面差异的显式登记（差异即文档）

| 差异点 | 桌面 | 移动端 | 理由（登记在案） |
| --- | --- | --- | --- |
| 圆角 | radius-md 6px 起 | 卡片 12-16、按钮胶囊 | 触控/移动视觉惯例；大圆角是移动端认知 |
| 行高 | 控件 32px | 列表行 44/56/72dp | 触控目标 ≥44dp（§6.5） |
| 阴影 | 多层低透明度 | elevation 1-6 三档 | RN 平台能力限制（iOS shadow / Android elevation） |
| 状态呈现 | 图标+文字 | 圆点+文字（双通道）| 色盲可读（F1 §4.7） |
| 元信息密度 | 高（桌面屏大）| 低：每行 ≤3 项元信息 | 屏幕宽度限制（F5 §2.1 信息密度） |
| 操作位置 | 工具栏/菜单 | 固定底部决策区/长按 Sheet | 拇指热区（§6.2） |

### 7.4 主题实现细节

- `settingsStore.appearance.theme`（`system/light/dark`，F6 §9）→ 适配层 `useTheme()` 返回 token 对象；系统主题变化经 `useColorScheme` 订阅即时切换。
- 深色 token 数值**不得引用浅色值再取反**（桌面 `theme-dark.css` 独立定义的分支纪律同样适用于移动端 token 表——每套完整、无继承）。
- token 完整性单测：浅/深两套 token 键集合完全一致（缺键编译期/测试期拦截）；对比度单测（正文/元信息/语义色在浅深两套下 ≥4.5:1 / ≥3:1，§6.5）。

## 8. 性能与体验

### 8.0 性能预算（承接 D4 §9.5，UI 侧补充）

| 指标 | 预算 | 本章节对应 |
| --- | --- | --- |
| 冷启动到可用（已配对） | ≤2.5s（中端 Android）| §8.1 |
| 页面首帧（首页/列表）| ≤300ms（本地缓存命中）| §8.1 |
| 事件流追加渲染 | 100 条/秒不掉帧 | §8.2 |
| 列表滚动 | 60fps（千级条目）| §8.2 |
| 图片加载 | 列表滚动不阻塞 | §8.3 |
| WS 内存常驻 | ≤60MB | §8.2（有界缓冲）|

### 8.1 首屏启动与骨架屏

**启动路径**（已配对冷启动）：

```
冷启动 → Splash（品牌静态图）→ SQLiteProvider 迁移（快速路径：user_version 比对）
→ SecureStore 读令牌（<50ms）→ AuthGuard 判定
→ 首屏（首页）渲染顺序：
   1. 骨架屏立即呈现（SkeletonPage 模板：连接条占位 + 核心卡 4 胶囊占位 + 活动区 2 行占位）
   2. 本地缓存数据渲染（SQLite 上次快照，stale 标记）
   3. WS 连接（复用网关单例）→ ready 后全量刷新（增量替换）
```

**骨架屏规范**（对齐桌面 `skeletonSection` 思路，F1 §4.7）：
- 三种模板：`SkeletonPage.list`（列表 5 行）、`SkeletonPage.dashboard`（核心卡+活动区）、`SkeletonPage.detail`（状态条+时间线 4 行）。
- 骨架动画：`opacity 0.4→0.7→0.4` 呼吸，1.5s 循环；深色模式同参数（颜色取 token 三档背景）。
- 骨架屏只出现于首次加载；缓存命中（二次进入）直接渲染数据态（F1 §4.7 加载态规范）。
- **防白屏**：根布局在 SQLite/SecureStore 就绪前渲染 SplashGate（不跳转、不白屏，D4 §5.0 守卫）。
- **防闪烁**：本地缓存数据先渲染再增量替换（先骨架→再缓存→再新鲜数据，三级渐进，F1 §4.3 骨架可见预算 <500ms）。

### 8.2 列表滚动与流式渲染

| 手段 | 实施 |
| --- | --- |
| 虚拟列表 | FlashList（默认开启，SDK 57 配套），固定行高（44/56/72dp），`getItemType` 复用消息/卡片/分隔行 |
| 行级 memo | 区块组件 `React.memo` + 严格 props 比较（F5 §6.1 移植 `assistantRowPropsEqual` 思路）；流式期间历史行零重渲染 |
| selector 粒度 | 列表数据一律 `useShallow` 选取数组 + 稳定引用（D4 §4.4.3）；事件流高频追加不触发全列表重渲染 |
| 流式合并 | 48ms 文本合并窗口 + 100ms 工具输出窗口 + 终态 flushNow（F3 §3.4.1 全参数对齐桌面先例）；渲染提交单次 setState（React 自动批处理） |
| 有界缓冲 | feed 500 条环形 / 行缓冲 200 行 / 消息正文渲染上限 20 万字符（F3 §3.4.2）|
| 后台降速 | 页面不可见只消费不渲染（脏标记 1s 合并，F3 §7.2）；事件流页退场即退订（`cleanupStreamState` 语义，F3 §7.3）|
| 节流兜底 | 弱网放大节流窗口（200ms→1s，F5 §6.4）；后台零轮询（F1 §1.3-3）|

**渲染线程纪律**：流式期间不跑语法高亮/不跑 markdown 全量解析（L1 纯文本，L2 终态一次解析，F3 §6.2 三级管线）；解析工作不进 worker（移动端包体/复杂度约束，终态一次解析的中端机型耗时在预算内）。

### 8.3 图片加载

| 场景 | 策略 |
| --- | --- |
| 会话内图片 | 占位（pending → resolved/error，F5 §3.4）；http 直载、local 占位「需在桌面端查看」、data 超 512KB 降级占位 |
| 文件缩略图 | ≤128px 宽（`mobile_file_thumbnail` 代理，F4 §5.3）；磁盘缓存 24h/128MB |
| 文件详情原图 | 按需加载（进入详情页才请求）；资源代理 URL 带 10 分钟令牌（F4 §5.4）|
| 列表滚动 | 滚动进入视口才加载（FlashList onViewableItemsChanged）；图片组件 memo；失败占位 + alt |
| 流量控制 | 「仅 Wi-Fi 加载图片」设置项（F5 §6.4）；会话列表不加载正文图片 |

### 8.4 动画（reanimated 克制原则）

**原则**：移动端是「远程伴侣」，信息型应用，动效是增强不是主角。全局动效预算 = **四类**：

| # | 动效 | 位置 | 实现 | 预算 |
| --- | --- | --- | --- | --- |
| 1 | 页面转场 | Stack push/pop、Tab 切换 | expo-router 原生转场（平台默认），不自定义 | 系统 300ms |
| 2 | 按压反馈 | 按钮/列表行按压 | 原生 `Pressable` 按压态（scale 0.98 或底色变化，≤80ms）| 80ms |
| 3 | 滑动确认 | 审批 L2 滑轨 | reanimated 手势：滑轨拖动 + 回弹（spring）+ 阈值 70% 判定 | 200ms |
| 4 | 列表增删 | 审批卡移除/outbox 状态切换 | 简单位移/淡出（LayoutAnimation 或 reanimated FadeIn）| 150ms |

**克制条款**：
- **禁止**：自定义转场动画、粒子/爆炸、无限循环动画（骨架呼吸除外）、流式文字逐字动画（桌面 `streamingCodeHighlighter` 是桌面特权，F3 §6.1）、水波纹过度定制。
- `reduce-motion`：系统「减弱动态效果」开启时，四类动效全部降级为即时切换（骨架呼吸停、滑动确认改为「点击两段式」：点「允许」→ 弹确认框 → 点「确认放行」，F2 §5.3 备注该降级路径）。
- reanimated 使用纪律：只在适配层/表现层使用（领域层零 reanimated import）；共享值不参与主题色（防深色切换闪变）；动画组件用 `useMemo` 隔离避免全屏重渲染。
- 电量：动画不常驻；后台不运行动画（页面不可见即停，对齐 F3 §7.3 省电）。

## 9. 可替换性：换 UI 框架的场景推演

### 9.0 场景定义

任务书核心诉求：**未来 UI 不好看要换 UI 框架**（如 RN 组件 → Tamagui，或 RN → 鸿蒙 ArkUI）。推演目标：明确「换框架时哪些重写、哪些保留、代价多少」。

### 9.1 分层保留/重写矩阵

| 层 | 保留比例 | 场景 A：RN 组件 → Tamagui（同生态） | 场景 B：RN → 鸿蒙 ArkUI（跨生态） |
| --- | --- | --- | --- |
| 领域层 store（vanilla zustand）| **100%** | 原样保留（零 React 依赖是硬约束的收益）| 保留 store 核心（若目标生态支持 TS 运行时；ArkUI ArkTS 可承载纯逻辑 + 自研轻量订阅层）|
| 领域层 repositories/services/network/db | **100%** | 原样保留（expo-sqlite 换鸿蒙需要 storage 适配器替换——属 db 层局部替换，见下）| services 的网络层按目标平台 API 重写适配（fetch/WS 语义等价）|
| 领域层 pure/ | **100%** | 原样保留 | 原样保留（纯 TS，零平台依赖）|
| 适配层 viewmodels | 90% | 保留（`useMemo/useEffect` 等价）| 重写 hooks 绑定（target：ArkUI 生命周期等价物）|
| 适配层 platform/{theme,Icon,Fonts} | 60% | theme 保留、Icon 内部实现换（Tamagui 图标面）、Toast/Haptics 换宿主 | theme 保留（token 表与框架无关）、Icon/Fonts/Haptics/Clipboard 全换 |
| 表现层原子组件 ui/（20 个）| 0% | 重写为 Tamagui 组件（或保留自研组件仅换主题——**建议：保留自研，换的是「主题与字体」而非组件**）| 全量重写为 ArkUI 组件 |
| 表现层区块/页面 | 30% | 保留结构与布局，换组件标签与主题 API | 全量重写（但 props 契约不变，重写是机械翻译）|
| 路由骨架 app/ | 20% | expo-router → 目标导航库（页面树不变）| 全换 |

### 9.2 为什么领域层能 100% 保留（架构保障清单）

| 保障设计 | 章节 | 机制 |
| --- | --- | --- |
| store 不依赖 React | §2.5 | vanilla `createStore` + 适配层 `useStore` 绑定 |
| 组件不依赖 store | §2.2.1 | props in / events out 铁律 + lint 门禁 G1 |
| 领域层白名单 import | §2.6 G2 | lint 强制：领域层只见 zustand/shared-types/expo-* 数据库 |
| 事件协议与 UI 无关 | D4 §6.1 | 信封解析在领域层，组件只消费 shared-types 领域类型 |
| 纯函数下沉 | §2.2.3 | 去重/合并/ANSI/时间/选择器全部 `domain/pure/`，Node 侧可测 |
| view-model 即契约 | §2.2.2 | 页面数据契约稳定；换框架只换「订阅实现」不换「状态投影逻辑」 |

### 9.3 场景 A 推演：RN 组件 → Tamagui（同生态，低代价）

- **建议不换组件层，换的是主题**：Tamagui 的价值是跨平台组件与编译优化；本项目组件已 token 化（§3.8），「换皮」= 换 `theme.ts` 两套 token 数值——这本身就是可替换性设计的目标形态。若产品决策要换 Tamagui 组件：原子组件 20 个重写（1-2 周工作量），区块/页面仅改 import 与布局属性（props 契约不变），领域层零改动。风险点：Tamagui 与 RN 0.86 新架构兼容面需先行验证（D4 §10.1 R2 同源风险）。
- **真实收益评估**：本项目功能面（列表/卡片/表单）自研组件已覆盖，Tamagui 增量收益有限；**换框架的真实驱动应是「视觉语言大改」而非「组件库偏好」**——视觉语言大改时，token 层是唯一的改动面（§3.8），组件库反而无需换。

### 9.4 场景 B 推演：RN → 鸿蒙 ArkUI（跨生态，中高代价）

- **可保留**：领域层 100%（store 核心 + pure 纯函数 + 仓库逻辑；expo-sqlite/expo-secure-store 由鸿蒙 storage 适配器替换，DAO 接口不变）；view-model 的状态投影逻辑；页面树与深链命名空间（映射为 ArkUI 路由表）；token 表与设计系统文档。
- **需重写**：表现层全部组件（ArkUI 声明式组件）、适配层平台封装（图标/剪贴板/触感/Toast 宿主）、store 订阅绑定（ArkTS 响应式状态）、网络层（鸿蒙 WebSocket/fetch API 等价重写）。
- **代价估计**：表现层约占总代码量 45-55%，重写量 ≈ 4-6 周（按 M 系列工程量折算）；领域层（约 45%）零改动；适配层（约 5%）局部重写。
- **前提约束**：鸿蒙侧需 TS/ArkTS 承载领域层（ArkTS 是 TS 超集限制版——纯逻辑代码兼容性高，zustand 不可用则自研 50 行订阅层替代，领域 store 接口不变）。
- **结论**：可替换性目标达成——「UI 不好看要换」的 90% 场景其实只是换 token；真正跨生态换壳（鸿蒙）时，价值最高的领域层与契约层 100% 保留，重写面严格限制在无业务逻辑的渲染层。

### 9.5 可替换性的验收口径

1. 表现层代码（app/ + presentation/）中，`domain/` 路径的 import 数为 0（lint G1 常绿）。
2. `domain/` 中 `react`/`react-native` 的 import 数为 0（lint G2 常绿）。
3. 领域层测试在「无 RN 环境」下可全量运行（Node 侧 jest，§10.1）。
4. 所有业务状态迁移可在领域层单测复现（不依赖组件树）。
5. 主题换肤（换 token 数值）不改任何组件代码即可实现（§3.8 验收演示脚本）。

## 10. 测试

### 10.1 分层测试矩阵（架构收益的直接体现）

| 层 | 测试类型 | 工具 | 运行环境 | 覆盖 |
| --- | --- | --- | --- | --- |
| 领域层 | 纯逻辑单测 | jest（普通 preset，**非 jest-expo**）| Node（零 RN mock）| store 状态机（审批/连接相位/outbox）、选择器、事件合并、ANSI、时间、去重、游标追平 |
| 仓库层 | 数据层测试 | jest + 内存 SQLite（expo-sqlite `:memory:`）| Node | DAO CRUD、迁移幂等、outbox 投递规则、缓存失效 |
| 适配层 | view-model 测试 | jest + @testing-library/react（挂 React 组件壳）| Node + happy-dom | vm 投影正确性、命令转发、导航参数 |
| 表现层 | 组件测试 | jest-expo + @testing-library/react-native | Node + RN mock | 原子组件交互、区块组件状态渲染、页面三态 |
| 跨层 | 集成测试 | jest（mock WsGateway）| Node | 配对流程、离线决策入队→重连重放、深链路由（D4 §9.1 三件套）|
| 全链路 | E2E | maestro（YAML 流程脚本）| 真机/模拟器 + dev client | 审批 3 秒路径、L2 滑动、推送深链、断线重连 |

**关键收益**：领域层用普通 jest（非 jest-expo）跑，测试速度与稳定性远超 RN mock 面——这是分层架构最直接的测试红利，也是 §2.5 vanilla store 设计的验收点。

### 10.2 组件测试要点（@testing-library/react-native）

| 组件 | 关键用例（对齐桌面测试心智） |
| --- | --- |
| ApprovalCard | 风险徽标（L1/L2）、倒计时渲染（剩余时间/过期置灰）、待发送徽标、点击转发 |
| ApprovalActionBar | 主/次按钮层级、busy 置灰、L2 滑轨（70% 阈值：滑 50% 松手回弹、75% 触发）、拒绝 Sheet 打开 |
| RunStatusChip | 十态→五色分组全映射断言（F1 §5.1 表逐行）|
| EventRow | 六类模板 + 未知 type 兜底「事件 <type>」|
| MessageBubble | 思考折叠三态、长消息折叠阈值、操作菜单（复制组装语义）|
| ToolCallCard | created→streaming→finalized 状态机、pending_approval 插入、parallel 分组 |
| TerminalCard | `\n` 追加 / `\r` 行覆盖、200 行环形淘汰、单行 5000 字符截断、ANSI 剥离 |
| SessionRow | 标题 28 码点截断、相对时间、未读角标、运行徽标三色 |
| EmptyState | 空态文案表（§5.9）逐条断言、不显 0 误导 |
| ConnectionBanner | 四相位文案（disconnected/connecting/recovering/offline）|
| TabBar | 5 Tab 渲染、审批角标（99+ 上限、未知态显示「·」）|

### 10.3 视觉回归（snapshot + 主题对照）

| 手段 | 方案 | 时机 |
| --- | --- | --- |
| 组件快照 | jest-expo 快照测试（浅/深两套主题各一组）；token 变更引发快照差异即人工确认 | PR 必跑 |
| 主题完整性 | token 键集合一致性 + 对比度单测（§7.4）| CI |
| 真机视觉走查 | EAS dev client + 截图清单（首页/审批/会话/文件/设置 × 浅深 × 三态）| 每里程碑 |
| 视觉回归自动对比（P1）| Storybook for RN（或 expo-snack 截图对比）| P1 评估后接入 |

快照纪律：快照文件入库（测试资产铁律，AGENTS.md）；快照断言只校验结构/文案/主题色引用，不校验像素级样式（RN 平台差异）。

### 10.4 交互测试（maestro E2E，关键路径清单）

| # | 场景 | 断言 |
| --- | --- | --- |
| E1 | 冷启动 → 已配对 → 首页骨架 → 数据态 | 骨架可见 <500ms；4s 内核心卡出数据 |
| E2 | 审批全链路：mock 引擎发 approval-requested → 列表出现 → 详情 → L1 允许 → 卡片消失 | 点按 ≤3 次、总时长 ≤3s（F2 §13.2 E2E-2）|
| E3 | L2 滑动：50% 松手不提交、75% 触发提交 | 无半途误提交（F2 E2E-3）|
| E4 | 断线：飞行模式决策 → 待发送徽标 → 恢复 → 重放送达 | outbox 状态迁移正确 |
| E5 | 推送深链冷启动：点击通知 → 直达审批详情 → 返回首页 | 不堆叠中间页 |
| E6 | 深链目标已过期 → 冲突态页 → 可返回 | 不崩溃 |
| E7 | 会话详情双视图切换：消息/事件流 → 数据一致 | 同一事件双视图不重复不缺失 |
| E8 | 终端：流式输出滚动 → 上滚暂停 → 回到底部 | 跟随/暂停切换正确 |
| E9 | 文件浏览：目录 push/pop 与手势返回一致 → 预览 → 返回状态保留 | 导航栈一致（F4 X4-6）|
| E10 | 移除本机：二次确认 → 回配对页 → SQLite 数据保留 | 数据保留断言 |
| E11 | 深色切换：全屏遍历无明暗残留 | 页面截图对照 |
| E12 | 动态字体 2.0×：列表/审批/会话不破版 | 关键文案完整可读 |

E2E 基建：maestro（免费、YAML 流程、与 EAS dev client 兼容）；测试用 mock 桌面 daemon（WS 测试服务器 + 夹具事件，D4 §9.2 T16 模式）；真机推送链路仍走手动/EAS job（D4 §9.4）。

### 10.5 分层门禁与回归护栏

| 门禁 | 内容 | 触发 |
| --- | --- | --- |
| 分层 import 检查（G1-G4）| §2.6 脚本常绿 | PR 必跑（并入 mobile-ci 快层）|
| 事件分类器对照 | F3 §8.4：41 变体 → S/N/I 分类表与 `ALL_TYPE_NAMES` 一一对应；shared-types 变更时编译失败强制补分类 | shared-types 变更自动触发 |
| 桌面回归 | 双端契约测试 + 桌面 `commandManifest.test.ts` 镜像断言（D4 §10.2 S4）| 命令面变更 |
| 测试资产入库 | 新增测试/调试脚本立即 `git add` 提交（AGENTS.md 铁律）| 每次提交 |

## 11. 里程碑建议（与 D4 §11.1 对齐）

M4 是 UI 架构方案，落地随 D4 里程碑推进；本表给出 UI 侧在各里程碑的交付物与出口标准：

| 阶段 | 与 D4 对齐 | M4 侧交付物 | 出口标准 |
| --- | --- | --- | --- |
| M0 骨架（2 周）| D4 M0 | 目录三层骨架落地 + theme.ts 两套 token + Icon 封装 + 20 个原子组件第一批（Button/Card/ListRow/EmptyState/Skeleton/Toast）+ TabBar 5 Tab + 路由守卫 + 分层 lint 门禁脚本 | typecheck/lint/check-layers 绿；首页骨架屏真机可达 |
| M1 连接与配对（3 周）| D4 M1 | 配对向导三屏（manual 先行）+ 连接横幅 + 设备列表/详情 + 首启欢迎页 | 配对→断网→重连全链路真机通过；T1-T8（F6 §14.1）绿 |
| M2 审批中心（3 周）| D4 M2 | 审批中心列表 + 详情 + 决策区（L1 点击/L2 滑动）+ 历史 + 批量（P1）+ 空/错/离线三态 | F2 验收 1-7 条；E2/E3/E4 绿 |
| M3 观测面（3 周）| D4 M3 | 首页仪表盘 + 会话列表 + 会话详情（双视图）+ run 详情 + 终端回放 | 100 条/秒不掉帧；E7/E8 绿 |
| M4 文件与设置（2 周）| D4 M4 | 文件浏览/预览 + 设置壳（搜索/分组/账户卡）+ 二级页 | F4 T4-01~12 绿；E9/E10 绿 |
| M5 推送完备（2 周）| D4 M5 | 深链白名单接线 + 通知点击三形态 + 角标 | E5/E6 绿；三形态真机通过 |
| M6 视觉与收口（1-2 周）| D4 M7 前 | 视觉走查清单 + 快照补齐 + 动态字体/无障碍走查 + 真机性能采样 | E11/E12 绿；性能预算达标（§8.0）|
| P1 项随排期 | F 系列 P1 | 用量/诊断/任务页 + 文件编辑 + 会话搜索 + 登录 | F1/F4/F5/F6 P1 验收 |

**依赖纪律**：每期结束即提交（仓库风格），测试与调试脚本立即入库；M4 文档中的 token 表、深链表、屏幕清单、三态文案表作为任务书附件被实现子 Agent 引用。

## 12. 风险与开放问题

| # | 风险/问题 | 影响 | 概率 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | **分层门禁形同虚设**：实现期组件直接 import store（图省事），分层架构退化为装饰 | 可替换性目标失败 | 中 | G1-G4 lint 从 M0 起强制；代码评审以「组件目录 grep 领域 import」为否决项；快层 CI 拦截 |
| R2 | **vanilla zustand 使用不熟**：`createStore` 与 `create` 的订阅/初始 API 差异导致误用 | 运行时 bug | 低 | 适配层 `useAppStore` 统一封装；领域层测试先行（§10.1 普通 jest）|
| R3 | **5 Tab 超导航承载**：审批/会话/文件/设置四域 + 首页，Tab 内层级深 | 认知负担 | 低 | 每 Tab 首屏即主任务（§1.1）；Stack 深度 ≤3（Tab → 二级 → 三级）；深链直达缩短路径 |
| R4 | **组件快照脆弱**：RN 平台差异导致快照频繁误报 | 门禁噪音 | 中 | 快照只断言结构/文案/token 引用（§10.3 纪律）；不引入像素断言 |
| R5 | **lucide 依赖面复发**（R2B 教训重演）：peer 依赖漏装/版本漂移 | 启动崩溃 | 低 | 安装命令固定 `npx expo install lucide-react-native react-native-svg`；expo-doctor CI；peer 依赖审查纳入 D8 |
| R6 | **双端 token 漂移**：桌面 tokens.css 变更后移动端 theme.ts 未同步 | 品牌不一致 | 中 | token 对照表（§3.2）纳入评审；双端 token 变更走同一评审单；快照测试捕获变更 |
| R7 | **动态字体破版**：系统大字号下列表/审批卡布局破坏 | 无障碍不过 | 中 | 布局以 flex 为主、文本不硬性截断（§6.5）；真机 2.0× 走查入 M6 出口标准 |
| R8 | **会话详情双视图数据一致性**：消息视图与事件流视图投影口径不一 | 用户困惑 | 低 | 双视图共用同一事件流数据源与投影纯函数（§5.5）；E7 双视图一致性 E2E |
| R9 | **E2E 基建成本**：maestro 首次接入与 mock daemon 搭建 | 排期超支 | 中 | E2E 只覆盖 12 条关键路径（§10.4）；mock daemon 复用 D4 §9.2 测试服务器夹具 |
| R10 | **鸿蒙未来接入未定**：跨生态推演（§9.4）的 ArkTS 兼容性需验证 | 远期不确定 | 低 | 当前只保障「领域层零 UI 依赖」的硬约束；ArkTS 兼容验证列为 P2 预研 |

**开放问题（需主控/评审裁决）**：

| # | 问题 | 候选 | M4 建议 |
| --- | --- | --- | --- |
| Q1 | 5 Tab vs F1 的 4 Tab 建议 | 遵循 M4 5 Tab / 遵循 F1 4 Tab | **5 Tab**（§4.1 论证）；请主控以本表为裁决基准 |
| Q2 | 会话详情双视图（消息/事件流）默认落哪个 | 消息 / 事件流 / 记忆上次 | 默认「消息」，记忆用户上次选择 |
| Q3 | 视觉回归自动对比（Storybook）是否 P1 引入 | 快照够用 / 引入截图对比 | 快照先行，P1 评估截图对比 |
| Q4 | 组件库自研 vs 引入的最终裁决 | §3.6 已评估 | 自研；若产品未来要求 web 端复用组件再评 Tamagui |
| Q5 | 审批主按钮颜色：品牌炭 vs 语义绿 | 品牌色统一 / 语义绿 | 语义绿（允许=成功语义，与 run 五色分组一致）；品牌炭用于强调按钮（登录/保存）|

## 13. 附录

### 13.1 图标白名单（IconName 注册表，约 60 个）

```
导航与通用：arrowLeft / chevronRight / chevronDown / close / check / x / more(⋯) / refresh /
            search / settings / home / list / clock / bell / shield / lock / eye / eyeOff
审批域：    alertTriangle（高风险）/ checkCircle / xCircle / clock（超时）/ send / rotateCcw（重试）/
            bookmark（记住）
会话域：    messageSquare / sparkles（助手）/ user（用户）/ brain（思考）/ copy / share / link /
            pin / archive / trash
事件流域：  activity（运行中）/ terminal / fileCode / fileText / folder / layers（压缩）/
            database（缓存）/ zap（工具）/ gitBranch（子代理）/ bug（错误）
文件域：    folder / file / fileText / image / fileJson / fileCode / table / fileArchive（二进制）/
            download / edit3 / searchX（无结果）
设备/账户： smartphone / laptop / tablet / wifi / cloud（中继）/ key / qrCode / logout / userPlus
状态域：    circle（圆点）/ wifiOff / refreshCcw（重连）/ shieldAlert（安全）
```

（实施时以 F1-F6 屏幕盘点为准增减，超出白名单的图标名走「先加注册表再使用」流程，防止图标使用失控。）

### 13.2 原子组件 ↔ 桌面 ui/ 映射与移动端新增

| 移动端组件 | 桌面对应 | 备注 |
| --- | --- | --- |
| Button/Input/Dialog/Menu/Select/Tooltip | `components/ui/{Button,Input,Dialog,Menu,Select,Tooltip}` | 同名同语义，API 按移动端触控调整 |
| Switch/Slider/Card/ListRow/Badge/Chip/AppBar/TabBar | 桌面无（桌面用面板/样式）| 移动端新增（§3.7 全清单）|
| ConnectionBanner/CountdownBar/EmptyState/Skeleton/Toast/Sheet/SegmentedControl | 桌面有对应样式/逻辑 | 移动端特化 |
| 区块组件（ApprovalCard/EventRow/…）| `components/{overview,workspace,settings,sidebar}` 对应卡 | 只移植纯函数（`*.pure.ts` 纪律，F3 §6.3），组件重写 |

### 13.3 与 D4 §4.3 目录的差异登记（实施改动面）

| D4 目录 | M4 调整 | 理由 |
| --- | --- | --- |
| `src/components/` | 拆分 `presentation/components/{ui,blocks,templates}` + `adapters/platform/` | 三层命名与依赖门禁需要（§2.3）|
| `src/store/` | 迁入 `domain/store/`（vanilla createStore）| 零 UI 依赖（§2.5）|
| `src/data/` | 迁入 `domain/repositories/` | 语义一致，归属领域层 |
| `src/network/` | 迁入 `domain/network/` | 同上 |
| `src/db/` | 迁入 `domain/db/` | 同上 |
| `src/utils/` | 拆入 `domain/pure/`（业务纯函数）与 `adapters/`（平台工具）| 纯函数可测性 |
| 新增 `src/presentation/screens/`、`src/adapters/viewmodels/`、`src/adapters/hooks/` | — | 三层结构新增面 |
| `src/pairing/`、`src/notifications/` | 保留（跨层接线，§2.3 说明）| 职责不变 |

### 13.4 关键接口契约速查（UI 侧依赖）

| 接口 | 定义方 | UI 侧消费点 |
| --- | --- | --- |
| `useXxxVm()`（每屏一个）| M4 §2.2.2 范式 | 页面组件唯一数据入口 |
| `useAppStore(store, selector)` | M4 §2.5 | 适配层订阅 |
| `Icon(name, size, color)` | M4 §3.5 | 全表现层图标 |
| `useTheme()` → token 对象 | M4 §3.8 | 全表现层样式 |
| 审批命令面（core_approve_tool/deny_tool）| F2 §12.1 | approvalRepository |
| 事件订阅面（WS 信封）| D4 §12.5 | services/WsGateway |
| 深链白名单 | M4 §4.3 | notifications/deepLink |
| 三态文案表 | M4 §5.9 | EmptyState/ErrorBanner |

### 13.5 文档复核点（供主控评审）

1. **Tab 结构裁决**（§4.1）：5 Tab 覆盖 F1/D4/F6 三份分歧，请主控确认。
2. **vanilla store 范式**（§2.5）：与桌面 `create()` 范式的小差异（仅移动端），请评审确认收益（Node 侧测试 + 可替换性）成立。
3. **组件库自研**（§3.6）：不引 gluestack/tamagui 的裁决，如产品预期未来大改视觉语言，此决策仍成立（换 token 即换皮，§9.3）。
4. **会话详情双视图**（§5.5）：消息/事件流分段是 F3 与 F5 的整合方案，请主控确认与 F3 的 feed 定位无冲突。
5. **图标白名单**（§13.1）：60 个图标是否覆盖 F1-F6 屏幕需求，实施期盘点确认。

---

## 总结

M4 移动端 UI/UX 与前后端分离方案结论：**架构上**，表现层（纯组件，props in/events out）— 适配层（view-model + store 订阅绑定 + 平台封装）— 领域层（vanilla zustand `createStore` + 仓库 + 服务 + 纯函数）三层单向依赖，领域层零 React 依赖、Node 侧可测、lint 门禁强制，换 UI 框架（Tamagui / 鸿蒙 ArkUI）时领域层 100% 保留，重写面严格限制在无业务逻辑的渲染层；**设计系统上**，自研轻量 token 体系逐项对齐桌面 `tokens.css`（浅色暖灰 / 深色炭灰 + 语义色同源），20 个原子组件自研不引组件库，图标用 lucide-react-native + 配套 svg 安装并经自研 Icon 组件隔离替换面（吸取 R2B 漏装 peer 依赖教训）；**导航上**，5 Tab（首页/会话/审批/文件/设置）+ Stack 深链页，审批占 Tab 位承载角标与推送直达，事件流并入会话详情双视图，用量/诊断入设置；屏幕清单 22 屏统一三态（加载/空/错误离线）规范、决策类屏幕固定底部拇指区、L2 审批滑动二次确认、run 十态五色分组；性能上骨架屏三级渐进 + FlashList 虚拟化 + 流式合并节流 + reanimated 四类克制动效并尊重系统减弱动效；测试上分层测试矩阵（领域层普通 jest 零 RN mock、组件层 jest-expo、E2E maestro 12 条关键路径）加分层 import 门禁，可替换性验收口径五条全部可自动断言。

<!-- M4-END -->




